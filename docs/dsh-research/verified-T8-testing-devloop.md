# T8-testing-devloop

## [corrected] 1) 官方包怎么测：测试框架、mock ctx 的方式、官方测试支撑包在哪

结论成立：官方的测试代码和测试支撑包都没有随桌面版发布，只能照它的思路自己搭。
①安装包里 308 个包只有构建产物，找不到任何 tests/ 目录或 *.spec.* / *.e2e.* 文件（node_modules 里第三方 zod 自带的测试除外）。带 src/ 的不止 cordis，共 8 个：cordis、cordis-plugin-loader、cordis-plugin-include、cordis-plugin-timer、cordis-plugin-group、cosmokit、schemastery（TS 源码），以及 node-addon-system（C 源码）。
②官方测试支撑包都只出现在 devDependencies 里，安装包里没有对应目录：dsh-agent-loop-testkit（被 53 个包引用）、dsh-client-test-runtime（58 个；dsh-api-remote-access 的 README 说它在 Client spec 里把 remote-access 行换成全允许）、dsh-remote-mock（11 个）、dsh-loader-smoke（8 个）、dsh-llm-mock-server（4 个：dsh、dsh-llm-retry、dsh-session-log-deepseek、dsh-web-frontend）、dsh-llm-replay（只有 dsh 1 个包引用；官方包目录把它归在 test-support，作用是短路 llm/stream、用录制的会话 JSONL 重建模型输出、做免密钥快照测试）、dsh-sdk-client（只有 dsh 引用）、cordis-plugin-logger-console（只出现在 dsh-session-telemetry-otel 的 devDependencies）。
③测试框架：dsh-web-frontend 用 vitest ^4.1.11 和 playwright ^1.49.0；24 个界面包用 @testing-library/react ^16；231 个 lib 文件带 v8 ignore 覆盖率注释（由此推断用的是 vitest 加 v8 覆盖率）。README 引用的测试文件分三类：tests/*.spec.ts（单测和 Loader 组合测试）；tests/*.e2e.ts（打真实 API，需要 DEEPSEEK_API_KEY）；*.expected.e2e.ts（用构建好的 CLI 做进程级验收，不调模型）。
④官方的组合测试跑在真实 Loader 树上：headless 和 web 的 tests/startup.spec.ts 写明「在真实 Loader 树上的命令行解析」；loader-composition.spec.ts 只在 dsh-message-feedback、dsh-tool-pwsh-persistent 两个 README 里出现。外部边界做成可注入接口，测试时换成假实现（例如 dsh-native-command 的 NativeCommandRunner）。安装包里唯一的测试辅助是 dsh-tools/lib/types/testing.js 的 defineContentToolFixture，标了 @internal，dsh-tools 的 exports 也没暴露它，用不上。
⑤官方插件开发技能对测试只有一条硬要求：测试用的子进程或临时资源要放在独立目录、限时执行、等清理完成。按三层搭建是成立的：L1 测 core 纯逻辑（SimHost/FakeClock）；L2 用假 ctx 加 vitest 测插件适配层；L3 用真实 dsh 启动器、隔离的 DSH_HOME 和测试专用插件跑端到端，不花额度；最后再做少量真模型冒烟。

> 核查说明：原说法「只有 vendored 的 @deepseek-ai/cordis 带了 src/*.ts」不准确，实际有 8 个包带 src/。原说法「多处 loader-composition.spec.ts」实际只有 2 个 README 提到。另补充了 dsh-llm-replay、dsh-sdk-client、logger-console 的实际引用数，以及 verification.md:7 的官方测试纪律。其余证据行号逐条核对无误。

证据：说明：dsh-src = /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src; find dsh-src/@deepseek-ai -maxdepth 2 -type d -name src → cordis、cordis-plugin-loader、cordis-plugin-include、cordis-plugin-timer、cordis-plugin-group、cosmokit、schemastery、node-addon-system；无 tests/ 目录; dsh-src/@deepseek-ai/dsh/package.json:110（devDependencies 起始）、121、137、139、140、144; dsh-src/@deepseek-ai/dsh-session-telemetry-otel/package.json:45-46（logger-console 位于 devDependencies）; dsh-src/@deepseek-ai/dsh-tools/package.json:16-32（exports 不含 testing）、71；lib/types/testing.js:1-24（@internal）; dsh-src/@deepseek-ai/dsh-web-frontend/package.json:25,29,30,41,49,54; dsh-src/@deepseek-ai/dsh-client-ui-schedule/package.json:58,72; dsh-src/@deepseek-ai/dsh-api-remote-access/README.zh.md:65; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:474-478; dsh-src/@deepseek-ai/dsh-headless/README.zh.md:114-120；dsh-web-app/README.zh.md:125；dsh-message-feedback/README.zh.md:101；dsh-tool-pwsh-persistent/README.zh.md:79; dsh-src/@deepseek-ai/dsh/README.zh.md:64；dsh-llm-deepseek/README.zh.md:211；dsh-native-command/README.md:44; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/verification.md:7（测试子进程/临时资源：独立目录、限时、等待清理）; grep 统计：231 个 lib/*.js 含 v8 ignore；24 个 package.json 含 @testing-library/react

## [corrected] 1) 不启动 DSH 时，插件适配层怎么 mock ctx（L2 单测）

做法成立：给 apply 传一个只实现插件真正用到那几样的假 ctx，用项目已装的 vitest ^3.2.4 跑。用户旧插件 dsh-net-tuning 的 node --test 测试就是这么做的，假 ctx 只给了 logger 和 effect。但原假 ctx 有 4 处和真 cordis 的语义不一致，要按下方代码改：
①缺 provide。第 14 题的宿主骨架会调 ctx.provide('agentHub', …)，原假 ctx 会直接报 TypeError。真实语义：同一作用域里同名服务重复 provide 会抛错（service "x" has been registered at <…>）；provide 返回 disposer，插件卸载时注销。
②异步 effect。真 cordis 的 effect 回调可以返回：清理函数、清理函数的同步或异步可迭代对象、Promise<清理函数>、null/undefined；其他形状抛 TypeError('Invalid effect')。原假 ctx 会丢掉 Promise 里的清理函数，对非法形状也不报错。
③重复释放。真 effect、on、provide 返回的 disposer 只生效一次，手动调过以后插件卸载不会再调。原假 ctx 在 dispose() 时会再调一遍，导致「注销次数 = 注册次数」的断言误报。
④「回调抛错就会让进程退出」的理由要改。真实 DSH 里，session/event 监听抛错或返回被拒的 Promise，会被 dsh-session 逐个兜住，只记一条 warn；webServer 路由处理器抛错或被拒，会被 host-webserver 兜住，返回 400 并记 warn；llm/adapters-updated 监听也有兜底。真正致命、会让整个进程以 1 退出的是：定时器回调、流的 'data' 等同步回调里的未捕获异常，以及脱离 apply 的 Promise 没人处理的拒绝。所以 L2 仍然要测「回调里的错不外泄」（这是 AGENTS.md 红线第 5 条），但不能写成「否则 session/event 会让进程退出」。
其余真实语义核对无误：
- ctx.on(name, listener, options?) 返回取消函数，随 fiber 卸载自动取消。
- ctx.waterfall 的最后一个参数是 next，监听者不调 next 就等于否决。它还有 ctx.waterfall(thisArg, name, …) 的写法，llm/stream 就是这样派发的。
- ctx.get(name) 只返回提供者已激活的服务。
- ctx.inject(deps, cb) 等价于 ctx.plugin({inject, apply: cb, name: cb.name})，cb 收到 (ctx, config)。
- ctx.logger('名字') 取命名 logger；直接调 ctx.logger.info() 时用当前 fiber 名。
L2 该断言的内容：
(a) 卸载后监听数归零，所有 effect/provide 的 disposer 都调过而且只调一次。
(b) 注册到别的 context 上的东西（尤其是机器人的 agent.ctx），插件卸载时不会自动清掉。官方要求把这些 disposer 同时存进插件自己的 effect（practices.md:8、19），L2 要测：插件卸载后，挂在 agent.ctx 上的工具和监听也被撤掉了。
(c) 回调里抛错不外泄。
(d) HostPort 各方法调对了 ctx 服务，参数字段也对。
假 ctx 测不到、要留给 L3 的：cordis 代理带来的 this 绑定，以及「服务方法里调的 ctx.effect 自动挂到调用者 fiber」；inject 的等待与重启；服务隔离；waterfall 的真实顺序；真实服务签名随版本漂移。
另外，项目路径含空格，若用 node --test，要用带引号的 glob，不能直接给目录。

```
// ===== packages/plugin/test/helpers/fake-ctx.ts =====
// 作用：不启动 DSH，造一个「够插件 apply 跑起来」的假 ctx（L2 单测用）。
// 语义对齐 @deepseek-ai/cordis 4.0.5：
//  - effect 回调可返回：清理函数 / 清理函数的可迭代对象 / Promise<清理函数> / null|undefined；其他形状真 cordis 抛 TypeError('Invalid effect')
//  - effect、on、provide 返回的 disposer 只生效一次；手动调过之后插件卸载时不会再调
//  - provide 同名重复提供会抛错；get 取不到返回 undefined；waterfall 最后一个参数是 next
type Disposer = () => unknown
type Listener = (...args: any[]) => unknown

export function createFakeCtx(services: Record<string, unknown> = {}) {
  const live = new Set<Disposer>()                    // 还没执行的清理函数（Set 保持登记顺序）
  const listeners = new Map<string, Listener[]>()     // 事件名 -> 监听函数
  const logs: Array<{ level: string; name: string; args: unknown[] }> = []
  const named = (name: string) => ({
    info: (...args: unknown[]) => { logs.push({ level: 'info', name, args }) },
    warn: (...args: unknown[]) => { logs.push({ level: 'warn', name, args }) },
    error: (...args: unknown[]) => { logs.push({ level: 'error', name, args }) },
    debug: (...args: unknown[]) => { logs.push({ level: 'debug', name, args }) },
  })
  // 真实 ctx.logger 既能 ctx.logger('名字') 取命名 logger，也能直接 ctx.logger.info()
  const logger: any = Object.assign((name = 'fiber') => named(name), named('fiber'))

  // 登记一个清理函数，返回「只执行一次、执行后自动出列」的包装（对齐真 cordis 的幂等 disposer）
  const track = (d: Disposer): Disposer => {
    let done = false
    const once = () => { if (done) return; done = true; live.delete(once); return d() }
    live.add(once)
    return once
  }
  // 按真 cordis 的规则收集 effect 回调的返回值
  const collect = (out: unknown): Disposer[] => {
    if (out == null) return []
    if (typeof out === 'function') return [track(out as Disposer)]
    if (typeof (out as any).then === 'function') {    // 异步 effect：拿到清理函数后再登记
      void (out as Promise<unknown>).then((d) => { if (typeof d === 'function') track(d as Disposer) })
      return []
    }
    if (typeof (out as any)[Symbol.iterator] === 'function') {
      const list: Disposer[] = []
      for (const d of out as Iterable<unknown>) {
        if (typeof d === 'function') list.push(track(d as Disposer))
        else if (d != null) throw new TypeError('Invalid effect')
      }
      return list
    }
    throw new TypeError('Invalid effect')              // 与真 cordis 一致：返回普通对象/数字等直接报错
  }

  const ctx: any = {
    ...services,                                       // 让 ctx.agents、ctx.tools 这种直接取服务的写法可用
    logger,
    logs,
    get: (name: string) => services[name],
    provide(name: string, value: unknown) {
      if (services[name] !== undefined) throw new Error(`service "${name}" has been registered`)
      services[name] = value
      ctx[name] = value
      return track(() => { delete services[name]; delete ctx[name] })
    },
    effect(execute: () => unknown) {
      const list = collect(execute())
      return () => { for (const d of [...list].reverse()) d() }
    },
    on(name: string, cb: Listener) {
      const arr = listeners.get(name) ?? []
      arr.push(cb)
      listeners.set(name, arr)
      return track(() => { const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1); return i >= 0 })
    },
    emit(name: string, ...args: unknown[]) { for (const cb of [...(listeners.get(name) ?? [])]) cb(...args) },
    waterfall(name: string, ...args: unknown[]) {
      const inner = args.pop() as Listener             // 最里层的默认行为
      const chain = [...(listeners.get(name) ?? [])]
      const next = (): unknown => (chain.shift() ?? inner)(...args, next)
      return next()
    },
    inject(deps: string[], cb: (c: any, config?: unknown) => unknown) {
      if (deps.every((d) => services[d] !== undefined)) cb(ctx, undefined)   // 依赖齐了才挂载子功能
    },
    listenerCount: (name: string) => listeners.get(name)?.length ?? 0,
    liveDisposers: () => live.size,                     // 卸载后应为 0
    async dispose() { for (const d of [...live].reverse()) await d() },   // 模拟插件卸载：逆序清理
  }
  return ctx
}

// ===== packages/plugin/test/host-lifecycle.test.ts（示例）=====
import { describe, it, expect, vi } from 'vitest'
import { createFakeCtx } from './helpers/fake-ctx'
import { apply } from '../src/host/index'            // 被测：宿主半边入口（路径以实际为准）

describe('宿主半边：生命周期与兜底', () => {
  it('卸载后不留监听、不留工具、不留服务', async () => {
    const unregister = vi.fn()
    const tools = { register: vi.fn(() => unregister) }
    const ctx = createFakeCtx({ tools, agents: { create: vi.fn(), get: vi.fn() } })
    apply(ctx, {})
    await ctx.dispose()
    expect(ctx.listenerCount('session/event')).toBe(0)
    expect(ctx.liveDisposers()).toBe(0)
    expect(unregister).toHaveBeenCalledTimes(tools.register.mock.calls.length)   // 每个注册恰好注销一次
    expect(ctx.get('agentHub')).toBeUndefined()
  })
  it('事件回调里抛错要自己兜住（AGENTS.md 红线 5）', () => {
    const ctx = createFakeCtx({ tools: { register: () => () => {} }, agents: { get: () => { throw new Error('boom') } } })
    apply(ctx, {})
    expect(() => ctx.emit('session/event', {}, { type: 'turn/end', data: { reason: { kind: 'completed' } } })).not.toThrow()
  })
})
```

> 核查说明：对原代码和原说法的改正：(1) 原假 ctx 没有 provide，和第 14 题的骨架冲突；(2) 原 effect 只处理函数和同步可迭代对象，丢掉 Promise 里的清理函数，也不报非法形状；(3) 原 disposer 不是幂等的，dispose() 会重复调用；(4) 原测试注释「否则真实 DSH 会整进程退出」对 session/event 不成立，dsh-session 会兜底、只记 warn。补充：注册在 agent.ctx 上的东西要插件自己管 disposer（practices.md:19）。

证据：dsh-src/@deepseek-ai/cordis/src/fiber.ts:356-399（_execute：函数/nullable/then/同步与异步可迭代，其余 TypeError('Invalid effect')）、402-442（effect 文档；dispose 幂等 if (disposing) return）; dsh-src/@deepseek-ai/cordis/src/reflect.ts:233-243（get 只返回 ACTIVE 实现）、277-305（provide：重复注册抛错、返回 disposer）; dsh-src/@deepseek-ai/cordis/src/events.ts:165-175（首参为对象时作 thisArg）、194-196（emit 不捕获监听异常）、234-243（waterfall）、288-302（on 作为 effect 注册）; dsh-src/@deepseek-ai/cordis/src/registry.ts:164-176、300-302（inject = plugin({inject, apply, name: callback.name})）；logger.ts:252-262; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1227-1240（invokeContainedSessionObservers：throw/reject 只记 warn）、1579-1593（commit 时按监听逐个兜底）; dsh-src/@deepseek-ai/dsh-host-webserver/lib/index.js:378-404（handle(req,res).catch → warn + 400）; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:1819-1833（llm/adapters-updated 监听被兜住）; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:109-110；lib/index.js:4216-4253（installFailLoud：unhandledRejection/uncaughtException → exit 1）; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:8、19（agent.ctx 上的注册需插件自留 disposer）; /Users/bytedance/Documents/DSHarness Doc/dsh-net-tuning/test/apply.test.mjs:14-27; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/package.json（vitest ^3.2.4）；agent-hub/AGENTS.md:23（不自行联网装依赖）、35（红线 5：回调 try/catch）; /Users/bytedance/.claude/skills/drive-dsh/references/gotchas.md 第 2 条

## [corrected] 1) 有没有能在进程内启动最小 Cordis/DSH 应用来测插件的辅助工具

没有现成的测试辅助，有三条路，按推荐度排：
(a) 推荐：把 dsh 启动器本身当成「最小 DSH 应用」。用隔离的 DSH_HOME 加现成 profile（web / headless），或者用 dsh plugin --profile <自定义名> add … 建一个只含 dsh-base 的自定义 profile（没有 runner，进程靠 appExit 结束；这一条未实测），再用 --patch 注入测试插件。启动器在挂载插件树之前，向根 ctx 提供三个服务：
- cmdlineArgs：{ get(): string[] }，本次应用参数的冻结快照。
- appExit：函数 (code) => void。
- appReady：{ onReady(cb): () => void }。整棵树启动完、必需行审计通过后才 commit；已经 commit 过的话会立即同步回调。
测试插件在 appReady 之后驱动被测插件，最后调 appExit(0 或 1)。
appExit 的真实语义（改正）：appExit(code) 先在 5 秒上限内释放整棵树。释放成功后只设置 process.exitCode = code，要等事件循环自然清空才退出。这时被测插件如果泄漏了没登记到 ctx.effect 的定时器或句柄，进程会一直挂着。这可以当泄漏探测器用，但外部脚本必须自带超时。只有释放失败或超过 5 秒，才会 process.exit(code) 强退。另外，SIGTERM 被当成正常关闭，以 0 退出；SIGINT 以 130 退出；第二次收到信号立即强退。
(b) 可选（未实测）：用真 cordis Context 做进程内集成测试。cordis README 的标准写法是 new Context() → await root.plugin(插件) → await root.fiber.dispose()；假服务用一个小插件里的 ctx.provide(name, value) 提供。@deepseek-ai/cordis 4.0.5 只在 app.asar 里（已核对 asar 目录表），项目 node_modules 里没有任何 @deepseek-ai 包。官方技能原话是普通 shell、node、pnpm 都读不了 app.asar，只有 DSH 自带 Electron 的 Node 模式（ELECTRON_RUN_AS_NODE=1，runtime/cli/bin/dsh 就是这样启动 CLI 的）才能读。cordis 的 lib 还会 import @deepseek-ai/cosmokit（同样在 asar 里）。
(c) 不推荐：调 dsh-app-boot 的 boot(binName, absoluteConfigPath, patches, prepare?, bareModuleBaseUrl?)。README 说这些直接配置的 helper 只留给低层嵌入方和测试，但用它要自己装 runtime resolution、provideCmdline、installFailLoud、关停控制器，成本高，也会随版本漂移。

> 核查说明：改正：原说法「appExit 走有界关闭：5 秒内释放整棵树后退出」只对了一半。5 秒上限只管释放阶段，正常释放后并不强制退出（completeOnce 只写 process.exitCode），句柄泄漏会让进程挂住。补充：SIGTERM→0、SIGINT→130；只含 dsh-base 的自定义 profile 可作更轻的宿主冒烟载体（未实测）；官方技能关于 app.asar 不能被普通 node 读取的原话出处。

证据：dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:12（PROCESS_SHUTDOWN_TIMEOUT_MS=5000）、21-71（shutdown 正常路径 completeOnce 只写 process.exitCode；dispose 失败/超时才 forceExit）、87-108（appReady.onReady）、273-285（SIGTERM→interrupt(0)，SIGINT→interrupt(130)）、286-288（installFailLoud）、302-314（prepare 中 provideCmdline，树结算后 appReady.commit）; dsh-src/@deepseek-ai/dsh-cmdline/lib/index.js:27-32（cmdlineArgs/appExit/appReady；appReady 仅在 host.ready 存在时提供）；README.zh.md:32-37; dsh-src/@deepseek-ai/cordis/README.md:45-58；cordis/src/reflect.ts:277-305；cordis/lib/index.js:1（import @deepseek-ai/cosmokit）; app.asar 头目录表（只读解析）含 dsh/node_modules/@deepseek-ai/cordis/lib/index.js、src/*.ts 与 dsh-desktop-host/lib/cli.js; /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh（ELECTRON_RUN_AS_NODE=1 exec …/MacOS/DeepSeek Harness --expose-internals …/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js）; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md:38（Desktop 中 app.asar 只有 Host 进程自己的文件读取能打开，shell/node/pnpm 都会失败）; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:12；lib/index.js:4507-4530（boot 实现）；dsh-app-boot/lib/index.js:1065-1071（非模板名 profile 不存在时提示用 dsh plugin --profile <name> add 创建）; dsh-src/@deepseek-ai/dsh-headless/lib/index.js:374-385（官方 runner 用 ctx.get('appExit') 结束进程）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/node_modules 下无 @deepseek-ai

## [corrected] 2) 有没有现成的假/可编程 LLM 供应商

没有。安装包里注册模型路由的只有三行适配器：
- 行 id llm-deepseek（包是 @deepseek-ai/dsh-llm-deepseek-api-key）：路由 deepseek-official，默认模型 deepseek-flash。
- 行 id llm-deepseek-account：路由 deepseek-account。
- 行 id llm-pi-ai：休眠挂载，只有 settings 里配了 providers 才注册路由。
全包没有假模型实现；dsh-llm-replay 和 dsh-llm-mock-server 只在 devDependencies 里。
可用的接缝有三个（源码已确认）：
①ctx.llm.registerAdapter(providers: string[], adapter)，推荐用这个。一次注册一条或多条路由，全有或全无：providers 为空抛 INVALID_ADAPTER；路由已被别人注册抛 DUPLICATE_ADAPTER；providerInfo(p).id 必须等于 p 且 name 非空，否则抛 INVALID_ADAPTER。返回一个 handle，调用它就注销，另带 handle.replace(nextProviders)；随调用者插件的 fiber 一起释放。官方 llm-deepseek-api-key 就是 inject ['llm'] 之后在 apply 里注册的。
②llm/stream waterfall。LlmRuntime 的 stream 和 prepareCall 之后的派发，都经过 ctx.waterfall(this, 'llm/stream', options, next)；不负责的监听者必须 return next()。但有两个限制：被选的路由必须已经注册，否则 registration() 抛 NO_ADAPTER；而且 agent loop 会先走 llm.prepareCall，也就是先调真实适配器的 prepareCall（DeepSeek 会解析连接和模型目录）。所以单用 waterfall 不能保证零网络。
③DEEPSEEK_BASE_URL：指向本机假服务器。它必须在启动环境里 export，不能写进 .env，见第 6 题。
配合手段：
- agent-default-model 的 provider/model 只是配置值，该服务不校验目录成员资格。用 --patch 改成假路由即可，但 patch 会整段替换 config，两个字段都要写。
- 会话标题生成在省略 provider/model 时继承主请求的路由，所以假模型要能回答不带工具的辅助请求；或者在测试 patch 里写 - id: session-title-llm / disabled: true（官方 SDK 组合就是这么写的）。

> 核查说明：改正和补充：原文「llm-deepseek-api-key、llm-deepseek-account 两行」里，前者是包名，行 id 实际是 llm-deepseek（patch 写错 id 只会告警 entry not found 并跳过）。dsh-llm-replay 只被 dsh 一个包引用。补充 registerAdapter 的校验错误码，以及 waterfall 方案要求路由已注册、无法绕开真实 prepareCall。

证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:88-94（agent-default-model）、128-136（llm-pi-ai 休眠）、521-529（行 id llm-deepseek → 包 dsh-llm-deepseek-api-key；行 id llm-deepseek-account）; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:1842-1880（registerAdapter/prepareRoutes 校验与错误码）、2220-2266（prepareCall 先调 adapter.prepareCall；registration 缺失 → NO_ADAPTER）、2393-2398（stream 经 waterfall）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1084、1201（agent loop 先 prepareCall，再 preparedCall.stream）; dsh-src/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js:45-47、111-148; dsh-src/@deepseek-ai/dsh-agent-default-model/README.zh.md:41-57; dsh-src/@deepseek-ai/dsh-session-title-first-prompt-llm/README.zh.md:36；dsh-sdk-app/cordis.patch.yml:8-9; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:474-478；cordis-plugin-development/references/practices.md:16; dsh-src/@deepseek-ai/dsh/package.json:137,139；dsh-llm-retry/package.json:58；dsh-session-log-deepseek/package.json:55；dsh-web-frontend/package.json:29（均在 devDependencies）

## [corrected] 2) 推荐做法：自写进程内假模型供应商插件，确定性跑完「唤醒→工具调用→交账」

做法成立：写一个测试专用插件，用 ctx.llm.registerAdapter 注册一条叫 hub-fake 的路由，按剧本吐出 StreamChunk。进程内、零网络、零额度、结果确定。
已核对无误的部分：
- 适配器方法齐全：providerInfo、providerRetryPolicy、imageRequestPricing、imageRequestTarget、listModels、resolveModel、prepareCall。LlmRuntime 只调 adapter.prepareCall(p, m, signal) 拿 {model, stream}，基类默认的 prepareCall 才会转调 this.stream。
- resolveModel 的返回值校验：provider 和 id 必须原样返回，name 非空；context.contextWindow 是正整数；defaultMaxTokens 是正的安全整数；reasoning.efforts 非空，每项 id、name 非空且不重复；defaultEffort 必须在列表里。
- chunk 规则：类型有 block-start、text-delta、reasoning-delta、tool-call-delta、block-end、usage、finish。tool-call-delta 的 id、argumentsDelta 必须是字符串，name 可选；chunk 必须能无损 JSON 序列化；finish 为 max-tokens 时工具调用会被丢掉；适配器抛错会变成终止 finish {kind: 'error' | 'aborted', failure}。
- 原 fake-llm.mjs 的主体可以照用。
有三处必须改：
①剧本里 hub_commit 的参数必须通过 core 的 CommitInputSchema。它是严格对象，12 个键全部必填，可以为空的也要显式写 null：outcome、summary、worldChanges、evidence、verification{level, notCovered}、blocker、nextThink{mode, reason，以及和 mode 对应的 at/afterMinutes/onEvent 之一}、ownerQuestion、reply、report、importance（1–10 整数）、proposals。原剧本只给了 {summary}，会被判为参数错误 → tool/result 的 isError 为 true → 冒烟一定失败。另外，主人消息唤醒的回合 reply 必填，而 pokeBot 就等于发消息，所以剧本里统一带上 reply。
②测试夹具目录自带的 package.json 必须有 name 字段。client-modules 找「离该行最近的 package.json」时，会跳过没有字符串 name 的清单，继续往上找到 dsh-agent-hub 的 package.json，照样触发「同一包两个来源」。
③efforts 列表要覆盖会话实际会请求的档位。DeepSeek 只认 off/low/high/max，默认 high；如果请求的档位不在列表里，同样会报 UNSUPPORTED_REASONING_EFFORT。原来的 ['off','low','high','max'] 正好对齐。
取步法（数最后一条 user 消息之后有几条 assistant 消息）可以用。如果测试里会插入额外的 user 角色消息，计数会被重置，那时改成按 options.sessionId 计数（DeepSeek 适配器也会读 options.sessionId 和 options.purpose）。

```
# ===== packages/plugin/test/e2e/package.json =====（必须有 name，且不声明 dsh.client）
{ "name": "dsh-agent-hub-e2e-fixtures", "private": true, "type": "module" }

# ===== packages/plugin/test/e2e/fake-llm.patch.yml =====
# 用法：dsh --profile <p> --patch <本文件> …；name 的 ./ 路径相对本文件
- insert:
    - id: hub-fake-llm
      name: ./fake-llm.mjs
      config:
        provider: hub-fake
        model: scripted
        script:
          # 第 1 次调模型：调用 hub_commit。参数必须是完整的 Commit 输入（严格对象，12 个键都要有）
          - tool: hub_commit
            args:
              outcome: no_change              # no_change | progress | done | blocked | needs_owner
              summary: 冒烟测试交账
              worldChanges: []
              evidence: []
              verification: { level: none, notCovered: 冒烟测试不做验证 }   # level: program | agent | e2e | none
              blocker: null                   # outcome=blocked 时必填
              nextThink: { mode: auto, reason: 冒烟测试结束 }   # auto 模式不能带 at/afterMinutes/onEvent
              ownerQuestion: null             # outcome=needs_owner 时必填
              reply: 收到，冒烟测试已交账       # 主人消息（含 pokeBot）唤醒的回合必填，统一带上
              report: null
              importance: 1                   # 1–10 整数
              proposals: []
          # 第 2 次调模型（拿到工具结果之后）：回一句话，回合以 completed 结束
          - text: 已交账，结束本轮。
# 新会话默认走假模型（patch 会整体替换该行 config，两个字段都要写）
- id: agent-default-model
  config:
    provider: hub-fake
    model: scripted
# 可选：不想让标题生成也打到假模型，就关掉这一行
# - id: session-title-llm
#   disabled: true
```

> 核查说明：改正：(1) 原剧本 args 只有 summary，会被 packages/core/src/commit/schema.ts 的严格 schema 拒绝；而且主人消息唤醒时 reply 必须非空（commit/process.ts:28）。(2) 补充：夹具的 package.json 必须带 name（client-modules 的 nearestPackage 只认有字符串 name 的清单）。(3) 补充：efforts 要覆盖实际请求的档位。适配器方法和 chunk 规则的行号逐条核对无误。

证据：dsh-src/@deepseek-ai/dsh-llm/lib/index.js:1665-1755（LlmAdapter 方法与默认实现）、2086-2101（listModels 校验）、2119-2163（normalizeModelInfo）、2182-2207（UNSUPPORTED_REASONING_EFFORT）、2220-2260（prepareCall）、2309-2381（adapterStream 兜底）、2401-2414（adapterFailureChunk）; dsh-src/@deepseek-ai/dsh-llm/lib/types/assembler.js:33-84、116-138；assistant-stream.js:20-25、38-111；message.js:53-100; dsh-src/@deepseek-ai/dsh-llm-deepseek/lib/index.js:1718-1724（DeepSeek 只认 off/low/high/max，默认 high）、2241-2242（options.sessionId / options.purpose）; dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:762-809（nearestPackage 只接受带字符串 name 的 package.json）、890-896（多来源报错）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/packages/core/src/commit/schema.ts:10-33（CommitNextThinkSchema 与 CommitInputSchema）；model/wake.ts:30-44（strictObject，全部字段必填）；model/enums.ts:47、59、149、155；commit/process.ts:28（owner_message 唤醒必须 reply）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/docs/build-spec.md:578-585（10.2 hub_commit 校验要点）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:3970-3978（insert 的 ./ 路径相对 patch 文件转 file URL）

## [corrected] 2) 备选黑盒法：本机假 Messages 服务器 + DEEPSEEK_BASE_URL（走真实 DeepSeek 适配器）

可行，核对无误。
端点：baseURL 的取值顺序是 配置里的 baseURL → 启动环境快照里的 DEEPSEEK_BASE_URL → https://api.deepseek.com/anthropic。请求发到 POST {root}/messages；root 的路径不以 /v1 结尾时会自动补 /v1，所以 http://127.0.0.1:18080/anthropic 实际打的是 /anthropic/v1/messages。
请求头：x-api-key、content-type: application/json、accept: text/event-stream、anthropic-version: 2023-06-01，另有 x-deepseek-harness-user-id；带会话时有 x-deepseek-harness-session-id；压缩请求带 x-deepseek-harness-compact: 1；有时带 anthropic-beta。fetch 用 redirect: 'error'。
请求体：{model, stream: true, messages, max_tokens, thinking: {type}, output_config?: {effort}, system?, temperature?, stop_sequences?, tools?: [{name, description, input_schema, defer_loading?}]}，再加上扩展字段 dsh_session_log、dsh_plugin_packages。工具结果放在 user 消息的 tool_result 块里回传。只有官方 origin 且使用内置模型目录时才去拉 /models 列表。loopback 地址永远绕过代理。
SSE 规则：
- 必须先发 message_start，其中 message.usage 必须是对象。
- content_block_start 支持 text、thinking、tool_use；tool_use 的 id、name 非空，input 是对象。
- delta 支持 text_delta、thinking_delta、signature_delta、input_json_delta。
- stop_reason 只认 end_turn、stop_sequence、tool_use、max_tokens。
- 如果写了 event: 行，它必须等于 data 里的 type；type 为 error 的事件直接按提供方错误处理。
- 一个内容块都没有却 end_turn → EMPTY_RESPONSE；工具参数最终必须能解析成 JSON 对象；没收到 message_stop 流就结束 → STREAM_CLOSED。
原假服务器代码符合以上规则。
必须补上的限制：DEEPSEEK_BASE_URL 属于启动器规定的「只能来自启动环境」的变量，写进 <当前目录>/.env 或 $DSH_HOME/.env 都会让启动器直接抛错退出，必须 export。DEEPSEEK_API_KEY 不在这个名单里：headless 从启动环境、<当前目录>/.env、$DSH_HOME/.env 取；web 先查凭据库，再回落到这些层。密钥只做格式校验（非空、能放进 HTTP 头）。缺点：多一个进程、占一个端口。

> 核查说明：补充：原文只说「导出」，没写清 DEEPSEEK_BASE_URL 是启动器的 bootstrap-only 变量（app-boot 的 BOOTSTRAP_NAMES），放进 .env 会让启动失败。另补充了完整的请求头和字段列表，以及 STREAM_CLOSED。其余核对无误。

证据：dsh-src/@deepseek-ai/dsh-llm-deepseek/lib/index.js:346-349（PUBLIC_BASE_URL；BASE_URL_ENV）、441-443（baseURL 取值与校验）、577-580（messagesApiRoot 补 /v1）; dsh-src/@deepseek-ai/dsh-llm-deepseek/lib/index.js:1718-1742（请求体）、2227-2244（POST …/messages 与全部请求头）; dsh-src/@deepseek-ai/dsh-llm-deepseek/lib/index.js:1798-1812（SSE：event 名须等于 data.type；error 事件）、1846-1933（块与 delta、stop_reason）、1939-2030（message_start 起、EMPTY_RESPONSE、JSON 对象参数、STREAM_CLOSED）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:3610-3667（BOOTSTRAP_NAMES 含 DEEPSEEK_BASE_URL@3649；前缀 DSH_/XDG_/DYLD_/BASH_FUNC_）、3688-3722（.env 设置这些名字即抛错）; dsh-src/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js:9-13、29-42、50-64; dsh-src/@deepseek-ai/dsh-llm/lib/index.js:1659-1663（assertUsableApiKey）; dsh-src/@deepseek-ai/dsh-headless/README.zh.md:55；dsh-base/cordis.patch.yml:113-116; dsh-src/@deepseek-ai/dsh-http-proxy/README.zh.md:52; dsh-src/@deepseek-ai/dsh-deepseek-llm-api-extensions/README.zh.md:30

## [confirmed] 3) dsh --profile headless 怎么带上一个本地插件跑（--patch 还是 plugin add）

核对无误。两种方式用途不同，对同一个插件只选一种；同时用会出现两个实例：同名服务 provide 抛错、工具重复注册，在 web 里还会触发 client-modules 的「同一包两个来源」，导致启动失败。
(A) 持久安装：dsh plugin --profile headless add link:<插件目录>。
- CLI 把参数原样转给安装包自带的 pnpm（Desktop 的 CLI 载体传入 primary-runtime 里的 pnpm），在 $DSH_HOME/profiles/headless 里执行。
- 该 profile 第一次使用时按模板初始化：package.json 的 dsh.profile.bundles 为 ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']；cordis.patch.yml 是带注释头的 []；pnpm-workspace.yaml 含 packages: [.]、nodeLinker: hoisted、autoInstallPeers: false。
- 安装后按插件 package.json 顶层的 engines.dsh（没写就看 @deepseek-ai/dsh* 的 peer 范围）检查版本。不兼容会回滚 manifest 和 lockfile、以退出码 1 结束，并打印 allow-version 命令。
- 包声明了 dsh.bundle.patch 时，会把包名追加进 dsh.profile.bundles；没声明时警告「installed as a plain dependency, not a profile layer」，不会加载。link: 的相对路径以执行命令的目录为基准。
- 卸载：dsh plugin --profile headless remove <包名>。
- 名字不在模板里的自定义 profile，用 dsh plugin 初始化时只有 dsh-base。
(B) 临时挂载：dsh --profile headless --patch <overlay.yml> …。
- overlay 是 YAML 数组。insert 里的 name 可以写绝对路径，或以 ./ ../ 开头、相对 overlay 文件的路径，都会被转成 file URL（路径含空格没问题）。
- 「- id: <行 id>」加 config、disabled 等键，会整键替换目标行；config 是整体替换，不合并。非 insert 补丁里的 name 字段是断言，不匹配就跳过。
- 插件包自带的 cordis.patch.yml 在这种方式下不生效，要在 overlay 里自己写行。
- overlay 文件不存在会直接启动失败；overlay 是启动时的快照，不会热重载。
层叠顺序（后者覆盖前者）：各组合包的 patch → profile 自己的 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → 各个 --patch（按命令行顺序）→ 遥测开关。profile 或 home 的 cordis.patch.yml 如果是空文件或只有注释，会导致启动失败，必须写 []。
参数顺序：启动器只认 --profile、--patch、--from-default-profile、--dump-config、--dump-default-config、--dump-config-schema、-V/--version，遇到第一个不认识的参数，后面全部交给应用。
headless 组合关掉了 hmr、credentials、authorization、deepseek-account 四行；任务是一个位置参数（或 stdin），跑完就退出，最后一轮 completed 退出码为 0，否则为 1。base 和 headless 里没有 webServer、schedule、sessionController、workspaceRegistry、agentPresets 这些服务（都只在 dsh-web-app 组合里）；插件若把它们写进 inject，在 headless 里会一直 pending。

> 核查说明：原结论核对无误。补充的细节：initProfile 实际写入的文件内容；patch 文件为空或只有注释会启动失败；compatibility 拒绝时以退出码 1 结束并回滚。

证据：dsh-src/@deepseek-ai/dsh/README.zh.md:9-20、37、41-48; dsh-src/@deepseek-ai/dsh/lib/bin.js:35-37、59-92、101-137; dsh-src/@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:63-99；dsh-desktop-host/lib/cli.js:94-107; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:71-76、96-124、534-559（不兼容→restore 并以 1 结束）、591-602; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:546-557、570、593-627（initProfile 三个文件的实际内容）、276-299、1065-1071、3961-3978; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:50、60-65（空或仅注释的 patch 文件导致启动失败）; dsh-src/@deepseek-ai/cordis-plugin-include/lib/index.js:56-104; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:236-247、290-301；dsh-app-boot/lib/index.js:1105-1135（readProfilePatches 的层顺序与遥测补丁）; dsh-src/@deepseek-ai/dsh-headless/cordis.patch.yml:32-43；README.zh.md:36、42-48、52-70、106-108; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:91、121、139、179、591；各包 super(ctx, …) 服务名：schedule、sessionController、workspaceRegistry、agentPresets、webServer

## [corrected] 3) 怎么确认插件被加载（--dump-config、日志在哪、诊断文本长什么样）

按「配置 → 导入 → 激活 → 行为」四层确认，方法成立，有三处改正。
①配置层：--dump-config 打印组合后的 YAML，注释写明每行来自哪一层、被哪些层改过；没匹配上的 patch 会在 stderr 报 dsh: [<层标签>] patch: entry "<id>" not found（层标签是包名或 patch 文件的绝对路径）。改正：它不求值 !!js（显示的是原表达式），而且不是纯只读，会按模板初始化 profile，并重写 profile 目录里的 cordis.yml。版本被拒的行仍会出现，被跳过的组合包一行都没有。--dump-default-config 不能带 --patch；三种 dump 互斥，也不能带应用参数。
②导入层：--dump-config-schema 会真的 import 组合里每个插件模块（会执行模块顶层代码，只对信任的插件用）。收集不完整时退出码为 1，诊断写到 stderr，可以直接用 && 判断。
③激活层（启动时的 stderr）：
- 组合包被跳过：dsh: skipping profile bundle "<包名>": <原因>
- 版本被拒：dsh: disabling profile plugin row "<id>": <原因>
- 可选行没起来：dsh: warning: N entry/entries did not activate，下面每行是「<id> (<name>): <阶段>: <错误>」或「<id> (<name>): pending (waiting for service/services: a, b)」
- 必需行失败：dsh: startup failed: N required plugin(s) did not activate，后面是失败和等待的分组列表；完整诊断写到 $DSH_HOME/logs/startup-<ISO时间>-<uuid>.log（目录权限 0700、文件 0600，文件开头警告里面可能含配置或凭据值）。
- 安装失败：dsh: plugin command failed; diagnostics: <profile>/.plugin-manager/logs/operation-*/pnpm.log
④行为层：产品 profile 不给 ctx.logger 挂控制台输出。改正：cordis 内置的 ctx.logger.buffer（最近 1000 条）只收得到 error 和 info。原因是内置缓冲 exporter 没设 levels，阈值取 logger.level ?? 1（INFO），而 WARN=2、DEBUG=3 会被过滤掉；app-boot 自己为了收 warn，专门另挂了一个 levels: {default: 2} 的 exporter。所以冒烟跑者读 buffer 抓不到 warn，要看 warn/debug 必须自己挂 exporter，比如原方案的 dev-log-stderr，用 levels: {default: 3}，那段代码正确。诊断一律写 stderr：headless 的 stdout 只放最终答案或 --json 事件流，sdk/acp 的 stdout 是协议通道。Web 里另有「设置 → 插件 → 插件列表」显示同步失败并可重试；浏览器控制台出现 slot entry crashed in '<slot>' 表示界面组件崩了。cordis_inspect_list / cordis_inspect_query 两个工具只在 web 的 cordis 预设里有。

