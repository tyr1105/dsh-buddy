/** 主人看到事实和结果，模型读取执行指令；集中处理旧候选与重建候选，避免指令经状态或活动流泄漏。 */
import type { HubContext } from '../engine/context.js';
import type { Approval, Bot, Percept, WakeReason } from '../model/index.js';
import { approvalActionText } from './action-text.js';
import { approvedOutboxResult, outboxOwnerResult } from './outbox-text.js';

/** 执行指令只供机器人读取；唤醒时按当前状态重新生成，已经用过的票不能复活成再执行一次。 */
export function approvalModelSummary(row: Approval, status: 'approved' | 'rejected' | 'expired', note = ''): string {
  return `审批单 ${row.id} 已${status === 'approved' ? (row.tool === 'hub_outbox_execute' ? '批准，由中心执行出站动作，请等待中心结果，不要再次调用' : '批准，用完全相同的参数再调用一次') : status === 'expired' ? '过期，视为拒绝，不要执行' : '拒绝，不要执行'}${note ? `。主人附言：${note}` : ''}`;
}

/** 决定文案与执行方式匹配；直接工具由机器人重试，只有出站动作由中心代执行。 */
export function approvalOwnerSummary(row: Approval, status: Approval['status'], note = '', ctx?: HubContext): string {
  const action = approvalActionText(row);
  const outbox = ctx?.store.table('outbox').list(item => item.approvalId === row.id)[0];
  // 中心因内容改变作废批准票是“未执行”，不能在状态栏或重新唤醒时误写成主人拒绝。
  if (outbox?.status === 'rejected' && outbox.executionStarted === false && outbox.ownerFailureReason === '脚本在批准后被改动') {
    return approvedOutboxResult(outbox, ctx?.settings.c03.actionCommandMaxChars);
  }
  if ((status === 'approved' || status === 'used') && outbox && ['done', 'failed'].includes(outbox.status)) {
    // M09 旧失败没有执行标记；未消费批准票就没有执行证据，升级后不能把复查拒绝说成已经执行。
    const result = outbox.executionStarted === undefined && status !== 'used' ? { ...outbox, executionStarted: false } : outbox;
    return approvedOutboxResult(result, ctx?.settings.c03.actionCommandMaxChars);
  }
  const priorApproval = row.status === 'approved' || approvalDecisions(ctx, row.id).some(item => item.status === 'approved');
  const inactive = ctx && !['active', 'probation'].includes(ctx.store.table('bots').get(row.botId)?.lifecycle ?? '');
  if (status === 'used' && row.tool === 'hub_outbox_execute') return `正在确认你批准的动作结果：${action}`;
  const summary = status === 'approved' || status === 'used'
    ? `你批准了：${action}${row.tool === 'hub_outbox_execute' ? inactive
      ? '，队友恢复在岗后由中心执行（24 小时内有效）' : '，中心会在下次巡检时执行' : ''}`
    : status === 'expired' ? `${priorApproval && outbox ? '批准已过期，未执行' : '审批已过期'}：${action}`
      : status === 'rejected' ? `你拒绝了：${action}` : `等待你批准：${action}`;
  return `${summary}${note ? `。你的附言：${note}` : ''}`;
}
/** 审计只用来恢复明确的主人决定和附言；损坏旧行忽略，不解析模型输出猜测批准。 */
function approvalDecisions(ctx: HubContext | undefined, id: string): Array<{ id: string; status: string; note?: string }> {
  return (ctx?.store.log('audit').all() ?? []).filter(row => row.action === 'approval_decided').flatMap(row => {
    try {
      const value = JSON.parse(row.detail) as { id?: string; status?: string; note?: string };
      return value.id === id && typeof value.status === 'string' ? [{ id, status: value.status, note: value.note }] : [];
    } catch { return []; }
  });
}
/** 审批结果可由原始感知重新入队；用对应决定时的状态与附言恢复主人摘要，不猜测模型指令的字符串格式。 */
export function ownerPerceptSummary(ctx: HubContext, percept: Pick<Percept, 'kind' | 'location' | 'summary'>): string {
  if (percept.kind === 'approval_decided') {
    const [id] = (percept.location ?? '').split(':');
    const approval = id ? ctx.store.table('approvals').get(id) : null;
    if (!approval) return '审批已有处理结果';
    const decision = approvalDecisions(ctx, approval.id).at(-1);
    return approvalOwnerSummary(approval, approval.status, decision?.note ?? '', ctx);
  }
  if (percept.kind === 'inbox_reply') return '收件箱事项已有回复';
  if (percept.kind === 'outbox_done') {
    const action = percept.location ? ctx.store.table('outbox').get(percept.location) : null;
    return action ? outboxOwnerResult(action, ctx.settings.c03.actionCommandMaxChars) : '出站动作已有执行结果';
  }
  return percept.summary || percept.kind;
}
/** 新理由直接使用分开的主人摘要；旧控制理由以保守事实代替模型指令。 */
export function ownerReasonSummary(reason: WakeReason, ctx?: HubContext): string {
  // 审批不是决定时的静态快照；按证据现场读当前执行状态，合并候选不能漏掉第二项决定。
  if (reason.kind === 'approval_decided' && ctx) {
    const ids = new Set<string>();
    for (const id of reason.evidence) {
      if (ctx.store.table('approvals').get(id)) ids.add(id);
      const percept = ctx.store.table('percepts').get(id);
      if (percept?.kind === 'approval_decided' && percept.location) ids.add(percept.location.split(':')[0]!);
    }
    const summaries = [...ids].flatMap(id => {
      const approval = ctx.store.table('approvals').get(id);
      return approval ? [approvalOwnerSummary(approval, approval.status, approvalDecisions(ctx, id).at(-1)?.note ?? '', ctx)] : [];
    });
    if (summaries.length) return summaries.length === 1 ? summaries[0]! : `处理你的 ${summaries.length} 项审批：${summaries.join('；')}`;
  }
  if (reason.ownerSummary) return reason.ownerSummary;
  // 旧队列没有分开的文案；只改写有精确来源证据的出站结果，不能因合并了证据而替换普通主人原话。
  const result = ctx && reason.evidence.map(id => ctx.store.table('percepts').get(id))
    .find(percept => percept?.kind === 'outbox_done' && percept.summary === reason.summary);
  if (result) return ownerPerceptSummary(ctx!, result);
  // 升级前排队的试跑、教学和内驱也没有主人摘要，不能等它们被重新生成才隐藏执行提示。
  if (reason.kind === 'trial') return '新队友开始试跑';
  if (reason.kind === 'teach') return '已收到教学会话';
  if (reason.kind === 'drive') return '复查目标与待办进展';
  if (reason.kind === 'reflection') return '复盘目标与做事方式';
  if (reason.kind === 'light_check') return '做一次轻复查';
  if (reason.kind === 'catch_up') return '补看停机期间的变化';
  if (reason.kind === 'retry') return '重新尝试处理待办';
  if (reason.kind === 'owner_message' && reason.summary === '处理暂停期间主人留下的消息') return '继续处理你暂停期间留的消息';
  return reason.kind === 'approval_decided' ? '审批已有处理结果'
    : reason.kind === 'inbox_reply' ? '收件箱事项已有回复' : reason.summary;
}

/** 状态栏只刷新当前排队或在途审批，不能用历史审批覆盖暂停、额度休息或其他工作状态。 */
export function ownerActivityText(ctx: HubContext, bot: Bot): string {
  if (!['active', 'probation'].includes(bot.lifecycle)) return bot.activityText;
  const reason = bot.activity === 'queued' ? ctx.store.table('queue').list(row => row.botId === bot.id)[0]?.reason
    : ['thinking', 'reflecting', 'catching_up'].includes(bot.activity)
      ? ctx.store.table('wakes').list(row => row.botId === bot.id && row.endedAt === null).at(-1)?.reason : undefined;
  return reason?.kind === 'approval_decided' ? `${bot.activity === 'queued' ? '' : '正在处理：'}${ownerReasonSummary(reason, ctx)}` : bot.activityText;
}
