/** 错误分类只检查已提供的文本，优先识别额度与鉴权，避免把全局故障误当单机器人网络问题。 */
export type ErrorClass = 'quota' | 'auth' | 'network' | 'other';

/**
 * 额度用完的文字关键词。
 * P76d 补上：使用上限、限额、已达上限、limit reached、rate_limit（下划线写法）。
 * 为什么要补：宿主把限流报错交给中心时，常常只剩正文里的一句话（例如「已达到 5 小时的使用上限，将于 15:53 恢复」），
 * 没有状态码、没有错误代号；原来的关键词一个都对不上，额度灯不会亮，只会被当成普通出错退避重试（P76a 试验一）。
 * P76r2（R7）收窄：不再认单独的 limit reached（「context limit reached」「max steps limit reached」这类与额度无关的报错会被误认）；
 * 只认与额度有关的组合：usage limit reached、rate limit reached、token limit reached、quota 与 reached 或 exceeded 同句出现。
 * 其中 usage limit、rate limit、quota 本来就是单独的关键词，所以这一处实际是删去单独的 limit reached、补上 token limit reached。
 */
const QUOTA_TEXT = /(?<![\w.])429(?![\w.])|rate[\s_]*limit|quota|额度|余额|usage\s*limit|token\s*limit\s*reached|使用上限|已达上限|限额|超出/i;

/**
 * P76r2（R7）：同一句里说的是上下文、步数、轮数、长度、输出的上限，不是额度用完（模型自己的用量上限，不是账户额度）。
 * 英文按整词认（避免 output 之类误伤别的词），中文直接认词。对所有文字关键词（含中文的「已达上限」「使用上限」）同样适用。
 */
const NON_QUOTA_LIMIT = /\b(?:context|steps?|turns?|length|output)\b|上下文|步数|轮数|长度|输出/i;

/** 把报错正文切成句子：句末标点加空白，或中文句号、感叹号、问号、分号，或换行；逗号不切（「已达到 5 小时的使用上限，将于 15:53 恢复」是一句）。 */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|[。！？；;\n\r]+/).filter(part => part.trim() !== '');
}

/** 文字里有没有一句话是「额度用完」：该句命中额度关键词，且这句没有在说上下文、步数、轮数、长度、输出的上限。 */
function textMeansQuota(text: string): boolean {
  return sentencesOf(text).some(sentence => QUOTA_TEXT.test(sentence) && !NON_QUOTA_LIMIT.test(sentence));
}

/**
 * 按明确关键词区分额度、鉴权和普通错误，让后续选择正确恢复路径。
 * P76d：宿主报错对象上若有错误代号和状态码（errorCode、statusCode），先看它们：
 * 代号含 RATE_LIMIT 或 QUOTA（不分大小写），或状态码为 429，直接判为额度用完；之后才看文字。
 * 两个参数都可以省略（旧调用方只给文字）。
 */
export function classifyError(text: string, errorCode?: string | null, statusCode?: number | null): ErrorClass {
  if (statusCode === 429 || (typeof errorCode === 'string' && /RATE_LIMIT|QUOTA/i.test(errorCode))) return 'quota';
  if (textMeansQuota(text)) return 'quota';
  if (/(?<![\w.])(?:401|403)(?![\w.])|unauthorized|invalid\s*api\s*key|鉴权|认证/i.test(text)) return 'auth';
  if (/ECONNRESET|ETIMEDOUT|network|fetch\s*failed|timed\s*out|网络|连接重置|连接超时/i.test(text)) return 'network';
  return 'other';
}
