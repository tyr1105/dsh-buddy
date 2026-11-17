/**
 * P74j 的测试：假模型的「执行者」「评审员」「发布这一步」剧本（scripts/dev/fake-job-plan.mjs）。
 *
 * 测什么：
 *   剧本是纯函数 jobAction({ messages, tools, plan, memory })：读这一回合的唤醒包文字和已调用过的工具，
 *   算出下一步（调用哪个工具、填什么参数，或交账）。这里用一个小驱动模拟「模型每次请求 -> 剧本回一步 ->
 *   工具返回结果 -> 再请求」，走完一个回合，断言每一步。
 *
 * 样例来源：
 *   下面九段「你手上的事」原文，取自 core 的真实输出：packages/core/test/p74j-packet-samples.test.ts
 *   （用真实的中心生成，2026-11-13 运行得到）。粘贴时只保留原文，不改任何句子；为了不重复粘贴同样的几行，
 *   把几个样例共用的行单独写成常量再拼起来，拼出来的文字与原文逐字相同。
 *   core 改了这些句子，那个测试会先失败，到时同步更新这里的样例和剧本。
 *   另有三处「变体」没有现成的样例（写明不再做的新版约定、没有交回、在等批准、相对路径的发布准备），
 *   它们的句子取自 core 渲染函数的源码，每处在用到的地方写明出处。
 *
 * 用例编号 J1 至 J14 对应任务卡 docs/tasks/P74j-supplement.md 第 7 节的表格。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CommitInputSchema, OutboxInputSchema, buildTools, testing } from '@agent-hub/core'

// ---------------------------------------------------------------------------
// 引入剧本（包外的 .mjs，没有类型声明，照 fake-model-script.test.ts 的写法）
// ---------------------------------------------------------------------------

interface Action { kind: string; name?: string; args?: Record<string, unknown> }
interface Step { action: Action; role: string; step: string; jobId: string; commit: { outcome: string; summary: string; reply: string | null } | null; error: string | null }
interface Memory { waits: Map<string, number>; asked: Set<string>; reviews: Map<string, number>; submitted: Set<string> }
interface PlanModule {
  jobAction(input: { messages: unknown[]; tools: unknown[]; plan: Set<string>; memory: Memory }): Step | null
  identifyJob(packet: string): { role: string; phase: string; jobId: string } | null
  parsePlan(value: string | undefined): Set<string>
  createJobMemory(): Memory
  pageHtml(prompt: string): string
  htmlCommand(jobId: string, prompt: string): string
  pngCommand(jobId: string): string
  decodeOctalEscapes(command: string): number[]
  launchCwdOf(section: string): string
  PNG_BYTES: readonly number[]
  GOOD_PROMPT: string
  WRONG_PROMPT: string
}
// @ts-expect-error 故意引用包外的 .mjs
const P = await import('../../scripts/dev/fake-job-plan.mjs') as PlanModule

// ---------------------------------------------------------------------------
// 样例：「你手上的事」段原文（取自 packages/core/test/p74j-packet-samples.test.ts 的真实输出）
// ---------------------------------------------------------------------------

const JOB = 'job_wq3ba6j12b'
const PRJ = 'prj_mj15m85nm0'
const DIR = `/hub/projects/${PRJ}/jobs/${JOB}`

/** 执行者段共用的行（样例 1 至 4 相同）。 */
const EXEC_ID = `你是「会员定价页」的执行者（jobId 为 ${JOB}）。评审甲在交付前对照约定逐条核对，核对通过后由中心交给主人验收。`
const EXEC_MATERIAL = `材料（只读）：约定 ${DIR}/约定.md；主人原话 ${DIR}/原话.md；草图 ${DIR}/草图.md。`
const EXEC_PUT = `产出物先在自己的家目录里做好，再用 hub_project_put 放进项目文件夹（参数 project 填 ${PRJ}，to 写 jobs/${JOB}/交付/文件名）；截图和测试日志放进 jobs/${JOB}/证据/。`
const EXEC_ITEMS = [
  '怎样算做完（交回时逐条对应，no 写序号）：',
  '1. 打开页面能看到今天的报价（交付时核对：selfCheck 写 at_delivery，不附证据）',
  '2. 点刷新后数据更新',
  '3. 接口失败时有提示',
]
const EXEC_SUBMIT = `交回：调用 hub_job_work，mode 写 submit，jobId 写 ${JOB}，changeNote 写这一轮怎么做的、改了什么；items 逐条写 no、selfCheck（met 符合、not_met 不符、at_delivery 交付时核对）和 evidence；selfCheck 写 met 的条目至少附 1 项、至多附 4 项 evidence，not_met 的条目要另写 note 说明哪里没做到，at_delivery 的条目不附 evidence。evidence 的每一项都要写 kind 和 summary：summary 是一句话说明这项证据证明了什么，不超过 120 字；kind 写 file（文件）、image（截图）、test（测试结果）或 link（链接）；file 和 image 另写 path（主题文件夹里的相对路径，例如 证据/手机.png）；link 另写 url（http:// 或 https:// 开头）；test 的 summary 写测试做了什么、结果如何，可以另加 command（核对人复跑用的命令）；deliverables 写 交付/ 下的文件；能打开预览的写 preview（交付/ 下的 html，或本机地址，http 或 https，主机只能是 localhost、127.0.0.1、[::1]）。`
const EXEC_ASK = '有问题问总管：mode 写 ask，text 写问题。做不下去：mode 写 block，stuckAt 写卡在哪，tried 写试过什么。'
const EXEC_NO_OWNER = '不要直接找主人，不要用 hub_send。交账的 reply 只写一句这一回合做了什么。'

/** 样例 1：执行者第一轮（取自 p74j-packet-samples.test.ts「1 执行者第一轮」）。 */
const S1_EXECUTOR_FIRST = [
  EXEC_ID, '现在：执行中。交付时间：11月17日 18:00 前。', EXEC_MATERIAL, EXEC_PUT, ...EXEC_ITEMS, EXEC_SUBMIT, EXEC_ASK, EXEC_NO_OWNER,
].join('\n')

/** 样例 2：执行者返工，第 2、3 条要改（取自「2 执行者返工 与 6 核对人第二轮」的第一段输出）。 */
const S2_EXECUTOR_REWORK = [
  EXEC_ID, '现在：返工中，本阶段第 1 轮，共 3 轮。交付时间：11月17日 18:00 前。', EXEC_MATERIAL, EXEC_PUT, ...EXEC_ITEMS,
  '这一轮要改的条目：第 2 条：问题：手机号提示文字与约定不一致；改到什么程度算过：输入 10 位手机号时，提示文字与约定逐字一致，附一张截图。第 3 条：问题：没有看到名额已满的提示；改到什么程度算过：提交满 80 人后页面显示名额已满，附一张截图。其余条目不用再交，沿用上一轮结论。',
  EXEC_SUBMIT, EXEC_ASK, EXEC_NO_OWNER,
].join('\n')

