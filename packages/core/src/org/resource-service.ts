/**
 * 资料服务层（v2 计划 3.3；主人取消编制后简化）：主人的三条资料命令
 * saveResource / archiveResource / setGrant。
 *
 * 与项目服务同一纪律：纯判定在 org/access.ts，这里集中处理生成 id、写表、审计、发界面事件；
 * 所有校验通过后才消耗 RNG 与写审计，失败命令不耗随机序列、不留半条记录。
 * 路径注册时就强制收敛到 rootDir/shared 子树，避免资料工具变成任意文件读取器。
 */
import { posix } from 'node:path';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import type { Grant, GrantLevel, GrantSubjectKind, Resource, ResourceKind, ResourceSensitivity } from '../model/resource.js';
import {
  GrantLevelSchema, GrantSchema, GrantSubjectKindSchema, ResourceKindSchema,
  ResourceSchema, ResourceSensitivitySchema,
} from '../model/resource.js';
import { nonempty, recordId, text } from '../model/primitives.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { newId } from '../util/ids.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { isSensitive, within } from '../gate/paths.js';

/** 资料命令入参；id 缺省表示新建。kind 创建后不可改，修改命令也必须带上原类型。 */
export const SaveResourceSchema = z.strictObject({
  id: recordId('res').optional(),
  name: nonempty.trim().min(1, '资料名称不能为空').max(120, '资料名称不能超过 120 字'),
  kind: ResourceKindSchema,
  locator: text.trim().min(1, '资料位置不能为空').max(1000, '资料位置不能超过 1000 字'),
  sensitivity: ResourceSensitivitySchema.optional(),
});
export type SaveResourceInput = z.infer<typeof SaveResourceSchema>;

/** 授权命令入参；同 resourceId+subjectKind+subjectId 再设即改 level（upsert）。 */
export const SetGrantSchema = z.strictObject({
  resourceId: recordId('res'),
  subjectKind: GrantSubjectKindSchema,
  subjectId: nonempty,
  level: GrantLevelSchema,
});
export type SetGrantInput = z.infer<typeof SetGrantSchema>;

/** 取消授权入参：和授权用同一组自然键，不需要级别。 */
export const RevokeGrantSchema = SetGrantSchema.omit({ level: true });

export const ResourceIdSchema = recordId('res');

/**
 * 把 dir/file 资料的 locator 校验并折叠到 `${rootDir}/shared` 子树内，返回规范化路径。
 * 复用 gate/paths 的 within（大小写折叠、NFC）思路：相对路径、家目录变量、反引号、
 * ../ 逃逸、敏感凭据位置一律在注册时拒绝，而不是等读取时才拦。
 */
export function resolveSharedLocator(locator: string, rootDir: string): string {
  if (locator.includes('\0')) throw new Error('资料路径不能包含空字符');
  // 含 ~、$、反引号的路径在动作闸里属于「无法确定」，资料注册不接受这种歧义位置。
  if (locator.startsWith('~') || /[$`]/.test(locator)) {
    throw new Error('资料路径不能使用 ~、$ 变量或反引号，请填写 rootDir/shared 子树内的绝对路径');
  }
  if (!posix.isAbsolute(locator)) {
    throw new Error(`资料路径必须是绝对路径且位于共享目录内：${locator}`);
  }
  // normalize 会折叠内部的 ./ 与 ../，再与共享根做前缀比较，挡掉越界逃逸。
  const normalized = posix.normalize(locator);
  const sharedDir = posix.join(rootDir, 'shared');
  if (!within(normalized, sharedDir)) {
    throw new Error(`资料路径必须位于共享目录 ${sharedDir} 之内，不能注册共享目录外的文件：${locator}`);
  }
  if (isSensitive(normalized)) {
    throw new Error(`资料路径指向凭据或环境文件（如 .env、密钥），不能注册为资料：${locator}`);
  }
  return normalized;
}

/** url 资料只接受真实 http/https 地址，与关注项的网页地址口径一致。 */
export function assertHttpLocator(locator: string): void {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error(`资料链接必须是有效的 http 或 https 地址：${locator}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`资料链接只支持 http 或 https，收到 ${url.protocol} 地址`);
  }
}

