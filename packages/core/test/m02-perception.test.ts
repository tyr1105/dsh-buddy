/** M02 感知维护回归：用真实存在的基线、假时钟和可控 I/O 钉住误报、轮转与过滤安全边界。 */
import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { createRuntime } from '../src/engine/context.js';
import { syncFileWatches, flushFileEvents } from '../src/perception/files.js';
import { fileBaselinePath } from '../src/perception/file-baseline.js';
import { readWatchState } from '../src/perception/watch-state.js';
import { checkExpectations } from '../src/perception/expectations.js';
import { matchesWatchFilter, validateWatchFilter } from '../src/perception/filter.js';
import { pollDueWatches } from '../src/perception/poll.js';
import { validateCommand } from '../src/perception/script.js';
import { onExternalSessionEvent } from '../src/perception/sessions.js';
import { validateWatchProposal } from '../src/tools/hub-watch-propose.js';
import { validateWatchUpdate } from '../src/tools/hub-watch-update.js';
import { botFixture, watchFixture } from './model-fixtures.js';
import { perceptionContext, response, minute, hour } from './perception-fixtures.js';
import { apiFixture, okData } from './c04-api-fixtures.js';
import type { Watch } from '../src/model/perception.js';

const url = 'https://example.test/review';
const pendingExpectation = { text: '每天按时更新', everyMs: null, byLocalTime: '09:00', weekdays: null, lastSatisfiedAt: null, lastMissedAt: null };
/** 只推进注入时钟，既不真实等待也不让去抖时间依赖测试机器速度。 */
async function flush(ctx: ReturnType<typeof perceptionContext>) { ctx.clock.advance(2 * minute); return flushFileEvents(ctx, ctx.clock.now()); }
/** 模拟进程重启：保留文件与存储，丢掉监听、批次和运行态。 */
function restart(ctx: ReturnType<typeof perceptionContext>) {
  for (const dispose of ctx.runtime.watchDisposers.values()) dispose();
  ctx.runtime = createRuntime(ctx.clock.now());
}

describe('M02 C02[12] HTTP 完整指纹与行哈希', () => {
  it('超过 4 KB 的 200 行网页只改第 150 行，摘要和强度只反映该行', async () => {
    const ctx = perceptionContext({ kind: 'http', target: url });
    const lines = Array.from({ length: 200 }, (_, i) => `第 ${i} 条：${'这是一段稳定的中文正文。'.repeat(8)}`);
    ctx.net.set(url, response(lines.join('\n'))); await pollDueWatches(ctx, ctx.clock.now());
    const baseline = ctx.store.table('watches').get(watchFixture.id)!;
    expect(Buffer.byteLength(baseline.lastValue!)).toBeLessThanOrEqual(4096);
    expect(readWatchState(baseline)).toMatchObject({ totalLines: 200 });
    expect(readWatchState(baseline).lineHashes).toHaveLength(200);
    expect(readWatchState(baseline).text).toBeUndefined();
    lines[149] = '真正变化的第 150 行'; ctx.net.set(url, response(lines.join('\n'))); ctx.clock.advance(15 * minute);
    const percept = (await pollDueWatches(ctx, ctx.clock.now()))[0]!;
    expect(percept.summary).toBe(lines[149]); expect(percept.magnitude).toBe(2 / 200); expect(percept.tier).toBe('pile');
    ctx.clock.advance(15 * minute); expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
  });
  it('超过 200 行只存有限哈希，并以总行数估算而不把未保存旧行虚报新增', async () => {
    const ctx = perceptionContext({ kind: 'http', target: url });
    const lines = Array.from({ length: 300 }, (_, i) => `稳定内容 ${i}`);
    ctx.net.set(url, response(lines.join('\n'))); await pollDueWatches(ctx, ctx.clock.now());
    lines[120] = '采样内的新事实'; ctx.net.set(url, response(lines.join('\n'))); ctx.clock.advance(15 * minute);
    expect((await pollDueWatches(ctx, ctx.clock.now()))[0]).toMatchObject({ summary: '采样内的新事实', magnitude: 2 / 300 });
    lines[250] = '采样外的新事实'; ctx.net.set(url, response(lines.join('\n'))); ctx.clock.advance(15 * minute);
    const percept = (await pollDueWatches(ctx, ctx.clock.now()))[0]!;
    expect(percept.summary).toContain('行哈希范围之外'); expect(percept.magnitude).toBe(1 / 300);
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!).lineHashes).toHaveLength(200);
  });
});

