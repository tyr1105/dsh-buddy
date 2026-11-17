/**
 * P74r15 第 3 至 8 节的测试：
 * 3 句号和问号：说明已经以句号结尾时不再接句号；问题末尾连续多个问号全部去掉；
 * 4 「写了时间」的判断：卡里给的两组写法逐条；约定出新版本时，文字没有变的「交付时核对」条目保持；
 * 5 「主人」的检查不误伤「宠物主人」「主人公」这类词，单独的「主人」照旧被拒（文字逐字）；
 * 6 参数名名单只留 fixTo、carriedNote、spotChecked，区分大小写；
 * 7 主人确认去掉对外发布时，发布已经在执行、或已经完成：主题里落一句固定句（逐字）；
 * 8 总管回答提问的回合被中心结束：往来、唤醒摘要、唤醒包里写的是总管的回合。
 */
import { describe, expect, it } from 'vitest';
import { remapItems, mapDeliveryItems } from '../src/job/item-remap.js';
import { mentionsOwnerWord, ownerTextProblem, ownerWordRefusal, paramNameProblem } from '../src/job/owner-text.js';
import { hasTimeMention } from '../src/job/time-mention.js';
import { ownerWordProblems } from '../src/project/agreement-content.js';
import { joinQuestion, stripQuestionMark } from '../src/util/question-join.js';
import { closeSentence } from '../src/util/sentence.js';
import { ownerSays, speak } from './p74b-fixtures.js';
import { commitAndEnd, runningOf, wakesOf } from './p74c-fixtures.js';
import { MINUTE, bot, callTool, nextPacket, sectionOf, started, theJob, threadOf, tick, type JobFix } from './p74d-fixtures.js';
import { acceptedWithLaunch, jobIdIn, submitLaunch } from './p74g-launch-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';

// ---------------------------------------------------------------------------
// 3 句号和问号
// ---------------------------------------------------------------------------

describe('3 句号和问号', () => {
  it('closeSentence：已经以句号、问号、叹号（全角、半角）结尾的不再加句号，否则补一个', () => {
    for (const text of ['缺接口文档。', '能不能放宽？', '不行！', 'done.', 'why?', 'stop!']) expect(closeSentence(text), text).toBe(text);
    expect(closeSentence('缺接口文档')).toBe('缺接口文档。');
    expect(closeSentence('缺接口文档。  ')).toBe('缺接口文档。');
    expect(closeSentence('缺接口文档  ')).toBe('缺接口文档。');
    expect(closeSentence('')).toBe('');
  });

  it('执行者说明做不下去、原因以句号结尾：工作往来和总管唤醒包里没有「。。」', async () => {
    const { fix, job } = await started();
    const blocked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺报价接口的文档。', tried: ['查了仓库。'] });
    expect(blocked, JSON.stringify(blocked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺报价接口的文档。', summary: '做不下去' });
    const works = threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' && row.kind === 'work').map(row => row.text);
    expect(works.at(-1)).toBe('林舟无法继续：缺报价接口的文档。已告诉总管。');
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    // 原因和「试过」都以句号结尾：拼起来只有一个句号。
    expect(text).toContain('林舟做不下去：缺报价接口的文档；试过：查了仓库。\n');
    expect(text).not.toContain('。。');
  });

  it('反例：原因没有句号时，往来里补一个句号', async () => {
    const { fix, job } = await started();
    const blocked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] });
    expect(blocked, JSON.stringify(blocked)).toMatchObject({ ok: true });
    const works = threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' && row.kind === 'work').map(row => row.text);
    expect(works.at(-1)).toBe('林舟无法继续：缺报价接口的文档。已告诉总管。');
  });

  it('问题末尾连续多个问号（全角、半角混用）全部去掉', () => {
    for (const question of ['是否限制报名人数？？', '是否限制报名人数??', '是否限制报名人数?？', '是否限制报名人数？?？', '是否限制报名人数？ ？']) {
      expect(joinQuestion(question, '限 80 人'), question).toBe('是否限制报名人数：限 80 人');
    }
    expect(joinQuestion('是否限制报名人数？', '限 80 人')).toBe('是否限制报名人数：限 80 人');
    // 反例：中间的问号保留，没有问号的不变。
    expect(stripQuestionMark('先问一下？再说')).toBe('先问一下？再说');
    expect(joinQuestion('报名人数上限', '80 人')).toBe('报名人数上限：80 人');
  });
});

// ---------------------------------------------------------------------------
// 4 「写了时间」的判断
// ---------------------------------------------------------------------------

