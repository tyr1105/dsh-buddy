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
import { centerWrittenError, checkTopicFile } from './evidence.js';

/**
 * 要做的事：用默认应用打开、在访达（文件管理器）中显示，或在 DSH 自带的文件预览里看（view：界面拿路径和会话去开 DSH 的右侧预览）。
 */
export type EvidenceOpenAction = 'open' | 'reveal' | 'view';

/**
 * 检查过的目标：真实绝对路径和要做的事。
 * sessionId 只在 view 时给：交付这件事的员工的 DSH 会话（没有就用总管的），DSH 的文件预览要挂在一个会话上读文件。
 */
export interface EvidenceOpenTarget { path: string; action: EvidenceOpenAction; sessionId?: string | null }

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
  action: z.enum(['open', 'reveal', 'view']),
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
    if (args.action !== 'reveal' && !evidenceOpenable(checked.real)) return fail(EVIDENCE_NOT_OPENABLE_TEXT);
    if (args.action === 'view') {
      const sessionOf = (botId: string): string | null => ctx.store.table('bots').get(botId)?.sessionId ?? null;
      return { ok: true, data: { path: checked.real, action: 'view', sessionId: sessionOf(job.executorId) ?? sessionOf(job.chiefId) } };
    }
    return { ok: true, data: { path: checked.real, action: args.action } };
  } catch (error) {
    try { ctx.logger.warn('取证据文件位置失败', { jobId: args.jobId, error: String(error) }); } catch { /* 日志出错也不能影响返回。 */ }
    return fail('这个文件现在打不开');
  }
}
