/**
 * P72c 约定视图测试：约定卡（改动标记、依据标签、状态）、主题第一层面板、收件箱标识、默契度。
 * 视图是只读投影，所以这里直接往表里放样例约定，再看投影出的字段。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { botCard } from '../src/api/summary-views.js';
import { inboxView, threadView } from '../src/api/feed-views.js';
import { AgreementSchema, type Agreement, type AgreementContent, type AgreementVersion } from '../src/model/agreement.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { postThread } from '../src/outreach/thread.js';
import { openTopic, setup, type Fix } from './p72b-fixtures.js';
import { agreementFixture, contentFixture, versionFixture } from './p72a-agreement-fixtures.js';

/** 把约定校验后写进表，顺便确认样例本身合法。 */
function put(fix: Fix, patch: Partial<Agreement>): Agreement {
  const agreement = AgreementSchema.parse(agreementFixture({ botId: fix.chief.id, originThread: fix.chief.id, ...patch }));
  fix.ctx.store.table('agreements').put(agreement);
  return agreement;
}

/** 第 2 版内容：refresh 的建议改了，多了一个新待定项 extra。 */
function secondContent(): AgreementContent {
  const content = contentFixture();
  content.pending[1] = { ...content.pending[1]!, suggested: '每小时' };
  content.pending.push({ key: 'extra', question: '要不要加导出', options: ['要', '不要'], suggested: '不要', reason: '先做最小的', chosen: null });
  content.doneWhen = [...content.doneWhen, '页面在手机上能看'];
  return content;
}

describe('约定卡视图：改动标记与状态', () => {
  it('第 2 版：改过的待定项 changed、新加的 added、没改的都是 false；第 1 版 superseded、不能确认、被第 2 版取代', async () => {
    const fix = await setup();
    const agreement = put(fix, { versions: [
      versionFixture(1, { state: 'superseded', cardMessageId: 'm_aaaaaaaaaa' }),
      versionFixture(2, { content: secondContent(), cardMessageId: 'm_bbbbbbbbbb', changeNote: '改了刷新频率，加了导出',
        changes: [{ section: 'pending', kind: 'changed', key: 'refresh' }, { section: 'pending', kind: 'added', key: 'extra' },
          { section: 'doneWhen', kind: 'added', index: 3 }, { section: 'summary', kind: 'changed' }] }),
    ] });
    const v2 = agreementCardView(fix.ctx, agreement, agreement.versions[1]!);
    expect(v2.pending.map(item => [item.key, item.changed, item.added])).toEqual([['source', false, false], ['refresh', true, false], ['extra', false, true]]);
    expect(v2.doneWhen.map(row => row.changed)).toEqual([false, false, false, true]);
    expect(v2.scopeIn.every(row => !row.changed)).toBe(true);
    expect(v2.summary.changed).toBe(true);
    expect(v2.sketch.changed).toBe(false);
    expect(v2).toMatchObject({ versionNo: 2, latestNo: 2, state: 'pending', canConfirm: true, supersededBy: null, changeNote: '改了刷新频率，加了导出' });
    const v1 = agreementCardView(fix.ctx, agreement, agreement.versions[0]!);
    expect(v1).toMatchObject({ state: 'superseded', canConfirm: false, supersededBy: 2, versionNo: 1, latestNo: 2 });
    expect(v1.pending.every(item => !item.changed && !item.added)).toBe(true);
    expect(v1.summary.changed).toBe(false);
  });

  it('卡片还没落楼（cardMessageId 为空）时不能确认', async () => {
    const fix = await setup();
    const agreement = put(fix, { versions: [versionFixture(1)] });
    expect(agreementCardView(fix.ctx, agreement, agreement.versions[0]!).canConfirm).toBe(false);
  });

  it('依据标签：规矩、项目决定、通行做法、需要试过、我的判断；来源文字', async () => {
    const fix = await setup();
    const content = contentFixture();
    content.decided = [
      { text: '对外文字先审', basis: { kind: 'source', ref: 'ru_0000000001', refText: '所有对外文字先给主人看' } },
      { text: '周报周五发', basis: { kind: 'source', ref: 'dc_0000000001', refText: '周报每周五发' } },
      { text: '用常见的表格库', basis: { kind: 'convention', ref: null, refText: null } },
      { text: '刷新频率先试试', basis: { kind: 'trial', ref: null, refText: null } },
      { text: '只做网页', basis: { kind: 'judgement', ref: null, refText: null } },
    ];
    const agreement = put(fix, { versions: [versionFixture(1, { content, cardMessageId: 'm_aaaaaaaaaa' })] });
    const view = agreementCardView(fix.ctx, agreement, agreement.versions[0]!);
    expect(view.decided.map(row => row.basisLabel)).toEqual([
      '依据：你定过的规矩「所有对外文字先给主人看」', '依据：项目决定「周报每周五发」', '依据：通行做法', '依据：需要试过才知道', '依据：我的判断']);
    expect(view.sourceLabel).toBe('来源：你在总管私聊里的要求');
  });

  it('来源文字：对齐时的修改、主题里的指示与私聊里的指示、重新确认', async () => {
    const fix = await setup();
    const topicId = 'ptp_0000000001';
    const make = (source: AgreementVersion['source'], sourceThread: string | null) => {
      const agreement = put(fix, { topicId, versions: [versionFixture(1, { source, sourceThread })] });
      return agreementCardView(fix.ctx, agreement, agreement.versions[0]!).sourceLabel;
    };
    expect(make('owner_revision', fix.chief.id)).toBe('来源：你在对齐时的修改');
    expect(make('owner_instruction', topicId)).toBe('来源：你在主题里的指示');
    expect(make('owner_instruction', fix.chief.id)).toBe('来源：你在总管私聊里的指示');
    expect(make('owner_reopen', fix.chief.id)).toBe('来源：你的修改，已重新请你确认');
  });
});

