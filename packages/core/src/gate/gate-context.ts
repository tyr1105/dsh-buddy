/**
 * 动作闸的分类上下文：把「这位队友是谁、家在哪、能碰哪些目录」从中心名册里算出来。
 *
 * 为什么从 guard.ts 里拆出来：审批单（approvals.ts）也要用它给审批卡挑一句人话，
 * 而 guard.ts 又依赖 approvals.ts，放在一起会绕成圈。guard.ts 仍然原样导出这里的函数，别处的引用不用改。
 *
 * P69 新增的三样：
 * - 宿主报告（ToolCallHostReport）：每次工具调用时，宿主说明这条会话此刻是不是在 workspace-write 沙箱里、
 *   沙箱里可写的临时目录有哪些。没报、报了 false、报得不合规，一律当作「没确认」，按旧规则走。
 * - projectDirs：这位队友作为成员（含负责人）的、没有归档的项目的项目目录，从项目表里现算。
 * - nativeGateContext：队友自己的工具（bash、write 这些）用的上下文。沙箱没确认时不带项目目录，
 *   「项目文件夹不用审批」只给经中心代写的动作，不给没有沙箱兜底的原生工具。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/index.js';
import { normalizeProjectSharedDir } from '../project/shared-dir.js';
import { isReadonlySkillTurn } from '../skill/keys.js';
import { tmpAlias, within, type GateContext } from './paths.js';

/** 宿主在每次工具调用时报进来的沙箱情况（由插件的工具钩子现查现报，不缓存）。 */
export interface ToolCallHostReport {
  /** 只有明确为 true 才算「沙箱开着」；宿主查不到、出错或是别的权限档位都应该报 false 或不报。 */
  sandboxed?: boolean;
  /** 沙箱里可写的临时目录，要求是真实路径（例如 /tmp、/private/tmp、系统临时目录）。 */
  tmpDirs?: string[];
}

/** 临时目录最多认这么多个，防止宿主误传一长串。 */
const TMP_DIR_LIMIT = 16;

/**
 * 这位队友作为成员（含负责人）的、没有归档的项目的项目目录。
 * 目录必须通过「位于 <根目录>/projects 之下」的校验才算数：旧存档或手工改库把目录指到别处时直接跳过，
 * 不能让一条坏数据变成「免审批可写」的目录。
 */
export function memberProjectDirs(ctx: HubContext, botId: string): string[] {
  const dirs: string[] = [];
  for (const project of ctx.store.table('projects').list(row => row.archivedAt === null && row.status !== 'archived'
    && (row.memberBotIds.includes(botId) || row.ownerBotId === botId))) {
    try { dirs.push(normalizeProjectSharedDir(ctx, project.sharedDir).replace(/\/+$/, '')); }
    catch { /* 目录不合规的项目不算可写空间。 */ }
  }
  return [...new Set(dirs)];
}

/**
 * 清洗宿主报来的临时目录：必须是绝对路径；不能是根目录，也不能是中心根目录、队友家目录或主人家目录的上级，
 * 否则「临时目录可写」会把整片范围都放开。清洗掉的直接丢弃，不报错（宿主出错不该影响队友干活）。
 */
function cleanTmpDirs(ctx: HubContext, bot: Bot, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const anchors = [ctx.settings.rootDir, bot.homeDir, ...(ctx.ownerHome ? [ctx.ownerHome] : []), ...(ctx.runtime?.realRootDir ? [ctx.runtime.realRootDir] : [])];
  const dirs: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.startsWith('/')) continue;
    const dir = posix.normalize(item).replace(/\/+$/, '');
    // 比较前先做别名规范化（R8）：/tmp 与 /private/tmp、/var 与 /private/var 是同一处，宿主报哪种写法都一样处理。
    if (dir === '' || dir === '/' || anchors.some(anchor => within(tmpAlias(anchor), tmpAlias(dir)))) continue;
    if (!dirs.includes(dir)) dirs.push(dir);
    if (dirs.length >= TMP_DIR_LIMIT) break;
  }
  return dirs;
}

/**
 * 会话归属只从中心名册读取，不接受工具参数自报 botId。
 * 不传 host 时得到的上下文和 P69 之前相比只多了 projectDirs，sandboxed 一定不为真：
 * 出站动作、脚本关注、交接这些由中心在沙箱外执行的事，都用这个不带沙箱的上下文。
 */
export function gateContextFor(ctx: HubContext, bot: Bot, host?: ToolCallHostReport): GateContext {
  // 复盘回合（总控裁定第 1 条）：本卡的放宽一律不生效，所以复盘时不管宿主怎么报，都当作「沙箱没确认」，
  // 完全按旧规则判；守卫照旧以「复盘回合只读」拒绝，不记越界，也不新增任何 protected 判定。
  // P75r5c（审查 H2）：学习回合（变体 teach、事项键 learn:）同样只读，统一用 isReadonlySkillTurn 判断。
  const reflection = ctx.store.table('wakes').list(w => w.botId === bot.id && w.sessionId === bot.sessionId
    && w.endedAt === null && ['running', 'delivering', 'committed'].includes(w.status) && isReadonlySkillTurn(w)).length > 0;
  const sandboxed = host?.sandboxed === true && !reflection;
  return { homeDir: bot.homeDir, ownerHome: ctx.ownerHome, maxCommandDepth: ctx.settings.c03.maxCommandDepth, sharedDir: `${ctx.settings.rootDir}/shared`, rootDir: ctx.settings.rootDir,
    workDataAllowed: bot.workDataAllowed, workDataPaths: ctx.settings.workDataPaths, autonomy: bot.autonomy,
    reflection,
    // 复盘回合不带项目目录（R5）：「成员写项目文件夹不用审批」也是本卡的放宽，复盘时一律不生效，
    // 经中心代写（hub_outbox_submit）也一样，照旧按「复盘只允许写自己的 work、MEMORY.md 与 playbooks」拒绝。
    projectDirs: reflection ? [] : memberProjectDirs(ctx, bot.id),
    // P74r16a：中心根目录在符号链接后面时，把它的真实路径带进来，路径解析时换回设置里的写法（沙箱开不开都一样）。
    ...(ctx.runtime?.realRootDir ? { realRootDir: ctx.runtime.realRootDir } : {}),
    // 两个字段只在宿主明确确认沙箱时才出现：没确认时连临时目录也不认，完全按旧规则走。
    ...(sandboxed ? { sandboxed: true, tmpDirs: cleanTmpDirs(ctx, bot, host?.tmpDirs) } : {}) };
}

/**
 * 队友自己的工具调用用的上下文（守卫专用）。
 * 沙箱确认开着：带项目目录，用来判断该给哪句指路的话。
 * 沙箱没确认：不带项目目录。此时没有 DSH 的墙兜底，原生工具写项目文件夹照旧要主人审批，和 P69 之前一样。
 */
export function nativeGateContext(ctx: HubContext, bot: Bot, host?: ToolCallHostReport): GateContext {
  const base = gateContextFor(ctx, bot, host);
  return base.sandboxed === true ? base : { ...base, projectDirs: [] };
}
