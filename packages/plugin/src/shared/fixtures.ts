/**
 * 样例数据（D01 样例数据模式专用）：给界面半边提供「像真的」的数据。
 * 为什么这样设计：D02 会把 FixtureHub 换成接真实引擎的 HubFacade，界面不改；
 * 所以这里的形状必须严格符合 views.ts 的类型（也就是规格第 15.1 节）。
 * 文案遵守 docs/design/prd/sections/16-ui.md 16.0.3：中文、北京时间短文案、不写内部代码与 ID。
 */
import { resolveSettings } from '@agent-hub/core'
import type {
  ActivityView, BotView, InboxView, OverviewView, RecentSessionView, SettingsView, ThreadMessageView, ThreadView,
} from './views.js'

// 以一个固定的「现在」为基准生成相对时间文案，避免样例每次刷新都变（D01 不接真时钟）。
const NOW = Date.now()

/** 造一条线程消息的简写：card 为 null 表示普通消息；minutesAgo 决定时间字段（样例固定基准）。 */
function msg(m: Partial<ThreadMessageView> & Pick<ThreadMessageView, 'id' | 'thread' | 'from' | 'fromName' | 'kind' | 'text'> & { minutesAgo?: number }): ThreadMessageView {
  const minutesAgo = m.minutesAgo ?? 60
  return {
    createdAt: NOW - minutesAgo * 60_000,
    timeText: minutesAgo < 1 ? '刚刚' : minutesAgo < 60 ? `${Math.round(minutesAgo)} 分钟前` : `今天 ${String(14 + Math.floor(minutesAgo / 60) % 10).padStart(2, '0')}:${String((minutesAgo * 7) % 60).padStart(2, '0')}`,
    fromColor: null,
    card: null,
    ...m,
  }
}

// ---------- 三个机器人 + 总览 ----------

export const fixtureOverview: OverviewView = {
  bots: [
    {
      id: 'bot-xunjian', name: '巡检员', role: 'sentinel', roleLabel: '盯守', color: 'var(--dsw-alias-accent)', initials: '巡',
      lifecycle: 'active', lifecycleLabel: '在岗', activity: 'watching', activityLabel: '盯着', activityText: '在盯着：3 项 · 下次自查：有变化时，最晚周四 9:00',
      nextThinkText: '有变化时，最晚周四 09:00',
      lastOutcome: 'progress', lastOutcomeLabel: '有进展', lastActiveText: '26 分钟前',
      unread: 0, todayThinks: 3, todayBudget: 6, todayTokens: 41000, waitingOwner: false,
    },
    {
      id: 'bot-guanchao', name: '观潮', role: 'researcher', roleLabel: '调研', color: 'var(--dsw-alias-success)', initials: '观',
      lifecycle: 'active', lifecycleLabel: '在岗', activity: 'thinking', activityLabel: '思考', activityText: '正在处理：执行单没出（第 12/30 步）',
      nextThinkText: '这轮结束后它自己定',
      lastOutcome: 'progress', lastOutcomeLabel: '有进展', lastActiveText: '刚刚',
      unread: 2, todayThinks: 2, todayBudget: 6, todayTokens: 68000, waitingOwner: false,
    },
    {
      id: 'bot-zongguan', name: '总管', role: 'chief', roleLabel: '总管', color: 'var(--dsw-alias-warning)', initials: '总',
      lifecycle: 'active', lifecycleLabel: '在岗', activity: 'waiting_owner', activityLabel: '等主人', activityText: '等你：要不要把巡检频率改成每天 1 次？（已等 26 小时，周五按默认处理）',
      nextThinkText: '你回答后马上想',
      lastOutcome: 'needs_owner', lastOutcomeLabel: '需要主人', lastActiveText: '26 小时前',
      unread: 1, todayThinks: 1, todayBudget: 6, todayTokens: 12000, waitingOwner: true,
    },
  ],
  inbox: { total: 3, approvals: 1, questions: 1, proposals: 1, alerts: 0 },
  team: { unread: 0, lastMessageText: '观潮：执行单的事我在查，第 12 步了，有结果告诉你。' },
  quota: { light: 'green', lightLabel: '绿灯', usedText: '约 12.1 万 token（估算）', resetText: '明天 00:00 恢复' },
  health: { ok: true, heartbeatText: '心跳正常（刚刚）', downtimeText: null, openAlerts: 0 },
  nowText: '今天 14:20', quietNow: false, pushesLeftToday: 3,
}