> 核查说明：改正：(1) 原说法「logger 自带最近 1000 条内存缓冲，测试插件可以读它」没说清缓冲只收 error/info，warn/debug 默认被过滤；(2) 补充：--dump-config 不求值 !!js，且会初始化 profile、改写 cordis.yml；(3) 补充：--dump-config-schema 收集不完整时退出码为 1。其余诊断文本和行号核对无误。

证据：dsh-src/@deepseek-ai/cordis/src/logger.ts:22-27（ERROR=0 INFO=1 WARN=2 DEBUG=3）、141-160（targetLevel = levels[name] ?? levels.default ?? this.level ?? INFO）、194-221（内置缓冲 exporter 无 levels）、232-238（exporter 随调用者 fiber 释放）; dsh-src/@deepseek-ai/cordis/lib/index.js:462-484（编译产物同为 ?? 1）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4507-4522（boot 为收集 warn 另挂 levels:{default:2} 的 exporter）; dsh-src/@deepseek-ai/dsh/lib/dump-config-CWs_HdOc.js:7-28（不启动、不求值 !!js；prepareProfile）；profile-boot-C14i-8IN.js:216-222（重写 cordis.yml）; dsh-src/@deepseek-ai/dsh/lib/dump-config-schema-D_PxIzpe.js:12-39（不完整时 exitCode=1）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:538、2306-2309、4038-4083、4405-4440、4455-4466; dsh-src/@deepseek-ai/dsh/lib/bin.js:150-194；dsh-plugin-manager/lib/types/operations.js:299-309；dsh/lib/plugin-BiveYA7h.js:96; dsh-src/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js:48; dsh-src/@deepseek-ai/dsh-headless/README.zh.md:36、78; dsh-src/@deepseek-ai/dsh-client-modules/README.zh.md:42；cordis-plugin-development/references/practices.md:35；dsh-web-app/presets/cordis.patch.yml:120-121；dsh-tool-cordis 工具名 cordis_inspect_list / cordis_inspect_query

