/**
 * P74r16c 第 1、2、3 节的测试：员工在一件事里被中心停用之后的衔接补完。
 *
 * 夹具与真实情况一致：总管是自动创建的（听吩咐、节奏设为最慢的一档 quiet）、执行类员工听吩咐；
 * 执行者是走真实路径被停用的（连续三次碰凭据类文件，闸门记三次越界），不直接改员工状态。
 * 「在等某人」的情形都让那个人真跑一个回合，只用唤醒包里的文字取名字、编号和调用写法。
 * 覆盖：
 * 1 唤醒包写明能怎么做：事实一行、末尾一句逐字；总管只用包里的文字换人成功、向主人说明成功；反例：手动停用不写「中心停用」、已说明过不再提示说明；
 * 2 主人选了带改动的办法而员工还停用着：保持受阻、进度行写「（已停用）」、不排唤醒、不报错、告警条目还开着，恢复在岗后接着做且摘要带着办法；
 *   反例：主人选的办法是换人，换成在岗的员工，不受停用的那位影响；
 * 3 叫醒总管的原因给主人看的那一句。
 */
import { describe, expect, it } from 'vitest';
import { inboxView } from '../src/api/feed-views.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { lifecycleAction } from '../src/api/bots.js';
import { lockedVersionOf } from '../src/job/files.js';
import { assigned, bot, commitAndEnd, entriesOf, jobFix, runningJob, tick, wakesOf, MINUTE, callTool, type JobFix } from './p74c-fixtures.js';
import { chiefChainBody } from '../src/wake/job-section-chief.js';
import { lastPacket, sectionOf } from './p74d-fixtures.js';

// 越界达到次数的停用原因（守卫里的写法，带最近一次的理由，原因本身带括号）。
const REASON = '越界的动作累计 3 次（最近一次：敏感凭据路径禁止读取或改写）';
/** 事实一行（任务卡逐字）。 */
const FACT = `林舟已被中心停用，原因：${REASON}。这件事停在执行。`;
/** 末尾一句（任务卡逐字）。 */
const CLOSING = '也可以向主人说明现状、给出几个办法（mode 写 escalate）。主人恢复林舟在岗之后，这件事会自己接着做，不需要你再安排。';

// 说明里的办法：A 带改动（放宽第 3 条），B 不改约定（换人）。
const A = { title: '放宽第三条', detail: '改成接口失败时有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } };
const B = { title: '换小周接着做', detail: '请小周从现有的交回接着做，不改约定' };

async function suspendByCredentials(fix: JobFix, botId: string): Promise<void> {
  const sessionId = bot(fix, botId).sessionId!;
  for (let i = 0; i < 3; i += 1) expect(fix.hub.guardToolCall(sessionId, 'bash', { command: 'cat ~/.ssh/id_rsa' }).allow).toBe(false);
  await fix.hub.tick();
  expect(bot(fix, botId).lifecycle).toBe('quarantined');
}

/** 林舟正在做一件事（回合开着）；总管、小周、评审甲都在岗。 */
async function running() {
  const fix = await jobFix(['小周']);
  const { job } = await runningJob(fix);
  return { fix, job };
}

/** 停用之后总管被叫醒（回合开着），返回这一回合的唤醒包。 */
async function chiefAwake(fix: JobFix, jobId: string): Promise<string> {
  for (let i = 0; i < 3 && !wakesOf(fix, fix.chief.id, jobId).some(row => row.status === 'running'); i += 1) await tick(fix, 10 * MINUTE);
  expect(wakesOf(fix, fix.chief.id, jobId).some(row => row.status === 'running'), '总管应该被叫醒了').toBe(true);
  return lastPacket(fix, bot(fix, fix.chief.id));
}

/** 总管只用唤醒包里的文字调用 escalate（编号和 mode 都从包里取）。 */
async function escalateFromText(fix: JobFix, text: string, options: Array<Record<string, unknown>>) {
  const jobId = /（jobId 为 (job_[0-9a-z]{10})）/.exec(text)?.[1];
  const mode = /（mode 写 (\w+)）/.exec(text)?.[1];
  expect(jobId, '包里应该有这件事的编号').toBeDefined();
  expect(mode, '包里应该写明向主人说明用哪个 mode').toBe('escalate');
  const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode, jobId, stuckAt: '林舟被停用了，暂时没有人接手', options, suggested: 0, reason: '改动最小' });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  // 说明成功之后总管这一回合结束，之后才能被主人选办法的话再叫醒。
  await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已把办法交给主人' });
  return jobId!;
}

/** 「待你处理」里这件事的说明卡。 */
const escalateCard = (fix: JobFix) => inboxView(fix.ctx).items.find(item => item.jobEntry?.kind === 'escalate');
/** 「待你处理」里的停用告警。 */
const alertItem = (fix: JobFix) => inboxView(fix.ctx).items.find(item => item.type === 'alert');

