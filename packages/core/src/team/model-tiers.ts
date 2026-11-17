/**
 * 模型档位（P73b）：组队卡上只给主人两个选择，「标准档」和「轻档」，
 * 这里负责把档位对应到模型目录里的具体模型。
 *
 * 为什么不新增设置项：不挤占设置精简；规则是确定的，可测试。
 * - 标准档 = 设置里的默认模型（null 表示跟随 DSH 默认模型）。
 * - 轻档 = 目录里第一个「模型 id 或显示名」按词切分后含 flash、mini、lite、haiku、air 整词的条目，
 *   且与标准档不是同一个模型；读不到目录或找不到时，轻档不可用。
 *
 * 本文件只做计算：目录由调用方读好传入（读取失败时调用方捕获后传 null），不读任何存储。
 */
import type { HubModelOption } from '../api/models.js';
import type { ModelChoice } from '../model/primitives.js';

/** 轻档的识别词：模型名先按非字母数字字符切成若干段，整段与关键词相等才算命中，不区分大小写。 */
export const LIGHT_MODEL_KEYWORDS: readonly string[] = ['flash', 'mini', 'lite', 'haiku', 'air'];

/**
 * 是否轻档模型名（P73r1 R4）。按完整的词匹配，不按子串：
 * gemini-2.5-pro 里的 mini、MiniMax-M2 里的 mini、airoboros 里的 air 都不算；gpt-4o-mini、glm-4-air 算。
 */
export function isLightModelName(name: string): boolean {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(word => word !== '');
  return words.some(word => LIGHT_MODEL_KEYWORDS.includes(word));
}

export type ModelTier = 'standard' | 'light';

export interface ModelTiers {
  /** 标准档对应的模型；null 表示跟随 DSH 默认模型。 */
  standard: ModelChoice;
  /** 轻档对应的模型；不可用时为 null。 */
  light: ModelChoice;
  /** 轻档在卡上显示的名字（目录里的显示名）；不可用时为 null。 */
  lightLabel: string | null;
  lightAvailable: boolean;
}

/** 由模型目录和默认模型算出两个档位。 */
export function modelTiers(catalog: readonly HubModelOption[] | null, defaultModel: ModelChoice): ModelTiers {
  const none: ModelTiers = { standard: defaultModel, light: null, lightLabel: null, lightAvailable: false };
  if (catalog === null || catalog.length === 0) return none;
  const found = catalog.find(option => {
    if (!isLightModelName(`${option.model} ${option.label}`)) return false;
    // 与标准档是同一个服务商加模型的，不算轻档。
    return !(defaultModel !== null && defaultModel.provider === option.provider && defaultModel.model === option.model);
  });
  if (found === undefined) return none;
  return {
    standard: defaultModel,
    light: { provider: found.provider, model: found.model } as NonNullable<ModelChoice>,
    lightLabel: found.label,
    lightAvailable: true,
  };
}

/** 档位换成具体模型：轻档不可用时一律回到标准档。 */
export function tierToModel(tier: ModelTier, tiers: ModelTiers): ModelChoice {
  return tier === 'light' && tiers.lightAvailable ? tiers.light : tiers.standard;
}
