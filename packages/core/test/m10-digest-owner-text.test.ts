/** M10 日报面向主人：额度灯复用中文标签；M11 修正汇报需有首句，审批仍不泄露原始参数。 */
import { describe, expect, it } from 'vitest';
import { overview } from '../src/api/summary-views.js';
import { resolveSettings } from '../src/config/defaults.js';
import { requestApproval } from '../src/gate/approvals.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { QUOTA_LIGHT_LABELS, type QuotaLight } from '../src/model/enums.js';
import { buildDigest } from '../src/outreach/digest.js';
import { requestPush } from '../src/outreach/push.js';
import { getQuotaState } from '../src/quota/window.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { botFixture } from './model-fixtures.js';

const local = (value: string) => parseLocalDateTime(value, 'Asia/Shanghai');

/** 两条普通通知占满单机器人预算，第三条真实审批产生待汇总记录。 */
async function deferredContext() {
  const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub' }) });
  ctx.store.table('bots').put(botFixture);
  ctx.clock.set(local('2026-11-05 09:00'));
  for (const subjectKey of ['first', 'second']) await requestPush(ctx, {
    botId: botFixture.id, level: 'P1', subjectKey, title: '前置事项', body: '无需进入日报的正文' });
  await requestApproval(ctx, botFixture.id, 'bash', { cmd: 'say 早盘已更新', memo: '此处原始参数不得进入日报' }, 'C', '确认后播报');
  ctx.clock.set(local('2026-11-05 23:30'));
  await requestPush(ctx, { botId: botFixture.id, level: 'P2', subjectKey: 'night', title: '机器人汇报', body: '夜间检查发现备份失败。第二句详细排查过程留在线程。' });
  ctx.clock.set(local('2026-11-06 08:30'));
  return ctx;
}

describe('M10 日报主人文字', () => {
  it.each(Object.keys(QUOTA_LIGHT_LABELS) as QuotaLight[])('额度灯 %s 的日报标签与总览完全一致', async light => {
    const ctx = await deferredContext();
    const quota = { ...getQuotaState(ctx, ctx.clock.now()), light };
    ctx.store.table('quota').put(quota);
    const digest = buildDigest(ctx, ctx.clock.now());
    const label = overview(ctx).quota.lightLabel;
    expect(digest.split('\n').find(row => row.startsWith('额度用量：'))).toBe(`额度用量：0/8 回合，0 token，${label}`);
    expect(digest).not.toMatch(/\b(green|yellow|orange|red)\b/);
  });

  it('未单独推送按类别区分：审批只列动作，汇报带队友名和首句', async () => {
    const ctx = await deferredContext();
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest.split('\n未单独推送\n')[1]).toBe(`- 批准：运行命令 say 早盘已更新（超出打扰预算）\n- ${botFixture.name}的汇报：夜间检查发现备份失败。（免打扰已推迟）`);
    expect(digest).not.toContain('原始参数');
    expect(digest).not.toContain('此处原始参数不得进入日报');
    expect(digest).not.toContain('第二句详细排查过程');
    expect(digest).not.toContain('"cmd"');
  });
});
