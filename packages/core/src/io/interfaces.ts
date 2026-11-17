/** 外部能力的最小契约。引擎只依赖接口，真实环境和仿真环境才能使用同一套规则。 */
/** 沙箱不可用的稳定前缀；上层据此识别并失败关闭，不解析具体系统错误。 */
export const SANDBOX_UNAVAILABLE = '沙箱不可用';
/** 宿主命令遇到沙箱不可用时给主人看的固定说明（计划场景 H 要求逐字一致）。 */
export const HOST_SANDBOX_UNAVAILABLE = '沙箱不可用，宿主命令不运行';
/** 写入越界错误的稳定前缀；上层据此识别，不解析具体系统错误。 */
export const PATH_CONTAINMENT = '路径越界';
/**
 * 写入边界：中心在沙箱外运行，写进机器人能改动的目录时必须带上它。
 * 机器人能在自己的目录里放符号链接（指向别处的快捷方式），不带边界的写入会顺着链接写到目录外。
 */
export interface WriteBoundary {
  /** 写入不得离开的根目录；根目录本身和它下面的每一级都不能是符号链接。 */
  within: string;
}
/** 写入被边界拦下。单独成类，让交账流程能把它记成一次越界，而不是普通的磁盘故障。 */
export class PathContainmentError extends Error {
  /** reason 区分原因（目前只有硬链接需要单独提示），不影响原有的调用方式。 */
  constructor(detail: string, readonly reason?: 'hardlink') {
    super(`${PATH_CONTAINMENT}：${detail}`);
    this.name = 'PathContainmentError';
  }
}
/** 限量读取超过了上限（P69 S3）：读到 maxBytes + 1 字节就停下并抛出它，整个文件不会被读进内存。 */
export class ReadLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`读取超过上限（${maxBytes} 字节）`);
    this.name = 'ReadLimitError';
  }
}
/** 限量读取的参数：只能读 within 之内的文件，最多读 maxBytes 字节。 */
export interface BoundedRead {
  /** 读取不得离开的根目录；路径上的每一级不能是符号链接，真实位置必须仍在其中。 */
  within: string;
  /** 允许读到的最大字节数；文件更大就抛 ReadLimitError，且最多只读 maxBytes + 1 字节。 */
  maxBytes: number;
}
/**
 * P81r1（S8）：沙箱生成规则时发现「发布位置的真实路径与传入的不一致」（核对之后路径被换了）。
 * 单独成类，让出站流程能认出它：命令不运行，给主人和员工看的原因用固定句，不带完整路径；
 * 完整路径只放在 detail 里，由调用方写进日志。message 本身不含路径。
 */
export class SandboxRootChanged extends Error {
  /** detail 含完整路径，只能写日志，不能进入出站记录或给人看的文字。 */
  constructor(readonly detail: string) {
    super('发布位置的真实路径与核对时不一致');
    this.name = 'SandboxRootChanged';
  }
}
/** 统一时间来源，规则与仿真不依赖机器墙钟。 */
export interface Clock {
  /** 返回 Unix 毫秒，供所有时限和时间窗口比较。 */
  now(): number;
}
/** 可替换随机源，让标识符与退避在测试中可重放。 */
export interface Rng {
  /** 返回 [0,1) 的随机值，供调用者按业务区间换算。 */
  next(): number;
}
/** 按严重程度记录诊断信息，宿主与测试可选择不同落地方式。 */
export interface Logger {
  /** 记录排查细节，不升级为故障。 */
  debug(message: string, data?: unknown): void;
  /** 记录正常状态转换，便于追踪运行过程。 */
  info(message: string, data?: unknown): void;
  /** 记录可恢复异常，保留上下文供人工查看。 */
  warn(message: string, data?: unknown): void;
  /** 记录操作失败，让上层能诊断被隔离的故障。 */
  error(message: string, data?: unknown): void;
}
/** 只暴露引擎需要的文件元信息，避免依赖系统专属 Stat 类型。 */
export interface FileStat {
  size: number;
  mtimeMs: number;
  isDir: boolean;
  /** 明确区分普通文件与管道、设备；旧适配器缺失时不作为可批准的脚本文件。 */
  isFile?: boolean;
  /** 可选 inode 用于发现同名文件轮转；内存实现可省略。 */
  inode?: number;
}
/**
 * P74r4b：不跟随符号链接的文件信息（lstat）。复制预览副本时要逐个判断：是不是符号链接、有几个硬链接、
 * 是不是普通文件；stat 会跟随链接，看不出这些，所以单独加这个接口。
 */
