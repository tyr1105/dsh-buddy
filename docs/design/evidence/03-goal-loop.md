# 底稿：目标驱动与自主循环（R3）

> 研究底稿（2026-11-04，DSH 桌面版 0.2.1-rc.5）。先由一位读者细读官方插件说明与源码，再由另一位核查员逐条尝试推翻承重结论；「核查」一节里的修正优先于「读者结论」。证据路径中的 `dsh-src/` 指从安装包只读解出的官方插件源码，可用 `tools/asar_extract.py` 重新解出。

## 读者总结

现成零件能做到：每个会话可以挂一个持久的“完成型目标”（goal）。机器人空闲时，驱动器会自动一轮接一轮推进，直到模型自报完成或受阻、轮数到上限，或者被人暂停。目标状态写进会话日志，跨天、重启后目标本身还在。做不到的有五点：一个会话只能有一个目标；轮与轮之间没有间隔，也没有 token、时间或金额预算，开放式目标会连续空转烧额度；没有独立评估器，完成与否由模型自己说；App 重启、升级、模型请求出错后，自动续跑会被收回，必须有人或插件重新 resume；定时唤醒的回合里，模型无权自己开新 goal 或恢复 goal。无人值守时，ask_user_question、计划审批和工具审批默认会无限期挂起，整个机器人会被冻住。结论：R3 可以做，但需要自写一个胶水插件，负责几件事：定时直接调 ctx.goals.create 开一个有界子目标、重启后重新武装、管住并发和预算、加一道完成评审闸门、提供无人值守时的应答器。长期目标和进度放在机器人工作目录的 AGENTS.md 或台账文件里。

## 逐题回答

**问题 1**

【数据模型】一个会话最多 1 个当前 goal。字段：目标文本、maxGoalRounds（默认 256）、roundsStarted、phase（active/paused/blocked/complete）、blocked 时的 {code,message}、revision（比较并设置）。还有一个进程内的 activation（armed/disarmed），不落盘。未完成的 goal 不能被新 goal 顶替（GOAL_ALREADY_EXISTS），complete 之后才能直接替换，否则要先 clear（dsh-goal/lib/index.js:588、639）。

【多轮机制】dsh-goal-round-driver 在 agent 空闲时检查一组条件：没有排队的人类输入、持久化 flush 成功、goal active 且 armed、子 agent 全部结束、轮数未满。全部满足就 followup 一条 user 角色的 <goal_round> 提示，来源 kind=goal；提示里有目标、Round n/上限，以及“继续推进、核验、证据充分再 complete，没做完就保持 active”。只有真正进入历史的轮才计数。轮与轮之间没有间隔，人类插话优先（driver lib:11-16、85、132、143-153、225、243）。

【停止条件】
- 达成：模型在当前 goal 轮里调 update_goal(complete)，或者人直接 complete；之后注入 <goal_complete>，让模型给用户写收尾。
- 卡住：模型调 blocked，代码要求 roundsStarted≥3（blockedAfterConsecutiveRounds 默认 3），“是不是同一个障碍”由模型自判。
- 轮数：到上限后驱动器 block，code 为 round-limit。
- 预算：除轮数外没有任何 token、时间或金额预算。
- 用户叫停：/goal pause 或 GoalBar 暂停（会中止正在跑的轮）、/goal clear；人取消正在跑的轮，goal 会在下次空闲时被 pause。
- 异常：agent/error（包括重试耗尽的模型请求错误）、max-tokens 结束、flush 失败时 disarm，phase 仍是 active；排队失败记 blocked(queue-failed)。

【自评】没有独立评估器，完成由同一个模型自报，只有提示词层面的“先拿证据”约束。三个 README 都把评估器列为暂缓。

【持久与跨天】goal 以 goal/change 事件写进会话日志，跨天、重启、resume、fork 后都在。但续跑权限只在进程内：App 重启、升级、会话重载后一律 disarmed，驱动器不会自己恢复。恢复需要人 /goal resume 或点 GoalBar；或模型在含人类直接消息的回合里 update_goal resume；或插件调 ctx.goals.resume。所以 App 重启后不会自动继续。

**问题 2**

ralph 是实验 bundle 提供的前台工具。Desktop 随附，但默认关闭，要在插件页开启。模型调用 ralph({objective,maxRounds}) 后，这次调用会一直阻塞到结束。内部是部署方写死的固定脚本：每轮 spawn 一个全新子 agent，不带父对话和上一轮会话，只给它不可变目标、轮次、上一轮的结构化交接报告（≤16384 字符）；共享工作区是唯一的长期记忆。worker 报 complete、blocked，或达到上限时返回（bundle 配 64 轮，工具默认 256）。

与 goal 的区别：
① goal 在同一会话续跑，上下文不断累积、靠压缩；ralph 每轮全新上下文，不会越跑越胖，但没有对话记忆，只能靠文件。
② goal 状态持久，重启后可以 resume；ralph 没有 job id、没有检查点、不能后台运行，宿主重启整次运行就丢了。
③ goal 由驱动器在空闲时异步推进，人随时可以插话；ralph 占住父 agent 的一个工具调用，期间父会话不空闲。
④ 两者的完成都是自报，没有独立验证。
⑤ ralph 的 worker 是子 agent，不能 ask_user（DELEGATED_CALLER），只能报 blocked。
⑥ “只有用户明确要求才用 ralph”只写在提示词里，代码不强制（tool-ralph/lib/index.js:99-124 没有授权检查）。

适合：能把全部状态外化到文件、上下文污染严重的一次性长任务，比如“把测试全部修到通过”“按清单反复改稿直到全部满足”。不适合：常驻、后台、跨天、要能恢复的个人目标。在 Agent 中心里，它只能在某次唤醒中当执行器，不能当主动循环的骨架。

**问题 3**

不能直接当自我验收。auto-review 是权限插件：每次工具调用执行前，用当前会话的模型按固定 REVIEW_POLICY 判风险（low 放行；medium 需人类或父 agent 明确授权；high 拒绝），放行即以 Full access 执行，拒绝时策略为 ask 就转人工审批。它评的是“这个动作安不安全”，不是“目标完成得好不好”。它只在 Web 层可选、默认关闭、标为实验（auto-review README 概述、lib:20-44、461-488）。

对机器人还有一个副作用：它只把 kind=user 且带 rpcId 的界面消息当作人类授权（lib:91-92）。定时回合和 goal 回合里的 medium 动作（比如对外发送）会被拒，转成人工审批后，无人值守时就挂起了。

可借用的是它的实现套路：在 tools/pre-execute 上 prepend 一个监听器，拦截 update_goal(action=complete)，用 ctx.llm.stream 让评审模型读会话里真实的工具调用记录（而不是模型自述），按多项判据打分，不达标就拒绝并把理由回给模型。用户旧看板“三项各≥0.65、修一轮、二次不过判失败”就是这种思路，可以照此自建“完成评审闸门”。

**问题 4**

判断：现有 goal 不适合直接承载“永不结束”的个人目标，应该用“定期唤醒 + 每次用 goal 推进一个有边界的子任务”。但这个组合官方零件拼不起来，需要一个小插件当胶水。

依据：
① 驱动器一空闲就发下一轮，没有节奏。<goal_round> 又要求“还有活就保持 active”，开放式目标永远不会 complete，会背靠背连跑到 256 轮；按用户每 5 小时的额度，一个机器人就可能把额度打光（driver lib:11-16、225、243）。
② 只有轮数预算，没有 token、时间或金额预算。
③ 一个会话只有一个 goal，轮数在同一个 goal 上累计，按周跑会撞上限。
④ 重启、升级、出错后自动 disarm，开放式目标会悄悄停掉。
⑤ “困难、不确定、还有有用的工作”都不算 blocked，模型不会自己停。

组合方案里的坑：dsh-schedule 投递的消息 source.kind 是 schedule（schedule lib:1594），而模型侧的 create_goal、resume、edit、pause 都要求回合里有 kind=user 的消息（tool-goal lib:45-64）。所以定时醒来的回合里，模型既不能开新 goal，也不能恢复被 disarm 的 goal。

可行做法（接口已核实）：中心插件到点后，先 sessionController.resolveAgent 把会话恢复成存活 agent；上一周期的 goal 若未完成，就 clear 并记账；然后 ctx.goals.create(agent,{objective:'本周：找 3 个值得关注的 AI 产品岗位，写入 jobs.md 并汇报', maxGoalRounds:5~10})。create 即 armed，驱动器会自动开跑；再监听 goal/changed 收结果、发通知。也可以学用户的 claude-bridge 用 commands.execute(agent,'/goal …')，但这条路不能指定轮数上限。长期目标本身写进机器人工作目录的 AGENTS.md 和台账文件，每次请求都看得见，台账同时充当跨周期记忆。

零代码的退路：不用 goal，只靠 schedule。每次醒来做一个长回合，结束前用 schedule_create 自己排下一次（模型在任何回合都能调 schedule 工具）。缺点是没有“没做完就自动续一轮”的保障。

**问题 5**

会卡住等待，默认没有超时。

