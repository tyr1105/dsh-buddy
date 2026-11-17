/**
 * P75r6 测试的公共环境（不是测试文件）：在 p75r5c 的夹具上，提供「五种技能类回合各自走到回合开着的那一刻」的起点，
 * 以及「每种回合里员工只用唤醒包里的文字做该做的那一步」的完整动作。
 *
 * 为什么放在一起：只读收紧（第 1 节）、名称进围栏之后只用唤醒包里的编号调用（第 2 节）都要在五种回合里各试一遍，
 * 起点和「该做的那一步」写一份，几个测试文件共用。夹具与真实情况一致（总管自动创建、听吩咐；执行类员工听吩咐），
 * 时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { expect } from 'vitest';
import {
  MINUTE, THIRD_BACK, afterExecutorProposes, bot, callTool, commitAndEnd, flow, learnAsked, learnerProposes, nextPacket, putSessions,
  retroTurn, reviewerRejects, rewriteIdsIn, rewritePacket, rewriteSrcsIn, seedExport, seedSkill, skillRefsIn, srcsIn, tick, tidyPacket, tidyScene,
  tidySectionOf, tidySkillNamesIn, tidySkillRefsIn, tidySrcsOfSkill, twoSentences, updatesIn, expectMigrated, type JobFix,
} from './p75r5c-fixtures.js';

export * from './p75r5c-fixtures.js';

/** 主人点学习提问卡上的第一段（按钮入口，与界面同一条命令）。 */
export async function chooseLearnByButton(fix: JobFix, asked: Awaited<ReturnType<typeof learnAsked>>) {
  const view = fix.hub.api.thread(fix.chief.id).messages.find(row => row.id === asked.card.id)!;
  return fix.hub.api.chooseLearnSession({ runId: view.card!.learnRunId, option: view.card!.options[0] });
}

/** 五种技能类回合。 */
export type SkillTurnKind = 'learn' | 'retro' | 'check' | 'rewrite' | 'tidy';
export const SKILL_TURN_KINDS: SkillTurnKind[] = ['learn', 'retro', 'check', 'rewrite', 'tidy'];

/** 一个开着的技能类回合：夹具、拿到回合的员工编号、这个回合的完整唤醒包。 */
export interface OpenTurn { kind: SkillTurnKind; fix: JobFix; botId: string; packet: string }

/** 走到某一种技能类回合开着的那一刻（员工已拿到回合，还没有做任何事）。 */
export async function openTurn(kind: SkillTurnKind): Promise<OpenTurn> {
  if (kind === 'learn') {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    expect(await chooseLearnByButton(fix, asked)).toMatchObject({ ok: true });
    return { kind, fix, botId: fix.engineer.id, packet: await nextPacket(fix, fix.engineer.id) };
  }
  if (kind === 'retro') {
    const { fix } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK });
    await seedSkill(fix, fix.engineer.id, '表单页做法', ['提交后显示明确的成功提示']);
    const turn = await retroTurn(fix, fix.engineer.id);
    return { kind, fix, botId: fix.engineer.id, packet: turn.packet };
  }
  if (kind === 'check') {
    const { fix } = await afterExecutorProposes();
    return { kind, fix, botId: fix.reviewer.id, packet: await nextPacket(fix, fix.reviewer.id) };
  }
  if (kind === 'rewrite') {
    const { fix } = await afterExecutorProposes();
    await reviewerRejects(fix);
    return { kind, fix, botId: fix.engineer.id, packet: await rewritePacket(fix) };
  }
  const { fix } = await tidyScene();
  await tick(fix, MINUTE);
  return { kind, fix, botId: fix.engineer.id, packet: await tidyPacket(fix, fix.engineer.id) };
}

/**
 * 在开着的回合里「做该做的那一步」，只用唤醒包里的文字（出处编号、技能编号、更新编号），然后交账收尾。
 * 返回这一步 hub_skill 的结果文字；调用不成功时测试直接失败（附上工具返回，方便看是哪一项被拒）。
 */
export async function doTheStep(turn: OpenTurn): Promise<string> {
  const { fix, kind, botId, packet } = turn;
  let result: { ok: boolean; text?: string; error?: string };
  if (kind === 'learn') {
    result = (await learnerProposes(fix)).result;
  } else if (kind === 'retro') {
    const srcs = srcsIn(packet);
    const review = srcs.find(row => row.kind === '评审意见')!;
    const correction = srcs.find(row => row.label.includes('验收第'))!;
    result = await callTool(fix, bot(fix, botId), 'hub_skill', { mode: 'propose', updates: [{ skill: skillRefsIn(packet)[0], sentences: twoSentences(review.src, correction.src) }] });
  } else if (kind === 'check') {
    result = await callTool(fix, bot(fix, botId), 'hub_skill', { mode: 'check', updateId: updatesIn(packet)[0]!.id, consistent: 'met', withinScope: 'met' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    // 评审员的合并唤醒里还有他自己的复盘：写「没有可写的」让参与者记完成。
    expect(await callTool(fix, bot(fix, botId), 'hub_skill', { mode: 'propose', updates: [], note: '这次没有可复用的做法' })).toMatchObject({ ok: true });
  } else if (kind === 'rewrite') {
    const srcs = rewriteSrcsIn(packet);
    result = await callTool(fix, bot(fix, botId), 'hub_skill', { mode: 'revise', updateId: rewriteIdsIn(packet)[0]!, sentences: [
      { text: '失败时页面要显示明确的失败提示', sources: [srcs[0]!.src] }, { text: '交回前试一次失败提示', sources: [srcs[1]!.src] }] });
  } else {
    const names = tidySkillNamesIn(packet);
    const refs = tidySkillRefsIn(packet);
    const phone = tidySrcsOfSkill(packet, '手机端适配')[0]!;
    const form = tidySrcsOfSkill(packet, '表单页做法')[0]!;
    result = await callTool(fix, bot(fix, botId), 'hub_skill', { mode: 'tidy', note: '没有发现相互矛盾的条目', merges: [{
      from: refs[names.indexOf('手机端适配')], into: refs[names.indexOf('表单页做法')], reason: '两条都要求手机上不出现横向滚动',
      sentences: [{ text: '手机上不出现横向滚动', sources: [phone] }, { text: '提交后显示明确的成功提示', sources: [form] }],
    }] });
    expect(tidySectionOf(packet)).toContain('名称：手机端适配');
  }
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, botId, { outcome: 'progress', summary: '这一步完成', reply: '完成了。' });
  return result.text ?? '';
}

export { putSessions, MINUTE };
