# 底稿：多机器人协作与编排（R6）

> 研究底稿（2026-11-04，DSH 桌面版 0.2.1-rc.5）。先由一位读者细读官方插件说明与源码，再由另一位核查员逐条尝试推翻承重结论；「核查」一节里的修正优先于「读者结论」。证据路径中的 `dsh-src/` 指从安装包只读解出的官方插件源码，可用 `tools/asar_extract.py` 重新解出。

## 读者总结

DSH 自带三套多智能体机制，都已在代码里确认：subagent（父子委派）、Agent Teams（实验功能，一个总管 Lead 带具名队友，可以互发消息、共用任务板，桌面插件页的「智能体团队」开关就是它）、workflow（一段一次性的 JS 编排脚本，把活扇出给多个子代理）。这三套都是「一个会话内临时拉人干活」的设计。队友和子代理共用总管的工作目录、preset 和模型，不能自己定时醒来，代码里写死拒绝。总管不在内存时，全队都叫不醒；消息不持久、不重试，也不跨进程。桌面组合包把队友上限配成 8 个，失败的也算，名字永久不能删。要做「很多个各有目标、会自己醒来的机器人」，更可行的是架构 B：每个机器人是一个独立的顶层会话，各自有 preset、模型、目录和定时提醒，再用自写插件补上注册表、机器人之间的消息总线和中心页。你自写的桥插件和已装的第三方 dsh-taskboard，已经在代码层证明了建会话、选模型、发指令、监听事件、定时复用会话这条路走得通。主要缺口有四个：跨会话消息总线、注册表、防循环和额度控制、中心页面；另外实验接口会随升级变化。

## 逐题回答

**问题 1**

【启用】在桌面版插件页打开「智能体团队」开关就行，它对应组合包 @deepseek-ai/dsh-experimental-agent-team-profile，随安装附带、默认关闭；也可以用 dsh plugin --profile <名> add 加入。它不是单独的 profile，而是叠加在 dsh-base 之后的 patch。base 里已经有它依赖的 session-persistence-jsonl、subagent 服务和 spawn/fork 提供方，桌面 profile 本身就是 dsh-base 加 dsh-web-app。开启后会插入 agent-team、tool-agent-team、ui-agent-team 三行，并关掉 host 级的 subagent 工具；不过桌面 preset 里挂的 subagent 和 workflow 工具仍然在。已打开的会话要刷新页面才会出现 Team 面板。
【Lead 和 teammate】不用「建团队」：每个顶层会话自动就是一个 Team 的 Lead。Lead 用 spawn_teammate（名字、职责、初始任务，fresh 或 fork）创建队友，队友本质上是 Lead 的可继续子代理。只有 Lead 能创建、中断队友和改派任务。
【inbox 消息】任何成员都能用 send_message 给任何成员（包括 lead）发消息。消息前缀是 Team message from <名字>:，作为 user 角色消息追加进收件方的历史：对方正在跑时在最近的步骤边界收到，空闲时会被启动或冷恢复。发送成功只代表进了收件箱，不代表已处理；单条不超过 64KB；不保证顺序、不重试、不去重。
【共享任务板】更新用 CAS（必须带当前 revision），支持依赖 blocked_by、claim/complete/reopen 等 owner 流转（reassign 仅 Lead）、写入范围只给提示不加锁，最多 256 个活动任务。
【冷恢复】名册和任务写在 Lead 会话日志里，写完就落盘；Lead 会话被重新加载时，会核对创建到一半的成员；队友在收到消息时冷恢复。这些都需要持久化会话存储。
【上限】maxMembers 代码默认 16，桌面组合包实际配 8，创建失败的也占名额，名字永久，没有删除和改名；maxTasks 256；maxMessageBytes 65536；wait_agent 只能等 10 秒到 1 小时；同时存活的子代理还受 maxActiveSubagents 默认 8 的限制（和 workflow、普通子代理共用一个池）。
【限制】所有成员共用同一工作区（没有 worktree 和锁）；单进程，不支持跨进程；没有持久化父级邮箱；不会自动释放 owner；没有嵌套 Team；Team 面板只读、不显示消息；实验功能，没有稳定性承诺。

**问题 2**

不能。现成的 Team 不支持给每个队友单独设 persona、preset、模型或工作目录（代码已确认）：spawn_teammate 只有 name、description、prompt、context 四个参数，服务调用 startActivation 时也不传 agentPreset、agentOptions、cwd。所以队友沿用 Lead 当前的 preset（同一套系统提示和工具）、Lead 的模型和 Lead 的 cwd，人设只能写进初始 prompt。名册显示的模型取「队友自己的 options.model，没有就用 Lead 的」；能不能在 UI 里给单个队友单独切模型，没有验证。
schedule 也不能用：任何委派深度大于 0 的子代理调用 schedule_* 都会被拒（A delegated subagent cannot use reminders.），服务端也不允许把提醒绑到子代理会话上，而提醒投递所用的 resolveAgent 对子代理会话一律拒绝。
Lead 不活动时能不能被定时唤醒，要分两种情况。(a) Lead 还在内存里、只是空闲：队友之间互发消息、队友给 Lead 发消息都照常（只需要 Lead 的实例在线）；队友一轮结束后，结算通知还会把空闲的 Lead 唤醒。(b) Lead 已经卸载（比如 App 重启后）：队友没有任何直接唤醒路径，人在 UI 里也只能看到只读输入框。唯一的间接办法是给 Lead 建一个定时提醒：到点后 Lead 被冷恢复，它的模型按提醒内容 send_message，队友随之被冷恢复。这条路依赖 Lead 的模型照约定办事，而且每次都要经过 Lead 这一跳。

**问题 3**

【\subagent 和 team 的区别】subagent 是父子树式委派：subagent 或 subagent_fork 立即返回子会话 id，子代理完成后通知父级；本地子代理可以继续对话、可以冷恢复。消息只能在直接的父与子之间收发，兄弟之间、隔代之间都不行。每个子代理可以单独选 cwd，可以选模型（要开 modelSelectionSettings，桌面 standard preset 已开，但还需要在宿主的子智能体设置里打开模型选择）；可以选 preset（要配 allowedAgentPresets，桌面没配）。maxDepth 默认 1，并行默认 8；没有具名名册，也没有共享看板。Team 是在 subagent 之上加了几样东西：具名的扁平名册、任意成员之间互发消息（由 Lead 授权转投）、共享 CAS 任务板和 wait_agent。代价是每个队友都只能复用 Lead 的 preset、模型和目录。
【workflow 和 ptc 是什么】workflow 是多 agent 编排脚本：模型写一段纯 JS，用 agent()、parallel()、pipeline()、phase()、log() 扇出很多 fresh 子代理，最后返回一个 JSON。它由 workflow-ptc 引擎在沙箱化的 Node 进程里执行。agent() 只能指定 label、phase、schema、provider、model；子代理的结果只回给脚本，子代理之间不能通信。默认前台运行、阻塞父级这一轮，可以开 run_in_background 变成后台 job。没有存档、重启后无法续跑，没有可保存的命名工作流，也没有 token 预算。PTC 是「执行模型写的程序、程序里可以调用宿主函数」的通用执行底座（ctx.ptcRuntime，README 里没写缩写全称，从用法看是程序化调用工具的意思）。run_code 模式和 workflow 都建在它上面，它本身不编排 agent。
【能否做机器人的固定流水线】可以，但只适合当机器人内部的一次性流水线，比如每天定时：3 个并行调研 agent，再接 1 个汇总 agent。脚本要存在文件里，由定时提醒触发机器人重新提交，或者由插件直接调 ctx.workflowEngine.start。workflow 不能当机器人本身，因为它不持久、不能续跑、没有身份。还有一个坑（根据代码推断）：workflow 子代理和队友、普通子代理共用 8 个名额，而这台 18 核 Mac 上 workflow 默认并发是 16，大扇出时启动失败会被当成致命错误 AGENT_START，整个 workflow 失败。要先在「插件 → 子智能体」里调高并行上限。

**问题 4**

【A：一个总管 Lead + N 个 teammate】
上限：名册 8 个（改配置可以调高，但只增不减）；同时存活的不超过 8 个（和 workflow、子代理共用）；一个 Team 就等于一个 Lead 会话；单进程。
优点：现成可用，打开开关就有名册、互发消息、共享看板和桌面面板；适合「一个大任务临时拉一个项目组」。
风险：(1) 所有机器人共用 Lead 的 preset、模型、目录和权限，委派出去的队友审批一律自动拒绝，做不到 R1；(2) 队友不能自己定时，R2 只能靠 Lead 中转；(3) Lead 是单点：它没加载时全队沉睡，结算通知可能丢，也没有持久邮箱；(4) Lead 的上下文会被所有消息和通知堆满；(5) 团队策略是按「有限任务、Lead 最后汇总」写的；(6) 开启后所有顶层会话都要多付 Team 策略加 9 个工具的 token 开销；(7) 实验功能，接口会变。
难度：只是启用的话是 S；要满足每个机器人独立人设、模型、目录和定时，得 fork 实验包再加上 Lead 扇出调度，是 M 到 L，而且仍然受 8 个名额和 Lead 必须在线的限制，升级后容易返工。
【B：每个机器人是独立会话 + 自建插件做总线和注册表】
上限：DSH 核心里没找到顶层会话数量的上限（api-session-controller 的配置只有两项，这是反向查找的结论，需要实测）。实际瓶颈是每 5 小时的用量额度、内存和 CPU，以及你自己设的并发阈值（桥插件默认 2、最多可调到 4；看板默认 3、可调 1 到 100）。
优点：每个机器人都是普通顶层会话，天然有自己的 preset、模型、cwd、权限、/goal 目标和定时提醒（提醒由宿主持久保存、重启后还在、到期冷恢复会话）。机器人内部还能再用 subagent、workflow，甚至 Team。你的桥插件和已装的 dsh-taskboard 已经在代码层跑通了「插件建会话、选模型、发指令、监听事件、cron 定时复用会话」这一整套。
要自写的部分：注册表；robot_send、robot_list 工具和投递逻辑（resolveAgent 加 followup）；防循环和额度护栏；中心页。
风险：插件接口在 rc 版本之间会变（桥插件在 rc.2 就返工过）；用自定义 source 发消息时界面怎么显示还没验证；机器人互相唤醒容易形成循环、烧光额度；只在宿主进程活着时运行；和 CLI 等其他进程抢同一个会话会报 writer-held。
难度：消息总线、注册表和工具这部分约为 M（可以参照桥插件，几百行规模）；加上中心页是 M 到 L。
【推荐】用 B 做骨架，每个机器人一个顶层会话；Team、subagent、workflow 只在单个机器人内部、需要临时拉人并行时使用。

