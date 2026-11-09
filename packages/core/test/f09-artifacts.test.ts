/** F09 用真实交账与文件写入验证固定版本；每条失败都检查没有正文读取或伪造成功。 */
import { describe, it, expect, vi } from 'vitest';
import { processCommit } from '../src/commit/process.js';
import { archiveCommitArtifacts } from '../src/artifacts/archive.js';
import { artifactList } from '../src/artifacts/views.js';
import { readArtifactVersion } from '../src/artifacts/access.js';
import { createUiApi } from '../src/api/index.js';
import { FileStore } from '../src/store/file-store.js';
import { F09_DEFAULTS, resolveSettings } from '../src/config/defaults.js';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { goalFixture } from './model-fixtures.js';
import { runTool } from '../src/tools/index.js';

/** 文件写好再交账；返回可继续修改原文件的世界与第一版。 */
export async function archived(visibility: 'owner' | 'only_me' | 'others' = 'owner') {
  const world = await turnContext();
  const source = `${world.bot.homeDir}/work/result.html`;
  await world.ctx.fs.writeTextAtomic(source, '<script>danger()</script>\n有来源的结论');
  world.ctx.store.table('goals').put(goalFixture);
  const result = await processCommit(world.ctx, world.toolCtx, commitArgs({
    outcome: 'done', evidence: [goalFixture.id],
    worldChanges: [{ what: '交付结果', whoCanSee: visibility, where: 'work/result.html' }],
  }));
  expect(result.ok).toBe(true);
  return { ...world, source, commit: world.ctx.store.table('commits').list()[0]!,
    version: world.ctx.store.table('artifactVersions').list()[0]! };
}

