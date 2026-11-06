/** 宿主目录必须同时驱动模型展示与写入校验；无目录时保持旧行为，错误目录不能放宽校验。 */
import { describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/index.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { okData } from './c04-api-fixtures.js';

const creation = { name: '目录测试', role: 'researcher', persona: '核实信息', aspirations: ['核实公开信息'] };
const option = { provider: 'catalog-provider', model: 'catalog-model', label: '目录显示名' };
const choice = { provider: option.provider, model: option.model };

describe('M07 宿主模型目录', () => {
  it('视图保留宿主标签、去重并可原样回传创建及编辑，实际会话使用所选模型', async () => {
    const ctx = createTestContext();
    const listModels = vi.fn(async () => [option, option]);
    const hub = createHub({ ...ctx, listModels });
    await hub.start();
    const view = await hub.api.settings();
    expect(view.modelOptions).toEqual([{ value: null, label: '跟随宿主默认模型' }, { value: choice, label: option.label }]);
    const bot = okData(await hub.api.createBot({ ...creation, model: view.modelOptions[1]!.value }));
    expect(bot.model).toEqual(choice);
    expect(ctx.host.calls.find(call => call.method === 'createSession')?.args[0]).toMatchObject({ model: choice });
    expect(okData(await hub.api.updateBot(bot.id, { model: null })).model).toBeNull();
    expect(okData(await hub.api.updateBot(bot.id, { model: choice })).model).toEqual(choice);
    expect(listModels).toHaveBeenCalledTimes(3);
  });

  it.each([{ provider: 'unknown', model: choice.model }, { provider: choice.provider, model: 'unknown' }])(
    '目录中不存在的 provider/model 拒绝创建和编辑且无副作用：%j', async invalid => {
      const ctx = createTestContext();
      const hub = createHub({ ...ctx, listModels: async () => [option] });
      const result = await hub.api.createBot({ ...creation, model: invalid });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('不在宿主模型目录') });
      expect(ctx.store.table('bots').count()).toBe(0);
      expect(await ctx.fs.list('/hub/bots')).toEqual([]);
      const bot = okData(await hub.api.createBot({ ...creation, model: choice }));
      expect(await hub.api.updateBot(bot.id, { name: '不应保存', model: invalid }))
        .toMatchObject({ ok: false, error: expect.stringContaining('不在宿主模型目录') });
      expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ name: creation.name, model: choice });
    });

  it('每次读取最新目录；被撤下的模型不在下拉中，编辑旧机器人必须换到可用模型', async () => {
    let models = [option];
    const ctx = createTestContext();
    const hub = createHub({ ...ctx, listModels: async () => models });
    const bot = okData(await hub.api.createBot({ ...creation, model: choice }));
    models = [];
    expect((await hub.api.settings()).modelOptions).toEqual([{ value: null, label: '跟随宿主默认模型' }]);
    expect(await hub.api.updateBot(bot.id, { name: '新名称' })).toMatchObject({ ok: false, error: expect.stringContaining('不在宿主模型目录') });
    expect(await hub.api.updateBot(bot.id, { name: '新名称', model: null })).toMatchObject({ ok: true });
  });

  it('设置默认模型也验证目录；创建继承有效默认，显式 null 跟随宿主默认', async () => {
    const ctx = createTestContext();
    const hub = createHub({ ...ctx, listModels: async () => [option] });
    expect(await hub.api.updateSettings({ defaultModel: { provider: 'bad', model: 'bad' } })).toMatchObject({ ok: false });
    expect(await hub.api.updateSettings({ defaultModel: choice })).toMatchObject({ ok: true });
    expect(okData(await hub.api.createBot(creation)).model).toEqual(choice);
    expect(okData(await hub.api.createBot({ ...creation, name: '默认跟随', model: null })).model).toBeNull();
  });

  it('没有提供目录时仍支持自定义模型，选项保留默认值及名册已选模型', async () => {
    const ctx = createTestContext();
    const hub = createHub(ctx);
    expect((await hub.api.settings()).modelOptions).toHaveLength(1);
    const bot = okData(await hub.api.createBot({ ...creation, model: choice }));
    expect(bot.model).toEqual(choice);
    expect((await hub.api.settings()).modelOptions).toContainEqual({ value: choice, label: `${choice.provider} / ${choice.model}` });
    expect(await hub.api.updateBot(bot.id, { model: { provider: 'new', model: 'new' } })).toMatchObject({ ok: true });
  });

  it.each(['reject', 'malformed'] as const)('目录 %s 返回中文失败，不将读取失败当成允许任何模型', async kind => {
    const ctx = createTestContext();
    const listModels = async () => {
      if (kind === 'reject') throw new Error('目录服务不可用');
      return [{ ...option, model: '' }];
    };
    const hub = createHub({ ...ctx, listModels });
    await expect(hub.api.settings()).rejects.toThrow('模型目录读取失败');
    expect(await hub.api.createBot({ ...creation, model: choice })).toMatchObject({ ok: false, error: expect.stringContaining('模型目录读取失败') });
    expect(ctx.store.table('bots').count()).toBe(0);
    expect(await hub.api.createBot({ ...creation, model: null })).toMatchObject({ ok: true });
  });
});