**问题 5**

现成能力的边界分四种情况。
(1) 同一个 Team 内：任意成员（包括 Lead）之间都能互发消息，消息会唤醒或冷恢复收件方，但要求 Lead 在线。委派方面，只有 Lead 能创建、中断队友和改派任务；队友只能发消息，以及在看板上建任务、认领、完成、重开。看板是同一个 Lead 内共享的 CAS 看板（依赖、owner、写入范围提示），不跨 Team；没有消息时间线界面。
(2) 普通 subagent：只能在直接的父与子之间收发消息。子给父发要求父在线、子仍驻留；兄弟之间、孙辈都不能作为收件方；父级可以中断后代、列出子代理；没有看板。
(3) workflow：子代理之间完全不能通信，只能通过脚本变量传递结果。
(4) 独立的顶层会话之间（架构 B）：官方没有消息和委派通道。只有实验性、只读的 session-query，而且只能读工作目录完全相同的会话。可直接利用的是已装的第三方 dsh-taskboard：任何会话都能用 taskboard_* 工具建卡、评论、认领、改状态（agent 永远移不到 done），卡片可以按 cron 定时，并单独指定 preset、模型和权限，评论可以当作异步留言。直接互发消息、按名字派活、机器人名册，都要自写插件，用 sessionController 或 resolveAgent 来实现。

## 能力清单（* 为承重结论）

- **C1***（依据：both；对应 R6, R10）桌面版可以用 Agent Teams：插件页的可选组合包「智能体团队」（@deepseek-ai/dsh-experimental-agent-team-profile），随安装附带、默认关闭。它不是独立 profile，而是叠加在 dsh-base 之后的 patch：插入 agent-team（maxMembers 配成 8）、tool-agent-team、ui-agent-team 三行，并禁用 host 级的 tool-subagent、tool-subagent-fork、tool-subagent-control、list-agents 四行。桌面 profile 由 dsh-base 加 dsh-web-app 组成，而 web-app 本来就把委派工具（subagent、subagent_fork、send_message、list_agents、workflow）挂在 preset 内部，所以开启后 preset 里的这些工具仍然在（profile README 把这一点列为已知限制）。已打开的会话要刷新页面才会出现 Team 面板。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/README.zh.md（「在 Web 或 Desktop 的插件页开启「智能体团队」」「仅显式启用」「预设内的子代理控件」「需要 base profile」）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml（disabled 四行 + insert agent-team maxMembers: 8）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/locale/zh.json（title: 智能体团队）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js（OPTIONAL_BUNDLES 含 agent-team-profile）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js（EXTENSION_BUNDLES 第一项）
  - 证据：dsh-src/_app/main.js（project-manager 段：WEB_PROFILE = PROFILE_TEMPLATES.web，即 dsh-base + dsh-web-app）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:553-575（host 级 subagent/workflow 行已 disabled）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:83-109（delegation 组挂在 preset 内）
  - 证据：dsh-src/_app/package.json:126-145（4 个 agent-team 包均已打包）
- **C2**（依据：both；对应 R6）Team 的运作方式：每个普通顶层会话自动是一个隐式 Team 的 Lead（TeamId 等于 SessionId），不需要「建团队」。成员共用 9 个工具：spawn_teammate、send_message、list_agents、wait_agent、interrupt_agent、team_task_create、team_task_list、team_task_get、team_task_update。只有 Lead 能创建、中断队友和改派任务（TEAM_LEAD_REQUIRED）。队友本质上是 Lead 的可继续子代理（delivery: parent），fresh 方式不带 Lead 的历史，fork 方式继承 Lead 已完成的轮次。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:870-903（tryMembership：没有 subagent 描述符的根会话 → role lead）
  - 证据：同文件 :1004-1043（spawnAdmitted：非 Lead 抛 TEAM_LEAD_REQUIRED；调用 ctx.subagents.startActivation，delivery: parent）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:250-512（9 个工具注册）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/README.zh.md（Team 身份与 roster）
- **C3***（依据：both；对应 R1, R6）Team 的上限都已在代码里确认。maxMembers 代码默认 16，但桌面组合包实际配的是 8；判断条件是 state.members.length >= maxMembers，创建失败的成员也算一个名额。名字永久占用、不能复用，服务里也没有删除或改名成员的接口。maxTasks 256（只算未删除的任务）；单条消息 maxMessageBytes 65536（含发送者前缀）；wait_agent 只能等 10 秒到 1 小时。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1420-1423（DEFAULT_MAX_MEMBERS = 16、DEFAULT_MAX_TASKS = 256、DEFAULT_MAX_MESSAGE_BYTES = 65536）
  - 证据：同文件 :1024（TEAM_MEMBER_LIMIT）、:1221（TEAM_TASK_LIMIT）、:1597（TEAM_MESSAGE_TOO_LARGE）、:48（timeoutMs 1e4..36e5）
  - 证据：同文件 :1488-1586（公开方法只有 membership/listMembers/spawnTeammate/sendMessage/createTask/getTask/listTasks/updateTask/waitForChange/interrupt，没有删除成员）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml（maxMembers: 8）
  - 证据：agent-team README 已知限制「扁平且不可变的 roster」
- **C4***（依据：both；对应 R1, R6）队友不能各自有 preset、人设、模型或工作目录。spawn_teammate 只有 name、description、prompt、context（fresh/fork）四个参数；服务调用 startActivation 时，request 里只有 prompt 和 parent，不传 agentPreset、agentOptions、cwd。所以子会话元数据默认取 Lead 的 cwd 和 Lead 当前 preset 代际，模型沿用 Lead 的路由。人设只能写进初始 prompt；名字身份由 runtime context 注入（You are teammate 「name」）。底层 subagent 服务本身支持每个子代理单独设置 agentPreset（仅 spawn）、agentOptions、cwd，只是 Team 没有透传。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:250-291（spawn_teammate 参数）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1032-1043（startActivation 只传 prompt/parent）
  - 证据：同文件 :917-919（roster 的 model = live?.options.model ?? root.options.model）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:346-357（childSessionMeta：cwd 和 agentPreset 默认取父级，origin: subagent）、:1400-1450（startLocal 从 request 读 agentPreset/agentOptions/cwd）
  - 证据：agent-team README「不支持独立工作目录」
- **C5***（依据：code；对应 R2, R6）队友（以及任何委派深度大于 0 的子代理）不能拥有定时提醒，也不能被宿主按会话 id 直接唤醒。schedule_* 四个工具遇到子代理调用者直接返回 subagent_session（A delegated subagent cannot use reminders.）；schedule 服务也拒绝把提醒绑到子代理会话上。提醒投递走 sessionController.resolveAgent，而它对 header.origin 为 subagent 的会话一律返回 session/agent-busy，不论这个会话当前在不在内存里。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:293-305（subagentCallerRefusal）、:534
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2073-2098（reminderTargetRefusal → subagent_session）、:1576-1596（投递 = resolveAgent + followup）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:128-142（hasApiSessionSubagentOwner：origin === subagent 返回 true）、:365-369（liveAgent 也拒绝）、:393-398（resumeObserved 拒绝）
- **C6***（依据：both；对应 R2, R6, R9）Team 的消息和唤醒全部经过一个在线的 Lead 实例。成员身份解析要求 Lead 存在于 ctx.agents；发给 Lead 用 root.steer()，发给队友用 steerHostSubagentPrompt(subagents, root, …)，以 Lead 的权限转投，目标空闲时启动一轮，目标未加载时冷恢复。队友一轮结束后，结算通知会以排队方式唤醒空闲的 Lead；但如果 Lead 实例已被替换，这条通知会被直接丢弃。Lead 只要加载在内存里（哪怕空闲），成员之间就能互相唤醒；Lead 一旦卸载（例如重启后），队友就没有任何直接唤醒路径。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:870-903（root = ctx.agents.get(parentId)，不存在就不算成员）、:1587-1613（sendAdmitted）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/types/internal.js:41-57（steerHostSubagentPrompt：exact live direct parent authorizing delivery）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:2079-2095、2141（父级发起投递，没有驻留实例时 coldResume）、:2048-2058（notifySettlement：parent !== activation.parent 时 return；空闲用 queue 唤醒）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-subagent/README.zh.md（父级不可用时，子会话输入框只读）
- **C7**（依据：both；对应 R6）Team 共享任务板：任何成员都能建任务（标题、详情、blocked_by 依赖、write_scopes 写入范围）。更新用 compare-and-set（必须带当前 revision，过期的会报 TEAM_TASK_STALE_REVISION）。动作包括 claim、release、edit、set_dependencies、complete、reopen、reassign（仅 Lead）、delete（保留墓碑记录）。依赖未完成的任务不能认领；写入范围重叠只给警告，不加锁。看板数据存在 Lead 会话日志里，只在本 Team 内共享。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:365-398（team_task_create）、:470-483（action 枚举）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1278（TEAM_TASK_STALE_REVISION）
  - 证据：agent-team README「共享任务板」「write scope 仅作提示」「不会自动释放 owner」
