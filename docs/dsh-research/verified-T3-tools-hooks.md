# T3-tools-hooks

## [corrected] Q1-a 插件怎么注册一个给模型用的工具：服务名、方法签名、定义字段、参数 schema 写法（zod 还是 JSON Schema）

服务是 ctx.tools（插件 export const inject = ['tools']），方法 register(definition: ToolDefinition): () => void，返回撤销函数。用插件自己的 ctx 注册就进全局层，这次注册是插件 fiber 上的 effect，插件卸载或重载时自动撤销。注册即生效：ToolRuntime 构造时调用 ctx.systemPrompt.tools(...)，可见 schema 会自动进入提示词组装和请求的 tools 列表。入口用官方形式 export const name / export const inject / export function apply(ctx, config)。

推荐用 defineTool（import { defineTool } from '@deepseek-ai/dsh-tools'）构造定义。运行时实际加载的是打包后的 lib/index.js；lib/types/schema.js 是同内容的副本。字段如下：
• name：同一层重名直接抛错。全局层报 'tool "x" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)'。'run_code' 是保留名。作用域内注册会遮蔽继承来的同名工具。
• description：原样发给模型。
• parameters：DSH 自己的值 schema DSL，既不是 zod，也不是裸 JSON Schema。顶层写成 { 参数名: 节点 }，编译成 { type:'object', properties, required? }。顶层不封闭，多余参数也能通过校验。节点按类型限制可用的键：
  – string、number、integer、boolean、null 只能再带 enum 或 const，enum 必须非空且类型匹配；
  – array 只能带 items；
  – object 必须显式写 additionalProperties: true 或 false，可以带 properties；
  – json 表示任意 JSON，只能带注解；
  – oneOf 至少两支，而且不能和 type 同时出现；
  – 所有节点都可以带 description、title、default、examples；
  – required 只能写 true，而且只能写在某个对象的属性条目上，不能写在 items、oneOf 分支或 output 根上；
  – 不支持 minLength、pattern、minimum、format，也不支持 type 写成数组。
  模型给的实参在执行前严格校验；不合法时 handler 不执行，模型收到 'Error: invalid arguments: …'（code INVALID_ARGS），回合不中断。
• output（必填）：{ schema, render(args, value) => ContentBlock[], presentationMeta?(args, value) }。schema 用同一套 DSL，根可以是任意类型。原生模式下发给模型的只有 name、description、parameters、deferLoading 四项。
• execute(args, exec)：async。
• 可选字段：
  – timeoutMs：只是声明。真正掐时间的是宿主默认挂载的 dsh-tool-call-timeout-policy：到点 abort exec.signal，模型收到 'Error: tool call timed out after <ms>ms'（info.code TOOL_TIMEOUT），前提是 handler 响应 signal；
  – isConcurrencySafe(args)：严格返回 true 才能并行；
  – projectContent、finalizeContent；
  – deferLoading: true。

更正：presentCall 和 presentResult 只给 Host 本地消费方用，桌面内置的 Web Client 不读它们。Web 卡片由客户端按 tool.call.toolview 选择渲染器，从原始参数、结果 content、失败状态和持久化的 meta（也就是 output.presentationMeta 的返回值）派生出来。

zod 只用于会话投影的 stateSchema；schemastery 的 z 只用于插件 Config。工具参数两者都不用。

> 核查说明：原说法里『presentCall / presentResult：UI 卡片』有误，依据是 dsh-tools/README.zh.md:95。另外补了四处：DSL 的键按类型受限；required 只能写在对象属性条目上；全局层重名时的报错文案；运行时 defineTool 位于 lib/index.js。其余结论与代码一致。调研员的 hub_report 示例代码能直接用，唯一要改的是 concludeTurn 那行注释，限制见 Q1-b。

证据：证据根目录：dsh-src = /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src（下同）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2798、2802（服务名 'tools'；ctx.systemPrompt.tools(...) 自动送 schema）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2974-2983（register 只校验 output{schema,render,presentationMeta?}、timeoutMs、run_code；返回 layers.effect 撤销函数）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2731（全局层/作用域层重名报错文案）; dsh-src/@deepseek-ai/dsh-tools/package.json exports '.' → lib/index.js；lib/index.js:838 起为运行时 defineTool；lib/types/schema.js:274-354 为同内容副本; dsh-src/@deepseek-ai/dsh-tools/lib/types/schema.js:78-82（required 只能 true）、126-133（required 仅属性条目允许；oneOf 不能与 type 并存）、150-205（各 type 允许的键；object 必须显式 additionalProperties）、238-247（参数根编译，不加 additionalProperties）、249-257（ToolArgsError / INVALID_ARGS）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:34-58、227、323-327（原始 JSON Schema 子集白名单、oneOf ≥2）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3135-3145（schemaOf 只投影四项）、3153-3157（isConcurrencySafe 严格 === true）; dsh-src/@deepseek-ai/dsh-tools/README.zh.md:95（内置 Web Client 不消费 presentCall/presentResult）; dsh-src/@deepseek-ai/dsh-tools/README.zh.md:30、235；dsh-src/@deepseek-ai/dsh-tool-call-timeout-policy/lib/index.js:93-140；dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:408-409（宿主默认挂载，dsh-web-app/cordis.patch.yml 未禁用）; dsh-src/@deepseek-ai/dsh-tool-todo/lib/index.js:95-193（官方最小工具范例）；dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:3-27、57-64

## [corrected] Q1-b handler 签名、在 handler 里怎么拿到是哪个会话/agent 在调用、返回值格式、报错格式

handler 签名是 execute(args, exec: ToolRunContext): Promise<JsonValue>。

exec 由 createExecution 在任何策略之前生成，字段有：
• callId；
• rootCallId：PTC 子调用指向外层调用；
• name；
• arguments：快照后深冻结；
• signal：handler 必须遵守；
• agent?；
• parent?：只有 PTC 子调用才有；
• schema?；
• token：同进程内关联用的 Symbol。
另有两个方法：deferContext(message: UserMessage) 和 concludeTurn()。

拿会话：
• exec.agent 由 agent-loop 用 ctx.agents.requireInitiator() 填入。
• exec.agent.id 就是 SessionId，等于 exec.agent.session.id。这个断言在 Agent 注册表的 enter() 里。
• exec.agent.session.header = { version, id, createdAt, cwd?, parentSession?, isSeeded, origin?: 'subagent', delegationDepth?, agentPreset? }。
• 子代理调用时 exec.agent 是子代理本身，用 header.origin === 'subagent' 加 header.parentSession 回溯。
• 程序化的无 agent 调用里 exec.agent 是 undefined。官方工具都先判空，为空就抛错。
• 权限档用 ctx.permissionPresets.current(exec.agent.session) 读，需要 inject 'permissionPresets'。
• 备选：ctx.agents.currentInitiator()。

返回值：
• 必须是无损 JSON。返回 undefined、函数、NaN 等会得到 INVALID_TOOL_OUTPUT。想返回空，就把 output.schema 写成 {type:'null'} 再返回 null。
• 先快照，再按 output.schema 校验。不符时模型收到 'Error: tool "<name>" returned invalid output: …'。
• 校验通过后，render 的结果就是模型能看到的内容。
• 成功结果为 { isError:false, value, content, meta?, additionalContexts?, concludesTurn? }。

报错：
• 直接 throw，结果为 { isError:true, content:[{type:'text',text:'Error: <message>'}], error:{ message, info? } }。
• info 只在抛 HarnessError(message, code) 时才有，内容是 {name, code}，给 UI 和日志用。
• 工具失败不结束回合。
• 未注册或对该 agent 不可见的工具，分发时报 UNKNOWN_TOOL。但在报错之前，这次调用仍会先经过 tools/pre-execute 和 guard。
• 日志顺序：tool/call 在 pre-execute 之前写入，tool/result 最后写入。

concludeTurn() 的真实语义（更正）：
① 只对成功结果生效。handler 抛错、输出校验失败、post-execute 返回 block，都不会收口。
② 同一条 assistant 消息里的其他工具调用照常执行。
③ 这一步结束后，只有 next-step inbox 为空才收口。同一步里用 deferContext 或 post-execute 的 additionalContexts 附带的上下文，以及期间到达的 steer、inject，都会让循环再请求一次模型。
所以『汇报完就睡』的工具里不要同时调用 deferContext，宿主也别在这时对该 agent 调用 steer 或 inject。

> 核查说明：原说法『concludeTurn()：本步工具结果落盘后回合直接收口，不再请求模型』过强，改正依据见上方三条证据：失败结果的 concludesTurn 类型是 never；agent-loop 只在 nextStep 为空时 break；catalog 原文写明收口不会短路已提交的 next-step 工作。另外补了两处：未知工具仍会进 pre-execute；id 断言所在的位置。

