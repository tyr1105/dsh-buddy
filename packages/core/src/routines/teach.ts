/** 教学只读取主人指定会话的有限摘要，作为不可信材料保存，再排入主人发起的教学回合。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, text } from '../model/primitives.js';
import { truncateBytes } from '../util/text.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
const TeachSchema = z.strictObject({ botId: nonempty, sessionId: nonempty, note: text });
/** 读取主人指定会话的有限摘要并留存证据，再生成主人发起的教学候选。 */
export async function enqueueTeach(ctx: HubContext, botId: string, sessionId: string, note: string) {
    const value = parseInput(TeachSchema, { botId, sessionId, note }, '教学');
    const bot = ctx.store.table('bots').get(value.botId);
    if (!bot)
        throw new Error('botId：机器人不存在');
    if (!['active', 'probation'].includes(bot.lifecycle))
        throw new Error('教学：机器人必须在岗或试岗，请先恢复其状态');
    const digest = truncateBytes(await ctx.host.readSessionDigest(value.sessionId, ctx.settings.c03.teachDigestMaxChars), ctx.settings.c03.teachDigestMaxBytes);
    const evidence = writeOutreachAudit(ctx, 'teach_context', { sessionId: value.sessionId, note: value.note, digest }, botId);
    return enqueue(ctx, buildCandidate(ctx, { botId, kind: 'teach', variant: 'teach', score: ctx.settings.c02.ownerSalience,
        summary: `主人教你一招：${value.note || '请整理这段会话的方法'}`, ownerSummary: '你提供的教学会话已收到',
        evidence: [evidence.id], subjectKey: `teach:${evidence.id}`, ownerInitiated: true }));
}
