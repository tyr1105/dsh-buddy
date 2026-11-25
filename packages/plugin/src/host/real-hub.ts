/**
 * 真引擎门面：把 D01 的 HubFacade 接口接到 core Hub 的 UiApi 上（字段不变，
 * 路由与界面零改动）。包含三件东西：
 * - RealHubFacade：视图直通 hub.api；command(name, input) 用命令表分发并在边界
 *   校验参数（中文错误）；subscribe 直通 hub.subscribe（SSE 由此驱动）。
 * - LazyHubFacade：apply 时引擎还没起（init 是异步的），路由先挂在一个可延迟
 *   赋值的门面上；未就绪时访问返回中文错误而不是崩。
 * - DisabledHub：rootDir/.hub/DISABLED 存在时只提供界面（显示已停用），不启动引擎。
 */
import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { evidenceOpenable, previewRootDir } from '@agent-hub/core'
import type { Hub, UiApi, CommandResult } from '@agent-hub/core'
import type { BotView, MemoryPageView, ProjectView, ResourceView, SettingsView, SkillDetailView, SkillLibraryView, ThreadView } from '../shared/views.js'
import type { HubFacade, ChangedEvent, ChangeListener } from './hub-facade.js'
import { restoreSkillInput, rollbackSkillInput } from './skill-input.js'
import { chooseLearnSessionInput, correctMemoryInput, memoryIdInput } from './memory-input.js'

// ---------- 参数校验小工具（中文错误，说清哪一项不对） ----------

const bad = (error: string): CommandResult => ({ ok: false, error })

function reqStr(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key}：必须是 non-empty 字符串`)
  return value
}

function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key}：必须是字符串`)
  return value
}

function reqBool(input: Record<string, unknown>, key: string): boolean {
  const value = input[key]
  if (typeof value !== 'boolean') throw new Error(`${key}：必须是布尔值`)
  return value
}

// ---------- 打开预览（P74g）：宿主一侧的「只打开 core 返回的目标」 ----------

/** 打开预览的结果：成功只带目标；失败带目标和一句中文说明（界面把目标显示出来，主人可以复制自己打开）。 */
export type OpenResult = { ok: true; path: string } | { ok: false; path: string; error: string }

/** 打不开时给主人的固定说明。 */
export const OPEN_FAILED_TEXT = '没能自动打开，可以复制这个路径自己打开'

/** 调用系统程序所需的两样东西，都可以替换：测试用替身，永远不会真的打开任何程序或地址。 */
export interface OpenDeps {
  platform: NodeJS.Platform
  /** 与 node:child_process 的 execFile 同形：程序名、参数数组、选项、完成回调。不经过 shell。 */
  execFile: (file: string, args: string[], options: { timeout: number; windowsHide: boolean }, callback: (error: Error | null) => void) => unknown
  /**
   * P74r4b：中心专用的预览目录（<中心数据目录>/.hub/preview）。文件预览打开的是 core 复制出来的副本，
   * 宿主打开之前必须再确认目标在这个目录之内；没有给出时，一律不打开文件（失败关闭），地址预览不受影响。
   */
  previewRoot?: string
  /** 宿主打开文件之前查看目标用的两个文件操作，可以替换（测试用）；默认用 node:fs 的同步版本。 */
  files?: PreviewFiles
  /**
   * W12：DSH 自带的「用默认应用打开 / 在访达中显示」（sessionController.openWorkspacePath）。
   * 有就优先用它；没有或它报错时，退回下面的系统命令（open / open -R）。
   */
  hostOpen?: HostFileOpener
}

/** 宿主的打开接口：path 是检查过的真实绝对路径；action 为 reveal 时在访达中显示，省略时用默认应用打开。失败抛出。 */
export type HostFileOpener = (request: { path: string; action?: 'reveal' }) => Promise<void>

/** 打开文件之前的检查要用到的文件操作：不跟随链接地看一个路径，以及解析真实路径。 */
export interface PreviewFiles {
  /** 路径本身的信息（不跟随符号链接）；不存在返回 null。 */
  lstat: (path: string) => { isFile: boolean; isSymlink: boolean } | null
  /** 解析真实路径；失败抛出。 */
  realpath: (path: string) => string
}