证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3227-3290（createExecution；未知工具只在 PTC 收口时提前拒绝，否则照常进策略）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:8167-8176、8247-8248（ToolExecution / ToolExecutionInput / ToolRunContext）、8172（ToolExecutionFailure.concludesTurn?: never）、8187-8188（ToolExecutionSuccess）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3637-3667（createSuccessResult：快照→校验→render；只有成功结果写 concludesTurn）、2672-2681（非无损 JSON → INVALID_TOOL_OUTPUT）、3712-3725（toolErrorResult）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:506-518（requireInitiator 填 exec.agent）、519-531（concluded 不中断后续调用）、572（additionalContexts→acceptContext）、1166-1167（acceptContext 写入 next-step inbox；concluded→completed）、1001-1007（只有 nextStep 为空才 break）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4036-4041（agent/turn-stopping 原文：The conclusion never short-circuits already-submitted next-step work）; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:512-514（id 与 session.id 的断言在 Agent 注册表 enter()）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:7143-7144（SessionHeader）；dsh-src/@deepseek-ai/dsh-experimental-auto-review/lib/index.js:461-465（permissionPresets.current 用法）

## [confirmed] Q1-c 第三方插件能不能 import defineTool（模块解析/打包），以及不 import 的原始写法

两种写法都能跑。

写法 (a)：import { defineTool } from '@deepseek-ai/dsh-tools'。
• 官方包不会随插件安装，运行时由 runtime resolution 解析到安装包里的同一份实例。
• install_bundle 安装本地目录时是 link，插件留在原目录。解析器走 routeLinked：从被 import 的文件所在目录逐级向上查找，每一级按顺序判断：
  ① 该级目录的 package.json 的 peerDependencies 含这个包名，就路由到安装实例；
  ② 否则看该级 node_modules 里有没有本地副本，有就用副本；
  ③ 全部没有命中，就交给 Node 原生解析，通常会报 ERR_MODULE_NOT_FOUND。
• 所以插件自己的 package.json 必须在 peerDependencies 里列出 '@deepseek-ai/dsh-tools'。同一级上，peer 声明优先于本地副本。
• 绝不要写进 dependencies，否则可能生成一份遮蔽宿主实例的副本，看板踩过这个坑。
• 版本闸门写在顶层 engines.dsh。写了它就只看它，忽略 peer；匹配时 includePrerelease: true。写在 dsh.engines 下无效，用户的 dsh-net-tuning 就写错了位置。
• 用 HarnessError 或 createUserMessage 时，同样把 '@deepseek-ai/dsh-llm' 列成 peer。

写法 (b)：不 import 任何包，直接把 ToolDefinition 对象传给 ctx.tools.register。
• 注册表只检查 output（schema 属于受支持子集、render 是函数）、timeoutMs 和 run_code 保留名。
• 不校验 parameters，也不校验入参。模型给了坏 JSON 时 args 是原始字符串，空参数时是 {}，必须自己校验。官方 dsh-subagent 的结构化输出工具就是这么写的：自己校验后抛 ToolArgsError。
• raw parameters 原样发给模型，只经过 structuredClone。

调研员的两段代码都可以照用。

> 核查说明：代码逻辑核实无误。补充一点：同一级目录上 peer 声明优先于本地 node_modules 副本。模板里的 autoInstallPeers:false 只在初始化 profile 时写入，老 profile 是否相同，在不读 ~/.dsh 的前提下无法确认。真机 import 仍未验证，保持 medium。

证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:1336-1352（findInterceptionLayer 判 linked 层；readPeerNames 只读 peerDependencies）、1624、1676-1730（routeLinked 逐级：先 peer→interception，再本地副本，最后 native）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:664-692（linked 根 = profile/node_modules 下指向 profiles 树外的符号链接）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:276-298（engines.dsh 优先、includePrerelease；否则只检查 @deepseek-ai/dsh 与 dsh-* 的 peer 范围）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:598-607（profile pnpm-workspace 模板 autoInstallPeers:false；已有文件不改写）；dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:52、67; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:35（Local directory installation links the checkout）; dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:903-930；dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:535-541；dsh-src/@deepseek-ai/dsh-system-prompt/lib/index.js:370-373（schema 只做 structuredClone）; /Users/bytedance/Documents/DSHarness Doc/dsh-net-tuning/package.json:15-22（engines 写在 dsh.engines 下）

## [corrected] Q2-a 怎么让工具只对特定会话或特定 preset 可见

工具对谁可见，由注册时用的 ctx 属于哪个作用域决定；监听器能收到谁的事件，也由同一套作用域决定。有三种写法：

① 宿主插件用自己的 ctx 注册：进全局层，所有会话和子代理都看得见。注意：如果 preset 层也有同名工具，preset 层会遮蔽全局层，所以全局工具一律加 hub_ 前缀。

② 写进某个 preset 的 plugins 列表：注册进该 preset 的作用域层。
• 用这个 preset 建的会话看得见；它们派出的子代理通过 composeFrom 加入同一个 preset 代际，也看得见。
• 新建 preset 要写 bundle 补丁：插入一行 '@deepseek-ai/dsh-agent-preset'，配上 config.id 和 plugins。plugins 必须写全，不会跟随 standard 的后续更新。
• preset 只能在空白会话上选择或切换。

③ 在某个 agent 的 agent.ctx 上注册：只有这个 agent 看得见。机器人专用工具推荐这种写法。参考官方 dsh-experimental-tool-agent-team：
• apply 时遍历 ctx.agents.list() 补装；
• 监听 agent/created 新装；
• 监听 agent/disposed 撤销；
• 在插件自己的 ctx.effect 里全部撤销。agent.ctx 上的注册有两个 owner，插件卸载不会自动撤销，所以要这样做。

agent/created 是 serial 事件：先等监听器跑完才算创建完成，AgentLoop 在这之前扣住输入，所以机器人第一次思考时工具已经就位。

更正：本版只有两个触发来源。新建时 source 是 'startup'，重启后恢复时是 'resume'。'clear' 和 'compact' 只是保留值，目前没有代码发出。

识别机器人：
• 方法一：查名册，并排除 header.origin==='subagent'。
• 方法二：用 preset 判断，ctx.agentPresets.composedPreset(agent.ctx)。setup 阶段已经 mount，agent/created 时就能读到。不要用 header.agentPreset：它是创建时的快照，空白会话后来换 preset 时它不会变。

更正：sessionController.create({ sessionId }) 的语义是『复用指定的空白会话』。
• id 不存在时，才用这个 id 新建；
• id 已存在且发生过 turn/start，或不属于指定 workspace 时，会另铸一个 'session-<uuid>'；
• 所以必须以返回的 sessionId 为准。
想在 agent/created 时就认出新机器人，要先生成一个必然不存在的新 id、登记进名册，再调用 create。

子代理的作用域父链是 preset 代际，不是父 agent。所以写法 ③ 装在机器人 agent.ctx 上的工具、restrict、guard 和作用域监听器，都管不到它派出的子代理。

```
import { randomUUID } from 'node:crypto'

// inject: ['tools', 'agents', 'sessionController', 'agentPresets']
// sessionController.create 的 sessionId 语义是『复用指定的空白会话』：
//   id 不存在 → 用这个 id 新建；id 已有 turn/start 或不属于指定 workspace → 另铸 session-<uuid>。
// agent/created 在 create() 返回之前就会触发，所以先登记一个必然不存在的新 id。
async function createBotSession(ctx, hub, maybeInstall, { cwd, agentPreset, bot }) {
  const wanted = `session-${randomUUID()}`
  hub.preRegister(wanted, bot)
  const { sessionId } = await ctx.sessionController.create({ sessionId: wanted, cwd, ...(agentPreset === undefined ? {} : { agentPreset }) })
  const actual = String(sessionId)
  if (actual !== wanted) {                       // 兜底：以返回值为准，并补装专用工具
    hub.rename(wanted, actual)
    const agent = ctx.agents.get(sessionId)
    if (agent !== undefined) maybeInstall(agent)
  }
  return actual
}

// 判定：名册 + 排除子代理；按 preset 判断时用 live 绑定，不用 header.agentPreset
const isBotRoot = (hub, agent) => agent.session.header.origin !== 'subagent' && hub.hasBot(String(agent.id))
const presetOf = (ctx, agent) => ctx.agentPresets.composedPreset(agent.ctx)
```

> 核查说明：原说法『resume、clear、compact 会生成新的 Agent 并再次触发 agent/created』不准确：本版只有 'startup' 和 'resume' 两个发出点，见 dsh-agent README.zh.md:186。原说法『sessionController.create 接受 sessionId，可以先登记再创建』漏了复用和另铸新 id 的规则，见 api-session-controller 416-456、508-510。另外补了 header.agentPreset 会过时这一点。调研员的安装代码（install、maybeInstall）本身可用，restrict 的限制见下一条。

