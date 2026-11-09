/** 轮询测试覆盖首次基线、实际变化、白名单拒绝与并发隔离，不访问真实网络或执行真实命令。 */
import { describe, expect, it } from 'vitest';
import { pollDueWatches } from '../src/perception/poll.js';
import { parseFeed } from '../src/perception/rss.js';
import { splitCommand, validateCommand } from '../src/perception/script.js';
import { readableHttpText } from '../src/perception/http.js';
import { readWatchState } from '../src/perception/watch-state.js';
import { fingerprint } from '../src/util/hash.js';
import { botFixture, watchFixture } from './model-fixtures.js';
import { perceptionContext, response, minute } from './perception-fixtures.js';

const url = 'https://example.test/feed';
const feed = (...items: string[]) => `<rss><channel>${items.map(id => `<item><guid>${id}</guid><title>标题 ${id}</title><link>https://example.test/${id}</link></item>`).join('')}</channel></rss>`;
const output = (stdout: string, code = 0) => ({ code, stdout, stderr: '', timedOut: false });

describe('HTTP 与订阅轮询', () => {
  it('HTTP 首次只建基线，相同内容不报，变化后给前三行新增', async () => {
    const ctx = perceptionContext({ kind: 'http', target: url, intervalMs: 15 * minute });
    ctx.net.set(url, response('<p>旧内容</p>'));
    expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.advance(15 * minute); expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
    ctx.net.set(url, response('<p>第一行</p><p>第二行</p><p>第三行</p><p>第四行</p>'));
    ctx.clock.advance(15 * minute);
    expect((await pollDueWatches(ctx, ctx.clock.now()))[0]).toMatchObject({ kind: 'changed', magnitude: 1, summary: '第一行\n第二行\n第三行', untrusted: true });
    expect(ctx.net.calls[0]?.opts).toEqual({ timeoutMs: 20_000, maxBytes: 512 * 1024 });
  });
  it('HTTP 保留换行、删除脚本和样式正文', () => {
    expect(readableHttpText('<style>secret</style><script>hidden</script><p>A</p>\n<p>B</p>')).toBe('A\nB');
  });
  it('HTTP 未到期、暂停关注项不会执行', async () => {
    const ctx = perceptionContext({ kind: 'http', target: url }); ctx.net.set(url, response('A'));
    await pollDueWatches(ctx, ctx.clock.now()); ctx.clock.advance(14 * minute); await pollDueWatches(ctx, ctx.clock.now());
    expect(ctx.net.calls).toHaveLength(1);
    ctx.store.table('watches').patch(watchFixture.id, { status: 'paused' }); ctx.clock.advance(2 * minute); await pollDueWatches(ctx, ctx.clock.now());
    expect(ctx.net.calls).toHaveLength(1);
  });
  it('HTTP 非成功状态保留基线并记录错误', async () => {
    const ctx = perceptionContext({ kind: 'http', target: url }); ctx.net.set(url, response('A')); await pollDueWatches(ctx, ctx.clock.now());
    const mark = ctx.store.table('watches').get(watchFixture.id)?.lastFingerprint;
    ctx.net.set(url, response('bad', 503)); ctx.clock.advance(15 * minute); await pollDueWatches(ctx, ctx.clock.now());
    const watch = ctx.store.table('watches').get(watchFixture.id)!;
    // M02 改为完整正文指纹与行哈希基线；失败仍必须保留同一份可比较信息。
    expect(watch.lastFingerprint).toBe(mark); expect(readWatchState(watch)).toMatchObject({ lineHashes: [fingerprint('A')], totalLines: 1, consecutiveFailures: 1, lastError: '网页请求失败：HTTP 503' });
    expect(readWatchState(watch).text).toBeUndefined();
  });
  it('RSS 首次只建已见集合，后来仅新增条目产生感知', async () => {
    const ctx = perceptionContext({ kind: 'rss', target: url }); ctx.net.set(url, response(feed('a', 'b')));
    expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
    ctx.net.set(url, response(feed('b', 'a'))); ctx.clock.advance(15 * minute); expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
    ctx.net.set(url, response(feed('b', 'c', 'd'))); ctx.clock.advance(15 * minute);
    expect((await pollDueWatches(ctx, ctx.clock.now()))[0]).toMatchObject({ kind: 'new_items', magnitude: 0.4, summary: '标题 c\n标题 d' });
  });
  it('解析 Atom 的 id、title 和链接属性', () => {
    expect(parseFeed('<feed><entry><id>urn:a</id><title><![CDATA[新消息]]></title><link rel="alternate" href="https://example.test/a"/></entry></feed>')).toEqual([{ id: 'urn:a', title: '新消息', link: 'https://example.test/a' }]);
  });
  it('条目无 id 时用链接兜底，相同条目去重', () => {
    expect(parseFeed('<rss><item><title>A</title><link>url</link></item><item><title>A</title><link>url</link></item></rss>')).toEqual([{ id: 'url', title: 'A', link: 'url' }]);
  });
  it('RSS 已见条目最多 200 且 lastValue 不超过 4 KB', async () => {
    const ctx = perceptionContext({ kind: 'rss', target: url }); ctx.net.set(url, response(feed(...Array.from({ length: 250 }, (_, i) => String(i)))));
    await pollDueWatches(ctx, ctx.clock.now()); const watch = ctx.store.table('watches').get(watchFixture.id)!;
    expect(readWatchState(watch).seenIds).toHaveLength(200); expect(Buffer.byteLength(watch.lastValue!)).toBeLessThanOrEqual(4096);
  });
  it('无效订阅不覆盖原有已见集合', async () => {
    const ctx = perceptionContext({ kind: 'rss', target: url }); ctx.net.set(url, response(feed('a'))); await pollDueWatches(ctx, ctx.clock.now());
    ctx.net.set(url, response('<html>登录页面</html>')); ctx.clock.advance(15 * minute); await pollDueWatches(ctx, ctx.clock.now());
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!).seenIds).toHaveLength(1);
  });
});

