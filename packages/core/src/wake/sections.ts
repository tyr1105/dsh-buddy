/** 按节压缩唤醒包：先舍弃低优先级摘要，围栏始终完整，不能在截断时把外部文本变成指令。 */
import { byteLength, truncateBytes } from '../util/text.js';
export interface PacketSection {
    key: string;
    title: string;
    body: string;
    untrusted?: boolean;
    quote?: string;
    suffix?: string;
}
/** 围栏标记被转义之后换成的文字（P75r6 第 7 节：与真正的标记明显不同，模型不会把它当成标记）。 */
export const FENCE_MARK_ESCAPED = '〔围栏标记已转义〕';
/** 零宽字符与文字方向控制符：不显示，却能把一个标记拆开骗过简单的文字匹配，判断「像不像标记」时先去掉。 */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
/** 围栏的开始标记与结束标记，各一个正则：字符之间允许夹空白，不分大小写（匹配前文字已做 NFKC 归一并去掉零宽字符）。 */
const FENCE_MARK_PATTERNS = ['<<<untrusted', 'untrusted>>>'].map(mark => new RegExp([...mark].join('\\s*'), 'gi'));
/**
 * P75r6 第 7 节（复验 N7）：把文字里「像围栏标记」的部分换成 FENCE_MARK_ESCAPED，开始标记和结束标记都处理。
 * 「像」的判断：先做 NFKC 归一（全角字符变半角）、去掉零宽字符，不分大小写，忽略标记中间的空白；
 * 命中的那一段按原文位置整段替换（原文里夹着的零宽字符、空白随之一起被替换掉）。
 * 为什么不再用「把最后一个字符换成全角」：转义后的样子与真标记几乎一样，模型可能当成标记；而且大写、中间加空格、全角、
 * 夹零宽字符这些变体原来不处理。没有命中时原样返回。
 */
