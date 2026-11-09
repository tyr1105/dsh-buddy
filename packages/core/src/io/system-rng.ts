/** 系统随机源只用于生成非秘密标识；测试由固定种子的随机源替换。 */
import type { Rng } from './interfaces.js';
/** 封装系统随机源，使业务算法不依赖全局随机函数。 */
export class SystemRng implements Rng {
  /** 产生区间内随机数，供 ID 和重排抖动共用。 */
  next(): number { return Math.random(); }
}