## [confirmed] 4) dsh-cordis-client-runner 是什么，能否用来测客户端插件

核对无误：不能用来测我们的客户端插件。它是「动态双半插件包」的浏览器半边。宿主半边是 @deepseek-ai/dsh-cordis-host-runner，提供服务 ctx.dynamicCordisRunner：
- define({sessionId, plugin: {kind: 'new', idPrefix}（3–6 个小写英文字母）或已有 {pluginId}, name, purpose, code: {host?, client?}})
- run(agent, pluginId, packageId, mode, signal)
- stop(agent, pluginId)
- undefine(agent, pluginId)
宿主半边在 node:vm 里跑；带浏览器半边的包运行时会向页面发 cordis/request-run，等页面审批或用户手势后才装载。
限制：
①定义只存在进程内存里，按会话隔离，重启就没了，页面刷新也不会恢复；
②浏览器半边只能是纯 JS 的 async 函数体，只能用 React、console、styles、host 四个名字，不能 import，没有 fetch、setTimeout，所以装不进我们用 esbuild 打的 bundle；
③没有任何模型工具能创建动态定义，只有程序调用方和浏览器控件能；
④带浏览器半边的 run 在 headless/ACP 里会一直挂起，直到该轮被取消，没有超时；
⑤只在 dsh-web-app 组合里挂载；
⑥沙箱不是安全边界。
唯一的间接用处：它注册了 Client 侧的 inspect provider（slots、theme、events），web 的 cordis 预设里的 cordis_inspect_query 借它查页面上实时注册的 slot（需要页面在线；用真模型会花额度）。

