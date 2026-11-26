/**
 * P73c 测试的公共环境（不是测试文件）：真实 Hub + 假宿主。
 * 为什么用真实链路：自动建总管、三问、发卡、条目都挂在 Hub 启动和命令出口上，只有走真实链路才能测到「接线」。
 * 「不调用模型」的判断：假宿主记录的 createSession 和 deliver 调用次数都为 0，唤醒队列为空。
 */
import { expect } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub, type Hub } from '../src/engine/hub.js';
import type { Bot, ThreadMessage } from '../src/model/index.js';
import type { TeamProposal, TeamSetup } from '../src/model/team-proposal.js';
import { createBotHome } from '../src/memory/files.js';
import { botFixture } from './model-fixtures.js';
import { okData } from './c04-api-fixtures.js';
import { settleTeamSetup, sweepTeamSetup } from '../src/team/setup.js';
import { PICK_SUBJECT_PREFIX } from '../src/team/pick-key.js';

export { okData };

/** 测试上下文的具体类型（直接写 ReturnType 会带上泛型的宽泛默认值，字段变成可能为空）。 */
function newCtx() { return createTestContext(); }
export type TestCtx = ReturnType<typeof newCtx>;

export interface TeamFix { ctx: TestCtx; hub: Hub; chief: Bot | null }

/** 预置一位员工（直接写表并建家目录），用于「已有员工的存档」。 */
export async function presetBot(ctx: TestCtx, index: number, patch: Partial<Bot> = {}): Promise<Bot> {
  const id = `b_p73c${String(index).padStart(6, '0')}`;
  const now = ctx.clock.now();
  const bot: Bot = { ...botFixture, id, name: `老员工${index}`, role: 'executor', lifecycle: 'active', homeDir: `/hub/bots/${id}`,
    sessionId: null, sessionStartedAt: null, createdAt: now, updatedAt: now, lastThinkAt: null, nextThinkAt: null, lightCheckAt: null,
    onDemand: true, autonomy: 'L1', pace: 'quiet', ...patch };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  return bot;
}

/**
 * 启动一个中心。before 在启动之前执行（预置员工、改设置），空存档什么都不传。
 * settings 里的值同时写进测试上下文和中心。
 */
export async function teamHub(options: { settings?: Record<string, unknown>; before?: (ctx: TestCtx) => Promise<void> } = {}): Promise<TeamFix> {
  const ctx = newCtx();
  Object.assign(ctx.settings, options.settings ?? {});
  if (options.before) await options.before(ctx);
  const hub = createHub({ ...ctx, settings: { ...ctx.settings, ...(options.settings ?? {}) } });
  await hub.start();
  const chief = ctx.store.table('bots').list(bot => bot.role === 'chief')[0] ?? null;
  return { ctx, hub, chief };
}

/** 宿主上和模型有关的调用（创建会话、投递唤醒）。 */
export function modelCalls(ctx: TestCtx): Array<{ method: string }> {
  return ctx.host.calls.filter(call => call.method === 'createSession' || call.method === 'deliver');
}

/** 断言「没有调用模型、没有排唤醒」：宿主没有投递，队列和唤醒单都是空的。 */
export function expectNoModelWork(ctx: TestCtx): void {
  expect(modelCalls(ctx)).toEqual([]);
  expect(ctx.store.table('queue').list()).toEqual([]);
  expect(ctx.store.table('wakes').list()).toEqual([]);
}

/**
 * W11：三问答完后，除了总管的那一个挑人回合，没有别的模型调用：
 * 队列为空，唤醒单都是挑人回合，宿主只为它投递。
 */
export function expectOnlyPickTurn(ctx: TestCtx): void {
  expect(ctx.store.table('queue').list()).toEqual([]);
  const wakes = ctx.store.table('wakes').list();
  expect(wakes.length).toBeLessThanOrEqual(1);
  for (const wake of wakes) expect(wake.subjectKey?.startsWith(PICK_SUBJECT_PREFIX)).toBe(true);
  // 第一回合由宿主建会话时一并投递（createSession），之后的回合才走 deliver；两者合计每个回合至多各一次。
  expect(modelCalls(ctx).length).toBeLessThanOrEqual(wakes.length * 2);
}

/** 某个线程里的全部消息，从旧到新。 */
export function thread(ctx: TestCtx, threadId: string): ThreadMessage[] {
  return ctx.store.log('thread').all().filter(row => row.thread === threadId);
}

export function theSetup(ctx: TestCtx): TeamSetup {
  const rows = ctx.store.table('teamSetups').list();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

export function theProposal(ctx: TestCtx): TeamProposal {
  const rows = ctx.store.table('teamProposals').list();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** 点选回答三问中的一问。 */
export async function pick(fix: TeamFix, step: 1 | 2 | 3, choice: string, extra: Record<string, unknown> = {}) {
  return fix.hub.api.answerTeamQuestion({ setupId: theSetup(fix.ctx).id, step, choice, ...extra });
}

/**
 * W11：答完第三问后总管的挑人回合没能排上（把排队的挑人候选撤掉），跑一次兜底检查，按规则表出默认推荐。
 * P73c 这一批测试测的是规则表出卡之后的流程（卡内修改、确认、拒绝……），默认推荐走的正是这条路；
 * 总管真的挑人的流程在 w11-chief-pick.test.ts。
 */
export async function pickFallsBack(fix: TeamFix): Promise<void> {
  for (const row of fix.ctx.store.table('queue').list(entry => entry.subjectKey.startsWith(PICK_SUBJECT_PREFIX))) {
    fix.ctx.store.table('queue').remove(row.id);
  }
  // 已经投递出去的挑人回合：当作出错结束（假宿主不会真的跑回合）。
  const now = fix.ctx.clock.now();
  for (const wake of fix.ctx.store.table('wakes').list(row => row.subjectKey?.startsWith(PICK_SUBJECT_PREFIX) === true && row.endedAt === null)) {
    fix.ctx.store.table('wakes').patch(wake.id, { status: 'error', endedAt: now, error: '测试：挑人回合没能完成' });
  }
  sweepTeamSetup(fix.ctx);
  await settleTeamSetup(fix.ctx);
}

/** 三问全部点选答完（软件类、没有项目、只在拍板时），总管没能挑人，得到默认推荐的初始组队卡。 */
export async function answerAll(fix: TeamFix, work = 'software'): Promise<TeamProposal> {
  okData(await pick(fix, 1, work));
  okData(await pick(fix, 2, 'no'));
  okData(await pick(fix, 3, 'decisions'));
  await pickFallsBack(fix);
  return theProposal(fix.ctx);
}

/** 组队卡当前的全部「待你处理」条目（含已处理的）。 */
export function teamInboxItems(ctx: TestCtx) {
  return ctx.store.table('inbox').list(row => row.subjectKey.startsWith('team:'));
}
/** 还开着的组队卡条目。 */
export function openTeamInbox(ctx: TestCtx) {
  return teamInboxItems(ctx).filter(row => row.status === 'open');
}
