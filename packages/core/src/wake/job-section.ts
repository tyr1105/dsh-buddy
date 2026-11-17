/**
 * 唤醒包「你手上的事（中心维护）」段（P74c，方案 5.3.2、6.3，任务卡 9 节）。
 *
 * 为什么要有这一段：模型要调用 hub_job_work 等工具，必须写对 jobId、约定的条目序号、文件路径。
 * 这些如果只在工具说明里，模型常常凭想象填写（第一块的教训）；由中心把「这件事的编号、约定的条目序号、
 * 现在该做什么、用哪个工具」直接写进唤醒包，模型只用这一段里的文字就能找到这件事并知道下一步。
 *
 * 三种读者三种写法：
 * - 执行者：材料路径、怎样算做完（逐条序号）、这一轮要改的条目、总管的回答、怎样交回；
 * - 核对人：只给约定全文路径、本轮交回的证据清单、上一轮的结论，不给工作往来、主题楼层、提问与回答
 *   （评审员只读约定和证据，不看执行过程）；
 * - 总管：见 job-section-chief.ts。
 *
 * 约定：
 * - 段落 key 为 job，自身上限 JOB_DEFAULTS.PACKET_MAX_BYTES，可截断，不计入原有 6 KB 预算（packet.ts 里与约定段同一做法）；
 *   只在完整唤醒包里出现，轻复查和复盘不出现；
 * - 绝对路径 = 项目文件夹 + 主题文件夹 + 文件名，相对路径写给工具用；
 * - 只读存储和文件列表，不写任何东西；这是给模型看的段落，可以出现工具名和编号。
 */
import { posix } from 'node:path';
import { dueTextOf } from '../api/job-views.js';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { materialTitles } from '../job/answer.js';
import { jobFolderPaths, lockedVersionOf } from '../job/files.js';
import { eventsOf, latestSubmission, reviewsOf } from '../job/store.js';
import { launchOf } from '../model/agreement.js';
import { JOB_STATE_LABELS, type Job, type JobEvent, type JobReview, type JobSubmission } from '../model/job.js';
import type { Bot } from '../model/bot.js';
import type { QueueEntry, WakeTicket } from '../model/wake.js';
import { truncateBytes } from '../util/text.js';
import { chiefChainBody, chiefOverviewDetailed, staffOverviewLine } from './job-section-chief.js';
import { launchApprovalBody, launchPrepareBody, inLaunchSection } from './job-section-launch.js';
import { clipWithEllipsis, fitJobBody, type CompressLevel, type FitResult, type FlexRow, type JobBodyParts } from './job-section-fit.js';

/** 段落的 key 和标题（key 要登记到 packet.ts 的「不计入预算」名单）。 */
export const JOB_SECTION_KEY = 'job';
export const JOB_SECTION_TITLE = '## 你手上的事（中心维护）';

const EVIDENCE_KIND_LABELS = { file: '文件', image: '图片', test: '测试', link: '链接' } as const;

/** P74r18a：执行者、核对人唤醒包里关于「验收之前不发布」的两句（逐字，{发布方式} 为约定里的 launch.how）。 */
export const executorLaunchLine = (how: string): string =>
  `这件事验收之后才对外发布（${how}），由中心在主人批准之后进行。验收之前不要做这一步，也不要把交付物放到发布的位置；交付物只放进这件事的交付文件夹。`;
export const reviewerLaunchLine = (how: string): string =>
  `这件事验收之后才对外发布（${how}）。核对时确认执行者没有提前做这一步；已经提前做了，判不符，并写明要撤回。`;
/** P74r18a：自测的做法（逐字，任何事都写在执行者的唤醒包里）。 */
export const SELF_TEST_LINE = '自测用命令行检查文件内容和脚本输出。不要在主人的电脑上打开浏览器或别的应用，不要启动常驻的本地服务：这些动作要主人批准，会打断他。';

/** 这次唤醒的证据对应的事件（感知的 location 就是事件 id）。 */
function eventsOfWake(ctx: HubContext, job: Job, entry: QueueEntry): JobEvent[] {
  const ids = new Set(entry.reason.evidence.flatMap(id => {
    const location = ctx.store.table('percepts').get(id)?.location;
    return location ? [location] : [];
  }));
  return eventsOf(ctx, job.id).filter(event => ids.has(event.id));
}

