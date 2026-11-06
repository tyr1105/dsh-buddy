/** M10 额度文字使用绝对期限并随保护进展更新；假时钟跨日后无候选也不能把过期时刻显示成今天。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createUiApi } from '../src/api/index.js';
import { onQuotaError, maybeAllowProbe, consumeProbe, quotaProtectionText, rollWindow } from '../src/quota/window.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { buildDigest } from '../src/outreach/digest.js';
import { pushHistory } from '../src/outreach/push.js';
import { botFixture } from './model-fixtures.js';

const initial = Date.parse('2026-11-04T15:00:00+08:00');

/** 只建立在岗档案，不注入唤醒候选，使过期后的“等待试运行”有真实可核对的状态。 */
function setup() {
  const ctx = createTestContext();
  ctx.clock.set(initial);
  ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', activity: 'watching', activityText: '继续关注变化' });
  return { ctx, api: createUiApi(ctx, async () => undefined) };
}

describe('M10 额度保护时间文案', () => {
  it('尚未到期用绝对日期，到期边界立即改成等待试运行，并遵循设置时区', () => {
    const { ctx } = setup();
    const state = onQuotaError(ctx, initial);
    expect(quotaProtectionText(state, initial, 'Asia/Shanghai')).toBe('额度保护，11月4日 20:05 后继续');
    expect(quotaProtectionText(state, initial, 'Asia/Tokyo')).toBe('额度保护，11月4日 21:05 后继续');
    expect(quotaProtectionText(state, state.redUntil! - 1, 'Asia/Shanghai')).toBe('额度保护，11月4日 20:05 后继续');
    expect(quotaProtectionText(state, state.redUntil!, 'Asia/Shanghai')).toBe('额度保护，等待一次试运行');
    expect(quotaProtectionText({ ...state, redUntil: null }, initial, 'Asia/Shanghai')).toBe('额度保护，等待一次试运行');
  });

  it('跨年期限写明年份，不生成固定的今天或明天', () => {
    const { ctx } = setup();
    const state = onQuotaError(ctx, initial);
    expect(quotaProtectionText({ ...state, redUntil: Date.parse('2027-01-01T01:05:00+08:00') }, initial, 'Asia/Shanghai'))
      .toBe('额度保护，2027年1月1日 01:05 后继续');
  });

  it('跨日没有候选时，状态、卡片、日报改成等待一次试运行，刷新不增加告警次数或推送', async () => {
    const { ctx, api } = setup();
    onQuotaError(ctx, initial);
    await syncAlertItems(ctx);
    const first = ctx.store.table('alerts').list(row => row.code === 'quota')[0]!;
    expect(api.overview().bots[0]?.activityText).toBe('额度保护，11月4日 20:05 后继续');
    expect(api.inbox().items[0]?.body).toBe('额度保护，11月4日 20:05 后继续');
    ctx.clock.set(Date.parse('2026-11-05T09:00:00+08:00'));
    expect(ctx.store.table('queue').count()).toBe(0);
    expect(maybeAllowProbe(ctx, ctx.clock.now())).toBe(true);
    await syncAlertItems(ctx);
    expect(api.overview().bots[0]?.activityText).toBe('额度保护，等待一次试运行');
    expect(api.inbox().items[0]?.body).toBe('额度保护，等待一次试运行');
    expect(buildDigest(ctx, ctx.clock.now()).split('\n').find(line => line.startsWith('告警：')))
      .toBe('告警：[P0] 额度保护，等待一次试运行');
    expect(maybeAllowProbe(ctx, ctx.clock.now())).toBe(false);
    await syncAlertItems(ctx);
    expect(ctx.store.table('alerts').get(first.id)).toMatchObject({ count: 1, firstAt: initial, lastAt: initial });
    expect(ctx.store.table('queue').count()).toBe(0);
    expect(ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red', probeAllowed: true });
    expect(pushHistory(ctx).filter(row => row.result === 'sent')).toHaveLength(1);
  });

  it('第二次 429 延后试运行时，已经 resting 的队友与开放卡同步新期限并保留恢复前状态', async () => {
    const { ctx, api } = setup();
    onQuotaError(ctx, initial);
    await syncAlertItems(ctx);
    const priorRest = ctx.store.table('bots').get(botFixture.id)!.quotaRest;
    ctx.clock.set(Date.parse('2026-11-05T09:00:00+08:00'));
    expect(maybeAllowProbe(ctx, ctx.clock.now())).toBe(true);
    expect(consumeProbe(ctx)).toBe(true);
    rollWindow(ctx, ctx.clock.now());
    expect(api.overview().bots[0]?.activityText).toBe('额度保护，正在试运行');
    onQuotaError(ctx, ctx.clock.now());
    await syncAlertItems(ctx);
    expect(api.overview().bots[0]?.activityText).toBe('额度保护，11月5日 14:05 后继续');
    expect(api.inbox().items[0]?.body).toBe('额度保护，11月5日 14:05 后继续');
    expect(ctx.store.table('bots').get(botFixture.id)?.quotaRest).toEqual(priorRest);
    expect(ctx.store.table('quota').get('quota')).toMatchObject({ probeInFlight: false, probeAllowed: false });
    expect(pushHistory(ctx).filter(row => row.result === 'sent')).toHaveLength(1);
  });

  it.each(['paused', 'waiting_owner'] as const)('刷新额度文字不覆盖 %s 的独立主人状态', async state => {
    const { ctx } = setup();
    onQuotaError(ctx, initial);
    ctx.store.table('bots').patch(botFixture.id, state === 'paused'
      ? { lifecycle: 'paused', activity: 'resting', activityText: '已暂停（你暂停的）' }
      : { activity: 'waiting_owner', activityText: '在等主人回复' });
    ctx.clock.set(Date.parse('2026-11-05T09:00:00+08:00'));
    maybeAllowProbe(ctx, ctx.clock.now());
    onQuotaError(ctx, ctx.clock.now());
    expect(ctx.store.table('bots').get(botFixture.id)?.activityText)
      .toBe(state === 'paused' ? '已暂停（你暂停的）' : '在等主人回复');
  });
});
