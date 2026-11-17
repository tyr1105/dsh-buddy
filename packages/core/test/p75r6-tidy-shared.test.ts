/**
 * P75r6 第 3 节：合并不能借共用的出处丢内容（复验 N3）。
 *
 * 复验发现：两条原技能引用同一条出处时，合并后只留一条技能的句子也能通过中心的校验，活动流还写「两处出处都保留」。
 * 现在：每一侧只算它独有的出处；独有的出处不为空时合并后的句子必须用到其中至少一个；出处有重合、一侧没有独有出处时
 * 中心不拒绝，但在更新上记标记、核对段多一句请核对人逐句对照；活动流只有两侧都有独有出处并且都用到时才写「两处出处都保留」。
 * 每种「在等某人」的情形都让那个人真跑一个回合，只用唤醒包里的文字（技能编号、出处编号、更新编号）调用工具。
 */
import { describe, expect, it } from 'vitest';
import { SkillSourceSchema } from '../src/model/skill.js';
import { tidyRunId } from '../src/skill/keys.js';
import { MERGE_BOTH_SOURCES_TEXT } from '../src/skill/tidy-submit.js';
import { newId } from '../src/util/ids.js';
import { MERGE_SHARED_SOURCES_NOTE } from '../src/wake/skill-check-section.js';
import {
  MINUTE, MONDAY, bot, callTool, checkSectionOf, commitAndEnd, nextPacket, tick, tidyScene, tidySectionOf, tidySkillNamesIn, tidySkillRefsIn, updatesIn, type JobFix,
} from './p75r6-fixtures.js';

const REASON = '两条都在说手机端的做法';

/** 活动流里这位员工本周整理那一组的全部文字。 */
function tidyTextOf(fix: JobFix, botId: string): string {
  const rows = fix.hub.api.activity({ limit: 200 } as never).rows.filter(row => row.kind === 'skill');
  const group = rows.find(row => row.id === `skill-tidy:${tidyRunId(MONDAY, botId)}`);
  expect(group, '活动流里应该有这位员工本周整理的那一组').toBeDefined();
  return JSON.stringify([group!.text, ...(group!.lines ?? [])]);
}

/** 这次整理提交的合并更新（场景里还有一条上周通过的普通更新，不能取列表第一条）。 */
function mergeUpdateOf(fix: JobFix) {
  const rows = fix.ctx.store.table('skillUpdates').list(row => row.kind === 'merge');
  expect(rows, '应该恰好有一条合并更新').toHaveLength(1);
  return rows[0]!;
}

/** 放一条评审意见出处（给这位员工），返回编号。 */
function seedSource(fix: JobFix, botId: string, label: string): string {
  const source = SkillSourceSchema.parse({ id: newId('ss', fix.ctx.rng), botId, kind: 'review', label, quote: `${label}的原文`,
    relayed: false, jobId: null, category: '表单页', refs: {}, createdAt: fix.ctx.clock.now() });
  fix.ctx.store.table('skillSources').put(source);
  return source.id;
}

/** 把一条技能当前版本的句子换成指定的（文字与出处编号）。必须在整理记录建立（巡检）之前做：整理唤醒包里的出处编号在建立时记下。 */
function setSentences(fix: JobFix, skillId: string, rows: Array<{ text: string; sourceIds: string[] }>): void {
  const skill = fix.ctx.store.table('skills').get(skillId)!;
  const version = fix.ctx.store.table('skillVersions').list(row => row.skillId === skillId && row.no === skill.currentVersionNo)[0]!;
  fix.ctx.store.table('skillVersions').patch(version.id, { sentences: rows.map(row => ({ ...row, addedInNo: 1 })) } as never);
}

/**
 * 整理的场景：林舟的两条技能「手机端适配」（被并入）与「表单页做法」（保留）的出处按 plan 设置，之后巡检、林舟拿到整理唤醒包。
 * 返回夹具、唤醒包、各出处的编号（唤醒包里 src 几对应哪一条出处，用 srcOf 取）。
 */
async function sharedScene(plan: { from: Array<{ text: string; src: 'shared' | 'fromOnly' | 'intoOnly' }>; into: Array<{ text: string; src: 'shared' | 'fromOnly' | 'intoOnly' }> }) {
  const made = await tidyScene();
  const { fix } = made;
  const ids = {
    shared: seedSource(fix, fix.engineer.id, '共用的评审意见'),
    fromOnly: seedSource(fix, fix.engineer.id, '手机端独有的评审意见'),
    intoOnly: seedSource(fix, fix.engineer.id, '表单页独有的评审意见'),
  };
  setSentences(fix, made.phone, plan.from.map(row => ({ text: row.text, sourceIds: [ids[row.src]] })));
  setSentences(fix, made.form, plan.into.map(row => ({ text: row.text, sourceIds: [ids[row.src]] })));
  await tick(fix, MINUTE);
  const packet = await nextPacket(fix, fix.engineer.id);
  // 只靠唤醒包里的文字：出处表「src{k} 种类｜标签」，按标签找编号（没有被这两条技能用到的出处不在表里，这一项为空）。
  const srcByLabel = (label: string): string | undefined => new RegExp(`^(src\\d+) \\S+｜${label}$`, 'm').exec(tidySectionOf(packet))?.[1];
  const srcOf = { shared: srcByLabel('共用的评审意见'), fromOnly: srcByLabel('手机端独有的评审意见'), intoOnly: srcByLabel('表单页独有的评审意见') } as Record<string, string>;
  return { ...made, packet, srcOf };
}

