/**
 * P74r2d 第 1、2 条（唤醒包部分）的测试：「你手上的事」段的体积与逐级压缩（审查发现 G5、G11）。
 *
 * 目录：
 *   1 审查报告 G5 的场景（转来 4 份材料加 500 字回答）：一条不删、做法说明完整、回答完整
 *   2 材料写法：文件夹路径写一次、最多列 8 份（最近的）、另有几份
 *   3 没有压缩的小例子：与修改前逐字相同（除材料写法）
 *   4 逐级压缩：每一级缩什么、不删什么（用测试专用的更小上限逐级触发）
 *   5 按参数上限构造最大的一件事：三种段都不超过上限或落在第四级，序号、证据编号与路径、做法说明都在
 *   6 四级之后仍超过上限：记错误日志，按第四级输出，不整段截断
 * 全部走真实 Hub（真实的启动整理与显著性），时间用注入的假时钟（每次推进不超过 10 分钟）。
 */
import { describe, expect, it, vi } from 'vitest';
import { JOB_DEFAULTS as D } from '../src/config/defaults.js';
import { enqueueJobWake } from '../src/job/chain.js';
import { applyJobAction } from '../src/job/state.js';
import { appendJobEvent } from '../src/job/store.js';
import type { Evidence } from '../src/model/job.js';
import type { QueueEntry, WakeTicket } from '../src/model/wake.js';
import { byteLength } from '../src/util/text.js';
import { buildJobBodyDetailed } from '../src/wake/job-section.js';
import { ownerSays } from './p74b-fixtures.js';
import { bot, callTool, commitAndEnd, jobFix, runningJob, speak, theJob, type JobFix } from './p74c-fixtures.js';
import { nextPacket, sectionOf, started } from './p74d-fixtures.js';

// 末尾做法说明的逐字原文（压缩的任何一级都不许改动、不许删）。
const EXECUTOR_TAIL = [
  '有问题问总管：mode 写 ask，text 写问题。做不下去：mode 写 block，stuckAt 写卡在哪，tried 写试过什么。',
  '不要直接找主人，不要用 hub_send。交账的 reply 只写一句这一回合做了什么。',
];
const REVIEWER_TAIL = [
  '核对规则：只核对是否符合约定、是否正确；配色、字体、文案语气不在核对范围。能复查的自己复查一次（打开页面、复跑命令），在 note 里写明。不符的条目必须写 note（问题是什么）和 fixTo（改到什么程度算过，写成一句可以验证的话）。沿用上一轮结论的条目可以不写结论；抽查了哪几条写进 spotChecked，沿用的理由写进 carriedNote。',
  '不要直接找主人，不要用 hub_send。交账的 reply 只写一句。',
];

/** 直接取这位员工在这件事上的「你手上的事」段（可指定更小的上限，只给测试用）。 */
async function bodyOf(fix: JobFix, botId: string, maxBytes?: number, entry?: QueueEntry) {
  const job = theJob(fix);
  const fake = { jobId: job.id, reason: { evidence: [] } } as unknown as QueueEntry;
  return buildJobBodyDetailed(fix.ctx, bot(fix, botId), entry ?? fake, { jobId: job.id } as unknown as WakeTicket, maxBytes);
}

/** 一件事里按序号和字数构造一份「怎样算做完」。 */
function doneList(count: number, chars: number): string[] {
  return Array.from({ length: count }, (_, i) => `${i + 1}号条目${'要'.repeat(chars - 5)}`);
}

/** 直接改约定已固定版本里的「怎样算做完」。 */
function setDoneWhen(fix: JobFix, agreementId: string, doneWhen: string[]): void {
  const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
  const version = agreement.versions.find(row => row.state === 'locked')!;
  fix.ctx.store.table('agreements').put({ ...agreement, versions: agreement.versions.map(row => row.no !== version.no ? row : { ...row, content: { ...row.content, doneWhen } }) });
}

interface ReviewShape { items: number; evidence: number; itemChars?: number; summaryChars?: number; commandChars?: number }

