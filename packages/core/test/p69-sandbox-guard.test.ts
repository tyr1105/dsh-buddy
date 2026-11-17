/**
 * P69 A-1：守卫、审批表和出站动作在「宿主确认沙箱开着」时的行为。
 *
 * 和 p69-sandbox-classify.test.ts 的分工：那边只测分类结果，这边走完整的守卫入口，
 * 看放行、拒绝、有没有产生审批单、有没有记越界、返回给队友的话是什么。
 * 对应任务卡「测试」的第 1、3、5、6、8、10 条，以及总控裁定第 1、7 条。
 * 路径全是假的：主人 /Users/owner，中心根目录 /Users/owner/AgentHub。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import { resolveSettings } from '../src/config/defaults.js';
import { guardToolCall, guardToolCallSync } from '../src/gate/guard.js';
import type { ToolCallHostReport } from '../src/gate/guard.js';
import { gateContextFor, nativeGateContext } from '../src/gate/gate-context.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
// P74r16a：指路的话改成带被拦路径的函数（原来是三个固定常量 GUIDE_PROJECT、GUIDE_SHARED、GUIDE_OTHER）。
import { guideOther, guideProject, guideShared } from '../src/gate/sandbox-rules.js';
import { ProjectSchema, WakeTicketSchema } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

const owner = '/Users/owner', root = `${owner}/AgentHub`, home = `${root}/bots/b_0000000001`, shared = `${root}/shared`;
const tmp = '/private/var/folders/ab/xyz/T';
const projectId = 'prj_0000000001', project = `${root}/projects/${projectId}`;
/** 宿主报告：沙箱开着，临时目录三个。 */
const SANDBOX: ToolCallHostReport = { sandboxed: true, tmpDirs: ['/tmp', '/private/tmp', tmp] };

type Overrides = { autonomy?: 'L0' | 'L1' | 'L2' | 'L3'; lifecycle?: 'active' | 'probation'; members?: string[]; archived?: boolean; owner?: string | null };

/** 一个带机器人和一个项目的测试环境。项目默认由这位机器人做成员。 */
function setup(options: Overrides = {}) {
  const runtime = createTestContext({ ownerHome: owner });
  runtime.settings = resolveSettings({ rootDir: root, l3Grants: [] });
  const bot = { ...botFixture, sessionId: 'session-p69', homeDir: home, autonomy: options.autonomy ?? 'L2', lifecycle: options.lifecycle ?? 'active' };
  runtime.store.table('bots').put(bot);
  const now = runtime.clock.now();
  runtime.store.table('projects').put(ProjectSchema.parse({
    id: projectId, name: '报名页', charter: '', status: options.archived ? 'archived' : 'active', ownerBotId: options.owner ?? null,
    memberBotIds: options.members ?? [bot.id], sharedDir: `${project}/`, acceptanceCriteria: [], createdAt: now, updatedAt: now,
    archivedAt: options.archived ? now : null,
  }));
  return { runtime, bot };
}

/** 走同步守卫入口（插件实际用的那个），并等所有副作用（记越界、发通知）做完。 */
async function guard(runtime: HubContext, sessionId: string, tool: string, args: unknown, host?: ToolCallHostReport) {
  const effects: Promise<unknown>[] = [];
  const decision = guardToolCallSync(runtime, sessionId, tool, args, effect => { effects.push(effect); }, undefined, host);
  await Promise.all(effects);
  return decision;
}
const violations = (runtime: HubContext, id: string) => runtime.store.table('bots').get(id)!.violations;

