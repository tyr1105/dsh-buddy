/**
 * 账本服务层：开账、追加动作、封存、旧档回填与重启调和。
 *
 * 为什么需要服务层：纯函数只负责「给定事实算出一行」，真正读写存储、取当前时间、
 * 生成 id、备份旧文件这些副作用必须集中在一个地方。这样引擎各个写入点只调用
 * 一个语义明确的函数，不会各自拼装账本行，也不会漏掉封存。
 *
 * 所有时间来自注入的 Clock，所有随机 id 来自注入的 Rng；服务层不直接访问系统。
 */
import { join } from 'node:path';
import type { AppraisalLog, V2Config, WakeTicket } from '../model/index.js';
import type { LedgerAction, WakeLedgerEntry } from '../model/wake-ledger.js';
import type { ToolResult } from '../tools/types.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { V2_SCHEMA_VERSION } from '../model/v2-config.js';
import { formatDuration } from '../util/time.js';
import { describeAction } from '../util/action-text.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { buildBackfillEntry } from './backfill.js';
import { capLedgerEntry } from './caps.js';
import { buildOpenLedger, sealLedger, sealMissingWake } from './entry.js';
import { snapshotEvidence, type EvidenceCandidate } from './evidence.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** 统一写账本并通知界面；同一入口的重复通知由 Hub 自行合并。 */
function saveLedger(ctx: HubContext, entry: WakeLedgerEntry): WakeLedgerEntry {
  ctx.store.table('wakeLedger').put(entry);
  ctx.emit(HUB_EVENT_SCOPES.ledger, entry.botId);
  return entry;
}

/** 按 wakeId 找账本行；一个唤醒单最多一行。 */
export function findLedgerByWakeId(ctx: HubContext, wakeId: string): WakeLedgerEntry | null {
  return ctx.store.table('wakeLedger').list(row => row.wakeId === wakeId)[0] ?? null;
}

/**
 * 账本行 id 由唤醒单 id 派生，而不是再取一次随机数。
 * 一次唤醒最多一行账本，派生 id 天然满足 1:1；同时避免账本写入消耗全局随机序列，
 * 让额度、调度等既有子系统的可复现行为不因账本上线而改变（仿真场景依赖固定随机顺序）。
 */
function ledgerIdForWake(wakeId: string): string {
  return `wl_${wakeId.replace(/^w_/, '').slice(0, 10)}`;
}

/**
 * 确保 v2 配置单例存在。
 * firstRun 只在首次创建时为 true，服务层据此决定是否备份旧表；
 * 备份和回填失败都不会删掉这个标记，下次启动按 wakeId 幂等重试。
 */
export function ensureV2Config(ctx: HubContext, now = ctx.clock.now()): { config: V2Config; firstRun: boolean } {
  const existing = ctx.store.table('v2Config').get('v2');
  if (existing) return { config: existing, firstRun: false };
  const config: V2Config = {
    id: 'v2', schemaVersion: V2_SCHEMA_VERSION, backfillDoneThrough: null, createdAt: now, updatedAt: now,
  };
  ctx.store.table('v2Config').put(config);
  return { config, firstRun: true };
}

/**
 * 首次升级前备份 v1 源表。
 * 规格写的是 state/appraisals.json，但现有实现把评估日志按天写在 logs/appraisals/，
 * 所以两处都尝试复制：存在什么就备份什么，不存在就跳过。只读源文件，不碰凭据。
 */
export async function backupV1State(ctx: HubContext, now = ctx.clock.now()): Promise<string | null> {
  const root = ctx.settings.rootDir;
  const stateDir = join(root, '.hub', 'state');
  const target = join(root, '.hub', 'backup', `v1-${now}`);
  let copied = false;
  for (const name of ['wakes.json', 'commits.json', 'appraisals.json', 'bots.json', 'settings.json']) {
    const source = join(stateDir, name);
    if (await ctx.fs.stat(source)) {
      await ctx.fs.copy(source, join(target, 'state', name));
      copied = true;
    }
  }
  const logDir = join(root, '.hub', 'logs', 'appraisals');
  const logFiles = await ctx.fs.list(logDir);
  if (logFiles.length > 0) {
    await ctx.fs.mkdirp(join(target, 'logs', 'appraisals'));
    for (const name of logFiles) await ctx.fs.copy(join(logDir, name), join(target, 'logs', 'appraisals', name));
    copied = true;
  }
  return copied ? target : null;
}

