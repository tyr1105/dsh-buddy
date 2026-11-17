/**
 * P74g 的测试：发布这一步（验收之后准备发布、提交审批、批准后回报、拒绝或过期）。
 *
 * 走真实 Hub、真实工具、假时钟（每次推进不超过 10 分钟）。第一条是整条链：执行者林舟只靠唤醒包里的文字取到 jobId，
 * 调用 hub_outbox_submit 提交发布命令，主人批准后又只靠唤醒包里的文字调用 launched。
 * 断言要证明的机制不依赖额度灯。
 */
import { describe, expect, it } from 'vitest';
import type { QueueEntry } from '../src/model/index.js';
import { buildJobBodyDetailed } from '../src/wake/job-section.js';
import { LAUNCH_DECLINED_TEXT, LAUNCH_EXPIRED_TEXT } from '../src/job/launch-approval.js';
import { commitAndEnd, entriesOf, eventsOf, wakesOf } from './p74c-fixtures.js';
import { delivered, nextPacket, bot, callTool, sectionOf, theJob, threadOf, tick, INTERNAL, MINUTE, type JobFix } from './p74f-fixtures.js';
import { firstSubmitArgs, started } from './p74d-fixtures.js';
import { acceptedWithLaunch, jobIdIn, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';
import { executeReadyOutbox } from '../src/gate/outbox.js';

describe('1 只用唤醒包里的文字：验收、准备发布、提交审批、批准、回报地址', () => {
  it('整条链：林舟被叫醒，提交发布命令，审批卡落总管私聊并带三行；批准后林舟被叫醒（带 jobId），launched 成功，总管私聊和主题各一句', async () => {
    const { fix, job } = await acceptedWithLaunch();
    expect(job).toMatchObject({ state: 'done', launch: { state: 'preparing', approvalId: null, link: null } });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_requested')).toHaveLength(1);
    // 林舟拿到发布准备的回合：唤醒包的这一段逐字照任务卡，只含他需要的内容。
    const wakesBefore = wakesOf(fix, fix.engineer.id).length;
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(wakesOf(fix, fix.engineer.id)).toHaveLength(wakesBefore + 1);
    expect(wakesOf(fix, fix.engineer.id).at(-1)).toMatchObject({ jobId: job.id });
    const jobId = jobIdIn(packet);
    const section = sectionOf(packet);
    expect(section).toContain(`「会员定价页」（jobId 为 ${jobId}）主人已验收。下一步是对外发布，必须先经主人批准。`);
    expect(section).toMatch(/\n产出物：\/.+\/jobs\/job_[0-9a-z]{10}\/交付\/报价页\.html。\n/);
    expect(section).toContain('提交发布：用 hub_outbox_submit 提交发布要运行的命令（kind 写 run_command），why 写为什么发布、发布到哪里，并填 cost（会不会产生费用、多少）、undo（发布后能不能撤回、怎样撤回）、after（批准之后多久上线、上线后会发生什么）。批准前不要发布。');
    // P74r18b 同步：发布命令由中心运行，这一行不再让员工自己执行、回报地址。
    expect(section).toContain('批准后：由中心运行这条命令，你不用再做任何事；结果出来中心会叫醒你。主人拒绝时也不用做任何事。');
    // 整段换成发布的写法：不再有交回、怎样算做完。
    expect(section).not.toContain('怎样算做完');
    expect(section).not.toContain('mode 写 submit');

    // 提交发布命令（带 why、cost、undo、after）。
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix));
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: expect.stringContaining('等待主人批准') });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    expect(approval).toMatchObject({ status: 'pending', botId: fix.engineer.id });
    // 这件事的发布状态：等批准；事件；旁表。
    expect(theJob(fix).launch).toEqual({ state: 'approval', approvalId: approval.id, link: null });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_requested').map(row => row.data)).toEqual([{ step: 'prepare' }, { approvalId: approval.id }]);
    expect(fix.ctx.store.table('approvalNotes').get(approval.id)).toMatchObject({ jobId: job.id, cost: '不产生费用', undo: '可以在后台下线，下线后链接失效', after: '约 5 分钟后上线，上线后任何人拿到链接都能报名' });
    // 审批卡落在总管私聊，前面是总管名义的那一句；员工私聊里没有这张卡。
    const chiefThread = threadOf(fix.ctx, fix.chief.id);
    const cardIndex = chiefThread.findIndex(row => row.kind === 'approval');
    expect(cardIndex).toBeGreaterThan(0);
    expect(chiefThread[cardIndex - 1]).toMatchObject({ from: fix.chief.id, kind: 'reply', text: '会员定价页已验收，下一步是对外发布，需要你批准；批准前不会发布。' });
    expect(threadOf(fix.ctx, fix.engineer.id).some(row => row.kind === 'approval')).toBe(false);
    // 「待你处理」里这一条归在总管名下；卡片带三行和「由林舟执行」。
    const item = fix.hub.api.inbox().items.find(row => row.approvalId === approval.id)!;
    expect(item).toMatchObject({ botId: fix.chief.id, botName: '老大',
      approval: { notes: { cost: '不产生费用', undo: '可以在后台下线，下线后链接失效', after: '约 5 分钟后上线，上线后任何人拿到链接都能报名' }, onBehalfOf: '由林舟执行' } });
    expect(item.approval!.argsPreview).toContain('go-live.js');
    const card = fix.hub.api.thread(fix.chief.id).messages.find(row => row.kind === 'approval')!;
    expect(card).toMatchObject({ fromName: '老大', card: { approvalId: approval.id, approval: { onBehalfOf: '由林舟执行' } } });
    // 回执的「打扰你」：这张审批按 refId 关联，计入。
    expect(fix.ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === approval.id)).toHaveLength(1);

    // 林舟结束这一回合；主人批准；林舟被叫醒，这一回合带着这件事。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已提交发布审批，等主人批准' });
    // P74r6（N13）：launched 只在发布命令已经运行并且成功之后接受：批准后让中心运行命令（假的执行接口返回成功）。
    fix.ctx.exec.set('node', ['work/go-live.js'], { code: 0, stdout: '已上线', stderr: '', timedOut: false });
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    // P74r18b 同步（第 1、2 节）：批准的那一刻不再叫醒林舟；命令由中心立刻运行（这里等批准之后开始的那次执行做完），
    // 运行完发布状态记为已发布、总管私聊和主题各落一句，再带着结果叫醒林舟一次：有网址就用 launched 补记。
    await executeReadyOutbox(fix.ctx);
    expect(theJob(fix).launch).toEqual({ state: 'done', approvalId: approval.id, link: null });
    const again = await nextPacket(fix, fix.engineer.id);
    expect(wakesOf(fix, fix.engineer.id).at(-1)).toMatchObject({ jobId: job.id });
    const section2 = sectionOf(again);
    expect(section2).toContain('发布命令已成功运行，这件事已记为已发布。');
    expect(section2).toContain(`调用 hub_job_work，mode 写 launched，jobId 写 ${jobIdIn(again)}，link 写网址（http:// 或 https:// 开头）；没有网址就直接交账收尾。`);

    // 只靠这一段里的 jobId 调用 launched，成功（只补记网址，不再落「已发布」的话）。
    const done = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: jobIdIn(again), link: 'https://example.com/signup' });
    expect(done, JSON.stringify(done)).toEqual({ ok: true, text: '已记下发布地址。' });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'done', approvalId: approval.id, link: 'https://example.com/signup' } });
    // 事件：命令成功时记一条（没有网址），补记网址时记一条。
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launched')).toHaveLength(2);
    // 总管私聊和主题各以总管名义落一句（命令成功时落的，补记网址时没有再落）。
    const said = (thread: string) => threadOf(fix.ctx, thread).filter(row => row.from === fix.chief.id && row.kind === 'reply' && row.text === '「会员定价页」已发布：发布到 /tmp/p74k-site（复制到本机目录）。');
    expect(said(fix.chief.id)).toHaveLength(1);
    expect(said(job.topicId)).toHaveLength(1);
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.text.includes('https://example.com/signup'))).toBe(false);
    // 给主人看的话里没有内部名称（审批卡正文里「原始参数」一段是原有的做法，界面默认收起，不在这里检查）。
    const visible = [...threadOf(fix.ctx, fix.chief.id), ...threadOf(fix.ctx, job.topicId)].filter(row => row.from !== fix.engineer.id && row.kind !== 'work' && row.kind !== 'approval');
    expect(visible.filter(row => INTERNAL.test(row.text)).map(row => row.text)).toEqual([]);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'done', summary: '已发布' });
  });
});

