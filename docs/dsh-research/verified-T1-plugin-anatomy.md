# T1-plugin-anatomy

## [corrected] Q1-a package.json 里与 DSH 有关的全部字段（dsh.bundle.patch、dsh.client.*、engines、icon）以及 exports 的约定

DSH 没有统一的清单解析器，各读取方自己校验用到的字段。插件包里有意义的字段如下。
1) dsh.bundle.patch：字符串，或有序字符串数组（相对包根的 YAML patch 路径）。只有它存在，dsh plugin add 和插件页才会把包名追加进 profile 的 dsh.profile.bundles（reconcile 的判据是 dsh.bundle.patch !== undefined），否则只当普通依赖装上并打警告。类型不对时 bundlePatchFiles 抛「dsh.bundle.patch must be a file path or a list of file paths」，启动时该组合包被跳过（stderr「skipping profile bundle」）。数组按顺序拼成同一层，例如 dsh-web-app 有 5 个文件。
2) dsh.client（浏览器半边），4 个字段：
- platform：必填字符串。只有 'web' 会被组合，其他值静默忽略。注意 parseDshClient 在判断 platform 之前就校验另外三个字段的类型，类型错了照样抛。
- inject：可选字符串数组，填客户端包的包名，只决定这些包先到达、先激活；图里没有的名字直接跳过。不是 Cordis 服务名。
- external：可选字符串数组，填 bundle 会 require()、但不在基座模块表里的精确模块名。声明自己的包名或形成环会让组合失败。
- immediately：可选布尔。true 表示页面启动时预取；不写也会在插件加载阶段加载并挂载。
基座模块表来自前端 OZ()，factory 里 require 必须用这些精确键：react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、zod、@tanstack/react-virtual、@deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-primitives（官方 practices 禁止 require 它）、@deepseek-ai/dsh-client-ui-dockkit。
3) platform 为 'web' 时，exports 必须是对象且含 './client'（字符串，或带字符串 default 的条件对象），否则抛「declares dsh.client but exports no "./client" bundle」。文件不存在时抛 MissingClientBundleError，要求先构建。
4) exports 的约定：
- exports['.'] 是宿主半边入口，Loader 按包名 import。
- exports['./locale/*.json'] 提供 meta.title 和 meta.description，缺了回落到 package.json 的 name 和 description。
- 图标用 exports['./icon'] 或顶层 icon；顶层优先，路径相对包根。限 SVG/PNG/JPEG/WebP，不超过 256KiB，不能是绝对路径、URL 或指向包外的符号链接。
- './package.json' 导出不是必需的：resolveBundleDir 和 client-modules 都直接在文件系统里找 package.json。
5) 版本要求写在顶层 engines.dsh，与 engines.node 并列。dsh-net-tuning 样板写在 dsh.engines.dsh，宿主不读。规则见 Q1-b。
6) dsh.manifestVersion 可选，当前格式号是 1，不强制。dsh.profile.bundles 只属于 profile 自己的 package.json，由安装器维护。
7) files 对 link 安装不起过滤作用。宿主自带的 @deepseek-ai/* 不要写进 dependencies；要复用宿主的副本，写 peerDependencies（见 Q3-b）。
8) 包名建议用不带 @deepseek-ai 作用域的唯一名字。组合包名先从 dsh 安装目录解析、再从 profile 解析。用户样板 dsh-auto-upgrade 用的是 @deepseek-ai/dsh-upgrade-monitor，能用，但和官方命名空间混在一起。

```
{
  "name": "dsh-agent-hub",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Resident proactive bots hub for DSH",
  "engines": { "dsh": ">=0.2.1-rc.5 <0.3.0-0" },
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["lib/index.js", "lib/client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "peerDependencies": { "@deepseek-ai/schemastery": "~3.18.5" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ]
    }
  }
}
```

> 核查说明：原说法：基座模块表里有 dsh-client-store、dsh-client-ui-slots、dsh-client-ui-primitives、dsh-client-ui-dockkit。改正：OZ() 返回的键是带作用域的全名 @deepseek-ai/dsh-client-store 等。按短名写 require('dsh-client-store') 会抛 missed the module table。补充 4 点：① parseDshClient 在判断 platform 之前就校验类型；② inject 里图中不存在的包会被跳过；③ external 自引用或成环在组合时被拒；④ ./package.json 导出不是必需的。其余条目逐条核对属实。

证据：路径约定：dsh-src = /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src（官方包只读解包）；_app = dsh-src/_app; dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js — function OZ() 的键是全名：react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、zod、@tanstack/react-virtual、@deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-primitives、@deepseek-ai/dsh-client-ui-dockkit；同文件的 prefetchImmediateTier 只预取 immediately 行; dsh-src/@deepseek-ai/dsh-client-modules/lib/client.js:804-840 — materialize / makeRequire：require 先查 seed 表（即 OZ），查不到就抛 require(...) missed the module table; dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:62-76 — parseDshClient 校验 platform、inject、external、immediately 的类型; dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:172-182 — clientExportOf：exports 不是对象时返回 undefined；./client 必须是字符串或带字符串 default; dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:720-748 — resolveMeta：先 parseDshClient，再 platform !== 'web' 返回 null；缺 ./client 抛错; dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:422-445 — orderByModuleGraph：external 自引用或成环时抛错; dsh-src/@deepseek-ai/dsh-client-modules/lib/client.js:777-792 — arriveGraphRow：external 和 inject 的包先到达，图里没有就跳过; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:517-521 — bundlePatchFiles 类型校验; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:83-87、96-125 — bundleManifest 以 dsh.bundle.patch 判定；reconcile 追加 bundles，或警告 installed as a plain dependency; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:976-1001 — packageDirFromAnchor / resolveBundleDir：安装锚点优先，不要求导出 ./package.json; dsh-src/@deepseek-ai/dsh-package-manifest/README.zh.md:33-53; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json:1-21; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:31-51; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35; dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/package.json:37-47; dsh-src/@deepseek-ai/dsh-web-app/package.json:46-56 — dsh.bundle.patch 是含 5 个文件的数组; /Users/bytedance/Documents/DSHarness Doc/dsh-net-tuning/package.json:15-18; /Users/bytedance/Documents/DSHarness Doc/dsh-auto-upgrade/plugin/package.json:1-17

## [confirmed] Q1-b engines.dsh 版本闸门的实际规则

1) 只读顶层 engines.dsh。写了它就只看它，peerDependencies 一律忽略。没写才逐个检查名字是 @deepseek-ai/dsh 或以 @deepseek-ai/dsh- 开头的 peer 范围；@deepseek-ai/cordis、@deepseek-ai/schemastery 不参与。两者都没写就不设限。
2) 比较对象是 getDshRuntimeVersion()，即 dsh-app-boot 自己 package.json 里的版本，与 dsh --version 一致，当前是 0.2.1-rc.5。用 semver.satisfies 比较，开了 includePrerelease。空范围或无效范围算不兼容，engines.dsh 写 workspace: 也算无效。engines 不是对象、或 engines.dsh 不是字符串时，按清单格式错误抛错。
3) 检查时点有 4 个：
- 安装前：直接读本地路径或 registry 上的 manifest；不兼容就「nothing was installed」，并打印 allow-version 提示。
- 安装后：检查新增或变更的直接依赖，以及组合包点名的组件；不兼容就恢复 package.json 和 lockfile，再跑 pnpm install --frozen-lockfile 复原 node_modules。
- 每次启动或重组时，loadProfileDirectory 检查组合包本身；不兼容就跳过，stderr 打印「skipping profile bundle」。
- prepareProfileEntries 检查每个插件行；不兼容就把该行改成 disabled，stderr 打印「disabling profile plugin」，模块不导入。
4) 豁免写在 profile 目录的 compatibility.json 里：精确的 name@version 对应精确 DSH 版本列表。插件升级或 DSH 升级后豁免都不继承。CLI 命令：
- dsh plugin --profile <p> allow-version <name@ver> --dsh-version <exact> --accept-risk
- revoke-version <name@ver> --dsh-version <exact>
- version-exemptions（列出现有豁免）
5) dsh-package-manifest README 说「不强制 engines.dsh」，这条已过时，以 app-boot 的代码为准。
6) 取舍：写一个封闭范围（如 >=0.2.1-rc.5 <0.3.0-0）是失败时关闭，DSH 强制更新后插件会停，要等发新版或做豁免。不写就永远加载，但接口变了会在运行时出错。常驻机器人建议写范围，同时在代码里用 ctx.get 探测可选服务。

> 核查说明：逐条核对属实。细化 2 点：运行时版本取自 dsh-app-boot 的 package.json；安装后被拒时会额外跑一次 pnpm install --frozen-lockfile 复原 node_modules，失败时提示运行 dsh plugin install。

证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:270-298 — getDshRuntimeVersion、satisfies（includePrerelease）、unmetRequirements; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:311-326 — evaluatePluginCompatibility 与豁免判定; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:1015-1045 — loadProfileDirectory 对组合包做兼容检查，不兼容就跳过; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:538、2305-2309 — skipping profile bundle / disabling profile plugin; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:351-374 — 安装前预检，nothing was installed; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:496-560 — 安装后检查；恢复文件并 pnpm install --frozen-lockfile; dsh-src/@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:14-56、95 — version-exemptions / allow-version / revoke-version 的解析与风险提示; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:52-56; dsh-src/@deepseek-ai/dsh-package-manifest/README.zh.md:93 — 「不强制」的旧表述

## [corrected] Q1-c 宿主插件的几种写法（具名导出 apply、export default {inject, apply}、class）、name，以及 Config/schema 配置项

一、模块形态
- Loader import 模块后执行 unwrapExports：取 exports.default ?? exports，再处理 __esModule。同时有 default 和具名 apply 时 default 胜出，具名导出全部被忽略，所以三种写法只能选一种。
- registry.resolve：插件是函数就当回调；是带 apply 方法的对象（包括 ES 模块命名空间）就取 apply。同时从这个对象上读 name、inject、Config、provide、intercept。
- name 只用于诊断和默认 logger 名，等于 'apply' 时被忽略。

二、调用方式由 isConstructor 决定：只看函数有没有 prototype，生成器函数除外。
- export function apply(ctx, config)：官方模板、dsh-client-hmr、plugin-manager/tools 都这么写。它会被 new 调用，return 值被丢弃，直接 return 清理函数等于没写。
- 更危险的是 return 一个 Promise：new 会把这个 Promise 当作实例吞掉，没人接；一旦 reject 就成为未处理拒绝，installFailLoud 让宿主 exit(1)。所以函数声明式 apply 必须同步、不 return；异步初始化写 init().catch(log)；清理全部走 ctx.effect / ctx.on。
- 方法简写 export default { apply(ctx){} }、async function、箭头函数：被普通调用 runtime.callback(ctx, config)，此时 this 是 runtime 记录，不是你的对象。返回值按 effect 收集：
  · 函数：作为清理函数收集。
  · Promise：等待它，收集 resolve 出的函数；reject 被兜住，只记日志。
  · 同步或异步可迭代（生成器）：逐个收集。
  · null / undefined：忽略。
  · 其他对象：抛 TypeError('Invalid effect')，插件启动失败。
- export async function apply：异常被兜住，也可以 return 清理函数。代价是 Promise 结算前整行处于 LOADING，启动时 boot() 的 loader.await() 会等它；长时间 await 会拖住整个 Web/桌面就绪（打印 URL、通知桌面 ready 都在它之后）。长任务要放到后台。
- 同样的规则也适用于 ctx.inject(deps, cb) 和 ctx.plugin(fn) 的回调：function 表达式会被 new；箭头回调的返回值会被当作 effect。返回 disposer 正好被收集，返回普通对象则报 Invalid effect。
- class：先 new Class(ctx, config)，再调用实例的 [Service.init]()（如果有），它的返回值作为 effect；inject 和 Config 写成 static 字段。要以类的形式提供服务，就 extends Service 并 super(ctx, '服务名')，这需要 import @deepseek-ai/cordis（用 peerDependencies 拿宿主那份）。不用类也行：在 apply 里 ctx.provide('agentHub', api)，零依赖，随插件卸载撤销，同名重复注册会抛错。

三、Config
- 任何带 '~standard'.validate 的 Standard Schema 对象都行。官方写法是 import z from '@deepseek-ai/schemastery'。
- validate 必须同步。返回 Promise 会抛 'Async config validation is not supported'。
- 返回 { issues } 时抛 ValidationError：记 error，该行不激活，启动审计按 optional 行给警告。

四、volatile
- schemastery 的 .volatile() 字段解析后是一个引用，用 .get() 读值。
- 只改 volatile 字段时，Loader 就地提交新值并发出 loader/volatile-update(paths)，不重新挂载。改普通字段会整行重新挂载（先卸载再执行 apply）。
- 限制一：loader/volatile-update 带过滤器 owner.fiber === 本行 fiber，只有注册在本行根 ctx 上的监听器收得到；在 ctx.inject / ctx.plugin 子插件里注册的收不到。
- 限制二：只有 Schemastery 的 Config 才识别 volatile。手写 Standard Schema 时按原值比较，任何改动都会整行重新挂载。

五、!!js：config 里的 !!js 在本行每次激活时以 with(本插件 ctx) 求值，例如 !!js dshHomePath('agent-hub')。

六、Config 不会自动生成插件页表单
- Settings 只给 volatile 字段出表单数据；autoGenerate 目前没有客户端实现。
- 要在插件页配置，客户端自己注册 slot：plugins.bundle.config（key 是包名）或 plugins.row.config（key 是 '<包名>#<行 id>'）。
- 条目有可编辑的 Config 字段时，页面宿主会传入 form.state 和 form.mutate(operations, expectedRevision)。

```
// lib/index.js —— 写法 A（推荐）：同步 apply + 后台初始化 + 清理全走 ctx.effect / ctx.on
import z from '@deepseek-ai/schemastery'   // package.json 写 peerDependencies，复用宿主那份
export const name = 'agent-hub'             // 只用于诊断和默认 logger 名
export const inject = ['agents']            // 顶层只放核心必需服务；webServer 等可选服务放进 ctx.inject 子插件
export const Config = z.object({
  maxConcurrent: z.number().step(1).min(1).default(2).volatile(), // 只改它不重挂载，读值用 .get()
  tickSeconds: z.number().step(1).min(10).default(60),            // 改它整行重挂载，正在跑的机器人轮次会被取消
})
export function apply(ctx, config) {
  // function 声明会被 new 调用：return 值被丢弃；绝不能 return Promise（reject 会成为未处理拒绝，宿主 exit(1)）
  ctx.on('loader/volatile-update', (paths) => {   // 必须注册在本行根 ctx 上，子插件 ctx 收不到
    console.log('[agent-hub] volatile changed', paths, config.maxConcurrent.get())
  })
  const abort = new AbortController()
  ctx.effect(() => () => abort.abort(), 'agent-hub: stop background init')
  // 不 await：apply 里长时间等待会拖住整个应用启动
  init(ctx, config, abort.signal).catch((error) => console.error('[agent-hub] init failed', error))
  // 可选依赖：webServer 重启只会卸载这个子插件，不会连带重挂载整个中心
  ctx.inject(['webServer'], (sub) => sub.webServer.register({
    kind: 'prefix',
    path: '/agent-hub',
    async handler(req, res) { res.setHeader('Content-Type', 'application/json'); res.end('{}') },
  }))  // 箭头回调的返回值被当作 effect：register 返回的 disposer 正好被收集
}
async function init(ctx, config, signal) { /* 读机器人档案、恢复调度…… */ }

