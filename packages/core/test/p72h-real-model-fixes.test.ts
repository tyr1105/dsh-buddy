/**
 * P72h 的测试：修复真模型验证（P72f）发现的问题。
 * - H1：修订时不能悄悄丢条目（整段不传沿用、传了变少必须声明删除、被拒不产生版本、「本版改动」列出删去的条目）；
 * - H2：约定固定后，唤醒包里由中心写明在岗执行员工的事实；守则补「总管不自己动手」；
 * - H3：新建员工不再自动试跑，也没有试跑留下的提议；
 * - H4：对齐时回复不列举待定项；
 * - H5：约定固定后，主题开头的中心旁白不再写「确认前不会开工」。
 * 为什么走真实 Hub：提交工具、唤醒包、线程视图都挂在真实链路上，只有走链路才能测到接线。
 */
import { describe, expect, it } from 'vitest';
import { createHub } from '../src/engine/hub.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { agreementCardView } from '../src/api/agreement-views.js';
import { threadView } from '../src/api/feed-views.js';
import { assertRemovalsDeclared, diffContent, findDroppedItems } from '../src/project/agreement-content.js';
import { AGREEMENT_TOPIC_NOTE } from '../src/project/agreement-home.js';
import { CHIEF_RULES_TEXT, staffFactLine } from '../src/wake/chief-packet.js';
import { agreementFixture, contentFixture, versionFixture } from './p72a-agreement-fixtures.js';
import { okData } from './c04-api-fixtures.js';
import { lastPacket } from './p63-topic-fixtures.js';
import { callTool, chiefDrafts, lockAgreement, ownerSays, setup, speak, type Fix } from './p72b-fixtures.js';

/** 三条「我已定的」：P72f 回合 2 里总管把它们缩成了 1 条。 */
const THREE_DECIDED = [
  { text: '11 月 18 日周三上线', basis: { kind: 'judgement' } },
  { text: '只做移动端单页', basis: { kind: 'convention' } },
  { text: '对外发布另行确认', basis: { kind: 'judgement' } },
];

/** 总管先提交带三条已定项的第 1 版，结束回合；主人再说一句话叫醒总管，返回约定 id。 */
async function draftThenOwnerSpeaks(fix: Fix): Promise<string> {
  const id = await chiefDrafts(fix, { decided: THREE_DECIDED });
  await speak(fix, fix.chief, '已记下，请看卡片');
  await ownerSays(fix, fix.chief.id, '报名信息再加一项公司名，选填。其余按你的建议。');
  return id;
}

/** 修订时通用的待定项改动（让「没有任何不同」不挡路）：给 doneWhen 加一条。 */
const MORE_DONE = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '页面在手机上能看'];

