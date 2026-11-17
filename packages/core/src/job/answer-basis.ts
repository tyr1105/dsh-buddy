/**
 * 回答的「约定出处」（P74e，方案 5.2.1）：由中心从约定里读出原文并拼成一句话，模型写不进。
 *
 * 为什么由中心拼：总管回答执行者的问题时，如果出处是模型自己写的，就可能编出约定里没有的条目，
 * 让执行者以为「约定里写过」。这里只接受「约定的哪一部分、第几条」，中心去约定里取原文：
 * 引用不存在的条目一律拒绝，并列出每一部分有几条，模型改正后再来。约定里推不出答案的问题，没有出处可引用，
 * 总管不能编一个，只能走「改约定」的路径（守则第 11 条）。
 *
 * 全部是纯函数：输入约定内容，输出文字；不读存储、不碰时钟。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { AgreementContent } from '../model/agreement.js';
import { joinQuestion } from '../util/question-join.js';

/** 约定里可以引用的六个部分。 */
export const BASIS_SECTIONS = ['summary', 'pending', 'decided', 'scopeIn', 'scopeOut', 'doneWhen'] as const;
export type BasisSection = (typeof BASIS_SECTIONS)[number];

/** 部分的中文名（与约定卡、主题文件里的小标题一致）。 */
export const BASIS_SECTION_LABELS: Record<BasisSection, string> = {
  summary: '一句话', pending: '待你定', decided: '我已定的', scopeIn: '这次做', scopeOut: '这次不做', doneWhen: '怎样算做完',
};

/** 约定条目的一处出处：约定的哪一部分、第几条。 */
export interface AgreementBasisArg { section: BasisSection; no: number }
/** 主人转来的材料的一处出处（P74r2d）：title 必须是这件事材料文件夹里已有的一份（不含 .md）。 */
export interface MaterialBasisArg { section: 'material'; title: string }
/** 模型给的一处出处：约定的条目，或主人转来的材料。 */
export type BasisArg = AgreementBasisArg | MaterialBasisArg;

/** 只引用「一句话」时的拒绝文字（P74r2d）：一句话只是复述，推不出具体答案，不能当唯一出处。 */
export const SUMMARY_ONLY_BASIS_TEXT = 'basis：不能只引用「一句话」。要有具体的条目或主人提供的材料能推出答案；推不出时用 hub_agreement_submit 的 mode revise 出新版本请主人确认。';

/** 出处是不是只有「一句话」（至少 1 处，且每一处都是 summary）。 */
export function isSummaryOnlyBasis(basis: readonly BasisArg[]): boolean {
  return basis.length > 0 && basis.every(item => item.section === 'summary');
}

/** 引用原文最多显示几个字，超过截断并加「…」。 */
export const BASIS_QUOTE_MAX_CHARS = 40;

/** 某一部分的全部原文（序号从 1 起，与主题文件夹里的「约定.md」一致）。待你定写「{问题}：{主人定下的选项}」。 */
function sectionRows(content: AgreementContent, section: BasisSection): string[] {
  switch (section) {
    case 'summary': return [content.summary];
    case 'pending': return content.pending.map(item => joinQuestion(item.question, item.chosen ?? item.suggested));
    case 'decided': return content.decided.map(item => item.text);
    case 'scopeIn': return [...content.scopeIn];
    case 'scopeOut': return [...content.scopeOut];
    case 'doneWhen': return [...content.doneWhen];
  }
}

