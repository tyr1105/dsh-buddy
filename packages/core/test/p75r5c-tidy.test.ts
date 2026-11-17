/**
 * P75r5c 的测试一：每周整理的修复（第 1、3、4、5、7.6 节）。
 * - 第 1 节（H1）：整理记录按编号找，不按「这位员工在不在参与者里」找；两人同一周都整理、其中一人是另一人的核对人时，两人各自的整理都能做完。
 * - 第 3 节（M1、M2）：合并只对整理时的那一版有效；合并后的句子要同时带着两条原技能的出处；reason 单行、不含内部名称；核对说明末尾多一句。
 * - 第 4 节（M3、L9）：「来源不明」不再单独成立；「最近用到」取调用时间、当前版本建立时间、放回时间三者里最晚的。
 * - 第 5 节：活动流里整理、合并、技能更新的几句话，逐字对照任务卡。
 * - 第 7 节第 6 条：周一的整理唤醒走「换新会话送出唤醒包」的路径。
 * 每种「在等某人」的情形都让那个人真跑一个回合，只用唤醒包里的文字调用工具；时间用注入的假时钟，推进每次不超过 10 分钟（跨天直接设到目标时刻）。
 */
import { describe, expect, it } from 'vitest';
import { SKILL_DEFAULTS } from '../src/config/defaults.js';
import { SkillRunSchema, SkillSourceSchema, SkillUpdateSchema } from '../src/model/skill.js';
import { SKILL_OWNER_VISIBLE_REFUSAL } from '../src/job/owner-text.js';
import { skillRunOfKey, tidyRunId, tidySubjectKey } from '../src/skill/keys.js';
import { MERGE_ABANDON_REASON, MERGE_NOT_ACTIVE_REASON, MERGE_STALE_REASON } from '../src/skill/merge-reasons.js';
import { versionsOfSkill } from '../src/skill/files.js';
import { setSkillState, writeSkillVersion } from '../src/skill/store.js';
import { MERGE_BOTH_SOURCES_TEXT } from '../src/skill/tidy-submit.js';
import { newId } from '../src/util/ids.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { assignArgs, lockedAndAwake } from './p74b-fixtures.js';
import {
  INTERNAL_NAMES, LAST_WEEK_AT, MINUTE, MONDAY, ageSkill, bot, callTool, commitAndEnd, jobFix, nextPacket, nextPacketViaNewSession, seedPassedUpdate, seedSkill,
  seedUnknownSkill, setLocal, tick, tidyRuns, tidyScene, tidySrcsOfSkill, updatesIn, type JobFix,
} from './p75r5c-fixtures.js';

const DAY = 24 * 60 * MINUTE;
const NOTE = '没有发现相互矛盾的条目';
const REASON = '两条都要求手机上不出现横向滚动';

/** 活动流里全部技能库记录（从新到旧）。 */
function skillRows(fix: JobFix) {
  return fix.hub.api.activity({ limit: 200 } as never).rows.filter(row => row.kind === 'skill');
}

/** 一条整理记录在活动流里那一组（id 为 skill-tidy:<记录编号>）。 */
function tidyGroupOf(fix: JobFix, botId: string, weekOf = MONDAY) {
  return skillRows(fix).find(row => row.id === `skill-tidy:${tidyRunId(weekOf, botId)}`);
}

/** 林舟用整理唤醒包里的技能名和 src 编号提交一项合并；sources 选择：两条原技能的出处都用、只用保留的、只用被并入的。 */
async function engineerMerges(fix: JobFix, packet: string, use: 'both' | 'into' | 'from' = 'both', extra: Record<string, unknown> = {}) {
  const phone = tidySrcsOfSkill(packet, '手机端适配')[0]!;
  const form = tidySrcsOfSkill(packet, '表单页做法')[0]!;
  const first = use === 'into' ? form : phone;
  const second = use === 'from' ? phone : form;
  return callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'tidy', note: NOTE, merges: [{
    from: '手机端适配', into: '表单页做法', reason: REASON,
    sentences: [{ text: '手机上不出现横向滚动', sources: [first] }, { text: '提交后显示明确的成功提示', sources: [second] }],
  }], ...extra });
}

/** 直接写一条整理记录（只用来造活动流要显示的各种状态，不走真实链路）。 */
function putTidyRun(fix: JobFix, botId: string, patch: Record<string, unknown> = {}) {
  const now = fix.ctx.clock.now();
  const state = (patch.state as string | undefined) ?? 'skipped';
  const row = SkillRunSchema.parse({
    id: tidyRunId(MONDAY, botId), kind: 'tidy', jobId: null, category: null,
    participants: [{ botId, role: 'executor', sourceIds: [], state, reason: (patch.reason as string | null | undefined) ?? null }],
    turnsUsed: 0, turnCap: 3, tokens: 0, summaryPostedAt: null, createdAt: now, endedAt: now, weekOf: MONDAY, collapsed: [], merges: [], tidyNote: null, activeAtStart: 0,
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'state' && key !== 'reason')),
  });
  fix.ctx.store.table('skillRuns').put(row);
  return row;
}

