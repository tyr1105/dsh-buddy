/**
 * P74e 的测试（二）：执行中改约定（B2）。
 *
 * 场景：「会员定价页」已派给林舟，林舟正在做；主人在总管私聊里发来与约定冲突的材料。总管先 forward 把材料交给林舟，
 * 再用 hub_agreement_submit 的 revise 出新版本，写 continuing（照常在做）、paused（暂停）和 fallback（不改的退路）。
 * 两栏由中心按改动算出（改动涉及的条目自动列入暂停，写进 continuing 的被拒）；确认之前，暂停的部分对应的唤醒不发生，
 * 照常在做的部分不受影响；确认之后恢复；主人不确认（撤下重新确认）时回到原约定继续。
 * 全部走真实的 Hub（真实的启动整理和显著性数值），时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { JobSplitViewSchema } from '../src/api/job-view-schemas.js';
import { buildPause, clipTo, touchedItems } from '../src/job/pause.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { pendingAgreementOf, pendingAgreementsOf } from '../src/project/agreements.js';
import { applyJobAction } from '../src/job/state.js';
import { contentFixture } from './p72a-agreement-fixtures.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { lockAgreement, newAgreementArgs } from './p72b-fixtures.js';
import { ownerSays, speak } from './p74b-fixtures.js';
import {
  INTERNAL, bot, callTool, engineerSubmits, entriesOf, eventsOf, lastPacket, nextPacket, reviewerInfo, sectionOf, started, theJob, threadOf, type JobFix,
} from './p74d-fixtures.js';
import { MINUTE, commitAndEnd, runningOf, tick, wakesOf } from './p74c-fixtures.js';

type Started = Awaited<ReturnType<typeof started>>;

/** 新版本只改「这次做」的第 2 条（其余不动）。 */
function reviseArgs(agreementId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'revise', agreementId, changeNote: '每小时自动刷新一次',
    scopeIn: ['报价列表页', '手动刷新，并每小时自动刷新'],
    continuing: ['报价列表页'], paused: ['刷新相关的部分'], fallback: '如果只是文案说法，回复「不变」，我保留第 1 版。',
    ...extra,
  };
}

/** 林舟结束他当前的回合，主人在总管私聊发来一句冲突的话，总管被叫醒；返回总管这一回合的唤醒包和从中取到的编号。 */
async function ownerConflicts(fix: JobFix, text = '文案里写的是自动刷新，和约定里的手动刷新不一样'): Promise<{ packet: string; jobId: string; agreementId: string }> {
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
  await ownerSays(fix, fix.chief.id, text);
  const packet = lastPacket(fix, bot(fix, fix.chief.id));
  const jobId = /（jobId 为 (job_[0-9a-z]{10})）/.exec(sectionOf(packet))?.[1];
  expect(jobId, '总管的唤醒包里应该有这件事的编号').toBeDefined();
  return { packet, jobId: jobId!, agreementId: agreementIdIn(packet) };
}

/** 完成 B2 的前半：总管 revise 成功并交账，卡片落在私聊，「待你处理」有一条。返回编号。 */
async function pendingReopen(extra: Record<string, unknown> = {}, state: 'doing' | 'checking' = 'doing'): Promise<Started & { agreementId: string; jobId: string }> {
  const base = await started();
  if (state === 'checking') await engineerSubmits(base.fix, base.info);
  const seen = await ownerConflicts(base.fix);
  const result = await callTool(base.fix, base.fix.chief, 'hub_agreement_submit', reviseArgs(seen.agreementId, extra));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await speak(base.fix, bot(base.fix, base.fix.chief.id), '这和已定的第 1 版冲突：自动刷新还没定。其余照常在做。', { outcome: 'needs_owner' });
  return { ...base, agreementId: seen.agreementId, jobId: seen.jobId };
}

/** 林舟在这件事上排着的候选加上已经开始的回合数（确认之后调度可能立刻放行，候选马上变成回合，所以两者合计才稳定）。 */
const touches = (fix: JobFix, jobId: string): number => entriesOf(fix, fix.engineer.id, jobId).length + wakesOf(fix, fix.engineer.id, jobId).length;

/**
 * 为林舟记下的、摘要包含这句话的感知条数：中心叫醒他之前一定先记一条这样的感知（带着这次叫醒的原因），
 * 所以它比「队列里有几条候选」稳定（同一件事的候选会合并，调度也可能立刻把候选变成回合）。
 */
const wokenFor = (fix: JobFix, summary: string): number =>
  fix.ctx.store.table('percepts').count(row => row.botId === fix.engineer.id && row.summary.includes(summary));

/**
 * 总管到目前为止的回合数。P74r2a：夹具里的总管已与真实一致（听吩咐），补课回合（catch_up）被中心挡住，
 * 不再需要排除；这里直接数全部回合。
 */
const chiefWakes = (fix: JobFix) => wakesOf(fix, fix.chief.id).length;

/**
 * 让时间流逝两小时，用来证明「确认之后总管没有新的唤醒」。不依赖额度灯，也不靠大步跳时间：
 * 一、每次只走 10 分钟（不超过「睡眠间隔」10 分钟）。一次跳 30 分钟会被中心当成电脑睡眠，给所有在岗员工（包括总管）排一个「补课」回合，
 *    那是时间跳跃造成的，与确认无关；真实使用里调度是持续运行的。
 * 二、林舟的回合正常交账（progress），这件事不停滞，所以不会有「回合卡住、重试、总管被叫来处理停滞」这类与确认无关的唤醒。
 */
