/**
 * 「怎样算做完」的条目对应（P74r2c，第二次审查 G4）。
 *
 * 为什么需要：一件事里有几样东西按「怎样算做完」的序号存着：交付时核对的条目（deliveryItems）、返工中待改的条目（unmet）、
 * 受阻时关联的条目（blocked.no）、每次交回和核对记录里的条目。执行中改约定时，新版本可以在中间插入、删去条目，
 * 序号随之变化，而这些按序号存的东西没有跟着变，结果是：一条本该附证据的条目被当成「交付时核对」，返工条目的问题挂到别的条目上。
 *
 * 做法：以条目原文为准。原文完全相同的是同一条，序号变了就跟着换；原文变了的按新增或改写处理。
 * 已有的交回记录、核对记录不改写，只追加（中心重排的交回记录见 buildRemappedSubmission）。
 *
 * 本文件全是纯函数：不读存储、不碰时钟，只在传入的数据上计算，P74f 的「待你验收」处理可以直接调用。
 */
import type { JobSubmission, JobUnmet } from '../model/job.js';
import { hasTimeMention } from './time-mention.js';
// hasTimeMention 仍用于 checkDeliveryItems（新写的 deliveryItems 必须写了时间）。

// ---------------------------------------------------------------------------
// 一、对应关系
// ---------------------------------------------------------------------------

/** 两份「怎样算做完」清单之间的对应结果（序号都从 1 起）。 */
export interface ItemRemap {
  /** 旧序号 -> 新序号：原文完全相同才有。 */
  toNew: Map<number, number>;
  /** 新序号 -> 旧序号。 */
  toOld: Map<number, number>;
  /** 新版本里新增或改写的序号（没有对应到旧条目的），从小到大。 */
  added: number[];
  /** 旧版本里被删去或被改写的序号（没有对应到新条目的），从小到大。 */
  removed: number[];
  /** 两份清单有没有任何不同（任何一条的序号或原文变了）。 */
  changed: boolean;
}

/**
 * 按原文对应。同一句原文出现多次时按出现的先后依次对应（旧的第 1 个对新的第 1 个，依此类推）。
 * 为什么按先后：重复原文本来分不出谁是谁，按先后对应最稳定，也不会让两条对到同一条上。
 */
export function remapItems(prev: readonly string[], next: readonly string[]): ItemRemap {
  // 每句原文在新清单里出现的位置（序号），按先后排队，旧清单每对应一次就取走队首。
  const queues = new Map<string, number[]>();
  next.forEach((text, index) => {
    const queue = queues.get(text);
    if (queue === undefined) queues.set(text, [index + 1]); else queue.push(index + 1);
  });
  const toNew = new Map<number, number>();
  const toOld = new Map<number, number>();
  const removed: number[] = [];
  prev.forEach((text, index) => {
    const target = queues.get(text)?.shift();
    if (target === undefined) { removed.push(index + 1); return; }
    toNew.set(index + 1, target);
    toOld.set(target, index + 1);
  });
  const added = next.map((_, index) => index + 1).filter(no => !toOld.has(no));
  const same = prev.length === next.length && prev.every((text, index) => text === next[index]);
  return { toNew, toOld, added, removed, changed: !same };
}

/** 一份清单这次改动涉及的条目（P74r3，M1）：新版本里改写或新增的条目用新序号，删去的条目用旧序号。 */
export interface ItemChanges {
  /** 新版本里改写的条目（旧位置上原文换了）：新序号。 */
  rewritten: number[];
  /** 新版本里新增的条目：新序号。 */
  added: number[];
  /** 旧版本里被删去的条目：旧序号。 */
  deleted: number[];
}

/**
 * 把对应结果分成「改写、新增、删去」三类（两栏的算法用，按原文算，序号只是挪了位置的条目不算改动）。
 * 做法：原文对上的条目是锚点；两个锚点之间没对上的旧条目和新条目按先后一对一配成「改写」，多出来的新条目是「新增」，
 * 多出来的旧条目是「删去」。例：旧 [甲, 乙, 丙]、新 [乙, 丙, 丁]：甲前面没有新条目可配，是删去；丁是新增；乙、丙没改。
 * 旧 [甲, 乙, 丙]、新 [甲, 乙, 丙']：丙和丙' 在同一个空档，配成改写。
 */