- **C8***（依据：both；对应 R6, R7）subagent 是父子树式委派。subagent 和 subagent_fork 工具立即返回子会话 id，子代理完成后通知父级；本地子代理可以继续发消息，也能冷恢复。消息只能在直接的父与子之间收发：兄弟之间、隔代之间都不行；子发给父时，要求父在线且子仍驻留。每个子代理可以单独选 cwd，开启 modelSelectionSettings 后可选模型，配置 allowedAgentPresets 后可选 preset（桌面 preset 没配这一项）。maxDepth 默认 1。maxActiveSubagents 默认 8，是进程内的名额池，同一主 Agent 下所有层级的存活子代理共用（Team 队友、workflow 子代理都算在内）；名额满了直接报 ACTIVATION_LIMIT_REACHED，不排队。所有委派子代理的审批策略都被固定为 never，需要审批的操作会被自动拒绝。
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:2979-2980（maxDepth default 1，maxActiveSubagents default 8）、:1038-1053（ActivationPool 进程内名额，ACTIVATION_LIMIT_REACHED）、:1677（materialize 预留名额）、:408-414（approvalPolicy 固定为 never）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent-control/README.zh.md（只有相邻的 Agent 可以通信）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent/README.zh.md（cwd、agentPreset/allowedAgentPresets、modelSelectionSettings）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-settings-subagent/README.zh.md（插件 → 子智能体页可调深度和并行上限）
- **C9***（依据：both；对应 R3, R6）workflow 是模型写的一段纯 JS 编排脚本，可用 agent()、parallel()、pipeline()、phase()、log() 这几个钩子，由 PTC 引擎在沙箱化的 Node 进程里跑，最后返回一个 JSON。每次 agent() 调用都会起一个 fresh 子代理（spawn 提供方，delivery: caller，结果只回给脚本，不通知父级），选项只支持 label、phase、schema、provider、model，不支持 preset、cwd、effort。默认在前台跑，会阻塞父级这一轮；加 run_in_background 后变成后台 job，结束时整体送达结果。运行过程不存档：重启后无法续跑，没有可保存的命名工作流，没有 token 预算，子代理之间也不能通信。并发默认 min(16, CPU 数 − 2)，单次最多 1000 个 agent；插件可以直接调 ctx.workflowEngine.start()。PTC（ctx.ptcRuntime）是「运行模型写的程序、让程序调用宿主函数」的执行底座，默认每次新开一个 Node 进程、超时 120 秒；它本身不负责多 agent 编排。
  - 证据：dsh-src/@deepseek-ai/dsh-workflow/README.zh.md（「仅支持前台收集」「没有日志化或恢复」「没有已保存或嵌套工作流」「没有 token 预算词汇」）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-workflow/README.zh.md（后台运行、maxResultChars 50000）
  - 证据：dsh-src/@deepseek-ai/dsh-workflow-ptc/lib/index.js:599-602（引擎配置默认值）、:631（maxConcurrentAgents 计算）、:327-349（startChild：delivery caller，cwd 取捕获值，agentOptions 只有 provider/model）、第 12 行 guest 源码（SUPPORTED_AGENT_OPTIONS、DEFERRED_AGENT_OPTIONS）
  - 证据：dsh-src/@deepseek-ai/dsh-ptc-runtime/README.zh.md、dsh-src/@deepseek-ai/dsh-ptc-runtime-node/README.zh.md（per-call，timeoutMs 120000）
- **C10***（依据：code；对应 R1, R2, R5, R6, R10）架构 B 需要的积木已经在代码层可用。插件可以直接调宿主的 sessionController：create（可带 workspaceId、agentPreset）、selectModel、prompt（mode 选 queue 或 steer）、cancel、rename、projections、resolveAgent（冷恢复一个普通顶层会话，并按它记录的 preset 组合）；也可以用 ctx.agents.create 建会话并指定 cwd、agentPreset、模型，再订阅 session/event 事件。schedule 把提醒绑到顶层会话上，由宿主持久保存，重启后还在，到期时冷恢复会话并投递。你的桥插件（dsh-claude-bridge）和已装的第三方 dsh-taskboard 都已实际用过这些接口；taskboard 还做了跨会话看板、host 侧 cron、每张卡单独的 preset/模型/权限，以及定时复用会话。api-session-controller 的配置里没有看到顶层会话的并发上限（这是反向查找的结论，未实测）。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-claude-bridge/lib/index.js（inject: sessionController/workspaceRegistry/commands/agents；ctx.on('session/event')；注释说明 0.2.1-rc.2 起改为直连 sessionController）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-claude-bridge/lib/bridge.js:305-380（create 带 agentPreset、selectModel、/permission、prompt mode queue、/goal）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts:603-650（ctx.agents.create 传 meta.cwd/agentPreset 和 agentOptions，以及 resumeScheduled）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/README.md（taskboard_* 共 10 个工具、host 侧 cron、DSH_TASKBOARD_MAX_CONCURRENT 默认 3）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:205-240（resolveAgent）、:3090-3256（create/selectModel/prompt/cancel）、:2931-2934（Config 只有 nativeOpen、listWorkSliceMs 两项）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md（宿主重启后任务仍可用；到期时恢复冷会话）
- **C11**（依据：both；对应 R6, R8）Team 的网页面板是只读投影：显示成员列表（状态、模型）和共享任务看板，可以跳到某个成员的会话。它不能创建、中断或删除队友，不能改任务，也不显示成员之间的消息时间线。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js（grep spawnTeammate/createTask/updateTask/interrupt 结果为 0；读取 projectionsBySession[lead].values.agentTeam）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-client-ui-agent-team/README.zh.md（已知限制：没有 mailbox timeline、没有 lifecycle control）
- **C12**（依据：both；对应 R6, R7）开启 Teams 之后，每一个顶层会话都会被装上 team:policy 系统提示段和 9 个 Team 工具，因为每个根会话都是隐式 Lead。这样每个机器人的每次请求都要多付一笔固定的 token 开销；每条 peer 消息也会追加进收件方的历史。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:227-245（install 注册 policy 和 identity）、:529-545（maybeInstall 对每个有 membership 的 agent 执行）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/README.zh.md（Token 影响）

## 限制清单（* 为承重结论）

- **L1*** Team 名册扁平且不可变：桌面版上限 8 个（代码默认 16），创建失败的也占名额；名字永久、不能删除或改名；没有嵌套 Team；只有 Lead 能创建和中断队友。
  - 影响：做「一个总管 + N 个机器人」时，最多只能长期养 8 个（改配置能调高，但退役的机器人永远占位，名册只增不减）。不能当成可以随时增删机器人的注册表用。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1024、1420
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml
  - 证据：agent-team README「扁平且不可变的 roster」
- **L2*** 所有队友共用 Lead 的工作目录和文件系统，没有 worktree 隔离和文件锁，write scope 只是提示；同时也共用 Lead 的 preset（系统提示和工具）、模型和权限。
  - 影响：R1 要求的「每个机器人各自有人设、指令、模型、工具、目录」，用 Team 现成能力做不到。多个机器人同时写文件会互相覆盖，只能靠提示词协调。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:22-30（策略原文：The Team Lead and all teammates share the same working directory）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1032-1043
  - 证据：agent-team README「单进程、共享 checkout」
- **L3*** 只支持单进程：没有持久化的父级邮箱，没有跨进程协调，发送不重试、不去重；「发送成功」只代表进了收件箱，不代表已被处理；同一收件方的消息不保证顺序；Lead 必须在线；被中断或退出时不会自动释放任务 owner；崩溃可能丢掉已接收但还没写进日志的消息。
  - 影响：整个协作依赖 Lead 一个进程内实例，Lead 就是单点故障。App 退出或重启后，在 Lead 被重新打开之前，全队都在沉睡；队友的结算通知可能丢失；不能和 CLI 等其他进程共同操作同一个 Team。
  - 证据：agent-team README 已知限制「无发送重试保证」「不会自动释放 owner」
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/README.zh.md（没有持久化 parent mailbox、驻留仅限进程内、不回放已接受但未记录的消息）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:2048-2058
- **L4*** 队友和子代理不能自己定时（工具和服务两层都拒绝），会话控制器也拒绝直接解析或恢复子代理会话。
  - 影响：Team 里的机器人不能「自己醒来」。只能靠这几条路：给 Lead 建定时提醒，Lead 醒来后再用 send_message 叫醒队友；或者由其他成员发消息；或者人在 UI 里发消息（同样要求 Lead 在线）。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:293-305
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:128-142、365-369
- **L5** 并发名额 maxActiveSubagents 默认 8，同一主 Agent 下的队友、普通子代理、workflow 子代理共用这一个池，满了直接拒绝、不排队。workflow 在 agent() 启动失败时抛的是致命错误 AGENT_START；而这台 Mac 有 18 核，workflow 默认并发是 min(16, 18−2) = 16，大于 8。
  - 影响：队友占满名额后，Lead 再起 workflow 或子代理会失败；大扇出的 workflow 可能整次失败。这条是根据代码推断的，未实测。可以在「插件 → 子智能体」里调高并行上限。
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:1038-1053、1677、2980
  - 证据：dsh-src/@deepseek-ai/dsh-workflow-ptc/lib/index.js:631；第 12 行 guest 源码 AGENT_START；该包中 grep ACTIVATION_LIMIT 结果为 0
  - 证据：本机 sysctl hw.ncpu = 18
