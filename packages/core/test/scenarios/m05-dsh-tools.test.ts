/** M05 用完整仿真回合检查 DSH 真实工具名：日常工作不中断，敏感路径仍由同一动作闸拒绝。 */
import { describe, expect, it } from 'vitest';
import { createSimWorld } from '../../src/sim/runner.js';
import { botIds, bots, complete, startAt } from './fixtures.js';

describe('M05 DSH 工具仿真', () => {
  it.each(['L0', 'L2'] as const)('%s 大脑依次搜索、读取、记待办、写工作文件和 ls，全部放行且不建审批单', async autonomy => {
    const world = await createSimWorld({ bots: bots().map(bot => ({ ...bot, autonomy })), startAt });
    const botId = botIds[0];
    const homeDir = world.store.table('bots').get(botId)!.homeDir;
    const actions = [
      { tool: 'glob', args: { pattern: '**/*.md' } },
      { tool: 'grep', args: { pattern: 'TODO', path: 'work' } },
      { tool: 'read', args: { file_path: 'work/report.md' } },
      { tool: 'todo_write', args: { todos: [{ content: '核对公开报告', status: 'in_progress' }] } },
      { tool: 'write', args: { file_path: 'work/result.md', content: '公开报告已经核对。' } },
      { tool: 'bash', args: { command: 'ls' } },
    ];

    try {
      // 准备内存中的公开资料；大脑通过宿主 call 进入真实守卫，仿真不会执行实际文件或命令操作。
      await world.fs.writeTextAtomic(`${homeDir}/work/report.md`, 'TODO 核对公开报告');
      world.host.registerBrain(botId, async input => {
        for (const action of actions) await input.call(action.tool, action.args);
        return complete(input, { outcome: 'progress', summary: '已搜索和核对资料，整理待办并形成结果' });
      });
      expect(await world.hub.api.sendMessage(botId, '请核对工作区里的公开报告')).toMatchObject({ ok: true });
      await world.host.settle();

      // 检查宿主实际记录的顺序与每一步回包，防止大脑继续交账掩盖前面的拒绝。
      expect(world.host.toolCalls.map(call => ({ tool: call.tool, args: call.args })).slice(0, -1)).toEqual(actions);
      expect(world.host.toolCalls.map(call => call.tool)).toEqual([...actions.map(action => action.tool), 'hub_commit']);
      expect(world.host.toolCalls.every(call => call.result.ok)).toBe(true);
      expect(world.store.table('approvals').list()).toEqual([]);
      expect(world.store.table('inbox').list(row => row.type === 'approval')).toEqual([]);
      expect(world.store.log('thread').all().filter(row => row.kind === 'approval')).toEqual([]);
      expect(world.store.table('bots').get(botId)?.violations).toBe(0);
      expect(world.host.turns).toEqual([expect.objectContaining({ botId, status: 'ended', steps: 7 })]);
      expect(world.store.table('wakes').list()).toEqual([expect.objectContaining({ botId, status: 'committed', error: null })]);
      expect(world.store.table('commits').count()).toBe(1);
    } finally {
      await world.hub.stop();
    }
  });

  it.each([
    { tool: 'glob', args: { pattern: '../../.ssh/*' } },
    { tool: 'grep', args: { pattern: 'key', path: '~/.dsh' } },
    { tool: 'present', args: { files: [{ path: '~/.ssh/id_rsa' }] } },
    { tool: 'edit', args: { file_path: 'AGENTS.md', old_string: '旧身份', new_string: '新身份' } },
  ])('$tool 触及受保护路径时仍拒绝，记录越界且不生成可批准的单据', async action => {
    const world = await createSimWorld({ bots: bots(), startAt });
    const botId = botIds[0];
    try {
      // 每个反例独立建世界，既检验真实守卫，也避免累计越界后的隔离状态影响下一种工具。
      world.host.registerBrain(botId, async input => {
        await input.call(action.tool, action.args);
        return complete(input, { outcome: 'no_change', summary: '受保护动作被拒，未读取或改写该路径' });
      });
      expect(await world.hub.api.sendMessage(botId, '检查路径边界')).toMatchObject({ ok: true });
      await world.host.settle();

      expect(world.host.toolCalls).toHaveLength(2);
      expect(world.host.toolCalls[0]).toMatchObject({ tool: action.tool, args: action.args,
        result: { ok: false, error: expect.stringMatching(/敏感凭据|不能直接改写/) } });
      expect(world.host.toolCalls[1]).toMatchObject({ tool: 'hub_commit', result: { ok: true } });
      expect(world.store.table('bots').get(botId)?.violations).toBe(1);
      expect(world.store.table('approvals').list()).toEqual([]);
      expect(world.store.table('inbox').list(row => row.type === 'approval')).toEqual([]);
      expect(world.host.turns[0]?.status).toBe('ended');
      expect(world.store.table('commits').count()).toBe(1);
    } finally {
      await world.hub.stop();
    }
  });
});
