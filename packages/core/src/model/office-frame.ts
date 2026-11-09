/** 房间历史独立保存观察结果与断点；不修改队友、账本或当前编制事实。 */
import type { OfficeView } from '../office/project.js';

export interface OfficeFrame {
  id: string;
  at: number;
  /** 同一毫秒可能经过多个状态；序号使重启后仍能确定最后一次观察。 */
  sequence: number;
  dateKey: string;
  kind: 'frame' | 'gap';
  room: OfficeView | null;
  reason: string | null;
}
