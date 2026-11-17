/**
 * 员工手上的活（P73d，方案 4.7、任务卡 6.3；P74b 加上「一件事」）：总管判断「他手上空不空」「最近做过哪个项目」要用的两个事实。
 *
 * 为什么由中心算好写进唤醒包：让模型自己去数事务和交接，既费回合又容易数错；
 * 数字由代码按固定口径算，模型只负责据此安排。
 * 本文件只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import { ROLE_LABELS } from '../model/enums.js';
import type { Bot } from '../model/bot.js';
import { isJobClosed } from '../job/store.js';
import { sameAsName } from '../util/name-label.js';
import { templateById } from './templates.js';

/** 一位员工手上的活。 */
export interface StaffWorkload {
  /**
   * 在办几件：指派给他、状态为进行中或待验收的项目事务数，加上他是收件人、状态为待接收或已接收的交接数，
   * 再加上他是执行者或核对人、状态不是已完成和已停止的「一件事」的件数（P74b）。
   */
  openCount: number;
  /** 最近做过的项目名：取他最近一条项目事务、或最近一件事（执行者或核对人）所属的项目名，哪个更新取哪个；取不到为 null。 */
  lastProjectName: string | null;
}

/**
 * 算一位员工手上的活。
 * 最近做过的项目从项目事务和「一件事」里取（取 updatedAt 最新的一条）：交接单本身不记录属于哪个项目，
 * 所以交接只计入「在办几件」，不参与「最近做过的项目」。
 * 总管自己核对的事（核对人为空）不算在员工头上，所以这里只认明确写了他的执行者和核对人。
 */
export function staffWorkload(ctx: HubContext, botId: string): StaffWorkload {
  const tasks = ctx.store.table('projectTasks').list(task => task.assigneeBotId === botId);
  const openTasks = tasks.filter(task => task.status === 'doing' || task.status === 'done_pending_check').length;
  const openHandoffs = ctx.store.table('handoffs').count(row => row.to === botId && (row.status === 'offered' || row.status === 'accepted'));
  const jobs = ctx.store.table('jobs').list(row => row.executorId === botId || row.reviewerId === botId);
  const openJobs = jobs.filter(job => !isJobClosed(job)).length;
  // 项目事务和一件事放在一起，取更新时间最新的一条所属的项目。
  const recent = [
    ...tasks.map(task => ({ projectId: task.projectId, updatedAt: task.updatedAt })),
    ...jobs.map(job => ({ projectId: job.projectId, updatedAt: job.updatedAt })),
  ].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const project = recent === undefined ? null : ctx.store.table('projects').get(recent.projectId);
  return { openCount: openTasks + openHandoffs + openJobs, lastProjectName: project?.name ?? null };
}

/**
 * P74r9 第 5 节：员工的岗位名称（组队时的岗位，如「工程师」「评审员」）：来历里记着模板标识的取模板的名字；
 * 旧员工和自己从头配置的没有模板，返回 null（句子里不写括号）。
 * 为什么不用 staffDutyLabel：它给的是岗位类别（执行、评审），拼进「由某某（执行）执行」「（评审）核对」会读起来重复；
 * 岗位类别只留在给总管看的在岗员工清单里。
 */
export function staffPostName(ctx: HubContext, bot: Bot): string | null {
  const templateId = ctx.store.table('botOrigins').get(bot.id)?.templateId ?? null;
  const post = templateId === null ? null : templateById(templateId)?.name ?? null;
  // P74r13：员工的名字与岗位名称相同（去掉首尾空白后相等）时当作没有岗位名称，句子里不写括号（见 util/name-label.ts）。
  return post === null || sameAsName(bot.name, post) ? null : post;
}

/**
 * 员工在唤醒包里显示的角色：有模板的用模板的显示标签（例如评审员写「评审」），没有的用角色标签。
 * 「有模板」指来历里记着模板标识；旧员工和自己从头配置的没有来历，用角色标签。
 */
export function staffDutyLabel(ctx: HubContext, bot: Bot): string {
  const templateId = ctx.store.table('botOrigins').get(bot.id)?.templateId ?? null;
  const template = templateId === null ? undefined : templateById(templateId);
  return template?.dutyLabel ?? ROLE_LABELS[bot.role];
}
