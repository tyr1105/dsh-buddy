// 构建脚本：用 esbuild 产出宿主半边 lib/index.js（Node ESM）与界面半边 lib/client.js（经典脚本）。
// 为什么这样设计：
// - 宿主半边是 Node ESM，bundle 后运行时零依赖（本卡不 import core；D02 会把 @agent-hub/core 打进来）。
// - 界面半边必须符合 DSH 客户端契约：整份文件只调用一次 window.__ModuleLoader__.load({id, factory})，
//   顶层不能有 import/export/let/const/class（多个插件的经典脚本会拼在同一个全局词法作用域里执行），
//   所以用 banner/footer 把 esbuild 的 CJS 产物包进 factory 闭包。
// - CSS 用 text loader 当字符串导入，由 apply 里的 ctx.effect 插入 <style>。
import { build } from 'esbuild'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

// 打印产物大小，方便在构建日志里确认两个文件都生成了。
function report(file) {
  const size = statSync(file).size
  const kb = (size / 1024).toFixed(1)
  console.log(`[agent-hub] 产物 ${join(root, file)} ${kb} KB`)
}

// 1) 宿主半边：Node ESM，external 只放 Node 内置模块（node:* 与裸名内置模块）。
const hostExternal = new Set()
for (const name of [
  'node:fs', 'node:path', 'node:os', 'node:url', 'node:util', 'node:events', 'node:stream',
  'node:crypto', 'node:process', 'node:timers', 'node:child_process', 'node:net', 'node:http',
  'node:https', 'node:buffer', 'node:string_decoder', 'node:zlib',
]) {
  hostExternal.add(name)
  hostExternal.add(name.slice('node:'.length)) // 裸名内置模块也保持 external
}

await build({
  entryPoints: [join(root, 'src/host/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(root, 'lib/index.js'),
  external: [...hostExternal],
  sourcemap: false,
  logLevel: 'info',
})
report('lib/index.js')

// 2) 界面半边：浏览器 CJS，React 四件套 external（运行时由 DSH 基座模块表提供）。
//    banner/footer 把产物包成 window.__ModuleLoader__.load({ id, factory: function (require) { … } })。
const clientBanner = `window.__ModuleLoader__.load({ id: 'dsh-agent-hub', factory: function (require) { var module = { exports: {} }; var exports = module.exports;`
const clientFooter = `return module.exports } })`

await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  jsx: 'automatic',
  jsxDev: false,
  outfile: join(root, 'lib/client.js'),
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  loader: { '.css': 'text' },
  banner: { js: clientBanner },
  footer: { js: clientFooter },
  sourcemap: false,
  logLevel: 'info',
})
report('lib/client.js')
