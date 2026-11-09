/**
 * F06 验收链路：先真实写文件，再交账、人工验收、检查线程与持久化。
 * 反例覆盖文件缺失、链接越界、自述验证、标准变化；文件非空绝不自动完成目标。
 */
import { describe, expect, it, vi } from 'vitest';
import { processCommit } from '../src/commit/process.js';
import { inspectArtifacts, verdictOf } from '../src/commit/result-check.js';
import { answerInbox, expireInbox } from '../src/outreach/inbox.js';
import { createUiApi } from '../src/api/index.js';
import { ResultCheckSchema } from '../src/model/result-check.js';
import { FileStore } from '../src/store/file-store.js';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { goalFixture } from './model-fixtures.js';
import { F06_DEFAULTS, V2_DEFAULTS } from '../src/config/defaults.js';
import { buildOpenLedger, sealLedger } from '../src/ledger/entry.js';

/** 同一套真实内存中心夹具：完成声明引用目标，交付地址来自 worldChanges。 */
async function submitted(content: string | null = '有来源的结论', where = 'work/result.md') {
  const world = await turnContext();
  world.ctx.store.table('goals').put(goalFixture);
  const path = `${world.bot.homeDir}/work/result.md`;
  if (content !== null) await world.ctx.fs.writeTextAtomic(path, content);
  const result = await processCommit(world.ctx, world.toolCtx, commitArgs({
    outcome: 'done', evidence: [goalFixture.id], worldChanges: [{ what: '完成结果', whoCanSee: 'owner', where }],
    verification: { level: 'program', notCovered: '尚未由主人验收内容' },
  }));
  expect(result.ok).toBe(true);
  const commit = world.ctx.store.table('commits').list()[0]!;
  const item = world.ctx.store.table('inbox').list(row => row.refId === goalFixture.id)[0]!;
  return { ...world, path, commit, item };
}

