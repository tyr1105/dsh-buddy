/**
 * P74r6 第 4 节各条小改的测试：说明卡失效原因（暂停、改派）、launched 的三种拒绝、预览副本的文件类型和扫描上限、
 * 预览路径的特殊字符、试用反馈只算接手之后的指出、内部名称检查、组队问答的消息编号、第 12 条（路径写法）。
 * 需要真实文件系统的（预览副本）用 p74g-fixtures 在系统临时目录里搭环境，每条用例结束后删除。
 */
import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { escalationCardView } from '../src/api/job-escalation-views.js';
import { checkTopicFile, previewError } from '../src/job/evidence.js';
import { internalNameIn, ownerTextProblem } from '../src/job/owner-text.js';
import { PREVIEW_COPY_LIMITS, previewRootDir, previewTooBigText } from '../src/job/preview-copy.js';
import { jobPreviewTarget } from '../src/job/preview.js';
import { holdForOwner } from '../src/job/unblock.js';
import { reportTrialFeedback } from '../src/job/trial.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { threadOf } from './p74b-fixtures.js';
import { delivered, sectionOf } from './p74f-fixtures.js';
import { acceptedWithLaunch, submitLaunch } from './p74g-launch-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';
import { registerCleanup, setup } from './p74g-fixtures.js';
import { answerAll as _unused, okData, pick, teamHub, theSetup, thread } from './p73c-fixtures.js';
import { MINUTE, bot, callTool, escalateFromPacket, lastPacket, ownerSays, started, theJob, tick } from './p74f2-fixtures.js';

void _unused;
registerCleanup();

const PLAIN = [{ title: '先放一放', detail: '等文档到了再做；代价是交付时间会晚' }, { title: '换一位执行者再试', detail: '换人重做；代价是多花一轮时间' }];

/** 林舟做不下去，总管说明了办法（主人还没选）。 */
async function escalatedExecutor() {
  const { fix, job } = await started(['小周']);
  fix.ctx.store.table('jobs').patch(job.id, { turnCap: 60 });
  expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺文档', summary: '做不下去' });
  expect((await escalateFromPacket(fix, PLAIN)).result).toMatchObject({ ok: true });
  return { fix, job };
}

describe('1 说明卡失效原因再分清：暂停、改派', () => {
  it('主人暂停这件事：没选的说明标 held，卡片「已失效：你已暂停这件事」，选办法被拒的文字固定', async () => {
    const { fix, job } = await escalatedExecutor();
    fix.ctx.store.table('jobs').put(holdForOwner(theJob(fix), fix.ctx.clock.now()));
    expect(theJob(fix).escalation).toMatchObject({ invalid: 'held' });
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ stateText: '已失效：你已暂停这件事', selectable: false });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toEqual({ ok: false, error: '这件事已暂停，这张卡上的办法不用再选。' });
  });

  it('总管改派（改派之后仍有人停用也一样）：标 reassigned，「已失效：总管已改派」，被拒文字固定', async () => {
    const { fix, job } = await escalatedExecutor();
    await tick(fix, 1_000);
    await ownerSays(fix, fix.chief.id, '换小周');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    expect(theJob(fix).escalation).toMatchObject({ invalid: 'reassigned' });
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ stateText: '已失效：总管已改派', selectable: false });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toEqual({ ok: false, error: '总管已经改派，这张卡上的办法不用再选。' });
  });

  it('约定在等确认期间（已标 reconfirming）这件事离开了那一次受阻：改标为离开的原因，不再显示「约定在重新确认」', async () => {
    const { fix, job } = await escalatedExecutor();
    const now = theJob(fix);
    fix.ctx.store.table('jobs').put({ ...now, escalation: { ...now.escalation!, invalid: 'reconfirming' } });
    fix.ctx.store.table('jobs').put(holdForOwner(theJob(fix), fix.ctx.clock.now()));
    expect(theJob(fix).escalation).toMatchObject({ invalid: 'held' });
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ stateText: '已失效：你已暂停这件事' });
  });
});

