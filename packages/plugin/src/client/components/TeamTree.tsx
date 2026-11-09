/**
 * 左栏「队友」分组树（P37，接 P28 的 team-tree 纯逻辑）。
 *
 * 为什么要这层组件：队友一多，只按名单顺序平铺会看不出「谁在哪个项目里」；
 * 这里把每位队友当成母节点，把它是成员的项目缩进挂在下面，点项目直接去项目页。
 * 排序、分组、归档沉底都在 logic/team-tree.ts 里算好，组件不自己决定顺序。
 * 办公室入口仍由 BotList 的「团队全景」行承担，本组件只画队友分组。
 */
import type { ReactNode } from 'react'
import type { BotCard, ProjectViewRow } from '../../shared/views.js'
import { buildTeamTree, type TeamTreeBotInput, type TeamTreeProjectInput } from '../logic/team-tree.js'
import { Avatar, UnreadBadge } from './Ui.js'

export function TeamTree(props: {
  /** 已按搜索词过滤过的队友；空数组时由 BotList 显示空态。 */
  bots: readonly BotCard[]
  /** 项目视图还没加载时为 null：只画队友、不画项目行，不假装没有项目。 */
  projects: readonly ProjectViewRow[] | null
  /** 当前打开的队友（主页或线程）；团队全景与别的页面不传。 */
  selectedBotId: string | null
  onSelectBot: (botId: string) => void
  /** 点项目子行时打开项目页；不传则项目行只读展示。 */
  onOpenProject?: (projectId: string) => void
}): ReactNode {
  const byId = new Map(props.bots.map(bot => [bot.id, bot]))
  const tree = buildTeamTree({
    // 办公室入口不在本组件里（见文件头），这两个数字只是占位。
    office: { workingCount: 0, waitingCount: 0, blockedCount: 0 },
    bots: props.bots.map(toBotInput),
    projects: (props.projects ?? []).map(toProjectInput),
    active: props.selectedBotId === null ? null : { kind: 'bot', id: props.selectedBotId },
  })
  return (
    <div className="ah-team-tree">
      {tree.teammateGroup.bots.map(node => {
        const bot = byId.get(node.botId)
        return (
          <div key={node.botId} className="ah-tree-bot-group">
            <button
              type="button"
              aria-current={node.active ? 'true' : undefined}
              className={`ah-bot-row ah-tree-bot${node.active ? ' ah-selected' : ''}`}
              onClick={() => props.onSelectBot(node.botId)}
            >
              <Avatar color={node.color} initials={node.initials} />
              <span className="ah-bot-row-main">
                <span className="ah-bot-row-name">
                  {node.name}
                  {node.waitingOwner ? <span className="ah-tag ah-tag-wait">待确认</span> : null}
                  {node.lifecycle === 'retired' ? <span className="ah-tag">已退役</span> : null}
                </span>
                {/* 角色与活动句沿用原列表口径；团队树不复制这两段文案，查原卡片。 */}
                <span className="ah-bot-row-role">
                  {bot?.roleLabel ?? ''}
                  {bot?.activity === 'thinking' && !(bot.activityText ?? '').includes('正在处理') ? ' · 正在处理' : ''}
                </span>
                <span className="ah-bot-row-activity" title={bot?.activityText}>{bot?.activityText ?? ''}</span>
              </span>
              <UnreadBadge count={node.unread} />
            </button>
            {node.projects.length > 0 ? (
              <div className="ah-tree-projects">
                {node.projects.map(project => (
                  <button
                    key={project.projectId}
                    type="button"
                    className={`ah-tree-project${project.active ? ' ah-selected' : ''}`}
                    disabled={props.onOpenProject === undefined}
                    title={`${project.name}${project.openCount > 0 ? ` · ${project.openCount} 件待领` : ''}${project.doingCount > 0 ? ` · ${project.doingCount} 件在做` : ''}`}
                    onClick={() => props.onOpenProject?.(project.projectId)}
                  >
                    <span className="ah-tree-project-name">{project.name}</span>
                    <span className="ah-tree-project-counts">
                      {project.openCount > 0 ? <span>待领 {project.openCount}</span> : null}
                      {project.doingCount > 0 ? <span>在做 {project.doingCount}</span> : null}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** BotCard → 团队树输入；lastActiveAt 是 core 已给的字段，插件旧视图可能没有，按「无记录」处理。 */
function toBotInput(bot: BotCard): TeamTreeBotInput {
  return {
    id: bot.id,
    name: bot.name,
    color: bot.color,
    initials: bot.initials,
    lifecycle: bot.lifecycle,
    activity: bot.activity,
    unread: bot.unread,
    waitingOwner: bot.waitingOwner,
    lastActiveAt: bot.lastActiveAt ?? null,
  }
}

/**
 * 项目行 → 团队树输入。待领 = 待办 + 已驳回（还没开工的口径，与 P29 看板一致）；
 * 在做 = 进行中 + 受阻。成员用项目自己的名单，已归档项目由树逻辑沉底、不在这里展示。
 */
function toProjectInput(row: ProjectViewRow): TeamTreeProjectInput {
  return {
    id: row.project.id,
    name: row.project.name,
    status: row.project.status,
    memberBotIds: row.project.memberBotIds,
    openTaskCount: row.taskCounts.todo + row.taskCounts.rejected,
    doingTaskCount: row.taskCounts.doing + row.taskCounts.blocked,
  }
}
