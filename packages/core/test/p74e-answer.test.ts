/**
 * P74e 的测试（一）：总管按约定回答（answer）和转交材料（forward）。
 * 全部走真实的 Hub（真实的启动整理和显著性数值），时间用注入的假时钟，文件放在内存文件系统里；不用人为调高分值的候选。
 *
 * 其中三条是「只用唤醒包里给出的文字就能调用成功」：从唤醒包文本里用正则取出编号、名字、序号，再去调用工具，必须成功。
 * 另有「约定出处由中心附上」的正反例：引用不存在的条目被拒并列出可引用的条目；模型自己写的「依据」不影响中心拼的依据。
 */
import { describe, expect, it } from 'vitest';
import { availableBasisText, basisProblems, composeAnswer, joinCitations, stripSelfWrittenBasis } from '../src/job/answer-basis.js';
import { NOBODY_ASKING_TEXT } from '../src/job/answer.js';
import { contentFixture } from './p72a-agreement-fixtures.js';
import {
  INTERNAL, bot, callTool, entriesOf, eventsOf, lastPacket, nextPacket, sectionOf, started, theJob, threadOf, writeSnapshot, type JobFix,
} from './p74d-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { ownerSays, speak } from './p74b-fixtures.js';

/** 林舟向总管提一个问题，结束回合；总管拿到回合，返回总管的唤醒包。 */
async function engineerAsksChief(fix: JobFix, jobId: string, text = '报价要不要含税？'): Promise<string> {
  const asked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId, text });
  expect(asked, JSON.stringify(asked)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
  return nextPacket(fix, fix.chief.id);
}

/** 从总管的唤醒包里只用正则取到的值。 */
function chiefSeen(packet: string) {
  const text = sectionOf(packet);
  const instruction = /回答：调用 hub_job_manage，mode 写 answer，jobId 写 (job_[0-9a-z]{10})，to 写(.+?)，text 写答案，basis 写出处/.exec(text);
  expect(instruction, '总管的唤醒包里应该有「回答」的调用说明').not.toBeNull();
  // 约定各部分的序号：「decided 1. 原文」「doneWhen 2. 原文」。
  const numbered = [...text.matchAll(/^(summary|pending|decided|scopeIn|scopeOut|doneWhen) (\d+)\. (.+)$/gm)]
    .map(match => ({ section: match[1]!, no: Number(match[2]), text: match[3]! }));
  return { jobId: instruction![1]!, to: instruction![2]!, numbered };
}

/** 给总管看的序号表里取某一条。 */
function pick(seen: ReturnType<typeof chiefSeen>, section: string, no: number) {
  const row = seen.numbered.find(item => item.section === section && item.no === no);
  expect(row, `唤醒包里应该有 ${section} ${no}`).toBeDefined();
  return row!;
}

