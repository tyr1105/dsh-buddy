/** 文件监听只累计事件；单文件监听父目录以抵御原子替换，tick 补扫弥补漏掉的系统事件。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { HubContext, HubRuntime } from '../engine/context.js';
import type { Percept, Watch } from '../model/perception.js';
import { fingerprint } from '../util/hash.js';
import { truncateBytes } from '../util/text.js';
import { recordPercept } from './percept.js';
import { recordWatchError } from './poll.js';
import { readWatchState, saveWatchState } from './watch-state.js';
import { fileBaselinePath, readFileBaseline, saveFileBaseline, snapshotFiles, type FileBaseline } from './file-baseline.js';
import { markWatchSatisfied } from './satisfaction.js';
import { classifyPath } from '../gate/paths.js';
import { writeOutreachAudit } from '../outreach/audit.js';

interface WatchTarget { path: string; extension: string | null }
interface Registration { signature: string; single: boolean; statKey: string }
// 绑定 runtime 而非 ctx 包装，复制依赖上下文不会重新注册监听或丢掉待处理事件。
const registrations = new WeakMap<HubRuntime, Map<string, Registration>>();
const synchronizing = new WeakMap<HubRuntime, Promise<void>>();

/** 一期只支持目录末尾 *.扩展名；其他通配符明确拒绝，避免悄悄监听错误范围。 */
export function parseFileTarget(target: string): WatchTarget {
  if (!isAbsolute(target)) throw new Error('文件关注路径必须是绝对路径');
  if (!/[*?\[\]{}]/.test(target)) return { path: normalize(target), extension: null };
  const match = /^(.*)\/\*\.([^/*?\[\]{}]+)$/.exec(target);
  if (!match || /[*?\[\]{}]/.test(match[1]!)) throw new Error('文件关注只支持目录末尾的 *.扩展名 通配符');
  return { path: normalize(match[1] || '/'), extension: `.${match[2]}` };
}
/** 每次读取都复核授权，并排除中心自己的基线目录，避免保存基线触发无限自循环。 */
function canReadPath(ctx: HubContext, watch: Watch, path: string): boolean {
  const baselineDir = dirname(fileBaselinePath(ctx, watch.id));
  if (path === baselineDir || path.startsWith(`${baselineDir}/`)) return false;
  const bot = ctx.store.table('bots').get(watch.botId);
  if (!bot || ctx.store.table('watches').get(watch.id)?.status !== 'active') return false;
  // 一次分类已同时判断敏感与工作数据；复用刚读到的机器人，避免每次 stat 前后重复克隆和解析。
  const action = classifyPath(path, false, { homeDir: bot.homeDir, cwd: bot.homeDir, ownerHome: ctx.ownerHome,
    sharedDir: join(ctx.settings.rootDir, 'shared'), rootDir: ctx.settings.rootDir,
    workDataAllowed: bot.workDataAllowed, workDataPaths: ctx.settings.workDataPaths });
  return action.cls !== 'protected' && action.subclass !== 'work_data';
}
/** 撤销权限时暂停精确命中的关注，取消监听和待处理批次。 */
function suspendDeniedWatches(ctx: HubContext): void {
  for (const watch of ctx.store.table('watches').list(row => row.status === 'active' && ['file', 'log'].includes(row.kind))) {
    if (canReadPath(ctx, watch, watch.target)) continue;
    ctx.store.table('watches').patch(watch.id, { status: 'paused', updatedAt: ctx.clock.now() });
    try { ctx.runtime.watchDisposers.get(watch.id)?.(); } catch (error) { ctx.logger.warn('撤销权限时取消文件关注失败', error); }
    ctx.runtime.watchDisposers.delete(watch.id);
    ctx.runtime.pendingFileEvents.delete(watch.id);
    writeOutreachAudit(ctx, 'watch_permission_revoked', { watchId: watch.id, text: '读取涉及敏感路径或未授权工作数据，关注项已暂停' }, 'hub');
    ctx.emit(HUB_EVENT_SCOPES.bot, watch.botId);
  }
}
/** mtime、inode 和大小一起识别路径当前指向的文件；删除也有独立状态。 */
const statKey = (info: { size: number; mtimeMs: number; inode?: number } | null | undefined): string => info ? JSON.stringify([info.size, info.mtimeMs, info.inode]) : 'missing';

/** 系统 mtime 可能带小数；事件模型使用整数毫秒，向下取整且不晚于发现时刻，基线仍保留原精度。 */
const fileOccurredAt = (mtimeMs: number | undefined, now: number): number => Math.min(Math.floor(mtimeMs ?? now), now);

/** 异步补扫与监听事件共用合批入口，后来的事件只扩展批次，不重置去抖起点。 */
function addPending(ctx: HubContext, watchId: string, paths: Iterable<string>, kind: string, now: number): void {
  const pending = ctx.runtime.pendingFileEvents.get(watchId) ?? { firstAt: now, lastAt: now, paths: new Set<string>(), kinds: new Set<string>() };
  pending.firstAt = Math.min(now, pending.firstAt);
  pending.lastAt = Math.max(now, pending.lastAt);
  for (const path of paths) pending.paths.add(path);
  pending.kinds.add(kind);
  ctx.runtime.pendingFileEvents.set(watchId, pending);
}
/** 对完整基线逐文件比较；超量基线只比较数量，绝不将缺失明细当成新文件。 */
function changedPaths(old: FileBaseline, current: FileBaseline, target: string): string[] {
  if (old.overflow || current.overflow) return old.count === current.count ? [] : [target];
  const paths = new Set([...Object.keys(old.entries), ...Object.keys(current.entries)]);
  // 升级前的 sizes 可能已被 4 KB 上限截掉：未知路径只有 mtime 晚于旧检查时刻才算新变化。
  if (old.legacyAt !== undefined) return [...paths].filter(path => {
    const before = old.entries[path]; const after = current.entries[path];
    return (!after && before !== undefined) || (after !== undefined && (after.mtimeMs > old.legacyAt! || (before !== undefined && before.size !== after.size)));
  });
  return [...paths].filter(path => statKey(old.entries[path]) !== statKey(current.entries[path]));
}
/** 在第一个异步读取前取得 runtime 锁，重叠调用共用结果，不会泄漏第二个监听器。 */
export async function syncFileWatches(ctx: HubContext): Promise<void> {
  const running = synchronizing.get(ctx.runtime);
  if (running) return running;
  const operation = syncUnlocked(ctx);
  synchronizing.set(ctx.runtime, operation);
  try { await operation; } finally { synchronizing.delete(ctx.runtime); }
}
/** 同步有效关注、恢复离线基线，并对已有单文件监听做廉价 stat 补扫。 */
async function syncUnlocked(ctx: HubContext): Promise<void> {
  suspendDeniedWatches(ctx);
  const active = ctx.store.table('watches').list(w => w.status === 'active' && (w.kind === 'file' || w.kind === 'log'));
  const registered = registrations.get(ctx.runtime) ?? new Map<string, Registration>();
  registrations.set(ctx.runtime, registered);
  for (const [id, dispose] of ctx.runtime.watchDisposers) {
    const watch = active.find(w => w.id === id);
    if (!watch || registered.get(id)?.signature !== `${watch.kind}:${watch.target}`) {
      try { dispose(); } catch (error) { ctx.logger.warn(`取消文件关注 ${id} 失败`, error); }
      ctx.runtime.watchDisposers.delete(id); ctx.runtime.pendingFileEvents.delete(id); registered.delete(id);
    }
  }
  for (const watch of active) {
    try {
      const target = parseFileTarget(watch.target);
      if (!canReadPath(ctx, watch, target.path)) continue;
      const info = await ctx.fs.stat(target.path);
      if (!canReadPath(ctx, watch, target.path)) continue;
      const existing = registered.get(watch.id);
      if (ctx.runtime.watchDisposers.has(watch.id) && existing) {
        if (existing.single && existing.statKey !== statKey(info) && !ctx.runtime.pendingFileEvents.has(watch.id)) {
          addPending(ctx, watch.id, [target.path], 'change', fileOccurredAt(info?.mtimeMs, ctx.clock.now()));
        }
        existing.statKey = statKey(info);
        continue;
      }
      const current = await snapshotFiles(ctx, watch, target.path, target.extension, path => canReadPath(ctx, watch, path));
      const old = await readFileBaseline(ctx, watch);
      if (!canReadPath(ctx, watch, target.path)) { suspendDeniedWatches(ctx); continue; }
      if (old) {
        const paths = changedPaths(old, current, target.path);
        // 离线期间没有监听回调，用变化文件的最早修改时间补回实际发生时刻；删除或超量无明细时只认发现时刻。
        if (paths.length) {
          const now = ctx.clock.now();
          const occurredAt = Math.min(now, ...paths.map(path => fileOccurredAt(current.entries[path]?.mtimeMs, now)));
          addPending(ctx, watch.id, paths, 'rename', occurredAt);
        }
        else if (old.legacyAt !== undefined) {
          await saveFileBaseline(ctx, watch, current);
          saveWatchState(ctx, watch, { fileBaseline: true, ...(watch.kind === 'log' ? { size: info?.size ?? 0 } : {}) }, ctx.clock.now());
        }
      } else {
        await saveFileBaseline(ctx, watch, current);
        saveWatchState(ctx, watch, { fileBaseline: true, ...(watch.kind === 'log' ? { size: info?.size ?? 0 } : {}) }, ctx.clock.now());
      }
      const single = !target.extension && !info?.isDir;
      // 文件本身的 inode 会随轮转失效；父目录监听始终按文件名重新找到新文件。
      const watchedPath = single ? dirname(target.path) : target.path;
      const dispose = ctx.fs.watch(watchedPath, { recursive: !single && target.extension === null }, event => {
        try {
          const latest = ctx.store.table('watches').get(watch.id);
          const path = normalize(event.path);
          if (latest?.status !== 'active' || !canReadPath(ctx, latest, path)) return;
          if (target.extension && (dirname(path) !== target.path || !basename(path).endsWith(target.extension))) return;
          if (single && path !== target.path) return;
          addPending(ctx, watch.id, [path], event.kind, ctx.clock.now());
        } catch (error) { ctx.logger.warn(`文件关注 ${watch.id} 的事件处理失败`, error); }
      });
      ctx.runtime.watchDisposers.set(watch.id, dispose);
      registered.set(watch.id, { signature: `${watch.kind}:${watch.target}`, single, statKey: statKey(info) });
    } catch (error) { recordWatchError(ctx, watch, error, ctx.clock.now()); }
  }
}

/** 按 UTF-8 字节偏移找新增尾部，切点落在多字节字符中时跳过残缺前缀。 */
function appendedTail(text: string, oldSize: number, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  let start = Math.max(oldSize > bytes.length ? 0 : oldSize, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}
/** 处理到期去抖批次，先保存完整基线，再清理批次；临时失败保留原事件供后续重试。 */
export async function flushFileEvents(ctx: HubContext, now: number, skipDebounce = false): Promise<Percept[]> {
  const result: Percept[] = [];
  suspendDeniedWatches(ctx);
  for (const [watchId, pending] of [...ctx.runtime.pendingFileEvents]) {
    if (!skipDebounce && now - pending.firstAt < ctx.settings.fileDebounceMs) continue;
    const watch = ctx.store.table('watches').get(watchId);
    if (!watch || watch.status !== 'active') { ctx.runtime.pendingFileEvents.delete(watchId); continue; }
    ctx.runtime.pendingFileEvents.delete(watchId);
    try {
      const target = parseFileTarget(watch.target);
      const old = await readFileBaseline(ctx, watch);
      const current = await snapshotFiles(ctx, watch, target.path, target.extension, path => canReadPath(ctx, watch, path));
      const summaries: string[] = [];
      const kinds = new Set<string>();
      let magnitude = Math.min(1, pending.paths.size / ctx.settings.c02.magnitudeItemCount);
      let sawNewLine = false;
      if (old?.overflow || current.overflow) {
        if (old && old.count !== current.count) {
          summaries.push(`文件太多，只比较数量：${old.count} → ${current.count}`);
          magnitude = Math.min(1, Math.abs(current.count - old.count) / Math.max(old.count, current.count, 1));
          kinds.add('changed');
        }
      } else {
        for (const path of pending.paths) {
          if (!canReadPath(ctx, watch, path)) continue;
          const entry = current.entries[path];
          const previous = old?.entries[path];
          // 目录自身事件无需报告为文件删除；它的子文件事件另行合并。
          if (!entry && (await ctx.fs.stat(path))?.isDir) continue;
          const oldSize = previous?.size ?? (watch.kind === 'log' && path === watch.target ? readWatchState(watch).size : undefined);
          const kind = !entry ? 'deleted' : oldSize === undefined && pending.kinds.has('rename') ? 'created' : 'changed';
          kinds.add(kind);
          if (watch.kind === 'file') {
            if (oldSize !== undefined && entry) magnitude = Math.max(magnitude, Math.abs(entry.size - oldSize) / Math.max(1, oldSize, entry.size));
            summaries.push(`${path}：${kind === 'created' ? '新建' : kind === 'deleted' ? '删除' : '变化'}`);
          } else if (entry && (oldSize === undefined || entry.size !== oldSize || (entry.inode !== undefined && entry.inode !== previous?.inode))) {
            const text = await ctx.fs.readText(path);
            if (!canReadPath(ctx, watch, path)) continue;
            if (text !== null) {
              const rotated = entry.inode !== undefined && previous?.inode !== undefined && entry.inode !== previous.inode;
              const tail = appendedTail(text, rotated ? 0 : oldSize ?? 0, ctx.settings.c02.watchValueMaxBytes);
              if (tail) summaries.push(tail);
              sawNewLine ||= tail.includes('\n');
            }
          }
        }
      }
      if (!canReadPath(ctx, watch, watch.target)) { suspendDeniedWatches(ctx); continue; }
      if ([...pending.paths].some(path => !canReadPath(ctx, watch, path))) continue;
      // 去抖或停机只延后处理；满足属于批次最早发生时刻，不能移到重启当天。
      if ((watch.kind === 'file' && summaries.length) || (watch.kind === 'log' && sawNewLine)) markWatchSatisfied(ctx, watch.id, Math.min(pending.firstAt, now));
      if (summaries.length) {
        const kind = watch.kind === 'log' || kinds.size !== 1 ? 'changed' : [...kinds][0]!;
        const percept = recordPercept(ctx, { botId: watch.botId, watchId, source: watch.kind === 'log' ? 'log' : 'file', kind,
          summary: truncateBytes(summaries.join('\n'), ctx.settings.c02.watchValueMaxBytes), location: watch.target,
          fingerprintMaterial: [watchId, pending.firstAt, [...pending.paths].sort(), fingerprint(summaries)], magnitude,
          anomaly: false, untrusted: true, occurredAt: pending.lastAt });
        if (percept) result.push(percept);
      }
      await saveFileBaseline(ctx, watch, current);
      saveWatchState(ctx, watch, { fileBaseline: true, ...(watch.kind === 'log' ? { size: current.entries[watch.target]?.size ?? 0 } : {}) }, now);
      const registration = registrations.get(ctx.runtime)?.get(watch.id);
      if (registration?.single) registration.statKey = statKey(current.entries[target.path]);
    } catch (error) {
      if (!canReadPath(ctx, watch, watch.target)) { suspendDeniedWatches(ctx); continue; }
      const newer = ctx.runtime.pendingFileEvents.get(watchId);
      ctx.runtime.pendingFileEvents.set(watchId, { firstAt: pending.firstAt, lastAt: Math.max(pending.lastAt, newer?.lastAt ?? pending.lastAt),
        paths: new Set([...pending.paths, ...(newer?.paths ?? [])]), kinds: new Set([...pending.kinds, ...(newer?.kinds ?? [])]) });
      recordWatchError(ctx, watch, error, now);
    }
  }
  return result;
}
