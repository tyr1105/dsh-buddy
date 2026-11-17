/**
 * P76h 第 8、9 条：旧的推送路径已经下线，推送只剩一个入口。
 *
 * 第 8 条（行为）：员工交账带提问与重要度 10 的汇报不推送；notify_owner 出站不推送；
 * 鉴权告警推送一次且为 P0；掉线告警进「待你处理」但不推送。前提：不在免打扰时段（10:00），渠道 macos。
 * 第 9 条（源码）：requestPush( 只在 outreach/notify.ts 里被调用；host.notify( 只在 outreach/push.ts 里出现。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { processCommit } from '../src/commit/process.js';
import { submitOutbox } from '../src/gate/outbox.js';
import { raiseAlert } from '../src/health/alerts.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { flushPushQueue } from '../src/outreach/notify.js';
import { botFixture } from './model-fixtures.js';

const notices = (ctx: { host: { calls: Array<{ method: string; args: unknown[] }> } }) => ctx.host.calls.filter(call => call.method === 'notify').map(call => call.args[0] as { title: string; level: string });

describe('P76h 旧路径：行为（10:00，渠道 macos）', () => {
  it('员工交账带提问与重要度 10 的汇报 → 不推送；提问照常进「待你处理」、汇报照常落线程', async () => {
    const { ctx, toolCtx } = await turnContext();
    const result = await processCommit(ctx, toolCtx, commitArgs({ report: '重要汇报全文', importance: 10,
      ownerQuestion: { text: '选哪条路线', options: ['甲', '乙'], defaultOption: '甲', whyNeeded: '才能继续' } }));
    expect(result.ok).toBe(true);
    await flushPushQueue(ctx, ctx.clock.now());
    expect(notices(ctx)).toHaveLength(0);
    expect(ctx.store.table('pushQueue').count()).toBe(0);
    expect(ctx.store.table('inbox').list(row => row.type === 'question' && row.status === 'open')).toHaveLength(1);
    expect(ctx.store.log('thread').all().some(row => row.kind === 'report' && row.text === '重要汇报全文')).toBe(true);
  });

  it('notify_owner 出站（重要度 10）→ 不推送，出站动作照常完成并落线程', async () => {
    const ctx = createTestContext();
    const bot = { ...botFixture, sessionId: 'bot-session' };
    ctx.store.table('bots').put(bot);
    const row = await submitOutbox(ctx, bot.id, { kind: 'notify_owner', payload: { text: '发现重要变化', importance: 10 }, why: '汇报' });
    await flushPushQueue(ctx, ctx.clock.now());
    expect(row.status).toBe('done');
    expect(ctx.store.log('thread').all().some(message => message.text === '发现重要变化')).toBe(true);
    expect(notices(ctx)).toHaveLength(0);
    expect(ctx.store.table('pushQueue').count()).toBe(0);
  });

  it('鉴权告警 → 推送一次，级别 P0；重复同步不再推', async () => {
    const ctx = createTestContext();
    raiseAlert(ctx, { code: 'auth', botId: null, text: '宿主鉴权失败，等待主人确认后恢复', level: 'P0', immediate: true });
    await syncAlertItems(ctx);
    await flushPushQueue(ctx, ctx.clock.now());
    await syncAlertItems(ctx);
    await flushPushQueue(ctx, ctx.clock.now());
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]).toMatchObject({ title: '中心告警：鉴权', level: 'P0' });
    expect(ctx.store.table('pushQueue').list()[0]).toMatchObject({ category: 'system', state: 'sent' });
  });

  it('掉线告警 → 进「待你处理」，不推送', async () => {
    const ctx = createTestContext();
    raiseAlert(ctx, { code: 'deadman', botId: null, text: '员工很久没有动静', level: 'P0', immediate: true });
    await syncAlertItems(ctx);
    await flushPushQueue(ctx, ctx.clock.now());
    expect(ctx.store.table('inbox').list(row => row.type === 'alert' && row.status === 'open')).toHaveLength(1);
    expect(notices(ctx)).toHaveLength(0);
    expect(ctx.store.table('pushQueue').count()).toBe(0);
  });
});

/** 递归列出 src 下全部 .ts 文件（测试里读源码文字用，不涉及 core 源码本身的限制）。 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}
const SRC = join(__dirname, '..', 'src');

/** 去掉注释行后，含有给定文字的文件（相对 src 的路径）。 */
function filesWithCode(needle: string): string[] {
  return sourceFiles(SRC).filter(file => readFileSync(file, 'utf8').split('\n')
    .some(line => line.includes(needle) && !/^\s*(\/\/|\/?\*)/.test(line))).map(file => relative(SRC, file)).sort();
}

describe('P76h 旧路径：源码只剩一个入口', () => {
  it('requestPush( 只在 outreach/notify.ts 里被调用（outreach/push.ts 只含它自己的定义）', () => {
    expect(filesWithCode('requestPush(')).toEqual(['outreach/notify.ts', 'outreach/push.ts']);
    // push.ts 里只有函数定义那一行，没有调用。
    const pushLines = readFileSync(join(SRC, 'outreach', 'push.ts'), 'utf8').split('\n').filter(line => line.includes('requestPush('));
    expect(pushLines).toHaveLength(1);
    expect(pushLines[0]).toContain('export async function requestPush(');
  });
  it('host.notify( 只在 outreach/push.ts 里出现', () => {
    expect(filesWithCode('host.notify(')).toEqual(['outreach/push.ts']);
  });
});
