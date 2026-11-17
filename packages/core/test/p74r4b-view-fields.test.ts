/**
 * P74r4b 第 5、6 节的测试：视图字段。
 * 第 5 节：审批卡视图 ApprovalCardParts.launch（这张审批是不是某件事发布这一步的审批；总管私聊里的审批卡与「待你处理」里这一条两处都带）。
 * 第 6 节：「待你处理」条目视图的 jobEntry（这是一件事的哪一类条目），按事项键判断，与 answerJobInbox 分流同一套判断。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalCardPartsSchema, isLaunchApproval } from '../src/api/index.js';
import { isJobInboxItem, jobEntryOf } from '../src/job/inbox-answer.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { bot, callTool, nextPacket } from './p74f-fixtures.js';
import { jobFix, started } from './p74d-fixtures.js';
import { acceptedWithLaunch, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';
import { wakeForLaunch } from '../src/job/launch-approval.js';import type { JobFix } from './p74f-fixtures.js';

/** 「待你处理」里某张审批对应的那一项。 */
const inboxItemOf = (fix: JobFix, approvalId: string) => fix.hub.api.inbox().items.find(row => row.approvalId === approvalId)!;
/** 总管私聊里某张审批的卡片消息（线程视图里的卡）。 */
const threadCardOf = (fix: JobFix, approvalId: string) => fix.hub.api.thread(fix.chief.id).messages.find(row => row.card?.approvalId === approvalId)?.card;

describe('5 审批卡视图：launch 标明这张审批是不是发布审批', () => {
  it('发布这一步的审批：launch 为真，「待你处理」和总管私聊里的卡两处都带；整个审批卡通过导出的 schema', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    const item = inboxItemOf(fix, approval.id);
    expect(item.approval?.launch).toBe(true);
    expect(threadCardOf(fix, approval.id)?.approval?.launch).toBe(true);
    expect(ApprovalCardPartsSchema.parse(item.approval)).toMatchObject({ launch: true, onBehalfOf: '由林舟执行' });
  });

  it('同一件事在执行中提交的审批（属于这件事但不是发布这一步）：launch 为假', async () => {
    const { fix } = await started();
    const { cost: _c, undo: _u, after: _a, ...plain } = launchArgs(fix);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { ...plain, why: '跑一次整理脚本' })).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    expect(fix.ctx.store.table('approvalNotes').get(approval.id)!.jobId).not.toBeNull(); // 属于这件事
    expect(inboxItemOf(fix, approval.id).approval).toMatchObject({ launch: false, onBehalfOf: '由林舟执行' });
    expect(threadCardOf(fix, approval.id)?.approval?.launch).toBe(false);
  });

  it('与任何事无关的审批：launch 为假', async () => {
    const fix = await jobFix();
    await fix.hub.api.sendMessage(fix.engineer.id, '请帮我跑一次整理脚本');
    await nextPacket(fix, fix.engineer.id);
    const { cost: _c, undo: _u, after: _a, ...plain } = launchArgs(fix);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { ...plain, why: '跑一次整理脚本' })).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    expect(inboxItemOf(fix, approval.id).approval).toMatchObject({ launch: false, onBehalfOf: null });
  });

  // P74r6（N10）改了预期：原来断言第二张审批的 launch 为真；现在只有这件事记下的那一张发布审批为真，第二张为假（拒绝它不影响发布状态）。
  it('这件事已完成之后提交的第二张发布审批：launch 为假（只有记下的那一张为真）', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval: first } = await submitLaunch(fix);
    // P74r18b 同步：批准的那一刻不再叫醒执行者（第 1 节改了时机），而批准之后命令会被中心运行（运行完发布状态就不是「等批准」了），
    // 就不能再用「批准第一张」来叫醒执行者：这里不批准，由中心直接叫执行者一次（排上之后他拿到一个带这件事的回合，才能提交第二张审批）。
    // 第一张仍记在这件事的发布状态上，第二张不是它，这一点不变。
    wakeForLaunch(fix.ctx, fix.ctx.store.table('jobs').get(job.id)!);
    await nextPacket(fix, fix.engineer.id);
    const home = bot(fix, fix.engineer.id).homeDir;
    // P74r19 同步（第 1 节，原意：发布环节的第二张审批 launch 为假；新结论）：这件事已有一条发布命令在等批准时，
    // 第二条没带 replace 被直接拒绝（不建审批，也就没有第二张卡）；带 replace: true 时第二条取代第一条、自己成为发布审批（launch 为真），
    // 被取代的第一张已作废、launch 变为假。「只有发布状态记下的那一张为真」这一点不变。
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { why: '再发布一次', payload: { cmd: 'node', args: ['work/go-live-2.js'], cwd: home } }));
    expect(refused).toMatchObject({ ok: false });
    expect(fix.ctx.store.table('approvals').list()).toHaveLength(1);
    expect(inboxItemOf(fix, first.id).approval?.launch).toBe(true);
    const second = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { why: '再发布一次', replace: true, payload: { cmd: 'node', args: ['work/go-live-2.js'], cwd: home } }));
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'done' });
    const secondApproval = fix.ctx.store.table('approvals').list().find(row => row.id !== first.id)!;
    expect(inboxItemOf(fix, secondApproval.id).approval?.launch).toBe(true);
    expect(threadCardOf(fix, secondApproval.id)?.approval?.launch).toBe(true);
    expect(threadCardOf(fix, first.id)?.approval?.launch).toBe(false);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '等批准' });
  });

  it('判断函数：没有这件事、没有发布这一步、没有验收、审批早于验收都为假；验收之后为真', () => {
    // P74r6（N10）改了预期：判断函数多了一条——只对这件事记下的那一张发布审批（launch.approvalId）为真；原来的测试没有 id 和 launch，现在补上。
    const launch = { state: 'approval' as const, approvalId: 'ap1', link: null };
    const job = { launchStep: true, acceptedAt: 1000, launch };
    const ap = (createdAt: number, id = 'ap1') => ({ id, createdAt });
    expect(isLaunchApproval(null, ap(2000))).toBe(false);
    expect(isLaunchApproval({ launchStep: false, acceptedAt: 1000, launch }, ap(2000))).toBe(false);
    expect(isLaunchApproval({ launchStep: true, acceptedAt: null, launch }, ap(2000))).toBe(false);
    expect(isLaunchApproval(job, ap(999))).toBe(false);
    expect(isLaunchApproval(job, ap(1000))).toBe(true);
    expect(isLaunchApproval(job, ap(5000))).toBe(true);
    // 不是这件事记下的那一张（别的审批、发布这一步结束之后新提交的）为假。
    expect(isLaunchApproval(job, ap(5000, 'ap2'))).toBe(false);
    expect(isLaunchApproval({ ...job, launch: { state: 'done', approvalId: 'ap1', link: null } }, ap(5000, 'ap9'))).toBe(false);
  });
});

