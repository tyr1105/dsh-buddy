## 14. 额度与预算

### 14.1 职责

额度（QuotaKeeper）管三件事：把所有模型调用记成一本账，包括 DSH 自带统计看不到的调用；按单机器人预算和全局份额决定一次思考能不能放行、本次最多能用多少；识别模型报错，决定交给 DSH 重试、按阶梯重排，还是全体停下。它保证主人份额（owner reserve，保底 30%）不被机器人占用；额度紧张时先降频，再只放紧急的，最后全体停歇，恢复时先放 1 个探针。

### 14.2 数据

#### budget_ledger（计量账：主循环每个回合一行，辅助调用每次一行）【一期】

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| entry_id | ULID | 账目编号 | 主键 |
| at | ISO 时间（+08:00） | 记账时间；主循环行为最后一次更新时间 | |
| day | YYYY-MM-DD | Asia/Shanghai 自然日 | 每日预算按它汇总 |
| window_id | string | 所属 5 小时窗口（quota_state 主键） | 当前没有未结束的窗口时，由这笔调用开新窗口（QUOTA 红灯期间除外，见「校准」） |
| bot_id | string \| null | 归属机器人；主人和中心自己的调用为 null | 子会话沿 parentSessionId 归到根会话所属的机器人 |
| initiator | bot / owner / hub | 谁发起的回合 | 主人在机器人会话里亲手发消息、点「现在想一下」记 owner；冒烟测试记 hub |
| wake_id | string \| null | 对应的唤醒单（第 7.6 节；主人在机器人会话里的原生消息也有原生唤醒单，见第 7.8 节） | 主人自己会话里的调用和中心的调用为 null |
| session_id | string | 产生用量的会话 | |
| turn_key | string \| null | 主循环行的回合键：会话 id + 回合序号 | 同一回合只有一行，回合内随每步更新 |
| kind | main_loop / compaction / search / title / triage / other | 用量来源 | triage 为二期 |
| provider | string | 模型路由名，如 zai-coding-cn、deepseek-official | |
| counts_window | bool | 是否占共用订阅的 5 小时窗口 | provider 属于 `quota.shared_routes` 时为 true |
| measured | measured / estimated | 实测还是估算 | |
| raw_uncached / raw_cache_write / raw_cache_read / raw_output | int | 原始 token 四桶（tokenUsage 的 uncachedInputTokens、cacheWriteTokens、cacheReadTokens、outputTokens） | 估算行只填 raw_uncached 与 raw_output |
| raw_requests | int | 模型请求次数：主循环为步数增量加重试次数，辅助调用每次记 1 | |
| tokens | int | 计量 token，公式见 14.3 | 已乘 1.2 |
| requests | int | 计量请求数 = raw_requests × 1.2，向上取整 | |
| peak | bool | 是否落在高峰时段 | 一期只记录不折算，供 V17 核对 |
| cum_snapshot | object \| null | 主循环行记下的会话累计值：tokenUsage 四桶、steps、asOfSeq | 算下一笔增量用 |
| note | string，≤ 200 字 | 说明，如「估算：web_search 1 次」 | |

明细保留 30 天；每日汇总写进日报后，过期明细可删。

#### quota_state（一个 5 小时窗口一行）【一期】

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| window_id | string | 窗口编号，取起点时间戳 | 主键 |
| started_at | ISO | 窗口起点：上一窗口结束后第一笔 counts_window 调用的时间 | 报错原文解析出重置时间时倒推修正 |
| ends_at | ISO | 预计重置时间 = started_at + 5 小时 | |
| reset_source | estimated / parsed / probe | ends_at 从哪来 | |
| calibrated | bool | 容量是否已经被额度报错校准过 | 首次 QUOTA 之前为 false |
| capacity_tokens / capacity_requests | int \| null | 窗口总容量估计 C（token、请求数两个维度） | 未校准为 null；新窗口沿用上一窗口的值 |
| ceiling_tokens / ceiling_requests | int \| null | C 上调的上限（见「校准」） | |
| share_turns | int | 未校准时机器人合计每窗口可放行的思考回合数 S | 初始 8 |
| used_tokens_bot / used_tokens_owner / used_tokens_hub | int | 本窗口计量 token 分项，只计 counts_window 的账 | |
| used_requests_bot / used_requests_owner / used_requests_hub | int | 本窗口计量请求数分项 | |
| bot_turns_granted | int | 本窗口已放行的机器人思考回合数 | 放行即计，不等回合结束；主人发起的不计 |
| bot_ratio | float | 机器人用量 / 机器人有效份额 | 判灯用，公式见「全局份额」 |
| light | green / yellow / orange / red | 当前额度灯 | |
| light_changed_at | ISO | 灯最近一次变化时间 | |
| red_reason | quota_error / share_exhausted / null | 红灯原因 | |
| red_until | ISO \| null | 最早可以放探针的时间 | |
| probe_state | none / waiting / running / passed / failed | 探针状态 | |
| probe_wake_id | string \| null | 充当探针的唤醒单 | |
| probe_failures | int | 本次红灯以来连续探针失败数 | |
| ramp_until | ISO \| null | 探针成功后并发限 1 的截止时间 | 探针成功时刻 + 10 分钟 |
| quota_errors | int | 本窗口 QUOTA 报错次数 | |
| error_point_tokens / error_point_requests | int \| null | 本窗口首次 QUOTA 报错时的窗口总用量（机器人 + 主人 + 中心） | 校准用 |
| error_raw | string，≤ 500 字 | 首次 QUOTA 报错原文 | 用于校准识别词表（V4） |
| calibration | none / lowered / raised / reset | 本窗口发生的校准动作 | |
| low_streak | int | 截至本窗口，连续「无报错且总量 < 50% C」的窗口数 | 上调后清零 |
| closed | bool | 窗口是否已结束 | 结束时写 low_streak 与 calibration |

#### settings 里的额度参数【一期】

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| quota.owner_reserve | float | 0.30 | 主人份额；机器人合计份额 = 1 − 它 |
| quota.window_hours | int | 5 | 窗口长度 |
| quota.share_turns_initial | int | 8 | 未校准时的 S，主人可改 |
| quota.calib_down | float | 0.9 | 报错点折算系数 |
| quota.calib_up | {after, below, step} | {3, 0.50, 0.10} | 上调条件与幅度 |
| quota.meter_factor | float | 1.2 | 计量放大系数 |
| quota.cache_read_weight | float | 0 | 缓存读取折算权重，默认不计，V16 核实后再定【待验证 V16】 |
| quota.light | {yellow, orange} | {0.50, 0.80} | 灯阈值 |
| quota.red_resume_delay_min | int | 5 | 重置后多久放探针 |
| quota.probe_backoff_min | int[] | [30, 60, 120] | 探针失败后的再探间隔 |
| quota.ramp_min | int | 10 | 探针成功后并发限 1 的时长 |
| quota.bot_day | {turns, tokens} | {6, 250000} | 单机器人每日预算 |
| quota.bot_window_turns | int | 3 | 单机器人每窗口次数 |
| quota.probation_factor | float | 0.5 | 试岗期折算，向下取整，最少 1 |
| quota.turn_tokens_cap | int | 60000 | 与回合上限同值（第 7 章） |
| quota.turn_tokens_min | int | 10000 | 本次可用低于它不放行 |
| quota.estimate | {search, title, compaction} | {10000, 2000, 60000} | 估算值（每次） |
| quota.shared_routes | string[] | 主人默认模型所在的路由 | 占共用窗口的路由 |
| quota.overuse_factor | float | 3.0 | 单日用量 ≥ 3 倍预算即隔离 |
| quota.wait_bonus | {per_30min, cap} | {0.05, 0.20} | 排队加分 |
| quota.words | {strong, weak, time, rate, context} | 见「报错分类」 | 识别词表，V4 实测后校准 |
| quota.peak | {hours, off_peak_factor} | {「工作日 14:00–18:00」, 1.0} | 【二期】V17 确认后系数改 0.5 |

### 14.3 规则

#### 计量口径与盲区【一期】

1. 计量 token = (未缓存输入 + 缓存写入 + 输出 + w × 缓存读取) × 1.2 × 时段系数，w 默认 0（与第 7.6 节唤醒单 usage 的 est_units 同口径，缓存读取单列记录、暂不计入）。一期时段系数恒为 1.0（见「高峰时段」）。本 PRD 里所有 token 数（回合上限约 6 万、单机器人每天 25 万）都按这个口径。缓存读取是否计入 GLM 额度、按多少计【待验证 V16】；核实后只改 w，账上留有原始四桶，可以回算。
2. 计量请求数与 token 并行记账。GLM 的计额单位（token、请求数还是 credits）未知【待验证 V16】，所以两维都校准、都判灯，取比值高的一维。
3. 各来源的记法：

| 来源 | 怎么拿到 | 记成 |
|---|---|---|
| 主循环 | 机器人回合每一步开始时（agent/pre-step）和任何会话的 turn/end 后，读该会话 `projections` 的 tokenUsage 与 sessionStats.steps，减去该会话上一笔 cum_snapshot 得增量；同一步的重试已含在 tokenUsage 里 | kind main_loop，measured |
| 子会话（子代理、机器人内部临时拉的 Agent Teams） | 同上，沿 parentSessionId 归到根会话 | 归到根会话的机器人或主人 |
| 压缩摘要 | session/event 里的 compaction/summary 事件自带 usage【待验证 V8】 | kind compaction，measured；不带 usage 时按 6 万估算 |
| 网页搜索 | session/event 里每次 web_search 工具调用记一行；一次搜索是一整轮 DeepSeek 模型调用，不进 tokenUsage | kind search，estimated，每次 1 万；provider deepseek-official，counts_window = false【待验证 V19】 |
| 标题生成 | 中心新建会话一律先 rename 再首次投递，正常不发生；rename 失败、且首条消息经 sessionController.prompt 发出时记一行 | kind title，estimated，每次 2,000【待验证 V19】 |
| 分诊【二期】 | ctx.llm.stream 返回的 usage；拿不到就按字符估算：ASCII 字符数 / 4 + 其他字符数 / 1.5 | kind triage |

