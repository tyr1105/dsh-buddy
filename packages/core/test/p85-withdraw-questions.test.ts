/**
 * P85 第 3.1、3.2 节的测试：提问只在主人的话真的交给那位员工时才撤回；提问卡回答那一回合哪些事能做、哪些不能。
 *
 * 3.1（审查 W1、W2）：
 * - 五种被中心认领、不叫醒员工的话（额度口令、「定了」两张以上在等、「验收通过」、「撤销」、组队三问的回答）：
 *   更早的提问仍开着，「等你回答」的条件（条目开着）没有解开，员工没有被叫醒；
 * - 一句真的叫醒员工的话：提问撤回，答复栏逐字是固定句，唤醒包里写明是哪一条提问被撤回。
 * 3.2（审查 W3）：P83 把「主人回答提问卡」与「主人直接回话」在六处共用的判断里等价起来，各处的结果：
 * - 停止一件事、记住记忆、删掉记忆：仍然被拒（三条反例，各靠 refId 检查挡住）；
 * - 修改组队卡：放行，改后的组队卡仍在等主人确认（正例）；
 * - 派活：去重键换成那条回答的消息编号，同一条回答只派一次。
 * 全部走真实 Hub（假宿主、假时钟）。
 */
import { describe, expect, it } from 'vitest';
import type { HubContext } from '../src/engine/context.js';
import type { InboxItem } from '../src/model/outreach.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { postThread, sendOwnerMessage } from '../src/outreach/thread.js';
import { STALE_QUESTION_ANSWER } from '../src/outreach/stale-questions.js';
import { writeMemory } from '../src/memory/service.js';
import { newId } from '../src/util/ids.js';
import { STOP_REFUSED_TEXT } from '../src/job/stop.js';
import { NOT_OWN_WORDS_TEXT } from '../src/memory/forget.js';
import { NOTE_NOT_OWN_WORDS_TEXT } from '../src/memory/note.js';
import { agreementFixture, versionFixture } from './p72a-agreement-fixtures.js';
import { setup as agreementSetup } from './p72b-fixtures.js';
import { jobFix, assignArgs, callTool, lockedAndAwake, threadOf } from './p74b-fixtures.js';
import { assigned, entriesOf, wakesOf } from './p74c-fixtures.js';
import { agreementIdIn, proposeResearcher, teamFix, theProposal } from './p73d-fixtures.js';
import { bot, chiefTurn, delivered, ownerTypes } from './p74f-fixtures.js';
import { teamHub } from './p73c-fixtures.js';
import { chiefHears, noteArgs, speak } from './p75c-fixtures.js';

const HOUR = 60 * 60_000;
const at = (text: string) => Date.parse(`${text}+08:00`);
/** 提问卡上的内容（与真实使用同形：两个选项，其中一个默认）。 */
const QUESTION = { text: '这一版的标题要不要加副标题', options: ['加', '不加'], defaultOption: '不加', whyNeeded: '才能继续做' };

/** 一条落在这位员工私聊里的普通提问（带提问卡消息）。 */
function privateQuestion(ctx: HubContext, botId: string, key = 'question:i_0000000012'): InboxItem {
  const item = createInboxItem(ctx, { botId, type: 'question', title: '问一句', body: '理由', options: ['甲', '乙'], defaultOption: '甲',
    refId: null, expiresAt: null, subjectKey: key });
  postThread(ctx, { thread: botId, from: botId, kind: 'question', text: '问一句', refId: item.id });
  return item;
}

/** 这条提问还开着、答复栏没有被写（「等你回答」闸门按条目开着数）。 */
function stillOpen(ctx: HubContext, id: string): void {
  const row = ctx.store.table('inbox').get(id)!;
  expect(row.status).toBe('open');
  expect(row.answer).toBeNull();
}

