/**
 * 工具 hub_job_manage（P74b 起）：总管管理「一件事」。
 * P74b：assign（派活）、reassign（改派）；P74e：answer（按约定回答问题）、forward（转交主人的材料）、
 * stop（主人确认不做之后停止）、resume（主人让先停下的事接着做）。其余 mode（返工、说明做不下去）由后面的卡加入。
 *
 * 工具层只做三件事：解析参数、检查「字段是否属于这个 mode」（放错 mode 的字段直接报错，不悄悄忽略，
 * 否则模型会以为自己写的内容生效了）、按 mode 调用 job/ 下的服务。身份（只有总管）、回合（有的必须由主人发起）、
 * 约定与员工的校验都在服务层，这里不重复判断。工具注册给所有员工，非总管调用时在服务层被拒绝
 * （与 hub_agreement_submit、hub_team_propose 同一做法）。复盘回合禁止调用：在 tools/common.ts 的 reflectionWrites 里登记。
 *
 * 参数是平铺对象、根节点不用联合类型（tools/json-schema.ts 的要求）；各 mode 的必填项在服务层按 mode 校验，缺几项一次列全。
 * 指人一律写名字或机器人 id。
 */
import { z } from 'zod';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import { runJobAnswer } from '../job/answer.js';
import { BASIS_SECTIONS, type BasisArg } from '../job/answer-basis.js';
import { runJobAssign, type JobManageArgs } from '../job/assign.js';
import { runJobReassign } from '../job/reassign.js';
import { runJobForward } from '../job/forward.js';
import { runJobResume, runJobStop } from '../job/stop.js';
import { runJobReopen } from '../job/reopen.js';
import { runJobEscalate } from '../job/escalate.js';
import { recordId } from '../model/primitives.js';
import { FlexibleTimeSchema } from '../commit/schema.js';
import { defineTool } from './common.js';

/** 带长度范围的一段文字：去首尾空白，1 到 max 字（按完整字符计）。 */
function limited(max: number, label: string) {
  return z.string({ error: `${label}：必须是文字` }).trim().min(1, `${label}：不能为空`)
    .refine(value => [...value].length <= max, `${label}：不能超过 ${max} 字`);
}

/** 回答里的一处出处：约定的哪一部分、第几条。原文由中心读出，模型写不进。 */
const BasisArgSchema = z.strictObject({
  section: z.enum([...BASIS_SECTIONS, 'material'], { error: 'section：必须是 summary、pending、decided、scopeIn、scopeOut、doneWhen、material 之一' })
    .describe('约定的哪一部分：summary 一句话（no 写 1，不能作为唯一出处）、pending 待你定、decided 我已定的、scopeIn 这次做、scopeOut 这次不做、doneWhen 怎样算做完；或 material 主人转来的材料（title 写材料的标题，必须是这件事材料文件夹里已有的一份）'),
  no: z.number({ error: 'no：必须是整数' }).int('no：必须是整数').min(1, 'no：从 1 起').optional()
    .describe('约定条目的出处必填：这一部分里的第几条，从 1 起，序号见唤醒包「你手上的事」里列出的约定各部分；section 为 material 时不写'),
  title: z.string({ error: 'title：必须是文字' }).trim().min(1, 'title：不能为空').optional()
    .describe('section 为 material 时必填：材料的标题；其他 section 不写'),
}).superRefine((value, ctx) => {
  // 材料出处要标题、不要序号；约定条目的出处要序号、不要标题（一次列全，让模型一次改对）。
  if (value.section === 'material') {
    if (value.title === undefined) ctx.addIssue({ code: 'custom', message: 'title：section 为 material 时必须写材料的标题', path: ['title'] });
    if (value.no !== undefined) ctx.addIssue({ code: 'custom', message: 'no：section 为 material 时不写序号', path: ['no'] });
  } else {
    if (value.no === undefined) ctx.addIssue({ code: 'custom', message: 'no：约定条目的出处必须写序号', path: ['no'] });
    if (value.title !== undefined) ctx.addIssue({ code: 'custom', message: 'title：只有 section 为 material 时才写标题', path: ['title'] });
  }
});

/** 把校验过的出处参数换成服务层的类型（superRefine 已保证字段齐全）。 */
function toBasisArgs(basis: Array<z.infer<typeof BasisArgSchema>> | undefined): BasisArg[] | undefined {
  return basis?.map((item): BasisArg => item.section === 'material' ? { section: 'material', title: item.title! } : { section: item.section, no: item.no! });
}

