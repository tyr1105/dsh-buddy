/** 内存目录树实现与系统文件相同的契约。写入先完成，再同步通知监听者，便于确定性测试。 */
import { dirname, isAbsolute, normalize, sep } from 'node:path';
import { PathContainmentError } from '../interfaces.js';
import type { Clock, FileChange, FileStat, FsIO, Logger, WriteBoundary } from '../interfaces.js';
import { FakeClock } from './fake-clock.js';
import { MemoryLogger } from './memory-logger.js';

type Node = { text: string | null; mtimeMs: number };
type Watcher = { path: string; recursive: boolean; callback: (event: FileChange) => void };
/** 使用内存目录树模拟文件接口，监听通知只在完整写入后发出。 */
export class MemoryFs implements FsIO {
  private readonly nodes = new Map<string, Node>();
  private readonly watchers = new Set<Watcher>();
  private readonly symlinks = new Set<string>();
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
    return content === null ? null : Buffer.from(content, 'utf8');
  }
  /** 测试专用：把某路径标记成符号链接，供验证同步守卫。内存实现不会真的跟随它。 */
  markSymlink(path: string): void { this.symlinks.add(this.path(path)); }
  /** 只反映 markSymlink 的标记。 */
  isSymlinkSync(path: string): boolean { return this.symlinks.has(this.path(path)); }
  /** 内存文件系统不建符号链接，解析结果保持原路径。 */
  async realpath(path: string): Promise<string> { return path; }
  /** 一次替换完整文本，使监听者不会观察到半份写入。 */
  async writeTextAtomic(path: string, text: string, boundary?: WriteBoundary): Promise<void> {
    this.assertInside(path, boundary);
    // 内存映射替换本身不可分割，回调看到的总是完整的新文本。
    this.write(this.path(path), text);
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
  private write(path: string, text: string): void {
    const existing = this.nodes.get(path);
    if(existing?.text === null) throw new Error(`不能覆盖目录：${path}`);
    this.ensureDirectory(dirname(path));
    this.nodes.set(path, { text, mtimeMs: this.clock.now() });
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
    return node ? { size: node.text === null ? 0 : Buffer.byteLength(node.text, 'utf8'), mtimeMs: node.mtimeMs, isDir: node.text === null, isFile: node.text !== null } : null;
  }
  /** 复制节点快照，拒绝向自身内部复制以避免无限递归。 */
  async copy(src: string, dst: string): Promise<void> {
    const source = this.path(src);
    const destination = this.path(dst);
    const node = this.nodes.get(source);
    if(!node) throw new Error(`复制源不存在：${src}`);
    if(source === destination) throw new Error('复制源与目标不能相同');
    if(node.text !== null) {
      this.write(destination, node.text);
      return;
    }
    if(source === sep || destination.startsWith(source + sep)) throw new Error('不能把目录复制到自身内部');
    // 先取快照，避免一边复制一边遍历刚生成的新节点。
    const descendants = [...this.nodes.entries()].filter(([key]) => key.startsWith(source === sep ? sep : source + sep) && key !== source);
    this.ensureDirectory(destination);
    for(const [path, child] of descendants) {
      const target = destination + sep + path.slice(source === sep ? 1 : source.length + 1);
      if(child.text === null) this.ensureDirectory(target); else this.write(target, child.text);
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
