/**
 * P72b 工具 hub_agreement_submit 的测试：身份、等级、复盘回合、JSON Schema、缺项报错。
 */
import { describe, expect, it } from 'vitest';
import { buildTools } from '../src/tools/index.js';
import { callTool, chiefDrafts, newAgreementArgs, ownerSays, runningWake, setup } from './p72b-fixtures.js';

describe('hub_agreement_submit', () => {
  it('总管在主人消息叫醒的回合里调用成功，返回文字含 agreementId', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs());
    expect(result.ok).toBe(true);
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    expect(result.text).toContain(agreement.id);
    expect(result.text).toContain('已记下约定「每日报价页」第 1 版');
    // 工具只写表，不落楼：卡片等交账后才发。
    expect(fix.ctx.store.log('thread').all().filter(row => row.kind === 'agreement')).toEqual([]);
  });

  it('反例：执行风格员工调用被拒，错误为「只有总管能提交约定」，表里没有约定', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.wang.id, '你来做个页面');
    expect(runningWake(fix.ctx, fix.wang.id)).toBeDefined();
    const result = await callTool(fix, fix.wang, 'hub_agreement_submit', newAgreementArgs());
    expect(result).toMatchObject({ ok: false, error: '只有总管能提交约定' });
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
  });

  it('反例：L0 的总管调用被拒', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我做个页面');
    fix.ctx.store.table('bots').patch(fix.chief.id, { autonomy: 'L0' });
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs());
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('L0') });
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
  });

  it('反例：复盘回合调用被拒，错误说明复盘回合只读', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我做个页面');
    fix.ctx.store.table('wakes').patch(runningWake(fix.ctx, fix.chief.id)!.id, { variant: 'reflection' });
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs());
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('只读') });
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
  });

  it('JSON Schema 根节点是对象，且根上没有 oneOf、anyOf', async () => {
    const fix = await setup();
    const tool = buildTools(fix.ctx).find(item => item.name === 'hub_agreement_submit')!;
    expect(tool.jsonSchema).toMatchObject({ type: 'object', properties: expect.any(Object) });
    expect(tool.jsonSchema).not.toHaveProperty('oneOf');
    expect(tool.jsonSchema).not.toHaveProperty('anyOf');
    expect(tool.description.startsWith('（仅总管）')).toBe(true);
  });

  it('反例：缺六样之一时报错点出缺的项，表里没有新约定', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我做个页面');
    const args = newAgreementArgs();
    delete args.scopeIn;
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', args);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('scopeIn');
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
  });

  it('修订时返回「已记下第 2 版，等主人确认」', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    // 同一回合里主人没有第二句话，要先结束回合再说下一句。
    const { speak } = await import('./p72b-fixtures.js');
    await speak(fix, fix.chief, '好的');
    await ownerSays(fix, fix.chief.id, '多加一条验收');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      agreementId: id, changeNote: '加一条验收', doneWhen: ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '页面在手机上能看'],
    });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('已记下第 2 版，等主人确认') });
  });
});
