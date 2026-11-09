/**
 * 公共知识库连接配置（P38）：一个纯可选、默认关闭的远程只读知识层。
 *
 * 设计纪律（对应任务卡口径）：
 * - 产品只提供能力，不预置任何具体值；enabled 默认 false，空配置即关闭，
 *   关闭时唤醒包与工具行为与今天完全一致。
 * - authRef 只存「凭据引用」（宿主安全存储里的名字/键），绝不存明文，
 *   也不允许进入日志、审计与唤醒包。
 * - 只允许 https 且主机必须来自用户填写的 endpoint；具体协议适配等 I15
 *   主人给出 wiki 访问方式后再补，本卡不假设任何厂商。
 * - readOnly 用字面量 true 锁死：知识库对全队只读，没有任何写入路径。
 */
import { z } from 'zod';

/** 各文本字段的保守长度上限，防止设置项本身变成无界输入。 */
export const KNOWLEDGE_ENDPOINT_MAX = 2000;
export const KNOWLEDGE_AUTH_REF_MAX = 120;
export const KNOWLEDGE_PROTOCOL_MAX = 40;
export const KNOWLEDGE_SCOPE_MAX = 200;
/** 单条知识条目实时读取的字节上下限：最小 1 KiB 防误填，最大 1 MiB 防拖垮回合。 */
export const KNOWLEDGE_MAX_BYTES_MIN = 1024;
export const KNOWLEDGE_MAX_BYTES_MAX = 1024 * 1024;
/** 唤醒包里知识库段的摘要上限（任务卡：≤1.5KB），只放入口说明，不放条目正文。 */
export const KNOWLEDGE_PACKET_MAX_BYTES = 1536;
/** 检索关键词与条目 id 的输入上限，挡住把整段正文当查询塞进工具。 */
export const KNOWLEDGE_QUERY_MAX = 120;
export const KNOWLEDGE_ENTRY_ID_MAX = 200;
/** 一次检索最多返回多少条，界面与工具共用同一保守上限。 */
export const KNOWLEDGE_SEARCH_LIMIT_MAX = 20;

/** 解析 endpoint；只接受 https 且带主机的绝对地址，其余一律 null（不当作合法配置）。 */
export function parseKnowledgeEndpoint(endpoint: string): URL | null {
  const trimmed = endpoint.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname === '') return null;
  return url;
}

/** 凭据引用只允许常见键名字符，禁止空白与控制字符；空串表示无鉴权（公开库）。 */
const authRefPattern = /^[\w.\-:/@]*$/;

export const KnowledgeBaseConfigSchema = z.strictObject({
  // 总开关：默认关；关着的时候允许保存半成品（endpoint 暂空），开着就必须填齐。
  enabled: z.boolean(),
  endpoint: z.string().max(KNOWLEDGE_ENDPOINT_MAX, `连接地址不能超过 ${KNOWLEDGE_ENDPOINT_MAX} 字`),
  authRef: z.string().max(KNOWLEDGE_AUTH_REF_MAX, `凭据引用不能超过 ${KNOWLEDGE_AUTH_REF_MAX} 字`),
  // 协议适配名（如未来的 'generic-json'）；I15 未确认前没有任何内置实现，留空即未适配。
  protocol: z.string().max(KNOWLEDGE_PROTOCOL_MAX, `协议名不能超过 ${KNOWLEDGE_PROTOCOL_MAX} 字`),
  // 检索范围（库内空间/目录/集合的名字），空串表示库里全部；由远端解释，core 不拼装。
  scope: z.string().max(KNOWLEDGE_SCOPE_MAX, `检索范围不能超过 ${KNOWLEDGE_SCOPE_MAX} 字`),
  // 字面量锁死只读：想关只读等于改产品边界，直接校验失败。
  readOnly: z.literal(true, { error: '公共知识库始终只读，readOnly 不能为 false' }),
  maxBytes: z.number().int('单条读取上限必须是整数')
    .min(KNOWLEDGE_MAX_BYTES_MIN, `单条读取上限至少 ${KNOWLEDGE_MAX_BYTES_MIN} 字节`)
    .max(KNOWLEDGE_MAX_BYTES_MAX, `单条读取上限最多 ${KNOWLEDGE_MAX_BYTES_MAX} 字节`),
}).superRefine((value, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (value.authRef !== '' && !authRefPattern.test(value.authRef)) {
    issue('authRef', '凭据引用只能含字母数字与 . - : / @ _，不要填明文凭据');
  }
  if (value.protocol !== '' && !/^[a-z][a-z0-9_-]*$/.test(value.protocol)) {
    issue('protocol', '协议名只能是小写字母开头的小写字母、数字、下划线或短横线');
  }
  // endpoint 非空时无论开关都必须是合法 https，避免关掉时存一份以后一开就炸的地址。
  if (value.endpoint.trim() !== '' && parseKnowledgeEndpoint(value.endpoint) === null) {
    issue('endpoint', '连接地址必须是 https:// 开头的绝对地址（含主机名），不允许 http 或相对地址');
  }
  // 打开开关时三项必须齐备；缺项给逐项中文错误，不让主人对着远端报错排查。
  if (value.enabled) {
    if (value.endpoint.trim() === '') issue('endpoint', '启用公共知识库必须先填写连接地址');
    if (value.protocol.trim() === '') issue('protocol', '启用公共知识库必须填写协议适配名（访问方式未确认前先保持关闭）');
  }
});

export type KnowledgeBaseConfig = z.infer<typeof KnowledgeBaseConfigSchema>;

/** 配置是否达到「可以发起检索」的状态：开关开、地址合法、协议名已填。 */
export function isKnowledgeConfigured(config: KnowledgeBaseConfig): boolean {
  return config.enabled && parseKnowledgeEndpoint(config.endpoint) !== null && config.protocol.trim() !== '';
}

/** 取 endpoint 的主机名用于展示与同源校验；未配置或非法时返回 null。 */
export function knowledgeHost(config: KnowledgeBaseConfig): string | null {
  return parseKnowledgeEndpoint(config.endpoint)?.hostname ?? null;
}