describe('1 整理记录按编号找，不按「这位员工在不在记录里」找（H1）', () => {
  it('林舟、评审甲同一周都整理，评审甲是林舟的核对人：两人各自的整理都能做完；评审甲能核对林舟的合并；回合数各记在各自的记录上；活动流里两人各一行、内容与事实相符', async () => {
    const { fix } = await tidyScene();
    // 评审甲：上周有通过的更新，在用两条技能（这样他自己也要整理）。
    const first = await seedSkill(fix, fix.reviewer.id, '核对清单', ['先看约定里的怎样算做完']);
    fix.ctx.clock.advance(1_000);
    await seedSkill(fix, fix.reviewer.id, '核对记录写法', ['每条不符写明改到什么程度算过']);
    seedPassedUpdate(fix, fix.reviewer.id, first, parseLocalDateTime(LAST_WEEK_AT, fix.ctx.settings.timezone));
    await tick(fix, MINUTE);
    const engineerRunId = tidyRunId(MONDAY, fix.engineer.id);
    const reviewerRunId = tidyRunId(MONDAY, fix.reviewer.id);
    const runOf = (id: string) => fix.ctx.store.table('skillRuns').get(id)!;
    // 巡检建好之后：两人各有一条整理记录，都排了整理唤醒；整理的回合上限是 3。
    expect(runOf(engineerRunId)).toMatchObject({ kind: 'tidy', turnCap: 3 });
    expect(runOf(reviewerRunId)).toMatchObject({ kind: 'tidy', turnCap: 3 });
    expect(SKILL_DEFAULTS.TIDY_TURN_CAP).toBe(3);
    expect(runOf(engineerRunId).participants[0]).toMatchObject({ botId: fix.engineer.id, state: expect.stringMatching(/queued|running/) });
    expect(runOf(reviewerRunId).participants[0]).toMatchObject({ botId: fix.reviewer.id, state: expect.stringMatching(/queued|running/) });
    expect(skillRunOfKey(fix.ctx, tidySubjectKey(MONDAY, fix.reviewer.id))?.id).toBe(reviewerRunId);

    // 林舟先整理：提交一项合并，评审甲作为核对人加进林舟的记录。
    const packet = await nextPacket(fix, fix.engineer.id);
    const submitted = await engineerMerges(fix, packet);
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true, text: '已提交 1 项合并，等评审甲核对。' });
    expect(runOf(engineerRunId).participants.find(row => row.botId === fix.reviewer.id)).toMatchObject({ role: 'checker' });
    // 这时评审甲的整理键仍然找到他自己的记录，不是林舟那条（原来取第一条「他在参与者里」的记录，取到的是林舟的）。
    expect(skillRunOfKey(fix.ctx, tidySubjectKey(MONDAY, fix.reviewer.id))?.id).toBe(reviewerRunId);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '整理完成', reply: '整理好了。' });

    // 评审甲有两个回合：自己的整理、核对林舟的合并（先后顺序由调度决定，两种都照唤醒包里的文字做）。
    const seen: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const reviewerPacket = await nextPacket(fix, fix.reviewer.id);
      if (reviewerPacket.includes('## 每周整理：你的技能库')) {
        seen.push('整理');
        const own = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'tidy', note: NOTE, merges: [] });
        expect(own, JSON.stringify(own)).toMatchObject({ ok: true, text: '已记下：这次没有可合并的技能。' });
      } else {
        seen.push('核对');
        const [update] = updatesIn(reviewerPacket);
        const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: update!.id, consistent: 'met', withinScope: 'met' });
        expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true, text: '已写入技能库：「表单页做法」第 2 版。' });
      }
      await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '完成', reply: '好了。' });
    }
    expect([...seen].sort()).toEqual(['整理', '核对']);

    // 回合数各记在各自的记录上：林舟那条（他的整理加评审甲的核对）2 个，评审甲那条（他自己的整理）1 个；两条都结束。
    const engineerRun = runOf(engineerRunId);
    const reviewerRun = runOf(reviewerRunId);
    expect(engineerRun.turnsUsed).toBe(2);
    expect(reviewerRun.turnsUsed).toBe(1);
    expect(engineerRun.endedAt).not.toBeNull();
    expect(reviewerRun.endedAt).not.toBeNull();
    expect(engineerRun.participants.map(row => [row.botId, row.role, row.state])).toEqual([[fix.engineer.id, 'executor', 'done'], [fix.reviewer.id, 'checker', 'done']]);
    expect(reviewerRun.participants.map(row => [row.botId, row.role, row.state])).toEqual([[fix.reviewer.id, 'executor', 'done']]);
    // 林舟的合并通过、评审甲的整理没有合并；没有谁被记成「一直有在办的事」。
    expect(fix.ctx.store.table('skillUpdates').list(row => row.kind === 'merge').map(row => row.state)).toEqual(['passed']);
    expect(tidyRuns(fix, fix.reviewer.id, MONDAY).flatMap(row => row.participants.map(item => item.reason)).every(reason => reason === null)).toBe(true);

    // 活动流：两人各一行，内容与事实相符（评审甲的那一行不含林舟的合并）。
    const groups = skillRows(fix).filter(row => row.id.startsWith('skill-tidy:'));
    expect(groups).toHaveLength(2);
    expect(tidyGroupOf(fix, fix.engineer.id)).toMatchObject({ botId: fix.engineer.id, text: '每周整理　林舟　评审甲核对通过', lines: [
      '林舟自己积累的技能　2 条变为 1 条',
      `合并　「手机端适配」并入「表单页做法」第 2 版。${REASON}；两处出处都保留。`,
      '未改动　没有发现相互矛盾的条目。',
    ] });
    expect(tidyGroupOf(fix, fix.reviewer.id)).toMatchObject({ botId: fix.reviewer.id, text: '每周整理　评审甲', lines: ['未改动　没有发现相互矛盾的条目。'] });
    expect(skillRows(fix).flatMap(row => [row.text, ...(row.lines ?? [])]).filter(text => INTERNAL_NAMES.test(text))).toEqual([]);
  });
});

