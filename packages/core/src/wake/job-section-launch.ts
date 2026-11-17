/**
 * 唤醒包「你手上的事」段里执行者在发布环节的两种写法（P74g，方案 5.6）。
 *
 * 为什么单独一个文件、整段替换：一件事验收之后状态是「已完成」，原来给执行者的那一段（怎样算做完、怎样交回）
 * 已经没有意义，继续写只会让模型去交回一件已经完成的事。发布环节只需要告诉他三件事：
 * 这件事叫什么、编号是什么；产出物在哪；下一步用哪个工具、写哪些参数。模型只用这一段里的文字就能调用成功。
 *
 * 两大类写法（P74r18b 起，发布命令由中心运行，员工不自己执行）：
 * - 准备中（发布状态 preparing）：提交发布审批，写 cost、undo、after 三行，批准前不要发布；批准后怎样回报也一并写明；
 *   并写明中心代为运行的命令可写范围，约定里的发布位置不在范围内时不要提交审批、交账写 blocked；
 * - 审批已经提交之后，按真实状态分四种（launchApprovalBody）：还在等批准、已批准中心正在运行、发布没有成功（failed）、
 *   命令已成功运行等补记网址（done 且没有网址）。
 *
 * 受「你手上的事」段上限和逐级压缩约束（job-section-fit.ts）：讲怎样提交、怎样回报的行在任何一级都不删；
 * 产出物很多时只压缩产出物清单（第一级起改相对路径，第四级只列前 8 项）。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import { HOST_COMMAND_CWD_RULE, HOST_WRITABLE_LIST, LAUNCH_LOCATION_BLOCKER } from '../gate/host-writable.js';
import { launchLinkOpen } from '../job/launch-turns.js';
import type { CompressLevel, FlexRow, JobBodyParts } from './job-section-fit.js';

/** 第四级产出物清单最多列几项（其余写「另有 n 项」）。 */
const DELIVERABLES_SHOWN_AT_MAX = 8;

/** P74r19 第 1 节第 8 条：发布准备正文新增的两行（逐字）。 */
export const LAUNCH_ONE_COMMAND_LINE = '发布用一条命令做完全部动作：要先建目录再复制时，写成一条命令（例如用 bash -c 把几步用 && 连起来）。同一时间只有一条发布命令在等主人批准。';
export const LAUNCH_NOTES_TRUTH_LINE = '审批卡上的三行只写这一条命令实际做的事，不写它没有做的事。';
/** P74r19 第 3 节第 3 条：发布准备正文新增的一行（逐字）。 */
export const LAUNCH_BLOCKER_WORDING_LINE = '交账写 blocked 时，blocker 用主人看得懂的一句话写清缺什么，不写内部的说法。';

/** P81：发布准备正文里的一行（逐字，任务卡 P81 第 3 节第 5 条；路径是约定里保存的绝对路径）。 */
export function launchLocalDirLine(absolutePath: string): string {
  return `这件事约定的发布位置是 ${absolutePath}，主人已在约定里确认，发布命令可以写入这个文件夹（只有这一个）。`;
}

/** P81r1（第 3.2 节第 7 条）：发布准备正文里，发布位置那一行之后的一行（逐字）。 */
export const LAUNCH_LOCAL_DIR_DOTTED_LINE = '这个文件夹里名字以点开头的文件和文件夹不能写入，也不能删除。';

