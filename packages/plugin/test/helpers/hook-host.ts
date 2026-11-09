/**
 * 测试用的「单组件 hook 宿主」：在没有真 React 的测试环境里，模拟一个组件的连续渲染。
 *
 * 为什么要自己写：插件运行时的 react 由宿主提供，依赖里没有 react，也没有 jsdom，
 * 所以测试不能真的挂载组件；但「展开和收起时 hook 数量不一样」这类崩溃，
 * 只有在同一次挂载上连续渲染才看得出来。
 *
 * 这个宿主只做四件事，和 React 的行为对齐：
 * 1. 按调用顺序给 hook 分配槽位，状态在多次渲染之间保留；
 * 2. 复刻 React 的校验：hook 变少（#300）、变多（#310）、类型错位都直接抛错；
 * 3. 渲染后「提交」：新出现的 ref 挂上假元素，消失的 ref 置回 null，和 DOM 节点卸载一致；
 * 4. 提交后跑 effect：依赖变了才跑，先做上一轮清理；effect 里 setState 会再渲染一轮。
 *
 * 只渲染传进来的这一个组件，子组件不执行，所以它们的 hook 不算在内。
 */

type Deps = readonly unknown[] | undefined
type EffectCleanup = void | (() => void)
type RefBox = { current: unknown }

interface StateSlot { kind: 'state'; value: unknown; setValue: (next: unknown) => void }
interface RefSlot { kind: 'ref'; box: RefBox }
interface MemoSlot { kind: 'memo'; value: unknown; deps: Deps }
interface EffectSlot { kind: 'effect'; deps: Deps; cleanup: EffectCleanup; pending: (() => EffectCleanup) | null }
interface StoreSlot { kind: 'store' }
type Slot = StateSlot | RefSlot | MemoSlot | EffectSlot | StoreSlot

/** 一次渲染期间交给 hook 函数用的两个能力。 */
interface RenderContext {
  /** 按调用顺序取下一个槽位；第一次渲染时用 create 新建，之后校验类型没有错位。 */
  allocate<S extends Slot>(kind: S['kind'], create: () => S): S
  /** setState 改了值：提交结束后要再渲染一轮。 */
  markDirty(): void
}

/** 假的 DOM 元素：只提供滚动测量会读到的几个属性。 */
export interface FakeElement {
  scrollHeight: number
  clientHeight: number
  getBoundingClientRect: () => { bottom: number }
}

function createFakeElement(): FakeElement {
  return { scrollHeight: 100, clientHeight: 100, getBoundingClientRect: () => ({ bottom: 100 }) }
}

