/**
 * 功能折叠的真实浏览器验收：独立 Chrome 操作本地隔离预览，不操作生产 DSH。
 * 覆盖点击、键盘、刷新记忆、整条侧栏收起及插件卸载恢复；截图写到系统临时目录。
 * 先启动 UI 预览，再运行 node packages/plugin/test/host-navigation-browser.mjs <预览 URL>。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const url = process.argv[2] ?? 'http://127.0.0.1:3953'
if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) throw new Error('验收只允许访问本机预览。')
const evidence = mkdtempSync(resolve(tmpdir(), 'buddy-navigation-check-'))
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  `--user-data-dir=${evidence}/profile`, '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let ws
try {
  const endpoint = await new Promise((ok, fail) => {
    let log = ''
    const timer = setTimeout(() => fail(new Error('Chrome 调试端口未启动')), 15000)
    chrome.stderr.on('data', chunk => {
      log += chunk
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timer); ok(match[1]) }
    })
    chrome.on('error', error => { clearTimeout(timer); fail(error) })
  })
  ws = new WebSocket(endpoint)
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail })
  const pending = new Map()
  const errors = []
  let nextId = 0, sessionId
  ws.onmessage = event => {
    const data = JSON.parse(event.data)
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text)
    const job = pending.get(data.id)
    if (!job) return
    pending.delete(data.id)
    data.error ? job.fail(new Error(JSON.stringify(data.error))) : job.ok(data.result)
  }
  const call = (method, params = {}, session = sessionId) => new Promise((ok, fail) => {
    const id = ++nextId
    pending.set(id, { ok, fail })
    ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
  const target = await call('Target.createTarget', { url: 'about:blank' }, null)
  sessionId = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  const frame = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const ready = () => evaluate(`new Promise((resolve,reject)=>{
    let count=0;const check=()=>{if(document.querySelector('.ah-host-navigation-toggle'))resolve(true);
    else if(count++>120)reject(Error('功能折叠开关没有加载'));else requestAnimationFrame(check)};check()
  })`)
  const click = async selector => {
    const point = await evaluate(`(()=>{
      const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('找不到验收控件');
      const r=e.getBoundingClientRect();if(!r.height)throw Error('验收控件不可见');
      return {x:r.x+r.width/2,y:r.y+r.height/2}
    })()`)
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await frame()
  }
  const snapshot = () => evaluate(`(()=>{
    const b=document.querySelector('.ah-host-navigation-toggle');
    const nav=document.querySelector('.preview-navigation'),list=document.querySelector('.ah-host-botlist');
    const workspace=document.querySelector('[data-original-workspace]');
    return {expanded:b?.getAttribute('aria-expanded'),controls:b?.getAttribute('aria-controls'),
      navId:nav.id,navHeight:nav.getBoundingClientRect().height,listY:list?.getBoundingClientRect().y,
      workspaceHeight:workspace.getBoundingClientRect().height,
      newSessionHeight:document.querySelector('.preview-new-session')?.getBoundingClientRect().height,
      toggles:document.querySelectorAll('.ah-host-navigation-toggle').length,
      sameNav:window.__navigationNode===nav,sameWorkspace:window.__workspaceNode===workspace,
      overflow:document.documentElement.scrollHeight>innerHeight}
  })()`)
  const shot = async name => {
    const result = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(evidence, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  await call('Page.navigate', { url })
  await ready()
  await evaluate("window.__navigationNode=document.querySelector('.preview-navigation');window.__workspaceNode=document.querySelector('[data-original-workspace]');true")
  const expanded = await snapshot()
  assert.equal(expanded.expanded, 'true')
  assert.equal(expanded.controls, expanded.navId)
  assert.equal(expanded.toggles, 1)
  await shot('expanded-light')
  await click('.ah-host-navigation-toggle')
  const collapsed = await snapshot()
  assert.equal(collapsed.expanded, 'false')
  assert.equal(collapsed.navHeight, 0)
  assert(collapsed.listY < expanded.listY - 100)
  assert(collapsed.workspaceHeight > expanded.workspaceHeight)
  assert.equal(collapsed.sameNav, true)
  assert.equal(collapsed.sameWorkspace, true)
  assert.equal(collapsed.newSessionHeight, expanded.newSessionHeight)
  assert.equal(collapsed.overflow, false)
  await shot('collapsed-light')
  // 真正刷新页面，确认记忆在新组件实例里恢复。
  await call('Page.reload')
  await ready()
  assert.equal((await snapshot()).expanded, 'false')
  await click('.ah-host-navigation-toggle')
  assert.equal((await snapshot()).expanded, 'true')
  // 原生按钮的键盘行为：聚焦后按 Enter 收起，Space 再展开。
  for (const [key, code, vk, text, expected] of [
    ['Enter', 'Enter', 13, '\r', 'false'], [' ', 'Space', 32, ' ', 'true'],
  ]) {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
    await frame()
    assert.equal((await snapshot()).expanded, expected)
  }
  await click('.ah-host-navigation-toggle')
  await click('[aria-label="收起宿主侧栏"]')
  assert.equal(await evaluate("document.querySelectorAll('.ah-host-navigation-toggle').length"), 0)
  assert.equal(await evaluate("document.querySelector('.preview-navigation').hasAttribute('data-dsh-buddy-nav-collapsed')"), false)
  await click('[aria-label="收起宿主侧栏"]')
  await ready()
  assert.equal((await snapshot()).expanded, 'false')
  // 模拟宿主组件卸载与再挂载，确保原节点和原属性完整恢复。
  await evaluate("window.__savedNav=document.querySelector('.preview-navigation');window.__previewSidebar.mount(false);true")
  await frame()
  assert.equal(await evaluate("document.querySelectorAll('.ah-host-navigation-toggle').length"), 0)
  assert.equal(await evaluate("document.querySelector('.preview-navigation').hasAttribute('data-dsh-buddy-nav-collapsed')"), false)
  assert.equal(await evaluate("document.querySelector('.preview-navigation').hasAttribute('id')"), false)
  assert.equal(await evaluate("document.querySelector('.preview-navigation')===window.__savedNav"), true)
  await evaluate('window.__previewSidebar.mount(true);true')
  await ready()
  assert.equal((await snapshot()).expanded, 'false')
  assert.equal((await snapshot()).toggles, 1)
  // 低高度暗色视口：折叠后队友和工作区仍可见，不出现页面纵向溢出。
  await evaluate("document.documentElement.dataset.theme='dark';true")
  await call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 600, deviceScaleFactor: 1, mobile: false })
  await frame()
  const compact = await snapshot()
  assert.equal(compact.navHeight, 0)
  assert(compact.workspaceHeight > 70)
  assert.equal(compact.overflow, false)
  await shot('collapsed-dark-1024')
  // 在功能导航收起时仍能直接打开队友线程。
  await click('.ah-host-botlist .ah-botlist-rows > button')
  assert.equal(await evaluate('window.__previewPanel'), 'agent-hub')
  assert.equal(await evaluate('window.__previewHub.getSnapshot().selectedThread'), 'team')
  await click('.ah-host-navigation-toggle')
  assert.equal((await snapshot()).expanded, 'true')
  assert.deepEqual(errors, [])
  writeFileSync(resolve(evidence, 'checks.json'), JSON.stringify({ expanded, collapsed, compact, errors }, null, 2))
  console.log(`PASS：点击、键盘、刷新记忆、侧栏模式、卸载恢复、低高度暗色布局、队友导航。证据：${evidence}`)
} finally {
  ws?.close()
  chrome.kill('SIGTERM')
}
