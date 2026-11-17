/**
 * 「只对这件事的发布命令放开约定里那一个本机文件夹」的判断（P81，决策 DC66；P81r1 收紧）。
 *
 * 背景：中心代为运行的命令只能写员工的文件夹、共享文件夹、项目文件夹、本机临时文件夹。主人在约定里确认过一个
 * 发布位置（launch.localDir）之后，这件事的发布命令可以多写这一个文件夹；别的命令（普通审批、别的事的发布、
 * 员工自己的工具）一律不放开。本文件管三个时机：
 * 1. 提交发布命令时的预先核对（launchDirForSubmit）：按约定里保存的路径，判断命令要写的位置算不算在可写范围内；
 * 2. 建审批卡时（launchDirShownForApproval）：审批卡的提示句要写上这个文件夹（显示路径）；
 * 3. 命令运行之前（localDirForRun）：重新核对一次，因为约定确认之后文件系统可能变了（符号链接等）。
 *
 * P81r1（S1、S6）的两处：
 * - 运行前核对不再整条解析符号链接：期望路径 = 主人主目录的真实路径 + 约定里主目录之下的各段，只解析它的上一级、
 *   再接回发布位置这一级的名字；发布位置这一级已存在时用 lstat 看它本身（符号链接或不是目录都不运行）。
 *   这样「主人确认的位置」与「实际放开的位置」在发布位置这一级上永远是同一个字面位置。
 * - 审批与约定的对应关系看审批旁表里记下的 launchLocalDir，不再比对提示句的文字；提示句只用于显示。
 *
 * 「是不是发布审批」只认中心记的事实：这张审批正是这件事 launch.approvalId 指的那一张、发布状态是「等批准」。
 * 判断入口统一在 job/launch-approval.ts 的 launchSubmissionOf（显示与绑定共用）。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { resolveRealTarget } from '../gate/real-path.js';
import { launchOf } from '../model/agreement.js';
import type { Job } from '../model/job.js';
import type { OutboxAction } from '../model/outreach.js';
import {
  LOCAL_DIR_CHANGED_REASON, checkLocalDir, localDirEnvOf, localDirRelativeOf, localDirShown, sameLocalDirPath,
} from '../project/local-dir.js';
import { lockedVersionOf } from './files.js';
import { executingJobOf, launchSubmissionOf } from './launch-approval.js';
import { launchJobOfOutbox } from './launch-result.js';

export { LOCAL_DIR_CHANGED_REASON };

/** 这件事固定下来的约定里的发布位置（已保存的绝对路径）；没有写返回 null。 */
export function agreedLocalDirOf(ctx: HubContext, job: Pick<Job, 'agreementId'>): string | null {
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  return agreement === null ? null : launchOf(lockedVersionOf(agreement).content)?.localDir ?? null;
}

/**
 * 提交前的预先核对用：这位员工此刻提交的命令若是这件事的发布审批，返回约定里的发布位置；否则 null（照旧不放开）。
 * 比建审批时略宽一点：发布状态是「等批准」时（可能带 replace 取代原来那条）也按发布审批看，
 * 放不放开的最终判断在建审批卡和运行时，这里只决定「提交时要不要拒绝」。
 */
export function launchDirForSubmit(ctx: HubContext, botId: string): string | null {
  const job = executingJobOf(ctx, botId);
  if (job === null || job.state !== 'done' || !['preparing', 'failed', 'approval'].includes(job.launch.state)) return null;
  return agreedLocalDirOf(ctx, job);
}

/** 建审批单时用：这张审批将是这件事的发布审批、约定里有发布位置时，返回它的显示路径（以 ~ 开头）；否则 undefined。 */
export function launchDirShownForApproval(ctx: HubContext, botId: string, replace: boolean): string | undefined {
  // 与 beginJobApproval 用同一个判断，带 replace 时两处不会给出不同的结论（P81r1，S6）。
  const submission = launchSubmissionOf(ctx, botId, replace);
  const saved = submission?.localDir ?? null;
  return saved === null ? undefined : localDirShown(saved, ctx.ownerHome);
}

/** 运行前核对不通过（审批单上记的位置与现在约定不一致、实际路径不合规、取不到真实路径、发布位置这一级是链接或不是目录）。 */
export class LocalDirChanged extends Error {
  constructor() { super(LOCAL_DIR_CHANGED_REASON); }
}

/**
 * 命令运行之前的核对（P81 第 3 节第 2 条；P81r1 第 3.1、3.4 节）。
 * - 这条命令不是某件事的发布审批：返回 null，什么都不放开；
 * - 是，但审批旁表没有记下发布位置（P81r1 之前建的旧审批）：返回 null，不放开也不报错，命令照常运行（写不进那个文件夹）；
 * - 是，且旁表记了位置：与约定里现在的位置按段比较，不相等或约定那边没有了：抛 LocalDirChanged；
 * - 相等：期望路径 = 主目录真实路径 + 约定里主目录之下的各段；只解析它的上一级、接回发布位置这一级的名字；
 *   结果必须通过 checkLocalDir 的全部条件；发布位置这一级已存在时用 lstat 看它本身，是符号链接或不是目录就抛 LocalDirChanged。
 */
export async function localDirForRun(ctx: HubContext, row: Pick<OutboxAction, 'approvalId'>): Promise<{ actual: string } | null> {
  const job = launchJobOfOutbox(ctx, row);
  if (job === null) return null;
  const saved = agreedLocalDirOf(ctx, job);
  const noted = ctx.store.table('approvalNotes').get(row.approvalId!)?.launchLocalDir ?? null;
  // 旧存档：审批旁表没有这个字段。不放开（命令照旧运行，但写不进发布位置），不报错。
  if (noted === null) return null;
  // 约定那边现在没有发布位置，或两边不是同一处：不放开，用「指向别处」的固定原因。
  if (saved === null || !sameLocalDirPath(noted, saved)) throw new LocalDirChanged();
  const home = ctx.ownerHome?.replace(/\/+$/, '');
  if (home === undefined || home === '') throw new LocalDirChanged();
  try {
    const realHome = (await resolveRealTarget(ctx.fs, home)).replace(/\/+$/, '');
    const rel = localDirRelativeOf(saved, home);
    if (rel === null) throw new LocalDirChanged();
    // 期望路径：真实主目录 + 约定里主目录之下的各段（发布位置这一级保留原来的名字，不跟着链接走）。
    const expected = posix.join(realHome, ...rel);
    const parent = posix.dirname(expected);
    // 只解析上一级目录的真实路径，再接回发布位置这一级的名字（与 gate/real-path.ts 的 resolveFixedRoot 同一做法）。
    const actual = posix.join(await resolveRealTarget(ctx.fs, parent), posix.basename(expected));
    const checked = checkLocalDir(actual, localDirEnvOf(ctx, realHome));
    if (!checked.ok) throw new LocalDirChanged();
    // 发布位置这一级已经存在时，不跟随链接地看它本身：是符号链接或不是目录，都不运行。
    const info = await ctx.fs.lstat(actual);
    if (info !== null && (info.isSymlink || !info.isDir)) throw new LocalDirChanged();
    return { actual: checked.path };
  } catch (error) {
    // 任何一步出错（包括取真实路径失败）都按「现在指向别处」处理：宁可不运行，也不放开一个核实不了的位置。
    if (error instanceof LocalDirChanged) throw error;
    throw new LocalDirChanged();
  }
}
