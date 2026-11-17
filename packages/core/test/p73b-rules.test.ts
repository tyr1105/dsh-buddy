/**
 * P73b 规则表测试：三问文字、打字匹配、「已记下」固定句、推荐名单、备选、结论句、拒绝口令、归档建议。
 * 每条规则至少一个正例一个反例；时间用显式传入的 now。
 */
import { describe, expect, test } from 'vitest';
import {
  ALTERNATES_TABLE, INITIAL_CONCLUSION, INITIAL_TEAM_TABLE, TEAM_OPENING_TEXT, TEAM_QUESTIONS, ackText, alternatesFor,
  isDeclinePhrase, matchTypedAnswer, recommendInitialTeam, suggestArchive,
  type ArchiveRow, type TeamRosterRow,
} from '../src/team/rules.js';

const withLight = { lightAvailable: true };
const noLight = { lightAvailable: false };
const row = (name: string, templateId: string | null, archived = false): TeamRosterRow => ({ name, templateId, archived });
const chief = row('总管', 'project-manager');
const summary = (list: ReturnType<typeof recommendInitialTeam>) => list.map(item => `${item.name}|${item.mbti}|${item.modelTier}`);

describe('三问文字', () => {
  test('问题、选项、建议项、说明行逐字照方案', () => {
    expect(TEAM_QUESTIONS.map(item => item.question)).toEqual([
      '第一个问题：你主要想让团队做哪类事？',
      '第二个问题：手上有没有已经在做的项目？有的话，我先把它的位置记下来。',
      '第三个问题：你希望多久被打扰一次？',
    ]);
    expect(TEAM_QUESTIONS[0].options.map(item => `${item.value}:${item.label}`)).toEqual([
      'software:做软件产品：网页、小工具、插件', 'research:调研与写作：查资料、写报告、写文案',
      'watch:盯守：定时检查网页、日志或任务', 'mixed:以上都有',
    ]);
    expect(TEAM_QUESTIONS[1].options.map(item => `${item.value}:${item.label}`)).toEqual(['yes:有，我选一下项目文件夹', 'no:暂时没有']);
    expect(TEAM_QUESTIONS[2].options.map(item => item.value)).toEqual(['decisions', 'each_done', 'each_step']);
    expect(TEAM_QUESTIONS.map(item => item.suggested)).toEqual([null, null, 'decisions']);
    expect(TEAM_QUESTIONS.map(item => item.note)).toEqual([
      '第 1 问，共 3 问。也可以直接在输入框里写。', '第 2 问，共 3 问', '第 3 问，共 3 问。答完我就给出推荐。',
    ]);
  });

  test('开场白逐字照方案，且不含「招」字', () => {
    expect(TEAM_OPENING_TEXT).toBe('你好，我是总管，你交代的每件事都由我来安排和交回。现在团队里只有我一位。我先问你 3 个问题，再推荐不超过 3 位员工，你确认后他们才会入职。');
    expect(TEAM_OPENING_TEXT).not.toContain('招');
  });
});

describe('ackText：已记下固定句', () => {
  test('三问每个选项逐字等于方案', () => {
    expect(ackText(1, { value: 'software' })).toBe('已记下：以做软件产品为主。');
    expect(ackText(1, { value: 'research' })).toBe('已记下：以调研与写作为主。');
    expect(ackText(1, { value: 'watch' })).toBe('已记下：以盯守为主。');
    expect(ackText(1, { value: 'mixed' })).toBe('已记下：三类都有。');
    expect(ackText(2, { value: 'yes', projectName: 'demo' })).toBe('已记下：项目「demo」。');
    expect(ackText(2, { value: 'no' })).toBe('已记下：暂时没有在做的项目。');
    expect(ackText(3, { value: 'decisions' })).toBe('已记下：只在需要你拍板时找你。');
    expect(ackText(3, { value: 'each_done' })).toBe('已记下：每件事做完都告诉你。');
    expect(ackText(3, { value: 'each_step' })).toBe('已记下：每个关键步骤都告诉你。');
  });

  test('第一问打字未命中：句子带原话；超过 30 字截断加省略号', () => {
    expect(ackText(1, { value: 'mixed', fallback: true, typedText: '随便' })).toBe('已记下：你的原话「随便」，按以上都有处理。');
    const long = '字'.repeat(40);
    const text = ackText(1, { value: 'mixed', fallback: true, typedText: long });
    expect(text).toBe(`已记下：你的原话「${'字'.repeat(30)}…」，按以上都有处理。`);
    expect(text).not.toContain('字'.repeat(31));
  });
});

