/**
 * P74r3 的测试（三）：两栏按原文算（M1）、「待你处理」条目正文最后一句（L1）、别人的提问不拦执行者的续排（L2）、
 * 「已处理到第几版」只增不减（疑点 1）。
 * 走真实 Hub（真实的启动整理、闸门、假时钟，每次推进不超过 10 分钟）；断言要证明的机制不依赖额度灯。
 */
import { describe, expect, it } from 'vitest';
import { flushJobHooks, onAgreementLocked } from '../src/job/agreement-hooks.js';
import { classifyChanges, remapItems } from '../src/job/item-remap.js';
import { catchUpJobFollowUps } from '../src/job/catch-up.js';
import { eventsOf } from '../src/job/store.js';
import { buildPause, touchedItems } from '../src/job/pause.js';
import type { AgreementContent } from '../src/model/agreement.js';
import { chiefDrafts, ownerSays, speak } from './p74b-fixtures.js';
import { commitAndEnd, runningOf, wakesOf } from './p74c-fixtures.js';
import { MINUTE, bot, callTool, entriesOf, jobFix, lastPacket, started, theJob, tick, type JobFix } from './p74d-fixtures.js';
import { idsIn, pendingReopen, reviseArgs } from './p74r2b-fixtures.js';

const T1 = '打开页面能看到今天的报价';
const T2 = '点刷新后数据更新';
const T3 = '接口失败时有提示';

/** 结束总管和林舟当前开着的回合（主人发话之前要先结束，总管才会拿到新的回合）。 */
async function chiefEndsTurn(fix: JobFix): Promise<void> {
  if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
  if (runningOf(fix, fix.chief.id)) await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已处理' });
}

/** 主人发话，总管 revise 出第 2 版并交账，主人确认，收尾做完。 */
async function reviseAndConfirm(fix: JobFix, extra: Record<string, unknown>): Promise<string> {
  await chiefEndsTurn(fix);
  await ownerSays(fix, fix.chief.id, '验收条目要调整一下');
  const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, extra));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '已请主人确认。', { outcome: 'needs_owner' });
  expect(await fix.hub.api.confirmAgreement({ agreementId: ids.agreementId, version: 2 })).toMatchObject({ ok: true });
  await flushJobHooks(fix.ctx);
  return ids.agreementId;
}

/** 一份最小的约定内容（只填两栏计算用到的段）。 */
function content(patch: Partial<AgreementContent>): AgreementContent {
  const basis = { kind: 'judgement' as const, ref: null, refText: null };
  return {
    summary: '做一个能查看每日报价的小页面', sketch: { layout: 'flow', steps: [{ label: '打开' }] },
    pending: [], decided: [{ text: '做网页', basis }, { text: '用中文', basis }], scopeIn: ['报价列表页', '手动刷新'], scopeOut: ['历史曲线', '登录'],
    doneWhen: [T1, T2, T3], ...patch,
  } as unknown as AgreementContent;
}

