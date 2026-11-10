/**
 * 主题里的点名解析（P63，纯函数）：从一句话里找出 @ 了哪些队友。
 *
 * 为什么不沿用团队线程那套「名字后必须是空格或标点」：
 * 中文里常写成「@小王帮忙看下」，名字后面紧跟文字。那套规则会漏掉这种点名，
 * 被点名的队友叫不醒，讨论就断了；而在主题里漏点名比多点名代价大得多。
 *
 * 防误伤的办法：调用方把全队的名册都传进来，按名字从长到短匹配，同一段文字只算一次。
 * 这样「@小王子」会先匹配到队友「小王子」，不会被算成「小王」。
 * 这里不判断在不在岗、是不是项目成员，只回答「点了谁」，规则留给调用方。
 */

/** 只依赖 id 和名字，测试不用造完整的队友档案。 */
export interface Mentionable {
  id: string;
  name: string;
}

/** 半角和全角的 @ 都算点名：输入法切换时两种都可能打出来。 */
const MENTION_MARKS = ['@', '＠'] as const;

/** 按出现顺序返回被点名的队友，同一个人点多次只算一次。 */
export function parseMentions<T extends Mentionable>(text: string, roster: readonly T[]): T[] {
  const spans: Array<{ bot: T; start: number; end: number }> = [];
  // 长名字优先：先占住「@小王子」这段文字，「小王」就匹配不到它了。
  const byLength = roster.filter(bot => bot.name.trim() !== '').sort((a, b) => b.name.length - a.name.length);
  for (const bot of byLength) {
    for (const mark of MENTION_MARKS) {
      const token = `${mark}${bot.name}`;
      let start = text.indexOf(token);
      while (start >= 0) {
        const end = start + token.length;
        if (!spans.some(span => start < span.end && end > span.start)) spans.push({ bot, start, end });
        start = text.indexOf(token, end);
      }
    }
  }
  const ordered = spans.sort((a, b) => a.start - b.start).map(span => span.bot);
  return [...new Map(ordered.map(bot => [bot.id, bot])).values()];
}
