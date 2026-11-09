/**
 * 资料（P50）：嵌在设置页里的全局配置，登记队友共用的目录、文件、链接，并决定谁能读。
 *
 * 为什么这样组织：和项目页同一纪律——本页只做三件事：把 core 组装好的 ResourceView
 * 摆清楚、把主人的改动拼成 core zod 规定的命令入参、把 core 回的中文错误就近显示。
 * 所有结论文案（全队可读 / 仅授权对象 N 个 / chip / 空态 / 表单校验）都取自
 * logic/resource-page.ts 纯函数，本文件不自己猜授权语义；canRead/路径越界等判定
 * 只在 core，前端不复制。主人取消编制后授权对象只认队友本人。
 *
 * 边界：页面常驻一条横幅说清这是「中心资料治理」而非系统级读隔离（硬隔离需宿主新能力）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CommandResult, Lifecycle, ResourceView, ResourceViewRow } from '../../shared/views.js'
import {
  RESOURCE_BOUNDARY_TEXT, accessConclusion, activeRows, archivedRows, buildSetGrantInput,
  grantChanges, grantSubjectGroups, grantSubjectText, resourceEmptyText, resourceSummary,
} from '../logic/resource-page.js'
import { Skeleton } from '../components/Ui.js'
import { ResourceFormDialog, type ResourceFormSubmit } from '../components/resource-dialogs.js'
import { useToastPlacement } from '../components/use-toast-placement.js'
import { ConfirmDialog } from '../components/confirm-dialog.js'

/** 成功轻提示停留时长（任务卡指定 2.2 秒；视觉沿用 .ah-toast，状态只活在本页）。 */
const SUCCESS_TOAST_MS = 2200

/** 当前打开的弹窗：可辨识联合保证每种弹窗拿到自己需要的上下文。 */
type DialogState =
  | { kind: 'form'; editing: ResourceViewRow | null }
  | { kind: 'archive'; row: ResourceViewRow }

/** 敏感性小标签：受限用警告色描边，普通用次级灰；颜色从不单独表达含义，旁边必有文字。 */
function Tags(props: { row: ResourceViewRow }): ReactNode {
  const r = props.row.resource
  return (
    <span className="ah-res-tags">
      <span className="ah-tag">{props.row.kindLabel}</span>
      <span className={`ah-tag ${r.sensitivity === 'restricted' ? 'ah-res-tag-restricted' : 'ah-res-tag-normal'}`}>
        {props.row.sensitivityLabel}
      </span>
      {props.row.archived ? <span className="ah-tag ah-res-tag-archived">已归档</span> : null}
    </span>
  )
}

/** 一行资料的授权 chips：对象已删除/归档的历史授权用弱化样式，仍诚实显示。 */
function GrantChips(props: { row: ResourceViewRow }): ReactNode {
  if (props.row.resource.sensitivity !== 'restricted') return null
  if (props.row.grants.length === 0) {
    return <p className="ah-res-hint">暂未选择队友，当前无阅读权限。</p>
  }
  return (
    <div className="ah-res-chips">
      {props.row.grants.map(g => (
        <span key={g.grant.id}
          className={`ah-res-chip${g.subjectName === null ? ' ah-res-chip-gone' : ''}`}
          title={g.subjectName === null ? `${g.subjectKindLabel} ${g.subjectId} 已删除或归档（授权保留在历史里）` : g.subjectId}>
          {grantSubjectText(g)}
        </span>
      ))}
    </div>
  )
}