> 核查说明：核对无误。

证据：dsh-src/@deepseek-ai/dsh-cordis-client-runner/package.json:3；README.zh.md:12、28-32、36-40、66、132-135; dsh-src/@deepseek-ai/dsh-cordis-host-runner/README.zh.md:12、52-58、62、136-141; dsh-src/@deepseek-ai/dsh-cordis-host-runner/lib/index.js:1572-1637（define 校验，idPrefix /^[a-z]{3,6}$/）、1644、1681、1865（undefine/run/stop 签名）; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:157-164、251-252

## [corrected] 4) 客户端 bundle 的热更新开发循环

结论成立：在 web profile 里（Desktop 的插件 profile 也是用 web 模板的 bundles 初始化的），改完 lib/client.js 约 0.5 秒内页面自动热替换，不用重启宿主，也不用刷新页面。
机制（已核对）：
- dsh-web-app 组合总会挂 client-hmr 行。它的宿主半边每 pollIntervalMs（默认 500 毫秒）stat 一次图里每个客户端行的 bundle，mtime、ctime、size 任一变化就调用 clientModules.rebuilt(id)，这是构建变化进入模块图的唯一入口。
- 然后通过 GET /plugins/events 的 SSE 推送 {type: 'rebuilt', id, rev}；浏览器作废旧模块、等旧 fiber 清理完、撤掉旧样式，再重新执行 bundle，用 entry.refresh() 重新挂载。
- 代价：被重载插件内部的 React 状态会丢（会话、连接状态保留）；替换失败不回滚，可以在「设置 → 插件 → 插件列表」里重试；DSH 升级（release 变化）后必须刷新页面。
开发循环：
①dsh --profile web --no-open --port 3999（插件已经用 plugin add link: 装进这个 profile）；
②打开 stdout 里「dsh web:」那行的 URL；
③esbuild --watch 持续写 lib/client.js（单文件；如果拆 chunk，要保证 client.js 最后写）；
④保存源码，页面自动更新。
格式要求：
- package.json 要有 dsh.client.platform: 'web' 和 exports['./client']。
- bundle 调用 window.__ModuleLoader__.load({ id: <package.json 的 name>, factory(require) { …; return { inject?, apply } } })。
- 第三方模块只能是种子表里有的，或者写进 dsh.client.external 的。
- Loader 取插件时用 exports.default ?? exports，遇到 __esModule 再取一次 default，所以直接返回含 apply 的对象即可。
改正和补充：
①页面里实际的 react-dom 版本是 18.3.1（dsh-web-frontend 的打包产物里能看到），package.json 里的 ^18.2.0 只是范围。
②页面模块种子表的完整键：react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、zod、@tanstack/react-virtual、@deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-primitives、@deepseek-ai/dsh-client-ui-dockkit。所以 esbuild 的 external 可以写 ['react', 'react/jsx-runtime', 'react-dom']，也可以改用 jsx: 'automatic'。但官方禁止 require 任何 Harness Client 包（ui-primitives 等）。require 不在表里、也没有已注册 factory 的模块会直接抛错。
③官方自己构建出的 client.js 带 Object.defineProperty(exports, Symbol.toStringTag, {value: 'Module'})，但它不是必需的：模板里没有，unwrapExports 也不看它。原来的 esbuild 脚本（format cjs 加 banner/footer 包成 factory）可以照用。
最大的坑（核对无误）：Web 和 Desktop 启动时读不到声明了 dsh.client 的包的 bundle，就会抛「client bundle not found; run `pnpm run build` before launch」，必需行 modules 失败，整个界面起不来；声明了 dsh.client 却没有 ./client 导出也会报错。所以 clean 构建时别先删 lib/。

