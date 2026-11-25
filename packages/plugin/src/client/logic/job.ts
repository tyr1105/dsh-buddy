/**
 * 「一件事」界面的纯规则（P74h）：进度行、工作往来折叠组、证据清单、交回卡与核对卡、
 * 约定卡两栏（B2）需要的文字拼法与样式类名，全部写成纯函数，组件只管画。
 *
 * 为什么单独成文件：这些规则要逐条单测（四步与五步、stuck 样式、delayNote 括号、
 * 「谁 → 谁」的拼法、证据图标的文字缩写），并让组件、测试和文案登记表引用同一份文字
 * （JOB_TEXT，登记在 docs/copy/strings.json，编号前缀 JOB-），不会各写一套慢慢走样。
 * 给主人看的文字用「员工」和「你」，不出现工具名、id、内部编号；图标用文字缩写，不用 emoji。
 *
 * 截图缩略图的读取：命令 readJobEvidence 由宿主接到中心（P74g）；这里只管界面这一侧的
 * 「进入视口才请求、同一次页面只请求一次」：请求按「交回 id + 证据 id」缓存在组件外的
 * 内存里（缓存 Promise，并发的两个缩略图也只发一次请求）。
 */
import type { CommandResult } from '../../shared/views.js'
import type { JobProgressView, TopicFloorsView } from '@agent-hub/core'

// ---------------------------------------------------------------------------
// 一、界面文字
// ---------------------------------------------------------------------------

/** 本卡新增的界面文字。动态部分用函数拼，文案登记表里对应的写法是 {} 占位。 */
export const JOB_TEXT = {
  // 进度行（约定面板底部）
  progressLabel: '进度',
  now: '现在',
  waiting: '在等',
  due: '交付',
  // P76j：进度行第三行「消耗」（文字由 core 拼好）与展开后的逐回合明细。
  costExpand: '展开每个回合',
  costCollapse: '收起每个回合',
  // 工作往来折叠组
  workFold: '工作往来',
  foldExpand: '展开',
  foldOpen: '已展开，点击收起',
  latest: '最近',
  // 证据清单
  fixTitle: '改到什么程度算过',
  fileTag: '文件',
  imageTag: '截图',
  testTag: '测试',
  linkTag: '链接',
  // 约定卡两栏（B2）
  splitContinuing: '不受影响，照常在做',
  splitPaused: '暂停，等你确认',
  // 截图缩略图与大图
  shotLoading: '读取中…',
  shotOpen: '点开大图',
  shotDialogLabel: '证据大图',
  shotClose: '关闭',
  // W12：文件证据交给电脑打开
  fileOpen: '用默认应用打开',
  fileOpening: '正在打开…',
  fileReveal: '在访达中显示',
  fileRevealOther: '在文件夹中显示',
  // 私聊里兜底的 job_card 占位（交付卡等 P74i 再画）
  jobCardPending: '这件事的卡片',
  // 交付卡（P74i）
  deliveryAccept: '验收通过',
  deliveryAccepting: '正在记下…',
  deliveryPreview: '在你的电脑上打开预览',
  deliveryOpened: '已打开',
  deliveryExpand: '展开证据',
  deliveryCollapse: '收起证据',
  // 三轮不过卡（P74i）
  // P74i-m3（第 7 节）：两个小标题改为书面表达（原「卡在哪」「试过什么」）。
  escalationStuck: '受阻原因',
  escalationTried: '已尝试的办法',
  escalationSubmit: '按所选办法处理',
  escalationSuggested: '建议',
  // P74i-m1（第二次）：主人已选的办法上的小标签（走查 E-5）。
  escalationChosen: '已选',
  // P74i-m1（第二次，任务卡 1.4）：发布审批的两个按钮与中心作废的审批状态。
  approvalLaunchApprove: '批准发布',
  approvalLaunchDecline: '暂不发布',
  approvalVoided: '已作废',
  // P74i-m2（第四次审查高-1）：楼层与折叠组里还有没加载的更早记录时的提示（{} 为条数）。
  floorsEarlierNote: '更早的 {} 条记录还没有加载。',
  foldEarlierNote: '这一组里更早的 {} 条还没有加载。',
  // P74i-m3（第 5 节）：有更早的记录没加载时，汇总一句只数已加载的（{} 依次为总数、给你的、往来）。
  loadedCountPlain: '已加载 {} 条记录',
  loadedCountSplit: '已加载 {} 条记录：给你的 {} 条，员工之间的往来 {} 条（已收起）',
} as const

