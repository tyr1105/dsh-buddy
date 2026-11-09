/**
 * 左栏内联「新建会话」表单（P44，U01 第 45 轮从主组件拆出）。
 *
 * 两个入口共用这一套表单：队友行加号（固定指派给该队友）、
 * 项目行加号（默认待领，可在成员下拉里改派）。组件只负责渲染与回传输入，
 * 校验、发命令、忙态与错误都留在父层 TeamSidebarNav，
 * 保证两个入口不会各自长出一套慢慢漂移的表单实现。
 */
import type { FormEvent, ReactNode } from 'react'

/** 正在新建会话的表单状态：项目 id + 固定指派（给队友新建时为该队友）。 */
export interface SidebarFormState {
  projectId: string
  botId: string | null
  /** 来源队友 id：null 表示从项目行加号进入（可改派），非 null 表示队友行加号。 */
  fromBotId: string | null
}

/** 成员下拉的一行：id 用于提交，name 用于显示，名字由父层统一解析。 */
export interface SidebarFormMember {
  id: string
  name: string
}

export interface SidebarSessionFormProps {
  form: SidebarFormState
  /** 项目成员（已解析成人名）；为空时不渲染指派下拉。 */
  memberOptions: SidebarFormMember[]
  title: string
  busy: boolean
  error: string | null
  onTitleChange: (value: string) => void
  onMemberChange: (botId: string | null) => void
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}

export function SidebarSessionForm(props: SidebarSessionFormProps): ReactNode {
  const { form } = props
  return (
    <form className="ah-nav-form" onSubmit={props.onSubmit}>
      <p className="ah-nav-form-title">
        这条会话做什么？
      </p>
      {form.fromBotId === null && props.memberOptions.length > 0 ? (
        <select
          className="ah-nav-form-select"
          aria-label="指派给谁"
          value={form.botId ?? ''}
          onChange={event => props.onMemberChange(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">先放待领区</option>
          {props.memberOptions.map(member => (
            <option key={member.id} value={member.id}>{member.name}</option>
          ))}
        </select>
      ) : null}
      <input
        className="ah-nav-form-input"
        aria-label="会话标题"
        placeholder="比如：把本周的竞品更新整理成一页。"
        maxLength={120}
        value={props.title}
        onChange={event => props.onTitleChange(event.target.value)}
      />
      {props.error ? <p className="ah-nav-form-error" role="alert">{props.error}</p> : null}
      <div className="ah-nav-form-actions">
        <button type="button" className="ah-btn" onClick={props.onCancel} disabled={props.busy}>取消</button>
        <button type="submit" className="ah-btn ah-btn-primary" disabled={props.busy || form.projectId === ''}>
          {props.busy ? '正在创建……' : '新建会话'}
        </button>
      </div>
    </form>
  )
}
