## 8. 志向与目标

### 8.1 职责

给每个机器人一个长期的「为什么」（志向，永远不会完成）和当期可验证的「做到什么算数」（目标，有边界、有周期、有验收方）。本章定义 aspirations 与 goals 两张表、开放式志向拆成周期目标的写法、停止条件 S1–S6、耐心期、进展记录与验证层级、验收、谁能建改放弃、周期结束的处理、二期有限轮数连续推进，以及目标在 AGENTS.md 与 mind/goals.md 里的样子。唤醒、内驱公式、交账协议和复盘回合本身见第 7 章。

### 8.2 数据

#### 8.2.1 aspirations（志向）【一期】

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| aspiration_id | string | 编号 | `asp-<bot_id>-<序号>`，不复用 |
| bot_id | string | 所属机器人 | 必填；每个机器人 status=active 的志向 1–3 个 |
| statement | string | 一句话志向 | ≤ 80 字；写方向，不写终态 |
| why | string | 主人原意（原话或出处） | ≤ 300 字；来自工厂的一句话描述或主人在界面填写 |
| success_signals | string[] | 进展顺利时能观察到的信号 | 1–5 条，每条 ≤ 80 字 |
| boundaries | string[] | 不做什么 | 0–5 条，每条 ≤ 80 字；渲染进 AGENTS.md，复盘时逐条核对 |
| review_at | datetime | 下次复查日期 | 默认创建或上次复查后 30 天 |
| status | enum: active / paused / archived | 状态 | 见 8.3.1 第 6 条 |
| created_via | enum: factory / owner_ui / proposal | 怎么来的 | proposal 指主人确认了一张志向提议（含主人在会话里口述后生成的预填提议） |
| source_ref | string | 出处 | 工厂草稿编号、收件箱编号或会话消息位置 |
| version | int | 版本 | 每次修改 +1；旧版本整条写入 audit |
| created_at / updated_at | datetime | 时间 | 带时区存储，展示用 Asia/Shanghai |

#### 8.2.2 goals（目标）【一期；continuous 字段二期】

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| goal_id | string | 编号 | `g-<bot_id>-<序号>`，不复用 |
| bot_id | string | 所属机器人 | 必填 |
| aspiration_id | string | 所属志向 | 必填，且该志向 status=active |
| series_id | string | 周期序列 | 同一周期目标的各期共用；首期等于自己的 goal_id |
| period_no | int | 第几期 | 首期 1 |
| objective | string | 可验证的终态：本期结束时世界上多了什么、谁能看到 | ≤ 200 字；含「持续」「尽量」「更好」「继续研究」且没有可数终态的，创建时拒绝（错误码 GOAL_OPEN_ENDED） |
| evidence_required | object[] | 证明方式 | 1–5 条，每条 {type: file / jsonl_row / outbox_result / command_output, spec, note} |
| min_verification | enum: program / agent / e2e / none | 报 done 时的最低验证层级 | 默认 program；none 只允许 evaluator=owner |
| horizon | enum: day / week / month / one_off | 周期 | 见 8.3.2 |
| period_start / period_end | datetime | 本期起止 | day：当天 00:00–次日 00:00；week：周一 00:00 起 7 天；month：当月 1 日 00:00 起到下月 1 日；one_off：创建者给截止，≤ 创建后 30 天 |
| renew | enum: auto / propose / none | 本期结束后怎么生成下一期 | day/week/month 默认 auto；one_off 固定 none |
| evaluator | enum: rule / other_model / owner | 验收方 | day 必须 rule；other_model 二期 |
| acceptance_rule | object[] | 规则验收检查项 | evaluator=rule 时必填，检查项见 8.3.7 |
| owner_accepts | bool | 主人点名亲自验收 | 默认 false；只有主人能设；为 true 时 evaluator 视为 owner |
| importance | int 1–5 | 重要度 | 主人建的默认 3；机器人自建 ≤ 4 |
| patience_hours | int | 耐心期 | day 24 / week 72 / month 168 / one_off 72；可改范围 6–336 |
| status | enum: proposed / active / verifying / done / failed / abandoned | 状态 | 转移见 8.4.1 |
| halts | object[] | 当前命中的停止条件 S1–S5（S6 直接结束本期，不写这里） | 每条 {code, ref, since}；可同时多条；展示取优先级 S2 > S1 > S3 > S5 > S4 |
| last_progress_at | datetime | 上次有效进展 | 创建时等于 period_start；只在 8.3.6 认定的有效进展时更新 |
| halted_ms | int | 自上次有效进展以来处于 halt 或受阻的累计毫秒 | 有效进展时清零 |
| blocked_since | datetime / null | 交账报受阻的起点 | 相关感知出现、复查成功或有效进展时清空 |
| stagnant | bool | 停滞是否已超过耐心期 | tick 计算 |
| progress_log | object[] | 进展记录 | 见 8.2.3；保留最近 50 条，全部历史在情景日志 |
| claim | object | 最近一次完成声明 | {wake_id, at, evidence[], verification, not_covered} |
| acceptance | object | 验收结果 | {round: 1 / 2, result: pass / fail / timeout, by: rule / other_model / owner, scores: {objective_met, evidence_sufficient, within_bounds}, missing[], at, note} |
| repair_used | bool | 是否已用掉「修一轮」 | 默认 false |
| repair_deadline | datetime / null | 修复截止 | 第一次验收不过时写入，见 8.4.2 |
| created_by | enum: owner / owner_message / bot / bot_proposal / renew | 谁建的 | renew 指周期续期 |
| close_reason | enum: accepted / accepted_timeout / acceptance_failed / period_ended / owner_stopped / dropped / aspiration_archived / proposal_rejected / proposal_expired / superseded | 结束原因 | 进入 done / failed / abandoned 时必填 |
| continuous | object / null | 二期连续推进记录 | {dsh_goal_id, revision, rounds_allowed, rounds_used, state: running / paused / finished, resume_attempts, next_resume_at}，见 8.4.4 |
| version / created_at / updated_at | int / datetime | 版本与时间 | 每次修改 +1，旧版本写 audit |

#### 8.2.3 progress_log 条目【一期】

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| at | datetime | 时间 | |
| wake_id | string | 来自哪次思考 | 中心事件（续期、验收、halt）为 null |
| kind | enum: progress / done_claim / ignored / halt / release / acceptance / owner_note / renew | 条目类型 | ignored = 机器人报了进展但没有可核对证据 |
| summary | string | 世界上多了什么、谁能看到 | ≤ 200 字，取交账里与该目标相关的部分 |
| evidence | object[] | 证据 | 每条 {type, ref, verified: bool, check_note} |
| verification | enum: program / agent / e2e / none | 验证层级 | progress 与 done_claim 必填 |
| not_covered | string | 没覆盖什么 | ≤ 200 字，必填，没有写「无」 |
| counted | bool | 是否算有效进展 | 中心按 8.3.6 判定 |

### 8.3 规则

#### 8.3.1 志向【一期】

1. 每个机器人 status=active 的志向 1–3 个；工厂复述时必须产出至少 1 个，否则不能上岗（第 6 章）。
2. 志向只能由主人在中心界面创建、修改、暂停、归档，或由主人确认一张志向提议。机器人的任何工具都不能写 aspirations 表。
3. 主人在机器人会话里亲手说「把你的志向改成……」时不直接生效：机器人调用 hub_goal_upsert（target=aspiration），中心据此生成一张预填好的提议（收件箱 type=proposal，第 10 章），主人点一次确认才生效。理由：志向影响此后所有目标，机器人的转述可能走样。
4. 志向变更从下一次思考开始生效：中心重写 AGENTS.md 与 mind/goals.md，并在下一个唤醒包第一行写「AGENTS.md 已更新，先 read 一次再做事」（见 8.5，【待验证 V16】）。
5. review_at 到期不单独唤醒：中心把「志向复查」并入该机器人下一次复盘（第 7 章）的输入，当天日报列一行；复盘产出「保持 / 修订提议 / 归档提议」之一，review_at 顺延 30 天。
6. 志向 paused：其下 active 目标全部加 S2（ref=null），不再续期；恢复后解除。archived：其下未结束目标转 abandoned（close_reason=aspiration_archived），series 停止续期。

#### 8.3.2 开放式志向拆成周期性有界目标【一期】

1. 志向从不直接推进。机器人每次思考推进的对象只能是目标，或挂在目标、志向下的议程项（第 7 章）。
2. 默认写法：「本期（天 / 周 / 月）做完 X 并汇报，即算本期达成」。X 必须是世界上可检查的东西（文件、记录行、出站结果、命令输出），不能是「继续研究」「持续关注」。依据：10-28 量化线改成「当天做完并汇报即算达成」后，唤醒从每小时 8 次降到 1 次。
3. 每个机器人同时 active + verifying 的目标 ≤ 3 个；proposed 不计。
4. horizon 的选法：有每日产出节律的用 day（「当天完成 1 个事先登记好的检验」）；要积累几天的用 week；有明确终点的用 one_off（「发 v0.3」），截止 ≤ 30 天。
5. day 目标必须 evaluator=rule。写不出规则检查的事不能做成 day 目标，改成 week。理由：天级目标靠主人验收会天天打扰主人，靠另一模型会天天多一次调用。
6. renew=auto 的目标在 period_end 由中心直接生成下一期：复制 objective、evidence_required、min_verification、acceptance_rule、evaluator、importance、patience_hours，period_no+1，created_by=renew，status=active，不需要再批准（series 的首次建立或批准覆盖后续各期）。续期不产生思考回合。
7. 新一期开始不发唤醒包。推进它的理由来自感知、议程和内驱（第 7 章）。period_end 作为一个到期时间参与承诺紧迫度计算（第 7 章的承诺内驱），只在 status=active、halts 为空、本期还没报 done 时计入。
8. 复盘（8.4.3）产生的「换写法」被采纳后，从下一期开始生效；本期内容不改。

#### 8.3.3 谁能建、改、放弃【一期；L3 二期】