describe('只用唤醒包里的文字调用成功（回答、转交）', () => {
  it('1 林舟 ask 之后，总管执行链唤醒包里只用正则取 jobId、提问人名字、「decided 1」「doneWhen 2」的序号，调用 answer 成功；依据由中心从约定读出，与约定原文一致；林舟被叫醒且唤醒包里有「总管刚回答你」', async () => {
    const { fix, job, info } = await started();
    const packet = await engineerAsksChief(fix, info.jobId);
    const seen = chiefSeen(packet);
    expect(seen).toMatchObject({ jobId: job.id, to: '林舟' });
    expect(sectionOf(packet)).toContain('林舟问你：报价要不要含税？');
    const decided = pick(seen, 'decided', 1);
    const doneWhen = pick(seen, 'doneWhen', 2);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'answer', jobId: seen.jobId, to: seen.to, text: '不含税，页面上写明「价格均为税前」。',
      basis: [{ section: 'decided', no: 1 }, { section: 'doneWhen', no: 2 }],
    });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已回答林舟。' });
    // 依据由中心从约定读出：与唤醒包里列的约定原文一致，部分名是中文名。
    const expected = `不含税，页面上写明「价格均为税前」。\n依据：约定「我已定的」第 1 条（${decided.text}）和约定「怎样算做完」第 2 条（${doneWhen.text}）。\n这一点不改约定，不需要问主人。`;
    const event = eventsOf(fix.ctx, job.id).find(row => row.kind === 'answered')!;
    expect(event).toMatchObject({ actor: fix.chief.id, to: [fix.engineer.id],
      data: { text: expected, basis: [{ section: 'decided', no: 1 }, { section: 'doneWhen', no: 2 }] } });
    // 提问清掉，状态不变，林舟入队。
    expect(theJob(fix)).toMatchObject({ state: 'doing', openAsk: null });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    // 林舟真的被叫醒，唤醒包里有总管的回答（依据只出现一次）。
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已回答' });
    const engineerPacket = await nextPacket(fix, fix.engineer.id);
    const text = sectionOf(engineerPacket);
    expect(text).toContain(`总管刚回答你：${expected}`);
    expect(text.split('依据：').length - 1).toBe(1);
  });

  it('2 主人在私聊发一段文案，总管主人发起的唤醒包里只用正则取 jobId，先 forward 成功：材料存为主题文件，林舟被叫醒且唤醒包里有文件路径', async () => {
    const { fix, job, info } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做页面骨架' });
    await ownerSays(fix, fix.chief.id, '这是活动文案：报名限 100 人，截止本周日。');
    const packet = lastPacket(fix, bot(fix, fix.chief.id));
    const jobId = /（jobId 为 (job_[0-9a-z]{10})）/.exec(sectionOf(packet))?.[1];
    expect(jobId).toBe(job.id);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'forward', jobId, title: '活动文案', text: '报名限 100 人，截止本周日。\n奖品：三份周边。',
    });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已存为主题文件「活动文案」，交给林舟。' });
    // 文件在主题文件夹的「材料」里，内容是原文；事件、往来、私聊提示都在。
    const file = `${info.jobDir}/材料/活动文案.md`;
    expect(await fix.ctx.fs.readText(file)).toBe('报名限 100 人，截止本周日。\n奖品：三份周边。\n');
    expect(eventsOf(fix.ctx, job.id).find(row => row.kind === 'forwarded')).toMatchObject({ actor: fix.chief.id, to: [fix.engineer.id], data: { file: '材料/活动文案.md', title: '活动文案' } });
    expect(threadOf(fix.ctx, job.topicId).at(-1)).toMatchObject({ from: 'hub', kind: 'work', text: '总管把你的「活动文案」存为主题文件，交给了林舟。' });
    expect(threadOf(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: 'hub', kind: 'system', text: '活动文案已存为主题文件「活动文案」，交给林舟。' });
    // 林舟被叫醒，唤醒包里有这份材料的绝对路径。
    await speak(fix, bot(fix, fix.chief.id), '已把文案交给林舟。', { outcome: 'progress' });
    const engineerPacket = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(engineerPacket)).toContain(`总管刚转来材料：${file}`);
    // P74r2d 第 2 点：材料只写一次文件夹的绝对路径，后面列文件名（原来：「；材料：」加每份的绝对路径）。
    expect(sectionOf(engineerPacket)).toContain(`；材料文件夹 ${file.replace(/\/活动文案\.md$/, '')}：活动文案.md`);
  });
});

