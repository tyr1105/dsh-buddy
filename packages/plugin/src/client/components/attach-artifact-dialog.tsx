/**
 * 关联产物对话框（F08 尾巴；U01 第 7 轮从 project-dialogs.tsx 拆出并增强）。
 *
 * 这个文件只做一件事：让主人把某位队友交出的某一版产物挂到一条任务上；
 * 任务走到「待验收」时，验收通过会一并给关联产物记「通过」。
 *
 * 为什么按队友分组加载：产物索引本来就属于某个队友（api.bot(id).artifacts），
 * 一次原则上只读一个队友，读不到时原因留在弹窗里、不关窗、选择不丢。
 *
 * 第 7 轮的增强（抬高上限，不是补 bug）：弹窗第一次打开时默认队友未必有产物，
 * 旧界面直接停在「这个队友没有可关联的产物版本」的空态，主人容易以为全队都没
 * 产物、不知道还要手动换人。现在打开时并行预读全队的产物索引（只读摘要、不带
 * 正文），默认队友空仓就自动落到第一位有版本的队友；主人一旦手动换过人，自动
 * 建议立刻失效，绝不抢选择。预读结果进缓存，手动切换是秒开且不重复请求。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ArtifactListView, ProjectTaskView } from '../../shared/views.js'
import { buildAttachTaskArtifactInput, validateArtifactChoice } from '../logic/project-form.js'
import { suggestArtifactBot } from '../logic/project-page.js'
import { DialogShell, FieldError } from './prj-dialog-shell.js'

/** 已关联产物的验收结论中文（与右栏产物区同一口径；core 视图只给结论枚举）。 */
const VERDICT_TEXT: Record<NonNullable<ArtifactListView['versions'][number]['review']>['verdict'], string> = {
  passed: '通过', not_done: '没做', incorrect: '做错', mismatch: '不符预期',
}

