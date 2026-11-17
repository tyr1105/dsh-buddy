/**
 * 把队友家目录里的东西复制进自己所在项目的项目文件夹（P69，工具 hub_project_put 的实现）。
 *
 * 为什么需要：DSH 的沙箱只让队友写自己的家目录，项目文件夹在沙箱之外，队友自己的工具写不进去。
 * 项目文件夹是主人给项目成员的操作空间，所以成员经中心把成品放进去，不需要审批；
 * 这个工具就是那条「中心代写」的路。
 *
 * 设计纪律（先全部检查完、全部读进内存，再开始写，任何一项不合规就整次不写）：
 * 1. 项目：只认自己是成员（含负责人）、没有归档的项目。不是成员和项目不存在回答一模一样，不泄露项目存在。
 * 2. 来源 from：真实位置必须在自己家目录内；不跟随符号链接（遇到直接报错并说是哪一个）；
 *    不能是敏感凭据路径，不能是中心维护的受保护文件（mind/、memory/journal/、家目录的 AGENTS.md）。
 * 3. 落点 to：必须留在项目文件夹内（不许 ../ 逃出去）；项目文件夹或它里面任何一级是符号链接就拒绝；
 *    不能覆盖由中心维护的项目上下文文件 context.md（它的改动要主人采纳）。
 * 4. 上限：文件个数、遍历条目数（文件加文件夹）和总字节数（config/defaults.ts 的 P69_DEFAULTS）。这个工具不审批，上限就是防误操作的闸。
 * 5. 二进制文件按字节原样复制（FsIO.writeBytesAtomic），不经过文本编码。
 * 6. 读来源一律走 FsIO.readBytesWithin（A-4）：这个工具由不受沙箱限制的中心执行，队友能在家目录里放硬链接、
 *    符号链接，还能在检查之后换掉目录或把文件撑大，所以读的时候按句柄再核一遍，并且限量读取。
 *    已知局限：队友先把内容另存一份再放，这道检查拦不住；它拦的是「原样带走别处的文件」。
 * 7. 项目按项目 id 和成员名单认，不按目录认（A-4 S8）；落点不许进别的项目的文件夹，也不许碰任何项目的 context.md。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { Project } from '../model/project.js';
import type { Job } from '../model/job.js';
import { P69_DEFAULTS } from '../config/defaults.js';
import { gateContextFor } from '../gate/gate-context.js';
import { PathContainmentError, ReadLimitError } from '../io/interfaces.js';
import { isProtected, isSensitive, within } from '../gate/paths.js';
import { resolveFixedRoot, resolveRealTarget } from '../gate/real-path.js';
import { normalizeProjectSharedDir } from './shared-dir.js';
import { PROJECT_CONTEXT_FILE } from './context.js';
import { isJobMaintainedPath } from '../job/files.js';
import { topicIdOfOpenWake } from './topics.js';
import { postThread } from '../outreach/thread.js';
import { newId } from '../util/ids.js';

/** 项目不存在、已归档、自己不是成员，三种情况对外必须是同一句话，不能让非成员探测到项目是否存在。 */
function noSuchProject(id: string): Error { return new Error(`项目 ${id} 不存在`); }

/**
 * 这位队友作为成员（含负责人）的、没有归档的项目。
 * A-4（S8）：按项目 id 和成员名单认，不按目录认——主人把两个项目设成共用或嵌套的文件夹时，
 * 不能因为「目录相同」就把别的项目的成员资格当成自己的。
 */
function memberProjects(ctx: HubContext, bot: Bot): Array<{ project: Project; dir: string }> {
  const found: Array<{ project: Project; dir: string }> = [];
  for (const project of ctx.store.table('projects').list(row => row.archivedAt === null && row.status !== 'archived'
    && (row.memberBotIds.includes(bot.id) || row.ownerBotId === bot.id))) {
    try { found.push({ project, dir: normalizeProjectSharedDir(ctx, project.sharedDir).replace(/\/+$/, '') }); }
    catch { /* 目录不合规的项目本来就不算可写空间。 */ }
  }
  return found;
}