// 写法 B（与 A 二选一）：async 函数不会被 new，返回值被 await、异常被兜住，可 return 清理函数；
// 代价：Promise 结算前整行处于 LOADING，启动会等它
// export async function apply(ctx, config) { await quickSetup(ctx); return () => { /* 卸载清理 */ } }

// 写法 C（与 A/B 三选一）：默认导出对象，方法简写不会被 new；只能 return 函数/undefined/Promise/生成器
// export default { name: 'agent-hub', inject: ['agents'], Config, apply(ctx, config) { return () => {} } }

// 不继承 Service 也能提供服务（零依赖）：
// ctx.provide('agentHub', { listBots: () => [] })   // 本插件卸载时自动撤销；同名已存在会抛错
```

> 核查说明：原结论核对属实：unwrapExports、resolve、isConstructor、Invalid effect、this 是 runtime、同步 validate、volatile、!!js、配置 slot 都有源码佐证。补充 4 点：① 函数声明式 apply 如果 return Promise，会被 new 吞掉，reject 就是未处理拒绝 → 进程 exit(1)（node 实验复现；fiber.ts:251-257 + installFailLoud）；② async apply 会被 loader.await() 等待，拖慢整个启动；③ loader/volatile-update 只投递给本行根 fiber 上的监听器，而且非 Schemastery 的 Config 不支持 volatile；④ ctx.inject / ctx.plugin 的回调同样受 isConstructor 规则约束；提供服务不必继承 Service，用 ctx.provide 即可。

证据：dsh-src/@deepseek-ai/cordis-plugin-loader/src/index.ts:201-208 — unwrapExports; dsh-src/@deepseek-ai/cordis-plugin-loader/src/config/entry.ts:223-238 — import → unwrapExports → registry.plugin; dsh-src/@deepseek-ai/cordis/src/registry.ts:8-10、91-133、222-228、300-302、316-336 — isApplicable；插件形态；resolve；inject 等价于 plugin({inject, apply, name})；name==='apply' 时忽略; dsh-src/@deepseek-ai/cordis/src/utils.ts:79-89 — isConstructor; dsh-src/@deepseek-ai/cordis/src/fiber.ts:250-261（lib/index.js:1067-1071）— 构造分支只取实例的 [symbols.init]()，否则调用 runtime.callback(this.ctx, this.config); dsh-src/@deepseek-ai/cordis/src/fiber.ts:356-400 — effect 的各种形态与 TypeError('Invalid effect'); dsh-src/@deepseek-ai/cordis/src/fiber.ts:50-62、646-673 — 同步 validate；_reload 捕获异常只 logger.error; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4216-4252 — installFailLoud：unhandledRejection → exit(1); node -e 实验：new 一个返回 rejected Promise 的 function 声明，结果就是那个 Promise，并触发 unhandledRejection；async 函数没有 prototype; dsh-src/@deepseek-ai/cordis-plugin-loader/src/config/tree.ts:35-49 与 dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4535-4541 — loader.await() 等待每行的 fiber.inertia；boot() 在启动审计前等它; dsh-src/@deepseek-ai/cordis/src/service.ts:11-59；dsh-src/@deepseek-ai/cordis/src/reflect.ts:277-305 — Service 自注册；ctx.provide 零依赖提供服务; dsh-src/@deepseek-ai/dsh-client-hmr/lib/index.js:2、18-21、172 — 官方写法：import z，具名导出 name、inject、Config、apply（function 声明）; dsh-src/@deepseek-ai/schemastery/README.md:392-394；src/index.ts:480-482 — .volatile() 与 .get(); dsh-src/@deepseek-ai/cordis-plugin-loader/src/config/entry.ts:140-197 — 只改 volatile 时就地提交；188-191 行的过滤器是 owner.fiber === fiber; dsh-src/@deepseek-ai/cordis-plugin-loader/README.md:53 — a non-Schemastery schema compares raw；事件只发给 owning fiber; dsh-src/@deepseek-ai/cordis/src/fiber.ts:736-753 — 普通配置变化走 fiber.update → restart; dsh-src/@deepseek-ai/cordis-plugin-loader/src/index.ts:104-113、src/config/utils.ts:5-9 — !!js 以 with(ctx) 求值; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:57-64; dsh-src/@deepseek-ai/dsh-settings/README.zh.md:12、33、39; dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md:73-83、131 — 配置 slot 的 key 格式，以及 form.state / form.mutate

## [corrected] Q1-d ctx.effect / ctx.on / ctx.get / inject（以及 ctx.inject、ctx.plugin、ctx.provide、ctx.logger）的用法与语义

ctx 上混入的核心方法：reflect 的 get、set、provide、accessor、mixin；fiber 的 runtime、effect；registry 的 inject、plugin；events 的 on、once、parallel、emit、serial、bail、waterfall。logger、events、reflect、registry 是根 ctx 的自有属性，不需要 inject。
1) 插件字段 inject：可以是数组，也可以是「服务名 → 拦截配置」的对象。所有服务都可用才执行 apply；缺一个就停在 PENDING。optional 行启动时只警告「等待服务」，required 行会让启动失败。epoch 由所依赖服务提供方的 fiber uid 拼成：提供方一重启或消失，本插件先卸载，服务回来后再重新 apply。
2) 读服务：ctx.X 会沿本 fiber 及祖先 fiber 的 store 查找；没 inject、又不在祖先上，就抛 cannot get property "X" without inject。根上 provide 的服务（dshHomePath、profileContext）可以直接读；由其他行提供的服务（webServer、agents、timer、schedule……）必须 inject。
3) ctx.get(name, strict=true)：不建立依赖。服务不存在、或提供方 fiber 不是 ACTIVE 时返回 undefined；服务之后出现也不会让插件重跑。
4) ctx.inject(deps, cb) 等价于 ctx.plugin({ inject: deps, apply: cb, name: cb.name })，是处理可选依赖的正确写法：服务齐了才跑，服务消失整块卸载。回调形态的规则见 Q1-c。
5) ctx.effect(execute, label?)：
- execute 立即执行，可以返回清理函数、Promise<清理函数>、同步或异步生成器（每个 yield 出来的清理函数都登记）。返回值是一个 disposer，可手动调用。
- 同一个 effect 内的清理函数按逆序串行执行，异步的逐个等待。
- 插件整体卸载时，各个顶层 effect、ctx.on、ctx.provide 的 disposer 按逆序启动，但用 Promise.all 并发执行并全部等完；单个抛错只记日志。所以不同 effect 之间的清理没有先后保证，有顺序要求就放进同一个 effect，用生成器依次 yield。
- fiber 已释放或正在卸载时调用 ctx.effect，抛 CordisError INACTIVE_EFFECT。在裸定时器回调里同步抛出会致命。
6) ctx.on(name, listener, options?)：
- 监听器归本插件 fiber，卸载时自动移除；返回值是手动移除用的 disposer。options 传布尔等于 { prepend }，还支持 { global }（无视派发方的上下文过滤）。
- 派发方式由发出方决定：emit 同步调用，不等待也不捕获；parallel 等待全部，失败汇成 AggregateError 抛给发出方；serial 逐个 await，第一个异常抛给发出方；bail 同步逐个调用；waterfall 必须 return next()。
- 关键：serial 和 bail 会把监听器的返回值当作短路值。只要返回的不是 undefined、null、false，后面的监听器就不再执行。agent/created 正是用 ctx.serial 派发的，所以 agent/created 监听器一定要写块体、不 return 任何值；不要写 ({agent}) => agent.ctx.effect(...) 这种表达式箭头。
7) ctx.plugin(mod, config)：挂一个子插件，归本插件所有。ctx.provide(name, value)：注册服务，本插件卸载时撤销，同名已存在会抛错。ctx.logger('name')：返回带 info、warn、error、debug 的 logger，输出去向见 Q5-e。
8) 不会自动跟随本插件的东西，必须自己包进 ctx.effect：裸的 setTimeout/setInterval、ctx.webServer.register() 返回的 disposer（webServer 不会登记到调用方的 fiber）、fs.watch、子进程、Node 全局设置。在 agent.ctx 等别的上下文上注册的东西有两个主人，要把它的 disposer 同时登记进本插件自己的 effect。
9) ctx.timeout / ctx.interval 来自 cordis-plugin-timer（行 id 是 timer），是对 ctx.timer 的混入，使用前要 inject: ['timer']。它们只负责在卸载时清除定时器，不捕获回调里的异常。ctx.timeout(ms) 的 Promise 写法在卸载时会以 'Context has been disposed' reject。

```
export const inject = ['webServer', 'agents']   // 示例；生产建议把 webServer 放进 ctx.inject 子插件（见 Q1-e）
export function apply(ctx, config) {
  const log = ctx.logger('agent-hub')           // 不需要 inject；只写内存缓冲，调试用 console.*
  // webServer.register 不会自动跟随本插件卸载 → 必须包进 ctx.effect，否则重载后报 duplicate prefix route
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/agent-hub',                          // 不要用 /api（Connection 占用）或 /plugins（client-modules 占用）
    async handler(req, res) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    },
  }), 'agent-hub: http')
  const isDesktop = ctx.get('profileContext')?.name === 'desktop'   // 可选读取，不建依赖
  ctx.inject(['schedule'], (sub) => {           // 可选依赖：服务齐了才跑，消失整块卸载
    sub.effect(() => () => log.info('schedule gone'))
  })
  // agent/created 由 ctx.serial 派发：块体、不 return 任何值，否则后面的监听器（含官方）被短路；异常要自己兜住
  ctx.on('agent/created', ({ agent, source }) => {
    try { /* 只处理机器人会话 */ } catch (e) { console.error('[agent-hub]', e) }
  })
}
```

> 核查说明：原说法「插件卸载时……按注册的逆序清理」不准确：只有同一个 effect 内部的 disposer 是逆序串行的；插件卸载时 _unload 对各顶层 disposer 逆序启动、Promise.all 并发执行（fiber.ts:675-686、utils.ts:27-31）。补充：serial 和 bail 的返回值短路语义（events.ts:13-15、204-222）；agent/created 是用 ctx.serial 派发的（dsh-agent/lib/index.js:581）。官方监听器（session-controller 的 publishAgentAvailability、dsh-goal 等）都是块体无返回值。一旦我们的监听器排在它们前面并返回了值，它们就收不到新 agent；例如对方被 HMR 重载后重新注册，就会排到队尾。其余逐条属实。

证据：dsh-src/@deepseek-ai/cordis/src/reflect.ts:219-222 — 混入方法清单; dsh-src/@deepseek-ai/cordis/src/context.ts:71-84 — reflect、registry、events、logger 是根 ctx 的自有属性; dsh-src/@deepseek-ai/cordis/src/reflect.ts:136-171 — 沿祖先 fiber 查找，没有 inject 时抛 cannot get property ... without inject; dsh-src/@deepseek-ai/cordis/src/reflect.ts:233-243 — get(name, strict); dsh-src/@deepseek-ai/cordis/src/reflect.ts:277-305 — provide 归调用方 fiber，重复注册抛错; dsh-src/@deepseek-ai/cordis/src/reflect.ts:364-390 — mixin 通过 ctx[source] 访问，所以 ctx.timeout 需要能读到 ctx.timer; dsh-src/@deepseek-ai/cordis/src/registry.ts:300-302; dsh-src/@deepseek-ai/cordis/src/fiber.ts:418-442 — 单个 effect 内的 disposer 逆序串行; dsh-src/@deepseek-ai/cordis/src/fiber.ts:675-696 与 utils.ts:27-31 — 卸载时对各顶层 disposer 逆序启动、Promise.all 并发执行; dsh-src/@deepseek-ai/cordis/src/fiber.ts:351-354、418-422 — INACTIVE_EFFECT; dsh-src/@deepseek-ai/cordis/src/fiber.ts:611-623 — epoch 由依赖提供方的 uid 拼成; dsh-src/@deepseek-ai/cordis/src/events.ts:13-15、112-117、183-243、288-302 — isBailed、EventOptions、各种派发方式、on; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:574-590 — announce 用 ctx.serial 派发 agent/created; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2986-2990；dsh-src/@deepseek-ai/dsh-goal/lib/index.js:594-596 — 官方 agent/created 监听器都是块体、无返回值; dsh-src/@deepseek-ai/dsh-host-webserver/lib/index.js:325-332 — register 只返回 disposer，不登记到调用方 effect; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4526；dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:302-305 — dshHomePath、profileContext 在根上 provide; dsh-src/@deepseek-ai/cordis-plugin-timer/src/index.ts:12-66; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:8、16、19、20、29

## [corrected] Q1-e 插件的重载、卸载、清理生命周期

激活顺序：
① Loader import 模块，执行 unwrapExports；
② 用 registry.plugin 建立 fiber，状态为 PENDING；
③ 等 inject 里的服务全部可用；
④ 走 internal/config waterfall：先对 !!js 求值，再执行 Config['~standard'].validate；
⑤ 执行 apply（或 new Class 后调用 [Service.init]()）；
⑥ 按 Q1-c 的规则收集返回的 effect。
启动时 boot() 会 await loader.await()，等所有行的导入和 LOADING 都结束，才做启动审计、打印 URL、通知桌面 ready。

会触发卸载或重载的情况：
① 行被禁用或删除：改 profile patch、插件页开关、remove_bundle。
② 组合包被取消选择或卸载。
③ 任一 inject 服务的提供方重启或消失：先卸载，服务回来后再 apply。
④ 行 config 的普通字段变了：fiber.update → restart，整行重新挂载。只改 volatile 字段时就地提交。
⑤ HMR 或插件管理器重组时，profile 目录和链接包目标里已加载文件变了的插件会被停掉，再用新代码启动；新代码失败时旧版本不恢复。
⑥ 进程退出：SIGINT/SIGTERM 走 createProcessShutdown，给 5 秒宽限，超时强制退出；桌面宿主收到 shutdown IPC 也走 shutdown.shutdown(0)。致命错误时 installFailLoud 最多等 2 秒释放。
⑦ 客户端半边被 dsh-client-hmr 热替换，React 状态会丢失。
⑧ 插件自己调用 ctx.fiber.dispose()：Loader 会把它当成「禁用该行」，把 entry.options.disabled 设为 true 并写回配置树，而不是「暂停」。

清理语义：fiber 卸载时，各个顶层 disposable 并发执行并全部等待，单个抛错只记 error。apply 同步抛错或异步 reject 只记 error，该行标记为失败，兄弟插件继续运行；required 行在启动时例外。

对 Agent 中心的后果：
- 通过本插件 ctx 调用 ctx.agents.create/resume 开出的 agent，以本插件 ctx 为 owner（用 ownerCtx.effect 登记生命周期）。
- 本插件任何一次重载都会执行 machine.cancel({kind:'disposed'})，打断正在跑的这一轮。这包括改一个非 volatile 配置、被依赖的服务重启、HMR 替换代码。
所以：
① 可调参数用 volatile；
② 状态随时落盘；
③ 顶层 inject 只放核心运行必需的服务，webServer 等放进 ctx.inject 子插件，避免它们重启时连带取消机器人；
④ 机器人会话的归属可以参考官方 dsh-schedule：用 ctx.sessionController.resolveAgent(sessionId) 取到 agent，会话归 sessionController 管，再 followup。

> 核查说明：原结论核对属实。补充 3 点：⑧ 自我 dispose 的后果（cordis-plugin-loader/src/index.ts:160-165）；启动会等 loader.await()，所以 apply 里的长任务会拖慢就绪；顶层 inject 的服务重启会连带取消机器人（fiber.ts:611-623 + agent-loop:1749-1764），建议把可选服务放进 ctx.inject 子插件。

证据：dsh-src/@deepseek-ai/cordis-plugin-loader/src/config/entry.ts:118-157、223-238; dsh-src/@deepseek-ai/cordis/src/fiber.ts:611-696、736-753 — epoch、_reload、_unload、update → restart; dsh-src/@deepseek-ai/cordis-plugin-loader/src/index.ts:129-166 — case 6：自我 dispose → entry.options.disabled = true 并 tree.write(); dsh-src/@deepseek-ai/cordis-plugin-loader/src/config/tree.ts:35-49；dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4535-4541 — 启动等 loader.await(); dsh-src/@deepseek-ai/dsh-hmr/README.zh.md:49、113; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:12-71、276-288 — 5 秒有界关闭；SIGTERM、SIGINT；installFailLoud; dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:258-262 — 桌面宿主调用 shutdown.shutdown(0); dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4174、4216-4252 — 致命错误时释放最多等 2 秒; dsh-src/@deepseek-ai/dsh-client-hmr/README.zh.md:36、48; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:98-113 — 失败矩阵; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:453-470 — create/resume 以调用方 ctx 为 owner; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:1703-1764 — owner 卸载触发 teardown，执行 machine.cancel({kind:'disposed'}); dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1576-1596 — sessionController.resolveAgent 后 followup

## [corrected] Q2-a 一个插件包怎么同时带宿主半边和客户端半边

1) 一个包对应一行 Loader 行，行的 name 必须正好等于包名（例如 dsh-agent-hub），这一行用 exports['.'] 挂宿主半边。dsh-client-modules 的 Node 半边只处理已有 fiber、未被禁用的行：行名是精确包名或文件路径（路径行会去找最近的 package.json），并且该包声明了 dsh.client.platform='web'，就把它的 ./client 产物放进 window.__DSH_BOOT__，并在 /plugins/... 下提供。浏览器半边与这一行同生共死，这一行被禁用时页面也会消失。官方的双面包就是这种结构，例如 dsh-api-job-controller、dsh-client-modules。
2) 宿主半边如果只是占位，就写 export function apply() {}，官方模板就是这样。
3) ./client 必须是预先构建好的浏览器脚本：不能有 import 语句，只能调用 window.__ModuleLoader__.load({ id, factory(require) {...} })。
- id 必须等于包名；<包名>/client 与包名指向同一组导出。
- factory 里 require 基座模块要用全名键（见 Q1-a），基座之外的模块列进 dsh.client.external。
- factory 返回 Cordis 客户端插件 { inject: ['slots', ...], apply(ctx) {...} }。浏览器 Loader 同样按 e.default ?? e 解析，所以返回普通对象即可，不需要标 Symbol.toStringTag。
4) 有两个不同的 inject，不要混：dsh.client.inject 写客户端包名，只管到达顺序；factory 返回对象上的 inject 写客户端 Cordis 服务名，例如 'slots'。
5) 页面挂载点按官方写法注册：ctx.slots.inject(slot 名, () => ctx.slots.register({...}, Component))。全局总览页用 'main'（key 是面板 id）加 'sidebar.panellist'（id 是同一个面板 id，再加 order、label；官方 schedule 还传了 locale）。slot 的具体选项以运行中 cordis_inspect_query 的 Slots.listSubTree 为准。
6) 同一个包要挂多个宿主子插件，用 exports 子路径，例如 './scheduler': './lib/scheduler.js'，行名写 dsh-agent-hub/scheduler；官方有 @deepseek-ai/dsh-web-app/startup、@deepseek-ai/dsh-plugin-manager/tools 这样的先例。子路径行永远不带浏览器半边；它的展示元信息用 './scheduler/locale/*.json' 和 './scheduler/icon' 导出。也可以在 apply 里调用 ctx.plugin(子模块)。不要用 ./lib/x.js 这种相对路径行：它会被识别成同一个包的第二个来源，报「resolves from multiple active Loader sources」，组合失败。
7) 宿主与界面之间的通信：
- 现成做法是在宿主上 ctx.webServer.register 路由，界面用文档相对路径 fetch，与官方 bundle 的 plugins/... 引用方式相同。
- web 版页面与宿主同源。桌面版页面在 dsh-app://app：Electron 主进程只直接提供 /、/index.html、/assets/*、/favicon.svg、/manifest.webmanifest，其余路径连同 query、方法、请求体，带上宿主 cookie 转发给宿主，并拒绝其他 Origin。所以相对路径在两边都能用；绝对的 http://127.0.0.1:端口 在桌面版用不了（端口随机，而且跨源）。路由不要放在 /assets/ 下。
- 安全：直接注册在 webServer 上的路由不经过 Connection 的 Host/Origin 校验和 cookie 鉴权（admit 只作用于 Connection 自己的 /api 前缀路由和 /connect）。知道端口的本机任意进程都能直接调用。前缀注册成 /api/xxx 会按最长前缀抢在 Connection 的 /api 之前匹配，同样绕过鉴权；用户样板 dsh-auto-upgrade 就是这样挂在 /api/dsh-upgrade 上的。
- 改变状态的接口（审批、扣额度）可以考虑 ctx.connection.fetch.register({ path: '/api/<段>/...', methods: ['GET','POST'], requestBody: 'buffered', fetch: async (request) => new Response(...) })：只支持精确路径，只接受 owner Peer，随调用方 ctx 的 effect 自动释放。细节归通信专题核对。
8) 改了插件自己的 package.json（exports、dsh.client、engines）不会被热重载检测到；client-modules 也把包元数据缓存到重启为止，所以要重启。

```
// lib/client.js —— 预构建浏览器脚本（不能有 import）
window.__ModuleLoader__.load({
  id: 'dsh-agent-hub',                        // 必须等于 package.json 的 name
  factory(require) {
    const React = require('react')           // 基座模块表的键；其他基座键要写全名，如 '@deepseek-ai/dsh-client-store'
    const h = React.createElement
    const PANEL_ID = 'agent-hub'
    function HubIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true },
        h('circle', { cx: 8, cy: 8, r: 6, fill: 'currentColor' }))
    }
    function HubPage() {
      const [bots, setBots] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        // 文档相对路径：web 版页面与宿主同源；桌面版页面在 dsh-app://app，主进程把非静态路径连同 cookie 转发给宿主
        fetch('agent-hub/api/bots').then((r) => r.json()).then((d) => { if (alive) setBots(d) }).catch(() => {})
        return () => { alive = false }
      }, [])
      return h('div', { style: { padding: 16 } }, bots === null ? 'Loading…' : JSON.stringify(bots))
    }
    return {
      inject: ['slots'],                      // 客户端 Cordis 服务名（不是 dsh.client.inject 的包名）
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, HubPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: () => 'Agent Hub',
        }, HubIcon))
      },
    }
  },
})
```

> 核查说明：原结论 1-8 条核对属实。补充 4 点：① 桌面版页面的来源是 dsh-app://app，以及主进程的转发规则（相对路径之所以可用的真正原因）；② 直接注册在 webServer 上的路由没有 Host/Origin 校验，/api/xxx 前缀会绕过 Connection 鉴权；③ 带鉴权的替代方案 ctx.connection.fetch.register（签名来自源码阅读，归通信专题复核）；④ 子路径行的展示元信息要单独导出。

证据：dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:83-90、720-766、851-896 — exactPackageSpecifier；resolveMeta / locatePkgJson（子路径行返回 undefined，路径行找最近的 package.json）；processOne 只处理已有 fiber、未禁用的行；同一个包有多个来源时抛错; dsh-src/@deepseek-ai/dsh-client-modules/README.zh.md:34、38、51、55、77; dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md:133 — 浏览器半边只挂在说明符正好是包名的那一行上; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/index.js:1-2、client.js:1-22；references/ui-plugin.md:3-13; dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:7473-7491 — main（key）与 sidebar.panellist（id、order、label、locale）; dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js — 浏览器端 unwrapExports：e.default ?? e; dsh-src/@deepseek-ai/dsh-api-job-controller/package.json（exports 含 ./client，dsh.client.platform 为 web）与 dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:127; dsh-src/@deepseek-ai/dsh-web-app/package.json exports['./startup']、dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:168-169；dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:16-17; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:51 — 子路径插件用 ./<sub>/locale/*.json、./<sub>/icon; _app/main.js:12406-12414 — dsh-app://app 只直接提供 /、/index.html、/assets/*、/favicon.svg、/manifest.webmanifest，其余转发给宿主; _app/main.js:8268-8299 — forwardWebRequest：拒绝非 dsh-app://app 的 Origin，带宿主 cookie 原样转发路径与 query; dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:1044-1064 — 只有 Connection 自己的 /api 前缀路由与 /connect 调用 admit（Host/Origin 校验 + cookie）; dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:732-735、840-853、973-977 — ctx.connection.fetch.register：/api/ 下的精确路径、methods 非空、只接受 owner Peer、随调用方 ctx 的 effect 释放; dsh-src/@deepseek-ai/dsh-client-connection/README.zh.md:41-47; dsh-src/@deepseek-ai/dsh-host-webserver/lib/index.js:495-504 — 先匹配精确路由，再匹配最长前缀; /Users/bytedance/Documents/DSHarness Doc/dsh-auto-upgrade/plugin/lib/index.js:72-109、lib/client.js:7-16 — 样板把路由挂在 /api/dsh-upgrade；toStringTag 并非必需

## [corrected] Q2-b 组合包的 cordis.patch.yml 能做什么（挂载子插件、改配置），格式和最小例子

格式：文件必须是一个顶层 YAML 数组，每一项是一个 patch。不是数组时：组合包自己的 patch 出错，整个组合包被跳过；用户层（profile 的 cordis.patch.yml 和 $DSH_HOME/cordis.patch.yml）出错，则启动失败。空文件或只有注释的用户层文件也会让启动失败，要关掉这一层就写 []。
支持的写法：
1) - insert: [行...]：在末尾追加行。同时带 id、且该 id 指向某个 group: true 的行时，追加到该分组的 config 列表里。插入的行会立即建立索引，同一层里后面的 patch 能按 id 改它。
2) - id: X，不带 insert：按 id 定位已有的行。给出的字段整字段替换，config 也是整体替换、不深合并，所以要重述这一行需要的全部字段。可以只写 disabled 来开关。name 写了只做断言，不改名；不一致就跳过并警告。
3) 非 insert 的 patch 没有 id，或者 id 匹配不到任何行：只打警告并跳过，不报错。
4) 行的字段：id、name、config、disabled、inject、intercept、isolate、group。name 可以是：包名、包的 exports 子路径、绝对路径、./ 或 ../ 相对路径（以 patch 文件所在目录为锚，转成 file URL；只对 insert 的行生效），以及 cordis:group、cordis:include。行级 inject（例如官方 webserver 行的 inject: [webStartup]）会让该行等这个服务出现后，才对 config 里的 !!js 求值。
5) !!js 只在 config 和 disabled 里求值，其他行元数据保持字面量。求值方式是 with(ctx)，可以用 process.env.X、ctx.get('profileContext')?.name、dshHomePath('...') 这类表达式。disabled 的 !!js 每次做挂载决定时都会重新求值；求值抛错算该行失败，不算禁用。
6) cordis:group 加 group: true，可以把一组行放进同一个 isolate realm。
7) 层级顺序，后面的胜出：dsh.profile.bundles 里各组合包按列表顺序 → profile 自己的 cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch 覆盖层 → 遥测开关。插件页重新开启一个组合包时，它会被追加到列表末尾，可能改变优先级。
8) 做不到的事：删除一行（只能 disabled）、深合并 config、给行改名。
风险提示：
- 覆盖官方 required 行时（id 为 agent-loop、webserver、web-runtime、modules、connection、headless-runner、acp、sdk-jsonrpc-server），一旦让它们激活失败，整个应用启动失败。
- 自己的行 id 必须全局唯一：同名会被当作 required；patch 按 id 建索引，后插入的同 id 行还会抢走后续 patch 的目标。
- HMR 只监视 profile 清单和两份用户 patch，不监视组合包自己的 patch 文件；改了要等下一次重组或重启才生效。

```
# cordis.patch.yml —— 示例集合（按需取用；文件必须是顶层 YAML 数组，空文件写 []）
# 1) 插入本插件：name = 包名 → 宿主半边 + 浏览器半边都挂在这一行
- insert:
    - id: agent-hub                         # 全局唯一；别用官方 id（modules/webserver/connection… 是 required）
      name: dsh-agent-hub
      config:
        maxConcurrent: 2
        tickSeconds: 60
        dataDir: !!js dshHomePath('agent-hub')   # 跟随 $DSH_HOME：沙箱和桌面版数据天然隔离
    # 2) 同包的宿主子插件：走 exports 子路径（'./scheduler': './lib/scheduler.js'），不带浏览器半边
    - id: agent-hub-scheduler
      name: dsh-agent-hub/scheduler
      disabled: !!js "ctx.get('profileContext')?.name === 'headless'"

