/**
 * 队友侧任务工具的共用授权口径（F08 尾巴批次八）。
 *
 * 取消编制后，「哪些任务算你的」只认任务上直接记录的承接队友 id；
 * 两处各写一遍迟早走偏，所以收在这里作为唯一实现。
 * 这是纯查询，不读时钟、不写存储；在岗与等级边界仍由 defineTool 统一处理。
 */
import type { HubContext } from '../engine/context.js';
import type { ProjectTask } from '../model/project.js';

/** 这个任务是否直接指派给该队友；没有指派（null）不算。 */
export function isTaskAssignedTo(task: ProjectTask, botId: string): boolean {
  return task.assigneeBotId === botId;
}
