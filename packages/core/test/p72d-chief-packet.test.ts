/**
 * P72d 总管唤醒包的测试：总管守则段、约定段、通用规矩两条改写、总管 AGENTS.md。
 * 为什么这样测：唤醒包是模型每个回合唯一能看见的规矩，所以一律断言最终字符串；
 * 直接造唤醒单测各种变体，需要真实链路（「定了」叫醒、主题回合）的用例走真实 Hub。
 */
import { describe, expect, it } from 'vitest';
import { AGREEMENT_DEFAULTS as D } from '../src/config/defaults.js';
import { renderBotAgentsMd } from '../src/memory/render.js';
import { AgreementSchema, type Agreement } from '../src/model/agreement.js';
import { ProjectSchema } from '../src/model/project.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { AGREEMENTS_TITLE, CHIEF_RULES_TEXT, CHIEF_RULES_TITLE, buildAgreementsBody } from '../src/wake/chief-packet.js';
import { byteLength } from '../src/util/text.js';
import { agreementFixture, contentFixture, versionFixture } from './p72a-agreement-fixtures.js';
import { turnContext } from './c03-turn-fixtures.js';
import { chiefDrafts, ownerSays, setup, speak } from './p72b-fixtures.js';
import { lastPacket, openTopic } from './p63-topic-fixtures.js';

/** 总管的一个常规回合环境（真实家目录，没有任何约定）。 */
const chiefTurn = (variant: 'regular' | 'light_check' | 'reflection' = 'regular') => turnContext(variant, { role: 'chief' });

/** 给总管造一份已固定的约定（直接写表）。n 用来区分 id、标题和更新时间。 */
function lockedAgreement(botId: string, n: number, patch: Partial<Agreement> = {}, versionPatch = {}): Agreement {
  const pad = String(n).padStart(10, '0');
  return AgreementSchema.parse(agreementFixture({
    id: `agr_${pad}`, botId, projectId: `prj_${pad}`, topicId: `ptp_${pad}`, title: `约定${n}`, state: 'locked',
    versions: [versionFixture(1, { state: 'locked', lockedAt: 1000 + n, lockedVia: 'button', choices: {}, content: { ...contentFixture(), summary: `第${n}份的一句话` }, ...versionPatch })],
    updatedAt: 1000 + n, ...patch,
  }));
}

/** 取出约定段正文（从标题到下一个二级标题之前）；守则正文里也有 agreementId 等字样，所以断言约定段要单独取。 */
function agreementsSection(packet: string): string {
  const rest = packet.split(`${AGREEMENTS_TITLE}\n`)[1] ?? '';
  return rest.split('\n\n## ')[0]!;
}

