/**
 * 技能类回合的事项键（P75g 第 4 节，P75i 加学习）：复盘、改写、技能核对、每周整理四种唤醒（种类 reflection），
 * 以及主人指定会话的学习唤醒（种类 teach）共用的键格式与解析。
 *
 * 为什么集中在一个文件：调度（on-demand 的例外名单）、闸门（按 skillRuns 找所属记录）、
 * 唤醒包（按键分派用哪一种段）、工具（hub_skill 认「这是不是中心叫你做的回合」）都要认这些键；
 * 各写各的字符串拼接，改一种键就要找几个地方。别处只引用这里的常量与函数，不自己拼。
 *
 * 键格式：
 * - 复盘：retro:<runId>:<botId>；改写：retro:<runId>:<botId>:rewrite（P75h 用）。
 * - 技能核对：skillcheck:<runId>:<botId>（P75h 用）。
 * - 每周整理：tidy:<周一日期>:<botId>（P75i 用；runId 的位置放周一日期，用 skillRunOfKey 找记录）。
 * - 学习：learn:<runId>:<botId>（P75i 用；唤醒种类是 teach 而不是 reflection）。
 */
import type { HubContext } from '../engine/context.js';
import type { WakeKind } from '../model/index.js';
import type { SkillRun } from '../model/skill.js';
import { sha1Hex } from '../util/hash.js';

/** 技能类回合的种类：复盘（含改写）、技能核对、每周整理、学习。 */
export type SkillWorkKind = 'retro' | 'skillcheck' | 'tidy' | 'learn';

/**
 * 事项键的前缀名单（on-demand 的例外名单与闸门共用这一份）。
 * 只列唤醒种类为 reflection 的三种；学习（learn:）的唤醒种类是 teach，本来就不在听吩咐挡住的名单里，另用 isLearnWork 判断。
 */
export const SKILL_WORK_SUBJECT_PREFIXES = ['retro:', 'skillcheck:', 'tidy:'] as const;

/** 复盘（或改写）唤醒的事项键。 */
export function retroSubjectKey(runId: string, botId: string, rewrite = false): string {
  return `retro:${runId}:${botId}${rewrite ? ':rewrite' : ''}`;
}

/** 技能核对唤醒的事项键。 */
export function skillcheckSubjectKey(runId: string, botId: string): string {
  return `skillcheck:${runId}:${botId}`;
}

/** 每周整理唤醒的事项键；dateKey 是本周一的本地日期（YYYY-MM-DD）。 */
export function tidySubjectKey(dateKey: string, botId: string): string {
  return `tidy:${dateKey}:${botId}`;
}

/** 学习唤醒的事项键。 */
export function learnSubjectKey(runId: string, botId: string): string {
  return `learn:${runId}:${botId}`;
}

/** 解析后的事项键；不是技能类的键返回 null。tidy 的 runId 位放的是周一日期。 */
export interface ParsedSkillKey {
  kind: SkillWorkKind;
  runId: string;
  botId: string;
  /** 复盘键的第四段是 rewrite 时为真（P75h 的改写唤醒）。 */
  rewrite: boolean;
}

/** 解析一个事项键：是技能类的键返回它的组成部分，否则返回 null。 */
export function parseSkillKey(subjectKey: string | null | undefined): ParsedSkillKey | null {
  if (typeof subjectKey !== 'string') return null;
  const parts = subjectKey.split(':');
  if (parts[0] === 'retro' && parts.length >= 3) {
    return { kind: 'retro', runId: parts[1]!, botId: parts[2]!, rewrite: parts[3] === 'rewrite' };
  }
  if (parts[0] === 'skillcheck' && parts.length === 3) {
    return { kind: 'skillcheck', runId: parts[1]!, botId: parts[2]!, rewrite: false };
  }
  if (parts[0] === 'tidy' && parts.length === 3) {
    return { kind: 'tidy', runId: parts[1]!, botId: parts[2]!, rewrite: false };
  }
  if (parts[0] === 'learn' && parts.length === 3) {
    return { kind: 'learn', runId: parts[1]!, botId: parts[2]!, rewrite: false };
  }
  return null;
}

/**
 * 技能类唤醒的说明文字（任务卡第 4 节）：复盘「复盘：{标题}」、改写「改写技能更新：{标题}」、
 * 核对「核对技能更新：{标题}」；整理没有标题，写「整理技能库」；学习写「学习：{主人要学什么}」。
 * 给模型看的摘要与活动流里主人看的摘要用同一句，所以集中一处，调用方不自己拼。
 */
