/**
 * P69 A-2 测试 7：新工具 hub_project_put（把家目录里的成品放进项目文件夹，成员免审批）。
 *
 * 用内存文件系统，路径全是假的：主人 /Users/owner，中心根目录 /Users/owner/AgentHub。
 * 每条断言都落在具体结果上（文件内容、返回的话、系统消息、有没有半成品），改坏实现就会红。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings, P69_DEFAULTS } from '../src/config/defaults.js';
import { buildTools, runTool } from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';
import { ProjectSchema, ProjectTopicSchema, WakeTicketSchema } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';
import { projectPutNote } from '../src/project/project-put.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

const owner = '/Users/owner', root = `${owner}/AgentHub`, home = `${root}/bots/b_0000000001`;
const prjA = 'prj_0000000001', prjB = 'prj_0000000002';
const dirOf = (id: string) => `${root}/projects/${id}`;

interface Options { autonomy?: 'L0' | 'L1' | 'L2' | 'L3'; lifecycle?: 'active' | 'probation'; members?: string[]; archived?: boolean; secondProject?: boolean }

/** 一个带机器人和项目 A 的环境（可选再加项目 B）。机器人默认是项目成员。 */
function setup(options: Options = {}) {
  const ctx = createTestContext({ ownerHome: owner });
  ctx.settings = resolveSettings({ rootDir: root, l3Grants: [] });
  const bot = { ...botFixture, name: '工程师', sessionId: 'session-put', homeDir: home, autonomy: options.autonomy ?? 'L2', lifecycle: options.lifecycle ?? 'active' };
  ctx.store.table('bots').put(bot);
  const now = ctx.clock.now();
  const addProject = (id: string, members: string[], archived = false) => ctx.store.table('projects').put(ProjectSchema.parse({
    id, name: id === prjA ? '报名页' : '落地页', charter: '', status: archived ? 'archived' : 'active', ownerBotId: null, memberBotIds: members,
    sharedDir: `${dirOf(id)}/`, acceptanceCriteria: [], createdAt: now, updatedAt: now, archivedAt: archived ? now : null }));
  addProject(prjA, options.members ?? [bot.id], options.archived);
  if (options.secondProject) addProject(prjB, [bot.id]);
  const tc: ToolContext = { botId: bot.id, sessionId: bot.sessionId, wakeId: null };
  return { ctx, bot, tc };
}
const put = (ctx: HubContext, tc: ToolContext, args: unknown) => runTool(ctx, tc, 'hub_project_put', args);
const write = (ctx: HubContext, path: string, text: string) => ctx.fs.writeTextAtomic(path, text);
const errorOf = (result: Awaited<ReturnType<typeof put>>): string => { expect(result.ok).toBe(false); return result.ok ? '' : result.error; };
const textOf = (result: Awaited<ReturnType<typeof put>>): string => { expect(result.ok, JSON.stringify(result)).toBe(true); return result.ok ? result.text : ''; };
const systemLines = (ctx: HubContext, thread: string) => ctx.store.log('thread').all().filter(row => row.thread === thread && row.kind === 'system').map(row => row.text);
/** 给机器人加一个项目会话主题，以及一张在这个主题里进行的唤醒单。 */
function inTopic(ctx: HubContext, bot: { id: string; sessionId: string }, projectId: string) {
  const now = ctx.clock.now();
  const topic = ProjectTopicSchema.parse({ id: 'ptp_0000000001', projectId, title: '做报名页', createdAt: now, updatedAt: now, lastMessageAt: now, agentTurnsSinceOwner: 0, pendingBotIds: [] });
  ctx.store.table('projectTopics').put(topic);
  const wake = { ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id, sessionId: bot.sessionId, topicId: topic.id, status: 'running' as const, endedAt: null };
  ctx.store.table('wakes').put(wake);
  return { topic, wake, tc: { botId: bot.id, sessionId: bot.sessionId, wakeId: wake.id } satisfies ToolContext };
}

