/**
 * P75r2 测试的公共环境（不是测试文件）：带两位员工的「升级前」世界，以及放旧规矩、旧套路、旧长期记忆的小工具。
 * 夹具与真实情况一致：员工的家目录与 memory/MEMORY.md 已建好（初始两行），没有迁移记录；
 * 旧表数据直接写进 store 模拟升级前的存量；时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { posix } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { Rule, Routine } from '../src/model/team.js';
import { botFixture } from './model-fixtures.js';

/** 初始的长期记忆文件内容（创建员工时写下的两行）。 */
export const INITIAL_MEMORY_MD = '# 长期记忆\n\n只记录已经确认、适合长期保留的事实与经验。\n';

/** 迁移记录。 */
export const record = (ctx: HubContext) => ctx.store.table('migrations').get('p75-storage');

/** 两位员工：第一位是 botFixture，第二位是评审甲。 */
export function twoBots() {
  return [botFixture, { ...botFixture, id: 'b_0000000002', name: '评审甲', homeDir: '/hub/bots/b_0000000002' }];
}

/** 把两位员工写进存储（不碰文件）。 */
export function seedBots(ctx: HubContext) {
  const bots = twoBots();
  for (const bot of bots) ctx.store.table('bots').put({ ...bot, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
  return { chiefBot: bots[0]!, other: bots[1]! };
}

/** 建一个带两位员工的旧世界：家目录已建、MEMORY.md 是初始两行、没有迁移记录。fs 可传入以复用同一份文件系统。 */
export async function legacyWorld(fs?: HubContext['fs']) {
  const ctx = createTestContext(fs ? { fs } : undefined) as unknown as HubContext;
  const { chiefBot, other } = seedBots(ctx);
  for (const bot of [chiefBot, other]) {
    await ctx.fs.mkdirp(posix.join(bot.homeDir, 'memory'), { within: bot.homeDir });
    await ctx.fs.writeTextAtomic(posix.join(bot.homeDir, 'memory', 'MEMORY.md'), INITIAL_MEMORY_MD, { within: bot.homeDir });
  }
  return { ctx, chiefBot, other };
}

/** 放一条旧规矩。 */
export function putRule(ctx: HubContext, ruleId: string, patch: Partial<Rule> = {}) {
  ctx.store.table('rules').put({ id: ruleId, scope: 'global', text: '规矩内容', redLine: false, source: 'owner', status: 'active', createdAt: 1, ...patch } as Rule);
}

/** 放一条旧套路。 */
export function putRoutine(ctx: HubContext, routineId: string, patch: Partial<Routine> = {}) {
  ctx.store.table('routines').put({ id: routineId, botId: botFixture.id, name: '核查来源', slug: 'check', whenToUse: '资料变化时',
    steps: ['打开原文', '核对日期'], learnedFrom: null, runs: 0, lastRunAt: null, createdAt: 1, updatedAt: 1, ...patch } as Routine);
}

/** 写某位员工的长期记忆文件。 */
export async function putMemoryMd(ctx: HubContext, homeDir: string, content: string) {
  await ctx.fs.writeTextAtomic(posix.join(homeDir, 'memory', 'MEMORY.md'), content, { within: homeDir });
}

/** 编号：ru_ 加 10 位数字。 */
export const ruleId = (n: number) => `ru_${String(n).padStart(10, '0')}`;
/** 编号：r_ 加 10 位数字。 */
export const routineId = (n: number) => `r_${String(n).padStart(10, '0')}`;

/** 预先放一条同名技能（占位）：迁移写同名技能时会被 writeSkillVersion 拒绝，用来制造「单条写不进」。 */
export function putBlockingSkill(ctx: HubContext, botId: string, title: string, n: number) {
  ctx.store.table('skills').put({ id: `sk_${String(n).padStart(10, '0')}`, botId, title, whenToUse: '占位', supplements: null,
    dirName: `self-${String(n).padStart(8, '0')}`, state: 'collapsed', collapseReason: 'merged', currentVersionNo: 1, categories: [],
    lastUsedAt: null, legacy: null, createdAt: 1, updatedAt: 1, collapsedAt: 1 } as never);
}
