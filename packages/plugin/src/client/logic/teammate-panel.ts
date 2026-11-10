/**
 * 队友右侧边栏的内容规则（P64）：忙碌状态、额度、在办的事。
 *
 * 为什么单独成文件：这三块都是「把现成数据翻译成一句人话」，写成纯函数才能逐条测，
 * 组件只管画。数据全部来自总览里的队友卡、成本视图和项目视图，这里不发请求、不存状态。
 */
import type { Activity, BotCard, CostView, Lifecycle } from '../../shared/views.js'
import { groupSessionsByProject, type WorkSession, type WorkSessionGroup } from './work-session.js'

/** 忙碌状态的大类：决定圆点颜色。off 表示它现在不上班（暂停、停用、退役、还没上岗）。 */
export type BusyTone = 'busy' | 'waiting' | 'idle' | 'off'

/** 忙碌状态的两段话：先给结论，再说具体在做什么。 */
export interface TeammateBusy {
  tone: BusyTone
  /** 结论：「正在忙」「空闲」「在等你」等。 */
  label: string
  /** 具体情况；结论已经把话说全时为 null，不重复写一遍。 */
  detail: string | null
}

/** 一条状态规则：大类、结论，以及活动句缺失时的兜底说法。 */
interface BusyRule { tone: BusyTone; label: string; fallback: string }

/**
 * 这几种生命周期下，活动字段已经不代表「在忙什么」（暂停后可能还留着旧状态），
 * 所以先按生命周期说话；在岗和试岗不在表里，走下面的活动状态。
 */
const BUSY_BY_LIFECYCLE: Readonly<Partial<Record<Lifecycle, BusyRule>>> = {
  paused: { tone: 'off', label: '已暂停', fallback: '恢复之前不会自己行动。' },
  quarantined: { tone: 'off', label: '已停用', fallback: '解除停用之前不会自己行动。' },
  retired: { tone: 'off', label: '已退役', fallback: '不再接活，数据还保留着。' },
  draft: { tone: 'off', label: '还没上岗', fallback: '上岗之后才会开始工作。' },
}

/** 在岗队友按活动状态说话。core 的九种活动状态逐项对应，新增时类型检查会报出来。 */
const BUSY_BY_ACTIVITY: Readonly<Record<Activity, BusyRule>> = {
  thinking: { tone: 'busy', label: '正在忙', fallback: '正在处理手上的事。' },
  reflecting: { tone: 'busy', label: '正在复盘', fallback: '正在复盘最近的工作。' },
  catching_up: { tone: 'busy', label: '正在补看', fallback: '正在补看错过的变化。' },
  queued: { tone: 'busy', label: '排队中', fallback: '排着队，轮到就开始。' },
  waiting_owner: { tone: 'waiting', label: '在等你', fallback: '有事等你回复。' },
  waiting_peer: { tone: 'waiting', label: '在等队友', fallback: '在等别的队友回话。' },
  blocked: { tone: 'waiting', label: '卡住了', fallback: '手上的事卡住了，需要有人帮一把。' },
  watching: { tone: 'idle', label: '空闲', fallback: '现在没事，有变化时会自己醒。' },
  resting: { tone: 'idle', label: '空闲', fallback: '正在休息，到点再看。' },
}

/** 模型正在跑的三种状态：这时就算有问题等主人，当下的回答也是「在忙」。 */
const WORKING_ACTIVITIES: ReadonlySet<Activity> = new Set<Activity>(['thinking', 'reflecting', 'catching_up'])

/** 有提问或审批等主人，但活动句说的是别的事时用这句，告诉主人去哪里处理。 */
const WAITING_OWNER_HINT = '有事等你回复，去「待你处理」看看。'

/**
 * 算出忙碌状态。
 * 优先级：不上班 > 模型正在跑 > 有事等主人 > 其他活动状态。
 * 活动句是 core 写好的人话，能用就原样用；只在它缺失或答非所问时才用兜底说法。
 */
export function teammateBusy(card: Pick<BotCard, 'lifecycle' | 'activity' | 'activityText' | 'waitingOwner'>): TeammateBusy {
  const lifecycleRule = BUSY_BY_LIFECYCLE[card.lifecycle]
  // 活动句此时可能在说「在盯着 3 项」，回答不了「等你什么」，所以不用它。
  if (lifecycleRule === undefined && card.waitingOwner
    && card.activity !== 'waiting_owner' && !WORKING_ACTIVITIES.has(card.activity)) {
    return { tone: 'waiting', label: BUSY_BY_ACTIVITY.waiting_owner.label, detail: WAITING_OWNER_HINT }
  }
  // 将来 core 新增的活动状态在老插件上查不到规则，退回「空闲」，好过整块报错。
  const rule = lifecycleRule ?? BUSY_BY_ACTIVITY[card.activity] ?? BUSY_BY_ACTIVITY.watching
  const text = card.activityText.trim()
  // 活动句开头已经是结论（「已暂停（你暂停的）」「已退役」）：直接当结论，不再多写一行。
  if (text.startsWith(rule.label)) return { tone: rule.tone, label: text, detail: null }
  return { tone: rule.tone, label: rule.label, detail: text === '' ? rule.fallback : text }
}

/**
 * 额度块只剩一行：今天用了多少 token（主人原话：额度只要 token 数，不要回合数）。
 * token 有两个来源，按可信度排：
 * 1. 成本视图里这位队友今天的记账 token（含主人发起的回合）；
 * 2. 总览队友卡的 todayTokens（只含它自己醒来的回合，旧宿主没有成本视图时的退路）。
 * 两边都读不到才说没有记录，不编数字。不足 1 万不给假精度。
 */
export function teammateQuota(input: {
  /** 成本视图；旧宿主没有时为 undefined。 */
  costs: CostView | undefined
  botId: string
  /** 总览队友卡的 todayTokens；读不到时为 null 或 undefined。 */
  cardTokens: number | null | undefined
}): string {
  const tokens = tokensToday(input.costs, input.botId) ?? input.cardTokens ?? null
  if (tokens === null) return '今天还没有用量记录'
  if (tokens < 10000) return '今天用了不到 1 万 token'
  return `今天用了约 ${(tokens / 10000).toFixed(1)} 万 token`
}

/** 从成本视图取这位队友今天的 token（记账值，含主人发起）；读不到为 null。第一天就是今天（core 按日倒序给）。 */
export function tokensToday(costs: CostView | undefined, botId: string): number | null {
  return costs?.days[0]?.bots.find(row => row.botId === botId)?.tokens ?? null
}

/** 「在办的事」为空时的固定说法。 */
export const NO_ACTIVE_WORK_TEXT = '现在没有在办的事'

/**
 * 在办的事：只留进行中和受阻的工作会话，按项目分组，最近有动静的项目排前面。
 * 传进来的应当已经按队友过滤过；待验收算已经交出去了，不再算在办。
 */
export function activeWorkGroups(sessions: readonly WorkSession[]): WorkSessionGroup[] {
  return groupSessionsByProject(sessions.filter(session => session.phase === 'doing'))
}
