/**
 * P74r9 第 1 节的测试：要不要对外发布、怎样发布，写成约定的一项内容（launch），由主人确认；派活时不再由总管另填 launchStep。
 *
 * 覆盖：
 * 1 新建约定带 launch：约定卡视图有那一行、约定文件有「对外发布」一节、派活不填 launchStep 这件事就有发布这一步、
 *   验收之后执行者被叫醒准备发布（唤醒包里有发布方式）；
 * 2 新建约定不带 launch：没有那一行、派活之后没有发布这一步、验收之后没有人被叫醒、也没有「下一步是对外发布」那句话；
 * 3 派活时 launchStep 填得与约定不一致（两个方向）被拒，文字逐字相同；一致或不填通过；
 * 4 修订：加上、改掉、去掉 launch 各一条，视图那一行和改动标记正确；进行中的事随新版本更新；已验收的不变；
 * 5 how 含内部名称、超过 120 字、多行被拒；
 * 6 只用唤醒包文字：按总管唤醒包里的文字构造一次带 launch 的新建约定和一次派活，都成功。
 * 全部走真实的 Hub，时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { launchOf } from '../src/model/agreement.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { FIXTURE_LAUNCH_HOW, assignArgs, commitAndEnd, entriesOf, wakesOf } from './p74c-fixtures.js';
import { chiefDrafts, jobFix, lockedAndAwake, ownerSays, speak } from './p74b-fixtures.js';
import { bot, callTool, delivered, nextPacket, started, theJob, threadOf } from './p74f-fixtures.js';

/** 该约定当前最新一版的约定卡视图。 */
function latestCard(fix: Awaited<ReturnType<typeof jobFix>>, agreementId: string) {
  const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
  return agreementCardView(fix.ctx, agreement, agreement.versions.at(-1)!);
}

describe('1 新建约定带 launch', () => {
  it('约定卡视图有那一行；约定文件有「对外发布」一节；派活不填 launchStep，这件事有发布这一步', async () => {
    const { fix, job, info } = await started([], { launch: true });
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    // 视图：那一行逐字，未改动。
    const view = latestCard(fix, job.agreementId);
    expect(view.launchLine).toBe(`验收之后对外发布：${FIXTURE_LAUNCH_HOW}。发布前单独请你批准。`);
    expect(view.launchChanged).toBe(false);
    // 存储：约定里记着 launch；这件事的 launchStep 由约定决定。
    expect(launchOf(agreement.versions.at(-1)!.content)).toEqual({ how: FIXTURE_LAUNCH_HOW });
    expect(job.launchStep).toBe(true);
    // 约定文件：加一节「对外发布」，写发布方式和「发布前由主人单独批准」。
    const file = await fix.ctx.fs.readText(`${info.jobDir}/约定.md`);
    expect(file).toContain(`## 对外发布\n${FIXTURE_LAUNCH_HOW}\n发布前由主人单独批准。`);
  });

  it('验收之后执行者被叫醒准备发布，唤醒包里有「约定里写的发布方式」', async () => {
    const { fix, job } = await delivered([], { launch: true });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    expect(theJob(fix).launch.state).toBe('preparing');
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(packet).toContain(`约定里写的发布方式：${FIXTURE_LAUNCH_HOW}`);
    // P74r7 加的那句仍然保留。
    expect(packet).toContain('约定和材料里没有写发布到哪里、用什么方式时：不要猜，也不要提问。');
  });
});

describe('2 新建约定不带 launch', () => {
  it('没有那一行；派活之后没有发布这一步；约定文件没有「对外发布」一节；验收后没有人被叫醒，也没有预告句', async () => {
    const { fix, job, info } = await started();
    const view = latestCard(fix, job.agreementId);
    expect(view.launchLine).toBeNull();
    expect(view.launchChanged).toBe(false);
    expect(job.launchStep).toBe(false);
    expect(await fix.ctx.fs.readText(`${info.jobDir}/约定.md`)).not.toContain('## 对外发布');
    // 验收：走完交回、核对、交付之后点验收通过。
    const done = await delivered();
    const before = wakesOf(done.fix, done.fix.engineer.id, done.job.id).length;
    expect(await done.fix.hub.api.acceptJob({ jobId: done.job.id, stage: done.job.stage })).toMatchObject({ ok: true });
    expect(theJob(done.fix)).toMatchObject({ state: 'done', launchStep: false, launch: { state: 'none' } });
    expect(entriesOf(done.fix, done.fix.engineer.id, done.job.id)).toHaveLength(0);
    expect(wakesOf(done.fix, done.fix.engineer.id, done.job.id)).toHaveLength(before);
    const texts = threadOf(done.fix.ctx, done.job.topicId).map(row => row.text);
    expect(texts).toContain('已记为完成。');
    expect(texts.some(text => text.includes('下一步是对外发布'))).toBe(false);
  });
});

/** 派活被拒的固定文字（逐字）。 */
const refusal = (written: boolean) => `launchStep：不用填。这件事有没有发布这一步，由约定里的对外发布一项决定；这份约定${written ? '写了对外发布' : '没有写对外发布'}。要改，先改约定请主人确认。`;

