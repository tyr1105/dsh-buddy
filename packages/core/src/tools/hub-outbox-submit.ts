/** 出站提交工具只建立受控动作，不把未知 payload 直接交给宿主执行。 */
import { OutboxInputSchema, submitOutbox } from '../gate/outbox.js';
import { defineTool } from './common.js';
export const hubOutboxSubmit = defineTool('hub_outbox_submit', '提交 notify_owner、write_file、http_post 或 run_command，并说明 why；中心按实际动作分类审批，批准后再执行。run_command 由中心在 DSH 沙箱外运行，一律要主人批准，批准绑定涉及的家目录文件内容。家目录内的日常工作用自己的 bash 工具。不可把这当作绕过权限的命令通道。', OutboxInputSchema, 'L1', async (ctx, tc, args) => {
    const row = await submitOutbox(ctx, tc.botId, args);
    return { ok: true, text: `出站动作 ${row.id} 已记录：${row.status === 'pending_approval' ? '等待主人批准' : row.status === 'done' ? '已完成' : row.status === 'rejected' ? '已拒绝' : '等待执行'}` };
});