/** 系统实现：node:fs 的同步 lstat 与 realpath。 */
const systemPreviewFiles: PreviewFiles = {
  lstat: path => {
    try {
      const info = lstatSync(path)
      return { isFile: info.isFile(), isSymlink: info.isSymbolicLink() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  },
  realpath: path => realpathSync(path),
}

/** 各系统打开默认程序的命令：返回程序名和参数数组。目标永远是参数数组里单独的一项。 */
export function openCommandFor(platform: NodeJS.Platform, target: string): { file: string; args: string[] } {
  // macOS：open 目标；Linux：xdg-open 目标。
  if (platform === 'darwin') return { file: 'open', args: [target] }
  // Windows：不用 cmd /c start。cmd 会把地址里的 & 当成「接着运行另一条命令」，本机地址的查询串里就可能带 &，
  // 那样等于把别人写的字送进了命令行。rundll32 的 FileProtocolHandler 同样是用默认程序打开文件或网址，且没有命令行解释这一层。
  if (platform === 'win32') return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target] }
  return { file: 'xdg-open', args: [target] }
}

/**
 * 宿主这一层的最后一道检查：目标必须是 core 给出的两种形状之一，且不能被系统程序当成选项。
 * P74i-m2（第四次审查低-5）：地址预览与核心同一口径——主机必须是本机（localhost、127.0.0.1、[::1]），
 * 用地址解析后的主机名判断（`http://localhost.evil.example/`、`http://127.0.0.1@evil.example/`
 * 这类都不放行），不用字符串开头判断。
 */
function hostAcceptsTarget(kind: 'file' | 'url', target: string): boolean {
  if (target === '' || target.startsWith('-') || /[\u0000-\u001f\u007f]/.test(target)) return false
  if (kind === 'url') {
    let url: URL | null = null
    try { url = new URL(target) } catch { url = null }
    if (url === null) return false
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  }
  // 文件：绝对路径（POSIX 以 / 开头；Windows 以盘符开头）。
  return target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target)
}

/**
 * 文件预览打开之前再查一次目标（P74r4b 第 2 节第 2 点；core 已经检查过，这里是第二道）：
 * - 必须在中心的预览目录之内：目标和预览目录都解析成真实路径，再按路径逐段比较（不用字符串前缀）；
 * - 必须是普通文件、不是符号链接；
 * - 扩展名必须是 .html 或 .htm。
 * 没有给出预览目录、或检查中出了任何错误，都按「不满足」处理。
 */
export function previewFileAllowed(target: string, deps: OpenDeps): boolean {
  try {
    if (deps.previewRoot === undefined || deps.previewRoot === '') return false
    if (!/\.html?$/i.test(target)) return false
    const files = deps.files ?? systemPreviewFiles
    const info = files.lstat(target)
    if (info === null || !info.isFile || info.isSymlink) return false
    const realRoot = files.realpath(deps.previewRoot)
    const realTarget = files.realpath(target)
    // 逐段比较：「…/preview」不能把「…/preview-other/…」当成自己里面的。
    const rest = posix.relative(realRoot, realTarget)
    return rest !== '' && rest !== '..' && !rest.startsWith('../') && !posix.isAbsolute(rest)
  } catch {
    return false
  }
}

/** 用系统默认程序打开 target；任何失败（含抛出）都返回 ok: false 和目标，绝不抛出。 */
export async function openTarget(kind: 'file' | 'url', target: string, deps: OpenDeps): Promise<OpenResult> {
  const failed: OpenResult = { ok: false, path: target, error: OPEN_FAILED_TEXT }
  try {
    if (!hostAcceptsTarget(kind, target)) return failed
    // 文件：目标必须是中心预览目录里的 .html 普通文件（P74r4b）。
    if (kind === 'file' && !previewFileAllowed(target, deps)) return failed
    const { file, args } = openCommandFor(deps.platform, target)
    await new Promise<void>((resolve, reject) => {
      deps.execFile(file, args, { timeout: 15000, windowsHide: true }, error => (error === null ? resolve() : reject(error)))
    })
    return { ok: true, path: target }
  } catch {
    return failed
  }
}

// ---------- 卡片上的文件证据（W12）：交给宿主打开或在访达中显示 ----------

/** 「在访达中显示」用的系统命令：macOS 用 open -R；Windows 用 explorer /select；其余打开所在的文件夹。 */
export function revealCommandFor(platform: NodeJS.Platform, target: string): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: ['-R', target] }
  if (platform === 'win32') return { file: 'explorer.exe', args: [`/select,${target}`] }
  return { file: 'xdg-open', args: [dirname(target)] }
}

/**
 * 宿主这一层对证据文件的第二道检查（core 已经查过）：绝对路径、没有控制字符、不会被当成选项、
 * 是普通文件且不是符号链接；用默认应用打开时扩展名还得在放行名单里（与 core 同一个函数）。任何出错都按「不满足」处理。
 */
