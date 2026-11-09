/**
 * 样例账本：只服务 D01/F05 沙箱（FixtureHub）。
 *
 * 为什么单独成文件：账本详情字段多、样例长，混进 fixtures.ts 会淹没其他样例；
 * 这里用三条记录覆盖界面必须区分的三种形态——
 * 1. 实时、完整、已交账；
 * 2. 实时、进行中（还没封存）；
 * 3. 旧档回填、不完整、缺少动作段。
 * 文案与 core 的翻译保持一致，但标签在客户端本地抄一份，不引 core 运行时。
 */
import type { WakeLedgerEntry, WakeLedgerRow, WakeLedgerView } from './views.js'

const MIN = 60_000
const HOUR = 60 * MIN
/** 固定基准时刻：样例文案与相对时间都是写死的，不依赖运行时时钟。 */
const NOW = Date.UTC(2026, 10, 6, 14, 20)

const STATUS_TEXT: Record<WakeLedgerEntry['status'], string> = {
  delivering: '投递中', running: '运行中', committed: '已交账', no_commit: '未交账',
  error: '出错', canceled: '取消', timeout: '超时',
}
const SOURCE_TEXT: Record<WakeLedgerEntry['source'], string> = { live: '实时', backfill: '回填' }
const COMPLETENESS_TEXT: Record<WakeLedgerEntry['completeness'], string> = { full: '完整', partial: '不完整' }
const MISSING_TEXT: Record<WakeLedgerEntry['missing'][number], string> = {
  trigger: '触发理由', evidence: '证据', actions: '动作', commit: '交账', result: '结果',
}
const EVIDENCE_TEXT: Record<WakeLedgerEntry['evidence']['items'][number]['kind'], string> = {
  percept: '感知', thread: '线程', agenda: '议程', aspiration: '志向', goal: '目标',
  watch: '关注项', inbox: '收件箱', approval: '审批', downtime: '停机', unknown: '未知',
}
const TRUST_TEXT: Record<WakeLedgerEntry['evidence']['items'][number]['trust'], string> = {
  trusted: '可信', untrusted: '外部内容', unknown: '未知',
}
const ACTION_KIND_TEXT: Record<WakeLedgerEntry['actions']['items'][number]['kind'], string> = {
  hub_tool: '中心工具', outbox: '出站提交', host_command: '宿主命令', dsh_tool: 'DSH 工具',
}
const WAKE_KIND_TEXT: Record<WakeLedgerEntry['trigger']['kind'], string> = {
  percept: '感知', pile: '待处理堆', agenda_due: '议程到期', drive: '内驱', owner_message: '主人消息',
  peer_message: '同伴消息', inbox_reply: '收件箱回复', approval_decided: '审批结果', next_think: '下次思考',
  light_check: '轻复查', reflection: '复盘', catch_up: '补课', trial: '试跑', teach: '教学', retry: '重试',
}
const VARIANT_TEXT: Record<WakeLedgerEntry['variant'], string> = {
  regular: '常规', light_check: '轻复查', reflection: '复盘', catch_up: '补课', trial: '试跑', teach: '教学',
}
const OUTCOME_TEXT: Record<string, string> = {
  no_change: '无变化', progress: '有进展', done: '已完成', blocked: '受阻', needs_owner: '需要主人',
}

interface Sample {
  botName: string
  botColor: string
  openedText: string
  sealedText: string | null
  entry: WakeLedgerEntry
}