describe('脚本白名单与输出对比', () => {
  it('按空白和双引号保留参数边界', () => {
    expect(splitCommand('node "work/report one.js" "a b" ""')).toEqual(['node', 'work/report one.js', 'a b', '']);
  });
  it.each(['git status; cat x', 'ls | cat', 'cat $(pwd)', 'node "unclosed'])('拒绝不支持的命令语法 %s', command => {
    expect(() => splitCommand(command)).toThrow();
  });
  it.each(['curl https://example.test', 'git push', 'git -c x=y status', 'node -e code', 'python3 -c code', 'node ../outside.js', '/usr/bin/python3 x.py'])('拒绝白名单外程序或越界脚本 %s', async command => {
    const ctx = perceptionContext(); await expect(validateCommand(ctx, botFixture.homeDir, command)).rejects.toThrow(); expect(ctx.exec.calls).toHaveLength(0);
  });
  it.each(['git status', 'git log', 'git diff', 'git show', 'ls', 'cat file', 'wc file'])('允许白名单 %s', async command => {
    const ctx = perceptionContext(); await expect(validateCommand(ctx, botFixture.homeDir, command)).resolves.toBeDefined();
  });
  it('允许已有家目录脚本和 node/python3 脚本参数', async () => {
    const ctx = perceptionContext(); const script = `${botFixture.homeDir}/work/test.js`; await ctx.fs.writeTextAtomic(script, 'print');
    expect(await validateCommand(ctx, botFixture.homeDir, 'node work/test.js')).toEqual({ cmd: 'node', args: [script] });
    expect(await validateCommand(ctx, botFixture.homeDir, 'python3 work/test.js')).toEqual({ cmd: 'python3', args: [script] });
    expect(await validateCommand(ctx, botFixture.homeDir, './work/test.js')).toEqual({ cmd: script, args: [] });
  });
  it('拒绝不存在脚本和目录', async () => {
    const ctx = perceptionContext(); await ctx.fs.mkdirp(`${botFixture.homeDir}/work`);
    await expect(validateCommand(ctx, botFixture.homeDir, 'node work/missing.js')).rejects.toThrow(/已有/);
    await expect(validateCommand(ctx, botFixture.homeDir, 'node work')).rejects.toThrow(/已有/);
  });
  it('脚本首轮只建基线，stdout 改变产生 output_changed', async () => {
    const ctx = perceptionContext({ kind: 'script', target: 'git status', intervalMs: 5 * minute }); ctx.exec.set('git', ['status'], output('clean'));
    expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
    ctx.exec.set('git', ['status'], output('modified')); ctx.clock.advance(5 * minute);
    expect((await pollDueWatches(ctx, ctx.clock.now()))[0]).toMatchObject({ kind: 'output_changed', magnitude: 0.6, anomaly: false });
    expect(ctx.exec.calls[0]?.opts).toEqual({ cwd: botFixture.homeDir, timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
      sandbox: { writableRoots: [botFixture.homeDir] } });
  });
  it('脚本退出码从零变非零产生异常，恢复不算异常', async () => {
    const ctx = perceptionContext({ kind: 'script', target: 'git status' }); ctx.exec.set('git', ['status'], output('same')); await pollDueWatches(ctx, ctx.clock.now());
    ctx.exec.set('git', ['status'], output('same', 1)); ctx.clock.advance(5 * minute);
    expect((await pollDueWatches(ctx, ctx.clock.now()))[0]).toMatchObject({ kind: 'exit_changed', anomaly: true });
    ctx.exec.set('git', ['status'], output('same')); ctx.clock.advance(5 * minute);
    expect((await pollDueWatches(ctx, ctx.clock.now()))[0]).toMatchObject({ anomaly: false });
  });
  it('脚本白名单拒绝也记录关注项错误，不执行程序', async () => {
    const ctx = perceptionContext({ kind: 'script', target: 'git push' }); await pollDueWatches(ctx, ctx.clock.now());
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!).consecutiveFailures).toBe(1); expect(ctx.exec.calls).toHaveLength(0);
  });
});

