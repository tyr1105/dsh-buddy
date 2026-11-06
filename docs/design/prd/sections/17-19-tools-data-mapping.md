## 17. 机器人工具清单

### 17.1 职责

机器人从中心拿到的能力只有本章列出的 hub_* 工具：读自己的状态、交账、改自己的议程和注意力、提议、提交对外动作、写记忆、复盘。本章给出每个工具的参数、返回、校验与行为出处，规定注册方式，并列出机器人不得拥有的工具与屏蔽办法。各章对同一工具写法不一致的地方，以本章合并后的写法为准，取舍处标【统一口径】。

### 17.2 工具一览

| 工具 | 用途 | 动作类别（第 9 章） | 行为定义 | 分期 |
|---|---|---|---|---|
| hub_state_get | 读自己的状态；按编号取一条感知原文 | A（只读） | 本章 17.5 | 一期；peers、mailbox、claims、beliefs 二期 |
| hub_commit | 交账 | 中心协议，不分类 | 7.7 | 一期 |
| hub_agenda_upsert | 建或改自己的议程项 | A | 7.4 | 一期 |
| hub_agenda_close | 关闭自己的议程项 | A | 7.4 | 一期 |
| hub_watch_update | 自改关注项；在获批范围内新建 | B | 7.1 R12 | 一期 |
| hub_watch_propose | 提议需主人批准的关注项变更 | D（扩权，走提议） | 7.1 R13、9.4 | 一期 |
| hub_goal_upsert | 建、改、停、放弃目标；志向只能提议 | B 或提议 | 8.3.3、8.6 | 一期 |
| hub_outbox_submit | 提交对外动作，由中心执行；申请工具调用的批准票 | C / D | 9.6–9.8 | 一期 |
| hub_lesson_propose | 写长期记忆，或建议主人立规矩 | B | 11.3、11.11 | 一期 |
| hub_reflect_commit | 复盘回合的交账 | 中心协议，不分类 | 7.9 | 一期 |
| hub_belief_set | 写信念板 | B | 本章 17.15 | 二期 |
| hub_handoff | 交接单 | 按派生动作判 | 12.3、12.5 | 二期 |
| hub_send | 同伴消息 | A | 12.3、12.5 | 二期 |

### 17.3 注册方式【一期】

**规则**

1. hub_* 工具只注册在机器人根会话的 agent.ctx 上（`agent.ctx.tools.register`），不注册在中心插件根 ctx 上：根上注册会进入主人的全部普通会话（可行性报告第九节）。工具定义手写同形对象，不 import `@deepseek-ai/*` 运行时包（evidence 05 L7）。
2. 注册时机是每一次 `agent/created`：会话按名册的三个索引（5.1.3 第 3 条）或工厂内存待建表（6.2.3 F7）识别为机器人后，依次挂 `tools.restrict` → `tools.guard` → `tools/pre-execute`（prepend）→ `approval/request`（prepend）→ 本期全部 hub_* → `systemPrompt.section`（agent-hub:identity）→ `agent/request`（模型路由）。【统一口径】顺序合并 6.2.3 F11 与 9.10.1：屏蔽先于注册，免得工具清单出现空窗。
3. 中心启动时对 `ctx.agents.list()` 里已经在线的机器人 agent 补挂一遍（中心的监听可能晚于 agent 创建，5.5.2）。
4. 每个注册返回的 disposer 同时挂到中心插件自己的 effect 和该 agent.ctx 的 effect；中心重载或会话释放时自动撤下，不留孤儿钩子。
5. 挂完立即读回核对：该 agent 的工具清单包含本期全部 hub_*，且不含 17.16 的任何工具。全部通过才把内存里的 gate_ready[bot_id] 置真；不通过就撤下已挂的全部钩子，该机器人不放行（9.10.1），按第 15 章告警。工厂试跑预检 P4、会话轮换、启动对账、冒烟测试都跑同一个核对函数。
6. 子代理（委派深度 > 0、父链属于机器人）不注册任何 hub_*，只按 5.5.2 执行屏蔽【待验证 V25】；子代理对 hub_* 的调用由动作闸按会话血缘拒绝。
7. 所有自主等级注册同一组工具；处理函数每次调用时读名册当前的等级和当前唤醒单的变体再判定（8.6 第 2 条的做法推广到全部工具），主人改等级不需要重新注册。二期工具在对应功能开启前不注册。
8. 主人的普通会话、工厂备选起草会话（`.factory/`）、冒烟测试会话（`.hub-smoke/`）都不注册 hub_*。

**实现**：`ctx.on('agent/created')`、`agent.ctx.tools.register / restrict / guard`、`tools/pre-execute` 与 `approval/request` 的 agent 作用域 prepend 注册、`agent.ctx.systemPrompt.section`、`agent/request`、`ctx.agents.list()`，全部经适配层（evidence 06 C5、07 C5、01 可调用接口）【待验证 V5、V10、V34】。

### 17.4 通用约定【一期】

#### 17.4.1 调用方、返回与时间

1. 调用方身份：工具执行上下文里的 agent → session_id → 名册 bot_id。参数里没有 bot_id、from 一类字段（12.3 第 41 条、12.5.1）；一个机器人只能读写自己的记录。
2. 当前唤醒单：该会话上 phase = started 的唤醒单（含原生回合登记的 native 单）。hub_commit 的 wake_id 参数只作交叉核对（7.7 实现）。
3. 返回统一结构：`{ok, result?, errors?: [{code, field?, message, fix?}], notes?: [string]}`。message 和 notes 先写结果，再写编号、期限、下一步该做什么，合计 ≤ 300 字（9.10 第 10 条）。校验失败以工具结果返回，处理函数不抛异常（宿主里未接住的异常会让 DSH 退出，evidence 06 L2）。
4. 时间参数一律 ISO 8601 带偏移；不带偏移按 Asia/Shanghai（+08:00）解释；回执里回显换算结果，格式「11-05 08:00」（7.4 R1、7.6 R2）。存储一律毫秒（18.2 第 5 条）。
5. 长度按字计（汉字、字母各计 1）；字节上限按 UTF-8 计。

#### 17.4.2 错误码

| code | 含义 | 典型情形 |
|---|---|---|
| invalid_param | 字段缺失、类型、枚举或长度不合格 | next_think 缺 reason；options 4 个 |
| not_found | 编号不存在，或不属于调用方 | 引用别的机器人的议程项（不区分两者，不泄露存在与否） |
| not_allowed_level | 当前自主等级不允许；改写成提议 | L0 调 hub_watch_update |
| not_allowed_variant | 本回合变体不允许（17.4.3） | 复盘回合调 hub_agenda_upsert |
| emergency_stop | 全局急停中 | 急停时调 hub_outbox_submit |
| already_committed | 本单已交账，只能读 | 交账后再改关注项 |
| limit | 数量上限 | 第 21 条关注项；第 4 张待处理审批单 |
| rate_limited | 本单或当天调用次数超限（17.4.5） | 一个回合第 16 次 hub_state_get |
| cooldown | 同类被拒后的冷却期内；返回到期时刻 | 同一内容 30 天内再次申请 |
| duplicate | 与已有记录重复；返回原编号 | 同一 bot_ref 的出站动作已完成 |
| out_of_scope | 路径、域名、目标不在允许范围 | 出站目标不在白名单 |
| forbidden_content | 命中禁写项过滤器；只写类别，不回显内容 | 记忆里含邮箱 |
| trio_blocked | 风险三要素组合检查不通过（第 13 章） | 新增 http 关注项会让实际占用三项 |
| stale | 引用的对象已被改过 | 撤销已被后续修改覆盖 |
| internal | 中心出错，本次没有生效 | 存储写失败 |

章内专用码照原章保留：GOAL_OPEN_ENDED 等（8.2.2）、peer.* 与 claim.*（12.5.1）。

#### 17.4.3 按回合变体的可用范围

| 工具 | 常规、补课、现在想一次 | 轻复查 | 复盘 | 试跑 | 原生回合 | 交账后锁定 | 过期单 | 急停（主人亲手那一步） |
|---|---|---|---|---|---|---|---|---|
| hub_state_get | 可 | 可 | 可 | 可 | 可 | 可 | 可 | 可 |
| hub_commit | 必须 | 必须 | 拒，用 hub_reflect_commit | 必须 | 有副作用才补交 | 拒 | 必须 | 可 |
| hub_agenda_upsert | 可 | 可 | 拒 | 只校验 | 可 | 拒 | 可 | 拒 |
| hub_agenda_close | 可 | 拒 | 拒 | 只校验 | 可 | 拒 | 可 | 拒 |
| hub_watch_update | 可 | 可 | 拒 | 只校验 | 可 | 拒 | 可 | 拒 |
| hub_watch_propose | 可 | 可 | 拒 | 只校验 | 可 | 拒 | 可 | 拒 |
| hub_goal_upsert | 可 | 拒 | 拒 | 只校验 | 可 | 拒 | 可 | 拒 |
| hub_outbox_submit | 可 | 拒 | 拒 | 只校验（trial_dry） | 可 | 拒 | 拒 | 拒 |
| hub_lesson_propose | 可 | 拒 | 拒，用 hub_reflect_commit.lessons | 只校验 | 可 | 拒 | 可 | 拒 |
| hub_reflect_commit | 拒 | 拒 | 必须 | 拒 | 拒 | 拒 | 必须（复盘过期单） | 拒 |

出处：轻复查 7.8 R1；复盘 7.9 R1；试跑 6.2.4、7.8 R3；原生回合 7.8 R5；交账后锁定 7.6 R12；过期单 7.6 R16 e；急停 13.4 第 82 条。【统一口径】试跑里所有改动类工具都只校验、不落库，返回 trial_dry（把 6.2.4 对 hub_outbox_submit 的做法推广到全部改动类工具）：草稿机器人在上岗前不该生成收件箱提议或议程。

#### 17.4.4 按自主等级的可用范围

| 工具 | L0 | L1（含试岗） | L2 | L3【二期】 |
|---|---|---|---|---|
| hub_state_get、hub_commit、hub_agenda_upsert、hub_agenda_close | 可 | 可 | 可 | 可 |
| hub_watch_update | 拒（not_allowed_level），改写进 watch_ops 的 propose 或用 hub_watch_propose | 可，做完告知 | 可 | 可 |
| hub_watch_propose | 可（生成提议） | 可 | 可 | 可 |
| hub_goal_upsert | 拒 | 只生成提议 | 在既有志向下自建、改自建的直接生效 | 同 L2 |
| hub_outbox_submit | 拒，写成提议 | 每次审批单 | 命中预批规则直接排队，否则审批单 | 逐类授权内直接排队 |
| hub_lesson_propose（target = memory） | 拒，写成提议 | 可 | 可 | 可 |
| hub_lesson_propose（target = rule_suggestion） | 可 | 可 | 可 | 可 |
| hub_reflect_commit 的 self_changes | 中心转成 proposals | 可 | 可 | 可 |

出处：9.3 处置矩阵（L0 的 B 类「不做；写成提议」）、8.3.3、9.7.2。【统一口径】7.1 R12 与 11.3 没写等级限制，按第 9 章矩阵补上：骨架把 L0 定为「只观察」。D 类在任何等级都要主人逐条点头（9.4），上表不改变这一点。

#### 17.4.5 每张唤醒单的调用上限

| 工具 | 每张唤醒单上限 | 超出时 |
|---|---|---|
| hub_state_get | 15 次 | rate_limited |
| hub_commit | 3 次提交（7.7 R1） | 第 3 次仍不合格按未交账 |
| hub_agenda_upsert + hub_agenda_close | 10 次，与交账 agenda_ops 合计 | rate_limited |
| hub_watch_update + hub_watch_propose | 5 次，与交账 watch_ops 合计 | rate_limited |
| hub_goal_upsert | 3 次 | rate_limited |
| hub_outbox_submit | 新提交 3 次（与 9.3 第 4 条「每回合新建审批单 ≤ 3」一致） | rate_limited |
| hub_lesson_propose | 5 次（11.2），每天 10 次 | rate_limited |
| hub_reflect_commit | 3 次提交 | 按未交账 |

原生回合按单计；一张 native 单覆盖主人一次连续对话。为什么：工具在一个回合里循环调用会刷满表和收件箱，上限之外的调用不产生任何记录。

#### 17.4.6 提议配额（各工具共用）

1. 机器人发起的全部提议共用一份配额：交账 new_items 的 propose、L1 的 hub_goal_upsert、hub_watch_propose、hub_reflect_commit 的 proposals、hub_lesson_propose 的 rule_suggestion。L1 每周 ≤ 3 条（骨架第 6 节），L2、L3 每周 ≤ 5 条（10.10 第 4 条），每个机器人同时待处理 ≤ 3 条（10.3）。
2. 提议门槛：价值 ≥ 0.6、把握 ≥ 0.5；不过门槛的改记点子池（17.6 校验第 7 条、18.23 kind = idea）。
3. 被拒同类 30 天不再提；过期撤回的同类 14 天不再提（10.3）；超额返回 limit，内容改记点子池。
4. 中心发起的提议（规矩确认卡、试岗去留、升级建议、自主等级降级建议）不占机器人配额（10.3、11.11）。
5. 「这周已用 x / 3 条」写进唤醒包的「允许的处置」一行。

#### 17.4.7 幂等与审计

1. 改动类工具在同一张唤醒单内按（工具名，规范化参数的 sha256）去重：重复调用直接返回第一次的结果，不重复生效。重放被打断的唤醒单时，A、B 类改动靠这一条加各工具按 id upsert 不重复（7.6 R16）。
2. 生效的改动写 audit：hub_watch_update、hub_lesson_propose（memory_write）、L2 自建或改目标、playbooks 与技能改动 → self_change；提议 → outreach；出站与审批 → action、decision。参数原文不进 audit，只存哈希与 ≤ 80 字摘要（13.3.3）。
3. 工具不调用模型、不开回合。返回内容会进入回合上下文，所以每次返回 ≤ 8 KB，超出截断并给 cursor。

### 17.5 hub_state_get【一期；二期加 scope】

**用途**：机器人读自己在中心里的状态，补唤醒包里放不下的细节；按编号取一条感知原文（带不可信围栏）；读上次被打断唤醒单的副作用清单。

**给模型的说明**：「读你自己在 Agent 中心里的状态：档案摘要、志向、目标、议程、关注项、你发起的收件箱事项和审批单、出站动作、今日预算；也可以按编号取一条感知的原文（外部内容在不可信围栏里）。只读，不花思考次数。唤醒包写『另有 N 条，用 hub_state_get 查看』时用它。」

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| scope | enum：overview / goals / agenda / watches / inbox / approvals / outbox / budget / percept / wake / side_effects；二期 peers / mailbox / claims / beliefs | 否 | 默认 overview |
| id | string | scope 为 percept、wake、mailbox 时必填 | 只能是调用方自己的记录 |
| filter | string | 否 | 按状态过滤，例如 agenda 的 open、inbox 的 pending |
| cursor | string | 否 | 翻页，每页 ≤ 20 条 |

**返回**（result，按 scope）

| scope | 内容 |
|---|---|
| overview | 名字、角色、生命周期与活动状态、有效自主等级、今日已用与上限（次数、token）、额度灯、下次思考（含夹紧说明）、志向各一句、active 目标（id、终态一句、本期截止、已命中的停止条件）、未完成议程数、关注项数与失明的项、我发起且待主人处理的事项数、rules_version、本周已用提议配额、上次被打断单的副作用摘要（有才列） |
| goals | 每个未结束目标的 8.2.2 字段摘要与最近 5 条 progress_log |
| agenda | 未结束议程项：id、kind、标题、触发、到期、优先级、状态、waiting_on、frozen、放弃条件 |
| watches | 全部关注项：id、名字、来源、过滤一句、期望、间隔、状态、健康、到期、谁建的、近 4 周精度 |
| inbox | 我发起的收件箱项：编号、类型、标题、状态、主人处理结果原文 |
| approvals | 我的审批单：编号、动作摘要、状态、批准票是否可用、到期（只读，9.6.2 第 4 条） |
| outbox | 我的出站动作：编号、类型、目标、状态、结果链接、撤销期限 |
| budget | 今日次数与 token、本窗口次数、额度灯、本次上限余量 |
| percept | 一条感知：summary、excerpt（external、peer 内容套不可信围栏，13.4 第 34–37 条）、trust、来源、payload_ref |
| wake | 我的一张唤醒单：变体、理由、结果、交账摘要、用量 |
| side_effects | 上次被打断唤醒单登记的副作用：dedupe_key、类型、目标、状态（7.6 R16 c） |
| peers、mailbox、claims【二期】 | 见 12.5.1；peers 只给名片和可用状态，不给对方的议程、记忆、感知 |
| beliefs【二期】 | 自己的信念：key、值、置信度、核实时间、保鲜期、期望 |

**校验**

1. 只能读自己的记录；别人的编号返回 not_found。
2. 返回 ≤ 8 KB，超出截断并给 cursor。
3. external、peer 内容一律套围栏，nonce 每次调用随机；摘录里伪造的闭合标记先换成全角（13.4 第 35 条）。
4. 不返回：audit、别的机器人的任何记录、主人消息正文、设置里的公司域名与禁写人名单。
5. 一期读取不改变任何记录的状态；二期读 mailbox 时把该条置为 read（12.2.4）。

**行为出处**：本章是唯一定义；5.2.2、6.2.4、7.6 R3 与 R16 c、9.6.2、12.5.1、13.4 第 37 条引用它。

### 17.6 hub_commit【一期】

**用途**：每个思考回合以它结束，报结果并交出议程、关注、找主人和下次思考的变更。

**给模型的说明**：「每个回合的最后一步必须调用它交账：本回合结果（no_change / progress / done / blocked / needs_owner）、世界上多了什么和谁能看到、证据与验证层级、各目标的进展、议程与关注项变更、新发现的事去哪、下次什么时候想（必须写理由，只能约下一次）、至多 1 个给主人的问题、重要度。只有计划没有交付物算 no_change；done 只表示完成待验收。校验不过会返回逐字段错误，改正后再交，同一张唤醒单最多交 3 次。交账后除 hub_state_get 外的工具都会被拒，请直接结束回合。」