describe('3.1 被中心认领、不叫醒员工的话：提问不撤回', () => {
  it('额度口令「我接下来 2 小时要用」：提问仍开着，总管没有被叫醒', async () => {
    const fix = await jobFix();
    fix.ctx.clock.set(at('2026-11-13T18:00:00'));
    const item = privateQuestion(fix.ctx, fix.chief.id);
    const before = wakesOf(fix, fix.chief.id).length + entriesOf(fix, fix.chief.id).length;
    sendOwnerMessage(fix.ctx, fix.chief.id, '我接下来2小时要用');
    stillOpen(fix.ctx, item.id);
    expect(wakesOf(fix, fix.chief.id).length + entriesOf(fix, fix.chief.id).length).toBe(before);
  });

  it('「定了」：有两张以上约定在等、中心落了说明时，不叫醒总管，提问仍开着', async () => {
    const fix = await agreementSetup();
    const chief = fix.chief;
    for (const [id, card] of [['agr_0000000001', 'm_0000000091'], ['agr_0000000002', 'm_0000000092']] as const) {
      fix.ctx.store.table('agreements').put(agreementFixture({ id, botId: chief.id, originThread: chief.id,
        versions: [versionFixture(1, { cardMessageId: card })] }));
    }
    const item = privateQuestion(fix.ctx, chief.id);
    const before = fix.ctx.store.table('wakes').count(row => row.botId === chief.id) + fix.ctx.store.table('queue').count(row => row.botId === chief.id);
    sendOwnerMessage(fix.ctx, chief.id, '定了');
    // 中心确实认领了这句话（落了「现在有 2 张约定在等你确认」那句）。
    expect(threadOf(fix.ctx, chief.id).some(row => row.from === 'hub' && row.text.includes('2 张约定在等你确认'))).toBe(true);
    stillOpen(fix.ctx, item.id);
    expect(fix.ctx.store.table('wakes').count(row => row.botId === chief.id) + fix.ctx.store.table('queue').count(row => row.botId === chief.id)).toBe(before);
  });

  it('「验收通过」认领验收：提问仍开着', async () => {
    const { fix, job } = await delivered();
    const item = privateQuestion(fix.ctx, job.chiefId);
    await ownerTypes(fix, job.chiefId, '验收通过');
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('done');
    stillOpen(fix.ctx, item.id);
  });

  it('「撤销」认领记忆撤销：提问仍开着', async () => {
    const fix = await jobFix();
    const item = privateQuestion(fix.ctx, fix.chief.id);
    const memory = await writeMemory(fix.ctx, { kind: 'rule', text: '提示都用请字开头', example: '写「请输入」', redLine: false, scope: { staff: 'all', projects: 'all' },
      source: { kind: 'owner_words', messageIds: [], quote: '以后提示都用请字开头', threadId: fix.chief.id } });
    // 紧挨在「撤销」之前的是总管的一条回复，下面挂着「已记住」。
    const reply = { id: newId('m', fix.ctx.rng), thread: fix.chief.id, from: fix.chief.id, kind: 'reply' as const, text: '已记住：提示都用请字开头。',
      refId: null, createdAt: fix.ctx.clock.now(), readAt: null };
    fix.ctx.store.log('thread').append(reply);
    fix.ctx.store.table('memories').patch(memory.id, { replyMessageId: reply.id });
    await fix.hub.api.sendMessage(fix.chief.id, '撤销');
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('undone');
    stillOpen(fix.ctx, item.id);
  });

  it('组队三问进行中，在总管私聊里答三问的话：提问仍开着，总管没有被叫醒', async () => {
    const fix = await teamHub();
    const chief = fix.chief!;
    const item = privateQuestion(fix.ctx as unknown as HubContext, chief.id);
    fix.ctx.runtime.startedAt -= HOUR;
    fix.ctx.clock.advance(HOUR);
    const result = await fix.hub.api.sendMessage(chief.id, '主要做网页');
    expect(result.ok).toBe(true);
    expect(fix.ctx.store.table('teamSetups').list()[0]!.step).toBe(2);
    stillOpen(fix.ctx as unknown as HubContext, item.id);
    expect(fix.ctx.store.table('wakes').count(row => row.botId === chief.id)).toBe(0);
  });
});

describe('3.1 真的叫醒员工的话：提问撤回，答复栏逐字，唤醒包里写明是哪一条', () => {
  it('一句普通的话叫醒总管：提问撤回；答复栏是固定句；唤醒包里有那一句', async () => {
    const fix = await jobFix();
    const item = privateQuestion(fix.ctx, fix.chief.id);
    const packet = await chiefHears(fix, '先按我说的做，不用副标题');
    const after = fix.ctx.store.table('inbox').get(item.id)!;
    expect(after.status).toBe('withdrawn');
    expect(after.answer).toBe('已撤回：你已在对话里直接回复');
    expect(STALE_QUESTION_ANSWER).toBe('已撤回：你已在对话里直接回复');
    expect(packet).toContain('中心说明：你更早提的问题「问一句」已撤回，主人在对话里直接回了话，以主人这句话为准，不用再等那个问题的答案。');
  });

  it('两位员工：只撤回被叫醒的那一位的提问（团队线程里点名别人不碰这一位）', async () => {
    const fix = await jobFix();
    const mine = privateQuestion(fix.ctx, fix.chief.id, 'question:i_0000000021');
    const theirs = privateQuestion(fix.ctx, fix.engineer.id, 'question:i_0000000022');
    sendOwnerMessage(fix.ctx, fix.chief.id, '继续');
    expect(fix.ctx.store.table('inbox').get(mine.id)!.status).toBe('withdrawn');
    expect(fix.ctx.store.table('inbox').get(theirs.id)!.status).toBe('open');
  });
});

