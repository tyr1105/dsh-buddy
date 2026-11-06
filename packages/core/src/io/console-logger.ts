/** 给宿主控制台日志加统一前缀，方便把中心日志和宿主日志区分开。 */
import type { Logger } from './interfaces.js';
/** 通过统一前缀输出分级日志，方便从宿主日志中定位中心事件。 */
export class ConsoleLogger implements Logger {
  /** 输出调试细节，供排查内部决策过程。 */
  debug(message: string, data?: unknown): void { this.write('debug', message, data); }
  /** 输出常规运行记录，供确认中心状态。 */
  info(message: string, data?: unknown): void { this.write('info', message, data); }
  /** 输出可恢复异常，保留后续排查线索。 */
  warn(message: string, data?: unknown): void { this.write('warn', message, data); }
  /** 输出操作失败，便于定位需要处理的问题。 */
  error(message: string, data?: unknown): void { this.write('error', message, data); }
  /** 统一选择日志级别与参数格式，避免重复打印缺失的附加数据。 */
  private write(level: keyof Logger, message: string, data: unknown): void {
    // 没有附加数据时不打印 undefined，以便直接阅读日志。
    if (data === undefined) console[level]('[agent-hub]', message);
    else console[level]('[agent-hub]', message, data);
  }
}
