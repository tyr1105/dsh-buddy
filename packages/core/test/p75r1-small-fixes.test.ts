/**
 * P75r1 第 9 节的测试：四处小修（L1 先例不重复写、L2 内部名称检查认得新表编号、L3 依据标签分清已撤销和已删除、
 * L5 身份文件截断不把一行切成半句且规矩排在志向之前）。L6 随第 2 节一起消失，不单独测试。
 */
import { describe, expect, it } from 'vitest';
import { basisLabelOf, basisLookupOf } from '../src/api/agreement-views.js';
import { flushJobHooks, onAgreementLocked } from '../src/job/agreement-hooks.js';
import { internalNameIn } from '../src/job/owner-text.js';
import { refreshBotFiles } from '../src/memory/files.js';
import { NOTE_DONE_TEXT } from '../src/memory/note.js';
import { setMemoryStatus, writeMemory } from '../src/memory/service.js';
import { byteLength } from '../src/util/text.js';
import { chiefDraftsAnother } from './p74b-fixtures.js';
import { lockAgreement } from './p72b-fixtures.js';
import { agentsMdOf, bot, callTool, chiefHears, jobFix, memoriesOf, noteArgs, type JobFix } from './p75c-fixtures.js';

describe('L1 同一版的先例不重复写', () => {
  it('同一版的固定收尾同时开始两次：每个待定项只有一条先例', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '帮我做个报价页');
    const agreementId = await chiefDraftsAnother(fix, '报价页', { category: '表单页' });
    lockAgreement(fix.ctx, agreementId); // 手工固定：不触发收尾，下面由测试同时开始两次
    onAgreementLocked(fix.ctx, agreementId, 1, 'confirm');
    onAgreementLocked(fix.ctx, agreementId, 1, 'confirm');
    await flushJobHooks(fix.ctx);
    const precedents = memoriesOf(fix.ctx).filter(row => row.kind === 'precedent' && row.source.agreementId === agreementId);
    expect(precedents.map(row => row.source.pendingKey).sort()).toEqual(['refresh', 'source']);
    expect(precedents.every(row => row.status === 'active' && row.source.versionNo === 1)).toBe(true);
  });
});

describe('L2 内部名称检查认得新表的编号', () => {
  it('note 的 text 写「按 mem_abcdefghij 那条来做」被拒；不含编号的普通话照常通过', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后都按我上次说的那条来做');
    const rejected = await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '按 mem_abcdefghij 那条来做' }));
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('「mem_abcdefghij」是内部名称');
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
    const accepted = await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '按我上次说的那条来做' }));
    expect(accepted).toEqual({ ok: true, text: NOTE_DONE_TEXT });
  });

  it('九张新表的编号前缀各认出一个；按真实形状匹配，普通文字不误判', () => {
    for (const prefix of ['mem', 'sk', 'skv', 'ss', 'su', 'sr']) {
      expect(internalNameIn(`先看 ${prefix}_abcdefghij 这条`), prefix).toBe(`${prefix}_abcdefghij`);
      expect(internalNameIn(`先看${prefix}_0123456789再说`), prefix).toBe(`${prefix}_0123456789`);
    }
    // 不是编号的写法：位数不对、前面连着别的字母、普通英文词。
    for (const normal of ['mem_short', 'item_abcdefghij', 'task_abcdefghij', 'mem_abcdefghijk', 'ask_me_anything_now', 'disk_usage_report', '规矩：提示文字都用请字开头']) {
      expect(internalNameIn(normal), normal).toBeNull();
    }
  });
});

describe('L3 依据标签分清已撤销和已删除', () => {
  it('记忆已撤销写「（已撤销）」，已删除写「（已删除）」', async () => {
    const fix = await jobFix();
    const make = (text: string) => writeMemory(fix.ctx, { kind: 'rule', text, example: '例子', redLine: false, scope: { staff: 'all', projects: 'all' },
      source: { kind: 'owner_words', messageIds: [], quote: '以后都这样', threadId: fix.chief.id } });
    const undone = await make('被撤销的规矩');
    const deleted = await make('被删除的规矩');
    await setMemoryStatus(fix.ctx, undone.id, 'undone', 'owner');
    await setMemoryStatus(fix.ctx, deleted.id, 'deleted', 'owner');
    const lookup = basisLookupOf(fix.ctx);
    const label = (ref: string) => basisLabelOf({ kind: 'source', ref, refText: '原文' }, lookup);
    expect(label(undone.id)).toMatch(/^出处：你的规矩（\d+月\d+日）（已撤销）$/);
    expect(label(deleted.id)).toMatch(/^出处：你的规矩（\d+月\d+日）（已删除）$/);
  });
});