describe('3 派活时 launchStep 与约定不一致', () => {
  it('约定写了发布、launchStep 填 false：被拒，文字逐字相同，没有建这件事', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix, undefined, { launch: { how: FIXTURE_LAUNCH_HOW } }));
    const result = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id, { launchStep: false }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(refusal(true));
    expect(fix.ctx.store.table('jobs').list()).toHaveLength(0);
  });

  it('约定没有写发布、launchStep 填 true：被拒，文字逐字相同，没有建这件事', async () => {
    const fix = await jobFix();
    const id = agreementIdIn(await lockedAndAwake(fix));
    const result = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id, { launchStep: true }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(refusal(false));
    expect(fix.ctx.store.table('jobs').list()).toHaveLength(0);
  });

  it('填得一致（写了发布填 true）或不填：通过，记录上 launchStep 照约定写', async () => {
    const same = await jobFix();
    const sameId = agreementIdIn(await lockedAndAwake(same, undefined, { launch: { how: FIXTURE_LAUNCH_HOW } }));
    expect(await callTool(same, same.chief, 'hub_job_manage', assignArgs(sameId, { launchStep: true }))).toMatchObject({ ok: true });
    expect(theJob(same).launchStep).toBe(true);
    const omitted = await jobFix();
    const omittedId = agreementIdIn(await lockedAndAwake(omitted));
    expect(await callTool(omitted, omitted.chief, 'hub_job_manage', assignArgs(omittedId, { launchStep: undefined }))).toMatchObject({ ok: true });
    expect(theJob(omitted).launchStep).toBe(false);
  });
});

/** 总管在主人又说了一句话之后调用约定提交（先结束上一回合，再让主人说一句）。 */
async function chiefAfterOwnerWords(fix: Awaited<ReturnType<typeof jobFix>>, words: string, args: Record<string, unknown>) {
  await speak(fix, bot(fix, fix.chief.id), '已记下。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, words);
  return callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', args);
}

describe('4 修订 launch', () => {
  it('待确认时：加上、改掉、去掉各一版，视图那一行和「本版改动」标记正确', async () => {
    const fix = await jobFix();
    const id = await chiefDrafts(fix as never, { title: '会员定价页' });
    expect(latestCard(fix, id)).toMatchObject({ launchLine: null, launchChanged: false });
    // 加上。
    expect(await chiefAfterOwnerWords(fix, '做完发布到测试站点', { mode: 'revise', agreementId: id, changeNote: '加上对外发布', launch: { how: '发布到测试站点' } })).toMatchObject({ ok: true });
    expect(latestCard(fix, id)).toMatchObject({ versionNo: 2, launchLine: '验收之后对外发布：发布到测试站点。发布前单独请你批准。', launchChanged: true });
    expect(fix.ctx.store.table('agreements').get(id)!.versions[1]!.changes).toEqual([{ section: 'launch', kind: 'added' }]);
    // 改掉。
    expect(await chiefAfterOwnerWords(fix, '改成发布到正式站点', { mode: 'revise', agreementId: id, changeNote: '改发布位置', launch: { how: '发布到正式站点' } })).toMatchObject({ ok: true });
    expect(latestCard(fix, id)).toMatchObject({ versionNo: 3, launchLine: '验收之后对外发布：发布到正式站点。发布前单独请你批准。', launchChanged: true });
    expect(fix.ctx.store.table('agreements').get(id)!.versions[2]!.changes).toEqual([{ section: 'launch', kind: 'changed' }]);
    // 不写 launch 的修订：沿用，不标改动。
    expect(await chiefAfterOwnerWords(fix, '一句话再准一点', { mode: 'revise', agreementId: id, changeNote: '一句话更准确', summary: '做一个能查看会员定价的小页面' })).toMatchObject({ ok: true });
    expect(latestCard(fix, id)).toMatchObject({ versionNo: 4, launchLine: '验收之后对外发布：发布到正式站点。发布前单独请你批准。', launchChanged: false });
    // 去掉：写 null。
    expect(await chiefAfterOwnerWords(fix, '先不发布了', { mode: 'revise', agreementId: id, changeNote: '去掉对外发布', launch: null })).toMatchObject({ ok: true });
    expect(latestCard(fix, id)).toMatchObject({ versionNo: 5, launchLine: '这一版去掉了对外发布这一步。', launchChanged: true, removed: [], removedUnlisted: 0 });
    expect(fix.ctx.store.table('agreements').get(id)!.versions[4]!.changes).toEqual([{ section: 'launch', kind: 'removed' }]);
  });

  // P74r13 第 1 节改了预期：原来断言「amend 能加上、去掉 launch，launchStep 随之更新」；
  // 现在对外发布只能经主人确认的修订来改，amend 加上 launch 被拒，launchStep 不变（去掉、改写的拒绝见 p74r13-launch-clause.test.ts）。
  it('进行中的事（还没有验收）：amend 加上 launch 被拒，这件事的 launchStep 不变', async () => {
    const { fix, job } = await started();
    expect(job.launchStep).toBe(false);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, '做完发布到测试站点');
    const added = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'amend', agreementId: job.agreementId, changeNote: '加上对外发布', launch: { how: '发布到测试站点' } });
    expect(added.ok).toBe(false);
    expect(added.error).toContain('amend 不能改「对外发布」');
    await flushJobHooks(fix.ctx);
    expect(theJob(fix).launchStep).toBe(false);
  });

  it('进行中的事重新请主人确认：主人确认新版本之后 launchStep 才更新', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, '做完发布到测试站点');
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'revise', agreementId: job.agreementId, changeNote: '加上对外发布',
      launch: { how: '发布到测试站点' }, continuing: ['报价列表页'], paused: ['发布相关的部分'] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).launchStep).toBe(false);
    await speak(fix, bot(fix, fix.chief.id), '这件事加了发布，等你确认。', { outcome: 'needs_owner' });
    expect(await fix.hub.api.confirmAgreement({ agreementId: job.agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(theJob(fix).launchStep).toBe(true);
  });

  // P74r13 第 2 节改了预期：原来断言「已验收的事约定去掉 launch，发布状态保持准备中不动」（且用 amend 去掉）；
  // 现在去掉对外发布只能走 revise 经主人确认，确认之后发布这一步随之结束（launchStep 仍保持原样，发布状态变为暂不发布）。
  it('已验收的事：约定经主人确认去掉 launch，发布这一步随之结束（launchStep 不动，发布状态变为暂不发布）', async () => {
    const { fix, job } = await delivered([], { launch: true });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const accepted = theJob(fix);
    expect(accepted).toMatchObject({ launchStep: true, launch: { state: 'preparing' } });
    await ownerSays(fix, fix.chief.id, '先不发布了');
    const removed = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'revise', agreementId: job.agreementId, changeNote: '去掉对外发布', launch: null });
    expect(removed, JSON.stringify(removed)).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '去掉发布的这一版等你确认。', { outcome: 'needs_owner' });
    expect(await fix.hub.api.confirmAgreement({ agreementId: job.agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(theJob(fix)).toMatchObject({ launchStep: true, launch: { state: 'declined', endedBy: 'owner' } });
  });
});

