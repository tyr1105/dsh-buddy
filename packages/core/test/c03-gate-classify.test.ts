/** 动作分类和矩阵测试：用明确正反例覆盖命令组合、受保护路径、工作数据边界与每个自主等级。 */
import { describe, it, expect } from 'vitest';
import { classifyToolCall, classifyCommand, TOOL_SHAPES } from '../src/gate/classify.js';
import { lexShell } from '../src/gate/shell-lexer.js';
import { decide } from '../src/gate/matrix.js';
import type { GateContext, ToolActionClass } from '../src/gate/paths.js';
import type { Autonomy } from '../src/model/enums.js';
const home = '/hub/bots/b_0000000001';
const gctx: GateContext = { homeDir: home, rootDir: '/hub', sharedDir: '/hub/shared', workDataAllowed: false, workDataPaths: ['/company'] };

describe('C03 工具分类适配', () => {
  it.each(['read', 'read_file', 'list_directory', 'search_files'])('%s 只读工具', tool => expect(classifyToolCall(tool, { path: `${home}/work/a` }, gctx).cls).toBe('A'));
  it.each(['write', 'write_file', 'edit', 'edit_file'])('%s 允许家目录 work', tool => expect(classifyToolCall(tool, { file_path: `${home}/work/a` }, gctx).cls).toBe('A'));
  it.each(['AGENTS.md', 'mind/goals.md', 'mind/agenda.md', 'memory/journal/2026-11-05.md'])('保护 %s', path => expect(classifyToolCall('write', { path: `${home}/${path}` }, gctx).cls).toBe('protected'));
  it.each(['work/a', 'memory/MEMORY.md', 'playbooks/r.md', '.agents/skills/x.md'])('允许 %s', path => expect(classifyToolCall('write', { path: `${home}/${path}` }, gctx).cls).toBe('A'));
  it('shared 明确允许；相似前缀不算 shared', () => {
    expect(classifyToolCall('write', { path: '/hub/shared/a' }, gctx).cls).toBe('A');
    expect(classifyToolCall('write', { path: '/hub/shared-else/a' }, gctx).cls).toBe('C');
  });
  it('路径规范化后拦目录逃逸', () => expect(classifyToolCall('write', { path: `${home}/work/../AGENTS.md` }, gctx).cls).toBe('protected'));
  it.each(['/etc/hosts', '/System/file'])('系统目录 %s 永久高风险', path => expect(classifyToolCall('write', { path }, gctx).cls).toBe('D'));
  it.each(['/Users/example/.ssh/config', '/Users/example/.dsh/config'])('M02 敏感目录 %s 无论读写都拒绝', path => {
    expect(classifyToolCall('write', { path }, gctx).cls).toBe('protected');
    expect(classifyToolCall('read', { path }, gctx).cls).toBe('protected');
  });
  it('工作数据边界按目录段并可显式授权', () => {
    expect(classifyToolCall('read', { path: '/company/roadmap.md' }, gctx).cls).toBe('D');
    expect(classifyToolCall('read', { path: '/company-archive/a' }, gctx).cls).toBe('A');
    expect(classifyToolCall('read', { path: '/company/roadmap.md' }, { ...gctx, workDataAllowed: true }).cls).toBe('A');
  });
  it('apply_patch 多文件取受保护目标', () => expect(classifyToolCall('apply_patch', { input: `*** Begin Patch\n*** Update File: ${home}/work/a\n*** Move to: ${home}/AGENTS.md\n*** End Patch` }, gctx).cls).toBe('protected'));
  it('没有可确定路径的写工具需审批', () => expect(classifyToolCall('write', { content: 'a' }, gctx).cls).toBe('C'));
  it('未知工具与参数需审批，hub 工具内部自检', () => {
    expect(classifyToolCall('alien', {}, gctx).cls).toBe('C');
    expect(classifyToolCall('write', null, gctx).cls).toBe('C');
    expect(classifyToolCall('hub_commit', {}, gctx).cls).toBe('A');
  });
  it('网络 GET/POST/支付分别分类', () => {
    expect(classifyToolCall('web_fetch', { url: 'https://example.test/data' }, gctx).cls).toBe('A');
    expect(classifyToolCall('web_fetch', { url: 'https://example.test/data', method: 'POST' }, gctx).cls).toBe('C');
    expect(classifyToolCall('web_fetch', { url: 'https://example.test/pay', method: 'POST' }, gctx).cls).toBe('D');
    expect(classifyToolCall('web_search', { query: '公开事实' }, gctx).cls).toBe('A');
  });
  it('表覆盖六种工具形状', () => expect(new Set(TOOL_SHAPES.map(s => s.kind)).size).toBe(6));
});