/** 核对中：约定有 items 条，交回里每条 evidence 项证据（文件类和测试类各一半），核对人是评审甲。 */
async function reviewing(shape: ReviewShape): Promise<{ fix: JobFix; done: string[]; jobDir: string }> {
  const fix = await jobFix();
  const { job, agreementId } = await runningJob(fix);
  const done = doneList(shape.items, shape.itemChars ?? 30);
  setDoneWhen(fix, agreementId, done);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  fix.ctx.store.table('jobs').put(applyJobAction(theJob(fix), { type: 'submit' }, fix.ctx.clock.now()));
  const evidence = (no: number, k: number): Evidence => {
    const isFile = k % 2 === 1;
    return {
      id: `ev${no}${k}`, kind: isFile ? 'file' : 'test', path: isFile ? `证据/第${no}条-${k}.png` : null, url: null,
      summary: `第${no}条的证据${k}${'证'.repeat((shape.summaryChars ?? 20) - 6)}`,
      command: isFile ? null : `pnpm test ${'a'.repeat((shape.commandChars ?? 20) - 10)}`,
      check: isFile ? { status: 'ok', detail: '文件存在，1.0 KB' } : { status: 'unchecked', detail: '中心不执行命令，由核对人复跑' },
    };
  };
  fix.ctx.store.table('jobSubmissions').put({
    id: 'jsb_0000000001', jobId: job.id, stage: 1, round: 1, executorId: fix.engineer.id, versionNo: 1, changeNote: '搭好了',
    items: done.map((text, index) => ({ no: index + 1, text, selfCheck: 'met' as const, note: null,
      evidence: Array.from({ length: shape.evidence }, (_, k) => evidence(index + 1, k + 1)) })),
    deliverables: ['交付/报价页.html'], preview: null, createdAt: fix.ctx.clock.now(),
  });
  return { fix, done, jobDir: `/hub/projects/${theJob(fix).projectId}/${theJob(fix).folder}` };
}

describe('1 审查报告 G5 的场景：转来 4 份材料加 500 字回答', () => {
  it('执行者的段里「怎样算做完」每一条都在，末尾做法说明完整（含「不要直接找主人」），回答完整，材料只写一次文件夹路径', async () => {
    const { fix, job, info } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做骨架' });
    await ownerSays(fix, fix.chief.id, '这是几份材料。');
    for (const title of ['活动文案', '接口说明', '价格表', '品牌规范']) {
      const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: job.id, title, text: `${title}的原文` });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    }
    await speak(fix, bot(fix, fix.chief.id), '已转交。', { outcome: 'progress' });
    // 林舟提问，总管回答（500 字，两处出处）。
    await nextPacket(fix, fix.engineer.id);
    const asked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: info.jobId, text: '报价要不要含税？' });
    expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
    await nextPacket(fix, fix.chief.id);
    const answer = `答案${'细'.repeat(498)}`;
    const answered = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'answer', jobId: info.jobId, text: answer, basis: [{ section: 'decided', no: 1 }, { section: 'doneWhen', no: 2 }, { section: 'scopeIn', no: 1 }] });
    expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已回答' });
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    expect(byteLength(text)).toBeLessThanOrEqual(D.PACKET_MAX_BYTES);
    // 条目一条不少，没有压缩的痕迹，也没有整条删掉的写法。
    expect((text.match(/^\d+\. /gm) ?? []).length).toBe(3);
    expect(text).not.toMatch(/其余 \d+ 条/);
    expect(text).not.toContain('下面的路径都相对于主题文件夹');
    expect(text).not.toContain('条目全文见约定文件');
    // 末尾的做法说明逐字完整，含「不要直接找主人」。
    for (const line of EXECUTOR_TAIL) expect(text).toContain(line);
    expect(text).toContain('交回：调用 hub_job_work，mode 写 submit');
    // 回答完整（500 字答案全在）。
    expect(text).toContain(`总管刚回答你：${answer}`);
    expect(text).not.toContain('回答较长，后面的部分放不下');
    // 材料：文件夹的路径只写一次，后面列四份文件名。
    expect(text.split('/材料').length - 1).toBeLessThanOrEqual(2);
    expect(text).toMatch(/；材料文件夹 \S+\/材料：[^；。]*价格表\.md/);
    for (const title of ['活动文案', '接口说明', '价格表', '品牌规范']) expect(text).toContain(`${title}.md`);
    expect(text).not.toContain('另有');
  });
});