// ---------- 线程 ----------

/** 团队线程与每个机器人的线程（含提问卡、审批卡、汇报、日报各至少一条）。 */
export const fixtureThreads: ThreadView[] = [
  {
    threadId: 'team', title: '团队',
    messages: [
      msg({ id: 'tm1', thread: 'team', from: 'hub', fromName: '中心', kind: 'system', text: '团队线程开启。机器人的交接和汇报会抄送到这里。', minutesAgo: 2880 }),
      msg({ id: 'tm2', thread: 'team', from: 'bot-xunjian', fromName: '巡检员', fromColor: 'var(--dsw-alias-accent)', kind: 'report', text: '它交账：收藏服务的运行记录昨晚新增 1 行，都是正常的定时归档，不需要处理。', minutesAgo: 720 }),
      msg({ id: 'tm3', thread: 'team', from: 'bot-guanchao', fromName: '观潮', fromColor: 'var(--dsw-alias-success)', kind: 'chat', text: '执行单的事我在查：昨晚 03:30 应该出的执行单没出，我拉了前后半小时的日志，正在比对。', minutesAgo: 90 }),
      msg({ id: 'tm4', thread: 'team', from: 'bot-zongguan', fromName: '总管', fromColor: 'var(--dsw-alias-warning)', kind: 'handoff', text: '交接：观潮查执行单，巡检员继续盯运行记录，我汇总。有需要主人拍板的走收件箱。', minutesAgo: 60 }),
      msg({ id: 'tm5', thread: 'team', from: 'hub', fromName: '中心', kind: 'digest', text: '日报（昨天）：全队共思考 7 次。最重要三件：1) 收藏服务运行记录正常；2) 执行单未出，观潮在查；3) 总管提议把巡检频率改成每天 1 次，等你决定。被免打扰拦下的推送都已并入本日报。', minutesAgo: 30 }),
      msg({ id: 'tm6', thread: 'team', from: 'bot-guanchao', fromName: '观潮', fromColor: 'var(--dsw-alias-success)', kind: 'reply', text: '执行单的事我在查，第 12 步了，有结果告诉你。', minutesAgo: 5 }),
    ],
    hasMore: false, oldestId: 'tm1',
  },
  {
    threadId: 'bot-xunjian', title: '巡检员',
    messages: [
      msg({ id: 'xm1', thread: 'bot-xunjian', from: 'hub', fromName: '中心', kind: 'system', text: '巡检员上岗（试岗 7 天已通过）。它盯着 3 个关注项。', minutesAgo: 4320 }),
      msg({ id: 'xm2', thread: 'bot-xunjian', from: 'bot-xunjian', fromName: '巡检员', fromColor: 'var(--dsw-alias-accent)', kind: 'report', text: '它交账：收藏服务运行记录新增 1 行（1495/1495），是正常的定时归档。中心核对：文件存在且在回合内改过。', minutesAgo: 720 }),
      msg({ id: 'xm3', thread: 'bot-xunjian', from: 'owner', fromName: '我', kind: 'chat', text: '好的，这种归档行以后不用专门叫我了。', minutesAgo: 700 }),
      msg({ id: 'xm4', thread: 'bot-xunjian', from: 'bot-xunjian', fromName: '巡检员', fromColor: 'var(--dsw-alias-accent)', kind: 'reply', text: '收到。以后这类变化我只记进日报，除非连续两行没出（那是异常）。', minutesAgo: 690 }),
      msg({ id: 'xm5', thread: 'bot-xunjian', from: 'bot-xunjian', fromName: '巡检员', fromColor: 'var(--dsw-alias-accent)', kind: 'digest', text: '日报（昨天）：盯了 3 项，共 4 次自查，全部无变化。今天剩下的次数：3 次。', minutesAgo: 240 }),
      msg({ id: 'xm6', thread: 'bot-xunjian', from: 'owner', fromName: '我', kind: 'chat', text: '辛苦。', minutesAgo: 26 }),
      msg({ id: 'xm7', thread: 'bot-xunjian', from: 'bot-xunjian', fromName: '巡检员', fromColor: 'var(--dsw-alias-accent)', kind: 'reply', text: '不客气。下次自查：有变化时马上，最晚周四 9:00。', minutesAgo: 20 }),
    ],
    hasMore: false, oldestId: 'xm1',
  },
  {
    threadId: 'bot-guanchao', title: '观潮',
    messages: [
      msg({ id: 'gm1', thread: 'bot-guanchao', from: 'hub', fromName: '中心', kind: 'system', text: '观潮上岗。它的志向：把每天 03:30 的执行单链路盯明白。', minutesAgo: 5760 }),
      msg({ id: 'gm2', thread: 'bot-guanchao', from: 'bot-guanchao', fromName: '观潮', fromColor: 'var(--dsw-alias-success)', kind: 'question', text: '想问你：昨晚的执行单没出，我可以读服务器上的任务日志吗？只读不改。', minutesAgo: 1800, card: { inboxId: 'inbox-q1', approvalId: null, type: 'question', status: 'open', title: '观潮想读任务日志', body: '它想读取服务器上的任务日志来排查执行单未出的原因，只读不改。', options: ['可以，只读', '先不要'], defaultOption: '可以，只读', answer: null, expiresText: '周五 09:00 按默认处理' } }),
      msg({ id: 'gm3', thread: 'bot-guanchao', from: 'owner', fromName: '我', kind: 'chat', text: '可以，只读。别动配置。', minutesAgo: 1740 }),
      msg({ id: 'gm4', thread: 'bot-guanchao', from: 'bot-guanchao', fromName: '观潮', fromColor: 'var(--dsw-alias-success)', kind: 'approval', text: '需要你批准：把排查结论写进共享目录的交接文件（同伴能看见）。', minutesAgo: 600, card: { inboxId: 'inbox-a1', approvalId: 'appr-a1', type: 'approval', status: 'open', title: '写交接文件', body: '把执行单排查的阶段性结论写到 shared/ 目录，巡检员和总管能看见。', options: ['批准', '拒绝'], defaultOption: '批准', answer: null, expiresText: '今晚 20:00 前有效' } }),
      msg({ id: 'gm5', thread: 'bot-guanchao', from: 'bot-guanchao', fromName: '观潮', fromColor: 'var(--dsw-alias-success)', kind: 'report', text: '它交账：比对完 03:00–04:00 的日志，执行单卡在依赖服务超时，已把证据链写进备忘。中心核对：回执存在。', minutesAgo: 120 }),
      msg({ id: 'gm6', thread: 'bot-guanchao', from: 'owner', fromName: '我', kind: 'chat', text: '进度怎么样了？', minutesAgo: 6 }),
      msg({ id: 'gm7', thread: 'bot-guanchao', from: 'bot-guanchao', fromName: '观潮', fromColor: 'var(--dsw-alias-success)', kind: 'reply', text: '正在处理：执行单没出（第 12/30 步）。初步看是依赖服务超时，我在等它今天的复现窗口。', minutesAgo: 4 }),
    ],
    hasMore: true, oldestId: 'gm1',
  },
  {
    threadId: 'bot-zongguan', title: '总管',
    messages: [
      msg({ id: 'zm1', thread: 'bot-zongguan', from: 'hub', fromName: '中心', kind: 'system', text: '总管上岗。它看全队：分工、交接、和你之间的优先级。', minutesAgo: 10080 }),
      msg({ id: 'zm2', thread: 'bot-zongguan', from: 'bot-zongguan', fromName: '总管', fromColor: 'var(--dsw-alias-warning)', kind: 'proposal', text: '提议：把「收藏服务运行记录」的巡检从每小时改成每天 1 次。最近 7 天全是正常归档，频率可以降下来。', minutesAgo: 1560, card: { inboxId: 'inbox-p1', approvalId: null, type: 'proposal', status: 'open', title: '巡检频率改成每天 1 次', body: '最近 7 天的巡检结果全部是正常归档，建议把该关注项的检查频率从每小时降到每天 1 次，省下的次数留给执行单排查。', options: ['接受', '先保持'], defaultOption: '接受', answer: null, expiresText: '周五 09:00 按默认处理' } }),
      msg({ id: 'zm3', thread: 'bot-zongguan', from: 'bot-zongguan', fromName: '总管', fromColor: 'var(--dsw-alias-warning)', kind: 'question', text: '等你回答上面这个提议。改还是不改，你说了算；不回答的话周五按「先保持」处理。', minutesAgo: 1556 }),
      msg({ id: 'zm4', thread: 'bot-zongguan', from: 'hub', fromName: '中心', kind: 'digest', text: '日报（昨天）：全队 7 次思考，约 9.8 万 token（估算）。观潮的执行单排查是当前最重要的事。', minutesAgo: 30 }),
      msg({ id: 'zm5', thread: 'bot-zongguan', from: 'owner', fromName: '我', kind: 'chat', text: '我先看看它俩今天的情况再说。', minutesAgo: 8 }),
      msg({ id: 'zm6', thread: 'bot-zongguan', from: 'bot-zongguan', fromName: '总管', fromColor: 'var(--dsw-alias-warning)', kind: 'reply', text: '好。一句话总结：巡检员一切正常；观潮在查执行单，第 12 步；就差你对巡检频率的提议拍板。', minutesAgo: 6 }),
    ],
    hasMore: false, oldestId: 'zm1',
  },
]

