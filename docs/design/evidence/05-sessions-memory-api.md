# 底稿：会话、记忆与宿主编程接口（R4、R8）

> 研究底稿（2026-11-04，DSH 桌面版 0.2.1-rc.5）。先由一位读者细读官方插件说明与源码，再由另一位核查员逐条尝试推翻承重结论；「核查」一节里的修正优先于「读者结论」。证据路径中的 `dsh-src/` 指从安装包只读解出的官方插件源码，可用 `tools/asar_extract.py` 重新解出。

## 读者总结

这一块的底子够用。宿主里有现成的会话服务 `ctx.sessionController`，插件能新建会话、发消息触发一轮、取消、列出全部会话，还能读目标、用量、每轮摘要等「投影」（从事件日志算出来的当前状态）。你自写的控制桥已经在用这套接口。会话日志按会话永久落盘、崩溃后能恢复，重启后给会话发消息会自动把它唤回来；也能用 `ctx.storageDomain` 像 schedule 那样建一张「机器人注册表」。真正缺的是长期记忆：官方没有记忆插件，自动压缩只留一份英文摘要，而且越压越丢细节；会话全文搜索默认关着，对中文关键词也不友好。所以最稳的做法是每个机器人一个独立工作目录，人设和目标写进 AGENTS.md（DSH 会自动把它注入会话开头），进展写进自己的记忆文件。远程和外部驱动是硬伤：桌面版宿主只监听本机随机端口，启动令牌不落盘，手机和外部程序都连不上。ACP、SDK、headless 能跑会话，但都是独立进程，桌面版里看不到实时过程，还会和桌面版抢会话写锁。所以 Agent 中心的核心应做成桌面版里的插件。

## 逐题回答

**问题 1**

