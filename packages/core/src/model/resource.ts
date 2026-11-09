/**
 * 资料可见性模型（v2 计划 3.3）：资料 Resource 与授权 Grant。
 *
 * 为什么独立建表而不是给队友挂路径：
 * - 资料是「被引用的对象」，授权对象只认队友本人，生命周期与队友在岗状态不同步；
 * - 资料只归档不删除，授权保留但归档资料读取一律返回「已归档」，保证历史可追溯；
 * - 与项目模型一样走独立 strictObject 表，旧存档缺表时视图自然为空，不需要改任何现有实体。
 *
 * 边界：本模型只管「中心资料层」（唤醒包摘要与 hub_resource_* 工具），
 * 不是系统级文件隔离——DSH 会话内的直接文件读取不受这套授权限制（计划 3.3 执行边界）。
 */
import { z } from 'zod';
import { nonempty, recordId, text, timestamp } from './primitives.js';

/** 资料类型：目录、文件、链接、笔记。note 本期保守拒绝创建，后续版本支持。 */
export const RESOURCE_KINDS = ['dir', 'file', 'url', 'note'] as const;
export const ResourceKindSchema = z.enum(RESOURCE_KINDS, { error: '资料类型必须是 dir、file、url、note 之一' });
export type ResourceKind = z.infer<typeof ResourceKindSchema>;
export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  dir: '目录', file: '文件', url: '链接', note: '笔记',
};

/** 敏感级别：normal 全队在岗可读；restricted 只按显式授权读取。 */
export const RESOURCE_SENSITIVITIES = ['normal', 'restricted'] as const;
export const ResourceSensitivitySchema = z.enum(RESOURCE_SENSITIVITIES, { error: '资料敏感性必须是 normal 或 restricted' });
export type ResourceSensitivity = z.infer<typeof ResourceSensitivitySchema>;
export const RESOURCE_SENSITIVITY_LABELS: Record<ResourceSensitivity, string> = {
  normal: '全员可读', restricted: '指定队友可读',
};

/**
 * 一份注册进中心资料层的资料。
 * locator：dir/file 为 rootDir/shared 子树内的绝对路径；url 为 http(s) 地址；note 预留。
 */
export const ResourceSchema = z.strictObject({
  id: recordId('res'), // 资料 id，前缀 res_
  name: nonempty.max(120, '资料名称不能超过 120 字'), // 资料名，唤醒包与工具列表都显示它
  kind: ResourceKindSchema, // 资料类型，创建后不允许修改
  locator: text.min(1, '资料位置不能为空').max(1000, '资料位置不能超过 1000 字'), // 路径、URL 或未来的笔记 id
  sensitivity: ResourceSensitivitySchema, // 普通全队在岗可读；受限必须命中授权
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(), // 归档不删除；归档后拒绝新授权、读取返回「已归档」
});
export type Resource = z.infer<typeof ResourceSchema>;

/** 授权对象类型：只保留队友本人（编制取消后不再有席位与部门授权）。 */
export const GRANT_SUBJECT_KINDS = ['bot'] as const;
export const GrantSubjectKindSchema = z.enum(GRANT_SUBJECT_KINDS, { error: '授权对象必须是 bot（队友本人）' });
export type GrantSubjectKind = z.infer<typeof GrantSubjectKindSchema>;
export const GRANT_SUBJECT_KIND_LABELS: Record<GrantSubjectKind, string> = {
  bot: '队友',
};

/** 授权级别：read 只读；write 可读可写（本期工具只消费读语义，写为后续资料治理预留）。 */
export const GRANT_LEVELS = ['read', 'write'] as const;
export const GrantLevelSchema = z.enum(GRANT_LEVELS, { error: '授权级别必须是 read 或 write' });
export type GrantLevel = z.infer<typeof GrantLevelSchema>;
export const GRANT_LEVEL_LABELS: Record<GrantLevel, string> = { read: '只读', write: '读写' };

/**
 * 一条资料授权。去重自然键为 resourceId + subjectKind + subjectId（同键改 level，不新增行）。
 * 本期只有主人能授权，所以 createdBy 固定 'owner'；没有撤销（revoke）命令，归档资料即拒绝新授权。
 */
export const GrantSchema = z.strictObject({
  id: recordId('gr'), // 授权 id，前缀 gr_
  resourceId: recordId('res'), // 被授权的资料
  subjectKind: GrantSubjectKindSchema, // 授权对象类型（当前只有 bot）
  subjectId: nonempty, // 队友 b_ 的 id，前缀与存在性由服务层校验
  level: GrantLevelSchema, // read 或 write；write 同样赋予读取资格
  createdAt: timestamp,
  createdBy: z.literal('owner', { error: '资料授权只能由主人授予' }),
});
export type Grant = z.infer<typeof GrantSchema>;
