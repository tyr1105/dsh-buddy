/**
 * 三问卡与组队卡的命令接线（P73e）。
 *
 * 三个命令：answerTeamQuestion（点选回答）、editTeamCandidate（卡内编辑）、confirmTeamProposal（确认入职）。
 * 它们都只改数据、不调用模型。每个命令的统一做法：
 * - 成功：刷新当前线程、待你处理和总览（卡片、条目、员工列表随之变化），返回 null；
 * - 失败：把中文原因交回卡片显示。「卡片已更新」一类的失败说明卡片在别处被改过，
 *   所以失败时也刷新一次线程，让你在最新内容上重新操作；不自动重试。
 * 放在 logic 层而不是 HubPage：纯编排，hub 以最小接口注入，便于对调用序列断言。
 */
import type { CommandResult } from '../../shared/views.js'
import { failureText } from './team-card.js'
import { pickDirectory } from '../directory-picker.js'

/** 接线需要的最小 hub 能力（HubStore 的子集）。 */
export interface TeamActionsHub {
  command: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  refreshThread: (threadId: string) => Promise<unknown> | unknown
  refreshInbox: () => Promise<unknown> | unknown
  refreshOverview: () => Promise<unknown> | unknown
}

/** 一个命令的提交函数：返回错误文字或 null（成功）。 */
export type TeamCommandRunner = (input: Record<string, unknown>) => Promise<string | null>

/** 刷新失败不影响命令结果：命令已经成功或已经有了失败原因，刷新只是让界面跟上。 */
async function refreshQuietly(hub: TeamActionsHub, threadId: string, all: boolean): Promise<void> {
  try {
    if (all) await Promise.all([hub.refreshThread(threadId), hub.refreshInbox(), hub.refreshOverview()])
    else await hub.refreshThread(threadId)
  } catch { /* 刷新失败时，下一次推送事件会再刷新。 */ }
}

/** 造一个命令的提交函数。threadId 取调用时的当前线程（总管私聊）。 */
export function teamCommandRunner(hub: TeamActionsHub, name: string, threadId: () => string): TeamCommandRunner {
  return async input => {
    try {
      const result = await hub.command(name, input)
      if (!result.ok) {
        await refreshQuietly(hub, threadId(), false)
        return result.error
      }
      await refreshQuietly(hub, threadId(), true)
      return null
    } catch (error) {
      return failureText(error)
    }
  }
}

/** 三个命令加选择文件夹，交给 CardActions。ctx 是宿主客户端上下文（选择文件夹要用）。 */
export function teamCardActions(hub: TeamActionsHub, threadId: () => string, ctx: unknown) {
  return {
    onAnswerTeamQuestion: teamCommandRunner(hub, 'answerTeamQuestion', threadId),
    onEditTeamCandidate: teamCommandRunner(hub, 'editTeamCandidate', threadId),
    onConfirmTeam: teamCommandRunner(hub, 'confirmTeamProposal', threadId),
    pickFolder: () => pickDirectory(ctx),
  }
}