① ask_user_question：桌面 standard preset 没配置这项，用的是 legacy 阻塞模式（tool-ask-user lib:212，mode 默认 legacy）。问题由 api-remotes 转发到网关；没有窗口连着时，网关把它挂在 pendingRemoteEvents，等有窗口连上再投递（gateway lib:1014、1102），一直等到有人回答或回合被取消。期间 agent 一直是 running：goal 不会发下一轮，定时提醒消息只能排在收件箱 next-turn 里，整个机器人被冻住。可选 mode: timed（默认 120 秒），到期返回 pending、模型继续干别的，之后的回答以 user-question-reply 消息送达（不具备人类授权）。子 agent，包括 ralph 的 worker，不能提问，会直接报 DELEGATED_CALLER。

② 计划审批：exit_plan_mode 固定走阻塞的 ask()，没有 timed 选项（plan-mode lib:261），没人批就一直等；计划模式状态跨重启保留。模型没有进入计划模式的工具，只要别给机器人开 /plan 就不会遇到。

③ 工具审批：策略为 ask 时同样经网关挂起、无超时；策略为 never 时确定性拒绝，不弹提示（README 明说这是 CI 与无人值守模式），模型拿到拒绝结果后可以换路子或报 blocked。

④ auto-review 在定时回合和 goal 回合里会拒绝 medium 动作，再转 ask，结果同样挂起。

⑤ goal blocked 时只在会话里写一段收尾说明，不会主动推送给用户。

建议：给机器人建专用 preset（ask-user 设 timed 或干脆去掉、不开计划模式、审批 never）；进阶的话，自写 user-questions/request 和 approval/request 应答器，带超时、能转发飞书。

**问题 6**

先澄清：本机安装的是 cloader 的 dsh-taskboard 0.8.7（src/shared/version.ts）。它的源码里没有 /goal 续跑，也没有“三项≥0.65”的自动验收，只在 i18n 里有 /goal 的补全提示。“三项各≥0.65、修一轮、二次不过判失败”出自用户自己的 dsh-playbook.md（第 34-37 行），描述的是 @linxin666/dsh-client-ui-task-board；那个插件现在不在磁盘上，实现无法核实。用 /goal 武装会话的现成代码在用户自己的 dsh-claude-bridge 里：bridge.js:346-351 用 commands.execute 发 '/goal …'，bridge.js:564 轮询 projections.values.goal.goal.phase 判断终态。

dsh-taskboard 可直接借鉴到 Agent 中心的：
① 宿主侧调度：一次性、cron，关浏览器照跑；全局并发上限（DSH_TASKBOARD_MAX_CONCURRENT 默认 3，可设 1–100）；满载时持久化 FIFO 队列；启动间隔节流（默认 1000ms）；排队保质期；离线错过超时后不补跑。
② 会话策略：每次新建、首次新建后复用、或指定已有会话；会话忙、锁、坏时回退新建；模型、preset、权限、隔离配置变了就自动新建；不往正在跑的会话里注入（报 'scheduled session is busy'）。
③ 开场注入：插件说明用自有 source kind（dsh-taskboard）走 inject，任务正文用 kind user 走 followup（execution.ts:736-747），所以该回合具备人类授权，模型可以自己开 goal。
④ 结算：用 whenIdle 等回合静止后结算，并采集提交、未提交改动、统计等证据。
⑤ 代码级协议闸：agent 永远移不到 done、被持有的任务不能抢、不能跨项目认领、model/execution 字段对 agent 只读，即“验收权只属于人”。
⑥ 结构化执行报告（摘要、改动文件、自验、产物、剩余风险）+ DoD 清单逐项勾选并附证据，可作为机器人汇报和自评的统一格式。
⑦ 退回附原因，下轮开工前必读，形成反馈闭环。
⑧ 定期任务“完成后新建待办”：每个周期一张新卡，由宿主强制执行，不依赖 agent 自己改状态，正好对应“开放式目标拆成一个周期一个有界子任务”。
⑨ 乐观并发 ifVersion、完整归因、SSE 实时看板、JSON 导入导出、健康诊断。
⑩ 任务级 preset、模型和三档权限，可对应到机器人级的身份与权限。

## 能力清单（* 为承重结论）

- **C1***（依据：both；对应 R3, R4）goal 数据模型：每个会话最多 1 个当前 goal。字段有目标文本 objective、轮数上限 maxGoalRounds（部署默认 256）、已开始轮数 roundsStarted、phase（active/paused/blocked/complete）、blocked 时的 {code,message}，以及 revision（比较并设置，旧视图会被拒绝）。未完成的 goal 不能被新的 create 顶替，会报 GOAL_ALREADY_EXISTS；要么等它 complete 后直接替换，要么先 clear。每次变更作为完整快照的 goal/change 事件追加进会话日志（事件溯源、严格回放），所以跨天、重启、resume、fork 后 goal 都还在。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（概述、驱动生命周期、什么会保留，已知限制里的“只有一个当前 goal”）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:588（defaultMaxGoalRounds default(256)）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:639（GOAL_ALREADY_EXISTS）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:865（agent.session.append("goal/change")）
- **C2***（依据：both；对应 R3, R9）“自动续跑”权限（armed/disarmed）只存在进程内存里，不持久化。凡是 agent/created 边界（App 重启、升级、会话被重新加载、fork），goal 都会被置为 disarmed，驱动器不会自己复活工作。恢复途径有四条：人在界面输入 /goal resume 或点 GoalBar 的恢复；模型在含人类直接消息的回合里调 update_goal resume；插件直接调 ctx.goals.resume；以上都受剩余轮数约束。结论：App 重启后目标不会自己继续跑。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:594-596（ctx.on("agent/created") → setActivation disarmed）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:778（runtimeState 初始 disarmed）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:696-697（resume：已 armed 报错；轮数耗尽报错）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/README.zh.md（resume、fork 或卸载之后：驱动器绝不会自行复活工作）
- **C3***（依据：both；对应 R3, R2）Round 驱动机制：dsh-goal-round-driver 监听 agent/status=idle 和 goal/changed。需要同时满足这些条件：agent 存活且空闲、没有排队的人类输入、会话持久化 flush 成功、goal 为 active 且 armed、子 agent 全部结束、轮数未满。满足后，它用 agent.followup 投一条 user 角色的 <goal_round> 提示，来源 kind=goal，内容是目标、Round n/上限，以及“继续推进、核验、证据充分再 complete”的固定指令。只有进入历史的轮才计数。轮与轮之间没有任何等待或节流，一空闲就发下一轮；人类输入优先，自动轮会让行。
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:11-16（renderGoalRoundPrompt 文本）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:85（readyToDrive：idle 且 !competingQueued）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:132（subagents.waitForChildren）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:143-153（followup，source kind "goal"）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:225,243（idle 或 goal/changed → requestDrive，无延时）
- **C4***（依据：both；对应 R3, R7）停止条件分几类。complete：模型只能在当前 goal 轮或含人类直接消息的回合里调，成功后注入 <goal_complete> 收尾。blocked：goal 轮里要求 roundsStarted≥3（blockedAfterConsecutiveRounds 默认 3），“是不是同一个障碍”由模型自己判断。驱动器自己也会 block：轮数耗尽记 code round-limit，排队失败记 queue-failed。人可以 /goal pause（会中止正在跑的轮）或 /goal clear；人取消正在跑的轮，goal 会在下一次空闲时被 pause。agent/error（包括重试耗尽的模型请求错误）、因 max-tokens 结束、flush 失败时，goal 只被 disarm，phase 仍是 active。除轮数外，没有 token、金额或挂钟时间预算。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:62-79（requireDirectHuman / completionAuthority）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:115,360（blockedAfterConsecutiveRounds 默认 3；GOAL_TOOL_BLOCK_THRESHOLD）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:137,170,211,225-245,274（round-limit、queue-failed、agent/error→disarm、取消→pause、max-tokens→disarm）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（已知限制：只有 Round 数量预算）
- **C5**（依据：both；对应 R3）没有独立评估器。完成或阻塞由同一个模型自报，约束只来自提示词：<goal_round> 要求先收集证据证明整个目标已达成；系统提示写着“Mark complete only when the objective is actually achieved”。终局时会注入 <goal_complete> 或 <goal_blocked>，让模型给用户写一段收尾说明。三个 README 都把“评估器认证”列为暂缓。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（已知限制：没有独立评估器）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/README.zh.md（已知限制：没有独立评估器）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:95-96,196（wrapup 文本、goal 策略提示）
- **C6***（依据：code；对应 R2, R3, R7）人类授权门槛：模型侧 create_goal 以及 update_goal 的 edit/pause/resume，要求调用者是根 agent，且当前回合里有 source.kind==='user' 的消息。定时提醒投递的消息 source.kind 是 'schedule'，所以定时唤醒的回合里模型不能开新 goal，也不能恢复被 disarm 的 goal，只能对当前 goal 轮做 complete/blocked。paused 的 goal 模型一律不能恢复。反过来，sessionController.prompt 发出的消息是 kind 'user'（带 rpcId），dsh-taskboard 执行任务时正文也以 kind 'user' 投递，所以这两条路都带“人类授权”。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:45-51（hasDirectHumanInput：source.kind === "user" 且为 root）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:290-292,345-352（create/edit/pause/resume 调 requireDirectHuman；GOAL_TOOL_RESUME_PAUSED）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1594（source: { kind: "schedule" }）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3224-3229（prompt 的 source kind "user" + rpcId）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts:736-747（inject 用 kind 'dsh-taskboard'，followup 用 kind 'user'）
- **C7***（依据：code；对应 R3, R2, R10）插件可以不经模型工具，直接控制 goal。服务层的 ctx.goals.create/edit/pause/resume/complete/block/clear/disarm 只要求精确的存活 Agent 和 {id,revision}，不检查人类授权。create 之后 goal 立即 armed，并触发 goal/changed，驱动器会自动发第 1 轮。另外两条路：commands.execute(agent,'/goal <目标>' 或 '/goal resume')，用户自己的 claude-bridge 已这样用；或者走 Remote 命名空间 goals 的 get/create/edit/pause/resume/complete/clear。冷会话要先用 sessionController.resolveAgent 恢复成存活 agent（dsh-schedule 就是这样做的）。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:496-502（Remote get/edit/pause/resume/complete/clear/create）、635-648（create → armed）、896（remoteExportCreate）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:243（goal/changed → requestDrive）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js:82-90（ctx.commands.execute(agent, line, [], signal)）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:346-351（'/goal ' 武装）、564（projections.values.goal.goal.phase）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1576（sessionController.resolveAgent 恢复冷会话）
- **C8***（依据：both；对应 R3, R7, R9）无人值守时会无限期挂起。ask_user_question 默认是 legacy 阻塞模式（桌面 standard preset 没改这项）；exit_plan_mode 固定用阻塞的 ask()；工具审批策略为 ask 时也一样等。这类请求由 api-remotes 转发到网关：没有窗口连着时，网关把请求挂在 pendingRemoteEvents 里，等有窗口连上再投递，没有超时。挂起期间 agent 一直是 running：goal 不会发下一轮，定时提醒只能排在收件箱后面。可选的缓解：ask_user_question 设 mode: timed（默认 120 秒，到期返回 pending）；审批策略设 never（确定性拒绝，README 称为 CI 与无人值守模式）。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ask-user/lib/index.js:212-213（mode 默认 legacy；timeout 默认 120）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml（tool-ask-user 无 config）
  - 证据：dsh-src/@deepseek-ai/dsh-api-remotes/lib/index.js:27,136,165-175（approval/request、user-questions/request 以 waterfall 方式转发）
  - 证据：dsh-src/@deepseek-ai/dsh-api-gateway/lib/index.js:1014,1102（pendingRemoteEvents 挂起，新窗口连上时再投递）
  - 证据：dsh-src/@deepseek-ai/dsh-plan-mode/lib/index.js:261（exit_plan_mode → interaction.ask）
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:176；README.zh.md（设置策略：never 是无人值守模式）
- **C9***（依据：both；对应 R3, R9）模型请求失败默认只重试 5 次，覆盖 RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT、EMPTY_RESPONSE，退避 500ms 到 10s。重试耗尽后回合以错误结束并发出 agent/error，goal 驱动器随即 disarm。所以碰上 5 小时用量上限时，所有正在跑的机器人目标都会停下，而且不会自己恢复。如果把 retryPolicy 设为 always，则会一直重试并占着这个回合。
  - 证据：dsh-src/@deepseek-ai/dsh-llm-retry/README.zh.md（最小配置：normal mode 最多重试五次）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:99-100（挂载 llm-retry）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:877-884,1020-1027（回合错误 → throwError 发 agent/error）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:211-213（agent/error → disarm）