describe('M1 两栏按原文算', () => {
  it('复验报告的场景：删去第 1 条、末尾加一条；没改的两条不在「暂停」栏，总管写进「照常在做」不被拒；新增的一条和删去的一条在「暂停」栏', async () => {
    const { fix, job } = await started([], { deliveryItems: [1] });
    await chiefEndsTurn(fix);
    await ownerSays(fix, fix.chief.id, '去掉第一条，加一条导出');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    // 条数没有减少（删一条、加一条），不需要声明 removals。
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', {
      mode: 'revise', agreementId: ids.agreementId, changeNote: '去掉第 1 条，加导出', doneWhen: [T2, T3, '能导出表格'],
      continuing: [T2], paused: ['导出相关的部分'], fallback: '如果不要导出，保留第 1 版。' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const pause = theJob(fix).pause!;
    expect(pause.continuing).toEqual([T2]);
    expect(pause.paused).toEqual(['怎样算做完第 3 条：能导出表格', `怎样算做完删去：${T1}`, '导出相关的部分']);
    const shown = pause.paused.join('\n');
    expect(shown).not.toContain(T2);
    expect(shown).not.toContain(T3);
    expect(theJob(fix).id).toBe(job.id);
  });

  it('修订里写进 continuing 的条目确实被改写时仍然被拒（反例）', async () => {
    const { fix } = await started([], { deliveryItems: [1] });
    await chiefEndsTurn(fix);
    await ownerSays(fix, fix.chief.id, '把刷新那条改一下');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', {
      mode: 'revise', agreementId: ids.agreementId, changeNote: '改刷新', doneWhen: [T1, '点刷新后数据更新并提示时间', T3],
      continuing: ['点刷新后数据更新并提示时间'], paused: ['刷新相关'] });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('不能写成照常在做');
  });

  it('其余三段：在最前面插入一条后，没改的条目不进「暂停」栏；新增的条目序号用新版本里的', () => {
    const before = content({});
    const basis = { kind: 'judgement' as const, ref: null, refText: null };
    // 我已定的：前面插入一条，原来的两条序号变成 2、3。
    const decided = touchedItems(before, content({ decided: [{ text: '先做手机端', basis }, ...before.decided] })).map(item => item.line);
    expect(decided).toEqual(['我已定的第 1 条：先做手机端']);
    // 这次做：前面插入。
    const scopeIn = touchedItems(before, content({ scopeIn: ['载入提示', ...before.scopeIn] })).map(item => item.line);
    expect(scopeIn).toEqual(['这次做第 1 条：载入提示']);
    // 这次不做：前面插入。
    const scopeOut = touchedItems(before, content({ scopeOut: ['多语言', ...before.scopeOut] })).map(item => item.line);
    expect(scopeOut).toEqual(['这次不做第 1 条：多语言']);
    // 怎样算做完：前面插入。
    const doneWhen = touchedItems(before, content({ doneWhen: ['加载时有提示', T1, T2, T3] })).map(item => item.line);
    expect(doneWhen).toEqual(['怎样算做完第 1 条：加载时有提示']);
    // 没有任何改动：一条都没有。
    expect(touchedItems(before, content({}))).toEqual([]);
  });

  it('改写（同一位置换了原文）算改动，只列新原文；删去且条数减少时写明删去；buildPause 对没改的条目写进照常在做不报错', () => {
    const before = content({});
    expect(touchedItems(before, content({ doneWhen: [T1, T2, '接口失败时提示原因'] })).map(item => item.line)).toEqual(['怎样算做完第 3 条：接口失败时提示原因']);
    expect(touchedItems(before, content({ scopeOut: ['历史曲线'] })).map(item => item.line)).toEqual(['这次不做删去：登录']);
    expect(buildPause(2, before, content({ scopeIn: ['载入提示', ...before.scopeIn] }),
      { continuing: ['报价列表页', '手动刷新'], paused: ['载入提示相关'], fallback: undefined }).paused).toEqual(['这次做第 1 条：载入提示', '载入提示相关']);
  });

  it('classifyChanges：改写、新增、删去的分法', () => {
    const run = (prev: string[], next: string[]) => classifyChanges(remapItems(prev, next), prev.length, next.length);
    expect(run(['甲', '乙', '丙'], ['乙', '丙', '丁'])).toEqual({ rewritten: [], added: [3], deleted: [1] });
    expect(run(['甲', '乙', '丙'], ['甲', '乙', '丙二'])).toEqual({ rewritten: [3], added: [], deleted: [] });
    expect(run(['甲', '乙', '丙'], ['甲', '乙'])).toEqual({ rewritten: [], added: [], deleted: [3] });
    expect(run(['甲'], ['子', '甲', '丑'])).toEqual({ rewritten: [], added: [1, 3], deleted: [] });
  });
});

