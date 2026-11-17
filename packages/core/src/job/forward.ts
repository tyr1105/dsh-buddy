/**
 * 总管把主人的材料转交给执行者（P74e，方案 5.2.2，B2 前半段；P74r2d 第 2 条按这件事的状态分别处理）：hub_job_manage 的 forward。
 *
 * 主人在私聊里发来与这件事有关的一段文字（例如一份新文案），总管不要转述，用 forward 把原文存成主题文件夹里的
 * 「材料/{title}.md」。只在主人发起的回合里可用（材料来自主人）。按这件事当前的状态分六种做法（P74r2d）：
 * - 待开工、执行中、返工中：存文件，叫醒执行者；
 * - 受阻，原因是执行者做不下去：存文件，同时解除受阻，叫醒执行者（材料往往正是他缺的东西）；
 * - 核对中：只存文件、记事件，不叫执行者（他此刻交不了，叫了白耗一个回合），他返工时唤醒包的材料清单里有这份材料；
 * - 受阻，原因是别的（有人停用、回合用到上限、主人让先停下、核对环节没有动静、核对三轮不过）：只存文件，不叫人；
 * - 待你验收：拒绝，不存文件（没有人接）；已完成、已停止：拒绝（不能再有任何动作）。
 *
 * 三段式（方案 6.4）：1 校验；2 写文件、写状态、给执行者排唤醒、记 forwarded 事件，有备份，任何一步失败全部恢复（文件删掉、
 * 状态写回），所以返回「已存为主题文件」时文件确实在、该叫醒时执行者确实会被叫醒；3 最后才写主人看得见的话。
 * 标题只允许汉字、字母、数字、空格、连字符、下划线：标题会成为文件名，不允许出现路径分隔符、「..」之类能越出文件夹的写法。
 */
import { posix } from 'node:path';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { JobSchema, jobBlockLabel, type Job } from '../model/job.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import type { ToolContext } from '../tools/types.js';
import { newId } from '../util/ids.js';
import type { JobManageArgs } from './assign.js';
import { isOnDutyNow } from './chain.js';
import { releaseBlockItems, withdrawBlockItems } from './block-items.js';
import { latestEstimate } from './estimate.js';
import { jobFolderPaths } from './files.js';
import { assertOpen, canForwardNow, chiefJobOf, isOwnerTurn, requireChief, requireFields } from './manage-common.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, putJob } from './store.js';
import { reviewStalled } from './version-stage.js';
import { queueWake, runUndo, softly, type UndoSteps } from './work-common.js';

/** 标题只允许这些字符：汉字、字母、数字、空格、连字符、下划线（标题会成为文件名，不能带路径写法）。 */
const TITLE_PATTERN = /^[\p{Script=Han}A-Za-z0-9 _-]+$/u;

/** 待你验收时转交材料的拒绝文字（原文）。 */
export const FORWARD_AWAITING_OWNER_TEXT = '这件事已交付、在等主人验收，现在转交材料没有人接。主人指出哪条不符，用 hub_job_manage 的 mode reopen 对到条目返工；主人要改约定，用 hub_agreement_submit 的 mode revise 出新版本请主人确认。';

/** 材料文件名：{title}.md；同名已存在时依次加「-2」「-3」……。existing 是材料文件夹里现有的文件名。 */
export function materialFileName(title: string, existing: readonly string[]): string {
  const taken = new Set(existing.map(name => name.normalize('NFC')));
  let name = `${title}.md`;
  for (let n = 2; taken.has(name.normalize('NFC')); n += 1) name = `${title}-${n}.md`;
  return name;
}

/** 转交时对这件事的处理：叫醒（可附带解除受阻）、只存文件（核对中）、只存文件（受阻在别处）。 */
type ForwardPlan = { kind: 'wake' } | { kind: 'unblock' } | { kind: 'checking' } | { kind: 'parked'; why: string };

