/**
 * 项目挂接主人电脑上的工作文件夹（W7a）：主人选一个已有的文件夹或代码仓库，项目成员可以读，谁都不能写。
 *
 * 为什么单独一个文件：这是安全相关的判断，规则写成纯函数（checkWorkFolder），挂接命令用它核对
 * 「主人选的写法」和「解析符号链接之后的真实位置」两次；动作闸只认挂接时存下来的这两个位置。
 *
 * 和发布位置（local-dir.ts 的 launch.localDir）的区别：发布位置是要写的，所以第一级只允许五个白名单；
 * 工作文件夹只读，代码仓库常放在 ~/code、~/projects 这类位置，所以放宽到「主目录下的一个具体文件夹」，
 * 但仍然拒绝：主目录本身、桌面和文稿这类大目录本身、资源库和应用程序、隐藏目录、应用程序包、
 * 中心和员工的数据目录（以及它们的上级）、凭据位置。
 *
 * 只读怎么保证（三层）：
 * 1. 动作闸（gate/paths.ts）：路径落在任何一个工作文件夹里的写入一律拒绝（不计越界）；
 *    不是这个项目成员的员工去读，要主人确认；
 * 2. 中心代为运行的命令：可写范围里本来就没有它（gate/host-writable.ts），沙箱会拦；
 * 3. 发布位置不能落在工作文件夹里（local-dir.ts 把它加进必须避开的目录）。
 * 凭据文件（.env、密钥这类）照旧按 isSensitive 拒绝读取，挂接不放宽这一条。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { recordId } from '../model/primitives.js';
import type { Project, ProjectWorkFolder } from '../model/project.js';
import { ProjectWorkFolderSchema } from '../model/project.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { isSensitive } from '../gate/paths.js';
import {
  LOCAL_DIR_MAX_CHARS, foldSegment, hasBadPathChars, isPlainSegmentName, localDirEnvOf, sameLocalDirPath, segmentsOf,
  type LocalDirEnv,
} from './local-dir.js';

/** 第一级是这两个时一律拒绝：资源库里是应用的数据和凭据，应用程序里是程序本身。 */
const SYSTEM_FIRST_LEVELS = new Set(['Library', 'Applications'].map(foldSegment));
/** 这些大目录本身不能挂（里面的具体文件夹可以）：挂整个桌面或文稿等于把主人的全部文件交出去。 */
export const WORK_FOLDER_BROAD_DIRS = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music', 'Public', 'Sites'] as const;
const BROAD = new Set(WORK_FOLDER_BROAD_DIRS.map(foldSegment));
const APP_SUFFIXES = ['.app', '.bundle', '.framework', '.plugin', '.photoslibrary'] as const;

/** 拒绝原因（接在「工作文件夹不能用：」之后）。 */
export const WORK_FOLDER_REASONS = {
  noHome: '取不到你电脑的主目录，无法核对这个位置',
  notAbsolute: '不是完整路径（要以 / 或 ~/ 开头）',
  dotDot: '路径里含有 .. 这一段',
  badChars: '路径里含有换行、引号、反斜杠或看不见的字符',
  tooLong: `路径超过 ${LOCAL_DIR_MAX_CHARS} 个字符`,
  outsideHome: '不在你电脑的主目录之下',
  isHome: '不能挂整个主目录，请选一个具体的文件夹',
  broad: `不能挂 ${WORK_FOLDER_BROAD_DIRS.join('、')} 这类大目录本身，请选里面的一个具体文件夹`,
  hidden: '路径里有以点开头的隐藏目录',
  system: '不能选资源库（Library）或应用程序（Applications）里的位置',
  appBundle: '不能选应用程序包或资料库里面的位置',
  badName: '文件夹名只能包含文字、数字、空格、连字符、下划线、点和括号',
  center: '在中心的数据目录、员工的文件夹、共享文件夹、项目文件夹或 DSH 的数据目录之内，或者是它们的上级目录',
  sensitive: '这是存放密钥、凭据的位置',
  missing: '找不到这个文件夹',
  notDir: '这不是文件夹',
} as const;

export type WorkFolderCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * 校验并整理一个工作文件夹路径（纯函数，不读磁盘）。通过时返回整理后的绝对路径。
 * 检查顺序固定，同时有几处不合格时只报第一处。
 */