| 操作 | 主人（中心界面） | 主人在机器人会话里亲手说 | 机器人 L2 / L3 | 机器人 L1（含试岗） | 机器人 L0 |
|---|---|---|---|---|---|
| 建、改、暂停、归档志向 | 直接生效 | 生成预填提议，主人一键确认 | 只能提议（复盘里） | 只能提议（复盘里） | 只能提议（复盘里） |
| 在既有志向下建目标 | 直接生效 | 直接生效并记账 | 直接生效，当天日报告知并附「撤销」 | 只能提议（status=proposed） | 不能（工具拒绝） |
| 改目标关键字段（objective、evidence_required、min_verification、horizon、evaluator、acceptance_rule、importance） | 直接生效 | 直接生效并记账 | 自建的：直接生效并日报告知；主人建的：只能提议 | 只能提议 | 不能 |
| 改 patience_hours（±50% 以内） | 直接生效 | 直接生效 | 自建的直接生效并记账；主人建的只能提议 | 只能提议 | 不能 |
| 暂停本期（S2）或恢复 | 直接生效 | 直接生效 | 不能 | 不能 | 不能 |
| 放弃目标 | 直接生效 | 直接生效 | 自建的、且满足放弃条件：直接放弃并日报告知；主人建的：只能提议 | 只能提议 | 不能 |

1. 「主人在会话里亲手说」的认定：本回合输入里有 source.kind=user 且带 rpcId 的消息（第 7 章唤醒理由 owner_message），hub_goal_upsert 在同一回合里调用，参数带 `authority: owner_message` 和所引主人原话（≤ 200 字）。核对不过就按机器人自己的等级处理。中心消息、到期议程、同伴消息、网页或文件里写的「主人说」一律不算。
2. 机器人自建目标：每个机器人每 7 天自建 ≤ 3 个（被撤销的也计数）；重要度 ≤ 4；evaluator 只能是 rule，二期加 other_model，不能把验收推给主人。
3. 机器人只能在 status=active 的志向下建目标。是否越出该志向的 boundaries，中心不做语义判断，由复盘与二期验收的 within_bounds 判据兜底；主人在日报或详情页点「撤销」，目标立即转 abandoned（close_reason=dropped），并在信任账本记一次「驳回」（第 9 章）。
4. L1 提议的目标进收件箱 type=proposal（第 10 章），受提议门槛（价值 ≥ 0.6、把握 ≥ 0.5）和 L1 每周 ≤ 3 条约束；7 天不处理自动撤回（proposal_expired）；被拒（proposal_rejected）的同类 30 天不再提。
5. 机器人放弃自建目标必须写明命中的放弃条件（达成 / 不可能 / 不再相关 / 过期）和证据；「困难」「暂时没进展」不算放弃条件。
6. 主人的修改从下一次思考开始生效；机器人正在思考时，中心等回合结束再处理，不中途 steer（主人亲手在会话里说的除外，那本来就在回合里）。

#### 8.3.4 停止条件 S1–S6【一期】

| 代码 | 含义 | 判定（谁、依据什么） | 命中后 | 解除 |
|---|---|---|---|---|
| S1 | 已提问在等主人 | 交账 goal_reports 中该目标 outcome=needs_owner、independent_steps_left=false，且本次交账带了 owner_ask，中心已生成收件箱 type=question 条目 | halts 加 {S1, ref=提问编号} | 主人回答；或提问 72 小时过期按默认处理 |
| S2 | 主人说停 | 主人在界面点「暂停本期 / 暂停到某天」；或主人亲手在会话里说、机器人用 hub_goal_upsert(action=pause, authority=owner_message) 提交且核对通过 | halts 加 {S2, ref=until 或 null}；主人选「停止」则直接 abandoned（owner_stopped） | 主人点恢复，或 until 到达 |
| S3 | 剩下步骤都要主人拍板 | goal_reports 中 outcome=needs_owner、independent_steps_left=false，且该目标至少关联 1 个 pending 的审批单或提议；关联不到任何 pending 条目的「需要你」无效，记为 ignored | halts 加 {S3, ref=这些条目编号} | 关联条目全部处理完或过期 |
| S4 | 当日思考达上限 | 调度器：该机器人当天自发思考次数 ≥ 每日上限（L0 2 / L1 6 / L2 10 / L3 12；主人亲手发起的不计） | 该机器人所有 active 目标加 {S4, ref=次日 00:00} | 次日 00:00（Asia/Shanghai） |
| S5 | 预算到顶 | 额度管家：该机器人当日或当前窗口预算用尽，或额度灯 red（第 14 章） | 该机器人所有 active 目标加 {S5, ref=重置时间} | 重置时间到达且额度灯不是 red |
| S6 | 目标周期结束 | tick：now ≥ period_end（verifying 中的目标等验收出结果，见 8.4.2） | 结束本期，按 8.4.3 收尾、续期、触发复盘 | 不解除，本期已结束 |

命中 S1–S5 后的通用效果：

1. 该目标不再产生任何唤醒理由：停滞内驱和周期到期紧迫度不计算；只挂在它下面的议程项不触发（第 7 章）。
2. halt 期间不计入停滞小时数（8.3.5）。
3. 唤醒包里该目标只占一行，例如「已停：S1 等你回答 Q-12（已等 26 小时，72 小时后按默认处理）。不要汇报它仍未达成」。交账里对被 halt 目标报的 no_change 条目中心直接丢弃，日报里也不出现「仍未达成」。
4. 一个机器人的 active 目标全部被 S1/S3 halt、且没有不依赖主人的议程项 ready 时，活动状态为 waiting_owner；全部被 S4/S5 halt 时为 resting（状态机见第 7 章）。
5. 机器人不能直接写 halts。S1/S3 只能通过交账声明，由中心核对后写入；S2 只认主人；S4/S5/S6 由中心计算。
6. 解除时：S1/S3 因主人处理而解除，生成显著性 1.0 的感知（主人答复）；因过期解除，生成 0.70 的感知；S2/S4/S5 解除不生成感知，只恢复内驱计算。

#### 8.3.5 耐心期与停滞【一期】

1. 停滞小时数 = (now − last_progress_at − halted_ms) ÷ 3600。halted_ms 累计两类时段：halts 非空的时段；blocked_since 非空的时段（受阻有自己的每天 1 次复查，第 7 章，不再叠加停滞压力）。
2. 停滞小时数 ≥ patience_hours 时 stagnant=true；mind/goals.md 和详情页显示「已停滞 30 小时（耐心期 24 小时）」。
3. 停滞内驱 = min(1, 停滞小时数 ÷ patience_hours) × importance ÷ 5（第 7 章）。importance ≤ 2 的目标停滞不产生唤醒理由，只在日报列出。
4. 停滞触发的思考之后，该目标必须出现三者之一：有效进展；机器人在交账里为该内驱设暂缓（≤ 72 小时，写理由，第 7 章）；报 blocked 并写明阻碍。三者都没有，下一次停滞触发直接改为复盘回合（第 7 章）。
5. 节奏档不改耐心期（节奏档只改门槛和间隔系数）。

#### 8.3.6 进展记录与验证层级【一期】

1. 机器人通过 hub_commit 的 goal_reports 汇报目标（交账协议见第 7 章）。每条需要：goal_id；outcome（no_change / progress / done / blocked / needs_owner）；summary ≤ 200 字；evidence[]（{type, ref}）；verification {level, not_covered}；independent_steps_left（outcome=needs_owner 时必填）；blocker ≤ 100 字（outcome=blocked 时必填）；continue_rounds 0–8（二期，见 8.4.4）。
2. 有效进展（counted=true）同时满足：outcome 为 progress 或 done；至少 1 条证据被中心核对通过。核对方法：
   - file：路径在家目录或该机器人的读取范围内（第 13 章），文件存在，且修改时间晚于本次唤醒开始，或内容哈希不同于上一条记录里的哈希；
   - jsonl_row：指定文件里存在满足 spec 的行，且该行的时间字段落在本期；
   - outbox_result：对应出站动作本期状态为 done（第 9 章）；
   - command_output：本次唤醒的会话日志里有该 callId 的 tool/result 且成功（【待验证 V18】）。
   核对不过的记为 ignored，last_progress_at 不动。只交计划、没有交付物的，按第 7 章记为 no_change。
3. 验证层级：program 程序测（机器人跑了自动化测试或脚本）；agent 经 Agent 测（像真实使用者那样经过一个 Agent 或技能跑了一遍）；e2e 真实端到端（真实环境、真实数据从头到尾走通，例如真装一次、产物真出现在主人的知识库里）；none 未验证。哪层通过只代表哪层。
4. not_covered 必填，写清这次没覆盖什么（≤ 200 字）。日报和汇报第一行都带层级和没覆盖什么（第 10 章）。
5. done 声明的层级低于 min_verification 时，中心当场退回：目标保持 active，下一个唤醒包写「验证层级不够：要求 e2e，你报的是 program」。不进验收，也不算虚报。
6. 声明与核对结果矛盾（证据路径不存在、文件没改过、对应 tool/result 失败却报成功），记一次「虚报」到信任账本（第 9 章）。

#### 8.3.7 验收方与验收

1. 选验收方【一期】：能写规则就用 rule；day 目标必须 rule。写不出规则的：一期用 owner；二期用 other_model；主人设了 owner_accepts=true 的用 owner。干活的机器人自己说了不算，也没有 update_goal 一类的工具。
2. 规则检查项【一期】（全部通过才算 pass；路径只允许家目录与读取范围；可用占位 `$home`、`$period_start`、`$period_end`）：

| 检查项 | 参数 | 通过条件 |
|---|---|---|
| file_exists | path, modified_after | 文件存在且修改时间晚于 modified_after（默认 $period_start） |
| file_grows | path, min_new_lines | 本期新增行数 ≥ min_new_lines |
| jsonl_count | path, where（字段 → 值，可用 $period 表示落在本期）, min | 满足 where 的行数 ≥ min |
| dir_count | dir, suffix, modified_after, min | 目录第一层里后缀匹配、修改时间晚于 modified_after 的文件数 ≥ min |
| outbox_done | kind, min | 本期该机器人 status=done 的该类出站动作 ≥ min |
| command_ok | script, args | 主人批准过的只读门控脚本（与关注项 script 共用一份批准名单）退出码 0，30 秒超时【待验证 V2】 |