export const HubJobManageInputSchema = z.strictObject({
  mode: z.enum(['assign', 'reassign', 'answer', 'forward', 'stop', 'resume', 'reopen', 'escalate'],
    { error: 'mode：必须是 assign、reassign、answer、forward、stop、resume、reopen、escalate 之一' })
    .describe('assign 把已固定的约定交给一位执行者；reassign 把进行中的事换一位执行者，或换一位核对人（executor、reviewer 至少写一个）；answer 按约定回答执行者或核对人的问题；forward 把主人发来的材料存为主题文件交给执行者；stop 主人在这一回合直接说了不做之后停止这件事；resume 主人已暂停的事接着做，或主人已为这次受阻（核对三轮不过、执行者做不下去）选了不带改动的办法、你不换人而照办法接着做（核对三轮不过的，从新的一个阶段、新的三轮算起）；reopen 主人验收时指出某几条不符，对到条目退回返工；escalate 核对三轮仍不过、或执行者做不下去且你解决不了时，向主人说明卡在哪并给出两三个办法'),
  agreementId: recordId('agr').optional()
    .describe('assign 必填：要派活的约定编号（唤醒包「刚由主人确认」那一行、「已固定」那一行里有）'),
  jobId: recordId('job').optional().describe('reassign、answer、forward、stop、resume 必填：这件事的编号（报错和唤醒包里会列出你手上的事）'),
  executor: limited(40, 'executor').optional()
    .describe('assign 必填：执行者，写在岗员工的名字（唤醒包「当前在岗的员工」里有）或机器人 id；reassign 时写新执行者，要换执行者才写（executor、reviewer 至少写一个）'),
  reviewer: limited(40, 'reviewer').optional()
    .describe('assign 可选：核对人，写评审员的名字或机器人 id；由你自己核对时写「总管」，省略等于「总管」；reassign 时写新核对人（写「总管」表示改由你自己核对），要换核对人才写'),
  dueAt: FlexibleTimeSchema.optional()
    .describe('assign 必填：交付时间，写约定里的交付时间，格式 YYYY-MM-DD HH:mm（北京时间）或带时区的 ISO 时间，必须晚于现在'),
  deliveryItems: z.array(z.number({ error: 'deliveryItems：必须是整数' }).int('deliveryItems：必须是整数')).optional()
    .describe('assign 可选：「怎样算做完」里写了交付时间的那一条的序号（从 1 起，唤醒包里逐条编了号），最多 2 条、原文里必须写了时间；通常只有一条，没有就不填；其余条目都要有证据并经过核对'),
  launchStep: z.boolean({ error: 'launchStep：必须是 true 或 false' }).optional()
    .describe('不用填：这件事有没有发布这一步，由约定里的对外发布一项（launch）决定；填了而与约定不一致会被拒绝'),
  note: limited(200, 'note').optional().describe('assign 可选：给执行者的一句交代，不超过 200 字'),
  to: limited(40, 'to').optional()
    .describe('answer 可选：收件人，写提问人的名字或机器人 id；省略时等于提问人，没有提问时等于执行者'),
  text: limited(D.FORWARD_TEXT_MAX_CHARS, 'text').optional()
    .describe(`answer 必填：答案本身，不超过 ${D.ANSWER_MAX_CHARS} 字，不要自己写「依据」（依据由中心从约定里读出附在后面）；forward 必填：主人发来的材料原文，不超过 ${D.FORWARD_TEXT_MAX_CHARS} 字`),
  basis: z.array(BasisArgSchema).min(1, 'basis：至少 1 处').max(D.BASIS_MAX, `basis：最多 ${D.BASIS_MAX} 处`).optional()
    .describe(`answer 必填：答案依据约定的哪几处（1 到 ${D.BASIS_MAX} 处，section 加 no）；必须是约定里真实存在的条目，推不出答案时不能用 answer`),
  title: limited(D.FORWARD_TITLE_MAX_CHARS, 'title').optional()
    .describe(`forward 必填：材料的标题，不超过 ${D.FORWARD_TITLE_MAX_CHARS} 字，只能写汉字、字母、数字、空格、连字符、下划线；会成为主题文件夹里「材料」下的文件名`),
  reason: limited(D.NOTE_MAX_CHARS, 'reason').optional()
    .describe(`stop 必填：停止的原因，写你说了什么（这句话会显示给主人看，称呼写「你」，不写「主人」），不超过 ${D.NOTE_MAX_CHARS} 字；escalate 必填：建议这个办法的理由（称呼写「你」），不超过 ${D.ESCALATE_REASON_MAX_CHARS} 字`),
  stuckAt: limited(D.NOTE_MAX_CHARS, 'stuckAt').optional()
    .describe(`escalate 必填：用白话写卡在哪（不写技术名词、不写工具名和编号），不超过 ${D.NOTE_MAX_CHARS} 字`),
  options: z.array(z.strictObject({
    title: limited(D.OPTION_TITLE_MAX_CHARS, 'options.title').describe(`办法的标题，不超过 ${D.OPTION_TITLE_MAX_CHARS} 字，各办法不重复`),
    detail: limited(D.OPTION_DETAIL_MAX_CHARS, 'options.detail').describe(`办法的做法和代价，不超过 ${D.OPTION_DETAIL_MAX_CHARS} 字`),
    change: z.strictObject({
      no: z.number({ error: 'options.change.no：必须是整数' }).int('options.change.no：必须是整数').min(1, 'options.change.no：从 1 起'),
      text: z.string({ error: 'options.change.text：必须是文字或 null' }).trim().min(1, 'options.change.text：不能为空，删去这一条写 null').max(100, 'options.change.text：不能超过 100 字').nullable(),
    }).optional().describe('选了这个办法就要改某一条「怎样算做完」时写：no 是那一条的序号（唤醒包里列了），text 是改后的原文，删去这一条写 null；主人选了它，中心直接记为约定新的一版，不再请主人确认'),
    followUp: z.boolean({ error: 'options.followUp：必须是 true 或 false' }).optional().describe('改约定之外，选了这个办法还要你做后续安排时写 true（主人选了之后会叫醒你）'),
  }), { error: 'options：必须是数组' }).min(D.OPTIONS_MIN, `options：至少 ${D.OPTIONS_MIN} 个办法`).max(D.OPTIONS_MAX, `options：最多 ${D.OPTIONS_MAX} 个办法`).optional()
    .describe(`escalate 必填：${D.OPTIONS_MIN} 到 ${D.OPTIONS_MAX} 个办法，每个写 title、detail，可带 change、followUp`),
  suggested: z.number({ error: 'suggested：必须是整数' }).int('suggested：必须是整数').min(0, 'suggested：从 0 起').optional()
    .describe('escalate 必填：建议第几个办法，从 0 起数'),
  items: z.array(z.strictObject({
    no: z.number({ error: 'items.no：必须是整数' }).int('items.no：必须是整数').min(1, 'items.no：从 1 起'),
    problem: limited(D.NOTE_MAX_CHARS, 'items.problem'),
    fixTo: limited(D.NOTE_MAX_CHARS, 'items.fixTo'),
  }), { error: 'items：必须是数组' }).min(1, 'items：至少 1 条').max(D.REOPEN_ITEMS_MAX, `items：最多 ${D.REOPEN_ITEMS_MAX} 条`).optional()
    .describe(`reopen 必填：主人指出不符的条目（1 到 ${D.REOPEN_ITEMS_MAX} 条）：no 是「怎样算做完」的序号，problem 写你说的问题，fixTo 写改到什么程度算过（写成一句可以验证的话）；这两句会显示给主人看，称呼写「你」，不写「主人」`),
  missed: limited(D.NOTE_MAX_CHARS, 'missed').optional()
    .describe(`reopen 必填：核对为什么漏了这个问题、这次怎么补，不超过 ${D.NOTE_MAX_CHARS} 字`),
});
type Args = z.infer<typeof HubJobManageInputSchema>;

