/**
 * P74r14 第 3 至 7 节的测试（第 1、2 节在 p74r14-escalate.test.ts）：
 * 3 总管写给主人看的话里称呼写「你」：总管两个工具里给主人看的参数出现「主人」被拒（文字逐字），员工用 hub_job_work 写的话不受影响
 *   （hub_memory 不在核心里，核心没有改它）；
 * 4 核对人、执行者的话里不带 hub_job_work 的参数名，页面里的标识符不拦；
 * 5 约定确认条目的视图带 agreementTitle；
 * 6 约定确认条目的正文不再带界面按标记显示的说明行，标记照旧；
 * 7 「问题：选定项」里问题末尾的问号去掉再接冒号。
 * 全部走真实的 Hub 或纯函数，时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { paramNameProblem } from '../src/job/owner-text.js';
import { joinQuestion } from '../src/util/question-join.js';
import { newAgreementArgs } from './p72b-fixtures.js';
import { chiefDrafts, jobFix, ownerSays, speak, type JobFix } from './p74b-fixtures.js';
import { commitAndEnd, runningOf, tick, MINUTE } from './p74c-fixtures.js';
import { bot, callTool, engineerSubmits, firstSubmitArgs, nextPacket, reviewerInfo, started } from './p74d-fixtures.js';
import { chiefTurn, delivered, ownerTypes, reopenInfo } from './p74f-fixtures.js';
import { limitFix } from './p74f2-fixtures.js';
import { stopRevise } from './p74f2-fixtures.js';

// P74r15 改了预期：拒绝文字后面加了半句「如果这里说的不是你的主人，换一个不含这两个字的说法」（原来到「不写「主人」」为止）。
const ADDRESS = (field: string) => `${field}：这句话是给主人看的，称呼写「你」，不写「主人」；如果这里说的不是你的主人，换一个不含这两个字的说法`;

// ---------------------------------------------------------------------------
// 3 称呼
// ---------------------------------------------------------------------------

describe('3 总管写给主人看的话里，称呼写「你」', () => {
  it('stop 的原因含「主人」被拒，文字逐字；改成「你」通过，主题里落的话是「这件事已停止：你说……」', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '这件事先不做了');
    const refused = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '主人在主题里说不做了' });
    expect(refused).toEqual({ ok: false, error: ADDRESS('reason') });
    const ok = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你在主题里说不做了' });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(fix.ctx.store.log('thread').all().some(row => row.text === '这件事已停止：你在主题里说不做了')).toBe(true);
  });

  it('escalate 的受阻说明、办法的标题和说明、建议的理由含「主人」各被拒，文字逐字，零写入', async () => {
    const { fix } = await limitFix();
    const text = await nextPacket(fix, fix.chief.id);
    const jobId = /写说明：调用 hub_job_manage，mode 写 escalate，jobId 写 (job_[0-9a-z]{10})/.exec(text)?.[1];
    expect(jobId).toBeDefined();
    const good = [{ title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } },
      { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' }];
    const args = { mode: 'escalate', jobId, stuckAt: '接口失败时的提示一直做不好', options: good, suggested: 0, reason: '最小的改动' };
    const refuse = async (patch: Record<string, unknown>, field: string) => {
      const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { ...args, ...patch });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(ADDRESS(field));
    };
    await refuse({ stuckAt: '主人要的提示一直做不好' }, 'stuckAt');
    await refuse({ reason: '主人看得最清楚' }, 'reason');
    await refuse({ options: [{ ...good[0]!, title: '听主人的' }, good[1]] }, 'options[0].title');
    await refuse({ options: [good[0], { ...good[1]!, detail: '主人选了就换人' }] }, 'options[1].detail');
    expect(fix.ctx.store.table('jobs').list()[0]!.escalation ?? null).toBeNull();
    const ok = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', args);
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
  });

  it('reopen 每一条的问题和改到什么程度含「主人」被拒，文字逐字', async () => {
    const { fix, job } = await delivered();
    await ownerTypes(fix, job.topicId, '第 3 条不对：失败时页面没有任何提示');
    const seen = reopenInfo(await chiefTurn(fix));
    const item = { no: seen.nos[2]!, problem: '失败时页面没有任何提示', fixTo: '断开接口后页面显示「加载失败」' };
    const base = { mode: 'reopen', jobId: seen.jobId, missed: '核对时只看了正常情况' };
    for (const [name, patch] of [['problem', { problem: '主人说失败时没有提示' }], ['fixTo', { fixTo: '主人试了能看到提示' }]] as const) {
      const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { ...base, items: [{ ...item, ...patch }] });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(ADDRESS(`第 ${item.no} 条的 ${name}`));
    }
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { ...base, items: [item] })).toMatchObject({ ok: true });
  });

  it('约定各栏和本版改动含「主人」被拒，文字逐字；不含的通过', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    const submit = (extra: Record<string, unknown>) => callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页', ...extra }));
    const bad = await submit({ summary: '做一个主人想要的页面' });
    expect(bad).toEqual({ ok: false, error: ADDRESS('summary') });
    const bad2 = await submit({ scopeOut: ['历史曲线', '主人没要的功能'] });
    expect(bad2).toEqual({ ok: false, error: ADDRESS('scopeOut[1]') });
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
    expect(await submit({})).toMatchObject({ ok: true });
  });

  it('员工用 hub_job_work 写的话不受影响：提问里写「主人」照常通过', async () => {
    const { fix, info } = await started();
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: info.jobId, text: '主人要的是手机端还是电脑端？' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 4 参数名
// ---------------------------------------------------------------------------

describe('4 核对人、执行者的话里不带参数名', () => {
  // P74r15 改了预期：原来断言五个参数名（含 rechecked、jobId）整词、不分大小写都被拦（含 'FIXTO'）；
  // 现在只拦 fixTo、carriedNote、spotChecked 三个，区分大小写（rechecked、jobId、FIXTO 不拦，另见 p74r15-small）。
  it('纯函数：三个参数名（整词、区分大小写）被拦，页面里的标识符和普通句子不拦', () => {
    for (const name of ['fixTo', 'carriedNote', 'spotChecked']) {
      expect(paramNameProblem('note', `把提示按 ${name} 改`), name).toBe(`note：不要写参数名（${name}），用白话写`);
    }
    // 主会话裁定：mode、items 是普通英文词，不拦。
    for (const text of ['BAD_PHONE 常量没有被页面使用', 'renderItems 函数没有调用', '接口失败时页面要有提示', 'model 字段缺失',
      '页面在 dark mode 下文字看不清', '列表里的 items 没有按价格排序']) {
      expect(paramNameProblem('note', text), text).toBeNull();
    }
  });

  it('核对人：不符说明里含 fixTo 被拒（文字逐字，零写入）；含页面标识符 BAD_PHONE 的通过', async () => {
    const s = await started();
    await engineerSubmits(s.fix, s.info);
    await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id));
    const items = (note: string, fixTo: string) => [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'unmet', note, fixTo }, { no: 3, verdict: 'met' }];
    const refused = await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: items('提示不明显', 'fixTo：把提示改为红色') });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('第 2 条：fixTo：不要写参数名（fixTo），用白话写');
    const carried = await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: items('提示不明显', '把提示改为红色'), carriedNote: '沿用 spotChecked 的结论' });
    expect(carried.ok).toBe(false);
    expect(carried.error).toContain('carriedNote：不要写参数名（spotChecked），用白话写');
    const ok = await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: items('BAD_PHONE 常量没有被页面使用', '让页面用上 BAD_PHONE 的提示') });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
  });

  it('执行者：交回说明和做不下去的原因含参数名被拒；普通句子通过', async () => {
    const { fix, info } = await started();
    const refusedSubmit = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info, { changeNote: '按 carriedNote 逐条改了' }));
    expect(refusedSubmit.ok).toBe(false);
    expect(refusedSubmit.error).toContain('changeNote：不要写参数名（carriedNote），用白话写');
    const refusedBlock = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: info.jobId, stuckAt: '缺少 fixTo 的说明', tried: ['试了两种写法'] });
    expect(refusedBlock.ok).toBe(false);
    expect(refusedBlock.error).toContain('stuckAt：不要写参数名（fixTo），用白话写');
    await engineerSubmits(fix, info);
  });
});

// ---------------------------------------------------------------------------
// 5、6 约定确认条目
// ---------------------------------------------------------------------------

const LINES = ['不会自动按建议处理', '你确认前不会开工', '暂停的部分不会做', '你确认后这件事停止'];

/** 这份约定的约定确认条目（还开着的）。 */
function confirmItem(fix: JobFix) {
  return fix.hub.api.inbox().items.find(row => row.agreementId != null)!;
}