4. 归属：机器人名下的会话（当前会话、轮换前的旧会话、它们的子会话）归该机器人；其中主人亲手发起的回合（回合里有 source.kind 为 user 且带 rpcId 的消息）initiator = owner；其他根会话归主人；冒烟测试会话归 hub。没有唤醒单却在机器人会话里产生的用量（例如别的插件给它 followup）仍记 initiator = bot，计入它的预算。
5. 盲区。下面这些不在账上，界面和日报必须写明「不含」：DSH 之外用同一 GLM 账号的调用；其他插件直接调模型的辅助调用（如 Auto review，机器人一律不开）；请求失败且没返回用量的调用；金额（harness 不读价格）。搜索、标题生成只有估算。
6. 展示：总览页额度条、机器人卡片、日报额度段都带「估算」二字，展开后显示固定文案：「估算值（×1.2）。已含：主循环、压缩摘要、子会话、网页搜索（估）、标题生成（估）。不含：DSH 之外用同一账号的调用、其他插件的辅助调用、失败且未返回用量的请求。」界面位置见第 16 章。

#### 单机器人预算【一期】

1. 次数：每个机器人每天可放行的自发思考回合 = min(自主等级的每日思考上限（L0 2 / L1 6 / L2 10 / L3 12）, 每日次数预算（默认 6）)；每个窗口 ≤ 3 次。试岗期两项预算都乘 0.5、向下取整、最少 1，即每天 3 次、每窗口 1 次。
2. 计入次数的回合：常规、轻复查、复盘、补课、探针。主人亲手发起的不计；试跑计入上岗首日（第 6 章）。
3. token：每天 25 万计量 token（试岗 12.5 万），只累计 initiator = bot 的账，含所有 provider：网页搜索不占 GLM 窗口，但占机器人预算。窗口内不单设 token 上限，由全局份额约束。
4. 本次上限：放行时算本次 token 上限 = min(该回合变体的 token 上限（第 7.8 节，常规回合 6 万）, 当日剩余 token, 机器人合计份额剩余 token（已校准时）)，写进唤醒包的「本次上限」，由回合守卫执行（第 7 章）。算出来不足 1 万就不放行。
5. 到顶：当日次数到顶记停止条件 S4；当日 token 或窗口次数到顶记 S5。机器人转 resting，文案写恢复时刻：窗口到顶取窗口 ends_at，当日到顶取次日 00:00。感知照常记录。
6. 自然日在 Asia/Shanghai 00:00 切换，窗口按 quota_state 切换。
7. 机器人不能改自己的预算，只能发提议请主人加额度（第 10 章）；批准只对当天有效。
8. 单日计量 token ≥ 3 倍当日预算 → quarantined（第 15 章「错误重排与隔离」）。正常放行下不会发生，只在有回合绕过放行时触发，是失控兜底。

#### 全局份额与主人份额【一期】

1. 记 C 为窗口总容量估计（校准后才有）。机器人合计份额 70%，主人份额 30%。
2. 已校准：机器人有效份额 Q_bot = 0.70 × C − max(0, U_owner + U_hub − 0.30 × C)。U 是本窗口 counts_window 的计量用量。主人超出自己 30% 的部分从机器人份额里扣，窗口总量不会超过 C。token 和请求数各算一个 r = U_bot / Q_bot，取大者；Q_bot ≤ 0 时 r 记为 1。
3. 未校准（从没报过 QUOTA）：只按次数，r = bot_turns_granted / S，S 初始 8。这时无法按 token 保护主人的 30%，靠两条兜住：S 取得保守；主人 10 分钟内在 DSH 亲手发过消息时同时思考上限降为 1（第 7 章）。
4. 放行即预占：放行时 bot_turns_granted 加 1，立刻重算 r；token 维度在回合内随计量更新。
5. 主人自己的会话从不被中心拦截或排队，中心只记账。

#### 额度灯【一期】

| 灯 | 判定 | 放行行为 | 机器人状态与文案 | 通知 |
|---|---|---|---|---|
| green | r < 0.50，且没有红灯条件 | 正常 | 不变 | 无 |
| yellow | 0.50 ≤ r < 0.80 | 非紧急候选的 pace_min ×2（与无变化退避叠乘，仍封顶 24 小时）；紧急（理由里有显著性 ≥ 0.90 的感知）和主人发起不受影响 | 不变 | 无；额度条变黄 |
| orange | 0.80 ≤ r < 1.00 | 只放行紧急和主人发起，其余留在队列 | 被留下的显示 queued「等额度恢复」 | 总览横幅「额度紧张，只处理紧急的事，约 HH:MM 恢复」；不单推 |
| red | 任意会话出现 QUOTA 报错；或 r ≥ 1.00 | 不放行任何机器人思考；主人在会话里亲手发消息不拦（QUOTA 时会失败，横幅说明） | 全体 resting「歇着：额度保护，HH:MM 继续」，HH:MM 取 red_until | QUOTA：P0 单推，免打扰时段照发，同一窗口只推 1 次；份额用尽：不单推，只进日报 |

1. 重算时机：每笔记账、每次 tick（60 秒）、每次报错、窗口切换。
2. red_until：QUOTA 引起的，取报错原文解析出的重置时间（reset_source = parsed）+ 5 分钟，解析不到取当前窗口 ends_at + 5 分钟；份额用尽引起的，取 ends_at + 5 分钟。
3. 红灯时正在跑的回合：QUOTA 引起的，回合已被 DSH 以错误结束，中心不重试，唤醒单记 interrupted 后重新入队（第 7.6 节）；份额用尽引起的，不打断，它们本来就受本次上限约束。
4. 探针：到 red_until 后 probe_state = waiting，界面文案「额度恢复检测中」。调度器按「仲裁顺序」取第 1 个候选当探针，单独放行（并发 1）。没有候选就一直等，不为探测专门调用模型。
5. 探针回合的第一次模型请求成功 → passed，清红灯，重算灯。QUOTA 引起的红灯在这时开新窗口（started_at = 探针开始时刻，reset_source = probe）；份额用尽引起的红灯，窗口已按常规切换，不再另开。ramp_until 之前同时思考上限为 1，之后恢复正常。
6. 探针遇到 QUOTA → failed：probe_failures 加 1；red_until 取解析出的重置时间 + 5 分钟，解析不到则在 30 分钟、60 分钟、120 分钟后再探（第 1、2、第 3 次及以后）。探针的唤醒单重新入队，不算机器人出错，不计入它的次数。
7. QUOTA 单推文案：「额度用完：机器人暂停到约 HH:MM，你自己的对话也可能受影响。」恢复后不再单推，日报记一笔：红灯次数、时长、校准变化。

#### 仲裁顺序【一期】

调度器放行前对每个候选调用额度闸，结果是放行（附本次上限）或延后（附原因和最早时间）。按下面的顺序判断，第一个不满足的条件就是「为什么没醒」里记录的原因（第 16 章展示）：

1. 中心处于 maintenance（第 15 章）或主人全局暂停 → 延后。
2. 鉴权暂停中（见「报错分类」AUTH）→ 延后。
3. 红灯：还没到 red_until → 延后到 red_until；已到 red_until 但已有探针在跑（probe_state = running）→ 延后；否则本候选可以当探针，继续往下判断。
4. 全局故障退避中（第 15 章）→ 延后。
5. 橙灯，且候选既不紧急也不是主人发起 → 延后到灯降为黄。
6. 黄灯，且候选不紧急：距该机器人上次思考结束不足 2 × pace_min → 延后。
7. 该机器人当日次数、窗口次数、当日 token 任一到顶 → 延后（S4 / S5）。
8. 本次上限不足 1 万 → 延后。
9. 放行。

几个候选都能放行、但名额不够（并发上限、90 秒放行间隔、探针只放 1 个）时，按下面的顺序取：

1. 主人发起：主人在中心页点「现在想一下」（飞书口令为二期）。
2. 紧急：理由里有显著性 ≥ 0.90 的感知。
3. 对人承诺到期：理由是到期的 commitment 或 follow_up 议程项。
4. 排序分高者：排序分 = 思考分 + min(0.20, 0.05 × 已排队的整 30 分钟数)。
5. 本窗口已用比例低的机器人：它本窗口已放行次数 / 它的窗口次数上限。
6. 先入队者。

队列结构、合并与过期见第 7 章；本节只定额度相关的先后。

#### 校准【一期】

1. 窗口边界：上一窗口的 ends_at 过去之后，第一笔 counts_window 调用开新窗口，ends_at = started_at + 5 小时。例外：QUOTA 引起的红灯期间不开新窗口，等探针成功时再开（见「额度灯」第 5 条），否则一次失败的探针会被当成新窗口里的首次报错。QUOTA 报错原文里能解析出重置时间时，用它修正当前窗口的 ends_at。GLM 窗口是否这样起算【待验证 V16】。
2. 下调：每个窗口只用首次 QUOTA 报错校准；红灯期间（探针成功之前）的 QUOTA 报错一律不参与校准，只按探针失败处理。记报错点 E = 本窗口全部 counts_window 用量（机器人 + 主人 + 中心），token、请求数各一个；C = min(C, 0.9 × E)，未校准时直接 C = 0.9 × E 并置 calibrated = true；calibration = lowered。
3. 上调：每个窗口结束时，若本窗口没有 QUOTA 报错且总用量 < 0.50 × C，low_streak 加 1，否则清零。low_streak 达到 3 → C = min(1.1 × C, ceiling)，low_streak 清零，calibration = raised。
4. ceiling = max(最近一次报错点 E, 无报错窗口里出现过的最高总用量 × 1.1)。为什么设上限：用量低于 50% 的窗口给不出容量更大的证据，不设上限，长期安静后 C 会漂得过高，第一次真正用满时会撞上额度报错，连累主人自己的对话。
5. 未校准时 S 不自动上调。连续 3 个窗口机器人都用满 S（份额用尽红灯）且没有报错时，日报给一条建议「可以把机器人每窗口份额从 8 次调到 9 次」，由主人在设置里改。
6. 主人在设置里点「重新校准」（例如换了套餐）→ 清空 C 和 ceiling，calibrated = false，S 回到 8，calibration = reset。
7. 每次校准变化写 audit，并在日报写一行，例如「容量估计 62 万 → 56 万（14:20 额度报错，当时窗口总用量 62 万）」。