/** 按完整字符截断，超过上限加「…」。 */
export function clipQuote(text: string, max: number = BASIS_QUOTE_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, max).join('')}…`;
}

/**
 * 检查每一处出处都真实存在；不存在的一次列全。返回错误文字（通过返回 null）。
 * 文字形如「basis[1]：约定「我已定的」只有 3 条」，序号从 0 起（与参数数组下标一致）。
 */
export function basisProblems(content: AgreementContent, basis: readonly BasisArg[], materials: readonly string[] = []): string | null {
  const problems: string[] = [];
  basis.forEach((item, index) => {
    if (item.section === 'material') {
      // 主人转来的材料：标题必须是材料文件夹里已有的一份；不存在时列出现有的标题。
      if (!materials.includes(item.title)) {
        problems.push(`basis[${index}]：这件事没有名为「${item.title}」的材料。${materials.length === 0 ? '现在没有主人转来的材料' : `现有的材料：${materials.map(title => `「${title}」`).join('、')}`}`);
      }
      return;
    }
    const count = sectionRows(content, item.section).length;
    if (!Number.isInteger(item.no) || item.no < 1 || item.no > count) {
      problems.push(`basis[${index}]：约定「${BASIS_SECTION_LABELS[item.section]}」只有 ${count} 条`);
    }
  });
  return problems.length === 0 ? null : problems.join('\n');
}

/** 可引用的出处一览：每部分的名字和条数，引用被拒时列给模型看（section 写英文名，no 在条数范围内）；有材料时再列材料的标题。 */
export function availableBasisText(content: AgreementContent, materials: readonly string[] = []): string {
  const rows = BASIS_SECTIONS.map(section => `${section}（${BASIS_SECTION_LABELS[section]}）${sectionRows(content, section).length} 条`);
  const files = materials.length === 0 ? '' : `、material（主人转来的材料，title 写材料标题）：${materials.map(title => `「${title}」`).join('、')}`;
  return `可引用的出处：${rows.join('、')}${files}`;
}

/** 一处出处的文字：约定「{部分}」第 {no} 条（{原文}），或主人提供的材料「{title}」。调用前须已通过 basisProblems。 */
function citation(content: AgreementContent, item: BasisArg, quoteMax: number): string {
  if (item.section === 'material') return `主人提供的材料「${item.title}」`;
  const text = sectionRows(content, item.section)[item.no - 1]!;
  return `约定「${BASIS_SECTION_LABELS[item.section]}」第 ${item.no} 条（${clipQuote(text, quoteMax)}）`;
}

/** 多处出处连接：两条用「和」，三条前两条用顿号。 */
export function joinCitations(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join('、')}和${parts[parts.length - 1]!}`;
}

/** 完整的出处句：「依据：……。」后面接固定的一句「这一点不改约定，不需要问主人。」 */
export function basisSentence(content: AgreementContent, basis: readonly BasisArg[], quoteMax: number = BASIS_QUOTE_MAX_CHARS): string {
  return `依据：${joinCitations(basis.map(item => citation(content, item, quoteMax)))}。\n这一点不改约定，不需要问主人。`;
}

/**
 * 去掉模型自己写在答案里的「依据：……」：依据只能来自约定，由中心拼在后面，答案里不能再有第二份。
 * 做法：逐行处理，从该行第一个「依据：」（含前面的括号）起，到行尾全部删掉；删完为空的行丢弃。
 * 同时去掉模型自己写的「这一点不改约定，不需要问主人。」，避免重复。
 */
export function stripSelfWrittenBasis(text: string): string {
  const kept: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const cut = rawLine.search(/[（(]?\s*依据\s*[：:]/);
    const line = (cut === -1 ? rawLine : rawLine.slice(0, cut)).replace('这一点不改约定，不需要问主人。', '').trim();
    if (line !== '') kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 拼出完整回答：{答案}\n依据：{出处}。\n这一点不改约定，不需要问主人。
 * 事件日志的附带内容有字节上限（2 KB）：太长时依次把引用原文缩短到 20、10 个字；仍超过由调用方报错让总管缩短答案。
 */
export function composeAnswer(content: AgreementContent, text: string, basis: readonly BasisArg[], maxBytes: number = D.EVENT_DATA_MAX_BYTES - 300): string | null {
  const body = stripSelfWrittenBasis(text);
  if (body === '') return null;
  for (const quoteMax of [BASIS_QUOTE_MAX_CHARS, 20, 10]) {
    const full = `${body}\n${basisSentence(content, basis, quoteMax)}`;
    if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;
  }
  return `${body}\n${basisSentence(content, basis, 10)}`;
}