/** 林舟只用唤醒包里的文字（技能编号、出处编号）提交一项合并。 */
function mergeCall(fix: JobFix, packet: string, sentences: Array<{ text: string; sources: string[] }>) {
  const names = tidySkillNamesIn(packet);
  const refs = tidySkillRefsIn(packet);
  return callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'tidy', note: '没有发现相互矛盾的条目', merges: [{
    from: refs[names.indexOf('手机端适配')], into: refs[names.indexOf('表单页做法')], reason: REASON, sentences }] });
}

describe('3.1 每一侧只算它独有的出处', () => {
  it('两条技能共用一条出处、被并入的那条另有独有出处而合并后没有用到：被拒（文字逐字）、什么都不写', async () => {
    const { fix, packet, srcOf } = await sharedScene({
      from: [{ text: '手机上不出现横向滚动', src: 'shared' }, { text: '手机上按钮不小于 44 像素', src: 'fromOnly' }],
      into: [{ text: '提交后显示明确的成功提示', src: 'shared' }],
    });
    const before = fix.ctx.store.table('skillUpdates').count();
    // 合并后只留保留技能的那一句、出处是共用的那条：被并入技能独有的出处一个都没有用到。
    const refused = await mergeCall(fix, packet, [{ text: '提交后显示明确的成功提示', sources: [srcOf.shared!] }]);
    expect(refused).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).toContain(MERGE_BOTH_SOURCES_TEXT);
    expect(MERGE_BOTH_SOURCES_TEXT).toBe('合并后的句子要同时带着两条原技能的出处：被并入的那条技能的内容并到哪一句，就把它的出处写在那一句上。');
    expect(fix.ctx.store.table('skillUpdates').count()).toBe(before);
    // 改正之后（被并入的独有出处也用上）成功；保留的一侧没有独有出处，所以出处有重合，更新上记标记。
    const ok = await mergeCall(fix, packet, [
      { text: '提交后显示明确的成功提示', sources: [srcOf.shared!] }, { text: '手机上按钮不小于 44 像素', sources: [srcOf.fromOnly!] }]);
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(mergeUpdateOf(fix)).toMatchObject({ kind: 'merge', sharedSources: true });
  });

  it('保留的那条另有独有出处而合并后没有用到：同样被拒（保留的一侧同理）', async () => {
    const { fix, packet, srcOf } = await sharedScene({
      from: [{ text: '手机上不出现横向滚动', src: 'shared' }],
      into: [{ text: '提交后显示明确的成功提示', src: 'shared' }, { text: '失败时给出下一步', src: 'intoOnly' }],
    });
    const refused = await mergeCall(fix, packet, [{ text: '手机上不出现横向滚动', sources: [srcOf.shared!] }]);
    expect(JSON.stringify(refused)).toContain(MERGE_BOTH_SOURCES_TEXT);
  });
});

