/**
 * 样例办公室（D01 样例数据模式专用）：给 FixtureHub 提供一份与 fixtures.ts
 * 三个样例队友一致的房间，用于在沙箱里先看等距一屏的样子。
 *
 * 为什么单独成文件：办公室字段多、样例长，混进 fixtures.ts 会淹没其他样例；
 * 这里只做「纯数据摆位」，灯与桌面产出的口径以 core 的投影为准（正式运行时
 * 由 /api/agent-hub/office 返回）。编制取消后每个座位就是一位在岗队友，
 * 没有部门分组、空位与临时摆放。
 */
import type { InboxItemView, OfficeView, SeatView } from './views.js'

/** 样例基准时刻：文案与 asOf 都写死，避免每次刷新漂移。 */
const NOW = Date.UTC(2026, 10, 6, 14, 20)

/**
 * 门口样例条的标题与类型：标题必须与 fixtures.ts 里同 id 的收件箱条目完全一致
 * （同一个事项在两个页面不能出现两个标题），且不带「审批：/提议：」前缀——
 * 类型由界面上的类型 chip 承担，标题再带前缀就会显示成「审批 审批：……」。
 */
const DOOR_ITEM_META: Readonly<Record<string, { type: InboxItemView['type']; title: string }>> = {
  'inbox-a1': { type: 'approval', title: '写交接文件' },
  'inbox-q1': { type: 'question', title: '探路想读任务日志' },
  'inbox-p1': { type: 'proposal', title: '巡检频率改成每天 1 次' },
}

/** 造一个座位：座位必有队友，其余用一致的默认值补齐。 */
function seat(input: {
  botId: string
  title: string
  name: string
  roleLabel: string
  color: string
  activityLabel: string
  activityText: string
  light: SeatView['light']
  lightLabel: string
  deskTitle: string | null
  deskRef: string
  deskRefKind: 'artifact' | 'wake' | 'bot'
  deskRefId: string
  doorInboxIds: string[]
}): SeatView {
  const activity = input.light === 'working' ? 'thinking'
    : input.light === 'watching' ? 'watching'
      : input.light === 'waiting' ? 'waiting_owner'
        : 'resting'
  return {
    botId: input.botId,
    title: input.title,
    occupant: {
      botId: input.botId, name: input.name, role: 'researcher', roleLabel: input.roleLabel,
      color: input.color, initials: Array.from(input.name).slice(0, 2).join(''),
      lifecycle: 'active', lifecycleLabel: '在岗',
      activity: activity as never, activityLabel: input.activityLabel,
      activityText: input.activityText, updatedAt: NOW - 18 * 60_000,
    },
    light: input.light,
    lightLabel: input.lightLabel,
    lightRef: { botId: input.botId, activity: activity, updatedAt: NOW - 18 * 60_000, ref: `bot:${input.botId}` },
    desk: {
      kind: input.deskTitle === null ? 'none' : 'wake_output',
      kindLabel: input.deskTitle === null ? '桌上暂时没有产出' : '本次产出（自述）',
      title: input.deskTitle,
      ref: input.deskRef,
      refKind: input.deskRefKind,
      refId: input.deskRefId,
    },
    door: {
      count: input.doorInboxIds.length,
      items: input.doorInboxIds.map(id => ({
        inboxId: id,
        type: DOOR_ITEM_META[id]?.type ?? 'alert',
        title: DOOR_ITEM_META[id]?.title ?? id,
        ref: `inbox:${id}`,
      })),
      inboxIds: input.doorInboxIds,
      refs: input.doorInboxIds.map(id => `inbox:${id}`),
    },
    warnings: [],
    ref: `bot:${input.botId}`,
  }
}

const seats: SeatView[] = [
  seat({
    botId: 'bot-tanlu', title: '调研席', name: '探路', roleLabel: '调研',
    color: 'var(--dsw-alias-success)',
    activityLabel: '思考', activityText: '正在处理：数据日报没出（第 12/30 步）',
    light: 'working', lightLabel: '正在跑',
    deskTitle: '定位到依赖服务超时，证据链已存', deskRef: 'wake:wk1', deskRefKind: 'wake', deskRefId: 'wk1',
    doorInboxIds: ['inbox-a1', 'inbox-q1'],
  }),
  seat({
    botId: 'bot-xunjian', title: '盯守席', name: '巡检员', roleLabel: '盯守',
    color: 'var(--dsw-alias-accent)',
    activityLabel: '盯着', activityText: '在盯着：3 项 · 下次自查：有变化时，最晚周四 9:00',
    light: 'watching', lightLabel: '盯着',
    deskTitle: '新增行是正常归档，已记入日报', deskRef: 'wake:wk2', deskRefKind: 'wake', deskRefId: 'wk2',
    doorInboxIds: [],
  }),
  seat({
    botId: 'bot-zongguan', title: '总管席', name: '总管', roleLabel: '总管',
    color: 'var(--dsw-alias-warning)',
    activityLabel: '等主人', activityText: '等你：要不要把巡检频率改成每天 1 次？',
    light: 'waiting', lightLabel: '在等人',
    deskTitle: '提出巡检降频提议，等你拍板', deskRef: 'bot:bot-zongguan', deskRefKind: 'bot', deskRefId: 'bot-zongguan',
    doorInboxIds: ['inbox-p1'],
  }),
]

export const fixtureOffice: OfficeView = {
  asOf: NOW,
  seats,
  doorway: { count: 0, items: [], refs: [], ref: 'inbox' },
  // 额度灯文案以 core 的 QUOTA_LIGHT_LABELS 为准（green 是「充足」，不是「绿灯」），
  // 否则沙箱里看到的说法会和正式运行不一致。
  health: { quotaLight: 'green', quotaLightLabel: '充足', openAlerts: 0, sandboxOk: true, ok: true },
  truncated: false,
}
