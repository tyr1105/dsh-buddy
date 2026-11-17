/**
 * P74r16b 第 3 节的测试：修订约定的几处。
 *
 * 3.1 「暂停，等你确认」的清单和「已继续做暂停的 k 处」里的 k 都不包含「一句话」这一项；
 * 3.2 给总管的三句提示写在提交约定的工具的参数说明里（逐字）；
 * 3.3 新版本固定时，主题的标题跟着约定的标题改（主人自己改过主题标题的不动）。
 * 全部走真实的 Hub，时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildPause, pausedCount, touchedItems } from '../src/job/pause.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { AgreementSubmitInputSchema } from '../src/project/agreement-content.js';
import { contentFixture } from './p72a-agreement-fixtures.js';
import { agreementIdIn, lockedAndAwake, teamFix } from './p73d-fixtures.js';
import { callTool, ownerSays, speak } from './p74b-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { bot, lastPacket, started, theJob, threadOf } from './p74d-fixtures.js';

describe('3.1 暂停清单不列「一句话」', () => {
  it('纯函数：只改了一句话：清单为空，k 为 0；一句话加「这次做」一条：清单只有「这次做」那一条，k 为 1', () => {
    const locked = contentFixture();
    const onlySummary = contentFixture();
    onlySummary.summary = '做一个能查看每日报价、并且带提醒的小页面';
    expect(touchedItems(locked, onlySummary)).toEqual([]);
    const empty = buildPause(2, locked, onlySummary, { continuing: ['报价列表页'], paused: [], fallback: undefined });
    expect(empty.paused).toEqual([]);
    expect(pausedCount(empty)).toBe(0);
    // 一句话加「这次做」一条。
    const both = contentFixture();
    both.summary = '做一个能查看每日报价、并且带提醒的小页面';
    both.scopeIn = ['报价列表页', '手动刷新', '价格提醒'];
    const pause = buildPause(2, locked, both, { continuing: ['报价列表页'], paused: [], fallback: undefined });
    expect(pause.paused).toEqual(['这次做第 3 条：价格提醒']);
    expect(pausedCount(pause)).toBe(1);
  });

  it('反例：「照常在做」写了一句话里的内容仍被拒（一句话只是不进清单，冲突检查照旧）', () => {
    const locked = contentFixture();
    const next = contentFixture();
    next.summary = '做一个能查看每日报价、并且带提醒的小页面';
    expect(() => buildPause(2, locked, next, { continuing: ['做一个能查看每日报价、并且带提醒的小页面'], paused: [], fallback: undefined }))
      .toThrow(/涉及这次改动的一句话/);
  });

  /** 林舟在做；主人发来一句话，总管被叫醒；返回总管唤醒包里的约定编号。 */
  async function ownerConflicts() {
    const { fix, job, info } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, '文案里写的是自动刷新，和约定里的手动刷新不一样');
    return { fix, job, info, agreementId: agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id))) };
  }

  it('走真实工具：改了一句话和「这次做」一条：清单只有「这次做」那一条，确认之后落的话里 k 为 1', async () => {
    const { fix, job, agreementId } = await ownerConflicts();
    const line = '这次做第 2 条：手动刷新，并每小时自动刷新';
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId, changeNote: '每小时自动刷新一次',
      summary: '做一个能查看每日报价、每小时自动刷新的小页面', scopeIn: ['报价列表页', '手动刷新，并每小时自动刷新'],
      continuing: ['报价列表页'], paused: [line], fallback: '如果只是文案说法，回复「不变」，我保留第 1 版。' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const pause = theJob(fix).pause!;
    expect(pause.paused).toEqual([line]);
    expect(pause.paused.some(item => item.startsWith('一句话'))).toBe(false);
    // 一句话的改动仍然在这一版的「本版改动」里看得到。
    expect(fix.ctx.store.table('agreements').get(agreementId)!.versions[1]!.changes.some(mark => mark.section === 'summary')).toBe(true);
    // 确认之后主题里落的话：暂停的处数是 1。
    await speak(fix, bot(fix, fix.chief.id), '这和已定的第 1 版冲突：自动刷新还没定。其余照常在做。', { outcome: 'needs_owner' });
    fix.ctx.clock.advance(1_000);
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const sentence = '约定第 2 版已按你的确认固定：每小时自动刷新一次。林舟已继续做暂停的 1 处（见约定卡），交付时间不变。';
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text === sentence)).toBe(true);
  });

  it('走真实工具：只改了一句话：清单里没有「一句话」，只有总管自己写的暂停部分', async () => {
    const { fix, agreementId } = await ownerConflicts();
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId, changeNote: '改了一句话',
      summary: '做一个能查看每日报价、每小时自动刷新的小页面',
      continuing: ['报价列表页'], paused: ['刷新相关的部分'], fallback: '如果只是文案说法，回复「不变」，我保留第 1 版。' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).pause!.paused).toEqual(['刷新相关的部分']);
  });
});

