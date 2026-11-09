/**
 * 可访问性静态契约（U01 体验巡检）。
 *
 * 为什么是静态契约：测试环境把 react 指到桩（见 vitest.config.ts），不真正渲染组件；
 * 这里锁的是「组件必须遵守的形状」，防止后续重构把 WCAG 修复改回去。运行时行为
 * （真实焦点移动、七视图控件盘点）由 .tmp/u09/audit-r36.mjs 与 .tmp/u10/audit-r37.mjs
 * 的 CDP 探针兜底，证据存 test/ui-evidence/ 下对应 JSON。
 *
 * 第 36 轮覆盖：
 * - WCAG 2.5.3 标签即名称（A）：切换器徽章计数并入按钮名称、唤醒链接名称含可见
 *   时间文字、回放滑块不被动态时间读数冒名；
 * - WCAG 2.4.1 跳过区块（A）：插件第一个 Tab 停是跳过链接，激活后焦点落正文容器，
 *   且不与宿主的 main 地标重复。
 *
 * 第 37 轮覆盖：
 * - WCAG 1.3.1 信息与关系（A）：每个视图有页面级 h2 且标题不跳级；账本段与轨迹
 *   面板用真标题元素；功能型地标全部可命名；无标题的布局槽不得冒充 header 地标；
 * - WCAG 1.3.2 意义顺序（A）：CSS 重排必须在审计白名单里登记口径（运行时探针另验）。
 *
 * 第 38 轮覆盖：
 * - WCAG 3.2.1 聚焦时（A）：全客户端 onFocus 只允许「聚焦选中文本」一种便利行为，
 *   不存在 onBlur 改上下文；
 * - WCAG 3.2.2 输入时（A）：onChange/onInput 处理器不得直接导航、开弹层或发命令，
 *   写操作只能走显式按钮（运行时逐字段改值探针另验）；
 * - WCAG 4.1.2 名称/值/角色（A）：「更多」菜单的 aria-controls 在收起态也必须能
 *   解析到常驻面板（id 随挂载一直在，用原生 hidden 收展）。
 * 运行时探针：.tmp/u11/audit-r38.mjs，证据见 test/ui-evidence/u01-r38-*.json。
 *
 * 第 39 轮覆盖（对话框表面专项）：
 * - WCAG 4.1.2（A）：每个 role="dialog" 开标签都必须同时带 aria-modal="true"
 *   与显式 aria-label（字符串或表达式），模态与可访问名缺一不可；
 * - WCAG 1.3.1（A）：弹窗背景被 inert 剪枝，是独立标题表面——弹窗组件内的标题
 *   必须从 h2 起且不跳级（本轮把五个弹窗的 h3 统一提为 h2）；
 * - WCAG 2.4.6（AA）/4.1.2：弹窗可访问名与可见标题同源（同一 props.title 或同文案）。
 * 运行时探针：.tmp/u12/audit-r39.mjs，十个弹窗表面逐个做命名/标题/idref/只聚焦/
 * 逐字段改值/Esc 关闭取证，证据见 test/ui-evidence/u01-r39-dialog-surfaces.json。
 *
 * U10 覆盖（P44 新左栏三组导航 TeamSidebarNav；U01 第 45 轮拆成六个文件，
 * 静态契约对整组源码拼接生效，组合根专属断言另读主组件）：
 * - WCAG 2.4.3（A）：DOM 顺序固定为 办公室→队友→工作区，项目母行内
 *   展开箭头→项目名→加号、子会话在母行之后，真实 Tab 键运行时取证；
 * - WCAG 4.1.2（A）：每个可点项有中文可读名（aria-label/可见中文/中文数据绑定）；
 * - WCAG 2.5.8（AA）/2.4.7（A）：点击区 ≥24×24（收起态 32×32），焦点环经
 *   .ah-host-botlist 全局规则覆盖；WCAG 1.4.11（AA）：待验收状态点 ≥3:1。
 * 运行时探针：.tmp/u13/audit-u10.mjs（亮/暗两档、真实 Tab 遍历），
 * 证据见 test/ui-evidence/u10-sidebar-nav.json。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const clientRoot = new URL('../src/client/', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, clientRoot), 'utf8')

const spaceSwitch = read('components/space-switch.tsx')
const taskRow = read('pages/project-task-row.tsx')
const replayPage = read('pages/office-replay-page.tsx')
const hubPage = read('pages/HubPage.tsx')
const css = read('styles.css')
const workspaceCss = read('workspace.css')
const settingsPane = read('components/SettingsPane.tsx')
const activityPane = read('components/ActivityPane.tsx')
const resourcePage = read('pages/ResourcePage.tsx')
const wakeLedger = read('components/WakeLedger.tsx')
const trailPanel = read('components/office-trail-panel.tsx')
const threadPane = read('components/ThreadPane.tsx')
const officePage = read('pages/OfficePage.tsx')
const inboxPane = read('components/InboxPane.tsx')
const contextPanel = read('components/project-context-panel.tsx')
const projectPage = read('pages/ProjectPage.tsx')
const commandPalette = read('components/command-palette.tsx')
const artifactSection = read('components/artifact-section.tsx')
// 第 39 轮登记六个真实弹窗挂载点；P48 队友归档新增 bot-archive-dialog（其拦截态
// BlockedDialog 自带原生 role="dialog"，其余三态复用 ConfirmDialog），挂载点增至七个
// （use-drawer-focus.ts 里的 role="dialog" 只是注释示例）。
const newBotWizard = read('components/NewBotWizard.tsx')
const teachDialog = read('components/TeachDialog.tsx')
const confirmDialog = read('components/confirm-dialog.tsx')
const prjDialogShell = read('components/prj-dialog-shell.tsx')
const resourceDialogs = read('components/resource-dialogs.tsx')
const botArchiveDialog = read('components/bot-archive-dialog.tsx')
// U10：P44 新左栏三组导航与其宿主挂载逻辑。
// U01 第 45 轮：左栏拆成主组件 + 共享零件 + 图标列 + 内联表单 + 两个分组共六个文件，
// 整组源码拼接后跑同一套静态契约；组顺序等组合根专属断言另读主组件，rail 断言读图标列文件。
const sidebarNavFileNames = [
  'team-sidebar-nav.tsx',
  'sidebar-nav-parts.tsx',
  'sidebar-nav-rail.tsx',
  'sidebar-session-form.tsx',
  'sidebar-teammates-group.tsx',
  'sidebar-workspaces-group.tsx',
]
const teamSidebarNav = sidebarNavFileNames.map(name => read(`components/${name}`)).join('\n')
const teamSidebarNavMain = read('components/team-sidebar-nav.tsx')
const teamSidebarRail = read('components/sidebar-nav-rail.tsx')
const hostMount = read('logic/host-mount.ts')

// ---------- 第 38 轮：事件处理器静态盘点辅助 ----------
// 递归列出客户端全部 ts/tsx（事件属性可能散落在任何组件里，必须全仓扫）。
const clientDir = fileURLToPath(clientRoot)
const walkSource = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkSource(p))
    else if (/\.(tsx|ts)$/.test(name)) out.push(p)
  }
  return out
}

/**
 * 从 JSX 属性的开花括号起做配对提取，跳过引号字符串、模板串（含 ${} 嵌套）与注释，
 * 返回处理器表达式正文。与 .tmp/u11/audit-r38.mjs 的 readBalanced 同一份逻辑，
 * 保证静态契约和运行时审计口径一致。
 */
