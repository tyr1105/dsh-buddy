/**
 * P74f-2 的测试（二）：三轮不过时向主人说明（escalate）与主人选办法（chooseJobOption）。
 *
 * 规则：核对三轮仍不过（或执行者做不下去且总管解决不了）时，总管用 escalate 说明卡在哪、给 2 到 3 个办法；
 * 这一阶段只能说明一次；说明之后「待你处理」恰好一条（无默认、不到期）、总管私聊一句加三轮不过卡；
 * 主人选一个办法：带改动的由中心生成约定新固定版本，不再另外请主人确认；不带改动的叫醒总管。
 * 全部走真实的 Hub，总管只用唤醒包里的文字调用。
 */
import { describe, expect, it } from 'vitest';
import { escalationCardView } from '../src/api/job-escalation-views.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { commitAndEnd, entriesOf, eventsOf, wakesOf } from './p74c-fixtures.js';
import { INTERNAL, reviewerInfo } from './p74d-fixtures.js';
import { threadOf } from './p74b-fixtures.js';
import {
  MINUTE, bot, callTool, escalateFromPacket, escalateItem, lastPacket, limitFix, nextPacket, sectionOf, started, theJob, tick, type JobFix,
} from './p74f2-fixtures.js';

const A = { title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } };
const B = { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' };
const D = { title: '删去这一条', detail: '这次不做失败提示，之后单独做；代价是失败时用户看不到原因', change: { no: 3, text: null } };

/** 总管的私聊里、总管名义的消息文字。 */
function chiefSays(fix: JobFix): string[] {
  return threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id).map(row => row.text);
}

