/**
 * 队友主页：像聊天软件的三栏页面——左队友列表、中对话线程/收件箱/活动流/设置、右详情（可收起）。
 * 数据全部来自 HubStore（唯一仓库）；加载超过 300ms 显示骨架；宿主连不上整页提示；
 * 每个页面块外包 BlockBoundary（出错只显示「这块没显示出来，刷新试试」）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { HubStore } from '../hub-state.js'
import { useStore } from '../store.js'
import { TopBar } from '../components/TopBar.js'
import { BotList } from '../components/BotList.js'
import { ThreadPane, type ThreadHeaderInfo } from '../components/ThreadPane.js'
import { RightPanel } from '../components/RightPanel.js'
import { InboxPane } from '../components/InboxPane.js'
import { ActivityPane } from '../components/ActivityPane.js'
import { SettingsPane } from '../components/SettingsPane.js'
import { NewBotWizard } from '../components/NewBotWizard.js'
import { TeachDialog } from '../components/TeachDialog.js'
import { BlockBoundary } from '../components/ErrorBoundary.js'
import { Skeleton } from '../components/Ui.js'
import type { CardActions } from '../components/Cards.js'
import { cardSubmission } from '../logic/cards.js'
import { OPEN_SESSION_HINTS, openBotSessionWith } from '../logic/thread.js'
import { lifecycleAllTargets, pauseResumeAction } from '../logic/lifecycle.js'

/** 骨架判定：加载中的视图超过 300ms 才显示骨架（16.0.3 第 9 条）。 */
function useSlowLoading(loading: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) { setSlow(false); return }
    const timer = setTimeout(() => setSlow(true), 300)
    return () => clearTimeout(timer)
  }, [loading])
  return slow
}