const readBalanced = (text: string, openIdx: number): string => {
  let depth = 0
  let quote: string | null = null
  let lineComment = false
  let blockComment = false
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (lineComment) { if (c === '\n') lineComment = false; continue }
    if (blockComment) { if (c === '*' && n === '/') blockComment = false; continue }
    if (quote) {
      if (quote === '`' && c === '$' && n === '{') { depth++; i++; quote = null; continue }
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '/' && n === '/') { lineComment = true; i++; continue }
    if (c === '/' && n === '*') { blockComment = true; i++; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return text.slice(openIdx + 1, i) }
  }
  return text.slice(openIdx + 1)
}

interface HandlerHit { file: string; body: string }
const collectHandlers = (kind: 'Focus' | 'Blur' | 'Change' | 'Input'): HandlerHit[] => {
  const hits: HandlerHit[] = []
  const re = new RegExp(`on${kind}\\s*=\\s*\\{`, 'g')
  for (const file of walkSource(clientDir)) {
    const text = readFileSync(file, 'utf8')
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text))) {
      hits.push({
        file: file.replace(/\\/g, '/').replace(clientDir.replace(/\\/g, '/'), ''),
        body: readBalanced(text, m.index + m[0].length - 1).replace(/\s+/g, ' ').trim(),
      })
    }
  }
  return hits
}

