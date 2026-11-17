/**
 * 中心代为运行命令时「可写范围」的唯一清单（P74r18b 第 4 节）。
 *
 * 为什么单独一个文件：以前沙箱规则（system-sandbox.ts）、审批卡上的提示句、员工看到的工具说明、
 * 回执里的明细各写各的，彼此不一致（审批卡写「系统临时目录」，实际 /tmp 写不进去）。
 * 现在只有这里一份清单：沙箱规则从它来，给主人和模型看的文字从它生成，提交前的「预先核对」也用它。
 *
 * 清单（与 DSH 给员工自己的命令工具的范围对齐，再加上中心共享目录）：
 * - 这位员工的家目录；
 * - 中心共享目录；
 * - 这位员工所在项目的项目文件夹（项目里由中心维护的文件 context.md 除外，放进拒绝清单）；
 * - 本机临时文件夹：/tmp（真实路径 /private/tmp）；系统的 $TMPDIR 由沙箱实现自动加入。
 * 联网不受限。工作数据目录即使有授权也一律拒绝（由调用方传入拒绝清单）。
 *
 * 本文件只放纯函数，不读磁盘，方便单测；真正的写入限制仍由 macOS 沙箱（system-sandbox.ts）执行。
 */
import { posix } from 'node:path';
import { PROJECT_CONTEXT_FILE } from '../project/context.js';
import { isCenterProjectFile, isUnresolvedPath, within } from './paths.js';
import { listTargets } from './sandbox-rules.js';

/** 本机临时文件夹的真实路径。沙箱规则按真实路径匹配，写 /tmp 其实落在这里。 */
export const HOST_TMP_ROOT = '/private/tmp';
/** 给人和模型看的一句「可写范围」（逐字，与任务卡 4.3、4.4 一致）。 */
export const HOST_WRITABLE_LIST = '你的文件夹、共享文件夹、项目文件夹、本机临时文件夹（含 /tmp）；可以联网';

/**
 * P82（缺陷 4）：中心代为运行命令时，执行目录（cwd）的硬性要求（与 gate/outbox.ts 运行前的核对同一句话）。
 * 真实模型曾把 cwd 写成沙箱目录之外的 /tmp/xxx，命令被中心拒绝；工具说明和发布准备正文都要写明这一句。
 */
export const HOST_COMMAND_CWD_RULE = '命令执行目录必须在家目录或共享目录内。';

/** 这位员工当次命令的几处目录。 */
export interface HostWritableDirs {
  homeDir: string;
  sharedDir: string;
  /** 这位员工所在项目的项目文件夹；不在任何项目里时为空。 */
  projectDirs: readonly string[];
  /**
   * P81：只对「这件事的发布审批」那一条命令放开的一个本机文件夹（主人在约定里确认过的 launch.localDir）。
   * 运行时是解析符号链接之后、并通过校验的「实际路径」；提交时的预先核对用约定里保存的路径。其他命令一律没有这一项。
   */
  localDir?: string | undefined;
}

/**
 * 交给沙箱的清单：可写的目录、必须拒绝的位置。
 * mayCreateRoots（P81）：可写目录里「允许还不存在」的那几个（只有发布位置）：沙箱对它们按「最深的已存在上级目录 + 剩下几段」处理，命令可以自己建出它。
 * 没有发布位置时不带这一项，与以前的清单完全一致。
 */
export interface HostSandboxRules { writableRoots: string[]; denyWriteRoots: string[]; mayCreateRoots?: string[] }

/** 沙箱可写的目录：家目录、共享目录、项目文件夹、本机临时文件夹（真实路径），以及（仅发布审批）约定的发布位置。 */
export function hostWritableRoots(dirs: HostWritableDirs, tmpRootExists = true): string[] {
  // 可写根必须是已存在的目录，否则沙箱整条命令都起不来（非 macOS 的机器上没有 /private/tmp）：不存在就不放进清单。
  return [dirs.homeDir, dirs.sharedDir, ...dirs.projectDirs, ...(tmpRootExists ? [HOST_TMP_ROOT] : []), ...(dirs.localDir === undefined ? [] : [dirs.localDir])];
}

/** 项目文件夹里由中心维护的文件：即使在可写的项目文件夹里也不可写。 */
export function hostCenterFiles(projectDirs: readonly string[]): string[] {
  return projectDirs.map(dir => posix.join(dir, PROJECT_CONTEXT_FILE));
}