describe('matchTypedAnswer', () => {
  test('第一问：恰好命中一类', () => {
    expect(matchTypedAnswer(1, '帮我做个小程序和网页')).toEqual({ value: 'software' });
    expect(matchTypedAnswer(1, '查资料写报告')).toEqual({ value: 'research' });
    expect(matchTypedAnswer(1, '帮我看日志')).toEqual({ value: 'watch' });
  });

  test('第一问：命中多类或零类按以上都有并标 fallback', () => {
    expect(matchTypedAnswer(1, '做网页也要查资料')).toEqual({ value: 'mixed', fallback: true });
    expect(matchTypedAnswer(1, '随便')).toEqual({ value: 'mixed', fallback: true });
  });

  test('第二问：路径、没有、其余要求重答', () => {
    expect(matchTypedAnswer(2, '/Users/x/proj')).toEqual({ value: 'yes', folderPath: '/Users/x/proj' });
    expect(matchTypedAnswer(2, '  /Users/x/proj  ')).toEqual({ value: 'yes', folderPath: '/Users/x/proj' });
    expect(matchTypedAnswer(2, '暂时没有')).toEqual({ value: 'no' });
    expect(matchTypedAnswer(2, '无')).toEqual({ value: 'no' });
    expect(matchTypedAnswer(2, '有的')).toBeNull();
  });

  test('第三问：命中与未命中', () => {
    expect(matchTypedAnswer(3, '做完告诉我')).toEqual({ value: 'each_done' });
    expect(matchTypedAnswer(3, '每一步都说')).toEqual({ value: 'each_step' });
    expect(matchTypedAnswer(3, '需要我拍板再说')).toEqual({ value: 'decisions' });
    expect(matchTypedAnswer(3, '看着办')).toEqual({ value: 'decisions', fallback: true });
  });
});

describe('recommendInitialTeam', () => {
  test('空名册：四类各一例，与方案表一致', () => {
    expect(summary(recommendInitialTeam('software', [], withLight, 6))).toEqual(['工程师|ISTJ|standard', '设计师|ISFJ|standard', '评审员|ISTJ|light']);
    expect(summary(recommendInitialTeam('research', [], withLight, 6))).toEqual(['研究员|INTP|standard', '评审员|ISTJ|light']);
    expect(summary(recommendInitialTeam('watch', [], withLight, 6))).toEqual(['巡检员|ISFJ|standard']);
    expect(summary(recommendInitialTeam('mixed', [], withLight, 6))).toEqual(['工程师|ISTJ|standard', '研究员|INTP|standard', '评审员|ISTJ|light']);
    expect(Object.keys(INITIAL_TEAM_TABLE)).toHaveLength(4);
  });

  test('已有工程师时软件类不再推荐工程师（含来历为空、按名字判断的旧员工）', () => {
    const byOrigin = recommendInitialTeam('software', [chief, row('小王', 'engineer')], withLight, 6);
    expect(byOrigin.map(item => item.templateId)).toEqual(['designer', 'reviewer']);
    const byName = recommendInitialTeam('software', [chief, row('工程师2', null)], withLight, 6);
    expect(byName.map(item => item.templateId)).toEqual(['designer', 'reviewer']);
  });

  test('已有评审员时不推荐评审员；已归档的不算已有', () => {
    expect(recommendInitialTeam('research', [chief, row('评审员', 'reviewer')], withLight, 6).map(item => item.templateId)).toEqual(['researcher']);
    expect(recommendInitialTeam('research', [chief, row('评审员', 'reviewer', true)], withLight, 6).map(item => item.templateId)).toEqual(['researcher', 'reviewer']);
  });

  test('在册 5 位（上限 6）时最多推荐 1 位；已满时为空', () => {
    const five = [chief, row('甲', 'seo-specialist'), row('乙', 'acceptor'), row('丙', 'team-coach'), row('丁', 'marketer')];
    expect(recommendInitialTeam('software', five, withLight, 6)).toHaveLength(1);
    expect(recommendInitialTeam('software', [...five, row('戊', 'spokesperson')], withLight, 6)).toHaveLength(0);
  });

  test('名册里有「设计师」时新设计师名为「设计师2」；已归档的名字也占用', () => {
    // 来历为空、名字叫设计师：模板视为已有，这里用另一个模板标识占着名字，模拟改名前的重名。
    const list = recommendInitialTeam('software', [chief, row('设计师', 'video-planner')], withLight, 6);
    expect(list.find(item => item.templateId === 'designer')?.name).toBe('设计师2');
    const archived = recommendInitialTeam('software', [chief, row('设计师', 'designer', true)], withLight, 6);
    expect(archived.find(item => item.templateId === 'designer')?.name).toBe('设计师2');
  });

  test('轻档不可用时评审员为标准档', () => {
    const list = recommendInitialTeam('software', [], noLight, 6);
    expect(list.find(item => item.templateId === 'reviewer')?.modelTier).toBe('standard');
  });
});