- **L6** 所有委派出去的子代理（含队友），审批策略都被固定为 never：权限范围在启动时就定死，需要审批的操作一律自动拒绝。
  - 影响：无人值守的队友没法临时申请更高权限，只能事先给 Lead 足够的权限档位（它会被继承），或者把这类动作交回给 Lead 或人来做。
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:363、408-414
- **L7** Agent Teams 是实验原型，没有稳定性承诺；插件接口在 rc 版本之间也变过：你的桥插件在 0.2.1-rc.2 被迫从 typertGateway.invoke 改为直连 sessionController。
  - 影响：如果基于 Team 内部 API（或 fork 它）搭建 Agent 中心，升级后很可能要返工。最好只依赖少数几个公开服务，并为它们写兼容层。
  - 证据：agent-team README 已知限制「实验原型，无稳定性承诺」
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-claude-bridge/lib/index.js（文件头注释说明 rc.2 起 peer 改为必填）
- **L8** workflow 不存档、不可恢复，没有保存的命名工作流；子代理之间不能通信；agent() 不能指定 preset 或 cwd；前台运行会阻塞父级这一轮，后台运行要等结束才整体出结果；没有 token 预算。
  - 影响：workflow 只能当机器人内部的一次性流水线，不能当机器人本身的运行载体。固定流水线的脚本要自己存起来，每次重新提交。
  - 证据：dsh-src/@deepseek-ai/dsh-workflow/README.zh.md（已知限制）
  - 证据：dsh-src/@deepseek-ai/dsh-workflow-ptc/lib/index.js:327-349
- **L9*** 官方没有跨独立会话（非父子、非同一 Team）的消息、委派和注册表。session-query 是实验功能、只读，而且只能看工作目录完全相同的会话；sessionController.prompt 发出的消息来源固定标记为 user。
  - 影响：架构 B 里机器人之间的「发消息、派活、名册」都要自写插件。想让消息显示为「某机器人发来」，需要用 resolveAgent 加 agent.followup，并自己带上 source 字段。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3218-3231（source kind: user）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-session-query/README.zh.md（只有 cwd 完全匹配才允许跨会话访问）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent-control/README.zh.md
- **L10** Team 的系统策略是为「有限任务」设计的，原文要求 Lead 在给出最终答复前等待必要的队友。当没有其他成员在跑时，wait_agent 会立即返回 noProgress，而且它从不唤醒成员，所以不能拿来当计时器。
  - 影响：它的心智模型是「一次任务拉一个项目组，做完收尾」，和「一群长期在线、各有目标的机器人」并不匹配。硬套的话，Lead 的上下文会被所有消息和通知堆满。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:30-32（The Lead must wait for required teammates…；NO_ACTIVE_PEER_MESSAGE）
- **L11** 每次名册或任务变化，都会把完整的名册和看板广播给所有已连接的浏览器；Team 面板只读，不显示消息；已打开的会话要刷新页面才能看到 Team。
  - 影响：这个面板不能直接充当 Agent 中心页：看不到机器人之间的对话、下次唤醒时间和消耗，需要自建页面。
  - 证据：agent-team README「完整视图广播」
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-client-ui-agent-team/README.zh.md（已知限制）
- **L12** 桌面版开启 Teams 后，preset 作用域里仍然挂着 subagent 版的 send_message、list_agents、interrupt_agent、subagent 和 subagent_fork，和 Team 工具同名或功能重叠；README 只承认这是已知限制，没说清最终哪套生效。
  - 影响：模型可能看到两套相近的工具，委派行为不好预测，需要实测。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/README.zh.md（预设内的子代理控件）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:83-109

## 核查结果

- **C1：部分成立**。原结论：桌面版可以用 Agent Teams：插件页的可选组合包「智能体团队」（@deepseek-ai/dsh-experimental-agent-team-profile），随安装附带、默认关闭。它不是独立 profile，而是叠加在 dsh-base 之后的 patch：插入 agent-team（maxMembers 配成 8）、tool-agent-team、ui-agent-team 三行，并禁用 host 级的 tool-subagent、tool-subagent-fork、tool-subagent-control、list-agents 四行。桌面 profile 由 dsh-base 加 dsh-web-app 组成，而 web-app 本来就把委派工具（subagent、subagent_fork、send_message、list_agents、workflow）挂在 preset 内部，所以开启后 preset 里的这些工具仍然在（profile README 把这一点列为已知限制）。已打开的会话要刷新页面才会出现 Team 面板。
  - 核查说明：多数事实成立，已在代码里确认：(1) 组合包随安装附带、默认关闭（OPTIONAL_BUNDLES 第 585 行；插件页 EXTENSION_BUNDLES 第一项；桌面模板 PROFILE_TEMPLATES.web 只含 dsh-base 和 dsh-web-app）。(2) patch 禁用 4 行，id 依次是 tool-subagent-control、tool-subagent-list-agents（不是 list-agents）、tool-subagent、tool-subagent-fork。(3) patch 插入 agent-team（maxMembers 8、maxTasks 256、maxMessageBytes 65536、disposalTimeoutMs 5000）、tool-agent-team（freshProvider spawn、forkProvider fork）和 ui-agent-team。「刷新页面才出现 Team 面板」只在 client-ui-agent-team README 的「晚启用插件」里写了，属于前端行为。
有两处偏差：
① 桌面版上，这 4 个 host 行早已被 dsh-web-app 禁用（cordis.patch.yml:560-576），所以组合包的禁用不起作用。
② 「preset 里这些工具仍然在」只对 subagent、subagent_fork、workflow 成立。理由：Team 的 9 个工具注册在每个成员 Agent 自己的 scope（install 用的是 agent.ctx）；dsh-tools 的 view() 规定，本 scope 的注册会覆盖从祖先 scope 继承来的同名工具，而 preset 代际正是通过 bindScopeParent 绑成祖先的；另外，每个顶层会话都会被 tryMembership 判定为 Lead。所以开启后，Lead 和队友看到的 send_message、list_agents、interrupt_agent 都是 Team 版，preset 里的同名相邻控件被遮蔽了。Team 版 send_message 只认 'lead' 和名册里 active 的名字（resolveActiveMember）。结果是：Lead 仍能用 subagent 起普通子代理，但不能再用 send_message 给它追加消息。这一点是读代码推断的，没有实测。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml:1-32
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/README.zh.md（「仅显式启用」「预设内的子代理控件」「需要 base profile」）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:579-591（OPTIONAL_BUNDLES）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:2179-2184（EXTENSION_BUNDLES）
  - 证据：dsh-src/_app/main.js:3385-3391、3552、3636-3637（PROFILE_TEMPLATES.web = dsh-base + dsh-web-app，createPluginProfile 用它）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:553-576（host 级 4 行 + workflow-ptc/tool-workflow 已 disabled）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:83-109（delegation 组含 send_message/list_agents/interrupt_agent/subagent/subagent_fork/workflow）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:227-235（scoped = agent.ctx）、531-552（agent/created 时对每个成员安装）
  - 证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2757、3055-3074（own layer 覆盖继承层）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:495-505、655-680（preset 代际是独立 scope，bindScopeParent 绑成 Agent 的父 scope）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:870-903（顶层会话→lead）、824-831（resolveActiveMember 只认 lead/active 名册）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-client-ui-agent-team/README.zh.md（「晚启用插件」需要刷新页面）
- **C3：成立**。原结论：Team 的上限都已在代码里确认。maxMembers 代码默认 16，但桌面组合包实际配的是 8；判断条件是 state.members.length >= maxMembers，创建失败的成员也算一个名额。名字永久占用、不能复用，服务里也没有删除或改名成员的接口。maxTasks 256（只算未删除的任务）；单条消息 maxMessageBytes 65536（含发送者前缀）；wait_agent 只能等 10 秒到 1 小时。
  - 核查说明：补充以下细节（均已在代码里确认）：
