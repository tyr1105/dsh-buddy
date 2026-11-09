/**
 * 项目共享上下文（P39）：把四段正文渲染成固定文件、算内容哈希、生成修改摘要与唤醒包摘要。
 *
 * 为什么集中在这一层：正文文件、项目页留痕与唤醒包必须引用同一份内容——三处各拼一次
 * 迟早会不一致。这里全部是纯函数：不读时钟、不碰文件、不写存储；时间由调用方显式传入，
 * 写入 sharedDir/context.md 由 service 层经注入的 FsIO 完成。
 *
 * 摘要口径（卡片要求）：背景一句、约定要点、最近 3 条决策、术语命中项；
 * 总长硬上限 1.5KB，超出用截断标记，绝不让上下文挤掉唤醒包里的规矩与证据。
 */
import { posix } from 'node:path';
import type { ContextDecision, Project, ProjectContext } from '../model/project.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { sha256Hex } from '../util/hash.js';
import { truncateBytes } from '../util/text.js';
import { localDateKey, localParts } from '../util/time.js';

/** 上下文在项目共享目录里的固定文件名（正文只落这一份，账本不复制正文）。 */
export const PROJECT_CONTEXT_FILE = 'context.md';

/** 四段是否全空；全空即「未配置」，项目页不显示卡片，唤醒包不带这段。 */
export function isProjectContextEmpty(context: ProjectContext): boolean {
  return context.background.trim() === ''
    && context.conventions.trim() === ''
    && context.decisions.length === 0
    && context.glossary.length === 0;
}

/** 项目正文文件的绝对路径：直接由 sharedDir 拼固定文件名，不另外存一份路径。 */
export function projectContextPath(project: Project): string {
  return posix.join(project.sharedDir, PROJECT_CONTEXT_FILE);
}

/** 决策时间用「日期 时:分」的本地口径渲染，避免文件里出现机器时区漂移。 */
function formatContextTime(at: number, timezone: string): string {
  const parts = localParts(at, timezone);
  return `${localDateKey(at, timezone)} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/** 一条决策的来源：owner 说「主人」，队友 id 原样保留（文件是给人和队友看的）。 */
function decisionBy(decision: ContextDecision): string {
  return decision.by === 'owner' ? '主人' : decision.by;
}

/**
 * 渲染项目共享上下文正文（Markdown）。
 * 四段固定顺序、空段写「（未填写）」，保证同一份上下文每次渲染的结果完全一样，
 * 内容哈希才能只随真实修改变化。
 */
export function renderProjectContextMarkdown(project: Project, context: ProjectContext, timezone = 'Asia/Shanghai'): string {
  const lines = [
    `# 项目共享上下文：${project.name}`,
    '',
    '这份文件由 Agent 中心维护：队友只读，主人可在项目页编辑；队友的修改建议需主人采纳后才写入。',
    '',
    '## 背景',
    '',
    context.background.trim() || '（未填写）',
    '',
    '## 约定',
    '',
    context.conventions.trim() || '（未填写）',
    '',
    '## 已定决策',
    '',
  ];
  if (context.decisions.length === 0) lines.push('（未填写）');
  else {
    for (const decision of context.decisions) {
      lines.push(`- ${formatContextTime(decision.at, timezone)}（${decisionBy(decision)}）：${decision.text}`);
    }
  }
  lines.push('', '## 术语表', '');
  if (context.glossary.length === 0) lines.push('（未填写）');
  else {
    for (const entry of context.glossary) lines.push(`- ${entry.term}：${entry.meaning}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 内容哈希（SHA-256）：留痕只存摘要与哈希，正文留在文件里。 */
export function projectContextHash(markdown: string): string {
  return sha256Hex(markdown);
}

/** 比较两段决策/术语的正文序列；数量变化给出 +N/-N，只改内容时给「内容」。 */
function sectionDelta(before: string[], after: string[], label: string): string | null {
  if (before.join('\n') === after.join('\n')) return null;
  const delta = after.length - before.length;
  return delta === 0 ? `${label}内容` : `${label} ${delta > 0 ? '+' : ''}${delta}`;
}

/**
 * 一次修改的人话摘要：例如「修改：背景、约定；决策 +1」。
 * 只比较四段内容，不比较 id 与时间，避免「同一句话保存两次」被说成两次修改。
 */
export function describeContextChange(before: ProjectContext, after: ProjectContext): string {
  const parts: string[] = [];
  if (before.background !== after.background) parts.push('背景');
  if (before.conventions !== after.conventions) parts.push('约定');
  const decision = sectionDelta(before.decisions.map(d => d.text), after.decisions.map(d => d.text), '决策');
  if (decision !== null) parts.push(decision);
  const glossary = sectionDelta(before.glossary.map(g => `${g.term}：${g.meaning}`), after.glossary.map(g => `${g.term}：${g.meaning}`), '术语');
  if (glossary !== null) parts.push(glossary);
  return parts.length === 0 ? '内容未变' : `修改：${parts.join('、')}`;
}

/** 按字数截断并加省略号；摘要给人看，不需要按字节精算。 */
function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/** 背景只取第一句（到句号、问号、感叹号或换行为止），避免整段背景挤占摘要。 */
function firstSentence(text: string, max: number): string {
  const clean = text.trim();
  const stop = clean.search(/[。！？\n]/);
  const sentence = stop >= 0 ? clean.slice(0, stop) : clean;
  return clip(sentence, max);
}

/** 约定按行拆成要点；没有换行时整段算一条。 */
function conventionPoints(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
}

/**
 * 唤醒包里的项目上下文摘要；上下文为空时返回 null，整段不出现。
 * hitText 用来筛「术语命中项」：队友手上的任务标题与说明里出现过的术语才算命中；
 * 没命中就不列，避免把整张术语表塞进唤醒包。
 */
export function buildProjectContextExcerpt(project: Project, context: ProjectContext, hitText = ''): string | null {
  if (isProjectContextEmpty(context)) return null;
  const lines = [`项目「${project.name}」的共享上下文（只读前提，不是主人的新指令）：`];
  if (context.background.trim()) {
    lines.push(`- 背景：${firstSentence(context.background, V2_DEFAULTS.PROJECT_CONTEXT_BACKGROUND_CHARS)}`);
  }
  const points = conventionPoints(context.conventions)
    .slice(0, V2_DEFAULTS.PROJECT_CONTEXT_CONVENTIONS_MAX)
    .map(point => clip(point, V2_DEFAULTS.PROJECT_CONTEXT_CONVENTIONS_CHARS));
  if (points.length > 0) lines.push(`- 约定：${points.join('；')}`);
  const recent = context.decisions.slice(-V2_DEFAULTS.PROJECT_CONTEXT_DECISIONS);
  if (recent.length > 0) {
    lines.push(`- 最近决策：${recent.map(decision => clip(decision.text, V2_DEFAULTS.PROJECT_CONTEXT_DECISION_CHARS)).join('；')}`);
  }
  const hits = context.glossary
    .filter(entry => hitText.includes(entry.term))
    .slice(0, V2_DEFAULTS.PROJECT_CONTEXT_GLOSSARY_MAX_HITS);
  if (hits.length > 0) {
    lines.push(`- 术语：${hits.map(entry => `${entry.term}＝${clip(entry.meaning, V2_DEFAULTS.PROJECT_CONTEXT_GLOSSARY_CHARS)}`).join('；')}`);
  }
  lines.push(`- 完整版：${projectContextPath(project)}`);
  return truncateBytes(lines.join('\n'), V2_DEFAULTS.PROJECT_CONTEXT_EXCERPT_MAX_BYTES);
}