/** 样例 3：约定新版本在等确认（取自「3 执行者在约定新版本等确认期间」）。 */
const S3_EXECUTOR_PAUSED = [
  EXEC_ID, '现在：执行中。交付时间：11月17日 18:00 前。', EXEC_MATERIAL, EXEC_PUT, ...EXEC_ITEMS,
  '约定第 2 版在等主人确认：暂停名额计数、名额已满；照常在做页面骨架。暂停的部分在主人确认前不要交回。照常在做的部分做完之后，交账的结果写 no_change，说明在等约定确认；主人确认后中心会叫你。',
  EXEC_SUBMIT, EXEC_ASK, EXEC_NO_OWNER,
].join('\n')

/** 样例 4：总管回答之后（取自「4 执行者收到总管回答之后」）。 */
const S4_EXECUTOR_ANSWERED = [
  EXEC_ID, '现在：执行中。交付时间：11月17日 18:00 前。', EXEC_MATERIAL, EXEC_PUT, ...EXEC_ITEMS,
  '总管刚回答你：同一手机号第二次提交时，提示这个手机号已经报过名（依据：doneWhen 2）',
  EXEC_SUBMIT, EXEC_ASK, EXEC_NO_OWNER,
].join('\n')

/** 核对人段共用的行（样例 5 至 7 相同）。 */
const REVIEW_RULES = '核对规则：只核对是否符合约定、是否正确；配色、字体、文案语气不在核对范围。能复查的自己复查一次（打开页面、复跑命令），在 note 里写明。不符的条目必须写 note（问题是什么）和 fixTo（改到什么程度算过，写成一句可以验证的话）。沿用上一轮结论的条目可以不写结论；抽查了哪几条写进 spotChecked，沿用的理由写进 carriedNote。'
const REVIEW_NO_OWNER = '不要直接找主人，不要用 hub_send。交账的 reply 只写一句。'
const reviewSubmit = (jobId: string): string => `提交结论：调用 hub_job_work，mode 写 review，jobId 写 ${jobId}，items 逐条写 no、verdict（met、unmet 或 at_delivery）、note、fixTo。`

/** 样例 5：核对人第一轮（取自「5 核对人第一轮」）。 */
const S5_REVIEWER_FIRST = [
  `你是「会员定价页」的核对人（jobId 为 ${JOB}）。只看约定和下面的证据，不看执行过程。`,
  `约定全文：${DIR}/约定.md。这是第 1 阶段第 1 轮核对，本阶段最多 3 轮。`,
  '林舟的交回（搭好了价格页，三档价格和刷新按钮都有）：',
  '1. 打开页面能看到今天的报价', '自查：交付时核对',
  '2. 点刷新后数据更新', '自查：自查符合',
  `证据 ev1：图片 ${DIR}/证据/手机.png 手机　390 宽；中心检查：图片，0.1 KB`,
  '3. 接口失败时有提示', '自查：自查符合',
  `证据 ev2：文件 ${DIR}/交付/报价页.html 页面文件；中心检查：文件存在，0.0 KB`,
  '证据 ev3：测试 依次提交 81 条，第 81 条显示名额已满；复跑命令：pnpm test signup；中心检查：中心不执行命令，由核对人复跑',
  `产出物：${DIR}/交付/报价页.html；预览：http://localhost:5173/`,
  REVIEW_RULES, reviewSubmit(JOB), REVIEW_NO_OWNER,
].join('\n')

/** 样例 6：核对人第二轮，第 1 条沿用（取自「6 核对人第二轮（有沿用的条目）」）。 */
const S6_REVIEWER_SECOND = [
  `你是「会员定价页」的核对人（jobId 为 ${JOB}）。只看约定和下面的证据，不看执行过程。`,
  `约定全文：${DIR}/约定.md。这是第 1 阶段第 2 轮核对，本阶段最多 3 轮。`,
  '林舟的交回（按核对意见改了第 2、3 条）：',
  '1. 打开页面能看到今天的报价', '自查：沿用第 1 轮结论：交付时核对',
  '2. 点刷新后数据更新', '自查：自查符合',
  `证据 ev4：图片 ${DIR}/证据/手机.png 手机　390 宽；中心检查：图片，0.1 KB`,
  '3. 接口失败时有提示', '自查：自查符合',
  `证据 ev5：图片 ${DIR}/证据/桌面.png 手机　390 宽；中心检查：图片，0.1 KB`,
  `产出物：${DIR}/交付/报价页.html`,
  REVIEW_RULES, reviewSubmit(JOB), REVIEW_NO_OWNER,
].join('\n')

/** 样例 7：主人选办法之后的重新核对（取自「7 核对人在主人选办法之后的重新核对」；这一段来自另一次运行，编号不同）。 */
const JOB7 = 'job_rwzutfe7wq'
const DIR7 = '/hub/projects/prj_d0ijouhr2e/jobs/job_rwzutfe7wq'
const S7_REVIEWER_RECHECK = [
  `你是「会员定价页」的核对人（jobId 为 ${JOB7}）。只看约定和下面的证据，不看执行过程。`,
  `约定全文：${DIR7}/约定.md。这是第 2 阶段第 1 轮核对，本阶段最多 3 轮。`,
  '林舟的交回（第3轮的做法）：',
  '1. 打开页面能看到今天的报价', '自查：沿用第 1 轮结论：交付时核对',
  '2. 点刷新后数据更新', '自查：沿用第 1 轮结论：符合',
  `证据 ev1：图片 ${DIR7}/证据/手机.png 手机　390 宽；中心检查：图片，0.1 KB`,
  '3. 接口失败时页面有提示或有备用文案', '自查：自查符合',
  `证据 ev5：文件 ${DIR7}/交付/报价页.html 页面文件；中心检查：文件存在，0.0 KB`,
  `产出物：${DIR7}/交付/报价页.html`,
  REVIEW_RULES, reviewSubmit(JOB7),
  '这一轮是主人选了办法之后的重新核对：只需要给第 3 条写结论，其余条目前面已经通过，不用再写。',
  REVIEW_NO_OWNER,
].join('\n')

/** 样例 8：发布准备中（取自「8 发布准备中」）。 */
const S8_LAUNCH_PREPARE = [
  `「会员定价页」（jobId 为 ${JOB}）主人已验收。下一步是对外发布，必须先经主人批准。`,
  `产出物：${DIR}/交付/报价页.html。`,
  '提交发布：用 hub_outbox_submit 提交发布要运行的命令（kind 写 run_command），why 写为什么发布、发布到哪里，并填 cost（会不会产生费用、多少）、undo（发布后能不能撤回、怎样撤回）、after（批准之后多久上线、上线后会发生什么）。批准前不要发布。',
  `批准后：执行发布，然后调用 hub_job_work，mode 写 launched，jobId 写 ${JOB}，link 写发布后的地址。主人拒绝时不用做任何事。`,
].join('\n')