证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3055-3089（view：继承层先过滤；本层注册始终可见并遮蔽；祖先层覆盖全局同名）; dsh-src/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:227-249、531-553；dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:8、19; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3956-3961（agent/created：serial、阻塞输入、抛错使创建失败、不得 await whenIdle）、7391-7392（SessionStartSource）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1909、2012；dsh-src/@deepseek-ai/dsh-agent/lib/index.js:494；dsh-src/@deepseek-ai/dsh-agent/README.zh.md:186（'clear'/'compact' 已保留但尚无发出方）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:264-268（createSession）、416-456（claim：不存在才按该 id 建；非空白→createMinted）、508-510（session-<uuid>）、755-787（create）、350-362（composeAgent：setup 里 installSelection + presets.mount）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1827（header.agentPreset 来自创建时 meta）；dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:117-122、139-143（composedPreset；select 只在首轮前）; dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:654-711；dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:381

## [confirmed] Q2-b 能否在运行时（不写 YAML）为机器人注册专用 preset

可能可以，但没实测。

ctx.agentPresets.register(definition: PresetDefinition): Promise<() => Promise<void>> 是公开方法，catalog 说明 'the declaring plugin owns it'，也就是谁声明谁持有。PresetDefinition 的结构是 { id, name?, description?, order?, plugins: Array<{ id?, name, config?, disabled?, … }> }。YAML 里的 preset 行（@deepseek-ai/dsh-agent-preset）本身就是在 Service.init 里调用 ctx.agentPresets.register(this.config)。

所以 06 号底稿『preset 没有运行时写接口』应改为『没有持久化写接口』：README 说注册表不写入任何声明，只能读取。

风险：
• 插件重载会让旧代际退役；
• 重启后恢复会话时，必须已有同 id 的定义，否则拒绝恢复；
• preset 里的插件行不能向全局泄漏 Service，否则激活审计会拒绝挂载。

落地前先实测。实测之前，用 Q2-a 的写法 ③ 就足够。

> 核查说明：API 事实都已核实。运行时注册的可行性、与会话恢复的先后顺序仍未实测，所以保持 low。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:70-75（agentPresets.register）、6411-6412（PresetDefinition）; dsh-src/@deepseek-ai/dsh-agent-preset/lib/index.js:7-27（YAML 行在 Service.init 里 register(this.config)）; dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md:48、56、58、60

## [corrected] Q2-b ctx.tools.restrict 与 ctx.tools.guard 的用法

restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
• 只能在作用域 ctx 上调用，也就是 agent.ctx 或 preset 内插件的 ctx。在宿主的全局 ctx 上调用会抛错。
• allow 表示只保留这些继承来的工具，deny 表示去掉这些。多个 restrict 取交集。
• 只作用于继承来的工具，即全局层和祖先层；本作用域自己注册的工具不受影响，run_code 也不受影响。
• 点名的工具必须在『限制前』的继承集合里，否则抛 'names unknown global tool …'。例如 standard 里 disabled 的 plugin_manager 和 plugin_market 不在集合里，点名它们会抛错。先用 ctx.tools.get(name, agent) !== undefined 过滤一遍。
• 传 {}（allow 和 deny 都没写）会抛错；不能点名 run_code。
• 注意：{ allow: [] } 是合法调用，会隐藏全部继承工具。过滤后为空就不要调用。
• 被屏蔽的工具同时从 schema、查找和执行中消失，硬调会得到 UNKNOWN_TOOL；同时触发 tools/change。
• 会话中途 restrict，会写一条 tool-removal 开发者消息，并让 KV cache 前缀失效，所以最好在 agent/created 时一次性设好。

guard(guard: (exec: Readonly<ToolExecution>) => string | undefined): () => void
• 必须是同步函数。只在 pre-execute 最终决定为 allow 时运行，ask 获批后也会运行。
• 判定条件是 `reason !== undefined`：『不管』必须返回 undefined。返回 null、false、'' 都会被当成拒绝理由，模型会看到 'Error: null' 这类内容。
• 它是单调的：任何监听器都无法把 guard 的拒绝改回允许。
• 宿主 ctx 上的 guard 作用于全部 agent，agent.ctx 上的只管该 agent。判定顺序是先全局层，再沿作用域链。
• 需要异步判断的，用 tools/pre-execute 返回 ask 或 deny。

官方给的手段强弱排序：restrict（只能删工具）< guard（只能拒绝）< waterfall 监听器（能改结果，但依赖注册顺序）。

```
// guard：『不管』必须 return undefined；null / false / '' 都会被当成拒绝理由
ctx.tools.guard((exec) => {
  if (exec.agent === undefined || !hub.isBotTree(exec.agent)) return undefined
  // file_path 可能是相对路径或 ~ 开头，按 exec.agent.session.header.cwd 解析后再判断
  if ((exec.name === 'write' || exec.name === 'edit') && hub.touchesDshHome(exec.agent, exec.arguments?.file_path)) return 'Bots may not modify files under ~/.dsh.'
  return undefined
})

// restrict：只能在 agent.ctx（或 preset 内插件的 ctx）上调；名字必须是继承来的工具；过滤后为空就别调
const allow = ['read', 'grep', 'glob', 'web_fetch', 'todo_write'].filter((n) => ctx.tools.get(n, agent) !== undefined)
if (allow.length > 0) agent.ctx.tools.restrict({ allow })   // allow: [] 会隐藏全部继承工具；{} 直接抛错
```

> 核查说明：补充 3 处会导致写错的细节，依据见 index.js:2745-2746、3030、2996、3068：guard 返回非 undefined 的任何值都算拒绝；{ allow: [] } 会隐藏全部继承工具；可点名集合是限制前的继承名。其余结论与代码一致。

证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2991-3006（restrict；2996：只有 allow 和 deny 都未定义才抛 {} 错）、3002/3068（restrictableNames 为限制前的继承名）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2737-2748（ToolLayer.admits；guardReason 以 reason !== void 0 判拒绝）、3017-3032（guard 注册与全局→作用域链判定）、3337-3339（只有 allow 才跑 guard）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3365-3373、8199-8200、8231-8232; dsh-src/@deepseek-ai/dsh-tools/README.zh.md:85、89、172-176；dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1212-1258；dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:10、17

## [corrected] Q2-c tools/pre-execute 钩子：能否拒绝/改写一次工具调用，怎么拿到调用参数与会话 id

签名：'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>。注册方式：ctx.on('tools/pre-execute', fn, { prepend: true })。

返回值 PreToolDecision 有四种：
• { kind:'allow' }：默认值，放行。
• { kind:'deny', reason: string, info?: { name, code, reason? } }：不执行，模型看到 'Error: <reason>'；info 只进日志和 UI。
• { kind:'cancel' }：模型看到 'Error: tool call aborted before dispatch'（ABORTED_BEFORE_DISPATCH）。
• { kind:'ask', reason?, displayReason?: { en, [locale] } }：走 ctx.approval.request。结果为 allowed-once 才执行，其余都转成 deny：
  – 被拒：'the user rejected tool "x"'；
  – 被取消：'approval for tool "x" was cancelled'；
  – 没有应答渠道：'tool "x" requires approval, but no approval channel is available'；
  – 没有 approval 服务：用 ask.reason 作理由的 deny；
  – exec.agent 为空：直接 deny。
不打算做决定时 return next()。

决策对象必须写对（补充）：registry 只在 kind==='allow' 时跑 guard，其余情况一律把 decision.reason 当拒绝理由。所以：
• { kind:'deny' } 漏写 reason，或返回未知的 kind，都会被当成放行，而且跳过 guard；
• 监听器忘了 return（返回 undefined）会在读取 gate.kind 时抛 TypeError，这次调用变成错误结果；
• 监听器抛错时，结果直接定稿，跳过 post-execute，但 tools/result 仍会触发。

拿参数和会话：
• exec.name：工具名；
• exec.arguments：解析后的实参，深冻结；
• exec.callId；
• exec.agent?.id 加上 exec.agent.session.header。
• PTC 模式下 run_code 内部的子调用也会经过这个钩子，此时 exec.parent 有值，callId 形如 '<外层>:ptc:<n>'。
• 未注册的工具名也会进这个钩子，handler 要能处理。
• callId 由模型或供应商生成，不保证跨会话唯一。按 callId 缓存参数时，键要加上 agent.id。

不能改写参数：README 明说有意不允许改写 exec.arguments。替代办法：
• deny，并在 reason 里写清正确参数，让模型重新调用；
• 在 'tools/execute'(exec, next) 里不调 next()，直接返回替代结果。成功结果仍按该工具的 output.schema 校验，错误结果原样透传；
• 在 'tools/post-execute'(exec, result, next) 里返回 { kind:'accept', content? }、{ kind:'accept', value }（只能用于成功结果）或 { kind:'block', feedback }，都可以附带 additionalContexts；
• 'tools/result'(exec, result) 只能观察，适合记账。
拒绝和取消的结果也会经过 post-execute。

作用域：宿主 ctx 收到全部调用；agent.ctx 只收该 agent 的；preset 内插件收该 preset 下的。

