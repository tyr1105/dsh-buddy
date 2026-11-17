/**
 * P74f 的测试：验收通过的五条途径（落到同一个函数）、打字识别的反例、验收之后总管没有新唤醒，
 * 以及主人指出不符（reopen）、总管 done 交账不再生成目标验收提问。
 * 走真实 Hub，假时钟（每次推进不超过 10 分钟）；只用唤醒包里的文字调用成功。
 */
import { describe, expect, it } from 'vitest';
import { executorInfo, putStandardFiles, metWithImage } from './p74d-fixtures.js';
import { commitAndEnd, entriesOf, wakesOf, eventsOf } from './p74c-fixtures.js';
import { speak } from './p74b-fixtures.js';
import { delivered, deliveryCard, openItems, ownerTypes, reopenInfo, chiefTurn, nextPacket, bot, callTool, sectionOf, theJob, threadOf, tick, INTERNAL, MINUTE, type JobFix } from './p74f-fixtures.js';
import type { Job } from '../src/model/job.js';

type PathName = 'button' | 'inbox' | 'topic_text' | 'chat_text' | 'direct_text';

/** 走一条验收途径，必须成功。 */
async function acceptVia(fix: JobFix, job: Job, via: PathName): Promise<void> {
  if (via === 'button') expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
  else if (via === 'inbox') expect(await fix.hub.api.answerInbox(openItems(fix, job.id)[0]!.id, '验收通过')).toMatchObject({ ok: true });
  else if (via === 'topic_text') await ownerTypes(fix, job.topicId, '验收通过');
  else if (via === 'chat_text') await ownerTypes(fix, job.chiefId, '验收通过');
  else await fix.hub.onTurnEvent({ type: 'owner_direct', sessionId: bot(fix, job.chiefId).sessionId ?? 'sess-chief', at: fix.ctx.clock.now(), text: '验收通过' });
}

/** 一次验收之后的全部可比较的结果（不含「途径」这一项）。 */
function outcome(fix: JobFix, job: Job) {
  const now = theJob(fix);
  const topic = threadOf(fix.ctx, job.topicId);
  return {
    state: now.state, accepted: now.acceptedAt !== null, inboxId: now.inboxId, launch: now.launch.state,
    accepts: eventsOf(fix.ctx, job.id).filter(row => row.kind === 'owner_accepted').length,
    items: fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`)).map(row => [row.status, row.answer]),
    hub: topic.filter(row => row.from === 'hub' && row.kind === 'system').map(row => row.text).filter(text => text.includes('已完成')),
    chief: topic.filter(row => row.from === job.chiefId && row.kind === 'reply').map(row => row.text).filter(text => text.startsWith('已记为')),
    receipt: topic.filter(row => row.kind === 'job_card' && row.refId === `receipt:${job.id}`).length,
    trial: threadOf(fix.ctx, job.chiefId).filter(row => row.text.includes('的第一件事做完了')).length,
  };
}

describe('4 五条验收途径，结果完全相同', () => {
  it('按钮、「待你处理」、主题打字、私聊打字、会话直聊：状态、事件、条目、提示、回执、试用反馈一致；按钮和待你处理多一条主人的「验收通过」，打字途径没有重复', async () => {
    const results: Array<ReturnType<typeof outcome>> = [];
    const ownerWords: Record<string, number> = {};
    for (const via of ['button', 'inbox', 'topic_text', 'chat_text', 'direct_text'] as const) {
      const { fix, job } = await delivered();
      const chiefWakesBefore = wakesOf(fix, fix.chief.id).length;
      await acceptVia(fix, job, via);
      results.push(outcome(fix, job));
      ownerWords[via] = threadOf(fix.ctx, job.topicId).filter(row => row.from === 'owner' && row.text === '验收通过').length;
      // 验收之后总管没有新的唤醒，队列里也没有他的候选。
      // 会话直聊本来就是主人在总管的会话里聊起的，那一回合是它自己的，不算「验收叫醒了总管」。
      if (via !== 'direct_text') expect(wakesOf(fix, fix.chief.id).length, via).toBe(chiefWakesBefore);
      expect(entriesOf(fix, fix.chief.id), via).toHaveLength(0);
      expect(eventsOf(fix.ctx, job.id).find(row => row.kind === 'owner_accepted')!.data.via).toBe(via);
    }
    for (const row of results.slice(1)) expect(row).toEqual(results[0]);
    expect(results[0]).toMatchObject({ state: 'done', accepted: true, inboxId: null, accepts: 1, receipt: 1, trial: 2,
      items: [['answered', '验收通过']], hub: ['会员定价页已完成。'], chief: ['已记为完成。'] });
    // 主题里主人的「验收通过」：按钮、待你处理各一条（中心代落）；主题打字是主人自己打的一条；私聊和会话直聊的话在私聊里，主题里没有。
    expect(ownerWords).toEqual({ button: 1, inbox: 1, topic_text: 1, chat_text: 0, direct_text: 0 });
  });
});

describe('5 打字识别的反例', () => {
  it('「通过吗」「先别通过」「通过，但改一下标题」不识别；主人的话照常交给总管；这件事仍在等验收', async () => {
    const { fix, job } = await delivered();
    for (const text of ['通过吗', '先别通过', '通过，但改一下标题']) {
      await ownerTypes(fix, job.topicId, text);
      expect(theJob(fix).state, text).toBe('awaiting_owner');
    }
    expect(openItems(fix, job.id)).toHaveLength(1);
    // 这几句话叫醒了总管（不是验收口令）。
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.chief.id).length + wakesOf(fix, fix.chief.id).length).toBeGreaterThan(0);
  });

  it('交付卡落楼之前（核对通过之前）的话不识别：事后也不会回头验收', async () => {
    const { fix, job, info } = await (async () => {
      const { started } = await import('./p74d-fixtures.js');
      return started();
    })();
    await ownerTypes(fix, job.topicId, '验收通过');
    expect(theJob(fix).state).not.toBe('done');
    // 即使状态被改成待你验收，没有交付卡时打字也不识别。
    fix.ctx.store.table('jobs').put({ ...theJob(fix), state: 'awaiting_owner' });
    await ownerTypes(fix, job.topicId, '验收通过');
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(info.jobId).toBe(job.id);
  });

  it('私聊里两件事在等验收：不识别，中心落那句话，这条消息不叫醒总管，两件都还在等', async () => {
    const { fix, job } = await delivered();
    // 再造一件在等验收的事（复制这件事，交付卡落在同一个主题）。
    const twin: Job = { ...job, id: 'job_bbbbbbbbbb', inboxId: null };
    fix.ctx.store.table('jobs').put(twin);
    const { postThread } = await import('../src/outreach/thread.js');
    postThread(fix.ctx, { thread: job.topicId, from: job.chiefId, kind: 'job_card', refId: `delivery:${twin.id}#1`, text: '另一件事' });
    const queued = fix.ctx.store.table('queue').list(row => row.botId === fix.chief.id).length;
    await ownerTypes(fix, job.chiefId, '验收通过');
    expect(threadOf(fix.ctx, job.chiefId).at(-1)).toMatchObject({ from: 'hub', text: '现在有 2 件事在等你验收，请在要验收的那张卡上点「验收通过」。' });
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.chief.id)).toHaveLength(queued);
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('awaiting_owner');
    expect(fix.ctx.store.table('jobs').get(twin.id)!.state).toBe('awaiting_owner');
  });

  it('对着上一阶段的卡（stage 不一致）按钮被拒，条目、状态不变', async () => {
    const { fix, job } = await delivered();
    const result = await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage + 1 });
    expect(result).toEqual({ ok: false, error: '这张卡已不是最新的，请在最新的交付卡上验收' });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(openItems(fix, job.id)).toHaveLength(1);
  });
});

