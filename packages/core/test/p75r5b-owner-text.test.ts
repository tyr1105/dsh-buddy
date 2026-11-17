/**
 * P75r5b 的测试四：模型写的话给主人看之前检查内部名称（审查 M5）。
 * check 的 note、tidy 的 note、技能类回合交账的 reply 会以核对卡、活动流、工作往来给主人看；
 * 写入之前用 internalNameIn 检查（补了出处编号 src 加数字、更新编号、updateId 三种写法），查到就拒绝这次调用，文字逐字固定；
 * 改成白话之后同一回合可以成功。核对段、改写段、整理段的调用写法里各有一句 note 的写法提醒。
 * 每种「在等某人」的情形都让那个人真跑一个回合，只用唤醒包里的文字调用工具。
 */
import { describe, expect, it } from 'vitest';
import { SKILL_NOTE_HINT, SKILL_OWNER_VISIBLE_REFUSAL, internalNameIn } from '../src/job/owner-text.js';
import { CHECK_SECTION_HOW } from '../src/wake/skill-check-section.js';
import { TIDY_SECTION_HOW } from '../src/wake/skill-tidy-section.js';
import { commitAs } from './p74c-fixtures.js';
import {
  MONDAY, afterExecutorProposes, bot, callTool, checkSectionOf, commitAndEnd, flow, nextPacket, retroRun, retroTurn, reviewerRejects, rewriteSectionOf, tick, tidyRuns, tidyScene,
  tidySectionOf, updatesIn, updatesOf,
} from './p75i-fixtures.js';

/** 文字（给模型看，逐字）。 */
const REFUSAL = '这句话主人会看到，不能出现工具名和内部编号。用「第几句」指句子，用技能的名字指技能，改成白话再提交。';
const HINT = 'note 里用「第几句」指句子，不写编号和工具名。';

describe('6.1 内部名称检查补上三种写法', () => {
  it('internalNameIn：出处编号（src 加数字）、更新编号（su_ 加字母数字）、updateId 这个词都查得到；普通的话与相近的词查不到', () => {
    expect(internalNameIn('第 2 句引用的 src2 没有说断开接口')).toBe('src2');
    expect(internalNameIn('更新 su_abcdefghij 超出了范围')).toBe('su_abcdefghij');
    expect(internalNameIn('把 updateId 改一下')).toBe('updateId');
    expect(internalNameIn('用 hub_skill 改写时删掉这一句')).toBe('hub_skill');
    // 反例：普通说法、带 src 但后面不是数字、更长的单词里含 src。
    expect(internalNameIn('第 2 句超出了出处的范围，删去后半句就能写入')).toBeNull();
    expect(internalNameIn('图片放在 src 目录下')).toBeNull();
    expect(internalNameIn('源码在 resources 里')).toBeNull();
    expect(internalNameIn('第 3 句')).toBeNull();
    expect(REFUSAL).toBe(SKILL_OWNER_VISIBLE_REFUSAL);
    expect(HINT).toBe(SKILL_NOTE_HINT);
  });
});

