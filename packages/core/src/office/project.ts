/**
 * 办公室投影（纯函数）：把在岗队友、最近账本、未关闭收件箱投影成一屏房间。
 *
 * 为什么是投影而不是一张表：如果办公室自己存状态，就会和 bots.activity、
 * wakeLedger、inbox 形成第二事实源；两边一旦不一致，主人看到的就是「演」出来的房间。
 * 所以这里只读输入、不写任何东西，同样的输入永远得到同样的输出（now 由调用方显式带入）。
 *
 * 主人已取消编制（部门、席位、空岗、替补）：
 * - 座位不再是编制里的位置，而是「每个在岗队友一把椅子」，按上岗先后摆放；
 * - 没有部门分区、板凳和「尚未编制」提示，不再伪造任何组织层；
 * - 数据缺失或矛盾时灯是 unknown，绝不默认成「在跑」；
 * - 每个承载状态的节点都带 ref（座位、灯、桌子、门口），界面据此下钻。
 */
import type { Bot } from '../model/bot.js';
import type { InboxItem } from '../model/outreach.js';
import type { WakeLedgerEntry } from '../model/wake-ledger.js';
import type { Activity, Lifecycle, OfficeLight, QuotaLight, Role } from '../model/enums.js';
import {
  ACTIVITY_LABELS, LIFECYCLE_LABELS, OFFICE_LIGHT_LABELS, QUOTA_LIGHT_LABELS, ON_TEAM_LIFECYCLES, ROLE_LABELS,
} from '../model/enums.js';

/** 座位上的队友摘要：界面只需要这些字段，不再自己拼装文案。 */
export interface OfficeOccupantView {
  botId: string;
  name: string;
  role: Role;
  roleLabel: string;
  color: string;
  initials: string;
  lifecycle: Lifecycle;
  lifecycleLabel: string;
  /** 原始状态值；数据非法时为 null（灯会显示 unknown）。 */
  activity: Activity | null;
  activityLabel: string | null;
  activityText: string | null;
  updatedAt: number | null;
}

/** 桌上的东西：优先显示队友最近产物（第四期），没有产物再看最近一条已封存账本的自述。 */
export interface OfficeDeskView {
  kind: 'artifact' | 'wake_output' | 'none';
  kindLabel: string;
  title: string | null;
  /** 桌面节点引用：产物指向 artifact:<产物头 id>，账本指向 wake:<id>，空桌指向 bot:<id>。 */
  ref: string;
  refKind: 'artifact' | 'wake' | 'bot';
  refId: string;
}

/** 座位门口：该队友未关闭的收件箱项；count 与 refs 来自同一份列表。 */
export interface OfficeDoorView {
  count: number;
  /**
   * 门口逐条列出「需要你」的事（F04）：房间里必须看得见具体是哪件事，
   * 只给数字会让主人还得再去收件箱里对一遍。
   */
  items: Array<{ inboxId: string; type: InboxItem['type']; title: string; ref: string }>;
  /** 收件箱 id（界面用来打开对应卡片）。 */
  inboxIds: string[];
  /** 带前缀的稳定引用，便于统一做 ref 完整性测试。 */
  refs: string[];
}

/** 一个座位：在岗队友、灯、桌子、门口。 */
export interface SeatView {
  /** 座位上的队友 id。 */
  botId: string;
  title: string;
  occupant: OfficeOccupantView;
  light: OfficeLight;
  lightLabel: string;
  /** 灯指向 botId + activity + updatedAt。 */
  lightRef: { botId: string; activity: string; updatedAt: number; ref: string };
  desk: OfficeDeskView;
  door: OfficeDoorView;
  warnings: string[];
  /** 座位节点引用：bot:<id>。 */
  ref: string;
}

/** 房间门口的总信箱：团队级收件箱（botId=null）只放这里，不塞进某个座位。 */
export interface DoorwayView {
  count: number;
  items: Array<{ inboxId: string; type: InboxItem['type']; title: string; botId: string | null; ref: string }>;
  refs: string[];
  /** 门口节点引用；点它打开收件箱页。 */
  ref: string;
}

export interface OfficeHealthView {
  quotaLight: QuotaLight;
  quotaLightLabel: string;
  openAlerts: number;
  sandboxOk: boolean;
  /** 健康汇总：没有未恢复告警且沙箱可用。 */
  ok: boolean;
}

export interface OfficeView {
  asOf: number;
  /** 全部在岗队友的座位，按上岗先后排。 */
  seats: SeatView[];
  doorway: DoorwayView;
  health: OfficeHealthView;
  /** 账本是否因为只读最近 N 条而截断。 */
  truncated: boolean;
}

