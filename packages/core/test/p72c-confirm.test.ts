/**
 * P72c 「定了」三条途径的测试：口令识别、打字、卡片按钮、待你处理。
 * 都走真实 Hub（假宿主），这样测到的是真实的接线：落楼顺序、唤醒数量、收件箱状态。
 */
import { describe, expect, it } from 'vitest';
import { confirmByText, isConfirmPhrase, normalizeConfirmText } from '../src/project/agreement-confirm.js';
import { floors, ownerSays, callTool, chiefDrafts, chiefReplies, setup, speak, openTopic, type Fix } from './p72b-fixtures.js';

const TITLE = '每日报价页';
const MORE_DONE = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '页面在手机上能看'];

/** 总管提交新约定并交账（卡片落楼），返回约定 id。 */
async function draftAndCommit(fix: Fix): Promise<string> {
  const id = await chiefDrafts(fix);
  await speak(fix, fix.chief, '已记下，请看卡片');
  return id;
}

/** 主人再说一句，总管出修订版并交账。 */
async function reviseAndCommit(fix: Fix, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await ownerSays(fix, fix.chief.id, '再改一下');
  const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '加一条验收', doneWhen: MORE_DONE, ...extra });
  expect(result).toMatchObject({ ok: true });
  await speak(fix, fix.chief, '改好了');
}

/** 该总管已有的唤醒单加排队中的候选总数，用来数「叫醒了几次」。 */
function wakeCount(fix: Fix): number {
  const id = fix.chief.id;
  return fix.ctx.store.table('wakes').count(row => row.botId === id) + fix.ctx.store.table('queue').count(row => row.botId === id);
}

const agreementOf = (fix: Fix, id: string) => fix.ctx.store.table('agreements').get(id)!;

describe('口令识别', () => {
  it('整句口令识别（含空白、标点、大小写、全角）', () => {
    for (const text of ['定了', '定了。', ' 按建议，定了 ', 'OK，定了', 'ＯＫ定了', '就这么定了！', '确认']) {
      expect(isConfirmPhrase(text), text).toBe(true);
    }
  });
  it('带别的内容的句子不识别', () => {
    for (const text of ['定了，但把邮箱加上', '定了吗', '先别定', '不定了', '我们定了个规矩', '', '。。。']) {
      expect(isConfirmPhrase(text), text).toBe(false);
    }
  });
  it('规范化去掉空白和标点并转小写', () => {
    expect(normalizeConfirmText(' O K，定 了。')).toBe('ok定了');
  });
});