describe('6 验收之后', () => {
  it('有发布步骤：launch 为 preparing，总管那句话带发布预告；没有发布步骤时只有「已记为完成。」', async () => {
    const { fix, job } = await delivered([], { launch: true });
    await acceptVia(fix, job, 'button');
    expect(theJob(fix).launch.state).toBe('preparing');
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text === '已记为完成。下一步是对外发布，需要你批准，我会单独发给你；批准前不会发布。')).toBe(true);
  });
});

describe('7 主人指出不符：reopen', () => {
  it('只用唤醒包里的文字：主人在主题里说「第 3 条不对」，总管用 jobId 和序号调用 reopen 成功；林舟被叫醒；新阶段核对人的唤醒包里有 missed；交付卡显示未通过', async () => {
    const { fix, job } = await delivered();
    await ownerTypes(fix, job.topicId, '第 3 条不对：失败时页面没有任何提示');
    const packet = await chiefTurn(fix);
    const seen = reopenInfo(packet);
    expect(seen.nos).toEqual([1, 2, 3]);
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reopen', jobId: seen.jobId,
      items: [{ no: seen.nos[2]!, problem: '失败时页面没有任何提示', fixTo: '断开接口后页面显示「加载失败」' }], missed: '核对时只看了正常情况，没有试断开接口，这次要试' });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已退回林舟返工第 3 条，核对人会在新一轮里核对。回复主人时写明三样：返工哪几条、核对当时为什么没有发现、预计什么时候再交。' });
    const now = theJob(fix);
    expect(now).toMatchObject({ state: 'rework', stage: 2, round: 0, inboxId: null, unmet: [{ no: 3 }] });
    // 条目撤回、事件、记录（第四块读的）、主题里的提示。
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey === `job:${job.id}:accept:1`)[0]).toMatchObject({ status: 'withdrawn', answer: '未通过：第 3 条' });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'owner_returned')).toHaveLength(1);
    expect(now.ownerReturns).toMatchObject([{ stage: 1, missed: '核对时只看了正常情况，没有试断开接口，这次要试', items: [{ no: 3, problem: '失败时页面没有任何提示' }], messageId: expect.any(String) }]);
    expect(threadOf(fix.ctx, job.topicId).some(row => row.text === '返工中：第 3 条。在等：林舟。')).toBe(true);
    // 交付卡视图：未通过：第 3 条，只列被指出的那条，其余保持通过。
    const view = fix.hub.api.thread(job.topicId).messages.find(row => row.jobCard?.kind === 'delivery')!.jobCard!;
    expect(view).toMatchObject({ kind: 'delivery', stateText: '未通过：第 3 条', returnedHint: '其余 2 条：你未提出问题，保持通过。', actions: { accept: false } });
    expect(view.kind === 'delivery' && view.items).toMatchObject([{ no: 3, verdict: { label: '你判不符' }, note: '失败时页面没有任何提示', fixTo: '断开接口后页面显示「加载失败」' }]);
    // 林舟被叫醒，只交第 3 条；核对人的唤醒包里写明主人指出过核对漏掉的问题。
    await speak(fix, bot(fix, fix.chief.id), '返工第 3 条：断开接口后页面要显示「加载失败」；核对漏了失败情况，这次补试；预计今天内再交给你。', { outcome: 'progress' });
    const again = executorInfo(await nextPacket(fix, fix.engineer.id));
    await putStandardFiles(fix, again);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'submit', jobId: again.jobId, changeNote: '补了失败提示', deliverables: ['交付/报价页.html'],
      items: [metWithImage(3)] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const reviewerPacket = await nextPacket(fix, fix.reviewer.id);
    expect(sectionOf(reviewerPacket)).toContain('主人验收时指出过核对漏掉的问题：核对时只看了正常情况，没有试断开接口，这次要试');
  });

  it('reopen 只在主人发起、等验收时可用；序号越界、重复被拒；都零写入', async () => {
    const { fix, job } = await delivered();
    const args = { mode: 'reopen', jobId: job.id, items: [{ no: 2, problem: '问题', fixTo: '改法' }], missed: '漏了' };
    // 不是主人发起的回合：先让总管拿到一个不是主人发起的回合比较绕，这里用主人发话的回合验证越界和重复，非主人回合用 stop 的同类做法覆盖在场景测试里。
    await ownerTypes(fix, job.topicId, '第 2 条有问题');
    await chiefTurn(fix);
    const before = JSON.stringify(theJob(fix));
    for (const items of [[{ no: 9, problem: 'x', fixTo: 'y' }], [{ no: 2, problem: 'x', fixTo: 'y' }, { no: 2, problem: 'x', fixTo: 'y' }]]) {
      const bad = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { ...args, items });
      expect(bad.ok).toBe(false);
    }
    expect(JSON.stringify(theJob(fix))).toBe(before);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'owner_returned')).toHaveLength(0);
    // 已经返工之后（不在等验收），再次 reopen 被拒。
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', args)).toMatchObject({ ok: true });
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', args)).toEqual({ ok: false, error: '只能在主人验收这件事时，按主人指出的条目返工' });
  });
});

