/**
 * P69 A-1 复查：把每个确认的问题写成「按任务卡应有的判定」来断言。
 * 这些用例现在应该是红的（失败即复现了问题）；修好之后应当变绿。
 * 编号和 docs/progress/P69-review.md 的问题编号一一对应。
 * 分类器是纯函数，这里的命令只是字符串，不会被执行。路径全是假的。
 */
import { describe, expect, it } from 'vitest';
import { classifyToolCall } from '../src/gate/classify.js';
import type { GateContext } from '../src/gate/paths.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { guardToolCallSync } from '../src/gate/guard.js';
import type { ToolCallHostReport } from '../src/gate/guard.js';
import { gateContextFor } from '../src/gate/gate-context.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { ProjectSchema, WakeTicketSchema } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

// —— 纯分类用的上下文（与 p69-sandbox-classify.test.ts 同款）——
const owner = '/Users/owner', root = '/hub', home = `${root}/bots/b_0000000001`;
const project = `${root}/projects/prj_0000000001`, tmp = '/private/var/folders/ab/xyz/T';
const legacy: GateContext = { homeDir: home, ownerHome: owner, rootDir: root, sharedDir: `${root}/shared`, workDataAllowed: false, workDataPaths: [`${owner}/CompanyWork`], cwd: home };
const sandboxed: GateContext = { ...legacy, sandboxed: true, tmpDirs: ['/tmp', '/private/tmp', tmp], projectDirs: [project] };
const exec = (command: string, ctx: GateContext = sandboxed) => classifyToolCall('exec', { command }, ctx);

// —— 守卫用的环境（与 p69-sandbox-guard.test.ts 同款）——
const gRoot = `${owner}/AgentHub`, gHome = `${gRoot}/bots/b_0000000001`, projectId = 'prj_0000000001', gProject = `${gRoot}/projects/${projectId}`;
const SANDBOX: ToolCallHostReport = { sandboxed: true, tmpDirs: ['/tmp', '/private/tmp', tmp] };
function setup() {
  const runtime = createTestContext({ ownerHome: owner });
  runtime.settings = resolveSettings({ rootDir: gRoot, l3Grants: [] });
  const bot = { ...botFixture, sessionId: 'session-review', homeDir: gHome, autonomy: 'L2' as const, lifecycle: 'active' as const };
  runtime.store.table('bots').put(bot);
  const now = runtime.clock.now();
  runtime.store.table('projects').put(ProjectSchema.parse({ id: projectId, name: '报名页', charter: '', status: 'active', ownerBotId: null,
    memberBotIds: [bot.id], sharedDir: `${gProject}/`, acceptanceCriteria: [], createdAt: now, updatedAt: now, archivedAt: null }));
  return { runtime, bot };
}
async function guard(runtime: HubContext, sessionId: string, tool: string, args: unknown, host?: ToolCallHostReport) {
  const effects: Promise<unknown>[] = [];
  const decision = guardToolCallSync(runtime, sessionId, tool, args, effect => { effects.push(effect); }, undefined, host);
  await Promise.all(effects);
  return decision;
}

describe('R1 喂给外壳的脚本不经过 here-document 本身时，里面的对外命令被放行', () => {
  it.each([
    "cat <<'EOF' | bash\ngit push origin main\nEOF",
    "cat <<'EOF' | sh\nssh build.example.com\nEOF",
    "echo 'git push origin main' | bash",
    "bash -s -- prod <<'EOF'\ngit push origin main\nEOF",
    "sh - <<'EOF'\nssh build.example.com\nEOF",
    "bash /dev/stdin <<'EOF'\nssh build.example.com\nEOF",
  ])('守卫应当要审批：%s', async command => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, 'exec', { command }, SANDBOX);
    expect(decision.allow, command).toBe(false);
    expect(runtime.store.table('approvals').count()).toBe(1);
  });
});

