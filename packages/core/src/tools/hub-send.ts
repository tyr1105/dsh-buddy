/**
 * 同伴发送工具：只暴露收件人和正文，发件身份从可信回合上下文读取。
 * P74b：派活不再走这里（约定的工作只能用 hub_job_manage 派活）；员工之间不能互发，总管与正在做事的员工之间
 * 关于那件事的往来也被拒绝，规则在 job/guards.ts，由 sendMail 统一执行。总管与没有在办的事的员工之间的小事照旧。
 */
import { sendMail, SendMailInputSchema } from '../peer/mail.js';
import { isChiefOwnerTurn } from '../peer/common.js';
import { defineTool } from './common.js';
export const hubSend = defineTool('hub_send', '给在岗同伴发消息，to 写员工名字或机器人 id；每对每方向每天最多 4 条，单条不超过 4KB，协作记录主人可见。员工之间不能互发；总管与正在做事的员工之间，关于那件事的往来用这件事自己的工具。', SendMailInputSchema, 'L1', async (ctx, tc, args) => {
    // P72l：总管在主人发起的回合里发的消息，收件员工不用等最短思考间隔。
    const report = { queued: false };
    const mail = await sendMail(ctx, tc.botId, args, { chiefDispatch: isChiefOwnerTurn(ctx, tc), report });
    // P73r3 S1：候选确实入队了才说已送达；否则如实报错（消息已记录，但对方没有被排上队）。
    if (!report.queued) throw new Error(`消息 ${mail.id} 已记录，但没有排上对方的队，对方暂时不会处理；请换个时机再提醒`);
    return { ok: true, text: `同伴消息已发送：${mail.id}` };
});
