/**
 * P75r2 第 6 节（审查 L6）：队列里的旧复盘、旧教学候选每次启动都丢弃，不依赖迁移成功；
 * 第 7 节：三处原来没有测试守着的判断（迁移完成后撤回旧教训提议不改 rules、启动时清理上次停在 writing 的半份数据；
 * 迁移时跳过员工已不存在的规矩另见 p75r2-rules.test.ts）。
 * 夹具与真实情况一致（见 p75r2-fixtures.ts）。
 */
import { describe, expect, it } from 'vitest';
import { runP75Migration } from '../src/migrate/p75-storage.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { answerInbox, createInboxItem, expireInbox } from '../src/outreach/inbox.js';
import { writeMemory } from '../src/memory/service.js';
import { writeSkillVersion } from '../src/skill/store.js';
import { SkillSourceSchema } from '../src/model/skill.js';
import { newId } from '../src/util/ids.js';
import type { HubContext } from '../src/engine/context.js';
import { legacyWorld, putRule, record, ruleId } from './p75r2-fixtures.js';

/**
 * 往队列里放一条候选：旧复盘（默认事项键）、旧教学，或指定事项键的候选。
 * 为什么不走 enqueue：enqueue 会把同一位员工的候选合并成一条（真实行为），这里要同一位员工同时有几条不同事项键的候选，
 * 所以按 enqueue 生成行的同一形状（候选加编号与入队时间）直接写表。
 */
function put(ctx: HubContext, botId: string, kind: 'reflection' | 'teach' | 'owner_message', variant: 'reflection' | 'teach' | 'regular', subjectKey?: string) {
  const candidate = buildCandidate(ctx, { botId, kind, variant, score: 1, summary: `${kind}/${variant}`, ownerInitiated: kind !== 'reflection',
    ...(kind === 'owner_message' ? { messageId: `m-${botId}` } : {}), ...(subjectKey ? { subjectKey } : {}) });
  const row = { ...candidate, id: newId('q', ctx.rng), enqueuedAt: ctx.clock.now() };
  ctx.store.table('queue').put(row);
  return row;
}
const queueKeys = (ctx: HubContext) => ctx.store.table('queue').list().map(row => row.subjectKey).sort();
const auditCount = (ctx: HubContext, action: string) => ctx.store.log('audit').all().filter(row => row.action === action).length;

describe('P75r2 第 6 节：旧候选的清理不依赖迁移成功', () => {
  /** 一个迁移必失败的世界（损坏的旧规矩行：创建时间不是整数毫秒）。 */
  async function failingWorld() {
    const world = await legacyWorld();
    putRule(world.ctx, ruleId(1), { text: '先给主人看', createdAt: 1.5 });
    return world;
  }

  it('迁移失败时旧复盘候选、旧教学候选被丢弃并记审计；事项键是 retro:、skillcheck:、tidy:、learn: 开头的不被丢弃；别的候选不动', async () => {
    const { ctx, chiefBot, other } = await failingWorld();
    put(ctx, chiefBot.id, 'reflection', 'reflection');                       // 旧复盘（默认事项键）
    put(ctx, other.id, 'teach', 'teach', 'teach:ev-1');                       // 旧教学
    put(ctx, chiefBot.id, 'reflection', 'reflection', 'retro:x:y');           // 后续卡的复盘候选
    put(ctx, other.id, 'reflection', 'reflection', 'skillcheck:a');
    put(ctx, other.id, 'reflection', 'reflection', 'tidy:b');
    put(ctx, chiefBot.id, 'teach', 'teach', 'learn:x');                       // 后续卡的学习候选
    put(ctx, chiefBot.id, 'owner_message', 'regular');                        // 普通候选
    expect(ctx.store.table('queue').count()).toBe(7);
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'failed' });
    expect(queueKeys(ctx)).toEqual(expect.arrayContaining(['retro:x:y', 'skillcheck:a', 'tidy:b', 'learn:x']));
    expect(ctx.store.table('queue').count()).toBe(5);
    expect(ctx.store.table('queue').count(row => row.subjectKey.startsWith('teach:ev-1') || row.subjectKey.startsWith('src:'))).toBe(0);
    expect(ctx.store.table('queue').count(row => row.reason.kind === 'owner_message')).toBe(1);
    expect(auditCount(ctx, 'p75_dropped_reflection')).toBe(1);
    expect(auditCount(ctx, 'p75_dropped_teach')).toBe(1);
  });

  it('迁移完成之后再启动：新来的旧复盘、旧教学候选同样被丢弃，事项键带前缀的仍不动', async () => {
    const { ctx, chiefBot, other } = await legacyWorld();
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done' });
    put(ctx, chiefBot.id, 'reflection', 'reflection');
    put(ctx, other.id, 'teach', 'teach', 'teach:ev-2');
    put(ctx, other.id, 'reflection', 'reflection', 'retro:keep:me');
    put(ctx, chiefBot.id, 'teach', 'teach', 'learn:keep');
    await runP75Migration(ctx);
    expect(queueKeys(ctx)).toEqual(['learn:keep', 'retro:keep:me']);
    expect(auditCount(ctx, 'p75_dropped_reflection')).toBe(1);
    expect(auditCount(ctx, 'p75_dropped_teach')).toBe(1);
    // 再启动一次：什么都不再丢。
    await runP75Migration(ctx);
    expect(queueKeys(ctx)).toEqual(['learn:keep', 'retro:keep:me']);
    expect(auditCount(ctx, 'p75_dropped_teach')).toBe(1);
  });
});

