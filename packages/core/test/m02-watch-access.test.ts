/** 关注执行器直接使用中心 I/O，因此入口和实际读取都必须拒绝敏感路径；所有文件均为内存假数据。 */
import { describe, expect, it } from 'vitest';
import { syncFileWatches, flushFileEvents } from '../src/perception/files.js';
import { pollDueWatches } from '../src/perception/poll.js';
import { readWatchState } from '../src/perception/watch-state.js';
import { validateWatchProposal, hubWatchPropose } from '../src/tools/hub-watch-propose.js';
import { validateWatchUpdate, hubWatchUpdate } from '../src/tools/hub-watch-update.js';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { perceptionContext, minute, response } from './perception-fixtures.js';
import { botFixture, watchFixture } from './model-fixtures.js';
import type { Watch } from '../src/model/perception.js';
import { toolFixture } from './c03-tool-fixtures.js';

describe('M02 第三部分：关注项不能绕过敏感路径拒绝', () => {
  it('可信机器人主动提议敏感关注计越界，第三次达到隔离门槛', async () => {
    const { ctx, bot, tc } = toolFixture();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await hubWatchPropose.handler(ctx, tc, { kind: 'file', target: '/Users/owner/.ssh/id_rsa', why: '检查文件' });
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toContain('敏感凭据路径');
      expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(attempt);
    }
    expect(ctx.store.table('bots').get(bot.id)?.lifecycle).toBe('quarantined');
  });
  it('可信机器人主动恢复敏感关注计越界，暂停敏感旧关注不计越界', async () => {
    const { ctx, bot, tc } = toolFixture();
    ctx.store.table('watches').patch(watchFixture.id, { kind: 'file', target: '/Users/owner/.dsh/private.txt', status: 'paused' });
    const denied = await hubWatchUpdate.handler(ctx, tc, { id: watchFixture.id, status: 'active' });
    expect(denied.ok).toBe(false); expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(1);
    expect((await hubWatchUpdate.handler(ctx, tc, { id: watchFixture.id, status: 'paused' })).ok).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(1);
  });
  it.each(['file', 'log'] as const)('%s 的机器人提议、重新启用与主人创建修改都拒绝敏感路径', async kind => {
    const target = '/Users/owner/.SSH/id_rsa';
    const ctx = perceptionContext({ kind, target, status: 'paused' });
    expect(() => validateWatchProposal(ctx, botFixture.id, { kind, target, why: '检查变化' })).toThrow('敏感凭据路径');
    expect(() => validateWatchUpdate(ctx, botFixture.id, { id: watchFixture.id, status: 'active' })).toThrow('敏感凭据路径');
    const ui = await apiFixture();
    const rejected = await ui.api.upsertWatch({ botId: ui.bot.id, kind, target, why: '检查变化' });
    expect(rejected.ok).toBe(false); if (!rejected.ok) expect(rejected.error).toContain('敏感凭据路径');
    const safe = okData(await ui.api.upsertWatch({ botId: ui.bot.id, kind, target: '/hub/shared/safe.txt', why: '公开资料' })) as Watch;
    expect((await ui.api.upsertWatch({ id: safe.id, botId: ui.bot.id, kind, target, why: '检查变化' })).ok).toBe(false);
    expect(ui.ctx.store.table('watches').get(safe.id)?.target).toBe('/hub/shared/safe.txt');
    expect(ui.ctx.store.table('bots').get(ui.bot.id)?.violations).toBe(0);
  });
  it.each(['file', 'log'] as const)('旧持久化 %s 敏感关注在实际读文件前暂停，不能因旧记录而放行', async kind => {
    const target = '/Users/owner/.dsh/private.txt'; const ctx = perceptionContext({ kind, target });
    await ctx.fs.writeTextAtomic(target, '完全虚构的内存资料\n');
    const read = ctx.fs.readText.bind(ctx.fs); const reads: string[] = [];
    ctx.fs.readText = async path => { reads.push(path); return read(path); };
    await syncFileWatches(ctx);
    expect(ctx.store.table('watches').get(watchFixture.id)?.status).toBe('paused');
    expect(ctx.runtime.watchDisposers.size).toBe(0); expect(reads).not.toContain(target);
    expect(ctx.store.table('bots').get(botFixture.id)?.violations).toBe(0);
    ctx.clock.advance(2 * minute); expect(await flushFileEvents(ctx, ctx.clock.now())).toEqual([]);
  });
  it('目录关注继续读取公开文件，但不触碰其中的敏感子树', async () => {
    const target = '/hub/public'; const ctx = perceptionContext({ kind: 'log', target });
    await ctx.fs.mkdirp(target); await syncFileWatches(ctx);
    await ctx.fs.writeTextAtomic(`${target}/.ssh/id_rsa`, '虚构敏感行\n');
    await ctx.fs.writeTextAtomic(`${target}/public.log`, '公开更新\n');
    const read = ctx.fs.readText.bind(ctx.fs); const reads: string[] = [];
    ctx.fs.readText = async path => { reads.push(path); return read(path); };
    ctx.clock.advance(2 * minute); const percepts = await flushFileEvents(ctx, ctx.clock.now());
    expect(percepts).toHaveLength(1); expect(percepts[0]?.summary).toContain('公开更新');
    expect(reads).not.toContain(`${target}/.ssh/id_rsa`);
  });
  it.each(['http', 'rss'] as const)('旧持久化 %s 的敏感 file URL 在网络调用前拒绝', async kind => {
    const target = 'file:///Users/owner/.dsh/.credentials.yaml'; const ctx = perceptionContext({ kind, target });
    ctx.net.set(target, response('虚构数据'));
    expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]); expect(ctx.net.calls).toHaveLength(0);
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!).lastError).toContain('敏感凭据路径');
  });
  it.each(['http', 'rss'] as const)('%s 即使非敏感 file URL 也不交给网络适配器读取', async kind => {
    const ctx = perceptionContext({ kind, target: 'file:///hub/shared/public.txt' });
    await pollDueWatches(ctx, ctx.clock.now()); expect(ctx.net.calls).toHaveLength(0);
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!).lastError).toContain('http 或 https');
  });
});