/** 把一条样例账本翻成界面直接渲染的摘要 + 详情。 */
function viewOf(sample: Sample): WakeLedgerView {
  const { entry } = sample
  const row: WakeLedgerRow = {
    id: entry.id, wakeId: entry.wakeId, botId: entry.botId, botName: sample.botName, botColor: sample.botColor,
    variant: entry.variant, variantLabel: VARIANT_TEXT[entry.variant],
    status: entry.status, statusLabel: STATUS_TEXT[entry.status],
    source: entry.source, sourceLabel: SOURCE_TEXT[entry.source],
    completeness: entry.completeness, completenessLabel: COMPLETENESS_TEXT[entry.completeness],
    triggerKind: entry.trigger.kind, triggerKindLabel: WAKE_KIND_TEXT[entry.trigger.kind],
    triggerText: entry.trigger.ownerSummary ?? entry.trigger.summary,
    triggerScore: entry.trigger.score, triggerThreshold: entry.trigger.threshold,
    outcome: entry.decision?.outcome ?? null,
    outcomeLabel: entry.decision?.outcome ? OUTCOME_TEXT[entry.decision.outcome] ?? null : null,
    summary: entry.decision?.summary ?? entry.result.summary,
    openedAt: entry.openedAt, openedText: sample.openedText,
    sealedAt: entry.sealedAt, sealedText: sample.sealedText,
    steps: entry.steps, tokens: entry.tokens,
    actionCount: entry.actions.items.length, evidenceCount: entry.evidence.items.length,
    truncated: entry.truncated,
    hasMissing: entry.missing.length > 0,
    missingLabels: entry.missing.map(part => MISSING_TEXT[part]),
  }
  return {
    entry,
    row,
    evidence: entry.evidence.items.map(item => ({
      ...item, kindLabel: EVIDENCE_TEXT[item.kind], trustLabel: TRUST_TEXT[item.trust], occurredText: null,
    })),
    actions: entry.actions.items.map(action => ({
      ...action, kindLabel: ACTION_KIND_TEXT[action.kind],
      outcomeLabel: action.outcome === 'ok' ? '成功' : '失败',
      sourceLabel: action.source === 'observed' ? '中心观察到' : '机器人自述',
    })),
    verificationLabel: entry.result.verification ? '机器人验证' : null,
    worldChanges: entry.result.worldChanges.map(change => ({
      ...change, visibilityLabel: change.whoCanSee === 'owner' ? '主人可见' : change.whoCanSee === 'only_me' ? '仅自己' : '他人可见',
    })),
    missingLabels: entry.missing.map(part => MISSING_TEXT[part]),
  }
}

/** 巡检机器人：一次完整的实时唤醒（读文件 → 对比规则 → 交账）。 */
const xunjian: Sample = {
  botName: '巡检', botColor: '#5b8def', openedText: '昨天 14:20', sealedText: '昨天 14:26',
  entry: {
    id: 'wl_wk2', wakeId: 'wk2', botId: 'bot-xunjian', sessionId: 'sess-xunjian-demo',
    variant: 'regular', status: 'committed', source: 'live', completeness: 'full', missing: [],
    openedAt: NOW - 12 * HOUR, sealedAt: NOW - 12 * HOUR + 6 * MIN,
    trigger: {
      kind: 'percept', score: 0.9, threshold: 0.6,
      summary: '运行记录新增 1 行，判断是否正常归档',
      ownerSummary: '收藏服务运行记录新增 1 行（1495/1495）',
      ownerInitiated: false, subjectKey: 'collect:run.log', queueWaitMs: 1200, evidenceRefs: ['p_run_1495'],
    },
    evidence: {
      items: [{
        kind: 'percept', refId: 'p_run_1495', summary: '运行记录新增 1 行：1495/1495，格式与上一行一致',
        occurredAt: NOW - 12 * HOUR - 2 * MIN, trust: 'untrusted',
      }],
    },
    decision: {
      outcome: 'progress', summary: '新增行是正常归档，已记入日报；按规矩不打扰主人',
      blocker: null, nextThink: null, ownerQuestion: null, report: null, importance: 3,
    },
    actions: {
      items: [
        { kind: 'hub_tool', name: 'hub_state_get', target: null, outcome: 'ok', source: 'observed', refId: null, detail: '读取关注项与最近一次运行记录', durationMs: 240 },
        { kind: 'hub_tool', name: 'hub_watch_get', target: '~/services/collect/run.log', outcome: 'ok', source: 'observed', refId: 'w1', detail: '确认期望是「每小时归档 1 行」', durationMs: 180 },
        { kind: 'hub_tool', name: 'hub_commit', target: null, outcome: 'ok', source: 'observed', refId: 'cm_wk2', detail: '交账：无变化之外的正常进展', durationMs: 120 },
      ],
    },
    result: {
      verification: { level: 'agent', notCovered: '没有真的去服务端核对归档任务，只比对了日志文本' },
      worldChanges: [{ what: '把这次归档行写进当日日报', whoCanSee: 'owner', where: '日报' }],
      refs: ['cm_wk2'], summary: '新增行正常，已记入日报',
    },
    steps: 8, tokens: 9400, truncated: false, bytes: 2680,
  },
}