describe('answer：约定出处由中心附上', () => {
  it('4a 没有人在问时 answer 被拒，零写入', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '进展如何？');
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '随便', basis: [{ section: 'summary', no: 1 }] });
    expect(result).toEqual({ ok: false, error: NOBODY_ASKING_TEXT });
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });

  it('4b 反例：引用不存在的条目被拒，报错写明那部分有几条并列出可引用的条目；没有写入；约定里有的条目照常成功（正例）', async () => {
    const { fix, job, info } = await started();
    await engineerAsksChief(fix, info.jobId);
    const before = writeSnapshot(fix, job.id);
    const bad = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'answer', jobId: job.id, text: '含税', basis: [{ section: 'decided', no: 1 }, { section: 'decided', no: 4 }, { section: 'summary', no: 2 }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('basis[1]：约定「我已定的」只有 1 条');
    expect(bad.error).toContain('basis[2]：约定「一句话」只有 1 条');
    expect(bad.error).not.toContain('basis[0]');
    const badPending = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '含税', basis: [{ section: 'pending', no: 3 }] });
    expect(badPending.error).toContain('basis[0]：约定「待你定」只有 2 条');
    expect(bad.error).toContain('可引用的出处：summary（一句话）1 条、pending（待你定）2 条、decided（我已定的）1 条、scopeIn（这次做）2 条、scopeOut（这次不做）1 条、doneWhen（怎样算做完）3 条');
    expect(bad.error).toContain('不能编出处');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    expect(theJob(fix).openAsk).not.toBeNull();
    // 正例：改成真实存在的条目就成功。
    const good = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '含税', basis: [{ section: 'decided', no: 1 }] });
    expect(good).toMatchObject({ ok: true });
  });

  it('4c 反例：写错部分名、出处条数为 0 或超过 3 处，被工具参数校验拒绝', async () => {
    const { fix, job, info } = await started();
    await engineerAsksChief(fix, info.jobId);
    for (const basis of [[], [{ section: 'rules', no: 1 }], [{ section: 'decided', no: 0 }],
      [{ section: 'decided', no: 1 }, { section: 'doneWhen', no: 1 }, { section: 'doneWhen', no: 2 }, { section: 'doneWhen', no: 3 }]]) {
      const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '答', basis });
      expect(result.ok, JSON.stringify(basis)).toBe(false);
    }
    expect(theJob(fix).openAsk).not.toBeNull();
  });

  it('4d 模型在 text 里自己写的「依据：……」不影响中心拼的依据：依据只出现一次，来自约定；只剩依据没有答案时被拒', async () => {
    const { fix, job, info } = await started();
    await engineerAsksChief(fix, info.jobId);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'answer', jobId: job.id, text: '不含税。（依据：约定我已定的第 9 条，随便写的）\n依据：编造的规矩 ru_0000000000', basis: [{ section: 'doneWhen', no: 3 }],
    });
    expect(result).toMatchObject({ ok: true });
    const event = eventsOf(fix.ctx, job.id).find(row => row.kind === 'answered')!;
    const text = event.data.text as string;
    expect(text).toBe('不含税。\n依据：约定「怎样算做完」第 3 条（接口失败时有提示）。\n这一点不改约定，不需要问主人。');
    expect(text.split('依据：').length - 1).toBe(1);
    expect(text).not.toContain('编造');
    // 单独的纯函数：只剩依据时没有答案，返回 null（工具据此拒绝）。
    expect(composeAnswer(contentFixture(), '依据：约定第 1 条', [{ section: 'summary', no: 1 }])).toBeNull();
  });

  it('4e 执行者做不下去（受阻）时，回答之后状态恢复到受阻前，林舟被叫醒', async () => {
    const { fix, job, info } = await started();
    const blocked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: info.jobId, stuckAt: '不知道要不要含税', tried: ['翻了约定'] });
    expect(blocked).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '不知道要不要含税', summary: '做不下去' });
    const packet = await nextPacket(fix, fix.chief.id);
    const seen = chiefSeen(packet);
    expect(seen).toMatchObject({ jobId: job.id, to: '林舟' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor' } });
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: seen.jobId, to: seen.to, text: '不含税', basis: [{ section: 'scopeIn', no: 1 }] });
    expect(result).toEqual({ ok: true, text: '已回答林舟。' });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, openAsk: null });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });

  it('4f 收件人写错（不是提问的人）被拒；核对人提的问题也能回答，叫醒核对人', async () => {
    const { fix, job, info } = await started();
    await engineerAsksChief(fix, info.jobId);
    const wrong = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, to: '评审甲', text: '答', basis: [{ section: 'summary', no: 1 }] });
    expect(wrong).toEqual({ ok: false, error: 'to：现在在等你回答的是林舟' });
    // 另一件事里，核对人评审甲提问。
    const second = await started();
    await second.fix.ctx.store.table('jobs').patch(second.job.id, { state: 'checking', round: 1 });
    const asked = await callTool(second.fix, bot(second.fix, second.fix.reviewer.id), 'hub_job_work', { mode: 'ask', jobId: second.job.id, text: '核对时要不要看手机端？' });
    expect(asked).toMatchObject({ ok: true });
    const answered = await callTool(second.fix, second.fix.chief, 'hub_job_manage', { mode: 'answer', jobId: second.job.id, text: '不用，约定只做网页', basis: [{ section: 'decided', no: 1 }] });
    expect(answered).toEqual({ ok: true, text: '已回答评审甲。' });
    expect(entriesOf(second.fix, second.fix.reviewer.id, second.job.id)).toHaveLength(1);
    expect(theJob(second.fix)).toMatchObject({ state: 'checking', openAsk: null });
  });

  it('5 回答写进事件，工作往来两条（回答全文、中心提示），给主人看的文字不含 hub_、job_、agr_', async () => {
    const { fix, job, info } = await started();
    await engineerAsksChief(fix, info.jobId);
    await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '不含税。', basis: [{ section: 'scopeOut', no: 1 }] });
    const event = eventsOf(fix.ctx, job.id).find(row => row.kind === 'answered')!;
    const topic = threadOf(fix.ctx, job.topicId);
    const work = topic.filter(row => row.kind === 'work' && row.refId === event.id);
    expect(work).toHaveLength(2);
    expect(work[0]).toMatchObject({ from: fix.chief.id, text: event.data.text });
    expect(work[1]).toMatchObject({ from: 'hub', text: '总管按约定答复了林舟 1 个问题，不需要你处理。' });
    for (const row of work) expect(row.text).not.toMatch(INTERNAL);
    expect(work[0]!.text).toContain('约定「这次不做」第 1 条（历史曲线）');
  });

  it('非总管调用 answer 被拒', async () => {
    const { fix, job, info } = await started();
    await engineerAsksChief(fix, info.jobId);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '答', basis: [{ section: 'summary', no: 1 }] });
    expect(result).toEqual({ ok: false, error: '只有总管能回答问题' });
  });

  it('字段放错 mode 被拒：answer 里写了 reason、executor', async () => {
    const { fix, job, info } = await started();
    await engineerAsksChief(fix, info.jobId);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '答', basis: [{ section: 'summary', no: 1 }], reason: '原因', executor: '林舟' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('mode 为 answer 时不用这些字段：reason、executor');
  });

  it('回答时林舟已停用：回答被拒并恢复（提问仍在）', async () => {
    const { fix, job, info } = await started();
    await engineerAsksChief(fix, info.jobId);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    const before = writeSnapshot(fix, job.id);
    // P74r2d 第 3 条：「一句话」不能再作为唯一出处，这一条原来用 summary 1，改用「我已定的」第 1 条，被测的仍是「叫不醒收件人时回答整体恢复」。
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '答', basis: [{ section: 'decided', no: 1 }] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('回答失败，已恢复到回答前的状态');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    expect(theJob(fix).openAsk).not.toBeNull();
  });
});

