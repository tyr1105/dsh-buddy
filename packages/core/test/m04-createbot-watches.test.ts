/** 新建机器人必须在落表前校验起步关注；用内存 I/O 验证六类关注成功及拒绝时无半成品。 */
import { describe, expect, it, vi } from 'vitest';
import { createUiApi } from '../src/api/index.js';
import { resolveSettings } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { SeededRng } from '../src/io/testing/seeded-rng.js';
import { initRoot } from '../src/memory/files.js';
import { newId } from '../src/util/ids.js';
import { okData } from './c04-api-fixtures.js';

const profile = { name: '起步队友', role: 'sentinel', persona: '有变化时核实证据', aspirations: ['持续关注公开资料'] };
const goal = { title: '核实起步资料', doneWhen: '留下可核对的证据', period: 'week' };
const tables = ['bots', 'aspirations', 'watches', 'goals', 'queue'] as const;
const seed = 404;

/** 预知注入随机源的首个身份，只用于准备虚构的家内脚本，不读取真实用户目录。 */
async function fixture() {
  const ctx = createTestContext({ ownerHome: '/Users/owner', rng: new SeededRng(seed),
    settings: resolveSettings({ rootDir: '/hub', workDataPaths: ['/company/work'] }) });
  await initRoot(ctx);
  const api = createUiApi(ctx, async () => { await ctx.store.flush(); });
  const id = newId('b', new SeededRng(seed));
  return { ctx, api, id, home: `${ctx.settings.rootDir}/bots/${id}` };
}

/** 拒绝场景保留一个已有队友、目标和真实监听，避免只测空表而漏掉误删旧数据。 */
async function existingFixture() {
  const state = await fixture();
  const { ctx, api } = state;
  const existing = okData(await api.createBot({ ...profile, name: '已有队友', goals: [goal] }));
  const target = '/hub/shared/existing.log';
  await ctx.fs.writeTextAtomic(target, '已有公开记录\n');
  okData(await api.upsertWatch({ botId: existing.id, kind: 'log', target, why: '保留原有关注' }));
  // 换一个固定种子，让失败的新身份和已有身份严格不同。
  ctx.rng = new SeededRng(seed + 1);
  const id = newId('b', new SeededRng(seed + 1));
  const before = {
    tables: tables.map(name => [name, ctx.store.table(name).list()]),
    files: ctx.fs.snapshot(), homes: await ctx.fs.list('/hub/bots'),
    disposers: [...ctx.runtime.watchDisposers.entries()],
  };
  return { ...state, id, home: `/hub/bots/${id}`, before };
}

/** 失败不能留下新身份或关联记录，也不能动已有队友的文件、队列和监听。 */
async function expectNoPartialBot(state: Awaited<ReturnType<typeof existingFixture>>) {
  const { ctx, id, home, before } = state;
  expect(tables.map(name => [name, ctx.store.table(name).list()])).toEqual(before.tables);
  expect(ctx.store.table('bots').get(id)).toBeNull();
  expect(await ctx.fs.stat(home)).toBeNull();
  expect(await ctx.fs.list('/hub/bots')).toEqual(before.homes);
  expect(ctx.fs.snapshot()).toEqual(before.files);
  expect([...ctx.runtime.watchDisposers.entries()]).toEqual(before.disposers);
  expect(ctx.exec.calls).toHaveLength(0);
  expect(ctx.net.calls).toHaveLength(0);
}

