/**
 * 队友右侧边栏的内容规则（P64）：忙碌状态、额度、在办的事。
 *
 * 为什么单独成文件：这三块都是「把现成数据翻译成一句人话」，写成纯函数才能逐条测，
 * 组件只管画。数据全部来自总览里的队友卡、成本视图和项目视图，这里不发请求、不存状态。
 */
import type { Activity, BotCard, CostView, ModelChoice, StaffStatus } from '../../shared/views.js'
import { formatTokenCount } from '../../shared/token-format.js'
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
 * P73f：员工状态只有在岗、停用、归档三种（读 core 给的 staffStatus，不再读 lifecycle）。
 * 停用和归档时，活动字段已经不代表「在忙什么」（停用后可能还留着旧状态），所以先按状态说话；
 * 在岗不在表里，走下面的活动状态。
 */
const BUSY_BY_STATUS: Readonly<Partial<Record<StaffStatus, BusyRule>>> = {
  suspended: { tone: 'off', label: '停用', fallback: '恢复在岗之前不会自己行动。' },
  archived: { tone: 'off', label: '归档', fallback: '不再接活，记录保留可查。' },
}

/** 在岗队友按活动状态说话。core 的九种活动状态逐项对应，新增时类型检查会报出来。 */
const BUSY_BY_ACTIVITY: Readonly<Record<Activity, BusyRule>> = {
  thinking: { tone: 'busy', label: '正在忙', fallback: '正在处理手上的事。' },
  reflecting: { tone: 'busy', label: '正在复盘', fallback: '正在复盘最近的工作。' },
  catching_up: { tone: 'busy', label: '正在补看', fallback: '正在补看错过的变化。' },
  queued: { tone: 'busy', label: '排队中', fallback: '排着队，轮到就开始。' },
  waiting_owner: { tone: 'waiting', label: '在等你', fallback: '有事等你回复。' },
  waiting_peer: { tone: 'waiting', label: '在等员工', fallback: '在等别的员工回话。' },
  blocked: { tone: 'waiting', label: '无法继续', fallback: '手上的事无法继续，需要有人协助。' },
  watching: { tone: 'idle', label: '空闲', fallback: '现在没事，有变化时会自己醒。' },
  resting: { tone: 'idle', label: '空闲', fallback: '正在休息，到点再看。' },
}

/** 模型正在跑的三种状态：这时就算有问题等主人，当下的回答也是「在忙」。 */
const WORKING_ACTIVITIES: ReadonlySet<Activity> = new Set<Activity>(['thinking', 'reflecting', 'catching_up'])

/** 有提问或审批等主人，但活动句说的是别的事时用这句，告诉主人去哪里处理。 */
const WAITING_OWNER_HINT = '有事等你回复，去「待你处理」看看。'

/**
 * 算出忙碌状态。
 * 优先级：不上班（停用、归档）> 模型正在跑 > 有事等主人 > 其他活动状态。
 * 活动句是 core 写好的人话，能用就原样用；只在它缺失或答非所问时才用兜底说法。
 */
export function teammateBusy(card: Pick<BotCard, 'staffStatus' | 'staffStatusReason' | 'activity' | 'activityText' | 'waitingOwner'>): TeammateBusy {
  const statusRule = BUSY_BY_STATUS[card.staffStatus]
  // 停用、归档：不看残留的活动句，原因（core 给的 staffStatusReason）就是细节。
  if (statusRule !== undefined) return { tone: statusRule.tone, label: statusRule.label, detail: card.staffStatusReason ?? statusRule.fallback }
  // 活动句此时可能在说「在盯着 3 项」，回答不了「等你什么」，所以不用它。
  if (card.waitingOwner && card.activity !== 'waiting_owner' && !WORKING_ACTIVITIES.has(card.activity)) {
    return { tone: 'waiting', label: BUSY_BY_ACTIVITY.waiting_owner.label, detail: WAITING_OWNER_HINT }
  }
  // 将来 core 新增的活动状态在老插件上查不到规则，退回「空闲」，好过整块报错。
  const rule = BUSY_BY_ACTIVITY[card.activity] ?? BUSY_BY_ACTIVITY.watching
  const text = card.activityText.trim()
  // 活动句开头已经是结论：直接当结论，不再多写一行。
  if (text.startsWith(rule.label)) return { tone: rule.tone, label: text, detail: null }
  return { tone: rule.tone, label: rule.label, detail: text === '' ? rule.fallback : text }
}

