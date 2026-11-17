/**
 * P74b 的测试：hub_job_manage 的派活（assign）与改派（reassign）。
 * 其中第一组是方案要求的「只用唤醒包里的文字就能派活成功」：参数里的约定编号、员工名字、条目序号
 * 都用正则从总管这一回合收到的唤醒包文本里取，不偷看存储。
 * 为什么走真实 Hub：工具、启动整理、调度闸门都挂在真实链路上；不用人为调高分值的候选，也不用跳过整理的仿真世界。
 * 时间全部用注入的假时钟。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { eventsOf } from '../src/job/store.js';
import { isJobMaintainedPath, renderAgreementFile, renderOwnerWordsFile, renderSketchFile } from '../src/job/files.js';
import { staffWorkload } from '../src/team/workload.js';
import { agreementFixture, contentFixture, versionFixture } from './p72a-agreement-fixtures.js';
import { HubJobManageInputSchema } from '../src/tools/hub-job-manage.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { wakeTicket } from './p72a-agreement-fixtures.js';
import {
  MINUTE, assignArgs, callTool, chiefDraftsAnother, chiefHasLockedAnother, doneCountIn, jobFix, lockedAndAwake, speak, staffIn,
  stateSnapshot, threadOf, type JobFix,
} from './p74b-fixtures.js';

/** 给主人看的文字里不许出现的内部名称。 */
const INTERNAL = /hub_|b_|job_|agr_/;

/** 项目文件夹里的文本（相对路径）；不存在为 null。 */
async function fileOf(fix: JobFix, projectId: string, rel: string): Promise<string | null> {
  const project = fix.ctx.store.table('projects').get(projectId)!;
  return fix.ctx.fs.readText(`${project.sharedDir.replace(/\/+$/, '')}/${rel}`);
}

