# 底稿：业界主动型个人 Agent 的做法与坑

> 研究底稿（2026-11-04）。这一路没有读 DSH 源码，只查了公开资料和用户个人知识库；涉及 DSH 现状的说法以 01–07 号底稿为准。事故和成本数字多为二手报道，已在各条注明出处。

## 总结

结论：能做。2025–2026 年业界已经把「一群主动型个人 Agent」拆成一套比较成熟的部件，DSH 可以照着补。最接近的参照有四个。一是 OpenClaw 2026 版的 automations：旧 heartbeat 已退役，改成作业系统，带门控脚本、静默暗号 NO_REPLY、无人值守契约、五种结果状态、失败去重报警和自动停用，并且每个 agent 有独立的工作区、凭据、工具和沙箱。二是 Claude Code：/goal 用另一个模型判断目标是否达成并能检测空转；定时分云端、Desktop、会话内三档；agent view 是按状态分组的收件箱；agent teams 有共享任务表和邮箱。三是 Paperclip 提供组织层：目标链、预算警戒与硬停、单一负责人加执行锁、审计。四是 Letta、Hermes、Anthropic memory tool 提供记忆层，LangChain 的 notify/question/review 和 Agent Inbox 提供人机接口。

难点不在「能不能定时叫醒」，而在六件事：
- 叫醒前先做便宜检查，没事就静默。否则 5 小时额度会被巡检烧光；用户 2026-10-16 就因目标钩子一天唤醒 57 次，在 18:34 用光额度。
- 目标写成「可验证终态 + 独立评估 + 停止条件」，否则会反复说「仍未达成」。
- 每个机器人有独立的工作区、模型、工具白名单、权限档位和预算；定时作业不能默认继承主人的全部权限。
- 机器人之间用共享看板、认领锁和结构化交接；互发消息有回合上限，消息里的「批准」一律无效。
- 人只在通知、提问、审核三种时刻出现。日常产出汇总成每日一份，连续失败才单独报警。
- 调度器放在关窗、休眠、重启后还在运行的常驻进程里，并有补跑、幂等和看门狗。

Project Vend 和 AI Village 是「有目标的长期自主 agent」最好的真实失败样本：写死流程清单比加一个同模型主管更有效；互相附和会扩散幻觉；agent 会编造进度，还会主动给陌生人发邮件。

起步建议：先做 2–3 个机器人，每日节奏，日报汇总，每个机器人设预算硬停，跑稳再扩。

证据说明：OpenClaw、Claude Code、Letta、z.ai 的机制细节来自 2026-11-04 查阅的官方文档；Paperclip 来自官方 README；Hermes、Multica 多为 README 镜像或第三方文章；事故和成本数字多为二手报道或作者自述，已在各条标注。OpenClaw 文档变化快（heartbeat 已退役，HEARTBEAT.md 不再被读取），落地前要按版本复核。本路没有读 DSH 源码，凡涉及 DSH 现状的说法都需要源码那一路核实。

## 可借鉴的做法

### 唤醒方式分开管：一次性、周期、自定节奏、事件触发、话题触发

业界不再只靠「每隔 N 分钟醒一次」。OpenClaw 2026 年把旧心跳（每 30 分钟读一次 HEARTBEAT.md 清单）退役，统一改成自动化作业 automations，调度方式有五种：at 一次性、every 固定间隔、cron 表达式、on-exit（等某条命令结束时触发）、stream（盯着一个长期命令的输出，有新行就触发）。首次安装会自动建一个每 30 分钟的「Proactive check」作业。

还有一种「自定节奏」：设上下限 pacing.min/max，agent 在运行中用 next_check 提议下次检查时间，系统把它夹在上下限之内；聊天里 /loop 不给间隔时，在 1 分钟到 1 小时之间自己定节奏。

另有 standing intents（常驻意图）：不按时间跑，而是聊天里出现某个关键词时顺带提醒。匹配只靠关键词预筛，不调用模型；默认冷却 24 小时、最多触发 3 次、90 天过期。长期志向（aspirations）则写进 Markdown 并带复查日期，不放进定时器。

Claude Code 分三档：会话内 /loop（最短 1 分钟，7 天自动过期）、Desktop 本地定时任务、云端定时任务（可按时间、API 调用或 GitHub 事件触发）。需要立即响应事件时，文档建议用 Channels 把事件（如 CI 失败）直接推进会话，而不是轮询。Letta 用 letta cron add 加 --at、--every 或 --cron；Hermes 内置自然语言 cron。

**对 DSH 的启发**：对应 R2。DSH 机器人至少要支持四种唤醒：一次性、周期、带上下限的自定节奏、事件触发（新文件、新飞书消息、看板卡片状态变化）。长期目标和定时器要分开存。用户以前用 schedule 工具的 after 类型给会话定时复查，只是其中最简单的一次性提醒；DSH 是否已有周期、上下限、事件触发和目标复查日期，需要读源码的那一路核实。

**出处**：
- OpenClaw 官方文档 Automation schedules（五种调度、pacing、/loop、条件触发）：https://docs.openclaw.ai/automation/cron-jobs/schedules
- OpenClaw 官方文档 Heartbeat 迁移页（心跳已退役，首装默认建 30 分钟一次的 Proactive check 作业）：https://docs.openclaw.ai/heartbeat
- OpenClaw 官方文档 Standing intents（话题触发；默认 24 小时冷却、最多 3 次、90 天过期；aspirations 写 Markdown 并带复查日期）：https://docs.openclaw.ai/concepts/standing-intents
- Claude Code 官方文档 Run prompts on a schedule（三档对比、/loop、Channels 事件推送）：https://code.claude.com/docs/en/scheduled-tasks
- Letta 官方文档 Schedules：https://docs.letta.com/configuration/schedules
- Hermes Agent（Nous Research）README，内置 cron 调度：https://github.com/NousResearch/hermes-agent

### 先做便宜检查，再决定要不要叫醒模型；没事就静默

大白话：每次叫醒大模型，都要把人设、规则、历史一起发过去，哪怕只是确认一句「没事」，也很贵。现在的做法是在调用模型前加一道门：
- 门控脚本：OpenClaw 允许给作业挂一个只读检查脚本 trigger.script。脚本返回 fire:false 时，不调用模型，也不留运行记录。限制是最短 30 秒评估一次，每次 30 秒预算、最多 5 次工具调用。
- 空草稿就跳过：作业的草稿区为空时直接跳过（skipIfScratchEmpty）。
- 不调模型的作业：纯命令作业根本不调用模型；--light-context 跳过注入工作区引导文件。
- 静默暗号：模型醒来发现没事，就回约定暗号（旧版 HEARTBEAT_OK，新版 NO_REPLY），系统直接吞掉，不发消息。
- 不轮询：Claude Code 文档建议能用 Monitor 工具流式盯输出时就不要轮询。

反例：第三方报道称旧心跳每次重发约 12 万 token 的整段上下文，一夜跑了约 25 次 Opus 请求。另一个要注意的点：OpenClaw 的门控脚本以 agent 的完整工具权限（含 exec）无人值守运行，官方提供一个总开关可以一键关停。

**对 DSH 的启发**：对应 R2、R7，是对 DSH 最划算的一条。DSH 订阅每 5 小时有额度上限，十来个任务就打光。所以机器人醒来前，应先用规则或脚本判断有没有新东西，没有就不开会话；就算开会话，也只带最小上下文。

