/** 小型统计工具采用总体标准差；空样本、单样本或全零均值不制造 NaN，便于仿真比较。 */

function assertFinite(values: readonly number[]): void {
  if (values.some((value) => !Number.isFinite(value))) throw new Error('统计样本必须全部为有限数值');
}

/** 计算样本均值，空样本返回零以便汇总无记录的情况。 */
export function mean(values: readonly number[]): number {
  assertFinite(values);
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 计算总体标准差，衡量思考间隔的波动幅度。 */
export function stddev(values: readonly number[]): number {
  assertFinite(values);
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

/** 节奏间隔应为正数；均值为零时约定返回 0，避免把不可定义的比值传入排序。 */
export function coefficientOfVariation(values: readonly number[]): number {
  assertFinite(values);
  if (values.length < 2) return 0;
  const average = mean(values);
  return average === 0 ? 0 : stddev(values) / Math.abs(average);
}
