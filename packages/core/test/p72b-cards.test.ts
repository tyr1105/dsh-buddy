/**
 * P72b 交账时发约定卡的测试（文件名原为「发布」类名字，按总控要求改为 cards）：
 * 顺序、待你处理条目、新版换条目、amend 只落旁白、撤下、合成交账、兜底补发、出错隔离、收件箱放宽。
 */
import { describe, expect, it } from 'vitest';
import type { FakeClock } from '../src/io/testing/fake-clock.js';
import { createInboxItem, expireInbox } from '../src/outreach/inbox.js';
import { postAgreementCards, sweepUnpostedAgreements } from '../src/project/agreement-cards.js';
import { AGREEMENT_DEFAULTS } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { agreementFixture, versionFixture, wakeTicket } from './p72a-agreement-fixtures.js';
import { callTool, chiefDrafts, chiefReplies, lockAgreement, ownerSays, runningWake, setup, speak, type Fix } from './p72b-fixtures.js';

const TITLE = '每日报价页';

/** 总管提交新约定并交账（带一句结论），返回约定 id。 */
async function draftAndCommit(fix: Fix): Promise<string> {
  const id = await chiefDrafts(fix);
  await speak(fix, fix.chief, '已记下，请看卡片');
  return id;
}

/** 主人再说一句，总管按给定参数修订，然后交账。 */
async function followUpAndCommit(fix: Fix, args: Record<string, unknown>, reply = '改好了') {
  await ownerSays(fix, fix.chief.id, '再改一下');
  const result = await callTool(fix, fix.chief, 'hub_agreement_submit', args);
  expect(result).toMatchObject({ ok: true });
  await speak(fix, fix.chief, reply);
}

const MORE_DONE = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '页面在手机上能看'];