describe('2 材料的写法：最多列最近的 8 份', () => {
  it('转来 10 份材料：列最近转来的 8 份，写「另有 2 份，见材料文件夹」；最早转来的两份不在清单里', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做骨架' });
    await ownerSays(fix, fix.chief.id, '材料很多。');
    // 标题按字母倒序转交：最早转来的名字最大，按名字排和按转交先后排结果不同，才能证明「最近」按转交先后。
    const titles = 'JIHGFEDCBA'.split('').map(letter => `材料${letter}`);
    for (const title of titles) {
      const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: job.id, title, text: `${title}的原文` });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    }
    const body = (await bodyOf(fix, fix.engineer.id)).text;
    expect(body).toContain('；另有 2 份，见材料文件夹');
    for (const title of titles.slice(2)) expect(body).toContain(`${title}.md`);
    for (const title of titles.slice(0, 2)) expect(body).not.toContain(`${title}.md`);
  });

  it('反例：恰好 8 份时不写「另有」', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做骨架' });
    await ownerSays(fix, fix.chief.id, '八份材料。');
    for (let i = 1; i <= 8; i += 1) {
      expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: job.id, title: `材料${i}`, text: '原文' })).toMatchObject({ ok: true });
    }
    expect((await bodyOf(fix, fix.engineer.id)).text).not.toContain('另有');
  });
});

describe('3 没有压缩时的输出', () => {
  it('核对人：2 条、每条 2 项证据：输出与修改前逐字相同，没有任何压缩', async () => {
    const { fix, done, jobDir } = await reviewing({ items: 2, evidence: 2 });
    const result = await bodyOf(fix, fix.reviewer.id);
    expect(result.level).toBe(0);
    const job = theJob(fix);
    const lines = [
      `你是「会员定价页」的核对人（jobId 为 ${job.id}）。只看约定和下面的证据，不看执行过程。`,
      `约定全文：${jobDir}/约定.md。这是第 1 阶段第 1 轮核对，本阶段最多 3 轮。`,
      '林舟的交回（搭好了）：',
    ];
    for (const [index, text] of done.entries()) {
      const no = index + 1;
      lines.push(`${no}. ${text}`, '自查：自查符合',
        `证据 ev${no}1：文件 ${jobDir}/证据/第${no}条-1.png 第${no}条的证据1${'证'.repeat(14)}；中心检查：文件存在，1.0 KB`,
        `证据 ev${no}2：测试 第${no}条的证据2${'证'.repeat(14)}；复跑命令：pnpm test ${'a'.repeat(10)}；中心检查：中心不执行命令，由核对人复跑`);
    }
    lines.push(`产出物：${jobDir}/交付/报价页.html`, ...REVIEWER_TAIL.slice(0, 1),
      `提交结论：调用 hub_job_work，mode 写 review，jobId 写 ${job.id}，items 逐条写 no、verdict（met、unmet 或 at_delivery）、note、fixTo。`, REVIEWER_TAIL[1]!);
    expect(result.text).toBe(lines.join('\n'));
  });

  it('核对人：6 条「怎样算做完」、每条 2 项证据：6 条都在、每项证据都在、没有任何压缩', async () => {
    const { fix } = await reviewing({ items: 6, evidence: 2, itemChars: 100, summaryChars: 120 });
    const result = await bodyOf(fix, fix.reviewer.id);
    expect(result.level).toBe(0);
    expect(result.overflow).toBe(false);
    expect(byteLength(result.text)).toBeLessThanOrEqual(D.PACKET_MAX_BYTES);
    expect((result.text.match(/^\d+\. /gm) ?? []).length).toBe(6);
    for (let no = 1; no <= 6; no += 1) for (const k of [1, 2]) expect(result.text).toContain(`证据 ev${no}${k}：`);
    expect(result.text).not.toContain('下面的路径都相对于主题文件夹');
    expect(result.text).not.toContain('条目全文见约定文件');
    for (const line of REVIEWER_TAIL) expect(result.text).toContain(line);
  });
});