describe('2 拒绝与过期：暂不发布，这件事仍是已完成，林舟不被叫醒', () => {
  it('拒绝：launch 为 declined，总管私聊那句话，事件；林舟没有新回合', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    const wakes = wakesOf(fix, fix.engineer.id).length;
    expect(await fix.hub.api.decideApproval(approval.id, false)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', approvalId: approval.id, link: null } });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_declined')).toMatchObject([{ data: { approvalId: approval.id, status: 'rejected' } }]);
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text === LAUNCH_DECLINED_TEXT)).toHaveLength(1);
    expect(LAUNCH_DECLINED_TEXT).toBe('好的，暂不发布。需要时告诉我。');
    for (let i = 0; i < 3; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id)).toHaveLength(wakes);
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    // 拒绝之后再报「已发布」被拒。
    const late = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: job.id, link: 'https://example.com/x' });
    expect(late).toEqual({ ok: false, error: '这件事现在不在等发布结果' });
  });

  it('过期：launch 为 declined，总管私聊落「发布审批已过期，没有发布。需要时告诉我。」，事件记过期', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    // 不靠推进几十个小时的假时钟：把这张审批的截止时间改成一分钟之后，再推进一分钟让中心巡检过期。
    fix.ctx.store.table('approvals').patch(approval.id, { expiresAt: fix.ctx.clock.now() + MINUTE });
    await tick(fix, 2 * MINUTE);
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('expired');
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined' } });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_declined')).toMatchObject([{ actor: 'hub', data: { status: 'expired' } }]);
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text === LAUNCH_EXPIRED_TEXT)).toHaveLength(1);
    expect(LAUNCH_EXPIRED_TEXT).toBe('发布审批已过期，没有发布。需要时告诉我。');
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.text === LAUNCH_DECLINED_TEXT)).toBe(false);
  });

  it('批准之后、回报之前审批过期：同样按「暂不发布」处理，之后回报被拒', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true }); // P74r18b 同步：只记下批准的决定（界面入口会立刻开始执行）
    fix.ctx.store.table('approvals').patch(approval.id, { expiresAt: fix.ctx.clock.now() + MINUTE, status: 'approved' });
    await tick(fix, 2 * MINUTE);
    expect(theJob(fix).launch.state).toBe('declined');
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: job.id, link: 'https://example.com/x' }))
      .toEqual({ ok: false, error: '这件事现在不在等发布结果' });
  });
});