describe('F09 固定版本与交账', () => {
  it('完整归档关联交账/唤醒/目标；重入幂等，原文件变化或删除不改变旧正文', async () => {
    const { ctx, source, version, commit, bot } = await archived();
    expect(version).toMatchObject({ number: 1, botId: bot.id, commitId: commit.id, wakeId: commit.wakeId,
      goalIds: [goalFixture.id], bytes: Buffer.byteLength(version.content), visibility: 'owner' });
    await archiveCommitArtifacts(ctx, commit, [goalFixture]);
    expect(ctx.store.table('artifactVersions').count()).toBe(1);
    await ctx.fs.writeTextAtomic(source, '第二版');
    const next = { ...commit, id: 'c_second', createdAt: ctx.clock.now() + 1 };
    await archiveCommitArtifacts(ctx, next, [goalFixture]);
    const versions = ctx.store.table('artifactVersions').list();
    expect(versions.map(row => row.number)).toEqual([1, 2]);
    expect(versions[1]?.artifactId).toBe(version.artifactId);
    expect(versions[1]?.sha256).not.toBe(version.sha256);
    await ctx.fs.remove(source);
    expect((await readArtifactVersion(ctx, version.id, { kind: 'owner' })).content).toBe(version.content);
    expect((await readArtifactVersion(ctx, `artifact:${version.id}`, { kind: 'owner' })).content).toBe(version.content);
    expect((await readArtifactVersion(ctx, versions[1]!.id, { kind: 'owner' })).content).toBe('第二版');
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('done_pending_check');
  });
  it('并发归档同次交账只产生一个版本，规范化路径同一产物不制造重复', async () => {
    const { ctx, commit, version } = await archived();
    ctx.store.table('artifactBatches').remove(commit.id);
    const args = { ...commit, worldChanges: [...commit.worldChanges,
      { what: '重复', whoCanSee: 'only_me' as const, where: 'work/../work/result.html' }] };
    await Promise.all([archiveCommitArtifacts(ctx, args, []), archiveCommitArtifacts(ctx, args, [])]);
    expect(ctx.store.table('artifactVersions').count()).toBe(1);
    expect(ctx.store.table('artifactVersions').get(version.id)?.content).toBe(version.content);
  });
  it.each([
    ['work/.env', '来源不在'], ['work/credentials.yaml', '来源不在'],
    ['/outside/file.txt', '来源不在'], ['https://example.test/result', '不支持'],
    ['', '不支持'], ['work/../mind/goals.md', '来源不在'],
  ])('禁止位置 %s 不读取正文、不联网，交账保留', async (where, reason) => {
    const { ctx, toolCtx } = await turnContext();
    const bytes = vi.spyOn(ctx.fs, 'readBytes');
    const get = vi.spyOn(ctx.net, 'get');
    expect(await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress',
      worldChanges: [{ what: '结果', whoCanSee: 'owner', where }] }))).toMatchObject({ ok: true });
    expect(ctx.store.table('artifactVersions').count()).toBe(0);
    expect(ctx.store.table('artifactBatches').list()[0]?.items[0]?.detail).toContain(reason);
    expect(bytes).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    expect(ctx.store.table('commits').count()).toBe(1);
  });
  it.each([['missing', null, '不存在'], ['empty', '', '为空'], ['whitespace', ' \n', '空白']])(
    '%s 明确未归档，不制造版本', async (_kind, content, reason) => {
      const { ctx, toolCtx, bot } = await turnContext();
      if (content !== null) await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/result.txt`, content!);
      await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress',
        worldChanges: [{ what: '结果', whoCanSee: 'owner', where: 'work/result.txt' }] }));
      expect(ctx.store.table('artifactVersions').count()).toBe(0);
      expect(ctx.store.table('artifactBatches').list()[0]?.items[0]?.detail).toContain(reason);
    });
  it('目录、超限普通文件在读取前拒绝', async () => {
    const { ctx, commit, source } = await archived();
    for (const stat of [{ isFile: false, isDir: true, size: 10, mtimeMs: 0 },
      { isFile: true, isDir: false, size: F09_DEFAULTS.maxBytes + 1, mtimeMs: 0 }]) {
      vi.spyOn(ctx.fs, 'stat').mockResolvedValue(stat);
      const read = vi.spyOn(ctx.fs, 'readBytes');
      await archiveCommitArtifacts(ctx, { ...commit, id: `c_${stat.size}` }, []);
      expect(read).not.toHaveBeenCalled(); expect(ctx.store.table('artifactVersions').count()).toBe(1);
      vi.restoreAllMocks();
    }
    expect(source).toContain('/work/');
  });
  it.each([new Uint8Array([0xc3, 0x28]), new Uint8Array([65, 0, 66])])(
    '无效 UTF-8 或二进制控制字节拒绝完整归档', async bytes => {
      const { ctx, commit } = await archived();
      vi.spyOn(ctx.fs, 'stat').mockResolvedValue({ isFile: true, isDir: false, size: bytes.length, mtimeMs: 0 });
      vi.spyOn(ctx.fs, 'readBytes').mockResolvedValue(bytes);
      const batch = await archiveCommitArtifacts(ctx, { ...commit, id: 'binary' }, []);
      expect(batch.items[0]?.versionId).toBeNull();
      expect(ctx.store.table('artifactVersions').count()).toBe(1);
    });
  it('64 KiB 完整保留，超过一字节拒绝，UTF-8 BOM 不丢失', async () => {
    const { ctx, commit, source } = await archived();
    for (const [id, content] of [['exact', '\ufeff' + 'a'.repeat(F09_DEFAULTS.maxBytes - 3)],
      ['oversize', 'a'.repeat(F09_DEFAULTS.maxBytes + 1)]]) {
      await ctx.fs.writeTextAtomic(source, content!);
      const batch = await archiveCommitArtifacts(ctx, { ...commit, id: id! }, []);
      if (id === 'exact') expect((await readArtifactVersion(ctx, batch.items[0]!.versionId!, { kind: 'owner' })).content).toBe(content);
      else expect(batch.items[0]?.versionId).toBeNull();
    }
  });
  it('越界链接、工作数据原路径和目录别名在读前拒绝', async () => {
    const { ctx, commit, source } = await archived();
    const read = vi.spyOn(ctx.fs, 'readBytes');
    for (const target of ['/owner/.ssh/id_rsa', '/outside/file.txt']) {
      vi.spyOn(ctx.fs, 'realpath').mockImplementation(async path => path === source ? target : path);
      await archiveCommitArtifacts(ctx, { ...commit, id: target }, []);
      expect(read).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
    ctx.settings.workDataPaths = [`${source}/..`];
    const batch = await archiveCommitArtifacts(ctx, { ...commit, id: 'work-data' }, []);
    expect(batch.items[0]?.detail).toContain('工作数据');
    ctx.settings.workDataPaths = ['/alias'];
    vi.spyOn(ctx.fs, 'realpath').mockImplementation(async path => path === '/alias' ? `${source}/..` : path);
    const alias = await archiveCommitArtifacts(ctx, { ...commit, id: 'alias' }, []);
    expect(alias.items[0]?.detail).toContain('工作数据');
  });
  it('读取后路径替换与元信息变化均拒绝，不泄露底层读取故障', async () => {
    const { ctx, commit, source } = await archived();
    const original = ctx.fs.readBytes.bind(ctx.fs);
    vi.spyOn(ctx.fs, 'readBytes').mockImplementation(async path => {
      const bytes = await original(path);
      vi.spyOn(ctx.fs, 'realpath').mockImplementation(async p => p === source ? '/outside/replaced' : p);
      return bytes;
    });
    expect((await archiveCommitArtifacts(ctx, { ...commit, id: 'swapped' }, [])).items[0]?.versionId).toBeNull();
    vi.restoreAllMocks();
    vi.spyOn(ctx.fs, 'stat').mockResolvedValueOnce({ size: 10, isFile: true, isDir: false, mtimeMs: 0 })
      .mockResolvedValueOnce({ size: 10, isFile: true, isDir: false, mtimeMs: 1 });
    vi.spyOn(ctx.fs, 'readBytes').mockResolvedValue(Buffer.from('abcdefghij'));
    expect((await archiveCommitArtifacts(ctx, { ...commit, id: 'changed' }, [])).items[0]?.detail).toContain('发生变化');
    vi.restoreAllMocks();
    vi.spyOn(ctx.fs, 'readBytes').mockRejectedValue(new Error('敏感错误正文'));
    const failure = await archiveCommitArtifacts(ctx, { ...commit, id: 'failure' }, []);
    expect(failure.items[0]?.detail).toBe('文件读取失败，未归档');
    expect(JSON.stringify(failure)).not.toContain('敏感错误正文');
  });
  it('位置与保留版本上限可下调；超过上限明确未归档', async () => {
    const { ctx, source, commit } = await archived();
    ctx.settings.artifacts.maxLocations = 1;
    ctx.settings.artifacts.maxVersionsPerBot = 1;
    const batch = await archiveCommitArtifacts(ctx, { ...commit, id: 'cap',
      worldChanges: [...commit.worldChanges, { what: '更多', whoCanSee: 'owner', where: source + '.other' }] }, []);
    expect(batch.items).toHaveLength(2);
    expect(batch.items.every(item => item.versionId === null)).toBe(true);
    expect(batch.items[0]?.detail).toContain('上限');
    expect(batch.items[1]?.detail).toContain('本轮上限');
    expect(batch.items[1]?.visibility).toBe('owner');
    expect(() => resolveSettings({ artifacts: { maxBytes: F09_DEFAULTS.maxBytes + 1 } })).toThrow('maxBytes');
  });
});

describe('F09 查阅、验收与保留', () => {
  it.each(['only_me', 'owner', 'others'] as const)('%s 作者、主人、同伴可见性正反例', async visibility => {
    const { ctx, version, bot } = await archived(visibility);
    ctx.store.table('bots').put({ ...bot, id: 'b_peer', sessionId: 'peer-session', workDataAllowed: false });
    expect((await readArtifactVersion(ctx, version.id, { kind: 'bot', botId: bot.id })).id).toBe(version.id);
    const owner = createUiApi(ctx, async () => {}).readArtifactVersion({ versionId: version.id });
    expect((await owner).ok).toBe(visibility !== 'only_me');
    const peer = readArtifactVersion(ctx, version.id, { kind: 'bot', botId: 'b_peer' });
    if (visibility === 'others') expect((await peer).id).toBe(version.id);
    else await expect(peer).rejects.toThrow('无权');
    expect((await artifactList(ctx, bot.id, { kind: 'owner' })).versions).toHaveLength(visibility === 'only_me' ? 0 : 1);
  });
  it('已归档版本仍受当前工作数据权限控制，撤销后不能绕过', async () => {
    const { ctx, source, bot, version } = await archived('others');
    ctx.settings.workDataPaths = [`${source}/..`];
    await expect(readArtifactVersion(ctx, version.id, { kind: 'owner' })).rejects.toThrow('无权');
    ctx.store.table('bots').patch(bot.id, { workDataAllowed: true });
    expect((await readArtifactVersion(ctx, version.id, { kind: 'owner' })).id).toBe(version.id);
    ctx.store.table('bots').put({ ...bot, id: 'b_peer', sessionId: 'peer-session', workDataAllowed: false });
    await expect(readArtifactVersion(ctx, version.id, { kind: 'bot', botId: 'b_peer' })).rejects.toThrow('无权');
  });
  it('查看不刷盘、不调度，指定旧版验收不完成目标；失败输入不产生记录', async () => {
    const { ctx, version, commit, source } = await archived();
    await ctx.fs.writeTextAtomic(source, '第二版');
    await archiveCommitArtifacts(ctx, { ...commit, id: 'next' }, []);
    const after = vi.fn(async () => {});
    const api = createUiApi(ctx, after);
    expect((await api.readArtifactVersion({ versionId: version.id })).ok).toBe(true);
    expect(after).not.toHaveBeenCalled();
    for (const verdict of ['passed', 'not_done', 'incorrect', 'mismatch']) {
      expect((await api.reviewArtifact({ versionId: version.id, verdict, note: '只评这一版' })).ok).toBe(true);
      expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('done_pending_check');
    }
    expect(ctx.store.table('artifactReviews').count()).toBe(4);
    await api.reviewArtifact({ versionId: version.id, verdict: 'mismatch', note: '只评这一版' });
    expect(ctx.store.table('artifactReviews').count()).toBe(4);
    expect((await api.bot(version.botId)).artifacts?.versions.find(row => row.number === 2)?.review).toBeNull();
    expect(await api.reviewArtifact({ versionId: version.id, verdict: 'other' })).toMatchObject({ ok: false });
    expect(await api.readArtifactVersion({ versionId: '' })).toMatchObject({ ok: false });
    ctx.store.table('artifactVersions').patch(version.id, { content: '篡改' });
    expect(await api.readArtifactVersion({ versionId: version.id })).toMatchObject({ ok: false });
  });
  it('新工具守身份、只读回合与授权；状态摘要只放固定引用', async () => {
    const { ctx, version, toolCtx, ticket } = await archived();
    const result = await runTool(ctx, toolCtx, 'hub_artifact_read', { versionId: version.id });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining(version.content) });
    expect(await runTool(ctx, toolCtx, 'hub_artifact_read', { versionId: `artifact:${version.id}` }))
      .toMatchObject({ ok: true, text: expect.stringContaining(version.content) });
    expect(await runTool(ctx, { ...toolCtx, sessionId: 'fake' }, 'hub_artifact_read', { versionId: version.id })).toMatchObject({ ok: false });
    ctx.store.table('wakes').patch(ticket.id, { variant: 'reflection' });
    expect(await runTool(ctx, toolCtx, 'hub_artifact_read', { versionId: version.id })).toMatchObject({ ok: true });
    const state = await runTool(ctx, toolCtx, 'hub_state_get', {});
    expect(state).toMatchObject({ ok: true, text: expect.stringContaining(`artifact:${version.id}`) });
    if (state.ok) expect(state.text).not.toContain(version.content);
  });
  it('独立表落盘恢复、90 天边界、清理后版本号继续；旧档不编造产物', async () => {
    const { ctx, version, commit } = await archived();
    const api = createUiApi(ctx, async () => {});
    await api.reviewArtifact({ versionId: version.id, verdict: 'passed' });
    const fileStore = new FileStore(ctx.fs, ctx.clock, ctx.settings.rootDir, ctx.settings.timezone, ctx.logger);
    for (const name of ['artifactHeads', 'artifactVersions', 'artifactReviews', 'artifactBatches'] as const)
      for (const row of ctx.store.table(name).list()) fileStore.table(name).put(row as never);
    await fileStore.flush();
    const restored = new FileStore(ctx.fs, ctx.clock, ctx.settings.rootDir, ctx.settings.timezone, ctx.logger);
    await restored.load();
    expect(restored.table('artifactVersions').get(version.id)).toEqual(version);
    expect(restored.table('artifactReviews').count()).toBe(1);
    await ctx.store.prune(ctx.clock.now() + F09_DEFAULTS.retentionMs);
    expect(ctx.store.table('artifactVersions').count()).toBe(1);
    await ctx.store.prune(ctx.clock.now() + F09_DEFAULTS.retentionMs + 1);
    expect(ctx.store.table('artifactVersions').count()).toBe(0);
    expect(ctx.store.table('artifactReviews').count()).toBe(0);
    expect(ctx.store.table('artifactHeads').get(version.artifactId)?.lastVersion).toBe(1);
    await archiveCommitArtifacts(ctx, { ...commit, id: 'after-prune', createdAt: ctx.clock.now() + F09_DEFAULTS.retentionMs + 2 }, []);
    expect(ctx.store.table('artifactVersions').list()[0]?.number).toBe(2);
    const legacy = await turnContext();
    expect((await createUiApi(legacy.ctx, async () => {}).bot(legacy.bot.id)).artifacts).toEqual({ versions: [], unarchived: [] });
  });
});
