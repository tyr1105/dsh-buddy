/**
 * 倒带时间轴的纯展示规则（交互审查第 6 轮，抬高上限）：
 * 把 core 给的「今天有哪些帧 / 断点」换算成轨道位置（百分比）和键盘步进落点。
 * 为什么单独成文件：位置换算和「上一帧 / 下一帧」不依赖 React，全部可单测；
 * 界面只拿到百分比和时间戳，不自己推断「这段时间有没有记录」这类业务含义。
 */
/** 轨道上的一个点：frame=有房间观察；gap=从此时刻起没有可靠观察（失败/停止/未运行）。 */
export interface ReplayTrackItem {
  id: string
  at: number
  kind: 'frame' | 'gap'
  reason: string | null
}

/** 有房间观察的刻度。 */
export interface ReplayTrackTick {
  id: string
  at: number
  /** 在整条轨道上的水平位置（0–100），与 range 输入框同坐标系。 */
  left: number
}

/** 没有可靠观察的色带：从断点时刻延伸到下一帧之前（或当前时刻）。 */
export interface ReplayGapBand {
  id: string
  at: number
  left: number
  width: number
  reason: string | null
}

export interface ReplayTrack {
  ticks: ReplayTrackTick[]
  gaps: ReplayGapBand[]
}

/** 时刻在当天轨道上的位置：dayStart=0、now=100；异常时间钳在轨道内，不溢出。 */
export function framePercent(at: number, dayStart: number, now: number): number {
  if (now <= dayStart) return 0
  const pct = ((at - dayStart) / (now - dayStart)) * 100
  return Math.min(100, Math.max(0, pct))
}

/**
 * 组轨道：帧画刻度；断点画一段「没有可靠观察」的色带。
 * 输入假定来自 core（已按当天裁剪、按时间排序），这里仍防御性排序与过滤，
 * 让走查桩或旧接口返回乱序数据时轨道也不会错位。
 */
export function buildReplayTrack(
  frames: readonly ReplayTrackItem[],
  dayStart: number,
  now: number,
): ReplayTrack {
  const rows = frames
    .filter(f => f.at >= dayStart && f.at <= now)
    .slice()
    .sort((a, b) => a.at - b.at)
  const ticks: ReplayTrackTick[] = []
  const gaps: ReplayGapBand[] = []
  for (const [index, row] of rows.entries()) {
    const left = framePercent(row.at, dayStart, now)
    if (row.kind === 'frame') {
      ticks.push({ id: row.id, at: row.at, left })
      continue
    }
    // 色带右端：下一个帧之前；后面再没有帧，就到当前时刻为止。
    const nextFrame = rows.slice(index + 1).find(f => f.kind === 'frame')
    const right = framePercent(nextFrame ? nextFrame.at : now, dayStart, now)
    gaps.push({ id: row.id, at: row.at, left, width: Math.max(0, right - left), reason: row.reason })
  }
  return { ticks, gaps }
}

/** 方向键步进：当前时刻之前最近的一帧（不含当前时刻）；没有更早的帧则返回 null。 */
export function previousFrameAt(frames: readonly ReplayTrackItem[], at: number): number | null {
  const earlier = frames
    .filter(f => f.kind === 'frame' && f.at < at)
    .sort((a, b) => b.at - a.at)
  return earlier[0]?.at ?? null
}

/** 方向键步进：当前时刻之后最近的一帧（不含当前时刻）；没有更晚的帧则返回 null。 */
export function nextFrameAt(frames: readonly ReplayTrackItem[], at: number): number | null {
  const later = frames
    .filter(f => f.kind === 'frame' && f.at > at)
    .sort((a, b) => a.at - b.at)
  return later[0]?.at ?? null
}
