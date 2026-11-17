/**
 * 技能核对的几个共用事实（P75h）：待核对的更新有哪些、「出处在记录里真实存在」怎么判、通过后会是第几版。
 *
 * 为什么单独放：唤醒包（wake/skill-check-section.ts）、check 工具（skill/check.ts）、回合收尾（skill/run.ts）、
 * 核对卡视图（api/skill-check-card.ts）都要用这几个判断；各写一份会不一致（例如唤醒包列了的更新，核对时又说不在清单里）。
 * 本文件只读存储，不写任何东西，也不引用 run.ts，避免互相引用。
 */
import type { HubContext } from '../engine/context.js';
import type { SkillUpdate } from '../model/index.js';

/**
 * 这位核对人在这次复盘里「等他核对」的更新：状态 checking、核对人是他。
 * asOf 不为空时只要「在这个时刻之前已经进入核对中」的更新（updatedAt 不晚于 asOf）：
 * 回合开始之后才提交或改写的更新不在这个回合的核对清单里（唤醒包里没有它的句子，核对人没见过）。
 */
export function pendingChecksFor(ctx: HubContext, runId: string, checkerId: string, asOf: number | null = null): SkillUpdate[] {
  return ctx.store.table('skillUpdates')
    .list(row => row.runId === runId && row.checkerId === checkerId && row.state === 'checking' && (asOf === null || row.updatedAt <= asOf))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * 三项检查的第一项（方案 7.3 第 4 点）：出处在记录里真实存在，由中心判，不让模型判：
 * 更新每一句引用的每个出处编号都在 skillSources 表里、属于提交人、原文不为空。全部满足为 met，否则 unmet。
 */
export function existsVerdict(ctx: HubContext, update: SkillUpdate): 'met' | 'unmet' {
  for (const sentence of update.sentences) {
    for (const id of sentence.sourceIds) {
      const source = ctx.store.table('skillSources').get(id);
      if (source === null || source.botId !== update.botId || source.quote.trim() === '') return 'unmet';
    }
  }
  return 'met';
}

/** 这条更新通过后会写成第几版：已有技能是它现有最大版本号加 1；新建是第 1 版。 */
export function versionNoIfPassed(ctx: HubContext, update: SkillUpdate): number {
  if (update.versionNo !== null) return update.versionNo;
  if (update.skillId === null) return 1;
  const nos = ctx.store.table('skillVersions').list(row => row.skillId === update.skillId).map(row => row.no);
  return (nos.length === 0 ? 0 : Math.max(...nos)) + 1;
}

/** 更新状态给模型看的中文（错误提示用）。 */
export const UPDATE_STATE_TEXT: Record<SkillUpdate['state'], string> = {
  checking: '核对中', rewrite: '等待改写', passed: '已写入技能库', abandoned: '已放弃',
};