/** 样例 9：发布已批准（取自「9 发布已批准」）。 */
const S9_LAUNCH_APPROVED = [
  `「会员定价页」（jobId 为 ${JOB}）的发布申请主人已批准。`,
  `执行发布，然后调用 hub_job_work，mode 写 launched，jobId 写 ${JOB}，link 写发布后的地址（http:// 或 https:// 开头）。`,
].join('\n')

// 变体一：写明不再做、在等确认。句子取自 packages/core/src/wake/job-section.ts 第 162 行。
const V_STOP = S1_EXECUTOR_FIRST.replace(EXEC_SUBMIT, `约定第 3 版写明这件事不再做，在等主人确认：确认后这件事由中心停下，确认前可以照常做。做完手上的部分之后，交账的结果写 no_change，说明在等约定确认。\n${EXEC_SUBMIT}`)
// 变体二：材料文件夹。格式取自 packages/core/test/p74c-packet.test.ts 第 96 行与 job-section.ts 第 135 行。
const V_WITH_MATERIAL = S1_EXECUTOR_FIRST.replace('草图.md。', '草图.md；材料文件夹 ' + `${DIR}/材料：竞品价格.txt。`)
// 变体三：核对人还没有交回。句子取自 job-section.ts 第 225 行。
const V_NOT_SUBMITTED = [
  `你是「会员定价页」的核对人（jobId 为 ${JOB}）。只看约定和下面的证据，不看执行过程。`,
  `约定全文：${DIR}/约定.md。这是第 1 阶段第 1 轮核对，本阶段最多 3 轮。`,
  '林舟还没有交回，暂时没有可核对的内容。',
  REVIEW_RULES, reviewSubmit(JOB), REVIEW_NO_OWNER,
].join('\n')
// 变体四：发布在等批准。句子取自 packages/core/src/wake/job-section-launch.ts 第 49 行。
const V_LAUNCH_WAITING = `「会员定价页」（jobId 为 ${JOB}）的发布申请在等主人批准。批准前不要发布，也不用做别的。`
// 变体五：第一级压缩的发布准备（路径改相对，开头一行写主题文件夹的绝对路径）。句子取自 job-section-launch.ts 第 27、32 行。
const V_LAUNCH_RELATIVE = [
  `下面的路径都相对于主题文件夹 ${DIR}`,
  `「会员定价页」（jobId 为 ${JOB}）主人已验收。下一步是对外发布，必须先经主人批准。`,
  '产出物：交付/报价页.html。',
  ...S8_LAUNCH_PREPARE.split('\n').slice(2),
].join('\n')

// ---------------------------------------------------------------------------
// 驱动：模拟「请求 -> 剧本回一步 -> 工具返回结果 -> 再请求」，走完一个回合
// ---------------------------------------------------------------------------

/** 请求里的工具清单（含命令行工具 exec 和 hub_project_put，参数表照真实工具的样子）。 */
const TOOLS = [
  { name: 'hub_state_get', input_schema: { properties: {} } },
  { name: 'hub_commit', input_schema: { properties: {} } },
  { name: 'exec', input_schema: { properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'hub_project_put', input_schema: { properties: { from: { type: 'string' }, to: { type: 'string' }, project: { type: 'string' }, why: { type: 'string' } }, required: ['from'] } },
  { name: 'hub_job_work', input_schema: { properties: { mode: { type: 'string' } }, required: ['mode', 'jobId'] } },
  { name: 'hub_outbox_submit', input_schema: { properties: { kind: { type: 'string' } } } },
]

/** 唤醒包：前面有别的段，「你手上的事」段在中间，后面还有一段（验证只取这一段）。 */
function wrap(section: string): string {
  return `【中心通知】唤醒单 w_1\n\n## 团队现在\n- 林舟：执行中\n\n## 你手上的事（中心维护）\n${section}\n\n## 其他\n无`
}

interface DriveOptions {
  plan?: string
  memory?: Memory
  tools?: unknown[]
  /** 返回错误文字就让这一步的工具结果变成错误；返回 undefined 表示成功。 */
  fail?: (action: Action) => string | undefined
  /** 上一回合留下的对话（验证上一回合的工具调用不会混进来）。 */
  history?: unknown[]
}

/** 走完一个回合，返回每一步（最后一步是交账）。 */
function drive(section: string, options: DriveOptions = {}): Step[] {
  const memory = options.memory ?? P.createJobMemory()
  const plan = P.parsePlan(options.plan)
  const messages: unknown[] = [...(options.history ?? []), { role: 'user', content: [{ type: 'text', text: wrap(section) }] }]
  const steps: Step[] = []
  for (let index = 0; index < 14; index += 1) {
    const step = P.jobAction({ messages, tools: options.tools ?? TOOLS, plan, memory })
    expect(step, `第 ${index + 1} 步应该识别到剧本`).not.toBeNull()
    steps.push(step!)
    if (step!.action.kind === 'commit') return steps
    const id = `toolu_${index}`
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: step!.action.name, input: step!.action.args }] })
    const failure = options.fail?.(step!.action)
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failure !== undefined, content: [{ type: 'text', text: failure ?? '成功' }] }] })
  }
  throw new Error('14 步还没有交账：剧本可能在空转')
}

/** 一个回合里各步的名字（工具名，交账记为 commit）。 */
const namesOf = (steps: Step[]): string[] => steps.map(step => (step.action.kind === 'commit' ? 'commit' : step.action.name!))
/** 一个回合里各步的日志步骤名。 */
const logOf = (steps: Step[]): string[] => steps.map(step => step.step)
/** 取某一步的工具参数。 */
const argsOf = (steps: Step[], name: string, nth = 0): Record<string, unknown> => steps.filter(step => step.action.name === name)[nth]!.action.args!

// ---------------------------------------------------------------------------
// J1 识别
// ---------------------------------------------------------------------------

