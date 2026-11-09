/** DSH 真实工具参数回归：正常工作不建审批，递归搜索、展示文件与 L0 仍遵守原安全边界。 */
import { describe, expect, it } from 'vitest';
import { classifyToolCall, TOOL_SHAPES } from '../src/gate/classify.js';
import { decide } from '../src/gate/matrix.js';
import { guardToolCall } from '../src/gate/guard.js';
import type { GateContext } from '../src/gate/paths.js';
import type { WakeTicket } from '../src/model/index.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

const ctx: GateContext = {
    homeDir: botFixture.homeDir, rootDir: '/hub', sharedDir: '/hub/shared', ownerHome: '/Users/example',
    workDataAllowed: false, workDataPaths: ['~/company'],
};
const sessionId = 'm05-session';
/** 每项守卫测试使用独立假时钟与名册，避免越界隔离影响后续用例。 */
function setup() {
    const runtime = createTestContext({ ownerHome: ctx.ownerHome, settings: resolveSettings({ rootDir: '/hub', workDataPaths: ctx.workDataPaths }) });
    runtime.store.table('bots').put({ ...botFixture, autonomy: 'L0', sessionId });
    return runtime;
}
const readCalls: Array<[string, Record<string, unknown>]> = [
    ['glob', { pattern: '**/*.md' }], ['glob', { pattern: '*.md', path: 'work' }],
    ['grep', { pattern: 'TODO', path: 'work' }], ['grep', { pattern: 'TODO' }],
    ['read_image', { file_path: 'work/a.png' }], ['present', { files: [{ path: 'work/report.md', description: '报告' }] }],
    ['read', { file_path: 'work/report.md', offset: 0, limit: 10 }], ['bash', { command: 'ls' }],
];
const internalCalls: Array<[string, Record<string, unknown>]> = [
    ['todo_write', { todos: [{ content: '核对资料', status: 'pending' }] }], ['skill', { name: 'research' }],
    ['job_list', {}], ['job_output', { job_id: 'job-1', wait: true, timeout_ms: 1000 }],
    ['job_kill', { job_id: 'job-1', reason: '已不再需要' }],
];

describe('M05 真实 DSH 工具与 L0', () => {
    it.each(readCalls)('%s 普通读取为 A，L0 真实守卫放行且不建审批 %#', async (tool, args) => {
        const action = classifyToolCall(tool, args, ctx);
        expect(action).toMatchObject({ cls: 'A', readOnly: true });
        expect(decide(action, 'L0', 'active')).toBe('allow');
        const runtime = setup();
        expect(await guardToolCall(runtime, sessionId, tool, args)).toEqual({ allow: true });
        expect(runtime.store.table('approvals').count()).toBe(0);
        expect(runtime.store.table('inbox').count()).toBe(0);
    });
    it.each(internalCalls)('%s 仅本会话动作在 L0 放行，但不冒充只读', async (tool, args) => {
        expect(TOOL_SHAPES.some(shape => shape.scope === 'session' && shape.names.includes(tool))).toBe(true);
        const action = classifyToolCall(tool, args, ctx);
        expect(action).toMatchObject({ cls: 'A', subclass: 'session_internal', readOnly: false });
        expect(decide(action, 'L0', 'active')).toBe('allow');
        const runtime = setup();
        expect(await guardToolCall(runtime, sessionId, tool, args)).toEqual({ allow: true });
        expect(runtime.store.table('approvals').count()).toBe(0);
        expect(runtime.store.table('inbox').count()).toBe(0);
    });
    it.each(internalCalls)('%s 的非法容器与相似名称不会获得内部权限', (tool, args) => {
        expect(classifyToolCall(tool, null, ctx).cls).toBe('C');
        expect(classifyToolCall(`${tool}_external`, args, ctx).cls).toBe('C');
        expect(decide(classifyToolCall(`${tool}_external`, args, ctx), 'L0', 'active')).toBe('deny');
    });
    it.each(internalCalls)('已交账后 %s 仍拒绝，普通读取继续放行', async (tool, args) => {
        const runtime = setup();
        runtime.store.table('wakes').put({ ...(modelFixtures.WakeTicket.valid as WakeTicket), botId: botFixture.id, sessionId,
            status: 'committed', commitId: 'c_0000000001', endedAt: null });
        expect(await guardToolCall(runtime, sessionId, tool, args)).toMatchObject({ allow: false, message: expect.stringContaining('本轮已交账') });
        expect(await guardToolCall(runtime, sessionId, 'read', { file_path: 'work/report.md' })).toEqual({ allow: true });
        expect(runtime.store.table('approvals').count()).toBe(0);
    });
});