describe('P69 测试1 样板重放：沙箱开着，八条命令全部放行，审批表里一条都没有', () => {
  const md = ['# 报名页基线', '', '- 报名需要姓名和手机号', '- 提交后展示成功提示', '- 手机上也要能用'].join('\n');
  const py = ['import re', 'from html.parser import HTMLParser', 'html = open("index.html", encoding="utf-8").read()', '', 'class Collect(HTMLParser):',
    '    def __init__(self):', '        super().__init__()', '        self.tags = []', '    def handle_starttag(self, tag, attrs):', '        self.tags.append((tag, dict(attrs)))',
    '', 'parser = Collect()', 'parser.feed(html)', 'print(len(parser.tags), "个标签")', 'print(re.findall(r"<title>(.*?)</title>", html))'].join('\n');
  // [名字, 命令, 额外参数, 旧规则下是不是要审批]
  const samples: Array<[string, string, Record<string, string>, boolean]> = [
    ['1 写基线文档', `mkdir -p work && cat > work/baseline.md <<'EOF'\n${md}\nEOF`, {}, true],
    ['2 看目录和心智', 'ls -R . 2>/dev/null | head -50; echo ---; cat mind/* 2>/dev/null', {}, true],
    ['3 python 读标准输入', `cd work/signup && python3 - <<'EOF'\n${py}\nEOF`, {}, true],
    ['4 python -c 多行', `cd work/signup && python3 -c "${py}"`, {}, true],
    ['5 带 workdir', 'ls work/signup && python3 -V', { workdir: home }, true],
    ['6 通配符看同伴目录', `ls ${root}/bots/*/work/signup/ 2>/dev/null; ls ${root}/projects/prj_x/`, {}, true],
    // 样板第 7 条：家目录内的脚本，旧规则下本来就放行（总控裁定第 7 条：照实写）。
    ['7 运行家目录内脚本', 'python3 check.py', { cwd: `${home}/work/signup` }, false],
    ['8 建环境装依赖', 'python3 -m venv .venv && .venv/bin/pip install requests', {}, true],
  ];

  it.each(samples)('沙箱开着放行 %s，没有审批单', async (_name, command, extra) => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, 'exec', { command, ...extra }, SANDBOX);
    expect(decision, command).toEqual({ allow: true });
    expect(runtime.store.table('approvals').count()).toBe(0);
    expect(runtime.store.table('inbox').count()).toBe(0);
    expect(violations(runtime, bot.id)).toBe(0);
  });

  it.each(samples)('不传 sandboxed（证明开关有效）：%s', async (_name, command, extra, needsApproval) => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, 'exec', { command, ...extra });
    if (needsApproval) {
      expect(decision.allow, command).toBe(false);
      expect(runtime.store.table('approvals').count()).toBe(1);
    } else {
      expect(decision.allow).toBe(true);
      expect(runtime.store.table('approvals').count()).toBe(0);
    }
    // 宿主明确报 false，和不传一模一样。
    const other = setup();
    const explicit = await guard(other.runtime, other.bot.sessionId, 'exec', { command, ...extra }, { sandboxed: false, tmpDirs: ['/tmp'] });
    expect(explicit.allow).toBe(decision.allow);
    expect(other.runtime.store.table('approvals').count()).toBe(needsApproval ? 1 : 0);
  });

  it('总控裁定第 7 条：rm -f "$TMP" 和 rm <临时目录>/x.py 沙箱开着放行，不传时保持旧判定 D', async () => {
    for (const command of ['rm -f "$TMP"', `rm ${tmp}/x.py`, 'rm /tmp/x.py']) {
      const on = setup();
      expect((await guard(on.runtime, on.bot.sessionId, 'exec', { command }, SANDBOX)).allow, command).toBe(true);
      expect(on.runtime.store.table('approvals').count()).toBe(0);
      const off = setup();
      expect((await guard(off.runtime, off.bot.sessionId, 'exec', { command })).allow, command).toBe(false);
      expect(off.runtime.store.table('approvals').list()[0]?.actionClass).toBe('D');
    }
  });

  it('异步入口 guardToolCall 同样接受宿主报告', async () => {
    const { runtime, bot } = setup();
    expect(await guardToolCall(runtime, bot.sessionId, 'exec', { command: 'frobnicate --all' }, SANDBOX)).toEqual({ allow: true });
    const other = setup();
    expect((await guardToolCall(other.runtime, other.bot.sessionId, 'exec', { command: 'frobnicate --all' })).allow).toBe(false);
  });

  it('Hub.guardToolCall 的第 4 个参数透传；不传时行为不变', () => {
    const { runtime, bot } = setup();
    const hub = createHub(runtime);
    expect(hub.guardToolCall(bot.sessionId, 'exec', { command: 'frobnicate --all' }, SANDBOX)).toEqual({ allow: true });
    expect(runtime.store.table('approvals').count()).toBe(0);
    expect(hub.guardToolCall(bot.sessionId, 'exec', { command: 'frobnicate --all' }).allow).toBe(false);
    expect(runtime.store.table('approvals').count()).toBe(1);
  });
});

