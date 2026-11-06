# T2-sessions-models

## [confirmed] Q1 ctx.sessionController 的完整方法、参数与返回（宿主插件直连）

核对无误。服务名 sessionController（TypertRemoteService，构造里 super(ctx,'sessionController',{namespace:'session'})）。@Remote 只经 addMarkerInitializer 在原型上打标记、不替换方法；TypertRemoteService 构造里也只做 bindTypertRemote，所以宿主内直连不经 Gateway、不做 schema 校验：多余字段直接丢弃，mode 只要不是 'steer' 就走 agent.followup（等于 queue）。
方法 → 返回：create(req) → Promise<{sessionId, agentPreset?}>，不收 signal；prompt(req, signal) → Promise<{accepted:true}>，首行就是 signal.throwIfAborted()，所以 signal 必传；resolveAgent(id) → Promise<{agent}|{error}>，不抛错；cancel({sessionId}) → {accepted:true}；projections({sessionId}, signal) → null | {kind:'sequenced', asOfSeq, values} | {kind:'migration-required', values}，signal 必传，sessionId 为空串报 gateway/bad-request；selectModel(req) → Promise<{selected}>；rename(req) → Promise<{title, seq}>，要有 sessionTitle 服务，否则报 gateway/internal；list(_req, signal?) → Promise<{items}>；modelCatalog()；fork；updateQueue；search；control(signal) 是 async generator；inspect(id, signal?) → {meta, inheritedEventCount, events}。
prompt 的内部顺序：resolveAgent → hasPromptRequest（查 inbox 两条队列，再查本会话内存日志里有没有 source.kind==='user' 且 rpcId===requestId 的消息）→ createUserMessage({content: admitPromptContent(...), source:{kind:'user', rpcId, clientTimeZone?, principal?}}) → mode==='steer' ? agent.steer : agent.followup。

```
// export const inject = ['sessionController']
const sc = ctx.sessionController
const sig = () => AbortSignal.timeout(30_000)
const { sessionId } = await sc.create({ workspaceId, agentPreset: 'standard' })
await sc.prompt({ sessionId, requestId: 'agent-hub:bot1:task-42', mode: 'queue', content: [{ type: 'text', text: '…' }] }, sig()) // signal 必传
const found = await sc.resolveAgent(sessionId) // { agent } | { error }，不抛
try { sc.cancel({ sessionId }) } catch (e) { /* 同步抛出：session/not-found（不在线）或 session/agent-busy（子代理会话） */ }
const p = await sc.projections({ sessionId }, sig()) // signal 必传
```

> 核查说明：补充三点，结论不变：①cancel 是同步方法（不是 async）。会话不在线时它同步 throw RemoteError('session/not-found')，不是返回 rejected Promise，所以要用 try/catch，不能只写 .catch()；②prompt 内部凡不是 RemoteError/AttachmentError 的异常（比如 followup 因消息不合法抛错），都会被包成 session/agent-busy『prompt rejected』，真正原因在 error.data.reason；③还有一个与中心无关的 Remote 方法 initializeDefaultModel()。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2673-2700（@Remote 清单，含 initializeDefaultModel）、:2952（super(ctx,'sessionController',{namespace:'session'})）; dsh-src/@deepseek-ai/dsh-typert-protocol/lib/index.js:339-352（TypertRemoteService 只 bind）、:363-372 与 :400-404（remoteDecorator 返回 undefined，不替换方法）、:440-448（addMarkerInitializer 只打标记）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3037-3039（resolveAgent）、:210-246（resolve 返回 {agent}|{error}）、:3218-3232（prompt：throwIfAborted、source.kind user + rpcId）、:925-964（commands.prompt：幂等检查、steer/followup，:957-961 非 RemoteError 包成 session/agent-busy）、:1061-1067（cancel 同步实现）、:3253-3255（cancel 外层未加 async）、:3281-3331（projections）、:3061-3066（list）、:793-823（selectModel）、:827-842（rename 需 sessionTitle）、:1128-1139（hasPromptRequest）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:227-237（create 参数与结果）、:519-535（list 行）、:791-958（projections 结果，含 kind 'sequenced'/'migration-required'）、:1125-1147（prompt 参数）、:1148-1157（rename）、:1170-1184（selectModel，provider 为 z.string() 必填）; /Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js:40-73（宿主内直连 sessionController 的可工作样例）

## [corrected] Q1 create 能否指定 cwd/标题/agentPreset/权限档/模型；建机器人会话的正确配方

create 只认四个字段：workspaceId 和 cwd 二选一、agentPreset、sessionId。具体规则：
- cwd 不存在会被 mkdir -p。
- 用 workspaceId 时，cwd 取 workspace.path（规范路径），建完自动 attachSession。
- agentPreset 桌面默认 standard，另有 minimal、cordis、ptc；ctx.agentPresets.list() → [{id, name?, description?, order?, broken?}]。
- sessionId 的复用条件（commands.create 的 reusable + claim）：该 id 下没有存储 → 用它新建；有存储，且同目录、仍空白（没有 turn/start）、未归档、属于指定工作区、没被别人持写锁 → 原地复用；目录不同 → 报 session/conflict；其余情况一律静默新建 session-<uuid>。
- 标题、权限档、模型都不能经 create 指定，传了会被静默丢弃。
标题：rename 写一条 session/title {source:{kind:'user'}}，从此钉住，后续不再自动改标题。
权限：新会话在 session/created 时由 pinInitialPermission 写入 defaultPreset。首轮前用 ctx.permissionPresets.set(session, name)，只追加 permission/preset、sandbox/mode、approval/policy 这类事件，不 inject 消息；会话已在跑时用 /permission，它走 approval.setPolicy，审批策略真的变了才 inject 一条 source.kind 'user-approval' 的通知。可用档：read-only、workspace-write、danger-full-access；auto 只在实验性 auto-review 注册时出现。
模型（更正点）：新会话的生效模型不是『创建时的全局默认』，而是 selection.current = picked（selectModel 留下的待用选择）?? 日志里最近一条 request/header ?? agentDefaultModel.currentSelection()。最后一项是每次组装时实时读取的。
配方顺序经核实可用：mkdir → workspaceRegistry.create → sessionController.create({workspaceId}) → rename → resolveAgent → permissionPresets.set → selectModel 后立刻还原全局默认 → sessions.flush → 写入注册表 → 第一次唤醒。

```
import { mkdir } from 'node:fs/promises'
// export const inject = ['sessionController', 'sessions', 'workspaceRegistry', 'permissionPresets', 'agentDefaultModel']
export async function createBotSession(ctx, bot) {
  await mkdir(bot.cwd, { recursive: true })                       // workspaceRegistry.create 要求目录已存在、绝对路径
  const ws = await ctx.workspaceRegistry.create(bot.cwd, bot.name)
  const { sessionId } = await ctx.sessionController.create({ workspaceId: ws.id, agentPreset: bot.preset })
  await ctx.sessionController.rename({ sessionId, title: bot.name })
  const found = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in found) throw found.error
  ctx.permissionPresets.set(found.agent.session, bot.permission)     // 名字不对会 throw
  // 必须 selectModel：否则首个请求会用『那一刻』的全局默认
  const prev = ctx.agentDefaultModel.currentSelection()
  await ctx.sessionController.selectModel({ sessionId, provider: bot.provider, model: bot.model,
    ...(bot.reasoningEffort === undefined ? {} : { reasoningEffort: bot.reasoningEffort }) })
  await ctx.agentDefaultModel.saveSelection(prev)
  await ctx.sessions.flush(found.agent.session)
  return sessionId // 一律以返回值登记
}
```