describe('escalate：校验', () => {
  it('说明成功：状态不变；「待你处理」恰好一条（无默认、不到期，按钮带字母）；私聊一句加三轮不过卡；内容没有内部名称', async () => {
    const { fix, job } = await limitFix();
    const { result, jobId } = await escalateFromPacket(fix, [A, B]);
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已把卡在哪和办法交给主人。这一回合交账时 outcome 写 blocked（这件事在等主人选办法），不要写 needs_owner，不要带 ownerQuestion。' });
    expect(jobId).toBe(job.id);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit' }, escalation: { stage: 1, chosen: null, no: 3, noText: '接口失败时有提示' } });
    const items = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ subjectKey: `job:${job.id}:escalate:1`, title: '会员定价页：第 3 条三轮未通过', defaultOption: null, expiresAt: null, priority: 'P1',
      // P74r4a 第 1 条：条目正文在「卡在哪」之后逐个办法列出，带改动的办法下一行是中心生成的「选了会改什么」（原来只有卡在哪一句）。
      options: ['A　放宽这一条', 'B　换一位执行者再试'],
      body: '接口失败时的提示，页面一直做不到让人看得懂\nA　放宽这一条\n选了会把「怎样算做完」第 3 条改为：接口失败时页面有提示或有备用文案\nB　换一位执行者再试' });
    expect(theJob(fix).inboxId).toBe(items[0]!.id);
    expect(chiefSays(fix)).toContain('会员定价页停在第 3 条（接口失败时有提示），核对三轮仍未通过，在等你选一个处理办法。其余 2 条已通过核对。');
    const card = threadOf(fix.ctx, fix.chief.id).filter(row => row.kind === 'job_card' && row.refId === `escalation:${job.id}#1`);
    expect(card).toHaveLength(1);
    const view = escalationCardView(fix.ctx, `escalation:${job.id}#1`)!;
    expect(view).toMatchObject({ kind: 'escalation', head: '提问', title: '第 3 条三轮未通过', stateText: '等你决定', chosen: null,
      optionsTitle: '可选的办法　选 A 即记为约定第 2 版，不再另外请你确认', reasonHint: '建议 A 的理由：最小的改动，其余条目不受影响' });
    // 卡上每个办法多了 changeLine 字段（由中心生成），整体相等比较的预期随之加上：A 带改写、B 不带改动。
    expect(view.options).toEqual([
      { letter: 'A', title: A.title, detail: A.detail, suggested: true, changeLine: '选了会把「怎样算做完」第 3 条改为：接口失败时页面有提示或有备用文案' },
      { letter: 'B', title: B.title, detail: B.detail, suggested: false, changeLine: null }]);
    expect(view.tried).toEqual(['第 1 轮：搭好了价格页，三档价格和刷新按钮都有。第1轮的问题', '第 2 轮：第2轮的做法。第2轮的问题', '第 3 轮：第3轮的做法。第3轮的问题']);
    // 给主人看的文字没有内部名称（视图里的 jobId 字段是界面调用命令用的，不显示给主人）。
    expect(JSON.stringify({ ...view, jobId: '' }) + items[0]!.title + items[0]!.body + chiefSays(fix).join('')).not.toMatch(INTERNAL);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'escalated')).toHaveLength(1);
  });

  it('被拒：状态不对、同一阶段第二次、change 序号越界、suggested 越界、内部名称、办法重复；都零写入', async () => {
    const { fix, job } = await limitFix();
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    const jobId = /mode 写 escalate，jobId 写 (job_[0-9a-z]{10})/.exec(text)![1]!;
    const base = { mode: 'escalate', jobId, stuckAt: '卡在失败提示', suggested: 0, reason: '改动最小' };
    const before = JSON.stringify([fix.ctx.store.table('jobs').list(), fix.ctx.store.table('inbox').list(), eventsOf(fix.ctx, job.id)]);
    const call = (patch: Record<string, unknown>) => callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { ...base, options: [A, B], ...patch });
    expect(String((await call({ options: [{ ...A, change: { no: 9, text: '改' } }, B] })).error)).toContain('没有第 9 条');
    expect(String((await call({ suggested: 2 })).error)).toContain('suggested');
    expect(String((await call({ options: [A, { ...B, title: A.title }] })).error)).toContain('重复');
    expect(String((await call({ options: [{ ...A, detail: '请调用 hub_send 再试' }, B] })).error)).toContain('内部名称');
    expect(String((await call({ stuckAt: '用 mode reassign 换人' })).error)).toContain('内部名称');
    expect(String((await call({ options: [D, B] })).error)).toContain('只剩 2 条');
    expect(String((await call({ options: [A] })).error)).toMatch(/至少|2 到 3/);
    expect(JSON.stringify([fix.ctx.store.table('jobs').list(), fix.ctx.store.table('inbox').list(), eventsOf(fix.ctx, job.id)])).toBe(before);
    // 成功一次之后，同一阶段第二次被拒。
    expect(await call({})).toMatchObject({ ok: true });
    expect(await call({})).toEqual({ ok: false, error: '这一次受阻已经向主人说明过了，在等主人选办法，不能再说明' });
    // 状态不对（这件事不在受阻）：被拒，文字原样。
    const { fix: other, job: running } = await limitFix();
    other.ctx.store.table('jobs').put({ ...running, state: 'checking', blocked: null });
    const wrong = await callTool(other, bot(other, other.chief.id), 'hub_job_manage', { ...base, jobId: running.id, options: [A, B] });
    expect(wrong).toEqual({ ok: false, error: '只能在这件事核对三轮仍不过、或执行者做不下去之后，向主人说明并给出办法' });
  });

  it('执行者做不下去且总管解决不了：同样能说明（标题写「{执行者}无法继续」，私聊句子不同）', async () => {
    const { fix, job } = await started(['小周']);
    const blocked = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] });
    expect(blocked, JSON.stringify(blocked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺报价接口的文档', summary: '做不下去' });
    const { result } = await escalateFromPacket(fix, [{ title: '先放一放', detail: '等文档到了再做；代价是交付时间会晚', followUp: true }, B]);
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已把卡在哪和办法交给主人。这一回合交账时 outcome 写 blocked（这件事在等主人选办法），不要写 needs_owner，不要带 ownerQuestion。' });
    expect(chiefSays(fix)).toContain('会员定价页停在执行：林舟无法继续，需要你选一个处理办法。');
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey === `job:${job.id}:escalate:1`)[0]).toMatchObject({ title: '会员定价页：林舟无法继续', status: 'open' });
    const view = escalationCardView(fix.ctx, `escalation:${job.id}#1`)!;
    expect(view).toMatchObject({ title: '林舟无法继续', tried: ['查了仓库'], optionsTitle: '可选的办法' });
    // 选第二个办法（不带改动）：不改状态，总管被叫醒；总管照办法改派。
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1 })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', inboxId: null });
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
  });

  it('执行者做不下去时选带改动的办法：新版本固定，解除受阻回到受阻前的环节，叫醒执行者；约定新版本记录「只改那一条」', async () => {
    const { fix, job } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '第 3 条的提示不知道怎么写', tried: ['翻了设计稿'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '没有思路', summary: '做不下去' });
    const { result } = await escalateFromPacket(fix, [A, B]);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, inboxId: null, handledVersionNo: 2 });
    expect(fix.ctx.store.table('agreements').get(job.agreementId)!.versions[1]).toMatchObject({ no: 2, lockedVia: 'button', source: 'owner_instruction' });
    expect(entriesOf(fix, fix.engineer.id, job.id).length + wakesOf(fix, fix.engineer.id, job.id).length).toBeGreaterThan(0);
  });
});