结论：插件可以全程用编程方式控制会话。主入口是 Host 服务 `ctx.sessionController`，方法与 session/* Remote 端点一一对应，你的控制桥已经跑通。下面的路径都相对于 dsh-src/@deepseek-ai/dsh-api-session-controller/lib。
① 新建会话：`create({ cwd 或 workspaceId（二选一）, agentPreset?, sessionId? })`，返回 `{ sessionId, agentPreset }`（index.js:755-786；参数 schema 见 typert.host.js:228）。create 没有权限参数，需要第二步设置：
- 权限：`ctx.commands.execute(ctx.agents.get(id), '/permission workspace-write', [], signal)`（dsh-commands lib:327），或直接调 `ctx.permissionPresets.set(session, 'workspace-write')`（dsh-permission-presets lib:344）。新会话默认取 permission 设置里的 defaultPreset。
- 模型：`selectModel({sessionId, provider?, model})`。
- 标题：`rename({sessionId, title})`。按 dsh-session-title README，用户来源的标题会钉住会话，之后不再自动生成标题。
② 发消息并触发一轮：`prompt({ sessionId, requestId, mode:'queue'|'steer', content:[{type:'text', text}] }, signal)`。它先解析或恢复冷会话，再调用 agent.followup（queue）或 agent.steer，空闲的 agent 会被唤醒开跑；同一 requestId 重试不会重复入队（index.js:925-968，必须传 AbortSignal）。更底层的做法：`ctx.agents.get(id).followup({content, source})`，以及 steer、inject（只注入上下文、不唤醒）、whenIdle（dsh-agent-loop lib:806-870）。
③ 读状态和最后输出：
- 在线状态：`ctx.agents.get(id)?.status` 取值 'idle' 或 'running'（agent-loop lib:791）。
- list 行：含 running、agentAvailable、updatedAt、cwd 和投影缓存（index.js:1940-1953）。
- `projections({sessionId}, signal)`：返回 `{kind:'sequenced', asOfSeq, values}`，values 里有 goal、tokenUsage、sessionStats、turnOutline（每轮回复 120 字预览）、title、inbox、agentPreset（index.js:3281-3320）。
- 最后输出：监听 `ctx.on('session/event', (session, event) => …)` 抓 assistant/message 和 turn/end（桥 bridge.js:480-550 就是这样做的）；或冷读 `ctx.sessionQuery.filterEvents(id, [{kind:'type', values:['assistant/message']}])`、readSurface(id)。
④ 列出全部会话：`list({}, signal)` 只读持久 header 和投影缓存，不激活 agent；也可以用 `ctx.sessionQuery.listSessions()`。`ctx.agents.list()`/`roots()` 只列在线的。
⑤ 中断：`cancel({sessionId})` 等于 `agent.cancel({kind:'user'}, {keepInbox:true})`，只对在线会话有效，否则报 session/not-found（index.js:1061-1068）。直接 `agent.cancel(cause)` 不带 keepInbox 会清空排队。挂了 /goal 的会话还要再执行 `/goal clear`，否则目标驱动会继续推进。
⑥ 可用事件：
- session/created、session/event、session/disposed
- agent/created、agent/disposed、agent/status、agent/error
- agent/pre-step（能拒绝下一步，适合做预算闸门）、agent/turn-stopping
- api-session/added、removed、status、activity、error
- approval/request（waterfall，可写自动审批应答者）
注意事项：
- 子代理会话不能用这些方法（报 session/agent-busy）。
- 会话被别的进程占写时报 session/writer-held（index.js:243）。
- 0.2.1-rc.2 起，走 typertGateway.invoke 必须带 Peer；宿主内插件应直接调服务方法，桥 index.js 的头部注释有说明。

**问题 2**

① 压缩保留什么、丢什么。压缩由 dsh-compaction-basic 负责，桌面版由 standard 预设挂载。触发条件：token 压力超过 min(0.8×窗口, 窗口−输出预留−65536)，在下一步之前触发。做法：用一次额外模型调用，把最旧的一段对话换成一条英文结构化摘要，固定包含 Primary Request and Intent、Key Technical Concepts、Files and Code、Errors and Fixes、Pending Jobs、Current Work、Next Step、Critical Context 这几节。
- 保留：最近约 16%×(窗口−输出预留) 的原文；系统提示词永不被压；超大工具结果会先被截成头尾两段。
- 丢失：被压区间里摘要没写到的细节、推理过程、工具参数和原始结果。再次压缩时会合并旧摘要并丢弃陈旧事实，越压越粗。
- 原事件仍在磁盘日志里，只是被遮蔽（dsh-compaction README）。token 按 4 字符/token 估算，中文会被低估。
② 能否检索自己过去的会话。
- 程序侧：`ctx.sessionQuery` 在 base 档常驻，可以按 cwd、时间过滤会话，用 filterEvents 做字面子串扫描（中文子串也能扫，但每次都回放整份日志）。全文搜索在 base 里默认关闭（openAt: never）。
- 模型侧：要在插件页启用实验包「会话搜索」，它给所有 agent 加 5 个只读工具（session_search 等）。跨会话只能查与自己 cwd 完全相同的会话，所以每个机器人独占一个目录时，正好只能查自己的历史。缺点：索引在内存里，重启后首次搜索要重读全部日志；unicode61 分词不做子串匹配，按 SQLite 规则连续汉字会被当成一个 token，中文关键词召回很可能差（推断，未实测）。
- 另外，桌面档挂了 dsh-session-reference，可以在提示词里 @ 引用旧会话，注入一份有界的只读快照。
③ 现成的长期记忆插件：没有。308 个官方包里没有 memory 类包；Ralph 的 README 也写明工作区是唯一的跨 Round 长期记忆。
④ 「每个机器人维护自己的记忆文件」是目前最稳的做法，而且有原生注入通道。dsh-agent-instructions 会把 ~/.dsh/AGENTS.md、~/.agents/AGENTS.md，以及从项目根（.git）到会话 cwd 每层的 AGENTS.md、CLAUDE.md、AGENTS.local.md、CLAUDE.local.md，作为一条持久基线放进第一次请求，总预算 65,536 字节；agent 用 read/write/edit 碰到这些文件后，改动会刷新进后续请求。具体建议：
- 每个机器人一个独立 cwd，最好带 .git，免得读到上级目录的 AGENTS.md。
- AGENTS.md 放稳定的人设和长期目标，memory.md/journal.md 放进展。
- 在 /goal 目标和唤醒提示词里写死「先读记忆、收尾写记忆」；goal 每一轮都会重新带上目标，压缩后也不会丢。
- 注意 ~/.dsh/AGENTS.md 会进所有机器人的上下文，单个文件要控制体积。

**问题 3**

能。`ctx.storageDomain` 由 base 档挂载，后端是 json，根目录 ~/.dsh/storages（schedule.json 就在这里）。schedule 的建表方式是 defineDomain({name:'schedule', version:1, tables:{tasks: domainTable(zodSchema)}}) 加 ctx.storageDomain.open（dsh-schedule lib:1675-1690、:1997）。
自建插件的用法：`const d = await ctx.storageDomain.open({ name:'agent_center', version:1, layout:'per-record', invalidRecords:'backup-and-skip', tables:{ bots:{ valueSchema: zod 对象 } } })`，然后用 `d.table('bots').put/get/update/delete`。读是同步内存读，写在落盘后才完成，并按顺序发出 domain/changed。defineDomain 只是校验后原样返回 spec，domainTable 就是 {valueSchema}（storage-domain lib:46-76），所以插件不用 import @deepseek-ai 包，手写同形状对象加你 profile 里已装的 zod 即可。不 import 也是为了避开遮蔽内置构建的坑，见 dsh-taskboard 的 sdk.ts。
注意事项：
- 名称要匹配 ^[a-z][a-z0-9_]*$，记录键要匹配 [a-zA-Z0-9_-]+。
- put 写入时不做 schema 校验（lib:257-263），只在 open 时校验；写坏一条会让下次 open 失败，除非设了 backup-and-skip。
- 没有跨进程写锁，没有跨表事务，版本号一变就拒绝打开（无自动迁移）。
- domain/changed 只在本进程可见。
- 本版本没有 storage-sqlite 后端。
机器人注册表数据量小，完全够用。推荐 per-record 布局：每个机器人一个文件，单条写坏不连累全表。

**问题 4**

桌面版现状：不能直接远程。
- 桌面宿主是 Electron 拉起的子进程，固定以 --host 127.0.0.1 --port 0 启动，只监听本机随机端口（dsh-desktop-host lib:232-241）。
- 启动 token 每进程随机生成，只经 IPC 交给 Electron（client-connection lib:294-300；main.js:8229、:12190）。
- dsh:// 深链只支持 dsh://open 聚焦窗口（main.js:13055-13058）。
所以手机连不上，本机外部程序也拿不到 token。
官方的远程路径：另起一个 Web 宿主，`dsh --profile web --host <本机具体 IP> --tls-cert … --tls-key … [--trusted-host 名称] [--public-url …]`（拒绝 0.0.0.0）。浏览器用启动时打印的带 token URL 换签名 cookie（默认 30 天，绑定 host:port），之后所有 RPC/WebSocket 都要认证。程序可以走 GET /connect?token=… 拿 API cookie。Host/Origin 栅栏只防 DNS rebinding，不负责认人。
安全模型：
- 认证通过的浏览器和 API 调用者都是 owner，拥有全部权限：能发消息、改设置、装插件。
- 非 owner 的细粒度角色只有机制（dsh-api-remote-access 的 policy/binding），官方没有内置任何策略，想做只读分享得自己写。
- 没有 logout，要删凭据记录并重启才能全部撤销。
- 不开 TLS 时 cookie 明文传输。
额外风险：Web 宿主和桌面版共用 ~/.dsh。同一会话两边会抢写锁（session/writer-held），storage-json 没有跨进程写锁，workspace.json、schedule.json 可能互相覆盖，所以不要两者同时跑在同一个 DSH_HOME 上。
可行方案：
- 首选：桌面版内自写插件，把汇报和告警推到飞书（手机看）；再从外部通道取指令后调 sessionController.prompt 唤起机器人。入站通道可以是同步文件夹或飞书事件订阅，需要另行验证。
- 备选：用 Tailscale 等把手机接入私网，跑独立 Web 宿主。但它与桌面版互斥，或者要用独立的 DSH_HOME，那样就看不到桌面版的机器人。

**问题 5**

能驱动，但都不是驱动「桌面版里的会话」。
① ACP：`dsh --profile acp`，标准 ACP v1 over stdio。
- 提供 session/new、list、resume、close、prompt、cancel、set_config_option。
- 审批走 session/request_permission，由驱动程序自动作答，最适合无人值守。
- 会话写入同一个 ~/.dsh/sessions，其他进程可以 list/resume。
- 缺点：默认模型是 deepseek-official/deepseek-v4-flash，用 GLM 要打 patch；只有标准语义更新，没有 DSH 的 goal、计划、标题呈现；没挂 schedule。
② SDK JSON-RPC：`dsh --profile sdk`。
- 方法：initialize、session/prompt、session/resume、session/wait、session/working-directory/get|set、shutdown；通知：session.event、session.status。
- 缺点：没有逐会话关闭或取消；自动适配器只支持 DeepSeek。
③ headless：每次跑一个任务，用 --session-id 续接同一会话，--json 输出事件流；默认不用 GUI 保存的凭据（你踩过的 MISSING_CREDENTIAL）。
这三种都是独立进程：桌面版看不到实时过程，刷新后才能看到冷历史；如果桌面版正持有该会话，还会被单写者锁挡住。
④ 你的控制桥：插件跑在桌面宿主进程内，直接调 ctx.sessionController。
- 优点：会话在客户端实时可见；复用 preset、goal、权限、审批 UI 和 schedule；不开网络端口；文件收件箱协议对 Claude Code 很友好。
- 缺点：依赖内部宿主服务，rc.2 已经破坏过一次；每 2 秒轮询一次；跟踪状态只存在内存里（bridge.js 的 tracked），宿主重启后会丢掉对旧任务的跟踪，只剩 processed-ids；审批仍需人点。
- 「活动会话已达上限 2」是桥自己的 settings.json 默认值，可在 1–4 之间调（bridge.js:54、:161），不是 DSH 的硬限制。我没有在 README 里找到宿主层的会话并发上限，代码未穷尽。
建议：Agent 中心的核心做成桌面版内插件，也就是桥的升级版，加上注册表、唤醒和数据面；Claude Code、定时脚本继续通过文件收件箱给它下指令。ACP 只用于不需要在桌面围观的后台机器人。

## 能力清单（* 为承重结论）

- **C1***（依据：both；对应 R1, R2, R5, R8）宿主内插件可以直接调用 `ctx.sessionController`（`session` Remote 命名空间背后的 Host 服务），用编程方式管理会话。可用方法：create({cwd 或 workspaceId, agentPreset?, sessionId?}) 新建会话，可指定 preset、工作目录，甚至自定会话 id；prompt({sessionId, requestId, mode:'queue'|'steer', content}, signal) 发消息并唤醒 agent 开跑一轮，冷会话会先被自动恢复，同一 requestId 重试不会重复入队；此外还有 cancel、list、projections、rename、selectModel、fork、page/follow/control 流。你的控制桥已经在实际使用这套方法。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2676-2700（@Remote 装饰器：list/search/create/selectModel/rename/fork/prompt/attachment/updateQueue/cancel/page/follow/projections/control）
  - 证据：同文件 :755-786 commands.create（workspaceId 与 cwd 二选一，可带 agentPreset、sessionId）；:925-968 commands.prompt（mode==='steer' 时调用 agent.steer，否则调用 agent.followup）；:1061-1068 cancel
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:228-233（create 参数 schema）、:1129（prompt.mode 只允许 queue|steer）
  - 证据：dsh-api-session-controller/README.zh.md「使用本包」：取消要求会话在线；queue、模型、重命名、prompt 可以解析或恢复普通 Session；只有 create 与 fork 会直接创建新 Agent
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js（inject: sessionController/workspaceRegistry/commands/agents；createSessionInvoke 直连服务）；lib/bridge.js:307-360（create→rename→/permission→selectModel→prompt→/goal）
- **C2**（依据：both；对应 R1, R7）权限档位和模型不在 create 参数里，要在建会话后再设一步。权限用 `ctx.commands.execute(agent, '/permission <预设名>', [], signal)`，或直接调 `ctx.permissionPresets.set(session, name)`；新会话默认用 permission 设置里的 defaultPreset。模型用 `sessionController.selectModel({sessionId, provider?, model})`。
  - 证据：dsh-src/@deepseek-ai/dsh-permission-presets/lib/index.js:170（服务名 permissionPresets）、:206-215（注册 /permission 命令）、:344-360（set/apply 按需改沙箱与审批）
  - 证据：dsh-src/@deepseek-ai/dsh-commands/lib/index.js:259（服务名 commands）、:327 execute(agent, line, submittedAttachments, signal)
  - 证据：dsh-permission-presets/README.zh.md「会话默认值」：创建会话时读取 defaultPreset 并记录 permission/preset
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:323（实际用 /permission 设置权限档位）
- **C3**（依据：both；对应 R2, R3, R7, R8）底层 Agent/Session API 与事件都可直接用。`ctx.agents` 提供 create/resume/get/list/roots；Agent 句柄提供 followup（排队并唤醒）、steer、inject（只注入上下文、不唤醒）、cancel、whenIdle，status 取值为 'idle' 或 'running'。`ctx.sessions` 提供 create/get/list/fork/flush。可监听的事件有 session/created、session/event、session/disposed，agent/created、agent/disposed、agent/status、agent/error，以及可拦截的 agent/pre-step（能拒绝即将开始的步骤）和 agent/turn-stopping。
  - 证据：dsh-src/@deepseek-ai/dsh-agent/lib/index.js:332（服务名 agents）、:453 create、:466 resume、:596 get、:614 list、:623 roots
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:791（status 为 idle|running）、:806 followup、:809 steer、:812 inject、:815 cancel、:870 whenIdle
  - 证据：dsh-src/@deepseek-ai/dsh-session/lib/index.js:1739（服务名 sessions）、:1772 create、:1951 flush、:1980 get、:1987 list、:2006 fork；事件 :1587 session/event、:1910 session/created、:1930 session/disposed
  - 证据：dsh-agent/README.zh.md「驱动 agent 的对话」「拦截或观察进行中的工作」；cancel 默认清空收件箱
- **C4**（依据：both；对应 R8, R3, R7）Agent 中心需要的数据大多现成可读。list 行含 sessionId、updatedAt、running、agentAvailable、blank、cwd、parentSessionId、origin 和投影缓存。projections 能读到：goal（含 phase）；tokenUsage（累计 token 分桶）；sessionStats（轮数、步数、llmMs、toolMs、decodeTokens）；turnOutline（每轮提示词 50 字、回复 120 字预览，可当「最近产出」）；title、inbox、agentPreset 等。下次唤醒时间可以从 `ctx.schedule.list/catalog` 取，lib 里有 nextScheduledAt 字段。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:1940-1953（summaryFor 行字段）、:3281-3320（projections 返回 {kind:'sequenced', asOfSeq, values}）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js:440（key goal）；dsh-src/@deepseek-ai/dsh-token-meter/lib/index.js:393-420（key tokenUsage）；dsh-src/@deepseek-ai/dsh-session-stats/lib/index.js:67；dsh-src/@deepseek-ai/dsh-session-turn-outline/lib/index.js:78 及其 README 字段表
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2083 create、:2120 list、:2129 catalog，nextScheduledAt 出现 14 次（返回结构未细看）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:95-110（web/desktop 档挂载了 session-reference、session-stats、session-turn-outline）
- **C5***（依据：both；对应 R4, R9）会话历史可靠落盘。每个会话是一份只追加的日志，每批写入都 fsync，存放在 `~/.dsh/sessions/--<规范化cwd>--/<会话id>/`，不同工作目录的会话天然分开存。崩溃后，读方会补写被中断那一轮的收尾事件。压缩只遮蔽、不删除原事件。重启后对会话发 prompt 会自动 resume，所以机器人的对话历史跨天、跨重启都在。格式升级有迁移链，但只升不降。
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:138-141（session-persistence-jsonl 的 root 为 dshHomePath('sessions')）
  - 证据：dsh-session-persistence-jsonl/README.zh.md「磁盘布局」「持久性与崩溃语义」；lib/index.js:12 引入 flock、:315 SessionAlreadyOwnedError
  - 证据：dsh-session-persistence/README.zh.md「恢复与崩溃恢复」；dsh-compaction/README.zh.md 概述（被遮蔽内容仍保留在会话日志）
  - 证据：ls /Users/bytedance/.dsh/sessions（只列了目录名：12 个按 cwd 命名的目录）
  - 证据：dsh-session-checkpoint-policy/README.zh.md 概述（模型请求前、有副作用的工具调用前先落盘）
- **C6**（依据：both；对应 R4）自动压缩（compaction）的规则：当 token 压力超过 min(0.8×窗口, 窗口−输出预留−65536) 时，在下一步之前，用一次额外模型调用把最旧的一段对话换成一条结构化摘要。摘要固定包含这几节：Primary Request、Key Concepts、Files and Code、Errors and Fixes、Pending Jobs、Current Work、Next Step、Critical Context，并要求用英文写。最近约 16%×(窗口−输出预留) 的对话原样保留，系统提示词永不被压。超大工具结果会先被截成头尾两段（pruner）。桌面版的压缩由 standard 预设挂载。
  - 证据：dsh-compaction-basic/README.zh.md「调整压缩开始的时机」「压缩指令」（Rules: Write concise English engineering prose；合并旧摘要时 drop stale ones）
  - 证据：dsh-src/@deepseek-ai/dsh-compaction-basic/lib/index.js:634-648（追加 compaction/summary 事件并带 usage）、:985 compactNow(agent, signal, ...)
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:544-551（宿主层禁用）；dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:66-78（standard 预设内挂 compaction-basic、command-compact、tool-result-pruner）
  - 证据：dsh-compaction-tool-result-pruner/README.zh.md 概述
- **C7**（依据：both；对应 R4, R8）过去的会话可以检索。程序侧，`ctx.sessionQuery` 在 base 档常驻，提供 listSessions、filterSessions（按 cwd、时间等过滤）、filterEvents（字面子串扫描）、readSurface、readSession、observeSession、traceSession 等方法。全文搜索（SQLite FTS5）要在插件页启用实验包「会话搜索」，它会给所有 agent 加 5 个只读工具（session_search 等），并且只允许查与自己 cwd 完全相同的会话。
  - 证据：dsh-src/@deepseek-ai/dsh-session-query/lib/index.js:1048（服务名 sessionQuery）、:1064-1210（各读取方法）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:149-161（session-query-sqlite 配为 path ':memory:'、openAt: never，即全文搜索默认关闭）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-session-search/cordis.patch.yml（独立组，openAt: first-search）；README：Web 和 Desktop 随附，默认关闭
  - 证据：dsh-tool-session-query/README.zh.md「模型可以做什么」：跨会话访问要求 cwd 严格相等，搜索结果排除调用方自己的会话
- **C8***（依据：both；对应 R1, R3, R4）「每个机器人一份人设/记忆文件」有原生注入通道。dsh-agent-instructions（在 standard 预设内）会把 ~/.dsh/AGENTS.md、~/.agents/AGENTS.md，以及从项目根（.git 标记）到会话 cwd 每层目录里的 AGENTS.md、CLAUDE.md、AGENTS.local.md、CLAUDE.local.md，作为一条持久基线消息放进第一次请求，总预算 65,536 字节。agent 用 read/write/edit 碰到这些文件后，改动会刷新进后续请求，恢复会话时也会重新对账。官方的 Ralph 设计也明确把工作区当作唯一的跨轮长期记忆。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-instructions/lib/index.js:17-18（默认文件名 AGENTS.md/CLAUDE.md 与 AGENTS.local.md/CLAUDE.local.md）、:168（用户全局 AGENTS.md）、:298 renderInstructionChanges
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:15-18（agent-instructions maxBytes 65536）；dsh-base/cordis.patch.yml:306
  - 证据：dsh-agent-instructions/README.zh.md「agent 获得的内容」「观察预算」
  - 证据：dsh-tool-ralph/README.zh.md:36、:163（工作区是唯一的跨 Round 长期记忆）
- **C9***（依据：both；对应 R1, R8）自建插件可以用 `ctx.storageDomain` 像 schedule 那样建表存机器人注册表：调用 open({name, version, layout:'per-record', invalidRecords:'backup-and-skip', tables:{bots:{valueSchema}}})，读是同步内存读，写在落盘后才完成，并发出 domain/changed 事件。数据落在 json 后端 ~/.dsh/storages。defineDomain 只是校验后原样返回 spec，所以插件不 import @deepseek-ai 包、手写同形状对象加 zod 也能用。
  - 证据：dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:46-48 domainTable 返回 {valueSchema}、:61-76 defineDomain 原样返回 spec、:355-392 open（加载时 valueSchema.parse，支持 backup-and-skip）、:449 provide('storageDomain')
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1675-1690（scheduleDomain：name schedule、tables.tasks）、:1997 ctx.storageDomain.open(scheduleDomain)
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:177-192（storage、storage-json root=dshHomePath('storages')、storage-domain backend: json）
  - 证据：ls /Users/bytedance/.dsh/storages（只列了名字：schedule.json、session_projcache、workspace.json）
- **C10**（依据：both；对应 R8, R10）插件可以在 connection 上注册自己的 HTTP 路由，供自己的前端页面取数据。这些路由只对 owner 开放，非 owner 一律 403。第三方插件 dsh-context 已经这样做（注册 /api/dsh-context/*），并读取 sessionQuery.observeSession、sessionProjections 和 storageDomain，说明跨会话统计看板这类数据面能由第三方插件实现。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/lib/index.js（函数 Cr 调用 connection.fetch.register；函数 G 注册 {path, methods:['POST'], requestBody:'buffered', fetch}；路径 /api/dsh-context/backfill）
  - 证据：dsh-client-connection/README.zh.md「浏览器认证与请求信任」：exact route 对非 owner Peer 返回 403
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/README.md（Context Insights 跨会话总览页）
- **C11**（依据：both；对应 R2, R10）外部程序可以驱动 DSH 会话，有三种方式，但都要另起一个进程。ACP：`dsh --profile acp`，标准 ACP v1 over stdio，提供 session/new、list、resume、close、prompt、cancel、set_config_option，审批走 session/request_permission，由驱动程序作答。SDK：`dsh --profile sdk`，提供 initialize、session/prompt、session/resume、session/wait、session/working-directory/get|set、shutdown，通知为 session.event 和 session.status。headless：每次跑一个任务，用 --session-id 续接同一会话，--json 输出事件流。三者的会话都写进同一个 ~/.dsh/sessions。
  - 证据：dsh-acp/README.zh.md「协议约定」；dsh-src/@deepseek-ai/dsh-acp/lib/index.js 中有 newSession/listSessions/resumeSession/closeSession/setSessionConfigOption
  - 证据：dsh-src/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js 中的方法字符串 initialize、session/prompt、session/resume、session/wait、session/working-directory/get|set、shutdown、session.event、session.status
  - 证据：dsh-acp-app/README.zh.md：另一个进程可针对同一持久化根目录 session/list 与 session/resume
  - 证据：dsh-headless/README.zh.md 概述（--session-id、--json）；CLI 位于 /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh（已确认存在，未运行）
- **C12**（依据：both；对应 R8, R2）官方的远程方式是另起一个 Web 宿主：`dsh --profile web --host <本机具体 IP> --tls-cert/--tls-key [--trusted-host] [--public-url]`，不接受 0.0.0.0。每个进程生成一个随机启动 token，用它换签名 cookie（默认 30 天，绑定 host:port），之后所有 RPC 和 WebSocket 都要认证，另有 Host/Origin 栅栏防 DNS rebinding。程序化客户端可以走 GET /connect?token=… 拿 API cookie。
  - 证据：dsh-web-app/README.zh.md:51-79（--host/--tls-cert/--tls-key/--public-url/--trusted-host）、:166-176（已知限制：通配地址被拒、不开 TLS 时为明文）
  - 证据：dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:294-300（processLaunchToken 用 randomBytes 生成）、:440 authenticatedUrl、:464 根路径换 token、:519 /connect、:752 createPeer
  - 证据：dsh-client-connection/README.zh.md「浏览器认证与请求信任」（cookieMaxAgeDays 默认 30，principal 为 owner）
  - 证据：dsh-host-webserver/README.zh.md「已知限制」：不提供服务器级认证

## 限制清单（* 为承重结论）

- **L1*** 桌面版宿主对外不可达。它是 Electron 拉起的子进程，固定以 --host 127.0.0.1 --port 0 启动（只监听本机随机端口）；启动 token 每进程随机生成，只经 IPC 交给 Electron，不落盘；dsh:// 深链只支持 dsh://open（聚焦窗口），没有任何外部触发入口。
  - 影响：手机无法直接查看或唤起桌面版里的机器人，本机外部程序（Claude Code、定时脚本）也无法用官方 API 操作桌面版会话。要远程只有两条路：自写宿主内插件开通道（文件收件箱、飞书等），或另起一个 Web 宿主。
  - 证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:232-241（args: --no-open --host 127.0.0.1 --port 0）、:342-347（authenticatedUrl 只经 process.send 交给父进程）
  - 证据：dsh-src/_app/main.js:8229-8237 authenticateWebHost、:12190-12192 hostUrl = ready.url、:13055-13058 open-url 只处理 dsh://open
  - 证据：dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:294-300（进程内随机 token）
- **L2*** 每个会话同一时刻只允许一个进程写（session.lock 上的 flock）。桌面版持有在线 agent 的会话时，ACP、SDK、headless 或另一个 Web 宿主去 resume/prompt 会得到 session/writer-held。反过来，外部进程开的会话在桌面版里看不到实时过程，只能刷新后看冷历史。
  - 影响：同一个机器人不能同时被桌面版和外部驱动器操作。Agent 中心必须选定一个宿主作为机器人的唯一运行地，推荐桌面版内插件。用 ACP 跑的机器人和桌面版是两套世界。
  - 证据：dsh-session-persistence-jsonl/README.zh.md「已知限制」：每会话一个活动写入方，内核锁排除其他所有实例与进程
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:243（SessionAlreadyOwnedError 映射为 session/writer-held）
  - 证据：/Users/bytedance/.claude/skills/drive-dsh/references/gotchas.md 第 9 条（headless 会话客户端看不到实时过程）
- **L3*** 没有现成的长期记忆插件，自带的压缩是有损的。只保留一次模型调用产出的英文摘要，推理过程、工具参数和原始结果都会丢；多次压缩时会合并旧摘要并丢弃陈旧事实，越压越粗；每次压缩都多发一次接近满窗口的请求。token 估算按 4 字符/token，中文会被低估。压缩只在单个会话内有效，新会话从零开始。
  - 影响：长期运行的机器人不能靠会话上下文记事，必须把关键事实外置到记忆文件里。压缩还会额外消耗订阅额度，几十个机器人一起长跑时更容易打光 5 小时额度。
  - 证据：dsh-compaction-basic/README.zh.md 概述、「压缩指令」Rules、「已知限制」、开发备注（tokenizer 每 token 四字符的启发式对 CJK 偏低）
  - 证据：dsh-src/@deepseek-ai/ 下 308 个包里没有 memory 类包（ls 包名并 grep README 未发现）
  - 证据：dsh-tool-ralph/README.zh.md:163
- **L4** 全文会话搜索默认关闭（openAt: never）。实验包开启后，所有 agent 的每次请求都多带 5 个工具 schema 和一段固定指引。索引放在 :memory:，每次重启后首次搜索要重读全部日志。分词器是 unicode61，不做子串匹配：按 SQLite 规则，连续汉字会被当成一个 token，中文关键词召回很可能很差（推断，未实测）。
  - 影响：不适合当机器人的主要记忆检索手段。中文场景下要么自写基于 filterEvents 字面扫描的 recall 工具，要么在记忆文件里自己维护索引。
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:149-161
  - 证据：dsh-src/@deepseek-ai/dsh-session-query-sqlite/lib/index.js:114、:144（tokenize = 'unicode61'）；README「已知限制」：不匹配更大 token 中的子字符串，trigram 方案被否决
  - 证据：dsh-tool-session-query/README.zh.md 概述（每次模型请求都增加固定指引与五个工具 schema）
- **L5** storageDomain 有几个限制：没有跨进程写锁；没有跨表事务和二级索引；版本号一变就拒绝打开（无自动迁移）；put 写入时不做 schema 校验，只在 open 时校验，写坏一条会让下次 open 失败，除非用 backup-and-skip；domain/changed 只在本进程可见；本版本没有 storage-sqlite 后端，只有 json。
  - 影响：机器人注册表这种小数据够用，但插件要在写入前自己校验，并用 per-record 布局加 backup-and-skip。不能让两个宿主进程同时写同一个 domain。
  - 证据：dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:257-263（put 直接落盘、不校验）、:366-376（加载时校验与 backup-and-skip）
  - 证据：dsh-storage-domain/README.zh.md「已知限制」；dsh-storage-json/README.zh.md「已知限制」（没有跨进程写锁）
  - 证据：dsh-src/@deepseek-ai/dsh-storage/lib/index.js:80（名称需匹配 ^[a-z][a-z0-9_]*$）；dsh-storage-json/lib/index.js:302（记录键需匹配 [a-zA-Z0-9_-]+）；包列表里没有 dsh-storage-sqlite
- **L6** 用量统计不全：tokenUsage 投影只累计 assistant/message 和 assistant/attempt。压缩摘要调用的 usage 记在 compaction/summary 事件里，但不计入 tokenUsage；标题生成等辅助调用是否入账未核实。
  - 影响：消耗看板和预算闸门如果只看 tokenUsage 会低估，需要插件自己额外累计 compaction/summary.usage。
  - 证据：dsh-src/@deepseek-ai/dsh-token-meter/lib/index.js:393-420（apply 只处理 assistant/message|assistant/attempt）
  - 证据：dsh-src/@deepseek-ai/dsh-compaction-basic/lib/index.js:629-648（compaction/summary 带 usage）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:67-78（session-title-first-prompt-llm 会额外发模型请求）
- **L7*** 插件能调的宿主服务是内部 API，官方没有稳定性承诺，已经出过破坏性变化：0.2.1-rc.2 起 typertGateway.invoke 必须带 Peer。第三方插件不能从 profile 的 node_modules 引入 @deepseek-ai/dsh-* 运行时包，否则会遮蔽内置构建，导致每次工具调用都崩。Client 侧的 Remote 命名空间在构建时就固定了，插件没法往 ctx.remote 加新命名空间。
  - 影响：Agent 中心插件要把对宿主的调用集中在一层适配层里，对服务做防御式探测（dsh-context 就是这么做的），并且每次 nightly 升级后跑冒烟测试。前后端通信只能走自有 fetch 路由。
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js 头部注释（rc.2 起 InvokeRemoteRequest.peer 必填）
  - 证据：dsh-api-gateway/README.zh.md（每次调用都指明 Peer，Gateway 从不提供默认 Peer）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/sdk.ts 头部注释（npm 镜像的 dsh-tools 遮蔽 CLI 内置构建，导致 prepare 报错）
  - 证据：dsh-api-remotes/README.zh.md「已知限制」：能力集合在构建时固定
- **L8** 外部驱动协议各有缺口。SDK JSON-RPC 没有逐会话关闭或取消，自动适配器只支持 DeepSeek。ACP 随附配置默认用 deepseek-official/deepseek-v4-flash，只有标准 ACP 面，没有 DSH 的 goal、计划、标题呈现，也没挂 schedule。headless 默认不用 GUI 保存的凭据。
  - 影响：用 GLM 跑外部驱动的机器人要额外打 patch（凭据能否复用未实测）。定时唤醒只能靠系统 cron/launchd 从外面拉起。
  - 证据：dsh-sdk-jsonrpc-server/README.zh.md「已知限制」
  - 证据：dsh-acp-app/README.zh.md（随附 deepseek-official 与 deepseek-v4-flash）；dsh-acp/README.zh.md「何时选择」
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:135-140（schedule 只在 web/desktop 档插入，base 里没有）
  - 证据：dsh-headless/README.zh.md「凭据」；/Users/bytedance/.claude/skills/drive-dsh/references/gotchas.md 第 8 条
- **L9** 远程的安全模型比较粗。认证通过的浏览器和 API 调用者都是 owner，拥有全部权限；非 owner 角色只有机制（policy/binding），官方没有任何内置策略；没有 logout；不开 TLS 时 cookie 明文传输；webserver 本身不做认证。另起的 Web 宿主和桌面版共用 ~/.dsh，会抢会话写锁，workspace.json 和 schedule.json 也可能被两边互相覆盖。
  - 影响：要做手机只读查看，得自写 remote-access policy。Web 宿主不适合和桌面版同时跑在同一个 DSH_HOME 上；更现实的手机方案是由插件推送到飞书。
  - 证据：dsh-client-connection/README.zh.md（browserPeer 与 /connect 的 principal 均为 owner；已知限制：没有 logout，明文 HTTP 会暴露 cookie）
  - 证据：dsh-api-remote-access/README.zh.md；在 dsh-src/@deepseek-ai/*/lib 中 grep registerPolicy，只出现在 dsh-api-remote-access 自身
  - 证据：dsh-host-webserver/README.zh.md「已知限制」；dsh-storage-json/README.zh.md「没有跨进程写锁」