describe('1 总管被叫醒之后，唤醒包写明能怎么做', () => {
  it('这件事那一段逐字含事实一行和末尾一句，并含换人的做法与在岗员工名单（停用的不在名单里）', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const text = sectionOf(await chiefAwake(fix, job.id));
    expect(text).toContain(FACT);
    expect(text).toContain(CLOSING);
    expect(text).toContain(`换人：调用 hub_job_manage，mode 写 reassign，jobId 写 ${job.id}，executor 写新执行者的名字。`);
    const staff = /当前在岗的员工：(.+?)。/.exec(text)?.[1] ?? '';
    expect(staff).toContain('小周');
    expect(staff).not.toContain('林舟');
  });

  it('总管只用包里的文字换人：成功，换成在岗的另一位，这件事接着做，被换上的人被叫醒', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const text = sectionOf(await chiefAwake(fix, job.id));
    const jobId = /换人：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，executor 写新执行者的名字/.exec(text)?.[1];
    expect(jobId).toBe(job.id);
    // 在岗名单里取一位执行类员工（名字和角色标签都只来自包里的文字）。
    const names = (/当前在岗的员工：(.+?)。/.exec(text)![1]!).split('、').flatMap(part => {
      const match = /^(.+?)（(.+)）$/.exec(part);
      return match === null ? [] : [{ name: match[1]!, duty: match[2]! }];
    });
    const picked = names.find(row => row.duty.includes('执行'))!;
    expect(picked.name).toBe('小周');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId, executor: picked.name });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const next = fix.ctx.store.table('jobs').get(job.id)!;
    expect(next).toMatchObject({ executorId: fix.extras[0]!.id, blocked: null });
    expect(['ready', 'doing', 'rework']).toContain(next.state);
    expect(entriesOf(fix, fix.extras[0]!.id, job.id).length + wakesOf(fix, fix.extras[0]!.id, job.id).length).toBeGreaterThan(0);
  });

  it('总管只用包里的文字向主人说明：成功，「待你处理」出现说明卡', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const text = sectionOf(await chiefAwake(fix, job.id));
    await escalateFromText(fix, text, [A, B]);
    const card = escalateCard(fix);
    expect(card, '「待你处理」里应该有说明卡').toBeDefined();
    expect(card).toMatchObject({ title: '会员定价页：林舟无法继续' });
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('blocked');
  });

  it('反例：已经向主人说明过的这一次受阻，包里不再提示说明，换人的做法仍在', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    await escalateFromText(fix, sectionOf(await chiefAwake(fix, job.id)), [A, B]);
    // 说明之后这一回合已结束；用同一件事的另一次叫醒（主人选了不带改动的办法）看包。
    const card = escalateCard(fix)!;
    expect((await fix.hub.api.answerInbox(card.id, card.options[1]!)).ok).toBe(true);
    const text = sectionOf(await chiefAwake(fix, job.id).catch(() => lastPacket(fix, bot(fix, fix.chief.id))));
    expect(text).not.toContain('也可以向主人说明现状');
    expect(text).toContain('换人：调用 hub_job_manage，mode 写 reassign');
  });

  it('反例：主人手动停用的员工（不是中心停用）：包里不写「已被中心停用」，仍写换人的做法', async () => {
    const { fix, job } = await running();
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    // 手动停用不排唤醒，总管没有带这件事编号的回合；直接取这件事在执行链唤醒里的写法（与真实唤醒包同一个函数）。
    const body = chiefChainBody(fix.ctx, fix.ctx.store.table('jobs').get(job.id)!, name => `/hub/${name}`, []);
    const text = body.tail.join('\n');
    expect(text).not.toContain('已被中心停用');
    expect(text).toContain('林舟已停用，这件事停在执行。');
    expect(text).toContain('换人：调用 hub_job_manage，mode 写 reassign');
  });
});

