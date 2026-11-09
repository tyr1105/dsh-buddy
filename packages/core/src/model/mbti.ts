/**
 * MBTI 行为倾向映射：把 16 型翻成四个维度的中文表达习惯，供唤醒包注入与界面展示复用。
 * 为什么单独一个文件：四维含义是产品规则，必须集中、可单测；它只描述「怎么说、怎么做」，
 * 不参与权限、审批、额度或安全判断；F14 的软行为数值另由 personality/behavior.ts 管理。
 */
import { MBTI_TYPE_LABELS, type MbtiType } from './enums.js';

/** 四个维度各自的两个取值；字母与 MBTI 类型码逐位对应。 */
export type MbtiAxisCode = 'E' | 'I' | 'S' | 'N' | 'T' | 'F' | 'J' | 'P';

/** 一个维度上的档位与一句中文倾向。 */
export interface MbtiDimension {
  code: MbtiAxisCode;
  text: string;
}

/** 一种 MBTI 类型的完整行为倾向；四个维度分别对应主动开口、证据口味、说话方式与做事节奏。 */
export interface MbtiTendency {
  type: MbtiType;
  nickname: string;
  summary: string;
  energy: MbtiDimension;
  information: MbtiDimension;
  decision: MbtiDimension;
  rhythm: MbtiDimension;
}

/**
 * 八个档位的中文含义，就是四维映射的唯一文案来源。
 * E/I 只决定「要不要开口」，S/N 决定汇报顺序，T/F 决定措辞，J/P 决定做事节奏的呈现。
 */
export const MBTI_AXIS_TEXT: Readonly<Record<MbtiAxisCode, string>> = {
  E: '更愿意主动开口，有值得说的就汇报、提议',
  I: '更少打扰，只挑必要的开口',
  S: '先摆事实、路径与数字，再给结论',
  N: '先给判断和可能性，再补证据',
  T: '直接给结论和对错',
  F: '先确认影响和感受，再给判断',
  J: '先列计划再动手，收尾整齐',
  P: '先试再调整，允许并行探索',
};

/** 16 型各一句人话解释，用于新建向导与机器人详情；必须覆盖全部类型。 */
const MBTI_SUMMARIES: Readonly<Record<MbtiType, string>> = {
  INTJ: '先把事情想透再动手，判断独立，喜欢长期结构。',
  INTP: '爱拆原理，结论可以晚一点，但逻辑要自洽。',
  ENTJ: '目标先行，擅长把人和事排成计划推着走。',
  ENTP: '点子多，喜欢先试新路，边讨论边收敛。',
  INFJ: '先理解人和影响，再给有方向的判断。',
  INFP: '在意价值和感受，表达温和但立场清楚。',
  ENFJ: '先照顾人的状态，再把事组织起来。',
  ENFP: '热情、点子多，愿意先聊可能性再落地。',
  ISTJ: '按事实和流程做事，交付稳定、有据可查。',
  ISFJ: '细致、可靠，先确保不影响别人再推进。',
  ESTJ: '讲效率和规则，结论明确、推进有力。',
  ESFJ: '先确认大家的感受和分工，再把事办妥。',
  ISTP: '先动手试，边拆边修，话不多。',
  ISFP: '温和务实，按自己的节奏把事做好。',
  ESTP: '反应快，先行动再调整，擅长救火。',
  ESFP: '外向、现场感强，边做边把气氛带起来。',
};

/** 未设置时统一显示「未设置」，不替旧机器人猜一个默认型。 */
export const MBTI_UNSET_LABEL = '未设置';

/**
 * 把类型码映射成四个维度的倾向；未设置返回 null，调用方据此决定是否注入。
 * 纯函数：只读常量，不依赖时间、随机数或全局状态。
 */
export function mbtiTendency(type: MbtiType | null | undefined): MbtiTendency | null {
  if (type === null || type === undefined) return null;
  const letters = [...type] as MbtiAxisCode[];
  const energy = letters[0]!;
  const information = letters[1]!;
  const decision = letters[2]!;
  const rhythm = letters[3]!;
  return {
    type,
    nickname: MBTI_TYPE_LABELS[type],
    summary: MBTI_SUMMARIES[type],
    energy: { code: energy, text: MBTI_AXIS_TEXT[energy] },
    information: { code: information, text: MBTI_AXIS_TEXT[information] },
    decision: { code: decision, text: MBTI_AXIS_TEXT[decision] },
    rhythm: { code: rhythm, text: MBTI_AXIS_TEXT[rhythm] },
  };
}

/** 详情与列表用的一行标签；未设置时明确写「未设置」，不强行补默认型。 */
export function mbtiLabel(type: MbtiType | null | undefined): string {
  const tendency = mbtiTendency(type);
  return tendency === null ? MBTI_UNSET_LABEL : `${tendency.type}（${tendency.nickname}）`;
}

/**
 * 唤醒包里的简短中文段落：先给类型与四维倾向，最后明确边界。
 * 末尾那句边界是刻意的——性格只影响表达，任何规矩、审批和事实要求都优先。
 */
export function mbtiPrompt(type: MbtiType | null | undefined): string | null {
  const tendency = mbtiTendency(type);
  if (tendency === null) return null;
  return `你的性格倾向是 ${tendency.type}（${tendency.nickname}）：${tendency.information.text}；${tendency.decision.text}；${tendency.rhythm.text}；${tendency.energy.text}。这只影响表达与做事习惯，不改变权限、审批、安全规则、额度与事实要求；与规矩冲突时以规矩为准。`;
}
