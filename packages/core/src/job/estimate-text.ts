/**
 * 约定卡上「预计消耗」一段的文字（P76e）。纯函数：输入是一项预计和几个事实，输出是逐字固定的句子。
 *
 * 为什么单独放：约定卡视图（api/agreement-views.ts）只负责把它接上；文字全部由中心拼，不调用模型。
 * token 数一律经 formatTokenCount 换算成带单位的短写法（380K、1.64M）；不出现内部编号、工具名、英文步骤名。
 */
import { BUDGET_DEFAULTS as D, JOB_DEFAULTS } from '../config/defaults.js';
import type { EstimateVersion } from '../model/budget.js';
import { formatTokenCount } from '../util/token-format.js';

/** 约定卡视图里「预计消耗」一段。 */
export interface EstimateCardView {
  title: '预计消耗';
  headline: string;
  lines: string[];
  basisLine: string;
  footer: string;
}

/** 生成「预计消耗」一段所需的事实：执行者与核对人的名字（没有人选时写「执行者」「核对人」；派活后没有核对人为 null，写总管核对）、有没有发布这一步。 */
export interface EstimateCardFacts {
  executorName: string;
  reviewerName: string | null;
  hasLaunch: boolean;
}

/** 一段「预计消耗」（逐字）。 */
export function estimateCardOf(estimate: EstimateVersion, facts: EstimateCardFacts): EstimateCardView {
  const lo = formatTokenCount(estimate.tokenLow);
  const hi = formatTokenCount(estimate.tokenHigh);
  const { steps } = estimate;
  const checker = facts.reviewerName === null ? '总管核对' : facts.reviewerName;
  const lines = [
    `对齐 ${steps.align} 回合（总管，已用）`,
    `执行 ${steps.exec} 回合（${facts.executorName}）`,
    `核对 ${steps.review} 回合（${checker}，每轮 ${D.REVIEW_PER_ROUND} 回合，最多 ${JOB_DEFAULTS.REVIEW_ROUNDS_MAX} 轮）`,
    `返工预留 ${steps.rework} 回合（核对不通过时使用；未用到的不消耗）`,
    ...(steps.chief > 0 ? [`总管预留 ${steps.chief} 回合（回答员工的问题）`] : []),
    ...(facts.hasLaunch ? [`对外发布另计，最多 ${D.LAUNCH_NOTE_TURNS} 回合。`] : []),
  ];
  return {
    title: '预计消耗',
    headline: lo === hi ? `${estimate.total} 回合，约 ${lo} token。` : `${estimate.total} 回合，约 ${lo} 到 ${hi} token。`,
    lines,
    basisLine: estimate.basis === 'history' ? `按 ${estimate.historyCount} 件同类事的记录估计。` : '首次估计：没有同类事的记录，按每一步的默认份额估计。',
    footer: `1 回合指一位员工被唤醒后连续工作一轮。用到 ${estimate.total} 回合仍未做完时，我会先问你，不会自行超出。`,
  };
}
