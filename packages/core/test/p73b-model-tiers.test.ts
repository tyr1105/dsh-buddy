/**
 * P73b 模型档位测试：从模型目录推出标准档和轻档；目录读不到或没有合适的模型时轻档不可用。
 */
import { describe, expect, test } from 'vitest';
import { modelTiers, tierToModel } from '../src/team/model-tiers.js';

const pro = { provider: 'deepseek', model: 'deepseek-pro', label: 'DeepSeek Pro' };
const flash = { provider: 'deepseek', model: 'deepseek-flash', label: 'DeepSeek Flash' };

describe('modelTiers', () => {
  test('目录含 flash 模型时，轻档是它；标准档就是默认模型', () => {
    const tiers = modelTiers([pro, flash], { provider: 'deepseek', model: 'deepseek-pro' });
    expect(tiers.standard).toEqual({ provider: 'deepseek', model: 'deepseek-pro' });
    expect(tiers.light).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(tiers.lightLabel).toBe('DeepSeek Flash');
    expect(tiers.lightAvailable).toBe(true);
  });

  test('只按显示名含关键词也算（不区分大小写）；默认模型为 null 表示跟随 DSH 默认', () => {
    const tiers = modelTiers([{ provider: 'p', model: 'x1', label: 'Claude HAIKU' }], null);
    expect(tiers.standard).toBeNull();
    expect(tiers.light).toEqual({ provider: 'p', model: 'x1' });
  });

  test('目录里只有一个与默认相同的 flash 模型时，轻档为 null', () => {
    const tiers = modelTiers([flash], { provider: 'deepseek', model: 'deepseek-flash' });
    expect(tiers.light).toBeNull();
    expect(tiers.lightLabel).toBeNull();
    expect(tiers.lightAvailable).toBe(false);
  });

  test('目录为 null、为空、没有轻量模型时，轻档为 null', () => {
    expect(modelTiers(null, null).lightAvailable).toBe(false);
    expect(modelTiers([], null).lightAvailable).toBe(false);
    expect(modelTiers([pro], null).light).toBeNull();
  });

  test('服务商不同、模型名相同不算同一个模型', () => {
    const tiers = modelTiers([flash], { provider: 'other', model: 'deepseek-flash' });
    expect(tiers.lightAvailable).toBe(true);
  });
});

describe('tierToModel', () => {
  test('轻档可用时返回轻档模型，标准档返回默认模型', () => {
    const tiers = modelTiers([pro, flash], { provider: 'deepseek', model: 'deepseek-pro' });
    expect(tierToModel('light', tiers)).toEqual({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(tierToModel('standard', tiers)).toEqual({ provider: 'deepseek', model: 'deepseek-pro' });
  });

  test('轻档不可用时回到标准档', () => {
    const tiers = modelTiers(null, { provider: 'deepseek', model: 'deepseek-pro' });
    expect(tierToModel('light', tiers)).toEqual({ provider: 'deepseek', model: 'deepseek-pro' });
    expect(tierToModel('light', modelTiers(null, null))).toBeNull();
  });
});