- **C10**（依据：both；对应 R3）ralph 是一个前台工具，运行固定脚本：每轮 spawn 一个全新的子 agent，不带父对话，也不带上一轮会话。每轮只能拿到不可变目标、轮次、上一轮的结构化交接报告（≤16384 字符）和共享工作区，工作区文件是唯一的跨轮记忆。worker 报告 complete 或 blocked，或达到轮数上限（bundle 配 64，工具默认 256）时返回 complete、blocked 或 budget-limited；整个过程会阻塞父 agent 的这次工具调用。它没有 job id、没有检查点、不能后台运行，完成由 worker 自报。实验 bundle 默认关闭；“只有用户明确要求才用”只写在提示词里，代码不强制。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ralph/README.zh.md（概述、已知限制：仅支持前台、完成由 worker 自行声明）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ralph/lib/index.js:20-21,99-124（配置默认值、固定循环脚本、DESCRIPTION，无 source 或授权检查）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-ralph-bundle/cordis.patch.yml（optional-ralph 组、maxRounds 64）及 README.zh.md（默认关闭）
- **C11**（依据：both；对应 R7, R3）auto-review 管的是“这个动作安不安全”，不是“目标完成得好不好”。每次工具调用执行前，它用当前会话的模型按固定 REVIEW_POLICY 判风险：low 直接放行；medium 需要人类或直接父 agent 明确授权；high 一律拒绝。被拒且审批策略为 ask 时，转人工审批。只有 source.kind==='user' 且带 rpcId 的消息才算人类授权；定时提醒（kind schedule）和 goal 轮（kind goal）都不算。它是实验功能，默认关闭。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/README.zh.md（概述、获得的能力、已知限制）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/lib/index.js:20-44（REVIEW_POLICY）、91-92（isHumanInstruction）、403-414（ctx.llm.stream）、461-488（tools/pre-execute prepend）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/cordis.patch.yml（只插入 auto-review 一行）
- **C12**（依据：both；对应 R3）todo_write 是单会话独占的整表清单，投影在每次 turn/start 清空，而每个 goal 轮都是一个新回合，所以它不适合当长期目标拆解的持久载体。计划模式只能由 /plan 或 ctx.planMode 开启，模型没有“进入计划模式”的工具；开启后状态跨重启保留，退出必须人工评审。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-todo/lib/index.js:83-86（turn/start 时返回 null）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-todo/README.zh.md（单一所有者、会话投影）
  - 证据：dsh-src/@deepseek-ai/dsh-plan-mode/README.zh.md；lib/index.js:34（只有 exit_plan_mode 工具）
- **C13**（依据：both；对应 R3）防死循环只有建议性提醒：同一工具、同一参数连续重复 3/5/8 次时给模型一条提醒，不会阻止调用。只有 kind=user 的消息会清零计数，goal 轮不清零。没有“多轮没进展”的检测。
  - 证据：dsh-src/@deepseek-ai/dsh-repeat-tool-reminder/README.zh.md（概述、设计理念：仅建议，不否决）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:448-452（thresholds [3,5,8]）
  - 证据：dsh-src/@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js:2262
- **C14**（依据：both；对应 R2, R3）模型在任何回合都能调 schedule_create/update/delete 给自己安排下一次唤醒，包括定时唤醒的回合和 goal 轮；工具层只拒绝被委派的子 agent。所以“每次醒来做一个长回合，结束前自己排下一次”不用写代码就能实现，但这条路线里没有“没做完就自动续一轮”的保障。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/README.zh.md（概述、四个工具）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js（grep 不到 source.kind 或 human 检查）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md（已知限制：被委派子 agent 以 subagent_session 拒绝）
- **C15**（依据：readme；对应 R3, R4, R1）机器人工作目录下的 AGENTS.md 或 CLAUDE.md 会被 dsh-agent-instructions 作为持久基线注入第一个请求，预算 65536 字节，恢复会话时会对账。它可以承载每个机器人的长期目标、什么时候停、什么时候求助、怎么汇报。这是 goal 之外模型每次都能看到的目标载体；goal 的变更本身不会注入模型上下文，只出现在 goal 轮提示和工具结果里。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-instructions/README.zh.md（概述、第 34 行指令链说明）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（模型体验：Goal 变更不会注入模型上下文）
- **C16**（依据：both；对应 R2, R3, R7, R8）dsh-taskboard 0.8.7（cloader 版）已经实现了一套无人值守执行器，可以直接借鉴。① 宿主侧 cron 或一次性调度，关掉浏览器照常跑。② 全局并发上限（默认 3）+ 持久 FIFO 队列 + 启动间隔节流。③ 会话复用策略，会话忙时回退新建；不往正在跑的会话里注入。④ 插件说明用自有 source kind 走 inject，任务正文以 user 来源走 followup。⑤ 等 whenIdle 后结算并采集证据。⑥ 代码级协议闸：agent 永远移不到 done。⑦ 结构化执行报告 + DoD 清单。⑧ 退回附原因。⑨ 定期任务“完成后新建待办”。它的源码里没有 /goal 续跑，也没有 0.65 阈值。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/README.md（功能特性、安全、配置与数据、0.7.2/0.7.6/0.8.1/0.8.2 升级日志）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts:715-770（busy 检查、inject+followup、whenIdle 结算）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/scheduler.ts:67-68,187-189（maxConcurrent 闸门）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/shared/version.ts（PLUGIN_VERSION '0.8.7'）；在 src 和 lib 里 grep 0.65、goal：只有 i18n 里的 /goal 补全提示

