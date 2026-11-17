/**
 * 设置页各分区的内容（P51；P76k 按方案 7.10.1 精简）。
 *
 * 版式统一成「左边写这一项是什么，右边放控件」的一行一项，取值范围和影响写在说明里，
 * 不再塞进字段名。草稿由 SettingsPane 统一持有，这里只负责显示和上报修改。
 * 知识库的连接测试、全队暂停这些立刻发生的动作，状态留在各自分区内。
 *
 * P76k：第一区只剩免打扰与通知方式；第二区只剩默认模型、给你自己留出（三档）、
 * 员工自己发起的工作（1 到 10），下方是只读的「最近 7 天的用量」表。
 * 日报时间、两个通知条数上限、每位每天的 token 上限都随机制一起删掉了。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { KnowledgeConnectionState, WeeklyUsageView } from '@agent-hub/core'
import type { ModelChoice, OverviewView, SettingsView } from '../../shared/views.js'
import {
  BOT_DAILY_TURN_MAX, BOT_DAILY_TURN_MIN, KB_DEFAULT_MAX_BYTES, QUOTA_SHARE_CHOICES,
  customShareLabel, knowledgeConfigFromDraft, modelSelectOptions, type SettingsDraft,
} from '../logic/settings.js'
import { quotaMeaning } from '../logic/quota.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { EmptyHint, RetryBox } from './Ui.js'

/** P86：「模型额度」一行在有额度窗口视图时写在数字前的时间范围（登记在 docs/copy/strings.json，编号 SET-71）。 */
const STATUS_WINDOW_PREFIX = '本窗口全队合计（含你发起的对话，不含项目主题） '

const PUSH_CHANNEL_LABELS: Readonly<Record<string, string>> = { macos: 'macOS 通知', dsh: 'DSH 内通知', none: '不发通知' }

/** 上报草稿修改的统一签名。 */
type SetDraft = (partial: Partial<SettingsDraft>) => void

/** 草稿的 defaultModel 序列化字符串 → ModelChoice（'' 为跟随默认）。 */
function parseModel(serialized: string): ModelChoice | undefined {
  if (serialized === '') return undefined
  try { return JSON.parse(serialized) as ModelChoice } catch { return undefined }
}

/** 一行设置：左边标题和说明，右边控件。窄屏时控件换到下一行。导出给测试用（测试环境不执行子组件）。 */
export function Row(props: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }): ReactNode {
  return (
    <div className="ah-set-row">
      <div className="ah-set-row-text">
        {props.htmlFor ? <label htmlFor={props.htmlFor}>{props.label}</label> : <span className="ah-set-row-label">{props.label}</span>}
        {props.hint ? <p className="ah-set-hint">{props.hint}</p> : null}
      </div>
      <div className="ah-set-row-control">{props.children}</div>
    </div>
  )
}

export function NotifySection(props: { draft: SettingsDraft; set: SetDraft; settings: SettingsView }): ReactNode {
  const { draft, set } = props
  return (
    <div className="ah-set-rows">
      <Row label="免打扰时段" hint="这段时间产生的通知，到点后再发。">
        <div className="ah-set-inline" role="group" aria-label="免打扰时段">
          <input aria-label="免打扰开始" type="time" step={300} value={draft.quietStart} onChange={e => set({ quietStart: e.target.value })} />
          <span>到</span>
          <input aria-label="免打扰结束" type="time" step={300} value={draft.quietEnd} onChange={e => set({ quietEnd: e.target.value })} />
        </div>
      </Row>
      <Row label="通知方式" hint="只有四类事会通知你：要你确认的约定改动；花钱、对外发布、不可撤销的动作；三轮核对不过或做不下去；长时间没有进展。" htmlFor="ah-set-channel">
        <select id="ah-set-channel" value={draft.pushChannel} onChange={e => set({ pushChannel: e.target.value })}>
          {props.settings.pushChannelOptions.map(channel => (
            <option key={channel} value={channel}>{PUSH_CHANNEL_LABELS[channel] ?? channel}</option>
          ))}
        </select>
      </Row>
    </div>
  )
}

/**
 * 「给你自己留出」三档单选（P76k）。
 * 当前值不在三档里（旧设置里的自定义份额）时多一项如实显示，选中它不会改掉这个值——
 * 主人只能在三档里切换，或者保持原样。
 */