describe('L5 身份文件截断不把一行切成半句，规矩排在志向之前', () => {
  /** 给某位员工放 n 条很长的志向（每条一行）。 */
  function putAspirations(fix: JobFix, botId: string, count: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const text = `志向${i}${'长'.repeat(300)}`;
      fix.ctx.store.table('aspirations').put({ id: `asp_${String(i).padStart(10, '0')}`, botId, text, status: 'active', createdBy: 'owner', approved: true, createdAt: 1 + i });
      lines.push(`- ${text}`);
    }
    return lines;
  }

  it('志向很长（超过上限）：记忆段每一行都完整，「另有 n 条未列出。」的条数与实际一致，文件最后一行是完整的一行', async () => {
    const fix = await jobFix();
    const aspirationLines = putAspirations(fix, fix.engineer.id, 20);
    for (let i = 1; i <= 40; i += 1) {
      fix.ctx.clock.advance(1_000);
      await writeMemory(fix.ctx, { kind: 'rule', text: `第${String(i).padStart(2, '0')}条规矩：提示文字都用「请」字开头并保持一致`, example: `例：第${String(i).padStart(2, '0')}条`,
        redLine: false, scope: { staff: 'all', projects: 'all' }, source: { kind: 'owner_edit', messageIds: [], quote: `第${i}条`, threadId: null } });
    }
    await refreshBotFiles(fix.ctx, fix.engineer.id);
    const md = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
    expect(byteLength(md)).toBeLessThanOrEqual(fix.ctx.settings.botAgentsMaxBytes);
    // 记忆段：到下一个「## 」标题之前。
    const start = md.indexOf('## 主人的规矩与偏好（全队共用，中心维护）\n');
    expect(start).toBeGreaterThan(0);
    const rest = md.slice(start).split('\n').slice(1);
    const end = rest.findIndex(line => line.startsWith('## '));
    expect(end, '志向段应该在记忆段之后').toBeGreaterThan(0);
    const section = rest.slice(0, end).filter(line => line !== '');
    const tail = /^另有 (\d+) 条未列出。$/.exec(section.at(-1)!);
    expect(tail, '记忆段末行应该写明有几条未列出').not.toBeNull();
    const shown = section.slice(0, -1);
    for (const line of shown) expect(line).toMatch(/^- 规矩：第\d\d条规矩：提示文字都用「请」字开头并保持一致（例如：例：第\d\d条）$/);
    expect(shown.length + Number(tail![1])).toBe(40);
    // 文件最后一行是完整的一行（某条志向的整行），不是切了一半的。
    const lastLine = md.trimEnd().split('\n').at(-1)!;
    expect(aspirationLines).toContain(lastLine);
    // 志向被少列了（放不下的整行不要）。
    expect(aspirationLines.filter(line => md.includes(line)).length).toBeLessThan(20);
  });

  it('志向很长、记忆不多：规矩和偏好保持完整，红线与规矩（旧规矩）排在最前', async () => {
    const fix = await jobFix();
    // P75f：模拟「升级前」（迁移未完成），旧规矩才一并读。
    fix.ctx.store.table('migrations').put({ id: 'p75-storage', state: 'failed', attempts: 0, written: {}, steps: {}, error: null, updatedAt: 1 });
    const aspirationLines = putAspirations(fix, fix.engineer.id, 20);
    fix.ctx.store.table('rules').put({ id: 'ru_0000000001', scope: 'global', text: '旧红线：先核实来源', redLine: true, source: 'owner', status: 'active', createdAt: 1 } as never);
    for (let i = 1; i <= 5; i += 1) {
      await writeMemory(fix.ctx, { kind: 'rule', text: `规矩${i}：提示用请字开头`, example: `例${i}`, redLine: false, scope: { staff: 'all', projects: 'all' },
        source: { kind: 'owner_edit', messageIds: [], quote: `规矩${i}`, threadId: null } });
    }
    await refreshBotFiles(fix.ctx, fix.engineer.id);
    const md = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
    expect(byteLength(md)).toBeLessThanOrEqual(fix.ctx.settings.botAgentsMaxBytes);
    const legacyAt = md.indexOf('## 红线与规矩\n- 红线：旧红线：先核实来源');
    const memoryAt = md.indexOf('## 主人的规矩与偏好（全队共用，中心维护）');
    const aspirationAt = md.indexOf('## 我的志向');
    expect(legacyAt).toBeGreaterThan(0);
    expect(legacyAt).toBeLessThan(memoryAt);
    expect(memoryAt).toBeLessThan(aspirationAt);
    for (let i = 1; i <= 5; i += 1) expect(md).toContain(`- 规矩：规矩${i}：提示用请字开头（例如：例${i}）`);
    expect(md).not.toContain('另有');
    expect(aspirationLines).toContain(md.trimEnd().split('\n').at(-1)!);
  });
});