export function evidenceFileAllowed(target: string, action: 'open' | 'reveal', deps: OpenDeps): boolean {
  try {
    if (target === '' || target.startsWith('-') || /[\u0000-\u001f\u007f]/.test(target)) return false
    if (!(target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target))) return false
    if (action === 'open' && !evidenceOpenable(target)) return false
    const info = (deps.files ?? systemPreviewFiles).lstat(target)
    return info !== null && info.isFile && !info.isSymlink
  } catch {
    return false
  }
}

/** 打开或显示一个证据文件：先用 DSH 自带的能力，不行再用系统命令；任何失败都返回 ok: false 和路径，绝不抛出。 */
export async function openEvidenceFile(target: string, action: 'open' | 'reveal', deps: OpenDeps): Promise<OpenResult> {
  const failed: OpenResult = { ok: false, path: target, error: OPEN_FAILED_TEXT }
  if (!evidenceFileAllowed(target, action, deps)) return failed
  if (deps.hostOpen !== undefined) {
    try {
      await deps.hostOpen(action === 'reveal' ? { path: target, action: 'reveal' } : { path: target })
      return { ok: true, path: target }
    } catch { /* 宿主拒绝或不支持：退回系统命令 */ }
  }
  try {
    const { file, args } = action === 'reveal' ? revealCommandFor(deps.platform, target) : openCommandFor(deps.platform, target)
    await new Promise<void>((resolve, reject) => {
      deps.execFile(file, args, { timeout: 15000, windowsHide: true }, error => (error === null ? resolve() : reject(error)))
    })
    return { ok: true, path: target }
  } catch {
    return failed
  }
}

/**
 * 界面的「打开文件 / 在访达中显示」命令：只认 jobId、submissionId、evidenceId、action，
 * 位置由 core 查过之后给出；界面传来的路径一律忽略。core 返回错误时原样返回、不调用任何程序。
 */
async function openJobEvidenceCommand(api: UiApi, raw: Record<string, unknown>, deps: OpenDeps): Promise<CommandResult | OpenResult> {
  const action = raw.action === 'reveal' ? 'reveal' : 'open'
  const checked = await api.jobEvidenceOpenTarget({ jobId: raw.jobId, submissionId: raw.submissionId, evidenceId: raw.evidenceId, action })
  if (!checked.ok) return { ok: false, error: checked.error }
  if (checked.data === undefined) return bad('没能取得文件的位置')
  return openEvidenceFile(checked.data.path, checked.data.action, deps)
}

/** 真正的系统实现：用 node:child_process 的 execFile（参数数组，不经过 shell）。 */
export const systemOpenDeps: OpenDeps = {
  platform: process.platform,
  execFile: (file, args, options, callback) => execFile(file, args, options, error => callback(error)),
}

/**
 * 界面的「打开预览」命令：只认 jobId，先让 core 校验并给出目标，再打开那个目标。
 * 界面传来的其他任何字段（路径、地址）一律忽略；core 返回错误时原样返回、不调用任何系统程序。
 */
async function openJobPreviewCommand(api: UiApi, raw: Record<string, unknown>, deps: OpenDeps): Promise<CommandResult | OpenResult> {
  const jobId = reqStr(raw, 'jobId')
  const checked = await api.jobPreviewTarget({ jobId })
  if (!checked.ok) return { ok: false, error: checked.error }
  const target = checked.data
  if (target === undefined) return bad('没能取得预览的位置')
  return openTarget(target.kind, target.kind === 'file' ? target.path : target.url, deps)
}

