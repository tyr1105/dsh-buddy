/** 模型目录完全由宿主提供；视图和写入共用校验，避免下拉展示与实际可选模型不一致。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { ModelChoice } from '../model/primitives.js';
import { parseInput } from '../engine/validation.js';

/** 宿主只传可路由模型的最小信息，不向 core 暴露凭据或服务商配置。 */
export interface HubModelOption { provider: string; model: string; label: string }
export type ListModels = () => Promise<HubModelOption[]>;
const CatalogSchema = z.array(z.strictObject({
  provider: z.string().trim().min(1, '服务商不能为空'),
  model: z.string().trim().min(1, '模型不能为空'),
  label: z.string().trim().min(1, '模型显示名称不能为空'),
}));

/** 每次读取当前目录；提供者失败时明确报错，不把故障解释为“允许任意模型”。 */
export async function readModelCatalog(ctx: HubContext): Promise<HubModelOption[] | null> {
  if (!ctx.listModels) return null;
  try {
    const rows = parseInput(CatalogSchema, await ctx.listModels(), '模型目录');
    return [...new Map(rows.map(row => [JSON.stringify([row.provider, row.model]), row])).values()];
  } catch (error) {
    throw new Error(`模型目录读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** null 始终表示跟随宿主默认；没有目录提供者时保留旧版自定义模型行为。 */
export async function validateModelChoice(ctx: HubContext, choice: ModelChoice): Promise<void> {
  if (choice === null) return;
  const rows = await readModelCatalog(ctx);
  if (rows !== null && !rows.some(row => row.provider === choice.provider && row.model === choice.model)) {
    throw new Error(`model：模型 ${choice.provider} / ${choice.model} 不在宿主模型目录里，请重新选择`);
  }
}
