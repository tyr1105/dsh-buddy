/**
 * F02 过程下钻：DSH 工具调用要能写进本次唤醒的账本，并能从账本详情读到。
 * 正例：带参数与结果的成功调用；反例：宿主没给参数时标「不完整」，
 * 封存后的账本不再接受追加，找不到唤醒时静默跳过而不是报错。
 */
import { describe, expect, it } from 'vitest';
import type { Bot, WakeTicket } from '../src/model/index.js';
import { openLedgerForWake, recordDshToolAction, sealLedgerForWake } from '../src/ledger/service.js';
import { wakeLedgerDetail } from '../src/api/ledger-views.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';

const botId = 'b_0000000001';
const wakeId = 'w_0000000001';

function ticket(patch: Partial<WakeTicket> = {}): WakeTicket {
  const at = 1_793_808_000_000;
  return {
    id: wakeId, botId, sessionId: 'session-one', variant: 'regular',
    reason: { kind: 'percept', score: 0.8, threshold: 0.6, summary: '资料发生变化', ownerSummary: '资料有更新', evidence: ['p_0000000001'] },
    ownerInitiated: false, packetBytes: 1200, status: 'running', startedAt: at, lastEventAt: at,
    endedAt: null, steps: 2, tokens: 300, steeredAt: null, commitId: null, error: null, ...patch,
  };
}

/** 放入一个在岗机器人、一条运行中的唤醒单和它引用的证据，并开出账本。 */
function seed() {
  const ctx = createTestContext();
  const now = ctx.clock.now();
  const bot: Bot = { ...botFixture, activity: 'thinking', updatedAt: now } as Bot;
  ctx.store.table('bots').put(bot);
  // 唤醒单的理由引用 p_0000000001；补上感知证据，开账才可能完整。
  ctx.store.table('percepts').put({
    id: 'p_0000000001', botId, watchId: null, source: 'file', kind: 'changed',
    summary: '文件增加一段文字', location: '/hub/shared/notes.txt', fingerprint: '0123456789abcdef',
    relevance: 0.8, novelty: 1, magnitude: 0.2, importance: 0.6, urgency: 0.5, anomaly: false,
    salience: 0.63, untrusted: true, tier: 'pile', consumedByWake: null, createdAt: now - 60_000,
  });
  ctx.store.table('wakes').put(ticket());
  const ledger = openLedgerForWake(ctx, wakeId, null)!;
  return { ctx, ledger };
}

describe('F02 过程下钻', () => {
  it('成功调用写入 dsh_tool 动作：工具名、人话目标、结果摘要与调用 id', () => {
    const { ctx } = seed();
    recordDshToolAction(ctx, wakeId, {
      name: 'read_file',
      args: { path: '/hub/shared/notes.txt' },
      isError: false,
      resultText: '第一版内容',
      callId: 'call-1',
    });
    const view = wakeLedgerDetail(ctx, wakeId)!;
    expect(view.actions).toHaveLength(1);
    expect(view.actions[0]).toMatchObject({
      kind: 'dsh_tool', kindLabel: 'DSH 工具', name: 'read_file', outcome: 'ok', outcomeLabel: '成功',
      source: 'observed', sourceLabel: '中心观察到', refId: 'call-1', detail: '第一版内容',
    });
    expect(view.actions[0]!.target).toContain('/hub/shared/notes.txt');
    expect(view.entry.completeness).toBe('full');
  });

  it('宿主没给参数时目标写明缺失，并标成不完整、缺动作段', () => {
    const { ctx } = seed();
    recordDshToolAction(ctx, wakeId, {
      name: 'bash', args: undefined, isError: true, resultText: '命令失败', callId: 'call-2',
    });
    const view = wakeLedgerDetail(ctx, wakeId)!;
    expect(view.actions[0]).toMatchObject({
      kind: 'dsh_tool', target: '（宿主未提供参数）', outcome: 'error', outcomeLabel: '失败', detail: '命令失败',
    });
    expect(view.entry.completeness).toBe('partial');
    expect(view.entry.missing).toContain('actions');
  });

  it('封存后不再追加；没有对应账本时不报错也不造记录', () => {
    const { ctx } = seed();
    sealLedgerForWake(ctx, wakeId);
    recordDshToolAction(ctx, wakeId, { name: 'read_file', args: {}, isError: false, resultText: '太晚了', callId: 'c3' });
    expect(wakeLedgerDetail(ctx, wakeId)!.actions).toHaveLength(0);
    expect(() => recordDshToolAction(ctx, 'w_not_found', {
      name: 'read_file', args: {}, isError: false, resultText: '', callId: 'c4',
    })).not.toThrow();
  });
});
