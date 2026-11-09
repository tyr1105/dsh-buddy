/** 真实文件系统适配：路径必须明确、写文件采用同目录替换，监听异常不外溢。 */
import * as fs from 'node:fs/promises';
import { watch as watchFile, statSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { FileChange, FsIO, Logger } from './interfaces.js';
import { ConsoleLogger } from './console-logger.js';

/** 拒绝相对路径，避免宿主工作目录变化导致写错位置。 */
function absolute(path: string): string {
  if(!isAbsolute(path)) throw new Error(`文件路径必须是绝对路径：${path}`);
  return path;
}
/** 只识别文件不存在，其他文件错误仍须向调用方报告。 */
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** 把真实文件访问封装在注入接口中，业务不直接依赖系统文件模块。 */
export class SystemFs implements FsIO {
  /** 注入日志后端，监听器失败可记录而不影响宿主。 */
  constructor(private readonly logger: Logger = new ConsoleLogger()) { }
  /** 读取 UTF-8 文件，不存在返回空值而不掩盖权限等其他错误。 */
  async readText(path: string): Promise<string | null> {
    absolute(path);
    try { return await fs.readFile(path, 'utf8'); }
    catch(error) {
      if(missing(error)) return null;
      throw error;
    }
  }
  /** 非阻塞打开后在同一文件句柄上验证类型，避免检查后被换成管道而挂住宿主。 */
  async readBytes(path: string): Promise<Uint8Array | null> {
    absolute(path);
    try {
      const file = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) throw new Error('批准绑定的路径必须是普通文件');
        return await file.readFile();
      } finally { await file.close(); }
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  /** 使用系统解析符号链接；不存在与权限错误原样交给调用者处理。 */
  async realpath(path: string): Promise<string> { return fs.realpath(absolute(path)); }
  /** 用同目录临时文件替换正文，避免中断留下半份记录。 */
  async writeTextAtomic(path: string, text: string): Promise<void> {
    absolute(path);
    await fs.mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    // 先完整写入同一文件系统的临时文件，再一次 rename；失败不破坏旧文件。
    try {
      await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  /** 自动创建父目录再追加文本，供按日日志持续落盘。 */
  async appendText(path: string, text: string): Promise<void> {
    absolute(path);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.appendFile(path, text, 'utf8');
  }
  /** 递归创建绝对目录，让重复初始化可安全重试。 */
  async mkdirp(path: string): Promise<void> { await fs.mkdir(absolute(path), { recursive: true }); }
  /** 返回排序后的直接子项，不存在目录按空列表处理。 */
  async list(dir: string): Promise<string[]> {
    absolute(dir);
    try { return (await fs.readdir(dir)).sort(); }
    catch(error) {
      if(missing(error)) return [];
      throw error;
    }
  }
  /** 只暴露大小、修改时刻和目录标记，保持业务接口最小化。 */
  async stat(path: string) {
    absolute(path);
    try {
      const info = await fs.stat(path);
      return { size: info.size, mtimeMs: info.mtimeMs, isDir: info.isDirectory(), isFile: info.isFile(), inode: info.ino };
    } catch(error) {
      if(missing(error)) return null;
      throw error;
    }
  }
  /** 复制文件或目录并准备父目录，支持原件备份和文件交接。 */
  async copy(src: string, dst: string): Promise<void> {
    absolute(src);
    absolute(dst);
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.cp(src, dst, { recursive: true });
  }
  /** 删除目标及子项，允许不存在的目标以支持幂等清理。 */
  async remove(path: string): Promise<void> { await fs.rm(absolute(path), { recursive: true, force: true }); }
  /** 订阅文件变化并隔离回调错误，返回取消函数供关注项停用。 */
  watch(path: string, opts: { recursive: boolean }, onChange: (event: FileChange) => void): () => void {
    absolute(path);
    // 监听文件时，回调文件名相对其父目录；监听目录时则相对该目录。
    const isDirectory = statSync(path).isDirectory();
    const watcher = watchFile(path, opts, (kind, filename) => {
      try {
        const changedPath = !filename ? path : (isDirectory ? join(path, filename.toString()) : path);
        onChange({ path: changedPath, kind });
      } catch(error) { this.warn('文件监听回调失败，已隔离本次事件', error); }
    });
    watcher.on('error', error => { this.warn('文件监听失败，已隔离监听器', error); });
    return () => { watcher.close(); };
  }
  /** 隔离日志后端本身的异常，确保监听错误不会带崩宿主。 */
  private warn(message: string, error: unknown): void {
    try { this.logger.warn(message, error); } catch { /* 日志后端错误也不能影响宿主。 */ }
  }
}
