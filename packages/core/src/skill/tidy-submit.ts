/**
 * `hub_skill` 的 `tidy`（P75i 第 5.4 节）：每周整理回合里，员工提交「合并重复」的结果。
 *
 * 校验（一次列全，中文）：
 * - 本回合是这位员工的整理唤醒，且他还没有提交过；
 * - 每项的 from、into 是这位员工在用的自己积累技能、互不相同；同一条技能在所有项里只出现一次；
 * - 合并后的句子数不超过 SENTENCES_MAX，技能文件不超过 4 KB（当场拒绝并说明哪一项超了，不等核对通过、写入时才失败）；
 * - 每句至少一个出处，出处只能是 from 与 into 当前版本句子里已有的出处（合并不凭空新增出处）。
 *
 * 结果：每项一条 SkillUpdate（kind 为 merge），核对人按 skill/checker.ts 找；记下 merges 与整理说明；参与者记 done；
 * 有合并就排核对人的核对唤醒，没有就结束这条记录。两段式：先校验、再写表（失败恢复原状）、最后才排唤醒。
 * 整理不发任何通知、不落私聊，只进活动流（从记录表生成）。
 */
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { SkillUpdateSchema, type SkillUpdate } from '../model/skill.js';
import { newId } from '../util/ids.js';
import { SKILL_OWNER_VISIBLE_REFUSAL, internalNameIn } from '../job/owner-text.js';
import { findSkillChecker } from './checker.js';
import { renderSelfSkillFile } from './files.js';
import { findSelfSkill } from './skill-ref.js';
import { parseSkillKey, skillRunOfKey } from './keys.js';
import { arrangeNextSteps, maybeFinishRun, proposedInWake, setProposedWake, settleParticipantAfterWork } from './run.js';
import { patchParticipant } from './retro-plan.js';
import { srcIndex } from './sentences.js';
import { tidySkillsOf, tidySourceOrder } from './tidy-sources.js';

/** 一项合并：被并入的技能名、保留的技能名、理由、合并后 into 的全部句子。 */
export interface TidyMergeArg {
  from: string;
  into: string;
  reason: string;
  sentences: Array<{ text: string; sources: string[] }>;
}

export interface TidyArgs { merges: TidyMergeArg[]; note: string }

/** 只能在中心叫你整理技能库的回合里用。 */
export const NOT_TIDY_TEXT = '只能在中心叫你整理技能库的回合里用';

/** 合并后的句子没有同时用到两条原技能的出处时的拒绝文字（给模型看，逐字，P75r5c 第 3 节第 2 条）。 */
export const MERGE_BOTH_SOURCES_TEXT = '合并后的句子要同时带着两条原技能的出处：被并入的那条技能的内容并到哪一句，就把它的出处写在那一句上。';

