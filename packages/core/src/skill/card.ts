/**
 * 复盘相关消息的 refId（P75g 第 8 节、P75h 第 6 节）：复盘卡、改写卡、技能核对卡与复盘小结落在主题线程里时带的标识。
 *
 * 为什么单独放：主题视图（api/job-views.ts 的往来折叠）、卡片视图（api/job-card-views.ts 的分派）
 * 和写消息的几处（propose 落卡、revise 落改写卡、check 落核对卡、run.ts 落小结、交账路由落回复）都要认这几种 refId；
 * 集中一处，改格式只改这里。注意与事项键（keys.ts）同形但用途不同：这里是线程消息的 refId。
 */

/** 复盘卡消息的 refId：retro:<runId>:<botId>（与复盘唤醒的事项键同形）。 */
export function retroCardRefId(runId: string, botId: string): string {
  return `retro:${runId}:${botId}`;
}

/**
 * 改写卡（员工改写技能更新之后落的复盘卡）的 refId：retro:<runId>:<botId>:rewrite:<updateId>。
 * 与原来的复盘卡同属 retro: 前缀，进同一个折叠组；多带更新编号是因为一次复盘里可能有不止一条更新被改写，每条各一张卡。
 */
export function rewriteCardRefId(runId: string, botId: string, updateId: string): string {
  return `retro:${runId}:${botId}:rewrite:${updateId}`;
}

/** 解析复盘卡 refId：普通复盘卡返回 updateId 为 null；改写卡带 updateId；不是复盘卡返回 null。 */
export function parseRetroCardRef(refId: string): { runId: string; botId: string; updateId: string | null } | null {
  const parts = refId.split(':');
  if (parts[0] !== 'retro' || parts.length < 3 || parts[1] === '' || parts[2] === '') return null;
  if (parts.length === 3) return { runId: parts[1]!, botId: parts[2]!, updateId: null };
  if (parts.length === 5 && parts[3] === 'rewrite' && parts[4] !== '') return { runId: parts[1]!, botId: parts[2]!, updateId: parts[4]! };
  return null;
}

/** 技能核对卡消息的 refId：skillcheck:<updateId>#<第几次核对>（同一条更新改写后会再核对一次）。 */
export function skillCheckCardRefId(updateId: string, nth: number): string {
  return `skillcheck:${updateId}#${nth}`;
}

/** 解析技能核对卡 refId；不是核对卡返回 null。 */
export function parseSkillCheckCardRef(refId: string): { updateId: string; nth: number } | null {
  const match = /^skillcheck:([^#:]+)#(\d+)$/.exec(refId);
  return match === null ? null : { updateId: match[1]!, nth: Number(match[2]) };
}

/** 复盘小结消息的 refId：retro-summary:<runId>（交账路由落回复时再接 :<wakeId>）。 */
export function retroSummaryRefId(runId: string): string {
  return `retro-summary:${runId}`;
}
