/**
 * 「回合用到上限」「停住了」两类条目正文里「现在真正在等什么」（P74f-2，补充要求第 3 节第 2 点，审查 G10）。
 *
 * 为什么需要：条目正文原来只写受阻说明（取自交账摘要）。一件事真正在等什么，有时和受阻说明不是一回事：
 * 有人提了问题没得到回答、约定的新版本在等主人确认、核对人一直没有交结论。主人看到条目时要知道真正在等什么，
 * 才知道该答「再给回合」还是去处理别的。按事实依次判断，取第一个成立的：
 *   一、有未回答的提问（还没有转成约定新版本）：`{提问人}问：{原文，超过 80 字截断加…}`；
 *   二、约定新版本在等确认：`约定第 {n} 版在等你确认`；
 *   三、核对环节没有动静：`等{核对人}核对第 {r} 轮交回`；
 *   四、其余：沿用受阻说明（取自模型的原文，过一遍内部名称检查）。
 * 等待时长不在这里算（P76g 起由 job/progress-mark.ts 的「记录」算）。
 * 只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import { agreementPendingNo } from './deliver.js';
import { oneLineClip, ownerSafe } from './owner-text.js';
import { effectiveStateOf } from './version-stage.js';
import { openAskText } from './store.js';

/** 受阻说明含内部名称时换成的固定句。 */
const BLOCK_TEXT_FALLBACK = '具体原因见这件事的主题';

/**
 * 这件事现在真正在等什么；没有可写的返回 null。
 * ignoreBlockText：为真时不取受阻说明（第四项返回 null，由调用方自己决定写什么）。
 */
export function waitingReasonOf(ctx: HubContext, job: Job, options: { ignoreBlockText?: boolean } = {}): string | null {
  const ask = job.openAsk;
  if (ask !== null && ask.agreementNo == null) {
    const asker = ctx.store.table('bots').get(ask.fromId)?.name ?? '员工';
    const text = ownerSafe(oneLineClip(openAskText(ctx, job) ?? '（问题原文没有留在记录里）', 80), '（问题原文见这件事的主题）');
    return `${asker}问：${text}`;
  }
  const pending = job.pause !== null ? job.pause.versionNo : agreementPendingNo(ctx, job);
  if (pending !== null) return `约定第 ${pending} 版在等你确认`;
  if (effectiveStateOf(job) === 'checking' && (job.state === 'checking' || job.blocked?.kind === 'executor')) {
    const reviewer = job.reviewerId === null ? '总管' : ctx.store.table('bots').get(job.reviewerId)?.name ?? '核对人';
    return `等${reviewer}核对第 ${job.round} 轮交回`;
  }
  if (options.ignoreBlockText !== true && job.blocked !== null && job.blocked.text.trim() !== '') {
    return ownerSafe(job.blocked.text.trim(), BLOCK_TEXT_FALLBACK);
  }
  return null;
}