export function checkWorkFolder(input: string, env: LocalDirEnv): WorkFolderCheck {
  const fail = (reason: string): WorkFolderCheck => ({ ok: false, reason });
  const text = input.trim();
  if (hasBadPathChars(text)) return fail(WORK_FOLDER_REASONS.badChars);
  if ([...text].length > LOCAL_DIR_MAX_CHARS) return fail(WORK_FOLDER_REASONS.tooLong);
  let absolute = text;
  if (text === '~' || text.startsWith('~/')) {
    if (env.homes.length === 0) return fail(WORK_FOLDER_REASONS.noHome);
    absolute = env.homes[0]! + text.slice(1);
  } else if (!text.startsWith('/')) {
    return fail(WORK_FOLDER_REASONS.notAbsolute);
  }
  const segments = segmentsOf(absolute);
  if (segments.some(part => part === '..' || part === '.')) return fail(WORK_FOLDER_REASONS.dotDot);
  if (env.homes.length === 0) return fail(WORK_FOLDER_REASONS.noHome);
  const home = env.homes.find(candidate => segmentsOf(candidate).length > 0
    && segmentsOf(candidate).every((part, index) => segments[index] !== undefined && foldSegment(part) === foldSegment(segments[index]!)));
  if (home === undefined) return fail(WORK_FOLDER_REASONS.outsideHome);
  const rel = segments.slice(segmentsOf(home).length);
  if (rel.length === 0) return fail(WORK_FOLDER_REASONS.isHome);
  if (rel.some(part => part.startsWith('.'))) return fail(WORK_FOLDER_REASONS.hidden);
  if (SYSTEM_FIRST_LEVELS.has(foldSegment(rel[0]!))) return fail(WORK_FOLDER_REASONS.system);
  if (rel.length === 1 && BROAD.has(foldSegment(rel[0]!))) return fail(WORK_FOLDER_REASONS.broad);
  if (rel.some(part => APP_SUFFIXES.some(suffix => foldSegment(part).endsWith(suffix)))) return fail(WORK_FOLDER_REASONS.appBundle);
  if (rel.some(part => !isPlainSegmentName(part))) return fail(WORK_FOLDER_REASONS.badName);
  const covered = env.protectedRoots.some(root => {
    const rootSegments = segmentsOf(root);
    const startsWith = (whole: string[], prefix: string[]): boolean => prefix.length <= whole.length
      && prefix.every((part, index) => foldSegment(part) === foldSegment(whole[index]!));
    return rootSegments.length > 0 && (startsWith(segments, rootSegments) || startsWith(rootSegments, segments));
  });
  if (covered) return fail(WORK_FOLDER_REASONS.center);
  const path = `/${segments.join('/')}`;
  if (isSensitive(path)) return fail(WORK_FOLDER_REASONS.sensitive);
  if ([...path].length > LOCAL_DIR_MAX_CHARS) return fail(WORK_FOLDER_REASONS.tooLong);
  return { ok: true, path };
}

/** 一个项目挂接的工作文件夹在闸门里要认的位置：主人选的写法和真实位置（相同时只算一个）。 */
export function workFolderRoots(folder: ProjectWorkFolder | null | undefined): string[] {
  if (folder == null) return [];
  return sameLocalDirPath(folder.path, folder.realPath) ? [folder.path] : [folder.path, folder.realPath];
}

/** 所有项目挂接的工作文件夹（含已归档的项目：主人的文件夹不因项目归档就变得可写）。写入一律拒绝用它。 */
export function allWorkFolderRoots(ctx: HubContext): string[] {
  return [...new Set(ctx.store.table('projects').list().flatMap(project => workFolderRoots(project.workFolder)))];
}

/** 这位员工作为成员（含负责人）的、没有归档的项目挂接的工作文件夹。这些可以直接读。 */
export function memberWorkFolderRoots(ctx: HubContext, botId: string): string[] {
  return [...new Set(memberWorkFolders(ctx, botId).flatMap(item => workFolderRoots(item.folder)))];
}

