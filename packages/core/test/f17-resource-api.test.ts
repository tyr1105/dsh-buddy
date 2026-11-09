/**
 * F17 资料可见性 - UI API 测试（api/resource-views.ts + 命令注册）。
 * resourceView 是只读视图；saveResource / archiveResource / setGrant 走统一 commandRunner，
 * 有中文错误、ui_ 审计；旧存档（空 store）视图返回空结构不报错（场景 F）。
 * 主人取消编制后，授权对象只剩队友本人，资料不再有归属部门。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createUiApi } from '../src/api/index.js';
import { initRoot } from '../src/memory/files.js';
import { okData } from './c04-api-fixtures.js';
import type { ResourceView } from '../src/index.js';

async function apiSetup() {
  const ctx = createTestContext();
  await initRoot(ctx);
  const after = vi.fn(async () => { await ctx.store.flush(); });
  const api = createUiApi(ctx, after);
  return { ctx, api, after };
}

describe('F17 resourceView 只读视图', () => {
  it('旧存档无资料表数据：空视图不报错，计数全 0', async () => {
    const { api } = await apiSetup();
    const view: ResourceView = api.resourceView();
    expect(view.counts).toEqual({ total: 0, active: 0, archived: 0, grants: 0 });
    expect(view.resources).toEqual([]);
    expect(view.grants).toEqual([]);
  });

  it('资料行带中文类型/敏感性标签；未归档在前已归档在后；授权行展开队友名', async () => {
    const { api } = await apiSetup();
    const bot = okData(await api.createBot({ name: '分析师', role: 'researcher', persona: '核实', aspirations: ['持续核实'] }));
    const r1 = okData(await api.saveResource({ name: '公开名单', kind: 'file', locator: '/hub/shared/list.txt' }));
    const r2 = okData(await api.saveResource({
      name: '机密预算', kind: 'file', locator: '/hub/shared/budget.txt', sensitivity: 'restricted',
    }));
    okData(await api.setGrant({ resourceId: r2.id, subjectKind: 'bot', subjectId: bot.id, level: 'write' }));
    okData(await api.archiveResource(r1.id));

    const view = api.resourceView();
    expect(view.counts).toEqual({ total: 2, active: 1, archived: 1, grants: 1 });
    // 未归档在前。
    expect(view.resources.map(r => r.resource.id)).toEqual([r2.id, r1.id]);
    const activeRow = view.resources[0]!;
    expect(activeRow.kindLabel).toBe('文件');
    expect(activeRow.sensitivityLabel).toBe('指定队友可读');
    expect(activeRow.archived).toBe(false);
    expect(activeRow.grants[0]).toMatchObject({
      resourceName: '机密预算', subjectKindLabel: '队友', subjectName: '分析师', levelLabel: '读写',
    });
  });

  it('只读视图不产生审计', async () => {
    const { api, ctx } = await apiSetup();
    okData(await api.saveResource({ name: 'r', kind: 'file', locator: '/hub/shared/a.txt' }));
    const before = ctx.store.log('audit').all().length;
    api.resourceView();
    api.resourceView();
    expect(ctx.store.log('audit').all().length).toBe(before);
  });
});

describe('F17 资料命令经统一出口', () => {
  it('非法入参返回中文 error 且不落记录', async () => {
    const { api, ctx } = await apiSetup();
    const badPath = await api.saveResource({ name: '坏', kind: 'file', locator: '../escape.txt' });
    expect(badPath.ok).toBe(false);
    if (!badPath.ok) expect(badPath.error).toContain('共享目录');
    const badUrl = await api.saveResource({ name: '坏', kind: 'url', locator: 'ftp://x.test/a' });
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.error).toContain('http');
    const badId = await api.archiveResource('res_bad');
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.error).toContain('res_');
    expect(ctx.store.table('resources').count()).toBe(0);
  });

  it('三条命令都有 ui_ 审计，且返回资料/授权数据', async () => {
    const { api, ctx } = await apiSetup();
    const bot = okData(await api.createBot({ name: '分析员', role: 'researcher', persona: '核实', aspirations: ['持续核实'] }));
    const saved = okData(await api.saveResource({ name: 'r', kind: 'file', locator: '/hub/shared/a.txt', sensitivity: 'restricted' }));
    const granted = okData(await api.setGrant({ resourceId: saved.id, subjectKind: 'bot', subjectId: bot.id, level: 'read' }));
    const archived = okData(await api.archiveResource(saved.id));
    expect(granted.subjectKind).toBe('bot');
    expect(archived.archivedAt).not.toBeNull();
    const actions = ctx.store.log('audit').all().map(a => a.action).filter(a => a.startsWith('ui_'));
    for (const name of ['ui_saveResource', 'ui_setGrant', 'ui_archiveResource']) {
      expect(actions).toContain(name);
    }
  });
});