describe('3.1 合并只对整理时的那一版有效（M1）', () => {
  for (const changed of ['保留的技能', '被并入的技能'] as const) {
    it(`整理之后、核对之前${changed}写进了新句子：核对通过时这条合并放弃，原因逐字，两条技能都不变，新句子还在；活动流写「原技能已有变化」`, async () => {
      const { fix, phone, form } = await tidyScene();
      await tick(fix, MINUTE);
      const packet = await nextPacket(fix, fix.engineer.id);
      expect(await engineerMerges(fix, packet)).toMatchObject({ ok: true });
      // 提交时记下两条原技能的版本号。
      const [update] = fix.ctx.store.table('skillUpdates').list(row => row.kind === 'merge');
      expect(update!.mergeBase).toEqual({ fromVersionNo: 1, intoVersionNo: 1 });
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '整理完成', reply: '整理好了。' });
      // 核对之前，另一次复盘给其中一条技能写进了新句子（第 2 版）。
      const target = changed === '保留的技能' ? form : phone;
      const sourceId = versionsOfSkill(fix.ctx, target)[0]!.sentences[0]!.sourceIds[0]!;
      await writeSkillVersion(fix.ctx, { botId: fix.engineer.id, skillId: target, change: 'add', sentences: [{ text: '必填项旁边标星号', sourceIds: [sourceId] }], updateId: null, checkedBy: null, categories: [] });
      const reviewerPacket = await nextPacket(fix, fix.reviewer.id);
      const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: updatesIn(reviewerPacket)[0]!.id, consistent: 'met', withinScope: 'met' });
      expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true, text: `没有写入技能库，这条更新已放弃：${MERGE_STALE_REASON}` });
      expect(MERGE_STALE_REASON).toBe('整理之后技能有了新版本，这次合并作废');
      await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '核对完了。' });
      // 更新放弃、原因逐字；两条技能都在用、没有合并版本；新句子还在。
      expect(fix.ctx.store.table('skillUpdates').get(update!.id)).toMatchObject({ state: 'abandoned', abandonReason: MERGE_STALE_REASON });
      expect(fix.ctx.store.table('skills').get(form)).toMatchObject({ state: 'active', currentVersionNo: changed === '保留的技能' ? 2 : 1 });
      expect(fix.ctx.store.table('skills').get(phone)).toMatchObject({ state: 'active', currentVersionNo: changed === '被并入的技能' ? 2 : 1 });
      expect(versionsOfSkill(fix.ctx, form).some(row => row.change === 'merge')).toBe(false);
      expect(versionsOfSkill(fix.ctx, target)[0]!.sentences.map(row => row.text)).toContain('必填项旁边标星号');
      expect(tidyGroupOf(fix, fix.engineer.id)!.lines).toContain('合并　「手机端适配」并入「表单页做法」时原技能已有变化，这次合并作废，未改动。');
    });
  }

  it('反例：整理之后两条技能都没有变化，核对通过写入合并版本（照常）', async () => {
    const { fix, form } = await tidyScene();
    await tick(fix, MINUTE);
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(await engineerMerges(fix, packet)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '整理完成', reply: '整理好了。' });
    const reviewerPacket = await nextPacket(fix, fix.reviewer.id);
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: updatesIn(reviewerPacket)[0]!.id, consistent: 'met', withinScope: 'met' });
    expect(checked).toMatchObject({ ok: true, text: '已写入技能库：「表单页做法」第 2 版。' });
    expect(versionsOfSkill(fix.ctx, form)[0]).toMatchObject({ no: 2, change: 'merge' });
  });
});