## 限制清单（* 为承重结论）

- **L1*** 续跑权限只存在进程内：App 重启、夜间自动升级、会话重新加载、fork 之后 goal 都是 disarmed，驱动器设计上绝不自行恢复。
  - 影响：机器人的目标会在重启或升级后悄悄停下，界面上 phase 仍显示 active。Agent 中心必须自己实现“开机重新武装”策略（恢复会话后调 ctx.goals.resume），面板也要显示 activation，不能只看 phase。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:594-596
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/README.zh.md（resume、fork 或卸载之后）
- **L2*** 定时唤醒的回合（source kind schedule）里，模型不能 create_goal，也不能 resume、edit 或 pause goal；paused 的 goal 模型永远不能恢复。
  - 影响：“schedule 唤醒 + 模型自己开 goal”这条路用官方零件拼不起来，需要插件直接调 ctx.goals.create/resume，或用 commands.execute('/goal …')；也可以以 kind 'user' 注入消息冒充人类授权，但这会弄脏审计。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:45-64,290-292,345-352
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1594
- **L3*** 只有轮数预算（默认 256），没有 token、金额、挂钟时间或提供方额度预算；轮与轮之间没有任何间隔，一空闲就发下一轮。
  - 影响：开放式、永不结束的目标会背靠背连跑到 256 轮。按用户每 5 小时的额度，一个机器人就可能把额度烧光，多个机器人同时 armed 会互相抢额度。节奏和预算必须由 Agent 中心自己控制。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（已知限制：只有 Round 数量预算）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:225,243（idle 即 requestDrive）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:11-16（提示里写着“还有活就保持 active”）
- **L4*** 无人值守时，ask_user_question（默认 legacy 模式）、exit_plan_mode、审批策略为 ask 的工具审批都没有超时，请求挂在网关里，等有窗口连上并且有人回答为止。
  - 影响：一个没人回答的问题会把这个机器人整个冻住：goal 停转，后续定时唤醒也排队。机器人需要专用 preset（ask-user 设为 timed、不开计划模式、审批设 never），或者自写一个带超时、能转发到飞书的应答器。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ask-user/lib/index.js:212-213
  - 证据：dsh-src/@deepseek-ai/dsh-api-gateway/lib/index.js:1014,1102
  - 证据：dsh-src/@deepseek-ai/dsh-plan-mode/lib/index.js:261
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:176
- **L5*** 模型请求重试耗尽（默认 normal 模式最多 5 次）后，会触发 agent/error，goal 被 disarm；回合因 max-tokens 结束时同样会 disarm。
  - 影响：碰上 5 小时额度上限或服务抖动时，所有在跑的目标同时停下，并且不会在额度恢复后自己继续，需要中心插件带退避地重新 resume。
  - 证据：dsh-src/@deepseek-ai/dsh-llm-retry/README.zh.md
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:211-213,274-277
- **L6** 一个会话只有一个当前 goal；目标只有一段文本，没有子目标、里程碑或 KPI 结构；轮数在同一个 goal 上一直累计。
  - 影响：一个机器人等于一个会话，同一时间只能推进一个子目标。长期目标的拆解、进度和历史要放进工作目录台账或自建存储；每个周期最好开新 goal，避免轮数累计撞上限。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:639
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（已知限制：只有一个当前 goal）
- **L7** 没有独立评估器：goal 和 ralph 的完成都由干活的模型自己声明；“卡住”也由模型自己判断，代码只机械地要求至少 3 轮。
  - 影响：机器人的“自我验收”质量取决于模型本身。要可靠验收，需要自建评审闸门，或者保留“验收权只属于人”。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/README.zh.md（已知限制：阻塞条件是否相同仍由模型判断）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ralph/README.zh.md（完成由 worker 自行声明）
- **L8** goal-round-driver 只按单个 agent 维护状态（states 是一个 Map），没有全局并发闸门，所有 armed 的 goal 会同时推进。
  - 影响：机器人数量一多，就会同时打满模型并发和额度，需要参考 taskboard 的全局并发上限加 FIFO 队列。
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:56-75（按 agent 的 states）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/scheduler.ts:67-68,187-189（对照：taskboard 自带并发闸门）
- **L9** ralph 只能前台运行，会占住父 agent 的一次工具调用；没有检查点，宿主重启后整次运行丢失；属于实验功能、默认关闭；“只在用户明确要求时使用”只靠提示词约束。
  - 影响：不能拿 ralph 做常驻机器人的主循环，只适合在某次唤醒里当执行器。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ralph/README.zh.md（已知限制：仅支持前台）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-ralph-bundle/README.zh.md
- **L10** auto-review 只把“从界面发出的用户消息”（kind user 且带 rpcId）当作人类授权。定时回合和 goal 回合里的 medium 级动作（对外写入或发送、删除已有对象等）会被拒绝，然后转人工审批。
  - 影响：想让机器人在无人值守时发飞书之类的外部写操作，不能依赖 Auto 模式，要换成别的权限方案（R7 路细化）。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/lib/index.js:20-44,91-92,476-484
- **L11** 宿主内插件接口跨版本常变：claude-bridge 在 0.2.1-rc.2 被迫从 typertGateway.invoke 改为直连 sessionController（因为 peer 变成必填）；taskboard 在 0.8.2 因 DSH v4 不再接受 source.kind 'plugin'，改用自有来源。
  - 影响：Agent 中心的胶水插件要只依赖 ctx.goals、commands、sessionController、agents 这类公开服务名，并在服务缺失时优雅降级；每次升级都要回归测试。
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js:20-30（注释说明改道原因）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/README.md（0.8.2 升级日志）

## 核查结果

- **C1：成立**。原结论：goal 数据模型：每会话最多 1 个当前 goal；字段 objective、maxGoalRounds（默认 256）、roundsStarted、phase（active/paused/blocked/complete）、blocked 时的 {code,message}、revision（比较并设置）；未完成的 goal 不能被 create 顶替（GOAL_ALREADY_EXISTS），complete 后可直接替换，否则先 clear；每次变更以完整快照 goal/change 事件追加进会话日志，跨天、重启、resume、fork 后都还在。
  - 核查说明：README 和 lib 都能对上。补充几点：(1) clear 写入的是带 revision 的 tombstone，不是完整快照；disarm 不写日志，也不改 revision。快照里还有 createdAt 和 updatedAt。(2) 状态转换规则：pause 和 block 只能从 active 出发；complete 可以从 active、paused、blocked 出发；resume 可以从未武装的 active、paused、blocked 出发。(3) README『何时使用』那句『未完成的 goal 必须先 edit、pause、resume、block 或 clear 才能被替代』写得不准确。按代码，只有 phase=complete 时才能直接 create，其余情况都要先 clear（或先 complete）。claim 的说法和代码一致。(4) 回放是严格的：如果插件直接往会话日志写入格式错误的 goal/change，这个会话的 goal 访问会整体报错，直到日志修好（README『信任进程内生产方』）。所以中心插件只能通过 ctx.goals 改 goal，不能自己写事件。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:588,593（defaultMaxGoalRounds default(256)）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:639（只有 phase!=='complete' 时抛 GOAL_ALREADY_EXISTS）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:763（GOAL_STALE_REVISION）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:865（agent.session.append('goal/change')）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:229-241（clear 折叠为 tombstone）、676/686/706/720（pause/resume/complete/block 允许的起始 phase）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:422-436（回放失败记入 failure，之后 state() 抛错）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（什么会保留；已知限制：只有一个当前 goal、信任进程内生产方）
- **C2：成立**。原结论：armed/disarmed 只存在进程内存。凡是 agent/created 边界（App 重启、升级、会话重载、fork），goal 都会被 disarm，驱动器不会自行复活。恢复途径：/goal resume 或 GoalBar；模型在含人类直接消息的回合里 update_goal resume；插件调 ctx.goals.resume；都受剩余轮数约束。所以 App 重启后目标不会自己继续跑。
  - 核查说明：README 和 lib 都支持。补充：(1) 除了 agent/created，还有两处会 disarm。goal-round-driver 插件加载时会把当时所有存活 agent 的 goal 都 disarm（driver:353），卸载时也会 disarm 并取消进行中的轮。GoalService 自己重载时 runtimeStates 换成新的 WeakMap，等于全部变成 disarmed。(2) 恢复途径还有 Remote 的 goals.resume，GoalBar 走的就是它。GoalBar 只对 paused 和『active 但 disarmed』显示恢复按钮；blocked 的 goal 只能用 /goal resume、模型在人类回合里恢复，或插件恢复。模型永远不能恢复 paused。(3) 轮数用完时 resume 会被拒，要先 edit 调高 maxGoalRounds。(4) 在全部官方包里 grep，除了 command-goal 和 tool-goal，没有任何代码调用 goals.resume 或 goals.create，也就是说官方没有『开机自动续跑』。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:594-596（agent/created → setActivation disarmed）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:590,778-787（runtimeStates WeakMap；初始 disarmed）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:696-697（已 armed 或轮数耗尽时 resume 报错）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:353-373（加载时 disarm 所有存活 agent；teardown 时 disarm 并取消）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/README.zh.md（resume、fork 或卸载之后：绝不会自行复活工作）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-goal/lib/client.js:269（showResume 只覆盖 paused 和 active+disarmed）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:352（GOAL_TOOL_RESUME_PAUSED）
