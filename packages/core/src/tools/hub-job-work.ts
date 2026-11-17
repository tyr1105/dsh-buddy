/**
 * 工具 hub_job_work（P74d）：一件事的执行者和核对人用它提问、交回、核对、说明做不下去。
 *
 * 五个 mode（launched 在 P74g 加入）：
 * - ask：执行者或核对人问总管一个问题；
 * - submit：执行者交回，按「怎样算做完」逐条附证据，中心机械检查证据；
 * - review：核对人逐条给结论，通过、退回或三轮不过由中心按规则决定；
 * - block：执行者说明做不下去，叫总管；
 * - launched：主人批准发布之后，执行者回报发布后的地址（见 job/launched.ts）。
 *
 * 工具层只做三件事：解析参数、检查「字段是否属于这个 mode」、按 mode 调用 job/work.ts 或 job/review.ts。
 * 身份（谁能调用哪个 mode）、状态、证据、轮次都在服务层。参数是平铺对象、根节点不用联合类型（tools/json-schema.ts 的要求）；
 * 各 mode 的必填项在服务层按 mode 校验，缺几项一次列全。字段放错 mode（例如交回时写了 verdict）直接报错，
 * 不悄悄忽略：悄悄忽略会让模型以为自己写的内容生效了。
 * 复盘回合禁止调用：在 tools/common.ts 的 reflectionWrites 里登记。等级 L1。
 */
import { z } from 'zod';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import { runJobReview } from '../job/review.js';
import { runJobLaunched } from '../job/launched.js';
import { runJobAsk, runJobBlock, runJobSubmit } from '../job/work.js';
import { recordId } from '../model/primitives.js';
import { defineTool } from './common.js';

/** 带长度范围的一段文字：去首尾空白，1 到 max 字（按完整字符计）。 */
function limited(max: number, label: string) {
  return z.string({ error: `${label}：必须是文字` }).trim().min(1, `${label}：不能为空`)
    .refine(value => [...value].length <= max, `${label}：不能超过 ${max} 字`);
}

/** 整数序号（从 1 起）。 */
const itemNo = z.number({ error: 'no：必须是整数' }).int('no：必须是整数').min(1, 'no：从 1 起');

/** 一项证据（submit 用）。 */
const EvidenceArgSchema = z.strictObject({
  kind: z.enum(['file', 'image', 'test', 'link'], { error: 'kind：必须是 file、image、test、link 之一' })
    .describe('证据类型：file 文件、image 截图、test 测试结果（一句话）、link 链接'),
  path: limited(300, 'path').optional().describe('file、image 必填：主题文件夹里的相对路径，例如 证据/手机.png、交付/报价页.html'),
  url: limited(500, 'url').optional().describe('link 必填：以 http:// 或 https:// 开头的网址'),
  summary: limited(D.EVIDENCE_SUMMARY_MAX_CHARS, 'summary').describe(`每项证据都要写：一句话说明，不超过 ${D.EVIDENCE_SUMMARY_MAX_CHARS} 字；test 写测试做了什么、结果如何`),
  command: limited(D.EVIDENCE_COMMAND_MAX_CHARS, 'command').optional().describe('仅 test 可选：核对人复跑用的命令（中心不执行）'),
});

/** 一条（submit 的自查，或 review 的结论）。 */
const ItemArgSchema = z.strictObject({
  no: itemNo.describe('条目序号，从 1 起，与唤醒包里「怎样算做完」的编号一致'),
  selfCheck: z.enum(['met', 'not_met', 'at_delivery'], { error: 'selfCheck：必须是 met、not_met、at_delivery 之一' }).optional()
    .describe('submit 用：met 符合（至少附一项证据）、not_met 不符（必须写 note）、at_delivery 交付时核对（只用于交付时核对的条目，不附证据）'),
  verdict: z.enum(['met', 'unmet', 'at_delivery'], { error: 'verdict：必须是 met、unmet、at_delivery 之一' }).optional()
    .describe('review 用：met 符合、unmet 不符（必须写 note 和 fixTo）、at_delivery 交付时核对（只用于交付时核对的条目）'),
  note: limited(D.NOTE_MAX_CHARS, 'note').optional().describe(`submit：自查不符时必写，说明哪里没做到；review：不符时必写问题是什么，符合时可写你复查了什么，不超过 ${D.NOTE_MAX_CHARS} 字`),
  fixTo: limited(D.NOTE_MAX_CHARS, 'fixTo').optional().describe('review 的 unmet 必写：改到什么程度算过，写成一句可以验证的话'),
  rechecked: z.boolean({ error: 'rechecked：必须是 true 或 false' }).optional().describe('review 可选：你是否自己复查过这一条'),
  evidence: z.array(EvidenceArgSchema).max(20, 'evidence：最多 20 项').optional()
    .describe(`submit 用：这一条的证据，每条符合的条目至少 1 项、至多 ${D.EVIDENCE_PER_ITEM_MAX} 项`),
});

