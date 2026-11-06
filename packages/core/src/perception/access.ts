/** 关注由中心直接读取世界，所以创建入口和每次读取都共用动作闸的敏感路径判断，不能依赖宿主工具钩子。 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { Watch } from '../model/perception.js';
import { classifyPath } from '../gate/paths.js';
import { classifyUrl } from '../gate/network-options.js';
import type { GateContext } from '../gate/paths.js';

/** 保留拒绝类别供可信机器人工具入口记越界；读取器与主人界面只拒绝，不替机器人累计次数。 */
export class WatchAccessDeniedError extends Error {
  constructor(message: string, readonly actionClass: 'protected' | 'work_data') { super(message); }
}

/** 新建预检直接使用尚未落表的身份；运行时传 id 时仍查询最新授权，宿主家目录只用注入值。 */
export function watchGateContext(ctx: HubContext, botOrId: Bot | string): GateContext {
  const bot = typeof botOrId === 'string' ? ctx.store.table('bots').get(botOrId) : botOrId;
  if (!bot) throw new Error('关注项所属机器人不存在');
  return { homeDir: bot.homeDir, cwd: bot.homeDir, ownerHome: ctx.ownerHome, rootDir: ctx.settings.rootDir,
    sharedDir: `${ctx.settings.rootDir}/shared`, workDataAllowed: bot.workDataAllowed, workDataPaths: ctx.settings.workDataPaths };
}

/** 公开路径可以读，敏感凭据与未授权工作数据一律拒绝；普通身份文件的只读仍然允许。 */
export function assertWatchPathAccess(ctx: HubContext, botOrId: Bot | string, path: string): void {
  const action = classifyPath(path, false, watchGateContext(ctx, botOrId));
  if (action.cls === 'protected' || action.subclass === 'work_data') throw new WatchAccessDeniedError(`target：${action.reason}`, action.cls === 'protected' ? 'protected' : 'work_data');
}

/** 旧持久化记录也必须是真实 HTTP(S)；file URL 在调用网络适配器之前先按文件路径判敏感。 */
export function assertHttpWatchAccess(ctx: HubContext, watch: Pick<Watch, 'botId' | 'target'>, botOrId: Bot | string = watch.botId): void {
  const action = classifyUrl(watch.target, 'GET', watchGateContext(ctx, botOrId));
  if (action.cls === 'protected' || action.subclass === 'work_data') throw new Error(`target：${action.reason}`);
  try { if (!['http:', 'https:'].includes(new URL(watch.target).protocol)) throw new Error(); }
  catch { throw new Error('target：网页和订阅关注必须使用有效 http 或 https 地址'); }
}