describe('answer-basis 纯函数', () => {
  it('出处句：一条、两条用「和」、三条前两条用顿号；原文超过 40 字截断加省略号', () => {
    const content = { ...contentFixture(), decided: [{ text: '甲'.repeat(45), basis: { kind: 'judgement' as const, ref: null, refText: null } }] };
    expect(composeAnswer(content, '好', [{ section: 'decided', no: 1 }])).toBe(`好\n依据：约定「我已定的」第 1 条（${'甲'.repeat(40)}…）。\n这一点不改约定，不需要问主人。`);
    expect(joinCitations(['甲', '乙'])).toBe('甲和乙');
    expect(joinCitations(['甲', '乙', '丙'])).toBe('甲、乙和丙');
    // 待你定写「{问题}：{主人定下的选项}」。
    const chosen = { ...contentFixture() };
    chosen.pending = chosen.pending.map(item => ({ ...item, chosen: item.options[1]! }));
    expect(composeAnswer(chosen, '好', [{ section: 'pending', no: 1 }])).toContain('约定「待你定」第 1 条（报价从哪里取：手工表格）');
  });

  it('越界一次列全；summary 只有第 1 条；去掉模型自己写的依据', () => {
    const content = contentFixture();
    expect(basisProblems(content, [{ section: 'summary', no: 1 }, { section: 'scopeIn', no: 3 }])).toBe('basis[1]：约定「这次做」只有 2 条');
    expect(basisProblems(content, [{ section: 'doneWhen', no: 3 }])).toBeNull();
    expect(availableBasisText(content)).toContain('doneWhen（怎样算做完）3 条');
    expect(stripSelfWrittenBasis('先这样。\n（依据：编的）\n再说一句（依据：也是编的）')).toBe('先这样。\n再说一句');
    expect(stripSelfWrittenBasis('照做。这一点不改约定，不需要问主人。')).toBe('照做。');
  });
});