describe('H1 修订时不能悄悄丢条目', () => {
  it('按 P72f 回合 2 的输入复现：只传 1 条已定项被拒，报错列出少了的 2 条，没有生成新版本', async () => {
    const fix = await setup();
    const id = await draftThenOwnerSpeaks(fix);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      agreementId: id, changeNote: '报名信息加公司名', decided: [THREE_DECIDED[0]], doneWhen: MORE_DONE,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('「我已定的」比上一版少了条目，上一版的这几条在这一版里找不到');
    expect(result.error).toContain('「只做移动端单页」');
    expect(result.error).toContain('「对外发布另行确认」');
    expect(result.error).not.toContain('「11 月 18 日周三上线」');
    expect(result.error).toContain('没改的条目要原样带上；确实要删除时，在 removals 里逐条写明');
    // 被拒绝的提交不产生版本。
    expect(fix.ctx.store.table('agreements').get(id)!.versions).toHaveLength(1);
  });

  it('被拒后同一回合改正再提交：整段不传沿用上一版的三条，成功生成第 2 版', async () => {
    const fix = await setup();
    const id = await draftThenOwnerSpeaks(fix);
    const bad = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      agreementId: id, changeNote: '加公司名', decided: [THREE_DECIDED[0]], doneWhen: MORE_DONE,
    });
    expect(bad.ok).toBe(false);
    // 改正：decided 整段不传。
    const good = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '加公司名', doneWhen: MORE_DONE });
    expect(good.ok).toBe(true);
    const versions = fix.ctx.store.table('agreements').get(id)!.versions;
    expect(versions).toHaveLength(2);
    expect(versions[1]!.content.decided.map(item => item.text)).toEqual(THREE_DECIDED.map(item => item.text));
    // 没有任何已定项被删：本版改动里没有「删去」。
    expect(versions[1]!.changes.some(mark => mark.kind === 'removed')).toBe(false);
  });

  it('传了完整的三条（带全）也成功：没丢条目不需要声明', async () => {
    const fix = await setup();
    const id = await draftThenOwnerSpeaks(fix);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      agreementId: id, changeNote: '加公司名', decided: THREE_DECIDED, doneWhen: MORE_DONE,
    });
    expect(result.ok).toBe(true);
  });

  it('写明删除：removals 列出被删条目，成功；「本版改动」逐条列出「删去」，改动区覆盖了全部差异', async () => {
    const fix = await setup();
    const id = await draftThenOwnerSpeaks(fix);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      agreementId: id, changeNote: '你说这两件不用定了', decided: [THREE_DECIDED[0]],
      removals: ['只做移动端单页', '对外发布另行确认'],
    });
    expect(result.ok).toBe(true);
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const v2 = agreement.versions[1]!;
    expect(v2.content.decided).toHaveLength(1);
    const removedMarks = v2.changes.filter(mark => mark.section === 'decided' && mark.kind === 'removed');
    expect(removedMarks.map(mark => mark.text).sort()).toEqual(['只做移动端单页', '对外发布另行确认']);
    // 卡片视图：改动区逐条列出被删的条目，没有「没记下原文」的删除。
    const card = agreementCardView(fix.ctx, agreement, v2);
    expect([...card.removed].sort()).toEqual(['只做移动端单页', '对外发布另行确认']);
    expect(card.removedUnlisted).toBe(0);
  });

  it('反例：removals 里写了没被删的条目（这一版仍带着它）被拒，指出是哪一条', async () => {
    const fix = await setup();
    const id = await draftThenOwnerSpeaks(fix);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      agreementId: id, changeNote: '加一条', decided: THREE_DECIDED, doneWhen: MORE_DONE, removals: ['只做移动端单页'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('removals');
    expect(result.error).toContain('只做移动端单页');
    expect(fix.ctx.store.table('agreements').get(id)!.versions).toHaveLength(1);
  });

  it('同条数的改写不要求声明（是「改动」，由对比标记显示）', async () => {
    const fix = await setup();
    const id = await draftThenOwnerSpeaks(fix);
    const rewritten = [{ text: '11 月 18 日周三晚上线', basis: { kind: 'judgement' } }, THREE_DECIDED[1], THREE_DECIDED[2]];
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '上线时间改为晚上', decided: rewritten });
    expect(result.ok).toBe(true);
  });

  it('待定项变少也要声明：写 key 通过，不写被拒', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    await speak(fix, fix.chief, '已记下');
    await ownerSays(fix, fix.chief.id, '刷新频率不用问了');
    const only = contentFixture().pending.slice(0, 1).map(({ key, question, options, suggested, reason }) => ({ key, question, options, suggested, reason }));
    const bad = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '去掉刷新频率', pending: only });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('「待定项」里，上一版的这几项在这一版里没有了');
    expect(bad.error).toContain('多久刷新一次');
    // 草图里「刷新」按钮原来标着第 2 项的圆圈，待定项只剩 1 项后要去掉那个圆圈，否则内容校验不过。
    const sketch = { layout: 'page', screens: [{ title: '报价页', blocks: [
      { kind: 'title', text: '每日报价' }, { kind: 'list', text: '报价列表', mark: 1 }, { kind: 'button', text: '刷新' }] }] };
    const good = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '去掉刷新频率', pending: only, sketch, removals: ['refresh'] });
    expect(good.error).toBeUndefined();
    const mark = fix.ctx.store.table('agreements').get(id)!.versions[1]!.changes.find(row => row.section === 'pending' && row.kind === 'removed');
    expect(mark).toMatchObject({ key: 'refresh', text: '多久刷新一次' });
  });

  it('纯函数：只看传了的段；没传的段不算丢；同条数不算丢', () => {
    const prev = contentFixture();
    const next = { ...prev, decided: [], scopeIn: ['报价列表页'] };
    // decided、scopeIn 传了且变少；pending、scopeOut、doneWhen 没传。
    const dropped = findDroppedItems(prev, next, { pending: false, decided: true, scopeIn: true, scopeOut: false, doneWhen: false });
    expect(dropped.map(item => `${item.section}:${item.id}`)).toEqual(['decided:只做网页，不做手机端', 'scopeIn:手动刷新']);
    // 全都没传：不丢。
    expect(findDroppedItems(prev, next, { pending: false, decided: false, scopeIn: false, scopeOut: false, doneWhen: false })).toEqual([]);
    // 声明齐全通过；少声明一条被拒；多声明一条被拒。
    expect(() => assertRemovalsDeclared(dropped, ['只做网页，不做手机端', '手动刷新'])).not.toThrow();
    expect(() => assertRemovalsDeclared(dropped, ['手动刷新'])).toThrow('「我已定的」比上一版少了条目');
    expect(() => assertRemovalsDeclared(dropped, ['只做网页，不做手机端', '手动刷新', '凭空'])).toThrow('removals');
  });

  it('对比标记：删去的条目记下原文，后面的条目前移不会让「删去」写成别的条目', () => {
    const prev = { ...contentFixture(), scopeIn: ['甲', '乙', '丙'] };
    const next = { ...prev, scopeIn: ['乙', '丙'] }; // 删了第一条
    const marks = diffContent(prev, next).filter(mark => mark.section === 'scopeIn');
    expect(marks.find(mark => mark.kind === 'removed')).toMatchObject({ text: '甲' });
  });

  it('旧数据：删除标记没有原文时，视图记为「没记下原文」，界面据此不写「与上一版相同」', async () => {
    const fix = await setup();
    const id = await draftThenOwnerSpeaks(fix);
    await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '加一条验收', doneWhen: MORE_DONE });
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const v2 = { ...agreement.versions[1]!, changes: [...agreement.versions[1]!.changes, { section: 'decided' as const, kind: 'removed' as const, index: 2 }] };
    const card = agreementCardView(fix.ctx, agreement, v2);
    expect(card.removed).toEqual([]);
    expect(card.removedUnlisted).toBe(1);
  });

  it('既改写又删除：上一版三条、这一版只传一条改写后的——不写被拒列三条；少写一条被拒列缺的；写全三条成功且卡片列出三条', async () => {
    const fix = await setup();
    const id = await draftThenOwnerSpeaks(fix);
    const rewritten = [{ text: '11 月 18 日周三晚上线', basis: { kind: 'judgement' } }];
    const base = { agreementId: id, changeNote: '上线时间改晚上，其余不要了', decided: rewritten };
    const none = await callTool(fix, fix.chief, 'hub_agreement_submit', base);
    expect(none.ok).toBe(false);
    for (const name of THREE_DECIDED) expect(none.error).toContain(`「${name.text}」`);
    expect(none.error).not.toMatch(/少了 \d+ 条/);
    const two = await callTool(fix, fix.chief, 'hub_agreement_submit', { ...base, removals: ['11 月 18 日周三上线', '只做移动端单页'] });
    expect(two.ok).toBe(false);
    expect(two.error).toContain('「对外发布另行确认」');
    expect(two.error).not.toContain('「只做移动端单页」');
    expect(fix.ctx.store.table('agreements').get(id)!.versions).toHaveLength(1);
    const all = await callTool(fix, fix.chief, 'hub_agreement_submit', { ...base, removals: THREE_DECIDED.map(item => item.text) });
    expect(all.error).toBeUndefined();
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const card = agreementCardView(fix.ctx, agreement, agreement.versions[1]!);
    expect([...card.removed].sort()).toEqual(THREE_DECIDED.map(item => item.text).sort());
    expect(card.removedUnlisted).toBe(0);
  });

  it('待定项换题且条数不变：不写 removals 被拒；写旧 key 成功，卡片列出旧问题原文', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    await speak(fix, fix.chief, '已记下');
    await ownerSays(fix, fix.chief.id, '刷新频率换成问通知方式');
    const swapped = [
      ...contentFixture().pending.slice(0, 1).map(({ key, question, options, suggested, reason }) => ({ key, question, options, suggested, reason })),
      { key: 'notify', question: '用什么方式通知', options: ['站内信', '邮件'], suggested: '站内信', reason: '成本最低' },
    ];
    const bad = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '换题', pending: swapped });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('多久刷新一次');
    const good = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '换题', pending: swapped, removals: ['refresh'] });
    expect(good.error).toBeUndefined();
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    expect(agreementCardView(fix.ctx, agreement, agreement.versions[1]!).removed).toEqual(['多久刷新一次']);
  });

  it('同条数改写时在 removals 里写了旧条目：被拒，报错说明「条数没有减少」', async () => {
    const fix = await setup();
    const id = await draftThenOwnerSpeaks(fix);
    const rewritten = [{ text: '11 月 18 日周三晚上线', basis: { kind: 'judgement' } }, THREE_DECIDED[1], THREE_DECIDED[2]];
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      agreementId: id, changeNote: '上线时间改晚上', decided: rewritten, removals: ['11 月 18 日周三上线'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('条数没有减少');
    expect(fix.ctx.store.table('agreements').get(id)!.versions).toHaveLength(1);
  });

  it('总管守则：补了「没改的整段不传、传了要带全、要删写明」', () => {
    expect(CHIEF_RULES_TEXT).toContain('修订时，没改的部分整段不传；传了的部分要带全，包括其中没改的条目；确实要删除某条时，用 removals 写明被删的条目。');
  });
});

