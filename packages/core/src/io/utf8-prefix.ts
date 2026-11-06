/** 外部原始输出只保留完整的 UTF-8 字符；不插入说明文字，以免改变命令输出的语义。 */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('字节上限必须是非负整数');
  return new TextDecoder().decode(Buffer.from(text, 'utf8').subarray(0, maxBytes), { stream: true });
}