describe('P69 宿主报告的合规检查：不合规一律当没确认', () => {
  it.each([
    ['sandboxed 是字符串', { sandboxed: 'true' }], ['sandboxed 是数字', { sandboxed: 1 }], ['sandboxed 缺失', { tmpDirs: ['/tmp'] }], ['sandboxed 为 false', { sandboxed: false }],
    ['报了 null', null],
  ])('%s', async (_name, host) => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, 'exec', { command: 'frobnicate --all' }, host as never);
    expect(decision.allow).toBe(false);
  });

  it('临时目录清洗：根目录、中心根目录的上级、家目录的上级、相对路径、非字符串都被丢掉', () => {
    const { runtime, bot } = setup();
    const context = gateContextFor(runtime, runtime.store.table('bots').get(bot.id)!, { sandboxed: true,
      tmpDirs: ['/', owner, root, home, '/Users', 'tmp', '', 7 as never, '/tmp/', '/tmp', '/private/tmp'] });
    expect(context.sandboxed).toBe(true);
    // 只剩 /tmp（去掉尾斜杠、去重）和 /private/tmp。
    expect(context.tmpDirs).toEqual(['/tmp', '/private/tmp']);
  });

  it('没确认沙箱时：上下文里没有 sandboxed 和 tmpDirs；原生工具的上下文也不带项目目录，出站动作的上下文带', () => {
    const { runtime, bot } = setup();
    const row = runtime.store.table('bots').get(bot.id)!;
    const hubSide = gateContextFor(runtime, row);
    expect(hubSide.sandboxed).toBeUndefined();
    expect(hubSide.tmpDirs).toBeUndefined();
    expect(hubSide.projectDirs).toEqual([project]);
    expect(nativeGateContext(runtime, row).projectDirs).toEqual([]);
    expect(nativeGateContext(runtime, row, SANDBOX).projectDirs).toEqual([project]);
  });

  it('项目目录只算成员（含负责人）的、没归档的项目；目录不在 projects 之下的坏数据跳过', () => {
    const member = setup();
    expect(gateContextFor(member.runtime, member.runtime.store.table('bots').get(member.bot.id)!).projectDirs).toEqual([project]);
    const stranger = setup({ members: [] });
    expect(gateContextFor(stranger.runtime, stranger.runtime.store.table('bots').get(stranger.bot.id)!).projectDirs).toEqual([]);
    const lead = setup({ members: [], owner: botFixture.id });
    expect(gateContextFor(lead.runtime, lead.runtime.store.table('bots').get(lead.bot.id)!).projectDirs).toEqual([project]);
    const archived = setup({ archived: true });
    expect(gateContextFor(archived.runtime, archived.runtime.store.table('bots').get(archived.bot.id)!).projectDirs).toEqual([]);
    const bad = setup();
    const row = bad.runtime.store.table('projects').get(projectId)!;
    bad.runtime.store.table('projects').put({ ...row, sharedDir: '/etc/' });
    expect(gateContextFor(bad.runtime, bad.runtime.store.table('bots').get(bad.bot.id)!).projectDirs).toEqual([]);
  });
});

