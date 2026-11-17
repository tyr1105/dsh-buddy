/**
 * 证据的机械检查（P74d，方案 5.3.3）：交回时由中心核对每一项证据「是否真实存在、格式是否对」，不读正文、不执行命令、不联网。
 *
 * 为什么要机械检查：执行者是模型，会把「应该有」的文件写成「已经有」。中心只做能确定的事——
 * 文件在不在、是不是普通文件、是不是空的、图片的文件头对不对、是不是真的在这件事的主题文件夹里；
 * 内容是否满足约定，只能由核对人判断（证据的 check 字段原样给核对人和主人看）。
 *
 * 安全重点（主会话要求）：证据里的路径由模型填写，不可信。检查顺序是：
 *   1. 文字层面：必须是相对路径；不以 / 开头；任何一段是「..」一律拒绝（不是先规范化再放过）；
 *   2. 项目文件夹，以及从它到目标文件经过的每一级（含主题文件夹本身），只要有一级是符号链接就拒绝（与 project-put.ts 同一口径）；
 *   3. 目标的真实路径（realpath，已把符号链接全部展开）必须仍在主题文件夹的真实路径之内；
 *   4. 图片再用 readBytesWithin 按句柄读文件头：该函数逐级拒绝符号链接、多个硬链接，并核对真实位置。
 * 任何一步看不出来在文件夹之内，状态一律是 outside（不在主题文件夹里）。
 * 产出物（deliverables）和预览（preview）的文件用同一个函数 checkTopicFile 检查，口径不会走偏。
 */
import { posix } from 'node:path';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { within } from '../gate/paths.js';
import { resolveFixedRoot, resolveRealTarget } from '../gate/real-path.js';
import { PathContainmentError, ReadLimitError } from '../io/interfaces.js';
import type { Evidence, Job } from '../model/job.js';
import { isJobMaintainedPath, jobFolderPaths } from './files.js';

/** 执行者传入的一项证据（check 由中心写，不在这里）。 */
export interface EvidenceInput {
  kind: Evidence['kind'];
  path?: string | undefined;
  url?: string | undefined;
  summary: string;
  command?: string | undefined;
}

/** 文件类检查的结果：status 与 Evidence.check.status 同一套取值（不含 unchecked）。 */
export interface TopicFileCheck {
  status: 'ok' | 'missing' | 'empty' | 'not_image' | 'too_large' | 'outside';
  /** 给人看的一句话；ok 时是「文件存在，3.2 KB」。 */
  detail: string;
  size: number;
  /** 状态为 ok 时：目标文件的真实路径（符号链接已全部展开，已确认在主题文件夹的真实路径之内）。P74g 的读取与预览用它。 */
  real?: string;
}

/**
 * 路径里不允许出现的控制字符：空字符、换行、回车、制表符等（P74g 补充要求第 1 节，原来只拦空字符）。
 * 为什么：这类字符能让「给人看的路径」和「实际打开的路径」读出两个意思，也能截断系统调用里的字符串；文件名里正常不会有。
 */
export function hasControlChar(text: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(text);
}

/** 这个字符编码是不是控制字符、行分隔、零宽或方向控制字符、字节顺序标记。 */
function invisible(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
    || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}

/** 把路径写进给人看的句子之前去掉控制字符、截短，模型填的路径不能伪装成换行或另一句话。 */
function shown(path: string): string {
  const chars = Array.from(path).map(char => invisible(char.codePointAt(0)!) ? ' ' : char);
  return chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : chars.join('');
}