#### 报错分类与处理【一期】

模型请求的报错在 agent/request-error 里分类；会话层的报错从 resolveAgent、prompt、followup 抛出的错误码分类。按顺序判断，命中即止：

1. failure.code 为 QUOTA 或 ACCOUNT_QUOTA，或 HTTP 402 → QUOTA。
2. failure.code 为 AUTH，或 HTTP 401 / 403 → AUTH。
3. 原文含强额度词 → QUOTA。强额度词初始：额度、配额、套餐、余额、欠费、quota、usage limit、insufficient balance。
4. 原文含上下文超长词，或 failure.code 指向上下文超长【待验证 V18】→ CONTEXT。上下文词：上下文、长度、context length、context window、maximum context、too long（不用单独的 context，免得把「context deadline exceeded」这类超时误判进来）。这一条排在弱额度词前面，避免把「上下文超长」误判成额度用完。
5. 原文含限流词 → RATE_LIMIT。限流词：频率、并发、速率、请求过多、请求太多、too many requests、rate limit。
6. 原文同时含弱额度词和时间词 → QUOTA。弱额度词：限额、上限、用量、用完、用尽、已达；时间词：小时、今日、每日、本周、每周、周期、重置、reset。误判方向的取舍：把限流错当额度会让全体停歇到窗口重置，代价比反过来大，所以有歧义的词（限额、上限）都要求同时出现时间词。
7. failure.code 为 RATE_LIMIT，或 HTTP 429 → RATE_LIMIT。
8. failure.code 为 SERVER、TIMEOUT、TRANSPORT、EMPTY_RESPONSE，HTTP 5xx，网络错误 → TRANSIENT。
9. 会话层：agent-preset/not-found → PRESET_LOST；session/not-found → SESSION_LOST；session/writer-held → WRITER_HELD；gateway/internal → TRANSIENT。
10. 其他 → TRANSIENT，并标「按临时错误兜底」；原文落库，日报「没见过的报错」一节列出，供校准词表。

| 类别 | DSH 自己的重试 | 中心处理 | 计入机器人出错 | 告警 |
|---|---|---|---|---|
| QUOTA | 在 agent/request-error 里直接终止，不让 llm-retry 再试【待验证 V18】 | 额度灯 red，按「额度灯」恢复；按「校准」下调；本唤醒单记 interrupted 后重新入队 | 否 | P0，立即，每窗口 1 次 |
| RATE_LIMIT | 交给 DSH normal 模式，最多再试 5 次 | 仍失败后按错误重排阶梯重排；30 分钟内 ≥ 2 个机器人出现 → 全局故障（第 15 章） | 是（全局故障期间不计） | 连续 2 次才报 |
| TRANSIENT | 同上 | 同上 | 同上 | 同上 |
| AUTH | 直接终止 | 鉴权暂停：所有机器人思考不放行；收件箱放一条告警请主人重新登录；主人点「已重新登录」，或观察到任一会话请求成功后，先放 1 个探针 | 否 | 立即（全体停摆，P0） |
| CONTEXT | 直接终止 | 先轮换会话（第 11 章），再把同一唤醒单重排 1 次；仍失败计 1 次出错 | 第二次起计 | 连续 2 次才报 |
| PRESET_LOST | — | 不重试，该机器人 quarantined；≥ 2 个机器人同时出现 → 中心转 maintenance（多半是组合包被停用或角色模板改名） | — | 立即 |
| SESSION_LOST | — | 不重试，quarantined；主人可在详情页选「换新会话恢复」，按第 11 章的轮换流程从文件冷启动 | — | 立即 |
| WRITER_HELD | — | 每 5 分钟重试，最多 3 次；仍被占用 → quarantined，文案「会话被别的进程占着（可能开着 dsh web 或 headless）」 | — | 第 3 次失败时 |

1. 机器人回合所用路由的 retryPolicy 固定为 normal，禁止 always：always 会无限重试，连 QUOTA 也重试，并一直占着回合。中心启动时和之后每小时检查一次：读得到配置【待验证 V20】且发现 always → 中心转 maintenance 并告警「机器人用的模型路由开了无限重试，请在设置 → 模型里改回 normal」；读不到 → 在常开环境清单里列为「待你确认」（第 15 章）。
2. 中心从不叠加立即重试；同一唤醒单的再次尝试只走第 15 章的重排阶梯。
3. 每次报错把类别和原文前 500 字写进唤醒单（第 7.6 节）。界面展示「类别 + 原文」，不展示猜测；分类不了的写「未识别（按临时错误处理）」，不写成额度问题。
4. 主人会话里的报错同样分类：QUOTA、AUTH 影响全局；其余只记录，不处理。
5. 词表用第一次真实的 GLM 额度报错校准【待验证 V4】，首次 QUOTA 原文存在 quota_state.error_raw。

#### 高峰时段【二期】【待验证 V17】

1. 若 V17 确认主人用的是 GLM Coding Plan，且工作日 14:00–18:00（Asia/Shanghai）为高峰、非高峰按 50% 计：时段系数非高峰取 0.5、高峰取 1.0，计量 token 和请求数都乘。
2. 高峰时段里，同一理由（指纹）上次用量超过 3 万计量 token 的非紧急候选，延后到 18:00 之后；紧急和主人发起不受影响。
3. 一期不区分时段，系数恒为 1.0，只在账上记 peak，供 V17 核对。

#### 用量展示【一期】

1. 总览页顶部：额度灯、「机器人本窗口已用 62%（估算）」、预计重置时间；红灯时显示原因（额度报错 / 份额用尽）和 red_until。
2. 机器人卡片：「今日 3 / 6 次 · 11.2 万 / 25 万 token（估算）」；歇着时显示恢复时刻。
3. 日报额度段：每个机器人昨天的次数与计量 token、各窗口的灯色变化、红灯次数与时长、校准变化、「没见过的报错」。
4. 所有展示都带 14.3「计量口径与盲区」第 6 条的估算说明。

### 14.4 流程

1. 放行：调度器取候选 → 额度闸判断 → 放行时开唤醒单（第 7.6 节），bot_turns_granted 加 1，重算灯，把本次上限写进唤醒包。
2. 回合中：每一步开始时读该会话投影，更新主循环账；回合守卫用同一数字判断是否到线（第 7 章）。
3. 回合结束：turn/end 后再读一次投影定稿；处理同期的 compaction/summary 与 web_search 事件；重算窗口用量与灯；更新机器人当日用量，必要时把它转 resting。
4. 报错：agent/request-error 分类 → 按处理表执行。QUOTA 时依次：终止请求 → 灯 red → 写 error_point 与 error_raw → 校准 → P0 单推 → 唤醒单记 interrupted 并重新入队。
5. 窗口到期：tick 发现 ends_at 已过 → closed = true，算 low_streak，满足条件就上调；下一笔 counts_window 调用开新窗口（QUOTA 红灯期间除外）。
6. 红灯恢复：tick 到 red_until → probe_state = waiting → 下一个候选当探针 → 成功则清红灯、10 分钟后恢复并发；失败则按 30 / 60 / 120 分钟再等。

### 14.5 实现

- 计量：`ctx.on('session/event')` 收 turn/end、compaction/summary、工具调用和 llm/retry 事件；`ctx.sessionController.projections({sessionId}, signal)` 读 tokenUsage（uncachedInputTokens、outputTokens、cacheReadTokens、cacheWriteTokens，按整份持久日志累计，同一步的重试另算）与 sessionStats（steps）；冷会话也能读，不用唤醒机器人。需要时用 `ctx.tokenMeter.measure(session)`。子会话归属用 `sessionController.list` 行里的 parentSessionId。
- 主人发起的识别：会话事件里 source.kind 为 user 且带 rpcId 的消息；中心自己的投递用自有 source.kind【待验证 V1】。
- 放行：额度闸是中心调度器内的纯函数；没持唤醒单的回合由第 7 章在 agent/pre-step 拦下（reject 会吞掉本步消息【待验证 V11】）。
- 报错：在 `agent/request-error` 瀑布上用 prepend 注册监听，读 failure.code 与原文；QUOTA、AUTH、CONTEXT 返回终止，其余调 next() 交给 llm-retry【待验证 V18】。`agent/error` 与 turn/end 的 reason 做事后兜底。会话层错误码 agent-preset/not-found、session/not-found、session/writer-held、gateway/internal 从 resolveAgent / prompt 的异常里读。
- 背景事实：llm-retry 的 normal 模式对 RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT、EMPTY_RESPONSE 最多重试 5 次，不重试 QUOTA；DSH 只按英文措辞把报错判成 QUOTA，GLM 的中文额度报错可能被归成 RATE_LIMIT 先重试 5 次，所以中心必须在 request-error 这一层抢先识别。
- 存储：budget_ledger、quota_state 在 `ctx.storageDomain.open({name: 'agent_hub', layout: 'per-record', invalidRecords: 'backup-and-skip', tables})` 下，写前自校验（写入时 DSH 不校验）。
- 没有能查 GLM 剩余额度的接口（底稿未找到），所以全部靠自记账和报错校准。
- web_search 的后端只有 DeepSeek，需要单独的 DEEPSEEK_API_KEY；一次搜索是一整轮 deepseek-v4-flash 调用（maxTokens 4096，最多 5 次服务端搜索），不进 tokenUsage，花的是 DeepSeek 的钱，不占 GLM 窗口。
- 机器人的角色模板里不开 Auto review：它每次工具调用多一次模型请求，且不计入用量。

