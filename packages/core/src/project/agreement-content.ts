/**
 * 约定内容的处理（P72a）：提交参数的形状、内容合并、key 兜底匹配、依据解析、版本对比、默契度。
 *
 * 为什么单独成文件：除了「依据解析」要读存储之外，这里全是纯函数（输入什么、输出什么，不碰时钟、文件、随机数），
 * 可以逐条单测。服务层（agreements.ts）只负责把它们按顺序串起来、再写表。
 *
 * 校验分两层：
 * - 本文件的 AgreementSubmitInputSchema 只管「形状和长度」，它原样会被 P72b 当作工具参数；
 * - 「哪些字段在什么模式下必填」要看约定当前状态，放在服务层判断。
 */
import { z } from 'zod';
import { AGREEMENT_DEFAULTS as D, JOB_DEFAULTS, SKILL_DEFAULTS } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import {
  BasisKindSchema, SketchSchema, launchOf, stripTrailingPunctuation,
  type AgreementContent, type ChangeMark, type DecidedItem, type PendingItem,
} from '../model/agreement.js';
import { hasInvisibleChars, internalNameIn, mentionsOwnerWord, ownerWordRefusal } from '../job/owner-text.js';
import { legacyRulesOf } from '../memory/memory-read.js';
import type { Memory } from '../model/memory.js';
import { nonempty, recordId, text } from '../model/primitives.js';
import { LOCAL_DIR_MISSING_REFUSAL, checkLocalDir, howNamesLocalPlace, localDirEnvOf, localDirRefusal } from './local-dir.js';

// ---------------------------------------------------------------------------
// 提交参数（工具参数用，根节点必须是对象，不能是联合）
// ---------------------------------------------------------------------------

/** 非空且不超过 max 个完整字符的一行字。 */
function line(max: number) {
  return nonempty
    .refine(value => value.trim().length > 0, '不能为空')
    .refine(value => [...value].length <= max, `不能超过 ${max} 字`);
}
const keyText = text.regex(/^[a-z][a-z0-9-]{0,15}$/, '必须以小写字母开头，只含小写字母、数字、连字符，最长 16 位');

/** 提交时的待定项：没有 chosen（固定时才写）。 */
export const PendingInputSchema = z.strictObject({
  key: keyText.describe('待定项的稳定标识，小写字母开头，只含小写字母、数字、连字符，最长 16 位；修订时同一件事请沿用原 key'),
  question: line(D.QUESTION_MAX_CHARS).describe(`要主人拍板的问题，不超过 ${D.QUESTION_MAX_CHARS} 字`),
  options: z.array(line(D.OPTION_MAX_CHARS)).min(D.OPTIONS_MIN).max(D.OPTIONS_MAX)
    .describe(`可选项，${D.OPTIONS_MIN} 到 ${D.OPTIONS_MAX} 个，各不超过 ${D.OPTION_MAX_CHARS} 字，不能重复`),
  suggested: text.describe('你的建议，必须与某个选项的文字完全一致'),
  reason: line(D.REASON_MAX_CHARS).describe(`建议的一句理由，不超过 ${D.REASON_MAX_CHARS} 字`),
});
export type PendingInput = z.infer<typeof PendingInputSchema>;

/** 提交时的已定事项：依据只给 kind 和 ref，出处原文由中心读出，模型写不进。 */
export const DecidedInputSchema = z.strictObject({
  text: line(D.DECIDED_MAX_CHARS).describe(`已经定下来的事，不超过 ${D.DECIDED_MAX_CHARS} 字`),
  basis: z.strictObject({
    kind: BasisKindSchema.describe('依据类型：source 有出处（要填 ref）；convention 通行做法；trial 需要试过才知道；judgement 我的判断'),
    ref: text.max(100, '出处 id 不能超过 100 字').optional().describe('仅 source 填：规矩 id（ru_ 开头）或项目决策 id（dc_ 开头）；查不到出处就改写 kind 为 judgement'),
  }).describe('这件事的依据'),
});
export type DecidedInput = z.infer<typeof DecidedInputSchema>;

const items = (max: number, itemMax: number) => z.array(line(itemMax)).max(max);

/**
 * P74r9：对外发布的「发布到哪里、用什么方式」：1 到 LAUNCH_HOW_MAX_CHARS 字、一行；主人在约定卡上直接看到，
 * 所以看不见的字符、工具名、内部编号这类内部名称一律拒绝，让总管改成白话（判断沿用 job/owner-text.ts，与审批卡三行同一做法）。
 */
const launchHow = z.string({ error: 'launch.how：必须是文字' }).trim().min(1, 'launch.how：不能为空')
  .refine(value => [...value].length <= D.LAUNCH_HOW_MAX_CHARS, `launch.how：不能超过 ${D.LAUNCH_HOW_MAX_CHARS} 字`)
  .refine(value => !/[\r\n]/.test(value), 'launch.how：写成一行，不要换行')
  .refine(value => !hasInvisibleChars(value), 'launch.how：含有看不见的字符，请删掉后重写。')
  .refine(value => internalNameIn(value) === null, 'launch.how：这句话主人直接看到，不能出现工具名、内部编号这类内部名称，请改成白话');

/**
 * P74r14：约定各栏的内容和本版改动的说明都会显示给主人，称呼应写「你」；出现「主人」就拒绝，一次列全。
 * 只检查总管填的、给主人看的字段（概述、待定项的问题和选项和理由、已定的事、这次做、这次不做、怎样算做完、发布方式、本版改动）；
 * 撤下的理由、给模型看的文字不在此列。
 */