/** 按类型校验 locator；note 本期保守拒绝，返回固定中文说明。 */
function validateLocator(kind: ResourceKind, locator: string, rootDir: string): string {
  if (kind === 'note') throw new Error('笔记资料后续版本支持，本期暂不能创建 note 类型资料');
  if (kind === 'url') {
    assertHttpLocator(locator);
    return locator.trim();
  }
  return resolveSharedLocator(locator, rootDir);
}

/** 资料变化属于全队结构变化：发 overview（插件在该 scope 里同时刷新资料与办公室），botId 固定为 null。 */
function notifyResources(ctx: HubContext): void {
  ctx.emit(HUB_EVENT_SCOPES.overview, null);
}

/** 新建或修改资料；未归档资料数受 RESOURCE_MAX_ACTIVE 防误操作上限保护。 */
export function saveResource(ctx: HubContext, raw: unknown): Resource {
  const input = parseInput(SaveResourceSchema, raw, '资料保存');
  const now = ctx.clock.now();
  const existing = input.id ? ctx.store.table('resources').get(input.id) : null;
  if (input.id && !existing) throw new Error(`资料不存在：${input.id}`);
  if (existing && existing.archivedAt !== null) throw new Error(`资料「${existing.name}」已归档，不能再修改`);
  // 资料类型决定读取方式与子路径约束，创建后允许修改会混淆边界，本期不允许。
  if (existing && existing.kind !== input.kind) {
    throw new Error(`资料类型创建后不能修改（原为 ${existing.kind}），请新建资料`);
  }
  // 先做全部校验（路径、数量上限），任何一条不过都不生成 id、不写审计。
  const locator = validateLocator(input.kind, input.locator, ctx.settings.rootDir);
  if (!existing && ctx.store.table('resources').count(r => r.archivedAt === null) >= V2_DEFAULTS.RESOURCE_MAX_ACTIVE) {
    throw new Error(`资料数量已达防误操作上限 ${V2_DEFAULTS.RESOURCE_MAX_ACTIVE} 条，请先归档不用的资料`);
  }
  const sensitivity: ResourceSensitivity = input.sensitivity ?? existing?.sensitivity ?? 'normal';
  const id = existing?.id ?? newId('res', ctx.rng);
  const record: Resource = ResourceSchema.parse({
    id,
    name: input.name,
    kind: input.kind,
    locator,
    sensitivity,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    archivedAt: existing?.archivedAt ?? null,
  });
  ctx.store.table('resources').put(record);
  writeOutreachAudit(ctx, existing ? 'resource_update' : 'resource_create',
    { id, name: record.name, kind: record.kind, locator: record.locator, sensitivity: record.sensitivity }, 'owner', now);
  notifyResources(ctx);
  return record;
}

/** 归档资料：只打归档标记，不删除、不清授权；归档后拒绝新授权、读取返回「已归档」。 */
export function archiveResource(ctx: HubContext, rawId: unknown): Resource {
  const id = parseInput(ResourceIdSchema, rawId, '资料归档');
  const now = ctx.clock.now();
  const resource = ctx.store.table('resources').get(id);
  if (!resource) throw new Error(`资料不存在：${id}`);
  if (resource.archivedAt !== null) throw new Error(`资料「${resource.name}」已经归档`);
  const record = ctx.store.table('resources').patch(id, { archivedAt: now, updatedAt: now });
  writeOutreachAudit(ctx, 'resource_archive', { id, name: record.name, kind: record.kind }, 'owner', now);
  notifyResources(ctx);
  return record;
}

