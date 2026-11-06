# 底稿：插件扩展模型与已有插件先例（R8、R10）

> 研究底稿（2026-11-04，DSH 桌面版 0.2.1-rc.5）。先由一位读者细读官方插件说明与源码，再由另一位核查员逐条尝试推翻承重结论；「核查」一节里的修正优先于「读者结论」。证据路径中的 `dsh-src/` 指从安装包只读解出的官方插件源码，可用 `tools/asar_extract.py` 重新解出。

## 读者总结

DSH 几乎所有功能本身就是插件，第三方组合包可以同时带两半。「宿主半边」在 DSH 进程里开会话或接着老会话跑、注册工具、挂定时器、开 HTTP 接口；「界面半边」在左侧栏加一个与「插件」「自动化任务」同级的独立页面。dsh-taskboard 的代码已经证明「每张卡开一个真实会话、每分钟检查一次到期任务（tick）、跑完自动结算」这条路走得通，所以 R8 的 Agent 中心页和 R10 用插件补缺口在技术上可行。现成零件里没有「机器人」这个概念：机器人档案、长期目标、预算、互发消息、总览页都得自己写。官方 Agent preset（工具和人设的组合）也没有运行时写接口，不能「一个机器人一个 preset」地批量生成，只能由中心插件自己存机器人档案，开会话时注入。最大的风险是接口不稳定：305 个官方共享包与 App 同号（0.2.1-rc.5），走 nightly 通道，还有强制更新；你自己的看板和桥都因为会话格式、网关参数变化坏过。官方的版本闸门只看插件顶层的 engines.dsh 或 peer 声明，hostProtocolVersion 不参与判断。另外，宿主进程里任何一个定时器的异常没被兜住，整个 DSH 都会退出，所以中心插件的调度器必须层层兜底。建议分两步：先用现有看板的「定期执行 + 复用会话」卡片零代码验证主动机器人；正式版另起一个以机器人为中心的插件，复用看板（Apache-2.0 许可）的执行和调度代码，不直接改看板。

## 逐题回答

**问题 1**

