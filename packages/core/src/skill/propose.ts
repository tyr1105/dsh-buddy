/**
 * `hub_skill` 的 `propose`（P75g 第 7 节）：复盘回合里提交技能更新。
 *
 * 两段式：第一段写 SkillUpdate 行（checking）、参与者改 done、排核对人（或评审员）的下一次唤醒——
 * 任何一步失败都撤销本次写入并返回失败；全部成功之后第二段才落复盘卡、调 maybeFinishRun。
 *
 * 校验一次列全（中文）：回合身份、条数与字数、src 编号、技能名、同一回合只能提交一次。
 * 出处的 src 编号是本次唤醒包里给这位参与者的那几条（对照存在复盘记录的 sourceIds 上，顺序即编号）。
 */
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { presetSkillById } from '../config/preset-skills.js';
import { SkillUpdateSchema, type Skill, type SkillUpdate } from '../model/skill.js';
import { postThread } from '../outreach/thread.js';
import { parseSkillKey } from './keys.js';
import { arrangeNextSteps, maybeFinishRun, proposedInWake, setProposedWake, settleParticipantAfterWork } from './run.js';
import { findSkillChecker } from './checker.js';
import { runTitleOf } from './run-title.js';
import { patchParticipant } from './retro-plan.js';
import { retroCardRefId } from './card.js';
import { validateSentences } from './sentences.js';
import { findSelfSkill } from './skill-ref.js';
import { internalNameRefusal, skillTitleProblem, whenToUseProblem } from './skill-text.js';
import { newId } from '../util/ids.js';

/** 工具入参（平铺；tools/hub-skill.ts 里是 zod 定义，这里是解码后的形状）。 */
export interface ProposeUpdateArg {
  skill?: string;
  title?: string;
  whenToUse?: string;
  supplements?: string;
  sentences: Array<{ text: string; sources: string[] }>;
}

export interface ProposeArgs {
  updates: ProposeUpdateArg[];
  note?: string;
}

/** 只能在中心叫你复盘的回合里用。 */
export const NOT_RETRO_TEXT = '只能在中心叫你复盘的回合里用';

/** 这位员工在用或收起的自己积累技能（按名称找）。 */
function selfSkillByTitle(ctx: HubContext, botId: string, title: string): Skill | null {
  return ctx.store.table('skills').list(row => row.botId === botId && row.title === title)[0] ?? null;
}

/** 这位员工的岗位技能名称（预置与 DSH 技能）。 */
function roleSkillNames(ctx: HubContext, botId: string): string[] {
  const bot = ctx.store.table('bots').get(botId);
  if (bot === null) return [];
  const preset = bot.presetSkillIds.map(id => presetSkillById(id)?.name ?? null).filter((name): name is string => name !== null);
  return [...preset, ...bot.dshSkillNames];
}

/**
 * 提交技能更新。校验失败抛中文错误（一次列全）；写入失败恢复原状并抛出；
 * 成功返回给模型看的一句话。
 */
