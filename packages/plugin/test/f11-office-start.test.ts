/** F11 空房间的身份判断：只有房间里一个在岗队友都没有时才引导新建。 */
import { describe, expect, it } from 'vitest'
import { officeStartState } from '../src/client/logic/office.js'
import { fixtureOffice } from '../src/shared/fixture-office.js'

describe('F11 首屏身份', () => {
  it('没有座位（也就是没有在岗队友）时引导第一步', () => {
    expect(officeStartState({ ...fixtureOffice, seats: [] })).toBe('empty')
  })
  it('有人在座不显示空房间引导', () => {
    expect(officeStartState(fixtureOffice)).toBeNull()
  })
  it('反例：只剩一个座位也不算空房间', () => {
    expect(officeStartState({ ...fixtureOffice, seats: [fixtureOffice.seats[0]!] })).toBeNull()
  })
  it('座位数只看投影本身，不看门口与房间健康', () => {
    const busyDoor = { ...fixtureOffice, seats: [], doorway: { ...fixtureOffice.doorway, count: 2 } }
    expect(officeStartState(busyDoor)).toBe('empty')
  })
})
