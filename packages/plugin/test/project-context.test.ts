/**
 * 项目共享上下文（P39）插件侧测试：表单换算、校验与入参拼装、空态口径、决策作者人话，
 * 以及样例门面 FixtureHub 对三条上下文命令的真实改动（编辑留痕、采纳/驳回、归档拒绝）。
 * 浏览器走查依赖这些行为在样例模式下真的发生，而不是一律返回成功。
 */
import { describe, expect, it } from 'vitest'
import { FixtureHub } from '../src/host/hub-facade.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import {
  CONTEXT_BACKGROUND_MAX, CONTEXT_DECISION_TEXT_MAX, CONTEXT_TERM_MAX,
  buildSaveProjectContextInput, contextBrief, contextDraftFrom, conventionPoints, decisionAuthor,
  isContextEmpty, validateContextDraft,
} from '../src/client/logic/project-context.js'

const rowWeekly = fixtureProject.projects[0]!
const rowEmpty = fixtureProject.projects[1]!

describe('上下文纯逻辑', () => {
  it('样例富项目带非空上下文、两条留痕与一条待审建议；空项目保持空态', () => {
    expect(rowWeekly.contextEmpty).toBe(false)
    expect(rowWeekly.context.background).not.toBe('')
    expect(rowWeekly.contextRevisions).toHaveLength(2)
    expect(rowWeekly.contextProposals).toHaveLength(1)
    expect(rowWeekly.contextFilePath).toBe('/Users/demo/AgentHub/projects/prj_weekly/context.md')
    expect(rowEmpty.contextEmpty).toBe(true)
    expect(rowEmpty.contextRevisions).toHaveLength(0)
    expect(rowEmpty.contextProposals).toHaveLength(0)
  })

  it('表单换算保留决策 id，保存入参不强塞多余字段', () => {
    const draft = contextDraftFrom(rowWeekly.context)
    expect(draft.decisions.every(item => item.id !== null)).toBe(true)
    const input = buildSaveProjectContextInput('prj_weekly', {
      ...draft,
      background: '  新背景  ',
      decisions: [...draft.decisions, { id: null, text: ' 新决策 ' }],
      glossary: [{ term: ' 新词 ', meaning: ' 新释义 ' }],
    })
    expect(input.projectId).toBe('prj_weekly')
    expect(input.background).toBe('新背景')
    const decisions = input.decisions as Array<Record<string, unknown>>
    expect(decisions[0]).toEqual({ id: rowWeekly.context.decisions[0]!.id, text: rowWeekly.context.decisions[0]!.text })
    expect(decisions.at(-1)).toEqual({ text: '新决策' })
    expect(input.glossary).toEqual([{ term: '新词', meaning: '新释义' }])
  })

  it('校验一次只报第一处：背景超长、决策空、术语空各有中文提示', () => {
    const base = contextDraftFrom(rowWeekly.context)
    expect(validateContextDraft({ ...base, background: 'x'.repeat(CONTEXT_BACKGROUND_MAX + 1) }))
      .toContain('背景：不能超过')
    expect(validateContextDraft({ ...base, decisions: [...base.decisions, { id: null, text: '   ' }] }))
      .toContain('已定决策第 3 条')
    expect(validateContextDraft({ ...base, glossary: [...base.glossary, { term: 'x'.repeat(CONTEXT_TERM_MAX + 1), meaning: '释义' }] }))
      .toContain('术语第 3 条')
    expect(validateContextDraft({ ...base, decisions: [{ id: null, text: 'x'.repeat(CONTEXT_DECISION_TEXT_MAX + 1) }] }))
      .toContain('不能超过')
    expect(validateContextDraft(base)).toBeNull()
  })

  it('空态、概况、约定拆行与决策作者人话', () => {
    expect(isContextEmpty({ background: '', conventions: '', decisions: [], glossary: [] })).toBe(true)
    expect(isContextEmpty({ background: ' ', conventions: '\n', decisions: [], glossary: [] })).toBe(true)
    expect(contextBrief(rowWeekly.context)).toContain('约定 3 条')
    expect(contextBrief(rowWeekly.context)).toContain('决策 2 条')
    expect(conventionPoints('一\n\n 二 \n')).toEqual(['一', '二'])
    expect(decisionAuthor('owner', rowWeekly)).toBe('主人')
    expect(decisionAuthor('bot-xunjian', rowWeekly)).toBe('巡检员')
    expect(decisionAuthor('bot-missing', rowWeekly)).toBe('已删除的队友')
  })
})