describe('H2 约定固定后总管不自己动手', () => {
  it('守则补了「合适的在岗员工动手，没有就告诉主人添加，不要自己动手」', () => {
    // P73d：第 6 条改写为「按顺序安排人」五步，缺角色时走 hub_team_propose 或自己完成；「不要自己动手」改为「只有小事才自己做」的明确分级。
    expect(CHIEF_RULES_TEXT).toContain('约定固定后安排人，按顺序做：');
    expect(CHIEF_RULES_TEXT).toContain('五、只有不需要专业技能、几步就能完成的小事才自己做。');
    expect(CHIEF_RULES_TEXT).not.toContain('由执行风格的在岗员工动手');
  });

  it('执行和调研各一位：「刚由主人确认」之后两人都列出，写明名字和角色', async () => {
    const fix = await setup();
    fix.ctx.store.table('bots').patch(fix.li.id, { role: 'researcher' });
    await chiefDrafts(fix);
    await speak(fix, fix.chief, '已记下，请看卡片');
    await ownerSays(fix, fix.chief.id, '定了');
    const packet = lastPacket(fix, fix.chief);
    expect(packet).toContain('刚由主人确认：约定「每日报价页」第 1 版（agreementId 为 ');
    expect(packet).toContain('当前在岗的员工：小王（执行，在办 0 件）、小李（调研，在办 0 件）。约定里的工作交给合适的员工，你负责安排；没有合适的，就告诉主人需要先添加什么角色的员工，不要自己动手。');
    expect(packet).not.toContain('没有在岗的员工');
  });

  it('只有调研员工：列出调研员工，不出现「没有在岗」', () => {
    return setup().then(fix => {
      fix.ctx.store.table('bots').patch(fix.wang.id, { role: 'researcher' });
      fix.ctx.store.table('bots').patch(fix.li.id, { lifecycle: 'paused' });
      const line = staffFactLine(fix.ctx);
      expect(line).toContain('当前在岗的员工：小王（调研，在办 0 件）。');
      expect(line).not.toContain('没有在岗');
      expect(line).not.toContain('小李');
    });
  });

  it('除总管外没有在岗员工（都暂停或退役）：写明没有，要求告诉主人先添加，不要自己动手', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    await speak(fix, fix.chief, '已记下，请看卡片');
    fix.ctx.store.table('bots').patch(fix.wang.id, { lifecycle: 'paused' });
    fix.ctx.store.table('bots').patch(fix.li.id, { lifecycle: 'retired' });
    await ownerSays(fix, fix.chief.id, '定了');
    const packet = lastPacket(fix, fix.chief);
    expect(packet).toContain('团队里除你之外没有在岗的员工：请告诉主人需要先添加一位（说明需要什么角色），不要自己动手。');
    expect(packet).not.toContain('当前在岗的员工');
  });

  it('只有总管在编时同样写「除你之外没有在岗的员工」（总管自己不列）', async () => {
    const fix = await setup();
    for (const bot of [fix.wang, fix.li]) fix.ctx.store.table('bots').remove(bot.id);
    expect(staffFactLine(fix.ctx)).toBe('团队里除你之外没有在岗的员工：请告诉主人需要先添加一位（说明需要什么角色），不要自己动手。');
  });
});

