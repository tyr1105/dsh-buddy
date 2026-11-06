/** 内存日志保留级别、正文和附加数据，供测试断言告警与错误隔离结果。 */
import type { Logger } from '../interfaces.js';
export interface MemoryLogLine { level: keyof Logger; message: string; data?: unknown }
/** 保留分级日志供测试断言，不向真实控制台输出。 */
export class MemoryLogger implements Logger {
  readonly lines: MemoryLogLine[] = [];
  /** 记录调试信息，供断言算法的内部解释。 */
  debug(message: string, data?: unknown): void { this.lines.push({ level: 'debug', message, data }); }
  /** 记录常规信息，供核对执行轨迹。 */
  info(message: string, data?: unknown): void { this.lines.push({ level: 'info', message, data }); }
  /** 记录可恢复警告，供验证坏数据与故障隔离。 */
  warn(message: string, data?: unknown): void { this.lines.push({ level: 'warn', message, data }); }
  /** 记录操作失败，供验证异常已被报告。 */
  error(message: string, data?: unknown): void { this.lines.push({ level: 'error', message, data }); }
}
