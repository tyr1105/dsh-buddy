/** M11 延迟汇报回归：验证凌晨真实交账和出站汇报进入当天日报，且首句长度与审批隐私边界不变。 */
import { describe, expect, it } from 'vitest';
import { resolveSettings } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { buildDigest } from '../src/outreach/digest.js';
import { requestPush, pushHistory } from '../src/outreach/push.js';
import { writeOutreachAudit } from '../src/outreach/audit.js';
import { createSimWorld, advance } from '../src/sim/runner.js';
import { quietBrain, scriptedBrain } from '../src/sim/brains.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { botFixture } from './model-fixtures.js';

const local = (value: string) => parseLocalDateTime(value, 'Asia/Shanghai');
const report = '磁盘已到 97%，凌晨备份连续失败两次，08:00 前不清理会停写。第二句排查详情在线程。';
const firstSentence = '磁盘已到 97%，凌晨备份连续失败两次，08:00 前不清理会停写。';

describe('M11 延迟汇报进入日报', () => {
  // P76c：日报不再推送，tick 不再发「团队日报」通知。原用例证明：凌晨的重要汇报被免打扰推迟（审计里 deferred_quiet）后，
  // 经真实 Hub tick 进入当天 08:30 的日报通知，带队友名和首句。现在保留前半（真实 Hub 里推迟的事实、汇报进线程）和日报文字的内容
  // （用 buildDigest 在 08:30 直接拼出同一份正文，断言原样保留），去掉「日报通知在 08:30 发出」；并断言整个过程没有任何系统通知。
  it.each(['交账', '出站'] as const)('凌晨%s的重要汇报被免打扰推迟，日报正文里仍带队友名和首句，且不再有日报通知', async source => {
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
      const digest = { body: buildDigest(world as never, local('2026-11-05 08:30')) };
      // P76h：汇报（交账与出站两个入口）不再申请推送，所以不再有「免打扰已推迟」的推送审计，旧日报也不再列出这条汇报。
      // 原断言：日报含「未单独推送\n- 巡检员的汇报：{首句}（免打扰已推迟）」，推送审计里有一条 deferred_quiet。现在改为这两处都没有。
      expect(firstSentence.length).toBeGreaterThan(0);
      expect(digest.body).not.toContain('巡检员的汇报');
      expect(digest.body).not.toContain('第二句排查详情');
      expect(digest.body).not.toContain('值班员的汇报');
      expect(world.store.log('thread').all().filter(row => row.kind === 'report').map(row => row.text)).toEqual([report]);
      const pushes = world.store.log('audit').all().filter(row => row.action === 'push').map(row => JSON.parse(row.detail));
      expect(pushes.filter(row => row.title === '机器人汇报')).toEqual([]);
      // 原来这里是 notices 恰好 1 条（08:30 的日报通知）；现在没有日报，整个过程没有任何系统通知（推迟的汇报不发，也不补发日报）。
      expect(notices.filter(row => row.title.startsWith('团队日报'))).toHaveLength(0);
      expect(notices).toHaveLength(0);
      await advance(world, 60_000);
      expect(world.host.notifications).toHaveLength(0);
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

  // P76c：每日推送条数上限取消后，推送不会再因「超出预算」被拦（原用例靠 dailyPushCap: 1 让第二条返回 over_budget）。
  // 现在：先断言旧设置里的条数上限不再起作用（第二、三条照常 sent）；再把这两条的入参按旧格式写成 over_budget 审计记录
  // （旧存档里有这种记录，日报仍要能读出），文字规则（超出预算的汇报保留首句、普通事项与审批不复制正文、设置可收紧长度）断言原样保留。
  it('超预算（旧记录）汇报同样保留首句，普通事项与审批不复制正文，设置可收紧长度；条数上限不再拦截', async () => {
    const ctx = createTestContext({ settings: resolveSettings({ dailyPushCap: 1, c03: { deferredReportMaxChars: 12 } }) });
    ctx.store.table('bots').put(botFixture);
    ctx.clock.set(local('2026-11-05 08:10'));
    const report = { botId: botFixture.id, title: '机器人汇报', body: '字'.repeat(20), level: 'P2' as const, subjectKey: 'report:budget' };
    const approval = { botId: botFixture.id, title: '批准：运行命令 say 完成', body: '原始参数：不应显示', level: 'P1' as const, subjectKey: 'approval' };
    await requestPush(ctx, { botId: botFixture.id, title: '前置事项', body: '已发送的正文', level: 'P1', subjectKey: 'first' });
    expect(await requestPush(ctx, report)).toBe('sent');
    expect(await requestPush(ctx, approval)).toBe('sent');
    writeOutreachAudit(ctx, 'push', { ...report, subjectKey: 'report:budget-old', result: 'over_budget' });
    writeOutreachAudit(ctx, 'push', { ...approval, subjectKey: 'approval-old', result: 'over_budget' });
    expect(buildDigest(ctx, local('2026-11-05 08:30')).split('\n未单独推送\n')[1]).toBe(
      `- ${botFixture.name}的汇报：${'字'.repeat(12)}（超出打扰预算）\n- 批准：运行命令 say 完成（超出打扰预算）`);
    expect(() => resolveSettings({ c03: { deferredReportMaxChars: 61 } })).toThrow('最多 60 字');
  });
});
