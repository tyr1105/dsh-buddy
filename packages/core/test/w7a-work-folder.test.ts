/**
 * W7a 项目挂接主人电脑上的工作文件夹（只读）。
 * 覆盖：
 * 1 路径校验（纯函数）：能挂的几种写法；主目录本身、大目录本身、资源库、隐藏目录、主目录外、中心数据目录及其上级、凭据位置都拒绝；
 * 2 挂接命令：存下路径与真实位置；文件夹不存在、是文件、链接指向别处、项目已归档都拒绝；取消挂接；保存项目不冲掉它；
 * 3 动作闸：成员读放行，非成员读要主人确认，任何人写都拒绝且不计越界；命令里的写入同样拒绝；
 * 4 唤醒包：成员的「可查资料」段有这一行，非成员没有；
 * 5 发布位置（launch.localDir）不能落在工作文件夹里。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createUiApi } from '../src/api/index.js';
import { initRoot } from '../src/memory/files.js';
import { saveProject, archiveProject } from '../src/project/service.js';
import { WORK_FOLDER_REASONS, checkWorkFolder, setProjectWorkFolder } from '../src/project/work-folder.js';
import { checkLocalDir, localDirEnvOf, type LocalDirEnv } from '../src/project/local-dir.js';
import { gateContextFor } from '../src/gate/gate-context.js';
import { classifyToolCall } from '../src/gate/classify.js';
import { guardToolCall } from '../src/gate/guard.js';
import { buildWakePacket } from '../src/wake/packet.js';
import type { Bot, QueueEntry } from '../src/model/index.js';
import type { HubContext } from '../src/engine/context.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { createTicket } from '../src/wake/ticket.js';
import { newId } from '../src/util/ids.js';
import { createBotHome } from '../src/memory/index.js';
import { turnContext } from './c03-turn-fixtures.js';
import { botFixture } from './model-fixtures.js';
import { okData } from './c04-api-fixtures.js';

const HOME = '/Users/owner';
const REPO = `${HOME}/code/shop-site`;
const env: LocalDirEnv = { homes: [HOME], protectedRoots: [`${HOME}/AgentHub`, `${HOME}/AgentHub/bots/b_1`, `${HOME}/.dsh`] };

function reasonOf(input: string): string {
  const result = checkWorkFolder(input, env);
  if (result.ok) throw new Error(`应当被拒绝但通过了：${input}`);
  return result.reason;
}

describe('1 路径校验', () => {
  it('能挂：主目录下的具体文件夹，含 ~ 写法、中文和空格、末尾斜线', () => {
    expect(checkWorkFolder('~/code/shop-site/', env)).toEqual({ ok: true, path: REPO });
    expect(checkWorkFolder(`${HOME}/Documents/DSH solo AGENT`, env)).toEqual({ ok: true, path: `${HOME}/Documents/DSH solo AGENT` });
    expect(checkWorkFolder('~/projects', env)).toEqual({ ok: true, path: `${HOME}/projects` });
    expect(checkWorkFolder('~/Desktop/活动页面', env)).toEqual({ ok: true, path: `${HOME}/Desktop/活动页面` });
  });

  it('不能挂：每条规则各一个例子', () => {
    expect(reasonOf('~')).toBe(WORK_FOLDER_REASONS.isHome);
    expect(reasonOf('~/Documents')).toBe(WORK_FOLDER_REASONS.broad);
    expect(reasonOf('~/desktop/')).toBe(WORK_FOLDER_REASONS.broad);
    expect(reasonOf('~/Library/Mobile Documents')).toBe(WORK_FOLDER_REASONS.system);
    expect(reasonOf('~/Applications/Tool')).toBe(WORK_FOLDER_REASONS.system);
    expect(reasonOf('~/.ssh')).toBe(WORK_FOLDER_REASONS.hidden);
    expect(reasonOf('~/code/.git')).toBe(WORK_FOLDER_REASONS.hidden);
    expect(reasonOf('/etc')).toBe(WORK_FOLDER_REASONS.outsideHome);
    expect(reasonOf('/Users/other/code')).toBe(WORK_FOLDER_REASONS.outsideHome);
    expect(reasonOf('code/x')).toBe(WORK_FOLDER_REASONS.notAbsolute);
    expect(reasonOf('~/code/../.ssh')).toBe(WORK_FOLDER_REASONS.dotDot);
    expect(reasonOf('~/AgentHub/bots')).toBe(WORK_FOLDER_REASONS.center);
    expect(reasonOf('~/AgentHub')).toBe(WORK_FOLDER_REASONS.center);
    expect(reasonOf('~/Desktop/Tool.app')).toBe(WORK_FOLDER_REASONS.appBundle);
    expect(reasonOf('~/code/a"b')).toBe(WORK_FOLDER_REASONS.badChars);
    expect(reasonOf('~/code/a$b')).toBe(WORK_FOLDER_REASONS.badName);
    expect(reasonOf('~/code/server.pem')).toBe(WORK_FOLDER_REASONS.sensitive);
  });

  it('中心数据目录的上级也不能挂（会把员工的文件夹一起交出去）', () => {
    const nested: LocalDirEnv = { homes: [HOME], protectedRoots: [`${HOME}/work/AgentHub`] };
    const result = checkWorkFolder('~/work', nested);
    expect(result).toEqual({ ok: false, reason: WORK_FOLDER_REASONS.center });
  });
});

async function apiSetup() {
  const ctx = createTestContext({ ownerHome: HOME });
  await initRoot(ctx);
  await ctx.fs.mkdirp(REPO);
  await ctx.fs.writeTextAtomic(`${REPO}/README.md`, '# shop');
  return { ctx, api: createUiApi(ctx, async () => { await ctx.store.flush(); }) };
}

describe('2 挂接命令', () => {
  it('挂接：存下主人选的路径、真实位置、时间与批准人，写审计', async () => {
    const { ctx, api } = await apiSetup();
    const project = okData(await api.saveProject({ name: '网店', memberBotIds: [] }));
    const saved = okData(await api.setProjectWorkFolder({ projectId: project.id, path: '~/code/shop-site/' }));
    expect(saved.workFolder).toEqual({ path: REPO, realPath: REPO, approvedAt: ctx.clock.now(), approvedBy: 'owner' });
    const audit = ctx.store.log('audit').all().filter(row => row.action === 'project_work_folder_set');
    expect(audit).toHaveLength(1);
  });

  it('文件夹不存在、是文件、项目已归档：拒绝，项目不变', async () => {
    const { ctx, api } = await apiSetup();
    const project = okData(await api.saveProject({ name: '网店', memberBotIds: [] }));
    const missing = await api.setProjectWorkFolder({ projectId: project.id, path: `${HOME}/code/nope` });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe(`工作文件夹不能用：${WORK_FOLDER_REASONS.missing}。`);
    const file = await api.setProjectWorkFolder({ projectId: project.id, path: `${REPO}/README.md` });
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.error).toContain(WORK_FOLDER_REASONS.notDir);
    expect(ctx.store.table('projects').get(project.id)!.workFolder ?? null).toBeNull();
    archiveProject(ctx, project.id);
    const archived = await api.setProjectWorkFolder({ projectId: project.id, path: REPO });
    expect(archived.ok).toBe(false);
  });

  it('符号链接指向主目录外或隐藏目录：按真实位置再核对一次，拒绝', async () => {
    const { ctx, api } = await apiSetup();
    const project = okData(await api.saveProject({ name: '网店', memberBotIds: [] }));
    const realpath = ctx.fs.realpath.bind(ctx.fs);
    ctx.fs.realpath = async (path: string) => (path === REPO ? `${HOME}/.ssh` : realpath(path));
    const result = await api.setProjectWorkFolder({ projectId: project.id, path: REPO });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(`工作文件夹不能用：它实际指向 ${HOME}/.ssh，${WORK_FOLDER_REASONS.hidden}。`);
    ctx.fs.realpath = async (path: string) => (path === REPO ? '/private/etc' : realpath(path));
    const outside = await api.setProjectWorkFolder({ projectId: project.id, path: REPO });
    expect(outside.ok).toBe(false);
  });

  it('取消挂接、重复取消不报错；保存项目不会冲掉工作文件夹；重新挂同一处不被自己挡住', async () => {
    const { ctx, api } = await apiSetup();
    const project = okData(await api.saveProject({ name: '网店', memberBotIds: [] }));
    okData(await api.setProjectWorkFolder({ projectId: project.id, path: REPO }));
    saveProject(ctx, { id: project.id, name: '网店（改名）' });
    expect(ctx.store.table('projects').get(project.id)!.workFolder?.path).toBe(REPO);
    okData(await api.setProjectWorkFolder({ projectId: project.id, path: REPO }));
    const other = okData(await api.saveProject({ name: '同一仓库的另一个项目', memberBotIds: [] }));
    okData(await api.setProjectWorkFolder({ projectId: other.id, path: REPO }));
    const cleared = okData(await api.setProjectWorkFolder({ projectId: project.id, path: null }));
    expect(cleared.workFolder).toBeNull();
    okData(await api.setProjectWorkFolder({ projectId: project.id, path: null }));
  });
});

/** 同一上下文里再放一位员工（可跑唤醒包）。 */
async function secondBot(ctx: HubContext, id: string, name: string) {
  const now = ctx.clock.now();
  const bot: Bot = { ...botFixture, id, name, homeDir: `/hub/bots/${id}`, sessionId: `session-${id}`, sessionStartedAt: now, createdAt: now, updatedAt: now };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const entry: QueueEntry = { ...buildCandidate(ctx, { botId: id, kind: 'next_think', variant: 'regular', score: 0.8, summary: '看看', now }), id: newId('q', ctx.rng), enqueuedAt: now };
  const ticket = createTicket(ctx, entry, bot.sessionId);
  ctx.store.table('wakes').patch(ticket.id, { status: 'running', dispatchedAt: now });
  return { bot, entry, ticket: ctx.store.table('wakes').get(ticket.id)! };
}