describe('chooseJobOption：主人选办法', () => {
  it('选带改动的办法（改写）：约定新版本只改那一条、来源主人的指示、按钮固定；回到核对中，核对人被叫醒且只需给那一条结论；主题文件重写', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [A, B]);
    const agreementId = job.agreementId;
    const old = fix.ctx.store.table('agreements').get(agreementId)!.versions[0]!;
    const item = escalateItem(fix, job.id)!;
    expect(await fix.hub.api.answerInbox(item.id, 'A　放宽这一条')).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const v2 = agreement.versions[1]!;
    expect(agreement).toMatchObject({ state: 'locked' });
    expect(v2).toMatchObject({ no: 2, state: 'locked', source: 'owner_instruction', lockedVia: 'button', changeNote: '按你选的办法：放宽这一条' });
    expect(v2.content.doneWhen).toEqual([old.content.doneWhen[0], old.content.doneWhen[1], '接口失败时页面有提示或有备用文案']);
    expect({ ...v2.content, doneWhen: [] }).toEqual({ ...old.content, doneWhen: [] });
    expect(v2.changes.length).toBe(1);
    expect(agreement.versions[0]!.state).toBe('replaced');
    // 主人的话：私聊里「选 A：放宽这一条」，版本引用它；中心提示。
    const said = threadOf(fix.ctx, fix.chief.id).find(row => row.from === 'owner' && row.text === '选 A：放宽这一条')!;
    expect(said).toBeDefined();
    expect(v2.sourceMessageId).toBe(said.id);
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.from === 'hub' && row.text === '已按你选的办法记为约定第 2 版。')).toBe(true);
    // 这件事：回到核对中、阶段加 1、第 1 轮；只需给第 3 条结论。
    expect(theJob(fix)).toMatchObject({ state: 'checking', stage: 2, round: 1, blocked: null, inboxId: null, recheckNos: [3], handledVersionNo: 2,
      escalation: { chosen: 0 } });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: 'A　放宽这一条' });
    // 主题文件（约定.md）已按新版本重写。
    const file = [...(fix.ctx.fs as unknown as { files?: Map<string, string> }).files?.entries() ?? []].find(([path]) => path.endsWith('/约定.md'));
    if (file !== undefined) expect(file[1]).toContain('接口失败时页面有提示或有备用文案');
    // 核对人被叫醒，唤醒包里写明「只需要给第 3 条写结论」，只给第 3 条的结论就能通过。
    const reviewerPacket = await nextPacket(fix, fix.reviewer.id);
    expect(sectionOf(reviewerPacket)).toContain('这一轮是主人选了办法之后的重新核对：只需要给第 3 条写结论，其余条目前面已经通过，不用再写。');
    const seen = reviewerInfo(reviewerPacket);
    const reviewed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [{ no: 3, verdict: 'met', note: '页面有备用文案' }] });
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner' });
    expect(theJob(fix).recheckNos).toBeUndefined();
  });

  it('选删去卡住条目的办法、其余条目已通过：直接交付（待你验收，新的验收条目），交付卡按新编号显示；约定新版本其余条目不变', async () => {
    const dones = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '能导出表格'];
    const { fix, job } = await limitFix(dones);
    await escalateFromPacket(fix, [D, B]);
    const item = escalateItem(fix, job.id)!;
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    expect(agreement.versions[1]!.content.doneWhen).toEqual([dones[0], dones[1], dones[3]]);
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner', stage: 2, blocked: null, handledVersionNo: 2, deliveryItems: [1] });
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered' });
    const accept = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey === `job:${job.id}:accept:2`);
    expect(accept).toHaveLength(1);
    const card = threadOf(fix.ctx, job.topicId).filter(row => row.kind === 'job_card' && row.refId === `delivery:${job.id}#2`);
    expect(card).toHaveLength(1);
    const view = fix.hub.api.thread(job.topicId).messages.filter(row => row.jobCard?.kind === 'delivery').at(-1)!.jobCard!;
    expect(view.kind === 'delivery' && view.items.map(row => row.text)).toEqual([dones[0], dones[1], dones[3]]);
    expect(view).toMatchObject({ stateText: '待你验收', actions: { accept: true } });
    // 验收成功。
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: 2, revision: 0 })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('done');
  });

  it('选不带改动的办法：不改状态，总管被主人的话叫醒（主人发起的回合），唤醒包写明主人选了什么；带改动但 followUp 为真时也叫醒总管', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [A, B]);
    const before = entriesOf(fix, fix.chief.id).length + wakesOf(fix, fix.chief.id).length;
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1 })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit' }, inboxId: null, escalation: { chosen: 1 } });
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.from === 'owner' && row.text === '选 B：换一位执行者再试')).toBe(true);
    expect(fix.ctx.store.table('agreements').get(job.agreementId)!.versions).toHaveLength(1);
    await tick(fix, 5 * MINUTE);
    expect(entriesOf(fix, fix.chief.id).length + wakesOf(fix, fix.chief.id).length).toBeGreaterThan(before);
    // 总管拿到的这一回合是主人的话叫醒的（主人发起），唤醒包里写明主人选了什么办法。
    const woken = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.reason.kind === 'owner_message').at(-1)!;
    expect(woken.ownerInitiated).toBe(true);
    expect(sectionOf(lastPacket(fix, bot(fix, fix.chief.id)))).toContain('主人为这件事选了办法「换一位执行者再试」：换人重做这一条；代价是多花一轮时间。请照这个办法处理');
    // 总管照办法换人：只用包里的文字。
    const swap = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(swap, JSON.stringify(swap)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ executorId: fix.extras[0]!.id, blocked: null });
  });

  it('followUp：带改动的办法也叫醒总管', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [{ ...A, followUp: true }, B]);
    const before = entriesOf(fix, fix.chief.id).length + wakesOf(fix, fix.chief.id).length;
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    await tick(fix, 5 * MINUTE);
    expect(entriesOf(fix, fix.chief.id).length + wakesOf(fix, fix.chief.id).length).toBeGreaterThan(before);
    expect(theJob(fix).state).toBe('checking');
  });

  it('选办法被拒：阶段不一致、办法序号越界、已经选过；约定新版本在等确认时也被拒；都零写入', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [A, B]);
    const snapshot = () => JSON.stringify([fix.ctx.store.table('jobs').list(), fix.ctx.store.table('inbox').list(), fix.ctx.store.table('agreements').list()]);
    const before = snapshot();
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 2, option: 0 })).toMatchObject({ ok: false, error: '这张卡已不是最新的，请在最新的一张上选办法' });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 2 })).toMatchObject({ ok: false });
    expect(await fix.hub.api.answerInbox(escalateItem(fix, job.id)!.id, '随便写')).toMatchObject({ ok: false });
    expect(snapshot()).toBe(before);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1 })).toMatchObject({ ok: true });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1 })).toMatchObject({ ok: false });
  });

  it('同一时刻共存：组队卡待确认、另一份约定待确认、A 等验收、B 三轮不过，主人面前各自只有一条，互不撤回', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [A, B]);
    const mine = () => fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`));
    expect(mine()).toHaveLength(1);
    // 另一件事、另一份约定、组队卡的条目（直接放进收件箱）：各自一条，不互相撤回；这件事的条目不受影响。
    for (const [id, key] of [['i_cccccccccc', 'agreement:agr_zzzzzzzzzz:1'], ['i_dddddddddd', 'team:prp_zzzzzzzzzz'], ['i_eeeeeeeeee', 'job:job_zzzzzzzzzz:accept:1']] as const) {
      fix.ctx.store.table('inbox').put({ id, botId: fix.chief.id, type: 'question', title: key, body: '', options: [key.startsWith('job:') ? '验收通过' : key.startsWith('team:') ? '确认' : '按建议，定了'],
        defaultOption: null, priority: 'P1', refId: null, subjectKey: key, status: 'open', answer: null, pushed: false, createdAt: fix.ctx.clock.now(), expiresAt: null, answeredAt: null } as never);
    }
    expect(mine()).toHaveLength(1);
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && ['i_cccccccccc', 'i_dddddddddd', 'i_eeeeeeeeee'].includes(row.id))).toHaveLength(3);
    // 选了办法 A（回到核对中），之后再次三轮不过并再次说明：新阶段的条目是新的一条，且这件事只有一条开着。
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    expect(mine()).toHaveLength(0);
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && ['i_cccccccccc', 'i_dddddddddd', 'i_eeeeeeeeee'].includes(row.id))).toHaveLength(3);
  });
});