export function HubPage(props: { hub: HubStore; clientCtx: unknown }): ReactNode {
  const hub = props.hub
  const state = useStore(hub)
  const [rightOpen, setRightOpen] = useState(true)
  const [busyInboxId, setBusyInboxId] = useState<string | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [teachOpen, setTeachOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** 试跑提示归属的机器人：它的线程里出现第一条回复后自动消失（D04 3c-3）。 */
  const [noticeAutoClearBot, setNoticeAutoClearBot] = useState<string | null>(null)

  const selectedThread = state.selectedThread
  const view = state.view

  // 首次挂载拉全部基础视图；此后由 SSE changed 事件驱动刷新。
  useEffect(() => {
    void hub.refreshAll()
    void hub.refreshSettings()
  }, [hub])
  useEffect(() => {
    if (state.connectionDown) return
    setThreadError(null)
    void hub.refreshThread(selectedThread).catch(() => setThreadError('线程加载失败（插件可能停用或在重载）'))
  }, [hub, selectedThread, state.connectionDown])

  // 选中机器人时拉它的详情；打开教学时拉最近会话。
  const overview = state.overview
  const selectedBot = overview?.bots.find(b => b.id === selectedThread) ?? null
  useEffect(() => {
    if (selectedBot && !state.bots[selectedBot.id]) void hub.refreshBot(selectedBot.id)
  }, [hub, selectedBot, state.bots])
  useEffect(() => {
    if (teachOpen) void hub.refreshRecentSessions()
  }, [hub, teachOpen])

  // 试跑提示只在试跑排队或进行中显示（D04 3c-3 / D07 第 19 条）：该机器人线程出现
  // 第一条回复，或试跑唤醒单已结束（无论有没有回复）就消失。
  useEffect(() => {
    if (noticeAutoClearBot === null || notice === null) return
    const thread = state.threads[noticeAutoClearBot]
    if (thread?.messages.some(m => m.kind === 'reply')) {
      setNotice(null)
      setNoticeAutoClearBot(null)
      return
    }
    const wakes = state.bots[noticeAutoClearBot]?.wakes
    if (wakes !== undefined) {
      const trial = wakes.find(w => w.variant === 'trial')
      // 详情里能看到试跑唤醒单、而它已不在队列/进行中：试跑结束，提示撤下。
      if (trial !== undefined && !['delivering', 'running'].includes(trial.status)) {
        setNotice(null)
        setNoticeAutoClearBot(null)
      }
    }
  }, [notice, noticeAutoClearBot, state.threads, state.bots])

  // 「中心正在启动」自动恢复（D07 第 12 条）：每 2 秒重拉一次全部视图，成功即停；
  // 引擎启动失败时显示失败原因（downMessage），不再停在「正在启动」。
  useEffect(() => {
    if (!state.connectionDown || state.downReason !== 'starting') return
    const timer = setInterval(() => {
      void hub.refreshAll().catch(() => undefined)
      void hub.refreshSettings().catch(() => undefined)
    }, 2_000)
    return () => clearInterval(timer)
  }, [hub, state.connectionDown, state.downReason])

  const overviewLoading = overview === null
  const showSkeleton = useSlowLoading(overviewLoading || (view === 'main' && state.threads[selectedThread] === undefined && !threadError))

  // 收件箱/线程卡片上的操作（D06 第 4 条）：按 cardSubmission 分流——审批卡用
  // approvalId 走 decideApproval（绝不把 inboxId 当 approvalId），其他卡走 answerInbox。
  // 卡片作答（D07 第 11 条）：失败要把原因返回给卡片显示（按钮恢复可点），不再只进 console。
  const cardActions: CardActions = {
    onPick: async (card, option, note) => {
      setBusyInboxId(card.inboxId)
      try {
        const submission = cardSubmission(card, option, note)
        if ('error' in submission) return submission.error
        const result = await hub.command(submission.name, submission.input)
        if (!result.ok) return result.error
        await Promise.all([hub.refreshInbox(), hub.refreshOverview()])
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      } finally { setBusyInboxId(null) }
    },
  }

  // 线程头部信息（团队线程没有）。
  const header: ThreadHeaderInfo | null = selectedThread === 'team' ? null : selectedBot ? {
    name: selectedBot.name,
    roleLabel: selectedBot.roleLabel,
    activityText: selectedBot.activityText,
    nextThinkText: selectedBot.nextThinkText,
    lifecycle: selectedBot.lifecycle,
    thinking: selectedBot.activity === 'thinking',
  } : { name: state.threads[selectedThread]?.title ?? '队友', roleLabel: null, activityText: null, nextThinkText: null, lifecycle: null, thinking: false }

  // 打断当前回合（D06 第 2 条）：interruptBot 经路由命令交给 core（取消、线程消息
  // 与感知恢复都由 core 完成），插件不再自己 cancel 或写系统消息。
  const interrupt = (): void => {
    if (!selectedBot) return
    void (async () => {
      const result = await hub.command('interruptBot', { botId: selectedBot.id })
      setNotice(result.ok ? '已打断；它会在下次醒来时接着处理。' : result.error)
      await Promise.all([hub.refreshThread(selectedBot.id), hub.refreshOverview()])
    })()
  }

  // 「打开工作会话」与暂停/恢复（线程头部；sessionId 在详情视图里）。
  const openSession = (): void => {
    const sessionId = selectedBot ? state.bots[selectedBot.id]?.profile.sessionId : null
    if (!sessionId) { setNotice('它还没有工作会话。'); return }
    const result = openBotSessionWith(props.clientCtx, sessionId)
    setNotice(OPEN_SESSION_HINTS[result])
  }
  const togglePause = (): void => {
    if (!selectedBot) return
    // D06 第 3 条 / D07 第 24 条：暂停/恢复走 lifecycleAction，动作由纯函数按状态选。
    const picked = pauseResumeAction(selectedBot.lifecycle)
    if (picked === null) return
    const action = picked
    void (async () => {
      const result = await hub.command('lifecycleAction', { botId: selectedBot.id, action })
      setNotice(result.ok ? (action === 'pause' ? '已暂停（期间的变化都存着）' : '已恢复') : result.error)
      await Promise.all([hub.refreshOverview(), hub.refreshBot(selectedBot.id)])
    })()
  }

  // 设置页保存与全体暂停/恢复。
  const saveSettings = async (patch: Record<string, unknown>): Promise<string | null> => {
    const result = await hub.command('updateSettings', patch)
    if (result.ok) await hub.refreshSettings()
    return result.ok ? null : result.error
  }
  const lifecycleAll = async (target: 'paused' | 'active'): Promise<string | null> => {
    if (!overview) return '总览还没加载出来，稍等再试'
    const action = target === 'paused' ? 'pause' : 'resume'
    // D07 第 24 条：目标选取也是纯函数（lifecycleAllTargets），与按钮表同一份规则。
    const targets = lifecycleAllTargets(overview.bots, target).map(id => overview.bots.find(b => b.id === id)!)
    let failed = 0
    for (const bot of targets) {
      // D06 第 3 条：全体暂停/恢复同样走 lifecycleAction（逐个执行，失败只计数）。
      const result = await hub.command('lifecycleAction', { botId: bot.id, action })
      if (!result.ok) failed += 1
    }
    await hub.refreshOverview()
    return failed === 0 ? null : `有 ${failed} 个队友操作没成功，再试一次或到它的详情里单独操作`
  }

  if (state.connectionDown) {
    // D05 第 13 条：停用与启动中给对应提示（含恢复办法），不要一律说「连不上」。
    const hint = state.downReason === 'disabled'
      ? '中心已停用：删除 ~/AgentHub/.hub/DISABLED 后重启 DSH 即可恢复。'
      : state.downReason === 'starting'
        ? '中心正在启动……稍等片刻会自动恢复。'
        : state.downReason === 'failed'
          ? `中心启动失败：${state.downMessage ?? '原因未知，看 DSH 日志'}。修复后重启 DSH 再试。`
          : '连不上 Agent 中心（插件可能停用或在重载）。'
    return (
      <div className="ah-page ah-page-down" data-plugin-page="agent-hub">
        <div className="ah-down">
          <p>{hint}</p>
          <button type="button" className="ah-btn" onClick={() => void hub.refreshAll()}>重试</button>
        </div>
      </div>
    )
  }

  return (
    <div className="ah-page" data-plugin-page="agent-hub">
      {overview ? (
        <BlockBoundary label="顶栏">
          <TopBar
            overview={overview}
            view={view}
            onOpenInbox={() => { hub.setView('inbox'); void hub.refreshInbox() }}
            onOpenActivity={() => { hub.setView('activity'); void hub.refreshActivity() }}
            onOpenSettings={() => { hub.setView('settings'); void hub.refreshSettings() }}
            onNewBot={() => setWizardOpen(true)}
            onBack={() => hub.setView('main')}
          />
        </BlockBoundary>
      ) : showSkeleton ? <header className="ah-topbar"><Skeleton rows={1} /></header> : null}

      {wizardOpen && overview ? (
        <BlockBoundary label="新建队友">
          <NewBotWizard
            existingBots={overview.bots}
            modelOptions={state.settings?.modelOptions ?? []}
            modelOptionsError={state.settings ? null : state.settingsError}
            onCreate={async (input, color) => {
              const created = await hub.command('createBot', input)
              if (!created.ok) return { error: created.error }
              const botId = (created.data as { id?: string } | undefined)?.id
              if (botId === undefined) return { error: '创建成功但没有返回机器人 id' }
              // createBot 不收颜色（core 按角色配色）；选中的色板随后用 updateBot 存。
              const colored = await hub.command('updateBot', { botId, patch: { color } })
              if (!colored.ok) console.error('[agent-hub] 保存头像颜色失败:', colored.error)
              return { botId }
            }}
            onOpenThread={botId => {
              setWizardOpen(false)
              hub.selectThread(botId)
              // 提示条改放线程顶部（D04 3c-3），该机器人第一次交账（线程出现 reply）后自动消失。
              setNotice('正在试跑：它会先做自我介绍，稍等片刻。')
              setNoticeAutoClearBot(botId)
              void hub.refreshOverview()
            }}
            onClose={() => setWizardOpen(false)}
          />
        </BlockBoundary>
      ) : null}

      {teachOpen && selectedBot ? (
        <BlockBoundary label="教它一招">
          <TeachDialog
            botName={selectedBot.name}
            sessions={state.recentSessions}
            onTeach={async (sessionId, note) => {
              const result = await hub.command('teach', { botId: selectedBot.id, sessionId, note })
              if (!result.ok) return result.error
              setTeachOpen(false)
              await Promise.all([hub.refreshThread(selectedBot.id), hub.refreshBot(selectedBot.id)])
              return null
            }}
            onClose={() => setTeachOpen(false)}
          />
        </BlockBoundary>
      ) : null}

      <div className={`ah-body${rightOpen && selectedBot && view === 'main' ? ' ah-body-right' : ''}`}>
        {overview ? (
          <BlockBoundary label="队友列表">
            <BotList
              overview={overview}
              selected={view === 'main' ? selectedThread : ''}
              onSelect={(threadId) => hub.selectThread(threadId)}
              onOpenInbox={() => { hub.setView('inbox'); void hub.refreshInbox() }}
            />
          </BlockBoundary>
        ) : showSkeleton ? <Skeleton rows={6} /> : null}

        {view === 'inbox' ? (
          <BlockBoundary label="收件箱">
            <InboxPane
              inbox={state.inbox}
              loading={state.inbox === null}
              error={null}
              onRetry={() => void hub.refreshInbox()}
              actions={cardActions}
              busyId={busyInboxId}
            />
          </BlockBoundary>
        ) : view === 'activity' ? (
          <BlockBoundary label="活动流">
            <ActivityPane
              activity={state.activity}
              bots={overview?.bots ?? []}
              loading={state.activity === null}
              onRetry={() => void hub.refreshActivity()}
              onLoadMore={() => {
                const last = state.activity?.rows.at(-1)?.id
                if (last) void hub.refreshActivity(last)
              }}
            />
          </BlockBoundary>
        ) : view === 'settings' ? (
          <BlockBoundary label="设置">
            <SettingsPane
              settings={state.settings}
              loadError={state.settingsError}
              overview={overview}
              loading={state.settings === null}
              onRetry={() => void hub.refreshSettings()}
              onSave={saveSettings}
              onPauseAll={() => lifecycleAll('paused')}
              onResumeAll={() => lifecycleAll('active')}
            />
          </BlockBoundary>
        ) : (
          <BlockBoundary label="对话线程">
            <ThreadPane
              key={selectedThread}
              thread={state.threads[selectedThread] ?? null}
              loading={state.threads[selectedThread] === undefined}
              header={header}
              inputPlaceholderName={state.threads[selectedThread]?.title ?? '队友'}
              banner={notice}
              onBannerDismiss={() => { setNotice(null); setNoticeAutoClearBot(null) }}
              onLoadEarlier={() => {
                const t = state.threads[selectedThread]
                if (t?.hasMore && t.oldestId) void hub.refreshThread(selectedThread, t.oldestId)
              }}
              onSend={(text) => hub.send(selectedThread, text)}
              actions={cardActions}
              busyInboxId={busyInboxId}
              onRetry={() => void hub.refreshThread(selectedThread)}
              error={threadError}
              onTeach={() => setTeachOpen(true)}
              onOpenSession={openSession}
              onTogglePause={togglePause}
              onInterrupt={interrupt}
              rightCollapsed={view === 'main' && !rightOpen && selectedBot !== null}
              onExpandRight={() => setRightOpen(true)}
            />
          </BlockBoundary>
        )}
        {view === 'main' && rightOpen ? (
          <BlockBoundary label="详情">
            <RightPanel
              key={selectedBot?.id ?? 'none'}
              bot={selectedBot ? state.bots[selectedBot.id] ?? null : null}
              modelOptions={state.settings?.modelOptions ?? []}
              modelOptionsError={state.settings ? null : state.settingsError}
              onRetrySettings={() => void hub.refreshSettings()}
              clientCtx={props.clientCtx}
              run={(name, input) => hub.command(name, input)}
              onRefresh={() => { if (selectedBot) void hub.refreshBot(selectedBot.id); void hub.refreshOverview() }}
              onTeach={() => setTeachOpen(true)}
              onCollapse={() => setRightOpen(false)}
            />
          </BlockBoundary>
        ) : null}
      </div>
    </div>
  )
}