- **C3：成立**。原结论：驱动器在 agent 存活且空闲、没有排队的人类输入、flush 成功、goal 为 active 且 armed、子 agent 全部结束、轮数未满时，用 agent.followup 投一条 user 角色、source kind=goal 的 <goal_round> 提示。只有进入历史的轮才计数。轮与轮之间没有等待或节流，人类输入优先。
  - 核查说明：README 和 lib 都支持，几处细节更正：(1)『没有排队的人类输入』在代码里的实际含义是：收件箱 next-turn 里没有除本轮预留以外的任何消息（agent/inbox/inserted 会置 competingQueued）。定时提醒、其他插件的 followup 同样会让 goal 轮让行，不只是人类输入。(2) 轮数满了不是简单地不发，而是直接 block，code 为 round-limit。(3) 消息进入步骤前，pre-step 还会再校验一次 revision、armed 和轮号；如果被下游的 pre-step 拒绝，会 block，code 为 prompt-rejected。(4) agent.followup 的调用在 lib:164，143-152 只是构造消息。其余几点（idle 且存活、flush 检查点、active+armed、waitForChildren、只计入已准入的轮、没有任何计时器或节流）都和代码一致，driver 全文没有 setTimeout。
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:11-18（renderGoalRoundPrompt）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:84-86（readyToDrive）、108-121（flush，失败则 disarm）、130-141（waitForChildren；round-limit）、142-164（source kind goal；agent.followup）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:223-248（idle 或 goal/changed → requestDrive，无延时）、249-256（任何 next-turn 插入都置 competingQueued）、326-333（prompt-rejected）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:273-281（只有已准入、来源为 goal 的 user/message 才推进 roundsStarted）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/README.zh.md（每轮做什么；设计：先预留，后准入）
- **C4：部分成立**。原结论：停止条件：complete 只能在当前 goal 轮或含人类直接消息的回合里调，成功后注入 <goal_complete>；blocked 在 goal 轮里要求 roundsStarted≥3；驱动器会 block 为 round-limit 或 queue-failed；人可以 /goal pause（中止正在跑的轮）或 /goal clear；人取消正在跑的轮，下次空闲时 goal 被 pause；agent/error、max-tokens、flush 失败只 disarm，phase 仍是 active；除轮数外没有其他预算。
  - 核查说明：大方向对，但有几处偏差：(1) <goal_complete>/<goal_blocked> 收尾只在『goal 轮授权』下注入。人类回合里的 complete/blocked、插件调用、/goal 命令都不会注入。(2) 收尾只是一段提示词，要求『本次运行不要再调用任何工具』；代码只做了 deferContext，没有调 concludeTurn。tool-goal README:57 说会『结束物理轮次』，和代码注释『取代原先的硬停止』对不上。(3) 驱动器自己的 block 码还有第三个：prompt-rejected，即 goal 轮在 pre-step 被下游拒绝。(4) 取消正在跑的 goal 轮（不论谁取消），下次空闲时 goal 会持久变成 paused，而模型永远不能自己恢复 paused。取消的如果是非 goal 回合（人自己的对话回合、定时唤醒回合），goal 只被 disarm。(5) 宿主侧的 pause（/goal pause、GoalBar、插件调 ctx.goals.pause）会取消当时正在跑的任何回合，不限于 goal 轮；模型在自己回合里 pause 则不取消。(6) blocked 门槛只在 goal 轮授权下检查 roundsStarted≥3，人类回合里随时可以 blocked；模型上报的 code 固定为 model-reported。(7)『除轮数外没有预算』成立，但每一轮内部也没有步数或请求数上限，见 L3。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:62-80（requireDirectHuman / completionAuthority）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:356-372（阈值只对 goal-round 生效；只有 goal-round 才 deferContext 收尾；code model-reported）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:83-97（收尾文本：Do not call any more tools in this run）
  - 证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3248-3253（deferContext 和 concludeTurn 是两个独立机制）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/README.zh.md:57,74
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:136-139,169-172,326-333（round-limit / queue-failed / prompt-rejected）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:211-213（agent/error → disarm）、229-235（取消 goal 轮 → pause）、246（宿主 pause 会 cancel 正在跑的回合）、273-281（max-tokens → disarm；非 goal 回合中止 → disarm）
- **C6：部分成立**。原结论：create_goal 和 update_goal 的 edit/pause/resume 要求根 agent 且当前回合有 source.kind==='user' 的消息。schedule 消息是 kind 'schedule'，所以定时唤醒回合里模型不能开 goal、不能恢复 disarm，只能对当前 goal 轮做 complete/blocked；paused 一律不能被模型恢复。sessionController.prompt（kind user + rpcId）和 dsh-taskboard 正文（kind user）都带人类授权。
  - 核查说明：授权规则本身都对，但『定时唤醒回合里……只能对当前 goal 轮做 complete/blocked』这句会误导。completionAuthority 只认两种回合：当前回合里有 kind==='user' 的消息，或者当前回合就是驱动器发出的那一轮 goal 轮。纯定时唤醒的回合两样都不是，模型在里面连 complete/blocked 也做不了，只能 get_goal。补充：(1) 人类授权只看 source.kind==='user'，不要求 rpcId。tool-goal README:72 明确说 followup/steer 省略 source 时默认就是 user，非人类生产方应该自带 source、不应继承人类权限。taskboard 用 kind user 投递正文，属于借用人类授权。(2) 同一条 taskboard 消息，auto-review 不认作人类指令（它要求 kind user 且带 rpcId）。各插件对『人类』的定义不一致。(3) 模型不能 resume paused，但在人类回合里可以先 complete（允许从 paused 出发），再 create 一个新 goal。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:44-56（hasDirectHumanInput：root + kind user；isMatchingGoalRound）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:72-80（completionAuthority 只有 direct-human 和 goal-round 两种）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:290-292,342-353（create/edit/pause/resume 需人类；GOAL_TOOL_RESUME_PAUSED）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/README.zh.md:55,71-72
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1576,1594（resolveAgent；source kind schedule）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3224-3229（prompt：kind user + rpcId）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts:736-747（inject 用 kind dsh-taskboard；followup 用 kind user，不带 rpcId）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/lib/index.js:91-92（isHumanInstruction 要求 rpcId）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:706-712（complete 允许从 paused 出发）
- **C7：成立**。原结论：插件可绕过模型工具直接控制 goal：ctx.goals.create/edit/pause/resume/complete/block/clear/disarm 只要求精确的存活 Agent 和 {id,revision}，不查人类授权；create 后立即 armed 并触发 goal/changed，驱动器自动发第 1 轮；也可以用 commands.execute(agent,'/goal …')（用户的 claude-bridge 已这样用）或 Remote goals 命名空间；冷会话要先 sessionController.resolveAgent。
  - 核查说明：lib 已确认。补充：(1) Remote 命名空间 goals 只导出 get/edit/pause/resume/complete/clear/create，没有 block 和 disarm。(2) Remote 调用里的 agent 参数通过 Typert 的 agent lookup 解析，而这个 lookup 走的就是 sessionController.resolveAgent，会自动恢复冷会话，所以走 Remote 不需要先手动 resolve。进程内调用 ctx.goals.* 才需要拿到精确存活的 Agent 对象（assertLive）。(3) create 之后，第 1 轮要等 agent 空闲才发（readyToDrive 要求 idle）。如果当时正在跑的回合被取消，新 goal 会直接被 disarm。(4) /goal 命令路径的 create 不能带轮数上限，只能用默认 256。用户 bridge 的 executeCommand 先用 ctx.agents.get 取 agent，所以只对已存活的会话有效。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:496-502（Remote 方法列表）、635-648（create → commitSnapshot(..., 'armed')）、755-769（prepareMutation/expectCurrent/assertLive，没有授权检查）、877（emit goal/changed）、896（remoteExportCreate）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:84-86,243-248
  - 证据：dsh-src/@deepseek-ai/dsh-command-goal/lib/index.js:126-134（/goal create 不传 maxGoalRounds）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:189-203（typert agent lookup → resolveAgent）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1576（sessionController.resolveAgent）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js:83-90（ctx.agents.get + ctx.commands.execute）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:350,564
