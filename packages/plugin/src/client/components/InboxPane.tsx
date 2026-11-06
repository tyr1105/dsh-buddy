/**
 * 收件箱页（左栏底部入口）：所有要主人动手的事只有这一个入口。
 * 按 P0/P1/P2 分组；每项显示队友头像名字、标题、正文、剩余有效期；
 * 操作：提问选选项或填自由文本、审批批准/拒绝（可附一句话）、提议接受/拒绝、告警「知道了」。
 * 处理后从列表消失（服务端把 open 项作答），结果出现在对应线程里。
 */
import { useState, type ReactNode } from 'react'
import type { InboxItemView, InboxView } from '../../shared/views.js'
import { Avatar, EmptyHint, Skeleton } from './Ui.js'
import { InboxCard, type CardActions, type CardPayload } from './Cards.js'
import { groupInbox } from '../logic/feeds.js'
import { expiryMeaningOf } from '../logic/cards.js'

/** 把 InboxItemView 适配成 InboxCard 需要的卡片形状（复用同一张卡的交互）。 */
function itemToCard(item: InboxItemView): CardPayload {
  return {
    inboxId: item.id, approvalId: item.approvalId, type: item.type, status: 'open' as const,
    title: item.title, body: item.body,
    options: item.options, defaultOption: item.defaultOption, answer: null, expiresText: item.expiresText,
  }
}

export function InboxPane(props: {
  inbox: InboxView | null
  loading: boolean
  error: string | null
  onRetry: () => void
  actions: CardActions
  busyId: string | null
}): ReactNode {
  const [, force] = useState(0)
  if (props.error) {
    return <div className="ah-inbox"><div className="ah-retry" role="alert"><span>{props.error}</span><button type="button" className="ah-btn" onClick={props.onRetry}>重试</button></div></div>
  }
  if (!props.inbox) return <div className="ah-inbox">{props.loading ? <Skeleton rows={3} /> : <EmptyHint text="收件箱还没打开。队友需要你拍板的事会出现在这里。" />}</div>
  const groups = groupInbox(props.inbox.items)
  if (groups.length === 0) {
    return <div className="ah-inbox"><EmptyHint text="没有要你处理的事。队友们会在需要你拍板时出现在这里。" /></div>
  }
  return (
    <section className="ah-inbox" aria-label="收件箱" data-testid="ah-inbox">
      {groups.map(group => (
        <div key={group.priority} className={`ah-inbox-group ah-inbox-group-${group.priority.toLowerCase()}`}>
          <h3>{group.label}（{group.items.length}）</h3>
          {group.items.map(item => (
            <article key={item.id} className={`ah-inbox-row ah-inbox-${item.priority.toLowerCase()}`}>
              <header>
                {item.botName ? <Avatar color={item.botColor} initials={item.botName.slice(0, 1)} size={24} /> : null}
                <span className="ah-inbox-bot">{item.botName ?? '中心'}</span>
                {/* 有效期带含义（D07 第 18 条）：说过期会怎样，不只给时间点。 */}
                <span className="ah-inbox-time">{item.createdText}{expiryMeaningOf(itemToCard(item)) ? ` · ${expiryMeaningOf(itemToCard(item))}` : ''}</span>
              </header>
              <InboxCard card={itemToCard(item)} actions={{
                ...props.actions,
                // 本卡处理中禁用；处理完由 SSE 刷新把项移出列表。这里 force 触发本行重渲染。
                onPick: async (card, option, note) => { force(n => n + 1); return await props.actions.onPick(card, option, note) },
              }} busy={props.busyId === item.id} />
            </article>
          ))}
        </div>
      ))}
    </section>
  )
}