# 3) 行级 inject：等服务出现后才对 config 里的 !!js 求值（官方 webserver 行同款写法）
- insert:
    - id: agent-hub-web
      name: dsh-agent-hub/web
      inject: [webServer]
      config:
        port: !!js ctx.webServer.port

# 4) 改已有行：按 id 定位，config 整体替换（重述全部字段）
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: first-search

# 5) 分组 + 往分组里追加
- insert:
    - id: agent-hub-group
      name: cordis:group
      group: true
      config:
        - id: agent-hub-extra
          name: dsh-agent-hub/extra
- id: agent-hub-group
  insert:
    - id: agent-hub-extra-2
      name: dsh-agent-hub/extra2
```

> 核查说明：原结论核对属实。补充 4 点：① 顶层必须是数组，以及组合包层与用户层出错的不同后果（跳过 vs 启动失败），空文件要写 []；② 行级 inject 可以延迟 !!js 求值；③ disabled 的 !!js 抛错算该行失败；④ 同 id 会抢走后续 patch 的目标（buildMap 覆盖）。删除了原例里与 Agent 中心无关的 MCP 片段（模板见 templates/mcp/cordis.patch.yml:1-8，核对属实）。

证据：dsh-src/@deepseek-ai/cordis-plugin-include/src/index.ts:57-127 — applyEntryPatches：insert、插入分组、id 必填、未命中只警告、name 断言、字段整体替换、buildMap 按 id 建索引; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/SKILL.md:12-23; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:3961-4004 — loadOverlayPatches、anchorInsertedPluginNames、parsePatchList（必须是顶层数组）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:1015-1045 — 组合包 patch 出错就跳过该组合包；用户层出错照常抛; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:50、61、63、65 — 用户层错误导致启动失败；空文件或只有注释会启动失败；HMR 监视范围；insert 名字解析; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:223-247 — 层级顺序; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:179-188 — 行级 inject: [webStartup]，config 里用 !!js ctx.webStartup.*; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:104 — disabled 的 !!js 抛错不当作已禁用; dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md:40; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4270-4279 — required 行的 id 清单; dsh-src/@deepseek-ai/dsh-experimental-session-search/cordis.patch.yml:1-14；dsh-src/@deepseek-ai/dsh-experimental-plugin-market-bundle/cordis.patch.yml:5-10；dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:138-141、157-161

## [confirmed] Q3-a dsh plugin --profile <p> add link:<dir> 的实际效果（装到哪里、发生了什么）与卸载命令

1) 用哪个 dsh：桌面版自带的 CLI 在 /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh。它是一个 sh 脚本，用 ELECTRON_RUN_AS_NODE=1 执行 app.asar 里的 dsh-desktop-host/lib/cli.js，自带 pnpm，以 manageDesktopProfile:true 调用 runCli。只有它能对 desktop 跑 plugin 子命令；npm 装的 dsh 遇到 --profile desktop 的 plugin 请求会直接拒绝。任何 dsh 都拒绝用 --profile desktop 启动或 dump 配置。
2) 装到哪里：$DSH_HOME/profiles/<p>/，DSH_HOME 默认是 ~/.dsh；桌面版就是 ~/.dsh/profiles/desktop。
- CLI 把 --profile 之后的参数原样转给 pnpm，在 profile 目录里执行。link:./x、link:../x、./x 这类相对路径会以你执行命令时的目录为锚，转成绝对路径。
- profile 的 pnpm 设置是 nodeLinker: hoisted、autoInstallPeers: false。
- 结果：profile 的 package.json 的 dependencies 里多一项 link 依赖，写 pnpm-lock.yaml，node_modules/<包名> 变成指向源码目录的符号链接。
3) pnpm 成功后执行 reconcile：新依赖如果声明了 dsh.bundle.patch，就先解析一遍它的 patch 文件，再把包名追加到 dsh.profile.bundles 末尾；没声明的只打警告「declares no dsh.bundle — installed as a plain dependency」。dsh-auto-upgrade/plugin 没有 dsh.bundle，用这条命令装它不会被激活。
4) 版本：安装前读目标 manifest 做预检，不兼容就「nothing was installed」；安装后对新增或变更的依赖及其组合包组件再查一次，不兼容就恢复 package.json 和锁文件，并用 pnpm install --frozen-lockfile 复原 node_modules。
5) 锁和日志：与宿主内的插件管理器共用 profile 的 package.json 写锁，最多等 120 秒。每次操作的日志在 <profile>/.plugin-manager/logs/operation-*/pnpm.log；失败时 stderr 会打印 diagnostics 路径。
6) 初始化：desktop profile 的 package.json 不存在时，报错「Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it…」。desktop 走 withFileLock + runProfilePnpm，不会自动初始化。非 desktop 的名字不存在时会自动初始化：名字是随附模板就按模板，否则只放 [dsh-base]。
7) 卸载：dsh plugin --profile <p> remove <包名>，写包名不写路径。pnpm remove 之后，reconcile 把包名从 bundles 里删掉；插件自己存的数据文件不会被删。只想停用不卸载：插件页开关、plugin_manager 的 set_bundle/set_plugin，或在 profile 的 cordis.patch.yml 里加一行 - id: <行id> 和 disabled: true。
8) 其他安装通道：
- 插件页「添加插件」：接受包名、Git 地址、压缩包、本地绝对路径。
- plugin_manager 工具：8 个动作，list_plugins、list_bundles、set_plugin、set_bundle、install_bundle、remove_bundle、list_version_exemptions、set_version_exemption。每次都要 danger-full-access 或你批准，默认只在 Creator 预设里启用。

```
# 桌面版（先完全退出桌面 App；路径含空格需引号——按用户习惯应写进脚本文件再让用户运行）
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "link:/绝对路径/dsh-agent-hub"
# 卸载（按包名）
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop remove dsh-agent-hub
# 查看 / 授予 / 撤销精确版本豁免
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop version-exemptions
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop allow-version dsh-agent-hub@0.1.0 --dsh-version <精确DSH版本> --accept-risk
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop revoke-version dsh-agent-hub@0.1.0 --dsh-version <精确DSH版本>
```

> 核查说明：逐条核对属实，行号已校正。补充：desktop profile 走 withFileLock + runProfilePnpm，不经 runPluginCommand，所以不会自动初始化。

证据：/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh:13-14; dsh-src/@deepseek-ai/dsh-desktop-host/lib/cli.js:94-107 — runDesktopCli：manageDesktopProfile:true，自带 pnpm; dsh-src/@deepseek-ai/dsh/lib/bin.js:35-37、101-137、207-238 — rejectElectronProfile；plugin 子命令只对带 manageDesktopProfile 的 CLI 放行 desktop; dsh-src/@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:10-12、63-99 — desktop 必须已初始化；锁最多等 120 秒；转给 pnpm; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:71-77、83-87、96-125 — anchorPathSpec、bundleManifest、reconcile; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:299-330、351-374、496-560、591-604 — 日志目录、预检、安装后检查与复原、runPluginCommand 初始化; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:546-557、570、598-627 — profile 路径、模板、默认组合包、pnpm 设置、initProfile; _app/main.js:79-84、3636-3638 — 桌面 profile 路径与 lock；用 web 模板的组合包初始化; dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md:31、40、98、160; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js:68-79 — 8 个动作与审批; dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md:57

## [confirmed] Q3-b 依赖怎么解析；链接插件能否有自己的 node_modules

有三层规则：
1) 组合包目录解析：先用 dsh 安装锚点找，再用 profile 目录找。所以官方组合包名永远指向安装里的那一份。
2) 运行时解析表：启动器把安装依赖图和选中组合包的依赖图合成一张不可变的表，装进 Node 的 ESM 和 CommonJS 解析器，不建链接。
3) 按 importer 所在位置分两种情况：
- profile 目录内的 importer：先找 profile 内的物理副本，找不到再用运行时表。所以一旦把 @deepseek-ai/* 写进 dependencies，pnpm 会把副本装进 profile 的 node_modules；profile 内的代码拿到副本，宿主用的是安装里的那份，服务实例对不上（看板踩过这个坑）。
- linked root 下的 importer（linked root 指 profile 的 node_modules 里指向 profiles 树之外的符号链接，例如 link: 进来的插件目录）：请求的包名不在运行时表里，就走原生 Node 解析（插件自己的 node_modules 及祖先目录）。在表里，就从 importer 往上逐层看：哪一层目录 D 的 package.json 在 peerDependencies 里列了它，就用宿主那份；否则 D/node_modules 里有物理副本就用副本；都没有就落回原生解析，通常报找不到模块。
结论：
- 链接插件可以有自己的 node_modules，放普通第三方依赖。
- 要复用宿主的 @deepseek-ai/cordis、@deepseek-ai/schemastery、zod，就写进插件根 package.json 的 peerDependencies。peer 名字只要不是 @deepseek-ai/dsh 或 @deepseek-ai/dsh-*，就不参与版本闸门。
- link: 安装时，依赖要在插件目录里自己装好，或者打包进 lib；官方说明是链接包使用该 checkout 的依赖与 peer。最省事的是零运行时依赖。
- 链接目录挪动位置后要先卸载再重装，否则报 ResolutionRestartRequired。

> 核查说明：核对属实（中等置信）。细化：routeLinked 在同一层先看 peer、再看物理副本。所以插件根 package.json 声明了 peer 时，即使根 node_modules 里有开发用副本，也会路由到宿主那份；但更靠近 importer 的层（例如 lib/node_modules）里的物理副本会先命中。pnpm 对 link: 依赖是否完全不安装其依赖，仍未实测。

证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:976-1001 — packageDirFromAnchor / resolveBundleDir：先安装锚点，再 profile; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:664-690 — linkedProfileRoots; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:1337-1356 — findInterceptionLayer 与 readPeerNames; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:1613-1675 — routeScoped：profile 层先用本地物理副本; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:1676-1729 — routeLinked：不在表里走原生；同一层先看 peer，再看物理副本，否则原生; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:67、134、138、199; dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md:50; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md:18; dsh-src/@deepseek-ai/dsh-experimental-plugin-market-bundle/package.json:39-40 — 官方组合包把 @deepseek-ai/cordis 写成 peer

## [confirmed] Q3-c 装完或改完要不要重启；HMR 覆盖到哪里

1) 桌面版和 web profile 都开着 HMR：dsh-base 的 hmr 行只在没有 profileContext 时禁用，CLI 和桌面宿主都会提供 profileContext。但配置是 root: []，不监视源码，只监视 3 个文件：
- profile 的 package.json（只有 dsh.profile.bundles 列表变化才触发）；
- profile 的 cordis.patch.yml；
- $DSH_HOME/cordis.patch.yml。
headless、sdk、acp 这三个组合包会把 HMR 关掉，改什么都要重启。
2) 走插件管理器（插件页或 plugin_manager 工具）：操作完立即重组。结果的 application 是 applied、failed、overridden 或 restart-required（另有 cancelled）。restart-required 附带 restartReason：no-hmr、package-moved 或 HMR 待处理原因。官方指南的说法：新装的组合包可以经 HMR 直接激活，替换已安装的包要重启才能加载新一代代码。
3) 用 CLI 的 dsh plugin 改桌面 profile：官方流程是先完全退出桌面版，装完再打开。「只改依赖」不会触发重组；在插件管理器之外重新链接一个仍处于安装状态的包，要等重启。稳妥做法：退出 → 安装 → 重开。
4) 改链接插件的宿主源码：不被监视。下一次重组时（由插件管理器操作、或修改上面那 3 个文件触发），文件已变化的插件会被停掉、换上新代码；新代码失败时旧版本不恢复。最可靠的是重启：沙箱 Ctrl+C 后重跑，桌面版完全退出后重开。
5) 改 lib/client.js：web 组合常驻挂着 dsh-client-hmr，它每 500ms 检查一次每个图条目 client bundle 的 mtime、ctime 和大小，有变化就调用 clientModules.rebuilt(id)，已打开页面里的这个插件被热替换，React 状态丢失（代码层结论，未实测）。
6) 改插件自己的 package.json 或组合包的 patch：检测不到；client-modules 还把包元数据缓存到重启为止，所以要重启。
7) DSH 升级之后：页面只应用启动时那个 release 的图，必须刷新页面。

> 核查说明：核对属实（中等置信）。官方两处文档对「替换已装包是否需要重启」说法不一：host-plugin.md:70 说要重启，hmr README:49 说下次重组会替换已变化的文件。原结论已如实并列。

证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:20-32; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:290-305; dsh-src/@deepseek-ai/dsh-headless/cordis.patch.yml:32-33；dsh-src/@deepseek-ai/dsh-sdk-app/cordis.patch.yml:23-24；dsh-src/@deepseek-ai/dsh-acp-app/cordis.patch.yml:22-23; dsh-src/@deepseek-ai/dsh-hmr/README.zh.md:27、43、49、59、109、113、118; dsh-src/@deepseek-ai/dsh-plugin-manager/README.zh.md:14、60、100、141-142; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:66-70; dsh-src/@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:11; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:214-219; dsh-src/@deepseek-ai/dsh-client-hmr/lib/index.js:18-21、42-110; dsh-src/@deepseek-ai/dsh-client-modules/README.zh.md:47、77

## [corrected] Q4 错误隔离：哪些地方抛错会让整个宿主崩溃，插件里应该怎么包

一、会致命的情况。宿主装了 installFailLoud：遇到 unhandledRejection 或 uncaughtException，就往 stderr 写诊断，最多等 2 秒释放资源，然后 exit(1)。桌面宿主非预期退出后会弹原生错误框，三个按钮是「退出 / 重启 / 禁用第三方插件、备份 profile patch 并重启」，不会自动拉起。选第三项会把 bundles 重置为 web 模板，并把 profile 的 cordis.patch.yml 改名为 .bak-<毫秒时间戳>（home patch 不变，已装的包保留），中心插件和它在 profile 里的配置会一起被摘掉。具体有这些：
1) 脱离 apply 的同步回调里抛出未捕获异常：setTimeout/setInterval 回调（包括 ctx.timeout/ctx.interval，它们只清理、不捕获）、流的 'data' 回调、子进程或 fs.watch 回调、process.nextTick。在已卸载的插件上调用 ctx.effect / ctx.on 抛出的 INACTIVE_EFFECT 也算。
2) 没人接的 Promise：void doSomething()、在定时器里调 async 函数却不 .catch、ctx.timeout(ms) 的 Promise 写法在卸载时 reject('Context has been disposed')。还有函数声明式 export function apply 里 return 的 Promise：它被 new 吞掉，没人处理。
3) ctx.emit 同步派发，不等待也不捕获：async 监听器 reject 就是未处理拒绝；同步抛错会冒到发出方，发出方如果在定时器或 IO 回调里，也会致命。
4) 客户端组合错误：dsh.client 类型不对、声明了 dsh.client 却没有 ./client 导出或文件、external 自引用或成环、同一个包被两行挂载。如果在 required 行 modules 构造时（它会扫描已有 fiber 的行）被发现，就抛 ClientPackageCompositionError，整个 Web 或桌面启动失败；之后才发生只记 warning。这取决于激活时序。

二、被兜住、不会崩的情况：
- apply 同步抛错，或 async apply reject：记 error，该行标记失败，兄弟插件继续运行；required 行在启动时例外。
- Config 校验失败、注入的服务缺失：不激活，或一直等待。
- 清理函数抛错：记 error。
- webServer 路由 handler 抛错或 reject：返回 400、记 warning；但 handler 里另起、没有 await 的异步任务不在保护范围内。
- session/event、agent/disposed 监听器：派发方逐个兜住，只记 warn。
- 客户端单个 slot 条目抛错：只有这一个条目崩溃，控制台打印 slot entry crashed in '<slot>'。

三、半致命：agent/created 是用 ctx.serial 派发的。
- 监听器抛错或 reject，会让这次 agent 创建失败，影响用户所有会话的新建和恢复。
- 监听器返回任何非 undefined/null/false 的值，后面的监听器就被短路，例如官方 session-controller 发 api-session/added 的那个监听器。
- waterfall 监听器（agent/pre-step、tools/pre-execute 等）不 return next()，会否决整条链。

四、包法：
- 所有脱离 apply 的回调都用 safe() 包：同步异常和异步 reject 都只记日志，而且一律返回 undefined（或 resolve 为 undefined 的 Promise），避免 serial/bail 短路。waterfall 监听器不要用 safe，必须保证 return next()。
- 定时调度用 setInterval，加防重入标志；每次 tick 包成 Promise.resolve().then(tick).catch(...)；清理交给 ctx.effect。
- 启动时的异步初始化写 init().catch(log)；不要写 void init()，也不要从函数声明式 apply 里 return 它。
- 自己的行不要用 required id。
- 发布前检查 dsh.client 和 ./client 产物齐全。

```
// lib/safe.js —— 宿主进程里所有「脱离 apply 的回调」都包一层
// 关键：永远返回 undefined（或 resolve 为 undefined 的 Promise）。
// 原因：ctx.serial / ctx.bail 派发的事件（如 agent/created）会把非 undefined/null/false 的返回值当成短路，后面的监听器全部不执行。
// waterfall 事件（agent/pre-step、tools/pre-execute 等）不要用它，必须自己 return next()。
export function safe(label, fn) {
  return function guarded(...args) {
    try {
      const result = fn.apply(this, args)
      if (result && typeof result.then === 'function') {
        return result.then(() => undefined, (error) => {
          console.error(`[agent-hub] ${label} failed:`, error)
        })
      }
    } catch (error) {
      console.error(`[agent-hub] ${label} failed:`, error)
    }
    return undefined
  }
}

