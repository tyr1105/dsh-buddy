/**
 * 资料列表工具（v2 计划 3.3 / F17）：队友通过它查看「我现在能查哪些注册资料」。
 *
 * 设计纪律：
 * - 能不能读的口径全部复用 org/access.ts 的纯函数（归档、在岗、normal/restricted、队友直授），
 *   工具层不自己另写一套授权判断；
 * - 只回 id、名称、类型中文、位置、敏感性，绝不回资料正文，正文一律走 hub_resource_read，
 *   这样受限资料「知道有这份资料」和「能看内容」是两条分开的审计链；
 * - 只读工具，所有等级（含 L0 与试岗）都可调用，与 hub_state_get 同级。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { defineTool } from './common.js';
import { readableResources, type ResourceAccessData } from '../org/access.js';
import { RESOURCE_KIND_LABELS, RESOURCE_SENSITIVITY_LABELS } from '../model/resource.js';

/** 列表无参数；保留 strictObject 是为了让未知字段直接得到中文校验错误。 */
export const HubResourceListInputSchema = z.strictObject({});

/** 组装 access 纯函数需要的三张表快照；与唤醒包 addResources 的取数方式保持一致。 */
function accessData(ctx: HubContext): ResourceAccessData {
  return {
    bots: ctx.store.table('bots').list(),
    resources: ctx.store.table('resources').list(),
    grants: ctx.store.table('grants').list(),
  };
}

export const hubResourceList = defineTool('hub_resource_list',
  '列出你当前可以查阅的中心资料（名称、类型、位置、是否受限）；只给清单不给正文，读正文用 hub_resource_read。',
  HubResourceListInputSchema, 'all', (ctx, tc) => {
    const readable = readableResources(accessData(ctx), tc.botId, ctx.clock.now());
    if (readable.length === 0) return { ok: true, text: '你当前没有可查阅的注册资料。' };
    const lines = readable.map(r =>
      `- [${r.id}] ${r.name}（${RESOURCE_KIND_LABELS[r.kind]}，${RESOURCE_SENSITIVITY_LABELS[r.sensitivity]}）：${r.locator}`);
    return { ok: true, text: `你可以查阅 ${readable.length} 份资料：\n${lines.join('\n')}` };
  });
