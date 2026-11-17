/**
 * P75r1 第 8 节的测试：被引用次数按约定份数计。
 *
 * 对应审查记录 M5：原来每份约定的每个固定过的版本、每条已定事项都计一次，总管多次修订或多处引用就能把一条规矩顶到最前面。
 * 现在每份约定对一条记忆最多计 1 次：取这份约定里版本号最大的、状态为已固定或已被取代的那一版，
 * 这一版里至少有一条已定事项的依据是这条记忆，就计 1。
 */
import { describe, expect, it } from 'vitest';
import { memoryCitations } from '../src/memory/memory-read.js';
import type { AgreementVersion } from '../src/model/agreement.js';
import { agreementFixture, contentFixture, versionFixture } from './p72a-agreement-fixtures.js';
import { jobFix, type JobFix } from './p75c-fixtures.js';

const MEM_A = 'mem_aaaaaaaaaa';
const MEM_B = 'mem_bbbbbbbbbb';

/** 一个版本的内容：每个出处编号对应一条依据为这条记忆的已定事项。 */
function citing(refs: string[]) {
  return { ...contentFixture(), decided: refs.map((ref, i) => ({ text: `已定事项${i}`, basis: { kind: 'source' as const, ref, refText: '出处原文' } })) };
}

/** 往约定表里放一份约定：每个版本给出状态和它引用的记忆编号。 */
function putAgreement(fix: JobFix, id: string, versions: Array<{ no: number; state: AgreementVersion['state']; refs: string[] }>): void {
  fix.ctx.store.table('agreements').put(agreementFixture({
    id, versions: versions.map(item => versionFixture(item.no, { state: item.state, content: citing(item.refs), lockedAt: item.state === 'pending' ? null : 1000 + item.no })),
  }));
}

describe('被引用次数：每份约定最多计 1 次', () => {
  it('同一份约定固定两版、都引用同一条：计 1', async () => {
    const fix = await jobFix();
    putAgreement(fix, 'agr_00000000a1', [{ no: 1, state: 'replaced', refs: [MEM_A] }, { no: 2, state: 'locked', refs: [MEM_A] }]);
    expect(memoryCitations(fix.ctx).get(MEM_A)).toBe(1);
  });

  it('同一版里两条已定事项引用同一条：计 1', async () => {
    const fix = await jobFix();
    putAgreement(fix, 'agr_00000000a1', [{ no: 1, state: 'locked', refs: [MEM_A, MEM_A] }]);
    expect(memoryCitations(fix.ctx).get(MEM_A)).toBe(1);
  });

  it('两份约定各引用一次：计 2；各自引用不同的记忆互不影响', async () => {
    const fix = await jobFix();
    putAgreement(fix, 'agr_00000000a1', [{ no: 1, state: 'locked', refs: [MEM_A] }]);
    putAgreement(fix, 'agr_00000000a2', [{ no: 1, state: 'locked', refs: [MEM_A, MEM_B] }]);
    const counts = memoryCitations(fix.ctx);
    expect(counts.get(MEM_A)).toBe(2);
    expect(counts.get(MEM_B)).toBe(1);
  });

  it('最新固定的一版不再引用：计 0（早先版本引用过也不算）', async () => {
    const fix = await jobFix();
    putAgreement(fix, 'agr_00000000a1', [{ no: 1, state: 'replaced', refs: [MEM_A] }, { no: 2, state: 'locked', refs: [] }]);
    expect(memoryCitations(fix.ctx).get(MEM_A)).toBeUndefined();
  });

  it('还没固定的版本不算：只有待确认的版本时计 0；最新是待确认版本时取它之前最新固定的那一版', async () => {
    const fix = await jobFix();
    putAgreement(fix, 'agr_00000000a1', [{ no: 1, state: 'pending', refs: [MEM_A] }]);
    expect(memoryCitations(fix.ctx).get(MEM_A)).toBeUndefined();
    putAgreement(fix, 'agr_00000000a2', [{ no: 1, state: 'locked', refs: [MEM_B] }, { no: 2, state: 'pending', refs: [] }]);
    expect(memoryCitations(fix.ctx).get(MEM_B)).toBe(1);
  });
});
