/** C04 独立联调回归：撤销权限立即停止感知，暂停中的在途回合仍能经过真实守卫完成交账。 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import { commitArgs } from './c03-turn-fixtures.js';
import { okData } from './c04-api-fixtures.js';
import { botFixture, watchFixture } from './model-fixtures.js';
import { syncFileWatches, flushFileEvents } from '../src/perception/files.js';
import { resolveSettings } from '../src/config/defaults.js';

/** 通过公开 Hub API 创建一个仍在运行的试岗回合，保留真实工具守卫和宿主路径。 */
async function world() {
  const ctx = createTestContext();
  const hub = createHub(ctx);
  await hub.start();
  const created = okData(await hub.api.createBot({ name: '权限核验员', role: 'sentinel', persona: '先核验再处理', aspirations: ['关注已授权变化'] }));
  const bot = ctx.store.table('bots').get(created.id)!;
  return { ctx, hub, bot };
}

describe('C04 独立联调审查', () => {
  it('撤销工作数据权限后，既有日志关注不再读取和生成新感知', async () => {
    const { ctx, hub, bot } = await world();
    await hub.api.updateSettings({ workDataPaths: ['/work'] });
    await hub.api.updateBot(bot.id, { workDataAllowed: true });
    await ctx.fs.writeTextAtomic('/work/research.log', '第一条已授权记录\n');
    expect((await hub.api.upsertWatch({ botId: bot.id, kind: 'log', target: '/work/research.log', why: '读取已授权的进度' })).ok).toBe(true);
    const watch = ctx.store.table('watches').list()[0]!;
    await ctx.fs.appendText('/work/research.log', '第二条已授权记录\n');
    ctx.clock.advance(ctx.settings.fileDebounceMs + 1);
    await hub.tick();
    expect(ctx.store.table('percepts').count(row => row.watchId === watch.id)).toBeGreaterThan(0);
    const before = ctx.store.table('percepts').count(row => row.watchId === watch.id);
    expect((await hub.api.updateBot(bot.id, { workDataAllowed: false })).ok).toBe(true);
    await ctx.fs.appendText('/work/research.log', '撤权后禁止读取的新记录\n');
    ctx.clock.advance(ctx.settings.fileDebounceMs + 1);
    await hub.tick();
    expect(ctx.store.table('percepts').count(row => row.watchId === watch.id)).toBe(before);
    await hub.stop();
  });
  it('新标记为工作数据的已有关注自动暂停，重新授权不会静默恢复', async () => {
    const { ctx, hub, bot } = await world();
    await ctx.fs.writeTextAtomic('/new-work/events.log', '已公开记录\n');
    expect((await hub.api.upsertWatch({ botId: bot.id, kind: 'log', target: '/new-work/events.log', why: '原公开目录' })).ok).toBe(true);
    const watch = ctx.store.table('watches').list()[0]!;
    expect((await hub.api.updateSettings({ workDataPaths: ['/new-work'] })).ok).toBe(true);
    expect(ctx.store.table('watches').get(watch.id)?.status).toBe('paused');
    await hub.api.updateBot(bot.id, { workDataAllowed: true });
    expect(ctx.store.table('watches').get(watch.id)?.status).toBe('paused');
    expect(ctx.store.log('audit').all().some(row => row.action === 'watch_permission_revoked')).toBe(true);
    await hub.stop();
  });
  it('父目录关注不能借递归事件读取未授权的工作数据子目录', async () => {
    const { ctx, hub, bot } = await world();
    await hub.api.updateSettings({ workDataPaths: ['/hub/shared/private'] });
    await ctx.fs.mkdirp('/hub/shared/private');
    expect((await hub.api.upsertWatch({ botId: bot.id, kind: 'log', target: '/hub/shared', why: '只关注公开部分' })).ok).toBe(true);
    const read = vi.spyOn(ctx.fs, 'readText');
    await ctx.fs.writeTextAtomic('/hub/shared/private/private.log', '未授权的正文');
    ctx.clock.advance(ctx.settings.fileDebounceMs + 1);
    await hub.tick();
    expect(read.mock.calls.some(([path]) => path === '/hub/shared/private/private.log')).toBe(false);
    expect(ctx.store.table('percepts').list().some(row => row.summary.includes('未授权的正文'))).toBe(false);
    await hub.stop();
  });
  it('文件读取等待期间撤权，返回的旧正文不能再写入感知或期望', async () => {
    const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub', workDataPaths: ['/work'] }) });
    const bot = { ...botFixture, workDataAllowed: true };
    ctx.store.table('bots').put(bot);
    const watch = { ...watchFixture, kind: 'log' as const, target: '/work/events.log' };
    ctx.store.table('watches').put(watch);
    await ctx.fs.writeTextAtomic(watch.target, '旧记录\n');
    await syncFileWatches(ctx);
    await ctx.fs.appendText(watch.target, '新记录\n');
    ctx.clock.advance(ctx.settings.fileDebounceMs + 1);
    let entered!: () => void;
    let release!: (value: string | null) => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const body = new Promise<string | null>(resolve => { release = resolve; });
    vi.spyOn(ctx.fs, 'readText').mockImplementationOnce(async () => { entered(); return body; });
    const flush = flushFileEvents(ctx, ctx.clock.now());
    await reading;
    ctx.store.table('bots').patch(bot.id, { workDataAllowed: false });
    release('旧记录\n新记录\n');
    expect(await flush).toEqual([]);
    expect(ctx.store.table('percepts').count()).toBe(0);
    expect(ctx.store.table('watches').get(watch.id)?.status).toBe('paused');
    expect(ctx.runtime.watchDisposers.size).toBe(0);
  });
  it('暂停在途回合后允许通过守卫交账，仍拒绝一般写操作', async () => {
    const { ctx, hub, bot } = await world();
    expect(bot.sessionId).not.toBeNull();
    expect((await hub.api.setLifecycle(bot.id, 'paused')).ok).toBe(true);
    expect(hub.guardToolCall(bot.sessionId!, 'write_file', { path: `${bot.homeDir}/work/result.txt`, content: '暂停后不应写' }).allow).toBe(false);
    const args = commitArgs({ reply: '已暂停并收口' });
    expect(hub.guardToolCall(bot.sessionId!, 'hub_commit', args).allow).toBe(true);
    const commit = await hub.tools().find(tool => tool.name === 'hub_commit')!.handler(bot.sessionId!, args);
    expect(commit.ok).toBe(true);
    await hub.onTurnEvent({ type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), tokens: 100, finalText: '已收口' });
    expect(ctx.store.table('wakes').list()[0]?.status).toBe('committed');
    expect(ctx.store.table('bots').get(bot.id)?.lifecycle).toBe('paused');
    await hub.stop();
  });
});
