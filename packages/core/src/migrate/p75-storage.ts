/**
 * P75f 升级迁移：把旧规矩（rules）、旧套路（routines）、旧长期记忆（memory/MEMORY.md）
 * 一次性搬进记忆（memories）与技能库（skills、skillVersions、skillSources）。
 *
 * 原则（方案 5.6）：只新增、不改旧表；旧版本插件读旧表照常工作；新表出错可以整体撤掉。
 * P75r2 起的顺序与口径：
 * 0. 每次启动先丢弃队列里的旧复盘候选、旧教学候选（不论迁移是否完成）；
 * 1. 读各员工的 memory/MEMORY.md（备份文件已存在时以备份为准），然后**先备份**（写任何新表之前；已存在不覆盖）；
 *    任何一位员工的备份写失败，整次迁移不做、新表没有任何行、MEMORY.md 原文不动；
 * 2. 第一段在内存里算出全部新行（见 p75-plan.ts）：规矩原样迁成记忆，教训、套路、长期记忆切句分组迁成技能；
 * 3. 第二段写新表：先写迁移记录 state=writing，每写一行把 id 记进 written；单条技能写不进就跳过这一条、
 *    清掉它留下的行、继续下一条；记忆或存储本身出错则按 written 逐行删除、整次不做；
 * 4. 全部写完记 done（记下跳过的条数），然后收尾：撤回旧教训提议、清旧复盘候选、
 *    把 MEMORY.md 改写成停用说明（先核对备份）、物化技能、刷新身份文件，每步各记完成标记，出错只记日志，下次启动接着做。
 *
 * 与 P75r1 的口径：迁移记录不是 done 时 legacyRulesInEffect 为真，旧规矩表与记忆一并生效
 * （已迁进记忆的规矩靠 source.legacyRuleId 去重，不会出现两条）；变成 done 后旧规矩表不再读。
 *
 * 本文件不写 rules、routines 两张旧表（只读迁移来源）；记忆与技能只经 writeMemory、writeSkillVersion
 * 两个唯一入口写；skillSources 出处表没有别的写入方，由本文件直接建行并随迁移记录回滚。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { MEMORY_DEFAULTS as MD, SKILL_DEFAULTS as SD } from '../config/defaults.js';
import { SkillSourceSchema } from '../model/skill.js';
import { newId } from '../util/ids.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { closeAlert, raiseAlert } from '../health/alerts.js';
import { writeMemory } from '../memory/service.js';
import { LEGACY_MEMORY_NOTICE, refreshBotFiles } from '../memory/files.js';
import { renderRootAgentsMd } from '../memory/render.js';
import { writeSkillVersion, setSkillState } from '../skill/store.js';
import { syncSelfSkills } from '../skill/files.js';
import { removeEntry } from '../scheduler/queue.js';
import { planMigration, type MigrationPlan, type SkillPlan, type SkippedCounts } from './p75-plan.js';

/** 迁移告警的固定编号（整次没有完成）。 */
const ALERT_CODE = 'p75:migration';
/** 迁移完成但有跳过的告警编号（和上一条分开，两句各出各的）。 */
const ALERT_CODE_SKIPPED = 'p75:migration-skipped';
/** 旧复盘候选里「后续卡新建的候选用这些前缀，不能丢」：事项键以它们开头的不是旧候选。 */
const NEW_RETRO_KEY_PREFIXES = ['retro:', 'skillcheck:', 'tidy:'] as const;
/** 旧教学候选里「后续卡新建的候选用这个前缀，不能丢」。 */
const NEW_LEARN_KEY_PREFIX = 'learn:';

/** 把整次没有完成的告警文字（逐字固定，不带员工编号、表名、字段名；原因只写进迁移记录和日志）。 */
const ALERT_TEXT_FAILED = '升级时整理旧的规矩、套路和长期记忆没有完成，每次启动会再试。旧的规矩照常生效；旧的套路和长期记忆暂时没有带给员工。';

