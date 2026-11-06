/** M12 静态路径包装回归：选项、shell 与工作目录包装中的家内文件也必须纳入批准指纹。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { decideApproval } from '../src/gate/approvals.js';
import { sha256Hex } from '../src/util/hash.js';
import { botFixture } from './model-fixtures.js';

const cases = [
  { label: 'shell 引号内静态路径', cmd: 'bash', args: ['-c', "python3 'work/x.py'"] },
  { label: 'shell cd 后的相对路径', cmd: 'bash', args: ['-c', 'cd work; python3 x.py'] },
  { label: '包装器更换 cwd 后的路径', cmd: 'env', args: ['-C', 'work', 'python3', 'x.py'] },
  { label: '长选项附着路径', cmd: 'custom-cli', args: ['--config=work/x.py'] },
  { label: '响应文件参数', cmd: 'custom-cli', args: ['@work/x.py'] },
  { label: '短选项附着路径', cmd: 'node', args: ['-rwork/x.py', 'work/main.js'] },
  { label: '文件 URL', cmd: 'custom-cli', args: [`file://${botFixture.homeDir}/work/x.py`] },
];

describe('M12 包装参数中的内容绑定', () => {
  it.each(cases)('$label 原内容可执行，改内容后不能使用原批准', async ({ cmd, args }) => {
    // 正反两条独立环境共享相同命令；无条件拒绝或只保护直接参数都会使测试失败。
    for (const changed of [false, true]) {
      const ctx = createTestContext();
      ctx.store.table('bots').put(botFixture);
      const path = `${botFixture.homeDir}/work/x.py`;
      await ctx.fs.writeTextAtomic(path, 'print("初版")\n');
      const row = await submitOutbox(ctx, botFixture.id, { kind: 'run_command',
        payload: { cmd, args, cwd: botFixture.homeDir }, why: '核对包装参数' });
      expect(row.commandFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ path, sha256: sha256Hex('print("初版")\n') }),
      ]));
      await decideApproval(ctx, row.approvalId!, true);
      if (changed) await ctx.fs.writeTextAtomic(path, 'print("修改版")\n');
      ctx.exec.set(cmd, args, { code: 0, stdout: '完成', stderr: '', timedOut: false });
      await executeReadyOutbox(ctx);
      expect(ctx.exec.calls).toHaveLength(changed ? 0 : 1);
      expect(ctx.store.table('outbox').get(row.id)?.status).toBe(changed ? 'rejected' : 'done');
    }
  });
});