### 14.6 验收

#### 计量

1. 机器人会话跑完一个回合：budget_ledger 有且只有 1 行该回合的 main_loop，tokens 等于该会话回合前后 projections 四桶之差按公式折算 × 1.2，误差为 0。
2. 触发一次压缩：出现 kind = compaction 的行；事件不带 usage 时记 72,000（6 万 × 1.2），measured = estimated。
3. 机器人调用 1 次 web_search：出现 kind = search、tokens = 12,000、counts_window = false 的行；该行计入机器人当日 token，不计入窗口用量。
4. 主人在机器人会话里亲手发 1 条消息：该回合 initiator = owner；机器人当日次数不变；used_tokens_owner 增加。
5. 机器人回合里起的子代理，用量归到该机器人。
6. 总览额度条、机器人卡片、日报额度段都带「估算」，展开后是 14.3 规定的固定文案，逐字一致。

#### 预算

7. 试岗机器人在同一窗口的第 2 个自发候选被延后，原因 S5，界面显示「歇着：额度保护，HH:MM 继续」，HH:MM 等于窗口 ends_at。
8. 在岗 L1 机器人当天第 7 个自发候选被延后（S4）；次日 00:00 之后可以放行。
9. 当日剩余 4 万计量 token 时放行：唤醒包里本次 token 上限为 4 万；剩余 8,000 时不放行。
10. 构造某机器人单日用量 76 万（超过 25 万的 3 倍）：它转为 quarantined。

#### 份额与额度灯

11. 未校准、S = 8：放行第 4 次后灯为 yellow，第 7 次后为 orange，第 8 次后为 red，red_reason = share_exhausted，且没有单推。
12. 已校准 C = 100 万、主人本窗口已用 45 万：机器人有效份额 = 70 万 − 15 万 = 55 万；机器人用到 27.5 万时灯变 yellow。
13. orange 时队列里同时有「主人点现在想一下」「显著性 0.92 的紧急候选」「思考分 0.75 的普通候选」：只放前两个，主人的在先；普通候选显示「等额度恢复」。
14. yellow 时非紧急候选按 2 × pace_min 的间隔放行；紧急候选不受影响。

#### 报错与恢复

15. 表驱动单测覆盖识别顺序每一步，每步至少 2 条样例，全部通过，其中必须包含：「输入长度超过模型上限」判 CONTEXT；「请求频率超过上限，请稍后再试」判 RATE_LIMIT；「您的 5 小时使用额度已用完，将于 15:40 重置」判 QUOTA 并解析出 15:40。
16. 注入一个 code = RATE_LIMIT、原文「套餐额度已用完」的请求错误：会话日志里该步没有 llm/retry 重试记录（V18 成立的前提下；不成立时改为验证分类结果和其余各项）；灯变 red；P0 单推恰好 1 条；quota_state 写入 error_point 与 error_raw；C = 0.9 × 当时窗口总用量。
17. red_until 到点、队列里有 3 个候选：只放行 1 个探针；探针成功后 10 分钟内同时最多 1 个在想，之后最多 2 个。
18. 探针再次遇到 QUOTA：分别在 30、60、120 分钟后再探；C 不变；探针的唤醒单不计机器人出错、不计次数。
19. 模拟 AUTH：所有机器人停止放行，收件箱出现重新登录告警；点「已重新登录」后先放 1 个探针。
20. 在 V20 可读的前提下，把机器人路由的 retryPolicy 改成 always：中心转 maintenance 并告警；改回 normal 后重新自检通过才恢复。
21. 主人会话里出现 QUOTA：同样亮红灯并参与校准。

#### 校准

22. 连续 3 个已结束窗口都没有报错且总用量 < 50% C：C 变为 min(1.1 × C, ceiling)，日报有一行说明；其间任一窗口报错，low_streak 清零。
23. 设置里点「重新校准」：calibrated = false，S = 8，日报记一行。

### 14.7 新增建议

1. 计量增加「请求数」维度，与 token 并行校准、取大者判灯。理由：GLM 的计额单位未确认（V16）；若按请求数或 credits 计，只看 token 会系统性偏差。
2. 骨架第 6 节「额度份额」补上调规则：连续 3 个窗口无报错且总用量 < 50% C 时 C 上调 10%，上限 ceiling = max(最近报错点, 无报错窗口最高总用量 × 1.1)；并写明红灯期间不开新窗口、红灯期间的报错不参与校准。理由：只有下调没有上调，一次偶然的额度报错（例如主人在 DSH 之外用了同一账号）会让容量估计永久偏低；上调不设上限，长期安静后又会漂高；探针失败若被当成新窗口里的首次报错，会把容量估成接近 0。
3. 网页搜索计入机器人预算，但不计入共用窗口。理由：搜索走 DeepSeek 计费，不占 GLM 额度；骨架第 6 节「计量」把搜索列在一起，建议注明这一区别。
4. 骨架第 6 节补充参数：缓存读取权重默认 0（待 V16）；本次上限下限 1 万；估算值（搜索 1 万 / 次、标题 2,000 / 次、压缩缺 usage 时 6 万）；探针失败再探 30 / 60 / 120 分钟；探针成功后 10 分钟并发 1；排队加分 0.05 / 30 分钟、封顶 0.20；计量明细保留 30 天。
5. 「鉴权暂停」作为与额度灯并列的全局闸，不并进额度灯。理由：把鉴权问题显示成额度问题会误导主人（主人记录里有过把「上下文超长」说成「在等额度」的情况）。
6. 骨架第 6 节「隔离触发」补上 PRESET_LOST、SESSION_LOST、WRITER_HELD 三次失败。
7. 默认预算 6 次 / 天会让 L2、L3 的 10 次、12 次上限不生效。建议主人把机器人升到 L2 及以上时，界面同时提示调预算；或把预算默认值改为 min(等级上限, 6)，允许主人提高到等级上限。
8. 若 V16 证实存在每周额度层：quota_state 增加周累计和周灯，周额度报错同样按 QUOTA 处理，red_until 取周重置时间。

## 15. 运行保障

### 15.1 职责

健康（Health）与适配层负责「不崩、不漏、不重复、停了会说」：中心自己永远不带崩 DSH；任何该动没动、卡住、来源失明、停机都被发现并报告，不靠主人追问；停机恢复后有序补课；DSH 升级后先自检再放行思考；DSH 之外由看门狗盯住中心本身。机器人只能在「电脑醒着、DSH 开着」时运行，这条硬边界用常开环境清单和近 7 天在线率管理，停机期间不假装在盯。

### 15.2 数据

#### 心跳文件 `~/.dsh/agent-hub/heartbeat.json`【一期】

每 30 秒原子写一次（先写同目录临时文件，再 rename），不超过 4 KB。

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| schema | int | 文件格式版本 | 1 |
| hub_version | string | 中心组合包版本 | |
| dsh_version | string \| null | 当前 DSH 版本 | 取法【待验证 V23】，取不到写 null |
| boot_id | ULID | 本次插件加载编号 | 每次 apply 新生成 |
| pid | int | 宿主进程 pid | |
| seq | int | 心跳序号 | 本次加载内单调递增 |
| written_at / written_at_ms | ISO / int | 写入时间 | 用 Date.now() |
| last_tick_at_ms | int | 意图时钟最近一次 tick 完成的时间 | 用来发现「心跳在、调度停了」 |
| state | starting / running / stopped | 中心状态 | stopped 只在正常卸载时写；崩溃不会留下 stopped |
| hub_mode | normal / maintenance | 运行模式 | |
| quota_light | green / yellow / orange / red | 额度灯 | |
| auth_blocked | bool | 是否处于鉴权暂停 | |
| thinking | string[] | 正在思考的 bot_id | |
| queued | int | 队列长度 | |
| bots | {active, probation, paused, quarantined} | 各生命周期的机器人数 | |
| tripped | string[] | 已熔断的组件 | |
| ui_available | bool | 界面 slot 是否注册成功 | |
| p0_pending | [{alert_id, text, created_at}] | 中心飞书出站失败、尚未送达的 P0 告警 | 最多 5 条，交给看门狗代发 |

#### downtime（停机记录，一段停机一行）【一期】

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| downtime_id | ULID | 记录编号 | 主键 |
| started_at | ISO | 停机开始 = 停机前最后一次心跳或 tick 的时间 | |
| ended_at | ISO | 中心恢复运行的时间 | |
| minutes | int | 停机时长 | ≥ 10 才建记录 |
| cause | sleep / app_quit / crash / hub_unloaded / unknown | 推断原因 | 推断规则见「停机检测与补课」 |
| evidence | string，≤ 200 字 | 推断依据 | 如「进程内两次 tick 相隔 4.5 小时，pid 未变」 |
| detected_by | tick_gap / startup | 发现方式 | |
| interrupted_wakes | string[] | 被打断的唤醒单 | |
| catchup_wakes | string[] | 补课唤醒单 | 每个机器人至多 1 张 |
| skipped | int | 过期跳过的事由数 | |
| to_owner | string[] | 改成「需要你」的审批单 id | |
| alert_id | string \| null | 对应的 downtime_long 告警 | 停机 ≥ 12 小时才建 |
| digest_day | YYYY-MM-DD \| null | 已写进哪天的日报 | |

