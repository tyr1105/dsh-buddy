/** 领域模型契约测试：每种类型都有合法/非法样例，并核对枚举标签与特殊字段边界。 */
import { describe, expect, it } from 'vitest';
import * as m from '../src/model/index.js';
import * as enums from '../src/model/enums.js';
import { botFixture, goalFixture, modelFixtures, watchFixture } from './model-fixtures.js';
import { resolveSettings, thresholdFor } from '../src/config/defaults.js';

for (const [name, fixture] of Object.entries(modelFixtures)) {
  describe(`${name} 领域契约`, () => {
    it('接受规范合法样例', () => { expect(fixture.schema.safeParse(fixture.valid).success).toBe(true); });
    it('拒绝非法样例', () => { expect(fixture.schema.safeParse(fixture.invalid).success).toBe(false); });
  });
}

// 每个固定枚举都实际走 schema；新增枚举自动获得合法及非法覆盖。
for (const [name, value] of Object.entries(enums)) {
  if (!name.endsWith('Schema') || !('safeParse' in value)) continue;
  const schema = value as { safeParse(value: unknown): { success: boolean }; options: unknown[] };
  const valid = name === 'AgendaPrioritySchema' ? 1 : schema.options[0];
  it(`${name} 接受声明中的值`, () => { expect(schema.safeParse(valid).success).toBe(true); });
  it(`${name} 拒绝未知值`, () => { expect(schema.safeParse('invalid-enum-value').success).toBe(false); });
}

it('所有枚举常量都有覆盖全部值的中文标签', () => {
  const maps = Object.entries(enums).filter(([name]) => name.endsWith('_LABELS')).map(([, value]) => value as object);
  for (const values of Object.values(enums)) {
    if (!Array.isArray(values)) continue;
    expect(maps.some(map => values.every(key => key in map))).toBe(true);
  }
  expect(m.ROLE_LABELS).toEqual({ chief: '总管', researcher: '调研', executor: '执行', sentinel: '盯守', advisor: '建议' });
});
it('机器人工作数据权限缺省时关闭', () => {
  const { workDataAllowed: _, ...input } = botFixture;
  expect(m.BotSchema.parse(input).workDataAllowed).toBe(false);
});
it('数字拒绝 NaN 与无穷', () => {
  expect(m.GoalSchema.safeParse({ ...goalFixture, importance: NaN }).success).toBe(false);
  expect(m.GoalSchema.safeParse({ ...goalFixture, patienceMs: Infinity }).success).toBe(false);
});
it('记录 id 要求前缀与十位小写 base36', () => {
  expect(m.BotSchema.safeParse({ ...botFixture, id: 'wt_0000000001' }).success).toBe(false);
  expect(m.BotSchema.safeParse({ ...botFixture, id: 'b_ABCDEFGHIJ' }).success).toBe(false);
});
it('关注项快照按 UTF-8 字节校验', () => {
  expect(m.WatchSchema.safeParse({ ...watchFixture, lastValue: '中'.repeat(1365) }).success).toBe(true);
  expect(m.WatchSchema.safeParse({ ...watchFixture, lastValue: '中'.repeat(1366) }).success).toBe(false);
});
it('宿主回合事件覆盖六种变体及拒绝混搭字段', () => {
  const base = { sessionId: 'session', at: 1 };
  const events = [
    { type: 'started', ...base }, { type: 'step', ...base, steps: 2, tokens: null },
    { type: 'ended', ...base, finalText: '完成', tokens: 100 }, { type: 'error', ...base, errorText: '失败' },
    { type: 'awaiting_approval', ...base, tool: 'write', summary: '写入' }, { type: 'owner_direct', ...base, text: '继续' },
  ];
  for (const event of events) expect(m.TurnEventSchema.safeParse(event).success).toBe(true);
  expect(m.TurnEventSchema.safeParse({ type: 'started', ...base, steps: 2 }).success).toBe(false);
});
it('允许守卫结果无需拒绝说明', () => { expect(m.GuardDecisionSchema.parse({ allow: true })).toEqual({ allow: true }); });
it('默认模型可为空或显式选择', () => { expect(m.ModelChoiceSchema.parse(null)).toBeNull(); });
it('可覆盖设置产生的大于 1 门槛仍可被唤醒原因及评估日志保存', () => {
  const threshold = thresholdFor(1, 'quiet', resolveSettings({ thresholdBase: 0.8, thresholdFatigueWeight: 0.6 }));
  expect(threshold).toBeCloseTo(1.5);
  expect(m.WakeReasonSchema.safeParse({ kind: 'percept', score: 0.9, threshold, summary: '未达门槛', evidence: [] }).success).toBe(true);
  const appraisal = modelFixtures.AppraisalLog.valid as Record<string, unknown>;
  expect(m.AppraisalLogSchema.safeParse({ ...appraisal, threshold }).success).toBe(true);
});

it('动作类别标签严格对应 M01 与自主等级矩阵的业务含义', () => {
  expect(m.ACTION_CLASS_LABELS).toEqual({
    A: '内部可撤销',
    B: '会持续生效的自我变更',
    C: '别人看得见或碰真实数据',
    D: '不可逆或高风险',
  });
  expect(m.ACTION_CLASS_LABELS.A).not.toBe('观察');
  expect(m.ACTION_CLASS_LABELS.B).not.toBe('内部可逆');
});

it('所有 proposed 状态显示提议中，不再倒置为尚未提出', () => {
  const labels = Object.entries(enums)
    .filter(([name, value]) => name.endsWith('_LABELS') && 'proposed' in value)
    .map(([, value]) => value as { proposed: string });
  expect(labels).toHaveLength(3);
  for (const label of labels) {
    expect(label.proposed).toBe('提议中');
    expect(label.proposed).not.toBe('待提议');
  }
});

it('坏记录备份保留期允许正数覆盖并拒绝非正数', () => {
  expect(resolveSettings({ badBackupRetentionMs: 86_400_000 }).badBackupRetentionMs).toBe(86_400_000);
  expect(() => resolveSettings({ badBackupRetentionMs: 0 })).toThrow();
  expect(() => resolveSettings({ badBackupRetentionMs: -1 })).toThrow();
});
