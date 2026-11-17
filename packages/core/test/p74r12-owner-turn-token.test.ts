/**
 * P74r12 第 3 节的测试：主人发起的回合，token 的收口提醒线由 8 万改为 30 万。
 *
 * 覆盖：
 * 1 全新数据：主人发起的回合到 8 万 token 不提醒，到 30 万提醒；
 * 2 表里存着旧默认值 8 万的设置，读取时按 30 万生效（启动时与界面保存设置都经过同一处合并）；
 * 3 表里存着别的值（例如 12 万）的按 12 万；步数 40、时长 30 分钟不变。
 */
import { describe, expect, it } from 'vitest';
import { resolveSettings, resolveStartupSettings } from '../src/config/defaults.js';
import { CLOSING_MESSAGE } from '../src/turn/limits.js';
import { ownerSays } from './p74b-fixtures.js';
import { MINUTE, bot, jobFix, runningOf, tick, type JobFix } from './p74c-fixtures.js';

/** 给员工的这个回合一个真实的步骤事件。 */
async function stepEvent(fix: JobFix, botId: string, steps: number, tokens: number): Promise<void> {
  await fix.hub.onTurnEvent({ type: 'step', sessionId: bot(fix, botId).sessionId!, at: fix.ctx.clock.now(), steps, tokens });
}

const steered = (fix: JobFix, botId: string) => fix.ctx.host.calls.filter(call => call.method === 'steer' && call.args[0] === bot(fix, botId).sessionId).length;

describe('1 全新数据', () => {
  it('主人发起的回合：到 8 万 token 不提醒，到 30 万 token 提醒；步数 40、时长 30 分钟不变', async () => {
    const fix = await jobFix();
    expect(fix.ctx.settings.turnLimitsByVariant.owner).toEqual({ steps: 40, durationMs: 30 * MINUTE, tokens: 300_000 });
    await ownerSays(fix, fix.engineer.id, '请看一下这件事');
    for (let i = 0; i < 8 && !runningOf(fix, fix.engineer.id); i += 1) await tick(fix, 5 * MINUTE);
    expect(runningOf(fix, fix.engineer.id)?.ownerInitiated).toBe(true);
    fix.ctx.clock.advance(MINUTE);
    await stepEvent(fix, fix.engineer.id, 5, 80_000);
    await fix.hub.tick();
    await stepEvent(fix, fix.engineer.id, 6, 299_999);
    await fix.hub.tick();
    expect(steered(fix, fix.engineer.id)).toBe(0);
    fix.ctx.clock.advance(MINUTE);
    await stepEvent(fix, fix.engineer.id, 7, 300_000);
    await fix.hub.tick();
    expect(fix.ctx.host.calls).toContainEqual({ method: 'steer', args: [bot(fix, fix.engineer.id).sessionId, CLOSING_MESSAGE] });
  });
});

describe('2、3 存档里的设置', () => {
  const stored = (tokens: number) => ({ turnLimitsByVariant: { regular: { steps: 30, durationMs: 20 * MINUTE, tokens: 60_000 }, owner: { steps: 40, durationMs: 30 * MINUTE, tokens } } });

  it('存着旧默认值 8 万：读取时按 30 万生效（resolveSettings 与启动时的合并都一样）', () => {
    expect(resolveSettings(stored(80_000)).turnLimitsByVariant.owner.tokens).toBe(300_000);
    expect(resolveStartupSettings(stored(80_000), {}).turnLimitsByVariant.owner.tokens).toBe(300_000);
    // 只读取时处理：传入的对象没有被改。
    const input = stored(80_000);
    resolveSettings(input);
    expect(input.turnLimitsByVariant.owner.tokens).toBe(80_000);
  });

  it('存着别的值（12 万）：按 12 万；步数和时长也按存的', () => {
    const settings = resolveSettings(stored(120_000));
    expect(settings.turnLimitsByVariant.owner).toEqual({ steps: 40, durationMs: 30 * MINUTE, tokens: 120_000 });
  });

  it('没有存这一项：按新默认值 30 万', () => {
    expect(resolveSettings({}).turnLimitsByVariant.owner.tokens).toBe(300_000);
  });
});
