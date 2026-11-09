/** M12 验证中心命令不能借旧 A 类、L3 授权或旧存档绕过审批，并把批准绑定到家内文件内容。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBotHome } from '../src/memory/files.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { consumeTicket, decideApproval, requestApproval } from '../src/gate/approvals.js';
import { OutboxActionSchema, type OutboxAction } from '../src/model/outreach.js';
import { resolveSettings } from '../src/config/defaults.js';
import { buildTools, runTool } from '../src/tools/index.js';
import { FileStore } from '../src/store/file-store.js';
import { sha256Hex } from '../src/util/hash.js';
import { approvalOwnerSummary } from '../src/util/owner-text.js';
import { botFixture } from './model-fixtures.js';
import { toolFixture } from './c03-tool-fixtures.js';

const response = { code: 0, stdout: '已完成', stderr: '', timedOut: false };
const warning = '这条命令在受限沙箱内运行，只能写家目录、共享目录和系统临时目录。看不懂就拒绝。';
const reason = '脚本在批准后被改动';
const commands = [
  { cmd: 'python3', args: ['work/x.py'] },
  { cmd: 'node', args: ['work/x.js'] },
  { cmd: 'mkdir', args: ['work/output'] },
  { cmd: 'cp', args: ['work/input.txt', 'work/copy.txt'] },
  { cmd: 'ls', args: ['work'] },
];
const levels = [
  { label: '试岗 L1', autonomy: 'L1' as const, lifecycle: 'probation' as const },
  { label: '在岗 L1', autonomy: 'L1' as const, lifecycle: 'active' as const },
  { label: '在岗 L2', autonomy: 'L2' as const, lifecycle: 'active' as const },
  { label: '在岗 L3', autonomy: 'L3' as const, lifecycle: 'active' as const },
];

/** 文件与时钟都注入，测试中没有执行真实任意命令或碰主人的文件。 */
async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/x.py`, 'print("已核对")\n');
  await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/x.js`, 'console.log("已核对");\n');
  await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/input.txt`, '原始输入');
  return { ctx, bot };
}
/** 每个命令按独立 argv 建单，避免测试意外绕过正式输入校验。 */
function input(homeDir: string, cmd = 'python3', args = ['work/x.py']) {
  return { kind: 'run_command' as const, payload: { cmd, args, cwd: homeDir }, why: '核对任务结果' };
}
/** 只找动作自己的执行回执，不能拿批准通知冒充执行后的结果。 */
function resultMessages(ctx: Awaited<ReturnType<typeof setup>>['ctx'], row: OutboxAction) {
  return ctx.store.log('thread').all().filter(message => message.kind === 'system' && message.refId === row.id);
}

describe('M12 中心命令一律需要主人批准', () => {
  for (const level of levels) {
    it.each(commands)(`${level.label} 的 $cmd 批准前零执行，批准后只运行一次`, async ({ cmd, args }) => {
      const { ctx, bot } = await setup();
      ctx.store.table('bots').patch(bot.id, { autonomy: level.autonomy, lifecycle: level.lifecycle });
      ctx.exec.set(cmd, args, response);
      const row = await submitOutbox(ctx, bot.id, input(bot.homeDir, cmd, args));
      expect(row).toMatchObject({ status: 'pending_approval', actionClass: 'C', approvalId: expect.any(String) });
      expect(ctx.store.table('approvals').get(row.approvalId!)).toMatchObject({
        status: 'pending', why: expect.stringContaining('这条命令由中心在受限沙箱内运行，要主人批准'),
      });
      expect(ctx.store.table('approvals').count()).toBe(1);
      await executeReadyOutbox(ctx);
      expect(ctx.exec.calls).toHaveLength(0);
      await decideApproval(ctx, row.approvalId!, true);
      await Promise.all([executeReadyOutbox(ctx), executeReadyOutbox(ctx)]);
      await executeReadyOutbox(ctx);
      expect(ctx.exec.calls).toEqual([expect.objectContaining({ cmd, args, opts: expect.objectContaining({ cwd: bot.homeDir }) })]);
      // 本卡反转 M12 的旧断言：宿主命令必须携带沙箱，可写目录只有家目录、共享目录（临时目录由沙箱实现加入）。
      expect(ctx.exec.calls[0]!.opts.sandbox).toEqual({ writableRoots: [bot.homeDir, '/hub/shared'], denyWriteRoots: [] });
      expect(ctx.store.table('outbox').get(row.id)?.status).toBe('done');
      expect(ctx.store.table('approvals').get(row.approvalId!)?.status).toBe('used');
      expect(resultMessages(ctx, row)).toHaveLength(1);
    });
  }

  it.each(['host_command', 'run_command', 'send_message', 'high_risk'])('L3 即使有 %s 授权也不能免去中心命令审批', async grant => {
    const { ctx, bot } = await setup();
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L3' });
    ctx.settings = resolveSettings({ rootDir: '/hub', l3Grants: [grant] });
    const command = grant === 'send_message' ? input(bot.homeDir, 'say', ['完成'])
      : grant === 'high_risk' ? input(bot.homeDir, 'rm', ['-rf', '/outside/obsolete'])
      : grant === 'run_command' ? input(bot.homeDir, 'custom-cli', ['run']) : input(bot.homeDir);
    const row = await submitOutbox(ctx, bot.id, command);
    expect(row).toMatchObject({ status: 'pending_approval', approvalId: expect.any(String) });
    if (grant === 'high_risk') expect(row.actionClass).toBe('D');
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(0);
  });

  it.each(commands)('L0 的 $cmd 被拒绝，不建审批也不执行', async ({ cmd, args }) => {
    const { ctx, bot } = await setup();
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L0' });
    await expect(submitOutbox(ctx, bot.id, input(bot.homeDir, cmd, args))).rejects.toThrow(/当前机器人不能|自主等级不允许/);
    expect(ctx.store.table('outbox').count()).toBe(0);
    expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.exec.calls).toHaveLength(0);
  });

  it.each(['protected', 'work_data'])('%s 原有硬拒绝不能被升级 C 类改成可批准', async boundary => {
    const { ctx, bot } = await setup();
    ctx.settings = resolveSettings({ rootDir: '/hub', workDataPaths: ['/owner/company'] });
    const command = boundary === 'protected' ? input(bot.homeDir, 'cp', ['work/input.txt', 'AGENTS.md'])
      : input(bot.homeDir, 'cat', ['/owner/company/data.txt']);
    // 本卡要求保留原来的硬拒绝文案，不能把分类名当成用户错误消息。
    await expect(submitOutbox(ctx, bot.id, command)).rejects.toThrow(boundary === 'protected'
      ? '中心管理的身份、心智视图和历史日志不能直接改写' : '尚未允许访问工作数据目录');
    expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(1);
    expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.store.table('outbox').count()).toBe(0);
    expect(ctx.exec.calls).toHaveLength(0);
  });

  it('旧 ready 无批准票存档恢复后补审批和当前文件指纹，批准之前不能运行', async () => {
    const { ctx, bot } = await setup();
    const legacy = { id: 'o_0000000009', botId: bot.id, ...input(bot.homeDir), actionClass: 'A',
      approvalId: null, status: 'ready', result: null, createdAt: ctx.clock.now(), doneAt: null };
    await ctx.fs.writeTextAtomic('/hub/.hub/state/outbox.json', JSON.stringify([legacy]));
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', ctx.settings.timezone, ctx.logger);
    await store.load();
    store.table('bots').put(bot);
    const runtime = { ...ctx, store };
    ctx.exec.set('python3', ['work/x.py'], response);
    expect(OutboxActionSchema.safeParse(store.table('outbox').get(legacy.id)).success).toBe(true);
    await executeReadyOutbox(runtime);
    const migrated = store.table('outbox').get(legacy.id)!;
    expect(migrated).toMatchObject({ status: 'pending_approval', actionClass: 'C', approvalId: expect.any(String) });
    expect(migrated.commandFiles ?? []).toEqual([expect.objectContaining({ path: `${bot.homeDir}/work/x.py`, sha256: sha256Hex('print("已核对")\n') })]);
    expect(ctx.exec.calls).toHaveLength(0);
    await executeReadyOutbox(runtime);
    expect(store.table('approvals').count()).toBe(1);
    await decideApproval(runtime, migrated.approvalId!, true);
    await executeReadyOutbox(runtime);
    expect(ctx.exec.calls).toHaveLength(1);
    expect(store.table('outbox').get(legacy.id)?.status).toBe('done');
    await store.flush();
    const restored = new FileStore(ctx.fs, ctx.clock, '/hub', ctx.settings.timezone, ctx.logger);
    await restored.load();
    expect(restored.table('outbox').get(legacy.id)?.commandFiles).toEqual(migrated.commandFiles);
    expect(ctx.logger.lines).toEqual([]);
  });

  it('旧 ready 在执行前降为 L0 仍拒绝，不创建可绕过等级的批准票', async () => {
    const { ctx, bot } = await setup();
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L0' });
    ctx.store.table('outbox').put(OutboxActionSchema.parse({ id: 'o_0000000009', botId: bot.id, ...input(bot.homeDir),
      actionClass: 'A', approvalId: null, status: 'ready', result: null, createdAt: ctx.clock.now(), doneAt: null }));
    await executeReadyOutbox(ctx);
    expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.exec.calls).toHaveLength(0);
    expect(['failed', 'rejected']).toContain(ctx.store.table('outbox').get('o_0000000009')?.status);
  });

  it.each([false, true])('旧档已批准=%s 但没绑定文件内容时必须重建审批，不能沿用旧票执行当前脚本', async approved => {
    const { ctx, bot } = await setup();
    const command = input(bot.homeDir);
    const old = await requestApproval(ctx, bot.id, 'hub_outbox_execute', { kind: command.kind, payload: command.payload }, 'C', '旧版申请');
    if (approved) await decideApproval(ctx, old.id, true);
    ctx.store.table('outbox').put(OutboxActionSchema.parse({ id: 'o_0000000009', botId: bot.id, ...command,
      actionClass: 'C', approvalId: old.id, status: 'pending_approval', result: null, createdAt: ctx.clock.now(), doneAt: null }));
    ctx.exec.set('python3', ['work/x.py'], response);
    await executeReadyOutbox(ctx);
    const row = ctx.store.table('outbox').get('o_0000000009')!;
    expect(ctx.exec.calls).toHaveLength(0);
    expect(row.status).toBe('pending_approval');
    expect(row.approvalId).not.toBe(old.id);
    expect(row.commandFiles).toHaveLength(1);
    await decideApproval(ctx, row.approvalId!, true);
    await executeReadyOutbox(ctx);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(1);
  });

  it('主人已经批准后降为 L0，执行前仍拒绝且不消费批准票', async () => {
    const { ctx, bot } = await setup();
    const row = await submitOutbox(ctx, bot.id, input(bot.homeDir));
    await decideApproval(ctx, row.approvalId!, true);
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L0' });
    ctx.exec.set('python3', ['work/x.py'], response);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(0);
    expect(['failed', 'rejected']).toContain(ctx.store.table('outbox').get(row.id)?.status);
    expect(ctx.store.table('approvals').get(row.approvalId!)?.usedAt).toBeNull();
    expect(resultMessages(ctx, row)[0]?.text).toContain('未执行你批准的');
  });
});

describe('M12 批准绑定实际文件内容', () => {
  it('cmd 与 args 中已有家内普通文件都绑定，目录和不存在的输出不冒充文件', async () => {
    const { ctx, bot } = await setup();
    await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/runner`, '#!/bin/sh\nexit 0\n');
    const row = await submitOutbox(ctx, bot.id, input(bot.homeDir, './work/runner',
      ['work/input.txt', `${bot.homeDir}/work/x.py`, 'work', 'work/missing.txt']));
    expect(row.commandFiles ?? []).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `${bot.homeDir}/work/runner`, sha256: sha256Hex('#!/bin/sh\nexit 0\n') }),
      expect.objectContaining({ path: `${bot.homeDir}/work/input.txt`, sha256: sha256Hex('原始输入') }),
      expect.objectContaining({ path: `${bot.homeDir}/work/x.py`, sha256: sha256Hex('print("已核对")\n') }),
    ]));
    expect(row.commandFiles).toHaveLength(3);
  });

  it('相对路径以 payload.cwd 为准，带空格和引号的单个 argv 不丢文件指纹', async () => {
    const { ctx, bot } = await setup();
    const path = `${bot.homeDir}/work/有 空格"脚本.py`;
    await ctx.fs.writeTextAtomic(path, 'print(1)\n');
    const row = await submitOutbox(ctx, bot.id, input(`${bot.homeDir}/work`, 'python3', ['有 空格"脚本.py']));
    expect(row.commandFiles).toEqual([expect.objectContaining({ path, sha256: sha256Hex('print(1)\n') })]);
  });

  it.each(['改写内容', '删除脚本', '读取失败', '变成目录', '符号链接改向', '符号链接同内容改向'])('批准后%s：拒绝、明确回执并作废批准票', async change => {
    const { ctx, bot } = await setup();
    const command = input(bot.homeDir);
    ctx.exec.set(command.payload.cmd, command.payload.args, response);
    const row = await submitOutbox(ctx, bot.id, command);
    await decideApproval(ctx, row.approvalId!, true);
    const path = `${bot.homeDir}/work/x.py`;
    if (change === '改写内容') await ctx.fs.writeTextAtomic(path, 'print("另一份脚本")\n');
    if (change === '删除脚本') await ctx.fs.remove(path);
    if (change === '变成目录') { await ctx.fs.remove(path); await ctx.fs.mkdirp(path); }
    if (change === '读取失败') {
      const read = ctx.fs.readBytes.bind(ctx.fs);
      ctx.fs.readBytes = async target => { if (target === path) throw new Error('EACCES'); return read(target); };
    }
    if (change.startsWith('符号链接')) {
      const target = '/owner/changed.py';
      await ctx.fs.writeTextAtomic(target, change === '符号链接同内容改向' ? 'print("已核对")\n' : 'print("被换掉的目标")\n');
      const read = ctx.fs.readBytes.bind(ctx.fs);
      const stat = ctx.fs.stat.bind(ctx.fs);
      ctx.fs.realpath = async value => value === path ? target : value;
      ctx.fs.readBytes = async value => read(value === path ? target : value);
      ctx.fs.stat = async value => stat(value === path ? target : value);
    }
    await executeReadyOutbox(ctx);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.store.table('outbox').get(row.id)).toMatchObject({ status: 'rejected', executionStarted: false, ownerFailureReason: reason });
    const expected = `未执行你批准的：运行命令 python3 work/x.py（原因：${reason}）`;
    expect(resultMessages(ctx, row).map(message => message.text)).toEqual([expected]);
    const ticket = ctx.store.table('approvals').get(row.approvalId!)!;
    expect(ticket.status).not.toBe('approved');
    expect(approvalOwnerSummary(ticket, ticket.status, '', ctx)).toBe(expected);
    expect(ctx.store.table('bots').get(bot.id)?.activityText).toBe(expected);
    expect(consumeTicket(ctx, bot.id, 'hub_outbox_execute', { kind: row.kind, payload: row.payload, commandFiles: row.commandFiles ?? [] })).toBe(false);
  });

  it('同一命令与同一内容只建一单，说明变化不换票；批准后同内容重写仍只执行一次', async () => {
    const { ctx, bot } = await setup();
    const command = input(bot.homeDir);
    ctx.exec.set('python3', ['work/x.py'], response);
    const row = await submitOutbox(ctx, bot.id, command);
    expect((await submitOutbox(ctx, bot.id, { ...command, why: '换一种解释' })).id).toBe(row.id);
    await decideApproval(ctx, row.approvalId!, true);
    ctx.clock.advance(1_000);
    await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/x.py`, 'print("已核对")\n');
    await Promise.all([executeReadyOutbox(ctx), executeReadyOutbox(ctx)]);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(1);
    expect(ctx.store.table('approvals').count()).toBe(1);
    expect(ctx.store.table('outbox').get(row.id)?.status).toBe('done');
  });

  it.each([false, true])('原票已批准=%s 时相同命令换文件内容都新建审批，旧票不能批准新版', async approved => {
    const { ctx, bot } = await setup();
    const command = input(bot.homeDir);
    ctx.exec.set('python3', ['work/x.py'], response);
    const old = await submitOutbox(ctx, bot.id, command);
    if (approved) await decideApproval(ctx, old.approvalId!, true);
    await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/x.py`, 'print("新版本")\n');
    const newer = await submitOutbox(ctx, bot.id, command);
    expect(newer.id).not.toBe(old.id);
    expect(newer.approvalId).not.toBe(old.approvalId);
    expect(ctx.store.table('approvals').get(newer.approvalId!)?.contentHash)
      .not.toBe(ctx.store.table('approvals').get(old.approvalId!)?.contentHash);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(0);
    await decideApproval(ctx, newer.approvalId!, true);
    await executeReadyOutbox(ctx);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(1);
    expect(ctx.store.table('outbox').get(newer.id)?.status).toBe('done');
  });

  it('提交时已有普通文件读不出来则不生成可执行票，不把读取失败当不存在', async () => {
    const { ctx, bot } = await setup();
    const path = `${bot.homeDir}/work/x.py`;
    const read = ctx.fs.readBytes.bind(ctx.fs);
    ctx.fs.readBytes = async target => { if (target === path) throw new Error('EACCES'); return read(target); };
    await expect(submitOutbox(ctx, bot.id, input(bot.homeDir))).rejects.toThrow();
    expect(ctx.store.table('approvals').count()).toBe(0);
    expect(ctx.exec.calls).toHaveLength(0);
  });

  it('提交时不存在的脚本在批准后出现，也不能使用未包含它内容的旧票运行', async () => {
    const { ctx, bot } = await setup();
    const path = `${bot.homeDir}/work/new.py`;
    const row = await submitOutbox(ctx, bot.id, input(bot.homeDir, 'python3', ['work/new.py']));
    expect(row.commandFiles ?? []).toEqual([]);
    await decideApproval(ctx, row.approvalId!, true);
    await ctx.fs.writeTextAtomic(path, 'print("新出现的内容")\n');
    ctx.exec.set('python3', ['work/new.py'], response);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.store.table('outbox').get(row.id)?.status).toBe('rejected');
  });

  it('批准指纹按原始字节计算，不让非法 UTF-8 被同一替代字符掩盖内容变化', async () => {
    const { ctx, bot } = await setup();
    const path = `${bot.homeDir}/work/x.py`;
    let bytes = new Uint8Array([0x80]);
    const read = ctx.fs.readBytes.bind(ctx.fs);
    ctx.fs.readBytes = async target => target === path ? bytes.slice() : read(target);
    const first = await submitOutbox(ctx, bot.id, input(bot.homeDir));
    await decideApproval(ctx, first.approvalId!, true);
    bytes = new Uint8Array([0x81]);
    expect(Buffer.from([0x80]).toString('utf8')).toBe(Buffer.from(bytes).toString('utf8'));
    const second = await submitOutbox(ctx, bot.id, input(bot.homeDir));
    expect(second.approvalId).not.toBe(first.approvalId);
    expect(second.commandFiles?.[0]?.sha256).not.toBe(first.commandFiles?.[0]?.sha256);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(0);
    expect(ctx.store.table('outbox').get(first.id)?.status).toBe('rejected');
  });

  it('有两张相同内容的已批准票时，只消费出站行实际关联的票', async () => {
    const { ctx, bot } = await setup();
    const row = await submitOutbox(ctx, bot.id, input(bot.homeDir));
    await decideApproval(ctx, row.approvalId!, true);
    const second = await requestApproval(ctx, bot.id, 'hub_outbox_execute',
      { kind: row.kind, payload: row.payload, commandFiles: row.commandFiles ?? [] }, 'C', '另一份独立批准');
    expect(second.id).not.toBe(row.approvalId);
    await decideApproval(ctx, second.id, true);
    ctx.store.table('outbox').patch(row.id, { approvalId: second.id });
    ctx.exec.set('python3', ['work/x.py'], response);
    await executeReadyOutbox(ctx);
    expect(ctx.exec.calls).toHaveLength(1);
    expect(ctx.store.table('approvals').get(second.id)?.status).toBe('used');
    expect(ctx.store.table('approvals').get(row.approvalId!)?.status).toBe('approved');
  });
});