export interface LinkStat extends FileStat {
  /** 路径本身是不是符号链接（为真时其余字段描述的是链接本身）。 */
  isSymlink: boolean;
  /** 硬链接数；普通文件为 1。内存实现没有标记时按 1。 */
  nlink: number;
  /** 权限位（只取低 9 位）；测试据此确认副本没有可执行位。 */
  mode: number;
}
/** 将原生文件监听事件收敛为路径与变化类别。 */
export interface FileChange {
  path: string;
  kind: 'change' | 'rename';
}
/** 文件能力可替换为内存实现，使持久化和文件关注项可仿真。 */
export interface FsIO {
  /** 读文本；不存在返回 null，以区分缺失与读取故障。 */
  readText(path: string): Promise<string | null>;
  /** 读取普通文件的原始字节，批准指纹不能因 UTF-8 解码替换而漏掉内容变化。 */
  readBytes(path: string): Promise<Uint8Array | null>;
  /**
   * P69：在指定根目录内、限量、按句柄读取一个普通文件。中心在沙箱外替队友搬文件时用它，
   * 因为队友能在自己的目录里放硬链接、符号链接，还能在检查之后把目录换掉。约定：
   * - 不存在返回 null；路径上任何一级是符号链接、不是普通文件、有多个硬链接、真实位置跑出 within、
   *   打开之后路径指向了别的文件，一律抛 PathContainmentError；
   * - 最多读 maxBytes + 1 字节，超过抛 ReadLimitError。
   */
  readBytesWithin(path: string, limit: BoundedRead): Promise<Uint8Array | null>;
  /** 解析实际文件位置，供宿主权限操作在执行前核验符号链接边界。 */
  realpath(path: string): Promise<string>;
  /** 同步判断路径本身是否符号链接：工具守卫是同步钩子，要在每次工具调用前核对家目录。 */
  isSymlinkSync(path: string): boolean;
  /** 先写临时文件再替换目标，避免中途失败留下半份内容。 */
  writeTextAtomic(path: string, text: string, boundary?: WriteBoundary): Promise<void>;
  /**
   * P69：按字节原样写入，同样先写临时文件再替换。图片、压缩包这类二进制文件不能走文本写入，
   * 否则会被当成 UTF-8 解码再编码而损坏；hub_project_put 复制文件靠它。边界约定同 writeTextAtomic。
   */
  writeBytesAtomic(path: string, bytes: Uint8Array, boundary?: WriteBoundary, mode?: number): Promise<void>;
  /**
   * P74r4b：查询路径本身的信息，不跟随符号链接；不存在返回 null。
   * 预览副本的复制要靠它跳过符号链接和多个硬链接的文件。
   */
  lstat(path: string): Promise<LinkStat | null>;
  /** 追加文本，供按日保留的日志使用。 */
  appendText(path: string, text: string, boundary?: WriteBoundary): Promise<void>;
  /** 递归建目录，允许重复调用以简化初始化。 */
  mkdirp(path: string, boundary?: WriteBoundary): Promise<void>;
  /** 只返回直接子项名称；不存在的目录返回空数组。 */
  list(dir: string): Promise<string[]>;
  /** 查询大小和修改时间；不存在返回 null。 */
  stat(path: string): Promise<FileStat | null>;
  /** 复制文件或目录，为恢复与交接保留原始内容。 */
  copy(src: string, dst: string): Promise<void>;
  /** 删除指定路径，供受控保留期清理使用。 */
  remove(path: string, boundary?: WriteBoundary): Promise<void>;
  /**
   * P75r3：移动路径本身，不跟随符号链接。src 是符号链接时移动的是链接本身（链接指向的内容原样留在原处），
   * src 是目录时整棵移走。回合结束核对用它把员工换进来的符号链接、文件、目录搬到存放处。
   * 约定：src 不存在、dst 已存在都抛错；dst 的父目录自动建；带 boundary 时 src 的上级每一级不能是符号链接
   * （不满足抛 PathContainmentError），src 本身是不是链接不限。
   * P75r4：带 dstBoundary 时，建 dst 的上级目录用带边界的建目录办法：dstBoundary.within 与它往下到 dst 上级的每一级都不能是符号链接
   * （不满足抛 PathContainmentError），dst 必须在 dstBoundary.within 之内。不带时保持原来的做法（直接递归建目录）。
   * 为什么：搬走的位置若被员工预先放了链接，东西会顺着链接落进员工写得到的地方。
   */
  move(src: string, dst: string, boundary?: WriteBoundary, dstBoundary?: WriteBoundary): Promise<void>;
  /** 订阅变化并返回取消函数，使关注项停止时能释放监听。 */
  watch(path: string, opts: { recursive: boolean }, onChange: (event: FileChange) => void): () => void;
}
/** 每次网络请求显式带资源上限，避免无界等待和正文积累。 */
export interface NetOptions {
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
}
/** 网络结果保留 HTTP 状态，由不同业务自行判定成功范围。 */
export interface NetResult {
  status: number;
  text: string;
  contentType: string;
}
/** 感知只用 GET，经过动作闸的出站操作才使用 POST。 */
export interface NetIO {
  /** 读取远端正文并遵守超时与字节上限。 */
  get(url: string, opts: NetOptions): Promise<NetResult>;
  /** 提交经批准的正文，仍受相同资源上限约束。 */
  post(url: string, body: string, opts: NetOptions): Promise<NetResult>;
}
/** 执行环境与时限必须显式提供，不借助 shell 解释参数。 */
export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  /** stdout 与 stderr 各自最多保留的 UTF-8 字节数。 */
  maxOutputBytes: number;
  env?: Record<string, string>;
  /**
   * 要求系统沙箱：脚本关注与宿主命令都必须限制写入范围；
   * 无可用系统沙箱时拒绝运行，不能降级为普通进程。
   */
  sandbox?: {
    /** 允许写入的目录；系统临时目录由沙箱实现自动加入。 */
    writableRoots: string[];
    /** 即使位于可写目录内也必须拒绝写入的目录（第一期工作数据故意收窄）。 */
    denyWriteRoots?: string[];
    /**
     * P81：可写目录（必须同时出现在 writableRoots 里）中「允许还不存在」的那几个，只有发布位置。
     * 沙箱按「最深的已存在上级目录的真实路径 + 剩下几段」生成规则，命令可以自己建出这个文件夹；
     * 传入的路径必须已经是解析符号链接之后的真实路径，沙箱重新解析的结果与它不一致（只差大小写除外）就整条命令不运行。
     */
    mayCreateRoots?: string[];
  };
}
/** 将退出、超时与输出资源限制分开，避免软截断被误报为命令失败。 */
export interface ExecResult {
  /** 真实退出码；信号终止时没有退出码，返回 null。 */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 至少一个输出流因保存上限被截断。 */
  outputTruncated: boolean;
  /** 合计输出超过硬上限，执行器主动终止了进程组。 */
  killedForOutput: boolean;
}
/** 可注入执行器让脚本关注和出站命令共享同一组受控边界。 */
export interface ExecIO {
  /** 运行命令文件及独立参数数组，并返回可诊断的退出结果。 */
  run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult>;
}