describe('3.2 合并后的句子要同时带着两条原技能的出处（M2）', () => {
  it('只用保留的技能的出处、只用被并入的技能的出处：各被拒（文字逐字）、什么都不写；两条的出处都用则成功', async () => {
    const { fix } = await tidyScene();
    await tick(fix, MINUTE);
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(MERGE_BOTH_SOURCES_TEXT).toBe('合并后的句子要同时带着两条原技能的出处：被并入的那条技能的内容并到哪一句，就把它的出处写在那一句上。');
    const runBefore = fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))!;
    for (const use of ['into', 'from'] as const) {
      const refused = await engineerMerges(fix, packet, use);
      expect(refused).toMatchObject({ ok: false });
      expect(refused.error).toBe(`提交被拒，没有写入任何东西：第 1 项：${MERGE_BOTH_SOURCES_TEXT}`);
      expect(fix.ctx.store.table('skillUpdates').list(row => row.kind === 'merge')).toHaveLength(0);
      expect(fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))).toEqual(runBefore);
    }
    // 同一回合改成两条的出处都用之后成功。
    expect(await engineerMerges(fix, packet, 'both')).toMatchObject({ ok: true, text: '已提交 1 项合并，等评审甲核对。' });
  });
});

describe('3.3 合并的理由（reason）与 note：单行、不含内部名称', () => {
  it('reason 带换行被拒（点名 reason，什么都不写）；reason、note 带工具名被拒（逐字）；改成白话之后成功', async () => {
    const { fix } = await tidyScene();
    await tick(fix, MINUTE);
    const packet = await nextPacket(fix, fix.engineer.id);
    const runBefore = fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))!;
    const newline = await engineerMerges(fix, packet, 'both', { merges: [{
      from: '手机端适配', into: '表单页做法', reason: '两条重复\n都要求手机上不出现横向滚动',
      sentences: [{ text: '手机上不出现横向滚动', sources: [tidySrcsOfSkill(packet, '手机端适配')[0]!] }, { text: '提交后显示明确的成功提示', sources: [tidySrcsOfSkill(packet, '表单页做法')[0]!] }],
    }] });
    expect(newline).toMatchObject({ ok: false });
    expect(newline.error).toContain('第 1 项：reason 必须是单行文字，不能含换行、制表符等控制字符');
    const toolInReason = await engineerMerges(fix, packet, 'both', { merges: [{
      from: '手机端适配', into: '表单页做法', reason: '都在说 hub_skill 的用法',
      sentences: [{ text: '手机上不出现横向滚动', sources: [tidySrcsOfSkill(packet, '手机端适配')[0]!] }, { text: '提交后显示明确的成功提示', sources: [tidySrcsOfSkill(packet, '表单页做法')[0]!] }],
    }] });
    expect(toolInReason.error).toBe(SKILL_OWNER_VISIBLE_REFUSAL);
    const toolInNote = await engineerMerges(fix, packet, 'both', { note: '第 1 句和 hub_skill 有冲突' });
    expect(toolInNote.error).toBe(SKILL_OWNER_VISIBLE_REFUSAL);
    expect(fix.ctx.store.table('skillUpdates').list(row => row.kind === 'merge')).toHaveLength(0);
    expect(fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))).toEqual(runBefore);
    expect(await engineerMerges(fix, packet)).toMatchObject({ ok: true });
  });
});