**出处**：
- OpenClaw 官方文档 Automation schedules（条件触发、fire:false 不调模型、skipIfScratchEmpty、总开关警告）：https://docs.openclaw.ai/automation/cron-jobs/schedules
- OpenClaw 官方文档 Automation payloads（命令作业不调模型、--light-context）：https://docs.openclaw.ai/automation/cron-jobs/payloads
- OpenClaw 官方文档 Automation delivery（NO_REPLY 抑制纯文本通知）：https://docs.openclaw.ai/automation/cron-jobs/delivery
- Claude Code 官方文档（Monitor 代替轮询）：https://code.claude.com/docs/en/scheduled-tasks
- Notebookcheck 二手报道：旧心跳重发整段上下文导致的空转成本：https://www.notebookcheck.net/From-hype-to-wallet-drain-OpenClaw-can-quietly-burn-hundreds-of-Dollars-per-day.1219925.0.html

### 无人值守运行契约：交付物优先、结果状态固定、定时触发不等于用户同意

OpenClaw 给定时运行写了一份「无人值守契约」：
- 这类回合没有人在场，不能澄清，也不能批准。
- 最后一条回复必须是交付物，不能是计划、「收到」或向人提问。
- 没有变化就记 no_change 并保持静默；同一个已知阻塞重复出现，也不再吵。
- 执行失败必须让人看得见。
- 每次运行用 record_result 报五种状态之一：no_change、progress、done、blocked、needs_attention。除 no_change 外都要附 1–2000 字的摘要；系统会把「上一次有意义的结果」带进下一次运行。
- 输出语言不会从聊天自动继承，必须写进作业 prompt 里。

Claude Code 云端定时任务文档有一条关键原则：触发时送来的 prompt 只证明这条指令事先存好了，并不是实时的用户输入，不能当作运行中任何动作的批准或同意。

**对 DSH 的启发**：对应 R3、R5、R7、R8。每个 DSH 机器人醒来时都应该带上这份契约。Agent 中心按这五种状态汇总展示。需要用户处理的事统一标成 needs_attention，不在会话里反复问。高危动作不能因为「这是我自己设的定时任务」就自动放行。用户是中文使用者，记得在作业里写明用中文输出。

**出处**：
- OpenClaw 官方文档 Automation payloads（Unattended run contract、record_result 五种状态、scratch）：https://docs.openclaw.ai/automation/cron-jobs/payloads
- OpenClaw 官方文档 Automation delivery（输出语言要写进作业）：https://docs.openclaw.ai/automation/cron-jobs/delivery
- Claude Code 官方文档 Automate work with scheduled tasks（触发的 prompt 不能作为批准）：https://code.claude.com/docs/en/routines

### 目标的写法：可验证的终态、独立评估者、停止条件

Claude Code 的 /goal：
- 用户写一个完成条件。每回合结束后，由另一个小模型判断是「未达成」「已达成」还是「不可能」；判为不可能会自动清除目标。
- 官方建议条件里写清三件事：一个可度量的终态、怎么证明、途中不许改什么；还可以加「最多 N 回合」的上限。
- 如果连续几回合只回话、不调用工具，就自动停下，把控制权交还用户。
- 有后台任务时，空闲检查的间隔每次加倍，最多 3 次。

Anthropic 的长时运行做法：
- 第一次会话先写三样东西：JSON 格式的功能清单（每项带 passes:false，之后只允许改这个字段；选 JSON 是因为模型较少乱改它）、进度文件 claude-progress.txt、初始 git 提交。
- 之后每次新会话：先读 git log 和进度文件，跑一遍端到端冒烟测试，再只做一项。

其他：Paperclip 把每个任务挂到公司目标上（goal ancestry），agent 总能看到这件事为什么要做。OpenClaw 把长期志向放在带复查日期的 Markdown 里。

**对 DSH 的启发**：对应 R3。每个机器人需要三件套：目标文件、可检查的完成判据、停止条件。停止条件至少要包括：已经在等用户回复、用户说停、当前没有不需要用户拍板就能推进的步骤、夜间时段——这四条正是用户 2026-10-17 自省里写过的。「达成没有」最好不让干活的机器人自己说了算。

**出处**：
- Claude Code 官方文档 /goal（三种判定、空转检测、写好条件的建议）：https://code.claude.com/docs/en/goal
- Anthropic 工程博客 Effective harnesses for long-running agents（2025-11）：https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Paperclip README（目标链、任务关联公司目标）：https://github.com/paperclipai/paperclip
- OpenClaw 官方文档 Standing intents（aspirations 带复查日期）：https://docs.openclaw.ai/concepts/standing-intents

### 每次唤醒用干净会话，进度和状态放在会话外

OpenClaw 的周期作业默认用 isolated 模式：
- 每次运行开一份新记录，只带上一次有意义的结果。
- 作业有私有草稿区 scratch：上限 256KiB，用版本号做「先读后写」防并发覆盖，明确禁止存密钥。
- 只有确实需要连贯上下文的流程（例如每日站会摘要）才用固定命名的会话。

Letta 的定时任务默认每次开新对话，理由是避免周期运行塞满主对话的上下文。Claude Desktop 的定时任务也是每次启动全新会话。

**对 DSH 的启发**：对应 R4、R9。DSH 机器人不要把所有唤醒都堆进同一个越聊越长的会话，那样会触发压缩、丢规则，还越跑越贵。进度写进文件或数据库，会话只当一次性工作台；这样关窗或重启之后也更容易接着干。

**出处**：
- OpenClaw 官方文档 Automation payloads（main、current、isolated、custom 四种会话与 scratch）：https://docs.openclaw.ai/automation/cron-jobs/payloads
- Letta 官方文档 Schedules（每次运行默认新对话）：https://docs.letta.com/configuration/schedules
- Claude Code Desktop 定时任务（每次运行新会话）：https://code.claude.com/docs/en/desktop-scheduled-tasks

### 分层记忆文件、压缩前先落盘、入库要有门槛和版本

- OpenClaw 工作区的固定文件：AGENTS.md（操作规则）、SOUL.md（人设、语气、边界）、USER.md（用户画像）、IDENTITY.md（名字与形象）、TOOLS.md（工具使用笔记，不控制权限）、BOOTSTRAP.md（首次启动仪式），以及每日记录 memory/YYYY-MM-DD.md。引导文件注入时有字符上限，超出会被截断。MEMORY.md 本次只在第三方资料里看到，官方文件列表没有列出。
- 压缩前落盘：上下文快满、自动压缩之前，OpenClaw 先跑一次静默的「记忆落盘」回合（agents.defaults.compaction.memoryFlush，默认开启，离压缩阈值约 4000 token 时触发，写入 memory/YYYY-MM-DD.md；只读工作区和心跳回合会跳过）。
- Letta：memory blocks（上下文里可编辑的固定段落）可以被多个 agent 共享；sleep-time agent 在后台整理主 agent 的记忆。主 agent 不能改自己的记忆块，只有后台那个能改。文档称默认每 5 步触发一次，触发太频繁会很贵，该功能标注为实验。
- Anthropic memory tool：让模型在 /memories 目录里读写记忆，配合「上下文编辑」清掉过期的工具结果。
- Hermes：MEMORY.md、USER.md 有字符上限，可设置为新建或修改技能前先经用户批准（第三方说法）。
- 经典参照 Generative Agents：记忆流、定期反思、计划三层结构。

**对 DSH 的启发**：对应 R4。给每个 DSH 机器人一个独立目录和一组固定文件。关键规则，尤其是安全红线，放在每次都注入的文件里，不放在聊天里。压缩前强制落盘。写入长期记忆要有门槛、能审查，并用 git 留版本；用户知识库收藏里的入库门槛和周审做法可以直接借用。

