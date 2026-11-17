/**
 * P75r6 第 8 节：没有测试守着的判断里，复验记录第 5 节第 6 处：没有 mergeBase 的旧合并更新，核对通过时跳过版本比对、照常写入。
 *
 * 背景：P75r5c 给合并类更新记了整理时两条原技能的版本号（mergeBase），核对通过、写入之前比对，不一致就放弃，免得用整理那一刻的句子
 * 整体覆盖整理之后新写进去的句子。升级之前写下的旧合并更新没有这个字段，不能因为缺字段就放弃或出错：跳过比对、照常写入。
 * 对照：有 mergeBase 时同样的变化会让合并放弃（p75r5c-tidy 已测，这里再放一条反例做对照）。
 * 其余六处对应的测试见 docs/progress/P75r6.md 第 8 节。
 */
import { describe, expect, it } from 'vitest';
import { MERGE_STALE_REASON } from '../src/skill/merge-reasons.js';
import { versionsOfSkill } from '../src/skill/files.js';
import { writeSkillVersion } from '../src/skill/store.js';
import {
  MINUTE, bot, callTool, checkSectionOf, commitAndEnd, nextPacket, tick, tidyScene, tidySkillNamesIn, tidySkillRefsIn, tidySrcsOfSkill, updatesIn, type JobFix,
} from './p75r6-fixtures.js';

/** 林舟只用唤醒包里的文字提交合并（两条原技能的出处都用），评审甲拿到核对唤醒包；返回更新编号。 */
async function mergeSubmittedAndCheckerAwake(fix: JobFix, packetOfEngineer: string): Promise<string> {
  const names = tidySkillNamesIn(packetOfEngineer);
  const refs = tidySkillRefsIn(packetOfEngineer);
  const phone = tidySrcsOfSkill(packetOfEngineer, '手机端适配')[0]!;
  const form = tidySrcsOfSkill(packetOfEngineer, '表单页做法')[0]!;
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'tidy', note: '没有发现相互矛盾的条目', merges: [{
    from: refs[names.indexOf('手机端适配')], into: refs[names.indexOf('表单页做法')], reason: '两条都要求手机上不出现横向滚动',
    sentences: [{ text: '手机上不出现横向滚动', sources: [phone] }, { text: '提交后显示明确的成功提示', sources: [form] }] }] });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '整理完成', reply: '整理好了。' });
  const checkPacket = await nextPacket(fix, fix.reviewer.id);
  expect(checkSectionOf(checkPacket)).toContain('一项合并');
  return updatesIn(checkPacket)[0]!.id;
}

/** 整理之后、核对之前，保留的技能写进了一句新句子（版本号变成 2）。 */
async function intoGetsNewVersion(fix: JobFix, formId: string): Promise<void> {
  const sourceId = fix.ctx.store.table('skillVersions').list(row => row.skillId === formId)[0]!.sentences[0]!.sourceIds[0]!;
  await writeSkillVersion(fix.ctx, { botId: fix.engineer.id, skillId: formId, change: 'add', sentences: [
    { text: '提交后显示明确的成功提示', sourceIds: [sourceId] }, { text: '失败时给出下一步', sourceIds: [sourceId] }], updateId: null, checkedBy: null, categories: [] });
  expect(fix.ctx.store.table('skills').get(formId)!.currentVersionNo).toBe(2);
}

describe('8.6 没有 mergeBase 的旧合并更新：核对通过时跳过版本比对，照常写入', () => {
  it('旧更新（没有 mergeBase）：整理之后保留的技能有了新版本，核对通过时不放弃，照常写入合并后的新版本；被并入的技能收起', async () => {
    const { fix, phone, form } = await tidyScene();
    await tick(fix, MINUTE);
    const updateId = await mergeSubmittedAndCheckerAwake(fix, await nextPacket(fix, fix.engineer.id));
    // 模拟升级之前写下的旧更新：去掉 mergeBase。
    const update = fix.ctx.store.table('skillUpdates').get(updateId)!;
    expect(update.mergeBase).toEqual({ fromVersionNo: 1, intoVersionNo: 1 });
    const { mergeBase: _drop, ...legacy } = update;
    fix.ctx.store.table('skillUpdates').put(legacy);
    expect(fix.ctx.store.table('skillUpdates').get(updateId)!.mergeBase).toBeUndefined();
    await intoGetsNewVersion(fix, form);
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId, consistent: 'met', withinScope: 'met' });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true, text: '已写入技能库：「表单页做法」第 3 版。' });
    expect(fix.ctx.store.table('skillUpdates').get(updateId)).toMatchObject({ state: 'passed', versionNo: 3 });
    expect(versionsOfSkill(fix.ctx, form)[0]!).toMatchObject({ no: 3, change: 'merge' });
    expect(fix.ctx.store.table('skills').get(phone)).toMatchObject({ state: 'collapsed', collapseReason: 'merged' });
  });

  it('对照（有 mergeBase）：同样的变化让这条合并放弃，原因逐字，两条技能都不变', async () => {
    const { fix, phone, form } = await tidyScene();
    await tick(fix, MINUTE);
    const updateId = await mergeSubmittedAndCheckerAwake(fix, await nextPacket(fix, fix.engineer.id));
    expect(fix.ctx.store.table('skillUpdates').get(updateId)!.mergeBase).toEqual({ fromVersionNo: 1, intoVersionNo: 1 });
    await intoGetsNewVersion(fix, form);
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId, consistent: 'met', withinScope: 'met' });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('skillUpdates').get(updateId)).toMatchObject({ state: 'abandoned', abandonReason: MERGE_STALE_REASON });
    expect(fix.ctx.store.table('skills').get(form)!.currentVersionNo).toBe(2);
    expect(fix.ctx.store.table('skills').get(phone)!.state).toBe('active');
  });
});
