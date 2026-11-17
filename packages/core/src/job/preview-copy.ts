/**
 * 预览副本（P74r4b 第 2 节）：文件预览不直接打开员工写的文件，而是打开中心复制出来的副本。
 *
 * 为什么：
 * - 检查之后、打开之前，员工可以把文件换成指向别处的链接（审查疑点 1）；
 * - macOS 可以给单个文件记一个「用哪个程序打开」的扩展属性，员工写的文件带着它，主人点「打开预览」时
 *   可能被交给终端之类的程序当脚本运行，等于在沙箱之外、以主人的身份运行员工写的内容（审查疑点 2）。
 * 副本由中心用普通方式重新写出来：不带扩展属性、不带可执行位，也不在任何员工的工作区里，员工碰不到。
 *
 * 副本放在：<中心数据目录>/.hub/preview/<这件事的编号>/<随机串>/，内容是这件事 `交付` 文件夹的全部普通文件。
 * 复制规则（全部经注入的文件接口，core 不直接碰系统文件）：
 * - 只复制普通文件；符号链接、硬链接数大于 1 的文件、读的时候发现路径上有链接或真实位置跑出 `交付` 的东西，一律跳过；
 * - 文件名含控制字符的跳过；
 * - 新文件的权限位是 0o444（只读、没有可执行位），不保留原文件的权限位和扩展属性；
 * - 上限：最多 2000 个文件、总共 100 MB、单个文件 20 MB、目录最深 8 层；超过任何一项都不打开，并且不留下半份副本。
 * 清理：每次打开之前先删这件事以前的副本（removeJobPreviews）；中心启动时清空整个预览目录（clearPreviewRoot）；
 * 删除只在预览目录之内进行，删除前按真实路径确认在目录之内，出错只记日志。
 *
 * 已知边界：预览页是员工写的网页，在主人的浏览器里以本地文件的方式打开副本，页面里的脚本会运行、可以联网；
 * 它读不到副本目录之外的东西，取决于浏览器对本地文件的限制（见 docs/progress/P74r4b.md）。
 */
import { posix } from 'node:path';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { PathContainmentError, ReadLimitError } from '../io/interfaces.js';
import type { Job } from '../model/job.js';
import { hasControlChar, isInsideByParts } from './evidence.js';
import { jobFolderPaths } from './files.js';

/** 副本的各项上限（审查之后主会话定的数）。 */
export const PREVIEW_COPY_LIMITS = {
  /** 最多复制的文件数。 */
  MAX_FILES: 2000,
  /** 副本总大小上限（100 MB）。 */
  MAX_TOTAL_BYTES: 100 * 1024 * 1024,
  /** 单个文件上限（20 MB）。 */
  MAX_FILE_BYTES: 20 * 1024 * 1024,
  /** 目录最深层数：`交付` 本身是第 0 层，它的子目录是第 1 层。 */
  MAX_DEPTH: 8,
  /** P74r6：扫描时列出的项（含被跳过的）上限。 */
  MAX_LISTED: 10000,
} as const;

/** P74r11：副本各项上限的类型（调用方可以传入更小的上限，测试用；生产代码不传，用上面的默认值）。 */
export type PreviewCopyLimits = { readonly [K in keyof typeof PREVIEW_COPY_LIMITS]: number };

/** P74r6：副本只收网页用得到的文件类型（扩展名，小写，不含点）。没有扩展名的不收。预览文件本身另要求是 html 或 htm。 */
export const PREVIEW_COPY_EXTENSIONS: ReadonlySet<string> = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json', 'map', 'txt', 'md', 'csv', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'pdf', 'wasm',
]);

/** 文件名的扩展名（小写，不含点）；没有扩展名或点在开头（隐藏文件）返回空字符串。 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** 副本里新文件的权限位：只读、没有可执行位。 */
export const PREVIEW_FILE_MODE = 0o444;

/** 预览目录：<中心数据目录>/.hub/preview。宿主一侧按同样的写法算（plugin 的 real-hub.ts）。 */
export function previewRootDir(rootDir: string): string {
  return posix.join(rootDir, '.hub', 'preview');
}

/** 给主人看的固定句：内容太大。路径是这件事 `交付` 文件夹的路径。 */
export const previewTooBigText = (deliveryDir: string): string => `预览内容太大，没有打开。可以到项目文件夹里查看：${deliveryDir}`;
/** 预览文件不在 `交付` 文件夹里：不复制、不打开。 */
export const PREVIEW_NOT_IN_DELIVERY_TEXT = '预览文件不在交付文件夹里，没有打开';
/** 预览文件本身被跳过或复制失败。 */
export const PREVIEW_COPY_FAILED_TEXT = '没能生成预览副本，没有打开';

