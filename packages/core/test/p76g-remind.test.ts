/**
 * P76g 的测试（四）：在等你，开着满 24 小时提醒一次（job/wait-remind.ts），以及条目视图的「已等 {时长}」。
 *
 * 夹具与真实一致（总管自动创建、听吩咐；执行类员工听吩咐）；时钟每步不超过 10 分钟，24 小时、48 小时写成循环，每步巡检一次。
 */
import { describe, expect, it } from 'vitest';
import { waitMatterOf, remindText } from '../src/job/wait-remind.js';
import { inboxView } from '../src/api/feed-views.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { flushPushQueue } from '../src/outreach/notify.js';
import { speak, chiefDrafts, jobFix } from './p74b-fixtures.js';
import { INTERNAL } from './p74d-fixtures.js';
import { delivered } from './p74f-fixtures.js';
import { MINUTE, advanceSweeping, chiefSays, noticeRow, pushedTitles } from './p76g-fixtures.js';

const HOUR = 60 * MINUTE;

/** 推进到距这一条建立恰好 ms 毫秒（每步 10 分钟，每步巡检一次）。 */
function advanceTo(fix: Awaited<ReturnType<typeof jobFix>>, createdAt: number, ms: number): void {
  const left = createdAt + ms - fix.ctx.clock.now();
  if (left > 0) advanceSweeping(fix, left);
}

/** 让通知队列发出（10 分钟合并窗口：过 10 分钟再整理）。 */
async function settleOutbox(fix: Awaited<ReturnType<typeof jobFix>>): Promise<void> {
  await flushPushQueue(fix.ctx, fix.ctx.clock.now());
  fix.ctx.clock.advance(10 * MINUTE);
  await flushPushQueue(fix.ctx, fix.ctx.clock.now());
  await flushPushQueue(fix.ctx, fix.ctx.clock.now());
}

describe('1 验收条目开着 24 小时：总管私聊一句、推送一次，之后不再提醒', () => {
  it('23 小时 50 分不提醒；满 24 小时提醒一次（私聊逐字、推送一次）；48 小时、72 小时不再提醒', async () => {
    const { fix, job } = await delivered();
    const item = fix.ctx.store.table('inbox').get(job.inboxId!)!;
    expect(item.subjectKey).toBe(`job:${job.id}:accept:1`);
    advanceTo(fix, item.createdAt, 24 * HOUR - 10 * MINUTE);
    expect(chiefSays(fix).filter(text => text.includes('还在等你'))).toEqual([]);
    expect(noticeRow(fix, job.id)?.remindedItemIds ?? []).toEqual([]);

    advanceTo(fix, item.createdAt, 24 * HOUR);
    const said = chiefSays(fix).filter(text => text.includes('还在等你'));
    expect(said).toEqual(['会员定价页还在等你验收，已等 24 小时。交付时间是 11月17日 18:00 前。']);
    expect(noticeRow(fix, job.id)!.remindedItemIds).toEqual([item.id]);
    await settleOutbox(fix);
    expect(pushedTitles(fix).filter(title => title === '会员定价页还在等你')).toHaveLength(1);
    expect(said[0]).not.toMatch(INTERNAL);

    // 48 小时、72 小时：不再提醒，也不再推送。
    advanceTo(fix, item.createdAt, 72 * HOUR);
    await settleOutbox(fix);
    expect(chiefSays(fix).filter(text => text.includes('还在等你'))).toHaveLength(1);
    expect(pushedTitles(fix).filter(title => title === '会员定价页还在等你')).toHaveLength(1);
  });

  it('提醒发出之前这一条已经被处理：不推送（带条目编号），私聊也不再落', async () => {
    const { fix, job } = await delivered();
    const item = fix.ctx.store.table('inbox').get(job.inboxId!)!;
    advanceTo(fix, item.createdAt, 24 * HOUR);
    // 提醒已经写进队列，发出之前你验收了：条目不再开着，这一行作废。
    expect(fix.ctx.store.table('pushQueue').list(row => row.subjectKey === `remind:${item.id}`)).toHaveLength(1);
    fix.ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: '验收通过', answeredAt: fix.ctx.clock.now() });
    await settleOutbox(fix);
    expect(pushedTitles(fix).filter(title => title === '会员定价页还在等你')).toHaveLength(0);
    expect(fix.ctx.store.table('pushQueue').list(row => row.subjectKey === `remind:${item.id}`).every(row => row.state === 'dropped')).toBe(true);
  });
});

