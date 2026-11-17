/** 宿主写入前解析实际目标；新文件沿父目录解析，不能把符号链接目录当成普通家内路径。 */
import { posix } from 'node:path';
import type { FsIO, WriteBoundary } from '../io/interfaces.js';
import type { HubContext } from '../engine/context.js';
import { samePlace, within } from './paths.js';

/**
 * P74r16a：中心启动时取一次中心根目录的真实路径，记进运行时上下文（不写进设置、不落盘）。
 * 为什么：主人可能把数据目录放在符号链接后面；DSH 报来的工作目录是真实路径，闸门要靠它认出「这就是中心根目录」。
 * 真实路径与设置里的写法相同（含 /var 与 /private/var 这类固定别名）时记为 null，不需要换算；
 * 取真实路径失败时当作相同，只记一条日志，不影响启动。
 */
export async function detectRealRootDir(ctx: HubContext): Promise<void> {
    try {
        const real = (await ctx.fs.realpath(ctx.settings.rootDir)).replace(/\/+$/, '');
        ctx.runtime.realRootDir = real && !samePlace(real, ctx.settings.rootDir) ? real : null;
    } catch (error) {
        ctx.runtime.realRootDir = null;
        ctx.logger.warn('取不到中心根目录的真实路径，按与设置相同处理', String(error));
    }
}
/** 不存在的尾部逐级补回；权限错误和循环链接不能被当作不存在而放行。 */
export async function resolveRealTarget(fs: FsIO, path: string): Promise<string> {
    try { return await fs.realpath(path); }
    catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT' || posix.dirname(path) === path) throw error;
        return posix.join(await resolveRealTarget(fs, posix.dirname(path)), posix.basename(path));
    }
}

/**
 * 机器人能改动的根目录（家目录、共享目录）的真实位置：只解析上一级，再接回固定的名字。
 * 不能直接解析根目录本身：机器人可以把整个家目录搬走，在原位放一个指向别处的符号链接，
 * 那样解析结果就成了「别处」，后面所有「是否在家目录内」的判断都会被带着一起跑偏。
 * 上一级目录归中心管，机器人动不了。
 */
export async function resolveFixedRoot(fs: FsIO, root: string): Promise<string> {
    return posix.join(await resolveRealTarget(fs, posix.dirname(root)), posix.basename(root));
}
/**
 * 把已解析的真实目标换回「根目录字面路径 + 边界」，写入时由文件层在根这一级就拒绝符号链接。
 * 目标不在任何根目录内时不带边界：能走到这里的只可能是主人批准过的写入。
 */
export async function containedWriteTarget(fs: FsIO, actual: string, roots: string[]): Promise<{ path: string; boundary?: WriteBoundary }> {
    for (const root of roots) {
        const fixed = await resolveFixedRoot(fs, root);
        if (within(actual, fixed)) return { path: posix.join(root, posix.relative(fixed, actual)), boundary: { within: root } };
    }
    return { path: actual };
}
