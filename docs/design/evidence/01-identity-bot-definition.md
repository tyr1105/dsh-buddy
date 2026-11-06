# 底稿：机器人身份与定义（R1，兼顾 R7）

> 研究底稿（2026-11-04，DSH 桌面版 0.2.1-rc.5）。先由一位读者细读官方插件说明与源码，再由另一位核查员逐条尝试推翻承重结论；「核查」一节里的修正优先于「读者结论」。证据路径中的 `dsh-src/` 指从安装包只读解出的官方插件源码，可用 `tools/asar_extract.py` 重新解出。

## 读者总结

现成零件能撑起「多机器人」的骨架。DSH 可以同时挂多个 Agent preset（界面里叫「模式」），每个 preset 各自决定人设（persona）、工具（含 MCP）、技能目录和指令文件规则。机器人实例就是一个个顶层会话，插件可以在运行时按「目录 + preset + 模型 + 权限」批量创建，不用重启；用户自写的 dsh-bridge 和装的 dsh-taskboard 已经在这样用。每个机器人配一个目录，放自己的 AGENTS.md、记忆文件和 .agents/skills，就能按目录把指令和技能分开；在 workspace-write 档位下，各机器人的写操作也不会越界。

需要自己补的地方有这些：
- preset 没有增删改接口，界面只读，只能写 bundle 再安装。
- preset 不能带模型，模型只能在会话上设。
- 会话跑完第一轮后 preset 就锁定，不能再换。
- 读文件不隔离；全局技能和 working_directory 工具会让机器人的「身份」串味。
- 没有「机器人名册」，也没有按机器人的预算。

推荐做法：少量「角色 preset」+ 每个机器人一个目录 + 一个长期会话，再写一个「机器人工厂」插件，把这些步骤串起来：建目录、建会话、设模型和权限、登记名册。

## 逐题回答

**问题 1**

最自然的对应是一个「三件套」：
- 机器人的「身体」= 一个长期存在的顶层会话（Session）。对话历史、模型、权限档位、goal、定时提醒都挂在会话上，提醒也是投递回原会话；会话还会固定绑定一个 preset。
- 机器人的「职业或能力模板」= Agent preset（界面里叫「模式」），决定人设、工具（含 MCP）、技能根、指令文件规则、子代理默认模型。几个机器人可以共用一个 preset，也可以一人一个。
- 机器人的「家和记忆」= 一个工作目录（侧边栏里的一个 workspace 项目），放自己的 AGENTS.md、记忆文件和 .agents/skills。

理由：
- persona 只是 preset 里的一行。
- preset 太重：要高权限安装、启动时整树预加载、会话开跑后就锁定，不适合当随手生成的个体。
- subagent 依附父会话（默认并发 8、深度 1），Agent Team 队友共享 Lead 的目录、最多 16 个、还是实验品，都没有独立的家目录和生命周期。
- 只有「会话 + 目录」能用 API 在运行时批量创建，而且互不干扰；dsh-bridge 和 dsh-taskboard 已经在这样做。

**问题 2**

能定义多个彼此独立的 preset，人设、工具和 MCP、技能根、指令文件规则、子代理模型都可以不同。但模型、工作目录、权限档位不在 preset 里，要在会话上设。