describe('J1 识别：九种样例各自对应正确的剧本', () => {
  const cases: Array<[string, string, string, string]> = [
    ['样例 1 执行者第一轮', S1_EXECUTOR_FIRST, 'executor', JOB],
    ['样例 2 执行者返工', S2_EXECUTOR_REWORK, 'executor', JOB],
    ['样例 3 约定新版本等确认', S3_EXECUTOR_PAUSED, 'executor', JOB],
    ['样例 4 总管回答之后', S4_EXECUTOR_ANSWERED, 'executor', JOB],
    ['样例 5 核对人第一轮', S5_REVIEWER_FIRST, 'reviewer', JOB],
    ['样例 6 核对人第二轮', S6_REVIEWER_SECOND, 'reviewer', JOB],
    ['样例 7 重新核对', S7_REVIEWER_RECHECK, 'reviewer', JOB7],
    ['样例 8 发布准备中', S8_LAUNCH_PREPARE, 'launch', JOB],
    ['样例 9 发布已批准', S9_LAUNCH_APPROVED, 'launch', JOB],
  ]
  for (const [name, section, role, jobId] of cases) {
    it(name, () => {
      expect(P.identifyJob(wrap(section))).toMatchObject({ role, jobId })
    })
  }
  it('发布的三个阶段：准备中、在等批准、已批准', () => {
    expect(P.identifyJob(wrap(S8_LAUNCH_PREPARE))?.phase).toBe('prepare')
    expect(P.identifyJob(wrap(V_LAUNCH_WAITING))?.phase).toBe('waiting')
    expect(P.identifyJob(wrap(S9_LAUNCH_APPROVED))?.phase).toBe('approved')
  })
  it('没有「你手上的事」段、或段里是没有执行者与核对人身份的一览：返回 null', () => {
    expect(P.identifyJob('【中心通知】醒来\n## 主人对你说\n【提问】请问一下')).toBeNull()
    // 一览、「你正在做」、总管的执行链段：都没有「的执行者（jobId 为」「的核对人（jobId 为」
    expect(P.identifyJob(wrap(`「会员定价页」（jobId 为 ${JOB}）执行中，在等林舟`))).toBeNull()
    expect(P.identifyJob(wrap(`你正在做「会员定价页」（jobId 为 ${JOB}），关于这件事的往来用 hub_job_work。`))).toBeNull()
    expect(P.identifyJob(wrap(`「会员定价页」（jobId 为 ${JOB}）：受阻，执行者林舟，核对人评审甲。约定全文：${DIR}/约定.md`))).toBeNull()
  })
  it('识别句出现在别的段（例如主题讨论）里不算', () => {
    const other = `## 项目主题讨论\n我是「会员定价页」的执行者（jobId 为 ${JOB}）\n\n## 你手上的事（中心维护）\n「会员定价页」（jobId 为 ${JOB}）执行中，在等林舟`
    expect(P.identifyJob(other)).toBeNull()
  })
  it('识别不到时 jobAction 返回 null，原有场景暗号不受影响', () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: '【中心通知】\n## 主人对你说\n【审批】发一下' }] }]
    expect(P.jobAction({ messages, tools: TOOLS, plan: new Set(), memory: P.createJobMemory() })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// J2 执行者第一轮
// ---------------------------------------------------------------------------

describe('J2 执行者第一轮', () => {
  it('步骤顺序：查状态、写页面、写截图、放页面、放截图、交回、交账', () => {
    const steps = drive(S1_EXECUTOR_FIRST)
    expect(namesOf(steps)).toEqual(['hub_state_get', 'exec', 'exec', 'hub_project_put', 'hub_project_put', 'hub_job_work', 'commit'])
    expect(logOf(steps)).toEqual(['state', 'write_html', 'write_png', 'put_html', 'put_png', 'submit', 'commit'])
    expect(steps.every(step => step.jobId === JOB && step.role === 'executor')).toBe(true)
    expect(steps.at(-1)!.commit).toMatchObject({ outcome: 'progress', reply: '已按约定做好页面并交回。' })
  })
  it('放文件的参数全部取自唤醒包文字：to 用「to 写」后面的文件夹，project 用「参数 project 填」后面的编号', () => {
    const steps = drive(S1_EXECUTOR_FIRST)
    expect(argsOf(steps, 'hub_project_put', 0)).toEqual({ from: `work/${JOB}/index.html`, to: `jobs/${JOB}/交付/index.html`, project: PRJ })
    expect(argsOf(steps, 'hub_project_put', 1)).toEqual({ from: `work/${JOB}/shot.png`, to: `jobs/${JOB}/证据/shot.png`, project: PRJ })
  })
  it('交回的条目序号与样例「怎样算做完」逐条一致；交付时核对的写 at_delivery 且没有证据；第一条普通条目用截图，其余用页面文件', () => {
    const submit = argsOf(drive(S1_EXECUTOR_FIRST), 'hub_job_work') as { items: Array<Record<string, unknown>> } & Record<string, unknown>
    // 样例里「{no}. 」开头的行就是条目：序号从样例文字里重新取一遍，不抄剧本的实现
    const nos = S1_EXECUTOR_FIRST.split('\n').flatMap(line => (/^(\d+)\. /.exec(line) ? [Number(/^(\d+)\. /.exec(line)![1])] : []))
    expect(nos).toEqual([1, 2, 3])
    expect(submit.items.map(item => item.no)).toEqual(nos)
    expect(submit.items[0]).toEqual({ no: 1, selfCheck: 'at_delivery' })
    expect(submit.items[1]).toEqual({ no: 2, selfCheck: 'met', evidence: [{ kind: 'image', path: '证据/shot.png', summary: '页面截图' }] })
    expect(submit.items[2]).toEqual({ no: 3, selfCheck: 'met', evidence: [{ kind: 'file', path: '交付/index.html', summary: '页面文件' }] })
    expect(submit).toMatchObject({ mode: 'submit', jobId: JOB, changeNote: '按约定做了页面', deliverables: ['交付/index.html'], preview: '交付/index.html' })
  })
  it('证据路径只写主题文件夹里的相对路径，不引用中心写的文件', () => {
    const text = JSON.stringify(argsOf(drive(S1_EXECUTOR_FIRST), 'hub_job_work'))
    for (const bad of ['约定.md', '原话.md', '草图.md', '材料/', '/hub/']) expect(text).not.toContain(bad)
  })
  it('上一回合留下的工具调用不会混进这一回合：新回合第一步仍是查状态', () => {
    const previous = [
      { role: 'user', content: [{ type: 'text', text: wrap(S1_EXECUTOR_FIRST) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old1', name: 'hub_state_get', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old1', content: [{ type: 'text', text: 'ok' }] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old2', name: 'hub_commit', input: {} }] },
    ]
    // 新唤醒正文和上一回合未答复的 tool_result 拼在同一条 user 消息里
    const merged = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old2', content: [] }, { type: 'text', text: wrap(S1_EXECUTOR_FIRST) }] }
    const first = P.jobAction({ messages: [...previous, merged], tools: TOOLS, plan: new Set(), memory: P.createJobMemory() })
    expect(first?.action).toEqual({ kind: 'tool', name: 'hub_state_get', args: {} })
  })
  it('这一回合已经交过账（hub_commit 的结果回来了）：返回 null，交给原有逻辑收尾', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: wrap(S1_EXECUTOR_FIRST) }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'hub_state_get', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'hub_commit', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [] }] },
    ]
    expect(P.jobAction({ messages, tools: TOOLS, plan: new Set(), memory: P.createJobMemory() })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// J3 返工
// ---------------------------------------------------------------------------

describe('J3 执行者返工', () => {
  it('只交「这一轮要改的条目」里的序号（两条全部取到）；changeNote 写对序号；页面重新放一次，截图不重放', () => {
    const steps = drive(S2_EXECUTOR_REWORK)
    expect(namesOf(steps)).toEqual(['hub_state_get', 'exec', 'hub_project_put', 'hub_job_work', 'commit'])
    expect(logOf(steps)).toEqual(['state', 'write_html', 'put_html', 'submit', 'commit'])
    const submit = argsOf(steps, 'hub_job_work') as { items: Array<{ no: number }>; changeNote: string }
    expect(submit.items.map(item => item.no)).toEqual([2, 3])
    expect(submit.changeNote).toBe('按核对意见改了第 2、3 条')
    expect(submit.items[0]).toMatchObject({ selfCheck: 'met', evidence: [{ kind: 'image', path: '证据/shot.png' }] })
    expect(argsOf(steps, 'hub_project_put').to).toBe(`jobs/${JOB}/交付/index.html`)
    expect(steps.at(-1)!.commit).toMatchObject({ outcome: 'progress', reply: '已按核对意见改好并重新交回。' })
  })
})

// ---------------------------------------------------------------------------
// J4 等约定确认
// ---------------------------------------------------------------------------

describe('J4 约定更新等确认期间', () => {
  it('「暂停」：不做产出物、不交回，交账 no_change，说明在等第几版', () => {
    const steps = drive(S3_EXECUTOR_PAUSED)
    expect(namesOf(steps)).toEqual(['hub_state_get', 'commit'])
    expect(steps[1]!.step).toBe('paused')
    expect(steps[1]!.commit).toEqual({ outcome: 'no_change', summary: '在等约定第 2 版确认', reply: '在等约定确认。' })
  })
  it('写明不再做的新版本在等确认：同样不交回、交账 no_change', () => {
    const steps = drive(V_STOP)
    expect(namesOf(steps)).toEqual(['hub_state_get', 'commit'])
    expect(steps[1]!.commit).toMatchObject({ outcome: 'no_change', summary: '在等约定第 3 版确认' })
  })
})

// ---------------------------------------------------------------------------
// J5 wait_material
// ---------------------------------------------------------------------------

describe('J5 wait_material', () => {
  it('没有材料文件夹时交账 progress，同一件事最多 4 次；第 5 次起照常做产出物', () => {
    const memory = P.createJobMemory()
    for (let turn = 1; turn <= 4; turn += 1) {
      const steps = drive(S1_EXECUTOR_FIRST, { plan: 'wait_material', memory })
      expect(namesOf(steps), `第 ${turn} 次`).toEqual(['hub_state_get', 'commit'])
      expect(steps[1]!.step).toBe('wait')
      expect(steps[1]!.commit).toEqual({ outcome: 'progress', summary: '在等主人的材料', reply: '在等主人的材料。' })
    }
    const fifth = drive(S1_EXECUTOR_FIRST, { plan: 'wait_material', memory })
    expect(namesOf(fifth)).toContain('hub_job_work')
    expect(memory.waits.get(JOB)).toBe(4)
  })
  it('有材料时（「材料」行带材料文件夹）不等', () => {
    const steps = drive(V_WITH_MATERIAL, { plan: 'wait_material' })
    expect(namesOf(steps)).toContain('hub_job_work')
    expect(logOf(steps)).not.toContain('wait')
  })
  it('状态不是执行中（返工中）时不等；没有设置开关时也不等', () => {
    expect(logOf(drive(S2_EXECUTOR_REWORK, { plan: 'wait_material' }))).not.toContain('wait')
    expect(logOf(drive(S1_EXECUTOR_FIRST))).not.toContain('wait')
  })
  it('不同的事各自计数', () => {
    const memory = P.createJobMemory()
    for (let turn = 0; turn < 4; turn += 1) drive(S1_EXECUTOR_FIRST, { plan: 'wait_material', memory })
    const other = S1_EXECUTOR_FIRST.split(JOB).join('job_other00001')
    expect(logOf(drive(other, { plan: 'wait_material', memory }))).toContain('wait')
  })
})

// ---------------------------------------------------------------------------
// J6 ask_once
// ---------------------------------------------------------------------------

describe('J6 ask_once', () => {
  it('同一件事只问一次：第一次先问总管再交账；之后被叫醒（样例 4）直接做产出物', () => {
    const memory = P.createJobMemory()
    const first = drive(S1_EXECUTOR_FIRST, { plan: 'ask_once', memory })
    expect(namesOf(first)).toEqual(['hub_state_get', 'hub_job_work', 'commit'])
    expect(logOf(first)).toEqual(['state', 'ask', 'commit'])
    expect(argsOf(first, 'hub_job_work')).toEqual({ mode: 'ask', jobId: JOB, text: '同一手机号第二次提交时，页面应该提示什么？' })
    expect(first.at(-1)!.commit).toMatchObject({ outcome: 'progress', reply: '已问总管，等回答。' })
    // 总管回答之后叫醒（样例 4）：不再问，直接做
    const second = drive(S4_EXECUTOR_ANSWERED, { plan: 'ask_once', memory })
    expect(logOf(second)).toEqual(['state', 'write_html', 'write_png', 'put_html', 'put_png', 'submit', 'commit'])
  })
  it('返工中不问', () => {
    expect(logOf(drive(S2_EXECUTOR_REWORK, { plan: 'ask_once' }))).not.toContain('ask')
  })
  it('wait_material 和 ask_once 同时设置：先等材料，等够 4 次再问，再做', () => {
    const memory = P.createJobMemory()
    for (let turn = 0; turn < 4; turn += 1) expect(logOf(drive(S1_EXECUTOR_FIRST, { plan: 'wait_material,ask_once', memory }))).toContain('wait')
    expect(logOf(drive(S1_EXECUTOR_FIRST, { plan: 'wait_material,ask_once', memory }))).toContain('ask')
    expect(logOf(drive(S4_EXECUTOR_ANSWERED, { plan: 'wait_material,ask_once', memory }))).toContain('submit')
  })
})

// ---------------------------------------------------------------------------
// J7 wrong_text
// ---------------------------------------------------------------------------

describe('J7 wrong_text', () => {
  /** 这一回合写页面的命令。 */
  const htmlWritten = (steps: Step[]): string => String(argsOf(steps, 'exec', 0).command)
  it('第一次交回的页面含「手机号格式不正确」、不含「请填写 11 位手机号」', () => {
    const html = htmlWritten(drive(S1_EXECUTOR_FIRST, { plan: 'wrong_text' }))
    expect(html).toContain('手机号格式不正确')
    expect(html).not.toContain('请填写 11 位手机号')
  })
  it('返工后相反', () => {
    const html = htmlWritten(drive(S2_EXECUTOR_REWORK, { plan: 'wrong_text' }))
    expect(html).toContain('请填写 11 位手机号')
    expect(html).not.toContain('手机号格式不正确')
  })
  it('没有开关时始终是「请填写 11 位手机号」', () => {
    for (const section of [S1_EXECUTOR_FIRST, S2_EXECUTOR_REWORK]) {
      const html = htmlWritten(drive(section))
      expect(html).toContain('请填写 11 位手机号')
      expect(html).not.toContain('手机号格式不正确')
    }
  })
})

// ---------------------------------------------------------------------------
// J8 页面
// ---------------------------------------------------------------------------

/** 用一个很小的假页面环境运行页面里的脚本，返回可操作的句柄（不依赖真实浏览器）。 */
function openPage(html: string) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
  interface Element { value: string; textContent: string; disabled: boolean; handlers: Record<string, (event?: unknown) => void>; addEventListener(type: string, fn: (event?: unknown) => void): void }
  const elements = new Map<string, Element>()
  const element = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn } })
    return elements.get(id)!
  }
  const store = new Map<string, string>()
  const blobs: Array<{ parts: string[]; type: string }> = []
  const downloads: Array<{ download?: string }> = []
  const sandbox = {
    document: {
      getElementById: element,
      createElement: () => ({ download: undefined as string | undefined, href: '', click() { downloads.push(this) } }),
      body: { appendChild() { /* 假页面不需要 */ }, removeChild() { /* 假页面不需要 */ } },
    },
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } },
    Blob: class { constructor(public parts: string[], options: { type: string }) { blobs.push({ parts, type: options.type }) } },
    URL: { createObjectURL: () => 'blob:demo' },
  }
  runInNewContext(script, sandbox)
  return {
    submit(name: string, phone: string, company = '') {
      element('name').value = name
      element('phone').value = phone
      element('company').value = company
      element('form').handlers.submit!({ preventDefault() { /* 假事件 */ } })
    },
    text: (id: string) => element(id).textContent,
    disabled: (id: string) => element(id).disabled,
    exportCsv() { element('export').handlers.click!(); return { csv: blobs.at(-1)!.parts[0]!, type: blobs.at(-1)!.type, file: downloads.at(-1)?.download } },
    stored: () => JSON.parse(store.get('signups') ?? '[]') as unknown[],
  }
}