describe('M02 C02[13][14][22] 文件持久基线与监听', () => {
  it('长路径目录的完整基线独立保存，连续重启不把未变化文件报成新建', async () => {
    const target = '/hub/very-long-directory/components/feature'; const ctx = perceptionContext({ target });
    for (let i = 0; i < 120; i++) await ctx.fs.writeTextAtomic(`${target}/module-${i}.ts`, 'old');
    await syncFileWatches(ctx);
    const baseline = JSON.parse((await ctx.fs.readText(fileBaselinePath(ctx, watchFixture.id)))!) as { entries: object };
    expect(Object.keys(baseline.entries)).toHaveLength(120);
    expect(Buffer.byteLength(JSON.stringify(baseline))).toBeGreaterThan(4096);
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!).sizes).toBeUndefined();
    for (let i = 0; i < 3; i++) { restart(ctx); ctx.clock.advance(minute); await syncFileWatches(ctx); expect(await flush(ctx)).toEqual([]); }
    await ctx.fs.writeTextAtomic(`${target}/module-0.ts`, 'new'); expect((await flush(ctx))[0]?.kind).toBe('changed');
  });
  it('升级时旧 sizes 已被截断，也只补 mtime 晚于旧检查时刻的变化', async () => {
    const target = '/hub/legacy'; const ctx = perceptionContext({ target });
    await ctx.fs.writeTextAtomic(`${target}/known.txt`, 'old'); await ctx.fs.writeTextAtomic(`${target}/omitted.txt`, 'old');
    ctx.clock.advance(minute); const checkedAt = ctx.clock.now();
    ctx.store.table('watches').patch(watchFixture.id, { lastCheckedAt: checkedAt, lastValue: JSON.stringify({ sizes: { [`${target}/known.txt`]: 3 } }) });
    await syncFileWatches(ctx); expect(await flush(ctx)).toEqual([]);
    const baseline = JSON.parse((await ctx.fs.readText(fileBaselinePath(ctx, watchFixture.id)))!); expect(Object.keys(baseline.entries)).toHaveLength(2);
  });
  it('目录超过 2000 条只比较数量，同数量重写不报，新增写明限制', async () => {
    const target = '/hub/many'; const ctx = perceptionContext({ target });
    for (let i = 0; i < 2001; i++) await ctx.fs.writeTextAtomic(`${target}/${i}.txt`, 'old');
    await syncFileWatches(ctx);
    const baseline = JSON.parse((await ctx.fs.readText(fileBaselinePath(ctx, watchFixture.id)))!);
    expect(baseline).toMatchObject({ count: 2001, overflow: true, entries: {} });
    await ctx.fs.writeTextAtomic(`${target}/0.txt`, 'new'); expect(await flush(ctx)).toEqual([]);
    await ctx.fs.writeTextAtomic(`${target}/new.txt`, 'new');
    const percept = (await flush(ctx))[0]!; expect(percept.summary).toBe('文件太多，只比较数量：2001 → 2002');
    restart(ctx); await syncFileWatches(ctx); expect(await flush(ctx)).toEqual([]);
  });
  it.each(['file', 'log'] as const)('单文件 %s 监听父目录且非递归，轮转后继续接收追加并过滤同目录噪声', async kind => {
    const target = '/hub/logs/app.log'; const ctx = perceptionContext({ kind, target }); await ctx.fs.writeTextAtomic(target, 'old\n');
    const calls: Array<{ path: string; recursive: boolean }> = [];
    const watch = ctx.fs.watch.bind(ctx.fs);
    ctx.fs.watch = (path, opts, callback) => { calls.push({ path, recursive: opts.recursive }); return watch(path, opts, callback); };
    await syncFileWatches(ctx); expect(calls).toEqual([{ path: dirname(target), recursive: false }]);
    await ctx.fs.remove(target); await ctx.fs.writeTextAtomic(target, 'rotated\n'); expect(await flush(ctx)).toHaveLength(1);
    await ctx.fs.appendText(target, 'after rotation\n'); expect((await flush(ctx))[0]?.summary).toContain(kind === 'log' ? 'after rotation' : 'app.log');
    await ctx.fs.writeTextAtomic('/hub/logs/noise.log', 'noise\n'); expect(await flush(ctx)).toEqual([]);
  });
  it('父目录事件遗漏时由每次 sync 的 mtime 或 inode 检查补回，处理后不重复补扫', async () => {
    const target = '/hub/atomic.txt'; const ctx = perceptionContext({ target }); await ctx.fs.writeTextAtomic(target, 'same');
    const stat = ctx.fs.stat.bind(ctx.fs); let inode = 1;
    ctx.fs.stat = async path => { const info = await stat(path); return info && path === target ? { ...info, inode } : info; };
    ctx.fs.watch = () => () => undefined; await syncFileWatches(ctx);
    inode = 2; await ctx.fs.writeTextAtomic(target, 'same'); await syncFileWatches(ctx);
    expect(ctx.runtime.pendingFileEvents.size).toBe(1); expect((await flush(ctx))[0]?.kind).toBe('changed');
    await syncFileWatches(ctx); expect(ctx.runtime.pendingFileEvents.size).toBe(0);
    ctx.clock.advance(minute); await ctx.fs.writeTextAtomic(target, 'size'); await syncFileWatches(ctx); expect(await flush(ctx)).toHaveLength(1);
  });
  it('两次重叠同步只注册一次，换 ctx 包装保留批次，暂停能取消全部监听', async () => {
    const target = '/hub/concurrent.txt'; const ctx = perceptionContext({ target }); await ctx.fs.writeTextAtomic(target, 'old');
    const original = ctx.fs.watch.bind(ctx.fs); let registered = 0; let disposed = 0;
    ctx.fs.watch = (path, opts, callback) => { registered++; const stop = original(path, opts, callback); return () => { disposed++; stop(); }; };
    await Promise.all([syncFileWatches(ctx), syncFileWatches({ ...ctx })]); expect(registered).toBe(1);
    await ctx.fs.writeTextAtomic(target, 'new'); await syncFileWatches({ ...ctx }); expect(ctx.runtime.pendingFileEvents.size).toBe(1); expect(registered).toBe(1);
    ctx.store.table('watches').patch(watchFixture.id, { status: 'paused' }); await syncFileWatches(ctx);
    expect(disposed).toBe(1); expect(ctx.runtime.watchDisposers.size).toBe(0);
  });
});

