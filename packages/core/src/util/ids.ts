/** ID 只依赖注入随机源；固定 10 位 base36 便于日志定位，也可在测试中复现。 */
import type { Rng } from '../io/index.js';

/** 按领域前缀生成可复现的短 ID；验证随机值边界，防止产生不合法标识。 */
export function newId(prefix: string, rng: Rng): string {
  if (!/^[a-z][a-z0-9]*$/.test(prefix)) throw new Error('ID 前缀必须以小写字母开头，只能包含小写字母和数字');
  let suffix = '';
  for (let index = 0; index < 10; index += 1) {
    const value = rng.next();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('随机源必须返回大于等于 0 且小于 1 的数值');
    suffix += Math.floor(value * 36).toString(36);
  }
  return `${prefix}_${suffix}`;
}