describe('线程与主题视图', () => {
  it('线程里的约定卡消息带 agreement；找不到版本时为 null；其他类别不带这个字段', async () => {
    const fix = await setup();
    const card = postThread(fix.ctx, { thread: fix.chief.id, from: fix.chief.id, kind: 'agreement', text: '约定「每日报价页」第 1 版', refId: 'agr_0000000001' });
    const orphan = postThread(fix.ctx, { thread: fix.chief.id, from: fix.chief.id, kind: 'agreement', text: '约定「别的」第 1 版', refId: 'agr_0000000009' });
    const chat = postThread(fix.ctx, { thread: fix.chief.id, from: 'owner', kind: 'chat', text: '你好' });
    put(fix, { versions: [versionFixture(1, { cardMessageId: card.id })] });
    const messages = threadView(fix.ctx, fix.chief.id).messages;
    const byId = (id: string) => messages.find(row => row.id === id)!;
    expect(byId(card.id).kind).toBe('agreement');
    expect(byId(card.id).agreement).toMatchObject({ agreementId: 'agr_0000000001', versionNo: 1, canConfirm: true });
    expect(byId(orphan.id).agreement).toBeNull();
    expect('agreement' in byId(chat.id)).toBe(false);
  });

  it('主题线程视图带 agreement：已固定取固定版，修订从新到旧、来源正确；没有约定的主题不带', async () => {
    const fix = await setup();
    const topicId = await openTopic(fix, '随便聊聊');
    const other = await openTopic(fix, '另一个话题');
    put(fix, { topicId, state: 'locked', versions: [
      versionFixture(1, { state: 'replaced', lockedAt: 2000, lockedVia: 'button' }),
      versionFixture(2, { state: 'locked', source: 'owner_instruction', sourceThread: topicId, changeNote: '加一条验收',
        lockedAt: 3000, lockedVia: 'amend', content: secondContent() }),
    ] });
    const panel = threadView(fix.ctx, topicId).agreement!;
    expect(panel.current).toMatchObject({ versionNo: 2, state: 'locked', agreementState: 'locked', canConfirm: false });
    expect(panel.revisionCount).toBe(1);
    expect(panel.revisions.map(row => [row.no, row.text, row.sourceLabel, row.locked])).toEqual([
      [2, '加一条验收', '来源：你在主题里的指示', true], [1, '初稿', '来源：你在总管私聊里的要求', false]]);
    expect(threadView(fix.ctx, other).agreement ?? null).toBeNull();
    expect('agreement' in threadView(fix.ctx, other)).toBe(false);
  });

  it('待确认的约定：当前版本取最新版；第 1 版未固定就被取代时修订行写「初稿，未固定」', async () => {
    const fix = await setup();
    const topicId = await openTopic(fix, '随便聊聊');
    put(fix, { topicId, versions: [versionFixture(1, { state: 'superseded' }), versionFixture(2, { source: 'owner_revision', changeNote: '改了频率' })] });
    const panel = threadView(fix.ctx, topicId).agreement!;
    expect(panel.current.versionNo).toBe(2);
    expect(panel.revisions.map(row => row.text)).toEqual(['改了频率', '初稿，未固定']);
  });
});

