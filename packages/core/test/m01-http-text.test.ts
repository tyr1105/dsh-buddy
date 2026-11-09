/** M01 网页回归：比较式附近的正文变化必须进入感知，纯标记变化不能误报。 */
import { describe, expect, it } from 'vitest';
import { pollDueWatches } from '../src/perception/poll.js';
import { perceptionContext, response, minute } from './perception-fixtures.js';

const url = 'https://example.test/prices';

describe('M01 网页比较式正文', () => {
  it('小于号后价格变化会改变指纹并生成感知', async () => {
    const ctx = perceptionContext({ kind: 'http', target: url, intervalMs: 15 * minute });
    ctx.net.set(url, response('价格 a < b 时原价<span>有效</span>'));
    expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);

    ctx.net.set(url, response('价格 a < b 时降价<span>有效</span>'));
    ctx.clock.advance(15 * minute);
    const changes = await pollDueWatches(ctx, ctx.clock.now());
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'changed', summary: '价格 a < b 时降价 有效' });
  });

  it('比较式正文不变时仅替换标签不会产生感知', async () => {
    const ctx = perceptionContext({ kind: 'http', target: url });
    ctx.net.set(url, response('比较 a<b<span>保持</span>'));
    await pollDueWatches(ctx, ctx.clock.now());

    ctx.net.set(url, response('比较 a<b<strong>保持</strong>'));
    ctx.clock.advance(15 * minute);
    expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
  });
});
