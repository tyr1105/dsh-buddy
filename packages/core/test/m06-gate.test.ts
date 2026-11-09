/** M06 动作闸回归：标准设备重定向保持只读，家目录普通文件可写，同时保留受保护和家外边界。 */
import { describe, expect, it } from 'vitest';
import { classifyCommand, classifyToolCall } from '../src/gate/classify.js';
import { guardToolCall } from '../src/gate/guard.js';
import { decide } from '../src/gate/matrix.js';
import type { GateContext } from '../src/gate/paths.js';
import { lexShell } from '../src/gate/shell-lexer.js';
import { turnContext } from './c03-turn-fixtures.js';

const home = '/hub/bots/b_0000000001';
const context: GateContext = {
    homeDir: home, rootDir: '/hub', sharedDir: '/hub/shared', ownerHome: '/Users/example',
    workDataAllowed: false, workDataPaths: ['/company'],
};

describe('M06 标准设备与文件描述符重定向', () => {
    it.each([
        'pwd; ls -la; cat hello.txt 2>/dev/null || echo "NO hello.txt"; date',
        'cat hello.txt > /dev/null', 'cat hello.txt >> /dev/stdout',
        'cat hello.txt 2>/dev/stderr', 'cat hello.txt >/dev/tty',
        'cat hello.txt &>/dev/null', 'cat hello.txt &>>/dev/null',
        'cat hello.txt 2>&1', 'cat hello.txt >&2', 'cat hello.txt 1>&2 2>&1',
        'cat hello.txt 2>& 1', 'cat hello.txt >&"2"', 'cat hello.txt 2>&1>/dev/null',
        'cat hello.txt 2>&-', 'cat hello.txt 2>&1-',
        'cat hello.txt >"/dev/null"', 'cat hello.txt >/dev/../dev/null',
    ])('%s 不产生文件写入，L0 仍可只读执行', command => {
        const action = classifyCommand(command, context);
        expect(action).toMatchObject({ cls: 'A', readOnly: true });
        expect(action.writePaths).toEqual([]);
        expect(decide(action, 'L0', 'active')).toBe('allow');
    });

    it.each(['2>&1', '>&2', '1>&2 2>&1', '2>& 1', '>&"2"', '2>&-', '2>&1-'])('%s 复制描述符，不成为命令参数或文件目标', redirect => {
        expect(lexShell(`cat hello.txt ${redirect}`)).toMatchObject({
            valid: true, parts: [{ words: ['cat', 'hello.txt'], redirects: [] }],
        });
    });

    it.each([
        ['cat hello.txt 2>/outside/errors.log', 'C'],
        ['cat hello.txt >/etc/hosts', 'D'],
        ['cat hello.txt &>/outside/output.log', 'C'],
        ['cat hello.txt >& /outside/output.log', 'C'],
        ['cat hello.txt 2>&1 >/outside/output.log', 'C'],
        ['cat hello.txt >/dev/null.backup', 'C'],
        ['cat hello.txt >/dev/null/child', 'C'],
        ['cat hello.txt >/dev/null; rm -rf /outside/data', 'D'],
        ['cat hello.txt 2>/dev/null >AGENTS.md', 'protected'],
    ])('%s 保留普通文件或危险子命令的 %s 分类', (command, cls) => {
        expect(classifyCommand(command!, context).cls).toBe(cls);
    });

    it('设备例外只适用于重定向，不扩大普通写工具的家外权限', () => {
        expect(classifyToolCall('write', { file_path: '/dev/null', content: 'x' }, context).cls).toBe('C');
    });

    it('普通数字文件名仍是文件写入，描述符复制后相邻的家外重定向也不能漏检', () => {
        expect(classifyCommand('echo hello >1', context)).toMatchObject({ cls: 'A', readOnly: false, writePaths: [`${home}/1`] });
        expect(classifyCommand('echo hello 2>&1>/outside/output.log', context)).toMatchObject({ cls: 'C', writePaths: ['/outside/output.log'] });
        expect(classifyCommand('echo hello >& 2.log', context)).toMatchObject({ cls: 'A', readOnly: false, writePaths: [`${home}/2.log`] });
    });

    it('真实只读巡检经过守卫放行，不生成审批、收件箱或越界记录', async () => {
        const { ctx, bot } = await turnContext('regular', { autonomy: 'L1', lifecycle: 'probation' });
        const result = await guardToolCall(ctx, bot.sessionId!, 'bash', {
            command: 'pwd; ls -la; cat hello.txt 2>/dev/null || echo "NO hello.txt"; date',
        });
        expect(result.allow).toBe(true);
        expect(ctx.store.table('approvals').count()).toBe(0);
        expect(ctx.store.table('inbox').list(i => i.type === 'approval')).toEqual([]);
        expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(0);
    });
});

