/**
 * P75h 顺带做的六处小遗留（派活说明第三节）各自的测试：
 * 1 主人纠正的触发词表认得「以后……别……」这类写法；2 员工身份文件的工具清单有 hub_skill；
 * 3 四条新告警在「待你处理」里的标题没有英文代号；4 settings 注释（只改注释，没有测试）；
 * 5 复盘回合代写对外动作被拒的文字；6 先例的「问题：选定项」拼法不出现「？：」。
 */
import { describe, expect, it } from 'vitest';
import { CORRECTION_PATTERN } from '../src/reflect/trigger.js';
import { raiseAlert } from '../src/health/alerts.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { submitOutbox } from '../src/gate/outbox.js';
import { WakeTicketSchema } from '../src/model/index.js';
import { writePrecedents } from '../src/memory/precedents.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import { agentsMdOf, jobFix, ownerSays, speak } from './p75c-fixtures.js';
import { chiefDraftsAnother } from './p74b-fixtures.js';
import { THIRD_BACK, INTERNAL_NAMES, flow, retroRun, threadOf, srcsIn, retroTurn } from './p75h-fixtures.js';

describe('1 主人纠正的触发词表', () => {
  it('必须命中：任务卡自己的例句、同一小句内「以后」之后 12 字以内出现指令词，以及原有的全部写法', () => {
    for (const text of ['以后提示文字别用感叹号', '以后报名页的按钮一律用蓝色', '以后交付之前记得自测', '以后这类页面不要放广告',
      // 原有的（P73r2）写法照旧。
      '这样不对', '别再这样了', '请记住这点', '以后不要这样写', '以后都用这个格式', '以后要先核实', '以后别发这个', '以后记得备份', '以后注意口径', '以后必须带来源', '以后不能省略步骤',
      // 新写法的其他指令词；指令词紧跟「以后」。
      '以后表单里必须写明单位', '以后所有页面都不能出现英文', '以后一律用蓝色'])
      expect(CORRECTION_PATTERN.test(text), text).toBe(true);
  });

  it('必须不命中：「以后」后面没有指令词、被标点隔开、指令词不是指令（「区别」「别的」「别人」等）、原有的反例', () => {
    for (const text of ['以后再说，不要紧', '以后有空看看', '以后区别对待这两类用户', '以后有别的想法再告诉你', '以后每周发我一份', '以后再说吧',
      // 其他「别」字组成的词：特别、个别、分别、类别、识别、辨别、差别、告别；别人、别处、别名、别称。
      '以后特别好看', '以后个别页面再看', '以后分别处理', '以后类别另外定', '以后识别结果再看', '以后辨别方法再说', '以后差别很小', '以后告别旧版', '以后别人再来', '以后别处再看', '以后别名再说', '以后别称再定',
      // 指令词在下一个小句（被逗号、句号、问号、叹号、分号、换行隔开）。
      '以后再说。不要紧', '以后看情况；必须带来源', '以后怎么办？注意', '以后看看！记得', '以后再说\n不要紧',
      // 指令词离「以后」超过 12 个字。
      '以后这个页面里面的所有按钮和文字还有图片都放在左边不要动'])
      expect(CORRECTION_PATTERN.test(text), text).toBe(false);
  });

  it('可重复调用（不是全局正则）：连续两次同一句都命中', () => {
    expect(CORRECTION_PATTERN.test('以后提示文字别用感叹号')).toBe(true);
    expect(CORRECTION_PATTERN.test('以后提示文字别用感叹号')).toBe(true);
    expect(CORRECTION_PATTERN.global).toBe(false);
  });

  it('真实链路（P75g 记录第 2 条换过说法的那一条）：主人在主题里说任务卡原来的例句，被当成「你的纠正」出处，复盘提示是 3 条', async () => {
    const { fix, job } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK, topicMessages: ['以后提示文字别用感叹号'] });
    const run = retroRun(fix, job.id)!;
    expect(run).not.toBeNull();
    const hint = threadOf(fix.ctx, job.topicId).find(row => row.from === 'hub' && row.text.startsWith('有 '))!;
    expect(hint.text).toBe('有 3 条可学的出处，林舟、评审甲各复盘一次。');
    const { packet } = await retroTurn(fix, fix.engineer.id);
    expect(srcsIn(packet).map(row => [row.kind, row.quote])).toContainEqual(['你的纠正', '以后提示文字别用感叹号']);
    expect(INTERNAL_NAMES.test(hint.text)).toBe(false);
  });
});

describe('2 员工身份文件的工具清单有 hub_skill', () => {
  it('每位员工（执行者、总管）的工作守则里都写着 hub_skill 的一句说明', async () => {
    const fix = await jobFix();
    for (const who of [fix.chief, fix.engineer, fix.reviewer]) {
      const text = await agentsMdOf(fix.ctx, who);
      expect(text, who.name).toContain('hub_skill 在中心叫你复盘、核对或改写技能更新的回合里提交技能更新（调用写法见当回合唤醒包）。');
      // 放在「工具清单」一段里。
      const section = text.slice(text.indexOf('## 工具清单'), text.indexOf('## 文件约定'));
      expect(section, who.name).toContain('hub_skill');
    }
  });
});