默认组合里只有 dsh-tool-jobs（prepend）和 dsh-workspace-changes 注册了这个钩子，两者最终都 return next()。实验性的 auto-review 用 prepend 做逐次审查，可作参考实现。

```
export const name = 'dsh-agent-hub'
export const inject = ['tools']

// callId 由模型/供应商生成，不保证跨会话唯一：缓存键带上 agent.id
export const callKey = (agent, callId) => `${String(agent?.id ?? '-')}:${String(callId)}`

export function apply(ctx) {
  const argsByCall = new Map()
  ctx.on('tools/pre-execute', (exec, next) => {
    const agent = exec.agent
    if (agent === undefined || !hub.isBotTree(agent)) return next()      // 不做决定必须 return next()
    const args = exec.arguments                                          // 深冻结，只读
    if (exec.name === 'web_fetch' && !hub.urlAllowed(agent, args?.url)) {
      // reason 必须是字符串：漏写 reason 或返回未知 kind 会被当成放行，而且跳过 guard
      return { kind: 'deny', reason: 'web_fetch is limited to this bot allow-list; pick an allowed URL.', info: { name: 'HubPolicyError', code: 'HUB_URL_BLOCKED', reason: String(args?.url) } }
    }
    if (exec.name.startsWith('mcp__feishu__')) {
      argsByCall.set(callKey(agent, exec.callId), { name: exec.name, args })
      return { kind: 'ask', reason: `bot ${String(agent.id)} wants to call ${exec.name}`, displayReason: { en: 'A bot wants to send a Feishu message', zh: '机器人要发飞书消息' } }
    }
    return next()
  }, { prepend: true })

  // 每个调用（含被拒、抛错、取消）最终都会到这里：清缓存、记账
  ctx.on('tools/result', (exec, result) => {
    argsByCall.delete(callKey(exec.agent, exec.callId))
    if (exec.name === 'web_search' && exec.agent !== undefined) hub.countSearch(exec.agent, result.isError)
  })
}
```

> 核查说明：补充一个会造成安全漏洞的细节，依据 index.js:3337-3339：deny 不带 reason 或返回未知 kind，等于放行且跳过 guard。另补三处：抛错时跳过 post-execute；未知工具也进钩子；callId 缓存键要加 agent.id。其余与代码一致。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4484-4490、6427-6428、4468-4504、6383-6384; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3310-3370（prepareExecution：3321 waterfall；3337 denialReason = allow ? guardReason : decision.reason；3339 仅当 !== undefined 才拒；3363-3369 抛错→final-result）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3535-3588（serviceAsk 四种映射及无 approval 服务/无 agent 的降级）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3258-3265；dsh-src/@deepseek-ai/dsh-tools/README.zh.md:233; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3423-3445、3599-3630、3672-3695（normalizeDispatchResult）、3505-3520; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:1362-1377（PTC 子调用）; dsh-src/@deepseek-ai/dsh-experimental-auto-review/lib/index.js:416-488；dsh-src/@deepseek-ai/dsh-tool-jobs/lib/index.js:235-239；dsh-src/@deepseek-ai/dsh-workspace-changes/lib/index.js:1086-1094

## [confirmed] Q3-0 钩子通用规则：注册方式、作用域过滤、执行顺序、prepend、next、serial 的 bail

注册：
• 在 apply 里调用 ctx.on(event, listener, options?)。
• options 可写 { prepend: true }（直接传布尔值 true 等价），或 { global: true }（绕过作用域过滤）。
• 返回撤销函数，它也是插件 fiber 上的 effect，插件卸载时自动移除。
• 所有 context 的监听器存在同一个数组里：普通注册按注册时间追加到末尾，prepend 插到最前，分发时再按作用域过滤。