export function skillWorkSummary(subjectKey: string, title: string): string {
  const parsed = parseSkillKey(subjectKey);
  if (parsed === null) return `复盘：${title}`;
  if (parsed.kind === 'skillcheck') return `核对技能更新：${title}`;
  if (parsed.kind === 'tidy') return '整理技能库';
  if (parsed.kind === 'learn') return `学习：${title}`;
  return parsed.rewrite ? `改写技能更新：${title}` : `复盘：${title}`;
}

/** 是不是技能类回合：唤醒种类为复盘（reflection）且事项键是复盘、核对、整理之一。学习唤醒的种类是 teach，不在此列。 */
export function isSkillWork(kind: WakeKind, subjectKey: string | null | undefined): boolean {
  if (kind !== 'reflection') return false;
  const parsed = parseSkillKey(subjectKey);
  return parsed !== null && parsed.kind !== 'learn';
}

/** 是不是学习回合：唤醒种类为教学（teach）且事项键是 learn: 开头。学习是主人发起的回合，闸门按主人发起的回合放行。 */
export function isLearnWork(kind: WakeKind, subjectKey: string | null | undefined): boolean {
  return kind === 'teach' && parseSkillKey(subjectKey)?.kind === 'learn';
}

/**
 * 是不是「只读的技能类回合」（P75r5c，审查 H2）：唤醒的变体是复盘（reflection），或事项键是技能类的键（含学习的 learn: 键）。
 * 为什么统一成一个判断：以前只读的限制只认变体是不是复盘，学习回合的变体是教学（teach），
 * 于是学习的员工能给主人发消息、能写文件、能用各种写工具；而这个回合读的是主人会话的摘要（外部内容），应当和复盘一样只读。
 * 闸门上下文的 reflection 标记、写类中心工具的名单、出站入口的几处判断，都经这个函数（出站入口、守卫读的是闸门上下文里的标记）。
 * 只改「能做什么」：学习仍是主人发起的回合，放行、额度灯下的处理、回合上限档位都不变。
 */
export function isReadonlySkillTurn(wake: { variant: string; subjectKey?: string | null | undefined } | null | undefined): boolean {
  if (wake === null || wake === undefined) return false;
  return wake.variant === 'reflection' || parseSkillKey(wake.subjectKey ?? null) !== null;
}

/** 一个事项键属于哪个 run（tidy 的「runId」其实是周一日期，要找记录请用 skillRunOfKey）。 */
export function runIdOf(subjectKey: string | null | undefined): string | null {
  return parseSkillKey(subjectKey)?.runId ?? null;
}

/**
 * 事项键对应的 skillRuns 记录；找不到返回 null。
 * 复盘、核对、学习的键里放的就是记录编号；每周整理的键里放的是周一日期，按（周一日期、员工）找那位员工本周的整理记录。
 */
export function skillRunOfKey(ctx: Pick<HubContext, 'store'>, subjectKey: string | null | undefined): SkillRun | null {
  const parsed = parseSkillKey(subjectKey);
  if (parsed === null) return null;
  // P75r5c（审查 H1）：整理键一律按整理记录的编号取。编号由（周一日期、员工）算出，
  // 不再按「这位员工在不在参与者里」找——他给别人的合并当核对人时，也在别人那条记录的参与者里，会取错记录。
  if (parsed.kind === 'tidy') return ctx.store.table('skillRuns').get(tidyRunId(parsed.runId, parsed.botId));
  return ctx.store.table('skillRuns').get(parsed.runId);
}

/**
 * 整理记录的编号：由（周一日期、员工）算出来，不取随机数。
 * 为什么：一是同一周同一位员工只会有一个编号（本身就是幂等的键）；二是不消耗注入的随机源——
 * 随机源是按顺序取值的，每周一每位员工建一条记录若都取随机数，会改变这之后所有编号的取值，
 * 让依赖固定随机序列的七天仿真（同一份种子得到同一串事件）每到周一就和以前对不上。
 * 放在这个文件里（而不是 tidy.ts）：按键找记录要用它，keys.ts 不能反过来引用 tidy.ts（会循环引用）。
 */
export function tidyRunId(weekOf: string, botId: string): string {
  return `sr_${sha1Hex(`tidy:${weekOf}:${botId}`).slice(0, 10)}`;
}