describe('4 逐级压缩：每一级缩什么、不删什么', () => {
  /** 逐级取出核对人的段：每次把上限压到比上一级的输出小 1 字节，得到下一级。 */
  async function reviewerLevels(shape: ReviewShape) {
    const ctxt = await reviewing(shape);
    const results = [await bodyOf(ctxt.fix, ctxt.fix.reviewer.id, 1_000_000)];
    for (let i = 1; i <= 4; i += 1) results.push(await bodyOf(ctxt.fix, ctxt.fix.reviewer.id, byteLength(results[i - 1]!.text) - 1));
    return { ...ctxt, results };
  }

  it('核对人：第一级去掉「文件存在」类检查说明并改相对路径，第二级证据说明截到 40 字，第三级条目原文截到 60 字并写「条目全文见约定文件」', async () => {
    const { fix, done, jobDir, results } = await reviewerLevels({ items: 5, evidence: 4, itemChars: 100, summaryChars: 120, commandChars: 100 });
    expect(results.map(row => row.level)).toEqual([0, 1, 2, 3, 4]);
    const [l0, l1, l2, l3] = results.map(row => row.text) as [string, string, string, string];
    // 第零级：绝对路径、完整检查说明。
    expect(l0).toContain(`${jobDir}/证据/第1条-1.png`);
    expect(l0).toContain('中心检查：文件存在，1.0 KB');
    // 第一级：开头一行说明；路径相对；检查结果正常的不写说明，没有检查过的（测试类）仍写。
    expect(l1.split('\n')[0]).toBe(`下面的路径都相对于主题文件夹 ${jobDir}`);
    expect(l1).toContain('证据 ev11：文件 证据/第1条-1.png ');
    expect(l1).not.toContain(`${jobDir}/证据`);
    expect(l1).not.toContain('中心检查：文件存在');
    expect(l1).toContain('中心检查：中心不执行命令，由核对人复跑');
    expect(l1).toContain('约定全文：约定.md');
    // 第二级：证据说明截到 40 字加「…」；条目原文还是完整的。
    expect(l2).toContain(`第1条的证据1${'证'.repeat(33)}…`);
    expect(l2).not.toContain(`第1条的证据1${'证'.repeat(34)}`);
    expect(l1).toContain(`第1条的证据1${'证'.repeat(114)}`);
    expect(l2).toContain(done[0]!);
    expect(l2).not.toContain('条目全文见约定文件');
    // 第三级：条目原文截到 60 字，清单后写条目全文在哪里。
    expect(l3).toContain(`1. ${[...done[0]!].slice(0, 60).join('')}…`);
    expect(l3).not.toContain(done[0]!);
    expect(l3).toContain(`条目全文见约定文件 ${jobDir}/约定.md`);
    // 每一级：序号、证据编号与路径、末尾做法说明都在，也不出现整条删掉的写法。
    for (const text of [l0, l1, l2, l3]) {
      expect((text.match(/^\d+\. /gm) ?? []).length).toBe(5);
      for (let no = 1; no <= 5; no += 1) for (const k of [1, 2, 3, 4]) expect(text).toContain(`证据 ev${no}${k}：`);
      for (let no = 1; no <= 5; no += 1) for (const k of [1, 3]) expect(text).toContain(`第${no}条-${k}.png`);
      for (const line of REVIEWER_TAIL) expect(text).toContain(line);
      expect(text).not.toMatch(/其余 \d+ 条见约定文件/);
    }
    void fix;
  });

  it('只有条目原文真的被截短时才写「条目全文见约定文件」：条目本来就不超过 60 字时，第三级不写这一行', async () => {
    const ctxt = await reviewing({ items: 5, evidence: 4, itemChars: 40, summaryChars: 120, commandChars: 100 });
    const levels = [await bodyOf(ctxt.fix, ctxt.fix.reviewer.id, 1_000_000)];
    for (let i = 1; i <= 3; i += 1) levels.push(await bodyOf(ctxt.fix, ctxt.fix.reviewer.id, byteLength(levels[i - 1]!.text) - 1));
    // 第三级与第二级的差别只是条目没有可截的，输出相同，所以直接落在第四级（仍然不写这一行）。
    expect(levels.map(row => row.level)).toEqual([0, 1, 2, 4]);
    for (const row of levels) expect(row.text).not.toContain('条目全文见约定文件');
  });

  it('执行者：第一级路径改相对，第三级条目截到 60 字并写条目全文在哪里，第四级待改条目的问题和标准各截到 120 字、回答截到 600 字；序号、条数、做法说明都在', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await runningJob(fix);
    setDoneWhen(fix, agreementId, doneList(5, 100));
    const unmet = [1, 2, 3].map(no => ({ no, problem: `问题${no}${'错'.repeat(190)}`, fixTo: `标准${no}${'改'.repeat(190)}` }));
    fix.ctx.store.table('jobs').put({ ...theJob(fix), state: 'rework' as const, round: 1, unmet });
    // 总管的一条很长的回答（事件附带内容上限 2 KB 之内，约 660 字，比第四级的 600 字长），作为这次唤醒的证据。
    const long = `回答${'详'.repeat(658)}`;
    const answered = appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'answered', to: [fix.engineer.id], refId: null, data: { text: long } });
    const entry = enqueueJobWake(fix.ctx, { job: theJob(fix), botId: fix.engineer.id, why: 'answered', eventId: answered.id, summary: '总管回答了你' })!;
    expect(entry).not.toBeNull();
    const levels = [await bodyOf(fix, fix.engineer.id, 1_000_000, entry)];
    for (let i = 1; i <= 3; i += 1) levels.push(await bodyOf(fix, fix.engineer.id, byteLength(levels[i - 1]!.text) - 1, entry));
    // 执行者的段里没有证据，第二级（缩证据说明）与第一级输出相同，逐级取时直接落到第三级。
    expect(levels.map(row => row.level)).toEqual([0, 1, 3, 4]);
    const jobDir = `/hub/projects/${theJob(fix).projectId}/${theJob(fix).folder}`;
    const [l0, l1, l3, l4] = levels.map(row => row.text) as [string, string, string, string];
    expect(l0).toContain(`约定 ${jobDir}/约定.md`);
    expect(l1.split('\n')[0]).toBe(`下面的路径都相对于主题文件夹 ${jobDir}`);
    expect(l1).toContain('约定 约定.md；主人原话 原话.md；草图 草图.md');
    expect(l3).toContain(`1. ${[...doneList(5, 100)[0]!].slice(0, 60).join('')}…`);
    expect(l3).toContain(`条目全文见约定文件 ${jobDir}/约定.md`);
    // 第三级之前待改条目和回答都是完整的；第四级才截。
    expect(l3).toContain(`问题1${'错'.repeat(190)}`);
    expect(l3).toContain(`回答${'详'.repeat(658)}`);
    expect(l4).toContain(`问题1${'错'.repeat(117)}…`);
    expect(l4).not.toContain('错'.repeat(118));
    expect(l4).toContain(`标准1${'改'.repeat(117)}…`);
    expect(l4).toContain(`回答${'详'.repeat(598)}（回答较长，后面的部分放不下）`);
    expect(l4).not.toContain('详'.repeat(599));
    for (const text of levels.map(row => row.text)) {
      expect((text.match(/^\d+\. /gm) ?? []).length).toBe(5);
      expect((text.match(/第 \d+ 条：问题：/g) ?? []).length).toBe(3);
      for (const line of EXECUTOR_TAIL) expect(text).toContain(line);
      expect(text).not.toMatch(/其余 \d+ 条见约定文件/);
    }
  });
});

