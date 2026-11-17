/**
 * 主人选了「带改动」的办法时，由中心生成约定的新固定版本（P74f-2，任务卡第 7 节）。
 *
 * 为什么由中心生成：办法里写了「把第 n 条改成……」或「删去第 n 条」，主人点选这个办法就等于确认了这处改动，
 * 不再另外请他确认一次（主人面前同一件事只有一个入口）。所以中心直接记一个已固定的新版本，而不是让总管出一版再请主人确认：
 * 来源记为「主人的指示」（owner_instruction），固定方式记为按钮（button），只改「怎样算做完」的这一条，其余内容逐项不变，
 * 「改了什么」由中心对比算出，不由模型写。
 *
 * 本文件只做约定这一半：算出新内容、写入新版本。这件事（状态、条目对应、叫人）的变化在 choose-option.ts。
 */
import { AGREEMENT_DEFAULTS } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import {
  AgreementContentSchema, AgreementSchema, parseWithPaths, type Agreement, type AgreementContent, type AgreementVersion,
} from '../model/agreement.js';
import { diffContent } from '../project/agreement-content.js';
import { lockedVersionOf } from './files.js';

/** 办法里带的改动：第 no 条改成 text；text 为 null 表示删去这一条。 */
export interface OptionChange { no: number; text: string | null }

/** 改动后的约定内容；改完不合约定的格式（例如删去后少于最少条数）时抛出中文错误。 */
export function contentWithChange(content: AgreementContent, change: OptionChange): AgreementContent {
  if (change.no < 1 || change.no > content.doneWhen.length) {
    throw new Error(`「怎样算做完」一共 ${content.doneWhen.length} 条，没有第 ${change.no} 条`);
  }
  const doneWhen = change.text === null
    ? content.doneWhen.filter((_, index) => index !== change.no - 1)
    : content.doneWhen.map((text, index) => (index === change.no - 1 ? change.text!.trim() : text));
  if (change.text === null && doneWhen.length < AGREEMENT_DEFAULTS.DONE_WHEN_MIN) {
    throw new Error(`删去第 ${change.no} 条之后「怎样算做完」只剩 ${doneWhen.length} 条，约定至少要有 ${AGREEMENT_DEFAULTS.DONE_WHEN_MIN} 条`);
  }
  return parseWithPaths(AgreementContentSchema, { ...content, doneWhen }, '约定内容');
}

/** 生成新版本的输入。 */
export interface OptionVersionInput {
  change: OptionChange;
  /** 所选办法的标题，写进「改了什么」。 */
  title: string;
  /** 主人那条「选 A：……」消息的编号和所在线程（先生成编号再生成版本，版本里记它）。 */
  messageId: string;
  thread: string;
  now: number;
}

/** 生成结果：写好的约定、新版本、改动前后的「怎样算做完」清单。 */
export interface OptionVersionResult { agreement: Agreement; version: AgreementVersion; prevDone: string[]; newDone: string[] }

/**
 * 把办法里的改动写成约定的新固定版本（直接写表）。只能对已固定、没有待确认版本的约定做；
 * 版本数已到上限时抛出中文错误。上一个固定版改为已替换。
 */
/**
 * 主人选了带改动的办法之后，新生成的约定版本的版本号（P74r6）：现有版本数加 1。
 * 卡片上「选 A 即记为约定第 n 版」和实际生成新版本用同一个函数算：出过被撤销的待确认版本之后，版本数比说明时的版本号多，不能再用「说明时的版本号加 1」。
 */
export function nextOptionVersionNo(agreement: Pick<Agreement, 'versions'>): number {
  return agreement.versions.length + 1;
}

export function applyOwnerOptionVersion(ctx: HubContext, agreement: Agreement, input: OptionVersionInput): OptionVersionResult {
  if (agreement.state !== 'locked') throw new Error('约定现在不是已固定的状态，不能按办法生成新版本');
  if (agreement.versions.length + 1 > AGREEMENT_DEFAULTS.VERSION_MAX) {
    throw new Error(`这份约定已经有 ${agreement.versions.length} 版，达到上限 ${AGREEMENT_DEFAULTS.VERSION_MAX}，不能再出新版`);
  }
  const prev = lockedVersionOf(agreement);
  const content = contentWithChange(prev.content, input.change);
  const version: AgreementVersion = {
    no: nextOptionVersionNo(agreement), state: 'locked', source: 'owner_instruction',
    sourceMessageId: input.messageId, sourceThread: input.thread, wakeId: null,
    content, changes: diffContent(prev.content, content), changeNote: `按你选的办法：${input.title}`, cardMessageId: null,
    createdAt: input.now, lockedAt: input.now, lockedVia: 'button', confirmMessageId: input.messageId,
    choices: prev.choices, adoption: null,
  };
  const versions = [...agreement.versions.map(row => (row.state === 'locked' ? { ...row, state: 'replaced' as const } : row)), version];
  const next = AgreementSchema.parse({ ...agreement, versions, updatedAt: input.now });
  ctx.store.table('agreements').put(next);
  return { agreement: next, version, prevDone: [...prev.content.doneWhen], newDone: [...content.doneWhen] };
}