/**
 * 决定放进哪个项目：写明 project 就用它；没写时，这一回合属于某个项目会话就用那个项目，
 * 否则队友只在一个未归档项目里就用它，都不满足报错让它写明。
 */
function pickProject(ctx: HubContext, bot: Bot, wakeId: string | null, wanted: string | undefined): { project: Project; dir: string; topicId: string | null } {
  const mine = memberProjects(ctx, bot);
  const wake = wakeId ? ctx.store.table('wakes').get(wakeId) : null;
  const topicId = (wake && wake.botId === bot.id ? wake.topicId : null) ?? topicIdOfOpenWake(ctx, bot.id) ?? null;
  if (wanted !== undefined) {
    const hit = mine.find(item => item.project.id === wanted);
    if (!hit) throw noSuchProject(wanted);
    return { ...hit, topicId };
  }
  const topicProject = topicId ? ctx.store.table('projectTopics').get(topicId)?.projectId : undefined;
  const fromTopic = topicProject ? mine.find(item => item.project.id === topicProject) : undefined;
  if (fromTopic) return { ...fromTopic, topicId };
  if (mine.length === 1) return { ...mine[0]!, topicId };
  if (mine.length === 0) throw new Error('你现在不在任何进行中的项目里，没有项目文件夹可以放');
  throw new Error(`你在 ${mine.length} 个项目里，请用 project 写明放进哪一个（项目 id：${mine.map(item => item.project.id).join('、')}）`);
}

/** 从根往下列出 target 经过的每一级（不含根本身），用来逐级查符号链接。 */
function levelsBelow(root: string, target: string): string[] {
  const rest = posix.relative(root, target);
  if (rest === '') return [];
  const out: string[] = [];
  let current = root;
  for (const part of rest.split('/')) { current = posix.join(current, part); out.push(current); }
  return out;
}

/** 一个待复制的文件：来源绝对路径、落在项目文件夹里的相对路径。 */
interface PutFile { source: string; rel: string }

/**
 * 给主人看的文件名：队友起的文件名会出现在中心发的系统消息里，所以要去掉一切能伪装成「换行」「另一句话」
 * 或改变显示顺序的字符，再截短。A-4（S9）：除了 C0 控制字符，还去掉 C1 控制字符（U+0080 到 U+009F）、
 * 行分隔和段分隔（U+2028、U+2029）、零宽和方向控制（U+200B 到 U+200F、U+202A 到 U+202E、U+2066 到 U+2069）和 U+FEFF。
 */
function shown(rel: string): string {
  const clean = rel.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ');
  return Array.from(clean).slice(0, 60).join('');
}

/** 系统消息的三种写法：一个文件、2 到 3 个文件、更多文件。文件名放进「」里，读起来不像中心自己说的话。 */
export function projectPutNote(botName: string, rels: readonly string[]): string {
  const names = rels.slice(0, 3).map(name => `「${shown(name)}」`);
  if (rels.length === 1) return `${botName}把${names[0]}放进了项目文件夹`;
  if (rels.length <= 3) return `${botName}放进了 ${rels.length} 个文件：${names.join('、')}`;
  return `${botName}放进了 ${rels.length} 个文件：${names.join('、')} 等 ${rels.length} 个文件`;
}

/** 返回给队友的清单：最多列 20 条，多了写「等 N 个」。 */
function listText(rels: readonly string[]): string {
  const head = rels.slice(0, 20).join('\n');
  return rels.length > 20 ? `${head}\n等 ${rels.length} 个` : head;
}

export interface ProjectPutArgs { from: string; to?: string; project?: string; why?: string }

/** 这一回合若是一件事的执行链回合（唤醒单带 jobId），返回那件事；宿主没给 wakeId 时找这位员工当前打开的唤醒单。 */
function jobOfTurn(ctx: HubContext, bot: Bot, wakeId: string | null): Job | null {
  const wake = wakeId ? ctx.store.table('wakes').get(wakeId)
    : ctx.store.table('wakes').list(row => row.botId === bot.id && row.endedAt === null && ['delivering', 'running', 'committed'].includes(row.status))
      .sort((a, b) => b.startedAt - a.startedAt)[0];
  return wake && wake.botId === bot.id && wake.jobId ? ctx.store.table('jobs').get(wake.jobId) : null;
}

