/** 文件基线单独原子保存，避免目录路径挤出 4 KB 字段后被误报为新建；超量目录只保存数量。 */
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { Watch } from '../model/perception.js';
import { readWatchState } from './watch-state.js';

const EntrySchema = z.object({ size: z.number().nonnegative(), mtimeMs: z.number().nonnegative(), inode: z.number().optional() });
const BaselineSchema = z.object({ target: z.string(), entries: z.record(z.string(), EntrySchema), count: z.number().int().nonnegative(), overflow: z.boolean(), legacyAt: z.number().optional() });
export type FileBaseline = z.infer<typeof BaselineSchema>;

/** 每个关注单独保存，既能在重启时恢复，也不会改变 watch.lastValue 的既定容量。 */
export const fileBaselinePath = (ctx: HubContext, watchId: string): string => join(ctx.settings.rootDir, '.hub/state/watch-baselines', `${watchId}.json`);

/** 读取新格式；兼容旧 sizes 时按 lastCheckedAt 作为时间下界，随后马上迁移。 */
export async function readFileBaseline(ctx: HubContext, watch: Watch): Promise<FileBaseline | null> {
  const text = await ctx.fs.readText(fileBaselinePath(ctx, watch.id));
  if (text) {
    const parsed = BaselineSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error('文件关注基线格式无效');
    if (parsed.data.target === watch.target) return parsed.data;
    return null;
  }
  const legacy = readWatchState(watch).sizes;
  if (!legacy) return null;
  return { target: watch.target, count: Object.keys(legacy).length, overflow: false, legacyAt: watch.lastCheckedAt ?? 0,
    entries: Object.fromEntries(Object.entries(legacy).map(([path, size]) => [path, { size, mtimeMs: watch.lastCheckedAt ?? 0 }])) };
}

/** 原子保存有界基线；超量目录丢弃全部明细，不能只丢一部分后继续假装完整。 */
export async function saveFileBaseline(ctx: HubContext, watch: Watch, baseline: FileBaseline): Promise<void> {
  const directory = join(ctx.settings.rootDir, '.hub/state/watch-baselines');
  await ctx.fs.mkdirp(directory);
  await ctx.fs.writeTextAtomic(fileBaselinePath(ctx, watch.id), JSON.stringify(baseline));
}

/** 遍历时最多保留 2000 条明细，超过后继续计数而不增加内存；授权在每次异步读取后重新核对。 */
export async function snapshotFiles(ctx: HubContext, watch: Watch, path: string, extension: string | null,
  allowed: (path: string) => boolean): Promise<FileBaseline> {
  const result: FileBaseline = { target: watch.target, count: 0, overflow: false, entries: {} };
  const visit = async (current: string): Promise<void> => {
    if (!allowed(current)) return;
    const info = await ctx.fs.stat(current);
    if (!allowed(current) || !info) return;
    if (info.isDir) {
      for (const name of await ctx.fs.list(current)) {
        const child = join(current, name);
        if (extension && (current !== path || !basename(child).endsWith(extension))) continue;
        await visit(child);
      }
      return;
    }
    result.count++;
    if (result.count > ctx.settings.c02.watchBaselineEntryLimit) { result.overflow = true; result.entries = {}; }
    else if (!result.overflow) result.entries[current] = { size: info.size, mtimeMs: info.mtimeMs, ...(info.inode === undefined ? {} : { inode: info.inode }) };
  };
  await visit(path);
  return result;
}