/** 事件里的文字字段（没有就为空）。 */
function textOf(event: JobEvent | undefined, key: string): string {
  const value = event?.data[key];
  return typeof value === 'string' ? value : '';
}

/** 回答附带的依据：data.basis 是 [{section, no}]；没有依据返回空字符串。 */
function basisText(event: JobEvent): string {
  const basis = event.data.basis;
  if (!Array.isArray(basis)) return '';
  const rows = basis.flatMap(item => {
    const section = (item as { section?: unknown }).section;
    const no = (item as { no?: unknown }).no;
    const title = (item as { title?: unknown }).title;
    if (section === 'material' && typeof title === 'string') return [`材料「${title}」`];
    return typeof section === 'string' && typeof no === 'number' ? [`${section} ${no}`] : [];
  });
  return rows.length === 0 ? '' : `（依据：${rows.join('、')}）`;
}

/**
 * 回答后面要不要再补「（依据：…）」：P74e 起中心拼好的完整回答里已经带着「依据：约定……」，再补一份就重复了；
 * 只有回答原文里没有「依据：」（旧格式、手写的事件）才补。
 */
function answerBasisSuffix(event: JobEvent): string {
  return textOf(event, 'text').includes('依据：') ? '' : basisText(event);
}

/**
 * 改派时作废的、上一位提问人的问题（P74r2a）：换执行者或换核对人时，被换下的人没回答的提问随改派作废，
 * 新人需要知道前任问过什么（也许同一个问题还要问）。只在改派之后、他第一次交回（核对人是第一次提交核对结论）之前出现。
 * 作废的提问记在 reassigned 事件的 data.voidedAsk 里（by 是提问人原来的身份）。
 */
export function voidedAskLine(ctx: HubContext, job: Job, botId: string, role: 'executor' | 'reviewer'): string | null {
  const events = eventsOf(ctx, job.id);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== 'reassigned') continue;
    const target = role === 'executor' ? event.data.to : event.data.reviewerTo;
    const voided = event.data.voidedAsk as { by?: unknown; text?: unknown } | undefined;
    if (target !== botId || voided === undefined || voided.by !== role || typeof voided.text !== 'string') continue;
    const acted = events.slice(index + 1).some(row => row.actor === botId && row.kind === (role === 'executor' ? 'submitted' : 'reviewed'));
    if (acted) return null;
    return `上一位${role === 'executor' ? '执行者' : '核对人'}问过：${voided.text}（没有回答，已作废）。你需要这个答案时，重新提问。`;
  }
  return null;
}

/** 「主人为这件事选的办法」一行（P74r6，逐字）：只在选办法之后进入的那个阶段里出现；标题和做法在说明时已检查过内部名称。 */
export function ownerChoiceLine(job: Job): string | null {
  return job.ownerChoice !== undefined && job.ownerChoice.stage === job.stage
    ? `主人为这件事选的办法：「${job.ownerChoice.title}」：${job.ownerChoice.detail}。` : null;
}

/** 回答原文（含出处）在第四级压缩时的写法：超过字数上限只留前面的部分，并写明后面放不下。 */
function answerClipped(text: string, level: CompressLevel): string {
  if (level < 4) return text;
  const chars = [...text];
  return chars.length <= D.PACKET_CLIP_ANSWER_CHARS ? text : `${chars.slice(0, D.PACKET_CLIP_ANSWER_CHARS).join('')}（回答较长，后面的部分放不下）`;
}

/** 材料文件夹里要列出的文件名：按转交的先后排，最近的在后面，最多列 PACKET_MATERIALS_MAX 份；返回列出的和没列出的份数。 */
function listedMaterials(ctx: HubContext, job: Job, materials: readonly string[]): { shown: string[]; more: number } {
  const order = eventsOf(ctx, job.id).filter(event => event.kind === 'forwarded').map(event => {
    const file = textOf(event, 'file');
    return file.startsWith(`${D.FOLDER_FILES.materials}/`) ? file.slice(D.FOLDER_FILES.materials.length + 1) : file;
  });
  // 没有转交记录的文件（主人手动放进去的）排在前面，按名字排；有记录的按转交先后。
  const rank = (name: string): number => order.lastIndexOf(name);
  const sorted = [...materials].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const shown = sorted.slice(-D.PACKET_MATERIALS_MAX);
  return { shown, more: sorted.length - shown.length };
}

