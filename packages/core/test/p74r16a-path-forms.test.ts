/**
 * P74r16a：同一个位置的两种写法都认得；沙箱开着时写到沙箱之外只指路、不计越界；停用原因写清次数。
 *
 * 两种环境各一组夹具（沙箱都开着）：
 * - 甲：中心根目录在系统临时目录下（/var/folders/…/T/agent-hub-sandbox/AgentHub），
 *   DSH 报来的工作目录是真实路径 /private/var/…（macOS 上 /var 是指向 /private/var 的链接）；
 * - 乙：中心根目录设置为 /Users/someone/AgentHub，它其实是指向 /Volumes/Disk/AgentHub 的符号链接，
 *   DSH 报来的工作目录是真实路径 /Volumes/Disk/AgentHub/…。
 * 每条规则都有正例（放行）和反例（仍然拒绝）。路径全是假的，不读磁盘。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { guardToolCallSync, gateContextFor } from '../src/gate/guard.js';
import type { ToolCallHostReport } from '../src/gate/guard.js';
import { detectRealRootDir } from '../src/gate/real-path.js';
import { toCenterForm, samePlace, within } from '../src/gate/paths.js';
import type { HubContext } from '../src/engine/context.js';
import { botFixture } from './model-fixtures.js';

const OWNER = '/Users/someone';
const TMP_T = '/var/folders/ab/xyz/T';
/** 宿主在这台机器上报的临时目录：两种写法的系统临时目录都有（与真实情况一致）。 */
const HOST_TMP = ['/tmp', '/private/tmp', TMP_T, `/private${TMP_T}`];
const SANDBOX: ToolCallHostReport = { sandboxed: true, tmpDirs: HOST_TMP };

interface Env {
  name: string;
  /** 设置里的中心根目录（中心记的写法）。 */
  root: string;
  /** DSH 报来的真实写法。 */
  real: string;
  /** 中心根目录在符号链接后面时，启动时取到的真实路径。 */
  realRootDir?: string;
}
const ENVS: Env[] = [
  { name: '甲：根目录在 /var 下，DSH 报 /private/var 写法', root: `${TMP_T}/agent-hub-sandbox/AgentHub`, real: `/private${TMP_T}/agent-hub-sandbox/AgentHub` },
  { name: '乙：根目录是符号链接，DSH 报真实路径', root: `${OWNER}/AgentHub`, real: '/Volumes/Disk/AgentHub', realRootDir: '/Volumes/Disk/AgentHub' },
];

const EXECUTOR = 'b_0000000001', PEER = 'b_0000000002', CHIEF = 'b_0000000003';

/** 总管（自动创建、听吩咐）、执行员工（听吩咐）和另一位执行员工；执行员工自主等级 L1，与真实验证时一致。 */
function setup(env: Env) {
  const runtime = createTestContext({ ownerHome: OWNER });
  runtime.settings = resolveSettings({ rootDir: env.root, l3Grants: [] });
  if (env.realRootDir) runtime.runtime.realRootDir = env.realRootDir;
  const make = (id: string, role: 'chief' | 'executor', session: string) => ({ ...botFixture, id, role, onDemand: true, sessionId: session,
    homeDir: `${env.root}/bots/${id}`, autonomy: 'L1' as const, pace: role === 'chief' ? 'quiet' as const : 'normal' as const });
  runtime.store.table('bots').put(make(CHIEF, 'chief', 'session-chief'));
  runtime.store.table('bots').put(make(EXECUTOR, 'executor', 'session-exec'));
  runtime.store.table('bots').put(make(PEER, 'executor', 'session-peer'));
  return { runtime, home: `${env.root}/bots/${EXECUTOR}`, realHome: `${env.real}/bots/${EXECUTOR}` };
}

/** host 传 null 表示宿主没有报沙箱情况（没确认沙箱）；不传默认沙箱开着。 */
async function guard(runtime: HubContext, tool: string, args: unknown, host: ToolCallHostReport | null = SANDBOX, session = 'session-exec') {
  const effects: Promise<unknown>[] = [];
  const decision = guardToolCallSync(runtime, session, tool, args, effect => { effects.push(effect); }, undefined, host ?? undefined);
  await Promise.all(effects);
  return decision;
}
const violations = (runtime: HubContext, id = EXECUTOR) => runtime.store.table('bots').get(id)!.violations;
const messageOf = (decision: { allow: boolean; message?: string }) => decision.allow ? '' : decision.message ?? '';