- **L10** 会话日志从不删除，只会累积。精确读取（readSession、filterEvents、readSurface）每次都回放整份日志。一个机器人如果只用一个会话跑几个月，日志、冷读和索引重建的成本都会持续增长。
  - 影响：建议按周或按月轮换机器人会话：新会话从记忆文件冷启动，旧会话归档。
  - 证据：dsh-session-persistence-jsonl/README.zh.md「已知限制」：不删除会话文件
  - 证据：dsh-session-query/README.zh.md「已知限制」：精确读取回放整个日志
- **L11** 宿主生命周期跟 Electron 绑在一起：宿主子进程一收到 IPC disconnect 就停（退出 App 等于所有机器人停）；macOS 上关掉所有窗口不会退出 App；main.js 里没有阻止系统休眠的代码。
  - 影响：这是 R9（可靠运行）的前提信息：机器人只在 App 运行且电脑醒着时工作。
  - 证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:325（process.once('disconnect', () => stop())）
  - 证据：dsh-src/_app/main.js:13063-13065（window-all-closed 在 darwin 下不退出）；grep powerSaveBlocker 无结果

## 核查结果

- **C1：部分成立**。原结论：插件可直连 ctx.sessionController 编程管理会话：create({cwd|workspaceId, agentPreset?, sessionId?}) 可指定 preset、目录，甚至自定会话 id；prompt({sessionId, requestId, mode:'queue'|'steer', content}, signal) 发消息并唤醒 agent，冷会话自动恢复，同一 requestId 重试不重复入队；另有 cancel/list/projections/rename/selectModel/fork/page/follow/control；控制桥已在用这套方法。
  - 核查说明：大部分在 lib 里确认：服务名 sessionController、namespace 为 session 的 @Remote 方法清单；create 对 workspaceId/cwd 做二选一校验；prompt 先 resolveAgent 恢复冷会话；hasPromptRequest 按 requestId 查 inbox 和日志去重；mode 为 steer 时调 agent.steer，否则调 agent.followup；followup 在 agent 空闲时 wakeDriver 开跑，运行中则排到下一轮；cancel 只对在线会话有效，并带 keepInbox。需要改正或补充的条件：(1)『自定会话 id』有条件。只有该 id 下没有已存储会话时才用它新建。若该 id 已有会话且开始过轮次，或不在指定工作区、被别的写者占用，create 会静默新建一个系统生成的 id 并返回；结果 schema 写明『may differ from the requested sessionId』。cwd 不一致直接报 session/conflict。所以不能把 create({sessionId:'bot-x'}) 当成『按机器人 id 取或建』，唤醒已有机器人应直接对已登记的 sessionId 调 prompt。(2)prompt 的第二个参数必须传 AbortSignal，方法第一行就是 signal.throwIfAborted()。插件直连会绕过 Gateway 的 Typert 参数校验，mode 写错不会报错，只会按 queue 处理。(3)README 把它定位为『Client 经 API Gateway 使用』的 Host 服务；插件直连属于没有官方稳定性承诺的用法，见 L7。(4)桥代码实际只用了 create、rename、selectModel、prompt、cancel、projections，外加 /permission、/goal 斜杠命令；没用 list、fork、page、follow、control。『已跑通』只能从代码推断，桥的日志在禁区内没有读。
  - 证据：dsh-api-session-controller/lib/index.js:2952（super(ctx,'sessionController',{namespace:'session'})）、:2676-2700（@Remote 清单）
  - 证据：同文件 :755-786（commands.create）、:264-268（createSession）、:416-460（claim：开始过轮次→createMinted 新 id；无存储→createAgent 用该 id）
  - 证据：dsh-api-session-controller/lib/typert.host.js:231（sessionId: Blank Session to reuse… or the identity of a new Session when none is stored under it）、:236（result: may differ from the requested sessionId）
  - 证据：同文件 index.js:3218-3231（prompt 包装：signal.throwIfAborted、source kind 'user'+rpcId）、:925-968（commands.prompt）、:1128-1139（hasPromptRequest）、:221-250（resolve→resume）、:1061-1067（cancel keepInbox）
  - 证据：dsh-agent-loop/lib/index.js:806-821（followup/steer/inject/cancel）、:854-868（wakeDriver 仅在 idle 时开跑）
  - 证据：dsh-typert-protocol/lib/index.js:339-351（TypertRemoteService 继承 Cordis Service，所以能 inject）
  - 证据：dsh-api-session-controller/README.zh.md 概述（『当 Client 需要按 Session 寻址的操作时，请通过 API Gateway 使用它』）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js:46-73；lib/bridge.js:315-389、:563（实际调用的方法）
