/**
 * 执行中改约定（B2）的「照常在做 / 暂停」两栏（P74e，方案 5.2.3）：由中心根据这次改动涉及的条目算出，不由模型自由填写。
 *
 * 为什么不能让模型自由填：模型可能把被这次改动涉及的部分写成「照常在做」，执行者就会接着做一件主人还没确认、
 * 甚至可能被改掉的事；也可能漏写暂停的部分。这里的做法：
 * - 改动涉及的条目（草图、待你定、我已定的、这次做、这次不做、怎样算做完里被新增、改写、删去的；P74r16b 起「一句话」不列进清单）由中心对比
 *   「正在执行的已固定版本」和新版本算出，一律列在「暂停」栏最前面，模型不用也不能漏；
 * - 模型仍要写 continuing（照常在做）和 paused（暂停）：paused 里写它判断受影响的工作内容（中心列出的条目放在前面，
 *   模型多写的接在后面，重复的去掉）；continuing 里写不受影响的部分，但不能写进被改动涉及的条目——碰到就整份拒绝，
 *   报错写明是哪一条，让模型改正；
 * - 两栏最多各 PAUSE_ITEMS_MAX 项、每项不超过 PAUSE_ITEM_MAX_CHARS 字，超长的截断。
 *
 * 纯函数：输入两版约定内容和模型写的几项，输出写进 Job.pause 的内容；不读存储、不碰时钟。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { AgreementContent } from '../model/agreement.js';
import type { JobPause } from '../model/job.js';
import { diffContent } from '../project/agreement-content.js';
import { classifyChanges, remapItems } from './item-remap.js';

/** 一条被这次改动涉及的条目：label 写进报错，text 用来和模型写的 continuing 对比，line 是写进「暂停」栏的那一行。 */
export interface TouchedItem { label: string; text: string | null; line: string }

/** 约定各部分的中文名（与约定卡一致）。 */
const SECTION_LABELS = { decided: '我已定的', scopeIn: '这次做', scopeOut: '这次不做', doneWhen: '怎样算做完' } as const;