describe('交账发卡', () => {
  it('新建约定后交账：私聊依次是总管 reply、建主题旁白、约定卡；版本记下卡片消息 id', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const replies = chiefReplies(fix.ctx, fix.chief.id);
    expect(replies.map(row => [row.kind, row.from])).toEqual([['reply', fix.chief.id], ['system', 'hub'], ['agreement', fix.chief.id]]);
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    expect(replies[1]!.text).toBe(`总管为这件事建立了主题「${TITLE}」，后续进展都记在那里。`);
    expect(replies[1]!.refId).toBe(agreement.topicId);
    expect(replies[2]).toMatchObject({ text: `约定「${TITLE}」第 1 版`, refId: id });
    expect(agreement.versions[0]!.cardMessageId).toBe(replies[2]!.id);
  });

  it('发卡后「待你处理」有一条：只有一个按钮、无默认、不到期；拨到 30 天后仍然开着', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith('agreement:'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: agreement.inboxId, botId: fix.chief.id, type: 'question', priority: 'P1', status: 'open',
      options: ['按建议，定了'], defaultOption: null, expiresAt: null, topicId: agreement.topicId, refId: id,
      subjectKey: `agreement:${id}:1`, title: `约定第 1 版待你确认：${TITLE}`,
    });
    expect(items[0]!.body).toContain('报价从哪里取：公开接口');
    // P74r14 第 6 节改了预期：原来断言正文里有「不会自动按建议处理。你确认前不会开工。」；这类说明行现在只由界面按标记显示，正文不再带。
    expect(items[0]!.body).not.toContain('不会自动按建议处理');
    expect(items[0]!.body).not.toContain('你确认前不会开工');
    (fix.ctx.clock as FakeClock).advance(30 * 24 * 3600 * 1000);
    await expireInbox(fix.ctx, fix.ctx.clock.now());
    expect(fix.ctx.store.table('inbox').get(items[0]!.id)!.status).toBe('open');
  });

  it('出第 2 版并交账：第 1 版条目变 withdrawn，新条目以 :2 结尾；不再出建主题旁白', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const first = fix.ctx.store.table('agreements').get(id)!.inboxId!;
    await followUpAndCommit(fix, { agreementId: id, changeNote: '加一条验收', doneWhen: MORE_DONE });
    expect(fix.ctx.store.table('inbox').get(first)).toMatchObject({ status: 'withdrawn', answer: '已出新版本' });
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const current = fix.ctx.store.table('inbox').get(agreement.inboxId!)!;
    expect(current.status).toBe('open');
    expect(current.subjectKey.endsWith(':2')).toBe(true);
    const replies = chiefReplies(fix.ctx, fix.chief.id);
    expect(replies.filter(row => row.text.startsWith('总管为这件事建立了主题'))).toHaveLength(1);
    expect(replies.filter(row => row.kind === 'agreement').map(row => row.text)).toEqual([`约定「${TITLE}」第 1 版`, `约定「${TITLE}」第 2 版`]);
  });

  it('amend 交账：不出卡、不建收件箱条目，私聊出现旁白', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    lockAgreement(fix.ctx, id);
    const itemsBefore = fix.ctx.store.table('inbox').count();
    await followUpAndCommit(fix, { agreementId: id, mode: 'amend', changeNote: '复述改个说法', summary: '做一个看每日报价的页面' });
    expect(fix.ctx.store.log('thread').all().filter(row => row.kind === 'agreement')).toHaveLength(1);
    expect(fix.ctx.store.table('inbox').count()).toBe(itemsBefore);
    const note = `已按你的指示记入约定「${TITLE}」第 2 版。`;
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    expect(chiefReplies(fix.ctx, fix.chief.id).some(row => row.text === note)).toBe(true);
    expect(agreement.versions[1]!.cardMessageId).not.toBeNull();
    // 主人是在私聊里说的，约定主题里也留一句。
    expect(fix.ctx.store.log('thread').all().some(row => row.thread === agreement.topicId && row.text === note)).toBe(true);
  });

  it('withdraw 交账：私聊出现撤下旁白，收件箱条目变 withdrawn', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const inboxId = fix.ctx.store.table('agreements').get(id)!.inboxId!;
    await followUpAndCommit(fix, { agreementId: id, mode: 'withdraw', reason: '主人说不做了' }, '好，不做了');
    expect(chiefReplies(fix.ctx, fix.chief.id).some(row => row.text === `约定「${TITLE}」已撤下，不会开工。`)).toBe(true);
    expect(fix.ctx.store.table('inbox').get(inboxId)).toMatchObject({ status: 'withdrawn', answer: '约定已撤下' });
    expect(fix.ctx.store.table('agreements').get(id)!.withdrawn!.noticeMessageId).not.toBeNull();
  });

  it('合成交账（回合结束却没交账）也会发卡', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    // 不交账，直接让回合结束：中心会合成一份交账。
    await fix.hub.onTurnEvent({ type: 'ended', sessionId: fix.chief.sessionId!, at: fix.ctx.clock.now(), finalText: '', tokens: 100 });
    expect(chiefReplies(fix.ctx, fix.chief.id).some(row => row.kind === 'agreement')).toBe(true);
    expect(fix.ctx.store.table('agreements').get(id)!.versions[0]!.cardMessageId).not.toBeNull();
  });

  it('重复调用 postAgreementCards 不会重复发卡', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const wakeId = fix.ctx.store.table('agreements').get(id)!.versions[0]!.wakeId!;
    postAgreementCards(fix.ctx, wakeId);
    expect(fix.ctx.store.log('thread').all().filter(row => row.kind === 'agreement')).toHaveLength(1);
  });
});

describe('兜底补发', () => {
  /** 在存储里放一份「卡片没发出」的约定，唤醒单状态由调用方决定。 */
  async function unposted(fix: Fix, createdAt: number) {
    const agreement = agreementFixture({
      botId: fix.chief.id, originThread: fix.chief.id, projectId: fix.project.id, topicId: 'ptp_0000000009',
      versions: [versionFixture(1, { wakeId: 'w_0000000042', createdAt })],
    });
    fix.ctx.store.table('agreements').put(agreement);
    return agreement;
  }

  it('唤醒单不存在：补发（即使刚创建）', async () => {
    const fix = await setup();
    const agreement = await unposted(fix, fix.ctx.clock.now());
    sweepUnpostedAgreements(fix.ctx, fix.ctx.clock.now());
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.versions[0]!.cardMessageId).not.toBeNull();
  });

  it('唤醒单已结束且超过宽限：补发；未超过宽限：不发', async () => {
    const fix = await setup();
    const now = fix.ctx.clock.now();
    const agreement = await unposted(fix, now);
    fix.ctx.store.table('wakes').put(wakeTicket(fix.ctx, fix.chief.id, { kind: 'owner_message', evidence: [] }, { id: 'w_0000000042', status: 'committed', endedAt: now }));
    sweepUnpostedAgreements(fix.ctx, now + AGREEMENT_DEFAULTS.UNPUBLISHED_GRACE_MS - 1);
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.versions[0]!.cardMessageId).toBeNull();
    sweepUnpostedAgreements(fix.ctx, now + AGREEMENT_DEFAULTS.UNPUBLISHED_GRACE_MS + 1);
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.versions[0]!.cardMessageId).not.toBeNull();
  });

  it('唤醒单还在跑：不补发', async () => {
    const fix = await setup();
    const now = fix.ctx.clock.now();
    const agreement = await unposted(fix, 1000);
    fix.ctx.store.table('wakes').put(wakeTicket(fix.ctx, fix.chief.id, { kind: 'owner_message', evidence: [] }, { id: 'w_0000000042', status: 'running' }));
    sweepUnpostedAgreements(fix.ctx, now + 10 * AGREEMENT_DEFAULTS.UNPUBLISHED_GRACE_MS);
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.versions[0]!.cardMessageId).toBeNull();
  });
});

