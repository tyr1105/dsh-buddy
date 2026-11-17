/**
 * 审批卡上给主人看的那句话（P69 A8）。
 *
 * 为什么单独一个文件：以前审批卡第一行是「运行命令 <原始命令>」，主人看不懂也不想看。
 * 现在按分类结果（审批单上存的 asks）说成大白话，原始命令只留在审批记录的 argsPreview 里，
 * 由界面放在「查看原始命令」后面。这里只放纯函数，不碰存储，方便单测。
 *
 * 规则（任务卡 A8 + 总控裁定第 3 条 + A-4 裁定 S4 到 S7、S13）：
 * - 命令类：每一件要确认的事各说一句，D 类排在最前、永不省略。D 类用现有的理由文案（删除类带上路径，说「不可逆」）；
 *   A3 名单里的子类用 outwardSentence（带对象）；写到工作区外的带上路径；下载的脚本、看不见内容的脚本、
 *   沙箱管不到的程序、碰到中心管理的文件各有专门说法（靠分类器给的 hint 标记）；归不了类的写「运行一条需要你确认的命令」。
 *   太长时不直接截字：列出放得下的几件，再用「……等 N 件」收尾。
 * - 出站动作：write_file「在工作区之外写文件：真实路径」，http_post「向 域名 发送数据」，
 *   run_command「请中心代为运行一条命令」（M12 的风险提示另存 riskNote，原样保留）。
 *   出站动作里有 D 类时，句子以 D 的理由开头，用「；」接原来那句。
 * - 其他工具（写文件、改文件、访问网页等）沿用 describeAction 的现有写法。
 * - 句子里不放原始命令。
 */
import type { ApprovalAsk } from '../model/outreach.js';
import { WAKE_KIND_LABELS, type WakeKind } from '../model/enums.js';
import { DANGER_SENTENCES, isOutwardSubclass, outwardSentence } from '../gate/outward-commands.js';
import { posix } from 'node:path';
import { describeAction, clipEdges } from './action-text.js';
import { safeObject } from '../gate/outward-commands.js';
import { PATH_SENTENCE_MAX_CHARS, SENTENCE_MAX_CHARS, SENTENCE_TAIL_RESERVE } from './approval-sentence-limits.js';

/** 审批单文案版本：3 表示 actionText 是这里生成的主人话；2 是旧版按目标生成的描述；缺省是更早的旧档。 */
export const APPROVAL_TEXT_VERSION = 3;
/**
 * M12 加的风险提示：中心代跑的命令在受限沙箱里，不确定作用就拒绝。界面单独显示。P74r13：末句由口语「看不懂就拒绝」改为书面表达。
 * P74r18b：可写范围改由 gate/host-writable.ts 的同一份清单生成（点名员工、按有没有项目写「项目文件夹」），不再有固定常量。
 */
export { hostCommandRiskNote } from '../gate/host-writable.js';
/** 归不了类的命令说法。 */
export const UNCLASSIFIED_COMMAND_SENTENCE = '运行一条需要你确认的命令';
/** 出站 run_command 的说法（总控裁定第 3 条）。 */
export const HOST_COMMAND_SENTENCE = '请中心代为运行一条命令';

