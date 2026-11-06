/** 投递等待只用注入时钟判断截止；tick 可在串行入口外解除挂起，避免宿主不返回时整个中心停摆。 */
import type { HubContext } from './context.js';

/** 每次投递独立登记截止与拒绝出口，不借用系统计时器或依赖宿主 Promise 自行结束。 */
export function createDeliveryWaits(ctx: HubContext) {
  const pending = new Map<string, { deadline: number; expire(): void }>();
  /** 在任一 tick 入口先检查，重叠 tick 也必须能终止前一轮挂起的投递等待。 */
  function expire(now: number): void {
    for (const item of pending.values()) if (now > item.deadline) item.expire();
  }
  /** 创建同一投递链共用的拒绝信号；迟到的宿主结果不能再把错误唤醒单改回运行中。 */
  function open(wakeId: string) {
    let expired = false;
    let reject!: (error: Error) => void;
    const timeout = new Promise<never>((_resolve, fail) => { reject = fail; });
    pending.set(wakeId, { deadline: ctx.clock.now() + ctx.settings.c02.deliveryTimeoutMs,
      expire() {
        if (expired) return;
        expired = true;
        reject(new Error('投递超过两分钟仍未收到开始事件'));
      } });
    // 主人取消先落终态，再释放当前 Promise；迟到结果通过终态检查被隔离。
    ctx.runtime.deliveryInterrupts.set(wakeId, () => { reject(new Error('主人已打断本次投递')); });
    return {
      /** 每个宿主调用共享一条超时链，成功后继续，超时后后续步骤不再执行。 */
      wait<T>(operation: Promise<T>): Promise<T> { return Promise.race([operation, timeout]); },
      expired: () => expired,
      close: () => { pending.delete(wakeId); ctx.runtime.deliveryInterrupts.delete(wakeId); },
    };
  }
  return { open, expire };
}
