/** 中心等待有明确租期：用后续 tick 解除失联宿主或落盘等待，迟到结果不能恢复旧入口。 */
import type { Clock } from '../io/interfaces.js';
import type { HostPort } from '../model/host.js';

/** 不创建计时器；只有宿主再次调用 tick，才按注入时钟检查五分钟保护线。 */
export function createEntryWaits(clock: Clock, timeoutMs: () => number) {
  const pending = new Set<{ label: string; startedAt: number; expire(): void }>();
  function open(label: string, onExpire?: () => void) {
    let expired = false;
    let reject!: (error: Error) => void;
    const interrupted = new Promise<never>((_resolve, fail) => { reject = fail; });
    // 即使入口尚未开始 await，也不把保护线拒绝变成未处理异常。
    void interrupted.catch(() => undefined);
    const item = { label, startedAt: clock.now(), expire() {
      if (expired) return;
      expired = true;
      onExpire?.();
      reject(new Error(`${label}等待超过五分钟，中心已释放通道`));
    } };
    pending.add(item);
    return {
      live: () => !expired,
      wait<T>(operation: Promise<T>): Promise<T> { return Promise.race([operation, interrupted]); },
      close: () => { pending.delete(item); },
    };
  }
  /** 同一次 tick 先中止宿主调用，再解除入口/落盘；外层负责只记一条 P1。 */
  function expire(now: number): string[] {
    const expired: string[] = [];
    for (const item of pending) if (now - item.startedAt > timeoutMs()) {
      expired.push(item.label);
      item.expire();
      pending.delete(item);
    }
    return expired;
  }
  /** 包住全部 HostPort 方法，通知、取消、读摘要与投递享有相同的故障隔离。 */
  function boundHost(host: HostPort): HostPort {
    const stalled = new Map<PropertyKey, Set<object>>();
    return new Proxy(host, { get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if (typeof value !== 'function') return value;
      // 投递链已有两分钟租期；保留原始 Promise，创建会话迟到时 dispatch 仍能拿到身份并取消。
      if (['createSession', 'deliver', 'sessionInfo'].includes(String(key))) return value.bind(target);
      return async (...args: unknown[]) => {
        // 同一个失联方法不能每次 tick 都重新堵住日报/健康阶段；原调用真正结束后自动恢复。
        if (stalled.get(key)?.size) throw new Error(`宿主 ${String(key)} 上次超时仍未返回，本次暂缓调用`);
        const token = {};
        let settled = false;
        const lease = open(`宿主 ${String(key)}`, () => {
          if (settled) return;
          const tokens = stalled.get(key) ?? new Set<object>();
          tokens.add(token); stalled.set(key, tokens);
        });
        try {
          const operation = Promise.resolve(Reflect.apply(value, target, args));
          const finished = () => {
            settled = true;
            stalled.get(key)?.delete(token);
            if (stalled.get(key)?.size === 0) stalled.delete(key);
          };
          void operation.then(finished, finished);
          return await lease.wait(operation);
        } finally { lease.close(); }
      };
    } });
  }
  return { open, expire, boundHost };
}
