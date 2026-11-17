/**
 * P75d 的测试（一）：先例（约定每次固定时，把主人选定的待定项写成先例）。
 * 走真实的 Hub：约定经总管工具提交，主人用「定了」、按钮、待你处理、DSH 直聊固定；
 * 小改动（amend）和主人选办法生成的新版本，用服务函数直接触发同一个收尾（onAgreementLocked）。
 */
import { describe, expect, it, vi } from 'vitest';
import { flushJobHooks, onAgreementLocked } from '../src/job/agreement-hooks.js';
import { applyOwnerOptionVersion } from '../src/job/option-version.js';
import { writePrecedents } from '../src/memory/precedents.js';
import { agentsMdOf, bot, callTool, jobFix, memoriesOf, ownerSays, speak, type JobFix } from './p75c-fixtures.js';
import { chiefDraftsAnother } from './p74b-fixtures.js';

/** 总管起草一份约定并交账（待主人确认），返回约定编号。 */
async function draft(fix: JobFix, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  await ownerSays(fix, fix.chief.id, `帮我做${title}`);
  const id = await chiefDraftsAnother(fix, title, { category: '表单页', ...extra });
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  return id;
}

/** 当前生效的先例，按待定项 key 排序。 */
function precedents(fix: JobFix, agreementId: string, status = 'active') {
  return memoriesOf(fix.ctx).filter(row => row.kind === 'precedent' && row.source.agreementId === agreementId && row.status === status)
    .sort((a, b) => (a.source.pendingKey ?? '').localeCompare(b.source.pendingKey ?? ''));
}

const TEXTS = ['多久刷新一次：每天', '报价从哪里取：公开接口'];

describe('四条固定途径都写先例', () => {
  it('「定了」（打字）：每个待定项一条先例，字段齐全', async () => {
    const fix = await jobFix();
    const id = await draft(fix, '报价页甲');
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    const rows = precedents(fix, id);
    expect(rows.map(row => row.text)).toEqual(TEXTS);
    const version = fix.ctx.store.table('agreements').get(id)!.versions[0]!;
    expect(rows[0]).toMatchObject({ kind: 'precedent', category: '表单页', scope: { staff: 'all', projects: 'all' }, redLine: false,
      source: { kind: 'agreement', agreementId: id, versionNo: 1, pendingKey: 'refresh', messageIds: [version.confirmMessageId], quote: TEXTS[0] } });
  });

  it('卡片按钮、待你处理、DSH 直聊各固定一份约定，都写出先例', async () => {
    const fix = await jobFix();
    const a = await draft(fix, '报价页乙');
    await fix.hub.api.confirmAgreement({ agreementId: a, version: 1 });
    await flushJobHooks(fix.ctx);
    expect(precedents(fix, a)).toHaveLength(2);
    const b = await draft(fix, '报价页丙');
    const item = fix.ctx.store.table('inbox').list(row => row.subjectKey === `agreement:${b}:1`)[0]!;
    expect(await fix.hub.api.answerInbox(item.id, '按建议，定了')).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(precedents(fix, b)).toHaveLength(2);
    const c = await draft(fix, '报价页丁');
    await fix.hub.onTurnEvent({ type: 'owner_direct', sessionId: fix.chief.sessionId!, at: fix.ctx.clock.now(), text: '定了' });
    await flushJobHooks(fix.ctx);
    expect(precedents(fix, c)).toHaveLength(2);
  });

  it('小改动生效（amend）与选办法生成的新版本：都到达同一个收尾（先清掉先例，再看是否按新版本写回）', async () => {
    const fix = await jobFix();
    const id = await draft(fix, '报价页戊');
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    // amend：先把先例清掉，证明 amend 的固定也会写。
    for (const row of precedents(fix, id)) fix.ctx.store.table('memories').remove(row.id);
    await speak(fix, fix.chief, '约定已固定，交付时间见卡片。', { outcome: 'progress' }); // 结束「定了」叫醒的那一回合
    await ownerSays(fix, fix.chief.id, '一句话改准确些');
    const amended = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'amend', agreementId: id, changeNote: '一句话改准确', summary: '做一个能查看每日报价的小页面，含手动刷新' });
    expect(amended, JSON.stringify(amended)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '已改好', { outcome: 'progress' });
    await flushJobHooks(fix.ctx);
    expect(precedents(fix, id).map(row => row.source.versionNo)).toEqual([2, 2]);
    // 选办法：同样先清掉，再由选办法生成第 3 版。
    for (const row of precedents(fix, id)) fix.ctx.store.table('memories').remove(row.id);
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const made = applyOwnerOptionVersion(fix.ctx, agreement, { change: { kind: 'append_done', text: '接口失败时页面保留上次数据' } as never, title: '保留上次数据', messageId: 'm_0000000099', thread: fix.chief.id, now: fix.ctx.clock.now() });
    onAgreementLocked(fix.ctx, id, made.version.no, 'option');
    await flushJobHooks(fix.ctx);
    expect(precedents(fix, id).map(row => row.source.versionNo)).toEqual([made.version.no, made.version.no]);
  });
});