describe('H3 新建员工不再自动试跑', () => {
  it('新建后没有待执行的试跑，也没有唤醒单；时间走过去也不会冒出试跑', async () => {
    const ctx = createTestContext();
    const hub = createHub(ctx);
    await hub.start();
    okData(await hub.api.createBot({ name: '新伙伴', role: 'executor', persona: '先核对再行动', aspirations: ['把交付物准备清楚'] }));
    expect(ctx.store.table('queue').list()).toEqual([]);
    expect(ctx.store.table('wakes').list()).toEqual([]);
    ctx.clock.advance(10 * 60_000);
    await hub.tick();
    expect(ctx.store.table('queue').list(row => row.variant === 'trial')).toEqual([]);
    expect(ctx.store.table('wakes').list(row => row.variant === 'trial')).toEqual([]);
    expect(ctx.host.calls.filter(call => call.method === 'createSession')).toEqual([]);
    await hub.stop();
  });

  it('「待你处理」里没有试跑留下的提议或事项', async () => {
    const ctx = createTestContext();
    const hub = createHub(ctx);
    await hub.start();
    // P73c：启动时中心已自动建了总管（总管最多 1 个），所以这里新增的员工改为执行类；用例要验证的是「新增员工后没有试跑留下的事项」。
    okData(await hub.api.createBot({ name: '新伙伴', role: 'executor', persona: '先对齐再开工', aspirations: ['把事情安排好'] }));
    ctx.clock.advance(10 * 60_000);
    await hub.tick();
    const inbox = await hub.api.inbox();
    expect(inbox.items).toEqual([]);
    expect(ctx.store.table('goals').list(row => row.status === 'proposed')).toEqual([]);
    await hub.stop();
  });

  it('反例：主人对新员工说话，仍然会叫醒它（只是不再自动试跑）', async () => {
    const ctx = createTestContext();
    const hub = createHub(ctx);
    await hub.start();
    const bot = okData(await hub.api.createBot({ name: '新伙伴', role: 'executor', persona: '先核对再行动', aspirations: ['把交付物准备清楚'] }));
    okData(await hub.api.pokeBot(bot.id));
    expect(ctx.store.table('wakes').list().map(row => row.variant)).toEqual(['regular']);
    await hub.stop();
  });
});

