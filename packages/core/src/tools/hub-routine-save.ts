/** 套路保存工具将模型总结转成可编辑的编号步骤与持久化文件。 */
import { z } from 'zod';
import { saveRoutine } from '../routines/index.js';
import { defineTool, requiredText } from './common.js';
export const RoutineSaveInputSchema = z.strictObject({ name: requiredText, whenToUse: requiredText, steps: z.array(requiredText).min(1, '步骤至少一条'), learnedFrom: requiredText.optional() });
export const hubRoutineSave = defineTool('hub_routine_save', '保存可复用套路：name 名称、whenToUse 使用条件、steps 具体步骤、learnedFrom 来源；同名更新，并追加修订记录，所有等级可用。', RoutineSaveInputSchema, 'all', async (ctx, tc, args) => {
    const row = await saveRoutine(ctx, tc.botId, args);
    return { ok: true, text: `套路已保存：${row.name}（playbooks/${row.slug}.md）` };
});
