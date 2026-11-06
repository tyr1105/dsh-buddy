/** 网络适配在读取时限制字节，避免远端大响应占满内存；HTTP 错误状态仍是有效响应。 */
import type { NetIO, NetOptions, NetResult } from './interfaces.js';
import { utf8Prefix } from './utf8-prefix.js';
/** 统一处理真实网络请求的超时和容量，防止远端响应拖垮宿主。 */
export class SystemNet implements NetIO {
  /** 执行有时限的读取请求，保留 HTTP 状态供业务自行判定。 */
  get(url: string, opts: NetOptions): Promise<NetResult> { return this.request('GET', url, undefined, opts); }
  /** 执行经动作闸批准的提交请求，复用相同的读取限制。 */
  post(url: string, body: string, opts: NetOptions): Promise<NetResult> { return this.request('POST', url, body, opts); }
  /** 流式读取有界正文并释放连接；网络异常转为中文错误。 */
  private async request(method: string, url: string, body: string | undefined, opts: NetOptions): Promise<NetResult> {
    if(!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0) throw new Error('网络 maxBytes 必须是非负整数');
    if(!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('网络 timeoutMs 必须是正整数');
    try {
      const response = await fetch(url, {
        method, body, headers: opts.headers, signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let bytes = 0;
      if(reader) {
        try {
          while(bytes < opts.maxBytes) {
            const chunk = await reader.read();
            if(chunk.done) {
              text += decoder.decode();
              break;
            }
            const remaining = opts.maxBytes - bytes;
            const kept = chunk.value.subarray(0, remaining);
            bytes += kept.byteLength;
            // 流式解码暂存不完整的 UTF-8 字符；截断时不输出替换字符。
            text += decoder.decode(kept, { stream: true });
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
      return { status: response.status, text: utf8Prefix(text, opts.maxBytes), contentType: response.headers.get('content-type') ?? '' };
    } catch(error) {
      throw new Error(`网络请求失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}
