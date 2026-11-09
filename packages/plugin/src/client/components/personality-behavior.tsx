/**
 * 档案展示后端实际性格策略，帮助主人确认选择确实影响行为。
 * 前端不推算门槛；旧接口缺字段时明确未读到，避免把默认数字当成真实配置。
 */
import type { BotView } from '../../shared/views.js'

export function PersonalityBehavior({ profile }: { profile: BotView['profile'] }) {
  if (profile.behavior === undefined) return <p className="ah-right-kv">性格行为策略读取失败。请刷新页面重试。</p>
  if (profile.behavior === null) return <p className="ah-right-kv">未设置 MBTI，沿用原门槛、汇报与提议规则。</p>
  const policy = profile.behavior
  return <div aria-label="性格行为策略">
    <p className="ah-right-kv">普通自主候选额外门槛：至多 +{policy.wakeOffset.toFixed(2)}</p>
    <p className="ah-right-kv">普通自主汇报：最多 {policy.reportMaxChars} 字；原文保留在交账。</p>
    <p className="ah-right-kv">提议底线：价值 {policy.proposalMinValue.toFixed(2)} · 置信度 {policy.proposalMinConfidence.toFixed(2)}</p>
    <p className="ah-right-kv">主人要求、紧急与承诺优先；权限、审批、额度不变。修改后影响新判断。</p>
  </div>
}
