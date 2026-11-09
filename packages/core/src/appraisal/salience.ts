/** 显著性是确定性加权分数：输入显式给出全部维度，分档与权重可通过设置覆盖。 */
import { z } from 'zod';
import { resolveSettings } from '../config/defaults.js';
import type { Percept, Settings } from '../model/index.js';
import { bool, ratio } from '../model/primitives.js';
import { parseInput } from '../engine/validation.js';

const PartsSchema = z.strictObject({ relevance: ratio, novelty: ratio, magnitude: ratio, importance: ratio, urgency: ratio, anomaly: bool });
export type SalienceParts = z.infer<typeof PartsSchema>;
/** 统一精确到万分位，避免数学上等于阈值的分数被浮点尾差降档。 */
export function roundScore(score: number): number { return Math.round(score * 10_000) / 10_000; }
/** 按可配置边界分成四档，保证评分与入队口径一致。 */
export function tierFor(score: number, settings: Settings = resolveSettings()): Percept['tier'] {
  score = roundScore(score);
  return score >= settings.salienceUrgent ? 'urgent' : score >= settings.salienceCandidate ? 'candidate'
    : score >= settings.saliencePile ? 'pile' : 'record';
}
/** 校验各维度后加权评分并封顶，异常额外加分以优先暴露风险。 */
export function computeSalience(parts: SalienceParts, settings: Settings = resolveSettings()) {
  const p = parseInput(PartsSchema, parts, '显著性参数');
  const w = settings.c02.salienceWeights;
  const salience = roundScore(Math.min(1, Math.max(0, w.relevance * p.relevance + w.novelty * p.novelty + w.magnitude * p.magnitude
    + w.importance * p.importance + w.urgency * p.urgency + (p.anomaly ? w.anomaly : 0))));
  return { salience, tier: tierFor(salience, settings) };
}