/** 两组依赖是否相同：undefined（不写依赖数组）表示每次都要重新执行。 */
function sameDeps(previous: Deps, next: Deps): boolean {
  if (previous === undefined || next === undefined || previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

/** 判断一个 prop 是不是 ref 对象：只有 current 一个键。透传给子组件的 rowsRef 也靠这个认出来。 */
function isRefBox(value: unknown): value is RefBox {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === 'current'
}

/** 收集这棵元素树上所有的 ref；函数组件的内部不展开，只看传给它的 props。 */
function collectRefs(node: unknown, found: Set<RefBox>): void {
  if (Array.isArray(node)) { node.forEach(child => collectRefs(child, found)); return }
  if (typeof node !== 'object' || node === null || !('props' in node)) return
  const props = (node as { props: Record<string, unknown> }).props
  for (const value of Object.values(props)) {
    if (isRefBox(value)) found.add(value)
  }
  collectRefs(props.children, found)
}

export interface HookHost {
  /** 渲染一次并完成提交；effect 里 setState 触发的后续渲染也在这里跑完。 */
  render<P>(component: (props: P) => unknown, props: P): unknown
}

/** 正在渲染的宿主：hook 函数靠它找到自己的槽位，渲染结束后清空。 */
let active: RenderContext | null = null

/** 取当前宿主；在渲染之外调用 hook 就报错，和真实 React 一样。 */
function currentContext(): RenderContext {
  if (active === null) throw new Error('hook 只能在 HookHost.render 的组件里调用')
  return active
}

function useEffectFacade(effect: () => EffectCleanup, deps: Deps): void {
  const slot = currentContext().allocate<EffectSlot>('effect', () => ({ kind: 'effect', deps: undefined, cleanup: undefined, pending: null }))
  if (slot.pending !== null || !sameDeps(slot.deps, deps)) slot.pending = effect
  slot.deps = deps
}

/** 交给 vi.mock('react') 的替身：转发到正在渲染的宿主。 */
export const reactFacade = {
  // 错误边界在 import 时就要继承 Component；Fragment 只用来占位，这里都不需要真实现。
  Component: class { },
  Fragment: Symbol.for('test.fragment'),
  useEffect: useEffectFacade,
  // 这里不区分提交前后，和 useEffect 走同一套槽位就够测试用。
  useLayoutEffect: useEffectFacade,
  /** 读仓库快照；第一次渲染时订阅，effect 里改仓库要能触发下一轮渲染。 */
  useSyncExternalStore(subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown): unknown {
    const context = currentContext()
    context.allocate<StoreSlot>('store', () => {
      subscribe(() => context.markDirty())
      return { kind: 'store' }
    })
    return getSnapshot()
  },
  useState(initial: unknown): [unknown, (next: unknown) => void] {
    const context = currentContext()
    const slot = context.allocate<StateSlot>('state', () => {
      const created: StateSlot = {
        kind: 'state',
        value: typeof initial === 'function' ? (initial as () => unknown)() : initial,
        // 值没变不触发重渲染，和真实 React 的跳过逻辑一致；测量函数每轮都 setState，靠这条才会停下来。
        setValue: (next) => {
          const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(created.value) : next
          if (Object.is(value, created.value)) return
          created.value = value
          context.markDirty()
        },
      }
      return created
    })
    return [slot.value, slot.setValue]
  },
  useRef(initial: unknown): RefBox {
    return currentContext().allocate<RefSlot>('ref', () => ({ kind: 'ref', box: { current: initial } })).box
  },
  useMemo(factory: () => unknown, deps: Deps): unknown {
    const slot = currentContext().allocate<MemoSlot>('memo', () => ({ kind: 'memo', value: factory(), deps }))
    if (!sameDeps(slot.deps, deps)) {
      slot.value = factory()
      slot.deps = deps
    }
    return slot.value
  },
}

/** 建一个宿主，相当于一次组件挂载：多次 render 共享同一组槽位。 */
export function createHookHost(): HookHost {
  const slots: Slot[] = []
  let cursor = 0
  let mounted = false
  let dirty = false
  const attachedRefs = new Set<RefBox>()

  const context: RenderContext = {
    allocate<S extends Slot>(kind: S['kind'], create: () => S): S {
      const index = cursor++
      const existing = slots[index]
      if (existing === undefined) {
        if (mounted) throw new Error('Rendered more hooks than during the previous render（React #310）')
        const slot = create()
        slots.push(slot)
        return slot
      }
      if (existing.kind !== kind) throw new Error(`hook 顺序错位：第 ${index + 1} 个原来是 ${existing.kind}，这次是 ${kind}`)
      return existing as S
    },
    markDirty() { dirty = true },
  }

  /** 提交：先同步 ref（真实 React 也是在 effect 之前），再清理、再执行本轮到期的 effect。 */
  const commit = (element: unknown): void => {
    const live = new Set<RefBox>()
    collectRefs(element, live)
    for (const box of attachedRefs) {
      if (!live.has(box)) { box.current = null; attachedRefs.delete(box) }
    }
    for (const box of live) {
      if (!attachedRefs.has(box)) { box.current = createFakeElement(); attachedRefs.add(box) }
    }
    const due = slots.filter((slot): slot is EffectSlot => slot.kind === 'effect' && slot.pending !== null)
    for (const slot of due) {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = undefined
    }
    for (const slot of due) {
      const effect = slot.pending
      slot.pending = null
      if (effect !== null) slot.cleanup = effect()
    }
  }

  return {
    render<P>(component: (props: P) => unknown, props: P): unknown {
      // 上限防死循环：effect 反复改状态时报错，而不是把测试卡住。
      for (let round = 0; round < 20; round++) {
        dirty = false
        cursor = 0
        active = context
        let element: unknown
        try { element = component(props) } finally { active = null }
        if (mounted && cursor < slots.length) throw new Error('Rendered fewer hooks than expected（React #300）')
        mounted = true
        commit(element)
        if (!dirty) return element
      }
      throw new Error('effect 里的 setState 一直在触发重渲染，停不下来')
    },
  }
}
