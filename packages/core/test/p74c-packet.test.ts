/**
 * P74c 的测试：唤醒包里的「你手上的事（中心维护）」段（任务卡 9 节）。
 * 全部走真实 Hub：员工的唤醒包是真实调度放行时生成、真实投递给（假）宿主的那一份文本。
 * 其中有三条是「只用这一段里的文字」的测试：从文本里用正则取出编号、路径、名字，再去调用现有工具，必须成功。
 */
import { describe, expect, it } from 'vitest';
import { AgreementSchema } from '../src/model/agreement.js';
import { appendJobEvent } from '../src/job/store.js';
import { applyJobAction } from '../src/job/state.js';
import { enqueueJobWake } from '../src/job/chain.js';
import { CHIEF_RULES_TEXT } from '../src/wake/chief-packet.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { createTicket } from '../src/wake/ticket.js';
import { byteLength } from '../src/util/text.js';
import { JOB_DEFAULTS } from '../src/config/defaults.js';
import { lastPacket } from './p63-topic-fixtures.js';
import { ownerSays } from './p74b-fixtures.js';
import {
  MINUTE, assigned, bot, callTool, commitAndEnd, entriesOf, jobFix, lockedAndAwake, runningJob, runningOf, speak, theJob, tick,
  topicMessages, type JobFix,
} from './p74c-fixtures.js';

/** 给主人看的文字里不许出现的内部名称（这里用来断言给模型看的段落以外的地方）。 */
const SECTION = '## 你手上的事（中心维护）';

