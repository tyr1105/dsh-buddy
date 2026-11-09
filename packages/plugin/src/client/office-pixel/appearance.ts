/**
 * 像素小人的固定外观（P30）：同一个队友 id 永远得到同一套头发、肤色、衣服与配饰。
 *
 * 为什么用 id 哈希而不是随机：Demo 定的是「小人随机固定外观」——看起来随机，
 * 但每次打开、每个页面都必须一样。随机数会让同一个人今天红衣服明天蓝衣服，
 * 主人就无法靠颜色认人。这里只做纯计算，不读时间、不读 Math.random。
 */

export type OfficeHairStyle = 'short' | 'bowl' | 'spiky' | 'bob' | 'buzz' | 'side'
export type OfficeAccessory = 'none' | 'glasses' | 'cap' | 'scarf'

export interface OfficeAppearance {
  hair: OfficeHairStyle
  hairColor: string
  skin: string
  shirt: string
  accessory: OfficeAccessory
  accessoryColor: string
  pants: string
}

/** 演示里用到的色板；新增颜色只改这里，渲染与测试共用同一份。 */
export const OFFICE_HAIR_STYLES: readonly OfficeHairStyle[] = ['short', 'bowl', 'spiky', 'bob', 'buzz', 'side']
export const OFFICE_HAIR_COLORS: readonly string[] = ['#4a352a', '#7a5334', '#a55a3a', '#3a4a5e', '#c9a24a', '#7a3f3f']
export const OFFICE_SKINS: readonly string[] = ['#f0c49a', '#e2b085', '#cf9469']
export const OFFICE_SHIRTS: readonly string[] = ['#b5584d', '#4f8a7d', '#c9a24a', '#5a6aa8', '#7a8a4a', '#a06a8a']
export const OFFICE_ACCESSORIES: readonly OfficeAccessory[] = ['none', 'none', 'glasses', 'cap', 'scarf']
export const OFFICE_ACCENT_COLORS: readonly string[] = ['#3a281d', '#2f4a6b', '#7a3f3f', '#4a5a3a']
export const OFFICE_PANTS: readonly string[] = ['#3f4152', '#4a4038', '#3a4650', '#514a3e']

/**
 * FNV-1a 哈希：与 Demo 相同的算法，保证同一 id 在页面重开后仍得到同一外观。
 * 用 imul 保持 32 位整数，避免大数精度差异。
 */
export function officeHash(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/** 用不同盐位从同一色板取不同维度，避免头发与衣服总是一起变化。 */
function pick<T>(list: readonly T[], hash: number, salt: number): T {
  const mixed = (hash ^ Math.imul(salt, 0x9e3779b1)) >>> 0
  return list[mixed % list.length]!
}

/** 由队友 id 算出一套固定外观；空 id 也有确定结果。 */
export function officeAppearance(botId: string): OfficeAppearance {
  const hash = officeHash(botId)
  return {
    hair: pick(OFFICE_HAIR_STYLES, hash, 1),
    hairColor: pick(OFFICE_HAIR_COLORS, hash, 2),
    skin: pick(OFFICE_SKINS, hash, 3),
    shirt: pick(OFFICE_SHIRTS, hash, 4),
    accessory: pick(OFFICE_ACCESSORIES, hash, 5),
    accessoryColor: pick(OFFICE_ACCENT_COLORS, hash, 6),
    pants: pick(OFFICE_PANTS, hash, 7),
  }
}