**出处**：
- OpenClaw 官方文档 Agent workspace：https://docs.openclaw.ai/concepts/agent-workspace
- OpenClaw 官方文档 压缩前记忆落盘 memoryFlush：https://docs.openclaw.ai/reference/session-management-compaction/housekeeping
- Letta 文档 Sleep-time agents：https://docs.letta.com/guides/agents/sleep-time-agents
- Letta 博客 Sleep-time compute：https://www.letta.com/blog/sleep-time-compute
- Anthropic memory tool 与上下文编辑（2025-09）：https://claude.com/blog/context-management
- Anthropic memory tool 文档：https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Hermes Agent README（memories 目录下的 MEMORY.md、USER.md，agent 自建技能）：https://github.com/NousResearch/hermes-agent
- Generative Agents 论文（2023）：https://arxiv.org/abs/2304.03442

### 每个机器人一套独立边界：工作区、凭据、会话、模型、工具、沙箱

OpenClaw 多 agent 模式下，每个 agent 有自己的工作区、agentDir（存凭据和模型注册）和会话库。在 agents.entries 下可以给每个 agent 单独设 model、sandbox（可以一个 agent 一个容器）、tools.allow/deny、skills；再用 bindings 把某个聊天渠道、账号或对象路由给指定 agent。内置记忆检索只搜本 agent 的来源，跨 agent 的 QMD 检索路径已在 v2026.8.1 移除。

官方同时提醒了几件事：
- 工作区只是默认目录，不是沙箱，用绝对路径能碰到主机。
- 不要让两个 agent 共用 agentDir。
- 插件自己的存储不会自动按 agent 拆开。
- 要严格隔离，得分开跑 Gateway。
- 定时作业如果不指定 --tools，每次运行都会沿用主人会话当时的全部工具权限。

Claude Code Desktop 的定时任务可以逐个设权限模式和「永久允许」清单，也能在详情页撤销。

**对 DSH 的启发**：对应 R1、R7。DSH 做 N 个机器人时，配置差异至少要覆盖工作目录、模型、工具白名单、权限档位，最好凭据也分开。「默认继承主人全部权限」是要专门避开的坑。用户踩过「某个会话插件换了存储后端，历史会话就消失」，所以插件存储是否按机器人隔离要专门核实。

**出处**：
- OpenClaw 官方文档 Multi-agent（agents.entries、bindings、tools、sandbox、隔离警告）：https://docs.openclaw.ai/concepts/multi-agent
- OpenClaw 官方文档 Automation payloads（--tools 不填即沿用主人工具权限）：https://docs.openclaw.ai/automation/cron-jobs/payloads
- Claude Code Desktop 定时任务（每个任务单独的权限模式与可撤销的永久允许）：https://code.claude.com/docs/en/desktop-scheduled-tasks

### 机器人之间协作：共享看板、认领锁、结构化交接；互发消息有上限，也不等于授权

- 回合上限：OpenClaw 的 sessions_send 允许两个 agent 来回对话，但有回合上限 maxPingPongTurns（默认 5，不同版本文档给的取值范围不一致）；被问的一方回 REPLY_SKIP 可以提前结束，回 ANNOUNCE_SKIP 可以不对外宣布。
- 互通范围：tools.agentToAgent.allow 限定哪些 agent 之间能互通。官方多 agent 文档说跨 agent 访问默认开启，列表为空就是全部放行。
- Paperclip：@ 提及本身不会分配工作，也不会叫醒对方；每个任务只有一个负责人，并有执行锁，防止两个 agent 认领同一件事。
- Claude Code agent teams：共享任务表（用文件锁认领，依赖完成后自动解锁），每个成员一个邮箱文件。收到别的 agent 的消息会标明来源；别的 agent 不能代用户批准，被拒的动作也不能转给队友去绕过。
- Cognition：并行的「多写手」会做出互相冲突的隐含决定，所以写操作保持单线程，其他 agent 只贡献判断。
- 用户收藏的牧之笔记：用「交接事件」代替群聊，交接期间只有接收方有写权限。

**对 DSH 的启发**：对应 R6。DSH 已有 taskboard 插件，可以当共享看板，但还要补六样东西：认领锁和单一负责人、交接单格式、互发消息的回合上限、默认不允许互相唤醒、消息里的「同意」或「批准」一律无效、同一资源只有一个 owner。

**出处**：
- OpenClaw session tool 文档（npm 包内 v2026.6.9 版，含 maxPingPongTurns、REPLY_SKIP）：https://cdn.jsdelivr.net/npm/openclaw@2026.6.9/docs/concepts/session-tool.md
- OpenClaw 官方文档 Multi-agent（tools.agentToAgent）：https://docs.openclaw.ai/concepts/multi-agent
- Paperclip README（提及不叫醒、单一负责人与执行锁）：https://github.com/paperclipai/paperclip
- Claude Code 官方文档 Agent teams（共享任务表、邮箱、agent 之间的消息不算授权）：https://code.claude.com/docs/en/agent-teams
- Cognition 博客 Don't Build Multi-Agents（2025-06）：https://cognition.ai/blog/dont-build-multi-agents
- Cognition 续篇（2026-04）：https://cognition.ai/blog/multi-agents-working

### 人只在三种时刻出现，统一进「待我处理」收件箱

LangChain 提出 ambient agents（在后台监听事件流、自己行动的 agent），以及三种人机交互：
- notify：只告诉你发生了重要的事，自己不行动。
- question：缺信息就问你，不瞎猜。
- review：要做的动作先给你，你可以批准、直接改或提意见；危险动作硬性要求 review。

他们为此单独做了 Agent Inbox，像邮箱加工单系统。理由是用 Slack 收通知容易被淹，没回复的消息越堆越多。

Claude Code 的 agent view 把所有后台会话按状态分组：需要输入、工作中、待审阅、已完成、失败；只在需要输入、完成或失败时通知，定时 /loop 会话只在需要输入时通知。OpenClaw 的 Control UI 有按 agent 分组的会话侧栏，以及一个显示状态和逾期警告的自动化页面。Multica 让 agent 像同事一样在看板上评论、报告阻塞。

**对 DSH 的启发**：对应 R5、R8。DSH Agent 中心的核心应该是一个「待我处理」收件箱，按 notify、question、review 分类，而不是 N 个聊天窗口。用户偏好「一条消息最多一个要我做的事」，可以直接变成 question 卡片的规则。

**出处**：
- LangChain 博客 Introducing ambient agents（2025-01，notify、question、review）：https://www.langchain.com/blog/introducing-ambient-agents
- LangChain Agent Inbox 开源仓库：https://github.com/langchain-ai/agent-inbox
- Claude Code 官方文档 Agent view（状态分组、按需通知）：https://code.claude.com/docs/en/agent-view
- OpenClaw 官方文档 Control UI：https://docs.openclaw.ai/web/control-ui
- Multica（agent 作为团队成员上看板，README 多为镜像）：https://github.com/multica-ai/multica

### 默认安静：汇总成摘要、连续失败才报警、去重加冷却、免打扰时段、数量上限

OpenClaw 的做法：
- 没事回 NO_REPLY，不发消息。
- 有失败通知路由的作业，默认连续 2 次失败才报警，同一原因 1 小时冷却，并合并成一个「事件」不重复报；成功后静默恢复。
- 瞬时故障先在 30 秒、1 分钟、5 分钟各重跑一次，三次都失败才报。
- 连续 10 次执行失败会自动停用，并发出停用通知。
- 用 activeHours 限定运行时段，夜间直接跳过。