describe('3.2 给总管的三句提示在工具的参数说明里', () => {
  const properties = (z.toJSONSchema(AgreementSubmitInputSchema) as { properties: Record<string, { description?: string }> }).properties;

  it('mode 的说明含 revise 时没有变的条目逐字照抄的那一段（逐字）', () => {
    expect(properties.mode!.description).toContain('没有变的条目逐字照抄上一版：改了字的条目，中心都会列为「暂停，等你确认」，执行者会停下这一条。草图和标题里与这次改动有关的内容一并改。');
  });

  it('title 的说明含标题只写这件事是什么的那一句（逐字）', () => {
    expect(properties.title!.description).toContain('标题只写这件事是什么，不写人数、日期这类以后可能改的内容。');
  });
});

describe('3.3 主题的标题跟着约定的标题改', () => {
  /** 约定「活动报名页（限 80 人）」已由主人确认固定，总管这一回合收尾；返回约定编号和主题编号。 */
  async function lockedAgreement() {
    const fix = await teamFix();
    const title = '活动报名页（限 80 人）';
    const agreementId = agreementIdIn(await lockedAndAwake(fix, title), title);
    await speak(fix, fix.chief, '收到。', { outcome: 'progress' });
    return { fix, agreementId, topicId: fix.ctx.store.table('agreements').get(agreementId)!.topicId };
  }

  /** 主人说了一句，总管出新版本（第 2 版）并交账，主人确认。extra 可带新标题。 */
  async function reviseAndConfirm(fix: Awaited<ReturnType<typeof teamFix>>, agreementId: string, extra: Record<string, unknown>) {
    await ownerSays(fix, fix.chief.id, '人数改成不限');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId, changeNote: '人数改成不限',
      summary: '做一个活动报名页，不限人数', ...extra });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await speak(fix, fix.ctx.store.table('bots').get(fix.chief.id)!, '改成不限人数。', { outcome: 'needs_owner' });
    fix.ctx.clock.advance(1_000);
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
  }

  const noteTexts = (fix: Awaited<ReturnType<typeof teamFix>>, topicId: string) => threadOf(fix.ctx, topicId).filter(row => row.text.startsWith('主题的标题已随约定'));

  it('标题变了、主人没改过主题标题：主题标题改成新标题，主题里落一句（中心说的，工作往来一类）', async () => {
    const { fix, agreementId, topicId } = await lockedAgreement();
    expect(fix.ctx.store.table('projectTopics').get(topicId)!.title).toBe('活动报名页（限 80 人）');
    await reviseAndConfirm(fix, agreementId, { title: '活动报名页' });
    expect(fix.ctx.store.table('agreements').get(agreementId)!.title).toBe('活动报名页');
    expect(fix.ctx.store.table('projectTopics').get(topicId)!.title).toBe('活动报名页');
    const notes = noteTexts(fix, topicId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: '主题的标题已随约定第 2 版改为「活动报名页」。', from: 'hub', kind: 'work' });
  });

  it('标题没变（修订时没写标题）：主题标题不动，不落话', async () => {
    const { fix, agreementId, topicId } = await lockedAgreement();
    await reviseAndConfirm(fix, agreementId, {});
    expect(fix.ctx.store.table('agreements').get(agreementId)!.title).toBe('活动报名页（限 80 人）');
    expect(fix.ctx.store.table('projectTopics').get(topicId)!.title).toBe('活动报名页（限 80 人）');
    expect(noteTexts(fix, topicId)).toHaveLength(0);
  });

  it('标题写了但和原来相同：同样不动，不落话', async () => {
    const { fix, agreementId, topicId } = await lockedAgreement();
    await reviseAndConfirm(fix, agreementId, { title: '活动报名页（限 80 人）' });
    expect(fix.ctx.store.table('projectTopics').get(topicId)!.title).toBe('活动报名页（限 80 人）');
    expect(noteTexts(fix, topicId)).toHaveLength(0);
  });

  it('主人自己改过主题标题：不动，不落话', async () => {
    const { fix, agreementId, topicId } = await lockedAgreement();
    fix.ctx.store.table('projectTopics').patch(topicId, { title: '报名页（主人起的名字）' });
    await reviseAndConfirm(fix, agreementId, { title: '活动报名页' });
    expect(fix.ctx.store.table('projectTopics').get(topicId)!.title).toBe('报名页（主人起的名字）');
    expect(noteTexts(fix, topicId)).toHaveLength(0);
  });
});
