/**
 * 项目共享上下文的写入服务（P39）：主人编辑、队友提建议、主人采纳/驳回。
 *
 * 为什么单独成文件：project/context.ts 只放纯函数（渲染、哈希、摘要），
 * project/service.ts 已经承载项目与任务命令。上下文写入要同时做「落正文文件、追加留痕、
 * 写审计、发事件」四件事，单独一处收口才能保证四条命令走同一条路径、不出现两套摘要口径。
 *
 * 纪律：
 * - 正文只落项目 sharedDir 下的 context.md；项目记录只存四段结构与「摘要 + 哈希」留痕，
 *   不在账本里复制正文；
 * - 内容哈希没变就不算一次修改：不写文件、不留痕、不发事件；
 * - 队友建议不改正文：只落 projectContextProposals 表，主人采纳后才走与主人编辑相同的写文件路径；
 * - 只有项目成员能提建议、只有进行中的项目能提；非成员按「项目不存在」处理，避免泄露项目存在性。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, recordId, text, timestamp } from '../model/primitives.js';
import type {
  ContextDecision, Project, ProjectContext, ProjectContextProposal, ProjectContextRevision,
} from '../model/project.js';
import {
  ContextDecisionSchema, ContextGlossaryEntrySchema, ProjectContextProposalSchema,
  ProjectContextRevisionSchema, ProjectContextSchema,
} from '../model/project.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { newId } from '../util/ids.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import {
  describeContextChange, projectContextHash, projectContextPath, renderProjectContextMarkdown,
} from './context.js';
import { posix } from 'node:path';
import { ensureProjectSharedDir } from './shared-dir.js';

/** 主人编辑时提交的一条决策：带 id 表示已有项，不带表示新增。 */
const DecisionInputSchema = z.strictObject({
  id: recordId('dc').optional(),
  text: nonempty.trim().min(1, '决策内容不能为空').max(300, '决策内容不能超过 300 字'),
  by: text.trim().max(100, '决策来源不能超过 100 字').optional(),
  at: timestamp.optional(),
});

/** 术语表一行；术语与释义都必须有正文。 */
const GlossaryInputSchema = z.strictObject({
  term: nonempty.trim().min(1, '术语不能为空').max(60, '术语不能超过 60 字'),
  meaning: nonempty.trim().min(1, '术语释义不能为空').max(300, '术语释义不能超过 300 字'),
});

/**
 * 主人保存上下文的入参：四段都可省略，省略即沿用当前值。
 * 为什么不做「整体替换」：界面只改背景时不该把决策与术语一起清空，
 * 显式传空数组才是清空。
 */
export const SaveProjectContextSchema = z.strictObject({
  projectId: recordId('prj'),
  background: text.trim().max(2000, '项目背景不能超过 2000 字').optional(),
  conventions: text.trim().max(2000, '项目约定不能超过 2000 字').optional(),
  decisions: z.array(DecisionInputSchema).optional(),
  glossary: z.array(GlossaryInputSchema).optional(),
});
export type SaveProjectContextInput = z.infer<typeof SaveProjectContextSchema>;

/** 队友建议的入参：语义与主人编辑一致（省略即沿用当前值），另加一句建议说明。 */
export const ProposeProjectContextSchema = SaveProjectContextSchema.extend({
  note: nonempty.trim().min(1, '建议说明不能为空').max(500, '建议说明不能超过 500 字'),
});
export type ProposeProjectContextInput = z.infer<typeof ProposeProjectContextSchema>;

const ProposalIdSchema = recordId('pcp');

/** 项目变化的统一事件：全队结构，botId 固定 null（与项目服务一致）。 */
function notifyProject(ctx: HubContext): void {
  ctx.emit(HUB_EVENT_SCOPES.project, null);
}

/** 条数上限的中文报错：说清是哪一段、上限多少、当前多少。 */
function checkLimit(label: string, count: number, max: number): void {
  if (count > max) throw new Error(`${label}不能超过 ${max} 条，当前 ${count} 条`);
}

/**
 * 合并决策列表：保留已有 id 与时间，给新增项生成 id、记录来源与时间。
 * 带 id 但不在当前上下文里的决策视为伪造，直接拒绝，避免把别人的决策挂到自己项目下。
 */