describe('只用唤醒包里的文字：派活成功', () => {
  it('1 取唤醒包里的约定编号、条数、员工名字，调用 hub_job_manage 一次成功', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    // 只从文本里取值。
    const agreementId = agreementIdIn(packet);
    const count = doneCountIn(packet);
    const staff = staffIn(packet);
    const engineer = staff.find(row => row.name === '林舟')!;
    const reviewer = staff.find(row => row.duty === '评审')!;
    expect(count).toBe(3);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'assign', agreementId, executor: engineer.name, reviewer: reviewer.name,
      // P74r7：交付时核对的条目原文必须写了时间；夹具第 1 条带「今天」，第 3 条没有，所以改指定第 1 条。
      dueAt: '2026-11-17 18:00', deliveryItems: [1], launchStep: false,
    });
    expect(result).toEqual({ ok: true, text: `已派给${engineer.name}，${reviewer.name}核对。` });

    // 2 记录、成员、文件、三句话、唤醒。
    const job = fix.ctx.store.table('jobs').list()[0]!;
    expect(job).toMatchObject({ state: 'ready', stage: 1, round: 0, turnsUsed: 0, executorId: fix.engineer.id, reviewerId: fix.reviewer!.id, deliveryItems: [1], launchStep: false, folder: `jobs/${job.id}` });
    // P76e：预算线按预计：首次估计 9 个回合（对齐 1、执行 3、核对 1、返工预留 3、总管 1）减去已用的对齐 1 个，等于 8。
    expect(job.turnCap).toBe(8);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    expect(fix.ctx.store.table('projects').get(agreement.projectId)!.memberBotIds).toEqual(expect.arrayContaining([fix.engineer.id, fix.reviewer!.id]));
    // 三份文件和三个子文件夹。
    const agreementFile = (await fileOf(fix, job.projectId, `${job.folder}/约定.md`))!;
    expect(agreementFile).toContain('# 会员定价页（约定第 1 版）');
    expect(await fileOf(fix, job.projectId, `${job.folder}/原话.md`)).toContain('## 第 1 版依据（');
    expect(await fileOf(fix, job.projectId, `${job.folder}/草图.md`)).toContain('[标题] 每日报价');
    for (const name of ['材料', '交付', '证据']) {
      const dir = `${fix.ctx.store.table('projects').get(job.projectId)!.sharedDir.replace(/\/+$/, '')}/${job.folder}/${name}`;
      expect((await fix.ctx.fs.stat(dir))?.isDir).toBe(true);
    }
    // 「怎样算做完」的编号与唤醒包一致。
    const section = agreementFile.split('## 怎样算做完\n')[1]!.split('\n').filter(Boolean);
    expect(section).toHaveLength(count);
    for (const row of section) expect(packet).toContain(row);
    // 主题一句、总管私聊一句、工作往来一条。
    const topic = threadOf(fix.ctx, agreement.topicId);
    const said = topic.find(row => row.from === fix.chief.id && row.kind === 'reply' && row.refId === job.id)!;
    // P74r9 第 5 节：括号里是岗位名称（组队时的岗位「工程师」），不再是岗位类别（原来写成「林舟（执行）执行」）。
    expect(said.text).toBe(`这件事由${engineer.name}（工程师）执行，${reviewer.name}在交付前对照约定核对。我已把你的原话、草图和约定第 1 版作为文件交给${engineer.name}。`);
    const assigned = eventsOf(fix.ctx, job.id).filter(row => row.kind === 'assigned');
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ actor: fix.chief.id, to: [fix.engineer.id, fix.reviewer!.id], data: { versionNo: 1 } });
    const work = topic.find(row => row.from === 'hub' && row.kind === 'work')!;
    expect(work.refId).toBe(assigned[0]!.id);
    expect(work.text).toBe(`总管把这件事交给${engineer.name}：约定第 1 版、你的原话和草图在主题文件夹里。`);
    const note = threadOf(fix.ctx, fix.chief.id).find(row => row.from === 'hub' && row.kind === 'system' && row.text.includes('接手'))!;
    expect(note.text).toBe(`${engineer.name}接手「会员定价页」，进展记在这件事的主题里。`);
    for (const text of [said.text, work.text, note.text]) expect(text).not.toMatch(INTERNAL);

    // 林舟的唤醒候选带这件事的标记，并通过全部调度闸门。
    const entry = fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id)[0]!;
    // P74c：执行链候选靠 jobId 越过冷却与最短思考间隔，不再带 chiefDispatch 标记。
    expect(entry).toMatchObject({ jobId: job.id, subjectKey: `jobwake:${job.id}:${fix.engineer.id}` });
    expect(entry.chiefDispatch).toBeUndefined();
    // 假时钟：时间过去 10 分钟（越过启动静默），林舟 5 分钟前刚思考过；总管当天已有一次非主人发起的回合。
    fix.ctx.clock.advance(10 * MINUTE);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lastThinkAt: fix.ctx.clock.now() - 5 * MINUTE });
    fix.ctx.store.table('wakes').put(wakeTicket(fix.ctx, fix.chief.id, { kind: 'next_think', evidence: [] },
      { ownerInitiated: false, status: 'committed', startedAt: fix.ctx.clock.now() - 60 * MINUTE, endedAt: fix.ctx.clock.now() - 55 * MINUTE }));
    // 主人离开超过 10 分钟后（此时允许两位同时思考），总管的回合还开着，林舟的候选也通过全部闸门。
    fix.ctx.runtime.ownerActiveAt = fix.ctx.clock.now() - 11 * MINUTE;
    const now = fix.ctx.clock.now();
    const verdict = evaluateGates(entry, buildSnapshot(fix.ctx, fix.engineer.id, now, entry.jobId), now, fix.ctx.settings);
    expect(verdict, JSON.stringify(verdict)).toEqual({ pass: true });
    // 真实调度：总管交账结束这一回合后，林舟有了唤醒单。
    await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    expect(fix.ctx.store.table('wakes').count(row => row.botId === fix.engineer.id)).toBe(1);
  });

  it('参数里 reviewer 写「总管」或省略，都由总管自己核对；主题那句话不提评审员', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementIdIn(packet), { reviewer: '总管' }));
    expect(result).toEqual({ ok: true, text: '已派给林舟，你自己核对。' });
    const job = fix.ctx.store.table('jobs').list()[0]!;
    expect(job.reviewerId).toBeNull();
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    const said = threadOf(fix.ctx, agreement.topicId).find(row => row.kind === 'reply' && row.from === fix.chief.id)!;
    expect(said.text).toContain('我在交付前对照约定核对。');
    // 评审员没有被加进项目成员。
    expect(fix.ctx.store.table('projects').get(job.projectId)!.memberBotIds).not.toContain(fix.reviewer!.id);
  });

  // P74e：hub_job_manage 加了 answer、forward、stop、resume 四个 mode，原断言「只有两个」按任务卡改为六个。
  it('工具参数的 mode 是 assign、reassign，以及 P74e 加入的 answer、forward、stop、resume', () => {
    const shape = HubJobManageInputSchema.shape.mode;
    // P74f：又加了 reopen（主人指出不符），预期按任务卡加一个。
    // P74f-2：又加了 escalate（卡住时向主人说明办法）。
    expect(shape.options).toEqual(['assign', 'reassign', 'answer', 'forward', 'stop', 'resume', 'reopen', 'escalate']);
  });
});

