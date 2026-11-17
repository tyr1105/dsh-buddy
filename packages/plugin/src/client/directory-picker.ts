/**
 * 选择文件夹（P73e 从 new-session-bridge.tsx 抽出，新会话下拉和三问卡共用，不复制粘贴）。
 *
 * 做法与官方「选目录」一致：桌面版有全局选择器就直接用，其余环境走宿主的 uiWorkspace 接口。
 * 返回 null 表示你取消了选择；环境不支持时抛错，由调用方决定怎么提示。
 * ctx 允许为空（界面预览里没有宿主上下文）：此时同样视为不支持，不会因为读空对象而崩。
 */
export function pickDirectory(ctx: any): Promise<string | null> {
  const desktop = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick: () => Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
  if (desktop !== undefined) return desktop.pick()
  const uiWorkspace = ctx?.get?.('uiWorkspace') as { pickDirectory?: () => Promise<string | null> } | undefined
  if (typeof uiWorkspace?.pickDirectory !== 'function') return Promise.reject(new Error('当前环境不支持选择文件夹。'))
  return uiWorkspace.pickDirectory()
}