/** 取出「你手上的事」段的正文（到下一个二级标题或结尾）。 */
function sectionOf(packet: string): string {
  const start = packet.indexOf(SECTION);
  expect(start, '唤醒包里应该有「你手上的事」段').toBeGreaterThanOrEqual(0);
  const rest = packet.slice(start + SECTION.length);
  const next = rest.search(/\n\n## /);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** 让这位员工拿到一个回合，返回那一回合的唤醒包。 */
async function nextPacket(fix: JobFix, botId: string): Promise<string> {
  for (let i = 0; i < 6 && !runningOf(fix, botId); i += 1) await tick(fix, 5 * MINUTE);
  expect(runningOf(fix, botId)).toBeDefined();
  return lastPacket(fix, bot(fix, botId));
}

describe('16 执行者的写法', () => {
  it('待开工：各行齐全，路径真实存在，条目序号与约定一致', async () => {
    const fix = await jobFix();
    // P74r7：交付时核对的条目必须写了时间，夹具里的第 1 条原文带「今天」，改为指定第 1 条（原来是第 3 条，原文没有时间）。
    await runningJob(fix, { deliveryItems: [1] });
    const job = theJob(fix);
    const text = sectionOf(lastPacket(fix, bot(fix, fix.engineer.id)));
    expect(text).toContain(`你是「会员定价页」的执行者（jobId 为 ${job.id}）。评审甲在交付前对照约定逐条核对，核对通过后由中心交给主人验收。`);
    expect(text).toMatch(/现在：执行中。交付时间：11月17日 18:00 前。/);
    expect(text).not.toContain('本阶段第');
    // 三份文件的绝对路径真实存在。
    for (const name of ['约定.md', '原话.md', '草图.md']) {
      const path = new RegExp(`(/[^\\s；]*/${job.id}/${name})`).exec(text)?.[1];
      expect(path, name).toBeDefined();
      expect(await fix.ctx.fs.readText(path!), name).not.toBeNull();
    }
    expect(text).toContain(`用 hub_project_put 放进项目文件夹（参数 project 填 ${job.projectId}，to 写 jobs/${job.id}/交付/文件名）；截图和测试日志放进 jobs/${job.id}/证据/。`);
    // 怎样算做完：条数和序号与约定一致，交付时核对的那一条带说明。
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const done = agreement.versions.find(row => row.state === 'locked')!.content.doneWhen;
    expect(text).toContain('怎样算做完（交回时逐条对应，no 写序号）：');
    done.forEach((item, index) => expect(text).toContain(`${index + 1}. ${item}${index + 1 === 1 ? '（交付时核对：selfCheck 写 at_delivery，不附证据）' : ''}`));
    expect(text).toContain('交回：调用 hub_job_work，mode 写 submit，jobId 写 ' + job.id);
    expect(text).toContain('有问题问总管：mode 写 ask，text 写问题。做不下去：mode 写 block，stuckAt 写卡在哪，tried 写试过什么。');
    expect(text).toContain('不要直接找主人，不要用 hub_send。交账的 reply 只写一句这一回合做了什么。');
    expect(text).not.toContain('总管刚回答你');
    expect(text).not.toContain('总管刚转来材料');
    expect(text).not.toContain('这一轮要改的条目');
    expect(text).not.toContain('在等主人确认');
  });

  it('返工：写出本阶段第几轮和要改的条目；材料文件、总管的回答、转来的材料都进来', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.engineer.id, kind: 'submitted', to: [fix.reviewer.id], refId: null, data: {} });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    // 直接把状态改成「返工中，已核对一轮，第 2 条不符」（核对本身的工具在后面的卡）。
    const checking = applyJobAction(theJob(fix), { type: 'submit' }, fix.ctx.clock.now());
    const rework = applyJobAction(checking, { type: 'review_fail', unmet: [{ no: 2, problem: '价格没有分档', fixTo: '页面上能看到三档价格' }] }, fix.ctx.clock.now());
    fix.ctx.store.table('jobs').put(rework);
    // 总管转来的材料文件和一次回答。
    const project = fix.ctx.store.table('projects').get(job.projectId)!;
    const materials = `${project.sharedDir.replace(/\/+$/, '')}/${job.folder}/材料`;
    await fix.ctx.fs.writeTextAtomic(`${materials}/竞品价格.txt`, '九块 十九块');
    const answer = appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'answered', to: [fix.engineer.id], refId: null,
      data: { text: '按三档做', basis: [{ section: 'doneWhen', no: 2 }] } });
    const forwarded = appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'forwarded', to: [fix.engineer.id], refId: null, data: { file: '竞品价格.txt' } });
    expect(enqueueJobWake(fix.ctx, { job: rework, botId: fix.engineer.id, why: 'returned', eventId: null, summary: '核对退回' })).not.toBeNull();
    expect(enqueueJobWake(fix.ctx, { job: rework, botId: fix.engineer.id, why: 'answered', eventId: answer.id, summary: '总管回答了' })).not.toBeNull();
    expect(enqueueJobWake(fix.ctx, { job: rework, botId: fix.engineer.id, why: 'forwarded', eventId: forwarded.id, summary: '总管转来材料' })).not.toBeNull();
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    expect(text).toContain('现在：返工中，本阶段第 1 轮，共 3 轮。');
    expect(text).toContain('这一轮要改的条目：第 2 条：问题：价格没有分档；改到什么程度算过：页面上能看到三档价格。其余条目不用再交，沿用上一轮结论。');
    // P74r2d 第 2 点：材料只写一次文件夹的绝对路径，后面列各份的文件名（原来逐份写绝对路径）。
    expect(text).toMatch(/；材料文件夹 \S+\/材料：竞品价格\.txt。/);
    expect(text).toContain('总管刚回答你：按三档做（依据：doneWhen 2）');
    expect(text).toContain('总管刚转来材料：竞品价格.txt');
    // 材料的绝对路径真实存在。
    // P74r2d 第 2 点：文件夹绝对路径加文件名，拼起来能打开。
    const folder = /材料文件夹 (\S+\/材料)：竞品价格\.txt。/.exec(text)![1]!;
    expect(await fix.ctx.fs.readText(`${folder}/竞品价格.txt`)).toBe('九块 十九块');
  });

  it('约定修改在等主人确认：暂停与照常在做两栏，暂停部分不要交回', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    // P74r2b：巡检会清掉指向「不存在的版本」的暂停（按撤销处理），所以先让约定真有一个待确认的第 2 版，再写暂停。
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const v1 = agreement.versions[0]!;
    fix.ctx.store.table('agreements').put(AgreementSchema.parse({ ...agreement, state: 'pending',
      versions: [v1, { ...v1, no: 2, state: 'pending', lockedAt: null, lockedVia: null, adoption: null }] }));
    fix.ctx.store.table('jobs').patch(job.id, { pause: { versionNo: 2, continuing: ['页面骨架'], paused: ['名额计数', '名额已满'], fallback: null } });
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    expect(text).toContain('约定第 2 版在等主人确认：暂停名额计数、名额已满；照常在做页面骨架。暂停的部分在主人确认前不要交回。');
    expect(text).toContain('照常在做的部分做完之后，交账的结果写 no_change，说明在等约定确认；主人确认后中心会叫你。');
  });

  it('只用这一段里的文字：取出 jobId、projectId、放文件的路径，调用 hub_project_put 成功；路径指向的目录真实存在', async () => {
    const fix = await jobFix();
    await runningJob(fix);
    const text = sectionOf(lastPacket(fix, bot(fix, fix.engineer.id)));
    const jobId = /jobId 为 (job_[0-9a-z]{10})/.exec(text)![1]!;
    const projectId = /参数 project 填 (prj_[0-9a-z]{10})，to 写 (\S+?)文件名/.exec(text)!;
    const home = bot(fix, fix.engineer.id).homeDir;
    await fix.ctx.fs.writeTextAtomic(`${home}/work/报价页.html`, '<html>页面</html>');
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_project_put', { from: 'work/报价页.html', to: `${projectId[2]}报价页.html`, project: projectId[1] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const job = theJob(fix);
    expect(job.id).toBe(jobId);
    const project = fix.ctx.store.table('projects').get(job.projectId)!;
    expect(await fix.ctx.fs.readText(`${project.sharedDir.replace(/\/+$/, '')}/jobs/${jobId}/交付/报价页.html`)).toBe('<html>页面</html>');
  });
});