describe('派活校验：全部在写入之前，被拒时零写入', () => {
  /** 被拒后的断言：返回失败、错误含期望文字、没有任何写入。 */
  async function expectRejected(fix: JobFix, agreementId: string, args: Record<string, unknown>, text: string | RegExp, caller = fix.chief): Promise<void> {
    const before = stateSnapshot(fix.ctx, fix, agreementId, fix.engineer.id);
    const result = await callTool(fix, caller, 'hub_job_manage', args);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.error).toMatch(text);
    expect(stateSnapshot(fix.ctx, fix, agreementId, fix.engineer.id)).toEqual(before);
  }

  it('3 非总管、复盘回合、非主人发起的回合被拒', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    await expectRejected(fix, id, assignArgs(id), '只有总管能派活', fix.engineer);
    // 总管所在回合不是主人发起的。
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: false });
    await expectRejected(fix, id, assignArgs(id), '派活只能在主人发话、确认或回答叫醒的回合里进行');
    // 复盘回合只读。
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: true, variant: 'reflection' });
    await expectRejected(fix, id, assignArgs(id), '反思回合只读');
  });

  it('3 约定待确认、不是自己的、不存在、已有一件事，各被拒且文字正确', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    // 待确认：总管再提交一份新约定，它还没定。
    const pendingId = await chiefDraftsAnother(fix, '新周报页');
    await expectRejected(fix, pendingId, assignArgs(pendingId), '约定「新周报页」还在等主人确认，确认前不能派活。');
    // 不是自己的：把约定改到别人名下。
    const other = fix.ctx.store.table('agreements').get(id)!;
    fix.ctx.store.table('agreements').put({ ...other, botId: fix.engineer.id });
    await expectRejected(fix, id, assignArgs(id), 'agreementId：只能为你名下已固定的约定派活');
    fix.ctx.store.table('agreements').put(other);
    await expectRejected(fix, id, assignArgs('agr_zzzzzzzzzz'), 'agreementId：只能为你名下已固定的约定派活');
    // 已有一件事：先派一次，再派一次。
    expect((await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id))).ok).toBe(true);
    const job = fix.ctx.store.table('jobs').list()[0]!;
    await expectRejected(fix, id, assignArgs(id), `这份约定已经交给林舟了（jobId 为 ${job.id}），要换人用 mode reassign`);
  });

  it('3 缺必填项一次列全', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    await expectRejected(fix, id, { mode: 'assign' }, '缺少必填项：agreementId、executor、dueAt（mode 为 assign 时都要填写）');
  });

  it('4 执行者是总管、不在岗、写错名字（报错列出在岗员工）；核对人是执行者本人，各被拒', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    await expectRejected(fix, id, assignArgs(id, { executor: '老大' }), 'executor：总管不能当执行者');
    await expectRejected(fix, id, assignArgs(id, { executor: '不存在的人' }), /executor：没有叫「不存在的人」的员工。在岗的员工：林舟（.+）、评审甲（.+）。写名字即可/);
    await expectRejected(fix, id, assignArgs(id, { reviewer: '林舟' }), 'reviewer：核对人不能是执行者本人');
    await expectRejected(fix, id, assignArgs(id, { reviewer: '老大' }), 'reviewer：由你自己核对时写「总管」');
    // 不在岗：停用林舟。
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    await expectRejected(fix, id, assignArgs(id), 'executor：「林舟」当前不在岗');
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'active' });
    fix.ctx.store.table('bots').patch(fix.reviewer!.id, { lifecycle: 'paused' });
    await expectRejected(fix, id, assignArgs(id), 'reviewer：「评审甲」当前不在岗');
  });

  it('5 交付时间早于现在、条目序号越界或重复，各被拒；同一条主人消息派两次，第二次被拒', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    await expectRejected(fix, id, assignArgs(id, { dueAt: '2026-11-01 09:00' }), 'dueAt：交付时间必须晚于现在');
    await expectRejected(fix, id, assignArgs(id, { dueAt: '下周三' }), /dueAt/);
    await expectRejected(fix, id, assignArgs(id, { deliveryItems: [4] }), 'deliveryItems：序号 4 不在「怎样算做完」的范围内（1 到 3）');
    await expectRejected(fix, id, assignArgs(id, { deliveryItems: [0] }), /deliveryItems：序号 0/);
    await expectRejected(fix, id, assignArgs(id, { deliveryItems: [2, 2] }), 'deliveryItems：序号不能重复');
    // 同一条主人消息派两次：第二份约定是同一回合里另外固定的。
    const second = await chiefHasLockedAnother(fix, '周报页');
    expect((await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id))).ok).toBe(true);
    await expectRejected(fix, second, assignArgs(second, { executor: '评审甲', reviewer: '总管' }), '主人的这句话已经派过一件事了');
  });
});

