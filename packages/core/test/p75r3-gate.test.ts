/**
 * P75r3 第 1.4 节与第 3 节的测试：闸门多认三个精确路径（.agents、.agents/skills、playbooks），
 * 以及一条命令里混着两种受保护的位置时仍计越界。
 *
 * 审查 H2 复现的每一条命令各一条，沙箱开着和没开着两种情况都测；反例是不受影响的三种
 * （cd 家目录 && git add .、ls .agents、读取）。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { classifyCommand, classifyToolCall } from '../src/gate/classify.js';
import { guardToolCall } from '../src/gate/guard.js';
import { isHubManaged, mostDangerous } from '../src/gate/paths.js';
import type { Classification, GateContext } from '../src/gate/paths.js';

const home = '/hub/bots/b_0000000001';
const otherHome = '/hub/bots/b_0000000002';
const base: GateContext = { homeDir: home, rootDir: '/hub', sharedDir: '/hub/shared', workDataAllowed: false };
const SANDBOX = { sandboxed: true, tmpDirs: ['/tmp', '/private/tmp'] };
const REASON = '技能库由中心维护：经验在复盘时用 hub_skill 提交，核对通过后写入。';

/** 一位在岗、有会话的员工。 */
function setup() {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, sessionId: 'bot-session' });
  return { ctx };
}
/** 经守卫跑一条命令，返回决定与越界次数。 */
async function run(command: string, sandboxed: boolean) {
  const { ctx } = setup();
  const decision = await guardToolCall(ctx, 'bot-session', 'exec', { command }, sandboxed ? SANDBOX : undefined);
  return { decision, violations: ctx.store.table('bots').get(botFixture.id)!.violations, approvals: ctx.store.table('approvals').count() };
}

describe('P75r3 闸门：三个精确路径本身', () => {
  // 审查 H2 里列的命令：每条沙箱开着、没开着各测一次。
  const DENIED = [
    'mv .agents .agents-old',
    'ln -s work/fake .agents',
    'rm -rf .agents',
    'mkdir -p t/skills/x && mv t .agents',
    // 另外两个精确路径：.agents/skills、playbooks。
    'mv .agents/skills s2',
    'ln -s work/fake .agents/skills',
    'rm -rf playbooks',
    'ln -sf work/fake playbooks',
    // 各种写法归一之后：相对路径、..、大小写、末尾斜杠、多余的斜杠。
    'mv ./.agents//  x',
    'rm -rf work/../.agents/',
    'mv .AGENTS x',
    'ln -s work/fake ./.Agents/',
  ];
  for (const sandboxed of [true, false]) {
    for (const command of DENIED) {
      it(`${sandboxed ? '沙箱开着' : '沙箱没开'}：${command} 被拒，原因码只读，不计越界、不建审批`, async () => {
        const { decision, violations, approvals } = await run(command, sandboxed);
        expect(decision).toEqual({ allow: false, message: REASON });
        expect(violations).toBe(0);
        expect(approvals).toBe(0);
      });
    }
  }

  it('write、edit 工具的目标恰好是 .agents 或 playbooks 本身也被拒', async () => {
    const { ctx } = setup();
    for (const tool of ['write', 'edit']) {
      for (const path of ['.agents', 'playbooks', `${home}/.agents/`]) {
        expect(await guardToolCall(ctx, 'bot-session', tool, { path, content: 'x', file_path: path })).toEqual({ allow: false, message: REASON });
      }
    }
    expect(ctx.store.table('bots').get(botFixture.id)!.violations).toBe(0);
  });

  it('别的员工家目录里的三个精确路径同样命中；家目录本身与更上级不命中', () => {
    for (const path of ['.agents', '.agents/skills', 'playbooks']) {
      expect(isHubManaged(`${otherHome}/${path}`, base)).toBe(true);
      expect(isHubManaged(`${home}/${path}`, base)).toBe(true);
    }
    expect(isHubManaged(home, base)).toBe(false);
    expect(isHubManaged('/hub/bots', base)).toBe(false);
    expect(isHubManaged('/hub', base)).toBe(false);
    // 名字相近的路径也不命中。
    expect(isHubManaged(`${home}/.agents-old`, base)).toBe(false);
    expect(isHubManaged(`${home}/work/.agents`, base)).toBe(false);
  });

  // 反例三条：不受影响。
  it('cd 家目录 && git add . 不被只读规则拦下（沙箱开着和没开着）', () => {
    for (const ctx of [base, { ...base, ...SANDBOX }]) {
      const git = classifyCommand(`cd ${home} && git add .`, ctx);
      expect(git.subclass).not.toBe('skill_dir_readonly');
      expect(git.cls).not.toBe('protected');
    }
  });
  it('ls .agents、读取 .agents 与 playbooks 不受影响', async () => {
    for (const ctx of [base, { ...base, ...SANDBOX }]) {
      expect(classifyCommand('ls .agents', ctx).subclass).not.toBe('skill_dir_readonly');
      expect(classifyCommand('cat .agents/skills/a/SKILL.md', ctx).subclass).not.toBe('skill_dir_readonly');
      for (const path of ['.agents', '.agents/skills', 'playbooks']) {
        expect(classifyToolCall('read_file', { path: `${home}/${path}` }, ctx).cls).toBe('A');
      }
    }
    // 守卫层面：沙箱开着时 ls .agents 直接放行。
    expect((await run('ls .agents', true)).decision).toEqual({ allow: true });
  });
  it('在别处建一个指进来的链接（ln -s .agents/skills s）闸门不拦：沙箱里放行，没开沙箱时不是因为只读规则被拒', async () => {
    expect((await run('ln -s .agents/skills s', true)).decision).toEqual({ allow: true });
    const outside = await run('ln -s .agents/skills s', false);
    expect(outside.decision.allow === false ? outside.decision.message : '').not.toContain('技能库由中心维护');
    expect(outside.violations).toBe(0);
  });
  it('链接建在技能库里面（ln -s ../.. .agents/skills/x）被拒；建在别处、指向别处的 ln 不受影响', async () => {
    for (const sandboxed of [true, false]) {
      expect((await run('ln -s ../.. .agents/skills/x', sandboxed)).decision).toEqual({ allow: false, message: REASON });
      const elsewhere = (await run('ln -s /hub/shared/a work/a', sandboxed)).decision;
      expect(elsewhere.allow === false ? elsewhere.message : '').not.toContain('技能库由中心维护');
    }
    // sh -c 包着的 ln 同样能认出。
    expect((await run("sh -c 'ln -s work/fake .agents'", true)).decision).toEqual({ allow: false, message: REASON });
  });
});

