/**
 * P85 第 3.5 节的测试：被主人否掉的先例不再复活（W10）、字面判断的误判（W11）、「是」确认的归属（W12）。
 *
 * 1. 复活：先例被否掉之后，同一份约定再固定一版，同一个待定项、文字相同的先例不再以生效中写出；
 *    选定项的文字变了之后照常写新的。
 * 2. 字面判断：只有否定词之后 12 个字以内出现完整的选定项文字才判否掉。审查记录的两个例子：
 *    「页面上不要公开我的名字」对「公开接口」不再判否掉；「不要每天都给我发通知，周报就行」对「每天」仍会判否掉，
 *    这是字面判断的限度（记在进度记录里；中心为此在主题里落旁白，让主人看得见）。
 * 3. 旁白：否掉一条先例时，在这件事的主题里落一句中心旁白（逐字）。
 * 4. 确认的归属：往回找「待确认的问句」时遇到总管的任何一条消息就停，以最近一条为准。
 */
import { describe, expect, it } from 'vitest';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { writePrecedents } from '../src/memory/precedents.js';
import { ownerWordsRefute, refutePrecedentsByOwnerWords, refutedPrecedentNote } from '../src/memory/precedent-refute.js';
import { NOTE_NO_TRIGGER_TEXT } from '../src/memory/note.js';
import { postThread } from '../src/outreach/thread.js';
import { UNVERIFIED_CLAIM_NOTE } from '../src/commit/claim-evidence.js';
import { callTool, chiefHears, jobFix, memoriesOf, noteArgs, speak } from './p75c-fixtures.js';
import { bot, chiefTurn, delivered, ownerTypes, reopenInfo, threadOf } from './p74f-fixtures.js';

const SOURCE = '报价从哪里取：公开接口';
const REFRESH = '多久刷新一次：每天';

/** 已交付的一件事，约定固定时写下的两条先例已经落表。 */
async function deliveredWithPrecedents() {
  const { fix, job } = await delivered();
  await flushJobHooks(fix.ctx);
  const precedents = memoriesOf(fix.ctx).filter(row => row.kind === 'precedent' && row.source.agreementId === job.agreementId);
  expect(precedents.map(row => row.text).sort()).toEqual([SOURCE, REFRESH].sort());
  return { fix, job };
}

/** 把已固定的最新一版复制成下一版（固定时间照旧），模拟「同一份约定因任何原因再固定一版」。 */
function lockNextVersion(fix: Awaited<ReturnType<typeof delivered>>['fix'], agreementId: string, patchChosen?: { key: string; chosen: string }): number {
  const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
  const last = agreement.versions.at(-1)!;
  const pending = last.content.pending.map(item => patchChosen !== undefined && item.key === patchChosen.key ? { ...item, chosen: patchChosen.chosen } : item);
  const next = { ...last, no: last.no + 1, lockedAt: fix.ctx.clock.now(), content: { ...last.content, pending } };
  fix.ctx.store.table('agreements').put({ ...agreement, versions: [...agreement.versions, next] });
  return next.no;
}

describe('3.5.1 W10：被否掉的先例不再复活', () => {
  it('否掉之后约定再固定一版：同一待定项、同文字的先例不写（先例表里没有新的生效中的同文字先例）', async () => {
    const { fix, job } = await deliveredWithPrecedents();
    const refuted = await refutePrecedentsByOwnerWords(fix.ctx, job.agreementId, '报价来源不要公开接口，改成手工表格。',
      { threadId: job.topicId, messageIds: [], quote: '报价来源不要公开接口，改成手工表格。' });
    expect(refuted).toHaveLength(1);
    const versionNo = lockNextVersion(fix, job.agreementId);
    const written = await writePrecedents(fix.ctx, job.agreementId, versionNo);
    expect(written).toBe(0);
    const rows = memoriesOf(fix.ctx).filter(row => row.kind === 'precedent' && row.source.agreementId === job.agreementId);
    expect(rows.filter(row => row.text === SOURCE && row.status === 'active')).toHaveLength(0);
    expect(rows.filter(row => row.text === SOURCE).map(row => row.status)).toEqual(['refuted']);
    // 另一条没被否掉的先例照常沿用。
    expect(rows.filter(row => row.text === REFRESH && row.status === 'active')).toHaveLength(1);
  });

  it('选定项的文字变了：照常写新的先例', async () => {
    const { fix, job } = await deliveredWithPrecedents();
    await refutePrecedentsByOwnerWords(fix.ctx, job.agreementId, '报价来源不要公开接口，改成手工表格。',
      { threadId: job.topicId, messageIds: [], quote: '报价来源不要公开接口，改成手工表格。' });
    const versionNo = lockNextVersion(fix, job.agreementId, { key: 'source', chosen: '手工表格' });
    expect(await writePrecedents(fix.ctx, job.agreementId, versionNo)).toBe(1);
    const rows = memoriesOf(fix.ctx).filter(row => row.kind === 'precedent' && row.source.agreementId === job.agreementId);
    expect(rows.filter(row => row.status === 'active' && row.text === '报价从哪里取：手工表格')).toHaveLength(1);
    expect(rows.filter(row => row.text === SOURCE).map(row => row.status)).toEqual(['refuted']);
  });

  it('反例：没被否掉过时，约定再固定一版仍沿用旧先例，不重复写', async () => {
    const { fix, job } = await deliveredWithPrecedents();
    const versionNo = lockNextVersion(fix, job.agreementId);
    expect(await writePrecedents(fix.ctx, job.agreementId, versionNo)).toBe(0);
    const active = memoriesOf(fix.ctx).filter(row => row.kind === 'precedent' && row.source.agreementId === job.agreementId && row.status === 'active');
    expect(active).toHaveLength(2);
  });
});