function mergeDecisions(
  ctx: HubContext, existing: ContextDecision[], inputs: z.infer<typeof DecisionInputSchema>[], byDefault: string,
): ContextDecision[] {
  const now = ctx.clock.now();
  const seen = new Set<string>();
  return inputs.map((item) => {
    const old = item.id ? existing.find(decision => decision.id === item.id) : undefined;
    if (item.id && !old) throw new Error(`决策不属于该项目，不能修改：${item.id}`);
    if (item.id && seen.has(item.id)) throw new Error(`决策在入参里重复：${item.id}`);
    if (item.id) seen.add(item.id);
    return ContextDecisionSchema.parse({
      id: old?.id ?? newId('dc', ctx.rng),
      text: item.text,
      by: item.by ?? old?.by ?? byDefault,
      at: item.at ?? old?.at ?? now,
    });
  });
}

/** 按入参合并四段；没有出现的段沿用当前值（含术语表的原样保留）。 */
function mergeContext(
  ctx: HubContext, project: Project, input: SaveProjectContextInput, byDefault: string,
): ProjectContext {
  const current = project.context;
  const decisions = input.decisions === undefined
    ? current.decisions
    : mergeDecisions(ctx, current.decisions, input.decisions, byDefault);
  checkLimit('项目决策', decisions.length, V2_DEFAULTS.PROJECT_CONTEXT_DECISION_MAX);
  const glossary = input.glossary === undefined
    ? current.glossary
    : input.glossary.map(item => ContextGlossaryEntrySchema.parse({ term: item.term, meaning: item.meaning }));
  checkLimit('项目术语', glossary.length, V2_DEFAULTS.PROJECT_CONTEXT_GLOSSARY_MAX);
  return ProjectContextSchema.parse({
    background: input.background ?? current.background,
    conventions: input.conventions ?? current.conventions,
    decisions,
    glossary,
  });
}

/**
 * 统一的落盘与留痕：渲染 → 比哈希 → 建目录 → 写文件 → 追加修订 → 审计 → 发事件。
 * 哈希没变直接返回原项目，避免「点保存但没改」也留一条记录。
 */
async function writeContext(
  ctx: HubContext,
  project: Project,
  next: ProjectContext,
  meta: { editorId: string; editorKind: 'owner' | 'bot'; source: ProjectContextRevision['source'] },
): Promise<Project> {
  const now = ctx.clock.now();
  const timezone = ctx.settings.timezone;
  const markdown = renderProjectContextMarkdown(project, next, timezone);
  const hash = projectContextHash(markdown);
  if (hash === projectContextHash(renderProjectContextMarkdown(project, project.context, timezone))) {
    return project;
  }

  const path = projectContextPath(project);
  await ensureProjectSharedDir(ctx, project);
  try {
    await ctx.fs.writeTextAtomic(path, markdown, { within: posix.join(ctx.settings.rootDir, 'projects') });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`项目「${project.name}」共享上下文写入失败：${path}（${message}）`);
  }

  const revision: ProjectContextRevision = ProjectContextRevisionSchema.parse({
    id: newId('pcr', ctx.rng),
    at: now,
    editorId: meta.editorId,
    editorKind: meta.editorKind,
    summary: describeContextChange(project.context, next),
    hash,
    source: meta.source,
  });
  // 留痕只保留最近 N 条（卡片默认 50）：旧记录被移出列表，但正文文件与审计仍在。
  const revisions = [...project.contextRevisions, revision].slice(-V2_DEFAULTS.PROJECT_CONTEXT_REVISION_MAX);
  const record = ctx.store.table('projects').patch(project.id, { context: next, contextRevisions: revisions, updatedAt: now });
  writeOutreachAudit(ctx, 'project_context_update', {
    id: project.id, name: project.name, hash, summary: revision.summary,
    editorId: revision.editorId, editorKind: revision.editorKind, source: revision.source,
    revisionId: revision.id, path,
  }, meta.editorKind === 'owner' ? 'owner' : meta.editorId, now);
  notifyProject(ctx);
  return record;
}

/** 主人保存上下文：只认进行中/暂停/完成的项目，归档项目不允许再改。 */
export async function saveProjectContext(ctx: HubContext, raw: unknown): Promise<Project> {
  const input = parseInput(SaveProjectContextSchema, raw, '项目上下文保存');
  const project = ctx.store.table('projects').get(input.projectId);
  if (!project) throw new Error(`项目不存在：${input.projectId}`);
  if (project.status === 'archived') throw new Error(`项目「${project.name}」已归档，共享上下文不能再改`);
  const next = mergeContext(ctx, project, input, 'owner');
  // 全部校验通过后才取随机数并碰盘，失败命令不留半条记录。
  return writeContext(ctx, project, next, { editorId: 'owner', editorKind: 'owner', source: 'owner_edit' });
}