> 核查说明：原说法『新会话默认：模型 = 创建时的全局默认（agentOptions 取 agentDefaultModel.currentSelection()）』不准确。agentOptions 只是 prepareRequest 交给 agent/request 瀑布的种子。真正生效的是 installModelSelection：它在 system-prompt/assemble 时快照 selection.current，再在 agent/request 里用这份快照覆盖 provider/model。selection.current 在『没有 picked、还没写过 request/header』时，实时返回当前全局默认。所以没调 selectModel、也还没跑过请求的会话，会用『第一次请求那一刻』的全局默认。调研员的配方先 selectModel（留下 picked），不受影响。
其余已逐条核实。补充：/permission <错名> 返回 {kind:'error'} 结果，不抛错；permissionPresets.set 名字不对才 throw。ctx.commands.execute 会在会话日志写 command/run（source.kind 'user'）和 command/done。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:755-787（create：二选一、cwd = workspace?.path ?? request.cwd ?? process.cwd()、reusable = 未归档且属于该工作区、attachSession）、:416-466（claim 复用/新建规则）、:524-546（createAgent mkdir、agentOptions 取默认）、:274-300（selectionFor：current = picked ?? requestHeader ?? defaultModel.currentSelection() 实时）; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:167-191（assemble 快照 selection.current → assembled；agent/request 用 assembled 覆盖）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1175-1191（seedConfig 只是 options 或日志 header 的提议）; dsh-src/@deepseek-ai/dsh-permission-presets/lib/index.js:170（服务名 permissionPresets）、:202-205（session/created → pinInitialPermission）、:206-230（/permission：错名返回 kind error，改审批走 approval.setPolicy）、:344-363（set/apply）、:371-391（pinInitialPermission 写三条事件）; dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:63-66（setApprovalPolicy 只 append approval/policy）、:98-110（setPolicy 策略不同才 inject 通知）; dsh-src/@deepseek-ai/dsh-sandbox-policy/lib/index.js:40-42（setSandboxMode 只 append sandbox/mode）; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:264-276（三个权限档）; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:591-594（agent-preset-registry default: standard）；dsh-web-app/presets/{standard,minimal,cordis,ptc}.patch.yml; dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:451（服务名 agentPresets）、:570-581（list）、:596-608（resolve → agent-preset/not-found）; dsh-src/@deepseek-ai/dsh-workspace/lib/index.js:408-412（create 要求已存在的绝对目录、同规范路径复用）、:111-129（attachSession 校验规范 cwd）; dsh-src/@deepseek-ai/dsh-session-title/lib/index.js:295-311（rename 写 source.kind user）；dsh-session-title/README.zh.md:32（用户标题钉住）; dsh-src/@deepseek-ai/dsh-commands/lib/index.js:327-345（execute 写 command/run，source.kind user）

## [confirmed] Q1 会话何时持久化

核实。JSONL 后端是延迟实体化：create(header) 只登记写句柄（writers.set），不写盘。之后每条 session/event 都经 enqueueLive 进入 200ms 批窗口，到点整批写入并 fsync；第一批会连 header 一起落盘。handle.flush() 也能让空会话实体化。从未实体化就崩溃的会话等于不存在。
额外证据支持调研员的推断：agent-loop 的工厂注释写明『挂了持久化后端时，会话的持久身份在发布前就已存储』，而 publish 里是先 enter 再 announce（session/created）。所以权限插件在 session/created 里追加的三条事件会落进已有写句柄的 200ms 批次，新建的空白会话通常约 200ms 内落盘（仍未实测）。
其余也已核实：sessions.flush(session) 返回 boolean；checkpoint 在模型请求前、有副作用的顶层工具前、下一步前刷盘；崩溃后被打断的轮次由恢复方追加合成收尾（turn/end reason interrupted），不会续跑；session.lock 上有 flock 单写者锁；根目录是 dshHomePath('sessions')。

> 核查说明：补充两点：①sessions.flush 返回 true 只表示『至少有一个 session/flush 监听器，且全部成功』。JSONL 监听器在这个会话没有写句柄时直接 return undefined，也算参与，所以 true 不严格等于『这个会话已写盘』。经 sessionController 创建或恢复的会话都有写句柄，可以当作已落盘。②会话目录是 <root>/--<normalized-cwd>--/<encoded-id>/，目录名是编码后的 id，不一定等于原始 id。按纪律未读 ~/.dsh。

证据：dsh-src/@deepseek-ai/dsh-session-persistence-jsonl/README.zh.md:58-72（目录布局）、:77（延迟实体化、每批 fsync）、:168（单写者 flock）; dsh-src/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:187-194（200ms 批窗口）、:361-365（adopt 登记写句柄）、:421-432（session/event → enqueueLive；session/flush 无写句柄返回 undefined）、:2465-2480（create 不写盘）; dsh-src/@deepseek-ai/dsh-session-persistence/README.zh.md:47、:53; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1951-1966（flush 返回 callbacks.length > 0）、:908（interruptedTurnClosers reason interrupted）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1786-1797（publish：enter → sessions.announce）、:1815-1817（持久身份在发布前已存储）; dsh-src/@deepseek-ai/dsh-permission-presets/lib/index.js:202-205、:371-391; dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1586-1597（官方 followup 后 sessions.flush，返回 false 视为失败）; dsh-src/@deepseek-ai/dsh-session-checkpoint-policy/README.zh.md:12; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:138-141

## [confirmed] Q1 会话怎么出现在客户端侧栏

核实。session/created 时控制器 emit api-session/added(summary)，该事件在转发白名单里，客户端 ctx.remote.$on('api-session/added') 后直接加行。agent/status 转成 api-session/status(sessionId, running)，agent/error 转成 api-session/error(sessionId, errorChain)。
显示规则：
- 空白会话（还没有 turn/start）除了当前选中的那条都不显示，origin 'subagent' 的会话也不显示。
- 分组看工作区记录里的 sessionIds：只有 attachSession 过、且规范 cwd 与工作区路径一致的才算成员。dsh-workspace 没有监听 session/created，只给 cwd 建的会话进『未分组』。
- 每个工作区的水位线初始 5 条。
- updatedAt = max(createdAt, lastPromptAt)，lastPromptAt 只认 source.kind==='user' 的 user/message。

> 核查说明：补充：session/disposed 时控制器会发 api-session/removed(sessionId)，它也在白名单里。agent/created 和 agent/disposed 时还会再发一次 api-session/added，用来刷新 agentAvailable。中心面板可以用这两个事件维护行状态。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2980-2996（added/removed/status/error）、:2997-3004（activity 只在 kind user 时发）; dsh-src/@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js:16-45（白名单含 api-session/added|removed|status|activity|error）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/client.js:4266-4280（客户端 $on 五个 api-session 事件）; dsh-src/@deepseek-ai/dsh-client-ui-workspace/lib/client.js:964-974（sessionVisible）、:1027-1044（groupByWorkspace / Ungrouped）; dsh-src/@deepseek-ai/dsh-workspace/lib/index.js:102-104（sessionIds 按规范 cwd 过滤）、:111-129（attachSession）；该文件没有任何 ctx.on 监听; dsh-src/@deepseek-ai/dsh-client-ui-workspace/README.zh.md:30（水位线 5）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:1871-1879（blank/lastPromptAt）、:2124-2126（updatedAt）、:1940-1953（summaryFor）