describe('5 约定确认条目带约定的标题', () => {
  it('视图有 agreementTitle；普通条目没有', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页' });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    const item = confirmItem(fix);
    expect(item).toMatchObject({ agreementTitle: '会员定价页', agreementVersion: 1 });
    for (const other of fix.hub.api.inbox().items.filter(row => row.agreementId == null)) expect(other.agreementTitle ?? null).toBeNull();
  });
});

describe('6 约定确认条目的正文不重复说明行', () => {
  it('没有进行中的事：正文不含说明行，两个标记都为假', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页' });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。', { outcome: 'needs_owner' });
    const item = confirmItem(fix);
    for (const line of LINES) expect(item.body).not.toContain(line);
    expect(item).toMatchObject({ agreementJobSplit: false, agreementStop: false });
  });

  it('有进行中的事（两栏）：正文不含说明行，agreementJobSplit 为真', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '名额限 60 人');
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'revise', agreementId: job.agreementId, changeNote: '限 60 人',
      scopeIn: ['报价列表页', '手动刷新，名额限 60 人'], continuing: ['报价列表页'], paused: ['名额相关的部分'], fallback: '如果只是文案说法，回复「不变」，我保留第 1 版。' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '名额限 60 人，等你确认。', { outcome: 'needs_owner' });
    const item = confirmItem(fix);
    for (const line of LINES) expect(item.body).not.toContain(line);
    expect(item).toMatchObject({ agreementJobSplit: true, agreementStop: false });
  });

  it('写明不再做（stopsJob）：正文不含说明行，agreementStop 为真', async () => {
    const { fix } = await started();
    await stopRevise(fix);
    const item = confirmItem(fix);
    for (const line of LINES) expect(item.body).not.toContain(line);
    expect(item).toMatchObject({ agreementStop: true });
  });
});