function quotaShareChoices(current: number): Array<{ value: number; label: string; isDefault: boolean }> {
  const choices = QUOTA_SHARE_CHOICES.map(choice => ({ ...choice }))
  if (!choices.some(choice => choice.value === current)) {
    choices.push({ value: current, label: customShareLabel(current), isDefault: false })
  }
  return choices
}

export function UsageSection(props: {
  draft: SettingsDraft
  set: SetDraft
  settings: SettingsView
  /** P76k：最近 7 天的用量表；旧宿主没有这个接口时为 null（不显示这一块）。 */
  weeklyUsage: WeeklyUsageView | null
  weeklyUsageError?: string | null
  onRetryWeeklyUsage: () => void
}): ReactNode {
  const { draft, set } = props
  const models = modelSelectOptions(parseModel(draft.defaultModel), props.settings.modelOptions.filter(option => option.value !== null))
  const share = Number(draft.botQuotaShare)
  return (
    <>
      <div className="ah-set-rows">
        <Row label="默认模型" hint="新员工默认使用，已有员工不受影响。" htmlFor="ah-set-model">
          <select id="ah-set-model" value={draft.defaultModel} onChange={e => set({ defaultModel: e.target.value })}>
            <option value="">跟随 DSH 默认</option>
            {/* 当前默认模型已不在宿主目录时补一项如实显示。 */}
            {models.map((option, i) => <option key={i} value={JSON.stringify(option.value) ?? ''}>{option.label}</option>)}
          </select>
        </Row>
        <Row label="给你自己留出" hint="每个 5 小时额度窗口里，员工不碰这一部分。">
          <div className="ah-set-inline" role="radiogroup" aria-label="给你自己留出">
            {quotaShareChoices(share).map(choice => (
              <label key={choice.value} className="ah-set-radio">
                <input
                  type="radio"
                  name="ah-set-quota-share"
                  value={String(choice.value)}
                  checked={Number(draft.botQuotaShare) === choice.value}
                  onChange={() => set({ botQuotaShare: String(choice.value) })}
                />
                <span>{choice.label}{choice.isDefault ? <span className="ah-set-default-tag">默认</span> : null}</span>
              </label>
            ))}
          </div>
        </Row>
        <Row label="员工自己发起的工作" hint="只管员工没人交代、自己开工的回合。你交代的事按约定里的预计消耗计，复盘与整理另有上限，都不受这一项限制。" htmlFor="ah-set-turns">
          <div className="ah-set-inline">
            <span>每位每天最多</span>
            <input id="ah-set-turns" type="number" min={BOT_DAILY_TURN_MIN} max={BOT_DAILY_TURN_MAX} value={draft.botDailyTurnBudget} onChange={e => set({ botDailyTurnBudget: e.target.value })} />
            <span>回合</span>
          </div>
        </Row>
      </div>
      {/* 用量明细很长，放在设置项下面，免得把真正要改的项挤到屏幕外。 */}
      <WeeklyUsageTable usage={props.weeklyUsage} error={props.weeklyUsageError ?? null} onRetry={props.onRetryWeeklyUsage} />
    </>
  )
}

