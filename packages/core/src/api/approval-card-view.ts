/**
 * 审批卡的三行说明与「由谁执行」（P74g）：纯函数加 zod 结构。
 *
 * 为什么单独放一个文件：审批卡的结构（api/types.ts 的 ApprovalCardParts）要给插件的一致性测试校验，
 * 类型和校验共用同一份定义；三行说明的「缺的项写未说明、只有 C、D 类才给」是纯规则，放在这里便于单测。
 */
import { z } from 'zod';
import type { ApprovalNote, Job } from '../model/job.js';
import type { Approval } from '../model/outreach.js';
import { LAUNCH_UNSPECIFIED } from '../job/launch-approval.js';
import { stableStringify } from '../util/hash.js';

/** 审批卡的三行：费用、能否撤回、批准之后；每一项一定有文字。 */
export const ApprovalNotesViewSchema = z.strictObject({ cost: z.string(), undo: z.string(), after: z.string() });

/** 审批卡的分段内容（与 api/types.ts 的 ApprovalCardParts 同形）。 */
export const ApprovalCardPartsSchema = z.strictObject({
  actionText: z.string(),
  ownerReason: z.string().nullable(),
  riskNote: z.string().nullable(),
  argsPreview: z.string(),
  notes: ApprovalNotesViewSchema.nullable(), // P74r9：非发布审批且员工一行都没写时为 null
  onBehalfOf: z.string().nullable(),
  launch: z.boolean(),
  voided: z.boolean(),
  // P74r20 补做：这条审批对应的命令全文（可省略；拿不到全文时没有这一项，界面退回显示 argsPreview）。只放在给主人看的审批卡视图里。
  argsFull: z.string().optional(),
});

/** 命令全文最多显示多少个字符；超过时保留前面这么多，末尾另起一行写明总字数。 */
export const ARGS_FULL_MAX_CHARS = 4000;
/** 审批记录里的 argsPreview 超长时中心写入的省略标记（gate/approvals.ts 的 approvalPreview）；带它说明记录里的不是全文。 */
const STORED_PREVIEW_CUT_MARK = '\n……中间省略……\n';

/** 命令全文超过上限时的处理：保留前 4000 个字符，末尾另起一行写一句话（逐字）。 */
export function clipArgsFull(full: string): string {
  const chars = Array.from(full);
  if (chars.length <= ARGS_FULL_MAX_CHARS) return full;
  return `${chars.slice(0, ARGS_FULL_MAX_CHARS).join('')}\n（命令共 ${chars.length} 个字符，这里只显示前 4000 个。看不到完整命令时，请拒绝。）`;
}

/**
 * 审批卡上「查看原始命令」要显示的命令全文（P74r20 补做）。全文的来源：
 * 1. 这条审批对应的出站记录（中心代为运行的命令，发布审批都是这一类）：记录里的负载没有被截断过，
 *    按审批时同一份参数（kind、payload，运行命令再加 commandFiles）稳定序列化；
 * 2. 没有出站记录时：审批记录的 argsPreview，但只在它没有被截断过时才算全文（超过 approvalPreviewMaxBytes 时
 *    中心在存入时就已经截成「前 400 字、省略标记、后 400 字」，那之后全文已不存在）；
 * 3. 都拿不到全文：返回 undefined，视图不带 argsFull，界面显示 argsPreview。
 */
export function approvalArgsFull(approval: Pick<Approval, 'argsPreview'>, outbox: { kind: string; payload: unknown; commandFiles?: unknown } | null): string | undefined {
  if (outbox !== null) {
    return clipArgsFull(stableStringify({ kind: outbox.kind, payload: outbox.payload, ...(outbox.kind === 'run_command' ? { commandFiles: outbox.commandFiles ?? [] } : {}) }));
  }
  if (approval.argsPreview.includes(STORED_PREVIEW_CUT_MARK)) return undefined;
  return clipArgsFull(approval.argsPreview);
}

/**
 * P74r4b 第 5 节：这张审批是不是某件事「发布这一步」的审批。判断：
 * 1. 审批属于一件事（审批旁表里记着这件事的编号，由调用方按旁表找到这件事传进来；不属于任何事传 null）；
 * 2. 这件事约定里有发布这一步（launchStep），并且已经验收（acceptedAt 有值）；
 * 3. 这张审批是验收之后才提交的（createdAt 不早于 acceptedAt）。验收之前、执行中提交的审批属于这件事，但不是发布审批。
 * P74r6（N10）：再加第四条——只对这件事记录上记下的那一张发布审批（launch.approvalId）为真；这件事别的审批、
 * 发布这一步结束之后新提交的审批为假（拒绝它不影响发布状态，不该写成「暂不发布」）。
 * 界面据此把按钮写成「批准发布」「暂不发布」；答复的处理不变，仍按批准、拒绝两个动作，不看按钮文字。
 */
export function isLaunchApproval(job: Pick<Job, 'launchStep' | 'acceptedAt' | 'launch'> | null, approval: Pick<Approval, 'id' | 'createdAt'>): boolean {
  return job !== null && job.launchStep && job.acceptedAt !== null && approval.createdAt >= job.acceptedAt
    && job.launch.approvalId === approval.id;
}

/**
 * 三行说明的视图（P74r9 第 3 节）。三行本意是发布审批上由执行者填写的说明；被中心拦下的普通命令生成的审批没有人填，
 * 全写「未说明」对主人没有信息量。所以：
 * - 这张审批是发布这一步的审批（isLaunch 为真）：照原来的做法给三行，员工没写的项写「未说明」（让主人看见执行者没有写）；
 * - 不是发布审批、而员工提交时写了至少一行：给三行，没写的项写「未说明」；
 * - 不是发布审批、一行都没有写（或没有旁表）：null，界面不显示三行。
 * 其他类别（A、B 类不会有审批单，这里按防御处理）一律 null。「由某某执行」那一行不在这里，不受影响。
 * note 为 null 表示这张审批没有旁表（员工没有填、也不属于一件事）。
 */
export function approvalNotesView(actionClass: string, note: Pick<ApprovalNote, 'cost' | 'undo' | 'after'> | null, isLaunch: boolean): { cost: string; undo: string; after: string } | null {
  if (actionClass !== 'C' && actionClass !== 'D') return null;
  const wroteAny = note !== null && (note.cost !== null || note.undo !== null || note.after !== null);
  if (!isLaunch && !wroteAny) return null;
  return { cost: note?.cost ?? LAUNCH_UNSPECIFIED, undo: note?.undo ?? LAUNCH_UNSPECIFIED, after: note?.after ?? LAUNCH_UNSPECIFIED };
}

/** 「由{员工名字}执行」：属于一件事的审批才有。 */
export function onBehalfOfText(executorName: string): string {
  return `由${executorName}执行`;
}
