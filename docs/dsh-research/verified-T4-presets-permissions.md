# T4-presets-permissions

## [confirmed] 1a) ctx.agentPresets.register(definition)：PresetDefinition 的完整结构、id 要求、注册时发生什么

ctx.agentPresets 是宿主服务，由 @deepseek-ai/dsh-agent-preset-registry 提供。桌面用 web 档（dsh-base + dsh-web-app），registry 行配 default: standard。

register 是普通方法，不是 Remote。Remote 只有三个：list 对应 remoteExportList，read 对应 readDocument，以及 select。签名是 register(definition: PresetDefinition): Promise<() => Promise<void>>，返回值是注销函数。

PresetDefinition 的结构：{ id: string; name?; description?; order?; plugins: (Omit<EntryOptions,'id'|'disabled'> & { id?: string; disabled?: boolean | null | { __jsExpr } })[] }。
- EntryOptions 有 id、name、config?、group?、disabled?、inject?，另有 isolate? 和 intercept?。行省略 id 时，Loader 会随机分配 8 位十六进制。
- 没有 extends、model、permission、hidden 这类字段。
- name 和 description 只给界面看，模型看不到。

id 只做两条校验：trim 后不能为空，否则报 'Preset id must not be empty'；不能重复，否则报 'Duplicate agent preset: <id>'。约定只用小写字母、数字和连字符。

注册时依次发生：
1. 同步写入 definitions。
2. activate：createScope(registry 自己的 owner, key)。
3. entryListProblem 校验 plugins 结构。
4. scope.ctx.extend({ baseUrl: 调用方 ctx.baseUrl })。
5. mountPreset：new PresetTree（write() 是空实现，只在内存）。
6. prepareProfileEntries：先 structuredClone。profile 模式下 engines 不兼容的行会被强制 disabled 并写 stderr；缺 baseUrl 时抛 'Profile compatibility preflight requires a resolution base'。
7. auditRows：导入失败或激活失败记为 failed；inject 缺服务的行记为 pending，保留挂载。
8. leakedServices：有服务漏到根 realm 就抛 'Preset services require isolate realms: X'。

只要有 failed 或泄漏，整个定义就是 broken：record.broken 记下错误文本，scope 被销毁，打 warn 日志，定义仍留在名册里；retain 或 mount 时抛 agent-preset/invalid。

register 要等激活成功或诊断落定才 resolve。定义 broken 时它照样返回注销函数，不会 reject。

服务方法里的 this.ctx 经 cordis traceable 代理指向调用方的 ctx，所以 record.context.baseUrl 就是调用方插件的 baseUrl，各行模块名按它解析。

名册排序先按 order ?? Infinity，再按 id。内置 standard=1、ptc=2、minimal=3、cordis=4。

> 核查说明：逐条核对一致。补充三点：
1. 原文排序只列了 standard、minimal、cordis，漏了 ptc=2。
2. activate 第一步先用 entryListProblem 校验 plugins：必须是数组；每行是带非空字符串 name 的对象；group:true 的行，config 也必须是行数组。不合格同样记为 broken，register 不会因此抛错。
3. 新任务的模式选择器会过滤掉 broken 的 preset，“加载失败”只出现在设置页卡片上。

证据：源码根：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src（下列路径都相对它）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:396-398（Remote 只有 list/read/select）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:466-494（register：空 id、重复 id 校验，await record.ready 后返回 unregister）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:495-521（activate：createScope(this.owner)、entryListProblem、extend baseUrl；catch 里记 broken、dispose scope、logger.warn，不向外抛）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:16-28（entryListProblem 的规则）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:62-77（PresetTree.write() 空实现）、154-179（auditRows）、219-237（mountPreset）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:570-581（list 排序）; @deepseek-ai/dsh-agent-preset/lib/index.js:10-26（官方声明插件在 Service.init 里 yield await register）; @deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:71-75（register 签名）、6411-6412（PresetDefinition）; @deepseek-ai/cordis-plugin-loader/src/config/entry.ts:10-23、src/config/isolate.ts:6-9（EntryOptions）；lib/index.js:161-165（ensureId 随机 id）; @deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:14（id 约定）; @deepseek-ai/cordis/lib/index.js:123-161、1770-1783（traceable 代理，tracker.property='ctx'）; @deepseek-ai/dsh-app-boot/lib/index.js:2304-2318、2341-2345（prepareProfileEntries/preflight）; @deepseek-ai/dsh-web-app/presets/standard.patch.yml:9、ptc.patch.yml:9、minimal.patch.yml:9、cordis.patch.yml:9（order 依次为 1/2/3/4）; @deepseek-ai/dsh-client-ui-agent-preset/lib/client.js:1168-1174（presetOptions 过滤 broken）、959（'加载失败' 徽标）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/docs/design/evidence/01-identity-bot-definition.md:45（旧结论“没有 preset 的增删改 API”，需要修正）

## [confirmed] 1b) 能否继承 standard？如何“从 standard 派生、去掉若干工具、加上自家工具”

不能声明式继承：PresetDefinition 没有 extends；覆盖一个 preset 也是整份替换它的子插件列表。派生只能在代码里做，分三步。

① 读出当前的 standard。
- await ctx.agentPresets.readDocument('standard') 返回 { agentPreset, content, name?, description? }，不含 order。
- content = js-yaml dump(plugins, { schema: entryListSchema, noRefs: true, lineWidth: -1 })。
- AgentPreset 声明了 EntryGroup.key，Loader 交给它的是未插值的原始 config，所以 registry 里存的 plugins 保留了 { __jsExpr } 节点。用同一方言 load 回来就能原样复用；方言是 JSON_SCHEMA 加上 'tag:yaml.org,2002:js' 标量与 { __jsExpr } 互转。
- 读到的是当前生效的定义，包括 bundle 覆盖补丁和 profile 补丁。
- 也可以直接读内部字段 ctx.agentPresets.definitions.get('standard').config.plugins。

② 按行 id 增删改。0.2.1-rc.5 的 standard 行依次是：persona、agent-instructions、time-context、tool-bash（win32 禁用）、tool-pwsh（非 win32 禁用）、tool-fs、tool-fs-search、tool-jobs、tool-schedule、skill-filesystem、tool-skill、command-goal、tool-goal、planning（组：plan-mode，isolate planMode）、compaction（组：compaction-basic / command-compact / tool-result-pruner）、delegation（组：tool-subagent-control / tool-subagent-list-agents / tool-subagent / tool-subagent-fork / workflow-ptc / tool-workflow）、tool-ask-user、tool-todo、tool-web、present、tool-plugin-manager（disabled: true）、tool-plugin-market（disabled: true）。
机器人建议去掉这几行：
- tool-ask-user：默认 legacy 阻塞模式，会一直等人回答。
- planning。
- 两个插件管理行。

③ 追加自家行 { id, name: '<包名>/<exports 子路径>' }，然后 register。

备选方案：
- 把行静态拷进插件：DSH 升级后会漂移。
- 走官方 bundle 补丁路线：insert 一行 @deepseek-ai/dsh-agent-preset，用 plugin_manager 安装。

调研员的示例代码与源码 API 形状一致，包括：JsExpr 类型定义；deriveBotRows；用 ctx.effect 包住 register；bot-tools 行里用 defineTool({ name, description, parameters: { x: { type, required, description } }, output: { schema, render }, execute(args, exec) })；ctx.systemPrompt.variable。

> 核查说明：核对一致。三处细节：
1. standard.patch.yml 第 2 行的注释还提到 Web editor，但 0.2.1-rc.5 的 client README:76 写明 Web 端只读，不能编辑 preset。所以“当前生效的覆盖”实际来自 bundle 覆盖补丁（创造模式安装的 bundle）或 profile 补丁，“Web 编辑器”一说已过时，不影响结论。
2. 计划模式只能由用户敲 /plan 进入，模型自己进不去，保留 planning 不会自动挂起。删掉它主要是省工具 schema 和提示词，也防止有人对机器人会话敲 /plan 后卡在计划审阅上。
3. 'dsh-agent-hub/bot-tools' 按调用方 baseUrl 解析，属于推断，未实测（见 open_questions）。

