/**
 * 自己积累的技能的物化与回合结束核对（P75e 第 4、8 节；P75r3 补强核对）。
 *
 * 做什么：
 * - 把一位员工「在用」的技能写成家目录 `.agents/skills/self-…/SKILL.md`（DSH 技能格式，带中心标记）；
 *   收起的技能删掉带标记的文件。内容不同才写，避免无意义的刷盘。
 * - 回合结束核对（也在每次投递唤醒之前做一遍）：
 *   先查路径本身（`.agents`、`.agents/skills`、`playbooks`、`memory`、`memory/MEMORY.md` 与技能目录下的每一项）
 *   是不是被员工换成了符号链接或别的类型，是的就把它本身移走并重建；
 *   再核对内容：中心应有的技能文件（预置与自己积累）内容不同或缺失的恢复；
 *   其余目录整个移到 `.hub/stray-skills/…`，记审计。
 *   都不计越界、不在私聊落消息（这三处以前允许写，旧会话照旧写不是有意越界，方案 7.4）。
 *   移走过东西、或核对没做完，都给主人出一条告警（同一位员工同一句话当天只出一条），核对不能被悄悄关掉。
 *
 * 为什么只认「目录名加编号」：目录名等于员工自己的 DSH 技能名、或文件里写了中心标记字样，都不能让员工放进来的目录躲过搬走；
 * 员工新建的目录也不删，只搬走留档，主人想看还看得到。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Bot, Skill, SkillVersion } from '../model/index.js';
import { MEMORY_DEFAULTS as MD, SKILL_DEFAULTS as D } from '../config/defaults.js';
import { presetSkillsFor } from '../config/preset-skills.js';
import { byteLength } from '../util/text.js';
import { localDateKey } from '../util/time.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { syncAlertItems } from '../outreach/alerts.js';
import { raiseAlert } from '../health/alerts.js';
import { syncPresetSkills } from '../memory/preset-skills.js';
import { LEGACY_MEMORY_NOTICE } from '../memory/files.js';

/** 中心写入标记：清理时只删带这个标记（前缀）的文件。版本号写在标记里。 */
export function selfSkillMarker(skillId: string, versionNo: number): string {
  return `<!-- dsh-buddy:self-skill:${skillId}:v${versionNo} -->`;
}

/** 这个文件是不是这条技能的中心文件（按标记前缀认，不限版本）。 */
function isSelfSkillFile(content: string, skillId: string): boolean {
  return content.includes(`dsh-buddy:self-skill:${skillId}:`);
}

/** 技能文件的固定落点：目录名就是这条技能在 DSH 里的技能名。 */
export function selfSkillPath(bot: Bot, skill: Skill): string {
  return posix.join(bot.homeDir, '.agents/skills', skill.dirName, 'SKILL.md');
}

/**
 * 渲染一份自己积累技能的 SKILL.md（P75 方案 7.4）：
 * YAML 头三项（name、description、user-invocable）让 DSH 认得它；
 * 中心标记排在头后面；正文按句编号，不写出处（出处给主人看，不进提示词）。
 * 超过 SKILL_FILE_MAX_BYTES 时从最后一句往前删，末尾写明少列了几句（正常不会发生，句数与字数已有上限）。
 */
export function renderSelfSkillFile(skill: Skill, version: SkillVersion): string {
  const head = [
    '---',
    `name: ${skill.dirName}`,
    `description: ${JSON.stringify(`${skill.title}：${skill.whenToUse}`)}`,
    'user-invocable: false',
    '---',
    selfSkillMarker(skill.id, version.no),
    `# ${skill.title}`,
    '',
    skill.whenToUse,
    '',
  ].join('\n');
  const sentences = version.sentences.map(row => row.text);
  let dropped = 0;
  // 先按全部句子拼；超出字节上限就从最后一句往前删，直到放得下（含「另有 n 句未列出」那一行）。
  let body = () => sentences.slice(0, sentences.length - dropped).map((text, index) => `${index + 1}. ${text}`).join('\n');
  while (dropped < sentences.length && byteLength(`${head}${body()}\n（另有 ${dropped} 句未列出）\n`) > D.SKILL_FILE_MAX_BYTES) {
    dropped += 1;
  }
  const listed = body();
  const note = dropped > 0 ? `\n（另有 ${dropped} 句未列出）\n` : '\n';
  return `${head}${listed}${note}`;
}