ChatGPT Pulse：每天一次、几张卡片，刻意做成看完就结束，当天过期，用点赞点踩调整内容。ChatGPT Tasks 和 Gemini Scheduled Actions 都把同时活跃的定时任务限制在 10 个（媒体报道）。

**对 DSH 的启发**：对应 R5、R8。多个机器人的产出应该汇总成每天一份摘要，只有「需要你」或「连续失败」时才单独打扰。这正好落实了用户 2026-11-02 自省提出、还没立项的「每天早上一条状态消息」。

**出处**：
- OpenClaw 官方文档 Automation delivery（失败告警、冷却、去重、自动停用）：https://docs.openclaw.ai/automation/cron-jobs/delivery
- OpenClaw 官方文档 Automation schedules（activeHours）：https://docs.openclaw.ai/automation/cron-jobs/schedules
- OpenAI Introducing ChatGPT Pulse（2025-09）：https://openai.com/index/introducing-chatgpt-pulse/
- TechCrunch 对 Pulse 的报道：https://techcrunch.com/2025/09/25/openai-launches-chatgpt-pulse-to-proactively-write-you-morning-briefs
- Neowin（ChatGPT Tasks 活跃任务上限 10、Gemini Scheduled Actions）：https://www.neowin.net/amp/google-gemini-challenges-chatgpt-with-new-scheduled-actions-feature/

### 把预算、并发和额度当成头等大事

- Paperclip：支持公司、agent、项目三级预算，到警戒线提醒，到上限硬停。不过它依赖上报的花费，进行中的工作可能晚一点才停。
- Claude Code：/goal 的状态里能看到已用 token。云端定时任务每个账号每小时最多 100 次定时运行，每个任务每小时最多 30 次手动或 API 触发，并且和交互会话共用订阅额度。agent teams 文档说 token 随队友人数线性增长，建议从 3–5 个开始。
- Anthropic 自述：普通 agent 约为聊天的 4 倍 token，多 agent 研究系统约 15 倍。
- z.ai 的 GLM Coding Plan：额度按 credits 计，分 5 小时和每周两层；工作日 14:00–18:00（UTC+8）是高峰，非高峰按标准的 50% 计。

**对 DSH 的启发**：对应 R7、R9。DSH 需要三样东西：每个机器人的 5 小时或每日预算、全局并发上限、超额自动暂停。能挪的活排到非高峰（前提是 DSH 实际用的就是 GLM Coding Plan）。用户控制桥出现过「活动会话已达上限 2」，说明并发名额本身就稀缺，应该排队，不抢，也不取消别人的会话。

**出处**：
- Paperclip README（预算警戒与硬停）：https://github.com/paperclipai/paperclip
- Claude Code 云端定时任务的用量与限制：https://code.claude.com/docs/en/routines
- Claude Code agent teams（token 随人数线性增长，建议 3–5 个）：https://code.claude.com/docs/en/agent-teams
- Anthropic How we built our multi-agent research system：https://www.anthropic.com/engineering/multi-agent-research-system
- z.ai GLM Coding Plan 概览（5 小时与每周额度、非高峰半价）：https://docs.z.ai/devpack/overview

### 调度器放在哪里，决定了关窗、休眠、重启后还跑不跑

- Claude Code 官方对比：
  - 云端任务：不需要开机。
  - Desktop 本地任务：要开机且 App 开着。电脑睡着时那次直接跳过；醒来后，只为 7 天内最近一次错过的时间补跑一次。官方提醒在 prompt 里写时间护栏，因为 9 点的任务可能晚上 11 点才补跑。
  - 会话内 /loop：关会话就停，7 天自动过期，不补跑。
- Letta：本地 cron 只在 CLI 或 server 进程开着时触发；一次性任务过时超过 5 分钟，记为 missed。
- OpenClaw：调度器跑在常驻的 Gateway 进程里，状态存在 SQLite。重启后，过期作业重新排期，而不是立刻重放；被打断的运行只重试一次，并要求先核对已经做过的工作。文档明确说工具副作用不保证「恰好执行一次」，可能已经发出的消息不会自动重发。隔离回合有 60 分钟看门狗（超时自动终止）。
- Claude Code agent view：后台会话由独立的 supervisor 进程托管，崩溃会自动拉起，休眠后恢复，关机后标为失败但可以续跑；无人连接约 1 小时的空闲会话会停掉进程，对话保留在磁盘上。

**对 DSH 的启发**：对应 R9。DSH 是 Electron 桌面 App；如果调度和会话都挂在窗口进程上，关窗或退出就停。用户 2026-10-23 电脑睡眠约 4.5 小时，三条后台线一起停过。可参考的组合：常驻后台进程（用户验证过 dsh headless 加 --patch 能跑）、系统级保活、补跑策略、动作幂等。DSH 的调度实际在哪个进程里，需要源码那一路核实。

**出处**：
- Claude Code 官方文档（三档调度对比与限制）：https://code.claude.com/docs/en/scheduled-tasks
- Claude Code Desktop 定时任务（睡眠跳过、7 天内补跑一次、保持唤醒设置）：https://code.claude.com/docs/en/desktop-scheduled-tasks
- Letta 官方文档 Schedules（本地 cron 只在进程运行时触发）：https://docs.letta.com/configuration/schedules
- OpenClaw 官方文档 How automations work（Gateway 内调度、对账、看门狗）：https://docs.openclaw.ai/automation/cron-jobs/how-it-works
- Claude Code 官方文档 Agent view（supervisor 托管与崩溃拉起）：https://code.claude.com/docs/en/agent-view

### 上岗前先试跑一次，并预先批好权限

OpenClaw 把用户反复提的请求升级成自动化时，分三步：先用大白话复述日程和任务；用户确认后再创建；立刻强制跑一次作为可见的测试，测试失败就删掉这个作业。

Claude Desktop 的建议是：新任务建好后先点 Run now，盯着权限弹窗，逐个选「永久允许」，以后这个任务就自动通过。在 Manual 模式下，遇到没批过的工具，运行会一直卡住等人；被标记为每次都要人确认的 MCP 工具，每次都会卡住。

**对 DSH 的启发**：对应 R1。批量生成机器人时，每个机器人都要过「复述、试跑、预批权限」三步，否则无人值守时会卡在权限弹窗上，或者悄悄失败。

**出处**：
- OpenClaw 官方文档 How automations work（复述、确认、强制试跑一次、失败即删）：https://docs.openclaw.ai/automation/cron-jobs/how-it-works
- Claude Code Desktop 定时任务（Run now 与永久允许）：https://code.claude.com/docs/en/desktop-scheduled-tasks

### 写死流程清单比再加一个「主管 agent」管用；监督要换一双眼睛

Anthropic 的 Project Vend 第二阶段，给 AI 店主加了 CRM、成本记录、「报价前必须核实成本和交期」的流程，还加了一个 CEO agent。结果：
- 效果最大的是流程。
- 把周边商品拆给单独的 agent 也有效。
- 同一模型的 CEO 和店主盲点一样：批准宽松请求的次数约为拒绝的 8 倍，还有人用伪造的「新 CEO 当选」说法夺了权。

AI Village（让多个 agent 长期追目标的公开实验）里，一个 agent 编出 93 人的联系人名单，其他 agent 跟着信，浪费了 8 小时以上；互相附和会把一个 agent 的幻觉扩散到全组。

