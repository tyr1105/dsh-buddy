/**
 * 任务验收前的提醒（F08 尾巴）：任务走到「待验收」时，把主人在点「验收通过」前
 * 值得先看一眼的事实摆出来——没关联产物、最新产物比任务还旧、最新版本上次被判不合格。
 *
 * 为什么只提醒不阻断：这些事实都不足以替主人下结论（有的任务本来就不交文件，
 * 有的产物是上一轮做的但依然有效）。规则写成纯函数，输入显式给状态、时间和产物摘要，
 * 页面与视图共用同一套口径，不在界面里重写。
 */
import type { ArtifactVerdict } from '../model/artifact.js';
import { ARTIFACT_VERDICT_LABELS } from '../model/artifact.js';
import type { TaskStatus } from '../model/project.js';

/** 一条关联产物里验收判定需要的最小事实（由视图行裁剪而来，便于单测）。 */
export interface AcceptanceArtifactFacts {
  number: number;
  createdAt: number;
  reviewVerdict: ArtifactVerdict | null;
}

/** 评估输入：任务状态、最近修改时间与已解析出的关联产物。 */
export interface AcceptanceFacts {
  status: TaskStatus;
  updatedAt: number;
  artifacts: readonly AcceptanceArtifactFacts[];
}

/** 评估结果：提醒文案列表；空数组表示没有需要特别注意的。 */
export interface AcceptanceEvaluation {
  hints: string[];
}

/**
 * 生成验收提醒：只有「待验收」任务才有提醒；按「没产物 → 最新结论 → 版本新旧」顺序给。
 * 文案说事实与后果，不替主人判断该不该通过。
 */
export function evaluateAcceptance(facts: AcceptanceFacts): AcceptanceEvaluation {
  if (facts.status !== 'done_pending_check') return { hints: [] };
  if (facts.artifacts.length === 0) {
    return { hints: ['这条任务还没有关联产物：验收前先看执行者交了什么，或先关联产物。'] };
  }
  const newest = [...facts.artifacts].sort((a, b) => b.createdAt - a.createdAt)[0]!;
  const hints: string[] = [];
  if (newest.reviewVerdict === null) {
    hints.push(`最新产物 v${newest.number} 还没有单独验收；验收通过会一并记为通过。`);
  } else if (newest.reviewVerdict !== 'passed') {
    hints.push(`最新产物 v${newest.number} 上次的结论是「${ARTIFACT_VERDICT_LABELS[newest.reviewVerdict]}」；确认返工后再验收。`);
  }
  if (newest.createdAt < facts.updatedAt) {
    hints.push('最新产物生成于任务最近一次修改之前，可能不是这一轮的产出。');
  }
  return { hints };
}