/** 工具说明：模型看到的全部使用规则。 */
const DESCRIPTION = '（仅总管）管理一件事。约定固定后，用 mode assign 把这件事交给一位执行者：agreementId 写约定编号；指人（executor、reviewer）写员工名字或机器人 id；reviewer 写评审员的名字，由你自己核对时写「总管」；dueAt 写约定里的交付时间；deliveryItems 写「怎样算做完」里写了交付时间的那一条的序号（通常只有一条，没有就不写；其余条目都要有证据并经过核对）；launchStep 不用填：这件事验收之后有没有对外发布这一步，由约定里的对外发布一项（launch）决定。派活后中心会把主人的原话、草图和约定作为文件交给执行者，叫醒执行者，并在主题里告诉主人谁执行、谁核对。只能在主人发话、确认或回答叫醒的回合里使用；约定还在等主人确认时不能派活。要换人用 mode reassign：jobId 写事的编号，换执行者写 executor（新执行者），换核对人写 reviewer（新核对人，写「总管」表示由你自己核对），可以只写一个，也可以两个都写；被换下的人的未回答提问随之作废。'
  + `执行者或核对人问你问题、约定能推出答案时，用 mode answer：jobId 写事的编号，to 写提问人名字，text 写答案，basis 写出处（section 加 no，序号见唤醒包里约定各部分的编号）；出处由中心从约定里读出原文附在答案后面，你写不出约定里真实存在的出处，就说明约定推不出答案，不能用 answer，要改约定或向主人说明。主人转来的材料也能当出处（section 写 material，title 写材料的标题，标题必须是这件事材料文件夹里已有的一份，唤醒包里列了现有的材料）；不能只引用「一句话」（summary）。主人发来与这件事有关的材料（只在主人发起的回合里）：mode forward，jobId、title（材料名，汉字字母数字空格连字符下划线）、text（原文）；中心存成主题文件夹里的文件交给执行者，不要自己转述；这件事已交付在等主人验收时不能转交。主人在这一回合的原话里直接说这件事不做了：mode stop，jobId 加 reason（写主人说了什么）；这一回合若是主人说「定了」或确认了某一版叫醒的、或在派活之前，会被拒绝；主人还没拿定、要他确认的，用 hub_agreement_submit 的 mode revise 并写 stopsJob，主人确认后中心直接停下这件事。主人已暂停的事要接着做，或主人已为这次受阻选了不带改动的办法、你不换人而照办法接着做：mode resume，jobId。stop 和 resume 都只能在主人发起的回合里使用。交付和验收由中心完成，不用你说话；主人验收时指出某几条不符：mode reopen，jobId、items（no 写序号，problem 写主人说的问题，fixTo 写改到什么程度算过）、missed（核对为什么漏了、这次怎么补），只在主人发起的回合、这件事在等主人验收时可用；主人说的问题不在约定里、是新要求的，不用 reopen。核对三轮仍不过、或执行者做不下去而你解决不了：mode escalate，jobId、stuckAt（白话写卡在哪）、options（2 到 3 个办法，每个写 title、detail；选了就要改某条「怎样算做完」的写 change，no 加改后的 text，删去写 null；改约定之外还要你做后续安排的写 followUp: true）、suggested（建议第几个，从 0 起）、reason（建议的理由）；主人选一个之后由中心执行，需要你做后续安排时会叫醒你。`;

