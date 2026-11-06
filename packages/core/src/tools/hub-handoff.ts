/** 交接工具：文件范围、收件人和议程数量的检查由统一交接模块完成。 */
import { createHandoff, HandoffInputSchema } from '../peer/handoffs.js';
import { defineTool } from './common.js';
export const hubHandoff = defineTool('hub_handoff', '把 task 和可选 files 交给在岗同伴 to，并说明 why；只能复制自己家目录或 shared 内文件，收件人会得到议程。', HandoffInputSchema, 'L1', async (ctx, tc, args) => {
    const row = await createHandoff(ctx, tc.botId, args);
    return { ok: true, text: `交接已送达 ${row.id}，等待同伴接收` };
});
