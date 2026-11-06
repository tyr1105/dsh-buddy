/** 网页轮询只读文本并比较摘要指纹；首次建立基线，不把已有内容误当成新变化。 */
import type { HubContext } from '../engine/context.js';
import type { Percept, Watch } from '../model/perception.js';
import { sha1Hex, fingerprint } from '../util/hash.js';
import { stripHtml } from '../util/text.js';
import { recordPercept } from './percept.js';
import { readWatchState, saveWatchState } from './watch-state.js';
import { markWatchSatisfied } from './satisfaction.js';
import { assertHttpWatchAccess } from './access.js';

/** 保留原有换行和常见块元素边界，再逐行清理 HTML，使按行差异仍有意义。 */
export function readableHttpText(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<\/?(?:p|div|li|h[1-6]|br|tr)\b[^>]*>/gi, '\n').split(/\r?\n/).map(stripHtml).filter(Boolean).join('\n');
}
/** 读取网页并比较清理后的指纹，首次只建基线、变化时保留新增行证据。 */
export async function pollHttp(ctx: HubContext, watch: Watch, now: number): Promise<Percept | null> {
  assertHttpWatchAccess(ctx, watch);
  const response = await ctx.net.get(watch.target, { timeoutMs: ctx.settings.httpTimeoutMs, maxBytes: ctx.settings.httpMaxBytes });
  if (response.status < 200 || response.status >= 300) throw new Error(`网页请求失败：HTTP ${response.status}`);
  const text = readableHttpText(response.text);
  const hash = sha1Hex(text);
  const prior = readWatchState(watch);
  const lines = text ? text.split('\n') : [];
  const lineHashes = lines.slice(0, ctx.settings.c02.httpLineHashLimit).map(line => fingerprint(line));
  let percept: Percept | null = null;
  if (watch.lastFingerprint !== null && watch.lastFingerprint !== hash && prior.lineHashes !== undefined) {
    // 只比较双方都保存的前缀范围；200 行外不把未保存的旧行虚报成新增行。
    const compared = (prior.totalLines ?? prior.lineHashes.length) <= prior.lineHashes.length
      ? ctx.settings.c02.httpLineHashLimit : prior.lineHashes.length;
    const current = lines.slice(0, compared);
    const oldHashes = new Set(prior.lineHashes);
    const newHashes = new Set(current.map(line => fingerprint(line)));
    const added = current.filter(line => !oldHashes.has(fingerprint(line)));
    const removed = [...oldHashes].filter(value => !newHashes.has(value));
    const changed = new Set(added.map(line => fingerprint(line))).size + removed.length;
    // 整页哈希确认变化但变化在采样范围外时，至少按一处未知变化估算，绝不夸大为整段新增。
    const magnitude = Math.min(1, Math.max(changed, Math.abs(lines.length - (prior.totalLines ?? 0)), 1) / Math.max(lines.length, prior.totalLines ?? 0, 1));
    markWatchSatisfied(ctx, watch.id, now);
    percept = recordPercept(ctx, { botId: watch.botId, watchId: watch.id, source: 'http', kind: 'changed',
      summary: added.slice(0, ctx.settings.c02.httpSummaryLines).join('\n') || (removed.length ? '网页内容有删除' : '网页内容有变化，变化位于已保存的行哈希范围之外'), location: watch.target,
      fingerprintMaterial: [watch.id, hash], magnitude, anomaly: false, untrusted: true, occurredAt: now });
  }
  saveWatchState(ctx, watch, { lineHashes, totalLines: lines.length }, now, hash);
  return percept;
}
