/**
 * 交接工具（P74b 起不再注册为工具）：派活只有 hub_job_manage 一条路，否则就有两套派活做法、两套检查。
 * 文件保留是因为旧交接数据和过期处理（peer/handoffs.ts）还要用；这里的定义不在 tools/index.ts 的清单里，模型看不到也调不了。
 * 文件范围、收件人和议程数量的检查由统一交接模块完成。
 */
import { createHandoff, HandoffInputSchema } from '../peer/handoffs.js';
import { isChiefOwnerTurn } from '../peer/common.js';
import { defineTool } from './common.js';
export const hubHandoff = defineTool('hub_handoff', '把 task 和可选 files 或 artifacts（固定版本 id）交给同伴并说明 why；只传产物和说明，不传上下文。to 写员工名字或机器人 id，可省略，省略时交给在岗总管；files 只复制自己家目录或 shared 内文件，artifacts 只交接同伴有权读的固定版本。', HandoffInputSchema, 'L1', async (ctx, tc, args) => {
    // P72l：总管在主人发起的回合里派活，员工不用等最短思考间隔。
    const report = { queued: false };
    const row = await createHandoff(ctx, tc.botId, args, { chiefDispatch: isChiefOwnerTurn(ctx, tc), report });
    // P73r3 S1：候选确实入队了才说已送达；否则如实报错（交接已记录，但对方没有被排上队）。
    if (!report.queued) throw new Error(`交接 ${row.id} 已记录，但没有排上对方的队，对方暂时不会处理；请换个时机再提醒`);
    return { ok: true, text: `交接已送达 ${row.id}，等待同伴接收` };
});