export function ownerWordProblems(input: {
  summary?: string | undefined; changeNote?: string | undefined; scopeIn?: readonly string[] | undefined; scopeOut?: readonly string[] | undefined;
  doneWhen?: readonly string[] | undefined; launch?: { how: string; localDir?: string | undefined } | null | undefined;
  pending?: ReadonlyArray<{ question: string; options: readonly string[]; reason: string }> | undefined; decided?: ReadonlyArray<{ text: string }> | undefined;
}): string[] {
  const rows: Array<[string, string]> = [];
  if (input.summary !== undefined) rows.push(['summary', input.summary]);
  if (input.changeNote !== undefined) rows.push(['changeNote', input.changeNote]);
  (input.pending ?? []).forEach((item, i) => {
    rows.push([`pending[${i}].question`, item.question], [`pending[${i}].reason`, item.reason]);
    item.options.forEach((option, j) => rows.push([`pending[${i}].options[${j}]`, option]));
  });
  (input.decided ?? []).forEach((item, i) => rows.push([`decided[${i}].text`, item.text]));
  for (const [name, list] of [['scopeIn', input.scopeIn], ['scopeOut', input.scopeOut], ['doneWhen', input.doneWhen]] as const) {
    (list ?? []).forEach((text, i) => rows.push([`${name}[${i}]`, text]));
  }
  if (input.launch != null) rows.push(['launch.how', input.launch.how]);
  // P74r15：「宠物主人」「主人公」这类含有这两个字的普通词不算（mentionsOwnerWord），拒绝文字后面加半句。
  return rows.filter(([, text]) => mentionsOwnerWord(text)).map(([name]) => ownerWordRefusal(name));
}

/**
 * P81：总管的工具说明和对齐时的说明里，launch 那一段补的一句（逐字，任务卡 P81 第 1 节第 6 条）；
 * 工具说明（tools/hub-agreement-submit.ts）、对齐时的说明（wake/chief-packet.ts）、参数说明三处共用这一句。
 * P82（缺陷 2）：补一句「这个文件夹本身可以还不存在，发布命令会自己建出来」——真实模型曾把「准备发布文件夹」
 * 当成自己该干的活，先申请建目录、再想写占位文件；发布位置只需要上一级文件夹存在，文件夹由发布命令创建。
 */
export const LOCAL_DIR_SENTENCE = '主人要把成果放到他电脑上的某个文件夹时，把这个文件夹写进 launch.localDir；一份约定只能写一个；这个文件夹本身可以还不存在，发布命令会自己建出来，不用先建，但它的上一级文件夹要已经存在。';
const LOCAL_DIR_DESCRIPTION = `${LOCAL_DIR_SENTENCE}写完整路径，可以用 ~ 表示主目录，例如 ~/Desktop/活动页面；至少两级，不能是主目录或桌面本身。`;