/** 一位员工长期记忆文件与备份文件的路径。 */
const memoryPathOf = (homeDir: string): string => posix.join(homeDir, 'memory', 'MEMORY.md');
const backupPathOf = (ctx: HubContext, botId: string): string => posix.join(ctx.settings.rootDir, SD.LEGACY_DIR, botId, 'MEMORY.md');
/** 文件内容是不是停用说明。 */
const isNotice = (text: string): boolean => text.trim() === LEGACY_MEMORY_NOTICE;
/** 原文有真实内容（不是缺失、空白或停用说明）才需要备份。 */
const needsBackup = (text: string | null): text is string => text !== null && text.trim() !== '' && !isNotice(text);

/** 读一个文件，读不出来当作没有。 */
async function readOrNull(ctx: HubContext, path: string): Promise<string | null> {
  try { return await ctx.fs.readText(path); } catch { return null; }
}

/** 第 6 节：丢弃队列里的旧候选（每次启动、不论迁移是否完成都做）。 */
function dropLegacyCandidates(ctx: HubContext): void {
  // 旧复盘候选：唤醒原因种类为 reflection、或回合变体为 reflection（P75r4 第 5 节：旧混合队列里两者可以不一致，
  // 变体是复盘而原因种类不是的，派出去是一个没有任何复盘说明的只读回合），且事项键不是后续卡新建的那几类（员工自己发起的旧复盘，不给主人看）。
  for (const entry of ctx.store.table('queue').list(row => (row.reason.kind === 'reflection' || row.variant === 'reflection')
    && !NEW_RETRO_KEY_PREFIXES.some(prefix => row.subjectKey.startsWith(prefix)))) {
    removeEntry(ctx, entry.id); // 同时把员工的「排队中」状态复位，不留没有候选的排队状态
    writeOutreachAudit(ctx, 'p75_dropped_reflection', { id: entry.id, botId: entry.botId }, entry.botId);
  }
  // 旧教学候选：variant 为 teach，且事项键不是后续卡新建的学习候选。
  for (const entry of ctx.store.table('queue').list(row => row.variant === 'teach' && !row.subjectKey.startsWith(NEW_LEARN_KEY_PREFIX))) {
    removeEntry(ctx, entry.id);
    writeOutreachAudit(ctx, 'p75_dropped_teach', { id: entry.id, botId: entry.botId }, entry.botId);
  }
}

/** 为一条技能写出处行与版本：出处先建行并立刻记进 written（后面写入失败也能回滚），再走 writeSkillVersion（不物化）。 */
async function writeSkillPlan(ctx: HubContext, plan: SkillPlan, now: number, written: Record<string, string[]>, made: string[]):
  Promise<{ skillId: string; versionId: string }> {
  const byKey = new Map<string, string>();
  const keyOf = (sentence: SkillPlan['sentences'][number]) => `${sentence.kind}\u0000${sentence.label}\u0000${sentence.quote}`;
  for (const sentence of plan.sentences) {
    const key = keyOf(sentence);
    if (byKey.has(key)) continue; // 同一原文、种类、标签只建一条出处。
    const row = SkillSourceSchema.parse({
      id: newId('ss', ctx.rng), botId: plan.botId, kind: sentence.kind,
      label: [...sentence.label].slice(0, SD.SOURCE_LABEL_MAX_CHARS).join(''),
      quote: [...sentence.quote].slice(0, SD.SOURCE_QUOTE_MAX_CHARS).join(''),
      relayed: false, jobId: null, category: null, refs: {}, createdAt: now,
    });
    ctx.store.table('skillSources').put(row);
    written.skillSources!.push(row.id);
    made.push(row.id);
    byKey.set(key, row.id);
  }
  const version = await writeSkillVersion(ctx, {
    botId: plan.botId, change: 'migrate',
    newSkill: { title: plan.title, whenToUse: plan.whenToUse, supplements: null },
    sentences: plan.sentences.map(sentence => ({ text: sentence.text, sourceIds: [byKey.get(keyOf(sentence))!] })),
    updateId: null, checkedBy: 'hub', categories: [], materialize: false, legacy: plan.legacy,
  });
  return { skillId: version.skillId, versionId: version.id };
}

