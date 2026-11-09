/**
 * 资料可见性判定（纯函数，v2 计划 3.3；主人取消编制后简化）：
 * 给定队友、资料与授权的完整快照，判断某个队友能不能读某份资料。
 * 同样的输入永远得到同样的输出：不读系统时间（now 显式入参）、不读文件、不碰存储与宿主。
 *
 * 规则：
 * 1. 已归档资料任何人都不可读（授权保留，但读取返回「已归档」）。
 * 2. normal 资料：所有 active/probation（在岗/试岗）队友可读。
 * 3. restricted 资料：必须命中一条授权给「队友本人」的有效授权。
 *    编制取消后不再有按席位、按部门传导的授权；旧存档里的这类授权在读取时被忽略。
 * 4. 注意边界：这只是「中心资料层」治理，不限制 DSH 会话内的直接文件读取。
 */
import type { Bot } from '../model/bot.js';
import { ON_TEAM_LIFECYCLES } from '../model/enums.js';
import type { Grant, Resource } from '../model/resource.js';

/** 判定所需的完整事实快照；纯函数只读它，不修改。 */
export interface ResourceAccessData {
  bots: Bot[];
  resources: Resource[];
  grants: Grant[];
}

/** canRead 不需要整张资料表，但调用方通常拿着完整快照，所以允许直接传整个 data。 */
export type ResourceAccessFacts = Pick<ResourceAccessData, 'bots' | 'grants'>;

/** 命中的授权；来源固定为队友直授，保留字段便于测试与后续解释「为什么能读」。 */
export interface EffectiveGrant {
  grant: Grant;
  via: 'bot';
}

/** 队友是否在岗（口径与派活校验完全一致）。 */
export function isBotOnTeam(bot: Bot): boolean {
  return ON_TEAM_LIFECYCLES.includes(bot.lifecycle as typeof ON_TEAM_LIFECYCLES[number]);
}

/**
 * 展开对某队友实际生效的授权：只认授权对象就是这个队友本人的记录。
 * 旧档里按席位、按部门授出的记录直接忽略，不报错、不阻塞读取。
 */
export function effectiveGrants(data: ResourceAccessFacts, botId: string): EffectiveGrant[] {
  return data.grants
    .filter(grant => grant.subjectKind === 'bot' && grant.subjectId === botId)
    .map(grant => ({ grant, via: 'bot' as const }));
}

/** 归档与在岗之外的核心判定：restricted 是否命中本资料的授权（read/write 都赋予读资格）。 */
export function hasResourceGrant(data: ResourceAccessFacts, botId: string, resourceId: string): boolean {
  return effectiveGrants(data, botId).some(hit => hit.grant.resourceId === resourceId);
}

/**
 * 判定队友能否读某份资料。now 按纯函数纪律显式带入（当前规则只看归档标记，
 * 保留入参以便后续按时间生效的授权规则复用同一签名）。
 */
export function canRead(bot: Bot, resource: Resource, data: ResourceAccessFacts, now: number): boolean {
  void now;
  // 1. 归档资料不参与读取，即使授权仍在。
  if (resource.archivedAt !== null) return false;
  // 2. 只有在岗/试岗队友读资料；暂停、隔离、退役、草稿都不行。
  if (!isBotOnTeam(bot)) return false;
  // 3. 普通资料全队在岗可读。
  if (resource.sensitivity === 'normal') return true;
  // 4. 受限资料必须命中本人直授。
  return hasResourceGrant(data, bot.id, resource.id);
}

/**
 * 给工具层用的中文拒绝原因：返回 null 表示可读。
 * 刻意不区分「资料不存在」与「已归档」对外的细节，避免向无授权方确认资料 id 是否存在；
 * 但对已存在且未归档却无授权的情况明确说「没有授权」，方便队友知道要找主人。
 */
export function explainReadDenial(
  bot: Bot | null,
  resource: Resource | null,
  data: ResourceAccessFacts,
  now: number,
): string | null {
  if (!resource || resource.archivedAt !== null) return '资料不存在或已归档，不能读取';
  if (!bot || !isBotOnTeam(bot)) {
    const state = bot ? `${bot.lifecycle}` : '不存在';
    return `队友当前状态为 ${state}，不在岗，不能读取资料`;
  }
  if (canRead(bot, resource, data, now)) return null;
  return `你没有资料「${resource.name}」的授权：这是受限资料，请主人授权后再读`;
}

/** 列出某队友当前可读的全部非归档资料，按创建时间再 id 稳定排序，供唤醒包与列表工具复用。 */
export function readableResources(data: ResourceAccessData, botId: string, now: number): Resource[] {
  const bot = data.bots.find(b => b.id === botId) ?? null;
  if (!bot) return [];
  return data.resources
    .filter(resource => resource.archivedAt === null && canRead(bot, resource, data, now))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
