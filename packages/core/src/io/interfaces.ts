/** 外部能力的最小契约。引擎只依赖接口，真实环境和仿真环境才能使用同一套规则。 */
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
  /** 解析实际文件位置，供宿主权限操作在执行前核验符号链接边界。 */
  realpath(path: string): Promise<string>;
  /** 先写临时文件再替换目标，避免中途失败留下半份内容。 */
  writeTextAtomic(path: string, text: string): Promise<void>;
  /** 追加文本，供按日保留的日志使用。 */
  appendText(path: string, text: string): Promise<void>;
  /** 递归建目录，允许重复调用以简化初始化。 */
  mkdirp(path: string): Promise<void>;
  /** 只返回直接子项名称；不存在的目录返回空数组。 */
  list(dir: string): Promise<string[]>;
  /** 查询大小和修改时间；不存在返回 null。 */
  stat(path: string): Promise<FileStat | null>;
  /** 复制文件或目录，为恢复与交接保留原始内容。 */
  copy(src: string, dst: string): Promise<void>;
  /** 删除指定路径，供受控保留期清理使用。 */
  remove(path: string): Promise<void>;
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
  /** 脚本关注必须限制写入范围；无可用系统沙箱时拒绝运行，不能降级为普通进程。 */
  sandbox?: { writableRoots: string[] };
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
