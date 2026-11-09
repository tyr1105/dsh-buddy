/** C03 记忆与套路验收：真实内存文件读回，验证保护恢复、文件协议、有限摘要和教学证据。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture, goalFixture, watchFixture, modelFixtures, id } from './model-fixtures.js';
import { createBotHome, initRoot, refreshBotFiles, verifyProtectedFiles, appendJournal, readMemorySummary } from '../src/memory/files.js';
import { renderBotAgentsMd, renderRootAgentsMd } from '../src/memory/render.js';
import { upsertRule } from '../src/memory/rules.js';
import { needsRotation } from '../src/memory/rotation.js';
import { saveRoutine, editRoutine, routineIndex } from '../src/routines/save.js';
import { enqueueTeach } from '../src/routines/teach.js';
import { CommitSchema, WakeTicketSchema } from '../src/model/wake.js';
import { AgendaItemSchema } from '../src/model/bot.js';
import { byteLength } from '../src/util/text.js';
import { resolveSettings } from '../src/config/defaults.js';

function context() {
  const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() }); return ctx;
}
const routine = { name: '事实核对', whenToUse: '遇到公开资料变化', steps: ['打开原文', '逐条核对'], learnedFrom: '主人教学' };

describe('家目录与身份', () => {
  it('初始化根目录且不建.git', async () => {
    const ctx = context(); await initRoot(ctx);
    for (const path of ['/hub/bots', '/hub/shared/handoffs', '/hub/.hub']) expect((await ctx.fs.stat(path))?.isDir).toBe(true);
    expect(await ctx.fs.readText('/hub/AGENTS.md')).toContain('全体守则'); expect(await ctx.fs.stat('/hub/.git')).toBeNull();
  });
  it('生成全套家目录、身份、mind与初始记忆', async () => {
    const ctx = context(); await createBotHome(ctx, botFixture);
    for (const path of ['mind', 'memory/journal', 'playbooks', '.agents/skills', 'work']) expect((await ctx.fs.stat(`${botFixture.homeDir}/${path}`))?.isDir).toBe(true);
    for (const path of ['AGENTS.md', 'mind/goals.md', 'mind/agenda.md', 'mind/watches.md', 'memory/MEMORY.md']) expect(await ctx.fs.readText(`${botFixture.homeDir}/${path}`)).not.toBeNull();
  });
  it('重复建家不会覆盖长期记忆', async () => {
    const ctx = context(); await createBotHome(ctx, botFixture); await ctx.fs.writeTextAtomic(`${botFixture.homeDir}/memory/MEMORY.md`, '重要事实'); await createBotHome(ctx, botFixture);
    expect(await ctx.fs.readText(`${botFixture.homeDir}/memory/MEMORY.md`)).toBe('重要事实');
  });
  it('机器人身份包含身份、性格、志向、协议、工具和只读边界', () => {
    const ctx = context(); ctx.store.table('aspirations').put({ id: id('asp'), botId: botFixture.id, text: '持续理解公开事实', status: 'active', approved: true, createdBy: 'owner', createdAt: ctx.clock.now() });
    const text = renderBotAgentsMd(ctx, botFixture);
    for (const expected of ['研究员', '先核实再给结论', '持续理解公开事实', 'hub_commit', 'hub_send', 'mind/', 'memory/journal/', '一条消息只问一件事']) expect(text).toContain(expected);
  });
  it('试岗明确强制L1，不展示原L3作为有效授权', () => { expect(renderBotAgentsMd(context(), { ...botFixture, lifecycle: 'probation', autonomy: 'L3' })).toContain('L1 建议（试岗强制 L1）'); });
  it('长规则下机器人8KB、全体3KB仍保留固定协议', () => {
    const ctx = context(); ctx.store.table('rules').put({ id: id('ru'), scope: 'global', text: '全体长规则'.repeat(3000), redLine: true, source: 'owner', status: 'active', createdAt: ctx.clock.now() });
    expect(byteLength(renderBotAgentsMd(ctx, botFixture))).toBeLessThanOrEqual(8192); expect(byteLength(renderRootAgentsMd(ctx))).toBeLessThanOrEqual(3072);
    expect(renderBotAgentsMd(ctx, botFixture)).toContain('hub_commit'); expect(renderRootAgentsMd(ctx)).toContain('不可逆');
  });
  it('可覆盖较小输出预算', () => {
    const ctx = context(); ctx.settings = resolveSettings({ rootDir: '/hub', botAgentsMaxBytes: 3000, globalRulesMaxBytes: 1500 });
    expect(byteLength(renderBotAgentsMd(ctx, botFixture))).toBeLessThanOrEqual(3000); expect(byteLength(renderRootAgentsMd(ctx))).toBeLessThanOrEqual(1500);
  });
  it('mind 三个视图读回包含真实结构化内容', async () => {
    const ctx = context(); ctx.store.table('goals').put(goalFixture); ctx.store.table('watches').put(watchFixture); ctx.store.table('agenda').put(AgendaItemSchema.parse(modelFixtures.AgendaItem.valid));
    await refreshBotFiles(ctx, botFixture.id);
    expect(await ctx.fs.readText(`${botFixture.homeDir}/mind/goals.md`)).toContain(goalFixture.doneWhen);
    expect(await ctx.fs.readText(`${botFixture.homeDir}/mind/agenda.md`)).toContain('资料撤回'); expect(await ctx.fs.readText(`${botFixture.homeDir}/mind/watches.md`)).toContain(watchFixture.target);
  });
  it('合法数据更新刷新不会计越界', async () => {
    const ctx = context(); await createBotHome(ctx, botFixture); ctx.store.table('goals').put(goalFixture); await refreshBotFiles(ctx, botFixture.id);
    expect(ctx.store.table('bots').get(botFixture.id)?.violations).toBe(0); expect(await verifyProtectedFiles(ctx, botFixture.id)).toEqual([]);
  });
  it('并发中心刷新与核验不会误报合法写入', async () => {
    const ctx = context(); await createBotHome(ctx, botFixture); ctx.store.table('goals').put(goalFixture);
    await Promise.all([refreshBotFiles(ctx, botFixture.id), verifyProtectedFiles(ctx, botFixture.id), refreshBotFiles(ctx, botFixture.id)]);
    expect(ctx.store.table('bots').get(botFixture.id)?.violations).toBe(0); expect(await ctx.fs.readText(`${botFixture.homeDir}/mind/goals.md`)).toContain(goalFixture.title);
  });
  it('核对未变化文件不误报', async () => { const ctx = context(); await createBotHome(ctx, botFixture); expect(await verifyProtectedFiles(ctx, botFixture.id)).toEqual([]); expect(ctx.store.table('bots').get(botFixture.id)?.violations).toBe(0); });
  it('多个保护文件被改按一轮计一次并恢复中心版本', async () => {
    const ctx = context(); await createBotHome(ctx, botFixture); await ctx.fs.writeTextAtomic(`${botFixture.homeDir}/AGENTS.md`, '伪造'); await ctx.fs.writeTextAtomic(`${botFixture.homeDir}/mind/goals.md`, '伪造');
    expect(await verifyProtectedFiles(ctx, botFixture.id)).toEqual(['AGENTS.md', 'mind/goals.md']); expect(ctx.store.table('bots').get(botFixture.id)?.violations).toBe(1);
    expect(await ctx.fs.readText(`${botFixture.homeDir}/AGENTS.md`)).toContain('工作守则'); expect(ctx.store.log('thread').all().at(-1)?.text).toContain('已恢复');
  });
  it('删除保护文件也能被发现', async () => { const ctx = context(); await createBotHome(ctx, botFixture); await ctx.fs.remove(`${botFixture.homeDir}/mind/agenda.md`); expect(await verifyProtectedFiles(ctx, botFixture.id)).toEqual(['mind/agenda.md']); });
  it('刷新前发现篡改而非覆盖掩盖', async () => { const ctx = context(); await createBotHome(ctx, botFixture); await ctx.fs.writeTextAtomic(`${botFixture.homeDir}/mind/watches.md`, '伪造'); ctx.store.table('watches').put(watchFixture); await refreshBotFiles(ctx, botFixture.id); expect(ctx.store.table('bots').get(botFixture.id)?.violations).toBe(1); expect(await ctx.fs.readText(`${botFixture.homeDir}/mind/watches.md`)).toContain(watchFixture.target); });
  it('第三次篡改触发隔离', async () => {
    const ctx = context(); await createBotHome(ctx, botFixture); for (let n = 0; n < 3; n++) { await ctx.fs.writeTextAtomic(`${botFixture.homeDir}/AGENTS.md`, '篡改'); await verifyProtectedFiles(ctx, botFixture.id); }
    expect(ctx.store.table('bots').get(botFixture.id)?.lifecycle).toBe('quarantined');
  });
  it('长期记忆摘要按UTF8截1.5KB', async () => { const ctx = context(); await createBotHome(ctx, botFixture); await ctx.fs.writeTextAtomic(`${botFixture.homeDir}/memory/MEMORY.md`, '中文'.repeat(2000)); const text = await readMemorySummary(ctx, botFixture); expect(byteLength(text)).toBeLessThanOrEqual(1536); expect(text).toContain('已截断'); });
  it('不存在长期记忆返回可读说明', async () => expect(await readMemorySummary(context(), botFixture)).toContain('尚无长期记忆'));
  it('交账日志含理由、世界变化、证据、下次思考，重试不重复', async () => {
    const ctx = context(); await createBotHome(ctx, botFixture); const commit = { ...CommitSchema.parse(modelFixtures.Commit.valid), createdAt: ctx.clock.now(), worldChanges: [{ what: '产出报告', whoCanSee: 'owner' as const, where: 'work/report.md' }], evidence: ['work/report.md'] }; const wake = WakeTicketSchema.parse(modelFixtures.WakeTicket.valid);
    await appendJournal(ctx, botFixture, commit, wake); await appendJournal(ctx, botFixture, commit, wake);
    const text = (await ctx.fs.readText(`${botFixture.homeDir}/memory/journal/2026-11-05.md`))!;
    for (const expected of ['资料发生变化', '产出报告', 'work/report.md', '等待新的证据']) expect(text).toContain(expected);
    expect(text.match(/<!-- commit:/g)).toHaveLength(1);
  });
  it('同日不同交账追加两段', async () => {
    const ctx = context(); const commit = { ...CommitSchema.parse(modelFixtures.Commit.valid), createdAt: ctx.clock.now() }; const wake = WakeTicketSchema.parse(modelFixtures.WakeTicket.valid);
    await appendJournal(ctx, botFixture, commit, wake); await appendJournal(ctx, botFixture, { ...commit, id: 'c_0000000002' }, wake);
    expect((await ctx.fs.readText(`${botFixture.homeDir}/memory/journal/2026-11-05.md`))?.match(/<!-- commit:/g)).toHaveLength(2);
  });
  it('规矩写入全体和个人文件，更新沿用id', async () => {
    const ctx = context(); await createBotHome(ctx, botFixture); const rule = await upsertRule(ctx, { scope: 'global', text: '先验来源', redLine: true }); await upsertRule(ctx, { id: rule.id, scope: 'global', text: '每条先验来源', redLine: true });
    expect(ctx.store.table('rules').count()).toBe(1); expect(await ctx.fs.readText('/hub/AGENTS.md')).toContain('每条先验来源'); expect(await ctx.fs.readText(`${botFixture.homeDir}/AGENTS.md`)).toContain('红线：每条先验来源');
  });
  it('无效规则范围拒绝', async () => expect(upsertRule(context(), { scope: '不存在', text: '规则' })).rejects.toThrow('scope'));
  it('proposed规矩不渲染为已生效红线', async () => { const ctx = context(); await upsertRule(ctx, { scope: botFixture.id, text: '尚待批准的红线', redLine: true, status: 'proposed' }); expect(renderBotAgentsMd(ctx, botFixture)).not.toContain('尚待批准'); });
});

describe('轮换与套路', () => {
  it.each([6, 7])('会话%s天轮换边界', days => { const bot = { ...botFixture, sessionId: 's', sessionStartedAt: 1000 }; expect(needsRotation(bot, { exists: true, running: false, contextRatio: 0.1 }, 1000 + days * 86400000)).toBe(days === 7); });
  it.each([0.49, 0.5])('上下文比例%s轮换边界', ratio => expect(needsRotation({ ...botFixture, sessionId: 's', sessionStartedAt: 1000 }, { exists: true, running: false, contextRatio: ratio }, 2000)).toBe(ratio >= 0.5));
  it('不存在的宿主会话需轮换', () => expect(needsRotation({ ...botFixture, sessionId: 's' }, { exists: false, running: false, contextRatio: null }, 1000)).toBe(true));
  it('套路文件和索引含标题、场景、编号步骤、来源和修订', async () => {
    const ctx = context(); const result = await saveRoutine(ctx, botFixture.id, routine); const text = (await ctx.fs.readText(`${botFixture.homeDir}/playbooks/${result.slug}.md`))!;
    for (const expected of ['事实核对', '遇到公开资料变化', '1. 打开原文', '2. 逐条核对', '主人教学', '修订记录']) expect(text).toContain(expected);
    expect(routineIndex(ctx, botFixture.id)).toContain(`playbooks/${result.slug}.md`);
  });
  it('同名更新保存id与runs并追加修订', async () => {
    const ctx = context(); const old = await saveRoutine(ctx, botFixture.id, routine); ctx.store.table('routines').patch(old.id, { runs: 5 }); ctx.clock.advance(60_000); const updated = await saveRoutine(ctx, botFixture.id, { ...routine, steps: ['先查来源'] });
    expect(updated.id).toBe(old.id); expect(updated.runs).toBe(5); expect(ctx.store.table('routines').count()).toBe(1); expect((await ctx.fs.readText(`${botFixture.homeDir}/playbooks/${old.slug}.md`))?.match(/- 2026/g)).toHaveLength(2);
  });
  it('并发同名保存仍然只有一个套路并保留两次修订', async () => {
    const ctx = context(); const [a, b] = await Promise.all([saveRoutine(ctx, botFixture.id, routine), saveRoutine(ctx, botFixture.id, { ...routine, steps: ['更新后的步骤'] })]);
    expect(a.id).toBe(b.id); expect(ctx.store.table('routines').count()).toBe(1); const text = (await ctx.fs.readText(`${botFixture.homeDir}/playbooks/${a.slug}.md`))!;
    expect(text).toContain('更新后的步骤'); expect(text.match(/- 2026/g)).toHaveLength(2);
  });
  it('不同名字相同slug不覆盖另一套路', async () => {
    const ctx = context(); const a = await saveRoutine(ctx, botFixture.id, { ...routine, name: 'A/B' }); const b = await saveRoutine(ctx, botFixture.id, { ...routine, name: 'A B' }); expect(a.slug).not.toBe(b.slug); expect(await ctx.fs.readText(`${botFixture.homeDir}/playbooks/${a.slug}.md`)).toContain('# A/B');
  });
  it('主人编辑更新清单但不另建套路', async () => {
    const ctx = context(); const old = await saveRoutine(ctx, botFixture.id, routine); const edited = await editRoutine(ctx, old.id, { steps: ['加一个人工检查'] }); expect(edited.id).toBe(old.id); expect((await ctx.fs.readText(`${botFixture.homeDir}/playbooks/${old.slug}.md`))).toContain('主人修订');
  });
  it.each([{ ...routine, name: '' }, { ...routine, steps: [] }, { ...routine, steps: [''] }])('套路输入无效拒绝 %j', async input => expect(saveRoutine(context(), botFixture.id, input)).rejects.toThrow());
  it('教学入队含主人发起、teach变体及有界摘要证据', async () => {
    const ctx = context(); ctx.host.digests.set('owner-session', '教学记录'.repeat(3000)); const entry = await enqueueTeach(ctx, botFixture.id, 'owner-session', '学会核对');
    expect(entry).toMatchObject({ variant: 'teach', ownerInitiated: true, priority: 100 }); const audit = ctx.store.log('audit').all().find(row => row.id === entry!.reason.evidence[0])!;
    expect(audit.action).toBe('teach_context'); expect(byteLength(JSON.parse(audit.detail).digest)).toBeLessThanOrEqual(3072); expect(ctx.host.calls[0]).toMatchObject({ method: 'readSessionDigest', args: ['owner-session', 3000] });
  });
  it('教学未知机器人拒绝且不读会话', async () => { const ctx = context(); await expect(enqueueTeach(ctx, 'missing', 's', '学')).rejects.toThrow('不存在'); expect(ctx.host.calls).toHaveLength(0); });
});