async function quietTwoHours(fix: JobFix): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await tick(fix, 10 * MINUTE);
  }
}

describe('只用唤醒包里的文字调用成功（转交材料，再出新版本）', () => {
  it('2 总管主人发起的唤醒包里只用正则取 jobId 和 agreementId，先 forward（title「活动文案」）成功，再 revise（带 continuing、paused、fallback）成功', async () => {
    const { fix, job } = await started();
    const seen = await ownerConflicts(fix, '这是活动文案：每小时自动刷新报价。');
    expect(seen.jobId).toBe(job.id);
    const forwarded = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: seen.jobId, title: '活动文案', text: '每小时自动刷新报价。' });
    expect(forwarded, JSON.stringify(forwarded)).toEqual({ ok: true, text: '已存为主题文件「活动文案」，交给林舟。' });
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(seen.agreementId));
    expect(revised.ok, JSON.stringify(revised)).toBe(true);
    // 工具如实告诉总管中心算出的两栏，以及林舟有没有被叫醒。
    expect(revised.text).toContain('已记下第 2 版，等主人确认。中心按这次的改动算出：照常在做：报价列表页；暂停：这次做第 2 条：手动刷新，并每小时自动刷新、刷新相关的部分（改动涉及的条目已自动列入暂停）。');
    expect(theJob(fix).pause).toMatchObject({ versionNo: 2, fallback: '如果只是文案说法，回复「不变」，我保留第 1 版。' });
  });
});