证据：@deepseek-ai/dsh-web-app/presets/standard.patch.yml:4-128（全部行 id 和禁用状态）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:613-631（readDocument）; @deepseek-ai/dsh-agent-preset-registry/README.zh.md:48、99（注册表不写入声明；覆盖替换整个子插件列表，不合并未来更新）; @deepseek-ai/dsh-agent-preset/lib/index.js:11-12；@deepseek-ai/cordis-plugin-loader/lib/index.js:610-611（带 EntryGroup.key 的插件拿到原始 config）; @deepseek-ai/cordis-plugin-include/lib/index.js:15-28（JsExpr 与 entryListSchema）以及文件末行（export entryListSchema）; @deepseek-ai/cordis-plugin-loader/lib/index.js:239-248（interpolate/isJsExpr）、336-351（group 的 disabled 沿父 entry 继承；disabledOf 求值）; @deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:16-66（bundle 补丁新建和覆盖 preset）; @deepseek-ai/dsh-tool-ask-user/lib/index.js:211-214（mode 默认 legacy）；README.zh.md:31、39; @deepseek-ai/dsh-plan-mode/README.zh.md:12（用 /plan 进入计划模式）; @deepseek-ai/dsh-client-ui-agent-preset/README.zh.md:76（Web 不创建也不编辑 preset，查看器只读）; @deepseek-ai/dsh-tools/lib/index.js:838-868（defineTool）；@deepseek-ai/dsh-plugin-manager/lib/types/tools.js:4、76-92（官方 defineTool 用法）; @deepseek-ai/cordis-plugin-loader/lib/index.js:214-226（模块按 tree.ctx.baseUrl 经 loader.internal.import 解析）；_app/main.js:3793-3803（桌面 host 以 --expose-internals 启动）

## [corrected] 1c) 插件行的启用与禁用、工具增删的规则，往 preset 里加自家插件的约束

启用和禁用：
- 在行上写 disabled: true，或 disabled: { __jsExpr }。
- 普通行的 disabled 会沿父 entry 上溯，所以组行禁用时子行一并禁用。
- profile 预检把 engines 不兼容的行强制设为 disabled 并写 stderr；审计时跳过被禁用的行，不算失败。
- 已注册的定义不能改单行，只能注销后重新 register。新代际只给之后新建或冷恢复的 Agent 用，运行中的 Agent 保留旧代际。

删工具：
1. 删掉行，或把行设为 disabled。
2. 用工具插件自己的配置开关。tool-fs 有 read / readImage / write / edit；tool-web 有 search / fetch / searchMaxResults / searchMaxQueries / *TimeoutMs / fetchMaxOutputChars。
3. agent.ctx.tools.restrict({ allow?, deny? })：
   - 只能在有 scope 的 ctx 上调用，否则抛错。
   - 只过滤继承来的工具，也就是全局层加祖先 preset 层。
   - 空过滤、未知名字、本层自己注册的名字、run_code，都会抛错。
   - 结果不持久，要在 agent/created 里重做。agent/created 是 serial 事件，新建、恢复、clear、compaction 都会触发；它按 scope 过滤，preset 行里的监听器只收到绑定本 preset 的 Agent。
4. ctx.tools.guard(fn)：
   - 同步、单调的硬拒绝，fn 返回字符串即拒绝。
   - 在 preset 行里注册，进入 preset 层，对该层下所有 Agent 生效。
   - 只在 pre-execute 决定为 allow 之后求值。

加工具：
- 在 preset 行里 ctx.tools.register，工具落在 preset 层，只有绑定该 preset 的会话看得到。
- 执行时 exec.agent.id 就是 sessionId。

约束：
1. preset 行如果提供服务，提供方和所有消费方必须共享同一个 cordis:group 的 isolate realm，否则整个定义 broken（'Preset services require isolate realms: X'）。只在单行上写 isolate，只能保护这一行自己。
2. 行配置会经过 structuredClone，只能放纯数据和 { __jsExpr }。
3. inject 了宿主服务、而服务还没就绪的行处于 pending；宿主 Loader 结算后仍缺服务，就诊断为不可用，retain 时抛 agent-preset/invalid。所以建议执行时用 ctx.get 取。
4. 每个代际只激活一次，由所有 Agent 共享。按机器人区分的状态要用 agent.id 做键。

```
// 放在机器人 preset 的某一行（agent/created 按 scope 过滤，只收本 preset 的 Agent）
export const name = 'agent-hub-bot-policy'
export const inject = ['tools']
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    const wanted = ctx.get('agentHub')?.deniedToolsFor(agent.id) ?? []
    // restrict 只接受继承来的工具名，未知名字会 throw；而 agent/created 里 throw 会让机器人创建或恢复失败
    const deny = wanted.filter((n) => agent.ctx.tools.get(n, agent) !== undefined)
    if (deny.length === 0) return
    try { agent.ctx.tools.restrict({ deny }) }   // 随 agent.ctx 释放自动解除
    catch (e) { ctx.logger.warn(`agent-hub: restrict failed for ${agent.id}: ${e}`) }
  })
  // 同步、单调的硬拒绝：作用于本 preset 层下所有 Agent
  ctx.tools.guard((exec) => exec.name === 'bash' && exec.arguments?.sandbox_permissions !== undefined ? 'bots may not escalate the sandbox' : undefined)
}
```

> 核查说明：文字结论核对一致，但原示例代码会让机器人会话起不来，已改正。
- 原写法：agent.ctx.tools.restrict({ deny })，deny 未经过滤。
- 问题：agent/created 是 serial 事件，api-catalog:3960 写明 'A throw or rejection fails creation'；而 restrict 遇到未知名字会直接抛错（dsh-tools:3004）。Hub 的 deny 表里只要有一个该 preset 没有的工具，比如被删掉的行，机器人就会创建或恢复失败。
- 改正：先用 agent.ctx.tools.get(name, agent) 过滤，再用 try/catch 兜底；本层自己注册的名字 restrict 也会抛错，这个情况也被兜住。

另外，“必须包在 cordis:group 里”这条有 README.zh.md:58 直接支持。

证据：@deepseek-ai/cordis-plugin-loader/lib/index.js:335-351（Entry.disabled 上溯父 entry；disabledOf）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:154-179（auditRows）、533-544（diagnostic：有 pending 时 await loader 后再审计）、108-122 与 230（leakedServices）; @deepseek-ai/dsh-agent-preset-registry/README.zh.md:58（提供方和消费方必须共享同一个 cordis:group 隔离 realm；条目局部隔离不沿 Agent scope 传播）; @deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:78-80; @deepseek-ai/dsh-app-boot/lib/index.js:2310-2345（structuredClone；deny 后 disabled=true）; @deepseek-ai/dsh-tools/lib/index.js:2991-3006（restrict：2993 无 scope 抛错，3004 未知名字抛错）、3017-3022（guard）、3023-3031（guardReason：全局层 + agent 的 scope 链）、3036-3060（view 只过滤继承面）、3318-3330（guard 只在 decision 为 allow 时求值）; @deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3358-3375、3956-3962（agent/created 为 serial；A throw or rejection fails creation and skips later listeners）; @deepseek-ai/dsh-agent/lib/index.js:564-596（announce 的 source 包括 fresh/resume/clear/compaction；agent id 即 session id）; @deepseek-ai/dsh-scope/lib/index.js:296-337（createScope；scopeTarget 让祖先 scope 的监听器收到后代事件）；@deepseek-ai/dsh-agent-loop/lib/index.js:778（Agent 自身就是 scope key）; @deepseek-ai/dsh-tool-fs/lib/index.js:1194-1203；@deepseek-ai/dsh-tool-web/lib/index.js:845-853; @deepseek-ai/dsh-tool-subagent/lib/index.js:600-612（官方 preset 行用 agent/created 的先例）

## [corrected] 1d) 说明文字、instructions、skills 目录分别怎么在 preset 里配置

definition 的 name 和 description 只进界面，没有其它 instructions 字段。模型可见的内容全部来自 preset 里的行：

① @deepseek-ai/dsh-persona，Config { prefix（必填）、suffix（默认 ''）、complete（默认 false）、includeRuntimeContext（默认 true） }：
- 段落注册在 preset 作用域，会遮蔽部署人设。
- prefix 和 suffix 是模板，其中完整的 {{…}} 在渲染时严格解析为已注册的提示词变量，例如 {{model}}、{{provider}}。
- complete: true 时只保留前缀这一段。

② @deepseek-ai/dsh-agent-instructions，Config { maxBytes（必填）、projectRootMarkers（默认 ['.git']）、instructionFileCandidates（默认 ['AGENTS.md','CLAUDE.md']）、localInstructionFileCandidates（默认 ['AGENTS.local.md','CLAUDE.local.md']）、maxSourceBytes（默认 1048576） }：
- 先注入用户全局链：$DSH_HOME/AGENTS.md，然后是 $DSH_AGENTS_HOME 或 ~/.agents 下的 AGENTS.md。这是进程级策略，preset 关不掉。
- 再注入项目链：从项目根到会话当前工作目录，每一层的候选文件。
- 项目根 = 离当前目录最近、含有任一标记的祖先目录，标记可以是文件也可以是目录；一个都找不到时就用当前目录。

③ 在自家行里调用：
- ctx.systemPrompt.section({ name, order, text })
- ctx.systemPrompt.context(...)
- ctx.systemPrompt.variable(name, provider)：name 必须匹配 [a-z][a-z0-9_]*；运行时 assemble 的 context 里带 agent，provider 可以读 context.agent；provider 返回 undefined 时，引用它的段落渲染会失败。

