/**
 * 读取一张证据截图（P74g，界面命令 readJobEvidence，只读）。
 *
 * 为什么要有：交回卡、核对卡上的截图在主题文件夹里，界面跑在 DSH 的网页里，不能直接打开本机文件，
 * 只能请中心读出来、以 data 地址的形式交给界面显示。
 *
 * 安全：这是界面直接触发的读文件命令，路径来自员工写的交回记录，不可信。所以：
 * - 证据必须属于这件事的这次交回，而且类型是截图；
 * - 每次读取都重新做一遍交回时的路径与图片检查（文件可能在交回之后被换掉：换成文本、换成指向文件夹外的符号链接、换成超大文件），
 *   检查与读字节用同一个函数（evidence.ts 的 loadTopicImage）：路径逐段比较、符号链接一律拒绝、
 *   真实路径必须仍在主题文件夹的真实路径之内、必须是普通文件、扩展名与文件头一致、不超过 5 MB；
 * - 中心写的文件（约定、原话、草图、材料）不能当证据；
 * - 任何一项不合格都只返回一句中文，不带系统路径和系统错误原文。
 * 不写任何存储、不记审计（读取不改变任何事实）。
 */
import { z } from 'zod';
import type { CommandResult } from '../api/types.js';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, recordId } from '../model/primitives.js';
import { centerWrittenError, loadTopicImage } from './evidence.js';

/** 读到的截图：类型和 data 地址（界面直接放进 img）。 */
export interface EvidenceImage { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; dataUrl: string }

/** 文件已经不在主题文件夹里（被删、被换到文件夹外、被换成符号链接……）时的固定说法。 */
export const EVIDENCE_GONE_TEXT = '这张截图已不在主题文件夹里';

const ReadEvidenceSchema = z.strictObject({ jobId: recordId('job'), submissionId: recordId('jsb'), evidenceId: nonempty });

/** 扩展名对应的类型；只认检查通过的四种格式。 */
const MIME_OF_EXT: Record<string, EvidenceImage['mime']> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const fail = (error: string): CommandResult<EvidenceImage> => ({ ok: false, error });

/** 读一张证据截图。不抛出：任何问题都变成一句中文错误。 */
export async function readJobEvidence(ctx: HubContext, raw: unknown): Promise<CommandResult<EvidenceImage>> {
  let args: z.infer<typeof ReadEvidenceSchema>;
  try { args = parseInput(ReadEvidenceSchema, raw, '读取截图'); }
  catch (error) { return fail(error instanceof Error ? error.message : '读取截图的参数不对'); }
  try {
    const job = ctx.store.table('jobs').get(args.jobId);
    const submission = job === null ? null : ctx.store.table('jobSubmissions').get(args.submissionId);
    // 证据必须属于这件事的这次交回：别的事的交回、别的交回里的证据一律读不到。
    if (job === null || submission === null || submission.jobId !== job.id) return fail('找不到这张截图');
    const evidence = submission.items.flatMap(item => item.evidence).find(entry => entry.id === args.evidenceId);
    if (evidence === undefined) return fail('找不到这张截图');
    if (evidence.kind !== 'image' || evidence.path === null) return fail('这项证据不是截图');
    // 中心写的文件不能当证据（交回时已拒绝，这里再核对一次，防止记录是别的途径写进去的）。
    if (centerWrittenError(job, evidence.path) !== null) return fail(EVIDENCE_GONE_TEXT);
    // 与交回时同一套路径与图片检查，并按句柄读出字节。
    const loaded = await loadTopicImage(ctx, job, evidence.path);
    if (loaded.check.status === 'too_large') return fail(`这张截图超过 ${D.IMAGE_MAX_BYTES / (1024 * 1024)} MB，这里不显示`);
    if (loaded.check.status === 'not_image' || loaded.check.status === 'empty') return fail('这个文件不是有效的图片');
    const mime = MIME_OF_EXT[loaded.ext];
    if (loaded.check.status !== 'ok' || loaded.bytes === null || mime === undefined) return fail(EVIDENCE_GONE_TEXT);
    return { ok: true, data: { mime, dataUrl: `data:${mime};base64,${Buffer.from(loaded.bytes).toString('base64')}` } };
  } catch (error) {
    // 系统错误（权限、读取失败）不把细节交给界面，只写日志。
    try { ctx.logger.warn('读取证据截图失败', { jobId: args.jobId, error: String(error) }); } catch { /* 日志出错也不能影响返回。 */ }
    return fail('这张截图现在读不出来');
  }
}