/** hub_agreement_submit 的参数。字段在新建、修订、撤下时各自要哪些，见服务层 submitAgreement。 */
export const AgreementSubmitInputSchema = z.strictObject({
  agreementId: recordId('agr').optional().describe('要修改或撤下的约定 id；新建时省略'),
  mode: z.enum(['draft', 'revise', 'amend', 'withdraw']).optional()
    .describe('draft 新建；revise 待确认时修订，或已固定后重大改动重新请主人确认；amend 已固定后的小改动直接生效；withdraw 撤下待确认的约定。省略时按约定状态取 draft 或 revise。revise 时：没有变的条目逐字照抄上一版：改了字的条目，中心都会列为「暂停，等你确认」，执行者会停下这一条。草图和标题里与这次改动有关的内容一并改。'),
  projectId: recordId('prj').optional().describe('仅新建时可填：这件事属于哪个进行中的项目，就填那个项目的编号（见「进行中的项目」，任何进行中的项目都可以，不要求你是成员）；只有哪个都不沾边时才省略，省略就为这件事新建项目。在项目对话里提的约定省略时放进这个项目'),
  title: line(D.TITLE_MAX_CHARS).optional().describe(`约定标题，不超过 ${D.TITLE_MAX_CHARS} 字；新建时必填，修订时不写表示沿用，写了表示改标题（新版本固定后主题的标题随之改）。标题只写这件事是什么，不写人数、日期这类以后可能改的内容。`),
  changeNote: line(D.CHANGE_NOTE_MAX_CHARS).optional().describe(`本版改了什么，一句话，不超过 ${D.CHANGE_NOTE_MAX_CHARS} 字；revise 和 amend 必填；约定各栏和这句话都会显示给主人看，称呼写「你」，不写「主人」`),
  reason: line(D.WITHDRAW_REASON_MAX_CHARS).optional().describe(`撤下的理由，不超过 ${D.WITHDRAW_REASON_MAX_CHARS} 字；withdraw 必填`),
  summary: line(D.SUMMARY_MAX_CHARS).optional().describe(`一句话复述主人想要什么，不超过 ${D.SUMMARY_MAX_CHARS} 字`),
  sketch: SketchSchema.optional().describe('草图：layout 取 page（页面线框，用 screens）、flow（流程，用 steps）、concept（概念，用 nodes 和 links）；不能混用'),
  pending: z.array(PendingInputSchema).max(D.PENDING_MAX).optional()
    .describe(`待主人定的事项，${D.PENDING_MIN} 到 ${D.PENDING_MAX} 项，每项给建议和理由`),
  decided: z.array(DecidedInputSchema).max(D.DECIDED_MAX).optional()
    .describe(`已经定下的事，最多 ${D.DECIDED_MAX} 条，可以为空数组`),
  scopeIn: items(D.SCOPE_IN_MAX, D.SCOPE_ITEM_MAX_CHARS).optional().describe(`这次要做的范围，${D.SCOPE_IN_MIN} 到 ${D.SCOPE_IN_MAX} 条`),
  scopeOut: items(D.SCOPE_OUT_MAX, D.SCOPE_ITEM_MAX_CHARS).optional().describe(`这次明确不做的范围，最多 ${D.SCOPE_OUT_MAX} 条，可以为空数组`),
  doneWhen: items(D.DONE_WHEN_MAX, D.DONE_WHEN_MAX_CHARS).optional().describe(`怎样算做完，${D.DONE_WHEN_MIN} 到 ${D.DONE_WHEN_MAX} 条，要能被检查`),
  // P74r9：验收之后要不要对外发布，只在约定里说一遍；主人确认的就是中心照办的。
  launch: z.strictObject({
    how: launchHow.describe(`发布到哪里、用什么方式，一行，不超过 ${D.LAUNCH_HOW_MAX_CHARS} 字，用白话写，不含内部名称；只写发布到哪里、用什么方式，不写「发布前请你批准」这类话（约定卡上中心会加）`),
    // P81：发布到主人电脑上的某个文件夹时填；形状只管是文字，路径是否可用由中心按固定规则判断（project/local-dir.ts）。
    localDir: z.string({ error: 'launch.localDir：必须是文字' }).trim().min(1, 'launch.localDir：不能为空').optional()
      .describe(LOCAL_DIR_DESCRIPTION),
  }).nullable().optional()
    .describe('验收之后要对外发布时写 { how }：发布到哪里、用什么方式；主人没有说发布到哪里时，你能给出具体可行的方式就直接写进 launch，给不出就不写（改在 scopeOut 里写明这次不含发布）；这件事不含对外发布就不写（新建时不写按「不发布」）。修订时不写表示不变，写 null 表示去掉，写对象表示设定或修改。主人会在约定卡上看到这一项并确认；发布前中心还会单独请主人批准。发布这一步只写在这里：「这次做」「怎样算做完」里不要出现发布要去的位置，也不要把「已发布」「已上线」当作完成条件。'),
  // P72h H1：有意删除条目时才填。某一段传了、但条数比上一版少，少掉的每一条都必须在这里写明，否则整份提交被拒绝。
  removals: z.array(line(D.REMOVAL_MAX_CHARS)).max(D.REMOVALS_MAX).optional()
    .describe('修订时确实要删除的条目：逐条写出被删条目的原文（待定项写它的 key）。我已定的、这次做、这次不做、怎样算做完这四段传了、且条数比上一版少时，上一版有、这一版找不到的每一条都要写；待定项去掉或换掉某一项时，也要写它的 key；没改的条目要原样带上，不要靠删除来省事'),
  // P74e（B2）：这份约定已有一件正在做的事、revise 让它重新确认时才用；其余情况传了会被拒绝。
  continuing: z.array(line(JOB_DEFAULTS.PAUSE_ITEM_MAX_CHARS)).min(1).max(JOB_DEFAULTS.PAUSE_ITEMS_MAX).optional()
    .describe(`正在做的事要改约定时必填（mode 为 revise）：不受这次改动影响、照常在做的部分，1 到 ${JOB_DEFAULTS.PAUSE_ITEMS_MAX} 项，各不超过 ${JOB_DEFAULTS.PAUSE_ITEM_MAX_CHARS} 字；写了被这次改动涉及的条目会被拒绝（那一部分要写进 paused）`),
  paused: z.array(line(JOB_DEFAULTS.PAUSE_ITEM_MAX_CHARS)).min(1).max(JOB_DEFAULTS.PAUSE_ITEMS_MAX).optional()
    .describe(`正在做的事要改约定时必填（mode 为 revise）：暂停、等主人确认的部分，1 到 ${JOB_DEFAULTS.PAUSE_ITEMS_MAX} 项，各不超过 ${JOB_DEFAULTS.PAUSE_ITEM_MAX_CHARS} 字；中心会把这次改动涉及的条目自动列在最前面`),
  // P74r2c：正在做的事改了「怎样算做完」时，可写明新版本里哪几条要到交付时才能核对（新版本的序号）；不写就按条目原文对应原来的。
  deliveryItems: z.array(z.number({ error: 'deliveryItems：必须是整数' }).int('deliveryItems：必须是整数')).optional()
    .describe('正在做的事要改约定时可选（mode 为 revise）：新版本里写了交付时间的那一条的序号（新版本的序号，最多 2 条、原文里必须写了时间；通常只有一条，没有就不写；其余条目都要有证据并经过核对）；不写时中心按条目原文把原来的交付时核对条目对应到新序号，原文被改写或删去的不再算'),
  // P74r3（H1）：主人发起的回合里，这份约定有进行中的事、这件事有未回答且还没关联到某个版本的提问时必填；其余情况传了忽略。
  answersAsk: z.boolean().optional()
    .describe('主人发话的回合里，正在做的事要改约定、而且这件事有一个没回答的提问时必填：这一版是不是在回答那个提问。是写 true（主人确认后由中心回答它）；不是写 false（之后仍要用 hub_job_manage 的 answer 回答它）。其余情况不用写'),
  // P74f-2：主人说这件事不做了，而这份约定有进行中的事：mode revise 并写 stopsJob，主人确认后由中心停下这件事。
  stopsJob: z.boolean().optional()
    .describe('主人说这件事不做了、而这份约定有进行中的事时，mode revise 写 true：这一版要写明不再做（例如把「这次做」改小、写进「这次不做」）；此时不用写 continuing、paused，主人确认后中心直接停下这件事，不叫醒你。其余情况不写'),
  fallback: line(JOB_DEFAULTS.FALLBACK_MAX_CHARS).optional()
    .describe(`正在做的事要改约定时可选：不改的退路，一句话，不超过 ${JOB_DEFAULTS.FALLBACK_MAX_CHARS} 字，例如「如果「限 80 人」只是文案说法，回复「不限」，我保留第 3 版。」`),
  // P75b：这件事属于哪类工作（词表在 SKILL_DEFAULTS.CATEGORIES）。存旁表 agreementTags，不进约定内容：
  // 新建时不填按默认类别；修订和直接生效的小改动里填了就改、不填不动。
  category: text.refine(value => SKILL_DEFAULTS.CATEGORIES.includes(value), `只能写这些类别之一：${SKILL_DEFAULTS.CATEGORIES.join('、')}`).optional()
    .describe('这件事属于哪类工作，从约定段末尾的类别表里选一个；新建时不填按「其他」'),
});
export type AgreementSubmitInput = z.infer<typeof AgreementSubmitInputSchema>;

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 七项内容的名字，新建缺项时原样列在错误里。 */
const CONTENT_FIELDS = ['summary', 'sketch', 'pending', 'decided', 'scopeIn', 'scopeOut', 'doneWhen'] as const;