skills 需要 skill-filesystem 和 tool-skill 两行（桌面宿主层的这两行已禁用，交给 preset）。skill-filesystem 的 Config：
- providerName：默认 'filesystem'，同一层里必须唯一。
- includeDefaultRoots：默认 true。
- customSkillDirs：经 path.resolve 处理，不展开 ~。
- 另有 bundledSkillDir、dshHome、agentsHome、watch* 等。
默认根目录和 rank：
- <projectRoot>/.dsh/skills：100
- <projectRoot>/.agents/skills：200
- customSkillDirs：300
- <dshHome>/skills：400
- <agentsHome>/skills：500
- bundledSkillDir：600
这里的 projectRoot 固定按 .git 找，不能配置。

按机器人区分人设有三种办法：
(a) 每个机器人一个目录，放自己的 AGENTS.md，再把 projectRootMarkers 加上自定义标记。
(b) 在 preset 行里注册 hub_bot_identity 变量，按 agent.id 返回身份。
(c) 一个机器人一个 preset，资源占用随机器人数线性增长。

> 核查说明：补充（会改变推荐）：
1. 宿主层的 working_directory 工具对所有 preset 可见。模型可以 cd 到任意已存在的目录，而 agent-instructions 在下一次请求前会按新的工作目录重载项目链（README:28）。所以方案 (a) 靠目录里的 AGENTS.md 区分身份并不牢靠：机器人 cd 到 ~/AgentHub/bots/<别的机器人> 就会读到别人的 AGENTS.md，自己的那份反而掉出链。身份应以方案 (b) 的变量为准（按 agent.id 返回），AGENTS.md 只放可以共享的规则；要么就用 guard 或 restrict 把 working_directory 给机器人禁掉。
2. findProjectRoot 取最近的、含任一标记的目录。机器人如果在自己目录里 git init，项目根就变成机器人目录，~/AgentHub/AGENTS.md 会掉出链。

证据：@deepseek-ai/dsh-persona/lib/index.js:23-48；README.zh.md:36-48; @deepseek-ai/dsh-agent-instructions/lib/index.js:16-31（默认值与 Config）、545-579（existsAsMarker 用 stat、findProjectRoot）; @deepseek-ai/dsh-agent-instructions/README.zh.md:28（切换 Session 工作目录后，下一次请求前重新加载项目指令链）、34、40; @deepseek-ai/dsh-skill-filesystem/lib/index.js:30-43、78；README.zh.md:48-56; @deepseek-ai/dsh-skill/lib/index.js:94-125; @deepseek-ai/dsh-web-app/cordis.patch.yml:510-523; @deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3089-3129；@deepseek-ai/dsh-agent/lib/index.js:291-297（assembleContextFor 返回 { agent, scope: agent }）；@deepseek-ai/dsh-agent-loop/lib/index.js:1591-1592; @deepseek-ai/dsh-tool-working-directory/lib/index.js:16-41；@deepseek-ai/dsh-working-directory/lib/index.js:113-150（set 只校验“是已存在的目录”，不改权限）; @deepseek-ai/dsh-base/cordis.patch.yml:169-170（working_directory 是宿主层工具，web-app 没有禁用）; @deepseek-ai/dsh-web-app/presets/cordis.patch.yml:122-126

## [corrected] 1e) 运行时注册的生命周期：只在内存？重启后要重新注册？已选它的会话会怎样？

只在内存：
- definitions 和 generations 都是内存里的 Map，PresetTree.write() 是空实现。
- 每次启动都要重新 register；YAML 声明的 preset 也是声明插件在每次启动时重新注册的。

生命周期归属：
- 定义的 scope 属于 registry，不随调用方插件销毁。
- 注销函数必须交给 ctx.effect，或在 Service.init 里 yield 出去。否则插件重载后再注册会报 'Duplicate agent preset'，旧的行代码也会继续跑。

注销时：
- 定义先从名册删除，代际标记为 retired。
- Agent、子 Agent 和临时历史读取各自持有引用，最后一个释放后才销毁插件树。

会话记住 preset 的方式：会话头的 header.agentPreset，加上 agent-preset/selected 事件，折叠成 agentPreset 投影。

运行中的 Agent 绑定确切的代际，之后注销或重注册都不影响它。

冷恢复走 resumeObserved → composeAgent，按投影里的 id 取当前定义：
- 没注册：agentPresets.resolve 抛 RemoteError('agent-preset/not-found', …, { agentPreset, available })。
- 定义 broken：mount → retain 抛 'agent-preset/invalid'。
- 能找到：用的是最新定义，工具 schema 和提示词前缀可能变化。

子代理通过 composeFrom 绑定父会话的确切代际。

换 preset 只能在空白会话上做，条件是 turnBoundary.openTurnStartSeq === null 且 lastTurn === 0：
- 用 agentPresets.select(agent, id)，或用 sessionController.create 复用空白会话。
- 开过第一轮后再换，报 agent-preset/locked（'This session has already started'）。

sessionController.create({ workspaceId? 或 cwd?, sessionId?, agentPreset? })：
- 返回 { sessionId, agentPreset? }。
- workspaceId 和 cwd 不能同时给。
- cwd 不存在时会自动 mkdir -p。

界面上：
- 注册后，它出现在新任务的模式选择器和设置页的“自定义”分组里。
- 客户端列表只在连接重置或设置更新时刷新。

dsh-schedule 投递提醒时 resolveAgent 失败，只打一条 warn（'were not acknowledged'），不自动重试。

```
// 唤醒或恢复机器人之前，确认 preset 可用（不要在本插件自己的激活过程中 await，见补充 B）
async function presetReady(ctx, id) {
  try {
    const r = await ctx.agentPresets.resolve(id)   // { id, broken? }
    return r.broken === undefined
  } catch (e) {
    if (e?.code === 'agent-preset/not-found') return false
    throw e
  }
}
// 经 resolveAgent 恢复失败时，拿不到原始 code：
const r = await ctx.sessionController.resolveAgent(sessionId)
if ('error' in r) {
  // r.error.code === 'gateway/internal'
  // message 形如：resume failed for session <id>: RemoteError: Unknown agent preset: <id>
}
```

> 核查说明：改正：原文说冷恢复时“抛 RemoteError，code 为 agent-preset/not-found，details 为 { agentPreset, available }”，这只对两种调用成立：直接调 ctx.agentPresets.resolve / retain；以及 sessionController.create，它的 rejectCreation 会把 RemoteError 原样抛出（1073-1074）。

凡是走 ctx.sessionController.resolveAgent 的恢复路径（dsh-schedule 投递、UI 打开会话、其它宿主域都走这条），resolve() 的 catch 会把 composeAgent 抛出的错误包成 { error: RemoteError('gateway/internal', 'resume failed for session <id>: RemoteError: Unknown agent preset: <id>', {}) }，原始 code 只剩在 message 文本里（221-244）。

所以 Hub 判断“preset 是否已注册”时，应先直接调 agentPresets.resolve，不能依赖 resolveAgent 返回的 error.code。另外 resolve 成功时也可能带 broken，示例代码应一并检查。

证据：@deepseek-ai/dsh-agent-preset-registry/lib/index.js:446-449、481-490、545-549、654-680（Map、unregister、collect、bind/join）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:48-58（agentPreset 投影）、596-608（resolve）、632-653（retain）、686-695（mount）、701-712（composeFrom）、750-770（select / locked）; @deepseek-ai/dsh-agent-preset-registry/README.zh.md:56、60; @deepseek-ai/dsh-api-session-controller/lib/index.js:210-244（resolveAgent → resolve；catch 里把非 NotFound/Ownership 的错误包成 gateway/internal）; @deepseek-ai/dsh-api-session-controller/lib/index.js:351-362（composeAgent）、392-397（resumeObserved）、493-496（isBlank）、511-526（createAgent：mkdir、meta.agentPreset）、755-791（create）、1073-1074（rejectCreation 原样抛出 RemoteError）、2952（服务名 sessionController）; @deepseek-ai/dsh-schedule/lib/index.js:1521-1522、1576-1577、1627-1633; @deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:7003-7008; @deepseek-ai/dsh-client-ui-agent-preset/README.zh.md:30、48；lib/client.js:883-885

## [confirmed] 2a) 内置有哪些权限档，各自的沙箱规则是什么

桌面 web 档（dsh-base + dsh-web-app）的三档由 dsh-base 的 permission 行配置：
- read-only = { sandbox: read-only, approval: ask }
- workspace-write = { sandbox: workspace-write, approval: ask }
- danger-full-access = { sandbox: danger-full-access, approval: never }
这三档不带 name 和 description，客户端用内置的本地化标签：仅可查看、工作区内修改、完全权限。

插件 schema 自带的默认值只有 workspace-write 和 danger-full-access 两档，而且带文案；dsh-base 把它整体替换成上面三档。

只有加载实验包 dsh-experimental-auto-review 时，才多出 auto = { danger-full-access, ask }。这一档只能给当前会话选，不能设为默认，默认组合也不加载这个包。

