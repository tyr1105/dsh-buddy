/**
 * 一次技能记录（复盘、学习、整理）的「标题」（P75i）：拼进唤醒摘要「复盘：{标题}」「核对技能更新：{标题}」
 * 和核对唤醒包的段标题里用。
 *
 * 为什么单独放：P75g、P75h 的几处各自写了「有这件事就取它的标题，没有就写『这件事』」。学习和每周整理的记录没有「这件事」
 * （jobId 为空），沿用「这件事」会让核对人看到「核对技能更新：这件事」，不知道在核对什么。
 * 集中一处：复盘取这件事的标题；学习取主人要学什么（截短）；整理写「每周整理」。
 */
import type { HubContext } from '../engine/context.js';
import type { SkillRun } from '../model/skill.js';
import { jobTitleOf } from '../job/chain.js';

/** 学习的标题最多取主人要学什么的前几个字（摘要要短）。 */
const LEARN_TITLE_CHARS = 20;

/** 这次记录的标题。 */
export function runTitleOf(ctx: HubContext, run: SkillRun): string {
  if (run.kind === 'learn') {
    const chars = [...(run.learn?.note ?? '').trim()];
    return chars.length === 0 ? '学习' : chars.slice(0, LEARN_TITLE_CHARS).join('');
  }
  if (run.kind === 'tidy') return '每周整理';
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  return job === null ? '这件事' : jobTitleOf(ctx, job);
}
