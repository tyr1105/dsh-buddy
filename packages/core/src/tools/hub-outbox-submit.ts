/** 出站提交工具只建立受控动作，不把未知 payload 直接交给宿主执行。 */
import { OutboxInputSchema, submitOutboxDetailed } from '../gate/outbox.js';
import { LAUNCH_REPLACED_TOOL_TEXT } from '../job/launch-replace.js';
import { HOST_COMMAND_CWD_RULE, hostWritableModelText } from '../gate/host-writable.js';
import { defineTool } from './common.js';
// P74r18b：run_command 的可写范围由 gate/host-writable.ts 的同一份清单生成，工具说明、审批卡、沙箱规则三处一致。
// P82：补上执行目录的要求（cwd 只能在家目录或共享目录内），与运行前的核对同一句。
export const hubOutboxSubmit = defineTool('hub_outbox_submit', `提交 notify_owner、write_file、http_post 或 run_command，并说明 why；中心按实际动作分类审批，批准后再执行。run_command 由中心在受限沙箱内运行，${hostWritableModelText()}；${HOST_COMMAND_CWD_RULE}要写这个范围之外的位置，提交时会被直接拒绝。run_command 一律要主人批准，批准绑定涉及的家目录文件内容。家目录内的日常工作（跑命令、写文件、自测）用自己的 bash 工具，一般直接做，不用申请；中心让你等主人确认时就等，不要换写法重试。把成品放进项目文件夹用 hub_project_put（L0 不能用），不用走这里。写自己项目的文件夹不需要批准，写工作区外、联网发数据这类对外动作会请主人确认，申请时在 why 里写清为什么。对外发布、花钱、不可撤回的动作，填 cost、undo、after，主人在审批卡上看得到。不可把这当作绕过权限的命令通道。`, OutboxInputSchema, 'L1', async (ctx, tc, args) => {
    const { row, replaced } = await submitOutboxDetailed(ctx, tc.botId, args);
    const base = `出站动作 ${row.id} 已记录：${row.status === 'pending_approval' ? '等待主人批准' : row.status === 'done' ? '已完成' : row.status === 'rejected' ? '已拒绝' : '等待执行'}`;
    // P74r19：取代了原来在等批准的发布命令时，末尾加一句（逐字）。
    return { ok: true, text: replaced ? `${base}。${LAUNCH_REPLACED_TOOL_TEXT}` : base };
});