/** 执行者的写法（任务卡 9.1 逐字）。level 是压缩级别（0 为不压缩），见 job-section-fit.ts。 */
function executorBody(ctx: HubContext, job: Job, entry: QueueEntry, title: string, absFull: (name: string) => string, jobDir: string, materials: readonly string[], level: CompressLevel): JobBodyParts {
  const reviewer = job.reviewerId === null ? '总管' : ctx.store.table('bots').get(job.reviewerId)?.name ?? '评审员';
  const F = D.FOLDER_FILES;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  // 第一级起路径改写成相对主题文件夹的路径，开头写一行说明（任务卡第 1 条第 3 点）。
  const abs = level >= 1 ? (name: string): string => name : absFull;
  // P74r1（R5）：开头的事实（rows）、条目清单（flex）、末尾的做法说明（after + 交回说明）分开放。
  const rows: string[] = [];
  const flex: FlexRow[] = [];
  if (level >= 1) rows.push(`下面的路径都相对于主题文件夹 ${jobDir}`);
  rows.push(`你是「${title}」的执行者（jobId 为 ${job.id}）。${reviewer}在交付前对照约定逐条核对，核对通过后由中心交给主人验收。`);
  const round = job.state === 'rework' ? `，本阶段第 ${Math.max(1, job.round)} 轮，共 ${D.REVIEW_ROUNDS_MAX} 轮` : '';
  rows.push(`现在：${JOB_STATE_LABELS[job.state]}${round}。交付时间：${dueTextOf(job.dueAt, ctx.settings.timezone)}。`);
  // P74r6：主人为三轮不过选了办法、总管照办法让这件事继续之后，只在这一阶段里写明主人选的办法。
  const choiceLine = ownerChoiceLine(job);
  if (choiceLine !== null) rows.push(choiceLine);
  // P74r2d：材料只写一次文件夹的路径，后面列各份的文件名；超过 8 份列最近的 8 份。
  const listed = listedMaterials(ctx, job, materials);
  const materialText = materials.length === 0 ? ''
    : `；材料文件夹 ${abs(F.materials)}：${listed.shown.join('、')}${listed.more > 0 ? `；另有 ${listed.more} 份，见材料文件夹` : ''}`;
  rows.push(`材料（只读）：约定 ${abs(F.agreement)}；主人原话 ${abs(F.words)}；草图 ${abs(F.sketch)}${materialText}。`);
  rows.push(`产出物先在自己的家目录里做好，再用 hub_project_put 放进项目文件夹（参数 project 填 ${job.projectId}，to 写 ${job.folder}/${F.delivery}/文件名）；截图和测试日志放进 ${job.folder}/${F.evidence}/。`);
  let shortened = false;
  if (agreement) {
    rows.push('怎样算做完（交回时逐条对应，no 写序号）：');
    flex.push({
      items: lockedVersionOf(agreement).content.doneWhen.map((text, index) => {
        // 第三级：条目原文截到 60 字（序号一直在）。
        const shown = level >= 3 ? clipWithEllipsis(text, D.PACKET_CLIP_ITEM_CHARS) : { text, clipped: false };
        if (shown.clipped) shortened = true;
        return `${index + 1}. ${shown.text}${job.deliveryItems.includes(index + 1) ? '（交付时核对：selfCheck 写 at_delivery，不附证据）' : ''}`;
      }),
      render: kept => kept.length === 0 ? null : kept.join('\n'),
    });
  }
  if (job.state === 'rework' && job.unmet.length > 0) {
    // 第四级：这一轮要改的条目的问题和「改到什么程度算过」各截到 120 字（序号和条数不变）。
    const clip = (text: string): string => level >= 4 ? clipWithEllipsis(text, D.PACKET_CLIP_UNMET_CHARS).text : text;
    flex.push({
      items: job.unmet.map(item => `第 ${item.no} 条：问题：${clip(item.problem)}；改到什么程度算过：${clip(item.fixTo)}。`),
      render: kept => kept.length === 0 ? null : `这一轮要改的条目：${kept.join('')}其余条目不用再交，沿用上一轮结论。`,
    });
  }
  const note = shortened && agreement ? `条目全文见约定文件 ${absFull(F.agreement)}` : null;
  const after: string[] = [];
  if (job.pause !== null && job.pause.stopsJob === true) {
    after.push(`约定第 ${job.pause.versionNo} 版写明这件事不再做，在等主人确认：确认后这件事由中心停下，确认前可以照常做。做完手上的部分之后，交账的结果写 no_change，说明在等约定确认。`);
  } else if (job.pause !== null) {
    const list = (items: readonly string[]): string => items.length === 0 ? '无' : items.join('、');
    after.push(`约定第 ${job.pause.versionNo} 版在等主人确认：暂停${list(job.pause.paused)}；照常在做${list(job.pause.continuing)}。暂停的部分在主人确认前不要交回。照常在做的部分做完之后，交账的结果写 no_change，说明在等约定确认；主人确认后中心会叫你。`);
  }
  const voided = voidedAskLine(ctx, job, job.executorId, 'executor');
  if (voided !== null) after.push(voided);
  const events = eventsOfWake(ctx, job, entry);
  const answered = [...events].reverse().find(event => event.kind === 'answered');
  if (answered) after.push(`总管刚回答你：${answerClipped(`${textOf(answered, 'text')}${answerBasisSuffix(answered)}`, level)}`);
  const forwarded = [...events].reverse().find(event => event.kind === 'forwarded');
  if (forwarded) {
    // 中心存的材料文件写相对路径「材料/xxx.md」，这里换成绝对路径，执行者直接能打开；旧格式（只有文件名）原样给出。
    const file = textOf(forwarded, 'file') || textOf(forwarded, 'fileName') || textOf(forwarded, 'title');
    after.push(`总管刚转来材料：${file.startsWith(`${F.materials}/`) ? abs(file) : file}`);
  }
  // P74r18a：约定写了对外发布时，写明验收之前不发布（真实模型为了做到「已复制到某目录」提前发布过）；自测不要引出需要主人批准的动作。
  // 这两行都是做法说明，放在 tail 里，压缩时任何一级都不删。
  const launchHow = agreement === null ? null : launchOf(lockedVersionOf(agreement).content)?.how ?? null;
  if (launchHow !== null) after.push(executorLaunchLine(launchHow));
  after.push(SELF_TEST_LINE);
  after.push(`交回：调用 hub_job_work，mode 写 submit，jobId 写 ${job.id}，changeNote 写这一轮怎么做的、改了什么；items 逐条写 no、selfCheck（met 符合、not_met 不符、at_delivery 交付时核对）和 evidence；selfCheck 写 met 的条目至少附 1 项、至多附 4 项 evidence，not_met 的条目要另写 note 说明哪里没做到，at_delivery 的条目不附 evidence。evidence 的每一项都要写 kind 和 summary：summary 是一句话说明这项证据证明了什么，不超过 120 字；kind 写 file（文件）、image（截图）、test（测试结果）或 link（链接）；file 和 image 另写 path（主题文件夹里的相对路径，例如 证据/手机.png）；link 另写 url（http:// 或 https:// 开头）；test 的 summary 写测试做了什么、结果如何，可以另加 command（核对人复跑用的命令）；deliverables 写 交付/ 下的文件；能打开预览的写 preview（交付/ 下的 html，或本机地址，http 或 https，主机只能是 localhost、127.0.0.1、[::1]）。`);
  // P74r6（第 12 条）：放文件和交回两个工具的路径写法不同，给一个例子，免得写混（逐字）。
  after.push(`例：放文件时 to 写 ${job.folder}/${F.delivery}/index.html；交回时 deliverables、preview 和证据的 path 都从这件事的文件夹算起，写 ${F.delivery}/index.html。`);
  after.push('有问题问总管：mode 写 ask，text 写问题。做不下去：mode 写 block，stuckAt 写卡在哪，tried 写试过什么。');
  after.push('不要直接找主人，不要用 hub_send。交账的 reply 只写一句这一回合做了什么。');
  return { head: rows, flex, note, tail: after };
}