**参数**（【统一口径】合并 7.7、8.3.6、10.3、10.5、11.7、11.8、11.12、9.6.1、12.5.3 的要求）

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| wake_id | string | 是 | 该会话当前 started 的唤醒单；原生回合补交账用补交账消息给的单号（7.7 R2） |
| outcome | enum：no_change / progress / done / blocked / needs_owner | 是 | 本回合主意图的结果 |
| world_delta | {what, visible_to: self / owner / peers / external, who} | 是 | what 1–300 字，no_change 写「无」；who ≤ 60 字 |
| evidence | array ≤ 10：{kind: path / jsonl_row / outbox / command / url / event, ref, note} | outcome 为 progress、done 时必填 | ref ≤ 300 字符，note ≤ 100 字。【统一口径】第 8 章的 file、outbox_result、command_output 分别写作 path、outbox、command |
| verification | {level: program / agent / e2e / none, not_covered} | progress、done 必填 | not_covered ≤ 200 字，没有就写「无」 |
| goal_reports | array ≤ 3：{goal_id, outcome, summary, evidence_idx[], independent_steps_left, blocker_key, continue_rounds} | outcome = done 时必填；涉及目标的 progress、blocked、needs_owner 应填 | summary ≤ 200 字；evidence_idx 引用本次 evidence 的序号；needs_owner 必填 independent_steps_left（bool）；blocked 必填 blocker_key（= blocker.key）；continue_rounds 0–8【二期】。【统一口径】取代 7.7 的顶层 goal_id |
| agenda_ops | array ≤ 10：{op: upsert / close, ...} | 否 | 其余字段同 17.7、17.8，用同一校验函数 |
| watch_ops | array ≤ 5：{op: update / propose, ...} | 否 | 其余字段同 17.9、17.10 |
| new_items | array ≤ 5：{title, class: A–D, disposition, undo, ref, item, handoff_id} | 否 | title ≤ 40 字；disposition：do / notify / propose / ask / drop / idea，二期加 delegate；B 类 undo 必填；notify 的 item 按 10.3「发现」字段，propose 按 10.3「提议」字段；delegate 必须带本回合创建的 handoff_id（12.5.3） |
| owner_question | {question, why_owner, options, default, wait_cost, meanwhile, blocks, subject_ref, reask_reason} | 至多 1 个 | 字段与长度按 10.3「提问」；options 2–3 个，各 {key, label ≤ 8 字, consequence ≤ 60 字, action_class}；default 只能是 A、B 类或「不做」的选项；subject_ref 引用本单的理由编号，用于等你同主题判断（7.2 R9）；reask_reason 在 30 天内同键问题已答过时必填（10.10 第 5 条）。【统一口径】第 8、9 章写的 owner_ask 就是本字段 |
| owner_action | {what, steps, minutes, cause_code} | 否 | 10.3「告警」的「要你做的一件事」：what ≤ 60 字；steps ≤ 5 步最短路径，要主人运行的命令只能是家目录里的脚本路径 |
| blocker | {key, what, waiting_for, recheck, handoff_id} | outcome = blocked 必填 | key 为稳定短码，≤ 40 字符；what ≤ 100 字；handoff_id【二期】在等交接单时填，中心据此置 waiting_peer |
| drive_ack | array：{reason_id, action: cleared / snoozed, until, reason} | 本单理由含 drive 时必填 | 每条 drive 理由一项；reason ≤ 100 字；snoozed 的 until 由中心夹到 [24 小时, 72 小时]，承诺类不晚于 due_at − 2 小时（7.3 R9）。【统一口径】加 reason_id，区分同一内驱的不同主题 |
| next_think | {kind: at / after / on_event / auto, at, after_min, on_event: {watch_id, match, deadline}, ref, reason} | 是 | reason 10–200 字；after_min 1–10080；ref 可指向一个议程项；出现 every、cron、daily、weekly、repeat 等周期字段即拒 |
| importance | int 1–10 | 是 | 1–3 例行、4–6 有进展、7–8 异常或需主人决定、9–10 事故或目标变化 |
| rules_version_seen | int | 是 | 唤醒包给出的 rules_version 原样回报（11.8 生成时机第 6 条） |
| rules_applied | int[] ≤ 10 | 否 | 只在某条规矩改变了做法时写它的编号（11.7 规则 5） |
| rule_conflict | {rule_ids: [a, b], situation} | 否 | situation ≤ 100 字（11.12 规则 2） |
| inbox_withdraw | array ≤ 3：{item_id, reason} | 否 | reason ≤ 60 字；只能撤自己发起、仍 pending 的提议和提问（10.5） |
| approval_withdraw | array ≤ 3：{approval_id, reason} | 否 | reason ≤ 60 字；由动作闸撤回并同步撤回收件箱项。【统一口径】落实 9.6.1 第 9 条，收件箱的 inbox_withdraw 不撤审批 |
| owner_answered | array ≤ 3：{item_id, quote} | 否 | 主人在本回合会话里亲手回答了收件箱里的那件事；quote ≤ 200 字；中心核对本回合确有主人亲手消息才接受（10.5 撤回第 2 条） |

**返回**：`{accepted, errors: [{field, reason, fix}], wake_id, next_at, clamp, attempts_left, notes}`。next_at 写成 +08:00 本地时间；clamp 取 none / raised_to_min / lowered_to_max / yellow_x2 / blocked_daily（7.5）。

**校验**（按顺序）

1. wake_id 等于该会话当前 started 的唤醒单；本单已交账 → already_committed（7.7 R2、7.6 R12）。
2. 结构、枚举、长度；next_think 与 agenda_ops 里的周期字段一律拒（7.4 R1）。
3. progress、done 至少 1 条能核对的交付物：家目录内本单 started 之后修改过的文件，或本机器人本单的 outbox_id；只有 url、command、event 的降为 no_change（7.7 R3）。goal_reports 的证据按 8.3.6 第 2 条逐条核对，核对不过的那条记 ignored。
4. done：至少一条 goal_reports.outcome = done；声明层级低于该目标 min_verification 的当场退回，不进验收（8.3.6 第 5 条）。
5. needs_owner：必须有 owner_question、owner_action，或本单产生的待处理审批单之一（7.7 R5）。owner_question.blocks = true 时，所有 outcome = needs_owner 的 goal_reports 必须 independent_steps_left = false；S1、S3 由中心按 goal_reports 写入（8.3.4）。
6. 问题至多 1 个，第 2 个退回；同键待处理的合并；30 天内同键已答的由中心直接交回旧答案、不进收件箱，除非带 reask_reason（7.7 R6、10.3）。
7. new_items 的 propose 必须过提议门槛与配额（17.4.6），不过的改记 idea。含具体「对世界的」C、D 类动作（发评论、写主人目录、删除等）的不能 propose，要用 hub_outbox_submit；对机器人自身配置的 D 类变更（扩权、改规矩、新建机器人、改志向、新关注来源）只能 propose。【统一口径】把 7.7 的禁令限定在对世界的动作，与 9.4 末段一致。
8. drive_ack 覆盖本单全部 drive 理由；写 cleared 但该主题没有进展的，按 snoozed 24 小时处理并在回执注明（7.3 R9）。
9. world_delta.visible_to 为 external 或 peers、本单却没有出站记录：照收，写 audit「声称别人看得见却没有出站记录」，交动作闸复核（7.7 R8）。
10. 全部文本过禁写项过滤器（11.3）：核心字段命中 → 替换并记 audit；找主人的事项命中 → 退回改写。
11. 次数：核心字段（wake_id 到 importance、rules_version_seen）3 次都不合格 → 按未交账（7.7 R11）；找主人的事项改 2 次仍不合格 → 只丢弃该事项，交账照收（7.7 R1）。

**行为出处**：处理流程 13 步见 7.7；下次思考夹紧、到点核对与退避见 7.5 R9–R11；内驱 7.3 R9；目标、停止条件、验收 8.3.4–8.4.2；找主人 10.3–10.5；规矩 11.7、11.12；原生回合补交账 7.8 R5；同伴派生 12.5.3。

### 17.7 hub_agenda_upsert【一期；peer 来源二期】

**用途**：机器人建立或修改自己的一条议程项，它代替一切闹钟。

**给模型的说明**：「建立或修改你自己的一条议程项：要做的事（task）、到时回看（follow_up）、条件满足才做（conditional）、对主人的承诺（commitment）、复查（review）。每项必须挂在你的一个目标或志向下，写清为什么和放弃条件；只能设一种触发（at / after / on_event / on_reply），不能写周期。时间带时区，缺省按 Asia/Shanghai。同一个 dedupe_key 即更新那一项。要等主人拍板的项设 depends_on_owner，它不会按时间叫醒你。」

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| item_id | string | 否 | 改已有项时填；新建由中心生成 `ag_<ULID>` |
| dedupe_key | string ≤ 64 字符 | 是 | 本机器人未结束项里唯一；同键即更新 |
| kind | enum：task / follow_up / conditional / commitment / review | 新建必填 | 约束见 7.4 R2 |
| title | string | 新建必填 | ≤ 60 字 |
| why | string | 新建必填 | ≤ 200 字，说清为哪个目标或志向 |
| goal_id / aspiration_id | string | 至少一个 | 本机器人未结束的目标或 active 志向 |
| trigger | {type: at / after / on_event / on_reply, at, after_min, on_event: {watch_id, match}, on_reply: {inbox_id}} | 新建必填 | 只能一种；match 语法见 7.4 R4；on_reply 引用自己发起的收件箱项 |
| not_before、due_at、expires_at | ISO 时间 | 否 | 都 ≤ 创建后 30 天；commitment 必须有 due_at；expires_at 缺省见 7.4 R8 |
| priority | enum：P1–P4 | 否 | 默认 P2；commitment ≥ P1；P0 只由主人或中心设 |
| depends_on_owner | bool | 否 | 默认 false |
| drop_conditions | array ≥ 1：{type: achieved / impossible / irrelevant / expired, rule} | 新建必填 | rule 可选，语法见 7.4 R7 |
| linked_watch_ids | string[] ≤ 5 | 否 | 必须是本机器人的关注项 |
| origin | enum：owner / self | 否 | 默认 self；owner 必须带 origin_ref |
| origin_ref | string | origin = owner 时必填 | 指向本回合主人亲手消息（会话 id + 事件时间）或收件箱项 |
| notify_on_done | bool | 否 | 主人说过「做完告诉我」时为 true（10.10 第 6 条） |
| acceptance | enum：accepted | 二期 | 接受同伴派来的项（7.4 R12 第 3 条）；拒绝用 hub_handoff(reject) |

**返回**：`{item_id, status, fire_at, notes}`；fire_at 回显 +08:00；被 7.4 R11 推后时 notes 写明原因。

**校验**：7.4 R1（目标或志向有效、只一种触发、拒周期字段、30 天、长度）、R2（类型约束）、R10（未结束 ≤ 30 条，其中 self 来源且按时间触发 ≤ 10 条；超限时返回 3 条最旧的 P3、P4 项）、R11（同键 follow_up 或 review 刚以 no_change 结束时，新间隔至少翻倍）、R12（origin = owner 核对不过改记 self 并写 audit）；源自不可信感知的项由中心置 from_untrusted = true（13.4 第 38 条）。

**行为出处**：7.4（状态转移、意图时钟、紧迫度、回看零成本核对）。

### 17.8 hub_agenda_close【一期】

**用途**：关闭自己的一条议程项。

**给模型的说明**：「关闭你自己的一条议程项：做完写 done；放弃写 dropped，并说明命中了哪类放弃条件（达成、做不到、不再相关、过期）。『困难』『暂时没进展』不是放弃理由。」

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| item_id | string | 是 | 自己的未结束项 |
| result | enum：done / dropped | 是 | |
| drop_type | enum：achieved / impossible / irrelevant / expired | result = dropped 时必填 | |
| closed_reason | string | 是 | ≤ 200 字 |

**返回**：`{item_id, status}`。

**校验**：已结束 → duplicate；dropped 的 closed_reason 不能只写「困难」「暂时没进展」（同 8.3.3 第 5 条）；对主人的 commitment 被 dropped 时，中心在日报写一行「答应你的 X 已取消（原因）」（7.4 R7）。

**行为出处**：7.4 R7、R9。

### 17.9 hub_watch_update【一期】

**用途**：机器人在边界内自己调整注意力：收窄、调频、静音、删除、延期，或在已获批的范围内新建。

**给模型的说明**：「调整你自己建的关注项：收窄或放宽过滤、调轮询间隔（不低于来源下限）、加或收紧期望、静音最长 30 天、删除、延长到期（每次 ≤ 30 天）；也可以在已经获批的来源类型、目录和域名内新建。每次必须写理由。改动立即生效、写进日报，主人可以一键撤销。主人建的关注项、第一次用的来源、新目录、新域名、门控脚本，请用 hub_watch_propose。」

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| op | enum：create / update / mute / unmute / delete / extend | 是 | |
| watch_id | string | create 以外必填 | 必须是 created_by = bot 的关注项 |
| watch | object | create 必填 | name ≤ 30 字、source_type、target、filter、expectation（≤ 3）、poll_minutes、linked_goal_id 或 linked_aspiration_id、tags、time_sensitivity；字段语义见 7.1 数据表 |
| patch | object | update 必填 | 只允许：filter（target 不变）、poll_minutes（不低于来源下限，≤ 1440）、加或收紧 expectation、bias（−0.20 至 0）、改挂同一志向下的另一个目标 |
| mute_until | ISO 时间 | mute 必填 | ≤ 30 天后 |
| extend_days | int 1–30 | extend 必填 | |
| rationale | string | 是 | ≤ 200 字 |

**返回**：`{watch_id, version, undo_id, notes}`。

**校验**：7.1 R12；对主人建的项返回 not_allowed 并提示改用 hub_watch_propose；create 只限这个机器人用过并获批过的来源类型、已授权目录、域名白名单，script 一律不能 create（7.1 R13 第 4 条）；每个机器人 ≤ 20 条（含 muted、proposed、failing）；运行中会改变三要素实际占用的变更先过组合检查（13.4 第 18 条）；L0 → not_allowed_level（17.4.4）。

**行为出处**：7.1 R12（B 类：写 audit、进当天日报、详情页可一键撤销）；撤销 9.7.3、16.4 规则 7。

### 17.10 hub_watch_propose【一期】

**用途**：提议需要主人批准的关注项变更。

**给模型的说明**：「提议需要主人批准的关注项变更：第一次用某种来源、新的目录或域名、任何门控脚本、改或删主人建的关注项、放宽主人定的期望、把打分偏置调到 0 以上。写清为什么盯、读什么、多久看一次、预计每周多几次思考。它会成为主人收件箱里的一条提议，批准前不采集。」

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| op | enum：create / modify_owner_watch / delete_owner_watch / relax_expectation / raise_bias / change_script | 是 | |
| watch_id | string | 改已有项时必填 | |
| watch / patch | object | create 填 watch，其余填 patch | 同 17.9；script 关注项写 {path, interpreter, args, sha256} |
| why | string | 是 | ≤ 200 字，为什么盯 |
| reads | string | 是 | ≤ 80 字，读什么（给主人看） |
| est_turns_per_week | int | 是 | 预计每周多出的思考回合数 |
| value、confidence | number 0–1 | 是 | 提议门槛 |

**返回**：`{result: proposed / rejected, proposal_item_id, watch_id}`；create 时生成一条 status = proposed 的关注项草稿，不采集。

**校验**：7.1 R13 的范围；直接拒绝、不进收件箱的：低于来源下限的间隔、改 trust、命中内置安全规则或未开启的工作数据（第 13 章）、会让三要素实际占用三项（13.4 第 16 条）、脚本不在家目录或中心目录内（13.4 第 41 条）；过提议门槛与配额（17.4.6）；同键待处理的合并。

**行为出处**：【统一口径】生成收件箱 proposal（7 天撤回），不是 7.1 R13 写的审批单：这是对机器人自身配置的扩权，按 9.4 第 8 条与末段走提议；关注项上的 approval_id 改名 proposal_item_id（18.8）。主人接受后中心把草稿置为 active，门控脚本同时写入批准名单 settings.security.approved_scripts（18.22）；拒绝后同类 30 天不再提。卡片字段：为什么盯、读什么、多久看一次、预计每周多几次思考（7.1 R13）。

### 17.11 hub_goal_upsert【一期】

**用途**：在既有志向下建、改、暂停、恢复、放弃有界目标；志向只能提议。

**给模型的说明**：「在你的志向下建、改、放弃有界目标：L2 起直接生效并在日报告知；L1 只生成提议；L0 不能用。目标必须写可验证的终态、证据要求、最低验证层级、周期和验收方，不能写『持续』『尽量』这类没有终态的话。暂停、恢复目标，以及主人在本回合亲手要求的改动，要带 authority = owner_message 和主人原话。志向只能提议，由主人确认。」

**参数**（8.6 第 2 条）

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| target | enum：goal / aspiration | 是 | aspiration 只接受 create、edit，结果一律是提议 |
| action | enum：create / edit / pause / resume / abandon | 是 | |
| goal_id | string | create 以外必填 | |
| fields | object | create、edit 必填 | 目标：aspiration_id、objective ≤ 200 字、evidence_required 1–5 条、min_verification、horizon、period_end（one_off）、renew、evaluator（rule；other_model 二期）、acceptance_rule、importance（自建 ≤ 4）、patience_hours（6–336）、notify_on_done。志向：statement ≤ 80 字、why、success_signals、boundaries |
| authority | enum：owner_message | 否 | 只在本回合有主人亲手消息时填 |
| owner_quote | string | authority 填了时必填 | ≤ 200 字，主人原话 |
| reason | string | 是 | ≤ 200 字 |
| drop_condition | {type: achieved / impossible / irrelevant / expired, evidence} | abandon 必填 | 「困难」「暂时没进展」不算 |

**返回**：`{result: applied / proposed / rejected, goal_id, proposal_item_id, message}`；message 例「已生效」「已生成提议 #31，进主人收件箱」「拒绝：L0 不能建目标」。

**校验**：8.2 自校验（GOAL_OPEN_ENDED、志向 active、day 目标必须有 acceptance_rule、同时 active + verifying ≤ 3）；8.3.3（机器人每 7 天自建 ≤ 3 个、被撤销的也计数；自建 evaluator 只能 rule，二期加 other_model）；authority 核对：本回合输入里有 source.kind = user 且带 rpcId 的消息，且 owner_quote 能在其中找到，核对不过按机器人自己的等级处理；pause、resume 只认 authority = owner_message；L0 → rejected；L1 → proposed 并受提议配额（17.4.6）；target = aspiration → 生成预填提议（8.3.1 第 3 条）。

**行为出处**：8.3.3–8.4；渲染 8.5。

### 17.12 hub_outbox_submit【一期；feishu_message、git_push 二期】

**用途**：机器人对外动作的唯一入口，由中心代为执行；也是被拦下的 C、D 类工具调用申请批准票的入口。

**给模型的说明**：「对外动作只能用它提交，由中心代为执行：把家目录里准备好的文件写进主人的目录（owner_file_write）、在白名单仓库的 issue 或 PR 下发评论（github_comment）。写清做什么、谁会看到、能否撤销、为什么、不批会怎样、不依赖它的部分你在做什么。目标不在出站白名单会被直接拒绝。需要审批的会生成审批单，批准后中心执行，你不需要再调用。被动作闸拦下的其他工具调用，用 kind = tool_call 带同样的参数申请，批准后用完全相同的参数再调一次。不要重复提交，同一个 bot_ref 只算一件事。」