describe('4 按规则收起：「来源不明」不再单独成立；「最近用到」取三者里最晚的（M3、L9）', () => {
  it('出处全是来源不明、昨天刚用过的不收起；40 天前建、昨天写进新版本的不收起；主人放回的 30 天内不再收起；来源不明且 31 天没用到的收起、原因是来源不明；29 天的不收起', async () => {
    const { fix } = await tidyScene();
    const now = fix.ctx.clock.now();
    // 1：来源不明、昨天刚用过。
    const usedUnknown = await seedUnknownSkill(fix, fix.engineer.id, '昨天用过的迁移技能');
    ageSkill(fix, usedUnknown, now - 60 * DAY, { lastUsedAt: now - DAY });
    // 2：40 天前建、昨天写进新版本（版本建立时间是昨天，从没被调用过）。
    const rewritten = await seedSkill(fix, fix.engineer.id, '四十天前建的', ['一句']);
    ageSkill(fix, rewritten, now - 40 * DAY);
    const sourceId = versionsOfSkill(fix.ctx, rewritten)[0]!.sentences[0]!.sourceIds[0]!;
    await writeSkillVersion(fix.ctx, { botId: fix.engineer.id, skillId: rewritten, change: 'add', sentences: [{ text: '昨天新写的一句', sourceIds: [sourceId] }], updateId: null, checkedBy: null, categories: [] });
    for (const version of versionsOfSkill(fix.ctx, rewritten).filter(row => row.no === 2)) fix.ctx.store.table('skillVersions').patch(version.id, { createdAt: now - DAY });
    // 3：久未使用、被收起，主人放回（记下放回的时间）。
    const putBack = await seedSkill(fix, fix.engineer.id, '主人放回的', ['一句']);
    ageSkill(fix, putBack, now - 60 * DAY);
    await setSkillState(fix.ctx, putBack, 'collapsed', 'unused');
    expect(await fix.hub.api.restoreSkill({ skillId: putBack })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('skills').get(putBack)).toMatchObject({ state: 'active', restoredAt: now });
    // 4：来源不明、31 天没用到；5：29 天没用到。
    const staleUnknown = await seedUnknownSkill(fix, fix.engineer.id, '三十一天没用的迁移技能');
    ageSkill(fix, staleUnknown, now - 60 * DAY, { lastUsedAt: now - 31 * DAY });
    const day29 = await seedSkill(fix, fix.engineer.id, '二十九天前用过', ['一句']);
    ageSkill(fix, day29, now - 60 * DAY, { lastUsedAt: now - 29 * DAY });
    await tick(fix, MINUTE);
    const stateOf = (id: string) => { const row = fix.ctx.store.table('skills').get(id)!; return [row.state, row.collapseReason]; };
    expect(stateOf(usedUnknown)).toEqual(['active', null]);
    expect(stateOf(rewritten)).toEqual(['active', null]);
    expect(stateOf(putBack)).toEqual(['active', null]);
    expect(stateOf(staleUnknown)).toEqual(['collapsed', 'unknown_source']);
    expect(stateOf(day29)).toEqual(['active', null]);
    expect(tidyRuns(fix, fix.engineer.id, MONDAY)[0]!.collapsed).toEqual([{ skillId: staleUnknown, reason: 'unknown_source', days: 31 }]);
    // 对照：主人放回之后过了 30 天，下一次整理又会把它收起（放回只管 30 天）。
    setLocal(fix, '2026-12-21 03:10');
    await tick(fix, MINUTE);
    expect(stateOf(putBack)).toEqual(['collapsed', 'unused']);
  });
});