/** 一条自查在核对人眼里的写法。 */
function selfCheckText(item: JobSubmission['items'][number], earlier: readonly JobReview[], textOfEarlier: (review: JobReview, no: number) => string | undefined): string {
  switch (item.selfCheck) {
    case 'met': return '自查符合';
    case 'not_met': return `自查不符：${item.note ?? '没有写说明'}`;
    case 'at_delivery': return '交付时核对';
    case 'carried': {
      // P74d：沿用的条目要追到最近一次真正给过结论的那一轮（上一轮可能也是沿用，结论记在更早的一轮里）。
      let old: JobReview['items'][number] | undefined;
      let round: number | string = '?';
      for (let index = earlier.length - 1; index >= 0 && old === undefined; index -= 1) {
        // P74r2c：早先的核对记录按它当时的序号存，约定改过之后序号可能变了：按条目原文找「同一条」，不按序号。
        const row = earlier[index]!.items.find(entry => entry.verdict !== 'carried' && textOfEarlier(earlier[index]!, entry.no) === item.text);
        if (row !== undefined) { old = row; round = earlier[index]!.round; }
      }
      const verdict = old === undefined ? '没有记录' : old.verdict === 'unmet' ? `不符（${old.note ?? '没有写说明'}）` : old.verdict === 'at_delivery' ? '交付时核对' : '符合';
      return `沿用第 ${round} 轮结论：${verdict}`;
    }
  }
}

