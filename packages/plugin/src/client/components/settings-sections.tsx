/**
 * 设置页各分区的内容（P51）：打扰与日报、模型与用量、公共知识库、运行状态。
 *
 * 版式统一成「左边写这一项是什么，右边放控件」的一行一项，取值范围和影响写在说明里，
 * 不再塞进字段名。草稿由 SettingsPane 统一持有，这里只负责显示和上报修改。
 * 知识库的连接测试、全队暂停这些立刻发生的动作，状态留在各自分区内。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { KnowledgeConnectionState } from '@agent-hub/core'
import type { ModelChoice, OverviewView, SettingsView } from '../../shared/views.js'
import {
  BOT_DAILY_TOKEN_MAX, BOT_DAILY_TOKEN_MIN, BOT_DAILY_TOKEN_STEP,
  BOT_DAILY_TURN_MAX, BOT_DAILY_TURN_MIN, KB_DEFAULT_MAX_BYTES,
  knowledgeConfigFromDraft, modelSelectOptions, type SettingsDraft,
} from '../logic/settings.js'
import { quotaMeaning } from '../logic/quota.js'
import { CostMeter } from './cost-meter.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { EmptyHint, RetryBox } from './Ui.js'

const PUSH_CHANNEL_LABELS: Readonly<Record<string, string>> = { macos: 'macOS 通知', dsh: 'DSH 内通知', none: '不发通知' }

/** 上报草稿修改的统一签名。 */
type SetDraft = (partial: Partial<SettingsDraft>) => void

/** 草稿的 defaultModel 序列化字符串 → ModelChoice（'' 为跟随默认）。 */
function parseModel(serialized: string): ModelChoice | undefined {
  if (serialized === '') return undefined
  try { return JSON.parse(serialized) as ModelChoice } catch { return undefined }
}

/** 一行设置：左边标题和说明，右边控件。窄屏时控件换到下一行。 */
function Row(props: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }): ReactNode {
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
      <Row label="免打扰时段" hint="这段时间队友不发通知，紧急告警除外。">
        <div className="ah-set-inline" role="group" aria-label="免打扰时段">
          <input aria-label="免打扰开始" type="time" step={300} value={draft.quietStart} onChange={e => set({ quietStart: e.target.value })} />
          <span>到</span>
          <input aria-label="免打扰结束" type="time" step={300} value={draft.quietEnd} onChange={e => set({ quietEnd: e.target.value })} />
        </div>
      </Row>
      <Row label="日报时间" hint="每天此时间汇总前一天的情况。" htmlFor="ah-set-digest">
        <input id="ah-set-digest" type="time" step={300} value={draft.digestAt} onChange={e => set({ digestAt: e.target.value })} />
      </Row>
      <Row label="通知方式" htmlFor="ah-set-channel">
        <select id="ah-set-channel" value={draft.pushChannel} onChange={e => set({ pushChannel: e.target.value })}>
          {props.settings.pushChannelOptions.map(channel => (
            <option key={channel} value={channel}>{PUSH_CHANNEL_LABELS[channel] ?? channel}</option>
          ))}
        </select>
      </Row>
      <Row label="全队每天最多通知" hint="可填 0 到 10。紧急告警和日报不占名额。" htmlFor="ah-set-push-all">
        <div className="ah-set-inline">
          <input id="ah-set-push-all" type="number" min={0} max={10} value={draft.dailyPushCap} onChange={e => set({ dailyPushCap: e.target.value })} />
          <span>条</span>
        </div>
      </Row>
      <Row label="每位队友每天最多通知" hint="可填 0 到 3，不能超过全队上限。" htmlFor="ah-set-push-bot">
        <div className="ah-set-inline">
          <input id="ah-set-push-bot" type="number" min={0} max={3} value={draft.botDailyPushCap} onChange={e => set({ botDailyPushCap: e.target.value })} />
          <span>条</span>
        </div>
      </Row>
    </div>
  )
}