/**
 * P74r10：「怎样算做完」里出现这些说法，说明这一条说的是验收之后才发生的事。
 * 为什么要拦：「怎样算做完」的每一条都要由核对人在交付之前逐条核对；验收之后的事在核对时不可能成立，
 * 核对人照实判就永远不通过，这件事会卡住。对外发布写在 launch 里，不写进这里。
 */
/**
 * P74r13：分两组。
 * - 任何约定都拦的九种：说的一定是验收（或主人批准）之后的事；
 * - 只在这一版约定写了对外发布（launch）时才拦的六种：这时「发布」「上线」指的就是验收之后的那一步；
 *   没有对外发布的约定里，「测试环境发布后冒烟通过」「文档写明上线后如何回滚」这类写法说的是交付前就能核对的事，不拦。
 */
export const ALWAYS_BLOCKED_PHRASES = [
  '验收后', '验收之后', '验收以后', '验收通过后', '验收通过之后', '验收完成后',
  '经你批准', '你批准后', '你批准之后',
] as const;
// P74r18a：再加八种「发布已经完成」的说法：真实模型把「已复制到某目录」当作完成条件，执行者为了做到就提前发布了。
export const LAUNCH_ONLY_PHRASES = [
  '发布后', '发布之后', '发布以后', '上线后', '上线之后', '上线以后',
  '已发布', '已上线', '发布完成', '上线完成', '发布成功', '上线成功', '完成发布', '完成上线',
] as const;
/** 全部十五种说法（两组合在一起，供测试逐种核对）。 */
export const AFTER_ACCEPTANCE_PHRASES = [...ALWAYS_BLOCKED_PHRASES, ...LAUNCH_ONLY_PHRASES] as const;

/** 拒绝的文字（{i} 是从 0 起的序号，路径写法与约定内容的其他校验一致）。 */
export function afterAcceptanceRefusal(index: number): string {
  return `doneWhen[${index}]：这一条说的是验收之后才发生的事。「怎样算做完」的每一条都要在交付核对时就能判断；对外发布写在 launch 里，不写进这里。`;
}

/**
 * 校验本次提交的「怎样算做完」：任何一条含验收之后的说法就拒绝，同一次提交里有多条时按序号一次列全。
 * 只看这次提交里写的条目（新建、修订都用）；修订时没写 doneWhen 的沿用上一版，不在这里检查。
 * hasLaunch（P74r13）：这一版约定有没有写对外发布；只有写了，「发布后」「上线后」一类才算验收之后的说法。
 */
export function assertDoneWhenBeforeAcceptance(doneWhen: readonly string[] | undefined, hasLaunch: boolean): void {
  if (doneWhen === undefined) return;
  const phrases: readonly string[] = hasLaunch ? AFTER_ACCEPTANCE_PHRASES : ALWAYS_BLOCKED_PHRASES;
  const problems = doneWhen.flatMap((item, index) =>
    phrases.some(phrase => item.includes(phrase)) ? [afterAcceptanceRefusal(index)] : []);
  if (problems.length > 0) throw new Error(`约定内容无效：${problems.join('；')}`);
}

// ---------------------------------------------------------------------------
// P74r18a：对外发布要去的位置不能出现在「这次做」「怎样算做完」里
// ---------------------------------------------------------------------------

/** 路径、网址、域名里可能出现的字符：只取半角，避免把后面紧跟的中文吞进位置里。 */
const LOC_CHAR = /[A-Za-z0-9_~@+\-/]/;

/** 常见文件扩展名：域名的最后一段是这些时，说的是文件名，不当作发布位置。 */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'html', 'htm', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'json', 'md', 'txt', 'csv', 'xml', 'yml', 'yaml',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'pdf', 'zip', 'gz', 'tar', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'py', 'sh', 'rb', 'go', 'rs', 'java', 'sql', 'log', 'mp3', 'mp4', 'mov',
]);

/** 去掉末尾的斜杠和句末标点（取出的位置不含它们）。 */
function trimLocation(value: string): string {
  return value.replace(/[/.,;:!?)\]]+$/, '');
}

/**
 * 从发布方式里取出「发布要去的位置」：先取网址，再取路径（至少两级），最后取域名。
 * 取不出任何位置时返回空数组（这时位置规则不生效）。
 */
