/**
 * P75r2 第 4 节（审查 H1、L3）：迁移告警两句逐字固定，不带员工编号、表名、字段名；原因只写进迁移记录和日志。
 * 夹具与真实情况一致（见 p75r2-fixtures.ts）。
 */
import { describe, expect, it } from 'vitest';
import { runP75Migration } from '../src/migrate/p75-storage.js';
import { legacyWorld, putBlockingSkill, putMemoryMd, putRoutine, putRule, record, routineId, ruleId } from './p75r2-fixtures.js';

const FAILED_TEXT = '升级时整理旧的规矩、套路和长期记忆没有完成，每次启动会再试。旧的规矩照常生效；旧的套路和长期记忆暂时没有带给员工。';
const TAIL = '没能整理进技能库，不再带给员工；原文仍保留在旧数据里。';

describe('P75r2 第 4 节：整次没有完成的告警', () => {
  it('连续三次失败后出现一条（文字逐字、级别 P1、开着）；第一、二次没有；第四次不再多出；原因只在迁移记录里', async () => {
    const { ctx } = await legacyWorld();
    // 损坏的旧规矩行（创建时间不是整数毫秒）：记忆校验仍会不过，整次迁移不做。
    putRule(ctx, ruleId(1), { text: '先给主人看', createdAt: 1.5 });
    const counts: number[] = [];
    for (let run = 1; run <= 4; run += 1) {
      await runP75Migration(ctx);
      counts.push(ctx.store.table('alerts').count(alert => alert.code === 'p75:migration'));
    }
    expect(counts).toEqual([0, 0, 1, 1]);
    const alert = ctx.store.table('alerts').list(item => item.code === 'p75:migration')[0]!;
    expect(alert).toMatchObject({ text: FAILED_TEXT, level: 'P1', status: 'open', botId: null });
    // 不出现员工编号、表名、字段名。
    expect(alert.text).not.toMatch(/b_\d|ru_\d|botId|memories|skills|createdAt/);
    // 原因写进迁移记录的 error（带字段路径），不在告警里。
    expect(record(ctx)).toMatchObject({ state: 'failed', attempts: 4 });
    expect(record(ctx)!.error).toContain('createdAt');
  });

  it('反例：迁移成功就没有这一句；之前开着的这一句在迁移完成后关闭', async () => {
    const { ctx } = await legacyWorld();
    putRule(ctx, ruleId(1), { text: '先给主人看', createdAt: 1.5 });
    for (let run = 1; run <= 3; run += 1) await runP75Migration(ctx);
    expect(ctx.store.table('alerts').count(alert => alert.code === 'p75:migration' && alert.status === 'open')).toBe(1);
    ctx.store.table('rules').put({ id: ruleId(1), scope: 'global', text: '先给主人看', redLine: false, source: 'owner', status: 'active', createdAt: 1 });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done' });
    expect(ctx.store.table('alerts').count(alert => alert.code === 'p75:migration' && alert.status === 'open')).toBe(0);
  });

  it('反例：备份写不进也是整次没完成，同样用这一句，不带路径和员工编号', async () => {
    const { ctx, other } = await legacyWorld();
    await putMemoryMd(ctx, other.homeDir, '# 长期记忆\n\n一条事实。\n');
    const original = ctx.fs.writeTextAtomic.bind(ctx.fs);
    ctx.fs.writeTextAtomic = async (path: string, content: string, options?: unknown) => {
      if (path.includes('/.hub/legacy/')) throw new Error('磁盘满');
      return original(path, content, options as never);
    };
    for (let run = 1; run <= 3; run += 1) await runP75Migration(ctx);
    const alerts = ctx.store.table('alerts').list(item => item.code === 'p75:migration');
    expect(alerts.map(item => item.text)).toEqual([FAILED_TEXT]);
  });
});

describe('P75r2 第 4 节：完成了但有跳过的告警', () => {
  /** 按需要让某几类各有一条写不进（同名占位技能），再跑迁移，返回这一次出的告警。 */
  async function run(options: { routine?: boolean; lesson?: boolean; memory?: boolean }) {
    const { ctx, chiefBot, other } = await legacyWorld();
    if (options.routine) { putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '核查来源' }); putBlockingSkill(ctx, chiefBot.id, '核查来源', 1); }
    if (options.lesson) {
      putRule(ctx, ruleId(1), { scope: chiefBot.id, source: 'lesson', text: '教训甲' });
      putRule(ctx, ruleId(2), { scope: chiefBot.id, source: 'lesson', text: '教训乙' });
      putBlockingSkill(ctx, chiefBot.id, '我的做法', 2);
    }
    if (options.memory) { await putMemoryMd(ctx, other.homeDir, '# 长期记忆\n\n一条事实。\n'); putBlockingSkill(ctx, other.id, '原长期记忆', 3); }
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done' });
    return ctx.store.table('alerts').list(alert => alert.code === 'p75:migration-skipped');
  }

  it('只有套路', async () => {
    const alerts = await run({ routine: true });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ text: `升级时有1 条旧套路${TAIL}`, level: 'P2', status: 'open', botId: null });
  });

  it('套路加教训', async () => {
    const alerts = await run({ routine: true, lesson: true });
    expect(alerts.map(alert => alert.text)).toEqual([`升级时有1 条旧套路、2 条旧教训${TAIL}`]);
  });

  it('三类都有', async () => {
    const alerts = await run({ routine: true, lesson: true, memory: true });
    expect(alerts.map(alert => alert.text)).toEqual([`升级时有1 条旧套路、2 条旧教训、1 位员工的原长期记忆${TAIL}`]);
    // 不出现员工编号。
    expect(alerts[0]!.text).not.toMatch(/b_\d|sk_\d|skills|skillVersions/);
  });

  it('只有长期记忆、只有教训：各自的写法', async () => {
    expect((await run({ memory: true })).map(alert => alert.text)).toEqual([`升级时有1 位员工的原长期记忆${TAIL}`]);
    expect((await run({ lesson: true })).map(alert => alert.text)).toEqual([`升级时有2 条旧教训${TAIL}`]);
  });

  it('反例：没有跳过不出这一句；第二次启动（已完成）也不再出', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRoutine(ctx, routineId(1), { botId: chiefBot.id, name: '核查来源' });
    await runP75Migration(ctx);
    await runP75Migration(ctx);
    expect(ctx.store.table('alerts').count(alert => alert.code === 'p75:migration-skipped')).toBe(0);
    // 有跳过的世界：再启动一次仍然只有一条。
    const world = await legacyWorld();
    putRoutine(world.ctx, routineId(1), { botId: world.chiefBot.id, name: '核查来源' });
    putBlockingSkill(world.ctx, world.chiefBot.id, '核查来源', 1);
    await runP75Migration(world.ctx);
    await runP75Migration(world.ctx);
    expect(world.ctx.store.table('alerts').count(alert => alert.code === 'p75:migration-skipped')).toBe(1);
  });
});