/** 大小换算成 KB 或 MB（一位小数）。 */
export function sizeText(size: number): string {
  return size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 从根往下列出 target 经过的每一级（不含根本身）。 */
function levelsBelow(root: string, target: string): string[] {
  const rest = posix.relative(root, target);
  if (rest === '') return [];
  const out: string[] = [];
  let current = root;
  for (const part of rest.split('/')) { current = posix.join(current, part); out.push(current); }
  return out;
}

/** 失败的检查结果。 */
const fail = (status: TopicFileCheck['status'], detail: string): TopicFileCheck => ({ status, detail, size: 0 });

/**
 * 检查「主题文件夹里的一个文件」：相对路径、不越界、不经过符号链接、存在、是普通文件、非空。
 * 证据（file、image）、产出物、预览共用。不读文件内容。
 */
export async function checkTopicFile(ctx: HubContext, job: Job, rel: string): Promise<TopicFileCheck> {
  const label = shown(rel);
  const outside = fail('outside', `${label} 不在主题文件夹里`);
  // 1. 文字层面：空、绝对路径、含空字符、任何一段是「..」都直接拒绝（不先规范化，规范化会把 a/../b 悄悄变成 b）。
  if (rel.trim() === '' || rel.startsWith('/') || hasControlChar(rel) || rel.split('/').some(part => part === '..')) return outside;
  const normalized = posix.normalize(rel.replace(/\/+$/, ''));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return outside;
  // P74r6（第 12 条）：放文件的工具（hub_project_put）的 to 从项目文件夹算起（jobs/<编号>/交付/…），交回时的路径从这件事的文件夹算起（交付/…），
  // 模型容易写混。只对「以这件事的文件夹路径开头」这一种写错，把怎样改说清；别的错误文字不动。
  if (normalized.startsWith(`${job.folder}/`)) {
    return fail('missing', `找不到 ${label}。路径从这件事的文件夹算起，去掉前面的 ${job.folder}/（例如写 ${D.FOLDER_FILES.delivery}/index.html）`);
  }
  const { projectDir, jobDir } = jobFolderPaths(ctx, job);
  const target = posix.join(jobDir, normalized);
  if (!within(target, jobDir) || target === jobDir) return outside;
  const fs = ctx.fs;
  // 系统错误（路径太长、权限等）一律按「不在主题文件夹里」处理，不把系统错误原文和绝对路径交给模型或主人（P74r4b 第 3 节）。
  let info: Awaited<ReturnType<typeof fs.stat>>;
  try {
    // 2. 符号链接：项目文件夹、主题文件夹的每一级、目标的每一级。
    if (fs.isSymlinkSync(projectDir)) return outside;
    for (const level of levelsBelow(projectDir, target)) {
      if (fs.isSymlinkSync(level)) return outside;
    }
    // 3. 存在、是普通文件、非空。
    info = await fs.stat(target);
  } catch { return outside; }
  if (info === null) return fail('missing', `找不到 ${label}`);
  // 4. 真实路径必须仍在主题文件夹的真实路径之内（符号链接都已展开）。
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await resolveFixedRoot(fs, jobDir);
    realTarget = await resolveRealTarget(fs, target);
  } catch {
    return outside; // 解析不出真实位置（权限、循环链接）按失败关闭处理。
  }
  if (!within(realTarget, realRoot)) return outside;
  if (info.isDir || info.isFile === false) return fail('missing', `${label} 不是普通文件`);
  if (info.size === 0) return fail('empty', `${label} 是空文件`);
  return { status: 'ok', detail: `文件存在，${sizeText(info.size)}`, size: info.size, real: realTarget };
}

/**
 * 主题文件夹里由中心写的文件（约定、主人原话、草图、材料文件夹里的文件）不能当作证据、产出物或预览（P74r2d 第 5 条）：
 * 它们是中心按主人的话和约定生成的，不是执行者做出来的东西；机械检查对它们照样是「文件存在」，会让核对人误以为是成果。
 * 判断沿用 hub_project_put 拒绝覆盖用的同一个函数（isJobMaintainedPath，已折叠大小写和 Unicode 写法）。
 * 路径写法本身不合规（绝对路径、含「..」）的这里不管，由 checkTopicFile 报「不在主题文件夹里」。返回错误文字，不是返回 null。
 */
export function centerWrittenError(job: Job, rel: string): string | null {
  if (rel.trim() === '' || rel.startsWith('/') || hasControlChar(rel) || rel.split('/').some(part => part === '..')) return null;
  const normalized = posix.normalize(rel.replace(/\/+$/, ''));
  return isJobMaintainedPath(posix.join(job.folder, normalized)) ? `${shown(rel)}是中心写的文件，不能当作证据或产出物。` : null;
}

/**
 * target 是不是在 root 之内（含 root 本身以外的任何层级），按路径逐段比较：先算 target 相对 root 的路径，
 * 相对路径以「..」开头、或仍是绝对路径、或为空（就是 root 本身）都算不在里面。
 * 为什么不用字符串前缀：「…/jobs/job_1」不能把「…/jobs/job_10/…」当成自己里面的；逐段比较没有这个问题，也不受大小写折叠影响。
 * 两个参数都要求是已经解析过的绝对路径。
 */
export function isInsideByParts(root: string, target: string): boolean {
  if (!posix.isAbsolute(root) || !posix.isAbsolute(target)) return false;
  const rest = posix.relative(root, target);
  return rest !== '' && rest !== '..' && !rest.startsWith('../') && !posix.isAbsolute(rest);
}