/** 截到 max 个字，超过时最后一个字换成「…」（总长不超过 max）。 */
export function clipTo(text: string, max: number = D.PAUSE_ITEM_MAX_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * P74r12：「暂停」栏一行里冒号之后的内容：取这一条的新文字，压成一行，最多 PAUSE_CONTENT_MAX_CHARS（60）个字，
 * 超过的截到 60 个字并在末尾加「…」；恰好 60 个字不加。内容为空时写「（没有文字）」，不留空行。
 */
export function pauseContent(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return '（没有文字）';
  const chars = [...clean];
  return chars.length <= D.PAUSE_CONTENT_MAX_CHARS ? clean : `${chars.slice(0, D.PAUSE_CONTENT_MAX_CHARS).join('')}…`;
}

/** 暂停的总处数：新数据记着 pausedTotal；旧数据按显示的行数算，最后一行是「另有 n 处，见约定卡」时把 n 加上。 */
export function pausedCount(pause: Pick<JobPause, 'paused' | 'pausedTotal'>): number {
  if (pause.pausedTotal !== undefined) return pause.pausedTotal;
  const last = pause.paused.at(-1);
  const more = last === undefined ? null : /^另有 (\d+) 处，见约定卡$/.exec(last);
  return more === null ? pause.paused.length : pause.paused.length - 1 + Number(more[1]);
}

/** 对比正在执行的已固定版本和新版本，列出被涉及的条目。 */
export function touchedItems(locked: AgreementContent, next: AgreementContent): TouchedItem[] {
  const items: TouchedItem[] = [];
  for (const mark of diffContent(locked, next)) {
    switch (mark.section) {
      case 'summary':
        // P74r16b：「一句话」不列进「暂停，等你确认」的清单（它不是一条要做的事，清单里被截到 60 个字主人读不完；
        // 这一句的改动仍在卡上的「本版改动」和新的一句话里看得到）。冲突检查仍看它，见 summaryTouched。
        break;
      case 'sketch':
        items.push({ label: '草图', text: null, line: '草图改了' });
        break;
      case 'pending': {
        const question = mark.kind === 'removed' ? mark.text ?? '' : next.pending.find(row => row.key === mark.key)?.question ?? '';
        items.push({ label: `待你定「${question}」`, text: question, line: `待你定「${pauseContent(question)}」${mark.kind === 'removed' ? '（删去）' : ''}` });
        break;
      }
      default:
        // 四段列表（我已定的、这次做、这次不做、怎样算做完）不按位置比，下面按原文单独算（P74r3，M1）。
        break;
    }
  }
  // 四段列表：判断哪些条目被这次改动涉及时都按原文：原文还在的不算改动（序号变了也不算）；新增、改写的算，序号用新版本里的；
  // 删去的算，写明删去。「我已定的」的身份还包括依据（依据变了也算改动）。
  const decidedKey = (item: AgreementContent['decided'][number]): string => `${item.text}\u0000${item.basis.kind}\u0000${item.basis.ref ?? ''}`;
  const lists: Array<{ section: keyof typeof SECTION_LABELS; prev: string[]; next: string[]; prevText: string[]; nextText: string[] }> = [
    { section: 'decided', prev: locked.decided.map(decidedKey), next: next.decided.map(decidedKey), prevText: locked.decided.map(item => item.text), nextText: next.decided.map(item => item.text) },
    { section: 'scopeIn', prev: locked.scopeIn, next: next.scopeIn, prevText: locked.scopeIn, nextText: next.scopeIn },
    { section: 'scopeOut', prev: locked.scopeOut, next: next.scopeOut, prevText: locked.scopeOut, nextText: next.scopeOut },
    { section: 'doneWhen', prev: locked.doneWhen, next: next.doneWhen, prevText: locked.doneWhen, nextText: next.doneWhen },
  ];
  for (const list of lists) {
    const label = SECTION_LABELS[list.section];
    const changes = classifyChanges(remapItems(list.prev, list.next), list.prev.length, list.next.length);
    for (const no of [...changes.rewritten, ...changes.added].sort((a, b) => a - b)) {
      const text = list.nextText[no - 1] ?? '';
      items.push({ label: `${label}第 ${no} 条`, text, line: `${label}第 ${no} 条：${pauseContent(text)}` });
    }
    for (const no of changes.deleted) {
      const text = list.prevText[no - 1] ?? '';
      items.push({ label: `${label}（删去）「${text}」`, text, line: `${label}删去：${pauseContent(text)}` });
    }
  }
  return items;
}

/** P74r16b：一句话改了就返回它的新文字（只用于检查「照常在做」有没有碰到它，不进「暂停」清单）；没改返回空数组。 */
function summaryTouched(locked: AgreementContent, next: AgreementContent): Array<Pick<TouchedItem, 'label' | 'text'>> {
  return diffContent(locked, next).some(mark => mark.section === 'summary') ? [{ label: '一句话', text: next.summary }] : [];
}

/** 比较用的规范写法：全角转半角、转小写、去掉空白和标点。 */
function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 模型写的一行是否碰到被涉及的条目原文（互相包含，较短的一方至少 3 个字才算，避免「页面」这样的短词误伤）。 */
function overlaps(line: string, text: string | null): boolean {
  if (text === null) return false;
  const a = normalized(line);
  const b = normalized(text);
  if (a === '' || b === '' || Math.min([...a].length, [...b].length) < 3) return false;
  return a.includes(b) || b.includes(a);
}

/** 模型提交的三项。 */
export interface PauseInput { continuing: readonly string[]; paused: readonly string[]; fallback: string | undefined }

/**
 * 算出写进 Job.pause 的内容。continuing 碰到被涉及的条目时整份拒绝（抛出中文错误，一次列全）。
 * 返回的 paused：中心列出的条目在前，模型另写的在后，去重，最多 PAUSE_ITEMS_MAX 项。
 */
export function buildPause(versionNo: number, locked: AgreementContent, next: AgreementContent, input: PauseInput): JobPause {
  const touched = touchedItems(locked, next);
  const conflicts: string[] = [];
  for (const line of input.continuing) {
    const hit = [...summaryTouched(locked, next), ...touched].find(item => overlaps(line, item.text));
    if (hit !== undefined) conflicts.push(`continuing 里的「${line}」涉及这次改动的${hit.label}，不能写成照常在做，请写进 paused`);
  }
  if (conflicts.length > 0) throw new Error(conflicts.join('\n'));
  const paused: string[] = [];
  for (const line of [...touched.map(item => item.line), ...input.paused.map(item => clipTo(item))]) {
    if (!paused.includes(line)) paused.push(line);
  }
  // 放不下时最后一项换成一句总括，不悄悄丢掉。
  const fitted = paused.length <= D.PAUSE_ITEMS_MAX ? paused
    : [...paused.slice(0, D.PAUSE_ITEMS_MAX - 1), `另有 ${paused.length - (D.PAUSE_ITEMS_MAX - 1)} 处，见约定卡`];
  return {
    versionNo,
    continuing: [...new Set(input.continuing.map(item => clipTo(item)))].slice(0, D.PAUSE_ITEMS_MAX),
    paused: fitted,
    // P74r12：记下暂停的总处数（显示的行数最多 6 行，最后一行可能是「另有 n 处」）。
    pausedTotal: paused.length,
    fallback: input.fallback === undefined ? null : clipTo(input.fallback, D.FALLBACK_MAX_CHARS),
  };
}
