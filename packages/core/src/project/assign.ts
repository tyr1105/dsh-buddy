/**
 * 主人点名派活（v2 计划 3.4「派活（F12）」）。
 *
 * 为什么单独一个文件：派活同时要动任务、议程、唤醒候选三张表，规则比普通任务命令多，
 * 和 service.ts 的增删改查分开放，读起来清楚，也不会让 service.ts 超过 400 行。
 *
 * 一次派活按计划只做四件事：
 * 1. 把任务从「待办」推进到「进行中」，记下承接队友；
 * 2. 为承接队友建一条指向该任务的议程（note 里写 task:<id>，不改 strictObject 模型）；
 * 3. 写一条主人发起的唤醒候选，复用 owner_message 类型，不新增 WakeKind；
 * 4. 写审计并发 project 事件，失败命令不留半条记录。
 *
 * 保守默认：只有「进行中」的项目、只有「待办」任务能被派活；队友必须在岗（在岗/试岗）
 * 且是项目成员。取消编制后不再有席位；总管自动分派不做（计划明确本期不做）。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { AgendaItemSchema } from '../model/bot.js';
import type { ProjectTask } from '../model/project.js';
import { TASK_STATUS_LABELS } from '../model/project.js';
import { recordId } from '../model/primitives.js';
import { isBotOnTeam } from '../org/access.js';
import { buildCandidate } from '../appraisal/think.js';
import { recordOwnerMessage } from '../perception/sources.js';
import { enqueue } from '../scheduler/queue.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { newId } from '../util/ids.js';
import { nextStatus } from './task-state.js';

/** 派活入参：任务必填；队友可省略，省略时沿用任务上已指派的队友。 */
export const AssignTaskSchema = z.strictObject({
  taskId: recordId('pt'),
  botId: recordId('b').optional(),
});
export type AssignTaskInput = z.infer<typeof AssignTaskSchema>;

/** 议程 note 里的任务关联记号；任务 id 本身不含空格，用固定前缀便于查找。 */
const taskMark = (taskId: string): string => `task:${taskId}`;

/**
 * 主人把一个任务派给某个队友。
 * 所有校验通过后才生成议程 id、写三张表和唤醒候选，失败命令不耗 RNG。
 */
export function assignTask(ctx: HubContext, raw: unknown): ProjectTask {
  const input = parseInput(AssignTaskSchema, raw, '任务派活');
  const now = ctx.clock.now();

  // 1. 任务与项目：只有进行中的项目能派活，归档/暂停/完成都不接新工作。
  const task = ctx.store.table('projectTasks').get(input.taskId);
  if (!task) throw new Error(`任务不存在：${input.taskId}`);
  const project = ctx.store.table('projects').get(task.projectId);
  if (!project) throw new Error(`任务所属项目不存在：${task.projectId}`);
  if (project.status !== 'active') {
    throw new Error(`项目「${project.name}」当前是「${project.status}」，只有进行中的项目能派活`);
  }
  if (task.status !== 'todo') {
    throw new Error(`任务「${task.title}」当前是「${TASK_STATUS_LABELS[task.status]}」，只有待办任务能派活`);
  }

  // 2. 承接队友：显式选择优先，否则用任务上已指派的队友；必须在岗且是项目成员。
  const botId = input.botId ?? task.assigneeBotId;
  if (!botId) throw new Error('任务还没有承接队友：请在派活时选择一个项目成员队友');
  const bot = ctx.store.table('bots').get(botId);
  if (!bot || bot.lifecycle === 'retired') throw new Error(`队友不存在或已退役：${botId}`);
  if (!isBotOnTeam(bot)) {
    throw new Error(`队友「${bot.name}」当前是 ${bot.lifecycle}，只有在岗或试岗的队友能接活`);
  }
  if (!project.memberBotIds.includes(bot.id)) {
    throw new Error(`队友「${bot.name}」不是项目成员：请先把该队友加入项目成员`);
  }

  // 3. 议程名额：派活会给队友新增一条未完成议程，先按现有上限拦截，避免无限堆积。
  const openAgenda = ctx.store.table('agenda').count(a => a.botId === bot.id && a.status === 'open');
  if (openAgenda >= ctx.settings.maxOpenAgendaPerBot) {
    throw new Error(`队友「${bot.name}」未完成议程已达上限 ${ctx.settings.maxOpenAgendaPerBot} 条，请先清理再派活`);
  }

  // 校验全部通过后才生成 id、改状态。
  const agendaId = newId('a', ctx.rng);
  const agenda = AgendaItemSchema.parse({
    id: agendaId,
    botId: bot.id,
    kind: 'task',
    title: `项目任务：${task.title}`,
    goalId: null,
    dueAt: task.dueAt,
    onEvent: null,
    // 放弃条件必须明确：项目归档、任务验收通过或主人撤回派活，三选一发生就不再跟进。
    abandonWhen: '任务通过验收、项目归档或主人撤回派活',
    priority: 1,
    toOwner: false,
    source: 'owner',
    status: 'open',
    note: `关联任务 ${taskMark(task.id)}；项目「${project.name}」；项目目录 ${project.sharedDir}`,
    createdAt: now,
    updatedAt: now,
  });
  const record = ctx.store.table('projectTasks').patch(task.id, {
    assigneeBotId: bot.id,
    status: nextStatus(task.status, 'start'),
    updatedAt: now,
  });
  ctx.store.table('agenda').put(agenda);

  // 4. 审计与唤醒：主人派活属于可信事件，感知仍记成 owner_message，不新增类型。
  writeOutreachAudit(ctx, 'task_assign', {
    id: record.id, projectId: record.projectId, title: record.title,
    botId: bot.id, agendaId, from: task.status, to: record.status,
  }, 'owner', now);
  const percept = recordOwnerMessage(ctx, {
    botId: bot.id, id: agendaId, summary: `主人派活：${task.title}`, at: now,
  });
  enqueue(ctx, buildCandidate(ctx, {
    botId: bot.id,
    kind: 'owner_message',
    score: ctx.settings.c02.ownerSalience,
    summary: `主人派活：${task.title}`,
    evidence: [percept?.id ?? agendaId],
    ownerInitiated: true,
  }));
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return record;
}