/** 同上，带项目名（唤醒包的资料段要说清是哪个项目的）。 */
export function memberWorkFolders(ctx: HubContext, botId: string): Array<{ project: Project; folder: ProjectWorkFolder }> {
  return ctx.store.table('projects').list(row => row.archivedAt === null && row.status !== 'archived'
    && (row.memberBotIds.includes(botId) || row.ownerBotId === botId) && row.workFolder != null)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(project => ({ project, folder: project.workFolder! }));
}

/** 写入被拒时给员工看的话、不是成员去读时审批卡上的理由（定义在 gate/paths.ts）。 */
export { WORK_FOLDER_NON_MEMBER_READ, WORK_FOLDER_WRITE_REFUSAL } from '../gate/paths.js';

/**
 * 校验用的环境：和发布位置同一份「必须避开的目录」，但去掉各项目已挂接的工作文件夹本身
 * （几个项目挂同一个仓库是正常的，重新挂接同一处也不能被自己挡住）。
 */
export function workFolderEnvOf(ctx: HubContext, realHome?: string): LocalDirEnv {
  const env = localDirEnvOf(ctx, realHome);
  const attached = allWorkFolderRoots(ctx);
  return { homes: env.homes, protectedRoots: env.protectedRoots.filter(root => !attached.some(dir => sameLocalDirPath(root.replace(/\/+$/, ''), dir))) };
}

export const SetWorkFolderSchema = z.strictObject({
  projectId: recordId('prj'),
  /** 主人选的文件夹；null 表示取消挂接。 */
  path: z.string().trim().min(1, '工作文件夹路径不能为空').max(1000, '工作文件夹路径不能超过 1000 字').nullable(),
});

/**
 * 主人挂接、更换或取消项目的工作文件夹（只有主人的界面命令会调到这里；员工和总管没有对应工具）。
 * 先按主人选的写法核对，再确认它是一个存在的文件夹，最后解析符号链接、按真实位置再核对一次：
 * 链接指向主目录之外、隐藏目录或中心数据目录时拒绝。全部通过才写表、记审计。
 */
export async function setProjectWorkFolder(ctx: HubContext, raw: unknown): Promise<Project> {
  const input = parseInput(SetWorkFolderSchema, raw, '挂接工作文件夹');
  const project = ctx.store.table('projects').get(input.projectId);
  if (!project) throw new Error(`项目不存在：${input.projectId}`);
  if (project.archivedAt !== null || project.status === 'archived') throw new Error(`项目「${project.name}」已归档，不能再修改`);
  const now = ctx.clock.now();
  if (input.path === null) {
    if (project.workFolder == null) return project;
    const record = ctx.store.table('projects').patch(project.id, { workFolder: null, updatedAt: now });
    writeOutreachAudit(ctx, 'project_work_folder_clear', { id: project.id, name: project.name, path: project.workFolder.path }, 'owner', now);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    return record;
  }
  const refuse = (reason: string): never => { throw new Error(`工作文件夹不能用：${reason}。`); };
  let realHome: string | undefined;
  if (ctx.ownerHome) {
    try { realHome = (await ctx.fs.realpath(ctx.ownerHome)).replace(/\/+$/, ''); } catch { realHome = undefined; }
  }
  const env = workFolderEnvOf(ctx, realHome);
  const first = checkWorkFolder(input.path, env);
  if (!first.ok) return refuse(first.reason);
  const stat = await ctx.fs.stat(first.path);
  if (stat === null) return refuse(WORK_FOLDER_REASONS.missing);
  if (!stat.isDir) return refuse(WORK_FOLDER_REASONS.notDir);
  const real = (await ctx.fs.realpath(first.path)).replace(/\/+$/, '') || '/';
  const second = checkWorkFolder(real, env);
  if (!second.ok) return refuse(`它实际指向 ${real}，${second.reason}`);
  const workFolder: ProjectWorkFolder = ProjectWorkFolderSchema.parse({ path: first.path, realPath: second.path, approvedAt: now, approvedBy: 'owner' });
  const record = ctx.store.table('projects').patch(project.id, { workFolder, updatedAt: now });
  writeOutreachAudit(ctx, 'project_work_folder_set',
    { id: project.id, name: project.name, path: workFolder.path, realPath: workFolder.realPath, previous: project.workFolder?.path ?? null }, 'owner', now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return record;
}