/** 工具主体：校验、读入、写出、留痕。成功返回给队友的中文说明，失败抛中文错误。 */
export async function projectPut(ctx: HubContext, bot: Bot, wakeId: string | null, args: ProjectPutArgs): Promise<{ text: string; rels: string[]; projectId: string }> {
  const { project, dir: projectDir, topicId } = pickProject(ctx, bot, wakeId, args.project);
  const fs = ctx.fs;
  const gctx = gateContextFor(ctx, bot);
  const home = bot.homeDir.replace(/\/+$/, '');

  // ---- 来源：必须在家目录内，逐级不跟随符号链接 ----
  const source = posix.normalize(args.from.startsWith('/') ? args.from : posix.join(home, args.from)).replace(/\/+$/, '');
  if (!within(source, home) || source === home) throw new Error(`from：必须是你家目录内的文件或文件夹（${args.from}）`);
  for (const level of levelsBelow(home, source)) {
    if (fs.isSymlinkSync(level)) throw new Error(`from：${posix.relative(home, level)} 是符号链接，不能放进项目`);
  }
  const realHome = await resolveFixedRoot(fs, home);
  if (!within(await resolveRealTarget(fs, source), realHome)) throw new Error('from：真实位置不在你的家目录内');
  const top = await fs.stat(source);
  if (!top) throw new Error(`from：找不到 ${args.from}`);

  // ---- 遍历来源，收集文件并逐个检查 ----
  const files: PutFile[] = [];
  let totalBytes = 0;
  let entries = 0;
  const visit = async (path: string, rel: string): Promise<void> => {
    const relHome = posix.relative(home, path);
    // A-4（S10）：文件和文件夹合计计数，空文件夹也算，超限立刻停。
    entries += 1;
    if (entries > P69_DEFAULTS.projectPutMaxEntries) throw new Error(`条目太多：一次最多遍历 ${P69_DEFAULTS.projectPutMaxEntries} 个文件和文件夹，你的来源里已经数到 ${entries} 个`);
    if (fs.isSymlinkSync(path)) throw new Error(`from：${relHome} 是符号链接，不能放进项目`);
    if (isSensitive(`/${relHome}`)) throw new Error(`from：${relHome} 是敏感凭据路径，不能放进项目`);
    if (isProtected(path, gctx)) throw new Error(`from：${relHome} 是中心维护的文件，不能放进项目`);
    const info = await fs.stat(path);
    if (!info) throw new Error(`from：找不到 ${relHome}`);
    if (info.isDir) {
      for (const name of await fs.list(path)) await visit(posix.join(path, name), rel === '' ? name : posix.join(rel, name));
      return;
    }
    if (info.isFile === false) throw new Error(`from：${relHome} 不是普通文件，不能放进项目`);
    files.push({ source: path, rel });
    totalBytes += info.size;
    // 边走边查，超限立刻停，不把整个依赖目录都数一遍。
    if (files.length > P69_DEFAULTS.projectPutMaxFiles) throw new Error(`文件太多：一次最多放 ${P69_DEFAULTS.projectPutMaxFiles} 个文件，你的来源里已经数到 ${files.length} 个`);
    if (totalBytes > P69_DEFAULTS.projectPutMaxBytes) throw new Error(`文件太大：一次最多放 ${Math.floor(P69_DEFAULTS.projectPutMaxBytes / 1048576)} MB，你的来源合计已经有 ${(totalBytes / 1048576).toFixed(1)} MB`);
  };
  await visit(source, '');
  if (files.length === 0) throw new Error('from：这个文件夹里没有文件可放');

  // ---- 落点：to 留在项目文件夹内 ----
  const sourceName = posix.basename(source);
  let to = (args.to ?? sourceName).trim();
  if (to === '' || to.startsWith('/')) throw new Error('to：必须是项目文件夹内的相对路径');
  const intoFolder = to.endsWith('/');
  to = posix.normalize(to).replace(/\/+$/, '');
  if (to === '.' || to === '..' || to.startsWith('../')) throw new Error('to：不能跑出项目文件夹');
  // 项目文件夹本身（以及它在中心 projects 下的位置）不能被换成指向别处的符号链接。
  if (fs.isSymlinkSync(projectDir)) throw new Error('项目文件夹被换成了符号链接，已拒绝写入');
  const realProjects = await resolveFixedRoot(fs, posix.join(ctx.settings.rootDir, 'projects'));
  if (!within(await resolveRealTarget(fs, projectDir), realProjects)) throw new Error('项目文件夹的真实位置不在中心的项目目录内，已拒绝写入');
  // 单个文件放进一个已存在的文件夹，或 to 以 / 结尾：放在文件夹里并保留原文件名。
  const targetInfo = await fs.stat(posix.join(projectDir, to));
  const singleFile = !top.isDir;
  const base = singleFile && (intoFolder || targetInfo?.isDir === true) ? posix.join(to, sourceName) : to;
  const plan = files.map(file => ({ ...file, dest: singleFile ? base : posix.join(base, file.rel) }));
  // A-4（S8）：落点不许进「别的项目（自己不是成员）」的文件夹，也不许是任何一个项目文件夹下的 context.md。
  // 嵌套或共用文件夹时，按目录认项目会让外层项目的成员改到内层项目的上下文。回答不点名对方项目，不泄露它存在。
  const mineIds = new Set(memberProjects(ctx, bot).map(item => item.project.id));
  const others: Array<{ id: string; dir: string }> = [];
  for (const other of ctx.store.table('projects').list()) {
    try { others.push({ id: other.id, dir: normalizeProjectSharedDir(ctx, other.sharedDir).replace(/\/+$/, '') }); } catch { /* 目录不合规的项目没有可比较的位置。 */ }
  }
  const sameDir = (a: string, b: string): boolean => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
  for (const item of plan) {
    const dest = posix.join(projectDir, item.dest);
    if (!within(dest, projectDir) || dest === projectDir) throw new Error('to：不能跑出项目文件夹');
    // context.md 由中心维护：任何项目文件夹下的这一份都不能覆盖（自己项目的，也包括嵌套在里面的别的项目的）。
    if (others.some(other => sameDir(posix.normalize(dest), posix.join(other.dir, PROJECT_CONTEXT_FILE)))) {
      throw new Error(`to：${PROJECT_CONTEXT_FILE} 由中心维护（改动要主人采纳），请换一个文件名`);
    }
    // P74b：一件事的主题文件夹里，约定.md、原话.md、草图.md 和「材料」由中心维护（与 context.md 同一处理），
    // 任何一个项目文件夹下的这些位置都不能覆盖；「交付」「证据」是执行者自己的位置，照常可以放。
    const maintained = others.find(other => within(dest, other.dir) && isJobMaintainedPath(posix.relative(other.dir, dest)));
    if (maintained !== undefined) throw new Error(`这是中心维护的文件，不能覆盖：${posix.relative(maintained.dir, dest)}`);
    if (others.some(other => !mineIds.has(other.id) && !sameDir(other.dir, projectDir) && within(dest, other.dir))) {
      throw new Error('to：这个位置不属于你的项目，不能放进去');
    }
    for (const level of levelsBelow(projectDir, dest)) {
      if (fs.isSymlinkSync(level)) throw new Error(`to：项目文件夹里的 ${posix.relative(projectDir, level)} 是符号链接，已拒绝写入`);
    }
    // A-4（S11）：可以预先发现的冲突在写之前就拒绝，整次一个文件都不写：落点已经是文件夹，
    // 或者落点的上级里有一级是普通文件。
    const levels = levelsBelow(projectDir, dest);
    for (const [index, level] of levels.entries()) {
      const exists = await fs.stat(level);
      if (!exists) break;
      const last = index === levels.length - 1;
      if (last && exists.isDir) throw new Error(`to：项目文件夹里的 ${posix.relative(projectDir, level)} 已经是一个文件夹，不能被文件覆盖，整次没有放任何文件，请换一个名字`);
      if (!last && !exists.isDir) throw new Error(`to：项目文件夹里的 ${posix.relative(projectDir, level)} 是一个文件，不能当文件夹用，整次没有放任何文件，请换一个名字`);
    }
  }

  // ---- 全部读进内存（A-4：按句柄限量读，额度是合计上限减去已经读到的），确认无误才开始写 ----
  const loaded: Array<{ dest: string; bytes: Uint8Array }> = [];
  let actual = 0;
  const tooBig = (): Error => new Error(`文件太大：一次最多放 ${Math.floor(P69_DEFAULTS.projectPutMaxBytes / 1048576)} MB，你的来源合计已经超过了`);
  for (const item of plan) {
    const relHome = posix.relative(home, item.source);
    let bytes: Uint8Array | null;
    try { bytes = await fs.readBytesWithin(item.source, { within: home, maxBytes: P69_DEFAULTS.projectPutMaxBytes - actual }); }
    catch (error) {
      if (error instanceof ReadLimitError) throw tooBig();
      if (error instanceof PathContainmentError) {
        throw new Error(error.reason === 'hardlink'
          ? `from：${relHome} 有多个硬链接（它和别处的文件是同一份），不能直接放进项目；请先把它复制成一个普通文件（例如 cp ${relHome} 新文件名）再放`
          : `from：${relHome} 在读取时位置不对（路径上有符号链接，或文件在检查之后被换掉了），已拒绝`);
      }
      throw error;
    }
    if (!bytes) throw new Error(`from：${relHome} 在复制前消失了`);
    actual += bytes.length;
    loaded.push({ dest: item.dest, bytes });
  }
  // 写入带边界：文件层在项目文件夹这一级就拒绝符号链接，检查之后目录被换掉也写不出去。
  // A-4（S11）：写到一半出错时，留一条审计写清已经写进去哪几个文件，并在给队友的错误里说明，不留无痕的半成品。
  const written: string[] = [];
  try {
    for (const item of loaded) { await fs.writeBytesAtomic(posix.join(projectDir, item.dest), item.bytes, { within: projectDir }); written.push(item.dest); }
  } catch (error) {
    ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: ctx.clock.now(), actor: bot.id, action: 'project_put_partial',
      detail: JSON.stringify({ project: project.id, from: posix.relative(home, source), planned: loaded.length, written: written.slice(0, 50), writtenCount: written.length }) });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`写入中途出错（${reason}）。已经放进项目文件夹的有 ${written.length} 个：${written.length ? written.slice(0, 20).join('、') : '无'}；其余没有放。`);
  }

  const rels = loaded.map(item => item.dest);
  // 留痕：审计里记来源、项目和队友自己说的原因（原因只进审计，不进给主人看的消息）。
  ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: ctx.clock.now(), actor: bot.id, action: 'project_put',
    detail: JSON.stringify({ project: project.id, from: posix.relative(home, source), count: rels.length, bytes: actual, ...(args.why ? { why: args.why.slice(0, 200) } : {}) }) });
  // 让主人看得见：只在这一回合所属的项目会话就是目标项目时，往那条会话里写一条系统消息。
  const topic = topicId ? ctx.store.table('projectTopics').get(topicId) : null;
  // P74c：执行链的回合（唤醒单带 jobId）放进项目文件夹的说明，落到这件事的主题里，作为「工作往来」（折叠起来，不占楼层）。
  const job = jobOfTurn(ctx, bot, wakeId);
  if (job && job.projectId === project.id) postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', text: projectPutNote(bot.name, rels), refId: null });
  else if (topic && topic.projectId === project.id) postThread(ctx, { thread: topic.id, from: 'hub', kind: 'system', text: projectPutNote(bot.name, rels) });
  return { text: `已放进项目「${project.name}」的文件夹（${projectDir}），共 ${rels.length} 个文件：\n${listText(rels)}`, rels, projectId: project.id };
}