/** 命令表：name → (api, input)。每条都在边界校验，UiApi 内部还会用 zod 再校验一次。 */
export function dispatchCommand(api: UiApi, name: string, raw: Record<string, unknown>, deps: OpenDeps = systemOpenDeps): Promise<CommandResult> {
  const run = (work: () => Promise<CommandResult | OpenResult>): Promise<CommandResult> =>
    work().catch(error => bad(error instanceof Error ? error.message : String(error)))
  try {
    switch (name) {
      // P74g：读一张证据截图（只读）：整对象透传给 core，由 core 的 zod 校验并检查路径。
      case 'readJobEvidence': return run(() => api.readJobEvidence({ jobId: raw.jobId, submissionId: raw.submissionId, evidenceId: raw.evidenceId }))
      // P74g：打开预览：只认 jobId，目标由 core 给出，宿主只打开这个目标。
      case 'openJobPreview': return run(() => openJobPreviewCommand(api, raw, deps))
      // W12：卡片上的文件证据：用默认应用打开或在访达中显示。位置由 core 查过后给出，宿主再查一次。
      case 'openJobEvidence': return run(() => openJobEvidenceCommand(api, raw, deps))
      // P74i：交付卡与三轮不过卡的按钮、回合上限与「停住了」条目的答复。
      // 都是普通 core 命令：整对象透传，由 core 的 zod 校验（缺哪一项它会用中文说清）。
      case 'acceptJob': return run(() => api.acceptJob(raw))
      case 'chooseJobOption': return run(() => api.chooseJobOption(raw))
      case 'answerJobCap': return run(() => api.answerJobCap(raw))
      case 'answerJobStall': return run(() => api.answerJobStall(raw))
      case 'createBot': return run(() => api.createBot(raw))
      case 'updateBot': return run(() => api.updateBot(reqStr(raw, 'botId'), raw.patch))
      case 'setLifecycle': return run(() => api.setLifecycle(reqStr(raw, 'botId'), reqStr(raw, 'lifecycle') as never))
      // M07：生命周期动作与主人打断都改走 core 的命令入口（UiApi 内部再用 zod 校验）。
      case 'lifecycleAction': return run(() => api.lifecycleAction(raw))
      // P48：归档/恢复/删除都只收 botId，业务校验在 core 用中文错误说明缺哪一项。
      case 'archiveBotCheck': return run(() => api.archiveBotCheck(reqStr(raw, 'botId')))
      case 'archiveBot': return run(() => api.archiveBot(reqStr(raw, 'botId')))
      case 'restoreArchivedBot': return run(() => api.restoreArchivedBot(reqStr(raw, 'botId')))
      case 'deleteArchivedBot': return run(() => api.deleteArchivedBot(reqStr(raw, 'botId')))
      case 'interruptBot': return run(() => api.interruptBot(raw))
      case 'sendMessage': return run(() => api.sendMessage(reqStr(raw, 'threadId'), reqStr(raw, 'text')))
      case 'answerInbox': return run(() => api.answerInbox(reqStr(raw, 'id'), reqStr(raw, 'answer'), optStr(raw, 'note')))
      case 'decideApproval': return run(() => api.decideApproval(reqStr(raw, 'id'), reqBool(raw, 'approve'), optStr(raw, 'note')))
      case 'upsertAspiration': return run(() => api.upsertAspiration(raw))
      case 'upsertGoal': return run(() => api.upsertGoal(raw))
      case 'closeGoal': return run(() => api.closeGoal(reqStr(raw, 'id'), raw.outcome as boolean | 'done' | 'active' | 'abandoned'))
      case 'readArtifactVersion': return run(() => api.readArtifactVersion(raw))
      case 'officeReplay': return run(() => api.officeReplay(raw))
      case 'reviewArtifact': return run(() => api.reviewArtifact(raw))
      case 'upsertWatch': return run(() => api.upsertWatch(raw))
      case 'decideWatchProposal': return run(() => api.decideWatchProposal(reqStr(raw, 'id'), reqBool(raw, 'approve')))
      case 'upsertRule': return run(() => api.upsertRule(raw))
      // P75f：这两个入口已停用（套路并入技能库、教它技能改为对总管说），照任务卡返回固定说明。
      case 'editRoutine': return Promise.resolve({ ok: false, error: '这个入口已停用：套路已并入技能库，请在技能库里查看。' })
      case 'teach': return Promise.resolve({ ok: false, error: '这个入口已停用：要员工学某段会话的做法，请对总管说。' })
      // P75j：技能详情里的「回退到这一版」「放回」。参数在边界先查一遍（中文错误，见 skill-input.ts），
      // 再交给 core 的命令入口（它还会用 zod 校验一次，并判断技能与版本是否存在）。
      case 'rollbackSkill': return run(() => api.rollbackSkill(rollbackSkillInput(raw)))
      case 'restoreSkill': return run(() => api.restoreSkill(restoreSkillInput(raw)))
      // P75k：「已记住」行与记忆页的五个命令、学习选会话（总管私聊里点某一段会话）。
      // 与技能库命令同一做法：参数在边界先查一遍（中文错误，见 memory-input.ts），再交给 core 的命令入口（它还会用 zod 校验一次）。
      case 'undoMemory': return run(() => api.undoMemory(memoryIdInput(raw)))
      case 'correctMemory': return run(() => api.correctMemory(correctMemoryInput(raw)))
      case 'deleteMemory': return run(() => api.deleteMemory(memoryIdInput(raw)))
      case 'undoDeleteMemory': return run(() => api.undoDeleteMemory(memoryIdInput(raw)))
      case 'undoCorrectMemory': return run(() => api.undoCorrectMemory(memoryIdInput(raw)))
      case 'chooseLearnSession': return run(() => api.chooseLearnSession(chooseLearnSessionInput(raw)))
      case 'pokeBot': return run(() => api.pokeBot(reqStr(raw, 'botId'), optStr(raw, 'text')))
      case 'updateSettings': return run(() => api.updateSettings(raw))
      // P76k：页面可见时上报「你正在看」、收起离开期间摘要；都不带参数，core 内部用 zod 校验空对象。
      case 'ownerSeen': return run(() => api.ownerSeen())
      case 'dismissAwaySummary': return run(() => api.dismissAwaySummary())
      // P38：连接草稿只读自检，整对象透传给 core zod 校验；不落设置、不产生审批。
      case 'testKnowledgeConnection': return run(() => api.testKnowledgeConnection(raw))
      case 'markThreadRead': return run(() => api.markThreadRead(reqStr(raw, 'threadId')))
      // 资料三条（V2-PH2-04）：saveResource/setGrant 整对象透传给 core zod 校验；
      // archiveResource 只收 id，缺参在边界直接中文报错、不进引擎。
      case 'saveResource': return run(() => api.saveResource(raw))
      case 'setGrant': return run(() => api.setGrant(raw))
      case 'revokeGrant': return run(() => api.revokeGrant(raw))
      case 'archiveResource': return run(() => api.archiveResource(reqStr(raw, 'id')))
      // 项目与任务（V2-PH4-02 / F12 / V2-PH4-04）：saveProject/saveTask/rejectTask/assignTask/
      // dispatchTask 整对象透传给 core zod 校验；派活三 id（projectId/taskId/botId）与 note
      // 的形状全部由 core DispatchTaskSchema 把关，边界不挑字段。其余状态流转只收 id，
      // 缺参在边界直接中文报错、不进引擎。
      case 'saveProject': return run(() => api.saveProject(raw))
      case 'pauseProject': return run(() => api.pauseProject(reqStr(raw, 'id')))
      case 'resumeProject': return run(() => api.resumeProject(reqStr(raw, 'id')))
      case 'completeProject': return run(() => api.completeProject(reqStr(raw, 'id')))
      case 'archiveProject': return run(() => api.archiveProject(reqStr(raw, 'id')))
      case 'restoreProject': return run(() => api.restoreProject(reqStr(raw, 'id')))
      // P39 项目共享上下文：saveProjectContext 整对象透传；采纳/驳回只收建议 id。
      case 'saveProjectContext': return run(() => api.saveProjectContext(raw))
      case 'approveProjectContextProposal': return run(() => api.approveProjectContextProposal(reqStr(raw, 'id')))
      case 'rejectProjectContextProposal': return run(() => api.rejectProjectContextProposal(reqStr(raw, 'id')))
      case 'saveTask': return run(() => api.saveTask(raw))
      case 'assignTask': return run(() => api.assignTask(raw))
      // V2-PH4-04：派活/恢复/催办/改派统一入口，整对象透传，三 id 与留言由 core zod 校验。
      case 'dispatchTask': return run(() => api.dispatchTask(raw))
      // P63：开项目主题，整对象透传由 core zod 校验；之后发消息沿用 sendMessage，线程 id 就是主题 id。
      case 'createProjectTopic': return run(() => api.createProjectTopic(raw))
      case 'taskBlock': return run(() => api.taskBlock(reqStr(raw, 'id')))
      case 'taskResume': return run(() => api.taskResume(reqStr(raw, 'id')))
      case 'reportDone': return run(() => api.reportDone(reqStr(raw, 'id')))
      case 'acceptTask': return run(() => api.acceptTask(reqStr(raw, 'id')))
      case 'rejectTask': return run(() => api.rejectTask(raw))
      // 任务关联产物（F08 尾巴）：整对象透传，任务/产物是否存在与上限由 core 判定。
      case 'attachTaskArtifact': return run(() => api.attachTaskArtifact(raw))
      // P72：约定卡上点「定了」，整对象（agreementId、version、choices）透传，由 core zod 校验。
      case 'confirmAgreement': return run(() => api.confirmAgreement(raw))
      // P73e：三问回答、组队卡编辑与确认，整对象透传，由 core zod 校验（rev、候选编号、动作、值）。
      case 'answerTeamQuestion': return run(() => api.answerTeamQuestion(raw))
      case 'editTeamCandidate': return run(() => api.editTeamCandidate(raw))
      case 'confirmTeamProposal': return run(() => api.confirmTeamProposal(raw))
      default: return Promise.resolve(bad(`未知命令：${name}；请更新插件后重试`))
    }
  } catch (error) {
    return Promise.resolve(bad(error instanceof Error ? error.message : String(error)))
  }
}