describe('16 核对人的写法', () => {
  /** 林舟已交回一轮（直接写交回记录），评审甲拿到核对的回合；返回评审甲的唤醒包和主题里的"执行过程"原文。 */
  async function reviewerPacket(fix: JobFix) {
    const { job } = await runningJob(fix);
    const secrets = { floor: '主人楼层的独特原话ZZ', ask: '执行者提问的独特原文YY', answer: '总管回答的独特原文XX', work: '工作往来的独特原文WW' };
    await ownerSays(fix, job.topicId, secrets.floor);
    await speak(fix, fix.chief, '收到。', { outcome: 'progress' });
    const asked = appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.engineer.id, kind: 'asked', to: [fix.chief.id], refId: null, data: { text: secrets.ask } });
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'answered', to: [fix.engineer.id], refId: asked.id, data: { text: secrets.answer } });
    fix.ctx.store.log('thread').append({ id: 'm_0000000777', thread: job.topicId, from: 'hub', kind: 'work', text: secrets.work, refId: null, createdAt: fix.ctx.clock.now(), readAt: null });
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.engineer.id, kind: 'submitted', to: [fix.reviewer.id], refId: null, data: {} });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const checking = applyJobAction(theJob(fix), { type: 'submit' }, fix.ctx.clock.now());
    fix.ctx.store.table('jobs').put(checking);
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const done = agreement.versions.find(row => row.state === 'locked')!.content.doneWhen;
    const project = fix.ctx.store.table('projects').get(job.projectId)!;
    await fix.ctx.fs.writeTextAtomic(`${project.sharedDir.replace(/\/+$/, '')}/${job.folder}/证据/截图.png`, 'png');
    fix.ctx.store.table('jobSubmissions').put({
      id: 'jsb_0000000001', jobId: job.id, stage: 1, round: 1, executorId: fix.engineer.id, versionNo: 1, changeNote: '搭好了三档价格页',
      items: done.map((text, index) => ({ no: index + 1, text, selfCheck: index === 0 ? 'met' as const : index === 1 ? 'not_met' as const : 'at_delivery' as const,
        note: index === 1 ? '还差一档' : null,
        evidence: index === 0 ? [{ id: 'ev1', kind: 'image' as const, path: '证据/截图.png', url: null, summary: '页面截图', command: null, check: { status: 'ok' as const, detail: '文件存在，大小 3 字节' } },
          { id: 'ev2', kind: 'test' as const, path: null, url: null, summary: '价格档位测试通过', command: 'pnpm test pricing', check: { status: 'unchecked' as const, detail: '' } }] : [] })),
      deliverables: ['交付/报价页.html'], preview: 'http://localhost:5173', createdAt: fix.ctx.clock.now(),
    });
    expect(enqueueJobWake(fix.ctx, { job: checking, botId: fix.reviewer.id, why: 'to_review', eventId: null, summary: '请核对' })).not.toBeNull();
    return { job: checking, secrets, packet: await nextPacket(fix, fix.reviewer.id), done };
  }

  it('各行齐全；不含任何工作往来、主题楼层、提问与回答的原文', async () => {
    const fix = await jobFix();
    const { job, secrets, packet, done } = await reviewerPacket(fix);
    const text = sectionOf(packet);
    expect(text).toContain(`你是「会员定价页」的核对人（jobId 为 ${job.id}）。只看约定和下面的证据，不看执行过程。`);
    expect(text).toMatch(/约定全文：\S+\/约定\.md。这是第 1 阶段第 1 轮核对，本阶段最多 3 轮。/);
    expect(text).toContain('林舟的交回（搭好了三档价格页）：');
    done.forEach((item, index) => expect(text).toContain(`${index + 1}. ${item}`));
    expect(text).toContain('自查：自查符合');
    expect(text).toContain('自查：自查不符：还差一档');
    expect(text).toContain('自查：交付时核对');
    expect(text).toMatch(/证据 ev1：图片 \S+\/证据\/截图\.png 页面截图；中心检查：文件存在，大小 3 字节/);
    expect(text).toContain('证据 ev2：测试 价格档位测试通过；复跑命令：pnpm test pricing');
    expect(text).toMatch(/产出物：\S+\/交付\/报价页\.html；预览：http:\/\/localhost:5173/);
    expect(text).toContain('核对规则：只核对是否符合约定、是否正确；配色、字体、文案语气不在核对范围。');
    expect(text).toContain(`提交结论：调用 hub_job_work，mode 写 review，jobId 写 ${job.id}，items 逐条写 no、verdict（met、unmet 或 at_delivery）、note、fixTo。`);
    expect(text).toContain('不要直接找主人，不要用 hub_send。交账的 reply 只写一句。');
    // 整个唤醒包里都没有执行过程的原文。
    for (const secret of Object.values(secrets)) expect(packet, secret).not.toContain(secret);
    expect(packet).not.toContain('## 主题');
    expect(topicMessages(fix, job).some(row => row.text === secrets.floor)).toBe(true);
  });

  it('只用这一段里的文字：取出 jobId 和约定路径，能找到这件事、读到约定', async () => {
    const fix = await jobFix();
    const { packet } = await reviewerPacket(fix);
    const text = sectionOf(packet);
    const jobId = /jobId 为 (job_[0-9a-z]{10})/.exec(text)![1]!;
    expect(fix.ctx.store.table('jobs').get(jobId)).not.toBeNull();
    const path = /约定全文：(\S+\/约定\.md)。/.exec(text)![1]!;
    expect(await fix.ctx.fs.readText(path)).toContain('# 会员定价页（约定第 1 版）');
  });
});

