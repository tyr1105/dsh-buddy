/**
 * F08 尾巴 - 任务关联产物与验收联动测试。
 * 覆盖：引用解析（头 id 跟随最新版 / 版本 id 直取）、关联命令的正反例与幂等、
 * 单任务产物上限、验收通过时给关联产物补记「通过」（幂等、只写验收表）、
 * 以及视图里的产物面板字段与「验收前提醒」口径。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { FakeClock } from '../src/io/testing/index.js';
import { initRoot } from '../src/memory/files.js';
import { createUiApi } from '../src/api/index.js';
import { ArtifactHeadSchema, ArtifactVersionSchema } from '../src/model/artifact.js';
import { resolveArtifactRef, recordAcceptancePassed } from '../src/project/artifacts.js';
import { evaluateAcceptance } from '../src/project/acceptance.js';
import { okData } from './c04-api-fixtures.js';

/** 内容指纹只校验格式，测试里用同一串 64 位十六进制。 */
const SHA = 'a'.repeat(64);

/** 建一个装了根目录的空中心，返回 ctx 与真实命令出口。 */
async function setup() {
  const ctx = createTestContext();
  await initRoot(ctx);
  const api = createUiApi(ctx, vi.fn(async () => { await ctx.store.flush(); }));
  return { ctx, api };
}

/** 测试环境类型：直接用 setup() 的返回值推导，避免可选依赖字段的类型误差。 */
type TestCtx = Awaited<ReturnType<typeof setup>>['ctx'];

/** 往产物两表塞一份产物；返回头 id 与版本 id，便于正反例引用。 */
function putArtifact(
  ctx: TestCtx,
  opts: { artifactId?: string; number?: number; title?: string; createdAt?: number } = {},
): { artifactId: string; versionId: string } {
  const artifactId = opts.artifactId ?? 'art_weekly';
  const number = opts.number ?? 1;
  const createdAt = opts.createdAt ?? ctx.clock.now() - 60_000;
  const version = ArtifactVersionSchema.parse({
    id: `av_${artifactId}_${number}`, artifactId, botId: 'bot_writer', number,
    title: opts.title ?? '第 45 周周报初稿', sourcePath: '/hub/bots/bot_writer/work/report.md',
    realPath: '/hub/bots/bot_writer/work/report.md', visibility: 'owner', content: '周报正文',
    bytes: 12, sha256: SHA, commitId: 'c_1', wakeId: 'w_1', goalIds: [], createdAt,
  });
  ctx.store.table('artifactVersions').put(version);
  ctx.store.table('artifactHeads').put(ArtifactHeadSchema.parse({
    id: artifactId, botId: 'bot_writer', sourcePath: version.sourcePath,
    lastVersion: number, createdAt, updatedAt: createdAt,
  }));
  return { artifactId, versionId: version.id };
}

/** 建项目 + 任务；返回 id。 */
async function projectWithTask(api: Awaited<ReturnType<typeof setup>>['api'], title = '写周报初稿') {
  const project = okData(await api.saveProject({ name: '竞品周报', memberBotIds: [] }));
  const task = okData(await api.saveTask({ projectId: project.id, title }));
  return { project, task };
}

/** 把任务推到待验收：直接 patch 成进行中（派活归 F12），再走交账命令。 */
async function pendingTask(api: Awaited<ReturnType<typeof setup>>['api'], ctx: TestCtx, title = '写周报初稿') {
  const { project, task } = await projectWithTask(api, title);
  ctx.store.table('projectTasks').patch(task.id, { status: 'doing' });
  okData(await api.reportDone(task.id));
  return { project, task };
}