**参数**

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| kind | enum：owner_file_write / github_comment / tool_call；二期 feishu_message / git_push | 是 | tool_call 见本节末【新增建议】 |
| target | string | 是 | 规范化目标：绝对路径 / `github:<owner>/<repo>#<n>` / 工具名（tool_call） |
| payload | object | 是 | owner_file_write：{source_path（家目录内）, dest_path, mode: create / overwrite / append, content_hash}；github_comment：{body ≤ 4,000 字}；tool_call：{tool, args, cwd}，必须与之后实际调用的参数逐字一致 |
| summary | string | 是 | ≤ 40 字，一句话写后果，不写代号 |
| who_sees | string | 是 | ≤ 120 字 |
| reversible | enum：yes / partial / no | 是 | |
| undo | string | reversible ≠ no 时必填 | ≤ 200 字，怎么撤、期限多久 |
| why | string | 是 | ≤ 300 字，必须引用 goal_id 或 aspiration_id |
| if_rejected | string | 是 | ≤ 60 字，不批会怎样（10.3 审批卡的「不批会怎样」） |
| independent_work | string | 是 | ≤ 200 字，不依赖它的部分正在做什么 |
| bot_ref | string ≤ 64 字符 | 否 | 跨回合不变的语义键，如 issue-41-first-reply；缺省取 payload_hash。【统一口径】7.6 R16 b 的 intent_key 就是它 |
| handoff_id | string | 二期 | 交接派生的动作必填（12.3 第 39 条） |

**返回**：`{result: queued / awaiting_approval / duplicate / rejected / trial_dry, outbox_id, approval_id, inbox_item_id, message}`；例「已排队执行 ob-55（预批规则 pa-3）」「已提交审批，批准后由中心执行，你不需要再调用」。

**校验**（按顺序；合并 13.5.1 第 9 步与 9.7.2）

1. 变体与状态：轻复查、复盘、过期单、急停 → 拒；试跑 → 走完全部校验后返回 trial_dry，不建任何记录（6.2.4）。
2. 等级：L0 → 拒，提示写成提议。
3. 类型本期支持；tool_call 的 tool 必须是动作闸判为 C 或 D 的那次调用。
4. 目标在出站白名单（tool_call 不查白名单）；sends_external = false 的机器人对主人以外的目标直接拒，不转审批（5.3.3 第 3 条）。
5. 频率：每个机器人每天出站执行合计 ≤ 10 次，其中目标为主人以外的 ≤ 5 次；同一外部目标每天 ≤ 2 条（github_comment 即同一 issue / PR ≤ 2 条）。【统一口径】合并 9.6.3 第 4 条与 13.4 第 87 条。
6. 禁写项过滤器：命中密钥类 → 拒并记严重越界；命中其他类 → 拒并说明类别，不替换（13.4 第 55 条）。
7. 拒绝记录：同一 payload_hash 30 天内被拒或过期 → cooldown 并附主人当时写的原因；同一 action_kind 连续 3 张被拒 → 7 天冷却（9.6.1 第 4 条）；二期再查全体有效的目标指纹（12.3 第 36–37 条）。
8. 二期：认领锁与交接派生的较低等级（12.3 第 6、39 条）。
9. 去重：30 天内同 dedupe_key（sha256(kind + 换行 + 规范化 target + 换行 + payload_hash)）已有非终态或 done 记录 → duplicate，返回原编号；同一机器人同一 bot_ref 已有非终态或 done 记录 → duplicate，不再执行（满足 7.6 R16 c）；想改内容先用 approval_withdraw 撤回旧的。
10. 数量：本机器人同时待处理的审批单 ≤ 3 张，本单新建 ≤ 3 张。【统一口径】取 10.3 的 3 张，9.3 第 4 条的 5 张作废。
11. 分流：等级 ≥ L2 且命中 active 预批规则（kind 相同、target 匹配、used_today < daily_cap、未过期）→ queued，route = preapproval；否则建审批单 → awaiting_approval，同步建收件箱项（9.7.2）。
12. 先登记再执行：写 wakes.side_effects（status = intended，dedupe_key 同第 9 条）后才交出站执行器（7.6 R16 b）；执行中被打断、状态未知的永不自动重发（7.6 R16 d、9.8）。

**tool_call 流程【新增建议】**：动作闸在 tools/pre-execute 拦下 C、D 类工具调用时，返回「请用 hub_outbox_submit(kind = tool_call) 写清后果与理由后申请」；机器人提交后，中心按本节第 1–10 条建审批单（origin = tool_call）；主人批准后发批准票，绑定 sha256({bot_id, tool, cwd, 规范化 args})，24 小时内一次有效（9.6.1 第 6 条）；中心唤醒机器人，机器人用完全相同的参数再调一次，动作闸消费批准票后放行（9.7.1 第 5 步）。中心不代为执行 tool_call。理由：原始工具调用不带 9.6.1 第 10 条要求的「做什么、谁会看到、能否撤销、为什么、不批会怎样」，动作闸按 9.7.1 直接建单时这些字段无从填写。

**行为出处**：9.6–9.8、9.10；幂等 7.6 R16；撤销 9.7.3。

### 17.13 hub_lesson_propose【一期；待核实区与审核二期】

**用途**：写长期记忆（memory/MEMORY.md 只能经它写），或建议主人立一条规矩。

**给模型的说明**：「把值得长期记住的结论写进你的 memory/MEMORY.md，或建议主人立一条规矩（target = rule_suggestion）。一条只写结论和适用条件，≤ 200 字，注明来源和验证层级，至少满足两项入库门槛。外部网页、文件、同伴的说法一期不进长期记忆，可以记在 work/。含密钥、邮箱、候选人信息等禁写项会被拒。」

**参数**（11.3）

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| op | enum：add / update / retire / merge | 是 | |
| entry_id | string | update、retire 必填 | |
| entry_ids | string[] 2–5 个 | merge 必填 | |
| target | enum：memory / rule_suggestion | 是 | rule_suggestion 不写记忆，转成规矩确认提议（11.11） |
| kind | enum：preference / fact / lesson / practice | add 必填 | 界面显示偏好 / 事实 / 教训 / 做法；practice 只写一句和 playbooks 路径 |
| text | string | add、update、merge 必填 | ≤ 200 字 |
| source | enum：owner / self / external | 是 | |
| source_ref | string | 是 | wake_id、item_id、percept_id 或链接 |
| test_level | enum：program / agent / e2e / none | add 必填 | source = self 的 fact、lesson 不能是 none |
| criteria | 多选：long_term_decision / reused / costly_if_forgotten / actionable / verifiable | add 必填 | 至少 2 项 |
| tags | string[] 1–5 个 | add 必填 | goal_id、watch_id、主题词 |
| quote | string | source = owner 或 target = rule_suggestion 时必填 | ≤ 200 字，原话原样 |

【统一口径】11.3 的 kind、test_level 用中文枚举值；存储与参数一律用上表英文代码，中文只在界面和 MEMORY.md 渲染里出现。

**返回**：`{accepted, entry_id, reason, bytes_used}`；被拒时 reason 写类别与改法，不回显命中的敏感内容。

**校验**：11.3 入库检查 8 步（格式 → 禁写项 → 来源核对 → 外部来源一期拒 → 门槛 → 去重相似度 ≥ 0.8 → 体积 12 KB → 原子写）；每回合 ≤ 5、每天 ≤ 10；MEMORY.md 达 12 KB 后只接受 merge、retire；target = memory 在 L0 返回 not_allowed_level；rule_suggestion 同一主人原话不重复提，并占提议配额（17.4.6）。

**行为出处**：11.2–11.5、11.11。

### 17.14 hub_reflect_commit【一期简版；experiments 二期】

**用途**：复盘回合的交账。

**给模型的说明**：「复盘回合的交账：≤ 3 条洞察（每条引用唤醒单）；≤ 5 条你自己可以直接改的调整，只收不扩（收窄关注、拉长间隔、停用自建关注项、调议程优先级、按放弃条件关闭议程、在既有目标下加 task、改做事清单），每条写撤销办法和预期效果；需要主人批准的提议；教训；复盘后的下次思考。因未交账或同一阻碍连续 3 次触发的复盘，必须在 addresses_trigger 里说明怎么应对。」

**参数**（7.9）

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| wake_id | string | 是 | 当前复盘单 |
| insights | array ≤ 3：{text, evidence} | 是 | text ≤ 150 字；evidence 至少 1 个 wake_id |
| self_changes | array ≤ 5：{target: watch / agenda / playbook, ref, op, before, after, undo, expect, observe_n} | 否 | 只收不扩（7.9 R5）；undo 必填；expect ≤ 80 字；observe_n ≥ 3 |
| proposals | array：{kind: goal_add / goal_change / goal_drop / aspiration_revise / watch_new_source / budget / autonomy / tool / new_bot, item} | 否 | item 按 10.3「提议」字段；过门槛与配额（17.4.6） |
| lessons | array ≤ 5 | 否 | 每项参数同 17.13 |
| experiments | array：{hypothesis, change, observe_n, metric, decide_by} | 二期 | 同一机器人同时 ≤ 1 个 |
| addresses_trigger | string | 由 missing_streak、blocker_streak 触发时必填 | ≤ 200 字；且至少带 1 条 self_change 或 proposal（7.9 R9） |
| next_think | object | 是 | 同 17.6 |

**返回**：`{accepted, errors, applied: [{ref, undo_id}], proposals: [{item_id}], lessons: [{entry_id 或 reason}], next_at}`。

**校验**：7.9 R5（放宽范围、缩短间隔、延长到期、新增对人承诺一律退回，提示改成 proposals）、R9、R10、二期 R12；L0 的 self_changes 由中心转成 proposals（17.4.4）；没交 hub_reflect_commit 的复盘按未交账（7.9 R14）。

**行为出处**：7.9。

### 17.15 二期工具：hub_belief_set、hub_handoff、hub_send【二期】

**hub_handoff、hub_send**：参数、返回、拒收代码全部以 12.5.1 为准，本章不重复。补充两条注册约束：两者都不接受 from、bot_id 参数；子代理没有这两个工具。

**hub_belief_set**（第 7 章信念板未写正文，这里给最小定义，二期开工前由第 7 章补全）

| 名称 | 类型 | 必填 | 约束 |
|---|---|---|---|
| key | string ≤ 64 字符 | 是 | 主题键，例如 xhs_service.last_run；本机器人内唯一 |
| value | JSON | 是 | ≤ 1 KB |
| confidence | number 0–1 | 是 | 来源为外部时中心封顶 0.6，除非两条独立来源或主人确认 |
| evidence_ref | string | 是 | 路径、链接或 percept_id；trust 由中心按它定，机器人不能填 |
| ttl_hours | int 1–720 | 是 | 保鲜期 |
| expected | object | 否 | 期望，格式同 7.1 的 by / every / count / absent |
| importance | int 1–5 | 否 | 默认 3；≥ 4 且过保鲜期时求知内驱上升（7.3 R6） |
| reason | string | 是 | ≤ 100 字 |

校验：「主人已同意」「规则已改」这类说法不能写成信念；每个机器人 ≤ 100 条；写入记 self_change。返回 `{key, version, undo_id}`。

### 17.16 机器人不得拥有的工具与屏蔽方式【一期】

**屏蔽分六层**，任一层缺失都由下一层兜住：

1. 角色模板不挂该行（5.4.2）。
2. 在机器人 agent.ctx 上 `tools.restrict({deny})`，deny 取「名单 ∩ 该 agent 实际继承到的工具名」，restrict 遇到不认识的名字会抛错（5.5.2）【待验证 V5、V27】。
3. 动作闸允许清单：不在该机器人 tools_allowed 里的工具一律拒绝并记越界（9.6.4 第 4 条、13.4 第 9 条）；主人以后装的插件、宿主层新增的工具默认用不了。
4. `tools.guard` 硬拒绝：受保护文件、内置敏感路径、急停时的只读（11.8、13.4 第 82 条）【待验证 V26】。
5. `agent/pre-step` 安全网：schedule、goal 等来源的回合在第一步就拒（7.5 R16）【待验证 V17】。
6. 读回核对：工厂 P4、会话轮换、启动对账、冒烟测试都按 17.3 第 5 条核对一遍。

| 工具或工具族 | 来自 | 为什么不给 | 屏蔽层 | 出处 |
|---|---|---|---|---|
| ask_user_question | tool-ask-user | 无人值守时无限等待 | 1、2、3 | 骨架第 9 节；5.4.2；13.4 第 8 条 |
| exit_plan_mode | plan-mode 行 | 计划审批是阻塞的 ask，跨重启保留 | 1、2、3 | 同上 |
| schedule_create / list / update / delete | tool-schedule | 唤醒只来自中心 | 1、2、3、5 | 骨架第 10 节第 1 条 |
| create_goal / update_goal、/goal | tool-goal、command-goal | 目标轮次由中心控制 | 1、2、3、5 | 骨架第 9 节；8.4.4 第 1、6 条 |
| working_directory | 宿主层 | 切 cwd 会换上别人的指令链，身份漂移 | 2、3 | 5.5.2 |
| plugin_manager | tool-plugin-manager | 扩权，动作作用于整个 profile | 1、2、3 | 骨架第 9 节 |
| subagent_fork、workflow、ralph、run_code | delegation 组、实验包 | 扇出与额度不可控 | 1、2、3 | 【统一口径】一期按 5.4.2 与 9.2.2 不给；二期 V28 通过后按 12.3 第 60–62 条对 standard 档放开 subagent_fork、workflow |
| taskboard_* 全部 | dsh-taskboard | 卡片可设完全访问、自带定时，绕过动作闸、额度闸与往返上限 | 2（按 `^taskboard_` 枚举）、3 | 12.3 第 54–55 条；13.4 第 8 条 |
| Agent Teams 的 9 个工具 | 智能体团队组合包（主人自己开启时出现） | 遮蔽预设同名工具，队友回合额度翻倍 | 2、3 | 12.3 第 68 条；5.5.2；二期按 12.3 第 69 条逐个放行 |
| 不在 mcp_allow 里的 mcp__<server>__* | 宿主层或角色模板的 MCP | MCP 进程不进沙箱、调用不走审批 | 2、3 | 13.4 第 46 条 |
| 能对外发送的 MCP 工具（飞书、邮件类） | 同上 | sends_external = false 时一律不给，mcp_allow 写了也不给 | 2、3 | 5.5.2 |
| subagent 的外部后端（Claude Code、Codex 提供方） | delegation | 保留各自权限系统，绕过动作闸 | 3（按参数拒） | 12.3 第 65 条 |
| bash、run_code、subagent、后台任务工具 | persistent-shell、delegation、tool-jobs | 工具档 no_shell（碰不可信内容的机器人） | 2、3 | 13.4 第 12、17 条 |
| web_search、web_fetch | tool-web | 未占「碰不可信」；web_fetch 另要求 web_hosts 非空 | 1（盯守型）、2、3 | 5.5.2；13.4 第 30 条 |
| tool-jobs 的工具 | tool-jobs | 盯守型不需要；完成通知会唤醒会话 | 1 | 5.4.2【待验证 V30】 |
| 实验包「会话搜索」的工具、宿主内省工具（cordis_inspect_* 等，如存在） | 实验包、宿主层 | 机器人用不到；不在允许清单 | 3 | 本章【待验证 V27】 |
| 全部 hub_*（对子代理） | — | 子代理不能交账、不能提交出站 | 不注册、3（按血缘） | 5.5.2；13.4 第 13 条【待验证 V25】 |

万一调到上表任何工具：拒绝并记一次越界（9.6.4 第 4 条）。Auto review 不是工具，角色模板里不开（14.5）。

### 17.17 验收

1. 机器人会话的工具清单 = 角色模板行 − 工具档 − 屏蔽项 + 本期全部 hub_*；主人普通会话、`.factory/` 起草会话、`.hub-smoke/` 冒烟会话的工具清单里搜不到任何 hub_*。
2. 机器人派出的子代理调用 hub_commit、hub_outbox_submit 被拒，越界记在父机器人名下。
3. 17.4.2 的每个错误码至少 1 个用例：工具返回结构化 errors，宿主进程 pid 不变。
4. 变体矩阵：在轻复查、复盘、试跑、过期单、交账后锁定、急停下逐格调用 17.4.3 标「拒」的工具，全部返回 not_allowed_variant、already_committed 或 emergency_stop；试跑下改动类工具返回 trial_dry，各表无变化。
5. 等级矩阵：同一组调用在 L0、L1、L2 机器人上的结果与 17.4.4 一致；试岗机器人按 L1。
6. 同一张唤醒单内以相同参数调用两次 hub_agenda_upsert，只有 1 条记录；重放被打断的唤醒单后出站动作没有重复执行。
7. 一个回合第 16 次 hub_state_get 返回 rate_limited；hub_state_get 每次返回 ≤ 8 KB，percept 范围的外部内容都在围栏内且 nonce 每次不同。
8. hub_commit：goal_reports 里 outcome = done 的目标进入 verifying；代码检索不出现 owner_ask、顶层 goal_id 字段。
9. hub_outbox_submit：白名单为空时 github_comment 直接拒、不出审批单；同一 bot_ref 已 done 后再交返回 duplicate；第 4 张待处理审批单返回 limit；试跑中返回 trial_dry 且 outbox、approvals 无记录。
10. tool_call：机器人删 work/ 之外的文件被拦 → 用 kind = tool_call 申请 → 主人批准后以相同参数执行一次；改一个字符的参数再调用被拦并生成新审批单。
11. 机器人提议配额：L1 机器人同一周第 4 条提议（来源混合：new_items、hub_watch_propose、rule_suggestion 各一条再加一条）返回 limit，内容进点子池。
12. 读回核对失败（人为让某个 hub_* 注册失败）的机器人不被唤醒，告警写明缺哪个工具。

### 17.18 新增建议

1. hub_state_get 的 scope 与返回（17.5）写进骨架第 9 节。
2. 工具统一错误码（17.4.2）、每张唤醒单的调用上限（17.4.5）写进骨架第 6 节。
3. hub_commit 合并字段：goal_reports、rules_version_seen、rules_applied、rule_conflict、inbox_withdraw、approval_withdraw、owner_answered、owner_question.reask_reason；删除 owner_ask 与顶层 goal_id 的写法。
4. hub_outbox_submit 增加 kind = tool_call，作为原始工具调用申请批准票的入口；理由见 17.12。
5. 提议配额覆盖全部机器人发起的提议来源（17.4.6）。
6. 试跑里改动类工具一律 trial_dry（17.4.3）。
7. 骨架第 9 节「机器人不得拥有」补：taskboard_*、Agent Teams 的 9 个工具、subagent 外部后端、一期的 subagent_fork / workflow / ralph / run_code，以及不在 mcp_allow 里的 MCP 工具。
8. 证据种类统一为 path / jsonl_row / outbox / command / url / event（第 7、8 章共用）。
9. 枚举值一律英文代码（hub_lesson_propose 的 kind、test_level、criteria，rules 的 kind、scope），中文只在界面与渲染文件里出现。
10. hub_belief_set 的参数（17.15）作为二期信念板的起点，由第 7 章补正文。

## 18. 数据模型汇总

### 18.1 职责