作用域：
• agent/*、approval/request、user-questions/request、tools/pre-execute、tools/execute、tools/post-execute、tools/result 按 agent 作用域分发（scopeTarget）。agent/* 事件会把 agent 注入 payload；tools/* 事件通过 exec.agent 携带。
• 例外：tools/change 不过滤作用域。
• 宿主 ctx 上的监听器收全部 agent 的事件；agent.ctx 上的只收该 agent 及其后代；preset 内插件收该 preset 下全部 agent 的。

waterfall 类事件（agent/pre-step、agent/request、agent/request-error、approval/request、user-questions/request、tools/pre-execute、tools/execute、tools/post-execute，另有 llm/stream、system-prompt/assemble）：
• 外层先跑；不调 next() 就截断后面所有监听器，连默认行为也跳过。
• 不打算做决定就必须 return next()。
• 要修改 next() 的结果，先 await next() 再展开，保留 startsRequestSeries 这类字段。

serial 类事件（agent/created、agent/turn-stopping）：
• 依次 await 每个监听器；任何监听器返回 null、false、undefined 以外的值，后面的监听器都会被跳过。所以写成块体、不返回值。

emit 类事件（agent/status、agent/error、agent/disposed、tools/result、session/event …）：只是通知，监听器异常会被兜住、记日志。

异常的后果：
• tools/pre-execute 抛错：该次调用变成错误结果，跳过 post-execute；
• approval/request 抛错：按 'unavailable' 处理；
• agent/pre-step、agent/request、agent/request-error、agent/turn-stopping 抛错：当前回合以 error 结束，并发 agent/error；
• agent/created 抛错：会话创建失败；
• 事件回调之外的定时器或异步任务，未捕获的异常会让整个 DSH 退出。

上线前，用 cordis_inspect_query（Service/Event）核对当前版本的签名。

> 核查说明：核实无误。补充两处：tools/change 不按作用域过滤；所有 context 的监听器在同一个数组里排序。

证据：dsh-src/@deepseek-ai/cordis/lib/index.js:219-221、258-263、289-296、317-325、336、372; dsh-src/@deepseek-ai/dsh-scope/README.zh.md:42、71-75；dsh-src/@deepseek-ai/dsh-scope/lib/index.js:327-338; dsh-src/@deepseek-ai/dsh-agent/lib/types/dispatch.js:31-73; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4460-4466（tools/change 不过滤）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1010-1027；dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:43；dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:3、16

## [confirmed] Q3-a agent/pre-step 钩子（限制步数）的签名与返回约定

签名：'agent/pre-step'(this: Scoped<Agent>, payload: { agent, messages: UserMessage[], turn, step, signal }, next): Promise<PreStepDecision>。
PreStepDecision = { kind:'reject' } | { kind:'enter', messages: UserMessage[], startsRequestSeries?: true }。

时机：
• 每一步（也就是每次模型请求）之前都跑一次。
• turn 是会话的累计轮次；step 每个回合从 1 开始。
• 跑钩子之前，循环已经从 inbox 领取（claim）了本步的消息：每一步领取全部 next-step 消息；第 1 步另外领取 1 条 next-turn 消息。
• 默认行为是 enter，messages = 领取的消息 + 运行时上下文。

reject 的效果：
• 本步不发模型请求，回合立即以 turn/end { reason:{kind:'blocked'} } 结束，驱动器转为空闲。
• 本步已领取的消息既不放回 inbox，也不写成 user/message，等于被吞掉。
• 队列里剩下的 next-turn 消息留在 inbox，等下一次唤醒再处理。
• 官方 ArchivedSessionGate 就是这样拦截已归档会话的。

限步数：
• 写法是 if (payload.step > N) return { kind:'reject' }。
• 这是硬截断：前面步骤的工具结果已经落盘，但模型不会再被请求做总结。
• 没有内置的步数预算。agent-loop README 建议从 agent/turn-stopping 这类既有扩展点执行取消，pre-step reject 也可以用。

替换消息：
• 写 const d = await next(); return { ...d, messages }。
• 消息必须是带 id 的 UserMessage，用 createUserMessage 构造。
• 这个钩子改不了请求本身。

已有的其他监听器包括 model-selection（agent 作用域，prepend）、dsh-tool-skill、plan-mode、goal-round-driver、time-context、compaction-basic、session-checkpoint-policy 等。外层 reject 不调 next() 时，它们在这一步都不会运行。

> 核查说明：核实无误。补充了 claim 的精确语义（每步领取全部 next-step 消息，第 1 步另领 1 条 next-turn），以及 reject 后驱动器转为空闲。调研员代码可用。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4004-4010、6423-6424、3980-3986; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:103-110（claim：全部 next-step + 1 条 next-turn）、902-924、955-964（reject→blocked 并 return false）、886-899（kick 结束→idle）; dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md:220；dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2508-2517; dsh-src/@deepseek-ai/dsh-agent/lib/types/model-selection.js:76-88；dsh-src/@deepseek-ai/dsh-tool-skill/lib/index.js:896-900

## [confirmed] Q3-b approval/request 钩子：能否用 prepend 注册后替机器人会话自动作答/拒绝审批

签名：'approval/request'(this: Scoped<Agent>, req: { agent, toolName, callId?, reason?, displayReason?, signal? }, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>。
ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'。

能自动作答，但要 prepend。原因如下：
• dsh-api-remotes 在插件 apply 时调用 typertGateway.registerRemoteEvents，网关立刻调用 source()，当场挂上转发监听器（没有 prepend）。中心插件一般在它之后加载，不 prepend 就排在里层。
• 转发器会把请求交给已连接的 owner 客户端并等待，自己不调 next()，只有客户端选择 delegate 时才调。
• 没有在线客户端时，请求挂在网关里，等有客户端连上再投递，期间不会自动 next()。
• 官方 dsh-acp 的应答者形状相同：不是自己的会话就 return next()，是自己的就返回 'allowed-once'、'rejected' 或 'cancelled'。

使用规则：
① 会话审批策略为 never 时，decide 直接返回 'rejected'，应答者看不到这次请求。
② 只能在打开的回合里请求；approval/asked 和 approval/decided 由服务自己写进会话，不管谁作答都会记。
③ 返回值不是那四个字符串之一，或监听器抛错，都按 'unavailable' 处理。
④ 请求不带工具参数：在 pre-execute 里缓存（键用 agent.id 加 callId），或者直接在 pre-execute 里 allow/deny。
⑤ 审批来源有三种：pre-execute 返回 ask；沙箱提权（bash、pwsh、fs、run_code 的 sandbox_permissions，reason 以 'escalate sandbox to <mode>: …' 开头）；plugin_manager（要求 danger-full-access）。
⑥ 委派出去的子代理审批策略固定为 never，它们的请求不会进来。
⑦ 没有超时，只和 signal 赛跑。

ask_user_question 也能用同样的套路接管：
• 'user-questions/request'(request: { questions, agent?, signal?, wait? }, next) 同样被 api-remotes 以 waterfall 方式转发。
• prepend 注册后返回 { answers: [{ id, selected: string[], custom?: string }] } 就能替机器人作答。
• 只接受根 agent；没有任何应答者时报 NO_PROVIDER。

```
// argsByCall / callKey 来自 Q2-c 的 tools/pre-execute 监听器（键 = agent.id + callId）
ctx.on('approval/request', async (req, next) => {
  if (!hub.isBotRoot(req.agent)) return next()                     // 普通会话交给桌面审批面板
  const cached = req.callId === undefined ? undefined : argsByCall.get(callKey(req.agent, req.callId))
  const verdict = hub.decideApproval({ sessionId: String(req.agent.id), toolName: req.toolName, reason: req.reason, args: cached?.args })
  if (verdict === 'allow') return 'allowed-once'
  if (verdict === 'deny') return 'rejected'
  return next()   // 转人工：没有在线桌面客户端时会一直挂着，直到用户打开 App 或回合被取消
}, { prepend: true })

ctx.on('user-questions/request', async (request, next) => {
  if (request.agent === undefined || !hub.isBotRoot(request.agent)) return next()
  return { answers: request.questions.map((q) => ({ id: q.id, selected: [], custom: 'No human is available right now. Make a reasonable assumption, state it, and continue.' })) }
}, { prepend: true })
```

> 核查说明：核实无误。原文说不 prepend『永远收不到』，严格说取决于注册顺序：转发器在 api-remotes apply 时就挂上，中心插件通常在它之后加载，所以实际几乎总在里层；结论『必须 prepend』成立。补充了无客户端时的挂起行为，以及缓存键改用 agent.id 加 callId。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4092-4097、4731-4732、4743-4744、4508-4514、4779-4780、4755-4760; dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:30-37、128-144、172-190; dsh-src/@deepseek-ai/dsh-api-remotes/lib/index.js:146-176（apply 即注册事件源；转发监听器未 prepend；无 carrier 才 next）、236-248; dsh-src/@deepseek-ai/dsh-api-gateway/lib/index.js:851-856（registerRemoteEvents 立刻调用 source()）、1014（新 owner 客户端连上时补投递挂起请求）、1062-1108（只投递给 answers 客户端，不自动 next）、1112-1124; dsh-src/@deepseek-ai/dsh-acp/lib/index.js:1158-1181；dsh-src/@deepseek-ai/dsh-sandbox/lib/index.js:99-123；dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js:76、94-97；dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:405-414; dsh-src/@deepseek-ai/dsh-user-questions/lib/index.js:668-691

## [confirmed] Q3-c agent/request 钩子（改路由）的签名与返回约定

签名：'agent/request'(this: Scoped<Agent>, payload: { agent, turn, step, signal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>。
LlmCallConfig = { provider, model, reasoningEffort?, temperature?, maxTokens?, stop?: string[] }。

时机与约定：
• 每次模型请求尝试都跑一次，同一步的重试也算。时机在 step/start 之后、提交 system 消息和 user 消息之前。
• await next() 拿到循环本来要用的配置：本次 loop 实例的第一次请求是 agentOptions（同路由时沿用日志里的推理强度），之后是日志里最近的请求头。
• 返回值必须同时有 provider 和 model，否则抛 'has no provider/model'。
• 随后 ctx.llm.prepareCall 会校验。provider 没注册时，prepareCall 报的 NO_ADAPTER 会被循环吞掉，回退为原配置；真正的失败随后以终止 finish（code NO_ADAPTER）的形式进入 agent/request-error，回合以 error 结束。
• 这个钩子改不了消息。

关键坑：
• 会话控制器在 setup 阶段（发布之前）为每个经它创建或恢复的会话，在 agent.ctx 上装了 model-selection。它的 agent/request 监听器没有 prepend，会在 await next() 之后把 provider/model 改成会话当前的选择，并去掉继承来的 reasoningEffort。
• 中心的监听器要用 { prepend: true } 注册在宿主 ctx 上，并在 await next() 之后再覆盖。所有监听器共用一个数组：中心如果在 agent 创建之前注册，本来就排在外层；但热重载后，或晚于 agent 加载时，就会排到里层。prepend 让结果不依赖加载顺序。
• 换模型时去掉继承来的 reasoningEffort。
• 可以顺手加 maxTokens。
• 生效后请求头会记成新模型，后续步骤保持一致。
• 不要用 session.selectModel 给机器人换模型，它会把选择存成全局默认。

> 核查说明：核实无误。补充了 NO_ADAPTER 的实际走向（先被吞掉、再经 request-error 结束回合），并说清了排序原因。调研员代码可用。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4012-4018、5843-5852; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1174-1210（1195 缺 provider/model 抛错；1204 只吞 NO_ADAPTER 并回退）; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:2386-2413（adapter 选择/分发/迭代失败转成终止 finish）; dsh-src/@deepseek-ai/dsh-agent/lib/types/model-selection.js:45-94；dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:274-306、350-362; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:808-811（selectModel 调 agentDefaultModel.saveSelection）

## [confirmed] Q3-d agent/request-error 钩子（识别 429/额度错误）的签名与返回约定

签名：'agent/request-error'(this: Scoped<Agent>, payload: { agent, turn, step, provider, failure: LlmFailure, retryPolicy: ResolvedRetryPolicy | undefined, signal }, next): Promise<RequestErrorAction>。
LlmFailure = { message, code, status?, providerRetryAfterMs?, requestId?, offloadImages? }。
RequestErrorAction = { kind:'retry' } | undefined。

时机：
• 一次请求以 finish.kind 为 error 或 aborted 结束时，先把 assistant/attempt 写进日志，再跑这个瀑布。
• adapter 选择、分发和流迭代的失败都被 llm 服务转成终止 finish，所以都会进这个钩子。
• middleware、嵌套调用、cleanup 和消费方的异常直接抛出，结束回合，不进这个钩子。

返回值：
• { kind:'retry' }：立即在同一步重新请求，没有延时；要延时，监听器自己 await。
• undefined（默认）：抛 LlmError，回合以 turn/end { kind:'error', error: failure } 结束，并发 agent/error。goal-round-driver 收到 agent/error 会解除自动续行。

已有的监听器：
• dsh-llm-retry：宿主层注册，没有 prepend。
  – normal 模式只对 retryableCodes 重试，默认是 EMPTY_RESPONSE、RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT；最多 5 次，延时从 500ms 指数增长到 10s，抖动 0.1；每次写 llm/retry 和 llm/retry-started。
  – providerRetryAfterMs 超过 maxDelayMs 时直接交给 next()。
  – always 模式无限重试，连 QUOTA 也重试。
• dsh-compaction-basic：处理 CONTEXT_WINDOW_EXCEEDED。
• dsh-compaction-image-offload：处理 IMAGE_OFFLOAD_REQUIRED。

识别 429 和额度错误：
• QUOTA 的判定靠 isQuotaExceededError，只认英文措辞。
• pi-ai（GLM 走这条路由）的失败只有 message 和 code，分类顺序是：含 401/403 → AUTH；英文额度措辞 → QUOTA；含 429 或 rate limit → RATE_LIMIT。
• 推断：GLM 的中文额度报错大概率被归成 RATE_LIMIT，会被白白重试 5 次。

中心的做法：
• 用 { prepend: true } 注册，抢在 llm-retry 之前。
• 判定为额度错误：记账、暂停该机器人，return undefined。
• 其余一律 return next()。

> 核查说明：核实无误。补充了哪些失败会进钩子、哪些直接抛出，以及 providerRetryAfterMs 过大时的行为。调研员代码可用。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4020-4026、5863-5864、6703-6704; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1094（未开始流的异常直接抛）、1127-1146（先写 attempt 再派发；非 retry 抛 LlmError；retry 立即 continue）；dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md:128; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:2386-2413（adapterFailureChunk）; dsh-src/@deepseek-ai/dsh-llm-retry/lib/index.js:141-180；dsh-src/@deepseek-ai/dsh-llm/lib/types/retry-policy.js:12-22；dsh-src/@deepseek-ai/dsh-llm/lib/types/error.js:21-26、76-82; dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1448-1459、1513-1521；dsh-src/@deepseek-ai/dsh-compaction-basic/lib/index.js:861-868；dsh-src/@deepseek-ai/dsh-compaction-image-offload/lib/index.js:141-145；dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:211-213

## [confirmed] Q4-a 有没有事件或字段能拿到每次请求的 token 用量（用于按机器人记账）

有，而且都是持久事件。

• assistant/message：每次请求成功后写入。data = { turn, step, message: { id, role:'assistant', source:{ kind:'model', provider, model, replayState? }, content }, usage?: TokenUsage, interrupted?: true, stream }。被中断的那次也会带 usage。
• assistant/attempt：失败的尝试写入，data = { turn, step, stream }。用量（如果供应商报了）在 stream 里最后一条 { type:'chunk', chunk:{ type:'usage', usage } } 中。
• 官方 token-meter 的口径：assistant/message 没有 usage 字段时，也退回到 stream 里的 usage chunk。
• TokenUsage = { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }。inputTokens 记为未命中缓存的输入；pi-ai 只在 cache 字段非 0 时才写出它们，也不报 reasoningTokens。
• compaction/summary 的 data 带 provider、model、usage?，但没有 turn 和 step。

取法：
• 宿主插件用 ctx.on('session/event', (session, event) => …)，能收到所有会话（含子代理会话）每条已提交的事件。
• 按 event.type 过滤；子代理会话用 header.origin==='subagent' 加 parentSession 归到机器人。
• 实时显示可以用 agent/assistant-stream，它只是进程内的帧，不持久。

注意：
• session/event 只在实时追加时触发，重启后不会重放，账本要自己持久化。
• 回调在 append 发布过程中同步执行。里面对同一会话 append（包括 inject、followup、steer）会抛 'session append cannot reenter…'，要用 queueMicrotask 或 setImmediate 延后。对别的会话 append 不受影响。
• 监听器的异常会被兜住。

```
// 与官方 token-meter 同口径地取一次用量；compaction/summary 没有 turn/step
function usageOf(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') return lastUsageChunk(event.data.stream)
  if (event.type === 'compaction/summary') return event.data.usage
  return undefined
}
function lastUsageChunk(stream) {
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i]
    if (record.type === 'chunk' && record.chunk.type === 'usage') return record.chunk.usage
  }
  return undefined
}
```

> 核查说明：核实无误。补充两点：assistant/message 缺 usage 时要退回 stream 里的 usage chunk；compaction/summary 没有 turn 和 step。调研员的记账代码要相应替换 usage 的取法。

证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1098-1135、1156-1163; dsh-src/@deepseek-ai/dsh-token-meter/lib/index.js:326-331、367-372（usageOf：message 无 usage 时退回 stream usage chunk）、393-428; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:8123-8124、4380-4385; dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1439-1447; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1567-1597（per-session appending 标记；重入抛错；观察者异常兜住）、1231-1240; dsh-src/@deepseek-ai/dsh-compaction-basic/lib/index.js:629-648

## [corrected] Q4-b 按会话/按轮/按机器人聚合的现成接口与计量盲区

• 会话累计（和官方用量面板口径一致）：ctx.sessionProjections.stateOf(session, 'tokenUsage') 返回 { totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, last }，需要 inject 'sessionProjections'。
• 冷会话：用 ctx.sessionController.projections(request: { sessionId }, signal: AbortSignal)，它是 @Remote 方法。返回值有三种：{ kind:'sequenced', …基线 }、{ kind:'migration-required', values }、null。
• 官方口径只折叠 assistant/message 和 assistant/attempt：同一 (turn, step) 后到的样本替换前一个，只有出现 llm/retry-started 后才累加。所以中心自己返回 retry 时（不写 llm/retry-started），官方 tokenUsage 会少算；逐条累加的账本更接近真实计费。
• 按轮：@deepseek-ai/dsh-token-meter/client 导出 deriveTurnTokenUsage(events)，传入 turn/start 到 turn/end 的事件。linked 插件要把 @deepseek-ai/dsh-token-meter 列成 peer。
• 节奏和耗时：web/桌面档还有 sessionStats 投影，字段是 turns、steps、llmMs、toolMs、ttftMs、ttftSteps、decodeMs、decodeTokens。
• 按机器人：顶层会话加上所有 origin==='subagent' 且 parentSession 指向它的子会话。

盲区：
• web_search 背后的 DeepSeek 调用只记一条 'web/deepseek-search-llm-request'，没有 usage；
• 标题生成、Auto review 直接调用 llm，不进 tokenUsage；
• 上下文压缩的用量在 compaction/summary 里；
• harness 不读价格，没有金额；
• web_search 次数用 tools/result 计数。

> 核查说明：原说法『projections({ sessionId })，返回 sequenced 基线或 null』不全：方法还要第二个参数 AbortSignal，返回值还有 { kind:'migration-required', values } 一种，依据是 catalog 2115-2119 和 SessionProjectionsValue。其余核实无误。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:2115-2119（projections(request, signal)）；SessionProjectionsRequest / SessionProjectionsValue 声明（sequenced | migration-required | null）; dsh-src/@deepseek-ai/dsh-token-meter/lib/index.js:393-428、694-696；dsh-src/@deepseek-ai/dsh-token-meter/package.json exports './client' → lib/types/client.js（导出 deriveTurnTokenUsage）；lib/types/turn-usage.js:106-115; dsh-src/@deepseek-ai/dsh-session-stats/lib/index.js:28-37；dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:102-103; dsh-src/@deepseek-ai/dsh-llm-retry/lib/index.js:141-147；dsh-src/@deepseek-ai/dsh-web-search-deepseek/lib/index.js:324-326；dsh-src/@deepseek-ai/dsh-experimental-auto-review/lib/index.js:400-414（直接 ctx.llm.stream）

## [confirmed] Q5-a standard preset 里内置工具的准确名字清单及来源包

standard 定义在 dsh-web-app/presets/standard.patch.yml，以 macOS 为准：
• dsh-tool-bash → bash（Windows 上换成 dsh-tool-pwsh → pwsh）
• dsh-tool-fs → read、write、edit、read_image（read_image 需要 attachments 服务）
• dsh-tool-fs-search → glob、grep
• dsh-tool-jobs → job_output、job_list、job_kill
• dsh-tool-schedule → schedule_create、schedule_list、schedule_update、schedule_delete（拒绝委派出去的子代理调用）
• dsh-tool-skill → skill
• dsh-tool-goal → get_goal、create_goal、update_goal（要求 live 根 agent 的当前驱动；create 类操作要求本回合有 source.kind==='user' 的人类消息）
• dsh-plan-mode（planning 组）→ exit_plan_mode，始终在工具目录里
• delegation 组：
  – dsh-tool-subagent-control → send_message、interrupt_agent
  – dsh-tool-subagent-control/list-agents → list_agents
  – dsh-tool-subagent → subagent、subagent_fork（名字由 config.toolName 决定）；开启子代理模型选择时另有 list_subagent_models
  – dsh-tool-workflow → workflow
• dsh-tool-ask-user → ask_user_question（standard 没给 config，是 legacy 模式，会无限等待）
• dsh-tool-todo → todo_write
• dsh-tool-web → web_search、web_fetch
• dsh-tool-present → present
• dsh-plugin-manager/tools → plugin_manager，dsh-plugin-market/tools → plugin_market，两者都 disabled。
不注册工具的行：persona、agent-instructions、time-context、skill-filesystem、command-goal、compaction 组。

> 核查说明：逐个工具名核对无误。

证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:4-128; 各工具名行已逐一核对：dsh-tool-bash:492、dsh-tool-pwsh:465、dsh-tool-fs:250/548/689/985、dsh-tool-fs-search:781/1089、dsh-tool-jobs:297/347/367、dsh-tool-schedule:507/547/569/603、dsh-tool-skill:787、dsh-tool-goal:264/275/301、dsh-plan-mode:230、dsh-tool-subagent-control:22/61、list-agents.js:45、dsh-tool-workflow:270、dsh-tool-ask-user:66/224、dsh-tool-todo:95、dsh-tool-web:261/736、dsh-tool-present:24、plugin-manager tools.js:75、plugin-market tools.js:54（均为 lib/index.js 或所列文件行号）; dsh-src/@deepseek-ai/dsh-tool-ask-user/lib/index.js:211-224；dsh-src/@deepseek-ai/dsh-tool-subagent/lib/index.js:168-176、359-376；dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:293-303；dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:25-80

## [confirmed] Q5-b standard 之外：宿主层全局工具、条件出现的工具、其他 preset 的差异

宿主层（全局）工具，所有 preset 都继承：
• working_directory（dsh-base 的 tool-working-directory 行）；
• list_mcp_resources、list_mcp_resource_templates、read_mcp_resource：只在调用方作用域里注册了 MCP 资源提供方时才出现；
• 用户加了 dsh-mcp-client 行时，还有 mcp__<server>__<tool>。名字超过 64 字符或含 [A-Za-z0-9_-] 以外的字符时，会被替换并追加 12 位哈希。

桌面 web 档禁用的宿主层行：tool-plugin-manager、tool-bash、tool-pwsh、tool-jobs、tool-fs、tool-fs-search、skill-filesystem、tool-skill、command-goal、tool-goal、plan-mode、compaction-basic、command-compact、tool-result-pruner、tool-subagent-control、tool-subagent-list-agents、tool-subagent、tool-subagent-fork、workflow-ptc、tool-workflow、agent-instructions、tool-todo、tool-web。这些都改由 preset 挂载，属于 preset 作用域，可以在 agent.ctx 上用 restrict 屏蔽。

其他 preset：
• ptc：模型能直接调用的只有 run_code；
• cordis：额外有 cordis_inspect_list、cordis_inspect_query；有 profileContext 时还有 plugin_manager、plugin_market；
• minimal：只有 read_image、持久终端版 bash、/compact 命令，外加宿主层工具。

核对办法：ctx.tools.schemas(agent).map((s) => s.name) 列出该 agent 可见的定义。PTC agent 的模型实际只拿到 run_code 的 schema（wireSchemas 会过滤），其他名字是 SDK 绑定。

> 核查说明：核实无误。补充了完整的禁用清单，以及 PTC 模式下 schemas() 与模型实际所见的差别。

证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:169-170、408-409、492-493; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:482-585（完整禁用清单）、160-164（dsh-tool-cordis/host 只注册 inspect provider，不注册工具）; dsh-src/@deepseek-ai/dsh-tool-working-directory/lib/index.js:16-17；dsh-src/@deepseek-ai/dsh-mcp-resources/lib/index.js:53-81、130-170；dsh-src/@deepseek-ai/dsh-mcp-client/lib/index.js:83-101; dsh-src/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml:124-134；dsh-src/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml:120-136；dsh-src/@deepseek-ai/dsh-web-app/presets/minimal.patch.yml:11-78; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2932-2944（wireSchemas：PTC 只给 run_code）、3121-3123（schemas）

## [corrected] 补充 S1：agent/turn-stopping 钩子（让机器人收尾前必须汇报、或给失控回合兜底）

签名：'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent, turn, signal }): Promise<void> | void，mode 为 serial。

时机：模型这一轮已经不欠回复（没有在跑的工具调用，也没有新的 steer），回合即将关闭之前。

用法：
• 监听器调用 agent.steer(createUserMessage(...))，循环会在提交边界之前重读 next-step inbox；非空就再跑一步，空就关闭回合。
• 由数据决定结果，监听器顺序不影响。
• 反方向（让工具循环提前停下）靠工具结果的 concludesTurn；但它不会短路已经提交的 next-step 工作。

用途：
• 机器人这一回合还没调用 hub_report 时，催一次。要设次数上限，防止死循环。
• agent-loop README 也建议从这里实施限制失控回合的策略，比如执行取消。

规则：
• serial 事件，监听器返回真值会截断后续监听器，写成块体、不返回值；
• 抛错会让回合以 error 结束；
• 宿主 ctx 上注册收全部 agent 的事件，agent.ctx 上的只收该 agent。

```
import { createUserMessage } from '@deepseek-ai/dsh-llm'   // linked 插件需在 package.json peerDependencies 列出

ctx.on('agent/turn-stopping', ({ agent, turn }) => {
  // serial 事件：写成块体、不返回值（返回真值会截断后面的监听器）
  if (!hub.isBotRoot(agent)) return
  const id = String(agent.id)
  if (hub.reportedInTurn(id, turn) || hub.nudgedInTurn(id, turn)) return   // 每回合最多催一次，防死循环
  hub.markNudged(id, turn)
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: 'Before you stop, call hub_report exactly once.' }],
    source: { kind: 'agent-hub' },
  }))   // 循环随后重读 next-step inbox，非空就再跑一步
})
```

> 核查说明：补充。调研员没有写到这个钩子，它是官方推荐的回合收尾、兜底扩展点，可以实现『汇报后才允许收口』。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4036-4041; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:996-1008（仅当 turnEnds 且 nextStep 为空才 serial 派发；之后再判 nextStep 决定 break 还是继续）、806-814（steer = next-step + 唤醒；运行中只入队）; dsh-src/@deepseek-ai/dsh-agent/README.zh.md:67；dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md:220

## [corrected] 补充 S2：中心构造的 UserMessage（followup/steer/inject/pre-step 替换）有哪些硬约束

• MessageBase = { id, content, source }，三项都必填。用 createUserMessage({ content, source }) 构造，它负责生成 id 并冻结消息，但不会补 source。
• source.kind 必须是非空字符串，而且不能是 'plugin'。v4 会话格式在恢复（重新打开）时校验这一点，写了 'plugin' 的会话会打不开。其他未知的 kind 会被原样保留，比如 { kind:'agent-hub' }；官方 README 的示例也用 { kind:'my-plugin' }。
• 不要用 'user'：goal 工具把本回合里 source.kind==='user' 的 user/message 当作人类授权，会解锁 create_goal 等操作；dsh-tool-jobs 也在收到 'user' 消息时重置唤醒预算。
• 更正调研员的说法：本版 dsh-agent 和 agent-loop 里没有给缺省 source 补 'user' 的代码。goal 那段注释只是提醒非人类生产者必须自带 source；实际上 source 是必填的。
• 三种投递方式：followup 进 next-turn 队列并唤醒；steer 进 next-step 队列并唤醒；inject 进 next-step 队列但不唤醒。
• 不要在 session/event 回调里对同一会话同步投递，会因重入而抛错，用 queueMicrotask 延后。

```
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const wake = createUserMessage({
  content: [{ type: 'text', text: 'Scheduled wake-up: review your goal and decide what to do next.' }],
  source: { kind: 'agent-hub' },   // 必填；非空；不能是 'plugin'（会话会打不开）；不要用 'user'（会被当成人类授权）
})
agent.followup(wake)              // next-turn + 唤醒
// agent.steer(wake)             // next-step + 唤醒
// agent.inject(wake)            // next-step，不唤醒
// 在 session/event 回调里：queueMicrotask(() => agent.followup(wake))
```

> 核查说明：补充，并更正调研员 gotcha 里『缺省来源会被当成 user』的说法：本版代码里 source 是必填的，没有补缺省值的逻辑。新增了『kind 不能是 plugin』这条硬约束。

证据：dsh-src/@deepseek-ai/dsh-llm/lib/typert.host.js:460（MessageBase 声明）、472-476（MessageSource / MessageSourceMap）; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:37-42、59-64（createMessage/createUserMessage 只补 id 与 role）; dsh-src/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:123-127（Native source admission：kind 非空且不是 'plugin'）；dsh-src/@deepseek-ai/dsh-session-format-v3-to-v4/README.zh.md:120、134、223（未知归属保留）; dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:44-53（hasDirectHumanInput 只认 source.kind==='user'）；dsh-src/@deepseek-ai/dsh-tool-jobs/lib/index.js:231-233; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:800-814（followup/steer/inject 不补 source）；dsh-src/@deepseek-ai/dsh-agent/README.zh.md:47-57

## 坑

- 模块解析（link 安装）：import @deepseek-ai/* 时，插件自己的 package.json 必须在 peerDependencies 里列出该包。routeLinked 逐级向上查找，同一级上 peer 声明优先于本地 node_modules 副本；三者都没有命中就报 ERR_MODULE_NOT_FOUND。绝不要写进 dependencies。版本闸门写在顶层 engines.dsh，写在 dsh.engines 下无效（dsh-net-tuning 就写错了位置）。
- defineTool 的 DSL 按类型限制可用的键：标量只能带 enum 或 const；array 只能带 items；object 必须显式写 additionalProperties，可以带 properties；oneOf 至少两支，且不能和 type 并存。required 只能写 true，而且只能写在对象属性条目上。顶层参数对象不封闭，多余参数也能通过校验。output 必填，execute 不能返回 undefined。
- 原始 ctx.tools.register 不校验 parameters，也不校验入参。args 可能是原始字符串（坏 JSON）、{}（空参数）或任意 JSON 值。
- 命名：统一加 hub_ 前缀。全局层重名会抛错；preset 层的同名工具会遮蔽宿主层注册的工具，导致 preset 会话看不见它；run_code 是保留名；名字按 DeepSeek 函数名约束，64 字符以内，只用 [A-Za-z0-9_-]。
- KV cache：注册、撤销、restrict 或 description 一变，就会写 tool-addition 或 tool-removal 开发者消息，前缀缓存随之失效。按 agent 安装的工具在 agent/created 时一次性装好，description 里不放动态内容。
- serial 事件（agent/created、agent/turn-stopping）：返回 null、false、undefined 以外的值都会截断后续监听器，要写成块体。agent/created 里抛错会让会话创建失败，必须 try/catch；catalog 明说不能 await agent.whenIdle() 或等待自己 owner 的销毁。
- agent/created 的来源本版只有 'startup' 和 'resume'；'clear' 和 'compact' 是保留值，没有代码发出。
- agent.ctx 上的注册有两个 owner：插件卸载不会自动撤销，要自己保存 disposer，在 agent/disposed 和插件 effect 里撤销；插件加载时还要遍历 ctx.agents.list() 补装。agent/disposed 发出时，作用域注册已经撤销过，再调用一次 disposer 是安全的空操作。
- 子代理的作用域父链是 preset 代际，不是父 agent：装在机器人 agent.ctx 上的工具、restrict、guard、监听器都管不到它的子代理。要管子代理，用全局监听器，再按 origin==='subagent' 加 parentSession 归属到机器人。
- restrict 只能在作用域 ctx 上调用；点名的工具必须在『限制前』的继承集合里；{} 会抛错；{ allow: [] } 不会报错，但会隐藏全部继承工具；不能点名 run_code；本作用域自己注册的工具不受影响。
- guard 只能是同步函数。只有返回 undefined 才算『不管』，返回 null、false、'' 都算拒绝。拒绝不可推翻，人工批准过的调用也照样被拒。
- tools/pre-execute 的决策对象要写严格：{ kind:'deny' } 必须带字符串 reason，漏写 reason 或返回未知 kind 都会被当成放行，而且跳过 guard；忘了 return 会让这次调用报错；监听器抛错会跳过 post-execute。exec.arguments 是深冻结的，不能改写。未注册的工具名也会进这个钩子。
- callId 由模型或供应商生成，不保证跨会话唯一。按 callId 缓存参数或审批状态时，键要用 `${agent.id}:${callId}`。
- 执行顺序：所有 context 的监听器在同一个数组里，普通注册按注册时间排、外层先跑，prepend 插到最前。approval/request 和 user-questions/request 要 prepend，因为桌面转发器在 api-remotes apply 时就挂上，而且不调 next。agent/request 要 prepend，并在 await next() 之后覆盖，否则会被 model-selection 改回去。agent/request-error 要 prepend，才能赶在 llm-retry 之前；不处理的错误码一定要 return next()。
- approval/request：会话策略为 never 时不进瀑布；请求本身不带参数；返回值只能是四个字符串之一。转人工后没有超时，没有在线桌面客户端时会一直挂着，直到有客户端连上或回合被取消。不要先 next() 再自己超时抢答（推断：UI 端的待批会残留）。
- agent/pre-step 返回 reject 时：本步已领取的消息（全部 next-step 消息，第 1 步另加 1 条 next-turn 消息）被吞掉，回合以 blocked 结束，驱动器转为空闲。用它做暂停时，中心要自己保存待投递的唤醒内容。
- concludeTurn 不保证收口：失败结果、post-execute 返回 block 都不收口；同一步里有 deferContext、additionalContexts 或期间到达的 steer、inject 时，还会再请求一次模型；同一条 assistant 消息里的其他工具调用照常执行。
- 想让机器人『汇报完才允许收尾』，在 agent/turn-stopping 里 steer 一条提醒，并设次数上限。
- session/event 只在实时追加时触发，重启后不重放，账本要自己持久化。回调在同一会话 append 的发布过程中同步执行，不能对同一会话 append、inject、followup、steer，要用 queueMicrotask 延后。
- 用量盲区：tokenUsage 不含 web_search 背后的模型调用、标题生成、Auto review，以及上下文压缩（压缩的 usage 在 compaction/summary 里，且没有 turn/step）。子代理用量在子会话里。没有金额。中心自己返回 retry 时，官方口径会少算。
- 消息构造：UserMessage 的 id、content、source 都必填，用 createUserMessage({ content, source }) 构造。source.kind 必须非空且不能是 'plugin'，否则会话打不开；也不要用 'user'，它会被 goal 工具当作人类授权，并重置 tool-jobs 的唤醒预算。本版代码不会给缺省 source 补 'user'。
- sessionController.create({ sessionId }) 是『复用指定的空白会话』：id 不存在才按该 id 新建；id 已有 turn/start 或不属于指定 workspace，就另铸 session-<uuid>。一律以返回的 sessionId 为准。判定 preset 用 ctx.agentPresets.composedPreset(agent.ctx)，不要用 header.agentPreset。
- 机器人不该等人：standard 的 ask_user_question 是 legacy 模式，会无限等待；exit_plan_mode 始终在工具目录里。给机器人 restrict 掉，或者 prepend 一个 user-questions/request 应答者。
- presentCall 和 presentResult 在桌面内置 Web Client 里不生效。要定制卡片，用 output.presentationMeta 写持久化的 meta，由客户端的 tool.call.toolview 渲染器派生。
- preset 不是安全沙箱。自定义 preset 必须写全插件行，不会跟随 standard 升级；复制时保留 cordis:group 和 isolate 结构；preset 内的插件不能对外提供 Service。
- 宿主插件里，事件回调之外的定时器或异步任务出现未捕获异常，会让整个 DSH 退出。共享定时器建议在 ctx.agents.withoutInitiator(...) 里创建，免得继承第一个触发它的机器人的 initiator，导致 currentInitiator() 归错属。
- 开发迭代：官方文档说替换已安装包的 JS 代码需要重启，才能加载新一代模块（host-plugin.md:70）。推断：改 hub 的代码后要重启 DSH，只有 patch 或配置的改动才适合靠 HMR。
- 用户样板：dsh-auto-upgrade 的包名用了 @deepseek-ai/ 前缀，也没有 dsh.bundle.patch，不能照抄；两个样板都没有注册工具或钩子。
- 版本：所有签名随 0.2.1-rc.5 发布，走 nightly 通道，升级后可能变化。上线前在创造模式里用 cordis_inspect_query（Service/Event/Tool）核对一次。

## 未决

- link 安装的插件 import @deepseek-ai/dsh-tools 时走 peerDependencies 路由，这是读 dsh-app-boot 的 routeLinked 推出来的，还没在真机上验证。另外，用户现有 profile 的 pnpm-workspace.yaml 是否带 autoInstallPeers:false，在不读 ~/.dsh 的前提下无法确认：模板只在初始化 profile 时写入。
- GLM（智谱，经 pi-ai 路由）在额度耗尽、5 小时上限、限流时的真实报错文本未知，也不知道是否含 429。需要抓一次真实报错，才能定额度识别的关键词。
- ctx.agentPresets.register(PresetDefinition) 能否由宿主插件在运行时注册机器人专用 preset，以及重启后会话恢复和插件注册谁先谁后，都需要实测。
- 自定义 preset 行引用 'dsh-agent-hub/bot-tools' 这类第三方子路径插件时，在 preset 的内存 Loader 树里能否按 link 目录正确解析，未验证。
- 中心在 approval/request 里先 next() 转给 UI、再自己超时返回时，桌面客户端那条待批会不会残留。代码上，网关的挂起请求只在 signal 中止或 agent.ctx 释放时才清除，UI 端的表现未实测。
- sessionController.create({ sessionId }) 的部分已核实：会话 id 落盘时会编码成安全的路径段，没看到格式限制；不存在的 id 会原样使用。仍待实测：桌面组合下 session-query（openAt: never）对一个新 id 的 observeSession 是否稳定返回 SESSION_QUERY_SESSION_NOT_FOUND。
- 中心自己在 request-error 里返回 { kind:'retry' } 时，官方 tokenUsage 会少算。要不要同时写一条 llm/retry-started（那是 llm-retry 的事件类型），需要权衡，未验证。
- 走 pi-ai 的 GLM 路由对工具名的字符集和长度的实际限制未核对；生成的 tool call id 会不会在不同会话之间重复，也未核对。缓存键建议总是带上 agent.id。
- 修改 linked 插件代码后，热重载能否加载新模块，还是必须重启 DSH（host-plugin.md:70 说替换已安装包需要重启），需要真机确认。