/** 核对人的写法（任务卡 9.2 逐字）。不含工作往来、主题楼层、提问与回答。 */
function reviewerBody(ctx: HubContext, job: Job, entry: QueueEntry, title: string, absFull: (name: string) => string, jobDir: string, level: CompressLevel): JobBodyParts {
  const executor = ctx.store.table('bots').get(job.executorId)?.name ?? '执行者';
  const submission = latestSubmission(ctx, job.id);
  // 第一级起路径改写成相对主题文件夹的路径，开头写一行说明。
  const abs = level >= 1 ? (name: string): string => name : absFull;
  // P74r1（R5）：证据清单（每条自查连同它的证据算一条）；开头的事实和末尾的核对规则、提交方法、禁止事项不动。
  // P74r2d：放不下时逐级压缩，每一条的序号、每一项证据的编号和路径都不删。
  const rows: string[] = [];
  const flex: FlexRow[] = [];
  const tail: string[] = [];
  let shortened = false;
  if (level >= 1) rows.push(`下面的路径都相对于主题文件夹 ${jobDir}`);
  rows.push(`你是「${title}」的核对人（jobId 为 ${job.id}）。只看约定和下面的证据，不看执行过程。`);
  rows.push(`约定全文：${abs(D.FOLDER_FILES.agreement)}。这是第 ${job.stage} 阶段第 ${job.round} 轮核对，本阶段最多 ${D.REVIEW_ROUNDS_MAX} 轮。`);
  const choiceLine = ownerChoiceLine(job);
  if (choiceLine !== null) rows.push(choiceLine);
  const returned = eventsOf(ctx, job.id).filter(event => event.kind === 'owner_returned').at(-1);
  // P74f：优先读这件事记录上的指出记录（不受事件日志只保留近 14 天的影响），没有再读事件。
  const missed = job.ownerReturns?.at(-1)?.missed ?? textOf(returned, 'missed');
  if (missed !== '') rows.push(`主人验收时指出过核对漏掉的问题：${missed}。这一轮要把这种情况核对到。`);
  if (submission === null) {
    rows.push(`${executor}还没有交回，暂时没有可核对的内容。`);
  } else {
    rows.push(`${executor}的交回（${submission.changeNote}）：`);
    const earlier = reviewsOf(ctx, job.id).filter(review => review.submissionId !== submission.id);
    flex.push({
      items: submission.items.map(item => {
        // 第三级：条目原文截到 60 字（序号一直在）。
        const shown = level >= 3 ? clipWithEllipsis(item.text, D.PACKET_CLIP_ITEM_CHARS) : { text: item.text, clipped: false };
        if (shown.clipped) shortened = true;
        const lines = [`${item.no}. ${shown.text}`, `自查：${selfCheckText(item, earlier, (review, no) => ctx.store.table('jobSubmissions').get(review.submissionId)?.items.find(entry => entry.no === no)?.text)}`];
        for (const evidence of item.evidence) {
          const where = evidence.kind === 'link' ? evidence.url ?? '' : evidence.path === null ? '' : abs(evidence.path);
          const command = evidence.command === null ? '' : `；复跑命令：${evidence.command}`;
          // 第一级：中心检查结果为正常时不写检查说明；第二级：证据说明截到 40 字。
          const check = evidence.check.detail === '' || (level >= 1 && evidence.check.status === 'ok') ? '' : `；中心检查：${evidence.check.detail}`;
          const summary = level >= 2 ? clipWithEllipsis(evidence.summary, D.PACKET_CLIP_EVIDENCE_CHARS).text : evidence.summary;
          lines.push(`证据 ${evidence.id}：${EVIDENCE_KIND_LABELS[evidence.kind]} ${where === '' ? '' : `${where} `}${summary}${command}${check}`);
        }
        return lines.join('\n');
      }),
      render: kept => kept.length === 0 ? null : kept.join('\n'),
    });
    const preview = submission.preview === null ? '' : `；预览：${/^https?:/.test(submission.preview) ? submission.preview : abs(submission.preview)}`;
    tail.push(`产出物：${submission.deliverables.length === 0 ? '无' : submission.deliverables.map(path => abs(path)).join('、')}${preview}`);
  }
  tail.push('核对规则：只核对是否符合约定、是否正确；配色、字体、文案语气不在核对范围。能复查的自己复查一次（打开页面、复跑命令），在 note 里写明。不符的条目必须写 note（问题是什么）和 fixTo（改到什么程度算过，写成一句可以验证的话）。沿用上一轮结论的条目可以不写结论；抽查了哪几条写进 spotChecked，沿用的理由写进 carriedNote。');
  tail.push(`提交结论：调用 hub_job_work，mode 写 review，jobId 写 ${job.id}，items 逐条写 no、verdict（met、unmet 或 at_delivery）、note、fixTo。`);
  // P74f-2：主人选了办法之后回到核对：只需要给记下的那几条结论，其余条目本阶段前面已经通过，不用再写。
  if (job.recheckNos !== undefined && job.recheckNos.length > 0) {
    tail.push(`这一轮是主人选了办法之后的重新核对：只需要给第 ${job.recheckNos.join('、')} 条写结论，其余条目前面已经通过，不用再写。`);
  }
  tail.push('不要直接找主人，不要用 hub_send。交账的 reply 只写一句。');
  // P74r18a：约定写了对外发布时，核对时确认执行者没有提前发布（做法说明，压缩时不删）。
  const agreementOfJob = ctx.store.table('agreements').get(job.agreementId);
  const reviewerLaunchHow = agreementOfJob === null ? null : launchOf(lockedVersionOf(agreementOfJob).content)?.how ?? null;
  if (reviewerLaunchHow !== null) tail.push(reviewerLaunchLine(reviewerLaunchHow));
  // P74e：核对人自己向总管提过的问题，总管回答后叫醒他时，要让他看到这个回答（只看自己问的那一问，不看别的往来）。
  const answered = [...eventsOfWake(ctx, job, entry)].reverse().find(event => event.kind === 'answered' && event.to.includes(job.reviewerId ?? ''));
  if (answered) tail.unshift(`总管刚回答你：${answerClipped(`${textOf(answered, 'text')}${answerBasisSuffix(answered)}`, level)}`);
  // 换核对人时，上一位核对人没回答的提问随之作废：新核对人在这里看到，需要时重新提问（P74r2a）。
  const voided = job.reviewerId === null ? null : voidedAskLine(ctx, job, job.reviewerId, 'reviewer');
  if (voided !== null) tail.unshift(voided);
  // 只有条目原文真的被截短了，才写「条目全文见约定文件」（不再有「其余 N 条见约定文件」这种整条删掉的写法）。
  return { head: rows, flex, note: shortened ? `条目全文见约定文件 ${absFull(D.FOLDER_FILES.agreement)}` : null, tail };
}