describe('2 约定确认条目（这份约定还没有事）同样提醒一次', () => {
  it('提醒记号写在以约定编号为 id 的行里；正文没有交付时间那一句；只提醒一次', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页' });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    const agreement = fix.ctx.store.table('agreements').list().find(row => row.title === '会员定价页')!;
    const item = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`agreement:${agreement.id}:`))[0]!;
    expect(fix.ctx.store.table('jobs').list()).toHaveLength(0);
    advanceTo(fix, item.createdAt, 24 * HOUR - 10 * MINUTE);
    expect(chiefSays(fix).filter(text => text.includes('还在等你'))).toEqual([]);
    advanceTo(fix, item.createdAt, 24 * HOUR);
    expect(chiefSays(fix).filter(text => text.includes('还在等你'))).toEqual(['会员定价页还在等你确认约定第 1 版，已等 24 小时。']);
    expect(noticeRow(fix, agreement.id)!.remindedItemIds).toEqual([item.id]);
    await settleOutbox(fix);
    expect(pushedTitles(fix).filter(title => title === '会员定价页还在等你')).toHaveLength(1);
    advanceTo(fix, item.createdAt, 60 * HOUR);
    expect(chiefSays(fix).filter(text => text.includes('还在等你'))).toHaveLength(1);
  });
});

describe('3 与一件事无关的条目不提醒', () => {
  it('员工的普通提问开着 25 小时：不提醒、不记记号、不推送', async () => {
    const fix = await jobFix();
    const item = createInboxItem(fix.ctx, { botId: fix.engineer.id, type: 'question', title: '价格表放哪？', body: '放项目根目录还是资料夹？', options: ['根目录', '资料夹'],
      defaultOption: '根目录', expiresAt: null, priority: 'P2', refId: null, subjectKey: 'question:i_aaaaaaaaaa' });
    advanceTo(fix, item.createdAt, 25 * HOUR);
    expect(chiefSays(fix).filter(text => text.includes('还在等你'))).toEqual([]);
    expect(fix.ctx.store.table('jobNotices').list()).toHaveLength(0);
    await settleOutbox(fix);
    expect(fix.ctx.store.table('pushQueue').list(row => row.subjectKey.startsWith('remind:'))).toHaveLength(0);
  });
});

describe('4 句子', () => {
  it('{事项}：各种条目的写法逐字（验收、预计消耗、三轮不过、没有进展、约定确认、审批）', () => {
    const key = (tail: string) => `job:job_aaaaaaaaaa:${tail}`;
    expect(waitMatterOf({ type: 'question', title: '', subjectKey: key('accept:1') })).toBe('验收');
    expect(waitMatterOf({ type: 'question', title: '', subjectKey: key('cap:8') })).toBe('决定预计消耗怎样处理');
    expect(waitMatterOf({ type: 'question', title: '', subjectKey: key('escalate:1') })).toBe('选一个办法');
    expect(waitMatterOf({ type: 'question', title: '', subjectKey: key('stall:1') })).toBe('决定怎样继续');
    expect(waitMatterOf({ type: 'question', title: '', subjectKey: 'agreement:agr_aaaaaaaaaa:3' })).toBe('确认约定第 3 版');
    expect(waitMatterOf({ type: 'approval', title: '发布到站点', subjectKey: 'approval:ap_aaaaaaaaaa' })).toBe('批准发布到站点');
  });

  it('整句：有交付时间写第二句，没有就去掉；时长按小时、天写', () => {
    expect(remindText('会员定价页', '验收', 24 * HOUR, { dueAt: Date.UTC(2026, 10, 17, 10, 0) }, 'Asia/Shanghai')).toBe('会员定价页还在等你验收，已等 24 小时。交付时间是 11月17日 18:00 前。');
    expect(remindText('会员定价页', '验收', 24 * HOUR, { dueAt: null }, 'Asia/Shanghai')).toBe('会员定价页还在等你验收，已等 24 小时。');
    expect(remindText('会员定价页', '验收', 72 * HOUR, null, 'Asia/Shanghai')).toBe('会员定价页还在等你验收，已等 3 天。');
  });
});

describe('5 条目视图的「已等 {时长}」：开着满 1 小时才有', () => {
  it('59 分钟没有；1 小时「已等 1 小时」；25 小时「已等 25 小时」', async () => {
    const { fix, job } = await delivered();
    const item = fix.ctx.store.table('inbox').get(job.inboxId!)!;
    const waited = () => inboxView(fix.ctx).items.find(row => row.id === item.id)!.waitedText;
    expect(waited()).toBeUndefined();
    fix.ctx.clock.advance(Math.max(0, item.createdAt + 59 * MINUTE - fix.ctx.clock.now()));
    expect(waited()).toBeUndefined();
    fix.ctx.clock.advance(item.createdAt + HOUR - fix.ctx.clock.now());
    expect(waited()).toBe('已等 1 小时');
    advanceSweeping(fix, item.createdAt + 25 * HOUR - fix.ctx.clock.now());
    expect(waited()).toBe('已等 25 小时');
  });
});