describe('3 没有发布步骤的事', () => {
  it('验收之后林舟不被叫醒：没有新唤醒、队列里没有他的候选、launch 为 none、没有 launch_requested 事件', async () => {
    const { fix, job } = await delivered();
    const wakes = wakesOf(fix, fix.engineer.id).length;
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id)).toHaveLength(wakes);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'none' } });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_requested')).toHaveLength(0);
  });
});

describe('4 交回时的预览地址与打开时用同一个判断', () => {
  it('http://localhost.example.com、http://127.0.0.1@example.com 被拒且说清只能写本机地址；https://localhost:3000/ 可以', async () => {
    const { fix, info } = await started();
    const submit = (preview: string) => callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info, { preview }));
    for (const preview of ['http://localhost.example.com', 'http://127.0.0.1@example.com', 'http://localhost:80@example.com']) {
      const result = await submit(preview);
      expect(result.ok, preview).toBe(false);
      expect(result.error, preview).toContain('本机地址');
    }
    expect(await submit('https://localhost:3000/')).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobSubmissions').list()[0]!.preview).toBe('https://localhost:3000/');
  });
});

describe('7 launched 的反例', () => {
  it('不是执行者（核对人、总管）、状态不对（执行中）、审批还在等、审批被拒、链接不是 http(s)：各被拒，这件事的记录都不变', async () => {
    // 状态不对：这件事还在核对之前。
    const early = await delivered();
    const call = (fix: JobFix, who: { id: string }, args: Record<string, unknown>) => callTool(fix, bot(fix, who.id), 'hub_job_work', { mode: 'launched', ...args });
    expect(await call(early.fix, early.fix.engineer, { jobId: early.job.id, link: 'https://example.com/x' })).toEqual({ ok: false, error: '这件事现在不在等发布结果' });

    const { fix, job } = await acceptedWithLaunch();
    // 发布状态是准备中：还没有审批。
    expect(await call(fix, fix.engineer, { jobId: job.id, link: 'https://example.com/x' })).toEqual({ ok: false, error: '这件事现在不在等发布结果' });
    const { approval } = await submitLaunch(fix);
    // 只比较和发布有关的部分（别的字段，如已用回合数，会随林舟的回合变化）。
    const snapshot = () => JSON.stringify({ state: theJob(fix).state, launch: theJob(fix).launch });
    const before = snapshot();
    // 审批还在等：不能报已发布。
    // P74r6 改了预期：原来断言「这件事现在不在等发布结果」；现在写明事实「发布审批还没有批准，不能回报已发布。」。
    expect(await call(fix, fix.engineer, { jobId: job.id, link: 'https://example.com/x' })).toEqual({ ok: false, error: '发布审批还没有批准，不能回报已发布。' });
    // 不是执行者：核对人、总管。
    expect(await call(fix, fix.reviewer, { jobId: job.id, link: 'https://example.com/x' })).toMatchObject({ ok: false, error: '只有这件事的执行者能回报发布结果' });
    expect(await call(fix, fix.chief, { jobId: job.id, link: 'https://example.com/x' })).toMatchObject({ ok: false, error: '只有这件事的执行者能回报发布结果' });
    fix.ctx.exec.set('node', ['work/go-live.js'], { code: 0, stdout: '已上线', stderr: '', timedOut: false });
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    // P74r18b 同步：批准之后命令由中心立刻运行（等它做完），发布状态随之记为已发布（还没有网址），所以后面比较的「记录不变」以运行之后为基准。
    await executeReadyOutbox(fix.ctx);
    await nextPacket(fix, fix.engineer.id);
    const afterRun = snapshot();
    expect(JSON.parse(afterRun).launch).toMatchObject({ state: 'done', link: null });
    // 审批已批准、命令已运行成功，但地址不合格。
    for (const link of ['ftp://example.com/x', 'javascript:alert(1)', 'example.com/signup', 'https://a b.com/', 'https://user:pw@example.com/', 'https://', '']) {
      const result = await call(fix, fix.engineer, { jobId: job.id, ...(link === '' ? {} : { link }) });
      expect(result.ok, JSON.stringify(link)).toBe(false);
      expect(snapshot(), link).toBe(afterRun);
    }
    expect(await call(fix, fix.engineer, { jobId: job.id, link: `https://example.com/${'a'.repeat(500)}` })).toMatchObject({ ok: false });
    expect(snapshot()).toBe(afterRun);
    // 字段放错 mode：launched 不用 text。
    expect(await call(fix, fix.engineer, { jobId: job.id, link: 'https://example.com/x', text: '多余' })).toMatchObject({ ok: false, error: expect.stringContaining('mode 为 launched 时不用这些字段：text') });
    // 合格的地址成功；再报一次被拒（已经发布了）。
    expect(await call(fix, fix.engineer, { jobId: job.id, link: 'https://example.com/ok' })).toEqual({ ok: true, text: '已记下发布地址。' });
    expect(await call(fix, fix.engineer, { jobId: job.id, link: 'https://example.com/ok2' })).toEqual({ ok: false, error: '这件事现在不在等发布结果' });
    expect(theJob(fix).launch.link).toBe('https://example.com/ok');
  });
});