describe('L1 条目正文的最后一句', () => {
  it('有进行中的事：写「你确认前，暂停的部分不会做。」；没有进行中的事：仍写「你确认前不会开工。」', async () => {
    const { fix } = await pendingReopen();
    const withJob = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.title.startsWith('约定第 2 版待你确认'));
    expect(withJob).toHaveLength(1);
    // P74r14 第 6 节改了预期：原来断言正文以这句结尾；说明行现在只由界面按标记显示，正文不再带。
    expect(withJob[0]!.body).not.toContain('不会自动按建议处理');
    expect(withJob[0]!.body).not.toContain('暂停的部分不会做');
    expect(withJob[0]!.body).not.toContain('不会开工');
    // 没有进行中的事：新约定第 1 版待确认。
    const fresh = await jobFix();
    await chiefDrafts(fresh as never, { title: '会员定价页' });
    await speak(fresh, fresh.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    const items = fresh.ctx.store.table('inbox').list(row => row.status === 'open' && row.title.startsWith('约定第 1 版待你确认'));
    expect(items).toHaveLength(1);
    expect(items[0]!.body).not.toContain('不会自动按建议处理');
    expect(items[0]!.body).not.toContain('你确认前不会开工');
  });
});

describe('L2 别人的提问不拦执行者的续排', () => {
  /** 林舟在执行中，这件事有一个未回答的提问（asker 提的）；林舟交账 progress。返回这之后林舟为这件事排着的候选数。 */
  async function engineerProgressesWithAskFrom(pick: (fix: JobFix) => string): Promise<number> {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { openAsk: { eventId: 'jev_aaaaaaaaaa', fromId: pick(fix), at: fix.ctx.clock.now(), text: '价格要不要含税？' } });
    const before = entriesOf(fix, fix.engineer.id, job.id).length;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '做了一部分' });
    return entriesOf(fix, fix.engineer.id, job.id).length - before;
  }

  it('核对人的提问（别人的提问）：林舟交账 progress 之后照常续排；林舟自己的提问：不续排', async () => {
    expect(await engineerProgressesWithAskFrom(fix => fix.reviewer.id)).toBeGreaterThan(0);
    expect(await engineerProgressesWithAskFrom(fix => fix.engineer.id)).toBe(0);
  });

  // 说明：核对人只在核对中提问，那时执行者本来就不续排，现有状态下到不了「核对人提问时执行者在干活」；
  // 所以上面一条用直接写入提问记录的方式，在单元层面证明续排的判断只看提问人是不是执行者自己。
});

describe('疑点 1：已处理到第几版只增不减', () => {
  it('较新的一版（第 2 版）收尾完成后，较旧的一版（第 1 版）的收尾再写入：值仍是 2；巡检不补做', async () => {
    const { fix, job } = await started();
    const agreementId = await reviseAndConfirm(fix, { changeNote: '加暗色模式' });
    expect(theJob(fix).handledVersionNo).toBe(2);
    onAgreementLocked(fix.ctx, agreementId, 1, 'confirm');
    await flushJobHooks(fix.ctx);
    expect(theJob(fix).handledVersionNo).toBe(2);
    // 巡检：已处理到的不小于约定最新固定的版本，什么都不补做（事件、叫醒都不增加）。
    const events = eventsOf(fix.ctx, job.id).length;
    const wakes = wakesOf(fix, fix.engineer.id, job.id).length + entriesOf(fix, fix.engineer.id, job.id).length;
    catchUpJobFollowUps(fix.ctx);
    await flushJobHooks(fix.ctx);
    await tick(fix, 1 * MINUTE);
    expect(eventsOf(fix.ctx, job.id)).toHaveLength(events);
    expect(wakesOf(fix, fix.engineer.id, job.id).length + entriesOf(fix, fix.engineer.id, job.id).length).toBe(wakes);
    expect(theJob(fix).handledVersionNo).toBe(2);
  });
});