/** 随机串：用注入的随机源（红线 4，不用 Math.random），16 个小写字母和数字。 */
function randomName(ctx: HubContext): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let index = 0; index < 16; index += 1) out += alphabet[Math.floor(ctx.rng.next() * alphabet.length) % alphabet.length];
  return out;
}

/** 扫描时的中途结论：太大（超过任一上限）。 */
class TooBigError extends Error {}

/** 要复制的一个文件：源路径（`交付` 之内）和相对 `交付` 的路径。 */
interface CopyItem { src: string; rel: string; size: number }

/**
 * 先扫描、不写任何东西：列出全部要复制的普通文件，同时检查文件数、总大小、单个大小、层数。
 * 先扫描再复制，超限时磁盘上就不会留下半份副本。
 */
async function scanDelivery(ctx: HubContext, deliveryDir: string, L: PreviewCopyLimits): Promise<CopyItem[]> {
  const items: CopyItem[] = [];
  let total = 0;
  let listed = 0;
  let skippedByType = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    for (const name of await ctx.fs.list(dir)) {
      // P74r6（N9）：列出的每一项（含被跳过的链接、目录、不在名单里的文件）都计入一个单独的上限，超过按「预览内容太大」处理，
      // 免得用大量空目录、链接把扫描放大。
      listed += 1;
      if (listed > L.MAX_LISTED) throw new TooBigError('列出的项太多');
      // 文件名含控制字符的跳过（这类名字能让「给人看的」和「实际的」读出两个意思）。
      if (hasControlChar(name)) continue;
      const path = posix.join(dir, name);
      const info = await ctx.fs.lstat(path);
      // 符号链接、不存在（刚被删）、管道和设备等：跳过。
      if (info === null || info.isSymlink) continue;
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (info.isDir) {
        if (depth + 1 > L.MAX_DEPTH) throw new TooBigError('目录太深');
        await walk(path, childRel, depth + 1);
      } else if (info.isFile === true) {
        // 硬链接数大于 1：可能是文件夹之外某个文件的另一个名字，跳过。
        if (info.nlink > 1) continue;
        // P74r6：只复制网页用得到的文件类型；其余（终端配置、快捷方式、没有扩展名的文件等，双击会被系统交给别的程序）跳过。
        if (!PREVIEW_COPY_EXTENSIONS.has(extensionOf(name))) { skippedByType += 1; continue; }
        if (info.size > L.MAX_FILE_BYTES) throw new TooBigError('单个文件太大');
        total += info.size;
        if (items.length + 1 > L.MAX_FILES) throw new TooBigError('文件太多');
        if (total > L.MAX_TOTAL_BYTES) throw new TooBigError('总共太大');
        items.push({ src: path, rel: childRel, size: info.size });
      }
    }
  };
  await walk(deliveryDir, '', 0);
  if (skippedByType > 0) ctx.logger.info('预览副本跳过了不在名单里的文件类型', { skipped: skippedByType });
  return items;
}

/** 复制结果：成功给副本里预览文件的路径；失败给一句中文说明。 */
export type PreviewCopyResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * 删除预览目录之内的一个位置：删除前按真实路径确认它在预览目录之内（符号链接本身只删链接、不跟随）；
 * 不在目录之内的不删。出错只记日志，不抛出。
 */
async function removeInsidePreviewRoot(ctx: HubContext, root: string, target: string): Promise<void> {
  try {
    const info = await ctx.fs.lstat(target);
    if (info === null) return;
    if (!info.isSymlink) {
      const realRoot = await ctx.fs.realpath(root);
      const realTarget = await ctx.fs.realpath(target);
      if (!isInsideByParts(realRoot, realTarget)) { ctx.logger.warn('预览副本的位置不在预览目录之内，没有删除', { target }); return; }
    }
    // 带边界删除：边界是预览目录，目录本身或上级是符号链接时拒绝。
    await ctx.fs.remove(target, { within: root });
  } catch (error) {
    try { ctx.logger.warn('删除预览副本失败', { target, error: String(error) }); } catch { /* 日志出错也不能影响主流程。 */ }
  }
}

/** 删掉这件事以前的全部预览副本（每次打开预览之前调用）。 */
export async function removeJobPreviews(ctx: HubContext, jobId: string): Promise<void> {
  const root = previewRootDir(ctx.settings.rootDir);
  await removeInsidePreviewRoot(ctx, root, posix.join(root, jobId));
}