/**
 * 整理某个机器人的证据候选池。
 * 顺序与唤醒包取证据的顺序一致（感知、线程、议程、志向、目标、收件箱、审批、停机），
 * 关注项额外加入，因为旧唤醒理由可能引用它。归属过滤在这里完成，纯函数不再碰存储。
 */
export function evidencePool(ctx: HubContext, botId: string): EvidenceCandidate[] {
  const items: EvidenceCandidate[] = [];
  for (const percept of ctx.store.table('percepts').list(row => row.botId === botId)) {
    items.push({
      kind: 'percept',
      refId: percept.id,
      // 审批结果会随时间变化，只能指回审批结果节，不能把历史状态当成现在。
      summary: percept.kind === 'approval_decided' ? '主人审批结果已有更新，当前状态见审批结果节' : percept.summary,
      occurredAt: percept.createdAt,
      trust: percept.untrusted ? 'untrusted' : 'trusted',
    });
  }
  for (const message of ctx.store.log('thread').all()) {
    if (message.thread !== botId && message.thread !== 'team') continue;
    items.push({
      kind: 'thread', refId: message.id, summary: message.text, occurredAt: message.createdAt,
      trust: ['owner', 'hub'].includes(message.from) ? 'trusted' : 'untrusted',
    });
  }
  for (const agenda of ctx.store.table('agenda').list(row => row.botId === botId)) {
    items.push({
      kind: 'agenda', refId: agenda.id, summary: `议程：${agenda.title}`, occurredAt: agenda.createdAt,
      trust: agenda.source === 'peer' ? 'untrusted' : 'trusted',
    });
  }
  for (const aspiration of ctx.store.table('aspirations').list(row => row.botId === botId)) {
    items.push({ kind: 'aspiration', refId: aspiration.id, summary: `志向：${aspiration.text}`, occurredAt: aspiration.createdAt, trust: 'trusted' });
  }
  for (const goal of ctx.store.table('goals').list(row => row.botId === botId)) {
    items.push({ kind: 'goal', refId: goal.id, summary: `目标：${goal.title}`, occurredAt: goal.createdAt, trust: 'trusted' });
  }
  for (const watch of ctx.store.table('watches').list(row => row.botId === botId)) {
    items.push({ kind: 'watch', refId: watch.id, summary: `关注项：${watch.target}`, occurredAt: watch.createdAt, trust: 'trusted' });
  }
  for (const inbox of ctx.store.table('inbox').list(row => row.botId === botId)) {
    items.push({
      kind: 'inbox', refId: inbox.id, summary: `你问过主人：${inbox.title} → 主人答：${inbox.answer ?? '尚未回答'}`,
      occurredAt: inbox.createdAt, trust: 'trusted',
    });
  }
  const approvalStatus: Record<string, string> = { pending: '待审批', approved: '已批准', rejected: '已拒绝', expired: '已过期', used: '已使用' };
  for (const approval of ctx.store.table('approvals').list(row => row.botId === botId)) {
    items.push({
      kind: 'approval', refId: approval.id, summary: `审批单：${approval.tool} ${approvalStatus[approval.status] ?? approval.status}`,
      occurredAt: approval.createdAt, trust: 'trusted',
    });
  }
  for (const downtime of ctx.store.table('downtime').list()) {
    items.push({
      kind: 'downtime', refId: downtime.id, summary: `停机：${formatDuration(downtime.to - downtime.from)}`,
      occurredAt: downtime.from, trust: 'trusted',
    });
  }
  return items;
}

/** 为一次唤醒开账；已有账本行时直接返回，避免重复开账。 */
export function openLedgerForWake(ctx: HubContext, wakeId: string, queueWaitMs: number | null): WakeLedgerEntry | null {
  const existing = findLedgerByWakeId(ctx, wakeId);
  if (existing) return existing;
  const wake = ctx.store.table('wakes').get(wakeId);
  if (!wake) return null;
  const now = ctx.clock.now();
  const entry = buildOpenLedger({
    id: ledgerIdForWake(wakeId),
    wake,
    queueWaitMs,
    evidence: snapshotEvidence(
      wake.reason.evidence,
      evidencePool(ctx, wake.botId),
      V2_DEFAULTS.LEDGER_EVIDENCE_MAX,
      V2_DEFAULTS.LEDGER_DETAIL_MAX_CHARS,
    ),
    now,
  });
  const capped = capLedgerEntry(entry).entry;
  return saveLedger(ctx, capped);
}

/**
 * 追加一条观察到的动作；已封存的行不可改。
 * 动作超过上限时保留最近的动作（slice(-max)）：主人关心「最后做了什么」，
 * 而不是最早做了什么；极端字节超限时截断层再从尾部丢弃。
 */
