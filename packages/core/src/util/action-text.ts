/** 把工具参数翻成主人能理解的动作；原始参数仍保留在审批记录里供核对，不参与执行或权限判断。 */
import { C03_DEFAULTS } from '../config/defaults.js';
import type { Approval } from '../model/outreach.js';
import { COMMAND_ARGUMENT_KEYS, PATH_ARGUMENT_KEYS, commandTargets, editTargetPaths, pathArguments, selectedCommand } from '../gate/tool-targets.js';

/** 仅取对象中的文本字段，坏旧档也能显示明确的缺失提示。 */
function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringField(args: Record<string, unknown>, ...keys: string[]): string {
  return keys.map(key => args[key]).find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? '';
}
/** 动作摘要保持单行，命令按完整字符截取，避免把参数里的换行变成卡片结构。 */
function oneLine(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
function domain(value: string): string {
  try { return new URL(value).hostname || '指定地址'; } catch { return '指定地址'; }
}
/** 宿主只报告工具名而没有完整参数时，只描述动作种类，不能虚构目标或回显内部工具名。 */
export function toolActionLabel(tool: string): string {
  if (['bash', 'exec', 'run_command', 'shell', 'exec_command'].includes(tool)) return '运行命令';
  if (['write', 'write_file'].includes(tool)) return '写入文件';
  if (['edit', 'edit_file', 'apply_patch'].includes(tool)) return '修改文件';
  if (['read', 'read_file', 'read_image', 'list_directory', 'list_files', 'search_files', 'glob', 'grep', 'present'].includes(tool)) return '读取文件';
  if (tool === 'web_fetch') return '访问网页';
  if (tool === 'web_search') return '搜索网页';
  if (tool === 'hub_outbox_execute') return '执行出站动作';
  return '执行工具动作';
}
function command(args: Record<string, unknown>, maxChars: number): string {
  const targets = commandTargets(args);
  const values = selectedCommand(args) ? targets : ['（未提供可确定的命令）', ...targets];
  return targetList(values.map(value => Array.from(oneLine(value)).slice(0, maxChars).join('')));
}
/** 各个目标分别截取后再列出，长诱饵不能把另一条真实路径挤出标题。 */
function targetList(values: string[]): string {
  return values.length > 1 ? `${values[0]}（另含 ${values.slice(1).join('、')}）（参数含多个目标）` : values[0] ?? '';
}
function paths(args: Record<string, unknown>, edit = false): string {
  const values = [...new Set(edit ? editTargetPaths(args) : pathArguments(args))];
  return targetList(values.map(value => ownerParameterPreview(oneLine(value), C03_DEFAULTS.approvalOwnerParamsMaxChars))) || '（未提供路径）';
}
/** 常见 DSH 工具及四类中心出站动作共用一套人话描述，标题、决定和执行结果不会各说各话。 */
export function describeAction(tool: string, input: unknown, commandMaxChars: number = C03_DEFAULTS.actionCommandMaxChars): string {
  const args = fields(input);
  if (tool === 'hub_outbox_execute') {
    const payload = fields(args.payload);
    if (args.kind === 'notify_owner') return '发通知';
    if (args.kind === 'write_file') return `写文件 ${paths(payload)}`;
    if (args.kind === 'http_post') return `向 ${domain(stringField(payload, 'url'))} 发送网络请求`;
    if (args.kind === 'run_command') return `运行命令 ${command(payload, commandMaxChars)}`;
    return '执行出站动作';
  }
  if (['bash', 'exec', 'run_command', 'shell', 'exec_command'].includes(tool)) return `运行命令 ${command(args, commandMaxChars)}`;
  if (['write', 'write_file', 'edit', 'edit_file', 'apply_patch'].includes(tool)) {
    const edit = tool.startsWith('edit') || tool === 'apply_patch';
    return `${edit ? '修改' : '写入'}文件 ${paths(args, edit)}`;
  }
  if (tool === 'web_fetch') return `访问 ${domain(stringField(args, 'url'))}`;
  return `执行 ${oneLine(tool)}`;
}
/** 新记录有版本证明按全部目标生成；旧摘要可能遗漏危险目标，必须重算，截断旧参数只显示通用动作。 */
export function approvalActionText(row: Approval, commandMaxChars: number = C03_DEFAULTS.actionCommandMaxChars): string {
  if (row.actionTextVersion === 2 && row.actionText) return row.actionText;
  try { return describeAction(row.tool, JSON.parse(row.argsPreview), commandMaxChars); }
  catch {
    if (['bash', 'exec', 'run_command', 'shell', 'exec_command'].includes(row.tool)) return '运行一条命令（完整参数见末行）';
    if (['write', 'write_file'].includes(row.tool)) return '写入文件（路径见末行）';
    if (['edit', 'edit_file', 'apply_patch'].includes(row.tool)) return '修改文件（路径见末行）';
    return describeAction(row.tool, {}, commandMaxChars);
  }
}
/** 卡片创建、旧单刷新与只读投影共用正文；参数原文始终位于末行，避免重算时残留旧诱饵描述。 */
export function approvalDisplayText(row: Approval, commandMaxChars: number = C03_DEFAULTS.actionCommandMaxChars,
  parameterMaxChars: number = C03_DEFAULTS.approvalOwnerParamsMaxChars, parameters = row.argsPreview): { title: string; body: string } {
  const action = approvalActionText(row, commandMaxChars);
  // 该帮助函数同时服务审批落表和只读投影，确保重新打开旧卡片也不丢失宿主权限提醒。
  let hostCommand = row.tool === 'hub_outbox_execute' && action.startsWith('运行命令');
  try { hostCommand ||= row.tool === 'hub_outbox_execute' && fields(JSON.parse(parameters)).kind === 'run_command'; } catch { /* 截断旧参数时按可信动作摘要判断。 */ }
  const sandboxNotice = hostCommand ? '\n这条命令在 DSH 沙箱之外运行，能改动这台电脑上的其他文件。看不懂就拒绝。' : '';
  return { title: `批准：${action}`,
    body: `${action}\n${row.actionClass} 类：${row.why}${sandboxNotice}\n原始参数（供核对）：${ownerParameterPreview(parameters, parameterMaxChars)}` };
}
/** 单项首尾截断；多目标预览也复用它，不能只留下命令或路径的无害开头。 */
function clipEdges(value: string, maxChars: number): string {
  const chars = Array.from(value.replaceAll('\n', '\\n').replaceAll('\r', '\\r'));
  if (chars.length <= maxChars) return chars.join('');
  const mark = '…中间省略…';
  if (maxChars <= Array.from(mark).length) return Array.from(mark).slice(0, Math.max(0, maxChars)).join('');
  const remaining = Math.max(0, maxChars - Array.from(mark).length);
  const tail = Math.floor(remaining / 2);
  return `${chars.slice(0, Math.ceil(remaining / 2)).join('')}${mark}${tail ? chars.slice(-tail).join('') : ''}`;
}
/** 提取会影响动作目标的原参数字段；payload 内的出站参数也优先于正文。 */
function targetParameters(value: unknown, prefix = ''): string[] {
  const args = fields(value);
  const keys = [...PATH_ARGUMENT_KEYS, 'url', ...COMMAND_ARGUMENT_KEYS, 'args', 'cwd', 'workdir'];
  return [...keys.flatMap(key => key in args ? [`${prefix}${key}:${JSON.stringify(args[key])}`] : []),
    ...(args.payload ? targetParameters(args.payload, `${prefix}payload.`) : [])];
}
/** 原始参数末行最多指定字数；长正文先让位给路径、URL、命令，并给每个目标保留首尾。 */
export function ownerParameterPreview(value: string, maxChars: number): string {
  if (Array.from(value.replaceAll('\n', '\\n').replaceAll('\r', '\\r')).length <= maxChars) return clipEdges(value, maxChars);
  let targets: string[];
  try { targets = targetParameters(JSON.parse(value)); } catch { return clipEdges(value, maxChars); }
  if (!targets.length) return clipEdges(value, maxChars);
  const separator = '；';
  const room = Math.max(0, maxChars - (targets.length - 1) * Array.from(separator).length);
  const budget = Math.floor(room / targets.length);
  const preview = targets.map((target, index) => clipEdges(target, budget + (index < room % targets.length ? 1 : 0))).join(separator);
  // 极小自定义上限时，分隔符本身也要受限；余下空间再保留非目标原文供核对。
  if (Array.from(preview).length >= maxChars) return clipEdges(preview, maxChars);
  const suffix = '；其余参数：';
  const remaining = maxChars - Array.from(preview + suffix).length;
  return remaining > 0 ? `${preview}${suffix}${clipEdges(value, remaining)}` : preview;
}