describe('3.2 出处有重合、一侧没有独有出处：中心不拒绝，记标记，核对段多一句，活动流不写「两处出处都保留」', () => {
  it('两条技能的出处完全相同：接受；核对段有那一句（逐字）；通过之后活动流没有「两处出处都保留」', async () => {
    const { fix, packet, srcOf } = await sharedScene({
      from: [{ text: '手机上不出现横向滚动', src: 'shared' }],
      into: [{ text: '提交后显示明确的成功提示', src: 'shared' }],
    });
    const result = await mergeCall(fix, packet, [{ text: '提交后显示明确的成功提示', sources: [srcOf.shared!] }]);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, text: '已提交 1 项合并，等评审甲核对。' });
    expect(mergeUpdateOf(fix)).toMatchObject({ kind: 'merge', sharedSources: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '整理完成', reply: '整理好了。' });
    // 核对人拿到核对唤醒：这条合并的块里多一句（逐字），两条原技能的名称在围栏内。
    const checkPacket = await nextPacket(fix, fix.reviewer.id);
    const section = checkSectionOf(checkPacket);
    expect(MERGE_SHARED_SOURCES_NOTE).toBe('这两条技能的出处有重合，中心无法按出处判断内容是否都保留：请逐句对照被并入的那条技能，每一句都要能在合并后的句子里找到对应，找不到的判不符。');
    expect(section).toContain(MERGE_SHARED_SOURCES_NOTE);
    expect(section).toContain('<<<untrusted\n被并入的技能名称：手机端适配\n保留的技能名称：表单页做法\nuntrusted>>>');
    expect(section.replace(/<<<untrusted\n[\s\S]*?\nuntrusted>>>/g, '〔围栏〕')).not.toContain('手机端适配');
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: updatesIn(checkPacket)[0]!.id, consistent: 'met', withinScope: 'met' });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '核对完了。' });
    // 活动流：合并行写通过的版本和理由，没有「两处出处都保留」这半句（其余文字不变）。
    const text = tidyTextOf(fix, fix.engineer.id);
    expect(text).toContain(`合并　「手机端适配」并入「表单页做法」第 2 版。${REASON}。`);
    expect(text).not.toContain('两处出处都保留');
  });

  it('保留的技能出处是被并入的技能出处的子集（保留的一侧没有独有出处）：同样接受并记标记', async () => {
    const { fix, packet, srcOf } = await sharedScene({
      from: [{ text: '手机上不出现横向滚动', src: 'shared' }, { text: '手机上按钮不小于 44 像素', src: 'fromOnly' }],
      into: [{ text: '提交后显示明确的成功提示', src: 'shared' }],
    });
    const result = await mergeCall(fix, packet, [
      { text: '手机上不出现横向滚动', sources: [srcOf.shared!] }, { text: '手机上按钮不小于 44 像素', sources: [srcOf.fromOnly!] }, { text: '提交后显示明确的成功提示', sources: [srcOf.shared!] }]);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(mergeUpdateOf(fix)).toMatchObject({ sharedSources: true });
  });
});

describe('3.3 两侧都有独有出处并且都用到：活动流有「两处出处都保留」；没有标记、核对段没有那一句', () => {
  it('共用一条、各自另有独有出处，合并后两侧独有的都用到：接受、不记标记；核对段没有那一句；活动流有这半句', async () => {
    const { fix, packet, srcOf } = await sharedScene({
      from: [{ text: '手机上不出现横向滚动', src: 'shared' }, { text: '手机上按钮不小于 44 像素', src: 'fromOnly' }],
      into: [{ text: '提交后显示明确的成功提示', src: 'shared' }, { text: '失败时给出下一步', src: 'intoOnly' }],
    });
    const result = await mergeCall(fix, packet, [
      { text: '手机上按钮不小于 44 像素', sources: [srcOf.fromOnly!] }, { text: '失败时给出下一步', sources: [srcOf.intoOnly!] }, { text: '提交后显示明确的成功提示', sources: [srcOf.shared!] }]);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(mergeUpdateOf(fix)).toMatchObject({ kind: 'merge' });
    expect(mergeUpdateOf(fix).sharedSources).toBeUndefined();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '整理完成', reply: '整理好了。' });
    const checkPacket = await nextPacket(fix, fix.reviewer.id);
    expect(checkSectionOf(checkPacket)).not.toContain(MERGE_SHARED_SOURCES_NOTE);
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: updatesIn(checkPacket)[0]!.id, consistent: 'met', withinScope: 'met' });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '核对完了。' });
    expect(tidyTextOf(fix, fix.engineer.id)).toContain(`合并　「手机端适配」并入「表单页做法」第 2 版。${REASON}；两处出处都保留。`);
  });

  it('反例：出处互不相同（没有共用）时照旧：两侧各用到一条才通过，只用一侧被拒', async () => {
    const { fix, packet, srcOf } = await sharedScene({
      from: [{ text: '手机上不出现横向滚动', src: 'fromOnly' }],
      into: [{ text: '提交后显示明确的成功提示', src: 'intoOnly' }],
    });
    expect(JSON.stringify(await mergeCall(fix, packet, [{ text: '提交后显示明确的成功提示', sources: [srcOf.intoOnly!] }]))).toContain(MERGE_BOTH_SOURCES_TEXT);
    expect(JSON.stringify(await mergeCall(fix, packet, [{ text: '手机上不出现横向滚动', sources: [srcOf.fromOnly!] }]))).toContain(MERGE_BOTH_SOURCES_TEXT);
    const ok = await mergeCall(fix, packet, [{ text: '手机上不出现横向滚动', sources: [srcOf.fromOnly!] }, { text: '提交后显示明确的成功提示', sources: [srcOf.intoOnly!] }]);
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(mergeUpdateOf(fix)).toMatchObject({ kind: 'merge' });
    expect(mergeUpdateOf(fix).sharedSources).toBeUndefined();
  });
});