/**
 * 队友提交修改建议：不改正文，只落一条待审记录。
 * 非成员与不存在的项目给同一句「项目不存在或你不在成员名单里」，不泄露项目存在性。
 */
export function proposeProjectContext(ctx: HubContext, botId: string, raw: unknown): ProjectContextProposal {
  const input = parseInput(ProposeProjectContextSchema, raw, '项目上下文建议');
  const project = ctx.store.table('projects').get(input.projectId);
  if (!project || !project.memberBotIds.includes(botId)) {
    throw new Error(`项目不存在或你不在成员名单里：${input.projectId}`);
  }
  if (project.status !== 'active') {
    throw new Error(`项目「${project.name}」当前不是进行中，暂不能提交上下文建议`);
  }
  const next = mergeContext(ctx, project, input, botId);
  if (describeContextChange(project.context, next) === '内容未变') {
    throw new Error('建议内容与当前上下文一致，没有需要提交的修改');
  }

  const now = ctx.clock.now();
  const table = ctx.store.table('projectContextProposals');
  // 每个队友在每个项目只保留一条待审建议：已有 pending 就原地更新，避免刷屏。
  const pending = table.list().find(item => item.projectId === project.id && item.botId === botId && item.status === 'pending');
  const record: ProjectContextProposal = ProjectContextProposalSchema.parse({
    id: pending?.id ?? newId('pcp', ctx.rng),
    projectId: project.id,
    botId,
    context: next,
    note: input.note,
    status: 'pending',
    createdAt: now,
    decidedAt: null,
  });
  if (pending) table.patch(record.id, record);
  else table.put(record);
  writeOutreachAudit(ctx, 'project_context_propose', {
    id: record.id, projectId: project.id, botId, note: record.note,
    summary: describeContextChange(project.context, next), replaced: pending !== undefined,
  }, botId, now);
  notifyProject(ctx);
  return record;
}

/**
 * 主人采纳建议：走与主人编辑完全相同的写文件与留痕路径，
 * 只是修订的 editorKind 记为 bot、来源记为 bot_proposal，主人可追溯是谁提的。
 */
export async function approveProjectContextProposal(ctx: HubContext, rawId: unknown): Promise<Project> {
  const id = parseInput(ProposalIdSchema, rawId, '上下文建议命令');
  const proposal = ctx.store.table('projectContextProposals').get(id);
  if (!proposal) throw new Error(`上下文建议不存在：${id}`);
  if (proposal.status !== 'pending') throw new Error('这条上下文建议已经处理过了');
  const project = ctx.store.table('projects').get(proposal.projectId);
  if (!project) throw new Error(`建议所属项目不存在：${proposal.projectId}`);
  if (project.status === 'archived') throw new Error(`项目「${project.name}」已归档，共享上下文不能再改`);

  const now = ctx.clock.now();
  // 建议里存的是「提出时看到的完整四段」：采纳即按建议内容写入，不做二次合并，
  // 避免悄悄丢掉建议方明确写的内容；写入后的留痕摘要会如实反映与当前正文的差异。
  const record = await writeContext(ctx, project, proposal.context, {
    editorId: proposal.botId, editorKind: 'bot', source: 'bot_proposal',
  });
  ctx.store.table('projectContextProposals').patch(proposal.id, { status: 'approved', decidedAt: now });
  writeOutreachAudit(ctx, 'project_context_approve', {
    id: proposal.id, projectId: project.id, botId: proposal.botId, revisionHash: record.contextRevisions.at(-1)?.hash ?? null,
  }, 'owner', now);
  notifyProject(ctx);
  return record;
}

/** 主人驳回建议：只改建议状态，不碰项目正文。 */
export function rejectProjectContextProposal(ctx: HubContext, rawId: unknown): ProjectContextProposal {
  const id = parseInput(ProposalIdSchema, rawId, '上下文建议命令');
  const proposal = ctx.store.table('projectContextProposals').get(id);
  if (!proposal) throw new Error(`上下文建议不存在：${id}`);
  if (proposal.status !== 'pending') throw new Error('这条上下文建议已经处理过了');
  const now = ctx.clock.now();
  const record = ctx.store.table('projectContextProposals').patch(id, { status: 'rejected', decidedAt: now });
  writeOutreachAudit(ctx, 'project_context_reject', {
    id: proposal.id, projectId: proposal.projectId, botId: proposal.botId,
  }, 'owner', now);
  notifyProject(ctx);
  return record;
}