describe('J8 页面', () => {
  const html = P.pageHtml(P.GOOD_PROMPT)
  it('含任务卡第 4.6 节列出的全部文字和功能元素', () => {
    for (const part of ['<title>活动报名</title>', '<h1>活动报名</h1>', '姓名', '必填', '手机号', '公司名', '选填', '>提交<', P.GOOD_PROMPT,
      '这个手机号已经报过名', '剩余名额：', '名额已满', '报名成功', '导出报名名单', 'text/csv', 'localStorage', '80']) {
      expect(html, part).toContain(part)
    }
  })
  it('全文没有单引号；不引用外部资源', () => {
    expect(html).not.toContain("'")
    expect(html).not.toMatch(/https?:/)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i)
    expect(html).not.toMatch(/\b(src|href)\s*=\s*"/i)
  })
  it('页面能用：手机号不是 11 位数字时显示提示；同一手机号第二次提示已报名；成功后名额减一；存进本地存储', () => {
    const page = openPage(html)
    expect(page.text('quota')).toBe('剩余名额：80')
    page.submit('甲', '12345')
    expect(page.text('hint')).toBe(P.GOOD_PROMPT)
    page.submit('甲', '13800000001', '某公司')
    expect(page.text('hint')).toBe('报名成功')
    expect(page.text('quota')).toBe('剩余名额：79')
    page.submit('乙', '13800000001')
    expect(page.text('hint')).toBe('这个手机号已经报过名')
    expect(page.stored()).toEqual([{ name: '甲', phone: '13800000001', company: '某公司' }])
  })
  it('报满 80 人后显示「名额已满」并让提交按钮不可用；导出 CSV 含全部报名', () => {
    const page = openPage(html)
    for (let n = 0; n < 80; n += 1) page.submit(`人${n}`, `138000${String(n).padStart(5, '0')}`)
    expect(page.text('quota')).toBe('名额已满')
    expect(page.disabled('submit')).toBe(true)
    const exported = page.exportCsv()
    expect(exported.type).toContain('text/csv')
    expect(exported.file).toBe('signups.csv')
    expect(exported.csv.split('\n')).toHaveLength(81)
    expect(exported.csv).toContain('姓名,手机号,公司名')
    expect(exported.csv).toContain('"人0","13800000000",""')
  })
  it('wrong_text 的页面显示「手机号格式不正确」', () => {
    const page = openPage(P.pageHtml(P.WRONG_PROMPT))
    page.submit('甲', '1')
    expect(page.text('hint')).toBe('手机号格式不正确')
  })
})

