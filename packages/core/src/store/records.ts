/** 存储层的最小记录检查和副本工具：旧数据可继续读取，完整业务校验留给领域入口。 */
export type StoredRecord = { id: string; [key: string]: unknown };

/** 启动恢复只要求对象和非空 id，不因未来新增必填字段丢失历史记录。 */
export function isRecord(value: unknown): value is StoredRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && 'id' in value && typeof value.id === 'string' && value.id.trim().length > 0;
}

/** 存储已经把记录归一成 JSON 树；递归复制可复用不可变字符串，避免每分钟查询重拷贝大段审计正文。 */
export function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => clone(item)) as T;
  // 展开语法为所有键创建自有数据属性（包含 __proto__），并让引擎快速复制多数标量字段。
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of Object.keys(value)) {
    const item = (value as Record<string, unknown>)[key];
    // 只对嵌套容器递归；字符串、数字、布尔和 null 已经是安全的值副本。
    if (item !== null && typeof item === 'object') copy[key] = clone(item);
  }
  return copy as T;
}

/** 日志优先使用 at，否则使用 createdAt；不能推断时间时跳过或拒绝。 */
export function recordTime(record: StoredRecord): number | null {
  const value = record.at ?? record.createdAt;
  // Date 的 TimeClip 范围固定为正负 8.64e15 毫秒；直接比较避免排序时反复构造日期对象。
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : null;
}

/** 写入先校验最小身份，错误在入口以中文反馈，不留到异步落盘阶段。 */
export function requireRecord(value: unknown): StoredRecord {
  if (!isRecord(value)) throw new Error('记录 id 必须是非空字符串，且记录必须是对象');
  return value;
}

/** JSON 往返验证并生成落盘副本；可选 undefined 按 JSON 规则处理，禁止悄悄吞掉函数等坏值。 */
export function serializableRecord(value: unknown): StoredRecord {
  requireRecord(value);
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'function' || typeof item === 'symbol'
        || (typeof item === 'number' && !Number.isFinite(item))) {
        throw new Error('包含函数、符号或非有限数字');
      }
      return item;
    });
    return requireRecord(JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error(`记录必须可用 JSON 序列化：${String(error)}`);
  }
}
