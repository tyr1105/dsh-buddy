/**
 * P39 项目共享上下文 - core 测试。
 * 覆盖：
 * - 数据形状：新项目默认空上下文、旧项目缺字段按空值兼容（零迁移）；
 * - 主人编辑：写 context.md、追加留痕（摘要 + 哈希）、审计与 project 事件；内容未变不留痕；
 * - saveProject 不冲掉上下文与留痕；
 * - 队友建议：仅成员、仅进行中项目、每 bot/项目保留一条 pending；非成员按「项目不存在」；
 * - 主人采纳/驳回：采纳走同一写文件路径且编辑者记为队友，驳回只改建议状态；
 * - 视图：context / contextEmpty / contextFilePath / 留痕与建议的人话翻译；
 * - 唤醒包：常规回合带 ≤1.5KB 摘要与术语命中，轻复查与非成员不带。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { projectView } from '../src/api/project-views.js';
import { ProjectSchema } from '../src/model/project.js';
import { botFixture } from './model-fixtures.js';
import { turnContext } from './c03-turn-fixtures.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { buildProjectContextSection } from '../src/wake/project-context.js';
import { assignTask } from '../src/project/assign.js';
import { archiveProject, saveProject, saveTask } from '../src/project/service.js';
import {
  approveProjectContextProposal, proposeProjectContext, rejectProjectContextProposal, saveProjectContext,
} from '../src/project/context-service.js';
import type { Bot } from '../src/model/bot.js';

const pad = (n: number): string => String(n).padStart(10, '0');

/** 直接放一个在岗队友（只测上下文服务，不需要走建队命令）。 */
function putBot(ctx: HubContext, n: number): Bot {
  const now = ctx.clock.now();
  const bot: Bot = {
    ...botFixture, id: `b_${pad(n)}`, name: `队友 ${n}`, createdAt: now, updatedAt: now,
  };
  ctx.store.table('bots').put(bot);
  return bot;
}

/** 与项目上下文相关的审计。 */
function contextAudits(ctx: HubContext) {
  return ctx.store.log('audit').all().filter(a => a.action.startsWith('project_context_'));
}

describe('P39 数据形状与旧档兼容', () => {
  it('新项目默认四段全空、零留痕', () => {
    const ctx = createTestContext();
    const project = saveProject(ctx, { name: '默认项目' });
    expect(project.context).toEqual({ background: '', conventions: '', decisions: [], glossary: [] });
    expect(project.contextRevisions).toEqual([]);
  });

  it('旧项目记录缺 context/contextRevisions：ProjectSchema.parse 补空，不需要迁移', () => {
    const now = Date.parse('2026-11-05T10:00:00+08:00');
    const parsed = ProjectSchema.parse({
      id: 'prj_0000000001', name: '旧项目', charter: '', status: 'active',
      ownerBotId: null, memberBotIds: [], sharedDir: '/hub/projects/prj_0000000001/',
      acceptanceCriteria: [], createdAt: now, updatedAt: now, archivedAt: null,
    });
    expect(parsed.context).toEqual({ background: '', conventions: '', decisions: [], glossary: [] });
    expect(parsed.contextRevisions).toEqual([]);
  });
});

