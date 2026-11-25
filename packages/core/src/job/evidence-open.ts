/**
 * 卡片上的「文件」证据：给出可以交给宿主打开的位置（W12，界面命令 openJobEvidence，只读）。
 *
 * 为什么要有：交付卡、交回卡、核对卡里的文件证据以前只是一行文字，主人点不开。
 * 中心不自己做查看器，而是把文件的真实路径交给宿主（DSH 的「用默认应用打开 / 在访达中显示」）。
 *
 * 安全：路径来自员工写的交回记录，不可信。所以：
 * - 证据必须属于这件事的这次交回，类型是文件或截图；
 * - 每次都重新做一遍交回时的路径检查（checkTopicFile：不越出主题文件夹、不经过符号链接、普通文件、非空），
 *   返回的是检查得到的真实路径，不是记录里的原文；
 * - 中心写的文件不能当证据；
 * - 「用默认应用打开」只放行常见的文档、表格、图片格式：员工写出来的 .command、.app、.sh 之类，
 *   双击就会运行，绝不能一点就开；网页（.html）也不在这里直接打开，网页走「打开预览」那一套。
 *   其余格式只能「在访达中显示」，由主人自己决定怎么开；
 * - 任何一项不合格都只返回一句中文，不带系统路径和系统错误原文。
 * 不写任何存储、不记审计。
 */
import { posix } from 'node:path';
import { z } from 'zod';
import type { CommandResult } from '../api/types.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, recordId } from '../model/primitives.js';
import { PathContainmentError, ReadLimitError } from '../io/interfaces.js';
import { jobFolderPaths } from './files.js';
import { centerWrittenError, checkTopicFile, realInsideTopic } from './evidence.js';

/** 宿主要做的事：用默认应用打开，或在访达（文件管理器）中显示。 */
export type EvidenceOpenAction = 'open' | 'reveal';

/** 交给宿主的目标：检查过的真实绝对路径和要做的事。 */
export interface EvidenceOpenTarget { path: string; action: EvidenceOpenAction }

/** 可以「用默认应用打开」的扩展名（小写，不带点）：只有文档、表格、演示、图片和纯文本。 */
export const EVIDENCE_OPENABLE_EXTS: readonly string[] = [
  'md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml',
  'pdf', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages', 'numbers',
  'png', 'jpg', 'jpeg', 'gif', 'webp',
];

/** 这个文件名能不能直接用默认应用打开。宿主那一层用同一个函数再查一次。 */
export function evidenceOpenable(path: string): boolean {
  const ext = posix.extname(path).slice(1).toLowerCase();
  return ext !== '' && EVIDENCE_OPENABLE_EXTS.includes(ext);
}

/** 文件不在了的固定说法。 */
export const EVIDENCE_FILE_GONE_TEXT = '这个文件已不在主题文件夹里';
/** 格式不能直接打开时的说法。 */
export const EVIDENCE_NOT_OPENABLE_TEXT = '这种文件不直接打开，可以点「在访达中显示」自己决定怎么开';

const OpenEvidenceSchema = z.strictObject({
  jobId: recordId('job'),
  submissionId: recordId('jsb'),
  evidenceId: nonempty,
  action: z.enum(['open', 'reveal']),
});

const fail = (error: string): CommandResult<EvidenceOpenTarget> => ({ ok: false, error });

/** 找到证据文件并给出可以交给宿主的目标。不抛出：任何问题都变成一句中文错误。 */
export async function jobEvidenceOpenTarget(ctx: HubContext, raw: unknown): Promise<CommandResult<EvidenceOpenTarget>> {
  let args: z.infer<typeof OpenEvidenceSchema>;
  try { args = parseInput(OpenEvidenceSchema, raw, '打开文件'); }
  catch (error) { return fail(error instanceof Error ? error.message : '打开文件的参数不对'); }
  try {
    const job = ctx.store.table('jobs').get(args.jobId);
    const submission = job === null ? null : ctx.store.table('jobSubmissions').get(args.submissionId);
    if (job === null || submission === null || submission.jobId !== job.id) return fail('找不到这个文件');
    const evidence = submission.items.flatMap(item => item.evidence).find(entry => entry.id === args.evidenceId);
    if (evidence === undefined) return fail('找不到这个文件');
    if ((evidence.kind !== 'file' && evidence.kind !== 'image') || evidence.path === null) return fail('这项证据不是文件');
    if (centerWrittenError(job, evidence.path) !== null) return fail(EVIDENCE_FILE_GONE_TEXT);
    const checked = await checkTopicFile(ctx, job, evidence.path);
    if (checked.status === 'empty') return fail('这个文件是空的');
    if (checked.status !== 'ok' || checked.real === undefined) return fail(EVIDENCE_FILE_GONE_TEXT);
    if (args.action === 'open' && !evidenceOpenable(checked.real)) return fail(EVIDENCE_NOT_OPENABLE_TEXT);
    return { ok: true, data: { path: checked.real, action: args.action } };
  } catch (error) {
    try { ctx.logger.warn('取证据文件位置失败', { jobId: args.jobId, error: String(error) }); } catch { /* 日志出错也不能影响返回。 */ }
    return fail('这个文件现在打不开');
  }
}

