/**
 * 「教它技能」改为对话（P75i 第 4 节，方案 7.6）：主人对总管说「让某位员工学一下我在 DSH 里某段会话的做法」，
 * 总管调用 hub_skill 的 teach；中心列出最近的会话请主人选一段；主人选定后员工读会话摘要、提交技能更新、核对人核对、写入；
 * 结束时总管私聊里落一句结果。
 *
 * 本文件是学习的前半段：
 * - runTeach：校验、读最近会话、建学习记录（skillRuns，kind 为 learn）、建「待你处理」的提问（P2，无默认、不到期）；
 * - chooseLearnSession：主人选了一段（两个入口：总管私聊里提问卡的按钮 = UiApi 命令 chooseLearnSession；「待你处理」= answerInbox
 *   的分流），读会话摘要、抄成出处、给员工排学习唤醒；
 * - answerLearnInbox：answerInbox 的分流函数（选项之一走 chooseLearnSession；自己写了一句别的话则结束这次学习并交给总管）。
 *
 * 后半段（提交、核对、改写、结束）复用 P75g、P75h 的流程，见 propose.ts、check.ts、run.ts。
 *
 * 两段式：校验与读宿主（可能失败）在前，写表在后；写表中途失败恢复原状。给主人的打扰只有两处：
 * 这条「待你处理」和学习结束时总管私聊里的一句；中间不单推、不落别的消息。
 */