#### settings 里的运行保障参数与状态【一期】

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| health.heartbeat_sec | int | 30 | 心跳间隔 |
| health.stale_min | int | 5 | 看门狗判心跳陈旧 |
| health.watchdog_check_sec | int | 120 | 看门狗检查间隔 |
| health.tick_gap_min | int | 10 | 两次 tick 间隔超过它视为刚醒来 |
| health.deadman_grace_min | int | 30 | expected_by 的宽限 |
| health.stuck | {idle_min, total_min} | {10, 30} | 卡住判定 |
| health.startup_quiet_min | int | 3 | 启动静默 |
| health.catchup_gap_sec | int | 90 | 补课放行间隔 |
| health.downtime_alert_hours | int | 12 | 停机多久才建告警 |
| health.retry_ladder_min | int[] | [2, 10, 30, 120] | 错误重排阶梯，±20% 抖动 |
| health.global_fault_window_min | int | 30 | 全局故障判定窗口 |
| health.breaker | {window_min, errors, halfopen_min} | {10, 5, 30} | 组件熔断 |
| health.writer_held | {gap_min, max} | {5, 3} | 会话被占用时的重试 |
| health.source_blind | {factor, restarts} | {2, 3} | 来源失明：超过 2 倍间隔；重启 3 次仍失败告警 |
| health.backup | {at, keep} | {04:00, 14} | 每日备份时刻与保留份数 |
| health.online_warn | float | 0.80 | 近 7 天在线率警戒线 |
| health.hub_mode | normal / maintenance | normal | 持久化，重启后保持 |
| health.mode_reason | string | | 进入 maintenance 的原因 |
| health.verified | {dsh_version, hub_version, api_fingerprint, at} | | 最近一次冒烟测试通过时的版本与服务探测哈希 |
| health.last_smoke | {at, passed, failed_step, error} | | 最近一次冒烟测试结果 |
| health.auth_blocked_since | ISO \| null | | 鉴权暂停开始时间 |
| health.global_fault | {since, attempt, until} \| null | | 全局故障退避状态 |
| health.tripped | {组件名: {since, halfopen_tried}} | | 已熔断组件 |
| health.last_backup | {at, path, counts, ok} | | 最近一次备份 |
| health.watchdog | {installed, installed_at, last_seen_at} | | 看门狗状态（读看门狗的 state.json） |
| health.env_checklist | {项: {status, checked_by, at}} | | 常开环境清单每项的状态 |

#### 备份目录 `~/.dsh/agent-hub/backups/YYYY-MM-DD/`【一期】

每张表一个 `<表名>.jsonl`（一行一条记录），外加 `manifest.json`：{hub_version, dsh_version, at, tables: {表名: {count, sha256}}}。放在 `~/.dsh` 下而不是根目录 `~/AgentHub/`：机器人在 workspace-write 下只能写自己的家目录和临时区，改不到备份；也不会进根目录的 git 历史。

#### 看门狗文件【一期，需主人同意安装】

| 路径 | 内容 |
|---|---|
| `~/Library/LaunchAgents/com.dsh-agent-hub.watchdog.plist` | launchd 任务：StartInterval 120，RunAtLoad true |
| `~/.dsh/agent-hub/watchdog/watchdog.sh` | zsh 脚本，只用系统自带命令（pgrep、plutil、date、osascript）和 lark-cli |
| `~/.dsh/agent-hub/watchdog/state.json` | {last_run_at, case, case_since, alerted_case, restarts: [时间]} |
| `~/.dsh/agent-hub/watchdog/ack.json` | 已代发的 P0 alert_id |
| `~/.dsh/agent-hub/watchdog/watchdog.log` | 每次判定一行，保留 7 天 |

### 15.3 规则

#### 心跳【一期】

1. 心跳每 30 秒写一次，定时器独立于 60 秒的意图时钟；写失败只记日志，不抛到宿主。
2. apply 一开始写 state = starting；存储打开、版本比对完成后写 running；正常卸载（dispose）时最后写一次 stopped。看门狗靠有没有 stopped 区分正常退出和崩溃。
3. 中心自查：心跳在写、但 last_tick_at 落后超过 5 分钟 → 判为调度停转，重建意图时钟的定时器 1 次，并立即告警（全体停摆，P0）。

#### 死人开关【一期】

1. 每次 tick，为每个 probation / active 机器人算 expected_by = min(下次思考时刻, 最早一条未处理的紧急感知（≥ 0.90）的产生时间) + 30 分钟。下次思考时刻：at 取该时刻；after 取上次回合结束 + 时长；on_event 和 auto 取上次回合结束 + pace_max（有进行中目标 48 小时，其余 7 天）。
2. 漏醒：当前时间已过 expected_by，自 expected_by − 30 分钟以来该机器人没有放行过唤醒单，而且队列里没有它的、带合法延后原因的条目。合法延后原因：额度灯（橙、红）、鉴权暂停、全局故障退避、预算到顶、并发已满、maintenance、暂停、等主人。命中漏醒 → 立即补一条队列条目（理由「漏醒补发」，原理由与证据照抄），记进健康日志；同一机器人连续第 2 次漏醒才告警。有合法延后原因的只记进「为什么没醒」，不算漏醒。
3. 卡住：思考中的回合 10 分钟没有任何会话事件，或总时长超过 30 分钟（回合守卫在 20 分钟收口、23 分钟取消，这里是第二道防线）：
   - 先查是否挂在审批或提问上：有 approval/asked 没有对应的 approval/decided，或有待回答的提问；
   - 取消回合（sessionController.cancel，保留收件箱），唤醒单记 cancelled 并注明 stuck，计 1 次回合出错，按「错误重排」阶梯重排；
   - 挂在审批上，说明无人值守权限档没生效：立刻对该会话重设无人值守权限档，并立即告警「X 卡在审批（原因：写工作区外文件），已取消并重设权限档」；
   - 其他原因卡住：同一原因第 2 次才告警；
   - 取消后 2 分钟仍在运行 → 该机器人 quarantined 并告警。
4. 感知源健康：每条关注项记来源最近一次成功时间。file 类以 5 分钟一次的快照为准，http、script 以各自的轮询间隔为准。超过 2 倍间隔没有成功 → 标「失明」，重启该来源（重挂 watch 或重启轮询）；连续 3 次重启仍失败 → 告警，并在该机器人下次的唤醒包里写明「这些来源失明：…」。失明和期望落空是两回事：读不到文件是失明；读到了、但该出现的新行没出现是期望落空，产生异常感知（第 7 章）。来源健康字段记在 watches 上（第 7 章）。
5. 长期沉默：在岗机器人 3 × pace_max 内没有一次成功交账 → 告警「长期沉默」。这是兜底，正常情况下内驱会更早叫醒它。
6. 日报固定有「应醒未醒 / 卡住 / 失明 / 被隔离」一节，全部正常也写「全部按时」（第 10 章）。

#### 停机检测与补课【一期】

1. 两个入口，任一命中就写 downtime：(a) 插件启动时，上一份心跳的 written_at 距今超过 10 分钟；(b) 运行中两次 tick 的 Date.now() 相差超过 10 分钟（电脑休眠后醒来）。ctx.interval 在休眠后的补偿延迟未知【待验证 V3】，所以只信真实时间。
2. 原因推断：入口 (b) → sleep；入口 (a) 且 pid 没变 → hub_unloaded（宿主没重启，只是中心被停用、重载，或卸载时没来得及写 stopped）；入口 (a)、pid 变了、上一份心跳 state = stopped → app_quit；入口 (a)、pid 变了、state 不是 stopped → crash（宿主没正常卸载，宿主运行中断电也落在这里）；其他 → unknown。
3. 恢复后先静默 3 分钟，只对账、不放行思考（主人亲手发消息不受影响）。对账内容：
   - 唤醒单：按下一节「唤醒单幂等」处理；
   - 游标补拉：每条关注项按自己的游标补一次。file 对比快照哈希；http、script 立即执行一次；log 期望检查停机期间应出现的行是否出现；session 事件从游标序号起用 sessionQuery 补读（只有「DSH 在跑、中心被停用」这种停机才会漏会话事件）。补到的变化照常打分，不因为欠得多就多醒；
   - 议程：停机期间到期的议程项标「已过期 X 小时」；
   - 出站动作：停机期间到点、还没执行的，一律不自动执行，改成审批单，例如「原定 03:10 发出，因停机没发，现在还发吗？」；执行中、状态未知的，改成「可能已发出，状态未知，要重发吗？」，绝不自动重发（第 9 章）。
4. 补课：对账后，每个机器人至多 1 次补课回合（变体 catch-up，活动状态 catching_up），合并它被打断的回合、过期议程、补拉到且过门槛的感知。三样都没有就不补课，只在日报写「停机期间无事」。补课每 90 秒放行 1 个，仍过额度闸。唤醒包写明停机区间与原因，例如「DSH 停了 4.5 小时（01:10–05:40，休眠）」。
5. 停机 ≥ 12 小时：对账完成后建 1 条 P2 告警 downtime_long（总览横幅 + 日报），写明停了多久、补课几个、跳过几个、几件事转给了主人；转成审批单的事项按第 10 章自己推送。不足 12 小时只进日报。
6. 日报「停机记录」逐段列出：起止、时长、原因、补课数、跳过数、转给主人的事项（第 10 章）。

#### 唤醒单幂等【一期】

唤醒单的字段与阶段见第 7.6 节，这里只定恢复时怎么处理：

1. 启动或醒来对账时，阶段停在 delivered 或 started、没有 ended 的唤醒单 → 标 interrupted；每张至多补发 1 次恢复唤醒，并入该机器人的补课，消息里写「上次被打断」。
2. 阶段停在 granted（还没投递）的 → 重投前先在会话收件箱（projections 的 inbox）和会话日志里找带该 wake_id 的消息，找到就不重投，接着等结果。
3. 恢复唤醒本身又被打断 → 不再补发，计 1 次回合出错。
4. 开始执行时已经超过过期时间的唤醒单，只许汇总、不许对外动作（第 7.6 节的时间护栏）。

#### 错误重排与隔离【一期】