describe.each(ENVS)('P74r16a 第 1 节 $name', env => {
  // 调查记录第 2 节表里被拒的六条命令，原样（员工编号换成夹具里的）。
  // 后两条里的多行命令在用例里按 REVIEW、REVIEW_SHORT 拼出来（要用到当前环境的中心根目录）。
  it.each([
    ['E1-1 tee 写家目录文件', 'node test.js 2>&1 | tee 证据-selftest.txt; echo "exit=$?"', 'work/signup'],
    ['E1-2 重定向到上一级', 'node test.js > ../selftest.log 2>&1; echo "exit=$?"; cat ../selftest.log', 'work/signup'],
    ['E1-3 写临时文件', 'pwd; ls; echo hi > t.txt && cat t.txt', 'work/signup'],
    ['E2 重定向', 'node test.js > selftest.log 2>&1; echo "exit=$?"; cat selftest.log', 'work/signup'],
    ['V1-1 复制到家目录', 'REVIEW', ''],
    ['V1-2 同上去掉原地复跑', 'REVIEW_SHORT', ''],
  ])('六条命令之一：%s：用真实写法的工作目录，放行、不计越界', async (_name, template, sub) => {
    const { runtime, realHome } = setup(env);
    const J = `J=${env.root}/projects/prj_xthhxt3le2/jobs/job_9gxfjzix75`;
    const review = ['set -e', J, 'mkdir -p work/review-run && cp "$J/交付/index.html" "$J/证据/test.js" work/review-run/', 'cd work/review-run && node test.js; echo "exit=$?"'];
    const command = template === 'REVIEW' ? [...review, 'cd "$J" && node 证据/test.js; echo "exit=$?"'].join('\n')
      : template === 'REVIEW_SHORT' ? review.join('\n') : template;
    const workdir = sub === '' ? realHome : `${realHome}/${sub}`;
    const decision = await guard(runtime, 'exec', { command, workdir });
    expect(decision, command).toEqual({ allow: true });
    expect(violations(runtime)).toBe(0);
    expect(runtime.store.table('approvals').count()).toBe(0);
    expect(runtime.store.table('bots').get(EXECUTOR)!.lifecycle).toBe('active');
  });

  it('同样的命令，工作目录用中心记的写法：照旧放行（对照）', async () => {
    const { runtime, home } = setup(env);
    const decision = await guard(runtime, 'exec', { command: 'pwd; ls; echo hi > t.txt && cat t.txt', workdir: `${home}/work/signup` });
    expect(decision).toEqual({ allow: true });
    expect(violations(runtime)).toBe(0);
  });

  it('写文件工具，路径用另一种写法指向家目录里的普通文件：放行', async () => {
    const { runtime, realHome } = setup(env);
    for (const [tool, args] of [['write', { file_path: `${realHome}/work/signup/index.html`, content: 'x' }],
      ['write_file', { path: `${realHome}/notes.md`, content: 'x' }], ['edit', { file_path: `${realHome}/work/a.txt`, old_string: 'a', new_string: 'b' }]] as const) {
      expect(await guard(runtime, tool, args), tool).toEqual({ allow: true });
    }
    expect(violations(runtime)).toBe(0);
  });

  // 仍然拒绝：另一种写法指向的是受保护的位置，原因和越界计数必须与用原写法时相同。
  const protectedTargets = (home: string, root: string): Array<[string, string]> => [
    ['家目录里的 AGENTS.md', `${home}/AGENTS.md`],
    ['家目录里 memory/journal/ 下的文件', `${home}/memory/journal/2026-11-13.md`],
    ['家目录里的 mind/ 下的文件', `${home}/mind/goals.md`],
    ['.hub/ 下的文件', `${root}/.hub/state/bots.json`],
    ['中心根目录下的 AGENTS.md', `${root}/AGENTS.md`],
    ['别的员工家目录里的 AGENTS.md', `${root}/bots/${PEER}/AGENTS.md`],
    ['别的员工家目录里的普通文件', `${root}/bots/${PEER}/work/x.txt`],
  ];
  it.each(protectedTargets('H', 'R').map(([name]) => name))('另一种写法指向%s：仍然拒绝，原因、越界计数与原写法相同', async name => {
    const pick = (home: string, root: string) => protectedTargets(home, root).find(([n]) => n === name)![1];
    for (const kind of ['写文件工具', '命令重定向'] as const) {
      const run = async (home: string, root: string) => {
        const { runtime } = setup(env);
        const target = pick(home, root);
        const decision = kind === '写文件工具' ? await guard(runtime, 'write', { file_path: target, content: 'x' }) : await guard(runtime, 'exec', { command: `echo x > ${target}`, workdir: `${env.real}/bots/${EXECUTOR}` });
        return { decision, count: violations(runtime), approvals: runtime.store.table('approvals').count() };
      };
      const original = await run(`${env.root}/bots/${EXECUTOR}`, env.root);
      const alt = await run(`${env.real}/bots/${EXECUTOR}`, env.real);
      expect(original.decision.allow, `${kind} 原写法`).toBe(false);
      expect(alt.decision.allow, `${kind} 另一种写法`).toBe(false);
      // 路径在文字里的写法不同，其余文字必须一致。
      expect(messageOf(alt.decision).split(env.real).join(env.root).split(env.root).join('R'), kind)
        .toBe(messageOf(original.decision).split(`/private${env.root}`).join('R').split(env.root).join('R'));
      expect(alt.count, `${kind} 越界计数`).toBe(original.count);
      expect(alt.approvals, `${kind} 审批单`).toBe(original.approvals);
    }
  });

  it('受保护位置在另一种写法下计一次越界、消息是原来的那一句', async () => {
    const { runtime, realHome } = setup(env);
    const decision = await guard(runtime, 'write', { file_path: `${realHome}/AGENTS.md`, content: 'x' });
    expect(decision).toEqual({ allow: false, message: '中心管理的身份、心智视图和历史日志不能直接改写' });
    expect(violations(runtime)).toBe(1);
  });

  it.each([
    ['/private/etc 下的私钥文件', '/private/etc/ssl/private/server.key'],
    ['/private/etc 下的 .env', '/private/etc/app/.env'],
    ['/private/etc 下的凭据文件', '/private/etc/app/credentials.json'],
    ['主人家目录下的 .ssh/', `${OWNER}/.ssh/id_rsa`],
    ['主人家目录下的 .ssh/ 配置', `${OWNER}/.ssh/config`],
  ])('凭据类文件：%s：仍然拒绝并计一次越界', async (_name, path) => {
    const { runtime } = setup(env);
    expect((await guard(runtime, 'write', { file_path: path, content: 'x' })).allow).toBe(false);
    expect((await guard(runtime, 'read', { file_path: path })).allow).toBe(false);
    expect((await guard(runtime, 'exec', { command: `echo x > ${path}` })).allow).toBe(false);
    expect(violations(runtime)).toBe(3);
  });

  it('反例：真正写系统目录仍然拒绝（沙箱会拦，只指路，不计越界），两种写法一样', async () => {
    for (const command of ['echo x > /var/log/x', 'echo x > /private/var/log/x', 'echo x > /etc/hosts', 'echo x > /private/etc/hosts']) {
      const { runtime } = setup(env);
      const decision = await guard(runtime, 'exec', { command, workdir: `${env.real}/bots/${EXECUTOR}` });
      expect(decision.allow, command).toBe(false);
      expect(messageOf(decision), command).toContain('不在你的工作区里，写不进去');
      expect(violations(runtime), command).toBe(0);
      expect(runtime.store.table('approvals').count()).toBe(0);
    }
    const { runtime } = setup(env);
    expect((await guard(runtime, 'write', { file_path: '/private/var/log/x', content: 'x' })).allow).toBe(false);
    expect((await guard(runtime, 'write', { file_path: '/var/log/x', content: 'x' })).allow).toBe(false);
  });

  it('反例：临时目录 /tmp/x、/private/tmp/x 放行；另一个用户的目录、桌面仍然拒绝', async () => {
    const { runtime } = setup(env);
    for (const command of ['echo x > /tmp/x', 'echo x > /private/tmp/x']) {
      expect(await guard(runtime, 'exec', { command, workdir: `${env.real}/bots/${EXECUTOR}` }), command).toEqual({ allow: true });
    }
    expect((await guard(runtime, 'write', { file_path: `${OWNER}/Desktop/a.txt`, content: 'x' })).allow).toBe(false);
    expect((await guard(runtime, 'write', { file_path: '/Users/other/a.txt', content: 'x' })).allow).toBe(false);
    expect(violations(runtime)).toBe(0);
  });

  it('没确认沙箱时，另一种写法指向家目录里的普通文件：同样放行；指向受保护的文件：同样拒绝', async () => {
    const { runtime, realHome } = setup(env);
    expect(await guard(runtime, 'write', { file_path: `${realHome}/work/x.txt`, content: 'x' }, null)).toEqual({ allow: true });
    expect((await guard(runtime, 'write', { file_path: `${realHome}/AGENTS.md`, content: 'x' }, null)).allow).toBe(false);
    expect(violations(runtime)).toBe(1);
  });
});

