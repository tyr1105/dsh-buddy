/**
 * 读取 DSH 里的技能目录（P55），给「岗位技能」的选择界面用。
 *
 * core 不能直接碰 DSH，目录由宿主注入的 listSkills 提供。
 * 读失败时返回空清单而不是报错：技能是可选项，不能因为目录暂时读不到，
 * 就让整个设置页或新建队友打不开。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { DSH_SKILL_NAME_PATTERN } from './schemas.js';

/** 界面列表里描述的最大长度：DSH 的描述可能写得很长，列表里放不下也没必要。 */
const DESCRIPTION_MAX = 160;

/** 宿主返回的一行技能；名字不合规的行直接丢弃，不让脏数据进选择列表。 */
const CatalogRowSchema = z.object({ name: z.string(), description: z.string() });
const CatalogSchema = z.array(CatalogRowSchema);

/** 界面用的一项 DSH 技能。 */
export interface DshSkillOption {
  name: string;
  description: string;
}

/** 超长描述截断并加省略号，按字符算，不会把汉字切成两半。 */
function shorten(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length <= DESCRIPTION_MAX ? chars.join('') : `${chars.slice(0, DESCRIPTION_MAX).join('')}…`;
}

/** 取 DSH 技能清单：去重、按名字排序。 */
export async function readDshSkillOptions(ctx: HubContext): Promise<DshSkillOption[]> {
  if (!ctx.listSkills) return [];
  try {
    const rows = parseInput(CatalogSchema, await ctx.listSkills(), '技能目录');
    const unique = new Map(rows.filter(row => DSH_SKILL_NAME_PATTERN.test(row.name))
      .map(row => [row.name, { name: row.name, description: shorten(row.description) }]));
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    ctx.logger.warn('技能目录读取失败', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