describe('16 总管的写法', () => {
  it('执行链唤醒（执行者做不下去）：约定各部分的序号与情况行', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', summary: '卡住了', blocker: '缺少价格表' });
    const packet = await nextPacket(fix, fix.chief.id);
    const text = sectionOf(packet);
    expect(text).toContain(`「会员定价页」（jobId 为 ${job.id}）：受阻，执行者林舟，核对人评审甲。约定全文：`);
    expect(text).toContain('约定各部分的序号（回答时 basis 用 section 加 no）：');
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const c = agreement.versions.find(row => row.state === 'locked')!.content;
    expect(text).toContain(`summary 1. ${c.summary}`);
    c.pending.forEach((item, index) => expect(text).toContain(`pending ${index + 1}. ${item.question}：${item.chosen ?? item.suggested}`));
    c.decided.forEach((item, index) => expect(text).toContain(`decided ${index + 1}. ${item.text}`));
    c.scopeIn.forEach((item, index) => expect(text).toContain(`scopeIn ${index + 1}. ${item}`));
    c.scopeOut.forEach((item, index) => expect(text).toContain(`scopeOut ${index + 1}. ${item}`));
    c.doneWhen.forEach((item, index) => expect(text).toContain(`doneWhen ${index + 1}. ${item}`));
    expect(text).toContain('林舟做不下去：缺少价格表。');
  });

  it('执行链唤醒（有未回答的提问）：写出提问人和问题原文', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    const asked = appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.engineer.id, kind: 'asked', to: [fix.chief.id], refId: null, data: { text: '会员价写几档？' } });
    fix.ctx.store.table('jobs').patch(job.id, { openAsk: { eventId: asked.id, fromId: fix.engineer.id, at: fix.ctx.clock.now() } });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先问一下' });
    const open = theJob(fix);
    expect(enqueueJobWake(fix.ctx, { job: open, botId: fix.chief.id, why: 'asked', eventId: asked.id, summary: '林舟问了一个问题' })).not.toBeNull();
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    expect(text).toContain('林舟问你：会员价写几档？');
  });

  it('主人发起的唤醒（没有 jobId）：「你手上的事」一览，每件一行', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    // 林舟这一回合先交账结束（主人在线时同一时刻只允许一位思考），主人再问总管。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    await ownerSays(fix, fix.chief.id, '进展怎么样了');
    const packet = lastPacket(fix, bot(fix, fix.chief.id));
    expect(runningOf(fix, fix.chief.id)).toMatchObject({ ownerInitiated: true });
    // P76e：每件事多一行消耗（对齐 1 个回合加执行者第一个回合 = 已用 2；首次估计 9）。
    // P88：在办的事的写法逐字不变，之后多一句固定的话（原断言整段只有这两行）。
    expect(sectionOf(packet)).toBe(`「会员定价页」（jobId 为 ${job.id}）执行中，在等林舟\n  消耗：已用 2 / 预计 9 回合\n提到一件已经派出的事的状态时，只按这一段列出的写；这一段没有列出的事，不要说它正在进行或正在返工。约定的状态见「你手上的约定」。`);
  });

  it('只用这一段里的文字：取出 jobId 和员工名字，调用 hub_job_manage 的 reassign 成功', async () => {
    const fix = await jobFix(['小周']);
    await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    await ownerSays(fix, fix.chief.id, '换个人做');
    const packet = lastPacket(fix, bot(fix, fix.chief.id));
    const text = sectionOf(packet);
    const jobId = /jobId 为 (job_[0-9a-z]{10})/.exec(text)![1]!;
    // 员工名字来自唤醒包的「团队现在」一节（这一回合没有新固定的约定，所以没有「当前在岗的员工」那一行）。
    const team = packet.slice(packet.indexOf('## 团队现在'));
    expect(/^(小周)：/m.exec(team)?.[1]).toBe('小周');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId, executor: '小周' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).executorId).toBe(fix.extras[0]!.id);
  });

  it('其他员工（没有 jobId 的唤醒）：有在办的事就写一行', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const entry = { ...entriesOf(fix, fix.engineer.id, job.id)[0]!, id: 'q_0000000001' };
    const { jobId: _ignored, ...plain } = entry;
    const ticket = createTicket(fix.ctx, plain, null);
    const packet = await buildWakePacket(fix.ctx, bot(fix, fix.engineer.id), plain, ticket);
    expect(sectionOf(packet)).toBe(`你正在做「会员定价页」（jobId 为 ${job.id}），关于这件事的往来用 hub_job_work。`);
  });
});