/** 一张资料卡：名称/标签/位置（单行省略，悬停看全）/授权结论与行内操作。 */
function ResourceCard(props: {
  row: ResourceViewRow
  archived: boolean
  onAction: (dialog: DialogState) => void
}): ReactNode {
  const { row, archived } = props
  const r = row.resource
  return (
    <article className={`ah-res-card${archived ? ' ah-res-card-archived' : ''}`}>
      <div className="ah-res-card-main">
        {/* 设置页 h2 → 分区 h3 → 卡名 h4，层级不跳。 */}
        <h4>{r.name} <Tags row={row} /></h4>
        <p className="ah-res-locator" title={r.locator}>{r.locator}</p>
        <p className="ah-res-meta">
          <span>{accessConclusion(row)}</span>
        </p>
        <GrantChips row={row} />
      </div>
      <div className="ah-res-ops">
        {archived ? (
          <>
            {/* 归档资料不开框：按钮禁用并在 title 里说明原因，不放行到 core 才报错。 */}
            <button type="button" className="ah-btn ah-btn-ghost" disabled title="已归档资料不能编辑（数据保留，可由底层数据恢复）">编辑</button>
          </>
        ) : (
          <>
            <button type="button" className="ah-btn ah-btn-ghost" onClick={() => props.onAction({ kind: 'form', editing: row })}>编辑</button>
            <button type="button" className="ah-btn ah-btn-danger" onClick={() => props.onAction({ kind: 'archive', row })}>归档</button>
          </>
        )}
      </div>
    </article>
  )
}

