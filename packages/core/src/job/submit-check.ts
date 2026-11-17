/**
 * 交回的全部校验（P74d，方案 5.3.1）：只检查、不写任何东西，问题一次列全。
 *
 * 为什么「一次列全」：模型拿到一条错误，改完再交，又得到下一条错误，会白白消耗回合（每件事的回合有上限）。
 * 所以这里把所有问题收集起来，一次性报给执行者；只要有一处不过，整次拒绝，不产生交回记录、不占轮次。
 *
 * 条目清单由中心从当前固定版本的「怎样算做完」抄出，执行者只能填序号 no、自查结论、说明和证据，不能改条目原文：
 * - 第一次交回（这个阶段还没有交回过，或没有要返工的条目）：每一条都必须出现，且只出现一次；
 * - 返工：核对退回或主人指出不符的条目（Job.unmet）必须重交；其余可以省略，省略的记为 carried（沿用上一轮结论）；
 * - 约定在上一次交回之后出过新版本，且某条原文变了（或被删去后序号对不上）：这一条也必须重交，不能沿用；
 * - deliveryItems 里的条目（与交付时间有关）只能写 at_delivery、不附证据；其他条目不能写 at_delivery。
 * 证据逐项机械检查（evidence.ts）：file、image 必须 ok；test、link 只查格式。
 * 修订不丢内容：省略的条目一律带着原条目原文进入 carried，核对时沿用上一次核对对它的结论，不会悄悄消失。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Agreement } from '../model/agreement.js';
import type { Evidence, Job, JobSubmission } from '../model/job.js';
import { centerWrittenError, checkEvidence, checkTopicFile, evidenceFormatError, previewError, type EvidenceInput } from './evidence.js';
import { lockedVersionOf } from './files.js';
import { remapItems, submissionTexts, type ItemRemap } from './item-remap.js';
import { latestSubmission } from './store.js';
import { paramNameProblem } from './owner-text.js';

/** 交回时执行者传入的一条。 */
export interface SubmitItemArg {
  no: number;
  selfCheck?: 'met' | 'not_met' | 'at_delivery' | undefined;
  note?: string | undefined;
  evidence?: EvidenceInput[] | undefined;
}

/** hub_job_work submit 解析后的参数。 */
export interface SubmitArgs {
  changeNote?: string | undefined;
  items?: SubmitItemArg[] | undefined;
  deliverables?: string[] | undefined;
  preview?: string | undefined;
}

/** 校验通过后可以直接写入的内容。 */
export interface SubmissionPlan {
  versionNo: number;
  changeNote: string;
  items: JobSubmission['items'];
  deliverables: string[];
  preview: string | null;
}

/** 本次交回必须出现的条目及原因（原因进报错文字）。 */
function requiredItems(job: Job, version: { no: number; texts: readonly string[] }, previous: JobSubmission | null, remap: ItemRemap | null): Map<number, string> {
  const required = new Map<number, string>();
  const count = version.texts.length;
  if (job.unmet.length === 0 || previous === null || remap === null) {
    // 第一次交回（或没有记录可沿用）：每一条都要出现。
    for (let no = 1; no <= count; no += 1) required.set(no, '第一次交回每一条都要写');
    return required;
  }
  for (const unmet of job.unmet) required.set(unmet.no, '这一条被退回了，要重新交回');
  // P74r2c：按原文判断：原文没变、只是序号变了的条目可以沿用；只有真的没有对应上的（改写或新增）才必须重交。
  for (const no of remap.added) {
    if (!required.has(no)) required.set(no, `约定第 ${version.no} 版改写了这一条（或它是新增的），不能沿用上一轮，要重新交回`);
  }
  return required;
}