- **C5：部分成立**。原结论：会话历史可靠落盘：每会话一份只追加日志、每批 fsync，存于 ~/.dsh/sessions/--<规范化cwd>--/<会话id>/，不同 cwd 天然分开；崩溃后读方补写被中断那一轮的收尾；压缩只遮蔽不删除；重启后 prompt 自动 resume，历史跨天跨重启都在；格式迁移只升不降。
  - 核查说明：核心结论成立：jsonl 后端每批 append 都要 handle.sync() 后才返回，失败会回滚；目录是 <root>/--规范化cwd--/<编码id>/，root 为 ~/.dsh/sessions；压缩只遮蔽；prompt 会先 resume 冷会话；迁移链只升不降。漏掉的限制：(1)实时事件先进入 200ms 批处理窗口再落盘。checkpoint 策略只保证在模型请求前、有副作用的工具执行前、下一步开始前刷盘，崩溃可能丢掉最后不到 200ms 的事件。(2)『补写收尾』的实际含义：恢复时由 agent-loop 通过写句柄追加合成收尾（tool/result 错误、step/end、turn/end{interrupted}），被打断的那一轮直接关闭，不会续跑。没有结果的工具调用标为 TOOL_OUTCOME_UNKNOWN，不自动重试。只读观察方只在内存里补齐。所以『历史都在』不等于『醒来接着干』，需要 Agent 中心重新唤醒。(3)项目目录名是有损编码（分隔符替换、截断到 251 字符），不同 cwd 可能共用一个项目目录，会话目录仍按 id 分开。(4)create 之后从没 append 或 flush 的会话不落盘，重启后等于不存在。(5)没有删除接口，日志只增不减。(6)会话被别的进程占着写锁时，prompt 会得到 session/writer-held；已归档的会话即使恢复了，每一步也会被 ArchivedSessionGate 拒绝。
  - 证据：dsh-base/cordis.patch.yml:138-141（root: dshHomePath('sessions')）
  - 证据：dsh-session-persistence-jsonl/lib/index.js:187-193（enqueueLive 200ms setTimeout）、:3299-3326（appendLines writeFile+sync，失败 truncate 回滚）、:875-909（projectKey 注释写明 intentionally lossy，slice(0,251)）、:12（flock）
  - 证据：dsh-session-persistence-jsonl/README.zh.md:77（延迟实体化、每批 fsync、崩溃后由恢复方追加合成 closer）、:164（不支持 downgrade）、:167（不删除会话文件）
  - 证据：dsh-session-persistence/README.zh.md:53（崩溃前从未实体化的会话等于从未存在）、:61（interruptedTurnClosers）、:155（合成 closer 是唯一崩溃方案）
  - 证据：dsh-session-checkpoint-policy/README.zh.md 概述（中断的工具调用以未知结果恢复、不自动重试）；dsh-base/cordis.patch.yml:420-421（已挂载）
  - 证据：dsh-compaction/README.zh.md:12（被遮蔽内容仍保留在日志）
  - 证据：ls /Users/bytedance/.dsh/sessions：12 个 --…-- 目录（只看了名字）