三种沙箱模式的规则：
- read-only：除了 /dev/null 一律不可写；write 和 edit 工具抛 FS_SANDBOX_DENIED。
- workspace-write：可写的只有 [session.header.cwd, '/tmp', os.tmpdir()] 再加 /dev/null。这些路径都经 realpath 规范化，在 macOS 上就是 /private/tmp 和 /private/var/folders/…/T。
- danger-full-access：bash 不套 sandbox-exec，fs 工具也不设围栏。
三档都不限制读取、联网和起进程。

新会话用哪一档：
- 会话创建时，pinInitialPermission 取设置里的 defaultPreset。通用设置可以改它，只影响之后创建的会话。
- 没有设置时由组合默认值推导：DSH_PERMISSION_MODE 未设置时为 workspace-write，审批为 ask，所以落在 workspace-write。
- 同时写入 permission/preset、sandbox/mode、approval/policy 三种事件，重启后靠回放保留。

当前档的推导顺序：最近一次仍然匹配的选择优先，其次是配置表里第一个匹配项，都不匹配就显示 custom。

证据：@deepseek-ai/dsh-base/cordis.patch.yml:237-276; _app/main.js:3385-3390（PROFILE_TEMPLATES.web = dsh-base + dsh-web-app）、81（profiles/desktop）; @deepseek-ai/dsh-permission-presets/lib/index.js:58-61、138-159、291-306、370-389; @deepseek-ai/dsh-permission-presets/README.zh.md:56、64、133-137; @deepseek-ai/dsh-client-ui-permission-presets/README.zh.md:12、32; @deepseek-ai/dsh-sandbox/lib/index.js:140-173（canonicalPath + writableRoots）; @deepseek-ai/dsh-sandbox-policy/lib/index.js:141-148; @deepseek-ai/dsh-bash-sandbox/lib/index.js:65-74；@deepseek-ai/dsh-fs-sandbox/lib/index.js:153-166

## [confirmed] 2b) 能否定义自定义权限档（例如 unattended = 工作区可写 + 额外可写目录 ~/AgentHub + 从不弹审批）

能定义，但只能是“沙箱模式 × 审批策略”的组合。PresetSpec = { sandbox, approval, name?, description? }，表达不了额外可写目录。

一、怎么定义：
- 覆盖 Loader 行 id 为 permission 的那一行（@deepseek-ai/dsh-permission-presets），改它的 config.presets（是个 z.dict）。
- custom 和 auto 是保留名，写进表里构造函数直接抛错，整个权限服务都起不来。
- 没有运行时注册接口，预设表在插件生命周期内固定。
- 可以写在两处：
  - Hub bundle 的 cordis.patch.yml：bundle 层按 dsh.profile.bundles 的顺序叠加，新装的 bundle 追加在末尾。
  - 用户的 profile 补丁 ~/.dsh/profiles/desktop/cordis.patch.yml：在所有 bundle 层之后叠加。按纪律本次未读取。
- 非 insert 补丁的 config 整体替换、不深合并，所以三个内置档必须一起写上。

二、额外可写目录做不到：writableRoots 写死为 [session.header.cwd, '/tmp', tmpdir()]；sandbox-policy 的 workspaceRoot 只是“没有会话的调用”所用的兜底根。

三、给机器人设档（在宿主代码里、第一轮之前）：
- ctx.permissionPresets.set(session, name)：只有档名变化时才追加 permission/preset，再用 setSandboxMode / setApprovalPolicy 只改实际变化的旋钮，不给模型注入消息。
- /permission <name> 命令走 ctx.approval.setPolicy(agent, …)，会注入一条 'The approval policy changed from … to … (changed by the user).'；带参数的命令不弹风险确认。
- 也可以完全不改配置，直接 session.append('sandbox/mode', { mode }) 和 session.append('approval/policy', { policy })，这时选择器显示 custom。

四、界面上：
- 自定义档会出现在会话的权限选择器里：有 name 就显示 name，没有就把 kebab-case 转成 Title Case。
- 设置里的“默认档”只能从配置表里选。

> 核查说明：核对一致。补充一点：用户已保存的默认档（设置里的 defaultPreset）如果指向被删掉的档，不只是建会话时 defaultSettings() 抛 'permission: unknown default preset'。构造函数里第 181 行就会 this.resolve(defaultPreset)，抛 'permission: unknown preset … (known: …)'，权限服务整体起不来。所以覆盖 permission 行时，不要删掉用户可能选过的档名。

证据：@deepseek-ai/dsh-permission-presets/lib/index.js:138-159（Config）; @deepseek-ai/dsh-permission-presets/lib/index.js:175-177（保留名、要求可约束的 shell）、181（构造时 this.resolve(defaultPreset)）、184（defaultSettings 抛 unknown default preset）; @deepseek-ai/dsh-permission-presets/lib/index.js:206-231、238-240、315（resolve 抛 unknown preset）、344-361; @deepseek-ai/dsh-permission-presets/README.zh.md:32、135、137; @deepseek-ai/dsh-app-boot/lib/index.js:61-109（applyEntryPatches）、488-497（bundle 层顺序，然后 profile 补丁）、3044（config is replaced wholesale）; @deepseek-ai/dsh-plugin-manager/README.zh.md:40（开启的 bundle 追加到列表末尾）; @deepseek-ai/dsh-sandbox/lib/index.js:166-173；@deepseek-ai/dsh-sandbox-policy/lib/index.js:40-42、97-104、141-148; @deepseek-ai/dsh-user-approval/lib/index.js:63-66、98-109; @deepseek-ai/dsh-client-ui-permission-presets/README.zh.md:32、38; @deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:6419-6420

## [confirmed] 2c) approval: never 时，需要审批的操作是自动拒绝还是放行

自动拒绝。

拒绝发生在分发之前：ApprovalService.decide 先看 signal 是否已中止，然后 effectivePolicy(session) === 'never' 就返回 'rejected'。这一步在 approval/request 瀑布分发之前，任何应答者都看不到，包括 prepend 注册的。

审计照常：request() 先追加 approval/asked，再追加 approval/decided，outcome 为 rejected。

模型这一侧看到的：
- 运行时上下文快照里有 NEVER_SENTENCE：审批提示已关闭，需要审批的操作会被自动拒绝，不要申请提权，不要设置 sandbox_permissions。
- 仍然申请提权的工具会抛错，文案是 'the user rejected escalating this <subject> to "<mode>"; it stays denied, so stop and explain instead of working around it'。subject 依次是：bash 为 command，write/edit 为 operation，run_code 为 program，plugin_manager 为 plugin management operation。
- pre-execute 返回 ask 的调用，得到 'Error: the user rejected tool "<name>"'。

不受影响的部分：
- 沙箱范围内的写入不需要审批，照常执行。
- 委派出去的子代理，审批策略一律被钉成 never。

想“按规则放行一部分”，就不能用 never，只能用 ask 加自己写的应答者。

证据：@deepseek-ai/dsh-user-approval/lib/index.js:39（NEVER_SENTENCE）、79-89（runtime context）、128-144（审计对）、172-189（decide）; @deepseek-ai/dsh-user-approval/README.zh.md:36、56、77; @deepseek-ai/dsh-sandbox/lib/index.js:99-123; @deepseek-ai/dsh-tools/lib/index.js:3535-3576（serviceAsk）、3330-3340（拒绝结果为 Error: <reason>）; @deepseek-ai/dsh-subagent/lib/index.js:397-415

## [corrected] 2d) 联网在各权限档下怎么处理

所有权限档都不管联网，也没有任何和联网相关的审批。

底层沙箱都不拦网络：
- macOS 的 Seatbelt 是 (allow default)，只额外 deny file-write*。
- Linux 的 bwrap 只读挂载根目录，只加了 --unshare-pid，没有 --unshare-net。
- Landlock 只授权文件。
- danger-full-access 根本不套沙箱。

各类联网途径：
- web_search 和 web_fetch 在宿主进程里发请求，任何档都不审批。web_fetch 只发 GET，并拒绝解析到非公网地址的目标（WEB_BLOCKED_URL）。
- MCP 的 stdio 服务器由宿主直接拉起，不进沙箱，调用也不审批。
- bash 里的 curl 之类，三档下都能直接联网。

要管联网只能在工具层：
- 用 tools/pre-execute 或 tools.guard，按工具名和参数拒绝。
- 或者不给这个 preset 挂 tool-web / MCP 行。
- bash 里的联网在 macOS 上没有配置级的手段能拦。

子进程环境变量：
- 从父进程继承来的环境里，名字匹配 /KEY|PASSWORD|SECRET|TOKEN/i 的变量和所有 DSH_* 变量都会被剔除。
- 但 bash 和 pwsh 每次调用时，dsh-shell-env 会显式注入受管的 DSH_HOME、DSH_SHELL=1、DSH_SESSION_ID、DSH_PROFILE、DSH_PROFILE_DIR；插件也可以注册自己的环境变量。
- 读文件不受限制。