const COMMAND_TOOLS = ['bash', 'exec', 'run_command', 'shell', 'exec_command'];
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();
const clip = (value: string, max: number): string => Array.from(value).slice(0, max).join('');

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function hostOf(value: unknown): string {
  try { return typeof value === 'string' ? new URL(value).hostname || '外部网址' : '外部网址'; } catch { return '外部网址'; }
}
/** 家目录写成 ~，主人一眼认得出是自己电脑上的哪里。 */
function tilde(path: string, ownerHome?: string): string {
  const home = ownerHome?.replace(/\/+$/, '');
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** 这个出站参数是不是中心代跑的命令（用来决定要不要存 M12 风险提示）。 */
export function isHostCommand(tool: string, args: unknown): boolean {
  return tool === 'hub_outbox_execute' && fields(args).kind === 'run_command';
}

/** 看不见内容的脚本的说法（下载来的但取不到主机名、来自文件或管道的，都用它）。 */
export const BLIND_SCRIPT_SENTENCE = '运行一段中心看不到内容的脚本';
/** 看不懂的命令碰到中心管理的文件的说法。 */
export const MANAGED_FILES_SENTENCE = '运行一条可能改动工作日志或身份文件的命令';

/**
 * 给主人看的路径（A-4，S6、S7）：先规范化（折叠 .. 和 .，让「Desktop/…/../../Library/LaunchAgents」显出真实落点），
 * 再把主人家目录写成 ~；太长时保留开头和结尾（文件名和它所在的目录一定看得到）。
 */
function shownPath(path: string, ownerHome?: string): string {
  const flat = oneLine(path);
  const normalized = flat.startsWith('/') || flat.startsWith('~') ? posix.normalize(flat) : flat;
  return clipEdges(tilde(normalized, ownerHome), PATH_SENTENCE_MAX_CHARS);
}
/** 多个路径：列前两个，后面写「等 N 处」（N 是总数）。 */
function pathList(paths: readonly string[], ownerHome?: string): string {
  const shown = paths.slice(0, 2).map(path => shownPath(path, ownerHome)).join('、');
  return paths.length > 2 ? `${shown} 等 ${paths.length} 处` : shown;
}

/**
 * D 类（不可逆）那一件事给主人看的话（A-5，P1）：靠分类器的 hint 标记查表，不去匹配理由文字。
 * 带路径的两种（删除、写系统目录）在后面接上路径。没有标记的 D（旧审批单、以后新增而没配话的）照旧显示分类器的理由。
 */
export function dangerSentence(ask: Pick<ApprovalAsk, 'hint' | 'reason' | 'paths'>, ownerHome?: string): string {
  const hint = ask.hint;
  if (hint === 'delete') return ask.paths?.length ? `删除 ${pathList(ask.paths, ownerHome)}（不可逆）` : DANGER_SENTENCES.delete;
  if (hint === 'system_write') return ask.paths?.length ? `${DANGER_SENTENCES.system_write}：${pathList(ask.paths, ownerHome)}` : DANGER_SENTENCES.system_write;
  if (hint !== undefined && Object.prototype.hasOwnProperty.call(DANGER_SENTENCES, hint)) return DANGER_SENTENCES[hint as keyof typeof DANGER_SENTENCES];
  return ask.paths?.length ? `${ask.reason}：${pathList(ask.paths, ownerHome)}` : ask.reason;
}

/** 命令里某一件要确认的事，说成一句话。D 类句子永远是 D 的主人话。 */
function askSentence(ask: ApprovalAsk, ownerHome?: string): string {
  if (ask.cls === 'D') {
    return dangerSentence(ask, ownerHome);
  }
  if (isOutwardSubclass(ask.subclass)) return outwardSentence(ask.subclass, ask.detail, ask.download === true);
  // 下面几类靠 hint 标记认；对象（主机名、程序名）显示前按 SAFE_OBJECT 的规矩再校验一遍，不合规就当没有。
  if (ask.hint === 'remote_script') {
    const host = safeObject(ask.detail);
    return host ? `运行从 ${host} 下载的脚本` : BLIND_SCRIPT_SENTENCE;
  }
  if (ask.hint === 'blind_script') return BLIND_SCRIPT_SENTENCE;
  if (ask.hint === 'sandbox_escape') {
    const program = safeObject(ask.detail);
    return program ? `运行 ${program} 命令（它在沙箱之外执行）` : UNCLASSIFIED_COMMAND_SENTENCE;
  }
  if (ask.hint === 'managed_files') return MANAGED_FILES_SENTENCE;
  if (ask.subclass === 'write_file' && ask.paths?.length) return `在工作区之外写文件：${pathList(ask.paths, ownerHome)}`;
  return UNCLASSIFIED_COMMAND_SENTENCE;
}

/**
 * 「写到工作区外」的几件事合成一件，路径合并去重（A-4，S7）。分类器对 cp a.html 目标 会把目标当文件和当文件夹各判一次，
 * 目标和「目标/a.html」会各出一件；说给主人听只需要一句，并且丢掉落在别的路径里面的那个。合并后放在第一件所在的位置。
 */
function mergeWrites(asks: readonly ApprovalAsk[]): ApprovalAsk[] {
  const isWrite = (ask: ApprovalAsk): boolean => ask.cls === 'C' && ask.hint === undefined && !isOutwardSubclass(ask.subclass) && ask.subclass === 'write_file' && !!ask.paths?.length;
  const merged = asks.filter(isWrite).flatMap(ask => ask.paths!);
  if (merged.length < 2) return [...asks];
  const flat = [...new Set(merged)];
  const top = flat.filter(path => !flat.some(other => other !== path && path.startsWith(`${other.replace(/\/+$/, '')}/`)));
  let placed = false;
  const out: ApprovalAsk[] = [];
  for (const ask of asks) {
    if (!isWrite(ask)) { out.push(ask); continue; }
    if (placed) continue;
    placed = true;
    out.push({ ...ask, paths: top });
  }
  return out;
}

/**
 * 把命令里的待确认事项连成一句话（A-4，S4）。D 类排在最前、永不省略；C 类按出现顺序放，
 * 放不下就停，用「……等 N 件」收尾（N 包括因为条数上限没存下来的）。总长不超过上限，只有 D 类自己超长时才例外。
 */
function joinAsks(rawAsks: readonly ApprovalAsk[], ownerHome?: string): string {
  const asks = mergeWrites(rawAsks);
  const unique = (list: readonly ApprovalAsk[]): string[] => {
    const out: string[] = [];
    for (const ask of list) { const one = askSentence(ask, ownerHome); if (!out.includes(one)) out.push(one); }
    return out;
  };
  const dangerous = unique(asks.filter(ask => ask.cls === 'D'));
  const ordinary = unique(asks.filter(ask => ask.cls !== 'D')).filter(one => !dangerous.includes(one));
  const beyond = asks.reduce((sum, ask) => sum + (ask.moreAfter ?? 0), 0);
  if (!dangerous.length && !ordinary.length) return UNCLASSIFIED_COMMAND_SENTENCE;
  const all = [...dangerous, ...ordinary];
  if (beyond === 0 && Array.from(all.join('；')).length <= SENTENCE_MAX_CHARS) return all.join('；');
  const kept = [...dangerous];
  let used = Array.from(kept.join('；')).length;
  for (const one of ordinary) {
    // 留出收尾那一段的位置：还有没放进来的，就必须写得出「等 N 件」。
    if (used + 1 + Array.from(one).length + SENTENCE_TAIL_RESERVE > SENTENCE_MAX_CHARS) break;
    kept.push(one);
    used += 1 + Array.from(one).length;
  }
  // 一件也放不下（第一句本身就很长）时，截它的开头保证有话可说，剩下的算进「等 N 件」。
  if (!kept.length) kept.push(clip(all[0]!, SENTENCE_MAX_CHARS - SENTENCE_TAIL_RESERVE));
  const left = all.length - kept.length + beyond;
  return left > 0 ? `${kept.join('；')}；……等 ${left} 件` : kept.join('；');
}

/**
 * 生成那一句话。asks 为 undefined 表示调用方没有分类结果（老的调用方式），此时返回 null，
 * 由调用方沿用旧写法并保持旧版本号，不冒充新版。
 */
export function ownerApprovalSentence(tool: string, args: unknown, asks: readonly ApprovalAsk[] | undefined,
  opts: { ownerHome?: string; commandMaxChars: number }): string | null {
  const input = fields(args);
  if (tool === 'hub_outbox_execute') {
    const payload = fields(input.payload);
    // A-4（S5）：出站动作里有 D 类时，D 的理由放在最前面（A-5：用 D 的主人话），后面接原来那句。
    // A-5：D 的话用同一张主人话表（没有标记的旧单子仍是分类器的理由）。
    const dangerReasons = [...new Set((asks ?? []).filter(ask => ask.cls === 'D').map(ask => dangerSentence(ask, opts.ownerHome)))];
    const withDanger = (sentence: string): string => dangerReasons.length ? `${dangerReasons.join('；')}；${sentence}` : sentence;
    if (input.kind === 'run_command') return withDanger(HOST_COMMAND_SENTENCE);
    if (input.kind === 'write_file') {
      return withDanger(typeof payload.path === 'string' && payload.path.trim() ? `在工作区之外写文件：${shownPath(payload.path, opts.ownerHome)}` : '在工作区之外写文件');
    }
    if (input.kind === 'http_post') return withDanger(`向 ${hostOf(payload.url)} 发送数据`);
    return describeAction(tool, args, opts.commandMaxChars);
  }
  if (COMMAND_TOOLS.includes(tool)) {
    if (asks === undefined) return null;
    return joinAsks(asks, opts.ownerHome);
  }
  return asks === undefined ? null : describeAction(tool, args, opts.commandMaxChars);
}

/**
 * 「为什么」：队友自己写了 why 就用它；没有就用它此刻在做的事——所在项目会话的标题，
 * 或这次唤醒的类别（固定短句，不直接用唤醒摘要，那里可能夹着外部文字）；都取不到返回 undefined。
 */
export function ownerReasonText(input: { ownerWhy?: string; topicTitle?: string; wakeKind?: WakeKind }): string | undefined {
  const why = input.ownerWhy ? clip(oneLine(input.ownerWhy), 200) : '';
  if (why) return why;
  if (input.topicTitle?.trim()) return `正在处理项目会话「${clip(oneLine(input.topicTitle), 40)}」`;
  if (input.wakeKind) return `处理「${WAKE_KIND_LABELS[input.wakeKind]}」时提出`;
  return undefined;
}