describe('R2 用 npx / pnpm dlx / bunx 跑带版本号或官方包名的部署工具，被放行', () => {
  it.each([
    'npx vercel@latest deploy --prod', 'pnpm dlx vercel@latest deploy', 'npx wrangler@3 deploy', 'npx netlify-cli deploy --prod',
    'npx firebase-tools deploy', 'npx @vercel/cli deploy', 'bunx vercel deploy',
  ])('应当是 C publish_deploy：%s', command => {
    expect(exec(command), command).toMatchObject({ cls: 'C' });
  });
  it('对照：不带版本号的 npx vercel 能认出来', () => {
    expect(exec('npx --package=vercel vercel deploy')).toMatchObject({ cls: 'C', subclass: 'publish_deploy' });
  });
});

describe('R3 发布软件包的常规写法不在名单里，被放行', () => {
  it.each([
    'python3 -m twine upload dist/*', 'python -m twine upload dist/pkg-1.0.tar.gz', 'uv run twine upload dist/*', 'uv publish', 'poetry publish --build', 'bun publish',
  ])('应当要确认：%s', command => {
    expect(exec(command).cls, command).not.toBe('A');
  });
  it('对照：直接写 twine upload 能认出来', () => {
    expect(exec('twine upload dist/*')).toMatchObject({ cls: 'C', subclass: 'publish_deploy' });
  });
});

describe('R4 名单外的包装器、带值选项没登记的包装器，会把里面的对外命令藏起来', () => {
  it.each([
    'arch -arm64 git push origin main', 'arch -x86_64 ssh build.example.com', 'stdbuf -oL git push origin main', 'setsid ssh build.example.com',
    'gtimeout 30 ssh build.example.com', 'xargs -a hosts.txt ssh', 'uv run git push origin main', 'poetry run git push origin main',
  ])('应当仍然要确认：%s', command => {
    expect(exec(command).cls, command).not.toBe('A');
  });
  it('对照：timeout、nice、env 包住时能认出来', () => {
    for (const command of ['timeout 30 ssh build.example.com', 'nice ssh build.example.com', 'env -u X git push origin main']) expect(exec(command).cls, command).toBe('C');
  });
});