/** 产物版本选项的一句话：版本号 · 标题 · 结论（没结论写未验收）· 生成时间。 */
function artifactOptionText(row: ArtifactListView['versions'][number]): string {
  const verdict = row.review ? VERDICT_TEXT[row.review.verdict] : '未验收'
  let when = ''
  try {
    when = new Date(row.createdAt).toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch { /* 时间格式化失败时只少一段时间，不影响选择 */ }
  return `v${row.number} · ${row.title} · ${verdict}${when ? ` · ${when}` : ''}`
}

/** 单个队友一份产物索引的缓存条目：null 表示该队友确实没有索引（读不到）。 */
type Catalogue = ArtifactListView | null

export function AttachArtifactDialog(props: {
  task: ProjectTaskView
  /** 总览队友（只排除退役）：产物可以来自任何队友，不限于任务指派的队友。 */
  bots: ReadonlyArray<{ id: string; name: string }>
  /** 拉某个队友的产物索引；HubStore.botArtifacts 直读接口，不进全局状态。 */
  loadArtifacts: (botId: string) => Promise<Catalogue>
  busy: boolean
  error: string | null
  onClose: () => void
  onSubmit: (raw: Record<string, unknown>) => void
}): ReactNode {
  const [botId, setBotId] = useState(props.bots[0]?.id ?? '')
  const [catalogue, setCatalogue] = useState<Catalogue>(null)
  const [versionId, setVersionId] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // 全队预读完成标志：用于在「全队都没产物」时把空态说得更肯定，而不是让主人一个个换。
  const [prefetched, setPrefetched] = useState(false)
  const versionRef = useRef<HTMLSelectElement>(null)
  const loadSeq = useRef(0)
  // 只有「重试读取」后第一次 effect 强制越过缓存；切队友不强制。
  const forceRef = useRef<string | null>(null)
  // 主人手动换过人之后，自动建议永久失效（弹窗开着的这一轮）。
  const touchedRef = useRef(false)
  const botIdRef = useRef(botId)
  botIdRef.current = botId
  const cacheRef = useRef<Map<string, Catalogue>>(new Map())
  const inflightRef = useRef<Map<string, Promise<Catalogue>>>(new Map())

  // 用 ref 持有最新的加载函数：页面每次渲染都会传新箭头函数，不能因此反复重拉。
  const loadRef = useRef(props.loadArtifacts)
  loadRef.current = props.loadArtifacts

  /** 读一位队友的产物索引：缓存命中不请求；并发的同队读取合并成同一个 Promise。 */
  const fetchCatalogue = (id: string, force: boolean): Promise<Catalogue> => {
    if (!force && cacheRef.current.has(id)) return Promise.resolve(cacheRef.current.get(id)!)
    const going = inflightRef.current.get(id)
    if (!force && going) return going
    const job = loadRef.current(id)
      .then(view => { cacheRef.current.set(id, view); inflightRef.current.delete(id); return view })
      .catch(cause => { inflightRef.current.delete(id); throw cause })
    inflightRef.current.set(id, job)
    return job
  }
  const fetchRef = useRef(fetchCatalogue)
  fetchRef.current = fetchCatalogue

  // 打开弹窗时并行预读全队索引（只一次）：用于自动落到第一位有产物的队友。
  useEffect(() => {
    if (props.bots.length === 0) { setPrefetched(true); return }
    let alive = true
    void Promise.allSettled(props.bots.map(b => fetchRef.current(b.id, false)))
      .then(() => {
        if (!alive) return
        setPrefetched(true)
        if (touchedRef.current) return
        const ids = props.bots.map(b => b.id)
        const pick = suggestArtifactBot(
          botIdRef.current, false, ids,
          id => (cacheRef.current.get(id)?.versions.length ?? 0) > 0,
        )
        if (pick !== null) setBotId(pick)
      })
    return () => { alive = false }
    // 只在挂载时预读一次；bots 列表在弹窗生命周期内不变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 当前队友变化（或点了重试）时呈现对应索引；乱序响应只认最新一次。
  useEffect(() => {
    const seq = ++loadSeq.current
    setCatalogue(null)
    setVersionId('')
    setLoadError(null)
    if (botId === '') return
    const force = forceRef.current === botId
    forceRef.current = null
    void (async () => {
      try {
        const view = await fetchRef.current(botId, force)
        if (seq !== loadSeq.current) return
        setCatalogue(view)
      } catch (cause) {
        if (seq !== loadSeq.current) return
        setLoadError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [botId, nonce])

  const submit = (): void => {
    const error = validateArtifactChoice(versionId)
    if (error) {
      setFieldError(error)
      versionRef.current?.focus()
      return
    }
    props.onSubmit(buildAttachTaskArtifactInput(props.task.task.id, versionId))
  }

  const versions = catalogue?.versions ?? []
  const loading = botId !== '' && catalogue === null && loadError === null
  // 全队都空：预读完成、当前队友空、且没有任何一位队友有版本。
  const everyoneEmpty = prefetched && !loading && loadError === null && botId !== '' && versions.length === 0
    && props.bots.every(b => (cacheRef.current.get(b.id)?.versions.length ?? 0) === 0)

  return (
    <DialogShell title={`关联产物：${props.task.task.title}`} busy={props.busy}
      error={props.error} onClose={props.onClose}
      footer={<>
        <button type="button" className="ah-btn" disabled={props.busy} onClick={props.onClose}>取消</button>
        <button type="button" className="ah-btn ah-btn-primary" disabled={props.busy || loading}
          onClick={submit}>
          {props.busy ? '关联中…' : '确认关联'}
        </button>
      </>}>
      <p className="ah-right-kv">
        关联后任务行会列出这份产物；任务待验收时「验收通过」会一并给关联产物记「通过」。
        关联固定为当前所选版本；产物后续更新不替换该关联。
      </p>
      <div className="ah-wizard-field">
        <label>哪一位队友交的
          <select value={botId} disabled={props.busy || props.bots.length === 0} autoFocus
            onChange={e => { touchedRef.current = true; setBotId(e.target.value); setFieldError(null) }}>
            {props.bots.length === 0 ? <option value="">暂无可选队友。队友交账后可关联。</option> : null}
            {props.bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
        </label>
        {props.bots.length === 0 ? (
          <p className="ah-right-kv">暂无可选队友。队友交账后可关联。</p>
        ) : null}
      </div>
      <div className="ah-wizard-field">
        <label>选一份产物版本
          <select ref={versionRef} value={versionId} disabled={props.busy || loading || versions.length === 0}
            aria-invalid={props.error === null && fieldError !== null || undefined}
            aria-describedby={props.error === null && fieldError !== null ? 'ah-attach-err-version' : undefined}
            onChange={e => { setVersionId(e.target.value); setFieldError(null) }}>
            <option value="">{loading ? '正在读取…' : '选择产物版本'}</option>
            {versions.map(row => <option key={row.id} value={row.id}>{artifactOptionText(row)}</option>)}
          </select>
        </label>
        <FieldError id="ah-attach-err-version" show={props.error === null && fieldError !== null} message={fieldError} />
        {loading ? <p className="ah-right-kv" role="status">正在读取该队友的产物…</p> : null}
        {!loading && loadError !== null ? (
          <div className="ah-card-error" role="alert">{loadError}
            <button type="button" className="ah-btn" disabled={props.busy}
              onClick={() => { forceRef.current = botId; setNonce(n => n + 1) }}>重试</button>
          </div>
        ) : null}
        {!loading && loadError === null && botId !== '' && versions.length === 0 ? (
          <p className="ah-right-kv">
            该队友暂无可关联的产物版本。请等待其交账并引用工作文件。
            {everyoneEmpty && props.bots.length > 1 ? '（其他队友同样暂无已交出的产物版本。）' : ''}
          </p>
        ) : null}
      </div>
      {props.task.artifacts.length > 0 ? (
        <p className="ah-right-kv">这条任务已关联 {props.task.artifacts.length} 份产物；重复关联同一版本不会重复计数。</p>
      ) : null}
    </DialogShell>
  )
}
