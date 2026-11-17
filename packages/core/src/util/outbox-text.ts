/** 出站结果的主人文案统一由中心事实生成；外部响应正文只留在原结果和模型的不可信证据区。 */
import type { OutboxAction } from '../model/outreach.js';
import type { HubContext } from '../engine/context.js';
import { C03_DEFAULTS } from '../config/defaults.js';
import { describeAction } from './action-text.js';

/** 文件接口和中心复查的错误只取首句；统一使用已有参数预览上限，避免无限长异常占满状态栏。 */
export function shortFailure(text: string, maxChars: number = C03_DEFAULTS.approvalOwnerParamsMaxChars): string {
  return Array.from(text.split(/[\r\n。！？]/, 1)[0]?.trim() || '中心未能完成动作').slice(0, maxChars).join('');
}

/** 传输异常只映射中心认可的类别；不把异常里的响应正文当成给主人看的原因。 */
export function transportFailure(text: string, network: boolean): string {
  if (/timeout|timed?\s*out|ETIMEDOUT|超时/i.test(text)) return network ? '网络请求超时' : '命令启动或执行超时';
  if (network) return /ENOTFOUND|EAI_AGAIN|解析/i.test(text) ? '域名解析失败' : '网络连接失败';
  if (/ENOENT|not found|找不到/i.test(text)) return '找不到命令程序';
  if (/EACCES|EPERM|permission|权限/i.test(text)) return '没有运行命令的权限';
  return '命令启动失败';
}

/** 新结果使用执行时保存的可信原因，旧结果仅识别中心固定前缀，不能重新解释外部正文。 */
export function outboxFailureReason(row: OutboxAction): string {
  if (row.ownerFailureReason) return row.ownerFailureReason;
  const result = row.result ?? '';
  if (row.kind === 'write_file') return shortFailure(result || '文件未能写入');
  if (row.kind === 'http_post') {
    const status = /^HTTP \d+/.exec(result)?.[0];
    return status ? `${status}，请求未成功` : transportFailure(result, true);
  }
  if (row.kind === 'run_command') return /^(命令超时|命令输出超过硬上限，已终止进程组|命令被信号终止，未返回退出码|命令退出码 -?\d+)/.exec(result)?.[0]
    ?? transportFailure(result, false);
  return '通知未能完成';
}

/** 所有主人结果都用同一个分隔格式，避免把“已完成”粘成路径或命令参数的一部分。 */
export function formatActionResult(action: string, result: string): string { return `${action} → ${result}`; }

/**
 * P69（总控裁定第 6 条）：执行回执和「你批准了：……」说同一句话。
 * 取审批单上存的、给主人看的那句话；审批单是旧版本（没有新话）或查不到时返回 undefined，调用方退回现有写法。
 */
export function approvedActionText(ctx: Pick<HubContext, 'store'> | undefined, row: OutboxAction): string | undefined {
  const approval = ctx && row.approvalId ? ctx.store.table('approvals').get(row.approvalId) : null;
  return approval?.actionTextVersion === 3 && approval.actionText ? approval.actionText : undefined;
}

/** 给员工的唤醒原因里「错误」最多带多少字（P74r18b）。 */
export const OUTBOX_ERROR_CLIP_CHARS = 200;

/**
 * 给员工看的错误输出（P74r18b）：取错误输出的前 200 字，换行折成空格。
 * 出站记录的结果文字写法是「{失败原因}：{错误输出}」（命令类）；这里把前面那段失败原因拿掉，只留错误输出本身，
 * 没有错误输出时退回失败原因，再没有写「没有错误输出」。
 */
export function outboxErrorText(row: OutboxAction): string {
  const result = row.result ?? '';
  const reason = row.ownerFailureReason;
  const stderr = reason && result.startsWith(`${reason}：`) ? result.slice(reason.length + 1) : result;
  const flat = stderr.replace(/\s+/g, ' ').trim() || reason || '没有错误输出';
  return Array.from(flat).slice(0, OUTBOX_ERROR_CLIP_CHARS).join('');
}

/**
 * 给提交这条动作的员工看的唤醒原因（P74r18b 第 3 节，逐字）：
 * 成功 `你提交的动作已由中心运行成功：{说明}。`；失败 `你提交的动作由中心运行失败：{说明}。错误：{错误}。`
 * 说明取主人批准时看到的那一句（approvedActionText），没有时退回 describeAction。
 */
export function outboxWakeReason(row: OutboxAction, action: string): string {
  return row.status === 'done' ? `你提交的动作已由中心运行成功：${action}。`
    : `你提交的动作由中心运行失败：${action}。错误：${outboxErrorText(row)}。`;
}

/** 系统感知用于汇总执行事实，不附加审批指令，也不复制外部返回内容。 */
export function outboxOwnerResult(row: OutboxAction, commandMaxChars?: number, ownerAction?: string): string {
  const action = ownerAction ?? describeAction('hub_outbox_execute', row, commandMaxChars);
  return formatActionResult(action, row.status === 'done' ? '已完成'
    : row.executionStarted === false ? `未执行：${outboxFailureReason(row)}` : `执行失败：${outboxFailureReason(row)}`);
}

/** 已批准动作的线程和实时状态共用完整结果，明确区分未执行与执行失败。 */
export function approvedOutboxResult(row: OutboxAction, commandMaxChars?: number, ownerAction?: string): string {
  const action = ownerAction ?? describeAction('hub_outbox_execute', row, commandMaxChars);
  if (row.executionStarted === false) return `未执行你批准的：${action}（原因：${outboxFailureReason(row)}）`;
  const success = row.kind === 'http_post' ? /^HTTP \d+/.exec(row.result ?? '')?.[0] ?? '网络请求已完成'
    : row.kind === 'run_command' ? '命令执行完成' : row.kind === 'write_file' ? '文件已写入' : '汇报已进入线程';
  return formatActionResult(`已执行你批准的：${action}`, row.status === 'done' ? `已完成（${success}）` : `失败：${outboxFailureReason(row)}`);
}