describe('6.1 check 的 note', () => {
  it('note 带出处编号、带工具名、带 updateId、带更新编号：各被拒，文字逐字，什么都不写；改成白话之后同一回合通过', async () => {
    const { fix } = await afterExecutorProposes();
    const packet = await nextPacket(fix, fix.reviewer.id);
    const updateId = updatesIn(packet)[0]!.id;
    const before = fix.ctx.store.table('skillUpdates').get(updateId)!;
    const call = (note: string) => callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId, consistent: 'met', withinScope: 'unmet', note });
    for (const note of ['第 2 句引用的 src2 没有说断开接口，删掉就能写入。', '用 hub_skill 改写时删掉这一句就能写入。', '把 updateId 对应的那句删掉就能写入。', `更新 ${updateId} 的第 2 句超出了范围，删掉就能写入。`]) {
      const refused = await call(note);
      expect(refused, note).toMatchObject({ ok: false });
      expect(refused.error, note).toBe(REFUSAL);
      expect(fix.ctx.store.table('skillUpdates').get(updateId), note).toEqual(before);
    }
    // 改成白话：用「第几句」指句子，通过校验，更新退回改写（核对不符）。
    const ok = await call('第 2 句超出了出处的范围，删去「断开接口试一遍」就能写入。');
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true, text: '已退回林舟改写一次。' });
    expect(fix.ctx.store.table('skillUpdates').get(updateId)).toMatchObject({ state: 'rewrite' });
    expect(updatesOf(fix)[0]!.checks.at(-1)!.note).toBe('第 2 句超出了出处的范围，删去「断开接口试一遍」就能写入。');
  });

  it('核对段、改写段、整理段的调用写法末尾各有一句 note 的写法提醒（逐字）', async () => {
    const { fix } = await afterExecutorProposes();
    const packet = await nextPacket(fix, fix.reviewer.id);
    expect(checkSectionOf(packet).trimEnd().endsWith(HINT)).toBe(true);
    expect(CHECK_SECTION_HOW.endsWith(HINT)).toBe(true);
    await reviewerRejects(fix);
    const rewrite = rewriteSectionOf(await nextPacket(fix, fix.engineer.id));
    expect(rewrite).toContain(`只能改写一次，再不符就放弃。${HINT}`);
    expect(TIDY_SECTION_HOW.endsWith(HINT)).toBe(true);
    const { fix: tidyFix } = await tidyScene();
    await tick(tidyFix, 60_000);
    const tidyPacket = await nextPacket(tidyFix, tidyFix.engineer.id);
    expect(tidySectionOf(tidyPacket).trimEnd().endsWith(HINT)).toBe(true);
  });
});

describe('6.1 tidy 的 note 与 reason', () => {
  it('note、reason 带编号或工具名被拒（文字逐字、什么都不写）；改成白话之后同一回合成功', async () => {
    const { fix } = await tidyScene();
    await tick(fix, 60_000);
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(tidySectionOf(packet)).toContain('## 每周整理：你的技能库');
    const run = () => tidyRuns(fix, fix.engineer.id, MONDAY)[0]!;
    const before = run();
    const call = (args: Record<string, unknown>) => callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'tidy', merges: [], note: '没有发现相互矛盾的条目', ...args });
    const badNote = await call({ note: '第 1 句和 src2 有冲突' });
    expect(badNote).toMatchObject({ ok: false });
    expect(badNote.error).toBe(REFUSAL);
    expect(run()).toEqual(before);
    const badReason = await call({ merges: [{ from: '手机端适配', into: '表单页做法', reason: '都在说 hub_skill 的用法', sentences: [{ text: '手机上不出现横向滚动', sources: ['src1'] }] }] });
    expect(badReason.error).toBe(REFUSAL);
    expect(run()).toEqual(before);
    expect(await call({})).toMatchObject({ ok: true });
  });
});

describe('6.1 技能类回合交账的 reply', () => {
  it('复盘回合的 reply 带工具名被拒（文字逐字，交账没有保存）；改成白话之后可以再交账', async () => {
    const { fix, job } = await flow({ rejectFirst: true });
    await retroTurn(fix, fix.engineer.id);
    const commitsBefore = fix.ctx.store.table('commits').count();
    const refused = await commitAs(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '我用 hub_skill 提交了一条技能更新。' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe(REFUSAL);
    expect(fix.ctx.store.table('commits').count()).toBe(commitsBefore);
    expect(retroRun(fix, job.id)!.participants[0]).toMatchObject({ state: 'running' });
    // 带出处编号也被拒。
    expect((await commitAs(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '按 src1 写了一条。' })).error).toBe(REFUSAL);
    // 白话之后通过，reply 以工作往来落进主题。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '这次没有可写的做法。' });
    expect(fix.ctx.store.log('thread').all().some(row => row.thread === job.topicId && row.text === '这次没有可写的做法。')).toBe(true);
  });

  it('反例：不是技能类回合的交账，reply 里写工具名不受这条限制（本卡只管技能类回合）', async () => {
    const { fix } = await flow();
    // 评审员此刻没有技能类回合；用一个普通回合：让总管拿到回合（主人发话叫醒）。
    const { ownerSays } = await import('./p72b-fixtures.js');
    await ownerSays(fix, fix.chief.id, '你好');
    const { chiefTurn } = await import('./p74f-fixtures.js');
    await chiefTurn(fix);
    const result = await commitAs(fix, fix.chief.id, { outcome: 'progress', summary: '回答了', reply: '我可以用 hub_skill 之类的工具。' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});