export function classifyChanges(remap: ItemRemap, prevCount: number, nextCount: number): ItemChanges {
  const anchors = [...remap.toNew.entries()].sort((a, b) => a[0] - b[0]);
  const rewritten: number[] = [];
  const added: number[] = [];
  const deleted: number[] = [];
  const usedNew = new Set<number>();
  // 空档：上一个锚点（旧、新序号）和下一个锚点之间，没对上的旧序号和新序号。
  let lastOld = 0;
  let lastNew = 0;
  const flush = (nextOld: number, nextNew: number): void => {
    const olds = remap.removed.filter(no => no > lastOld && no < nextOld);
    const news = remap.added.filter(no => no > lastNew && no < nextNew && !usedNew.has(no));
    olds.forEach((oldNo, index) => {
      const target = news[index];
      if (target === undefined) deleted.push(oldNo);
      else { rewritten.push(target); usedNew.add(target); }
    });
    for (const no of news.slice(olds.length)) { added.push(no); usedNew.add(no); }
  };
  for (const [oldNo, newNo] of anchors) {
    flush(oldNo, newNo);
    lastOld = oldNo;
    lastNew = newNo;
  }
  flush(prevCount + 1, nextCount + 1);
  // 顺序被调换时，有些新序号落在空档之外：当作新增，不丢。
  for (const no of remap.added) if (!usedNew.has(no)) added.push(no);
  const asc = (list: number[]): number[] => [...new Set(list)].sort((a, b) => a - b);
  return { rewritten: asc(rewritten), added: asc(added), deleted: asc(deleted) };
}

/** 超过 20 个字截断并加「…」，用在给模型看的报错和返回文字里。 */
export function clip20(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length <= 20 ? chars.join('') : `${chars.slice(0, 20).join('')}…`;
}

/**
 * 沿用下来的条目相对顺序有没有变：按旧序号从小到大看，对应的新序号必须依次变大。
 * 有变化时返回「位置变了」的那一条在新版本里的序号（按旧顺序往后看，新序号回头的那一条），没有变化返回 null。
 */