describe('出错隔离', () => {
  // P72j J1：总管名下有待确认约定时，交账带 ownerQuestion 一律被拒，所以这里改用同一回合的建议（proposals）
  // 验证同一件事：发卡出错不挡住后面的提问、提议路由。
  it('一份约定发卡出错（原线程不存在）时，同一回合的建议仍进收件箱', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '你看看');
    const wake = runningWake(fix.ctx, fix.chief.id)!;
    fix.ctx.store.table('agreements').put(agreementFixture({
      botId: fix.chief.id, originThread: 'b_nonexistent', projectId: fix.project.id, topicId: 'ptp_0000000009',
      versions: [versionFixture(1, { wakeId: wake.id })],
    }));
    await speak(fix, fix.chief, '看过了', {
      proposals: [{ title: '要不要加周报', detail: '影响范围', value: 0.9, confidence: 0.9 }],
    });
    expect(fix.ctx.store.table('inbox').list(row => row.title === '要不要加周报')).toHaveLength(1);
    // 坏约定没有被发出去。
    expect(fix.ctx.store.table('agreements').get('agr_0000000001')!.versions[0]!.cardMessageId).toBeNull();
  });
});

describe('createInboxItem 对约定条目的放宽', () => {
  const base = { type: 'question' as const, title: '约定待确认', body: '正文', priority: 'P1' as const };
  function inboxCtx() {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture });
    return ctx;
  }

  it('反例：普通提问只给 1 个选项仍被拒', () => {
    const ctx = inboxCtx();
    expect(() => createInboxItem(ctx, { ...base, botId: botFixture.id, subjectKey: 'question:x', options: ['按建议，定了'], defaultOption: '按建议，定了' }))
      .toThrow('至少提供两个选项');
  });
  it('正例：subjectKey 以 agreement: 开头、选项为「按建议，定了」、期限为 null、无默认项时通过', () => {
    const ctx = inboxCtx();
    const item = createInboxItem(ctx, { ...base, botId: botFixture.id, subjectKey: 'agreement:agr_0000000001:1', options: ['按建议，定了'], defaultOption: null, expiresAt: null });
    expect(item).toMatchObject({ options: ['按建议，定了'], defaultOption: null, expiresAt: null, status: 'open' });
  });
  it('反例：同样前缀但带了 expiresAt、带了默认项、选项不对或没写 expiresAt 都被拒', () => {
    const ctx = inboxCtx();
    const ok = { ...base, botId: botFixture.id, subjectKey: 'agreement:agr_0000000001:1', options: ['按建议，定了'], defaultOption: null, expiresAt: null };
    expect(() => createInboxItem(ctx, { ...ok, expiresAt: 123 })).toThrow('expiresAt');
    expect(() => createInboxItem(ctx, { ...ok, defaultOption: '按建议，定了' })).toThrow('defaultOption');
    expect(() => createInboxItem(ctx, { ...ok, options: ['好', '不好'] })).toThrow('options');
    const { expiresAt: _omitted, ...withoutExpiry } = ok;
    expect(() => createInboxItem(ctx, withoutExpiry)).toThrow('expiresAt');
    expect(ctx.store.table('inbox').count()).toBe(0);
  });
});