describe('M05 搜索范围与 pattern 路径', () => {
    it.each(['glob', 'grep'])('%s 无 path 使用 cwd，普通目录放行，工作数据祖先拒绝', tool => {
        const args = { pattern: tool === 'glob' ? '*' : 'TODO', recursive: false };
        expect(classifyToolCall(tool, args, { ...ctx, cwd: `${ctx.homeDir}/work` })).toMatchObject({ cls: 'A', paths: [`${ctx.homeDir}/work`] });
        expect(classifyToolCall(tool, args, { ...ctx, cwd: ctx.ownerHome })).toMatchObject({ cls: 'D', subclass: 'work_data' });
        expect(classifyToolCall(tool, { ...args, path: '~' }, ctx)).toMatchObject({ cls: 'D', subclass: 'work_data' });
        expect(classifyToolCall(tool, { ...args, path: '/' }, ctx)).toMatchObject({ cls: 'D', subclass: 'work_data' });
        expect(classifyToolCall(tool, { ...args, path: '~' }, { ...ctx, workDataAllowed: true })).toMatchObject({ cls: 'A', readOnly: true });
        expect(classifyToolCall(tool, { ...args, path: '~/company-copy' }, ctx).cls).toBe('A');
    });
    it.each(['glob', 'grep'])('%s 相对 path 按 cwd 解析，调用者额外字段不能伪造工作区', tool => {
        expect(classifyToolCall(tool, { pattern: '*', path: 'work' }, { ...ctx, cwd: '/public' })).toMatchObject({ cls: 'A', paths: ['/public/work'] });
        for (const field of ['cwd', 'workdir']) {
            expect(classifyToolCall(tool, { pattern: '*', path: '.', [field]: '/public' }, { ...ctx, cwd: '/Users/example/company' })).toMatchObject({ cls: 'D', subclass: 'work_data' });
            expect(classifyToolCall(tool, { pattern: '*', path: 'work', [field]: '/Users/example/.ssh' }, ctx)).toMatchObject({ cls: 'A', paths: [`${ctx.homeDir}/work`] });
        }
    });
    it.each([
        [{ pattern: '../../.ssh/*' }, 'protected'],
        [{ pattern: '../.ssh/*', path: '/Users/example/public' }, 'protected'],
        [{ pattern: '/Users/example/.dsh/*', path: 'work' }, 'protected'],
        [{ pattern: '../company/*.md', path: '/Users/example/public' }, 'D'],
        [{ pattern: '../company/*.md', path: '$UNKNOWN' }, 'C'],
        [{ pattern: 'work/**/*.md' }, 'A'],
        [{ pattern: '../public/*.md', path: '/Users/example/public' }, 'A'],
        [{ pattern: '..', path: 'work' }, 'A'],
    ] as const)('glob 拼接 pattern 后按完整路径判断 %#', (args, cls) => {
        const action = classifyToolCall('glob', args, ctx);
        expect(action.cls).toBe(cls);
        if (cls === 'D') expect(action.subclass).toBe('work_data');
    });
    it('glob 保留搜索根的递归边界，不能靠更窄 pattern 消掉工作数据祖先', () => {
        expect(classifyToolCall('glob', { pattern: 'public/*.md', path: '~' }, ctx)).toMatchObject({ cls: 'D', subclass: 'work_data' });
    });
    it.each(['/Users/*/company/*.md', '/Users/**/company/*.md', '/Users/exampl?/company/*.md', '/Users/{example,guest}/company/*.md'])('glob 通配路径 %s 仍检查工作数据，公开范围与授权正例放行', pattern => {
        const args = { pattern, path: 'work' };
        expect(classifyToolCall('glob', args, ctx)).toMatchObject({ cls: 'D', subclass: 'work_data' });
        expect(classifyToolCall('glob', args, { ...ctx, workDataAllowed: true })).toMatchObject({ cls: 'A', readOnly: true });
        expect(classifyToolCall('glob', { ...args, pattern: pattern.replace('/Users/', '/public/') }, ctx).cls).toBe('A');
    });
    it('grep 正则只表示正文，敏感路径仍由 path 独立检查', () => {
        expect(classifyToolCall('grep', { pattern: '../.ssh|key', path: 'work', include: '*.md' }, ctx).cls).toBe('A');
        expect(classifyToolCall('grep', { pattern: 'key', path: '~/.dsh' }, ctx).cls).toBe('protected');
    });
});

