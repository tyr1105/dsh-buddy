/**
 * P73a 员工状态合并验收（core）：投影函数、新员工直接在岗、执行类固定听吩咐、停用/恢复/归档动作、
 * 归档规则、提前转正报错、给主人看的文字。
 * 每条规则至少一个正例一个反例；时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBot, updateBot } from '../src/api/bots.js';
import { staffStatus } from '../src/model/bot.js';
import { STAFF_STATUS_LABELS, type Lifecycle } from '../src/model/index.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { botCard } from '../src/api/summary-views.js';
import { quarantine } from '../src/health/quarantine.js';
import { apiFixture, okData } from './c04-api-fixtures.js';
import type { HubContext } from '../src/engine/context.js';

const hour = 3_600_000;

/** 给某位员工排一个主人消息候选，用来观察闸门是否放行。 */
function ownerCandidate(ctx: HubContext, botId: string) {
  return enqueue(ctx, buildCandidate(ctx, { botId, kind: 'owner_message', score: ctx.settings.c02.ownerSalience,
    summary: '主人发来一条消息', evidence: [], ownerInitiated: true }))!;
}

describe('P73a staffStatus 投影', () => {
  const base = { archivedAt: null, quarantineReason: null };
  it.each([
    ['draft', 'on_duty', null], ['probation', 'on_duty', null], ['active', 'on_duty', null],
    ['paused', 'suspended', '你停用的'], ['retired', 'archived', null],
  ] as const)('%s 映射为 %s', (lifecycle, status, reason) => {
    const view = staffStatus({ ...base, lifecycle: lifecycle as Lifecycle });
    expect(view).toEqual({ status, label: STAFF_STATUS_LABELS[status], reason });
  });
  it('quarantined 映射为停用，原因含 quarantineReason；没有原因时写安全保护', () => {
    expect(staffStatus({ ...base, lifecycle: 'quarantined', quarantineReason: '反复越界' }))
      .toEqual({ status: 'suspended', label: '停用', reason: '连续出错，系统已停用：反复越界' });
    expect(staffStatus({ ...base, lifecycle: 'quarantined' }).reason).toBe('连续出错，系统已停用：安全保护');
  });
  it('retired 不论有没有归档时间都是归档；archivedAt 有值而 lifecycle 为 active 时按归档（防御）', () => {
    expect(staffStatus({ ...base, lifecycle: 'retired', archivedAt: 5 }).status).toBe('archived');
    expect(staffStatus({ ...base, lifecycle: 'active', archivedAt: 5 })).toMatchObject({ status: 'archived', label: '归档', reason: null });
  });
});

describe('P73a createBot：新员工直接在岗，执行类固定听吩咐', () => {
  it('新员工 lifecycle 为 active，没有试岗字段，文案和审计写入职', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { name: '小研', role: 'researcher' });
    expect(bot).toMatchObject({ lifecycle: 'active', probationEndsAt: null, activityText: '继续关注变化' });
    expect(bot.probationStartedAt).toBeUndefined();
    const audit = ctx.store.log('audit').all().find(row => row.action === 'lifecycle')!;
    expect(JSON.parse(audit.detail)).toMatchObject({ to: 'active', text: '小研入职' });
  });
  it('执行类（调研、执行、建议）传入 onDemand false、L2、normal 后仍是听吩咐三项', async () => {
    const ctx = createTestContext();
    for (const [index, role] of (['researcher', 'executor', 'advisor'] as const).entries()) {
      const bot = await createBot(ctx, { name: `执行类${index}`, role, onDemand: false, autonomy: role === 'advisor' ? 'L1' : 'L2', pace: 'normal' });
      expect(bot).toMatchObject({ onDemand: true, autonomy: 'L1', pace: 'quiet' });
    }
  });
  it('反例：值守类照传入值，总管照传入值', async () => {
    const ctx = createTestContext();
    const sentinel = await createBot(ctx, { name: '守望', role: 'sentinel', onDemand: false, autonomy: 'L2', pace: 'active' });
    expect(sentinel).toMatchObject({ onDemand: false, autonomy: 'L2', pace: 'active' });
    const chief = await createBot(ctx, { name: '总管', role: 'chief', onDemand: false, autonomy: 'L1', pace: 'normal' });
    expect(chief).toMatchObject({ onDemand: false, autonomy: 'L1', pace: 'normal' });
  });
  it('updateBot：执行类传入的听吩咐三项被忽略且不报错；改为值守类时才采用', async () => {
    const ctx = createTestContext();
    const bot = await createBot(ctx, { name: '小研', role: 'researcher' });
    expect(await updateBot(ctx, bot.id, { onDemand: false, autonomy: 'L2', pace: 'active' })).toMatchObject({ onDemand: true, autonomy: 'L1', pace: 'quiet' });
    expect(await updateBot(ctx, bot.id, { role: 'sentinel', onDemand: false, autonomy: 'L2', pace: 'active' }))
      .toMatchObject({ role: 'sentinel', onDemand: false, autonomy: 'L2', pace: 'active' });
  });
  it('新员工没有试岗限制：主人消息候选闸门放行；每天上限不按自主等级分档（P76c）', async () => {
    const ctx = createTestContext();
    ctx.runtime.startedAt -= hour;
    const executor = await createBot(ctx, { name: '小研', role: 'researcher' });
    const sentinel = await createBot(ctx, { name: '守望', role: 'sentinel', autonomy: 'L2', onDemand: false });
    for (const bot of [executor, sentinel]) {
      const entry = ownerCandidate(ctx, bot.id);
      const now = ctx.clock.now();
      expect(evaluateGates(entry, buildSnapshot(ctx, bot.id, now), now, ctx.settings)).toEqual({ pass: true });
      // P76c：dailyThinkCapFor（每日思考上限按自主等级）已删除，每天上限只剩 botDailyTurnBudget 一个数。
      // 原断言证明「在岗员工按自己的 autonomy 取每日思考上限、不被试岗压成 L1」；现在改为证明：两位自主等级不同的在岗员工，
      // 员工卡上的每天上限都是同一个完整值（不按等级分档，也不减半）。
      expect(botCard(ctx, ctx.store.table('bots').get(bot.id)!).todayBudget).toBe(ctx.settings.botDailyTurnBudget);
    }
  });
});