describe('5 活动流的文字与事实相符（M4、L5、L6）', () => {
  it('收起：有类别写「下次接到同类的事自动放回」，没有类别写「可以在技能库里放回」；来源不明写多少天没有用到（逐字）', async () => {
    const { fix } = await tidyScene();
    const now = fix.ctx.clock.now();
    const categorised = await seedSkill(fix, fix.chief.id, '表单要点', ['一句']);
    const plain = await seedSkill(fix, fix.chief.id, '无类别的要点', ['一句']);
    fix.ctx.store.table('skills').patch(plain, { categories: [] });
    const unknown = await seedUnknownSkill(fix, fix.chief.id, '迁移来的要点');
    ageSkill(fix, categorised, now - 40 * DAY);
    ageSkill(fix, plain, now - 45 * DAY);
    ageSkill(fix, unknown, now - 50 * DAY);
    await tick(fix, MINUTE);
    // 总管上周没有通过的更新：记 no_change、立即结束，只有收起这一组（按建立时间从旧到新）。
    expect(tidyGroupOf(fix, fix.chief.id)).toMatchObject({ text: '每周整理　老大', lines: [
      '收起　「迁移来的要点」来源不明，50 天内没有用到，移到「不常用」。不删除，可以在技能库里放回。',
      '收起　「无类别的要点」45 天内没有用到，移到「不常用」。不删除，可以在技能库里放回。',
      '收起　「表单要点」40 天内没有用到，移到「不常用」。不删除，下次接到同类的事自动放回。',
    ] });
  });

  it('没有整理成的几种原因分开写：一直有在办的事、当天没有排上整理回合、在用的技能不到 2 条、没有核对人、回合用完；本周技能库没有变化不出行', async () => {
    const fix = await jobFix();
    const rows = (botId: string) => skillRows(fix).filter(row => row.botId === botId).map(row => row.text);
    putTidyRun(fix, fix.engineer.id, { state: 'skipped', reason: 'busy_all_day' });
    expect(rows(fix.engineer.id)).toEqual(['每周整理　林舟　本周未整理：一直有在办的事。']);
    fix.ctx.store.table('skillRuns').put({ ...fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))!, participants: [{ botId: fix.engineer.id, role: 'executor', sourceIds: [], state: 'skipped', reason: 'no_slot' }] });
    expect(rows(fix.engineer.id)).toEqual(['每周整理　林舟　本周未整理：当天没有排上整理回合。']);
    fix.ctx.store.table('skillRuns').put({ ...fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))!, participants: [{ botId: fix.engineer.id, role: 'executor', sourceIds: [], state: 'skipped', reason: 'few_skills' }] });
    expect(rows(fix.engineer.id)).toEqual(['每周整理　林舟　在用的技能不到 2 条，未整理。']);
    fix.ctx.store.table('skillRuns').put({ ...fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))!, participants: [{ botId: fix.engineer.id, role: 'executor', sourceIds: [], state: 'skipped', reason: 'no_checker' }] });
    expect(rows(fix.engineer.id)).toEqual(['每周整理　林舟　本周未做合并：没有可以核对的同事。']);
    fix.ctx.store.table('skillRuns').put({ ...fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))!, participants: [{ botId: fix.engineer.id, role: 'executor', sourceIds: [], state: 'capped', reason: 'skill_cap' }] });
    expect(rows(fix.engineer.id)).toEqual(['每周整理　林舟　本周没有完成整理：整理回合用完。']);
    // 本周技能库没有变化：记录照建（已结束），活动流不出行。
    fix.ctx.store.table('skillRuns').put({ ...fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))!, participants: [{ botId: fix.engineer.id, role: 'executor', sourceIds: [], state: 'skipped', reason: 'no_change' }] });
    expect(fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))).not.toBeNull();
    expect(rows(fix.engineer.id)).toEqual([]);
  });

  it('真实链路：上周有更新但在用只有 1 条的员工写「在用的技能不到 2 条，未整理」；上周没有更新的员工记录照建、活动流不出行', async () => {
    const { fix } = await tidyScene();
    const one = await seedSkill(fix, fix.reviewer.id, '评审要点', ['只看与约定是否一致']);
    seedPassedUpdate(fix, fix.reviewer.id, one, parseLocalDateTime(LAST_WEEK_AT, fix.ctx.settings.timezone));
    await tick(fix, MINUTE);
    // 只看整理那几行（评审甲上周那条通过的更新本来就有一行「技能更新」）。
    const tidyRowsOf = (botId: string) => skillRows(fix).filter(row => row.botId === botId && row.id.startsWith('skill-tidy')).map(row => row.text);
    expect(tidyRowsOf(fix.reviewer.id)).toEqual(['每周整理　评审甲　在用的技能不到 2 条，未整理。']);
    expect(fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.chief.id))).toMatchObject({ endedAt: expect.any(Number) });
    expect(tidyRowsOf(fix.chief.id)).toEqual([]);
  });

  it('合并没有写入的几种原因分开写；通过的合并只在两处出处都在新版本里时才写「两处出处都保留」；「{a} 条变为 {b} 条」a 等于 b 时不出', async () => {
    const fix = await jobFix();
    const form = await seedSkill(fix, fix.engineer.id, '表单页做法', ['提交后显示明确的成功提示']);
    const phone = await seedSkill(fix, fix.engineer.id, '手机端适配', ['手机上不出现横向滚动']);
    const sourceOf = (skillId: string) => versionsOfSkill(fix.ctx, skillId)[0]!.sentences[0]!.sourceIds[0]!;
    const now = fix.ctx.clock.now();
    const merge = (n: number, patch: Record<string, unknown>) => SkillUpdateSchema.parse({
      id: `su_00000000${n}0`, botId: fix.engineer.id, runId: tidyRunId(MONDAY, fix.engineer.id), kind: 'merge', skillId: form, newSkill: null, mergeFromIds: [phone],
      sentences: [{ text: '合并后的句子', sourceIds: [sourceOf(phone), sourceOf(form)] }], checkerId: fix.reviewer.id, state: 'abandoned', checks: [], rewrites: 0, versionNo: null,
      createdAt: now, updatedAt: now, ...patch,
    });
    const updates = [
      merge(1, { abandonReason: MERGE_ABANDON_REASON }), // 未通过核对
      merge(2, { abandonReason: '核对人没有核对' }), // 没有完成核对
      merge(3, { abandonReason: MERGE_STALE_REASON }), // 原技能有了新版本
      merge(4, { abandonReason: MERGE_NOT_ACTIVE_REASON }), // 原技能已不在用
      merge(5, { abandonReason: '这条技能已有 13 句，先在每周整理时合并' }), // 写入失败
    ];
    for (const row of updates) fix.ctx.store.table('skillUpdates').put(row);
    putTidyRun(fix, fix.engineer.id, { state: 'done', activeAtStart: 4, tidyNote: NOTE, merges: updates.map(row => ({ updateId: row.id, reason: '重复' })) });
    const head = '合并　「手机端适配」并入「表单页做法」';
    expect(tidyGroupOf(fix, fix.engineer.id)!.lines).toEqual([
      `${head}未通过核对，未改动。`,
      `${head}没有完成核对，未改动。`,
      `${head}时原技能已有变化，这次合并作废，未改动。`,
      `${head}时原技能已有变化，这次合并作废，未改动。`,
      `${head}写入没有成功，未改动。`,
      '未改动　没有发现相互矛盾的条目。',
    ]);
    // 通过的合并：合并后的句子只带保留的技能的出处时，不写「两处出处都保留」；理由取提交时检查过的 reason。
    const passed = merge(6, { state: 'passed', abandonReason: null, versionNo: 2, sentences: [{ text: '合并后的句子', sourceIds: [sourceOf(form)] }],
      checks: [{ at: now, checkerId: fix.reviewer.id, exists: 'met', consistent: 'met', withinScope: 'met', note: null }] });
    fix.ctx.store.table('skillUpdates').put(passed);
    putTidyRun(fix, fix.engineer.id, { state: 'done', activeAtStart: 4, tidyNote: NOTE, merges: [{ updateId: passed.id, reason: '内容重复。' }] });
    expect(tidyGroupOf(fix, fix.engineer.id)!.lines).toEqual([
      '林舟自己积累的技能　4 条变为 3 条',
      `${head}第 2 版。内容重复。`,
      '未改动　没有发现相互矛盾的条目。',
    ]);
    // 两处出处都用时才写「两处出处都保留」。
    fix.ctx.store.table('skillUpdates').put({ ...passed, sentences: [{ text: '合并后的句子', sourceIds: [sourceOf(phone), sourceOf(form)] }] });
    expect(tidyGroupOf(fix, fix.engineer.id)!.lines![1]).toBe(`${head}第 2 版。内容重复；两处出处都保留。`);
    // a 等于 b（合并都没有通过）时不出「条数」那一行（上面第一组已经断言）。
    expect(skillRows(fix).flatMap(row => [row.text, ...(row.lines ?? [])]).filter(text => INTERNAL_NAMES.test(text))).toEqual([]);
  });

  it('技能更新没有写入：按更新上记的放弃原因写（固定说法）；核对不符写「未通过核对」；写入失败的系统错误原文不带编号，写「写入没有成功」', async () => {
    const fix = await jobFix();
    const form = await seedSkill(fix, fix.engineer.id, '表单页做法', ['提交后显示明确的成功提示']);
    const sourceId = versionsOfSkill(fix.ctx, form)[0]!.sentences[0]!.sourceIds[0]!;
    const now = fix.ctx.clock.now();
    const reasons: Array<[string, string]> = [
      ['核对人没有核对', '核对人没有核对'], ['改写后仍不符', '未通过核对'], ['复盘回合用完', '复盘回合用完'], ['学习回合用完', '学习回合用完'],
      ['等待超过 7 天', '等待超过 7 天'], ['提交人此刻不在岗，没有改写', '提交人此刻不在岗，没有改写'],
      ['出处 ss_abcdefghij 不存在或不属于这位员工，不能写入', '写入没有成功'],
    ];
    reasons.forEach(([reason], index) => {
      fix.ctx.store.table('skillUpdates').put(SkillUpdateSchema.parse({
        id: newId('su', fix.ctx.rng), botId: fix.engineer.id, runId: newId('sr', fix.ctx.rng), kind: 'learn', skillId: form, newSkill: null, mergeFromIds: [],
        sentences: [{ text: `一句${index}`, sourceIds: [sourceId] }], checkerId: fix.reviewer.id, state: 'abandoned', checks: [], rewrites: 0, versionNo: null,
        abandonReason: reason, createdAt: now, updatedAt: now + index,
      }));
    });
    const texts = skillRows(fix).map(row => row.text).sort();
    expect(texts).toEqual(reasons.map(([, shown]) => `技能更新　林舟　「表单页做法」的一条更新没有写入：${shown}。只留在记录里。`).sort());
  });
});