describe('3 四条新告警的中文标题', () => {
  it('升级整理（两种代号）与技能目录（两种代号）：「待你处理」条目的标题里没有英文代号', async () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, name: '林舟' });
    const now = ctx.clock.now();
    for (const [code, botId, text] of [
      ['p75:migration', null, '升级时整理旧的规矩、套路和长期记忆没有完成，每次启动会再试。'],
      ['p75:migration-skipped', null, '升级时有几条旧经验没能整理进技能库，不再带给员工；原文仍保留在旧数据里。'],
      ['skill_dir_replaced', botFixture.id, '林舟家目录里的技能目录被换成了别的东西，中心已恢复成技能库里的内容。'],
      ['skill_verify_failed', botFixture.id, '林舟家目录里的技能目录核对没有完成，下一个回合读到的技能可能不是技能库里的内容。'],
    ] as const) raiseAlert(ctx, { code, botId, level: 'P1', immediate: true, text, at: now });
    await syncAlertItems(ctx);
    const titles = ctx.store.table('inbox').list(row => row.type === 'alert').map(row => row.title).sort();
    expect(titles).toEqual(['中心告警：升级整理', '中心告警：升级整理', '林舟告警：技能目录', '林舟告警：技能目录'].sort());
    for (const title of titles) expect(title, title).not.toMatch(/p75|skill_|migration|[a-zA-Z_]{4,}/);
  });

  it('反例：表外的代号仍显示「异常」，不暴露代号', async () => {
    const ctx = createTestContext();
    raiseAlert(ctx, { code: 'something_new', botId: null, level: 'P1', immediate: true, text: '出了点问题', at: ctx.clock.now() });
    await syncAlertItems(ctx);
    expect(ctx.store.table('inbox').list(row => row.type === 'alert').map(row => row.title)).toEqual(['中心告警：异常']);
  });
});

describe('5 复盘回合代写对外动作被拒的文字', () => {
  it('复盘回合 hub_outbox_submit 写工作区外：错误文字是「复盘回合只读，不执行对外动作」；非复盘回合不是这句', async () => {
    const owner = '/Users/owner', gRoot = `${owner}/AgentHub`, gHome = `${gRoot}/bots/b_0000000001`;
    const runtime = createTestContext({ ownerHome: owner });
    runtime.settings = resolveSettings({ rootDir: gRoot, l3Grants: [] });
    const bot = { ...botFixture, sessionId: 'session-leftover', homeDir: gHome, autonomy: 'L2' as const, lifecycle: 'active' as const };
    runtime.store.table('bots').put(bot);
    runtime.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: bot.id, sessionId: bot.sessionId, variant: 'reflection' });
    await expect(submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${owner}/Documents/note.txt`, content: 'x' }, why: '复盘时顺手写' }))
      .rejects.toThrow('复盘回合只读，不执行对外动作');
    // 反例：同一个动作不在复盘回合里，不会得到这句话（要么按自主等级处理，要么另有原因）。
    runtime.store.table('wakes').list().forEach(row => runtime.store.table('wakes').put({ ...row, variant: 'regular' }));
    const outcome = await submitOutbox(runtime, bot.id, { kind: 'write_file', payload: { path: `${owner}/Documents/note.txt`, content: 'x' }, why: '正常提交' }).catch((error: Error) => error);
    expect(outcome instanceof Error ? outcome.message : '').not.toContain('复盘回合只读');
  });
});

describe('6 先例的「问题：选定项」', () => {
  it('问题以问号结尾（全角或半角）时拼出来没有「？：」「?：」；问题没有问号时照旧', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做报价页');
    const id = await chiefDraftsAnother(fix, '报价页', { category: '表单页', pending: [
      { key: 'limit', question: '是否限制报名人数？', options: ['限 80 人', '不限'], suggested: '限 80 人', reason: '场地有限' },
      { key: 'refresh', question: '多久刷新一次', options: ['每天', '每周'], suggested: '每天', reason: '数据每天更新' },
      { key: 'source', question: 'Is the source public?', options: ['公开', '不公开'], suggested: '公开', reason: '来源要可查' },
    ] });
    await speak(fix, fix.chief, '这件事有 3 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    const texts = fix.ctx.store.table('memories').list(row => row.kind === 'precedent' && row.source.agreementId === id).map(row => row.text).sort();
    expect(texts.length).toBe(3);
    for (const text of texts) expect(text, text).not.toMatch(/[？?]：/);
    expect(texts).toContain('是否限制报名人数：限 80 人');
    expect(texts).toContain('多久刷新一次：每天');
    expect(texts).toContain('Is the source public：公开');
    expect(await writePrecedents(fix.ctx, id, 1)).toBe(0); // 幂等：再写一次不重复
  });
});
