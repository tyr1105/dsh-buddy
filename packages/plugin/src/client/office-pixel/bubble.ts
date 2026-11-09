/**
 * 头顶气泡（P30）：把 core 的办公室灯翻译成一句抽象状态，不额外编故事。
 *
 * 为什么单独一层：气泡必须只映射真实状态。一旦渲染层自己根据「最近一次唤醒」
 * 猜一句「在努力」，办公室就变成表演。这里只认 core 已经算好的 OfficeLight，
 * 九种灯到气泡的对应关系固定、可单测；文案短，是为了不遮挡小人。
 */
import type { OfficeLight } from '../../shared/views.js'

/** 气泡色调只决定底色，不改变语义。 */
export type OfficeBubbleTone = 'working' | 'waiting' | 'blocked' | 'resting' | 'offline' | 'unknown'

export interface OfficeBubble {
  light: OfficeLight
  /** 完整文案，用于悬停或读屏。 */
  label: string
  /** 气泡里的短文案，最多四个字。 */
  short: string
  tone: OfficeBubbleTone
}

/** 九种灯 → 气泡；空位也给一个诚实的「空位」，不冒充离线。 */
export function officeBubble(light: OfficeLight): OfficeBubble {
  switch (light) {
    case 'working':
      return { light, label: '正在工作', short: '工作', tone: 'working' }
    case 'queued':
      return { light, label: '在排队等开工', short: '排队', tone: 'working' }
    case 'watching':
      return { light, label: '在盯守变化', short: '盯守', tone: 'working' }
    case 'waiting':
      return { light, label: '待确认', short: '待确认', tone: 'waiting' }
    case 'blocked':
      return { light, label: '受阻了，需要帮忙', short: '受阻', tone: 'blocked' }
    case 'resting':
      return { light, label: '在休息', short: '休息', tone: 'resting' }
    case 'offline':
      return { light, label: '离线', short: '离线', tone: 'offline' }
    case 'vacant':
      return { light, label: '空位', short: '空位', tone: 'offline' }
    case 'unknown':
      return { light, label: '状态未知', short: '未知', tone: 'unknown' }
  }
}