describe('5 按参数上限构造最大的一件事', () => {
  it('核对人：5 条、每条 4 项证据（说明和命令都取上限）：不超过上限或落在第四级；序号、证据编号与路径、做法说明都在', async () => {
    const { fix, done } = await reviewing({ items: D.EVIDENCE_PER_ITEM_MAX > 0 ? 5 : 5, evidence: D.EVIDENCE_PER_ITEM_MAX, itemChars: 100, summaryChars: D.EVIDENCE_SUMMARY_MAX_CHARS, commandChars: D.EVIDENCE_COMMAND_MAX_CHARS });
    const result = await bodyOf(fix, fix.reviewer.id);
    console.info(`核对人最大一件事：${byteLength(result.text)} 字节，第 ${result.level} 级`);
    expect(byteLength(result.text) <= D.PACKET_MAX_BYTES || result.level === 4).toBe(true);
    expect((result.text.match(/^\d+\. /gm) ?? []).length).toBe(done.length);
    for (let no = 1; no <= 5; no += 1) {
      for (const k of [1, 2, 3, 4]) expect(result.text).toContain(`证据 ev${no}${k}：`);
      for (const k of [1, 3]) expect(result.text).toContain(`第${no}条-${k}.png`);
    }
    for (const line of REVIEWER_TAIL) expect(result.text).toContain(line);
  });

  it('执行者：5 条（每条 100 字）、5 条待改（问题和标准各 200 字）、500 字回答、10 份材料：不超过上限或落在第四级；序号、做法说明都在', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await runningJob(fix);
    setDoneWhen(fix, agreementId, doneList(5, 100));
    const unmet = [1, 2, 3, 4, 5].map(no => ({ no, problem: `问题${no}${'错'.repeat(D.NOTE_MAX_CHARS - 4)}`, fixTo: `标准${no}${'改'.repeat(D.NOTE_MAX_CHARS - 4)}` }));
    fix.ctx.store.table('jobs').put({ ...theJob(fix), state: 'rework' as const, round: 1, unmet });
    const long = `回答${'详'.repeat(D.ANSWER_MAX_CHARS)}依据：约定「我已定的」第 1 条（${'甲'.repeat(40)}）。\n这一点不改约定，不需要问主人。`;
    const answered = appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'answered', to: [fix.engineer.id], refId: null, data: { text: long } });
    const entry = enqueueJobWake(fix.ctx, { job: theJob(fix), botId: fix.engineer.id, why: 'answered', eventId: answered.id, summary: '总管回答了你' })!;
    const jobDir = `/hub/projects/${job.projectId}/${job.folder}`;
    for (let i = 1; i <= 10; i += 1) await fix.ctx.fs.writeTextAtomic(`${jobDir}/材料/${'长'.repeat(15)}${i}.md`, '原文');
    const result = await bodyOf(fix, fix.engineer.id, undefined, entry);
    console.info(`执行者最大一件事：${byteLength(result.text)} 字节，第 ${result.level} 级`);
    expect(byteLength(result.text) <= D.PACKET_MAX_BYTES || result.level === 4).toBe(true);
    expect((result.text.match(/^\d+\. /gm) ?? []).length).toBe(5);
    expect((result.text.match(/第 \d+ 条：问题：/g) ?? []).length).toBe(5);
    for (const line of EXECUTOR_TAIL) expect(result.text).toContain(line);
    expect(result.text).toContain('另有 2 份，见材料文件夹');
  });

  it('总管：约定各部分都取上限（一句话 120 字、待你定 5 项、我已定的 8 条、这次做和不做各 6 条、怎样算做完 5 条）、执行者做不下去：不超过上限或落在第四级；每部分的序号和「回答」的做法说明都在', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await runningJob(fix);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const version = agreement.versions.find(row => row.state === 'locked')!;
    const pending = Array.from({ length: 5 }, (_, i) => ({ ...version.content.pending[0]!, key: `p${i + 1}`, question: `问题${i + 1}${'问'.repeat(50)}`, chosen: `选${'项'.repeat(25)}` }));
    fix.ctx.store.table('agreements').put({ ...agreement, versions: agreement.versions.map(row => row.no !== version.no ? row : { ...row, content: {
      ...row.content, summary: '概'.repeat(120), pending,
      decided: Array.from({ length: 8 }, (_, i) => ({ text: `${i}${'定'.repeat(99)}`, basis: { kind: 'judgement' as const, ref: null, refText: null } })),
      scopeIn: Array.from({ length: 6 }, (_, i) => `做${i}${'内'.repeat(57)}`), scopeOut: Array.from({ length: 6 }, (_, i) => `不${i}${'外'.repeat(57)}`),
      doneWhen: doneList(5, 100) } }) });
    fix.ctx.store.table('jobs').put(applyJobAction(theJob(fix), { type: 'block', kind: 'executor', no: null, text: '缺少价格表' }, fix.ctx.clock.now()));
    const result = await bodyOf(fix, fix.chief.id);
    console.info(`总管最大一件事：${byteLength(result.text)} 字节，第 ${result.level} 级`);
    expect(byteLength(result.text) <= D.PACKET_MAX_BYTES || result.level === 4).toBe(true);
    for (const [section, count] of [['summary', 1], ['pending', 5], ['decided', 8], ['scopeIn', 6], ['scopeOut', 6], ['doneWhen', 5]] as const) {
      for (let no = 1; no <= count; no += 1) expect(result.text).toContain(`${section} ${no}. `);
    }
    expect(result.text).toContain(`回答：调用 hub_job_manage，mode 写 answer，jobId 写 ${job.id}`);
    expect(result.text).not.toMatch(/其余 \d+ 条见约定文件/);
  });

  it('总管：放不下时第三级把约定各部分的原文截到 60 字并写「条目全文见约定文件」，序号一个不少', async () => {
    const fix = await jobFix();
    const { agreementId } = await runningJob(fix);
    setDoneWhen(fix, agreementId, doneList(5, 100));
    fix.ctx.store.table('jobs').put(applyJobAction(theJob(fix), { type: 'block', kind: 'executor', no: null, text: '缺少价格表' }, fix.ctx.clock.now()));
    const full = await bodyOf(fix, fix.chief.id, 1_000_000);
    expect(full.level).toBe(0);
    const tight = await bodyOf(fix, fix.chief.id, byteLength(full.text) - 1);
    expect(tight.level).toBe(3);
    expect(tight.text).toContain(`doneWhen 1. ${[...doneList(5, 100)[0]!].slice(0, 60).join('')}…`);
    expect(tight.text).toMatch(/条目全文见约定文件 \S+\/约定\.md/);
    for (let no = 1; no <= 5; no += 1) expect(tight.text).toContain(`doneWhen ${no}. `);
    expect(tight.text).toContain('回答：调用 hub_job_manage，mode 写 answer');
  });
});