describe('F08 产物引用解析与验收提醒（纯函数）', () => {
  it('头 id 取最新版、版本 id 直取、查不到给 null', () => {
    const versions = [
      { id: 'av_1', artifactId: 'art_a', number: 1 },
      { id: 'av_2', artifactId: 'art_a', number: 2 },
      { id: 'av_3', artifactId: 'art_b', number: 1 },
    ] as never;
    expect(resolveArtifactRef(versions, 'art_a')?.id).toBe('av_2');
    expect(resolveArtifactRef(versions, 'av_1')?.id).toBe('av_1');
    expect(resolveArtifactRef(versions, 'art_missing')).toBeNull();
  });

  it('非待验收任务没有提醒；待验收按「没产物 / 未单独验收 / 结论不合格 / 产物比任务旧」给', () => {
    expect(evaluateAcceptance({ status: 'doing', updatedAt: 100, artifacts: [] }).hints).toEqual([]);
    expect(evaluateAcceptance({ status: 'done_pending_check', updatedAt: 100, artifacts: [] }).hints[0])
      .toContain('还没有关联产物');
    const hints = evaluateAcceptance({
      status: 'done_pending_check', updatedAt: 200,
      artifacts: [{ number: 2, createdAt: 100, reviewVerdict: 'incorrect' }],
    }).hints;
    expect(hints.join('\n')).toContain('做错');
    expect(hints.join('\n')).toContain('修改之前');
    // 最新结论是通过时不再提「未验收」，只按时间新旧提醒。
    expect(evaluateAcceptance({
      status: 'done_pending_check', updatedAt: 100,
      artifacts: [{ number: 3, createdAt: 200, reviewVerdict: 'passed' }],
    }).hints).toEqual([]);
  });
});

