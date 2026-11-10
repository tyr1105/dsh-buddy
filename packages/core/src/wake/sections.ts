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
/** 将外部内容包进完整不可信围栏并转义结束标记，防止正文提前逃出边界。 */
export function fence(text: string): string {
    return `<<<untrusted\n${text.replaceAll('untrusted>>>', 'untrusted>>＞')}\nuntrusted>>>`;
}
/** 按节渲染标题和正文，为标记为外部资料的章节统一添加信任围栏。 */
export function renderSections(sections: PacketSection[]): string {
    return sections.map(s => `${s.title}${s.title && s.body ? '\n' : ''}${s.untrusted ? fence(s.body) : s.body}${s.quote === undefined ? '' : `\n${fence(s.quote)}\n${s.suffix ?? ''}`}`).join('\n\n');
}
/** 每个阶段只削掉超预算的字节；后面的内容仍能容纳时，不预先删掉它。 */
export function fitSections(sections: PacketSection[], limit: number, agendaKeep: number, evidenceKeep: number): string {
    // 先转义再计量，否则关闭标记替换后的全角字符会在最终渲染时额外挤占字节。
    const copy = sections.map(s => ({ ...s, body: s.untrusted ? s.body.replaceAll('untrusted>>>', 'untrusted>>＞') : s.body,
        ...(s.quote === undefined ? {} : { quote: s.quote.replaceAll('untrusted>>>', 'untrusted>>＞') }) }));
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
    // 极端输入连必留条目也超长时，继续按节截正文；从不截断围栏或固定规矩。
    // 截断顺序：先截一般内容，再截主题的成员与楼层，主人的原话最后才动（越靠后越晚被截）。
    const lastResort = copy.filter(s => !['rules', 'header', 'limits', 'variant', 'agenda', 'evidence', 'trusted-evidence', 'topic-rules'].includes(s.key));
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