describe('P75r2 第 7 节：迁移完成后撤回旧教训提议不改 rules', () => {
  /** 一条提议中的旧教训规矩和对应的开着的提议条目。 */
  function openLessonProposal(ctx: HubContext, botId: string, n: number) {
    ctx.store.table('rules').put({ id: ruleId(n), scope: botId, text: `先跑一遍再交 ${n}`, redLine: false, source: 'lesson', status: 'proposed', createdAt: ctx.clock.now() });
    return createInboxItem(ctx, { botId, type: 'proposal', title: `教训 ${n}`, body: 'why', subjectKey: `proposal:p${n}`, refId: ruleId(n) });
  }

  it('迁移完成后：主人点「不做」、提议到期撤回，rules 里的规矩都保持 proposed 不变', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done' });
    const rejected = openLessonProposal(ctx, chiefBot.id, 1);
    await answerInbox(ctx, rejected.id, '不做');
    expect(ctx.store.table('inbox').get(rejected.id)!.status).toBe('answered');
    expect(ctx.store.table('rules').get(ruleId(1))).toMatchObject({ status: 'proposed' });
    const expiring = openLessonProposal(ctx, chiefBot.id, 2);
    await expireInbox(ctx, ctx.clock.now() + ctx.settings.proposalExpiryMs + 1);
    expect(ctx.store.table('inbox').get(expiring.id)).toMatchObject({ status: 'withdrawn', answer: '到期撤回' });
    expect(ctx.store.table('rules').get(ruleId(2))).toMatchObject({ status: 'proposed' });
  });

  it('反例：迁移未完成时，同样的撤回把规矩改成已归档（旧行为）', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    const rejected = openLessonProposal(ctx, chiefBot.id, 1);
    await answerInbox(ctx, rejected.id, '不做');
    expect(ctx.store.table('rules').get(ruleId(1))).toMatchObject({ status: 'archived' });
    const expiring = openLessonProposal(ctx, chiefBot.id, 2);
    await expireInbox(ctx, ctx.clock.now() + ctx.settings.proposalExpiryMs + 1);
    expect(ctx.store.table('rules').get(ruleId(2))).toMatchObject({ status: 'archived' });
    expect(expiring.id).toBeTruthy();
  });
});

describe('P75r2 第 7 节：启动时清理上次停在 writing 的半份数据', () => {
  it('writing 记录里 written 登记的行（记忆、出处、技能、版本）被清掉，没有登记的行不动；随后迁移完成', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, ruleId(1), { text: '先给主人看' });
    // 上次进程写到一半：写了一条记忆、一条出处、一条技能与它的版本，迁移记录停在 writing。
    const ghostMemory = await writeMemory(ctx, { kind: 'rule', text: '半份数据里的记忆', example: null, redLine: false,
      scope: { staff: 'all', projects: 'all' }, refresh: false,
      source: { kind: 'legacy_owner_rule', messageIds: [], quote: '半份', threadId: null, legacyRuleId: ruleId(1) } });
    const ghostSource = SkillSourceSchema.parse({ id: newId('ss', ctx.rng), botId: chiefBot.id, kind: 'unknown', label: '迁移：升级前的规矩',
      quote: '半份数据里的出处', relayed: false, jobId: null, category: null, refs: {}, createdAt: ctx.clock.now() });
    ctx.store.table('skillSources').put(ghostSource);
    const ghostVersion = await writeSkillVersion(ctx, { botId: chiefBot.id, change: 'migrate', newSkill: { title: '半份技能', whenToUse: '占位', supplements: null },
      sentences: [{ text: '半份数据里的句子', sourceIds: [ghostSource.id] }], updateId: null, checkedBy: 'hub', categories: [], materialize: false,
      legacy: { kind: 'lesson', refId: null } });
    // 没有登记的行（比如主人这期间手写的一条记忆）不动。
    const unrelated = await writeMemory(ctx, { kind: 'rule', text: '主人手写的一条', example: null, redLine: false,
      scope: { staff: 'all', projects: 'all' }, refresh: false, source: { kind: 'owner_edit', messageIds: [], quote: '手写', threadId: null } });
    ctx.store.table('migrations').put({ id: 'p75-storage', state: 'writing', attempts: 1, error: null, steps: {}, updatedAt: ctx.clock.now(),
      written: { memories: [ghostMemory.id], skillSources: [ghostSource.id], skills: [ghostVersion.skillId], skillVersions: [ghostVersion.id] } });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', attempts: 1 });
    expect(ctx.store.table('memories').get(ghostMemory.id)).toBeNull();
    expect(ctx.store.table('skillSources').get(ghostSource.id)).toBeNull();
    expect(ctx.store.table('skills').get(ghostVersion.skillId)).toBeNull();
    expect(ctx.store.table('skillVersions').get(ghostVersion.id)).toBeNull();
    expect(ctx.store.table('memories').get(unrelated.id)).not.toBeNull();
    // 重新迁入的是旧规矩那一条，只有一份（半份数据没有留下重复）。
    const migrated = ctx.store.table('memories').list(row => row.source.legacyRuleId === ruleId(1));
    expect(migrated.map(row => row.text)).toEqual(['先给主人看']);
    expect(ctx.store.table('skills').count()).toBe(0);
  });
});