describe('第一段失败时全部恢复', () => {
  it('6 建文件夹抛错：一件事、成员、主题与私聊消息、林舟队列都不变，工具返回失败', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    const before = stateSnapshot(fix.ctx, fix, id, fix.engineer.id);
    const original = fix.ctx.fs.mkdirp.bind(fix.ctx.fs);
    const spy = vi.spyOn(fix.ctx.fs, 'mkdirp').mockImplementation(async (path, boundary) => {
      if (path.includes('/jobs/')) throw new Error('磁盘已满');
      return original(path, boundary);
    });
    const result = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id));
    spy.mockRestore();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('派活失败，已恢复到派活前的状态：磁盘已满');
    expect(stateSnapshot(fix.ctx, fix, id, fix.engineer.id)).toEqual(before);
    // 失败之后可以重新派活，并成功。
    expect((await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id))).ok).toBe(true);
  });

  it('6 写文件抛错：已建的文件夹也被删掉', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const project = fix.ctx.store.table('projects').get(agreement.projectId)!;
    const original = fix.ctx.fs.writeTextAtomic.bind(fix.ctx.fs);
    const spy = vi.spyOn(fix.ctx.fs, 'writeTextAtomic').mockImplementation(async (path, text, boundary) => {
      if (path.endsWith('原话.md')) throw new Error('写入失败');
      return original(path, text, boundary);
    });
    const result = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id));
    spy.mockRestore();
    expect(result.ok).toBe(false);
    expect(await fix.ctx.fs.list(`${project.sharedDir.replace(/\/+$/, '')}/jobs`)).toEqual([]);
  });

  it('7 入队失败（林舟在入队前被停用）：同第 6 条全部恢复，工具返回失败且说明原因', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    const before = stateSnapshot(fix.ctx, fix, id, fix.engineer.id);
    const original = fix.ctx.fs.writeTextAtomic.bind(fix.ctx.fs);
    // 写第一份文件时让林舟被停用：校验已经通过，入队时他已不在岗。
    const spy = vi.spyOn(fix.ctx.fs, 'writeTextAtomic').mockImplementation(async (path, text, boundary) => {
      await original(path, text, boundary);
      fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    });
    const result = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id));
    spy.mockRestore();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('派活失败，已恢复到派活前的状态：没有排上林舟的队');
    const after = stateSnapshot(fix.ctx, fix, id, fix.engineer.id);
    // 林舟被停用是测试自己做的，其余都与派活前一致。
    expect({ ...after, bot: { ...after.bot!, lifecycle: 'active' } }).toEqual({ ...before, bot: { ...before.bot!, lifecycle: 'active' } });
    expect(fix.ctx.store.table('queue').count(row => row.botId === fix.engineer.id)).toBe(0);
  });
});

