/** 仓库路径必须核验 .git 的实际位置，避免家内 worktree 指向家外仓库后免审批修改。 */
import { posix } from 'node:path';
import type { FsIO } from '../io/interfaces.js';
import { classifyPath, mostDangerous, resolveGatePath, within } from './paths.js';
import type { Classification, GateContext } from './paths.js';
/** 从 cwd 向上找 .git，文件式 worktree 读取 gitdir 并解析相对位置。 */
export async function checkGitBoundaries(fs: FsIO, action: Classification, ctx: GateContext): Promise<Classification> {
    const checks = [action];
    for (const repo of action.gitRepos ?? []) {
        let directory = repo;
        for (;;) {
            const marker = posix.join(directory, '.git');
            const info = await fs.stat(marker);
            if (info) {
                let gitdir = marker;
                if (!info.isDir) {
                    const content = await fs.readText(marker);
                    const match = content?.match(/^gitdir:\s*(.+)\s*$/i);
                    if (!match) { checks.push({ cls: 'C', reason: '.git 文件无法确认真实仓库位置', subclass: 'git_write' }); break; }
                    gitdir = resolveGatePath(match[1]!, { ...ctx, cwd: directory });
                }
                gitdir = await fs.realpath(gitdir);
                checks.push(classifyPath(gitdir, false, ctx));
                if (!within(gitdir, ctx.homeDir)) checks.push({ cls: 'C', reason: '.git 的真实仓库位于机器人家目录外', subclass: 'git_write' });
                break;
            }
            if (posix.dirname(directory) === directory) break;
            directory = posix.dirname(directory);
        }
    }
    return mostDangerous(checks);
}