/**
 * 桌面产物只需要这几个字段：投影不读正文，避免把 artifactVersions 的大段内容带进办公室。
 * 服务层用 listFields 取字段，测试可以直接构造同样形状。
 */
export interface OfficeArtifactInput {
  id: string;
  artifactId: string;
  botId: string;
  number: number;
  title: string;
  createdAt: number;
}

export interface ProjectOfficeInput {
  now: number;
  bots: Bot[];
  /** 最近 N 条账本（服务层已按 openedAt 倒序截断）；本函数不关心总条数。 */
  ledgers: WakeLedgerEntry[];
  /** 队友的产物版本摘要（服务层已按保留期与主人可读性过滤）；每个队友取最新一版上桌。 */
  artifacts: OfficeArtifactInput[];
  /** 未关闭的收件箱项。 */
  inboxItems: InboxItem[];
  quotaLight: QuotaLight;
  openAlerts: number;
  sandboxOk: boolean;
  truncated: boolean;
}

/** 当前状态到灯的映射表（3.5 节）；表里没有的值一律 unknown，不猜。 */
const ACTIVITY_LIGHTS: Record<Activity, OfficeLight> = {
  thinking: 'working', catching_up: 'working',
  queued: 'queued',
  waiting_owner: 'waiting', waiting_peer: 'waiting',
  blocked: 'blocked',
  resting: 'resting', reflecting: 'resting',
  watching: 'watching',
};

/** 不在岗的生命周期：暂停、隔离、退役，以及还没上岗的草稿。 */
const OFF_DUTY_LIFECYCLES: readonly Lifecycle[] = ['draft', 'paused', 'quarantined', 'retired'];

/** 在岗口径与派活、资料判定一致：试岗与正式在岗都算在队里。 */
function isOnTeam(bot: Bot): boolean {
  return ON_TEAM_LIFECYCLES.includes(bot.lifecycle as typeof ON_TEAM_LIFECYCLES[number]);
}

/** 单个队员的灯：先看能否在岗，再看 activity；任何无法映射的值都是 unknown。 */
export function officeLightFor(bot: Bot | null): OfficeLight {
  if (bot === null) return 'vacant';
  if (OFF_DUTY_LIFECYCLES.includes(bot.lifecycle)) return 'offline';
  return ACTIVITY_LIGHTS[bot.activity as Activity] ?? 'unknown';
}

/** 把一条账本压成桌面标题：交账摘要优先，其次第一条世界变化；都没有就不算产出。 */
function deskTitleOf(entry: WakeLedgerEntry): string | null {
  const summary = entry.decision?.summary?.trim();
  if (summary) return summary;
  const change = entry.result.worldChanges[0]?.what?.trim();
  return change || null;
}

/** 按队友挑最近一条「有产出」的已封存账本；一次遍历，不逐 Bot 扫全表。 */
function buildDeskIndex(ledgers: WakeLedgerEntry[]): Map<string, WakeLedgerEntry> {
  const index = new Map<string, WakeLedgerEntry>();
  for (const entry of ledgers) {
    if (entry.sealedAt === null) continue;
    if (deskTitleOf(entry) === null) continue;
    const previous = index.get(entry.botId);
    if (previous === undefined || (previous.sealedAt ?? 0) < entry.sealedAt) index.set(entry.botId, entry);
  }
  return index;
}

/** 同一队友有多版产物时按创建时间、版本号、id 依次比较，保证同样输入得到同样的桌面。 */
function isNewerArtifact(candidate: OfficeArtifactInput, current: OfficeArtifactInput): boolean {
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt;
  if (candidate.number !== current.number) return candidate.number > current.number;
  return candidate.id > current.id;
}

/** 每位队友只留最新一版产物上桌；产物是第四期起桌面的第一优先级。 */
function buildArtifactIndex(artifacts: OfficeArtifactInput[]): Map<string, OfficeArtifactInput> {
  const index = new Map<string, OfficeArtifactInput>();
  for (const artifact of artifacts) {
    const previous = index.get(artifact.botId);
    if (previous === undefined || isNewerArtifact(artifact, previous)) index.set(artifact.botId, artifact);
  }
  return index;
}

