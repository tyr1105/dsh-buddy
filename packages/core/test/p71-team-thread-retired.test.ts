/**
 * P71「砍掉团队全景」在引擎侧的回归：原来写进团队线程（thread = 'team'）的四类消息都换了去处。
 * - 日报：不再写进任何对话，正文记在审计 digest_generated，主人通过系统通知收到；旧版写在团队线程、还没推送的日报照样补推一次。
 * - 同伴消息、交接：落在说这句话的队友自己的私聊里。
 * - 告警：队友的告警进它自己的私聊；没有对应队友的中心告警只进「待你处理」，原文记一条审计。
 * - 中心事项的回答：只留在「待你处理」，不再写回团队线程。
 * 每条规则都配一个反例：确认团队线程里一条新消息都没有。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { answerInbox, createInboxItem } from '../src/outreach/inbox.js';
import { raiseAlert } from '../src/health/alerts.js';
import { closeHandoffForAgenda, createHandoff, sendMail } from '../src/peer/index.js';
import { toolFixture } from './c03-tool-fixtures.js';
import { botFixture } from './model-fixtures.js';

/** 团队线程里的全部消息：P71 之后新产生的消息一条都不该在这里。 */
function teamRows(ctx: Pick<HubContext, 'store'>) {
  return ctx.store.log('thread').all().filter(row => row.thread === 'team');
}

// P76c：原来这里有一组「P71 日报不再进任何对话」两条用例：到点生成的日报记在审计里、通知正文就是这份日报；旧版写在团队线程里
// 还没推送的日报升级后补推一次。两条都靠 maybeSendDigest 推送日报；日报不再推送（maybeSendDigest 与 tick 里的「日报」一项已删除），
// 「生成并推送」「补推旧日报」这两件事已不存在，两条删除。「日报不进任何对话」这一半仍然成立，并且更强：现在根本不生成、不推送，
// 由 test/p76c-retired.test.ts 经真实 Hub 的 tick 断言（没有日报通知、没有 digest_generated 审计、线程里没有日报消息）。

describe('P71 同伴消息和交接落到队友自己的私聊', () => {
  it('同伴消息记在发送方私聊，团队线程里没有', async () => {
    const { ctx, bot, peer } = toolFixture();
    // P74b：员工之间不再直接发消息，这条测消息落在哪个线程，所以把发送方设为总管（断言不变）。
    ctx.store.table('bots').patch(bot.id, { role: 'chief' });
    const mail = await sendMail(ctx, bot.id, { to: peer.id, text: '资料更新了' });
    expect(ctx.store.log('thread').all()).toEqual([expect.objectContaining({ thread: bot.id, from: bot.id, kind: 'peer', refId: mail.id })]);
    expect(teamRows(ctx)).toEqual([]);
  });

  it('发起交接记在发起方私聊；完成交接记在接收方私聊', async () => {
    const { ctx, bot, peer } = toolFixture();
    const handoff = await createHandoff(ctx, bot.id, { to: peer.id, task: '复核来源', why: '需要独立核验' });
    closeHandoffForAgenda(ctx, peer.id, handoff.agendaId!, 'done');
    const rows = ctx.store.log('thread').all().filter(row => row.kind === 'handoff');
    expect(rows.map(row => ({ thread: row.thread, from: row.from }))).toEqual([
      { thread: bot.id, from: bot.id },
      { thread: peer.id, from: peer.id },
    ]);
    expect(rows[1]!.text).toContain('完成了交接');
    expect(teamRows(ctx)).toEqual([]);
  });
});

describe('P71 告警与中心事项不再进团队线程', () => {
  it('队友的告警进它自己的私聊', async () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, name: '巡检员' });
    raiseAlert(ctx, { code: 'quarantine', botId: botFixture.id, text: '巡检员已隔离', level: 'P1', immediate: true });
    await syncAlertItems(ctx);
    const rows = ctx.store.log('thread').all().filter(row => row.kind === 'alert');
    expect(rows).toEqual([expect.objectContaining({ thread: botFixture.id, text: '巡检员已隔离' })]);
    expect(teamRows(ctx)).toEqual([]);
  });

  it('没有对应队友的中心告警只进「待你处理」，原文记审计，不写任何对话', async () => {
    const ctx = createTestContext();
    raiseAlert(ctx, { code: 'quota', botId: null, text: '额度已用尽', level: 'P0', immediate: true });
    await syncAlertItems(ctx);
    const card = ctx.store.table('inbox').list(row => row.type === 'alert')[0]!;
    expect(card).toMatchObject({ botId: null, status: 'open', title: '中心告警：额度' });
    expect(ctx.store.log('thread').all()).toEqual([]);
    const originals = ctx.store.log('audit').all().filter(row => row.action === 'hub_alert_original');
    expect(originals.map(row => JSON.parse(row.detail))).toEqual([expect.objectContaining({ inboxId: card.id, text: '额度已用尽' })]);
  });

  it('回答中心事项：只关卡片，不往团队线程写回答；队友事项照旧写回私聊', async () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, name: '巡检员' });
    // 没有队友归属的全队提问：走的是普通作答路径（告警卡走关闭路径，本来就不写线程）。
    const hubItem = createInboxItem(ctx, { botId: null, type: 'question', title: '全队要不要暂停', body: '需要你决定', subjectKey: 'hub-q',
      options: ['暂停', '继续'], defaultOption: '继续' });
    await answerInbox(ctx, hubItem.id, '继续');
    expect(ctx.store.table('inbox').get(hubItem.id)?.status).toBe('answered');
    expect(ctx.store.log('thread').all()).toEqual([]);
    const botItem = createInboxItem(ctx, { botId: botFixture.id, type: 'question', title: '选哪个', body: '需要你决定', subjectKey: 'q1',
      options: ['继续', '停止'], defaultOption: '停止' });
    await answerInbox(ctx, botItem.id, '继续');
    expect(ctx.store.log('thread').all()).toEqual([expect.objectContaining({ thread: botFixture.id, from: 'owner', kind: 'reply' })]);
    expect(teamRows(ctx)).toEqual([]);
  });
});
