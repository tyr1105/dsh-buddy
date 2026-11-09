/**
 * 看板 C03「项目配置」第四项——可见范围的保守默认：仅项目成员可见。
 *
 * 背景：项目说明、成员、产物目录在 F08 已经可编辑并真实生效；唯独「可见范围」
 * 规格没写（v2 计划没有项目级可见性条款）。按最保守口径：非成员队友看不到项目
 * 的任何信息——唤醒包里不出现项目名、目录与任务，hub_task_list 也只列指派给自己的活。
 * 「全队可见」是未来的可选项，主人没拍板前不做，本文件把「不泄露」钉死，
 * 防止以后改唤醒包或工具时悄悄放开。
 *
 * 主人取消编制后，项目成员直接是队友 id；非成员队友只需要在 bots 表里存在且在岗，
 * 不再需要占一个席位。
 */
import { describe, expect, it } from 'vitest';
import { turnContext } from './c03-turn-fixtures.js';
import { createBotHome } from '../src/memory/index.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { createTicket } from '../src/wake/ticket.js';
import { newId } from '../src/util/ids.js';
import { saveProject, saveTask } from '../src/project/service.js';
import { assignTask } from '../src/project/assign.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { runTool } from '../src/tools/index.js';
import { botFixture } from './model-fixtures.js';
import type { HubContext } from '../src/engine/context.js';
import type { Bot, QueueEntry } from '../src/model/index.js';

/** 造第二个在岗队友（非项目成员）：有家目录与会话，能正常被唤醒。 */
async function putOutsider(ctx: HubContext, idSuffix: string): Promise<{ bot: Bot; entry: QueueEntry }> {
  const now = ctx.clock.now();
  const bot: Bot = {
    ...botFixture, id: `b_${idSuffix}`, name: '旁观队友', homeDir: `/hub/bots/b_${idSuffix}`,
    sessionId: `session-${idSuffix}`, sessionStartedAt: now, createdAt: now, updatedAt: now,
  };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const entry: QueueEntry = {
    ...buildCandidate(ctx, { botId: bot.id, kind: 'next_think', variant: 'regular', score: 0.8, summary: '例行自查', now }),
    id: newId('q', ctx.rng), enqueuedAt: now,
  };
  const ticket = createTicket(ctx, entry, bot.sessionId);
  ctx.store.table('wakes').patch(ticket.id, { status: 'running', dispatchedAt: now });
  return { bot, entry };
}

describe('C03 项目可见范围：仅成员可见（保守默认）', () => {
  it('非成员队友的唤醒包看不到项目名、目录和任务；成员照常看到', async () => {
    const turn = await turnContext('regular');
    const ctx = turn.ctx;
    const member = turn.bot;

    const outsider = await putOutsider(ctx, '0000000099');

    // 项目成员只有成员队友；任务派给成员队友。
    const project = saveProject(ctx, { name: '密级改版', memberBotIds: [member.id] });
    const task = saveTask(ctx, { projectId: project.id, title: '写内部方案' });
    assignTask(ctx, { taskId: task.id, botId: member.id });

    // 成员：段在、项目名和共享目录都在。
    const memberPacket = await buildWakePacket(ctx, member, turn.entry, turn.ticket);
    expect(memberPacket).toContain('你手上的项目任务');
    expect(memberPacket).toContain('密级改版');
    expect(memberPacket).toContain(project.sharedDir);
    expect(memberPacket).toContain('写内部方案');

    // 非成员：整段不存在，名字、目录、任务一个字都不能漏出来。
    const outsiderTicket = ctx.store.table('wakes').list().find(w => w.sessionId === outsider.bot.sessionId)!;
    const outsiderPacket = await buildWakePacket(ctx, outsider.bot, outsider.entry, outsiderTicket);
    expect(outsiderPacket).not.toContain('你手上的项目任务');
    expect(outsiderPacket).not.toContain('密级改版');
    expect(outsiderPacket).not.toContain(project.sharedDir);
    expect(outsiderPacket).not.toContain('写内部方案');
  });

  it('非成员队友调 hub_task_list 拿不到项目任务，成员能拿到', async () => {
    const turn = await turnContext('regular');
    const ctx = turn.ctx;
    const outsider = await putOutsider(ctx, '0000000098');

    const project = saveProject(ctx, { name: '对外发布', memberBotIds: [turn.bot.id] });
    const task = saveTask(ctx, { projectId: project.id, title: '整理发布清单' });
    assignTask(ctx, { taskId: task.id, botId: turn.bot.id });

    const outsiderTicket = ctx.store.table('wakes').list().find(w => w.sessionId === outsider.bot.sessionId)!;
    const outsiderView = await runTool(
      ctx,
      { botId: outsider.bot.id, sessionId: outsider.bot.sessionId!, wakeId: outsiderTicket.id },
      'hub_task_list', {},
    );
    expect(outsiderView.ok).toBe(true);
    if (outsiderView.ok) {
      expect(outsiderView.text).not.toContain('整理发布清单');
      expect(outsiderView.text).not.toContain('对外发布');
    }

    const memberView = await runTool(ctx, turn.toolCtx, 'hub_task_list', {});
    expect(memberView.ok).toBe(true);
    if (memberView.ok) expect(memberView.text).toContain('整理发布清单');
  });
});
