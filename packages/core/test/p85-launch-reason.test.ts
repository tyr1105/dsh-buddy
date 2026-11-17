/**
 * P85 第 3.7 节的测试：发布失败那一句只用固定的原因（审查 W8）。
 *
 * - 命令运行了、以非零退出码结束：照原来的写法「发布命令运行出错（命令退出码 N）。」；
 * - 命令没有运行：「「{标题}」没有发布成功：发布命令没有运行（{原因}）。」，原因只有四种固定说法：
 *   找不到命令里的程序、没有运行这条命令的权限、命令的执行目录不在允许的范围内、运行命令时出错（其余情形都归到最后一种）；
 * - 异常原文、绝对路径、命令名不出现在给主人看的这一句里；它们仍留在出站记录和给执行者的唤醒原因里；
 * - P81 的「约定的发布位置现在指向别处，没有运行发布命令。」不变。
 */
import { describe, expect, it } from 'vitest';
import { executeReadyOutbox } from '../src/gate/outbox.js';
import { launchFailedText, NOT_RUN_REASONS } from '../src/job/launch-result.js';
import { LOCAL_DIR_CHANGED_REASON } from '../src/project/local-dir.js';
import { entriesOf, wakesOf } from './p74c-fixtures.js';
import { threadOf, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, submitLaunch } from './p74g-launch-fixtures.js';

const TITLE = '会员定价页';
/** 命令没有运行时，出站记录里留着的异常原文（四种）。 */
const RAW = {
  noProgram: '启动命令失败：spawn deploy-site ENOENT',
  noPermission: "EACCES: permission denied, realpath '/Users/someone/site'",
  badCwd: '命令执行目录必须在家目录或共享目录内，宿主命令不运行',
  other: '宿主命令崩溃了 at /Users/someone/work/run.js:12',
};
const notRun = (reason: string) => `「${TITLE}」没有发布成功：发布命令没有运行（${reason}）。`;
const row = (raw: string) => ({ ownerFailureReason: raw, result: raw, executionStarted: false });

describe('3.7 固定句：命令没有运行的四种原因（逐字）', () => {
  it('四种固定原因各一句，且句子里没有异常原文、命令名和绝对路径', () => {
    expect([...NOT_RUN_REASONS]).toEqual(['找不到命令里的程序', '没有运行这条命令的权限', '命令的执行目录不在允许的范围内', '运行命令时出错',
      '命令用到的脚本在批准之后被改动', '现在的权限设置不允许运行这条命令']);
    expect(launchFailedText(TITLE, row(RAW.noProgram))).toBe(notRun('找不到命令里的程序'));
    expect(launchFailedText(TITLE, row(RAW.noPermission))).toBe(notRun('没有运行这条命令的权限'));
    expect(launchFailedText(TITLE, row(RAW.badCwd))).toBe(notRun('命令的执行目录不在允许的范围内'));
    expect(launchFailedText(TITLE, row(RAW.other))).toBe(notRun('运行命令时出错'));
    for (const raw of Object.values(RAW)) {
      const text = launchFailedText(TITLE, row(raw));
      for (const leak of ['ENOENT', 'EACCES', 'spawn', 'deploy-site', '/Users', 'realpath', '宿主命令', '家目录']) expect(text, raw).not.toContain(leak);
    }
  });

  it('复验 C3：脚本在批准之后被改动、权限设置不允许，各有固定原因，不落到兜底说法，且没有英文异常原文和绝对路径', () => {
    const script = launchFailedText(TITLE, { ownerFailureReason: '脚本在批准后被改动', result: '脚本在批准后被改动', executionStarted: false });
    expect(script).toBe(notRun('命令用到的脚本在批准之后被改动'));
    const level = launchFailedText(TITLE, { ownerFailureReason: '当前自主等级不允许：这条命令由中心在受限沙箱内运行，要主人批准', result: '当前自主等级不允许：x /Users/a/b ENOENT', executionStarted: false });
    expect(level).toBe(notRun('现在的权限设置不允许运行这条命令'));
    for (const text of [script, level]) for (const leak of ['/Users', 'ENOENT', 'EACCES', 'spawn']) expect(text).not.toContain(leak);
  });

  it('命令运行了、非零退出码：照原来的写法；运行了但没有标记时（旧记录）也照原来的写法', () => {
    expect(launchFailedText(TITLE, { ownerFailureReason: '命令退出码 2', result: '命令退出码 2：boom', executionStarted: true }))
      .toBe(`「${TITLE}」没有发布成功：发布命令运行出错（命令退出码 2）。`);
    expect(launchFailedText(TITLE, { ownerFailureReason: '命令退出码 2', result: '命令退出码 2：boom' }))
      .toBe(`「${TITLE}」没有发布成功：发布命令运行出错（命令退出码 2）。`);
  });

  it('P81 的固定句不变：发布位置现在指向别处', () => {
    expect(launchFailedText(TITLE, { ownerFailureReason: LOCAL_DIR_CHANGED_REASON, result: LOCAL_DIR_CHANGED_REASON, executionStarted: false }))
      .toBe(`「${TITLE}」没有发布成功：约定的发布位置现在指向别处，没有运行发布命令。`);
  });
});

/** 批准、让命令执行接口抛出这条异常、中心运行完。 */
async function runFailing(fix: JobFix, approvalId: string, error: Error): Promise<void> {
  fix.ctx.exec.set('node', ['work/go-live.js'], error);
  expect(await fix.hub.api.decideApproval(approvalId, true)).toMatchObject({ ok: true });
  await executeReadyOutbox(fix.ctx);
}

describe('3.7 真实链路：主题和总管私聊里的那一句；异常原文只留在出站记录和给执行者的唤醒原因里', () => {
  it.each([
    ['找不到命令程序', new Error(RAW.noProgram), '找不到命令里的程序', 'ENOENT'],
    ['没有权限', new Error(RAW.noPermission), '没有运行这条命令的权限', 'EACCES'],
    ['其他异常', new Error(RAW.other), '运行命令时出错', '宿主命令崩溃了'],
  ] as const)('%s：给主人的一句是固定原因', async (_name, error, reason, rawMark) => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    await runFailing(fix, approval.id, error);
    const said = [...threadOf(fix.ctx, fix.chief.id), ...threadOf(fix.ctx, job.topicId)]
      .filter(message => message.from === fix.chief.id && message.kind === 'reply' && message.text.includes('没有发布成功'));
    expect(said.map(message => message.text)).toEqual([notRun(reason), notRun(reason)]);
    for (const message of said) expect(message.text).not.toContain(rawMark);
    // 出站记录里仍是异常原文。
    const outbox = fix.ctx.store.table('outbox').list()[0]!;
    expect(outbox.status).toBe('failed');
    expect(outbox.executionStarted).toBe(false);
    expect(outbox.result).toContain(rawMark);
    // 给执行者的唤醒原因里也仍带着原文。
    const summaries = [...entriesOf(fix, fix.engineer.id, job.id), ...wakesOf(fix, fix.engineer.id, job.id)]
      .map(item => ('reason' in item ? item.reason.summary : ''));
    expect(summaries.some(text => text.includes(rawMark))).toBe(true);
  });
});