describe('改派', () => {
  it('14 旧执行者队列里这件事的候选被丢弃，新执行者被叫醒并成为成员；改派给核对人被拒', async () => {
    const fix = await jobFix(['小周']);
    const id = agreementIdIn(await lockedAndAwake(fix));
    // 主人刚说完话，全队只允许一位思考：林舟的候选留在队列里，等总管交账之后才放行。
    expect((await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id))).ok).toBe(true);
    const job = fix.ctx.store.table('jobs').list()[0]!;
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id && row.jobId === job.id)).toHaveLength(1);
    const memberCountBefore = fix.ctx.store.table('projects').get(job.projectId)!.memberBotIds.length;

    // 改派给核对人被拒；改派给本来就在做的人被拒；不是主人发起的回合被拒。
    const denied = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '评审甲' });
    expect(denied).toMatchObject({ ok: false, error: 'executor：新执行者不能是这件事的核对人' });
    const same = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '林舟' });
    expect(same.ok).toBe(false);
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: false });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' }))
      .toMatchObject({ ok: false, error: '改派只能在主人发话、确认或回答叫醒的回合里进行' });
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: true });
    // jobId 写错：报错列出手上的事。
    const wrong = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: 'job_zzzzzzzzzz', executor: '小周' });
    expect(wrong.error).toContain(`「会员定价页」（jobId 为 ${job.id}）`);

    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(result).toEqual({ ok: true, text: '已改派给小周。' });
    const newcomer = fix.extras[0]!;
    expect(fix.ctx.store.table('jobs').get(job.id)!.executorId).toBe(newcomer.id);
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id && row.jobId === job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('queue').list(row => row.botId === newcomer.id && row.jobId === job.id)).toHaveLength(1);
    expect(fix.ctx.store.table('projects').get(job.projectId)!.memberBotIds).toContain(newcomer.id);
    expect(fix.ctx.store.table('projects').get(job.projectId)!.memberBotIds).toHaveLength(memberCountBefore + 1);
    expect(eventsOf(fix.ctx, job.id).map(row => row.kind)).toEqual(['assigned', 'reassigned']);
    const topic = threadOf(fix.ctx, job.topicId);
    const line = topic.filter(row => row.from === 'hub' && row.kind === 'work').at(-1)!;
    expect(line.text).toBe('总管把这件事改派给小周。');
    expect(line.text).not.toMatch(INTERNAL);
    // 新执行者随后被真实调度叫醒（越过启动静默和全局放行间隔，这两道闸不在总管派活的豁免之内）。
    fix.ctx.clock.advance(10 * MINUTE);
    await speak(fix, fix.chief, '已改派给小周。', { outcome: 'progress' });
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    expect(fix.ctx.store.table('wakes').count(row => row.botId === newcomer.id)).toBe(1);
  });

  it('14 受阻原因是有人停用时，改派同时解除受阻', async () => {
    const fix = await jobFix(['小周']);
    const id = agreementIdIn(await lockedAndAwake(fix));
    expect((await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id))).ok).toBe(true);
    const job = fix.ctx.store.table('jobs').list()[0]!;
    fix.ctx.store.table('jobs').put({ ...job, state: 'blocked', blocked: { kind: 'participant_off', no: null, text: '林舟已停用', since: fix.ctx.clock.now(), resumeTo: 'ready' } });
    expect((await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).ok).toBe(true);
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'ready', blocked: null });
  });

  it('14 状态不允许时拒绝改派', async () => {
    const fix = await jobFix(['小周']);
    const id = agreementIdIn(await lockedAndAwake(fix));
    expect((await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id))).ok).toBe(true);
    const job = fix.ctx.store.table('jobs').list()[0]!;
    fix.ctx.store.table('jobs').patch(job.id, { state: 'checking' });
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(result).toMatchObject({ ok: false, error: '这件事当前是「核对中」，只有待开工、执行中、返工中、受阻时才能改派' });
  });
});