describe('总管守则段', () => {
  it('总管的常规唤醒包含守则全文；执行风格员工的不含', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain(CHIEF_RULES_TITLE);
    expect(packet).toContain(CHIEF_RULES_TEXT);
    // 守则放在规矩之后、约定段之前。
    expect(packet.indexOf('## 规矩')).toBeLessThan(packet.indexOf(CHIEF_RULES_TITLE));
    expect(packet.indexOf(CHIEF_RULES_TITLE)).toBeLessThan(packet.indexOf(AGREEMENTS_TITLE));
    const other = await turnContext('regular', { role: 'executor' });
    const otherPacket = await buildWakePacket(other.ctx, other.bot, other.entry, other.ticket);
    expect(otherPacket).not.toContain(CHIEF_RULES_TITLE);
    expect(otherPacket).not.toContain(AGREEMENTS_TITLE);
  });

  it('守则关键句一字不差（称呼、分档、拿不准按第三档、确认前不开工）', () => {
    for (const phrase of ['对主人说话一律称「你」，不写「主人」。', '拿不准是第二档还是第三档时，按第三档。',
      '已改好：把 X 由 A 改为 B，其他不变。', '这件事不开工、不派活，中心会拦下这件事的派活和主题里的 @；别的已固定的事照常安排。',
      '出处只能用下方列出的编号；没有出处就写 judgement，不得编造「你定过的规矩」。', '最多 5 项',
      // P73r5：交付时间以约定为准，不在回复里另报。
      '交付时间以约定为准，约定里没有写的，不要在回复里另报时间。',
      // P72g：第 7 条的撤回说法与「已固定的约定不能直接撤下」一致。
      '约定还没固定过时，主人说这件事不做了，用 mode withdraw；约定已经固定后，主人说这件事不做了，用 mode revise 提交一版，写明这件事不再做，请主人确认，你不能直接撤下已固定的约定。']) {
      expect(CHIEF_RULES_TEXT).toContain(phrase);
    }
  });

  it('守则第 4 条只出现一次（合并第四块时曾把它整段复制成两份）', () => {
    // 只数「4. pending」的出现次数：toContain 只能证明存在，钉不住重复。
    const occurrences = CHIEF_RULES_TEXT.split('4. pending').length - 1;
    expect(occurrences).toBe(1);
  });

  it('守则要求交付物一律派给队友：这句存在且只出现一次（P76q）', () => {
    const sentence = '交付物一律派给队友，你自己不写交付文件；只有回复、说明和整理可以自己写。';
    expect(CHIEF_RULES_TEXT).toContain(sentence);
    // 用整句切分来数次数：换个位置重复一遍也会被钉住。
    expect(CHIEF_RULES_TEXT.split(sentence).length - 1).toBe(1);
  });

  it('总管的轻复查包、复盘包不含守则段和约定段', async () => {
    for (const variant of ['light_check', 'reflection'] as const) {
      const { ctx, bot, entry, ticket } = await chiefTurn(variant);
      const packet = await buildWakePacket(ctx, bot, entry, ticket);
      expect(packet, variant).not.toContain(CHIEF_RULES_TITLE);
      expect(packet, variant).not.toContain(AGREEMENTS_TITLE);
    }
  });

  it('总管的主题回合唤醒包含守则段和约定段', async () => {
    const fix = await setup();
    await openTopic(fix, '帮我整理本周的事');
    const packet = lastPacket(fix, fix.chief);
    expect(packet).toContain('reply 会直接显示在这个主题里');
    expect(packet).toContain(CHIEF_RULES_TEXT);
    expect(packet).toContain(AGREEMENTS_TITLE);
  });

  // P75r3 第 10 节：原测试名「记忆摘要写到 20 KB 时，守则段仍一字不缺，整个包照常生成」，P75f 删掉了「记忆摘要」段、
  // 也就没有了预算压力。现在换一个能把常规部分撑过预算的段：大量议程（议程是员工自己维护的，条数没有上限）。
  it('议程多到把常规部分撑过预算时，守则段仍一字不缺，整个包照常生成', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    // 100 条议程，每条标题约 120 字节：常规部分远超 wakePacketMaxBytes（6 KB）。
    for (let n = 1; n <= 100; n += 1) {
      ctx.store.table('agenda').put({ id: `a_${String(n).padStart(10, '0')}`, botId: bot.id, kind: 'task', title: `事项${String(n).padStart(3, '0')}：${'核对资料'.repeat(8)}`,
        goalId: null, dueAt: null, onEvent: null, abandonWhen: '资料撤回', priority: 3, toOwner: false, source: 'bot', status: 'open', note: null,
        createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
    }
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    // 压力确实存在：议程没有全部列出（最后一条被预算挤掉）。
    expect(packet).toContain('事项001');
    expect(packet).not.toContain('事项100');
    // 守则段一字不缺。
    expect(packet).toContain(CHIEF_RULES_TEXT);
    // 常规部分仍受原预算管，守则和约定段另计。
    const extra = byteLength(CHIEF_RULES_TEXT) + byteLength(CHIEF_RULES_TITLE);
    expect(byteLength(packet)).toBeLessThanOrEqual(ctx.settings.wakePacketMaxBytes + extra + D.PACKET_MAX_BYTES + 200);
    // 反例：没有议程压力时同样一字不缺，且这个包比有压力时的常规部分小得多（说明上面确实是预算在起作用）。
    const calm = await chiefTurn();
    const calmPacket = await buildWakePacket(calm.ctx, calm.bot, calm.entry, calm.ticket);
    expect(calmPacket).toContain(CHIEF_RULES_TEXT);
    expect(byteLength(calmPacket)).toBeLessThan(byteLength(packet));
  });
});