3. 规则验收在两个时刻跑：收到 done 声明后 1 个 tick 内；period_end 时对仍是 active 的规则目标再跑一次，通过就直接 done（progress_log 记「未汇报，规则判达成」）。
4. 主人验收【一期】：收件箱 type=question（第 10 章），标题「『收藏管家』说本期目标已完成：<objective 摘要>，你验一下？」，附证据链接、验证层级、没覆盖什么；选项「通过」「不通过（写一句原因）」。72 小时不回答按默认处理：status=done、close_reason=accepted_timeout，日报和界面显示「完成·主人未验」，不计入验收通过率；7 天内主人可以改判。
5. 另一模型验收【二期】：
   - 模型：设置项 acceptance_model 指定，必须与该机器人 model_route 不是同一家供应商；调用不可用或连续失败 2 次时，这一次改为主人验收。
   - 输入（合计 ≤ 24k token）：objective、evidence_required、min_verification；机器人的完成声明（标注为「被验收方的说法，仅供对照」）；本期与该目标相关的全部唤醒在会话日志里的 tool/call 与 tool/result 记录（每条截取工具名、参数摘要、结果状态和首尾各 500 字，失败的调用全部保留）；证据文件节选（≤ 10 个，每个 ≤ 2 KB）；本期出站动作结果。
   - 输出（≤ 1k token，JSON）：objective_met、evidence_sufficient、within_bounds 三项各 0–1，加理由与 missing[]（≤ 5 条）。三项都 ≥ 0.65 才算 pass。
   - 判据含义：objective_met 看真实工具记录显示的世界状态是否等于终态，不看机器人怎么说；evidence_sufficient 看证据是否真实存在、是否达到最低验证层级、报的层级与工具记录是否一致；within_bounds 看有没有越出志向的 boundaries、有没有做没被要求或没被批准的改动。
   - 用量计入该机器人预算（第 14 章，类别「验收」）。
6. 虚报认定：evidence_sufficient < 0.40；或规则核对发现所引证据不存在；或主人在验收时选「不通过」并勾「汇报不实」。三者任一都在信任账本记一次「虚报」（第 9 章）。普通的不通过只记「验收不过」。
7. 主人随时可以在界面改判任何验收结果；改判写 audit，并在信任账本记一次「纠正」。

### 8.4 流程

#### 8.4.1 目标状态转移【一期】

| 从 | 到 | 触发 |
|---|---|---|
| （无） | proposed | L1 机器人 hub_goal_upsert；机器人对主人建的目标提出修改或放弃（生成一份 proposed 的新版本，原目标照常进行；接受后原目标转 abandoned，close_reason=superseded 或 dropped） |
| （无） | active | 主人建；主人在会话里亲手说；L2/L3 机器人自建；续期 |
| proposed | active | 主人在收件箱接受提议（「改一下」后接受的，以改后内容为准） |
| proposed | abandoned | 主人拒绝（proposal_rejected）；7 天未处理（proposal_expired）；机器人撤回 |
| active | verifying | goal_reports 报 done，证据核对通过且层级 ≥ min_verification |
| verifying | done | 验收 pass；主人验收超时（accepted_timeout） |
| verifying | active | 第一次验收 fail，且 repair_used=false：置 repair_used=true，repair_deadline = max(period_end, 现在 + 6 小时) |
| verifying | failed | 第二次验收 fail（acceptance_failed）；第一次 fail 后 repair_deadline 到达仍没有新的 done 声明 |
| active | failed | period_end 到达、规则没通过或没报 done（period_ended）；repair_deadline 到达 |
| active / verifying | abandoned | 主人停止（owner_stopped）；志向归档（aspiration_archived）；机器人放弃自建目标或主人接受放弃提议（dropped）；被新版本替换（superseded） |

done、failed、abandoned 是终态，不再变化；主人改判只改 acceptance 和 close_reason，并写 audit。

#### 8.4.2 验收流程

1. 交账里某目标 outcome=done：中心核对证据（8.3.6 第 2 条），不过则记 ignored 并在下一个唤醒包说明；层级不够则退回（8.3.6 第 5 条）。
2. 通过后写 claim，status=verifying，按 evaluator 分流：
   - rule【一期】：1 个 tick 内跑完检查项，写 acceptance；
   - owner【一期】：生成收件箱提问（8.3.7 第 4 条），不单推，进日报「要你定的事」；
   - other_model【二期】：中心异步调用验收模型（8.3.7 第 5 条），不占用机器人会话，不阻塞其他机器人。
3. pass：status=done、close_reason=accepted；生成一条显著性 0.50 的感知给该机器人（进待处理堆，随下次思考带上，不单独唤醒）；日报列一行「目标完成（规则 / 另一模型 / 主人验收），层级、没覆盖什么」。
4. 第一次 fail 且可修：status 回 active，生成显著性 0.80 的感知（成为候选），内容是 missing[] 与理由；下一个唤醒包把它列为本次主意图的首选，并注明「这是唯一一次修复机会，截止 <repair_deadline>」。
5. 第二次 fail，或修复截止仍无新的 done 声明：status=failed、close_reason=acceptance_failed；日报标红「自报完成；验收没通过，缺：…」；触发复盘（8.4.3）。
6. 每次验收结果都写 audit（类别 acceptance）供信任账本统计（第 9 章）。

#### 8.4.3 周期结束、续期与复盘【一期】

1. 每个 60 秒 tick 检查 period_end（按 Date.now 真实时间；两次 tick 间隔 > 10 分钟视为刚醒来，先补齐所有到期的周期，再做别的）。
2. 到期的目标按状态收尾：active 且 evaluator=rule → 跑规则，pass 则 done，fail 则 failed（period_ended）；active 且非规则 → failed（period_ended）；verifying → 等验收出结果，最长等到 repair_deadline 或主人验收的 72 小时。
3. 续期：renew=auto 且志向 active、机器人生命周期为 probation 或 active → 立即生成下一期（8.3.2 第 6 条）。renew=propose → 不生成，交给复盘提议。机器人 paused / quarantined 期间到期的周期照样收尾，但不续期，恢复时按当时日期生成当期。
4. 复盘触发（复盘回合本身见第 7 章：只读、≤ 20 步、每天 ≤ 1 次）：
   - week / month / one_off 目标本期结束：每次都触发；
   - day 目标：本期 failed、验收第一次 fail、连续 3 期没有有效进展、或距该 series 上次复盘已满 7 期，任一满足才触发；其余 day 周期只由中心写一条无模型的周期小结，不调用模型；
   - 当天已复盘过一次的，排到次日，并与次日其他复盘理由合并成一次。
5. 复盘包里目标部分由中心算好（不让机器人自己数）：本期状态与验收结果、各项得分、有效进展条数、被 ignored 的条数、花掉的思考回合与 token、各停止条件命中次数和时长、停滞次数、同一阻碍重复次数、是否有虚报、下一期是否已生成。
6. 复盘可产出（经 hub_reflect_commit，第 7 章）：自己能改的（做法、做事清单、关注项收窄或调频）立即生效；目标层面的变化（换写法、换周期、换验收方、改重要度、停掉 series、把「找到过关策略」改成「本周写出否定结论报告」）按 8.3.3 的权限，L2 改自建 series 直接生效并日报告知，其余生成提议；志向修订一律生成提议。

#### 8.4.4 有限轮数连续推进【二期】

用途：较大的一次性推进（例如在本地分支修一个 CI 失败），在一次唤醒里需要连续多轮。用 DSH 的 goal 驱动器跑有限轮，由中心发起、由中心叫停。

1. 只有中心能建 DSH goal。角色模板不挂 tool-goal 和 command-goal（第 6 章），机器人没有 create_goal / update_goal / /goal；动作闸对这两个工具名一律拒绝作双保险（第 9 章）。
2. 申请：机器人在 goal_reports 里写 continue_rounds（1–8）和理由。中心同时满足以下条件才批：机器人 L2 及以上且生命周期 active（试岗期不批）；该目标 active 且 halts 为空；额度灯 green；该机器人当日剩余预算 ≥ 轮数 × 6 万 token；当日剩余思考次数 ≥ 轮数；该机器人没有别的连续推进在跑。实际轮数 = min(申请轮数, 8, 预算可支撑轮数, 剩余思考次数)。
3. 发起：sessionController.resolveAgent(sessionId) 拿到存活 agent；若会话上已有未完成的 DSH goal，先 ctx.goals.clear 并记 audit；再 ctx.goals.create(agent, {objective, maxGoalRounds: 实际轮数})。objective 由中心渲染：目标原文 + 「这是中心发起的连续推进，共 N 轮；每轮以 hub_commit 结束；你没有 update_goal 工具，结束由中心判断；需要主人的事不要等待」。
4. 调度：调度器为本次连续推进开一张唤醒单（变体 continuous，见 8.8），覆盖 N 个回合；未持该唤醒单的 goal 来源回合被第 7 章的 agent/pre-step 闸拒绝。连续推进期间占用 1 个同时思考名额，直到结束。每一轮都受回合守卫上限（30 步、20 分钟、约 6 万 token），都计入每日思考次数和预算。
5. 每轮在处理本轮 hub_commit 时（回合还没结束）就决定是否继续：outcome=progress 且下一轮的预算和额度条件仍满足 → 不动，让驱动器继续；outcome=done → ctx.goals.block(agent, ref, 'awaiting-acceptance')，进 8.4.2 验收，pass 后 ctx.goals.complete（complete 可以从 blocked 出发）；outcome=blocked / needs_owner → ctx.goals.block(agent, ref, 原因)；outcome=no_change、命中任一停止条件、额度灯离开 green → ctx.goals.block(agent, ref, 'hub-stop')。没交账就结束的回合，在 turn/end 里 block。停的时候用 block 不用 pause：宿主侧 pause 会取消当时正在跑的回合，会把还没结束的这一轮掐断（block 是否同样会取消【待验证 V17】）。
6. 任何时刻 maxGoalRounds > 8 的 create 或 edit 都不由中心发出；中心监听 goal/changed，发现机器人会话上出现非中心创建的 DSH goal（含主人误操作），1 个 tick 内 ctx.goals.clear，并在详情页提示「请用中心的『连续推进』按钮，最多 8 轮」。
7. 重新武装：App 重启、插件重载、agent/error、因 max-tokens 结束都会让 DSH goal 变成 disarmed。中心在启动静默 3 分钟结束后（此时 goal-round-driver 已加载，它加载时会把所有存活 agent 的 goal 再 disarm 一次），对 continuous.state=running 的机器人逐个检查：ctx.goals.get 显示 active 且未武装、条件仍满足 → ctx.goals.resume。失败按 2 分钟、10 分钟、30 分钟、2 小时（±20% 抖动）退避重试；第 4 次仍失败 → ctx.goals.clear、continuous.state=finished、该目标 24 小时内不再批连续推进，并按告警规则（连续 2 次失败才报）告诉主人。因额度报错 disarm 的，不计入重试次数，等额度灯回到 green 再试。
8. 驱动器只看轮数，轮内没有步数或 token 上限，所以中心的回合守卫必须对 goal 来源的回合同样生效；驱动器在轮间不留间隔、一空闲就发下一轮，所以第 5 条的决定必须在 hub_commit 处理里做完，不能等 turn/end 之后再判断。重新武装时跳过 block 原因为 awaiting-acceptance 或 hub-stop 的 goal。

