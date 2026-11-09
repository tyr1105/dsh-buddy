/**
 * 主人点名派活 / 催办 / 改派（v2 计划 3.4「派活（F12）」，任务卡 V2-PH4-03）。
 *
 * 为什么和 assign.ts 分开：assignTask 只覆盖「待办任务第一次派活」一条直线；
 * 真实项目里主人还会催进度、把活从一个队友改派给另一个队友、把受阻/被驳回的任务重新派出去。
 * 本文件是项目页「派活」按钮的完整入口，入参必须同时带项目、任务、队友三项 id，
 * 防止界面只拿任务 id 时把活派到错误项目的队友身上。主人取消编制后不再有席位这一层。
 *
 * 一次派活按顺序做五件事，全部校验通过后才取 id、写表，失败命令不耗 RNG：
 * 1. 校验项目进行中、任务属于该项目且不在验收链路（已通过终态、待验收先验收）；
 * 2. 校验承接队友存在、在岗（在岗或试岗）、是项目成员；
 * 3. 推进任务：todo/blocked/rejected→doing；doing 同一队友=催办（状态不变），doing 换队友=改派；
 * 4. 议程：目标队友没有打开的任务议程才新建（议程名额受限）；改派时旧队友的打开议程标 dropped；
 * 5. 向队友线程发一条主人原话消息（复用 owner_message 唤醒候选，不新增 WakeKind、不加定时器），
 *    写 task_dispatch 审计并广播 project scope。
 *
 * 保守默认（详见 docs/questions.md V2-PH4-03）：
 * - 派活议程 dueAt 恒为 null：派活是主人即时发起，不借任务截止时间再造 agenda_due 闹钟；
 * - 催办不新建议程，避免主人多催几次就把队友议程名额灌满；
 * - 完全相同的留言在感知去重窗口内只记录不重复唤醒，这是现有感知层口径，本命令不绕过。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { AgendaItemSchema, type AgendaItem } from '../model/bot.js';
import type { ProjectTask, TaskStatus } from '../model/project.js';
import { recordId, text } from '../model/primitives.js';
import { isBotOnTeam } from '../org/access.js';
import { sendOwnerMessage } from '../outreach/thread.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { newId } from '../util/ids.js';
import { nextStatus } from './task-state.js';

/** 派活留言长度上限；驳回理由同为 500 字，派活留言不比验收结论更长。 */
export const DISPATCH_NOTE_MAX = 500;

/**
 * 派活入参：项目、任务、队友三项 id 必填（项目 id 用于防跨项目误派）；留言可选。
 * strictObject：界面多传字段直接报错，而不是默默忽略，避免旧版界面传错参数还以为生效。
 */
export const DispatchTaskSchema = z.strictObject({
  projectId: recordId('prj'),
  taskId: recordId('pt'),
  botId: recordId('b'),
  note: text.trim().max(DISPATCH_NOTE_MAX, `派活留言不能超过 ${DISPATCH_NOTE_MAX} 字`).optional(),
});
export type DispatchTaskInput = z.infer<typeof DispatchTaskSchema>;

/** 议程 note 里的任务关联记号，与 assign.ts 保持一致，按此前缀找同一任务的旧议程。 */
const taskMark = (taskId: string): string => `task:${taskId}`;

/** 找某队友一条仍打开的该任务议程；议程可能被手动关掉，所以只认 status=open。 */
function findOpenTaskAgenda(ctx: HubContext, botId: string, mark: string): AgendaItem | undefined {
  return ctx.store.table('agenda')
    .list(a => a.botId === botId && a.status === 'open' && (a.note?.includes(mark) ?? false))[0];
}

/** 组装议程备注：固定标记段供机器关联，主人留言附在后面，没有留言就不写空架子。 */
function agendaNote(task: ProjectTask, projectName: string, sharedDir: string, note: string | null): string {
  const base = `关联任务 ${taskMark(task.id)}；项目「${projectName}」；项目目录 ${sharedDir}`;
  return note ? `${base}；主人留言：${note}` : base;
}

/** 发给队友的线程原话：按派活/催办/改派区分措辞，让队友醒来就知道主人这次要干什么。 */
function dispatchMessage(task: ProjectTask, projectName: string, renudge: boolean, reassigned: boolean, note: string | null): string {
  const head = renudge
    ? `主人催一下任务：${task.title}（项目「${projectName}」）`
    : `主人把任务${reassigned ? '改派' : '派活'}给你：${task.title}（项目「${projectName}」）`;
  return note ? `${head}\n留言：${note}` : head;
}

/**
 * 主人点名派活。返回更新后的任务行；失败抛中文错误，且不在任何表或日志里留半条记录。
 */
