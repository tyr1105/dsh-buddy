/**
 * F08 共享目录物理创建（尾巴批次七）——界面命令出口测试。
 * 覆盖：
 * - 新建项目默认 sharedDir 真的建出目录；
 * - 显式目录先规范化（尾斜杠、..）再递归创建；
 * - 相对路径、projects 根目录、界外路径一律拒绝，不建目录、不留项目记录；
 * - 重复保存幂等，目录被删后能补回来；
 * - 旧记录目录被改到界外时保存被拒，不往界外碰盘；
 * - 建目录失败返回中文错误点名项目与路径，项目记录已保存（保守默认：下次保存重试）。
 * 物理创建只发生在 API 出口；服务层 saveProject 仍是同步纯逻辑，直接调用不会碰盘。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createUiApi } from '../src/api/index.js';
import { initRoot } from '../src/memory/files.js';
import { saveProject } from '../src/project/service.js';
import { ensureProjectSharedDir, normalizeProjectSharedDir } from '../src/project/shared-dir.js';
import { okData } from './c04-api-fixtures.js';

/** 界面测试出口：afterCommand 真实 flush，与既有项目 API 测试同一口径。 */
async function apiSetup() {
  const ctx = createTestContext();
  await initRoot(ctx);
  const after = vi.fn(async () => { await ctx.store.flush(); });
  return { ctx, api: createUiApi(ctx, after) };
}

describe('F08 共享目录物理创建（界面命令出口）', () => {
  it('新建项目：默认 sharedDir 落在 rootDir/projects/<id> 并真的建出目录', async () => {
    const { ctx, api } = await apiSetup();
    const project = okData(await api.saveProject({ name: '默认目录', memberBotIds: [] }));
    expect(project.sharedDir).toBe(`/hub/projects/${project.id}/`);
    const stat = await ctx.fs.stat(`/hub/projects/${project.id}`);
    expect(stat?.isDir).toBe(true);
  });

  it('显式目录：规范化尾斜杠与 .. 后递归创建', async () => {
    const { ctx, api } = await apiSetup();
    const project = okData(await api.saveProject({
      name: '显式目录', memberBotIds: [], sharedDir: '/hub/projects/team/../reports/',
    }));
    expect(project.sharedDir).toBe('/hub/projects/reports/');
    expect((await ctx.fs.stat('/hub/projects/reports'))?.isDir).toBe(true);
  });

  it('相对路径、projects 根目录与界外路径一律拒绝，不建目录也不留项目记录', async () => {
    const { ctx, api } = await apiSetup();
    const relative = await api.saveProject({ name: '相对', memberBotIds: [], sharedDir: 'projects/a' });
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.error).toContain('项目目录必须是绝对路径');

    const root = await api.saveProject({ name: '根目录', memberBotIds: [], sharedDir: '/hub/projects/' });
    expect(root.ok).toBe(false);
    if (!root.ok) expect(root.error).toContain('项目目录必须位于 /hub/projects/ 下');

    const outside = await api.saveProject({ name: '越界', memberBotIds: [], sharedDir: '/tmp/evil' });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error).toContain('项目目录必须位于 /hub/projects/ 下');

    expect(ctx.store.table('projects').count()).toBe(0);
    expect(await ctx.fs.stat('/tmp/evil')).toBeNull();
    expect(await ctx.fs.stat('/hub/projects/a')).toBeNull();
  });

  it('重复保存幂等：目录被删掉后再次保存能补回来', async () => {
    const { ctx, api } = await apiSetup();
    const project = okData(await api.saveProject({ name: '可补回', memberBotIds: [] }));
    const dir = `/hub/projects/${project.id}`;
    await ctx.fs.remove(dir);
    expect(await ctx.fs.stat(dir)).toBeNull();

    const again = okData(await api.saveProject({ id: project.id, name: '可补回', memberBotIds: [] }));
    expect(again.sharedDir).toBe(`${dir}/`);
    expect((await ctx.fs.stat(dir))?.isDir).toBe(true);
  });

  it('旧记录目录被改到界外：保存被拒，不往界外建目录', async () => {
    const { ctx, api } = await apiSetup();
    const project = okData(await api.saveProject({ name: '被改坏', memberBotIds: [] }));
    ctx.store.table('projects').patch(project.id, { sharedDir: '/etc/agent-hub/' });

    const result = await api.saveProject({ id: project.id, name: '被改坏', memberBotIds: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('项目目录必须位于 /hub/projects/ 下');
    expect(await ctx.fs.stat('/etc/agent-hub')).toBeNull();
  });

  it('建目录失败：中文错误点名项目与路径，项目记录已保存（下次保存重试）', async () => {
    const { ctx, api } = await apiSetup();
    // 先在实际目录位置放一个文件，让 mkdirp 撞上「父路径不是目录」。
    await ctx.fs.writeTextAtomic('/hub/projects/blocked', '占位文件');
    const result = await api.saveProject({
      name: '失败目录', memberBotIds: [], sharedDir: '/hub/projects/blocked/sub',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('项目「失败目录」目录创建失败');
      expect(result.error).toContain('/hub/projects/blocked/sub');
    }
    // 保守默认：项目记录已经写入，下一次保存会再尝试建目录。
    expect(ctx.store.table('projects').count()).toBe(1);
    expect(await ctx.fs.stat('/hub/projects/blocked/sub')).toBeNull();
  });
});

describe('F08 共享目录边界函数', () => {
  it('normalizeProjectSharedDir：补尾斜杠、折叠 ..，拒绝 projects 根目录', () => {
    const ctx = createTestContext();
    expect(normalizeProjectSharedDir(ctx, '/hub/projects/a/')).toBe('/hub/projects/a/');
    expect(normalizeProjectSharedDir(ctx, '/hub/projects/x/../b')).toBe('/hub/projects/b/');
    expect(() => normalizeProjectSharedDir(ctx, '/hub/projects')).toThrow('项目目录必须位于 /hub/projects/ 下');
    expect(() => normalizeProjectSharedDir(ctx, '/hub/projects-evil/a')).toThrow('项目目录必须位于 /hub/projects/ 下');
  });

  it('ensureProjectSharedDir 直接调用幂等；界外目录被拒且不碰盘', async () => {
    const ctx = createTestContext();
    const project = saveProject(ctx, { name: '直接建', memberBotIds: [] });
    const dir = await ensureProjectSharedDir(ctx, project);
    expect(dir).toBe(`/hub/projects/${project.id}`);
    await ensureProjectSharedDir(ctx, project); // 第二次不抛错
    expect((await ctx.fs.stat(dir))?.isDir).toBe(true);

    const tampered = { ...project, sharedDir: '/var/tmp/evil/' };
    await expect(ensureProjectSharedDir(ctx, tampered)).rejects.toThrow('项目目录必须位于 /hub/projects/ 下');
    expect(await ctx.fs.stat('/var/tmp/evil')).toBeNull();
  });
});
