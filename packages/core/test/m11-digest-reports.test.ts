/** M11 延迟汇报回归：验证凌晨真实交账和出站汇报进入当天日报，且首句长度与审批隐私边界不变。 */
import { describe, expect, it } from 'vitest';
import { resolveSettings } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { buildDigest } from '../src/outreach/digest.js';
import { requestPush, pushHistory } from '../src/outreach/push.js';
import { createSimWorld, advance } from '../src/sim/runner.js';
import { quietBrain, scriptedBrain } from '../src/sim/brains.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { botFixture } from './model-fixtures.js';

const local = (value: string) => parseLocalDateTime(value, 'Asia/Shanghai');
const report = '磁盘已到 97%，凌晨备份连续失败两次，08:00 前不清理会停写。第二句排查详情在线程。';
const firstSentence = '磁盘已到 97%，凌晨备份连续失败两次，08:00 前不清理会停写。';

describe('M11 延迟汇报进入日报', () => {
  it.each(['交账', '出站'] as const)('凌晨%s的重要汇报经真实 Hub tick 进入当天日报通知，带队友名和首句', async source => {
    // 两个入口都使用真实中心工具与调度；另一位队友用于确认汇报归属清楚。
    const inspector = scriptedBrain([source === '交账'
      ? { outcome: 'progress', summary: '凌晨复查发现备份异常', report, importance: 9, reply: null }
      : { calls: [{ tool: 'hub_outbox_submit', args: { kind: 'notify_owner', payload: { text: report, importance: 9 }, why: '需要主人及时处理' } }],
          commit: { outcome: 'progress', summary: '已报告凌晨备份异常', reply: null } }, quietBrain]);
    const world = await createSimWorld({ startAt: local('2026-11-05 01:00'), bots: [
      { id: 'b_0000000001', name: '巡检员', brain: inspector, nextThinkAt: local('2026-11-05 02:10'),
        nextThinkReason: '凌晨复查备份结果', nextThinkBy: 'bot', nextThinkMode: 'at' },
      { id: 'b_0000000002', name: '值班员' },
    ] });
    try {
      await advance(world, local('2026-11-05 08:30') - world.clock.now());
      const notices = world.host.notifications;
      const digest = notices.find(row => row.title === '团队日报 2026-11-05');
      expect(digest?.at).toBe(local('2026-11-05 08:30'));
      expect(digest?.body).toContain(`未单独推送\n- 巡检员的汇报：${firstSentence}（免打扰已推迟）`);
      expect(digest?.body).not.toContain('第二句排查详情');
      expect(digest?.body).not.toContain('值班员的汇报');
      expect(world.store.log('thread').all().filter(row => row.kind === 'report').map(row => row.text)).toEqual([report]);
      const pushes = world.store.log('audit').all().filter(row => row.action === 'push').map(row => JSON.parse(row.detail));
      expect(pushes.filter(row => row.title === '机器人汇报')).toMatchObject([{ result: 'deferred_quiet', body: report, botId: 'b_0000000001' }]);
      expect(notices).toHaveLength(1);
      // 日报投递成功后，同一天再巡检不会重推，也不会把报告另发一遍。
      await advance(world, 60_000);
      expect(world.host.notifications).toHaveLength(1);
    } finally { await world.hub.stop(); }
  });

  it.each([
    ['中文首句。后续内容不入清单', '中文首句。'],
    ['Alert at example.com is 97.5%. Further details.', 'Alert at example.com is 97.5%.'],
    ['第一行汇报\n第二行细节', '第一行汇报'],
    ['字'.repeat(70), '字'.repeat(60)],
    ['𠮷'.repeat(61), '𠮷'.repeat(60)],
  ])('首句按完整字符限长：%s', async (body, expected) => {
    const ctx = createTestContext();
    ctx.store.table('bots').put(botFixture);
    ctx.clock.set(local('2026-11-05 02:10'));
    expect(await requestPush(ctx, { botId: botFixture.id, title: '机器人汇报', body, level: 'P2', subjectKey: 'report:limit' })).toBe('deferred_quiet');
    const digest = buildDigest(ctx, local('2026-11-05 08:30'));
    expect(digest.split('\n未单独推送\n')[1]).toBe(`- ${botFixture.name}的汇报：${expected}（免打扰已推迟）`);
    expect(Array.from(expected).length).toBeLessThanOrEqual(60);
    expect(pushHistory(ctx)[0]?.body).toBe(body);
  });

  it('超预算汇报同样保留首句，普通事项与审批不复制正文，设置可收紧长度', async () => {
    const ctx = createTestContext({ settings: resolveSettings({ dailyPushCap: 1, c03: { deferredReportMaxChars: 12 } }) });
    ctx.store.table('bots').put(botFixture);
    ctx.clock.set(local('2026-11-05 08:10'));
    await requestPush(ctx, { botId: botFixture.id, title: '前置事项', body: '已发送的正文', level: 'P1', subjectKey: 'first' });
    expect(await requestPush(ctx, { botId: botFixture.id, title: '机器人汇报', body: '字'.repeat(20), level: 'P2', subjectKey: 'report:budget' })).toBe('over_budget');
    await requestPush(ctx, { botId: botFixture.id, title: '批准：运行命令 say 完成', body: '原始参数：不应显示', level: 'P1', subjectKey: 'approval' });
    expect(buildDigest(ctx, local('2026-11-05 08:30')).split('\n未单独推送\n')[1]).toBe(
      `- ${botFixture.name}的汇报：${'字'.repeat(12)}（超出打扰预算）\n- 批准：运行命令 say 完成（超出打扰预算）`);
    expect(() => resolveSettings({ c03: { deferredReportMaxChars: 61 } })).toThrow('最多 60 字');
  });
});
