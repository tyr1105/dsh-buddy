/**
 * 推送范围 → 界面刷新计划（D06 第 5 条，纯函数）。
 * core 的 HUB_EVENT_SCOPES 只在宿主侧存在（客户端 bundle 不能引入 core 运行时），
 * 这里按 M07 第 4 节的表逐项抄一份同样的词表与刷新规则；删除了旧版对内部表名
 * （bots/wakes/watches/appraisals/queue…）的匹配。
 */

/** 九个公开范围（与 core 的 HubEventScope 一致；不再出现内部表名）。 */
export type HubScope = 'overview' | 'bot' | 'thread' | 'inbox' | 'activity' | 'settings' | 'ledger' | 'office' | 'project' | 'memory'

/** 范围词表（值即 scope 字符串本身）。P75k 起多一个 memory（记忆新增、更正、撤销、删除）。 */
export const HUB_SCOPES: Readonly<Record<HubScope, HubScope>> = {
  overview: 'overview', bot: 'bot', thread: 'thread',
  inbox: 'inbox', activity: 'activity', settings: 'settings', ledger: 'ledger',
  office: 'office', project: 'project', memory: 'memory',
}

/** 一条 changed 事件要刷新哪些视图（宁多刷不漏刷；botId 为 null 表示全局/团队）。 */
export interface RefreshPlan {
  overview: boolean
  /** 需要重拉详情的机器人 id 列表（scope=bot 或带 botId 的 overview）。 */
  bots: string[]
  /** 需要重拉的线程 id（机器人 id 或主题 id；scope=thread 时按 botId 归位）。 */
  threads: string[]
  /** 是否重拉已经展开过的账本详情（按需加载的缓存，见 hub-state 的 ledgers）。 */
  ledgers: boolean
  inbox: boolean
  activity: boolean
  settings: boolean
  /** 是否重拉办公室投影（F03）：队友状态、账本、收件箱变化都会影响房间。 */
  office: boolean
  /**
   * 是否重拉资料授权矩阵（V2-PH2-04）：core 的资料变化发的是 overview scope，不新增 scope；
   * 所以凡会改资料/队友的范围（overview/bot）与 overview 同口径置 true（宁多刷不漏刷）。
   */
  resource: boolean
  /** 是否重拉项目容器（V2-PH4-02）：项目/任务变化发 project scope 时定向刷项目页。 */
  project: boolean
  /**
   * P75k：是否重拉记忆页（以及当前对话，「已记住」行的状态挂在对话的消息上）。
   * 只有 memory 范围才带这一项（其余范围的计划里没有这个字段），所以既有范围的计划形状不变。
   */
  memory?: true
}

const emptyPlan = (): RefreshPlan => ({ overview: false, bots: [], threads: [], ledgers: false, inbox: false, activity: false, settings: false, office: false, resource: false, project: false })

/**
 * 按 M07 第 4 节的表计算刷新计划：
 * - overview：全局变化刷总览；单机器人变化（带 id）顺带刷它的详情。
 * - bot：交账/感知/议程/目标/关注/规矩/套路/生命周期/队列/回合 → 刷该机器人详情 + 总览。
 * - thread：机器人线程带 id → 刷该线程 + 总览（未读汇总）；null 原指团队线程，
 *   P71 团队全景下线后界面不再摆它，只刷总览，不再去拉那条线程。
 * - inbox：刷收件箱 + 总览数量。
 * - activity：刷活动流。
 * - settings：刷设置视图。
 * - ledger：账本行变化 → 刷该机器人详情（唤醒时间线上的 hasLedger）+ 总览，
 *   并标记重拉已展开的账本详情（账本本身按需加载，不放进全局轮询）。
 * 队友新建/改名/退役（overview、bot scope）同样会改变资料授权的对象名字，资料页一并刷。
 * - office：办公室投影自身的变化（F03）→ 只刷办公室。
 * 另外，队友状态（overview/bot）、账本（ledger）与收件箱（inbox）都会改变房间里的灯、
 * 桌面产出或门口计数，所以这些范围顺带把办公室也刷一遍。
 * 未知的 scope（向前兼容）：总览 + 活动流都刷一遍。
 */
export function refreshPlan(scope: string, botId?: string | null): RefreshPlan {
  const plan = emptyPlan()
  const id = typeof botId === 'string' && botId !== '' ? botId : null
  switch (scope) {
    case HUB_SCOPES.overview:
      plan.overview = true
      plan.office = true
      plan.resource = true
      if (id !== null) plan.bots.push(id)
      return plan
    case HUB_SCOPES.bot:
      plan.overview = true
      plan.office = true
      plan.resource = true
      if (id !== null) plan.bots.push(id)
      return plan
    case HUB_SCOPES.ledger:
      plan.overview = true
      plan.office = true
      if (id !== null) plan.bots.push(id)
      plan.ledgers = true
      return plan
    case HUB_SCOPES.thread:
      plan.overview = true // 未读汇总在总览里
      if (id !== null) plan.threads.push(id)
      return plan
    case HUB_SCOPES.inbox:
      plan.inbox = true
      plan.overview = true // 总览的收件箱计数
      plan.office = true // 座位门口与房间总信箱
      return plan
    case HUB_SCOPES.activity:
      plan.activity = true
      return plan
    case HUB_SCOPES.settings:
      plan.settings = true
      return plan
    case HUB_SCOPES.office:
      plan.office = true
      return plan
    case HUB_SCOPES.memory:
      // P75k：记忆变化（botId 固定为空）：刷记忆页和当前对话，并刷总览（P75k 时为了左栏与总管右侧栏的条数；P86 起这两处入口已删除，界面不再读 memoryCount，这一次总览刷新保留不动、无副作用）。
      plan.overview = true
      plan.memory = true
      return plan
    case HUB_SCOPES.project:
      // V2-PH4-02：项目与任务变化（core 第四期，botId 固定 null）→ 刷总览计数并
      // 定向重拉项目页；项目变化目前不改办公室/资料投影，不顺带刷其它视图。
      plan.overview = true
      plan.project = true
      return plan
    default:
      plan.overview = true
      plan.activity = true
      return plan
  }
}
