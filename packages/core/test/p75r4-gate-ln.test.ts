/**
 * P75r4 第 4 节的测试：闸门对建链接（ln）的识别。
 * - 误拦：cd /tmp && ln -s x .agents 不再被拒（cd 之后只按当前目录解析）；连续几个 cd 逐个跟踪；
 * - 补几种写法：合写的 -t、空格分隔的 --target-directory、等号写法、命令前的变量赋值、busybox ln、command ln；
 * - 链接所在的位置是中心管理的文件（AGENTS.md、mind/、memory/journal/）时，按受保护的写入处理：拒绝并计越界。
 * 每条命令沙箱开着、没开着都测。技能库三处的拒绝文字沿用 p75r3-gate.test.ts 里的原因。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { guardToolCall } from '../src/gate/guard.js';

const SANDBOX = { sandboxed: true, tmpDirs: ['/tmp', '/private/tmp'] };
/** 技能库三处的拒绝原因（只读、不计越界）。 */
const READONLY_REASON = '技能库由中心维护：经验在复盘时用 hub_skill 提交，核对通过后写入。';
/** 中心管理的文件的拒绝原因（受保护、计越界）。 */
const PROTECTED_REASON = '中心管理的身份、心智视图和历史日志不能直接改写';

/** 经守卫跑一条命令，返回决定与越界次数。 */
async function run(command: string, sandboxed: boolean) {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, sessionId: 'bot-session' });
  const decision = await guardToolCall(ctx, 'bot-session', 'exec', { command }, sandboxed ? SANDBOX : undefined);
  return { decision, violations: ctx.store.table('bots').get(botFixture.id)!.violations };
}
const messageOf = (decision: { allow: boolean; message?: string }): string => decision.allow ? '' : (decision.message ?? '');
const MODES = [true, false] as const;
const label = (sandboxed: boolean): string => sandboxed ? '沙箱开着' : '沙箱没开';

describe('P75r4 第 4 节第 1 条：cd 之后只按当前目录解析', () => {
  for (const sandboxed of MODES) {
    it(`${label(sandboxed)}：cd /tmp && ln -s x .agents 放行（不再误拦；链接建在 /tmp/.agents，不是家目录的）`, async () => {
      const { decision, violations } = await run('cd /tmp && ln -s x .agents', sandboxed);
      expect(messageOf(decision)).not.toBe(READONLY_REASON);
      expect(messageOf(decision)).not.toBe(PROTECTED_REASON);
      expect(violations).toBe(0);
      if (sandboxed) expect(decision).toEqual({ allow: true });
    });
    it(`${label(sandboxed)}：cd work && cd ../.agents && ln -s x skills 被拒（第二个 cd 按第一个 cd 的结果解析，链接建在 .agents/skills）`, async () => {
      const { decision, violations } = await run('cd work && cd ../.agents && ln -s x skills', sandboxed);
      expect(decision).toEqual({ allow: false, message: READONLY_REASON });
      expect(violations).toBe(0);
    });
    it(`${label(sandboxed)}：cd 到家目录以外、再 cd 回来之后建在 .agents 里的链接仍被拒`, async () => {
      const { decision } = await run('cd /tmp && cd /hub/bots/b_0000000001/.agents && ln -s x skills', sandboxed);
      expect(decision).toEqual({ allow: false, message: READONLY_REASON });
    });
  }
});

