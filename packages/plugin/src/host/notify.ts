/**
 * macOS 系统通知：notify 的唯一落地方式（verified-T7 / 任务卡 D02）。
 * 为什么用 osascript 而不是别的：DSH 宿主进程里没有任何通知服务，桌面版
 * 也没有插件可用的通知通道；osascript -e 'display notification' 是 macOS
 * 上零依赖的系统通知办法。execFile 不经 shell，正文先转义再截断，
 * 避免 Shell 注入与超长正文。
 * pushChannel 为 'none' 时由调用方（host-port）决定不调用这里。
 */
import { execFile } from 'node:child_process'

/** 转义 AppleScript 字符串字面量里的反斜杠与双引号；换行压成空格（通知不支持多行）。 */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')
}

/** 按字符数截断（不是按字节）：通知正文最多 200 字，标题同理。 */
export function truncateForNotify(text: string, maxChars = 200): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('')
}

/** 组装 osascript 参数；非 macOS 平台返回 null（调用方只记日志）。 */
export function notifyCommandArgs(title: string, body: string, platform: string = process.platform): string[] | null {
  if (platform !== 'darwin') return null
  const script = `display notification "${escapeAppleScript(truncateForNotify(body))}" with title "${escapeAppleScript(truncateForNotify(title))}"`
  return ['-e', script]
}

/** 真正发送通知；失败只记日志并正常返回（推送失败绝不能影响引擎）。 */
export function sendMacNotification(title: string, body: string, platform: string = process.platform): Promise<void> {
  return new Promise((resolve) => {
    const args = notifyCommandArgs(title, body, platform)
    if (args === null) {
      console.log(`[agent-hub] 通知（非 macOS，仅记录）：${title} ${body}`)
      resolve()
      return
    }
    execFile('/usr/bin/osascript', args, { timeout: 10_000 }, (error) => {
      if (error) console.error('[agent-hub] 发送系统通知失败:', error)
      resolve()
    })
  })
}
