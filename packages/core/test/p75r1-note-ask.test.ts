/**
 * P75r1 第 4 节的测试：总管追问「要我以后都这样吗」之后，只有肯定的回答才把更早那句话算作出处；
 * 并入出处的每一条主人消息都要是主人亲口打的字、且在同一个对话里。
 *
 * 对应审查记录 M1（否定回答也能记）、第 4 节两处「去掉判断没有测试失败」（isEarlierOwnWords、row.thread === main.thread）
 * 和疑点一（证据里并入的其他主人消息没有过「亲口打字」这一道）。全部走真实的 Hub。
 */
import { describe, expect, it } from 'vitest';
import { NOTE_NO_TRIGGER_TEXT } from '../src/memory/note.js';
import { postThread } from '../src/outreach/thread.js';
import { newId } from '../src/util/ids.js';
import { openTopic } from './p63-topic-fixtures.js';
import { callTool, chiefHears, jobFix, memoriesOf, noteArgs, ownerSays, speak, type JobFix } from './p75c-fixtures.js';

const ASK = '已改好：把按钮改成红色，其他不变。要我以后都这样吗？';
const EARLIER = '这个页面的按钮都改成红色';

/** 主人说一句、总管回复以追问句结尾，主人再回一句；返回 note 的结果（参数固定）。 */
async function askThenAnswer(fix: JobFix, answer: string) {
  await chiefHears(fix, EARLIER);
  await speak(fix, fix.chief, ASK, { outcome: 'progress' });
  await chiefHears(fix, answer);
  return callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '按钮都用红色', example: '确定按钮用红色' }));
}

describe('只有肯定的回答才把更早那句话并入出处', () => {
  it('主人回「不用，就这一次」：note 被拒，没有写入', async () => {
    const fix = await jobFix();
    const result = await askThenAnswer(fix, '不用，就这一次');
    expect(result).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('主人回「是」「对，以后都这样」：成功，出处原文里有更早那句', async () => {
    for (const answer of ['是', '对，以后都这样', '好的。', ' 嗯嗯 ']) {
      const fix = await jobFix();
      const result = await askThenAnswer(fix, answer);
      expect(result, `${answer}：${JSON.stringify(result)}`).toMatchObject({ ok: true });
      const [memory] = memoriesOf(fix.ctx);
      expect(memory!.source.quote, answer).toContain(EARLIER);
      expect(memory!.source.messageIds).toHaveLength(2);
    }
  });

  it('补充的肯定回答「可以的」「没问题」「OK」「Ok」：成功，出处原文里有更早那句（规范化统一小写）', async () => {
    for (const answer of ['可以的', '没问题', 'OK', 'Ok', 'ok。']) {
      const fix = await jobFix();
      const result = await askThenAnswer(fix, answer);
      expect(result, `${answer}：${JSON.stringify(result)}`).toMatchObject({ ok: true });
      expect(memoriesOf(fix.ctx)[0]!.source.quote, answer).toContain(EARLIER);
    }
  });

  it('不在名单里的回答（「再说吧」「不要」「没必要，就这一次」）一律不并入；比较是整句相等，不是包含', async () => {
    for (const answer of ['再说吧', '不要', '没必要，就这一次']) {
      const fix = await jobFix();
      expect(await askThenAnswer(fix, answer), answer).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
      expect(memoriesOf(fix.ctx)).toHaveLength(0);
    }
  });
});

describe('并入出处的主人消息都要是主人亲口打的字、且在同一个对话里', () => {
  it('更早那句是中心代主人落的话（选办法落的那一句）：不并入，note 被拒', async () => {
    const fix = await jobFix();
    // 中心代主人落的话：带记录编号（与真实的选办法、点按钮一致）。它含「以后」「都」，若被并入就会满足触发词。
    postThread(fix.ctx, { thread: fix.chief.id, from: 'owner', kind: 'chat', text: '选 B：以后都用红色', refId: newId('tsu', fix.ctx.rng) });
    postThread(fix.ctx, { thread: fix.chief.id, from: fix.chief.id, kind: 'reply', text: ASK });
    await chiefHears(fix, '是');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '按钮都用红色', example: '确定按钮用红色' }));
    expect(result).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('证据里另一个对话的主人消息不并入', async () => {
    const fix = await jobFix();
    const topicId = await openTopic(fix, '帮我整理一下登录页的文案');
    await speak(fix, fix.chief, '收到，我来看。', { outcome: 'progress' });
    await ownerSays(fix, topicId, '以后登录页的提示都用红色');
    await speak(fix, fix.chief, '收到。', { outcome: 'progress' });
    const other = fix.ctx.store.log('thread').all().filter(row => row.thread === topicId && row.from === 'owner').at(-1)!;
    // 主人在总管私聊里说了一句没有触发词的话；把另一个对话里那句主人消息塞进这一回合的证据。
    await chiefHears(fix, '随便聊聊');
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { reason: { ...wake.reason, evidence: [...wake.reason.evidence, other.id] } });
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('证据里同一对话中由中心代主人落的话不并入（审查记录疑点一）', async () => {
    const fix = await jobFix();
    const behalf = postThread(fix.ctx, { thread: fix.chief.id, from: 'owner', kind: 'chat', text: '选 A：以后都这样', refId: newId('tsu', fix.ctx.rng) });
    await chiefHears(fix, '随便聊聊');
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { reason: { ...wake.reason, evidence: [...wake.reason.evidence, behalf.id] } });
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });
});
