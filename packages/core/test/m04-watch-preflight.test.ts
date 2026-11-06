/** 起步关注的预检只依赖传入身份；同时核对旧 id/家目录入口仍读取当前授权，避免修复时放松访问边界。 */
import { describe, expect, it, vi } from 'vitest';
import { makeWatch } from '../src/api/entities.js';
import { resolveSettings } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { assertHttpWatchAccess, assertWatchPathAccess } from '../src/perception/access.js';
import { validateCommand } from '../src/perception/script.js';
import { botFixture } from './model-fixtures.js';

/** 所有路径仅存在于注入的内存世界；授权边界显式设置，不读取真实用户目录。 */
function fixture() {
  return createTestContext({ ownerHome: '/Users/owner', settings: resolveSettings({ rootDir: '/hub', workDataPaths: ['/company'] }) });
}

describe('M04 关注预检与运行时授权兼容', () => {
  it('未落表 Bot 可预检文件、网页和家内脚本，全程不查询机器人表', async () => {
    const ctx = fixture();
    const bot = { ...botFixture };
    await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/check.js`, 'console.log("公开资料");');
    const get = vi.spyOn(ctx.store.table('bots'), 'get');
    const list = vi.spyOn(ctx.store.table('bots'), 'list');
    expect(makeWatch(ctx, bot, { botId: bot.id, kind: 'file', target: '/hub/shared/news.txt', why: '资料变化' }, null).status).toBe('active');
    expect(makeWatch(ctx, bot, { botId: bot.id, kind: 'http', target: 'https://example.test/news', why: '公开进展' }, null).status).toBe('active');
    await expect(validateCommand(ctx, bot, 'node work/check.js')).resolves.toEqual({ cmd: 'node', args: [`${bot.homeDir}/work/check.js`] });
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(ctx.store.table('bots').count()).toBe(0);
    expect(ctx.exec.calls).toHaveLength(0);
  });

  it.each([false, true])('未落表 Bot 的工作数据授权为 %s 时，路径和脚本按同一授权判断', async workDataAllowed => {
    const ctx = fixture();
    const bot = { ...botFixture, workDataAllowed };
    if (workDataAllowed) {
      expect(() => assertWatchPathAccess(ctx, bot, '/company/report.txt')).not.toThrow();
      await expect(validateCommand(ctx, bot, 'cat /company/report.txt')).resolves.toEqual({ cmd: 'cat', args: ['/company/report.txt'] });
    } else {
      expect(() => assertWatchPathAccess(ctx, bot, '/company/report.txt')).toThrow('尚未允许访问工作数据');
      await expect(validateCommand(ctx, bot, 'cat /company/report.txt')).rejects.toThrow('尚未允许访问工作数据');
    }
    expect(ctx.store.table('bots').count()).toBe(0);
    expect(ctx.exec.calls).toHaveLength(0);
  });

  it.each(['~/.ssh', '~/.dsh/.credentials.yaml'])('未落表且有工作数据授权的 Bot 仍拒绝敏感路径 %s', async target => {
    const ctx = fixture();
    const bot = { ...botFixture, workDataAllowed: true };
    expect(() => assertWatchPathAccess(ctx, bot, target)).toThrow('敏感凭据路径');
    await expect(validateCommand(ctx, bot, `cat ${target}`)).rejects.toThrow('敏感凭据路径');
    expect(ctx.exec.calls).toHaveLength(0);
  });

  it.each(['http', 'rss'] as const)('未落表的 %s 预检仍识别敏感 file URL，并拒绝普通非 HTTP 协议', kind => {
    const ctx = fixture();
    const bot = { ...botFixture };
    const args = { botId: bot.id, kind, why: '检查来源' };
    expect(() => makeWatch(ctx, bot, { ...args, target: 'file:///Users/owner/.dsh/.credentials.yaml' }, null)).toThrow('敏感凭据路径');
    expect(() => makeWatch(ctx, bot, { ...args, target: 'file:///hub/shared/news.txt' }, null)).toThrow('http 或 https');
    expect(() => makeWatch(ctx, bot, { ...args, target: 'ftp://example.test/news' }, null)).toThrow('http 或 https');
    expect(ctx.net.calls).toHaveLength(0);
    expect(ctx.store.table('watches').count()).toBe(0);
  });

  it('旧 id 与家目录入口仍读取最新授权，撤销后立即拒绝', async () => {
    const ctx = fixture();
    ctx.store.table('bots').put({ ...botFixture, workDataAllowed: true });
    expect(() => assertWatchPathAccess(ctx, botFixture.id, '/company/report.txt')).not.toThrow();
    await expect(validateCommand(ctx, botFixture.homeDir, 'cat /company/report.txt')).resolves.toBeDefined();
    expect(() => assertHttpWatchAccess(ctx, { botId: botFixture.id, target: 'https://example.test/news' })).not.toThrow();
    ctx.store.table('bots').patch(botFixture.id, { workDataAllowed: false });
    expect(() => assertWatchPathAccess(ctx, botFixture.id, '/company/report.txt')).toThrow('尚未允许访问工作数据');
    await expect(validateCommand(ctx, botFixture.homeDir, 'cat /company/report.txt')).rejects.toThrow('尚未允许访问工作数据');
  });

  it('旧入口找不到机器人时仍拒绝 id；仅家目录的脚本校验维持保守授权', async () => {
    const ctx = fixture();
    expect(() => assertWatchPathAccess(ctx, botFixture.id, '/hub/shared/news.txt')).toThrow('关注项所属机器人不存在');
    expect(() => assertHttpWatchAccess(ctx, { botId: botFixture.id, target: 'https://example.test/news' })).toThrow('关注项所属机器人不存在');
    await expect(validateCommand(ctx, botFixture.homeDir, 'cat /hub/shared/news.txt')).resolves.toBeDefined();
    await expect(validateCommand(ctx, botFixture.homeDir, 'cat /company/report.txt')).rejects.toThrow('尚未允许访问工作数据');
    expect(ctx.exec.calls).toHaveLength(0);
  });
});