- **C8：部分成立**。原结论：无人值守时会无限期挂起：ask_user_question 默认 legacy 阻塞（standard preset 没改）；exit_plan_mode 用阻塞 ask()；审批策略为 ask 时也等。请求经 api-remotes 转发到网关，没有窗口时挂在 pendingRemoteEvents，等有窗口连上再投递，没有超时。期间 agent 一直是 running，goal 不发下一轮，定时提醒排队。缓解：ask_user_question 设 mode timed（默认 120 秒，到期返回 pending）；审批策略设 never。
  - 核查说明：主干事实都成立：(1) legacy 是默认值，standard、cordis、ptc 三套 Web preset 都没给 tool-ask-user 配置。(2) exit_plan_mode 用的是阻塞的 ask()。(3) 审批和提问都以 waterfall 方式转发。网关把请求放进 pendingRemoteEvents，只投给 owner 身份的窗口；窗口断开不会结算请求，代码里也没有任何定时器；只有回合被取消或 Agent Context 被释放时才会结束。但缓解措施不严密：(a) 即使设成 timed，模型仍可以传 timeout:-1，回到 legacy 的无限等待；工具描述里本身就写着『必须先得到答案时才用 -1』。(b) timed 的宿主倒计时只在没有窗口持有这个等待时才计时；有窗口连着时，由客户端倒计时决定。(c) 超时以后，用户迟到的回答以 user-question-reply 来源 steer 进来，不算人类授权。另外，user-approval 的 README 和系统提示说『没有可用应答者时 fail closed』，但在桌面组合里，api-remotes 的转发器本身就算一个应答者，所以实际表现是挂起而不是拒绝。这一点和 claim 的结论一致。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ask-user/lib/index.js:211-214（mode 默认 legacy；timeout 默认 120）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ask-user/lib/index.js:8-10,120,181-198（timeout 可以是 -1；为 -1 时走阻塞的 ask）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:110-111（tool-ask-user 没有 config）
  - 证据：dsh-src/@deepseek-ai/dsh-api-remotes/lib/index.js:27,136,170,233-248（waterfall 转发）
  - 证据：dsh-src/@deepseek-ai/dsh-api-gateway/lib/index.js:1013-1014,1062-1108,1130-1135（pendingRemoteEvents；只投给 answers=owner 的窗口；移除窗口不结算）
  - 证据：dsh-src/@deepseek-ai/dsh-user-questions/lib/index.js:297-345（有窗口 claim 时不计时）、563（user-question-reply）
  - 证据：dsh-src/@deepseek-ai/dsh-plan-mode/lib/index.js:261（exit_plan_mode → interaction.ask）
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:37,41,176（策略只有 ask/never；never 直接返回 rejected）；README.zh.md:12,36
- **C9：成立**。原结论：模型请求失败默认只重试 5 次（RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT、EMPTY_RESPONSE，退避 500ms 到 10s），用尽后回合以错误结束并发出 agent/error，goal 驱动器随即 disarm；所以碰上 5 小时用量上限时，正在跑的机器人目标都会停下，不会自己恢复；retryPolicy 设为 always 则会一直重试、占着回合。
  - 核查说明：结论成立，但触发路径要补充：用量上限多半根本不会重试 5 次。(1) 报错文本里如果有 quota、usage limit exceeded/reached 之类的字样，或者 HTTP 状态是 402，会被归为 QUOTA；账号渠道还会再改成 ACCOUNT_QUOTA。这两个码都不在默认可重试列表里，会直接失败。(2) 如果是 429，但带的 Retry-After 超过 maxDelayMs（默认 10 秒），normal 模式也会直接放弃。(3) always 模式不看可重试码，连配额错误也会无限重试（README 已知限制）；Retry-After 过长时退回本地退避（≤maxDelayMs）。这样回合不会以错误结束，goal 也不会被 disarm，代价是一直占着回合、反复请求。(4) 默认的 retryPolicy 由各个提供方适配器给出，dsh-base 和 web-app 的 patch 都没有配置，所以默认就是 normal。另外，定时提醒不受影响：提醒写进收件箱并 flush 成功后就算已投递，周期提醒会照常排下一次。
  - 证据：dsh-src/@deepseek-ai/dsh-llm/lib/index.js:247-258（DEFAULT_MAX_RETRIES=5；默认可重试码；500ms/10s/0.1 抖动）
  - 证据：dsh-src/@deepseek-ai/dsh-llm/lib/index.js:138-140,181-183（QUOTA/ACCOUNT_QUOTA；isQuotaExceededError）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-deepseek/lib/index.js:1775-1776（quota 文本或 402 → QUOTA；429 → RATE_LIMIT）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-deepseek-account/lib/index.js:88（QUOTA → ACCOUNT_QUOTA）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-retry/lib/index.js:153-170（always 不看可重试码；normal 下码不合格或 Retry-After>maxDelayMs 时直接 next()）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-retry/README.zh.md（最小配置；已知限制：always mode 会重试永久性失败）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:99-100
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:877-884,1010-1027（回合错误 → agent/error）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:211-213
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1595-1620
- **L1：部分成立**。原结论：续跑权限只在进程内：App 重启、夜间自动升级、会话重载、fork 后都是 disarmed，驱动器绝不自行恢复。影响：目标会悄悄停下，界面上 phase 仍显示 active；Agent 中心要自己实现开机重新武装，面板要显示 activation。
  - 核查说明：disarm 机制和『中心要自己重新武装、要显示 activation』这两点都对，但有两处说错：(1)『夜间自动升级』不成立。桌面更新设置了 autoDownload=false 和 autoInstallOnAppQuit=false，下载和安装都要用户另外确认；『nightly』只是更新通道的名字。重启来源主要是用户退出、用户确认升级、崩溃，以及无 HMR 时改插件需要的重启。(2)『界面上 phase 仍显示 active』只对只读 goal 投影的地方成立，比如 session.projections 和用户自己的 bridge。官方 GoalBar 会读 activation，把『active 但 disarmed』显示成『已暂停的目标』（英文 Inactive Goal），并给出恢复按钮。只是这个文案和真正的 paused 一样，容易混淆。还有一个实现上的坑：开机重新武装必须在 goal-round-driver 加载之后做，因为驱动器加载时会把当时所有存活 agent 的 goal 再 disarm 一遍。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:594-596
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:353（驱动器加载时 disarm 所有存活 agent）
  - 证据：dsh-src/_app/main.js:7806-7807（autoDownload=false、autoInstallOnAppQuit=false）、7871（Install a prepared target after a separate user confirmation）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-goal/lib/client.js:166-169,268-269,525-528（active+disarmed 显示为『已暂停的目标』，并给恢复按钮）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:439-451（goal 投影的 wire view 只有 state.current，不含 activation）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:564-575（只读 phase）
- **L2：成立**。原结论：定时唤醒回合里模型不能 create/resume/edit/pause goal，paused 的 goal 模型永远不能恢复；所以『schedule 唤醒 + 模型自己开 goal』用官方零件拼不起来，需要插件直接调 ctx.goals 或 commands.execute('/goal …')；用 kind 'user' 注入冒充人类会弄脏审计。
  - 核查说明：代码和 README 都支持。补充：(1) tool-goal README:72 明确要求非人类生产方自带 source、不继承人类权限，所以用 kind user 注入不只是弄脏审计，也违背了设计意图。(2) 官方零件里，只有 sessionController.prompt（也就是界面或 Remote 发消息）是 kind user；dsh-schedule 固定是 kind schedule，没有配置项能改。(3) 一个边角情况：在人类回合里，模型可以把 paused 的 goal 先 complete 再 create 一个新 goal。在定时回合里，模型连 complete/blocked 都做不了，见 C6。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:44-80,290-292,342-353
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/README.zh.md:72
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1594
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:125（到期提醒以生产者 kind 为 schedule 的 user-role 消息进入会话）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:706-712
- **L3：部分成立**。原结论：只有轮数预算（默认 256），没有 token、金额、挂钟时间或提供方额度预算；轮与轮之间没有间隔。影响：开放式目标会背靠背连跑到 256 轮，一个机器人就可能把 5 小时额度烧光，节奏和预算必须由 Agent 中心控制。
  - 核查说明：所述事实都对，但低估了预算风险，漏了几点：(1) 256 只是默认值，不是上限。maxGoalRounds 只校验是不是正的安全整数；模型在人类回合里调 create_goal 或 edit、插件调用、Remote 调用都可以填任意大的数。相比之下 ralph 有 deployment ceiling。(2) 每一轮内部没有步数或请求数上限（agent-loop README：没有内置轮次预算），repeat-tool-reminder 只提醒不阻止。所以 256 轮不等于 256 次模型请求，一轮里可以连续调用很多次工具和模型。(3) 模型会主动 create_goal：工具描述鼓励『即使用户没说 goal』也创建，任何含 kind user 消息的回合都满足授权；模型不填上限时就是 256。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（已知限制：只有 Round 数量预算）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:455-458,465-469（maxGoalRounds 只校验正安全整数）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:123,284-297（CREATE_DESCRIPTION；max_goal_rounds 原样传给服务）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ralph/lib/index.js:145-146（对比：ralph 超过 deployment ceiling 会报错）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md（已知限制：没有内置轮次预算）
  - 证据：dsh-src/@deepseek-ai/dsh-repeat-tool-reminder/README.zh.md（概述：提醒只是建议，绝不阻止）
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:11-18,223-248
- **L4：部分成立**。原结论：无人值守时 ask_user_question（默认 legacy）、exit_plan_mode、审批策略为 ask 的工具审批都没有超时，请求挂在网关里，直到有窗口连上并有人回答；一个没人回答的问题会冻住整个机器人。需要专用 preset（ask-user timed、不开计划模式、审批 never）或自写带超时、能转发飞书的应答器。
  - 核查说明：挂起机制成立（见 C8），以下几处要修正：(1) 结束条件除了『有人回答』，还有『回合被取消』和『Agent Context 被释放』。(2)『ask-user 设为 timed』不能保证不卡住，因为模型仍可传 timeout:-1 无限等待。要硬性保证，得在机器人专用 preset 里去掉 tool-ask-user，或者自写一个先注册的 user-questions/request 应答器，统一超时或拒绝。(3) 模型没有进入计划模式的工具，exit_plan_mode 只在会话已经处于计划模式时可用，所以只要中心不替机器人切换到计划模式就不会碰到。(4) 审批设 never 是在服务内部、waterfall 之前就拒绝，后注册的应答器也绕不过去。自写审批应答器只在 ask 策略下有效。(5) 子 agent（包括 ralph 的 worker）提问时会直接报 DELEGATED_CALLER，不会挂起。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ask-user/lib/index.js:8-10,120,181-198,211-214
  - 证据：dsh-src/@deepseek-ai/dsh-api-gateway/lib/index.js:1062-1108,1136-1146（结算或取消路径）
  - 证据：dsh-src/@deepseek-ai/dsh-plan-mode/lib/index.js:34,230,255,261（只有 exit_plan_mode 一个工具，且只在计划模式下可用）
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:176；README.zh.md:77（never 在 waterfall 之前执行，prepend 的监听器也绕不过）
  - 证据：dsh-src/@deepseek-ai/dsh-user-questions/lib/index.js:534（DELEGATED_CALLER）