describe('F08 任务关联产物命令', () => {
  it('挂产物头 id：写入 artifactIds、写审计，视图跟随最新版并给出验收提醒', async () => {
    const { ctx, api } = await setup();
    const { artifactId } = putArtifact(ctx, { number: 1 });
    putArtifact(ctx, { number: 2, createdAt: ctx.clock.now() - 30_000 });
    const { task } = await pendingTask(api, ctx);

    const updated = okData(await api.attachTaskArtifact({ taskId: task.id, artifactId }));
    expect(updated.artifactIds).toEqual([artifactId]);

    const row = api.projectView().projects[0]!.tasks[0]!;
    expect(row.artifactCount).toBe(1);
    expect(row.artifacts[0]).toMatchObject({
      artifactId, number: 2, title: '第 45 周周报初稿', reviewVerdict: null, isLatest: true,
    });
    expect(row.artifacts[0]!.createdText).not.toBeNull();
    expect(row.acceptance.hints.join('\n')).toContain('还没有单独验收');
    expect(ctx.store.log('audit').all().some(audit => {
      const detail = JSON.parse(String(audit.detail));
      return audit.action === 'task_artifact_attach' && detail.versionId === row.artifacts[0]!.versionId;
    })).toBe(true);
  });

  it('按版本 id 挂：图标 isLatest=false；再挂同一份产物的头 id 按幂等处理，不重复不写审计', async () => {
    const { ctx, api } = await setup();
    const { artifactId, versionId } = putArtifact(ctx, { number: 1 });
    putArtifact(ctx, { number: 2 });
    const { task } = await projectWithTask(api);
    okData(await api.attachTaskArtifact({ taskId: task.id, artifactId: versionId }));
    expect(api.projectView().projects[0]!.tasks[0]!.artifacts[0]!.isLatest).toBe(false);

    const audits = ctx.store.log('audit').all().filter(row => row.action === 'task_artifact_attach').length;
    const again = okData(await api.attachTaskArtifact({ taskId: task.id, artifactId }));
    expect(again.artifactIds).toEqual([versionId]);
    expect(ctx.store.log('audit').all().filter(row => row.action === 'task_artifact_attach').length).toBe(audits);
  });

  it('反例：任务/项目不存在、项目归档、任务已通过、产物不存在都给中文错误且不写关联', async () => {
    const { ctx, api } = await setup();
    const { artifactId } = putArtifact(ctx);
    const { project, task } = await projectWithTask(api);

    await expect(api.attachTaskArtifact({ taskId: 'pt_0000000000', artifactId }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('任务不存在') });
    await expect(api.attachTaskArtifact({ taskId: task.id, artifactId: 'art_missing' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('产物不存在') });

    ctx.store.table('projectTasks').patch(task.id, { status: 'accepted' });
    await expect(api.attachTaskArtifact({ taskId: task.id, artifactId }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('已通过验收') });
    ctx.store.table('projectTasks').patch(task.id, { status: 'todo' });
    okData(await api.archiveProject(project.id));
    await expect(api.attachTaskArtifact({ taskId: task.id, artifactId }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('已归档') });
    expect(ctx.store.table('projectTasks').get(task.id)?.artifactIds).toEqual([]);
  });

  it('单任务关联上限：到上限后中文报错，不写入第 21 条', async () => {
    const { ctx, api } = await setup();
    const { artifactId } = putArtifact(ctx);
    const { task } = await projectWithTask(api);
    ctx.store.table('projectTasks').patch(task.id, {
      artifactIds: Array.from({ length: 20 }, (_, i) => `art_old_${i}`),
    });
    await expect(api.attachTaskArtifact({ taskId: task.id, artifactId }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('最多关联') });
    expect(ctx.store.table('projectTasks').get(task.id)?.artifactIds).toHaveLength(20);
  });
});

describe('F08 验收联动：通过任务时给关联产物记通过', () => {
  it('验收通过写入 passed、审计带版本 id；重复联动幂等，视图显示「通过」', async () => {
    const { ctx, api } = await setup();
    const { artifactId, versionId } = putArtifact(ctx);
    const { task } = await pendingTask(api, ctx);
    okData(await api.attachTaskArtifact({ taskId: task.id, artifactId }));

    const accepted = okData(await api.acceptTask(task.id));
    expect(accepted.status).toBe('accepted');
    const reviews = ctx.store.table('artifactReviews').list();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ versionId, verdict: 'passed' });
    expect(ctx.store.log('audit').all().some(row => row.action === 'task_accept_artifacts')).toBe(true);
    expect(recordAcceptancePassed(ctx, accepted)).toEqual([]);
    expect(ctx.store.table('artifactReviews').count()).toBe(1);

    const row = api.projectView().projects[0]!.tasks[0]!;
    expect(row.task.status).toBe('accepted');
    expect(row.artifacts[0]!.reviewLabel).toBe('通过');
    expect(row.acceptance.hints).toEqual([]);
  });

  it('最新结论是「做错」时验收通过会补一条通过结论，旧结论保留可回溯', async () => {
    const { ctx, api } = await setup();
    const { artifactId, versionId } = putArtifact(ctx);
    const clock = ctx.clock as FakeClock;
    const { task } = await pendingTask(api, ctx);
    okData(await api.attachTaskArtifact({ taskId: task.id, artifactId }));
    ctx.store.table('artifactReviews').put({
      id: 'ar_old', versionId, botId: 'bot_writer', verdict: 'incorrect', note: '缺两家', createdAt: clock.now(),
    });
    clock.advance(1_000);
    okData(await api.acceptTask(task.id));
    const reviews = ctx.store.table('artifactReviews').list();
    expect(reviews).toHaveLength(2);
    expect(reviews.at(-1)).toMatchObject({ verdict: 'passed' });
    expect(reviews[0]).toMatchObject({ verdict: 'incorrect' });
  });

  it('没有关联产物的任务照常验收，不凭空造验收记录', async () => {
    const { ctx, api } = await setup();
    const { task } = await pendingTask(api, ctx);
    const accepted = okData(await api.acceptTask(task.id));
    expect(accepted.status).toBe('accepted');
    expect(ctx.store.table('artifactReviews').count()).toBe(0);
    expect(ctx.store.log('audit').all().some(row => row.action === 'task_accept_artifacts')).toBe(false);
  });
});
