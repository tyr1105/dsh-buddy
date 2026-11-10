/**
 * 新会话页和宿主的接线（P57）：@ 队友，以及选项目后在项目里开主题。
 *
 * 规则在 logic/new-session-mention.ts 和 logic/new-session-project.ts，这里只把它们接到宿主服务上：
 * - inputTriggers：往输入框的 @ 菜单里加「队友」或「项目成员」这一组；
 * - 认领（claim）：宿主唯一能接管回车的办法。回车时不进 DSH 会话，改成发给队友或开主题；
 * - conversation.hero.workspace：队友模式下换成带「项目」分组的下拉；
 * - conversation.hero.options：挂一个不显示内容的组件，让输入框的项目标签跟着选中状态走。
 *
 * 为什么用 ctx.inject 子插件：这些服务在插件启动时还没就绪（实测 ctx.get 拿不到）。
 * 子插件等齐了才运行，宿主版本缺某个服务时也只是这几项功能不出现，不会让 DSH 启动失败。
 * 所有回调都兜底：这里的任何错误都不能影响主人正常发消息。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { HubStore } from './hub-state.js'
import { createStore, useStore, type Store } from './store.js'
import type { BotCard } from '../shared/views.js'
import { openHubPanel } from './logic/host-sidebar.js'
import type { SpaceMode } from './logic/space-capability.js'
import {
  MENTION_SECTION_TITLE,
  TEAMMATE_CLAIM_NAME,
  TEAMMATE_SOURCE_NAME,
  directHint,
  mentionRoute,
  mentionToken,
  mentionableTeammates,
  teammateFromToken,
  type MentionRoute,
} from './logic/new-session-mention.js'
import {
  PROJECT_CHIP_IDLE,
  PROJECT_CLAIM_NAME,
  PROJECT_SOURCE_NAME,
  PROJECT_TRIGGER,
  activeProjects,
  projectChipStep,
  projectFromToken,
  projectHint,
  projectMentionRows,
  projectMentionSection,
  projectToken,
  type ComposerState,
  type ProjectChipDraft,
  type ProjectChoice,
} from './logic/new-session-project.js'
import { makeNewSessionWorkspacePicker } from './new-session-workspace-picker.js'

/** 宿主官方选择器的 priority 是 0，数值小的渲染，所以用负数盖住它。 */
const HERO_PICKER_PRIORITY = -10

/** 宿主服务里用得到的部分：实际对象来自宿主，这里只声明调用面。 */
interface HostServices {
  slots: {
    inject: (name: string, callback: () => unknown) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  effect: (factory: () => () => void, label?: string) => unknown
  inputTriggers: { registerSource: (source: unknown) => () => void }
  sessions: { list: { getSnapshot: () => { byId: Record<string, { blank?: boolean } | undefined> } } }
  workspaces: { create: (input: { path: string }) => Promise<{ workspaceId: string; title: string }> }
}

/** 认领提交时宿主要我们回答的结果。 */
type ClaimOutcome = { kind: 'success' } | { kind: 'error'; text: string }

type MentionPosition = 'leading' | 'inline'

/** 发送失败时给主人的提示都走这里，保证一定是一句人话。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function installNewSessionBridge(ctx: any, deps: { hub: HubStore; mode: Store<SpaceMode> }): void {
  const { hub, mode } = deps

  ctx.inject(['slots', 'inputTriggers', 'sessions', 'workspaces'], (host: HostServices) => {
    /** 新会话页选中的项目 id：只存内存，刷新页面回到普通状态，也不告诉宿主。 */
    const selection = createStore<string | null>(null)
    const teammates = (): BotCard[] => hub.getSnapshot().overview?.bots ?? []
    const projects = (): ProjectChoice[] => activeProjects(hub.getSnapshot().project)
    /** 选中的项目；已经不是进行中的项目（被暂停、归档）时当作没选。 */
    const selectedProject = (): ProjectChoice | null => projects().find(project => project.id === selection.getSnapshot()) ?? null

