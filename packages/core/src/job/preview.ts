/**
 * 打开预览前的校验（P74g，界面命令 openJobPreview 的 core 一侧；宿主一侧在插件里，负责真正打开）。
 *
 * 分工：core 只回答「这件事的预览能不能打开、打开哪个目标」，红线 4 不允许 core 自己打开任何东西；
 * 宿主只打开 core 返回的那个目标，不接受界面传来的任何路径或地址。所以这里的每一项判断都是安全边界：
 * 任何一处写松了，主人点一下「打开预览」就可能打开主题文件夹以外的文件，或者联网打开别人的网页。
 *
 * 预览取这件事最新一次交回里写的 preview。两种：
 * 一、主题文件夹里的 .html、.htm 文件：
 *    - 路径文字里不能有空字符、换行等控制字符，前后不能有空白，不能是绝对路径，任何一段不能是「..」（evidence.ts 的 checkTopicFile）；
 *    - 路径经过的每一级（含项目文件夹、主题文件夹本身）不能是符号链接；文件夹里指向文件夹外的符号链接，文件、目录两种都拒绝；
 *    - 解析成真实路径之后，再按「逐段比较」确认仍在主题文件夹的真实路径里（isInsideByParts，不用字符串前缀）；
 *    - 必须存在、是普通文件、不是空文件；扩展名在解析出真实路径之后再判断一次；
 *    - 中心写的文件（约定、原话、草图、材料）不能当预览。
 *    以上检查通过后，复制副本并返回副本里的文件路径（P74r4b）。
 * 二、本机地址：
 *    - 用地址解析（new URL）判断，不用字符串前缀；协议只能是 http 或 https；
 *    - 主机名必须恰好是 localhost、127.0.0.1 或 [::1]；不能带用户名或密码；
 *    - 整个地址只能由可见的英文字符、数字、符号组成：前后的空白、换行、中间的控制字符、非英文字符一律拒绝；
 *    - 开头必须是「http://」或「https://」（解析器对「http:localhost」这类写法也会放过，这里先拒绝）；
 *    - 返回解析后的标准写法，宿主打开的就是检查过的那个地址。
 * 其他一切（file:、javascript:、别的主机）一律拒绝。不确定的按拒绝处理。
 *    - P74r4b：地址里不能含 $ ` ; | & ( ) < > ' " \ * ! 这些字符（localPreviewUrl，交回时和打开时同一个判断）。
 * P74r4b：文件预览不再返回员工写的原文件，而是返回中心复制出来的副本（preview-copy.ts），宿主打开之前还会再查一次。
 */
import { z } from 'zod';
import type { CommandResult } from '../api/types.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { recordId } from '../model/primitives.js';
import { localPreviewUrl, previewFileCheck } from './evidence.js';
import { PREVIEW_NOT_IN_DELIVERY_TEXT, makePreviewCopy, type PreviewCopyLimits } from './preview-copy.js';
import { latestSubmission } from './store.js';

/** core 返回给宿主的预览目标。 */
export type PreviewTarget = { kind: 'file'; path: string } | { kind: 'url'; url: string };

const PreviewSchema = z.strictObject({ jobId: recordId('job') });

const fail = (error: string): CommandResult<PreviewTarget> => ({ ok: false, error });

/** 地址不合格时的固定说法。 */
export const PREVIEW_URL_REFUSED_TEXT = '预览地址不是本机地址，不能打开';
/** 文件不合格时的固定说法。 */
export const PREVIEW_FILE_GONE_TEXT = '这个预览文件已不在主题文件夹里';

// 地址判断放在 evidence.ts（交回时和打开时共用同一个函数），这里转出。
export { localPreviewUrl };

/**
 * 这件事最新一次交回的预览：能打开就返回目标，不能返回一句中文说明。不抛出；不写任何记录（存储、审计）；core 不打开任何东西。
 * 文件预览（P74r4b）：检查通过后把 `交付` 文件夹复制成副本，返回副本里的文件；副本的规则见 preview-copy.ts。
 */
export async function jobPreviewTarget(ctx: HubContext, raw: unknown, limits?: PreviewCopyLimits): Promise<CommandResult<PreviewTarget>> {
  let jobId: string;
  try { jobId = parseInput(PreviewSchema, raw, '打开预览').jobId; }
  catch (error) { return fail(error instanceof Error ? error.message : '打开预览的参数不对'); }
  try {
    const job = ctx.store.table('jobs').get(jobId);
    if (job === null) return fail('找不到这件事');
    const preview = latestSubmission(ctx, job.id)?.preview ?? null;
    if (preview === null) return fail('这件事没有可打开的预览');
    // 带协议的写法（含前面有空白的）一律按地址判断，其余按主题文件夹里的文件判断。
    if (/^\s*[a-z][a-z0-9+.-]*:/i.test(preview)) {
      const url = localPreviewUrl(preview);
      return url === null ? fail(PREVIEW_URL_REFUSED_TEXT) : { ok: true, data: { kind: 'url', url } };
    }
    // 检查函数与交回时共用（previewFileCheck）；通过后复制副本，打开的是副本，不是员工写的原文件。
    const checked = await previewFileCheck(ctx, job, preview);
    if (!checked.ok) return fail(checked.notInDelivery === true ? PREVIEW_NOT_IN_DELIVERY_TEXT : PREVIEW_FILE_GONE_TEXT);
    // P74r11：limits 只有测试会传（传很小的上限，免得在磁盘上建上千个文件）；生产调用方不传，用默认上限。
    const copy = await makePreviewCopy(ctx, job, checked.real, limits);
    return copy.ok ? { ok: true, data: { kind: 'file', path: copy.path } } : fail(copy.error);
  } catch (error) {
    try { ctx.logger.warn('检查预览失败', { jobId, error: String(error) }); } catch { /* 日志出错也不能影响返回。 */ }
    return fail('现在打不开这个预览');
  }
}