1. 重排阶梯：唤醒单因 RATE_LIMIT、TRANSIENT（DSH 自己重试 5 次后仍失败）或卡住被取消而失败 → 同一唤醒单在 2 分钟、10 分钟、30 分钟、2 小时后重排（每档 ±20% 随机抖动）；第 4 次重排仍失败 → 该机器人 quarantined。中心不做任何立即重试。
2. 全局故障：30 分钟内 ≥ 2 个机器人出现 RATE_LIMIT 或 TRANSIENT → 判为供应商故障。所有机器人的放行按同一阶梯整体退避，不计入各自的重排次数和出错次数；立即告警 1 次（全体停摆，P0）；任一回合成功即解除。
3. 回合出错计数：机器人最近连续以错误结束的唤醒单数，从 wakes 现算，不另存。QUOTA、AUTH 和全局故障期间的失败不计。连续 3 次 → quarantined。
4. 其他隔离触发：越界尝试 3 次（口径见第 9、13 章）；复盘后仍连续 2 次未交账（第 7 章）；单日用量 ≥ 3 倍预算（第 14 章）；第 14 章报错表里的 PRESET_LOST、SESSION_LOST、WRITER_HELD 三次失败。
5. 隔离动作：取消正在跑的回合（保留收件箱）；把队列里它的条目移进「隔离前积压」；感知照常记录（便于恢复后补课），不评估、不算内驱、不放行；生命周期改为 quarantined（第 6 章）；立即告警 1 条，写明原因、最后 3 次错误原文和建议动作。所有在岗机器人都被隔离时按 P0（全体停摆）。
6. 恢复只由主人在详情页点「恢复」，回到试岗 L1（第 6 章）；恢复后积压合并成 1 次补课。

#### 适配层【一期】

所有对 DSH 的调用只经过一个模块（host-adapter）。其他模块里不得出现 `ctx.` 调用（apply 入口除外）。适配层的每个函数自带 try/catch 和 AbortSignal 超时（默认 30 秒），把 DSH 的错误码映射成第 14 章的报错类别，并把异常计入调用方组件的熔断计数。

启动时用 `ctx.inject` / `ctx.get` 探测下表的服务与事件，结果（服务名、方法名、事件名的集合）哈希成 api_fingerprint 存进 settings。缺必需项 → maintenance 并告警；缺可降级项 → 降级运行，告警 1 次。

| 依赖 | 用途 | 缺失或探测失败时 |
|---|---|---|
| storageDomain | 全部表 | 必需：业务全部不启动，只写心跳（hub_mode = maintenance），告警 |
| ctx.interval / ctx.timeout | 意图时钟、心跳 | 必需：中心无法运行，心跳写不出，由看门狗报出 |
| sessionController（create、rename、prompt、cancel、projections、list、resolveAgent） | 机器人会话生命周期、计量 | 必需 → maintenance |
| session/event | 交账、计量、死人开关 | 必需 → maintenance |
| agent/pre-step | 放行闸、暂停 | 必需 → maintenance（没有闸就不放行：中心失效时机器人宁可全停） |
| tools/pre-execute | 动作闸（第 9 章） | 必需 → maintenance |
| permissionPresets，且无人值守权限档存在 | 防止回合挂在审批上 | 必需 → maintenance |
| agent.ctx 上的 tools.register、tools.restrict | 机器人工具与收窄 | 必需 → maintenance |
| agent/request-error | 报错分类，抢在 llm-retry 之前拦中文额度报错 | 可降级：改为事后从 agent/error 与 turn/end 分类；QUOTA 可能先被 DSH 重试 5 次 |
| agent/turn-stopping | 回合守卫收口 | 可降级：回合守卫改用计时器 + steer / cancel |
| ctx.fs.watch | file 类感知 | 可降级：改为每 5 分钟快照哈希 |
| connection.fetch.register | 界面数据接口 | 可降级：界面不可用，机器人照常，飞书日报照发 |
| workspaceRegistry.archiveSession | 会话轮换、清理自检会话 | 可降级：轮换推迟 |
| ctx.goals、ctx.llm | 二期功能 | 二期功能关闭 |

1. package.json 顶层写 `engines.dsh`（不是 `dsh.engines.dsh`，宿主只读顶层），值为已验证版本加次版本上界，初始 `>=0.2.1-rc.5 <0.3.0`。不精确锁死单一版本：精确锁死会让每次强制更新都把中心静默跳过，而范围内的新版本由冒烟测试兜底。预发布版本的范围匹配语义【待验证 V23】。
2. 宿主 Config 只放启动必需项，所有字段声明 `.volatile()`（普通字段一改，插件加载器会整行重新挂载中心）。业务参数一律放 settings 表，在中心设置页修改；插件页的 plugins.bundle.config slot 只放一个「打开中心设置」入口。
3. 不在 profile 依赖里装任何 `@deepseek-ai/dsh-*` 的 npm 副本，运行时不 import 它们（会遮蔽内置实例，导致所有工具调用报错）。类型只在编译期引用；storageDomain 的表结构手写。
4. 界面只用官方 slot：sidebar.panellist + main（总览）、sidebar.right.pane.tab（机器人详情）、plugins.bundle.config。注册前用 `ctx.slots.spec` 探测，不存在就不注册，并在心跳里写 ui_available = false。不做 DOM 注入，不引用 Harness 客户端组件包，只用 `--dsw-alias-*` 主题 token。
5. 不监听 system-prompt/assemble；不追加自定义会话事件类型（会话将无法再打开）；不用 `ctx.agents.create` 持有机器人会话（插件重载会把机器人当轮取消）；不用 `session.selectModel`（会改掉全局默认模型）。
6. 中心页的数据接口只用 `ctx.connection.fetch.register`（只放行已认证的 owner，校验 Host / Origin），不用无鉴权的 webServer 路由。

#### 组件熔断【一期】

1. 组件按第 4 章划分：名册、工厂、感知总线（每个来源单独计）、评估器、意图时钟、调度器、唤醒器、回合守卫、交账处理、动作闸、沟通（飞书出站单独计）、规矩与记忆、额度、健康、反思、界面接口。
2. 某个组件 10 分钟内抛错 5 次 → 自停：撤下它的定时器和监听，其他组件照常运行；告警 1 次。
3. 关键组件（调度器、唤醒器、回合守卫、交账处理、动作闸、额度）自停 → 中心转 maintenance，宁可全停，也不在没有闸门时放行；按 P0（全体停摆）告警。
4. 自停 30 分钟后自动试恢复 1 次；试恢复后 10 分钟内再抛错 → 保持停止，直到主人在设置页点「恢复组件」或 DSH 重启。
5. 飞书出站自停时，P0 告警写进心跳的 p0_pending，由看门狗代发；其他告警进应用内收件箱。
6. 健康组件自停 → 心跳停写，由看门狗报出。

#### 冒烟测试与维护模式【一期】

1. maintenance 即只感知、不思考：感知、记账、界面、收件箱照常；调度器不放行任何机器人回合；界面顶部横幅写原因；主人亲手发消息不拦。模式持久化，重启后保持。
2. 进入条件：DSH 版本或中心版本与 settings 里已验证的不同；api_fingerprint 变了（拿不到版本号时靠它发现升级）；必需依赖缺失；关键组件熔断；PRESET_LOST 同时影响 ≥ 2 个机器人；retryPolicy 为 always；主人点「重新自检」；从备份恢复。
3. 冒烟测试，全程不超过 5 分钟；红灯期间推迟到 red_until 之后：
   1. 服务探测：必需项齐全，无人值守权限档存在。
   2. 存储往返：写、读、删一条测试记录。
   3. 建测试会话：sessionController.create（cwd = `<根目录>/.hub-smoke/`，该目录写进根目录的 .gitignore；preset = 盯守型角色模板）→ rename「中心自检 HH:MM」→ permissionPresets.set（无人值守档）。
   4. 拦截：不给测试会话发放行许可 → prompt（requestId 用新 ULID，mode queue）→ 应被第 7 章的 pre-step 闸拦下：30 秒内回合以 blocked 结束、且没有模型请求【待验证 V11】。
   5. prompt：给测试会话发一次性许可 → 再 prompt 一次 → 60 秒内看到第一次模型请求开始。
   6. 读 projections：tokenUsage、sessionStats、inbox 字段都在。
   7. cancel：sessionController.cancel → 30 秒内回合以 cancelled 结束。
   8. 收尾：归档测试会话（archiveSession，stopActivity）。这次用量记 initiator = hub。
4. 全部通过 → 写 settings 的 verified，回 normal，日报写「DSH 已升级到 X，自检通过」。任一步失败 → 保持 maintenance，按 P0 告警，写明失败的步骤和错误原文，例如「DSH 升级到 0.2.2 后中心自检第 6 步失败：projections 里没有 tokenUsage。机器人已全部暂停思考，感知照常。」主人把这条转给 Claude 修。
5. 维护期间每 6 小时自动重跑 1 次；主人可随时点「重新自检」。

#### 崩溃安全【一期】

1. 所有回调套统一兜底：定时器（ctx.interval、ctx.timeout 不替回调包 try/catch，抛错必然致命）、事件监听（emit 同步调用监听器、不捕获；async 监听返回的 rejection 没人接，一定致命）、子进程的 data / error / exit、fs.watch 回调、HTTP 处理、SSE、存储写入。做法：guard(组件名, fn) 包一层，同步异常就地 catch，返回的 Promise 挂 .catch，错误计入该组件的熔断计数。
2. 禁止的写法：`void someAsync()`；不带 catch 的 Promise；直接 setInterval / setTimeout；把 async 函数直接当事件监听；对文件内容裸调 JSON.parse。
3. 不注册进程级 uncaughtException / unhandledRejection 监听，那会改变宿主对所有插件的失败处理。
4. apply 分步初始化，每步失败只让对应组件不启动；apply 本身不抛出。
5. 一个机器人出错只影响它自己：每个机器人的处理在独立的 try 范围里，异常写进它的唤醒单。
6. 宿主一旦崩溃，DSH 弹原生错误框（退出 / 重启 / 禁用第三方插件并重启），不会自动重启。第三个选项会把组合包重置为默认、把 profile 的 cordis.patch.yml 改名备份，中心和无人值守权限档一起被摘掉。对策：
   - 看门狗的告警文案写明「请点『重启』，不要点『禁用第三方插件并重启』」；
   - 中心数据不写在 profile patch 里，重新加回中心后不丢；
   - 加回后启动探测发现无人值守权限档不在 → maintenance 并告警「需要恢复无人值守权限档」（配置见第 5.5 节），不会在 ask 档下放行机器人。

