/**
 * 内联「新建会话」表单（P44 起，P63 收成一个输入框）。
 *
 * 三个入口共用这一套：项目行加号、队友行加号、项目页顶部的「新开会话」。
 * 项目下的会话就是一个主题聊天，所以只问一句「这条会话做什么」，这句话就是第一条消息。
 * 组件只负责渲染与回传输入，校验、发命令、忙态与错误都留在调用方，
 * 保证几个入口不会各自长出一套慢慢漂移的表单实现。
 */
import type { FormEvent, ReactNode } from 'react'

/** 第一句话的字数上限，和 core 的 TOPIC_MESSAGE_MAX_CHARS 一致；再长的内容放项目目录。 */
export const TOPIC_FIRST_MESSAGE_MAX = 4000

/** 正在新建会话的表单状态：开在哪个项目，以及是不是从某位队友的加号进来的。 */
export interface SidebarFormState {
  projectId: string
  /** 来源队友 id：null 表示从项目行加号进入，非 null 表示队友行加号（第一句话会 @ 它）。 */
  fromBotId: string | null
}

export interface SidebarSessionFormProps {
  /** 项目还没选好时禁止提交（队友不在任何可开会话的项目里）。 */
  canSubmit: boolean
  title: string
  busy: boolean
  error: string | null
  onTitleChange: (value: string) => void
  onCancel: () => void
  onSubmit: (event: FormEvent) => void
}

export function SidebarSessionForm(props: SidebarSessionFormProps): ReactNode {
  return (
    <form className="ah-nav-form" onSubmit={props.onSubmit}>
      <p className="ah-nav-form-title">这条会话做什么？</p>
      <input
        className="ah-nav-form-input"
        aria-label="这条会话做什么"
        placeholder="比如：把本周的竞品更新整理成一页。"
        maxLength={TOPIC_FIRST_MESSAGE_MAX}
        value={props.title}
        onChange={event => props.onTitleChange(event.target.value)}
      />
      {props.error ? <p className="ah-nav-form-error" role="alert">{props.error}</p> : null}
      <div className="ah-nav-form-actions">
        <button type="button" className="ah-btn" onClick={props.onCancel} disabled={props.busy}>取消</button>
        <button type="submit" className="ah-btn ah-btn-primary" disabled={props.busy || !props.canSubmit}>
          {props.busy ? '正在创建……' : '新建会话'}
        </button>
      </div>
    </form>
  )
}