describe('M04 新建机器人带起步关注', () => {
  it('同次创建六类关注与初始目标全部落表，file/log 立即注册真实监听', async () => {
    const { ctx, api, id, home } = await fixture();
    const script = `${home}/work/probe.js`;
    await ctx.fs.writeTextAtomic(script, 'console.log("公开状态");\n');
    await ctx.fs.writeTextAtomic('/hub/shared/start.txt', '原始公开资料');
    await ctx.fs.writeTextAtomic('/hub/shared/start.log', '原始记录\n');
    const stat = ctx.fs.stat.bind(ctx.fs);
    const scriptPreflight: Array<number> = [];
    vi.spyOn(ctx.fs, 'stat').mockImplementation(async path => {
      if (path === script) scriptPreflight.push(ctx.store.table('bots').count());
      return stat(path);
    });
    const register = vi.spyOn(ctx.fs, 'watch');
    const watches = [
      { kind: 'file', target: '/hub/shared/start.txt', why: '关注资料变化' },
      { kind: 'log', target: '/hub/shared/start.log', why: '关注新增记录' },
      { kind: 'http', target: 'https://example.test/status', why: '关注公开页面' },
      { kind: 'rss', target: 'https://example.test/feed.xml', why: '关注公开订阅' },
      { kind: 'script', target: 'node work/probe.js', why: '检查家内公开状态' },
      { kind: 'session', target: 'any', why: '关注会话完成' },
    ];
    const bot = okData(await api.createBot({ ...profile, aspirations: ['关注公开变化', '核对公开证据'], watches,
      goals: [goal, { ...goal, title: '整理核对结果', period: 'one_off', aspirationIndex: 1 }] }));

    expect(bot).toMatchObject({ id, homeDir: home, lifecycle: 'probation', activity: 'queued', autonomy: 'L1', workDataAllowed: false,
      probationEndsAt: ctx.clock.now() + ctx.settings.probationMs, lightCheckAt: ctx.clock.now() + ctx.settings.paceMaxActiveGoalMs });
    expect(ctx.store.table('bots').list()).toEqual([bot]);
    const aspirations = ctx.store.table('aspirations').list();
    expect(aspirations).toHaveLength(2);
    expect(aspirations.map(row => [row.botId, row.status, row.createdBy, row.approved]))
      .toEqual([[id, 'active', 'owner', true], [id, 'active', 'owner', true]]);
    const goals = ctx.store.table('goals').list();
    expect(goals).toHaveLength(2);
    expect(goals[0]).toMatchObject({ botId: id, aspirationId: aspirations[0]!.id, title: goal.title, status: 'active', createdBy: 'owner' });
    expect(goals[1]).toMatchObject({ botId: id, aspirationId: aspirations[1]!.id, period: 'one_off', periodEndsAt: null, status: 'active', createdBy: 'owner' });
    const saved = ctx.store.table('watches').list();
    expect(saved).toHaveLength(6);
    for (const input of watches) {
      const row = saved.find(watch => watch.kind === input.kind)!;
      const intervalMs = input.kind === 'script' ? ctx.settings.scriptMinIntervalMs
        : ['http', 'rss'].includes(input.kind) ? ctx.settings.httpMinIntervalMs : null;
      expect(row).toMatchObject({ ...input, botId: id, status: 'active', createdBy: 'owner', expiresAt: null,
        relevance: ctx.settings.watchRelevanceByCreator.owner, intervalMs });
      expect(row.lastCheckedAt).toBe(['file', 'log'].includes(input.kind) ? ctx.clock.now() : null);
    }
    expect(ctx.store.table('queue').list()).toEqual([expect.objectContaining({ botId: id, variant: 'trial', ownerInitiated: true,
      reason: expect.objectContaining({ kind: 'trial', evidence: aspirations.map(row => row.id) }) })]);
    expect(scriptPreflight).toEqual([0]);
    expect(await ctx.fs.readText(script)).toBe('console.log("公开状态");\n');
    for (const path of ['AGENTS.md', 'memory/MEMORY.md', 'mind/goals.md', 'mind/watches.md'])
      expect(await ctx.fs.readText(`${home}/${path}`)).not.toBeNull();
    expect(await ctx.fs.readText(`${home}/mind/watches.md`)).toContain('/hub/shared/start.txt');
    expect(await ctx.fs.readText(`${home}/mind/goals.md`)).toContain(goal.title);

    // 观察真实 FsIO.watch 和事件回调，不能把表里有记录误当作已经监听。
    const fileWatches = saved.filter(watch => ['file', 'log'].includes(watch.kind));
    expect(register).toHaveBeenCalledTimes(2);
    for (const call of register.mock.calls) expect(call.slice(0, 2)).toEqual(['/hub/shared', { recursive: false }]);
    expect([...ctx.runtime.watchDisposers.keys()].sort()).toEqual(fileWatches.map(watch => watch.id).sort());
    expect(ctx.runtime.pendingFileEvents.size).toBe(0);
    await ctx.fs.appendText('/hub/shared/start.txt', '新增资料');
    await ctx.fs.appendText('/hub/shared/start.log', '新增记录\n');
    for (const watch of fileWatches) expect([...ctx.runtime.pendingFileEvents.get(watch.id)!.paths]).toEqual([watch.target]);
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.net.calls).toHaveLength(0);
  });

  const deniedPaths = [
    { target: '~/.ssh', error: '绝对路径' },
    { target: '~/.dsh/.credentials.yaml', error: '绝对路径' },
    { target: '/Users/owner/.ssh', error: '敏感凭据路径' },
    { target: '/Users/owner/.dsh/.credentials.yaml', error: '敏感凭据路径' },
    { target: '/company/work/report.txt', error: '工作数据' },
  ];
  it.each((['file', 'log'] as const).flatMap(kind => deniedPaths.map(path => ({ kind, ...path }))))(
    '$kind 起步关注拒绝 $target，所有关联表与家目录保持原状', async ({ kind, target, error }) => {
      const state = await existingFixture();
      const result = await state.api.createBot({ ...profile, goals: [goal], watches: [
        { kind: 'file', target: '/hub/shared/safe.txt', why: '先准备合法关注' },
        { kind, target, why: '检验读取边界' },
      ] });
      expect(result).toEqual({ ok: false, error: expect.stringContaining(error) });
      await expectNoPartialBot(state);
    },
  );

  it.each([
    { target: 'cat ~/.ssh/id_rsa', error: '敏感凭据路径' },
    { target: 'cat ~/.dsh/.credentials.yaml', error: '敏感凭据路径' },
    { target: 'cat /company/work/report.txt', error: '工作数据' },
    { target: 'node /hub/shared/outside.js', error: '机器人家目录内' },
    { target: 'node work/missing.js', error: '已有的文件' },
  ])('脚本起步关注拒绝 $target，预检失败不留下机器人', async ({ target, error }) => {
    const state = await existingFixture();
    // 越界脚本在内存中确实存在，避免因找不到文件而碰巧通过边界反例。
    await state.ctx.fs.writeTextAtomic('/hub/shared/outside.js', 'console.log("公开状态");\n');
    state.before.files = state.ctx.fs.snapshot();
    const result = await state.api.createBot({ ...profile, goals: [goal], watches: [
      { kind: 'file', target: '/hub/shared/safe.txt', why: '先准备合法关注' },
      { kind: 'script', target, why: '检验脚本边界' },
    ] });
    expect(result).toEqual({ ok: false, error: expect.stringContaining(error) });
    await expectNoPartialBot(state);
  });

  it('起步关注预检成功后初始目标关联无效，也不留下半个机器人', async () => {
    const state = await existingFixture();
    const result = await state.api.createBot({ ...profile, goals: [{ ...goal, aspirationIndex: 2 }],
      watches: [{ kind: 'file', target: '/hub/shared/safe.txt', why: '合法关注' }] });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('初始目标指定的志向不存在') });
    await expectNoPartialBot(state);
  });
});
