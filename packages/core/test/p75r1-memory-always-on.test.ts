/**
 * P75r1 第 1 节的测试：记忆永远生效；旧规矩表在迁移完成之前一并生效（两边都读），迁移完成之后不再读。
 *
 * 对应审查记录 H1：原来「记忆是否可用」取决于旧规矩表里有没有生效的规矩，员工用 hub_lesson_propose 写进一条旧规矩，
 * 全队身份文件就不再读记忆；反过来旧规矩表有规矩、迁移未完成时，「已记住」成功却不进身份文件。
 * 全部走真实的 Hub（总管听吩咐、执行员工听吩咐，与真实一致）；时间用假时钟（每次推进不超过 10 分钟）。
 */
import { describe, expect, it } from 'vitest';
import { MEMORY_DEFAULTS } from '../src/config/defaults.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { refreshBotFiles } from '../src/memory/files.js';
import { legacyRulesInEffect, legacyRulesOf } from '../src/memory/memory-read.js';
import { renderRootAgentsMd } from '../src/memory/render.js';
import { setMemoryStatus, writeMemory } from '../src/memory/service.js';
import { resolveBasis } from '../src/project/agreement-content.js';
import { newAgreementArgs } from './p72b-fixtures.js';
import { agentsMdOf, bot, callTool, chiefHears, jobFix, noted, ownerSays, speak, type JobFix } from './p75c-fixtures.js';

const SECTION = '## 主人的规矩与偏好（全队共用，中心维护）';
const LEGACY_SECTION = '## 红线与规矩';

/** 往旧规矩表里直接放一条生效的规矩。 */
function putLegacy(fix: JobFix, id: string, text: string, scope = 'global', redLine = false): void {
  fix.ctx.store.table('rules').put({ id, scope, text, redLine, source: 'owner', status: 'active', createdAt: fix.ctx.clock.now() } as never);
}

/**
 * P75f：中心启动会自动跑迁移并记 done；这些用例要模拟「升级前、迁移还没做」的旧数据，
 * 所以先把迁移记录置为 failed（断言本身不变）。
 */
function unmarkMigrated(fix: JobFix): void {
  fix.ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'failed', attempts: 0, written: {}, steps: {}, error: null, updatedAt: fix.ctx.clock.now() });
}

/** 标记迁移已完成。 */
function markMigrated(fix: JobFix): void {
  fix.ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'done', attempts: 1, written: {}, steps: {}, error: null, updatedAt: fix.ctx.clock.now() });
}

/** 写一条「迁移来的」记忆：source.legacyRuleId 指向旧规矩。 */
async function migratedMemory(fix: JobFix, legacyRuleId: string, text: string) {
  return writeMemory(fix.ctx, { kind: 'rule', text, example: '例子', redLine: false, scope: { staff: 'all', projects: 'all' },
    source: { kind: 'legacy_owner_rule', messageIds: [], quote: text, threadId: null, legacyRuleId } });
}

/** 总管听到一句话之后的唤醒包里，「可引用的出处」那一段（取完让总管交账结束这一回合，下一次才会拿到新的唤醒包）。 */
async function sourcesSection(fix: JobFix): Promise<string> {
  const packet = await chiefHears(fix, '随便聊聊');
  await speak(fix, fix.chief, '收到。', { outcome: 'progress' });
  const start = packet.indexOf('可引用的出处（basis.ref 只能写这些编号）：');
  return start < 0 ? '' : packet.slice(start);
}

/** 总管在一个新回合里提交一份只含一条「已定事项」的新约定，依据是 ref；返回工具结果。 */
async function submitCiting(fix: JobFix, title: string, ref: string) {
  await ownerSays(fix, fix.chief.id, `帮我做${title}`);
  return callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({
    title, category: '表单页', decided: [{ text: '沿用你定过的做法', basis: { kind: 'source', ref } }],
  }));
}