describe('2 launched 只在发布命令已运行并且成功之后接受（N13）', () => {
  const launched = (fix: Awaited<ReturnType<typeof acceptedWithLaunch>>['fix'], jobId: string) =>
    callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId, link: 'https://example.com/x' });

  it('还没有批准：「发布审批还没有批准，不能回报已发布。」', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await submitLaunch(fix);
    expect(await launched(fix, job.id)).toEqual({ ok: false, error: '发布审批还没有批准，不能回报已发布。' });
  });

  it('已批准、命令还没有运行：「发布命令还没有运行，等它运行完再回报。」', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true }); // P74r18b 同步：只记下批准的决定（界面入口会立刻开始执行）
    // 不推进时间：中心还没有运行命令（审批是已批准、批准票没有被使用）。
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('approved');
    expect(await launched(fix, job.id)).toEqual({ ok: false, error: '发布命令还没有运行，等它运行完再回报。' });
  });

  it('命令运行失败：「发布命令运行失败，不能回报已发布。可以重新提交发布审批。」', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    // P74r18b 同步：命令运行失败之后中心马上把发布状态记为「发布没有成功」（failed）；本条要测的是 launched 里
    // 「发布状态仍是等批准、批准票已使用、出站记录是失败」这一支（中心没来得及记下结果时的保护），所以不真的运行命令，直接构造这个状态。
    // 发布状态是 failed 时同样给这句话，见本卡新增的 p74r18b-launch-result.test.ts。
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true });
    fix.ctx.store.table('approvals').patch(approval.id, { status: 'used', usedAt: fix.ctx.clock.now() });
    const outboxRow = fix.ctx.store.table('outbox').list(row => row.approvalId === approval.id)[0]!;
    fix.ctx.store.table('outbox').patch(outboxRow.id, { status: 'failed', result: '命令退出码 1：出错了', ownerFailureReason: '命令退出码 1', executionStarted: true, doneAt: fix.ctx.clock.now() });
    expect(await launched(fix, job.id)).toEqual({ ok: false, error: '发布命令运行失败，不能回报已发布。可以重新提交发布审批。' });
    expect(theJob(fix).launch.state).toBe('approval');
  });
});

describe('3 预览副本只复制网页用得到的文件类型；4 扫描时所有列出的项都计数', () => {
  it('终端配置、快捷方式、应用目录里的文件、没有扩展名的文件都没有；名单里的类型都在（不分大小写）', async () => {
    const s = setup();
    s.write('交付/index.html', '<html></html>');
    for (const bad of ['a.terminal', 'b.command', 'c.fileloc', '没有扩展名']) s.write(`交付/${bad}`, 'x');
    nodeFs.mkdirSync(join(s.jobDir, '交付/d.app/Contents/MacOS'), { recursive: true });
    s.write('交付/d.app/Contents/MacOS/run', '#!/bin/sh');
    s.write('交付/d.app/Info.plist', '<plist/>');
    const good = ['a.CSS', 'b.js', 'c.json', 'd.svg', 'e.woff2', 'f.pdf', 'g.wasm', 'h.mjs', 'i.txt'];
    for (const name of good) s.write(`交付/${name}`, 'x');
    s.submit({ preview: '交付/index.html' });
    const result = await jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const dir = (result as { data: { path: string } }).data.path.replace(/\/index\.html$/, '');
    const names = nodeFs.readdirSync(dir).sort();
    expect(names).toEqual(['index.html', ...good].sort());
    expect(nodeFs.existsSync(join(dir, 'd.app'))).toBe(false);
  });

  // P74r11：要证明的是「列出的项超过上限就按固定办法处理、差一个不到上限就照常」，与上限具体是多少无关：
  // 函数接受调用方传入的上限，测试传 20，不在磁盘上建一万多个空目录（原来这一条约 20 秒）。
  const SMALL_LISTED = { ...PREVIEW_COPY_LIMITS, MAX_LISTED: 20 };

  it('列出的项（空目录）超过上限：按「预览内容太大」处理，不留副本（上限传 20）', async () => {
    const s = setup();
    s.write('交付/index.html', '<html></html>');
    // 加上 index.html 共列出 21 项，超过 20。
    for (let i = 0; i < SMALL_LISTED.MAX_LISTED; i += 1) nodeFs.mkdirSync(join(s.jobDir, `交付/空${i}`));
    s.submit({ preview: '交付/index.html' });
    const result = await jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' }, SMALL_LISTED);
    expect(result).toEqual({ ok: false, error: previewTooBigText(join(s.jobDir, '交付')) });
    expect(nodeFs.existsSync(join(previewRootDir(s.root), 'job_0000000001'))).toBe(false);
  });

  it('列出的项恰好等于上限：照常打开（上限传 20，差一个不到上限）', async () => {
    const s = setup();
    s.write('交付/index.html', '<html></html>');
    for (let i = 0; i < SMALL_LISTED.MAX_LISTED - 1; i += 1) nodeFs.mkdirSync(join(s.jobDir, `交付/空${i}`));
    s.submit({ preview: '交付/index.html' });
    const result = await jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' }, SMALL_LISTED);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('默认上限没有变：列出的项 10000（不建文件）', () => {
    expect(PREVIEW_COPY_LIMITS.MAX_LISTED).toBe(10000);
  });
});