// ---------- 真引擎门面 ----------

/** 推送渠道直读存储的最小形状（core 的 FileStore.settings 表；D07 第 6 条）。 */
export interface PushChannelStore {
  table(name: 'settings'): { get(id: string): { pushChannel?: unknown } | null | undefined }
}

export class RealHubFacade implements HubFacade {
  /**
   * 推送渠道缓存（D06 第 1 条 / D07 第 6 条）：直接同步读引擎存储的 settings 行
   * （updateSettings 落的是整份设置），**不走会读宿主模型目录的 settings() 视图**，
   * 也不依赖有没有 SSE 订阅者——目录坏了「不推送」的设置照样生效。读不到时保持
   * 上次读到的值；从未读到过按「不推送」（none）处理，绝不默认推送。
   */
  private pushChannelCache: string = 'none'

  /** 打开预览时用的参数：系统程序加上中心的预览目录（没有传 rootDir 时没有预览目录，文件预览一律不打开）。 */
  private readonly openDeps: OpenDeps

  constructor(private readonly hub: Hub, store?: PushChannelStore, rootDir?: string, hostOpen?: HostFileOpener) {
    const base = rootDir === undefined ? systemOpenDeps : { ...systemOpenDeps, previewRoot: previewRootDir(rootDir) }
    this.openDeps = hostOpen === undefined ? base : { ...base, hostOpen }
    this.readStoredPushChannel(store)
    // 常驻订阅一次（不挂在 SSE 订阅者上）：主人改设置后立刻刷新缓存。
    try {
      this.hub.subscribe(event => {
        if (event.scope === 'settings') this.readStoredPushChannel(store)
      })
    } catch { /* 订阅失败只影响刷新时机，不影响初值 */ }
  }