export function launchLocationsOf(how: string): string[] {
  const found: string[] = [];
  let rest = how;
  // 网址：http:// 或 https:// 开头的一段。取完之后从文字里抹掉，避免它的主机名、路径被当成域名、路径再取一遍。
  rest = rest.replace(/https?:\/\/[A-Za-z0-9_~@+\-./:%?#=&]+/g, match => {
    const url = trimLocation(match);
    if (url.replace(/^https?:\/\//, '') !== '') found.push(url);
    return ' ';
  });
  // 路径：以 / 或 ~/ 开头、至少两级；前面不能紧跟路径字符（不从别的路径中间截取）。
  rest = rest.replace(/(?<![A-Za-z0-9_~@+\-./:])(?:~\/|\/)[A-Za-z0-9_~@+\-.]+(?:\/[A-Za-z0-9_~@+\-.]+)+\/?/g, match => {
    const path = trimLocation(match);
    const depth = path.replace(/^~?\//, '').split('/').filter(part => part !== '').length;
    if (depth >= 2) found.push(path);
    return ' ';
  });
  // 域名：至少一个点，最后一段是两个以上的字母。
  for (const match of rest.matchAll(/(?<![A-Za-z0-9_@\-.])[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![A-Za-z0-9_\-])/g)) {
    // 最后一段是常见文件扩展名（index.html、app.js 这类文件名）时不是域名。
    const last = match[0].slice(match[0].lastIndexOf('.') + 1).toLowerCase();
    if (!FILE_EXTENSIONS.has(last)) found.push(match[0]);
  }
  return [...new Set(found)];
}

/** 这一条文字里有没有这个位置（不分大小写，位置前后不能紧挨着路径字符，避免「/tmp/a」命中「/tmp/ab」）。 */
function containsLocation(item: string, location: string): boolean {
  const hay = item.toLowerCase();
  const needle = location.toLowerCase();
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : hay[at - 1]!;
    const after = hay[at + needle.length] ?? '';
    // 位置以 / 或 ~ 开头时，前一个字符不能是路径字符；以字母数字开头（域名、网址）时，前一个字符不能是字母数字。
    if (before !== '' && LOC_CHAR.test(before)) continue;
    // 后面紧跟的 / 视为同一个位置（末尾斜杠不计）；紧跟字母数字、连字符、下划线说明是更长的另一个位置。
    if (after !== '' && /[A-Za-z0-9_~@+-]/.test(after)) continue;
    // 后面是「.字母数字」（例如 /tmp/a 与 /tmp/a.html）也是另一个位置；句末的句点不算。
    if (after === '.' && /[A-Za-z0-9]/.test(hay[at + needle.length + 1] ?? '')) continue;
    return true;
  }
  return false;
}

/** 拒绝的文字（逐字，给总管看）。 */
export function launchLocationInDoneWhenRefusal(index: number, location: string): string {
  return `doneWhen[${index}]：这一条写到了对外发布要去的位置（${location}）。对外发布在验收之后、经主人批准才进行，不能当作交付时的完成条件；改成交付时就能核对的说法，或删去。`;
}
export function launchLocationInScopeInRefusal(index: number, location: string): string {
  return `scopeIn[${index}]：这一条写到了对外发布要去的位置（${location}）。对外发布写在 launch 里，由中心在验收之后请主人批准再进行；「这次做」只写验收之前要做的事。`;
}

/**
 * P74r18a：校验这一版「实际生效」的内容（本次提交与上一版合并之后的结果，新建、修订、小改动都用）：
 * - 「怎样算做完」不能含验收之后的说法（原规则）；
 * - 这一版写了对外发布时，「怎样算做完」「这次做」的任何一条都不能写到发布要去的位置。
 * 有问题时一次列全，序号是生效内容里的序号。
 */
export function assertAgreementBeforeLaunch(content: Pick<AgreementContent, 'doneWhen' | 'scopeIn' | 'launch'>): void {
  const launch = launchOf(content);
  const phrases: readonly string[] = launch !== null ? AFTER_ACCEPTANCE_PHRASES : ALWAYS_BLOCKED_PHRASES;
  const locations = launch !== null ? launchLocationsOf(launch.how) : [];
  const problems: string[] = [];
  content.doneWhen.forEach((item, index) => {
    if (phrases.some(phrase => item.includes(phrase))) problems.push(afterAcceptanceRefusal(index));
    const hit = locations.find(location => containsLocation(item, location));
    if (hit !== undefined) problems.push(launchLocationInDoneWhenRefusal(index, hit));
  });
  content.scopeIn.forEach((item, index) => {
    const hit = locations.find(location => containsLocation(item, location));
    if (hit !== undefined) problems.push(launchLocationInScopeInRefusal(index, hit));
  });
  if (problems.length > 0) throw new Error(`约定内容无效：${problems.join('；')}`);
}

/** P74r10：整理提交的对外发布项：how 去掉首尾空白和末尾标点；整理后为空，按「不能为空」拒绝（与原有规则同一句话）。 */
function normalizeLaunchInput(launch: { how: string; localDir?: string | undefined } | null): { how: string; localDir?: string } | null {
  if (launch === null) return null;
  const how = stripTrailingPunctuation(launch.how);
  if (how === '') throw new Error('launch.how：不能为空');
  // P81：localDir 在这里原样带上；是否可用由服务层按 project/local-dir.ts 的规则校验并整理（需要主人主目录等运行环境）。
  return launch.localDir === undefined ? { how } : { how, localDir: launch.localDir };
}

/**
 * P81：校验并整理这一版的发布位置（localDir）。只在这次提交里写了 launch 对象时检查（不写沿用上一版、写 null 是去掉，都没有新位置要查）：
 * - 写了 localDir：按 checkLocalDir 校验，不合格整份提交被拒（文字逐字，任务卡 P81 第 1 节第 3 条）；合格的存整理之后的绝对路径；
 * - 没写 localDir、但 launch.how 明显写的是主人电脑上的位置（howNamesLocalPlace）：拒绝（逐字，第 5 条）。
 * 返回新内容，不改入参。必须在任何写入之前调用。
 */
export function resolveLaunchLocalDir(ctx: HubContext, content: AgreementContent, input: Pick<AgreementSubmitInput, 'launch'>): AgreementContent {
  if (input.launch === undefined || input.launch === null || content.launch == null) return content;
  const raw = input.launch.localDir;
  if (raw === undefined) {
    if (howNamesLocalPlace(content.launch.how, ctx)) throw new Error(LOCAL_DIR_MISSING_REFUSAL);
    return content;
  }
  const checked = checkLocalDir(raw, localDirEnvOf(ctx));
  if (!checked.ok) throw new Error(localDirRefusal(checked.reason));
  return { ...content, launch: { how: content.launch.how, localDir: checked.path } };
}

/**
 * 合并提交内容。
 * - prev 为 null（新建）：七项缺任何一项都报错，并一次列出全部缺的项（decided 可以是空数组，但不能缺省）；
 * - prev 不为 null（修订）：缺省的项沿用上一版。
 * pending 的 chosen 一律置 null（固定时才写）；decided 的 refText 先置 null，由 resolveBasis 之后补上。
 * 注意：这里只合并，不校验长度和规则，校验交给 AgreementContentSchema。
 */
export function mergeContentInput(prev: AgreementContent | null, input: AgreementSubmitInput): AgreementContent {
  if (prev === null) {
    const missing = CONTENT_FIELDS.filter(name => input[name] === undefined);
    if (missing.length > 0) throw new Error(`新建约定必须一次给全七项内容，缺少：${missing.join('、')}`);
  }
  const pending: PendingItem[] = input.pending !== undefined
    ? input.pending.map(item => ({ ...item, options: [...item.options], chosen: null }))
    : (prev as AgreementContent).pending.map(item => ({ ...item, options: [...item.options], chosen: null }));
  const decided: DecidedItem[] = input.decided !== undefined
    ? input.decided.map(item => ({ text: item.text, basis: { kind: item.basis.kind, ref: item.basis.ref ?? null, refText: null } }))
    : (prev as AgreementContent).decided.map(item => ({ text: item.text, basis: { ...item.basis } }));
  return {
    summary: input.summary ?? (prev as AgreementContent).summary,
    sketch: input.sketch ?? (prev as AgreementContent).sketch,
    pending,
    decided,
    scopeIn: input.scopeIn ?? (prev as AgreementContent).scopeIn,
    scopeOut: input.scopeOut ?? (prev as AgreementContent).scopeOut,
    doneWhen: input.doneWhen ?? (prev as AgreementContent).doneWhen,
    // P74r9：对外发布项：新建不写按 null；修订不写沿用上一版（旧数据没有这一项也按 null），写 null 去掉，写对象设定。
    // P74r10：提交的 how 先去掉首尾空白和末尾的标点再存；去掉之后为空按现有规则拒绝。
    launch: input.launch !== undefined ? normalizeLaunchInput(input.launch) : launchOf(prev ?? { launch: null }),
  };
}

/**
 * key 兜底匹配：模型修订时有时会给同一个问题换个 key，导致「改了」被看成「删一个加一个」。
 * next 里某项的 key 在 prev 里不存在、但它的 question 原文与 prev 里某个「key 不在 next 里」的项完全相同，
 * 就把这一项的 key 改回 prev 的 key。一个 prev 项最多被认领一次。返回新数组，不改入参。
 */
export function alignPendingKeys<T extends { key: string; question: string }>(prev: readonly T[], next: readonly T[]): T[] {
  const prevKeys = new Set(prev.map(item => item.key));
  const nextKeys = new Set(next.map(item => item.key));
  const claimed = new Set<string>();
  return next.map(item => {
    if (prevKeys.has(item.key)) return item;
    const match = prev.find(old => !nextKeys.has(old.key) && !claimed.has(old.key) && old.question === item.question);
    if (!match) return item;
    claimed.add(match.key);
    return { ...item, key: match.key };
  });
}

/** 键顺序固定的 JSON，比较两个对象是否一样时不受键顺序影响。 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 按序号比较两个列表：同序号不同记 changed，next 多出的记 added，prev 多出的记 removed。
 * P72h：条数减少时，上一版有、这一版按原文（ident）找不到的每一条都记一个带原文的 removed 标记（index 是它在上一版的序号），
 * 数量与「要求声明的条目」完全一致；既改写又删除时也不会少列。条数没有减少时不记 removed，由 changed、added 显示。
 */
function diffByIndex<T>(
  section: ChangeMark['section'], prev: readonly T[], next: readonly T[], same: (a: T, b: T) => boolean,
  ident: (item: T) => string, marks: ChangeMark[],
): void {
  const max = Math.max(prev.length, next.length);
  for (let index = 0; index < max; index += 1) {
    if (index >= prev.length) marks.push({ section, kind: 'added', index });
    else if (index < next.length && !same(prev[index]!, next[index]!)) marks.push({ section, kind: 'changed', index });
  }
  if (next.length < prev.length) {
    const kept = new Set(next.map(ident));
    prev.forEach((old, index) => {
      if (!kept.has(ident(old))) marks.push({ section, kind: 'removed', index, text: ident(old) });
    });
  }
}

/**
 * 版本对比：中心算出「这一版比上一版改了什么」，不由模型自己报。
 * summary、sketch 整体比；pending 按 key 比；decided、scopeIn、scopeOut、doneWhen 按序号比。prev 为 null 返回空数组。
 */
export function diffContent(prev: AgreementContent | null, next: AgreementContent): ChangeMark[] {
  if (prev === null) return [];
  const marks: ChangeMark[] = [];
  if (prev.summary !== next.summary) marks.push({ section: 'summary', kind: 'changed' });
  if (stable(prev.sketch) !== stable(next.sketch)) marks.push({ section: 'sketch', kind: 'changed' });
  // 待定项按 key 比：先看 next（新增、改动），再看 prev 里被删掉的。
  for (const item of next.pending) {
    const old = prev.pending.find(row => row.key === item.key);
    if (!old) marks.push({ section: 'pending', kind: 'added', key: item.key });
    else if (old.question !== item.question || old.suggested !== item.suggested || old.reason !== item.reason
      || stable(old.options) !== stable(item.options)) marks.push({ section: 'pending', kind: 'changed', key: item.key });
  }
  for (const old of prev.pending) {
    // P72h：待定项被删时把问题原文记下来，界面写「删去：某某」。
    if (!next.pending.some(row => row.key === old.key)) marks.push({ section: 'pending', kind: 'removed', key: old.key, text: old.question });
  }
  diffByIndex('decided', prev.decided, next.decided,
    (a, b) => a.text === b.text && a.basis.kind === b.basis.kind && a.basis.ref === b.basis.ref, item => item.text, marks);
  for (const section of ['scopeIn', 'scopeOut', 'doneWhen'] as const) {
    diffByIndex<string>(section, prev[section], next[section], (a, b) => a === b, item => item, marks);
  }
  // P74r9：对外发布项：没有变 -> 不标；原来没有、现在有 -> added；两边都有但写法不同 -> changed；原来有、现在去掉 -> removed。
  const before = launchOf(prev);
  const after = launchOf(next);
  if (before === null && after !== null) marks.push({ section: 'launch', kind: 'added' });
  else if (before !== null && after === null) marks.push({ section: 'launch', kind: 'removed' });
  // P81：发布位置（localDir）变了同样记为 changed（与改发布方式同一做法）；没有这一项按 undefined 比较。
  else if (before !== null && after !== null && (before.how !== after.how || before.localDir !== after.localDir)) marks.push({ section: 'launch', kind: 'changed' });
  return marks;
}

// ---------------------------------------------------------------------------
// P72h H1：修订时不能悄悄丢条目
// ---------------------------------------------------------------------------

/** 五个列表区块的中文名（错误提示和「删去」说明用）。 */
const LIST_SECTION_LABELS = { pending: '待定项', decided: '我已定的', scopeIn: '这次做', scopeOut: '这次不做', doneWhen: '怎样算做完' } as const;
type ListSection = keyof typeof LIST_SECTION_LABELS;

/** 一个「这一版没有、上一版有」的条目：id 是写进 removals 的标识（待定项为 key，其余为原文），label 是给人看的原文。 */
export interface DroppedItem { section: ListSection; id: string; label: string }

/**
 * 找出本次提交丢掉的条目。只看提交里「传了」的区块（没传的整段沿用上一版，不可能丢）；
 * 按原文认的四段：传了、且条数比上一版少时，上一版有、这一版找不到的每一条都算丢（同条数的改写算「改动」，不要求声明）。
 * 待定项按 key 认（调用方应先做过 key 兜底对齐），不论条数有没有减少。
 * 这个结果与 diffContent 记下的 removed 标记一一对应。
 */
export function findDroppedItems(prev: AgreementContent, next: AgreementContent, provided: Record<ListSection, boolean>): DroppedItem[] {
  const dropped: DroppedItem[] = [];
  // 待定项按 key 认：上一版的 key 在这一版没有了就是删除，不论条数有没有减少（换题也算删旧题）。
  if (provided.pending) {
    for (const old of prev.pending) {
      if (!next.pending.some(row => row.key === old.key)) dropped.push({ section: 'pending', id: old.key, label: old.question });
    }
  }
  if (provided.decided && next.decided.length < prev.decided.length) {
    for (const old of prev.decided) {
      if (!next.decided.some(row => row.text === old.text)) dropped.push({ section: 'decided', id: old.text, label: old.text });
    }
  }
  for (const section of ['scopeIn', 'scopeOut', 'doneWhen'] as const) {
    if (!provided[section] || next[section].length >= prev[section].length) continue;
    for (const old of prev[section]) {
      if (!next[section].includes(old)) dropped.push({ section, id: old, label: old });
    }
  }
  return dropped;
}

/**
 * 校验「有意删除」的声明：丢掉的条目必须逐条出现在 removals 里，removals 里写的也必须真的是被删的条目。
 * 通过返回 void；不通过抛出中文错误，文字里列出少了哪几条，并说明怎么改正。
 * 待定项在 removals 里可以写 key，也可以写问题原文。
 */
export function assertRemovalsDeclared(dropped: readonly DroppedItem[], removals: readonly string[] | undefined): void {
  const declared = removals ?? [];
  const isDeclared = (item: DroppedItem) => declared.includes(item.id) || declared.includes(item.label);
  const missing = dropped.filter(item => !isDeclared(item));
  if (missing.length > 0) {
    const parts = (Object.keys(LIST_SECTION_LABELS) as ListSection[]).flatMap(section => {
      const rows = missing.filter(item => item.section === section);
      if (rows.length === 0) return [];
      const names = rows.map(row => `「${row.label}」`).join('');
      // 不写「少了 N 条」：既改写又删除时 N 会大于实际减少的条数。
      return [section === 'pending'
        // 待定项不写「少了」：换题时条数并没有减少；也不用「项目」一词，避免和产品里的「项目」混淆。
        ? `「${LIST_SECTION_LABELS[section]}」里，上一版的这几项在这一版里没有了：${names}`
        : `「${LIST_SECTION_LABELS[section]}」比上一版少了条目，上一版的这几条在这一版里找不到：${names}`];
    });
    throw new Error(`${parts.join('。')}。没改的条目要原样带上；确实要删除时，在 removals 里逐条写明（待定项写 key）。这次提交没有生成新版本，请改正后重新提交`);
  }
  const unknown = declared.filter(name => !dropped.some(item => item.id === name || item.label === name));
  if (unknown.length > 0) {
    throw new Error(`removals：「${unknown.join('」「')}」不是这一版删去的条目，可能的原因：上一版里没有它；这一版里仍然带着它；它所在的那一段条数没有减少（把一条换成另一条属于改写，不需要声明）。请核对原文，没有要删的条目就不要填 removals`);
  }
}

/**
 * 默契度：主人第一次确认时，总管的建议被原样采纳了几项。
 * 某项算采纳，当且仅当：第 1 版里有同 key 的项、两版的建议原文相同、且最终选择等于建议。
 * total 是最终版待定项的总数。
 */
export function computeAdoption(first: AgreementContent, locked: AgreementContent): { adopted: number; total: number } {
  let adopted = 0;
  for (const item of locked.pending) {
    const origin = first.pending.find(row => row.key === item.key);
    if (origin && origin.suggested === item.suggested && item.chosen === item.suggested) adopted += 1;
  }
  return { adopted, total: locked.pending.length };
}

/**
 * 把主人的选择写进内容：choices 的 key 必须都存在、值必须在该项选项里；没给的项取建议。
 * 返回新对象，不改入参。
 */
export function applyChoices(content: AgreementContent, choices: Record<string, string>): AgreementContent {
  for (const [key, value] of Object.entries(choices)) {
    const item = content.pending.find(row => row.key === key);
    if (!item) throw new Error(`choices.${key}：没有这个待定项`);
    if (!item.options.includes(value)) throw new Error(`choices.${key}：「${value}」不是这一项的选项之一`);
  }
  return {
    ...content,
    pending: content.pending.map(item => ({ ...item, options: [...item.options], chosen: choices[item.key] ?? item.suggested })),
  };
}

// ---------------------------------------------------------------------------
// 依据解析（读存储，不写）
// ---------------------------------------------------------------------------

/** 按完整字符截取，不把一个汉字切成两半。 */
function clip(value: string, max: number): string {
  return [...value].slice(0, max).join('');
}

/**
 * 把提交里的依据解析成存储形态：source 的出处必须真实存在，出处原文由中心读出。
 * - mem_ 开头：必须是生效中的记忆；记忆限定了项目时，这份约定所在的项目必须在名单里（P75r1，M3）；
 * - ru_ 开头（P75r1）：先找 legacyRuleId 等于它的生效记忆，找到就把出处改写成那条记忆的编号；
 *   找不到、且旧规矩表仍要读（迁移未完成）、这条旧规矩生效并作用于全队或总管时，按旧规矩处理；都不成立报「找不到出处」；
 * - dc_ 开头：必须是总管作为成员的某个未归档项目里 context.decisions 的决策；
 * - 其他 kind：不得带 ref，refText 为 null。
 * agreementProjectId：这份约定所在的项目（新建且没指定项目时为 null）。员工范围不在这里核对（对齐时还不知道由谁做），由总管按行尾后缀判断。
 */
export function resolveBasis(ctx: HubContext, chiefId: string, decided: readonly DecidedInput[],
  agreementProjectId: string | null = null): DecidedItem[] {
  return decided.map((item, i) => {
    const { kind, ref } = item.basis;
    const at = `decided[${i}].basis.ref`;
    if (kind !== 'source') {
      if (ref !== undefined) throw new Error(`${at}：只有 source 才填出处`);
      return { text: item.text, basis: { kind, ref: null, refText: null } };
    }
    const notFound = (what: string) => new Error(`${at}：找不到出处 ${what}；查不到出处就把 kind 写成 judgement（显示为「我的判断」）`);
    if (ref === undefined || ref.trim() === '') throw notFound('（没有填）');
    let refText: string | null = null;
    let finalRef = ref;
    // 记忆限定了项目、而这份约定不在这些项目里时拒绝（这份约定不属于任何项目时，带项目范围的记忆一律不能引用）。
    const checkProjectScope = (memory: Memory): void => {
      if (memory.scope.projects === 'all' || (agreementProjectId !== null && memory.scope.projects.includes(agreementProjectId))) return;
      const names = memory.scope.projects.map(id => ctx.store.table('projects').get(id)?.name ?? '已删除的项目');
      throw new Error(`${at}：这一条只用于「${names.join('、')}」，这份约定不在这些项目里，不能引用；查不到合适的出处就把 kind 写成 judgement`);
    };
    if (ref.startsWith('mem_')) {
      // P75d：记忆（规矩、偏好、先例）：必须是生效中的，出处原文取记忆的文字。
      const memory = ctx.store.table('memories').get(ref);
      if (memory && memory.status === 'active') { checkProjectScope(memory); refText = clip(memory.text, D.REF_TEXT_MAX_CHARS); }
    } else if (ref.startsWith('ru_')) {
      // P75r1：先按 legacyRuleId 找对应的生效记忆，把出处改写成那条记忆的编号。
      const memory = ctx.store.table('memories').list(row => row.status === 'active' && row.source.legacyRuleId === ref)[0];
      if (memory) {
        checkProjectScope(memory);
        refText = clip(memory.text, D.REF_TEXT_MAX_CHARS);
        finalRef = memory.id;
      } else if (legacyRulesOf(ctx, { id: chiefId }).some(rule => rule.id === ref)) {
        // 找不到对应记忆：迁移未完成时按旧规矩处理（旧规矩必须生效、作用于全队或总管；已经有对应记忆的不再按旧规矩引用，
        // 与「可引用的出处」列表一致，避免主人删掉记忆后旧规矩又能被引用）。
        refText = clip(ctx.store.table('rules').get(ref)!.text, D.REF_TEXT_MAX_CHARS);
      }
    } else if (ref.startsWith('dc_')) {
      const projects = ctx.store.table('projects').list(p => p.archivedAt === null && p.status !== 'archived' && p.memberBotIds.includes(chiefId));
      for (const project of projects) {
        const decision = project.context.decisions.find(row => row.id === ref);
        if (decision) { refText = clip(decision.text, D.REF_TEXT_MAX_CHARS); break; }
      }
    }
    if (refText === null) throw notFound(ref);
    return { text: item.text, basis: { kind, ref: finalRef, refText } };
  });
}