describe('3.5.2 W11：字面判断只认完整的选定项文字', () => {
  it('审查记录的两个例子：「页面上不要公开我的名字」不再判否掉；「不要每天都给我发通知」仍判否掉（字面判断的限度）', () => {
    expect(ownerWordsRefute('页面上不要公开我的名字。', SOURCE)).toBe(false);
    expect(ownerWordsRefute('不要每天都给我发通知，周报就行。', REFRESH)).toBe(true);
  });

  it('完整选定项要在否定词之后 12 个字以内开始出现；超出不判；整段选定项完整说出才判', () => {
    expect(ownerWordsRefute('报价来源不要公开接口。', SOURCE)).toBe(true);
    // 否定词与选定项之间隔了超过 12 个字：不判。
    expect(ownerWordsRefute('不要这样，页面的标题和颜色都按之前说的做，还有公开接口', SOURCE)).toBe(false);
    // 只说选定项的前半（原来取前两个字会判）：不判。
    expect(ownerWordsRefute('不要公开', SOURCE)).toBe(false);
    // 否定词之前出现完整选定项不算（原样沿用之前的规则：只看否定词之后）。
    expect(ownerWordsRefute('公开接口很好，不要改。', SOURCE)).toBe(false);
  });
});

describe('3.5.3 否掉一条先例时在主题里落旁白', () => {
  it('真实链路：主人验收时否掉先例，主题里落一句中心旁白（逐字）', async () => {
    const { fix, job } = await deliveredWithPrecedents();
    await ownerTypes(fix, job.topicId, '第 1 条不对：报价来源不要公开接口，改成手工表格。');
    const seen = reopenInfo(await chiefTurn(fix));
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reopen', jobId: seen.jobId,
      items: [{ no: seen.nos[0]!, problem: '没有照你的要求做', fixTo: '按你这次说的改' }], missed: '核对时没有对照你这次的要求' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const text = '「报价从哪里取：公开接口」这条先例已按你的话作废，以后对齐时不再引用。';
    expect(refutedPrecedentNote(SOURCE)).toBe(text);
    expect(threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' && row.kind === 'system' && row.text === text)).toHaveLength(1);
    // 另一条先例没被否掉，没有它的旁白。
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text.includes('多久刷新一次'))).toBe(false);
  });
});

describe('3.5.4 W12：「是」只确认总管最近一条消息里的待确认问句', () => {
  const EARLIER = '提示文字里别用感叹号吧。';
  const ASK = '提示文字里没有感叹号了。要我以后都这样吗？';

  it('总管回复问了待确认问句之后，又发了一张提问卡：主人答「是」不算确认更早那一问', async () => {
    const fix = await jobFix();
    await chiefHears(fix, EARLIER);
    await speak(fix, fix.chief, ASK, { outcome: 'progress' });
    // 总管之后又发了一张提问卡（最近一条不是回复）。
    postThread(fix.ctx, { thread: fix.chief.id, from: fix.chief.id, kind: 'question', text: '你要红色还是蓝色？' });
    const packet = await chiefHears(fix, '是。');
    expect(packet).not.toContain('中心判断');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('总管之后又发了一条汇报：同样不算确认更早那一问', async () => {
    const fix = await jobFix();
    await chiefHears(fix, EARLIER);
    await speak(fix, fix.chief, ASK, { outcome: 'progress' });
    postThread(fix.ctx, { thread: fix.chief.id, from: fix.chief.id, kind: 'report', text: '这一轮做完了。' });
    expect(await chiefHears(fix, '是。')).not.toContain('中心判断');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
  });

  it('正例：最近一条就是待确认问句的回复，「是」仍算确认', async () => {
    const fix = await jobFix();
    await chiefHears(fix, EARLIER);
    await speak(fix, fix.chief, ASK, { outcome: 'progress' });
    const packet = await chiefHears(fix, '是。');
    expect(packet).toContain('中心判断');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toMatchObject({ ok: true });
  });

  it('兼容：问句之前的完成声明没有证据、末尾被补了固定的一句，「是」仍算确认那一问', async () => {
    const fix = await jobFix();
    await chiefHears(fix, EARLIER);
    await speak(fix, fix.chief, `已改好：${ASK}`, { outcome: 'progress' });
    // 回复末尾确实多了补的一句。
    const reply = threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.kind === 'reply').at(-1)!;
    expect(reply.text.endsWith(UNVERIFIED_CLAIM_NOTE)).toBe(true);
    const packet = await chiefHears(fix, '是。');
    expect(packet).toContain('中心判断');
    // 唤醒包里引用的那一问不带补的那一句。
    expect(packet).not.toContain('这一回合没有可以核对的结果。」');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toMatchObject({ ok: true });
  });
});
