/** 首屏说明：用同一段短说明连接空对话与空房间；按钮仍打开原有向导，不自动创建。 */
import { useState, type ReactNode } from 'react'
import type { OfficeView } from '../../shared/views.js'
import { officeStartState } from '../logic/office.js'

/** 创建入口异常留在本块；它只负责解释下一步，不替主人填角色或提交。 */
export function FirstTeammate(props: { onNewBot?: () => void }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="ah-office-start" aria-label="新建第一位队友">
      <h3>新建第一位队友</h3>
      <p>队友持续观察变化，满足条件时执行。汇报留在会话里；需要你回复或批准时，会出现在「待你处理」。</p>
      <dl className="ah-office-guide">
        <div><dt>座位和灯</dt><dd>谁在做事、谁在等待</dd></div>
        <div><dt>桌上的结果</dt><dd>点开看这次做了什么</dd></div>
        <div><dt>门口的信箱</dt><dd>待你处理入口</dd></div>
      </dl>
      {props.onNewBot ? (
        <button type="button" className="ah-btn ah-btn-primary" onClick={() => {
          try { setError(null); props.onNewBot?.() } catch { setError('新建向导打开失败。请重试。') }
        }}>新建队友</button>
      ) : null}
      <p className="ah-office-start-note">创建后先试跑。之后可点名字对话。</p>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  )
}

/** 房间里没有任何在岗队友时才出现；有队友时这一块不占位置。 */
export function OfficeStart(props: { office: OfficeView; onNewBot?: () => void }): ReactNode {
  if (officeStartState(props.office) === null) return null
  return <FirstTeammate onNewBot={props.onNewBot} />
}