describe('6 参数校验', () => {
  it('约定有进行中的事时 revise 缺 continuing 或 paused 被拒，零写入', async () => {
    const { fix, job } = await started();
    const seen = await ownerConflicts(fix);
    const before = JSON.stringify(fix.ctx.store.table('agreements').list());
    for (const missing of [['continuing'], ['paused'], ['continuing', 'paused']]) {
      const args = reviseArgs(seen.agreementId);
      for (const key of missing) delete args[key];
      const result = await callTool(fix, fix.chief, 'hub_agreement_submit', args);
      expect(result, missing.join()).toEqual({ ok: false, error: '这件事正在做，请写明哪些照常在做（continuing）、哪些暂停（paused）' });
    }
    expect(JSON.stringify(fix.ctx.store.table('agreements').list())).toBe(before);
    expect(theJob(fix).pause).toBeNull();
    expect(job.id).toBe(theJob(fix).id);
  });

  it('没有进行中的事时传了这三项被拒：新建、没有事的约定 revise、amend、已完成和已停止的事', async () => {
    const fix = await (await started()).fix;
    const job = theJob(fix);
    const ONLY = 'continuing、paused、fallback 只用于正在做的事重新确认约定';
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '再改一下');
    // 新建约定。
    const created = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '另一件', continuing: ['甲'] }));
    expect(created).toEqual({ ok: false, error: ONLY });
    // 这件事已完成、已停止：revise 带三项被拒（事收尾了就不是「正在做的事」）。
    const agreementId = fix.ctx.store.table('agreements').get(job.agreementId)!.id;
    for (const state of ['done', 'stopped'] as const) {
      fix.ctx.store.table('jobs').patch(job.id, { state });
      const result = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(agreementId));
      expect(result, state).toEqual({ ok: false, error: ONLY });
    }
    // amend 带三项被拒。
    const amended = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'amend', agreementId, changeNote: '改一句话', summary: '一句话', paused: ['甲'] });
    expect(amended).toEqual({ ok: false, error: ONLY });
  });

  it('没有事的约定（没有派活）revise 带三项被拒；不带则照常出新版本（第一块原有行为）', async () => {
    const fix = (await started()).fix;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '再做一件小事');
    const second = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '第二件' }));
    expect(second.ok, JSON.stringify(second)).toBe(true);
    const id = fix.ctx.store.table('agreements').list().find(row => row.title === '第二件')!.id;
    await speak(fix, bot(fix, fix.chief.id), '有 2 项需要你定。', { outcome: 'needs_owner' });
    lockAgreement(fix.ctx, id);
    await ownerSays(fix, fix.chief.id, '第二件要改一下');
    const withInput = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId: id, changeNote: '改范围', scopeIn: ['报价列表页'], removals: ['手动刷新'], continuing: ['甲'], paused: ['乙'] });
    expect(withInput).toEqual({ ok: false, error: 'continuing、paused、fallback 只用于正在做的事重新确认约定' });
    const plain = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId: id, changeNote: '改范围', scopeIn: ['报价列表页'], removals: ['手动刷新'] });
    expect(plain.ok, JSON.stringify(plain)).toBe(true);
  });

  it('两栏由中心算：continuing 里写了被改动涉及的条目被整份拒绝（写明是哪一条），paused 里漏写改动涉及的条目也会被自动列入', async () => {
    const { fix, job } = await started();
    const seen = await ownerConflicts(fix);
    const bad = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(seen.agreementId, { continuing: ['手动刷新，并每小时自动刷新', '报价列表页'] }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('continuing 里的「手动刷新，并每小时自动刷新」涉及这次改动的这次做第 2 条，不能写成照常在做，请写进 paused');
    expect(fix.ctx.store.table('agreements').list()[0]!.versions).toHaveLength(1);
    expect(theJob(fix).pause).toBeNull();
    // 模型的 paused 一个字没提改动涉及的条目：中心自动列在最前面。
    const good = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(seen.agreementId, { paused: ['别的暂停项'] }));
    expect(good.ok, JSON.stringify(good)).toBe(true);
    expect(theJob(fix).pause).toMatchObject({ continuing: ['报价列表页'], paused: ['这次做第 2 条：手动刷新，并每小时自动刷新', '别的暂停项'] });
    expect(job.id).toBe(theJob(fix).id);
  });

  it('状态变化要么全部完成、要么恢复原状：写约定新版本时失败，这件事的暂停记录也不留，约定仍是原样，执行者没有被叫醒', async () => {
    const { fix, job } = await started();
    const seen = await ownerConflicts(fix);
    // 让约定表的第一次写入失败（表对象每次取都是新的，所以换掉 store.table，对「agreements」包一层）。
    const store = fix.ctx.store as unknown as { table: (name: string) => object };
    const originalTable = store.table.bind(store);
    let failed = false;
    store.table = (name: string) => {
      const table = originalTable(name);
      if (name !== 'agreements') return table;
      return new Proxy(table, {
        get(target, prop) {
          if (prop === 'put' && !failed) return () => { failed = true; throw new Error('磁盘写入失败'); };
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const touchedBefore = wokenFor(fix, '约定第 2 版在等主人确认');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(seen.agreementId));
    store.table = originalTable;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('磁盘写入失败');
    expect(theJob(fix).pause).toBeNull();
    expect(fix.ctx.store.table('agreements').get(seen.agreementId)!.versions).toHaveLength(1);
    expect(wokenFor(fix, '约定第 2 版在等主人确认')).toBe(touchedBefore);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'paused')).toHaveLength(0);
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text.includes('在等你确认'))).toBe(false);
  });

  it('纯函数：改动涉及的条目一次列全（一句话、草图、待你定、我已定的、怎样算做完、删去）；超过 6 项时最后一项写总括；每项不超过 40 字', () => {
    const locked = contentFixture();
    const next = contentFixture();
    next.summary = '做一个能查看每日报价、并且带提醒的小页面';
    next.decided = [{ text: '做网页，也做手机端', basis: { kind: 'judgement', ref: null, refText: null } }];
    next.scopeIn = ['报价列表页', '手动刷新', '价格提醒'];
    next.scopeOut = [];
    next.doneWhen = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时显示「加载失败」，并且不白屏、不报错'];
    next.pending = next.pending.filter(item => item.key !== 'refresh');
    const lines = touchedItems(locked, next).map(item => item.line);
    // P74r16b 第 3.1 节：清单不再列「一句话」（它不是一条要做的事）；其余各项不变。
    expect(lines).toEqual([
      '待你定「多久刷新一次」（删去）', '我已定的第 1 条：做网页，也做手机端',
      '这次做第 3 条：价格提醒', '这次不做删去：历史曲线', '怎样算做完第 3 条：接口失败时显示「加载失败」，并且不白屏、不报错',
    ]);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(40);
    // 超过 6 项：前 5 项加一句总括。
    const many = contentFixture();
    many.scopeIn = ['甲甲甲', '乙乙乙', '丙丙丙', '丁丁丁', '戊戊戊', '己己己'];
    many.doneWhen = ['子子子', '丑丑丑', '寅寅寅'];
    const pause = buildPause(2, locked, many, { continuing: ['无关的一项'], paused: ['额外的一项'], fallback: undefined });
    expect(pause.paused).toHaveLength(6);
    expect(pause.paused[5]).toMatch(/^另有 \d+ 处，见约定卡$/);
    expect(clipTo('甲'.repeat(50))).toBe(`${'甲'.repeat(39)}…`);
  });
});