describe('收件箱视图', () => {
  it('约定条目带 agreementId 与版本号，普通提问不带', async () => {
    const fix = await setup();
    createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '约定第 3 版待你确认', body: 'x', subjectKey: 'agreement:agr_0000000001:3',
      options: ['按建议，定了'], defaultOption: null, expiresAt: null });
    createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '普通提问', body: 'y', subjectKey: 'ask:1', options: ['好', '不好'], defaultOption: '好' });
    const items = inboxView(fix.ctx).items;
    const agreementItem = items.find(row => row.title.startsWith('约定'))!;
    const plain = items.find(row => row.title === '普通提问')!;
    expect(agreementItem).toMatchObject({ agreementId: 'agr_0000000001', agreementVersion: 3 });
    expect('agreementId' in plain).toBe(false);
    expect('agreementVersion' in plain).toBe(false);
  });
});

describe('默契度', () => {
  it('总管确认过一次（3 / 4）：员工卡片带「默契度 3 / 4」；非总管没有；没确认过的总管没有', async () => {
    const fix = await setup();
    const bot = (id: string) => fix.ctx.store.table('bots').get(id)!;
    expect(botCard(fix.ctx, bot(fix.chief.id)).rapport ?? null).toBeNull();
    put(fix, { state: 'locked', versions: [versionFixture(1, { state: 'locked', lockedAt: 2000, lockedVia: 'button', adoption: { adopted: 3, total: 4 } })] });
    expect(botCard(fix.ctx, bot(fix.chief.id)).rapport).toEqual({ adopted: 3, total: 4, text: '默契度 3 / 4' });
    expect(botCard(fix.ctx, bot(fix.wang.id)).rapport ?? null).toBeNull();
    expect('rapport' in botCard(fix.ctx, bot(fix.wang.id))).toBe(false);
  });

  it('两项都为 0 时不显示；固定后的卡片视图 adoption 为 3 / 4，rapport 为累计值', async () => {
    const fix = await setup();
    const bot = fix.ctx.store.table('bots').get(fix.chief.id)!;
    put(fix, { id: 'agr_0000000002', state: 'locked', versions: [versionFixture(1, { state: 'locked', lockedAt: 2000, lockedVia: 'button', adoption: { adopted: 0, total: 0 } })] });
    expect(botCard(fix.ctx, bot).rapport ?? null).toBeNull();
    const agreement = put(fix, { state: 'locked', versions: [versionFixture(1, { state: 'locked', lockedAt: 2000, lockedVia: 'button', adoption: { adopted: 3, total: 4 } })] });
    put(fix, { id: 'agr_0000000003', topicId: 'ptp_0000000003', state: 'locked', versions: [versionFixture(1, { state: 'locked', lockedAt: 2000, lockedVia: 'text', adoption: { adopted: 1, total: 1 } })] });
    const view = agreementCardView(fix.ctx, agreement, agreement.versions[0]!);
    expect(view.adoption).toEqual({ adopted: 3, total: 4 });
    expect(view.rapport).toEqual({ adopted: 4, total: 5 });
    expect(botCard(fix.ctx, bot).rapport!.text).toBe('默契度 4 / 5');
    // 没有 adoption 的版本不带 rapport。
    const plain = put(fix, { id: 'agr_0000000004', topicId: 'ptp_0000000004' });
    expect(agreementCardView(fix.ctx, plain, plain.versions[0]!).rapport).toBeNull();
  });
});