/** 控制字符（含换行、制表符、行分隔符）。 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

/** 提交整理结果。校验失败抛中文错误（什么都不写）；写入失败恢复原状并抛出；成功返回给模型看的一句话。 */
export async function runTidy(ctx: HubContext, tc: { botId: string; wakeId?: string | null; sessionId: string }, args: TidyArgs): Promise<string> {
  const bot = ctx.store.table('bots').get(tc.botId);
  if (bot === null) throw new Error('botId：员工不存在');
  // 1：本回合是这位员工的整理唤醒，且还没有提交过。
  const wake = tc.wakeId != null && tc.wakeId !== '' ? ctx.store.table('wakes').get(tc.wakeId) : null;
  const parsed = parseSkillKey(wake?.subjectKey ?? null);
  if (wake === null || parsed === null || parsed.kind !== 'tidy' || parsed.botId !== bot.id) throw new Error(NOT_TIDY_TEXT);
  const run = skillRunOfKey(ctx, wake.subjectKey ?? null);
  const participant = run?.participants.find(row => row.botId === bot.id && row.role !== 'checker');
  if (run === null || participant === undefined) throw new Error(NOT_TIDY_TEXT);
  if (participant.state === 'done') throw new Error('本回合已经提交过了，不能再提交');
  if (participant.state === 'queued' && proposedInWake(ctx, run, bot.id, wake)) throw new Error('本回合已经提交过了，不能再提交');
  if (participant.state !== 'running' && participant.state !== 'queued') throw new Error(NOT_TIDY_TEXT);

  // P75r5b（审查 M5）：note、每项的 reason 会出现在活动流里给主人看，写入之前查内部名称，查到就拒绝、什么都不写（文字逐字固定）。
  // P75r6 第 2 节第 5 条（复验 N9）：合并后的句子会写进技能库给主人看，同样先查内部名称。
  if (internalNameIn(args.note) !== null || args.merges.some(merge => internalNameIn(merge.reason) !== null
    || merge.sentences.some(sentence => internalNameIn(sentence.text) !== null))) throw new Error(SKILL_OWNER_VISIBLE_REFUSAL);

  // 2：逐项校验，一次列全。
  const errors: string[] = [];
  const skills = tidySkillsOf(ctx, bot.id);
  const order = tidySourceOrder(ctx, run, bot.id);
  const note = args.note.trim();
  if (note === '' || [...note].length > D.NOTE_MAX_CHARS) errors.push(`note：1 到 ${D.NOTE_MAX_CHARS} 字`);
  if (args.merges.length > D.TIDY_MERGES_MAX) errors.push(`merges：最多 ${D.TIDY_MERGES_MAX} 项`);
  const used = new Map<string, number>(); // 技能编号 → 出现在第几项（0 起）
  const prepared: Array<{ arg: TidyMergeArg; fromId: string; intoId: string; sentences: Array<{ text: string; sourceIds: string[] }>;
    base: { fromVersionNo: number; intoVersionNo: number }; sharedSources: boolean }> = [];
  for (const [index, merge] of args.merges.entries()) {
    const label = `第 ${index + 1} 项`;
    // P75r6：from、into 写唤醒包里的技能编号（sk1）或名称都认（编号见 skill-ref.ts）；认出来之后还要是在用的技能。
    const fromSkill = findSelfSkill(ctx, bot.id, merge.from);
    const intoSkill = findSelfSkill(ctx, bot.id, merge.into);
    const from = fromSkill === null ? undefined : skills.find(row => row.skill.id === fromSkill.id);
    const into = intoSkill === null ? undefined : skills.find(row => row.skill.id === intoSkill.id);
    if (from === undefined) errors.push(`${label}：from「${merge.from}」不是你在用的技能的名字`);
    if (into === undefined) errors.push(`${label}：into「${merge.into}」不是你在用的技能的名字`);
    if (from !== undefined && into !== undefined && from.skill.id === into.skill.id) errors.push(`${label}：from 和 into 不能是同一条技能`);
    for (const found of [from, into]) {
      if (found === undefined) continue;
      const earlier = used.get(found.skill.id);
      if (earlier !== undefined && earlier !== index) errors.push(`${label}：技能「${found.skill.title}」已经出现在第 ${earlier + 1} 项里，同一条技能只能出现在一项里`);
      else used.set(found.skill.id, index);
    }
    const reason = merge.reason.trim();
    if (reason === '' || [...reason].length > 60) errors.push(`${label}：reason 1 到 60 字`);
    // P75r5c（审查 M2）：reason 同样要单行、不含控制字符（内部名称已在前面统一检查）：它会原样出现在活动流里给主人看。
    else if (CONTROL_CHARS.test(reason)) errors.push(`${label}：reason 必须是单行文字，不能含换行、制表符等控制字符`);
    // 句子：条数、字数、出处。
    if (merge.sentences.length < 1 || merge.sentences.length > D.SENTENCES_MAX) {
      errors.push(`${label}：合并后的句子要 1 到 ${D.SENTENCES_MAX} 句，现在有 ${merge.sentences.length} 句`);
      continue;
    }
    // 出处只能是 from 与 into 当前版本句子里已有的（合并后的每一句只能用两条原技能里已有的出处）。
    const allowed = new Set([...(from?.version.sentences ?? []), ...(into?.version.sentences ?? [])].flatMap(row => row.sourceIds));
    // P75r5c（M2）：合并后的句子要同时用到两条原技能的出处，分别记下两条原技能各自的出处。
    const fromSources = new Set((from?.version.sentences ?? []).flatMap(row => row.sourceIds));
    const intoSources = new Set((into?.version.sentences ?? []).flatMap(row => row.sourceIds));
    const errorsBefore = errors.length;
    const sentences: Array<{ text: string; sourceIds: string[] }> = [];
    merge.sentences.forEach((sentence, sentenceIndex) => {
      const where = `${label}第 ${sentenceIndex + 1} 句`;
      const text = sentence.text.trim();
      const chars = [...text].length;
      if (chars < 1 || chars > D.SENTENCE_MAX_CHARS) errors.push(`${where}：每句 1 到 ${D.SENTENCE_MAX_CHARS} 字`);
      else if (CONTROL_CHARS.test(text)) errors.push(`${where}：必须是单行文字，不能含换行、制表符等控制字符`);
      const ids: string[] = [];
      for (const src of sentence.sources) {
        const at = srcIndex(src, order.length);
        const id = at === null ? null : order[at]!;
        if (id === null) errors.push(`${where}：出处「${src}」不是唤醒包里列出的编号`);
        else if (!allowed.has(id)) errors.push(`${where}：出处「${src}」不在「${merge.from}」与「${merge.into}」已有的出处里，合并不能凭空新增出处`);
        else if (!ids.includes(id)) ids.push(id);
      }
      if (sentence.sources.length === 0) errors.push(`${where}：至少写一个出处`);
      sentences.push({ text, sourceIds: ids });
    });
    // P75r6 第 3 节（复验 N3）：每一侧只算它独有的出处（被并入的有、保留的没有的；保留的有、被并入的没有的）。
    // 一侧独有的出处不为空时，合并后的句子必须用到其中至少一个；两条技能共用一条出处时，共用的那条不能顶替任何一侧
    // （原来两侧共用一条出处就能同时满足两项，借合并就能丢掉被并入技能的全部内容）。
    // 只有这一项自己没有别的错误时才查，免得重复报。
    let sharedSources = false;
    if (from !== undefined && into !== undefined && errors.length === errorsBefore) {
      const used = sentences.flatMap(row => row.sourceIds);
      const fromOnly = [...fromSources].filter(id => !intoSources.has(id));
      const intoOnly = [...intoSources].filter(id => !fromSources.has(id));
      if ((fromOnly.length > 0 && !used.some(id => fromOnly.includes(id))) || (intoOnly.length > 0 && !used.some(id => intoOnly.includes(id)))) {
        errors.push(`${label}：${MERGE_BOTH_SOURCES_TEXT}`);
      }
      // 出处有重合、而且其中一侧没有独有的出处：中心不拒绝，但无法按出处判断内容是否都保留，记标记，核对段请核对人逐句对照。
      sharedSources = [...fromSources].some(id => intoSources.has(id)) && (fromOnly.length === 0 || intoOnly.length === 0);
    }
    // 技能文件不超过 4 KB：按合并后的句子渲染，渲染不下（有句子被省略）就当场拒绝。
    if (into !== undefined && merge.sentences.length <= D.SENTENCES_MAX && sentences.every(row => row.sourceIds.length > 0)) {
      const rendered = renderSelfSkillFile(into.skill, { ...into.version, no: into.skill.currentVersionNo + 1,
        sentences: sentences.map(row => ({ text: row.text, sourceIds: row.sourceIds, addedInNo: into.skill.currentVersionNo + 1 })) });
      if (/（另有 \d+ 句未列出）/.test(rendered)) errors.push(`${label}：合并后「${merge.into}」的技能文件超过 ${D.SKILL_FILE_MAX_BYTES / 1024} KB，请精简合并后的句子`);
    }
    if (from !== undefined && into !== undefined && from.skill.id !== into.skill.id) {
      prepared.push({ arg: merge, fromId: from.skill.id, intoId: into.skill.id, sentences,
        base: { fromVersionNo: from.skill.currentVersionNo, intoVersionNo: into.skill.currentVersionNo }, sharedSources });
    }
  }
  if (errors.length > 0) throw new Error(`提交被拒，没有写入任何东西：${errors.join('；')}`);
  // 核对人（有合并才需要）。
  const checkerId = prepared.length === 0 ? null : findSkillChecker(ctx, bot.id);
  if (prepared.length > 0 && checkerId === null) throw new Error('提交被拒，没有写入任何东西：这次整理找不到可以核对的同事');

  // ---- 第一段：写更新（checking）、整理说明、参与者 done、排核对人；任一步失败恢复原状 ----
  const undoSteps: (() => void)[] = [];
  const written: SkillUpdate[] = [];
  const runBefore = run;
  try {
    const now = ctx.clock.now();
    for (const item of prepared) {
      const update = parseInput(SkillUpdateSchema, {
        id: newId('su', ctx.rng), botId: bot.id, runId: run.id, kind: 'merge',
        skillId: item.intoId, newSkill: null, mergeFromIds: [item.fromId], sentences: item.sentences,
        checkerId: checkerId!, state: 'checking', checks: [], rewrites: 0, versionNo: null, createdAt: now, updatedAt: now,
        // P75r5c（M1）：记下整理时两条原技能的版本号，核对通过、写入之前比对。
        mergeBase: item.base,
        // P75r6（N3）：两条原技能的出处有重合、一侧没有独有出处时记标记，核对段多写一句请核对人逐句对照。
        ...(item.sharedSources ? { sharedSources: true } : {}),
      }, '技能更新');
      ctx.store.table('skillUpdates').put(update);
      undoSteps.push(() => { ctx.store.table('skillUpdates').remove(update.id); });
      written.push(update);
    }
    // 记下每项合并的理由与整理说明（说明里的控制字符各换成一个空格，活动流只取第一句）。
    const current = ctx.store.table('skillRuns').get(run.id)!;
    ctx.store.table('skillRuns').put({
      ...current,
      merges: written.map((update, index) => ({ updateId: update.id, reason: prepared[index]!.arg.reason.trim() })),
      tidyNote: note.replace(new RegExp(CONTROL_CHARS.source, 'g'), ' '),
    });
    undoSteps.push(() => { ctx.store.table('skillRuns').put(runBefore); });
    settleParticipantAfterWork(ctx, run.id, bot.id);
    setProposedWake(ctx, run.id, bot.id, wake.id);
    // 有合并：排核对人的核对唤醒（核对人加进参与者名单）；撤销步骤交回调用方，失败时整体恢复。
    if (written.length > 0) arrangeNextSteps(ctx, run.id, bot.id, written, undoSteps);
  } catch (error) {
    for (const step of [...undoSteps].reverse()) {
      try { step(); } catch (undoError) { ctx.logger.warn('提交整理失败后的撤销没有成功', { error: String(undoError) }); }
    }
    patchParticipant(ctx, run.id, bot.id, participant.state, participant.reason);
    throw error instanceof Error ? error : new Error(String(error));
  }

  // ---- 第二段：试一次结束（只记日志，不影响已成功的第一段）----
  try { maybeFinishRun(ctx, run.id); } catch (error) { ctx.logger.warn('整理结束检查失败', { runId: run.id, error: String(error) }); }
  if (written.length === 0) return '已记下：这次没有可合并的技能。';
  const checker = ctx.store.table('bots').get(checkerId!);
  return `已提交 ${written.length} 项合并，等${checker?.role === 'chief' ? '总管' : checker?.name ?? '核对人'}核对。`;
}
