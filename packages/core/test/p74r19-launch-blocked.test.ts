/**
 * P74r19 第 3 节的测试：发布这一步做不了时，总管私聊里给主人的那句话。
 *
 * 照第三次验证第二件事的情形：约定的发布位置在主人的桌面（中心代为运行时写不进去）。
 * 执行者只按唤醒包（或预先核对拒绝）里的文字交账 blocked；总管私聊落一句固定的话，逐字，不含「中心」「~/Desktop」。
 * 其他原因仍引用执行者的话，但只取第一句；超过 80 字截断带「…」；空原因、含内部名称的旧写法原样。
 */
import { describe, expect, it } from 'vitest';
import { LAUNCH_LOCATION_BLOCKER, hostWriteRefusal } from '../src/gate/host-writable.js';
import { launchBlockedText, launchLocationBlockedText } from '../src/job/launch-blocked.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { bot, callTool, nextPacket, sectionOf, theJob, threadOf, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, launchArgs } from './p74g-launch-fixtures.js';

// P81 同步（第 4 节）：固定句改为「约定里没有写明发布到你电脑上的哪个文件夹……」。
const FIXED = '会员定价页没有发布：约定里没有写明发布到你电脑上的哪个文件夹，员工写不进去。做好的成果在项目文件夹里。告诉我具体的文件夹（例如桌面上的一个文件夹），我再安排。';
const chiefReplies = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.kind === 'reply').map(row => row.text);
const blockedLines = (fix: JobFix) => chiefReplies(fix).filter(text => text.includes('没有发布') && !text.includes('没有发布成功'));

describe('3.1 发布位置写不进去：固定的话，不引用执行者的原话', () => {
  it('固定句逐字；blocker 的固定写法逐字', () => {
    expect(launchLocationBlockedText('会员定价页')).toBe(FIXED);
    expect(LAUNCH_LOCATION_BLOCKER).toBe('发布位置不在能写入的范围内');
    expect(hostWriteRefusal(['/a'])).toMatch(/交账写 blocked，blocker 逐字写：发布位置不在能写入的范围内。$/);
    expect(FIXED).not.toMatch(/中心|~\/Desktop/);
  });

  it('执行者按唤醒包里的文字交账：总管私聊落的是那句固定的话，不含「中心」「~/Desktop」', async () => {
    const { fix } = await acceptedWithLaunch();
    const packet = sectionOf(await nextPacket(fix, fix.engineer.id));
    // 只用唤醒包里的文字：取出「blocker 逐字写：……」那一句。
    const blocker = /blocker 逐字写：(.+?)。/.exec(packet)?.[1];
    expect(blocker, '唤醒包里应该写明 blocker 的逐字写法').toBe('发布位置不在能写入的范围内');
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker, summary: '约定要求复制到桌面，写不进去' });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'hub' } });
    expect(blockedLines(fix)).toEqual([FIXED]);
    // P81 同步：第 4 节的新固定句里有「例如桌面上的一个文件夹」，所以这里不再禁「桌面」二字。
    expect(blockedLines(fix)[0]).not.toMatch(/中心|~\/Desktop/);
  });

  it('预先核对拒绝之后交账：同样落那句固定的话', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix,
      { payload: { cmd: 'mkdir', args: ['-p', '/Users/someone/Desktop/p74l3-desktop'], cwd: bot(fix, fix.engineer.id).homeDir } }));
    expect(refused).toMatchObject({ ok: false });
    // 只用拒绝文字里的话：取出「blocker 逐字写：……」那一句。
    const blocker = /blocker 逐字写：(.+?)。$/.exec((refused as { error: string }).error)?.[1];
    expect(blocker).toBe('发布位置不在能写入的范围内');
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker, summary: '写不进约定的位置' });
    expect(blockedLines(fix)).toEqual([FIXED]);
  });

  it('旧写法的 blocker（含「中心」「~/Desktop」，不含固定句）仍不会原样露出内部说法的那部分：只引用第一句', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '约定要求复制到桌面。中心代为运行的命令写不进 ~/Desktop。', summary: '写不进去' });
    const line = blockedLines(fix)[0]!;
    expect(line).toBe('会员定价页的发布这一步没有做成：林舟说缺少条件（约定要求复制到桌面）。没有发布。要发布时告诉我发布到哪里、用什么方式，我再安排。');
    expect(line).not.toMatch(/中心|~\/Desktop/);
  });
});

describe('3.2 其他原因：引用执行者的话，只取第一句，再按 80 字截断', () => {
  const textOf = (reason: string | null) => launchBlockedText({ title: '会员定价页', executor: '林舟', reason });
  const wrap = (quote: string) => `会员定价页的发布这一步没有做成：林舟说缺少条件（${quote}）。没有发布。要发布时告诉我发布到哪里、用什么方式，我再安排。`;

  it('两句话的原因只引用第一句（「。」「；」「！」「？」和换行都算句子的结尾，标点本身不引用）', () => {
    expect(textOf('缺少发布账号。请主人提供。')).toBe(wrap('缺少发布账号'));
    expect(textOf('缺少发布账号；请主人提供')).toBe(wrap('缺少发布账号'));
    expect(textOf('缺少发布账号！请主人提供')).toBe(wrap('缺少发布账号'));
    expect(textOf('缺少发布账号？请主人提供')).toBe(wrap('缺少发布账号'));
    expect(textOf('缺少发布账号\n请主人提供')).toBe(wrap('缺少发布账号'));
    expect(textOf('只有一句没有句号')).toBe(wrap('只有一句没有句号'));
  });

  it('第一句超过 80 字：截到 80 字，末尾加「…」；正好 80 字不加', () => {
    const long = '账'.repeat(100);
    expect(textOf(`${long}。后面还有一句`)).toBe(wrap(`${'账'.repeat(80)}…`));
    expect(textOf('账'.repeat(80))).toBe(wrap('账'.repeat(80)));
  });

  it('空原因、含内部名称：不写原因（旧写法原样）', () => {
    const none = '会员定价页的发布这一步没有做成：林舟说缺少条件。没有发布。要发布时告诉我发布到哪里、用什么方式，我再安排。';
    expect(textOf(null)).toBe(none);
    expect(textOf('   ')).toBe(none);
    expect(textOf('hub_job_work 调用失败，jobId 不对')).toBe(none);
    // 内部名称在第二句里：仍按整段原因检查，不写原因。
    expect(textOf('缺少账号。请检查 hub_job_work')).toBe(none);
  });

  it('端到端：执行者交账 blocked 写两句话，总管私聊只引用第一句', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺少发布网站的登录账号。需要主人提供之后才能继续。', summary: '缺账号' });
    expect(blockedLines(fix)).toEqual([wrap('缺少发布网站的登录账号')]);
  });
});