/** 总管在这一回合提了一个问题；主人点卡片作答；总管被这条回答叫醒（返回这一回合的唤醒包）。 */
async function answeredByCard(fix: Parameters<typeof chiefTurn>[0], answer: string): Promise<string> {
  await speak(fix, bot(fix, fix.chief.id), '请你定一下。', { outcome: 'needs_owner', ownerQuestion: QUESTION });
  const item = fix.ctx.store.table('inbox').list(row => row.type === 'question' && row.status === 'open')[0]!;
  expect(await fix.hub.api.answerInbox(item.id, answer)).toMatchObject({ ok: true });
  return chiefTurn(fix);
}

describe('3.2 提问卡回答的回合：六处共用的判断，各处的结果', () => {
  it('停止一件事被拒绝', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    await speak(fix, fix.chief, '收到。', { outcome: 'progress' });
    await chiefHears(fix, '看一下进度');
    await answeredByCard(fix, '加');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '主人说不做了' });
    expect(result).toEqual({ ok: false, error: STOP_REFUSED_TEXT });
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).not.toBe('stopped');
  });

  it('记住一条记忆被拒绝', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后提示文字都用请字开头');
    await answeredByCard(fix, '加');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toEqual({ ok: false, error: NOTE_NOT_OWN_WORDS_TEXT });
    expect(fix.ctx.store.table('memories').list()).toHaveLength(0);
  });

  it('删掉一条记忆被拒绝', async () => {
    const fix = await jobFix();
    const memory = await writeMemory(fix.ctx, { kind: 'rule', text: '提示都用请字开头', example: '写「请输入」', redLine: false, scope: { staff: 'all', projects: 'all' },
      source: { kind: 'owner_words', messageIds: [], quote: '以后提示都用请字开头', threadId: fix.chief.id } });
    await chiefHears(fix, '看一下');
    await answeredByCard(fix, '加');
    const result = await callTool(fix, fix.chief, 'hub_memory', { mode: 'forget', memoryId: memory.id });
    expect(result).toEqual({ ok: false, error: NOT_OWN_WORDS_TEXT });
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('active');
  });

  it('修改组队卡放行，改后的组队卡仍在等主人确认（P83 带来的行为变化，主会话裁定保留）', async () => {
    const fix = await teamFix();
    // 约定固定之后，总管先问一句，主人点卡片作答；这一回合（提问卡回答叫醒的）里推荐研究员、再按这条回答修改组队卡。
    // （组队卡在等主人确认时总管不能再带提问交账，所以提问放在组队卡之前。）
    const packet = await lockedAndAwake(fix);
    await answeredByCard(fix as never, '加');
    expect(await proposeResearcher(fix, packet)).toMatchObject({ ok: true });
    const proposalId = theProposal(fix.ctx).id;
    const brief = '只查公开资料，每条结论都附出处；查不到就明说。';
    const result = await callTool(fix, fix.chief, 'hub_team_propose', { mode: 'revise', proposalId, brief });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('组队卡已按主人的话更新') });
    // 仍在等主人确认：状态还是待确认，「待你处理」里组队卡那一条仍开着。
    expect(theProposal(fix.ctx).state).toBe('pending');
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith('team:'))).toHaveLength(1);
  });

  it('派活：去重键是那条回答的消息编号，同一条回答只派一次', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    const agreementId = agreementIdIn(packet);
    await speak(fix, fix.chief, '约定已固定，我先问你一句。', { outcome: 'needs_owner', ownerQuestion: QUESTION });
    const item = fix.ctx.store.table('inbox').list(row => row.type === 'question' && row.status === 'open')[0]!;
    expect(await fix.hub.api.answerInbox(item.id, '加')).toMatchObject({ ok: true });
    await chiefTurn(fix);
    const first = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId));
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    const answerMessage = fix.ctx.store.log('thread').all().find(row => row.from === 'owner' && row.refId === item.id)!;
    const assignedEvents = fix.ctx.store.log('jobEvents').all().filter(event => event.kind === 'assigned');
    expect(assignedEvents).toHaveLength(1);
    // 去重键：派活事件里记的来源消息就是那条回答。
    expect(assignedEvents[0]!.data.sourceMessageId).toBe(answerMessage.id);
    // 同一条回答再派一次：被拒绝，仍只有一件事。
    const second = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId));
    expect(second.ok).toBe(false);
    expect(fix.ctx.store.log('jobEvents').all().filter(event => event.kind === 'assigned')).toHaveLength(1);
  });
});