describe('M12 主人和机器人都能看清命令权限', () => {
  it('工具入口明确一律批准和日常 bash 路径，M06 扁平 Schema 保持完整', async () => {
    const { ctx, bot, tc } = toolFixture();
    const tools = buildTools(ctx);
    const tool = tools.find(item => item.name === 'hub_outbox_submit')!;
    expect(tool.description).toContain('一律要主人批准');
    expect(tool.description).toContain('受限沙箱');
    expect(tool.description).toContain('bash');
    for (const item of tools) {
      expect(item.jsonSchema).toMatchObject({ type: 'object', properties: expect.any(Object) });
      for (const key of ['oneOf', 'anyOf', 'allOf']) expect(item.jsonSchema).not.toHaveProperty(key);
      expect(JSON.stringify(item.jsonSchema)).not.toMatch(/"\$(?:ref|defs|schema)"\s*:/);
    }
    expect(await runTool(ctx, tc, 'hub_outbox_submit', input(bot.homeDir, 'ls', ['work']))).toMatchObject({ ok: true });
    expect(ctx.store.table('outbox').list()[0]?.status).toBe('pending_approval');
    expect(ctx.exec.calls).toHaveLength(0);
  });

  it('run_command 审批卡与审批线程都有完整沙箱风险提醒，普通写文件不误报', async () => {
    const { ctx, bot } = await setup();
    const row = await submitOutbox(ctx, bot.id, input(bot.homeDir));
    const card = ctx.store.table('inbox').list(item => item.refId === row.approvalId)[0]!;
    expect(card.body).toContain(warning);
    expect(ctx.store.log('thread').all().find(message => message.refId === card.id)?.text).toContain(warning);
    const other = await submitOutbox(ctx, bot.id, { kind: 'write_file', payload: { path: '/owner/report.md', content: '结果' }, why: '交付' });
    expect(ctx.store.table('inbox').list(item => item.refId === other.approvalId)[0]?.body).not.toContain(warning);
  });
});
