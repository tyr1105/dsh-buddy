/**
 * P72b 派活闸门的测试（P74b 改为按事情区分）：
 * 一份约定还在等主人确认时，这件事的派活（hub_job_manage 的 assign）和它所在主题里总管 reply 的 @ 被拦；
 * 别的事、非总管、主人自己的操作都不受影响。
 * P74b 之前这里测的是「总管名下有待确认约定，hub_send、hub_handoff、指派事务、主题里 @ 一律被拒」，
 * 现在 hub_handoff 已移出工具清单，hub_send 与事务指派改受另外的规则约束（见 p74b-gates.test.ts），所以这里按新预期重写。
 */
import { describe, expect, it } from 'vitest';
import { dispatchBlockFor } from '../src/project/agreement-gate.js';
import {
  callTool, chiefDrafts, floors, lockAgreement, openTopic, ownerSays, queued, runningWake, setup, speak, type Fix,
} from './p72b-fixtures.js';

/** 总管在「季度战役」项目里提交约定（约定有自己的主题），并交账结束私聊回合；返回约定编号和它的主题。 */
async function draftedInProject(fix: Fix): Promise<{ agreementId: string; topicId: string }> {
  await chiefDrafts(fix, { projectId: fix.project.id });
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  const agreement = fix.ctx.store.table('agreements').list()[0]!;
  return { agreementId: agreement.id, topicId: agreement.topicId };
}

// P74r1（R1）恢复：总管名下有等主人确认的新约定（或组队卡）时，hub_send 一律被拒（P74b 曾放宽为照常成功，那是审查发现的缺口）。
describe('闸门：hub_send', () => {
  it('总管有待确认约定时被拒，文字含约定标题', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    const result = await callTool(fix, fix.chief, 'hub_send', { to: fix.wang.id, text: '开工吧' });
    expect(result).toMatchObject({ ok: false, error: '约定「每日报价页」还在等主人确认，确认前不能叫员工动手。' });
    expect(fix.ctx.store.log('thread').all().some(row => row.kind === 'peer')).toBe(false);
  });
  it('没有待确认约定时正常发出', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '你看看');
    expect(await callTool(fix, fix.chief, 'hub_send', { to: fix.wang.id, text: '有空看一下' })).toMatchObject({ ok: true });
  });
  it('员工之间不能互发（P74b 新规则），不管总管有没有待确认约定', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    await ownerSays(fix, fix.wang.id, '你联系一下小李');
    expect(await callTool(fix, fix.wang, 'hub_send', { to: fix.li.id, text: '在吗' }))
      .toMatchObject({ ok: false, error: '员工之间不直接发消息。做完交回用 hub_job_work 的 submit；有问题问总管。' });
  });
});

describe('闸门：派活（hub_job_manage assign）', () => {
  it('约定待确认时被拒，文字含约定标题；确认后放行的情形见 p74b-assign', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    const agreementId = fix.ctx.store.table('agreements').list()[0]!.id;
    const result = await callTool(fix, fix.chief, 'hub_job_manage', {
      mode: 'assign', agreementId, executor: '小王', dueAt: '2026-11-17 18:00', launchStep: false,
    });
    expect(result).toMatchObject({ ok: false, error: '约定「每日报价页」还在等主人确认，确认前不能派活。' });
    expect(fix.ctx.store.table('jobs').count()).toBe(0);
  });
});

describe('事务指派：总管不能把事务指派给别人（P74b）', () => {
  it('总管指派给别的员工被拒，不管约定是否待确认；指派给自己、不指派都成功', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    const base = { projectId: fix.project.id };
    const denied = await callTool(fix, fix.chief, 'hub_project_task_upsert', { ...base, title: '做页面', assigneeBotId: fix.wang.id });
    expect(denied).toMatchObject({ ok: false, error: '派活用 hub_job_manage 的 assign。' });
    expect(fix.ctx.store.table('projectTasks').count()).toBe(0);
    expect(await callTool(fix, fix.chief, 'hub_project_task_upsert', { ...base, title: '自己整理', assigneeBotId: fix.chief.id })).toMatchObject({ ok: true });
    expect(await callTool(fix, fix.chief, 'hub_project_task_upsert', { ...base, title: '先记一笔' })).toMatchObject({ ok: true });
    // 更新：把已有事务改派给别人也被拦，只改标题不拦。
    const mine = fix.ctx.store.table('projectTasks').list(task => task.title === '先记一笔')[0]!;
    expect(await callTool(fix, fix.chief, 'hub_project_task_upsert', { ...base, taskId: mine.id, title: '改个标题' })).toMatchObject({ ok: true });
    expect(await callTool(fix, fix.chief, 'hub_project_task_upsert', { ...base, taskId: mine.id, assigneeBotId: fix.wang.id })).toMatchObject({ ok: false });
  });
});