- **A1：成立**。原结论：（抽查读者回答 2）ralph：bundle 配 64 轮，工具默认 256，交接报告不超过 16384 字符
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-ralph-bundle/cordis.patch.yml（maxRounds: 64）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ralph/lib/index.js:19-22,128-130
- **A2：成立**。原结论：（抽查读者回答 3）auto-review 只把 kind=user 且带 rpcId 的消息当作人类授权
  - 核查说明：由此可推出：dsh-taskboard 投递的 kind user 正文不带 rpcId，对 auto-review 不算人类指令，但对 tool-goal 算。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/lib/index.js:91-92
- **A3：成立**。原结论：（抽查读者回答 6）本机 dsh-taskboard 版本 0.8.7；全局并发默认 3，可用 DSH_TASKBOARD_MAX_CONCURRENT 覆盖；源码里没有 /goal 续跑
  - 核查说明：在 src 和 lib 下 grep '/goal' 都没有结果，和读者说的一致。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/shared/version.ts:9
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/shared/protocol.ts:125
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts:77-78
- **A4：成立**。原结论：（抽查读者回答 4、5）模型在任何回合都能调 schedule 工具；timed 模式下迟到的回答以 user-question-reply 送达，不算人类授权；子 agent 提问报 DELEGATED_CALLER
  - 核查说明：在 dsh-tool-schedule 的 lib 里 grep kind==='user'、roots()、human 都没有结果，即没有人类授权检查（这是否定性证据）。user-question-reply 通过 agent.steer 进入回合，而 tool-goal 只认 kind 'user'。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js（全文无授权检查）
  - 证据：dsh-src/@deepseek-ai/dsh-user-questions/lib/index.js:534,556-575

## 核查员补充（读者漏掉的点）

- maxGoalRounds 没有部署上限，256 只是默认值。模型（在人类回合里）、插件、Remote 都可以把 goal 的轮数设成任意大的正整数，所以中心如果要设上限，必须自己在 create 和 edit 时做校验。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:455-458,465-469
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:284-297,340-345
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ralph/lib/index.js:145-146（对比 ralph 有 ceiling）
- 单个 goal 轮内部没有步数或请求数预算。agent-loop 没有内置的回合预算，repeat-tool-reminder 只提醒不阻止，设置页也只能调并行工具数。所以按『轮数』限额并不能限住用量，中心需要在 agent/turn-stopping 或 agent/pre-step 自己计量 token 和请求数，并主动取消回合。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md（已知限制：没有内置轮次预算，要从 agent/turn-stopping 等扩展点执行取消）
  - 证据：dsh-src/@deepseek-ai/dsh-repeat-tool-reminder/README.zh.md（概述）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-settings-agent-loop/README.zh.md（只有并行工具调用数一项）
- 模型会自己开 goal。create_goal 的描述鼓励『即使用户没说 goal』也创建，执行时只校验回合里有没有 kind user 的消息。中心如果用 kind user 给机器人派活（taskboard 就是这么做的），每个机器人都可能自己启动一个 256 轮的连续长跑。tool-goal README 也承认，它无法判断请求是否值得建 goal。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:123,195-197,290-297
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/README.zh.md:147
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts:742-747
- 各插件对『人类授权』的定义不一致。tool-goal 只看 source.kind==='user'（followup/steer 省略 source 时默认就是 user）；auto-review 要求 kind user 且带 rpcId。同一条插件投递的消息，对 goal 工具算人类，对 auto-review 不算。中心需要给自己投递的消息定一个独立的 source kind，并明确授权策略。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:44-52
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/README.zh.md:72
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/lib/index.js:91-92
- 除了重启，还有多条会让 goal 悄悄停下的路径：(1) goal-round-driver 插件加载或卸载时，会把所有存活 agent 的 goal disarm。(2) GoalService 重载后 runtimeStates 清空。这是推断：改 dsh-goal 的配置，或者在没有 HMR 时增删插件需要重启，都会触发。(3) 中止任何非 goal 回合（人取消自己的对话、中心取消定时回合）都会 disarm。(4) 宿主侧 pause 会取消当时正在跑的任何回合。(5) goal 轮被任何来源取消后，goal 会持久变成 paused，而模型永远不能自己恢复 paused。中心的『一键暂停』如果用 cancel 实现，会把 goal 变成只有人或插件才能恢复的 paused。
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:229-235,246,273-281,353-373
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:588-590,778-787
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:352
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md:14,100（未启用 HMR 时，组合改动要等重启才生效）
- goal 的目标文本对模型基本不可见。goal 变更不会注入上下文；tool-goal 的系统提示是固定文本，不含目标；只有 <goal_round> 提示和 get_goal 工具能看到目标。所以机器人在定时唤醒或普通对话的回合里，并不知道自己的长期目标，除非它主动调 get_goal，或者中心把目标另外写进 AGENTS.md 或人设。README 开发备注把『始终可见的 goal 上下文插件』列为尚未实现的方向。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md:140（模型体验：Goal 变更不会注入模型上下文）、169（开发备注）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:195-197,259-263
- 自主 complete/blocked 之后的收尾提示要求模型『本次运行不要再调用任何工具』，所以机器人完成时不会自己发飞书通知。通知应该由中心插件订阅 goal/changed（带 operation、ref 和最新视图）和 goal/activation-changed（带 sessionId 和 armed/disarmed）来推送。注意：重启后不会补发 disarmed 事件，因为新进程初始就是 disarmed，setActivation 只在状态变化时才发事件。所以开机后要主动 ctx.goals.get，或者读冷投影推断。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:91-97,365-372
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:789-806（只在变化时 emit goal/activation-changed）、877（emit goal/changed）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（事件与归属）
- schedule 比 goal 更经得起出错。提醒写进收件箱并 flush 成功后就记为已投递，之后回合是否报错都不影响，周期提醒会照常排下一次。goal 则一遇到 agent/error 就 disarm，而且不会自己恢复。此外，任何 next-turn 消息（包括定时提醒）都会让 goal 轮让行。所以用 schedule 当机器人的『心跳』，再在每次唤醒里推进一个有边界的子任务，比依赖 goal 自己续跑更可靠。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1576-1620
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:65
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:211-213,249-256
- 官方没有跨会话的并发上限或限流。goal 驱动器按每个 agent 各自调度，没有全局信号量；在 agent-loop 和 session-controller 里 grep 也没找到 maxConcurrent 之类的配置（否定性证据）。用户遇到的『活动会话已达上限 2』来自自写 bridge 的护栏（DEFAULT_MAX_ACTIVE_SESSIONS=2，可调 1 到 4）。另外，bridge 只读投影里的 phase、不读 activation：遇到 max-tokens 这类只 disarm、不改 phase 的情况，phase 仍是 active，bridge 不会把任务判为终态，可能一直占着名额（这是推断，未实测）。
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:55-73
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:54,161,311-312,535-546,564-575
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:273-276（max-tokens 只 disarm）
- 碰到用量上限时，多半一次都不重试就失败。QUOTA 和 ACCOUNT_QUOTA 不在默认可重试码里；429 的 Retry-After 超过 10 秒时，normal 模式也直接放弃。如果改成 always 模式，它会无限重试，连配额错误也重试，一直占着回合。两种做法各有代价，中心最好自己感知额度（比如订阅 agent/error 并读 code），统一暂停和恢复所有机器人。
  - 证据：dsh-src/@deepseek-ai/dsh-llm/lib/index.js:138-140,247-258
  - 证据：dsh-src/@deepseek-ai/dsh-llm-deepseek/lib/index.js:1775-1776
  - 证据：dsh-src/@deepseek-ai/dsh-llm-retry/lib/index.js:153-170
  - 证据：dsh-src/@deepseek-ai/dsh-llm-retry/README.zh.md（已知限制）