import { z } from 'zod';
import { MEMORY_DEFAULTS as MD, SKILL_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { currentWake, requireChief } from '../job/manage-common.js';
import { ownerTextProblem } from '../job/owner-text.js';
import type { InboxItem } from '../model/outreach.js';
import { nonempty } from '../model/primitives.js';
import { SkillRunSchema, SkillSourceSchema, type SkillRun } from '../model/skill.js';
import { createInboxItem, emitInboxChange } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import type { ToolContext } from '../tools/types.js';
import { newId } from '../util/ids.js';
import { redactSecrets } from '../util/redact.js';
import { truncateBytesKeepTail } from '../util/text.js';
import { localParts } from '../util/time.js';
import { enqueueSkillWorkUndoable } from './enqueue.js';
import { learnSubjectKey } from './keys.js';
import { offDutyReason, patchParticipant } from './retro-plan.js';
import { runTitleOf } from './run-title.js';
import { maybeFinishRun } from './run.js';

/** 迁移没完成时 teach 的回答（技能库的数据在迁移完成之后才齐，派活说明第一节第 10 条）。 */
export const LEARN_NOT_READY_TEXT = '技能库还在升级整理，稍后再试。';
/** 不是主人发话叫醒的回合里调用 teach 的拒绝文字。 */
export const TEACH_NOT_OWNER_TURN_TEXT = '只能在主人发话叫醒的回合里用';
/** teach 成功后返回给总管的话（逐字，任务卡 4.1）。 */
export const TEACH_DONE_TEXT = '已列出最近的会话，请主人选一段；reply 只写一句「是哪一段？」。';
/** 读会话摘要失败时总管私聊里落的话的后半（前面是员工名字）：「没能读取这段会话，{员工}这次没有学习。」 */
export function learnReadFailedText(name: string): string { return `没能读取这段会话，${name}这次没有学习。`; }

/** 学习的员工此刻不在岗时，总管私聊里落的话（逐字，P75r5c 第 7 节第 2 条）。 */
export function learnOffDutyText(name: string): string { return `${name}此刻不在岗，这次没有学习。`; }
/** 提问卡正文里，在总管写的那句（要学什么）之后另起一行的提醒（逐字，P75r5c 第 6 节第 3 条）：告诉主人选中的会话会给谁看。 */
export function learnVisibilityNotice(name: string): string { return `选中的那段会话的内容会交给${name}和核对的同事阅读，其中像密钥的内容会先隐去。`; }

/** 宿主返回的最近会话（逐项校验，不信任宿主）。 */
const HostSessionsSchema = z.array(z.strictObject({ sessionId: nonempty, title: z.string(), updatedAt: z.number().int() }));

/** 控制字符（含换行、制表符、行分隔符）。 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

/**
 * 双向文字控制符（U+202A 至 U+202E、U+2066 至 U+2069）和零宽字符（U+200B 至 U+200D、U+FEFF）：
 * 它们不显示，却能让标题的显示顺序颠倒或让两个不同的标题看起来一样（P75r5c，审查 L7），一律去掉。
 */
const INVISIBLE_CHARS = new RegExp('[\\u202a-\\u202e\\u2066-\\u2069\\u200b-\\u200d\\ufeff]', 'g');

/**
 * 会话标题压成一行：去掉双向控制符与零宽字符、控制字符各换成一个空格、去首尾空白、隐去像密钥的内容（P75r6 第 5 节，复验 N5：
 * DSH 的会话标题通常取自第一条消息，里面可能带着密钥）、截到 max 个字；空标题写「未命名会话」。
 * 先隐去、后截取：免得密钥被截断成认不出来的残片。重复处理结果不变。
 */
function oneLine(text: string, max: number): string {
  const clean = redactSecrets(text.replace(INVISIBLE_CHARS, '').replace(CONTROL_CHARS, ' ').trim());
  const chars = [...clean];
  return chars.length === 0 ? '未命名会话' : chars.slice(0, max).join('');
}

/** 一段会话在「待你处理」里的选项文字：「{标题}　{M}月{D}日 {HH:mm}」；重复的选项加序号区分（保证每个选项唯一）。 */
export function sessionOptionLabels(ctx: HubContext, sessions: Array<{ title: string; at: number }>): string[] {
  const labels: string[] = [];
  for (const session of sessions) {
    const p = localParts(session.at, ctx.settings.timezone);
    const base = `${session.title}　${p.month}月${p.day}日 ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    let label = base;
    for (let n = 2; labels.includes(label); n += 1) label = `${base}（${n}）`;
    labels.push(label);
  }
  return labels;
}

/** 迁移完成了吗（P75b 的迁移记录是 done）。 */
export function migrationDone(ctx: HubContext): boolean {
  return ctx.store.table('migrations').get(MD.MIGRATION_ID)?.state === 'done';
}

/** teach 的参数（hub-skill.ts 已校验类型）。 */
export interface TeachArgs { staff: string; note: string }

/**
 * 总管请主人选会话（hub_skill 的 teach）。校验失败抛中文错误、什么都不写；成功返回给总管的一句话。
 * 校验：调用者是总管；本回合是主人发起的；迁移已完成；staff 是在岗、不是总管的员工；note 1 到 LEARN_NOTE_MAX_CHARS 字、单行、
 * 不含内部名称；宿主能列出至少一段最近会话。
 * 总管名下上一条还在等主人选会话的学习：自动撤回，按新的来（派活说明第二节第 3 条：这条提问不到期，拒绝的做法会让「教它技能」永远用不了）。
 */
export async function runTeach(ctx: HubContext, tc: ToolContext, args: TeachArgs): Promise<string> {
  // ---- 第一段：校验（前三项不满足时后面没有意义，直接说；后面的一次列全）----
  const chief = requireChief(ctx, tc, '请员工学习');
  const wake = currentWake(ctx, tc);
  if (wake === null || wake.ownerInitiated !== true) throw new Error(TEACH_NOT_OWNER_TURN_TEXT);
  if (!migrationDone(ctx)) throw new Error(LEARN_NOT_READY_TEXT);
  const problems: string[] = [];
  const staffName = args.staff.trim();
  const named = ctx.store.table('bots').list(row => row.name === staffName || row.id === staffName);
  const learner = named.find(row => offDutyReason(row) === null) ?? null;
  if (named.length === 0) problems.push(`staff：找不到叫「${staffName}」的员工`);
  else if (named.some(row => row.id === chief.id)) problems.push('staff：不能是总管自己，请写要学习的员工的名字');
  else if (learner === null) problems.push(`staff：「${staffName}」此刻不在岗，不能学习`);
  const note = args.note.trim();
  const noteChars = [...note].length;
  if (noteChars < 1 || noteChars > D.LEARN_NOTE_MAX_CHARS) problems.push(`note：1 到 ${D.LEARN_NOTE_MAX_CHARS} 字`);
  if (new RegExp(CONTROL_CHARS.source).test(note)) problems.push('note：必须是单行文字，不能含换行、制表符等控制字符');
  const noteProblem = ownerTextProblem('note', note);
  if (noteProblem !== null) problems.push(noteProblem);
  if (problems.length > 0) throw new Error(`没有列出会话：${problems.join('；')}`);
  // 宿主的最近会话（不信任宿主：逐项校验）。
  let listed: z.infer<typeof HostSessionsSchema>;
  try {
    listed = HostSessionsSchema.parse(await ctx.host.listRecentSessions(D.LEARN_SESSIONS_MAX));
  } catch (error) {
    throw new Error(`没有列出会话：读取最近的会话失败（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (listed.length === 0) throw new Error('没有列出会话：宿主里没有可选的最近会话，请主人先在 DSH 里打开那段会话');
  const sessions = listed.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, D.LEARN_SESSIONS_MAX)
    .map(row => ({ id: row.sessionId, title: oneLine(row.title, 40), at: row.updatedAt }));

  // ---- 第二段：写表（先建新的，成功之后才撤回上一条；中途失败恢复原状）----
  const now = ctx.clock.now();
  const run = parseInput(SkillRunSchema, {
    id: newId('sr', ctx.rng), kind: 'learn', jobId: null, category: null, participants: [],
    turnsUsed: 0, turnCap: D.LEARN_TURN_CAP, tokens: 0, summaryPostedAt: null, createdAt: now, endedAt: null,
    learn: { learnerId: learner!.id, note, sessions, sessionId: null, digest: null, inboxId: null },
  }, '学习记录');
  ctx.store.table('skillRuns').put(run);
  let item: InboxItem | null = null;
  try {
    item = createInboxItem(ctx, {
      botId: chief.id, type: 'question', title: `${learner!.name}要学的会话`, body: `${note}\n${learnVisibilityNotice(learner!.name)}`,
      options: sessionOptionLabels(ctx, sessions), defaultOption: null, priority: 'P2', expiresAt: null,
      subjectKey: `learn:${run.id}`,
    });
    ctx.store.table('skillRuns').put({ ...run, learn: { ...run.learn!, inboxId: item.id } });
  } catch (error) {
    ctx.store.table('skillRuns').remove(run.id);
    if (item !== null) { ctx.store.table('inbox').remove(item.id); emitInboxChange(ctx, item); }
    throw error instanceof Error ? error : new Error(String(error));
  }
  // 总管名下上一条还在等主人选会话的学习：撤回（条目标为撤回，记录结束），照现有的撤回做法。
  for (const prior of ctx.store.table('skillRuns').list(row => row.kind === 'learn' && row.id !== run.id && row.endedAt === null && row.learn?.sessionId == null)) {
    const priorItem = prior.learn?.inboxId == null ? null : ctx.store.table('inbox').get(prior.learn.inboxId);
    if (priorItem === null || priorItem.botId !== chief.id) continue;
    if (priorItem.status === 'open') {
      ctx.store.table('inbox').patch(priorItem.id, { status: 'withdrawn', answer: '已被新的学习取代', answeredAt: now });
      emitInboxChange(ctx, priorItem);
    }
    ctx.store.table('skillRuns').put({ ...prior, endedAt: now });
  }
  return TEACH_DONE_TEXT;
}

/** chooseLearnSession 的入参：via 记这次选择从哪个入口来（按钮或「待你处理」）。 */
export interface ChooseLearnArgs { runId: string; option: string; via: 'button' | 'inbox' }

/**
 * 主人选了一段会话（两个入口结果相同）。校验：记录存在、还没选过、option 是列出的选项之一。
 * 第一段：条目标为已回答；以主人名义在总管私聊落所选的那一行（与普通提问被回答时落的那一行相同）；读会话摘要
 *   （读不到：记录结束，总管私聊以总管名义落「没能读取这段会话，{员工}这次没有学习。」）；写 learn.sessionId、learn.digest；
 *   写一条出处（owner_instruction）；参与者加学习的员工（queued）。
 * 第二段：给员工排学习唤醒（主人发起、不叫醒总管）。
 */
export async function chooseLearnSession(ctx: HubContext, args: ChooseLearnArgs): Promise<{ started: boolean }> {
  const run = ctx.store.table('skillRuns').get(args.runId);
  if (run === null || run.kind !== 'learn' || run.learn == null) throw new Error('runId：找不到这次学习');
  const learn = run.learn;
  if (run.endedAt !== null) throw new Error('这次学习已经结束，不能再选会话');
  if (learn.sessionId !== null) throw new Error('这次学习已经选过会话了');
  const item = learn.inboxId === null ? null : ctx.store.table('inbox').get(learn.inboxId);
  if (item === null || item.status !== 'open' || item.botId === null) throw new Error('这次学习的提问已经处理过了');
  const labels = sessionOptionLabels(ctx, learn.sessions);
  const index = labels.indexOf(args.option);
  if (index < 0) throw new Error(`option：不是这次列出的会话，请选其中一项：${labels.join('、')}`);
  const session = learn.sessions[index]!;
  const chiefId = item.botId;
  const learner = ctx.store.table('bots').get(learn.learnerId);
  const name = learner?.name ?? '员工';

  // ---- 第一段：条目标为已回答、落主人所选的那一行（先于任何 await：并发的第二次选择在这里就会被上面的状态检查拒绝）----
  const now = ctx.clock.now();
  ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: args.option, answeredAt: now });
  postThread(ctx, { thread: chiefId, from: 'owner', kind: 'reply', text: `「${item.title}」：${args.option}`, refId: item.id });
  writeOutreachAudit(ctx, 'inbox_answer', { id: item.id, answer: args.option, expired: false }, 'owner');
  emitInboxChange(ctx, item);

  // P75r5c（第 7 节第 2 条）：学习的员工此刻已不在岗：不读摘要，这次学习结束，总管私聊以总管名义落一句如实的说明
  // （以前照样读摘要，然后落「没能从这段会话整理出可以写入的做法」，与事实不符）。
  if (offDutyReason(learner ?? null) !== null) {
    ctx.store.table('skillRuns').put({ ...run, endedAt: ctx.clock.now(), summaryPostedAt: ctx.clock.now() });
    postThread(ctx, { thread: chiefId, from: chiefId, kind: 'reply', text: learnOffDutyText(name), refId: `learn-end:${run.id}` });
    return { started: false };
  }

  // 读会话摘要（宿主给的，先截字数）。读不到或是空的：这次学习结束，总管私聊落说明。
  // P75r5c（第 6 节）：先隐去像密钥的内容，再按字节上限截取、保留末尾（宿主取的就是会话最后一段，最新的内容在末尾；
  // 以前保留开头，丢掉的反而是最新的内容）。先隐去、后截取：免得密钥被截断成残片、认不出来。
  let digest = '';
  try {
    digest = truncateBytesKeepTail(redactSecrets(await ctx.host.readSessionDigest(session.id, ctx.settings.c03.teachDigestMaxChars)), ctx.settings.c03.teachDigestMaxBytes);
  } catch (error) {
    ctx.logger.warn('学习：读会话摘要失败', { runId: run.id, error: String(error) });
  }
  // P75r5c（第 7 节第 1 条）：读摘要要等待。等待期间这条学习记录可能已经结束（例如总管再次发起了学习，上一条被撤回），
  // 或已经选过会话：这时丢弃摘要、不排唤醒、也不落任何消息；写回时用重新读到的记录，不用等待之前读到的旧对象。
  const latest = ctx.store.table('skillRuns').get(run.id);
  if (latest === null || latest.endedAt !== null || latest.learn == null || latest.learn.sessionId !== null) return { started: false };
  if (digest.trim() === '') {
    ctx.store.table('skillRuns').put({ ...latest, endedAt: ctx.clock.now(), summaryPostedAt: ctx.clock.now() });
    postThread(ctx, { thread: chiefId, from: chiefId, kind: 'reply', text: learnReadFailedText(name), refId: `learn-end:${run.id}` });
    return { started: false };
  }

  // 出处与参与者（两段写入：任一步失败恢复原状）。
  const source = parseInput(SkillSourceSchema, {
    id: newId('ss', ctx.rng), botId: learn.learnerId, kind: 'owner_instruction',
    // P75r5c（L5）：出处的种类已经写「你的指示」，标签只写会话（活动流写成「来自你的指示（会话『…』）」，不重复「你的指示」）。
    label: `会话『${oneLine(session.title, 40)}』`,
    // 原文取摘要前 400 字（schema 允许多行，不替换换行）。
    quote: [...digest.trim()].slice(0, D.SOURCE_QUOTE_MAX_CHARS).join(''),
    relayed: false, jobId: null, category: null, refs: { sessionId: session.id }, createdAt: now,
  }, '技能出处');
  const written: SkillRun = {
    // P75r6（复验 N4）：记下主人选定会话的时刻，学习的 7 天过期从这里算起。
    ...latest, learn: { ...latest.learn, sessionId: session.id, digest, chosenAt: ctx.clock.now() },
    participants: [{ botId: learn.learnerId, role: 'executor', sourceIds: [source.id], state: 'queued', reason: null }],
  };
  ctx.store.table('skillSources').put(source);
  ctx.store.table('skillRuns').put(written);
  // ---- 第二段：排学习唤醒（主人发起；不叫醒总管）----
  try {
    const wake = enqueueSkillWorkUndoable(ctx, { runId: run.id, botId: learn.learnerId, key: learnSubjectKey(run.id, learn.learnerId), title: runTitleOf(ctx, written) });
    if (wake.entry === null) {
      // 此刻停用或归档：记 skipped 及原因，记录随即结束；其余（例如感知被去重）保持 queued，由兜底补排。
      const off = offDutyReason(learner ?? null);
      if (off !== null) { patchParticipant(ctx, run.id, learn.learnerId, 'skipped', off); maybeFinishRun(ctx, run.id); }
    }
  } catch (error) {
    ctx.logger.warn('学习唤醒排队出错，由兜底补排', { runId: run.id, error: String(error) });
  }
  return { started: true };
}

