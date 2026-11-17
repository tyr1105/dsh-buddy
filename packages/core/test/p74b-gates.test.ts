/**
 * P74b 的测试：派活闸门按事情区分、旧的派活入口收拢、主题文件不许覆盖。
 * 全部走真实 Hub（真实的启动整理、真实的显著性数值），时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { buildTools, runTool } from '../src/tools/index.js';
import { renderBotAgentsMd, renderRootAgentsMd } from '../src/memory/render.js';
import { declineTeamProposal } from '../src/team/proposals.js';
import { agreementIdIn, proposeResearcher, theProposal } from './p73d-fixtures.js';
import { floors, queued, runningWake } from './p72b-fixtures.js';
import { lastPacket } from './p63-topic-fixtures.js';
import {
  MINUTE, assignArgs, callTool, chiefDrafts, chiefDraftsAnother, chiefHasLockedAnother, jobFix, lockedAndAwake, ownerSays, speak, threadOf, type JobFix,
} from './p74b-fixtures.js';

/** 给主人看的文字里不许出现的内部名称。 */
const INTERNAL = /hub_|b_|job_|agr_/;
const OLD_TOOLS = /hub_handoff|hub_claim|hub_release/;

describe('8 闸门按事情区分', () => {
  it('A 已固定、B 待确认：对 A 派活成功，对 B 被拒', async () => {
    const fix = await jobFix();
    const a = agreementIdIn(await lockedAndAwake(fix));
    const b = await chiefDraftsAnother(fix, '新周报页');
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(b))).toMatchObject({ ok: false, error: '约定「新周报页」还在等主人确认，确认前不能派活。' });
    expect(fix.ctx.store.table('jobs').count()).toBe(0);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(a))).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').list()[0]!.agreementId).toBe(a);
  });

  it('为 A 加人的组队卡待确认时：对 A 被拒；对另一份已固定的 C 成功；卡处理之后对 A 放行', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    const a = agreementIdIn(packet);
    const c = await chiefHasLockedAnother(fix, '周报页');
    expect(await proposeResearcher(fix as never, packet)).toMatchObject({ ok: true });
    const denied = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(a));
    expect(denied).toMatchObject({ ok: false, error: '组队卡还在等主人确认，确认前不能把这件事交给别人。' });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(c))).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobs').list().map(row => row.agreementId)).toEqual([c]);
    // 卡处理之后，A 在新的主人发起的回合里可以派（同一条主人消息已经派过一次，换一条）。
    declineTeamProposal(fix.ctx, theProposal(fix.ctx).id, 'button');
    await speak(fix, fix.chief, '已安排周报页。', { outcome: 'progress' });
    fix.ctx.clock.advance(10 * MINUTE);
    await ownerSays(fix, fix.chief.id, '再把会员定价页安排上');
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(a, { executor: '评审甲', reviewer: '总管' }))).toMatchObject({ ok: true });
  });
});