- **C8：成立**。原结论：dsh-agent-instructions（standard 预设内）把 ~/.dsh/AGENTS.md、~/.agents/AGENTS.md 及项目根（.git）到 cwd 每层的 AGENTS.md/CLAUDE.md/AGENTS.local.md/CLAUDE.local.md 作为持久基线放进首次请求，预算 65,536 字节；read/write/edit 碰到后改动刷新进后续请求，恢复会话也对账；Ralph 明确工作区是唯一跨轮长期记忆。
  - 核查说明：lib 和 README 都支持。补充几个条件和一个对你有利的发现：(1)在桌面和 Web 组合里，dsh-base 的那一行被禁用（web-app/cordis.patch.yml:578-579），注入能力来自预设：standard、cordis、ptc 预设挂了它，minimal 没挂，自定义预设要自己加。所以证据里的 base:306 对桌面不生效。(2)只认 AGENTS.md、CLAUDE.md、AGENTS.local.md、CLAUDE.local.md，全局两处只认 AGENTS.md；memory.md、journal.md 不会自动注入。(3)README 写明刷新靠 touch：只有内置 read/write/edit 成功、会话恢复、或基线被遮蔽后重建时，才会带上改动。用 bash 改文件，或者别的进程、插件改文件，都不算 touch。代码里每次 agent/pre-step 似乎还会对基线链文件 stat 并比较版本（lib:1021-1140），比 README 说的更积极；未实测，保守起见按 README 理解。(4)有利的发现：基线消息被压缩遮蔽后，下一次 pre-step 会重新注入（lib:1197-1203 只在可见 surface 里找基线；README.md:220『restores a shadowed baseline』）。所以写在 AGENTS.md 里的人设和长期目标能扛过压缩，代价是重新注入时多付一次 token，并打断前缀缓存。(5)往上找不到 .git 时，项目根就是 cwd（lib:574-579）；上级目录有 .git 时，从上级到 cwd 每一层的 AGENTS.md 都会带上。(6)超出预算时先丢较宽泛的文件，最具体的文件会被截断。(7)Ralph 那句出自 dsh-tool-ralph 的『已知限制』，说的是 Ralph 子 agent 轮次之间的情况，不是通用设计声明。(8)当前 ~/.dsh/AGENTS.md 和 ~/.agents/AGENTS.md 都不存在。
  - 证据：dsh-agent-instructions/lib/index.js:17-18（候选文件名）、:161-168（USER_GLOBAL_DIRECTORIES、USER_GLOBAL_FILE='AGENTS.md'）、:574-579（找不到标记回退为 cwd）、:1197-1203（visibleBaselineSource 只看可见 surface）、:1210-1214（触发 touch 的只有 read/write/edit）、:1406-1424（每个 agent/pre-step 都 compose）
  - 证据：dsh-agent-instructions/README.md:219（bash 不触发发现）、:220（Refresh is touch-driven… or when an entering pre-step restores a shadowed baseline）；README.zh.md「agent 获得的内容」「观察预算」
  - 证据：dsh-web-app/presets/standard.patch.yml:15-18（maxBytes 65536）；dsh-web-app/cordis.patch.yml:578-579（base 行 disabled）；presets/minimal.patch.yml 不含 agent-instructions，cordis/ptc 含
  - 证据：dsh-tool-ralph/README.zh.md:36、:163（位于『已知限制』）
  - 证据：ls：/Users/bytedance/.dsh/AGENTS.md、/Users/bytedance/.agents/AGENTS.md 均不存在