/** 完整的沙箱规则：可写目录，加上拒绝清单（工作数据目录、项目里中心维护的文件）。 */
export function hostSandboxRules(dirs: HostWritableDirs, workDataDenyRoots: readonly string[], tmpRootExists = true): HostSandboxRules {
  return { writableRoots: hostWritableRoots(dirs, tmpRootExists), denyWriteRoots: [...workDataDenyRoots, ...hostCenterFiles(dirs.projectDirs)],
    ...(dirs.localDir === undefined ? {} : { mayCreateRoots: [dirs.localDir] }) };
}

/**
 * 审批卡上给主人看的风险提示（逐字，任务卡 4.2；P81 加了发布位置）。
 * 员工不在任何项目里时去掉「项目文件夹、」；name 是员工名；
 * localShown（P81）：这条命令是某件事的发布审批、约定里有发布位置时，在「本机临时文件夹」后面写上它的显示路径（以 ~ 开头）。
 */
export function hostCommandRiskNote(name: string, hasProject: boolean, localShown?: string): string {
  return `批准后这条命令只能写入：${name}的文件夹、共享文件夹、${hasProject ? '项目文件夹、' : ''}本机临时文件夹${localShown === undefined ? '' : `、${localShown}`}；可以联网。不确定这条命令的作用时，请拒绝。`;
}

/** 给模型看的工具说明里的范围（与上面同一份清单）。 */
export function hostWritableModelText(): string {
  return `只能写${HOST_WRITABLE_LIST}`;
}

/**
 * 提交时发现命令要写可写范围之外的位置，拒绝文字（给模型看，逐字，任务卡 4.3）。
 * 路径最多列 3 个，写法同 sandbox-rules.ts 的 listTargets。
 */
export function hostWriteRefusal(outside: readonly string[]): string {
  return `这条命令要写 ${listTargets(outside)}，中心代为运行时写不进去。中心代为运行的命令只能写：${HOST_WRITABLE_LIST}。这是约定里写明的发布位置时，不要更换位置，交账写 blocked，blocker 逐字写：${LAUNCH_LOCATION_BLOCKER}。`;
}

/**
 * P74r19 第 3 节：发布位置写不进去时，执行者交账 blocker 里逐字写的那一句（唤醒包正文、预先核对的拒绝文字都用它）。
 * 总管私聊那句固定的话（job/launch-blocked.ts）据此认出「这是发布位置写不进去」，不再引用执行者的原话。
 */
export const LAUNCH_LOCATION_BLOCKER = '发布位置不在能写入的范围内';

/** 系统每用户临时目录（macOS 的 $TMPDIR，形如 /private/var/folders/xx/yyyy/T）：沙箱实现会自动加入，提交前核对时一并认作可写。 */
const SYSTEM_USER_TMP = /^\/private\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/;

/** 这一个路径中心代为运行时写不写得进去（只看路径文字；符号链接等由沙箱在运行时拦）。 */
function writableInRange(path: string, dirs: HostWritableDirs): boolean {
  // 先做别名规范化（/tmp、/var 与 /private 下的真实路径是同一处）再比较：within 内部已经折叠。
  if (path === '/dev/null') return true;
  if (within(path, '/tmp') || within(path, HOST_TMP_ROOT)) return true;
  // 系统临时目录：within 折叠别名后用同一条正则判断。
  if (SYSTEM_USER_TMP.test(path.replace(/^\/var(?=\/)/, '/private/var'))) return true;
  if (within(path, dirs.homeDir) || within(path, dirs.sharedDir)) return true;
  // P81：发布审批的命令可以写约定里的发布位置（within 按段比较，不分大小写）。
  if (dirs.localDir !== undefined && within(path, dirs.localDir)) return true;
  return dirs.projectDirs.some(dir => within(path, dir) && !isCenterProjectFile(path, dir));
}

/**
 * 提交前的「预先核对」：命令要写的路径里，哪些在可写范围之外。
 * 只看已经解析成绝对路径的；含变量、~ 的（分析不出落在哪里的）不判，照旧可以提交。
 * 返回的是原路径（给拒绝文字列出）。
 */
export function pathsOutsideHostWritable(paths: readonly string[] | undefined, dirs: HostWritableDirs): string[] {
  const outside: string[] = [];
  for (const path of paths ?? []) {
    if (!path.startsWith('/') || isUnresolvedPath(path)) continue;
    if (!writableInRange(posix.normalize(path), dirs) && !outside.includes(path)) outside.push(path);
  }
  return outside;
}