describe('5.3 接到同类的事时自动放回：核对人的同类技能也放回', () => {
  /** 给一位员工放一条类别为「其他」（这份约定的默认类别）或别的类别的收起技能（久未用）。 */
  async function collapsedSkill(fix: JobFix, botId: string, title: string, category: string): Promise<string> {
    const source = SkillSourceSchema.parse({
      id: newId('ss', fix.ctx.rng), botId, kind: 'review', label: '旧事第 1 轮退回第 1 条', quote: '原文', relayed: false, jobId: null, category, refs: {}, createdAt: fix.ctx.clock.now(),
    });
    fix.ctx.store.table('skillSources').put(source);
    await writeSkillVersion(fix.ctx, { botId, change: 'create', newSkill: { title, whenToUse: '做事时用', supplements: null },
      sentences: [{ text: '先看约定再动手', sourceIds: [source.id] }], updateId: null, checkedBy: null, categories: [category] });
    const id = fix.ctx.store.table('skills').list(row => row.botId === botId && row.title === title)[0]!.id;
    await setSkillState(fix.ctx, id, 'collapsed', 'unused');
    return id;
  }

  it('派活：执行者（林舟）与核对人（评审甲）同类（其他）的收起技能放回；类别不同的、不是核对人的（总管）的不放回', async () => {
    const fix = await jobFix();
    const executorSkill = await collapsedSkill(fix, fix.engineer.id, '林舟的同类技能', '其他');
    const reviewerSkill = await collapsedSkill(fix, fix.reviewer.id, '评审甲的同类技能', '其他');
    const reviewerOther = await collapsedSkill(fix, fix.reviewer.id, '评审甲的别类技能', '表单页');
    const chiefSkill = await collapsedSkill(fix, fix.chief.id, '总管的同类技能', '其他');
    await lockedAndAwake(fix);
    const agreementId = fix.ctx.store.table('agreements').list()[0]!.id;
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId))).toMatchObject({ ok: true });
    const stateOf = (id: string) => fix.ctx.store.table('skills').get(id)!.state;
    expect(stateOf(executorSkill)).toBe('active');
    expect(stateOf(reviewerSkill)).toBe('active');
    expect(stateOf(reviewerOther)).toBe('collapsed');
    expect(stateOf(chiefSkill)).toBe('collapsed');
  });

  it('改派：换了执行者之后，核对人（评审甲）同类的收起技能也放回', async () => {
    const fix = await jobFix(['小周']);
    await lockedAndAwake(fix);
    const agreementId = fix.ctx.store.table('agreements').list()[0]!.id;
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId))).toMatchObject({ ok: true });
    const job = fix.ctx.store.table('jobs').list()[0]!;
    // 派活之后才收起，改派前它是收起的；改派到小周之后评审甲仍是核对人，他的同类技能放回。
    const reviewerSkill = await collapsedSkill(fix, fix.reviewer.id, '评审甲的同类技能', '其他');
    expect(fix.ctx.store.table('skills').get(reviewerSkill)!.state).toBe('collapsed');
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('skills').get(reviewerSkill)!.state).toBe('active');
  });
});