describe('M02 C02[15][23][33] 期望事实与期限', () => {
  it('截止前一分钟新增日志仍在去抖批次时不误报期望落空', async () => {
    const target = '/hub/expect.log'; const ctx = perceptionContext({ kind: 'log', target, expectation: pendingExpectation });
    ctx.clock.set(Date.parse('2026-11-05T08:58:00+08:00')); await ctx.fs.writeTextAtomic(target, 'old\n'); await syncFileWatches(ctx);
    ctx.clock.advance(minute); await ctx.fs.appendText(target, '按时完成\n'); ctx.clock.advance(minute + 5000);
    expect(await flushFileEvents(ctx, ctx.clock.now())).toEqual([]); expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.advance(minute); expect(await flushFileEvents(ctx, ctx.clock.now())).toHaveLength(1);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]); expect(ctx.store.table('percepts').list(p => p.kind === 'expectation_missed')).toEqual([]);
  });
  it('重启补扫已发现离线新增日志时，在批次合并前也不报落空', async () => {
    const target = '/hub/offline.log'; const ctx = perceptionContext({ kind: 'log', target, expectation: pendingExpectation });
    ctx.clock.set(Date.parse('2026-11-04T08:30:00+08:00')); await ctx.fs.writeTextAtomic(target, 'old\n'); await syncFileWatches(ctx); restart(ctx);
    ctx.clock.set(Date.parse('2026-11-05T08:30:00+08:00')); await ctx.fs.appendText(target, '按时输出\n');
    ctx.clock.set(Date.parse('2026-11-05T10:00:00+08:00')); await syncFileWatches(ctx);
    expect(ctx.runtime.pendingFileEvents.size).toBe(1); expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    expect(await flush(ctx)).toHaveLength(1); expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
  });
  it.each(['file', 'http', 'rss'] as const)('%s 真实变化满足 expectation，无变化不会伪造满足', async kind => {
    const target = kind === 'file' ? '/hub/expected.csv' : url;
    const ctx = perceptionContext({ kind, target, expectation: { ...pendingExpectation, byLocalTime: null, everyMs: hour } });
    if (kind === 'file') { await ctx.fs.writeTextAtomic(target, 'old'); await syncFileWatches(ctx); }
    else { ctx.net.set(target, response(kind === 'http' ? 'old' : '<rss><item><guid>old</guid><title>旧</title></item></rss>')); await pollDueWatches(ctx, ctx.clock.now()); }
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBeNull();
    const fileChangedAt = ctx.clock.now();
    if (kind === 'file') { await ctx.fs.writeTextAtomic(target, 'new'); expect(await flush(ctx)).toHaveLength(1); }
    else { ctx.net.set(target, response(kind === 'http' ? 'new' : '<rss><item><guid>new</guid><title>新</title></item></rss>')); ctx.clock.advance(15 * minute); expect(await pollDueWatches(ctx, ctx.clock.now())).toHaveLength(1); }
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBe(kind === 'file' ? fileChangedAt : ctx.clock.now());
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
  });
  it('脚本成功且输出符合条件即满足，失败或不匹配不满足，恒定输出也能刷新满足', async () => {
    const ctx = perceptionContext({ kind: 'script', target: 'git status', filter: 'ok', expectation: pendingExpectation });
    const output = (stdout: string, code = 0) => ({ stdout, code, stderr: '', timedOut: false });
    ctx.exec.set('git', ['status'], output('not ready')); await pollDueWatches(ctx, ctx.clock.now());
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBeNull();
    ctx.exec.set('git', ['status'], output('ok', 1)); ctx.clock.advance(5 * minute); await pollDueWatches(ctx, ctx.clock.now());
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBeNull();
    ctx.exec.set('git', ['status'], output('ok')); ctx.clock.advance(5 * minute); await pollDueWatches(ctx, ctx.clock.now());
    const first = ctx.clock.now(); expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBe(first);
    ctx.clock.advance(5 * minute); expect(await pollDueWatches(ctx, ctx.clock.now())).toEqual([]);
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBe(first + 5 * minute);
  });
  it('会话关注的匹配事件也写满足事实，非匹配会话不写', () => {
    const ctx = perceptionContext({ kind: 'session', target: '报告', expectation: pendingExpectation });
    const event = { type: 'finished' as const, sessionId: 'session-example', title: '其他工作', summary: '完成', at: ctx.clock.now() };
    expect(onExternalSessionEvent(ctx, event)).toEqual([]);
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBeNull();
    expect(onExternalSessionEvent(ctx, { ...event, title: '报告完成' })).toHaveLength(1);
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBe(ctx.clock.now());
  });
  it('同日第二次落空即使旧指纹被换掉也不写感知或重复评估日志', () => {
    const ctx = perceptionContext({ expectation: pendingExpectation });
    // 关注项在当日期限前已经生效，本例继续只验证落空去重与次日恢复。
    ctx.store.table('watches').patch(watchFixture.id, { createdAt: ctx.clock.now() - 2 * hour });
    const first = checkExpectations(ctx, ctx.clock.now()); expect(first).toHaveLength(1);
    ctx.store.table('percepts').patch(first[0]!.id, { fingerprint: 'ffffffffffffffff' });
    const count = ctx.store.log('appraisals').all().length;
    ctx.clock.advance(hour); expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    expect(ctx.store.log('appraisals').all()).toHaveLength(count);
    ctx.clock.advance(24 * hour); expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
  });
});

