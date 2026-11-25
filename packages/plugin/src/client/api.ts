/**
 * 宿主接口封装：fetch('api/agent-hub/…')，文档相对路径、同源 cookie，不加任何鉴权头
 * （鉴权由宿主 Connection 的 Cookie 完成；桌面版由主进程转发并补 cookie，verified-T5 Q3-1）。
 * 所有请求失败都抛带一句中文原因的 Error，界面只管显示与「重试」。
 */
import type {
  ActivityView, ActiveJobsView, BotView, CommandResult, InboxView, MemoryPageView, OfficeView, OverviewView, ProjectView, ResourceView, SettingsView,
  SkillDetailView, SkillLibraryView, ThreadView, WakeLedgerRow, WakeLedgerView, WeeklyUsageView,
} from '../shared/views.js'

const BASE = 'api/agent-hub'

async function getJson<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE}/${path}`, { credentials: 'same-origin' })
  } catch {
    throw new Error('连接中断。点击重试；仍失败请确认 DSH 是否已关闭。')
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）。点击重试。`
    try {
      const body = await response.json() as { error?: string }
      if (body?.error) message = body.error
    } catch { /* 保持默认文案 */ }
    throw new Error(message)
  }
  return await response.json() as T
}

/** POST command：JSON { name, input } → CommandResult。带返回数据的命令用泛型注明 data 的形状。 */
async function postCommand<T = unknown>(name: string, input: Record<string, unknown>): Promise<CommandResult<T>> {
  let response: Response
  try {
    response = await fetch(`${BASE}/command`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name, input }),
    })
  } catch {
    return { ok: false, error: '连接中断。点击重试；仍失败请确认 DSH 是否已关闭。' }
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）。点击重试。`
    try {
      const body = await response.json() as { error?: string }
      if (body?.error) message = body.error
    } catch { /* 保持默认文案 */ }
    return { ok: false, error: message }
  }
  return await response.json() as CommandResult<T>
}

export const api = {
  overview: (): Promise<OverviewView> => getJson('overview'),
  bot: (id: string): Promise<BotView> => getJson(`bot?id=${encodeURIComponent(id)}`),
  thread: (id: string, opts?: { before?: string; limit?: number }): Promise<ThreadView> => {
    const params = new URLSearchParams({ id })
    if (opts?.before) params.set('before', opts.before)
    if (opts?.limit) params.set('limit', String(opts.limit))
    return getJson(`thread?${params.toString()}`)
  },
  inbox: (): Promise<InboxView> => getJson('inbox'),
  activity: (opts?: { before?: string; limit?: number }): Promise<ActivityView> => {
    const params = new URLSearchParams()
    if (opts?.before) params.set('before', opts.before)
    if (opts?.limit) params.set('limit', String(opts.limit))
    const qs = params.toString()
    return getJson(qs ? `activity?${qs}` : 'activity')
  },
  settings: (): Promise<SettingsView> => getJson('settings'),
  /** P76k：设置页「最近 7 天的用量」表（只读；旧宿主没有这条路由时请求失败，界面不显示这块）。 */
  weeklyUsage: (): Promise<WeeklyUsageView> => getJson('weekly-usage'),
  /** 办公室纯投影（F03）：座位、灯、桌上产出、门口信箱与房间健康。 */
  office: (): Promise<OfficeView> => getJson('office'),
  /** 资料授权矩阵（V2-PH2-04）：资料列表、授权展开行与计数。 */
  resource: (): Promise<ResourceView> => getJson('resource'),
  /** 项目容器（V2-PH4-02）：项目分区、任务展开与问题计数；写操作统一走 command。 */
  project: (): Promise<ProjectView> => getJson('project'),
  /** 某机器人的最近账本摘要（按需加载，不参与全局轮询）。 */
  wakeLedger: (botId: string, opts?: { limit?: number; before?: number }): Promise<WakeLedgerRow[]> => {
    const params = new URLSearchParams({ botId })
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.before !== undefined) params.set('before', String(opts.before))
    return getJson(`wake-ledger?${params.toString()}`)
  },
  /** 一次唤醒的完整账本；没有记录时返回 null。 */
  wakeLedgerDetail: (wakeId: string): Promise<WakeLedgerView | null> =>
    getJson(`wake-ledger-detail?wakeId=${encodeURIComponent(wakeId)}`),
  /**
   * P74h：读一张证据截图（dataUrl），供缩略图与大图显示。命令由宿主接到中心（P74g），
   * 只读主题文件夹内的图片；这里只发命令并原样返回结果，缓存与进入视口的判断在 logic/job.ts。
   */
  readJobEvidence: (input: { jobId: string; submissionId: string; evidenceId: string }): Promise<CommandResult<{ dataUrl: string }>> =>
    postCommand('readJobEvidence', { ...input }),
  /**
   * W12：卡片上的文件证据交给电脑打开（action 为 open）或在访达中显示（reveal）。位置由中心查过后给出，
   * 宿主优先用 DSH 自带的打开能力；失败时结果里带 path，界面显示出来方便复制。
   */
  /** W12：在 DSH 自带的文件预览里看之前，取检查过的文件路径和交付员工的会话（宿主不打开任何东西）。 */
  locateJobEvidence: (input: { jobId: string; submissionId: string; evidenceId: string }): Promise<CommandResult<{ path: string; sessionId?: string | null }>> =>
    postCommand('locateJobEvidence', { ...input }),
  openJobEvidence: (input: { jobId: string; submissionId: string; evidenceId: string; action: 'open' | 'reveal' }): Promise<CommandResult & { path?: string }> =>
    postCommand('openJobEvidence', { ...input }),
  /** P74i：交付卡上点「验收通过」。revision 是交付卡视图的修订号（旧数据没有按 0）。 */
  acceptJob: (input: { jobId: string; stage: number; revision?: number }): Promise<CommandResult> =>
    postCommand('acceptJob', { ...input }),
  /** P74i：三轮不过卡上选一个办法。option 是办法的序号（从 0 起，A 为 0）。 */
  chooseJobOption: (input: { jobId: string; stage: number; option: number; revision?: number }): Promise<CommandResult> =>
    postCommand('chooseJobOption', { ...input }),
  /** P74i：答复「回合用到上限」条目；answer 是按钮文字（「再给 N 个回合」「暂停」）。 */
  answerJobCap: (input: { jobId: string; answer: string }): Promise<CommandResult> =>
    postCommand('answerJobCap', { ...input }),
  /** P74i：答复「没有进展」条目（原「停住了」）；answer 是按钮文字（「再提醒一次」「暂停」）。 */
  answerJobStall: (input: { jobId: string; answer: string }): Promise<CommandResult> =>
    postCommand('answerJobStall', { ...input }),
  /** P74i：在你的电脑上打开预览。成功返回 { ok:true, path }；失败返回 { ok:false, path, error }。 */
  openJobPreview: (input: { jobId: string }): Promise<CommandResult & { path?: string }> =>
    postCommand('openJobPreview', { ...input }),
  /** P75j：某位员工的技能库一栏（右侧栏「技能库」）。 */
  skillLibrary: (botId: string): Promise<SkillLibraryView> => getJson(`skill-library?botId=${encodeURIComponent(botId)}`),
  /** P76j：某位员工的「在办的事」（右侧栏）；旧宿主没有这条路由，取不到时界面退回工作会话列表。 */
  activeJobs: (botId: string): Promise<ActiveJobsView> => getJson(`active-jobs?botId=${encodeURIComponent(botId)}`),
  /** P75j：一条技能的详情（逐句出处、历史版本、同类任务对比）。 */
  skillDetail: (skillId: string): Promise<SkillDetailView> => getJson(`skill-detail?skillId=${encodeURIComponent(skillId)}`),
  /** P75j：把技能回退到某一版；被替换的版本仍保留，可以再回到它。 */
  rollbackSkill: (input: { skillId: string; versionNo: number }): Promise<CommandResult> => postCommand('rollbackSkill', { ...input }),
  /** P75j：把一条收起的技能放回员工每次读的技能目录。 */
  restoreSkill: (input: { skillId: string }): Promise<CommandResult> => postCommand('restoreSkill', { ...input }),
  /** P76k：页面可见时上报「你正在看」（打开一次、之后每 5 分钟一次）；失败只记日志。 */
  ownerSeen: (): Promise<CommandResult<{ generated: boolean }>> => postCommand('ownerSeen', {}),
  /** P76k：收起总管私聊顶部的离开期间摘要。 */
  dismissAwaySummary: (): Promise<CommandResult<{ dismissed: boolean }>> => postCommand('dismissAwaySummary', {}),
  /** P75k：「关于你的记忆」一页（偏好、规矩、决定和先例、项目背景，加 24 小时内删除的）；全队共用一份，不带参数。 */
  memoryPage: (): Promise<MemoryPageView> => getJson('memory-page'),
  command: postCommand,
}

/** SSE 变化事件的载荷（与宿主 hub-facade 的 ChangedEvent 一致）。 */
export interface ChangedEvent { scope: string; botId?: string }