describe('备选', () => {
  test('每项 0 到 2 个，指向的模板在备选表里逐字等于方案', () => {
    expect(alternatesFor('engineer').map(item => item.label)).toEqual(['工程师，换性格 ESTJ：尽早给出初步结果', '产品经理：先把需求写清楚']);
    expect(alternatesFor('designer').map(item => item.label)).toEqual(['产品经理：先把需求写清楚', '视频策划：写推广视频脚本']);
    expect(alternatesFor('reviewer').map(item => item.label)).toEqual(['评审员，换性格 ESTJ：尽早给出初步意见']);
    expect(alternatesFor('researcher').map(item => item.label)).toEqual(['研究员，换性格 ISTJ：只核对事实，不找替代方案']);
    expect(alternatesFor('inspector')).toEqual([]);
    expect(alternatesFor('不存在')).toEqual([]);
    for (const list of Object.values(ALTERNATES_TABLE)) expect(list.length).toBeLessThanOrEqual(2);
  });
});

describe('INITIAL_CONCLUSION', () => {
  test('1、2、3 位各一例，句式固定，不含「招」字', () => {
    expect(INITIAL_CONCLUSION([{ templateId: 'inspector' }])).toBe('我建议先安排 1 位：巡检员盯守日志和任务。他们平时不接活就不消耗额度。请在下方确认；确认前不会入职。');
    expect(INITIAL_CONCLUSION([{ templateId: 'researcher' }, { templateId: 'reviewer' }])).toBe('我建议先安排 2 位：研究员查资料，评审员在交付前逐条核对。他们平时不接活就不消耗额度。请在下方确认；确认前不会入职。');
    const three = INITIAL_CONCLUSION([{ templateId: 'engineer' }, { templateId: 'designer' }, { templateId: 'reviewer' }]);
    expect(three).toBe('我建议先安排 3 位：工程师做页面和功能，设计师出原型，评审员在交付前逐条核对。他们平时不接活就不消耗额度。请在下方确认；确认前不会入职。');
    for (const text of [three, INITIAL_CONCLUSION([])]) expect(text).not.toContain('招');
  });
});

describe('isDeclinePhrase', () => {
  test('口令本身为真，带标点、空白、大小写也为真', () => {
    // P73r3 S6：口令收窄为六句整句，「不用新增」「不需要」「不要了」改入反例。
    for (const text of ['不新增', '不招。', '不用招', ' 不 加 人 ！', '不用加人', '先不加人']) expect(isDeclinePhrase(text), text).toBe(true);
  });

  test('夹带别的话或不是口令为假', () => {
    for (const text of ['不招的话谁来做', '不新增吗', '先不要', '', '好的', '不用新增', '不需要', '不要了']) expect(isDeclinePhrase(text), text).toBe(false);
  });
});

describe('suggestArchive', () => {
  const now = 100 * 24 * 3600 * 1000;
  const day = 24 * 3600 * 1000;
  const base = (over: Partial<ArchiveRow>): ArchiveRow => ({
    botId: 'b', name: 'x', role: 'executor', templateId: 'engineer', lastWorkAt: now, openWorkCount: 0, lastThinkAt: now, ownsProject: false, ...over,
  });

  test('30 天没接活的两位里选更久的那位；从未接活视为最早', () => {
    const rows = [
      base({ botId: 'a', name: '甲', lastWorkAt: now - 40 * day }),
      base({ botId: 'b', name: '乙', lastWorkAt: now - 90 * day }),
      base({ botId: 'c', name: '丙', lastWorkAt: now - day }),
    ];
    expect(suggestArchive(rows, now)).toEqual({ botId: 'b', name: '乙', reasonText: '最近 30 天没有接活' });
    const never = [...rows, base({ botId: 'd', name: '丁', lastWorkAt: null })];
    expect(suggestArchive(never, now)?.botId).toBe('d');
  });

  // P73r1（R6.3）：有在办事务的员工现在不能归档，已被排除；这条只剩「都没有在办事务」时按最近一次思考最早选。
  test('都接过活且都没有在办事务时，选最近一次思考最早的；有在办事务的不被选', () => {
    const rows = [
      base({ botId: 'a', name: '甲', openWorkCount: 3, lastWorkAt: now - 2 * day, lastThinkAt: now - 20 * day }),
      base({ botId: 'b', name: '乙', openWorkCount: 0, lastWorkAt: now - 5 * day, lastThinkAt: now - day }),
      base({ botId: 'c', name: '丙', openWorkCount: 0, lastWorkAt: now - 3 * day, lastThinkAt: now - 10 * day }),
    ];
    expect(suggestArchive(rows, now)).toEqual({ botId: 'c', name: '丙', reasonText: '没有在办的事，最久没有接活' });
  });

  test('只有总管和唯一评审员时返回 null；有两位评审员时可以选其一', () => {
    const only = [base({ botId: 'z', name: '总管', role: 'chief', templateId: 'project-manager', lastWorkAt: null }),
      base({ botId: 'r', name: '评审员', role: 'advisor', templateId: 'reviewer', lastWorkAt: null })];
    expect(suggestArchive(only, now)).toBeNull();
    expect(suggestArchive([], now)).toBeNull();
    const two = [...only, base({ botId: 'r2', name: '评审员2', role: 'advisor', templateId: 'reviewer', lastWorkAt: null })];
    expect(['r', 'r2']).toContain(suggestArchive(two, now)?.botId);
  });
});