// ---------- 收件箱 ----------

export const fixtureInbox: InboxView = {
  items: [
    { id: 'inbox-a1', approvalId: 'appr-a1', createdAt: NOW - 60 * 60_000, botId: 'bot-guanchao', botName: '观潮', botColor: 'var(--dsw-alias-success)', type: 'approval', typeLabel: '审批', priority: 'P1', title: '写交接文件', body: '把执行单排查的阶段性结论写到 shared/ 目录，同伴能看见。', options: ['批准', '拒绝'], defaultOption: '批准', createdText: '今天 13:20', expiresText: '今晚 20:00 前有效' },
    { id: 'inbox-q1', approvalId: null, createdAt: NOW - 26 * 60 * 60_000, botId: 'bot-guanchao', botName: '观潮', botColor: 'var(--dsw-alias-success)', type: 'question', typeLabel: '提问', priority: 'P1', title: '观潮想读任务日志', body: '它想读取服务器上的任务日志来排查执行单未出的原因，只读不改。', options: ['可以，只读', '先不要'], defaultOption: '可以，只读', createdText: '昨天 16:20', expiresText: '周五 09:00 按默认处理' },
    { id: 'inbox-p1', approvalId: null, createdAt: NOW - 26 * 60 * 60_000 - 4 * 60_000, botId: 'bot-zongguan', botName: '总管', botColor: 'var(--dsw-alias-warning)', type: 'proposal', typeLabel: '提议', priority: 'P2', title: '巡检频率改成每天 1 次', body: '最近 7 天巡检结果全部正常，建议把该关注项的检查频率从每小时降到每天 1 次。', options: ['接受', '先保持'], defaultOption: '接受', createdText: '昨天 12:20', expiresText: '周五 09:00 按默认处理' },
  ],
}