describe('6 四级之后仍超过上限', () => {
  it('记一条错误日志，按第四级的结果输出（允许超过上限），不整段截断；末尾做法说明和序号仍在', async () => {
    const { fix, done } = await reviewing({ items: 5, evidence: 4, itemChars: 100, summaryChars: 120, commandChars: 100 });
    const error = vi.spyOn(fix.ctx.logger, 'error');
    const result = await bodyOf(fix, fix.reviewer.id, 100);
    expect(result.overflow).toBe(true);
    expect(result.level).toBe(4);
    expect(byteLength(result.text)).toBeGreaterThan(100);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('第四级仍超过上限');
    expect(result.text).not.toContain('已截断');
    expect((result.text.match(/^\d+\. /gm) ?? []).length).toBe(done.length);
    for (const line of REVIEWER_TAIL) expect(result.text).toContain(line);
    // 与「刚好放不下第三级」时按第四级输出的内容相同（第四级就是核对人段压缩的终点）。
    const tight = await bodyOf(fix, fix.reviewer.id, 99);
    expect(tight.text).toBe(result.text);
  });

  it('反例：放得下时不记日志', async () => {
    const { fix } = await reviewing({ items: 3, evidence: 2 });
    const error = vi.spyOn(fix.ctx.logger, 'error');
    const result = await bodyOf(fix, fix.reviewer.id);
    expect(result.overflow).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
});