/** 未关闭收件箱按队友分组，保持一次遍历；同一队友的顺序按创建时间新到旧。 */
function buildInboxIndex(items: InboxItem[]): Map<string, InboxItem[]> {
  const index = new Map<string, InboxItem[]>();
  for (const item of items) {
    if (item.status !== 'open' || item.botId === null) continue;
    const list = index.get(item.botId) ?? [];
    list.push(item);
    index.set(item.botId, list);
  }
  for (const list of index.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  return index;
}

function occupantOf(bot: Bot): OfficeOccupantView {
  return {
    botId: bot.id, name: bot.name, role: bot.role, roleLabel: ROLE_LABELS[bot.role], color: bot.color,
    initials: Array.from(bot.name).slice(0, 2).join(''),
    lifecycle: bot.lifecycle, lifecycleLabel: LIFECYCLE_LABELS[bot.lifecycle],
    activity: ACTIVITY_LABELS[bot.activity] === undefined ? null : bot.activity,
    activityLabel: ACTIVITY_LABELS[bot.activity] ?? null,
    activityText: bot.activityText, updatedAt: bot.updatedAt,
  };
}

/** 组装一个座位：灯、桌面、门口。 */
function buildSeat(input: {
  bot: Bot;
  deskIndex: Map<string, WakeLedgerEntry>;
  artifactIndex: Map<string, OfficeArtifactInput>;
  inboxIndex: Map<string, InboxItem[]>;
}): SeatView {
  const bot = input.bot;
  const light = officeLightFor(bot);
  // 桌面优先级（3.5 节）：最近产物 > 最近一条有产出的已封存账本 > 如实空着。
  const artifactEntry = input.artifactIndex.get(bot.id) ?? null;
  const artifactTitle = artifactEntry === null ? null : artifactEntry.title.trim() || null;
  const deskEntry = input.deskIndex.get(bot.id) ?? null;
  const wakeTitle = deskEntry === null ? null : deskTitleOf(deskEntry);
  // 没有产出的桌面仍是一个「如实空着」的状态节点，指向队友，界面不把它当可下钻的账本。
  const desk: OfficeDeskView = artifactTitle !== null && artifactEntry !== null
    ? {
      kind: 'artifact', kindLabel: '产物', title: artifactTitle,
      ref: `artifact:${artifactEntry.artifactId}`, refKind: 'artifact', refId: artifactEntry.artifactId,
    }
    : wakeTitle !== null && deskEntry !== null
      ? {
        kind: 'wake_output', kindLabel: '本次产出（自述）', title: wakeTitle,
        ref: `wake:${deskEntry.wakeId}`, refKind: 'wake', refId: deskEntry.wakeId,
      }
      : {
        kind: 'none', kindLabel: '桌上暂时没有产出', title: null,
        ref: `bot:${bot.id}`, refKind: 'bot', refId: bot.id,
      };
  const doorItems = input.inboxIndex.get(bot.id) ?? [];
  return {
    botId: bot.id,
    title: `${bot.name}的座位`,
    occupant: occupantOf(bot),
    light,
    lightLabel: OFFICE_LIGHT_LABELS[light],
    lightRef: { botId: bot.id, activity: String(bot.activity), updatedAt: bot.updatedAt, ref: `bot:${bot.id}` },
    desk,
    door: {
      count: doorItems.length,
      items: doorItems.map(item => ({
        inboxId: item.id, type: item.type, title: item.title, ref: `inbox:${item.id}`,
      })),
      inboxIds: doorItems.map(item => item.id),
      refs: doorItems.map(item => `inbox:${item.id}`),
    },
    warnings: [],
    ref: `bot:${bot.id}`,
  };
}

/** 团队级收件箱放房间门口；顺序按创建时间新到旧，数字与列表同源。 */
function buildDoorway(items: InboxItem[]): DoorwayView {
  const teamItems = items
    .filter(item => item.status === 'open' && item.botId === null)
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    count: teamItems.length,
    items: teamItems.map(item => ({
      inboxId: item.id, type: item.type, title: item.title, botId: item.botId, ref: `inbox:${item.id}`,
    })),
    refs: teamItems.map(item => `inbox:${item.id}`),
    ref: 'inbox',
  };
}

/** 投影入口：每个在岗队友一把椅子，按上岗先后摆放；没有在岗队友时房间如实空着。 */
export function projectOffice(input: ProjectOfficeInput): OfficeView {
  const deskIndex = buildDeskIndex(input.ledgers);
  const artifactIndex = buildArtifactIndex(input.artifacts);
  const inboxIndex = buildInboxIndex(input.inboxItems);
  const health: OfficeHealthView = {
    quotaLight: input.quotaLight,
    quotaLightLabel: QUOTA_LIGHT_LABELS[input.quotaLight],
    openAlerts: input.openAlerts,
    sandboxOk: input.sandboxOk,
    ok: input.openAlerts === 0 && input.sandboxOk,
  };
  const seats = input.bots
    .filter(isOnTeam)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map(bot => buildSeat({ bot, deskIndex, artifactIndex, inboxIndex }));
  return {
    asOf: input.now, seats, doorway: buildDoorway(input.inboxItems), health, truncated: input.truncated,
  };
}
