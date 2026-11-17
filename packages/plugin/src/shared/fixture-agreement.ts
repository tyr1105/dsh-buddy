/**
 * 样例约定（P72e，样例数据模式专用）：照设计稿「活动报名页」的例子造一份约定，
 * 让离线走查能看到约定卡的几种样子：
 * - 第 1 版：已被第 2 版取代（折叠成一行）；
 * - 第 2 版：待你确认（页面线框草图、四个待你定的事项、本版改动标记）；
 * - 主题第一层的约定面板（当前版本 + 修订记录）。
 *
 * 为什么单独成文件：约定视图字段很多，混进 fixtures.ts 会淹没其他样例。
 * 形状严格照 core 的 AgreementCardView（api/types.ts），正式运行时由 core 的
 * agreement-views.ts 组装；这里是静态样例，中文标签手工对齐。
 * 样例文字不进文案登记表（见 docs/copy/strings.md「不登记」一条）。
 */
import type { AgreementCardView, AgreementPanelView, AgreementRevisionRow } from './views.js'

/** 样例约定与主题的固定 id（agr_ 加 10 位小写字母或数字；主题 id 是 ptp_ 开头）。 */
export const SAMPLE_AGREEMENT_ID = 'agr_signuppage'
/** P72g B6：样例约定挂在总管负责的项目「活动报名页」下（约定只能建在总管自己负责的项目里）。 */
export const SAMPLE_AGREEMENT_PROJECT_ID = 'prj_signup'
export const SAMPLE_AGREEMENT_TOPIC_ID = 'ptp_signup'
export const SAMPLE_AGREEMENT_TITLE = '活动报名页'
export const SAMPLE_AGREEMENT_TOPIC_TITLE = '活动报名页（11月18日上线）'

/** 样例总管累计的默契度基数（设计稿 E：17 / 20）；离线确认时在它上面累加。 */
export const SAMPLE_RAPPORT_BASE = { adopted: 17, total: 20 } as const

/** 两个版本共用的「我已定的」：条目、依据标签（依据由 core 生成，这里手写成同样的话）。 */
const DECIDED: AgreementCardView['decided'] = [
  { text: '页面同时适配手机和电脑，按手机优先排版。', basisLabel: '依据：通行做法', changed: false },
  { text: '手机号按 11 位数字校验，格式不符时当场提示，不能提交。', basisLabel: '依据：通行做法', changed: false },
  { text: '同一手机号重复提交时，只保留最后一次。', basisLabel: '依据：通行做法', changed: false },
  { text: '不收集身份证号、住址等与报名无关的个人信息。', basisLabel: '依据：你定过的规矩「非必要不收集个人信息」', changed: false },
  { text: '名单保存为表格文件，放在本主题的文件夹里，不接入外部服务。', basisLabel: '依据：通行做法，不产生费用', changed: false },
  { text: '页面能否在你的电脑上直接预览，先做一次小试验（不超过 5 个回合），结果写进主题。', basisLabel: '依据：需要试过才知道', changed: false },
]

/** 待你定的另外三项（两个版本相同）。 */
function otherPending(): AgreementCardView['pending'] {
  return [
    { key: 'limit', index: 2, question: '是否限制报名人数？', options: ['不限', '限制人数，满额后停止报名'], suggested: '不限', chosen: null,
      reason: '你没有提到场地容量。选限制人数时，请在输入框写明人数。', changed: false, added: false },
    { key: 'close', index: 3, question: '什么时候停止报名？', options: ['活动开始前 1 小时自动停止', '等你通知再停止'], suggested: '活动开始前 1 小时自动停止', chosen: null,
      reason: '自动停止不依赖有人值守，活动当天不会漏掉。', changed: false, added: false },
    { key: 'copy', index: 4, question: '活动标题、时间、地点和介绍从哪里来？', options: ['你发来现成的文字', '员工按你给的要点起草，你审定'], suggested: '你发来现成的文字', chosen: null,
      reason: '活动信息只有你掌握，用你的原文最不容易出错。', changed: false, added: false },
  ]
}

const SCOPE_IN = [{ text: '报名页和提交成功页', changed: false }, { text: '报名名单表格', changed: false }, { text: '发布前检查清单', changed: false }]
const SCOPE_OUT = [
  { text: '对外发布：做好后另行请你确认', changed: false }, { text: '短信或邮件通知', changed: false },
  { text: '付费报名', changed: false }, { text: '宣传海报', changed: false },
]