describe('P74r16a 第 1 节：规范化函数', () => {
  const ctx = { rootDir: '/Users/someone/AgentHub', realRootDir: '/Volumes/Disk/AgentHub' };
  it('within 认得 /var 与 /private/var、/tmp 与 /private/tmp、/etc 与 /private/etc 是同一处', () => {
    expect(within('/private/var/folders/a/b', '/var/folders/a')).toBe(true);
    expect(within('/var/folders/a/b', '/private/var/folders/a')).toBe(true);
    expect(within('/private/tmp/x', '/tmp')).toBe(true);
    expect(within('/etc/hosts', '/private/etc')).toBe(true);
    expect(samePlace('/var/x', '/private/var/x')).toBe(true);
    // 反例：别的目录、前缀相同但不是同一段、/private 下别的目录。
    expect(within('/private/var2/x', '/var')).toBe(false);
    expect(within('/private/home/x', '/var')).toBe(false);
    expect(within('/varx/a', '/var')).toBe(false);
    expect(samePlace('/var/x', '/private/var/y')).toBe(false);
  });
  it('toCenterForm：落在真实路径下的目标换成设置里的写法；边界、大小写、尾斜杠；不在下面的原样返回', () => {
    expect(toCenterForm('/Volumes/Disk/AgentHub/bots/b1/AGENTS.md', ctx)).toBe('/Users/someone/AgentHub/bots/b1/AGENTS.md');
    expect(toCenterForm('/Volumes/Disk/AgentHub', ctx)).toBe('/Users/someone/AgentHub');
    expect(toCenterForm('/volumes/disk/agenthub/x', ctx)).toBe('/Users/someone/AgentHub/x');
    expect(toCenterForm('/Volumes/Disk/AgentHub-other/x', ctx)).toBe('/Volumes/Disk/AgentHub-other/x');
    expect(toCenterForm('/Volumes/Disk/x', ctx)).toBe('/Volumes/Disk/x');
    expect(toCenterForm('/Volumes/Disk/AgentHub/x', { ...ctx, realRootDir: '/Volumes/Disk/AgentHub/' })).toBe('/Users/someone/AgentHub/x');
    expect(toCenterForm('/Volumes/Disk/AgentHub/x', { rootDir: ctx.rootDir })).toBe('/Volumes/Disk/AgentHub/x');
    expect(toCenterForm('relative/x', ctx)).toBe('relative/x');
  });
  it('gateContextFor 把运行时记下的真实路径带进分类上下文；没有时不带', () => {
    const { runtime } = setup(ENVS[1]!);
    const bot = runtime.store.table('bots').get(EXECUTOR)!;
    expect(gateContextFor(runtime, bot).realRootDir).toBe('/Volumes/Disk/AgentHub');
    const plain = setup(ENVS[0]!);
    expect('realRootDir' in gateContextFor(plain.runtime, plain.runtime.store.table('bots').get(EXECUTOR)!)).toBe(false);
  });
  it('detectRealRootDir：真实路径不同才记；同一处（含 /var 与 /private/var）、取不到都记 null，取不到时记一条日志', async () => {
    const differ = setup(ENVS[1]!).runtime;
    differ.fs.realpath = async path => path === differ.settings.rootDir ? '/Volumes/Disk/AgentHub/' : path;
    await detectRealRootDir(differ);
    expect(differ.runtime.realRootDir).toBe('/Volumes/Disk/AgentHub');
    const same = setup(ENVS[0]!).runtime;
    same.fs.realpath = async path => `/private${path}`;
    await detectRealRootDir(same);
    expect(same.runtime.realRootDir).toBeNull();
    const failing = setup(ENVS[1]!).runtime;
    failing.runtime.realRootDir = '/stale';
    failing.fs.realpath = async () => { throw new Error('ENOENT'); };
    await detectRealRootDir(failing);
    expect(failing.runtime.realRootDir).toBeNull();
    expect(failing.logger.lines.filter(line => line.level === 'warn').map(line => line.message)).toEqual(['取不到中心根目录的真实路径，按与设置相同处理']);
    expect(same.logger.lines.filter(line => line.level === 'warn')).toEqual([]);
  });
});