**对 DSH 的启发**：对应 R3、R6。与其给机器人再配一个「主管机器人」，不如给每个机器人写硬性流程和检查清单。需要监督时，用不同的模型、确定性规则或者人。

**出处**：
- Anthropic Project Vend phase two：https://www.anthropic.com/research/project-vend-2
- AI Village 2025 年总结：https://aivillageblog.substack.com/p/what-we-learned-2025

### 按风险三要素给每个机器人定档

Simon Willison 的「致命三要素」：一个 agent 如果同时能读私密数据、会接触不可信内容、能对外通信，就容易被提示注入（藏在网页、邮件、文档里的恶意指令）利用来偷数据。

Meta 2025-10 提出的 Agents Rule of Two：在还没法可靠拦截提示注入之前，一个会话里最多同时具备三项中的两项——处理不可信输入、访问敏感数据或系统、改变状态或对外通信。Meta 也说明这只是补充，不能替代最小权限等基本原则。

OpenClaw 安全文档要求：外部内容一律视为不可信；多 agent 时每个 agent 一个访问档位；用 openclaw security audit 检查配置是否偏离安全设置。

**对 DSH 的启发**：对应 R5、R7。DSH 建机器人档案时，就标出它占三项里的哪两项。例如「读飞书群消息 + 读本地文件」的机器人不能直接对外发消息，发送要走 review；「能对外发消息」的机器人就不读不可信内容。

**出处**：
- Simon Willison The lethal trifecta（2025-06-16）：https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Meta Agents Rule of Two（2025-10-31）：https://ai.meta.com/blog/practical-ai-agent-security/
- OpenClaw 官方文档 Gateway security：https://docs.openclaw.ai/gateway/security

## 常见的坑

### 成本与额度失控：周期巡检每次都把人设、规则、历史整段重发给模型；多机器人、多 agent 协作把 token 成倍放大；订阅额度被后台任务悄悄吃光。

**缓解**：
- 唤醒前先跑只读检查脚本或规则，没有新情况就不调用模型。
- 没事就回静默暗号，不发消息。
- 周期任务用隔离会话加最小上下文。
- 零散检查合并成每日一次。
- 每个机器人设 5 小时和每日预算，加全局并发上限；到警戒线提醒，到上限自动暂停。
- 能挪的活排到非高峰。
- 巡检可以换便宜模型，但要盯着重试次数，小模型反复失败可能反而更贵。

**出处**：
- Notebookcheck（二手报道：旧心跳每次重发约 12 万 token、一夜约 25 次 Opus 请求）：https://www.notebookcheck.net/From-hype-to-wallet-drain-OpenClaw-can-quietly-burn-hundreds-of-Dollars-per-day.1219925.0.html
- Anthropic 多 agent 研究系统约为聊天的 15 倍 token：https://www.anthropic.com/engineering/multi-agent-research-system
- Engadget（2025-07，Anthropic 因有人 24/7 后台跑 Claude Code 加周限额）：https://www.engadget.com/ai/anthropic-is-rate-limiting-claude-code-blaming-some-users-for-never-turning-it-off-211134730.html
- OpenClaw 条件触发 fire:false 不调模型：https://docs.openclaw.ai/automation/cron-jobs/schedules
- z.ai 非高峰半价：https://docs.z.ai/devpack/overview
- 用户日记 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/journal/2026-10-17.md（记录 2026-10-16 目标钩子唤醒 57 次、18:34 额度耗尽）

### 空转复读：目标暂时达不成，或正在等用户拍板时，「没达成就继续」的机制反复叫醒机器人，产出一串「仍未达成，明天继续」，既烧额度又刷屏。

**缓解**：
- 目标写成可测的终态，并写明停止条件：已向用户提问在等回复、用户说停、当前没有不需要用户拍板的步骤、夜间时段、最多 N 回合。
- 连续几回合没有实际工具调用，就自动停下交还控制权。
- 已知阻塞重复出现时保持安静。
- 空闲检查用退避（间隔逐次拉长），并设次数上限。
- 把持续性目标改写成「当天做完并汇报即算达成」这类能关闭的日目标。

**出处**：
- 用户日记 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/journal/2026-10-22.md（28 分钟被叫醒约 24 次，约 20 遍「目标 1 仍未达成」）
- 用户日记 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/journal/2026-10-28.md（改为「当天做完并汇报即算达成」后，每小时唤醒由 8 次降到 1 次）
- Claude Code /goal 文档（空转检测、空闲检查最多 3 次且间隔加倍）：https://code.claude.com/docs/en/goal
- OpenClaw 无人值守契约（重复的已知阻塞保持安静）：https://docs.openclaw.ai/automation/cron-jobs/payloads

### 通知轰炸：每个机器人各自汇报、各自提问，真正需要用户拍板的一条被几条催促顶下去；主动提醒太频繁会打断人的工作流。

**缓解**：
- 只在 notify、question、review 三种时刻打扰。
- 日常产出汇总成每日一份摘要。
- 需要拍板时，一条消息只问一件事。
- 连续失败 N 次才报警；同一原因合并，并设冷却。
- 设免打扰时段。
- 收件箱把「需要你」排在最前。
- 界面上显示机器人正在做什么，降低突兀感。

**出处**：
- 用户日记 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/journal/2026-10-20.md（12:31 的汇报被 9 条钩子催促顶上来，17:54–17:56 两分钟 9 条）
- LangChain ambient agents：https://www.langchain.com/blog/introducing-ambient-agents
- OpenClaw delivery（连续 2 次失败才报、1 小时冷却、同因合并）：https://docs.openclaw.ai/automation/cron-jobs/delivery
- Pu 等 CHI 2025（主动式编程助手提效，但会打断工作流；加在场提示和交互上下文可以缓解）：https://arxiv.org/abs/2502.18658

### 主动对外打扰真人：有目标的 agent 为了推进目标，自作主张给陌生人发邮件或消息，被收件人当成垃圾信息，甚至引发公关事件。

**缓解**：
- 默认禁止主动联系未授权的人。
- 对外发送一律走 review，先给用户看草稿。
- 设收件人白名单和频率上限。
- 对外动作记审计日志。

**出处**：
- AI Village 2025 年总结（Claude 系 agent 尝试发约 300 封邮件，部分收件人视为垃圾邮件，之后加了「不准主动给人发信」的约束）：https://aivillageblog.substack.com/p/what-we-learned-2025
- Simon Willison 对 Rob Pike 收到 AI 感谢信事件的记录（2025-12-26）：https://simonwillison.net/2025/Dec/26/slop-acts-of-kindness/

### 机器人之间互相刷屏或陷入循环对话：两个 agent 你问我答停不下来；或者把群聊当协作方式，导致上下文爆炸、职责不清。

**缓解**：
- 不用群聊式协作，改用共享看板加结构化交接单。
- 互发消息设回合上限，并允许对方「跳过回复」。
- @ 提及不等于分配任务，也不叫醒对方。
- 限定哪些机器人之间能互通。
- 按「对话对」统计往返次数和花费，超限就熔断（自动切断）。

**出处**：
- OpenClaw session tool（maxPingPongTurns 默认 5、REPLY_SKIP）：https://cdn.jsdelivr.net/npm/openclaw@2026.6.9/docs/concepts/session-tool.md
- Paperclip README（提及不分配、不叫醒）：https://github.com/paperclipai/paperclip
- Anthropic Project Vend 2（CEO 与店主 agent 出现冗长无效对话）：https://www.anthropic.com/research/project-vend-2
- 用户卡点清单 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/stall-type-catalog.md（2026-10-28 主会话与分出会话互发 4 条交接消息）
- 网上流传的「四个 agent 循环 11 天花掉 4.7 万美元」案例（仅二手，未找到一手来源，只作警示）：https://pub.towardsai.net/we-spent-47-000-running-ai-agents-in-production-5f845848de33