describe('员工写进旧规矩之后，记忆不失效（H1 复现）', () => {
  it('L2 员工的旧教训还在旧规矩表里：另一位员工的身份文件仍有记住的那一条；提教训的员工两段都有', async () => {
    const fix = await jobFix();
    unmarkMigrated(fix);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { autonomy: 'L2' });
    const { memory } = await noted(fix);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.reviewer.id))).toContain(memory.text);
    // P75f：hub_lesson_propose 已下线；这里按它原来的写法直接往旧规矩表放一条员工的教训（旧数据）。
    fix.ctx.store.table('rules').put({ id: 'ru_0000000009', scope: fix.engineer.id, text: '交回前先自测一遍', redLine: false, source: 'lesson', status: 'active', createdAt: fix.ctx.clock.now() } as never);
    expect(fix.ctx.store.table('rules').count(row => row.status === 'active')).toBe(1);
    await refreshBotFiles(fix.ctx, fix.reviewer.id);
    await refreshBotFiles(fix.ctx, fix.engineer.id);
    // 另一位员工：仍读得到主人记住的那一条，没有「红线与规矩」段（教训只属于提教训的员工）。
    const reviewerMd = await agentsMdOf(fix.ctx, bot(fix, fix.reviewer.id));
    expect(reviewerMd).toContain(`${SECTION}\n- 规矩：${memory.text}`);
    expect(reviewerMd).not.toContain(LEGACY_SECTION);
    expect(reviewerMd).not.toContain('交回前先自测一遍');
    // 提教训的员工：「红线与规矩」段（含那条教训）和「主人的规矩与偏好」段（含记住的那一条）同时在，规矩段在前。
    const engineerMd = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
    expect(engineerMd).toContain(`${LEGACY_SECTION}\n- 交回前先自测一遍\n`);
    expect(engineerMd).toContain(`${SECTION}\n- 规矩：${memory.text}`);
    expect(engineerMd.indexOf(LEGACY_SECTION)).toBeLessThan(engineerMd.indexOf(SECTION));
  });
});

describe('旧规矩表有规矩、没有迁移记录：旧规矩和新记的这一条一起生效', () => {
  it('员工身份文件同时有两边；总管出处里 ru_ 和 mem_ 都有；两个编号各提交一次已定事项都被接受', async () => {
    const fix = await jobFix();
    unmarkMigrated(fix);
    putLegacy(fix, 'ru_0000000001', '旧规矩一条：对外文字先给主人看');
    expect(legacyRulesInEffect(fix.ctx)).toBe(true);
    const { memory } = await noted(fix);
    const engineerMd = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
    expect(engineerMd).toContain(`${LEGACY_SECTION}\n- 旧规矩一条：对外文字先给主人看\n`);
    expect(engineerMd).toContain(`${SECTION}\n- 规矩：${memory.text}`);
    // 全体守则里也是两边都列：旧规矩在前，记忆在后，没有「暂无」。
    const root = renderRootAgentsMd(fix.ctx);
    expect(root).toContain(`## 全体规矩\n- 旧规矩一条：对外文字先给主人看\n- 规矩：${memory.text}`);
    expect(root).not.toContain('暂无');
    // 总管约定段「可引用的出处」：两个编号都在「主人的规矩与偏好」一组里，记忆在前。
    const section = await sourcesSection(fix);
    expect(section).toContain(`${memory.id}：${memory.text}`);
    expect(section).toContain('ru_0000000001：旧规矩一条：对外文字先给主人看');
    expect(section.indexOf(memory.id)).toBeLessThan(section.indexOf('ru_0000000001'));
    // 用这两个编号各提交一次约定：都被接受（记忆的编号一次、旧规矩的编号一次）。
    const byMemory = await submitCiting(fix, '报价页甲', memory.id);
    expect(byMemory, JSON.stringify(byMemory)).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    await flushJobHooks(fix.ctx);
    await speak(fix, fix.chief, '已固定。', { outcome: 'progress' });
    const byLegacy = await submitCiting(fix, '报价页乙', 'ru_0000000001');
    expect(byLegacy, JSON.stringify(byLegacy)).toMatchObject({ ok: true });
    const refs = fix.ctx.store.table('agreements').list().map(row => row.versions[0]!.content.decided[0]!.basis.ref).sort();
    expect(refs).toEqual([memory.id, 'ru_0000000001'].sort());
  });
});