/** 校验一次交回并生成写入内容。有任何问题抛出一条列全的中文错误，不写任何东西。 */
export async function planSubmission(ctx: HubContext, job: Job, agreement: Agreement, args: SubmitArgs): Promise<SubmissionPlan> {
  const errors: string[] = [];
  const version = lockedVersionOf(agreement);
  const texts = version.content.doneWhen;
  const missing = [args.changeNote === undefined ? 'changeNote' : null, args.items === undefined ? 'items' : null,
    args.deliverables === undefined ? 'deliverables' : null].filter((name): name is string => name !== null);
  if (missing.length > 0) throw new Error(`缺少必填项：${missing.join('、')}（mode 为 submit 时都要填写）`);
  const changeNoteProblem = paramNameProblem('changeNote', args.changeNote!);
  if (changeNoteProblem !== null) errors.push(changeNoteProblem);
  const previous = latestSubmission(ctx, job.id);
  // P74r2c：上一次交回里的条目按原文对应到当前版本的条目（序号可能变了）；沿用的条目从对应的那一条带说明和证据。
  const remap = previous === null ? null : remapItems(submissionTexts(previous), texts);
  const previousOf = (no: number) => { const oldNo = remap?.toOld.get(no); return oldNo === undefined ? undefined : previous?.items.find(item => item.no === oldNo); };
  const required = requiredItems(job, { no: version.no, texts }, previous, remap);

  // 1. 逐条检查执行者写的条目。
  const seen = new Set<number>();
  const checked: JobSubmission['items'] = [];
  // 新证据的编号接在上一次交回已有编号之后（沿用的条目会原样带着上一次的证据，编号不能重复）。
  let evidenceNo = Math.max(0, ...(previous?.items ?? []).flatMap(item => item.evidence.map(evidence => Number(evidence.id.slice(2)))));
  const ordered = [...args.items!].sort((a, b) => a.no - b.no);
  for (const item of ordered) {
    const prefix = `第 ${item.no} 条：`;
    if (item.no < 1 || item.no > texts.length) { errors.push(`${prefix}约定「怎样算做完」只有 ${texts.length} 条，没有这一条`); continue; }
    if (seen.has(item.no)) { errors.push(`${prefix}写了多次，每一条只能写一次`); continue; }
    seen.add(item.no);
    const evidence = item.evidence ?? [];
    const note = item.note?.trim() === '' ? undefined : item.note?.trim();
    // P74r14：自查说明会显示给主人，不带参数名（证据里的页面标识符不检查）。
    const noteProblem = note === undefined ? null : paramNameProblem(`${prefix}note`, note);
    if (noteProblem !== null) errors.push(noteProblem);
    const isDelivery = job.deliveryItems.includes(item.no);
    if (item.selfCheck === undefined) { errors.push(`${prefix}缺少 selfCheck（met、not_met 或 at_delivery）`); continue; }
    if (isDelivery) {
      if (item.selfCheck !== 'at_delivery') errors.push(`${prefix}这一条在交付时核对，selfCheck 只能写 at_delivery`);
      else if (evidence.length > 0) errors.push(`${prefix}交付时核对的条目不附证据`);
    } else if (item.selfCheck === 'at_delivery') {
      errors.push(`${prefix}这一条不是交付时核对的条目，selfCheck 不能写 at_delivery，请写 met 或 not_met`);
    }
    if (item.selfCheck === 'met' && evidence.length === 0) errors.push(`${prefix}自查符合必须至少附一项证据`);
    if (item.selfCheck === 'not_met' && note === undefined) errors.push(`${prefix}自查不符必须用 note 写明哪里没做到`);
    if (evidence.length > D.EVIDENCE_PER_ITEM_MAX) errors.push(`${prefix}证据最多 ${D.EVIDENCE_PER_ITEM_MAX} 项，你写了 ${evidence.length} 项`);
    // 证据逐项检查：格式问题和文件问题都带上条目序号。at_delivery 的条目已经因为带证据被拒，这里不再检查它们的证据。
    const kept: Evidence[] = [];
    if (item.selfCheck !== 'at_delivery') {
      for (const [index, entry] of evidence.slice(0, D.EVIDENCE_PER_ITEM_MAX).entries()) {
        const problem = evidenceFormatError(entry);
        if (problem !== null) { errors.push(`${prefix}第 ${index + 1} 项证据：${problem}`); continue; }
        // P74r2d 第 5 条：文件、图片类证据不能指向中心写的文件（约定、原话、草图、材料）。
        const centerWritten = (entry.kind === 'file' || entry.kind === 'image') && entry.path !== undefined ? centerWrittenError(job, entry.path.trim()) : null;
        if (centerWritten !== null) { errors.push(`${prefix}第 ${index + 1} 项证据：${centerWritten}`); continue; }
        evidenceNo += 1;
        const result = await checkEvidence(ctx, job, entry, `ev${evidenceNo}`);
        if (result.check.status !== 'ok' && result.check.status !== 'unchecked') errors.push(`${prefix}${result.check.detail}`);
        kept.push(result);
      }
    }
    checked.push({ no: item.no, text: texts[item.no - 1]!, selfCheck: item.selfCheck, note: note ?? null, evidence: kept });
  }

  // 2. 必须出现的条目有没有出现。
  for (const [no, why] of required) {
    if (!seen.has(no)) errors.push(`第 ${no} 条：没有交回。${why}`);
  }

  // 3. 没有出现、也不是必须出现的条目记为沿用（carried），原文由中心抄写；
  //    上一次交回里这一条的说明和证据原样带过来（修订不悄悄丢内容：最新一次交回始终是完整的清单，抽查沿用的条目时也看得到证据）。
  const items: JobSubmission['items'] = [...checked];
  for (let no = 1; no <= texts.length; no += 1) {
    if (seen.has(no) || required.has(no)) continue;
    const old = previousOf(no);
    items.push({ no, text: texts[no - 1]!, selfCheck: 'carried', note: old?.note ?? null, evidence: old?.evidence.map(evidence => ({ ...evidence, check: { ...evidence.check } })) ?? [] });
  }
  items.sort((a, b) => a.no - b.no);

  // 4. 产出物：每一项都是主题文件夹里真实存在的非空文件。
  const deliverables = (args.deliverables ?? []).map(path => path.trim());
  if (deliverables.length === 0) errors.push('deliverables：至少写一个产出物');
  if (deliverables.length > D.DELIVERABLES_MAX) errors.push(`deliverables：最多 ${D.DELIVERABLES_MAX} 个，你写了 ${deliverables.length} 个`);
  for (const [index, path] of deliverables.slice(0, D.DELIVERABLES_MAX).entries()) {
    const centerWritten = centerWrittenError(job, path);
    if (centerWritten !== null) { errors.push(`deliverables 第 ${index + 1} 项：${centerWritten}`); continue; }
    const result = await checkTopicFile(ctx, job, path);
    if (result.status !== 'ok') errors.push(`deliverables 第 ${index + 1} 项：${result.detail}`);
  }

  // 5. 预览入口。
  const preview = args.preview === undefined || args.preview.trim() === '' ? null : args.preview.trim();
  if (preview !== null) {
    const problem = await previewError(ctx, job, preview);
    if (problem !== null) errors.push(problem);
  }

  if (errors.length > 0) throw new Error(`交回被拒，没有写入任何东西（不占轮次）。需要改的地方：\n${errors.join('\n')}`);
  return { versionNo: version.no, changeNote: args.changeNote!.trim(), items, deliverables, preview };
}
