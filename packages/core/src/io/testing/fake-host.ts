/** 记录调用的假宿主：仅模拟会话目录和投递结果，不运行机器人或实现 C04 仿真大脑。 */
import type { HostPort, MessageSource } from '../../model/index.js';
/** 保存会话状态和宿主调用，供测试验证行为而不启动真实机器人。 */
export class FakeHost implements HostPort {
  readonly calls: Array<{ method: keyof HostPort; args: unknown[] }> = [];
  readonly sessions = new Map<string, { exists: boolean; running: boolean; contextRatio: number | null }>();
  readonly digests = new Map<string, string>();
  /** 复制调用参数留作证据，避免事后修改对象污染断言。 */
  private record(method: keyof HostPort, args: unknown[]): void { this.calls.push({ method, args: structuredClone(args) }); }
  /** 创建模拟会话并置为运行中，供验证新会话路径。 */
  async createSession(input: Parameters<HostPort['createSession']>[0]): Promise<{ sessionId: string }> {
    this.record('createSession', [input]);
    const sessionId = `fake-session-${this.sessions.size + 1}`;
    this.sessions.set(sessionId, { exists: true, running: true, contextRatio: null });
    return { sessionId };
  }
  /** 记录消息投递而不生成模型回复，供检查唤醒包与来源。 */
  async deliver(sessionId: string, text: string, source: MessageSource): Promise<void> { this.record('deliver', [sessionId, text, source]); }
  /** 记录收口指令，供验证回合上限触发。 */
  async steer(sessionId: string, text: string): Promise<void> { this.record('steer', [sessionId, text]); }
  /** 记录取消并结束模拟运行状态，供验证超时收尾。 */
  async cancel(sessionId: string): Promise<void> {
    this.record('cancel', [sessionId]);
    const s = this.sessions.get(sessionId);
    if(s) s.running = false;
  }
  /** 返回状态副本，缺失会话按不存在处理。 */
  async sessionInfo(sessionId: string) {
    this.record('sessionInfo', [sessionId]);
    return { ...(this.sessions.get(sessionId) ?? { exists: false, running: false, contextRatio: null }) };
  }
  /** 记录历史查询并返回空列表，教学会话由测试显式指定。 */
  async listRecentSessions(limit: number): Promise<Array<{ sessionId: string; title: string; updatedAt: number }>> {
    this.record('listRecentSessions', [limit]);
    return [];
  }
  /** 按请求长度读取预设摘要，避免教学测试依赖真实会话。 */
  async readSessionDigest(sessionId: string, maxChars: number): Promise<string> {
    this.record('readSessionDigest', [sessionId, maxChars]);
    return (this.digests.get(sessionId) ?? '').slice(0, maxChars);
  }
  /** 记录给主人推送的内容，供检查免打扰和预算。 */
  async notify(n: Parameters<HostPort['notify']>[0]): Promise<void> { this.record('notify', [n]); }
}