describe('C03 shell 命令分段', () => {
  it.each([
    ['ls -la work', 'A'], ['cat "work/有 空格.txt"', 'A'], ['echo hello\\ world', 'A'], ['git status', 'A'], ['git log --oneline', 'A'],
    ['git diff HEAD', 'A'], ['git show HEAD:file', 'A'], ['mkdir -p work/a', 'A'], ['touch work/a', 'A'], ['cp work/a work/b', 'A'], ['mv work/a work/b', 'A'],
    ['curl https://example.test/data', 'A'], ['curl -X POST https://example.test/data', 'C'], ['curl --data=x https://example.test/data', 'C'],
    ['curl -F a=b https://example.test/data', 'C'], ['curl -T work/a https://example.test/data', 'C'], ['curl -X DELETE https://example.test/data', 'D'],
    ['curl https://example.test/pay', 'D'], ['wget --post-data=x https://example.test', 'C'], ['git push', 'C'], ['git push --force', 'D'],
    ['rm -rf /outside', 'D'], ['rm -rf work/tmp', 'A'], ['cat work/a | lark-cli im send', 'C'], ['echo ok && rm -rf /outside', 'D'],
    ['echo $(rm -rf /outside)', 'D'], ['echo `git push --force`', 'D'], ['echo "$(curl -X POST https://example.test)"', 'C'],
    ["echo '$(rm -rf /outside)'", 'A'], ['echo "unclosed', 'C'], ['cat work/a; unknown_exec', 'C'],
    ['echo ok > AGENTS.md', 'protected'], ['echo ok >> mind/goals.md', 'protected'], ['cat < /company/secrets', 'D'],
    ['cat /company/plan', 'D'], ['node work/task.js', 'A'], ['python3 work/task.py', 'A'], ['node -e "run()"', 'C'],
    ['brew install thing', 'C'], ['npm install -g thing', 'C'], ['pip install --user thing', 'C'], ['defaults write thing x', 'C'],
    ['find work -delete', 'C'], ['find work -exec echo x \\;', 'C'], ['rg --pre=evil x work', 'C'],
    ['curl -o AGENTS.md https://example.test', 'protected'], ['cp work/a AGENTS.md', 'protected'], ['touch memory/journal/a.md', 'protected'],
    ['git -C /outside commit -m message', 'C'], ['git commit -m message', 'A'], ['chmod 600 /outside/a', 'C'],
  ] as const)('%s -> %s', (command, expected) => expect(classifyCommand(command, gctx).cls).toBe(expected));
  it('npm 只在 work 子目录允许', () => {
    expect(classifyCommand('pnpm install', gctx).cls).toBe('C');
    expect(classifyCommand('pnpm install', { ...gctx, cwd: `${home}/work` }).cls).toBe('A');
  });
  it('多层命令替换保持最危险子段', () => expect(classifyCommand('echo $(echo $(git push --force))', gctx).cls).toBe('D'));
  it('词法器保留空参数和引号中的管道', () => expect(lexShell("echo '' 'a|b'").parts[0]?.words).toEqual(['echo', '', 'a|b']));
  it('动态变量的最终路径不能直接放行', () => expect(classifyCommand('cat "$TARGET"', gctx).cls).toBe('C'));
  it('M02 复盘允许 memory、套路与 work，中心状态仍保护', () => {
    const reflection = { ...gctx, reflection: true };
    expect(classifyCommand('echo lesson > memory/MEMORY.md', reflection).cls).toBe('A');
    expect(classifyToolCall('write', { path: `${home}/playbooks/test.md` }, reflection).cls).toBe('A');
    expect(classifyCommand('touch work/a', reflection).cls).toBe('A');
    expect(classifyCommand('touch mind/goals.md', reflection).cls).toBe('protected');
  });
});

