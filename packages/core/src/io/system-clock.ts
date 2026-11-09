/** 唯一读取机器当前时间的时钟实现；测试使用 FakeClock 避免等待。 */
import type { Clock } from './interfaces.js';
/** 将真实时钟限制在系统适配层，业务可替换为假时钟。 */
export class SystemClock implements Clock {
  /** 提供当前 Unix 毫秒，供注入接口的调用方计算时间差。 */
  now(): number { return Date.now(); }
}
