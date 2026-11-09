/** 固定版本交接验证复制内容、两端授权和议程感知；接收人只收到引用与短说明。 */
import { describe, expect, it, vi } from 'vitest';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { processCommit } from '../src/commit/process.js';
import { createHandoff } from '../src/peer/handoffs.js';
import { archiveCommitArtifacts } from '../src/artifacts/archive.js';
import { createUiApi } from '../src/api/index.js';

async function team(visibility: 'only_me' | 'owner' | 'others' = 'others') {
  const world = await turnContext();
  const { ctx, bot, toolCtx } = world;
  const source = `${bot.homeDir}/work/result.txt`;
  await ctx.fs.writeTextAtomic(source, '固定版本的正文：不应进入线程与感知');
  await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress',
    worldChanges: [{ what: '交付', whoCanSee: visibility, where: source }] }));
  ctx.store.table('bots').put({ ...bot, id: 'b_peer', name: '复核员', homeDir: '/hub/bots/b_peer',
    sessionId: 'session-peer', workDataAllowed: false });
  return { ...world, source, version: ctx.store.table('artifactVersions').list()[0]! };
}

describe('F09 固定交接', () => {
  it('原文件修改后复制指定旧版，线程和接收人感知只有固定引用和说明', async () => {
    const { ctx, bot, version, source } = await team();
    await ctx.fs.writeTextAtomic(source, '新版内容');
    const row = await createHandoff(ctx, bot.id, { to: 'b_peer', task: '复核这份结论',
      why: '请核对引用来源', artifacts: [version.id] });
    expect(row.files).toHaveLength(1);
    expect(row.files[0]).toMatch(/shared\/handoffs\/.*artifact-1-v1\.txt$/);
    expect(await ctx.fs.readText(row.files[0]!)).toBe(version.content);
    const thread = ctx.store.log('thread').all().filter(message => message.kind === 'handoff');
    const percepts = ctx.store.table('percepts').list(p => p.botId === 'b_peer');
    expect(JSON.stringify(thread)).toContain(`artifact:${version.id}`);
    expect(JSON.stringify(percepts)).toContain(`artifact:${version.id}`);
    expect(JSON.stringify(thread)).not.toContain(version.content);
    expect(JSON.stringify(percepts)).not.toContain(version.content);
    expect(ctx.store.table('agenda').get(row.agendaId!)?.note).toContain(`artifact:${version.id}`);
  });
  it.each(['only_me', 'owner'] as const)('%s 不能交接进共享区，无议程、感知或副本', async visibility => {
    const { ctx, bot, version } = await team(visibility);
    await expect(createHandoff(ctx, bot.id, { to: 'b_peer', task: '复核', why: '验证',
      artifacts: [version.id] })).rejects.toThrow('同伴');
    expect(ctx.store.table('handoffs').count()).toBe(0);
    expect(ctx.store.table('agenda').count()).toBe(0);
    expect(await ctx.fs.list('/hub/shared/handoffs')).toEqual([]);
  });
  it('发起方可读工作数据不代表接收方可读；拒绝前不复制正文', async () => {
    const { ctx, bot, source, version } = await team();
    ctx.settings.workDataPaths = [`${source}/..`];
    ctx.store.table('bots').patch(bot.id, { workDataAllowed: true });
    await expect(createHandoff(ctx, bot.id, { to: 'b_peer', task: '复核', why: '验证',
      artifacts: [version.id] })).rejects.toThrow('无权');
    expect(ctx.store.table('handoffs').count()).toBe(0);
    ctx.store.table('bots').patch('b_peer', { workDataAllowed: true });
    expect((await createHandoff(ctx, bot.id, { to: 'b_peer', task: '复核', why: '验证',
      artifacts: [version.id] })).files).toHaveLength(1);
  });
  it('只允许已存在的版本；过期、超限与越界目标不发布交接', async () => {
    const { ctx, bot, version } = await team();
    const input = { to: 'b_peer', task: '复核', why: '验证' };
    await expect(createHandoff(ctx, bot.id, { ...input, artifacts: ['unknown'] })).rejects.toThrow('版本');
    await expect(createHandoff(ctx, bot.id, { ...input, artifacts: Array.from({ length: 6 }, (_, i) => `v${i}`) })).rejects.toThrow('上限');
    const original = ctx.fs.realpath.bind(ctx.fs);
    vi.spyOn(ctx.fs, 'realpath').mockImplementation(async path => path.includes('/shared/handoffs/') ? '/outside' : original(path));
    await expect(createHandoff(ctx, bot.id, { ...input, artifacts: [version.id] })).rejects.toThrow('shared');
    expect(ctx.store.table('handoffs').count()).toBe(0);
  });
  it('files 老行为与固定版本可以并存，重名不覆盖；重复版本只复制一次', async () => {
    const { ctx, bot, source, version } = await team();
    const row = await createHandoff(ctx, bot.id, { to: 'b_peer', task: '复核', why: '验证',
      files: [source], artifacts: [version.id, version.id] });
    expect(row.files).toHaveLength(2);
    expect(row.files[0]).not.toBe(row.files[1]);
    expect(await ctx.fs.readText(row.files[1]!)).toBe(version.content);
  });
  it('同路径更严格可见性不被重复 others 声明扩大；版本头丢失也不复用版本号', async () => {
    const { ctx, bot, version } = await team();
    const commit = ctx.store.table('commits').list()[0]!;
    await archiveCommitArtifacts(ctx, { ...commit, id: 'private',
      worldChanges: [...commit.worldChanges, { what: '私有', whoCanSee: 'only_me', where: 'work/../work/result.txt' }] }, []);
    const privateVersion = ctx.store.table('artifactVersions').list().find(v => v.number === 2)!;
    expect(privateVersion.visibility).toBe('only_me');
    expect(await createUiApi(ctx, async () => {}).readArtifactVersion({ versionId: privateVersion.id })).toMatchObject({ ok: false });
    ctx.store.table('artifactHeads').remove(version.artifactId);
    await archiveCommitArtifacts(ctx, { ...commit, id: 'head-recovery' }, []);
    expect(ctx.store.table('artifactVersions').list().map(v => v.number)).toEqual([1, 2, 3]);
    expect(ctx.store.table('bots').get(bot.id)?.id).toBe(bot.id);
  });
});