describe('7 约定卡视图与第二段', () => {
  it('revise 之后约定卡视图有 jobSplit：两栏、退路、交付时间一行正确；工作往来一句；林舟被叫醒且唤醒包里写明暂停的部分', async () => {
    const { fix, job, agreementId } = await pendingReopen();
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const card = agreementCardView(fix.ctx, agreement, agreement.versions[1]!);
    expect(card.jobSplit).toEqual({
      continuing: ['报价列表页'], paused: ['这次做第 2 条：手动刷新，并每小时自动刷新', '刷新相关的部分'],
      dueText: '交付时间不变：11月17日 18:00 前', fallback: '如果只是文案说法，回复「不变」，我保留第 1 版。',
    });
    expect(JobSplitViewSchema.safeParse(card.jobSplit).success).toBe(true);
    // 第 1 版（已固定）没有两栏。
    expect(agreementCardView(fix.ctx, agreement, agreement.versions[0]!).jobSplit).toBeNull();
    // dueAt 为空：只写「交付时间不变」。
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: null });
    expect(agreementCardView(fix.ctx, agreement, agreement.versions[1]!).jobSplit!.dueText).toBe('交付时间不变');
    // 工作往来一句；事件记了暂停。
    const topic = threadOf(fix.ctx, job.topicId);
    expect(topic.find(row => row.kind === 'work' && row.text.startsWith('约定第 2 版在等你确认'))).toMatchObject({ from: 'hub',
      text: '约定第 2 版在等你确认；暂停：这次做第 2 条：手动刷新，并每小时自动刷新、刷新相关的部分；其余照常在做。' });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'paused')).toHaveLength(1);
    // 给主人看的文字没有内部名称。
    expect(JSON.stringify(card.jobSplit) + topic.map(row => row.text).join('')).not.toMatch(INTERNAL);
    // 林舟被叫醒：他的唤醒包写明暂停的部分和照常在做的部分，暂停的部分在主人确认前不要交回。
    expect(entriesOf(fix, fix.engineer.id, job.id).length).toBeGreaterThan(0);
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain('约定第 2 版在等主人确认：暂停这次做第 2 条：手动刷新，并每小时自动刷新、刷新相关的部分；照常在做报价列表页。暂停的部分在主人确认前不要交回。');
  });

  it('8 待确认期间林舟 submit 被拒（B2 流程里再验一次）；answer、forward 照常成功', async () => {
    const { fix, job, info } = await pendingReopen();
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain('暂停的部分在主人确认前不要交回');
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: info.jobId, changeNote: '做完了', items: [{ no: 1, selfCheck: 'at_delivery' }], deliverables: ['交付/报价页.html'],
    });
    // P74r2b：拒绝文字补一句，告诉执行者做完照常的部分就结束这一回合。
    expect(refused).toEqual({ ok: false, error: '约定第 2 版还在等主人确认，暂停的部分确认后再交回。照常在做的部分做完了就结束这一回合，主人确认后中心会叫你。' });
    // 林舟问一个问题（照常在做的部分），总管按约定回答成功。
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '报价列表要不要分页？' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问' });
    const chiefPacket = await nextPacket(fix, fix.chief.id);
    expect(chiefPacket).toContain('回答：调用 hub_job_manage，mode 写 answer');
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '不分页', basis: [{ section: 'scopeOut', no: 1 }] })).toEqual({ ok: true, text: '已回答林舟。' });
    // 主人再发一份材料，总管 forward 成功。
    await speak(fix, bot(fix, fix.chief.id), '已回答。', { outcome: 'progress' });
    await ownerSays(fix, fix.chief.id, '再补一份文案');
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: job.id, title: '补充文案', text: '补充内容' })).toMatchObject({ ok: true });
    expect(theJob(fix).pause).not.toBeNull();
  });
});

/** 四条确认途径。每条返回确认前、后总管的唤醒数（队列和回合）。 */
type Route = 'button' | 'inbox' | 'typed' | 'direct';
async function confirmVia(fix: JobFix, route: Route, agreementId: string): Promise<void> {
  if (route === 'button') {
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
  } else if (route === 'inbox') {
    const item = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey === `agreement:${agreementId}:2`)[0]!;
    expect(await fix.hub.api.answerInbox(item.id, '按建议，定了')).toMatchObject({ ok: true });
  } else if (route === 'typed') {
    await ownerSays(fix, fix.chief.id, '定了');
  } else {
    await fix.hub.onTurnEvent({ type: 'owner_direct', sessionId: bot(fix, fix.chief.id).sessionId!, at: fix.ctx.clock.now(), text: '定了' });
  }
}

describe('9 主人确认：四条途径', () => {
  it.each(['button', 'inbox', 'typed', 'direct'] as Route[])('%s：主题文件重写（新版本号）、暂停清空、主题里那一句、林舟被叫醒，总管没有新的唤醒', async route => {
    const { fix, job, info, agreementId } = await pendingReopen();
    const paused = theJob(fix).pause!.paused;
    const before = chiefWakes(fix);
    const engineerBefore = touches(fix, job.id);
    fix.ctx.clock.advance(1_000);
    await confirmVia(fix, route, agreementId);
    await flushJobHooks(fix.ctx);
    // 约定固定，主题文件重写为第 2 版，暂停清空。
    expect(fix.ctx.store.table('agreements').get(agreementId)).toMatchObject({ state: 'locked' });
    const file = await fix.ctx.fs.readText(`${info.jobDir}/约定.md`);
    expect(file).toContain('（约定第 2 版）');
    expect(file).toContain('手动刷新，并每小时自动刷新');
    expect(theJob(fix).pause).toBeNull();
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'resumed' && row.data.how === 'confirm')).toHaveLength(1);
    // 主题里以总管名义落中心固定句。
    const sentence = `约定第 2 版已按你的确认固定：每小时自动刷新一次。林舟已继续做暂停的 ${paused.length} 处（见约定卡），交付时间不变。`;
    expect(threadOf(fix.ctx, job.topicId).find(row => row.text === sentence)).toMatchObject({ from: fix.chief.id, kind: 'reply' });
    expect(sentence).not.toMatch(INTERNAL);
    // P74r12：固定之后的话不再拼清单，不含暂停清单里任何一条的内容。
    for (const item of paused) expect(sentence).not.toContain(item);
    // 林舟被叫醒（为他记了一条「约定第 2 版已生效」的感知并排了候选）；总管没有新的唤醒（队列里没有，时间流逝之后也没有新的回合）。
    expect(wokenFor(fix, '约定第 2 版已生效，请接着做')).toBe(1);
    expect(engineerBefore).toBeGreaterThanOrEqual(0);
    expect(entriesOf(fix, fix.chief.id)).toHaveLength(0);
    // 直聊（DSH 会话）本身就是总管的一个回合，那是主人直接聊起的、不是确认之后多出来的叫醒，而且它没有交账会超时重试，
    // 所以直聊途径只检查到队列为空这一步；其余三条途径再让时间流逝，确认没有给总管带来任何新回合。
    if (route !== 'direct') {
      await quietTwoHours(fix);
      expect(chiefWakes(fix)).toBe(before);
      expect(wakesOf(fix, fix.engineer.id, job.id).length).toBeGreaterThan(1);
    }
  });

  it('typed：在这个主题里打「定了」同样固定，且不叫醒总管', async () => {
    const { fix, job, agreementId } = await pendingReopen();
    const before = chiefWakes(fix);
    fix.ctx.clock.advance(1_000);
    await ownerSays(fix, job.topicId, '定了');
    await flushJobHooks(fix.ctx);
    expect(fix.ctx.store.table('agreements').get(agreementId)).toMatchObject({ state: 'locked' });
    expect(theJob(fix).pause).toBeNull();
    // 与上一条相同的观察办法：每次只走 10 分钟、林舟正常交账，两小时里总管回合数不变（不靠额度灯，也不靠观察期恰好够短）。
    await quietTwoHours(fix);
    expect(chiefWakes(fix)).toBe(before);
  });
});