describe('通用规矩的两条改写', () => {
  it('总管的第 1、3 条改写；执行风格员工仍是原文', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain('先做不依赖主人的部分；需要对齐的事，在主人确认约定之前不开工。');
    expect(packet).toContain('需要主人定的事放进约定，约定之外的单个问题写进 ownerQuestion，一次最多一个。');
    expect(packet).not.toContain('需要决定的写进 ownerQuestion');
    const other = await turnContext('regular', { role: 'executor' });
    const otherPacket = await buildWakePacket(other.ctx, other.bot, other.entry, other.ticket);
    expect(otherPacket).toContain('先做不依赖主人的部分。');
    expect(otherPacket).not.toContain('在主人确认约定之前不开工');
    expect(otherPacket).toContain('需要决定的写进 ownerQuestion，一次最多一个。');
  });
});

describe('约定段内容', () => {
  it('有一份 pending 约定：给出 agreementId、每个待定项的 key 和建议；没有约定时只有出处说明', async () => {
    const empty = await chiefTurn();
    const none = await buildWakePacket(empty.ctx, empty.bot, empty.entry, empty.ticket);
    // P75b：约定段末尾多一行类别表（任务卡第 9 节允许的全文比对改动：只多这一行）。
    expect(agreementsSection(none)).toBe('暂无可引用的出处，依据只能写 convention、trial 或 judgement。\n类别（category 只能写这些）：表单页、展示页、数据整理、数据核对、文档撰写、调研报告、脚本工具、问题排查、设计稿、其他。');

    const { ctx, bot, entry, ticket } = await chiefTurn();
    const pending = agreementFixture({ botId: bot.id });
    ctx.store.table('agreements').put(pending);
    const packet = agreementsSection(await buildWakePacket(ctx, bot, entry, ticket));
    expect(packet).toContain('待主人确认：约定「每日报价页」第 1 版（agreementId 为 agr_0000000001，主题「每日报价页」）');
    expect(packet).toContain('- key=source｜报价从哪里取｜选项：公开接口 / 手工表格｜建议：公开接口');
    expect(packet).toContain('- key=refresh｜多久刷新一次｜选项：每小时 / 每天｜建议：每天');
    expect(packet).toContain('你已定的：1. 只做网页，不做手机端（依据：我的判断）');
    expect(packet).toContain('草图沿用上一版；要改草图时整份重填 sketch。');
    expect(packet).toContain('怎样算做完：1. 打开页面能看到今天的报价');
  });

  it('只列最近 3 份已固定的约定；已撤下的约定不出现', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    for (const n of [1, 2, 3, 4]) ctx.store.table('agreements').put(lockedAgreement(bot.id, n));
    ctx.store.table('agreements').put(AgreementSchema.parse(agreementFixture({
      id: 'agr_0000000009', botId: bot.id, title: '撤下的事', state: 'withdrawn',
      versions: [versionFixture(1, { state: 'superseded' })], withdrawn: { at: 5000, reason: '不做了', wakeId: null, noticeMessageId: null }, updatedAt: 9000,
    })));
    const packet = agreementsSection(await buildWakePacket(ctx, bot, entry, ticket));
    expect(packet).toContain('已固定：约定「约定4」第 1 版（agreementId 为 agr_0000000004，固定于');
    expect(packet).toContain('约定「约定3」');
    expect(packet).toContain('约定「约定2」');
    expect(packet).not.toContain('约定「约定1」');
    expect(packet).not.toContain('撤下的事');
    expect(packet).toContain('：第4份的一句话');
  });

  it('「定了」叫醒的那一回合第一行是「刚由主人确认」，之后的普通回合没有', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    await speak(fix, fix.chief, '已记下，请看卡片');
    await ownerSays(fix, fix.chief.id, '定了');
    const packet = lastPacket(fix, fix.chief);
    // P74b：这一行带约定编号和逐条编号的「怎样算做完」，总管据此一次填对 hub_job_manage 的参数。
    expect(packet).toMatch(/刚由主人确认：约定「每日报价页」第 1 版（agreementId 为 agr_[a-z0-9]{10}）。怎样算做完：1\. 打开页面能看到今天的报价 2\. 点刷新后数据更新 3\. 接口失败时有提示。这次不做：历史曲线。对外发布：无（验收之后没有发布这一步）。现在可以安排员工开工；reply 用一句话说明交付时间，以及什么情况才会再来问你。/);
    // 约定段的第一行就是它。
    const body = packet.split(`${AGREEMENTS_TITLE}\n`)[1]!;
    expect(body.startsWith('刚由主人确认：')).toBe(true);
    expect(packet).toContain('已固定：约定「每日报价页」第 1 版');
    // 总管答完，主人再说别的，包里不再有这一行。
    await speak(fix, fix.chief, '预计明天交付，有变化再来问你');
    await ownerSays(fix, fix.chief.id, '另外今天天气怎么样');
    const later = lastPacket(fix, fix.chief);
    expect(later).not.toContain('刚由主人确认');
    expect(later).toContain('已固定：约定「每日报价页」第 1 版');
  });

  it('约定段正文超过 3 KB 时被截断到 3 KB 以内，整个包照常生成', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    const long = (s: string) => s.repeat(Math.floor(100 / [...s].length));
    const content = {
      ...contentFixture(),
      decided: Array.from({ length: 8 }, (_, i) => ({ text: long(`已定的事${i}，`).slice(0, 100), basis: { kind: 'judgement' as const, ref: null, refText: null } })),
      scopeIn: Array.from({ length: 6 }, (_, i) => `范围内第${i}条`.padEnd(60, '范')),
      doneWhen: Array.from({ length: 5 }, (_, i) => `做完的标准${i}`.padEnd(100, '完')),
    };
    ctx.store.table('agreements').put(agreementFixture({ botId: bot.id, versions: [versionFixture(1, { content })] }));
    const body = buildAgreementsBody(ctx, bot, entry, ctx.clock.now());
    expect(byteLength(body)).toBeLessThanOrEqual(D.PACKET_MAX_BYTES);
    expect(byteLength(body)).toBeGreaterThan(D.PACKET_MAX_BYTES - 10);
    await expect(buildWakePacket(ctx, bot, entry, ticket)).resolves.toContain(CHIEF_RULES_TEXT);
  });
});

