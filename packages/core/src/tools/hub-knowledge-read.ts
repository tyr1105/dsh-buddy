/**
 * 公共知识库条目读取工具（P38）：按检索命中的 id 实时读取单条目正文。
 *
 * 纪律：
 * - 只读工具，所有在岗等级均可调用；正文受 Settings.knowledgeBase.maxBytes 收口；
 * - 每次读取记 knowledge_read 审计（谁、哪条、多大），正文与凭据不进审计；
 * - 未配置不发请求、回固定说明；协议无适配时中文失败，不静默编造内容。
 */
import { z } from 'zod';
import { defineTool, requiredText } from './common.js';
import { KNOWLEDGE_ENTRY_ID_MAX } from '../model/knowledge-base.js';
import { KNOWLEDGE_UNCONFIGURED_TEXT, readKnowledge } from '../knowledge/index.js';

/** id 来自检索结果，只做形状校验；不存在或过期由远端适配返回中文错误。 */
export const HubKnowledgeReadInputSchema = z.strictObject({
  id: requiredText.max(KNOWLEDGE_ENTRY_ID_MAX, `条目 id 不能超过 ${KNOWLEDGE_ENTRY_ID_MAX} 字`),
});

export const hubKnowledgeRead = defineTool('hub_knowledge_read',
  '按 id 读取公共知识库条目的正文（只读、实时获取，受字节上限约束）；id 来自 hub_knowledge_search 的检索结果。',
  HubKnowledgeReadInputSchema, 'all', async (ctx, tc, args) => {
    const outcome = await readKnowledge(ctx, tc.botId, args.id);
    if (outcome.status === 'unconfigured') return { ok: true, text: KNOWLEDGE_UNCONFIGURED_TEXT };
    if (outcome.status === 'unsupported') {
      return { ok: false, error: `公共知识库协议「${outcome.protocol}」暂无适配，请等主人在设置里更新连接方式` };
    }
    const { entry, truncated } = outcome;
    const header = `[${entry.id}] ${entry.title}\n位置：${entry.location}`;
    const footer = truncated ? `\n（正文超过读取上限，已截断；完整内容请看原位置：${entry.location}）` : '';
    return { ok: true, text: `${header}\n\n${entry.text}${footer}` };
  });
