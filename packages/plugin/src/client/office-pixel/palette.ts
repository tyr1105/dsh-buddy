/**
 * 像素办公室的调色板（P54 明亮改版）。
 *
 * 为什么单独一个文件：画面好不好看，八成取决于这张表。把颜色集中在这里，
 * 以后想整体换一种心情，只改这一处，不用去几千个小方块里找颜色。
 *
 * 配色思路（主人的要求是「明亮轻快，但要像办公室」）：
 * 1. 大面积用干净的白墙和浅蓝灰的方块地毯，这是写字楼的底色，一眼就不是家里；
 * 2. 墙上一道青绿加黄的企业色带，隔断和设备用亮色点缀，让画面有精神；
 * 3. 描边用偏冷的深灰蓝，比暖棕色更利落，又不像纯黑那么硬。
 *
 * 这里只放「房间」的颜色；队友的衣服和头发在 appearance.ts，气泡底色在 render.ts。
 */

/** 房间调色板；页面可以整体换色，但布局坐标不变。 */
export interface OfficePalette {
  // —— 墙面与天花 ——
  wall: string
  /** 腰线以下的浅色墙面。 */
  wallLower: string
  /** 墙上企业色带的主色和细线。 */
  wallAccent: string
  wallAccentThin: string
  /** 踢脚线、窗台这些白色收边。 */
  trim: string
  trimShadow: string
  ceiling: string
  ceilingGrid: string

  // —— 地面 ——
  floorA: string
  floorB: string
  floorSeam: string
  tileA: string
  tileB: string
  aisle: string
  meetingA: string
  meetingB: string

  // —— 工位 ——
  desk: string
  deskTop: string
  deskEdge: string
  deskShadow: string
  chair: string
  screen: string
  screenOn: string
  monitorBody: string

  // —— 通用 ——
  outline: string
  bubbleBorder: string
  board: string
  metal: string
  metalDark: string
  water: string
  table: string
  woodDark: string
  woodLight: string

  // —— 绿植 ——
  leaf: string
  leafDark: string
  leafLight: string
  pot: string
  potDark: string

  // —— 玻璃、窗、钟 ——
  glass: string
  glassFrost: string
  windowFrame: string
  windowSky: string
  windowSkyDeep: string
  blind: string
  blindShade: string
  clockFace: string
  clockRim: string

  // —— 公告栏与灯 ——
  cork: string
  noteA: string
  noteB: string
  noteC: string
  noteD: string
  lampBulb: string

  // —— 点缀色 ——
  coral: string
  coralDark: string
  teal: string
  tealDark: string
  sun: string
  sunDark: string

  // —— 只用来营造氛围的半透明光 ——
  wallGlow: string
  floorShade: string
  floorLift: string
  sunbeamA: string
  sunbeamB: string
  lampHalo: string
  lampGlow: string
}

export const DEFAULT_OFFICE_PALETTE: OfficePalette = {
  // 墙：白墙配浅蓝的下半截，中间一道企业色带，是写字楼最常见的做法。
  wall: '#fbfaf6',
  wallLower: '#e4f1f5',
  wallAccent: '#45c4b4',
  wallAccentThin: '#ffcf57',
  trim: '#ffffff',
  trimShadow: '#d6e0ea',
  ceiling: '#eef2f7',
  ceilingGrid: '#dbe4ed',

  // 地：工作区是浅蓝灰方块地毯；共享区更浅；会议室用青绿色地毯，三个区一眼分得开。
  floorA: '#e0f1f9',
  floorB: '#d4e9f4',
  floorSeam: '#c7dfec',
  tileA: '#f8fbfd',
  tileB: '#eff6fa',
  aisle: 'rgba(255, 255, 255, 0.55)',
  meetingA: '#cdeee6',
  meetingB: '#c2e8df',

  // 桌子：白色桌面、浅钢蓝桌身，和后面彩色的隔断对比开。
  desk: '#bfd2e4',
  deskTop: '#ffffff',
  deskEdge: '#dde6ef',
  deskShadow: 'rgba(90, 110, 140, 0.26)',
  chair: '#5f83bd',
  screen: '#7c8ba6',
  screenOn: '#a8f0dc',
  monitorBody: '#eef2f8',

  outline: '#4d5569',
  bubbleBorder: '#4d5569',
  board: '#fffffb',
  metal: '#dbe3ec',
  metalDark: '#a9b7c7',
  water: '#8fdcff',
  table: '#f4c98f',
  woodDark: '#c9925a',
  woodLight: '#fbdcae',

  leaf: '#72d083',
  leafDark: '#46b36b',
  leafLight: '#b0ec9f',
  pot: '#f2f6fa',
  potDark: '#cbd7e3',

  glass: 'rgba(186, 228, 246, 0.55)',
  glassFrost: 'rgba(255, 255, 255, 0.62)',
  windowFrame: '#c9d5e1',
  windowSky: '#87d7ff',
  windowSkyDeep: '#c6efff',
  blind: '#ffffff',
  blindShade: '#dbe4ed',
  clockFace: '#fffef7',
  clockRim: '#6c86a6',

  cork: '#eec083',
  noteA: '#ffe16b',
  noteB: '#a3dcff',
  noteC: '#ffb6c8',
  noteD: '#b4efa8',
  lampBulb: '#fff8d2',

  coral: '#ff9d86',
  coralDark: '#f07f69',
  teal: '#5cc9ba',
  tealDark: '#3bab9b',
  sun: '#ffcf57',
  sunDark: '#f2b13c',

  // 亮色房间里，光要用白色系的半透明叠上去，才会显得通透而不是发灰。
  wallGlow: 'rgba(255, 255, 255, 0.45)',
  floorShade: 'rgba(90, 110, 140, 0.03)',
  floorLift: 'rgba(255, 255, 255, 0.10)',
  sunbeamA: 'rgba(255, 252, 220, 0.62)',
  sunbeamB: 'rgba(255, 252, 220, 0.44)',
  lampHalo: 'rgba(255, 250, 215, 0.16)',
  lampGlow: 'rgba(255, 252, 228, 0.26)',
}

/** 工位隔断的颜色：每个座位一种亮色，工位区一眼有活力，也方便主人记住谁坐哪。 */
export const OFFICE_PANEL_COLORS: readonly string[] = ['#7fd8cc', '#ffd877', '#9dd0f7', '#ffb3a3', '#c4b5f3', '#aee6a4']

/** 档案盒、饮料这类零碎小物件轮流用的点缀色。 */
export const OFFICE_ACCENTS: readonly string[] = ['#ff8f7a', '#ffd166', '#6fc9ee', '#b79cf0', '#7ed99a', '#ff9fbd']