/** 受阻说明（给总管和主人看）：停在哪个原因。 */
function parkedWhy(ctx: HubContext, job: Job, executorName: string): string {
  const blocked = job.blocked!;
  if (blocked.kind === 'executor') return '核对环节没有动静';
  if (blocked.kind === 'participant_off') {
    // 停用的是执行者还是核对人：哪一位不在岗就写哪一位的名字。
    const off = [job.executorId, job.reviewerId].find(id => id !== null && !isOnDutyNow(ctx, id)) ?? null;
    const name = off === null ? executorName : ctx.store.table('bots').get(off)?.name ?? '员工';
    return `${name}已停用`;
  }
  // P84（K6）：有预计的事，因预算线受阻写「已用到预计消耗」（与条目标题一致）；没有预计的旧事保留「回合用到上限」。
  if (blocked.kind === 'turn_cap' && latestEstimate(ctx, job.agreementId) !== null) return '已用到预计消耗';
  // 总管看的文字，「你已暂停」写成第三人称的「主人已暂停」。
  return blocked.kind === 'owner_hold' ? '主人已暂停' : jobBlockLabel(blocked.kind, executorName);
}

/** 按状态决定做法；待你验收在调用前已拒绝。 */
function planFor(ctx: HubContext, job: Job, executorName: string): ForwardPlan {
  switch (job.state) {
    case 'ready': case 'doing': case 'rework': return { kind: 'wake' };
    case 'checking': return { kind: 'checking' };
    case 'blocked':
      // 执行者做不下去（解除后回到执行中或返工中）：解除受阻并叫醒；核对环节没有动静（解除后回到核对中）按「别的」处理。
      return job.blocked?.kind === 'executor' && !reviewStalled(job) ? { kind: 'unblock' } : { kind: 'parked', why: parkedWhy(ctx, job, executorName) };
    default: return { kind: 'parked', why: '' };
  }
}