describe('P75r4 第 4 节第 2 条：补几种写法', () => {
  const DENIED = [
    'ln -st .agents/skills x',           // 合写的 -t
    'ln -sft .agents/skills x',          // 合写的 -t（-f 在前）
    'ln -t .agents/skills x',            // 原有写法仍认
    'ln -t.agents/skills x',             // 值紧贴在 -t 后面
    'ln --target-directory .agents/skills x',   // 空格分隔的长选项
    'ln --target-directory=.agents/skills x',   // 等号写法
    'FOO=1 ln -s work/fake .agents',     // 命令前面带变量赋值
    'FOO=1 BAR=2 ln -s work/fake playbooks',
    'busybox ln -s work/fake .agents',
    'command ln -s work/fake .agents',
  ];
  for (const sandboxed of MODES) {
    for (const command of DENIED) {
      it(`${label(sandboxed)}：${command} 被拒，原因码只读，不计越界`, async () => {
        const { decision, violations } = await run(command, sandboxed);
        expect(decision).toEqual({ allow: false, message: READONLY_REASON });
        expect(violations).toBe(0);
      });
    }
  }
  // 反例：同样的写法，但链接建在 work 里：不被只读规则拦。
  const ALLOWED = [
    'ln -st work x', 'ln --target-directory work x', 'ln --target-directory=work x',
    'FOO=1 ln -s ../shared/a work/a', 'busybox ln -s ../shared/a work/a', 'command ln -s ../shared/a work/a',
  ];
  for (const sandboxed of MODES) {
    for (const command of ALLOWED) {
      it(`${label(sandboxed)}：${command} 不被只读规则误拦`, async () => {
        const { decision, violations } = await run(command, sandboxed);
        expect(messageOf(decision)).not.toBe(READONLY_REASON);
        expect(messageOf(decision)).not.toBe(PROTECTED_REASON);
        expect(violations).toBe(0);
        if (sandboxed) expect(decision).toEqual({ allow: true });
      });
    }
  }
});

describe('P75r4 第 4 节第 3 条：链接建在中心管理的文件上，按受保护的写入处理', () => {
  const PROTECTED = [
    'ln -sf /dev/null AGENTS.md',
    'ln -s x mind/now.md',
    'ln -s x memory/journal/2026-11-13.md',
    'ln -st mind x',                         // 与第 2 条的写法叠加
    'FOO=1 ln -sf /dev/null AGENTS.md',
  ];
  for (const sandboxed of MODES) {
    for (const command of PROTECTED) {
      it(`${label(sandboxed)}：${command} 被拒，原因是受保护，越界加一`, async () => {
        const { decision, violations } = await run(command, sandboxed);
        expect(decision).toEqual({ allow: false, message: PROTECTED_REASON });
        expect(violations).toBe(1);
      });
    }
    it(`${label(sandboxed)}：反例：在 work 里建指向 AGENTS.md 的链接不受影响（链接所在的位置是 work/link）`, async () => {
      const { decision, violations } = await run('ln -s ../AGENTS.md work/link', sandboxed);
      expect(messageOf(decision)).not.toBe(PROTECTED_REASON);
      expect(messageOf(decision)).not.toBe(READONLY_REASON);
      expect(violations).toBe(0);
      if (sandboxed) expect(decision).toEqual({ allow: true });
    });
    it(`${label(sandboxed)}：一条命令里同时有技能库三处和 AGENTS.md：按受保护处理，越界加一`, async () => {
      const { decision, violations } = await run('ln -s x .agents && ln -sf /dev/null AGENTS.md', sandboxed);
      expect(decision).toEqual({ allow: false, message: PROTECTED_REASON });
      expect(violations).toBe(1);
    });
  }
});

describe('P75r4 第 4 节：正常的 ln 不被误拦', () => {
  for (const sandboxed of MODES) {
    for (const command of ['ln -s ../shared/a work/a', 'ln -s .agents/skills work/skills-link', 'ln work/a work/b', 'cd work && ln -s ../.agents/skills s']) {
      it(`${label(sandboxed)}：${command}`, async () => {
        const { decision, violations } = await run(command, sandboxed);
        expect(messageOf(decision)).not.toBe(READONLY_REASON);
        expect(messageOf(decision)).not.toBe(PROTECTED_REASON);
        expect(violations).toBe(0);
        if (sandboxed) expect(decision).toEqual({ allow: true });
      });
    }
  }
});
