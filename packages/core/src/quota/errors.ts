/** 错误分类只检查已提供的文本，优先识别额度与鉴权，避免把全局故障误当单机器人网络问题。 */
export type ErrorClass = 'quota' | 'auth' | 'network' | 'other';

/** 按明确关键词区分额度、鉴权和普通错误，让后续选择正确恢复路径。 */
export function classifyError(text: string): ErrorClass {
  if (/(?<![\w.])429(?![\w.])|rate\s*limit|quota|额度|余额|usage\s*limit|超出/i.test(text)) return 'quota';
  if (/(?<![\w.])(?:401|403)(?![\w.])|unauthorized|invalid\s*api\s*key|鉴权|认证/i.test(text)) return 'auth';
  if (/ECONNRESET|ETIMEDOUT|network|fetch\s*failed|timed\s*out|网络|连接重置|连接超时/i.test(text)) return 'network';
  return 'other';
}