describe('10 主人不确认：总管撤销重开', () => {
  it('主人回「不限」，总管 withdraw：暂停清空，工作往来那句，林舟被叫醒，约定仍是原固定版本', async () => {
    const { fix, job, agreementId } = await pendingReopen();
    await ownerSays(fix, fix.chief.id, '不限，保持原来的');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'withdraw', agreementId, reason: '主人说不用改' });
    expect(result).toEqual({ ok: true, text: '已取消这次重新确认，约定仍按已固定的版本执行。' });
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    expect(agreement).toMatchObject({ state: 'locked' });
    expect(agreement.versions.find(row => row.state === 'locked')!.no).toBe(1);
    expect(theJob(fix).pause).toBeNull();
    expect(threadOf(fix.ctx, job.topicId).some(row => row.from === 'hub' && row.kind === 'work'
      && row.text === '约定第 2 版没有采用，仍按第 1 版做。暂停的部分照第 1 版继续做。')).toBe(true);
    expect(entriesOf(fix, fix.engineer.id, job.id).length).toBeGreaterThan(0);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'resumed' && row.data.withdrawn === true)).toHaveLength(1);
    // 约定卡视图不再有两栏。
    expect(agreementCardView(fix.ctx, agreement, agreement.versions[1]!).jobSplit).toBeNull();
  });
});

describe('11 amend：主人亲口的小改动在执行中', () => {
  it('主题文件重写，工作往来一句，林舟被叫醒，不出卡', async () => {
    const { fix, job, info } = await started();
    const seen = await ownerConflicts(fix, '一句话说得再准确一点');
    const before = chiefWakes(fix);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'amend', agreementId: seen.agreementId, changeNote: '一句话改得更准确', summary: '做一个能查看每日报价的小页面，含手动刷新' });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('已记入约定第 2 版并直接生效') });
    const file = await fix.ctx.fs.readText(`${info.jobDir}/约定.md`);
    expect(file).toContain('（约定第 2 版）');
    expect(file).toContain('含手动刷新');
    expect(threadOf(fix.ctx, job.topicId).some(row => row.from === 'hub' && row.kind === 'work' && row.text === '约定第 2 版：一句话改得更准确。')).toBe(true);
    expect(entriesOf(fix, fix.engineer.id, job.id).length).toBeGreaterThan(0);
    // 不出卡：约定仍是已固定，没有待确认的版本，没有新的「待你处理」条目。
    await speak(fix, bot(fix, fix.chief.id), '已记入。', { outcome: 'progress' });
    const agreement = fix.ctx.store.table('agreements').get(seen.agreementId)!;
    expect(agreement.state).toBe('locked');
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith('agreement:'))).toHaveLength(0);
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.kind === 'agreement')).toHaveLength(1);
    expect(theJob(fix).pause).toBeNull();
    expect(chiefWakes(fix)).toBe(before);
  });
});