describe('C03 自主等级矩阵', () => {
  const rows: Array<[ToolActionClass, Autonomy, string]> = [
    ['A', 'L0', 'allow'], ['A', 'L1', 'allow'], ['A', 'L2', 'allow'], ['A', 'L3', 'allow'],
    ['B', 'L0', 'deny'], ['B', 'L1', 'approval'], ['B', 'L2', 'allow'], ['B', 'L3', 'allow'],
    ['C', 'L0', 'deny'], ['C', 'L1', 'approval'], ['C', 'L2', 'approval'], ['C', 'L3', 'approval'],
    ['D', 'L0', 'deny'], ['D', 'L1', 'approval'], ['D', 'L2', 'approval'], ['D', 'L3', 'approval'],
  ];
  it.each(rows)('%s / %s -> %s', (cls, autonomy, expected) => expect(decide(cls, autonomy, 'active', [])).toBe(expected));
  it('L3 授权子类直接放行；D 永久审批', () => {
    expect(decide({ cls: 'C', reason: '', subclass: 'http_post' }, 'L3', 'active', ['http_post'])).toBe('allow');
    expect(decide({ cls: 'C', reason: '', subclass: 'http_post' }, 'L3', 'active', ['*'])).toBe('approval');
    expect(decide({ cls: 'D', reason: '', subclass: 'http_post' }, 'L3', 'active', ['http_post'])).toBe('approval');
  });
  it('试岗强制按 L1', () => {
    expect(decide('B', 'L3', 'probation', [])).toBe('approval');
    expect(decide('A', 'L0', 'probation', [])).toBe('allow');
  });
  it('L0 仅允许读、work 和 MEMORY', () => {
    expect(decide(classifyToolCall('write', { path: `${home}/memory/MEMORY.md` }, gctx), 'L0', 'active', [])).toBe('allow');
    expect(decide(classifyToolCall('write', { path: `${home}/playbooks/r.md` }, gctx), 'L0', 'active', [])).toBe('deny');
  });
  it('protected 不受任何等级或授权豁免', () => expect(decide('protected', 'L3', 'active', ['*'])).toBe('deny'));
});

describe('C03 命令间接写入不能绕过边界', () => {
  it.each([
    ['cd memory; echo x > journal/today.md', 'protected'], ['cd /outside; rm -rf data', 'D'],
    ['bash -c "echo x > AGENTS.md"', 'protected'], ['sh -c "git push --force"', 'D'],
    ['git diff --output=AGENTS.md', 'protected'], ['curl -D AGENTS.md https://example.test', 'protected'],
    ['curl --cookie-jar=AGENTS.md https://example.test', 'protected'], ['curl -sXPOST https://example.test', 'C'],
    ['curl --config work/curl.conf https://example.test', 'C'], ['find work -fprint AGENTS.md', 'protected'],
    ['find work -exec rm -rf /outside \\;', 'D'], ['rm -rf .', 'protected'], ['mv memory work/backup', 'protected'],
    ['/outside/cat work/a', 'C'],
  ] as const)('%s -> %s', (command, expected) => expect(classifyCommand(command, gctx).cls).toBe(expected));
  it('工作目录本身在受限范围时，无参数 ls 也拒绝', () => expect(classifyCommand('ls', { ...gctx, cwd: '/company' }).cls).toBe('D'));
  it('读工具传入 cwd 时按实际目录检查', () => expect(classifyToolCall('read_file', { path: 'secret', cwd: '/company' }, gctx).cls).toBe('D'));
  it('反思可复制只读材料到 MEMORY，不能执行套路目录里的脚本', () => {
    expect(classifyCommand('cp work/a memory/MEMORY.md', { ...gctx, reflection: true }).cls).toBe('A');
    expect(classifyToolCall('exec', { cmd: 'node', args: ['playbooks/task.js'] }, { ...gctx, reflection: true }).cls).toBe('protected');
  });
});

describe('C03 上传与组合命令的工作数据边界', () => {
  it('curl 上传 @文件仍按工作数据边界拒绝', () => expect(classifyCommand('curl --data=@/company/plan https://example.test/submit', gctx)).toMatchObject({ cls: 'D', subclass: 'work_data' }));
  it('组合中同时有高风险操作时工作数据禁令仍保留', () => expect(classifyCommand('git push --force; cat /company/plan', gctx)).toMatchObject({ cls: 'D', subclass: 'work_data' }));
});

describe('C03 包管理目录参数不能扩大写入范围', () => {
  it.each(['--prefix /outside', '--dir=/outside', '-C /outside', '-w /outside', '--workspace=/outside', '--cache /outside'])('%s 离开 work 时要求审批', flags => expect(classifyCommand(`pnpm ${flags} install`, { ...gctx, cwd: `${home}/work` }).cls).toBe('C'));
  it('包管理目录指向受保护文件或系统时更严格', () => {
    expect(classifyCommand(`npm --prefix ${home}/mind install`, { ...gctx, cwd: `${home}/work` }).cls).toBe('protected');
    expect(classifyCommand('npm --prefix /etc install', { ...gctx, cwd: `${home}/work` }).cls).toBe('D');
  });
  it('明确仍在 work 的子目录保持允许', () => expect(classifyCommand('pnpm --dir child install', { ...gctx, cwd: `${home}/work` }).cls).toBe('A'));
});