describe('样例门面的上下文命令', () => {
  it('主人编辑真的改视图并追加留痕；同内容再保存不留痕', async () => {
    const hub = new FixtureHub()
    const before = await hub.project()
    const row = before.projects[0]!
    const revisions = row.contextRevisions.length
    const result = await hub.command('saveProjectContext', {
      projectId: row.project.id,
      background: `${row.context.background}（补充一句）`,
      conventions: row.context.conventions,
      decisions: row.context.decisions.map(item => ({ id: item.id, text: item.text })),
      glossary: row.context.glossary.map(item => ({ term: item.term, meaning: item.meaning })),
    })
    expect(result.ok).toBe(true)
    const after = await hub.project()
    expect(after.projects[0]!.context.background).toContain('（补充一句）')
    expect(after.projects[0]!.contextRevisions).toHaveLength(revisions + 1)
    expect(after.projects[0]!.contextRevisions[0]!.sourceLabel).toBe('主人编辑')

    // 同样的内容再保存一次：core 口径是不留痕。
    const same = await hub.command('saveProjectContext', {
      projectId: row.project.id,
      background: after.projects[0]!.context.background,
      conventions: after.projects[0]!.context.conventions,
      decisions: after.projects[0]!.context.decisions.map(item => ({ id: item.id, text: item.text })),
      glossary: after.projects[0]!.context.glossary.map(item => ({ term: item.term, meaning: item.meaning })),
    })
    expect(same.ok).toBe(true)
    const third = await hub.project()
    expect(third.projects[0]!.contextRevisions).toHaveLength(revisions + 1)
  })

  it('采纳队友建议：写入建议内容、留痕记队友、建议从待审列表消失', async () => {
    const hub = new FixtureHub()
    const before = await hub.project()
    const proposal = before.projects[0]!.contextProposals[0]!
    const result = await hub.command('approveProjectContextProposal', { id: proposal.proposal.id })
    expect(result.ok).toBe(true)
    const after = await hub.project()
    expect(after.projects[0]!.context.conventions).toBe(proposal.proposal.context.conventions)
    expect(after.projects[0]!.contextProposals).toHaveLength(0)
    expect(after.projects[0]!.contextRevisions[0]!.editorName).toBe('巡检员')
    expect(after.projects[0]!.contextRevisions[0]!.sourceLabel).toBe('采纳队友建议')
  })

  it('驳回队友建议：上下文不变，建议消失', async () => {
    const hub = new FixtureHub()
    const before = await hub.project()
    const proposal = before.projects[0]!.contextProposals[0]!
    const result = await hub.command('rejectProjectContextProposal', { id: proposal.proposal.id })
    expect(result.ok).toBe(true)
    const after = await hub.project()
    expect(after.projects[0]!.context.conventions).toBe(before.projects[0]!.context.conventions)
    expect(after.projects[0]!.contextProposals).toHaveLength(0)
  })

  it('归档项目拒绝编辑；不存在的项目与建议给中文错误', async () => {
    const hub = new FixtureHub()
    const archived = (await hub.project()).projects.find(row => row.project.status === 'archived')!
    const denied = await hub.command('saveProjectContext', { projectId: archived.project.id, background: 'x' })
    expect(denied.ok).toBe(false)
    expect(denied.ok ? '' : denied.error).toContain('已归档')
    expect((await hub.command('saveProjectContext', { projectId: 'prj_missing' })).ok).toBe(false)
    const missing = await hub.command('approveProjectContextProposal', { id: 'pcp_missing' })
    expect(missing.ok).toBe(false)
    expect(missing.ok ? '' : missing.error).toContain('建议不存在')
  })
})