### 8.5 在 AGENTS.md 与 mind/goals.md 里的渲染【一期】

1. AGENTS.md（单个 ≤ 8 KB，第 11 章负责整体生成与保护）里只放稳定内容，目标相关段落合计 ≤ 2 KB。以 L1 的收藏管家为例：

   ```
   ## 我的志向（主人定的，我不能改，只能在复盘里提议）
   1. 每天的小红书收藏都按时进知识库；停了当天就让主人知道
      - 为什么：主人原话「新增的收藏处理了么」，不想再靠追问
      - 顺利时会看到：日报里每天有入库条数；失败当天有原因
      - 不做：不自己刷收藏页；不碰账号登录
      - 下次复查：2026-12-04
   ## 目标怎么运作
   - 当期目标在 mind/goals.md，唤醒包里也会列出相关目标；两者不一致时以唤醒包为准。
   - 每个目标都是「本期做完并汇报即算达成」。做完在 hub_commit 的 goal_reports 里报 done，附证据、验证层级和没覆盖什么；是否达成由验收方判，不由我判。
   - 命中停止条件（S1 在等主人回答、S2 主人说停、S3 剩下都要主人拍板、S4 今天思考次数到顶、S5 预算到顶、S6 本期结束）就停，不汇报「仍未达成」。
   - 我的等级是 L1：目标只能提议，提议进主人的收件箱。
   ```

   L2 的版本把最后一条换成「可以在上面的志向下用 hub_goal_upsert 建有界目标（同时进行 ≤ 3 个，每 7 天自建 ≤ 3 个，重要度 ≤ 4），建了会在日报里告诉主人」；L0 的版本写「目标由主人设定」。
2. AGENTS.md 由中心写入，不是机器人的 read/write/edit，DSH 不一定会把改动刷新进后续请求。所以志向或等级变化后，中心在下一个唤醒包第一行要求机器人先 read AGENTS.md；会话轮换（第 11 章）时自然生效。【待验证 V16】
3. mind/goals.md 是只读视图，aspirations 或 goals 任一记录变化后 1 个 tick 内重写（先写临时文件再原子改名），≤ 6 KB；超出时「最近结束」一节截断。机器人对 mind/ 的写入由动作闸拒绝（第 9 章）。格式：

   ```
   # 我的目标（中心生成，只读；2026-11-05 09:12 更新）
   ## 进行中
   ### g-xhs-12 本周每天新增的收藏都入库，并在日报报数（第 3 期，11-03 至 11-10）
   - 志向：asp-xhs-1 收藏按时进知识库
   - 终态：wiki/sources/xhs/ 下本周每天都有入库记录；主人在日报和知识库里能看到
   - 证据：runs.jsonl 本周每天一行 status=ok；最低验证层级 e2e
   - 验收：规则（jsonl_count：status=ok 且日期在本期 ≥ 7）
   - 重要度 4 · 耐心期 72 小时 · 上次有效进展 11-04 21:30 · 未停滞
   - 停止条件：无
   - 最近进展：11-04 补齐 11-03 的 14 条（e2e；没覆盖：图片附件）
   ## 已停（命中停止条件）
   ### g-guanchao-7 ……（S1：等你回答 Q-12，已等 26 小时）
   ## 待主人处理的提议
   ## 最近 7 天结束的
   - g-xhs-11 第 2 期：done（规则验收）
   ```

4. 唤醒包（第 7 章，≤ 6 KB）里的「相关目标」只列与本次唤醒理由相关的目标，每个 ≤ 4 行：编号与 objective、本期截止、停止条件、上次有效进展与是否停滞；被 halt 的目标只列一行。

### 8.6 实现

1. 存储：aspirations、goals 两张表在 `ctx.storageDomain.open({name:'agent_hub', layout:'per-record', invalidRecords:'backup-and-skip', tables:{…}})` 里；storageDomain 写入不校验，中心写前按 8.2 自校验（必填、枚举、长度、志向存在且 active、同时 active ≤ 3、自建配额），用 version 做比较后写入，冲突重读重试 1 次。
2. 工具：hub_goal_upsert 在 agent/created 时注册到该机器人的 agent.ctx（`ctx.tools.register`），不注册在插件根上。参数：{target: goal / aspiration, action: create / edit / pause / resume / abandon, goal_id?, fields, authority?: owner_message, owner_quote?, reason, drop_condition?}。处理函数按名册里的自主等级和 8.3.3 决定直接生效、生成提议或拒绝，返回值写清结果（「已生效」「已生成提议 P-31，进主人收件箱」「拒绝：L0 不能建目标」）。所有等级都注册这个工具，处理函数每次按当时的等级判定，这样主人改等级后不用重新注册；L0 的每次调用都返回「目标由主人设定，有想法写进交账的提议」。
3. 交账：goal_reports 由交账处理（第 7 章 CommitProcessor）逐条调用本章的 `goals.applyReport(report, wake)`：核对证据、写 progress_log、更新 last_progress_at、处理 done 声明与 S1/S3。
4. 时钟：周期收尾、halt 解除、停滞计算、mind/goals.md 重写都挂在意图时钟的 60 秒 tick（`ctx.interval`，回调全部 try/catch，按 Date.now 核对真实时间）。不用 ctx.schedule。
5. 证据核对与规则验收：文件类用宿主进程内的文件读取（宿主不在会话沙箱里）；command_ok 用宿主子进程跑主人批准过的脚本，30 秒超时【待验证 V2】；command_output 与另一模型验收要的工具记录用 `ctx.sessionQuery.filterEvents(sessionId, [{kind:'type', values:['tool/call','tool/result']}])`，按唤醒单记下的回合起止截取【待验证 V18】。
6. 另一模型验收【二期】：`ctx.llm.stream` 直接调用 acceptance_model【待验证 V6】；这类调用不进会话 tokenUsage，中心按估算 × 1.2 自己记账（第 14 章）。
7. 连续推进【二期】：`ctx.sessionController.resolveAgent` → `ctx.goals.get / clear / create / pause / block / complete / resume`（服务层只要求精确存活的 Agent 与 {id, revision}，不查人类授权；revision 过期报 GOAL_STALE_REVISION 时重读再试）；订阅 `goal/changed`（记账、发现非中心创建的 goal）、`goal/activation-changed`（显示是否真的在跑）、`agent/error` 与 `session/event` 的 turn/end（判断每轮结束）。注意：宿主侧 pause 会取消正在跑的回合；被取消的 goal 轮会让 goal 变 paused，只能由中心 resume；重新武装必须在 goal-round-driver 加载之后。goal-round-driver 挂在宿主层还是 preset 里，决定不挂 tool-goal 的角色模板能否连续推进【待验证 V17】。
8. 界面与收件箱：主人在界面建改志向和目标、改判验收、撤销自建目标，都走 `ctx.connection.fetch.register` 注册的接口（只认主人，第 16 章）；提议与验收提问写收件箱（第 10 章）。
9. 渲染：AGENTS.md 与 mind/goals.md 由宿主写文件（临时文件 + 原子改名）；机器人写这些路径被动作闸拒绝（第 9 章）。

### 8.7 验收

1. 建目标时缺 aspiration_id、志向不是 active、objective 含「持续研究」且无可数终态、day 目标没有 acceptance_rule、机器人已有 3 个 active 目标：各返回明确错误码，表里没有新记录。
2. 同一句 hub_goal_upsert(create)：L0 返回拒绝；L1 生成 status=proposed 和一条收件箱提议；L2 生成 status=active，当天日报出现「自建目标」一行且带撤销入口；同一机器人 7 天内第 4 次自建被拒。
3. 主人在机器人会话里亲手说「这周先别管 issue，专心发 v0.3」：本回合内目标变更直接生效，audit 记 authority=owner_message 与原话；同样内容由中心消息或同伴消息带进来时，按机器人等级处理（L1 只生成提议）。
4. 主人在会话里口述修改志向：只生成一张预填提议，aspirations 表在主人确认前不变。
5. 冻结世界 48 小时，day 目标 renew=auto：每天 00:00 生成下一期，期间没有任何因续期产生的思考回合；第 1 章 T1 照样通过。
6. S1：机器人提问且 independent_steps_left=false 后，72 小时内该目标不产生任何唤醒理由；主人回答后 1 个 tick 内生成显著性 1.0 的感知；72 小时不答，按默认处理并生成 0.70 的感知。
7. S3：报 needs_owner 但目标没关联任何 pending 条目 → 记 ignored，halts 不变，日报不出现「需要你」。
8. S4、S5：达到每日上限或预算用尽时所有 active 目标带上对应 halt，次日 00:00 或重置时间到达后 1 个 tick 内解除；halt 期间停滞小时数不增长。
9. 被 halt 的目标：日报与唤醒包都不出现「仍未达成」；交账里对它的 no_change 被丢弃。
10. 报 progress 但证据路径不存在或本次唤醒没改过：记 ignored，last_progress_at 不变；证据路径存在但内容与声明矛盾的记一次虚报。
11. 停滞：重要度 4、耐心期 24 小时的目标，冻结世界、无事件，停滞内驱在第 7 章公式下越过门槛并触发思考（T6）；重要度 2 的目标只在日报列出，不触发。
12. done 声明层级低于 min_verification：当场退回，不进验收。规则目标报 done 后 1 个 tick 内出结果；period_end 时规则通过但机器人没报 done 的，自动 done 并注明「未汇报」。
13. 主人验收 72 小时不回答：status=done、close_reason=accepted_timeout，界面显示「完成·主人未验」，不计入验收通过率。
14. 【二期】构造 10 个「自报完成但没有证据」的交账，另一模型验收拦下 ≥ 9 个；三项都 ≥ 0.65 才 pass；第一次 fail 后有且只有一次修复机会，修复截止为 max(period_end, fail 时刻 + 6 小时)；第二次 fail 判 failed。
15. 周期结束：week 目标每期结束都排一次复盘；day 目标连续 5 期 done 不排复盘，第 7 期排一次；同一天第二个复盘理由合并到次日。
16. 【二期】连续推进：任何路径都不会出现 maxGoalRounds > 8 的 DSH goal；手动在机器人会话里建一个 goal，1 个 tick 内被清除；连续推进中退出并重开 DSH，启动静默结束后按退避 resume；模拟额度报错，额度灯回 green 前不 resume；每一轮都计入每日思考次数，超过即停。
17. mind/goals.md 在目标变化后 1 个 tick 内更新、≤ 6 KB；机器人直接用 write、edit 或 bash 重定向改它都被拒并记越界（借脚本间接改写属于第 13 章的残余风险，中心每次重写会覆盖）；AGENTS.md 目标相关段落 ≤ 2 KB。