## [confirmed] Q2 agent 对象 followup / steer / inject / whenIdle / cancel 的语义差别

核实。
- send(msg, target, wakeup)：把传入对象原样插入 inbox，不补 id/role。followup → next-turn 并唤醒；steer → next-step 并唤醒；inject → next-step 不唤醒。若唤醒时 agent 正在中止，目标自动改成 next-turn，收尾后再唤醒。
- claim：先取 next-step 全部，再取 next-turn 的 1 条，并逐条发 agent/inbox/claimed {agent, message, turn}。
- 轮次推进：一步结束且 next-step 为空才跑 agent/turn-stopping，之后仍为空才收尾。
- cancel(cause, {keepInbox})：不带 keepInbox 会持久清空两条队列。cause 只有 user|parent|disposed|hook 四种，hook 会带 reason。
- whenIdle：循环等 activityDone，直到它不再变化。
- status：维护期间算 idle，其余非 idle 阶段（含等审批）算 running。
- 已归档会话：ArchivedSessionGate 在 agent/pre-step 返回 {kind:'reject'}，本轮以 blocked 收尾。

> 核查说明：补充两点细节：①turn() 收尾后会检查 inbox.hasPending（两条队列任一非空），为真就在同一个驱动循环里直接开下一轮。所以 agent 运行中 inject 的消息，即使错过本轮最后一次『是否继续』检查，也会马上开新一轮处理。『inject 不唤醒』只在 agent 空闲时成立。②pre-step 被拒（归档门禁，或中心自己挂的预算闸）时，本轮已 claim 的消息算被这次 blocked 结局消费掉，不会重新排队。中心如果用 pre-step reject 做闸门，被拦的唤醒消息要自己记账、之后重投。

证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:790-798（status 与 agent/status）、:800-821（send/followup/steer/inject/cancel）、:854-875（wakeDriver/whenIdle）、:103-111（claim 顺序与 agent/inbox/claimed）、:731-745（cancel cause）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:938-1041（turn：:961 reject → blocked；:999-1006 turn-stopping；:1037-1041 hasPending → 开下一轮）、:885-893（kick 循环）; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:53-60（blocked 结局表示被 claim 的输入已被丢弃）; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:242-273（agentEvents 把 agent 合并进 payload）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2508-2518（ArchivedSessionGate）；README.zh.md:75

## [corrected] Q2 能否给消息带自定义 source（标记来自中心插件）及构造写法

