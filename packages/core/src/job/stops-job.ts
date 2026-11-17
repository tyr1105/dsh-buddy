/**
 * 主人确认了写明「不再做」的约定版本（stopsJob）之后，由中心直接停下这件事（P74f-2，补充要求第 1 节第 1 点）。
 *
 * 为什么由中心停：以前主人确认之后没有人去停这件事——总管没有被叫醒（正在做的事的约定确认不叫醒总管，省一个回合），
 * 事就一直做下去。现在这一版带 stopsJob 时，确认的任何一条途径（按钮、「待你处理」、主题里打字、私聊里打字）
 * 最后都落到约定固定的收尾（agreement-hooks.ts 的 onAgreementLocked），收尾在这里把事停下：
 * 效果与 stop 相同（状态、清队列、撤回条目、主题里一句、私聊一句，见 stop-core.ts），不叫醒总管。
 * 主人不确认、总管撤销：照常接着做（走 onReopenWithdrawn，不经过这里）。
 *
 * 可以重复调用：已经停止的事直接返回 false；巡检补做固定后的收尾（catch-up.ts）时也会再走到这里，不会重复说话。
 */
import type { HubContext } from '../engine/context.js';
import { jobOfAgreement, isJobClosed } from './store.js';
import { stopJobCore } from './stop-core.js';

/** 这一版是不是写明了「不再做」。 */
export function versionStopsJob(ctx: HubContext, agreementId: string, versionNo: number): boolean {
  const version = ctx.store.table('agreements').get(agreementId)?.versions.find(row => row.no === versionNo);
  return version !== undefined && version.stopsJob === true && version.lockedAt !== null;
}

/**
 * 固定的这一版带 stopsJob 时停下这份约定的事；返回是否停了。
 * 这件事已经停止或已完成（没有进行中的事）时什么都不做。出错由调用方只记日志，巡检会再补。
 */
export function stopJobForAgreement(ctx: HubContext, agreementId: string, versionNo: number): boolean {
  if (!versionStopsJob(ctx, agreementId, versionNo)) return false;
  const job = jobOfAgreement(ctx, agreementId);
  if (job === null || isJobClosed(job)) return false;
  stopJobCore(ctx, job, {
    actor: 'hub', reason: `主人确认了约定第 ${versionNo} 版：不再做`, via: 'agreement', clearAsk: true,
    topic: { from: 'hub', kind: 'system', text: `这件事已按约定第 ${versionNo} 版停止，已经做出来的东西保留在项目文件夹里。` },
  });
  return true;
}