  private readStoredPushChannel(store?: PushChannelStore): void {
    try {
      const value = store?.table('settings').get('settings')?.pushChannel
      if (typeof value === 'string' && value !== '') this.pushChannelCache = value
    } catch { /* 读失败保持旧值，绝不阻塞投递 */ }
  }

  async overview() { return this.hub.api.overview() }
  async bot(botId: string) { return this.hub.api.bot(botId) }
  async thread(threadId: string, opts?: { before?: string | number; limit?: number }) {
    return this.hub.api.thread(threadId, opts)
  }
  async inbox() { return this.hub.api.inbox() }
  async activity(opts?: { before?: string | number; limit?: number }) { return this.hub.api.activity(opts) }
  async settings() { return this.hub.api.settings() }
  /** P76k：设置页「最近 7 天的用量」表；core 只读组装，不写任何状态。 */
  async weeklyUsage() { return this.hub.api.weeklyUsage() }
  /** 办公室是 core 的纯投影，读一次就给一屏，不写任何状态。 */
  async office() { return this.hub.api.officeView() }
  /** 资料授权矩阵也是只读组装：资料、授权、中文名全部由 core 的 resourceView 给出。 */
  async resource() { return this.hub.api.resourceView() }
  /** 项目容器同样是只读组装：项目、成员、验收项、任务分组与问题都由 core 的 projectView 给出。 */
  async project() { return this.hub.api.projectView() }
  /** 账本读法：core 的接口是同步读存储，门面统一成 Promise 保持调用方一致。 */
  async wakeLedger(botId: string, opts?: { limit?: number; before?: number }) {
    return this.hub.api.wakeLedgerList(botId, opts?.limit, opts?.before)
  }
  async wakeLedgerDetail(wakeId: string) { return this.hub.api.wakeLedgerDetail(wakeId) }
  /** P75j：技能库一栏与技能详情都是只读视图，core 同步读存储，门面统一成 Promise。 */
  async skillLibrary(botId: string): Promise<SkillLibraryView> { return this.hub.api.skillLibrary(botId) }
  async skillDetail(skillId: string): Promise<SkillDetailView> { return this.hub.api.skillDetail(skillId) }
  /** P76j：「在办的事」也是只读视图（core 的 activeJobs），同步读存储后统一成 Promise。 */
  async activeJobs(botId: string) { return this.hub.api.activeJobs(botId) }
  /** P75k：记忆页是只读视图（core 同步读存储，不调用模型），门面统一成 Promise。 */
  async memoryPage(): Promise<MemoryPageView> { return this.hub.api.memoryPage() }
  async command(name: string, input: Record<string, unknown>): Promise<CommandResult> {
    return dispatchCommand(this.hub.api, name, input, this.openDeps)
  }
  subscribe(fn: ChangeListener): () => void {
    return this.hub.subscribe(event => {
      try { fn({ scope: event.scope, botId: event.botId ?? undefined } satisfies ChangedEvent) } catch (error) {
        console.error('[agent-hub] 订阅者回调出错:', error)
      }
    })
  }
  /** 当前推送渠道（同步读缓存；存储直读 + settings 事件刷新，见 pushChannelCache）。 */
  pushChannel(): string { return this.pushChannelCache }
}