① maxMessageBytes 量的是 JSON.stringify([前缀块, 正文块]) 的 UTF-8 字节数。JSON 结构和转义也算在内，中文每字占 3 字节，所以实际能写的正文明显少于 64KB。
② maxTasks 计数的条件是 status !== 'deleted'。已完成（completed）的任务同样占名额，要删除（留 tombstone）后才释放。长期运行的团队要定期清理。
③ 名字规则：lower-kebab-case、不超过 64 个字符、不能叫 lead。投影 applyCurrentTeamEvent 不允许 active 成员再发生任何状态变化，failed 成员会永久留在 members 里。
④ wait_agent 默认等 30000ms。
⑤ 上限按 Lead 会话计算（每个顶层会话自成一个 Team）。用户自己的 profile patch 可能改掉 8，但它在禁区里，没有读。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1420-1442（默认值与 Config）、1024（TEAM_MEMBER_LIMIT）、1023（TEAM_MEMBER_NAME_TAKEN）、1221-1223（TEAM_TASK_LIMIT，status !== deleted）、1590-1597（前缀+JSON.stringify 字节检查）、48（timeoutMs 1e4..36e5）、1488-1586（无删除/改名方法）、589-606（成员状态迁移规则）、1163-1166（memberName）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:318-337（wait_agent 默认 3e4）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml:16-23（maxMembers: 8）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/README.zh.md（「扁平且不可变的 roster」、maxMembers 含失败）
- **C4：成立**。原结论：队友不能各自有 preset、人设、模型或工作目录。spawn_teammate 只有 name、description、prompt、context（fresh/fork）四个参数；服务调用 startActivation 时，request 里只有 prompt 和 parent，不传 agentPreset、agentOptions、cwd。所以子会话元数据默认取 Lead 的 cwd 和 Lead 当前 preset 代际，模型沿用 Lead 的路由。人设只能写进初始 prompt；名字身份由 runtime context 注入（You are teammate 「name」）。底层 subagent 服务本身支持每个子代理单独设置 agentPreset（仅 spawn）、agentOptions、cwd，只是 Team 没有透传。
  - 核查说明：补充：
① 模型继承来自 resolveChildAgentOptions：spawn 那一刻复制 Lead 最近一次请求的 provider、model、reasoningEffort 和 maxTokens，写进子代理 descriptor，冷恢复时按它重建。之后 Lead 换模型，已有队友不受影响。
② 人在 UI 里也不能单独给某个队友换模型：sessionController.selectModel 先走 resolveAgent，而 resolveAgent 对 origin=subagent 的会话返回 session/agent-busy。读者原来写的「没有验证」现在可以确定为「不能」。
③ 目录：spawn 时不能指定。但桌面 base 在 host 级挂了内置的 working_directory 工具，队友可以自己 cd。子级的目录单独保存、跨恢复保留，权限根目录仍沿用父级。所以只能靠提示词让队友自己切目录。
④ agentPreset 的能力检查是「提供方声明 agentPreset 能力，且不继承父上下文」，fork 和外部后端都会拒绝。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:250-291（spawn_teammate 四参数）、239-246（team:identity runtime context）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1032-1043（startActivation 只传 prompt/parent）、916-918（roster model 回退 Lead）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:293-330（parentAgentOptionsForDelegation/resolveChildAgentOptions）、346-357（childSessionMeta）、1400-1452（startLocal）、1524（cwd 默认父级当前目录）、3311-3312（agentPreset 能力限制）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:793-794（selectModel→resolveAgent）、128-142（subagent 会话被拒）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:166-170（working-directory 与 tool-working-directory）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/README.zh.md（使用本包首段：子级保留父级权限根目录，目录独立保留）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/README.zh.md（「不支持独立工作目录」）
- **C5：部分成立**。原结论：队友（以及任何委派深度大于 0 的子代理）不能拥有定时提醒，也不能被宿主按会话 id 直接唤醒。schedule_* 四个工具遇到子代理调用者直接返回 subagent_session（A delegated subagent cannot use reminders.）；schedule 服务也拒绝把提醒绑到子代理会话上。提醒投递走 sessionController.resolveAgent，而它对 header.origin 为 subagent 的会话一律返回 session/agent-busy，不论这个会话当前在不在内存里。
  - 核查说明：核心结论成立，代码已确认：
- 工具层：schedule_create、schedule_list、schedule_delete、schedule_update 对 delegationDepth>0 的调用者一律返回 subagent_session，而且工具只能把提醒绑到调用者自己的会话（agent.session.id）。
- 投递：走 resolveAgent + followup。resolveAgent 对 origin=subagent 的会话一律报 session/agent-busy，在线时由 liveAgent 拒绝，冷恢复时由 resumeObserved 拒绝。

需要修正两处：
① 服务层的 reminderTargetRefusal 只在该子代理当前驻留内存时（ctx.agents.get(sessionId) 有值）才拒绝。子代理不在内存时，插件直接调 ctx.schedule.create(子会话id) 会被接受。README 说这项检查「读取自持久化 session header」，但代码并不读 header，两者不一致。这样建出的任务永远投递不了，会一直过期，每次 drive 都重试。
② 「不能被宿主按会话 id 直接唤醒」只对 sessionController 和 schedule 这条路成立。subagent 服务仍然可以凭「精确在线的直接父级」按子会话 id 唤醒子代理（包括冷恢复），入口有：ctx.subagents.sendMessage(lead, childId, …)、queuePrompt/steerPrompt，以及浏览器用的 subagents/prompt 路由（要求父级在线）。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:299-305（subagentCallerRefusal）、508/548/570/604（四个工具名）、531-541（绑定 agent.session.id）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2254-2261（reminderTargetRefusal：agent === void 0 时放行）、2084-2098（create）、1576-1597（drive：resolveAgent + followup）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md（已知限制：subagent_session「读取自持久化 session header」，与代码不符）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:128-142、222-240、365-369、392-398
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:1538-1551（sendMessage）、1561-1582（queuePrompt/steerPrompt）、3187-3196（subagents/prompt 要求父级在线）
- **C6：成立**。原结论：Team 的消息和唤醒全部经过一个在线的 Lead 实例。成员身份解析要求 Lead 存在于 ctx.agents；发给 Lead 用 root.steer()，发给队友用 steerHostSubagentPrompt(subagents, root, …)，以 Lead 的权限转投，目标空闲时启动一轮，目标未加载时冷恢复。队友一轮结束后，结算通知会以排队方式唤醒空闲的 Lead；但如果 Lead 实例已被替换，这条通知会被直接丢弃。Lead 只要加载在内存里（哪怕空闲），成员之间就能互相唤醒；Lead 一旦卸载（例如重启后），队友就没有任何直接唤醒路径。
  - 核查说明：补充以下细节（代码确认）：
① 结算通知的投递方式：Lead 空闲时用 queue（followup，会启动一轮）；Lead 正在跑时用 steer；Lead 所在的树正在拆除时用 inject（不唤醒）。Lead 不在内存或实例已被替换时，通知静默丢弃（parent !== activation.parent 直接 return，不记日志）。
② 通知只发给 announced 的 activation，而队友的每次启动、追加投递和冷恢复都会 announce。所以队友每跑完一轮，都会把空闲的 Lead 叫醒跑一轮模型。
③ 冷恢复队友要从 Lead 这棵树的 maxActiveSubagents 池（默认 8）里预留名额。池满时 send_message 直接报 ACTIVATION_LIMIT_REACHED，不排队。
④ 「Lead 卸载后队友没有直接唤醒路径」成立，但有不依赖 Lead 模型的间接路径：
- 人在 UI 打开冷的 Lead 会话时，history 会对 prepared 来源执行 promote，再调 resolveObservedAgent，把 Lead 加载回内存，不发起模型轮次（代码推断）。
- 插件也可以直接调 sessionController.resolveAgent(leadId)。
- Lead 在线之后，人可以在队友会话里直接输入（subagents/prompt 要求父级在线），插件也可以调 ctx.subagents.sendMessage(lead, teammateId, …)。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:870-903（tryMembership 要求 ctx.agents.get(parentId)）、1587-1613（sendAdmitted：root.steer / steerHostSubagentPrompt）、1032-1043（delivery: parent）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/types/internal.js:55-57
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:2048-2061（notifySettlement）、1509/2109/2206（announce）、2079-2095、2141（coldResume）、1664-1666（assertLiveParent）、1676-1677（预留名额）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:799-814（followup/steer 唤醒，inject 不唤醒）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:1586-1590（history 对 prepared 会话 promote）、3006-3016、3037-3039（resolveAgent 对插件公开）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-subagent/README.zh.md（续接对话：父级不可用且子级未运行时只读编辑器说明恢复路径）
- **C8：成立**。原结论：subagent 是父子树式委派。subagent 和 subagent_fork 工具立即返回子会话 id，子代理完成后通知父级；本地子代理可以继续发消息，也能冷恢复。消息只能在直接的父与子之间收发：兄弟之间、隔代之间都不行；子发给父时，要求父在线且子仍驻留。每个子代理可以单独选 cwd，开启 modelSelectionSettings 后可选模型，配置 allowedAgentPresets 后可选 preset（桌面 preset 没配这一项）。maxDepth 默认 1。maxActiveSubagents 默认 8，是进程内的名额池，同一主 Agent 下所有层级的存活子代理共用（Team 队友、workflow 子代理都算在内）；名额满了直接报 ACTIVATION_LIMIT_REACHED，不排队。所有委派子代理的审批策略都被固定为 never，需要审批的操作会被自动拒绝。
  - 核查说明：补充：
