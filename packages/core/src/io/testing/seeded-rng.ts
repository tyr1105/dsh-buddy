/** mulberry32 确定性随机源：固定种子能够逐步重放同一条仿真轨迹。 */
import type { Rng } from '../interfaces.js';
/** 固定种子复现随机序列，便于重放 ID 和退避轨迹。 */
export class SeededRng implements Rng {
  private state: number;
  /** 把安全整数种子归一化到 32 位状态，确保跨次测试一致。 */
  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new Error('随机种子必须是安全整数');
    this.state = seed >>> 0;
  }
  /** 推进确定性状态并返回区间内随机值，不读取机器环境。 */
  next(): number {
    // 每一步仅依赖上一步的 32 位状态，不读取机器环境。
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(this.state ^ (this.state >>> 15), this.state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
}