export function appendLedgerAction(ctx: HubContext, wakeId: string | null, action: LedgerAction): WakeLedgerEntry | null {
  if (!wakeId) return null;
  const entry = findLedgerByWakeId(ctx, wakeId);
  if (!entry || entry.sealedAt !== null) return null;
  const items = [...entry.actions.items, action];
  const next: WakeLedgerEntry = {
    ...entry,
    actions: { items: items.length > V2_DEFAULTS.LEDGER_ACTION_MAX ? items.slice(-V2_DEFAULTS.LEDGER_ACTION_MAX) : items },
  };
  const capped = capLedgerEntry(next).entry;
  return saveLedger(ctx, capped);
}

/**
 * 把一次 DSH 工具调用记为观察动作（F02 过程下钻）。
 * 只保存人话目标与结果摘要，不保存原始参数与完整输出：账本容量有限，
 * 而且参数里可能带凭据或大段文件内容。参数拿不到时目标写「未提供参数」，
 * 让主人知道这不是工具没执行，而是宿主没给。
 */
export function recordDshToolAction(
  ctx: HubContext,
  wakeId: string | null,
  input: { name: string; args?: unknown; isError: boolean; resultText: string; callId: string },
  durationMs: number | null = null,
): void {
  if (!wakeId) return;
  const entry = findLedgerByWakeId(ctx, wakeId);
  if (!entry || entry.sealedAt !== null) return;
  const hasArgs = input.args !== undefined && input.args !== null;
  let target = '（宿主未提供参数）';
  if (hasArgs) {
    try { target = describeAction(input.name, input.args, V2_DEFAULTS.LEDGER_DETAIL_MAX_CHARS); }
    catch { target = '（参数无法解析）'; }
  } else markPartial(ctx, entry);
  const detail = truncate(input.resultText.trim(), V2_DEFAULTS.LEDGER_DETAIL_MAX_CHARS) || (input.isError ? '工具返回失败，宿主未提供详情' : '成功');
  appendLedgerAction(ctx, wakeId, {
    kind: 'dsh_tool', name: input.name, target, outcome: input.isError ? 'error' : 'ok', source: 'observed',
    refId: input.callId || null, detail, durationMs,
  });
}

/** 参数缺失时把账本标成「不完整」，界面据此说明过程不是全量观察。 */
function markPartial(ctx: HubContext, entry: WakeLedgerEntry): void {
  // 已经因为别的段缺而不完整时仍要补上 actions；只按「动作段是否已标」去重。
  if (entry.missing.includes('actions')) return;
  const missing = [...entry.missing, 'actions' as const];
  const next = capLedgerEntry({ ...entry, completeness: 'partial', missing }).entry;
  ctx.store.table('wakeLedger').put(next);
  ctx.emit(HUB_EVENT_SCOPES.ledger, entry.botId);
}

/** 按字符截断，避免把超长工具输出写进账本。 */
function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

/** 把一次 hub_* 工具调用记为观察动作；工具结果只留一句摘要，不存完整输出。 */
export function recordToolAction(
  ctx: HubContext,
  wakeId: string | null,
  name: string,
  result: ToolResult,
  durationMs: number,
): void {
  appendLedgerAction(ctx, wakeId, {
    kind: 'hub_tool', name, target: null, outcome: result.ok ? 'ok' : 'error', source: 'observed',
    refId: null, detail: result.ok ? '成功' : result.error, durationMs: Math.max(0, Math.round(durationMs)),
  });
}

export interface SealOptions {
  /**
   * 允许在账本行不存在时补建。
   * 投递失败走 true（这是一次真实唤醒的失败）；回合结束与打断走 false，
   * 避免给「主人直聊」这种没有经历投递的回合凭空造账本。
   */
  createIfMissing?: boolean;
}

/**
 * 封存一次唤醒的账本；幂等，已封存行原样返回。
 * 唤醒单丢失时按「中心重启，未收到回合终态」记为 error。
 */
export function sealLedgerForWake(ctx: HubContext, wakeId: string, options: SealOptions = {}): WakeLedgerEntry | null {
  let entry = findLedgerByWakeId(ctx, wakeId);
  let wake: WakeTicket | null = ctx.store.table('wakes').get(wakeId);
  if (!entry && options.createIfMissing && wake) entry = openLedgerForWake(ctx, wakeId, null);
  if (!entry) return null;
  if (entry.sealedAt !== null) return entry;
  const now = ctx.clock.now();
  // 交账可能已经被清理；这时按没有交账封存，并在 missing 里说明。
  wake = ctx.store.table('wakes').get(wakeId);
  const commit = wake?.commitId ? ctx.store.table('commits').get(wake.commitId) : null;
  const sealed = wake ? sealLedger({ entry, wake, commit, now }) : sealMissingWake(entry, now);
  const capped = capLedgerEntry(sealed).entry;
  return saveLedger(ctx, capped);
}