/** 一位成员、一位非成员，项目挂了 REPO。 */
async function gateSetup() {
  const setup = await turnContext('regular');
  const { ctx, bot } = setup;
  (ctx as HubContext).ownerHome = HOME;
  await ctx.fs.mkdirp(REPO);
  const outsider = await secondBot(ctx, 'b_0000000009', '小外');
  const project = saveProject(ctx, { name: '网店', memberBotIds: [bot.id] });
  await setProjectWorkFolder(ctx, { projectId: project.id, path: REPO });
  return { ...setup, outsider, project };
}

describe('3 动作闸：只读', () => {
  it('成员读放行；非成员读要主人确认', async () => {
    const { ctx, bot, outsider } = await gateSetup();
    const member = classifyToolCall('read_file', { path: `${REPO}/README.md` }, gateContextFor(ctx, bot));
    expect(member.cls).toBe('A');
    const other = classifyToolCall('read_file', { path: `${REPO}/README.md` }, gateContextFor(ctx, outsider.bot));
    expect(other.cls).toBe('C');
    expect(other.reason).toContain('不是该项目成员');
  });

  it('写、改、删一律拒绝，沙箱开不开都一样，且不计越界', async () => {
    const { ctx, bot } = await gateSetup();
    for (const host of [undefined, { sandboxed: true }]) {
      const write = classifyToolCall('write_file', { path: `${REPO}/README.md`, content: 'x' }, gateContextFor(ctx, bot, host));
      expect(write.cls).toBe('protected');
      expect(write.subclass).toBe('work_folder_readonly');
      for (const command of [`rm -rf ${REPO}/src`, `sed -i s/a/b/ ${REPO}/README.md`, `git -C ${REPO} commit -m x`, `echo x > ${REPO}/a`, `mv ${REPO}/README.md /tmp/r`, `python3 ${REPO}/run.py`]) {
        const shell = classifyToolCall('bash', { command }, gateContextFor(ctx, bot, host));
        expect(shell.cls, command).toBe('protected');
        expect(shell.subclass, command).toBe('work_folder_readonly');
      }
      // 读、以及把文件拷到自己的文件夹里，照常放行。
      for (const command of [`cat ${REPO}/README.md`, `git -C ${REPO} log --oneline`, `cp ${REPO}/README.md ${bot.homeDir}/work/r.md`]) {
        expect(classifyToolCall('bash', { command }, gateContextFor(ctx, bot, host)).cls, command).toBe('A');
      }
    }
    const decision = await guardToolCall(ctx, bot.sessionId!, 'write_file', { path: `${REPO}/README.md`, content: 'x' });
    expect(decision.allow).toBe(false);
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(0);
  });

  it('取消挂接后，写入回到原来的规则（不再是只读拒绝）', async () => {
    const { ctx, bot, project } = await gateSetup();
    await setProjectWorkFolder(ctx, { projectId: project.id, path: null });
    const write = classifyToolCall('write_file', { path: `${REPO}/README.md`, content: 'x' }, gateContextFor(ctx, bot));
    expect(write.subclass).not.toBe('work_folder_readonly');
  });
});

describe('4 唤醒包', () => {
  it('成员的「可查资料」段有工作文件夹一行，非成员没有', async () => {
    const { ctx, bot, entry, ticket, outsider } = await gateSetup();
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain('## 可查资料');
    expect(packet).toContain(`- 项目「网店」的工作文件夹（只读，不能写改删）：${REPO}`);
    const other = await buildWakePacket(ctx, outsider.bot, outsider.entry, outsider.ticket);
    expect(other).not.toContain(REPO);
  });
});

describe('5 发布位置不能落在工作文件夹里', () => {
  it('launch.localDir 指向工作文件夹之内：拒绝', async () => {
    const { ctx } = await gateSetup();
    const result = checkLocalDir(`${HOME}/code/shop-site/dist`, localDirEnvOf(ctx));
    expect(result.ok).toBe(false);
  });
});