// ---------------------------------------------------------------------------
// J9 截图与命令
// ---------------------------------------------------------------------------

describe('J9 截图', () => {
  it('命令里的八进制转义解码后与 PNG 常量逐字节相同，前 8 个字节是 PNG 文件头', () => {
    const decoded = P.decodeOctalEscapes(P.pngCommand(JOB))
    expect(decoded).toEqual([...P.PNG_BYTES])
    expect(decoded.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })
  it('命令真的在一个临时文件夹里跑通：写出的文件字节与常量相同，页面文件与 pageHtml 相同（单引号、换行没有写坏）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p74j-'))
    try {
      execFileSync('sh', ['-c', P.htmlCommand(JOB, P.GOOD_PROMPT)], { cwd: dir })
      execFileSync('sh', ['-c', P.pngCommand(JOB)], { cwd: dir })
      expect([...readFileSync(join(dir, 'work', JOB, 'shot.png'))]).toEqual([...P.PNG_BYTES])
      expect(readFileSync(join(dir, 'work', JOB, 'index.html'), 'utf8')).toBe(P.pageHtml(P.GOOD_PROMPT))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('命令里没有引号以外的 shell 风险字符：截图命令只含 printf 和八进制转义', () => {
    expect(P.pngCommand(JOB)).toMatch(/^printf '(\\[0-7]{3})+' > work\/job_[A-Za-z0-9]+\/shot\.png$/)
  })
})

// ---------------------------------------------------------------------------
// J10 评审员
// ---------------------------------------------------------------------------

describe('J10 评审员', () => {
  const reviewOf = (steps: Step[]) => argsOf(steps, 'hub_job_work') as { items: Array<Record<string, unknown>>; carriedNote?: string; spotChecked?: number[] }

  it('没有开关：第一轮一律通过，交付时核对的写 at_delivery（不带 note）；交账 reply 写第几轮', () => {
    const steps = drive(S5_REVIEWER_FIRST)
    expect(namesOf(steps)).toEqual(['hub_state_get', 'hub_job_work', 'commit'])
    expect(logOf(steps)).toEqual(['state', 'review', 'commit'])
    expect(argsOf(steps, 'hub_job_work')).toEqual({ mode: 'review', jobId: JOB, items: [
      { no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '已对照约定核对' }, { no: 3, verdict: 'met', note: '已对照约定核对' }] })
    expect(steps.at(-1)!.commit).toMatchObject({ outcome: 'progress', reply: '已核对第 1 轮。' })
  })
  it('沿用的条目不写；有沿用时带 carriedNote 和 spotChecked（第一条沿用的序号）；reply 写第 2 轮', () => {
    const steps = drive(S6_REVIEWER_SECOND)
    expect(reviewOf(steps).items).toEqual([{ no: 2, verdict: 'met', note: '已对照约定核对' }, { no: 3, verdict: 'met', note: '已对照约定核对' }])
    expect(reviewOf(steps)).toMatchObject({ carriedNote: '本轮只改了被退回的条目', spotChecked: [1] })
    expect(steps.at(-1)!.commit!.reply).toBe('已核对第 2 轮。')
  })
  it('review_fail_once：这件事的第一次核对判第一条非交付时核对的条目不符，之后都通过', () => {
    const memory = P.createJobMemory()
    const first = reviewOf(drive(S5_REVIEWER_FIRST, { plan: 'review_fail_once', memory }))
    expect(first.items).toEqual([{ no: 1, verdict: 'at_delivery' },
      { no: 2, verdict: 'unmet', note: '提示文字与约定不一致', fixTo: '输入 10 位手机号时，提示文字与约定逐字一致，附一张截图' },
      { no: 3, verdict: 'met', note: '已对照约定核对' }])
    const second = reviewOf(drive(S6_REVIEWER_SECOND, { plan: 'review_fail_once', memory }))
    expect(second.items.every(item => item.verdict === 'met')).toBe(true)
    // 另一件事有自己的计数：第一次核对仍然判不符
    const other = reviewOf(drive(S5_REVIEWER_FIRST.split(JOB).join('job_other00001'), { plan: 'review_fail_once', memory }))
    expect(other.items.some(item => item.verdict === 'unmet')).toBe(true)
  })
  it('review_fail_always：每一轮都判同一条（第一条非沿用、非交付时核对）不符', () => {
    const memory = P.createJobMemory()
    const first = reviewOf(drive(S5_REVIEWER_FIRST, { plan: 'review_fail_always', memory }))
    const second = reviewOf(drive(S6_REVIEWER_SECOND, { plan: 'review_fail_always', memory }))
    const third = reviewOf(drive(S6_REVIEWER_SECOND, { plan: 'review_fail_always', memory }))
    for (const round of [first, second, third]) {
      expect(round.items.filter(item => item.verdict === 'unmet').map(item => item.no)).toEqual([2])
      expect(round.items.find(item => item.verdict === 'unmet')).toMatchObject({ note: '提示文字与约定不一致', fixTo: expect.stringContaining('逐字一致') })
    }
    // 第 2、3 轮里第 1 条沿用，仍然不写、仍带沿用说明
    expect(second.items.some(item => item.no === 1)).toBe(false)
    expect(second.spotChecked).toEqual([1])
  })
  it('主人选办法之后的重新核对：只给指定序号写 met，不论开关（review_fail_always 也一律通过）', () => {
    for (const plan of ['', 'review_fail_once', 'review_fail_always']) {
      const steps = drive(S7_REVIEWER_RECHECK, { plan })
      expect(argsOf(steps, 'hub_job_work')).toEqual({ mode: 'review', jobId: JOB7, items: [{ no: 3, verdict: 'met', note: '已对照约定核对' }] })
    }
  })
  it('还没有交回：不核对，交账 no_change', () => {
    const steps = drive(V_NOT_SUBMITTED)
    expect(namesOf(steps)).toEqual(['hub_state_get', 'commit'])
    expect(steps[1]!.commit).toEqual({ outcome: 'no_change', summary: '还没有可核对的交回', reply: '还没有可核对的交回。' })
  })
})

// ---------------------------------------------------------------------------
// J11 发布
// ---------------------------------------------------------------------------

describe('J11 发布', () => {
  it('准备中：提交一次 run_command 的发布审批，再交账；同一件事不提交第二次', () => {
    const memory = P.createJobMemory()
    const first = drive(S8_LAUNCH_PREPARE, { memory })
    expect(namesOf(first)).toEqual(['hub_state_get', 'hub_outbox_submit', 'commit'])
    expect(logOf(first)).toEqual(['state', 'outbox', 'commit'])
    expect(first.at(-1)!.commit).toMatchObject({ outcome: 'progress', reply: '已提交发布审批，等主人批准。' })
    const again = drive(S8_LAUNCH_PREPARE, { memory })
    expect(namesOf(again)).toEqual(['hub_state_get', 'commit'])
  })
  it('参数通过 core 导出的 OutboxInputSchema；cwd 是绝对路径（第零级从「产出物」行取）；三行不超过 80 字且单行', () => {
    const args = argsOf(drive(S8_LAUNCH_PREPARE), 'hub_outbox_submit')
    expect(OutboxInputSchema.safeParse(args).success, JSON.stringify(OutboxInputSchema.safeParse(args))).toBe(true)
    expect(args.payload).toEqual({ cmd: 'echo', args: ['发布演示'], cwd: DIR })
    for (const key of ['cost', 'undo', 'after']) {
      const text = String(args[key])
      expect([...text].length, key).toBeLessThanOrEqual(80)
      expect(text, key).not.toMatch(/[\r\n]/)
      expect(text, key).not.toMatch(/hub_|job_|prj_/)
    }
  })
  it('第一级压缩（路径改相对）：cwd 取「下面的路径都相对于主题文件夹」那一行的绝对路径', () => {
    expect(P.launchCwdOf(V_LAUNCH_RELATIVE)).toBe(DIR)
    expect(argsOf(drive(V_LAUNCH_RELATIVE), 'hub_outbox_submit').payload).toMatchObject({ cwd: DIR })
  })
  it('两处都取不到：用 /tmp', () => {
    expect(P.launchCwdOf('「会员定价页」（jobId 为 job_x）主人已验收。')).toBe('/tmp')
  })
  it('已批准：调用 launched 回报本机地址，再交账', () => {
    const steps = drive(S9_LAUNCH_APPROVED)
    expect(namesOf(steps)).toEqual(['hub_state_get', 'hub_job_work', 'commit'])
    expect(logOf(steps)).toEqual(['state', 'launched', 'commit'])
    expect(argsOf(steps, 'hub_job_work')).toEqual({ mode: 'launched', jobId: JOB, link: 'http://127.0.0.1:18080/launched-demo' })
    expect(steps.at(-1)!.commit).toMatchObject({ reply: '已发布。' })
  })
  it('在等批准：只交账 no_change，不调用任何工具', () => {
    const steps = drive(V_LAUNCH_WAITING)
    expect(namesOf(steps)).toEqual(['hub_state_get', 'commit'])
    expect(steps[1]!.commit).toMatchObject({ outcome: 'no_change', reply: '在等主人批准发布。' })
  })
})

// ---------------------------------------------------------------------------
// J12 参数通过 core 的校验
// ---------------------------------------------------------------------------

describe('J12 剧本给出的参数通过 core 的工具 schema 与交账校验', () => {
  const tools = buildTools(testing.createTestContext())
  const schemaOf = (name: string) => tools.find(tool => tool.name === name)!.schema

  /** 各种剧本的完整回合：每一步的工具参数都要过对应工具的 schema，每一次交账字段都要过 CommitInputSchema。 */
  const turns: Array<[string, Step[]]> = [
    ['执行者第一轮', drive(S1_EXECUTOR_FIRST)],
    ['执行者返工', drive(S2_EXECUTOR_REWORK)],
    ['执行者先提问', drive(S1_EXECUTOR_FIRST, { plan: 'ask_once' })],
    ['执行者等材料', drive(S1_EXECUTOR_FIRST, { plan: 'wait_material' })],
    ['执行者等约定确认', drive(S3_EXECUTOR_PAUSED)],
    ['核对人第一轮', drive(S5_REVIEWER_FIRST)],
    ['核对人判不符', drive(S5_REVIEWER_FIRST, { plan: 'review_fail_always' })],
    ['核对人第二轮', drive(S6_REVIEWER_SECOND)],
    ['核对人重新核对', drive(S7_REVIEWER_RECHECK)],
    ['核对人没有可核对的', drive(V_NOT_SUBMITTED)],
    ['发布准备中', drive(S8_LAUNCH_PREPARE)],
    ['发布已批准', drive(S9_LAUNCH_APPROVED)],
    ['发布在等批准', drive(V_LAUNCH_WAITING)],
  ]
  for (const [name, steps] of turns) {
    it(name, () => {
      for (const step of steps) {
        if (step.action.kind === 'commit') {
          // 与 fake-model-cards.mjs 的合并一致：在合法参数上换 outcome、summary、reply
          const merged = { ...testing_commitArgs(), ...step.commit! }
          const parsed = CommitInputSchema.safeParse(merged)
          expect(parsed.success, JSON.stringify(parsed)).toBe(true)
          continue
        }
        const name2 = step.action.name!
        if (!['hub_job_work', 'hub_project_put', 'hub_outbox_submit'].includes(name2)) continue
        const parsed = schemaOf(name2).safeParse(step.action.args)
        expect(parsed.success, `${name2} ${JSON.stringify(step.action.args).slice(0, 200)} -> ${JSON.stringify(parsed)}`).toBe(true)
      }
    })
  }
})

/** hub_commit 的一份合法基础参数（与 scripts/fake-model-server.mjs 的 commitArgs(null) 相同的形状）。 */
function testing_commitArgs(): Record<string, unknown> {
  return {
    outcome: 'progress', summary: '端到端冒烟：按剧本完成一次交账', worldChanges: [], evidence: [],
    verification: { level: 'none', notCovered: '冒烟测试不做验证' }, blocker: null,
    nextThink: { mode: 'after', afterMinutes: 90, reason: '冒烟测试：稍后再看一眼' }, ownerQuestion: null, reply: null, report: null, importance: 5, proposals: [],
  }
}

// ---------------------------------------------------------------------------
// J13 工具报错
// ---------------------------------------------------------------------------

describe('J13 工具结果是错误', () => {
  it('命令行工具报错：不重试，下一步就是交账 progress，summary 以「假模型剧本出错：」开头，带报错原文', () => {
    const steps = drive(S1_EXECUTOR_FIRST, { fail: action => (action.name === 'exec' ? 'Error: 没有权限写这个文件夹' : undefined) })
    expect(namesOf(steps)).toEqual(['hub_state_get', 'exec', 'commit'])
    expect(steps.at(-1)!.commit!.outcome).toBe('progress')
    expect(steps.at(-1)!.commit!.summary).toMatch(/^假模型剧本出错：Error: 没有权限写这个文件夹/)
    expect(steps.at(-1)!.error).toContain('没有权限')
  })
  it('hub_project_put 报错（is_error）：同样不重试；报错原文只留前 200 字', () => {
    const long = '错'.repeat(300)
    const steps = drive(S1_EXECUTOR_FIRST, { fail: action => (action.name === 'hub_project_put' ? long : undefined) })
    expect(namesOf(steps)).toEqual(['hub_state_get', 'exec', 'exec', 'hub_project_put', 'commit'])
    expect(steps.at(-1)!.commit!.summary).toBe(`假模型剧本出错：${'错'.repeat(200)}`)
  })
  it('hub_job_work 报错（交回被拒）：交账 progress，不重新交回；评审员、发布同理', () => {
    const submit = drive(S1_EXECUTOR_FIRST, { fail: action => (action.name === 'hub_job_work' ? '预览文件必须在这件事的交付文件夹里' : undefined) })
    expect(namesOf(submit).at(-2)).toBe('hub_job_work')
    expect(submit.at(-1)!.commit!.summary).toContain('假模型剧本出错：预览文件')
    const review = drive(S5_REVIEWER_FIRST, { fail: action => (action.name === 'hub_job_work' ? '这件事当前不在核对中' : undefined) })
    expect(namesOf(review)).toEqual(['hub_state_get', 'hub_job_work', 'commit'])
    expect(review.at(-1)!.commit!.summary).toContain('假模型剧本出错：这件事当前不在核对中')
    const launch = drive(S8_LAUNCH_PREPARE, { fail: action => (action.name === 'hub_outbox_submit' ? '参数不对' : undefined) })
    expect(namesOf(launch)).toEqual(['hub_state_get', 'hub_outbox_submit', 'commit'])
    expect(launch.at(-1)!.commit!.outcome).toBe('progress')
  })
  it('请求的工具清单里没有命令行工具或 hub_project_put：交账说明缺哪个，不空转', () => {
    const noShell = drive(S1_EXECUTOR_FIRST, { tools: TOOLS.filter(tool => tool.name !== 'exec') })
    expect(namesOf(noShell)).toEqual(['hub_state_get', 'commit'])
    expect(noShell.at(-1)!.commit!.summary).toBe('假模型剧本出错：这条会话里没有命令行工具')
    const noPut = drive(S1_EXECUTOR_FIRST, { tools: TOOLS.filter(tool => tool.name !== 'hub_project_put') })
    expect(noPut.at(-1)!.commit!.summary).toBe('假模型剧本出错：这条会话里没有 hub_project_put 工具')
    expect(noPut.at(-1)!.error).toContain('hub_project_put')
  })
  it('命令行工具的名字和参数名按请求里的清单现找（例如 bash 的 script 参数）', () => {
    const tools = [...TOOLS.filter(tool => tool.name !== 'exec'), { name: 'bash', input_schema: { properties: { script: { type: 'string' }, description: { type: 'string' } }, required: ['script', 'description'] } }]
    const steps = drive(S1_EXECUTOR_FIRST, { tools })
    const run = steps.find(step => step.action.name === 'bash')!
    expect(Object.keys(run.action.args!).sort()).toEqual(['description', 'script'])
    expect(String(run.action.args!.script)).toContain(`work/${JOB}/index.html`)
  })
})