> 核查说明：改正：原文说“所有 DSH_* 变量都会被剔除”，这只对继承来的环境成立。scrubbedParentEnv 之后还会合并显式 env；tool-bash 每次都传 dshEnv: ctx.shellEnv.collect(exec)，于是 bash 里总有 DSH_HOME（凭据所在目录）、DSH_SESSION_ID、DSH_PROFILE 和 DSH_PROFILE_DIR。Hub 也可以借 shellEnv 注册机制，给机器人注入自己的环境变量，比如 bot id。其余结论核对一致。

证据：@deepseek-ai/dsh-sandbox-local/lib/index.js:22-38、44-52、65-75; @deepseek-ai/dsh-sandbox/README.zh.md:166; @deepseek-ai/dsh-tool-web/README.zh.md:253; @deepseek-ai/dsh-web-fetch-http/lib/index.js:35、70、162、196（只用 GET；非公网目标拦截）; @deepseek-ai/dsh-subprocess/lib/index.js:25-56（剔除只针对继承环境；显式 env 在剔除之后合并）; @deepseek-ai/dsh-shell-env/README.zh.md:12、32（每次 shell 调用注入的 DSH_* 事实）；@deepseek-ai/dsh-tool-bash/lib/index.js:665（dshEnv: ctx.shellEnv.collect(exec)）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/docs/design/evidence/07-guard-safety-quota.md:80-86、249-264

## [confirmed] 2e) 做不到“额外可写目录”时，~/AgentHub 应该怎么布局

推荐方案 (A)：
- 每个机器人会话的 cwd 设为 ~/AgentHub/bots/<botId>，权限档用 unattended（workspace-write + never），它就只能写自己的目录和临时区。
- 跨机器人共享的内容、对外的产出，都通过 Hub 自己的宿主工具来写。宿主代码不在沙箱里，由 Hub 自己校验路径。
- 读取本来就不受限，共享资料直接读，不需要符号链接。
- 沙箱根取会话头的 header.cwd，创建后不能改。

其它方案和代价：
(B) 所有机器人 cwd 都设为 ~/AgentHub：机器人之间可以互相写，没有隔离；agent-instructions 和 skills 的项目根也会变成同一个。
(C) 用 ask，再写一个 Hub 应答者自动批准提权：一经批准，这一次调用整体升到 danger-full-access，可以写全盘。
(D) 给 dsh-sandbox-local 配 runnerCommand：配置后任何平台都直接调用它，并追加 bwrap 风格参数（--ro-bind / /、--bind <ws> <ws>、--tmpfs /tmp 等）。代价是对所有会话都生效、跳过探测、官方不支持，而且进程内的 fs 围栏不认这个额外目录，两边行为会不一致。

符号链接这条路走不通：Seatbelt 和 fs 围栏都按 realpath 后的路径匹配，工作区里放指向外部的链接，不会把写权限扩到外面。

> 核查说明：核对一致。补充四点：
1. 桌面宿主进程的 cwd 就是 profile 目录（main.js:3767、3803），所以 dsh-base 里 workspaceRoot: !!js process.cwd() 的值是 ~/.dsh/profiles/desktop。宿主代码调用 ctx.fs.writeText/editText 或 ctx.shell 而不传 sandboxPolicy 时，只能写这个目录加 /tmp 和 tmpdir，写 ~/AgentHub 会报 FS_SANDBOX_DENIED。解决办法：用 node:fs，或者显式传 { mode: 'danger-full-access', workspaceRoot }。
2. sessionController.create 会对 cwd 执行 mkdir -p，机器人目录不必预先建好。
3. 方案 (C) 可以细化：write 和 edit 的目标路径能在 tools/pre-execute 里按 callId 记下 arguments.path，Hub 只批准 realpath 落在 ~/AgentHub 下的那一次写。这样对 fs 工具可以做到按路径授权；bash 的命令内容无法可靠判断会写哪里，仍不推荐。
4. header.cwd 和“工作目录”是两回事：宿主层的 working_directory 工具能让模型 cd 到任意目录，但沙箱根始终是 header.cwd。

证据：@deepseek-ai/dsh-sandbox/lib/index.js:99-123、140-173; @deepseek-ai/dsh-fs-sandbox/lib/index.js:125-166（不传 sandboxPolicy 时回落到 this.ctx.sandboxPolicy.resolve()）; @deepseek-ai/dsh-sandbox-policy/lib/index.js:97-104、141-148; @deepseek-ai/dsh-base/cordis.patch.yml:243-247（workspaceRoot: !!js process.cwd()）; _app/main.js:3767、3793-3803（桌面 Host 子进程的 cwd 是 profile 目录：Desktop plugin profile and child working directory）; @deepseek-ai/dsh-sandbox-local/lib/index.js:253-257、305-320；README.zh.md:135; @deepseek-ai/dsh-api-session-controller/lib/index.js:511-516（createAgent 先 mkdir cwd）; @deepseek-ai/dsh-working-directory/lib/index.js:105-120（cd 不改变权限）

## [confirmed] 3a) 什么会触发审批

只有代码显式调用 approval.request 时才会产生审批。桌面组合里，调用它的地方有四类：

① 沙箱提权，经 dsh-sandbox 的 approveEscalation。
- 模型给 bash（Windows 上是 pwsh）、write、edit、run_code 传了 sandbox_permissions，并且必须同时带非空的 justification，二者缺一就抛错。
- 目标模式必须比当前有效模式严格更宽：read-only 可以升到 workspace-write 或 danger-full-access；workspace-write 只能升到 danger-full-access。
- 申请的模式和当前模式相同时，直接放行，不走审批。
- 沙箱拒绝本身不会触发审批，只会在结果里给出拒绝标记和“可以带 sandbox_permissions 重试一次”的提示；模型照做重试时才真正发起审批。

② plugin_manager 工具的每个动作，包括 list_plugins 这种只读动作，都以 requestedMode='danger-full-access' 走 approveEscalation；它的 justification 里带着 JSON.stringify(args)。

③ 任何 tools/pre-execute 监听器返回 { kind: 'ask', reason?, displayReason? }，都会经 serviceAsk 转成审批。默认组合里只有实验性的 Auto review 这样做。

④ 其它插件直接调用 ctx.approval.request。必须在开放回合里调用，否则在写审计事件之前就抛错。

不会触发审批的：读文件、联网、MCP、web_fetch / web_search、工作区内的写入、持久终端；子代理的审批策略被钉成 never。

ask_user_question 和计划审阅走的是另一条 user-questions/request 通道，不算审批，但同样会一直等人。

> 核查说明：核对一致。全仓 grep 调用 approveEscalation 或 approval.request 的包，只有 tool-bash、tool-pwsh、tool-fs、dsh-tools（run_code、serviceAsk）和 plugin-manager。持久终端没有 sandbox_permissions 参数，不会产生审批。

证据：@deepseek-ai/dsh-sandbox/lib/index.js:30-33、51-55、64-78、99-123; @deepseek-ai/dsh-tool-bash/lib/index.js:150-171、344（escalationModes 只取决于执行器是否约束）、355-375、656-663; @deepseek-ai/dsh-tool-fs/lib/index.js:1134-1155；@deepseek-ai/dsh-tools/lib/index.js:1251-1272; @deepseek-ai/dsh-plugin-manager/lib/types/tools.js:76、92-98; @deepseek-ai/dsh-tools/lib/index.js:3318-3325、3535-3576; @deepseek-ai/dsh-experimental-auto-review/lib/index.js:432-446; @deepseek-ai/dsh-user-approval/lib/index.js:49-56、128-131; @deepseek-ai/dsh-plan-mode/lib/index.js:252-275；@deepseek-ai/dsh-api-remotes/lib/index.js:136-139

## [confirmed] 3b) 审批请求的数据结构、结果取值、日志事件

宿主侧的请求（ApprovalRequestEvent / ApprovalRequest）字段：
- agent：Agent 对象，agent.id 就是 sessionId。
- toolName：工具名。
- callId?：ToolCallId。
- reason?：给审计用的原因文字。
- displayReason?：{ en, [locale] }，给界面显示的本地化文案。
- signal?：AbortSignal。
请求里不带工具参数（plugin_manager 例外，它的 reason 里带着 args）。

提权请求的典型取值：
- reason = `escalate sandbox to ${mode}: ${justification}`。
- displayReason = { en: `Allow this operation with ${mode} permissions: ${justification}`, zh: `允许本次操作使用 ${mode} 权限：${justification}` }。

结果只有四种：'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'。
- 'allowed-once' 是唯一的放行，只对这一次调用有效。
- 应答者抛错，或返回词表外的值，都被规整成 'unavailable'。
- 没有“总是允许”，没有记忆规则，也不能撤销。

会话日志里记两条，模型都看不到：
- approval/asked { id(uuid), toolName, callId?, reason? }
- approval/decided { id, outcome }

策略：ApprovalPolicy = 'ask' | 'never'，对应的日志事件是 approval/policy { policy }。