// ---------- 活动流（10 条） ----------

export const fixtureActivity: ActivityView = {
  rows: [
    { id: 'ac10', at: NOW - 4 * 60_000, timeText: '4 分钟前', botId: 'bot-guanchao', botName: '观潮', botColor: 'var(--dsw-alias-success)', kind: 'wake', text: '被叫醒：变化——执行单依赖服务今天又超时了 1 次。正在处理（第 12/30 步）。' },
    { id: 'ac9', at: NOW - 6 * 60_000, timeText: '6 分钟前', botId: 'bot-zongguan', botName: '总管', botColor: 'var(--dsw-alias-warning)', kind: 'commit', text: '交账：汇总了全队今天的状态，等你对巡检频率的提议拍板。' },
    { id: 'ac8', at: NOW - 20 * 60_000, timeText: '20 分钟前', botId: 'bot-xunjian', botName: '巡检员', botColor: 'var(--dsw-alias-accent)', kind: 'commit', text: '交账：第 4 次自查完成，无变化。' },
    { id: 'ac7', at: NOW - 26 * 60_000, timeText: '26 分钟前', botId: null, botName: null, botColor: null, kind: 'system', text: '日报已送达到团队线程（免打扰时段外）。' },
    { id: 'ac6', at: NOW - 120 * 60_000, timeText: '2 小时前', botId: 'bot-guanchao', botName: '观潮', botColor: 'var(--dsw-alias-success)', kind: 'commit', text: '交账：比对完 03:00–04:00 日志，定位到依赖服务超时，证据链已存。' },
    { id: 'ac5', at: NOW - 150 * 60_000, timeText: '2.5 小时前', botId: 'bot-guanchao', botName: '观潮', botColor: 'var(--dsw-alias-success)', kind: 'approval', text: '发起审批：写交接文件（等主人）。' },
    { id: 'ac4', at: NOW - 240 * 60_000, timeText: '4 小时前', botId: 'bot-xunjian', botName: '巡检员', botColor: 'var(--dsw-alias-accent)', kind: 'commit', text: '交账：第 3 次自查完成，无变化。' },
    { id: 'ac3', at: NOW - 26 * 60 * 60_000, timeText: '26 小时前', botId: 'bot-zongguan', botName: '总管', botColor: 'var(--dsw-alias-warning)', kind: 'commit', text: '交账：提出巡检频率调整的提议，转入收件箱。' },
    { id: 'ac2', at: NOW - 30 * 60 * 60_000, timeText: '昨天 14:20', botId: 'bot-zongguan', botName: '总管', botColor: 'var(--dsw-alias-warning)', kind: 'handoff', text: '交接：执行单排查交给观潮，巡检员继续盯运行记录。' },
    { id: 'ac1', at: NOW - 32 * 60 * 60_000, timeText: '昨天 12:20', botId: null, botName: null, botColor: null, kind: 'lifecycle', text: '观潮完成试岗，转为在岗。' },
  ],
  hasMore: false,
}

