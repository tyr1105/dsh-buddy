/**
 * P74r20 第 1 节的测试：发布这一步收尾时，给主人看的两句话。
 *
 * 照第四次真实模型验证第二件事的情形：发布位置是一个只读目录，发布命令运行失败（Permission denied），
 * 执行者被叫醒后交账写做不下去，blocker 里带着路径和权限字样（r-xr-xr-x）。
 * 1 总管私聊落固定的一句（逐字），不含路径、权限字样、执行者的原话；主题里「这件事没有发布。」照旧；
 * 2 「没有发布成功」那一句不再有「中心」两个字，其余原因的句子不变；
 * 3 反例：还没有提交发布命令就说做不了，仍是 P74r19 的写法。
 */
import { describe, expect, it } from 'vitest';
import { executeReadyOutbox } from '../src/gate/outbox.js';
import { launchBlockedText, launchFailedBlockedText, launchLocationBlockedText } from '../src/job/launch-blocked.js';
import { launchFailedText } from '../src/job/launch-result.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { nextPacket, theJob, threadOf, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, submitLaunch } from './p74g-launch-fixtures.js';

const DENIED_ERR = 'cp: /tmp/p74l4-fail/index.html: Permission denied';
const DENIED = { code: 1, stdout: '', stderr: DENIED_ERR, timedOut: false };
/** 第四次验证里执行者交账的 blocker 原文（带路径和权限字样）。 */
const RAW_BLOCKER = '发布位置写不进去：/tmp/p74l4-fail 目录存在但权限是只读（r-xr-xr-x），任何复制进去的操作都会被拒。这不是命令写错了，需要主人处理该目录权限或另定发布位置。';
/** 逐字：第 1 节第 1 条的固定句（标题「会员定价页」，执行者「林舟」）。 */
const FIXED = '会员定价页没有发布：发布命令没有运行成功，林舟无法改正。要换一个发布位置或方式时告诉我，我再安排。';

const chiefReplies = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.kind === 'reply').map(row => row.text);
const blockedLines = (fix: JobFix) => chiefReplies(fix).filter(text => text.includes('没有发布') && !text.includes('没有发布成功'));
const topicTexts = (fix: JobFix, topicId: string) => threadOf(fix.ctx, topicId).map(row => row.text);

describe('1 发布命令失败之后执行者说做不了：固定的一句', () => {
  it('句子逐字', () => {
    expect(launchFailedBlockedText('会员定价页', '林舟')).toBe(FIXED);
    expect(launchBlockedText({ title: '会员定价页', executor: '林舟', reason: RAW_BLOCKER, afterFailed: true })).toBe(FIXED);
  });

  it('第四次验证第二件事的情形：总管私聊落固定句，不含路径和权限字样；主题里「这件事没有发布。」照旧', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    fix.ctx.exec.set('node', ['work/go-live.js'], DENIED);
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    await executeReadyOutbox(fix.ctx);
    expect(theJob(fix).launch.state).toBe('failed');
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: RAW_BLOCKER, summary: '写不进去' });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'hub' } });
    // 总管私聊：只有固定句，没有引用执行者的原话。
    expect(blockedLines(fix)).toEqual([FIXED]);
    expect(blockedLines(fix)[0]).not.toMatch(/\/tmp|r-xr-xr-x|权限|只读|写不进去/);
    // 主题里「这件事没有发布。」照旧。
    expect(topicTexts(fix, job.topicId).filter(text => text === '这件事没有发布。')).toHaveLength(1);
  });

});

describe('2 「没有发布成功」那一句去掉「中心」', () => {
  const t = (reason: string, result: string) => launchFailedText('会员定价页', { ownerFailureReason: reason, result });
  it('写入被拒的句子逐字，其余几种原因的句子不变', () => {
    expect(t('命令退出码 1', `命令退出码 1：${DENIED_ERR}`)).toBe('「会员定价页」没有发布成功：要发布到的位置写不进去。');
    expect(t('命令退出码 1', `命令退出码 1：${DENIED_ERR}`)).not.toContain('中心');
    expect(t('命令超时', '命令超时：')).toBe('「会员定价页」没有发布成功：命令超时');
    // P82：其他原因的句子逐字保留，末尾用括号带上宿主原文（中心确认的失败原因）。
    expect(t('命令退出码 2', '命令退出码 2：boom')).toBe('「会员定价页」没有发布成功：发布命令运行出错（命令退出码 2）。');
  });
});

describe('3 反例：还没有提交发布命令就说做不了', () => {
  it('仍是 P74r19 的写法（固定位置句，或引用第一句），不是新的固定句', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '发布位置不在能写入的范围内', summary: '写不进去' });
    expect(blockedLines(fix)).toEqual([launchLocationBlockedText('会员定价页')]);
    expect(blockedLines(fix)[0]).not.toBe(FIXED);
  });

  it('其他原因仍引用第一句', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺少发布网站的登录账号。需要主人提供。', summary: '缺账号' });
    expect(blockedLines(fix)).toEqual(['会员定价页的发布这一步没有做成：林舟说缺少条件（缺少发布网站的登录账号）。没有发布。要发布时告诉我发布到哪里、用什么方式，我再安排。']);
  });
});
