/**
 * P75r5b 第 8 节第 2 条的测试：建链接识别里，cd 带选项或参数不是恰好一个时，按「目标认不出」处理。
 * 背景：`cd -- .agents && ln -s /x skills`、`cd -P x`、`cd -L x` 以前因为「cd 后面恰好两个词」的判断不跟踪，
 * 后面的 ln 只按原目录判断，漏掉了「cd 到了技能库」的情形。
 * 每条命令沙箱开着、没开着都测；P75r5a 的测试原样通过（本文件不改它们）。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { guardToolCall } from '../src/gate/guard.js';

const SANDBOX = { sandboxed: true, tmpDirs: ['/tmp', '/private/tmp'] };

async function run(command: string, sandboxed: boolean) {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, sessionId: 'bot-session' });
  const decision = await guardToolCall(ctx, 'bot-session', 'exec', { command }, sandboxed ? SANDBOX : undefined);
  return { decision, violations: ctx.store.table('bots').get(botFixture.id)!.violations };
}

describe('cd 带选项：目标认不出，后面的 ln 不能只按原目录判断', () => {
  for (const sandboxed of [true, false]) {
    for (const command of ['cd -- .agents && ln -s /x skills', 'cd -P .agents && ln -s /x skills', 'cd -L .agents && ln -s /x skills']) {
      it(`${sandboxed ? '沙箱开着' : '沙箱没开'}：${command} 被拒、不计越界`, async () => {
        const { decision, violations } = await run(command, sandboxed);
        expect(decision.allow, JSON.stringify(decision)).toBe(false);
        expect(violations).toBe(0);
      });
    }
  }
});

describe('反例：写法正常的 cd（恰好一个参数、没有选项）仍按目标精确判断，不被误拦', () => {
  it('沙箱开着：cd /tmp && ln -s /x skills 放行（链接建在 /tmp）', async () => {
    const { decision } = await run('cd /tmp && ln -s /x skills', true);
    expect(decision, JSON.stringify(decision)).toEqual({ allow: true });
  });
  it('沙箱没开：同一条命令不会被说成「看不出在哪个目录」（沙箱没开时 ln 本来就要主人批准，与 cd 的识别无关）', async () => {
    const { decision, violations } = await run('cd /tmp && ln -s /x skills', false);
    expect(decision.allow ? '' : decision.message ?? '').not.toContain('看不出这条命令执行时在哪个目录');
    expect(violations).toBe(0);
  });
});