describe('M02 C02[16] C03[28] 受限过滤规则', () => {
  it('主人界面的创建与修改同样拒绝危险正则，原关注项保持不变', async () => {
    const { ctx, api, bot } = await apiFixture();
    const input = { botId: bot.id, kind: 'http' as const, target: url, why: '公开更新', filter: '/^(a+)+$/' };
    const denied = await api.upsertWatch(input); expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('filter');
    expect(ctx.store.table('watches').count()).toBe(0);
    const valid = okData(await api.upsertWatch({ ...input, filter: '/^ok$/' })) as Watch;
    const modified = await api.upsertWatch({ ...input, id: valid.id }); expect(modified.ok).toBe(false);
    expect(ctx.store.table('watches').get(valid.id)?.filter).toBe('/^ok$/');
  });
  it.each(['/^(a+)+$/', '/(.*)*/', '/(\\w+\\s?)+$/', '/((a+))+/','/(a|aa)+$/', '/a+a+a+b/', '/(a)\\1/', '/(?<x>a)\\k<x>/', `/${'a'.repeat(201)}/`])('创建与修改都拒绝危险过滤 %s', filter => {
    const ctx = perceptionContext({ filter: null });
    const proposal = { kind: 'http' as const, target: url, why: '检查更新', filter };
    expect(() => validateWatchProposal(ctx, botFixture.id, proposal)).toThrow(/filter/);
    expect(() => validateWatchUpdate(ctx, botFixture.id, { id: watchFixture.id, filter })).toThrow(/filter/);
  });
  it.each(['关键词', '/ERROR/', '/^error [0-9]+$/', '/(?:ok|done)$/', `/${'a'.repeat(200)}/`])('关键词与简单正则仍可创建和修改 %s', filter => {
    const ctx = perceptionContext({ filter: null });
    expect(() => validateWatchProposal(ctx, botFixture.id, { kind: 'http', target: url, why: '更新', filter })).not.toThrow();
    expect(() => validateWatchUpdate(ctx, botFixture.id, { id: watchFixture.id, filter })).not.toThrow();
  });
  it('匹配文本只取 64 KB，旧持久数据里的危险正则也不会执行', () => {
    const ctx = perceptionContext();
    expect(matchesWatchFilter('END', `END${'x'.repeat(65536)}`, ctx.settings)).toBe(true);
    expect(matchesWatchFilter('/END/', `${'x'.repeat(65536)}END`, ctx.settings)).toBe(false);
    expect(matchesWatchFilter('/^(a+)+$/', `${'a'.repeat(24)}!`, ctx.settings)).toBe(false);
    expect(() => validateWatchFilter('/[/', ctx.settings)).toThrow('正则表达式无效');
  });
});