/** 这位员工名下的全部自己积累技能，按更新时间倒序（技能库一栏的显示顺序）。 */
export function selfSkillsOf(ctx: HubContext, botId: string): Skill[] {
  return ctx.store.table('skills').list(row => row.botId === botId).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 一条技能的一个版本；没有返回 null。 */
export function skillVersionOf(ctx: HubContext, skillId: string, no: number): SkillVersion | null {
  return ctx.store.table('skillVersions').list(row => row.skillId === skillId && row.no === no)[0] ?? null;
}

/** 一条技能的全部版本，按版本号从新到旧。 */
export function versionsOfSkill(ctx: HubContext, skillId: string): SkillVersion[] {
  return ctx.store.table('skillVersions').list(row => row.skillId === skillId).sort((a, b) => b.no - a.no);
}

/**
 * 把这位员工的自己积累技能同步到磁盘：
 * - 在用的：渲染当前版本，内容不同才写；
 * - 收起的：删掉该目录下带本技能标记的文件，目录空了顺手删目录；只碰带标记的文件。
 * 返回实际写入/删除的技能 id，供测试与排查。
 */
export async function syncSelfSkills(ctx: HubContext, bot: Bot): Promise<{ written: string[]; removed: string[] }> {
  const written: string[] = [];
  const removed: string[] = [];
  for (const skill of selfSkillsOf(ctx, bot.id)) {
    const path = selfSkillPath(bot, skill);
    const dir = posix.dirname(path);
    if (skill.state === 'active') {
      const version = skillVersionOf(ctx, skill.id, skill.currentVersionNo);
      if (version === null) continue; // 数据不完整时不写文件，下次写入后自然补上
      const content = renderSelfSkillFile(skill, version);
      if (await ctx.fs.readText(path) === content) continue;
      await ctx.fs.mkdirp(dir, { within: bot.homeDir });
      await ctx.fs.writeTextAtomic(path, content, { within: bot.homeDir });
      written.push(skill.id);
      continue;
    }
    // 收起：只删带本技能标记的文件；员工放在同一个目录里的其他文件不动。
    let empty = true;
    for (const name of await ctx.fs.list(dir)) {
      const file = posix.join(dir, name);
      const content = await ctx.fs.readText(file);
      if (content !== null && isSelfSkillFile(content, skill.id)) {
        await ctx.fs.remove(file, { within: bot.homeDir });
        removed.push(skill.id);
      } else empty = false;
    }
    if (empty) {
      try { if ((await ctx.fs.list(dir)).length === 0) await ctx.fs.remove(dir, { within: bot.homeDir }); } catch { /* 目录删不掉不影响主流程 */ }
    }
  }
  return { written, removed };
}

// ---------------------------------------------------------------------------
// 回合结束（与投递之前）的核对
// ---------------------------------------------------------------------------

/** 主人看到的两句告警（逐字固定）：移走并恢复成功 / 核对没有完成。两句都不带员工编号和路径。 */
// P75r4 第 3 节第 2 条：第一句改写（原句里的「别的东西」是口语，而且被替换的不一定是技能目录）。
export const SKILL_DIR_REPLACED_ALERT = (botName: string): string => `${botName}家目录里由中心维护的目录被替换过，中心已按技能库的内容恢复。`;
export const SKILL_VERIFY_FAILED_ALERT = (botName: string): string => `${botName}家目录里的技能目录核对没有完成，下一个回合读到的技能可能不是技能库里的内容。`;

/** 一次核对里发生的事：移走了哪些路径、哪些步骤失败了。 */
interface VerifyReport { replaced: Array<{ path: string; found: string }>; failed: string[] }

/** 路径上实际是什么，写进审计，让主人和排查的人看得懂。 */
function describeFound(info: { isSymlink: boolean; isDir: boolean }): string {
  return info.isSymlink ? '符号链接' : info.isDir ? '目录' : '文件';
}

/**
 * 把家目录下的一个相对路径本身（不跟随符号链接）移到搬走的位置，返回搬到哪里。
 * 命名同原来搬走杂项的做法：{rootDir}/.hub/stray-skills/{员工}/{时间}/{原名}；同名已存在时加序号，绝不覆盖。
 */
async function moveAside(ctx: HubContext, bot: Bot, rel: string): Promise<string> {
  const from = posix.join(bot.homeDir, rel);
  const base = posix.join(ctx.settings.rootDir, D.STRAY_DIR, bot.id, String(ctx.clock.now()));
  const name = posix.basename(rel);
  let to = posix.join(base, name);
  for (let n = 2; await ctx.fs.lstat(to) !== null; n += 1) to = posix.join(base, `${name}-${n}`);
  // P75r4 第 3 节第 5 条：搬走的目标位置也带边界（中心的根目录）：搬走位置的上级任何一级被员工换成符号链接就拒绝，
  // 否则东西会顺着链接落进员工写得到的地方。被拒绝时由调用方的核对记失败并出第二句告警。
  await ctx.fs.move(from, to, { within: bot.homeDir }, { within: ctx.settings.rootDir });
  return to;
}

/**
 * 第 1 步：先查路径本身。应当是目录的（`.agents`、`.agents/skills`、`playbooks`、`memory`、技能目录下的每一项）、
 * 应当是文件的（`memory/MEMORY.md`，仅在中心接管它之后）：用不跟随链接的方式查看，
 * 是符号链接或类型不对的，把它本身移走、重建应有的目录、记审计 skill_dir_replaced。
 * 为什么先于内容核对：路径本身被换成指向别处的链接后，内容核对的写入会因路径里有符号链接被文件层拒绝，核对就等于被关掉了。
 */
async function repairManagedPaths(ctx: HubContext, bot: Bot, includeMemory: boolean, report: VerifyReport): Promise<void> {
  const replace = async (rel: string, kind: 'dir' | 'file', rebuild: string[]): Promise<boolean> => {
    const info = await ctx.fs.lstat(posix.join(bot.homeDir, rel));
    if (info === null) return false;
    if (!info.isSymlink && (kind === 'dir' ? info.isDir : !info.isDir)) return false;
    const found = describeFound(info);
    const to = await moveAside(ctx, bot, rel);
    for (const dir of rebuild) await ctx.fs.mkdirp(posix.join(bot.homeDir, dir), { within: bot.homeDir });
    writeOutreachAudit(ctx, 'skill_dir_replaced', { botId: bot.id, path: rel, found, to }, bot.id);
    report.replaced.push({ path: rel, found });
    return true;
  };
  // 外层先查：外层被换掉，里面的路径都已随它移走，不必再查。
  await replace('.agents', 'dir', ['.agents/skills']);
  await replace('.agents/skills', 'dir', ['.agents/skills']);
  await replace('playbooks', 'dir', ['playbooks']);
  // 迁移完成之前不查 memory 目录本身（与 MEMORY.md 的条件一致，P75r4 第 3 节第 3 条）：
  // 这时 memory/MEMORY.md 还是员工自己的长期记忆，整个目录被搬走的话迁移读不到原文。
  if (includeMemory) {
    await replace('memory', 'dir', ['memory', 'memory/journal']);
    // MEMORY.md 在迁移的备份步骤完成之前还由员工使用，中心不接管，也不查。
    await replace('memory/MEMORY.md', 'file', []);
  }
  // 技能目录下的每一项都应是目录；链接、文件整个移走（目录里的内容由下一步按目录名与编号核对）。
  for (const name of await ctx.fs.list(posix.join(bot.homeDir, '.agents/skills'))) await replace(posix.join('.agents/skills', name), 'dir', []);
}

/** 文件里出现的中心标记字样（任何种类）。 */
const ANY_MARKER = /dsh-buddy:(?:self-skill|preset-skill):/;

/**
 * 第 2 步：技能目录下的每个目录，只有两种算中心的（P75r3 第 2 节，按「目录名加编号」精确核对）：
 * 1. 目录名等于这位员工某条在用的自己积累技能的目录名，并且文件里的中心标记（文件存在时）写的是这条技能的编号；
 * 2. 目录名等于这位员工勾选的某个预置技能的 id（文件里的标记同理写的得是它）。
 * 文件存在但完全没有标记时，目录名对得上的仍按中心的算：内容由同步恢复（原有做法），不另外搬走。
 * 其余一律搬走：包括员工 DSH 技能名的同名目录、写了标记字样但对不上的目录、标记写的是别的技能编号的目录、没有勾选的预置技能目录。
 */
async function moveStrayDirs(ctx: HubContext, bot: Bot, report: VerifyReport): Promise<void> {
  const skillsDir = posix.join(bot.homeDir, '.agents/skills');
  const skills = selfSkillsOf(ctx, bot.id);
  const activeByDir = new Map(skills.filter(skill => skill.state === 'active').map(skill => [skill.dirName, skill]));
  // 收起的技能：它的带标记文件由随后的同步删除，目录在那之前不算多余。
  const collapsedByDir = new Map(skills.filter(skill => skill.state === 'collapsed').map(skill => [skill.dirName, skill]));
  const presetIds = new Set(presetSkillsFor(bot.presetSkillIds).map(skill => skill.id));
  for (const name of await ctx.fs.list(skillsDir)) {
    const dir = posix.join(skillsDir, name);
    let content: string | null;
    let unreadable = false;
    try { content = await ctx.fs.readText(posix.join(dir, 'SKILL.md')); } catch { content = null; unreadable = true; }
    const self = activeByDir.get(name);
    const collapsed = collapsedByDir.get(name);
    const own = (marker: string): boolean => !unreadable && (content === null || content.includes(marker) || !ANY_MARKER.test(content));
    let center = false;
    if (self) center = own(`dsh-buddy:self-skill:${self.id}:`);
    else if (presetIds.has(name)) center = own(`dsh-buddy:preset-skill:${name}`);
    else if (collapsed) center = content !== null && isSelfSkillFile(content, collapsed.id);
    if (center) continue;
    const to = await moveAside(ctx, bot, posix.join('.agents/skills', name));
    writeOutreachAudit(ctx, 'stray_skill_moved', { botId: bot.id, dir: name, to }, bot.id);
    report.replaced.push({ path: posix.join('.agents/skills', name), found: '目录' });
  }
}

/**
 * 这一项被移走，要不要给主人出告警：
 * 技能目录下直接出现的普通目录（员工新建的）、普通文件（访达的 .DS_Store 之类）只记审计；
 * 符号链接，以及技能目录以外的中心位置（技能目录本身、.agents、playbooks、memory、MEMORY.md）被换掉，才出告警。
 */
function alertsOwner(item: { path: string; found: string }): boolean {
  const directlyUnderSkills = item.path.startsWith('.agents/skills/');
  if (directlyUnderSkills) return item.found === '符号链接';
  return true;
}

/** 同一位员工、同一句话，当天只出一条告警（当天按设置的时区算）。 */
async function alertOncePerDay(ctx: HubContext, bot: Bot, code: string, text: string): Promise<void> {
  const today = localDateKey(ctx.clock.now(), ctx.settings.timezone);
  if (ctx.store.table('alerts').count(row => row.botId === bot.id && row.text === text && localDateKey(row.lastAt, ctx.settings.timezone) === today) > 0) return;
  raiseAlert(ctx, { code, botId: bot.id, level: 'P1', immediate: true, text });
  try { await syncAlertItems(ctx); } catch (error) { ctx.logger.warn('技能目录核对的告警同步失败', { botId: bot.id, error: String(error) }); }
}

/**
 * 回合结束核对技能目录（方案 7.4，P75e 第 8 节；P75r3 第 1、2、9 节）：
 * 1. 先查路径本身（见 repairManagedPaths），被换成链接或别的类型的移走并重建；
 * 2. 预置技能文件内容不同或缺失的恢复（内容相同不写）；
 * 3. 搬走不属于中心的目录（见 moveStrayDirs），记审计 `stray_skill_moved`；
 * 4. 自己积累的技能文件恢复（先搬走、后写出，标记编号对不上的目录才能被重新写对）；
 * 5. `memory/MEMORY.md` 的核对：迁移记录是 done 且「备份长期记忆」这一步已完成之后才纳入（includeMemory 由调用方按迁移完成与否传入，这里再核对那一步）。
 * 任何一步失败：记审计 `skill_verify_failed`、出告警，不抛出去，不影响回合收尾。
 * 全部没有问题时不写任何文件、不发任何事件。不计越界、不在私聊落消息。
 */
export async function verifyManagedSkillFiles(ctx: HubContext, bot: Bot, includeMemory = false): Promise<void> {
  const report: VerifyReport = { replaced: [], failed: [] };
  const errors: string[] = [];
  const step = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    try { await work(); }
    catch (error) {
      report.failed.push(label);
      errors.push(`${label}：${String(error)}`);
      ctx.logger.warn(`技能目录核对：${label}失败`, { botId: bot.id, error: String(error) });
    }
  };
  // 第 9 节：长期记忆文件只在迁移完成、并且各员工的长期记忆已备份改写之后才由中心接管。
  const managesMemory = includeMemory && ctx.store.table('migrations').get(MD.MIGRATION_ID)?.steps.backupMemory === true;
  await step('检查路径', () => repairManagedPaths(ctx, bot, managesMemory, report));
  await step('恢复预置技能文件', () => syncPresetSkills(ctx, bot));
  await step('搬走多余目录', () => moveStrayDirs(ctx, bot, report));
  await step('恢复自己积累技能文件', () => syncSelfSkills(ctx, bot));
  // 长期记忆文件：迁移完成后中心应有的内容就是那一句停用说明，不同就恢复。
  if (managesMemory) {
    await step('恢复长期记忆文件', async () => {
      const path = posix.join(bot.homeDir, 'memory', 'MEMORY.md');
      if (await ctx.fs.readText(path) !== `${LEGACY_MEMORY_NOTICE}\n`)
        await ctx.fs.writeTextAtomic(path, `${LEGACY_MEMORY_NOTICE}\n`, { within: bot.homeDir });
    });
  }
  if (report.failed.length > 0) {
    writeOutreachAudit(ctx, 'skill_verify_failed', { botId: bot.id, steps: report.failed, errors }, bot.id);
    await alertOncePerDay(ctx, bot, 'skill_verify_failed', SKILL_VERIFY_FAILED_ALERT(bot.name));
  } else if (report.replaced.some(item => alertsOwner(item))) {
    // 员工新建的普通目录只记审计（原有做法）；技能目录、playbooks、memory 这些中心的位置被换掉才出告警。
    // P75r4：技能目录下直接出现的普通文件（例如访达留下的 .DS_Store）同样只搬走、记审计，不出告警。
    await alertOncePerDay(ctx, bot, 'skill_dir_replaced', SKILL_DIR_REPLACED_ALERT(bot.name));
  }
}