describe('P74r16a 第 2 节：沙箱开着时，写到沙箱之外只指路、不计越界', () => {
  const root = `${OWNER}/AgentHub`;
  const GUIDE_OTHER_TEXT = (target: string) => `${target}不在你的工作区里，写不进去。自己的文件用相对路径写在你的文件夹里，临时文件写到 /tmp 下；确实要写到别处，用 hub_outbox_submit（kind 为 write_file 或 run_command）并写清原因，主人确认后由中心执行。`;
  const env = ENVS[1]!;

  it('连续 5 次写真正的系统目录：每次都被拒、文字逐字、越界计数不变、员工没有被停用', async () => {
    const { runtime } = setup(env);
    for (let i = 0; i < 5; i += 1) {
      const decision = await guard(runtime, 'exec', { command: 'echo x > /var/log/x' });
      expect(decision).toEqual({ allow: false, message: GUIDE_OTHER_TEXT('/var/log/x') });
      expect(violations(runtime)).toBe(0);
      expect(runtime.store.table('bots').get(EXECUTOR)!.lifecycle).toBe('active');
    }
    expect(runtime.store.table('approvals').count()).toBe(0);
  });

  it('写系统目录之外的沙箱外位置（桌面）：同样不计越界，文字逐字', async () => {
    const { runtime } = setup(env);
    for (let i = 0; i < 4; i += 1) {
      expect(await guard(runtime, 'write', { file_path: `${OWNER}/Desktop/a.txt`, content: 'x' })).toEqual({ allow: false, message: GUIDE_OTHER_TEXT(`${OWNER}/Desktop/a.txt`) });
    }
    expect(violations(runtime)).toBe(0);
  });

  it('项目文件夹、共享目录的指路话逐字', async () => {
    const { runtime } = setup(env);
    const now = runtime.clock.now();
    runtime.store.table('projects').put({ id: 'prj_0000000001', name: '报名页', charter: '', status: 'active', ownerBotId: null, memberBotIds: [EXECUTOR],
      sharedDir: `${root}/projects/prj_0000000001/`, acceptanceCriteria: [], createdAt: now, updatedAt: now, archivedAt: null } as never);
    expect(await guard(runtime, 'write', { file_path: `${root}/projects/prj_0000000001/index.html`, content: 'x' })).toEqual({ allow: false,
      message: `${root}/projects/prj_0000000001/index.html在项目文件夹里，不能用你自己的工具直接写。把文件先做在你的文件夹里，再用 hub_project_put 放进项目，不需要主人批准。` });
    expect(await guard(runtime, 'write', { file_path: `${root}/shared/a.txt`, content: 'x' })).toEqual({ allow: false,
      message: `${root}/shared/a.txt在共享目录里，不能用你自己的工具直接写。用 hub_outbox_submit（kind 为 write_file）写入，不需要主人批准。` });
    expect(violations(runtime)).toBe(0);
  });

  it('路径最多列 3 个，用顿号连接，超过的写「等 n 处」', async () => {
    const { runtime } = setup(env);
    const three = await guard(runtime, 'exec', { command: 'tee /var/log/a /var/log/b /var/log/c' });
    expect(three).toEqual({ allow: false, message: GUIDE_OTHER_TEXT('/var/log/a、/var/log/b、/var/log/c') });
    const five = await guard(runtime, 'exec', { command: 'tee /var/log/a /var/log/b /var/log/c /var/log/d /var/log/e' });
    expect(five).toEqual({ allow: false, message: GUIDE_OTHER_TEXT('/var/log/a、/var/log/b、/var/log/c等 2 处') });
    expect(violations(runtime)).toBe(0);
  });

  it('反例：写凭据类文件、中心管理的文件各 1 次，越界各加一', async () => {
    const { runtime } = setup(env);
    expect((await guard(runtime, 'write', { file_path: `${OWNER}/.ssh/id_rsa`, content: 'x' })).allow).toBe(false);
    expect(violations(runtime)).toBe(1);
    expect((await guard(runtime, 'write', { file_path: `${root}/bots/${EXECUTOR}/AGENTS.md`, content: 'x' })).allow).toBe(false);
    expect(violations(runtime)).toBe(2);
  });

  it('反例：工作数据目录仍计越界（沙箱开着也一样）', async () => {
    const { runtime } = setup(env);
    runtime.settings = resolveSettings({ rootDir: env.root, l3Grants: [], workDataPaths: [`${OWNER}/CompanyWork`] });
    expect((await guard(runtime, 'read', { file_path: `${OWNER}/CompanyWork/plan.md` })).allow).toBe(false);
    expect(violations(runtime)).toBe(1);
  });

  it('反例：没有确认沙箱时写系统目录：照旧计越界、照旧建审批单', async () => {
    const { runtime } = setup(env);
    const decision = await guard(runtime, 'exec', { command: 'echo x > /var/log/x' }, null);
    expect(decision.allow).toBe(false);
    expect(messageOf(decision)).toContain('已提交审批单');
    expect(violations(runtime)).toBe(1);
    expect(runtime.store.table('approvals').count()).toBe(1);
    // 宿主明确报 false，和不传一样。
    const other = setup(env);
    await guard(other.runtime, 'exec', { command: 'echo x > /var/log/x' }, { sandboxed: false, tmpDirs: ['/tmp'] });
    expect(violations(other.runtime)).toBe(1);
  });
});