/** 清空整个预览目录（中心启动时调用）：逐个删除目录里的每一项，目录本身保留。 */
export async function clearPreviewRoot(ctx: HubContext): Promise<void> {
  const root = previewRootDir(ctx.settings.rootDir);
  try {
    for (const name of await ctx.fs.list(root)) await removeInsidePreviewRoot(ctx, root, posix.join(root, name));
  } catch (error) {
    try { ctx.logger.warn('清空预览目录失败', { error: String(error) }); } catch { /* 同上。 */ }
  }
}

/**
 * 把这件事的 `交付` 文件夹复制成副本，返回副本里 previewReal 对应的文件路径。
 * previewReal 是 previewFileCheck 给出的真实路径（已确认在主题文件夹之内、是普通文件、不是链接）。
 * 失败时把已经写出的半份副本整个删掉。
 */
export async function makePreviewCopy(ctx: HubContext, job: Job, previewReal: string, limits: PreviewCopyLimits = PREVIEW_COPY_LIMITS): Promise<PreviewCopyResult> {
  const { jobDir } = jobFolderPaths(ctx, job);
  const deliveryDir = posix.join(jobDir, D.FOLDER_FILES.delivery);
  const fail = (error: string): PreviewCopyResult => ({ ok: false, error });
  let copyRoot: string | null = null;
  try {
    // 预览文件必须在 `交付` 文件夹里（按真实路径逐段比较）。
    const realDelivery = await ctx.fs.realpath(deliveryDir);
    if (!isInsideByParts(realDelivery, previewReal)) return fail(PREVIEW_NOT_IN_DELIVERY_TEXT);
    const previewRel = posix.relative(realDelivery, previewReal);
    // 先扫描：超过任何一项上限就不打开，磁盘上什么也没写。
    let items: CopyItem[];
    try { items = await scanDelivery(ctx, deliveryDir, limits); }
    catch (error) {
      if (error instanceof TooBigError) return fail(previewTooBigText(deliveryDir));
      throw error;
    }
    // 以前的副本先删掉，再建新的。
    await removeJobPreviews(ctx, job.id);
    const jobRoot = posix.join(previewRootDir(ctx.settings.rootDir), job.id);
    for (let attempt = 0; attempt < 5 && copyRoot === null; attempt += 1) {
      const candidate = posix.join(jobRoot, randomName(ctx));
      if ((await ctx.fs.lstat(candidate)) === null) copyRoot = candidate;
    }
    if (copyRoot === null) return fail(PREVIEW_COPY_FAILED_TEXT);
    // 建目录时每一级都不能是符号链接（边界是中心数据目录）。
    await ctx.fs.mkdirp(copyRoot, { within: ctx.settings.rootDir });
    let total = 0;
    let copiedPreview = false;
    for (const item of items) {
      let bytes: Uint8Array | null;
      try {
        // 按句柄读：路径上有符号链接、多个硬链接、被换成别的东西，都抛出，这个文件跳过。
        bytes = await ctx.fs.readBytesWithin(item.src, { within: deliveryDir, maxBytes: limits.MAX_FILE_BYTES });
      } catch (error) {
        if (error instanceof ReadLimitError) throw new TooBigError('单个文件太大');
        if (error instanceof PathContainmentError) continue;
        throw error;
      }
      if (bytes === null) continue;
      total += bytes.length;
      if (total > limits.MAX_TOTAL_BYTES) throw new TooBigError('总共太大');
      await ctx.fs.writeBytesAtomic(posix.join(copyRoot, item.rel), bytes, { within: copyRoot }, PREVIEW_FILE_MODE);
      if (item.rel === previewRel) copiedPreview = true;
    }
    // 预览文件本身被跳过：不打开。
    if (!copiedPreview) throw new Error('预览文件没有被复制');
    return { ok: true, path: posix.join(copyRoot, previewRel) };
  } catch (error) {
    if (copyRoot !== null) await removeInsidePreviewRoot(ctx, previewRootDir(ctx.settings.rootDir), posix.dirname(copyRoot));
    if (error instanceof TooBigError) return fail(previewTooBigText(deliveryDir));
    try { ctx.logger.warn('生成预览副本失败', { jobId: job.id, error: String(error) }); } catch { /* 日志出错也不能影响返回。 */ }
    return fail(PREVIEW_COPY_FAILED_TEXT);
  }
}
