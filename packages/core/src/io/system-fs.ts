/** 真实文件系统适配：路径必须明确、写文件采用同目录替换，监听异常不外溢。 */
import * as fs from 'node:fs/promises';
import { watch as watchFile, statSync, lstatSync, constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { PathContainmentError } from './interfaces.js';
import type { FileChange, FsIO, Logger, WriteBoundary } from './interfaces.js';
import { ConsoleLogger } from './console-logger.js';

/** 拒绝相对路径，避免宿主工作目录变化导致写错位置。 */
function absolute(path: string): string {
  if(!isAbsolute(path)) throw new Error(`文件路径必须是绝对路径：${path}`);
  return path;
}
/** 只识别文件不存在，其他文件错误仍须向调用方报告。 */
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** 算出目标在根目录下的各级名字；目标不在根目录内就拒绝。等于根目录时返回空数组。 */
function partsBelow(root: string, target: string): string[] {
  const rest = relative(root, target);
  if (rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest)) throw new PathContainmentError(`${target} 不在 ${root} 内`);
  return rest === '' ? [] : rest.split(sep);
}
/** 比较路径时折叠大小写和 Unicode 写法，与 gate/paths 的口径一致（macOS 默认不区分大小写）。 */
function samePath(a: string, b: string): boolean { return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase(); }

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
  async writeTextAtomic(path: string, text: string, boundary?: WriteBoundary): Promise<void> {
    absolute(path);
    if (boundary) await this.prepareDirectory(boundary.within, dirname(path), true);
    else await fs.mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    // 先完整写入同一文件系统的临时文件，再一次 rename；失败不破坏旧文件。
    try {
      if (boundary) {
        // O_EXCL 保证临时文件是这次新建的；句柄核对过位置才写正文。
        // rename 不跟随目标处的符号链接，所以目标若是链接，只会替换链接本身，不会写到链接指向的文件。
        // 核对之后目录再被换成链接也没用：目录外不会有这个随机名字的临时文件，rename 只会失败。
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
        try {
          await this.assertHandleInside(boundary.within, temporary, handle);
          await handle.writeFile(text, 'utf8');
        } finally { await handle.close(); }
      } else await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, path);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  /** 自动创建父目录再追加文本，供按日日志持续落盘。 */
  async appendText(path: string, text: string, boundary?: WriteBoundary): Promise<void> {
    absolute(path);
    if (!boundary) {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.appendFile(path, text, 'utf8');
      return;
    }
    await this.prepareDirectory(boundary.within, dirname(path), true);
    let handle: fs.FileHandle;
    try {
      // O_NOFOLLOW：文件本身是符号链接时系统直接拒绝；O_NONBLOCK：放了管道也不会把宿主挂住。
      handle = await fs.open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ELOOP' || code === 'ENXIO') throw new PathContainmentError(`${path} 是符号链接或特殊文件`);
      throw error;
    }
    try {
      // 先打开、后核对、最后才写：核对的是已经打开的这个文件，打开之后路径再怎么换都改变不了写入目标。
      await this.assertHandleInside(boundary.within, path, handle);
      await handle.appendFile(text, 'utf8');
    } finally { await handle.close(); }
  }
  /**
   * 从根目录往下逐级检查，任何一级是符号链接或不是目录都拒绝。
   * create 为真时顺手建出缺失的目录（一级一级建，不用 recursive，否则会穿过中途的链接）。
   * 返回目录是否存在：只有 create 为假时才可能返回 false，供删除操作把「不存在」当成功。
   */
  private async prepareDirectory(root: string, directory: string, create: boolean): Promise<boolean> {
    absolute(root);
    absolute(directory);
    const parts = partsBelow(root, directory);
    // 根目录的上级归中心和主人管（例如 macOS 的 /tmp 本身就是链接），只从根目录这一级开始查。
    if (create) await fs.mkdir(root, { recursive: true });
    let current = root;
    for (const part of [null, ...parts]) {
      if (part !== null) {
        current = join(current, part);
        if (create) await fs.mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      }
      let info;
      try { info = await fs.lstat(current); }
      catch (error) {
        if (!create && missing(error)) return false;
        throw error;
      }
      if (info.isSymbolicLink()) throw new PathContainmentError(`${current} 是符号链接`);
      if (!info.isDirectory()) throw new PathContainmentError(`${current} 不是目录`);
    }
    return true;
  }
  /** 解析路径的真实位置，必须正好落在根目录真实位置的对应子路径上。 */
  private async assertResolvedInside(root: string, path: string): Promise<void> {
    // 只解析根目录的上一级：根目录在核对前被换成链接时，它的解析结果不可信，这样比较才能发现。
    const expected = join(await fs.realpath(dirname(root)), basename(root), relative(root, path));
    if (!samePath(await fs.realpath(path), expected)) throw new PathContainmentError(`${path} 解析到了 ${root} 之外`);
  }
  /**
   * 核对已打开的文件确实是根目录内的这一个普通文件。
   * 比对 inode（文件在磁盘上的编号）堵住「打开前把目录换成链接、打开后再换回来」的抢时间差；
   * 拒绝多个硬链接，否则目录里的文件可能和目录外的文件是同一份。
   */
  private async assertHandleInside(root: string, path: string, handle: fs.FileHandle): Promise<void> {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new PathContainmentError(`${path} 不是普通文件`);
    if (opened.nlink !== 1) throw new PathContainmentError(`${path} 有多个硬链接`);
    await this.assertResolvedInside(root, path);
    const current = await fs.lstat(path);
    if (current.isSymbolicLink() || current.ino !== opened.ino || current.dev !== opened.dev) throw new PathContainmentError(`${path} 在写入前被替换`);
  }
  /** 只看路径本身是不是符号链接；不存在算否，其他错误交给调用方按失败关闭处理。 */
  isSymlinkSync(path: string): boolean {
    absolute(path);
    try { return lstatSync(path).isSymbolicLink(); }
    catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  /** 递归创建绝对目录，让重复初始化可安全重试。 */
  async mkdirp(path: string, boundary?: WriteBoundary): Promise<void> {
    absolute(path);
    if (!boundary) { await fs.mkdir(path, { recursive: true }); return; }
    await this.prepareDirectory(boundary.within, path, true);
    await this.assertResolvedInside(boundary.within, path);
  }
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
  async remove(path: string, boundary?: WriteBoundary): Promise<void> {
    absolute(path);
    // 带边界时只查上级目录：目标本身是链接没关系，rm 删掉的是链接，不会动它指向的内容。
    if (boundary && !await this.prepareDirectory(boundary.within, dirname(path), false)) return;
    await fs.rm(path, { recursive: true, force: true });
  }
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