describe('P69 测试7 hub_project_put：正例', () => {
  it('单个文件：放进项目文件夹，内容一致，返回路径清单，不产生审批单', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/index.html`, '<h1>报名</h1>');
    const text = textOf(await put(ctx, tc, { from: 'work/index.html' }));
    expect(await ctx.fs.readText(`${dirOf(prjA)}/index.html`)).toBe('<h1>报名</h1>');
    expect(text).toContain('index.html');
    expect(text).toContain('报名页');
    expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.store.table('inbox').count()).toBe(0);
    // 来源文件原样还在，是复制不是搬走。
    expect(await ctx.fs.readText(`${home}/work/index.html`)).toBe('<h1>报名</h1>');
  });

  it('整个文件夹：保留里面的层级；指定 to 时放在 to 下面', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/site/index.html`, 'A');
    await write(ctx, `${home}/work/site/css/main.css`, 'B');
    textOf(await put(ctx, tc, { from: 'work/site' }));
    expect(await ctx.fs.readText(`${dirOf(prjA)}/site/index.html`)).toBe('A');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/site/css/main.css`)).toBe('B');
    textOf(await put(ctx, tc, { from: 'work/site', to: 'release/v1' }));
    expect(await ctx.fs.readText(`${dirOf(prjA)}/release/v1/index.html`)).toBe('A');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/release/v1/css/main.css`)).toBe('B');
  });

  it('绝对路径的 from（家目录内）也可以；to 以斜杠结尾时保留原文件名', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/a.txt`, 'x');
    textOf(await put(ctx, tc, { from: `${home}/work/a.txt`, to: 'docs/' }));
    expect(await ctx.fs.readText(`${dirOf(prjA)}/docs/a.txt`)).toBe('x');
  });

  it('同名文件直接覆盖', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/a.txt`, '新版');
    await write(ctx, `${dirOf(prjA)}/a.txt`, '旧版');
    textOf(await put(ctx, tc, { from: 'work/a.txt' }));
    expect(await ctx.fs.readText(`${dirOf(prjA)}/a.txt`)).toBe('新版');
  });

  it('二进制文件复制前后字节一致（含不能按 UTF-8 解码的字节）', async () => {
    const { ctx, tc } = setup();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x00, 0x01]);
    await ctx.fs.writeBytesAtomic(`${home}/work/logo.png`, bytes);
    textOf(await put(ctx, tc, { from: 'work/logo.png' }));
    const copied = await ctx.fs.readBytes(`${dirOf(prjA)}/logo.png`);
    expect(Array.from(copied!)).toEqual(Array.from(bytes));
    // 改动来源数组不影响已放进去的文件（拿到的是副本）。
    bytes[0] = 0;
    expect((await ctx.fs.readBytes(`${dirOf(prjA)}/logo.png`))![0]).toBe(0x89);
  });

  it('省略 project：只在一个未归档项目里时用它', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/a.txt`, 'x');
    textOf(await put(ctx, tc, { from: 'work/a.txt' }));
    expect(await ctx.fs.readText(`${dirOf(prjA)}/a.txt`)).toBe('x');
  });

  it('省略 project：在两个项目里又不在项目会话里，报错并列出项目 id；写明 project 就能放', async () => {
    const { ctx, tc } = setup({ secondProject: true });
    await write(ctx, `${home}/work/a.txt`, 'x');
    const error = errorOf(await put(ctx, tc, { from: 'work/a.txt' }));
    expect(error).toContain(prjA);
    expect(error).toContain(prjB);
    expect(await ctx.fs.readText(`${dirOf(prjA)}/a.txt`)).toBeNull();
    textOf(await put(ctx, tc, { from: 'work/a.txt', project: prjB }));
    expect(await ctx.fs.readText(`${dirOf(prjB)}/a.txt`)).toBe('x');
  });

  it('在项目会话回合里省略 project：用这个会话的项目，并在会话里写一条系统消息', async () => {
    const { ctx, bot } = setup({ secondProject: true });
    const { topic, tc } = inTopic(ctx, bot, prjB);
    await write(ctx, `${home}/work/index.html`, 'x');
    textOf(await put(ctx, tc, { from: 'work/index.html' }));
    expect(await ctx.fs.readText(`${dirOf(prjB)}/index.html`)).toBe('x');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/index.html`)).toBeNull();
    expect(systemLines(ctx, topic.id)).toEqual(['工程师把「index.html」放进了项目文件夹']);
  });

  it('放进的不是这个会话的项目时，不在这个会话里写系统消息', async () => {
    const { ctx, bot } = setup({ secondProject: true });
    const { topic, tc } = inTopic(ctx, bot, prjB);
    await write(ctx, `${home}/work/a.txt`, 'x');
    textOf(await put(ctx, tc, { from: 'work/a.txt', project: prjA }));
    expect(systemLines(ctx, topic.id)).toEqual([]);
  });

  it('不在项目会话里：不写系统消息（私聊线程里也没有）', async () => {
    const { ctx, bot, tc } = setup();
    await write(ctx, `${home}/work/a.txt`, 'x');
    textOf(await put(ctx, tc, { from: 'work/a.txt' }));
    expect(systemLines(ctx, bot.id)).toEqual([]);
  });

  it('系统消息三种写法：一个、2 到 3 个、更多', async () => {
    const { ctx, bot } = setup();
    const { topic, tc } = inTopic(ctx, bot, prjA);
    for (const name of ['a', 'b', 'c', 'd', 'e']) await write(ctx, `${home}/work/pack/${name}.txt`, name);
    await write(ctx, `${home}/work/one.txt`, '1');
    await write(ctx, `${home}/work/three/x.txt`, 'x');
    await write(ctx, `${home}/work/three/y.txt`, 'y');
    await write(ctx, `${home}/work/three/z.txt`, 'z');
    textOf(await put(ctx, tc, { from: 'work/one.txt' }));
    textOf(await put(ctx, tc, { from: 'work/three' }));
    textOf(await put(ctx, tc, { from: 'work/pack' }));
    expect(systemLines(ctx, topic.id)).toEqual([
      '工程师把「one.txt」放进了项目文件夹',
      '工程师放进了 3 个文件：「three/x.txt」、「three/y.txt」、「three/z.txt」',
      '工程师放进了 5 个文件：「pack/a.txt」、「pack/b.txt」、「pack/c.txt」 等 5 个文件',
    ]);
  });

  it('系统消息里的文件名不带换行和控制字符，也不会很长', () => {
    const note = projectPutNote('工程师', [`a\nb\u0007${'长'.repeat(100)}.txt`]);
    expect(note).not.toMatch(/[\n\u0007]/);
    expect(Array.from(note).length).toBeLessThan(100);
  });

  it('返回的清单最多列 20 条，多了写「等 N 个」', async () => {
    const { ctx, tc } = setup();
    for (let index = 0; index < 25; index += 1) await write(ctx, `${home}/work/many/f${String(index).padStart(2, '0')}.txt`, 'x');
    const text = textOf(await put(ctx, tc, { from: 'work/many' }));
    expect(text).toContain('f00.txt');
    expect(text).toContain('f19.txt');
    expect(text).not.toContain('f20.txt');
    expect(text).toContain('等 25 个');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/many/f24.txt`)).toBe('x');
  });

  it('试岗、L1、L2 都能用；负责人（不在成员名单里）也算成员', async () => {
    for (const options of [{ autonomy: 'L1' as const }, { autonomy: 'L2' as const }, { lifecycle: 'probation' as const, autonomy: 'L1' as const }]) {
      const { ctx, tc } = setup(options);
      await write(ctx, `${home}/work/a.txt`, 'x');
      textOf(await put(ctx, tc, { from: 'work/a.txt' }));
    }
    const { ctx, tc } = setup({ members: [] });
    ctx.store.table('projects').patch(prjA, { ownerBotId: botFixture.id });
    await write(ctx, `${home}/work/a.txt`, 'x');
    textOf(await put(ctx, tc, { from: 'work/a.txt' }));
  });

  it('工具已登记，描述里写明不需要批准', () => {
    const { ctx } = setup();
    const tool = buildTools(ctx).find(item => item.name === 'hub_project_put');
    expect(tool?.description).toContain('不需要主人批准');
    expect(tool?.jsonSchema).toMatchObject({ type: 'object', required: ['from'] });
  });
});

describe('P69 测试7 hub_project_put：反例', () => {
  it('非成员：回答和项目不存在时一模一样，不泄露项目存在，也没有写入', async () => {
    const { ctx, tc } = setup({ members: [] });
    await write(ctx, `${home}/work/a.txt`, 'x');
    const notMember = errorOf(await put(ctx, tc, { from: 'work/a.txt', project: prjA }));
    const missing = errorOf(await put(ctx, tc, { from: 'work/a.txt', project: 'prj_0000000099' }));
    expect(notMember.replace(prjA, 'ID')).toBe(missing.replace('prj_0000000099', 'ID'));
    expect(notMember).toContain('不存在');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/a.txt`)).toBeNull();
    // 省略 project 时也一样不能放进别人的项目：没有可用项目。
    expect(errorOf(await put(ctx, tc, { from: 'work/a.txt' }))).not.toContain(prjA);
  });

  it('已归档的项目：和不存在同一句话，没有写入', async () => {
    const { ctx, tc } = setup({ archived: true });
    await write(ctx, `${home}/work/a.txt`, 'x');
    const archived = errorOf(await put(ctx, tc, { from: 'work/a.txt', project: prjA }));
    const missing = errorOf(await put(ctx, tc, { from: 'work/a.txt', project: 'prj_0000000099' }));
    expect(archived.replace(prjA, 'ID')).toBe(missing.replace('prj_0000000099', 'ID'));
    expect(await ctx.fs.readText(`${dirOf(prjA)}/a.txt`)).toBeNull();
  });

  it('from 在家目录外：绝对路径、../ 逃出、别的队友的家目录、家目录本身，都拒绝', async () => {
    const { ctx, tc } = setup();
    await write(ctx, '/etc/hosts', 'x');
    await write(ctx, `${root}/bots/b_0000000002/work/secret.txt`, 'x');
    for (const from of ['/etc/hosts', '../../../../../../etc/hosts', `${root}/bots/b_0000000002/work/secret.txt`, '../b_0000000002/work/secret.txt', '.', home]) {
      expect(errorOf(await put(ctx, tc, { from })), from).toContain('from');
    }
    expect(await ctx.fs.list(dirOf(prjA))).toEqual([]);
  });

  it('from 不存在：说明找不到', async () => {
    const { ctx, tc } = setup();
    expect(errorOf(await put(ctx, tc, { from: 'work/nothing.txt' }))).toContain('找不到');
  });

  it('from 是敏感文件，或文件夹里有敏感文件：整次拒绝，什么都不写', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/.env`, 'KEY=1');
    expect(errorOf(await put(ctx, tc, { from: 'work/.env' }))).toContain('敏感');
    await write(ctx, `${home}/work/site/index.html`, 'ok');
    await write(ctx, `${home}/work/site/.ssh/id_rsa`, 'secret');
    expect(errorOf(await put(ctx, tc, { from: 'work/site' }))).toContain('敏感');
    await write(ctx, `${home}/work/cert/server.pem`, 'x');
    expect(errorOf(await put(ctx, tc, { from: 'work/cert/server.pem' }))).toContain('敏感');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/site/index.html`)).toBeNull();
  });

  it('from 是中心维护的文件：mind/、memory/journal/、家目录的 AGENTS.md', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/mind/goals.md`, 'x');
    await write(ctx, `${home}/memory/journal/2026-11-10.md`, 'x');
    await write(ctx, `${home}/AGENTS.md`, 'x');
    for (const from of ['mind/goals.md', 'memory/journal/2026-11-10.md', 'AGENTS.md', 'mind', 'memory']) {
      expect(errorOf(await put(ctx, tc, { from })), from).toContain('中心维护');
    }
    // 普通的 memory/MEMORY.md 不受影响。
    await write(ctx, `${home}/memory/MEMORY.md`, 'x');
    textOf(await put(ctx, tc, { from: 'memory/MEMORY.md' }));
  });

  it('from 里有符号链接：不跟随，直接报错并说明是哪一个', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/real.txt`, 'x');
    ctx.fs.markSymlink(`${home}/work/link.txt`);
    expect(errorOf(await put(ctx, tc, { from: 'work/link.txt' }))).toContain('work/link.txt 是符号链接');
    await write(ctx, `${home}/work/site/a.txt`, 'x');
    await write(ctx, `${home}/work/site/inner/b.txt`, 'x');
    ctx.fs.markSymlink(`${home}/work/site/inner`);
    expect(errorOf(await put(ctx, tc, { from: 'work/site' }))).toContain('work/site/inner 是符号链接');
    // 来源的上级目录是符号链接也不行。
    ctx.fs.markSymlink(`${home}/work`);
    expect(errorOf(await put(ctx, tc, { from: 'work/real.txt' }))).toContain('work 是符号链接');
    expect(await ctx.fs.list(dirOf(prjA))).toEqual([]);
  });

  it('to 用 ../ 或绝对路径逃出项目文件夹：拒绝，项目外没有任何写入', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/a.txt`, 'x');
    for (const to of ['../escape.txt', 'a/../../escape.txt', '/etc/escape.txt', '..']) {
      expect(errorOf(await put(ctx, tc, { from: 'work/a.txt', to })), to).toContain('to');
    }
    expect(await ctx.fs.readText(`${root}/projects/escape.txt`)).toBeNull();
    expect(await ctx.fs.readText('/etc/escape.txt')).toBeNull();
  });

  it('to 落在中心维护的 context.md 上：拒绝', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/a.txt`, '改写');
    await write(ctx, `${dirOf(prjA)}/context.md`, '原文');
    expect(errorOf(await put(ctx, tc, { from: 'work/a.txt', to: 'context.md' }))).toContain('context.md');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/context.md`)).toBe('原文');
  });

  it('项目文件夹被换成符号链接：拒绝（标记为链接，或真实位置跑出了中心的项目目录）', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/a.txt`, 'x');
    ctx.fs.markSymlink(dirOf(prjA));
    expect(errorOf(await put(ctx, tc, { from: 'work/a.txt' }))).toContain('符号链接');
    const second = setup();
    await write(second.ctx, `${home}/work/a.txt`, 'x');
    const realpath = second.ctx.fs.realpath.bind(second.ctx.fs);
    second.ctx.fs.realpath = async (path: string) => path === dirOf(prjA) ? '/elsewhere/prj' : realpath(path);
    expect(errorOf(await put(second.ctx, second.tc, { from: 'work/a.txt' }))).toContain('真实位置');
    expect(await second.ctx.fs.readText('/elsewhere/prj/a.txt')).toBeNull();
  });

  it('项目文件夹里的某一级是符号链接：拒绝', async () => {
    const { ctx, tc } = setup();
    await write(ctx, `${home}/work/a.txt`, 'x');
    ctx.fs.markSymlink(`${dirOf(prjA)}/sub`);
    expect(errorOf(await put(ctx, tc, { from: 'work/a.txt', to: 'sub/a.txt' }))).toContain('sub 是符号链接');
  });

  it('超过文件个数上限：说明超的是个数和当前数量，什么都不写', async () => {
    const { ctx, tc } = setup();
    for (let index = 0; index <= P69_DEFAULTS.projectPutMaxFiles; index += 1) await write(ctx, `${home}/work/big/f${index}.txt`, 'x');
    const error = errorOf(await put(ctx, tc, { from: 'work/big' }));
    expect(error).toContain('文件太多');
    expect(error).toContain(String(P69_DEFAULTS.projectPutMaxFiles));
    expect(error).toContain(String(P69_DEFAULTS.projectPutMaxFiles + 1));
    expect(await ctx.fs.list(dirOf(prjA))).toEqual([]);
    // 刚好 500 个可以。
    await ctx.fs.remove(`${home}/work/big/f0.txt`);
    textOf(await put(ctx, tc, { from: 'work/big' }));
    expect((await ctx.fs.list(`${dirOf(prjA)}/big`)).length).toBe(P69_DEFAULTS.projectPutMaxFiles);
  });

  it('超过总大小上限：说明超的是大小和当前大小，什么都不写', async () => {
    const { ctx, tc } = setup();
    await ctx.fs.writeBytesAtomic(`${home}/work/huge.bin`, new Uint8Array(P69_DEFAULTS.projectPutMaxBytes + 1));
    const error = errorOf(await put(ctx, tc, { from: 'work/huge.bin' }));
    expect(error).toContain('文件太大');
    expect(error).toContain('20 MB');
    expect(error).toContain('20.0 MB');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/huge.bin`)).toBeNull();
    // 合计超限（两个各 11 MB）同样拒绝；刚好 20 MB 可以。
    await ctx.fs.writeBytesAtomic(`${home}/work/two/a.bin`, new Uint8Array(11 * 1024 * 1024));
    await ctx.fs.writeBytesAtomic(`${home}/work/two/b.bin`, new Uint8Array(11 * 1024 * 1024));
    expect(errorOf(await put(ctx, tc, { from: 'work/two' }))).toContain('文件太大');
    await ctx.fs.writeBytesAtomic(`${home}/work/exact.bin`, new Uint8Array(P69_DEFAULTS.projectPutMaxBytes));
    textOf(await put(ctx, tc, { from: 'work/exact.bin' }));
  });

  it('L0 不能用；停岗的队友也不能用', async () => {
    const { ctx, tc } = setup({ autonomy: 'L0' });
    await write(ctx, `${home}/work/a.txt`, 'x');
    expect(errorOf(await put(ctx, tc, { from: 'work/a.txt' }))).toContain('L0');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/a.txt`)).toBeNull();
    const paused = setup();
    paused.ctx.store.table('bots').patch(paused.bot.id, { lifecycle: 'paused' });
    await write(paused.ctx, `${home}/work/a.txt`, 'x');
    expect(errorOf(await put(paused.ctx, paused.tc, { from: 'work/a.txt' }))).toContain('不在岗');
  });

  it('复盘回合不可用：报只读，没有写入', async () => {
    const { ctx, bot, tc } = setup();
    const wake = { ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id, sessionId: bot.sessionId, variant: 'reflection' as const, status: 'running' as const, endedAt: null };
    ctx.store.table('wakes').put(wake);
    await write(ctx, `${home}/work/a.txt`, 'x');
    expect(errorOf(await put(ctx, { ...tc, wakeId: wake.id }, { from: 'work/a.txt' }))).toContain('反思回合只读');
    expect(await ctx.fs.readText(`${dirOf(prjA)}/a.txt`)).toBeNull();
  });

  it('参数校验：缺 from、多余字段、空 to 都报中文错误', async () => {
    const { ctx, tc } = setup();
    for (const args of [{}, { from: 'a', extra: 1 }, { from: 'a', to: '' }]) expect(errorOf(await put(ctx, tc, args))).toMatch(/[一-鿿]/);
  });
});