describe('P69 测试3 硬拦没有放松：沙箱开着照样拒绝并记越界', () => {
  const hard: Array<[string, string, unknown]> = [
    ['读 ssh 私钥', 'exec', { command: 'cat ~/.ssh/id_rsa' }],
    ['python 内联代码读私钥', 'exec', { command: `python3 -c "open('/Users/x/.ssh/id_rsa').read()"` }],
    ['python 内联代码读凭据（相对写法）', 'exec', { command: `python3 -c "print(open('.netrc').read())"` }],
    ['here-document 脚本里出现 .dsh/', 'exec', { command: `python3 - <<'EOF'\nprint(open('.dsh/config.yaml').read())\nEOF` }],
    ['写家目录 AGENTS.md（命令）', 'exec', { command: 'echo x > AGENTS.md' }],
    ['写家目录 AGENTS.md（写文件工具）', 'write_file', { path: `${home}/AGENTS.md`, content: 'x' }],
    ['rm -rf mind', 'exec', { command: 'rm -rf mind' }],
    ['改心智文件', 'write_file', { path: `${home}/mind/goals.md`, content: 'x' }],
    ['钥匙串命令', 'exec', { command: 'security find-generic-password -s x' }],
    ['git credential', 'exec', { command: 'git credential fill' }],
    ['未授权的工作数据', 'exec', { command: `cat ${owner}/CompanyWork/plan.md` }],
    ['读工作数据（读文件工具）', 'read_file', { path: `${owner}/CompanyWork/plan.md` }],
  ];
  it.each(hard)('拒绝并记越界：%s', async (_name, tool, args) => {
    const { runtime, bot } = setup();
    runtime.settings = resolveSettings({ rootDir: root, l3Grants: [], workDataPaths: [`${owner}/CompanyWork`] });
    const decision = await guard(runtime, bot.sessionId, tool, args, SANDBOX);
    expect(decision.allow).toBe(false);
    expect(violations(runtime, bot.id)).toBe(1);
    expect(runtime.store.table('approvals').count()).toBe(0);
  });

  it('反例：obj.key、process.env 放行，不记越界', async () => {
    for (const command of [`python3 -c "print(obj.key)"`, 'grep -r process.env src', `node -e "console.log(process.env.HOME)"`]) {
      const { runtime, bot } = setup();
      expect(await guard(runtime, bot.sessionId, 'exec', { command }, SANDBOX), command).toEqual({ allow: true });
      expect(violations(runtime, bot.id)).toBe(0);
    }
  });

  it('授权后读工作数据放行（反例，证明拦的是授权状态）', async () => {
    const { runtime, bot } = setup();
    runtime.settings = resolveSettings({ rootDir: root, l3Grants: [], workDataPaths: [`${owner}/CompanyWork`] });
    runtime.store.table('bots').patch(bot.id, { workDataAllowed: true });
    expect((await guard(runtime, bot.sessionId, 'read_file', { path: `${owner}/CompanyWork/plan.md` }, SANDBOX)).allow).toBe(true);
  });
});

