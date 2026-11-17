/**
 * P85 第 3.6 节的测试：批准写文件之后，落点变了就不写（审查 W9）。
 *
 * 审查记录写的三步：
 * 1. 员工在 /tmp 下建了一个普通文件夹 foo；
 * 2. 员工提交 write_file 写 /tmp/foo/run.plist，主人看到「在工作区之外写文件」并批准；
 * 3. 批准之后、中心执行之前，员工把 foo 换成指向别处的链接；中心执行时重新解析，文件就落到了别处。
 * 修好之后第 3 步被拦住：建审批时把解析到的真实落点记进审批旁表，执行前重新解析并比较，不相等就不写，
 * 这次出站记为失败，给主人看的原因是固定句，完整路径只写进日志。
 *
 * 这里用假文件接口（内存实现的 realpath 原样返回路径，测试里让它按「链接表」改写路径，等价于目录被换成链接）。
 */
import { describe, expect, it } from 'vitest';
import { decideApproval } from '../src/gate/approvals.js';
import { WRITE_TARGET_CHANGED_REASON, executeReadyOutbox, submitOutbox } from '../src/gate/outbox.js';
import type { HubContext } from '../src/engine/context.js';
import { turnContext } from './c03-turn-fixtures.js';

/** 给内存文件接口装一张「链接表」：路径以表里的某个前缀开头时，解析结果换成链接的目标（等价于那一级目录是符号链接）。 */
function withLinks(ctx: HubContext): Map<string, string> {
  const links = new Map<string, string>();
  const fs = ctx.fs as unknown as { realpath(path: string): Promise<string> };
  const original = fs.realpath.bind(fs);
  fs.realpath = async (path: string): Promise<string> => {
    const real = await original(path);
    for (const [from, to] of links) {
      if (real === from || real.startsWith(`${from}/`)) return `${to}${real.slice(from.length)}`;
    }
    return real;
  };
  return links;
}

/** 提交一条写到工作区之外的写文件出站动作，返回出站记录和审批编号。 */
async function submitOutside(ctx: HubContext, botId: string, path = '/srv/plain/run.txt') {
  const row = await submitOutbox(ctx, botId, { kind: 'write_file', why: '写一个配置文件', payload: { path, content: 'hello' } });
  expect(row.status).toBe('pending_approval');
  expect(row.approvalId).not.toBeNull();
  return row;
}

const sentencesTo = (ctx: HubContext, botId: string) => ctx.store.log('thread').all().filter(row => row.thread === botId).map(row => row.text);

describe('3.6 批准写文件之后落点变了：不写', () => {
  it('建审批时把真实落点记进审批旁表', async () => {
    const { ctx, bot } = await turnContext('regular');
    withLinks(ctx);
    const row = await submitOutside(ctx, bot.id);
    expect(ctx.store.table('approvalNotes').get(row.approvalId!)?.writeRealPath).toBe('/srv/plain/run.txt');
  });

  it('W9 的三步：批准之后把目标的上一级换成指向别处的链接，第 3 步被拦住：不写入、记为失败、原因是固定句', async () => {
    const { ctx, bot } = await turnContext('regular');
    const links = withLinks(ctx);
    const row = await submitOutside(ctx, bot.id);
    await decideApproval(ctx, row.approvalId!, true);
    // 批准之后，员工把 /srv/plain 换成指向别处的链接。
    links.set('/srv/plain', '/srv/elsewhere');
    await executeReadyOutbox(ctx);
    const done = ctx.store.table('outbox').get(row.id)!;
    expect(done.status).toBe('failed');
    expect(done.executionStarted).toBe(false);
    expect(done.ownerFailureReason).toBe('要写入的位置在批准之后变了，没有写入。');
    expect(WRITE_TARGET_CHANGED_REASON).toBe('要写入的位置在批准之后变了，没有写入。');
    // 两处都没有文件。
    expect(await ctx.fs.readText('/srv/elsewhere/run.txt')).toBeNull();
    expect(await ctx.fs.readText('/srv/plain/run.txt')).toBeNull();
    // 给主人看的回执里原因是固定句；链接指向的位置（完整路径）不出现，只留在日志里。
    // （回执前半句是主人批准过的那件事本身，带着主人当时看到的原路径，那不是新信息。）
    const shown = sentencesTo(ctx, bot.id).filter(text => text.includes('要写入的位置在批准之后变了'));
    expect(shown.length).toBeGreaterThan(0);
    for (const text of shown) {
      expect(text).toContain('原因：要写入的位置在批准之后变了，没有写入。');
      expect(text).not.toContain('/srv/elsewhere');
    }
    expect(done.result).toBe('要写入的位置在批准之后变了，没有写入。');
  });

  it('反例：落点没有变，批准之后照常写入', async () => {
    const { ctx, bot } = await turnContext('regular');
    withLinks(ctx);
    const row = await submitOutside(ctx, bot.id);
    await decideApproval(ctx, row.approvalId!, true);
    await executeReadyOutbox(ctx);
    expect(ctx.store.table('outbox').get(row.id)!.status).toBe('done');
    expect(await ctx.fs.readText('/srv/plain/run.txt')).toBe('hello');
  });

  it('既有存档里没有记下落点的、已经在等批准的写文件审批：照旧执行，不报错', async () => {
    const { ctx, bot } = await turnContext('regular');
    const links = withLinks(ctx);
    const row = await submitOutside(ctx, bot.id);
    // 模拟旧存档：旁表里没有这一项。
    ctx.store.table('approvalNotes').remove(row.approvalId!);
    await decideApproval(ctx, row.approvalId!, true);
    links.set('/srv/plain', '/srv/elsewhere');
    await executeReadyOutbox(ctx);
    expect(ctx.store.table('outbox').get(row.id)!.status).toBe('done');
    expect(await ctx.fs.readText('/srv/elsewhere/run.txt')).toBe('hello');
  });

  it('目标在可写根目录之内的写文件不受影响：不建审批、不记落点，照常写入', async () => {
    const { ctx, bot } = await turnContext('regular');
    withLinks(ctx);
    const row = await submitOutbox(ctx, bot.id, { kind: 'write_file', why: '记一份笔记', payload: { path: `${bot.homeDir}/work/note.txt`, content: 'in home' } });
    expect(row.approvalId).toBeNull();
    await executeReadyOutbox(ctx);
    expect(ctx.store.table('outbox').get(row.id)!.status).toBe('done');
    expect(await ctx.fs.readText(`${bot.homeDir}/work/note.txt`)).toBe('in home');
    expect(ctx.store.table('approvalNotes').list(note => note.writeRealPath !== undefined)).toHaveLength(0);
  });
});