① maxDepth（默认 1）只由 subagent 和 subagent_fork 工具执行：工具把 Host 设置当作 request.maxDepth 传进去，而 resolveChildDepth 只在传了 maxDepth 时才检查。Team 的 spawn_teammate 和 workflow 的 agent() 都不传 maxDepth，所以不受它限制。结果是：默认设置下，队友（深度 1）调用 subagent 会被拒；但从队友里跑 workflow 不检查深度。
② 名额池按根 Agent 实例划分（rootPool），根本身不占名额，名额只在子代理运行、待处理或停放期间占用。架构 B 里每个顶层机器人各自有一个 8 名额的池，核心里没有跨机器人的全局上限。
③ 审批固定为 never 只针对进程内子代理（captureDelegatedPolicyOverrides 在 startLocal 里调用）。父级处于 auto 或 danger-full-access 档位时，子代理会继承该档位，也会继承 sandbox override，所以哪些操作还需要审批取决于父级档位。外部后端（Claude Code、Codex，需按需安装）保留各自的权限系统。
④ modelSelectionSettings 还要求 Host 的 subagent-model-selection 设置已开启并至少选了一条路由，且只对新建的顶层会话生效（这一点只在 README 里写了）。
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:2979-2980（maxDepth 1、maxActiveSubagents 8）、1038-1053（ActivationPool）、1754-1762（rootPool）、279-284（resolveChildDepth 仅在传 maxDepth 时检查）、408-414（approvalPolicy never）、363（自动拒绝说明）、1538-1551（相邻消息）、2120-2135（PARENT_UNAVAILABLE）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent/lib/index.js:461-471、524-528（工具传入 maxDepth）
  - 证据：dsh-src/@deepseek-ai/dsh-workflow-ptc/lib/index.js:327-349（startChild 不传 maxDepth）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/README.zh.md（Activation 容量：每棵树一个池、根不占名额、不排队；外部提供方保留各自权限系统）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent/README.zh.md（cwd、agentPreset/allowedAgentPresets 仅 spawn、modelSelectionSettings）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-settings-subagent/README.zh.md（容量统计同一主 Agent 下所有层级）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent-control/README.zh.md（send_message 只在直接父子之间）
- **C9：部分成立**。原结论：workflow 是模型写的一段纯 JS 编排脚本，可用 agent()、parallel()、pipeline()、phase()、log() 这几个钩子，由 PTC 引擎在沙箱化的 Node 进程里跑，最后返回一个 JSON。每次 agent() 调用都会起一个 fresh 子代理（spawn 提供方，delivery: caller，结果只回给脚本，不通知父级），选项只支持 label、phase、schema、provider、model，不支持 preset、cwd、effort。默认在前台跑，会阻塞父级这一轮；加 run_in_background 后变成后台 job，结束时整体送达结果。运行过程不存档：重启后无法续跑，没有可保存的命名工作流，没有 token 预算，子代理之间也不能通信。并发默认 min(16, CPU 数 − 2)，单次最多 1000 个 agent；插件可以直接调 ctx.workflowEngine.start()。PTC（ctx.ptcRuntime）是「运行模型写的程序、让程序调用宿主函数」的执行底座，默认每次新开一个 Node 进程、超时 120 秒；它本身不负责多 agent 编排。
  - 核查说明：多数成立，README 和代码一致：
- 钩子就是 agent()、parallel()、pipeline()、phase()、log() 这几个。
- agent() 的选项白名单是 label、phase、schema、provider、model。effort、isolation、agentType 会报 deferred，其他键会报 not recognized，都属于致命的 UNSUPPORTED_OPTION。
- startChild 用 delivery 'caller'，cwd 取捕获时的值。
- 并发上限 min(16, CPU−2)，maxTotalAgents 1000，maxItemsPerCall 4096。
- run_in_background 依赖 ctx.jobs。
- 没有 checkpoint、没有可保存的工作流、没有 token 预算。

需要修正或补充：
① 「插件可以直接调 ctx.workflowEngine.start()」在桌面版不成立。web-app 禁用了 host 级的 workflow-ptc 行，引擎只挂在 standard preset 的 delegation 组里，而且声明了 isolate: workflowEngine；preset-registry 还禁止 preset 里的服务泄漏到根 realm。所以 host 插件的 ctx.workflowEngine 拿不到引擎，要用 ctx.agentPresets.serviceFor(agent, 'workflowEngine') 针对具体 Agent 去取。这是读代码推断的，没有实测。
② workflow 适配器调 PTC 时传 timeoutMs: null，workflow 没有 120 秒时限。120 秒是 run_code 的默认值。
③ 「不存档」指没有 checkpoint。工具仍会往会话写 4 种 log-only 的 run/member 生命周期记录，供 transcript 显示；跑完的本地 workflow 子代理也留在父级的 subagent catalog 里，之后还能打开、继续。
④ 默认并发 16（18 核机器）大于根池的 8 个名额。扇出超过 8 个时，第 9 个 startActivation 会报 ACTIVATION_LIMIT_REACHED，guest 把它包成致命的 AGENT_START，整个 workflow 失败。
  - 证据：dsh-src/@deepseek-ai/dsh-workflow-ptc/lib/index.js:597-603（Config 默认值）、631（并发计算）、327-349（startChild）、436（timeoutMs: null）、第 12 行 guest 源码（SUPPORTED/DEFERRED_AGENT_OPTIONS、AGENT_START 致命）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:572-576（host 级 workflow-ptc/tool-workflow disabled）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:83-109（isolate: workflowEngine）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:220-230（Preset services require isolate realms）、720-727（serviceFor）
  - 证据：dsh-src/@deepseek-ai/dsh-workflow/README.zh.md（编程方式运行、已知限制）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-workflow/README.zh.md（后台运行、持久会话记录、maxResultChars 50000）
  - 证据：dsh-src/@deepseek-ai/dsh-ptc-runtime-node/README.zh.md（per-call、timeoutMs 120000、工作流适配器传 timeoutMs: null）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/README.zh.md（Activation 结算：已完成的本地工作流子级仍可发现、打开或继续）
- **C10：成立**。原结论：架构 B 需要的积木已经在代码层可用。插件可以直接调宿主的 sessionController：create（可带 workspaceId、agentPreset）、selectModel、prompt（mode 选 queue 或 steer）、cancel、rename、projections、resolveAgent（冷恢复一个普通顶层会话，并按它记录的 preset 组合）；也可以用 ctx.agents.create 建会话并指定 cwd、agentPreset、模型，再订阅 session/event 事件。schedule 把提醒绑到顶层会话上，由宿主持久保存，重启后还在，到期时冷恢复会话并投递。你的桥插件（dsh-claude-bridge）和已装的第三方 dsh-taskboard 都已实际用过这些接口；taskboard 还做了跨会话看板、host 侧 cron、每张卡单独的 preset/模型/权限，以及定时复用会话。api-session-controller 的配置里没有看到顶层会话的并发上限（这是反向查找的结论，未实测）。
  - 核查说明：补充：
① 用 ctx.agents.create 时，只写 meta.agentPreset 不会自动挂载 preset。taskboard 是先 composeAgent，再在 setup 里调 agentPresets.mount 完成组合的；sessionController.create 内部会自动做这一步。
② sessionController.prompt 记录的 source 固定为 {kind:'user', rpcId}。机器人之间经它转发的消息，对方看到的就是「用户说」。要标明发送者，需要先 resolveAgent，再自己调 agent.followup/steer(createUserMessage({content, source}))；schedule 就是这样做的（source 为 {kind:'schedule'}）。
③ sessionController 的 prompt、selectModel、rename、cancel 都拒绝子代理（队友）会话，所以桥插件这套控制方式驱动不了 Team 成员。
④ schedule 的限制（README 加代码）：宿主必须在运行；重启后每个周期任务只补最近一次错过的时点；不保证恰好投递一次，关闭时可能重复投递；不能暂停；只能投递回原会话；归档时如果带 stopActivity，会直接删除活跃提醒。
⑤ 全仓反查也没有找到别的顶层会话并发上限（agent-loop 里的 concurrency 是工具级调度）。现有的上限只来自桥插件（默认 2，最多 4）和看板（默认 3，最多 100）。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-claude-bridge/lib/index.js:15-46（rc.2 起直连 sessionController；inject 列表）、146（ctx.on('session/event')）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-claude-bridge/lib/bridge.js:300-385（create 带 workspaceId/agentPreset、rename、/permission、selectModel、prompt queue、/goal、cancel）、53-54、161（maxActiveSessions 默认 2、范围 1-4）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts:586-650（composeAgent、agents.create 的 meta.cwd/agentPreset、agentOptions、setup、resumeScheduled）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts:77-78、221-229（并发环境变量；presets.mount 在 setup 里）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/README.md（10 个 taskboard_* 工具、host 侧 cron、DSH_TASKBOARD_MAX_CONCURRENT 默认 3、Git worktree 隔离）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2931-2934（Config 两项）、3085-3100、3196-3260、3281（公开方法）、3037-3039（resolveAgent）、745-786（create：workspaceId 或 cwd + agentPreset）、925-950（prompt：steer/followup，source kind user）、1061-1066（cancel 拒绝子代理）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1576-1597（resolveAgent + followup + flush，source schedule）、2043-2063、2273（归档 session-stop 删除提醒）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md（概述：重启后仍可用、到期恢复冷会话；已知限制）
- **L1：成立**。原结论：Team 名册扁平且不可变：桌面版上限 8 个（代码默认 16），创建失败的也占名额；名字永久、不能删除或改名；没有嵌套 Team；只有 Lead 能创建和中断队友。
  - 核查说明：补充：上限按每个 Lead 会话计算（TeamId 就是 Lead 的 SessionId），不是全局上限。名册只增不减，想「重置」只能换一个新的 Lead 会话。名字必须是小写连字符、不超过 64 个字符、不能叫 lead。改派任务（reassign）也只有 Lead 能做。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1006-1029（spawnAdmitted：TEAM_LEAD_REQUIRED、NAME_TAKEN、MEMBER_LIMIT）、936-944（interrupt 仅 Lead）、589-606、1163-1166
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml:16-23
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/README.zh.md（「扁平且不可变的 roster」；TeamId 等于 SessionId）
- **L2：部分成立**。原结论：所有队友共用 Lead 的工作目录和文件系统，没有 worktree 隔离和文件锁，write scope 只是提示；同时也共用 Lead 的 preset（系统提示和工具）、模型和权限。
  - 核查说明：以下几点成立（策略原文加代码）：共用 cwd 和文件系统；Team 不提供 worktree 和文件锁；write scope 只是提示；队友加入 Lead 当前的 preset 代际，系统提示和工具与 Lead 相同。