// ---------------------------------------------------------------------------
// 零点五、交付卡与三轮不过卡的小规则（P74i）
// ---------------------------------------------------------------------------

/** 交付卡的结构化状态（核心 P74r8 给出）：待你验收、等约定确认、已完成、未通过、已失效。 */
export type DeliveryPhase = 'awaiting' | 'waiting_agreement' | 'accepted' | 'returned' | 'void'

/**
 * 交付卡右侧状态的样式类：已完成成功色、未通过警示色、已失效灰，其余普通色。
 * 只看 phase（核心给的结构化状态），不按状态文字开头猜：核心以后换了状态文字，着色也不会错。
 */
export function deliveryStateClass(phase: DeliveryPhase): string {
  if (phase === 'accepted') return 'is-ok'
  if (phase === 'returned') return 'is-bad'
  if (phase === 'void') return 'is-na'
  return ''
}

/** 这张交付卡是不是只读（phase 为已失效：约定已更新、已重新交付、这件事已停止）。失效的卡没有任何按钮。 */
export function deliveryIsExpired(phase: DeliveryPhase): boolean {
  return phase === 'void'
}

/** 三轮不过卡初始选中的办法：建议项的序号；没有建议项（不会发生）退回第 0 个。 */
export function initialEscalationChoice(options: ReadonlyArray<{ suggested: boolean }>): number {
  const found = options.findIndex(option => option.suggested)
  return found === -1 ? 0 : found
}

// ---------------------------------------------------------------------------
// 二、进度行
// ---------------------------------------------------------------------------

/** 步骤的样式类：done 实线、current 主色加粗、stuck 警示色、todo 浅色。不靠颜色单独表达：每步有文字。 */
export function stepClass(state: JobProgressView['steps'][number]['state']): string {
  switch (state) {
    case 'done': return 'is-done'
    case 'current': return 'is-current'
    case 'stuck': return 'is-stuck'
    case 'todo': return 'is-todo'
  }
}

/**
 * 状态小标签的样式类：run 主色（进行中）、you 警示色（等你处理）、ok 成功色（已收尾）。
 * P74i-m1（走查 S-3）：标签要有底色和边线，四种样子在深浅外观下都可分辨；核心后续若把
 * 「受阻」从「等你处理」里单列一个 tone，落到 is-blocked（警示底色加边线），不认识的值也归到它。
 * 标签里有文字，不靠颜色单独表达。
 */
export function toneClass(tone: JobProgressView['stateTone'] | 'blocked'): string {
  switch (tone) {
    case 'run': return 'is-run'
    case 'you': return 'is-you'
    case 'ok': return 'is-ok'
    default: return 'is-blocked'
  }
}

/** 「在等：{谁}」那一段；有延迟说明时用括号接在后面（「在等：林舟（排队中）」）。没有在等的人返回 null。 */
export function waitingText(progress: Pick<JobProgressView, 'waitingOn' | 'delayNote'>): string | null {
  if (progress.waitingOn === null) return null
  return `${JOB_TEXT.waiting}：${progress.waitingOn}${progress.delayNote === null ? '' : `（${progress.delayNote}）`}`
}

// ---------------------------------------------------------------------------
// 三、工作往来折叠组
// ---------------------------------------------------------------------------

/** 折叠组的类型：core 视图里 kind 为 fold 的那一项。 */
export type FoldItem = Extract<TopicFloorsView['items'][number], { kind: 'fold' }>

/**
 * P74i-m2（第四次审查高-1）：楼层与「已加载的消息」的对位。
 * 线程只带最新一页消息，楼层按主题的全部消息算：从前往后找到第一条「已加载」的楼层项
 * （楼层项的消息有视图，或折叠组里至少一条有视图），它之前的就是还没加载的更早记录——
 * 界面不画它们，只写一行「更早的 n 条记录还没有加载。」，n 是这段里的消息条数
 * （楼层项算 1 条，折叠组按组里的条数算）。
 */