export async function runPropose(ctx: HubContext, tc: { botId: string; wakeId?: string | null; sessionId: string }, args: ProposeArgs): Promise<string> {
  const bot = ctx.store.table('bots').get(tc.botId);
  if (bot === null) throw new Error('botId：员工不存在');
  // 1：本回合是这位员工的复盘唤醒（不是改写唤醒），参与者状态 running。
  const wake = tc.wakeId != null && tc.wakeId !== '' ? ctx.store.table('wakes').get(tc.wakeId) : null;
  const parsed = parseSkillKey(wake?.subjectKey ?? null);
  // P75i：学习唤醒（learn:）同样提交技能更新，写法与复盘一样；整理唤醒用 tidy，不能用 propose。
  if (wake === null || parsed === null || (parsed.kind !== 'retro' && parsed.kind !== 'learn') || parsed.rewrite || parsed.botId !== bot.id) throw new Error(NOT_RETRO_TEXT);
  const run = ctx.store.table('skillRuns').get(parsed.runId);
  const participant = run?.participants.find(row => row.botId === bot.id);
  if (run === null || participant === undefined) throw new Error(NOT_RETRO_TEXT);
  // 5：同一回合只能提交一次。提交成功之后参与者就是 done（这个回合的唤醒单还是同一张），再调用时说明原因，
  // 不写成「不是复盘回合」让模型误以为自己哪里叫错了身份。
  if (participant.state === 'done') throw new Error('本回合已经提交过了，不能再提交');
  // 参与者一般是 running；评审员的合并唤醒还在进行时，别人改写完又要他再核对，他会被改回 queued（排给他的候选才不会被闸门丢弃），
  // 这时只要他本回合还没有提交过（参与者行上没有记下本回合的提交），仍然可以提交自己的复盘。
  if (participant.state === 'queued' && proposedInWake(ctx, run, bot.id, wake)) throw new Error('本回合已经提交过了，不能再提交');
  if (participant.state !== 'running' && participant.state !== 'queued') throw new Error(NOT_RETRO_TEXT);
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  const title = runTitleOf(ctx, run);

  // P75r6 第 2 节第 5 条（复验 N9）：句子、新建技能的名称与「什么时候用」会写进技能库给主人看、也写进技能文件，
  // 写入之前先查内部名称，查到就拒绝、什么都不写（文字逐字固定，沿用 SKILL_OWNER_VISIBLE_REFUSAL）。
  const visibleTexts = args.updates.flatMap(update => [update.title ?? '', update.whenToUse ?? '', ...update.sentences.map(sentence => sentence.text)]);
  const refusal = internalNameRefusal(visibleTexts);
  if (refusal !== null) throw new Error(refusal);

  // 2–4：逐项校验，一次列全。
  const errors: string[] = [];
  const seenSkills = new Set<string>();
  const prepared: Array<{ arg: ProposeUpdateArg; skillId: string | null; newSkill: { title: string; whenToUse: string; supplements: string | null } | null }> = [];
  if (args.updates.length > D.UPDATES_PER_PROPOSE_MAX) errors.push(`updates：最多 ${D.UPDATES_PER_PROPOSE_MAX} 项`);
  for (const [index, update] of args.updates.entries()) {
    const label = `第 ${index + 1} 项`;
    // 3：句子的条数、src 编号（只能是本次唤醒包给出的、每句至少一个、不能只有验收结果）、字数——与改写（revise）共用
    // skill/sentences.ts 里的同一份校验。条数不合格时这一项的其余校验跳过。
    const checked = validateSentences(ctx, participant.sourceIds, update.sentences, label);
    errors.push(...checked.errors);
    if (!checked.countOk) continue;
    // 4：skill 是在用或收起的自己积累技能名；新建必填 title、whenToUse、不重名；同一 skill 不出现两次；supplements 是岗位技能名。
    if (update.skill !== undefined) {
      // P75r6：skill 写唤醒包里的技能编号（sk1）或名称都认（编号见 skill-ref.ts）；同一条技能的两种写法也算「出现了两次」。
      const skill = findSelfSkill(ctx, bot.id, update.skill);
      if (skill === null) errors.push(`${label}：skill「${update.skill}」不是你已有技能的名字`);
      else if (seenSkills.has(skill.id)) errors.push(`${label}：同一条技能「${update.skill}」出现了两次`);
      if (skill !== null) seenSkills.add(skill.id);
      if (update.title !== undefined || update.whenToUse !== undefined) errors.push(`${label}：给已有技能新增时不用写 title 和 whenToUse`);
      prepared.push({ arg: update, skillId: skill?.id ?? null, newSkill: null });
    } else {
      const t = update.title?.trim() ?? '';
      const w = update.whenToUse?.trim() ?? '';
      if (t === '' || w === '') errors.push(`${label}：新建技能要写 title 和 whenToUse`);
      // P75r6 第 2 节第 4 条：名称只允许中文、英文字母、数字、空格和「-」「·」「、」；「什么时候用」必须单行、不含控制字符；长度上限不变。
      if (t !== '') { const problem = skillTitleProblem(t, label); if (problem !== null) errors.push(problem); }
      if (w !== '') { const problem = whenToUseProblem(w, label); if (problem !== null) errors.push(problem); }
      if (t !== '' && selfSkillByTitle(ctx, bot.id, t) !== null) errors.push(`${label}：已有一条叫「${t}」的技能`);
      if (update.supplements !== undefined && !roleSkillNames(ctx, bot.id).includes(update.supplements)) {
        errors.push(`${label}：supplements「${update.supplements}」不是你的岗位技能名称`);
      }
      prepared.push({ arg: update, skillId: null, newSkill: t === '' || w === '' ? null : { title: t, whenToUse: w, supplements: update.supplements?.trim() ?? null } });
    }
  }
  if (args.note !== undefined && [...args.note.trim()].length > D.NOTE_MAX_CHARS) errors.push(`note：不能超过 ${D.NOTE_MAX_CHARS} 字`);
  if (args.updates.length > 0 && args.note !== undefined && args.note.trim() === '') errors.push('note：没有可写的更新时才写 note，写了就不能是空的');
  if (errors.length > 0) throw new Error(`提交被拒，没有写入任何东西：${errors.join('；')}`);

  // ---- 第一段：写更新（checking）、参与者 done、排下一步；任一步失败恢复原状 ----
  const undoSteps: (() => void)[] = [];
  const written: SkillUpdate[] = [];
  try {
    const now = ctx.clock.now();
    for (const item of prepared) {
      const checkerId = checkerFor(ctx, bot.id, job, run);
      const update = parseInput(SkillUpdateSchema, {
        id: newId('su', ctx.rng), botId: bot.id, runId: run.id, kind: 'learn',
        skillId: item.skillId, newSkill: item.newSkill, mergeFromIds: [],
        sentences: item.arg.sentences.map(sentence => ({
          text: sentence.text.trim(),
          sourceIds: sentence.sources.map(src => participant.sourceIds[Number(/^src(\d+)$/.exec(src)?.[1]) - 1]!),
        })),
        checkerId, state: 'checking', checks: [], rewrites: 0, versionNo: null, createdAt: now, updatedAt: now,
      }, '技能更新');
      ctx.store.table('skillUpdates').put(update);
      undoSteps.push(() => { ctx.store.table('skillUpdates').remove(update.id); });
      written.push(update);
    }
    // 参与者 done（没有更新时原因 no_update）；队列里已有他在这次复盘里的另一条候选（例如别人改写完要他再核对）时记 queued。
    settleParticipantAfterWork(ctx, run.id, bot.id, written.length === 0 ? 'no_update' : null);
    undoSteps.push(() => { patchParticipant(ctx, run.id, bot.id, 'running'); });
    // 记下这位参与者提交所在的唤醒编号（学习与整理没有主题、不落复盘卡，「本回合提交过没有」靠它判断）。
    setProposedWake(ctx, run.id, bot.id, wake.id);
    undoSteps.push(() => { setProposedWake(ctx, run.id, bot.id, participant.proposedWakeId); });
    // 排下一步；失败抛出（连同撤销步骤一起交还）。
    arrangeNextSteps(ctx, run.id, bot.id, written, undoSteps);
  } catch (error) {
    for (const step of [...undoSteps].reverse()) {
      try { step(); } catch (undoError) { ctx.logger.warn('提交技能更新失败后的撤销没有成功', { error: String(undoError) }); }
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  // ---- 第二段：落复盘卡、试一次结束（都只记日志，不影响已成功的第一段） ----
  try {
    const topicJob = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
    if (topicJob !== null) {
      postThread(ctx, { thread: topicJob.topicId, from: bot.id, kind: 'job_card', refId: retroCardRefId(run.id, bot.id), text: `复盘　${bot.name}　${title}` });
    }
  } catch (error) { ctx.logger.warn('复盘卡没有落成', { runId: run.id, error: String(error) }); }
  try { maybeFinishRun(ctx, run.id); } catch (error) { ctx.logger.warn('复盘结束检查失败', { runId: run.id, error: String(error) }); }

  if (written.length === 0) return '已记下：这次没有可写的技能更新。';
  const checkerNames = [...new Set(written.map(row => row.checkerId))]
    .map(id => id === job?.chiefId || ctx.store.table('bots').get(id)?.role === 'chief' ? '总管' : ctx.store.table('bots').get(id)?.name ?? '核对人');
  return `已提交 ${written.length} 条技能更新，等${checkerNames.join('、')}核对。`;
}

/**
 * 核对人（方案 7.3、任务卡第 7 节）：执行者的更新由这件事的评审员核对，没有评审员时由总管核对；
 * 评审员的更新由总管核对（不能自己核对自己）；总管的更新由这件事的评审员核对。
 */
function checkerFor(ctx: HubContext, submitter: string, job: { executorId: string; reviewerId: string | null; chiefId: string } | null, run: { kind: string }): string {
  // P75i：学习的更新由「最近核对过这位员工交回的评审员，没有时总管」核对（skill/checker.ts）。
  if (run.kind === 'learn') {
    const found = findSkillChecker(ctx, submitter);
    if (found === null) throw new Error('这次学习找不到可以核对的同事，没有提交');
    return found;
  }
  if (job === null) throw new Error('这件事的记录找不到了，不能排核对');
  if (submitter === job.executorId) return job.reviewerId ?? job.chiefId;
  if (submitter === job.reviewerId) return job.chiefId;
  // 总管的更新：总管自己复盘时一定有评审员（没有的总管当初就记了 no_checker，不会走到这里）。
  if (job.reviewerId === null) throw new Error('这件事没有评审员，这条更新没有核对人；有想记下的做法，写进 note 说明');
  return job.reviewerId;
}

/** 复盘卡消息的 refId。 */
export { retroCardRefId };
