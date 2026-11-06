/** 出站结果的主人文案统一由中心事实生成；外部响应正文只留在原结果和模型的不可信证据区。 */
import type { OutboxAction } from '../model/outreach.js';
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

/** 系统感知用于汇总执行事实，不附加审批指令，也不复制外部返回内容。 */
export function outboxOwnerResult(row: OutboxAction, commandMaxChars?: number): string {
  const action = describeAction('hub_outbox_execute', row, commandMaxChars);
  return formatActionResult(action, row.status === 'done' ? '已完成'
    : row.executionStarted === false ? `未执行：${outboxFailureReason(row)}` : `执行失败：${outboxFailureReason(row)}`);
}

/** 已批准动作的线程和实时状态共用完整结果，明确区分未执行与执行失败。 */
export function approvedOutboxResult(row: OutboxAction, commandMaxChars?: number): string {
  const action = describeAction('hub_outbox_execute', row, commandMaxChars);
  if (row.executionStarted === false) return `未执行你批准的：${action}（原因：${outboxFailureReason(row)}）`;
  const success = row.kind === 'http_post' ? /^HTTP \d+/.exec(row.result ?? '')?.[0] ?? '网络请求已完成'
    : row.kind === 'run_command' ? '命令执行完成' : row.kind === 'write_file' ? '文件已写入' : '汇报已进入线程';
  return formatActionResult(`已执行你批准的：${action}`, row.status === 'done' ? `已完成（${success}）` : `失败：${outboxFailureReason(row)}`);
}