describe('12 修订不丢内容', () => {
  it('B2 新版本里没改的部分与上一版逐项相同；有意删除要在 removals 里写明，不写就被拒', async () => {
    const { fix, agreementId } = await pendingReopen();
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const [v1, v2] = agreement.versions;
    expect(v2!.content.summary).toBe(v1!.content.summary);
    expect(v2!.content.sketch).toEqual(v1!.content.sketch);
    expect(v2!.content.decided).toEqual(v1!.content.decided);
    expect(v2!.content.scopeOut).toEqual(v1!.content.scopeOut);
    expect(v2!.content.doneWhen).toEqual(v1!.content.doneWhen);
    expect(v2!.content.pending.map(({ chosen, ...rest }) => rest)).toEqual(v1!.content.pending.map(({ chosen, ...rest }) => rest));
    expect(v2!.content.scopeIn).toEqual(['报价列表页', '手动刷新，并每小时自动刷新']);
    expect(v2!.changes).toEqual([{ section: 'scopeIn', kind: 'changed', index: 1 }]);
    // 悄悄少一条被拒；暂停记录不变（失败时零写入）。
    const pause = JSON.stringify(theJob(fix).pause);
    await ownerSays(fix, fix.chief.id, '再改一下');
    const dropped = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(agreementId, { changeNote: '去掉一条', doneWhen: ['打开页面能看到今天的报价', '点刷新后数据更新'] }));
    expect(dropped.ok).toBe(false);
    expect(dropped.error).toContain('removals');
    expect(JSON.stringify(theJob(fix).pause)).toBe(pause);
  });

  it('12a 这件事在核对中，主人确认改写「怎样算做完」第 3 条的新版本：返工中、阶段加 1、待改只有第 3 条、核对人队列里的候选被丢弃、林舟被叫醒；已有的交回记录和核对记录原样保留', async () => {
    const { fix, job, info, agreementId } = await pendingReopen({
      changeNote: '接口失败时的提示写具体', scopeIn: undefined, continuing: ['报价列表页', '手动刷新'], paused: ['失败提示'],
      doneWhen: ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时显示「加载失败」'],
    }, 'checking');
    // 确认之前：评审甲的核对唤醒不发生（时间流逝也不会有回合）；核对结论被拒。
    for (let i = 0; i < 4; i += 1) await tick(fix, 30 * MINUTE);
    expect(wakesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(1);
    const refused = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: job.id, items: [{ no: 1, verdict: 'at_delivery' }] });
    expect(refused).toEqual({ ok: false, error: '约定第 2 版还在等主人确认，核对要等确认之后（确认后按新版本核对）。' });
    const submissionsBefore = JSON.stringify(fix.ctx.store.table('jobSubmissions').list());
    expect(theJob(fix)).toMatchObject({ state: 'checking', stage: 1, round: 1 });
    // 主人确认。
    const engineerBefore = touches(fix, job.id);
    await confirmVia(fix, 'button', agreementId);
    await flushJobHooks(fix.ctx);
    expect(theJob(fix)).toMatchObject({ state: 'rework', stage: 2, round: 0, pause: null,
      unmet: [{ no: 3, problem: '约定第 2 版改了这一条', fixTo: '接口失败时显示「加载失败」' }] });
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    expect(wokenFor(fix, '约定第 2 版改了第 3 条，请按新版本返工这几条')).toBe(1);
    expect(engineerBefore).toBeGreaterThanOrEqual(0);
    expect(threadOf(fix.ctx, job.topicId).some(row => row.kind === 'work' && row.text === '约定第 2 版改了第 3 条，林舟按新版本返工这几条。')).toBe(true);
    // 交回记录原样保留；之后评审甲也没有回合（林舟的回合开着，间隔取 2 分钟，不让它因久无动静超时）。
    expect(JSON.stringify(fix.ctx.store.table('jobSubmissions').list())).toBe(submissionsBefore);
    const packet = await nextPacket(fix, fix.engineer.id);
    for (let i = 0; i < 3; i += 1) await tick(fix, 2 * MINUTE);
    expect(wakesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    // 林舟只重交第 3 条：其余条目沿用，证据原样带过来（编号、检查结果不变）。
    expect(sectionOf(packet)).toContain('这一轮要改的条目：第 3 条：问题：约定第 2 版改了这一条；改到什么程度算过：接口失败时显示「加载失败」。');
    const first = fix.ctx.store.table('jobSubmissions').list()[0]!;
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: job.id, changeNote: '按新版本改了失败提示', deliverables: ['交付/报价页.html'],
      items: [{ no: 3, selfCheck: 'met', evidence: [{ kind: 'test', summary: '断开接口后页面显示「加载失败」' }] }],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const second = fix.ctx.store.table('jobSubmissions').list().find(row => row.id !== first.id)!;
    expect(second.versionNo).toBe(2);
    expect(second.items.find(row => row.no === 1)).toMatchObject({ selfCheck: 'carried', evidence: first.items.find(row => row.no === 1)!.evidence });
    expect(second.items.find(row => row.no === 2)).toMatchObject({ selfCheck: 'carried', evidence: first.items.find(row => row.no === 2)!.evidence });
    expect(info.items).toHaveLength(3);
  });

  it('12b 核对中只改「这次做」文字的新版本：状态不变（仍核对中）、不叫醒林舟；确认之后评审甲的核对唤醒照常发生，核对结论照常提交', async () => {
    const { fix, job, info, agreementId } = await pendingReopen({}, 'checking');
    for (let i = 0; i < 3; i += 1) await tick(fix, 30 * MINUTE);
    expect(wakesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    const engineerBefore = touches(fix, job.id);
    await confirmVia(fix, 'button', agreementId);
    await flushJobHooks(fix.ctx);
    expect(theJob(fix)).toMatchObject({ state: 'checking', stage: 1, round: 1, unmet: [], pause: null });
    expect(touches(fix, job.id)).toBe(engineerBefore);
    // 评审甲被放行，拿到回合，提交核对结论成功（核对的交回和证据没有被动过）。
    const packet = await nextPacket(fix, fix.reviewer.id);
    const seen = reviewerInfo(packet);
    expect(seen.nos).toEqual([1, 2, 3]);
    const result = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', {
      mode: 'review', jobId: seen.jobId, items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'met' }],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(info.jobId).toBe(job.id);
  });

  it('12c 已通过核对、待你验收时确认改写「怎样算做完」第 2 条的新版本：撤回验收条目，只退回第 2 条，其余结论和证据保留', async () => {
    const { fix, job, agreementId } = await pendingReopen({
      changeNote: '点刷新后的提示写具体', scopeIn: undefined, continuing: ['报价列表页', '手动刷新'], paused: ['刷新提示'],
      doneWhen: ['打开页面能看到今天的报价', '点刷新后数据更新并显示「已更新」', '接口失败时有提示'],
    }, 'doing');
    // 让这件事处于「待你验收」：手工写状态，并放一条验收条目（P74f 才有真实的条目，这里只验证会被撤回）。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'awaiting_owner', round: 1 });
    fix.ctx.store.table('inbox').put({ id: 'i_aaaaaaaaaa', botId: fix.chief.id, type: 'question', title: '会员定价页：待你验收', body: '', options: ['验收通过'],
      defaultOption: null, priority: 'P1', refId: job.id, subjectKey: `job:${job.id}:accept:1`, status: 'open', answer: null, pushed: false,
      createdAt: fix.ctx.clock.now(), expiresAt: null, answeredAt: null } as never);
    await confirmVia(fix, 'button', agreementId);
    await flushJobHooks(fix.ctx);
    expect(theJob(fix)).toMatchObject({ state: 'rework', stage: 2, round: 0, unmet: [{ no: 2 }] });
    expect(theJob(fix).unmet).toHaveLength(1);
    expect(fix.ctx.store.table('inbox').get('i_aaaaaaaaaa')).toMatchObject({ status: 'withdrawn' });
  });
});