describe('段落的出现条件与上限', () => {
  it('轻复查和复盘不出现；没有在办的事时总管这一段仍出现（P88：写「现在没有在办的事。」）', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const base = { ...entriesOf(fix, fix.engineer.id, job.id)[0]!, id: 'q_0000000001' };
    for (const variant of ['light_check', 'reflection'] as const) {
      const entry = { ...base, variant };
      const ticket = createTicket(fix.ctx, entry, null);
      const packet = await buildWakePacket(fix.ctx, bot(fix, fix.engineer.id), entry, ticket);
      expect(packet, variant).not.toContain(SECTION);
    }
    // 没有在办的事：P88 之前总管的唤醒包里不出现这一段（原断言 not.toContain(SECTION)）；现在出现，内容是两行固定的话。
    const other = await jobFix();
    const calm = await lockedAndAwake(other);
    expect(calm).toContain(SECTION);
    expect(sectionOf(calm)).toBe('现在没有已经派出、还没有收尾的事。\n提到一件已经派出的事的状态时，只按这一段列出的写；这一段没有列出的事，不要说它正在进行或正在返工。约定的状态见「你手上的约定」。');
  });

  it('17 约定撑到内容上限时段不超过上限（P74r2d 起放得下、不压缩）；总管守则、约定段不被截断；不占原有预算', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    // 把约定撑到接近内容上限，让总管的执行链段超过 4 KB。
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const long = (n: number) => `${String(n).padStart(2, '0')}${'说明'.repeat(48)}`;
    const version = agreement.versions.find(row => row.state === 'locked')!;
    fix.ctx.store.table('agreements').put({ ...agreement, versions: agreement.versions.map(row => row.no !== version.no ? row : { ...row, content: {
      ...row.content,
      decided: Array.from({ length: 8 }, (_, i) => ({ text: long(i), basis: { kind: 'judgement' as const, ref: null, refText: null } })),
      doneWhen: Array.from({ length: 5 }, (_, i) => long(i + 20)),
      scopeIn: Array.from({ length: 6 }, (_, i) => `范围${i}${'内'.repeat(50)}`),
      scopeOut: Array.from({ length: 6 }, (_, i) => `不做${i}${'外'.repeat(50)}`),
    } }) });
    // 总管被叫醒做 escalate（执行者做不下去）。
    await speak(fix, fix.chief, '好', { outcome: 'progress' });
    const blocked = applyJobAction(theJob(fix), { type: 'block', kind: 'executor', no: null, text: '缺少价格表' }, fix.ctx.clock.now());
    fix.ctx.store.table('jobs').put(blocked);
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    expect(enqueueJobWake(fix.ctx, { job: blocked, botId: fix.chief.id, why: 'escalate', eventId: null, summary: '林舟做不下去' })).not.toBeNull();
    const packet = await nextPacket(fix, fix.chief.id);
    const text = sectionOf(packet);
    expect(byteLength(text)).toBeLessThanOrEqual(JOB_DEFAULTS.PACKET_MAX_BYTES);
    // P74r2d 第 1 条：上限放宽到 16 KB，这份撑到内容上限的约定放得下，一条都不删、不压缩；
    // 原来断言「其余 N 条见约定文件」的整条删掉的写法不再存在；末尾「怎样回答」的做法说明一行不丢。
    expect(text).not.toMatch(/其余 \d+ 条见约定文件/);
    expect(text).not.toContain('条目全文见约定文件');
    for (const part of ['decided 8.', 'scopeIn 6.', 'scopeOut 6.', 'doneWhen 5.']) expect(text).toContain(part);
    expect(text).toContain('回答：调用 hub_job_manage，mode 写 answer');
    // 总管守则全文都在，约定段也在。
    expect(packet).toContain(CHIEF_RULES_TEXT);
    expect(packet).toContain('## 你手上的约定（中心维护）');
  });
});