describe('9 主题里的 @ 只看这个主题挂的约定', () => {
  /** 在「季度战役」项目里先后提交两份约定：甲主人已点「定了」，乙还待确认；返回两份的主题。 */
  async function twoAgreements(fix: JobFix) {
    await chiefDrafts(fix as never, { title: '甲页', projectId: fix.project.id });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    await chiefDraftsAnother(fix, '乙页', { projectId: fix.project.id });
    await speak(fix, fix.chief, '乙页有 2 项需要你定。', { outcome: 'needs_owner' });
    const [a, b] = fix.ctx.store.table('agreements').list();
    return { a: a!, b: b! };
  }

  // P74r1（R1）：总管名下有新约定在等主人确认（乙）时，在任何主题里 @ 员工都不叫醒，包括甲（已固定）的主题——
  // 自由文字的 @ 说的是哪件事中心分不清，所以不再「只看这个主题挂的约定」。甲单独存在时 @ 照常可用，见 p74r1-review-fixes。
  it('甲已固定、乙待确认：在甲的主题里 @ 林舟也不叫醒（总管名下有新约定待确认），在乙的主题里同样，各落旁白一条', async () => {
    const fix = await jobFix();
    const { a, b } = await twoAgreements(fix);
    expect(a.state).toBe('locked');
    expect(b.state).toBe('pending');
    // 甲的主题。
    await ownerSays(fix, a.topicId, '你怎么看');
    await speak(fix, fix.chief, '@林舟 你来做');
    expect(queued(fix.ctx, fix.engineer.id, a.topicId)).toBeUndefined();
    expect(runningWake(fix.ctx, fix.engineer.id)).toBeUndefined();
    expect(floors(fix.ctx, a.topicId).filter(row => row.kind === 'system' && row.text === '约定还没确认，这次没有叫 林舟。')).toHaveLength(1);
    fix.ctx.clock.advance(10 * MINUTE);
    await ownerSays(fix, b.topicId, '你怎么看');
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    expect(runningWake(fix.ctx, fix.chief.id)).toMatchObject({ topicId: b.topicId });
    await speak(fix, fix.chief, '@林舟 你也来看看');
    expect(queued(fix.ctx, fix.engineer.id, b.topicId)).toBeUndefined();
    expect(runningWake(fix.ctx, fix.engineer.id)?.topicId ?? null).not.toBe(b.topicId);
    const notes = floors(fix.ctx, b.topicId).filter(row => row.kind === 'system' && row.text === '约定还没确认，这次没有叫 林舟。');
    expect(notes).toHaveLength(1);
  });
});

describe('10 重新确认前不能对同一份约定派过活', () => {
  it('revise 重新确认 A 时：本回合已对 A 派过活则被拒；对别的约定派过活不影响', async () => {
    const fix = await jobFix();
    const a = agreementIdIn(await lockedAndAwake(fix));
    await speak(fix, fix.chief, '预计周五交付。', { outcome: 'progress' });
    fix.ctx.clock.advance(10 * MINUTE);
    // 新的主人发起的回合：先对别的约定 C 派活，再 revise A，不受影响。
    await ownerSays(fix, fix.chief.id, '会员定价页的范围改一下');
    const c = await chiefHasLockedAnother(fix, '周报页');
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(c))).toMatchObject({ ok: true });
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: a, mode: 'revise', changeNote: '改交付', summary: '重新来过' });
    expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('agreements').get(a)!.state).toBe('pending');
  });

  it('对 A 自己派过活之后 revise A 被拒，约定仍是已固定', async () => {
    const fix = await jobFix();
    const a = agreementIdIn(await lockedAndAwake(fix));
    await speak(fix, fix.chief, '预计周五交付。', { outcome: 'progress' });
    fix.ctx.clock.advance(10 * MINUTE);
    await ownerSays(fix, fix.chief.id, '会员定价页的范围改一下');
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(a))).toMatchObject({ ok: true });
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: a, mode: 'revise', changeNote: '改交付', summary: '重新来过' });
    expect(revised).toMatchObject({ ok: false, error: '约定「会员定价页」没有记下：这一回合你已经把它交给员工了。先让员工停下的部分写进新版本的暂停里，或下一回合再提交。' });
    expect(fix.ctx.store.table('agreements').get(a)!.state).toBe('locked');
    const note = threadOf(fix.ctx, fix.chief.id).find(row => row.from === 'hub' && row.text.includes('这次没有记下'));
    expect(note?.text).toBe('总管在这一回合已经把约定「会员定价页」交给员工了，新的版本这次没有记下，请你留意。');
    expect(note?.text).not.toMatch(INTERNAL);
  });
});