describe('5 预览文件路径里不许出现命令行特殊字符（N8）；12 路径写法', () => {
  it("a'b;$(id).html 交回被拒并写明不能含哪些字符；报名 页-1.html 通过", async () => {
    const s = setup();
    s.write("交付/a'b;$(id).html", '<html></html>');
    s.write('交付/报名 页-1.html', '<html></html>');
    const refused = await previewError(s.ctx, s.job, "交付/a'b;$(id).html");
    expect(refused).toContain('预览文件的路径里不能含这些字符');
    expect(refused).toContain('$ ` ; | & ( ) < > \' " \\ * !');
    expect(await previewError(s.ctx, s.job, '交付/报名 页-1.html')).toBeNull();
    // 打开时用同一个判断：交回之后文件名没变，打开同样被拒。
    s.submit({ preview: "交付/a'b;$(id).html" });
    expect((await jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' })).ok).toBe(false);
  });

  it('带这件事文件夹前缀的路径（path、deliverables 用的 checkTopicFile，和 preview）：报错说清「从这件事的文件夹算起，去掉前面的 jobs/{编号}/」；别的错误文字不变', async () => {
    const s = setup();
    s.write('交付/index.html', '<html></html>');
    const hint = '路径从这件事的文件夹算起，去掉前面的 jobs/job_0000000001/';
    const prefixed = 'jobs/job_0000000001/交付/index.html';
    expect((await checkTopicFile(s.ctx, s.job, prefixed)).detail).toContain(hint);
    expect(await previewError(s.ctx, s.job, prefixed)).toContain(hint);
    // 别的错误：找不到、越界，文字不动。
    expect((await checkTopicFile(s.ctx, s.job, '交付/没有.html')).detail).toBe('找不到 交付/没有.html');
    expect((await checkTopicFile(s.ctx, s.job, '../x.html')).detail).toBe('../x.html 不在主题文件夹里');
    expect((await checkTopicFile(s.ctx, s.job, '交付/index.html')).status).toBe('ok');
  });
});

describe('7 试用反馈：「你验收时指出了 N 条不符」只算这位执行者接手之后的（N11）', () => {
  it('接手之前主人指出过 1 条、接手之后没有：这句话里是 0；接手之后又指出 1 条：是 1', async () => {
    for (const later of [false, true]) {
      const { fix, job } = await delivered();
      const sub = fix.ctx.store.table('jobSubmissions').list(row => row.jobId === job.id).sort((a, b) => a.createdAt - b.createdAt)[0]!;
      const at = later ? sub.createdAt + 1000 : sub.createdAt - 1000;
      fix.ctx.store.table('jobs').put({ ...theJob(fix), ownerReturns: [{ stage: 1, items: [{ no: 1, text: '打开页面能看到今天的报价', problem: '没有', fixTo: '有' }], missed: '漏了', messageId: null, at }] });
      reportTrialFeedback(fix.ctx, job.id);
      const said = threadOf(fix.ctx, fix.chief.id).map(row => row.text).find(text => text.includes('的第一件事做完了：交回'))!;
      expect(said).toContain(later ? '你验收时指出了 1 条不符' : '你验收时没有指出不符');
    }
  });
});

describe('8 内部名称检查：认出绕过写法，减少误判', () => {
  const caught = [
    'hub͏_send', 'hub️_send', 'hub\u{E0041}_send', 'hubㅤ_send', 'hubﾠ_send', 'h​ub_send',
    '参考_job_0000000001', '编号1job_0000000001', '见agr_0000000001', '用 mode reassign 换人', 'mode: escalate', 'jobId', 'stopsJob',
  ];
  it.each(caught)('认出：%s', text => { expect(ownerTextProblem('f', text)).not.toBeNull(); });

  const fine = ['页面支持 dark mode and light mode 两种', 'Reopen 按钮能用', '支持 followup 邮件', 'ap_testing 环境', '支持 mode 切换', 'web_applications 列表'];
  it.each(fine)('不误判：%s', text => { expect(ownerTextProblem('f', text)).toBeNull(); expect(internalNameIn(text)).toBeNull(); });

  it('同一句里有 mode 或参数名时，reopen、followUp 这类单词才算', () => {
    expect(internalNameIn('先用 mode 写 reopen')).not.toBeNull();
    expect(internalNameIn('followUp 写 true')).toBeNull();
    expect(internalNameIn('followUp 写 true，jobId 写好')).not.toBeNull();
  });
});

describe('9 组队问答里中心代主人落的那条消息带上记录编号', () => {
  it('点选之后主人名义的消息 refId 是三问记录的编号（不是 null，不会被当作主人亲口的话）；不叫醒总管', async () => {
    const fix = await teamHub();
    okData(await pick(fix, 1, 'software'));
    const owner = thread(fix.ctx, fix.chief!.id).filter(row => row.from === 'owner');
    expect(owner).toHaveLength(1);
    expect(owner[0]!.refId).toBe(theSetup(fix.ctx).id);
    // 这条消息只是落线程，没有排任何唤醒。
    expect(fix.ctx.store.table('queue').count()).toBe(0);
  });
});

describe('12 执行者唤醒包里放文件和交回的路径写法例子', () => {
  it('唤醒包里有那句例子（逐字，文件夹用包里已经在用的写法）', async () => {
    const { fix, job } = await started();
    const packet = sectionOf(lastPacket(fix, bot(fix, fix.engineer.id)));
    expect(packet).toContain(`例：放文件时 to 写 ${job.folder}/交付/index.html；交回时 deliverables、preview 和证据的 path 都从这件事的文件夹算起，写 交付/index.html。`);
  });
});