describe('6 「待你处理」条目视图：jobEntry 写明它是一件事的哪一类条目', () => {
  /** 往收件箱直接放一条（视图是存储行的纯函数，不需要走完整流程）。 */
  function put(fix: JobFix, id: string, subjectKey: string, type: 'question' | 'approval' | 'proposal' | 'alert' = 'question') {
    fix.ctx.store.table('inbox').put({ id, botId: fix.chief.id, type, title: subjectKey, body: '', options: ['确认'], defaultOption: null, priority: 'P1', refId: null,
      subjectKey, status: 'open', answer: null, pushed: false, createdAt: fix.ctx.clock.now(), expiresAt: null, answeredAt: null } as never);
  }
  const entryOf = (fix: JobFix, id: string) => fix.hub.api.inbox().items.find(row => row.id === id)!.jobEntry;

  it('四类条目各一条：kind 和 jobId 正确（含带修订号的三轮不过条目）', async () => {
    const fix = await jobFix();
    put(fix, 'i_aaaaaaaaa1', 'job:job_aaaaaaaaaa:accept:2');
    put(fix, 'i_aaaaaaaaa2', 'job:job_bbbbbbbbbb:escalate:1');
    put(fix, 'i_aaaaaaaaa3', 'job:job_cccccccccc:escalate:3~2');
    put(fix, 'i_aaaaaaaaa4', 'job:job_dddddddddd:cap:16');
    put(fix, 'i_aaaaaaaaa5', 'job:job_eeeeeeeeee:stall:7');
    expect(entryOf(fix, 'i_aaaaaaaaa1')).toEqual({ kind: 'accept', jobId: 'job_aaaaaaaaaa' });
    expect(entryOf(fix, 'i_aaaaaaaaa2')).toEqual({ kind: 'escalate', jobId: 'job_bbbbbbbbbb' });
    expect(entryOf(fix, 'i_aaaaaaaaa3')).toEqual({ kind: 'escalate', jobId: 'job_cccccccccc' });
    expect(entryOf(fix, 'i_aaaaaaaaa4')).toEqual({ kind: 'cap', jobId: 'job_dddddddddd' });
    expect(entryOf(fix, 'i_aaaaaaaaa5')).toEqual({ kind: 'stall', jobId: 'job_eeeeeeeeee' });
  });

  it('约定确认、组队卡、审批、普通提问的条目没有这个字段；事项键像一件事、但不是提问类的条目也没有', async () => {
    const fix = await jobFix();
    put(fix, 'i_bbbbbbbbb1', 'agreement:agr_zzzzzzzzzz:1');
    put(fix, 'i_bbbbbbbbb2', 'team:prp_zzzzzzzzzz');
    put(fix, 'i_bbbbbbbbb3', 'approval:ap_zzzzzzzzzz', 'approval');
    put(fix, 'i_bbbbbbbbb4', 'ask:随便问一句');
    put(fix, 'i_bbbbbbbbb5', 'job:job_aaaaaaaaaa:accept:1', 'proposal');
    put(fix, 'i_bbbbbbbbb6', 'job:job_aaaaaaaaaa:other:1');
    put(fix, 'i_bbbbbbbbb7', 'job:job_short:cap:1');
    for (const id of ['i_bbbbbbbbb1', 'i_bbbbbbbbb2', 'i_bbbbbbbbb3', 'i_bbbbbbbbb4', 'i_bbbbbbbbb5', 'i_bbbbbbbbb6', 'i_bbbbbbbbb7']) {
      const item = fix.hub.api.inbox().items.find(row => row.id === id)!;
      expect(item, id).toBeDefined();
      expect(item.jobEntry ?? null, id).toBeNull();
    }
  });

  it('与回答分流同一套判断：jobEntryOf 与 isJobInboxItem 对同一批事项键结论一致', () => {
    const keys: Array<[string, 'question' | 'proposal']> = [
      ['job:job_aaaaaaaaaa:accept:1', 'question'], ['job:job_aaaaaaaaaa:escalate:1~2', 'question'], ['job:job_aaaaaaaaaa:cap:8', 'question'],
      ['job:job_aaaaaaaaaa:stall:1', 'question'], ['job:job_aaaaaaaaaa:accept:1', 'proposal'], ['job:job_aaaaaaaaaa:foo:1', 'question'],
      ['agreement:x', 'question'], ['team:x', 'question'], ['job:bad:cap:1', 'question'],
    ];
    for (const [subjectKey, type] of keys) {
      expect(jobEntryOf({ type, subjectKey }) !== null, `${type} ${subjectKey}`).toBe(isJobInboxItem({ type, subjectKey }));
    }
  });
});