    /** 列菜单和选中时用同一份判断，避免两处口径不一致。 */
    const routeFor = (sessionId: string, position: MentionPosition, quoted: boolean): MentionRoute | null => mentionRoute({
      teamMode: mode.getSnapshot() === 'team',
      blankSession: host.sessions.list.getSnapshot().byId[sessionId]?.blank === true,
      quoted,
      position,
      projectSelected: selectedProject() !== null,
    })

    /** 发完之后跳走。等宿主清空输入框再跳：先切页面的话，这条空白会话下次打开还会留着刚发的内容。 */
    const jumpToThread = (threadId: string): void => {
      setTimeout(() => {
        try { openHubPanel(ctx, () => hub.selectThread(threadId)) }
        catch (error) { console.error('[agent-hub] 跳转到对话失败:', error) }
      }, 0)
    }

    /** 没选项目：话发给队友本人，然后跳到和它的对话。 */
    const sendDirect = async (bot: BotCard, args: string, attachments: readonly unknown[]): Promise<ClaimOutcome> => {
      // 队友线程只收文字。声明了接收附件才能在这里明确拒绝，否则宿主会让附件留在框里、话却发走了。
      if (attachments.length > 0) return { kind: 'error', text: `发给 ${bot.name} 的消息不支持附件。请移除附件后重试。` }
      const text = args.trim()
      if (text === '') return { kind: 'error', text: `消息内容为空。请写下要发给 ${bot.name} 的话。` }
      try {
        await hub.send(bot.id, text)
      } catch (error) {
        return { kind: 'error', text: `发送失败。${messageOf(error)}` }
      }
      jumpToThread(bot.id)
      return { kind: 'success' }
    }

    const directClaim = (bot: BotCard): Record<string, unknown> => ({
      name: TEAMMATE_CLAIM_NAME,
      token: mentionToken(bot.name),
      hint: directHint(bot.name),
      attachments: true,
      submit: (args: string, _actx: unknown, attachments: readonly unknown[]) => sendDirect(bot, args, attachments),
    })

    /**
     * 选了项目：第一句话开成一个主题，文字原样交给引擎，@ 谁由引擎从文字里解析。
     * 这条路不跑 DSH 模型，也不建 DSH 会话。
     */
    const createTopic = async (project: ProjectChoice, args: string, attachments: readonly unknown[]): Promise<ClaimOutcome> => {
      if (attachments.length > 0) return { kind: 'error', text: `项目 ${project.name} 的主题不支持附件。请移除附件后重试。` }
      const text = args.trim()
      if (text === '') return { kind: 'error', text: `消息内容为空。请写下要发到项目 ${project.name} 的话。` }
      let topicId: string | undefined
      try {
        const result = await hub.command('createProjectTopic', { projectId: project.id, text })
        if (!result.ok) return { kind: 'error', text: result.error }
        topicId = (result.data as { topicId?: string } | undefined)?.topicId
      } catch (error) {
        return { kind: 'error', text: `发送失败。${messageOf(error)}` }
      }
      if (topicId === undefined) return { kind: 'error', text: '发送失败。主题没有建好，请重试。' }
      // 这句话发完就回到普通状态：下一个新会话不该默默还在这个项目里。
      selection.set(null)
      jumpToThread(topicId)
      return { kind: 'success' }
    }

    const projectClaim = (project: ProjectChoice): Record<string, unknown> => ({
      name: PROJECT_CLAIM_NAME,
      token: projectToken(project.name),
      hint: projectHint(project),
      attachments: true,
      submit: (args: string, _actx: unknown, attachments: readonly unknown[]) => createTopic(project, args, attachments),
    })

    /** @ 菜单行的小头像：图标位只有 14px，两个字挤不下，取第一个字。 */
    const avatarIcon = (bot: BotCard) => function TeammateMenuAvatar(): ReactNode {
      return <span className="ah-mention-avatar" style={{ background: bot.color }} aria-hidden="true">{Array.from(bot.initials)[0] ?? ''}</span>
    }