/** 授权对象只认队友本人：id 必须是 b_ 前缀且队友存在；取消编制后不再接受席位/部门授权。 */
function assertGrantSubject(ctx: HubContext, kind: GrantSubjectKind, subjectId: string): string {
  void kind; // 枚举已收敛为 bot，保留入参便于阅读与未来扩展。
  if (!subjectId.startsWith('b_')) throw new Error('subjectId：授权对象必须是 b_ 开头的队友 id');
  const bot = ctx.store.table('bots').get(subjectId);
  if (!bot) throw new Error(`授权队友不存在：${subjectId}`);
  return bot.name;
}

/**
 * 授予或修改一条资料授权（仅主人）。
 * 去重自然键 resourceId+subjectKind+subjectId：同键再设只改 level、保留原 id 与创建时间；
 * 不同对象各算一条。资料不存在或已归档、对象不存在都拒绝。
 */
export function setGrant(ctx: HubContext, raw: unknown): Grant {
  const input = parseInput(SetGrantSchema, raw, '资料授权');
  const now = ctx.clock.now();
  const resource = ctx.store.table('resources').get(input.resourceId);
  if (!resource) throw new Error(`资料不存在：${input.resourceId}`);
  if (resource.archivedAt !== null) {
    throw new Error(`资料「${resource.name}」已归档，归档资料不能新增授权`);
  }
  const subjectName = assertGrantSubject(ctx, input.subjectKind, input.subjectId);
  const existing = ctx.store.table('grants').list().find(g =>
    g.resourceId === input.resourceId && g.subjectKind === input.subjectKind && g.subjectId === input.subjectId) ?? null;
  if (existing) {
    // upsert：同键改级别，不生成新授权 id；只为审计 id 消耗一次随机序列。
    const level: GrantLevel = input.level;
    const record = ctx.store.table('grants').patch(existing.id, { level });
    writeOutreachAudit(ctx, 'grant_set',
      { grantId: record.id, resourceId: resource.id, resourceName: resource.name, subjectKind: record.subjectKind,
        subjectId: record.subjectId, subjectName, level: record.level, updated: true }, 'owner', now);
    notifyResources(ctx);
    return record;
  }
  if (ctx.store.table('grants').count() >= V2_DEFAULTS.RESOURCE_GRANT_MAX) {
    throw new Error(`授权总条数已达防误操作上限 ${V2_DEFAULTS.RESOURCE_GRANT_MAX} 条，请先归档不用的资料`);
  }
  const id = newId('gr', ctx.rng);
  const record: Grant = GrantSchema.parse({
    id, resourceId: input.resourceId, subjectKind: input.subjectKind, subjectId: input.subjectId,
    level: input.level, createdAt: now, createdBy: 'owner',
  });
  ctx.store.table('grants').put(record);
  writeOutreachAudit(ctx, 'grant_set',
    { grantId: id, resourceId: resource.id, resourceName: resource.name, subjectKind: record.subjectKind,
      subjectId: record.subjectId, subjectName, level: record.level, updated: false }, 'owner', now);
  notifyResources(ctx);
  return record;
}

/**
 * 取消一条资料授权（仅主人）。重复取消不报错，返回是否真的删掉了一条，
 * 这样「保存到一半失败后重试」不会因为已取消过而卡住。
 */
export function revokeGrant(ctx: HubContext, raw: unknown): { revoked: boolean } {
  const input = parseInput(RevokeGrantSchema, raw, '取消资料授权');
  const existing = ctx.store.table('grants').list().find(g =>
    g.resourceId === input.resourceId && g.subjectKind === input.subjectKind && g.subjectId === input.subjectId) ?? null;
  if (!existing) return { revoked: false };
  ctx.store.table('grants').remove(existing.id);
  writeOutreachAudit(ctx, 'grant_revoked',
    { grantId: existing.id, resourceId: existing.resourceId, subjectKind: existing.subjectKind, subjectId: existing.subjectId }, 'owner', ctx.clock.now());
  notifyResources(ctx);
  return { revoked: true };
}