export function floorEarlierCount(
  items: ReadonlyArray<TopicFloorsView['items'][number]>,
  isLoaded: (messageId: string) => boolean,
): number {
  let count = 0
  for (const item of items) {
    const loaded = item.kind === 'fold'
      ? item.messages.some(entry => isLoaded(entry.message.id))
      : isLoaded(item.message.id)
    if (loaded) return count
    count += item.kind === 'fold' ? item.count : 1
  }
  return 0
}

/**
 * P74i-m3（第 5 节）：楼层汇总一句。
 * 全部记录都已加载时照旧显示核心给的 countText（「共 n 条记录：……」）；
 * 确实有更早的记录还没有加载时，「共 n 条记录」会让人以为 n 就是全部，所以界面按已加载的消息自己数，
 * 改写成「已加载 n 条记录：……」，n 与下面两项都只数已加载的（与屏幕上看得到的条目一致）。
 */
export function floorsCountText(
  floors: TopicFloorsView,
  isLoaded: (messageId: string) => boolean,
): string {
  if (floorEarlierCount(floors.items, isLoaded) === 0) return floors.countText
  let loaded = 0
  let work = 0
  for (const item of floors.items) {
    if (item.kind === 'fold') {
      const inFold = item.messages.filter(entry => isLoaded(entry.message.id)).length
      loaded += inFold
      work += inFold
    } else if (isLoaded(item.message.id)) {
      loaded += 1
    }
  }
  return work === 0
    ? JOB_TEXT.loadedCountPlain.replace('{}', String(loaded))
    : JOB_TEXT.loadedCountSplit.replace('{}', String(loaded)).replace('{}', String(loaded - work)).replace('{}', String(work))
}

/** 收起时第一行的中段：「{参与者用顿号连接}　{条数} 条　{日期范围}」。 */
export function foldSummary(fold: FoldItem): string {
  return `${fold.participants.join('、')}　${fold.count} 条　${fold.rangeText}`
}

/** 收起时第二行：「最近：{最近一句}」。 */
export function foldLatestText(fold: FoldItem): string {
  return `${JOB_TEXT.latest}：${fold.latest}`
}

/** 展开后每条的行头：「{发出者} → {接收者用顿号连接}」；没有接收者时只写发出者。 */
export function workHead(fromName: string, toNames: readonly string[]): string {
  return toNames.length === 0 ? fromName : `${fromName} → ${toNames.join('、')}`
}