/** 按迁移记录的 written 逐行删除已写的新表行（失败回滚与上次写到一半的清理共用）。 */
function rollbackWritten(ctx: HubContext, written: Record<string, string[]>): void {
  for (const [table, ids] of Object.entries(written)) {
    for (const id of ids) {
      try { ctx.store.table(table as 'memories').remove(id); } catch { /* 删不掉的行下次迁移会因重复失败并再次回滚 */ }
    }
  }
}

/** 收尾的一步：撤回开着的旧教训提议（「待你处理」里对应 rules 状态 proposed 的；rules 行不改）。 */
function closeLessonProposals(ctx: HubContext): void {
  const now = ctx.clock.now();
  for (const item of ctx.store.table('inbox').list(row => row.status === 'open' && row.type === 'proposal')) {
    if (!item.refId) continue;
    const rule = ctx.store.table('rules').get(item.refId);
    if (!rule || rule.status !== 'proposed') continue;
    ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: '已停用：员工的经验改由评审者核对', answeredAt: now });
  }
}

/** 一条已写入的技能留下的行：出处、技能、版本（撤掉整条套路已写入的几篇时要逐行删）。 */
interface WrittenPlan { sourceIds: string[]; skillId: string; versionId: string }

/** 删掉某张表的一批行，并从 written 里去掉（删不掉的行留给整次回滚）。 */
function dropRows(ctx: HubContext, written: Record<string, string[]>, table: 'skills' | 'skillVersions' | 'skillSources', ids: string[]): void {
  for (const id of ids) { try { ctx.store.table(table).remove(id); } catch { /* 删不掉的行留给整次回滚 */ } }
  written[table] = (written[table] ?? []).filter(id => !ids.includes(id));
}

/**
 * 写一条技能计划；写不进（或收起失败）时跳过这一条：删掉为它建的出处行，再核对 skills、skillVersions 两张表
 * 没有它留下的行（有就删掉），并从 written 里去掉。成功返回它留下的行，失败返回原因文字（只进审计）。
 */