describe('13 至 15 待确认的数量', () => {
  /** 总管名下另有一份对齐中的新约定 B（待确认），再由主人说话叫醒总管出 A 的新版本。返回编号。 */
  async function twoPending() {
    const base = await started();
    const { fix, job } = base;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '另外再帮我做一个邀请函页');
    const drafted = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '邀请函页' }));
    expect(drafted.ok, JSON.stringify(drafted)).toBe(true);
    await speak(fix, bot(fix, fix.chief.id), '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    const bId = fix.ctx.store.table('agreements').list().find(row => row.title === '邀请函页')!.id;
    // A 要改：总管在新的主人发起的回合里为 A 出新版本。
    await ownerSays(fix, fix.chief.id, '会员定价页的刷新要自动的');
    const packet = lastPacket(fix, bot(fix, fix.chief.id));
    const aId = agreementIdIn(packet);
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(aId));
    expect(revised.ok, JSON.stringify(revised)).toBe(true);
    await speak(fix, bot(fix, fix.chief.id), '会员定价页的刷新方式和第 1 版冲突，其余照常在做。', { outcome: 'needs_owner' });
    return { ...base, aId, bId, job };
  }

  it('13 对齐中的 B 在等确认时，执行中的事 A 仍可重新确认；私聊打「定了」不固定任何一张，中心落那句话，总管不被叫醒；在 A 的主题里打「定了」固定 A', async () => {
    const { fix, job, aId, bId } = await twoPending();
    expect(fix.ctx.store.table('agreements').get(aId)).toMatchObject({ state: 'pending' });
    expect(fix.ctx.store.table('agreements').get(bId)).toMatchObject({ state: 'pending' });
    const before = chiefWakes(fix);
    fix.ctx.clock.advance(1_000);
    await ownerSays(fix, fix.chief.id, '定了');
    expect(fix.ctx.store.table('agreements').get(aId)!.state).toBe('pending');
    expect(fix.ctx.store.table('agreements').get(bId)!.state).toBe('pending');
    const notes = threadOf(fix.ctx, fix.chief.id).filter(row => row.from === 'hub' && row.text === '现在有 2 张约定在等你确认，请在要确认的那张卡上点「定了」。');
    expect(notes).toHaveLength(1);
    expect(entriesOf(fix, fix.chief.id)).toHaveLength(0);
    for (let i = 0; i < 3; i += 1) await tick(fix, 30 * MINUTE);
    expect(chiefWakes(fix)).toBe(before);
    // 在 A 的主题里打「定了」只固定 A，B 仍待确认。
    fix.ctx.clock.advance(1_000);
    await ownerSays(fix, job.topicId, '定了');
    await flushJobHooks(fix.ctx);
    expect(fix.ctx.store.table('agreements').get(aId)!.state).toBe('locked');
    expect(fix.ctx.store.table('agreements').get(bId)!.state).toBe('pending');
    expect(theJob(fix).pause).toBeNull();
    // 此后私聊里只剩 B 一张，打「定了」照旧固定 B（并叫醒总管：B 没有正在做的事）。
    fix.ctx.clock.advance(1_000);
    await ownerSays(fix, fix.chief.id, '定了');
    expect(fix.ctx.store.table('agreements').get(bId)!.state).toBe('locked');
  });

  it('13b DSH 会话直聊：两张待确认时「定了」同样不识别（规则同总管私聊），中心落那句话；pendingAgreementsOf 给出全部，pendingAgreementOf 只给对齐阶段的那一份', async () => {
    const { fix, aId, bId } = await twoPending();
    expect(pendingAgreementsOf(fix.ctx, fix.chief.id).map(row => row.id).sort()).toEqual([aId, bId].sort());
    expect(pendingAgreementOf(fix.ctx, fix.chief.id)!.id).toBe(bId);
    fix.ctx.clock.advance(1_000);
    await fix.hub.onTurnEvent({ type: 'owner_direct', sessionId: bot(fix, fix.chief.id).sessionId!, at: fix.ctx.clock.now(), text: '定了' });
    expect(fix.ctx.store.table('agreements').get(aId)!.state).toBe('pending');
    expect(fix.ctx.store.table('agreements').get(bId)!.state).toBe('pending');
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.from === 'hub' && row.text === '现在有 2 张约定在等你确认，请在要确认的那张卡上点「定了」。')).toHaveLength(1);
  });

  it('13c 只有一张待确认时「定了」照旧识别（对齐中的新约定，没有正在做的事）：固定并叫醒总管', async () => {
    const fix = (await started()).fix;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '再帮我做一个邀请函页');
    expect((await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '邀请函页' }))).ok).toBe(true);
    await speak(fix, bot(fix, fix.chief.id), '有 2 项需要你定。', { outcome: 'needs_owner' });
    const id = fix.ctx.store.table('agreements').list().find(row => row.title === '邀请函页')!.id;
    fix.ctx.clock.advance(1_000);
    await ownerSays(fix, fix.chief.id, '定了');
    expect(fix.ctx.store.table('agreements').get(id)!.state).toBe('locked');
    expect(entriesOf(fix, fix.chief.id).length + wakesOf(fix, fix.chief.id).filter(row => row.status === 'running').length).toBeGreaterThan(0);
  });

  it('15 两张待确认时总管交账带 ownerQuestion 被拒；唤醒包里两张待确认块都在', async () => {
    const { fix, aId, bId } = await twoPending();
    await ownerSays(fix, fix.chief.id, '你觉得先做哪个？');
    const packet = lastPacket(fix, bot(fix, fix.chief.id));
    expect(packet).toContain(`待主人确认：约定「会员定价页」第 2 版（agreementId 为 ${aId}`);
    expect(packet).toContain(`待主人确认：约定「邀请函页」第 1 版（agreementId 为 ${bId}`);
    const tool = fix.hub.tools().find(item => item.name === 'hub_commit')!;
    const { commitArgs } = await import('./c03-turn-fixtures.js');
    const result = await tool.handler(bot(fix, fix.chief.id).sessionId!, commitArgs({ reply: '先做哪个？', outcome: 'needs_owner',
      ownerQuestion: { text: '先做哪个？', options: ['会员定价页', '邀请函页'], defaultOption: '会员定价页', whyNeeded: '需要主人定' } } as never)) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('约定卡已经在等主人确认，不能再用 ownerQuestion 提问');
  });

  it('14 有组队卡待确认时，A 的重新确认不被拦；新建约定照旧被拦', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '这件事可能要加个研究员查竞品');
    const packet = lastPacket(fix, bot(fix, fix.chief.id));
    const template = /^(.+?)（[^）]+）：代查资料/m.exec(packet)?.[1];
    expect(template, '唤醒包里应该有研究员模板').toBeDefined();
    const agreementId = agreementIdIn(packet);
    const proposed = await callTool(fix, fix.chief, 'hub_team_propose', { template, agreementId, needReason: '要先查同类产品的定价', residentReason: '以后还会反复查竞品和资料' });
    expect(proposed.ok, JSON.stringify(proposed)).toBe(true);
    expect(fix.ctx.store.table('teamProposals').list().length).toBe(1);
    // 新建约定被拦；A 的重新确认不被拦。
    const created = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '又一件' }));
    expect(created).toEqual({ ok: false, error: '已有一张组队卡在等主人确认，先请主人确认或回复「不新增」，再提交新的约定或重新确认' });
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(agreementId));
    expect(revised.ok, JSON.stringify(revised)).toBe(true);
    expect(theJob(fix).pause).toMatchObject({ versionNo: 2 });
    expect(job.id).toBe(theJob(fix).id);
  });
});