/** 「最近 7 天的用量」只读表（P76k）：表头与每一行都来自 core 的 weeklyUsageView，界面不另算。 */
export function WeeklyUsageTable(props: { usage: WeeklyUsageView | null; error: string | null; onRetry: () => void }): ReactNode {
  if (props.usage === null && props.error === null) return null
  if (props.usage === null) {
    return (
      <div className="ah-set-usage" role="region" aria-label="最近 7 天的用量">
        <h4 className="ah-set-subhead">最近 7 天的用量</h4>
        <p className="ah-settings-error" role="alert">用量读不出来：{props.error}
          <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onRetry}>重试</button>
        </p>
      </div>
    )
  }
  return (
    <div className="ah-set-usage" role="region" aria-label="最近 7 天的用量">
      <h4 className="ah-set-subhead">最近 7 天的用量</h4>
      <table className="ah-set-usage-table">
        <thead>
          <tr>{props.usage.head.map(cell => <th key={cell} scope="col">{cell}</th>)}</tr>
        </thead>
        <tbody>
          {props.usage.rows.map((row, index) => (
            <tr key={`${row.label}-${index}`}>
              <th scope="row">{row.label}</th>
              <td>{row.turns}</td>
              <td>{row.estimate}</td>
              <td>{row.tokens}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function KnowledgeSection(props: {
  draft: SettingsDraft
  set: SetDraft
  onTest: (config: Record<string, unknown>) => Promise<KnowledgeConnectionState | string>
}): ReactNode {
  const { draft, set } = props
  const [result, setResult] = useState<KnowledgeConnectionState | null>(null)
  const [testing, setTesting] = useState(false)
  // 改了任一连接字段，旧的测试结果就不对应当前内容了，立刻清掉。
  useEffect(() => { setResult(null) }, [draft.kbEnabled, draft.kbEndpoint, draft.kbAuthRef, draft.kbProtocol, draft.kbScope, draft.kbMaxBytes])

  const test = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    const failed = (reason: string): KnowledgeConnectionState => ({ state: 'failed', host: null, protocol: null, reason, errors: [] })
    try {
      const outcome = await props.onTest(knowledgeConfigFromDraft(draft))
      setResult(typeof outcome === 'string' ? failed(outcome) : outcome)
    } catch (e) {
      setResult(failed(e instanceof Error ? e.message : String(e)))
    } finally {
      setTesting(false)
    }
  }
  const clear = (): void => set({ kbEnabled: false, kbEndpoint: '', kbAuthRef: '', kbProtocol: '', kbScope: '', kbMaxBytes: String(KB_DEFAULT_MAX_BYTES) })

  const resultNode = (): ReactNode => {
    if (result === null) return null
    if (result.state === 'ok') return <span className="ah-set-result" role="status">连接正常：主机 {result.host ?? '未知'}，协议 {result.protocol ?? '未知'}。</span>
    if (result.state === 'unconfigured') return <span className="ah-set-result" role="status">未配置完整：请打开开关，并填写连接地址与协议名。</span>
    if (result.state === 'unsupported') return <span className="ah-settings-error" role="alert">{result.reason ?? '暂不支持这个协议'}</span>
    if (result.state === 'failed') return <span className="ah-settings-error" role="alert">连接失败：{result.reason}</span>
    return <span className="ah-settings-error" role="alert">{result.errors.join('　')}</span>
  }

  return (
    <>
      <div className="ah-set-rows">
{/* U11 #29：开关 hint 按定稿拆成几句，每行只回答一个问题；
    https 与凭据两句在下面「连接地址」「凭据名称」行各有一条更具体的 hint，不在这里重复。 */}
        <Row label="启用公共知识库" hint={<>关着：员工看不到知识库，也不会联网。<br />打开：全队能搜、能读，但只能看，权限不变。<br />访问方式还没定，先关着。</>} htmlFor="ah-set-kb-on">
          <input id="ah-set-kb-on" type="checkbox" className="ah-set-switch" checked={draft.kbEnabled} onChange={e => set({ kbEnabled: e.target.checked })} />
        </Row>
        {draft.kbEnabled ? (
          <>
            <Row label="连接地址" hint="必须是 https 开头的完整地址。" htmlFor="ah-set-kb-url">
              <input id="ah-set-kb-url" className="ah-set-text" value={draft.kbEndpoint} placeholder="https://wiki.example.com" onChange={e => set({ kbEndpoint: e.target.value })} />
            </Row>
            <Row label="协议名" hint="小写英文标识，由知识库的接入方式决定。" htmlFor="ah-set-kb-protocol">
              <input id="ah-set-kb-protocol" className="ah-set-text" value={draft.kbProtocol} placeholder="generic-json" onChange={e => set({ kbProtocol: e.target.value })} />
            </Row>
            <Row label="凭据名称" hint="只填凭据在安全存储里的名字，不要粘贴密钥。公开知识库留空。" htmlFor="ah-set-kb-auth">
              <input id="ah-set-kb-auth" className="ah-set-text" value={draft.kbAuthRef} placeholder="vault/wiki-token" onChange={e => set({ kbAuthRef: e.target.value })} />
            </Row>
            <Row label="检索范围" hint="留空表示整个知识库。" htmlFor="ah-set-kb-scope">
              <input id="ah-set-kb-scope" className="ah-set-text" value={draft.kbScope} onChange={e => set({ kbScope: e.target.value })} />
            </Row>
            <Row label="单条读取上限" hint="1024 到 1048576 字节，默认 262144。" htmlFor="ah-set-kb-bytes">
              <div className="ah-set-inline">
                <input id="ah-set-kb-bytes" className="ah-set-wide-number" type="number" min={1024} max={1048576} value={draft.kbMaxBytes} onChange={e => set({ kbMaxBytes: e.target.value })} />
                <span>字节</span>
              </div>
            </Row>
          </>
        ) : null}
      </div>
      {draft.kbEnabled ? (
        <div className="ah-settings-actions ah-set-actions">
          <button type="button" className="ah-btn" disabled={testing} onClick={() => void test()}>{testing ? '测试中…' : '测试连接'}</button>
          <button type="button" className="ah-btn ah-btn-ghost" onClick={clear}>清除配置</button>
          {resultNode()}
        </div>
      ) : null}
    </>
  )
}

export function StatusSection(props: {
  overview: OverviewView | null
  rootDir: string
  /** 总览（运行状态）读不出来时的重试（U11 #28）：不传则只显示提示。 */
  onRetry?: () => void
  onPauseAll: () => Promise<string | null>
  onResumeAll: () => Promise<string | null>
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  // 结果提示只停留几秒：「已全部停用」一直挂着，会让人以为还在执行。
  useEffect(() => {
    if (note === null || busy) return
    const timer = setTimeout(() => { try { setNote(null) } catch { /* 提示消失失败不影响设置页。 */ } }, 2200)
    return () => clearTimeout(timer)
  }, [note, busy])

  const lifecycle = async (work: () => Promise<string | null>, doing: string, done: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote(`${doing}…`)
    try {
      setNote(await work() ?? done)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const o = props.overview
  return (
    <>
      {o ? (
        <dl className="ah-set-rows ah-set-facts">
          <div className="ah-set-row"><dt>后台心跳</dt><dd>{o.health.heartbeatText}</dd></div>
          {o.health.downtimeText ? <div className="ah-set-row"><dt>最近停机</dt><dd>{o.health.downtimeText}</dd></div> : null}
          {/* 沙箱不可用时逐字显示固定说明，避免把宿主命令的失败误当成普通报错。 */}
          {o.health.sandboxWarning ? <div className="ah-set-row"><dt>沙箱</dt><dd className="ah-settings-error">{o.health.sandboxWarning}</dd></div> : null}
          <div className="ah-set-row"><dt>未处理告警</dt><dd>{o.health.openAlerts} 条</dd></div>
          <div className="ah-set-row">
            <dt>模型额度</dt>
            {/* P86：这一行的回合数与 token 是「本窗口内全队」的合计（core 的 quota.usedText：不含项目主题里的回合）；
                顶栏、总管右侧栏的 token 是「本窗口内员工一侧」（不含你发起的对话和主题回合），范围不同，所以有窗口视图时
                把时间范围「本窗口」写在数字前，两处各自无歧义。没有窗口视图的旧宿主保持原写法。 */}
            <dd>{quotaMeaning(o.quota.light).label}，{o.quota.window ? `${STATUS_WINDOW_PREFIX}${o.quota.usedText}` : o.quota.usedText}{o.quota.resetText ? `，${o.quota.resetText}` : ''}</dd>
          </div>
          <div className="ah-set-row"><dt>数据目录</dt><dd className="ah-set-path" title={props.rootDir}>{props.rootDir}</dd></div>
        </dl>
      ) : props.onRetry ? (
        // U11 #28：与待你处理、工作区同一套报错模板，就地给重试。
        <RetryBox message="读不出来。点重试。还不行，看看 DSH 是不是关了。" onRetry={props.onRetry} />
      ) : (
        <EmptyHint text="读不出来。看看 DSH 是不是关了。" />
      )}
      <h4 className="ah-set-subhead">全队操作</h4>
      <p className="ah-set-note">全部停用后所有在岗员工停止自主开工；全部恢复在岗后继续。两项操作立即生效。</p>
      <div className="ah-settings-actions ah-set-actions">
        <button type="button" className="ah-btn ah-btn-danger" disabled={busy} onClick={() => setConfirming(true)}>全部停用</button>
        <button type="button" className="ah-btn" disabled={busy} onClick={() => void lifecycle(props.onResumeAll, '恢复中', '已恢复在岗。')}>全部恢复在岗</button>
        {note ? <span className="ah-set-result" role="status">{note}</span> : null}
      </div>
      {confirming ? (
        <ConfirmDialog
          title="全部停用"
          text="全体在岗员工将停用，不再自主开工。点击「全部恢复在岗」即可恢复。"
          confirmText="全部停用"
          busy={busy}
          error={null}
          onCancel={() => { if (!busy) setConfirming(false) }}
          onConfirm={() => void lifecycle(props.onPauseAll, '停用中', '已全部停用。')}
        />
      ) : null}
    </>
  )
}