把各章分散定义的存储表、字段、保留期、写入方与读取方合到一处，给出存储约定（主键、时间、迁移、跨表写入、清理），并列出根目录、家目录与中心数据目录下的全部文件。实现方照本章写 zod schema 和 storageDomain 的 tables；字段的业务含义与约束仍以「出处」列的章节为准，本章只在跨章冲突处给出统一写法（标【统一口径】）。

### 18.2 存储约定【一期】

1. **一个 domain**：`ctx.storageDomain.open({name: 'agent_hub', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip', tables: {...}})`，tables 含 18.3 全部一期表；同名 domain 在进程内只 open 一次，插件重载时在 effect 清理里 close（7.1 实现，evidence 05 C9）。数据落在 `~/.dsh/storages` 的 json 后端。
2. **版本与迁移**：domain 的 version 固定为 1，因为 version 一变 open 就失败、没有自动迁移（evidence 05 L5）。每条记录带 schema_version；读到旧版本记录时由该表的升级函数就地升级并写回。不兼容的改动用新的 domain 名（agent_hub_v2）：中心进 maintenance，一次性搬迁并逐表核对条数，旧 domain 只读保留 30 天。二期新增表能否不改 version 直接加入 tables【待验证 V39】。
3. **写前自校验**：每张表一份 zod schema，put 前校验，失败不写、返回字段级错误并写 audit（kind = health）；put 本身不校验，写坏一条会让下次 open 时整条被备份跳过（evidence 05 C9、L5）。
4. **主键**：只用 `[a-zA-Z0-9_-]`。前缀见 18.3。【统一口径】关注项改用 `wt_<ULID>`：7.1 的 `w_<ULID>` 与唤醒单 `w_<ULID>`（7.6）撞前缀；subject_key 里的写法 `w:<watch_id>` 不变。顺序编号（志向、目标、审批、出站、预批、收件箱、规矩、告警，二期的 R、H、M）从 `settings.counters.<表名>` 自增取号；取号后记录写失败，这个号作废、不回收。
5. **时间**：存储一律 epoch 毫秒整数，字段名以 _at、_until、_ms 结尾；工具参数、界面、唤醒包、日报用 ISO 8601 带 +08:00 或「11-05 08:00」。自然日、周、窗口的切分一律按 Asia/Shanghai（固定 +08:00，没有夏令时）。【统一口径】第 8 章写的 datetime、第 12–15 章写的「ISO 时间」在存储层都是毫秒。
6. **跨表写入**：storageDomain 没有跨表事务（evidence 05 L5）。凡一次操作要写多张表（交账处理、审批决定、出站执行、退役、会话轮换、工厂建造、急停与恢复、从备份恢复），都在主记录上带操作日志 `{op_id, steps_done[]}`，按固定顺序逐步写，每步幂等；启动对账时对没写完的操作从下一步续做。这是把 7.7 的 process_steps 推广到全部多表操作。
7. **读**：storageDomain 的读是同步内存读（evidence 05 C9）；界面接口读内存快照，请求路径上不调用会话接口（16.0.5 第 6 条）。`domain/changed` 只在本进程可见，界面变更走 SSE（第 16 章）。
8. **唯一写入方**：每张表只有 18.3 列出的模块能直接 put；其他模块调用该模块的函数写，校验和 audit 集中在一处。
9. **清理与备份**：每天 04:00 之后第一个 tick 先做每日备份（15.3），再按 18.3 的保留期清理，最后写一条按表计数的汇总 audit（18.27）。【统一口径】一期每日备份同时复制各家目录的 memory/MEMORY.md、playbooks/、.agents/skills/：15.3 第 2 条把它们交给根目录 git，而 git 快照是二期（11.5）。
10. **不进存储的**：密钥（只在各工具自己的配置或 `~/.dsh/agent-hub/secrets/`，13.4 第 53 条）、主人消息正文、会话标题（10.2）、唤醒包正文 14 天后的部分。

### 18.3 表一览

| 表 | 主键（前缀） | 是什么 | 定义 | 写入方 | 主要读取方 | 保留期 | 分期 |
|---|---|---|---|---|---|---|---|
| bots | bot_id | 档案（含节奏、交账计数、健康缓存） | 5.3，并 7.5、7.7、11.6、12.2.1、13.3.1 | 名册（档案字段）、工厂、调度器（节奏）、交账处理（交账计数）、健康（缓存） | 全部 | 永久；退役后为墓碑 | 一期 |
| aspirations | `asp-<bot_id>-<n>` | 志向 | 8.2.1 | 志向与目标（主人界面、提议被接受） | 唤醒器、规矩与记忆（渲染）、界面 | 永久（archived 也留） | 一期 |
| goals | `g-<bot_id>-<n>` | 目标 | 8.2.2 | 志向与目标、交账处理（applyReport）、意图时钟（周期与 halt） | 评估器、内驱、唤醒器、界面、日报 | 永久 | 一期 |
| agenda | `ag_<ULID>` | 议程项 | 7.4 | 意图时钟、hub_agenda_*、交账处理、界面（主人）、同伴总线（二期） | 评估器、内驱、唤醒器、界面 | 结束后 90 天 | 一期 |
| watches | `wt_<ULID>` | 关注项 | 7.1 | 感知总线、hub_watch_*、交账处理、界面（主人） | 感知总线、评估器、界面 | expired、删除后 30 天 | 一期 |
| percepts | `p_<ULID>` | 感知 | 7.1 | 感知总线、评估器、意图时钟、内驱 | 评估器、调度器、唤醒器、界面、日报 | 14 天 | 一期 |
| drives | bot_id | 内驱与评估快照 | 7.3 | 内驱、评估器 | 评估器、调度器、界面 | 与机器人同；退役清理时删 | 一期 |
| queue | `q_<ULID>` | 排队项 | 7.5 | 调度器 | 调度器、界面 | 终态后 14 天 | 一期 |
| wakes | `w_<ULID>` | 唤醒单 | 7.6 | 唤醒器、回合守卫、交账处理、健康 | 全部 | 元数据 90 天；唤醒包正文 14 天 | 一期 |
| inbox | `inb_<n>`，界面显示 #n | 收件箱 | 10.5，并 16.3 | 沟通（唯一写入方；动作闸、额度、健康经沟通写） | 界面、日报、单推、唤醒器 | 终态后 90 天 | 一期 |
| approvals | `ap-<n>` | 审批单 | 9.5.1 | 动作闸 | 沟通、界面、唤醒器 | 终态后 90 天 | 一期 |
| outbox | `ob-<n>` | 出站动作 | 9.5.2 | 动作闸、出站执行器 | 交账处理、界面、日报 | 终态后 90 天 | 一期 |
| preapprovals | `pa-<n>` | 预批规则 | 9.5.3（新增表） | 界面接口（只主人）、动作闸（used_today、suspended） | 动作闸、界面 | 到期或撤销后 30 天 | 一期 scope = target；class 二期 |
| rules | `r<n>`，界面显示 r-001 | 规矩 | 11.7 | 规矩与记忆（主人确认后） | 动作闸、规矩与记忆、唤醒器、界面 | 永久（retired 也留） | 一期；角色层二期 |
| budget_ledger | ULID | 计量账 | 14.2 | 额度 | 额度、界面、日报 | 30 天 | 一期 |
| quota_state | window_id | 5 小时窗口 | 14.2 | 额度 | 调度器、界面、日报 | 90 天 | 一期 |
| alerts | `al-<n>` | 告警 | 本章 18.20 | 额度、健康、动作闸、规矩与记忆、沟通 | 沟通、界面、日报、心跳 | 恢复后 90 天 | 一期 |
| downtime | ULID | 停机记录 | 15.2 | 健康 | 日报、界面、在线率 | 90 天 | 一期 |
| settings | 键 | 设置与中心级状态 | 本章 18.22 | 界面接口（主人可改的键）；各模块（自己的状态键） | 全部 | 永久 | 一期 |
| audit | entry_id（ULID） | 审计与活动流 | 13.3.3、16.4，本章 18.23 | 各模块，只追加 | 界面、日报、复盘、信任账本 | 90 天；安全、信任、反馈 180 天 | 一期 |
| beliefs | `<bot_id>:<key>` | 信念板 | 本章 18.24 | 内驱与评估器（宿主规则更新）、hub_belief_set | 内驱、唤醒器 | 与机器人同 | 二期 |
| handoffs | `H-<n>` | 交接单 | 12.2.3 | 同伴总线 | 唤醒器、动作闸、界面 | 关闭后 90 天 | 二期 |
| claims | `R-<n>` | 认领锁 | 12.2.2 | 界面接口（主人）、同伴总线 | 动作闸、唤醒器 | 资源登记期间 | 二期 |
| mailbox | `M-<n>` | 同伴消息 | 12.2.4 | 同伴总线 | 感知总线、唤醒器 | 30 天 | 二期 |
| lessons_review | ULID | 记忆审核 | 本章 18.24 | 规矩与记忆 | 日报、界面 | 处理后 30 天 | 二期 |

点子池不单独建表，记在 audit 的 kind = idea（18.23）。

### 18.4 bots【一期】

主键 bot_id。写入：名册是档案字段的唯一写入口（经 5.3.3 校验），工厂写 factory，调度器写节奏字段，交账处理写交账计数，健康写缓存字段。

| 分组 | 字段 | 类型/枚举 | 出处 | 统一说明 |
|---|---|---|---|---|
| 身份 | bot_id | string `^[a-z][a-z0-9-]{2,31}$` | 5.3.1 | 永不复用 |
| 身份 | name、icon、persona_text、origin_request、created_by、cloned_from | 见 5.3.1 | 5.3.1 | |
| 身份 | role_preset | researcher / executor / sentinel | 5.3.1 | 【统一口径】可改，经会话轮换生效（6.3.4，end_reason = role_change）；16.2 档案设置「一期建好后不能改」作废 |
| 身份 | field_sources、revision、schema_version | 见 5.3.1 | 5.3.1 | |
| 家与会话 | home_dir | string | 5.3.1 | 建后不可改 |
| 家与会话 | current_session_id、pending_session_id | string? | 5.3.1 | 【统一口径】11.6 的 session_id 即 current_session_id |
| 家与会话 | session_history | SessionEntry[] | 5.3.2、11.6 | SessionEntry = {session_id, seq, preset_id, model_route, created_at, registered_at, ended_at, end_reason, turns, tokens, handoff_ref, archived_at}；seq、archived_at 来自 11.6；当前会话的 registered_at 即 11.6 的 session_started_at |
| 家与会话 | end_reason 枚举 | rotation_age / rotation_context / role_change / model_change / tool_change / quarantine_reset / retired / draft_abandoned | 5.3.2、11.6 | 合并后的唯一枚举 |
| 家与会话 | rotation | {due_reason, attempts, last_error, last_try_at} | 11.6 | 【统一口径】连续 2 次失败告警（骨架「告警：连续 2 次失败才报」；6.3.5 写 2 次，11.6 写 3 次） |
| 模型与工具 | model_route | {provider, model, reasoning_effort?} | 5.3.1 | |
| 模型与工具 | permission_preset | const unattended | 5.3.1、13.3.1 | |
| 模型与工具 | permission_mode | preset / fallback | 5.3.1 | |
| 模型与工具 | tool_profile | standard / no_shell；二期 restricted_shell | 13.3.1 | 工厂按三要素推出，主人确认（13.4 第 14–17 条） |
| 模型与工具 | tools_allowed | string[] | 13.3.1 | 会话创建时算出；改工具档、mcp_allow、轮换时重算 |
| 模型与工具 | tool_deny_extra | string[] | 5.3.1、13.3.1 | 只能收窄 |
| 模型与工具 | mcp_allow | {server, tools[], review_id}[] | 13.3.1 | 【统一口径】用第 13 章结构；5.3.1 的 string[] 作废 |
| 模型与工具 | allow_teams | bool | 12.3 第 69 条、13.3.1 | 二期 |
| 数据与风险 | risk_trio | {reads_private, touches_untrusted, sends_external} | 5.3.1 | 主人声明值。【统一口径】键名用第 5 章，13.3.1 的 trio{read_private, touch_untrusted, send_out} 改用这组键名 |
| 数据与风险 | risk_trio_effective | 同上 + causes[] | 13.3.1（trio_effective） | 中心按能力算出，判定一律以它为准 |
| 数据与风险 | work_data_allowed | bool | 5.3.1 | 即 13.3.1 的 work_data.enabled |
| 数据与风险 | data_scopes | DataScope[] | 5.3.2、13.3.1 | DataScope = {scope_id, kind: path / session_cwd / url_prefix / feishu_chat（二期）, target, access: read, is_private, is_work, is_untrusted, reason, granted_at, granted_via}。【统一口径】13.3.1 的 read_scopes 并入此字段，其 kind = untrusted 写成 is_untrusted；work_data.paths、chats 写成 is_work = true 的项 |
| 数据与风险 | web_hosts | string[] | 13.3.1 | 空 = 不给 web_fetch；`*` 占对外发送 |
| 数据与风险 | web_search | bool | 13.3.1 | 为真即占碰不可信 |
| 自主与预算 | autonomy | L0 / L1 / L2 / L3 | 5.3.1 | L3 二期；试岗有效等级 L1，主人可在试岗期降到 L0（16.2），不能升 |
| 自主与预算 | think_cap_daily、budget_override | 见 5.3.1 | 5.3.1、14.3 | 生效次数 = min(等级上限, 次数预算)（7.5 R2 第 8 条、14.3） |
| 打扰 | push_daily_cap、muted、quiet_hours | 见 5.3.1 | 5.3.1、10.4 | push_daily_cap 0–2 |
| 节奏 | pace_profile | active / normal / quiet | 5.3.1 | 一期固定 normal |
| 节奏 | pace_min_minutes | int? ≥ 10 | 5.3.1 | null 取角色值；7.5 表里的 pace_min 由它得出，不另存 |
| 节奏 | no_change_streak、pace_min_eff、pace_max、last_self_wake_at、last_settled_at、next_think、light_check_due_at、today | 见 7.5 | 7.5 | pace_max 单位小时（48 / 168），其余时刻字段为毫秒 |
| 生命周期 | lifecycle、lifecycle_since、activity | 见 5.3.1 | 5.3.1、骨架第 3 节 | activity 只在 probation、active 下有值 |
| 生命周期 | probation、pause、quarantine、retirement | 见 5.3.1 | 5.3.1、6.1 | pause.source = global 是 settings.security.emergency_stop 的镜像（18.22） |
| 生命周期 | factory、pending_effective | 见 6.2.2、5.3.2 | 6.2.2 | |
| 交账 | known_blockers | {key, what, first_seen, last_seen, streak, item_id, resolved_at}[] ≤ 20 | 7.7 | |
| 交账 | missing_streak、post_reflection_missing、unreflected_importance | int / bool / int | 7.7 | 【统一口径】5.3.1 counters.missed_commit_streak 即 missing_streak |
| 复盘 | last_reflection_at、reflection_pending | ms；{triggers[], since}? | 7.9 R3 | 7.9 的「待复盘标记」没有定存放，本章补在这里 |
| 健康缓存 | counters | {error_streak, violation_7d, severe_last_at, last_violation_at} | 5.3.1、13.4 第 71 条 | 缓存：真源是 wakes（回合出错，15.3）与 audit（越界，13.3.1）；每次相关写入后重算 |
| 健康缓存 | expected_by | ms | 15.3 死人开关 | 每个 tick 写，界面读（16.0.2） |
| 协作 | capability_card、peer_labels、taint | 见 12.2.1 | 12.2.1 | 二期；一期 capability_card = null |
| 内存 | gate_ready | bool | 9.12 第 8 条 | 不落库 |

### 18.5 aspirations【一期】

字段（全部出自 8.2.1）：aspiration_id、bot_id、statement、why、success_signals、boundaries、review_at、status（active / paused / archived）、created_via（factory / owner_ui / proposal）、source_ref、version、created_at、updated_at。每个机器人 active 的志向 1–3 个。写入只有两条路：主人在界面操作；主人在收件箱接受一张志向提议（8.3.1 第 2 条）。

### 18.6 goals【一期；continuous 二期】

| 字段 | 类型/枚举 | 出处 | 统一说明 |
|---|---|---|---|
| goal_id、bot_id、aspiration_id、series_id、period_no | | 8.2.2 | |
| objective、evidence_required、min_verification | | 8.2.2 | evidence_required[].type 取 path / jsonl_row / outbox / command（【统一口径】与 hub_commit 的证据种类同名） |
| horizon、period_start、period_end、renew | | 8.2.2 | |
| evaluator、acceptance_rule、owner_accepts | | 8.2.2、8.3.7 | |
| importance、patience_hours | | 8.2.2 | |
| status | proposed / active / verifying / done / failed / abandoned | 8.2.2、8.4.1 | |
| halts | {code: S1–S5, ref, since}[] | 8.2.2、8.3.4 | S4、S5 的判定口径以 14.3 为准（18.11） |
| last_progress_at、halted_ms、blocked_since、stagnant | | 8.2.2、8.3.5 | |
| progress_log | ProgressEntry[] ≤ 50 | 8.2.3 | ProgressEntry = {at, wake_id, kind, summary, evidence[{kind, ref, verified, check_note}], verification, not_covered, counted} |
| claim、acceptance、repair_used、repair_deadline | | 8.2.2、8.4.2 | |
| created_by、close_reason | | 8.2.2 | |
| proposal_item_id | int? | 本章 | status = proposed 时指向收件箱提议 |
| notify_on_done | bool | 10.10 第 6 条 | 默认 false |
| continuous | object? | 8.4.4 | 二期 |
| version、created_at、updated_at | | 8.2.2 | |

### 18.7 agenda【一期；peer 来源二期】

| 字段 | 类型/枚举 | 出处 | 统一说明 |
|---|---|---|---|
| item_id、bot_id、kind、title、why、goal_id、aspiration_id | | 7.4 | |
| trigger、fire_at、not_before、due_at、expires_at | | 7.4 | |
| priority、depends_on_owner、assignee | | 7.4 | assignee 二期加 `bot:<id>` |
| drop_conditions、linked_watch_ids | | 7.4 | |
| origin | owner / self / peer / hub | 7.4 R12 | |
| origin_ref、acceptance | | 7.4 | acceptance 二期 |
| status | pending / ready / running / waiting / done / dropped / expired | 7.4 | |
| waiting_on、frozen、attempts、no_progress_streak、skip_count、last_result | | 7.4 | |
| dedupe_key、fired_by、closed_reason、missed_reported | | 7.4 | |
| notify_on_done | bool | 10.10 第 6 条 | |
| from_untrusted | bool | 13.4 第 38 条 | 【统一口径】13.4 第 38 条写的「origin = untrusted」与本表 origin 字段撞名，改为独立布尔 |
| handoff_id | string? | 12.3 第 19 条 | 二期；accept 时回填 |
| created_by、created_at、updated_at | | 7.4 | |

### 18.8 watches【一期；feishu、peer、owner 来源二期】