describe('F06 中心实查', () => {
  it('非空产物只进入待验收，自述 program 也不会自动变成已完成', async () => {
    const { ctx, commit, item, bot } = await submitted();
    const record = ctx.store.table('resultChecks').get(commit.id)!;
    expect(ResultCheckSchema.safeParse(record).success).toBe(true);
    expect(record.artifacts[0]).toMatchObject({ status: 'present', size: Buffer.byteLength('有来源的结论') });
    expect(record.decisions).toEqual([]);
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('done_pending_check');
    expect(item.body).toContain('完成标准');
    expect(item.body).toContain('执行者自述验证');
    expect(item.body).toContain('文件存在且非空');
    expect(item.defaultOption).toBe('未通过');
    const api = createUiApi(ctx, async () => {});
    expect(api.inbox().items[0]?.goalId).toBe(goalFixture.id);
    expect(api.thread(bot.id).messages.find(row => row.card)?.card?.goalId).toBe(goalFixture.id);
    expect((await api.bot(bot.id)).goals[0]?.checkText).toContain('内容待你验收');
  });
  it.each([
    [null, 'missing'], ['', 'empty'],
  ] as const)('%s 产物如实记录 %s，并拦住通过', async (content, status) => {
    const { ctx, commit, item } = await submitted(content);
    expect(ctx.store.table('resultChecks').get(commit.id)?.artifacts[0]?.status).toBe(status);
    await expect(answerInbox(ctx, item.id, '通过')).rejects.toThrow('产物');
    expect(ctx.store.table('inbox').get(item.id)?.status).toBe('open');
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('done_pending_check');
    expect(ctx.store.table('resultChecks').get(commit.id)?.decisions).toEqual([]);
  });
  it('交付位置是目录时不把目录存在当成文件交付', async () => {
    const { ctx, item, commit } = await submitted(null, 'work');
    expect(ctx.store.table('resultChecks').get(commit.id)?.artifacts[0]?.status).toBe('invalid');
    await expect(answerInbox(ctx, item.id, '通过')).rejects.toThrow('产物');
  });
  it('通过前发现文件被删除，失败后保留卡片；补齐后可重新验收', async () => {
    const { ctx, path, item, commit } = await submitted();
    await ctx.fs.remove(path);
    await expect(answerInbox(ctx, item.id, '通过')).rejects.toThrow('产物');
    await ctx.fs.writeTextAtomic(path, '补齐的交付');
    await answerInbox(ctx, item.id, '通过');
    const check = ctx.store.table('resultChecks').get(commit.id)!;
    expect(check.artifacts[0]?.size).toBe(Buffer.byteLength('有来源的结论'));
    expect(check.decisions[0]?.artifacts[0]?.size).toBe(Buffer.byteLength('补齐的交付'));
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('done');
  });
  it('完成标准变更后不能按旧标准通过，可以按不符合要求退回', async () => {
    const { ctx, item, commit } = await submitted();
    ctx.store.table('goals').patch(goalFixture.id, { doneWhen: '必须包含新的来源' });
    await expect(answerInbox(ctx, item.id, '通过')).rejects.toThrow('完成标准已变更');
    await answerInbox(ctx, item.id, '不是你要的');
    expect(ctx.store.table('resultChecks').get(commit.id)?.decisions[0]?.verdict).toBe('mismatch');
  });
  it.each(['work/.env', 'work/credentials.yaml', '/elsewhere/file', 'https://example.test/result', '', 'work/../mind/goals.md'])(
    '不可实查位置 %s 不读正文、不请求网络，不伪造存在', async where => {
      const { ctx, commit } = await submitted();
      const read = vi.spyOn(ctx.fs, 'readText');
      const bytes = vi.spyOn(ctx.fs, 'readBytes');
      const stat = vi.spyOn(ctx.fs, 'stat');
      const get = vi.spyOn(ctx.net, 'get');
      const artifacts = await inspectArtifacts(ctx, { ...commit, worldChanges: [{ what: '结果', whoCanSee: 'owner', where }] });
      expect(artifacts[0]?.status).toBe('unchecked');
      expect(read).not.toHaveBeenCalled();
      expect(bytes).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });
  it('真实路径指向凭据或外部目录时不继续 stat', async () => {
    const { ctx, commit } = await submitted();
    vi.spyOn(ctx.fs, 'realpath').mockResolvedValue('/owner/.dsh/.credentials.yaml');
    const stat = vi.spyOn(ctx.fs, 'stat');
    expect((await inspectArtifacts(ctx, commit))[0]?.status).toBe('unchecked');
    expect(stat).not.toHaveBeenCalled();
  });
  it('文件接口出错只记未能实查，不泄露错误正文，也不抹掉交账', async () => {
    const { ctx, commit } = await submitted();
    vi.spyOn(ctx.fs, 'stat').mockRejectedValue(new Error('内部敏感路径与错误正文'));
    const results = await inspectArtifacts(ctx, commit);
    expect(results[0]?.status).toBe('unchecked');
    expect(JSON.stringify(results)).not.toContain('内部敏感');
    expect(ctx.store.table('commits').get(commit.id)).not.toBeNull();
  });
  it('系统 realpath 的 ENOENT 也归为文件缺失', async () => {
    const { ctx, commit } = await submitted();
    vi.spyOn(ctx.fs, 'realpath').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect((await inspectArtifacts(ctx, commit))[0]?.status).toBe('missing');
  });
  it('实查有上限且重复位置只查一次，超限明确标未覆盖', async () => {
    const { ctx, commit } = await submitted();
    const changes = Array.from({ length: F06_DEFAULTS.ARTIFACT_MAX + 3 }, (_, i) => ({ what: '结果', whoCanSee: 'owner' as const, where: `work/${i}.md` }));
    const stat = vi.spyOn(ctx.fs, 'stat');
    const records = await inspectArtifacts(ctx, { ...commit, worldChanges: [...changes, changes[0]!] });
    expect(stat).toHaveBeenCalledTimes(F06_DEFAULTS.ARTIFACT_MAX);
    expect(records).toHaveLength(F06_DEFAULTS.ARTIFACT_MAX + 1);
    expect(records.at(-1)).toMatchObject({ status: 'unchecked', where: '' });
  });
});