describe('P75r3 一条命令里混着两种受保护的位置：照样计越界', () => {
  it('先写技能库、再写 AGENTS.md：被拒且越界加一', async () => {
    for (const sandboxed of [true, false]) {
      const { decision, violations } = await run('touch .agents/skills/a/SKILL.md; echo x > AGENTS.md', sandboxed);
      expect(decision.allow).toBe(false);
      expect(violations).toBe(1);
    }
  });
  it('先写 AGENTS.md、再写技能库：被拒且越界加一', async () => {
    for (const sandboxed of [true, false]) {
      const { decision, violations } = await run('echo x > AGENTS.md; touch .agents/skills/a/SKILL.md', sandboxed);
      expect(decision.allow).toBe(false);
      expect(violations).toBe(1);
    }
  });
  it('只写技能库的命令不计越界（反例）', async () => {
    for (const sandboxed of [true, false]) {
      const { decision, violations } = await run('touch .agents/skills/a/SKILL.md; touch playbooks/r.md', sandboxed);
      expect(decision).toEqual({ allow: false, message: REASON });
      expect(violations).toBe(0);
    }
  });
  it('mostDangerous：同为 protected 时，不是技能库只读的优先，两种顺序结果一样', () => {
    const readonly: Classification = { cls: 'protected', reason: REASON, subclass: 'skill_dir_readonly', paths: ['/a'] };
    const other: Classification = { cls: 'protected', reason: '中心管理的身份、心智视图和历史日志不能直接改写', paths: ['/b'] };
    expect(mostDangerous([readonly, other])).toMatchObject({ cls: 'protected', reason: other.reason });
    expect(mostDangerous([other, readonly])).toMatchObject({ cls: 'protected', reason: other.reason });
    expect(mostDangerous([readonly, other]).subclass).toBeUndefined();
    // 只有技能库只读的项：保持原样。
    expect(mostDangerous([readonly, readonly])).toMatchObject({ subclass: 'skill_dir_readonly' });
  });
});
