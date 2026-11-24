/**
 * 真实浏览器回归：旧版与新版 DSH 侧栏的两个 DOM 观察器必须收敛。
 * 只使用本地源码、内存夹具和独立 Chrome，不连接 DSH、网络或模型。
 * 执行：node packages/plugin/test/host-space-browser.mjs；可用 CHROME_BINARY 指定 Chrome。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = process.env.BUDDY_SOURCE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const bundled = await build({
  stdin: { contents: 'export * from "./packages/plugin/src/client/logic/host-mount.ts"; export * from "./packages/plugin/src/client/logic/host-navigation.ts";', resolveDir: root },
  bundle: true, format: 'iife', globalName: 'BuddyMount', write: false,
})
const profile = mkdtempSync(resolve(tmpdir(), 'buddy-host-space-regression-'))
const chrome = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let ws
try {
  const endpoint = await new Promise((ok, fail) => {
    let log = ''
    const timer = setTimeout(() => fail(new Error('独立 Chrome 未启动')), 15000)
    chrome.stderr.on('data', chunk => {
      log += chunk
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) { clearTimeout(timer); ok(match[1]) }
    })
    chrome.once('error', error => { clearTimeout(timer); fail(error) })
    chrome.once('exit', code => { clearTimeout(timer); fail(new Error(`Chrome 提前退出：${code}`)) })
  })
  ws = new WebSocket(endpoint)
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail })
  let nextId = 0
  const pending = new Map()
  ws.onmessage = event => {
    const data = JSON.parse(event.data)
    const job = pending.get(data.id)
    if (!job) return
    pending.delete(data.id)
    data.error ? job.fail(new Error(JSON.stringify(data.error))) : job.ok(data.result)
  }
  const call = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++nextId
    pending.set(id, { ok, fail })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  await evaluate(bundled.outputFiles[0].text)
  const report = await evaluate(`(${async function () {
    const { watchHostSpace, watchHostNavigation, findHostSpaceRoot } = BuddyMount
    const results = []
    const wait = () => new Promise(resolve => setTimeout(resolve, 25))
    const entry = '<button class="host-entry"><svg class="ah-entry-icon"></svg></button>'
    const fixture = (nested, withEntry = true) => `<aside class="demo_root"><div class="demo_topStrip"></div><div class="demo_logoRow">DSH</div><div class="demo_newSessionRow"><button class="demo_newSession">New</button></div>${nested ? '<div class="demo_scrollRegion"><div class="demo_scrollArea">' : ''}<nav class="demo_panelList">${withEntry ? entry : ''}</nav><div class="demo_regionArea"></div>${nested ? '</div><span class="demo_scrollFade"></span></div>' : ''}<footer></footer></aside>`
    document.head.innerHTML = '<style>.demo_root,.demo_scrollArea{width:240px;height:500px}</style>'
    // 每个观察器闭环都有同步上限：旧实现失败时仍可退出，不让测试锁住浏览器。
    async function scenario(name, nested, lifecycle = false) {
      document.body.innerHTML = fixture(nested, !lifecycle)
      let changes = 0, exceeded = false
      const states = [], cleanups = []
      const stop = () => { for (const cleanup of cleanups.splice(0)) cleanup() }
      cleanups.push(watchHostSpace(document, { getMode: () => 'chat', onChange: state => {
        changes += 1
        if (state.kind === 'slot') states.push({ root: state.switcher.parentElement?.className, anchor: state.switcher.getAttribute('data-ah-space-anchor') })
        if (changes >= 40) { exceeded = true; stop() }
      } }))
      cleanups.push(watchHostNavigation(document))
      try {
        await wait()
        if (exceeded) throw new Error('没有外部 DOM 更新，挂载通知已达 40 次自循环上限')
        const sidebar = document.querySelector('.demo_root')
        if (findHostSpaceRoot(document) !== sidebar) throw new Error('挂载根不是含标识行的整根侧栏')
        const initialSwitcher = sidebar.querySelector('[data-plugin-space]')
        if (initialSwitcher?.previousElementSibling?.className !== 'demo_logoRow') throw new Error('切换器不在标识行之后')
        if (lifecycle) {
          const nav = sidebar.querySelector('nav')
          nav.innerHTML = entry
          await wait()
          if (findHostSpaceRoot(document) !== sidebar || sidebar.querySelector('[data-plugin-space]') !== initialSwitcher) throw new Error('入口延迟注册导致挂载根或 portal 容器变化')
          nav.innerHTML = ''
          await wait()
          nav.innerHTML = entry
          await wait()
          if (findHostSpaceRoot(document) !== sidebar || sidebar.querySelector('[data-plugin-space]') !== initialSwitcher) throw new Error('入口移除重建导致挂载根或 portal 容器变化')
          document.body.innerHTML = fixture(nested)
          await wait()
          if (findHostSpaceRoot(document) !== document.querySelector('.demo_root')) throw new Error('宿主侧栏重建后没有恢复整根挂载')
          if (document.querySelector('[data-plugin-space]') === initialSwitcher) throw new Error('宿主侧栏重建后未更换 portal 容器')
        }
        const toggle = document.querySelector('.ah-host-navigation-toggle')
        if (!toggle || toggle.nextElementSibling?.tagName !== 'NAV') throw new Error('功能导航折叠按钮没有紧贴原生导航')
        toggle.click()
        if (toggle.getAttribute('aria-expanded') !== 'false') throw new Error('功能导航无法折叠')
        const settled = changes
        document.querySelector('.demo_root').classList.add('host-rerender')
        await wait()
        if (changes !== settled) throw new Error('无关 class 更新触发 portal 重新发布')
        if (document.querySelectorAll('[data-plugin-space]').length !== 1 || document.querySelectorAll('.ah-host-navigation-toggle').length !== 1) throw new Error('自有节点重复')
        results.push({ name, pass: true, changes, first: states[0] })
      } catch (error) {
        results.push({ name, pass: false, changes, first: states[0], error: error.message })
      } finally { stop() }
      if (document.querySelector('[data-plugin-space],.ah-host-navigation-toggle,[data-ah-space-root]')) throw new Error('卸载未清理挂载节点')
    }
    await scenario('旧版直接子节点：两个观察器共存并可折叠', false)
    await scenario('新版滚动容器：两个观察器共存并收敛', true)
    await scenario('新版入口延迟、移除重建与整根侧栏重建', true, true)
    // DSH 0.2.2 起滚动容器是真实的 grid：列「4px 264px 6px」、行「8px 自动 2px 自动」，
    // 原生导航写死在第 2 行第 2 列，工作区写死在第 4 行第 2 列（0.2.3-alpha.2 实测）。
    // 折叠按钮必须和导航同列、紧贴在导航上方：不指定列会被挤进 4px 的内边距轨道，
    // 只指定列会被排到工作区下面。
    {
      const name = '新版 grid 滚动容器：折叠按钮紧贴在导航上方'
      const style = document.createElement('style')
      style.textContent = [
        '.demo_grid .demo_scrollArea{display:grid;grid-template-columns:4px 264px 6px;grid-template-rows:8px auto 2px auto;align-content:start;width:274px}',
        '.demo_grid .demo_panelList{grid-column:2;grid-row:2;min-height:100px}',
        '.demo_grid .demo_regionArea{grid-column:2;grid-row:4;min-height:100px}',
        // 与 workspace.css 里的两条规则保持一致：按钮高度，以及共用格子时导航让出的空间。
        'button.ah-host-navigation-toggle{display:flex;width:calc(100% - 24px);min-height:28px;margin:3px 12px;padding:4px 8px;border:0}',
        '.ah-host-navigation-toggle svg{width:12px;height:12px;flex-shrink:0}',
        "nav[data-dsh-buddy-nav-cell='true']{margin-top:34px}",
        "nav[data-dsh-buddy-nav-collapsed='true']{display:none !important}",
      ].join('')
      document.head.append(style)
      document.body.innerHTML = fixture(true)
      document.querySelector('.demo_root').classList.add('demo_grid')
      const cleanup = watchHostNavigation(document)
      try {
        await wait()
        const toggle = document.querySelector('.ah-host-navigation-toggle')
        const nav = document.querySelector('nav')
        const region = document.querySelector('.demo_regionArea')
        if (!toggle) throw new Error('功能导航折叠按钮没有挂上')
        const box = toggle.getBoundingClientRect(), navBox = nav.getBoundingClientRect(), regionBox = region.getBoundingClientRect()
        if (box.width < 200) throw new Error(`折叠按钮只有 ${box.width}px 宽，被挤进了窄轨道`)
        if (box.bottom > navBox.top + 4) throw new Error(`折叠按钮没有排在导航上方（按钮底 ${box.bottom}，导航顶 ${navBox.top}）`)
        if (navBox.top - box.bottom > 8) throw new Error(`折叠按钮与导航之间空了 ${navBox.top - box.bottom}px`)
        if (box.top >= regionBox.top) throw new Error('折叠按钮被排到了工作区下面')
        toggle.click()
        await wait()
        const folded = toggle.getBoundingClientRect(), regionAfter = region.getBoundingClientRect()
        if (nav.getBoundingClientRect().height !== 0) throw new Error('折叠后导航仍然占位')
        if (folded.width < 200 || folded.bottom > regionAfter.top + 4) throw new Error('折叠后按钮位置不对')
        toggle.click()
        results.push({ name, pass: true, toggle: { width: box.width, gapToNav: navBox.top - box.bottom } })
      } catch (error) {
        results.push({ name, pass: false, error: error.message })
      } finally { cleanup(); style.remove() }
      if (document.querySelector('[data-dsh-buddy-nav-cell]')) throw new Error('卸载未清理导航上的共用格子标记')
    }
    document.body.innerHTML = '<header><div class="demo_logoRow">unrelated</div></header><section><nav class="demo_panelList"></nav></section><section class="demo_regionArea"></section>'
    results.push({ name: '无入口且标识与导航分属不同区域：保守降级', pass: findHostSpaceRoot(document) === null })
    return results
  }.toString()})()`)
  console.log(JSON.stringify(report, null, 2))
  if (report.some(result => !result.pass)) process.exitCode = 1
} finally {
  ws?.close()
  const exited = new Promise(resolve => chrome.once('exit', resolve))
  chrome.kill('SIGTERM')
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))])
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
}
