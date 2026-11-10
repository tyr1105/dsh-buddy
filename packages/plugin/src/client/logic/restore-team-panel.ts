/**
 * 启动或界面被替换后，把中栏选回队友页（看板 P56 / I18）。
 *
 * 为什么需要它：中栏停在哪一页，只记在宿主内存里。页面刷新、DSH 重启、插件界面被
 * 热替换（不重启，直接拆掉旧界面换上新的）时，这个选择都会回到「对话」；而左栏的
 * 「对话 / 队友」是本插件存在本地的，不会变。不处理的话，就成了左栏还是队友、
 * 中栏却跳回对话，主人会觉得页面自己跳走了。
 *
 * 规则只有三条：
 * 1. 每次插件启动最多选一次，之后主人去哪一页都不再干预；
 * 2. 只有左栏是队友模式才选，对话模式什么都不做；
 * 3. 中栏如果已经停在某个功能页（比如主人正在插件管理页点更新），不抢。
 *
 * 为什么要等信号：冷启动时，宿主的布局服务和中栏插槽都可能比本插件晚就绪，
 * 谁先到不确定。所以每个前置条件就绪时都试一次，有结论就结束。
 * 没就绪时宿主会抛错，这里吞掉，等下一个信号；不轮询，也不设定时器。
 */
import type { SpaceMode } from './space-capability.js'

/** 这个文件需要外面提供的能力。用接口隔开，测试时可以换成假的宿主。 */
export interface TeamPanelRestorePort {
  /** 读最新的左栏模式：等待期间主人可能已经切回对话，不能用启动时的旧值。 */
  getMode(): SpaceMode
  /** 中栏当前选中的页面：null 是对话；undefined 表示宿主没有提供这项信息。 */
  getActivePanel(): string | null | undefined
  /** 选中队友页。布局服务或队友页还没就绪时会抛错。 */
  selectTeamPanel(): void
}

export interface TeamPanelRestore {
  /** 某个前置条件就绪时调用。可以调用多次，真正选中最多一次。 */
  attempt(): void
  /** 插件卸载时调用：还没执行的尝试直接作废。 */
  dispose(): void
}

export function createTeamPanelRestore(port: TeamPanelRestorePort): TeamPanelRestore {
  // settled 为真表示这次启动已经有结论（选中了，或判断不该选），后面的信号直接忽略。
  let settled = false

  const run = (): void => {
    if (settled) return
    try {
      // 对话模式：左右本来就一致，这次启动不用再管。
      if (port.getMode() !== 'team') {
        settled = true
        return
      }
      // 中栏已经停在某一页（可能就是队友页，也可能是别的功能页）：都不用动。
      if (typeof port.getActivePanel() === 'string') {
        settled = true
        return
      }
      port.selectTeamPanel()
      settled = true
    } catch {
      // 布局服务或队友页还没就绪，属于正常等待，不记错误；下一个信号再试。
    }
  }

  return {
    attempt() {
      if (settled) return
      // 放到微任务里执行：信号可能来自宿主注册插槽的过程中，等这一轮注册收尾再选页面；
      // 微任务在浏览器绘制之前跑完，主人看不到对话页闪一下。
      queueMicrotask(run)
    },
    dispose() {
      settled = true
    },
  }
}