/** 第 1 版：被第 2 版取代，只用来演示折叠成一行、点开可看只读全文。 */
export const sampleAgreementV1: AgreementCardView = {
  agreementId: SAMPLE_AGREEMENT_ID, title: SAMPLE_AGREEMENT_TITLE, projectId: SAMPLE_AGREEMENT_PROJECT_ID, topicId: SAMPLE_AGREEMENT_TOPIC_ID,
  topicTitle: SAMPLE_AGREEMENT_TOPIC_TITLE, versionNo: 1, latestNo: 2,
  state: 'superseded', stateLabel: '已被取代', agreementState: 'pending', canConfirm: false, supersededBy: 2,
  createdText: '11月11日 15:31', lockedAt: null, lockedText: null, sourceLabel: '来源：你在总管私聊里的要求', originLine: null, changeNote: '', removed: [], removedUnlisted: 0,
  summary: { text: '11月18日（周三）前做好一个活动报名页：访客填写报名信息并提交，你拿到一份可导出的报名名单。', changed: false },
  sketch: {
    changed: false,
    value: {
      layout: 'page',
      screens: [{
        title: '报名页（手机上的样子）',
        blocks: [
          { kind: 'title', text: '活动标题', mark: 4 }, { kind: 'text', text: '活动时间和地点' },
          { kind: 'field', text: '姓名', required: true }, { kind: 'field', text: '手机号', required: true, mark: 1 },
          { kind: 'button', text: '提交报名' },
        ],
      }],
    },
  },
  pending: [
    { key: 'fields', index: 1, question: '报名要填哪些信息？', options: ['姓名、手机号', '再加邮箱', '再加所在城市'], suggested: '姓名、手机号', chosen: null,
      reason: '字段越少，填完的人越多；这两项已足够联系到每位报名者。', changed: false, added: false },
    ...otherPending(),
  ],
  decided: DECIDED, scopeIn: SCOPE_IN, scopeOut: SCOPE_OUT,
  doneWhen: [
    { text: '用手机和电脑分别打开页面，都能看到活动标题、时间地点和报名表，无需左右滑动。', changed: false },
    { text: '填写姓名和正确的手机号后提交，页面显示「报名成功」。', changed: false },
    { text: '手机号少填一位时，页面提示「请填写 11 位手机号」，无法提交。', changed: false },
    { text: '连续提交 3 条测试报名后，名单表格中恰好有 3 行，各列与表单一致。', changed: false },
    { text: '11月17日（周二）18:00 前交给你验收，为发布留出一天。', changed: false },
  ],
  adoption: null, rapport: null,
}

/** 第 2 版：待你确认，带「本版改动」和改动标记。 */
export const sampleAgreementV2: AgreementCardView = {
  ...sampleAgreementV1,
  versionNo: 2, state: 'pending', stateLabel: '待你确认', canConfirm: true, supersededBy: null, createdText: '11月11日 15:37',
  sourceLabel: '来源：你在对齐时的修改',
  changeNote: '报名信息加入「公司名（选填）」，名单表格相应增加一列。其余不变。',
  summary: { text: '11月18日（周三）前做好一个活动报名页：访客填写姓名、手机号和公司名（选填）并提交，你拿到一份可导出的报名名单。', changed: true },
  sketch: {
    changed: true,
    value: {
      layout: 'page',
      screens: [
        {
          title: '报名页（手机上的样子）',
          blocks: [
            { kind: 'title', text: '活动标题', mark: 4 }, { kind: 'text', text: '活动时间和地点' },
            { kind: 'field', text: '姓名', required: true }, { kind: 'field', text: '手机号', required: true, mark: 1 },
            { kind: 'field', text: '公司名（选填）' }, { kind: 'button', text: '提交报名' },
            { kind: 'note', text: '名额规则', mark: 2 }, { kind: 'note', text: '截止规则', mark: 3 },
          ],
        },
        { title: '提交后', blocks: [{ kind: 'title', text: '报名成功' }, { kind: 'text', text: '活动时间和地点再显示一遍，方便截图保存。' }] },
        {
          title: '你拿到的名单（表格文件）',
          blocks: [{ kind: 'table', text: '报名名单', rows: [['姓名', '手机号', '公司名', '时间'], ['测试一', '138……01', '某科技', '10:02'], ['测试二', '139……02', '', '10:05']] }],
        },
      ],
    },
  },
  pending: [
    { key: 'fields', index: 1, question: '报名要填哪些信息？', options: ['姓名、手机号、公司名（选填）', '再加邮箱', '再加所在城市'], suggested: '姓名、手机号、公司名（选填）', chosen: null,
      reason: '字段越少，填完的人越多；公司名选填，不影响联系到每位报名者。', changed: true, added: false },
    ...otherPending(),
  ],
  doneWhen: [
    ...sampleAgreementV1.doneWhen.slice(0, 3),
    { text: '连续提交 3 条测试报名后，名单表格中恰好有 3 行，各列与表单一致，公司名可为空。', changed: true },
    sampleAgreementV1.doneWhen[4]!,
  ],
}

/** 样例的修订记录（从新到旧），与两个版本对应。 */
export const sampleAgreementRevisions: AgreementRevisionRow[] = [
  { no: 2, timeText: '11月11日 15:37', stateLabel: '待你确认', text: '报名信息加入「公司名（选填）」，名单表格相应增加一列。其余不变。', sourceLabel: '来源：你在对齐时的修改', locked: false },
  { no: 1, timeText: '11月11日 15:31', stateLabel: '已被取代', text: '初稿，未固定', sourceLabel: '来源：你在总管私聊里的要求', locked: false },
]

/** 主题第一层的约定面板：待确认时当前版本是最新版（第 2 版）。 */
export const sampleAgreementPanel: AgreementPanelView = {
  current: sampleAgreementV2, revisions: sampleAgreementRevisions, revisionCount: 1,
}