export function firstReordered(remap: ItemRemap): number | null {
  let highest = 0;
  for (const oldNo of [...remap.toNew.keys()].sort((a, b) => a - b)) {
    const newNo = remap.toNew.get(oldNo)!;
    if (newNo < highest) return newNo;
    highest = newNo;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 二、交付时核对的条目
// ---------------------------------------------------------------------------

/** 交付时核对的序号校验（派活和执行中改约定共用）：每个都是 1 到 count 的整数，不重复。错误文字是中文。 */
export function checkDeliveryItems(items: readonly number[], count: number, texts?: readonly string[]): void {
  for (const no of items) {
    if (!Number.isInteger(no) || no < 1 || no > count) throw new Error(`deliveryItems：序号 ${no} 不在「怎样算做完」的范围内（1 到 ${count}）`);
  }
  if (new Set(items).size !== items.length) throw new Error('deliveryItems：序号不能重复');
  // P74r7：传了条目原文时，再检查「只能是写了时间的那一条」：最多 2 条，每条原文里都要写了时间。
  if (texts === undefined) return;
  if (items.length > DELIVERY_ITEMS_MAX) throw new Error(`deliveryItems：最多 ${DELIVERY_ITEMS_MAX} 条，这次写了 ${items.length} 条。${DELIVERY_ITEMS_RULE}${DELIVERY_ITEMS_REST}`);
  for (const no of items) {
    const text = texts[no - 1] ?? '';
    if (!hasTimeMention(text)) {
      throw new Error(`deliveryItems：${DELIVERY_ITEMS_RULE}第 ${no} 条「${[...text].slice(0, 30).join('')}」里没有写时间，不能写进来；${DELIVERY_ITEMS_REST}`);
    }
  }
}

/** 「交付时核对」最多几条。 */
export const DELIVERY_ITEMS_MAX = 2;
const DELIVERY_ITEMS_RULE = '这一项只写到了交付那一刻才能判断的条目，也就是写了交付时间的那一条（例如「11 月 17 日 18:00 前交给你验收」）。';
const DELIVERY_ITEMS_REST = '其余条目要由执行者附证据、核对人核对。没有这样的条目就不写这一项。';

/**
 * 把旧的交付时核对条目换成新序号；原文被改写或删去的不再算。从小到大。
 * P74r15：对应上的条目（remap.toNew 里只有原文完全相同的）原样保留，不再按「有没有写时间」重新判断。
 * 原来（P74r7）换算后会把原文里没写时间的条目去掉，判断规则一变（P74r13 收紧、P74r15 放宽），
 * 主人已经确认过的「交付时核对」条目就会被悄悄改成要证据、要核对的普通条目；条目文字没有变，就不该因为判断规则变了而变。
 * 只有「是否交付时核对」由总管在新版本里明确改写（deliveryItems）时才变，那一条路径不经过这里。
 */
export function mapDeliveryItems(oldItems: readonly number[], remap: ItemRemap): number[] {
  return oldItems.flatMap(no => {
    const target = remap.toNew.get(no);
    return target === undefined ? [] : [target];
  }).sort((a, b) => a - b);
}

/** 原来在交付时核对、现在对不上新条目（被改写或删去）的旧序号。 */
export function lostDeliveryItems(oldItems: readonly number[], remap: ItemRemap): number[] {
  return oldItems.filter(no => !remap.toNew.has(no)).sort((a, b) => a - b);
}

/**
 * 条目对应上了、但「是否在交付时核对」的状态变了的新序号（例如总管在 deliveryItems 里把一条原本附证据的条目改成交付时核对）。
 * 这样的条目原来的交回不能照搬，要重新交回。
 */
export function flippedDeliveryItems(oldItems: readonly number[], newItems: readonly number[], remap: ItemRemap): number[] {
  const flipped: number[] = [];
  for (const [oldNo, newNo] of remap.toNew) {
    if (oldItems.includes(oldNo) !== newItems.includes(newNo)) flipped.push(newNo);
  }
  return flipped.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 三、返工条目、受阻条目
// ---------------------------------------------------------------------------

/** 待改条目换成新序号：问题和「改到什么程度算过」原样保留；原文已被改写或删去的去掉。按新序号排序。 */
export function remapUnmet(unmet: readonly JobUnmet[], remap: ItemRemap): JobUnmet[] {
  return unmet.flatMap(item => {
    const target = remap.toNew.get(item.no);
    return target === undefined ? [] : [{ ...item, no: target }];
  }).sort((a, b) => a.no - b.no);
}

/** 受阻时关联的条目序号：原文还在的换成新序号，否则置空；本来就没有关联的保持空。 */
export function remapBlockedNo(no: number | null, remap: ItemRemap): number | null {
  return no === null ? null : remap.toNew.get(no) ?? null;
}

// ---------------------------------------------------------------------------
// 四、中心重排的交回记录
// ---------------------------------------------------------------------------

/** 一次交回的条目原文清单（按序号从小到大）。 */
export function submissionTexts(submission: Pick<JobSubmission, 'items'>): string[] {
  return [...submission.items].sort((a, b) => a.no - b.no).map(item => item.text);
}

/**
 * 按对应关系给最近一次交回重排出一条新记录（只用于只有删去、没有新增或改写的情形）：
 * 同一阶段、同一轮，版本号是新版本；条目按新序号，原文、自查结论、说明、证据原样；被删去的条目不带；
 * remappedFrom 标明它是中心重排的、重排自哪一次交回。原来的记录不动。
 * 不是执行者的一次交回：统计「交回几次」时用 isCenterRemapped 排除。
 */
export function buildRemappedSubmission(
  source: JobSubmission, remap: ItemRemap, versionNo: number, id: string, now: number,
): JobSubmission {
  const items = source.items.flatMap(item => {
    const target = remap.toNew.get(item.no);
    return target === undefined ? [] : [{ ...item, no: target, evidence: item.evidence.map(evidence => ({ ...evidence, check: { ...evidence.check } })) }];
  }).sort((a, b) => a.no - b.no);
  return { ...source, id, versionNo, items, createdAt: now, remappedFrom: source.id };
}

/**
 * P74r4a 第 2 条第 4 点：主人选了带改动的办法之后，按新版本的「怎样算做完」给最近一次交回重排出一条新记录。
 * 与 buildRemappedSubmission 的不同：交回里的序号是它当时那个版本的序号，新版本里还可能有交回里没有的条目
 * （说明之后约定在前面插入的新条目、被办法改写的那一条）。做法全部按条目原文对应，不按序号直接套：
 * - 新版本的每一条，原文在交回里有的，沿用那一条（自查结论、说明、证据原样）；
 * - 被办法改写的那一条（rewrite），沿用它原来在交回里的那一条，只把原文换成改后的；
 * - 其余没有对应的新条目（别处插入的新条目）：中心补一条「还没有做」（自查 not_met、没有证据），
 *   核对人必须给结论，没做的事不会因为被当成「沿用」而溜过核对。
 * 返回的记录标明 remappedFrom（中心重排的，不算执行者的一次交回）。纯函数。
 */
export function buildOptionSubmission(
  source: JobSubmission, newDone: readonly string[], rewrite: { newNo: number; sourceNo: number } | null,
  versionNo: number, id: string, now: number,
): JobSubmission {
  const bySource = remapItems(submissionTexts(source), newDone);
  const items = newDone.map((text, index) => {
    const no = index + 1;
    const oldNo = bySource.toOld.get(no) ?? (rewrite !== null && rewrite.newNo === no ? rewrite.sourceNo : undefined);
    const own = oldNo === undefined ? undefined : source.items.find(item => item.no === oldNo);
    if (own === undefined) {
      return { no, text, selfCheck: 'not_met' as const, note: '约定新版本新增的条目，还没有做', evidence: [] };
    }
    return { ...own, no, text, evidence: own.evidence.map(evidence => ({ ...evidence, check: { ...evidence.check } })) };
  });
  return { ...source, id, versionNo, items, createdAt: now, remappedFrom: source.id };
}

/** 这条交回记录是中心重排的、不是执行者的一次交回。 */
export function isCenterRemapped(submission: Pick<JobSubmission, 'remappedFrom'>): boolean {
  return typeof submission.remappedFrom === 'string' && submission.remappedFrom !== '';
}