// ---------- 机器人详情（含为什么醒 / 为什么没醒各若干条） ----------

/** 生成一份机器人详情视图；wakes/appraisals 两个机器人共用骨架、文案各自给。 */
function botView(v: BotView): BotView { return v }

export const fixtureBots: Record<string, BotView> = {
  'bot-xunjian': botView({
    card: fixtureOverview.bots[0]!,
    profile: {
      persona: '话少、只报事实，异常才开口。口头禅：「记下了。」',
      autonomy: 'L1', autonomyLabel: 'L1 建议', pace: 'normal', paceLabel: '适中',
      model: null, modelText: '跟随宿主默认模型',
      createdAt: NOW - 9 * 24 * 60 * 60_000, homeDir: '~/AgentHub/bots/xunjian', sessionId: 'sess-xunjian-demo', createdText: '10-28', probationText: null, workDataAllowed: false,
    },
    aspirations: [{ id: 'asp1', text: '让盯着的每一项都有「期望」：什么算正常、什么该叫人。', status: 'active' }],
    goals: [
      { id: 'g1', title: '收藏服务运行记录连续 7 天全正常', doneWhen: '连续 7 天的巡检里没有异常行', period: 'week', periodText: '周', status: 'active', statusLabel: '进行中', lastProgressText: '今天第 4 天，全部正常', createdBy: 'owner' },
    ],
    agenda: [
      { id: 'ag1', kind: 'review', kindLabel: '复查', title: '复查「归档行」的判断规则是否仍然准确', dueText: '周四 9:00', priority: 3, toOwner: false, source: 'bot', status: 'open' },
      { id: 'ag2', kind: 'follow_up', kindLabel: '跟进', title: '跟进收藏服务下周一的版本升级', dueText: '下周一 00:00', priority: 4, toOwner: false, source: 'owner', status: 'open' },
    ],
    watches: [
      { id: 'w1', kind: 'log', kindLabel: '日志', target: '~/services/collect/run.log', filter: '每行', intervalText: '每小时', expectationText: '每小时归档 1 行', status: 'active', createdBy: 'owner', why: '你让我盯着这个服务的健康', lastCheckedText: '20 分钟前' },
      { id: 'w2', kind: 'file', kindLabel: '文件', target: '~/services/collect/config.yaml', filter: '内容变化', intervalText: '有变化时', expectationText: '不该有人改它', status: 'active', createdBy: 'owner', why: '配置不该被随手改', lastCheckedText: '20 分钟前' },
      { id: 'w3', kind: 'http', kindLabel: '网页', target: 'https://example.com/status', filter: '状态页出现红色', intervalText: '每天 1 次', expectationText: '应该全绿', status: 'active', createdBy: 'bot', why: '它自己提议的，你接受了', lastCheckedText: '昨天 14:00' },
    ],
    routines: [{ id: 'r1', name: '确认归档行', whenToUse: '看到运行记录新增行时', steps: ['读新增行的内容', '和上一行比对', '正常的记进日报，异常的马上告诉你'], runs: 26, updatedText: '昨天' }],
    rules: [
      { id: 'ru1', text: '不许改任何服务的配置。', redLine: true, scope: 'global' },
      { id: 'ru2', text: '正常归档不用叫主人，写日报即可。', redLine: false, scope: 'bot' },
    ],
    memoryExcerpt: '主人关心的是「别出事」，不是「每行都知道」。归档行噪音已被降级到日报。',
    wakes: [
      { id: 'wk3', variant: 'light_check', variantLabel: '轻复查', reasonKind: 'light_check', reasonText: '到自查时刻，快速看一眼', score: 0.4, threshold: 0.6, status: 'committed', outcome: 'no_change', outcomeLabel: '无变化', summary: '3 项全部正常', steps: 3, tokens: 2100, durationText: '2 分钟', startedAt: NOW - 20 * 60_000, timeText: '20 分钟前' },
      { id: 'wk2', variant: 'regular', variantLabel: '常规', reasonKind: 'percept', reasonText: '变化：收藏服务运行记录：新增 1 行，1495/1495', score: 0.9, threshold: 0.6, status: 'committed', outcome: 'progress', outcomeLabel: '有进展', summary: '新增行是正常归档，规则判断无需打扰', steps: 8, tokens: 9400, durationText: '6 分钟', startedAt: NOW - 12 * 60 * 60_000, timeText: '昨天 14:20' },
      { id: 'wk1', variant: 'regular', variantLabel: '常规', reasonKind: 'next_think', reasonText: '它自己约的时刻到了', score: 0.5, threshold: 0.6, status: 'committed', outcome: 'no_change', outcomeLabel: '无变化', summary: '全量自查一次，无变化', steps: 12, tokens: 13000, durationText: '9 分钟', startedAt: NOW - 26 * 60 * 60_000, timeText: '昨天 12:20' },
    ],
    appraisals: [
      { id: 'ap8', at: NOW - 20 * 60_000, timeText: '20 分钟前', decision: 'woke', decisionLabel: '已唤醒', suppressedBy: null, text: '轻复查：到时刻了，看一眼不花钱', score: 0.4, threshold: 0.6 },
      { id: 'ap7', at: NOW - 55 * 60_000, timeText: '55 分钟前', decision: 'record_only', decisionLabel: '仅记录', suppressedBy: null, text: '状态页探活成功，没有新内容', score: 0.1, threshold: 0.6 },
      { id: 'ap6', at: NOW - 3 * 60 * 60_000, timeText: '3 小时前', decision: 'suppressed', decisionLabel: '被拦截', suppressedBy: 'pace_min', text: '又有 1 行归档，但距上次思考不到最短间隔', score: 0.7, threshold: 0.6 },
      { id: 'ap5', at: NOW - 6 * 60 * 60_000, timeText: '6 小时前', decision: 'pile', decisionLabel: '入待处理堆', suppressedBy: null, text: '中等变化先攒着，够了再叫', score: 0.45, threshold: 0.6 },
      { id: 'ap4', at: NOW - 9 * 60 * 60_000, timeText: '6 小时前', decision: 'record_only', decisionLabel: '仅记录', suppressedBy: null, text: '配置文件没有变化', score: 0, threshold: 0.6 },
      { id: 'ap3', at: NOW - 12 * 60 * 60_000, timeText: '昨天 14:20', decision: 'woke', decisionLabel: '已唤醒', suppressedBy: null, text: '运行记录新增 1 行，显著性够高', score: 0.9, threshold: 0.6 },
      { id: 'ap2', at: NOW - 18 * 60 * 60_000, timeText: '昨天 08:20', decision: 'suppressed', decisionLabel: '被拦截', suppressedBy: 'quota', text: '额度黄灯，节奏放慢一倍', score: 0.65, threshold: 0.6 },
      { id: 'ap1', at: NOW - 26 * 60 * 60_000, timeText: '昨天 12:20', decision: 'woke', decisionLabel: '已唤醒', suppressedBy: null, text: '它自己约的全量自查时刻', score: 0.5, threshold: 0.6 },
    ],
    stats: { thinks7d: 21, intervalCv: 0.62, selfPacedRatio: 0.57, selfInitiated7d: 2, proposalAcceptRate: 1, tokens7d: 118000 },
  }),
  'bot-guanchao': botView({
    card: fixtureOverview.bots[1]!,
    profile: {
      persona: '好奇心重，喜欢把一件事追到根因。汇报时先给结论再给证据。',
      autonomy: 'L1', autonomyLabel: 'L1 建议', pace: 'active', paceLabel: '积极',
      model: { provider: 'deepseek-official', model: 'deepseek-flash' }, modelText: 'deepseek-official / deepseek-flash',
      createdAt: NOW - 5 * 24 * 60 * 60_000, homeDir: '~/AgentHub/bots/guanchao', sessionId: 'sess-guanchao-demo', createdText: '11-02', probationText: '试岗第 5/7 天', workDataAllowed: false,
    },
    aspirations: [
      { id: 'asp1', text: '把执行单链路彻底查明白，让它别再半夜出问题。', status: 'active' },
      { id: 'asp2', text: '学会写「别人一眼能懂」的排查笔记。', status: 'active' },
    ],
    goals: [
      { id: 'g1', title: '本周找出执行单未出的根因', doneWhen: '给出有证据的根因结论和一条规避建议', period: 'week', periodText: '周', status: 'active', statusLabel: '进行中', lastProgressText: '已定位到依赖服务超时，等今天复现窗口', createdBy: 'owner' },
    ],
    agenda: [
      { id: 'ag1', kind: 'task', kindLabel: '任务', title: '等依赖服务今天的复现窗口，抓现场', dueText: '今天 16:00', priority: 1, toOwner: false, source: 'bot', status: 'open' },
      { id: 'ag2', kind: 'commitment', kindLabel: '承诺', title: '周五前给主人一份排查结论', dueText: '周五 18:00', priority: 2, toOwner: true, source: 'owner', status: 'open' },
    ],
    watches: [
      { id: 'w1', kind: 'log', kindLabel: '日志', target: '~/services/dispatch/job.log', filter: '出现 error 或超时', intervalText: '每小时', expectationText: '03:30 应有一行执行单记录', status: 'active', createdBy: 'owner', why: '执行单连续两天没出', lastCheckedText: '刚刚' },
    ],
    routines: [{ id: 'r1', name: '日志比对三步法', whenToUse: '怀疑两个时段行为不一致时', steps: ['拉前后各半小时日志', '按事件类型分组', '只比对缺失和新增的事件'], runs: 5, updatedText: '昨天' }],
    rules: [{ id: 'ru1', text: '读服务器文件前先问主人。', redLine: false, scope: 'global' }],
    memoryExcerpt: '执行单依赖一个内部服务，它超时后任务不会重试。主人允许只读日志，不许改配置。',
    wakes: [
      { id: 'wk2', variant: 'regular', variantLabel: '常规', reasonKind: 'percept', reasonText: '变化：任务日志：依赖服务今天又超时了 1 次', score: 1.1, threshold: 0.6, status: 'running', outcome: null, outcomeLabel: null, summary: null, steps: 12, tokens: 41000, durationText: null, startedAt: NOW - 18 * 60_000, timeText: '18 分钟前' },
      { id: 'wk1', variant: 'regular', variantLabel: '常规', reasonKind: 'agenda_due', reasonText: '答应你的：周五前给的清单，还剩 2 小时', score: 0.8, threshold: 0.6, status: 'committed', outcome: 'progress', outcomeLabel: '有进展', summary: '定位到依赖服务超时，证据链已存', steps: 18, tokens: 52000, durationText: '14 分钟', startedAt: NOW - 6 * 60 * 60_000, timeText: '6 小时前' },
    ],
    appraisals: [
      { id: 'ap4', at: NOW - 18 * 60_000, timeText: '18 分钟前', decision: 'woke', decisionLabel: '已唤醒', suppressedBy: null, text: '依赖服务又超时，正是要抓的现场', score: 1.1, threshold: 0.6 },
      { id: 'ap3', at: NOW - 2 * 60 * 60_000, timeText: '2 小时前', decision: 'suppressed', decisionLabel: '被拦截', suppressedBy: 'concurrency', text: '想同时再开一轮，但已有回合在跑', score: 0.75, threshold: 0.6 },
      { id: 'ap2', at: NOW - 5 * 60 * 60_000, timeText: '5 小时前', decision: 'queued', decisionLabel: '已排队', suppressedBy: null, text: '例行比对可以先排着，让紧急的先走', score: 0.6, threshold: 0.6 },
      { id: 'ap1', at: NOW - 6 * 60 * 60_000, timeText: '6 小时前', decision: 'woke', decisionLabel: '已唤醒', suppressedBy: null, text: '承诺快到期：排查结论还剩 5 小时', score: 0.8, threshold: 0.6 },
    ],
    stats: { thinks7d: 9, intervalCv: 0.48, selfPacedRatio: 0.33, selfInitiated7d: 1, proposalAcceptRate: null, tokens7d: 231000 },
  }),
  'bot-zongguan': botView({
    card: fixtureOverview.bots[2]!,
    profile: {
      persona: '全局视角，擅长把复杂的事说成三句话。不打扰人，但 deadlines 从不漏。',
      autonomy: 'L1', autonomyLabel: 'L1 建议', pace: 'normal', paceLabel: '适中',
      model: null, modelText: '跟随宿主默认模型',
      createdAt: NOW - 17 * 24 * 60 * 60_000, homeDir: '~/AgentHub/bots/zongguan', sessionId: 'sess-zongguan-demo', createdText: '10-20', probationText: null, workDataAllowed: false,
    },
    aspirations: [{ id: 'asp1', text: '让全队的每次思考都花在刀刃上。', status: 'active' }],
    goals: [{ id: 'g1', title: '本月把全队的无变化思考占比降到 40% 以下', doneWhen: '统计口径下连续一周达标', period: 'month', periodText: '月', status: 'active', statusLabel: '进行中', lastProgressText: '本周 41%，接近达标', createdBy: 'bot' }],
    agenda: [
      { id: 'ag1', kind: 'review', kindLabel: '复查', title: '周五检查巡检频率提议是否被处理', dueText: '周五 09:00', priority: 2, toOwner: true, source: 'bot', status: 'open' },
      { id: 'ag2', kind: 'follow_up', kindLabel: '跟进', title: '跟进观潮的排查承诺（周五 18:00 截止）', dueText: '周五 18:00', priority: 1, toOwner: false, source: 'hub', status: 'open' },
    ],
    watches: [],
    routines: [{ id: 'r1', name: '日报三件套', whenToUse: '每天生成日报时', steps: ['挑最重要的三件事', '写清每件谁在管', '免打扰拦下的推送并入'], runs: 6, updatedText: '昨天' }],
    rules: [{ id: 'ru1', text: '收件箱里同一时间不超过 5 件，能合并的合并。', redLine: false, scope: 'bot' }],
    memoryExcerpt: '主人喜欢先看结论。巡检项最近一周全正常，所以提了降频的提议。',
    wakes: [
      { id: 'wk1', variant: 'regular', variantLabel: '常规', reasonKind: 'reflection', reasonText: '复盘：最近 7 天 21 次处理', score: 0.7, threshold: 0.6, status: 'committed', outcome: 'progress', outcomeLabel: '有进展', summary: '提出巡检降频提议', steps: 10, tokens: 15000, durationText: '8 分钟', startedAt: NOW - 26 * 60 * 60_000, timeText: '26 小时前' },
    ],
    appraisals: [
      { id: 'ap2', at: NOW - 26 * 60 * 60_000, timeText: '26 小时前', decision: 'woke', decisionLabel: '已唤醒', suppressedBy: null, text: '复盘时刻到了', score: 0.7, threshold: 0.6 },
      { id: 'ap1', at: NOW - 30 * 60 * 60_000, timeText: '昨天 14:20', decision: 'suppressed', decisionLabel: '被拦截', suppressedBy: 'waiting_owner_same_subject', text: '巡检频率的话题已经在等你回答，不再为同一件事叫醒', score: 0.65, threshold: 0.6 },
    ],
    stats: { thinks7d: 7, intervalCv: 0.35, selfPacedRatio: 0.29, selfInitiated7d: 1, proposalAcceptRate: null, tokens7d: 98000 },
  }),
}

// ---------- 设置与最近会话 ----------

export const fixtureSettings: SettingsView = {
  // 完整设置以 core 的默认表为底（c02/c03 细分参数与默认值表逐项一致），只改演示值。
  settings: resolveSettings({ quietHours: { start: '22:30', end: '08:00' }, digestAt: '08:30', pushChannel: 'dsh' }),
  pushChannelOptions: ['dsh', 'macos', 'none'],
  modelOptions: [
    { value: null, label: '跟随宿主默认模型' },
    { value: { provider: 'deepseek-official', model: 'deepseek-flash' }, label: 'deepseek-flash（快）' },
    { value: { provider: 'deepseek-official', model: 'deepseek-chat' }, label: 'deepseek-chat（均衡）' },
  ],
}

export const fixtureRecentSessions: RecentSessionView[] = [
  { sessionId: 'sess-owner-1', title: '排查收藏服务', updatedText: '昨天' },
  { sessionId: 'sess-owner-2', title: '写周报', updatedText: '2 天前' },
  { sessionId: 'sess-owner-3', title: '整理收藏夹', updatedText: '4 天前' },
]
