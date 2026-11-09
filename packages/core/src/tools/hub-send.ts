/** 同伴发送工具：只暴露收件人和正文，发件身份从可信回合上下文读取。 */
import { sendMail, SendMailInputSchema } from '../peer/mail.js';
import { defineTool } from './common.js';
export const hubSend = defineTool('hub_send', '给在岗同伴发消息，to 是机器人 id；每对每方向每天最多 4 条，单条不超过 4KB，协作记录主人可见。', SendMailInputSchema, 'L1', async (ctx, tc, args) => {
    const mail = await sendMail(ctx, tc.botId, args);
    return { ok: true, text: `同伴消息已发送：${mail.id}` };
});