// ---------------------------------------------------------------------------
// 7 问题：选定项
// ---------------------------------------------------------------------------

describe('7 「问题：选定项」里问号后面不接冒号', () => {
  it('全角问号、半角问号、不带问号、问号后带空白各一条，逐字', () => {
    expect(joinQuestion('是否限制报名人数？', '限 80 人')).toBe('是否限制报名人数：限 80 人');
    expect(joinQuestion('是否限制报名人数?', '限 80 人')).toBe('是否限制报名人数：限 80 人');
    expect(joinQuestion('是否限制报名人数', '限 80 人')).toBe('是否限制报名人数：限 80 人');
    expect(joinQuestion('是否限制报名人数？  ', '限 80 人')).toBe('是否限制报名人数：限 80 人');
  });

  it('「待你处理」条目正文：问题以问号结尾时不出现「？：」，存下来的问题原文不改', async () => {
    const fix = await jobFix();
    const pending = [{ key: 'limit', question: '是否限制报名人数？', options: ['不限', '限 80 人'], suggested: '限 80 人', reason: '场地只能坐 80 人' },
      { key: 'refresh', question: '多久刷新一次?', options: ['每小时', '每天'], suggested: '每天', reason: '看日报即可' }];
    const id = await chiefDrafts(fix as never, { title: '会员定价页', pending });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。', { outcome: 'needs_owner' });
    const body = confirmItem(fix).body;
    expect(body).toContain('是否限制报名人数：限 80 人');
    expect(body).toContain('多久刷新一次：每天');
    expect(body).not.toContain('？：');
    expect(body).not.toContain('?：');
    expect(fix.ctx.store.table('agreements').get(id)!.versions[0]!.content.pending[0]!.question).toBe('是否限制报名人数？');
  });
});

void runningOf; void tick; void MINUTE;
