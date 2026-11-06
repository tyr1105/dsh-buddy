/** 规矩只保存经过调用方授权的结构化变更，再刷新对应身份文件，避免文字与事实分离。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { RuleSchema, type Rule } from '../model/team.js';
import { newId } from '../util/ids.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { refreshBotFiles } from './files.js';
import { renderRootAgentsMd } from './render.js';
const RuleInputSchema = RuleSchema.pick({ scope: true, text: true }).extend({
    id: RuleSchema.shape.id.optional(), redLine: z.boolean().optional(), source: RuleSchema.shape.source.optional(), status: RuleSchema.shape.status.optional(),
});
export type RuleInput = z.infer<typeof RuleInputSchema>;
/** 校验规矩并保存来源和状态，再刷新所有受影响的身份文件以保持事实一致。 */
export async function upsertRule(ctx: HubContext, input: RuleInput): Promise<Rule> {
    const value = parseInput(RuleInputSchema, input, '规矩');
    if (value.scope !== 'global' && !ctx.store.table('bots').get(value.scope))
        throw new Error('scope：机器人不存在');
    const old = value.id ? ctx.store.table('rules').get(value.id) : null;
    if (value.id && !old)
        throw new Error('id：规矩不存在');
    const rule: Rule = { id: old?.id ?? newId('ru', ctx.rng), scope: value.scope, text: value.text,
        redLine: value.redLine ?? old?.redLine ?? false, source: value.source ?? old?.source ?? 'owner', status: value.status ?? old?.status ?? 'active', createdAt: old?.createdAt ?? ctx.clock.now() };
    ctx.store.table('rules').put(rule);
    writeOutreachAudit(ctx, 'rule_upsert', { id: rule.id, scope: rule.scope, status: rule.status }, rule.source === 'owner' ? 'owner' : rule.scope);
    if (rule.scope === 'global' || old?.scope === 'global')
        await ctx.fs.writeTextAtomic(posix.join(ctx.settings.rootDir, 'AGENTS.md'), renderRootAgentsMd(ctx));
    for (const bot of ctx.store.table('bots').list(row => rule.scope === 'global' || old?.scope === 'global' || row.id === rule.scope || row.id === old?.scope)) {
        await refreshBotFiles(ctx, bot.id);
        // 全局规矩也出现在每个机器人详情里，逐个通知而不是发送没有身份的 bot 事件。
        ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    }
    return rule;
}