describe('可引用的出处', () => {
  /** 往存储里放一条规矩。 */
  const putRule = (ctx: Awaited<ReturnType<typeof chiefTurn>>['ctx'], n: number, patch: Record<string, unknown> = {}) => ctx.store.table('rules').put({
    id: `ru_${String(n).padStart(10, '0')}`, scope: 'global', text: `规矩${n}`, redLine: false, source: 'owner', status: 'active', createdAt: 1000 + n, ...patch,
  } as never);
  /** 放一个项目，决策列表自定。 */
  const putProject = (ctx: Awaited<ReturnType<typeof chiefTurn>>['ctx'], n: number, members: string[], decisions: string[], archivedAt: number | null = null) => ctx.store.table('projects').put(ProjectSchema.parse({
    id: `prj_${String(n).padStart(10, '0')}`, name: `项目${n}`, charter: '', status: 'active', ownerBotId: null, memberBotIds: members, sharedDir: `/shared/${n}`,
    acceptanceCriteria: [], createdAt: 1, updatedAt: 1, archivedAt,
    context: { background: '', conventions: '', decisions: decisions.map((text, i) => ({ id: `dc_${String(n * 10 + i).padStart(10, '0')}`, text, by: 'owner', at: 2000 + i })), glossary: [] },
  }));

  it('有效 global 规矩和总管专属规矩、总管所在项目的决策出现；归档规矩、别人的规矩、非成员项目的决策、已归档项目的决策不出现', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    putRule(ctx, 1, { text: '价格一律含税' });
    putRule(ctx, 2, { scope: bot.id, text: '总管专属的规矩' });
    putRule(ctx, 3, { status: 'archived', text: '已归档的规矩' });
    putRule(ctx, 4, { scope: 'b_0000000099', text: '别的员工专属的规矩' });
    putRule(ctx, 5, { status: 'proposed', text: '只是提议的规矩' });
    putProject(ctx, 1, [bot.id], ['报名页只收手机号']);
    putProject(ctx, 2, ['b_0000000099'], ['总管不在的项目的决策']);
    putProject(ctx, 3, [bot.id], ['已归档项目的决策'], 5000);
    // 只看约定段里的出处列表：项目共享上下文段是原有功能，会另外带出项目决策，不在本卡断言范围。
    const packet = agreementsSection(await buildWakePacket(ctx, bot, entry, ticket));
    expect(packet).toContain('ru_0000000001：价格一律含税');
    expect(packet).toContain('ru_0000000002：总管专属的规矩');
    expect(packet).toContain('dc_0000000010：报名页只收手机号');
    for (const hidden of ['已归档的规矩', '别的员工专属的规矩', '只是提议的规矩', '总管不在的项目的决策', '已归档项目的决策']) expect(packet).not.toContain(hidden);
    expect(packet).not.toContain('暂无可引用的出处');
    // 规矩在前，决策在后。
    expect(packet.indexOf('ru_0000000001')).toBeLessThan(packet.indexOf('dc_0000000010'));
  });

  it('超过 12 条时只列 12 条，每条只取前 60 字', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    for (let n = 1; n <= 10; n++) putRule(ctx, n, { text: `规矩${n}${'长'.repeat(100)}` });
    putProject(ctx, 1, [bot.id], ['决策甲', '决策乙', '决策丙', '决策丁']);
    const packet = agreementsSection(await buildWakePacket(ctx, bot, entry, ticket));
    const ids = packet.match(/\b(?:ru|dc)_\d{10}：/g) ?? [];
    expect(ids).toHaveLength(D.PACKET_SOURCES_MAX);
    // P75r1：原来断言「10 条规矩全在，决策只剩前 2 条」；现在「规矩与偏好」一组合并后最多 8 条（PACKET_RULES_MAX），
    // 决策补满剩下的名额（4 条都在），合计仍是 12 条。
    expect(ids.filter(id => id.startsWith('ru_'))).toHaveLength(8);
    expect(ids.filter(id => id.startsWith('dc_'))).toHaveLength(4);
    expect(packet).not.toContain('长'.repeat(61));
    expect(packet).toContain('长'.repeat(55));
  });
});