export function UsageSection(props: {
  draft: SettingsDraft
  set: SetDraft
  settings: SettingsView
  overview: OverviewView | null
  loadError?: string | null
  onRetry: () => void
}): ReactNode {
  const { draft, set } = props
  const models = modelSelectOptions(parseModel(draft.defaultModel), props.settings.modelOptions.filter(option => option.value !== null))
  return (
    <>
      <div className="ah-set-rows">
        <Row label="默认模型" hint="新建队友时默认使用，已有队友不受影响。" htmlFor="ah-set-model">
          <select id="ah-set-model" value={draft.defaultModel} onChange={e => set({ defaultModel: e.target.value })}>
            <option value="">跟随 DSH 默认</option>
            {/* 当前默认模型已不在宿主目录时补一项如实显示。 */}
            {models.map((option, i) => <option key={i} value={JSON.stringify(option.value) ?? ''}>{option.label}</option>)}
          </select>
          {props.loadError ? (
            <p className="ah-settings-error" role="alert">
              模型列表读取失败：{props.loadError}
              <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onRetry}>重试</button>
            </p>
          ) : null}
        </Row>
        <Row label="每位队友每天最多自己开工" hint={`可填 ${BOT_DAILY_TURN_MIN} 到 ${BOT_DAILY_TURN_MAX}。主人发消息不计入，试岗队友自动减半。`} htmlFor="ah-set-turns">
          <div className="ah-set-inline">
            <input id="ah-set-turns" type="number" min={BOT_DAILY_TURN_MIN} max={BOT_DAILY_TURN_MAX} value={draft.botDailyTurnBudget} onChange={e => set({ botDailyTurnBudget: e.target.value })} />
            <span>次</span>
          </div>
        </Row>
        <Row label="每位队友每天最多用" hint="用到上限后，当天不再自己开工，第二天重置。默认 250000。" htmlFor="ah-set-tokens">
          <div className="ah-set-inline">
            <input id="ah-set-tokens" className="ah-set-wide-number" type="number" min={BOT_DAILY_TOKEN_MIN} max={BOT_DAILY_TOKEN_MAX} step={BOT_DAILY_TOKEN_STEP} value={draft.botDailyTokenBudget} onChange={e => set({ botDailyTokenBudget: e.target.value })} />
            <span>token</span>
          </div>
        </Row>
      </div>
      <p className="ah-set-note">自主等级在每位队友的「详情」里单独设置。</p>
      {/* 用量明细很长，放在设置项下面，免得把真正要改的项挤到屏幕外。 */}
      <div className="ah-set-usage"><CostMeter costs={props.overview?.costs} /></div>
    </>
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
        <Row label="启用公共知识库" hint={<>关着：队友看不到知识库，也不会联网。<br />打开：全队能搜、能读，但只能看，权限不变。<br />访问方式还没定，先关着。</>} htmlFor="ah-set-kb-on">
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
  // 结果提示只停留几秒：「已暂停全队」一直挂着，会让人以为还在执行。
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
            <dd>{quotaMeaning(o.quota.light).label}，{o.quota.usedText}{o.quota.resetText ? `，${o.quota.resetText}` : ''}</dd>
          </div>
          <div className="ah-set-row"><dt>今天还能通知</dt><dd>{o.pushesLeftToday} 条</dd></div>
          <div className="ah-set-row"><dt>数据目录</dt><dd className="ah-set-path" title={props.rootDir}>{props.rootDir}</dd></div>
        </dl>
      ) : props.onRetry ? (
        // U11 #28：与待你处理、工作区同一套报错模板，就地给重试。
        <RetryBox message="读不出来。点重试。还不行，看看 DSH 是不是关了。" onRetry={props.onRetry} />
      ) : (
        <EmptyHint text="读不出来。看看 DSH 是不是关了。" />
      )}
      <h4 className="ah-set-subhead">全队操作</h4>
      <p className="ah-set-note">暂停后所有队友停止自主开工；恢复后继续。两项操作立即生效。</p>
      <div className="ah-settings-actions ah-set-actions">
        <button type="button" className="ah-btn ah-btn-danger" disabled={busy} onClick={() => setConfirming(true)}>暂停全队</button>
        <button type="button" className="ah-btn" disabled={busy} onClick={() => void lifecycle(props.onResumeAll, '恢复中', '已恢复。')}>恢复全队</button>
        {note ? <span className="ah-set-result" role="status">{note}</span> : null}
      </div>
      {confirming ? (
        <ConfirmDialog
          title="暂停全队"
          text="全体在岗与试岗队友将暂停自主开工。点击「恢复全队」即可恢复。"
          confirmText="暂停全队"
          busy={busy}
          error={null}
          onCancel={() => { if (!busy) setConfirming(false) }}
          onConfirm={() => void lifecycle(props.onPauseAll, '暂停中', '已暂停。')}
        />
      ) : null}
    </>
  )
}