describe('5 how 的检查', () => {
  it('含内部名称、超过 120 字、多行、空白：各被拒，约定没有新版本', async () => {
    const fix = await jobFix();
    const id = await chiefDrafts(fix as never, { title: '会员定价页' });
    const cases: Array<[string, string, string]> = [
      ['含内部名称', '用 hub_outbox_submit 发布到站点', '这句话主人直接看到，不能出现工具名、内部编号这类内部名称'],
      ['超过 120 字', '发'.repeat(121), '不能超过 120 字'],
      ['多行', '发布到站点\n再通知大家', '写成一行，不要换行'],
      ['空白', '   ', '不能为空'],
    ];
    for (const [label, how, text] of cases) {
      const result = await chiefAfterOwnerWords(fix, `发布方式：${label}`, { mode: 'revise', agreementId: id, changeNote: '加上对外发布', launch: { how } });
      expect(result.ok, label).toBe(false);
      expect(result.error, label).toContain(text);
      expect(fix.ctx.store.table('agreements').get(id)!.versions, label).toHaveLength(1);
    }
    // 恰好 120 字通过。
    const ok = await chiefAfterOwnerWords(fix, '发布方式：一百二十字', { mode: 'revise', agreementId: id, changeNote: '加上对外发布', launch: { how: '发'.repeat(120) } });
    expect(ok).toMatchObject({ ok: true });
  });
});

describe('6 只用唤醒包文字', () => {
  it('按总管唤醒包里的文字：带 launch 新建约定，主人定了之后只照包里的话派活（不填 launchStep），都成功', async () => {
    const fix = await jobFix();
    // 总管第一回合的唤醒包：守则里写明了 launch 的用法。
    const first = await lockedAndAwake(fix, undefined, { launch: { how: '发布到 /tmp/p74k-site' } });
    // P74r13 第 15 节改了预期：这一句后面加了「只写发布到哪里、用什么方式，不写「发布前请你批准」这类话（约定卡上中心会加）」。
    expect(first).toContain('在约定的 launch 里写清发布到哪里、用什么方式（一行字，只写发布到哪里、用什么方式，不写「发布前请你批准」这类话（约定卡上中心会加））');
    expect(first).toContain('约定里没有 launch 的事，验收之后没有发布这一步，不要对主人说「发布前会请你批准」');
    // 「刚由主人确认」那一行里写明了对外发布一项；在岗员工那一行写明 launchStep 不用填。
    expect(first).toContain('对外发布：发布到 /tmp/p74k-site（验收之后对外发布，发布前中心单独请主人批准）');
    expect(first).toContain('launchStep 不用填：验收之后有没有对外发布这一步，由约定里的对外发布一项（launch）决定。');
    // 只照包里的话派活：agreementId、executor 名字、reviewer、dueAt，不写 launchStep。
    const id = agreementIdIn(first);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'assign', agreementId: id, executor: '林舟', reviewer: '评审甲', dueAt: '2026-11-17 18:00' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).launchStep).toBe(true);
  });
});