    const source = {
      trigger: '@',
      name: TEAMMATE_SOURCE_NAME,
      // 队友模式下主人要找的主要是人，排在文件和对话前面（官方来源的 order 是 0）。
      order: -10,
      showGroupTitle: false,
      async candidates(session: { sessionId: string }, request: { query: string; quoted?: boolean; position: MentionPosition }) {
        try {
          const route = routeFor(session.sessionId, request.position, request.quoted === true)
          if (route === 'direct') {
            return mentionableTeammates(teammates(), request.query).map(bot => ({
              name: bot.name,
              description: bot.roleLabel,
              section: MENTION_SECTION_TITLE,
              icon: avatarIcon(bot),
              value: bot.id,
            }))
          }
          const project = route === 'project' ? selectedProject() : null
          if (project === null) return []
          return projectMentionRows(project, teammates(), request.query).map(row => ({
            name: row.bot.name,
            description: row.description,
            section: projectMentionSection(project.name),
            icon: avatarIcon(row.bot),
            value: row.bot.id,
          }))
        } catch (error) {
          console.error('[agent-hub] 读取队友候选失败:', error)
          return []
        }
      },
      onPick(pick: { candidate: { value?: string }; session: { sessionId: string }; position: MentionPosition }) {
        try {
          const bot = teammates().find(item => item.id === pick.candidate.value)
          if (bot === undefined) return undefined
          const route = routeFor(pick.session.sessionId, pick.position, false)
          if (route === 'direct') return { claim: directClaim(bot) }
          // 项目里点名就是文字：引擎按「@名字」解析，回车由开头的项目标签接管。
          if (route === 'project') return { text: mentionToken(bot.name) }
          return undefined
        } catch (error) {
          console.error('[agent-hub] 选择队友失败:', error)
          return undefined
        }
      },
      /** 切换工作区后草稿带到新会话时，宿主靠这里把标签重新建起来，否则会退回普通文字、话发给 DSH。 */
      async matchClaim(_session: unknown, token: string) {
        try {
          const bot = teammateFromToken(teammates(), token)
          return bot === undefined ? undefined : directClaim(bot)
        } catch (error) {
          console.error('[agent-hub] 恢复队友标签失败:', error)
          return undefined
        }
      },
    }
    host.effect(() => host.inputTriggers.registerSource(source), 'dsh-buddy: @ teammates')

    /**
     * 项目标签的来源：菜单里不列任何东西，宿主只会用 # 开头的文字来问 matchClaim。
     * 这里不判断当前选没选这个项目：先把标签建回来，要不要留由下面的组件统一决定，
     * 否则草稿带到普通工作区时标签退回成一段「#项目名」的普通文字，就摘不掉了。
     */
    const projectChipSource = {
      trigger: PROJECT_TRIGGER,
      name: PROJECT_SOURCE_NAME,
      candidates: async () => [],
      onPick: () => undefined,
      async matchClaim(_session: unknown, token: string) {
        try {
          const project = projectFromToken(projects(), token)
          return project === undefined ? undefined : projectClaim(project)
        } catch (error) {
          console.error('[agent-hub] 恢复项目标签失败:', error)
          return undefined
        }
      },
    }
    host.effect(() => host.inputTriggers.registerSource(projectChipSource), 'dsh-buddy: project chip')

    host.slots.inject('conversation.hero.options', () => host.slots.register(
      { name: 'conversation.hero.options', id: 'dsh-buddy-project-chip', order: 1000 },
      makeProjectChipGuard({ hub, selection }),
    ))

    // 下拉只在队友模式替换官方选择器；切回对话模式就撤掉，官方选择器自动复位，选中的项目也清掉。
    const picker = makeNewSessionWorkspacePicker({
      hub,
      selection,
      createWorkspace: path => host.workspaces.create({ path }),
      pickDirectory: () => pickDirectory(ctx),
      defaultWorkspaceName: () => defaultWorkspaceName(ctx),
    })
    host.effect(() => {
      let dispose: (() => void) | null = null
      const sync = (): void => {
        try {
          const team = mode.getSnapshot() === 'team'
          if (team && dispose === null) {
            dispose = host.slots.inject('conversation.hero.workspace', () => host.slots.register(
              // 这里不能声明 children：官方条目已经声明过目录流子插槽，抢先声明会让官方选择器注册失败。
              { name: 'conversation.hero.workspace', priority: HERO_PICKER_PRIORITY },
              picker,
            ))
          } else if (!team && dispose !== null) {
            dispose()
            dispose = null
            selection.set(null)
          }
        } catch (error) {
          console.error('[agent-hub] 切换新会话下拉失败:', error)
        }
      }
      sync()
      const unsubscribe = mode.subscribe(sync)
      return () => {
        unsubscribe()
        dispose?.()
      }
    }, 'dsh-buddy: new-session picker')
  })
}