/** 右侧边栏「状态」一栏的内容：一行主句，加可选的一行细节。 */
export interface TeammateStatusLine {
  tone: BusyTone
  /** 主句：在岗写「在岗　{忙碌结论}」，停用写「停用：{原因}」，归档写「归档」。 */
  text: string
  detail: string | null
}

/**
 * 「状态」一行（设计稿场景 D）：在岗时在后面接现有的忙碌文字（正在忙、空闲、在等你……），
 * 细节（它正在处理什么）放下一行；停用旁边写原因；归档只写「归档」。
 */
export function teammateStatusLine(card: Pick<BotCard, 'staffStatus' | 'staffStatusLabel' | 'staffStatusReason' | 'activity' | 'activityText' | 'waitingOwner'>): TeammateStatusLine {
  const busy = teammateBusy(card)
  if (card.staffStatus === 'on_duty') return { tone: busy.tone, text: `${card.staffStatusLabel}　${busy.label}`, detail: busy.detail }
  if (card.staffStatus === 'suspended') return { tone: 'off', text: `${card.staffStatusLabel}：${card.staffStatusReason ?? '你停用的'}`, detail: null }
  return { tone: 'off', text: card.staffStatusLabel, detail: busy.detail }
}

/** 模型档位信息（与 core 的 ModelTiers 同形，只取这里要比较的两项；没有档位信息时不传）。 */
export interface ModelTierInfo { standard: ModelChoice; light: ModelChoice; lightAvailable: boolean }

/** 两个模型选择是否同一个（null 表示跟随默认模型，只和 null 相等）。 */
function sameModel(a: ModelChoice, b: ModelChoice): boolean {
  if (a === null || b === null) return a === b
  return a.provider === b.provider && a.model === b.model
}

/**
 * 「模型与额度」里的档位或模型名：模型选择为「跟随默认」或等于标准档的模型时写「标准档」，
 * 等于轻档的模型时写「轻档」，其余写模型显示名（modelText）。
 * tiers 没有（模型目录还没读到）时写模型显示名，不猜档位。
 */
export function modelTierText(model: ModelChoice, modelText: string, tiers: ModelTierInfo | null | undefined): string {
  if (tiers === null || tiers === undefined) return modelText
  if (model === null || sameModel(model, tiers.standard)) return '标准档'
  if (tiers.lightAvailable && sameModel(model, tiers.light)) return '轻档'
  return modelText
}

/**
 * 「模型与额度」一行（设计稿场景 D）：「标准档。今天约 41K token。」
 * 额度只写 token，不写回合数（主人在 P64 定的）；token 优先成本视图，读不到退回队友卡（同 teammateQuota 的口径）。
 * token 数量按 P80 的规则换算成 K、M、B、T 单位（原来写「约 4.1 万」，「不足 1 万」一档随之取消，小于 1000 原样写）；
 * 两边都读不到写「今天还没有用量记录」，不编数字。
 */
export function modelQuotaLine(input: {
  tierText: string
  costs: CostView | undefined
  botId: string
  cardTokens: number | null | undefined
}): string {
  const tokens = quotaTokens(input)
  const head = `${input.tierText}。今天`
  if (tokens === null) return `${head}还没有用量记录。`
  return `${head}约 ${formatTokenCount(tokens)} token。`
}

/**
 * 这位队友今天用了多少 token（原始数字）：成本视图优先，读不到退回队友卡，都读不到为 null。
 * 抽出来是因为界面要拿它做鼠标悬停的完整数字，与 modelQuotaLine、teammateQuota 取同一个来源。
 */
export function quotaTokens(input: {
  costs: CostView | undefined
  botId: string
  cardTokens: number | null | undefined
}): number | null {
  return tokensToday(input.costs, input.botId) ?? input.cardTokens ?? null
}

/**
 * 额度块只剩一行：今天用了多少 token（主人原话：额度只要 token 数，不要回合数）。
 * token 有两个来源，按可信度排：
 * 1. 成本视图里这位队友今天的记账 token（含主人发起的回合）；
 * 2. 总览队友卡的 todayTokens（只含它自己醒来的回合，旧宿主没有成本视图时的退路）。
 * 两边都读不到才说没有记录，不编数字。token 数量按 P80 的规则换算单位（K、M、B、T）。
 */
export function teammateQuota(input: {
  /** 成本视图；旧宿主没有时为 undefined。 */
  costs: CostView | undefined
  botId: string
  /** 总览队友卡的 todayTokens；读不到时为 null 或 undefined。 */
  cardTokens: number | null | undefined
}): string {
  const tokens = quotaTokens(input)
  if (tokens === null) return '今天还没有用量记录'
  return `今天用了约 ${formatTokenCount(tokens)} token`
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