/** 目标文件的真实路径是否在这件事主题文件夹的真实路径之内（逐段比较）。解析不出主题文件夹的真实位置时按「不在」处理。 */
export async function realInsideTopic(ctx: HubContext, job: Job, real: string): Promise<boolean> {
  try {
    const { jobDir } = jobFolderPaths(ctx, job);
    return isInsideByParts(await resolveFixedRoot(ctx.fs, jobDir), real);
  } catch { return false; }
}

/** 各种图片格式的文件头是否与扩展名一致。 */
function headerMatches(ext: string, bytes: Uint8Array): boolean {
  const at = (index: number): number => bytes[index] ?? -1;
  switch (ext) {
    case 'png': return at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47;
    case 'jpg': case 'jpeg': return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
    case 'gif': return at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38;
    case 'webp': return at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
      && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50;
    default: return false;
  }
}

/** 检查一张图片：先按文件检查，再查扩展名、大小、文件头（只取前 16 字节比对）。 */
export async function checkTopicImage(ctx: HubContext, job: Job, rel: string): Promise<TopicFileCheck> {
  return (await loadTopicImage(ctx, job, rel)).check;
}

/** 图片检查的结果：检查结论；通过时附带读到的全部字节和小写扩展名（P74g 读取截图用，不必再读一遍）。 */
export interface LoadedImage { check: TopicFileCheck; bytes: Uint8Array | null; ext: string }

/**
 * 图片检查的完整版：与 checkTopicImage 同一套判断，通过时把已经按句柄读到的字节一并交出。
 * 为什么放在这里：读取截图（evidence-read.ts）必须先做完全相同的路径与图片检查，再读字节；
 * 单独另写一套检查会出现两处口径不一致，所以共用这一个函数。
 */
export async function loadTopicImage(ctx: HubContext, job: Job, rel: string): Promise<LoadedImage> {
  const ext = posix.extname(rel).slice(1).toLowerCase();
  const base = await checkTopicFile(ctx, job, rel);
  if (base.status !== 'ok') return { check: base, bytes: null, ext };
  const label = shown(rel);
  const refuse = (check: TopicFileCheck): LoadedImage => ({ check, bytes: null, ext });
  // 真实路径再按「逐段比较」核对一次（checkTopicFile 里用的是带大小写折叠的前缀判断，这里不依赖它）。
  if (base.real === undefined || !(await realInsideTopic(ctx, job, base.real))) return refuse(fail('outside', `${label} 不在主题文件夹里`));
  if (!D.IMAGE_EXTS.includes(ext)) return refuse(fail('not_image', `${label} 不是图片`));
  const tooLarge = fail('too_large', `${label} 超过 ${D.IMAGE_MAX_BYTES / (1024 * 1024)} MB`);
  if (base.size > D.IMAGE_MAX_BYTES) return refuse(tooLarge);
  const { jobDir } = jobFolderPaths(ctx, job);
  let bytes: Uint8Array | null;
  try {
    // 按句柄读，且 within 是主题文件夹：路径上有符号链接、多个硬链接、真实位置跑出文件夹，都会抛 PathContainmentError。
    bytes = await ctx.fs.readBytesWithin(posix.join(jobDir, posix.normalize(rel.replace(/\/+$/, ''))), { within: jobDir, maxBytes: D.IMAGE_MAX_BYTES });
  } catch (error) {
    if (error instanceof ReadLimitError) return refuse(tooLarge);
    if (error instanceof PathContainmentError) return refuse(fail('outside', `${label} 不在主题文件夹里`));
    throw error;
  }
  if (bytes === null) return refuse(fail('missing', `找不到 ${label}`));
  if (!headerMatches(ext, bytes.subarray(0, 16))) return refuse(fail('not_image', `${label} 不是图片`));
  return { check: { status: 'ok', detail: `图片，${sizeText(base.size)}`, size: base.size, ...(base.real === undefined ? {} : { real: base.real }) }, bytes, ext };
}

/** 网址只接受 http、https，必须有主机、没有空白、不带用户名密码。解析不了返回 null。 */
export function parseHttpUrl(text: string): URL | null {
  if (!/^https?:\/\//i.test(text) || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.username !== '' || url.password !== '') return null;
    return url;
  } catch { return null; }
}

/**
 * 一项证据在格式上有没有问题（kind 与 path、url、command 的搭配）；没有问题返回 null。
 * 这类问题是「写错了」而不是「文件有问题」，所以不生成 Evidence，由交回的校验逐条报错。
 */