export const HubJobWorkInputSchema = z.strictObject({
  mode: z.enum(['ask', 'submit', 'review', 'block', 'launched'], { error: 'mode：必须是 ask（提问）、submit（交回）、review（核对）、block（做不下去）、launched（已发布）之一' })
    .describe('ask 问总管一个问题；submit 执行者交回；review 核对人提交核对结论；block 执行者说明做不下去；launched 执行者回报已发布并写发布后的地址'),
  jobId: recordId('job').describe('这件事的编号，唤醒包「你手上的事」里有'),
  text: limited(D.ASK_MAX_CHARS, 'text').optional().describe(`ask 必填：你的问题，不超过 ${D.ASK_MAX_CHARS} 字`),
  changeNote: limited(D.NOTE_MAX_CHARS, 'changeNote').optional().describe(`submit 必填：这一轮怎么做的、改了什么，不超过 ${D.NOTE_MAX_CHARS} 字`),
  items: z.array(ItemArgSchema).min(1, 'items：至少 1 条').max(30, 'items：最多 30 条').optional()
    .describe('submit、review 必填：逐条写。交回时第一次每一条都要写；返工时被退回的条目必须写，其余可以省略（沿用上一轮结论）'),
  deliverables: z.array(limited(300, 'deliverables')).min(1, 'deliverables：至少 1 项').max(D.DELIVERABLES_MAX, `deliverables：最多 ${D.DELIVERABLES_MAX} 项`).optional()
    .describe('submit 必填：产出物，主题文件夹里的相对路径，例如 交付/报价页.html'),
  preview: limited(500, 'preview').optional().describe('submit 可选：能打开预览的入口，交付/ 下的 html（预览文件放在交付文件夹里，放在别处会被拒），或本机地址（http 或 https，主机只能是 localhost、127.0.0.1、[::1]，不能带用户名密码）'),
  carriedNote: limited(D.CARRIED_NOTE_MAX_CHARS, 'carriedNote').optional().describe(`review 可选：沿用上一轮结论的理由，不超过 ${D.CARRIED_NOTE_MAX_CHARS} 字`),
  spotChecked: z.array(itemNo).max(30, 'spotChecked：最多 30 个').optional().describe('review 可选：抽查了哪几条沿用的条目（序号）'),
  stuckAt: limited(D.NOTE_MAX_CHARS, 'stuckAt').optional().describe(`block 必填：卡在哪，不超过 ${D.NOTE_MAX_CHARS} 字`),
  tried: z.array(limited(D.TRIED_ITEM_MAX_CHARS, 'tried')).min(1, 'tried：至少 1 项').max(D.TRIED_MAX, `tried：最多 ${D.TRIED_MAX} 项`).optional()
    .describe(`block 必填：试过什么办法，1 到 ${D.TRIED_MAX} 项`),
  link: limited(500, 'link').optional().describe('launched 必填：发布后的地址，以 http:// 或 https:// 开头，不超过 500 字'),
});
type Args = z.infer<typeof HubJobWorkInputSchema>;

/** 工具说明：模型看到的全部使用规则。 */
const DESCRIPTION = '这是一件事的执行者和核对人用的工具，jobId 在唤醒包「你手上的事」里。mode 有五个：ask（执行者或核对人问总管一个问题，text 写问题，总管会按约定回答）；submit（执行者交回：changeNote 写这一轮怎么做的，items 按「怎样算做完」逐条写 no、selfCheck 和 evidence，deliverables 写产出物，preview 可选）；review（核对人逐条提交结论：items 写 no、verdict，不符的必须写 note 和 fixTo；可写 carriedNote、spotChecked）；block（执行者做不下去：stuckAt 写卡在哪，tried 写试过什么）；launched（主人批准发布之后，执行者执行完发布，用 link 写发布后的地址）。条目序号 no 从 1 起，与唤醒包里「怎样算做完」的编号一致。路径一律写主题文件夹里的相对路径，例如 交付/报价页.html、证据/手机.png，不能写绝对路径，不能带 ..。每项证据都要写 summary 一句话。中心会检查文件是否真实存在、截图是否真是图片，不执行命令、不打开链接。';

/** 每个 mode 允许出现的字段；出现别的 mode 的字段直接报错。 */
const MODE_FIELDS: Record<Args['mode'], readonly string[]> = {
  ask: ['text'],
  submit: ['changeNote', 'items', 'deliverables', 'preview'],
  review: ['items', 'carriedNote', 'spotChecked'],
  block: ['stuckAt', 'tried'],
  launched: ['link'],
};
/** 每个条目允许的字段（按 mode）。 */
const ITEM_FIELDS = {
  submit: ['no', 'selfCheck', 'note', 'evidence'],
  review: ['no', 'verdict', 'note', 'fixTo', 'rechecked'],
} as const;

/** 字段放错 mode 的报错；没有问题返回 null。 */
function misplacedFields(args: Args): string | null {
  const problems: string[] = [];
  const stray = (['text', 'changeNote', 'items', 'deliverables', 'preview', 'carriedNote', 'spotChecked', 'stuckAt', 'tried', 'link'] as const)
    .filter(key => args[key] !== undefined && !MODE_FIELDS[args.mode].includes(key));
  if (stray.length > 0) problems.push(`mode 为 ${args.mode} 时不用这些字段：${stray.join('、')}`);
  if ((args.mode === 'submit' || args.mode === 'review') && args.items !== undefined) {
    const allowedItemFields: readonly string[] = ITEM_FIELDS[args.mode];
    for (const item of args.items) {
      const wrong = Object.keys(item).filter(key => !allowedItemFields.includes(key));
      if (wrong.length > 0) problems.push(`第 ${item.no} 条：mode 为 ${args.mode} 时条目不用这些字段：${wrong.join('、')}`);
    }
  }
  return problems.length === 0 ? null : problems.join('\n');
}

export const hubJobWork = defineTool('hub_job_work', DESCRIPTION, HubJobWorkInputSchema, 'L1', async (ctx, tc, args) => {
  const misplaced = misplacedFields(args);
  if (misplaced !== null) throw new Error(misplaced);
  switch (args.mode) {
    case 'ask': return { ok: true, text: await runJobAsk(ctx, tc, args) };
    case 'submit': return { ok: true, text: await runJobSubmit(ctx, tc, args) };
    case 'review': return { ok: true, text: await runJobReview(ctx, tc, args) };
    case 'block': return { ok: true, text: await runJobBlock(ctx, tc, args) };
    case 'launched': return { ok: true, text: await runJobLaunched(ctx, tc, args) };
  }
});