### 8.8 新增建议

1. 耐心期默认值写进骨架第 6 节：day 24 小时、week 72 小时、month 168 小时、one_off 72 小时，可调范围 6–336 小时。骨架目前只有「耐心期」这个词，没有数值。
2. 目标状态枚举写进骨架第 3 节：proposed / active / verifying / done / failed / abandoned；结束原因 close_reason 枚举见 8.2.2。
3. 验证层级代码写进名词表：program 程序测 / agent 经 Agent 测 / e2e 真实端到端 / none 未验证。
4. 第 7 章 hub_commit 需要 goal_reports[] 字段（8.3.6 第 1 条），其中 independent_steps_left 是 S1/S3 的判定依据，continue_rounds 是二期连续推进的申请入口。
5. 思考回合变体新增 continuous 连续推进（二期）：一张唤醒单覆盖 N ≤ 8 个 goal 来源回合。
6. 新增数值：day 目标必须规则验收；机器人每 7 天自建目标 ≤ 3 个、重要度 ≤ 4；第一次验收不过的修复窗口至少 6 小时；另一模型验收输入 ≤ 24k token、输出 ≤ 1k token；主人验收超时记 accepted_timeout（「完成·主人未验」）。理由：天级目标不能天天打扰主人；自建配额防自造忙碌；周期末尾失败也要给得起「修一轮」。
7. 第 7 章的承诺内驱需要把目标的 period_end 当作到期时间计入（8.3.2 第 7 条），否则新一期目标只能靠停滞内驱推动。
8. 设置表新增 acceptance_model（二期另一模型验收用的供应商与模型）。

## 9. 行动边界：动作分类、自主等级、审批与出站

### 9.1 职责

决定机器人的每一个动作能不能做、要不要先给主人看、由谁来执行。机制分四件：动作分类（A–D）、按自主等级处置（L0–L3）、非阻塞的审批单与批准票、由中心代为执行的出站动作；外加记录表现的信任账本，用来自动降级和（二期）提出升级建议。本章写机制；安全威胁分析、红线清单、风险三要素与读取范围见第 13 章，给主人的消息怎么送达见第 10 章。

### 9.2 动作类别 A–D【一期】

#### 9.2.1 定义与判定顺序

- **A 内部可撤销**：只影响机器人自己、别人看不见、坏了能重做。读家目录和读取范围内的东西；在家目录 work/ 里写、改、删；在家目录里跑本地命令；网页抓取与搜索（只读，计入预算）；改自己的议程项。
- **B 会持续生效的自我变更**：改变它以后看什么、怎么做，主人日后要看得见、能撤销。关注项自调、做事清单、自己的技能、长期记忆、自建目标。
- **C 别人看得见、碰共享资源或真实数据，且可以撤回**：公开场合、可删除的发言（白名单仓库里的评论），写主人的目录（带备份）。
- **D 不可逆或高风险（永久闸门）**：见 9.4。直接发给主人以外某个人的消息归 D，不归 C。

判定顺序（第一个命中的为准）：① 第 13 章红线 → 拒绝并记越界；② 本期不支持的动作 → 拒绝，提示写成提议；③ D；④ C；⑤ B；⑥ A。判不清的按更高的一类处理。类别以动作闸的判定为准，机器人在参数或交账里自报的类别不算。

#### 9.2.2 归类清单

工具名与参数字段名以 V21 实测的角色模板工具清单为准【待验证 V21】。

| 动作（工具与参数特征） | 类别 | 处置要点 |
|---|---|---|
| read / grep / glob，或 bash 只读命令（cat、ls、rg、git log），路径在家目录或读取范围内（第 13 章） | A | 直接做 |
| 读读取范围之外的主人私密文件（未开放的 ~/Documents 子目录、其他机器人的家目录） | D（个人信息） | 审批单 + 批准票，批一次读一次 |
| 读凭据与密钥（~/.ssh、~/.dsh/.credentials.yaml、.env、钥匙串、浏览器配置目录）；读未开放的公司工作目录 | 红线 | 拒绝并记越界 |
| write / edit / bash 在家目录 work/ 下建、改、删文件 | A | 直接做 |
| write / edit 家目录 playbooks/、.agents/skills/、memory/MEMORY.md | B | 写之前把旧文件存进撤销区，做完记一条自我变更，日报告知并附撤销 |
| 写或改 AGENTS.md（自己的或根目录的）、mind/ 下任何文件、memory/journal/ 历史 | 红线（受保护文件） | 拒绝并记越界 |
| 删家目录 work/ 之外的文件；破坏性 git 操作（reset --hard、clean -fdx、branch -D、push --force） | D（删除） | 审批单 + 批准票 |
| 写家目录之外（write、edit、bash 重定向、cp、mv 的目标在外面，临时区按第 13 章） | 越界 | 拒绝并记越界；写主人目录改用 hub_outbox_submit(owner_file_write)（unattended 权限档本来也会拒） |
| bash 本地构建、测试；git 本地操作（status、diff、commit、branch、在家目录里 clone）；往家目录装依赖（家目录里的 node_modules、venv） | A | 直接做（隔离目录里的安装不用问，见主人 10-31 的教训） |
| bash 全局安装或改主机环境（npm -g、brew、sudo、pip --user、launchctl、defaults write） | D（扩权） | 一期直接拒绝（沙箱写不了家目录外），可写提议请主人自己装 |
| bash 对外写入：curl / wget 带 -X POST/PUT/PATCH/DELETE、-d、-F、--data、--upload-file；gh 的写子命令；git push；lark-cli 发送；ssh / scp / rsync 到远端；npm publish；osascript 发邮件或消息 | 越界（绕过出站） | 拒绝并记越界；提示改用 hub_outbox_submit |
| bash 看不懂的命令（eval、管道给 sh / bash、base64 解码后执行、变量拼出命令名、单条超过 2,000 字） | D | 审批单 + 批准票 |
| web_fetch（只能 GET）、web_search；bash 里 curl / wget 只读 GET | A | 直接做，计入预算（第 14 章）；风险三要素不含「碰不可信内容」的机器人不提供这两个工具（第 13 章） |
| subagent | A | 直接做；子代理沿用同一套闸门，用量计入本机器人 |
| workflow、ralph、run_code、plugin_manager、working_directory、schedule_*、ask_user_question、exit_plan_mode、create_goal、update_goal | 不提供 | 角色模板不挂或 tools.restrict 屏蔽；万一调到，拒绝并记越界 |
| mcp__<server>__<tool> | 默认不提供 | 只有第 13 章允许清单里的 MCP 工具可用，按读写性质归 A 或「绕过出站」 |
| hub_agenda_upsert / hub_agenda_close | A | 直接做（议程是自己的短期意图，≤ 30 天，可改可撤） |
| hub_watch_update：收窄过滤、在 15 分钟–24 小时内调轮询间隔、静音或删除自建项 | B | 做完告知，附撤销 |
| hub_watch_propose：新来源类型、新外部域名、门控脚本、扩大数据范围 | D（扩权） | 生成提议（不是审批单），主人接受后中心落库 |
| hub_goal_upsert | B 或提议 | 按第 8 章 8.3.3 |
| hub_lesson_propose | B | 按第 11 章 |
| hub_outbox_submit(owner_file_write)：写入白名单里的主人目录（如知识库某子目录），带备份 | C | 按 9.3 处置；目标不在出站白名单直接拒绝 |
| hub_outbox_submit(github_comment)：在白名单仓库的 issue / PR 下发评论（以主人的 GitHub 账号发出） | C | 同上 |
| 给主人以外的人发飞书、邮件、私信 | D（直接联系真人） | 一期不支持，拒绝并提示写成提议请主人自己发；二期 hub_outbox_submit(feishu_message)，每条审批，永不预批 |
| 合并 PR、发布版本（GitHub release、npm publish）、关闭别人的 issue、删除任何外部对象 | D（不可逆） | 一期不支持；二期逐类加出站类型，每条审批 |
| 花钱、真钱（下单、转账、券商与支付接口、付费服务充值） | D | 一期没有执行器，拒绝；只能写提议，由主人自己做 |
| 改规矩（全体守则、单个规矩、红线、主人定的门槛与风险线） | D | 只能提议；直接写规矩文件属于红线 |
| 改自主等级、权限档、预算、风险三要素、读取范围、出站白名单、预批规则 | D（扩权） | 只能提议，主人在界面改 |
| 新建机器人、退役机器人 | D | 只能提议 |
| 给主人发消息、提问 | 不归动作闸 | 经 hub_commit 的 owner_ask 与找主人路由（第 10 章）；机器人没有直接发飞书的工具 |

### 9.3 自主等级与处置矩阵【一期 L0–L2；L3 二期】

| 等级 | A | B | C | D |
|---|---|---|---|---|
| L0 只观察 | 读类直接做；写只限 work/ | 不做；写成提议 | 不做，不生成审批单；写成发现或提议 | 同 C |
| L1 建议（试岗期固定 L1） | 直接做 | 做完告知（日报 + 撤销入口）；目标只能提议 | 每次生成审批单 | 每次生成审批单 |
| L2 执行 | 直接做 | 做完告知；可在既有志向下自建目标 | 命中预批规则 → 中心执行，日报逐条告知并附撤销；否则审批单 | 每次生成审批单 |
| L3 授权执行【二期】 | 直接做 | 做完告知 | 主人逐类授权的类别 → 中心执行，日报汇总一行；其余同 L2 | 每次生成审批单 |