describe('8 唤醒包：发布这一段受上限和逐级压缩约束', () => {
  it('产出物很多、上限很小时，只压缩产出物清单；讲怎样提交和怎样回报的两行任何一级都不删', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    const latest = fix.ctx.store.table('jobSubmissions').list().at(-1)!;
    const many = Array.from({ length: 20 }, (_, i) => `交付/一个名字比较长的产出物文件-${i + 1}.html`);
    fix.ctx.store.table('jobSubmissions').put({ ...latest, deliverables: many });
    const ticket = wakesOf(fix, fix.engineer.id).at(-1)!;
    const entry = { jobId: job.id } as QueueEntry;
    const engineer = bot(fix, fix.engineer.id);
    const whole = await buildJobBodyDetailed(fix.ctx, engineer, entry, ticket);
    expect(whole.level).toBe(0);
    const submitLine = whole.text.split('\n').find(line => line.startsWith('提交发布：'))!;
    const backLine = whole.text.split('\n').find(line => line.startsWith('批准后：'))!;
    expect(submitLine).toBeDefined();
    // 逐级调小上限：级别升高、产出物清单变短，两行做法逐字不变；序号性的内容（jobId）一直在。
    let last = whole.text.length;
    for (const max of [1800, 1400, 1100, 900]) {
      const fit = await buildJobBodyDetailed(fix.ctx, engineer, entry, ticket, max);
      expect(fit.text, String(max)).toContain(submitLine);
      expect(fit.text, String(max)).toContain(backLine);
      expect(fit.text, String(max)).toContain(`jobId 为 ${job.id}`);
      expect(fit.text.length, String(max)).toBeLessThanOrEqual(last);
      last = fit.text.length;
    }
    const tiny = await buildJobBodyDetailed(fix.ctx, engineer, entry, ticket, 900);
    expect(tiny.level).toBeGreaterThanOrEqual(1);
    expect(tiny.text).toContain('下面的路径都相对于主题文件夹');
    expect(tiny.text).toContain('另有 12 项，见主题文件夹的「交付」');
  });
});
