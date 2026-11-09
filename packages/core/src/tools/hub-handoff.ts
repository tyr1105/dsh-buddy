/** 交接工具：文件范围、收件人和议程数量的检查由统一交接模块完成。 */
import { createHandoff, HandoffInputSchema } from '../peer/handoffs.js';
import { defineTool } from './common.js';
export const hubHandoff = defineTool('hub_handoff', '把 task 和可选 files 或 artifacts（固定版本 id）交给同伴并说明 why；只传产物和说明，不传上下文。to 可省略，沿席位汇报链找在岗上级，再回退给在岗总管；files 只复制自己家目录或 shared 内文件，artifacts 只交接同伴有权读的固定版本。', HandoffInputSchema, 'L1', async (ctx, tc, args) => {
    const row = await createHandoff(ctx, tc.botId, args);
    return { ok: true, text: `交接已送达 ${row.id}，等待同伴接收` };
});