1. 自主等级只能由主人在中心界面改；机器人只能提议。试岗期锁 L1（第 5 章）。
2. paused、quarantined、retired 的机器人不会有回合（第 7 章）；万一有，动作闸对 A 以外一律拒绝。
3. 「做完告知」落在日报「它们自己做了的事」一节和活动流（第 10、16 章），不单推。
4. 审批单数量限制：每个机器人同时 pending ≤ 5 张，每个回合新建 ≤ 3 张；超出直接拒绝（不记越界），提示合并成一张或下次再提。
5. 预批规则只在 L2 及以上生效，L1 一律忽略；L3 的「逐类授权」是 scope=class 的预批规则（9.5.3），二期开放。
6. D 类在任何等级、任何来源下都要主人逐条点头（对世界的动作用审批单，对机器人自身配置的变更用提议，见 9.4）；预批规则与 L3 授权都覆盖不了 D。主人刚在会话里亲手提过的事也一样，界面会把这张卡置顶并标「你刚在会话里提到」（第 16 章）。

### 9.4 永久闸门（D 类）【一期】

下列动作任何等级都要主人逐条批准，一期没有执行器的直接拒绝并提示写成提议：

1. 花钱：任何会产生费用的动作，包括申请超出预算的额度。
2. 真钱：交易、下单、转账、券商与支付接口。
3. 删除：家目录 work/ 之外的删除与破坏性 git 操作；任何外部对象的删除。
4. 个人信息：读取范围之外的主人私密文件；对外发送任何个人信息（邮箱、电话、证件号、候选人与面试官信息）。
5. 直接联系主人以外的人：私信、邮件、飞书消息。
6. 不可逆的对外动作：合并、发布、关闭他人的 issue。
7. 改规矩：全体守则、单个规矩、红线、主人定的门槛与风险线。
8. 扩权：自主等级、权限档、预算、风险三要素、读取范围、出站白名单、预批规则、新的关注来源类型或外部域名、门控脚本、新工具或 MCP、安装插件或改 DSH 配置。
9. 新建或退役机器人；修改志向（第 8 章）。
10. 动作闸看不懂的命令。

其中「改规矩」「扩权」「新建机器人」「改志向」「新关注来源」本质是对机器人自身配置的变更，走提议（收件箱 type=proposal，7 天撤回）；其余是对世界的动作，走审批单（type=approval，24 小时视为拒绝）。两者都绑定内容哈希，接受或批准只对那份内容生效一次。

### 9.5 数据

#### 9.5.1 approvals（审批单）【一期；feishu_card 二期】

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| approval_id | string | 编号 | `ap-<序号>`；界面与飞书显示为「A-123」 |
| bot_id / wake_id | string | 哪个机器人、在哪次思考里拦下 | 必填 |
| inbox_id | string | 对应收件箱条目（第 10 章） | 必填 |
| origin | enum: tool_call / outbox | 拦下的是工具调用还是出站动作 | |
| action_class | enum: C / D | 类别 | |
| action_kind | string | 工具名（tool_call）或出站类型（outbox） | |
| summary | string | 一句话写后果 | ≤ 40 字，不写代号，例「在 xhs-wiki #12 下以你的账号发一条评论」 |
| payload | object | 规范化后的完整动作 | ≤ 16 KB，超出存文件并记引用 |
| payload_hash | string | sha256(规范化 payload) | 批准只对它有效一次（规范化见 9.6.1） |
| target | string | 规范化目标 | 路径、`github:<owner>/<repo>#<n>`、收件人 |
| who_sees | string | 谁会看到 | 必填，≤ 120 字 |
| reversible | enum: yes / partial / no | 能否撤销 | 必填 |
| undo | string | 怎么撤销、期限多久 | reversible≠no 时必填，≤ 200 字 |
| why | string | 为什么做 | ≤ 300 字，必须引用 goal_id 或 aspiration_id |
| independent_work | string | 不依赖它的部分正在做什么 | ≤ 200 字 |
| owner_present | bool | 本回合是否由主人亲手发起 | 只影响界面排序，不改变批准规则 |
| status | enum: pending / approved / rejected / expired / withdrawn / revoked / consumed / ticket_expired / executed / failed | 状态 | 转移见 9.7 |
| created_at / expires_at | datetime | 创建与过期 | expires_at = created_at + 24 小时，过期视为拒绝 |
| decided_by | enum: owner | 谁批的 | 只能是主人 |
| decided_via | enum: hub_ui / feishu_card | 在哪里批的 | feishu_card 二期 |
| decided_at / decision_note | datetime / string | 何时批、主人写的一句话 | note ≤ 200 字，可空 |
| ticket_expires_at | datetime | 批准票有效期（只用于 tool_call） | decided_at + 24 小时 |
| consumed_at / consumed_call_id | datetime / string | 批准票何时、被哪次工具调用用掉 | 用掉即失效 |
| outbox_id | string | 对应出站动作（origin=outbox） | |

#### 9.5.2 outbox（出站动作）【一期】

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| outbox_id | string | 编号 | `ob-<序号>` |
| bot_id / wake_id | string | 来源 | 必填 |
| kind | enum: owner_file_write / github_comment；二期加 feishu_message / git_push | 出站类型 | 见 9.8 |
| target | string | 规范化目标 | 必须匹配出站白名单 |
| payload / payload_hash | object / string | 内容与哈希 | 规范化同 9.6.1 |
| dedupe_key | string | 去重键 | sha256(kind + 换行 + target + 换行 + payload_hash)，30 天内唯一 |
| bot_ref | string | 机器人给的语义键 | 可选，≤ 64 字符，例 issue-12-triage |
| class | enum: C / D | 类别 | |
| route | enum: approval / preapproval / class_grant | 放行依据 | class_grant 二期 |
| approval_id / preapproval_id | string | 放行凭据 | 二选一 |
| who_sees / reversible / undo / why | | 同 9.5.1 | 必填规则同 9.5.1 |
| status | enum: awaiting_approval / queued / executing / done / failed / unknown / rejected / expired / cancelled / undone | 状态 | 见 9.7.2 |
| attempts / next_attempt_at | int / datetime | 尝试次数与下次时间 | 只有「发起前失败」才重试，≤ 3 次 |
| result | object | 执行结果 | {external_ref（评论链接、写入路径）, backup_ref, read_back: ok / missing / unknown} |
| undo_until | datetime | 撤销期限 | executed + 7 天 |
| error_code / error_text | string | 失败原因 | text ≤ 300 字 |
| created_at / executed_at / undone_at | datetime | 时间 | |

#### 9.5.3 preapprovals（预批规则，新增，见 9.12）【一期 scope=target；scope=class 二期】

| 字段 | 类型/枚举 | 含义 | 默认与约束 |
|---|---|---|---|
| preapproval_id | string | 编号 | `pa-<序号>` |
| bot_id | string | 给哪个机器人 | 只在其等级 ≥ L2 时生效 |
| kind | string | 出站类型 | 不能是任何 D 类类型 |
| target_pattern | string | 目标 | scope=target：精确目标或目录前缀，且必须落在出站白名单之内；scope=class：该类型在白名单内的全部目标 |
| scope | enum: target / class | 预批范围 | class 即 L3 逐类授权，二期 |
| daily_cap / used_today | int | 每天上限与今天已用 | target 1–5；class ≤ 20；00:00 清零 |
| expires_at | datetime | 到期 | target ≤ 创建后 30 天；class ≤ 90 天 |
| status | enum: active / suspended / revoked / expired | 状态 | suspended 见 9.9 |
| created_via | enum: hub_ui / proposal | 怎么来的 | 只有主人能建 |
| note | string | 主人写的限定 | ≤ 200 字，例「只写当天的整理页，不改旧页」 |

#### 9.5.4 出站白名单【一期】

存在 settings 的 `outbound_allowlist` 键：[{kind, target_pattern, note, added_at, added_via}]。默认为空（第 23 章 D17）。只有主人在设置页增删；机器人只能在交账里写提议。owner_file_write 的目录前缀不能包含任何机器人的家目录、`~/.dsh`、`~/.ssh`，也不能是主人的整个家目录。

#### 9.5.5 信任账本【一期记录与降级；二期升级建议】

不单独建表，用 audit 表里 category=trust 的事件：

| type | 何时写 | 用途 |
|---|---|---|
| adopted 采纳 | 审批单被批准；提议被接受 | 采纳率 |
| rejected 驳回 | 审批单被拒或过期；提议被拒或过期；主人撤销机器人的自建目标或 B 类变更 | 采纳率；同类冷却 |
| violation 越界 | 9.6.4 认定的越界 | 自动降级、隔离 |
| misreport 虚报 | 8.3.6 第 6 条、8.3.7 第 6 条 | 自动降级 |
| corrected 纠正 | 主人改判验收结果；主人撤销预批执行的结果并勾「不该做」 | 一致率、预批暂停 |
| acceptance_pass / acceptance_fail | 每次验收出结果（accepted_timeout 不写） | 验收通过率、自报与验收一致率 |

每条事件字段：event_id、bot_id、at、type、action_key（出站类型，或「工具名:类别」）、ref（approval_id / inbox_id / goal_id / wake_id）、detail（≤ 200 字）。指标按 14 天和 28 天滚动窗口现算：采纳率 = adopted ÷ (adopted + rejected)；验收通过率 = pass ÷ (pass + fail)；自报与验收不一致率 = 自报 done 而验收 fail 的次数 ÷ 自报 done 次数。

### 9.6 规则

#### 9.6.1 审批单与批准票【一期】

1. 一张审批单只对应一个动作；批准只对该 payload_hash 有效一次。
2. 规范化：payload = {bot_id, action_kind, cwd, 参数}；JSON 按键排序、去掉无意义空白，字符串做 NFC 归一；路径解析成真实绝对路径（解开符号链接）；bash 命令保留原文，只去掉首尾空白。
3. 24 小时不处理 → expired，按拒绝处理。
4. 被拒或过期的同一 payload_hash，30 天内再提直接拒绝（不建新单、不记越界），返回「这个动作 X 天前被拒：<主人写的原因>」。同一机器人同一 action_kind 连续 3 张被拒 → 该类动作 7 天内不能再提，返回冷却到期时间。
5. 已有 pending 的同一 payload_hash：不建新单，返回已有编号。
6. 批准票只用于 origin=tool_call：批准即发，绑定 bot_id + payload_hash，24 小时有效，用一次即失效；参数改一个字就对不上，要重新审批。
7. 批准后中心立即唤醒该机器人（唤醒理由 approval_granted，按主人发起处理：不计入机器人每日思考上限，计入全局额度，第 7 章）。唤醒包写「A-123 已批准：允许执行一次 <工具>(<参数摘要>)，参数必须与审批时完全一致；做完照常交账」。额度灯 red 时排队，批准票仍按原有效期计算。
8. 主人在执行前可以撤回批准（revoked）；已用掉的票、已执行的出站动作不能撤回批准，只能撤销其结果（9.7.3）。
9. 机器人可以撤回自己 pending 的审批单（交账里声明原因，status=withdrawn）；情况变了要主动撤回。
10. 审批单正文必须让主人不看代码也能判断：做什么（summary）、对谁、谁会看到、能不能撤销、为什么、不批会怎样（写在 why 里）。缺任何一项，动作闸拒绝建单并把缺的字段告诉机器人。