export function evidenceFormatError(input: EvidenceInput): string | null {
  const has = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';
  switch (input.kind) {
    case 'file': case 'image':
      if (!has(input.path)) return `${input.kind} 类型的证据必须写 path（主题文件夹里的相对路径）`;
      if (input.url !== undefined) return `${input.kind} 类型的证据不能写 url`;
      if (input.command !== undefined) return `${input.kind} 类型的证据不能写 command，command 只给 test 类型`;
      return null;
    case 'link':
      if (!has(input.url)) return 'link 类型的证据必须写 url（以 http:// 或 https:// 开头）';
      if (input.path !== undefined) return 'link 类型的证据不能写 path';
      if (input.command !== undefined) return 'link 类型的证据不能写 command，command 只给 test 类型';
      if (parseHttpUrl(input.url!.trim()) === null) return `url：只接受 http:// 或 https:// 开头的网址（${shown(input.url!)}）`;
      return null;
    case 'test':
      if (input.path !== undefined || input.url !== undefined) return 'test 类型的证据不能写 path 或 url；复跑命令写在 command 里';
      return null;
  }
}

/** 链接显示用的主机名。 */
export function hostOf(url: string): string {
  return parseHttpUrl(url)?.hostname ?? url;
}

/**
 * 机械检查一项证据，返回写好 check 的 Evidence。
 * file、image 查文件；test、link 只查格式（状态 unchecked，中心不执行命令、不联网）。
 * 格式问题（evidenceFormatError）会直接抛出中文错误；调用方应先用 evidenceFormatError 逐条收集。
 */
export async function checkEvidence(ctx: HubContext, job: Job, input: EvidenceInput, id = 'ev1'): Promise<Evidence> {
  const problem = evidenceFormatError(input);
  if (problem !== null) throw new Error(problem);
  const base = { id, kind: input.kind, path: input.path?.trim() ?? null, url: input.url?.trim() ?? null,
    summary: input.summary.trim(), command: input.command?.trim() ?? null };
  if (input.kind === 'test') return { ...base, check: { status: 'unchecked', detail: '中心不执行命令，由核对人复跑' } };
  if (input.kind === 'link') return { ...base, check: { status: 'unchecked', detail: '中心不打开链接，由核对人查看' } };
  const result = input.kind === 'image' ? await checkTopicImage(ctx, job, base.path!) : await checkTopicFile(ctx, job, base.path!);
  return { ...base, check: { status: result.status, detail: result.detail } };
}

/** 允许的本机主机名（URL 解析之后的 hostname，IPv6 带方括号）。 */
const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * 预览地址是否是允许的本机地址；合格返回解析后的标准写法，不合格返回 null。
 * 交回时（previewError）和打开前（job/preview.ts）共用这一个函数，两边口径一致：
 * 用地址解析判断；协议 http 或 https；主机名恰好是本机；不带用户名密码；整个地址只含可见英文字符。
 */
export function localPreviewUrl(text: string): string | null {
  // 整个地址必须是可见的英文字符：空白、换行、控制字符、零宽字符、全角字符都不行（解析器会悄悄去掉或改写其中一部分）。
  if (!/^[\x21-\x7e]+$/.test(text)) return null;
  // P74r4b：命令行里有特殊含义的字符一律拒绝（Linux 的 xdg-open 是脚本，个别桌面环境会对参数求值）。
  if (hasForbiddenUrlChar(text)) return null;
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (!LOCAL_HOSTS.includes(url.hostname)) return null;
  // 解析后的标准写法也查一次（解析器可能把某些写法改成带这些字符的形式）。
  if (hasForbiddenUrlChar(url.href)) return null;
  return url.href;
}

/** 预览地址里不允许出现的字符（P74r4b 第 2 节第 4 点，审查疑点 4）。给人看的说明里逐个列出。 */
export const PREVIEW_URL_FORBIDDEN_CHARS = ['$', '`', ';', '|', '&', '(', ')', '<', '>', "'", '"', '\\', '*', '!'] as const;
/** 地址里有没有上面那些字符。 */
export function hasForbiddenUrlChar(text: string): boolean {
  return PREVIEW_URL_FORBIDDEN_CHARS.some(char => text.includes(char));
}

/** 预览文件允许的最大字节数（20 MB）：再大的网页不当作可打开的预览。交回时和打开时都按它判断。 */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** 预览文件的检查结果：通过时给真实路径；不通过时给一句不含绝对路径和系统错误原文的说明。 */
export type PreviewFileCheck = { ok: true; real: string } | { ok: false; detail: string; notInDelivery?: true };

/**
 * 预览文件的检查，交回时（previewError）和打开时（job/preview.ts）共用这一个函数（P74r4b 第 3 节）：
 * 文字（控制字符、前后空白、扩展名）、中心写的文件、checkTopicFile（符号链接、真实路径、普通文件、非空）、
 * 真实路径逐段比较、真实扩展名、大小上限、按句柄再读一次（硬链接、检查之后被换掉）。
 * 任何系统错误都按「不在主题文件夹里」处理，不抛出。
 */