describe('P39 主人保存共享上下文', () => {
  it('写 context.md、追加留痕、写审计并发 project 事件', async () => {
    const ctx = createTestContext();
    const project = saveProject(ctx, { name: '竞品周报' });
    const saved = await saveProjectContext(ctx, {
      projectId: project.id,
      background: '每周五给主人一份竞品变化周报。',
      conventions: '只引用能打开原文的公开信息。\n对外发出前先交主人验收。',
      decisions: [{ text: '先覆盖五家竞品' }],
      glossary: [{ term: '周报', meaning: '每周五发出的竞品汇总' }],
    });

    // 文件落在 sharedDir 的固定文件名，正文含四段与标题。
    const file = await ctx.fs.readText(`/hub/projects/${project.id}/context.md`);
    expect(file).toContain('## 背景');
    expect(file).toContain('每周五给主人一份竞品变化周报。');
    expect(file).toContain('对外发出前先交主人验收。');
    expect(file).toContain('先覆盖五家竞品');

    // 留痕只存摘要与哈希，不复制正文。
    expect(saved.contextRevisions).toHaveLength(1);
    const revision = saved.contextRevisions[0]!;
    expect(revision.id).toMatch(/^pcr_[a-z0-9]{10}$/);
    expect(revision.editorId).toBe('owner');
    expect(revision.editorKind).toBe('owner');
    expect(revision.source).toBe('owner_edit');
    expect(revision.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(revision.summary).toContain('背景');
    expect(revision.summary).toContain('决策 +1');

    const audit = contextAudits(ctx).find(a => a.action === 'project_context_update')!;
    expect(audit.actor).toBe('owner');
    expect(JSON.parse(audit.detail)).toMatchObject({ id: project.id, revisionId: revision.id, hash: revision.hash });
    expect(ctx.events).toContainEqual({ scope: 'project', botId: null });
  });

  it('内容没变再保存：不留痕、不写审计', async () => {
    const ctx = createTestContext();
    const project = saveProject(ctx, { name: '稳定项目' });
    await saveProjectContext(ctx, { projectId: project.id, background: '同一段背景' });
    const before = contextAudits(ctx).length;
    const again = await saveProjectContext(ctx, { projectId: project.id, background: '同一段背景' });
    expect(again.contextRevisions).toHaveLength(1);
    expect(contextAudits(ctx).length).toBe(before);
  });

  it('已有决策带 id 保留身份，新决策发新 id；不属于本项目的 id 拒绝', async () => {
    const ctx = createTestContext();
    const project = saveProject(ctx, { name: '决策项目' });
    const first = await saveProjectContext(ctx, { projectId: project.id, decisions: [{ text: '先做 A' }] });
    const decision = first.context.decisions[0]!;
    const second = await saveProjectContext(ctx, {
      projectId: project.id, decisions: [{ id: decision.id, text: '先做 A（已确认）' }, { text: '再做 B' }],
    });
    expect(second.context.decisions[0]).toMatchObject({ id: decision.id, text: '先做 A（已确认）' });
    expect(second.context.decisions[1]!.id).toMatch(/^dc_[a-z0-9]{10}$/);
    await expect(saveProjectContext(ctx, {
      projectId: project.id, decisions: [{ id: 'dc_0000000099', text: '伪造' }],
    })).rejects.toThrow('决策不属于该项目');
  });

  it('保存项目本身（改名/改成员）不会清空上下文与留痕', async () => {
    const ctx = createTestContext();
    const project = saveProject(ctx, { name: '旧名字' });
    await saveProjectContext(ctx, { projectId: project.id, background: '保留我' });
    const updated = saveProject(ctx, { id: project.id, name: '新名字' });
    expect(updated.name).toBe('新名字');
    expect(updated.context.background).toBe('保留我');
    expect(updated.contextRevisions).toHaveLength(1);
  });

  it('归档项目不能再改上下文', async () => {
    const ctx = createTestContext();
    const project = saveProject(ctx, { name: '归档项目' });
    archiveProject(ctx, project.id);
    await expect(saveProjectContext(ctx, { projectId: project.id, background: '太晚' }))
      .rejects.toThrow('已归档');
  });
});

describe('P39 队友建议与主人确认', () => {
  it('成员可提建议：不改正文、不写文件，只落一条待审记录', async () => {
    const ctx = createTestContext();
    const bot = putBot(ctx, 1);
    const project = saveProject(ctx, { name: '协作项目', memberBotIds: [bot.id] });
    const proposal = proposeProjectContext(ctx, bot.id, {
      projectId: project.id, background: '队友补充的背景', note: '补一句背景',
    });
    expect(proposal.id).toMatch(/^pcp_[a-z0-9]{10}$/);
    expect(proposal.status).toBe('pending');
    expect(ctx.store.table('projects').get(project.id)!.context.background).toBe('');
    expect(await ctx.fs.readText(`/hub/projects/${project.id}/context.md`)).toBeNull();
    expect(contextAudits(ctx).some(a => a.action === 'project_context_propose' && a.actor === bot.id)).toBe(true);
  });

  it('非成员与不存在项目给同一句拒绝；暂停项目不能提建议', () => {
    const ctx = createTestContext();
    const member = putBot(ctx, 1);
    const outsider = putBot(ctx, 2);
    const project = saveProject(ctx, { name: '成员项目', memberBotIds: [member.id] });
    expect(() => proposeProjectContext(ctx, outsider.id, { projectId: project.id, note: '插一句' }))
      .toThrow('项目不存在或你不在成员名单里');
    expect(() => proposeProjectContext(ctx, member.id, { projectId: 'prj_0000000099', note: '插一句' }))
      .toThrow('项目不存在或你不在成员名单里');
    ctx.store.table('projects').patch(project.id, { status: 'paused' });
    expect(() => proposeProjectContext(ctx, member.id, { projectId: project.id, note: '插一句' }))
      .toThrow('暂不能提交上下文建议');
  });

  it('同一队友在同一项目再次提交：原地更新同一条 pending', () => {
    const ctx = createTestContext();
    const bot = putBot(ctx, 1);
    const project = saveProject(ctx, { name: '一条建议', memberBotIds: [bot.id] });
    const first = proposeProjectContext(ctx, bot.id, { projectId: project.id, background: '第一版', note: '第一次' });
    const second = proposeProjectContext(ctx, bot.id, { projectId: project.id, background: '第二版', note: '第二次' });
    expect(second.id).toBe(first.id);
    expect(ctx.store.table('projectContextProposals').list(p => p.projectId === project.id && p.status === 'pending')).toHaveLength(1);
  });

  it('主人采纳：正文写入、留痕记队友为编辑者、建议标记已采纳', async () => {
    const ctx = createTestContext();
    const bot = putBot(ctx, 1);
    const project = saveProject(ctx, { name: '采纳项目', memberBotIds: [bot.id] });
    const proposal = proposeProjectContext(ctx, bot.id, {
      projectId: project.id, background: '队友写的背景', note: '请主人确认',
    });
    const saved = await approveProjectContextProposal(ctx, proposal.id);
    expect(saved.context.background).toBe('队友写的背景');
    const revision = saved.contextRevisions.at(-1)!;
    expect(revision.editorId).toBe(bot.id);
    expect(revision.editorKind).toBe('bot');
    expect(revision.source).toBe('bot_proposal');
    expect(ctx.store.table('projectContextProposals').get(proposal.id)!.status).toBe('approved');
    expect(await ctx.fs.readText(`/hub/projects/${project.id}/context.md`)).toContain('队友写的背景');
  });

  it('主人驳回：只改建议状态，项目正文与留痕不变', () => {
    const ctx = createTestContext();
    const bot = putBot(ctx, 1);
    const project = saveProject(ctx, { name: '驳回项目', memberBotIds: [bot.id] });
    const proposal = proposeProjectContext(ctx, bot.id, { projectId: project.id, background: '不采纳', note: '试试' });
    const rejected = rejectProjectContextProposal(ctx, proposal.id);
    expect(rejected.status).toBe('rejected');
    expect(ctx.store.table('projects').get(project.id)!.context.background).toBe('');
    expect(ctx.store.table('projects').get(project.id)!.contextRevisions).toEqual([]);
    expect(() => rejectProjectContextProposal(ctx, proposal.id)).toThrow('已经处理过了');
  });
});

describe('P39 视图与唤醒包', () => {
  it('项目视图给出上下文、空态、文件路径、留痕与待审建议的人话翻译', async () => {
    const ctx = createTestContext();
    const bot = putBot(ctx, 1);
    const empty = saveProject(ctx, { name: '空上下文项目' });
    const project = saveProject(ctx, { name: '有上下文项目', memberBotIds: [bot.id] });
    await saveProjectContext(ctx, { projectId: project.id, background: '视图背景' });
    proposeProjectContext(ctx, bot.id, { projectId: project.id, conventions: '视图约定', note: '补约定' });

    const view = projectView(ctx);
    const emptyRow = view.projects.find(row => row.project.id === empty.id)!;
    expect(emptyRow.contextEmpty).toBe(true);
    const row = view.projects.find(item => item.project.id === project.id)!;
    expect(row.contextEmpty).toBe(false);
    expect(row.context.background).toBe('视图背景');
    expect(row.contextFilePath).toBe(`/hub/projects/${project.id}/context.md`);
    expect(row.contextRevisions[0]).toMatchObject({ editorName: '主人', editorKindLabel: '主人', sourceLabel: '主人编辑' });
    expect(row.contextRevisions[0]!.hashShort).toHaveLength(8);
    expect(row.contextProposals[0]).toMatchObject({ botName: bot.name, botInvalid: false });
    expect(row.contextProposals[0]!.summary).toContain('约定');
  });

  it('常规唤醒带 ≤1.5KB 摘要与术语命中；轻复查不带；非成员不带', async () => {
    const turn = await turnContext('regular');
    const ctx = turn.ctx;
    const project = saveProject(ctx, { name: '唤醒项目', memberBotIds: [turn.bot.id] });
    await saveProjectContext(ctx, {
      projectId: project.id,
      background: '背景'.repeat(400),
      conventions: '只引用公开信息\n对外前先交主人验收',
      decisions: [{ text: '先覆盖五家竞品' }],
      glossary: [{ term: '周报', meaning: '每周五的竞品汇总' }],
    });
    const task = saveTask(ctx, { projectId: project.id, title: '整理周报初稿' });
    assignTask(ctx, { taskId: task.id, botId: turn.bot.id });

    const section = buildProjectContextSection(ctx, turn.bot)!;
    expect(section).not.toBeNull();
    expect(Buffer.byteLength(section.body, 'utf8')).toBeLessThanOrEqual(1536);
    expect(section.body).toContain('只引用公开信息');
    expect(section.body).toContain('周报＝每周五的竞品汇总');

    const packet = await buildWakePacket(ctx, turn.bot, turn.entry, turn.ticket);
    expect(packet).toContain('项目共享上下文');
    expect(packet).toContain('最近决策');

    // 轻复查保持简版：不出现项目上下文段。
    const light = await turnContext('light_check');
    const lightProject = saveProject(light.ctx, { name: '轻复查项目', memberBotIds: [light.bot.id] });
    await saveProjectContext(light.ctx, { projectId: lightProject.id, background: '轻复查不该看到' });
    const lightPacket = await buildWakePacket(light.ctx, light.bot, light.entry, light.ticket);
    expect(lightPacket).not.toContain('项目共享上下文');
    expect(lightPacket).not.toContain('轻复查不该看到');

    // 非成员：整段不存在，连项目名都不能漏。
    const outsider = await turnContext('regular');
    const privateProject = saveProject(outsider.ctx, { name: '别人的项目' });
    await saveProjectContext(outsider.ctx, { projectId: privateProject.id, background: '别人的背景' });
    const outsiderPacket = await buildWakePacket(outsider.ctx, outsider.bot, outsider.entry, outsider.ticket);
    expect(outsiderPacket).not.toContain('项目共享上下文');
    expect(outsiderPacket).not.toContain('别人的背景');
  });
});
