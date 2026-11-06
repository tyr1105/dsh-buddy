/** M09 告警回归：用倒序宿主时间和假时钟核对去重、开放记录唯一性及主人可读的中文标题。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { closeAlert, raiseAlert } from '../src/health/alerts.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { pushHistory } from '../src/outreach/push.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { FileStore } from '../src/store/file-store.js';
import { botFixture } from './model-fixtures.js';

const HOUR = 60 * 60_000;

/** 每例使用独立内存库；中心告警和机器人告警共用同一生产入口。 */
function setup() {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, name: '巡检员' });
  return ctx;
}

const quota = { code: 'quota', botId: null, text: '额度已用尽', level: 'P0' as const, immediate: true };

describe('M09 告警时间乱序与唯一开放记录', () => {
  it('两次额度告警倒序两毫秒只存一条、建一张卡并申请一次推送', async () => {
    const ctx = setup();
    const now = ctx.clock.now();
    const first = raiseAlert(ctx, { ...quota, at: now + 2 });
    await syncAlertItems(ctx);
    const second = raiseAlert(ctx, { ...quota, at: now });
    await syncAlertItems(ctx);

    expect(second).toMatchObject({ id: first.id, count: 2, status: 'open', firstAt: now, lastAt: now + 2 });
    expect(ctx.store.table('alerts').list()).toHaveLength(1);
    expect(ctx.store.table('inbox').list()).toHaveLength(1);
    expect(ctx.store.table('inbox').list()[0]).toMatchObject({ title: '中心告警：额度', status: 'open', pushed: true });
    expect(ctx.store.log('thread').all().filter(row => row.kind === 'alert')).toHaveLength(1);
    expect(pushHistory(ctx)).toHaveLength(1);
    expect(ctx.host.calls.filter(call => call.method === 'notify')).toHaveLength(1);
  });

  it('普通告警倒序仍累计连续次数，第一次不打扰、第二次才开放', async () => {
    const ctx = setup();
    const now = ctx.clock.now();
    const input = { code: 'network', botId: botFixture.id, text: '网络不可用', level: 'P1' as const };
    const first = raiseAlert(ctx, { ...input, at: now + 2 });
    await syncAlertItems(ctx);
    expect(first).toMatchObject({ count: 1, status: 'closed' });
    expect(ctx.store.table('inbox').list()).toHaveLength(0);

    const second = raiseAlert(ctx, { ...input, at: now });
    await syncAlertItems(ctx);
    expect(second).toMatchObject({ id: first.id, count: 2, status: 'open', lastAt: now + 2 });
    expect(ctx.store.table('alerts').list()).toHaveLength(1);
    expect(ctx.store.table('inbox').list()).toHaveLength(1);
  });

  it.each([HOUR - 1, -(HOUR - 1)])('时间差 %i 毫秒仍在合并窗口内，保留较大的 lastAt', offset => {
    const ctx = setup();
    const now = ctx.clock.now();
    const first = raiseAlert(ctx, { ...quota, at: now });
    const second = raiseAlert(ctx, { ...quota, at: now + offset });
    expect(second).toMatchObject({ id: first.id, count: 2, lastAt: Math.max(now, now + offset) });
    expect(ctx.store.table('alerts').list()).toHaveLength(1);
  });

  it.each([HOUR, -HOUR])('时间差 %i 毫秒达到窗口边界，保留历史但最多一条开放', async offset => {
    const ctx = setup();
    const now = ctx.clock.now();
    const first = raiseAlert(ctx, { ...quota, at: now });
    await syncAlertItems(ctx);
    const second = raiseAlert(ctx, { ...quota, at: now + offset });
    expect(ctx.store.table('alerts').get(first.id)).toMatchObject({ count: 1, status: 'closed' });
    await syncAlertItems(ctx);
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ count: 2, status: 'open', lastAt: Math.max(now, now + offset) });
    // 原有卡片关闭流程会清零该历史观测；新开放记录的连续次数仍保留为 2。
    expect(ctx.store.table('alerts').get(first.id)).toMatchObject({ count: 0, status: 'closed' });
    expect(ctx.store.table('alerts').get(second.id)).toMatchObject({ count: 2, status: 'open' });
    expect(ctx.store.table('alerts').list()).toHaveLength(2);
    expect(ctx.store.table('alerts').list(row => row.status === 'open')).toHaveLength(1);
    expect(ctx.store.table('inbox').list(row => row.refId === first.id)[0]?.status).toBe('closed');
    expect(ctx.store.table('inbox').list(row => row.status === 'open')).toHaveLength(1);
  });

  it('旧版本遗留多个开放记录时选择 lastAt 最新项，并关闭其余记录和旧卡', async () => {
    const ctx = setup();
    const now = ctx.clock.now();
    const first = raiseAlert(ctx, { ...quota, at: now - 2 * HOUR });
    await syncAlertItems(ctx);
    const latest = raiseAlert(ctx, { ...quota, at: now + 2 });
    // 模拟旧版本已持久化的重复开放状态；新入口应恢复唯一性而非继续扩大重复。
    ctx.store.table('alerts').patch(first.id, { status: 'open' });
    const merged = raiseAlert(ctx, { ...quota, at: now });
    await syncAlertItems(ctx);
    expect(merged).toMatchObject({ id: latest.id, count: 3, lastAt: now + 2 });
    expect(ctx.store.table('alerts').list(row => row.status === 'open')).toHaveLength(1);
    expect(ctx.store.table('alerts').get(first.id)?.status).toBe('closed');
    expect(ctx.store.table('inbox').list(row => row.refId === first.id)[0]?.status).toBe('closed');
    expect(ctx.store.table('inbox').list(row => row.status === 'open')).toHaveLength(1);
  });

  it('倒序窗口外产生相同 lastAt 时，后续观测继续最新开放记录而非旧历史', () => {
    const ctx = setup();
    const now = ctx.clock.now();
    const input = { ...quota, immediate: false };
    const first = raiseAlert(ctx, { ...input, at: now });
    const opened = raiseAlert(ctx, { ...input, at: now - HOUR });
    expect(opened).toMatchObject({ count: 2, status: 'open', lastAt: now });
    expect(opened.id).not.toBe(first.id);
    const next = raiseAlert(ctx, { ...input, at: now + 1 });
    expect(next).toMatchObject({ id: opened.id, count: 3, status: 'open', lastAt: now + 1 });
    expect(ctx.store.table('alerts').get(first.id)).toMatchObject({ count: 1, status: 'closed' });
    expect(ctx.store.table('alerts').list(row => row.status === 'open')).toHaveLength(1);
  });

  it('相同 code 不同机器人、同一机器人不同 code 分别保留开放记录', () => {
    const ctx = setup();
    const first = raiseAlert(ctx, quota);
    const own = raiseAlert(ctx, { ...quota, botId: botFixture.id });
    const other = raiseAlert(ctx, { ...quota, code: 'auth' });
    expect(new Set([first.id, own.id, other.id]).size).toBe(3);
    expect(ctx.store.table('alerts').list(row => row.status === 'open')).toHaveLength(3);
  });

  it('恢复清零后乱序的普通新观测不会继承此前连续次数', () => {
    const ctx = setup();
    const now = ctx.clock.now();
    const first = raiseAlert(ctx, { ...quota, at: now + 2 });
    closeAlert(ctx, quota.code, quota.botId);
    const next = raiseAlert(ctx, { ...quota, immediate: false, at: now });
    expect(next.id).not.toBe(first.id);
    expect(next).toMatchObject({ count: 1, status: 'closed', firstAt: now, lastAt: now });
    expect(ctx.store.table('alerts').get(first.id)).toMatchObject({ count: 0, status: 'closed' });
  });

  it.each(['none', 'older', 'both'])('旧档重启已有 %s 告警卡，无新 raise 也合并开放记录且不重复通知', async mode => {
    const source = setup();
    const now = source.clock.now();
    const first = raiseAlert(source, { ...quota, at: now });
    const latest = { ...first, id: 'al_0000000002', firstAt: now + 2, lastAt: now + 2, count: 2 };
    // 直接写入旧版本可能保存的两条开放记录，重启后只调用同步入口，不制造新告警观测。
    await source.fs.writeTextAtomic('/hub/.hub/state/alerts.json', JSON.stringify([first, latest]));
    await source.fs.writeTextAtomic('/hub/.hub/state/bots.json', JSON.stringify(source.store.table('bots').list()));
    const savedCards = mode === 'none' ? [] : mode === 'older' ? [first] : [first, latest];
    for (const alert of savedCards) {
      const item = createInboxItem(source, { botId: null, type: 'alert', title: '中心告警：quota', body: alert.text,
        priority: 'P0', refId: alert.id, subjectKey: 'alert:hub:quota' });
      source.store.table('inbox').patch(item.id, { pushed: true });
    }
    await source.fs.writeTextAtomic('/hub/.hub/state/inbox.json', JSON.stringify(source.store.table('inbox').list()));
    const store = new FileStore(source.fs, source.clock, '/hub', 'Asia/Shanghai', source.logger);
    await store.load();
    const ctx = createTestContext({ store, fs: source.fs, clock: source.clock });
    await syncAlertItems(ctx);
    await syncAlertItems(ctx);
    expect(store.table('alerts').list(item => item.status === 'open')).toEqual([
      { ...latest, count: 3, firstAt: now },
    ]);
    const cards = store.table('inbox').list(item => item.status === 'open');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ refId: latest.id, title: '中心告警：额度', pushed: true });
    expect(store.table('inbox').count()).toBe(mode === 'both' ? 2 : 1);
    expect(ctx.host.calls.filter(call => call.method === 'notify')).toHaveLength(mode === 'none' ? 1 : 0);
    expect(pushHistory(ctx)).toHaveLength(mode === 'none' ? 1 : 0);
    await store.flush();
    const reloaded = new FileStore(source.fs, source.clock, '/hub', 'Asia/Shanghai', source.logger);
    await reloaded.load();
    expect(reloaded.table('alerts').list(item => item.status === 'open')).toHaveLength(1);
    expect(reloaded.table('inbox').list(item => item.status === 'open')).toHaveLength(1);
  });
});