describe('打字途径', () => {
  it('私聊里对已发卡的 pending 约定打「定了」：固定、两处旁白、条目已回答、总管只多一次唤醒', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const inboxId = agreementOf(fix, id).inboxId!;
    const before = wakeCount(fix);
    await ownerSays(fix, fix.chief.id, '定了');
    const agreement = agreementOf(fix, id);
    const version = agreement.versions[0]!;
    expect(agreement.state).toBe('locked');
    expect(version).toMatchObject({ state: 'locked', lockedVia: 'text' });
    const ownerMessage = floors(fix.ctx, fix.chief.id).filter(row => row.from === 'owner' && row.text === '定了').at(-1)!;
    expect(version.confirmMessageId).toBe(ownerMessage.id);
    expect(chiefReplies(fix.ctx, fix.chief.id).some(row => row.text === `约定第 1 版已固定，挂在主题「${TITLE}」上。`)).toBe(true);
    expect(floors(fix.ctx, agreement.topicId).some(row => row.text === '约定第 1 版已固定。')).toBe(true);
    expect(fix.ctx.store.table('inbox').get(inboxId)).toMatchObject({ status: 'answered', answer: '定了' });
    expect(agreement.inboxId).toBeNull();
    expect(wakeCount(fix) - before).toBe(1);
  });

  it('「定了，但把邮箱加上」不固定，总管照常被叫醒', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const before = wakeCount(fix);
    await ownerSays(fix, fix.chief.id, '定了，但把邮箱加上');
    expect(agreementOf(fix, id).state).toBe('pending');
    expect(wakeCount(fix) - before).toBe(1);
  });

  it('没有 pending 约定时打「定了」：什么都不固定，消息照常交给总管', async () => {
    const fix = await setup();
    const before = wakeCount(fix);
    await ownerSays(fix, fix.chief.id, '定了');
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
    expect(floors(fix.ctx, fix.chief.id).filter(row => row.from === 'hub')).toHaveLength(0);
    expect(wakeCount(fix) - before).toBe(1);
  });

  it('新版本已生成但卡片还没落楼时打「定了」：不固定', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    await ownerSays(fix, fix.chief.id, '再改一下');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '加一条验收', doneWhen: MORE_DONE });
    expect(result).toMatchObject({ ok: true });
    expect(agreementOf(fix, id).versions[1]!.cardMessageId).toBeNull();
    await ownerSays(fix, fix.chief.id, '定了');
    expect(agreementOf(fix, id).state).toBe('pending');
    expect(agreementOf(fix, id).versions[1]!.state).toBe('pending');
  });

  it('在约定所在主题里打「定了」固定；在别的主题里不固定', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const other = await openTopic(fix, '另一个话题');
    await ownerSays(fix, other, '定了');
    expect(agreementOf(fix, id).state).toBe('pending');
    await ownerSays(fix, agreementOf(fix, id).topicId, '定了');
    expect(agreementOf(fix, id)).toMatchObject({ state: 'locked' });
    expect(agreementOf(fix, id).versions[0]!.lockedVia).toBe('text');
  });

  it('执行风格员工的私聊里打「定了」：不固定任何约定', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    await ownerSays(fix, fix.wang.id, '定了');
    expect(agreementOf(fix, id).state).toBe('pending');
  });

  it('主人早于卡片说的「定了」不算：消息时间早于卡片落楼时不固定，同时刻或更晚才固定', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const cardId = agreementOf(fix, id).versions[0]!.cardMessageId!;
    const card = fix.ctx.store.log('thread').all().find(row => row.id === cardId)!;
    const message = { ...card, id: 'm_zzzzzzzzzz', from: 'owner', kind: 'chat' as const, text: '定了', refId: null };
    // 直接调用识别函数：造一条比卡片早 1 毫秒的主人消息。
    expect(confirmByText(fix.ctx, fix.chief.id, { ...message, createdAt: card.createdAt - 1 })).toBe(false);
    expect(agreementOf(fix, id).state).toBe('pending');
    expect(confirmByText(fix.ctx, fix.chief.id, { ...message, createdAt: card.createdAt })).toBe(true);
    expect(agreementOf(fix, id).state).toBe('locked');
  });

  it('识别过程出任何异常都返回 false，不抛出', async () => {
    const fix = await setup();
    await draftAndCommit(fix);
    // 故意让存储读取抛错，确认不会让主人发消息失败。
    const broken = { ...fix.ctx, store: { ...fix.ctx.store, table: () => { throw new Error('存储坏了'); } } } as unknown as typeof fix.ctx;
    const message = floors(fix.ctx, fix.chief.id).find(row => row.from !== 'owner')!;
    expect(confirmByText(broken, fix.chief.id, { ...message, text: '定了' })).toBe(false);
  });
});

