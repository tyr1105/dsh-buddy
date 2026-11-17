/**
 * P73b 模板库测试：模板数据完整性、新增字段、默认性格与节奏、findTemplate、名字与已添加判断。
 * 数据已从插件移到 core，这里是 core 侧的底线断言。
 */
import { describe, expect, test } from 'vitest';
import {
  BOT_TEMPLATES, TURN_TOKEN_RANGE_TEXT, findTemplate, freeTemplateName, isTemplateAdded, templateById, templatesInGroup,
} from '../src/team/templates.js';
import { ALTERNATES_TABLE, INITIAL_TEAM_TABLE } from '../src/team/rules.js';
import { ROLE_LABELS } from '../src/model/enums.js';

describe('模板完整性', () => {
  test('每个模板都有非空的 fitFor、fitShort、dutyLabel、estimate，区间合法，长度受限', () => {
    expect(BOT_TEMPLATES.length).toBeGreaterThan(0);
    for (const item of BOT_TEMPLATES) {
      expect(item.fitFor.length, item.id).toBeGreaterThan(0);
      expect([...item.fitFor].length, item.id).toBeLessThanOrEqual(40);
      expect(item.fitShort.length, item.id).toBeGreaterThan(0);
      expect([...item.fitShort].length, item.id).toBeLessThanOrEqual(12);
      expect(item.dutyLabel.length, item.id).toBeGreaterThan(0);
      expect(item.estimate.text.length, item.id).toBeGreaterThan(0);
      expect(item.estimate.minTurns, item.id).toBeGreaterThan(0);
      expect(item.estimate.minTurns, item.id).toBeLessThanOrEqual(item.estimate.maxTurns);
    }
  });

  test('备选表和推荐名单表引用的模板都存在', () => {
    for (const [key, alternates] of Object.entries(ALTERNATES_TABLE)) {
      expect(templateById(key), key).toBeDefined();
      for (const alternate of alternates) expect(templateById(alternate.templateId), alternate.label).toBeDefined();
    }
    for (const rows of Object.values(INITIAL_TEAM_TABLE)) {
      for (const row of rows) expect(templateById(row.templateId), row.templateId).toBeDefined();
    }
  });

  test('评审员显示「评审」且全队一位，其余不是全队一位', () => {
    const reviewer = templateById('reviewer')!;
    expect(reviewer.dutyLabel).toBe('评审');
    expect(reviewer.uniquePerTeam).toBe(true);
    for (const item of BOT_TEMPLATES.filter(template => template.id !== 'reviewer')) {
      expect(item.uniquePerTeam, item.id).toBe(false);
      expect(item.dutyLabel, item.id).toBe(ROLE_LABELS[item.role]);
    }
  });

  test('执行类（不是总管、盯守）模板的节奏全是听吩咐', () => {
    for (const item of BOT_TEMPLATES.filter(template => template.role !== 'chief' && template.role !== 'sentinel')) {
      expect(item.rhythm, item.id).toBe('on_demand');
    }
    expect(templateById('researcher')!.rhythm).toBe('on_demand');
  });

  test('默认性格已按方案调整，其余模板不变', () => {
    expect(templateById('engineer')!.mbti).toBe('ISTJ');
    expect(templateById('designer')!.mbti).toBe('ISFJ');
    expect(templateById('reviewer')!.mbti).toBe('ISTJ');
    expect(templateById('product-manager')!.mbti).toBe('INTP');
    expect(templateById('researcher')!.mbti).toBe('INTP');
    expect(templateById('project-manager')!.mbti).toBe('ENTJ');
    expect(templateById('inspector')!.mbti).toBe('ISFJ');
  });

  test('六个有指定值的模板，新增字段逐字等于方案', () => {
    const engineer = templateById('engineer')!;
    expect(engineer.fitFor).toBe('写页面和功能，改完自己跑一遍，说明怎样验证。');
    expect(engineer.fitShort).toBe('做页面和功能');
    expect(engineer.estimate).toEqual({ text: '一件中等的事 4 到 8 个回合', minTurns: 4, maxTurns: 8 });
    expect(templateById('reviewer')!.estimate).toEqual({ text: '每次核对 1 到 2 个回合', minTurns: 1, maxTurns: 2 });
    expect(templateById('inspector')!.estimate).toEqual({ text: '每次检查 1 个回合', minTurns: 1, maxTurns: 1 });
    expect(templateById('researcher')!.fitShort).toBe('查资料');
  });

  test('其余模板取默认值：fitFor 为 tagline 去句号，fitShort 为模板名，估算 3 到 6 个回合', () => {
    const acceptor = templateById('acceptor')!;
    expect(acceptor.fitFor).toBe('交付前按验收项逐条核对');
    expect(acceptor.fitShort).toBe('验收员');
    expect(acceptor.estimate).toEqual({ text: '一件中等的事 3 到 6 个回合', minTurns: 3, maxTurns: 6 });
  });

  test('每个回合的 token 区间文字集中在常量里', () => {
    expect(TURN_TOKEN_RANGE_TEXT).toBe('1 个回合约 110K 到 160K token');
  });

  test('模板标识和名字不重复，分组都有模板', () => {
    expect(new Set(BOT_TEMPLATES.map(item => item.id)).size).toBe(BOT_TEMPLATES.length);
    expect(new Set(BOT_TEMPLATES.map(item => item.name)).size).toBe(BOT_TEMPLATES.length);
    expect(templatesInGroup('product').length).toBeGreaterThan(0);
  });
});

describe('findTemplate', () => {
  test('按标识找', () => expect(findTemplate('engineer')?.name).toBe('工程师'));
  test('按名字找', () => expect(findTemplate('工程师')?.id).toBe('engineer'));
  test('名字带首尾空白也能找到', () => expect(findTemplate('  评审员 \n')?.id).toBe('reviewer'));
  test('不存在返回 null', () => {
    expect(findTemplate('不存在的岗位')).toBeNull();
    expect(findTemplate('')).toBeNull();
  });
});

describe('名字与已添加判断', () => {
  test('没人用就用原名，被占用从 2 开始加序号', () => {
    expect(freeTemplateName('巡检员', ['工程师'])).toBe('巡检员');
    expect(freeTemplateName('巡检员', ['巡检员', '巡检员2'])).toBe('巡检员3');
  });

  test('isTemplateAdded：同名、同名加序号算已添加；已归档、前缀相似的名字不算', () => {
    const designer = templateById('designer')!;
    expect(isTemplateAdded(designer, [{ name: '设计师', archived: false }])).toBe(true);
    expect(isTemplateAdded(designer, [{ name: '设计师2', archived: false }])).toBe(true);
    expect(isTemplateAdded(designer, [{ name: '设计师', archived: true }])).toBe(false);
    expect(isTemplateAdded(designer, [{ name: '设计师小王', archived: false }])).toBe(false);
  });
});