/**
 * 「你手上的事」段正文和实际用到的压缩级别（0 为没有压缩；没有这一段时为空字符串）。测试用它确认落在哪一级。
 * maxBytes 默认是段的上限；测试传入更小的值，就能在小内容上逐级验证每一级的压缩（生产调用不传）。
 */
export async function buildJobBodyDetailed(ctx: HubContext, bot: Bot, entry: QueueEntry, ticket: WakeTicket, maxBytes: number = D.PACKET_MAX_BYTES): Promise<FitResult> {
  const jobId = ticket.jobId ?? entry.jobId ?? null;
  const job = jobId === null ? null : ctx.store.table('jobs').get(jobId);
  if (job === null) {
    // P88：总管的一览自己按上限压缩（先删最近收尾的事，固定的话保留），删过时级别记 1；其他员工那一行照旧。
    if (bot.role === 'chief') {
      const overview = chiefOverviewDetailed(ctx, bot.id, maxBytes);
      return { text: overview.text, level: overview.compressed ? 1 : 0, overflow: false };
    }
    return { text: truncateBytes(staffOverviewLine(ctx, bot.id), maxBytes), level: 0, overflow: false };
  }
  const title = ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事';
  const { jobDir } = jobFolderPaths(ctx, job);
  const abs = (name: string): string => posix.join(jobDir, name);
  const isReviewer = job.reviewerId === bot.id || (job.reviewerId === null && bot.id === job.chiefId && job.state === 'checking' && job.openAsk === null);
  // 四级之后仍超过上限（按参数上限推算不应出现）：记一条错误日志，照第四级的结果输出。
  const overflow = (bytes: number): void => {
    try { ctx.logger.error('「你手上的事」段压缩到第四级仍超过上限', { jobId: job.id, botId: bot.id, bytes, max: maxBytes }); } catch { /* 日志出错不能影响唤醒包。 */ }
  };
  // P74g：已验收、在发布环节（准备中、等批准或已批准）的执行者，整段换成发布的写法（不再写怎样交回）。
  if (bot.id === job.executorId && inLaunchSection(job)) {
    const deliverables = latestSubmission(ctx, job.id)?.deliverables ?? [];
    // P74r9：约定里写的发布方式（已固定那一版的对外发布一项）一并给执行者；没有写就为 null，不加这一行。
    const agreement = ctx.store.table('agreements').get(job.agreementId);
    const launchHow = agreement === null ? null : launchOf(lockedVersionOf(agreement).content)?.how ?? null;
    // P81：约定里写了发布位置（本机文件夹）时，发布准备正文多一行，写明可以写入这一个文件夹。
    const launchLocalDir = agreement === null ? null : launchOf(lockedVersionOf(agreement).content)?.localDir ?? null;
    return fitJobBody(level => job.launch.state === 'preparing' ? launchPrepareBody(job, title, jobDir, deliverables, level, launchHow, launchLocalDir) : launchApprovalBody(ctx, job, title), maxBytes, overflow);
  }
  // 执行者、核对人、总管的正文都是开头、清单、末尾三块，放不下时逐级压缩，做法说明和序号、证据编号与路径不删（P74r2d 第 1 条）。
  if (bot.id === job.executorId) {
    const materials = await ctx.fs.list(posix.join(jobDir, D.FOLDER_FILES.materials));
    return fitJobBody(level => executorBody(ctx, job, entry, title, abs, jobDir, materials, level), maxBytes, overflow);
  }
  if (isReviewer) return fitJobBody(level => reviewerBody(ctx, job, entry, title, abs, jobDir, level), maxBytes, overflow);
  if (bot.id === job.chiefId) {
    const wakeEvents = eventsOfWake(ctx, job, entry);
    const materials = await materialTitles(ctx, job);
    return fitJobBody(level => chiefChainBody(ctx, job, abs, wakeEvents, level, materials), maxBytes, overflow);
  }
  return { text: '', level: 0, overflow: false };
}

/**
 * 「你手上的事」段正文；这一回合不需要这一段时返回空字符串（整段不出现）。
 * 超过自身上限时逐级压缩（见 job-section-fit.ts），不整条删条目。
 */
export async function buildJobBody(ctx: HubContext, bot: Bot, entry: QueueEntry, ticket: WakeTicket): Promise<string> {
  return (await buildJobBodyDetailed(ctx, bot, entry, ticket)).text;
}
