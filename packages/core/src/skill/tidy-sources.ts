/**
 * 每周整理里「在用的技能」与「出处编号」的读取（P75i 第 5.3、5.4 节）：整理唤醒包和 tidy 工具共用同一份，
 * 唤醒包里写的 src 编号与工具里认的 src 编号才对得上。
 *
 * 编号规则：整理记录建立时，把这位员工在用的自己积累技能（收起之后）当前版本里出现的出处，按出现顺序记在参与者的 sourceIds 上；
 * 之后读取时，先用参与者上记下的顺序（出处还在表里的），再把后来才出现的新出处按出现顺序接在后面。
 * 为什么记下顺序而不是每次现算：两次读取之间技能可能变过（例如同一员工刚学完一次、写进了新句子），
 * 现算的编号会整体错位；记下之后，已有的编号不会变，新出处只会接在最后。
 *
 * 本文件只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Skill, SkillRun, SkillVersion } from '../model/skill.js';
import { versionsOfSkill } from './files.js';

/** 一条在用技能和它的当前版本。 */
export interface TidySkill { skill: Skill; version: SkillVersion }

/** 这位员工在用的自己积累技能（带当前版本），按建立时间从旧到新，稳定排序。 */
export function tidySkillsOf(ctx: HubContext, botId: string): TidySkill[] {
  const out: TidySkill[] = [];
  const skills = ctx.store.table('skills').list(row => row.botId === botId && row.state === 'active')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const skill of skills) {
    const version = versionsOfSkill(ctx, skill.id).find(row => row.no === skill.currentVersionNo);
    if (version !== undefined) out.push({ skill, version });
  }
  return out;
}

/**
 * 这位员工是不是在办一件事：事处在执行中（doing）、核对中（checking）、返工中（rework）之一，并且他是这件事的执行者，
 * 或是核对中的核对人（有评审员时是评审员；总管自己核对时 reviewerId 为空，核对人就是总管）。
 * 整理候选的闸门（scheduler/snapshot.ts）与「当天没有整理成」的原因判断（skill/run.ts）共用这一个口径（P75r5c 从 snapshot.ts 移到这里）。
 */
export function busyWithJob(ctx: HubContext, botId: string): boolean {
  return ctx.store.table('jobs').list(job => ['doing', 'checking', 'rework'].includes(job.state)
    && (job.executorId === botId || (job.state === 'checking' && (job.reviewerId ?? job.chiefId) === botId))).length > 0;
}

/** 在用技能当前版本里出现的出处编号，按出现顺序去重。 */
export function sourceIdsInSkills(skills: TidySkill[]): string[] {
  const seen: string[] = [];
  for (const item of skills) {
    for (const sentence of item.version.sentences) {
      for (const id of sentence.sourceIds) if (!seen.includes(id)) seen.push(id);
    }
  }
  return seen;
}

/**
 * 这位员工最近一次整理的结束时间（整理做完，或有收起）；没有整理过返回 null。
 * 技能库一栏顶部的「上次整理：{M}月{D}日」用它（api/skill-views.ts）。
 */
export function lastTidyAt(ctx: HubContext, botId: string): number | null {
  const times = ctx.store.table('skillRuns')
    .list(run => run.kind === 'tidy' && run.endedAt !== null && run.participants.some(row => row.botId === botId && row.role !== 'checker'
      && (row.state === 'done' || (run.collapsed ?? []).length > 0)))
    .map(run => run.endedAt!);
  return times.length === 0 ? null : Math.max(...times);
}

/** 这位员工整理时的出处编号表：src{k} 对应返回数组的第 k-1 项。 */
export function tidySourceOrder(ctx: HubContext, run: SkillRun | null, botId: string): string[] {
  const recorded = (run?.participants.find(row => row.botId === botId)?.sourceIds ?? [])
    .filter(id => ctx.store.table('skillSources').get(id) !== null);
  const current = sourceIdsInSkills(tidySkillsOf(ctx, botId));
  return [...recorded, ...current.filter(id => !recorded.includes(id))];
}