- **C9：成立**。原结论：自建插件可用 ctx.storageDomain.open({name, version, layout:'per-record', invalidRecords:'backup-and-skip', tables:{bots:{valueSchema}}}) 建机器人注册表；读为同步内存读，写落盘后完成并发 domain/changed；数据在 json 后端 ~/.dsh/storages；defineDomain 只校验后原样返回，所以不 import @deepseek-ai 包、手写同形对象加 zod 也能用。
  - 核查说明：lib 确认：domainTable 只返回 {valueSchema}；defineDomain 校验后原样返回；open 加载时逐条调用 valueSchema.parse；per-record 写入走『临时文件 + fsync + rename + fsync 目录』；写操作先落盘、再改内存、再发 domain/changed；provide('storageDomain')。补充陷阱（读者第 3 问里『版本号一变就拒绝打开』需要改）：(1)open 不调用 defineDomain，手写 spec 时 version 和 global 的检查会被跳过。名字和表名由 storage-json 校验，须符合 ^[a-z][a-z0-9_]*$；记录键须符合 [a-zA-Z0-9_-]+。(2)同名 domain 在进程内只能 open 一次，否则报 already-open。插件热重载时必须在 ctx.effect 的清理函数里 close，否则重载会失败。(3)『版本号一变就拒绝打开』只对 single 布局成立。per-record 布局下，版本戳不在 version 加 compatibleVersions 范围内的记录会被静默当作不存在：改了版本又没写 compatibleVersions，注册表会『变空』，但文件还在磁盘上。(4)backup-and-skip 只在 per-record 布局下有效，因为只有 PerRecordJsonUnit 实现了 backupRecord；single 布局遇到坏记录仍会直接失败。(5)没有跨进程写锁；domain/changed 走 ctx.emit，只在本进程可见。(6)valueSchema 只要有 parse() 方法即可，zod 是官方的用法；profile 里确有 zod（只 ls 了名字）。(7)默认路由来自 dsh-base；用户自己的 ~/.dsh/cordis.patch.yml 在禁区内没有读，理论上可以改路由。
  - 证据：dsh-storage-domain/lib/index.js:46-48（domainTable）、:61-76（defineDomain）、:257-263（put 不校验，先 putRecord 再写内存）、:355-356（already-open）、:371-373（valueSchema.parse 与 backup-and-skip 条件）、:449（provide('storageDomain')）
  - 证据：dsh-storage-json/lib/index.js:25-41（writeAtomic：fsync+rename+fsync 目录）、:102（single 布局 version-mismatch）、:146-160（per-record 版本戳不符读作缺席）、:302（SAFE_KEY_RE）、:353-355（acceptedStamps）、:479（只有 per-record 单元有 backupRecord）
  - 证据：dsh-storage-json/README.zh.md:141（没有跨进程写锁）
  - 证据：dsh-schedule/lib/index.js:9（import zod）、:1675-1690、:1997
  - 证据：dsh-base/cordis.patch.yml:177-192；ls /Users/bytedance/.dsh/storages（schedule.json、session_projcache、workspace.json）；ls profile node_modules 有 zod
- **L1：成立**。原结论：桌面版宿主对外不可达：Electron 子进程固定 --host 127.0.0.1 --port 0；启动 token 每进程随机、只经 IPC 交给 Electron、不落盘；dsh:// 只支持 dsh://open；没有外部触发入口。远程只能自写宿主内插件开通道，或另起 Web 宿主。
  - 核查说明：代码确认无误。补充：(1)启动 token 不落盘，但 cookie 签名密钥（client-connection/browser-session 凭据记录）持久化在 $DSH_HOME/.credentials.yaml。cookie 有效期 30 天，绑定 host:port。桌面版每次启动端口随机，所以没有官方入口；但本机同一用户下的进程理论上可以凭磁盘上的密钥伪造 cookie。这属于安全风险面，不是可用的接口。(2)Electron 断开 IPC 时，宿主进程会自行 stop（desktop-host lib:325）。退出 App 就等于所有机器人停摆（与 R9 相关）。(3)second-instance 事件也只是聚焦窗口，不读启动参数。(4)用户自己的 cordis.patch.yml 能否覆盖监听地址没有核实，在禁区内。
  - 证据：dsh-desktop-host/lib/index.js:232-241（--no-open --host 127.0.0.1 --port 0）、:325（process.once('disconnect', stop)）、:342-347（authenticatedUrl 经 process.send）
  - 证据：dsh-client-connection/lib/index.js:273（AUTH_RECORD_KEY）、:294-300（processLaunchToken 进程内随机）、:391-402（initializeSecret 持久签名密钥）；dsh-client-connection/README.zh.md:43（密钥持久化到 $DSH_HOME/.credentials.yaml，cookie 30 天，绑定 hostname 和 port）
  - 证据：dsh-src/_app/main.js:8229-8237（authenticateWebHost）、:12190-12192（hostUrl=ready.url）、:13055-13058（只处理 dsh://open）、:7659-7663（second-instance→focusOwner）
- **L2：部分成立**。原结论：每会话只允许一个进程写（session.lock flock）。桌面持有在线 agent 时，ACP/SDK/headless/另一 Web 宿主 resume 或 prompt 会得到 session/writer-held；外部进程开的会话在桌面只能刷新看冷历史。所以一个机器人只能有一个运行宿主，推荐桌面版内插件。
  - 核查说明：单写者锁、writer-held 映射、桌面看不到外部进程的实时过程，这三点都在代码里确认了：follow 只订阅本进程的 session/event。偏差与漏项：(1)session/writer-held 是桌面和 Web 宿主（session-controller）给的错误码。ACP、SDK、headless 走各自的错误：SDK 服务端注释写的是『Rejects … already owned sessions』，ACP 的 lib 里没有 writer-held 映射。(2)更关键的漏项：桌面 UI 只要打开（follow）一个冷会话，就会在后台 promote，也就是把它 resume 成在线 agent 并拿走写锁（lib:1586-1589、:3006）。所以只是在桌面里点开看一眼，外部驱动就会被挡住；外部进程占着锁时，在桌面打开会报 api-session/error。没找到空闲 agent 的自动回收，写锁何时释放取决于 agent 何时被释放（未穷尽）。(3)持有锁的进程如果还活着但卡死了，会一直挡住其他写入方，直到该进程退出。『一个机器人只选一个运行宿主』的结论成立，而且比读者说的更严格：连『在桌面里只读围观外部机器人』也会抢锁。
  - 证据：dsh-session-persistence-jsonl/README.zh.md:168（内核 flock 排除其他所有实例与进程；活着但卡死的持有者会一直阻塞）
  - 证据：dsh-api-session-controller/lib/index.js:243（SessionAlreadyOwnedError→session/writer-held）
  - 证据：同文件 :1510-1535（follow 只监听本进程 session/event）、:1586-1589（prepared 冷会话在快照后调用 this.promote）、:2967-2968、:3006-3025（promote→resolveObservedAgent 后台激活）
  - 证据：dsh-session-query/lib/index.js:455 与 README.zh.md:110（prepared 即冷路径观察）
  - 证据：dsh-sdk-jsonrpc-server/lib/index.js:169（Rejects missing, unreadable, or already owned sessions）；grep dsh-acp/lib 无 writer-held 映射
  - 证据：/Users/bytedance/.claude/skills/drive-dsh/references/gotchas.md:14（第 9 条，用户经验）
- **L3：部分成立**。原结论：没有现成长期记忆插件；压缩有损：只保留一次调用产出的英文摘要，推理、工具参数、原始结果都丢；多次压缩合并旧摘要、丢陈旧事实；每次压缩多发一次接近满窗口请求；按 4 字符/token 估算、中文低估；压缩只在单会话内有效。
  - 核查说明：已确认：压缩用一次额外的模型调用，只保留返回的英文结构化 checkpoint；多次压缩会合并旧摘要、丢弃陈旧事实；308 个包里没有 memory 包；token-meter 里 CHARS_PER_TOKEN=4。需要修正：(1)『每次压缩都多发一次接近满窗口的请求』说过头了。standard 预设挂了 tool-result-pruner，修剪后够用就会跳过摘要调用；摘要请求也会复用会话的前缀缓存。另一方面，compactionRetries 默认为 1，上下文溢出恢复还会再压一次，最坏情况下一次压缩不止调用一次。摘要输入大约是『系统提示词 + 被遮蔽区间』，约占窗口的 64%–80%。(2)4 字符/token 只是兜底估算。只要请求 envelope 与上次相同，就以模型返回的实际用量为锚，只有新增部分按启发式估算。中文被低估主要会让压缩触发偏晚，由溢出恢复兜底。(3)『原始结果都会丢』只对模型能看到的上下文成立，原事件仍在磁盘日志里。开启实验包『会话搜索』后，模型可以用 session_event_search 和 session_event_read 回查本会话更早的事件。AGENTS.md 基线被遮蔽后还会自动重新注入（见 C8）。(4)摘要规则要求逐字保留文件路径、命令、错误串、标识符、数值等，不只是空泛的概述。影响判断仍然成立：关键事实要外置到记忆文件，压缩会额外消耗额度。
  - 证据：dsh-compaction-basic/README.zh.md 概述（一次额外模型请求，只保留返回的摘要文本）、「修剪超大工具输出」（修剪后在阈值内就跳过摘要）、配置表（compactionRetries=1、maxOverflowRetries=1）、「KV Cache 影响」（复用热前缀）、压缩指令 Rules（English、保留精确路径/命令/错误串，合并旧摘要、丢弃陈旧事实）
  - 证据：dsh-web-app/presets/standard.patch.yml compaction 组（compaction-basic + tool-result-pruner）
  - 证据：dsh-token-meter/lib/index.js:16（CHARS_PER_TOKEN=4）；dsh-token-meter/README.zh.md:12、:43（envelope 相同时复用提供方用量，否则才估算）、:154
  - 证据：dsh-compaction/README.zh.md:12（被遮蔽内容保留在日志）；dsh-tool-session-query/README.zh.md:48（session_event_search 可查当前会话）
  - 证据：ls dsh-src/@deepseek-ai：无 memory/recall 类包；dsh-tool-ralph/README.zh.md:163