describe('取不到主人消息 id 时按唤醒单去重', () => {
  it('主人发起的回合找不到对应的主人消息，同一个回合第二次派活仍被拒', async () => {
    const fix = await jobFix();
    const first = agreementIdIn(await lockedAndAwake(fix));
    const second = await chiefHasLockedAnother(fix, '周报页');
    // 把唤醒理由改成不指向主人消息，其余（主人发起）不变：此时只能按唤醒单 id 去重。
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { reason: { ...wake.reason, kind: 'drive' }, ownerDirect: false });
    expect((await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(first))).ok).toBe(true);
    const again = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(second, { executor: '评审甲', reviewer: '总管' }));
    expect(again).toMatchObject({ ok: false, error: '主人的这句话已经派过一件事了，同一句话只派一次；要换人用 mode reassign' });
  });
});

describe('主题文件的内容', () => {
  /** 一份已固定的约定（待定项带上主人的选择）。 */
  function lockedFixture() {
    const content = contentFixture();
    content.pending = content.pending.map(item => ({ ...item, chosen: item.suggested }));
    return agreementFixture({ state: 'locked', versions: [versionFixture(1, { state: 'locked', lockedAt: 1000, content })] });
  }

  it('约定文件：标题加七节，后四节逐条编号从 1 起，待定项写已定的选择', () => {
    const agreement = lockedFixture();
    const text = renderAgreementFile(agreement, agreement.versions[0]!);
    expect(text).toContain('# 每日报价页（约定第 1 版）');
    for (const title of ['## 一句话', '## 草图', '## 待你定（已定）', '## 我已定的', '## 这次做', '## 这次不做', '## 怎样算做完']) expect(text).toContain(title);
    expect(text).toContain('1. 报价从哪里取：公开接口\n2. 多久刷新一次：每天');
    expect(text).toContain('## 我已定的\n1. 只做网页，不做手机端');
    expect(text).toContain('## 这次做\n1. 报价列表页\n2. 手动刷新');
    expect(text).toContain('## 这次不做\n1. 历史曲线');
    expect(text).toContain('## 怎样算做完\n1. 打开页面能看到今天的报价\n2. 点刷新后数据更新\n3. 接口失败时有提示');
  });

  it('草图文件：页面逐屏逐块带待定项序号；流程逐步；概念先节点再连线', () => {
    const pending = contentFixture().pending;
    const page = renderSketchFile(contentFixture().sketch, pending);
    expect(page).toContain('### 第 1 屏：报价页');
    expect(page).toContain('- [标题] 每日报价');
    expect(page).toContain('- [列表] 报价列表（对应待你定第 1 项）');
    expect(page).toContain('- [按钮] 刷新（对应待你定第 2 项）');
    const flow = renderSketchFile({ layout: 'flow', steps: [{ text: '打开页面', actor: '用户', mark: 1 }, { text: '点刷新', note: '每天一次' }, { text: '看到新数据' }] }, pending);
    expect(flow).toBe('1. [用户] 打开页面（对应待你定第 1 项）\n2. 点刷新（每天一次）\n3. 看到新数据');
    const concept = renderSketchFile({ layout: 'concept', nodes: [{ id: 'a', text: '报价源', mark: 2 }, { id: 'b', text: '页面' }], links: [{ from: 'a', to: 'b', text: '每日拉取' }] }, pending);
    expect(concept).toBe('节点：\n- a：报价源（对应待你定第 2 项）\n- b：页面\n连线：\n- a -> b：每日拉取');
  });

  it('原话文件：每一版依据的主人原话带时间；找不到原话的版本写固定说明', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    const real = fix.ctx.store.table('agreements').get(id)!;
    const words = renderOwnerWordsFile(fix.ctx, real);
    expect(words).toMatch(/## 第 1 版依据（11月5日 10:00）\n帮我做个每日报价页/);
    // 这一版本来就没有来源消息（主人在 DSH 会话里直接说的）：写固定说明。
    const direct = { ...real, versions: [{ ...real.versions[0]!, sourceMessageId: null }] };
    expect(renderOwnerWordsFile(fix.ctx, direct)).toContain('（主人在 DSH 会话里直接说的，没有存下原文）');
    // P74r1（R8）：有来源消息但日志里已经找不到（超出保留范围），写「原话记录已超出保留范围，以约定为准」，不再误称是直接说的。
    const missing = { ...real, versions: [{ ...real.versions[0]!, sourceMessageId: 'm_0000000000' }] };
    expect(renderOwnerWordsFile(fix.ctx, missing)).toContain('原话记录已超出保留范围，以约定为准');
  });

  it('主题文件名与禁止覆盖的判断：只认约定.md、原话.md、草图.md 和材料', () => {
    for (const rel of ['jobs/job_1/约定.md', 'jobs/job_1/原话.md', 'jobs/job_1/草图.md', 'jobs/job_1/材料', 'jobs/job_1/材料/a/b.png', 'jobs/job_1/约定.MD', 'jobs/job_1/交付/../约定.md']) {
      expect(isJobMaintainedPath(rel), rel).toBe(true);
    }
    for (const rel of ['jobs/job_1/交付/x.md', 'jobs/job_1/证据/约定.md', 'jobs/约定.md', 'notes/约定.md', 'context.md', 'jobs/job_1/约定.md.bak']) {
      expect(isJobMaintainedPath(rel), rel).toBe(false);
    }
  });
});

describe('员工手上的活把一件事算进去', () => {
  it('执行者和核对人的在办件数各加一，最近做过的项目取这件事所在的项目；收尾后不再计入', async () => {
    const fix = await jobFix();
    expect(staffWorkload(fix.ctx, fix.engineer.id)).toEqual({ openCount: 0, lastProjectName: null });
    const id = agreementIdIn(await lockedAndAwake(fix));
    expect((await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id))).ok).toBe(true);
    const job = fix.ctx.store.table('jobs').list()[0]!;
    const projectName = fix.ctx.store.table('projects').get(job.projectId)!.name;
    expect(staffWorkload(fix.ctx, fix.engineer.id)).toEqual({ openCount: 1, lastProjectName: projectName });
    expect(staffWorkload(fix.ctx, fix.reviewer.id)).toEqual({ openCount: 1, lastProjectName: projectName });
    fix.ctx.store.table('jobs').patch(job.id, { state: 'done' });
    expect(staffWorkload(fix.ctx, fix.engineer.id).openCount).toBe(0);
    // 收尾的事仍然算「最近做过的项目」。
    expect(staffWorkload(fix.ctx, fix.engineer.id).lastProjectName).toBe(projectName);
  });
});
