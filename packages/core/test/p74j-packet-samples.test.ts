/**
 * P74j 的样例来源与看守测试：让真实的中心生成假模型剧本要读的九种「你手上的事」段。
 *
 * 为什么有这个文件：假模型的执行者、评审员、发布剧本（scripts/dev/fake-job-plan.mjs）靠识别唤醒包里的固定句子
 * 取值。这些句子由 core 的渲染函数生成（wake/job-section.ts、job-section-launch.ts）。
 * 插件测试（packages/plugin/test/p74j-fake-job.test.ts）不能起一个真实的中心，所以把这里打印出的原文
 * 作为样例常量粘过去。本文件同时起看守作用：以后 core 改了这些句子，这里的断言会先失败，
 * 提醒同步修改假模型剧本和插件测试里的样例。
 *
 * 九种：
 *   1 执行者第一轮；2 执行者返工（两条要改）；3 约定新版本在等确认；4 总管回答之后；
 *   5 核对人第一轮；6 核对人第二轮（有沿用的条目）；7 主人选办法之后的重新核对；
 *   8 发布准备中；9 发布已批准。
 * 全部走真实 Hub，时间用注入的假时钟，每次推进不超过 10 分钟。每种用 console.log 打印原文。
 */
import { describe, expect, it } from 'vitest';
import { AgreementSchema } from '../src/model/agreement.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { enqueueJobWake } from '../src/job/chain.js';
import { appendJobEvent } from '../src/job/store.js';
import { commitAndEnd } from './p74c-fixtures.js';
import {
  bot, callTool, engineerSubmits, metWithImage, nextPacket, reviewerInfo, sectionOf, started, theJob, type JobFix,
} from './p74d-fixtures.js';
import { escalateFromPacket, escalateItem, limitFix } from './p74f2-fixtures.js';
import { acceptedWithLaunch, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';
import { buildJobBodyDetailed } from '../src/wake/job-section.js';
import type { QueueEntry } from '../src/model/index.js';

/** 打印一种样例（带标题行），方便从测试输出里整段复制。 */
function show(title: string, text: string): void {
  console.log(`\n@@@ 样例 ${title} @@@\n${text}\n@@@ 结束 @@@`);
}

/** 林舟交回第 1 轮并结束回合，评审甲拿到核对的回合；返回评审甲这一回合的完整唤醒包。 */
async function reviewerRound1(fix: JobFix, info: Parameters<typeof engineerSubmits>[1]): Promise<string> {
  await engineerSubmits(fix, info);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  return nextPacket(fix, fix.reviewer.id);
}

describe('P74j 九种「你手上的事」段的样例与看守', () => {
  it('1 执行者第一轮：有交付时核对的条目、怎样算做完、材料行、放文件的说明', async () => {
    const { fix, info } = await started();
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    show('1 执行者第一轮', text);
    expect(text).toContain('」的执行者（jobId 为 job_');
    expect(text).toContain('材料（只读）：约定 ');
    expect(text).not.toContain('材料文件夹');
    expect(text).toMatch(/用 hub_project_put 放进项目文件夹（参数 project 填 prj_[0-9a-z]{10}，to 写 jobs\/job_[0-9a-z]{10}\/交付\/文件名）/);
    expect(text).toContain('怎样算做完（交回时逐条对应，no 写序号）：');
    expect(text).toContain('（交付时核对：selfCheck 写 at_delivery，不附证据）');
    expect(text).not.toContain('这一轮要改的条目');
    expect(info.items.length).toBeGreaterThanOrEqual(3);
  });

  it('2 执行者返工 与 6 核对人第二轮：返工写出两条要改的条目；第二轮核对里没改的条目显示沿用', async () => {
    const { fix, info } = await started();
    const first = await reviewerRound1(fix, info);
    const seen = reviewerInfo(first);
    // 第 2、3 条都判不符：返工的执行者要改两条。
    const failed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [
      { no: 1, verdict: 'at_delivery' },
      { no: 2, verdict: 'unmet', note: '手机号提示文字与约定不一致', fixTo: '输入 10 位手机号时，提示文字与约定逐字一致，附一张截图' },
      { no: 3, verdict: 'unmet', note: '没有看到名额已满的提示', fixTo: '提交满 80 人后页面显示名额已满，附一张截图' }] });
    expect(failed, JSON.stringify(failed)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '退回' });
    const rework = sectionOf(await nextPacket(fix, fix.engineer.id));
    show('2 执行者返工（两条要改）', rework);
    expect(rework).toContain('现在：返工中，本阶段第 1 轮，共 3 轮。');
    expect(rework).toMatch(/这一轮要改的条目：第 2 条：问题：.+；改到什么程度算过：.+。第 3 条：问题：.+；改到什么程度算过：.+。其余条目不用再交，沿用上一轮结论。/);
    // 返工交回第 2、3 条，核对人第二轮拿到的交回里第 1 条沿用。
    const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: seen.jobId, changeNote: '按核对意见改了第 2、3 条', deliverables: ['交付/报价页.html'],
      items: [metWithImage(2), metWithImage(3, '证据/桌面.png')] });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已重新交回' });
    const second = sectionOf(await nextPacket(fix, fix.reviewer.id));
    show('6 核对人第二轮（有沿用的条目）', second);
    expect(second).toMatch(/这是第 1 阶段第 2 轮核对，本阶段最多 3 轮。/);
    expect(second).toMatch(/\n1\. .+\n自查：沿用第 1 轮结论：/);
    expect(second).toContain('的交回（按核对意见改了第 2、3 条）：');
  });

  it('3 执行者在约定新版本等确认期间：有「暂停」的那一行', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    // 先让约定真有一个待确认的第 2 版，再写暂停（巡检会清掉指向不存在版本的暂停）。
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const v1 = agreement.versions[0]!;
    fix.ctx.store.table('agreements').put(AgreementSchema.parse({ ...agreement, state: 'pending',
      versions: [v1, { ...v1, no: 2, state: 'pending', lockedAt: null, lockedVia: null, adoption: null }] }));
    fix.ctx.store.table('jobs').patch(job.id, { pause: { versionNo: 2, continuing: ['页面骨架'], paused: ['名额计数', '名额已满'], fallback: null } });
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    show('3 执行者在约定新版本等确认期间', text);
    expect(text).toMatch(/约定第 2 版在等主人确认：暂停名额计数、名额已满；照常在做页面骨架。暂停的部分在主人确认前不要交回。/);
    expect(text).toContain('交账的结果写 no_change，说明在等约定确认');
  });

  it('4 执行者收到总管回答之后：有「总管刚回答你：」', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先问一下' });
    const answer = appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'answered', to: [fix.engineer.id], refId: null,
      data: { text: '同一手机号第二次提交时，提示这个手机号已经报过名', basis: [{ section: 'doneWhen', no: 2 }] } });
    expect(enqueueJobWake(fix.ctx, { job: theJob(fix), botId: fix.engineer.id, why: 'answered', eventId: answer.id, summary: '总管回答了' })).not.toBeNull();
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    show('4 执行者收到总管回答之后', text);
    expect(text).toContain('总管刚回答你：同一手机号第二次提交时，提示这个手机号已经报过名');
    expect(text).toContain('怎样算做完（交回时逐条对应，no 写序号）：');
  });

  it('5 核对人第一轮：交回的条目、自查、证据、产出物与预览', async () => {
    const { fix, info } = await started();
    const text = sectionOf(await reviewerRound1(fix, info));
    show('5 核对人第一轮', text);
    expect(text).toContain('」的核对人（jobId 为 job_');
    expect(text).toMatch(/这是第 1 阶段第 1 轮核对，本阶段最多 3 轮。/);
    expect(text).toMatch(/的交回（.+）：\n1\. .+\n自查：交付时核对\n2\. .+\n自查：自查符合/);
    expect(text).toMatch(/\n证据 \S+：图片 \S+ /);
    expect(text).toMatch(/\n产出物：.+；预览：/);
    expect(text).toContain('提交结论：调用 hub_job_work，mode 写 review，jobId 写 job_');
    expect(text).not.toContain('主人选了办法之后的重新核对');
  });

  it('7 核对人在主人选办法之后的重新核对：只需要给记下的那几条结论', async () => {
    const { fix } = await limitFix();
    const A = { title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } };
    const B = { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' };
    await escalateFromPacket(fix, [A, B]);
    const item = escalateItem(fix, theJob(fix).id)!;
    expect(await fix.hub.api.answerInbox(item.id, 'A　放宽这一条')).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const text = sectionOf(await nextPacket(fix, fix.reviewer.id));
    show('7 核对人在主人选办法之后的重新核对', text);
    expect(text).toContain('这一轮是主人选了办法之后的重新核对：只需要给第 3 条写结论，其余条目前面已经通过，不用再写。');
  });

  it('8 发布准备中：整段换成发布的写法，带产出物和提交、回报两句', async () => {
    const { fix } = await acceptedWithLaunch();
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    show('8 发布准备中', text);
    expect(text).toMatch(/」（jobId 为 job_[0-9a-z]{10}）主人已验收。下一步是对外发布，必须先经主人批准。/);
    expect(text).toMatch(/\n产出物：\/.+\/jobs\/job_[0-9a-z]{10}\/交付\/报价页\.html。\n/);
    expect(text).toContain('提交发布：用 hub_outbox_submit');
    // P74r18b 同步：发布命令由中心运行，这一行不再让员工自己执行、回报地址。
    expect(text).toContain('批准后：由中心运行这条命令，你不用再做任何事；结果出来中心会叫醒你。主人拒绝时也不用做任何事。');
    expect(text).not.toContain('怎样算做完');
  });

  it('9 发布已批准：「的发布申请主人已批准。」与 launched 的说明', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    // P74r18b 同步（4.4）：批准之后由中心运行，员工不自己执行；这一段按真实状态写「已批准、中心正在运行」。
    // 样例要看的是「已批准、命令还没运行完」的这一段：只记下批准的决定（界面入口会立刻运行命令，巡检也会运行，
    // 所以不再靠叫醒、等回合拿唤醒包），直接用这一回合的唤醒单生成这一段正文。
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true });
    const ticket = fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id).at(-1)!;
    const text = (await buildJobBodyDetailed(fix.ctx, bot(fix, fix.engineer.id), { jobId: theJob(fix).id } as QueueEntry, ticket)).text;
    show('9 发布已批准', text);
    expect(text).toMatch(/」（jobId 为 job_[0-9a-z]{10}）\n发布申请主人已批准，中心正在运行发布命令。这一回合不用做任何事，直接交账；结果出来中心会叫醒你。/);
    expect(text).not.toContain('执行发布，然后调用 hub_job_work');
    expect(text).not.toContain('在等主人批准');
    // 剧本第一步提交的参数形状也在这里守一道：与 launchArgs 一样是 run_command，payload 为 cmd、args、cwd。
    expect(launchArgs(fix)).toMatchObject({ kind: 'run_command', payload: { cmd: expect.any(String), args: expect.any(Array), cwd: expect.stringMatching(/^\//) } });
  });
});