> 核查说明：改正：原说法「页面里是 React 18.2」不准确，实际打包的是 react-dom 18.3.1。补充：种子表的完整键（可用于 external 和 jsx automatic），以及 toStringTag 标记的来龙去脉。其余核对无误。

证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:214-219; dsh-src/@deepseek-ai/dsh-client-hmr/lib/index.js:21-22、27-39、45-115、140-169；README.zh.md:28-48、62-74、116-118; dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:128-157、537-562、614-643、720-750；README.zh.md:34、38、42、47、53-55、77、79; dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js（react-dom version:"18.3.1"；函数 OZ() 返回的种子表键如答案所列）; dsh-src/@deepseek-ai/dsh-client-modules/lib/client.js:6（官方产物带 toStringTag）、804-893（materialize / require / import 只认种子表、已物化模块、已注册 factory）; dsh-src/@deepseek-ai/cordis-plugin-loader/lib/index.js:667-672; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js:1-22、package.json:1-21；references/ui-plugin.md:9；practices.md:35; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:43、113; dsh-src/_app/main.js:3550-3553、3635-3637

## [corrected] 4) 宿主半边代码的开发循环（与客户端热更新配合）

宿主代码没有「保存即生效」，各 profile 情况不同：
- headless：每次运行都是新进程，重新构建后直接重跑即可。headless、sdk、acp 三个组合本来就关了 hmr。
- web：base 组合在有 profileContext 时启用 dsh-hmr，但 root: [] 表示不监听源码。已链接包的文件改了，要等「下一次重新组合」才替换。会触发重新组合的有：HMR 监听到 profile manifest 里 dsh.profile.bundles 列表变化、profile 的 cordis.patch.yml 变化、$DSH_HOME/cordis.patch.yml 变化，或者插件管理器的操作。设置页的 Config Editor 也会重新组合，但不替换模块。新版本导入或启动失败时，旧版本也已经停了，状态报 failed，修好文件后下一次重组会再启动。
- 在插件管理器之外只改依赖的安装（另开终端跑 dsh plugin … update），不会触发重组。
- --patch 覆盖层是启动时快照，改了必须重启。
- 实操最稳的做法：宿主代码重建后直接重启 dsh web（几秒），页面会自动重连，必要时刷新。
- 可选（未实测）：在隔离 home 的 profile patch 里，把 hmr 行的 config 改成 root: ['<插件 lib 绝对路径>']。
改正：原说法「HMR 替换已链接包时不会再做 engines.dsh 检查」不对。按 dsh-hmr README，被替换的 profile 行在重新组合时会经过预检，app-boot 的 preflight 每次重组都会逐行读清单、跑兼容性检查。只有 profile 组合之外的行（preset 行、ctx.loader.create() 加的条目）才会带着新代码直接重启、不做检查。我们的插件是通过组合包 patch 插入的 profile 行，所以重建后如果 engines.dsh 变得不兼容，下一次重组就会被禁用，stderr 会出现 dsh: disabling profile plugin …。
- Desktop：官方开发指南写明替换已安装包要重启才能加载新的 JavaScript 模块代际；dsh-hmr README 又说重组时会替换已改动的文件，两份文档不一致。开发期用隔离的 dsh web 迭代，验收时再装进 Desktop，然后完全退出、重开。

> 核查说明：改正：原文把 dsh-hmr README:113-114 读成「替换已链接包不做兼容性检查」，实际只有 profile 组合之外的行才不检查，profile 行每次重组都会预检（app-boot preflight 2311-2360）。补充：Config Editor 重组但不替换模块。

证据：dsh-src/@deepseek-ai/dsh-hmr/README.zh.md:27-34、44、47、49、113、114（被替换的 profile 行经过重组预检；profile 组合之外的行不检查）、118；README.md:63（Config Editor 重组但不替换模块）、114; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:2296-2360（prepareProfileEntries/preflight 每次逐行 evaluatePluginCompatibility）；README.zh.md:50、54、63; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:27-32；dsh-headless/cordis.patch.yml:32-33；dsh-sdk-app/cordis.patch.yml:23-24；dsh-acp-app/cordis.patch.yml:22-23; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:290-301（--patch overlays 作为静态数据放进 profileContext）; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:70; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/docs/design/evidence/06-plugin-extension.md:77、193