发给客户端的线上帧（网关剥掉 agent 和 signal）：{ type: 'waterfall', event: 'approval/request', eventId, agentId, request: { toolName, callId?, reason?, displayReason? } }。客户端只有“允许一次”和“拒绝”两个按钮，Enter 对应 allowed-once，Esc 对应 rejected。

证据：@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4736-4744、4092-4097、326-345; @deepseek-ai/dsh-user-approval/lib/index.js:30-39、128-144、172-189; @deepseek-ai/dsh-user-approval/README.zh.md:56、153-156; @deepseek-ai/dsh-sandbox/lib/index.js:105-115; @deepseek-ai/dsh-api-gateway/lib/index.js:179-194、1081-1095; @deepseek-ai/dsh-client-ui-approval/lib/client.js:70-80、120-135、152-240；README.zh.md:36

## [confirmed] 3c) 审批有没有超时？没人应答时会话是否一直挂起？

没有超时，会一直挂起。

整条链路上都没有计时器：
- decide 只拿瀑布结果和 req.signal 赛跑。
- dsh-api-remotes 的转发监听器在宿主启动时就注册了，它把请求交给网关的 pendingRemoteEvents，只投递给在线的 owner 客户端。
- 没有客户端在线时，请求就一直挂着；客户端断开也只移除投递、不结算；重连时，网关把所有 pending 用同一个 eventId 重投。
- 客户端的 PendingApproval 也没有计时器。

所以在 ask 档、没人点的情况下：
- 工具调用一直在 await，回合不会结束。
- 同一会话之后的 followup（定时提醒、Hub 的唤醒）只能排到下一轮。

等待结束的情形：
- 有人点了允许或拒绝。
- 回合被取消（session.cancel、停止按钮、归档时带 stopActivity、退出 App），signal 中止，结果为 'cancelled'。
- 这个 Agent 的 ctx 被释放：网关 cancel 这次事件，结果为 'unavailable'。

工具调用超时策略管不到：它只包住声明了 timeoutMs 的工具，bash、read、write、edit 都没有声明；pre-execute 阶段的 ask 更在它之外。

never 档不会挂起。

> 核查说明：核对一致。补充几种结算为 'unavailable' 的情形：
- 客户端回了 kind 为 'rejected' 的结果帧：网关 cancel，再 reject。
- 转发事件源被移除或关闭（closeRemoteEvents）。
- 所有收到投递的客户端都 delegate 了：网关 settle next，落到默认的 'unavailable'。

证据：@deepseek-ai/dsh-user-approval/lib/index.js:172-189; @deepseek-ai/dsh-api-remotes/lib/index.js:146-176、233-249; @deepseek-ai/dsh-api-gateway/lib/index.js:851-865（注册时立刻调用 source）、1014、1027-1036、1062-1110、1114-1159; @deepseek-ai/dsh-client-ui-approval/lib/client.js:152-240、284-310; @deepseek-ai/dsh-tool-call-timeout-policy/README.zh.md:42、46; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/docs/design/evidence/07-guard-safety-quota.md:232-248、333-345

## [corrected] 3d) 插件能否用代码应答（批准或拒绝），怎么写才对

能。approval/request 是 cordis 瀑布事件：监听器返回一个结果就算认领了这次请求，调用 next() 就交给下一个监听器。

瀑布的执行规则：
- 监听器按注册顺序执行，只有 { prepend: true } 用 unshift 插到最前面；ctx.on 的第三个参数传布尔值，等同于 prepend。
- next() 不接受参数，下游监听器拿到的是同一个 req 对象。
- 桌面 UI 转发器（dsh-api-remotes）在宿主启动时就注册了，而且除非客户端 delegate，它不调用 next。所以自己的应答者必须 prepend。

作用域：
- 写在宿主层的监听器能收到所有会话的请求，要按 req.agent.id 自己过滤。
- 写在机器人 preset 的某一行里，只会收到绑定这个 preset 的会话的请求。
- 用 agent.ctx.on 注册的，只收这一个 Agent 的请求。
- 官方 dsh-acp 就是用同样的方式做机器应答的：自己的会话认领，其它会话调 next。

其它要点：
- 请求一旦已经交给桌面面板，宿主代码没有公开接口替用户点允许或拒绝，只能取消回合。
- 超时、转飞书、规则表都要自己实现。
- 请求里不带参数：在 prepend 的 tools/pre-execute 里按 exec.callId 记下 name 和 arguments，审批时按 req.callId 查出来；也可以在 pre-execute 里直接返回 { kind: 'deny', reason }。
- 运行时切换策略用 ctx.approval.setPolicy(agent, policy)，它会注入一条通知。不想注入时，用包导出的 setApprovalPolicy(session, policy)，等价于 session.append('approval/policy', { policy })。
- Hub 认领请求后，客户端不会出现 PendingApproval，会话也就不显示“等待审批”。

```
export const inject = ['approval']
export function installBotApprover(ctx, hub) {
  const calls = new Map()   // callId -> { name, arguments }；审批请求本身不带参数
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.agent && hub.isBot(exec.agent.id)) calls.set(exec.callId, { name: exec.name, arguments: exec.arguments })
    return next()
  }, { prepend: true })
  // 改正：原示例只在审批时 delete，而绝大多数调用不审批，Map 会无限增长；在 post-execute 里清理
  ctx.on('tools/post-execute', (exec, _result, next) => { calls.delete(exec.callId); return next() })
  ctx.on('approval/request', (req, next) => {
    if (!hub.isBot(req.agent.id)) return next()      // 普通会话交给桌面面板
    const call = req.callId === undefined ? undefined : calls.get(req.callId)
    return new Promise((resolve) => {
      const done = (o) => { clearTimeout(timer); req.signal?.removeEventListener('abort', onAbort); resolve(o) }
      const onAbort = () => done('cancelled')
      const timer = setTimeout(() => done('rejected'), 10 * 60 * 1000)
      req.signal?.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(hub.decide({ sessionId: req.agent.id, toolName: req.toolName, reason: req.reason, call }))
        .then((o) => done(o === 'allowed-once' ? 'allowed-once' : 'rejected'), () => done('rejected'))
    })
  }, { prepend: true })   // 必须 prepend：api-remotes 的 UI 转发器先注册，而且不调用 next
}
```

> 核查说明：结论核对一致，改正三处：
1. 证据行号：client.js:313 是 apply 的注释。实际驱动“等待审批”状态的是第 295 行的 registerPendingInteraction(pending, …)，以及第 343 行的 ctx.uiSession.registerPendingInteraction。
2. setApprovalPolicy 不是 ctx.approval 上的方法，而是 @deepseek-ai/dsh-user-approval 导出的函数；第三方插件直接 session.append('approval/policy', { policy }) 即可。
3. 原示例的 calls Map 只在审批时删除，会无限增长，已改为在 tools/post-execute 里清理。

另补充一个可选做法：在 prepend 应答者里拿 next() 和自己的计时器赛跑，超时就自己返回 'rejected'。外层结果会立即落定，但桌面面板上那条请求会残留，直到 Agent ctx 被释放或回合被取消，因为没有公开的撤销接口。

证据：@deepseek-ai/cordis/lib/index.js:317-325（waterfall：next 不带参数，同一组 args 传给下一个）、335-345（prepend 用 unshift）、370-380（on）; @deepseek-ai/dsh-api-remotes/lib/index.js:146-176; @deepseek-ai/dsh-user-approval/lib/index.js:176（waterfall(scopeTarget(req.agent, req.agent), …)）; @deepseek-ai/dsh-scope/lib/index.js:315-337；@deepseek-ai/dsh-agent-loop/lib/index.js:778; @deepseek-ai/dsh-acp/lib/index.js:1158-1181; @deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4476-4489（tools/post-execute 与 tools/pre-execute）、6427-6428、8175-8176; @deepseek-ai/dsh-user-approval/lib/index.js:63-66（setApprovalPolicy 是包导出函数）、98-109; @deepseek-ai/dsh-client-ui-approval/lib/client.js:295-298、343（registerPendingInteraction）; @deepseek-ai/dsh-api-gateway/lib/index.js:179-194、1062-1075（网关在 startRemoteEvent 时读取 req.signal）

## [corrected] 4a) 沙箱到底拦什么，哪些东西不在沙箱里

只拦写文件。

写：分两层拦。
- 内核级：bash、pwsh（包括后台作业，子孙进程继承规则）、持久终端、PTC run_code 的子进程，都走 Seatbelt。
- 进程内：write 和 edit 工具走 fs 围栏，先重新 realpath 规范化路径，再检查是否落在 writableRoots 之下。代码注释自己说这是 containment，不是安全边界。

读：不拦。Seatbelt 是 allow default；fs 围栏对读取直接放行。机器人能读全盘，包括其它机器人的目录、~/.ssh、~/.dsh 下的凭据文件。

网络：不拦。

进程：创建进程、发信号、进程间通信都不拦；只有 Linux 的 bwrap 带了 --unshare-pid。

