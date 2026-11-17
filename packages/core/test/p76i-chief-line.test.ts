/**
 * P76i 第 3.2 节：左栏总管一句（chiefJobLine、chiefJobLineFor）。
 *
 * 规则：没有在办的事为 null（沿用现有角色行）；否则「{n} 件在办」，其中在等你的件数 m 大于 0 时「{n} 件在办，{m} 件等你」；只有一件时也这样写。
 * 纯函数用「在办的事」的行当输入；读取函数（chiefJobLineFor）读真实记录，口径与右栏同一份（含对齐中的约定）。
 */
import { describe, expect, it } from 'vitest';
import { chiefJobLine } from '../src/api/job-views.js';
import { chiefJobLineFor } from '../src/api/job-topic-views.js';
import { botCard } from '../src/api/summary-views.js';
import { sceneA } from './p76i-fixtures.js';

describe('1 chiefJobLine（纯函数）四种逐字', () => {
  const row = (waitingOwner: boolean) => ({ waitingOwner });
  it('0 件：null', () => {
    expect(chiefJobLine([])).toBeNull();
  });
  it('1 件、不在等你：「1 件在办」', () => {
    expect(chiefJobLine([row(false)])).toBe('1 件在办');
  });
  it('1 件、在等你：「1 件在办，1 件等你」', () => {
    expect(chiefJobLine([row(true)])).toBe('1 件在办，1 件等你');
  });
  it('3 件、其中 2 件在等你：「3 件在办，2 件等你」；3 件都不在等你：「3 件在办」', () => {
    expect(chiefJobLine([row(true), row(false), row(true)])).toBe('3 件在办，2 件等你');
    expect(chiefJobLine([row(false), row(false), row(false)])).toBe('3 件在办');
  });
});

describe('2 chiefJobLineFor（读真实记录）', () => {
  it('场景 A：对齐中的活动推文、受阻在等你的嘉宾介绍页、核对中的活动报名页：「3 件在办，2 件等你」', async () => {
    const { ctx, fix } = await sceneA();
    expect(chiefJobLineFor(ctx, fix.chief.id)).toBe('3 件在办，2 件等你');
    // 员工卡片（总览里的总管那一行）读的是同一句。
    expect(botCard(ctx, fix.chief).chiefJobLine).toBe('3 件在办，2 件等你');
  });

  it('反例：只剩核对中的活动报名页（不在等你）：「1 件在办」；其他员工的卡片不带这个字段', async () => {
    const { ctx, fix, guest, tweet } = await sceneA();
    ctx.store.table('jobs').remove(guest.id);
    ctx.store.table('agreements').remove(tweet.id);
    expect(chiefJobLineFor(ctx, fix.chief.id)).toBe('1 件在办');
    expect('chiefJobLine' in botCard(ctx, fix.engineer)).toBe(false);
  });

  it('已完成的事不算在办；全部收尾后为 null', async () => {
    const { ctx, fix, report, guest, tweet } = await sceneA();
    ctx.store.table('jobs').patch(report.id, { state: 'done', launchStep: false, launch: { state: 'none', approvalId: null, link: null } });
    ctx.store.table('jobs').patch(guest.id, { state: 'stopped', blocked: null });
    ctx.store.table('agreements').remove(tweet.id);
    expect(chiefJobLineFor(ctx, fix.chief.id)).toBeNull();
  });

  it('旧写法的输入（只给一件事的记录，没有「在等你」的信息）：已收尾的不算，其余按不在等你写', async () => {
    const { report } = await sceneA();
    expect(chiefJobLine([{ job: report, title: '活动报名页' }])).toBe('1 件在办');
    expect(chiefJobLine([{ job: { ...report, state: 'done' }, title: '活动报名页' }])).toBeNull();
  });
});