## [corrected] 5) 在隔离 DSH_HOME 里装上插件、用 headless / web 做端到端冒烟：完整步骤草案（标注哪步要模型凭据）

原来 0–9 步的骨架成立，有四处必须改。
①外部看门狗。appExit 正常释放后只设退出码、等事件循环清空才退出（见第 3 题和补充条目），插件泄漏句柄时进程会一直挂着。本机核对过，macOS 默认没有 timeout，也没有 gtimeout 命令，要自己写看门狗。
②看门狗不能用 SIGTERM。dsh 把 SIGTERM 映射成正常关闭并以 0 退出，会把超时伪装成成功。用 SIGINT（退出码 130），再补一次 SIGKILL（137）。判定以冒烟跑者打印的 {"type":"hub-smoke","ok":true} 那一行为主，退出码 0 为辅。
③关停期间冒出来的未处理 rejection（例如卸载时 await ctx.timeout(ms) 被 reject）会让进程以 1 退出，这时 JSON 行可能已经是 ok:true。退出码和 JSON 行不一致时，看 web.err 里有没有「dsh: fatal …」，那说明插件卸载路径有 bug。
④「dsh web:」那行 URL 里的 token 是进程级启动令牌，进程存活期间可以反复使用，拿它换到的 cookie 默认 30 天有效，不是一次性的。日志和产物不要外传。
另外：DSH_HOME、DSH_AGENTS_HOME、DSH_TELEMETRY_DISABLED 和（备选方案的）DEEPSEEK_BASE_URL 都必须 export，不能写 .env。
各步骤是否需要凭据，原标注核对无误：0–7 步都不需要模型凭据、零额度；只有第 8 步真模型冒烟需要 DEEPSEEK_API_KEY（可以写进 $DSH_HOME/.env），会消耗额度，要先征得主人同意；第 9 步清理是删除操作，要先说一声。
第 3 步之前的前置（补充）：插件目录必须已经有 cordis.patch.yml、lib/index.js、lib/client.js，否则 plugin add 在加载组合包 patch 时失败，web 启动时 modules 也会失败。agent-hub/packages/plugin 目前只有 package.json 和 tsconfig.json。

```
# 替换原 run-smoke.sh 的第 7 步（web 主动链路冒烟）。
# macOS 默认没有 timeout/gtimeout，自己做看门狗；不能用 TERM（dsh 把 SIGTERM 当正常关闭并以 0 退出）。
"$DSH" --profile web --patch "$FIX/fake-llm.patch.yml" --patch "$FIX/smoke.patch.yml" --no-open --port 0 > "$RUN/web.out" 2> "$RUN/web.err" &
PID=$!
( sleep 120; kill -INT "$PID" 2>/dev/null; sleep 10; kill -KILL "$PID" 2>/dev/null ) &
WATCH=$!
wait "$PID"; CODE=$?
kill "$WATCH" 2>/dev/null
# 判定以冒烟跑者打印的 JSON 行为准，退出码只作辅助（130=被看门狗 INT，137=被 KILL）
if grep -q '"type":"hub-smoke","ok":true' "$RUN/web.out" && [ "$CODE" -eq 0 ]; then
  echo 'web 冒烟通过'
else
  echo "web 冒烟失败（退出码 $CODE）"
  grep -n 'fatal\|did not activate\|startup failed' "$RUN/web.err" || true
fi
```

> 核查说明：改正和补充：(1) 原脚本没有外部超时，句柄泄漏时会挂死，而且 macOS 没有 timeout 命令；(2) SIGTERM 会让 dsh 以 0 退出，看门狗和 CI 不能用；(3) 关停期的未处理 rejection 会把退出码变成 1；(4) 原说法「一次性登录令牌」不准，令牌在进程存活期间可以反复用来换 30 天 cookie；(5) 插件目录目前缺 cordis.patch.yml 和 lib/，link 安装前必须先构建。

证据：dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:21-71、280-285（SIGTERM→0，SIGINT→130）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4172-4253（installFailLoud：任何时刻的未处理 rejection → exit 1）; 本机核对：which timeout gtimeout 无结果（macOS 默认无此命令）; dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:458-481（启动令牌每次 GET / 都可换 cookie，不作废）；README.zh.md:41、43（每进程一个随机令牌；cookieMaxAgeDays 默认 30 天）; dsh-src/@deepseek-ai/dsh-home-paths/README.zh.md:34-39、48-52; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:3610-3667、3701-3760; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:138-141、202-224；dsh-app-boot/lib/index.js:1105-1111（DSH_TELEMETRY_DISABLED 非空即禁用遥测行）; dsh-src/@deepseek-ai/dsh-headless/README.zh.md:12、52-70、78、106-108；lib/json-stream-BA-F3lfb.js:182-276; dsh-src/@deepseek-ai/dsh-web-app/README.zh.md:37-41、67；lib/startup.js:24-25；lib/index.js:156-168（console.log 打印 dsh web: URL 到 stdout）; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:96-124、555-559（安装后 reconcile 会加载组合包 patch 文件）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/packages/plugin 目录现状：仅 package.json、tsconfig.json、node_modules

## [corrected] 5) 冒烟跑者插件：自动走一遍「唤醒→工具调用→交账」并以退出码报告

思路成立：在 web profile 里挂一个测试专用插件。它只 inject 一定存在的 appReady、appExit 两个服务；agentHub 在就绪后用 ctx.get 探测，中心插件没激活时能立刻报失败；另设兜底超时。
判定依据是会话事件 ctx.on('session/event', (session, event) => …)，事件形状和 headless --json 的投影一致（已核对）：
- tool/call：event.data.name，另有 callId、arguments。
- tool/result：只看 event.surfaceOp === 'append' 的，取 event.data.message.isError 和 toolCallId。
- turn/end：看 event.data.reason.kind，'completed' 为正常，headless runner 也以此决定退出码。
这些监听里抛错会被 dsh-session 兜住只记 warn，但原代码已经 try/catch，这样写正确。
有四处要改：
①role 只能是 chief | researcher | executor | sentinel（build-spec §3；core 的 ROLES）。原代码的 role: 'worker' 不合法，createBot 会失败。
②规格里的 CommandResult 是 { ok: true, data? } | { ok: false, error }，不是只有 {ok, error?}。实现如果在 data 里回了 botId 就直接用，否则再用 overview().bots（BotCard[]，字段有 id、name）按名字查。规格写明创建后会入队 trial 唤醒（主人发起），跑者只等第一次成功交账即可。
③假模型剧本里的 hub_commit 参数必须是完整的 Commit 输入，并带 reply，见第 5 题改正。否则 toolErrors 会大于 0，冒烟一定失败。
④ctx.logger.buffer 默认收不到 warn/debug。失败时想附中心插件的日志，就在跑者里自己挂一个 levels: {default: 3} 的 exporter，按名字过滤收集。
另外两点：
- 原证据里 build-spec 的行号有误：第 16 节「DSH 适配（待补）」在第 731 行，第 18 节「仿真与验收」在第 739–761 行（第 674 行是 15.1）。
- appExit 之后进程要等事件循环清空才退出，外部脚本必须带看门狗（见上一题）。

```
// ===== smoke-runner.mjs 中需要替换的片段 =====
// 改正 1：role 只能是 chief | researcher | executor | sentinel（build-spec §3 Role；core model/enums.ts:5）
const created = await hub.api.createBot({ name: botName, role: 'researcher', persona: '冒烟测试用', aspirations: ['完成一次交账'] })
if (!created?.ok) return finish(1, 'createBot 失败：' + (created?.error ?? '未知'))
// 改正 2：CommandResult = { ok: true, data? } | { ok: false, error }；实现若在 data 里回了 botId 就直接用，否则按名字查
const botId = created.data?.id ?? created.data?.botId ?? (await hub.api.overview()).bots.find((b) => b.name === botName)?.id
if (!botId) return finish(1, '找不到刚建的机器人')
const poked = await hub.api.pokeBot(botId, '冒烟：请交账')   // 等同主人发消息 → 交账必须带 reply
if (!poked?.ok) return finish(1, 'pokeBot 失败：' + (poked?.error ?? '未知'))

// 改正 3：ctx.logger.buffer 默认只有 error/info（WARN=2、DEBUG=3 被默认阈值 1 过滤）。
// 想在失败时附上中心插件的 warn，就在 apply 开头自己挂一个 exporter 收集（随本插件卸载自动移除）
const captured = []
ctx.logger.exporter({
  levels: { default: 3 },                      // 3 = DEBUG 及以上全部收
  export(m) {
    if (!String(m.name).includes('agent-hub')) return
    captured.push(m.type + ' ' + m.name + ': ' + m.args.map(String).join(' '))
    if (captured.length > 50) captured.shift()  // 只留最近 50 条
  },
})
// finish() 里把 recentLogs() 换成 captured.slice(-20)
```

> 核查说明：改正：(1) role 'worker' 不在 Role 枚举里；(2) CommandResult 有 data? 字段；(3) 交账参数要完整并带 reply；(4) buffer 不含 warn；(5) build-spec 行号引用有误（§16 在 731，§18 在 739–761）。

证据：dsh-src/@deepseek-ai/dsh-cmdline/lib/index.js:27-32; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:21-71、87-108; dsh-src/@deepseek-ai/dsh-headless/lib/json-stream-BA-F3lfb.js:182-264；lib/index.js:335-362; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1227-1240; dsh-src/@deepseek-ai/cordis/src/logger.ts:141-160、194-238；reflect.ts:233-243; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/docs/build-spec.md:100（Role）、614-659（HostPort/Hub）、661-672（UiApi：overview、createBot 输入、pokeBot(botId, text?) 等同发消息、创建后入队 trial）、726（CommandResult 含 data?）、731（§16 待补）、739-761（§18 仿真）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/packages/core/src/model/enums.ts:5（ROLES）；commit/process.ts:28

## [corrected] 5) 为了能这样测，插件本身要满足的可测性约束