describe('M05 图片、展示与原有文件工具边界', () => {
    it.each([
        ['read_image', { file_path: '~/.ssh/key.png' }],
        ['present', { files: [{ path: '~/.ssh/id_rsa' }] }],
        ['present', { files: [{ path: 'work/report.md' }, { path: '~/.ssh/id_rsa' }] }],
        ['present', { files: [{ path: '~/.ssh/id_rsa' }, { path: 'work/report.md' }] }],
        ['read', { file_path: '~/.dsh/.credentials.yaml' }],
        ['write', { file_path: 'AGENTS.md', content: '修改' }],
        ['edit', { file_path: 'AGENTS.md', old_string: '旧', new_string: '新' }],
        ['bash', { command: 'cat ~/.dsh/.credentials.yaml' }],
    ] as Array<[string, Record<string, unknown>]>)('%s 敏感或中心保护路径始终拒绝 %#', async (tool, args) => {
        const action = classifyToolCall(tool, args, { ...ctx, workDataAllowed: true });
        expect(action.cls).toBe('protected');
        expect(decide(action, 'L3', 'active', ['*'])).toBe('deny');
        const runtime = setup();
        expect((await guardToolCall(runtime, sessionId, tool, args)).allow).toBe(false);
        expect(runtime.store.table('approvals').count()).toBe(0);
        expect(runtime.store.table('bots').get(botFixture.id)?.violations).toBe(1);
    });
    it('present 检查全部文件，工作数据混在普通文件中也需要授权', () => {
        const files = [{ path: 'work/report.md' }, { path: '~/company/plan.md' }];
        expect(classifyToolCall('present', { files }, ctx)).toMatchObject({ cls: 'D', subclass: 'work_data' });
        expect(classifyToolCall('present', { files }, { ...ctx, workDataAllowed: true })).toMatchObject({ cls: 'A', readOnly: true });
        expect(classifyToolCall('present', { files: [{ path: 'work/a.md' }, { path: 'work/b.md' }] }, ctx).paths).toEqual([`${ctx.homeDir}/work/a.md`, `${ctx.homeDir}/work/b.md`]);
    });
    it.each(['read_image', 'present'])('%s 相对路径不接受协议外 cwd/workdir 覆盖', tool => {
        const args = tool === 'read_image' ? { file_path: 'id_rsa.png' } : { files: [{ path: 'id_rsa' }] };
        expect(classifyToolCall(tool, { ...args, cwd: '/public', workdir: '/public' }, { ...ctx, cwd: '/Users/example/.ssh' }).cls).toBe('protected');
        const safeArgs = tool === 'read_image' ? { file_path: 'work/a.png' } : { files: [{ path: 'work/report.md' }] };
        expect(classifyToolCall(tool, { ...safeArgs, cwd: '/Users/example/.ssh', workdir: '/Users/example/.ssh' }, ctx).cls).toBe('A');
    });
    it.each(['write', 'edit'])('%s 的 file_path 可写 work，L0 仍拒绝原有限制区', async tool => {
        const args = { file_path: 'work/x.txt', content: '结果', old_string: '旧', new_string: '新' };
        const runtime = setup();
        expect(classifyToolCall(tool, args, ctx)).toMatchObject({ cls: 'A', subclass: 'work' });
        expect(await guardToolCall(runtime, sessionId, tool, args)).toEqual({ allow: true });
        for (const path of ['playbooks/a.md', '.agents/skills/a.md', '/hub/shared/a.md']) {
            const action = classifyToolCall(tool, { ...args, file_path: path }, ctx);
            expect(action.cls).toBe('A');
            expect(decide(action, 'L0', 'active')).toBe('deny');
            expect(decide(action, 'L1', 'active')).toBe('allow');
        }
        expect(classifyToolCall(tool, { ...args, file_path: '/outside/x.txt' }, ctx).cls).toBe('C');
        expect(runtime.store.table('approvals').count()).toBe(0);
    });
});

describe('M05 非法参数保守处理', () => {
    it.each([
        ['glob', {}, 'pattern'], ['grep', { pattern: 12 }, 'pattern'],
        ['glob', { pattern: '*' , path: null }, 'path'], ['grep', { pattern: 'TODO', path: '' }, 'path'],
        ['glob', { pattern: '*', path: 12 }, 'path'], ['read_image', { file_path: '' }, 'file_path'],
        ['present', { files: [] }, 'files'], ['present', { files: 'work/a.md' }, 'files'],
        ['present', { files: [{ path: 'work/a.md' }, {}] }, 'files.1.path'],
        ['present', { files: [{ path: 'work/a.md' }, null] }, 'files.1'],
        ['todo_write', { todos: {} }, 'todos'], ['skill', { name: '' }, 'name'],
        ['job_output', { job_id: 'job-1', wait: 'yes' }, 'wait'], ['job_kill', {}, 'job_id'],
    ] as Array<[string, Record<string, unknown>, string]>)('%s 参数异常不能降级成 A，并指出错误字段 %#', (tool, args, field) => {
        expect(classifyToolCall(tool, args, ctx)).toMatchObject({ cls: 'C', reason: expect.stringContaining(field) });
    });
    it('present 无效条目不能掩盖同批敏感路径', () => {
        expect(classifyToolCall('present', { files: [{ path: '~/.ssh/id_rsa' }, {}] }, ctx).cls).toBe('protected');
    });
});