describe('F06 人工结果与恢复', () => {
  it('验收结论从账本视图可读，同时已封存账本保持原样', async () => {
    const { ctx, commit, ticket, item } = await submitted();
    const wake = ctx.store.table('wakes').get(ticket.id)!;
    const opened = buildOpenLedger({ id: 'wl_test', wake, queueWaitMs: 0, evidence: { items: [], missingIds: [] }, now: ctx.clock.now() });
    const sealed = sealLedger({ entry: opened, wake, commit, now: ctx.clock.now() });
    ctx.store.table('wakeLedger').put(sealed);
    await answerInbox(ctx, item.id, '做错');
    const view = createUiApi(ctx, async () => {}).wakeLedgerDetail(wake.id);
    expect(view?.entry).toEqual(sealed);
    expect(view?.resultCheck?.decisions[0]?.verdict).toBe('incorrect');
    expect(view?.verificationLabel).not.toBeNull();
  });
  it.each([
    ['通过', 'passed', 'done'], ['没做', 'not_done', 'active'], ['做错', 'incorrect', 'active'],
    ['不是你要的', 'mismatch', 'active'], ['看起来差不多', 'rejected', 'active'],
  ] as const)('%s 分别记录结论 %s 并通知队友', async (answer, verdict, status) => {
    const { ctx, item, commit } = await submitted();
    await answerInbox(ctx, item.id, answer);
    expect(ctx.store.table('resultChecks').get(commit.id)?.decisions[0]).toMatchObject({ verdict, answer, goalId: goalFixture.id });
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe(status);
    expect(ctx.store.log('thread').all().some(row => row.from === 'owner' && row.text.includes(answer))).toBe(true);
    expect(ctx.store.table('queue').list().some(row => row.reason.kind === 'inbox_reply')).toBe(true);
    await expect(answerInbox(ctx, item.id, answer)).rejects.toThrow('已处理');
    expect(ctx.store.table('resultChecks').get(commit.id)?.decisions).toHaveLength(1);
  });
  it.each(['not_done', 'incorrect', 'mismatch'] as const)('右栏 closeGoal %s 与收件箱同一路径', async outcome => {
    const { ctx, commit } = await submitted();
    const api = createUiApi(ctx, async () => {});
    expect((await api.closeGoal(goalFixture.id, outcome)).ok).toBe(true);
    expect(ctx.store.table('resultChecks').get(commit.id)?.decisions[0]?.verdict).toBe(outcome);
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('active');
  });
  it('过期不完成目标，且独立记录明确说明是默认处理', async () => {
    const { ctx, commit } = await submitted();
    ctx.clock.advance(ctx.settings.questionExpiryMs);
    await expireInbox(ctx, ctx.clock.now());
    expect(ctx.store.table('resultChecks').get(commit.id)?.decisions[0]?.verdict).toBe('expired');
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('active');
    expect(verdictOf('通过', true)).toBe('expired');
  });
  it('多目标独立决定，不把一个验收结论套给另一个目标', async () => {
    const { ctx, toolCtx } = await turnContext();
    ctx.store.table('goals').put(goalFixture);
    const other = { ...goalFixture, id: 'g_0000000002' };
    ctx.store.table('goals').put(other);
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'done', evidence: [goalFixture.id, other.id] }));
    const items = ctx.store.table('inbox').list();
    await answerInbox(ctx, items.find(item => item.refId === goalFixture.id)!.id, '通过');
    await answerInbox(ctx, items.find(item => item.refId === other.id)!.id, '做错');
    const check = ctx.store.table('resultChecks').list()[0]!;
    expect(check.decisions.map(row => row.verdict)).toEqual(['passed', 'incorrect']);
    expect(ctx.store.table('goals').get(other.id)?.status).toBe('active');
  });
  it('独立记录可落盘恢复；没有新表的旧档继续允许主人验收', async () => {
    const { ctx, commit } = await submitted();
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', ctx.settings.timezone, ctx.logger);
    store.table('resultChecks').put(ctx.store.table('resultChecks').get(commit.id)!);
    await store.flush();
    const restored = new FileStore(ctx.fs, ctx.clock, '/hub', ctx.settings.timezone, ctx.logger);
    await restored.load();
    expect(restored.table('resultChecks').get(commit.id)).toEqual(store.table('resultChecks').get(commit.id));
    const api = createUiApi(ctx, async () => {});
    ctx.store.table('resultChecks').remove(commit.id);
    expect((await api.closeGoal(goalFixture.id, true)).ok).toBe(true);
  });
  it('记录到保留期边界仍保留，超过后才清理', async () => {
    const { ctx, commit } = await submitted();
    await ctx.store.prune(ctx.clock.now() + V2_DEFAULTS.LEDGER_RETENTION_MS);
    expect(ctx.store.table('resultChecks').get(commit.id)).not.toBeNull();
    await ctx.store.prune(ctx.clock.now() + V2_DEFAULTS.LEDGER_RETENTION_MS + 1);
    expect(ctx.store.table('resultChecks').get(commit.id)).toBeNull();
  });
  it('没有成果的普通 no_change 交账不制造实查成功', async () => {
    const { ctx, toolCtx } = await turnContext();
    await processCommit(ctx, toolCtx, commitArgs());
    expect(ctx.store.table('resultChecks').count()).toBe(0);
    expect(ctx.store.table('commits').list()[0]?.verification).toEqual({ level: 'none', notCovered: '尚无新证据' });
  });
});