原来 9 条中有 7 条成立（①②④⑤⑥⑧⑨）；第⑦条要改，第③条要补说明；另外补 3 条：
①只把「没有就完全不能工作」的服务写进 inject（如 agents、tools，这两个服务名已核对）。webServer、schedule、sessionController、workspaceRegistry、agentPresets 只在 web 组合里有，用 ctx.inject([...], cb) 可选挂载，或者用 ctx.get 探测。
②ctx.provide('agentHub', 门面)，门面里放 UiApi 和 status()。同一作用域里同名服务只能提供一次，所以插件不能被挂两份。
③数据根目录做成 Config。组合包 patch 里写 !!js dshHomePath('agent-hub') 的机制成立：Loader 用 with (ctx) { eval(expr) } 求值，dshHomePath 由 boot 提供在根 ctx 上，第三方行和 base 行是同一套机制。但 --dump-config 不求值 !!js，要真启动一次才能确认。规格目前写的默认值是 ~/AgentHub，默认放哪是设计决定，由主人拍板。
④机器人的默认模型（provider/model）做成 Config，测试 patch 指向 hub-fake。
⑤所有回调 try/catch。致命和被兜住的区别见第 2 题：定时器、流回调、脱离的 Promise 是致命的。
⑥用命名 logger ctx.logger('agent-hub')；开发开关 debugStderr 打开时往 stderr 写一行，绝不写 stdout。
⑦改正：health 路由不要挂在 /api/ 下。Connection 独占唯一的 /api 前缀路由，在那里做 Host/Origin 栅栏（防 DNS rebinding 和跨站请求）和登录鉴权；而 webServer 的精确路由优先于前缀路由，挂在 /api/agent-hub/health 会绕开这层保护。只读探活用 /agent-hub/health（裸路由、无鉴权、本机任何程序都能访问，只放非敏感数据）；需要鉴权的写操作走 ctx.connection.fetch.register(route)，或者在处理器开头调 ctx.connection.requestRejection(req)。
⑧lib/ 全量打包，测试夹具放在有自己 package.json（带 name、不声明 dsh.client）的目录。
⑨隔离规则不变：DSH_HOME 和 Desktop 的 ~/.dsh 分开，DSH_AGENTS_HOME 指向空目录，工作目录在任何 git 仓库之外且没有 .env。
⑩补充：定时器用 dsh-base 自带的 timer 服务（行 id timer，包 @deepseek-ai/cordis-plugin-timer）。ctx.interval(cb, ms) 和 ctx.timeout(cb, ms) 会随插件卸载自动清除，不会挂住 appExit。但写成 await ctx.timeout(ms) 时，插件卸载会让它 reject('Context has been disposed')，必须 catch，否则会变成未处理 rejection，进程以 1 退出。回调本身照样要 try/catch。
⑪补充：agent-hub/packages/plugin/package.json 现在把版本要求写在 dsh.engines.dsh，和旧样板 dsh-net-tuning 犯了同一个错。DSH 只读顶层 engines.dsh，现在等于没写。另外它声明了 dsh.bundle.patch 和 dsh.client，但 cordis.patch.yml、lib/index.js、lib/client.js 都还不存在，link 安装前必须先构建出来。
⑫补充：注册在机器人 agent.ctx 上的工具和监听，插件卸载时不会被自动撤掉。要把 disposer 按机器人存起来，在插件自己的 effect 里统一释放（practices.md:19）。

```
// ===== 宿主半边骨架（片段，按改正后的约束）=====
export const name = 'agent-hub'
export const inject = ['agents', 'tools']            // 只放没有就完全不能工作的服务

export function apply(ctx, config) {
  const log = ctx.logger('agent-hub')                // 命名 logger：日志名固定，便于导出与过滤
  const hub = /* createHub({ host, clock, … }) */ null
  const facade = { api: /* createUiApi(…) */ null, status: () => ({ ok: true, version: '0.1.0' }) }
  ctx.provide('agentHub', facade)                    // 给冒烟跑者等测试插件、诊断用

  // web 才有的能力：可选挂载。路由不要放在 /api/ 下：Connection 独占 /api 前缀并做 Host/Origin 校验与登录鉴权，
  // 而 webServer 的精确路由优先于前缀路由，挂在 /api/agent-hub/health 会绕过这层保护
  ctx.inject(['webServer'], (web) => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: '/agent-hub/health',                     // 只读、无敏感信息：本机任何程序都能访问
      handler(req, res) {
        try {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(facade.status()))
        } catch (error) {
          log.warn(error)
          res.statusCode = 500
          res.end('{}')
        }
      },
    }))
  })

  // 心跳用 dsh-base 自带的 timer 服务：ctx.interval 随插件卸载自动清除，不会挂住 appExit
  ctx.inject(['timer'], (t) => {
    t.interval(() => {
      try {
        Promise.resolve(hub?.tick()).catch((error) => log.warn(error))   // 异步失败也兜住，避免未处理 rejection
      } catch (error) {
        log.warn(error)                                                   // 同步异常兜住，避免整进程退出
      }
    }, 60_000)
  })

  if (config.debugStderr) process.stderr.write('agent-hub: active\n')   // 自报激活；绝不写 stdout
}

// ===== packages/plugin/package.json 关键字段（版本要求必须写在顶层 engines，dsh.engines 无效）=====
{
  "name": "dsh-agent-hub",
  "engines": { "dsh": ">=0.2.1-rc.5 <0.3.0" },
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": { "client": { "platform": "web" }, "bundle": { "patch": "./cordis.patch.yml" } }
}
```

> 核查说明：改正：原第⑦条建议的 GET /api/agent-hub/health 会盖过 Connection 的 /api 网关、绕开 Host/Origin 栅栏，应改用 /agent-hub/health 或 connection.fetch.register。补充：timer 服务与 ctx.timeout 的 reject 陷阱；当前 plugin package.json 的 engines 写错位置、缺产物；agent.ctx 上的注册要自管 disposer；!!js dshHomePath 的求值机制。

证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:8、19、20、22; dsh-src/@deepseek-ai/cordis/src/registry.ts:300-302；reflect.ts:277-305; dsh-src/@deepseek-ai/cordis-plugin-loader/lib/index.js:233-237（!!js 求值：with (ctx) eval）；dsh-app-boot/lib/index.js:4526（ctx.provide('dshHomePath', …)）；dsh-base/cordis.patch.yml:138-141; dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:14（API_PATH='/api'）、732-740（fetch.register、requestRejection）、1044-1058（/api 前缀路由：admit → 401/403）；README.zh.md:34（Web 载体持有唯一 /api route）、47; dsh-src/@deepseek-ai/dsh-host-webserver/lib/index.js:326-333（register 无鉴权，返回 disposer）、494-503（精确路由优先于前缀）; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:24-25（timer 行）；cordis-plugin-timer/src/index.ts:12-16、28-54（timeout；卸载时 reject 'Context has been disposed'）、56-66（interval 随 fiber 清除）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:276-299（只读顶层 engines.dsh）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/packages/plugin/package.json（dsh.engines.dsh；目录内无 cordis.patch.yml、lib/）; dsh-src/@deepseek-ai/dsh-client-hmr/lib/index.js:140-152（webServer.register 包在 ctx.effect 里的官方写法）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/AGENTS.md:35；docs/build-spec.md:731

## [corrected] 补充：dsh 进程的退出码语义（写测试判定必读）

下面这张表直接决定冒烟脚本和 CI 怎么判成败：
- 应用（或测试插件）调用 appExit(code)：先在 5 秒上限内释放整棵树；成功后只设置 process.exitCode = code，等事件循环清空才退出；释放失败或超时则 process.exit(code) 强退。泄漏的定时器或句柄会让进程不退出。
- SIGTERM：释放后以 0 退出，会把「被杀」伪装成成功。SIGINT：释放后以 130 退出。第二次收到信号：立即强退。
- 任何时刻的未捕获异常或未处理的 Promise rejection：stderr 写一行「dsh: fatal uncaught exception: <util.inspect>」或「dsh: fatal load failure: <util.inspect>」，最多等 2 秒释放，然后 exit(1)。插件卸载期间（appExit 之后）冒出来的 rejection 也算，例如 await ctx.timeout(ms) 在卸载时被 reject。
- 启动阶段：必需行（agent-loop、webserver、web-runtime、modules、connection、headless-runner、acp、sdk-jsonrpc-server）任一失败，stderr 写「dsh: startup failed: …」，并写 $DSH_HOME/logs/startup-*.log，exit 1。可选行失败只告警，进程继续运行。
- headless：最后一轮 turn/end 为 completed 时退出码 0，否则 1；runner 层失败写「dsh: <message>」，--json 模式下另有 {type: 'error'} 事件、没有 final。
测试判定建议：以测试插件自己打印的结果行为主，退出码为辅；外部看门狗先发 INT，再发 KILL。

> 核查说明：补充：原结论没有覆盖退出码语义，而它直接决定冒烟和 CI 的判定方式。

证据：dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:12、21-71、273-288; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4172-4253（FAIL_LOUD_RELEASE_TIMEOUT_MS=2000；fatal load failure / fatal uncaught exception）; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:43（全局必需行清单）、105-111; dsh-src/@deepseek-ai/dsh/lib/bin.js:207-231（StartupError → 报告 + exit 1）; dsh-src/@deepseek-ai/dsh-headless/lib/index.js:274-286、357-362；README.zh.md:78、106-108; dsh-src/@deepseek-ai/cordis-plugin-timer/src/index.ts:44-54

## [corrected] 补充：插件的默认日志名 / fiber 名取自哪里（回答原 open question）

Loader 把模块导出（经 unwrapExports 之后）原样交给 ctx.registry.plugin。cordis 给插件建 runtime 时，名字取导出的 name；名字恰好是 'apply' 时视为无名。fiber.name 会向上找最近一个有名字的 runtime。所以插件里直接调 ctx.logger.info(...) 时，日志的 message.name 是 hyphenate(插件导出的 name)，不是 patch 行的 id。用 ctx.inject(deps, cb) 建的子插件，名字取 cb.name；箭头函数的名字是空串，会沿用父插件的名字。仍建议显式写 ctx.logger('agent-hub')，日志名就不依赖导出名。

> 核查说明：补充：原调研把这一点列为未核实的 open question，现已由源码证实。

证据：dsh-src/@deepseek-ai/cordis-plugin-loader/lib/index.js:452-463（unwrapExports 后 ctx.registry.plugin(plugin, config)）、667-672; dsh-src/@deepseek-ai/cordis/src/registry.ts:300-302、316-327（runtime.name = plugin.name）; dsh-src/@deepseek-ai/cordis/src/fiber.ts:336-343（fiber.name 取最近的有名 runtime）；logger.ts:252-262（name ??= hyphenate(fiber.name)）

## 坑