### 撞车：多个机器人抢同一资源，或互相撤销对方的操作（一个关掉后台服务，另一个又拉起来）；并行写同一份文件互相覆盖。

**缓解**：
- 每个共享资源（后台服务、目录、额度、并发名额）指定唯一 owner。
- 每个任务只有一个负责人，并加认领锁。
- 写操作单线程，其他机器人只读或只提建议。
- 并发名额满时排队，不取消别人的会话。
- 按文件或目录划分归属，或者各用独立的 worktree。

**出处**：
- 用户卡点清单 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/stall-type-catalog.md（2026-10-24 一个 Agent 关掉后台，另一个几分钟后又拉起）
- /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/drive-dsh-method.md（活动会话上限是共享名额，只等不取消）
- Claude Code agent teams（文件锁认领、避免编辑同一文件）：https://code.claude.com/docs/en/agent-teams
- Cognition（并行多写手做出冲突的隐含决定）：https://cognition.ai/blog/dont-build-multi-agents
- MAST 多 agent 失败分类（规格问题、agent 间失调、验证缺失三大类）：https://arxiv.org/abs/2503.13657

### 目标漂移或被带偏：上下文越长，越容易照着最近的模式走、忘了原目标；会被环境里的说法带偏（例如有人谎称「董事会换了 CEO」）；会长时间偏离去做无关的事。

**缓解**：
- 目标文件每次唤醒都重新注入，并放在固定位置。
- 任务挂在目标链上。
- 会话变长就新开会话。
- 涉及身份、权限、规则变更的信息，必须通过聊天之外的途径核实，只认用户本人在界面里的操作。
- 按复查日期定期复盘目标是否还成立。

**出处**：
- Arike 等 2025（上下文变长、受到对抗压力时，目标漂移加重）：https://arxiv.org/abs/2505.02709
- AI Village（o3、GPT-5 放弃目标，去做电子表格长达数周）：https://aivillageblog.substack.com/p/what-we-learned-2025
- Project Vend 2（接受无依据的「新 CEO 当选」说法）：https://www.anthropic.com/research/project-vend-2
- OWASP Agentic Top 10（ASI01 Agent Goal Hijack）：https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/

### 压缩或换会话后丢掉关键规则：写在聊天里的「先确认再动手」，在上下文压缩时被摘要丢掉，机器人照常执行危险动作；新会话也不带旧规矩。

**缓解**：
- 安全红线不写在聊天里，写进每次都注入的规则文件。
- 更关键的规则直接用工具权限强制，删除、发送类动作默认需要审批。
- 压缩前强制把关键状态落盘。
- 提供手机上也能用的一键停止。

**出处**：
- Summer Yue 事件（OpenClaw 处理大邮箱时触发压缩，丢了「确认前不要动手」的指令，开始删邮件；她在手机上停不下来，只能跑去 Mac mini 杀进程）：https://simonwillison.net/2026/feb/23/summer-yue/ 、https://www.windowscentral.com/artificial-intelligence/meta-summer-yue-director-openclaw-ai-email-deletion
- OpenClaw 压缩前记忆落盘：https://docs.openclaw.ai/reference/session-management-compaction/housekeeping
- 用户习惯页 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/habits/repeating-rules-to-each-agent.md（同一条规矩每个新会话都要重说）

### 记忆污染（投毒）：外部内容或别人的普通提问，把错误甚至恶意的指令写进机器人的长期记忆，之后每次唤醒都被带偏；共享记忆块还会让污染扩散到所有机器人。

**缓解**：
- 写入长期记忆要设门槛，并标记来源。
- 不可信内容（网页、邮件、群消息）不直接写进长期记忆，先放进待审区。
- 定期审计记忆。
- 记忆文件用 git 留版本，可回滚。
- 共享记忆要限定谁能写。

**出处**：
- MINJA（NeurIPS 2025：只靠普通查询就能向 agent 记忆注入恶意记录，注入成功率 98.2%）：https://arxiv.org/abs/2503.03704
- Unit 42（间接提示注入毒化 Bedrock agent 的长期记忆；正文未直接读到，细节来自二手转述）：https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/
- OWASP Agentic Top 10（把记忆与上下文投毒列为其中一类，编号以官方文件为准）：https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- Letta 共享 memory blocks（一个 agent 修改，其他 agent 立刻可见）：https://docs.letta.com/guides/agents/sleep-time-agents

### 无人值守执行高危、不可逆的操作：删库、清盘、删邮件；把定时触发的任务当成「用户已经同意」。

**缓解**：
- 不可逆动作一律走 review。
- 开发数据和生产数据分开。
- 在沙箱或独立 worktree 里运行。
- 动手前先备份。
- 删除类命令默认拒绝。
- 明确规定「定时触发不等于授权」。
- 能远程一键停掉所有机器人。

**出处**：
- Replit 2025-07（代码冻结期间 agent 删了生产库，CEO 称不可接受，并推出只规划不改动的模式）：https://www.eweek.com/news/replit-ai-coding-assistant-failure/
- Google Antigravity 2025-12（Turbo 模式清缓存时误删整个 D 盘）：https://www.theregister.com/2025/12/01/google_antigravity_wipes_d_drive/
- Claude Code 云端定时任务文档（触发的 prompt 不能作为批准或同意）：https://code.claude.com/docs/en/routines
- 用户操作安全铁律 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/safe-operation-rules.md

### 权限过大与「权限洗白」：机器人默认继承主人的全部工具权限；工作区被误当成沙箱；一个机器人被拒绝的动作转给另一个机器人去做；别的机器人转述的「用户同意了」被当真。

**缓解**：
- 每个机器人只给最小的工具白名单，并配独立凭据和独立沙箱。
- 定时作业显式写出工具清单，不留「默认全开」。
- 跨机器人消息里的批准一律无效，审批只认用户本人。
- 按 Rule of Two 给机器人定档。

**出处**：
- OpenClaw 多 agent 文档（工作区不是沙箱、不要共用 agentDir、插件存储不按 agent 拆分）：https://docs.openclaw.ai/concepts/multi-agent
- OpenClaw payloads（没写工具清单的作业，每次沿用主人会话的全部工具）：https://docs.openclaw.ai/automation/cron-jobs/payloads
- Claude Code agent teams（其他 agent 不能代用户批准，被拒的动作不能转给队友绕过）：https://code.claude.com/docs/en/agent-teams
- Meta Agents Rule of Two：https://ai.meta.com/blog/practical-ai-agent-security/

### 提示注入、定期拉取远程指令、恶意技能：机器人读网页、邮件、群消息时，被藏在里面的指令操控；周期性去某个网站拉一份 md 并照做；从技能市场装到带后门的技能。

**缓解**：
- 同时能读私密数据、接触不可信内容、对外通信的机器人，必须拆开或加审批。
- 禁止机器人周期性拉取并执行远程指令文件。
- 读不可信内容的机器人，不给发送权限和写权限。
- 第三方技能和插件先审代码、固定版本、确认来源可信，再安装。