describe('4 「写了时间」的判断', () => {
  it.each([
    '17 号交付', '17 号前', '截止 17 号', '到 17 号', '17 日下班前', '17 日交', '18 点交', '18 点前', '下午 6 点', '周五下班前', '月底前', '明天上午',
    '下周三前', '11 月 17 日 18:00 前',
    // P74r13 记录里已有的正例，全部仍算。
    '17号之前给我', '5 日前交付', '3 号上午交付', '11 月 5 日交付', '下午 3 点交付', '晚上八点之前给我', '18 点前交付', '3 点整', '3 点半前', '18 点 30 分交付',
    '11月17日前交付', '18:00 前交付', '3 天内给我', '周三前给我', '明天给我',
    // 复验里点名的几种。
    '17号交', '每天 18 点更新', '18点',
  ])('算写了时间：%s', text => {
    expect(hasTimeMention(text)).toBe(true);
  });

  it.each([
    '页面展示 7 日留存曲线', '文档列出 3 点注意事项', '首页轮播 5 号位换成新图', '按第 3 号文件格式导出', '文档写 2 点改进意见', '展示 7 日均值',
    // P74r13 记录里已有的反例，全部仍不算。
    '支持 12 月份的账单', '按 2 号文件格式导出', '文档列出三点注意事项', '十二月份的账单能导出', '说明里写明 5 点建议',
  ])('不算写了时间：%s', text => {
    expect(hasTimeMention(text)).toBe(false);
  });

  it('约定出新版本时，文字没有变的「交付时核对」条目保持，不因为判断规则变了被改掉；序号变了跟着换', () => {
    const prev = ['页面能打开', '17 号交付', '文档列出 3 点注意事项'];
    // 新版本在最前面插了一条：原来的三条序号都往后挪一位，文字都没变。
    const next = ['加一条新要求', '页面能打开', '17 号交付', '文档列出 3 点注意事项'];
    const remap = remapItems(prev, next);
    // 原来在交付时核对的是第 2、3 条（第 3 条的文字按现在的判断不算写了时间，但文字没变，也保持）。
    expect(mapDeliveryItems([2, 3], remap)).toEqual([3, 4]);
    // 反例：文字被改写的条目不再算（对不上新条目）。
    const rewritten = remapItems(prev, ['页面能打开', '18 号交付', '文档列出 3 点注意事项']);
    expect(mapDeliveryItems([2, 3], rewritten)).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// 5 「主人」的检查
// ---------------------------------------------------------------------------

describe('5 「主人」的检查不误伤别的词', () => {
  it.each([
    '宠物主人能在页面填写手机号', '女主人的称呼要显示', '男主人的头像可以不填', '房主人信息页', '屋主人的联系方式', '狗主人可以上传照片', '猫主人要选品种',
    '店主人能改营业时间', '车主人要填车牌', '原主人的名字保留', '新主人收到邀请', '旧主人的数据迁移', '失主人认领物品', '物主人确认归还',
    '主人公立绘 3 张', '主人翁精神的文案',
  ])('通过：%s', text => {
    expect(mentionsOwnerWord(text)).toBe(false);
    expect(ownerTextProblem('summary', text, { noOwnerWord: true })).toBeNull();
    expect(ownerWordProblems({ summary: text })).toEqual([]);
  });

  it('单独的「主人」照旧被拒，文字逐字（含后半句）', () => {
    const expected = 'summary：这句话是给主人看的，称呼写「你」，不写「主人」；如果这里说的不是你的主人，换一个不含这两个字的说法';
    expect(ownerWordRefusal('summary')).toBe(expected);
    for (const text of ['主人要看到报价', '请主人确认', '让主人选一个', '给主人看的摘要']) {
      expect(ownerTextProblem('summary', text, { noOwnerWord: true }), text).toBe(expected);
      expect(ownerWordProblems({ summary: text }), text).toEqual([expected]);
    }
    // 一句话里既有普通词又有称呼：照旧被拒。
    expect(ownerTextProblem('summary', '宠物主人的页面要让主人审核', { noOwnerWord: true })).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 6 参数名
// ---------------------------------------------------------------------------

describe('6 参数名名单只留三个', () => {
  it('含 rechecked、jobId（普通英文词和页面源码里的变量名）的句子通过', () => {
    for (const text of ['Rechecked the layout', '页面里 rechecked 状态要保存', 'const jobId = 1 没有被使用', '把 jobId 显示在页面上']) {
      expect(paramNameProblem('note', text), text).toBeNull();
    }
  });

  it('含 fixTo、carriedNote、spotChecked 的被拒；区分大小写（FIXTO 不拦）', () => {
    for (const name of ['fixTo', 'carriedNote', 'spotChecked']) {
      expect(paramNameProblem('note', `把提示按 ${name} 改`), name).toBe(`note：不要写参数名（${name}），用白话写`);
    }
    expect(paramNameProblem('note', '看 FIXTO：把提示改好')).toBeNull();
    // 边界：相邻英文字母、下划线的不算整词。
    expect(paramNameProblem('note', 'fixToday 的文案')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7 发布已经开始执行或已经完成时主人确认去掉对外发布
// ---------------------------------------------------------------------------

/** 主人说去掉发布、总管出新版本、主人确认第 2 版。 */
async function ownerRemovesLaunch(fix: JobFix, agreementId: string): Promise<void> {
  if (runningOf(fix, fix.chief.id)) await speak(fix, bot(fix, fix.chief.id), '好。', { outcome: 'progress' });
  await ownerSays(fix, fix.chief.id, '先不发布了');
  for (let i = 0; i < 6 && !runningOf(fix, fix.chief.id); i += 1) await tick(fix, 5 * MINUTE);
  const revised = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'revise', agreementId, changeNote: '去掉对外发布', launch: null });
  expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '去掉发布的这一版等你确认。', { outcome: 'needs_owner' });
  expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
}

describe('7 发布已经开始执行或已经完成时主人确认去掉对外发布', () => {
  it('发布正在执行（已批准、命令已开始）：不中止，主题里一句固定句，逐字', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    fix.ctx.exec.set('node', ['work/go-live.js'], { code: 0, stdout: '已上线', stderr: '', timedOut: false });
    // P74r18b 同步：命令运行完之后中心马上把结果记到这件事上（发布状态不再停在等批准），这里要测的是「命令已开始运行、还没有结果」，
    // 所以只记下批准的决定，再把批准票记为已使用（命令已开始运行）、出站记录保持就绪（运行中）。
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true });
    fix.ctx.store.table('approvals').patch(approval.id, { status: 'used', usedAt: fix.ctx.clock.now() });
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('used');
    await ownerRemovesLaunch(fix, job.agreementId);
    // 发布状态不动（仍是等批准，命令已经在执行）。
    expect(theJob(fix).launch).toMatchObject({ state: 'approval', approvalId: approval.id });
    const topic = threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' && row.kind === 'work').map(row => row.text);
    expect(topic).toContain('约定第 2 版去掉了对外发布，但这次发布已经在执行，没有中止。');
    expect(topic).not.toContain('约定第 2 版去掉了对外发布，这次不发布。');
  });

  it('发布已经完成：不动，主题里一句固定句，逐字', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    fix.ctx.exec.set('node', ['work/go-live.js'], { code: 0, stdout: '已上线', stderr: '', timedOut: false });
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    const again = await nextPacket(fix, fix.engineer.id);
    const done = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: jobIdIn(again), link: 'https://example.com/signup' });
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true });
    await ownerRemovesLaunch(fix, job.agreementId);
    expect(theJob(fix).launch).toMatchObject({ state: 'done', link: 'https://example.com/signup' });
    const topic = threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' && row.kind === 'work').map(row => row.text);
    expect(topic).toContain('约定第 2 版去掉了对外发布；这次发布在此之前已经完成。');
    expect(topic).not.toContain('约定第 2 版去掉了对外发布，这次不发布。');
  });

  it('反例：发布还在准备时去掉：仍是原来的固定句，没有新增的两句', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await ownerRemovesLaunch(fix, job.agreementId);
    const topic = threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' && row.kind === 'work').map(row => row.text);
    expect(topic).toContain('约定第 2 版去掉了对外发布，这次不发布。');
    expect(topic.some(text => text.includes('已经在执行') || text.includes('在此之前已经完成'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8 总管回答提问的回合被结束
// ---------------------------------------------------------------------------

describe('8 总管回答提问的回合被中心结束', () => {
  it('往来、唤醒摘要、唤醒包写的是总管（老大）的回合，没有「一直没有回答」「叫了你两次」「做不下去」「。。」', async () => {
    const { fix, job } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '报价要不要含税？' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
    await nextPacket(fix, fix.chief.id);
    // 总管的回合一直有事件、超过 60 分钟被结束（每次不超过 10 分钟）。
    for (let i = 0; i < 7 && runningOf(fix, fix.chief.id); i += 1) {
      fix.ctx.clock.advance(10 * MINUTE);
      await fix.hub.onTurnEvent({ type: 'step', sessionId: bot(fix, fix.chief.id).sessionId!, at: fix.ctx.clock.now(), steps: 5, tokens: 100_000 });
      await fix.hub.tick();
    }
    const fact = '老大的一个回合超过 60 分钟，中心已结束它。';
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', text: fact } });
    const works = threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' && row.kind === 'work').map(row => row.text);
    expect(works.at(-1)).toBe(`${fact}已再叫总管。`);
    expect(wakesOf(fix, fix.chief.id, job.id).at(-1)!.reason.summary).toBe(`「会员定价页」：${fact}`);
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    expect(text).toContain(`\n${fact}\n`);
    for (const bad of ['一直没有回答', '叫了你两次', '做不下去', '。。', '无法继续']) {
      expect(text).not.toContain(bad);
      expect(works.at(-1)).not.toContain(bad);
    }
  });
});
