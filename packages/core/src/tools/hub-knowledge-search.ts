/**
 * 公共知识库检索工具（P38）：队友按关键词实时检索远程只读知识库。
 *
 * 纪律：
 * - 只读工具，所有在岗等级（含 L0 与试岗）均可调用，与 hub_resource_list 同级；
 * - 未配置时不发任何网络请求，如实回「未配置公共知识库」，不伪装成空结果；
 * - 协议暂无适配（I15 未确认）时给中文失败，不假设任何具体厂商；
 * - 只返回命中条目的 id、标题、位置与摘要，正文必须再走 hub_knowledge_read。
 */
import { z } from 'zod';
import { defineTool, requiredText } from './common.js';
import { KNOWLEDGE_QUERY_MAX, KNOWLEDGE_SEARCH_LIMIT_MAX } from '../model/knowledge-base.js';
import { KNOWLEDGE_UNCONFIGURED_TEXT, searchKnowledge } from '../knowledge/index.js';

/** query 必填且有长度上限；limit 可选，越界由服务层收口，strictObject 拦未知字段。 */
export const HubKnowledgeSearchInputSchema = z.strictObject({
  query: requiredText.max(KNOWLEDGE_QUERY_MAX, `检索关键词不能超过 ${KNOWLEDGE_QUERY_MAX} 字`),
  limit: z.number().int('limit 必须是整数').min(1, 'limit 至少为 1')
    .max(KNOWLEDGE_SEARCH_LIMIT_MAX, `limit 最多为 ${KNOWLEDGE_SEARCH_LIMIT_MAX}`).optional(),
});

export const hubKnowledgeSearch = defineTool('hub_knowledge_search',
  '检索全队公共知识库（只读远程 wiki）：按关键词返回条目的 id、标题、位置与摘要，不返回正文；读正文用 hub_knowledge_read。未配置知识库时会如实说明。',
  HubKnowledgeSearchInputSchema, 'all', async (ctx, tc, args) => {
    const outcome = await searchKnowledge(ctx, tc.botId, args.query, args.limit);
    if (outcome.status === 'unconfigured') return { ok: true, text: KNOWLEDGE_UNCONFIGURED_TEXT };
    if (outcome.status === 'unsupported') {
      return { ok: false, error: `公共知识库协议「${outcome.protocol}」暂无适配，请等主人在设置里更新连接方式` };
    }
    const { hits, truncated } = outcome.output;
    if (hits.length === 0) return { ok: true, text: '公共知识库没有检索到相关条目。' };
    const lines = hits.map(hit => [
      `- [${hit.id}] ${hit.title}`,
      `  位置：${hit.location}`,
      hit.snippet.trim() === '' ? null : `  摘要：${hit.snippet}`,
    ].filter((line): line is string => line !== null).join('\n'));
    const head = `公共知识库命中 ${hits.length} 条${truncated ? '（结果已截断，换更具体的关键词再试）' : ''}：`;
    return { ok: true, text: `${head}\n${lines.join('\n')}` };
  });
