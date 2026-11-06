# T5-client-ui

## [confirmed] Q1-1 客户端 bundle 的准确格式：window.__ModuleLoader__.load({id, factory}) 契约是什么？package.json / cordis.patch.yml 要声明什么？

调研员结论基本属实，下面是核对后的精确契约：
1) lib/client.js 是经典脚本，宿主用 <script src> 加载（defaultLoadBundle）。整份文件只调用一次 window.__ModuleLoader__.load({ id, factory })。执行脚本时只登记 factory，第一次 import/require 时才调用 factory(require)，返回值作为 exports 并缓存。
2) 宿主把多个插件的 client.js 原样拼接（source += src + ';\n'），URL 形如 plugins/??<id>/client.js,<id2>/client.js&rev=<rev>。prepareSource 会去掉末尾的 //# sourceURL= 和 //# sourceMappingURL= 两种尾注。因此：文件顶层不能有 import/export（经典脚本里是语法错误）；顶层 let/const/class 会进入所有经典脚本共享的全局词法作用域，和别的插件重名就 SyntaxError；function/var 会挂到 window 上。所有代码都放进 factory 闭包。如果某个合并包（combo）没能登记某一行，这一行会退回自己的单资源 URL 重试（每行最多 3 次请求），已登记的行不受影响。
3) id 必须等于 package.json 的 name。登记时会去掉结尾的 /client，所以 '<name>/client' 和裸包名等价。id 对不上会报 loaded without registering "<id>" via __ModuleLoader__.load；同一 id 登记两次会报 duplicate factory registration。
4) Loader 的 unwrapExports 规则：e==null 时原样返回；否则先取 e = e.default ?? e，若 e.__esModule 为真再取 e.default ?? e。所以命名导出 apply/inject、export default {apply, inject}、或者像官方模板那样直接 return {inject, apply} 普通对象都可以。Symbol.toStringTag 不是必需的（用户样板注释里「不标记就去取 default」不准确）。
5) 客户端条目只用 { name: 包名 } 创建，拿不到 patch 行里的 config。
6) 宿主组合时（resolveMeta）的校验：dsh.client 必须是对象，platform 必须是字符串，platform !== 'web' 时静默忽略（不报错，也不进启动图）；inject/external 必须是字符串数组；immediately 必须是布尔值（true 表示 Cordis 启动前预取）。exports['./client'] 必须是字符串，或带字符串 default 的对象。声明了 dsh.client 却没有 ./client 会抛错；client.js 文件不存在会报 MissingClientBundleError。只有「有 fiber 且未禁用」的 Loader 行才参与组合（行被禁用，客户端半随之卸下）。包身份取这一行模块解析出的最近 package.json，所以包根 '.' 必须有可导入的宿主半（官方 UI 包也只是一个空 apply）。同一个包名从两个 Loader 来源解析到会报组合错误。
7) dsh.client.inject 里的包名只让这些包的 bundle 先到达（不存在的包会被忽略），不是服务依赖。cordis.patch.yml 插入一行，name 指向本包。展示用的 ./locale/*.json（meta.title / meta.description）和 ./icon 见 host-plugin.md。

> 核查说明：小处修正：原说法「prepareSource 只去掉 sourceMappingURL」不完整，它也会去掉 //# sourceURL= 尾注（index.js:255-265）。补充三点：combo 失败时的单行回退（client.js:728-775）；platform 非 web 时静默忽略（index.js:733-736）；行必须有 fiber 且未禁用（index.js:855）。这些都不改变结论，所以标 confirmed。engines.dsh 版本闸门引自底稿 06，本次只确认插件管理器读取 engines（dsh-plugin-manager/lib/index.js:393、415），没有逐行复核比较逻辑。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js:1-22（官方模板 factory(require) 直接 return {inject:['slots'], apply}）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json:6-20；cordis.patch.yml:1-3；index.js:1-2; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-modules/lib/client.js:16-23（只登记、首次 import 才物化）、61-75（parseDshClient）、484（options = { name: id }）、581-594（经典脚本 <script src> 加载）、702-714（去 /client 后登记，重复登记抛错）、728-775（loaded without registering；退回单资源 URL）、789-792（inject 包只用于先到达）、803-830（materialize）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:166-182（两种尾注正则；clientExportOf）、255-265（prepareSource 去掉 sourceURL 和 sourceMappingURL）、337-341（buildComboScript 拼接）、720-750（resolveMeta：非 web 返回 null；无 ./client 抛错）、830-841（MissingClientBundleError）、852-858（只组合有 fiber 且未禁用的行）、890-896（同包多来源报错）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js:17（unwrapExports(e){return Xn(e)||(e=e.default??e,!e.__esModule)?e:e.default??e}；Xn(e)=e==null）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-modules/README.zh.md:34、38（声明方式；combo 失败的单行回退；<id>/client 与裸 id 同一组导出）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-settings-agent-loop/lib/client.js:1-8、166-170（官方产物外形）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/index.js:1-9（官方 UI 包的宿主半只有空 apply）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:29-51（meta.title/description、./locale/*.json、./icon）

## [confirmed] Q1-2 factory(require) 能 require 到哪些共享模块？准确模块名？

属实。factory 拿到的 require 按以下顺序查找：① 冻结的静态模块表（前端 OZ() 作为 staticModules 传入），共 11 个名字：react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、zod、@tanstack/react-virtual、@deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-primitives、@deepseek-ai/dsh-client-ui-dockkit；② 已物化的模块；③ 已登记但还没物化的 factory（会递归物化）。都找不到就抛 client-modules: require("x") missed the module table。各模块的具体情况：
- React 和 ReactDOM 是 18.3.1。
- zod 是 v4（$ZodType 的 version 常量是 {major:4,minor:4,patch:3}，即 4.4.3）。调研员原来列为开放问题，这里已查实。
- dsh-client-store 只导出 createSnapshotStore、defineStore、notifySubscribers、shallowEqual。
- dsh-client-ui-slots 导出 5 个：SlotCore、SlotOwnershipError、StaleAuthorizationError、resolveSlotLabel、standardHookPropName。
- primitives 有 290 个导出。
- 表里没有 react/jsx-dev-runtime，也没有 react-dom/server。
其他插件的客户端半（动态行）要在 dsh.client.external 里写精确的模块名，组合时才会排到你前面、先到达。官方规则（practices.md:35）：不要 require primitives 或任何 Harness 客户端包。
区分两种 external：打包器（esbuild）的 external 写 react 四件套，用到时再加 zod、@tanstack/react-virtual。dsh.client.external 只写「静态表以外」的请求；静态表里的名字写进去也无害，但没必要。dsh.client.external 里写一个实际不存在的包，组合阶段不会报错，要到物化时才抛 missed the module table。

> 核查说明：补充（不改变结论）：查实 zod 版本为 4.4.3（index-BXV-oxvX.js:59），可以关闭原开放问题「zod 版本未核实」。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js:190（function OZ(){return{react:…,"@deepseek-ai/dsh-client-ui-dockkit":SZ}}；RZ.run 里 staticModules:OZ()）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js:25（Te.version="18.3.1"）、59（const Y9={major:4,minor:4,patch:3}，e._zod.version=Y9）、120（xI = dsh-client-store 四个导出；jI = ui-slots 五个导出）、188（TU = primitives，共 290 个键）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-modules/lib/client.js:832-841（require：seed→loadCache→已登记 factory，否则抛 missed the module table）、777-794（external 行先到达；行不存在则跳过）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-modules/README.zh.md:51（每个动态 bundle 精确按基座解析 external；dsh.client.external 只添加基座之外的请求）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35（不要 require primitives 等 Harness 客户端包；dsh.client.inject 只决定排序）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-experimental-client-ui-voice-input/package.json（dsh.client.external: ['@deepseek-ai/dsh-api-gateway/client']）

## [corrected] Q1-3 exports.apply(ctx) 里能用哪些服务？inject 怎么写才安全？

服务清单和「安全写法」大体属实，有两处要改：
(a)【改正】原说法「timer 只提供给动态包」不对。dsh-cordis-client-runner 的 apply 第一行就是 provideClientTimer(ctx)：new ClientTimerService(ctx) 提供全局的 'timer' 服务，并把 timeout/interval/throttle/debounce/setTimeout/setInterval 混入 ctx。这一行在 dsh-web-app 补丁里默认启用，桌面 profile 用的就是 web 模板。动态包被禁止的只是浏览器全局 setTimeout 之类（TIMER_REDIRECT 提示）。普通插件可以写 ctx.inject(['timer'], c => c.interval(fn, ms))，interval 自己会挂 effect、卸载时自动清理；不想多一个依赖，就继续用 ctx.effect 包 setInterval。
(b)【补充】ctx.remote 上的官方命名空间（session/schedule/goals/commands/settings…）各自是一个独立的可追踪子服务，服务名是 'remote.<ns>'。读 ctx.remote.schedule 时，Cordis 代理会转成 ctx['remote.schedule'] 并检查 inject。所以要调用生成方法，必须注入对应的子服务：官方 schedule 的 inject 写了 'remote.schedule'，voice-input 写了 'remote.speech'。只注入 'remote' 时，只能用 $on / $stream / $host / $mount。
以下核对属实：
- 未声明的服务直接读 ctx.xxx 会抛 cannot get property "xxx" without inject。
- ctx.get(name) 不需要 inject；提供方 fiber 还不是 active 时返回 undefined。
- Cordis 4 的 inject 没有「可选」概念，数组或映射里列出的都是必需。
- 启动审计 IZ 对任何非 active 的 Loader 条目都会抛 web boot: N entries did not activate；pending 条目会附上它在等的服务名。桌面版通过 dshDesktopBoot.failed 交给主进程 reportFatal('web-boot')，弹出致命恢复框（按钮：退出 / 重启 / 禁用第三方插件、备份 profile patch 并重启）。
- 客户端事件 4 个：connection/reset、locale/change、slots/changed、theme/change（theme/change 的载荷是 theme 快照）。
- 顶层 inject 只放 ['slots','locale']，其余用 ctx.get 或 ctx.inject 子插件，这个建议成立。ctx.inject 创建的子 fiber 不在启动审计范围内，所以子 fiber 一直 pending 也不会让整页起不来。

```
export const inject = ['slots', 'locale'] // 只放随包必有的服务
export function apply(ctx) {
  try {
    // 调用官方 Remote 命名空间方法：注入子服务 'remote.<ns>'（官方 schedule 写的就是 'remote.schedule'）
    ctx.inject(['remote', 'remote.schedule'], (c) => {
      c.effect(() => c.remote.$on('schedule/changed', () => reload())) // $on 只需要 'remote'
      // c.remote.schedule.history(request) 之类的生成方法需要 'remote.schedule'，否则抛 without inject
    })
    // 定时器：二选一
    ctx.effect(() => { const id = setInterval(poll, 30000); return () => clearInterval(id) }, 'dsh-agent-hub: poll')
    // ctx.inject(['timer'], (c) => { c.interval(poll, 30000) }) // interval 自己挂 effect，卸载自动清理
  } catch (error) {
    console.error('[dsh-agent-hub] apply failed', error)
  }
}
```

> 核查说明：原说法「timer 只提供给动态包，普通插件用 ctx.effect 包 setInterval」改为：timer 由默认启用的 cordis-client-runner 行全局提供，普通插件可以注入使用；用 ctx.effect 包 setInterval 仍然可行，而且零依赖。补充：调用 ctx.remote.<ns>.* 生成方法必须 inject 'remote.<ns>'，这一点原文没提，照原文写会在运行时抛 without inject。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:7227-7239（ClientTimerService：super(ctx,'timer') + mixin）、7407-7409（provideClientTimer）、7467（apply 第一行 provideClientTimer(ctx)）、41（TIMER_REDIRECT 只针对动态包）、7286-7295（interval(cb, delay) 自挂 ctx.effect）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:251-252（cordis-client-runner 行默认启用）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/_app/main.js:3385-3391、3552、3637（桌面 profile 用 WEB_PROFILE = dsh-base + dsh-web-app）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-api-gateway/lib/client.browser.js:2074-2076（remoteServiceKey = `remote.${namespace}`）、1953-1962（RemoteNamespaceService 以 'remote.<ns>' 提供）、1679-1682（$on 要求 interactions=answer）、1638-1641（onConnected 时 emit connection/reset）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-api-gateway/README.zh.md:56（每个 namespace 都是可追踪的 remote.<namespace> 子 Service）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/cordis/lib/index.js:123-131（被追踪的服务代理把 ctx.remote.x 转为 ctx['remote.x']）、672-692（未 inject 抛错）、736-743（mixin 暴露 get）、761-770（get(name, strict) 不需 inject）、1491-1500（Inject.resolve 全部必需）、1770-1784（Service tracker associate:name）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:7365-7377（官方 inject 含 'remote.schedule'）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js:2943-2950（$mount 之后 ctx.inject(['remote.speech', …])）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js:188（jZ / IZ 启动审计）、190（桌面传 o7 → dshDesktopBoot.failed）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/_app/main.js:12433-12438（bootFailed → reportFatal(…, 'web-boot')）、8355-8380（三个按钮）、7505（中文按钮文案）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1690-1730（EVENT_API 四个客户端事件）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-theme/lib/client.js:1880（emit('theme/change', this.snapshot)）

## [corrected] Q1-4 官方 dsh-client-ui-* 的 lib 产物是什么格式？能否用 esbuild 打包、external 哪些？

产物格式的描述属实：
- lib/index.js 是宿主半（Node ESM）。
- lib/client.js 是 tsdown/rolldown 产出的、装进 factory 的 CJS：var module/exports，require(...)，exports.apply / exports.inject，return module.exports，末尾带 //# sourceMappingURL。
- .map 不随包发布；宿主找到 client.js.map 时会拼进 combo map。
- 官方 CSS 编译成字符串，在模块体里插入 <style data-plugin=包名 data-plugin-css=…>。模块系统在物化期间会认领新增的未标记 <style>，卸载、替换、清理时按 data-plugin 删除。
- 双端包的 exports['./client'] 是 node/browser/default 条件对象，宿主取 default。
- tsdown 拆出的 import() 会编译成 require.async('./client.<name>.js')；入口和 chunk 之间不能同步 require。
【改正样式写法】原建议「照官方在模块体里插 style」技术上可行（模块系统会回收），但违反官方写给插件作者的规范：ui-plugin.md:13 明确要求 factory 保持无副作用，样式、定时器、监听器都在 apply 里用 ctx.effect / ctx.on 注册并返回清理函数，或者在组件里渲染 <style> 元素、随组件卸载；practices.md:36 也禁止在组件之外写 DOM。手写插件应改为在 apply 里用 effect 插入 style（可以保留 data-plugin 标记），或者由页面组件渲染 <style>。
esbuild 方案（bundle:true、format:'cjs'、platform:'browser'、external 填 react 四件套、banner/footer 包成 factory、jsx:'automatic' 不开 jsxDev、splitting:false）和源码契约一致：esbuild 的 cjs 输出会给 exports 设 __esModule，unwrapExports 能正确处理；seed 里的 react 是带 default 的合并命名空间，__toESM 可以兼容。但这套配置没有实际构建运行过。

```
// src/client/index.jsx（esbuild 入口，loader {'.css':'text'}）
import css from './hub.css'
export const inject = ['slots', 'locale']
export function apply(ctx) {
  // 样式在 apply 的 effect 里注册并返回清理函数（ui-plugin.md:13），不要放在模块顶层
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-agent-hub' // 与模块系统按 data-plugin 回收的约定一致
    tag.dataset.pluginCss = 'dsh-agent-hub/hub.css'
    tag.textContent = css
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'dsh-agent-hub: styles')
  // 另一种写法：页面组件里渲染 React.createElement('style', null, css)，随组件卸载
}
```

> 核查说明：原说法「CSS 用 text loader 导入后照官方插 style（模块体里，带 data-plugin）」改为：在 apply 的 ctx.effect 里插入并返回移除函数，或在组件里渲染 <style>，这是官方作者规范（ui-plugin.md:13）。官方编译产物在模块体插入只是工具链行为，模块系统会兜底回收，但不该照搬到手写代码里。esbuild 配置仍属按契约推导、没有构建验证。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/ui-plugin.md:9、13（factory 无副作用；样式在 apply 里用 ctx.effect 注册，或作为 React 元素渲染）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:36（不要在组件之外写 DOM）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:2432-2441、1783-1791（官方在模块体里插 style[data-plugin][data-plugin-css]）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-modules/lib/client.js:16-19（模块体副作用含 CSS 在 factory 里执行）、312-315（removeOwnedStyles）、617-631（claimStyles）、842-848（require.async 只认 ./client.<name>.js）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-modules/lib/index.js:271-283（读取 client.js.map）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-modules/README.zh.md:38、73（chunk 协议；不能同步 require 另一个 client*.js）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-connection/package.json（exports['./client'] = {node, browser, default}）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js:2（P1：react 等 seed 是带 default 的冻结合并命名空间）、17（unwrapExports）

## [corrected] Q2-1 插槽（slot）模型与全部可用 slot：sidebar.panellist、main、shell.overlay、会话头部等

模型、注册写法、props 合成顺序、103 个 slot 的数量、各 slot 的 kind/scope 都核对属实。props 的合成顺序是：标准 kit + t + inject 结果 + slot inject + owner props，owner props 优先级最高。
【改正】原文「single（单占位，注册会顶掉官方占位）」以及 gotcha 里「single 类 slot 注册会顶掉官方 UI」与源码不符。SlotCore.register 的实际规则：
- single：已有同 priority 的条目就直接抛 single slot "x" already has a registration at priority 0 — register at a different priority to shadow it (lowest renders)。
- keyed：同 key 同 priority 抛错。
- list：同 id 同 priority 抛错。
要遮蔽官方占位，必须显式给一个更小的 priority（例如 -1），数值小的条目渲染。目录文档里「Registering an already-occupied key replaces that occupant / reusing a shipped id … replaces it」的说法和代码冲突，以代码为准。
抛错的时机：slot 已经声明时，在 apply 里同步抛出，会让插件变成 failed，启动时就是致命框；slot 之后才声明时，错误在 microtask 里抛出，这次注入随之停止。
【补充】shell.bottom 在默认组合里没有被占用（只有实验性 inspector 会占），可以当作三栏下方的整行 single 座位使用，但同一时间只能有一个占用方。真正已被官方占用的 single 座位有：shell.leading（HeaderLeadingControls）、sidebar.toggle.badge（DesktopUpdateBadge）、rightbar / rightbar.session、conversation.session.header.corner（ExpandButton）。
对 Agent 中心有用的 list / keyed slot 清单（sidebar.panellist、main、shell.overlay、sidebar.footer.action、sidebar.panellist.actions、sidebar.session.row.leading / hover、settings.* 、plugins.* 等）核对属实。其中 plugins.item 由官方设置页占用，组合包的配置应放 plugins.bundle.config 或 plugins.row.config。

> 核查说明：原说法「single：注册会顶掉官方占位」改为：默认 priority 0 注册已占用的 single 座位会抛错；只有显式给更小的 priority 才会遮蔽（数值小者渲染）。shell.bottom 不是官方占用的座位，从「别用」清单里移出，改成「可用但独占」。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js:120（SlotCore.register：未声明抛错；single 同 priority 抛错；keyed 需 key、list 需 id、chain 需 select；提示语 register at a different priority to shadow it (lowest renders)；list 按 priority 再按 order 排序）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1354-1425（slots.inject：已声明时同步抛出 setup 失败；之后的失败在 queueMicrotask 里抛出）、1306（使用 seed 表里的 SlotCore）、1603-1621（_register 加 registrant 标记）、850-858（最终 props 合成，owner 胜出）、435-457（hooks → useX）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-layout/README.zh.md:34（shell.bottom 默认组合不占用此 slot）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:2434-7146（CLIENT_SLOT_API 共 103 条）、5423（shell.bottom 占用者只有 experimental-inspector）、5452（shell.leading）、6574（sidebar.toggle.badge）、4841/4870（rightbar / rightbar.session）、3923（header.corner）、4706-4712（plugins.item：OCCUPIED by official settings pages）、4372-4383（main 的文档写着 replaces，与代码冲突）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-layout/lib/client.js:627-652（root 的子 slot 声明）

## [confirmed] Q2-2 怎么加一个左侧栏入口和一个中栏页面（路由/视图注册）？给最小例子

属实。机制如下：
- 没有 URL 路由。在 root 级 keyed slot 'main' 用一个 key 注册页面，再在 list slot 'sidebar.panellist' 用同一个 id 注册图标组件，图标组件的 owner props 是 {size, active}。
- 侧栏负责画按钮，label（可以是 thunk）同时用作可见文字、无障碍名称和折叠提示。
- 中栏渲染 renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })，只挂载被选中的那一页。
- layout.selectPanel(id) 会先检查 main 注册表，key 未注册时抛 layout.selectPanel: main panel "x" is not registered；selectPanel(null) 回到会话界面，但不换当前会话。
- 布局状态刷新后重置。
- 已被占用的 key：conversation（保留）、plugins、schedules。order：插件页 0，自动化任务 10。
- 官方任务页的样式：.page 背景 --dsw-alias-bg-base；内容 max-width 960px；标题 20px / 500；仅在 [data-platform=darwin] 下给标题加 calc(28px + var(--dsh-frame-top-clearance,0px))。调研员给的最小示例代码符合这些契约。

> 核查说明：补充（不改变结论）：用户可以通过侧栏「更多」菜单收起自定义面板行（sidebar README:40，状态只存内存、刷新后重置），所以入口不保证永远可见，需要从代码打开时用 selectPanel。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:4372-4408（main：keyed/root；keyDomain 写明 conversation 已被占用）、5748-5795（sidebar.panellist：id 必填、order、label 可为 thunk；owner props {size, active}）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-layout/lib/client.js:117-119（MainPanel 只渲染 activePanelId 对应的 key）、468-472（selectPanel 对未注册 key 抛错）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-layout/README.zh.md:12、32、57; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-sidebar/README.zh.md:38; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:7363（PANEL_ID='schedules'）、7472-7490（main + sidebar.panellist，order 10）、2433（任务页 CSS）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:4355（PANEL_ID='plugins'）、4484-4490（order 0）

## [corrected] Q2-3 会话级位置（会话头部、侧栏会话行、输入框上方、会话视图）怎么挂？

各位置的语义、注册方式、inject(sessionId) 都核对属实：
- header.actions 在标题旁，官方 AgentPresetLabel 挂在这里。
- header.utilities 在右侧工具区，官方「自动化任务」入口挂在这里。
- sidebar.session.row.leading / hover 是 root 级，owner props 给 {sessionId}。leading 只在该行主状态为 idle 时渲染，归档行留空；hover 只在悬浮卡片打开时挂载。
- conversation.input.dock 在输入框上方整宽，官方 GoalDock 在这里。
- conversation.view 是会话的视图标签，一次只显示一个。
【改正】原文「会话级 slot 会在每一个会话里各挂一份」和 gotcha「在所有会话里各挂一份」容易误解。会话级条目只挂在当前被渲染的会话界面里：主栏选中的那个会话，可能还有子代理会话面板。用户切到哪个会话就为哪个会话挂一份，切换时会重挂，不是所有会话同时常驻。所以不能指望会话级组件替后台的每个机器人会话持续运行逻辑，后台逻辑要放在 apply 或宿主。
官方把侧栏会话行座位设计成 root 级，原因正是「session 作用域的 slot 会强制建立 Session 绑定，从而激活并保留列表中每个 Session」。所以做会话行装饰时，不要改用 session 级 slot。

> 核查说明：原说法「会话级 slot 会在每一个会话里各挂一份」改为：只挂在当前渲染的会话界面里，随切换重挂，不是所有会话常驻。补充：侧栏会话行座位刻意设计成 root 级的原因（workspace README:96）。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:3861-3863（header.actions）、3999-4053（header.utilities：declaredBy conversation.session.header；standardProps 含 sessionId/useSession…）、3339-3341（input.dock）、4201-4203（conversation.view：rendered one at a time）、6449-6545（row.hover / leading 的文档）、4410-4440（main.conversation 是 session-maybe）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-workspace/README.zh.md:96（row 两个子 slot 是 root 作用域；session 作用域会强制绑定并激活每个 Session）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:435-441（runInject 以 binding.key 作为第一个参数）、818-830（session-maybe 切换会话时重挂）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:7509-7540（官方 header.utilities 用 inject:(sessionId)=>…；row.leading / hover 注册）

## [corrected] Q3-1 ctx.connection.fetch.register（需鉴权）怎么注册？客户端怎么调用（URL、鉴权头）？

主体全部属实：
- 宿主半 inject 'connection'，调用 ctx.connection.fetch.register({ path, methods, requestBody, fetch })。
- path 必须是 /api/<段>，按 pathname 精确匹配；每段只允许 [A-Za-z0-9_$.-]，不能是空段、'.' 或 '..'。
- methods 非空且不重复。同一 path 重复注册时，在调用方 effect 里同步抛错。
- 注册自动挂在调用方 ctx 的 effect 上，插件卸载即移除。
- 鉴权链按顺序是：Host/Origin 栅栏（失败 403）→ Cookie 或 API 认证（失败 401）→ connection/request waterfall（桌面更新锁定期间回 503）→ 精确路由只放行 owner Peer（否则 403）。不接受 Authorization 头。
- 浏览器端用文档相对路径 fetch('api/…')，不加鉴权头。
- 桌面版的 dsh-app://app/ 请求由主进程转发到 127.0.0.1:<随机端口>：删掉 host/origin/cookie/sec-fetch-site，补上宿主 Cookie，保留流式与取消；Origin 存在且不等于 dsh-app://app 时直接 403。
- 更新锁会等所有在途 /api 请求结束。
【补充，推断】requestBody 必须显式写 'buffered'，GET 路由尤其如此。原因：requestBodyMode 原样返回 route.requestBody，bridge 只在值等于 'buffered' 时构造不带 body 的 Request，其他值（包括省略不写）一律走流式分支 new Request(url, { method, body: Readable.toWeb(req), duplex:'half' })。按 Fetch 规范，GET/HEAD 带 body 会抛 TypeError，最终 webServer 回 400。官方 deliverables 的 GET 路由全部写的是 'buffered'。
官方还有一个参考做法：用 lifetime AbortController 配合 AbortSignal.any([request.signal, lifetime.signal])，插件卸载时中止在途请求，并在 effect 清理里 await 它们。

> 核查说明：补充：requestBody 不能省略，GET 路由要写 'buffered'。这是根据 bridge 源码加 Fetch 规范推断的，没有实测。其余原结论全部核对属实。dsh-context 第三方先例引自底稿 05，因纪律不读 ~/.dsh，没有复核。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:733-736（fetch.register 绑定读取服务的 ctx）、737-750（requestRejection / admit）、816-853（requestBodyMode 原样返回 route.requestBody；非 owner 返回 403；重复 path 抛错；owner.effect）、926-931（endpointFromPath 段规则）、972-976（assertFetchRoute）、1036-1061（/api 前缀路由：admit → waterfall → bridge）、240-250（Host/Origin 栅栏）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:40-90（bridge：只有 'buffered' 构造无 body 的 Request；否则 body: Readable.toWeb(req)，第 84 行）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-host-webserver/lib/index.js:399-410（handler reject：响应头已发出则销毁 socket，否则回 400）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-connection/README.zh.md:41、47、49; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-deliverables/lib/index.js:48-96（GET 路由都写 requestBody:'buffered'；lifetime 中止在途任务）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-deliverables/lib/client.js:283、423（'/api/present.host'.slice(1)；fetch 用相对路径）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/_app/main.js:12406-12414（protocol.handle 转发）、8266-8299（forwardWebRequest）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:108-147（connection/request：锁定时回 503；lock 时 await 全部在途请求）、216-237（桌面宿主以 --host 127.0.0.1 --port 0 启动）

## [confirmed] Q3-2 webServer.register（不鉴权）怎么注册？怎么补鉴权？客户端怎么调？

属实：
- ctx.webServer.register({ kind:'exact'|'prefix', path, handler(req,res) }) 只把路由写进表并返回 disposer，不会自动进 effect，必须写成 ctx.effect(() => ctx.webServer.register(...))。
- 匹配顺序：先精确路由，再最长前缀，最后 fallback。同一张表里路径重复会抛错。
- webServer 本身没有任何认证或来源检查。
- 补鉴权：handler 开头调 ctx.connection.requestRejection(req)，返回 401/403 就照写状态码结束。这和 /api 用的是同一套 admit 逻辑。官方 open-in-app 就是这么做的，浏览器端 fetch('open-in-app/apps')。
- webServer 路由放在 /api/... 下会因为「精确优先、最长前缀优先」抢在 /api 之前，从而绕过 /api 的 admit 与 waterfall。用户的样板 /api/dsh-upgrade 正是这种情况。
两处细节修正：
(1) handler 抛错时，若响应头还没发出则回 400；若已经发出则直接销毁 socket（不是一律回 400）。
(2) 自定义响应头不是 webServer 独有的优势：/api 精确路由返回的 Response 头也会原样写回。webServer 路由真正的必要场景是：长连接或 SSE（避开 /api 的更新锁），以及需要直接操作 Node res 的场合。

> 核查说明：细节修正（不影响结论）：handler 异常在响应头已发出时是销毁 socket 而不是回 400；「要自定义响应头」不是选 webServer 的理由，fetch 路由也能带自定义头。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-host-webserver/lib/index.js:320-333（register 只写表、返回 disposer）、399-410（异常处理）、495-505（match：exact → 最长 prefix）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md:12、61、71、130; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-host-open-in-app/lib/index.js:1126-1133、1160-1164、1264-1283（rejected(req,res) + ctx.effect(() => ctx.webServer.register(...))）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js:12、146; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:737-740（requestRejection）; /Users/bytedance/Documents/DSHarness Doc/dsh-auto-upgrade/plugin/lib/index.js:71-76（样板 prefix /api/dsh-upgrade，没有鉴权）

## [confirmed] Q3-3 实时推送怎么做（SSE 放哪条路、怎么写）？

属实。SSE 放在 /api 之外的 webServer exact 路由上，并在 handler 里用 requestRejection 鉴权。理由和证据：
- 官方常驻的 client-hmr 就是 webServer exact 路由 /plugins/events：writeHead text/event-stream 后持续 res.write('data: …\n\n')。注意官方这个路由本身没做鉴权，你自己的路由要补上。
- 桌面页面的 __DSH_TRANSPORT__ 只有 {ownsHost, streamBaseUrl}，没有 fetch，所以客户端直接 new EventSource('plugins/events')。
- dsh-app 协议注册了 stream:true 特权，主进程转发会保留流式与取消，所以 EventSource 经 dsh-app:// 在官方组件里已有实际使用。
- webServer 在桌面（web-app 补丁）开了 gzip（level 1，阈值 1024），但 text/event-stream 会被跳过。
不要放在 /api 上，两个原因：桌面更新锁会 await 所有在途 /api 请求；bridge 在客户端断开后用 continue 继续把响应流读完，不结束的流会泄漏。
客户端写法：ctx.effect 里 new EventSource('dsh-agent-hub/events')，返回 close；另外 ctx.on('connection/reset', 重拉全量)，官方 schedule 就是这个模式。宿主侧给 res 挂 'close' 和 'error'、写之前判断 destroyed / writableEnded 的建议是合理防护。

> 核查说明：补充证据（不改变结论）：dsh-app 协议的 stream:true 特权（main.js:11880-11890），以及桌面 profile 就是 web 模板、带 gzip 和常驻 client-hmr（main.js:3552、3637；web-app 补丁 179-188、214-219）。这些可以关闭原开放问题「desktop 是否开启 gzip」。第三方路由经 dsh-app:// 的 EventSource 仍需实测一次。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-hmr/lib/index.js:117-160（SSE connect；140-152 的 exact 路由没有 requestRejection）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-hmr/lib/client.js:235、289-305（没有 transport.fetch 时 new EventSource）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js:190（__DSH_TRANSPORT__={ownsHost:!0,streamBaseUrl:n}）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/_app/main.js:11880-11890（dsh-app 协议 privileges 含 stream:true、supportFetchAPI:true）、8258-8299（转发保留流式）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:179-188（webserver compression: gzip）、214-219（client-hmr 行 always mounted）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-host-webserver/lib/index.js:197-205（gzip 跳过 text/event-stream）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:116-147（/api 在途请求计数；lock 时 await）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:96-104（if (abort.signal.aborted) continue）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:7411-7412（$on schedule/changed + connection/reset 重拉）

## [corrected] Q3-4 Typert remote 事件、follow 流能不能给第三方用？机器人会话状态怎么实时拿？

「能用不能加」的结论属实：
- ctx.remote.$on 的合法事件名就是 API_REMOTE_FORWARDED_EVENTS 白名单。常用的几个及参数：api-session/status(agentId, running)、api-session/error(agentId, errorChain)、api-session/added(summary)、api-session/removed(sessionId)、schedule/changed、goal/activation-changed、settings/document-updated、plugin-manager/changed；approval/request 和 user-questions/request 是 waterfall。
- 通知只投递、不回放，重连后要自己重拉。$on 要求 interactions=answer，返回 disposer，订阅归调用方 fiber。
- 能力集合在构建时固定，Client 不会运行时发现宿主的新服务。
- 机器人会话状态最省事的读法是标准 hook：useSessionStatus(m => m.get(id)) 得到 {running, pendingInteraction, completionUnread}，其中 pendingInteraction 来自审批或提问域；useSessions(s => s.byId[id]) 得到 title、cwd、running、blank、updatedAt 等。
- 审批保持「用户在会话里点」（user-actions.md:11）。
【补充】
(1) 调用生成的命名空间方法（如 ctx.remote.schedule.update / history / delete）必须 inject 子服务 'remote.<ns>'，只注入 'remote' 读 ctx.remote.schedule 会抛 without inject，见 Q1-3。
(2) api-session/activity 只在 source.kind==='user' 的 user/message 上触发，机器人自己被唤醒（followup）大概率不会触发，不能拿它当「机器人最近活动」。
(3) 如果要展示的状态可以从机器人会话日志推导（例如目标进度快照），官方首选的通道是：宿主侧的 ctx.sessionProjections 单元声明 wire.view，客户端在会话级 slot 里用标准的 useProjection 读，值到达时已经算好。中心自己持有、不在会话日志里的数据（档案、额度、下次唤醒）仍走自建 fetch / SSE。
(4) 官方的 user-actions.md 推荐 UI 操作和 agent 工具共用一个宿主方法，UI 侧通过 ctx.remote.commands.execute(agentId, line) 跑会话命令。这条路只适用于「对某个机器人会话的操作」，而且会写 command/run 记录。

```
// 官方命名空间方法：注入 'remote.<ns>'（参照 dsh-client-ui-schedule）
ctx.inject(['remote', 'remote.schedule'], (c) => {
  c.effect(() => c.remote.$on('api-session/status', (agentId, running) => markRunning(agentId, running)))
  // const r = await c.remote.schedule.history(request) // 返回 RemoteResult {ok, value|error}
})
// 组件里读状态
function BotStatus({ sessionId, useSessionStatus, useSessions, t }) {
  const st = useSessionStatus((m) => m.get(sessionId)) // { running, pendingInteraction, completionUnread } | undefined
  const title = useSessions((s) => s.byId[sessionId]?.title)
  return st?.pendingInteraction ? t('awaitingYou') : (st?.running ? t('running') : t('idle')) + ' · ' + (title ?? sessionId)
}
```

> 核查说明：补充四点（原结论不变）：(1) 调用生成方法要 inject 'remote.<ns>'；(2) api-session/activity 只反映用户消息；(3) 能从会话日志推导的状态，官方通道是 projection 的 wire.view 加 useProjection；(4) user-actions.md 推荐的 commands.execute 路径。第 (2) 点里「followup 不触发」是按事件来源推断的，没有实测。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-api-remotes/lib/index.js:21-139（API_REMOTE_FORWARDED_EVENTS）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-api-remotes/README.zh.md:43、47、77-79; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2980-3003（status/error 用 agent.id；activity 只在 user/message 且 source.kind==='user' 时触发）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-api-gateway/lib/client.browser.js:796-801（subscribe 经 callerCtx.on 注册，返回 disposer）、1679-1682、2074-2076; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:7365-7377（inject 含 'remote.schedule'）、7406-7440（ctx.remote.schedule.delete / update / history 用法）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-session/lib/client.js:933-946、976-990（pendingInteraction 来自 pending 域；状态快照形状）、1105-1110（provideRoot hooks sessions/sessionStatus）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-api-session-controller/lib/client.js:3814-3819（sessions.list 快照 {ids, byId, phase, projectionsBySession}）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:7、38（客户端要的会话派生值用 Host projection 的 wire.view）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-session-projection/README.zh.md:32、36（ProjectionDefinition 带 wire 块投影给客户端）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/user-actions.md:7-11（UI 通过 ctx.remote.commands.execute() 走宿主入口；授权类动作仅限用户）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-api-remotes/lib/client.js:1255-1300（commands/execute 的参数 agent=SessionId、line）

## [confirmed] Q4-1 主题 CSS 变量有哪些？亮暗怎么跟随？

属实：
- 颜色 token 定义在 body 和 body[data-ds-dark-theme] 上（另有 html[data-platform=darwin] 变体）。
- ui-layout 的 ThemePresenter 按 ctx.theme 快照设置 html 的 color-scheme、切换 body[data-ds-dark-theme]，并把字号、字体变量和 active.tokens（含 overrideTokens 覆盖层）写成 body 上的内联变量。所以 CSS 只要引用 var(--dsw-alias-*) 就能自动跟随亮暗。
- --dsw-alias-* 在 theme 客户端各段 CSS 里共定义 107 个：design_platform.css 里 101 个，另有 onboarding-* 4 个和 settings-card-fill / settings-card-stroke 2 个。调研员列出的具体 token 都存在。
- 非颜色 token（--dsw-radius-*、--dsw-shadow-lv1~3、--dsw-elevation-*、--dsw-font-*、--dsw-focus-ring-*、--dsw-specific-menu、--dsw-menu-backdrop-filter）定义在同一个文件里。
- --dsh-content-font-size、--dsh-code-font-size 由呈现器用 JS 写入。
- --dsh-frame-top-clearance 在 macOS 是 48px，Windows 是标题栏高度，普通浏览器文档不发布这个变量，必须给兜底值 0px。官方任务页只在 [data-platform=darwin] 下给标题加它。
- ctx.theme.getTheme() 的快照字段是 { preference, fontSizes, fontFamilies, active:{…colorScheme, tokens}, themes, revision }，比原文多一个 themes。theme/change 的载荷就是这个快照。
- 用户样板里的 --dsh-accent / --dsh-fg / --dsh-border / --dsh-bg 在全部 308 个包的 JS/CSS 里都没有定义。

> 核查说明：小补充（不改变结论）：theme 快照还有 themes 字段；107 个 alias token 分布在 theme 客户端的多段 CSS 里，不全在 design_platform.css。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-theme/lib/client.js:1413（design_platform.css；选择器 body / body[data-ds-dark-theme] / html[data-platform=darwin] body）、1693-1695（getTheme）、1848-1860（buildSnapshot 字段）、1880（emit theme/change）、2029（provide theme）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-layout/lib/client.js:540-568（ThemePresenter.apply）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-layout/README.zh.md:39、43、47（frame clearance：macOS 48px、Windows 为标题栏高度、普通浏览器不发布；--dsh-content-font-size 等）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:33-34; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:2433（官方任务页 CSS）; /Users/bytedance/Documents/DSHarness Doc/dsh-auto-upgrade/plugin/lib/client.js:89、104、109（样板使用 --dsh-accent 等）

## [confirmed] Q4-2 toast / 通知的 API？

属实：
- 客户端没有通用的 toast 服务。workspace.toast 是 keyed slot，key 集合由 ui-workspace 的 ToastKind 表写死（archived、createFailed、pinFailed 等 11 个），不是给插件用的。
- 官方做法是功能插件自己持有一个可观察的提示状态，在 shell.overlay 注册条目来渲染。ScheduleDeleteToast、PluginRefreshToast 都是这样做的，内部用 primitives 的 Toast 组件。
- 第三方不能 require primitives，就照抄它的样式：position:fixed; top:40px; left:50%; transform:translate(-50%); z-index:1100; pointer-events:none; max-width:min(640px,calc(100vw - 48px)); padding:12px 16px; border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-toast-bg); color:var(--dsw-alias-toast-label); font-size:14px; line-height:22px; box-shadow:var(--dsw-shadow-lv3)。动画是 0.16s 淡入，停留 var(--dsh-toast-hold,3s) 后 1s 淡出。
- shell.overlay 整层点击穿透，需要可点击的部分自己加 pointer-events:auto。
- 系统通知：主进程对非麦克风权限的检查与请求一律放行，网页 Notification API 理论上可用，但没有官方先例。

> 核查说明：补充（不改变结论）：官方 Toast 自身是 pointer-events:none，停留时长由 --dsh-toast-hold（默认 3s）控制。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:5481-5539（shell.overlay：点击穿透，toast 归这里，新 id 追加）、6957-6985（workspace.toast 的 keyDomain 由 owner 固定）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:147-197（createDeleteToastSource + ScheduleDeleteToast 用 primitives.Toast）、7420-7428; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BNyAYEM7.css:1（._toast_l6cvn_6{…pointer-events:none…animation:…var(--dsh-toast-hold, 3s)…}）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/_app/main.js:7063-7072（非 media 权限 check 返回 true、request 回调 true）

## [confirmed] Q4-3 打开某个会话视图的 API？

属实：
- ctx.uiWorkspace.openSession(target) 内部是 replaceMain(target, lifetime.signal, 'reveal')。它同步把主区切回 Conversation 并选中该会话，不等历史加载。target 可以是会话 id，也可以是持久的直接父子 subagent 地址。
- 官方只在 sessionLinkState(...) === 'available' 时才调用。
- startSession(workspaceId?, { prompt, whenDraftExists:'keep'|'replace'|'append', clearPreviousDraft, agentPreset })：打开或复用该项目的空白会话并预填草稿，不会发送。
- selectPanel(null) 回到会话视图，但不换会话。
- openWorkspace / connectWorkspace / forkSession / archiveSession / unarchiveSession / pickDirectory / listDirectory / createDirectory 的签名都核对过。
小补充：官方 sessionLinkState 第一步是 workspaces.state === 'error' 时返回 'unavailable'，调研员的 openBotSession 少了这一判断，建议补上。

```
function openBotSession(ctx, sessionId) {
  const ws = ctx.get('uiWorkspace'), sessions = ctx.get('sessions'), workspaces = ctx.get('workspaces')
  if (!ws || !sessions || !workspaces) return 'unavailable'
  const list = sessions.list.getSnapshot(), wsList = workspaces.list.getSnapshot()
  if (wsList.state === 'error') return 'unavailable' // 官方第一步
  if (list.phase === 'pending' || wsList.phase === 'pending') return 'loading'
  if (wsList.archivedSessionIds.includes(sessionId)) return 'archived'
  if (!list.ids.includes(sessionId)) return 'unavailable'
  ws.openSession(sessionId)
  return 'opened'
}
```

> 核查说明：补充 workspaces.state==='error' 这一判断（官方第一步），属于小补充，不改变结论。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1471-1473（openSession）、1500-1510（startSession）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-workspace/README.zh.md:74、96; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:3651-3657（sessionLinkState，含 workspaces.state==='error'）、7441-7443; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1489-1610（uiWorkspace 方法签名）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-layout/README.zh.md:32

## [confirmed] Q4-4 右侧栏标签：ctx.sidebarRight.openTab 的 API，以及怎么注册一个 tab 类型？

属实。注册分两步：
① 类型：ctx.sidebarRightTabs.register({ id, kind, title, patterns?, priority?:'extension'|'builtin'|'fallback', canOpen?, guide?, keepMounted?, multiple? })。id 全局唯一，重复会抛错；kind 与已注册的类型不能共存时也抛错。返回的 disposer 要由调用方放进 ctx.effect。
② 正文：在 slot 'sidebar.right.pane.tab' 用 key = 类型 id 注册组件；可选再注册 'sidebar.right.pane.tab.title'。正文组件里用 useTabInfo() 读 { sidebar, panel, tab }。
打开：openTab(kind, { params?, paneId?, replaceTab?, revealIfOpened?, preferNewPane? })；资源类用 openResource('dsh-resource://<type>/…', opts)。
限制：
- 只作用于屏幕上的会话。mounted 为 undefined，或该会话的 store 还没被采用时，抛 sidebarRight: no session surface is mounted。
- kind 未注册也抛错。
- params 运行时不校验，也不随布局保存，刷新后 navigation.params 是 undefined，官方代码是按 undefined 兜底处理的。
- 布局按会话存在 localStorage 的 dsh.sidebar-right.v1.<sessionId>。
- 没有会话就没有右栏。
其他方法 close / active / isExpanded / toggleExpanded / tabsIn / registerCloseHandler / openTabs 都存在。
从中心页跳过去（先 openSession，再由该会话里的组件在 effect 里 openTab）的时序依据只有 README 描述，没有官方先例。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-sidebar-right/README.zh.md:74、83-84、93、97、144; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:2194（registerCloseHandler）、2226-2246（tabsIn / openResource / openTab）、2301（multiple）、2344-2365（close/active/isExpanded/toggleExpanded）、2594-2601（require 抛错）、4570-4600（register 校验）、4965-4966（provide sidebarRightTabs / sidebarRight）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:199-217（类型定义）、7454-7472、7502、6097-6099（params 为 undefined 时兜底）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js:22-36（guide 入口形状 {id, commandId, order, title, description, icon}）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:5844-5900

## [corrected] Q5 设置页能否注册自定义设置项？数据怎么存？

四个落点和 configForms 读写的描述属实：
- settings.section：设置弹窗里单独一页，owner props 给 {close}，label 可以是 thunk（官方 agent-presets 就这么写）。
- settings.general.item：在「通用」里加一行，行内一切（包括标签）自己画。
- settings.plugins.tab：设置里「插件」分区下的一个标签页。
- plugins.bundle.config：key = 组合包的 npm 包名，只以 { view:'page' } 渲染，不带 form，页面要自己调 ctx.configForms.get。
- plugins.row.config：key = '<包名>#<行 id>'，以 { view:'page', form } 或 { view:'summary' } 渲染；form 只在该命名空间被宿主服务时才有。
- plugins.bundle.activation：启用后的引导。
- plugins.item 被官方设置页占用，组合包的配置不要放这里。
- ctx.pluginNavigation.openBundle(包名) 可以直接跳到组合包页面。
- ctx.configForms.get(entryId)：命名空间就是 patch 行的 id。返回的对象有 getSnapshot() → { status, value, base, user, revision, writable }、subscribe；set(field, value) 和 unset(field) 都走 mutate；mutate(ops, expectedRevision?) 通过 remote.settings.mutate 写入，返回 Promise<boolean>，失败时自动重读。
- 只有 .volatile() 字段可以通过表单编辑，并持久化到 profile 的 Cordis patch。autoGenerate 目前没有客户端实现。
- 官方配对写法：宿主在可选的 ctx.inject(['settings'], …) 子插件里 child.effect(() => child.settings.configure({ auto:false }, ctx.fiber))。
【补充】宿主侧读取 volatile 字段时，拿到的是稳定引用，必须用 config.<field>.get() 读当前值（官方 agent-loop 写的是 ctx.agentLoop.config.maxParallelToolCalls.get()）。只改 volatile 字段时，Cordis 会就地提交到引用里、不重挂插件（_commitVolatile）。照原示例直接把 config.maxConcurrentBots 当数字用会出错。

```
// 宿主 index.js
import z from '@deepseek-ai/schemastery' // 链接安装的第三方包能否解析到它，见开放问题
export const Config = z.object({ maxConcurrentBots: z.number().step(1).min(1).max(8).default(2).volatile() })
export function apply(ctx, config) {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const maxConcurrent = () => config.maxConcurrentBots.get() // volatile 字段是引用，用 .get() 读当前值；改值时就地更新、不重挂
}
```

> 核查说明：补充：宿主读 volatile 字段必须 .get()（原示例的 apply(ctx, config) 没说明，会把引用当数值用）。plugins.item 是官方专用，plugins.bundle.config 不带 form，需要自己用 configForms.get。其余属实。

证据：/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/schemastery/README.md:393（.volatile() 把值解析为用 .get() 读取的稳定引用）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:553（config.maxParallelToolCalls.get()）、1554（.volatile() 声明）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/cordis/lib/index.js:382-395（只改 volatile 字段 → _commitVolatile，不重挂）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-settings/lib/client.js:1103-1170（ConfigFormController：快照字段、set/unset/mutate）、1290-1330（get(entryId) 即 namespace；whileServed）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-settings/README.zh.md:12、33、39; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-conversation/lib/index.js:1-25（Config busyEnter.volatile() + settings.configure）；lib/client.js:19737-19751（configForms.get('ui-conversation') + settings.general.item）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:326-327（行 id ui-conversation 等于 namespace）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js:2964（bundle.config 只传 {view:'page'}）、2818-2823 与 4143（row.config 传 {view:'page', form}）、3833-3840（formFor）、20-35（rowConfigKey = `${bundle}#${rowId}`）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-plugin-manager/README.zh.md:71-83; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:4528-4545（plugins.bundle.config）、4706-4712（plugins.item 被官方占用）、4759-4775（plugins.row.config）、5340-5372（settings.section owner props close）、5014-5020（settings.general.item 行内自绘）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js:2888-2890、2924-2935（openBundle(包名)；bundle.config / bundle.activation 的 key 都是组合包包名）; /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js:2490-2497（settings.section 的 label 用 thunk）

## 坑

- 【最致命，属实】启动审计 IZ：页面启动时，任何一个 Loader 条目没进入 active，前端都会抛 web boot: N entries did not activate。会触发的情况包括：bundle 语法错、require 了表外模块、factory 或 apply 抛错、顶层 inject 的服务一直不存在而停在 pending（错误信息会写出它在等哪个服务）。桌面版经 dshDesktopBoot.failed 交给 reportFatal('web-boot')，弹出「退出 / 重启 / 禁用第三方插件、备份 profile patch 并重启」的致命框。对策：顶层 inject 只放 ['slots','locale']；其余服务用 ctx.get 或 ctx.inject 子插件，子 fiber 不在审计范围内；apply 整体 try/catch；apply 里不要 await 网络。运行中热装失败只显示在「设置 → 插件 → 插件列表」，下次启动才变成致命框。证据：index-BXV-oxvX.js:188、190；_app/main.js:12433-12438、8355-8380；dsh-client-modules/README.zh.md:42。
- 【属实】宿主启动时 client-modules 构造器同步扫描，任何组合失败都会抛 ClientPackageCompositionError：声明了 dsh.client 但 lib/client.js 不存在、exports['./client'] 形状不对、同一包名从两个 Loader 来源解析到，都算组合失败。这会让 clientModules 激活失败、整页起不来。运行中重组时同样的错误只记 warn，下次启动才爆。证据：dsh-client-modules/lib/index.js:537-562、545-556、830-841、890-896。
- 【属实】client.js 会以经典脚本形式与其他插件原样拼接执行：顶层 import/export 是语法错误；顶层 let/const/class 进入全局词法作用域，与别人重名就 SyntaxError；load 的 id 必须等于 package.json name。某个 combo 没登记到某行时会退回单资源 URL 重试，但该行自身的错误依然会让它导入失败。证据：dsh-client-modules/lib/index.js:337-341；lib/client.js:581-594、728-775。
- 【改正】Cordis 4 没有可选 inject，未声明的服务读 ctx.xxx 会抛 without inject，这一点属实。但 timer 不是只给动态包：dsh-cordis-client-runner（web-app 默认启用）全局提供 'timer' 服务，普通插件可以 ctx.inject(['timer'], c => c.interval(fn, ms))，也可以继续用 ctx.effect 包 setInterval。证据：dsh-cordis-client-runner/lib/client.js:7227-7239、7467；dsh-web-app/cordis.patch.yml:251-252。
- 【新增】ctx.remote 的每个官方命名空间都是子服务 'remote.<ns>'。调用 ctx.remote.session / schedule / … 的生成方法必须在 inject 里写 'remote.<ns>'（官方 schedule 写 'remote.schedule'），只注入 'remote' 会抛 cannot get property "remote.<ns>" without inject。证据：dsh-api-gateway/lib/client.browser.js:2074-2076；cordis/lib/index.js:123-131；dsh-client-ui-schedule/lib/client.js:7365-7377。
- 【属实】ctx.connection.fetch.register 会自动挂到调用方的 effect 上；ctx.webServer.register 不会，必须写 ctx.effect(() => ctx.webServer.register(...))。两边路径重复都会抛错，导致 apply 失败。
- 【属实，并补充】/api 精确路由只能精确匹配 pathname，参数放 query；路径段只能是 [A-Za-z0-9_$.-]；只有 owner Peer 能调。补充（推断）：requestBody 必须显式写 'buffered'，GET 路由尤其如此，省略或写 'streaming' 会给 GET 构造带 body 的 Request，最终回 400。证据：dsh-client-connection/lib/index.js:822-825、54-84。
- 【属实】长连接不要挂在 /api 上：桌面更新锁会等所有在途 /api 请求结束；更新安装期间新的 /api 请求直接回 503；bridge 在客户端断开后还会继续把响应流读完。SSE 放在 /api 之外的 webServer exact 路由，并配合 requestRejection。官方 /plugins/events 这个 SSE 路由本身没做鉴权，不要照抄这一点。
- 【属实】不要把不鉴权的 webServer 路由放在 /api/... 下：精确优先、最长前缀优先的规则会让它抢在 /api 之前，绕过 Cookie 和 Host/Origin 校验。用户的 dsh-auto-upgrade 样板 /api/dsh-upgrade 正是这种情况。
- 【属实，细节修正】宿主侧向 SSE 写数据前要检查 res.destroyed / writableEnded，并监听 'error'。webServer handler 抛错时：响应头还没发出就回 400，已经发出就直接销毁 socket。「宿主未处理异常会让整个应用退出」引自底稿 06，本次没有复核。
- 【属实】用户样板里的 --dsh-accent / --dsh-fg / --dsh-border / --dsh-bg 在 308 个包里都没有定义，颜色一律用 --dsw-alias-*（共 107 个）。--dsh-frame-top-clearance 在普通浏览器里不存在，必须写兜底值 0px。
- 【属实】官方禁止 require primitives 等 Harness 客户端包。组件抛错时，该条目会被摘除，控制台打印 slot entry crashed in '<slot>'（list 和 single 会让出座位，chain 不会）。复杂组件自己包一层错误边界。证据：dsh-client-ui-renderer/lib/client.js:638、1140。
- 【改正】single slot 不是「注册会顶掉官方 UI」：已有占位时，用默认 priority 0 注册会直接抛错；只有显式给更小的 priority 才会遮蔽（数值小者渲染）。keyed / list 的 key 或 id 与已有条目同 priority 也抛错。slot 目录文档里「reusing a shipped id … replaces it」和代码冲突，以代码为准。shell.bottom 在默认组合里没被占用，可以独占使用。所有 id/key 都加 dsh-agent-hub 前缀；main 的 key 避开 conversation、plugins、schedules。证据：index-BXV-oxvX.js:120；dsh-client-ui-layout/README.zh.md:34。
- 【属实】shell.overlay 整层点击穿透，官方 Toast 自身也是 pointer-events:none，需要可点击的部分自己加 pointer-events:auto。
- 【属实】ctx.sidebarRight.openTab 只作用于屏幕上的会话：中栏是全局页、或该会话的 store 还没被采用时会抛错。tab 的 navigation.params 刷新后丢失。没有会话就没有右栏。
- 【属实】中栏页面的选中状态刷新即重置，没有 URL 路由；selectPanel 传未注册的 key 会抛错；main 只渲染当前选中的那一页。
- 【属实】客户端条目只以 { name: 包名 } 创建，拿不到 patch 行的 config。客户端需要配置时，走宿主接口或 ctx.configForms.get(行 id)。
- 【改正】会话级 slot 条目不是「在所有会话里各挂一份」，而是只挂在当前被渲染的会话界面里，切换会话时重挂。后台逻辑不要放在会话级组件里；非机器人会话直接 return null。侧栏会话行座位刻意设计成 root 级，就是为了避免激活每个 Session。证据：dsh-client-ui-workspace/README.zh.md:96。
- 【新增】宿主 Config 里的 .volatile() 字段在 apply 里拿到的是引用，必须 config.x.get() 读取；只改 volatile 字段时就地更新、不重挂。证据：schemastery/README.md:393；dsh-agent-loop/lib/index.js:553；cordis/lib/index.js:382-395。
- 【新增】手写插件的样式不要在 factory 顶层插入：官方作者规范要求 factory 无副作用，样式在 apply 的 ctx.effect 里注册并返回清理函数，或者在组件里渲染 <style>。证据：references/ui-plugin.md:13；practices.md:36。
- 【属实，补充】locale.register(ns, {zh, en}) 时，同一个 (ns, locale) 重复注册会抛错。「双语齐全」只在类型层面要求，运行时不校验。namespace 要全局唯一。证据：dsh-client-locale/lib/client.js:1387-1396、922。
- 【属实】文档相对路径：浏览器端一律去掉开头的 /，例如 fetch('api/…')、new EventSource('dsh-agent-hub/events')。桌面页面本身没有 Cookie，主进程删掉 cookie 后补上宿主 Cookie 再转发；Origin 存在且不是 dsh-app://app 的请求回 403。dsh-host-webserver README 里「Electron 通过 file:// 加载、经 IPC 承载 fetch」与 0.2.1-rc.5 的 main.js 不符（实际是 dsh-app:// 的 protocol.handle 转发），以 main.js 为准。
- 【属实】改写 lib/client.js 后，常驻的 client-hmr 每 500ms 检查文件的 mtime/ctime/size，发现变化就在已打开的页面热替换（React 状态丢失）。宿主半的代码变化要重启才会加载新的模块代。桌面 profile 就是 web 模板，所以 HMR 在桌面也是常驻的。证据：dsh-client-hmr/lib/index.js:14-17、107-118；_app/main.js:3552、3637。
- 【新增，属于界面体验】桌面在退出 App 和检查更新时，会把「running 状态、或 inbox 非空的 agent」以及运行中的 job 计为活动任务。常驻机器人在跑时，用户退出会看到「有任务在运行」的确认框。证据：dsh-desktop-host/lib/index.js:100-101、147、160-180；_app/main.js:11622-11630。
- 【属实】让 DSH 自己实现时，先用 cordis_inspect_query 的 Slots.listSubTree、Theme、Service 查当前安装的真实 slot、token 和服务签名，比笔记更权威（SKILL.md:23、30）。

## 未决

- 全部结论来自读源码，没有在本机运行 DSH。下面三项需要装上后实测一次：esbuild 产出的 factory 包能否正常物化；第三方 webServer 路由上的 EventSource 经 dsh-app:// 转发是否稳定（官方 HMR 走的是同一条路，协议也有 stream:true 特权）；GET 路由省略 requestBody 时是否如推断那样回 400。
- 网页 Notification API 在桌面窗口里能否真的弹出系统通知：主进程对非麦克风权限一律放行，但 macOS 系统层的通知授权和表现没有核实。
- ctx.uiWorkspace.openSession 对没挂到任何项目的会话是否可用：官方只在会话出现在 sessions.list 里才调用。另外侧栏会话行座位（row.leading / hover）只出现在工作区列出的会话上。宿主是否必须把机器人会话挂到某个工作区，留给宿主主题确认。
- 从中心页先 openSession、再由该会话里的组件在 effect 里 openTab，这个时序只依据 sidebar-right README 的描述，没有官方的跨页打开先例。
- 第三方链接安装的宿主半能否直接 import '@deepseek-ai/schemastery' 来声明 .volatile() Config：官方包能这样写，但 link 包的解析路径没有核实。dsh-settings 是否把第三方组合包插入的行当作「活动且可唯一定位的 profile 条目」服务给 ctx.configForms，也没有核实。两者都不行的话，设置数据只能走自建宿主接口。
- 没找到让插件打开设置弹窗并定位到某个 section 的公开服务：settings-general 里的 openSection 没有对外提供。目前能用代码跳转的只有 ctx.pluginNavigation.openBundle(包名)。
- 宿主半 fiber 停在 pending 时，客户端半是否仍会加载：client-modules 只检查条目存在、有 fiber 且未禁用（lib/index.js:855），推测仍会加载，没有实测。
- 已关闭：zod 版本是 4.4.3（index-BXV-oxvX.js:59）；桌面 webServer 开了 gzip（web-app 补丁 179-188），SSE 自动跳过；308 个包里只有 dsh-desktop-host 监听 connection/request。