- 启动器参数必须写在应用参数前面：启动器只认 --profile、--patch、--from-default-profile、--dump-config、--dump-default-config、--dump-config-schema、-V/--version，遇到第一个不认识的参数后全部交给应用。dsh --profile headless --json --patch a.yml '任务' 会把 --patch 当成 headless 自己的参数。
- profile 名 desktop 被保留：--profile desktop 的启动和 dump 都会被拒。dsh plugin --profile desktop 只有 Desktop 自带的 CLI 载体（runtime/cli/bin/dsh）能用，而且要求先打开过一次 Desktop、再完全退出。
- --dump-config 只反映配置结果，不代表激活：它不求值 !!js，会按模板初始化 profile 并重写 profile 的 cordis.yml；版本被拒的行仍会出现，被跳过的组合包没有行。是否真正激活，看启动时 stderr 的 did not activate / pending 诊断。
- --from-default-profile 会删掉同名自定义 profile 的旧目录（含已装插件和用户 patch）；内置名 web、headless、sdk、sdk-minimal、acp 不能当目标。
- 当前目录和 $DSH_HOME 的 .env 里不能写启动变量：PATH、HOME、SHELL、NODE_OPTIONS、NODE_PATH、DEEPSEEK_BASE_URL、DEEPSEEK_SEARCH_BASE_URL、SSL_CERT_*、NODE_TLS_REJECT_UNAUTHORIZED，以及所有 DSH_*、XDG_*、DYLD_*、BASH_FUNC_* 前缀的变量；代理变量 HTTP(S)_PROXY、ALL_PROXY、NO_PROXY 只允许写在 $DSH_HOME/.env。写了启动器会直接抛错退出，必须 export。DEEPSEEK_API_KEY 可以写进 .env；.env 的值并入 process.env，但不覆盖已有值。
- 工作目录决定会话的 workspace，也决定注入哪些指令文件：从最近的带 .git 的祖先目录到 cwd 逐级加载 AGENTS.md/CLAUDE.md（找不到 .git 时只读 cwd 这一层），外加 $DSH_HOME/AGENTS.md 和 $DSH_AGENTS_HOME/AGENTS.md。在 agent-hub 目录里跑，会把给 Codex 的守则注入机器人会话。
- headless 不用 GUI 保存的密钥（credentials 行被关了），裸跑默认路由 deepseek-official 会报 MISSING_CREDENTIAL。drive-dsh 技能里 --patch ~/.dsh/profiles/desktop/cordis.patch.yml 的绕法不适用于隔离测试。
- headless、sdk、acp 组合都关了 hmr；base 和 headless 里没有 webServer、schedule、sessionController、workspaceRegistry、agentPresets，把它们写进 inject 的插件在 headless 里会永远 pending。
- 产品 profile 不给 ctx.logger 挂控制台输出，而且 ctx.logger.buffer 默认只收 error/info（WARN=2、DEBUG=3 被默认阈值 1 过滤），要看 warn 必须自己挂 exporter。headless 的 stdout 只放答案或 --json 事件流，sdk/acp 的 stdout 是 JSON-RPC 通道；诊断一律写 stderr。
- 致命和被兜住要分清：定时器回调、流的 'data' 监听里的未捕获异常，以及任何时刻（包括 appExit 之后的卸载期）没人处理的 Promise rejection，都会让整个进程以 1 退出。session/event 监听、webServer 路由处理器、llm/adapters-updated 监听里抛错会被宿主兜住、只记 warn，但不要依赖这一点。
- await ctx.timeout(ms) 在插件卸载时会 reject('Context has been disposed')，脱离的 async 循环里不 catch，就会在关停时让进程以 1 退出，冒烟被误判为失败。
- appExit(code) 正常释放后不强制退出，只设 process.exitCode，事件循环清空后才退出；插件泄漏了没登记到 ctx.effect 的定时器或句柄，进程就会挂住。冒烟脚本必须有外部看门狗，而 macOS 默认没有 timeout/gtimeout 命令。
- dsh 把 SIGTERM 映射成正常关闭并以 0 退出（SIGINT 是 130）。看门狗和 CI 不能用 SIGTERM 杀进程再看退出码，否则超时会被当成成功；要以测试插件打印的结果行为准。
- 必需行（agent-loop、webserver、web-runtime、modules、connection、headless-runner、acp、sdk-jsonrpc-server）任一失败，整个进程启动失败；测试 patch 不要禁用或弄坏它们。
- profile 或 home 的 cordis.patch.yml 若为空或只有注释，会导致启动失败，必须写 []。--patch 指向的文件不存在也直接启动失败。
- 声明了 dsh.client 却缺 lib/client.js（或 exports 里没有 ./client）：Web 和 Desktop 启动时必需行 modules 失败，整个界面起不来，Desktop 进崩溃恢复。clean 构建不要先删 lib/。声明了 dsh.bundle.patch 却缺这个文件：dsh plugin add 在 reconcile 阶段失败。
- 测试夹具要放在有自己 package.json 的目录：要带 name 字段（没有 name 的清单会被跳过），并且不声明 dsh.client。否则夹具会被当成 dsh-agent-hub 的第二个来源，Web 报 resolves from multiple active Loader sources，启动失败。同理，不要既 plugin add 了插件，又在 --patch 里按路径再插一遍。
- 会话标题生成也会调模型（默认继承会话路由）。假模型必须能回答不带工具的请求，或者在测试 patch 里写 - id: session-title-llm 加 disabled: true。
- StreamChunk 必须能无损 JSON 序列化；tool-call-delta 的 id、argumentsDelta 必须是字符串；只能有一个终止 finish；finish 为 max-tokens 时工具调用会被丢弃。
- 假模型不声明 reasoning，或者 efforts 不含会话实际请求的档位（DeepSeek 默认 high，可选 off/low/high/max），请求会在发出前被 UNSUPPORTED_REASONING_EFFORT 拒掉。
- 版本闸门只读 package.json 顶层的 engines.dsh（预发布版本参与匹配）。用户旧样板 dsh-net-tuning，以及当前 agent-hub/packages/plugin/package.json，都写在 dsh.engines.dsh 里，等于没写。旧样板 dsh-auto-upgrade 没有 dsh.bundle，用现在的 CLI 安装只会作为普通依赖，不会加载。
- link: 安装不会安装插件自己的 dependencies，files 字段也不过滤链接目录，所以 lib 必须自包含。本机能跑，可能只是因为 Node 从真实路径往上找到了仓库的 node_modules。
- 宿主代码不会保存即生效：web 要等下一次重组（profile/home 的 cordis.patch.yml 变化、bundles 列表变化、插件管理器操作）或重启。重组时 profile 行会重新做兼容性预检；--patch 覆盖层是启动时快照；Desktop 要完全重启。
- 「dsh web:」那行 URL 带进程级启动令牌：进程存活期间可以反复用它换取默认 30 天的登录 cookie，不是一次性的。不要贴进日志、聊天或文档。用 --port 0 时从这一行解析端口。
- webServer.register 注册的路由没有任何鉴权，本机任何程序都能访问。也不要把裸路由挂在 /api/ 下：精确路由优先于 Connection 的 /api 前缀网关，会绕过 Host/Origin 栅栏。
- 行 id 和包名不是一回事：DeepSeek API-key 适配器的行 id 是 llm-deepseek（包 @deepseek-ai/dsh-llm-deepseek-api-key）。patch 写错 id 只会告警 entry not found 并跳过，不会报错。
- hub_commit 的入参是严格对象：12 个键都必须有，可空的写 null。主人消息唤醒的回合（包括 pokeBot）reply 必填。Role 只能是 chief、researcher、executor、sentinel。假模型剧本和冒烟跑者都要照这个写。
- 插件卸载不会自动撤掉注册在机器人 agent.ctx 上的工具和监听，要把 disposer 按机器人存进插件自己的 effect（practices.md:19），L2 要测这一点。
- 不要让测试宿主和 Desktop 共用同一个 DSH_HOME：会话写锁会冲突（session/writer-held），JSON 存储没有跨进程锁。
- 审批：没有应答者时，需要审批的工具调用解析为 unavailable，等于拒绝（headless 就是这样）；web 的应答者是界面，无人值守时会一直等。冒烟剧本只调不需要审批的工具。
- 项目路径含空格（DSH solo AGENT）：node --test 不能直接给目录参数，要用带引号的 glob；临时 DSH_HOME 和工作目录用 mktemp 建在不含空格、不在 git 仓库里的位置。
- dsh-cordis-host-runner 的动态定义只在内存里，重启就丢；带浏览器半边的定义在 headless/ACP 里会无限挂起，别用于测试。dsh-app-boot 的 DSH_SNAPSHOT=replay 回放开关 dsh 启动器根本不走，对我们无用。cordis_inspect_list / cordis_inspect_query 只在 web 的 cordis 预设里有。

## 未决

- @deepseek-ai/dsh-llm-replay、dsh-agent-loop-testkit、dsh-llm-mock-server、@deepseek-ai/cordis 4.0.5 有没有发布到 npm？离线无法核实。即使能装，dsh-llm-replay 的 Config 字段未知，而且要先花一次额度录制。
- 在全新的隔离 profile 里执行 dsh plugin add link: 是否完全不联网（pnpm 会不会去 registry 取元数据或校验 packageManager）？需要实测一次。
- 用 DSH 自带 Electron 的 Node 模式（ELECTRON_RUN_AS_NODE=1）跑 node --test 或 vitest，并从 app.asar 里 import @deepseek-ai/cordis，是否可行？未实测。
- hmr 行的 root 能否写成 profile 目录之外的绝对路径（插件 lib 目录），实现宿主代码保存即替换？未实测。
- 原样重写（内容不变）profile 的 cordis.patch.yml，能否触发一次重组、从而替换已链接包的新代码？未实测。
- Web 界面的输入框能否在不属于「可配置提供方目录」的路由（hub-fake）上提交消息？只影响人工界面冒烟。
- Desktop 里改已链接插件的 lib/client.js 会不会热替换？Desktop profile 由 web 模板初始化，挂了 client-hmr；client-hmr README 只说 Electron 的安装和后端重启流程不走这条 SSE 路径。未实测。
- 第三方组合包 patch 里的 !!js dshHomePath('agent-hub')：求值机制和 base 相同（with (ctx) eval），预计可用；但 --dump-config 不求值，需要一次真实启动确认。
- 在 web profile 里不带预设直接 ctx.agents.create 建的会话，会拿到哪些工具和提示词？这影响冒烟会话里假模型看到的 tools 列表，需要参考 T1/T5 的调研或实测。
- dsh-session 派发 session/event 时会按 scope 过滤（scopeTarget(session, scopeOf(ctx))）。根级的测试插件能否收到中心插件自建的机器人会话的事件？已确认 headless runner 能收到它自己创建的会话的事件，但中心建会话的方式未在本题核实。
- 非交互 sh 里用 & 启动的后台进程可能继承「忽略 SIGINT」（POSIX：没有作业控制时，后台命令忽略 SIGINT/SIGQUIT）。Node 通过 process.on('SIGINT') 安装处理器后能否覆盖这一点、看门狗的 kill -INT 是否生效？未实测，所以看门狗脚本里用 SIGKILL 兜底。
- createBot 之后自动入队的 trial 唤醒和随后的 pokeBot 如何去重或排队，会影响冒烟跑者的判定窗口，以中心的实现为准。