describe('迁移记录为 done：旧规矩表不再读', () => {
  it('旧规矩表里仍有生效的规矩，也不出现在身份文件、全体守则、出处、rules 视图里；ru_ 编号只能经对应的记忆引用', async () => {
    const fix = await jobFix();
    putLegacy(fix, 'ru_0000000001', '已迁移的旧规矩原文');
    putLegacy(fix, 'ru_0000000002', '没迁移的旧规矩原文');
    const migrated = await migratedMemory(fix, 'ru_0000000001', '已迁移的旧规矩（记忆里的说法）');
    markMigrated(fix);
    expect(legacyRulesInEffect(fix.ctx)).toBe(false);
    expect(legacyRulesOf(fix.ctx, bot(fix, fix.engineer.id))).toEqual([]);
    await refreshBotFiles(fix.ctx, fix.engineer.id);
    const engineerMd = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
    expect(engineerMd).toContain('已迁移的旧规矩（记忆里的说法）');
    expect(engineerMd).not.toContain('旧规矩原文');
    expect(engineerMd).not.toContain(LEGACY_SECTION);
    expect(renderRootAgentsMd(fix.ctx)).not.toContain('旧规矩原文');
    const section = await sourcesSection(fix);
    expect(section).toContain(migrated.id);
    expect(section).not.toContain('ru_0000000002');
    expect(section).not.toContain('ru_0000000001');
    const view = await fix.hub.api.bot(fix.engineer.id);
    expect(view.rules.map(row => row.text)).toEqual(['已迁移的旧规矩（记忆里的说法）']);
    // ru_ 编号：有对应记忆的改写成记忆编号；没有对应记忆的找不到出处。
    expect(resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000001' } }])[0]!.basis.ref).toBe(migrated.id);
    expect(() => resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000002' } }])).toThrow(/找不到出处 ru_0000000002/);
  });
});

describe('旧规矩已有对应记忆、迁移记录不是 done：各处只出现记忆那一条', () => {
  it('身份文件、全体守则、出处、rules 视图都只列记忆；把记忆删除后旧规矩不重新出现', async () => {
    const fix = await jobFix();
    unmarkMigrated(fix);
    putLegacy(fix, 'ru_0000000001', '旧规矩原文：对外文字先给主人看');
    putLegacy(fix, 'ru_0000000002', '另一条没迁移的旧规矩');
    const memory = await migratedMemory(fix, 'ru_0000000001', '记忆里的说法：对外文字先给主人看');
    expect(legacyRulesInEffect(fix.ctx)).toBe(true);
    // 只剩没迁移的那一条。
    expect(legacyRulesOf(fix.ctx, 'all').map(row => row.id)).toEqual(['ru_0000000002']);
    const check = async (expectMemory: boolean) => {
      await refreshBotFiles(fix.ctx, fix.engineer.id);
      const md = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
      const root = renderRootAgentsMd(fix.ctx);
      const view = await fix.hub.api.bot(fix.engineer.id);
      const section = await sourcesSection(fix);
      for (const text of [md, root, section]) {
        expect(text, '旧规矩原文不再列').not.toContain('旧规矩原文');
        expect(text).toContain(text === section ? 'ru_0000000002' : '另一条没迁移的旧规矩');
        expect(text.includes('记忆里的说法'), text).toBe(expectMemory);
      }
      expect(view.rules.map(row => row.text).sort()).toEqual(expectMemory
        ? ['另一条没迁移的旧规矩', '记忆里的说法：对外文字先给主人看'].sort() : ['另一条没迁移的旧规矩']);
      expect(section.includes('ru_0000000001')).toBe(false);
    };
    await check(true);
    // 主人删掉这条记忆（任何状态都算「已有对应记忆」）：旧规矩不再冒出来。
    await setMemoryStatus(fix.ctx, memory.id, 'deleted', 'owner');
    await check(false);
    expect(resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000002' } }])[0]!.basis.ref).toBe('ru_0000000002');
    expect(() => resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000001' } }])).toThrow(/找不到出处 ru_0000000001/);
  });
});
