/**
 * 左栏第二组「队友」（P44，U01 第 45 轮从主组件拆出）。
 *
 * 组头右侧常驻新建加号，搜索框只过滤这一组；P71 起组里不再有「团队全景」行，第一行就是队友。
 * 行内加号在触发行下方
 * 就地展开新建会话表单（P2-N2），表单节点由父层统一构造后传入，
 * 本组件只决定它贴在哪一行，不持有表单状态。
 */
import type { ReactNode } from 'react'
import type { BotCard } from '../../shared/views.js'
import type { PageView } from '../hub-state.js'
import { AGR_TEXT, displayRoleLabel, isChiefEntry, roleLineOf } from '../logic/agreement.js'
import { isArchivedBot } from '../logic/lifecycle.js'
import { SIDEBAR_GROUP_TITLES } from '../logic/sidebar-groups.js'
import { Avatar, UnreadBadge } from './Ui.js'
import { Chevron, isBotActive } from './sidebar-nav-parts.js'
import type { SidebarFormState } from './sidebar-session-form.js'

/**
 * 队友行第三行活动句（U01 第 46 轮）：归档时 core 会把活动句改写成「已归档」，
 * 与第二行的状态文字完全重复——状态已回答「它现在什么状态」，第三行就
 * 换成「最后活动：…」回答「多久前停的」；没有时间记录时返回空串，调用方整行不渲染，
 * 不用一句空话占位。（P73f：旧的「已退役」统一为「已归档」。）
 */
export function rowActivityText(bot: BotCard): string {
  if (isArchivedBot(bot) && bot.activityText === '已归档') {
    return bot.lastActiveText ? `最后活动：${bot.lastActiveText}` : ''
  }
  return bot.activityText
}

/** 默认在册上限（与 core 的默认值、模板库的 MAX_TEAM_SIZE 一致）。 */
const DEFAULT_MAX_BOTS = 6

/** 分组标题：「员工 3 / 6」。写成函数，组件和测试读同一处。 */
export function teammatesTitle(totalBots: number, maxBots?: number): string {
  return `${SIDEBAR_GROUP_TITLES.teammates} ${totalBots} / ${maxBots ?? DEFAULT_MAX_BOTS}`
}

export interface TeammatesGroupProps {
  expanded: boolean
  onToggle: () => void
  totalBots: number
  query: string
  onQueryChange: (value: string) => void
  view: PageView
  selectedThread: string
  /** 已按搜索词过滤后的在名单队友（不含归档）；过滤规则在父层，组件只渲染。 */
  bots: BotCard[]
  /** 已按搜索词过滤后的归档队友：收进组内折叠区，不新造第二套列表。 */
  archivedBots: BotCard[]
  archivedOpen: boolean
  onToggleArchived: () => void
  /** 删除已归档员工时命令报错的中文提示。 */
  notice: string | null
  /**
   * 打开「删除」确认弹窗；真正的命令由父层发。
   * P73f：归档只在编辑员工弹窗里做（有二次确认），已归档区不再有「恢复」，只保留「删除」。
   */
  onBeginDelete: (bot: BotCard) => void
  onSelectBot: (botId: string) => void
  onNewBot: () => void
  /** P73e：在册上限，用于标题「员工 N / 6」；不传按默认的 6 位。 */
  maxBots?: number
  /** 行内加号：打开该队友的新建会话表单。 */
  onOpenBotForm: (botId: string) => void
  /** 队友参与多个可加活项目时，切换表单里的目标项目。 */
  onBotFormProjectChange: (projectId: string) => void
  form: SidebarFormState | null
  /** 当前表单可选的项目（队友参与且可加活），多于 1 个才出下拉。 */
  botFormProjects: { id: string; name: string }[]
  /** 当前表单对应的队友卡片，用于显示表单标题。 */
  formBot: BotCard | null
  /** 父层构造好的内联表单节点，贴在触发行下方；无表单时为 null。 */
  formNode: ReactNode
}

