/** 人工时钟让一天或一周的仿真只需移动数字，不需要真实等待。 */
import type { Clock } from '../interfaces.js';
/** 通过显式推进时间模拟长周期，让测试无需真实等待。 */
export class FakeClock implements Clock {
  /** 校验初始毫秒值，避免无效时间进入仿真。 */
  constructor(private currentMs = 0) { this.set(currentMs); }
  /** 返回当前模拟时刻，保持与真实时钟相同的调用契约。 */
  now(): number { return this.currentMs; }
  /** 向前推进指定毫秒，拒绝倒退和非有限输入。 */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('推进时间必须是非负有限毫秒数');
    this.set(this.currentMs + ms);
  }
  /** 直接设定测试时刻，允许测试重置场景并拒绝非有限值。 */
  set(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error('时钟必须是有限毫秒数');
    this.currentMs = ms;
  }
}