- **L7：部分成立**。原结论：宿主服务是内部 API、无稳定性承诺，已出过破坏性变化（0.2.1-rc.2 起 typertGateway.invoke 必须带 Peer）；第三方插件不能从 profile node_modules 引入 @deepseek-ai/dsh-* 运行时包，否则遮蔽内置构建、每次工具调用都崩；Client 的 Remote 命名空间构建时固定，插件没法往 ctx.remote 加命名空间；前后端只能走自有 fetch 路由。
  - 核查说明：已确认：Gateway 每次调用都必须带 Peer，README 和 lib 里的 assertPeerLive 都能对上；api-remotes 写明能力集合由构建时的导入决定，不会在运行时发现；没找到官方对 Host 服务的稳定性承诺，app-boot 只对 config dump 和 schema 标了 pre-stable。需要修正：(1)『0.2.1-rc.2 起』这个时间点只来自你自己桥的注释，发布包里核实不了。(2)遮蔽问题的证据是你装的 dsh-taskboard 里的注释，而且只针对 dsh-tools，不是官方文档。官方 app-boot README 写的解析规则是：插件 package.json 里声明为 peerDependencies 的 @deepseek-ai/dsh-* 包会解析到运行时自带的版本；物理安装进 profile 的副本则可能变成 profile 级映射。所以准确的说法是『声明为 peer，不要把物理副本装进 profile』，而不是『完全不能 import』。现状：profile/node_modules/@deepseek-ai 下已有物理安装的 cosmokit 和 schemastery，影响未验证。(3)『插件没法往 ctx.remote 加新命名空间』说得太绝对。运行时存在 ctx.remote.$mount(contribution)，dsh-api-remote-access 就是单独挂载自己的贡献；但贡献需要 Typert 生成的描述符，第三方能不能走通未验证。(4)『前后端通信只能走自有 fetch 路由』不对。Client 插件可以直接调用官方 namespace：dsh-context 注入了 remote.session，dsh-taskboard 调用了 session.modelCatalog 和 agentPresets.list。只有自定义数据（比如机器人注册表）才需要自建 webServer 路由，taskboard 的 routes.ts 就是这么做的。读者给的建议仍然成立：做一层适配层、对服务做防御式探测、每次升级后跑冒烟测试。
  - 证据：dsh-api-gateway/README.zh.md:33（peer 必填，Gateway 从不提供默认 Peer）；dsh-api-gateway/lib/index.js:963、:983（assertPeerLive）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js:19-24（rc.2 说法的唯一来源）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/sdk.ts:1-20（只说 dsh-tools）；dsh-app-boot/README.zh.md:52、:134、:138（peer 名解析到运行时包、物理候选与 profile 映射规则）
  - 证据：ls /Users/bytedance/.dsh/profiles/desktop/node_modules/@deepseek-ai：cosmokit、schemastery
  - 证据：dsh-api-remotes/README.zh.md:77-78；dsh-api-gateway/lib/types/client/index.js:88-93（$mount）；dsh-api-remote-access/lib/types/client/mount.js（单独 mountAccess）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js（e.inject(['remote','remote.session'],…)）；dsh-taskboard/lib/client.js（remote.session.modelCatalog、agentPresets.list）；dsh-taskboard/src/host/routes.ts:1-12（自建 webServer JSON+SSE 路由）

## 核查员补充（读者漏掉的点）

- 在桌面 UI 里打开一个冷会话，会自动把它恢复成在线 agent（promote）并拿走写锁，之后一直驻留在内存里。没找到空闲 agent 回收机制，也没找到在线 agent 数量上限。几十个机器人被逐个点开查看后都会常驻；外部驱动器（ACP、headless、另一个宿主）会因此被挡住。
  - 证据：dsh-api-session-controller/lib/index.js:1586-1589（follow 发完快照后对 prepared 冷会话调用 this.promote）
  - 证据：同文件 :2967-2968、:3006-3025（promote→agents.resolveObservedAgent 后台激活）
  - 证据：在 dsh-agent、dsh-api-session-controller 里 grep evict/idle/maxLive 无结果（只能说明没找到）
- 归档可以当『硬暂停』用：ArchivedSessionGate 在 agent/pre-step 拒绝已归档会话及其子代理的每一步。定时唤醒和迟到的投递照样会送达，但这一轮会以 blocked 结束，不发出模型请求；取消归档即可恢复。prompt 本身不会拒收，所以 Agent 中心要自己把『已归档』标成『暂停』，否则用户会以为唤醒失败了。
  - 证据：dsh-api-session-controller/lib/index.js:2508-2530（ArchivedSessionGate、underArchivedSession）
  - 证据：dsh-api-session-controller/README.zh.md:75
- 崩溃、强退，或宿主随 Electron 一起退出时，正在跑的那一轮不会续跑：恢复时追加合成收尾（turn/end interrupted），没完成的工具调用标为 TOOL_OUTCOME_UNKNOWN，且不自动重试。Agent 中心需要在宿主启动后找出『上次被打断』的机器人，主动补发唤醒。
  - 证据：dsh-session-persistence/README.zh.md:61、:155（合成 closer 是唯一的崩溃处理方案，不续跑）
  - 证据：dsh-session-checkpoint-policy/README.zh.md 概述
  - 证据：dsh-desktop-host/lib/index.js:325（Electron 断开即 stop）
- 只 create、还没成功 prompt（或 flush）的会话不会落盘，崩溃或重启后就像从没存在过。机器人注册表应该在第一次 prompt 被接受之后再登记 sessionId。
  - 证据：dsh-session-persistence/README.zh.md:53
  - 证据：dsh-session-persistence-jsonl/README.zh.md:77（create 不写任何内容，第一次 append 才真正写盘）
- 会话日志永不删除、只追加，压缩也只是遮蔽不删除。一个机器人长期用同一个会话，日志会无限增长；冷读、恢复和逐事件回查都要读整份日志（这是推断，未压测）。建议按周期（比如每周）给机器人换新会话，用记忆文件交接；官方没有删除接口，磁盘清理也要自己规划。
  - 证据：dsh-session-persistence-jsonl/README.zh.md:167（不删除会话文件，seam 没有删除接口）
  - 证据：dsh-compaction/README.zh.md:12
  - 证据：dsh-session-query/README.zh.md:110（冷路径经句柄重新加载）；dsh-session-query/lib/index.js:1152-1168（filterEvents/readSurface）
- R8 的数据面大部分现成可用：前端（Client）插件可以直接调用官方 ctx.remote.session 的 list、projections、control 流，以及 agentPresets。投影里有 tokenUsage（uncachedInput、output、cacheRead、cacheWrite，重试另计）、sessionStats、turnOutline、goal、inbox。要注意三点：tokenUsage 统计的是 token，和订阅的『5 小时额度』如何换算未知；列表里冷会话的投影来自节流写回的缓存（每 200 个事件或每 5 秒），可能滞后；要拿准确值得调用 projections()。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js（inject remote.session）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/lib/client.js（remote.session.modelCatalog、agentPresets.list）
  - 证据：dsh-token-meter/README.zh.md:49；dsh-session-stats/README.zh.md 概述
  - 证据：dsh-base/cordis.patch.yml:196-200（session-projection-cache writeEveryEvents 200 / writeIntervalMs 5000）
  - 证据：dsh-api-session-controller/README.zh.md「使用本包」（projections 读取准确基线）
- 你已装的 dsh-context 自带两个页面：跨会话的『上下文洞察』页（每个会话的 billed tokens、估算成本、缓存命中率、7 天用量图、按工作区分组的会话卡片）和 Fleet 页（只覆盖同一会话家族里的父代理和子代理）。它们可以作为 Agent 中心『消耗』视图的起点或参考。另外，它的『System Prompt 前缀/后缀』会加到所有 agent 的系统提示词里，没法按机器人区分。以上只读了 README，没核对它的 lib。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/README.md:16、:52、:58-74（上下文洞察）
  - 证据：同文件 :18、:181-203（Fleet 页，只覆盖本会话家族）
  - 证据：同文件 :219（前缀/后缀注入所有 agent）、:227（往 dsh 投影缓存写每会话摘要）
- 开启实验包『会话搜索』后，5 个工具 schema 和一段固定指引会加进所有预设（包括 minimal）里所有 agent 的每一次请求，几十个机器人都会持续多付这部分 token。检索范围限于 cwd 字符串完全相同的会话；索引放在内存里，重启后要重建。
  - 证据：dsh-experimental-session-search/README.zh.md「使用此包」（所有预设包括 minimal 都生效）、:70
  - 证据：dsh-tool-session-query/README.zh.md:12（每次请求增加固定指引与五个工具 schema）、:53（cwd 严格相等）
- 新会话的第一条『人类』消息会触发一次额外的模型调用来自动生成标题（dsh-base 挂了 first-prompt-llm 标题提供方）。插件经 sessionController.prompt 发出的消息 source.kind 是 'user'，会被当成人类消息。建完会话先 rename，用户来源的标题会把会话『钉住』，之后不再自动改标题，大概率能省掉这次调用（未实测）。
  - 证据：dsh-base/cordis.patch.yml:60-68（session-title 与 session-title-first-prompt-llm）
  - 证据：dsh-session-title/README.zh.md:32（只有人类 user/message 符合条件；用户来源标题钉住会话）
  - 证据：dsh-api-session-controller/lib/index.js:3218-3231（prompt 构造的 source kind 为 'user'）