describe('P73a 停用、恢复在岗', () => {
  it('suspend：状态为停用，原因「你停用的」，队列清空，文案「已停用（你停用的）」', async () => {
    const { ctx, api, bot } = await apiFixture();
    ownerCandidate(ctx, bot.id);
    expect(ctx.store.table('queue').count()).toBe(1);
    const row = okData(await api.lifecycleAction({ botId: bot.id, action: 'suspend' }));
    expect(staffStatus(row)).toEqual({ status: 'suspended', label: '停用', reason: '你停用的' });
    expect(row.activityText).toBe('已停用（你停用的）');
    expect(ctx.store.table('queue').count()).toBe(0);
  });
  it('反例：已停用的员工不能再停用；在岗员工不能 reinstate', async () => {
    const { api, bot } = await apiFixture();
    expect((await api.lifecycleAction({ botId: bot.id, action: 'reinstate' })).ok).toBe(false);
    okData(await api.lifecycleAction({ botId: bot.id, action: 'suspend' }));
    expect((await api.lifecycleAction({ botId: bot.id, action: 'suspend' })).ok).toBe(false);
  });
  it('reinstate：停用回到在岗', async () => {
    const { ctx, api, bot } = await apiFixture();
    okData(await api.lifecycleAction({ botId: bot.id, action: 'suspend' }));
    const row = okData(await api.lifecycleAction({ botId: bot.id, action: 'reinstate' }));
    expect(staffStatus(row).status).toBe('on_duty');
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ lifecycle: 'active', pausedFrom: null });
  });
  it('reinstate 隔离员工：故障计数和越界计数清零', async () => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { consecutiveErrors: 3, violations: 2 });
    quarantine(ctx, bot.id, '连续故障');
    expect(staffStatus(ctx.store.table('bots').get(bot.id)!).reason).toContain('连续故障');
    const row = okData(await api.lifecycleAction({ botId: bot.id, action: 'reinstate' }));
    expect(row).toMatchObject({ lifecycle: 'active', consecutiveErrors: 0, violations: 0, quarantineReason: null });
  });
  it('promote 报「已没有试岗这一步」', async () => {
    const { api, bot } = await apiFixture();
    expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toEqual({ ok: false, error: '提前转正：已没有试岗这一步' });
  });
});

