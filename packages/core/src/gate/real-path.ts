/** 宿主写入前解析实际目标；新文件沿父目录解析，不能把符号链接目录当成普通家内路径。 */
import { posix } from 'node:path';
import type { FsIO } from '../io/interfaces.js';
/** 不存在的尾部逐级补回；权限错误和循环链接不能被当作不存在而放行。 */
export async function resolveRealTarget(fs: FsIO, path: string): Promise<string> {
    try { return await fs.realpath(path); }
    catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT' || posix.dirname(path) === path) throw error;
        return posix.join(await resolveRealTarget(fs, posix.dirname(path)), posix.basename(path));
    }
}
