/**
 * P74g 的测试：审批卡的三行（费用、能否撤回、批准之后）、审批的落点（属于一件事的落总管私聊）、不属于一件事的审批保持原样。
 *
 * 走真实 Hub 和真实工具；三行是员工写的、主人直接看到，含内部名称的一律拒绝提交（补充要求第 2 节）。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalCardPartsSchema, approvalNotesView, onBehalfOfText } from '../src/api/index.js';
import { commitAndEnd, wakesOf } from './p74c-fixtures.js';
import { jobFix, started, nextPacket, bot, callTool, theJob, threadOf, type JobFix } from './p74d-fixtures.js';
import { acceptedWithLaunch as acceptedForLaunch, launchArgs } from './p74g-launch-fixtures.js';

/** 林舟的 run_command 提交（可以不带三行）。 */
function submitArgs(fix: JobFix, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { cost: _cost, undo: _undo, after: _after, ...base } = launchArgs(fix);
  return { ...base, why: '跑一次整理脚本', ...extra };
}

describe('4 执行中途的审批：落总管私聊，前面一句总管的话，launch 不变', () => {
  it('林舟在做「会员定价页」时提交 C 类审批：总管私聊先有「林舟在做「会员定价页」，这一步需要你批准。」再有审批卡；三行都写「未说明」；批准后林舟被叫醒且带这件事', async () => {
    const { fix, job } = await started();
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', submitArgs(fix));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    // 发布状态不变；这件事仍在执行中。
    expect(theJob(fix)).toMatchObject({ state: 'doing', launch: { state: 'none', approvalId: null } });
    expect(fix.ctx.store.log('jobEvents').all().filter(row => row.kind === 'launch_requested')).toHaveLength(0);
    // 落点与前一句。
    const chiefThread = threadOf(fix.ctx, fix.chief.id);
    const cardIndex = chiefThread.findIndex(row => row.kind === 'approval');
    expect(chiefThread[cardIndex - 1]).toMatchObject({ from: fix.chief.id, kind: 'reply', text: '林舟在做「会员定价页」，这一步需要你批准。' });
    expect(threadOf(fix.ctx, fix.engineer.id).some(row => row.kind === 'approval')).toBe(false);
    // 旁表带 jobId，三项为空；视图里三行都是「未说明」。
    expect(fix.ctx.store.table('approvalNotes').get(approval.id)).toMatchObject({ jobId: job.id, cost: null, undo: null, after: null });
    const item = fix.hub.api.inbox().items.find(row => row.approvalId === approval.id)!;
    // P74r9：执行中途的普通审批、员工一行都没写：notes 为 null（界面不显示三行），「由林舟执行」不受影响。
    expect(item).toMatchObject({ botId: fix.chief.id, botName: '老大', approval: { notes: null, onBehalfOf: '由林舟执行' } });
    // 批准后林舟被叫醒，那一回合带着这件事（走执行链规则）。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '等批准' });
    // P74r18b 同步（第 1 节改了时机）：批准的那一刻不再叫醒他；命令由中心立刻运行，运行完之后叫醒他，唤醒原因是结果，同样带着这件事。
    fix.ctx.exec.set('node', ['work/go-live.js'], { code: 0, stdout: '已完成', stderr: '', timedOut: false });
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    await nextPacket(fix, fix.engineer.id);
    expect(wakesOf(fix, fix.engineer.id).at(-1)).toMatchObject({ jobId: job.id, reason: { kind: 'peer_message', summary: '你提交的动作已由中心运行成功：请中心代为运行一条命令。' } });
    // 批准结果记在总管私聊（审批卡所在的地方），不记在员工私聊。
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.from === 'hub' && row.kind === 'system' && row.refId === approval.id)).toBe(true);
    expect(threadOf(fix.ctx, fix.engineer.id).some(row => row.refId === approval.id)).toBe(false);
  });

  it('拒绝：这件事状态与 launch 都不变，林舟照常被叫醒（照现有审批的做法）', async () => {
    const { fix, job } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', submitArgs(fix))).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '等批准' });
    expect(await fix.hub.api.decideApproval(approval.id, false)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', launch: { state: 'none' } });
    await nextPacket(fix, fix.engineer.id);
    expect(wakesOf(fix, fix.engineer.id).at(-1)).toMatchObject({ jobId: job.id });
  });
});

