/**
 * 按需加人的固定文字（P73d）：集中放在这里，便于登记（P73e）和测试断言「给主人看的文字不含工具名、编号」。
 *
 * 分两类：
 * - 给主人看的（线程里的中心旁白、主人名义落的消息）：不出现工具名、机器人 id、内部编号；
 * - 给模型看的（工具返回文字、报错）：说明下一步怎么做，可以出现参数名，但同样不放 id。
 */

/** 主人确认按需加人后，中心以主人名义在总管私聊落的消息（也是叫醒总管的证据）。 */
export const CONFIRM_RECORD_TEXT = '确认入职';

/** 中心旁白：组队卡按主人的话更新了。changes 是「员工说明已修改」「换为某某」这类短语。 */
export function reviseNoteText(name: string, changes: readonly string[]): string {
  return `组队卡已按你的话更新：${name}${changes.join('；')}。`;
}
/** revise 改了员工说明时的短语。 */
export const REVISE_BRIEF_PHRASE = '的员工说明已修改';
/** revise 换了模板时的短语。 */
export function reviseTemplatePhrase(templateName: string): string {
  return `换为${templateName}`;
}

/** 中心旁白：总管撤下了组队卡。 */
export function withdrawnNoteText(reason: string): string {
  return `总管撤下了组队卡：${reason}`;
}

/** 工具返回（给模型看）：propose 成功。 */
export const PROPOSE_DONE_TEXT = '组队卡已建好，本回合交账后发给主人。reply 用一句话说明为什么需要、为什么常驻，请主人在卡片上确认。';
/** 工具返回（给模型看）：revise 成功。 */
export const REVISE_DONE_TEXT = '组队卡已按主人的话更新。reply 用一句话说明改了什么。';
/** 工具返回（给模型看）：withdraw 成功。 */
export const WITHDRAW_DONE_TEXT = '组队卡已撤下。这件事由你自己完成，或按主人的意思另行安排。';