/**
 * 重启调和：只处理「已经不可能再收到终态」的未封存行。
 * - 唤醒单已结束：按终态封存。
 * - 唤醒单不存在：封存为 error，原因写「中心重启，未收到回合终态」。
 * - 唤醒单仍在运行：不碰。宿主可能只是重建了 Hub 而会话仍在跑，
 *   原回合的结束事件之后仍会到达；提前判死会把一次真实唤醒写错。
 */
export function reconcileOpenLedgers(ctx: HubContext, now = ctx.clock.now()): number {
  let count = 0;
  for (const entry of ctx.store.table('wakeLedger').list(row => row.sealedAt === null)) {
    const wake = ctx.store.table('wakes').get(entry.wakeId);
    if (wake && wake.endedAt === null) continue;
    const commit = wake?.commitId ? ctx.store.table('commits').get(wake.commitId) : null;
    const sealed = wake ? sealLedger({ entry, wake, commit, now }) : sealMissingWake(entry, now);
    saveLedger(ctx, capLedgerEntry(sealed).entry);
    count += 1;
  }
  return count;
}

export interface BackfillSummary {
  scanned: number;
  written: number;
  skipped: number;
  missing: Record<string, number>;
  reconciled: number;
  backupDir: string | null;
}

/**
 * 旧档回填：扫描最近三十天已结束的唤醒单，把没有账本行的复制成回填行。
 * 幂等：按 wakeId 查重，第二次启动不会重复写入。备份与回填失败都不阻塞启动，
 * 由调用方记录日志并在下次启动重试。
 */
export async function runLedgerBackfill(ctx: HubContext, now = ctx.clock.now()): Promise<BackfillSummary> {
  const { firstRun } = ensureV2Config(ctx, now);
  let backupDir: string | null = null;
  if (firstRun) {
    try {
      backupDir = await backupV1State(ctx, now);
    } catch (error) {
      // 备份失败不阻止回填：回填只读旧表，不会改写它们。
      ctx.logger.warn('v2 首次启动备份旧表失败，继续回填', error);
    }
  }
  const cutoff = now - V2_DEFAULTS.LEDGER_BACKFILL_DAYS * DAY_MS;
  const wakes = ctx.store.table('wakes').list(row => row.endedAt !== null && row.endedAt >= cutoff && row.status !== 'delivering');
  const appraisals = ctx.store.log('appraisals').since(cutoff);
  const pools = new Map<string, EvidenceCandidate[]>();
  const missing: Record<string, number> = {};
  let written = 0;
  let skipped = 0;
  for (const wake of wakes) {
    if (findLedgerByWakeId(ctx, wake.id)) {
      skipped += 1;
      continue;
    }
    const commit = wake.commitId ? ctx.store.table('commits').get(wake.commitId) : null;
    let pool = pools.get(wake.botId);
    if (!pool) {
      pool = evidencePool(ctx, wake.botId);
      pools.set(wake.botId, pool);
    }
    const built = buildBackfillEntry({
      id: ledgerIdForWake(wake.id),
      wake,
      commit,
      appraisals: appraisals as AppraisalLog[],
      candidates: pool,
    });
    if (!built) {
      skipped += 1;
      continue;
    }
    const capped = capLedgerEntry(built).entry;
    saveLedger(ctx, capped);
    written += 1;
    for (const part of capped.missing) missing[part] = (missing[part] ?? 0) + 1;
  }
  // 调和放在回填之后：先补齐历史，再统一处理上次进程留下的未封存行。
  const reconciled = reconcileOpenLedgers(ctx, now);
  ctx.store.table('v2Config').patch('v2', { backfillDoneThrough: now, updatedAt: now });
  // 只有确实发生了回填、调和或首次备份时才写审计：空库首次启动不产生无意义记录，
  // 也避免平白消耗一次随机 id，扰动既有仿真场景的随机序列。
  if (wakes.length > 0 || reconciled > 0 || backupDir !== null) {
    writeOutreachAudit(ctx, 'ledger_backfill', { scanned: wakes.length, written, skipped, missing, reconciled, firstRun, backup: backupDir }, 'hub', now);
  }
  return { scanned: wakes.length, written, skipped, missing, reconciled, backupDir };
}
