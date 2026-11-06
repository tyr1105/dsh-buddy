/** C03 回合测试建立真实内存家目录和会话绑定，避免把缺少初始化误当作越界行为。 */
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { createBotHome } from '../src/memory/index.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { createTicket } from '../src/wake/ticket.js';
import { newId } from '../src/util/ids.js';
import type { Bot, QueueEntry, Variant } from '../src/model/index.js';
import type { CommitInput } from '../src/commit/schema.js';

export function commitArgs(patch: Partial<CommitInput> = {}): CommitInput {
  return { outcome: 'no_change', summary: '资料没有变化', worldChanges: [], evidence: [],
    verification: { level: 'none', notCovered: '尚无新证据' }, blocker: null,
    nextThink: { mode: 'auto', reason: '等待新的事实' }, ownerQuestion: null,
    reply: null, report: null, importance: 5, proposals: [], ...patch };
}
export async function turnContext(variant: Variant = 'regular', patch: Partial<Bot> = {}) {
  const ctx = createTestContext();
  const now = ctx.clock.now();
  const bot = { ...botFixture, sessionId: 'session-one', sessionStartedAt: now, createdAt: now, updatedAt: now, ...patch };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const entry: QueueEntry = { ...buildCandidate(ctx, { botId: bot.id, kind: 'next_think', variant,
    score: 0.8, summary: '核对资料变化', now }), id: newId('q', ctx.rng), enqueuedAt: now };
  const ticket = createTicket(ctx, entry, bot.sessionId);
  ctx.store.table('wakes').patch(ticket.id, { status: 'running', dispatchedAt: now });
  return { ctx, bot, entry, ticket: ctx.store.table('wakes').get(ticket.id)!,
    toolCtx: { botId: bot.id, sessionId: bot.sessionId!, wakeId: ticket.id } };
}