describe('H4 对齐时的回复不列举待定项', () => {
  it('守则要求只写有几项要定、确认前不开工，不列举待定项的题目', () => {
    expect(CHIEF_RULES_TEXT).toContain('reply 只写一句结论：有几项需要你定、确认前不会开工');
    expect(CHIEF_RULES_TEXT).toContain('不要列举待定项的题目');
    expect(CHIEF_RULES_TEXT).toContain('卡片里已经有，会自动发给主人');
  });
});

describe('H5 约定固定后的状态文字', () => {
  /** 取主题线程里那条中心旁白的显示文字。 */
  function noteText(fix: Fix, topicId: string): string {
    const rows = threadView(fix.ctx, topicId).messages.filter(row => row.from === 'hub' && row.kind === 'system');
    return rows[0]!.text;
  }

  it('待确认时旁白写「确认前不会开工」；固定后换成「约定已固定」，不再有那句话', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    const topicId = fix.ctx.store.table('agreements').get(id)!.topicId;
    expect(noteText(fix, topicId)).toBe(AGREEMENT_TOPIC_NOTE);
    lockAgreement(fix.ctx, id);
    const locked = noteText(fix, topicId);
    expect(locked).toBe('总管为这件事建立了主题。约定已固定。');
    expect(locked).not.toContain('确认前不会开工');
    // 存储里的原文不改。
    expect(fix.ctx.store.log('thread').all().find(row => row.thread === topicId && row.kind === 'system')!.text).toBe(AGREEMENT_TOPIC_NOTE);
  });

  it('约定撤下后旁白只留事实，不再写「确认前不会开工」', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    const topicId = fix.ctx.store.table('agreements').get(id)!.topicId;
    fix.ctx.store.table('agreements').patch(id, { state: 'withdrawn' });
    expect(noteText(fix, topicId)).toBe('总管为这件事建立了主题。');
  });
});

