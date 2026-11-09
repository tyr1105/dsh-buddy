/**
 * 资料视图（主人视角；主人取消编制后只显示队友授权）：
 * 把资料、授权、队友名字拼成界面可直接渲染的结构。
 *
 * 为什么视图层只做组装：能不能读的口径全部在 org/access.ts，这里只负责
 * 「资料列表 + 授权展开 + 归档标记」，不写审计、不改任何状态。
 * 旧存档没有 resources/grants 两表时，存储层自然给出空表，视图返回空列表，不报错（场景 F）。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { Grant, Resource } from '../model/resource.js';
import {
  GRANT_LEVEL_LABELS, GRANT_SUBJECT_KIND_LABELS, RESOURCE_KIND_LABELS, RESOURCE_SENSITIVITY_LABELS,
} from '../model/resource.js';
import type { ResourceView, ResourceGrantViewRow, ResourceViewRow } from './types.js';

/** 把授权对象 id 解析成中文名；队友已删除时给 null，界面不猜名字。 */
function subjectName(grant: Grant, bots: Map<string, Bot>): string | null {
  return bots.get(grant.subjectId)?.name ?? null;
}

/** 读取当前中心资料全貌：未归档在前、已归档在后，各按创建时间与 id 稳定排序。 */
export function resourceView(ctx: HubContext): ResourceView {
  const resources = ctx.store.table('resources').list();
  const grants = ctx.store.table('grants').list();
  const bots = new Map(ctx.store.table('bots').list().map(b => [b.id, b]));

  const grantRows: ResourceGrantViewRow[] = grants
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(grant => ({
      grant,
      resourceName: resources.find(r => r.id === grant.resourceId)?.name ?? null,
      subjectKind: grant.subjectKind,
      subjectKindLabel: GRANT_SUBJECT_KIND_LABELS[grant.subjectKind],
      subjectId: grant.subjectId,
      subjectName: subjectName(grant, bots),
      level: grant.level,
      levelLabel: GRANT_LEVEL_LABELS[grant.level],
    }));

  const rowsFor = (list: Resource[]): ResourceViewRow[] =>
    list.map(resource => ({
      resource,
      kindLabel: RESOURCE_KIND_LABELS[resource.kind],
      sensitivityLabel: RESOURCE_SENSITIVITY_LABELS[resource.sensitivity],
      archived: resource.archivedAt !== null,
      grants: grantRows.filter(row => row.grant.resourceId === resource.id),
    }));

  const byTimeThenId = (a: Resource, b: Resource) =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const active = resources.filter(r => r.archivedAt === null).sort(byTimeThenId);
  const archived = resources.filter(r => r.archivedAt !== null).sort(byTimeThenId);

  return {
    asOf: ctx.clock.now(),
    resources: [...rowsFor(active), ...rowsFor(archived)],
    grants: grantRows,
    counts: {
      total: resources.length,
      active: active.length,
      archived: archived.length,
      grants: grantRows.length,
    },
  };
}