describe('forward', () => {
  it('同名材料加 -2、-3；标题含路径写法被拒；非主人发起的回合被拒；已完成的事被拒', async () => {
    const { fix, job, info } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '再给一份文案');
    const forward = (title: string, text = '内容') => callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: job.id, title, text });
    expect(await forward('文案 A')).toMatchObject({ ok: true });
    // 林舟被叫醒后合并了候选，再叫一次也能入队（同一员工同一件事）。
    expect(await forward('文案 A')).toMatchObject({ ok: true });
    expect(await forward('文案 A')).toMatchObject({ ok: true });
    expect(await fix.ctx.fs.list(`${info.jobDir}/材料`)).toEqual(expect.arrayContaining(['文案 A.md', '文案 A-2.md', '文案 A-3.md']));
    for (const title of ['../偷', 'a/b', '文案.md', '文案\\x', '点.点']) {
      const result = await forward(title);
      expect(result.ok, title).toBe(false);
      expect(result.error).toContain('title：只能写汉字、字母、数字、空格、连字符、下划线');
    }
    expect(await fix.ctx.fs.list(`${info.jobDir}/材料`)).toHaveLength(3);
    // 已完成的事不能再转交。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'done' });
    expect(await forward('文案 B')).toEqual({ ok: false, error: '这件事已完成，不能再转交材料' });
  });

  it('非主人发起的回合（总管被执行链唤醒）调用 forward 被拒；零写入', async () => {
    const { fix, job, info } = await started();
    await engineerAsksChief(fix, info.jobId);
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: job.id, title: '文案', text: '内容' });
    expect(result).toEqual({ ok: false, error: '转交材料只能在主人发话、确认或回答叫醒的回合里进行（材料来自主人）' });
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    expect(await fix.ctx.fs.list(`${info.jobDir}/材料`)).toEqual([]);
  });

  it('执行者此刻不在岗：转交被拒，文件被删除（没有残留）', async () => {
    const { fix, job, info } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '再给一份文案');
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: job.id, title: '文案', text: '内容' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('转交失败，已恢复到转交前的状态');
    // 林舟已停用，调度会把他排着的候选清掉，所以队列不比较；其余（这件事、事件、往来、感知）一概不变。
    expect({ ...writeSnapshot(fix, job.id), queues: null }).toEqual({ ...before, queues: null });
    expect(await fix.ctx.fs.list(`${info.jobDir}/材料`)).toEqual([]);
  });
});