describe('2 主人选了办法而那位员工还停用着', () => {
  /** 林舟被停用、总管说明（A 带改动、B 换人）、总管这一回合结束。返回说明卡。 */
  async function escalated() {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    await escalateFromText(fix, sectionOf(await chiefAwake(fix, job.id)), [A, B]);
    const card = escalateCard(fix)!;
    expect(card.options).toEqual([`A　${A.title}`, `B　${B.title}`]);
    return { fix, job, card };
  }

  it('完整顺序：选带改动的办法后保持受阻、进度行写「林舟（已停用）」、不排唤醒、告警条目还开着；恢复在岗后林舟被叫醒且摘要带着办法', async () => {
    const { fix, job, card } = await escalated();
    const engineerWakes = wakesOf(fix, fix.engineer.id, job.id).length;
    const alert = alertItem(fix)!;
    expect(alert.reinstate).toBeDefined();
    // 主人选 A（改第 3 条）：成功，不报错。
    const chosen = await fix.hub.api.answerInbox(card.id, card.options[0]!);
    expect(chosen, JSON.stringify(chosen)).toMatchObject({ ok: true });
    const blocked = fix.ctx.store.table('jobs').get(job.id)!;
    expect(blocked).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off' }, escalation: { chosen: 0 } });
    // 约定按选定的办法出了新版本，第 3 条已改。
    const agreement = fix.ctx.store.table('agreements').get(blocked.agreementId)!;
    expect(lockedVersionOf(agreement).content.doneWhen[2]).toBe(A.change.text);
    // 进度行：在等被停用的那位。
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('林舟（已停用）');
    // 不给停用的员工排唤醒；之后推进时间也不会（两个十分钟）。
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    for (let i = 0; i < 2; i += 1) await tick(fix, 10 * MINUTE);
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    expect(wakesOf(fix, fix.engineer.id, job.id).length).toBe(engineerWakes);
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off' } });
    // 带恢复入口的告警条目还开着。
    expect(alertItem(fix)).toMatchObject({ id: alert.id, reinstate: { botName: '林舟', answer: 'reinstate' } });
    expect(fix.ctx.store.table('inbox').get(alert.id)!.status).toBe('open');
    // 恢复在岗：这件事接着做，林舟被叫醒，唤醒摘要里带着选定的办法。
    const reinstated = await fix.hub.api.answerInbox(alert.id, 'reinstate');
    expect(reinstated, JSON.stringify(reinstated)).toMatchObject({ ok: true });
    expect(bot(fix, fix.engineer.id).lifecycle).toBe('active');
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'doing', blocked: null });
    // 候选可能还在队列里，也可能已经放行成唤醒单：两处合起来恰好有一条新的，摘要在那一条里。
    const summaries = [...entriesOf(fix, fix.engineer.id, job.id).map(row => row.reason.summary),
      ...wakesOf(fix, fix.engineer.id, job.id).slice(engineerWakes).map(row => row.reason.summary)];
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain(`主人为这件事选了办法「${A.title}」：${A.detail}`);
    expect(summaries[0]).toContain('你已恢复在岗，接着做「会员定价页」');
  });

  it('反例：主人选的办法是换人：总管只用包里的文字换成在岗的小周，这件事接着做，不受林舟还停用着的影响', async () => {
    const { fix, job, card } = await escalated();
    expect((await fix.hub.api.answerInbox(card.id, card.options[1]!)).ok).toBe(true);
    // 主人选了不带改动的办法：总管被主人的话叫醒，看到主人选了什么。
    const packet = await (async () => {
      for (let i = 0; i < 3 && !wakesOf(fix, fix.chief.id).some(row => row.status === 'running'); i += 1) await tick(fix, 10 * MINUTE);
      return lastPacket(fix, bot(fix, fix.chief.id));
    })();
    const text = sectionOf(packet);
    expect(text).toContain(`主人为这件事选了办法「${B.title}」：${B.detail}`);
    const jobId = /换执行者：调用 hub_job_manage，mode 写 reassign，jobId 写 (job_[0-9a-z]{10})，executor 写新执行者的名字/.exec(text)?.[1];
    expect(jobId).toBe(job.id);
    const staff = /当前在岗的员工：(.+?)。/.exec(text)![1]!;
    expect(staff).toContain('小周');
    expect(staff).not.toContain('林舟');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId, executor: '小周' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const next = fix.ctx.store.table('jobs').get(job.id)!;
    expect(next).toMatchObject({ executorId: fix.extras[0]!.id, blocked: null });
    expect(['ready', 'doing', 'rework']).toContain(next.state);
    expect(bot(fix, fix.engineer.id).lifecycle).toBe('quarantined');
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.waitingOn).toBe('小周');
  });

  it('反例：停用的那位已经恢复在岗：这件事已经接着做，这张说明已失效，选办法被拒，状态不变', async () => {
    const { fix, job, card } = await escalated();
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    const before = fix.ctx.store.table('jobs').get(job.id)!;
    expect(before.blocked).toBeNull();
    const result = await fix.hub.api.answerInbox(card.id, card.options[0]!);
    expect(result.ok).toBe(false);
    expect(fix.ctx.store.table('jobs').get(job.id)).toEqual(before);
  });
});

describe('3 叫醒总管的原因，给主人看的那一句', () => {
  it('队列候选和唤醒单上给主人看的原因都是「林舟已被中心停用」', async () => {
    const { fix, job } = await running();
    await suspendByCredentials(fix, fix.engineer.id);
    const entries = entriesOf(fix, fix.chief.id, job.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.reason.ownerSummary).toBe('林舟已被中心停用');
    await chiefAwake(fix, job.id);
    const wake = wakesOf(fix, fix.chief.id, job.id).find(row => row.status === 'running')!;
    expect(wake.reason.ownerSummary).toBe('林舟已被中心停用');
  });

  it('反例：派活的叫醒原因没有被改动（总管交来一件事，等待开工）', async () => {
    const fix = await jobFix(['小周']);
    await assigned(fix);
    const entry = entriesOf(fix, fix.engineer.id)[0]!;
    expect(entry.reason.ownerSummary).toBe('总管交来一件事，等待开工');
  });
});