/** 每个 mode 里不用的字段：出现就报错。assign、reassign 保持 P74b 的宽松做法（只检查新字段不放错地方）。 */
const NEW_FIELDS = ['to', 'text', 'basis', 'title', 'reason', 'items', 'missed', 'stuckAt', 'options', 'suggested'] as const;
const OLD_FIELDS = ['agreementId', 'executor', 'reviewer', 'dueAt', 'deliveryItems', 'launchStep', 'note'] as const;
const MODE_FIELDS: Record<Args['mode'], readonly string[]> = {
  assign: [], reassign: [],
  answer: ['jobId', 'to', 'text', 'basis'],
  forward: ['jobId', 'title', 'text'],
  stop: ['jobId', 'reason'],
  resume: ['jobId'],
  reopen: ['jobId', 'items', 'missed'],
  escalate: ['jobId', 'stuckAt', 'options', 'suggested', 'reason'],
};

/** 字段放错 mode 的报错；没有问题返回 null。 */
function misplacedFields(args: Args): string | null {
  const allowed = MODE_FIELDS[args.mode];
  const keys = args.mode === 'assign' || args.mode === 'reassign' ? NEW_FIELDS : [...NEW_FIELDS, ...OLD_FIELDS];
  const stray = keys.filter(key => args[key] !== undefined && !allowed.includes(key));
  return stray.length === 0 ? null : `mode 为 ${args.mode} 时不用这些字段：${stray.join('、')}`;
}

export const hubJobManage = defineTool('hub_job_manage', DESCRIPTION, HubJobManageInputSchema, 'L1', async (ctx, tc, args) => {
  const misplaced = misplacedFields(args);
  if (misplaced !== null) throw new Error(misplaced);
  const input: JobManageArgs = { ...args, basis: toBasisArgs(args.basis) };
  switch (args.mode) {
    case 'assign': return { ok: true, text: await runJobAssign(ctx, tc, input) };
    case 'reassign': return { ok: true, text: await runJobReassign(ctx, tc, input) };
    case 'answer': return { ok: true, text: await runJobAnswer(ctx, tc, input) };
    case 'forward': return { ok: true, text: await runJobForward(ctx, tc, input) };
    case 'stop': return { ok: true, text: await runJobStop(ctx, tc, input) };
    case 'resume': return { ok: true, text: await runJobResume(ctx, tc, input) };
    case 'reopen': return { ok: true, text: await runJobReopen(ctx, tc, input) };
    case 'escalate': return { ok: true, text: await runJobEscalate(ctx, tc, input) };
  }
});