// ---------- 可延迟赋值的门面 ----------

const NOT_READY = '中心引擎尚未就绪，请稍后重试'

export class LazyHubFacade implements HubFacade {
  private impl: HubFacade | null = null
  /** 引擎启动失败的原因（D07 第 12 条）：界面要显示失败原因，而不是永远「正在启动」。 */
  private failure: string | null = null
  private readonly extraListeners = new Set<ChangeListener>()
  /** 已挂到当前引擎上的退订函数（listener → off）。换引擎时先全部退掉再重挂。 */
  private readonly engineOffs = new Map<ChangeListener, () => void>()

  /**
   * 接通实现（D05 第 12 条）：把已有订阅逐个挂到新引擎上——引擎就绪前建立的 SSE
   * 连接在就绪后也要能收到 changed 事件，不能只收 emitInApp。
   */
  setImpl(impl: HubFacade): void {
    this.impl = impl
    for (const [listener, off] of [...this.engineOffs]) {
      try { off() } catch { /* 忽略旧引擎退订失败 */ }
      this.engineOffs.delete(listener)
    }
    for (const listener of [...this.extraListeners]) {
      try {
        const off = impl.subscribe(listener)
        if (typeof off === 'function') this.engineOffs.set(listener, off)
      } catch (error) { console.error('[agent-hub] 重挂引擎订阅失败:', error) }
    }
  }

  /** 应用内提示（notify 之后调用）：直接向 SSE 订阅者广播一条 changed 事件。 */
  emitInApp(scope = 'overview'): void {
    for (const fn of [...this.extraListeners]) {
      try { fn({ scope }) } catch (error) { console.error('[agent-hub] 应用内提示回调出错:', error) }
    }
  }

  status(): { ok: boolean; mode: string; error?: string } {
    if (this.failure !== null) return { ok: false, mode: 'failed', error: this.failure }
    if (this.impl === null) return { ok: false, mode: 'starting' }
    if (this.impl instanceof DisabledHub) return { ok: false, mode: 'disabled' }
    return { ok: true, mode: 'engine' }
  }

  /** 引擎启动失败（D07 第 12 条）：记下原因，之后所有视图访问都报「启动失败：原因」。 */
  markFailed(reason: string): void {
    if (this.failure === null) this.failure = reason
  }

  private facade(): HubFacade {
    if (this.failure !== null) throw new Error(`中心引擎启动失败：${this.failure}`)
    if (this.impl === null) throw new Error(NOT_READY)
    return this.impl
  }

  async overview() { return this.facade().overview() }
  async bot(botId: string) { return this.facade().bot(botId) }
  async thread(threadId: string, opts?: { before?: string; limit?: number }) { return this.facade().thread(threadId, opts) }
  async inbox() { return this.facade().inbox() }
  async activity(opts?: { before?: string; limit?: number }) { return this.facade().activity(opts) }
  async settings() { return this.facade().settings() }
  async weeklyUsage() { return this.facade().weeklyUsage() }
  async office() { return this.facade().office() }
  async resource() { return this.facade().resource() }
  async project() { return this.facade().project() }
  async wakeLedger(botId: string, opts?: { limit?: number; before?: number }) { return this.facade().wakeLedger(botId, opts) }
  async wakeLedgerDetail(wakeId: string) { return this.facade().wakeLedgerDetail(wakeId) }
  async skillLibrary(botId: string) { return this.facade().skillLibrary(botId) }
  async skillDetail(skillId: string) { return this.facade().skillDetail(skillId) }
  async activeJobs(botId: string) { return this.facade().activeJobs(botId) }
  async memoryPage() { return this.facade().memoryPage() }
  async command(name: string, input: Record<string, unknown>) { return this.facade().command(name, input) }
  subscribe(fn: ChangeListener): () => void {
    // 记在本地（emitInApp 与 setImpl 重挂都用它）；引擎已就绪时同时挂到引擎上。
    this.extraListeners.add(fn)
    if (this.impl !== null) {
      try {
        const off = this.impl.subscribe(fn)
        if (typeof off === 'function') this.engineOffs.set(fn, off)
      } catch (error) { console.error('[agent-hub] 引擎订阅失败:', error) }
    }
    return () => {
      this.extraListeners.delete(fn)
      const off = this.engineOffs.get(fn)
      this.engineOffs.delete(fn)
      try { off?.() } catch { /* 忽略 */ }
    }
  }
}

