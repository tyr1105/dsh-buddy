/** 最小 RSS 2.0 / Atom 读取器不展开实体或执行内容；已见条目只留短指纹，兼容 4 KB 的状态上限。 */
import type { HubContext } from '../engine/context.js';
import type { Percept, Watch } from '../model/perception.js';
import { fingerprint } from '../util/hash.js';
import { stripHtml } from '../util/text.js';
import { recordPercept } from './percept.js';
import { readWatchState, saveWatchState } from './watch-state.js';
import { markWatchSatisfied } from './satisfaction.js';
import { assertHttpWatchAccess } from './access.js';

export interface FeedItem { id: string; title: string; link: string }
/** 提取订阅条目的文本字段并清理标记，不执行 XML 外部实体。 */
function tagText(body: string, tag: string): string {
  const raw = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i').exec(body)?.[1] ?? '';
  return stripHtml(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}
/** 按条目身份去重解析 RSS 与 Atom，保留标题和链接供感知摘要。 */
export function parseFeed(xml: string): FeedItem[] {
  const result: FeedItem[] = [];
  const seen = new Set<string>();
  for(const match of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const body = match[2]!;
    const title = tagText(body, 'title');
    const link = tagText(body, 'link') || /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/i.exec(body)?.[1] || '';
    const id = tagText(body, 'guid') || tagText(body, 'id') || link || title;
    if(id && !seen.has(id)) {
      result.push({ id, title: title || id, link });
      seen.add(id);
    }
  }
  return result;
}
/** 比较有限的新条目集合，首次仅建基线以免把历史订阅误报成更新。 */
export async function pollRss(ctx: HubContext, watch: Watch, now: number): Promise<Percept | null> {
  assertHttpWatchAccess(ctx, watch);
  const response = await ctx.net.get(watch.target, { timeoutMs: ctx.settings.httpTimeoutMs, maxBytes: ctx.settings.httpMaxBytes });
  if(response.status < 200 || response.status >= 300) throw new Error(`订阅请求失败：HTTP ${response.status}`);
  if(!/<(?:rss|feed)\b/i.test(response.text)) throw new Error('订阅内容不是 RSS 或 Atom');
  // 只处理 feed 的前 200 条，防止超长历史列表把已见集合反复挤出并误报旧条目。
  const items = parseFeed(response.text).slice(0, ctx.settings.c02.rssSeenLimit);
  const oldIds = readWatchState(watch).seenIds ?? [];
  const known = new Set(oldIds);
  const newItems = items.filter(item => !known.has(fingerprint(item.id)));
  const allIds = [...new Set([...items.map(item => fingerprint(item.id)), ...oldIds])].slice(0, ctx.settings.c02.rssSeenLimit);
  let percept: Percept | null = null;
  if (watch.lastFingerprint !== null && newItems.length) markWatchSatisfied(ctx, watch.id, now);
  if(watch.lastFingerprint !== null && newItems.length) percept = recordPercept(ctx, {
    botId: watch.botId, watchId: watch.id, source: 'rss', kind: 'new_items', summary: newItems.map(item => item.title).join('\n'),
    location: watch.target, fingerprintMaterial: [watch.id, newItems.map(item => item.id).sort()],
    magnitude: Math.min(1, newItems.length / ctx.settings.c02.magnitudeItemCount), anomaly: false, untrusted: true, occurredAt: now,
  });
  saveWatchState(ctx, watch, { seenIds: allIds }, now, fingerprint(allIds));
  return percept;
}
