/**
 * P75e 的测试五：三处只读（.agents/skills/、playbooks/、memory/MEMORY.md）。
 * write、edit、命令行写入（echo 重定向、cp、mv）到这三处被拒，原因码 skill_dir_readonly、不计越界；
 * 写别的员工家目录里的这三处同样被拒；读取放行；cd 家目录 && git add . 不受影响。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { classifyToolCall, classifyCommand } from '../src/gate/classify.js';
import { guardToolCall } from '../src/gate/guard.js';
import { isHubManaged } from '../src/gate/paths.js';
import type { GateContext } from '../src/gate/paths.js';

const home = '/hub/bots/b_0000000001';
const otherHome = '/hub/bots/b_0000000002';
const gctx: GateContext = { homeDir: home, rootDir: '/hub', sharedDir: '/hub/shared', workDataAllowed: false };

/** 一位在岗、有会话的员工；守卫层面的测试都用它。 */
function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture, sessionId: 'bot-session' };
  ctx.store.table('bots').put(bot);
  return { ctx, bot };
}

const THREE_PLACES = ['.agents/skills/a/SKILL.md', 'playbooks/r.md', 'memory/MEMORY.md'] as const;
const REASON = '技能库由中心维护：经验在复盘时用 hub_skill 提交，核对通过后写入。';

describe('P75e 三处只读：分类', () => {
  it('write 与 edit 到三处：protected、子类 skill_dir_readonly、原因文字一致', () => {
    for (const path of THREE_PLACES) {
      for (const tool of ['write', 'edit']) {
        expect(classifyToolCall(tool, { path: `${home}/${path}`, file_path: `${home}/${path}` }, gctx))
          .toMatchObject({ cls: 'protected', subclass: 'skill_dir_readonly', reason: REASON });
      }
    }
  });

  it('命令行能解析出的写入（重定向、cp、mv）到三处同样被拒', () => {
    const cases: Array<[string, string]> = [
      ['echo x > .agents/skills/a/SKILL.md', '.agents/skills/a/SKILL.md'],
      ['cp work/a playbooks/r.md', 'playbooks/r.md'],
      ['mv work/a memory/MEMORY.md', 'memory/MEMORY.md'],
    ];
    for (const [command] of cases) {
      expect(classifyCommand(command, gctx)).toMatchObject({ cls: 'protected', subclass: 'skill_dir_readonly' });
    }
  });

  it('别的员工家目录里的三处同样命中（判断方法同 isProtected）', () => {
    for (const path of THREE_PLACES) {
      expect(isHubManaged(`${otherHome}/${path}`, gctx)).toBe(true);
      expect(classifyToolCall('write', { path: `${otherHome}/${path}` }, gctx))
        .toMatchObject({ cls: 'protected', subclass: 'skill_dir_readonly' });
    }
    // 自己家目录之外、中心根目录之外的无关路径不命中。
    expect(isHubManaged('/tmp/a.md', gctx)).toBe(false);
    expect(isHubManaged(`${home}/work/a.md`, gctx)).toBe(false);
  });

  it('读取放行；cd 家目录 && git add . 不受影响', () => {
    for (const path of THREE_PLACES) {
      expect(classifyToolCall('read_file', { path: `${home}/${path}` }, gctx).cls).toBe('A');
    }
    const git = classifyCommand(`cd ${home} && git add .`, gctx);
    // 「不受影响」指不被新的只读规则拦下（分类与改动前一致，不因 isHubManaged 或 isProtectedAncestor 变成 protected）。
    expect(git.cls).not.toBe('protected');
    expect(git.subclass).not.toBe('skill_dir_readonly');
  });
});

describe('P75e 三处只读：守卫', () => {
  it('拒绝、说明去向、不计越界、不建审批', async () => {
    const { ctx, bot } = setup();
    for (const path of THREE_PLACES) {
      const decision = await guardToolCall(ctx, 'bot-session', 'write', { path: `${bot.homeDir}/${path}`, content: 'x' });
      expect(decision).toEqual({ allow: false, message: REASON });
    }
    // 命令行写入同样被拒。
    const command = await guardToolCall(ctx, 'bot-session', 'exec', { command: 'echo x > .agents/skills/a/SKILL.md' });
    expect(command.allow).toBe(false);
    expect(command.allow === false ? command.message : '').toContain('技能库由中心维护');
    // 不计越界、不建审批。
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(0);
    expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.store.table('inbox').count()).toBe(0);
  });
});
