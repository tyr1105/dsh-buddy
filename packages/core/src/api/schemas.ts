/** 主人界面输入集中校验：只允许档案与业务字段，禁止直接改会话、计数、来源和运行态。 */
import { z } from 'zod';
import { BotSchema, AspirationSchema, GoalSchema } from '../model/bot.js';
import { WatchSchema } from '../model/perception.js';
import { RuleSchema } from '../model/team.js';
import { nonempty } from '../model/primitives.js';
import { WatchProposeInputSchema } from '../tools/hub-watch-propose.js';
import { C04_DEFAULTS } from '../config/defaults.js';

export const NameSchema = nonempty.trim().min(1, '名字不能为空').max(20, '名字不能超过 20 字');
export const ProfilePatchSchema = BotSchema.pick({ name: true, role: true, persona: true, color: true, autonomy: true, pace: true,
  model: true, workDataAllowed: true }).partial().extend({ name: NameSchema.optional() });
export const AspirationInputSchema = AspirationSchema.pick({ botId: true, text: true }).extend({
  id: AspirationSchema.shape.id.optional(), text: nonempty.trim().min(1, '志向不能为空'), status: AspirationSchema.shape.status.optional(),
});
export const GoalInputSchema = GoalSchema.pick({ botId: true, aspirationId: true, title: true, doneWhen: true, period: true }).extend({
  id: GoalSchema.shape.id.optional(), importance: GoalSchema.shape.importance.optional(), patienceMs: GoalSchema.shape.patienceMs.optional(),
  verification: GoalSchema.shape.verification.optional(), periodEndsAt: GoalSchema.shape.periodEndsAt.optional(),
});
// 创建时不可能知道新志向 id，初始目标按 aspirationIndex（默认首条）明确归属。
export const InitialGoalSchema = GoalInputSchema.omit({ botId: true, aspirationId: true, id: true }).extend({ aspirationIndex: z.number().int().min(0).optional() });
export const WatchInputSchema = WatchProposeInputSchema.extend({ botId: nonempty, id: WatchSchema.shape.id.optional(),
  relevance: WatchSchema.shape.relevance.optional(), status: z.enum(['active', 'paused']).optional() });
export const CreateBotSchema = z.strictObject({
  name: NameSchema, role: BotSchema.shape.role, persona: BotSchema.shape.persona,
  aspirations: z.array(nonempty.trim().min(1, '志向不能为空')).min(1, '至少需要一个志向').max(3, '最多三个志向'),
  autonomy: BotSchema.shape.autonomy.optional(), pace: BotSchema.shape.pace.optional(), model: BotSchema.shape.model.optional(),
  watches: z.array(WatchProposeInputSchema).optional(), goals: z.array(InitialGoalSchema).optional(),
});
export const RuleInputSchema = RuleSchema.pick({ scope: true, text: true }).extend({ id: RuleSchema.shape.id.optional(),
  redLine: RuleSchema.shape.redLine.optional(), status: RuleSchema.shape.status.optional() });
export const PageSchema = z.strictObject({ before: z.union([nonempty, z.number().int()]).optional(),
  limit: z.number().int('条数必须是整数').min(1, '条数至少为 1').max(C04_DEFAULTS.VIEW_PAGE_MAX, '单页条数过多').optional() });
