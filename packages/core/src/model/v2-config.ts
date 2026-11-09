/**
 * v2 配置单例：只存版本与回填进度，不存用户可调开关。
 *
 * 为什么不加进 Settings：SettingsSchema 是 strictObject，旧版本解析 v2 设置会因未知键失败；
 * 新数值默认值统一放 config/defaults.ts 的 V2_DEFAULTS。这个表只是「v2 数据长什么样、
 * 回填做到哪」的标记，方便诊断和未来迁移。
 */
import { z } from 'zod';
import { timestamp } from './primitives.js';

/** 当前 v2 数据结构版本；未来迁移时递增。 */
export const V2_SCHEMA_VERSION = 1;

/** 单例配置行；id 固定为 v2，重复写入天然幂等。 */
export const V2ConfigSchema = z.strictObject({
  id: z.literal('v2'), // 单例标识
  schemaVersion: z.number().int('版本必须是整数').min(1, '版本至少为 1'), // 数据结构版本
  backfillDoneThrough: timestamp.nullable(), // 最近一次回填覆盖到的时间；只作诊断
  createdAt: timestamp, // 首次创建时间
  updatedAt: timestamp, // 最近修改时间
});
export type V2Config = z.infer<typeof V2ConfigSchema>;
