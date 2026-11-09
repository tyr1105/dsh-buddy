/**
 * 性格的可执行软策略：普通自主候选更挑理由，普通汇报更短，提议更挑证据。
 * 安全、权限、预算与主人要求仍由原规则决定；这里不能降低原有底线或创造唤醒。
 * 所有计算只读输入，数值来自已校验 Settings，便于仿真和界面使用同一口径。
 */
import type { MbtiType, Settings } from '../model/index.js';

/** 档案里显示的实际策略，也是候选、消息与提议共用的值；null 表示没有设置。 */
export interface PersonalityBehavior {
  wakeOffset: number;
  reportMaxChars: number;
  proposalMinValue: number;
  proposalMinConfidence: number;
}

/** E 保留原底线，I 增加保守程度；两者都不能突破原提议底线。 */
export function personalityBehavior(type: MbtiType | null, settings: Settings): PersonalityBehavior | null {
  if (type === null) return null;
  const quiet = type.startsWith('I');
  const policy = settings.personality;
  return {
    wakeOffset: quiet ? policy.introvertWakeOffset : 0,
    reportMaxChars: quiet ? policy.introvertReportMaxChars : policy.extrovertReportMaxChars,
    proposalMinValue: Math.min(1, settings.proposalMinValue + (quiet ? policy.introvertProposalOffset : 0)),
    proposalMinConfidence: Math.min(1, settings.proposalMinConfidence + (quiet ? policy.introvertProposalOffset : 0)),
  };
}

/** 原公式是底线；封顶最多为 1，绝不能把本来就超过 1 的严格配置降下来。 */
export function personalityThreshold(base: number, behavior: PersonalityBehavior | null, exempt: boolean): number {
  return exempt || behavior === null ? base : Math.max(base, Math.min(1, base + behavior.wakeOffset));
}

/** 只节略普通 report 的展示，正文仍在原交账；Unicode 码点避免切坏代理对。 */
export function personalityReport(text: string, behavior: PersonalityBehavior | null, exempt: boolean): string {
  if (behavior === null || exempt) return text;
  const characters = [...text];
  if (characters.length <= behavior.reportMaxChars) return text;
  const mark = '…（汇报已节略，原文保留在交账）';
  return characters.slice(0, Math.max(0, behavior.reportMaxChars - [...mark].length)).join('') + mark;
}

/** 写给机器人的是实际执行口径，模型不需猜 MBTI 标签代表多少分或多长消息。 */
export function personalityInstruction(behavior: PersonalityBehavior): string {
  return `普通自主候选额外门槛至多 +${behavior.wakeOffset.toFixed(2)}，硬闸不变；主人要求、紧急和承诺优先。
普通自主汇报 report 最多 ${behavior.reportMaxChars} 字，按性格顺序保留结论与证据；长报告放产物。主人要求、重要汇报、reply 和提问不节略。
只提有证据的新建议：value ≥ ${behavior.proposalMinValue.toFixed(2)} 且 confidence ≥ ${behavior.proposalMinConfidence.toFixed(2)}，否则进点子池；周上限与拒绝冷却不变。没有建议就不提，不为性格凑数。`;
}