// ---------- 停用门面：rootDir/.hub/DISABLED 存在时 ----------

const emptyOverview = {
  // P58：停用时总览接口仍返回 200，这里明确标出空名册只是占位，
  // 否则界面会以为队友都不存在，把主人选中的对话和本地记忆一起清掉。
  rosterUnavailable: true,
  bots: [], inbox: { total: 0, approvals: 0, questions: 0, proposals: 0, alerts: 0 },
  team: { unread: 0, lastMessageText: null }, quota: { light: 'green', lightLabel: '未知', usedText: '已停用', resetText: null },
  health: { ok: false, heartbeatText: '已停用', downtimeText: null, openAlerts: 0, sandboxWarning: null },
  nowText: '已停用', quietNow: false, pushesLeftToday: 0,
}

/** 停用后的空资料矩阵：没有资料也没有授权，页面显示正常空态而不是整页错误。 */
const emptyResource: ResourceView = {
  asOf: 0, resources: [], grants: [],
  counts: { total: 0, active: 0, archived: 0, grants: 0 },
}

/** 停用后的空项目视图：没有项目与任务，项目页显示正常空态而不是整页错误。 */
const emptyProject: ProjectView = {
  // P63：和空总览同一个道理，空列表只是占位，界面不能据此判断主题没了、把本地记住的主题清掉。
  rosterUnavailable: true,
  asOf: 0, projects: [],
  counts: { active: 0, paused: 0, done: 0, archived: 0, total: 0, tasksTotal: 0, tasksPendingCheck: 0 },
}

export class DisabledHub implements HubFacade {
  constructor(private readonly reason: string) {}
  private denied<T>(): T { throw new Error(this.reason) }
  async overview() { return structuredClone(emptyOverview) as never }
  async bot(_botId: string): Promise<BotView> { return this.denied() }
  async thread(_threadId: string, _opts?: { before?: string; limit?: number }): Promise<ThreadView> { return this.denied() }
  async inbox() { return { items: [] } }
  async activity() { return { rows: [], hasMore: false } }
  async settings(): Promise<SettingsView> { return this.denied() }
  /** 停用后没有可汇总的回合：给一份只有表头的空表，设置页照常打开。 */
  async weeklyUsage() { return { head: ['事', '回合', '预计', 'token'] as ['事', '回合', '预计', 'token'], rows: [] } }
  /** 停用后办公室没有可投影的数据：给一间空房间并如实说明，不把整页打成错误。 */
  async office() {
    return {
      asOf: 0, seats: [],
      doorway: { count: 0, items: [], refs: [], ref: 'inbox' },
      health: { quotaLight: 'green' as const, quotaLightLabel: '未知', openAlerts: 0, sandboxOk: false, ok: false },
      truncated: false,
    }
  }
  /** 停用后资料矩阵没有数据可看：给一份空矩阵（计数全 0），不把整页打成错误。 */
  async resource(): Promise<ResourceView> { return structuredClone(emptyResource) }
  /** 停用后项目页没有数据可看：给一份空项目视图（计数全 0），不把整页打成错误。 */
  async project(): Promise<ProjectView> { return structuredClone(emptyProject) }
  /** 停用后账本只读视图没有数据可看：列表为空、详情为空，不把整页打成错误。 */
  async wakeLedger(_botId: string, _opts?: { limit?: number; before?: number }) { return [] }
  async wakeLedgerDetail(_wakeId: string) { return null }
  /** 停用后没有技能数据可看：与读员工详情一致，直接说明停用原因。 */
  async skillLibrary(_botId: string): Promise<SkillLibraryView> { return this.denied() }
  async skillDetail(_skillId: string): Promise<SkillDetailView> { return this.denied() }
  /** 停用后没有在办的事可看：给空视图，不把整页打成错误。 */
  async activeJobs(_botId: string) { return { headText: '现在没有在办的事', rows: [], footerText: '查看全部记录' as const } }
  /** 停用后没有记忆可看：直接说明停用原因（与技能库同一做法）。 */
  async memoryPage(): Promise<MemoryPageView> { return this.denied() }
  async command(): Promise<CommandResult> { return { ok: false, error: this.reason } }
  subscribe(): () => void { return () => undefined }
}
