/** 稳定序列化与哈希：同一份结构化内容不因对象键顺序不同而产生不同指纹。 */
import { createHash } from 'node:crypto';

/** 计算 UTF-8 正文的 SHA-1，用于发现内容变化。 */
export function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 计算 SHA-256 内容摘要，为审批票绑定精确动作参数。 */
export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 删除 undefined 项，对象键排序、数组元素保持相对顺序；循环或非 JSON 内容明确拒绝。 */
export function stableStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === undefined) return undefined;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('稳定序列化不支持非有限数值');
      return item;
    }
    if (typeof item !== 'object') throw new Error('稳定序列化只支持 JSON 值');
    if (ancestors.has(item)) throw new Error('稳定序列化不支持循环引用');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.filter((entry) => entry !== undefined).map(normalize);
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('稳定序列化只支持普通对象与数组');
      const normalized = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(item).sort()) {
        const entry = (item as Record<string, unknown>)[key];
        if (entry !== undefined) normalized[key] = normalize(entry);
      }
      return normalized;
    } finally {
      ancestors.delete(item);
    }
  };
  // 根值缺失用 null 表示，使返回值始终是可用于哈希的字符串。
  return JSON.stringify(normalize(value) ?? null);
}

/** 使用数组编码保留参数边界，避免 ('ab','c') 与 ('a','bc') 碰撞。 */
export function fingerprint(...parts: unknown[]): string {
  return sha1Hex(stableStringify(parts)).slice(0, 16);
}