describe('13 总管 done 交账不再生成目标验收提问；普通员工仍生成', () => {
  it('普通员工 done：目标判待验收并生成提问（反例）', async () => {
    const { fix } = await delivered();
    const goal = { id: 'g_0000000009', botId: fix.engineer.id, aspirationId: 'asp_0000000009', title: '长期目标', doneWhen: '有结果', period: 'week' as const,
      periodEndsAt: null, importance: 0.6, patienceMs: 86_400_000, status: 'active' as const, verification: 'owner' as const, lastProgressAt: fix.ctx.clock.now(),
      createdBy: 'owner' as const, createdAt: fix.ctx.clock.now(), updatedAt: fix.ctx.clock.now() };
    fix.ctx.store.table('goals').put(goal);
    await fix.hub.api.sendMessage(fix.engineer.id, '私聊一句');
    await speak(fix, bot(fix, fix.engineer.id), '做完了', { outcome: 'done' });
    expect(fix.ctx.store.table('goals').get(goal.id)!.status).toBe('done_pending_check');
    expect(fix.ctx.store.table('inbox').list().filter(row => row.subjectKey === `goal_check:${goal.id}`)).toHaveLength(1);
  });
});

describe('给主人看的文字不含内部名称', () => {
  it('交付、验收、回执的全部消息和卡片视图', async () => {
    const { fix, job } = await delivered();
    await acceptVia(fix, job, 'button');
    for (const row of fix.hub.api.thread(job.topicId).messages) {
      if (row.kind === 'work') continue;
      expect(row.text).not.toMatch(INTERNAL);
      // 卡片视图里的 jobId 是给界面按钮用的参数，不显示给主人；其余文字不得含内部名称。
      if (row.jobCard) expect(JSON.stringify({ ...row.jobCard, jobId: undefined, evidenceJobId: undefined, evidenceSubmissionId: undefined })).not.toMatch(INTERNAL);
    }
    expect(deliveryCard(fix, theJob(fix))).toBeDefined();
    await tick(fix, MINUTE);
  });
});