describe('P69 测试5 指路：沙箱会拦的写入，不发卡', () => {
  const guided: Array<[string, string, unknown, string]> = [
    // P74r16a：断言由「固定的一句」改为「带被拦路径的一句」（依据任务卡第 2 节的逐字指路话）。
    ['cp 到项目目录', 'exec', { command: `cp work/a.html ${project}/` }, guideProject([project, `${project}/a.html`])],
    ['重定向写项目目录', 'exec', { command: `echo x > ${project}/a.txt` }, guideProject([`${project}/a.txt`])],
    ['写文件工具写项目目录', 'write_file', { path: `${project}/index.html`, content: 'x' }, guideProject([`${project}/index.html`])],
    ['write 工具写项目目录', 'write', { file_path: `${project}/index.html`, content: 'x' }, guideProject([`${project}/index.html`])],
    ['写共享目录', 'exec', { command: `echo x > ${shared}/a.txt` }, guideShared([`${shared}/a.txt`])],
    ['写桌面', 'exec', { command: `echo x > ${owner}/Desktop/a.txt` }, guideOther([`${owner}/Desktop/a.txt`])],
    ['写家目录以外的任意位置', 'write_file', { path: `${owner}/Desktop/b.txt`, content: 'x' }, guideOther([`${owner}/Desktop/b.txt`])],
    ['写别的项目的目录（不是成员）', 'exec', { command: `echo x > ${root}/projects/prj_other/a.txt` }, guideOther([`${root}/projects/prj_other/a.txt`])],
    ['curl 下载到桌面', 'exec', { command: `curl -o ${owner}/Desktop/a.html https://example.com/a.html` }, guideOther([`${owner}/Desktop/a.html`])],
  ];
  it.each(guided)('拒绝、不建审批单、不记越界、给指路的话：%s', async (_name, tool, args, message) => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, tool, args, SANDBOX);
    expect(decision).toEqual({ allow: false, message });
    expect(runtime.store.table('approvals').count()).toBe(0);
    expect(runtime.store.table('inbox').count()).toBe(0);
    expect(violations(runtime, bot.id)).toBe(0);
  });

  it('同样的调用，没确认沙箱：走原来的审批流程（证明指路由开关控制）', async () => {
    for (const [tool, args] of [['exec', { command: `echo x > ${owner}/Desktop/a.txt` }], ['write_file', { path: `${project}/index.html`, content: 'x' }], ['exec', { command: `cp work/a.html ${project}/` }]] as const) {
      const { runtime, bot } = setup();
      const decision = await guard(runtime, bot.sessionId, tool, args);
      expect(decision.allow).toBe(false);
      expect(decision.allow === false && decision.message).toContain('已提交审批单');
      expect(runtime.store.table('approvals').count()).toBe(1);
    }
  });

  it('同一条命令写了两种位置：每种各说一句，顺序是项目、共享、其他', async () => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, 'exec', { command: `cp work/a ${project}/ && cp work/b ${owner}/Desktop/` }, SANDBOX);
    expect(decision).toEqual({ allow: false, message: `${guideProject([project, `${project}/a`])}\n${guideOther([`${owner}/Desktop`, `${owner}/Desktop/b`])}` });
    expect(runtime.store.table('approvals').count()).toBe(0);
  });

  // P74r16a 第 2 节：原测试名「rm -rf ~/Documents/x：拒绝、不建审批单、记一次越界」，原来断言越界计数为 1，现在为 0（沙箱会拦的拒绝一律不计越界）。
  it('rm -rf ~/Documents/x：拒绝、不建审批单、不记越界（P74r16a 起）', async () => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, 'exec', { command: 'rm -rf ~/Documents/x' }, SANDBOX);
    expect(decision).toEqual({ allow: false, message: guideOther([`${owner}/Documents/x`]) });
    expect(runtime.store.table('approvals').count()).toBe(0);
    expect(violations(runtime, bot.id)).toBe(0);
  });

  // P74r16a 第 2 节：原测试名「写系统目录（D）：同样指路并记越界」，原来断言越界计数为 1，现在为 0。
  it('写系统目录（D）：同样指路，不记越界（P74r16a 起）', async () => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, 'exec', { command: 'echo x > /etc/hosts' }, SANDBOX);
    expect(decision).toEqual({ allow: false, message: guideOther(['/etc/hosts']) });
    expect(violations(runtime, bot.id)).toBe(0);
    expect(runtime.store.table('approvals').count()).toBe(0);
  });

  it('cp work/a.html ~/Desktop/ && git push：走审批（git_push），不走指路；审批单记下了全部待确认事项', async () => {
    const { runtime, bot } = setup();
    const decision = await guard(runtime, bot.sessionId, 'exec', { command: `cp work/a.html ${owner}/Desktop/ && git push origin main` }, SANDBOX);
    expect(decision.allow).toBe(false);
    expect(decision.allow === false && decision.message).toContain('已提交审批单');
    const approvals = runtime.store.table('approvals').list();
    expect(approvals).toHaveLength(1);
    const asks = approvals[0]!.asks!;
    expect(asks.map(ask => ask.subclass)).toEqual(expect.arrayContaining(['git_push', 'write_file']));
    expect(asks.find(ask => ask.subclass === 'git_push')).toMatchObject({ cls: 'C', detail: 'origin main' });
    expect(asks.find(ask => ask.subclass === 'write_file')).toMatchObject({ blocked: true, paths: [`${owner}/Desktop`] });
    expect(violations(runtime, bot.id)).toBe(0);
  });

  it('指路时不消费批准票', async () => {
    const { runtime, bot } = setup();
    // 先在没确认沙箱时被要求审批，批准，再换成沙箱开着：这张票留着，不被指路吃掉。
    const args = { command: `echo x > ${owner}/Desktop/a.txt` };
    await guard(runtime, bot.sessionId, 'exec', args);
    const approval = runtime.store.table('approvals').list()[0]!;
    runtime.store.table('approvals').patch(approval.id, { status: 'approved', decidedAt: runtime.clock.now() });
    expect((await guard(runtime, bot.sessionId, 'exec', args, SANDBOX)).allow).toBe(false);
    expect(runtime.store.table('approvals').get(approval.id)?.status).toBe('approved');
    // 没确认沙箱时这张票照常被消费放行（旧行为）。
    expect((await guard(runtime, bot.sessionId, 'exec', args)).allow).toBe(true);
    expect(runtime.store.table('approvals').get(approval.id)?.status).toBe('used');
  });

  it('hub_ 工具不走指路', async () => {
    const { runtime, bot } = setup();
    expect(await guard(runtime, bot.sessionId, 'hub_outbox_submit', { kind: 'write_file', payload: { path: `${owner}/Desktop/a`, content: 'x' } }, SANDBOX)).toEqual({ allow: true });
  });

  // 上面那条里 hub_ 工具在分类器里一律是 A，永远不会带 blocked，守卫里的 !tool.startsWith('hub_') 删掉它也照样过。
  // 这里直接给守卫塞一个「沙箱会拦」的判定（verifiedAction），同一个判定换成 exec 工具会被指路，换成 hub_ 工具就必须走审批，不能被指路。
  it('hub_ 工具不走指路：即使判定带着 blocked，也走审批而不是指路（删掉守卫里的 hub_ 例外这条会变红）', async () => {
    const blocked = { cls: 'C' as const, reason: '写入家目录或共享目录以外的文件', subclass: 'write_file', blocked: true, paths: [`${owner}/Desktop/a`] };
    const call = async (tool: string) => {
      const { runtime, bot } = setup();
      const effects: Promise<unknown>[] = [];
      const decision = guardToolCallSync(runtime, bot.sessionId, tool, { path: `${owner}/Desktop/a` }, effect => { effects.push(effect); }, blocked, SANDBOX);
      await Promise.all(effects);
      return { decision, approvals: runtime.store.table('approvals').count() };
    };
    const native = await call('write');
    expect(native.decision).toEqual({ allow: false, message: guideOther([`${owner}/Desktop/a`]) });
    expect(native.approvals).toBe(0);
    const hub = await call('hub_outbox_submit');
    expect(hub.decision.allow).toBe(false);
    expect(hub.decision).not.toEqual({ allow: false, message: guideOther([`${owner}/Desktop/a`]) });
    expect(hub.approvals).toBe(1);
  });
});

