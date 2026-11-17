/**
 * P88r1 的测试：说一件已经验收的事「做完了」，不再被补上「没有可以核对的结果」。
 * 覆盖：
 * 1-2 复验里那句原文：名单里有标题时不补句，名单为空时照旧补句；
 * 3   两句话：第二句说的事不在名单里，补句；
 * 4   同一句里顺带说的另一件事随这一句放行（已知边界，见用例注释）；
 * 5   已停止、别的总管、验收超过天数的事不在名单里（名单取数 recentAcceptedTitles）；
 * 6   只有 2 个字符相同不放行；
 * 7   走真实入口：一件事验收之后，总管在主人发起的私聊回合里交账，保存下来的回复没有补句。
 */
import { describe, expect, it } from 'vitest';
import { UNVERIFIED_CLAIM_NOTE, hasCompletionClaim, noteUnverifiedClaims } from '../src/commit/claim-evidence.js';
import { recentAcceptedTitles } from '../src/job/recent-closed.js';
import type { Job } from '../src/model/job.js';
import { newId } from '../src/util/ids.js';
import { jobFix, runningJob, speak, type JobFix } from './p74c-fixtures.js';
import { ownerSays } from './p74b-fixtures.js';

const NOTE = UNVERIFIED_CLAIM_NOTE;
const DAY = 24 * 60 * 60 * 1000;
const NO_TOOLS = new Set<never>();
/** 复验第 15 回合里总管的回复原文（事实全部正确）。 */
const REPLY = '签到页已经做完：返工去掉 ✅ 图标后核对通过，你今天（11月17日）已验收完成，这件事收尾了；需要放到哪里或再改，随时说。';

describe('名单与按句放行', () => {
  it('1 复验原文：名单里有「活动签到页」，不补句', () => {
    expect(noteUnverifiedClaims(REPLY, NO_TOOLS, ['活动签到页'])).toBe(REPLY);
    expect(hasCompletionClaim(REPLY, NO_TOOLS, ['活动签到页'])).toBe(false);
  });

  it('2 同一句，名单为空（或省略）：照旧补句', () => {
    expect(noteUnverifiedClaims(REPLY, NO_TOOLS, [])).toBe(`${REPLY}\n${NOTE}`);
    expect(noteUnverifiedClaims(REPLY)).toBe(`${REPLY}\n${NOTE}`);
  });

  it('3 两句话：第一句说名单里的事，第二句「反馈页也已经改好了。」不在名单里：补句', () => {
    const text = '签到页已经做完，你已验收。反馈页也已经改好了。';
    expect(hasCompletionClaim(text, NO_TOOLS, ['活动签到页'])).toBe(true);
    expect(noteUnverifiedClaims(text, NO_TOOLS, ['活动签到页'])).toBe(`${text}\n${NOTE}`);
    // 反过来：只有第一句时不补。
    expect(hasCompletionClaim('签到页已经做完，你已验收。', NO_TOOLS, ['活动签到页'])).toBe(false);
  });

  it('4 同一句里顺带的另一件事随这一句放行（已知边界：按句放行，一句话里顺带说的另一件事不再核对）', () => {
    const text = '签到页已验收完成，反馈页也已经做完了。';
    expect(noteUnverifiedClaims(text, NO_TOOLS, ['活动签到页'])).toBe(text);
  });

  it('6 只有 2 个字符相同（标题「活动签到页」，句子「活动反馈页已经做完了。」）：不放行，补句', () => {
    const text = '活动反馈页已经做完了。';
    expect(noteUnverifiedClaims(text, NO_TOOLS, ['活动签到页'])).toBe(`${text}\n${NOTE}`);
  });

  it('问句、否定句的判断不变；标点与空白不影响片段比较', () => {
    expect(hasCompletionClaim('签到页已经做完了吗？', NO_TOOLS, ['活动签到页'])).toBe(false);
    expect(hasCompletionClaim('签 到，页 已经做完了。', NO_TOOLS, ['活动签到页'])).toBe(false);
    expect(hasCompletionClaim('反馈页已经做完了。', NO_TOOLS, ['活动签到页'])).toBe(true);
  });
});

/** 以在办的事为底，写入一件别的状态、别的收尾时间的事。 */
function copyOf(fix: JobFix, base: Job, patch: Partial<Job>): void {
  fix.ctx.store.table('jobs').put({ ...base, id: newId('job', fix.ctx.rng), blocked: null, ...patch });
}

describe('5 名单取数', () => {
  it('已完成、7 天内、本总管名下才在名单里；已停止、别的总管名下、超过天数的不在', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    const now = fix.ctx.clock.now();
    // 在办的事不在名单里。
    expect(recentAcceptedTitles(fix.ctx, fix.chief.id)).toEqual([]);
    copyOf(fix, job, { state: 'stopped', stoppedAt: now - DAY, updatedAt: now - DAY });
    copyOf(fix, job, { state: 'done', acceptedAt: now - DAY, updatedAt: now - DAY, chiefId: fix.reviewer.id });
    copyOf(fix, job, { state: 'done', acceptedAt: now - 8 * DAY, updatedAt: now - 8 * DAY });
    expect(recentAcceptedTitles(fix.ctx, fix.chief.id)).toEqual([]);
    // 上面三种情形下，说这件事做完了照旧补句。
    const titles = recentAcceptedTitles(fix.ctx, fix.chief.id);
    expect(noteUnverifiedClaims('会员定价页已经做完了。', NO_TOOLS, titles)).toBe(`会员定价页已经做完了。\n${NOTE}`);
    // 验收时间缺失取 updatedAt：算。
    copyOf(fix, job, { state: 'done', acceptedAt: null, updatedAt: now - 2 * DAY });
    expect(recentAcceptedTitles(fix.ctx, fix.chief.id)).toEqual(['会员定价页']);
  });
});

describe('7 走真实入口', () => {
  it('一件事验收之后，总管在主人发起的私聊回合里交账：保存下来的回复没有补句；没有验收时照旧补句', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await ownerSays(fix, fix.chief.id, '会员定价页现在什么情况？');
    const now = fix.ctx.clock.now();
    // 对照：这件事还没有验收，同样的话补句。
    await speak(fix, fix.chief, '会员定价页已经做完：你已验收完成，这件事收尾了。', { outcome: 'progress' });
    const lastReply = (): string | null => fix.ctx.store.table('commits').list(row => row.botId === fix.chief.id)
      .sort((a, b) => a.createdAt - b.createdAt).at(-1)!.reply;
    expect(lastReply()).toBe(`会员定价页已经做完：你已验收完成，这件事收尾了。\n${NOTE}`);
    // 这件事验收之后，同样的话不补句。
    fix.ctx.store.table('jobs').put({ ...fix.ctx.store.table('jobs').get(job.id)!, state: 'done', acceptedAt: now - 1000, updatedAt: now - 1000 });
    await ownerSays(fix, fix.chief.id, '再说一遍现在什么情况？');
    await speak(fix, fix.chief, '会员定价页已经做完：你已验收完成，这件事收尾了。', { outcome: 'progress' });
    expect(lastReply()).toBe('会员定价页已经做完：你已验收完成，这件事收尾了。');
  });
});