能，但不能经 sessionController.prompt，它的 source 写死为 {kind:'user', rpcId, …}。做法是对 Agent 句柄直接调 followup/steer/inject，传一条完整、冻结的消息：{id: 非空字符串, role:'user', content: ContentBlock[], source: {kind: 非空字符串, …}}。官方 createUserMessage 的实现是 deepFreeze(structuredClone({...input, role:'user', id})）；brandString 运行时是恒等函数，所以手写等价函数没问题。
官方先例：dsh-schedule 用 {kind:'schedule'} + followup + flush；dsh-tool-jobs 用 {kind:'tool-jobs', form:'notice', summary}；agent-team 用 {kind:'agent-message', form:'relay', senderSessionId}。
UI：非 user 来源渲染为上下文行，标签默认是 kind；唤醒本轮的那条渲染为 turn-trigger；notice 有非空 summary 时显示 summary；relay 有 senderSessionId 时显示『来自会话 X』。
两条更正：
①inbox 不会按 id 静默去重。两条队列合起来要求 id 唯一，重复的待处理 id 会让 inbox.mutate 直接 throw Error('message "<id>" is already pending')，followup/steer/inject 同步抛错。
②消息（包括 source 里的任何自定义字段）不能有值为 undefined 的属性。inbox 会把整条消息写进 agent/inbox/spliced 事件，Session.append 用 snapshotJsonValue 校验，遇到 undefined 直接 throw『session event "agent/inbox/spliced" carries non-JSON-serializable data』。
回放校验（id 非空、role 'user'、source.kind 非空字符串、content 为数组）与『不能在同一会话的 session/event 同步阶段 append』两点都已核实。

```
import { randomUUID } from 'node:crypto'
function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]) }
  return v
}
// 去掉值为 undefined 的键：Session.append 遇到 undefined 会拒绝整条事件
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
export function hubUserMessage(text, source) {
  if (typeof source?.kind !== 'string' || source.kind === '') throw new Error('source.kind 必须是非空字符串')
  return deepFreeze(structuredClone({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: defined(source) }))
}
export async function wakeBot(ctx, sessionId, { text, botId, wakeId, summary }) {
  const found = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in found) throw found.error
  const { agent } = found
  // 业务幂等自己做；同一 message.id 重复入队会直接抛 already pending
  const mine = (m) => m.source?.kind === 'agent-hub' && m.source.wakeId === wakeId
  if (agent.inbox.nextTurn.some(mine) || agent.inbox.nextStep.some(mine)) return 'duplicate'
  agent.followup(hubUserMessage(text, { kind: 'agent-hub', form: 'notice',
    summary: String(summary ?? text).slice(0, 120) || '中心唤醒', botId: String(botId), wakeId: String(wakeId) }))
  await ctx.sessions.flush(agent.session)
  return 'queued'
}
```

> 核查说明：原说法『inbox 按 message.id 去重』，证据写的是 dsh-agent-loop:225-248。那几行其实是 SystemPromptProjection，与 inbox 无关。真实行为是重复 id 抛错，见 :186-193（mutate）与 :41-45（投影回放同样校验）。补充 undefined 字段这条：调研员示例代码里的 summary、botId、wakeId 一旦是 undefined，followup 就会同步抛错。

证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:186-193（mutate：重复 id → throw already pending）、:41-45（投影 apply 同样校验）、:200-206（整条消息写进 agent/inbox/spliced）、:800-814（send 原样插入）; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1517-1537（append：snapshotJsonValue 失败即 throw）; dsh-src/@deepseek-ai/dsh-util-values/lib/index.js:739（undefined 等非对象值使校验失败）; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1086-1090（adoptSessionEvent 回放时调 assertMessageEventShape）、:1194-1215（id/role/source.kind/content 校验）; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:15-23（summary 上限 120）、:37-64（createMessage/createUserMessage）; dsh-src/@deepseek-ai/dsh-brand/lib/index.js:20-22（brandString 恒等）; dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1586-1597；dsh-src/@deepseek-ai/dsh-tool-jobs/lib/index.js:271-295；dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1598-1610; dsh-src/@deepseek-ai/dsh-client-ui-chat/lib/client.js:9877-9925、:7756-7805、:4872-4875、:4799-4802; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1568-1571（重入即抛）、:1576-1595（session/event 在 commit 内同步分发）、:1231-1240（监听器异常只记 warn）

## [confirmed] Q2 自定义 source 的副作用与替代方案（取舍）

核实。非 kind:'user' 来源有这些代价：
①不触发自动标题（sessionTitleUserMessageOf 只认 kind user）；
②turnOutline 的 prompt 为空；
③不更新 lastPromptAt，侧栏不上浮；
④不发 api-session/activity；
⑤create_goal，以及 update_goal 的 edit/pause/resume，都要求本轮里有 kind:'user' 消息且 agent 是根（ctx.agents.roots()，经 sessionController 建的会话都是根）；complete/blocked 则接受人类输入或当前 goal 轮次；
⑥requestId 幂等只认 kind 'user' + rpcId。
替代方案也成立：
- A：requestId 原样存成 source.rpcId，可以加前缀识别来源；
- B：空闲时 inject 加 prompt，两条在同一次 claim 中一起领取（next-step 在前，next-turn 的 1 条在后）；
- C：relay 形态可用。

> 核查说明：B 方案的出处 dsh-taskboard 在 ~/.dsh 里，按纪律未复核，但机制本身已由 claim 顺序证实。提醒：经 prompt（kind 'user'）送达的消息在 goal 工具眼里就是『直接人类输入』，可以让机器人自行创建或修改目标。自主唤醒（定时、事件、巡检）不要走 prompt，只有真正来自人类的指令才走。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:1127（requestId 持久化为 rpcId）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:1128-1139、:2997-3004、:1871-1879; dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:45-52（hasDirectHumanInput）、:62-79（requireDirectHuman / completionAuthority）、:289-296（create_goal）、:342-353（edit/pause/resume）; dsh-src/@deepseek-ai/dsh-session-turn-outline/lib/index.js:97-108; dsh-src/@deepseek-ai/dsh-session-title/lib/index.js:91; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:103-111; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:614-625（roots：没有 owner 的 agent）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/docs/design/evidence/03-goal-loop.md:91（taskboard 组合，未复核）

## [corrected] Q3 怎么知道一轮结束、拿到最终回复文本与工具调用记录（事件名与载荷）

订阅方式与载荷基本正确：ctx.on('session/event', (session, event) => …) 同步收到所有会话（包括 preset 作用域与子代理）的每条已提交事件。原说法给的事件顺序有误，正确的单轮顺序是：
turn/start{turn}
→ agent/inbox/spliced（preStep 里 claim，从 inbox 移出）
→ [自动压缩可能插入 compaction/start、compaction/summary、user/message(compact-checkpoint)、compaction/end]
→ step/start{turn,step}
→（agent/request 瀑布，不产生事件）
→ [system/message]
→ user/message…（本步领取的输入，夹着 source.kind 为 runtime-context、model-selection 等的注入；只在首次尝试时写）
→ [request/header{header:{config, adapterDefaults?, tools?}, reason:'initial'|'resume'|'change'|'series', startsSeries?}]
→ [developer/message（工具增删）]
→ [request/context{provider, model, contextWindow?, systemPromptUpdate?}]（变化时才写）
→ assistant/message{turn, step, message, usage?, stream, interrupted?}；失败或重试的尝试写成 assistant/attempt
→ tool/call{turn, step, callId, name, arguments} → [approval/asked{id, toolName, callId?, reason?} → approval/decided{id, outcome}] → tool/result{turn, step, message:{id, role:'tool', toolCallId, content, isError, source:{kind:'tool', callId}}, error?, meta?}
→ step/end
→（有工具调用则下一步：agent/inbox/spliced(next-step) → step/start …）
→ turn/end{turn, reason}。
要点：user/message 在 step/start 之后，并且在 request/header 之前。
reason.kind 取值：completed、blocked、aborted（reason.reason = {kind:'user'|'parent'|'disposed'|'hook', reason?}）、error（error = LlmError.failure 或 {message, code:'UNKNOWN'}）、max-tokens、interrupted（恢复时合成）、forked。
最终回复的规则、按 callId 配对工具、agent/inbox/claimed {agent, message, turn}、agent/status、agent/error {agent, turn, step, error}、agent/pre-step 与 agent/turn-stopping 的可拦截性，都已核实。

```
// 单步顺序：step/start → [system/message] → user/message… → [request/header] → [developer/message] → [request/context] → assistant/message → tool/call/tool/result → step/end
const turns = new Map()
ctx.on('session/event', (session, event) => {
  if (!bots.has(session.id)) return
  const t = turns.get(session.id)
  switch (event.type) {
    case 'turn/start': turns.set(session.id, { turn: event.data.turn, inputs: [], finalText: '', calls: new Map() }); return
    case 'user/message': t?.inputs.push({ id: event.data.id, source: event.data.source }); return // data 就是消息本身
    case 'assistant/message': {
      const text = event.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (t && text !== '') t.finalText = text
      return
    }
    case 'tool/call': t?.calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments }); return
    case 'tool/result': { const c = t?.calls.get(event.data.message.toolCallId); if (c) Object.assign(c, { isError: event.data.message.isError }); return }
    case 'turn/end': turns.delete(session.id); setImmediate(() => onTurnEnd(session.id, t, event.data.reason)) // 同步阶段不能对同一会话 append
  }
})
```

> 核查说明：原说法的顺序『turn/start → user/message → step/start → [system/message] → [request/header] …』错误。step/start 写在 turn() 里，紧接在 preStep 之后（:970）；user/message 由 step() 在 system/message 之后、buildRequest 之前追加（:1061-1073）；request/header 与 request/context 在 buildRequest 里（:1222-1271）。调研员的示例代码只依赖 turn/start…turn/end 的括号关系，仍然可用。

证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:945（turn/start）、:906（preStep 内 inbox.claim）、:970（step/start）、:1043-1073（step()：prepareRequest → system/message → user/message）、:1214-1271（buildRequest：request/header reason、developer/message、request/context）、:1156-1162（assistant/message）、:1098-1121（中断/失败写 assistant/attempt 或 interrupted 消息）、:681-707（tool/call、tool/result）、:994（step/end）、:1029（turn/end）、:950-1035（reason 取值）; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1576-1595（session/event 同步分发）; dsh-src/@deepseek-ai/dsh-session/lib/types/known-event-types.js:21-84; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:1020-1036、:101-111; dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:132-142; dsh-src/@deepseek-ai/dsh-compaction-basic/lib/index.js:839-853（pre-step 自动压缩，发生在 step/start 之前）

## [confirmed] Q3 projection 的数据结构与读取方式

核实。三种读取方式：
①await sessionController.projections({sessionId}, signal)：在线会话读内存快照，冷会话经 observeSession 精确折叠，不激活 agent；
②在线同步读 ctx.sessionProjections.snapshot(session, keys?) → {asOfSeq, values}（经 viewSchema 校验的 wire 值）；stateOf(session, key) 返回内部状态；
③ctx.sessionProjections.onChanged((session, key, value, seq) => …)，只在原始视图引用变化时推送，注册即挂在调用方 fiber 上。
各键形状均已核实：title、turnOutline(prompt ≤50 / response ≤120)、sessionStats、tokenUsage、contextPressure、contextBreakdown、goal（blockedReason 是 {code, message}）、inbox、modelSelection{lastUsed, next}、permissions{currentValue}、sessionListMetadata{blank, lastPromptAt} 等。turnOutline/sessionStats 不在控制器的类型化 schema 里，经 z.record 透传。sessionQuery.readSession(id) → {session(header), inheritedEventCount, events}。

> 核查说明：补充约束见『补充：onChanged 监听器』条目：它在 session/event 分发内同步执行，不能对同一会话 append，也绝不能抛错。snapshot 只适用于已 attach 的会话；ctx.sessions.get(id) 为 undefined 时改用 projections()。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:791-958; dsh-src/@deepseek-ai/dsh-session-turn-outline/lib/index.js:25-27、:78-150; dsh-src/@deepseek-ai/dsh-session-stats/lib/index.js:29-36、:67; dsh-src/@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js:83-120、:141-188; dsh-src/@deepseek-ai/dsh-session-projection/lib/index.js:109-155、:402-426; dsh-src/@deepseek-ai/dsh-session-query/lib/index.js:1081-1089、:1152、:1168; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:99-107

## [confirmed] Q4 selectModel 会改全局默认；按会话设定模型且不改全局默认的做法

核实。selectModel 的流程：resolveAgent（会恢复冷会话）→ requireModel（provider 不在 listProviders，或 model 不在 listModels 里，就报 session/model-unavailable）→ llm.resolveCallConfig → selectForNextRequest（追加 model/selection 事件并设置 picked）→ 不等待地调用 agentDefaultModel.saveSelection(selected)。
saveSelection 的同步部分就是 this.saves = this.saves.then(...)，所以按调用顺序串行写入。selectModel 返回前已经调用过它，此后立刻 await saveSelection(prev)，必然排在后面，最终默认就是 prev。
会话的生效路由：picked ?? 日志里最近的 request/header ?? 全局默认（实时）。pending 重启后会从 modelSelection 投影恢复，等 request/header 与它完全一致才清掉。

```
export async function selectModelKeepDefault(ctx, sessionId, provider, model, reasoningEffort) {
  const prev = ctx.agentDefaultModel.currentSelection()
  const { selected } = await ctx.sessionController.selectModel({ sessionId, provider, model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
  await ctx.agentDefaultModel.saveSelection(prev) // 串在 selectModel 那次保存之后
  return selected // 常带 reasoningEffort（补成模型默认值）
}
```

> 核查说明：补充：①没给 reasoningEffort 时，resolveCallConfig 会补成该模型的 defaultEffort，所以 selected 和写进默认的值通常都带 reasoningEffort。②没有 configEditor 或 fiber.entry 时，saveSelection 直接 return（不写、不报错）。③prev 取自 currentSelection()。如果用户刚在 UI 改了默认、保存还没提交，prev 可能是旧值，还原会把用户的改动盖掉。批量建机器人要串行执行，并避开用户正在操作的时候。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:793-823（selectModel；:809 不等待 saveSelection）、:966-971（requireModel）、:615-628（modelAvailable）、:274-300（selectionFor）、:312-315（selectForNextRequest）、:2998-3001（request/header 消费 picked）、:2155-2189（modelSelection 投影）; dsh-src/@deepseek-ai/dsh-agent-default-model/lib/index.js:38-67（currentSelection；saveSelection 串行，缺 editor 时 return）; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:2174-2219（resolveCallWithInfo 补默认 effort）; dsh-src/@deepseek-ai/dsh-api-session-controller/README.zh.md:89-91; dsh-src/@deepseek-ai/dsh-client-ui-model-selection/README.zh.md:76、:97

## [confirmed] Q4 agent/request 钩子如何改 provider/model

核实。agent-loop 每一步在 prepareRequest 里跑 waterfall('agent/request', {agent, turn, step, signal})。种子是：本 loop 已写过 header 时取 requestProposal(日志 header)（去掉适配器默认值），否则取 AgentOptions。返回值交给 llm.prepareCall 校验路由（NO_ADAPTER 时退回原提议，之后请求失败），再写入 request/header。
所有 waterfall 监听器共用一个 _hooks 数组，cbs.shift() 先执行的是最外层，prepend 用 unshift 放到最前；作用域分发对无标签监听器放行。installModelSelection 在 agent 的作用域 ctx 上用普通 push 注册，它先 await next()，再用 selection.assembled 覆盖 provider/model，并去掉继承的 effort。所以中心钩子必须加 {prepend:true}：插件在 agent 之后注册（例如热重载）时不加就会被内置覆盖。
308 个包里只有 dsh-agent:181 监听 agent/request。黏性、换供应商要丢掉 effort、压缩沿用最近路由、首次请求的 {{model}} 与实际不一致这几点都成立。

```
const routes = new Map() // sessionId -> { provider, model, reasoningEffort? }
ctx.on('agent/request', async (payload, next) => {
  const resolved = await next()
  const route = routes.get(payload.agent.id)
  if (route === undefined) return resolved
  const { reasoningEffort: _drop, ...rest } = resolved
  return { ...rest, provider: route.provider, model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }
}, { prepend: true })
```

> 核查说明：漏掉了一个关键交互，见『补充：钩子与 selectModel 待用选择的冲突』。另：钩子改道时模型收不到任何切换提示。改道那一步 assembled 仍是旧路由、与上次 header 相同，所以不追加 [model changed]；下一步 assembled 已经变成新路由，也不追加。

证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1175-1211（prepareRequest）、:716-722（requestProposal）; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:166-209（installModelSelection 三个监听器）; dsh-src/@deepseek-ai/cordis/lib/index.js:258-264（dispatch 过滤）、:317-325（waterfall 外层先执行）、:335-346（prepend → unshift）、:371-380（on）; dsh-src/@deepseek-ai/dsh-scope/README.zh.md:73-75; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:2174-2219、:2220-2235（prepareCall）

## [confirmed] Q4 有没有服务能列出已配置的模型/供应商（不读凭据）

核实。modelCatalog() 即 buildModelCatalog(ctx)，返回 {default, routableProviders, groups:[{id, name, models:[{id, name, description?, reasoning?:{efforts:[{id,name,description?}], defaultEffort?}}]}], failures:[{id, name, message}]}。它只列有适配器的供应商；单个供应商出错进 failures；模型列表为空的组会被过滤掉。
底层接口：llm.listProviders()；llm.listModels(provider) → [{provider, id, name, description?, inputModalities?}]；llm.resolveModelInfo(provider, model, signal?) → {provider, id, name, description?, inputModalities?, context?:{contextWindow}, defaultMaxTokens?, systemPromptUpdate?, toolUpdate?, reasoning?}；llm.listConfigurableProviders()；agentDefaultModel.currentSelection()。DeepSeek API Key 路由在没有 key、或未通过官方 /models 认证时返回空目录。

> 核查说明：补充：listConfigurableProviders() 的条目除 provider/displayName/settingsNs/settingsPath/error? 外，还带 declared 和供应商默认值（如环境变量名，不含密钥值）。pi-ai 会为它目录里的每个供应商都声明一条（含 zai、zai-coding-cn），即使用户没配置。所以判断『已配置、可用』要看 listProviders() 或 modelCatalog().routableProviders，不能看 listConfigurableProviders()。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:563-611、:3121-3123; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js:706-736; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:1908-1910、:1964-1966、:2086-2104、:2111-2170、:2416-2427; dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2841-2857（directoryEntries：目录内每个供应商都声明）; dsh-src/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js:139-148

## [confirmed] Q4 模型/供应商标识的形状；DeepSeek 与 GLM 在 DSH 里的 provider id

核实。
DeepSeek：
- 路由 deepseek-official：显示名 DeepSeek，apiKeyEnv 默认 DEEPSEEK_API_KEY；
- 路由 deepseek-account：显示名 DeepSeek Account；
- 内置目录：deepseek-flash（DeepSeek-V4.1-Flash，1,048,576，text+image）、deepseek-v4-pro；
- 推理强度 off/low/high/max，默认 high；thinking 被禁用时只有 off；
- dsh-base 出厂默认 deepseek-official/deepseek-flash，ACP 是 deepseek-v4-flash。
GLM：
- 走 dsh-llm-pi-ai，默认休眠；
- pi-ai 目录里有 zai（https://api.z.ai/api/coding/paas/v4，ZAI_API_KEY）和 zai-coding-cn（https://open.bigmodel.cn/api/coding/paas/v4，ZAI_CODING_CN_API_KEY）；
- 路由 id 就是 llm-pi-ai 设置里 providers 字典的键；
- pi-ai 推理等级词表：off/minimal/low/medium/high/xhigh/max。

> 核查说明：补充：pi-ai 目录条目的 settingsPath 是 ['providers', <键名>]，进一步证实路由 id 就是 providers 的键名。DeepSeek 适配器对目录外的模型 id 不会在 prepare 阶段拒绝：name 取 id，上下文取 defaultContextWindow（默认常量 1e6），错误要到真正请求时才出现。defaultMaxTokens 默认 256000，但启用官方 /models 列表时可能被列表的 maxOutputTokens 压低，所以 Q5 的压缩阈值仍是估算。

证据：dsh-src/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js:8-13、:47、:112-122; dsh-src/@deepseek-ai/dsh-llm-deepseek-account/lib/index.js:70、:128-137; dsh-src/@deepseek-ai/dsh-llm-deepseek/lib/index.js:16-31、:36-40、:329-330、:450-451、:472-546、:2645; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:89-94、:128-136、:520-529; dsh-src/@deepseek-ai/dsh-acp-app/cordis.patch.yml:15-20; dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2784-2791、:2841-2857、:2943-2953、:298-306

## [confirmed] Q5 会话上下文用量（token 数）从哪里读、怎么按 50% 轮换

核实。token meter 留在宿主层，注册了 tokenUsage、contextPressure、contextBreakdown 三个投影。contextPressure 的 wire 形状是 {contextWindow?, pressureTokens?, projectedTokens?}：
- pressureTokens = 最近一次请求的 inputTokens(未缓存) + cacheRead + cacheWrite；
- projectedTokens = max(0, pressure + surfaceTokens − sampledSurfaceTokens)；
- contextWindow 取自最近一条 request/context。
UI 占用率公式为 used = projectedTokens ?? pressureTokens，percent = min(100, round(used / contextWindow × 100))。启发式按 4 字符/token 估算，中文增量会被低估。轮换建议与 archiveSession(sessionId, {stopActivity?}) 也都核实。

> 核查说明：补充：tokenMeter.measure(session, requestHeader?) 实际返回 {logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes}，调研员只列了其中一部分，不影响结论。onChanged 里只打标记的写法正确，另需 try/catch，见 onChanged 补充条目。

证据：dsh-src/@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js:121-188; dsh-src/@deepseek-ai/dsh-token-meter/lib/index.js:686-696、:722-765; dsh-src/@deepseek-ai/dsh-token-meter/lib/types/estimate.js:9（CHARS_PER_TOKEN = 4）; dsh-src/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:18641-18649; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1262-1271; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:537-541; dsh-src/@deepseek-ai/dsh-workspace/lib/index.js:526-542

## [confirmed] Q5 压缩（compaction）机制与插件可用的操作

核实。宿主层的 compaction-basic、command-compact、tool-result-pruner 都被禁用；standard、minimal、cordis、ptc 四个 preset 都在 isolate:{compaction:true} 组里挂了 compaction-basic 和 command-compact，minimal 没挂 tool-result-pruner。
阈值公式 floor(min(W×0.8, W−O−65536))，保留 16%×(W−O)。自动压缩在 agent/pre-step；溢出恢复在 agent/request-error 收到 CONTEXT_WINDOW_EXCEEDED 时触发。摘要沿用最近已路由的目标，复用前缀缓存，用英文写；系统提示词所在的 surface 节点 0 永不被遮蔽。
事件依次是 compaction/start、compaction/summary（原始摘要在这里）、替换用的 user/message(source.kind 'compact-checkpoint')、compaction/end。
手动压缩：commands.execute(agent, '/compact', [], signal) → {commandId, result:{kind, text, sourceEventSeq?}} 或 undefined。它内部走 runMaintenance，agent 不空闲时以 busy 错误结果返回。
估算的阈值：DeepSeek 约 727,040（69%）；pi-ai 无目录值时 163,840（62.5%）。

证据：dsh-src/@deepseek-ai/dsh-compaction-basic/README.zh.md:60-80、:108、:113、:119; dsh-src/@deepseek-ai/dsh-compaction-basic/lib/index.js:824-870、:634、:985-1010; dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:66-80；minimal.patch.yml:24-33；cordis.patch.yml:65-80；ptc.patch.yml:66-80; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:543-551; dsh-src/@deepseek-ai/dsh-command-compact/lib/index.js:20-69; dsh-src/@deepseek-ai/dsh-commands/lib/index.js:327-350; dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1150-1151、:1470-1478

## [confirmed] Q6 插件能否在客户端里打开/聚焦某个会话（导航 API）

核实。客户端服务 uiWorkspace 的接口：
- openSession(target) 即 replaceMain(target, lifetime.signal, 'reveal')：retain 会话、设为选中，然后 layout.selectPanel(null)；
- openWorkspace(id, beforeOpen?, {agentPreset?})；
- startSession(workspaceId?, {prompt?, whenDraftExists?, clearPreviousDraft?, agentPreset?})，只填草稿，不发送。
官方 dsh-client-ui-workflow-run 就是注入 uiWorkspace 后调 openSession。宿主侧只有 dsh://open，而且只聚焦窗口。客户端 follow 一个冷会话时，宿主会 promote 恢复 agent，并拿走写锁。

> 核查说明：补充：官方客户端插件都在 inject 里声明 'remote'（例如 dsh-client-ui-schedule 的 inject 含 'remote' 与 'uiWorkspace'），再用 ctx.remote.$on 监听白名单事件。第三方客户端插件可以照此写 exports.inject = ['remote', 'uiWorkspace']；在 ModuleLoader 包装下是否生效仍未实测。

证据：dsh-src/@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1380、:1471-1473、:1474-1530、:1652-1675; dsh-src/@deepseek-ai/dsh-client-ui-workspace/README.zh.md:74、:96; dsh-src/@deepseek-ai/dsh-client-ui-workflow-run/lib/client.js:643、:660; dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:7365-7376（inject 含 remote/uiWorkspace）、:6302（ctx.remote.$on('schedule/changed')）; dsh-src/_app/main.js:13055-13058; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:1586-1593、:3006-3025

## [corrected] 补充：中心能否往会话日志里写自己的事件类型

不能用 session.append 写自定义事件类型。Session.append 不检查类型名，也不会加 ignorable 标记，所以写的当下不报错。但持久化读路径会拒绝『不在 KNOWN_SESSION_EVENT_TYPES 里、又没标 ignorable』的事件，抛出『… unknown to this harness and not marked ignorable; refusing to interpret the log』。结果是 DSH 重启或冷读后这个会话再也打不开、也恢复不了。唯一能写 ignorable 插件记录的 appendPluginRecord，README 明确禁止仓库外插件调用。结论：中心的注册表、唤醒记录、预算账本一律放在自己的存储（storageDomain 或自己的文件）里。需要在对话里留痕时，用合法的 user/message（followup/inject 加自定义 source），不要自造事件类型。

> 核查说明：补充（调研员只提到 appendPluginRecord 被禁，没提『直接 session.append 自定义类型会让会话不可读』这个更隐蔽的坑）。

证据：dsh-src/@deepseek-ai/dsh-session/lib/types/known-event-types.js:8-20（读路径拒绝未知且未标 ignorable 的类型；仓库外插件事件按构造不在表内）; dsh-src/@deepseek-ai/dsh-session-persistence/lib/index.js:184（throw unsupported … refusing to interpret the log）; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1517-1537（append 不校验类型名、不加 ignorable）; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1272-1297；dsh-session/README.zh.md:70（appendPluginRecord 仅限 packages/experimental，仓库外不得调用）

## [corrected] 补充：直连 prompt 与手搓消息里的 undefined 字段

宿主内直连没有 schema 校验，『缺字段』不会被友好拒绝，而是在写日志时炸掉。prompt 把 request.requestId 原样放进 source.rpcId：漏传 requestId 时，source 里就有 rpcId: undefined。followup 往 inbox 写 agent/inbox/spliced 时，Session.append 校验失败抛错，又被 prompt 包成 session/agent-busy『prompt rejected』，表面看像会话忙。同理，clientTimeZone 不用时不要写成 undefined；自定义 source、content 块里也不能有 undefined。规则：requestId 必须是非空字符串；所有可选字段用条件展开，不要写 undefined 值。

```
await ctx.sessionController.prompt({
  sessionId,
  requestId: `agent-hub:${botId}:${taskId}`, // 必须是非空字符串
  mode: 'queue',
  content: [{ type: 'text', text: taskText }],
  ...(tz === undefined ? {} : { clientTimeZone: tz }), // 不要写 clientTimeZone: undefined
}, AbortSignal.timeout(30_000))
```

> 核查说明：补充。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3218-3232（rpcId: request.requestId）、:944-951（createUserMessage → followup/steer）、:957-961（非 RemoteError → session/agent-busy 'prompt rejected'）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:200-204（整条消息写进 agent/inbox/spliced）; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1524（non-JSON-serializable → throw）; dsh-src/@deepseek-ai/dsh-util-values/lib/index.js:739

## [corrected] 补充：sessionProjections.onChanged 监听器的约束

onChanged 回调不是异步通知。它由 SessionProjectionRegistry.drive 在 session/event 监听器里同步调用，逐个投影单元执行，没有 try/catch。因此：
①回调里不能对同一会话 append（followup/inject/permissionPresets.set 等），否则触发重入，抛错并被吞掉；
②回调一旦抛错，drive 会中断，同一事件后面的投影单元不再推送。客户端 control 流的 projection 帧正是 SessionControlController 用 onChanged 推的，所以中心监听器抛错可能让 UI 漏掉实时更新（标题、inbox、goal、contextPressure 等）。
写法：回调体整体包 try/catch，只记录或打标记，真正动作放到 setImmediate 或 turn/end 之后。

```
ctx.sessionProjections.onChanged((session, key, value) => {
  try {
    if (key !== 'contextPressure' || !bots.has(session.id)) return
    const used = value?.projectedTokens ?? value?.pressureTokens
    if (used !== undefined && value?.contextWindow && used / value.contextWindow >= 0.5) needsRotation.add(session.id) // 只打标记
  } catch (e) {
    ctx.logger.warn(`agent-hub: onChanged 处理失败 ${String(e)}`) // 绝不向外抛
  }
})
```

> 核查说明：补充。

证据：dsh-src/@deepseek-ai/dsh-session-projection/lib/index.js:64-66（drive 挂在 session/event 上）、:402-426（逐单元调 listener，无 try/catch）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:1201-1209（客户端 control 帧来自 onChanged）; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1231-1240（隔离只在 session/event 监听器粒度）、:1568-1571（同会话重入抛错）

## [corrected] 补充：agent/request 钩子与 selectModel 待用选择（picked）的冲突

会话存在一个与钩子路由不同的 picked 时，会出两个问题。picked 的来源可以是中心自己调的 selectModel，也可以是用户在 UI 里用 /model 或 composer 切的模型。
①picked 永远消费不掉。只有 request/header 的 provider/model/effort 与 picked 完全一致时，consume 才清掉它；钩子改道后 header 永远是钩子路由。投影里的 pending 也一样，重启后还会恢复。
②几乎每一步都会多一条 [model changed] 通知。installModelSelection 每步把 selection.current（即 picked）快照为 assembled；pre-step 监听器看到 assembled 与上次 request/header 的路由不同，就往本步输入里追加一条 user/message：『[model changed: assistant turns above this point were generated by <钩子路由>; the session continues with <picked>]』（source {kind:'model-selection', form:'notice'}）。内容方向是反的，而且会持久写进日志。除了某些首步空决策，其余每步都会追加。
对策：
- 某机器人一旦交给钩子路由，就不要再给它 selectModel 一个不同的模型；
- 中心改钩子路由时，同时调一次 selectModelKeepDefault(路由)，让 picked 与钩子一致，下一次请求就会被消费掉；
- 或者在钩子里读 ctx.sessionProjections.stateOf(session, 'modelSelection')?.pending，发现与路由不同就视为人类改了模型，撤销该机器人的钩子路由，不再强改。

```
ctx.on('agent/request', async (payload, next) => {
  const resolved = await next()
  const route = routes.get(payload.agent.id)
  if (route === undefined) return resolved
  const pending = ctx.sessionProjections.stateOf(payload.agent.session, 'modelSelection')?.pending
  if (pending && (pending.provider !== route.provider || pending.model !== route.model)) {
    routes.delete(payload.agent.id) // 有人手动选了别的模型：让位，避免每步 [model changed] 通知
    return resolved
  }
  const { reasoningEffort: _drop, ...rest } = resolved
  return { ...rest, provider: route.provider, model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }
}, { prepend: true })
```

> 核查说明：补充（调研员把『selectModel 建机器人 + agent/request 钩子运行期改道』作为组合推荐，但没发现两者冲突）。读代码推断，未实测。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:279（picked 来自 modelSelection.pending）、:283-285（current 先返回 picked）、:296-300（consume 要求 provider/model/effort 全等）、:2998-3001（request/header 时尝试消费）、:2155-2172（pending 只在 header 相同时清空）; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:167-178（assemble 快照 selection.current）、:181-191（agent/request 用 assembled 覆盖）、:193-203（pre-step：assembled 与上次 header 路由不同 → 追加通知）、:133-148（modelSwitchNotice 文案与 source）

## [corrected] 补充：中心监听 session/created 的风险

SessionStore.announce 同步调用 session/created 监听器，只 catch 返回的 Promise 拒绝，不 catch 同步异常。announce 又在 agent 工厂的 publish 里调用，所以中心若 ctx.on('session/created', …) 且同步抛错，会让 DSH 里所有新建或恢复会话失败（被包成 gateway/internal）。可以在这个监听器里 append（权限插件就这么做），但回调必须整体 try/catch。中心通常用不到 session/created：建会话以 sessionController.create 的返回值为准。

```
ctx.on('session/created', (session) => {
  try { /* 只做轻量登记 */ } catch (e) { ctx.logger.warn(`agent-hub: ${String(e)}`) } // 同步异常会让建会话失败
})
```

> 核查说明：补充。

证据：dsh-src/@deepseek-ai/dsh-session/lib/index.js:1901-1922（announce：同步调用监听器，只处理 Promise 拒绝）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1786-1797（publish：enter → sessions.announce，异常直接抛出）

## 坑

- 证据路径里的 dsh-src/ = /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/（只读解包的官方源码）。
- 宿主内直连 sessionController 不做任何 schema 校验：多余字段静默丢弃；mode 只要不是 'steer' 就按 queue；缺字段不会被友好拒绝。比如 prompt 漏传 requestId，会在写日志时失败，并表现为 session/agent-busy『prompt rejected』。
- prompt(req, signal) 和 projections(req, signal) 必须传 AbortSignal，不传直接 TypeError；create/selectModel/rename/cancel 不收 signal；list 的 signal 可选。cancel 是同步方法：不在线时同步 throw session/not-found，不是 rejected Promise。
- selectModel 的 provider 必填（z.string()）。用户 dsh-bridge 里只传裸模型 id 的分支会以 session/model-unavailable 失败，被 catch 后静默退回默认模型（bridge.js:328-338）。
- selectModel（以及 UI 的 /model、composer 模型位）会在后台把选择存成全局默认，要立刻 saveSelection(prev) 还原。未给 reasoningEffort 时，它会补成模型默认强度。
- 新会话在没有 selectModel、也还没发过请求时，用的是『第一次请求那一刻』的全局默认（实时读），不是创建时的快照。给机器人定模型必须显式 selectModel（再还原默认）或用钩子。
- create({sessionId}) 不是『按 id 取或建』：已开始、已归档、不在指定工作区或被他人持锁时，会静默新建 session-<uuid>；目录不同报 session/conflict。永远以返回的 sessionId 登记。
- 手搓给 followup/steer/inject 的消息必须同时满足：非空 id、role 'user'、source.kind 非空字符串、content 数组、深冻结；整条消息（含 source 自定义字段）不能有 undefined 值，否则同步抛 non-JSON-serializable；同一个 id 已在 inbox 时再入队会抛『message "<id>" is already pending』（不是静默去重）。
- session/event 和 sessionProjections.onChanged 都在 Session.append 的提交阶段同步执行：不能对同一会话再 append（会抛错并只记 warn），要 setImmediate 推迟。onChanged 回调绝不能抛错，否则同一事件后面的投影单元（包括发往客户端 UI 的 projection 帧）会漏推。
- 绝不要用 session.append 写自定义事件类型：写入时不报错，但下次冷读或重启时持久化层拒绝解析整条日志，会话从此打不开。appendPluginRecord 也禁止仓库外插件调用。中心的数据放自己的存储。
- ctx.on('session/created') 的同步异常不会被隔离，会让 DSH 所有新建或恢复会话失败；中心如需监听，必须 try/catch。
- 非 kind:'user' 来源的唤醒有这些代价：不触发自动标题、turnOutline 的 prompt 为空、不更新 lastPromptAt（侧栏不上浮）、不发 api-session/activity、goal 工具没有人类授权、requestId 幂等不生效。反过来，经 prompt（kind 'user'）送达的消息带人类授权，自主唤醒不要用它。
- 单步内事件顺序：step/start → [system/message] → user/message… → [request/header] → [developer/message] → [request/context] → assistant/message|assistant/attempt → tool/call → [approval/*] → tool/result → step/end。user/message 在 step/start 之后；claim 产生的 agent/inbox/spliced 在 step/start 之前。
- pre-step 被拒（归档门禁或自定义预算闸）时，本轮已领取的唤醒消息被消费丢弃，不会重新排队，中心要自己记账、之后重投。运行中 inject 的消息即使错过本轮最后检查，也会因 hasPending 立刻开新一轮。
- agent/request 钩子必须加 {prepend:true}，才能压过内置 installModelSelection。覆盖一次后，会话经日志 request/header『黏』在该模型上；换供应商要丢掉继承的 reasoningEffort。钩子改道时模型收不到切换提示。
- 钩子路由与 selectModel 留下的待用选择（picked，含用户在 UI 里切的模型）不一致时，picked 永远消费不掉，并且几乎每一步都追加一条方向相反的 [model changed] 持久通知。用钩子的机器人不要再 selectModel 别的模型，或在钩子里检测 modelSelection.pending 并让位。
- 空白会话（还没 turn/start）在侧栏不显示；每个工作区默认只露 5 条；只给 cwd 建的会话进『未分组』。用 workspaceId 创建才会 attachSession。api-session/removed 也在客户端白名单里。
- whenIdle() 等的是整条驱动链（含已排队的后续轮次和维护任务），不是单轮结束。goal 武装的会话在 turn/end 之后仍可能被 goal 驱动排入下一轮。
- sessionController.cancel 固定用 {kind:'user'}。要在 turn/end.reason 里区分中心发起的中断，直接调 agent.cancel({kind:'hook', reason:'agent-hub:…'}, {keepInbox:true})，reason 必须是已定义的字符串；不带 keepInbox 会持久清空排队消息。
- compaction 服务被 preset 组 isolate，宿主插件拿不到 ctx.compaction。手动压缩走 commands.execute(agent, '/compact', [], signal)，只能在 agent 空闲时，否则返回 busy 错误结果；返回 undefined 表示该 preset 没挂 /compact。
- contextPressure 在首次请求前是空对象，之后 contextWindow 先出现、pressureTokens 后出现。占用率用 (projectedTokens ?? pressureTokens) / contextWindow，与 UI 一致。tokenUsage 是累计计费量，不能当上下文占用。启发式 4 字符/token，会低估中文增量。
- sessions.flush 返回 true 只表示有持久化监听器参与且都成功，不严格保证某个会话有写句柄。经 sessionController 创建或恢复的会话可以视为已落盘。
- uiWorkspace.openSession 会 layout.selectPanel(null)，把用户从当前全局面板切走；中心 UI 做成 shell.overlay 悬浮面板可以避免。客户端只能 $on 白名单里的宿主事件，中心自定义宿主事件不会转发，需要自建 webServer 路由、SSE 或轮询。
- 桌面里打开（follow）一个冷会话，会让宿主后台把它恢复为在线 agent 并持有写锁；外部进程驱动同一会话会被 session/writer-held 挡住。

## 未决

- 用户实际的 GLM 路由键名（zai-coding-cn / zai / 自定义）和当前全局默认模型：按纪律未读 ~/.dsh，需要在插件里运行时打印 modelCatalog() 与 agentDefaultModel.currentSelection() 确认。
- GLM 模型在 pi-ai 目录里的 contextWindow 与 maxTokens 未知，决定自动压缩阈值是否有效（W−O−65536 过小时自动压缩会被跳过）。需运行时用 ctx.llm.resolveModelInfo(glmProvider, glmModel) 查看。DeepSeek 启用官方 /models 列表时 maxTokens 可能被列表压低，阈值同样要运行时核对。
- 新建会话约 200ms 内落盘，目前由代码链路支持（工厂在发布前登记写句柄 → session/created 追加权限事件 → 200ms 批写），但未实测；以 await ctx.sessions.flush(session) 为准。
- 用 saveSelection(prev) 还原默认时，中间窗口和两次 profile 写入会不会触发设置页刷新或其他监听副作用，未实测；与用户并发改默认时的覆盖问题也未实测。
- agent/request 钩子与 picked 冲突的对策（检测 modelSelection.pending 后让位，或同步 selectModel 使二者一致）是读代码推出的，未实测；钩子改道后 {{model}} 与实际路由不一致对模型自我认知的影响也未实测。
- pi-ai 的 isContextOverflow 能否识别智谱 GLM 的上下文溢出报错（决定溢出恢复是否生效），未实测。
- 第三方插件声明 peerDependencies 后 import '@deepseek-ai/dsh-llm' 能否解析到运行时副本，未实测；手写等价的 createUserMessage 更稳。
- 第三方客户端插件在 ModuleLoader 包装下写 exports.inject = ['remote', 'uiWorkspace'] 是否和官方插件一样生效，未实测（官方 dsh-client-ui-schedule 是这么声明的）；uiWorkspace.openSession 对已归档会话的行为也未核实。
- 官方任务看板（dsh-taskboard）的 inject+prompt 组合只来自证据笔记，源码位于 ~/.dsh/profiles 内，按纪律未复核（机制本身已由 claim 顺序证实）。