describe('R5 复盘回合里，经中心代写进项目文件夹被放行（总控裁定第 1 条：复盘时本卡放宽一律不生效）', () => {
  it('复盘回合 hub_outbox_submit write_file 写自己项目的文件夹：应当被拒绝或至少要审批，而不是直接写进去', async () => {
    const { runtime, bot } = setup();
    runtime.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id, sessionId: bot.sessionId, variant: 'reflection' });
    expect(gateContextFor(runtime, runtime.store.table('bots').get(bot.id)!).reflection).toBe(true);
    let row: Awaited<ReturnType<typeof submitOutbox>> | null = null;
    try { row = await submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${gProject}/index.html`, content: '<h1>x</h1>' }, why: '复盘时顺手交付' }); }
    catch { row = null; }
    if (row) await executeReadyOutbox(runtime);
    // 改动前（c65e050）：项目目录不在上下文里，判 C，submitOutbox 以「复盘回合只允许写自己的 work、MEMORY.md 与 playbooks」拒绝。
    expect(await runtime.fs.readText(`${gProject}/index.html`)).toBeNull();
  });
});

describe('R6 A6 原文检查只认五个解释器名：带版本号的 python 写的内联代码读凭据被放行', () => {
  const code = `from pathlib import Path; print((Path.home() / ".ssh" / "id_ed25519").read_text())`;
  it('对照：python3 -c 同一段代码被拒绝', () => {
    expect(exec(`python3 -c '${code}'`)).toMatchObject({ cls: 'protected' });
  });
  it.each([`python3.12 -c '${code}'`, `uv run python -c '${code}'`, `pypy3 -c '${code}'`])('应当同样拒绝：%s', command => {
    expect(exec(command).cls, command).toBe('protected');
  });
});

describe('R7 不点名地改中心管理的文件：旧规则要审批，沙箱开着变成放行（memory/journal 没有回合结束的恢复）', () => {
  it.each([
    'echo 补一行 >> "$PWD/memory/journal/2026-11-10.md"',
    'rm -rf "$PWD/memory/journal"',
    "find memory -name '*.md' -exec sed -i '' s/失败/成功/ {} +",
  ])('应当不是 A：%s', command => {
    expect(exec(command, legacy).cls, `旧规则 ${command}`).not.toBe('A');
    expect(exec(command).cls, command).not.toBe('A');
  });
  // 总控 A-3 复核裁定 T1：家目录根部不再算上级目录。下面两条沙箱开着改成 A（旧规则仍然要审批）。
  it.each(['tar -xf work/old-home.tar', 'rsync -a work/backup/ ./'])('沙箱开着放行（总控 A-3 复核裁定 T1：家目录根部不再算上级目录）：%s', command => {
    expect(exec(command, legacy).cls, `旧规则 ${command}`).not.toBe('A');
    expect(exec(command).cls, command).toBe('A');
  });
});

describe('R8 临时目录的 /var 与 /private/var 别名：只报了真实路径时，正常写临时文件被当成写系统目录（D，记越界）', () => {
  it('tmpDirs 只有真实路径时，写 os.tmpdir() 给出的 /var/folders/... 应当放行，而不是 D', () => {
    const realOnly = { ...sandboxed, tmpDirs: ['/private/tmp', tmp] };
    expect(exec('echo x > /var/folders/ab/xyz/T/a.txt', realOnly).cls).toBe('A');
  });
  it('中心根目录在 /private/tmp 下、宿主报了 /tmp：/tmp/... 写别的队友的身份文件应当被拒绝', () => {
    const r = '/private/tmp/hub', h = `${r}/bots/b_0000000001`;
    const ctx: GateContext = { homeDir: h, ownerHome: owner, rootDir: r, sharedDir: `${r}/shared`, workDataAllowed: false, cwd: h, sandboxed: true, tmpDirs: ['/tmp'] };
    expect(exec('echo x > /tmp/hub/bots/b_0000000002/AGENTS.md', ctx).cls).not.toBe('A');
    expect(exec('echo x > /tmp/hub/.hub/state.json', ctx).cls).not.toBe('A');
  });
});

describe('R9 git 少见写法：推送被当成「修改仓库」放行', () => {
  it.each(['git --namespace foo push origin main', 'git send-pack origin main', 'git http-push https://example.com/r.git main'])('应当要确认：%s', command => {
    expect(exec(command).cls, command).not.toBe('A');
  });
});

// R10 是附带发现：旧规则下同样判 protected（见 zz-review-r10-legacy.test.ts），不是 P69 引入的。
describe('R10（既有问题）A6 误拦会记越界：正常写 .gitignore、README 的 here-document 被判 protected，累计三次就隔离', () => {
  it.each([
    "cat > work/signup/.gitignore <<'EOF'\nnode_modules\n.env\nEOF",
    "cat > work/signup/README.md <<'EOF'\n# 报名页\n\n本地运行前，把 .env.example 复制成 .env\nEOF",
    "cat > work/notes.md <<'EOF'\n部署机器的公钥放在 ~/.ssh/authorized_keys\nEOF",
  ])('应当放行且不记越界：%s', async command => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, 'exec', { command }, SANDBOX);
    expect(runtime.store.table('bots').get(bot.id)!.violations, `${command} → ${JSON.stringify(decision)}`).toBe(0);
    // A-3 总控裁定：R10 按「写进文件的文字放行且不记越界」断言（原来只断言不记越界，被拒绝也算过）。
    expect(decision.allow, `${command} → ${JSON.stringify(decision)}`).toBe(true);
    expect(runtime.store.table('approvals').count()).toBe(0);
  });
});

describe('R11 下载按远端文件名落地（curl -O）时，落点可能正好是家目录的 AGENTS.md', () => {
  it('curl -O .../AGENTS.md 在家目录下运行：应当不是 A', () => {
    expect(exec('curl -O https://example.com/templates/AGENTS.md', legacy).cls).not.toBe('A');
    expect(exec('curl -O https://example.com/templates/AGENTS.md').cls).not.toBe('A');
  });
});