#### 看门狗【一期只告警；二期自动重启】

1. 安装要主人同意（往系统里加一个登录后自动运行的任务）。中心设置页「安装看门狗」先列出要写入的 3 个文件和作用、检查频率、告警渠道；主人确认后中心写入文件。宿主能起子进程【待验证 V2】时由中心执行 launchctl 加载，否则界面给一条只含脚本路径的命令让主人运行。卸载同理。没装时总览页常驻提示「看门狗未安装：DSH 退出或崩溃时没人会告诉你」。
2. 每 120 秒运行一次，读心跳文件并检查两个进程：DSH 主进程、DSH 宿主子进程。进程识别方法【待验证 V21】。按下表顺序判定，命中即止：

| 序号 | 条件 | 判定 | 一期动作 | 二期追加 |
|---|---|---|---|---|
| 1 | 看门狗自己的上次运行距今超过 6 分钟 | 系统刚醒，本轮只记录 | 不告警 | — |
| 2 | 心跳 ≤ 5 分钟、state = running、last_tick ≤ 10 分钟 | 健康 | 有未关闭的告警则发「已恢复（停了 X 分钟）」 | — |
| 3 | 心跳 ≤ 5 分钟、state = running、last_tick > 10 分钟 | 中心调度停转 | P0 | — |
| 4 | state = stopped，DSH 主进程在 | 中心插件已停用，DSH 还在跑 | P0：「可能被手动停用、升级后版本不兼容被跳过，或崩溃后选了『禁用第三方插件』」 | — |
| 5 | 心跳 > 5 分钟、state 不是 stopped，主进程和宿主子进程都在 | profile patch 的备份文件比最后一次心跳新 → 中心被「禁用第三方插件并重启」摘掉；否则 → 中心卡死 | P0 | 卡死连续 2 次判定 → 重启 DSH |
| 6 | 心跳 > 5 分钟，主进程在、宿主子进程不在 | DSH 崩溃，停在错误弹窗上 | P0：「请点『重启』，不要点『禁用第三方插件并重启』，那会把中心摘掉」 | 结束 DSH 并重开 |
| 7 | 主进程不在，state = stopped | DSH 已正常退出 | P1 单推，免打扰时段顺延到 08:00 | — |
| 8 | 主进程不在，state 不是 stopped | DSH 意外退出 | P0 | 重开 DSH |
| 9 | 其他（如 state = starting 且心跳新鲜） | 无法判定 | 只记录 | — |

第 4、6 种在正常退出和 App 刚启动时会有几秒的过渡状态，所以判定成立后等 20 秒复查一次，仍成立才报。

3. 告警渠道：调用和中心飞书出站相同的 lark-cli 命令，凭据由 lark-cli 自己保管，看门狗文件里不放密钥【待验证 V13】；发不出时用 osascript 弹本机通知。
4. 去重：同一判定只报 1 次；一直没恢复的，次日 08:30 再提醒 1 次；恢复健康时发 1 条「已恢复」。P0 在免打扰时段照发。
5. 代发 P0：心跳的 p0_pending 里有超过 5 分钟的条目 → 看门狗代发，写进 ack.json；中心读到 ack 后把这些告警标为已送达。
6. 二期自动重启：只针对上表第 5（卡死）、6、8 种情况。做法：结束 DSH 进程（先 TERM，15 秒后 KILL）→ `open -a` 重新打开。每小时 ≤ 3 次，超出就停止自动重启并告警「已自动重启 3 次仍失败」。前提是 V21 实测确认重开不丢数据。「正常退出」和「中心插件已停用」从不自动处理。

#### 每日备份【一期】

1. 每天第一次晚于 04:00 的 tick 做备份；距上次成功备份超过 24 小时（例如夜里电脑在睡），启动静默期结束后立即补做。
2. 范围是名册和心智数据：bots、aspirations、goals、agenda、watches、drives、rules、settings、inbox、approvals、outbox、queue、wakes（近 30 天）、quota_state、downtime。不含 percepts（14 天自然过期）、budget_ledger 明细和 audit（体量大，各有保留期）。家目录里的记忆文件由根目录的 git 留版本（第 11 章），不在这里备份。
3. 写完逐表重读校验：记录数与存储一致、每行能解析、sha256 写进 manifest。任一不符记失败；连续 2 次失败告警。
4. 保留最近 14 份，更早的删除；只删中心自己的备份目录。
5. 恢复：设置页「从备份恢复」→ 选日期 → 二次确认（会覆盖当前的名册和心智数据）→ 中心转 maintenance → 先把当前数据再备份一份 → 逐表写入 → 走一遍启动对账 → 冒烟测试通过后回 normal。只有主人能发起，机器人的工具里没有这个能力。

#### 常开环境与在线率【一期】

1. 中心设置页有一张常开环境清单。每项都由主人在系统里操作，中心只检测和提示，从不自己改系统设置：
   - 接电源（笔记本）；
   - 不合盖，或改用常开的 Mac mini（三期方案）；
   - 接电源时防止自动睡眠（系统设置 → 电池 → 选项），或用 caffeinate；
   - DSH 加入登录项（系统设置 → 通用 → 登录项）；
   - 看门狗已安装（可选）；
   - 机器人路由的 retryPolicy 为 normal（第 14 章）；
   - 无人值守权限档已配置（第 5.5 节）。
2. 能自动检测的项（电源和睡眠设置靠 pmset，依赖宿主能起子进程【待验证 V2】）显示检测结果；检测不了的由主人勾选，记下勾选时间。
3. 在线率 = 近 7 天中心在线分钟数 / (7 × 24 × 60)。downtime 记录之外的时间都算在线（不足 10 分钟的空档不建记录，算在线）。每小时更新，显示在总览页和日报。
4. 近 7 天在线率低于 80% → 日报写「机器人有 X% 的时间不在线（休眠 a 小时、退出 b 小时、崩溃 c 次）」，并列出清单里没完成的项。

#### 退出 App 时的提示【一期】【待验证 V22】

1. DSH 退出前只检查活 agent、后台任务和官方 schedule；中心自建的队列不在检查范围，主人退出时不会被提醒。
2. 中心仿照 dsh-schedule，往 workspace/session-activity 贡献条目：有机器人在思考或排队时，退出确认框显示「还有 N 个机器人在排队或思考。退出后它们会停下，感知也会停止，直到你再次打开 DSH。」所有机器人都只是在盯着时不贡献条目，免得每次退出都弹框；这种情况由看门狗在退出后发「DSH 已退出」。
3. 正常退出时 dispose 写心跳 state = stopped；被打断的回合在下次启动时按「唤醒单幂等」处理。

#### 告警一览【一期】

第 14、15 章产生的告警写进 alerts，优先级与去向按第 10 章：P0 立即单推，不占打扰预算，免打扰时段照发；P1 要主人动手，进收件箱并推 1 次；P2 只进总览与日报。同一原因 1 小时内合并为一条。

| 代码 | 级别 | 触发 | 什么时候报 |
|---|---|---|---|
| quota_exhausted | P0 | 任意会话出现 QUOTA | 立即，每窗口 1 次 |
| auth_failed | P0 | AUTH | 立即 |
| provider_outage | P0 | 全局故障 | 立即；解除时进日报 |
| hub_maintenance | P0 | 进入 maintenance：冒烟失败、必需依赖缺失、关键组件熔断、retryPolicy 为 always、PRESET_LOST 影响 ≥ 2 个机器人 | 立即 |
| scheduler_stalled | P0 | 心跳在写、tick 停转 | 立即 |
| all_quarantined | P0 | 所有在岗机器人都被隔离 | 立即 |
| bot_quarantined | P1 | 单个机器人被隔离 | 立即 |
| component_tripped | P2 | 非关键组件熔断 | 立即 |
| stuck_on_approval | P1 | 回合卡在审批上 | 立即 |
| turn_stuck | P2 | 其他原因卡住 | 同一原因第 2 次 |
| missed_wake | P2 | 漏醒 | 同一机器人连续第 2 次 |
| turn_error | P2 | 单个机器人的 RATE_LIMIT、TRANSIENT、CONTEXT | 连续第 2 次 |
| writer_held | P1 | 会话被别的进程占用，重试 3 次仍失败 | 第 3 次失败时 |
| source_blind | P1 | 来源失明，重启 3 次仍失败 | 第 3 次重启失败时 |
| long_silence | P2 | 3 × pace_max 内没有成功交账 | 立即 |
| backup_failed | P2 | 备份失败 | 连续第 2 次 |
| downtime_long | P2 | 停机 ≥ 12 小时 | 恢复对账后，只进总览与日报 |

看门狗自己发出的告警见看门狗判定表，不经过 alerts。

### 15.4 流程

#### 启动与恢复

1. apply：写心跳 state = starting；读上一份心跳（boot_id、written_at、state、pid）。
2. 服务探测，算 api_fingerprint；必需项缺失 → maintenance。
3. 打开存储并自校验。
4. 比对 DSH 版本、中心版本、api_fingerprint 与 settings 的 verified；不一致 → maintenance，立即开始冒烟测试（与下面的对账并行，maintenance 本来就不放行思考）。心跳写 running。
5. 停机判定，必要时写 downtime。
6. 静默 3 分钟对账：唤醒单阶段；正在运行的机器人回合（agents 状态为 running；插件重载时会话归会话控制器所有，不会被取消）重新挂上回合守卫，按唤醒单的 started_at 计时；出站动作；游标补拉；议程过期标记。
7. 静默结束：normal 模式下生成补课，每 90 秒放行 1 个，之后进入常规 tick；maintenance 模式下等冒烟测试通过再放行。
8. 运行中 tick 发现间隔超过 10 分钟：从第 5 步开始走，不重新探测。

#### 升级后的一次自检