export function TeammatesGroup(props: TeammatesGroupProps): ReactNode {
  const q = props.query.trim().toLowerCase()
  return (
    <section className="ah-nav-group">
      <div className="ah-nav-group-head">
        <button
          type="button"
          className="ah-nav-group-toggle"
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          <Chevron open={props.expanded} />
          {/* P73e：标题写在册人数和上限：「员工 3 / 6」，上限一开始就可见。 */}
          <span className="ah-nav-group-title">{teammatesTitle(props.totalBots, props.maxBots)}</span>
        </button>
        <button type="button" className="ah-botlist-add" aria-label="新建员工" title="新建员工" onClick={props.onNewBot}>＋</button>
      </div>
      {props.expanded ? (
        <>
          <input
            className="ah-bot-search"
            aria-label="搜索员工"
            placeholder="搜索名字或角色"
            value={props.query}
            onChange={event => props.onQueryChange(event.target.value)}
          />
          <div className="ah-nav-rows">
            {props.bots.map((bot: BotCard) => {
              const activity = rowActivityText(bot)
              return (
              <div key={bot.id} className="ah-nav-bot-group">
                <div className="ah-nav-bot">
                  <button
                    type="button"
                    className={`ah-bot-row ah-tree-bot${isBotActive(props.view, props.selectedThread, bot.id) ? ' ah-selected' : ''}`}
                    data-bot-row={bot.id}
                    aria-current={isBotActive(props.view, props.selectedThread, bot.id) ? 'true' : undefined}
                    onClick={() => props.onSelectBot(bot.id)}
                  >
                    <Avatar color={bot.color} initials={bot.initials} />
                    <span className="ah-bot-row-main">
                      <span className="ah-bot-row-name">
                        {/* 名字单独包一层：CJK 裸文本在 flex 里会被压到逐字断行（r46），
                            name-text 用 nowrap+省略号兜底，空间不够时省略也不竖排。 */}
                        <span className="ah-bot-row-name-text">{bot.name}</span>
                        {bot.waitingOwner ? <span className="ah-tag ah-tag-wait">待确认</span> : null}
                        {/* P72：总管是全队入口，名字旁加标签；角色行写「有事先找我」。 */}
                        {isChiefEntry(bot) ? <span className="ah-tag ah-tag-entry">{AGR_TEXT.chiefTag}</span> : null}
                      </span>
                      <span className="ah-bot-row-role">
                        {roleLineOf(bot)}
                        {bot.activity === 'thinking' && !(bot.activityText ?? '').includes('正在处理') ? ' · 正在处理' : ''}
                      </span>
                      {activity ? (
                        <span className="ah-bot-row-activity" title={activity}>{activity}</span>
                      ) : null}
                    </span>
                    <UnreadBadge count={bot.unread} />
                  </button>
                  {/* P73f：已归档的员工不在这里（见下面的已归档区），名单里的员工行尾一律是「新建会话」。 */}
                  <button
                    type="button"
                    className="ah-nav-row-add"
                    aria-label={`给${bot.name}新建会话`}
                    title={`给${bot.name}新建会话`}
                    aria-expanded={props.form !== null && props.form.fromBotId === bot.id}
                    onClick={() => props.onOpenBotForm(bot.id)}
                  >＋</button>
                </div>
                {/* P2-N2：表单贴着触发行就地展开，不再落到工作区组末尾隔着几个项目行。 */}
                {props.form !== null && props.form.fromBotId === bot.id ? (
                  <div className="ah-nav-bot-form">
                    <p className="ah-nav-form-title">给「{props.formBot?.name ?? '员工'}」新建会话</p>
                    {props.botFormProjects.length > 1 ? (
                      <select
                        className="ah-nav-form-select"
                        aria-label="选择项目"
                        value={props.form.projectId}
                        onChange={event => props.onBotFormProjectChange(event.target.value)}
                      >
                        {props.botFormProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                      </select>
                    ) : null}
                    {props.formNode}
                  </div>
                ) : null}
              </div>
              )
            })}
            {/* P73e：员工列表底部入口，打开模板库；原来的「＋」仍在标题右侧。 */}
            <button type="button" className="ah-nav-library-entry" onClick={props.onNewBot}>从模板库添加</button>
            {props.bots.length === 0 ? (
              <p className="ah-empty">{q ? '没找到。换个词，或者把搜索清掉。'
                : props.archivedBots.length > 0 ? '暂无在册员工。已归档员工见下方。'
                  : '这儿还没人。点上面的 +，给第一位起个名字，选个角色。'}</p>
            ) : null}
            {/* P48：归档区是「队友」组内的折叠段，沿用同一套行样式；只在有归档时出现。 */}
            {props.archivedBots.length > 0 ? (
              <div className="ah-nav-archived">
                <button
                  type="button"
                  className="ah-nav-archived-toggle"
                  aria-expanded={props.archivedOpen}
                  onClick={props.onToggleArchived}
                >
                  <Chevron open={props.archivedOpen} />
                  <span>已归档（{props.archivedBots.length}）</span>
                </button>
                {props.archivedOpen ? props.archivedBots.map(bot => (
                  <div key={bot.id} className="ah-nav-bot ah-nav-bot-archived">
                    <button
                      type="button"
                      className="ah-bot-row ah-tree-bot"
                      onClick={() => props.onSelectBot(bot.id)}
                    >
                      <Avatar color={bot.color} initials={bot.initials} />
                      <span className="ah-bot-row-main">
                        <span className="ah-bot-row-name"><span className="ah-bot-row-name-text">{bot.name}</span><span className="ah-tag">已归档</span></span>
                        <span className="ah-bot-row-role">{displayRoleLabel(bot)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ah-nav-row-text ah-nav-row-danger"
                      aria-label={`删除${bot.name}`}
                      title={`删除${bot.name}`}
                      onClick={() => props.onBeginDelete(bot)}
                    >删除</button>
                  </div>
                )) : null}
              </div>
            ) : null}
            {props.notice ? <p className="ah-empty" role="alert">{props.notice}</p> : null}
          </div>
        </>
      ) : null}
    </section>
  )
}