/**
 * 不显示任何内容的组件：让输入框里的项目标签跟着选中状态走，规则见 projectChipStep。
 * 必须放在会话作用域的插槽里，宿主只在这里给 inputActions，这也是官方写草稿的接口。
 */
function makeProjectChipGuard(deps: { hub: HubStore; selection: Store<string | null> }) {
  return function ProjectChipGuard(props: {
    sessionId: string
    useInput: <T>(select: (state: ComposerState) => T) => T
    inputActions: { setDraft: (draft: ProjectChipDraft | string) => void }
  }): ReactNode {
    const phase = props.useInput(state => state.phase)
    const draft = props.useInput(state => state.draft)
    const claim = props.useInput(state => state.claim)
    const selectedId = useStore(deps.selection)
    const hubState = useStore(deps.hub)
    const memo = useRef({ sessionId: props.sessionId, chip: PROJECT_CHIP_IDLE })
    const projects = activeProjects(hubState.project)
    const selected = projects.find(project => project.id === selectedId) ?? null
    useEffect(() => {
      try {
        // 项目视图已经读到，但选中的项目不在进行中的名单里（被暂停或归档）：当作没选。
        if (selectedId !== null && selected === null && hubState.project !== null) {
          deps.selection.set(null)
          return
        }
        // 组件被宿主复用到另一条会话时，上一条的记录不能带过来。
        if (memo.current.sessionId !== props.sessionId) memo.current = { sessionId: props.sessionId, chip: PROJECT_CHIP_IDLE }
        const step = projectChipStep({ phase, draft, claim }, selected, memo.current.chip)
        memo.current.chip = step.memo
        if (step.clearSelection) deps.selection.set(null)
        if (step.draft !== null) props.inputActions.setDraft(step.draft)
        if (step.chipAppeared) placeComposerCaretAtEnd()
      } catch (error) {
        console.error('[agent-hub] 同步项目标签失败:', error)
      }
    }, [phase, draft, claim, selectedId, selected?.name, hubState.project === null, props.sessionId])
    return null
  }
}

/**
 * 标签建好后把光标挪到最后：先打字后选项目时，宿主把光标留在标签后面、正文前面，
 * 主人接着打的字会插到前面。只在输入框正拿着焦点时动，不抢别处的焦点。
 * 宿主编辑器会跟着浏览器的选区同步，所以改选区就够了；失败也不影响发送。
 */
function placeComposerCaretAtEnd(): void {
  try {
    const input = document.querySelector<HTMLElement>('[data-composer-input="true"]')
    if (input === null || document.activeElement !== input) return
    const range = window.getSelection()
    range?.selectAllChildren(input)
    range?.collapseToEnd()
  } catch (error) {
    console.error('[agent-hub] 移动输入框光标失败:', error)
  }
}

/** 官方选目录的同款调用：桌面版有全局选择器，其余环境走宿主接口。 */
function pickDirectory(ctx: any): Promise<string | null> {
  const desktop = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick: () => Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
  if (desktop !== undefined) return desktop.pick()
  const uiWorkspace = ctx.get?.('uiWorkspace') as { pickDirectory?: () => Promise<string | null> } | undefined
  if (typeof uiWorkspace?.pickDirectory !== 'function') return Promise.reject(new Error('当前环境不支持选择文件夹。'))
  return uiWorkspace.pickDirectory()
}

/** 宿主内部的默认工作区要显示成本地化名字；取不到时用中文兜底。 */
function defaultWorkspaceName(ctx: any): string {
  const key = 'workspace.defaultName'
  try {
    const text = ctx.locale.bind('workspace')(key) as string
    return text === key ? '默认工作区' : text
  } catch {
    return '默认工作区'
  }
}