// 调度器：防重入 + 每次 tick 兜底 + 清理归 ctx.effect
export function startScheduler(ctx, intervalMs, tick) {
  ctx.effect(() => {
    let stopped = false
    let running = false
    const timer = setInterval(() => {
      if (stopped || running) return
      running = true
      Promise.resolve()
        .then(() => tick())   // tick 里的同步异常（包括卸载后调用 ctx.effect 抛的 INACTIVE_EFFECT）也变成 rejection
        .catch((error) => console.error('[agent-hub] tick failed:', error))
        .finally(() => { running = false })
    }, intervalMs)
    return () => { stopped = true; clearInterval(timer) }
  }, 'agent-hub: scheduler')
}

// 用法（apply 内）
// ctx.on('agent/created', safe('agent/created', async ({ agent }) => { /* 只处理机器人会话；不要 return 值 */ }))
// init().catch((error) => console.error('[agent-hub] init failed:', error))   // 不要 void init()，也不要从函数声明式 apply 里 return 它
// await ctx.timeout(1000).catch(() => {})   // 需 inject: ['timer']；卸载时会 reject
```

> 核查说明：原结论核对属实。改正：原 safe() 对同步函数直接 return result；作为 agent/created（serial）监听器时如果返回了值（比如 disposer），会短路后面的监听器（events.ts:13-15、204-209）。改为一律返回 undefined。补充 2 点：函数声明式 apply return 的 Promise 会成为未处理拒绝；在已卸载的 ctx 上调用 ctx.effect 会同步抛 INACTIVE_EFFECT，在裸定时器回调里就致命。

证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4174、4216-4252 — installFailLoud; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:286-288; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:43、98-113 — 失败矩阵; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4270-4279、4464-4475 — required id；启动审计; dsh-src/@deepseek-ai/cordis/src/events.ts:13-15、183-222 — isBailed；parallel / emit / serial / bail; dsh-src/@deepseek-ai/cordis/src/fiber.ts:250-261 — 构造调用丢弃返回值（Promise 无人处理）；351-354、418-422 — INACTIVE_EFFECT; dsh-src/@deepseek-ai/cordis-plugin-timer/src/index.ts:31-66; dsh-src/@deepseek-ai/cordis/src/fiber.ts:646-696 — apply 与清理的错误只记日志; dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md:71；lib/index.js:395-406; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1231-1240、1592；dsh-src/@deepseek-ai/dsh-agent/lib/index.js:546-557 — session/event、agent/disposed 由派发方兜住; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:574-590 — agent/created 用 ctx.serial 派发，失败会 reject; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2986-2990 — 官方 agent/created 监听器（发 api-session/added）; dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:536-562、851-896 — 启动时组合失败抛 ClientPackageCompositionError；运行期只 warn; dsh-src/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:638; _app/main.js:8344-8384、7505 — 致命错误框与三个按钮; _app/main.js:3531-3546、3585-3586、11834-11840 — sanitizeProfile（重置为 web 模板、备份 profile patch、home patch 不变）; _app/main.js:3841-3846 — 宿主退出时把 stderr 尾部拼进错误信息; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:16

## [confirmed] Q5-a DSH_HOME 环境变量的作用和覆盖范围

1) 解析顺序：显式传入的值 → $DSH_HOME → ~/.dsh。空值或纯空白的 $DSH_HOME 当作没设置，支持 ~ 展开。
2) 这个根目录下有：
- profiles/<name>/：package.json、cordis.patch.yml、compatibility.json、node_modules、.plugin-manager/logs。
- sessions/：会话持久化。
- .credentials.yaml：托管凭据，也存账号登录授权、浏览器会话签名密钥。
- .env：home 级环境层。
- cordis.patch.yml：home 级用户 patch，作用于所有 profile，优先级高于 profile 自己的 patch。
- logs/startup-*.log：启动失败的完整诊断。
- cache/。
- 桌面版的 dsh-runtimes/。
3) 桌面版的 profile 是 $DSH_HOME/profiles/desktop，锁文件是同目录下的 lock。桌面版用的是 App 进程自己继承到的环境；从登录 shell 读来的变量里，DSH_* 和 ELECTRON_* 一律被忽略。所以从 Finder 启动时，桌面版用 ~/.dsh；在终端里给 CLI 设置 DSH_HOME，不会影响正在运行的桌面版。
4) 不归 DSH_HOME 管的有两个：
- ~/.agents（变量 DSH_AGENTS_HOME）：用户全局 AGENTS.md 和 skills/ 在这里。
- 新会话默认的工作目录：等于启动 dsh 时所在的目录。
5) .env 文件里不能设 DSH_*、PATH、XDG_* 这类启动变量，会被拒绝，必须在 shell 里 export。
6) 插件自己的数据目录用 !!js dshHomePath('agent-hub') 生成；代码里也可以直接用 ctx.dshHomePath，它是根服务，无需 inject。这样会跟着 DSH_HOME 走，沙箱和桌面版的数据天然分开。dsh-auto-upgrade 样板把 HOME + '/.dsh/...' 写死，是反例。

> 核查说明：逐条核对属实。

证据：dsh-src/@deepseek-ai/dsh-home-paths/lib/index.js:70-86、109-111、124-134; dsh-src/@deepseek-ai/dsh-home-paths/README.zh.md:39、52; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:507-509、546-549; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:113-126、138-141; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:115-117; dsh-src/@deepseek-ai/dsh/lib/bin.js:158-194; dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:60-61; _app/main.js:79-84、9283-9284; dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:331-335; dsh-src/@deepseek-ai/dsh/README.zh.md:20; /Users/bytedance/Documents/DSHarness Doc/dsh-auto-upgrade/plugin/lib/index.js:23-27

## [confirmed] Q5-b 有哪些 profile 模板（desktop、web、headless、tui…）以及 --from-default-profile

1) 随附模板，代码里的 PROFILE_TEMPLATES 只有 5 个：
- acp = dsh-base + dsh-acp-app
- web = dsh-base + dsh-web-app
- headless = dsh-base + dsh-headless
- sdk = dsh-base + dsh-sdk-app
- sdk-minimal = 只有 dsh-sdk-minimal
第一次 dsh --profile <这些名字> 时会自动初始化。
2) desktop 不是 CLI 模板：它由 Electron 管理，用 web 模板的组合包（base + web-app）初始化，所以和 dsh web 几乎是同一套组合。差别有三处：
- 几行按 profileContext.name==='desktop' 门控的插件：desktop-product-telemetry、product-analytics、ui-sidebar-browser、deepseek-account 的 desktopPlatform。
- 桌面宿主额外挂 Office 插件，以及退出、更新时的检查。
- 固定用 --no-open --host 127.0.0.1 --port 0 启动，端口随机。
CLI 拒绝 --profile desktop 启动或 dump。
3) 这一版没有 tui：它只在帮助和 README 的「假设已安装」示例里出现，308 个包里没有任何 TUI 包。
4) 自定义名字：dsh plugin --profile <自定义名> 在 profile 不存在时，只按 DEFAULT_PROFILE_BUNDLES = [@deepseek-ai/dsh-base] 初始化，没有 web-app，也就没有 webServer 和界面。直接 dsh --profile <自定义名> 而 profile 不存在时会报错，提示先用 dsh plugin --profile <名> add <package> 创建。
5) dsh --profile <名> --from-default-profile <模板>（也可写成 dsh <名> --from-default-profile <模板>）：
- 只拷贝模板的组合包列表，在 profiles 目录下的 .<名>.staging-* 里组装，再改名换入。
- 成功后删除旧目录，旧的依赖和用户 patch 全部丢失；换入失败会尝试恢复。
- 目标名不能是随附模板名（不区分大小写），模板名未知也报错。
- 做完会接着启动这个 profile。每带一次这个参数就重建一次，所以只在创建或重置时用。
6) headless：
- 不挂宿主 HTTP 服务、Web 运行时或浏览器插件；禁用 HMR；禁用托管凭据存储、authorization、deepseek-account。
- 只按 环境变量 → <cwd>/.env → $DSH_HOME/.env 的顺序取 key；跑完一个任务就退出。
- 依赖 webServer 的插件在 headless 下会一直等待、不激活。想让核心逻辑在 headless 下也能跑，就把路由放进 ctx.inject(['webServer'], ...) 子插件。
7) 官方另外随附 12 个默认关闭的可选组合包（OPTIONAL_BUNDLES，都是 experimental），可以在插件页打开。

> 核查说明：逐条核对属实。

证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:551-557、570、579-592; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:1065-1073 — loadProfile; dsh-src/@deepseek-ai/dsh/README.zh.md:9-20、24-32; dsh-src/@deepseek-ai/dsh/lib/bin.js:39-49、105、129; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:129-200、216-222; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:591-604; _app/main.js:3552、3636-3638; dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:218-240、331-335; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:47、59、298；dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:123; dsh-src/@deepseek-ai/dsh-headless/cordis.patch.yml:1-7、32-43；dsh-src/@deepseek-ai/dsh-headless/README.zh.md:53-55

## [confirmed] Q5-c dsh web 在哪个端口提供界面、怎么改端口

1) 默认监听 127.0.0.1:3080：webserver 行的 host 取 ctx.webStartup.host ?? '127.0.0.1'，port 取 ctx.webStartup.port ?? 3080。
2) 改端口用应用参数 --port <n>，例如 dsh web --no-open --port 3999；传 0 表示让系统挑一个空闲端口。其他应用参数：
- --host 只接受一个具体的本机 IP 字面量，通配地址会被拒绝；
- --no-open、--public-url、--trusted-host、--tls-cert、--tls-key。
启动器自己的参数（--profile、--patch、--from-default-profile、--dump-*）要写在前面，因为第一个启动器不认识的参数就被当成应用参数的开始。
3) 启动后打印一行「dsh web: http://127.0.0.1:<port>/?token=...」，token 每个进程一个。浏览器首次 GET / 时用 token 换一个签名 cookie，再重定向到干净的 ./。cookie 默认 30 天有效，绑定 host:port；签名密钥是 $DSH_HOME/.credentials.yaml 里 client-connection/browser-session 的 grant 记录。所以同一端口重启后通常不用重新拿 token；换了端口要用新打印的 URL。
4) 端口被占用（EADDRINUSE）时，因为 webserver 是 required 行，启动直接失败。桌面版用随机端口，固定端口一般不会和它冲突；桌面版遇到 EADDRINUSE 会提示「有其他正在运行的 DSH」。
5) 插件里绝不要写死端口。界面用相对路径请求宿主；桌面版页面在 dsh-app://app，由主进程转发，见 Q2-a。

```
# 隔离实例里换端口（启动器参数在前，应用参数在后）
DSH_HOME="$HOME/dsh-sandbox/home" "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" web --no-open --port 3999
# 终端打印：dsh web: http://127.0.0.1:3999/?token=...  —— 用这个带 token 的地址打开
```

> 核查说明：逐条核对属实。

证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:179-188; dsh-src/@deepseek-ai/dsh-web-app/lib/startup.js:24-36、44-69; dsh-src/@deepseek-ai/dsh-web-app/lib/index.js:162; dsh-src/@deepseek-ai/dsh-web-app/README.zh.md:16、65、67; dsh-src/@deepseek-ai/dsh-client-connection/README.zh.md:41-43; dsh-src/@deepseek-ai/dsh/lib/bin.js:10-25、105、129；dsh-src/@deepseek-ai/dsh/README.zh.md:24-32; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4270-4279; _app/main.js:8352-8358、7498 — 只有 EADDRINUSE 时提示「有其他正在运行的 DSH」; dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:233-240

## [confirmed] Q5-d 隔离实例需不需要模型凭据；凭据按什么路径查找（只给路径）

1) 没有凭据也能完成的事：启动隔离实例、装插件、打开界面、注册路由和工具、跑插件的 apply 和调度器。适配器在每次请求时才解析凭据；只有机器人真正发起一轮模型调用时才需要，没有凭据这一轮会出错。
2) web、sdk、acp、desktop 的查找顺序，先找到的胜出：
① 托管凭据文件 $DSH_HOME/.credentials.yaml：refs 下按环境变量名存 key，例如 DEEPSEEK_API_KEY；records 下存各插件的授权，账号登录授权、浏览器会话签名密钥都在这里。POSIX 上只要其他用户可读就拒绝加载，并提示 chmod 600。
② 启动时的环境变量。这是启动时拍的快照，之后再 export 的不算。
③ <启动 dsh 时所在目录>/.env。
④ $DSH_HOME/.env。
3) 桌面版的对应文件是 ~/.dsh/.credentials.yaml 和 ~/.dsh/.env，只写路径，不要读取。隔离实例换了 DSH_HOME 就不会读它们。订阅额度那条路（账号登录）要在沙箱里重新登录，能不能用没有验证。
4) headless 不同：它禁用托管文件，只按 ② → ③ → ④ 的顺序找。
5) 给隔离实例模型能力的方法：在沙箱 shell 里 export DEEPSEEK_API_KEY；或者把 key 写进沙箱的 $DSH_HOME/.env；或者在沙箱 Web 的「设置 → 模型」里保存，会写进沙箱的 .credentials.yaml。注意：沙箱启动时会自动在它自己的 .credentials.yaml 里生成浏览器会话签名记录，这不是模型凭据。

> 核查说明：逐条核对属实。

证据：dsh-src/@deepseek-ai/dsh-credentials-local/README.zh.md:42-47、71-80、109、115; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:113-126; dsh-src/@deepseek-ai/dsh-web-app/README.zh.md:43; dsh-src/@deepseek-ai/dsh-headless/README.zh.md:53-55；dsh-src/@deepseek-ai/dsh-headless/cordis.patch.yml:35-43; dsh-src/@deepseek-ai/dsh-client-connection/README.zh.md:43

## [confirmed] Q5-e 怎样在隔离实例里跑起插件，又完全不碰用户正在用的桌面版

能做到。推荐方案：用桌面版自带的 CLI，加上独立的 DSH_HOME，跑 web profile。web profile 的组合与桌面版同为 base + web-app、HMR 开着，所以在这里验证过的插件，行为最接近桌面版。

步骤：
① export DSH_HOME=<沙箱>/home。可选：DSH_AGENTS_HOME=<沙箱>/agents（不读全局 AGENTS.md 和 skills）；DSH_TELEMETRY_DISABLED=1（任何非空值都会禁用 session-telemetry-otel 行）。
② cd 到沙箱的工作目录。它就是新会话默认的 workspace 根，也会读这里的 .env。
③ dsh plugin --profile web add link:<插件目录>：沙箱里的 web profile 会按模板自动初始化，并把插件选进 bundles。
④ dsh web --no-open --port 3999。
⑤ 用终端打印的带 token 的 URL 在浏览器里打开。
辅助命令：dsh --profile web --dump-config 可以确认组合结果里有 agent-hub 这一行（desktop 不能 dump，沙箱可以）。

为什么不碰桌面版：
- profile、sessions、凭据、日志、home patch 都在沙箱的 DSH_HOME 下。
- 桌面版忽略从登录 shell 读来的 DSH_*，继续用 ~/.dsh/profiles/desktop。
- CLI 以 ELECTRON_RUN_AS_NODE 方式运行，不会开窗口。
- 桌面版端口随机，沙箱用固定端口，互不冲突。

调试时能看到什么：
- 终端会显示 URL 行、启动时未激活插件的诊断（stderr）、skipping profile bundle 和 disabling profile plugin、插件里 console.* 的输出、致命错误的 fatal 行。
- ctx.logger 在这一版只进内存缓冲（最多 1000 条）。除了启动期收集 warn/error 的诊断 exporter，没有控制台 exporter，所以运行期看日志用 console.*。
- 桌面宿主的 stdout 进 Electron 主进程的 stdout，从 Finder 启动时看不到；stderr 只保留最后 64KB，宿主退出时拼进错误框。
- 启动失败的完整诊断在沙箱的 $DSH_HOME/logs/startup-*.log。

迭代方式：
- 改宿主代码：Ctrl+C，重跑，再刷新页面。
- 改 client.js：client-hmr 会热替换。
- 改 package.json 或组合包的 patch：重启。

注意事项：
① 一定要设 DSH_HOME，否则 dsh web 和桌面版共用 ~/.dsh，会互相干扰。
② 同一个源码目录同时 link 进沙箱和桌面版时，改动会在桌面版下一次重组或重启时被带进去。稳定之前只 link 进沙箱。
③ 沙箱里的 agent 工具操作的是真实文件系统，要放在专用目录里。
④ 给了凭据就会消耗真实额度。
⑤ 桌面版自动更新会替换 App 包，对正在运行的沙箱进程有什么影响，没有验证。

备选方案（低置信）：dsh web --patch <overlay.yml> 可以不经 pnpm，直接按绝对路径插入一行（overlay 里的绝对或相对 name 会转成 file URL）。代价有三点：这个目录不算 linked root，import 宿主的包时没有 peer 路由；HMR 不比较这个目录的文件；兼容检查按最近的 package.json 做。只适合零依赖的快速试验。

```
#!/bin/bash
# dsh-sandbox.sh —— 在独立 DSH_HOME 里跑 dsh web，不碰 ~/.dsh 和正在运行的桌面版
# 用法：bash dsh-sandbox.sh install | run | dump | remove
set -euo pipefail
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"  # 桌面版自带 CLI（自带 pnpm）
SANDBOX="$HOME/dsh-sandbox"
PLUGIN_DIR="/绝对路径/dsh-agent-hub"
export DSH_HOME="$SANDBOX/home"            # profiles/ sessions/ .credentials.yaml .env logs/ 都在这里
export DSH_AGENTS_HOME="$SANDBOX/agents"   # 可选：不读 ~/.agents 的全局 AGENTS.md 和 skills
export DSH_TELEMETRY_DISABLED=1            # 可选：任何非空值都会禁用 session-telemetry-otel 行
mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$SANDBOX/work"
cd "$SANDBOX/work"                          # 启动目录 = 新会话默认 workspace 根；也会读这里的 .env
case "${1:-run}" in
  install) "$DSH" plugin --profile web add "link:$PLUGIN_DIR" ;;   # 首次按 web 模板(base+web-app)初始化
  remove)  "$DSH" plugin --profile web remove dsh-agent-hub ;;
  dump)    "$DSH" --profile web --dump-config ;;                    # 确认组合里有 agent-hub 行
  run)     exec "$DSH" web --no-open --port 3999 ;;                 # 打印 dsh web: http://127.0.0.1:3999/?token=...