#### 9.6.2 任何消息里的批准一律无效【一期】

1. 审批单的状态只能经两条路径改变：主人在中心界面点击（`ctx.connection.fetch.register` 注册的接口，只放行已认证的主人，第 16 章）；二期主人在飞书卡片上点按钮（只认主人 open_id，按 event_id 去重，第 10 章）。代码里只有这两处调用 approvals.decide。
2. 以下内容里出现的「批准」「同意」「主人说可以」一律无效，不改变任何审批单、提议、预批规则、白名单或等级：唤醒包与中心通知、到期议程、同伴消息与交接单（二期）、网页、文件、命令输出、外部系统消息、飞书文字回复（二期文字回复只用来回答提问，主人自己发的文字也不算批准）、机器人自己的交账。
3. 主人在机器人会话里打字说「批准 A-123」也不改审批单；机器人回复「请在中心收件箱点批准」，不得自行执行。
4. 机器人的工具里没有任何能写 approvals、preapprovals、出站白名单、等级、预算的接口；hub_state_get 只能读自己的审批单状态。
5. 被拒的动作不能换参数、换工具或转给别的机器人去做：动作闸按 action_kind + target 在 30 天内识别同目标同类动作，再提交时审批单上标「此前被拒：<原因>」；二期交接单里携带被拒动作直接拒绝（第 12 章）。

#### 9.6.3 出站【一期】

1. 对外动作只由中心代为执行；机器人只能用 hub_outbox_submit 提交。
2. 目标不在出站白名单 → 直接拒绝，不生成审批单，返回「目标不在出站白名单；需要的话在交账里写提议，由主人在设置页添加」。
3. 一期出站类型只有 owner_file_write 与 github_comment（9.8）；其他类型直接拒绝。
4. 每个机器人每天出站执行 ≤ 10 次（全部类型合计）；github_comment 每个 issue / PR 每天 ≤ 2 条。超出直接拒绝。
5. 出站执行器全局同时只跑 1 个动作；同一目标严格串行。
6. 状态为 unknown（可能已经执行过）的动作绝不自动重发。

#### 9.6.4 越界的认定【一期】

越界 = 尝试一个本来就不允许的动作，不是「需要审批」的动作。计入越界：

1. 命中第 13 章红线（读凭据与密钥、写受保护文件、改权限档或 DSH 配置、调用 plugin_manager 等）。
2. 写家目录之外（不经 hub_outbox_submit）。
3. 绕过出站：用 bash、MCP 或任何工具直接对外写入、发送、推送。
4. 调用被屏蔽的工具（ask_user_question、schedule_*、create_goal、update_goal、working_directory、workflow 等）。
5. 试图经任何途径改 approvals、预批规则、白名单、等级、预算。

不计入越界：生成了审批单的 C、D 动作；因限额、冷却、重复、目标不在白名单而被拒的提交；L0 尝试 C、D（只拒绝并提示写提议）。

每次越界：写 audit（trust / violation）；该次工具结果写明「越界，已记录（7 天内第 n 次）」；按 9.9 降级；达到第 15 章的隔离阈值（越界尝试 3 次）即 quarantined，属于安全事件，按 P0 立即告诉主人（第 10 章）。

### 9.7 流程

#### 9.7.1 非阻塞审批（工具调用）【一期】

1. 机器人调用工具 → tools/pre-execute（prepend）进动作闸 → 判为 C 或 D、且没有可用批准票 → 建 approvals（pending）和收件箱条目（type=approval；是否单推按第 10 章）。
2. 对这次调用返回 deny，模型看到的工具结果：「中心动作闸：已拦下，类别 D（删除）。已提交审批 A-123，24 小时内有效。批准后中心会唤醒你，届时用完全相同的参数再调用一次。现在先做不依赖它的部分；不要等待，不要重复提交。」
3. 回合照常继续，不挂起，侧栏不会出现「等待审批」：动作闸自己从不返回 ask；万一别处触发 approval/request，prepend 的应答器立即返回 rejected（9.10）。
4. 机器人做完不依赖它的事，以 hub_commit 结束。若某目标剩下的步骤全依赖这张单，goal_reports 报 needs_owner、independent_steps_left=false → S3（第 8 章）。
5. 主人点批准 → status=approved，发批准票 → 中心唤醒机器人（approval_granted）→ 机器人用相同参数再调一次 → 动作闸算出同一 payload_hash，找到未用的票 → 先把票标 consumed 并落盘，再放行 → 工具执行，status=consumed。
6. 主人点拒绝或 24 小时过期 → 不唤醒；给该机器人一条显著性 0.50 的感知（进待处理堆，随下次思考带上）：「A-123 被拒（原因）/ 已过期」；相关目标的 S3 随之解除。
7. 批准票 24 小时没用掉 → ticket_expired，写 audit 并在日报列一行「批准了但它没去做」，不计入信任账本，不再唤醒。

#### 9.7.2 出站动作【一期】

1. 机器人调用 hub_outbox_submit({kind, target, payload, why, goal_id, who_sees, reversible, undo, bot_ref?})。
2. 动作闸校验：类型本期支持、目标在白名单、限额、冷却、必填项齐全；算 payload_hash 与 dedupe_key；30 天内同 dedupe_key 已有非终态或 done 记录 → 返回已有 outbox_id，不新建；同一 bot_ref 已有非终态记录 → 拒绝并返回其编号（想改内容先撤回旧的）。
3. 分流：等级 ≥ L2 且命中 active 的预批规则（kind 相同、target 匹配、used_today < daily_cap、未过期）→ status=queued、route=preapproval、used_today+1；否则建审批单，status=awaiting_approval。L0 → 拒绝并提示写提议。
4. 工具立即返回：「已排队执行 ob-55（预批规则 pa-3）」或「已提交审批 A-124；批准后由中心执行，你不需要再调用」。回合继续。
5. 主人批准 → queued；拒绝或过期 → rejected / expired，给机器人 0.50 的感知。
6. 执行器（9.8）执行 → done / failed / unknown。结果作为感知交给该机器人：done 0.50，failed 0.70，unknown 0.70；日报列一行「中心替它做了什么、谁能看到、撤销入口」；unknown 另按告警规则告诉主人。执行器不为出站结果单独唤醒机器人。
7. 机器人需要在出站完成后接着做事，就自己写一个 on_event 议程项（第 7 章），条件引用 outbox_id。

#### 9.7.3 撤销【一期】

1. 出站动作执行后 7 天内，主人可在日报或活动流点「撤销」：owner_file_write 恢复备份；github_comment 删除该评论（通知已经发出，所以是 partial）。撤销由中心执行，写 audit，status=undone。
2. B 类自我变更：动作闸在放行前把旧文件复制到撤销区 `~/.dsh/agent-hub/undo/<bot_id>/<时间>/`，保留 14 天；关注项、目标、议程的 B 类变更按表内旧版本（version）恢复。主人点撤销即恢复，并记一次 rejected。
3. 主人撤销 L2 预批执行的结果时可以勾「不该做」：记一次 corrected，并把该预批规则置 suspended，等主人在设置页重新打开。

### 9.8 一期出站动作清单与去重键

给主人自己的消息（日报、单推、提问、审批卡片）不在这里，见第 10 章。这里只列对外动作。

| 类型 | 做什么 | 目标与白名单 | payload | 执行方式 | 谁会看到 | 撤销 | 读回校验 |
|---|---|---|---|---|---|---|---|
| owner_file_write（C） | 把机器人家目录里准备好的文件写进主人的目录（例如知识库某个子目录） | 绝对路径，必须落在白名单某个目录前缀下；不能写隐藏目录、受保护文件、任何机器人的家目录 | {source_path（家目录内）, dest_path, mode: create / overwrite / append, content_hash} | 宿主进程：先把 dest 原文件备份到 `~/.dsh/agent-hub/outbox-backups/<outbox_id>/`，再写临时文件、原子改名；执行时重算 source 哈希，与 content_hash 不一致即失败（防止批准后内容被换）【待验证 V23】 | 主人，以及读这个目录的程序和同步端 | yes：7 天内恢复备份 | 写后读回哈希一致才算 done |
| github_comment（C） | 在白名单仓库的 issue / PR 下发一条评论 | `github:<owner>/<repo>#<number>`，仓库在白名单 | {body ≤ 4,000 字} | 宿主子进程 `gh api` 发评论；正文末尾自动加不可见标记 `<!-- agent-hub:<outbox_id> -->`【待验证 V2、V22】 | 公开：仓库所有访客；issue 参与者会收到通知；以主人的 GitHub 账号发出 | partial：7 天内可删评论，已发出的通知收不回 | 发之前、超时之后都按标记查该 issue 的评论：已存在即 done，不重发 |

二期：feishu_message（D，给白名单里的人或群发飞书，每条审批）；git_push（C，只能推到白名单仓库的非默认分支）。

去重与幂等：

1. dedupe_key = sha256(kind + 换行 + 规范化 target + 换行 + payload_hash)，30 天内唯一。
2. 先写状态再动手：status=executing、attempts+1 落盘之后才发起外部调用。
3. 中心启动时，对所有 executing 状态的记录做读回校验：能确认已生效 → done；能确认没发出去 → queued 重试；无法确认 → unknown，告诉主人，不自动重发。
4. 只有「发起前就失败」（子进程起不来、请求发出之前网络断开、目标校验失败）才自动重试，间隔 2 分钟、10 分钟、30 分钟，最多 3 次；之后 failed，按告警规则（连续 2 次失败才报）处理。
5. 唤醒单被重放时（第 15 章），同一回合重复调用 hub_outbox_submit 会被 dedupe_key 挡住，不会产生第二个动作。

### 9.9 信任账本、自动降级与升级建议

