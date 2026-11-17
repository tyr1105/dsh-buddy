/**
 * 工具 hub_team_propose（P73d）：总管为已固定的约定推荐一位新员工、按主人的话修改待确认的组队卡、撤下组队卡。
 *
 * 工具层只做三件事：解析参数、找到本回合的唤醒单、调用 team/addition.ts 的 runTeamPropose 并把结果翻成一句话。
 * 身份（只有总管）、回合（必须由主人发起）、内容校验都在服务层，这里不重复判断。
 * 工具注册给所有员工，非总管调用时在服务层被拒绝（与 hub_agreement_submit 同一做法）。
 * 卡片不在这里发：工具只写表，交账路由 routeCommit 里再发卡（见 team/cards.ts）。
 * 复盘回合禁止调用：在 tools/common.ts 的 reflectionWrites 里登记。
 */
import { z } from 'zod';
import { recordId } from '../model/primitives.js';
import { runTeamPropose } from '../team/addition.js';
import { defineTool } from './common.js';

/** 带长度范围的一段文字：去首尾空白，1 到 max 字（按完整字符计）。 */
function limited(max: number, label: string) {
  return z.string({ error: `${label}：必须是文字` }).trim().min(1, `${label}：不能为空`)
    .refine(value => [...value].length <= max, `${label}：不能超过 ${max} 字`);
}

/** 参数：根节点是对象，不用联合类型（模型接口对联合类型的识别不稳定）。 */
export const HubTeamProposeInputSchema = z.strictObject({
  mode: z.enum(['propose', 'revise', 'withdraw']).optional()
    .describe('propose 推荐新员工（省略即 propose）；revise 按主人的话修改待确认的组队卡；withdraw 撤下待确认的组队卡'),
  proposalId: recordId('tpr').optional().describe('组队卡编号（唤醒包「组队」段里有）；revise、withdraw 必填'),
  template: limited(40, 'template').optional()
    .describe('模板名或模板编号，写模板名即可（唤醒包「可推荐的模板」里的名字）；propose 必填；revise 时表示换成这个模板'),
  agreementId: recordId('agr').optional().describe('为哪份已固定的约定加人（唤醒包约定段里有编号）；propose 必填'),
  needReason: limited(80, 'needReason').optional().describe('这件事为什么需要这个角色，不超过 80 字；propose 必填'),
  residentReason: limited(80, 'residentReason').optional().describe('为什么值得常驻，以后还会用到哪些事，不超过 80 字；propose 必填'),
  name: limited(20, 'name').optional().describe('revise：要改的是卡上哪一位，写卡上的名字；卡上只有一位时可省略'),
  brief: limited(1000, 'brief').optional().describe('revise：这位的员工说明全文（整段替换，不是追加），不超过 1000 字'),
  reason: limited(80, 'reason').optional().describe('withdraw 必填：为什么撤下，不超过 80 字'),
});

/** 工具说明：模型看到的全部使用规则。 */
const DESCRIPTION = '（仅总管）推荐新员工，或修改、撤下待确认的组队卡。只能在主人发话、确认或回答叫醒的回合里用。propose：约定已固定、在岗员工里缺少需要的角色、而且以后还会反复用到时，推荐一位：template 写模板名即可（唤醒包「可推荐的模板」里的名字），agreementId 写这份约定，needReason 写这件事为什么需要这个角色，residentReason 写为什么值得常驻；卡片在你交账后发给主人，确认前不要把这件事交给任何人。revise：主人要改卡上某位的员工说明或换成别的模板时，proposalId 写卡片编号，name 写卡上的名字，brief 写完整的员工说明（整段替换），或 template 写新模板名。withdraw：proposalId 写卡片编号，reason 写原因。一句话用一次：同一条主人消息只能产生一张组队卡，也只能修改同一张卡一次。你不能替主人确认入职。';

export const hubTeamPropose = defineTool('hub_team_propose', DESCRIPTION, HubTeamProposeInputSchema, 'L1', async (ctx, tc, args) => {
  // 取本回合的唤醒单：宿主给了 wakeId 就用它；没给就找这个员工当前打开的唤醒单（口径与 hub_agreement_submit 一致）。
  const wake = tc.wakeId
    ? ctx.store.table('wakes').get(tc.wakeId)
    : ctx.store.table('wakes').list(row => row.botId === tc.botId && row.sessionId === tc.sessionId
      && (['running', 'delivering'].includes(row.status) || (row.status === 'committed' && row.endedAt === null)))
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  if (!wake) throw new Error('组队卡只能在回合里提出或修改');
  return { ok: true, text: await runTeamPropose(ctx, tc.botId, wake, args) };
});