describe('11 旧入口：工具清单与 hub_send 的新规则', () => {
  it('hub_handoff、hub_claim、hub_release 不在工具清单里，hub_job_manage 在', async () => {
    const fix = await jobFix();
    const names = buildTools(fix.ctx).map(tool => tool.name);
    for (const gone of ['hub_handoff', 'hub_claim', 'hub_release']) expect(names).not.toContain(gone);
    expect(names).toContain('hub_job_manage');
    expect(fix.hub.tools().map(tool => tool.name)).not.toContain('hub_handoff');
    // 调用已移除的工具，得到明确的失败。
    const tc = { botId: fix.chief.id, sessionId: fix.chief.sessionId!, wakeId: null };
    expect(await runTool(fix.ctx, tc, 'hub_handoff', { to: '林舟', task: '做事', why: '约定' })).toEqual({ ok: false, error: '未知机器人工具：hub_handoff' });
  });

  it('员工发员工被拒；总管发给正在做 A 的林舟被拒且含 jobId；林舟发总管被拒；总管发给没有在办的事的员工成功', async () => {
    const fix = await jobFix(['小周']);
    const a = agreementIdIn(await lockedAndAwake(fix));
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(a))).toMatchObject({ ok: true });
    const job = fix.ctx.store.table('jobs').list()[0]!;
    // 员工发员工。
    await ownerSays(fix, fix.engineer.id, '问问小周');
    expect(await callTool(fix, fix.engineer, 'hub_send', { to: '小周', text: '在吗' }))
      .toMatchObject({ ok: false, error: '员工之间不直接发消息。做完交回用 hub_job_work 的 submit；有问题问总管。' });
    // 总管发给正在做事的林舟、核对中的评审甲。
    const toExecutor = await callTool(fix, fix.chief, 'hub_send', { to: '林舟', text: '进展如何' });
    expect(toExecutor).toMatchObject({ ok: false, error: `林舟正在做「会员定价页」（jobId 为 ${job.id}），关于这件事的往来用 hub_job_manage。` });
    expect(await callTool(fix, fix.chief, 'hub_send', { to: '评审甲', text: '看一下' })).toMatchObject({ ok: false, error: expect.stringContaining(`jobId 为 ${job.id}`) });
    // 林舟发总管。
    const toChief = await callTool(fix, fix.engineer, 'hub_send', { to: '老大', text: '我有个问题' });
    expect(toChief).toMatchObject({ ok: false, error: `你正在做「会员定价页」（jobId 为 ${job.id}），问总管用 hub_job_work 的 ask。` });
    // 总管与没有在办的事的员工之间照旧；这件事收尾之后，林舟也可以了。
    expect(await callTool(fix, fix.chief, 'hub_send', { to: '小周', text: '有空看一下' })).toMatchObject({ ok: true });
    await ownerSays(fix, fix.extras[0]!.id, '回报一下');
    expect(await callTool(fix, fix.extras[0]!, 'hub_send', { to: '老大', text: '好的' })).toMatchObject({ ok: true });
    fix.ctx.store.table('jobs').patch(job.id, { state: 'stopped' });
    expect(await callTool(fix, fix.chief, 'hub_send', { to: '林舟', text: '这件事先停了' })).toMatchObject({ ok: true });
  });
});

describe('12 总管不能把事务指派给别人', () => {
  it('总管指派给林舟被拒，指派给自己成功；非总管的项目负责人指派给成员成功', async () => {
    const fix = await jobFix();
    await lockedAndAwake(fix);
    const base = { projectId: fix.project.id };
    expect(await callTool(fix, fix.chief, 'hub_project_task_upsert', { ...base, title: '做页面', assigneeBotId: '林舟' }))
      .toMatchObject({ ok: false, error: '派活用 hub_job_manage 的 assign。' });
    expect(fix.ctx.store.table('projectTasks').count()).toBe(0);
    expect(await callTool(fix, fix.chief, 'hub_project_task_upsert', { ...base, title: '自己整理', assigneeBotId: '老大' })).toMatchObject({ ok: true });
    // 林舟当项目负责人，指派给评审甲（项目成员）。
    fix.ctx.store.table('projects').patch(fix.project.id, { ownerBotId: fix.engineer.id });
    const ok = await callTool(fix, fix.engineer, 'hub_project_task_upsert', { ...base, title: '核对页面', assigneeBotId: '评审甲' });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('projectTasks').list().some(task => task.assigneeBotId === fix.reviewer!.id)).toBe(true);
  });
});

