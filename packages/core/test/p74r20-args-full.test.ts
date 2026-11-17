/**
 * P74r20 补做的测试：审批卡视图的命令全文字段 argsFull。
 *
 * 全文保存在哪里：中心代为运行的命令，全文在出站记录（outbox）的 payload 里，没有被截断；
 * 审批记录的 argsPreview 超过 approvalPreviewMaxBytes（1 KiB）时存入时就已截成「前 400 字、省略标记、后 400 字」。
 * 所以视图按出站记录取全文；没有出站记录时只在审批记录没被截断时才给，否则不带这个字段。
 * 覆盖：300 字以内与全文相同；超过 300 而不到 4000 是全文、不含「…中间省略…」；超过 4000 末尾那一句逐字；
 * argsPreview 的 300 字截断照旧；没有全文来源时不带字段；schema 通过；唤醒包不带。
 */
import { describe, expect, it } from 'vitest';
import { ApprovalCardPartsSchema } from '../src/api/index.js';
import { approvalArgsFull, clipArgsFull } from '../src/api/approval-card-view.js';
import { stableStringify } from '../src/util/hash.js';
import { bot, nextPacket, threadOf, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, submitLaunch } from './p74g-launch-fixtures.js';

/** 提交一条指定长度的发布命令，返回总管私聊里这张审批卡的 approval 视图和出站记录。 */
async function approvalViewOf(commandChars: number) {
  const { fix } = await acceptedWithLaunch();
  const home = bot(fix, fix.engineer.id).homeDir;
  // 命令正文：开头、中间、结尾各有可辨认的标记，用 x 补到指定长度。
  const body = (n: number) => `echo HEAD_MARK ${'x'.repeat(Math.max(0, Math.floor(n / 2) - 30))} MIDDLE_MARK ${'y'.repeat(Math.max(0, Math.floor(n / 2) - 30))} TAIL_MARK`;
  await submitLaunch(fix, { payload: { cmd: 'bash', args: ['-c', body(commandChars)], cwd: home } });
  const card = fix.hub.api.thread(fix.chief.id).messages.map(message => message.card).find(item => item?.approval !== undefined);
  const row = fix.ctx.store.table('outbox').list()[0]!;
  return { fix, approval: card!.approval!, row };
}

describe('命令全文字段 argsFull', () => {
  it('300 个字符以内：argsFull 与全文相同，argsPreview 也是全文', async () => {
    const { approval, row } = await approvalViewOf(100);
    const full = stableStringify({ kind: row.kind, payload: row.payload, commandFiles: row.commandFiles ?? [] });
    expect(Array.from(full).length).toBeLessThanOrEqual(300);
    expect(approval.argsFull).toBe(full);
    expect(approval.argsPreview).toBe(full);
    expect(() => ApprovalCardPartsSchema.parse(approval)).not.toThrow();
  });

  it('超过 300 而不到 4000：argsFull 是全文、不含「…中间省略…」；argsPreview 仍截到 300 字', async () => {
    const { approval, row } = await approvalViewOf(2000);
    const full = stableStringify({ kind: row.kind, payload: row.payload, commandFiles: row.commandFiles ?? [] });
    expect(Array.from(full).length).toBeGreaterThan(300);
    expect(Array.from(full).length).toBeLessThan(4000);
    expect(approval.argsFull).toBe(full);
    expect(approval.argsFull).not.toContain('中间省略');
    for (const mark of ['HEAD_MARK', 'MIDDLE_MARK', 'TAIL_MARK']) expect(approval.argsFull).toContain(mark);
    expect(Array.from(approval.argsPreview).length).toBeLessThanOrEqual(300);
    expect(approval.argsPreview).toContain('中间省略');
  });

  it('超过 4000：保留前 4000 个字符，末尾另起一行写那一句（逐字，n 为总字数）', async () => {
    const { approval, row } = await approvalViewOf(6000);
    const full = stableStringify({ kind: row.kind, payload: row.payload, commandFiles: row.commandFiles ?? [] });
    const n = Array.from(full).length;
    expect(n).toBeGreaterThan(4000);
    expect(approval.argsFull).toBe(`${Array.from(full).slice(0, 4000).join('')}\n（命令共 ${n} 个字符，这里只显示前 4000 个。看不到完整命令时，请拒绝。）`);
    expect(approval.argsFull!.endsWith(`（命令共 ${n} 个字符，这里只显示前 4000 个。看不到完整命令时，请拒绝。）`)).toBe(true);
  });

  it('给模型看的唤醒包不带命令全文', async () => {
    const { fix } = await approvalViewOf(2000);
    const packet = await nextPacket(fix, fix.engineer.id).catch(() => '');
    expect(packet).not.toContain('MIDDLE_MARK yyyy');
    expect(JSON.stringify(threadOf(fix.ctx, fix.engineer.id))).not.toContain('argsFull');
  });
});

describe('没有出站记录时（approvalArgsFull 的纯规则）', () => {
  it('审批记录没被截断：就是全文（超过 4000 同样按上限处理）', () => {
    expect(approvalArgsFull({ argsPreview: '{"path":"/a/b"}' }, null)).toBe('{"path":"/a/b"}');
    const big = 'z'.repeat(4500);
    expect(approvalArgsFull({ argsPreview: big }, null)).toBe(clipArgsFull(big));
  });
  it('审批记录里已被截成首尾加省略标记：全文已不存在，不带字段', () => {
    expect(approvalArgsFull({ argsPreview: `${'a'.repeat(400)}\n……中间省略……\n${'b'.repeat(400)}` }, null)).toBeUndefined();
  });
  it('刚好 4000 个字符不加那一句；4001 个加', () => {
    expect(clipArgsFull('q'.repeat(4000))).toBe('q'.repeat(4000));
    expect(clipArgsFull('q'.repeat(4001))).toBe(`${'q'.repeat(4000)}\n（命令共 4001 个字符，这里只显示前 4000 个。看不到完整命令时，请拒绝。）`);
  });
});

export type { JobFix };