/** 时间的显示（本机时区）：「M月D日 HH:mm」，与中心落在消息上的写法同一形状。 */
export function workTimeText(createdAt: number): string {
  const date = new Date(createdAt)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * P74i-m2（第四次审查低-2）：折叠组里每行的时间优先用消息视图里核心按中心时区算好的 timeText；
 * 找不到视图（旧数据、还没加载）时才退回本机时区的算法（workTimeText），两者不同时同一页的时间才对得上。
 */
export function workTimeOf(view: { timeText: string } | undefined, createdAt: number): string {
  return view !== undefined && view.timeText !== '' ? view.timeText : workTimeText(createdAt)
}

// ---------------------------------------------------------------------------
// 四、证据清单
// ---------------------------------------------------------------------------

/** 证据的类型（与 core 的 EvidenceView 同形状里用到的字段）。 */
export interface EvidenceLike {
  id: string
  kind: 'file' | 'image' | 'test' | 'link'
  label: string
  path: string | null
  url: string | null
  summary: string
  checkText: string | null
}

/** 证据的图标缩写：用文字，不用 emoji。 */
export function evidenceTag(kind: EvidenceLike['kind']): string {
  switch (kind) {
    case 'file': return JOB_TEXT.fileTag
    case 'image': return JOB_TEXT.imageTag
    case 'test': return JOB_TEXT.testTag
    case 'link': return JOB_TEXT.linkTag
  }
}

/** 结论小章的样式类：ok 成功色、bad 警示色、na 灰。章里有文字，不靠颜色单独表达。 */
export function verdictClass(tone: 'ok' | 'bad' | 'na'): string {
  return tone === 'ok' ? 'is-ok' : tone === 'bad' ? 'is-bad' : 'is-na'
}

// ---------------------------------------------------------------------------
// 五、截图缩略图：进入视口才请求、只请求一次
// ---------------------------------------------------------------------------

/** 一次读取的结果：成功拿图，或一句中文错误。 */
export type ShotEntry = { state: 'ok'; dataUrl: string } | { state: 'error'; error: string }

/** 读取函数的形状：与 client/api.ts 的 readJobEvidence 一致，测试里注入假实现。 */
export type ShotReader = (input: { jobId: string; submissionId: string; evidenceId: string }) =>
  Promise<CommandResult<{ dataUrl: string }>>

/**
 * 组件外的内存缓存：键是「交回 id:证据 id」（证据编号只在一次交回里唯一）。
 * 缓存 Promise 而不是结果：同一张图并发出现在两处时也只请求一次；失败不缓存
 * （Promise 落定后从表里清掉，重试还有机会）。
 */
const shotCache = new Map<string, Promise<ShotEntry>>()

/** 读一次截图：命中缓存直接返回同一个 Promise，同一张图在同一次页面里只请求一次。 */
export function loadShot(
  read: ShotReader,
  input: { jobId: string; submissionId: string; evidenceId: string },
): Promise<ShotEntry> {
  const key = `${input.submissionId}:${input.evidenceId}`
  const hit = shotCache.get(key)
  if (hit !== undefined) return hit
  const promise = read(input).then((result): ShotEntry =>
    result.ok && typeof result.data?.dataUrl === 'string' && result.data.dataUrl !== ''
      ? { state: 'ok', dataUrl: result.data.dataUrl }
      : { state: 'error', error: result.ok ? '没有读到截图。' : result.error },
  ).catch((error: unknown): ShotEntry => ({ state: 'error', error: error instanceof Error ? error.message : String(error) }))
  // 成功的读取留在缓存里（同一张图在同一次页面里不再请求）；失败的清掉，重试还有机会。
  void promise.then(entry => { if (entry.state === 'error') void shotCache.delete(key) }, () => { void shotCache.delete(key) })
  shotCache.set(key, promise)
  return promise
}

/** 清空截图缓存（只在测试里用）。 */
export function clearShotCache(): void {
  shotCache.clear()
}

// ---------------------------------------------------------------------------
// 六、焦点归还
// ---------------------------------------------------------------------------

/**
 * 把焦点还给某个元素（大图关闭后回到缩略图）。
 * 抽成函数是为了能单测：元素没有 focus 方法（测试替身）时安静跳过，不抛错。
 */
export function returnFocus(el: { focus?: () => void } | null): void {
  try {
    if (el !== null && typeof el.focus === 'function') el.focus()
  } catch { /* 还焦失败不影响界面 */ }
}

/**
 * P74i-m1（走查 D-11）：把 Tab 的焦点圈在一组元素里（弹窗内的焦点圈）。
 * shift 是不是 Shift+Tab；active 是此刻持有焦点的元素。焦点在最后一个上按 Tab 回到第一个、
 * 在第一个上按 Shift+Tab 回到最后一个；焦点不在圈里（刚打开弹窗）回到第一个。
 * 返回是否拦下了这次 Tab（调用方据此 preventDefault）；圈里没有可聚焦元素时返回假，不拦。
 * 抽成纯函数是为了单测焦点循环；元素没有 focus 方法（测试替身）时安静跳过。
 */
export function trapTabIn(focusables: ReadonlyArray<{ focus?: () => void } | null>, active: unknown, shift: boolean): boolean {
  const ordered = focusables.filter((el): el is { focus?: () => void } => el !== null && typeof el.focus === 'function')
  if (ordered.length === 0) return false
  const index = ordered.findIndex(el => el === active)
  const next = shift
    ? (index <= 0 ? ordered.length - 1 : index - 1)
    : (index === -1 || index === ordered.length - 1 ? 0 : index + 1)
  try { ordered[next]!.focus?.() } catch { /* 聚焦失败不影响显示 */ }
  return true
}