describe('13 唤醒包与守则里不再出现旧工具', () => {
  it('组队卡确认后的唤醒包那一句含 hub_job_manage、不含 hub_handoff；全部唤醒包和守则渲染结果里没有三个旧工具', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    expect(await proposeResearcher(fix as never, packet)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '建议新增一位研究员，请你在卡片上确认。', { outcome: 'needs_owner' });
    fix.ctx.clock.advance(10 * MINUTE);
    const proposal = theProposal(fix.ctx);
    const result = await fix.hub.api.confirmTeamProposal({ proposalId: proposal.id, rev: proposal.rev });
    expect(result.ok).toBe(true);
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    const confirmed = lastPacket(fix, fix.chief);
    expect(confirmed).toContain('现在调用 hub_job_manage，mode 写 assign，agreementId 写 agr_');
    expect(confirmed).not.toContain('hub_handoff');
    // 全部送出过的唤醒包。
    const delivered = fix.ctx.host.calls.filter(call => call.method === 'deliver').map(call => String(call.args[1]));
    expect(delivered.length).toBeGreaterThan(2);
    for (const text of delivered) expect(text).not.toMatch(OLD_TOOLS);
    // 全体守则与每位员工的个人守则。
    expect(renderRootAgentsMd(fix.ctx)).not.toMatch(OLD_TOOLS);
    for (const bot of fix.ctx.store.table('bots').list()) {
      const rendered = renderBotAgentsMd(fix.ctx, bot);
      expect(rendered).not.toMatch(OLD_TOOLS);
      if (bot.role === 'chief') expect(rendered).toContain('hub_job_manage 派活与管理一件事（仅总管）');
    }
  });
});

describe('17 主题文件不许覆盖', () => {
  it('覆盖 约定.md、原话.md、草图.md、写进 材料/ 被拒；写进 交付/、证据/ 成功', async () => {
    const fix = await jobFix();
    const a = agreementIdIn(await lockedAndAwake(fix));
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(a))).toMatchObject({ ok: true });
    const job = fix.ctx.store.table('jobs').list()[0]!;
    await fix.ctx.fs.writeTextAtomic(`${fix.engineer.homeDir}/work/x.md`, '我的成品');
    const put = (to: string) => callTool(fix, fix.engineer, 'hub_project_put', { from: 'work/x.md', to, project: job.projectId });
    for (const name of ['约定.md', '原话.md', '草图.md', '材料/x.md']) {
      const rel = `${job.folder}/${name}`;
      expect(await put(rel), name).toMatchObject({ ok: false, error: `这是中心维护的文件，不能覆盖：${rel}` });
    }
    // 落在「材料」文件夹本身：文件会被放进文件夹里，同样被拒。
    expect(await put(`${job.folder}/材料`)).toMatchObject({ ok: false, error: `这是中心维护的文件，不能覆盖：${job.folder}/材料/x.md` });
    // 大小写、上级目录写法都绕不过去。
    expect(await put(`${job.folder}/约定.MD`)).toMatchObject({ ok: false, error: expect.stringContaining('这是中心维护的文件，不能覆盖') });
    expect(await put(`${job.folder}/交付/../约定.md`)).toMatchObject({ ok: false, error: expect.stringContaining('这是中心维护的文件，不能覆盖') });
    // 内容没有被改。
    const project = fix.ctx.store.table('projects').get(job.projectId)!;
    expect(await fix.ctx.fs.readText(`${project.sharedDir.replace(/\/+$/, '')}/${job.folder}/约定.md`)).toContain('# 会员定价页（约定第 1 版）');
    // 交付、证据照常。
    expect(await put(`${job.folder}/交付/x.md`)).toMatchObject({ ok: true });
    expect(await put(`${job.folder}/证据/x.md`)).toMatchObject({ ok: true });
    expect(await fix.ctx.fs.readText(`${project.sharedDir.replace(/\/+$/, '')}/${job.folder}/交付/x.md`)).toBe('我的成品');
    // 项目文件夹里别的普通位置不受影响。
    expect(await put('notes/约定.md')).toMatchObject({ ok: true });
  });
});