describe('P69 自主等级、交账和复盘（总控裁定第 1 条）', () => {
  it('L0：sandboxed_exec、tmp 拒绝（A 类非白名单子类），只读照旧放行；L1 及以上放行', async () => {
    const l0 = setup({ autonomy: 'L0' });
    expect((await guard(l0.runtime, l0.bot.sessionId, 'exec', { command: 'frobnicate' }, SANDBOX)).allow).toBe(false);
    expect((await guard(l0.runtime, l0.bot.sessionId, 'exec', { command: `echo x > ${tmp}/a` }, SANDBOX)).allow).toBe(false);
    expect((await guard(l0.runtime, l0.bot.sessionId, 'exec', { command: 'ls work' }, SANDBOX)).allow).toBe(true);
    expect(l0.runtime.store.table('approvals').count()).toBe(0);
    for (const autonomy of ['L1', 'L2', 'L3'] as const) {
      const level = setup({ autonomy });
      expect((await guard(level.runtime, level.bot.sessionId, 'exec', { command: 'frobnicate' }, SANDBOX)).allow, autonomy).toBe(true);
    }
    const probation = setup({ autonomy: 'L0', lifecycle: 'probation' });
    expect((await guard(probation.runtime, probation.bot.sessionId, 'exec', { command: 'frobnicate' }, SANDBOX)).allow).toBe(true);
  });

  it('本轮已交账：不能再做非只读动作（sandboxed_exec 也一样）', async () => {
    const { runtime, bot } = setup();
    runtime.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id, sessionId: bot.sessionId, status: 'committed', variant: 'regular' });
    const decision = await guard(runtime, bot.sessionId, 'exec', { command: 'frobnicate' }, SANDBOX);
    expect(decision).toMatchObject({ allow: false, message: expect.stringContaining('本轮已交账') });
    expect((await guard(runtime, bot.sessionId, 'exec', { command: 'ls work' }, SANDBOX)).allow).toBe(true);
  });

  it('复盘回合：本卡的放宽一律不生效，宿主怎么报都按旧规则；拒绝但不记越界，也没有新增 protected', async () => {
    const { runtime, bot } = setup();
    runtime.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id, sessionId: bot.sessionId, variant: 'reflection' });
    for (const command of ['frobnicate', `python3 -c "print(1)"`, `echo x > ${tmp}/a`, `echo x > ${owner}/Desktop/a`, 'git commit -m x', 'rm -f "$TMP"']) {
      const decision = await guard(runtime, bot.sessionId, 'exec', { command }, SANDBOX);
      expect(decision, command).toEqual({ allow: false, message: '复盘回合只读，不能执行需要审批的动作' });
    }
    expect(violations(runtime, bot.id)).toBe(0);
    expect(runtime.store.table('approvals').count()).toBe(0);
    // 复盘照旧可以做的事：读。P75r6 同步（第 1 节第 5 条）：原来这里还断言「写 work」放行（touch work/a），现在技能类回合一律只读，写 work 也拒绝（不计越界）。
    expect(await guard(runtime, bot.sessionId, 'exec', { command: 'touch work/a' }, SANDBOX)).toEqual({ allow: false, message: '复盘回合只读，不能执行需要审批的动作' });
    expect((await guard(runtime, bot.sessionId, 'exec', { command: 'ls work' }, SANDBOX)).allow).toBe(true);
    // 硬拦在复盘里照旧（凭据仍然 protected）。
    expect((await guard(runtime, bot.sessionId, 'exec', { command: 'cat ~/.ssh/id_rsa' }, SANDBOX)).allow).toBe(false);
    expect(violations(runtime, bot.id)).toBe(1);
  });

  it('复盘回合里 gateContextFor 把 sandboxed 当作没确认', () => {
    const { runtime, bot } = setup();
    runtime.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id, sessionId: bot.sessionId, variant: 'reflection' });
    const context = gateContextFor(runtime, runtime.store.table('bots').get(bot.id)!, SANDBOX);
    expect(context.reflection).toBe(true);
    expect(context.sandboxed).toBeUndefined();
  });
});