| 字段 | 类型/枚举 | 出处 | 统一说明 |
|---|---|---|---|
| watch_id | `wt_<ULID>` | 7.1 | 【统一口径】前缀改 wt_（18.2 第 4 条） |
| bot_id、name、source_type、target、filter、expectation、poll_minutes | | 7.1 | |
| linked_goal_id、linked_aspiration_id、tags、bias、time_sensitivity、trust | | 7.1 | |
| created_by、rationale | | 7.1 | |
| proposal_item_id | int? | 7.1（原名 approval_id） | 【统一口径】关注项扩权走提议（17.10），字段改名 |
| status | active / muted / proposed / failing / disabled / expired | 7.1 | |
| muted_until、expires_at、cursor | | 7.1 | |
| health | {last_ok_at, last_error, fail_streak, last_fail_at, degraded} | 7.1、15.3 | 界面映射：degraded → 降级，failing → 失败，disabled → 看不见了（16.2） |
| stats、exp_state、version | | 7.1 | |
| schema_only | bool | 13.4 第 19 条 | http、script 关注项可设；为真时只把通过 schema 校验的数值、布尔、枚举、时间和 ≤ 64 字符的标识交给机器人，不算碰不可信 |
| script_approval_id | string? | 本章 | script 关注项必填，指向 settings.security.approved_scripts 的一项（8.3.7 的 command_ok 共用同一份批准名单） |
| deleted_at | ms? | 本章 | 删除只做标记，30 天内可撤销 |

### 18.9 percepts【一期】

字段全部出自 7.1：percept_id、bot_id、watch_id、kind（change / anomaly / message / due / drive / system）、source_type、occurred_at、observed_at、during_downtime、fingerprint、shape_key、subject_key、summary（≤ 200 字）、excerpt（≤ 300 字）、payload_ref、trust、metrics、factors、salience、repeat_count、disposition（logged / piled / candidate / woken / owner_turn / agenda_fired / dropped）、reason_codes（7.2 R12）、appraisal、queue_id、wake_id、resolves、feedback（二期）、expires_at。二期 peer 感知另带 labels 与 msg_id（12.2.4）。每个机器人每天 ≤ 500 条（7.1 R8）。

### 18.10 drives【一期；二期内驱项】

字段全部出自 7.3：bot_id（主键）、computed_at、budget_left、fatigue、pace_profile、threshold、items[{drive, subject, value, inputs, state: idle / armed / fired / snoozed, snoozed_until, snooze_reason, snoozed_by, last_fired_at, last_percept_id, explain}]，以及 7.2 写的评估快照 think_score、top_reason、pile_sum、pile_count、last_decision、appraised_at、explain。

### 18.11 queue【一期】

字段全部出自 7.5：queue_id、bot_id、status（waiting / granted / merged / expired / dropped / stashed）、variant、reasons（≤ 10 条 reason）、merged_count、priority、think_score、urgent、owner_triggered、enqueued_at、not_before、expires_at、attempts、last_gate、gate_log（≤ 20 条）、wake_id。

reason 的 type 枚举【统一口径】在 7.5 的 12 种之外补 approval_granted（9.6.1 第 7 条，档 0，按主人发起处理）；8.3.3 写的「owner_message」不是理由类型，指主人亲手消息开的原生回合（7.8 R5）；6.3.1 写的「暂停恢复」按 catch_up 处理（7.8 R2）。

gate 代码【统一口径】在 7.5 R2 的 13 道闸之外，把 14.3「仲裁顺序」折进来：maintenance、auth_blocked、global_fault 三道插在 startup 之后、busy 之前；turn_budget_low（本次上限不足 1 万）插在 bot_budget 之后。7.5 R2 是唯一的闸序，14.3 的仲裁顺序不再单独实现；同档排序按 7.5 R4 先比「思考分 + 排队加分」（14.2 quota.wait_bonus），再比本窗口已用比例，再比入队时间。黄灯的放慢一律用 pace_min_eff 从 last_self_wake_at 起算（7.5），14.3 仲裁第 6 条「距上次思考结束不足 2 × pace_min」作废。S4、S5 的写法以 14.3 为准：当日次数到顶（含次数预算）记 S4，当日 token 或窗口次数到顶记 S5，红灯不记 S 码；8.3.4 的 S4、S5 判定句与 16.2 的「预算到顶（S5）」文案按此改。

### 18.12 wakes【一期；continuous 二期】

| 字段 | 类型/枚举 | 出处 | 统一说明 |
|---|---|---|---|
| wake_id | `w_<ULID>` | 7.6 | 兼作投递去重键与 requestId |
| bot_id、session_id、queue_id、reasons、priority、think_score | | 7.6 | |
| variant | regular / light_check / catch_up / trial / reflection / owner_now / native；二期 continuous | 7.6、7.8、8.4.4 | 【统一口径】代码一律 snake_case；骨架的「light check」「catch-up」只是读法 |
| phase | granted / delivered / started / ended / settled | 7.6 R15 | |
| granted_at、delivered_at、started_at、ended_at、settled_at、expires_at、late | | 7.6 | |
| packet | {bytes, sha256, text} | 7.6 | text 14 天后清空 |
| limits、baseline、usage | | 7.6、14.3 | usage.est_units 与 budget_ledger 同口径 |
| guard | {steered_at, steer_cause, nudged_at, cancel_at, owner_joined, last_steps} | 7.6 | |
| end_reason | completed / cancelled / interrupted / error / blocked / max_tokens | 7.6 | 【统一口径】QUOTA 结束的回合记 end_reason = error、error.class = QUOTA：不计回合出错、不走重排阶梯、等红灯恢复后重新入队（14.3）；interrupted 只用于启动对账发现的被打断单（7.6 R17），14.3「记 interrupted 后重新入队」的写法作废 |
| cancel_by | guard / owner / pause / emergency_stop / dead_man | 7.6 | |
| outcome、commit、commit_attempts、commit_missing、process_steps | | 7.6、7.7 | |
| side_effects | {seq, dedupe_key, kind, target, class, status, outbox_id, at}[] | 7.6 R16 | dedupe_key 与 outbox.dedupe_key 相同（17.12 第 9 条） |
| next_think、replay_of | | 7.6 | |
| error | {class, code, raw} | 7.6、14.3 | class 取 14.3 的报错类别 |
| tool_calls | {tool, args_hash, at}[] | 本章 | 17.4.7 本单内工具调用去重用，结算后清空 |

### 18.13 inbox【一期；飞书按钮二期】

| 字段 | 类型/枚举 | 出处 | 统一说明 |
|---|---|---|---|
| item_id | int，记录键 `inb_<n>` | 10.5 | 【统一口径】主人看到的编号一律「#n」；9.5.1 与 16.3 的「A-123」、8.5 的「Q-12」只在机器人看到的唤醒包与工具结果里出现，界面和飞书不用 |
| type | proposal / question / approval / alert | 10.5 | |
| bot_id、origin、priority、title | | 10.5 | origin：bot / gate / health / quota / hub |
| fields | object | 10.3 | 按类型的模板字段 |
| the_one_action | string ≤ 60 字 | 10.5 | 【统一口径】入库校验用 10.5 的长度；16.3 的「≤ 30 字」只作界面截断提示，不再另行校验 |
| options | {key, label, consequence, action_class, primary, is_default, needs_note}[] | 10.5、16.3 | 2–3 个，可另加「改一下」；label ≤ 8 字（10.5；16.3 的 12 字作废）；每张卡恰好一个 primary；接口参数统一叫 option_key（16.0.4 的 option_id 改名） |
| default | {key, text} | 10.5 | |
| evidence | {ref, label, check, verification}[] ≤ 5 | 10.5、16.3 | check：已核对 / 证据缺失 / 外部，未核实 |
| refs | {wake_id, approval_id, alert_id, goal_id, agenda_id, rule_id, handoff_id} | 10.5 | handoff_id 二期 |
| dedupe_key | string | 10.3 | |
| blocking_bots | bot_id[] | 10.5（原名 blocks） | 【统一口径】改名：与提问字段 blocks（bool）撞名 |
| created_at、presented_at、expire_at、digest_reminded_at | | 10.5 | 到期从 presented_at 起算 |
| status | pending / answered / expired / withdrawn / resolved | 10.5 | 【统一口径】以 10.5 为准；界面映射 answered → 已处理、resolved → 已关闭（告警恢复）；16.3 的 resolved（已处理）/ closed 作废 |
| pending_effect | {option_key, note, until}? | 16.3 | 10 秒撤销窗口，计时在宿主；重启时按已生效处理 |
| resolution | {option_key, text, by, via, at} | 10.5 | via：hub_page / feishu_card / feishu_reply / bot_session |
| delivered | {wake_id, at} | 10.5 | |
| push | {state, at, message_id, card_rev} | 10.5 | 单推记录只在这里和 audit kind = push，不在 outbox（16.3「送达情况」的来源按此改） |
| merge_count | int | 16.3 | 告警合并次数 |
| withdrawn_reason、feedback | | 10.5 | |
| from_untrusted | bool | 13.4 第 38 条 | 源自不可信感知的提议 |
| pinned_owner_mention | bool | 9.3 第 6 条 | 「你刚在会话里提到」置顶 |

### 18.14 approvals【一期】

字段出自 9.5.1：approval_id、bot_id、wake_id、inbox_id、origin（tool_call / outbox）、action_class、action_kind、summary、payload、payload_hash、target、who_sees、reversible、undo、why、independent_work、owner_present、status、created_at、expires_at、decided_by、decided_via、decided_at、decision_note、ticket_expires_at、consumed_at、consumed_call_id、outbox_id。跨章增补与统一：

| 字段 | 统一说明 | 出处 |
|---|---|---|
| expires_at | 【统一口径】等于对应收件箱项的 expire_at（从首次呈现起算 24 小时），不是 created_at + 24 小时 | 10.5 |
| decided_via | hub_page / feishu_card（9.5.1 写的 hub_ui 改名，与收件箱 via 一致） | 10.5 |
| if_rejected | ≤ 60 字，不批会怎样 | 10.3、17.12 |
| target_fingerprint | sha256(出站类型 + 规范化目标)，被拒或过期时写，30 天内对全体机器人有效 | 12.3 第 36 条（二期起用） |
| status 增 withdrawn 的来源 | 机器人经 hub_commit.approval_withdraw 撤回 | 9.6.1 第 9 条 |

### 18.15 outbox【一期】

字段出自 9.5.2：outbox_id、bot_id、wake_id、kind（owner_file_write / github_comment；二期 feishu_message / git_push）、target、payload、payload_hash、dedupe_key、bot_ref、class、route（approval / preapproval；二期 class_grant）、approval_id、preapproval_id、who_sees、reversible、undo、why、status（awaiting_approval / queued / executing / done / failed / unknown / rejected / expired / cancelled / undone）、attempts、next_attempt_at、result、undo_until、error_code、error_text、created_at、executed_at、undone_at。跨章增补：summary、if_rejected、independent_work（17.12）；handoff_id（二期，12.3 第 39 条）；bot_ref 缺省取 payload_hash，同一机器人同一 bot_ref 30 天内只执行一次（17.12 第 9 条）。kind = tool_call 不建 outbox 记录，只建审批单（17.12）。

### 18.16 preapprovals【一期 scope = target；class 二期】

字段出自 9.5.3：preapproval_id、bot_id、kind、target_pattern、scope（target / class）、daily_cap、used_today、expires_at、status（active / suspended / revoked / expired）、created_via（hub_ui → 统一写 hub_page / proposal）、note。只有主人能建；只在机器人等级 ≥ L2 时生效。

### 18.17 rules【一期；角色层二期】

字段出自 11.7：rule_id、text、kind、scope、targets、expires_at、origin{quote, said_at, channel, ref}、gate_policy{template, params}、status（draft / active / retired / superseded）、hits、conflicts、review_at、version、created_at、confirmed_at、retired_at、retired_reason、supersedes。【统一口径】kind 存 preference / redline，scope 存 all / role / bot / temp，界面显示偏好、红线、全体、角色、单个、临时。gate_policy.template 取 deny_path / deny_domain / deny_command / require_approval / content_filter（11.9）。rules_meta 在 settings（18.22）。

### 18.18 budget_ledger【一期】

字段全部出自 14.2：entry_id、at、day、window_id、bot_id、initiator（bot / owner / hub）、wake_id、session_id、turn_key、kind（main_loop / compaction / search / title / triage / other；triage 二期）、provider、counts_window、measured、raw_uncached、raw_cache_write、raw_cache_read、raw_output、raw_requests、tokens、requests、peak、cum_snapshot、note。【统一口径】试跑的用量记 initiator = bot、计入该机器人上岗首日的 token 预算，不计每日思考次数（6.2.4、14.3、16.6）；7.8 变体表「试跑只计全局额度」作废。

### 18.19 quota_state【一期】

字段全部出自 14.2：window_id、started_at、ends_at、reset_source、calibrated、capacity_tokens、capacity_requests、ceiling_tokens、ceiling_requests、share_turns、used_tokens_bot、used_tokens_owner、used_tokens_hub、used_requests_bot、used_requests_owner、used_requests_hub、bot_turns_granted、bot_ratio、light、light_changed_at、red_reason、red_until、probe_state、probe_wake_id、probe_failures、ramp_until、quota_errors、error_point_tokens、error_point_requests、error_raw、calibration、low_streak、closed。

### 18.20 alerts【一期】

骨架第 8 节列了这张表，第 10、15、16 章都引用它，但没有一章写字段。本节补全，字段语义取自 10.3「告警」模板与 15.3「告警一览」。

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| alert_id | string `al-<n>` | 编号 | 顺序取号 |
| code | enum | 原因代码 | 15.3 告警一览的 17 个（quota_exhausted、auth_failed、provider_outage、hub_maintenance、scheduler_stalled、all_quarantined、bot_quarantined、component_tripped、stuck_on_approval、turn_stuck、missed_wake、turn_error、writer_held、source_blind、long_silence、backup_failed、downtime_long），加：permission_drift、security_violation、secret_found、skill_tampered、script_changed（第 13 章）；rotation_failed、baseline_too_large（11.6）；preset_unhealthy（5.4.7）；outbox_unknown、outbox_failed（9.8）；feishu_failed（10.7）；owner_action_needed（机器人交账的 owner_action，10.3） |
| priority | P0 / P1 / P2 | 级别 | 按 15.3 与 13.4；所有在岗机器人都被隔离时升为 P0 |
| origin | hub / bot | 谁发起 | bot 指机器人交账里要主人动手修的事 |
| bot_id | string? | 涉及的机器人 | 中心本身为空 |
| object_key | string | 对象 | watch_id、组件名、session_id、outbox_id 等 |
| dedupe_key | string | 去重键 | code + bot_id（或 hub）+ object_key；status = open 时唯一 |
| status | open / resolved | 状态 | 中心感知到恢复即 resolved（骨架「告警恢复即关闭」） |
| opened_at、last_seen_at、resolved_at | ms | 时间 | |
| count | int | 合并次数 | 同一原因 1 小时内合并（骨架第 6 节）；界面显示「同一原因合并了 N 次」 |
| reopen_of | string? | 复发 | 恢复后 24 小时内复发 → 重新打开原记录，不新建（10.3） |
| fields | {what_broke, impact, cause, cause_verification, owner_action: {needed, steps[], minutes}, done_already} | 告警正文 | 10.3 模板字段；写入前过禁写项过滤器；要主人运行的命令只能是脚本路径 |
| evidence_refs | string[] ≤ 5 | 证据包 | 13.5.2 |
| inbox_item_id | int? | 收件箱项 | 要主人动手的、以及 P0，建收件箱项（18.13 统一说明见下） |
| push | {state, at, message_id, via: hub / watchdog} | 单推 | P0 中心飞书失败时写进心跳 p0_pending，由看门狗代发（15.2） |

【统一口径】P0 告警一律进收件箱（没有主人要做的步骤时主按钮「知道了」，16.3 规则 2），其余告警只有要主人动手的才进（10.3 总表）。保留期：恢复后 90 天。

### 18.21 downtime【一期】

字段全部出自 15.2：downtime_id、started_at、ended_at、minutes（≥ 10 才建）、cause（sleep / app_quit / crash / hub_unloaded / unknown）、evidence、detected_by（tick_gap / startup）、interrupted_wakes、catchup_wakes、skipped、to_owner、alert_id、digest_day。

### 18.22 settings【一期】

一个键一条记录，值为对象。各章定义的键不改名，本章补全分组与缺的键。

| 键或前缀 | 内容 | 出处 | 谁能改 |
|---|---|---|---|
| root_dir | 根目录，默认 `~/AgentHub/`；有机器人后锁定 | 5.2.1 | 主人（建第一个机器人前） |
| owner | 主人模型：timezone、quiet_hours、dnd、last_hand_message_at、last_hub_action_at、last_feishu_action_at、reply_latency_p50_h、interests；presence、open_items、feedback_stats、push_used_today 为派生缓存 | 10.2 | quiet_hours、dnd、interests 主人改；其余中心写 |
| outreach.* | push_cap_total（默认 3，0–5）、push_cap_per_bot（默认 2，0–2）、merge_window_min（2）、digest_at（08:30）、digest_channels | 10.4、10.6、16.5 | 主人。【统一口径】范围按 10.4：全体 0–5、每机器人 0–2；16.5 的 0–10、0–3 作废 |
| feishu.* | owner_open_id、lark_cli_path、consecutive_failures、send_rate_per_min（6）；二期 inbound_enabled | 10.7、10.8 | owner_open_id、路径主人改 |
| privacy.* | company_domains、internal_codenames、forbidden_names（禁写项过滤器用；只存本机，不进日志、唤醒包、飞书） | 11.3 | 主人 |
| outbound_allowlist | [{kind, target_pattern, note, added_at, added_via}]，默认空 | 9.5.4 | 主人 |
| security.* | sensitive_paths、work_paths、git_remotes、shell_rules、emergency_stop、installed_reviews（13.3.2），加 approved_scripts：[{script_id, path, interpreter, args, sha256, approved_at, item_id}]（本章补：7.1 的 script 关注项与 8.3.7 的 command_ok 共用的批准名单） | 13.3.2、7.1、8.3.7 | 主人；emergency_stop 中心写 |
| security.emergency_stop | {on, level: pause / security, since, by, reason, cancelled_turns, held_outbox} | 13.3.2 | 【统一口径】全局急停的唯一真源：16.1 的「全部暂停开关」就是 level = pause；bots.pause.source = global 是它的镜像；接口统一 `hub/stop-all {on, level}`（13.8 建议的 hub/emergency-stop 并入） |
| quota.* | 14.2 表全部键 | 14.2 | 主人（份额、灯阈值、起步值）；其余中心 |
| health.* | 15.2 表全部键 | 15.2 | 中心；backup、online_warn 主人可改 |
| engine.* | 骨架第 6 节「全部可配置」里还没有键名的数值：max_bots（6）、concurrency（2，1–4）、release_gap_sec（90，60–600）、pace_min_minutes（sentinel 20、executor 30、researcher 60）、pace_max_hours（48 / 168）、backoff_cap_min（1440）、salience 权重与分档、pile（合计 1.0、48 小时、50 条、封顶 0.85）、threshold（0.60、0.30、节奏档 ±0.10）、dedupe_hours（24）、cooldown_hours（6）、file_debounce_min（2）、daily_think_cap（L0 2 / L1 6 / L2 10 / L3 12）、drive（每日 2 次、暂缓 24–72 小时）、turn_limits（常规 30 步 / 20 分钟 / 6 万；轻复查 5 / 5 / 1.5 万；复盘 20 / 15 / 4 万；收口宽限 3 分钟）、packet_bytes（6144）、agents_md_bytes（根 3072、单个 8192）、watch（20 条、http ≥ 15 分钟、script ≥ 5 分钟与 30 秒超时、自建到期 30 天）、agenda（30 条、self 按时 10 条、30 天）、percept（14 天、每天 500 条）、proposal（门槛 0.6 / 0.5、每周 L1 3 / L2–L3 5、待处理 3、被拒 30 天、撤回 14 天）、question（待处理 2、复用 30 天）、approval（待处理 3、每回合 3）、expiry（提问 72 小时、审批 24 小时、提议 7 天）、rotation（7 天、50%）、probation（7 天、3 天提前） | 骨架第 6 节；各章 | 主人改其中 16.5 列出的项；其余只读显示 |
| new_bot.* | start_autonomy（L1）、default_model（空 = 全局默认，5.3.1） | 16.5 | 主人 |
| rules_meta | rules_version、各生成文件的 {hash, version, generated_at} | 11.7 | 中心 |
| counters.<表名> | 顺序编号计数器 | 本章 18.2 第 4 条 | 中心 |
| acceptance_model | 另一模型验收用的供应商与模型 | 8.8 第 8 条 | 主人；二期 |