/** forward 的入口：返回给模型看的一句话。 */
export async function runJobForward(ctx: HubContext, tc: ToolContext, args: JobManageArgs): Promise<string> {
  // ---- 第一段：校验 ----
  const chief = requireChief(ctx, tc, '转交材料');
  requireFields('forward', args,['jobId', 'title', 'text']);
  const job = chiefJobOf(ctx, chief, args.jobId!);
  assertOpen(job, '转交材料');
  // P74r13：与修订成功后的转交提醒共用同一个判断（canForwardNow）。
  if (!canForwardNow(job)) throw new Error(FORWARD_AWAITING_OWNER_TEXT);
  if (!isOwnerTurn(ctx, tc)) throw new Error('转交材料只能在主人发话、确认或回答叫醒的回合里进行（材料来自主人）');
  const title = args.title!.trim();
  if (title === '' || [...title].length > D.FORWARD_TITLE_MAX_CHARS) throw new Error(`title：1 到 ${D.FORWARD_TITLE_MAX_CHARS} 个字`);
  if (!TITLE_PATTERN.test(title)) throw new Error('title：只能写汉字、字母、数字、空格、连字符、下划线，不能带斜杠、点号等符号');
  const text = args.text!;
  if (text.trim() === '') throw new Error('text：不能为空');
  if ([...text].length > D.FORWARD_TEXT_MAX_CHARS) throw new Error(`text：不能超过 ${D.FORWARD_TEXT_MAX_CHARS} 字`);
  const executor = ctx.store.table('bots').get(job.executorId);
  if (!executor) throw new Error('这件事的执行者找不到了，不能转交材料');
  const plan = planFor(ctx, job, executor.name);
  const { projectDir, jobDir } = jobFolderPaths(ctx, job);
  const folder = posix.join(jobDir, D.FOLDER_FILES.materials);
  const fileName = materialFileName(title, await ctx.fs.list(folder));
  const target = posix.join(folder, fileName);
  const relative = `${D.FOLDER_FILES.materials}/${fileName}`;
  // 解除受阻时，这件事回到受阻前的状态（与 answer 解除受阻同一个状态机动作）。
  // P74f-2：解除受阻时，这件事开着的「停住了」等条目一并撤回（状态里先清空编号，条目在第三段撤回）。
  // P74r4a 第 3 条：解除受阻统一走 releaseBlockItems。
  const released = plan.kind === 'unblock' ? releaseBlockItems(ctx, applyJobAction(job, { type: 'unblock' }, ctx.clock.now())) : null;
  const staleItems = released === null ? [] : released.items;
  const next: Job = released === null ? job : JobSchema.parse(released.job);

  // ---- 第二段：写文件、写状态、排唤醒、记事件，有备份 ----
  const now = ctx.clock.now();
  const eventId = newId('jev', ctx.rng);
  const undo: UndoSteps = [];
  const wakes = plan.kind === 'wake' || plan.kind === 'unblock';
  try {
    await ctx.fs.mkdirp(folder, { within: projectDir });
    await ctx.fs.writeTextAtomic(target, text.endsWith('\n') ? text : `${text}\n`, { within: projectDir });
    undo.push(() => ctx.fs.remove(target, { within: projectDir }));
    if (plan.kind === 'unblock') {
      putJob(ctx, next);
      undo.push(() => { putJob(ctx, job); });
    }
    if (wakes) {
      queueWake(ctx, { job: next, botId: executor.id, why: 'forwarded', eventId,
        summary: `总管转来主人的材料「${title}」（${relative}）` }, undo, executor.name);
    }
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: chief.id, kind: 'forwarded', to: [executor.id], refId: null,
      data: { file: relative, title, ...(wakes ? {} : { woken: false }), ...(plan.kind === 'unblock' ? { unblocked: true } : {}) } });
  } catch (error) {
    await runUndo(ctx, undo, '转交材料', job.id);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw new Error(`转交失败，已恢复到转交前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_forward', { jobId: job.id, file: relative }, chief.id, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, executor.id);

  // ---- 第三段：主人看得见的话 ----
  const result = plan.kind === 'unblock' ? `已存为主题文件「${title}」，交给${executor.name}，他接着做。`
    : plan.kind === 'checking' ? `已存为主题文件「${title}」。这件事在核对中，${executor.name}返工时会看到。`
    : plan.kind === 'parked' ? `已存为主题文件「${title}」。这件事现在停在：${plan.why}，材料等它恢复后${executor.name}会看到。`
    : `已存为主题文件「${title}」，交给${executor.name}。`;
  const threadText = plan.kind === 'unblock' ? `总管把主人的材料「${title}」交给了${executor.name}，${executor.name}继续做。`
    : plan.kind === 'checking' ? `总管把你的「${title}」存为主题文件，${executor.name}返工时会看到。`
    : plan.kind === 'parked' ? `总管把你的「${title}」存为主题文件，这件事恢复后${executor.name}会看到。`
    : `总管把你的「${title}」存为主题文件，交给了${executor.name}。`;
  softly(ctx, '撤回受阻条目', () => { withdrawBlockItems(ctx, staleItems, now, '总管已转交材料，这件事继续进行'); });
  softly(ctx, '工作往来里的提示', () => {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text: threadText });
  });
  softly(ctx, '总管私聊里的提示', () => {
    postThread(ctx, { thread: chief.id, from: 'hub', kind: 'system', refId: job.id, text: plan.kind === 'wake' ? `${title}已存为主题文件「${title}」，交给${executor.name}。` : result });
  });
  // 转交时这件事有未回答的提问：提醒总管材料也许能回答它（回答要另用 answer，出处写这份材料）。
  const asker = job.openAsk === null ? null : ctx.store.table('bots').get(job.openAsk.fromId)?.name ?? '员工';
  return asker === null ? result : `${result}${asker}的提问还没有回答：材料能回答它的话，再用 mode answer 回答，出处写这份材料。`;
}