describe('M02 C02[26][30] 白名单拒绝与失败阈值', () => {
  it.each(['cat /Users/owner/.dsh/.credentials.yaml', 'cat $HOME/.ssh/id_rsa', 'cat ../../../.dsh/x', 'node work/private.key'])('中心直接执行的脚本关注也拒绝敏感参数 %s', async command => {
    const ctx = perceptionContext({ kind: 'script', target: command });
    await pollDueWatches(ctx, ctx.clock.now()); expect(ctx.exec.calls).toHaveLength(0);
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!).lastError).toContain('敏感凭据路径');
  });
  it('脚本关注在每次执行前复核工作数据授权，已授权只读仍可执行', async () => {
    const ctx = perceptionContext({ kind: 'script', target: 'cat /company/report.txt' });
    ctx.settings.workDataPaths = ['/company'];
    await expect(validateCommand(ctx, botFixture.homeDir, 'cat /company/report.txt')).rejects.toThrow('尚未允许访问工作数据');
    ctx.store.table('bots').patch(botFixture.id, { workDataAllowed: true });
    await expect(validateCommand(ctx, botFixture.homeDir, 'cat /company/report.txt')).resolves.toEqual({ cmd: 'cat', args: ['/company/report.txt'] });
  });
  it('边界外脚本真实存在仍明确拒绝越界，不能靠不存在错误碰巧通过', async () => {
    const ctx = perceptionContext(); await ctx.fs.writeTextAtomic('/hub/bots/outside.js', 'exists');
    await expect(validateCommand(ctx, botFixture.homeDir, 'node ../outside.js')).rejects.toThrow('必须位于机器人家目录内');
    await ctx.fs.writeTextAtomic('/usr/bin/python3', 'exists');
    await expect(validateCommand(ctx, botFixture.homeDir, '/usr/bin/python3 x.py')).rejects.toThrow('必须位于机器人家目录内');
    expect(ctx.exec.calls).toHaveLength(0);
  });
  it.each(['node -e code', 'python3 -c code', 'python3 -m code'])('家目录存在相同选项名文件仍拒绝内联入口 %s', async command => {
    const ctx = perceptionContext(); await ctx.fs.writeTextAtomic(`${botFixture.homeDir}/${command.split(' ')[1]}`, 'exists');
    await expect(validateCommand(ctx, botFixture.homeDir, command)).rejects.toThrow('必须位于机器人家目录内');
  });
  it.each(['--output=/tmp/x', '--output /tmp/x', '--ext-diff', '--textconv', '--exec=code'])('git 的危险参数有独立显式拒绝 %s', async option => {
    const ctx = perceptionContext(); await expect(validateCommand(ctx, botFixture.homeDir, `git diff ${option}`)).rejects.toThrow('git 关注项只允许');
  });
  it('第 1、2 次失败没有 P2，第 3 次才告警，成功后重新从 1 次累计', async () => {
    const ctx = perceptionContext({ kind: 'http', target: url }); ctx.net.set(url, new Error('短暂失败'));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await pollDueWatches(ctx, ctx.clock.now());
      expect(ctx.store.table('alerts').list(a => a.status === 'open')).toHaveLength(attempt < 3 ? 0 : 1);
      ctx.clock.advance(15 * minute);
    }
    expect(ctx.store.table('alerts').list(a => a.status === 'open')[0]?.level).toBe('P2');
    ctx.net.set(url, response('recovered')); await pollDueWatches(ctx, ctx.clock.now());
    expect(ctx.store.table('alerts').list(a => a.status === 'open')).toHaveLength(0);
    ctx.net.set(url, new Error('再次短暂失败')); ctx.clock.advance(15 * minute); await pollDueWatches(ctx, ctx.clock.now());
    expect(ctx.store.table('alerts').list(a => a.status === 'open')).toHaveLength(0);
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!).consecutiveFailures).toBe(1);
  });
});