describe('5 不带 jobId 的审批：落点、视图与改动前完全一致', () => {
  it('主人在林舟私聊里叫他做事，他申请审批：卡在林舟私聊、发送者是 Agent 中心、没有旁表、三行写未说明、没有「由谁执行」、候选不带 jobId', async () => {
    const fix = await jobFix();
    expect(await fix.hub.api.sendMessage(fix.engineer.id, '请帮我跑一次整理脚本')).toMatchObject({ ok: true });
    await nextPacket(fix, fix.engineer.id);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', submitArgs(fix))).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    expect(fix.ctx.store.table('approvalNotes').count()).toBe(0);
    const own = threadOf(fix.ctx, fix.engineer.id);
    expect(own.filter(row => row.kind === 'approval')).toHaveLength(1);
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.kind === 'approval')).toBe(false);
    // 没有总管名义的前置话。
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.from === fix.chief.id && row.text.includes('这一步需要你批准'))).toBe(false);
    const item = fix.hub.api.inbox().items.find(row => row.approvalId === approval.id)!;
    // P74r9：不属于一件事、员工也没写三行：notes 为 null。
    expect(item).toMatchObject({ botId: fix.engineer.id, botName: '林舟', approval: { notes: null, onBehalfOf: null } });
    const card = fix.hub.api.thread(fix.engineer.id).messages.find(row => row.kind === 'approval')!;
    expect(card.fromName).toBe('Agent 中心');
    // 主人消息唤醒的回合必须回复主人。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '等批准', reply: '已提交，等你批准后我再运行。' });
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    // 结果记在林舟私聊（原样）；跟进的唤醒不带 jobId。
    expect(threadOf(fix.ctx, fix.engineer.id).some(row => row.from === 'hub' && row.kind === 'system' && row.refId === approval.id)).toBe(true);
    await nextPacket(fix, fix.engineer.id);
    expect(wakesOf(fix, fix.engineer.id).at(-1)!.jobId ?? null).toBeNull();
  });

  it('不属于一件事、但员工填了费用：只写旁表（jobId 为空），视图显示员工写的项，没写的写未说明', async () => {
    const fix = await jobFix();
    await fix.hub.api.sendMessage(fix.engineer.id, '请帮我跑一次整理脚本');
    await nextPacket(fix, fix.engineer.id);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', submitArgs(fix, { cost: '不产生费用' }))).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    expect(fix.ctx.store.table('approvalNotes').get(approval.id)).toMatchObject({ jobId: null, cost: '不产生费用', undo: null, after: null });
    const item = fix.hub.api.inbox().items.find(row => row.approvalId === approval.id)!;
    expect(item.approval).toMatchObject({ notes: { cost: '不产生费用', undo: '未说明', after: '未说明' }, onBehalfOf: null });
    expect(item.botId).toBe(fix.engineer.id);
  });
});

describe('6 视图：三行与「由谁执行」', () => {
  it('approvalNotesView：C、D 类给出三项，缺的写「未说明」；其他类别为 null', () => {
    // P74r9：第三个参数是「是不是发布审批」。非发布审批员工写了至少一行给三行；一行都没写为 null；发布审批照旧给三行。
    expect(approvalNotesView('C', { cost: '不产生费用', undo: null, after: null }, false)).toEqual({ cost: '不产生费用', undo: '未说明', after: '未说明' });
    expect(approvalNotesView('D', null, false)).toBeNull();
    expect(approvalNotesView('D', null, true)).toEqual({ cost: '未说明', undo: '未说明', after: '未说明' });
    expect(approvalNotesView('C', { cost: 'a', undo: 'b', after: 'c' }, false)).toEqual({ cost: 'a', undo: 'b', after: 'c' });
    expect(approvalNotesView('A', { cost: 'a', undo: 'b', after: 'c' }, true)).toBeNull();
    expect(approvalNotesView('B', null, true)).toBeNull();
    expect(onBehalfOfText('林舟')).toBe('由林舟执行');
  });

  it('真实视图：带 jobId 的审批 notes、onBehalfOf、显示名都对，argsPreview（原始命令）仍在；整个审批卡能通过导出的 schema', async () => {
    const { fix } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { cost: '不产生费用', undo: '无法撤回', after: '立即生效' }))).toMatchObject({ ok: true });
    const item = fix.hub.api.inbox().items[0]!;
    expect(item.approval).toMatchObject({ notes: { cost: '不产生费用', undo: '无法撤回', after: '立即生效' }, onBehalfOf: '由林舟执行' });
    expect(item.approval!.argsPreview).toContain('go-live.js');
    expect(item.botName).toBe('老大');
    expect(ApprovalCardPartsSchema.safeParse(item.approval).success).toBe(true);
    const card = fix.hub.api.thread(fix.chief.id).messages.find(row => row.kind === 'approval')!;
    expect(card.fromName).toBe('老大');
    expect(ApprovalCardPartsSchema.safeParse(card.card!.approval).success).toBe(true);
    // 不带这两项的旧形状通不过 schema（字段一直都在）。
    const { notes: _notes, ...old } = item.approval!;
    expect(ApprovalCardPartsSchema.safeParse(old).success).toBe(false);
  });
});