需要一个「组合包」，也就是一个 npm 包目录，里面分四块。
①清单：package.json 声明 dsh.bundle.patch、dsh.client、exports（./client、./locale/*.json、./icon），并在顶层写 engines.dsh；cordis.patch.yml 插入一行本插件。模板见 cordis-plugin-development/templates/decoration。
②宿主半边（host plugin，即 index.js 里的 apply）：存机器人档案；定时检查谁该醒（tick）；执行器用 ctx.agents.create / resume 开会话，先 inject 再 followup，whenIdle 后结算；用 ctx.webServer.register 给界面开 HTTP 接口；用 ctx.tools.register 给机器人注册模型工具（汇报、求助、给别的机器人留言）；用 ctx.systemPrompt.section 加协议提示词段；可选斜杠命令；再加 Config（并发、默认模型、预算阈值）。模型工具就放在这里，不需要单独的包。
③界面半边（ui plugin，即 client.js，用 window.__ModuleLoader__.load 注册，React 由宿主提供）：总览页挂在左侧栏一级入口 + 中栏全局页（sidebar.panellist + main），和「插件」「自动化任务」同级；单个机器人详情做成右侧栏 tab 类型（只在选中会话时有）。另外还能挂在：会话页头（conversation.session.header.utilities）、侧栏会话行（sidebar.session.row.leading / hover）、对话流（conversation.chat.turnTail）、输入框上方（conversation.composer.dock）、底栏 shell.bottom、浮层 shell.overlay、插件页配置页（plugins.bundle.config）。
④MCP bundle 不是中心本身必需的。只有要接飞书等外部服务时，才加一个只含配置的组合包（插入 @deepseek-ai/dsh-mcp-client 行）。
Agent preset 是可选项，只做少量「角色模板」。没找到插件开独立原生窗口的接口（不确定）。官方不建议用 iframe 嵌页面。

**问题 2**

实现方式（代码已确认，位于 /Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src）：宿主入口 index.ts 先注册 10 个 taskboard_* 工具和协议提示词段，再按 workspaceRegistry、agents、webServer 的顺序逐层接入服务。
①每张卡一个真实会话：execution.ts 调用 agentCtx.agents.create，参数包括 sessionId、meta 里的 cwd 与 agentPreset、agentOptions 里的 provider / model / reasoningEffort，setup 用 agentPresets.mount 装上 preset。随后 attachSession 挂到项目，permissionPresets.set 设权限，sessionTitle.rename 改标题。然后先 agent.inject 一条看板框架说明（source.kind 为 'dsh-taskboard'，不叫醒），再 agent.followup 卡片正文（叫醒），两条合成一轮。
②续跑：定期卡默认复用上次的会话。scheduled-session.ts 只在老会话空闲、且 cwd、preset、模型都一致时用 agents.resume 接上；会话忙、已归档或损坏就新开。界面上的「↻ 续跑」还能沿用原来的 worktree。
③所谓「自动验收」其实是自动结算：whenIdle 后收集 git 证据；如果 agent 没按协议交接，就自动移到「待验收」并留一条系统评论；turn/end 带错误则判失败、退回待办。done 只能由人点（tools.ts L621-622 的代码闸门）。当前版本没有「自动验收裁判」。drive-dsh 技能里说的旧看板（task_board_* 工具、~/.dsh/task-board/ledger-v2.json）不是现在装的这个。
④调度器：scheduler.ts 每 60 秒 tick 一次，启动后立刻补跑一次。到期任务先写进持久的先进先出队列，再按全局并发上限（默认 3）和派发间隔（默认 1 秒）逐个放行；同一时间只允许一次 tick 在跑，异常用 catch 兜住。宿主重启时，reconcile 会把上个进程留下的「运行中」任务标为失败、退回待办。
用到的宿主 API：tools、systemPrompt、workspaceRegistry、session/event、agents（create / resume / get）、sessions、sessionPersistence.stat、agentPresets（resolve / mount / list）、agentDefaultModel、permissionPresets、sessionTitle、llm（listProviders / listModels）、skills.list、commands.list、webServer.register。界面用 slots（sidebar.panellist + main）和 layout.selectPanel，旧版界面回落到 DOM 注入；数据走它自己的 /dsh-taskboard 路由 + SSE。
离 Agent 中心还差：没有「机器人」实体（人设、长期目标、自评、何时停、何时求助）；没有按机器人看的总览；没有用量预算和暂停；没有机器人之间互发消息；记忆只靠复用同一会话。此外，agent 能用 taskboard_create / update 把卡片权限设成 danger-full-access，代码里没有用户确认；定期卡默认每轮新生成一张卡，长期跑会堆卡。
建议不直接改它，原因有三：数据模型对不上；上游是第三方作者，0.8.x 还在快速迭代，改了会和更新冲突；界面带着旧的 DOM 注入包袱。分两步走：先零代码，用它的「定期执行 + 复用会话 + 完成后移回待办 + 指定 preset / 模型 / 权限」卡片模拟几个机器人，验证主动唤醒和额度消耗；正式版另起一个以机器人为中心的插件，按 Apache-2.0 许可借用它的 execution、scheduler、scheduled-session 三块代码。

**问题 3**

投递方式：外部程序把 JSON 写进 ~/.dsh/claude-bridge/inbox/<id>.json。插件每 2 秒扫一次（bridge.js L50），先把文件原子移到 processing/，校验后执行；结果写进 outbox/<id>.json 和 <id>.events.jsonl，心跳文件 bridge-status.json 每 5 秒更新（L52）。
开会话的步骤（bridge.js L309-355）：按 cwd 找到项目，找不到就注册一个；调 ctx.sessionController.create（带 workspaceId 和 agentPreset）；rename 改标题；通过 ctx.commands.execute 执行 /permission，失败就不发指令；可选 selectModel；prompt（mode 为 'queue'）；可选 /goal 让它自动续跑到目标完成。会话是客户端自己的宿主服务创建的，所以在客户端里实时可见。从 0.2.1-rc.2 起网关要求 peer 参数，桥因此改为直连 sessionController（index.js L20-28、L54-68）。
各项限制定义在哪：
①并发：DEFAULT_MAX_ACTIVE_SESSIONS = 2（bridge.js L54）。~/.dsh/claude-bridge/settings.json 可以改，但会被 numberInRange 夹在 1–4（L161）。超限时报「活动会话已达上限 N」（L310-312），这就是你见过的报错，是桥的规则不是 DSH 的。它只统计桥自己跟踪的、还没结束的指令（idle 也算，L585-587），跟踪表只在内存里（L113）。
②限流：每分钟 10 条，可调范围 1–60（L56、L162）。
③白名单：allowed-roots.json，默认只有 ~/Documents/DSHarness Doc（paths.js L84-86）；用 realpath 解析真实路径，防止符号链接绕过；文件格式坏了就当空名单，全部拒绝（L89-104）。
④权限：只允许 read-only 和 workspace-write，full-access 一律拒绝（validate.js L16）；指令文件不超过 512KB，提示词不超过 20 万字（L22、L25）。
⑤审批：桥没有任何批准能力，只把 approval/asked 事件转成 awaiting-approval 状态，等你在客户端里点；看板卡的 confirmation-required 也原样上报。
其他：放一个 DISABLED 文件可一键停用；processed-ids.log 防止同一条指令被重放；audit.log 只记提示词的 SHA-256 哈希。
两处已过时：card.run 调用的 task_board_create / run 工具，在当前安装里找不到提供方；package.json 把版本要求写在 dsh.engines.dsh 下，而宿主只读顶层 engines.dsh，等于没声明。

**问题 4**

lunheng-article-pipeline（MIT 许可）：一个多 Agent 深度长文流水线。用「技能 + subagent 编排」实现 9 个角色、6 个阶段；每个阶段有机械校验的「门」（只读工具，如 lunheng_m_gate），有 4 个需要人确认的节点；运行状态写在 run/<项目>/status.md；按环境变量给 subagent 分三档模型来控成本。它还用全局 tools.guard 防止会话改写流水线自己的规则文件，并提供一个可选的只读运行面板（左侧栏页 + 右侧栏 tab）。值得借鉴：阶段门、状态文件作为唯一可信来源、人在环节点、保护机器人自己的规则文件，正好对应 R3 的「拆解、推进、自评、何时求助」。反面教材：它监听 system-prompt/assemble 去改装配结果（官方不建议），注释里还记录过 next() 返回 undefined 会把上下文整个抹掉的坑。
dsh-oil-ui（MIT 许可）：把上游 oil-ui 设计技能自动编译成 DSH 原生插件，包括动态技能提供者、5 个 oil_ui_* 工具、3 个斜杠命令；命令处理函数里直接用 invocation.agent.followup 让当前 agent 开工。值得借鉴：把技能打包成插件的方式，以及「一键唤醒」按钮的写法。
dsh-context（Apache-2.0 许可）：一个上下文洞察插件。左侧栏一级页展示跨会话的 token、费用、缓存命中和活跃热力图；会话内有 Context 页和 Fleet 页（子代理网络），还有右侧栏面板和 /context 命令。数据用 sessionProjections 从日志派生，只把紧凑摘要写进官方投影缓存；偏好里的「系统提示词前缀 / 后缀」用 systemPrompt.section 按官方锚点注入给所有 agent（包括子代理）。值得借鉴：中心页的「消耗」列和 Fleet 视图，以及上下文注入的正确写法。
entities：不是 DSH 插件，而是 parse5 依赖的 HTML 实体编解码库（entities@9.0.0），和「实体 / 记忆」无关，没有可借鉴的东西。
顺带两个：技能中心（@linxin666/dsh-client-ui-skill-explorer）是「管理中心页 + 宿主写接口 + 仅限本机访问 + 原子写文件」的好先例；dshmarket 是第三方插件市场。
总体看，这几个插件都没做「长期记忆」，记忆只能靠会话本身、文件或自建存储。

**问题 5**

升级时常坏的原因有两类。
①没有独立的稳定插件 API：305 个官方共享包与 App 同号（0.2.1-rc.5），走 nightly 通道，还有强制更新。官方指南明说要以运行中 cordis_inspect_query 查到的为准，experimental 包属于 pre-stable（尚未稳定）。
②具体的坑，你的插件里都踩过：会话 v4 格式取消了通用的 source.kind:'plugin'（看板在 0.8.2 修复）；API 网关从 0.2.1-rc.2 起要求 InvokeRemoteRequest.peer 必填（桥因此改为直连 sessionController）；旧版界面没有官方 slot 时，看板靠 DOM 类名注入，布局一改就失效；在 profile 依赖里装 @deepseek-ai/dsh-* 的 npm 副本，会遮蔽内置实例，导致所有工具调用报错。官方还明确不建议这些写法：监听 system-prompt/assemble、引用 Harness 客户端组件包、追加自定义会话事件类型（会话将无法再打开）。另外，preset 里引用的包改名后，preset 会激活失败。
hostProtocolVersion：desktop-runtime.json 的 release 段里值为 4，但 main.js 只校验 version、nodeVersion、pnpmVersion；整个 app.asar 只在这个描述文件里出现一次；308 个包都不读它。所以它不参与插件兼容判断，具体用途没找到（推测是桌面壳、宿主和更新服务之间的协议号，未证实）。
真正的兼容策略：看插件 package.json 顶层的 engines.dsh（优先），没写就看对 @deepseek-ai/dsh* 的 peerDependencies；在启动、profile 重组、preset 挂载时与运行时版本比较（预发布版也参与比较）。不满足就把该行改为禁用、代码不加载，整个组合包被跳过；两者都没写就不设限。插件管理器在跑 pnpm 之前就会拒绝不兼容的安装（incompatible-version）。可以在 profile 的 compatibility.json 里按「精确插件版本 × 精确 DSH 版本」豁免，升级后不继承，而且需要明确接受风险。注意它只在组合时检查；在 Plugin Manager 之外改动的 link 包不经检查。
官方验证流程（verification.md、SKILL.md 第 4 步、host-plugin.md、user-actions.md）：
1）先用 cordis_inspect_list / query 查当前版本的真实 API；
2）装之前检查 JS 语法和清单；
3）install_bundle 后看结果里的 application 和 warnings（applied / failed / overridden / restart-required），再用 cordis_inspect_query 确认新行；
4）真正运行一次功能；
5）核对插件页的标题、描述、图标（中英文都看）；
6）页面类插件要检查：只用主题 token、不 import Harness 客户端包、控制台没有 slot entry crashed、亮色和暗色主题都正常；
7）没有浏览器控制时，只验证语法、清单和 slot 注册，并明确说明「视觉未验证」，不做假预览；
8）界面和工具共用的操作，要用工具单独执行一遍再和界面结果比对；授权类操作要验证 agent 做不了。

**问题 6**

安装有三种方式。
①在 DSH 侧栏「插件」里点「添加插件」，可以填包名、Git 地址、压缩包或本地绝对路径。Host 会先检查再装，过程中能看 pnpm 日志、取消安装，遇到构建脚本被拦时可以允许后重试。
②让 DSH 用 plugin_manager 工具的 install_bundle 动作安装，目标填绝对目录。每次操作都要 Full access 或你批准；创造模式默认带这个工具。
③命令行："/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add link:<绝对路径>，remove 和 update 同理。
插件必须是组合包（package.json 里有 dsh.bundle.patch），否则装之前就被拒。本地目录是「链接」安装，改源码就等于改插件。
热更新（HMR）：base 组合包在启动器提供 profileContext 时会启用 dsh-hmr（root: []），插件管理器的每次操作都会触发一次重组，新装的组合包可以直接激活。界面代码方面，看板 README 说重新构建后刷新页面就生效；但官方 client-modules 文档说 bundle 内容变化只能经 HMR 的 rebuilt() 进入模块图，而且正文在第一次请求后会被缓存，所以不一定生效（不确定）。宿主代码方面，官方开发指南说替换已安装的包要重启才能加载新代码，HMR 文档又说下一次重组时会替换已改动的文件。稳妥的做法是完全退出再打开 DSH，你的桥和看板 README 也都这么要求。DSH 升级后，页面必须刷新。
调试手段：插件页上每行的状态（只显示阶段，失败原因要看宿主日志）；profile 下的 .plugin-manager/logs；设置 → 插件 → 插件列表里的同步失败提示和重试；dsh --profile <p> --dump-config；浏览器控制台里的 slot entry crashed；用 cordis_inspect_query 查 Slots 和 Config。
插件市场：官方市场组合包和「发现」页是可选的，默认不启用、默认没有索引源；索引没有签名；不支持升级，只能卸载再装。你已经装了第三方 dshmarket（社区目录、热禁用、启动失败恢复页）。自写的中心插件不需要上市场，本地 link 安装就行。
不要用 dsh-cordis-host-runner 的动态插件做常驻功能，它只存在内存里，重启就丢。
可以让 DSH 自己写插件：左侧栏「更多 → 创建你的插件」会用 cordis 预设开一个新会话，并预填好请求（不会自动发送）。你的 drive-dsh 技能就是「Claude 写需求、DSH 实现、Claude 验收」这套流程。

## 能力清单（* 为承重结论）

- **C1***（依据：both；对应 R8, R10）插件可以在左侧栏注册一级入口，并在中栏渲染全局页面：与「插件」「自动化任务」同级，不依赖选中会话。这就是 Agent 中心总览页的落点。官方的定时任务页和 4 个第三方插件（看板、技能中心、dsh-context、论衡面板）都是这么做的。
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-layout/README.zh.md L32：全局面板占据 root 作用域的 main keyed slot，用 ctx.layout.selectPanel(id) 选中
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-sidebar/README.zh.md L36-38：插件在 sidebar.panellist 注册图标，同一个 id 寻址 main 的面板
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js：ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID }) 与 { name: 'main', key: PANEL_ID }
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/client/official-panel.tsx L61-64（先用 slots.spec 探测）、L201-208（注册 main 与 sidebar.panellist）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/@linxin666/dsh-client-ui-skill-explorer/README.zh.md「功能」：侧边栏「技能中心」一行，打开原生中栏页面；/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/README.md L16：Context Insights 一级侧栏页
- **C2**（依据：both；对应 R8）总览页之外还有一批可挂的位置：右侧栏 tab 类型（只在选中会话时存在，适合放单个机器人的详情）、会话页头按钮、侧栏会话行的标记和悬浮卡、对话流里的轮次卡片、输入框上方的 dock、全宽底栏 shell.bottom、浮层 shell.overlay，以及插件页里的配置页 slot。
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-sidebar-right/README.zh.md L83：ctx.sidebarRightTabs.register 加 sidebar.right.pane.tab；L144：没有会话就没有停靠面
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js：conversation.session.header.utilities、sidebar.session.row.leading / hover、conversation.chat.turnTail、sidebarRightTabs.register
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-layout/README.zh.md L34：shell.bottom
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js：conversation.composer.dock
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md L71-73：配置页 slot plugins.bundle.config / plugins.row.config
- **C3***（依据：both；对应 R2, R8, R10）宿主插件能在 DSH 进程里直接开新会话或续老会话，并叫醒 agent 干活。做法是：用 ctx.agents.create / resume 开会话；先用 inject 塞一条框架说明（不叫醒），再用 followup 发正文（叫醒）；用 whenIdle 等这一轮跑完再结算；监听 session/event 里的 turn/end 判断失败。dsh-taskboard 就靠这套实现了：每张卡一个真实会话、定期任务复用会话、每分钟检查一次到期任务、跑完自动移到待验收。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts L142-195：依次注入 workspaceRegistry、agents；调用 agentCtx.agents.create 与 agentCtx.agents.resume。L266 scheduler.start()，L381 execution.reconcile()
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts L736-747：先 handle.agent.inject 框架说明（source.kind 为 'dsh-taskboard'），再 followup 正文。L766：whenIdle 后结算。L213-232：turn/end 带错误即判失败。L780-870：结算时自动移到 in_review，定期任务按 spawn / rearm 处理
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/scheduled-session.ts：只有老会话空闲且 cwd、preset、模型都一致才用 agents.resume 复用，否则新开
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/scheduler.ts L14：TICK_MS=60000。L83-99：setInterval 定时，启动后立刻补跑一次，tick 的异常用 .catch 兜住
  - 证据：dsh-src/@deepseek-ai/dsh-agent/README.zh.md L32、L47：create / resume；followup 会叫醒，inject 不叫醒
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L29：定时器要叫醒 agent 就用 agent.followup()
- **C4**（依据：both；对应 R1, R5, R7, R10）外部程序可以通过插件把任务投进 DSH 客户端进程。claude-bridge 每 2 秒扫一次收件箱，直连宿主的 ctx.sessionController，按 create、rename、/permission、selectModel、prompt、/goal 的顺序开会话，会话在客户端里实时可见。并发、白名单、权限、限流、审批的处理全写在桥自己的代码里，不是 DSH 的规则。
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js L20-28：从 0.2.1-rc.2 起不再走 typertGateway，改为直连 sessionController。L46：inject 列表。L54-68：调用映射。L146：监听 session/event
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js L50-56：INBOX_POLL_MS=2000、STATUS_POLL_MS=5000、DEFAULT_MAX_ACTIVE_SESSIONS=2、DEFAULT_COMMANDS_PER_MINUTE=10。L161-162：用户设置被夹在 1–4 与 1–60 之间。L309-355：开会话的完整步骤
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/validate.js L16、L22、L25；/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/paths.js L84-86、L89-104
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/README.md：目录协议与「限制」一节
- **C5**（依据：code；对应 R3, R6, R7, R10）宿主插件能注册模型工具、系统提示词段、斜杠命令、技能和工具闸门，足够给机器人加上「协议 + 汇报 / 求助 / 互发消息」这类工具。先例：看板的 10 个 taskboard_* 工具、协议提示词段和代码级 done 闸门；oil-ui 的工具、斜杠命令和动态技能；论衡的技能和 tools.guard；dsh-context 的系统提示词前缀与后缀。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts L51：inject ['tools','systemPrompt']。L85：ctx.systemPrompt.section。L124：注册工具
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/tools.ts L319：ctx.tools.register。L621-635：agent 移到 done 被拒、任务被别人持有不可抢、跨项目不可认领
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-oil-ui/lib/index.js：ctx.skills.registerProvider、ctx.tools.register(defineTool({ name: 'oil_ui_skill_status' }))、ctx.commands.register({ name: 'oil-ui-status' })、invocation.agent.followup(...)
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/lunheng-article-pipeline/lib/index.js L25、L213：ctx.skills.register；/Users/bytedance/.dsh/profiles/desktop/node_modules/lunheng-article-pipeline/lib/guard.js L305：tools.guard
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/lib/index.js：systemPrompt.section({ name: 'dsh-context:prompt-prefix', order: getSectionOrder('HARNESS_IDENTITY') - 1000 })
- **C6**（依据：both；对应 R8, R10）界面和宿主之间通信，现成做法是插件在 ctx.webServer 上注册自己的 HTTP 路由（可加 SSE 推送）。桌面版宿主也在 127.0.0.1 的随机端口上起了 webServer，所以在桌面版能用。官方另一条通道（Typert Remote）需要先生成代码，第三方插件都没走这条。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/routes.ts L1433-1434：webServer.register 注册前缀路由和 SSE；/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/client/api.ts L224：new EventSource('/dsh-taskboard/events')
  - 证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js：启动参数 '--host','127.0.0.1','--port','0'，以及 ctx.connection.authenticatedUrl(... ctx.webServer.port)
  - 证据：dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md L61：register 支持 exact / prefix 路由
  - 证据：dsh-src/@deepseek-ai/dsh-typert-loader/README.zh.md「概述」：Typert 依赖生成的产物；dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/user-actions.md：同一个宿主方法同时给界面和工具调用
- **C7***（依据：both；对应 R10）自写组合包有官方的安装、启停通道：插件页「添加插件」（支持包名、Git、压缩包、本地绝对路径）；DSH 自己的 plugin_manager 工具（含 install_bundle 等 8 个动作，每次都要 Full access 或你批准）；命令行 dsh plugin add link:。新装的组合包可以经 HMR（热重载）免重启生效；可调参数写进 Config，就能在插件页编辑。DSH 还自带「创造模式」，可以让它自己写插件。
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js：action 枚举 list_plugins、list_bundles、set_plugin、set_bundle、install_bundle、remove_bundle、list_version_exemptions、set_version_exemption；原文：'Every action requires danger-full-access permission or approval'
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md L14、L31
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md「安装一个组合包」
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md「Install, enable, and observe」
  - 证据：dsh-src/@deepseek-ai/dsh-hmr/README.zh.md L27、L49
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-entry-customization/README.zh.md：「创建你的插件」调用 uiWorkspace.startSession(..., { agentPreset: 'cordis' })
- **C8**（依据：both；对应 R8）每个会话的派生数据（状态、token、费用）官方推荐用 ctx.sessionProjections 计算，界面侧用 wire.view 直接拿算好的值。dsh-context 已经用它做出跨会话的 token、费用、缓存命中洞察页，以及 Fleet 子代理网络页，可以直接借鉴来做中心页的「消耗」列和「状态」列。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L26、L38
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/README.md L16-18、L97（读官方 contextPressure / contextBreakdown 投影）、L227（只把紧凑摘要写入投影缓存）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/lib/index.js：e.sessionProjections.register(...)
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md L305：dsh-token-meter 提供 ctx.tokenMeter
- **C9**（依据：both；对应 R10）官方有插件版本闸门。规则：看插件 package.json 顶层的 engines.dsh，没写就看对 @deepseek-ai/dsh* 的 peerDependencies；在启动、profile 重组、preset 挂载时与运行时版本比较；不兼容的行被禁用、代码不加载。插件管理器在跑 pnpm 之前就会拒绝不兼容的安装（incompatible-version）。可以在 profile 的 compatibility.json 里按「精确插件版本 × 精确 DSH 版本」豁免，升级后不继承。
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md L52、L54、L56
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js：evaluatePluginCompatibility 调 unmetRequirements(fields)，先读顶层 fields.engines.dsh，否则读 peerDependencies
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md L67-71；dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/index.js：throw new ManagementFailure('incompatible-version', ...)

## 限制清单（* 为承重结论）

- **L1*** 插件接口没有冻结的稳定版本。桌面版 305 个共享包全部与 App 同号 0.2.1-rc.5 一起发布；更新通道是 nightly（允许预发布版），还有强制更新策略（提示文案：这个版本已不再受支持，必须更新才能继续）。官方指南要求每个服务方法和事件都以运行中 cordis_inspect_query 的查询结果为准，experimental 包明确属于 pre-stable（尚未稳定）。
  - 影响：Agent 中心插件要做好「每次升级都可能要修」的准备：锁定已验证的版本、升级后跑回归测试、出问题能停用或回退。这是长期维护成本，不是一次性开发成本。
  - 证据：dsh-src/_app/desktop-runtime.json：release 段为 version 0.2.1-rc.5、hostProtocolVersion 4；sharedPackages 共 305 条，@deepseek-ai/dsh-* 全部是 0.2.1-rc.5，cordis 是 4.0.5
  - 证据：/Applications/DeepSeek Harness.app/Contents/Resources/app-update.yml：channel: nightly
  - 证据：dsh-src/_app/main.js：updater.allowPrerelease = channel === 'nightly'；mandatoryDetail 文案「This version is no longer supported. Update to continue.」
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L3（the installed Harness is the authority）；dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md L5（experimental 为 pre-stable）
- **L2*** 宿主进程里，任何同步回调（定时器、流监听）抛出没被捕获的异常，或者脱离 apply() 单独跑的异步任务出现未处理的 rejection，整个应用都会释放并以非零码退出，不管是哪个插件引起的。相比之下，普通插件加载失败只算警告，其他插件照常运行。
  - 影响：中心插件的调度器、轮询、HTTP 处理只要有一处没兜住，所有机器人和你正在用的会话会一起停。必须像看板那样给每次 tick 加 .catch，所有回调都包 try/catch。
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md L43、L98-110：失败矩阵中，未处理的 rejection 和同步回调未捕获异常都是致命错误，与条目 id 无关
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/scheduler.ts L89-97：tick().catch 兜底及其注释
- **L3*** 官方 Agent preset（工具集加人设的组合）没有运行时写接口。preset 注册表明确「不写入任何声明」；新建或修改 preset 只能写一个组合包补丁，再用 plugin_manager 安装。每次安装都要 Full access 或你批准，而且影响整个 profile；已经在跑的会话继续用旧组合。
  - 影响：「一个机器人一个 preset，由你或别的 Agent 批量生成」这条路走不通。机器人身份要存在中心插件自己的数据里，只预装少量角色 preset；开会话时注入人设和目标，再在这个 agent 的上下文上用 tools.restrict 收窄它能用的工具。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md L48
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md：Nothing edits a declaration in place；Existing sessions ... keep the plugin revision they started with
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js：Every action requires danger-full-access permission or approval
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L19：单个 agent 的行为注册在 agent.ctx 上
- **L4** 右侧栏按会话保存状态，没有选中会话就没有右侧面板；整个布局的几何状态刷新页面就重置。
  - 影响：所有机器人的总览只能做成中栏全局页；右侧栏只适合放「当前这个机器人」的详情。
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-sidebar-right/README.zh.md L144
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-layout/README.zh.md L94
- **L5** webServer 本身不做认证，也不检查请求来源，插件路由要自己设防。桌面版绑定在 127.0.0.1 的随机端口上。
  - 影响：中心插件的写接口（新建、暂停、运行机器人）必须自带同源、仅限本机回环、防 CSRF 的校验，否则本机上任何进程都能调用。
  - 证据：dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md L130
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/routes.ts L188、L609：注释写明是本地无认证接口，自加 CSRF 栅栏
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/@linxin666/dsh-client-ui-skill-explorer/README.zh.md「安全模型」：所有路由默认只允许本机回环访问
- **L6** 插件界面不能引用 Harness 自带的客户端组件包（官方原话是它们会「change without notice」，即随时变更），只能共享 --dsw-alias-* 主题 token；也不建议用 iframe 嵌宿主页面。
  - 影响：做一个像样的仪表盘要自己写或照抄控件，工作量偏大。体量参照：看板的 lib/client.js 约 255KB，dsh-context 的 lib/client.js 约 619KB。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L33-35
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/verification.md
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/lib/client.js（254809 字节）；/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js（618663 字节）
- **L7** claude-bridge 的「活动会话上限 2」是桥自己的代码规则：默认 2，settings.json 最多只能调到 4；每分钟指令数默认 10（可调范围 1–60）。桥只认自己开的会话，跟踪状态只存在内存里：重启后既不再计数，也不能对旧会话 followup 或 cancel。idle 状态也占名额。card.run 依赖的 task_board_create / task_board_run 工具，在当前安装里找不到任何包提供。
  - 影响：桥适合「外部 Claude 派活」，不适合当机器人调度的核心。Agent 中心应该在宿主内部自己管理并发和排队。
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js L54、L56、L113、L161-162、L310-312（报错原文「活动会话已达上限 N」）、L418、L431、L585-587
  - 证据：对 308 个官方包和 /Users/bytedance/.dsh/profiles/desktop/node_modules 做 grep，task_board_create 无结果
- **L8** dsh-taskboard 以「任务卡」为中心：全局并发默认 3（可用环境变量或设置改为 1–100），tick 每 60 秒一次，只在宿主进程活着时调度，离线期间错过的窗口按设置跳过。它没有机器人身份、长期目标、用量预算、机器人互发消息。另外，agent 可以用 taskboard_create / taskboard_update 把卡片权限设成 danger-full-access，执行时直接套用，看板代码里没有用户确认环节（DSH 本身是否另有拦截未验证）。
  - 影响：它可以当「主动机器人」的零代码原型，但离 Agent 中心还差一整套数据模型。直接在它上面改，还会继承这个提权口子和与上游作者更新的冲突。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/shared/protocol.ts L125：DEFAULT_MAX_CONCURRENT=3；L166-175：asPermission 接受 danger-full-access
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts L77-78：DSH_TASKBOARD_MAX_CONCURRENT；/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/scheduler.ts L14
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/tools.ts L423-425、L479、L532、L568；/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts L684-689
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/README.md：「host 侧调度：关掉浏览器照常触发；错过窗口跳过不补跑」，以及 0.7.6 版说明（并发 1–100）
- **L9** hostProtocolVersion 不参与插件兼容判断。它只出现在 desktop-runtime.json 的 release 段（值为 4）；main.js 的 readDesktopRuntime 只校验 version、nodeVersion、pnpmVersion；整个 app.asar 只在这个描述文件里出现过一次；308 个包的代码都不读它。另外，你的桥把版本要求写在 dsh.engines.dsh 下，而宿主只读顶层 engines.dsh，等于没声明。
  - 影响：不能指望 hostProtocolVersion 来判断插件能否跨版本使用。要在 package.json 顶层写 engines.dsh，并在每次升级后自测。
  - 证据：dsh-src/_app/desktop-runtime.json：release.hostProtocolVersion: 4
  - 证据：dsh-src/_app/main.js：readDesktopRuntime 只校验 release.version / nodeVersion / pnpmVersion 和共享包版本
  - 证据：在 /Applications/DeepSeek Harness.app/Contents/Resources/app.asar 全文搜索 hostProtocolVersion，只有 1 处，就是 desktop-runtime.json 本身
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js：unmetRequirements 读 fields.engines；/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/package.json："dsh": { "engines": { "dsh": ">=0.2.0-rc.2" } }
- **L10** 升级后常坏的具体写法，你的插件里都出现过，或官方明确不建议：①会话 v4 格式取消了通用的 source.kind:'plugin'；②API 网关从 0.2.1-rc.2 起要求 InvokeRemoteRequest.peer 必填；③旧版界面没有官方 slot 时，看板靠 DOM 类名注入；④在 profile 依赖里装 @deepseek-ai/dsh-* 的 npm 副本，会遮蔽内置实例，导致工具调用失败；⑤监听 system-prompt/assemble 去改装配结果；⑥追加自定义会话事件类型，会导致会话无法再打开；⑦preset 里引用的包改名后，preset 激活失败。
  - 影响：中心插件设计时要逐条规避：只用官方 slot 和服务；运行时不 import @deepseek-ai 包；注入上下文用 systemPrompt.section 和 agent.inject；机器人数据存在自己的文件里，不塞进会话日志。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts L39-49，及 README.md 0.8.2 版说明
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js L20-28
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/client/sidebar-entry.ts L36-62（[class*="logoRow"]、button[class*="newSession"]），及 README.md 0.8.0 版说明
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/sdk.ts 文件头注释，及 README.md 安装段「官方 @deepseek-ai/dsh-* 包只写进 profile 的 bundles 列表」
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/lunheng-article-pipeline/lib/index.js L644 对比 dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L17、L21
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md：packages renamed since the preset was written fail at activation
- **L11** 开发期的几条限制：①dsh-cordis-host-runner 的动态插件定义只存在内存里，重启就丢；②官方插件市场组合包默认不启用、索引没有签名、不支持升级（只能卸载再装）；③替换已安装包的宿主代码，官方开发指南说要重启才能加载新代码，HMR 文档又说下一次重组时会自动替换。你的桥和看板 README 都要求装完后重启。
  - 影响：中心插件的迭代节奏是：本地目录 link 安装，改界面代码后刷新或重启，改宿主代码后完全退出再打开 DSH。动态插件不适合做常驻功能。
  - 证据：dsh-src/@deepseek-ai/dsh-cordis-host-runner/README.zh.md「概述」与「定义的去向」
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-market/README.zh.md L27、L102-103
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md 末段；dsh-src/@deepseek-ai/dsh-hmr/README.zh.md L49
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/README.md 安装段（装完重启一次客户端）；/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/README.md「开发模式安装」

## 核查结果

- **C1：成立**。原结论：插件可以在左侧栏注册一级入口（sidebar.panellist），并在中栏渲染全局页面（root 作用域的 main keyed slot），与「插件」「自动化任务」同级，不依赖选中会话。官方定时任务页和看板、技能中心、dsh-context、论衡面板 4 个第三方插件都这么做。
  - 核查说明：README 和 lib 代码都支持。补充细节：①官方定时任务页在 lib 里确认是 ctx.slots.inject('main' / 'sidebar.panellist', () => ctx.slots.register(...))，key 和 id 都是 'schedules'，order 10；插件页是 order 0。4 个第三方插件的 lib 也都确认：看板先用 slots.spec 探测两个 slot，失败就回落到旧的 DOM 注入；dsh-context 只在偏好 insightsEntry 为 'show' 时注册（order 20）；论衡用 order 60，整块包了 try/catch；技能中心直接注册。②落点有 4 条限制。第一，中栏一次只显示一个页面，打开任何会话就切回会话正文，所以总览页和某个机器人的对话不能在中栏并排。第二，右侧栏的 rightbar.session 只在中栏显示会话时渲染，机器人详情如果做成右栏 tab，只有打开那个会话时才能看到。第三，面板选中状态和栏宽刷新后会重置。第四，注册必须包在 ctx.slots.inject(声明方, ...) 里；宿主没声明这个 slot 时，面板只是不出现，不会报错。
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js L7363（PANEL_ID='schedules'）、L7473-7491（main key + sidebar.panellist id，order 10）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js L4484-4490（插件页 order 0）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-sidebar/README.zh.md L36-38（全局面板入口：同一个 id 寻址 main）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-layout/README.zh.md L12（布局状态刷新后重置）、L32（selectPanel，null 回到会话界面）、L59（右栏 root 控制器只在选中会话界面时渲染 rightbar.session）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/client/official-panel.tsx L59-63（slots.spec 探测）、L199-208（注册 main 与 sidebar.panellist）、L229-262（回落旧 DOM 注入）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/@linxin666/dsh-client-ui-skill-explorer/lib/client.js L2153-2171；README.zh.md L22-24（打开任意会话就让中栏回到会话正文）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js 第 31 行（压缩代码，关键词 insightsEntry()===`show` 后注册 main 与 sidebar.panellist，order 20）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/lunheng-article-pipeline/lib/client.js L2041-2045（sidebar.panellist order 60 + main，外层 try/catch）
- **C3：部分成立**。原结论：宿主插件能用 ctx.agents.create / resume 开新会话或续老会话，先 inject 一条框架说明（不叫醒），再 followup 正文（叫醒），用 whenIdle 等这轮跑完再结算，用 session/event 的 turn/end 判断失败。dsh-taskboard 就靠这套实现了：每张卡一个真实会话、定期任务复用会话、每分钟检查到期任务、跑完自动移到待验收。
  - 核查说明：上面这些做法在看板源码里都对得上：create/resume、inject 和 followup 合成一轮、whenIdle 后结算、turn/end 带错误判失败、TICK_MS=60000、spawn/rearm、自动移入 in_review。但有 4 处承重偏差。
①所有权（最重要）：ctx.agents.create/resume 会把调用方的 ctx 当作 owner 交给工厂。agent-loop 用 ownerCtx.effect 跟随 owner，owner 一卸载就执行 teardown，并调用 machine.cancel({kind:'disposed'})。所以中心插件一旦被停用、文件替换后热重载、改了非 volatile 的 Config（Loader 会整行重新挂载），或者重组失败，它开出或续上的所有机器人都会被当轮取消并卸下。看板 index.ts 的注释说「插件重载会保留活 agent」，这只对它借用的、由 GUI 持有的活 agent 成立（scheduled-session.ts 里 borrowed:true 的分支）。官方 dsh-schedule 和你的桥走的是 ctx.sessionController（create / resolveAgent），这样 agent 归 Session controller 所有，和 GUI 走同一条路，更适合常驻机器人。
②whenIdle 不等于「这一条 followup 跑完了」：官方 practices.md 写明多个输入可能共用同一个运行区间。等待审批或等待回答的回合也算在运行（dsh-agent README），这时 whenIdle 不会完成，看板这次执行会一直占着并发名额。
③「turn/end 带错误就算失败」是看板自己的启发式判断，注释 S7 写着需要宿主确认。
④几处细节：活着且空闲、配置一致的会话是直接借用，不调 resume；只有不在内存里的会话才走 agents.resume。模型一致性只对活会话检查，持久会话靠 execution.ts 里的 sessionReuseKey。启动后的补跑 tick 在 3 秒后执行，不是立刻。agents.create 开出的会话还要再调一次 workspace.attachSession，才会出现在 GUI 的项目会话列表里。
  - 证据：dsh-src/@deepseek-ai/dsh-agent/lib/index.js L453-470（create/resume 把 this.ctx 作为 ownerCtx 传给工厂）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js L1702-1714（teardown 里 machine.cancel({kind:'disposed'})）、L1749-1764（ownerCtx.effect 跟随 owner）、L1969-1976（resume 同样跟随 owner）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md L89、L110、L112（所有权归调用方 fiber；调用方卸载与句柄释放走同一次 teardown）
  - 证据：dsh-src/@deepseek-ai/cordis-plugin-loader/README.md L53（普通 config 值变化就整行重新挂载，只有 volatile 字段就地提交）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js L1576-1596（sessionController.resolveAgent 后 followup）；dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js L210-245
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L28（whenIdle 不代表一条 follow-up 完成）、L29（定时器用 followup 叫醒）
  - 证据：dsh-src/@deepseek-ai/dsh-agent/README.zh.md L32、L47（create/resume；inject 不叫醒）、L109（等待审批或回答的回合也算在运行）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts L185-204（agents 注入；L201-203 注释说重载保留活 agent）、L266、L381
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/execution.ts L213-232（turn/end；L219-224 S7 待确认注释）、L736-747（inject + followup）、L766-770（whenIdle）、L780-870（spawn/rearm/in_review）；关键词「Attach the session to the workspace」
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/scheduled-session.ts L32-47（活会话直接借用，borrowed:true）、L49-66（不在内存时才 resume）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/scheduler.ts L14（TICK_MS=60000）、start() 中 setTimeout 3_000 补跑
- **C7：部分成立**。原结论：自写组合包有官方的安装、启停通道：插件页「添加插件」（包名、Git、压缩包、本地绝对路径）；plugin_manager 工具（8 个动作，每次要 Full access 或批准）；命令行 dsh plugin add link:。新装组合包可经 HMR 免重启生效；可调参数写进 Config 就能在插件页编辑；DSH 自带创造模式，可以让它自己写插件。
  - 核查说明：安装和启停的几条路都成立。①添加插件接受的 4 种形式，在 README 和 install-spec.js 里都能看到。②plugin_manager 有 8 个动作，每个动作（包括 list）都调用 approveEscalation('danger-full-access')，代码已确认。③CLI 确实存在，它把参数原样转给 pnpm。④新装组合包可以经 HMR 激活。⑤创造模式会调用 startSession(..., {agentPreset:'cordis'})。
有一处说错了：「Config 写好就能在插件页编辑」不成立。官方 settings 只会报告 autoGenerate，「目前没有已发布的客户端这样做」，表单也只覆盖 .volatile() 字段。插件页只会渲染插件自己在 plugins.bundle.config 或 plugins.row.config slot 里注册的配置组件，dsh-context 就是这么做的。普通 Config 字段只能手改 cordis.patch.yml。
还有几处要补充：
（a）plugin_manager 工具默认只在创造模式（cordis preset）里开着，standard 和 ptc preset 里是 disabled: true。没有人审批时（审批渠道不可用、never 或被拒绝）不会执行，所以不能指望无人值守的 agent 用它装插件。
（b）桌面版 profile 用 CLI 前必须先初始化，提示语是「先打开一次再完全退出」。官方开发指南也要求 agent 不要用 shell 或 pnpm 自己装插件。
（c）HMR 的 root 是 []，不监听源码。link 包改了代码，要等下一次重组（插件管理操作，或改 profile/home patch）才会被替换；替换版本加载失败时，旧插件也会被停掉。至于「替换已装的包要不要重启」，host-plugin.md 和工具描述说法不一致，以返回结果里的 application / restartReason 为准。
（d）中心插件的普通 Config 字段一改，就会整行重新挂载（见 C3 ①），可调参数应该声明成 .volatile()。
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js（description 写明 Every action requires danger-full-access permission or approval；action 枚举 8 个；execute 内 approveEscalation）
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js parseInstallSpec（本地路径必须是绝对路径；git / tarball / registry 三种形式）
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md L14、L31（工具在 Creator 模式中启用，其他 preset 默认禁用）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml L131-133 与 dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml L123-125（disabled: true）
  - 证据：dsh-src/@deepseek-ai/dsh-settings/README.zh.md L33（表单只展示 volatile 字段）、L39（autoGenerate：目前没有已发布的客户端这样做）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md L57（添加插件接受的形式）、L71-83（配置页靠 plugins.bundle.config / plugins.row.config slot）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js 第 47 行（configForms.whileServed + 注册 plugins.bundle.config）
  - 证据：dsh-src/@deepseek-ai/dsh/lib/plugin-BiveYA7h.js L10-12（desktop 提示先打开一次再完全退出）、L63-99（转给 pnpm）；dsh-src/@deepseek-ai/dsh/README.zh.md L18
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md L68-70；dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md L10（不要手写 profile 或跑 pnpm）
  - 证据：dsh-src/@deepseek-ai/dsh-hmr/README.zh.md L27、L49；dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml L28-32（有 profileContext 时启用 hmr，root: []）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-entry-customization/lib/client.js L122-123（startSession(void 0, {agentPreset:'cordis'})）；README.zh.md L33（只预填草稿，不自动发送）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L22（可调值放 Config，用户在 cordis.patch.yml 里改）
- **L1：成立**。原结论：插件接口没有冻结的稳定版本：305 个共享包全部与 App 同号 0.2.1-rc.5；更新通道是 nightly（允许预发布版），还有强制更新策略；官方指南要求以运行中的 cordis_inspect_query 为准，experimental 包属于 pre-stable。
  - 核查说明：结论成立。数字要更正：305 条 sharedPackages 里，297 个 @deepseek-ai/dsh* 的版本都是 0.2.1-rc.5；另有 8 个包有自己的版本号，分别是 cordis 4.0.5、cordis-plugin-loader 1.0.6、cordis-plugin-include 1.0.10、cordis-plugin-group 1.0.5、cordis-plugin-timer 1.1.7、cosmokit 1.8.6、schemastery 3.18.5、node-addon-system 0.1.2。插件实际调用的 DSH 服务都跟着 App 的 rc 版本走，所以结论不变。
强制更新已经在代码和安装包里确认。我只读解析了 app.asar 的文件头，取出根目录的 package.json：里面写着 dshDesktopUpdateChannel: nightly，dshMandatoryUpdatePolicy 的 origin 是 https://harness.deepseek.com。main.js 默认每 10 分钟检查一次；更新通道写死在安装包里，用户切不到 latest。
对「锁版本」的补充：用 engines.dsh 精确锁定后，强制更新一到，中心插件会被跳过（相当于禁用），直到你发布兼容版本或做精确豁免。豁免只对「插件精确版本 × DSH 精确版本」这一对有效，升级后不继承，还要明确接受风险。官方另有一句：Harness 客户端包「改动不另行通知」。
  - 证据：dsh-src/_app/desktop-runtime.json（release：version 0.2.1-rc.5、hostProtocolVersion 4；sharedPackages 305 条，统计结果是 297 条 rc.5 加 8 条独立版本）
  - 证据：/Applications/DeepSeek Harness.app/Contents/Resources/app.asar 根目录 package.json（只读解析：dshDesktopUpdateChannel nightly；dshMandatoryUpdatePolicy.origin https://harness.deepseek.com，authentication anonymous）
  - 证据：/Applications/DeepSeek Harness.app/Contents/Resources/app-update.yml（channel: nightly）
  - 证据：dsh-src/_app/main.js L7577（「当前版本已停止支持，请更新后继续使用」）、L7672-7680（通道读自安装包 manifest）、L7809（allowPrerelease = channel === 'nightly'）、L9460-9489（intervalMs 默认 6e5）、L13129-13131
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L3、L35（客户端包 change without notice）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md L5（experimental 是 pre-stable）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md L52-56（engines.dsh 检查；不兼容就跳过；豁免不继承）；dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md L69-75
- **L2：部分成立**。原结论：宿主进程里任何同步回调抛出未捕获异常，或脱离 apply() 的异步任务出现未处理 rejection，整个应用都会释放并以非零码退出，不管是哪个插件引起；普通插件加载失败只算警告。中心插件的调度器、轮询、HTTP 处理只要有一处没兜住，所有机器人和正在用的会话会一起停。
  - 核查说明：核心结论在 README 失败矩阵和代码里都成立。installFailLoud 会监听 unhandledRejection 和 uncaughtException，触发后直接 exit(1)；桌面宿主子进程通过 runProfile 装了它。插件加载失败只算警告，这一点也对。
有两处要改。
①「HTTP 处理没兜住就全停」不准确。webServer 路由的 handler 抛错或 rejection 会被服务器接住，返回 400 并记一条 warning，「绝不会退出进程」。真正致命的是 handler 之外的东西，包括：
- 同步回调：定时器、流的 'data' 事件；
- Cordis 的事件监听：ctx.emit 同步调用监听器，既不 await 也不 catch；
- 没有人接的 Promise：async 事件监听器返回的 Promise、`void xxx()` 这类写法。
先例自己也有隐患：看板 index.ts L381 的 `void execution.reconcile()` 没有 catch，而 store.mutate 写盘失败会 reject，所以启动时一旦写盘失败就会致命退出。
②桌面版不只是「退出」。宿主子进程非零退出后，Electron 会弹出原生错误框，有三个按钮：退出、重启、「禁用第三方插件、备份 profile patch 并重启」。它不会自动重启，要等人来点。选第三个按钮会把 profile 的组合包列表重置为默认 web 组合，并把 profile 的 cordis.patch.yml 改名备份，中心插件和它的配置会一起被摘掉。所以在无人值守时，一次没兜住的异常就意味着所有机器人停摆，直到你回来处理。
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md L43、L98-110（失败矩阵）、L69（sanitizeProfile）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js L4216-4252（installFailLoud：unhandledRejection / uncaughtException → exit(1)）
  - 证据：dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js L286（runProfile 中安装 installFailLoud）；dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js L226（桌面宿主子进程使用 runProfile）
  - 证据：dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md L71（handler 抛错返回 400，绝不会退出进程）；lib/index.js L395-405（handle().catch）
  - 证据：dsh-src/@deepseek-ai/cordis/lib/index.js L276-282（emit 同步调用监听器，不 await、不 catch）
  - 证据：dsh-src/_app/main.js L3840-3846（宿主退出后 fail）、L12250-12252（phase error 时调用 reportFatal）、L8325-8380（DesktopFatalRecovery 三个按钮）、L7497-7505（中文按钮文案）、L11827-11848（disablePlugins / relaunch）、L3576-3586（disableAllPlugins → sanitizeProfile(WEB_PROFILE.bundles)）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/scheduler.ts start()（tick().catch 兜底）；/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts L381（void execution.reconcile() 没有 catch）；/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/store.ts L202-219（mutate 写盘可能 reject）
- **L3：部分成立**。原结论：官方 Agent preset 没有运行时写接口：注册表不写入任何声明；新建或修改 preset 只能写组合包补丁再用 plugin_manager 安装（要 Full access 或批准、影响整个 profile、在跑的会话用旧组合）。所以「一个机器人一个 preset，批量生成」走不通，应只预装少量角色 preset，开会话时注入人设和目标，再在 agent 上下文上用 tools.restrict 收窄工具。
  - 核查说明：README 和官方技能里确实只给了一条路：写组合包补丁，再用 plugin_manager 安装。装一次要 Full access 或批准、会影响整个 profile、已在跑的会话保留旧代际，这些在 tools.js 和 README 里都已确认。
但「没有运行时写接口」在代码层不成立。agentPresets 服务公开了 register(definition) 方法，preset 声明行本身就是调它注册的；app-boot README 也写到「运行时创建的……Agent preset 实例」。任何注入了 agentPresets 的宿主插件，都能在内存里直接注册 preset，不经过 plugin_manager，也不需要审批。不过这样做有代价：
- 不持久：重启或插件卸载后要重新注册，否则引用这个 id 的会话恢复时会报 agent-preset/not-found，开机时还和官方定时补投递存在竞态；
- 重复 id 会直接抛错；
- 每个 preset 都会立即激活成一棵独立的插件树；
- 它会以自定义 preset 的身份出现在你新建会话的选择器里；
- 这是给 preset 声明插件用的内部接口，没有作为第三方用法写进文档。
另外，用户自己改 profile 的 cordis.patch.yml 也会被 HMR 实时重组，只是官方技能禁止 agent 手写这个文件。
所以「不要一机器人一 preset」这个结论仍然对，但理由应该是选择器被污染、每个 preset 一棵插件树的开销、id 的生命周期和恢复竞态，而不是「做不到」。
收窄工具的写法可行，但有坑：tools.restrict 只能在 agent.ctx 上调用，否则直接抛错；它能过滤 preset 层继承下来的工具；名单里只要有一个该 agent 不认识的工具名就会抛错，所以要先按该 agent 实际继承到的工具来算名单。人设和目标也可以用 agent.ctx 上的 systemPrompt.section 注册（create 的 setup 回调或 agent/created 监听里做），不必只靠 inject 一条消息。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md L12、L48、L60（缺失时拒绝恢复）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js L466-492（async register(definition)，返回 disposer，重复 id 抛错）、L570-591（list / remoteExportList 列出全部定义）、L596-600、L632-640（not-found）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/lib/index.js L25（preset 行本身调用 this.ctx.agentPresets.register(this.config)）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md L81（运行时创建的插件和 Agent preset 实例不在发现范围内）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md L8、L52、L74、L78（preset 代际会立即激活）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-agent-preset/README.zh.md 第 30 行（新会话选择器提供标准、创造和自定义预设）
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js（每个动作都要 danger-full-access 或批准，Changes affect every session in this profile）
  - 证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js L2991-3005（restrict 只能用于 scoped ctx；未知名字抛错）、L3030-3050（能过滤祖先 preset 层的工具）
  - 证据：dsh-src/@deepseek-ai/dsh-agent/README.zh.md L43（setup 回调在发布前组合作用域）、L63（agent.ctx 上注册的提示词段、工具、限制只对该 agent 生效）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L17-19；dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md L10

## 核查员补充（读者漏掉的点）

- 机器人 agent 归谁所有，决定了中心插件一更新或一停用，会不会把所有机器人当轮掐断。用 ctx.agents.create/resume 开出的 agent 归中心插件的 ctx 所有，下面三种情况都会让它们全部 cancel({kind:'disposed'}) 并卸下：插件被停用；文件替换后热重载；改了非 volatile 的 Config（这时 Loader 会整行重新挂载）。如果改走 ctx.sessionController.create / resolveAgent（官方 dsh-schedule 和你的桥都走这条路），agent 就归 Session controller 所有，和 GUI 是同一条路径。中心的可调参数要声明成 .volatile() 才能就地生效。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js L1714、L1749-1764、L1969-1976
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md L89、L110、L112
  - 证据：dsh-src/@deepseek-ai/cordis-plugin-loader/README.md L53
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/README.zh.md L34、L44；lib/index.js L210-245
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js L1576-1596
- 桌面版宿主崩溃后不会自动拉起，而是弹出原生错误框，等人点「退出 / 重启 / 禁用第三方插件、备份 profile patch 并重启」。选第三个会把组合包列表重置为默认，并把 profile 的 cordis.patch.yml 改名备份，中心插件和它的配置会一起被摘掉。无人值守时，任何插件里一处没兜住的异常，都会让所有机器人一直停到你回来。
  - 证据：dsh-src/_app/main.js L3840-3846、L12250-12252、L8325-8380、L7497-7505、L11827-11848、L3576-3586
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md L69
- 官方定时服务可以直接给机器人会话排闹钟。宿主插件注入 schedule 服务后，就能调 ctx.schedule.create(sessionId, {title, prompt, 以及 after_seconds / at / every_seconds / daily / weekly / cron 六选一})。注意 Remote 只开放 list / catalog / history / update / delete，没有 create。到点后宿主会恢复冷会话并 followup；宿主重启后任务还在；任务会自动出现在「自动化任务」页，也会进归档检查和退出提醒。限制如下：
- 每个周期任务只补最近一次错过的；
- 同一会话同时到期的任务会合并成一条；
- every 至少 60 秒；
- 子代理会话会被拒绝；
- 回执只代表消息进了收件箱，不代表执行完；
- 在崩溃窗口里可能重复投递。
这条路比照搬看板的 scheduler 更省事。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js L1992（服务名 schedule）、L2068-2117（create(sessionId, request, signal)）、L1576-1596
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/typert.host.js L634-662（Remote 只有 list / catalog / history / delete / update）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md L12、L28-29 及「存储、投递与所有权」段
- 官方已有一个实验性 Agent Team，可作为机器人协作（R6）的先例：一个 Lead 加最多 16 个具名 teammate，能互发 inbox 消息，有持久共享任务板（用 compare-and-set 防止互相覆盖），还能等待变化和打断。它随安装包附带，默认关闭，在插件页的实验性插件里开启。限制如下：
- 实验原型，没有稳定性承诺；
- 单进程，所有成员共用一个 cwd；
- 名单扁平且不可变，只有 Lead 能创建成员；
- 任务 owner 不会自动释放；
- 发送失败不重试；
- Team 绑定在一个 Lead 会话上（TeamId = SessionId），不能把彼此独立的根机器人连起来。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/README.zh.md L12、L32、L49-54、L60-78、L126、L199-207
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js L579-592（OPTIONAL_BUNDLES 含 dsh-experimental-agent-team-profile）
- ctx.webServer.register 注册的 HTTP 路由没有任何鉴权或来源检查，本机任何程序都能调用。看板的路由注释自己就写着这是「本地、无鉴权的 HTTP 面」。中心如果要开「立即运行 / 新建机器人 / 改权限」这类接口，应该改用 ctx.connection.fetch.register：它只放行已认证的 owner，并做 Host/Origin 校验，能防 DNS rebinding 和跨站请求。或者在 handler 开头先调 ctx.connection.requestRejection(req)。技能中心至少做了回环地址检查。
  - 证据：dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md L130（不提供服务器级认证或来源策略）
  - 证据：dsh-src/@deepseek-ai/dsh-client-connection/README.zh.md L34、L47、L49；lib/index.js L723-740（get fetch / requestRejection）、L826-830（非 owner 返回 403）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/host/routes.ts L186-190（unauthenticated HTTP surface）、L1433-1434
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/@linxin666/dsh-client-ui-skill-explorer/lib/index.js L45（isLoopbackAddress）
- 在插件根 ctx 上注册的工具和提示词段会进入所有会话，包括你平时的普通会话。看板就是全局注册了 10 个 taskboard_* 工具和一段协议提示词。中心给机器人的「汇报 / 求助 / 留言」工具、人设和目标提示词，应该注册在该机器人的 agent.ctx 上（在 create 的 setup 回调里，或在 agent/created 监听里），并把 disposer 同时挂到插件自己的 effect 里。否则既会占用普通会话的 token，也会让普通会话能调用机器人的工具。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts L51、L85-90、L124
  - 证据：dsh-src/@deepseek-ai/dsh-agent/README.zh.md L43、L63
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md L18-19
- Config 不会自动变成插件页上的表单。官方 settings 的 autoGenerate「目前没有已发布的客户端这样做」，而且表单只管 .volatile() 字段。要在插件页编辑，中心插件得自己在 plugins.bundle.config 或 plugins.row.config slot 里注册配置组件，dsh-context 就是这么做的。普通字段只能手改 cordis.patch.yml。
  - 证据：dsh-src/@deepseek-ai/dsh-settings/README.zh.md L33、L39
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md L71-83
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-context/lib/client.js 第 47 行（configForms + plugins.bundle.config）
- 退出 App 前，宿主会检查「还有任务在跑 / 有定时任务」，但只看活 agent、后台 job，以及官方 schedule（通过 workspace/session-activity 的 schedule 族）；强制更新前的检查只看活 agent 和 job。中心自建的调度和排队不在检查范围内，你退出时不会被提醒。除非中心也像 dsh-schedule 的 archiveAdmission 那样，往 workspace/session-activity 里贡献条目。
  - 证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js L100-102、L108-150、L160-182
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md（schedule.archiveAdmission() 段）
- 「长期目标」已有现成零件：dsh-goal（服务名 ctx.goals）。它给每个会话保存一个持久目标，状态有 active / paused / blocked / complete 四种，blocked 时可以写原因，Round 上限默认 256，跨重启保留。不过自动续行的授权只存在于当前进程，重启后不会自己接着跑，需要中心重新唤醒。每个会话只能有一个当前目标，正好对应「一个机器人、一个会话、一个目标」。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md L12、L32 及「驱动生命周期」段
  - 证据：dsh-src/@deepseek-ai/dsh-goal/lib/index.js L592（super(ctx, 'goals')）
- 读者列出的调试手段 `dsh --profile <p> --dump-config` 对桌面版 profile 不可用：CLI 遇到 desktop 会直接报错，说它只由 Electron 管理。官方技能 SKILL.md L34 也写了这条命令，但没提 desktop 这个例外。
  - 证据：dsh-src/@deepseek-ai/dsh/lib/bin.js L36
  - 证据：dsh-src/@deepseek-ai/dsh/README.zh.md L20
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md L34
- DSH 还有不依赖桌面窗口的运行方式：
- `dsh --profile headless "任务"`：跑一个持久会话，打印结果后退出；
- `dsh --profile acp`：面向自动化的 JSON-RPC stdio 服务。
你本机已经有 headless 和 web 两个 profile，会话存在 home 级的 ~/.dsh/sessions。这可以作为「电脑开着、但不开 App」时的兜底。不过 desktop profile 只归 Electron 管，插件要在别的 profile 里另装一遍。这些会话会不会出现在桌面版的会话列表里、能不能和桌面进程同时写同一个会话，都还没核实。
  - 证据：dsh-src/@deepseek-ai/dsh/README.zh.md L12-20
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md（@deepseek-ai/dsh-acp：Automation-only Agent Client Protocol server）
  - 证据：ls /Users/bytedance/.dsh/profiles（desktop / headless / web）与 /Users/bytedance/.dsh/sessions（只列了目录名，没读内容）

## 缺口与补法

- [R8｜工作量 L] 没有现成的 Agent 中心页，也没有「机器人」这个实体。官方只有会话、preset、定时提醒三样零件。
  - 补法：自写一个组合包。宿主半边：存机器人档案（人设、目标、模型、角色 preset、权限、工作目录、唤醒规则、预算），负责调度、执行、结算，并提供 HTTP 接口。界面半边：用 sidebar.panellist + main 做总览页，用右侧栏 tab 做单个机器人详情。可以让 DSH 的创造模式按 drive-dsh 的流程来实现。
- [R8｜工作量 M] 中心页的「消耗」列缺数据：没有官方的用量预算接口，也没找到订阅余量接口，只有 token 计量和会话投影。
  - 补法：参照 dsh-context，用 sessionProjections 和 tokenMeter 估算 token 与费用；中心插件自己记下每个机器人每次唤醒的消耗，超过阈值就暂停该机器人。订阅「每 5 小时上限」的余量能不能读，待确认。
- [R1｜工作量 M] preset 不能在运行时创建，「一个机器人一个 preset」意味着要反复安装组合包。
  - 补法：把机器人做成中心插件里的一条数据记录，提供 hub_create_bot 等工具和页面表单；只预装少量角色 preset。工具和权限的差异，用 agent.ctx 上的 tools.restrict 与 permissionPresets.set 实现。
- [R10｜工作量 S] 第三方插件没有现成的「界面调宿主」通道；官方的 Typert Remote 需要先生成代码。
  - 补法：沿用看板和技能中心的做法：webServer 路由 + SSE，加上同源、仅限本机回环、防 CSRF 的校验；按 user-actions 指南，让界面和工具共用同一个宿主方法。
- [R10｜工作量 M] 接口随 nightly 版本变动，没有稳定的 API 版本，hostProtocolVersion 也指望不上。
  - 补法：在 package.json 顶层用 engines.dsh 锁定验证过的版本范围；运行时只用 ctx.get / inject 探测服务，代码里只依赖用到的少数方法；不 import @deepseek-ai 运行时包；不用 DOM 注入，也不监听 system-prompt/assemble；所有定时器都兜底。写一套冒烟测试，每次升级后跑一遍（可参考看板的 vitest、论衡的 node --test）。必要时用 compatibility.json 豁免，或暂缓升级。
- [R2｜工作量 S] 看板是「任务中心」不是「机器人中心」，而且 agent 不需要确认就能把卡片提权到 danger-full-access。
  - 补法：短期零代码：每个机器人建一张「定期执行 + 复用会话 + 完成后移回待办」的卡，验证主动唤醒和额度消耗（复用会话和移回待办这两个选项只能在界面里设）。正式版另起炉灶，按 Apache-2.0 许可复用看板 execution、scheduler、scheduled-session 三块的代码和思路，并把提权改成只有用户能操作。
- [R9｜工作量 S] 任何一个没被捕获的异常都会让整个 DSH 退出。
  - 补法：插件内统一做错误兜底和日志：定时器、路由、事件回调全部 try/catch；某个机器人连续失败达到次数后自动停用它。
- [R5｜工作量 S] 现有桥的并发上限是 2（最多只能调到 4），只能管自己开的会话，card.run 也已失效。
  - 补法：如果还需要外部派活：在中心插件里提供同样的收件箱或 HTTP 入口，由中心统一排队。或者改桥代码里的上限常量，并把 card.run 改成调用 taskboard_* 工具。

## 可调用的宿主接口

- `slot sidebar.panellist + main（ctx.slots.inject / register，ctx.layout.selectPanel）`：注册左侧栏的「Agent 中心」入口和中栏总览页
- `ctx.sidebarRightTabs.register + slot sidebar.right.pane.tab（及 .title）+ ctx.sidebarRight.openTab`：做单个机器人的详情 tab，在它自己的会话右侧栏里打开
- `会话级 slot：conversation.session.header.utilities、sidebar.session.row.leading / hover、conversation.chat.turnTail、conversation.composer.dock、shell.bottom、shell.overlay`：在会话页头和侧栏会话行显示「这是哪个机器人、下次几点醒」；在对话里渲染机器人的汇报卡片；做全局横幅或提示
- `插件页配置 slot plugins.bundle.config / plugins.row.config + 宿主 Config 定义`：放并发上限、默认模型、预算阈值等全局设置；保存到 cordis.patch.yml，升级后保留
- `ctx.agents.create / resume / get；AgentHandle.agent.inject / followup / steer / cancel / whenIdle`：唤醒机器人：开新会话或续它的老会话，先注入人设、目标和记忆摘要，再用 followup 下达本轮任务，跑完后结算
- `ctx.sessionController.create / rename / selectModel / prompt / cancel / projections`：另一种开会话的方式（桥的用法），可以指定 workspaceId 和 agentPreset
- `事件 session/event（turn/end、approval/asked、approval/decided）`：判断机器人这一轮是结束、失败还是卡在等你审批，用于中心页的状态列
- `agentPresets.resolve / mount（作为 agents.create 的 setup 回调）、agentDefaultModel.currentSelection、permissionPresets.set(session, name)、sessionTitle.rename、workspaceRegistry.attachSession`：按机器人的角色模板组合工具和人设，指定模型、权限档位、会话标题，并把会话挂到它的项目下
- `ctx.tools.register / guard / restrict；agent/created 监听 + agent.ctx.effect`：注册 hub_* 工具（汇报、求助、给别的机器人留言）；按机器人收窄工具；设硬闸门（例如禁止机器人自己提权）
- `ctx.systemPrompt.section / agent.inject`：注入「机器人协议」（何时停、何时求助、怎么汇报）和每个机器人的人设、目标
- `ctx.commands.register（处理函数里调用 invocation.agent.followup）`：做 /hub、/wake 之类的斜杠命令，在当前会话里一键让机器人开工
- `ctx.skills.register / registerProvider`：给机器人挂专属技能；动态技能提供者可以随时让技能列表失效并刷新
- `ctx.sessionProjections.register（+ wire.view）、ctx.tokenMeter`：从会话日志派生状态、token 和估算费用，供中心页使用
- `ctx.webServer.register（exact / prefix 路由，可配 SSE）`：中心页的数据和操作接口；需要自带同源、仅限本机回环、防 CSRF 的防护
- `ctx.workspaceRegistry（list / get / create / resolveByPath / attachSession / archivedSessionIds）`：给每个机器人绑定工作目录，把会话挂到对应项目下
- `ctx.schedule（dsh-schedule 包）与 schedule_create 等工具`：官方的持久定时提醒：到点把消息投递回原会话，宿主会自动恢复已经冷下来的会话。可以直接当机器人「下次唤醒」的实现，或作为参照
- `plugin_manager（install_bundle / set_plugin / set_bundle / remove_bundle / list_version_exemptions / set_version_exemption）与 cordis_inspect_list / cordis_inspect_query`：安装中心插件；查当前版本真实存在的服务方法、事件、slot 和主题 token
- `组合包清单字段：dsh.bundle.patch、dsh.client{platform, immediately, inject, external}、exports ./client ./locale/*.json ./icon、顶层 engines.dsh；界面代码用 window.__ModuleLoader__.load 注册`：中心插件的打包骨架
- `@deepseek-ai/dsh-mcp-client（只含配置的组合包行）`：接入飞书等外部服务供机器人使用（对应 R5）
- `实验性：@deepseek-ai/dsh-experimental-agent-team（成员名册、点对点消息、共享任务依赖图）与 @deepseek-ai/dsh-webhook（按规则触发、新建会话）`：机器人协作与事件触发的官方参照。属于 pre-stable，只在 README 层面确认过

## 读者留下的未决问题

- 桌面版 desktop profile 有没有开启 HMR，也就是装插件、改插件后能不能免重启：官方文档说 base 组合包在有 profileContext 时会启用 HMR，但你自装的桥和看板 README 都要求装完重启。需要在本机实测，或用 cordis_inspect_query 查 hmr 那一行。
- hostProtocolVersion=4 的真实用途：没找到任何读取它的代码。
- 订阅「每 5 小时用量上限」的剩余额度，宿主有没有接口可读：本路没找到。这决定中心页能不能显示准确余量，并据此自动暂停机器人。
- 你自装的插件（看板、dsh-context、论衡等）的 package.json 有没有在顶层声明 engines.dsh：受禁区限制没读，无法判断升级时它们会不会被自动拦下。
- drive-dsh 技能和桥的 card.run 指向的旧看板（task_board_* 工具，数据在 ~/.dsh/task-board/ledger-v2.json，该目录只列了文件名）已经不在任何 profile 的依赖里。它是不是已经卸载、技能里的「方式 A」要不要改写，需要你确认。
- 官方实验性的 dsh-experimental-agent-team（成员名册、点对点消息、任务依赖图）能不能作为机器人协作的底座、跨 DSH 升级是否稳定，需要另一路评估。
- 看板的「复用会话 / 完成后移回待办」只能在界面里设，taskboard_create 工具没有这两个参数。由 Agent 批量建「机器人卡」时，默认每轮都会新生成一张卡，这种效果能不能接受，需要实测。