export function escapeFenceMarks(text: string): string {
    // 逐个码点归一，并记下归一后每个 UTF-16 单元对应原文里的哪一段，匹配之后才能按原文位置替换。
    const norm: string[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    let at = 0;
    for (const ch of text) {
        const width = ch.length;
        for (const unit of ch.normalize('NFKC')) {
            if (INVISIBLE.test(unit)) continue;
            for (let k = 0; k < unit.length; k += 1) { norm.push(unit[k]!); starts.push(at); ends.push(at + width); }
        }
        at += width;
    }
    const flat = norm.join('');
    const ranges: Array<[number, number]> = [];
    for (const pattern of FENCE_MARK_PATTERNS) {
        for (const match of flat.matchAll(pattern)) {
            const first = match.index!;
            ranges.push([starts[first]!, ends[first + match[0].length - 1]!]);
        }
    }
    if (ranges.length === 0) return text;
    // 重叠的合并成一段（「<<<untrusted>>>」同时命中两个标记）。
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([range[0], range[1]]);
    }
    let out = '';
    let cursor = 0;
    for (const [from, to] of merged) { out += text.slice(cursor, from) + FENCE_MARK_ESCAPED; cursor = to; }
    return out + text.slice(cursor);
}
/** 将外部内容包进完整不可信围栏并转义开始、结束标记，防止正文提前逃出边界。 */
export function fence(text: string): string {
    return `<<<untrusted\n${escapeFenceMarks(text)}\nuntrusted>>>`;
}
/** 按节渲染标题和正文，为标记为外部资料的章节统一添加信任围栏。 */
export function renderSections(sections: PacketSection[]): string {
    return sections.map(s => `${s.title}${s.title && s.body ? '\n' : ''}${s.untrusted ? fence(s.body) : s.body}${s.quote === undefined ? '' : `\n${fence(s.quote)}\n${s.suffix ?? ''}`}`).join('\n\n');
}
/** 每个阶段只削掉超预算的字节；后面的内容仍能容纳时，不预先删掉它。 */
export function fitSections(sections: PacketSection[], limit: number, agendaKeep: number, evidenceKeep: number): string {
    // 先转义再计量，否则关闭标记替换后的全角字符会在最终渲染时额外挤占字节。
    const copy = sections.map(s => ({ ...s, body: s.untrusted ? escapeFenceMarks(s.body) : s.body,
        ...(s.quote === undefined ? {} : { quote: escapeFenceMarks(s.quote) }) }));
    /** 仅削减当前超预算的正文并保留指定下限，避免提前丢失仍能容纳的事实。 */
    const shrink = (section: PacketSection, minimum = ''): void => {
        // 证据中的引文先缩短；围栏单独渲染，截断永远不会把外部内容泄露到可信正文。
        if (section.quote !== undefined) {
            const quoteExcess = byteLength(renderSections(copy)) - limit;
            if (quoteExcess > 0) section.quote = truncateBytes(section.quote, Math.max(0, byteLength(section.quote) - quoteExcess));
        }
        const excess = byteLength(renderSections(copy)) - limit;
        if (excess <= 0)
            return;
        const target = Math.max(byteLength(minimum), byteLength(section.body) - excess);
        section.body = target === byteLength(minimum) ? minimum : truncateBytes(section.body, target);
    };
    for (const key of ['changes', 'memory', 'routines']) {
        const section = copy.find(s => s.key === key);
        if (section)
            shrink(section);
    }
    for (const [keys, keep] of [[['agenda'], agendaKeep], [['evidence', 'trusted-evidence'], evidenceKeep]] as const) {
        let remaining = keep;
        for (const section of copy.filter(s => keys.some(key => key === s.key))) {
            // 逐条结构化证据超出保留数量时可整条移除，连同围栏和时间一起删，避免空引文耗尽预算。
            if (remaining === 0 && section.quote !== undefined && byteLength(renderSections(copy)) > limit) {
                copy.splice(copy.indexOf(section), 1);
                continue;
            }
            const rows = section.body.split('\n');
            const minimum = rows.slice(0, remaining).join('\n');
            remaining = Math.max(0, remaining - rows.length);
            shrink(section, minimum);
        }
    }
    // P74c 登记：key 为 job 的「你手上的事」段、agreements 约定段、team-card 组队段都自带上限、不计入原有预算（packet.ts 另加额度），
    // 它们在这里和别的普通段一样可以被截断；总管守则（chief-rules）在下面的名单里，永远不被截断。
    // 极端输入连必留条目也超长时，继续按节截正文；从不截断围栏或固定规矩。
    // 截断顺序：先截一般内容，再截主题的成员与楼层，主人的原话最后才动（越靠后越晚被截）。
    // P75r6 第 7 节（N8）：技能段（key 为 skill）同样不参与这一级截断：它自带上限、不计入预算、自己会逐级压缩，
    // 段里内嵌多个围栏，从尾部截会截掉最后一个围栏的结束标记和段末「怎样提交」的调用写法。
    const lastResort = copy.filter(s => !['rules', 'header', 'limits', 'variant', 'agenda', 'evidence', 'trusted-evidence', 'topic-rules', 'chief-rules', 'skill'].includes(s.key));
    const shrinkRank = (key: string): number => key === 'owner' ? 3 : key === 'topic-floor-first' ? 2 : key === 'topic' || key === 'topic-floor' ? 1 : 0;
    for (const section of [...lastResort].sort((a, b) => shrinkRank(a.key) - shrinkRank(b.key)))
        shrink(section);
    // 保留前十项/前五条的身份；超长的单条正文逐条缩短，仍让模型知道有哪些事项。
    if (byteLength(renderSections(copy)) > limit) {
        const preserved = copy.filter(s => ['agenda', 'evidence', 'trusted-evidence'].includes(s.key));
        const rows = preserved.flatMap(section => section.body.split('\n').map(text => ({ section, text })));
        for (const section of preserved)
            section.body = '';
        const available = limit - byteLength(renderSections(copy)) - rows.length;
        const share = Math.max(0, Math.floor(available / Math.max(1, rows.length)));
        for (const section of preserved)
            section.body = rows.filter(row => row.section === section)
                .map(row => truncateBytes(row.text, share)).join('\n');
    }
    if (byteLength(renderSections(copy)) > limit)
        throw new Error('唤醒包上限过小，无法容纳必要规矩与上限说明');
    return renderSections(copy);
}