/** 资料授权矩阵页：加载给骨架；数据到齐后按「横幅 → 计数/新建 → 活跃列表 → 归档区」铺陈。 */
export function ResourcePage(props: {
  resource: ResourceView | null
  loading: boolean
  onRetry: () => void
  /** 执行命令（HubPage 注入 hub.command）；失败由弹窗就近显示中文原因。 */
  run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  /** 命令成功后刷新资料矩阵（HubPage 注入 refreshResource）。 */
  onRefresh: () => Promise<unknown> | unknown
  /** 总览队友（唯一的授权对象组）：只排除退役，隔离中仍保留并标注。 */
  bots: ReadonlyArray<{ id: string; name: string; lifecycle: Lifecycle }>
}): ReactNode {
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 弹窗关闭后仍要让人看到的错误（资料已存、授权部分失败）。 */
  const [pageError, setPageError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // WCAG 2.4.11：提示会完全罩住键盘焦点时翻到底部，避免焦点按钮被轻提示遮挡。
  const toastPlacement = useToastPlacement(toast !== null)

  // 卸载时清掉轻提示定时器，避免对已卸载组件 setState（回调异常也不带崩宿主）。
  useEffect(() => () => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
  }, [])

  /** 顶部中间成功轻提示：2.2 秒自动消失；连续成功时重新计时，只显示最新一条。 */
  const showSuccess = (text: string): void => {
    setToast(text)
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    try {
      toastTimer.current = setTimeout(() => {
        toastTimer.current = null
        setToast(null)
      }, SUCCESS_TOAST_MS)
    } catch { /* 定时器不可用时轻提示静默不显示，不影响功能 */ }
  }

  /** 统一提交：成功关窗、刷新、轻提示；失败把 core 的中文错误留在弹窗里，输入不丢。 */
  const submit = async (name: string, input: Record<string, unknown>, successText: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await props.run(name, input)
      if (result.ok) {
        setDialog(null)
        await props.onRefresh()
        showSuccess(successText)
      } else {
        setError(result.error)
      }
    } catch (e) {
      // 宿主层兜底：任何意外都只影响本页，绝不能带崩 DSH（红线 5 的界面侧呼应）。
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (props.resource === null) {
    return (
      <section className="ah-res" aria-label="资料">
        <p className="ah-res-boundary">{RESOURCE_BOUNDARY_TEXT}</p>
        {props.loading ? <Skeleton rows={6} /> : (
          <div className="ah-retry">
            资料读取失败。点击「重试」；仍失败请检查 DSH 运行状态。
            <button type="button" className="ah-btn" onClick={props.onRetry}>重试</button>
          </div>
        )}
      </section>
    )
  }

  const view = props.resource
  const active = activeRows(view)
  const archived = archivedRows(view)
  const groups = grantSubjectGroups(props.bots)
  const emptyText = resourceEmptyText(view)
  const close = (): void => { if (!busy) setDialog(null) }

  /**
   * 保存资料和授权：先存资料，再逐个新增、取消授权。
   * 资料存好后某个授权失败时，关闭弹窗并在页面上说明，避免重复点保存又登记一条新资料。
   */
  const submitResource = async (editing: ResourceViewRow | null, value: ResourceFormSubmit): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setPageError(null)
    try {
      const saved = await props.run('saveResource', value.resource)
      if (!saved.ok) { setError(saved.error); return }
      const id = editing?.resource.id ?? (saved.data as { id?: string } | undefined)?.id
      if (!id) throw new Error('资料已保存，但未取得编号。请刷新后在「编辑」中重新选择队友。')
      const changes = grantChanges(editing, value.botIds)
      const failures: string[] = []
      for (const botId of changes.add) {
        const result = await props.run('setGrant', buildSetGrantInput(id, 'bot', botId, 'read'))
        if (!result.ok) failures.push(result.error)
      }
      for (const botId of changes.remove) {
        const result = await props.run('revokeGrant', { resourceId: id, subjectKind: 'bot', subjectId: botId })
        if (!result.ok) failures.push(result.error)
      }
      setDialog(null)
      await props.onRefresh()
      if (failures.length > 0) setPageError(`资料已保存，但有 ${failures.length} 位队友的读取权限未变更：${failures[0]}。请点击「编辑」重新保存。`)
      else showSuccess(editing ? '修改已保存' : '资料已登记')
    } catch (e) {
      setDialog(null)
      setPageError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ah-res" aria-label="资料">
      <p className="ah-res-boundary">{RESOURCE_BOUNDARY_TEXT}</p>

      <header className="ah-res-head">
        <div className="ah-res-head-main">
          <h3>资料</h3>
          <span className="ah-res-summary">{resourceSummary(view)}</span>
        </div>
        <div className="ah-settings-actions">
          <button type="button" className="ah-btn ah-btn-primary"
            onClick={() => setDialog({ kind: 'form', editing: null })}>＋ 新资料</button>
        </div>
      </header>

      {pageError ? <p className="ah-settings-error" role="alert">{pageError}</p> : null}

      {emptyText !== null ? (
        <div className="ah-empty ah-res-empty">
          {emptyText}
          <button type="button" className="ah-btn ah-btn-primary"
            onClick={() => setDialog({ kind: 'form', editing: null })}>＋ 新资料</button>
        </div>
      ) : (
        <div className="ah-res-list">
          {active.map(row => <ResourceCard key={row.resource.id} row={row} archived={false} onAction={setDialog} />)}
        </div>
      )}

      {/* 归档区默认折叠：归档资料只读陈列，操作按钮禁用并说明原因。 */}
      {archived.length > 0 ? (
        <details className="ah-res-archived">
          <summary>已归档（{archived.length}）</summary>
          <div className="ah-res-list">
            {archived.map(row => <ResourceCard key={row.resource.id} row={row} archived onAction={setDialog} />)}
          </div>
        </details>
      ) : null}

      {/* 成功轻提示：沿用全局 toast 视觉语言（顶部中间、不拦截点击），状态只属于本页。
          WCAG 4.1.3：live 区域空态也常驻，消息到来时只更新同一节点内的文本，读屏才稳定播报；
          aria-atomic=false 保证只念新提示。 */}
      <div ref={toastPlacement.layerRef}
        className={`ah-toast-layer${toastPlacement.below ? ' ah-toast-layer-below' : ''}`}
        aria-live="polite" aria-atomic="false">
        {toast !== null ? <div className="ah-toast">{toast}</div> : null}
      </div>

      {/* 弹窗层：按当前 dialog 种类渲染，busy/error 全页共用一份。 */}
      {dialog?.kind === 'form' ? (
        <ResourceFormDialog editing={dialog.editing} busy={busy} error={error}
          bots={groups.bot} onClose={close} onSubmit={value => void submitResource(dialog.editing, value)} />
      ) : null}
      {dialog?.kind === 'archive' ? (
        <ConfirmDialog title={`归档资料：${dialog.row.resource.name}`} busy={busy} error={error}
          onCancel={close} onConfirm={() => void submit('archiveResource', { id: dialog.row.resource.id }, '资料已归档')}
          confirmText="归档资料"
          text={`归档后「${dialog.row.resource.name}」移入归档区，队友经中心无法读取；授权记录保留但不再生效，资料文件不会被删除。`} />
      ) : null}
    </section>
  )
}