describe('提交时三行的检查：含内部名称、超长、空白、换行都拒绝，什么都不留下', () => {
  it('cost、undo、after 里写工具名、内部编号、mode 的英文名：被拒并让员工改成白话；审批单、出站记录、旁表都没有产生', async () => {
    const { fix } = await started();
    const call = (extra: Record<string, unknown>) => callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, extra));
    const bads: Array<[string, string]> = [
      ['cost', '用 hub_outbox_submit 提交，不产生费用'], ['undo', '调用 hub_job_work 撤回'], ['after', '这件事 job_abcdefghij 上线'],
      ['cost', 'mode launched 之后收费'], ['undo', '把 jobId 改回去'], ['after', '请 b_abcdefghij 处理'],
    ];
    for (const [field, text] of bads) {
      const result = await call({ [field]: text });
      expect(result.ok, `${field}：${text}`).toBe(false);
      expect(result.error, `${field}：${text}`).toContain(`${field}：`);
      expect(result.error, `${field}：${text}`).toContain('内部名称');
    }
    for (const [field, text] of [['cost', ''], ['undo', '   '], ['after', '字'.repeat(81)], ['cost', '第一行\n第二行']] as const) {
      expect((await call({ [field]: text })).ok, `${field}：${JSON.stringify(text)}`).toBe(false);
    }
    expect(fix.ctx.store.table('approvals').count()).toBe(0);
    expect(fix.ctx.store.table('outbox').count()).toBe(0);
    expect(fix.ctx.store.table('approvalNotes').count()).toBe(0);
    expect(theJob(fix).launch.state).toBe('none');
    // 恰好 80 字、白话写法：通过。
    expect(await call({ cost: '字'.repeat(80) })).toMatchObject({ ok: true });
  });

  it('工具说明里写了 cost、undo、after，主人在审批卡上看得到；参数说明里有这三项', async () => {
    const fix = await jobFix();
    const tool = fix.hub.tools().find(item => item.name === 'hub_outbox_submit')!;
    expect(tool.description).toContain('对外发布、花钱、不可撤回的动作，填 cost、undo、after，主人在审批卡上看得到。');
    const properties = (tool.jsonSchema as { properties: Record<string, { description?: string }> }).properties;
    for (const name of ['cost', 'undo', 'after']) expect(properties[name]?.description, name).toContain('主人在审批卡上看到');
  });
});

describe('审批提交中途失败：审批单、出站记录、旁表、发布状态一起恢复', () => {
  it('发布准备时写事件失败：审批单、出站记录、旁表都撤回，这件事仍是 preparing，工具返回失败；之后重新提交成功', async () => {
    const { fix } = await acceptedForLaunch();
    await nextPacket(fix, fix.engineer.id);
    // 让「记 launch_requested 事件」失败一次：存储的 log() 每次返回新对象，所以替换 log 方法本身。
    const store = fix.ctx.store as unknown as { log: (name: string) => { append: (row: { kind?: string; data?: { approvalId?: string } }) => void } };
    const originalLog = store.log.bind(store);
    let failOnce = true;
    store.log = (name: string) => {
      const real = originalLog(name);
      if (name !== 'jobEvents') return real;
      return { ...real, append: row => {
        if (failOnce && row.kind === 'launch_requested' && row.data?.approvalId !== undefined) { failOnce = false; throw new Error('磁盘写满了'); }
        real.append(row);
      } };
    };
    const failed = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('审批没有记下，已恢复到申请前的状态');
    expect(theJob(fix).launch).toEqual({ state: 'preparing', approvalId: null, link: null });
    expect(fix.ctx.store.table('approvals').count()).toBe(0);
    expect(fix.ctx.store.table('outbox').count()).toBe(0);
    expect(fix.ctx.store.table('approvalNotes').count()).toBe(0);
    expect(fix.ctx.store.table('inbox').list(row => row.type === 'approval')).toHaveLength(0);
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.kind === 'approval')).toBe(false);
    // 再提交一次（磁盘恢复了）：成功，发布状态进入等批准。
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix))).toMatchObject({ ok: true });
    expect(theJob(fix).launch.state).toBe('approval');
  });
});