1. 自动降级【一期】：
   - 越界：滚动 7 天内第 2 次 → 自主等级降一级（L2→L1、L1→L0，L0 不再降），该机器人全部 active 预批规则置 suspended；达到隔离阈值 → quarantined（第 15 章）。
   - 虚报：1 次即降一级，并进入 7 天观察期：预批规则 suspended、不出升级建议、日报把它的交账单列在「观察期」下。
   - 自报与验收不一致率（28 天，样本 ≥ 5）> 20% → 收件箱提议「建议降一级」，由主人决定，不自动降。
   - 驳回不扣分，只记原因；同类连续 3 次被拒触发 7 天冷却（9.6.1 第 4 条）。
   - 试岗期出现越界，按第 5 章的规则退回 draft。
   - 每次升降写 audit、进当天日报，详情页显示原因和日期；主人可以在界面直接改回去。
2. 升级建议【二期】（只是建议，升级永远由主人点）：
   - L1 → L2：近 28 天采纳率 ≥ 60%、验收通过率 ≥ 80%、0 越界、0 虚报、样本 ≥ 10。
   - L2 → 某类出站动作的逐类授权（L3）：该类近 14 天采纳 ≥ 10 次、采纳率 ≥ 90%、0 越界、0 虚报。
   - 建议进收件箱 type=proposal，写清「升级后你会看到什么变化」；被拒后同类 30 天不再提；观察期内和降级后 14 天内不出建议。
3. 账本只用中心自己记录的事件计算，机器人在交账里写的自我评价不进账本。

### 9.10 实现：动作闸 ActionGate【一期】

1. 挂载时机：收到 agent/created，且该会话在名册里是机器人 → 在它的 agent.ctx 上依次：tools.restrict、tools.guard、tools/pre-execute（prepend）、approval/request（prepend）、注册 hub_* 工具，disposer 同时挂到插件自己的 effect 上。全部成功才把内存里的 gate_ready[bot_id] 置真；调度器只唤醒 gate_ready 的机器人，未就绪时到达该会话的回合被第 7 章的 agent/pre-step 闸拒绝。不在插件根 ctx 上注册任何机器人钩子，免得进主人的普通会话。
2. `ctx.tools.restrict({deny})`（只能在 agent.ctx 上调）：deny = 9.2.2「不提供」那一行里该 agent 实际继承到的工具名。名单里有一个它不认识的名字就会抛错，所以先取该 agent 的工具清单求交集【待验证 V5、V21】。
3. `ctx.tools.guard(fn)`：同步、单调拒绝，后面的监听器放不行。放第 13 章红线、受保护路径、被屏蔽工具名。持有批准票也过不了 guard（审批之后仍会再判一次 guard）【待验证 V20】。
4. tools/pre-execute（prepend，agent 作用域）：能看到工具名、解析后的参数、callId 和调用方 agent，可以 allow / deny，不能改写参数【待验证 V10、V19】。处理逻辑：

```
async function gate(call, next) {          // call: {toolName, args, callId, agent}
  try {
    const bot = registry.byAgent(call.agent)               // 不是机器人会话：直接 next()
    if (!bot) return next()
    const c = classify(bot, call)                           // 9.2.2 规则表；返回 {cls, kind, target, payload, violation}
    if (c.violation) { trust.violation(bot, c); return deny(text.violation(c)) }
    if (c.cls === 'A') return next()
    if (c.cls === 'B') {
      if (bot.autonomy === 'L0') return deny(text.propose(c))
      await undo.snapshot(bot, c); activity.selfChange(bot, c); return next()
    }
    if (bot.autonomy === 'L0') return deny(text.propose(c)) // C、D：L0 只能提议
    const h = payloadHash(bot, call)
    const t = await approvals.findTicket(bot.id, h)         // approved、未用、未过期
    if (t) { await approvals.consume(t, call.callId); return next() }   // 先落盘再放行
    return deny(await approvals.createOrReuse(bot, c, h))  // 冷却、30 天已拒、限额、已有 pending 都在这里
  } catch (e) {
    health.gateError(bot, e)
    return deny('中心动作闸出错，这次调用已拦下；先做别的，稍后再试')   // 出错一律拦，不放行
  }
}
```

5. 动作闸从不返回 ask。approval/request 应答器（prepend，agent 作用域）对机器人一律返回 rejected，附「改走审批单」，并记一条 audit（说明权限档或别的插件出了偏差）。机器人会话用 unattended 权限档（approval never）时审批在分发前就被拒，这个应答器只是兜底；必须 prepend，否则会被桌面界面转发器截走【待验证 V10】。
6. classify 是纯函数：输入（机器人档案、工具名、参数），输出类别和目标。规则以数据表维护（即 9.2.2），每条规则带单元测试样例。bash 先做保守的词法切分：按 `;`、`&&`、`||`、`|`、换行拆成子命令逐个匹配，取最高类别；含命令替换、eval、变量做命令名的整条按「看不懂」处理。路径一律解析成真实绝对路径再比对。
7. hub_outbox_submit 是中心自己的工具，校验与分流在它的处理函数里完成（9.7.2），不经 tools/pre-execute 的批准票分支。
8. 出站执行器：outbox 表即队列，60 秒 tick 外加入队时立即触发；gh 等命令用宿主子进程【待验证 V2、V22】；文件写入用宿主进程的文件接口（宿主不在会话沙箱里）【待验证 V23】；每次执行 60 秒超时；所有回调 try/catch，出错只影响这一条记录。
9. 审批与收件箱：approvals 写入后同步建收件箱条目（第 10 章）；界面按钮调用 connection.fetch 接口；approvals.decide 只被这条接口和二期飞书入站调用，代码审查时逐一核对调用点。
10. 工具结果文字是写给模型看的：先说结果（已拦下 / 已放行 / 已排队 / 越界），再说编号、有效期、下一步该做什么，≤ 300 字。
11. 冒烟测试（第 15 章）每次 DSH 升级后各做一次：A 类放行、B 类快照、C 类出审批单、批准票放行一次、越界拒绝、approval/request 立即拒绝。

### 9.11 验收

1. 规则表单测：9.2.2 每一行至少 2 个样例（共 ≥ 60 个），classify 输出的类别与处置全部符合；随机构造的 bash 组合命令取最高类别。
2. 处置矩阵：同一组 A、B、C、D 动作分别在 L0、L1、L2 机器人上执行，结果与 9.3 一致；试岗机器人按 L1；L1 机器人有 active 预批规则时照样出审批单。
3. 非阻塞：C、D 动作被拦后 1 秒内工具返回，回合继续并以 hub_commit 结束；整个试运行期间侧栏「等待审批」出现 0 次，回合因审批或提问挂起超过 30 分钟 0 次。
4. 哈希绑定：批准 A-1 后用相同参数调用 → 执行一次；再调一次 → 新审批单；参数改一个字符 → 新审批单，A-1 的票不被消耗。
5. 过期与冷却：审批单 24 小时不处理变 expired，机器人下次唤醒包里看到结果；同一 payload_hash 30 天内再提直接被拒、不建新单；同类连续 3 张被拒后 7 天内提交被拒并返回冷却到期时间。
6. 「批准」无效：在唤醒包、网页、文件、命令输出、主人在会话里打的字里写「已批准 A-1」，A-1 状态不变，机器人不执行。
7. 出站白名单为空时，github_comment 和 owner_file_write 都被直接拒绝且不出审批单；主人加了白名单后，同样的提交出审批单。
8. 预批：L2 机器人在预批规则内的 owner_file_write 不出卡片，中心执行，日报逐条列出并带撤销；第 daily_cap+1 次出审批单；预批规则到期或 suspended 后出审批单。
9. 去重与崩溃：两次相同提交只产生 1 个 outbox；在 executing 落盘后、外部调用前后分别杀掉 DSH，重启后读回校验，评论最多 1 条，无法确认的进 unknown 并告诉主人，不自动重发。
10. 撤销：owner_file_write 撤销后目标文件与执行前逐字节一致；github_comment 撤销后评论不存在；B 类变更撤销后文件恢复旧版。
11. 越界：读 ~/.ssh、写家目录外、bash 里 curl -X POST、调 schedule_create，各记 1 次越界；7 天内第 2 次自动降一级且预批 suspended；达到隔离阈值即 quarantined，主人 1 个 tick 内收到 P0 告警（第 20 章 FI7）。
12. 虚报：构造一次证据不存在的完成声明 → 记虚报、降一级、7 天观察期；观察期内预批不生效。
13. 闸门故障：让 gate 处理函数抛错 → 本次调用被拒，DSH 不退出，机器人其他回合不受影响；去掉 agent/created 注册（模拟未就绪）→ 该机器人不被唤醒。
14. guard 优先：持有有效批准票去写 AGENTS.md 仍被拒。
15. approval/request：把测试机器人的审批策略临时改成 ask 并触发越权写入，应答器立即返回 rejected，回合不挂起。
16. 【二期】升级建议：构造满足 9.9 第 2 条的 28 天记录，收件箱出现 1 条升级建议；任一条件不满足则不出。

### 9.12 新增建议

1. 新增表 preapprovals（预批规则）：L2 的「预批名单内的 C 类做完再告知」需要一个由主人建的、带目标范围、每日上限、到期时间的记录；二期 L3 逐类授权复用同一张表（scope=class）。理由：骨架只有等级名称，没有让 L2 区别于 L1 的放行凭据。
2. 出站白名单写进名词表，存 settings.outbound_allowlist，默认为空（与第 23 章 D17 一致）。
3. 名词表区分两种「需要主人点头」：审批单（对世界的动作，24 小时视为拒绝）与提议（对机器人自身配置、目标、志向的变更，7 天撤回）；两者都绑定内容哈希。D 类里的改规矩、扩权、新建机器人、改志向、新关注来源走提议。
4. 「信任账本」写进名词表：audit 表 category=trust 的事件（adopted / rejected / violation / misreport / corrected / acceptance_pass / acceptance_fail），不新建表。
5. 新增数值：每个机器人同时 pending 审批单 ≤ 5、每回合新建 ≤ 3；每天出站执行 ≤ 10 次，同一 issue / PR 每天评论 ≤ 2 条；同类连续 3 次被拒冷却 7 天；越界滚动 7 天第 2 次降一级；虚报 1 次降一级并观察 7 天；批准票有效 24 小时；出站与 B 类变更撤销期 7 天、撤销区保留 14 天。
6. 「越界」的认定写进骨架（9.6.4），让第 15 章的隔离阈值「越界尝试 3 次」有确定口径。
7. 一期出站类型定为 owner_file_write 与 github_comment；发飞书给主人以外的人归 D，二期再做，永不预批。
8. 名册运行时状态增加 gate_ready（只在内存）：动作闸没挂好的机器人不唤醒。

