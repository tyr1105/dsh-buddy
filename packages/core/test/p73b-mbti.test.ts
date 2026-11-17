/**
 * P73b 性格四句话测试：总表逐字、四句顺序、提示词格式、唤醒包里的四句与卡片读到的四句一致。
 */
import { describe, expect, test } from 'vitest';
import { MBTI_TYPES } from '../src/model/enums.js';
import { MBTI_BEHAVIOR_TEXT, mbtiBehaviorLines, mbtiPrompt } from '../src/model/mbti.js';
import { saveBotMbti } from '../src/personality/profile.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { MBTI_DEFAULTS } from '../src/config/defaults.js';
import { byteLength } from '../src/util/text.js';
import { turnContext } from './c03-turn-fixtures.js';

/** 设计稿 D：ISTJ 的四句话（I、S、T、J）。 */
const ISTJ_LINES = [
  '交付前先自查一遍，没有必要不中途打扰。',
  '逐条核对事实和约定，不放过与约定不符的细节。',
  '按约定判断对错，发现问题直接指出。',
  '动手前先列计划，尽早收口交付。',
];
const stripPeriod = (text: string) => text.replace(/。$/, '');

describe('性格四句话总表', () => {
  test('八句逐字照设计稿', () => {
    expect(MBTI_BEHAVIOR_TEXT).toEqual({
      E: '尽早给出初步结果，方便及早纠偏。',
      I: '交付前先自查一遍，没有必要不中途打扰。',
      S: '逐条核对事实和约定，不放过与约定不符的细节。',
      N: '主动找约定里没说到的要素，并给出替代方案。',
      T: '按约定判断对错，发现问题直接指出。',
      F: '检查产出对使用者是否友好，指出难用的地方。',
      J: '动手前先列计划，尽早收口交付。',
      P: '保留几个选项，边做边调整。',
    });
  });

  test('mbtiBehaviorLines：ISTJ 四句逐字等于设计稿，顺序 E/I、S/N、T/F、J/P', () => {
    const lines = mbtiBehaviorLines('ISTJ')!;
    expect(lines.map(line => line.text)).toEqual(ISTJ_LINES);
    expect(lines.map(line => line.code)).toEqual(['I', 'S', 'T', 'J']);
  });

  test('16 型都是四句，字母与类型码逐位一致；未设置返回 null', () => {
    for (const type of MBTI_TYPES) {
      const lines = mbtiBehaviorLines(type)!;
      expect(lines).toHaveLength(4);
      expect(lines.map(line => line.code).join('')).toBe(type);
    }
    expect(mbtiBehaviorLines(null)).toBeNull();
    expect(mbtiBehaviorLines(undefined)).toBeNull();
  });
});

describe('mbtiPrompt', () => {
  test('格式：类型、四句（去句号、分号连接）、边界声明，且不超过唤醒包的性格段上限', () => {
    const prompt = mbtiPrompt('ISTJ')!;
    expect(prompt).toBe(`你的性格是 ISTJ。工作时按这四条做：${ISTJ_LINES.map(stripPeriod).join('；')}。这些只影响做事方式，不改变权限、审批、安全规则、额度与事实要求；与规矩冲突时以规矩为准。`);
    for (const type of MBTI_TYPES) expect(byteLength(mbtiPrompt(type)!), type).toBeLessThanOrEqual(MBTI_DEFAULTS.PROMPT_MAX_BYTES);
    expect(mbtiPrompt(null)).toBeNull();
  });
});

describe('唤醒包', () => {
  test('一位 ISTJ 员工的完整唤醒包里含这四句，且与卡片读到的四句逐字相同', async () => {
    const { ctx, bot, entry, ticket } = await turnContext('regular');
    saveBotMbti(ctx, bot.id, 'ISTJ');
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    for (const line of mbtiBehaviorLines('ISTJ')!) expect(packet).toContain(stripPeriod(line.text));
    for (const line of ISTJ_LINES) expect(packet).toContain(stripPeriod(line));
    expect(packet).toContain('你的性格是 ISTJ。');
  });
});