describe('约定卡待定项编号', () => {
  /** 造一份有三个待定项的约定版本，草图里的 mark 分别指向第 1、2、3 项。 */
  function threeItemAgreement() {
    const content = contentFixture();
    content.pending.push({ key: 'extra', question: '要不要通知', options: ['要', '不要'], suggested: '不要', reason: '先简单', chosen: null });
    content.sketch = { layout: 'page', screens: [{ title: '报价页', blocks: [
      { kind: 'list', text: '报价列表', mark: 1 }, { kind: 'button', text: '刷新', mark: 2 }, { kind: 'note', text: '通知', mark: 3 },
    ] }] } as typeof content.sketch;
    return agreementFixture({ versions: [versionFixture(1, { content })] });
  }

  it('第一项的 index 是 1，最后一项等于待定项总数', async () => {
    const fix = await setup();
    const agreement = threeItemAgreement();
    const card = agreementCardView(fix.ctx, agreement, agreement.versions[0]!);
    expect(card.pending.map(item => item.index)).toEqual([1, 2, 3]);
    expect(card.pending[0]!.index).toBe(1);
    expect(card.pending.at(-1)!.index).toBe(card.pending.length);
  });

  it('草图里带 mark 的元素，mark 值等于所指待定项在卡片视图里的 index', async () => {
    const fix = await setup();
    const agreement = threeItemAgreement();
    const card = agreementCardView(fix.ctx, agreement, agreement.versions[0]!);
    const blocks = (card.sketch.value.screens ?? []).flatMap(screen => screen.blocks);
    const marks = blocks.flatMap(block => (block.mark === undefined ? [] : [block.mark]));
    expect(marks).toEqual([1, 2, 3]);
    // 每个 mark 都能在卡片视图里找到 index 相同的待定项，且指向的是内容里同一位置的那一项。
    marks.forEach((mark, position) => {
      const target = card.pending.find(item => item.index === mark);
      expect(target?.key).toBe(agreement.versions[0]!.content.pending[position]!.key);
    });
  });
});