- 实验包 Agent Teams（默认关闭）提供『Lead + 具名 teammate』、成员间直接消息、持久的共享任务板，还能冷恢复 teammate。但它只支持同一个共享工作区，不能跨进程协作，也不会自动释放任务 owner。适合『一个总管带一组手下』，不等于多个各有目录和目标的独立机器人。可以作为 R6 协作的参考。
  - 证据：dsh-experimental-agent-team/README.zh.md:12、:32（不支持独立工作目录、跨进程协调）、:68（不在重启后重试新消息）
  - 证据：dsh-experimental-agent-team-profile/README.zh.md 概述（默认关闭，开启后禁用普通 subagent 委派）

## 缺口与补法

- [R4｜工作量 M] 没有内置的长期记忆；压缩有损（只留英文摘要，越压越粗），而且只在单个会话内有效。
  - 补法：先定约定，不用写代码：每个机器人一个独立 cwd（会话也就按 cwd 分目录存放），稳定的人设和长期目标写进 AGENTS.md（自动注入），进展、教训、待办写进 memory.md/journal.md；在 /goal 目标和定时唤醒提示词里写死「开工先读记忆、收尾更新记忆」。可选再写一个小插件，在 agent/turn-stopping 时检查记忆文件是否改过，没改就 steer 一句提醒。
- [R4｜工作量 M] 全文搜索默认关闭、中文分词差、模型工具还是实验性，机器人很难按关键词翻自己的旧账。
  - 补法：自写一个 recall 工具（插件注册给模型）：用 ctx.sessionQuery.filterSessions 按本机器人 cwd 限定范围，再用 filterEvents 的字面文本子句扫描，中文子串也能命中；或者让机器人在记忆文件里自己维护「主题→日期→会话」索引。偶尔需要时，可以在提示词里 @ 引用旧会话（dsh-session-reference）。
- [R8｜工作量 M] 没有「机器人」这一层的聚合接口：会话列表是一个会话一行，没有目标、预算、下次唤醒的汇总视图。
  - 补法：自写宿主插件做数据面：用 storageDomain 存注册表；订阅 session/event、api-session/status、agent/error、schedule/changed，维护内存快照；按需调 projections（goal、tokenUsage、sessionStats、turnOutline）和 ctx.schedule.list 补齐；再通过 connection.fetch.register 暴露给前端页（页面另一路负责）。也可以注册一个自定义投影单元，让状态直接跟着会话行走。
- [R7｜工作量 S] tokenUsage 漏算压缩摘要等辅助调用，按它做预算会低估。
  - 补法：插件在监听 session/event 时，把 compaction/summary 的 usage 也累进去；预算闸门挂在 agent/pre-step 上，超额就拒绝下一步。
- [R8｜工作量 L] 桌面版宿主对外不可达，手机看不了也唤起不了机器人。
  - 补法：首选：宿主内插件把日报和告警推送到飞书（手机看），再从外部通道取指令后调 sessionController.prompt（入站通道要么用同步文件夹，要么在插件里起飞书事件订阅子进程，需要另行验证）。备选：用 Tailscale 等让手机进同一私网，跑独立的 dsh web 加 TLS；但它和桌面版不能同时用同一个 DSH_HOME，也看不到桌面版的实时过程。
- [R1｜工作量 S] create 不带权限和模型参数；preset 只能用 bundle 补丁定义，没有运行时新建 preset 的 API。
  - 补法：创建流程照搬桥的做法：create→rename→/permission→selectModel→prompt→/goal。人设差异全部放进各自 cwd 的 AGENTS.md；工具差异只做少数几个 preset，用 bundle 一次装好，按机器人类型复用。
- [R10｜工作量 S] 宿主服务没有稳定性承诺，nightly 升级会改接口；插件不能 import @deepseek-ai 运行时包。
  - 补法：所有宿主调用收进一个适配层，对服务名和方法做存在性探测与降级（参考 dsh-context）；storageDomain 的 spec 手写，不 import；升级后跑一套冒烟脚本（建会话→prompt→读 projections→cancel）。
- [R5｜工作量 L] 非 owner 的只读远程访问没有内置策略（比如给别人看看板）。
  - 补法：写 dsh-api-remote-access 的 policy，配合自建非 owner Peer 的页面注入，工作量大。更现实的做法是不开放宿主，只推送摘要到飞书或文档。
- [R4｜工作量 S] 会话日志只增不删；一个机器人一个会话跑几个月，冷读、搜索和重建成本会持续增长。
  - 补法：按周或按月轮换机器人会话：新会话从记忆文件冷启动，注册表记下新旧 sessionId；旧会话归档（归档后官方门禁也会挡住迟到的唤醒）。

## 可调用的宿主接口

- `ctx.sessionController.create / prompt / cancel / list / projections / rename / selectModel / fork / control`：机器人生命周期的主入口。建会话：create({cwd|workspaceId, agentPreset, sessionId})；唤醒或派活：prompt({sessionId, requestId, mode:'queue', content:[{type:'text', text}]}, AbortSignal)；中断：cancel({sessionId})；看板取数：list({}, signal) 加 projections({sessionId}, signal)；control() 是实时投影流。prompt、list、projections、search 都要传 AbortSignal。
- `ctx.agents 与 Agent 句柄（followup / steer / inject / cancel / whenIdle / status）`：对在线 agent 做细粒度控制：inject 往下一步塞记忆摘要但不唤醒；whenIdle 等这一轮彻底结束；status 读 idle|running。get、list、roots 列出在线 agent。
- `事件 session/created、session/event、session/disposed`：监听所有会话的每条已提交事件，如 assistant/message、turn/end、approval/asked，用来维护「最近产出、状态机、审计」。你的桥就是这样做的。
- `事件 agent/status、agent/error、api-session/added|removed|status|activity|error`：在线状态变化、错误和活动时间推送给看板。api-session/* 由会话控制器发出，并已转发给客户端。
- `agent/pre-step、agent/turn-stopping`：pre-step 能拒绝即将开始的步骤，可用来做预算闸门或一键暂停，官方 ArchivedSessionGate 就是用它挡住已归档会话的迟到唤醒。turn-stopping 在轮次将要结束时运行，可以 steer 一句「先更新记忆文件」让轮次继续。
- `ctx.sessionQuery（listSessions / filterSessions / filterEvents / readSurface / observeSession / traceSession / searchSessions）`：冷读任何会话，不激活 agent：按 cwd 找到某个机器人的全部历史会话，做字面扫描式 recall，或取最后一条 assistant/message。
- `ctx.sessionProjections.register / snapshot / stateOf / onChanged`：注册自定义投影单元，从会话事件折叠出「机器人状态」。带 wire 块时，这个状态会随 list 行和 projections/control 一起送到客户端。
- `ctx.storageDomain.open(spec) 与 domain/changed`：建 agent_center 一类的注册表或预算表：机器人 id 到 sessionId、cwd、preset、目标、预算、状态的映射。
- `ctx.commands.execute(agent, '/permission …' | '/goal …' | '/goal clear', [], signal) 与 ctx.permissionPresets.set(session, name)`：设置机器人的权限档位，武装或清除长期目标。
- `ctx.schedule.create / list / catalog 与 schedule/changed`：给机器人会话挂定时唤醒（到点以 follow-up 形式投递回原会话），看板从这里读下次唤醒时间（nextScheduledAt）。
- `ctx.workspaceRegistry.create / list`：把机器人会话归到某个工作区（例如「机器人」），侧边栏就能分组显示。create 用 workspaceId 时会自动加入该工作区。
- `approval/request（waterfall 应答者）`：自写按 agent 限定作用域的审批应答者，对无人值守的机器人按白名单自动放行或拒绝；没有最终应答者时请求按 unavailable 拒绝。
- `ctx.connection.fetch.register({path, methods, requestBody, fetch})`：给 Agent 中心前端页开 /api/agent-center/* 一类的数据接口，仅 owner 可用。
- `ctx.compaction.compactNow(agent, signal)`：在夜间等空闲时段主动压缩，避免白天在轮次中途触发。桌面版的压缩服务在 preset 作用域里，可能要经 agent.ctx 取（未实测）。
- `外部进程：dsh --profile acp / sdk / headless（CLI 位于 /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh）`：不需要在桌面版里围观的后台机器人，或给 Claude Code、launchd 用的标准驱动接口。会话同样落在 ~/.dsh/sessions。

## 读者留下的未决问题

- macOS 下关掉所有窗口后 App 仍在运行，但没有在线的 owner 客户端时，approval/request 是一直等待，还是立即以 unavailable 拒绝？未核实。这决定了无人值守的机器人遇到审批会不会卡住。
- 几十个 agent 常驻同一个宿主进程时内存和 CPU 开销多大？有没有空闲 agent 自动卸载机制？README 没提。
- GLM 路由（经 dsh-llm-pi-ai）遇到上下文溢出时，会不会被规范化成 CONTEXT_WINDOW_EXCEEDED？如果不会，溢出恢复就不会触发。README 只说两个 DeepSeek 适配器会做这种规范化。
- ACP 或 SDK profile 能不能直接复用桌面版已登录的 GLM 凭据？base 挂了 credentials-local，但未实测。
- unicode61 对中文的实际切分效果需要实测；本报告的结论是按 SQLite 分词规则推断的。
- 标题生成等辅助模型调用的 usage 有没有写进会话日志、有没有计入任何投影？未核实。
- 订阅的 5 小时额度还剩多少，宿主侧有没有接口能读？本路未查（dsh-deepseek-account 系列不在阅读范围内）。
- 被定时任务或插件唤醒的轮次（source 不是人类 user）在 turnOutline 里提示词预览为空。看板的「最近产出」需要改用回复预览，或自己从事件里取。
- ctx.sessionController 的方法签名在后续 nightly 里会不会保持？官方没有稳定性承诺，只能每次升级后回归测试。