describe('M09 主人可读的告警标题', () => {
  it.each([
    ['quota', '额度'], ['auth', '鉴权'], ['deadman', '掉线'], ['quarantine', '隔离'],
    ['protected_verify', '受保护文件校验'], ['host_approval_blocked', '宿主审批受阻'],
    ['host_approval_wait', '宿主审批等待'], ['future_code', '异常'], ['toString', '异常'],
  ])('%s 在中心卡与机器人卡上显示中文名 %s', async (code, name) => {
    for (const botId of [null, botFixture.id]) {
      const ctx = setup();
      raiseAlert(ctx, { ...quota, botId, code });
      await syncAlertItems(ctx);
      const title = `${botId === null ? '中心' : '巡检员'}告警：${name}`;
      expect(ctx.store.table('inbox').list()[0]?.title).toBe(title);
      expect(pushHistory(ctx)[0]?.title).toBe(title);
      expect(title).not.toContain(code);
    }
  });

  it('已有内部 code 标题更新为中文，不另建卡片或再次申请推送', async () => {
    const ctx = setup();
    raiseAlert(ctx, quota);
    await syncAlertItems(ctx);
    const item = ctx.store.table('inbox').list()[0]!;
    ctx.store.table('inbox').patch(item.id, { title: '中心告警：quota' });
    await syncAlertItems(ctx);
    expect(ctx.store.table('inbox').get(item.id)?.title).toBe('中心告警：额度');
    expect(ctx.store.table('inbox').list()).toHaveLength(1);
    expect(pushHistory(ctx)).toHaveLength(1);
  });
});
