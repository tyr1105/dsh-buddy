/**
 * 学习记录结束时总管私聊里落的那一句（P75i 第 4.4 节，逐字）。
 *
 * 三种：
 * - 有通过的更新：「{员工}已从这段会话学到 {k} 条做法，写进技能「{技能}」第 {n} 版，{核对人}核对与会话内容一致。」
 *   （k 为通过的句子数；写进多条技能时「写进技能「{a}」第 {n} 版、「{b}」第 {m} 版」）；
 * - 都没有通过或没有提交：「{员工}没能从这段会话整理出可以写入的做法，只留在记录里。」
 * - 回合用完或等待过期：「{员工}这次学习没有完成：学习回合用完。」「{员工}这次学习没有完成：等待超过 7 天。」
 *   （派活说明第二节第 4 条：把复盘的说法换成与学习相符的说法）。
 *
 * 为什么单独放一个文件：run.ts 已经很长；这几句话是纯函数（读存储、不写任何东西），也方便测试逐字对照。
 */
import type { HubContext } from '../engine/context.js';
import type { SkillRun, SkillUpdate } from '../model/skill.js';

/** 这条更新对应的技能名（已有技能取技能名，新建取新技能的名称）。 */
function skillTitleOf(ctx: HubContext, update: SkillUpdate): string {
  if (update.skillId === null) return update.newSkill?.title ?? '新技能';
  return ctx.store.table('skills').get(update.skillId)?.title ?? '技能';
}

/** 员工的显示名：总管写「总管」（与提交时的说法一致），其余取名字。 */
function nameOf(ctx: HubContext, botId: string): string {
  const bot = ctx.store.table('bots').get(botId);
  return bot?.role === 'chief' ? '总管' : bot?.name ?? '员工';
}

/** 学习的员工名字（学习的结果句里就写他的名字，总管不会被教，所以不写成「总管」）。 */
function learnerName(ctx: HubContext, run: SkillRun): string {
  return ctx.store.table('bots').get(run.learn?.learnerId ?? '')?.name ?? '员工';
}

/** 这次学习是总管私聊里提起的：「待你处理」那一条的所属员工就是总管；找不到时取在岗的总管。 */
export function learnChiefId(ctx: HubContext, run: SkillRun): string | null {
  const inboxId = run.learn?.inboxId ?? null;
  const fromInbox = inboxId === null ? null : ctx.store.table('inbox').get(inboxId)?.botId ?? null;
  if (fromInbox !== null) return fromInbox;
  return ctx.store.table('bots').list(row => row.role === 'chief')[0]?.id ?? null;
}

/** 结束句。updates 是这次学习提交的全部更新。 */
export function learnEndText(ctx: HubContext, run: SkillRun, updates: SkillUpdate[]): string {
  const name = learnerName(ctx, run);
  const passed = updates.filter(row => row.state === 'passed');
  if (passed.length > 0) {
    const k = passed.reduce((sum, row) => sum + row.sentences.length, 0);
    // 同一条技能通过多次时只写一次（取最后一个版本号）；多条技能依次写「「{a}」第 {n} 版」。
    const written = new Map<string, number>();
    for (const row of passed) written.set(skillTitleOf(ctx, row), row.versionNo ?? 1);
    const skills = [...written].map(([title, no]) => `「${title}」第 ${no} 版`).join('、');
    const checkers = [...new Set(passed.map(row => row.checks.at(-1)?.checkerId ?? row.checkerId))].map(id => nameOf(ctx, id)).join('、');
    return `${name}已从这段会话学到 ${k} 条做法，写进技能${skills}，${checkers}核对与会话内容一致。`;
  }
  // 没有通过的：回合用完或过期（学习的员工、核对人任何一位的回合用完、等待过期）优先说明原因。
  if (run.participants.some(row => row.state === 'capped')) return `${name}这次学习没有完成：学习回合用完。`;
  if (run.participants.some(row => row.state === 'expired')) return `${name}这次学习没有完成：等待超过 7 天。`;
  return `${name}没能从这段会话整理出可以写入的做法，只留在记录里。`;
}