// 危险记号与审计探针 INPUT_DANGER_RE 保持一致：导航 / 开弹层选线程 / 直接发命令或提交。
const INPUT_DANGER_RE = /window\.open|location\.(assign|replace|href)|history\.(push|replace)|\bsetView\s*\(|\.selectThread\s*\(|\.selectTeammate\s*\(|props\.run\s*\(|\brun\s*\(\s*['"]|\.command\s*\(|props\.onSave\s*\(|props\.onSubmit\s*\(/

describe('WCAG 2.5.3 切换器：徽章计数并入按钮名称', () => {
  it('只有队友模式且有待处理数时才展示徽章，对话模式永不带计数', () => {
    // 可选 badge 先归一成数值常量，下游不再处理 undefined。
    expect(spaceSwitch).toContain('const badgeCount = props.badge ?? 0')
    expect(spaceSwitch).toContain(
      "const showBadge = mode === 'team' && badgeCount > 0",
    )
  })

  it('有徽章时名称包含可见计数，语音念「队友」仍可命中', () => {
    expect(spaceSwitch).toContain('const accessibleName = showBadge')
    expect(spaceSwitch).toContain('`${SPACE_MODE_LABELS[mode]}（${badgeCount} 件待处理）`')
    // 无徽章时名称就是基础文案，不额外拼计数。
    expect(spaceSwitch).toContain(': SPACE_MODE_LABELS[mode]')
  })

  it('徽章本身装饰化，避免计数被读屏读两遍、也避免名称与可见文字不一致', () => {
    expect(spaceSwitch).toContain('className="ah-space-switch-badge" aria-hidden="true"')
  })

  it('悬停提示保持基础标签，不把计数复制进 title', () => {
    expect(spaceSwitch).toContain('title={SPACE_MODE_LABELS[mode]}')
  })
})

describe('WCAG 2.5.3 唤醒链接：名称包含可见时间文字', () => {
  it('aria-label 以可见的打开时间开头，用途说明放在后面', () => {
    expect(taskRow).toContain(
      "aria-label={`${wake.openedText ?? '查不到记录'}（打开这次唤醒的账本：${title}）`}",
    )
  })

  it('可见文字与名称用同一个 openedText，查不到记录时两边同口径', () => {
    expect(taskRow).toContain("{wake.openedText ?? '查不到记录'}")
  })
})

describe('WCAG 2.5.3 回放滑块：动态时间读数不冒名字段标签', () => {
  it('外层是普通 div 而不是 label，两端时间不会变成滑块的可见标签', () => {
    expect(replayPage).toContain('<div className="ah-replay-range">')
    expect(replayPage).not.toContain('<label className="ah-replay-range"')
  })

  it('滑块名称与当前值分别由 aria-label / aria-valuetext 播报', () => {
    expect(replayPage).toContain('type="range" aria-label="当天回放时间"')
    expect(replayPage).toContain('aria-valuetext={clock(selectedAt ?? now, bounds.timezone)}')
  })
})

describe('WCAG 2.4.1 跳过区块', () => {
  it('插件页顶部有跳过链接，指向正文锚点', () => {
    expect(hubPage).toContain('className="ah-skip-link"')
    expect(hubPage).toContain('href="#ah-main"')
    expect(hubPage).toContain('跳到主内容')
  })

  it('激活时拦掉哈希跳转，直接把焦点编程移到正文容器', () => {
    expect(hubPage).toContain('event.preventDefault()')
    expect(hubPage).toContain("document.getElementById('ah-main')?.focus()")
  })

  it('正文容器用 tabIndex=-1 可被编程聚焦，但不进 Tab 环', () => {
    expect(hubPage).toContain('id="ah-main"')
    expect(hubPage).toContain('tabIndex={-1}')
  })

  it('插件不重复声明 main 地标，地标归宿主/预览壳承担', () => {
    expect(hubPage).not.toContain('role="main"')
  })

  it('样式默认离屏隐藏但保留在 Tab 序列，键盘聚焦时浮到左上角', () => {
    expect(css).toMatch(/\.ah-skip-link\s*\{[^}]*clip:\s*rect\(0,?\s*0,?\s*0,?\s*0\)/)
    expect(css).toContain('.ah-skip-link:focus-visible')
  })
})

describe('WCAG 2.4.3/4.1.2 项目页「归档 N」锚点：跳转后焦点落在目的地（U01 第 41 轮）', () => {
  it('归档计数是带动作的真按钮，名称含归档总数，可见文字与名称同物', () => {
    expect(projectPage).toContain('className="ah-prj-summary-link"')
    expect(projectPage).toContain('aria-label={`展开并定位到归档区，共 ${part.count} 个归档项目`}')
    expect(projectPage).toContain('title="展开归档区并滚动定位"')
  })

  it('仅当归档数大于 0 才渲染按钮，0 个时保持纯文本（不制造无动作的假链接）', () => {
    expect(projectPage).toContain("if (part.key === 'archived' && part.count > 0)")
  })

  it('目标折叠区同时有 id（可被定位）与 ref（编程展开/聚焦的唯一句柄）', () => {
    expect(projectPage).toContain('id="ah-prj-archived" ref={archivedRef}')
    expect(projectPage).toContain('useRef<HTMLDetailsElement | null>(null)')
  })

  it('看板模式先切回列表再定位，并在折叠区挂载后把焦点交给 summary', () => {
    expect(projectPage).toContain("if (mode !== 'list') setMode('list')")
    expect(projectPage).toContain('el.open = true')
    expect(projectPage).toContain("el.scrollIntoView({ block: 'start' })")
    expect(projectPage).toContain("el.querySelector('summary')")
  })

  it('行内锚点沿用 2.5.8 例外不套 24px 方块，但保留焦点环与点击手型', () => {
    expect(css).toContain('.ah-prj-summary-link {')
    expect(css).toMatch(/\.ah-prj-archived\s*\{[^}]*scroll-margin-top:\s*16px/)
  })
})

describe('WCAG 1.3.1 标题层级：每视图有 h2 且不跳级', () => {
  it('设置页有页面级 h2，当前分区用 h3（h2→h3 不跳级）', () => {
    expect(settingsPane).toContain('<header className="ah-pane-heading"><h2>设置</h2>')
    expect(settingsPane).toContain('<h3>{current.title}</h3>')
  })

  it('动态页补齐页面级 h2，与 section 的 aria-label 同名同物', () => {
    expect(activityPane).toContain('<header className="ah-pane-heading"><h2>动态</h2>')
  })

  it('资料嵌入设置页后，分区 h3 和卡名 h4 逐级不跳', () => {
    // 资料嵌在设置页：设置 h2 → 资料 h3 → 卡名 h4，逐级不跳。
    expect(resourcePage).toContain('<h3>资料</h3>')
    expect(resourcePage).toContain('<h4>{r.name} <Tags row={row} /></h4>')
    expect(css).toContain('.ah-res-card-main h4 {')
    expect(css).not.toContain('.ah-res-card-main h3')
  })
})

describe('WCAG 1.3.1 装饰标题转正：账本段与轨迹面板用真标题元素', () => {
  it('唤醒账本八个分区标题全部是 h3，不再用 p 冒充', () => {
    expect(wakeLedger).not.toContain('<p className="ah-ledger-title">')
    const titles = ['为什么醒', '手里的证据', '工具调用（中心观察到的）', '其它动作', '结果引用', '交了什么', '中心实查与主人验收', '执行者报告的变更']
    for (const title of titles) {
      expect(wakeLedger).toContain(`<h3 className="ah-ledger-title">${title}</h3>`)
    }
    // h3 的 UA 样式必须归零，视觉与改前的 p 完全一致。
    expect(css).toContain('.ah-ledger p, .ah-ledger h3 { margin: 0; font-size: 12px; }')
    expect(css).toMatch(/\.ah-ledger-title\s*\{[^}]*font-weight:\s*inherit/)
  })

  it('轨迹面板标题从 div 转正为 h3，并让所在 header 自动获名', () => {
    expect(trailPanel).toContain('<h3 className="ah-trail-title">')
    expect(trailPanel).not.toContain('<div className="ah-trail-title">')
    expect(workspaceCss).toMatch(/\.ah-trail-title\s*\{[^}]*margin:\s*0[^}]*font-weight:\s*inherit/)
  })
})

describe('WCAG 1.3.1 地标：功能区显式命名，纯布局槽不得冒充 header', () => {
  it('线程输入区 footer 带可访问名', () => {
    expect(threadPane).toContain('<footer className="ah-thread-input" aria-label="消息输入区">')
  })

  it('办公室引导 aside 与门口总信箱 footer 都带可访问名', () => {
    expect(officePage).toContain('<aside className="ah-office-pixel-guide" aria-label="像素办公室引导">')
    expect(officePage).toContain('<footer className="ah-office-foot" aria-label="房间门口总信箱">')
  })

  it('收件箱卡片内不再出现裸 header，元信息行改回普通 div', () => {
    // 裸 <header>（无 className）在 map 里会按卡片数制造未命名地标。
    expect(inboxPane).not.toMatch(/<header>/)
    expect(inboxPane).toContain('<div className="ah-inbox-row-head">')
    expect(css).toContain('.ah-inbox-row .ah-inbox-row-head {')
    expect(css).not.toContain('.ah-inbox-row header')
  })

  it('共享上下文面板头改回 div，命名由外层 section 的 aria-label 承担', () => {
    expect(contextPanel).toContain('<div className="ah-context-head">')
    expect(contextPanel).not.toContain('<header className="ah-context-head">')
  })
})

describe('WCAG 3.2.1 聚焦本身不制造上下文变化', () => {
  it('全客户端 onFocus 只有引用框「聚焦即选中文本」一处，且不含导航/发命令记号', () => {
    const focus = collectHandlers('Focus')
    expect(focus).toHaveLength(1)
    // 上一行已锁定长度为 1，可选链只是给严格模式一个交代。
    expect(focus[0]?.file).toBe('components/artifact-section.tsx')
    expect(focus[0]?.body).toMatch(/\.select\(\)/)
    expect(focus[0]?.body).not.toMatch(INPUT_DANGER_RE)
    // 同一段便利逻辑确实在引用框组件里，防止文件路径被改后锁错对象。
    expect(artifactSection).toContain('e.currentTarget.select()')
  })

  it('全客户端没有任何 onBlur 处理器（失焦自动提交/跳转一律禁止）', () => {
    expect(collectHandlers('Blur')).toEqual([])
  })
})

describe('WCAG 3.2.2 改值不自动提交：写操作只能走显式按钮', () => {
  it('onChange/onInput 处理器表达式里不出现导航、开弹层、直接发命令记号', () => {
    const bad = [...collectHandlers('Change'), ...collectHandlers('Input')]
      .filter(h => INPUT_DANGER_RE.test(h.body))
    expect(bad).toEqual([])
  })
})

describe('WCAG 4.1.2 「更多」菜单：收起态 aria-controls 仍可解析', () => {
  it('触发器声明 aria-controls，面板以同 id 常驻挂载、用原生 hidden 收展', () => {
    expect(threadPane).toContain('aria-controls="ah-thread-more"')
    expect(threadPane).toMatch(
      /<div className="ah-thread-menu" id="ah-thread-more"[^>]*hidden=\{!menuOpen\}/,
    )
    // 旧实现是展开才挂载（收起态引用悬空），这条锁防止重构退回条件渲染。
    expect(threadPane).not.toMatch(/\{menuOpen \? \(\s*\n\s*<div className="ah-thread-menu"/)
  })

  it('CSS 显式把 [hidden] 压回 display:none（.ah-thread-menu 的 display:grid 会盖过 UA 默认值）', () => {
    expect(css).toContain('.ah-thread-menu[hidden] { display: none; }')
  })

  it('命令面板的 combobox 与 listbox 同对话框共生死，aria-controls 不会悬空', () => {
    expect(commandPalette).toContain('aria-controls="ah-cmdk-list"')
    expect(commandPalette).toContain('id="ah-cmdk-list"')
  })
})

// ---------- 第 39 轮：对话框表面形状 ----------
// 与 .tmp/u12/audit-r39.mjs 的静态段同口径：抓 role="dialog" 开标签（属性跨行时
// 兜底到第一个 >），注释里的文字示例因为没有「<标签名」前缀不会被误抓。
const DIALOG_TAG_RE = /<[a-zA-Z]+[^>]*role="dialog"[^>]*>/g
interface DialogTagHit { file: string; tag: string }
const collectDialogTags = (): DialogTagHit[] => {
  const hits: DialogTagHit[] = []
  for (const file of walkSource(clientDir)) {
    const text = readFileSync(file, 'utf8')
    DIALOG_TAG_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = DIALOG_TAG_RE.exec(text))) {
      let tag = m[0]
      if (!tag.endsWith('/>') && !tag.includes('>')) {
        tag = text.slice(m.index, text.indexOf('>', m.index) + 1)
      }
      hits.push({
        file: file.replace(/\\/g, '/').replace(clientDir.replace(/\\/g, '/'), ''),
        tag: tag.replace(/\s+/g, ' '),
      })
    }
  }
  return hits
}

/** 取一个弹窗组件文件内全部标题层级（去重升序）；空数组表示该表面刻意不设标题。 */
const headingLevels = (text: string): number[] => {
  const levels = new Set<number>()
  for (const m of text.matchAll(/<h([1-6])\b/g)) levels.add(Number(m[1]))
  return [...levels].sort((a, b) => a - b)
}

describe('WCAG 4.1.2 对话框：模态声明与显式命名一个都不能少', () => {
  const tags = collectDialogTags()

  it('全客户端恰有七个真实弹窗挂载点（新增弹窗需在本契约登记）', () => {
    expect(tags.map(t => t.file).sort()).toEqual([
      'components/NewBotWizard.tsx',
      'components/TeachDialog.tsx',
      'components/bot-archive-dialog.tsx',
      'components/command-palette.tsx',
      'components/confirm-dialog.tsx',
      'components/prj-dialog-shell.tsx',
      'components/resource-dialogs.tsx',
    ])
  })

  it('每个 role="dialog" 开标签都带 aria-modal="true" 与非空显式 aria-label', () => {
    const bad = tags.filter(t =>
      !/aria-modal="true"/.test(t.tag) || !/aria-label=(?:"[^"]+"|\{[^}]+\})/.test(t.tag))
    expect(bad).toEqual([])
  })
})

describe('WCAG 1.3.1 弹窗是独立表面：标题从 h2 起且不跳级', () => {
  const dialogSources: Array<{ name: string; text: string }> = [
    { name: 'NewBotWizard.tsx', text: newBotWizard },
    { name: 'TeachDialog.tsx', text: teachDialog },
    { name: 'confirm-dialog.tsx', text: confirmDialog },
    { name: 'prj-dialog-shell.tsx', text: prjDialogShell },
    { name: 'resource-dialogs.tsx', text: resourceDialogs },
    // P48：拦截态 BlockedDialog 自带 h2 表面，同样受「标题从 h2 起且不跳级」约束。
    { name: 'bot-archive-dialog.tsx', text: botArchiveDialog },
    { name: 'command-palette.tsx', text: commandPalette },
  ]

  it('六个带标题弹窗：恰一个标题且为 h2；命令面板刻意无标题（搜索优先，名称靠 aria-label）', () => {
    for (const src of dialogSources) {
      const levels = headingLevels(src.text)
      if (src.name === 'command-palette.tsx') {
        expect(levels, src.name).toEqual([])
      } else {
        expect(levels, src.name).toEqual([2])
      }
    }
  })

  it('向导与教学弹窗的 h2 包在 ah-wizard-head 里，不允许退回 h3', () => {
    expect(newBotWizard).toContain('<header className="ah-wizard-head">')
    expect(newBotWizard).toContain('<h2>新建队友（第 {draft.step + 1}/6 步：{STEP_TITLES[draft.step]}）</h2>')
    expect(newBotWizard).not.toContain('<h3>')
    expect(teachDialog).toContain('<header className="ah-wizard-head">')
    expect(teachDialog).toContain('<h2>教 {props.botName} 技能</h2>')
    expect(teachDialog).not.toContain('<h3>')
  })

  it('三个 DialogShell 系列弹窗：h2 直接渲染 props.title，名称与可见标题同源', () => {
    for (const text of [confirmDialog, prjDialogShell, resourceDialogs]) {
      expect(text).toContain('aria-label={props.title}')
      expect(text).toContain('<h2>{props.title}</h2>')
      expect(text).not.toContain('<h3>')
    }
  })

  it('ah-wizard-head 的样式选择器已随标题改到 h2，不得残留 h3 规则', () => {
    expect(css).toContain('.ah-wizard-head h2 { margin: 0; }')
    expect(css).not.toContain('.ah-wizard-head h3')
    expect(workspaceCss).toContain('.ah-wizard-head h2 { font-size: 17px; }')
    expect(workspaceCss).not.toContain('.ah-wizard-head h3')
  })
})

// ---------- U10：P44 新左栏三组导航（键盘 / 命名 / 点击区 / 焦点环） ----------
/** 取某个选择器的声明块（这些规则都无嵌套，直接配到第一个右花括号）。 */
const declBlock = (source: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  return match?.[1] ?? ''
}

describe('U10 新左栏：DOM 顺序就是 Tab 顺序，三组与母子行结构固定', () => {
  it('三组按办公室 → 队友 → 工作区顺序出现', () => {
    // 第 45 轮拆分后三个分组注释仍留在主组件的挂载点上，顺序由组合根保证。
    const iOffice = teamSidebarNavMain.indexOf('第一组：办公室')
    const iTeammates = teamSidebarNavMain.indexOf('第二组：队友')
    const iWorkspaces = teamSidebarNavMain.indexOf('第三组：工作区')
    expect(iOffice).toBeGreaterThanOrEqual(0)
    expect(iTeammates).toBeGreaterThan(iOffice)
    expect(iWorkspaces).toBeGreaterThan(iTeammates)
  })

  it('项目母行内顺序固定：展开箭头 → 项目名 → 行内加号；子会话在母行之后', () => {
    const rowStart = teamSidebarNav.indexOf('ah-nav-project-row')
    const rowEnd = teamSidebarNav.indexOf('ah-nav-sessions', rowStart)
    const row = teamSidebarNav.slice(rowStart, rowEnd)
    expect(row.indexOf('ah-nav-disclosure')).toBeGreaterThanOrEqual(0)
    expect(row.indexOf('ah-nav-project-name')).toBeGreaterThan(row.indexOf('ah-nav-disclosure'))
    expect(row.indexOf('ah-nav-row-add')).toBeGreaterThan(row.indexOf('ah-nav-project-name'))
    // 会话按钮渲染在母行之外的 sessions 容器里，Tab 时天然排在母行三个控件之后。
    expect(teamSidebarNav.indexOf('className={`ah-nav-session', rowEnd)).toBeGreaterThan(rowEnd)
  })

  it('三个组开关与项目箭头都带 aria-expanded，导航整体有可访问名', () => {
    const toggleCount = (teamSidebarNav.match(/className="ah-nav-group-toggle"/g) ?? []).length
    expect(toggleCount).toBe(3)
    expect(teamSidebarNav.match(/aria-expanded=\{/g)?.length).toBeGreaterThanOrEqual(4)
    expect(teamSidebarNav).toContain('<nav className="ah-botlist ah-sidebar-nav" aria-label="团队空间导航">')
    expect(teamSidebarNav).toContain('aria-label="团队空间导航（图标）"')
  })
})

describe('U10 新左栏：每个可点项有中文可读名，点击区 ≥24×24，焦点环不漏', () => {
  const buttonBlocks = (): string[] => teamSidebarNav.match(/<button\b[\s\S]*?<\/button>/g) ?? []

  it('每个 button 要么带 aria-label，要么含可见中文文本或中文数据绑定（纯图标加号也必须命名）', () => {
    const blocks = buttonBlocks()
    expect(blocks.length).toBeGreaterThan(15)
    for (const block of blocks) {
      // 第三种证据：可见文本来自 {xxx.name} 这类数据绑定（项目名/队友名运行时为中文）。
      const named = /aria-label=/.test(block)
        || /[\u4e00-\u9fff]/.test(block)
        || />\s*\{[^}]*\bname\b[^}]*\}\s*</.test(block)
      expect(named, block.slice(0, 120)).toBe(true)
    }
  })

  it('关键控件的中文名称逐一在册（办公室/新建队友/新建会话/待你处理/展开项目）', () => {
    expect(teamSidebarNav).toContain('aria-label="办公室"')
    expect(teamSidebarNav).toContain('aria-label="新建队友"')
    expect(teamSidebarNav).toContain('aria-label="待你处理"')
    expect(teamSidebarNav).toContain('aria-label="搜索队友"')
    expect(teamSidebarNav).toContain('aria-label={`给${bot.name}新建会话`}')
    expect(teamSidebarNav).toContain('aria-label={`在${project.name}新建会话`}')
    expect(teamSidebarNav).toContain('aria-label={project.expanded ? `收起${project.name}` : `展开${project.name}`}')
    expect(teamSidebarNav).toContain('aria-label={`项目：${project.name}`}')
  })

  it('展开态所有可点控件的 CSS 点击区不小于 24×24', () => {
    const cases: Array<[string, string, string]> = [
      ['.ah-nav-group-toggle', 'min-height', '28px'],
      ['.ah-nav-item', 'min-height', '30px'],
      ['.ah-botlist-add', 'width', '24px'],
      ['.ah-nav-row-add', 'width', '24px'],
      ['.ah-nav-disclosure', 'width', '24px'],
      ['.ah-nav-project-name', 'min-height', '28px'],
      ['.ah-nav-session', 'min-height', '26px'],
    ]
    for (const [selector, prop, value] of cases) {
      const block = declBlock(workspaceCss, selector)
      expect(block, `${selector} 缺少声明块`).not.toBe('')
      expect(block, `${selector} ${prop} 小于 ${value}`).toContain(`${prop}: ${value}`)
    }
    // 正方形控件两维都锁。
    for (const selector of ['.ah-botlist-add', '.ah-nav-row-add', '.ah-nav-disclosure']) {
      const block = declBlock(workspaceCss, selector)
      expect(block).toContain('width: 24px')
      expect(block).toContain('height: 24px')
    }
  })

  it('收起态图标按钮为 32×32，且不渲染搜索框与表单', () => {
    const block = declBlock(workspaceCss, '.ah-rail-btn')
    expect(block).toContain('width: 32px')
    expect(block).toContain('height: 32px')
    // 第 45 轮起收起态独立成 sidebar-nav-rail.tsx：直接对该文件断言，
    // 图标列里不允许混入展开态才有的搜索框与表单。
    expect(teamSidebarRail).toContain('aria-label="团队空间导航（图标）"')
    expect(teamSidebarRail).not.toContain('ah-bot-search')
    expect(teamSidebarRail).not.toContain('ah-nav-form')
  })

  it('焦点环经挂载容器的 .ah-host-botlist 全局规则覆盖全部新控件', () => {
    expect(hostMount).toContain("node.className = 'ah-host-botlist ah-team-sidebar'")
    expect(workspaceCss).toMatch(/\.ah-host-botlist\)\s*:is\(button[^)]*\):focus-visible/)
    expect(workspaceCss).toContain('outline: 2px solid var(--dsw-alias-accent)')
  })

  it('待验收状态点不得回退成裸 warning 色（U10 修过的 2.9:1 对比度缺陷）', () => {
    const block = declBlock(workspaceCss, '.ah-nav-dot-check')
    expect(block).toContain('color-mix(')
    expect(block).not.toContain('background: var(--dsw-alias-warning, var(--dsw-alias-accent));')
  })
})