/** 探路：一次仍在进行中的唤醒（有观察到的动作，还没交账）。 */
const tanluRunning: Sample = {
  botName: '探路', botColor: '#e08a3c', openedText: '18 分钟前', sealedText: null,
  entry: {
    id: 'wl_gc_wk2', wakeId: 'wk2', botId: 'bot-tanlu', sessionId: 'sess-tanlu-demo',
    variant: 'regular', status: 'running', source: 'live', completeness: 'full', missing: [],
    openedAt: NOW - 18 * MIN, sealedAt: null,
    trigger: {
      kind: 'percept', score: 1.1, threshold: 0.6,
      summary: '任务日志出现依赖服务超时，正是要抓的现场',
      ownerSummary: '任务日志：依赖服务今天又超时了 1 次',
      ownerInitiated: false, subjectKey: 'dispatch:timeout', queueWaitMs: 400, evidenceRefs: ['p_dispatch_timeout'],
    },
    evidence: {
      items: [{
        kind: 'percept', refId: 'p_dispatch_timeout', summary: 'job.log 新增一行：依赖服务 03:30 超时，任务未重试',
        occurredAt: NOW - 20 * MIN, trust: 'untrusted',
      }],
    },
    decision: null,
    actions: {
      items: [
        { kind: 'hub_tool', name: 'hub_state_get', target: null, outcome: 'ok', source: 'observed', refId: null, detail: '读取目标、关注项和上次结论', durationMs: 300 },
        { kind: 'hub_tool', name: 'hub_memory_read', target: null, outcome: 'ok', source: 'observed', refId: null, detail: '读取排查笔记：上次已定位到依赖服务超时', durationMs: 260 },
      ],
    },
    result: { verification: null, worldChanges: [], refs: [], summary: null },
    steps: 12, tokens: 41000, truncated: false, bytes: 2210,
  },
}

/** 探路：一条旧档回填的唤醒（只有触发、证据与交账，没有动作流水）。 */
const tanluBackfill: Sample = {
  botName: '探路', botColor: '#e08a3c', openedText: '6 小时前', sealedText: '6 小时前',
  entry: {
    id: 'wl_gc_wk1', wakeId: 'wk1', botId: 'bot-tanlu', sessionId: null,
    variant: 'regular', status: 'committed', source: 'backfill', completeness: 'partial', missing: ['actions'],
    openedAt: NOW - 6 * HOUR, sealedAt: NOW - 6 * HOUR + 14 * MIN,
    trigger: {
      kind: 'agenda_due', score: 0.8, threshold: 0.6,
      summary: '答应主人周五前给排查结论，还剩 2 小时',
      ownerSummary: '承诺快到期：排查结论还剩 2 小时',
      ownerInitiated: false, subjectKey: 'promise:dispatch-report', queueWaitMs: null, evidenceRefs: ['ag_dispatch_report'],
    },
    evidence: {
      items: [{
        kind: 'agenda', refId: 'ag_dispatch_report', summary: '承诺：周五前给主人一份排查结论',
        occurredAt: NOW - 8 * HOUR, trust: 'trusted',
      }],
    },
    decision: {
      outcome: 'progress', summary: '定位到依赖服务超时，证据链已存',
      blocker: null, nextThink: null, ownerQuestion: null, report: null, importance: 6,
    },
    actions: { items: [] },
    result: {
      verification: null, worldChanges: [], refs: [],
      summary: '定位到依赖服务超时，证据链已存',
    },
    steps: 18, tokens: 52000, truncated: false, bytes: 1730,
  },
}

const samples: Sample[] = [xunjian, tanluRunning, tanluBackfill]
const byBot = new Map<string, WakeLedgerView[]>()
for (const sample of samples) {
  const list = byBot.get(sample.entry.botId) ?? []
  list.push(viewOf(sample))
  byBot.set(sample.entry.botId, list)
}

/** 按机器人返回样例账本摘要；按封存时间倒序，未封存排最前。 */
export function fixtureLedgerRows(botId: string): WakeLedgerRow[] {
  return [...(byBot.get(botId) ?? [])]
    .sort((a, b) => (b.row.sealedAt ?? b.row.openedAt) - (a.row.sealedAt ?? a.row.openedAt))
    .map(view => view.row)
}

/** 按唤醒单 id 返回样例账本详情；没有账本时返回 null。 */
export function fixtureLedgerDetail(wakeId: string): WakeLedgerView | null {
  const sample = samples.find(item => item.entry.wakeId === wakeId)
  return sample ? viewOf(sample) : null
}
