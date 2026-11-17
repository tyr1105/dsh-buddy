/**
 * 技能编号（P75r6 第 2 节第 3 条，复验 N2）：唤醒包里，模型写的技能名称放进不可信围栏；
 * 需要原样抄进工具参数的地方（propose 的 skill、tidy 的 from 与 into），在围栏外用编号指代，做法照出处编号 src1。
 *
 * 编号写法：sk1、sk2……（sk 加正整数）。编号 = 这位员工自己积累的全部技能（含收起的）按「建立时间从旧到新、同时间按技能编号」
 * 排序之后的名次。为什么这样算：技能只会增加、不会删除，建立时间不变，所以一条技能的编号一旦出现就不再变化
 * （收起、放回、新写版本都不影响），唤醒包里写的编号和稍后工具里认的编号总是对得上，不用像出处编号那样另外记一份。
 * 为什么新建技能的名称不能写成 sk 加数字的样子：免得名称和编号混淆（见 skill-text.ts 的名称检查）。
 *
 * 工具参数既认编号，也认名称（旧的写法不变）：先按编号认，认不出再按名称。
 * 本文件只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Skill } from '../model/skill.js';

/** 编号的写法：sk 加正整数（不分大小写，工具参数里写 SK1 也认）。 */
export const SKILL_REF_PATTERN = /^sk([1-9]\d*)$/i;

/** 这位员工自己积累的全部技能（含收起的），带编号，按编号从小到大。 */
export function skillRefsOf(ctx: HubContext, botId: string): Array<{ ref: string; skill: Skill }> {
  return ctx.store.table('skills').list(row => row.botId === botId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((skill, index) => ({ ref: `sk${index + 1}`, skill }));
}

/** 一条技能的编号；找不到这条技能时返回 null。 */
export function skillRefOf(ctx: HubContext, botId: string, skillId: string): string | null {
  return skillRefsOf(ctx, botId).find(row => row.skill.id === skillId)?.ref ?? null;
}

/**
 * 工具参数里的「技能」（编号或名称）对应哪一条自己积累的技能：先按编号认，认不出再按名称（去首尾空白）；都不是返回 null。
 * 名称重名时取第一条（新建技能不允许重名，只有迁移来的旧数据可能重名）。
 */
export function findSelfSkill(ctx: HubContext, botId: string, text: string): Skill | null {
  const refs = skillRefsOf(ctx, botId);
  const wanted = text.trim();
  if (SKILL_REF_PATTERN.test(wanted)) {
    const hit = refs.find(row => row.ref === wanted.toLowerCase());
    if (hit !== undefined) return hit.skill;
  }
  return refs.find(row => row.skill.title === wanted)?.skill ?? null;
}