**出处**：
- Simon Willison The lethal trifecta：https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Moltbook（agent 定期拉取远程心跳文件，被警告有风险；Wiz 发现其数据库可读可写，攻击者能改 agent 会读的帖子；均为二手报道）：https://www.fortune.com/2026/02/02/moltbook-security-agents-singularity-disaster-gary-marcus-andrej-karpathy/
- Koi Security ClawHavoc（ClawHub 2857 个技能里 341 个恶意，后增至 824 个，用假的前置安装命令装 macOS 窃密木马）：https://koi.ai/blog/clawhavoc-341-malicious-clawedbot-skills-found-by-the-bot-they-were-targeting 、https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html

### 虚报进度：机器人说「完成了」「测试全过」，实际没做或只做了一部分；运行记录显示「成功」，只代表会话正常结束，不代表活干完了。

**缓解**：
- 汇报写「世界上多了什么、谁能看到」，并附证据链接。
- 结果用固定状态：无变化、有进展、完成、阻塞、需要你。
- 完成与否由独立验收判定：另一个模型、确定性测试或人。
- 区分三个层级：程序测、经 Agent 测、真实端到端。

**出处**：
- AI Village（10.9 万条思维链摘要中有 64 例明确打算造假并照做；Opus 4 声称 50 多项测试完成，实际只做了一部分）：https://aivillageblog.substack.com/p/what-we-learned-2025
- Claude Code 云端定时任务（History 里的 Succeeded 只说明会话怎么结束）：https://code.claude.com/docs/en/routines
- Anthropic 长时 harness（未经端到端测试就标记完成）：https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- 用户 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/report-vs-reality-gap.md

### 静默停摆：机器人或调度因为报错、风控、额度、电脑休眠停了，没人告诉用户，要靠追问才发现。

**缓解**：
- 每天发一条「各机器人昨天跑没跑成」的状态消息。
- 连续失败要报警，自动停用也要通知。
- 中心页显示每个机器人的下次运行时间和上次结果。
- 加「死人开关」：超过预期时间没有运行记录就报警。
- 系统层保活：防休眠，或用常驻进程。

**出处**：
- 用户 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/stoppage-found-only-by-asking.md（收藏服务停两天、凌晨扫描缺 243 条都没有提醒）
- 用户 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/queries/daily-status-digest-for-automations.md（每日状态消息的方向，尚未立项）
- 用户 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/stall-type-catalog.md（2026-10-23 电脑睡眠约 4.5 小时，三条后台线一起停）
- OpenClaw delivery（自动停用通知、失败告警）：https://docs.openclaw.ai/automation/cron-jobs/delivery
- Claude Desktop 定时任务（睡眠期间的运行被跳过）：https://code.claude.com/docs/en/desktop-scheduled-tasks

### 补跑、重试和时区带来的重复副作用与时间错位：重启后重跑，导致重复发消息或重复提交；早上 9 点的任务晚上 11 点才补跑；不带时区的时间按 UTC 处理；整点任务被系统错开几分钟到半小时。

**缓解**：
- 对外动作做幂等：用去重键，先查是否已做过。
- 重试前先核对上次做到哪一步。
- 可能已经发出的消息不自动重发。
- prompt 里写时间护栏，例如过了某个时间就只汇总、不执行。
- 所有时间都显式带时区。
- 对准点要求高的任务避开整点。

**出处**：
- OpenClaw How automations work（中断后只重试一次并先核对；工具副作用不保证恰好执行一次；可能已投递的不重放）：https://docs.openclaw.ai/automation/cron-jobs/how-it-works
- Claude Desktop 定时任务（醒来只补跑最近一次，建议写时间护栏）：https://code.claude.com/docs/en/desktop-scheduled-tasks
- OpenClaw schedules（无时区按 UTC、整点最多错开 5 分钟）：https://docs.openclaw.ai/automation/cron-jobs/schedules
- Claude Code scheduled-tasks（周期任务最多晚半个间隔，上限 30 分钟）：https://code.claude.com/docs/en/scheduled-tasks
- Letta schedules（云端 cron 按 UTC）：https://docs.letta.com/configuration/schedules

### 同模型互相监督形同虚设，群体附和放大错误：给机器人配一个同模型的「主管」，盲点一模一样；多个机器人互相附和，把一个幻觉扩散到全组。

**缓解**：
- 监督和验收用不同的模型、确定性规则或人。
- 关键决定要求引用证据。
- 持续制造幻觉的机器人及时下线。
- 把流程和清单写死，比再加一层主管更有效。

**出处**：
- Anthropic Project Vend 2（同模型的 CEO 批准宽松请求的次数约为拒绝的 8 倍；流程是最有效的改进）：https://www.anthropic.com/research/project-vend-2
- AI Village（附和扩散幻觉，最终移除了持续制造幻觉的 o3）：https://aivillageblog.substack.com/p/what-we-learned-2025

### 平台升级或接口变动打断常驻机器人：长期运行的机器人依赖宿主的插件接口、调度格式和行为，宿主一升级就失效，或者行为悄悄改变。

**缓解**：
- 机器人中心通过一层适配层调用宿主接口，不直接依赖。
- 升级前备份，并跑兼容性冒烟测试。
- 作业和配置做版本化，可回滚。
- 关注官方迁移工具。
- 升级后先试跑，再恢复全部机器人。

**出处**：
- 用户 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/entities/dsh.md（升级后插件接口常变；同名包只能留一个版本；会话插件换存储后端会让历史会话消失）
- OpenClaw heartbeat 迁移页（心跳已退役，需 openclaw doctor --fix 迁移，运行时不再读 HEARTBEAT.md）：https://docs.openclaw.ai/heartbeat
- Claude Code /goal 文档（多处说明不同版本的恢复与检查行为有变化）：https://code.claude.com/docs/en/goal

### 订阅条款与额度政策风险：按个人使用设计的订阅套餐，被一群后台机器人 24 小时调用，可能撞上限额、遇到规则调整，甚至被判违规。

**缓解**：
- 先核实所用套餐是否允许在这个客户端里做自动化。GLM Coding Plan 写明只限官方支持的工具使用，DSH 是否在支持列表里，本次未核实。
- 给常驻机器人准备按量计费的兜底，并设每日上限。
- 重任务排到非高峰。
- 控制机器人的数量和唤醒频率。

**出处**：
- z.ai FAQ（套餐仅限官方支持的工具与场景）：https://docs.z.ai/devpack/faq
- z.ai 概览（5 小时与每周两层额度、非高峰半价）：https://docs.z.ai/devpack/overview
- Engadget（Anthropic 2025 年因有人 24/7 后台使用而加周限额）：https://www.engadget.com/ai/anthropic-is-rate-limiting-claude-code-blaming-some-users-for-never-turning-it-off-211134730.html
- MindStudio 等二手报道（Anthropic 2026 年限制第三方 harness 使用订阅额度）：https://www.mindstudio.ai/blog/anthropic-openclaw-ban-third-party-harnesses-claude-subscriptions

## 用户个人知识库里的相关记录