describe('7.6 周一的整理唤醒走「换新会话送出唤醒包」的路径', () => {
  it('员工的会话早已超过最长存活时间（真实情形：整理在周一凌晨）：唤醒包随新会话送出，里面有每周整理那一段；整理能做完，核对人也照样核对完', async () => {
    const { fix } = await tidyScene();
    // 夹具的 setLocal 把每位员工的会话开始时间改成「现在」，所以以前的整理测试从来没有走过这条路径；这里改回「会话早已过期」。
    const old = fix.ctx.clock.now() - fix.ctx.settings.sessionMaxAgeMs - 1;
    for (const who of [fix.engineer, fix.reviewer]) fix.ctx.store.table('bots').patch(who.id, { sessionStartedAt: old });
    const sessionBefore = bot(fix, fix.engineer.id).sessionId;
    await tick(fix, MINUTE);
    const packet = await nextPacketViaNewSession(fix, fix.engineer.id);
    expect(bot(fix, fix.engineer.id).sessionId, '应该换了新会话').not.toBe(sessionBefore);
    expect(packet).toContain('这是你的新工作会话');
    expect(packet).toContain('## 每周整理：你的技能库');
    // 整理能做完：只用新会话唤醒包里的文字提交合并。
    expect(await engineerMerges(fix, packet)).toMatchObject({ ok: true, text: '已提交 1 项合并，等评审甲核对。' });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '整理完成', reply: '整理好了。' });
    // 核对人的会话同样早已过期：核对唤醒也随新会话送出，核对段在里面。
    const reviewerPacket = await nextPacketViaNewSession(fix, fix.reviewer.id);
    expect(reviewerPacket).toContain('## 本轮核对技能更新：');
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: updatesIn(reviewerPacket)[0]!.id, consistent: 'met', withinScope: 'met' });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true, text: '已写入技能库：「表单页做法」第 2 版。' });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '核对完了。' });
    const run = fix.ctx.store.table('skillRuns').get(tidyRunId(MONDAY, fix.engineer.id))!;
    expect(run.endedAt).not.toBeNull();
    expect(run.participants.map(row => row.state)).toEqual(['done', 'done']);
  });
});
