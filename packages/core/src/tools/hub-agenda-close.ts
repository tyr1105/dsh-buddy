/** 关闭议程并同步交接结果：接单人完成或放弃后，发起人会收到对应事实。 */
import { z } from 'zod';
import { refreshBotFiles } from '../memory/index.js';
import { closeHandoffForAgenda } from '../peer/handoffs.js';
import { defineTool, requiredText, auditTool } from './common.js';
export const AgendaCloseInputSchema = z.strictObject({ id: requiredText, status: z.enum(['done', 'dropped']), note: requiredText });
export const hubAgendaClose = defineTool('hub_agenda_close', '完成或放弃自己的一条议程，note 说明结果或放弃理由；交接议程会自动通知发起人。L0 不可用。', AgendaCloseInputSchema, 'L1', async (ctx, tc, args) => {
    const item = ctx.store.table('agenda').get(args.id);
    if (!item || item.botId !== tc.botId)
        throw new Error('id：议程不存在或不属于你');
    if (item.status !== 'open')
        throw new Error('id：议程已经关闭');
    ctx.store.table('agenda').patch(item.id, { status: args.status, note: args.note, updatedAt: ctx.clock.now() });
    closeHandoffForAgenda(ctx, tc.botId, item.id, args.status);
    auditTool(ctx, tc.botId, 'hub_agenda_close', `${item.id} ${args.status}`);
    await refreshBotFiles(ctx, tc.botId);
    return { ok: true, text: `议程已${args.status === 'done' ? '完成' : '放弃'}：${item.title}` };
});