describe('M06 家目录普通写入与受保护边界', () => {
    it.each(['write', 'edit', 'write_file', 'edit_file'])('%s 可新建或修改家目录根文件，也可写普通子目录', tool => {
        for (const path of ['hello.txt', `${home}/hello.txt`, 'notes/daily.txt', 'memory/notes.md', '.local/output.txt']) {
            const action = classifyToolCall(tool, { file_path: path, content: '已检查' }, context);
            expect(action).toMatchObject({ cls: 'A', readOnly: false });
            expect(action.writePaths).toContain(path.startsWith('/') ? path : `${home}/${path}`);
            expect(decide(action, 'L1', 'probation')).toBe('allow');
        }
    });

    it.each([
        'echo hello >hello.txt', 'echo hello >>hello.txt', 'echo hello &>notes.txt',
        'cp work/source.txt hello.txt', 'mv work/source.txt hello.txt',
        'mkdir -p notes/daily', 'touch hello.txt', 'echo hello | tee hello.txt',
        'chmod 600 hello.txt', 'chown user hello.txt',
    ])('%s 在家目录内是可撤销写入 A', command => {
        const action = classifyCommand(command, context);
        expect(action).toMatchObject({ cls: 'A', readOnly: false });
        expect(decide(action, 'L1', 'probation')).toBe('allow');
    });

    it.each(['AGENTS.md', 'mind/goals.md', 'memory/journal/history.md', '.ssh/config', '.env.local'])('%s 不因家目录普通写放宽而失去保护', path => {
        expect(classifyToolCall('write', { file_path: path }, context).cls).toBe('protected');
        expect(classifyToolCall('edit', { file_path: path }, context).cls).toBe('protected');
        expect(classifyCommand(`echo changed >${path}`, context).cls).toBe('protected');
        expect(classifyCommand(`cp work/source.txt ${path}`, context).cls).toBe('protected');
        expect(classifyCommand(`mv work/source.txt ${path}`, context).cls).toBe('protected');
        expect(classifyCommand(`touch ${path}`, context).cls).toBe('protected');
    });

    it.each([
        'cp work/AGENTS.md .', `cp work/AGENTS.md ${home}`, `cp work/AGENTS.md ${home}/`,
        'mv work/AGENTS.md .', `mv work/AGENTS.md ${home}`, 'cp work/agents.md .',
    ])('%s 把目标解释为目录时也不能隐式覆盖受保护文件', command => {
        expect(classifyCommand(command, context).cls).toBe('protected');
    });

    it.each([
        'cp work/hello.txt .', `cp work/hello.txt ${home}`, 'mv work/hello.txt .',
        `mv work/hello.txt ${home}`, 'cp work/AGENTS.md backup.txt', 'cp work/AGENTS.md notes/',
    ])('%s 的两种目标解释都安全时仍为 A', command => {
        expect(classifyCommand(command, context)).toMatchObject({ cls: 'A', readOnly: false });
    });

    it.each(['mv AGENTS.md work/backup.md', 'mv mind work/backup', 'mv memory work/backup'])('%s 仍不能搬走受保护源文件或其祖先目录', command => {
        expect(classifyCommand(command, context).cls).toBe('protected');
    });

    it.each([
        ['/outside/hello.txt', 'C'], ['/etc/hosts', 'D'],
        [`${home}-other/hello.txt`, 'C'], ['../other/hello.txt', 'C'],
        ['/company/hello.txt', 'D'],
    ])('家外 %s 的 %s 分类保持不变', (path, cls) => {
        expect(classifyToolCall('write', { file_path: path }, context).cls).toBe(cls);
        expect(classifyCommand(`echo changed >${path}`, context).cls).toBe(cls);
        expect(classifyCommand(`cp hello.txt ${path}`, context).cls).toBe(cls);
        expect(classifyCommand(`touch ${path}`, context).cls).toBe(cls);
    });

    it('L0 仍只允许原有 work 和 MEMORY 写入，L1 家目录根写不再需要审批', () => {
        expect(decide(classifyToolCall('write', { file_path: 'hello.txt' }, context), 'L0', 'active')).toBe('deny');
        expect(decide(classifyToolCall('write', { file_path: 'work/hello.txt' }, context), 'L0', 'active')).toBe('allow');
        expect(decide(classifyToolCall('write', { file_path: 'memory/MEMORY.md' }, context), 'L0', 'active')).toBe('allow');
    });

    it('守卫允许家目录根新建与修改，受保护文件拒绝，家外文件仍提交审批', async () => {
        const { ctx, bot } = await turnContext('regular', { autonomy: 'L1', lifecycle: 'probation' });
        expect((await guardToolCall(ctx, bot.sessionId!, 'write', { file_path: 'hello.txt', content: '你好' })).allow).toBe(true);
        expect((await guardToolCall(ctx, bot.sessionId!, 'edit', { file_path: 'hello.txt', old_string: '你好', new_string: '已检查' })).allow).toBe(true);
        expect(ctx.store.table('approvals').count()).toBe(0);
        expect((await guardToolCall(ctx, bot.sessionId!, 'write', { file_path: 'AGENTS.md', content: '改写身份' })).allow).toBe(false);
        expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(1);
        expect(ctx.store.table('approvals').count()).toBe(0);
        expect((await guardToolCall(ctx, bot.sessionId!, 'write', { file_path: '/outside/hello.txt', content: '修改' })).allow).toBe(false);
        expect(ctx.store.table('approvals').list()).toMatchObject([{ actionClass: 'C', status: 'pending' }]);
    });
});
