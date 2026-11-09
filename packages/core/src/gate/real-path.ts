/** 宿主写入前解析实际目标；新文件沿父目录解析，不能把符号链接目录当成普通家内路径。 */
import { posix } from 'node:path';
import type { FsIO, WriteBoundary } from '../io/interfaces.js';
import { within } from './paths.js';
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