describe('P73a 归档', () => {
  const member = { name: '小搭', role: 'researcher', persona: '协助', aspirations: ['协助'] };

  it('在岗员工一步归档：lifecycle 为 retired、有归档时间、队列清空，旁白「已归档」', async () => {
    const { ctx, api, bot } = await apiFixture();
    ownerCandidate(ctx, bot.id);
    const row = okData(await api.lifecycleAction({ botId: bot.id, action: 'archive' }));
    expect(row).toMatchObject({ lifecycle: 'retired', archivedAt: ctx.clock.now(), activityText: '已归档' });
    expect(staffStatus(row).status).toBe('archived');
    expect(ctx.store.table('queue').count()).toBe(0);
    expect(api.thread(bot.id).messages.at(-1)?.text).toBe('小研：已归档');
  });
  it('停用的员工也能直接归档', async () => {
    const { api, bot } = await apiFixture();
    okData(await api.lifecycleAction({ botId: bot.id, action: 'suspend' }));
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'archive' })).archivedAt).not.toBeNull();
  });
  it('是项目负责人：拒绝并说明请先换负责人', async () => {
    const { ctx, api, bot } = await apiFixture();
    okData(await api.saveProject({ name: '周报项目', memberBotIds: [bot.id], ownerBotId: bot.id }));
    const result = await api.lifecycleAction({ botId: bot.id, action: 'archive' });
    expect(result).toEqual({ ok: false, error: '归档：它是项目「周报项目」的负责人。请先在项目设置里换一位负责人' });
    expect(ctx.store.table('bots').get(bot.id)?.lifecycle).toBe('active');
  });
  it('有进行中事务：拒绝并列出项目和件数；待验收同样算', async () => {
    const { ctx, api, bot } = await apiFixture();
    const other = okData(await api.createBot(member));
    const project = okData(await api.saveProject({ name: '周报项目', memberBotIds: [bot.id, other.id], ownerBotId: other.id }));
    const task = okData(await api.saveTask({ projectId: project.id, title: '写周报', assigneeBotId: bot.id }));
    ctx.store.table('projectTasks').patch(task.id, { status: 'doing' });
    expect(await api.lifecycleAction({ botId: bot.id, action: 'archive' }))
      .toEqual({ ok: false, error: '归档：它有 1 件进行中或待验收的事务，先交接：项目「周报项目」（1 件）' });
    ctx.store.table('projectTasks').patch(task.id, { status: 'done_pending_check' });
    expect((await api.lifecycleAction({ botId: bot.id, action: 'archive' })).ok).toBe(false);
    ctx.store.table('projectTasks').patch(task.id, { status: 'accepted' });
    expect((await api.lifecycleAction({ botId: bot.id, action: 'archive' })).ok).toBe(true);
  });
  it('只是成员：检查列出会被移出的项目，归档成功并从成员名单移出，审计 detail 带 byArchive', async () => {
    const { ctx, api, bot } = await apiFixture();
    const owner = okData(await api.createBot(member));
    const project = okData(await api.saveProject({ name: '周报项目', memberBotIds: [owner.id, bot.id], ownerBotId: owner.id }));
    expect(okData(await api.archiveBotCheck(bot.id))).toMatchObject({ canArchive: true, reason: null,
      memberProjects: [{ projectId: project.id, projectName: '周报项目' }] });
    okData(await api.lifecycleAction({ botId: bot.id, action: 'archive' }));
    expect(ctx.store.table('projects').get(project.id)?.memberBotIds).toEqual([owner.id]);
    const updates = ctx.store.log('audit').all().filter(row => row.action === 'project_update');
    expect(updates.map(row => JSON.parse(row.detail)).some(detail => detail.byArchive === true)).toBe(true);
    expect(updates.at(-1)?.actor).toBe('owner');
  });
  it('总管拒绝；已归档再归档拒绝', async () => {
    const { api, bot } = await apiFixture();
    const chief = okData(await api.createBot({ name: '总管', role: 'chief', persona: '统筹', aspirations: ['统筹'] }));
    expect(await api.lifecycleAction({ botId: chief.id, action: 'archive' })).toEqual({ ok: false, error: '归档：总管不能归档' });
    okData(await api.lifecycleAction({ botId: bot.id, action: 'archive' }));
    expect(await api.lifecycleAction({ botId: bot.id, action: 'archive' })).toEqual({ ok: false, error: '归档：它已经归档了' });
  });
});

describe('P73a 给主人看的文字', () => {
  it('暂停后文案「已停用（你停用的）」，归档后「已归档」，隔离后「已停用：」开头', async () => {
    const { ctx, api, bot } = await apiFixture();
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'suspend' })).activityText).toBe('已停用（你停用的）');
    okData(await api.lifecycleAction({ botId: bot.id, action: 'reinstate' }));
    quarantine(ctx, bot.id, '连续故障');
    expect(ctx.store.table('bots').get(bot.id)?.activityText).toBe('已停用：连续故障');
    okData(await api.lifecycleAction({ botId: bot.id, action: 'reinstate' }));
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'archive' })).activityText).toBe('已归档');
  });
  it('core 源码里不再有给主人看的「已退役」「已暂停（你暂停的）」字符串（注释除外）', () => {
    const root = join(__dirname, '..', 'src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!path.endsWith('.ts')) continue;
        readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
          const code = line.replace(/\/\/.*$/, '');
          if (code.includes('已退役') || code.includes('已暂停（你暂停的）')) hits.push(`${path}:${index + 1}`);
        });
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