- ask_user_question 的 timed 模式不能保证不卡住：模型可以传 timeout:-1 无限等待；有窗口持有这个等待时，宿主不计时。要让无人值守的机器人确定不会卡住，只能在机器人专用的 preset 里去掉 tool-ask-user，或者自写一个先注册的 user-questions/request 应答器，统一给超时或转发飞书。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ask-user/lib/index.js:8-10,120,181-198
  - 证据：dsh-src/@deepseek-ai/dsh-user-questions/lib/index.js:297-345,613-640
- 归档会话的所有步骤都会被拒绝（ArchivedSessionGate）。如果把机器人会话归档，它的 goal 轮会被拒：如果驱动器的 pre-step 先执行，会 block 为 prompt-rejected；如果拒绝发生在驱动器监听器之前，则可能在空闲时变成 pause。具体走哪条取决于监听器注册顺序，我没有核实。取消归档后还需要显式 resume。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2509-2517
  - 证据：dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:229-235,326-333

## 缺口与补法

- [R3｜工作量 S] 没有长期目标结构：没有子目标树、里程碑、KPI、周期进度台账；goal 只有一段文本，todo 每个回合都会清空。
  - 补法：零代码起步：在每个机器人的工作目录放 AGENTS.md（写目标章程）和 goals.md、ledger.md（拆解、进度、每周期产出），由模型读写。之后可升级为自写插件存储，加上面板展示。
- [R3/R2｜工作量 M] 官方零件里没有“定时唤醒 → 自动开一个有界 goal”的胶水，因为定时回合里模型无权自己开 goal。
  - 补法：自写宿主插件（或在 dsh-schedule 投递之后补一步）：到点后用 sessionController.resolveAgent 恢复会话；若上一周期的 goal 没完成，先 clear 并记录；再调 ctx.goals.create(agent,{objective:本周期子任务, maxGoalRounds:5~10})，驱动器会自动开跑；最后监听 goal/changed 记录结果。
- [R3/R9｜工作量 M] 重启、升级、模型请求出错之后，goal 被 disarm，不会自己恢复。
  - 补法：中心插件在启动时，以及收到 agent/error 后按退避节奏，对“应该在跑”的机器人恢复会话并调 ctx.goals.resume（受剩余轮数约束）；面板显示 activation。
- [R3｜工作量 M] 没有独立的完成评审（自我验收）。
  - 补法：仿 auto-review 写一个 tools/pre-execute 闸门，拦截 update_goal(complete)，用 ctx.llm.stream 让评审模型读真实的工具调用记录，按多项判据打分（可沿用旧看板“三项各≥0.65、修一轮、二次不过判失败”的规则）；不达标就拒绝并反馈。也可以改成 complete 之后复核，不过关再开一个修复 goal。
- [R3/R7｜工作量 M] 只有轮数预算，没有节奏、token、时间或金额预算，也没有全局并发控制。
  - 补法：中心插件维护全局并发信号量和 FIFO 队列（参考 taskboard 默认 3），按机器人和周期统计请求或 token 用量，超额就 pause 或 disarm，并通知用户。
- [R3/R5｜工作量 S] 无人值守时，提问、计划审批、工具审批会无限期挂起。
  - 补法：先改配置：机器人专用 preset 里 tool-ask-user 设 mode: timed（或去掉这个工具）、不开计划模式、审批策略设 never（S）。进阶：自写 user-questions/request 和 approval/request 应答器，带超时、能转发飞书、有默认策略（M）。
- [R3｜工作量 M] 卡住检测太弱：只有模型自己报 blocked（至少 3 轮）和完全相同的重复调用提醒，没有“多轮没进展”的检测。
  - 补法：中心插件监听 goal 轮的结束，比较工作区或台账在连续 N 轮里有没有变化、blocker 是不是同一个；满足条件就 pause 并通知用户。
- [R3/R8｜工作量 M] 目标状态只能在单个会话里看（GoalBar、/goal），没有跨机器人的总览。
  - 补法：面板插件冷读各机器人会话的 goal 投影，订阅 goal/activation-changed，展示目标、phase、轮数和下次唤醒时间（R8 路细化）。
- [R3（Q6）｜工作量 M] “三项判据各≥0.65”的自动验收出自旧的 @linxin666/dsh-client-ui-task-board，本机已不存在，无法复用或核实；现装的 dsh-taskboard 0.8.7 没有这项功能。
  - 补法：按上面的“完成评审闸门”重写，或请用户确认能否找回旧插件源码。

## 可调用的宿主接口

- `ctx.goals（GoalService）`：插件直接读写机器人的目标：get / create({objective,maxGoalRounds}) / edit / pause / resume / complete / block / clear / disarm。需要精确的存活 Agent 和 {id,revision}，服务层不检查人类授权；create 后立即 armed，驱动器自动开第 1 轮。
- `Remote 命名空间 goals（get/create/edit/pause/resume/complete/clear）`：给中心面板或外部客户端（owner 身份）用 RPC 管理每个会话的 goal；GoalBar 就是用它来暂停和恢复的。
- `事件 goal/changed、goal/activation-changed`：goal/changed 在持久化提交后触发，带 operation、ref、最新视图，可用于记录周期结果、在 complete 或 blocked 时推送通知、触发复核。goal/activation-changed 表示进程内 armed/disarmed 的切换，会被转发给客户端，用于面板显示“是否真的在跑”。
- `会话投影 goal（sessionController.projections → values.goal.goal.phase）`：冷读每个机器人会话的目标状态，不需要激活 agent；用户的 claude-bridge 就是这样判断终态的。
- `ctx.commands.execute(agent, '/goal …', [], signal)`：走面向人类的命令路径来开、恢复、暂停、清除 goal（例如 '/goal <目标>'、'/goal resume'）。这是已验证的做法，但不能指定单次的轮数上限。
- `ctx.sessionController.resolveAgent / create / prompt；ctx.agents.create / resume / get；agent.inject / followup / steer / cancel / whenIdle`：唤醒冷会话、注入开场说明（用自有 source kind）、投递任务正文，以及等回合静止后结算。注意 prompt 和 kind 'user' 的 followup 会带人类授权。
- `tools/pre-execute 监听（prepend）+ ctx.llm.stream`：仿照 auto-review 做“完成评审闸门”：拦截 update_goal(action=complete)，让评审模型读会话里真实的工具调用记录，按多项标准打分；不达标就拒绝这次调用，并把理由作为错误结果回给模型。
- `waterfall：user-questions/request、approval/request`：自写无人值守应答器：按 agent 作用域拦截机器人的提问和审批，可以按策略自动答、超时给默认值，或转发到飞书等人回复，避免无限期挂起。
- `agent 生命周期事件：agent/status、agent/error、agent/inbox/inserted、session/event（turn/end 的 reason）`：监测机器人是空闲、出错还是因 max-tokens 结束，检测卡住或停摆，并在出错后带退避地重新 resume goal；驱动器自己也是用这些事件。
- `配置项：dsh-tool-ask-user mode: timed / timeout；dsh-user-approval policy 或 setPolicy(agent,'never')；dsh-goal defaultMaxGoalRounds；dsh-tool-goal blockedAfterConsecutiveRounds`：给机器人专用 preset 配置无人值守行为：提问会超时、审批确定性拒绝、轮数上限更小、受阻阈值可调。
- `ralph 工具（ctx.workflowEngine + ctx.subagents）`：某次唤醒里需要“每轮全新上下文、状态全在文件里”的长任务时，当执行器用。需要先在插件页开启实验 bundle。
- `AGENTS.md（dsh-agent-instructions）与 schedule_* 工具`：零代码层：AGENTS.md 写机器人的长期目标、停或求助的规则、汇报格式，每个会话都能看到；模型用 schedule_create 给自己安排下一次唤醒。

## 读者留下的未决问题

- 关闭桌面窗口（或退到托盘）后，Electron 的宿主进程是否还在运行，决定了 goal 和定时任务在无窗口时能不能继续。本路没有核查 main.js，需要 R9 那一路确认。
- 默认 GLM 提供方在 5 小时额度用尽时返回什么错误码：是否会被归为 RATE_LIMIT、是否带 Retry-After，以及额度恢复后多久能继续，本路都没有核实。
- 用户 dsh-playbook.md 描述的 @linxin666/dsh-client-ui-task-board（armGoal、三项≥0.65 的裁判）源码不在本机，打分维度和提示词无法核实，需要用户确认还能不能找回。
- 插件直接调 ctx.goals.create/resume，或者以 kind 'user' 注入消息来“代替人类授权”，在官方后续版本里是否会被收紧不确定。官方 README 明确要求非人类生产方使用自有 source。
- 用户的桥曾报“活动会话已达上限 2”。这是桥自己的限制还是宿主限制，以及同时存活很多机器人会话时的内存和并发上限，本路没有核实，需要 R9 那一路确认。
- docs/subsystems/goal.zh.md 等仓库文档没有随 npm 包分发，评估器和“始终可见的 goal 上下文”插件的路线图无法核实。