async function writeOnePlan(ctx: HubContext, plan: SkillPlan, collapse: boolean, now: number, written: Record<string, string[]>):
  Promise<{ ok: true; rows: WrittenPlan } | { ok: false; reason: string }> {
  const skillsBefore = new Set(ctx.store.table('skills').list().map(row => row.id));
  const versionsBefore = new Set(ctx.store.table('skillVersions').list().map(row => row.id));
  const made: string[] = [];
  try {
    const result = await writeSkillPlan(ctx, plan, now, written, made);
    written.skills!.push(result.skillId);
    written.skillVersions!.push(result.versionId);
    // 在用名额放不下而收起的，原因记 migrated（说明写事实，不是「没有用到」）。
    if (collapse) await setSkillState(ctx, result.skillId, 'collapsed', 'migrated');
    return { ok: true, rows: { sourceIds: made, skillId: result.skillId, versionId: result.versionId } };
  } catch (error) {
    dropRows(ctx, written, 'skillSources', made);
    dropRows(ctx, written, 'skills', ctx.store.table('skills').list().map(row => row.id).filter(id => !skillsBefore.has(id)));
    dropRows(ctx, written, 'skillVersions', ctx.store.table('skillVersions').list().map(row => row.id).filter(id => !versionsBefore.has(id)));
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * P75f 迁移入口：中心启动的整理步骤里、第一次调度之前调用；幂等。
 * 已 done 时只补做没收尾完的步骤；全部完成时什么都不做（旧候选的清理除外，每次都做）。
 */
export async function runP75Migration(ctx: HubContext): Promise<void> {
  // 第 6 节：旧候选的清理不依赖迁移成功，放在最前面；出错只记日志，不影响迁移。
  try { dropLegacyCandidates(ctx); } catch (error) { ctx.logger.warn('清理旧候选失败，下次启动重试', { error: String(error) }); }
  const existing = ctx.store.table('migrations').get(MD.MIGRATION_ID);
  if (existing?.state === 'done') {
    await finalizeSteps(ctx, existing.steps);
    return;
  }
  // 上次进程在写入中途退出：先按 written 清掉半份数据，再当新的一次迁移做。
  if (existing?.state === 'writing') rollbackWritten(ctx, existing.written);
  const attempts = existing?.attempts ?? 0;
  const now = ctx.clock.now();
  // ---- 读长期记忆并先备份（写任何新表之前）----
  // 备份文件已存在（且不是停用说明）时以备份为准：上一次做到一半、原文件已被改写成停用说明的情形。
  const memoryFiles = new Map<string, string | null>();
  try {
    for (const bot of ctx.store.table('bots').list()) {
      const original = await readOrNull(ctx, memoryPathOf(bot.homeDir));
      const target = backupPathOf(ctx, bot.id);
      const backup = await readOrNull(ctx, target);
      const usableBackup = backup !== null && !isNotice(backup) ? backup : null;
      // 原文有真实内容而备份不存在（或备份是停用说明）：先把原文备份下来；已有可用备份不覆盖。
      if (usableBackup === null && needsBackup(original)) {
        await ctx.fs.mkdirp(posix.dirname(target));
        await ctx.fs.writeTextAtomic(target, original);
      }
      memoryFiles.set(bot.id, usableBackup ?? original);
    }
  } catch (error) {
    failMigration(ctx, attempts + 1, `长期记忆文件备份失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  // ---- 第一段：算出全部新行（不写任何东西） ----
  let plan: MigrationPlan;
  try {
    plan = planMigration(ctx, memoryFiles, LEGACY_MEMORY_NOTICE);
  } catch (error) {
    failMigration(ctx, attempts + 1, error instanceof Error ? error.message : String(error));
    return;
  }
  for (const audit of plan.audits) writeOutreachAudit(ctx, audit.action, audit.detail, 'hub');
  const skipped: SkippedCounts = { ...plan.skipped };
  const skippedRoutines = new Set<string>();
  // ---- 第二段：写新表；先写迁移记录 writing，每写一行记进 written ----
  const written: Record<string, string[]> = { memories: [], skillSources: [], skills: [], skillVersions: [] };
  const memoriesBefore = new Set(ctx.store.table('memories').list().map(row => row.id));
  ctx.store.table('migrations').put({ id: MD.MIGRATION_ID, state: 'writing', attempts, written: {}, steps: {}, error: null, updatedAt: now });
  const noteWritten = () => ctx.store.table('migrations').patch(MD.MIGRATION_ID, { written: structuredClone(written), updatedAt: ctx.clock.now() });
  try {
    for (const draft of plan.memories) {
      const row = await writeMemory(ctx, { kind: draft.kind, text: draft.text, example: draft.example,
        redLine: draft.redLine, scope: draft.scope, source: draft.source, category: draft.category,
        refresh: false, createdAt: draft.createdAt });
      written.memories!.push(row.id);
      noteWritten();
    }
    // 在用条数超过上限的：按出处种类（你的指示在前）与原 updatedAt 倒序，前 SELF_ACTIVE_MAX 条在用，其余收起。
    // 先写要收起的（写一条立刻收一条，在用数不超上限），再写保留在用的。单条写不进就跳过这一条。
    const byBot = new Map<string, SkillPlan[]>();
    for (const skill of plan.skills) {
      const list = byBot.get(skill.botId) ?? [];
      list.push(skill);
      byBot.set(skill.botId, list);
    }
    for (const list of byBot.values()) {
      const ranked = [...list].sort((a, b) => Number(b.ownerInstruction) - Number(a.ownerInstruction) || b.updatedAt - a.updatedAt);
      const order = ranked.slice(SD.SELF_ACTIVE_MAX).map(item => ({ item, collapse: true }))
        .concat(ranked.slice(0, SD.SELF_ACTIVE_MAX).map(item => ({ item, collapse: false })));
      // 一条套路分成几篇时，已经写进的篇（P75r4 第 2 节第 3 条：只要有一篇写不进，已写进的几篇一起撤掉，按一条计入「没能整理」）。
      const routineParts = new Map<string, WrittenPlan[]>();
      for (const { item, collapse } of order) {
        // 同一条套路已有一篇写不进：后面的篇不再写（这条套路已按一条计入没能整理）。
        if (item.routineId !== null && skippedRoutines.has(item.routineId)) continue;
        const result = await writeOnePlan(ctx, item, collapse, now, written);
        if (result.ok) {
          if (item.routineId !== null) routineParts.set(item.routineId, [...(routineParts.get(item.routineId) ?? []), result.rows]);
          noteWritten();
          continue;
        }
        // 这一条写不进：记审计（带原因，只进审计不进告警）与条数，继续下一条。
        if (item.routineId !== null) {
          skippedRoutines.add(item.routineId);
          const earlier = routineParts.get(item.routineId) ?? [];
          routineParts.delete(item.routineId);
          if (earlier.length > 0) {
            // 技能库里不应留着这条套路的一半：把它已写进的几篇一起撤掉。
            dropRows(ctx, written, 'skillSources', earlier.flatMap(rows => rows.sourceIds));
            dropRows(ctx, written, 'skills', earlier.map(rows => rows.skillId));
            dropRows(ctx, written, 'skillVersions', earlier.map(rows => rows.versionId));
            writeOutreachAudit(ctx, 'p75_migration_skip', { note: `套路 ${item.routineId} 有一篇写不进，已写入的 ${earlier.length} 篇一并撤回`,
              botId: item.botId, reason: result.reason }, 'hub');
          }
        }
        skipped.lessons += item.lessons;
        if (item.memoryFile) skipped.memoryFiles += 1;
        writeOutreachAudit(ctx, 'p75_migration_skip', { note: `员工 ${item.botId} 的技能「${item.originName}」写入失败，已跳过：${result.reason}`,
          botId: item.botId, reason: result.reason }, 'hub');
        noteWritten();
      }
    }
  } catch (error) {
    rollbackWritten(ctx, written);
    // 写到一半出错的那一行（行已写入、还没来得及记进 written）也要清掉，否则下次重试会重复迁入同一条规矩。
    for (const row of ctx.store.table('memories').list(item => !memoriesBefore.has(item.id))) {
      try { ctx.store.table('memories').remove(row.id); } catch { /* 删不掉的行下次迁移会因重复失败并再次回滚 */ }
    }
    failMigration(ctx, attempts + 1, error instanceof Error ? error.message : String(error));
    return;
  }
  skipped.routines += skippedRoutines.size;
  // 全部写完：迁移记录 done（此后 legacyRulesInEffect 为假，旧规矩表不再读）。
  ctx.store.table('migrations').patch(MD.MIGRATION_ID, { state: 'done', error: null, written: {}, steps: {}, skipped, updatedAt: ctx.clock.now() });
  closeAlert(ctx, ALERT_CODE, null);
  raiseSkippedAlert(ctx, skipped);
  await finalizeSteps(ctx, {});
}

/** 记一次迁移失败并按次数出告警（同一句开着的时候只出一条，不叫醒任何人）。原因只写进迁移记录和日志。 */
function failMigration(ctx: HubContext, attempts: number, reason: string): void {
  ctx.store.table('migrations').put({ id: MD.MIGRATION_ID, state: 'failed', attempts, written: {}, steps: {}, error: reason, updatedAt: ctx.clock.now() });
  ctx.logger.warn('升级迁移没有完成，下次启动重试', { attempts, reason });
  if (attempts >= MD.MIGRATION_ALERT_AFTER) {
    const open = ctx.store.table('alerts').list(alert => alert.code === ALERT_CODE && alert.status === 'open');
    if (!open.some(alert => alert.text === ALERT_TEXT_FAILED)) raiseAlert(ctx, { code: ALERT_CODE, botId: null, level: 'P1', text: ALERT_TEXT_FAILED, immediate: true });
  }
}

/** 完成了但有跳过：出一条告警，写明各类各几条（级别比整次没完成低一级）。 */
function raiseSkippedAlert(ctx: HubContext, skipped: SkippedCounts): void {
  const parts = [
    skipped.routines > 0 ? `${skipped.routines} 条旧套路` : null,
    skipped.lessons > 0 ? `${skipped.lessons} 条旧教训` : null,
    skipped.memoryFiles > 0 ? `${skipped.memoryFiles} 位员工的原长期记忆` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return;
  raiseAlert(ctx, { code: ALERT_CODE_SKIPPED, botId: null, level: 'P2', immediate: true,
    text: `升级时有${parts.join('、')}没能整理进技能库，不再带给员工；原文仍保留在旧数据里。` });
}

/** 第三段收尾：每步各记完成标记，出错只记日志，下次启动接着做。 */
async function finalizeSteps(ctx: HubContext, steps: Record<string, boolean>): Promise<void> {
  const step = async (name: string, work: () => void | Promise<void>) => {
    if (steps[name]) return;
    try {
      await work();
      const row = ctx.store.table('migrations').get(MD.MIGRATION_ID);
      if (row) ctx.store.table('migrations').patch(MD.MIGRATION_ID, { steps: { ...row.steps, [name]: true }, updatedAt: ctx.clock.now() });
    } catch (error) {
      ctx.logger.warn(`迁移收尾「${name}」失败，下次启动重试`, { error: String(error) });
    }
  };
  await step('lessonProposals', () => closeLessonProposals(ctx));
  await step('reflectionQueue', () => dropLegacyCandidates(ctx));
  // 步骤名保持 backupMemory（别的卡按这个名字判断「长期记忆文件已停用」）；备份已在迁移前做完，这一步只做改写。
  // 改写某一位员工之前，确认他的备份文件存在、内容不是停用说明（原文本来就没有内容、不需要备份的除外）；
  // 不满足就不改写这一位，这一步不记完成，下次启动再做。
  await step('backupMemory', async () => {
    const blocked: string[] = [];
    for (const bot of ctx.store.table('bots').list()) {
      const path = memoryPathOf(bot.homeDir);
      // P75r4 第 3 节第 4 条：某一位员工的 MEMORY.md 读不出（是目录、没有权限等）：对这位记审计、跳过这一位，
      // 别的员工照做，这一步照常记完成。否则这一步永远不完成，全队的长期记忆文件都不再纳入回合核对。
      let original: string | null;
      try { original = await ctx.fs.readText(path); }
      catch (error) {
        writeOutreachAudit(ctx, 'p75_memory_unreadable', { botId: bot.id, name: bot.name, error: error instanceof Error ? error.message : String(error) }, 'hub');
        continue;
      }
      if (needsBackup(original)) {
        const backup = await ctx.fs.readText(backupPathOf(ctx, bot.id));
        if (backup === null || isNotice(backup)) { blocked.push(bot.id); continue; }
      }
      if (original !== null && isNotice(original)) continue; // 已经是停用说明
      await ctx.fs.writeTextAtomic(path, `${LEGACY_MEMORY_NOTICE}\n`, { within: bot.homeDir });
    }
    if (blocked.length > 0) throw new Error(`${blocked.length} 位员工的备份文件缺失，未改写长期记忆文件`);
  });
  await step('materializeSkills', async () => {
    for (const bot of ctx.store.table('bots').list()) await syncSelfSkills(ctx, bot);
  });
  await step('refreshAll', async () => {
    await ctx.fs.writeTextAtomic(posix.join(ctx.settings.rootDir, 'AGENTS.md'), renderRootAgentsMd(ctx));
    for (const bot of ctx.store.table('bots').list()) await refreshBotFiles(ctx, bot.id);
  });
}
