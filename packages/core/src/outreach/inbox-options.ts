/** 收件箱按钮与回答约定共用一份定义，旧卡片也能展示当前合法值，界面无需硬编码文案。 */
import type { InboxItem } from '../model/outreach.js';

/** 提议同义词统一为界面按钮原文；旧答案统计也复用同一判断，避免新回答漏入接受率。 */
export function proposalAnswer(answer: string): '接受' | '不做' | null {
  const normalized = answer.replace(/\s+/g, '').toLowerCase();
  if (['接受', '同意', '好', 'accept'].includes(normalized)) return '接受';
  if (['不做', '拒绝', '不要', 'reject'].includes(normalized)) return '不做';
  return null;
}

/** 固定决策卡使用中心约定；问题保留机器人原选项，同时仍允许主人填写自由文本。 */
export function inboxOptions(item: Pick<InboxItem, 'type' | 'options'>): string[] {
  switch (item.type) {
    case 'proposal': return ['接受', '不做'];
    case 'approval': return ['批准', '拒绝'];
    case 'alert': return ['知道了'];
    case 'question': return [...item.options];
  }
}

/** 将旧提议的默认值映射到当前按钮，不能让界面收到不在 options 中的旧「拒绝」。 */
export function inboxDefaultOption(item: Pick<InboxItem, 'type' | 'defaultOption'>): string | null {
  if (item.type === 'proposal' && item.defaultOption !== null) return proposalAnswer(item.defaultOption);
  if (item.type === 'alert') return item.defaultOption === null ? null : '知道了';
  return item.defaultOption;
}