/** 发布准备中的写法（逐字照任务卡第 3 节第 2 点）。 */
export function launchPrepareBody(job: Job, title: string, jobDir: string, deliverables: readonly string[], level: CompressLevel, launchHow: string | null = null, launchLocalDir: string | null = null): JobBodyParts {
  const head: string[] = [];
  // 第一级起路径改写成相对主题文件夹的路径，开头写一行说明（与执行者、核对人的段同一做法）。
  if (level >= 1) head.push(`下面的路径都相对于主题文件夹 ${jobDir}`);
  head.push(`「${title}」（jobId 为 ${job.id}）主人已验收。下一步是对外发布，必须先经主人批准。`);
  // P74r9：约定里写了发布方式时原样给出（主人确认过的就是要照办的）；head 在任何一级都不删。
  if (launchHow !== null) head.push(`约定里写的发布方式：${launchHow}`);
  const shown = level >= 4 ? deliverables.slice(0, DELIVERABLES_SHOWN_AT_MAX) : deliverables;
  const more = deliverables.length - shown.length;
  const flex: FlexRow = {
    items: shown.map(path => level >= 1 ? path : `${jobDir}/${path}`),
    render: kept => `产出物：${kept.length === 0 ? '无' : kept.join('、')}${more > 0 ? `；另有 ${more} 项，见主题文件夹的「${D.FOLDER_FILES.delivery}」` : ''}。`,
  };
  const tail = [
    '提交发布：用 hub_outbox_submit 提交发布要运行的命令（kind 写 run_command），why 写为什么发布、发布到哪里，并填 cost（会不会产生费用、多少）、undo（发布后能不能撤回、怎样撤回）、after（批准之后多久上线、上线后会发生什么）。批准前不要发布。',
    // P74r18b 第 4.4 节：中心代为运行的命令有可写范围，约定里的发布位置不在这个范围内时，不要提交审批，交账写 blocked。
    // P74r19：一条命令做完全部动作；审批卡三行只写这一条命令实际做的事。
    LAUNCH_ONE_COMMAND_LINE,
    LAUNCH_NOTES_TRUTH_LINE,
    // P74r19 第 3 节：发布位置写不进去时 blocker 逐字写固定的一句，中心据此给主人说固定的话，不引用执行者的原话。
    `中心代为运行的发布命令只能写：${HOST_WRITABLE_LIST}。约定里的发布位置不在这个范围内时，不要提交审批，交账写 blocked，blocker 逐字写：${LAUNCH_LOCATION_BLOCKER}。`,
    // P82（缺陷 4）：真实模型把 cwd 写成沙箱之外的目录，命令被拒；工具说明与这里共用同一句。
    HOST_COMMAND_CWD_RULE,
    // P81：约定里写了发布位置（本机文件夹）时，可写范围那一行之后加一行（逐字）。
    // P81r1：再补一句点开头的条目写不进、也删不掉（沙箱规则里同样拒绝）。
    ...(launchLocalDir === null ? [] : [launchLocalDirLine(launchLocalDir), LAUNCH_LOCAL_DIR_DOTTED_LINE]),
    '批准后：由中心运行这条命令，你不用再做任何事；结果出来中心会叫醒你。主人拒绝时也不用做任何事。',
    // P74r7：缺发布条件时不猜、不提问，交账写 blocked，中心转告主人，这一步到此结束。
    '约定和材料里没有写发布到哪里、用什么方式时：不要猜，也不要提问。交账的结果写 blocked，blocker 写清缺什么；中心会转告主人，这一步到此结束。',
    // P74r19 第 3 节第 3 条。
    LAUNCH_BLOCKER_WORDING_LINE,
  ];
  return { head, flex: [flex], note: null, tail };
}

/**
 * 这件事的执行者此刻要看发布的写法吗（P74r18b）：已完成，并且发布状态是准备中、等批准、发布没有成功，
 * 或命令已成功运行、等执行者补记网址（link 为空）。
 */
export function inLaunchSection(job: Job): boolean {
  return job.state === 'done' && (job.launch.state === 'preparing' || job.launch.state === 'approval' || job.launch.state === 'failed' || launchLinkOpen(job));
}

/**
 * 发布审批已经提交之后的写法，按真实状态分四种（P74r18b，发布命令由中心运行，员工不自己执行、也不再次调用）：
 * - 还在等主人批准：什么都不用做；
 * - 已批准、中心正在运行：这一回合不用做任何事，直接交账，结果出来中心会叫醒他（有了第 1 节，这种状态下一般不会叫醒他，这一句只作兜底）；
 * - 发布没有成功（failed）：按唤醒原因里的说明改正重提，或交账写 blocked；
 * - 命令已成功运行、已记为已发布但还没有网址：有网址用 launched 补记，没有就交账收尾。
 * 每一种都先写一行「标题和 jobId」：后面调用工具要用这个 jobId。
 */
export function launchApprovalBody(ctx: HubContext, job: Job, title: string): JobBodyParts {
  const approval = job.launch.approvalId === null ? null : ctx.store.table('approvals').get(job.launch.approvalId);
  const approved = approval !== null && (approval.status === 'approved' || approval.status === 'used');
  const who = `「${title}」（jobId 为 ${job.id}）`;
  let tail: string[];
  if (job.launch.state === 'failed') {
    tail = [who, '发布命令运行失败，这件事没有发布。按这次叫醒你的原因里的说明处理：命令本身写错了，就改正后重新提交一次发布审批；是发布的位置中心写不进去，或别的你解决不了的原因，就交账写 blocked，说明原因。不要自己更换约定里写的发布位置。'];
  } else if (job.launch.state === 'done') {
    tail = [who, `发布命令已成功运行，这件事已记为已发布。发布之后有可以访问的网址时，调用 hub_job_work，mode 写 launched，jobId 写 ${job.id}，link 写网址（http:// 或 https:// 开头）；没有网址就直接交账收尾。`];
  } else if (approved) {
    tail = [who, '发布申请主人已批准，中心正在运行发布命令。这一回合不用做任何事，直接交账；结果出来中心会叫醒你。'];
  } else {
    tail = [`${who}的发布申请在等主人批准。批准前不要发布，也不用做别的。`];
  }
  return { head: [], flex: [], note: null, tail };
}