describe('卡片按钮途径', () => {
  it('用最新版本号确认：固定、私聊依次出现主人「定了」和旁白、总管被叫醒一次', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const before = wakeCount(fix);
    const sizeBefore = floors(fix.ctx, fix.chief.id).length;
    const result = await fix.hub.api.confirmAgreement({ agreementId: id, version: 1 });
    expect(result).toEqual({ ok: true, data: { agreementId: id, version: 1 } });
    const agreement = agreementOf(fix, id);
    expect(agreement.versions[0]).toMatchObject({ state: 'locked', lockedVia: 'button' });
    const added = floors(fix.ctx, fix.chief.id).slice(sizeBefore);
    expect(added.slice(0, 2).map(row => [row.from, row.text])).toEqual([['owner', '定了'], ['hub', `约定第 1 版已固定，挂在主题「${TITLE}」上。`]]);
    expect(added[0]).toMatchObject({ kind: 'chat', refId: id });
    expect(agreement.versions[0]!.confirmMessageId).toBe(added[0]!.id);
    expect(wakeCount(fix) - before).toBe(1);
  });

  it('用旧版本号：报「已被第 N 版取代」，线程里没有新增主人消息', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    await reviseAndCommit(fix, id);
    const sizeBefore = floors(fix.ctx, fix.chief.id).length;
    const result = await fix.hub.api.confirmAgreement({ agreementId: id, version: 1 });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('已被第 2 版取代');
    expect(floors(fix.ctx, fix.chief.id)).toHaveLength(sizeBefore);
    expect(agreementOf(fix, id).state).toBe('pending');
  });

  it('改选非建议项：chosen 是所选项，默契度不算采纳；不存在的 key 报错且无任何写入', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const sizeBefore = floors(fix.ctx, fix.chief.id).length;
    const bad = await fix.hub.api.confirmAgreement({ agreementId: id, version: 1, choices: { nokey: '公开接口' } });
    expect(bad).toMatchObject({ ok: false });
    expect(floors(fix.ctx, fix.chief.id)).toHaveLength(sizeBefore);
    expect(agreementOf(fix, id).state).toBe('pending');
    const ok = await fix.hub.api.confirmAgreement({ agreementId: id, version: 1, choices: { refresh: '每小时' } });
    expect(ok.ok).toBe(true);
    const version = agreementOf(fix, id).versions[0]!;
    expect(version.content.pending.find(item => item.key === 'refresh')!.chosen).toBe('每小时');
    expect(version.content.pending.find(item => item.key === 'source')!.chosen).toBe('公开接口');
    expect(version.adoption).toEqual({ adopted: 1, total: 2 });
  });

  it('已固定的约定再确认：返回「约定已经固定」；入参错误报中文', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    expect((await fix.hub.api.confirmAgreement({ agreementId: id, version: 1 })).ok).toBe(true);
    const again = await fix.hub.api.confirmAgreement({ agreementId: id, version: 1 });
    expect(again).toMatchObject({ ok: false });
    expect((again as { error: string }).error).toContain('约定已经固定');
    const wrong = await fix.hub.api.confirmAgreement({ agreementId: 'agr_0000000000', version: 1 });
    expect((wrong as { error: string }).error).toContain('约定不存在');
    const bad = await fix.hub.api.confirmAgreement({ agreementId: id, version: 0 });
    expect(bad.ok).toBe(false);
  });
});

describe('待你处理途径', () => {
  it('回答「按建议，定了」：固定、via inbox、条目 answered、总管被叫醒，没有通用的回答消息', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const inboxId = agreementOf(fix, id).inboxId!;
    const before = wakeCount(fix);
    const result = await fix.hub.api.answerInbox(inboxId, ' 按建议，定了 ');
    expect(result.ok).toBe(true);
    const agreement = agreementOf(fix, id);
    expect(agreement.versions[0]).toMatchObject({ state: 'locked', lockedVia: 'inbox' });
    expect(fix.ctx.store.table('inbox').get(inboxId)).toMatchObject({ status: 'answered', answer: '按建议，定了' });
    expect(wakeCount(fix) - before).toBe(1);
    const texts = floors(fix.ctx, fix.chief.id).map(row => row.text);
    expect(texts.some(text => text.includes('：按建议，定了'))).toBe(false);
    expect(texts).toContain('定了');
  });

  it('回答其他文字：报错，约定仍 pending、条目仍 open', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const inboxId = agreementOf(fix, id).inboxId!;
    const result = await fix.hub.api.answerInbox(inboxId, '把邮箱加上');
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('只能按建议确认');
    expect(agreementOf(fix, id).state).toBe('pending');
    expect(fix.ctx.store.table('inbox').get(inboxId)!.status).toBe('open');
  });

  it('第 1 版的条目在出第 2 版后已撤回，再回答报「事项不存在或已处理」', async () => {
    const fix = await setup();
    const id = await draftAndCommit(fix);
    const first = agreementOf(fix, id).inboxId!;
    await reviseAndCommit(fix, id);
    const result = await fix.hub.api.answerInbox(first, '按建议，定了');
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain('事项不存在或已处理');
    expect(agreementOf(fix, id).state).toBe('pending');
  });
});