### 18.23 audit【一期】

全中心共用的只追加事件表：活动流（第 16 章）、安全记录（第 13 章）、信任账本（第 9 章）、日报全文（第 10 章）、记忆与规矩变更（第 11 章）都写在这里。机器人没有任何读写 audit 的工具（13.4 第 77 条）。

| 字段 | 类型/枚举 | 含义 | 出处 |
|---|---|---|---|
| entry_id | ULID | 主键 | 13.3.3 |
| ts | ms | 发生时间 | 13.3.3 |
| kind | enum，见下表 | 类型 | 13.3.3、16.4 |
| sub | string | 子类型，例如 trust 的 adopted / rejected / violation / misreport / corrected / acceptance_pass / acceptance_fail | 9.5.5 |
| bot_id | string? | 涉及的机器人 | 13.3.3 |
| actor | owner_ui / owner_chat / owner_feishu / bridge / bot / hub | 谁做的 | 13.3.3 |
| actor_ref | string | bot_id、组件名，或飞书 open_id 的哈希 | 13.3.3 |
| decision | deny / approved / rejected / expired / executed / failed / unknown / changed / triggered / released | 结果 | 13.3.3 |
| severity | info / general / severe | 越界级别 | 13.3.3 |
| action、target、reason_code、rule_ref | string | 工具名或出站类型、规范化目标、原因代码、规则出处 | 13.3.3 |
| refs | {session_id, event_seq, wake_id, call_id, approval_id, outbox_id, inbox_id, goal_id, watch_id, agenda_id, rule_id, handoff_id, msg_id} | 证据定位 | 13.3.3、16.4 |
| content_hash | string | 动作参数的 sha256 | 13.3.3 |
| summary | string ≤ 80 字 | 一句话，先过禁写项过滤器 | 13.3.3、16.4 |
| payload | object | 按 kind 的附加数据：owner_change 的 {revision, fields, before, after, via}（5.3.4）；feedback 的 {target, outreach_type, value, note, via}（10.9）；digest 的 {text, from, to, message_id}（10.6）；push 的 {key, message_id, state, retries, error}（10.7）；memory_write 的 {op, entry_id, kind, source, criteria, tags}（11.3） | 各章 |
| flags | red / yellow | 标色原因 | 16.4 |
| undo | {type, undo_id, available_until, how} | 撤销入口 | 16.4、9.7.3 |
| fold | {percepts, turns, tokens, from, to} | 「看了 N 次没事」计数 | 16.4 |
| verification、verdict、cost、importance | | 思考条目的验证层级、验收结果、花费、重要度 | 16.4 |

kind 的完整枚举（【统一口径】合并 9.5.5、10.10 第 7 条、11.13 第 11 条、13.3.3、16.4）：

| kind | 写入方 | 来源章节 |
|---|---|---|
| think、quiet | 交账处理、评估器（每小时汇总） | 16.4 |
| outreach、push、digest、feedback | 沟通 | 10、16.4 |
| decision、action | 收件箱、动作闸、出站执行器 | 9、16.4 |
| self_change、owner_change、lifecycle | 交账处理、名册、界面接口 | 5.3.4、16.4 |
| quota、health | 额度、健康 | 14、15、16.4 |
| memory_write、rule_change | 规矩与记忆 | 11 |
| trust、acceptance | 动作闸、志向与目标 | 9.5.5、8.4.2 |
| gate、permission、stop、scan、install | 动作闸、健康、规矩与记忆 | 13.3.3 |
| idea | 交账处理（new_items 去向 idea、超配额的提议） | 本章；点子池（骨架第 2 节）没有定存放 |
| peer | 同伴总线 | 13.3.3（二期） |

保留期【统一口径】：gate、permission、stop、scan、install、peer、trust、feedback，以及带 severity 或 content_hash 的 decision、action、owner_change、lifecycle，保留 180 天；其余 90 天（16.4 规则 9）。10.10 第 7 条「feedback 长期」改为 180 天：二期反馈校准只用近 30 天、复盘用 4 周。每天清理时写一条按 kind 计数的汇总（13.4 第 79 条）。

### 18.24 二期表【二期】

**handoffs、claims、mailbox**：字段全部出自 12.2.2–12.2.4，本章不重复；保留期 handoffs 关闭后 90 天、mailbox 30 天、claims 在资源登记期间一直保留（12.7）。

**beliefs**（第 7 章信念板未写表，按 17.15 给最小结构）：key（主键 `<bot_id>:<key>`）、bot_id、value、confidence、trust（中心按证据来源定）、evidence_ref、verified_at、ttl_hours、expected、importance、updated_by（hub_rule / bot / owner）、version、updated_at。每个机器人 ≤ 100 条；渲染为只读的 mind/beliefs.md。

**lessons_review**（11.3 第 5 步提到，没有字段）：review_id、bot_id、memory_entry_id、text、source、criteria、status（pending / confirmed / rejected）、asked_in_digest_at、decided_at、decided_via。周一日报请主人逐条「对 / 不对」。

### 18.25 根目录与家目录文件清单【一期；标注的二期】

**根目录 `<root_dir>`（默认 `~/AgentHub/`）**

| 路径 | 谁写 | 谁读 | 上限 | 受保护 | 出处 |
|---|---|---|---|---|---|
| `.git/` | 中心（首次运行 git init；子进程不可用时建空目录作标记）；二期快照提交 | DSH 指令发现（项目根） | — | 是（家目录外，沙箱拒写；读也在敏感路径里） | 5.2.2、11.5、13.3.4 |
| `.gitignore` | 中心 | git | — | 是 | 11.5、15.3（排除 `bots/*/work/`、`.hub-smoke/`、`exports/`、`.trash/`） |
| `AGENTS.md` | 中心（rules 全体规矩渲染） | 所有机器人会话首轮注入 | 3 KB | 是 | 5.2.2、11.8 |
| `.factory/` | 中心（备选起草会话 cwd、越界探针的目标） | 中心 | — | 是（机器人写不进） | 5.6 第 1 条、6.2.8 |
| `.trash/` | 中心（回滚的半成品、清理后的退役家目录、移走的违规指令文件） | 主人 | — | 是 | 5.2.3 第 3 条、6.3.3 |
| `.hub-smoke/` | 中心（冒烟测试会话 cwd） | 中心 | — | 是 | 15.3 冒烟第 3 步 |
| `exports/<日期-时刻>/` | 中心（导出全部表与家目录副本） | 主人 | — | 是 | 16.5 规则 8 |
| `.agents/skills/<bot_id>/` | 中心（只在 V32 不通、且选用第 13 章退路时） | 对应机器人 | 同家目录技能 | 是 | 12-13 原 V24 退路【待验证 V32】 |
| `bots/` | 中心 | — | 本层不得有任何指令文件 | 是 | 5.2.3 第 1 条 |

**家目录 `bots/<bot_id>/`**（【统一口径】数值以第 11 章为准，5.2.2 的 journal 1 KB / 24 KB、playbooks 4 KB / 32 KB、技能 8 KB × 20 作废；mind/goals.md 以 8.5 的 6 KB 为准）

| 路径 | 谁写 | 谁读 | 上限 | 受保护 | 出处 |
|---|---|---|---|---|---|
| `AGENTS.md` | 中心（档案、志向、目标、单个规矩渲染） | 本机器人会话首轮注入 | 8 KB（一期 7 KB），分段上限见 11.8 | 是 | 5.2.2、11.8 |
| `mind/goals.md` | 中心 | 机器人按需 read；主人在详情页看 | 6 KB | 是 | 8.5 第 3 条 |
| `mind/agenda.md` | 中心 | 同上 | 6 KB | 是 | 5.2.2 |
| `mind/watches.md` | 中心 | 同上 | 4 KB | 是 | 5.2.2 |
| `mind/beliefs.md` | 中心 | 同上 | 4 KB | 是 | 二期 |
| `memory/MEMORY.md` | 中心（机器人只能经 hub_lesson_propose）；主人（编辑器或详情页 `bot/file`） | 中心截取进唤醒包；机器人按需 read | 12 KB；单条 ≤ 200 字 | 是（对机器人） | 11.2、11.8。【统一口径】5.2.2「机器人写、不受保护」与 9.2.2「write / edit MEMORY.md = B 类」作废 |
| `memory/journal/YYYY-MM-DD.md` | 中心（每次交账、结果回流、轮换、规矩变更、补课后追加） | 机器人、复盘、主人 | 单条 ≤ 1.5 KB；单日 ≤ 32 KB | 是 | 11.2 |
| `memory/quarantine.md` | 二期：中心 | 机器人、主人 | 8 KB；30 天未核实移出 | 是 | 11.2、11.3。【统一口径】一期工厂只建空文件；5.2.2「一期机器人追加」作废，一期外部说法记在 work/ |
| `playbooks/*.md` | 机器人（B 类）；碰不可信的机器人只能写 work/ 草稿再提议（13.4 第 25 条）；主人 | 机器人 | 单个 8 KB，≤ 20 个，合计 64 KB | 否 | 11.2 |
| `.agents/skills/<名>/` | 机器人自己写的 B 类；外部拿来的 D 类审装；碰不可信的同 playbooks | 见 5.4.3【待验证 V32】 | 单个目录 32 KB，≤ 10 个 | 否 | 11.2 |
| `work/` | 机器人 | 机器人、主人 | 超过 2 GB 在日报提示 | 否 | 5.2.2 |
| `work/trial/` | 机器人（试跑写入） | 工厂 | — | 否 | 6.2.4 |
| `work/handoffs/<handoff_id>/` | 中心复制交接产物 | 接收方机器人 | 10 个文件、10 MB | 机器人只读副本 | 12.3 第 19 条，二期 |
| 任何一层的 `AGENTS.local.md`、`CLAUDE.md`、`CLAUDE.local.md`，子目录新建的 `AGENTS.md` | 不允许存在 | — | — | 禁止创建；巡检移到 `.trash/` | 5.2.3 第 3 条、11.8 |

### 18.26 中心数据目录与系统位置【一期】

`~/.dsh/agent-hub/` 整个目录在内置敏感路径（13.3.4）里：机器人读写都被拒。

| 路径 | 谁写 | 谁读 | 上限与保留 | 出处 |
|---|---|---|---|---|
| `heartbeat.json` | 中心，每 30 秒原子写 | 看门狗 | ≤ 4 KB | 15.2 |
| `backups/YYYY-MM-DD/` | 中心，每天 04:00 后 | 主人（从备份恢复） | 保留 14 份；【统一口径】一期另含各家目录的 MEMORY.md、playbooks/、.agents/skills/ | 15.2、15.3 |
| `watchdog/watchdog.sh`、`state.json`、`ack.json`、`watchdog.log` | 安装时中心写脚本；看门狗写其余 | 中心、看门狗 | 日志 7 天 | 15.2 |
| `undo/<bot_id>/<wake_id>/` | 中心：动作闸放行 B 类写之前快照，唤醒包投递前再按哈希比对补一次 | 中心（撤销） | 【统一口径】撤销期 7 天，副本保留 14 天，每个机器人 ≤ 5 MB（合并 9.7.3 的 `<时间>` 与 14 天、11.5 的 `<wake_id>` 与 7 天；16.4 规则 7「一直可用到被覆盖」改为「7 天内且未被后续变更覆盖」） | 9.7.3、11.5 |
| `outbox-backups/<outbox_id>/` | 出站执行器写前备份 | 中心（撤销） | undo_until 过后 7 天删除 | 9.8 |
| `quarantine/files/` | 中心（每日扫描发现的含密钥文件） | 主人（可还原） | 主人处理前不删 | 13.4 第 26 条 |
| `install-review/<review_id>/` | 中心（审装取件，不运行安装脚本） | 中心、主人 | 装完或拒绝后 30 天删 | 13.5.3。【统一口径】13.4 第 26 条与 13.5.3 原先共用 `quarantine/`，分开存放 |
| `secrets/` | 主人经设置页写（权限 0600） | 中心按名字引用，不读出、不打印 | — | 13.4 第 53 条 |
| `logs/hub-YYYY-MM-DD.log` | 中心各组件（诊断日志：组件错误、熔断、适配层报错原文、健康日志） | 主人、Claude 排障 | 保留 14 天，单日 ≤ 20 MB，写入前过禁写项过滤器 | 本章补（15.3 提到「健康日志」未定存放） |
| `snapshots/<bot_id>/<wake_id>/` | 中心（git 不可用时的快照退路） | 中心 | 每个机器人最近 30 份 | 11.5，二期 |
| `~/.dsh/storages/`（agent_hub 部分） | DSH storageDomain | 中心 | — | evidence 05 C9 |
| `~/.dsh/sessions/` | DSH（会话日志，只追加不删） | 中心冷读（sessionQuery） | 中心不删；靠会话轮换控制单个日志长度 | evidence 05 C5、L10 |
| profile 的组合包补丁（三种角色模板、unattended 权限档） | 插件管理器安装组合包时写 | DSH | 见 19.5 C1–C3 | 5.4.7、5.5.1 |
| `~/Library/LaunchAgents/com.dsh-agent-hub.watchdog.plist` | 主人同意后由中心写 | launchd | 见 19.5 C5 | 15.2 |

中心从不写：`~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md`（骨架第 10 节第 10 条、5.4.3）、`~/.dsh/.credentials.yaml`、lark-cli 与 gh 自己的配置。

### 18.27 流程：每日维护（04:00 后第一个 tick）

1. 每日备份（15.3），连同一期的家目录记忆文件；写完逐表核对。备份失败照常往下做清理，但跳过第 3 步的删除类操作，第二次连续失败告警（backup_failed）。
2. 按 18.3 的保留期清理各表；wakes 先清空 14 天前的 packet.text，再删 90 天前的记录；percepts 删 expires_at 已过的（7.1 R17）。
3. 清理 `undo/`（超过 14 天或超出 5 MB 的最旧副本）、`outbox-backups/`（undo_until 过后 7 天）、`install-review/`（30 天）、`logs/`（14 天）。
4. 扫描 `~/AgentHub` 的密钥类内容，命中移到 `quarantine/files/` 并发 P1（13.4 第 26 条）。
5. 第三方技能哈希校验，变了就停用并发 P1（13.4 第 49 条）。
6. 写 audit 汇总：每张表删除条数、备份结果、扫描结果。

整套维护在 tick 互斥锁外的独立任务里跑，单步失败只记 health，不阻塞意图时钟。

### 18.28 实现

- 建表：一个 open 调用列出全部一期表；表结构手写同形对象加 zod，不 import `@deepseek-ai/dsh-storage-domain`（evidence 05 C9、L7）。
- 升级函数：每张表一个 `upgrade(record) → record`，按 schema_version 逐级升级，单元测试覆盖每一级。
- 取号：`counters.<表名>` 在同一个 tick 内读、加一、写回，再写记录；中心是 agent_hub 的唯一写入进程（evidence 05 L5：没有跨进程写锁），不需要额外锁。
- 操作日志：多表操作的 op_id 用 ULID，steps_done 写在主记录上（例如审批决定写在 approvals，退役写在 bots.retirement），启动对账时扫描 steps_done 不完整的记录续做。
- 诊断日志：Node fs 追加写，经禁写项过滤器；与 audit 分开，audit 只记业务事件。

### 18.29 验收

1. 每张表的 zod schema 与本章字段逐个比对（脚本），无多无少；代码检索不出现 7.1 的 `w_` 关注项前缀、inbox 的 blocks 字段、approvals 的 hub_ui、inbox 的 closed 状态。
2. 手工写坏一条记录后重启：中心照常启动，该条被备份跳过，告警一条，其他记录照常（5.3.5 同项）。
3. 构造一条 schema_version 为旧版本的记录：读时升级并写回，新旧两版的单元测试都通过。
4. 在审批决定、退役、会话轮换三种多表操作的每一步之间各杀一次 DSH：重启后操作从下一步续做，没有半截状态（例如批准票已发但收件箱仍是 pending）。
5. 全部表的时间字段都是毫秒整数；同一时刻在界面、唤醒包、日报里都显示为 +08:00 本地时间。
6. 在 1 秒内并发取 50 个审批编号：无重号；人为让第 10 次写记录失败，第 10 号不再出现。
7. 04:00 维护后各表没有超过保留期的记录；备份目录时间早于清理汇总的时间；一期备份里有各家目录的 MEMORY.md。
8. 18.25 中标「受保护」的每个文件，机器人用 write、edit、bash 重定向各写一次都被拒并记越界；主人用编辑器改 MEMORY.md 不记越界（11.2 规则 2）。
9. 18.25、18.26 的上限：构造超限内容，渲染文件按段落截断并写明截掉什么，记忆写入被拒，日志按日轮转。
10. 中心数据目录 `~/.dsh/agent-hub/` 下的任何文件，机器人读取都被拒（凭据核心以外按一般越界）。

### 18.30 新增建议