describe('轮询并发与失败隔离', () => {
  it('同时执行不超过 3 个，所有到期关注项最终检查', async () => {
    const ctx = perceptionContext(); let concurrent = 0; let max = 0; let count = 0;
    for (let i = 1; i <= 7; i++) ctx.store.table('watches').put({ ...watchFixture, id: `wt_000000000${i}`, kind: 'http', target: `${url}/${i}` });
    ctx.net.get = async () => { count++; concurrent++; max = Math.max(max, concurrent); await Promise.resolve(); concurrent--; return response('A'); };
    await pollDueWatches(ctx, ctx.clock.now()); expect(max).toBe(3); expect(count).toBe(7);
  });
  it('一个关注项失败不影响另一个，第三次失败立即 P2，恢复关闭', async () => {
    const ctx = perceptionContext({ kind: 'http', target: url }); ctx.net.set(url, new Error('网络不可用'));
    ctx.store.table('watches').put({ ...watchFixture, id: 'wt_0000000002', kind: 'http', target: `${url}/ok` }); ctx.net.set(`${url}/ok`, response('A'));
    for (let i = 0; i < 3; i++) { await pollDueWatches(ctx, ctx.clock.now()); ctx.clock.advance(15 * minute); }
    expect(ctx.store.table('watches').get('wt_0000000002')?.lastFingerprint).not.toBeNull();
    expect(ctx.store.table('alerts').list(a => a.status === 'open')[0]).toMatchObject({ botId: botFixture.id, level: 'P2' });
    ctx.net.set(url, response('recovered')); await pollDueWatches(ctx, ctx.clock.now());
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!)).toMatchObject({ consecutiveFailures: 0, lastError: null });
    expect(ctx.store.table('alerts').list(a => a.status === 'open')).toEqual([]);
  });
});

// 超长 feed 与损坏状态的回归：缓存容量上限不能导致旧消息在每次轮询时重新出现。
describe('轮询状态边界', () => {
  it('超过 200 条的未变化 feed 不重复报告旧条目', async () => {
    const ctx = perceptionContext({ kind: 'rss', target: url });
    ctx.net.set(url, response(feed(...Array.from({ length: 250 }, (_, i) => String(i)))));
    await pollDueWatches(ctx, ctx.clock.now()); ctx.clock.advance(15 * minute);
    expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
    ctx.net.set(url, response(feed('new', ...Array.from({ length: 250 }, (_, i) => String(i)))));
    ctx.clock.advance(15 * minute); expect((await pollDueWatches(ctx, ctx.clock.now()))[0]?.summary).toBe('标题 new');
    ctx.clock.advance(15 * minute); expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
  });
  it('不合法的 lastValue 结构按空状态读取', () => {
    expect(readWatchState({ ...watchFixture, lastValue: '{"seenIds":7,"consecutiveFailures":"x"}' })).toEqual({});
    expect(readWatchState({ ...watchFixture, lastValue: 'bad-json' })).toEqual({});
  });
});