describe('默契度不进提示词；总管 AGENTS.md', () => {
  it('确认过约定（采纳 3 / 4）后，唤醒包和总管 AGENTS.md 都不含「默契」和采纳数', async () => {
    const { ctx, bot, entry, ticket } = await chiefTurn();
    ctx.store.table('agreements').put(lockedAgreement(bot.id, 1, {}, { adoption: { adopted: 3, total: 4 } }));
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    const agents = renderBotAgentsMd(ctx, bot);
    for (const text of [packet, agents]) {
      expect(text).not.toContain('默契');
      expect(text).not.toContain('3 / 4');
      expect(text).not.toContain('3/4');
      expect(text).not.toContain('采纳');
    }
  });

  it('总管 AGENTS.md 含约定工具和称呼规矩；执行风格员工的 AGENTS.md 不含，仍是原文', async () => {
    const chief = await chiefTurn();
    const agents = renderBotAgentsMd(chief.ctx, chief.bot);
    expect(agents).toContain('hub_agreement_submit 提交开工前的约定（仅总管）。');
    expect(agents).toContain('对主人说话称「你」');
    expect(agents).toContain('需要主人定的事放进约定；约定之外的单个问题写 ownerQuestion，最多一个。');
    expect(agents).not.toContain('需要主人决定时 ownerQuestion 最多一个');
    expect(agents).not.toContain('先完成不依赖主人的部分');
    const other = await turnContext('regular', { role: 'executor' });
    const otherAgents = renderBotAgentsMd(other.ctx, other.bot);
    expect(otherAgents).not.toContain('hub_agreement_submit');
    expect(otherAgents).not.toContain('对主人说话称「你」');
    expect(otherAgents).toContain('先完成不依赖主人的部分');
    expect(otherAgents).toContain('需要主人决定时 ownerQuestion 最多一个');
  });
});