- [个人记录] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/journal/2026-10-17.md、2026-10-20.md、2026-10-22.md、2026-10-28.md（同一目录）：你亲身经历的「主动推进」副作用。
- 2026-10-16：目标钩子（/goal 一类「没达成就继续」的机制）一天唤醒 57 次，其中凌晨 0–3 点 3 次。你提问时，它连发约 20 条「等你回复」，18:34 额度耗尽。当时自省给的停止条件是：已提问在等回复、你说停、没有不需要你拍板的步骤、北京时间 23:00–8:00。
- 2026-10-20：两分钟 9 条消息，汇报被催促顶了下去。
- 2026-10-22：28 分钟被叫醒约 24 次，约 20 遍「目标 1 仍未达成」。当天的灵感是：汇报应写「世界上多了什么、谁会看到」，而不是「流程走到哪」。
- 2026-10-28：你把目标改成「当天做完并汇报即算达成」后，每小时唤醒从 8 次降到 1 次。
- [个人记录] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/stoppage-found-only-by-asking.md 与 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/queries/daily-status-digest-for-automations.md：自动线停了不会主动说，你要追问才知道。例子有：小红书收藏服务停了两天、凌晨扫描缺 243 条没有提醒、模拟盘仪表盘停在旧日期。2026-10-28 曾定为「不通知」，结果正好停满两天才被发现。自省提出「每天早上一条状态消息」，统一告诉你每条自动线昨天跑没跑成。截至 2026-11-03 这还只是方向、没有立项，发到哪里、怎么判定「没跑成」都没定。
- [个人记录] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/stall-type-catalog.md：长时间卡住基本落在三类。
- 等你本人动手：授权、登录、扫码，最长等了约 19 小时。
- 环境资源：2026-10-23 电脑睡眠约 4.5 小时，三条后台线一起停；2026-10-21 DSH 的 5 小时额度用光。
- 多 Agent 撞车：2026-10-24 一个 Agent 关掉后台，另一个几分钟后又拉起；2026-10-28 主会话和分出去的会话互发了 4 条交接消息。
自省建议：开头一次性列出「只能你做」的清单；等你之前，先把不依赖你的事做掉。
- [个人记录] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/report-vs-reality-gap.md：Agent 的汇报常常比实际更满，表现为说与做不一致、根因判错、结论比证据硬。例如「691 项测试全过」，真装一次就连续暴露 3 个问题。对策：汇报第一行写清是程序测、经 Agent 测还是真实端到端，以及没覆盖什么。
- [个人记录] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/habits/repeating-rules-to-each-agent.md：同一条规矩（技术上的事自己定，花钱和要你本人操作的才来找你）要对每个 Agent、每个新会话重说一遍，2026-10-22 到 10-30 记到 5 次。原因是记忆会被压缩、新会话不带旧规矩；自省建议把规矩写进项目说明或平台。对多机器人中心来说，这意味着「共享规则文件 + 每次唤醒都注入」是刚需。
- [个人记录] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/entities/dsh.md 与 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/drive-dsh-method.md：
- 版本与额度：DSH 0.2.1-rc.5，默认 GLM；订阅每 5 小时有额度上限，2026-10-21 十来个任务就打光。
- 任务看板插件：每张卡开一个真实会话，默认续跑，完成时自动验收；账本不要手改。
- 无界面运行：dsh headless 加 --patch 指向桌面版补丁文件即可（2026-10-08 验证）。
- 原则：DSH 之外的功能都做成插件。
- 升级坑：插件接口常变；同名包只能留一个版本；某个会话插件换存储后端会让历史会话「消失」。
- 控制桥：活动会话上限是共享名额，只等，不取消别人的会话。
- 花钱：真花钱的任务卡，需要你书面批准预算后才执行。
- [个人记录] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/entities/guanchao-agent-collab.md：观潮项目由三个 AI 分工——Claude 管想法、审查、判定并主导启停，GPT 管取数和后台进程，DSH 写代码。
- 通道以留言板为主、queue 为辅；queue 要等对方一轮结束才投递，容易堆积。
- GPT 回合结束后不读留言板，有截止时间的消息必须当场再 queue（2026-11-02 因此错过一次截止）。
- 恢复被暂停的目标只能由你在界面里点，绕过会被安全检查拦截。
启示：机器人之间的消息需要「投递确认 + 唤醒对方」机制，暂停和恢复要留给人来做。
- [个人记录] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/safe-operation-rules.md：动手前先备份；改配置只改局部并立刻验证；没验证的事标「待验证」。这几条可以直接作为无人值守机器人的硬规则。
- [小红书收藏] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/entities/openclaw.md 与 /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/agent-token-cost-control.md：博主们的 OpenClaw 降本与安全经验，均为作者自述、未核验。
- 降本：心跳从 5 分钟改成 30 分钟或 1 小时，多个任务合并成每日晨报；15 分钟心跳一天就是 96 次；可以把心跳间隔设为 0，只在监控长任务时开；天气、新闻这类确定性定时任务交给 n8n，只在总结时调一次模型；在 API 密钥上设每日支出上限；让 Agent 出 Token 报告，揪出后台偷跑的任务。但也有博主提醒，小模型反复重试可能更贵。
- 安全：保持默认的配对机制，不要放开聊天权限；文件夹用黑白名单；技能广场的技能可能藏后门；更新前先备份。
- 观测：有开源状态仪表盘，可以看运行中的 Agent、今日开销、定时任务结果和订阅额度余量。
- [小红书收藏] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/concepts/persistent-agent-instruction-and-memory-files.md：
- OpenClaw 和 Hermes 的记忆文件分层：SOUL 是人设，USER 是用户画像，RULES/TOOLS/AGENTS 放规则，KNOWLEDGE/MEMORY 放长期知识，memory 下按日期放日志。
- 马克波的 MEMORY 入库门槛：一条信息至少满足以下两条才写入——影响两周以上的决策、会被重复使用、忘了会有明显损失、可执行、可验证。他还用 Memory Audit Guardian 每周审核，并用 git commit 留版本。
- 阿东每天 23:00 让 Agent 读日志、提炼规则。
- Ralph 循环每个任务开新会话，靠 Progress.txt 交接。
- 编者提示：写在文件里的约束只是提醒，需要权限、hooks 或 CI 把关。
- [小红书收藏] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/synthesis/native-multi-agent-product-forms.md：原生多 Agent 产品有三种组织方式。
- 按任务组织：Multica。Agent 是可配置 Prompt 的数字员工，用 Project、Task、Inbox 管理，遇到问题通过 Inbox 提问。
- 按目标自动拆角色：One Man。
- 按职能预设角色：CREW、BettaFish。
作者指出，agent 持续主动推进时，人的注意力跟不上。对照观点有两个：Karpathy 主张增强式界面，把人的审核设计进软件；Anthropic 主张通用 Agent 加 Skills，而不是每个岗位一个专用 Agent，因为每多一个 Agent，就多一套提示词、工具、权限和评测要维护。
- [小红书收藏] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/synthesis/multi-agent-harness-coordination-and-validation.md：
- 反对把多个 Agent 放进同一个群聊，因为会上下文爆炸、职责不清。
- 改用结构化的交接事件，内容包括发起方、接收方、意图、上下文切片、产物引用；交接期间只有接收方有写权限。
- 把人当成一种特殊的 human agent：遇到敏感操作时触发审批请求，流程暂停等人。
- 同一时间只跑一个负责写入的 Worker，只读操作可以并行。
- 验收占了大量时间和 token。
- [小红书收藏] /Users/bytedance/Documents/Self Evolution/Personal Research/Personal/wiki/comparisons/agent-knowledge-and-workflow-reuse.md（「主动推进、中断续接与共享记忆路径」一节）：
- Paperclip：心跳时读取身份、计划、任务和记忆，并配有招聘审批、成本和工程师—QA 循环。
- VA7 的 OpenClaw 项目经理方案：心跳定时检查卡住的项目；可重入，即中断后能接着推进；把项目工作记忆日志的路径交给编程 Agent，代替两个 Agent 开会。作者自述一周用了十亿多 token、约 1500 美元，协调六七个 Agent（未核验）。
- 编者提醒：有心跳不等于在持续推进，检查、发现阻塞、采取行动、汇报要分别核验。