需要修正三处：
① 模型不是「共用」。spawn 时复制 Lead 最近一次请求的路由，写进 descriptor 后就固定了，之后 Lead 换模型不影响已有队友。人在 UI 里也改不了（selectModel 拒绝子代理会话）。
② 权限和 Lead 不同。子代理的 approvalPolicy 被固定为 never，凡是需要审批的操作都会被自动拒绝；只继承 Lead 的 auto 或 danger-full-access 档位，以及 sandbox override。Lead 用默认的「按需审批」时，队友比 Lead 更受限，无人值守时一碰到需要审批的操作就会失败。
③ 目录不是完全锁死。spawn 时不能指定目录，但队友可以用内置的 working_directory 工具自己 cd，权限根目录不变；另外还有一个默认关闭的可选包「Git 工作树」（create_worktree）。所以「多个机器人互相覆盖文件」可以靠提示词让各自切到子目录或 worktree 来缓解，只是没有硬隔离。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:22-30（共享工作目录策略原文）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1032-1043
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:293-330（模型在 spawn 时复制）、346-357、363（需审批的操作自动拒绝）、408-414（approvalPolicy never，只继承 auto/danger-full-access 与 sandbox override）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:793-794
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:166-170（working_directory 工具在 host 级挂载）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-worktree/README.zh.md（create_worktree，默认关闭）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:2186-2187（MORE_BUNDLES 含 tool-worktree）
- **L3：成立**。原结论：只支持单进程：没有持久化的父级邮箱，没有跨进程协调，发送不重试、不去重；「发送成功」只代表进了收件箱，不代表已被处理；同一收件方的消息不保证顺序；Lead 必须在线；被中断或退出时不会自动释放任务 owner；崩溃可能丢掉已接收但还没写进日志的消息。
  - 核查说明：补充出处：
- 「同一收件方不保证顺序」只是 agent-team README 的免责声明，进程内 inbox 实际是按 FIFO 追加的。
- 「没有持久 parent mailbox」「驻留仅限进程内」「不回放已接受但未落日志的消息」写在 dsh-subagent README。
- 「Lead 必须在线」「interrupt 不动任务」在代码里确认了。

另外，roster 和任务的写入会先 flush 再返回成功，这部分是持久的；不可靠的只是消息投递这一段。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/README.zh.md（teammate 之间的消息；已知限制：单进程、不会自动释放 owner、无发送重试保证）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/README.zh.md（已知限制：没有持久化 parent mailbox、驻留仅限进程内、不回放已接受但未记录的消息）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:2048-2061
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:927-947（interrupt 不触碰任务）、1020-1029（appendAndFlush 后才继续）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:799-814
- **L4：部分成立**。原结论：队友和子代理不能自己定时（工具和服务两层都拒绝），会话控制器也拒绝直接解析或恢复子代理会话。（影响：Team 里的机器人不能「自己醒来」。只能靠这几条路：给 Lead 建定时提醒，Lead 醒来后再用 send_message 叫醒队友；或者由其他成员发消息；或者人在 UI 里发消息（同样要求 Lead 在线）。）
  - 核查说明：工具层拒绝成立。会话控制器拒绝解析和恢复子代理会话也成立，在线和冷恢复两种情况都拒绝。

需要修正：
① 服务层只在子代理驻留内存时拒绝。冷的子会话会被接受，但永远投递失败（见 C5）。
② 「只能靠这几条路」漏了一条不依赖 Lead 模型的路：插件调 sessionController.resolveAgent(leadId)，或者人在 UI 打开 Lead 会话触发 promote，都能把 Lead 加载回内存而不发起模型轮次；然后用 ctx.subagents.sendMessage(lead, teammateId, …) 或 queuePrompt 直接冷恢复并唤醒队友，人也可以直接在队友会话里输入。代价是队友这一轮结束后，结算通知仍会把 Lead 唤醒跑一轮。

所以「机器人自己醒」可以交给一个中心插件代为调度，不必让 Lead 的模型中转。但仍受三条约束：Lead 必须在线、Lead 这棵树只有 8 个名额、队友每跑一轮都会唤醒 Lead。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:299-305
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2254-2261
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:128-142、365-369、392-398、3037-3039、1586-1590
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:1538-1551、1561-1567、3187-3196、2048-2061

## 核查员补充（读者漏掉的点）

- 开启「智能体团队」后，每个顶层会话都会自动成为 Lead，Team 的 9 个工具注册在每个成员 Agent 自己的 scope 里，会遮蔽 preset 里同名的 send_message、list_agents、interrupt_agent。普通 subagent 和 subagent_fork 起的子代理从此不能被 Lead 用 send_message 追加消息，因为 Team 版只认名册里的名字。这会影响「机器人内部临时用 subagent」的做法，而且所有会话每次请求都多出 Team 策略和工具 schema 的 token。这一点是读代码推断的，没有实测。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:227-235、531-552
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:870-903、824-831
  - 证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3055-3074
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:655-680
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/README.zh.md（同名 scoped 注册只为团队成员覆盖全局控件）
- 成本倍增和互相唤醒的循环风险。队友每跑完一轮（包括被其他队友消息叫醒的那一轮），结算通知都会把空闲的 Lead 叫醒跑一轮模型；Team 策略还要求 Lead 等齐需要的队友后才给最终答复。在每 5 小时有用量上限的订阅下，N 个队友就意味着大约翻倍的模型轮次，Lead 和队友之间也容易互相唤醒、停不下来。
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:2048-2061、1509、2109、2206
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1032-1043（delivery: parent）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:22-30（The Lead must wait for required teammates）
- 读者回答 2 说「Lead 卸载后唯一的间接办法是给 Lead 建提醒，依赖 Lead 的模型照约定办事」，说得太窄。插件可以先调 sessionController.resolveAgent(leadId)，只把 Lead 加载回内存、不跑模型；人在 UI 打开冷的顶层会话时，history 也会把它 promote 成在线 Agent。之后插件调 ctx.subagents.sendMessage(lead, childId, …) 或 queuePrompt，就能直接冷恢复并唤醒指定队友，不需要 Lead 的模型参与。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3037-3039、1586-1590、3006-3016
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:1538-1551、1561-1567、2079-2095、3187-3196
- maxDepth（默认 1）只约束 subagent 和 subagent_fork 工具。Team 的 spawn_teammate 和 workflow 的 agent() 都不传 maxDepth，所以不受深度限制。默认设置下，队友（深度 1）不能再用 subagent 工具，但可以跑 workflow，而且深度不受检查。想让机器人内部扇出，或者限制它扇出，都要另外处理。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent/lib/index.js:461-471、524-528
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:279-284
  - 证据：dsh-src/@deepseek-ai/dsh-workflow-ptc/lib/index.js:327-349
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1032-1043
- 架构 B 消息总线的两个坑。
① sessionController 的 prompt、selectModel、rename、cancel 都拒绝子代理会话，所以中心插件只能管顶层会话，管不了 Team 队友。
② sessionController.prompt 记录的 source 固定为 user，机器人之间经它转发的消息，对方看到的就是「用户说」。要带上发送者身份，得先 resolveAgent，再自己调 agent.followup/steer(createUserMessage({content, source}))，schedule 就是这样投递的。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:128-142、793-794、925-950、1061-1066、3218-3236
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1576-1597
- schedule 和归档对「Agent 中心」的影响。
- schedule 服务按 sessionId 绑定提醒，不校验调用者是谁，所以中心插件可以给任何顶层机器人会话布置提醒；模型自己的工具只能给自己布置。
- 但提醒没有暂停功能，只能投递回原会话。
- 归档会话时如果带 stopActivity，会直接删除它的活跃提醒，取消归档也不会恢复。
- 归档门禁会挡住整条血缘（包括所有队友）的每一步。
所以「用归档当暂停」会丢掉定时配置，一键暂停得由 Agent 中心自己实现。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2084-2098、2043-2063、2273-2290
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md（已知限制：不支持暂停、原会话以外的投递；会话绑定校验不等于调用者鉴权）
  - 证据：dsh-src/@deepseek-ai/dsh-workspace/README.zh.md:104（archiveSession stopActivity）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/README.zh.md:75（ArchivedSessionGate 挡住整条血缘）
- 并发和预算没有全局闸门。maxActiveSubagents 的名额池按根 Agent 划分，架构 B 里每个机器人各有 8 个名额，核心里找不到跨机器人的全局并发上限或 token 预算，额度护栏得自己写。外部后端 Claude Code 和 Codex（插件页「更多」里按需安装）只执行一次，不接受追加消息，也不支持 agentOptions、agentPreset、maxDepth，只能当一次性帮手，不能当常驻机器人。
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:1754-1762、2786-2795（NO_START_CAPABILITIES）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/README.zh.md（Activation 容量；外部子级执行一次）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:2407（ON_DEMAND_BUNDLES）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:2186-2197
- Team 的状态完全依附于 Lead 会话。TeamId 就是 Lead 的 SessionId，名册和任务都写在 Lead 的会话日志里，没法迁到别的会话，也不能跨 Lead 共享。每次名册或任务变化，都会把完整名册和未删除任务板（含描述）广播给所有已连接的浏览器。机器人和任务一多，前端开销会跟着上去。这条只在 README 里写了。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/README.zh.md（Team 身份与 roster：TeamId 等于 SessionId；已知限制：完整视图广播）