describe('版本更替、去重、容错', () => {
  it('第二次固定同一份约定：改了的待定项写新先例、旧的变为已取代；没改的沿用；重复调用不重复写', async () => {
    const fix = await jobFix();
    const id = await draft(fix, '报价页己');
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    const first = precedents(fix, id);
    await speak(fix, fix.chief, '约定已固定，交付时间见卡片。', { outcome: 'progress' }); // 结束「定了」叫醒的那一回合
    await ownerSays(fix, fix.chief.id, '再改一下');
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId: id, changeNote: '改一句话', summary: '做一个每日报价小页面' });
    expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '改好了', { outcome: 'needs_owner' });
    await fix.hub.api.confirmAgreement({ agreementId: id, version: 2, choices: { refresh: '每小时' } });
    await flushJobHooks(fix.ctx);
    const active = precedents(fix, id);
    expect(active.map(row => row.text)).toEqual(['多久刷新一次：每小时', '报价从哪里取：公开接口']);
    expect(active.map(row => row.source.versionNo)).toEqual([2, 1]);
    const replaced = precedents(fix, id, 'replaced');
    expect(replaced.map(row => row.id)).toEqual([first.find(row => row.source.pendingKey === 'refresh')!.id]);
    // 重复调用：不再多写、状态不变。
    const before = memoriesOf(fix.ctx).length;
    onAgreementLocked(fix.ctx, id, 2, 'confirm');
    expect(await writePrecedents(fix.ctx, id, 2)).toBe(0);
    await flushJobHooks(fix.ctx);
    expect(memoriesOf(fix.ctx)).toHaveLength(before);
  });

  it('写先例抛错时约定照常固定，只记日志', async () => {
    const fix = await jobFix();
    const id = await draft(fix, '报价页庚');
    const original = fix.ctx.store.table.bind(fix.ctx.store);
    // 让 memories 表一写就抛错：模拟存储故障。
    (fix.ctx.store as unknown as { table: unknown }).table = (name: string) => {
      const table = (original as unknown as (n: string) => Record<string, unknown>)(name);
      if (name !== 'memories') return table;
      return new Proxy(table, { get: (target, key) => (key === 'put' ? () => { throw new Error('存储故障'); } : (target[key as string] as { bind?: (t: unknown) => unknown }).bind?.(target) ?? target[key as string]) });
    };
    const warn = vi.spyOn(fix.ctx.logger, 'warn');
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    expect(fix.ctx.store.table('agreements').get(id)!.state).toBe('locked');
    expect(warn.mock.calls.some(call => String(call[0]).includes('先例'))).toBe(true);
  });

  it('先例的文字含内部名称时这一条不写（不把内部名称带到主人面前）', async () => {
    const fix = await jobFix();
    const id = await draft(fix, '报价页辛');
    // 改存储里的待定项选项文字，造出含工具名的选定项。
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const version = agreement.versions[0]!;
    fix.ctx.store.table('agreements').put({ ...agreement, versions: [{ ...version, content: { ...version.content,
      pending: version.content.pending.map(item => (item.key === 'source' ? { ...item, options: ['hub_send 接口', '手工表格'], suggested: 'hub_send 接口' } : item)) } }] });
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    expect(precedents(fix, id).map(row => row.text)).toEqual(['多久刷新一次：每天']);
  });
});

describe('先例不刷新身份文件', () => {
  it('固定约定写先例前后，身份文件写入次数不变，文件里也没有先例文字', async () => {
    const fix = await jobFix();
    const id = await draft(fix, '报价页壬');
    const writes = vi.spyOn(fix.ctx.fs, 'writeTextAtomic');
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    expect(precedents(fix, id)).toHaveLength(2);
    expect(writes.mock.calls.filter(call => String(call[0]).endsWith('AGENTS.md'))).toHaveLength(0);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.chief.id))).not.toContain('报价从哪里取');
  });
});