// ---------- 在员工页里直接看（W12 验收后加）：读出文本，界面用 DSH 自带的 Markdown 渲染器显示 ----------

/** 能在卡片旁边直接看的纯文本格式（小写，不带点）。 */
export const EVIDENCE_TEXT_EXTS: readonly string[] = ['md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml'];
/** 直接看的大小上限：2 MB。再大的文件交给默认应用。 */
export const EVIDENCE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** 读到的文本：内容、格式（md 按 Markdown 显示，其余按纯文本）和文件名。 */
export interface EvidenceText { text: string; format: 'markdown' | 'plain'; name: string }

const ReadTextSchema = z.strictObject({ jobId: recordId('job'), submissionId: recordId('jsb'), evidenceId: nonempty });

/** 这个文件名能不能在卡片旁边直接看。 */
export function evidenceTextViewable(path: string): boolean {
  const ext = posix.extname(path).slice(1).toLowerCase();
  return ext !== '' && EVIDENCE_TEXT_EXTS.includes(ext);
}

/**
 * 读出一个文本类文件证据（只读）。检查与「打开」同一套，再按句柄在主题文件夹内读字节（符号链接、硬链接、跑出文件夹都拒绝），
 * 不超过 2 MB，必须是 UTF-8。不抛出：任何问题都变成一句中文错误。
 */
export async function readJobEvidenceText(ctx: HubContext, raw: unknown): Promise<CommandResult<EvidenceText>> {
  const failText = (error: string): CommandResult<EvidenceText> => ({ ok: false, error });
  let args: z.infer<typeof ReadTextSchema>;
  try { args = parseInput(ReadTextSchema, raw, '读取文件'); }
  catch (error) { return failText(error instanceof Error ? error.message : '读取文件的参数不对'); }
  try {
    const job = ctx.store.table('jobs').get(args.jobId);
    const submission = job === null ? null : ctx.store.table('jobSubmissions').get(args.submissionId);
    if (job === null || submission === null || submission.jobId !== job.id) return failText('找不到这个文件');
    const evidence = submission.items.flatMap(item => item.evidence).find(entry => entry.id === args.evidenceId);
    if (evidence === undefined) return failText('找不到这个文件');
    if (evidence.kind !== 'file' || evidence.path === null) return failText('这项证据不是文件');
    if (centerWrittenError(job, evidence.path) !== null) return failText(EVIDENCE_FILE_GONE_TEXT);
    if (!evidenceTextViewable(evidence.path)) return failText('这种文件不能在这里直接看');
    const checked = await checkTopicFile(ctx, job, evidence.path);
    if (checked.status === 'empty') return failText('这个文件是空的');
    if (checked.status !== 'ok' || checked.real === undefined || !(await realInsideTopic(ctx, job, checked.real))) return failText(EVIDENCE_FILE_GONE_TEXT);
    const tooLarge = '这个文件超过 2 MB，请用「在访达中显示」打开';
    if (checked.size > EVIDENCE_TEXT_MAX_BYTES) return failText(tooLarge);
    const { jobDir } = jobFolderPaths(ctx, job);
    let bytes: Uint8Array | null;
    try {
      bytes = await ctx.fs.readBytesWithin(posix.join(jobDir, posix.normalize(evidence.path.replace(/\/+$/, ''))), { within: jobDir, maxBytes: EVIDENCE_TEXT_MAX_BYTES });
    } catch (error) {
      if (error instanceof ReadLimitError) return failText(tooLarge);
      if (error instanceof PathContainmentError) return failText(EVIDENCE_FILE_GONE_TEXT);
      throw error;
    }
    if (bytes === null) return failText(EVIDENCE_FILE_GONE_TEXT);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return failText('这个文件不是 UTF-8 文本，请用「在访达中显示」打开'); }
    const ext = posix.extname(evidence.path).slice(1).toLowerCase();
    return { ok: true, data: { text, format: ext === 'md' || ext === 'markdown' ? 'markdown' : 'plain', name: posix.basename(evidence.path) } };
  } catch (error) {
    try { ctx.logger.warn('读取证据文件失败', { jobId: args.jobId, error: String(error) }); } catch { /* 日志出错也不能影响返回。 */ }
    return failText('这个文件现在读不出来');
  }
}