存放位置：
- 内置的 standard/ptc/minimal/cordis 四个在 @deepseek-ai/dsh-web-app/presets/*.patch.yml，桌面版打包在 app.asar 里；
- 自定义的写在你自己 bundle 的 cordis.patch.yml 里，装进 ~/.dsh/profiles/desktop；也可以写进 profile 的 cordis.patch.yml 或 ~/.dsh/cordis.patch.yml；
- 默认 preset 存在 agent-preset-registry 行的 selectedDefault 字段；
- 老的 ~/.dsh/.agent-presets 目录已不再读取。

客户端：设置页能看、能选默认、能只读查看 YAML，不能新建或编辑。「创造模式」入口会开一个任务，让 Agent 帮你写 bundle 并安装（需要你批准）。

运行时批量生成：可以，但只能「写 bundle → plugin_manager 安装」或改 profile patch，没有 preset 的增删改 API。

要不要重启：desktop 默认开了配置热重载，装完在线生效；已在跑的会话继续用旧版本，App 重启后才换新定义。这一条前提是用户的 profile 没关 HMR，未核实。

数量上限：注册表代码里没有上限，只禁止重复 id；但每个 preset 启动时都会整树预加载，数量多了会更慢、更占资源（没实测）。

**问题 3**

选 preset 的途径：新任务页的模式选择器；设置里的默认 preset；API session.create({agentPreset})，或插件里 agents.create 加 agentPresets.mount；空白会话可以调 agentPresets.select；子代理工具的 agent_preset 参数（需要白名单）。

固定绑定：会。会话日志记下 preset id，重启时按这个 id 取当前定义恢复；id 不存在就恢复失败（agent-preset/not-found）；fork 出来的会话继承原 preset。

中途换：不行。只有还没开始第一轮的空白会话能换；开跑之后会被拒绝，报 agent-preset/locked "This session has already started"。

**问题 4**

preset 不能直接指定模型，配置里没有 model 字段，内置 preset 也都没写。可行的做法有三种：
1. 会话级：每个机器人的会话在创建时就定好模型（agents.create 的 agentOptions）。模型记在会话里，重启后沿用。不建议用 session.selectModel 或界面的 /model 给机器人换模型，因为会顺带把全局默认也改掉。
2. preset 级只能管子代理：在 preset 里放一个 subagent 工具实例，用 agentOptions 固定子级的 provider/model。比如巡检机器人主会话跑便宜模型，需要干活时派一个强模型的子代理；也可以用 modelSelectionSettings 让模型在白名单里挑。
3. 一定要让 preset 绑定模型，就得自写插件拦截 agent/request，与会话级选择的冲突未验证。

**问题 5**

加载机制：会话首轮注入两条链，一条是用户全局链（~/.dsh/AGENTS.md、~/.agents/AGENTS.md），一条是项目链（从最近含 .git 的祖先目录、找不到就用 cwd 本身，一路到会话 cwd，每层的 AGENTS.md/CLAUDE.md，再叠 .local 文件）。总预算 65536 字节。Agent 用 read/write/edit 碰到 cwd 下更深的目录时，才会追加那一层的指令；文件被它自己改了会刷新；压缩后看不到基线时会重新注入；文件名可以在 preset 里改。

能不能隔离：能做到指令和身份按目录隔离，但要注意几点：
- 机器人目录别放在同一个 git 仓库下，否则会共享仓库根的 AGENTS.md（也可以故意把它当「全体守则」用）；
- 全局 AGENTS.md 对所有机器人生效，本机目前两份都不存在；
- working_directory 工具能让机器人切到别人的目录，导致身份漂移，需要屏蔽；
- 记忆文件可以配成 local 候选文件（如 MEMORY.md），开局自动读入，自己改写后自动刷新；
- 在 workspace-write 下，写操作以会话初始 cwd 为界、互不越界，但读不隔离；
- 会话日志本身集中存在 ~/.dsh/sessions，不在机器人目录里。

**问题 6**

可以，技能有三种来源叠加：
1. 每个机器人目录下的 .agents/skills 或 .dsh/skills，按会话 cwd 发现，这是最自然的做法；
2. preset 里 skill-filesystem 的 customSkillDirs；
3. 全局 ~/.dsh/skills 和 ~/.agents/skills，默认所有机器人都看得到，本机有 132 项。

要让某个机器人严格只看自己的技能，需要给它单独建 preset，设 includeDefaultRoots:false，再用 customSkillDirs 写上绝对路径。技能的增删改由 watcher 热更新，不用重启。注意每个会话开局都会注入整个技能目录，全局技能太多会明显增加 token 消耗。

## 能力清单（* 为承重结论）

- **C1***（依据：both；对应 R1, R10）可以同时声明多个彼此独立的 preset。每个 preset 是一份完整的插件清单，可以各配不同的 persona 人设（前缀/后缀，complete:true 时可完全替换系统提示词）、工具行（含按作用域隔离的 MCP 客户端）、skill-filesystem 技能根、agent-instructions 指令文件规则、subagent 委派默认值。preset 按 config.id 区分，id 重复会注册失败；注册表用 Map 存储，代码里没有数量上限常量。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/README.zh.md 概述「可同时声明多个 preset，由会话选择」
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/lib/index.js Config: id/name/description/order/plugins
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:446 definitions = new Map(); :473 "Duplicate agent preset"
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/minimal.patch.yml:15 complete: true, :22 tool-fs write: false（与 standard.patch.yml 组合明显不同）
  - 证据：dsh-src/@deepseek-ai/dsh-persona/lib/index.js:24 prefix 必填；apply() 注册 agent 作用域的 persona 段落
  - 证据：dsh-src/@deepseek-ai/dsh-mcp-client/README.zh.md「独立 agent 作用域可以复用相同 namespace，因为其工具与传输彼此隔离」
- **C2***（依据：both；对应 R1, R7, R10）preset 没有增删改 API，客户端也只读：Web 端只调用 agentPresets.list/read/select，设置页的 YAML 查看器是只读的。新建或修改 preset 的唯一官方途径是写一个 bundle（package.json 加 cordis.patch.yml，插入一行 @deepseek-ai/dsh-agent-preset，或按行 id 整份覆盖），再用 plugin_manager installBundle 装进 profile。「创造模式」入口的作用就是让 Agent 在对话里代写并安装这个 bundle。模型通过工具安装时需要 Full access 或逐次批准。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md「注册表不写入任何声明…没有任何接口接受 YAML 写回。新建 preset 或覆盖内置 preset 都是 bundle 补丁」
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:396-398 Remote 只有 list/read/select
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-agent-preset/README.zh.md 已知限制「Web 不创建也不编辑 preset」；lib/client.js 中只出现 agentPresets.list/read/select
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md「Nothing edits a declaration in place」「Install with plugin_manager…requires Full access or approval」
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md「Agent 预设条目保持只读」「每个工具操作都要求 danger-full-access 或本次调用的批准」
- **C3***（依据：both；对应 R1, R9, R10）新装或改动 preset 默认不必重启。desktop profile 默认开启 HMR 的配置热重载：plugin manager 改完 profile 后会在线重组（结果为 application: applied），只有没开 HMR 时才返回 restart-required。HMR 还会监听 profile 的 cordis.patch.yml 和 ~/.dsh/cordis.patch.yml，改动后实时重组。不过已经在跑的会话继续用旧版本，只有新会话用新定义；App 重启后，老会话会按同一个 id 换成「当前定义」。
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:27-31 hmr 行 disabled: !!js "!ctx.get('profileContext')"，注释 Profile configuration reloads by default
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/index.js:2373-2381 有 hmr 返回 applied，否则 restart-required/no-hmr
  - 证据：dsh-src/@deepseek-ai/dsh-hmr/lib/index.js:849-873 watchConfig(profile.patchPath / home patch) 后调用 reconcileProfile
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md「现有 Agent 保留已经使用的组合」「重启恢复使用该 ID 的当前定义」
  - 证据：前提未核实：用户的 /Users/bytedance/.dsh/profiles/desktop/cordis.patch.yml 和 /Users/bytedance/.dsh/cordis.patch.yml 按禁区未读，可能覆盖 hmr 设置
- **C4***（依据：code；对应 R1, R6, R8）机器人「实例」（顶层会话）可以在运行时由宿主插件批量创建，不需要重启，有三条路：
1. 调 sessionController.create({workspaceId 或 cwd, agentPreset})；
2. 像 dsh-taskboard 那样调 agents.create({sessionId, meta:{cwd, agentPreset}, agentOptions:{provider, model, reasoningEffort}, setup: agentPresets.mount})，建会话时就把模型定好；
3. 先用 workspaceRegistry.create(path, title) 把目录登记成侧边栏项目，再用 permissionPresets.set(session, name) 或 /permission 设定权限档位。
用户自写的 dsh-bridge 和装的 dsh-taskboard 已在用这些路径。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:112-149 create(request)，接受 workspaceId/cwd/agentPreset/sessionId
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:371-383 composeAgent → presets.resolve + presets.mount
  - 证据："/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js":305-345 opStart：session.create(workspaceId, agentPreset)、rename、/permission、selectModel、prompt、/goal
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/lib/index.js:160-169 composeAgent；lib/host/execution.js:402-415 agentOptions 指定模型
  - 证据：dsh-src/@deepseek-ai/dsh-workspace/README.zh.md ctx.workspaceRegistry.create('/path/to/dir', 'My Project')
  - 证据：dsh-src/@deepseek-ai/dsh-permission-presets/lib/index.js:344 set(session, name)
- **C5***（依据：code；对应 R1, R9）会话固定绑定 preset：会话日志在 header 和 agent-preset/selected 事件里记下 preset id。只有还没开始第一轮的空白会话能切换 preset；已经开跑的会话调用 select 会被拒绝，报 agent-preset/locked "This session has already started"。fork 出来的会话继承原 preset。恢复会话时按记录的 id 取当前定义；如果这个 id 已经不存在，恢复会失败（报 agent-preset/not-found）。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:750-768 select()；:753 抛出 agent-preset/locked
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/types/session.js agentPresetProjectionDefinition（header.agentPreset + agent-preset/selected）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:418-432 resumeObserved → composeAgent(presetForObservation)；:596 起的 resolve 在 id 不存在时抛 agent-preset/not-found（registry lib/index.js）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:216 起 fork 使用 presetForObservation(source)
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-agent-preset/README.zh.md「已有会话保留所选模式；新会话使用当前默认值」
- **C6***（依据：both；对应 R1, R7）模型不属于 preset：preset 的配置里没有 model 字段，四个内置 preset 也都没写模型。模型是会话级的，有三种设法：/model、session.selectModel，或建会话时传 agentOptions。设定后记进会话日志（model/selection 事件和请求 header），重启后沿用。整个进程只有一个全局默认模型（agentDefaultModel）。
坑：session.selectModel 会在后台把这次选择同时存成全局默认。
preset 能固定模型的只有它的子代理：dsh-tool-subagent 的 agentOptions 可以固定子级 provider/model，modelSelectionSettings 可以让模型从白名单里挑。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/lib/index.js Config 中没有 model 字段
  - 证据：dsh-src/@deepseek-ai/dsh-agent-default-model/README.zh.md 已知限制「单一的进程级默认值——按会话的模型选择仍由入口负责」
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:279-320 selectionFor：pending → 已记录的 request header → 全局默认
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:155-185，:175 void this.ctx.agentDefaultModel.saveSelection(selected)
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent/lib/index.js:311-324 Config: agentOptions{provider,model,reasoningEffort,maxTokens}/agentPreset/allowedAgentPresets/maxDepth/modelSelectionSettings
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent/README.zh.md「选择子级 preset」「选择子级 LLM」
- **C7***（依据：both；对应 R1, R4）AGENTS.md 按会话工作目录加载。会话首轮会注入两条指令链：
1. 用户全局链：~/.dsh/AGENTS.md、~/.agents/AGENTS.md，所有会话都会加载；
2. 项目链：从最近一个含 .git 的祖先目录（找不到就用 cwd 本身）一路到会话 cwd，每层的 AGENTS.md/CLAUDE.md，以及 AGENTS.local.md/CLAUDE.local.md。
注入总预算 maxBytes 为 65536 字节。文件名可以在 preset 的 agent-instructions 行里改（instructionFileCandidates / localInstructionFileCandidates，不能带路径分隔符）。Agent 用 read/write/edit 碰到 cwd 以下更深的目录时，才会追加那一层的指令；只认 cwd 的子孙目录。指令以 user 消息形式注入；上下文压缩后基线如果看不到了，下一步会重新注入。因此「一个机器人一个目录 + 自己的 AGENTS.md（还可以把 MEMORY.md 配成 local 候选文件）」能做到按目录隔离指令和身份。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-instructions/README.zh.md「agent 获得的内容」「配置」「已知限制」
  - 证据：dsh-src/@deepseek-ai/dsh-agent-instructions/lib/index.js:16-31 默认候选与 Config；:480-496 userGlobalRoots；:574-582 findProjectRoot（无标记返回 cwd）；:609-615 descendantDirsBetween（只认 cwd 子孙）；:1243-1300 基线不可见时重新组装注入
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:578 宿主层 agent-instructions disabled；standard.patch.yml 在 preset 内挂载（maxBytes: 65536）
  - 证据：本机 /Users/bytedance/.dsh/AGENTS.md 与 /Users/bytedance/.agents/AGENTS.md 都不存在（ls 结果）
- **C8**（依据：both；对应 R1）每个机器人可以有自己的技能集合。skill 注册表分两层：宿主层加每个 preset 一层，每个 preset 带自己的 skill-filesystem 行。发现顺序按会话 cwd：
1. <项目根>/.dsh/skills、<项目根>/.agents/skills（项目根同样是最近的 .git 祖先或 cwd 本身）；
2. preset 配的 customSkillDirs；
3. 全局 ~/.dsh/skills、~/.agents/skills。
设 includeDefaultRoots:false 就只看自己配置的根。技能的增删改由 watcher 热更新，不用重启。缺点是默认会同时看到全局技能，本机 ~/.agents/skills 有 132 项。
  - 证据：dsh-src/@deepseek-ai/dsh-skill-filesystem/README.zh.md「根目录与优先级」表
  - 证据：dsh-src/@deepseek-ai/dsh-skill-filesystem/lib/index.js:150-188 roots(cwd)；:27 DEFAULT_WATCH_MAX_PROJECTS = 128（超出时按最旧淘汰监听）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:510-519「a preset's skill-filesystem registers into that preset's layer」
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml:125 customSkillDirs 示例
  - 证据：dsh-src/@deepseek-ai/dsh-tool-skill/README.zh.md「技能发现、目录更新与显式技能调用均使用 Session 的当前工作目录」
  - 证据：ls /Users/bytedance/.agents/skills | wc -l → 132
- **C9**（依据：both；对应 R7, R1）每个机器人的权限边界（R7）：
- 权限档位按会话设：沙箱 read-only/workspace-write/danger-full-access，加审批 ask/never；可以在建会话时设，重启后保留。
- workspace-write 的写边界是会话「初始 cwd」，之后不可改；即使 Agent 切换了工作目录，边界也不变，所以机器人之间的写操作是隔离的。但读不隔离：fs-sandbox 只拦写入。
- preset 本身不是安全边界：YAML 和插件能执行宿主代码。但 preset 可以通过少挂工具行来收窄能力。
- 审批可以挂「只管某一个 agent」的应答者；never 是无人值守的严格模式。
- 归档会话时传 stopActivity:true，可以一键停掉它的回合、子代理、后台任务和提醒。
  - 证据：dsh-src/@deepseek-ai/dsh-permission-presets/README.zh.md「会话默认值」「之后的设置变更绝不会改变现有会话」
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox-policy/lib/index.js:145 workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ...)
  - 证据：dsh-src/@deepseek-ai/dsh-fs-sandbox/lib/index.js:157,164 FS_SANDBOX_DENIED（只对写入）；README「保留本地文件系统的读取行为」
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md「preset 不是安全沙箱：YAML 及插件可以执行 Host 代码」
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/README.zh.md「限定到 agent 的监听器只接收该 agent 的请求」「never…无人值守运行采用的严格无头模式」；lib/index.js:98 setPolicy(agent, policy)
  - 证据：dsh-src/@deepseek-ai/dsh-workspace/README.zh.md archiveSession(sessionId, { stopActivity: true })

## 限制清单（* 为承重结论）

- **L1*** preset 的增删改只能走「写 bundle/patch 再安装」，属于改宿主配置的高权限操作。模型通过 plugin_manager 安装要 Full access 或逐次批准；宿主插件直接调 installBundle 不经审批，等于完全信任这个插件。客户端没有编辑器。文档前后说法不一致：YAML 注释还写着 Web editor，locale 写着「编辑预设」，但 README 和 client 代码都是只读。另外，老的 ~/.dsh/.agent-presets 目录已不再读取。这些都说明这块接口近期变过。
  - 影响：「每个机器人一个 preset」做不到在界面里一键生成，需要自写「机器人工厂」插件来生成并安装 bundle。更稳的做法是少量「角色 preset」，加上每个机器人一个目录和一个会话。这块接口升级后可能再变。
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:2「Edits saved from the Web editor override this row's config.plugins」
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-agent-preset/locale/zh.json「并编辑预设使用的插件」 与 README.zh.md「Web 不创建也不编辑 preset」矛盾
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md「Migrate a legacy preset…Nothing reads that directory any more」
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md「已安装的 Host 代码在宿主进程内运行，不受工作区沙箱限制」
- **L2*** 会话开跑后 preset 锁定，不能中途更换；fork 出来的会话也继承原 preset。
  - 影响：机器人的能力组合在第一轮就定型。要升级某个机器人的能力，只能改它的 preset 后重启 App，或者让它换一个新会话；新会话靠目录里的 AGENTS.md 和记忆文件延续身份。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:753 agent-preset/locked
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:216 起 fork 复用源会话 preset
- **L3*** preset 不能带模型；而通过 session.selectModel 或界面的 /model 给某个会话换模型时，会顺带把全局默认模型也改掉。
  - 影响：「巡检用便宜模型、干活用强模型」只能在会话层面做：建会话时用 agents.create 的 agentOptions 指定模型，或在 preset 里用 subagent 的 agentOptions 固定子代理的模型。通过界面给某个机器人换模型，会影响之后新建的所有会话。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:175
  - 证据：dsh-src/@deepseek-ai/dsh-agent-default-model/README.zh.md 已知限制
- **L4** preset 被删除或改名后，绑定它的会话无法恢复（报 agent-preset/not-found）。修改 preset 后，老会话在 App 重启时会自动换成新定义，没有版本固定；进程退出后旧代际的实现不保留。
  - 影响：机器人的 preset id 要当成永久 id 来管理，不能随便删。改一个 preset，就等于改了所有用它的机器人；被删 preset 的机器人，定时唤醒也会因恢复失败而失效。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:418-432
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md「进程退出后不保存旧代际的插件实现」
- **L5** 自定义 preset 是整份插件清单的拷贝，不会继承内置清单的后续更新。在 Desktop/Web 里，很多能力只在 preset 内部挂载，宿主层是禁用的：上下文压缩（compaction）、goal 的命令和工具、schedule 的四个提醒工具、time-context、agent-instructions、skill-filesystem/tool-skill。自定义 preset 漏写哪一行，机器人就没有那项能力；比如没有 compaction 组，长期运行的会话就不会自动压缩。
  - 影响：写机器人 preset 时，要以 standard.patch.yml 为模板整份复制，并在每次升级后对照更新。这和「升级后插件接口常变」的老问题会叠加在一起。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md「用户覆盖替换完整子插件列表，不自动合并内置列表的未来更新」
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:465 起「the agent plane moves behind agent presets」，:531 tool-goal、:544 compaction-basic、:578 agent-instructions 宿主行 disabled；:135-137「reminder tools belong to the standard, cordis, and ptc presets」
- **L6** 每个 preset 在注册时就整树预加载（eager），里面的 MCP 连接、skill 监听器等即使没有会话在用也会启动。preset 数量没有硬上限，但越多启动越慢、资源占用越多（没有实测数字）。
  - 影响：「一人一个 preset」在机器人数量多时有资源成本，用共享的角色 preset 更省。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:491 record.ready = this.activate(record)
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md「Preset revisions are eagerly activated once」
- **L7** 身份隔离不等于安全隔离：
(a) 读不隔离；
(b) 宿主层的 working_directory 工具在 base 里启用、web-app 没有禁用，Agent 可以用它把 cwd 切到别的机器人目录，之后就会加载对方的 AGENTS.md 和项目技能（写边界不变）；
(c) 全局的 ~/.dsh/AGENTS.md、~/.agents/AGENTS.md、~/.agents/skills 对所有机器人共享；
(d) bash 的 cd 不会触发指令发现，外部改动的文件要等下一次 read/write/edit 才会刷新进上下文。
  - 影响：机器人的核心身份最好写进 preset 的 persona（系统提示词），AGENTS.md 只放可变部分；需要屏蔽 working_directory 工具。几个机器人的目录不要放在同一个 git 仓库下面；如果放了，仓库根的 AGENTS.md 会成为共享的「全体守则」。
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:169-170 tool-working-directory（宿主层，web-app patch 未禁用）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-working-directory/lib/index.js:17 name: "working_directory"
  - 证据：dsh-src/@deepseek-ai/dsh-agent-instructions/README.zh.md 已知限制「发现跟随结构化 fs 工具」「刷新由 touch 驱动」
- **L8** 子代理和 Agent Team 队友都不适合当独立机器人：
- subagent 依附父会话：并发上限默认 8（maxActiveSubagents），委派深度默认 1；
- Agent Team 是实验功能：队友共享 Lead 的 cwd，最多 16 人，不支持独立工作目录。
  - 影响：它们适合当某个机器人的「手下」，不适合承载独立的身份、家目录和长期目标。
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:2980 maxActiveSubagents default(8)
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent/README.zh.md maxDepth「Host 设置（1）」
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/README.zh.md「不支持独立工作目录」「maxMembers 16」「成员共享 cwd」
- **L9** token 成本：每个机器人会话首轮都会注入技能目录，每条描述上限 500 字符，本机全局 132 个技能都会进每个机器人的上下文。AGENTS.md 或记忆文件每被自己改写一次，就会往历史里追加一份完整的替换内容，直到下次压缩。
  - 影响：在「每 5 小时用量上限」下，多个机器人同时跑会很快耗光额度，需要精简全局技能、控制记忆文件的大小。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-skill/README.zh.md catalogDescriptionMaxLength 500
  - 证据：dsh-src/@deepseek-ai/dsh-agent-instructions/README.zh.md「已改变或移除的指令上下文」Token 影响
- **L10** 「活动会话已达上限 2」不是 DSH 宿主的限制，而是用户自写桥插件的护栏：DEFAULT_MAX_ACTIVE_SESSIONS = 2，可在它自己的 settings.json 里调到 1-4。dsh-taskboard 默认并发是 3。本路在宿主的 agent、session-controller、llm、schedule 代码里没有找到顶层会话的并发上限（不确定，交 R9 路确认）。
  - 影响：机器人数量的瓶颈主要在订阅用量和自写插件的护栏，未必在 DSH 本身。
  - 证据："/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js":53-55, 161, 309-313
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/lib/host/execution.js:264 maxConcurrent ?? 3

## 核查结果

- **C1：部分成立**。原结论：可同时声明多个彼此独立的 preset；每个 preset 是一份完整插件清单，可各配 persona（complete:true 完全替换系统提示词）、工具行（含按作用域隔离的 MCP 客户端）、skill-filesystem 技能根、agent-instructions 规则、subagent 委派默认值；按 config.id 区分，重复注册失败；注册表用 Map，无数量上限常量。
  - 核查说明：主体成立，lib 代码确认：AgentPreset.Config 只有 id/name/description/order/plugins；register() 检查空 id 和重复 id（抛出 Duplicate agent preset）；definitions 是 Map，registry 和 mount 里都没有数量上限常量；persona 的 complete:true 由 dsh-system-prompt 强制成唯一的系统段（同时出现两个 complete 段会报错）；mcp-client 按 scopeOf(ctx) 预留 serverName。
需要修正三点：
1）「完整的插件清单」不对。preset 是叠加在共享宿主层上的一层：dsh-base 里没被 dsh-web-app 禁用的宿主行，对所有 preset 的会话都生效。例如 tool-working-directory（working_directory 工具）、宿主层配置的 MCP 服务器（子作用域会继承）、system-prompt 部署段、sandbox/approval/permission、schedule/goal 服务、subagent 注册表和 maxActiveSubagents。preset 写 YAML 去不掉这些宿主工具；要按 Agent 屏蔽，只能自写插件调 ctx.tools.restrict()，官方包里只有 dsh-subagent 用了它。
2）「彼此独立」只到 preset 这一层。同一 preset 版本的插件树只激活一次，被所有选它的会话共享，所以 preset 里有状态的插件（如 MCP 连接）是按角色共享的，不是每个机器人一份。
3）激活失败的 preset 不会注册失败，而是带 broken 诊断留在列表里，之后用它新建或恢复会话会抛 agent-preset/invalid。
补充：SKILL 文档要求 id 只用小写字母、数字、连字符，代码只检查非空和不重复。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/lib/index.js:13-19 Config 只有 id/name/description/order/plugins（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:446 definitions = new Map()；:472-473 空 id 与 Duplicate agent preset；grep 无 max/limit 常量（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-system-prompt/lib/index.js:381-403 complete 段唯一化，多个 complete 段抛错（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-mcp-client/lib/index.js:774-819 activeServerNames 按 scopeOf(ctx) 预留 serverName（lib）；README.zh.md:127（README）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:169-170 tool-working-directory 是宿主行；dsh-web-app/cordis.patch.yml 与 presets/*.patch.yml 中 grep 不到 working-directory 和 mcp（未禁用）
  - 证据：dsh-src/@deepseek-ai/dsh-tools/README.zh.md:85 ctx.tools.restrict 对单个 agent 继承的全局工具做掩码（README）；全部 lib 里只有 dsh-subagent 调用 tools.restrict（grep）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:78「Preset revisions are eagerly activated once and shared by their selecting Agents」；:14 id 格式要求（文档）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:632-648 retain() 对 broken 定义抛 agent-preset/invalid（lib）
- **C2：部分成立**。原结论：preset 没有增删改 API，客户端只读（Web 只调 agentPresets.list/read/select，YAML 查看器只读）；新建或修改 preset 的唯一官方途径是写 bundle 再用 plugin_manager installBundle 安装；创造模式就是让 Agent 代写并安装 bundle；模型经工具安装需 Full access 或逐次批准。
  - 核查说明：对的部分（README 和 lib 都确认）：Remote 只有 list/read/select；Web 端 client.js 只调 agentPresets.list/read/select，唯一的写操作是用 settings.update 写默认值 selectedDefault，不碰 preset 定义；YAML 查看器只读；plugin_manager 工具要求 danger-full-access 或逐次批准；创造入口就是开一个 cordis preset 会话，由它代写并安装 bundle。
「没有增删改 API」和「唯一官方途径」都说过头了：
1）宿主层有运行时注册接口。ctx.agentPresets.register(definition) 会立即激活一个 preset 并返回 unregister，dsh-tool-cordis 的宿主 API 目录也把它列为 agentPresets 的方法。它只存在内存里、不落盘，没有开放给 Remote/Web，README 也没写成对外用法。宿主插件用它不需要 bundle、不跑 pnpm，也不经审批。
2）宿主插件可以调 ctx.configEditor.edit(entry, change)，把已有 preset 行（如 preset-standard）的完整 config 覆盖写进 profile patch，并经 Loader 实时生效，同样不经审批。registry 的 mount.js 注释「only the profile configuration editor persists definitions」和 YAML 注释里的「Edits saved from the Web editor」，指的就是这条路。它只能覆盖已有行，不能插入新行。
3）profile 自己的 cordis.patch.yml 和 ~/.dsh/cordis.patch.yml 是官方补丁层：模板注释写明支持 insert 列表，HMR 也监听这两个文件。所以直接写一个 insert 行就能新建 preset，读者在问题 2 的回答里也这样写过。
4）用户在 Web 侧栏的「插件」页也能手动安装 bundle，不一定要走创造模式。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:396-398 Remote 只有 list/read/select；:470-493 register(definition) 返回 unregister（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js key 'agentPresets' 下列出 async register(definition: PresetDefinition)（官方宿主 API 目录）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js 只出现 agentPresets.list/read/select 和 settings.update 写 selectedDefault（lib，grep）；README.zh.md 已知限制「Web 不创建也不编辑 preset」
  - 证据：dsh-src/@deepseek-ai/dsh-config-editor/lib/index.js:30-35 entries()（根 include 下可唯一定位的行），:69-130 edit() 写 profile patch 并 reconcile（lib）；README.zh.md「编辑完整配置的调用方可使用 ctx.configEditor.edit()」
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/types/mount.js:6「only the profile configuration editor persists definitions」
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:593 PROFILE_PATCH_TEMPLATE「id-targeted config overrides, disables, and insert lists」
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js:93-97 approveEscalation(requestedMode danger-full-access)（lib）；README.zh.md:31 插件页管理组合包
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md「Nothing edits a declaration in place」（文档口径）
- **C3：部分成立**。原结论：新装或改动 preset 默认不必重启：desktop 默认开 HMR，plugin manager 改完在线重组（applied），只有没开 HMR 时才返回 restart-required；HMR 监听 profile 和 ~/.dsh 的 cordis.patch.yml；在跑会话用旧版本，新会话用新定义，App 重启后老会话按 id 换成当前定义。
  - 核查说明：核心成立（lib 确认）：hmr 行只在没有 profileContext 时禁用，而 profile-boot 会 provide('profileContext')，所以桌面版默认开 HMR；HMR 监听 profile.patchPath 和 <DSH_HOME>/cordis.patch.yml，变了就调 reconcileProfile；在跑的 Agent 继续持有旧代际，重启后恢复时按 id 取当前定义。
需要修正：
1）「只有没开 HMR 才返回 restart-required」不准确。有 HMR 时结果初值是 applied，但只要 reconcileProfile 返回 restartReason 或 pending（宿主模块变了、package-moved 等），也会改报 restart-required。
2）有 HMR 时，installBundle 会直接拒绝已安装的包（already-installed）。靠 bundle 声明的 preset 想改，只能先卸载再安装；这中间 preset id 不存在，新建或恢复用它的会话会失败。改 profile patch、调 configEditor.edit 或 agentPresets.register 可以避开这个空窗。
3）patch 文件监听开了 awaitWriteFinish（约 2 秒稳定窗口），而且只有 bundle 列表或那两份 patch 的内容真变了才会重组；bundle 自己目录里的 cordis.patch.yml 不在监听范围内（由代码推断，未实测）。
4）前提仍未核实：ls 显示 /Users/bytedance/.dsh/cordis.patch.yml 存在，按禁区没读，里面可能覆盖 hmr 设置。
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:27-31 hmr disabled: !!js !ctx.get('profileContext')
  - 证据：dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:304 hostCtx.provide('profileContext', ...)（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-hmr/lib/index.js:849-873 patchFiles = [profile.patchPath, home/cordis.patch.yml]，内容未变则 return；:56 awaitWriteFinish: true（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/index.js:2361-2371 reload 带回 restartReason/pending；:2378-2388 有 HMR 时也可能改成 restart-required；:1991 HMR 下 already-installed（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md:100「有 HMR 时…installBundle() 在运行 pnpm 之前以 already-installed 拒绝安装」（README）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:418-432 resumeObserved → composeAgent(presetForObservation)（lib）；dsh-agent-preset-registry/README.zh.md「重启恢复使用该 ID 的当前定义，缺失时拒绝恢复」
  - 证据：ls：/Users/bytedance/.dsh/cordis.patch.yml 存在（未读，禁区）
- **C4：成立**。原结论：机器人实例（顶层会话）可由宿主插件在运行时批量创建、无需重启，三条路：sessionController.create({workspaceId 或 cwd, agentPreset})；像 dsh-taskboard 那样 agents.create(...agentOptions, setup: agentPresets.mount)；workspaceRegistry.create 登记目录后用 permissionPresets.set 或 /permission 设权限。dsh-bridge 和 dsh-taskboard 已在用。
  - 核查说明：三条路和两个插件的用法都在 lib 里核实了。
补充细节：
1）session.create 的 workspaceId 和 cwd 只能二选一，传 cwd 时会自动 mkdir；它不收模型参数，新会话从全局默认模型起步。
2）workspaceRegistry.create 要求目录已经存在；title 参数在 README 的开发备注里已列为准备删除，属于易变接口。
3）不管走哪条路建会话，宿主都会在 session/created 时钉上默认权限档（默认 workspace-write，审批策略 ask）。
4）agents.create 这条路绕开了 session-controller 的 installSelection，模型完全由 agentOptions 决定。
5）用户遇到的「活动会话已达上限 2」来自 dsh-bridge 自己的护栏（DEFAULT_MAX_ACTIVE_SESSIONS = 2，可调 1 到 4），不是 DSH 的限制；dsh-taskboard 也有自己的 maxConcurrent，默认 3。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:112-149 create()：workspaceId 与 cwd 二选一（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:565-585 createAgent 先 mkdir(cwd)，agentOptions() 取 agentDefaultModel.currentSelection()（lib）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:309-358 opStart（create→rename→/permission→selectModel→prompt→/goal）；:54 DEFAULT_MAX_ACTIVE_SESSIONS = 2；:161 范围 1~4；:311-312 上限报错
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js:46 inject sessionController/workspaceRegistry/commands/agents；:130 workspaceRegistry.create(path)
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/lib/index.js:160-169 composeAgent（presets.resolve + presets.mount）；:189-194 permissionPresets.set；lib/host/execution.js:402-415 agentOptions；lib/shared/protocol.js:145-147 maxConcurrent 默认 3
  - 证据：dsh-src/@deepseek-ai/dsh-workspace/lib/index.js:408-412 create 要求是已存在目录（lib）；README.zh.md:184-188 title 参数待移除（README）
  - 证据：dsh-src/@deepseek-ai/dsh-permission-presets/lib/index.js:202-205 session/created → pinInitialPermission；:344 set(session, name)（lib）
- **C5：成立**。原结论：会话固定绑定 preset：日志 header 和 agent-preset/selected 记录 id；只有未开始首轮的空白会话能切换，开跑后 select 报 agent-preset/locked；fork 继承原 preset；恢复按记录 id 取当前定义，id 不存在则恢复失败（agent-preset/not-found）。
  - 核查说明：README 和 lib 一致。
补充：
1）fork 和重启恢复拿到的都是这个 id 的「当前」定义，不是原来那个版本；只有子代理走 composeFrom，才会加入父会话的同一个版本。
2）定义激活失败（broken）时，retain 抛 agent-preset/invalid，恢复同样失败。
3）通过 resolveAgent 恢复时（UI 打开会话、dsh-schedule 投递提醒都走这条），这类错误会被包装成 gateway/internal「resume failed for session …」，原始 code 只剩在消息文本里。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/types/session.js init: header.agentPreset，apply: agent-preset/selected（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:750-768 select()，:753 openTurnStartSeq/lastTurn 判定后抛 agent-preset/locked（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:596-607 resolve 抛 agent-preset/not-found；:632-648 retain 抛 agent-preset/invalid（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:255 fork 用 presetForObservation(source)（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:209-256 resolve() 把其他错误包成 gateway/internal；:418-432 resumeObserved（lib）
- **C6：部分成立**。原结论：模型不属于 preset（Config 无 model，内置 preset 都没写）；模型是会话级的，可用 /model、session.selectModel 或建会话时传 agentOptions；记进会话日志、重启沿用；全局只有一个默认模型；selectModel 会顺带存成全局默认；preset 只能用 dsh-tool-subagent 的 agentOptions 固定子级模型，或用 modelSelectionSettings 让模型从白名单里挑。
  - 核查说明：主体成立：preset 的 Config 没有 model 字段，四个内置 preset 都没写模型；selectModel 记一条 model/selection 事件，并在后台保存成全局默认（lib 和 README:91 都写明）；selectionFor 依次取 pending、已记录的 request header、全局默认；进程里只有一个默认模型。
需要修正的条件：
1）/model 弹窗和 composer 模型位底层都调 session.selectModel，其实是同一种方式。「建会话时传 agentOptions」只有宿主插件直接调 agents.create 时才能用：Remote 的 session.create 不收模型参数，fork 出来的子会话 agentOptions 也取全局默认。
2）子代理白名单不归 preset 管。modelSelectionSettings: true 只是让工具在会话创建时去读宿主单例设置 subagent-model-selection-settings（enabled 默认 false，allowedModels 默认为空），再把结果快照进会话。用户不在设置里开启，这个开关不起作用；preset 也不能各自定义白名单。
3）子代理工具的 agentOptions 和 agentPreset 只有进程内 spawn 支持，fork 会拒绝；fork 子代理沿用父级模型。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/lib/index.js:13-19 无 model 字段（lib）；dsh-web-app/presets/*.patch.yml grep model 只命中 {{model}} 模板和 modelSelectionSettings: true
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:155-185，:175 saveSelection；:270 fork 子会话 agentOptions 取全局默认（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/README.zh.md:91 selectModel 不等默认值保存、后台按序保存（README）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:279-320 selectionFor 顺序（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-model-selection/README.zh.md:76 /model 与 composer 都经 session.selectModel 提交（README）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent/lib/model-selection-settings.js:41-63 enabled 默认 false、allowedModels 默认 []（lib）；dsh-web-app/cordis.patch.yml:66-67 该服务是宿主行
  - 证据：dsh-src/@deepseek-ai/dsh-tool-subagent/lib/index.js:311-324 Config；README.zh.md:68、:76、:241 只有进程内 spawn 支持 preset/LLM 选择，fork 继承父级模型（README）
- **C7：部分成立**。原结论：AGENTS.md 按会话工作目录加载：首轮注入用户全局链（~/.dsh/AGENTS.md、~/.agents/AGENTS.md）和项目链（最近 .git 祖先或 cwd 到 cwd 每层的 AGENTS.md/CLAUDE.md 及 .local 文件），预算 65536 字节；文件名可在 preset 的 agent-instructions 行改；只在 read/write/edit 触到 cwd 子孙目录时追加；以 user 消息注入，压缩后重注入；所以一个机器人一个目录加自己的 AGENTS.md（可把 MEMORY.md 配成 local 候选）能按目录隔离指令和身份。
  - 核查说明：加载机制都在 lib 里核实了：用户全局链只认 AGENTS.md（USER_GLOBAL_FILE），两个全局根都没有 local overlay；找不到 .git 时项目根就是 cwd；嵌套发现只认 cwd 的子孙目录；候选文件名里带路径分隔符的会被静默过滤，不会报错；基线看不到时会重新组装注入；maxBytes 65536 写在 standard、ptc、cordis 三个 preset 里。
但「按目录隔离身份」要加三个前提：
1）preset 必须挂 agent-instructions 行。web-app 已经把宿主层的这一行禁用了，内置 minimal 就没有它；自定义的机器人 preset 漏了这一行，就完全读不到 AGENTS.md。
2）指令链按会话的「当前」工作目录计算（ctx.workingDirectory.ensure），README 也写了切换工作目录后会重新加载项目指令链。working_directory 是宿主层工具，preset YAML 去不掉；机器人 cd 到别人目录就会换上别人的指令。写入边界则固定在不可变的 SessionHeader.cwd 上。
3）机器人目录不能嵌套。如果某个「管理者」机器人的 cwd 是其他机器人目录的祖先，它对这些子目录做 read、write 或 edit 时，会把子机器人的 AGENTS.md 当成嵌套指令加载进来。
另外，把 MEMORY.md 配成 local 候选有代价：每次修改都会整份重新注入一条「Updated instructions from」user 消息（受 maxBytes 限制），频繁写记忆会持续涨 token；而且只有第一方 read、write、edit 才触发刷新，用 bash 改的要等下一次 touch 才生效。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-instructions/lib/index.js:16-31 默认候选与 Config；:87 含路径分隔符的候选被 filter；:168 USER_GLOBAL_FILE = AGENTS.md；:574-582 findProjectRoot；:609-615 descendantDirsBetween；:1243 ctx.workingDirectory.ensure(agent)；:1234-1310 基线不可见时重新组装（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-instructions/README.zh.md:28 切换工作目录后重新加载；:192 Updated instructions from；:219-221 已知限制（README）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:578-579 宿主 agent-instructions disabled；presets/minimal.patch.yml 全文没有 agent-instructions 行
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:169-170 tool-working-directory 是宿主行
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox-policy/README.zh.md:48、:54、:76 写入根为不可变 SessionHeader.cwd（README）
  - 证据：ls：/Users/bytedance/.dsh/AGENTS.md 和 /Users/bytedance/.agents/AGENTS.md 都不存在
- **L1：部分成立**。原结论：preset 增删改只能写 bundle/patch 再安装，属高权限操作；模型经 plugin_manager 安装要 Full access 或逐次批准，宿主插件直接调 installBundle 不经审批；客户端无编辑器；YAML 注释写 Web editor、locale 写编辑预设，与 README 和代码矛盾；旧 ~/.dsh/.agent-presets 已不读取。影响：每个机器人一个 preset 需自写机器人工厂插件生成并安装 bundle，更稳的是少量角色 preset 加每个机器人一个目录和会话。
  - 核查说明：列举的事实都核实了：审批只在 plugin_manager 工具层（tools.js），PluginManager.installBundle 服务方法本身不审批；Web 只读；YAML 注释和 locale 里的说法与 README 冲突；lib 里没有任何读取 .agent-presets 目录的代码。
需要修正：
1）「增删改只能写 bundle 或 patch 再安装」不准确。宿主插件可以直接调 ctx.agentPresets.register()，运行时注册或注销 preset（只在内存里，进程重启后要由插件重新注册）；也可以调 ctx.configEditor.edit() 覆盖已有 preset 行。这两条都不经审批，也不需要 bundle 和 pnpm。所以「机器人工厂」插件不一定要每个机器人生成并安装一个 bundle：它可以自己保存定义，每次启动时 register。风险在启动顺序：工厂插件必须在会话恢复和定时投递之前完成注册，否则对应会话会恢复失败（未实测）。
2）安全面比描述的更宽：会话已经是 danger-full-access 时，approveEscalation 直接放行，所以 Full access 加创造（cordis）preset 的会话可以无人审批地往宿主装代码。preset YAML 里的 !!js 本身就是宿主代码执行，registry README 也写明「preset 不是安全沙箱」。
3）「少量角色 preset，加每个机器人一个目录和一个会话」的建议仍然合理：每个 preset 启动时都要整树激活，每次 list 都要重新审计。
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js:93-97 审批只在工具层；lib/index.js:1970 installBundle 服务方法无审批（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:470-493 register/unregister（lib）；dsh-tool-cordis/lib/types/api-catalog.js 列出 agentPresets.register（宿主 API 目录）
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox/lib/index.js:99-101 effectiveMode 等于请求模式时直接返回（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml:131-133 创造 preset 启用 tool-plugin-manager；standard.patch.yml:123-125 disabled: true
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:2-3（四个 preset 文件同样）「Edits saved from the Web editor」；dsh-client-ui-agent-preset/locale/zh.json:4「并编辑预设使用的插件」
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md「Nothing reads that directory any more」；全部 lib grep 没有读取 .agent-presets 的代码
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md 已知限制「preset 不是安全沙箱：YAML 及插件可以执行 Host 代码」
- **L2：部分成立**。原结论：会话开跑后 preset 锁定、fork 也继承原 preset；影响：机器人能力组合在第一轮定型，升级能力只能改 preset 后重启 App 或换新会话，新会话靠目录里的 AGENTS.md 和记忆文件延续身份。
  - 核查说明：「开跑后锁定、fork 继承」成立。但「能力组合在第一轮就定型，只能改 preset 后重启或换会话」说得太绝对：
1）冻结的只是 preset 这一层的行列表和 config。宿主层新增的工具、宿主层 MCP 服务器、全局和 cwd 下的技能（watcher 热更新）、AGENTS.md 内容，都会实时传到在跑的会话，因为子作用域会继承祖先的贡献。
2）HMR 发现 preset 里某个插件的代码文件变了，会让 preset 行用新代码原地重启（hmr README 已知限制里写明）。所以只改代码、不改组合的升级，在跑的机器人不用重启就能拿到。
3）要换组合确实得等 Agent 重建。session-controller 建会话或恢复后只保留 .agent、丢掉 AgentHandle，代码里也没找到空闲回收，所以实际上就是重启 App。
4）fork 继承的是这个 id 的当前定义，不是原来那个版本。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:753 agent-preset/locked（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:255 fork 用 presetForObservation(source)（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-hmr/README.zh.md 已知限制「profile 组合之外的行（例如 preset 行…）以替换后的代码重启，不经检查」（README）
  - 证据：dsh-src/@deepseek-ai/dsh-scope/README.zh.md 概述「子作用域继承祖先贡献」；dsh-mcp-resources/README.zh.md:57「继承的提供方与工具仍然可见」
  - 证据：dsh-src/@deepseek-ai/dsh-skill-filesystem/README.zh.md:81 技能根被监视，下一步刷新目录
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:565-581 与 :418-432 只返回 .agent；session-controller lib 里 grep 不到 dispose 或空闲回收
- **L3：成立**。原结论：preset 不能带模型；用 session.selectModel 或界面 /model 给会话换模型会顺带改全局默认。影响：分模型只能在会话层（agents.create 的 agentOptions）或 preset 的 subagent agentOptions 实现；界面换模型会影响之后新建的所有会话。
  - 核查说明：已核实（lib 加 README）。补充三点：
1）全局默认一改，影响的不只是之后新建的会话：从没发过请求的已有会话（没有 request header，也没有 pending 选择）和 fork 出来的子会话都会跟着变。
2）经 Remote 或 bridge 建的会话没法在创建时定模型，只能事后调 selectModel，这会顺带改掉全局默认。用户的 dsh-bridge 在 req.model 有值时正是这样调的：每派一个指定模型的任务，全局默认就被改一次。要干净地按机器人定模型，只能由宿主插件直接调 agents.create 并传 agentOptions（dsh-taskboard 就是这么做的）。
3）子代理的模型白名单是宿主全局设置，默认关闭（见 C6）。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js:175（lib）；README.zh.md:91（README）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-model-selection/README.zh.md:76 /model 与 composer 都走 session.selectModel
  - 证据：dsh-src/@deepseek-ai/dsh-agent-default-model/README.zh.md 已知限制「单一的进程级默认值」
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:279-320 无记录时回退全局默认；commands.js:270 fork 用全局默认（lib）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:327-339 req.model 存在时调 session.selectModel
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/lib/host/execution.js:402-415 agentOptions 直接定模型

## 核查员补充（读者漏掉的点）

- 宿主层有运行时注册 preset 的接口，读者以为没有。ctx.agentPresets.register(definition) 会立即激活一个 preset 并返回注销函数，已列入官方宿主 API 目录。机器人工厂插件因此能在运行时增删「角色 preset」，不用 bundle、不跑 pnpm、不经审批。代价有三：只在内存里，插件每次启动都要重新注册；必须赶在会话恢复和定时投递之前注册完；README 没写这个接口，升级后可能变。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:470-493 register(definition) 返回 unregister（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js key 'agentPresets' 的 methods 里有 async register(definition)
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md 没提到 register（只在 lib 和 API 目录里）
- preset 少了某些行，机器人就失去主动能力。web-app 已把 agent-instructions、4 个提醒工具（tool-schedule）、tool-goal/command-goal、skill-filesystem/tool-skill、compaction、子代理工具从宿主层禁用、挪进 preset，而 schedule、goal 服务本身留在宿主层。所以机器人用的 preset 必须自带这些行，否则不能给自己定时、不能用 /goal（dsh-bridge 会退化成单轮）、读不到 AGENTS.md、没有技能、不会压缩上下文。内置 minimal 就缺 agent-instructions、tool-schedule、goal、skill 这些行。
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:134-140「reminder tools belong to the standard, cordis, and ptc presets」；:467-585 agent 平面各行 disabled
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/minimal.patch.yml 全文只有 persona、tool-fs、compaction、persistent-shell
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:15-44 agent-instructions、tool-schedule、skill、goal 行
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:346-356 /goal 失败时按普通单轮运行
- preset 缺失或损坏时，机器人会无声停摆。会话恢复和 dsh-schedule 提醒投递都走 sessionController.resolveAgent，再按记录的 preset id 组装；id 不存在（not-found）或定义损坏（invalid）都会失败。schedule 只打一条 warn 日志，并把这些提醒排除出下一次计时，机器人从此不再被定时唤醒，界面上也看不到。所以机器人工厂改名、删除或重装 preset（包括 HMR 下 bundle 卸载再安装的空窗期）都要按「先加新 id，再迁移会话，最后删旧 id」来做。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1576 sessionController.resolveAgent；:1627-1632 catch 后只 logger.warn；:1636 failed 的任务排除出下次计时（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:209-256、:418-432（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:596-607、:632-648（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-plugin-manager/lib/index.js:1991 already-installed（lib）
- 宿主层工具不能按 preset 去掉，这对权限边界（R7）很关键。比如 working_directory 是 dsh-base 的宿主行，dsh-web-app 没禁用它；宿主层的 MCP 服务器也会被所有 Agent 继承。要给某个机器人收窄工具，只能自写一个挂在 preset 里的插件，在 agent 作用域里调 ctx.tools.restrict({ deny })。官方包里只有 dsh-subagent 用了这个接口。
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:169-170
  - 证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2991-2996 restrict() 要求作用域上下文（lib）；README.zh.md:85（README）
  - 证据：dsh-src/@deepseek-ai/dsh-mcp-resources/README.zh.md:57「继承的提供方与工具仍然可见」
  - 证据：grep 全部 lib：tools.restrict( 只出现在 dsh-subagent 和 dsh-tools 自身
- 无人值守的审批问题。新会话默认被钉成 workspace-write 加 approval ask（dsh-base 的三档：read-only/ask、workspace-write/ask、danger-full-access/never）。ask 档下，机器人一要求升权就停下等人点批准；只有 danger-full-access 能完全无人值守，但这一档没有沙箱，而且配上 cordis（创造）preset 后，可以无审批地往宿主装代码。实验性的 Auto review 用当前模型逐次审查，被拒的调用仍转人工，还要多耗 token。权限档不在 preset 里，只能按会话设。
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:239-275 sandbox-policy、approval、permission 三档
  - 证据：dsh-src/@deepseek-ai/dsh-permission-presets/lib/index.js:202-205 session/created 时 pinInitialPermission（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox/lib/index.js:99-120 approveEscalation（lib）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/README.zh.md 概述「被拒绝调用会请求用户审批…消耗额外 token」
- 同一 preset 版本只激活一次，插件树被所有选它的会话共享。preset 里有状态的插件（MCP 连接、凭据、缓存）因此是按角色共享的，不是每个机器人一份。如果每个机器人要用不同的外部账号或 MCP 身份，就得一人一个 preset，或者插件自己按 Agent 区分。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:78
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/types/mount.js:1「Runtime plugin trees shared by Agents selecting one preset revision」（lib）
- 已经装好的 dsh-taskboard（第三方 npm 包，作者 cloader）提供 10 个 taskboard_* agent 工具。其中 taskboard_create 能让一个 Agent 批量建任务卡，可设 cron 周期或 runAt 定时、用 model 钉模型、用 presetId 指定 preset，到时由宿主侧调度新建会话执行，浏览器关了也照跑。这是现成的「由另一个 Agent 批量生成并定时唤醒」的通道，可以直接拿来做原型。局限：每次执行默认新开会话（README 说可选复用项目已有会话），并发默认 3；它是第三方插件，接口稳定性自担。
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/lib/host/tools.js:279 起 taskboard_create（execution.cron/runAt、model）；:355 presetId
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/README.md 开头「10 个 taskboard_* agent 工具」「host 侧调度，浏览器关了照跑」
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/lib/shared/protocol.js:145-147 maxConcurrent 默认 3
- 用户碰到的并发数字都来自插件自己：dsh-bridge 默认 2（可调 1 到 4），dsh-taskboard 默认 3。DSH 官方层面，在 dsh-agent、dsh-agent-loop、session-controller、dsh-session 里只找到子代理的 maxActiveSubagents（默认 8，按每棵激活树算），没找到顶层会话的上限。另外，session-controller 建会话或恢复后会丢掉 AgentHandle，也没找到空闲回收，被唤醒过的机器人会一直常驻宿主进程直到退出。机器人一多，内存和 watcher 会持续增长，需要实测。
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:54、:161、:311-312
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/README.zh.md:53 maxActiveSubagents 默认 8
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js:565-581 只返回 .agent；在 dsh-agent、dsh-agent-loop、dsh-session 里 grep 不到 maxAgents/maxSessions 之类的上限

## 缺口与补法

- [R1 批量生成机器人「类型」｜工作量 M] preset 没有增删改 API，界面只读，只能写 bundle 或 patch。
  - 补法：自写宿主插件：根据机器人清单生成一个 bundle（多行 @deepseek-ai/dsh-agent-preset，以 standard.patch.yml 为模板），调用 ctx.pluginManager.installBundle 安装；有 HMR 时在线生效。也可以改走「少量角色 preset」，不必每个机器人一个 preset。
- [R1 由用户或另一个 Agent 运行时批量生成机器人「实例」｜工作量 M] 模型没有可用的「创建顶层会话」工具：tool-cordis 只读，host-runner 明说没有模型工具能创建动态定义。DSH 里也没有「机器人」概念和名册。
  - 补法：自写插件，提供 bot_create 工具或 Remote。步骤：建机器人目录，写 AGENTS.md/MEMORY.md，workspaceRegistry.create，agents.create（指定 preset，用 agentOptions 定模型），permissionPresets.set，发第一条 prompt 或设 /goal，最后用 dsh-storage-domain 登记名册（名字、目录、preset、模型、主会话 id）。可以直接复用 dsh-bridge 的 opStart 配方。
- [R1/Q4 每个机器人不同模型｜工作量 S] preset 不能带模型；selectModel 会顺带改全局默认。
  - 补法：建会话时用 agents.create 的 agentOptions 指定模型，并记进名册；巡检和干活的分工用 preset 里 subagent 的 agentOptions 固定子代理模型。如果一定要「preset 绑模型」，需要自写插件拦截 agent/request，与会话级选择的先后顺序未验证。
- [R1/Q5 身份不串味｜工作量 S] working_directory 工具能让机器人切到别人的目录；全局 AGENTS.md 和全局技能对所有机器人共享。
  - 补法：在机器人 preset 里加一行自写小插件，用 ctx.tools.restrict 屏蔽 working_directory；核心身份写进 preset 的 persona；机器人目录不放在同一个 git 仓库下；不往 ~/.dsh/AGENTS.md、~/.agents/AGENTS.md 写私人身份。
- [R1/Q5（兼 R4）记忆文件随身｜工作量 S] 默认只认 AGENTS.md/CLAUDE.md 及其 .local 文件。
  - 补法：改配置：在机器人 preset 的 agent-instructions 行设 localInstructionFileCandidates: [AGENTS.local.md, MEMORY.md]（只能写文件名，不能带路径），并注意总预算 maxBytes。
- [R1/Q6 每个机器人只看自己的技能｜工作量 S] 全局 ~/.agents/skills（132 项）默认对所有机器人可见。
  - 补法：两种改法：(1) 给需要严格隔离的机器人单独建 preset，skill-filesystem 设 includeDefaultRoots:false 加 customSkillDirs:[绝对路径]；(2) 保持默认，只用 <机器人目录>/.agents/skills，同时精简全局技能。
- [R7 每个机器人的用量或花费预算｜工作量 M] 没有找到 preset 级或会话级的预算字段（只搜到 thinking token 预算相关字段）。
  - 补法：自写插件，按会话累计 token（token meter 或 agent/request 钩子）；超额后降为 never、cancel 或归档会话。
- [R7 无人值守时的审批｜工作量 M] 默认 ask 需要有人点批准；Auto review 被拒后仍然要人审，而且额外耗 token。
  - 补法：机器人会话设成 never（越权就拒绝）；或自写一个只管某个 agent 的审批应答者：白名单内自动批准，其余推到飞书等人处理。
- [R10 自定义 preset 跟上升级｜工作量 S] 自定义 preset 是整份拷贝，不继承内置清单的更新。
  - 补法：由机器人工厂从当前版本的 standard 清单重新生成；每次升级后做一次 diff 检查（流程或脚本）。

## 可调用的宿主接口

- `ctx.agentPresets（服务名 agentPresets；Remote：list/read/select；事件 agent-preset/selected）`：列出 preset 及其加载诊断；resolve(id) 校验 preset；mount(agentCtx, id) 把新建的 Agent 绑到某个 preset；select(agent, id) 给空白会话切换 preset；composedPreset 查询某会话用的 preset；inspectCompositions / compositionInventory 用于中心页展示每个机器人的组成。
- `ctx.sessionController（namespace session）：create/selectModel/rename/prompt/fork/cancel/list`：机器人工厂建会话用 create({workspaceId 或 cwd, agentPreset})，再 rename 起名、prompt 发第一条任务；list 返回的条目里带 agentPreset、modelSelection 等投影，可以给中心页用。
- `ctx.agents.create / resume（配合 agentPresets.mount 作为 setup）`：建会话时一次传齐 cwd、agentPreset 和 agentOptions{provider, model, reasoningEffort}，不会改动全局默认模型；dsh-taskboard 用的就是这条路。
- `ctx.workspaceRegistry（create/get/list/attachSession/archiveSession；事件 workspace/session-activity、workspace/session-stop）`：每个机器人目录登记成侧边栏里的一个项目；用 archiveSession(id, {stopActivity:true}) 一键停掉某个机器人的回合、子代理、后台任务和提醒。
- `ctx.permissionPresets.set(session, name)、ctx.approval.setPolicy(agent, policy)、approval/request waterfall、ctx.commands.execute(agent, '/permission x')`：给每个机器人会话设权限档位和审批策略；可以挂一个只管某个 agent 的审批应答者，实现白名单内自动批准、其余转人工。
- `ctx.pluginManager.installBundle/listBundles/listPlugins/setPluginEnabled（Remote；事件 plugin-manager/changed）与 ctx.configEditor.edit(entry, change)`：机器人工厂生成一个包含 N 行 dsh-agent-preset 的 bundle 后安装，有 HMR 时在线生效；configEditor 能热改 profile 里已有行的 config，但用它编辑 preset 行属于文档之外的用法，未验证。
- `ctx.systemPrompt.section / variable（通过 agent.ctx 注册）与 dsh-persona 行`：按 agent 作用域注册人设或提示词段，会盖过同名的全局段：可以在 agent/created 时读机器人目录里的 bot 配置，给这一个会话注入身份段落，而不必为每个机器人建一个 preset。
- `ctx.tools.restrict(filter)`：按 agent 屏蔽宿主层继承来的工具，例如 working_directory，防止机器人的身份漂移；官方没有现成的 preset 行封装它，需要自写一个小插件。
- `ctx.skills.register / registerProvider`：在某个 preset 作用域里注册自定义技能来源，例如从机器人名册动态提供技能。
- `ctx.agentDefaultModel.currentSelection()/saveSelection() 与会话投影 modelSelection、agentPreset`：读全局默认模型；机器人名册可以反查每个会话当前的 preset 和模型。
- `dsh-tool-subagent 行配置：agentPreset / allowedAgentPresets / agentOptions / maxDepth / modelSelectionSettings`：在机器人 preset 里挂一个委派工具，固定子代理的 preset 和模型，实现「主会话用便宜模型、派出的子代理用强模型」，或反过来。
- `ctx.workingDirectory.ensure/set 与 agent-instructions 行配置（instructionFileCandidates / localInstructionFileCandidates / projectRootMarkers / maxBytes）`：把机器人目录设为会话 cwd；把 MEMORY.md 之类的文件配成 local 候选，开局自动读入，压缩后重新注入。
- `事件 agent/created、session/event`：新会话创建时给这个 agent 挂上专属能力（人设段、工具限制、审批应答者）。

## 读者留下的未决问题

- 用户 profile 的 /Users/bytedance/.dsh/profiles/desktop/cordis.patch.yml 和 /Users/bytedance/.dsh/cordis.patch.yml 按禁区未读。它们是否关了 HMR、是否禁用了 tool-working-directory、是否改了默认 preset，会影响「免重启生效」和「身份漂移」两条判断。
- 关掉窗口或没人在线时，审批的 ask 请求是挂起等人，还是立即按 unavailable 拒绝？这决定无人值守机器人该用哪种权限策略，需要 R7/R9 路实测。
- 自写插件在 preset 里拦截 agent/request 来固定模型，与会话控制器 installModelSelection 的执行先后能否控制，未验证。
- preset 数量的实际上限（预加载开销、MCP 连接数）和同时存活会话数的实际上限都没有实测；宿主代码里没有找到顶层会话的并发上限。
- 直接改已安装的 link:/file: bundle 里的 patch 文件，会不会被热加载，还是必须重新 installBundle，未验证；configEditor.edit 能否编辑 preset 行（文档说只读）也未验证。
- 文档与代码对「Web 能否编辑 preset」说法不一致：YAML 注释和 locale 说能编辑，README 和 client 代码是只读。说明这块接口近期在变，下次升级可能还会变。