/**
 * answerInbox 对 learn: 前缀条目的分流（P75i）：
 * - 回答是列出的选项之一：等同选了这一段（chooseLearnSession，via inbox），返回处理后的条目；
 * - 不是选项之一（主人在条目上自己写了一句别的话，决策 DC64）：这次学习记录结束（不加参与者、不排唤醒），
 *   返回 handled 为 false，由调用方把这句话照普通提问回答的路径交给总管（叫醒总管，不落「没能读取」那一句）。
 */
export async function answerLearnInbox(ctx: HubContext, item: InboxItem, answer: string): Promise<{ handled: true } | { handled: false }> {
  const runId = item.subjectKey.split(':')[1] ?? '';
  const run = ctx.store.table('skillRuns').get(runId);
  if (run === null || run.kind !== 'learn' || run.learn == null || run.learn.inboxId !== item.id) {
    // 记录对不上（例如旧数据）：当普通提问处理，不阻止主人回答。
    return { handled: false };
  }
  const labels = sessionOptionLabels(ctx, run.learn.sessions);
  if (labels.includes(answer)) {
    await chooseLearnSession(ctx, { runId: run.id, option: answer, via: 'inbox' });
    return { handled: true };
  }
  if (run.endedAt === null) ctx.store.table('skillRuns').put({ ...run, endedAt: ctx.clock.now() });
  return { handled: false };
}
