/** 内存目录树实现与系统文件相同的契约。写入先完成，再同步通知监听者，便于确定性测试。 */
import { dirname, isAbsolute, normalize, sep } from 'node:path';
import { PathContainmentError, ReadLimitError } from '../interfaces.js';
import type { BoundedRead, Clock, FileChange, FileStat, FsIO, LinkStat, Logger, WriteBoundary } from '../interfaces.js';
import { FakeClock } from './fake-clock.js';
import { MemoryLogger } from './memory-logger.js';

/** bytes 只在按字节写入的文件上有值：保存原始字节，text 是它的 UTF-8 解码（仅供文本读取兜底）。 */
type Node = { text: string | null; mtimeMs: number; bytes?: Uint8Array };
type Watcher = { path: string; recursive: boolean; callback: (event: FileChange) => void };
/** 使用内存目录树模拟文件接口，监听通知只在完整写入后发出。 */
export class MemoryFs implements FsIO {
  private readonly nodes = new Map<string, Node>();
  private readonly watchers = new Set<Watcher>();
  private readonly symlinks = new Set<string>();
  /** 测试专用：标成「有多个硬链接」的文件，值是硬链接数。 */
  private readonly hardlinks = new Map<string, number>();
  /** 按字节写入时指定的权限位（P74r4b）。 */
  private readonly modes = new Map<string, number>();
  /** 创建虚拟根目录并注入时钟与日志，所有时间可确定性重放。 */
  constructor(private readonly clock: Clock = new FakeClock(0), private readonly logger: Logger = new MemoryLogger()) {
    this.nodes.set(sep, { text: null, mtimeMs: clock.now() });
  }
  /** 统一绝对路径与尾部分隔符，防止同一文件出现多份节点。 */
  private path(path: string): string {
    if(!isAbsolute(path)) throw new Error(`文件路径必须是绝对路径：${path}`);
    return normalize(path).replace(/\/$/, '') || sep;
  }
  /** 内存里没有符号链接，只校验目标确实在边界内，让业务测试能发现边界传错。 */
  private assertInside(path: string, boundary?: WriteBoundary): void {
    if (!boundary) return;
    const root = this.path(boundary.within);
    const target = this.path(path);
    if (target !== root && !target.startsWith(root === sep ? sep : root + sep)) throw new PathContainmentError(`${path} 不在 ${root} 内`);
  }
  /** 读取虚拟文件，缺失返回空值而目录读取明确拒绝。 */
  async readText(path: string): Promise<string | null> {
    const node = this.nodes.get(this.path(path));
    if(!node) return null;
    if(node.text === null) throw new Error(`不能把目录当文件读取：${path}`);
    return node.text;
  }
  /** 内存文件以文本保存，返回独立字节副本，供批准内容指纹走与系统相同的接口。 */
  async readBytes(path: string): Promise<Uint8Array | null> {
    const content = await this.readText(path);
    if (content === null) return null;
    // P69：按字节写入的文件返回原始字节的副本，二进制内容读回来逐字节一致。
    const raw = this.nodes.get(this.path(path))?.bytes;
    return raw ? Uint8Array.from(raw) : Buffer.from(content, 'utf8');
  }
  /** 测试专用：把某路径标记成符号链接，供验证同步守卫。内存实现不会真的跟随它。 */
  markSymlink(path: string): void { this.symlinks.add(this.path(path)); }
  /** 只反映 markSymlink 的标记。 */
  isSymlinkSync(path: string): boolean { return this.symlinks.has(this.path(path)); }
  /** 测试专用：把某个文件标成有 count 个硬链接（默认 2），供验证限量读取会拒绝它。 */
  markHardlink(path: string, count = 2): void { this.hardlinks.set(this.path(path), count); }
  /**
   * P69：限量读取的内存版，规则与系统版一致：
   * 根目录以下的每一级（含文件本身）被标成符号链接就拒绝；有多个硬链接就拒绝；超过 maxBytes 抛 ReadLimitError。
   */
  async readBytesWithin(path: string, limit: BoundedRead): Promise<Uint8Array | null> {
    this.assertInside(path, limit);
    const root = this.path(limit.within);
    const target = this.path(path);
    let current = root;
    if (this.symlinks.has(root)) throw new PathContainmentError(`${root} 是符号链接`);
    for (const part of target.slice(root === sep ? 1 : root.length + 1).split(sep).filter(Boolean)) {
      current = current === sep ? sep + part : current + sep + part;
      if (this.symlinks.has(current)) throw new PathContainmentError(`${current} 是符号链接`);
    }
    const node = this.nodes.get(target);
    if (!node) return null;
    if (node.text === null) throw new PathContainmentError(`${path} 不是普通文件`);
    if ((this.hardlinks.get(target) ?? 1) !== 1) throw new PathContainmentError(`${path} 有多个硬链接`, 'hardlink');
    const bytes = await this.readBytes(path);
    if (bytes && bytes.length > limit.maxBytes) throw new ReadLimitError(limit.maxBytes);
    return bytes;
  }
  /** 内存文件系统不建符号链接，解析结果保持原路径。 */
  async realpath(path: string): Promise<string> { return path; }
  /** 一次替换完整文本，使监听者不会观察到半份写入。 */
  async writeTextAtomic(path: string, text: string, boundary?: WriteBoundary): Promise<void> {
    this.assertInside(path, boundary);
    // 内存映射替换本身不可分割，回调看到的总是完整的新文本。
    this.write(this.path(path), text);
  }
  /** P69：按字节原样写入，保存字节副本，调用方之后改动自己的数组不影响文件。 */
  async writeBytesAtomic(path: string, bytes: Uint8Array, boundary?: WriteBoundary, mode?: number): Promise<void> {
    this.assertInside(path, boundary);
    this.write(this.path(path), Buffer.from(bytes).toString('utf8'), Uint8Array.from(bytes));
    // P74r4b：记下新文件的权限位（只取低 9 位），lstat 读回；不传按普通文件的 0o644。
    if (mode === undefined) this.modes.delete(this.path(path)); else this.modes.set(this.path(path), mode & 0o777);
  }
  /** P74r4b：内存版 lstat：符号链接按 markSymlink 的标记、硬链接数按 markHardlink 的标记、权限位按写入时记下的值。 */
  async lstat(path: string): Promise<LinkStat | null> {
    const key = this.path(path);
    const node = this.nodes.get(key);
    if (!node) return null;
    const isDir = node.text === null;
    const isSymlink = this.symlinks.has(key);
    return { size: isDir ? 0 : node.bytes ? node.bytes.length : Buffer.byteLength(node.text ?? '', 'utf8'), mtimeMs: node.mtimeMs, isDir: isDir && !isSymlink,
      isFile: !isDir && !isSymlink, isSymlink, nlink: this.hardlinks.get(key) ?? 1, mode: this.modes.get(key) ?? (isDir ? 0o755 : 0o644) };
  }
  /** 在原文后追加内容，不允许把目录当文件。 */
  async appendText(path: string, text: string, boundary?: WriteBoundary): Promise<void> {
    this.assertInside(path, boundary);
    const normalized = this.path(path);
    const node = this.nodes.get(normalized);
    if(node?.text === null) throw new Error(`不能追加到目录：${path}`);
    this.write(normalized, (node?.text ?? '') + text);
  }
  /** 准备父目录并更新修改时刻，再通知变化保证读取一致。 */
  private write(path: string, text: string, bytes?: Uint8Array): void {
    const existing = this.nodes.get(path);
    if(existing?.text === null) throw new Error(`不能覆盖目录：${path}`);
    this.ensureDirectory(dirname(path));
    this.nodes.set(path, bytes ? { text, mtimeMs: this.clock.now(), bytes } : { text, mtimeMs: this.clock.now() });
    this.notify({ path, kind: existing ? 'change' : 'rename' });
  }
  /** 递归创建虚拟目录，重复创建保持幂等。 */
  async mkdirp(path: string, boundary?: WriteBoundary): Promise<void> { this.assertInside(path, boundary); this.ensureDirectory(this.path(path)); }
  /** 补齐父目录并拒绝文件占位，模拟真实目录层级限制。 */
  private ensureDirectory(path: string): void {
    const existing = this.nodes.get(path);
    if(existing) {
      if(existing.text !== null) throw new Error(`父路径不是目录：${path}`);
      return;
    }
    this.ensureDirectory(dirname(path));
    this.nodes.set(path, { text: null, mtimeMs: this.clock.now() });
    this.notify({ path, kind: 'rename' });
  }
  /** 返回排序后的直接子项，保持与系统适配器一致。 */
  async list(dir: string): Promise<string[]> {
    const path = this.path(dir);
    const node = this.nodes.get(path);
    if(!node) return [];
    if(node.text !== null) throw new Error(`列举路径不是目录：${dir}`);
    return [...this.nodes.keys()].filter(key => key !== path && dirname(key) === path)
      .map(key => key.slice(path === sep ? 1 : path.length + 1)).sort();
  }
  /** 读取虚拟大小、时间和类型，供测试轮询与保留期。 */
  async stat(path: string): Promise<FileStat | null> {
    const node = this.nodes.get(this.path(path));
    return node ? { size: node.text === null ? 0 : node.bytes ? node.bytes.length : Buffer.byteLength(node.text, 'utf8'), mtimeMs: node.mtimeMs, isDir: node.text === null, isFile: node.text !== null } : null;
  }
  /** 复制节点快照，拒绝向自身内部复制以避免无限递归。 */
  async copy(src: string, dst: string): Promise<void> {
    const source = this.path(src);
    const destination = this.path(dst);
    const node = this.nodes.get(source);
    if(!node) throw new Error(`复制源不存在：${src}`);
    if(source === destination) throw new Error('复制源与目标不能相同');
    if(node.text !== null) {
      this.write(destination, node.text, node.bytes);
      return;
    }
    if(source === sep || destination.startsWith(source + sep)) throw new Error('不能把目录复制到自身内部');
    // 先取快照，避免一边复制一边遍历刚生成的新节点。
    const descendants = [...this.nodes.entries()].filter(([key]) => key.startsWith(source === sep ? sep : source + sep) && key !== source);
    this.ensureDirectory(destination);
    for(const [path, child] of descendants) {
      const target = destination + sep + path.slice(source === sep ? 1 : source.length + 1);
      if(child.text === null) this.ensureDirectory(target); else this.write(target, child.text, child.bytes);
    }
  }
  /** 先删除整棵子树再通知，回调不会看到半删状态。 */
  async remove(path: string, boundary?: WriteBoundary): Promise<void> {
    this.assertInside(path, boundary);
    const normalized = this.path(path);
    const removed = [...this.nodes.keys()].filter(key => key === normalized || key.startsWith(normalized === sep ? sep : normalized + sep));
    // 先删完整子树再发通知，监听者不会读到半删状态。
    for(const key of removed) this.nodes.delete(key);
    if(normalized === sep) this.nodes.set(sep, { text: null, mtimeMs: this.clock.now() });
    for(const key of removed) this.notify({ path: key, kind: 'rename' });
  }
  /**
   * P75r3：内存版 move，规则与系统版一致：整棵子树连同符号链接、硬链接、权限位的标记一起改名；
   * src 不存在、dst 已存在抛错；dst 的父目录自动建；带边界时 src 的上级每一级被标成符号链接就拒绝。
   */
  async move(src: string, dst: string, boundary?: WriteBoundary, dstBoundary?: WriteBoundary): Promise<void> {
    this.assertInside(src, boundary);
    const from = this.path(src);
    const to = this.path(dst);
    /** 从边界根目录往下，逐级检查 directory 路径上有没有被标成符号链接的（P75r4：目标的上级目录也这样查）。 */
    const assertNoLinkBelow = (within: string, directory: string): void => {
      let current = this.path(within);
      if (this.symlinks.has(current)) throw new PathContainmentError(`${current} 是符号链接`);
      for (const part of directory.slice(current === sep ? 1 : current.length + 1).split(sep).filter(Boolean)) {
        current = current === sep ? sep + part : current + sep + part;
        if (this.symlinks.has(current)) throw new PathContainmentError(`${current} 是符号链接`);
      }
    };
    if (boundary) assertNoLinkBelow(boundary.within, dirname(from));
    if (!this.nodes.has(from)) throw new Error(`移动源不存在：${src}`);
    if (dstBoundary) { this.assertInside(dst, dstBoundary); assertNoLinkBelow(dstBoundary.within, dirname(to)); }
    if (this.nodes.has(to)) throw new Error(`移动目标已存在：${dst}`);
    if (from === sep || to === from || to.startsWith(from + sep)) throw new Error('不能把目录移动到自身内部');
    const moving = [...this.nodes.keys()].filter(key => key === from || key.startsWith(from + sep));
    this.ensureDirectory(dirname(to));
    for (const key of moving) {
      const target = to + key.slice(from.length);
      this.nodes.set(target, this.nodes.get(key)!);
      this.nodes.delete(key);
      if (this.symlinks.delete(key)) this.symlinks.add(target);
      const hard = this.hardlinks.get(key);
      if (hard !== undefined) { this.hardlinks.delete(key); this.hardlinks.set(target, hard); }
      const mode = this.modes.get(key);
      if (mode !== undefined) { this.modes.delete(key); this.modes.set(target, mode); }
    }
    for (const key of moving) this.notify({ path: key, kind: 'rename' });
    this.notify({ path: to, kind: 'rename' });
  }
  /** 注册变化监听并返回取消函数，便于测试关注项生命周期。 */
  watch(path: string, opts: { recursive: boolean }, onChange: (event: FileChange) => void): () => void {
    const watcher = { path: this.path(path), recursive: opts.recursive, callback: onChange };
    this.watchers.add(watcher);
    return () => { this.watchers.delete(watcher); };
  }
  /** 筛选监听范围并隔离回调异常，一个监听失败不影响其他监听。 */
  private notify(event: FileChange): void {
    for(const watcher of [...this.watchers]) {
      const below = event.path.startsWith(watcher.path === sep ? sep : watcher.path + sep);
      if(event.path !== watcher.path && !(below && (watcher.recursive || dirname(event.path) === watcher.path))) continue;
      try { watcher.callback({ ...event }); }
      catch(error) {
        try { this.logger.warn('文件监听回调失败，已隔离本次事件', error); } catch { /* 日志失败不影响其余监听。 */ }
      }
    }
  }
  /** 只列文件，不暴露内部节点；调用方修改快照不会影响文件系统。 */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.nodes.entries()].filter(([, node]) => node.text !== null).sort(([a], [b]) => a.localeCompare(b))
      .map(([path, node]) => [path, node.text as string]));
  }
}