esac
```

> 核查说明：核对属实（中等置信），行号已校正。

证据：dsh-src/@deepseek-ai/dsh/README.zh.md:11-20、37、46、48; dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js:591-604; _app/main.js:3552、3636-3638 — 桌面 profile 也是 web 模板的组合包; _app/main.js:79-84、9283-9284; _app/main.js:3794-3816、3841-3846 — 宿主 stdout 转到主进程 stdout；stderr 只留最后 64KB，退出时拼进错误信息; dsh-src/@deepseek-ai/cordis/src/logger.ts:195-224 — 默认 exporter 只写内存 buffer（bufferSize 1000）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4507-4526 — 只装了收集启动期 warn/error 的诊断 exporter；全库 grep .exporter( 只有 cordis 与 app-boot 两处; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:538、2308、4464-4475; dsh-src/@deepseek-ai/dsh/lib/bin.js:158-194; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:245、300; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:1105-1112 — resolveTelemetryPatch：任何非空值都禁用; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:3971-3978 — overlay 里的绝对或相对 name 转成 file URL; dsh-src/@deepseek-ai/dsh-hmr/README.zh.md:65 — HMR 只比较 profile 目录及链接包目标里的文件; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:2262-2300 — manifestOf：路径类行按最近的 package.json 做兼容检查

## 坑

- export function apply(ctx, config)（官方模板的写法）会被 cordis 当成构造函数，用 new 调用（utils.ts:79-89 只看有没有 prototype），return 值被丢弃。如果 return 一个 Promise，它会被 new 吞掉，一旦 reject 就是未处理拒绝，宿主 installFailLoud 直接 exit(1)。函数声明式 apply 必须同步、不 return；清理全部走 ctx.effect / ctx.on；异步初始化写 init().catch(...)。也可以改用 export async function apply：它不会被 new，异常被兜住，但会拖住整个启动。
- 方法简写、async、箭头函数形式的 apply，返回值按 effect 收集；返回普通对象会抛 TypeError('Invalid effect')。ctx.inject(deps, cb) 和 ctx.plugin(fn) 的回调规则相同：function 表达式会被 new，箭头回调的返回值被当作 effect。
- async apply 里长时间 await 会拖住整个应用启动：boot() 等 loader.await()，之后才打印 URL、通知桌面 ready。恢复机器人、联网这类长任务放到后台执行，并加 .catch。
- agent/created 是用 ctx.serial 派发的。监听器抛错或 reject，会让这次 agent 创建失败；监听器返回任何非 undefined/null/false 的值，后面的监听器（包括官方 session-controller 发 api-session/added 的那个）全部被跳过。所以监听器一律写块体、不 return 值，safe() 包装也必须返回 undefined。
- ctx.emit 不等待也不捕获：async 监听器 reject 就是未处理拒绝，宿主 exit(1)。session/event、agent/disposed 由派发方兜住；其他事件要看派发方式。waterfall 监听器必须 return next()，不能用 safe() 吞掉。
- 插件卸载时，各个顶层 ctx.effect / ctx.on / ctx.provide 的清理是并发执行的，没有先后保证；只有同一个 effect 内部的清理是逆序串行。有顺序要求就放进同一个 effect，用生成器依次 yield。
- 版本要求必须写在顶层 engines.dsh。写在 dsh.engines.dsh 下（dsh-net-tuning 样板就是这样）宿主不读，等于没声明。dsh-package-manifest 的 README 说「不强制」是旧说法，以 app-boot 的代码为准。
- ctx.webServer.register() 返回的 disposer 不会自动跟着插件卸载，必须包进 ctx.effect，否则重载后报 duplicate prefix route。webServer 路由没有任何 cookie 鉴权或 Host/Origin 校验，这些只作用在 Connection 自己的 /api 路由上。路由前缀注册成 /api/xxx 会按最长前缀抢过 Connection 的 /api，同样绕过鉴权（dsh-auto-upgrade 样板就是这样）；/plugins 被 client-modules 占用。
- 桌面版页面在 dsh-app://app，Electron 主进程把非静态路径连同 cookie 转发给宿主。界面里只能用文档相对路径（或 / 开头的根路径）请求宿主，不能写死 127.0.0.1:端口；路由不要放在 /assets/ 下。
- client factory 里 require 基座模块要用全名：@deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-dockkit。写短名会抛 missed the module table。不要 require Harness 客户端包，官方禁止，包括 @deepseek-ai/dsh-client-ui-primitives。
- dsh.client.inject 写客户端包名，只管到达顺序；client factory 返回对象的 inject 写客户端 Cordis 服务名，例如 'slots'。两者不能混。factory 的 id 必须等于包名。
- 下面这些都会让 client-modules 组合失败：dsh.client 字段写错（即使 platform 不是 web 也会校验类型）；缺 ./client 导出或文件；external 自引用或成环；同一个包被两行挂载（例如再加一个 ./lib/x.js 相对路径行）。如果发生在 required 行 modules 构造时，整个 Web 或桌面启动失败；之后才发生只记 warning。
- 不要把 @deepseek-ai/* 写进 dependencies，物理副本会遮蔽宿主实例。要复用宿主的 cordis、schemastery、zod，就写进插件根 package.json 的 peerDependencies。link: 安装时 pnpm 不会替你装链接目录自己的依赖；链接目录挪位置后要先卸载再重装。
- 普通 Config 字段一改就整行重新挂载，本插件开出的 agent 会被 cancel({kind:'disposed'})。可调参数要用 schemastery 的 .volatile()，读值用 .get()。loader/volatile-update 只发给注册在本行根 ctx 上的监听器；手写 Standard Schema 不支持 volatile。
- 顶层 inject 的任何服务（例如 webServer）一重启，整个中心插件就重新挂载，正在跑的机器人轮次被取消。可选服务要放进 ctx.inject 子插件。
- 不要用 ctx.fiber.dispose() 停掉自己：Loader 会把该行标成 disabled 并写回配置树（cordis-plugin-loader/src/index.ts:160-165）。要停机器人，用自己的状态开关。
- Config 不会自动出现在插件页上。要在界面上改配置，得自己注册 plugins.bundle.config（key 是包名）或 plugins.row.config（key 是 '<包名>#<行 id>'）。
- HMR 配置是 root: []，不监视源码，也不监视组合包自己的 patch 文件和插件自己的 package.json。改宿主代码、package.json 或 patch，都要等重组或重启；只有 client.js 会被 dsh-client-hmr 每 500ms stat 一次并热替换。
- cordis.patch.yml 必须是顶层 YAML 数组。profile 或 home 的用户层文件空着、或只有注释，会让启动失败，要写 []。组合包自己的 patch 解析失败，整个组合包被跳过。行 id 必须全局唯一，不要和官方 id、特别是 required id 重名：agent-loop、webserver、web-runtime、modules、connection、headless-runner、acp、sdk-jsonrpc-server。
- dsh plugin --profile desktop 只能用桌面版自带的 CLI（/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh），官方流程是先完全退出桌面版。任何 dsh 都拒绝用 --profile desktop 启动或 dump 配置。
- dsh plugin --profile <不存在的自定义名> 只按 [dsh-base] 初始化，没有 web-app，也就没有 webServer 和界面。要么用随附名 web，要么先执行 dsh <名> --from-default-profile web；这个参数会删除同名自定义 profile 的整个旧目录。
- 不设 DSH_HOME 直接跑 dsh web，会和桌面版共用 ~/.dsh。插件数据目录要用 !!js dshHomePath('...')，不要像 dsh-auto-upgrade 样板那样写死 ~/.dsh。
- 这一版的 ctx.logger 只写内存缓冲（1000 条），没有控制台 exporter，运行期调试用 console.*。桌面宿主的 stdout 进 Electron 主进程，从 Finder 启动时看不到；stderr 只留最后 64KB，宿主退出时出现在错误框里。
- 进程退出时只有 5 秒宽限，致命错误时只有 2 秒，状态要随时落盘。桌面宿主崩溃后不会自动拉起；如果有人点了「禁用第三方插件、备份 profile patch 并重启」，组合包列表会被重置为 web 模板，profile 的 cordis.patch.yml 被改名为 .bak-<时间戳>。
- 这一版没有 tui profile 和 tui 包。随附模板只有 acp、web、headless、sdk、sdk-minimal；desktop 由 Electron 用 web 模板的组合包创建。
- 用户的环境约束：要用户手动运行的命令不能带引号、空格路径、$()、管道。桌面版 CLI 路径含空格，必须先写成脚本文件，再给用户一条只含脚本路径的短命令。

## 未决

- 桌面版运行时，用 CLI 执行 dsh plugin --profile desktop add：代码显示 dsh.profile.bundles 变化会触发 HMR 重组，可能直接热激活；但官方提示要求先退出，插件管理器 README 又说在管理器之外重新链接要等重启。真实行为没有实测，目前按「退出 → 安装 → 重开」处理。
- 桌面版自带的 pnpm 处理 link: 依赖时，是否完全不安装链接目录自己的依赖、缺少 peer 时是否只警告不失败：没有实测。
- client-modules 的启动期组合错误（dsh.client 写错等）是否必然让 Web 或桌面启动失败：取决于本插件行在 modules 构造时是否已经建好 fiber，没有实测。
- ctx.logger 的内存缓冲是否有其他读取途径（例如 inspector 实验插件、宿主调试器），没有验证。
- dsh web --patch <overlay> 按绝对路径免安装挂载插件的方案：链接根之外 import 宿主包、client 半边提供、兼容检查的实际效果都没有实测（低置信）。
- 沙箱里的 dsh web 用账号登录（订阅额度）是否可用、额度是否与桌面版共享：没有验证。
- 桌面版自动更新替换 App 包时，正在用 App 包里的 CLI 跑的沙箱进程会怎样：没有验证。
- dsh-client-hmr 对第三方 link 插件 client.js 的热替换，没有在真实页面（尤其是桌面版的 dsh-app:// 页面）里验证。
- 注册 main 和 sidebar.panellist slot 时，locale 等字段是否必填：官方 schedule 传了 locale: MANAGER_NS。要以运行中 cordis_inspect_query 的 Slots.listSubTree 为准，未在运行中核对。
- ctx.connection.fetch.register 作为带鉴权的替代路由：字段（path、methods、requestBody、fetch）来自源码阅读；requestBody 除 'buffered' 外还有哪些取值、在桌面转发链路下表现如何，没有验证，归通信专题。
- 插件 ctx.fiber.dispose() 自停后写回的配置树，在下一次 HMR 重组时如何表现：没有实测。已知启动时 profile-boot 会重写根 cordis.yml。
- engines.dsh 范围怎么取（例如 >=0.2.1-rc.5 <0.3.0-0），取决于 DSH 版本号怎么演进，需要和用户确认采用「失败时关闭」还是「照常加载」的策略。
