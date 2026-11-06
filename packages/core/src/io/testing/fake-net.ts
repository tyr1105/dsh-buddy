/** 按 URL 预设网络结果，并记录调用参数；未预设时失败，防止测试意外访问真实网络。 */
import type { NetIO, NetOptions, NetResult } from '../interfaces.js';
import { utf8Prefix } from '../utf8-prefix.js';
/** 按 URL 返回预设响应，测试不能意外发起真实网络请求。 */
export class FakeNet implements NetIO {
  readonly calls: Array<{ method: 'GET' | 'POST'; url: string; body?: string; opts: NetOptions }> = [];
  private readonly responses = new Map<string, NetResult | Error>();
  /** 复制预设响应或保存错误，避免调用方后续修改测试结果。 */
  set(url: string, response: NetResult | Error): this {
    this.responses.set(url, response instanceof Error ? response : { ...response });
    return this;
  }
  /** 模拟 GET 并记录参数，复用预设结果和字节限制。 */
  get(url: string, opts: NetOptions): Promise<NetResult> { return this.request('GET', url, undefined, opts); }
  /** 模拟 POST 并保存请求正文，供核对出站动作。 */
  post(url: string, body: string, opts: NetOptions): Promise<NetResult> { return this.request('POST', url, body, opts); }
  /** 查找预设、记录调用并截断正文，未预设时明确失败。 */
  private async request(method: 'GET' | 'POST', url: string, body: string | undefined, opts: NetOptions): Promise<NetResult> {
    this.calls.push({ method, url, body, opts: structuredClone(opts) });
    const response = this.responses.get(url);
    if(!response) throw new Error(`未预设网络结果：${url}`);
    if(response instanceof Error) throw response;
    return { ...response, text: utf8Prefix(response.text, opts.maxBytes) };
  }
}