export function dispatchTask(ctx: HubContext, raw: unknown): ProjectTask {
  const input = parseInput(DispatchTaskSchema, raw, '任务派活');
  const now = ctx.clock.now();
  const note = input.note && input.note.length > 0 ? input.note : null;
  const mark = taskMark(input.taskId);

  // 1. 任务与项目：项目 id 必须对上，防止把甲项目的任务连同乙项目的席位派出去。
  const task = ctx.store.table('projectTasks').get(input.taskId);
  if (!task) throw new Error(`任务不存在：${input.taskId}`);
  if (task.projectId !== input.projectId) {
    throw new Error(`任务不属于该项目：任务 ${task.id} 属于项目 ${task.projectId}`);
  }
  const project = ctx.store.table('projects').get(input.projectId);
  if (!project) throw new Error(`任务所属项目不存在：${input.projectId}`);
  if (project.status !== 'active') {
    throw new Error(`项目「${project.name}」当前是「${project.status}」，只有进行中的项目能派活`);
  }

  // 2. 任务状态：已通过是终态；待验收必须先由主人给结论，不能靠再派活绕过验收。
  if (task.status === 'accepted') {
    throw new Error(`任务「${task.title}」已通过验收，是终态，不能再派活`);
  }
  if (task.status === 'done_pending_check') {
    throw new Error(`任务「${task.title}」正在待验收：请先验收通过或驳回，再决定派给谁`);
  }

  // 3. 承接队友：存在、在岗（在岗/试岗）、是项目成员，三条缺一不可（取消编制后不再看席位）。
  const bot = ctx.store.table('bots').get(input.botId);
  if (!bot || bot.lifecycle === 'retired') throw new Error(`队友不存在或已退役：${input.botId}`);
  if (!isBotOnTeam(bot)) {
    throw new Error(`队友「${bot.name}」当前是 ${bot.lifecycle}，只有在岗或试岗的队友能接活`);
  }
  if (!project.memberBotIds.includes(bot.id)) {
    throw new Error(`队友「${bot.name}」不是项目成员：请先把该队友加入项目成员`);
  }

  // 4. 判定本次动作：改派（任务原在别的队友名下）、催办（进行中且仍是同一队友）、或新派/恢复。
  const oldBotId = task.assigneeBotId;
  const reassigned = oldBotId !== null && oldBotId !== bot.id;
  const renudge = task.status === 'doing' && !reassigned;
  const targetStatus: TaskStatus = task.status === 'doing'
    ? 'doing'
    : nextStatus(task.status, task.status === 'todo' ? 'start' : task.status === 'blocked' ? 'resume' : 'rework');

  // 5. 议程：目标队友已有打开的同任务议程就复用（催办、改派回原队友都走这里）；
  //    需要新建时先查名额。旧队友的打开议程在改派成功后统一标 dropped。
  const existingAgenda = findOpenTaskAgenda(ctx, bot.id, mark);
  if (!existingAgenda) {
    const openAgenda = ctx.store.table('agenda').count(a => a.botId === bot.id && a.status === 'open');
    if (openAgenda >= ctx.settings.maxOpenAgendaPerBot) {
      throw new Error(`队友「${bot.name}」未完成议程已达上限 ${ctx.settings.maxOpenAgendaPerBot} 条，请先清理再派活`);
    }
  }
  const droppedAgendas = reassigned && oldBotId
    ? ctx.store.table('agenda').list(a => a.status === 'open' && a.botId === oldBotId && (a.note?.includes(mark) ?? false))
    : [];

  // 所有校验通过后才取随机数、写表：失败命令不耗 RNG。
  const agendaId = existingAgenda?.id ?? newId('a', ctx.rng);
  if (!existingAgenda) {
    ctx.store.table('agenda').put(AgendaItemSchema.parse({
      id: agendaId,
      botId: bot.id,
      kind: 'task',
      title: `项目任务：${task.title}`,
      goalId: null,
      // 派活是主人即时唤醒，不继承任务 dueAt 再造到期闹钟（保守默认，见 questions.md）。
      dueAt: null,
      onEvent: null,
      abandonWhen: '任务通过验收、项目归档或主人撤回派活',
      priority: 1,
      toOwner: false,
      source: 'owner',
      status: 'open',
      note: agendaNote(task, project.name, project.sharedDir, note),
      createdAt: now,
      updatedAt: now,
    }));
  }
  for (const old of droppedAgendas) {
    ctx.store.table('agenda').patch(old.id, { status: 'dropped', updatedAt: now });
  }
  const record = ctx.store.table('projectTasks').patch(task.id, {
    assigneeBotId: bot.id,
    status: targetStatus,
    updatedAt: now,
  });

  // 6. 主人原话进队友线程：sendOwnerMessage 同时落感知并入队 owner_message 候选（豁免门槛）。
  const message = sendOwnerMessage(ctx, bot.id, dispatchMessage(task, project.name, renudge, reassigned, note));

  // 7. 审计：把这次派活的完整事实记下，账本与项目页可据此复盘「谁在什么时候把活派给了谁」。
  writeOutreachAudit(ctx, 'task_dispatch', {
    id: record.id,
    projectId: project.id,
    taskId: record.id,
    title: record.title,
    botId: bot.id,
    agendaId,
    messageId: message.id,
    from: task.status,
    to: record.status,
    renudge,
    reassigned,
    reusedAgenda: existingAgenda !== undefined,
    droppedAgendaIds: droppedAgendas.map(a => a.id),
    note,
  }, 'owner', now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return record;
}