describe('状态机：version_rework', () => {
  it('只能从核对中、待你验收出发；阶段加 1、轮数归零、写入待改条目；待改条目不能为空', () => {
    const base = { id: 'job_aaaaaaaaaa', stage: 1, round: 2, unmet: [], deliveredAt: 5 } as never as Parameters<typeof applyJobAction>[0];
    const unmet = [{ no: 3, problem: '约定改了', fixTo: '新原文' }];
    for (const state of ['checking', 'awaiting_owner'] as const) {
      expect(applyJobAction({ ...base, state }, { type: 'version_rework', unmet }, 10)).toMatchObject({ state: 'rework', stage: 2, round: 0, unmet, updatedAt: 10 });
    }
    for (const state of ['ready', 'doing', 'rework', 'blocked'] as const) {
      expect(() => applyJobAction({ ...base, state, blocked: state === 'blocked' ? { kind: 'executor', no: null, text: 'x', since: 1, resumeTo: 'doing' } : null }, { type: 'version_rework', unmet }, 10)).toThrow(/「新版约定返工」只能从「核对中、待你验收」发起/);
    }
    expect(() => applyJobAction({ ...base, state: 'checking' }, { type: 'version_rework', unmet: [] }, 10)).toThrow('新版约定返工必须写明至少一条被改到的条目');
  });
});