describe('P69 测试6 项目文件夹：成员经中心代写不审批', () => {
  it('成员 hub_outbox_submit write_file 写自己项目的文件夹：直接完成，没有审批单', async () => {
    const { runtime, bot } = setup();
    const row = await submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${project}/index.html`, content: '<h1>报名</h1>' }, why: '交付页面' });
    expect(row).toMatchObject({ status: 'ready', actionClass: 'A', approvalId: null });
    await executeReadyOutbox(runtime);
    expect(await runtime.fs.readText(`${project}/index.html`)).toBe('<h1>报名</h1>');
    expect(runtime.store.table('outbox').get(row.id)?.status).toBe('done');
    expect(runtime.store.table('approvals').count()).toBe(0);
    expect(violations(runtime, bot.id)).toBe(0);
  });

  it('负责人（不在成员名单里）同样算成员', async () => {
    const { runtime, bot } = setup({ members: [], owner: botFixture.id });
    const row = await submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${project}/a.txt`, content: 'x' }, why: '交付' });
    expect(row.status).toBe('ready');
  });

  it('非成员：照旧审批（C）', async () => {
    const { runtime, bot } = setup({ members: [] });
    const row = await submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${project}/index.html`, content: 'x' }, why: '交付' });
    expect(row).toMatchObject({ status: 'pending_approval', actionClass: 'C' });
    expect(runtime.store.table('approvals').count()).toBe(1);
    expect(await runtime.fs.readText(`${project}/index.html`)).toBeNull();
  });

  it('已归档的项目：照旧审批（C）', async () => {
    const { runtime, bot } = setup({ archived: true });
    const row = await submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${project}/index.html`, content: 'x' }, why: '交付' });
    expect(row).toMatchObject({ status: 'pending_approval', actionClass: 'C' });
  });

  it('别的项目的目录：照旧审批', async () => {
    const { runtime, bot } = setup();
    const row = await submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${root}/projects/prj_other/a.txt`, content: 'x' }, why: '交付' });
    expect(row.status).toBe('pending_approval');
  });

  it('项目文件夹里中心维护的 context.md：仍要审批', async () => {
    const { runtime, bot } = setup();
    const row = await submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${project}/context.md`, content: 'x' }, why: '改上下文' });
    expect(row.status).toBe('pending_approval');
  });

  it('项目文件夹里的敏感文件名：拒绝并记越界', async () => {
    const { runtime, bot } = setup();
    await expect(submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${project}/.env`, content: 'KEY=1' }, why: '交付' })).rejects.toThrow();
    expect(violations(runtime, bot.id)).toBe(1);
  });

  it('项目文件夹被换成指向别处的符号链接：拒绝，不借「写自己的项目」免审批', async () => {
    const { runtime, bot } = setup();
    const realpath = runtime.fs.realpath.bind(runtime.fs);
    // 内存文件系统没有真的符号链接：让项目文件夹里的路径解析到界外，模拟「项目目录自己被换成链接」。
    runtime.fs.realpath = async (path: string) => path === project || path.startsWith(`${project}/`) ? path.replace(project, '/elsewhere/prj') : realpath(path);
    await expect(submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${project}/index.html`, content: 'x' }, why: '交付' })).rejects.toThrow('项目文件夹');
    expect(runtime.store.table('approvals').count()).toBe(0);
    expect(await runtime.fs.readText('/elsewhere/prj/index.html')).toBeNull();
  });

  it('执行时写入带边界：边界是项目文件夹本身', async () => {
    const { runtime, bot } = setup();
    const boundaries: unknown[] = [];
    const original = runtime.fs.writeTextAtomic.bind(runtime.fs);
    runtime.fs.writeTextAtomic = async (path, text, boundary) => { boundaries.push(boundary); return original(path, text, boundary); };
    await submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${project}/sub/a.txt`, content: 'x' }, why: '交付' });
    await executeReadyOutbox(runtime);
    expect(boundaries).toEqual([{ within: project }]);
  });
});

describe('P69 测试8 出站命令没有被放松', () => {
  it('hub_outbox_submit run_command 跑 python3 work/x.py 仍然要审批（M12），不受项目目录和沙箱开关影响', async () => {
    const { runtime, bot } = setup({ autonomy: 'L3' });
    runtime.settings = resolveSettings({ rootDir: root, l3Grants: ['run_command', 'host_command', 'sandboxed_exec'] });
    await runtime.fs.writeTextAtomic(`${home}/work/x.py`, 'print(1)\n');
    const row = await submitOutbox(runtime, bot.id, { kind: 'run_command', payload: { cmd: 'python3', args: ['work/x.py'], cwd: home }, why: '自测' });
    expect(row).toMatchObject({ status: 'pending_approval', actionClass: 'C' });
    const approval = runtime.store.table('approvals').list()[0]!;
    // 分类结果随审批单存下来，下一步生成人话要用。
    expect(approval.asks?.[0]).toMatchObject({ cls: 'C', subclass: 'host_command' });
  });

  it('未识别的程序和内联代码经出站命令仍是至少 C', async () => {
    for (const payload of [{ cmd: 'frobnicate', args: [], cwd: home }, { cmd: 'python3', args: ['-c', 'print(1)'], cwd: home }, { cmd: 'ls', args: ['work'], cwd: home }]) {
      const { runtime, bot } = setup({ autonomy: 'L2' });
      const row = await submitOutbox(runtime, bot.id, { kind: 'run_command', payload, why: '自测' });
      expect(row.status, JSON.stringify(payload)).toBe('pending_approval');
    }
  });

  it('出站命令写项目目录的路径（命令参数里）不因项目目录而免审批', async () => {
    const { runtime, bot } = setup({ autonomy: 'L2' });
    const row = await submitOutbox(runtime, bot.id, { kind: 'run_command', payload: { cmd: 'cp', args: ['work/a', `${project}/a`], cwd: home }, why: '搬运' });
    expect(row.status).toBe('pending_approval');
  });
});

describe('P69 审批单上存的分类结果（留给 A-2 生成人话）', () => {
  it('守卫建单时把 asks 存下来；不传时旧调用方式的审批单没有这一项', async () => {
    const { runtime, bot } = setup();
    await guard(runtime, bot.sessionId, 'exec', { command: 'git push origin main' }, SANDBOX);
    const approval = runtime.store.table('approvals').list()[0]!;
    expect(approval.asks).toEqual([expect.objectContaining({ cls: 'C', subclass: 'git_push', detail: 'origin main' })]);
    // 旧签名（6 个位置参数）仍然可用，审批单没有 asks。
    const { prepareApproval } = await import('../src/gate/approvals.js');
    const legacy = prepareApproval(runtime, bot.id, 'write', { path: '/x/y' }, 'C', '旧调用');
    expect(legacy.approval.asks).toBeUndefined();
  });

  it('多件事都留着：下载、发送、删除各一条', async () => {
    const { runtime, bot } = setup();
    await guard(runtime, bot.sessionId, 'exec', { command: `curl -d a=1 https://api.example.com/x && ssh build.example.com id` }, SANDBOX);
    const asks = runtime.store.table('approvals').list()[0]!.asks!;
    expect(asks.map(ask => [ask.subclass, ask.detail])).toEqual([['http_post', 'api.example.com'], ['remote_access', 'ssh 到 build.example.com']]);
  });
});