## 缺口与补法

- [R6 独立会话的机器人之间互发消息｜工作量 M] 官方只支持父与子之间、同一 Team 内的消息，没有跨顶层会话的消息通道。
  - 补法：自写插件，注册 robot_send 和 robot_inbox 工具：先用 ctx.sessionController.resolveAgent(目标会话) 拿到 Agent，再调用 agent.followup(createUserMessage({content, source})) 投递（也可以退而用 sessionController.prompt，但来源会显示为 user）。要加限频、防乒乓循环、单条大小上限，并写审计日志。
- [R6/R1 机器人注册表（名字、会话 id、目标、preset、模型、下次唤醒时间）｜工作量 M] 官方没有注册表。Team 名册只增不减，而且只在一个 Lead 内有效。
  - 补法：自写插件，用 @deepseek-ai/dsh-storage-domain 或本地 JSON 持久化，再用 sessionProjections 发布给中心页；建机器人时串起 create、selectModel、/permission、schedule_create 这几步（可以参考桥插件 opStart 的写法）。
- [R6 跨机器人共享看板｜工作量 S] Team 看板只在同一个 Lead 内共享。
  - 补法：优先复用已装的第三方 dsh-taskboard：它跨会话、提供 taskboard_* 工具、卡片可以定时并单独指定 preset 和模型，评论可以当作异步消息用。也可以照 agent-team 的 CAS 看板自己写一个。
- [R1/R6 Team 内每个队友有自己的 preset、模型、目录｜工作量 M] spawn_teammate 和 spawnTeammate 都不透传 agentPreset、agentOptions、cwd。
  - 补法：fork 这两个实验包（agent-team、tool-agent-team），把这三个参数透传给 ctx.subagents.startActivation（spawn 提供方已经支持）；或者干脆自写一个类似 Team 的插件。升级后容易坏。
- [R2+R6 队友按计划自己醒来｜工作量 S] 子代理被 schedule 拒绝，会话控制器也拒绝子代理会话。
  - 补法：在 Lead（顶层会话）上建提醒，在提醒内容里约定「醒来后给哪些队友发什么」，由 Lead 扇出；或者直接改用架构 B，让每个机器人都是顶层会话。
- [R6 机器人数量超过 8 个，或者能退役机器人｜工作量 L] 桌面组合包写死 maxMembers: 8，名字永久，没有删除。
  - 补法：在用户 profile patch 里把 agent-team 行的 maxMembers 调高（改配置）；但要支持删除或复用名字，必须改实验包本身。
- [R6/R9 持久邮箱、投递重试、跨进程｜工作量 L] 官方明确不提供，设计上就是单进程。
  - 补法：自写插件在自己的存储里做发件箱：投递失败时（例如目标会话正被别的进程占用而报 writer-held）重试并去重。跨进程共享同一个 Team 做不到。
- [R3/R6 机器人的固定流水线｜工作量 S] workflow 没有「保存的工作流」，也不能续跑。
  - 补法：把脚本存进文件，定时提醒的内容写成「读这个文件，用 workflow 并开 run_in_background 跑它」；或者插件在定时事件里直接调 ctx.workflowEngine.start。还要把子代理并行上限调到不小于 workflow 的并发数。
- [R8 能看到协作过程（谁给谁发了什么、谁在干什么）｜工作量 M] Team 面板只读、不显示消息；workflow 节点只显示状态。
  - 补法：订阅 session/event、workflow/*、subagent/*、agent/status 这些事件，自建中心页（投影加 slot）。

## 可调用的宿主接口

- `ctx.agentTeams（TeamService）`：方法有 membership、listMembers、spawnTeammate、sendMessage、createTask、getTask、listTasks、updateTask、waitForChange、interrupt；每个方法都要传入一个确切在线的成员 Agent 作为调用者。插件拿到 Lead 的 Agent 句柄后，可以代 Lead 批量建队友、发消息、操作看板（但传不了 preset、模型、cwd）。
- `ctx.subagents（startActivation / sendMessage / interrupt / listChildren / listDescendants / waitForChildren / drainChildren / registerProvider）`：自建团队式编排时，用 startActivation({provider: spawn, childId, delivery, label, request: {prompt, parent, cwd, agentPreset, agentOptions, outputSchema}}) 起有名字的子代理，可以带各自的 preset、模型、cwd；但仍受 8 个名额和父级必须在线的限制。
- `@deepseek-ai/dsh-subagent/internal：queueHostSubagentPrompt / steerHostSubagentPrompt`：宿主专用的投递口：以直接父级的权限向它的子代理投递带自定义 source 的消息，子代理未加载时会冷恢复。Team 自己就是这么用的。
- `ctx.sessionController（create / selectModel / prompt / cancel / rename / projections / resolveAgent）`：架构 B 的核心：建机器人会话（带 preset）、设模型、投递指令（queue 或 steer）、中断、读投影。resolveAgent 会冷恢复普通顶层会话，并按会话记录的 preset 组合；拿到 Agent 后调用 agent.followup 或 agent.steer，就能实现机器人之间的消息投递（schedule 服务就是这样投递的）。
- `ctx.agents.create / resume`：直接建或恢复顶层会话，指定 sessionId、meta.cwd、meta.agentPreset 和 agentOptions（provider、model、reasoningEffort）。第三方任务看板就是用它为每张卡起执行会话，并在定时执行时复用会话。
- `ctx.schedule（create / list / catalog / history / update / delete）`：给每个机器人（顶层会话）建一次性、周期、每日、每周或 cron 提醒；由宿主持久保存，到期时冷恢复会话并投递。注意：不能绑到子代理会话上。
- `ctx.workflowEngine.start({script, meta, args, parent, signal, subagentProvider, maxTotalAgents})`：插件可以直接替某个在线机器人跑一段固定流水线，并拿到 run.result；用完必须调用 dispose。观察事件有 workflow/start、end、phase、log、agent-start、agent-end，可以用来做中心页的进度展示。
- `ctx.ptcRuntime.resolve / run`：在沙箱化的 Node 进程里运行一段程序，程序可以调用你注入的宿主异步函数；适合做确定性的数据处理步骤，不负责 agent 编排。
- `事件：agent/created、agent/status、agent/disposed、session/event、schedule/changed、subagent/start、subagent/end`：自建注册表和中心页时用来追踪每个机器人的状态和产出。agent/created、agent/status 是 Team 服务自己用的，session/event 是桥插件在用。
- `按 Agent 作用域注册工具和提示：agent.ctx.tools.register(defineTool) + agent.ctx.systemPrompt.section/context`：照 tool-agent-team 的 install/maybeInstall 写法，只给「属于 Agent 中心的机器人会话」装上 robot_send、robot_list、board_* 等工具，以及身份上下文（比如「你是机器人 X，你的目标是…」）。
- `ctx.commands.execute(agent, '/permission …' 或 '/goal …')`：给机器人会话设置权限档位、挂上长期目标（桥插件已验证可用）。
- `ctx.sessionProjections.register + 客户端 slot；createUserMessage（@deepseek-ai/dsh-llm）；defineDomain（@deepseek-ai/dsh-storage-domain）`：做中心页（投影加页头或侧栏 slot）、构造带 source 的消息、持久化注册表；schedule 服务和 Team 服务都是这么做的。

## 读者留下的未决问题

- 桌面版开启「智能体团队」后，preset 作用域里仍挂着 subagent 版的 send_message、list_agents、interrupt_agent，和 Team 版同名工具哪个生效、模型会不会同时看到两套？README 只把它列为已知限制，需要实测。
- 用户自己的 profile patch 有没有改过 agent-team 的 maxMembers、有没有开启 Teams 或 taskboard？按禁区规则没有读 profile 里的 cordis.patch.yml 和 package.json，无法核实。
- 桌面宿主里空闲的顶层会话（Lead）多久会被卸载出 ctx.agents？这决定「Lead 空闲时队友能互相唤醒」能维持多久。在 session-controller、agent、subagent 里没找到空闲回收逻辑，未确认。
- DSH 核心对同时存活的顶层会话数量到底有没有上限？只在 api-session-controller 的配置里确认没有，没有全面搜索 agents 工厂和桌面宿主，需要实测内存、CPU 和额度消耗。
- 自建插件用 agent.followup 投递 source.kind 为 agent-message、form 为 relay 的消息时，会不会被校验拒绝、界面能不能正确显示发送者？未验证。
- 能否在界面里给单个 teammate 单独切换模型（名册会读队友自己的 options.model）？未验证。
- workflow 子代理受不受 maxDepth 限制？队友（深度 1）能不能调用 workflow？未验证。
- 本机 18 核时 workflow 默认并发 16、大于子代理名额 8，大扇出会不会真的触发 AGENT_START 导致整次失败？目前是根据代码推断，需要实测。
- 第三方 dsh-taskboard 的 cron 定时在桌面版关窗口或退出 App 后还会不会触发、错过的会不会补跑？README 写的是「错过窗口跳过不补跑」，具体属于 R9，需要和负责 R9 的那一路核对。
