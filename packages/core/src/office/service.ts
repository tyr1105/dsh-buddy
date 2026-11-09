/**
 * 办公室服务：从存储里取投影需要的六样事实，交给纯函数 projectOffice。
 *
 * 为什么只读最近 N 条账本：账本保留 90 天，办公室只关心「桌上最近产出了什么」；
 * 读全表会让投影随账本增长越来越慢（3.5 节性能要求）。取够 N 条就停。
 * 本文件不写审计、不改任何状态，界面刷新只是重新投影。
 */
import type { HubContext } from '../engine/context.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { getQuotaState } from '../quota/window.js';
import { projectOffice, type OfficeArtifactInput, type OfficeView } from './project.js';
import type { WakeLedgerEntry } from '../model/wake-ledger.js';
// 账本不变时重用最近段；办公室每个收口都观察，但无须每次复制整张多年账本。
const ledgerIndexes = new WeakMap<HubContext, { revision: number; total: number; recent: WakeLedgerEntry[] }>();

/**
 * 桌面产物摘要：只取投影要用的字段（绝不复制正文），并过滤掉保留期外与
 * 「只有队友自己可看」的版本——后者主人点开也读不到，放上桌只会造出坏链接。
 */
function recentArtifacts(ctx: HubContext, now: number): OfficeArtifactInput[] {
  const cutoff = now - ctx.settings.retentionMsByCollection.artifactVersions;
  return ctx.store.table('artifactVersions')
    .listFields(['id', 'artifactId', 'botId', 'number', 'title', 'createdAt', 'visibility'])
    .filter(row => row.createdAt >= cutoff && row.visibility !== 'only_me');
}

/** 读取当前办公室全貌；没有在岗队友时房间如实空着。 */
export function officeView(ctx: HubContext): OfficeView {
  const now = ctx.clock.now();
  const limit = V2_DEFAULTS.OFFICE_RECENT_LEDGER;
  const table = ctx.store.table('wakeLedger');
  const revision = table.revision();
  let index = ledgerIndexes.get(ctx);
  // 最近 N 条按开账时间倒序；同毫秒用 id 倒序保证投影结果稳定（同样的输入同样的输出）。
  if (!index || index.revision !== revision) {
    const rows = table.listFields(['id', 'openedAt'])
      .sort((a, b) => b.openedAt - a.openedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    index = { revision, total: rows.length, recent: rows.slice(0, limit).flatMap(row => {
      const entry = table.get(row.id);
      return entry ? [entry] : [];
    }) };
    ledgerIndexes.set(ctx, index);
  }
  const quota = getQuotaState(ctx, now);
  return projectOffice({
    now,
    bots: ctx.store.table('bots').list(),
    ledgers: index.recent,
    artifacts: recentArtifacts(ctx, now),
    inboxItems: ctx.store.table('inbox').list(row => row.status === 'open'),
    quotaLight: quota.light,
    openAlerts: ctx.store.table('alerts').count(row => row.status === 'open'),
    sandboxOk: ctx.runtime.sandboxUnavailable === null,
    // 超过读取上限时明确告知「只看了最近 N 条」，不假装读全了。
    truncated: index.total > limit,
  });
}
