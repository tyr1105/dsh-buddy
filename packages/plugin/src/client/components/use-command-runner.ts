/**
 * 右栏命令执行小钩子（从 RightPanel 抽出，给主文件压回 400 行以内）：
 * 统一 busy 锁、中文成功 / 失败提示与 2.2 秒自动消失的瞬时 toast。
 * - lock 防重复提交：同一条命令没回来之前，后续调用直接返回 false；
 * - 成功 / 失败都把结果交给调用方决定后续界面状态（如退出编辑态）；
 * - toast 计时器在卸载或下一次提示时清掉，不留更新已卸载组件的副作用。
 */
import { useEffect, useRef, useState } from 'react'
import type { CommandResult } from '../../shared/views.js'

export function useCommandRunner(run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const lock = useRef(false)
  useEffect(() => {
    if (!success || message === null) return
    const timer = setTimeout(() => { try { setMessage(null); setSuccess(false) } catch { /* 提示不影响宿主。 */ } }, 2200)
    return () => clearTimeout(timer)
  }, [success, message])
  const exec = async (name: string, input: Record<string, unknown>, okText: string): Promise<boolean> => {
    if (lock.current) return false
    lock.current = true
    setBusy(true)
    setSuccess(false)
    try {
      const result = await run(name, input)
      setMessage(result.ok ? okText : result.error)
      setSuccess(result.ok)
      return result.ok
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return { busy, message, success, exec, setMessage }
}
