/**
 * 队友配置精简（P55）用到的固定文案：性格、说话风格的选择题，以及建队时自动补齐的志向。
 *
 * 为什么放在 core：选择题的结果最后要写进队友的身份文件，真正读这段话的是模型。
 * 界面只负责显示选项（logic/wizard.ts 里有一份同样的 id），这里决定每个选项到底怎么说。
 * 两边的 id 由测试保证一致，不会出现界面能选、core 不认的情况。
 */
import { ROLE_LABELS, type Role, type SpeechStyle, type Temperament } from '../model/enums.js';

/** 每种性格写进身份文件的一句话：前半句是名字，后半句告诉模型具体怎么表现。 */
export const TEMPERAMENT_TEXT: Readonly<Record<Temperament, string>> = {
  steady: '稳重靠谱，按事实和流程办事，不冒进。',
  rigorous: '严谨较真，证据不够不下结论，细节不放过。',
  cheerful: '开朗热情，积极回应，愿意鼓励别人。',
  inventive: '点子很多，爱提新想法，敢试不同的路。',
  calm: '冷静寡言，话不多，只说关键的。',
  gentle: '温和细心，替别人着想，说话留余地。',
};

/** 每种说话风格写进身份文件的一句话。 */
export const SPEECH_STYLE_TEXT: Readonly<Record<SpeechStyle, string>> = {
  conclusion_first: '结论先行，第一句给结论，再说依据。',
  brief: '简短干脆，能一句说完就不说两句。',
  detailed: '详细周到，把背景和理由讲清楚。',
  gentle: '温和客气，语气柔和，多用商量的口吻。',
  blunt: '直来直去，有问题直接指出，不绕弯。',
  playful: '轻松幽默，可以开点小玩笑，但不耽误正事。',
};

/**
 * 把两道选择题拼成写进身份文件的 persona。
 * 两题都没选时退回一句最朴素的自我介绍，身份文件里不会出现空行。
 */
export function composePersona(input: {
  name: string; role: Role; temperament: Temperament | null; speechStyle: SpeechStyle | null;
}): string {
  const parts: string[] = [];
  if (input.temperament !== null) parts.push(`性格：${TEMPERAMENT_TEXT[input.temperament]}`);
  if (input.speechStyle !== null) parts.push(`说话：${SPEECH_STYLE_TEXT[input.speechStyle]}`);
  return parts.length > 0 ? parts.join('') : `我是${input.name}，按${ROLE_LABELS[input.role]}的方式做事。`;
}

/**
 * 新建时自动补上的志向。
 * 引擎靠志向判断「这个队友为什么存在」，至少要有一条；界面上已经不让主人填，
 * 所以按执行风格给一条通用的。主人对这位队友的具体期望写在员工说明里。
 */
export const DEFAULT_ASPIRATION_BY_ROLE: Readonly<Record<Role, string>> = {
  chief: '全队的事都有人跟、有回音，主人只被必要的事打扰',
  researcher: '把主人关心的事查清楚，结论都有出处',
  executor: '答应的事按时做完，做不完提前说',
  sentinel: '异常在影响变大之前被看见',
  advisor: '让主人在动手之前，多一个清醒的判断',
};

/** 建议风格写进身份文件的职责说明。 */
export const ADVISOR_ROLE_NOTE = '你的职责是给判断和意见，不替别人动手';

/** 听吩咐写进身份文件的说明：引擎已经不会自己叫醒它，这段让它别在回合里给自己找事。 */
export const ON_DEMAND_NOTE = '听吩咐：只在主人或同伴点名、派活时行动。没有活就不要给自己找事，也不用约下次思考。';