1. 骨架第 8 节补 preapprovals（第 9 章新增）与 alerts 的字段（18.20）；点子池写明存 audit kind = idea。
2. 存储约定（18.2）写进骨架第 8 节：domain version 固定为 1、记录级 schema_version、跨表写入的操作日志、时间一律毫秒、顺序编号的计数器。
3. 关注项前缀改 `wt_<ULID>`；inbox 的 blocks 改名 blocking_bots；watches 的 approval_id 改名 proposal_item_id；agenda、inbox 的「来源不可信」用独立字段 from_untrusted。
4. settings 新增 engine.*（骨架第 6 节全部数值的键名）、security.approved_scripts、privacy.*、counters.*。
5. 骨架第 7 节补根目录的 `.factory/`、`.trash/`、`.hub-smoke/`、`exports/`，以及 `~/.dsh/agent-hub/` 下的 `logs/`、`quarantine/files/`、`install-review/`。
6. 一期每日备份带上各家目录的记忆、做事清单和技能文件。
7. audit 的 trust、feedback 与安全条目同样保留 180 天。
8. 骨架第 6 节的「lessons ≤ 12 KB」改为「memory/MEMORY.md ≤ 12 KB」（第 5、11 章新增建议一致）。

## 19. DSH 接口映射与需要主人同意的配置改动

### 19.1 职责

一张表列出中心每个模块用到的 DSH 服务、方法、事件和外部命令，附证据出处与待验证编号，作为适配层（host-adapter）的实现清单和 DSH 升级后的回归清单；统一第 5–16 章各自从 V16 起编的待验证编号；列出所有需要改 DSH 配置、改系统设置或往主人电脑装东西的地方，写清为什么、谁来做、怎么撤销。

### 19.2 接口映射总表

「证据」列写 `docs/design/evidence/` 的文件号与条目：C 是能力清单、L 是限制清单、「可调用接口」指该文件末节「可调用的宿主接口」。所有调用都只经适配层（15.3「适配层」），其他模块里不出现 `ctx.`。

| 中心模块 | DSH 服务、方法或事件 | 用途 | 证据 | 待验证 |
|---|---|---|---|---|
| 适配层 | `ctx.inject` / `ctx.get` 探测服务与事件 | 启动探测、api_fingerprint、缺项降级 | 02 C4（证据行 ctx.inject(['schedule'])） | V52 |
| 适配层（开发期） | `cordis_inspect_list` / `cordis_inspect_query` | 查本版本真实存在的行名、方法、slot、主题 token | 06 逐题回答、可调用接口 | V7、V27、V57 |
| 存储（全部模块） | `ctx.storageDomain.open` / put / get / delete；`domain/changed`（只在本进程） | 全部表 | 05 C9、L5 | V39 |
| 名册 | `ctx.sessionController.list({}, signal)` | 核对会话存在、cwd、agentPreset 投影、parentSessionId | 05 C1、C4 | — |
| 名册、工厂 | `sessionPersistence.stat` | 确认会话已落盘再登记 | 06 逐题回答（dsh-taskboard 用到的宿主 API） | V18 |
| 名册 | `ctx.sessionQuery.filterSessions` | 启动对账：按 cwd 前缀找名册之外的会话 | 05 C7 | — |
| 名册 | `ctx.workspaceRegistry.archivedSessionIds` | 对账已归档会话 | 06 可调用接口 | — |
| 名册、动作闸 | `agent/created`；`ctx.agents.list()` / `get` | 识别机器人 agent 并挂能力；启动补挂；读 idle / running | 01 可调用接口；05 C3 | V25 |
| 工厂 | `ctx.llm.stream` | 起草复述卡与档案草稿 | 03 可调用接口 | V6 |
| 工厂 | `ctx.workspaceRegistry.create` | 家目录登记为侧栏项目 | 01、05 可调用接口 | V12 |
| 工厂、轮换 | `ctx.sessionController.create({workspaceId, agentPreset, sessionId})`、`rename` | 建机器人会话、钉标题省一次标题调用 | 05 C1；01 可调用接口 | V18 |
| 工厂、轮换、健康 | `ctx.permissionPresets.set(session, 'unattended')`；退路 `ctx.approval.setApprovalPolicy(session, 'never')` | 无人值守权限档 | 07 C1、C15；05 C2 | V5 |
| 工厂 | `agentDefaultModel.currentSelection()`；`llm.listModels` | 核对全局默认模型没被改；校验 model_route | 01 可调用接口、L3；06 逐题回答 | — |
| 工厂 | `agent.inject` | 首条「中心通知：会话开场」，不唤醒 | 02 可调用接口；05 C3 | V18 |
| 角色模板 | 组合包 `cordis.patch.yml` 三行 `@deepseek-ai/dsh-agent-preset`；`agentPresets.list` / `resolve`；退路 `ctx.agentPresets.register` | 预装三种角色模板；启动健康检查 | 01 C1–C5、L4；可行性报告第九节 | V7 |
| 角色模板 | `agent-instructions` 配置：instructionFileCandidates、localInstructionFileCandidates、maxBytes | 只认 AGENTS.md | 05 C8；01 C7 | V31、V33 |
| 角色模板 | `skill-filesystem` 配置：includeDefaultRoots、customSkillDirs；`ctx.skills.registerProvider` | 不注入全局技能；按机器人提供它自己的技能 | 01 C8、可调用接口 | V32 |
| 角色模板 | `tool-jobs` 配置 completionDelivery | 后台任务完成不唤醒 | 02 C7、可调用接口 | V30 |
| 按机器人挂载 | `agent.ctx.tools.register` | 注册 hub_* | 06 C5；04 可调用接口 | — |
| 按机器人挂载 | `agent.ctx.tools.restrict({deny})` | 屏蔽工具（17.16） | 07 C5；01 可调用接口 | V5、V27 |
| 动作闸、规矩与记忆 | `agent.ctx.tools.guard(fn)` | 受保护文件、敏感路径、急停只读的硬拒绝 | 07 C5、可调用接口 | V26 |
| 动作闸、回合守卫 | `tools/pre-execute`（prepend，agent 作用域） | 分类、审批、批准票、变体限制、交账后锁定、过期单 | 07 C5 | V10、V27 |
| 动作闸 | `approval/request`（prepend，agent 作用域） | 审批请求立即 rejected | 07 C2、C5 | V10 |
| 按机器人挂载 | `agent.ctx.systemPrompt.section` | agent-hub:identity 段 | 01 可调用接口 | — |
| 按机器人挂载 | `agent/request` | 按机器人改写 provider、model | 07 可调用接口 | V34 |
| 感知总线 | `ctx.fs.watch(target, changed, signal)` | file、log 第一层事件 | 02 C8 | V38 |
| 感知总线、意图时钟、健康 | `ctx.interval` / `ctx.timeout`（cordis-plugin-timer） | 60 秒 tick、30 秒心跳 | 02 C8、L3 核查 | V3 |
| 感知总线 | `session/event`、`agent/status`、`agent/error`、`goal/changed` | session 来源、主人在场、中心自身事件 | 05 C3；03 可调用接口 | V16 |
| 感知总线、交账处理、唤醒器 | `ctx.sessionQuery.filterEvents` | 停机回看；按 callId 核对命令证据；按 wake_id 查投递去重 | 05 C7、L10 | V19、V22 |
| 感知总线 | 宿主进程内 Node fetch（不是 DSH 接口，不用模型的 web_fetch） | http 关注项 | — | V37 |
| 感知总线、动作闸、沟通、健康 | 宿主子进程：script、git、gh、lark-cli、pmset、launchctl | 门控脚本、github_comment、飞书出站、环境检测、看门狗加载 | — | V2 |
| 调度器、唤醒器 | `ctx.sessionController.resolveAgent(sessionId)` | 拿存活 agent，冷会话按记录的 preset 恢复 | 02 C2；04 C10 | — |
| 唤醒器 | `agent.followup({content, source: {kind: 'agent-hub'}})`；`ctx.sessions.flush()` | 投递唤醒包 | 02 可调用接口；03 C6；05 C3 | V1、V18 |
| 唤醒器（V1 不通时） | `ctx.sessionController.prompt({sessionId, requestId: wake_id, mode: 'queue', content}, signal)` | 一句 user 来源的短触发 | 05 C1 | V1、V19 |
| 调度器、回合守卫、暂停 | `agent/pre-step` 返回 `{kind: 'reject'}`（prepend，机器人作用域；不行则宿主层按 session 过滤） | 安全网、暂停门、急停、计步 | 05 C3；02 核查（ArchivedSessionGate） | V11、V17 |
| 回合守卫 | `agent.steer` | 收口、缺交账提醒、过期单提示 | 02 可调用接口；05 C3 | — |
| 回合守卫、暂停、急停、健康 | `ctx.sessionController.cancel({sessionId})`（keepInbox） | 取消回合 | 05 C1；07 可调用接口 | V29 |
| 回合守卫 | `agent/turn-stopping` | 缺交账提醒 | 05 C3；03 核查 | V21 |
| 回合守卫、交账处理、额度、健康 | `session/event`：turn/end（reason）、compaction/summary、tool/call、llm/retry、approval/asked、approval/decided、permission/preset、sandbox/mode、approval/policy | 结束判定、计量、卡在审批、权限漂移 | 05 C3、L6；07 C10 | V8、V20、V49 |
| 回合守卫、额度、规矩与记忆 | `ctx.sessionController.projections({sessionId}, signal)`：tokenUsage、sessionStats、contextPressure、inbox | 计量、上下文占用轮换、投递去重 | 05 C4；07 C4 | V8、V23、V24 |
| 额度 | `ctx.tokenMeter.measure(session)` | 补充计量 | 07 可调用接口 | — |
| 额度 | `agent/request-error`（prepend） | 抢在 llm-retry 之前识别额度报错并终止 | 07 可调用接口、C13 | V4、V35 |
| 额度 | provider 的 retryPolicy（只读） | 发现 always 就进 maintenance | 07 C13、可调用接口 | V36 |
| 回合守卫、急停 | `ctx.subagents.listDescendants`、`interrupt`；`ctx.jobs`；`ctx.agentTeams.listMembers`、`interrupt` | 交账后与急停时终止子代理、后台任务、队友 | 04 可调用接口；02 C7 | V29 |
| 调度器（安全网） | `ctx.schedule.catalog()`，只读 | 列出机器人会话上的残留提醒，供主人删除 | 02 C4 | — |
| 规矩与记忆、退役、轮换 | `ctx.workspaceRegistry.archiveSession(id, {stopActivity: true})` | 归档旧会话；归档门禁挡住迟到投递 | 01、07 可调用接口；02 核查 | — |
| 健康 | `workspace/session-activity`（贡献条目） | 退出确认框列出在思考或排队的机器人 | 02 可调用接口 | V51 |
| 健康 | 组合包 package.json 顶层 `engines.dsh` | 版本闸（不兼容版本不加载） | 06 C9 | V52 |
| 健康 | 插件 Config 字段 `.volatile()` | 改参数不整行重新挂载 | 06 核查 C3①、C7（d） | — |
| 沟通 | 子进程 `lark-cli im +messages-send --as bot …`、`im messages patch` | 单推、日报、卡片回写 | 07 L5（DSH 没有 IM 推送） | V2、V13、V43 |
| 界面接口 | `ctx.connection.fetch.register({path, methods, requestBody, fetch})` | 读写接口与 SSE，只放行主人 | 05 C10；06 核查员补充 | V9、V54 |
| 界面接口（SSE 退路） | `ctx.webServer.register` + `ctx.connection.requestRejection` | 只用于 events 一条 | 06 C6、L5、核查员补充 | V54 |
| 界面半边 | `ctx.slots.inject` / `register` / `spec`：sidebar.panellist、main、plugins.bundle.config | 入口、中心页、插件页设置入口 | 06 C1、可调用接口 | V9 |
| 界面半边 | `ctx.layout.selectPanel` | 打开中心页 | 06 可调用接口 | — |
| 界面半边 | `ctx.sidebarRightTabs.register`、`ctx.sidebarRight.openTab`；slot sidebar.right.pane.tab | 机器人 tab | 06 C2、可调用接口 | V56 |
| 界面半边 | slot conversation.session.header.utilities、sidebar.session.row.leading | 会话页头与会话行标记 | 06 C2、可调用接口 | V12、V56 |
| 界面半边 | slot sidebar.toggle.badge | 收件箱角标 | 07 可调用接口 | V55 |
| 界面半边 | `window.__ModuleLoader__.load`；package.json 的 dsh.client、exports；`--dsw-alias-*` 主题 token | 客户端打包与主题 | 06 可调用接口、L6 | V57 |
| 界面半边 | 客户端「打开指定会话」接口 | 「打开它的会话」「在会话里看这一轮」 | — | V53 |
| 看门狗（DSH 之外） | launchd LaunchAgent、pgrep、plutil、osascript、lark-cli | 中心停摆、DSH 退出或崩溃时告警 | 02 L1–L3；05 L11 | V13、V50 |
| 二期：连续推进 | `ctx.goals.get` / `create` / `block` / `complete` / `clear` / `resume`；`goal/changed`、`goal/activation-changed` | 有限轮数连续推进 | 03 C1–C3、C7、L1 | V40 |
| 二期：分诊、另一模型验收、日报首行 | `ctx.llm.stream` | 不开会话的模型调用 | 03 可调用接口 | V6 |
| 二期：飞书入站 | 子进程 `lark-cli event consume`；`ctx.sessionController.prompt`（@名字转投） | 卡片按钮、回复、口令 | 05 C1 | V16、V44 |
| 二期：受限 shell | dsh-sandbox-local 的 runnerCommand | 碰不可信又要跑代码 | 07 L2 | V45 |
| 二期：看板镜像 | dsh-taskboard 只读写入 | 协作进度镜像 | 06 L8 | V46 |

### 19.3 刻意不用的接口

| 接口 | 为什么不用 | 出处 |
|---|---|---|
| `ctx.schedule.create`、schedule_* 工具 | 到点直接开模型回合、绕过评估，就是定时唤醒；不能暂停、失败不重试 | 骨架第 10 节第 1 条；02 C4、L5 |
| `ctx.agents.create` / `resume` 持有机器人会话 | 会话归插件所有，插件一重载就把机器人当轮取消；唯一例外是 V34 退路里建会话那一刻用、首条消息落盘后立即释放 | 06 核查 C3①；可行性报告第九节；5.5.3 |
| `session.selectModel`、界面 `/model` | 会把这次选择存成全局默认模型 | 01 L3；07 L6 |
| `/permission` 命令、`ctx.approval.setPolicy` | 会给模型注入「策略已由用户更改」 | 07 可调用接口；5.5.1 |
| `sessionController.prompt` 作为常规投递 | 来源固定记成 user，等于冒充主人 | 04 L9；可行性报告第九节 |
| `ctx.webServer` 承载写接口 | 不鉴权、不查来源，本机任何程序都能调 | 06 L5 |
| 往会话日志追加自定义事件类型 | 会话从此打不开 | 06 L10 |
| 监听 system-prompt/assemble | 官方不建议，升级易坏 | 06 L10 |
| 写 `~/.dsh/AGENTS.md` | 会进入主人所有普通会话 | 骨架第 10 节第 10 条 |
| Agent Teams 作机器人载体；中心开启「智能体团队」组合包 | 队友共用总管的人设、模型、目录；开启后每个顶层会话每次请求多付固定 token | 04 C3–C6、C12；12.5.4 |
| 模型侧 goal 工具（create_goal、update_goal、/goal） | 目标轮次由中心控制 | 03 C6；8.4.4 |
| 进程级 uncaughtException / unhandledRejection 监听 | 改变宿主对所有插件的失败处理 | 15.3 崩溃安全 |
| 运行时 import `@deepseek-ai/dsh-*` | 遮蔽内置实例，每次工具调用都会崩 | 05 L7 |
| Auto review（机器人角色模板不开） | 每次工具调用多一次模型请求且不计用量；被拒转人工审批 | 07 C11、L10；14.5 |
| dsh-taskboard 作协作骨架或给机器人用 | 卡片可设完全访问、自带定时，绕过动作闸与额度闸 | 12.3 第 54–55 条 |
| `ctx.deepseekAccount.getBalance()` 作额度来源 | 只能查 DeepSeek 钱包，查不了 GLM 额度 | 07 可调用接口；14.5 |

### 19.4 待验证编号统一表

第 5–16 章各自从 V16 起编号，同号在不同章含义不同（例如 V16 在八个文件里分别指技能注册、http 取数、缺交账提醒、AGENTS.md 刷新、主人消息区分、子代理覆盖、缓存读取计费、客户端打开会话）。下表把它们去重后统一编为 V16–V57；V1–V15 仍是骨架第 12 节的原义。各章正文按「原编号」列替换，第 21 章待验证清单按本表补齐。

