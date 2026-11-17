/**
 * 员工状态文字里「受阻」的显示（P74r7 第 4 节）。
 *
 * 为什么需要：交账里的 blocker 是模型写的原文，原来直接拼进左栏员工的状态文字（「受阻：……」）。
 * 真实模型写进去的原因里含有工具名，工具名就这样到了主人面前。
 *
 * 做法：只处理与「一件事」有关的回合（唤醒单带这件事的编号）。blocker 含内部名称（工具名、编号等）或看不见的字符时，
 * 换成固定句；不含的原样显示。不带这件事编号的回合（员工自己的目标、主人直聊）显示不动。
 */
import { ownerTextProblem } from './owner-text.js';

/** blocker 含内部名称时给主人看的固定句。 */
export const BLOCKED_SEE_THREAD = '受阻，详情见对话';

/** 员工状态文字：带这件事编号的回合按内部名称检查，其余原样。 */
export function blockedActivityText(blocker: string | null | undefined, jobId: string | null | undefined): string {
  const text = blocker ?? '';
  const forJob = typeof jobId === 'string' && jobId !== '';
  if (forJob && ownerTextProblem('受阻原因', text) !== null) return BLOCKED_SEE_THREAD;
  return `受阻：${text}`;
}