export async function previewFileCheck(ctx: HubContext, job: Job, text: string): Promise<PreviewFileCheck> {
  const gone: PreviewFileCheck = { ok: false, detail: `${shown(text)} 不在主题文件夹里` };
  try {
    if (hasControlChar(text) || text !== text.trim() || !/\.html?$/i.test(text)) return gone;
    // P74r6（N8）：预览文件的相对路径不许出现命令行里有特殊含义的字符（与预览地址用同一组）：Linux 上打开时路径会交给系统程序。
    // 交回时和打开时用同一个判断；中文、空格、连字符、下划线、点照常可以。
    if (hasForbiddenUrlChar(text)) {
      return { ok: false, detail: `预览文件的路径里不能含这些字符：${PREVIEW_URL_FORBIDDEN_CHARS.join(' ')}（现在是 ${shown(text)}）。改个文件名再交回。` };
    }
    if (centerWrittenError(job, text) !== null) return gone;
    const checked = await checkTopicFile(ctx, job, text);
    if (checked.status !== 'ok' || checked.real === undefined) return { ok: false, detail: checked.detail };
    // 真实路径：逐段比较确认在主题文件夹里，扩展名按真实路径再判断。
    if (!(await realInsideTopic(ctx, job, checked.real)) || !/\.html?$/i.test(checked.real)) return gone;
    // P74r4b-m1：预览文件必须在这件事的「交付」文件夹里（打开预览时只复制这个文件夹）。交回时和打开时同一个判断（真实路径逐段比较）。
    const { jobDir: topicDir } = jobFolderPaths(ctx, job);
    const deliveryReal = await ctx.fs.realpath(posix.join(topicDir, D.FOLDER_FILES.delivery));
    if (!isInsideByParts(deliveryReal, checked.real)) {
      return { ok: false, notInDelivery: true,
        detail: `预览文件要放在这件事的「${D.FOLDER_FILES.delivery}」文件夹里（现在是 ${shown(text)}）。放进「${D.FOLDER_FILES.delivery}」文件夹后再交回，或者不写 preview。` };
    }
    if (checked.size > PREVIEW_MAX_BYTES) return { ok: false, detail: `${shown(text)} 超过 ${PREVIEW_MAX_BYTES / (1024 * 1024)} MB` };
    // 再按句柄读一次：路径上有符号链接、文件有多个硬链接（可能是文件夹之外的文件的硬链接）、真实位置跑出主题文件夹、
    // 打开之后指向了别的文件，readBytesWithin 都会抛出，一律拒绝。
    const { jobDir } = jobFolderPaths(ctx, job);
    const bytes = await ctx.fs.readBytesWithin(posix.join(jobDir, posix.normalize(text.replace(/\/+$/, ''))), { within: jobDir, maxBytes: Math.max(checked.size, 1) });
    if (bytes === null) return gone;
    return { ok: true, real: checked.real };
  } catch { return gone; }
}

/** 预览入口检查：主题文件夹里已存在的 html 文件，或本机地址（同 localPreviewUrl）。返回错误文字，通过为 null。 */
export async function previewError(ctx: HubContext, job: Job, preview: string): Promise<string | null> {
  const text = preview.trim();
  const rule = 'preview：只接受主题文件夹里已存在的 .html 文件，或本机地址（http 或 https，主机只能写 localhost、127.0.0.1 或 [::1]，不能带用户名密码）';
  // 带协议的写法（含前面有空白的）一律按地址判断，用没有去掉空白的原文。
  if (/^\s*[a-z][a-z0-9+.-]*:/i.test(preview)) {
    if (localPreviewUrl(preview) !== null) return null;
    // 带了命令行里有特殊含义的字符时，把话说清（P74r4b）。
    const forbidden = hasForbiddenUrlChar(preview) ? `；地址里也不能含这些字符：${PREVIEW_URL_FORBIDDEN_CHARS.join(' ')}` : '';
    return `${rule}${forbidden}（${shown(text)}）`;
  }
  const centerWritten = centerWrittenError(job, text);
  if (centerWritten !== null) return centerWritten;
  if (!/\.html?$/i.test(text)) return `${rule}（${shown(text)}）`;
  // 与打开预览时同一个检查函数：硬链接、大小上限、超长路径等，交回时就能发现（P74r4b 第 3 节）。
  const result = await previewFileCheck(ctx, job, text);
  return result.ok ? null : `preview：${result.detail}`;
}
