/** 界面通用校验、命令审计和排序分页集中处理，避免某个命令忘记刷盘或泄漏原始异常。 */
import type { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty } from '../model/primitives.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { formatShort, formatAgo } from '../util/time.js';
import { C04_DEFAULTS } from '../config/defaults.js';
import { PageSchema } from './schemas.js';
import type { CommandResult, PageInput } from './types.js';

/** 先确认名册身份，再读取或修改业务对象，禁止创建悬空关联。 */
export function requireBot(ctx: HubContext, id: string) {
  const bot = ctx.store.table('bots').get(parseInput(nonempty, id, 'botId'));
  if (!bot) throw new Error('botId：机器人不存在');
  return bot;
}
/** 格式化可空的业务时间，同时由视图保留原始毫秒。 */
export function shortTime(ctx: HubContext, at: number | null): string | null {
  return at === null ? null : formatShort(at, ctx.clock.now(), ctx.settings.timezone);
}
/** 相对时间同样使用注入时钟，测试与实际界面一致。 */
export function agoTime(ctx: HubContext, at: number | null): string | null {
  return at === null ? null : formatAgo(at, ctx.clock.now());
}
/** 所有命令串行执行到业务修改结束；调度在锁外运行，以免宿主立即回调时互相等待。 */
export function commandRunner(ctx: HubContext, afterCommand: () => Promise<void>) {
  let tail: Promise<unknown> = Promise.resolve();
  return async <T>(name: string, operation: () => T | Promise<T>): Promise<CommandResult<T>> => {
    const operationPromise = tail.catch(() => undefined).then(async (): Promise<CommandResult<T>> => {
      let result: CommandResult<T>;
      try {
        const data = await operation();
        writeOutreachAudit(ctx, `ui_${name}`, { ok: true }, 'owner');
        // 变化通知由业务入口按真实受影响对象发出；通用审计没有机器人身份，不能冒充全局刷新。
        result = { ok: true, data };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = /[\u3400-\u9fff]/.test(message) ? message : `操作失败：${message}`;
        writeOutreachAudit(ctx, `ui_${name}`, { ok: false, error: detail }, 'owner');
        result = { ok: false, error: detail };
      }
      return result;
    });
    tail = operationPromise;
    const result = await operationPromise;
    try {
      await afterCommand();
    } catch (error) {
      return { ok: false, error: `命令已处理，但调度或保存失败：${String(error)}` };
    }
    return result;
  };
}
/** 按 id 游标截取更早的记录；游标不存在时明确报错，避免默默重复第一页。 */
export function paginate<T extends { id: string }>(rows: T[], input: PageInput | undefined, time: (row: T) => number) {
  const page = parseInput(PageSchema, input ?? {}, '分页');
  let candidates = rows;
  if (typeof page.before === 'string') {
    const index = rows.findIndex(row => row.id === page.before);
    if (index < 0) throw new Error('before：分页游标不存在');
    candidates = rows.slice(index + 1);
  } else if (typeof page.before === 'number') {
    const before = page.before;
    candidates = rows.filter(row => time(row) < before);
  }
  const limit = page.limit ?? C04_DEFAULTS.VIEW_PAGE_LIMIT;
  return { rows: candidates.slice(0, limit), hasMore: candidates.length > limit };
}
/** 简单元组入口也统一经过 zod，避免直接向业务模块传入未校验的布尔或 id。 */
export function input<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  return parseInput(schema, raw, label);
}