// P74r1（R1）恢复：原来的场景是主人在临时主题里叫醒总管，总管提交约定（约定落到中心新建的另一个主题），
// 再回到原来的临时主题 @ 员工。P74b 把这条改成「在约定自己的主题里 @」，正好绕开了这条路径（审查发现 F2）。
describe('闸门：主题里的 @（临时主题里提交约定后，回到原主题 @）', () => {
  it('有待确认约定时总管 reply 里的 @ 不叫醒人，主题里落旁白；约定固定后同样的话会叫醒', async () => {
    const fix = await setup();
    const topicId = await openTopic(fix, '先聊聊这件事');
    // 总管在主题回合里提交约定（主人的话叫醒的回合），再在 reply 里 @小王。
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { ...(await import('./p72b-fixtures.js')).newAgreementArgs() });
    expect(result.ok).toBe(true);
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    // 约定落在中心新建的主题，不是这个临时主题：只看「本主题的约定」会漏掉这条路径。
    expect(agreement.topicId).not.toBe(topicId);
    await speak(fix, fix.chief, '@小王 你来做');
    expect(queued(fix.ctx, fix.wang.id, topicId)).toBeUndefined();
    expect(runningWake(fix.ctx, fix.wang.id)).toBeUndefined();
    expect(floors(fix.ctx, topicId).some(row => row.kind === 'system' && row.text === '约定还没确认，这次没有叫 小王。')).toBe(true);

    // 同一场景，约定固定后：小王被叫醒。
    const fix2 = await setup();
    const topic2 = await openTopic(fix2, '先聊聊这件事');
    await callTool(fix2, fix2.chief, 'hub_agreement_submit', (await import('./p72b-fixtures.js')).newAgreementArgs());
    lockAgreement(fix2.ctx, fix2.ctx.store.table('agreements').list()[0]!.id);
    await speak(fix2, fix2.chief, '@小王 你来做');
    expect(runningWake(fix2.ctx, fix2.wang.id)).toMatchObject({ topicId: topic2 });
    expect(floors(fix2.ctx, topic2).some(row => row.text.startsWith('约定还没确认'))).toBe(false);
  });
});

describe('闸门：主题里的 @（只看这个主题挂的约定）', () => {
  it('约定待确认时总管 reply 里的 @ 不叫醒人，主题里落旁白；约定固定后同样的话会叫醒', async () => {
    const fix = await setup();
    const { topicId } = await draftedInProject(fix);
    // 主人在约定的主题里说话，总管在主题回合里 reply @小王。
    await ownerSays(fix, topicId, '你怎么看');
    await speak(fix, fix.chief, '@小王 你来做');
    expect(queued(fix.ctx, fix.wang.id, topicId)).toBeUndefined();
    expect(runningWake(fix.ctx, fix.wang.id)).toBeUndefined();
    expect(floors(fix.ctx, topicId).some(row => row.kind === 'system' && row.text === '约定还没确认，这次没有叫 小王。')).toBe(true);

    // 同一场景，约定固定后：小王被叫醒。
    const fix2 = await setup();
    const second = await draftedInProject(fix2);
    lockAgreement(fix2.ctx, second.agreementId);
    await ownerSays(fix2, second.topicId, '你怎么看');
    await speak(fix2, fix2.chief, '@小王 你来做');
    expect(runningWake(fix2.ctx, fix2.wang.id)).toMatchObject({ topicId: second.topicId });
    expect(floors(fix2.ctx, second.topicId).some(row => row.text.startsWith('约定还没确认'))).toBe(false);
  });

  it('主人自己在主题里 @小王，总管有待确认约定时小王照常被叫醒', async () => {
    const fix = await setup();
    const { agreementId, topicId } = await draftedInProject(fix);
    expect(dispatchBlockFor(fix.ctx, fix.chief.id, agreementId)).not.toBeNull();
    await ownerSays(fix, topicId, '@小王 先看一眼');
    // 小王被叫醒：已经在跑或在队里等（并发上限下可能先排队），两种都算「没被闸门拦」。
    expect(runningWake(fix.ctx, fix.wang.id) ?? queued(fix.ctx, fix.wang.id, topicId)).toMatchObject({ topicId });
  });
});

describe('dispatchBlockFor', () => {
  it('没有这份约定、已固定的约定返回 null；待确认的约定返回带标题的一句话', async () => {
    const fix = await setup();
    expect(dispatchBlockFor(fix.ctx, fix.chief.id, 'agr_0000000000')).toBeNull();
    await chiefDrafts(fix);
    const agreementId = fix.ctx.store.table('agreements').list()[0]!.id;
    expect(dispatchBlockFor(fix.ctx, fix.chief.id, agreementId)).toBe('约定「每日报价页」还在等主人确认，确认前不能派活。');
    lockAgreement(fix.ctx, agreementId);
    expect(dispatchBlockFor(fix.ctx, fix.chief.id, agreementId)).toBeNull();
  });
});