完全不在沙箱里的：宿主插件代码（包括 Hub 自己的工具和钩子）、MCP 服务器进程、web_fetch / web_search、插件安装（由 plugin_manager 的审批或完全权限把关）、用户侧边栏的终端。

环境变量：继承环境里名字匹配凭据模式的变量和 DSH_* 都会被剔除，但 shell 调用会显式注入受管的 DSH_* 变量（见 2d）。

失败即关闭：要求沙箱的模式下没有可用 runner 时，报 SANDBOX_UNAVAILABLE，拒绝执行，不会静默地在无沙箱状态下跑。

> 核查说明：主体核对一致，只改一处：原文说“子进程环境会剔除……所有 DSH_* 变量”，这只对继承来的环境成立。bash 和 pwsh 每次调用都会由 dsh-shell-env 显式注入 DSH_HOME、DSH_SHELL、DSH_SESSION_ID、DSH_PROFILE、DSH_PROFILE_DIR（依据同 2d）。

证据：@deepseek-ai/dsh-sandbox/README.zh.md:166; @deepseek-ai/dsh-fs-sandbox/lib/index.js:68-93、153-166; @deepseek-ai/dsh-sandbox-policy/lib/index.js:57-62; @deepseek-ai/dsh-bash-sandbox/lib/index.js:65-119; @deepseek-ai/dsh-subprocess/lib/index.js:25-56；@deepseek-ai/dsh-shell-env/README.zh.md:12、32; @deepseek-ai/dsh-sandbox/lib/index.js:259-275; @deepseek-ai/dsh-credentials-local/README.zh.md:12、199

## [corrected] 4b) macOS 下沙箱的具体实现方式

macOS 用 Seatbelt，启动方式是：sandbox-exec -p <SBPL> -- bash -c <command>。

runner 的选择：
- darwin 的 runner 链只有 seatbelt 一个候选，直接选用、不做探测，enforcement 记为 full。
- 'sandbox-exec' 按命令名从 PATH 里找。它已被 Apple 标为弃用，但系统仍自带。

SBPL 规则：
- 基础部分：(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))。
- workspace-write 时再加一条：(allow file-write* (subpath <cwd 的真实路径>) (subpath "/private/tmp") (subpath <tmpdir 的真实路径>))。
- confine 会先对 workspaceRoot 做 canonicalPath。
- danger-full-access 时，SandboxBashExecutor 直接执行，不做任何包装。

怎么判定结果：
- 拒绝：退出码非 0，且 stderr 包含 'operation not permitted'（不区分大小写）。记 result.sandbox.denied=true，模型看到 [sandbox: file access denied under <mode> mode]，组合支持提权时再附一行提示。
- runner 故障：退出码非 0，且任一 stderr 行包含 'sandbox-exec: '。抛 SandboxUnavailableError。

每次调用的模式和根都由 ctx.sandboxPolicy.resolve({ session }) 现场计算：模式的优先级是“已批准的提权模式 > 会话最后一条 sandbox/mode 事件 > 部署默认值”，根 = session.header.cwd。

dsh-sandbox-local 只有三个配置项：runnerCommand、runnerFailureSignatures、probeTimeoutMs。Seatbelt 规则本身不可配置。

> 核查说明：改正措辞：原文说“stderr 里以 'sandbox-exec: ' 开头的行视为 runner 故障”。实际是 classifyRunnerFailure 先要求退出码非 0，再看任一 stderr 行（转小写后）是否“包含” 'sandbox-exec: '，不要求出现在行首（dsh-sandbox:224-237）。副作用：模型的命令自己往 stderr 打出这串文字，并且以非 0 退出时，也会被误判为沙箱不可用。其余核对一致。

证据：@deepseek-ai/dsh-sandbox-local/lib/index.js:65-75、173-177、187-192、206-216、233-248、253-257、305-330、490-505、528-530; @deepseek-ai/dsh-sandbox-local/README.zh.md:79、133; @deepseek-ai/dsh-sandbox/lib/index.js:224-237（classifyRunnerFailure：非 0 退出 + 行内包含）、245-249（matchesSignature：非 0 退出 + 包含）; @deepseek-ai/dsh-bash-sandbox/lib/index.js:68-74、101-112、161-167; @deepseek-ai/dsh-sandbox/lib/index.js:64-78；@deepseek-ai/dsh-sandbox-policy/lib/index.js:141-148

## [corrected] 补充 A) 机器人 preset 之外，还会继承哪些工具

tools.view(scope) 的可见集合 = 全局层的工具，加上 Agent scope 链上所有祖先层的工具，再加 Agent 自己层的工具。

宿主层插件（ctx 不带 scope）注册的工具进全局层，对每个 preset 都可见，包括机器人 preset 和用户的普通会话。

桌面组合里仍然启用的宿主层工具行，例如 dsh-base 的 tool-working-directory（工具名 working_directory，能把会话工作目录 cd 到任意已存在目录）。web-app 只禁用了 bash、fs、web 等那些，没有禁用它。

从 preset 里删行去不掉这类工具，只能：
- 按机器人 agent.ctx.tools.restrict({ deny: ['working_directory'] })（注意 1c 的过滤要求）；
- 或者在 preset 行里用 ctx.tools.guard 拒绝。

反过来，Hub 只想给机器人用的工具，必须注册在 preset 行里，不要放在宿主插件里注册，否则用户自己的会话也会看到。

> 核查说明：补充：调研员没有指出全局层工具会被所有 preset 继承。这会影响 1b（删行不等于删工具）和 1d（working_directory 会破坏按目录区分人设的做法）。

证据：@deepseek-ai/dsh-tools/lib/index.js:3036-3060（view：inherited 从 layers.global.tools 开始，再叠加祖先层）; @deepseek-ai/dsh-base/cordis.patch.yml:169-170；@deepseek-ai/dsh-web-app/cordis.patch.yml:482-585（禁用列表里没有 tool-working-directory）; @deepseek-ai/dsh-tool-working-directory/lib/index.js:16-41；@deepseek-ai/dsh-working-directory/lib/index.js:105-150

## [corrected] 补充 B) register 之后怎么确认 preset 可用，以及要避开的死锁

activate 会吞掉所有挂载错误，只记 broken，所以 register 对 broken 的定义也照常 resolve 出注销函数，必须另外检查。

可用的检查手段是 resolve(id)、list()、retain。但它们都会调 diagnostic()：只要有行处于 pending（在等宿主服务），diagnostic() 就会 await this.owner.loader.await()，等整个宿主 Loader 结算。registry 源码注释明确要求调用方不要在宿主行自己的激活过程中调用它们，否则互相等待。

所以在注册 preset 的同一个 ctx.effect 或 Service.init 里，不要 await 这些检查。正确做法：
- 发起检查但不 await；
- 或者在真正唤醒机器人之前再检查（见 1e 的 presetReady）。

```
ctx.effect(async () => {
  const dispose = await ctx.agentPresets.register(def)   // broken 时也会正常返回
  // 不要在这里 await resolve/list：有 pending 行时它们要等整个宿主 Loader 结算，而 Loader 正在等本插件激活完成
  ctx.agentPresets.resolve(def.id).then(
    (r) => { if (r.broken !== undefined) ctx.logger.warn(`agent-hub preset broken: ${r.broken}`) },
    (e) => ctx.logger.warn(`agent-hub preset check failed: ${e}`))
  return dispose
}, 'agent-hub: register bot preset')
```

> 核查说明：补充：调研员写了“register 等激活成功或诊断落定才 resolve”，但没有点明两件事：一是 broken 时 register 不会 reject；二是事后检查有死锁风险。

证据：@deepseek-ai/dsh-agent-preset-registry/lib/index.js:491-493、516-520（catch 记 broken，不向外抛）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:522-544（diagnostic 的注释：Callers therefore must not run inside a Host row's own activation；有 pending 时 await loader）; @deepseek-ai/dsh-agent-preset-registry/lib/index.js:570-581、596-608、632-653; @deepseek-ai/cordis/lib/index.js:1136-1145（effect 返回 Promise 时，其 resolve 值会被当作 disposer 收集）

## 坑

