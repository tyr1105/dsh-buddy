/** 引擎公共依赖与内存运行态：业务只能经过这些接口访问世界，重启后不恢复监听器与去抖批次。 */
import type { HubEventScope } from '../api/event-scopes.js';
import type { ListModels } from '../api/models.js';
import type { Store } from '../store/interfaces.js';
import type { Clock, Rng, FsIO, NetIO, ExecIO, Logger } from '../io/interfaces.js';
import type { HostPort, Settings } from '../model/index.js';

export interface HubRuntime {
  /** 主人打断可在串行投递等待之外释放该次等待，不依赖宿主先返回。 */
  deliveryInterrupts: Map<string, () => void>;
  startedAt: number; lastTickAt: number | null; lastDispatchAt: number | null; ownerActiveAt: number | null;
  pendingFileEvents: Map<string, { firstAt: number; lastAt: number; paths: Set<string>; kinds: Set<string> }>;
  watchDisposers: Map<string, () => void>;
  suppressionLogAt: Map<string, number>;
  lastHeartbeatAt: number | null;
}
export interface HubContext {
  store: Store; clock: Clock; rng: Rng; fs: FsIO; net: NetIO; exec: ExecIO; host: HostPort; logger: Logger;
  settings: Settings; runtime: HubRuntime;
  /** 主人家目录由宿主提供，核心不能自行读取环境变量猜测敏感路径。 */
  ownerHome?: string;
  /** 可选宿主模型目录，供设置视图和机器人编辑共用。 */
  listModels?: ListModels;
  /** 通知宿主哪些视图需要刷新，使核心无需依赖界面框架。 */
  emit(scope: HubEventScope, botId?: string | null): void;
}

/** 启动时间由宿主或假时钟提供；每个中心拥有独立集合，避免不同实例互相抑制。 */
export function createRuntime(now: number): HubRuntime {
  return { deliveryInterrupts: new Map(), startedAt: now, lastTickAt: null, lastDispatchAt: null, ownerActiveAt: null,
    pendingFileEvents: new Map(), watchDisposers: new Map(), suppressionLogAt: new Map(), lastHeartbeatAt: null };
}