DSH 强制更新 → App 重开 → 中心 apply → 第 4 步发现版本变化 → maintenance，横幅「DSH 已升级，自检中」→ 冒烟 8 步 → 通过：回 normal，日报一行 → 失败：保持 maintenance，P0 写明失败步骤，每 6 小时重跑，主人可点「重新自检」。

### 15.5 实现

- 定时器：`ctx.interval`（tick 60 秒、心跳 30 秒），回调全部经 guard；每次用 Date.now() 核对真实时间。
- 文件：心跳、备份、看门狗文件用 Node fs 原子写（同目录临时文件 + rename），目录 `~/.dsh/agent-hub/`。先例：控制桥插件每 5 秒写一次 bridge-status.json。
- 会话：`ctx.sessionController` 的 create / rename / prompt / cancel / projections / list / resolveAgent；`ctx.agents.list / get` 读运行状态（idle 或 running）；`ctx.permissionPresets.set(session, name)`；`ctx.workspaceRegistry.archiveSession(id, {stopActivity: true})`。
- 事件：`session/event`（turn/end 及其 reason、approval/asked、approval/decided、提问事件、compaction/summary）、`agent/error`、`agent/status`、`agent/pre-step`（拦截）、`agent/turn-stopping`。
- 冷读：`ctx.sessionQuery.filterEvents` 补读漏掉的会话事件。
- 宿主重启后，没跑完的回合由 agent-loop 追加合成收尾（turn/end 为 interrupted），没完成的工具调用标 TOOL_OUTCOME_UNKNOWN，DSH 不自动重试；中心靠唤醒单对账接手。
- 探测：`ctx.inject` / `ctx.get`；界面侧 `ctx.slots.spec`、`ctx.slots.register`。
- 界面接口：`ctx.connection.fetch.register`。
- 退出提示：往 `workspace/session-activity` 贡献条目【待验证 V22】。
- 版本：package.json 顶层 `engines.dsh`；插件管理器在安装前就会拒绝不兼容的版本（incompatible-version）；compatibility.json 豁免只对「插件精确版本 × DSH 精确版本」有效，平时不用。
- 看门狗：launchd LaunchAgent（StartInterval 120、RunAtLoad）；pgrep 识别进程【待验证 V21】；plutil 读 JSON；lark-cli 发飞书【待验证 V13】；osascript 弹本机通知；二期用 `open -a` 重开。
- 子进程（launchctl、pmset）【待验证 V2】。
- 宿主崩溃链路（用于理解看门狗判定）：宿主子进程非零退出 → Electron 弹原生错误框，按钮为退出 / 重启 / 禁用第三方插件并重启，没有超时、不会自动选择；宿主装了 installFailLoud，任何 uncaughtException 或 unhandledRejection 都会让宿主 exit(1)。

### 15.6 验收

#### 心跳与死人开关

1. 心跳文件每 30 ± 2 秒更新一次，始终是合法 JSON：心跳写入期间并发读 1,000 次，没有一次读到不完整的文件。正常停用中心后 state = stopped。
2. 停掉意图时钟的定时器、心跳照写：6 分钟内出现 scheduler_stalled（P0），定时器被重建。
3. 把某机器人的下次思考设为 40 分钟前、队列里没有它的条目：下一次 tick 记漏醒并补入队列，不告警；连续第 2 次漏醒才告警。
4. 同样设置，但它的条目在等并发名额：不记漏醒，「为什么没醒」显示「并发已满」。
5. 构造回合 10 分钟没有事件：回合被取消，唤醒单记 cancelled（stuck），约 2 分钟后重排。构造回合挂在 approval/asked 上：立即告警且文案点名审批，该会话被重设为无人值守权限档。
6. http 来源连续失败超过 2 倍轮询间隔：被重启；3 次重启仍失败时告警，该机器人下次的唤醒包里写明「来源失明」。

#### 停机与补课

7. 合盖 4.5 小时后打开（或在测试里让两次 tick 相隔 4.5 小时）：写 downtime，cause = sleep；之后 3 分钟内没有任何思考被放行；之后每 90 秒最多放行 1 个补课，每个机器人至多 1 个；唤醒包写明停机区间。
8. 停机期间到点的出站动作没有被执行，而是变成审批单；执行中、状态未知的出站动作没有被重发。
9. 停机 13 小时：恢复对账后出现 1 条 P2 告警 downtime_long（不单推）；停机 2 小时：不建告警，只进日报。日报的停机记录列出起止、时长、原因、补课数、跳过数、转给主人的事项。
10. 重启时阶段为 started 的唤醒单被标 interrupted，只补发 1 次恢复唤醒；阶段为 granted、会话里已有该 wake_id 消息的唤醒单不重投。

#### 重排与隔离

11. 单个机器人连续 TRANSIENT：重排时间点约为 2、10、30、120 分钟（各 ±20%）；第 4 次重排仍失败 → quarantined，告警含最后 3 次报错原文。
12. 两个机器人 30 分钟内都出现 TRANSIENT：判全局故障，发 1 条 P0，各自的重排次数不增加；之后任一回合成功即解除。
13. 被隔离的机器人感知照常记录、不再放行；主人点「恢复」后回到试岗 L1，积压合并为 1 次补课。

#### 适配层、熔断与崩溃安全

14. 源码检查全部通过：host-adapter 以外没有 `ctx.` 调用；package.json 顶层有 engines.dsh；没有运行时 import `@deepseek-ai/*`；Config 字段全部 `.volatile()`；没有 `void` 加函数调用、裸 setInterval / setTimeout、把 async 函数直接当事件监听；不监听 system-prompt/assemble；界面没有 DOM 注入。
15. 模拟缺少 agent/pre-step：中心进入 maintenance，不放行任何思考。模拟缺少 ctx.fs.watch：file 类感知改为 5 分钟快照，其他照常。
16. 让某个感知来源 10 分钟内抛错 5 次：只有它停下并告警，其他来源和机器人正常；30 分钟后自动试恢复 1 次。
17. 让动作闸熔断：中心转 maintenance 并发 P0。
18. 故障注入：在定时器、同步事件监听、async 事件监听、子进程事件、fs.watch、HTTP 处理、存储写入这几类回调里，分别抛同步异常和 rejected Promise：DSH 宿主进程不退出（pid 不变），对应组件的熔断计数加 1。

#### 冒烟测试

19. 把 settings 里 verified 的 DSH 版本改成旧值后重启：中心进入 maintenance，自动跑 8 步冒烟，全部通过后回 normal，日报有一行；测试会话已归档。
20. 让第 6 步失败（模拟 projections 里没有 tokenUsage）：保持 maintenance，P0 告警写明「第 6 步」和错误原文；6 小时后自动重跑。
21. 红灯期间版本变化：冒烟推迟到 red_until 之后。

#### 看门狗、备份与环境

22. 未经主人在设置页确认，`~/Library/LaunchAgents/` 里不会出现看门狗的 plist。
23. 看门狗判定表第 3–8 种情况各模拟一次：每种在心跳陈旧阈值之后的 2 个检查周期内发出对应文案的告警，同一状态只报 1 次；第 1 种（刚醒）不告警；恢复后发「已恢复」。
24. 关掉中心的飞书出站后制造一个 P0：看门狗在 5 分钟后代发，中心随后把它标为已送达。
25. 每天 04:00 之后生成 1 份备份，manifest 的记录数与存储一致；出现第 15 份时最早的一份被删；从备份恢复后，名册和心智数据与备份一致，冒烟通过后回到 normal。
26. 7 天里制造 2 小时停机：在线率显示 98.8%；在线率低于 80% 时，日报出现提醒和清单里没完成的项。
27. 【待验证 V22】有机器人在思考时按 Cmd+Q：退出确认框列出机器人数；只有在盯着的机器人时直接退出，看门狗随后发「DSH 已退出」。

### 15.7 新增建议

1. 名词表加「中心运行模式 hub_mode：normal / maintenance」，maintenance 即只感知、不思考。理由：升级自检、必需依赖缺失、关键组件熔断都靠它全停思考，骨架名词表里还没有这个词。
2. 加「全局故障」：30 分钟内 ≥ 2 个机器人出现 RATE_LIMIT 或 TRANSIENT 时整体退避，不计入各自的重排次数。理由：否则一次供应商故障会把所有机器人逐个隔离，主人回来要一个个恢复。
3. 心跳文件增加 last_tick_at_ms、p0_pending、ui_available。理由：能发现「心跳在、调度停了」；中心飞书出站坏了时，P0 仍能经看门狗送到。
4. 组件熔断后 30 分钟自动试恢复 1 次。理由：偶发故障不该永久停一个组件。
5. 骨架第 6 节补充参数：停机 ≥ 12 小时建 P2 告警；在线率警戒 80%；备份 04:00、保留 14 份；来源失明为超过 2 倍间隔、重启 3 次仍失败才告警；长期沉默为 3 × pace_max；维护期每 6 小时重跑冒烟；看门狗「刚醒」判定为上次运行距今超过 6 分钟，未恢复的告警次日 08:30 再提醒 1 次，「插件已停用」「崩溃弹窗」两种判定复查 20 秒；调度停转判定为中心自查 5 分钟、看门狗 10 分钟；卡住的回合取消后 2 分钟仍在运行即隔离。
6. engines.dsh 用版本范围而不是精确锁定。理由：DSH 走 nightly 通道且有强制更新，精确锁定等于每次升级都把中心静默跳过；用范围加冒烟测试，坏了也会大声报出来。
7. 备份放在 `~/.dsh/agent-hub/backups/`。理由：机器人在 workspace-write 下写不到，也不进根目录的 git 历史。
8. 看门狗区分「正常退出」（P1，免打扰顺延）和「意外退出、崩溃」（P0）。理由：主人主动退出时不该在深夜收到 P0。
9. 隔离触发补充 PRESET_LOST、SESSION_LOST、WRITER_HELD 三次失败（同第 14 章新增建议 6）。