describe('P74r16a 第 3 节：越界达到次数被停用时，原因写清楚', () => {
  it('三次越界（凭据类）之后停用，停用原因逐字', async () => {
    const { runtime } = setup(ENVS[1]!);
    for (let i = 0; i < 3; i += 1) {
      expect(violations(runtime)).toBe(i);
      expect((await guard(runtime, 'exec', { command: 'cat ~/.ssh/id_rsa' })).allow).toBe(false);
    }
    const row = runtime.store.table('bots').get(EXECUTOR)!;
    expect(row.lifecycle).toBe('quarantined');
    expect(row.quarantineReason).toBe('越界的动作累计 3 次（最近一次：敏感凭据路径禁止读取或改写）');
    expect(row.activityText).toBe('已停用：越界的动作累计 3 次（最近一次：敏感凭据路径禁止读取或改写）');
  });

  it('反例：未达到次数时不停用，没有停用原因', async () => {
    const { runtime } = setup(ENVS[1]!);
    await guard(runtime, 'exec', { command: 'cat ~/.ssh/id_rsa' });
    await guard(runtime, 'exec', { command: 'cat ~/.ssh/id_rsa' });
    const row = runtime.store.table('bots').get(EXECUTOR)!;
    expect(row).toMatchObject({ lifecycle: 'active', violations: 2, quarantineReason: null });
  });
});