| 编号 | 要验证什么 | 各章原编号 | 不通过的退路 | 分期 |
|---|---|---|---|---|
| V16 | 主人在界面手打的消息，能否与控制桥、插件经 sessionController.prompt 发出的消息区分（都是 user + rpcId） | 07a V18；10-11 V16；12-13 V23 | 中心只排除自己登记的 requestId；控制桥的消息按主人在场计，但不给审批和改安全设置的权力 | 一期 |
| V17 | agent/pre-step 能否读到本步认领消息的 source 与正文，据此只放行持单回合 | 07b V17 | 用 session/event 的 user/message 判定；宿主层注册按 session 过滤 | 一期 |
| V18 | 新会话首条消息：agent.inject「会话开场」能否被接受并落盘；followup 首投后是否要 sessions.flush；「被接受」以什么信号为准；先 rename 能否省掉标题调用 | 05-06 V18；10-11 V19；14 V19（标题部分） | 首投改为试跑唤醒（followup）；接受一次标题调用，按 2,000 token 估算记账 | 一期 |
| V19 | 投递去重：filterEvents 按 wake_id 字面扫描的耗时；prompt 的 requestId 去重 | 07b V20 | 投递前记 projections 的 asOfSeq，只扫其后的事件 | 一期 |
| V20 | turn/end 的 reason 取值能否映射到 end_reason 六种 | 07b V18 | 结合 agent/error 与中心自己的取消记录推断 | 一期 |
| V21 | agent/turn-stopping 里 steer 能否让回合继续以补交账 | 07b V16 | 回合守卫用计时器 + steer / cancel（适配层可降级项） | 一期 |
| V22 | sessionQuery 冷读：停机期间被关注会话的 turn/end、agent/error 回看；按 callId 取 tool/call 与 tool/result 核对证据 | 07a V19；08 V18 | 只看 projections 最新状态；command 类证据降为佐证，不能单独撑起 progress | 一期 |
| V23 | contextPressure 投影的口径（比例或 token）与冷会话可读性 | 10-11 V20 | 用 tokenUsage 与模型窗口估算；仍不行只按满 7 天轮换 | 一期 |
| V24 | GLM 计额口径：缓存读取是否计入、计额单位、5 小时窗口如何起算、有无周额度层 | 14 V16；07b V19（cache_read 部分） | 缓存读取权重 0，token 与请求数两维并行校准（已设计） | 一期 |
| V25 | 子代理覆盖：agent/created 是否对子代理触发；挂在机器人 agent.ctx 上的 restrict 与钩子是否作用于子代理；宿主层 tools/pre-execute 能否沿 parentSessionId 找到机器人 | 05-06 V19；12-13 V16 | standard 档也不给 subagent | 一期 |
| V26 | tools.guard 回调能否拿到 write、edit 的目标路径和 bash 全文；持有批准票时 guard 仍会再判 | 10-11 V21；08-09 V20 | 改在 tools/pre-execute 拒绝，并保留哈希巡检 | 一期 |
| V27 | 机器人实际继承的工具全清单、带路径参数的工具与参数名；pre-execute 能否看到 write、edit 的完整内容和 workflow、subagent 的关键参数 | 08-09 V21（及 9.10 第 4 条的 V19）；12-13 V22；12-13 V18（参数可见部分） | tools_allowed 只留已识别路径参数的工具 | 一期 |
| V28 | 角色模板里 workflow-ptc 的 maxConcurrentAgents、maxTotalAgents 能否生效 | 12-13 V18 | standard 档不给 workflow | 二期 |
| V29 | 能否枚举并终止机器人名下的子代理与后台任务；sessionController.cancel 是否连带 | 12-13 V19 | 急停与隔离时用 archiveSession(stopActivity) 兜底，解除时轮换会话 | 一期 |
| V30 | tool-jobs 的 completionDelivery 能否配成完成不唤醒 | 05-06 V20 | 执行型也去掉 tool-jobs；job 完成唤醒由安全网拒绝（7.5 R16） | 一期 |
| V31 | work/ 下第三方仓库里的 AGENTS.md 会不会被当作指令追加注入 | 05-06 V21 | 克隆后改名 *.upstream.md（执行型清单已写）；巡检移走 | 一期 |
| V32 | includeDefaultRoots: false 后看不到全局技能；家目录 .agents/skills 能否被发现；skills.registerProvider 能否按 agent 作用域提供 | 05-06 V16；10-11 V18；12-13 V24 | 家目录 AGENTS.md「做事清单与技能」索引 + 按路径 read（11.8）为唯一退路 | 一期 |
| V33 | 中心改写 AGENTS.md 后，在跑会话何时刷新 | 08 V16；10-11 V17 | 唤醒包带变更差量并要求先 read（已设计） | 一期 |
| V34 | 按机器人路由模型：agent/request 改写 provider、model；或建会话时用 agents.create 指定模型后释放句柄 | 05-06 V17 | 全部机器人用全局默认模型，档案 model_route 只读显示 | 一期 |
| V35 | agent/request-error 返回终止能否阻止 llm-retry；上下文超长的错误码 | 14 V18 | 事后从 agent/error、turn/end 分类（QUOTA 可能先被重试 5 次） | 一期 |
| V36 | 能否读取机器人所用模型路由的 retryPolicy | 14 V20 | 常开环境清单列为「待你确认」 | 一期 |
| V37 | 宿主进程内用 Node 全局 fetch 发 http 关注项请求 | 07a V16 | 子进程 curl（依赖 V2）；再不行一期关闭 http 来源 | 一期 |
| V38 | fs.watch 在追加写、原子替换、目录删除时的事件表现与 6 × 20 条的句柄开销 | 07a V17 | 全部改为每个 tick 做 stat 扫描 | 一期 |
| V39 | storageDomain 约 2 万条记录时的打开耗时与内存；不改 version 能否新增表 | 07a V21；本章 18.2 | 降低每机器人每日感知条数或保留期；新增表走新 domain 名 | 一期 |
| V40 | ctx.goals.block 是否取消在跑回合；goal-round-driver 挂在宿主层还是 preset | 08 V17 | 不做连续推进 | 二期 |
| V41 | gh api 发评论，及按隐藏标记查重 | 08-09 V22 | github_comment 一期不开，只出草稿 | 一期 |
| V42 | 宿主进程直接写主人目录（owner_file_write）不受机器人沙箱限制，原子改名与读回 | 08-09 V23 | owner_file_write 一期不开，只出草稿 | 一期 |
| V43 | lark-cli 交互卡片发送与 patch 回写、折叠面板在手机上的显示 | 10-11 V22 | 日报改 markdown 富文本；卡片只发不改 | 一期 |
| V44 | lark-cli event consume 作为常驻子进程的稳定性 | 10-11 V23；07a V20 | 每 2 分钟拉私聊消息，按钮改引用回复 | 二期 |
| V45 | 受限 shell：runnerCommand 包装器翻译成带 deny network 的 sandbox-exec，主人会话不受影响 | 12-13 V17 | 维持「有 shell 不碰不可信」 | 二期 |
| V46 | dsh-taskboard 只读镜像 | 12-13 V20 | 不做镜像 | 二期 |
| V47 | 命令行工具令牌的实际存放路径；ctx.credentials 能否枚举 | 12-13 V21 | `~/.config/**` 整体拦截；不做原值比对 | 一期 |
| V48 | GLM Coding Plan 高峰时段与非高峰折算 | 14 V17 | 时段系数恒为 1.0 | 二期 |
| V49 | web_search 不进 tokenUsage、不占 GLM 窗口；标题生成调用是否入账 | 14 V19 | 按估算记账（搜索 1 万 / 次、标题 2,000 / 次） | 一期 |
| V50 | 看门狗识别 DSH 主进程与宿主子进程的方法；二期结束并重开不丢数据 | 15 V21 | 只看心跳新旧与 state，不区分崩溃弹窗 | 一期 |
| V51 | 往 workspace/session-activity 贡献条目，让退出确认框列出机器人 | 15 V22 | 不提示，退出后由看门狗报 | 一期 |
| V52 | DSH 版本号的取法；engines.dsh 对预发布版本的范围匹配 | 15 V23 | 靠 api_fingerprint 发现升级；版本范围改为逐个列出已验证版本 | 一期 |
| V53 | 客户端打开指定会话（并定位到某一轮）的接口 | 16 V16 | 显示一行「在左侧栏找…」指引 | 一期 |
| V54 | connection.fetch.register 能否返回 SSE 长连接流 | 16 V17 | events 一条改用 webServer + requestRejection；再不行 10 秒轮询 changes | 一期 |
| V55 | sidebar.toggle.badge 的显示位置与时机；sidebar.panellist 入口能否带数字 | 16 V18 | 只在中心页内显示待处理数 | 一期 |
| V56 | 会话级 slot 组件如何拿到当前会话 id；右侧栏 tab 能否只在机器人会话出现 | 16 V19 | 普通会话里显示一行「这不是机器人的会话」 | 一期 |
| V57 | --dsw-alias-* 主题 token 的实际名称与亮暗两套是否齐全 | 16 V20 | 用最接近的 token；橙色用 warning 加粗描边并写文字 | 一期 |

### 19.5 需要主人同意的配置改动、系统设置与安装

中心不替主人改任何系统设置和 DSH 全局设置。下表每一项都要主人点头或亲手操作；设置页「安装与常开环境」逐项显示状态（19.8）。

| 编号 | 改动 | 改哪里 | 为什么需要 | 谁来操作、何时 | 怎么撤销 | 分期 | 相关 |
|---|---|---|---|---|---|---|---|
| C1 | 安装中心组合包 dsh-agent-hub（宿主半边 + 界面半边） | 主人 profile 的组合包清单（插件页「添加插件」，或本地 link 安装） | 中心本体 | 主人在插件页添加；经 plugin_manager 安装需要完全访问或逐次批准（06 C7、01 L1）；首次与每次升级 | 按 19.6 第 6 条的卸载顺序：先急停、退役或归档全部机器人，再在插件页移除；`~/.dsh/storages`、`~/AgentHub`、`~/.dsh/agent-hub` 的数据不自动删 | 一期 | V7、V52 |
| C2 | 预装三种角色模板 | 组合包补丁里三行 dsh-agent-preset（agent-hub-researcher / executor / sentinel） | 机器人的职业能力；不在运行时建 preset | 随 C1；升级按 5.4.6 第 6 条「先注册新代际或新 id、迁移会话、最后卸旧」 | 不能单独撤：preset id 删掉后绑定它的会话恢复失败（01 L4）；要撤先退役全部用该模板的机器人 | 一期 | V7 |
| C3 | 新增无人值守权限档 unattended（workspace-write + never） | profile 的 permission.presets（随组合包补丁写入） | 防回合挂在审批面板上无限等待（07 L1） | 随 C1，主人在安装确认时同意；V5 不通时不改配置，改为逐会话 permissionPresets.set + setApprovalPolicy | 随组合包移除；移除或被「禁用第三方插件并重启」摘掉后，中心进 maintenance，不放行任何机器人（15.3 崩溃安全） | 一期 | V5 |
| C4 | 根目录 `~/AgentHub/` 与其 `.git` | 主人家目录下新建目录；git init | 机器人的家与写入边界；指令链的项目根 | 中心在首次运行、主人于设置页确认路径后创建；有机器人后路径锁定 | 退役全部机器人后由主人手动删除；中心从不删除 | 一期 | V2 |
| C5 | 看门狗 | `~/Library/LaunchAgents/com.dsh-agent-hub.watchdog.plist` + `~/.dsh/agent-hub/watchdog/` | DSH 退出、崩溃，或中心被停用时，主人仍能收到告警（02 L1–L3） | 主人在设置页点「安装看门狗」，看过要写的 3 个文件后确认；V2 可行时由中心执行 launchctl 加载，否则主人运行一条只含脚本路径的命令 | 设置页「卸载看门狗」（卸载 launchd 任务、删 plist 与脚本），或主人运行同目录下的卸载脚本 | 一期（只告警） | V2、V13、V50 |
| C6 | 飞书中心机器人 | 飞书开放平台建应用机器人；应用凭据存在 lark-cli 自己的配置里；中心设置页填 owner_open_id | 单推与日报 | 主人在飞书开放平台与 lark-cli 中配置，在设置页填 open_id 并点「测试发送」 | 设置页解绑（清空 owner_open_id，单推降为中心角标，日报只在中心页）；凭据由主人从 lark-cli 配置里删除 | 一期 | V13、V43 |
| C7 | 飞书入站事件 | 飞书开发者后台开启卡片回调、私聊消息事件 | 卡片按钮、引用回复、口令 | 主人 | 后台关闭这两个事件 | 二期 | V44 |
| C8 | DSH 加入登录项 | 系统设置 → 通用 → 登录项 | 开机后中心能自动运行（02 L2：没有开机自启） | 主人；中心检测不了，由主人勾选 | 同处移除 | 一期（建议） | — |
| C9 | 防休眠 | 系统设置 → 电池 → 选项（接电源时防止自动睡眠）；或 caffeinate；不合盖 | 电脑睡着时全部机器人停摆 | 主人；中心只用 pmset 检测并提示 | 改回原设置 | 一期（建议） | V2 |
| C10 | DeepSeek 搜索凭据 DEEPSEEK_API_KEY | DSH 凭据来源（`.credentials.yaml` 或环境变量） | 用 GLM 的会话做 web_search 必须要它；花的是 DeepSeek 的钱（14.5） | 主人决定是否配置；不配就不给机器人 web_search，试跑报告写明「网页搜索缺凭据」 | 删除该凭据 | 一期（可选） | V49 |
| C11 | 机器人所用模型路由的 retryPolicy 保持 normal | DSH 设置 → 模型 | always 会无限重试，连 QUOTA 也重试 | 主人确认；中心读得到就自动核对 | — | 一期 | V36 |
| C12 | gh 登录（github_comment 以主人的 GitHub 账号发出） | gh 自己的令牌配置（`gh auth login`） | github_comment 出站由中心子进程调用 gh | 主人在终端登录，并在出站白名单里加仓库 | `gh auth logout`；白名单删除仓库 | 一期（用到时） | V41、V47 |
| C13 | 核实 GLM 订阅条款 | 无改动；不允许时改用按量计费 API | 全天自动调用是否合规（骨架 V14） | 主人在 M0 查条款；改按量 API 要主人书面批准预算 | — | 一期 | V14 |
| C14 | 主人的全局指令文件 | `~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md` | 它们去不掉，会进入每个机器人的首轮请求（5.4.3） | 主人决定是否精简；中心只检测存在与大小，不读内容、不改 | — | 一期 | — |
| C15 | 门控脚本在本机运行 | 无 DSH 配置改动；批准记录在 settings.security.approved_scripts | 在主人电脑上跑代码 | 主人在向导或收件箱逐个勾选批准，绑定 sha256 | 撤销批准：对应关注项立即停用 | 一期 | V2 |
| C16 | 给机器人接 MCP 服务 | dsh-mcp-client 配置行（宿主层或角色模板）+ 审装报告 | 让机器人用外部服务 | 主人批准 D 类审批单后，在插件页或补丁里落地，再把工具名加进 mcp_allow | 删配置行，从 mcp_allow 移除 | 一期默认无；按需 | — |
| C17 | 第三方技能审装 | 目标机器人的技能目录 | 用第三方技能 | 主人批准 D 类审批单（13.5.3） | 停用（SKILL.md 改名 SKILL.md.disabled）或删除 | 一期（按需） | V32 |
| C18 | 受限 shell | dsh-sandbox-local 的 runnerCommand | 碰不可信又要跑代码的机器人 | 主人同意后先在测试 profile 验证再落地 | 删除该配置 | 二期 | V45 |
| C19 | 看门狗自动重启 DSH | 看门狗脚本开关 | DSH 卡死或崩溃停在弹窗时自动恢复 | 主人在设置页开启 | 关闭开关 | 二期 | V50 |
| C20 | 主人在场扩展 | 飞书日历授权（lark-cli）；客户端上报系统空闲 | 单推避开会议与离开时段 | 主人逐项开启 | 关闭、撤销授权 | 二期 | V13 |
| C21 | 常开主机 | Mac mini，或 dsh web + launchd | 24 小时在线 | 主人 | — | 三期 | — |

### 19.6 规则

1. 中心从不自己改系统设置、DSH 全局设置（模型、子智能体并行数与深度、插件开关、智能体团队）和主人的全局文件；只检测、提示、给最短路径（15.3「常开环境与在线率」、16.5 规则 7）。
2. 改 DSH 配置的只有 C1–C3（随组合包安装，主人在安装时确认）与 C16、C18（主人自己落地）。中心运行中不调用 plugin_manager、configEditor。
3. 凭据一律留在各工具自己的配置里（lark-cli、gh、DSH 凭据来源）；中心不读、不存、不打印，只检查「是否已设置」与长度（13.4 第 53–54 条）。中心需要保存的非凭据配置（owner_open_id、lark-cli 路径）存 settings。
4. 要主人运行的命令只含一个脚本路径，不带引号、管道、通配符；脚本由中心生成在 `~/.dsh/agent-hub/` 下（15.3 看门狗第 1 条、10.3 告警）。
5. 每一项的状态变化（完成、撤销、主人勾选）写 audit（kind = owner_change），设置页显示最近一次检测或勾选的时间。
6. 卸载顺序固定：全局急停 → 退役或归档全部机器人 → 卸载看门狗 → 插件页移除组合包。顺序反过来会让机器人会话报 agent-preset/not-found（01 L4），且无人值守权限档先消失。
7. DSH 升级不需要主人改配置；升级后中心自检（15.3 冒烟测试），失败只告警并保持 maintenance。

### 19.7 流程：首次运行

1. 主人在插件页添加组合包（C1–C3）。
2. 中心 apply：服务探测 → 无人值守权限档存在（不存在 → maintenance，设置页置顶「需要恢复无人值守权限档」）→ 打开存储 → 写预置全体守则 r-001 至 r-012（11.10）→ 冒烟测试（15.3）。
3. 设置页「首次运行」清单按顺序出现，可以跳过的都标「可跳过」：确认根目录（C4，确认后建目录、git init、生成根 AGENTS.md）→ 填公司工作目录、公司域名与禁写人名单（13.3.2、11.3，可跳过，跳过时设置页常驻提醒）→ 飞书绑定与测试发送（C6，可跳过）→ 看门狗（C5，可跳过）→ 常开环境（C8、C9、C11、C14 的检测与勾选）→ 可选的 C10、C12。
4. 清单走完（或主人点「先这样」）后，总览显示空态与新建入口（16.1 规则 13）。

### 19.8 实现

设置页新增「安装与常开环境」分区（合并 16.5 的健康区第 2 项与常开环境指引），每项一行：名字、状态、为什么、最短路径、撤销办法、最近检测时间。检测方法：

| 项 | 怎么检测 |
|---|---|
| C1、C2 | 中心自身版本；`agentPresets.list` 里三个 id 存在且无 broken 诊断 |
| C3 | 适配层探测无人值守档存在；冒烟测试第 3 步读回 |
| C4 | 根目录与 `.git` 存在 |
| C5 | 看门狗 `state.json` 的 last_run_at 在 6 分钟内 |
| C6 | 最近一次测试发送或单推成功的时间 |
| C8、C13，以及其他检测不了的项 | 主人勾选，记勾选时间 |
| C9 | `pmset -g` 子进程【待验证 V2】 |
| C11 | 读 retryPolicy【待验证 V36】 |
| C12 | `gh auth status` 子进程【待验证 V2】 |
| C14 | 两个文件是否存在、大小，不读内容 |

### 19.9 验收

1. 适配层源码之外搜不到 `ctx.`（apply 入口除外）；19.2 表里每一行在适配层都有对应函数，且每个函数带 try/catch 与超时（15.3）。
2. 每次 DSH 升级后的冒烟测试覆盖 19.2 中标「一期」的必需项；缺任一必需项时中心进 maintenance 并告警，缺可降级项时降级运行。
3. 代码检索：不出现 19.3 列出的接口（V34 退路分支里的 `ctx.agents.create` 除外，且只在适配层登记的那一处）。
4. 各章正文与第 21 章里出现的 V 编号都能在 19.4 找到，且同一编号含义一致；V16 之后没有重号。
5. 未经主人在设置页确认，`~/Library/LaunchAgents/` 里没有看门狗 plist；未经主人确认路径，`~/AgentHub/` 不被创建。
6. 设置页「安装与常开环境」逐项状态与实际一致：拔掉电源、关掉防休眠、卸载看门狗、解绑飞书，各自在下一次检测后变为未完成。
7. 中心存储、日志、audit 里搜不到飞书、gh、DeepSeek 的任何凭据原文。
8. 按 19.6 第 6 条的顺序卸载：全部机器人已退役，插件页移除后重启 DSH 没有 agent-preset/not-found 报错；数据目录仍在。

### 19.10 新增建议

1. 19.4 的统一编号 V16–V57 写进第 21 章，并作为各章唯一的引用口径；新增待验证项从 V58 起编。
2. 设置页增加「安装与常开环境」分区与「首次运行」清单（19.7、19.8），由第 16 章补界面细节。
3. 19.2 作为每次 DSH 升级后的回归清单：冒烟测试之外，逐行用 cordis_inspect_query 核对方法与事件仍在，结果写进 api_fingerprint。
4. 把 gh 登录（C12）写进开源维护员等用到 github_comment 的机器人的试跑预检：未登录时试跑报告给出最短路径。