- 01 号底稿“没有 preset 的增删改 API”要更正：宿主插件可以调用 ctx.agentPresets.register 在进程内注册 preset。它不持久化，也不能改单行；Remote 侧仍然只有 list、read、select 三个方法。
- register 对 broken 的定义也正常返回注销函数，不会 reject，可用性要另外检查。检查时调用的 resolve / list / retain，在有 pending 行时会等整个宿主 Loader 结算；在本插件自己的激活过程里 await 它们，可能互相等待。
- register 返回的注销函数必须交给 ctx.effect，或在 Service.init 里 yield 出去。定义的 scope 属于 registry，不随调用方插件销毁；不这样做，插件重载后再注册会报 'Duplicate agent preset'，旧的行代码也会继续跑。
- preset 行如果提供服务，提供方和所有消费方必须在同一个 cordis:group 的 isolate realm 里，否则整个 preset broken（Preset services require isolate realms）。Hub 的共享服务放在宿主层，preset 行在执行时用 ctx.get 去取。
- preset 行配置会经过 structuredClone，config 里只能放纯数据和 { __jsExpr }。
- agent/created 是 serial 事件，监听器抛错会让机器人会话创建或恢复失败；而 tools.restrict 遇到未知工具名、本层自己注册的名字或 run_code 都会抛错。所以 deny 列表要先过滤，再用 try/catch 兜底。
- 宿主层（全局层）注册的工具对所有 preset 都可见，例如 working_directory，从 preset 里删行去不掉，只能 restrict 或 guard。Hub 只想给机器人用的工具，要注册在 preset 行里。
- 冷恢复按 id 取当前定义。经 sessionController.resolveAgent 恢复失败时，error.code 是 'gateway/internal'，原因只在 message 文本里，不是 'agent-preset/not-found'。dsh-schedule 投递失败后不自动重试，所以 preset 要赶在任何机器人会话被恢复之前注册好，唤醒前也先直接调 agentPresets.resolve 确认。
- 运行时注册的 preset 会出现在新任务的模式选择器和设置页的“自定义”分组里，用户也能拿它开普通会话。broken 的 preset 只在设置页显示“加载失败”，模式选择器里看不到。客户端列表只在连接重置或设置更新时刷新。
- 从 standard 派生时，读到的是当前生效的定义，包括 bundle 覆盖补丁和 profile 补丁；DSH 升级或用户改动都会被一并继承。
- 每个 preset 都常驻一整棵插件树，各自带一份 skill-filesystem 文件监听等。机器人多时，用少量角色 preset，再给每个机器人一个目录。
- persona 里完整的 {{…}} 在渲染时严格解析，变量 provider 返回 undefined 时，引用它的段落会渲染失败。skill-filesystem 的 customSkillDirs 不展开 ~，同一层里 providerName 不能重复；它的项目根固定按 .git 找。
- agent-instructions 按会话当前工作目录加载项目链，而宿主层的 working_directory 工具能让模型 cd 到任意目录。靠目录里的 AGENTS.md 区分机器人身份不牢靠，身份要用 agent.id 驱动的提示词变量。用户全局的 $DSH_HOME/AGENTS.md 和 ~/.agents/AGENTS.md 对机器人同样生效；机器人在自己目录里 git init 会把 ~/AgentHub/AGENTS.md 截出链。
- 补丁覆盖 permission 行时 config 整体替换，三个内置档必须一起写上；custom 和 auto 是保留名。用户已保存的默认档如果被删，构造时 this.resolve(defaultPreset) 就会抛错，整个权限服务起不来。用户自己的 profile 补丁最后叠加，可能把你的配置冲掉，设档前先查 ctx.permissionPresets.names。
- approval: never 是在分发前自动拒绝，不是自动放行；prepend 的应答者也拿不到 never 会话的请求。想按规则放行一部分，只能用 ask 加自己写的应答者。
- 自己写的 approval/request 应答者必须 { prepend: true }，因为 UI 转发器在宿主启动时就注册了，而且不调用 next。next() 不接受参数，下游拿到的是同一个 req 对象。
- 审批请求里不带工具参数（plugin_manager 例外，它的 reason 里含 args）。要看参数，就在 tools/pre-execute 里按 callId 记下，并在 tools/post-execute 里清理，否则 Map 会无限增长。approval.request 只能在开放回合内调用。
- 审批在任何环节都没有超时：关窗、断开客户端都不会结算，客户端重连后用同一个 eventId 重投。只有回合取消或 Agent ctx 释放能解开。工具调用超时策略不覆盖 bash、read、write、edit。
- ask_user_question 默认是 legacy 阻塞模式，计划审阅走 user-questions 通道，都会一直等人。机器人 preset 应去掉 tool-ask-user 和 planning；计划模式只能由用户敲 /plan 进入。
- 沙箱只限写：读全盘（包括 ~/.dsh 下的凭据和 ~/.ssh）、联网、起进程都不拦。macOS 上 /private/tmp 和 $TMPDIR 对所有会话可写，机器人之间可以互相篡改临时文件。
- bash 环境里继承来的 DSH_* 和凭据名变量会被剔除，但每次调用都会显式注入 DSH_HOME、DSH_SHELL、DSH_SESSION_ID、DSH_PROFILE、DSH_PROFILE_DIR，机器人可以直接定位 DSH 主目录。
- 宿主插件代码、MCP 服务器、web_fetch / web_search 都不在沙箱里。宿主代码调 ctx.fs 或 ctx.shell 不传 sandboxPolicy 时，回落到部署默认规则：桌面宿主进程的 cwd = ~/.dsh/profiles/desktop，写 ~/AgentHub 会被拒。
- workspace-write 的可写根是会话创建时定下的 header.cwd，之后不能改；working_directory 的 cd 不改变它；在工作区里放指向外部的符号链接也扩不出去。
- /permission <名> 会给模型注入“策略已被用户更改”的消息；permissionPresets.set 只写日志、不注入。带参数的 /permission 切到完全权限时不弹风险确认，创建机器人的插件要自己把权限档夹紧。
- never 档下 bash 结果里仍可能出现 escalation available 提示：是否显示只取决于执行器能不能约束，与审批策略无关。模型照做去提权，会立即收到 'the user rejected escalating…' 的错误，实际是系统自动拒绝。

## 未决

- 第三方插件能否 import 共享包，比如 @deepseek-ai/dsh-tools 的 defineTool、@deepseek-ai/cordis-plugin-include 的 entryListSchema？补充证据：_app/desktop-runtime.json 的 sharedPackages 里有这两个包；dsh-app-boot 的运行时解析会拦截 Node 的 ESM / CJS 解析器，把安装目录里的包提供给 profile 里的包（lib/index.js:499-503、1842-1860）。js-yaml 不在共享表里，必须自带。推断可行，但未实测。
- 'dsh-agent-hub/bot-tools' 这种子路径行挂在 registry 拥有的 PresetTree 里，按调用方 baseUrl 经 loader.internal.import 加运行时解析，能否解析到本包 exports 的子路径？未实测。另外 profile 预检的 manifestOf 也会按这个名字找 package.json 做 engines 检查。
- 运行时注册与 dsh-schedule 的启动驱动、UI 恢复会话之间谁先谁后？registry README 说 pending 行“启动顺序不决定结果”，但定义还不存在时，恢复会直接失败而且不重试。需要实测；如果有问题，就改用 bundle 补丁静态声明这个 preset。
- 在插件 apply 的 ctx.effect 里循环重试 readDocument('standard')（最长约 10 秒），会不会推迟宿主 Loader 结算，进而拖慢其它会话恢复或 diagnostic？需要实测。
- 超时后能否让桌面审批面板同步消失？next() 不接受参数，要换 signal 只能在调用 next() 之前原地改写 req.signal（运行时可写，类型上是 readonly）；网关在 startRemoteEvent 时读取 signal，abort 时给客户端发 cancel 帧。这个做法未实测，可能随版本失效。另一个做法是和 next() 赛跑，但面板会残留。
- Seatbelt 下，通过工作区里的硬链接改写工作区外的同一个文件对象，会不会被拦？符号链接已确认扩不出去，硬链接未验证；Windows ACL 的 README 明确把硬链接列为部分强制。
- 客户端用 ctx.sessions.scopeOf(owner) 映射不到会话时会调 next()，结果是 unavailable，也就是被拒绝。用户从没在 UI 里打开过的机器人会话，客户端能不能映射到，未验证。
- persona 用 {{hub_bot_identity}} 变量区分人设时，assemble 每轮调用的频率、对已记录的系统提示词和 KV 缓存前缀有什么影响？refreshContext 不重跑变量 provider，但 assemble 的触发时机没有逐行核实。
- 按纪律没有读取 ~/.dsh 下的 profile 补丁，所以不知道用户当前是否已经覆盖了 permission 行、preset-standard 行，或开启了 Auto review。这会影响 readDocument('standard') 读到的内容，以及自定义权限档会不会被冲掉。
- 在第一轮之前追加的 permission/preset、sandbox/mode、approval/policy 事件，重启后能否保留？user-approval README:77 说轮次之间的裸事件在重载时与崩溃尾巴无法区分；但 jsonl 持久化层只截断不完整的物理尾巴，官方 pinInitialPermission 也是在轮次外写入的。推断可以保留，需实测：建好机器人会话、调 set('unattended')、在第一轮前重启，再读 permissions 投影。
- run_code 的超时问题（部分回答）：run_code 自身的提权审批用的是 exec.signal（dsh-tools/lib/index.js:1531 run(exec.signal)），而 run_code 定义上没有工具级 timeoutMs，推断这一步不受超时约束；程序内部的嵌套工具和审批等待计入 PTC 运行时期限（参数说明见 1003-1006）。只在 PTC 模式下相关，未实测。
