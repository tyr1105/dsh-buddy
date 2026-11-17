/**
 * P75f 迁移的第一段：在内存里算出全部新行（只读存储，不写任何东西）。
 *
 * P75r2 的原则：除了存储或磁盘本身出错，迁移不再因旧数据的长度或形状整次失败：
 * - 主人的规矩原样迁成记忆（正文不限字数）；这一类万一仍不合格，抛错让整次迁移不做（旧规矩照常生效）；
 * - 教训、套路、长期记忆迁成技能：先切句，再按每条技能最多 12 句分组，一个步骤、一条教训的各句不拆开；
 * - 单条技能算不出来时跳过这一条，记审计和条数，其余照迁。
 * 本文件不写任何表、不写文件，审计也只记在计划里，由调用方在计划成功之后统一写入。
 */
import { MEMORY_DEFAULTS as MD, SKILL_DEFAULTS as SD } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { MemorySchema, type Memory } from '../model/memory.js';
import { SkillSchema, SkillSentenceSchema, type Skill } from '../model/skill.js';
import type { Rule, Routine } from '../model/team.js';
import { newId } from '../util/ids.js';
import { cleanControl, dedupeTitle, oneLine, packUnits, splitSentences } from './p75-split.js';

/** 各出处标签的固定写法。 */
const LABEL_OWNER_INSTRUCTION = '你的指示（升级前教过的会话）';
const LABEL_APPROVED_PROPOSAL = '你批准的提议（升级前）';
const LABEL_LESSON = '迁移：升级前的规矩';
const LABEL_MEMORY_MD = '迁移：原长期记忆';
/** 旧 MEMORY.md 里初始说明那一句；迁移时视同没有内容（停用说明由调用方传入）。 */
const MEMORY_MD_INITIAL = '只记录已经确认、适合长期保留的事实与经验。';

/** 一句技能：正文、出处原文、出处种类与标签（同一原文、种类、标签只建一条出处）。 */
export interface PlanSentence {
  text: string;
  quote: string;
  kind: 'owner_instruction' | 'unknown';
  label: string;
}

/** 一条计划写入的技能。 */
export interface SkillPlan {
  botId: string;
  title: string;
  /** 原始名称（审计与套路出处标签用，不用去重后的名字）。 */
  originName: string;
  whenToUse: string;
  sentences: PlanSentence[];
  legacy: NonNullable<Skill['legacy']>;
  updatedAt: number;
  /** 句子里有主人批准或教过的：在用名额不够时排在前面。 */
  ownerInstruction: boolean;
  /** 写入失败时统计「没能整理的」：套路编号、教训条数、是否是长期记忆。 */
  routineId: string | null;
  lessons: number;
  memoryFile: boolean;
}

/** 一条待写的记忆（不含 id 与固定为默认的字段）。 */
export interface MemoryDraft {
  kind: Memory['kind']; text: string; example: string | null; redLine: boolean;
  scope: Memory['scope']; source: Memory['source']; category: string | null; createdAt: number;
}

/** 没能整理进技能库的条数（套路条数、教训条数、长期记忆的员工数）。 */
export interface SkippedCounts { routines: number; lessons: number; memoryFiles: number }

/** 计划：记忆、技能、要记的审计、跳过的条数。 */
export interface MigrationPlan {
  memories: MemoryDraft[];
  skills: SkillPlan[];
  audits: Array<{ action: string; detail: unknown }>;
  skipped: SkippedCounts;
}

/** 补全 MemorySchema 的其余字段做整行校验。 */
export function toMemoryRow(draft: MemoryDraft, id: string): Memory {
  return { id, kind: draft.kind, text: draft.text, example: draft.example, redLine: draft.redLine,
    scope: draft.scope, source: draft.source, category: draft.category, status: 'active', history: [],
    noteWakeId: null, replyMessageId: null, createdAt: draft.createdAt, updatedAt: draft.createdAt, endedAt: null };
}

/** 旧规矩的出处原文：取正文前 QUOTE_MAX_CHARS 个字，换行换成一个空格。 */
export function legacyQuote(text: string): string {
  const flat = text.replace(/\r\n|\r|\n/g, ' ');
  const quote = [...flat].slice(0, MD.QUOTE_MAX_CHARS).join('');
  return quote.trim() === '' ? [...flat.trim()].slice(0, MD.QUOTE_MAX_CHARS).join('') : quote;
}

/**
 * P75r4 第 2 节：预检直接用技能的结构校验（writeSkillVersion 写入时用的也是它们），不再只查句数和字数：
 * 句子用版本结构里「一句」的那部分，标题和「什么时候用」用技能结构里对应的部分。
 * 为什么：自己另写一份检查，漏掉的项（例如控制字符）要到写入段才失败，一个字符就拖累整组。
 */
const sentenceCheck = SkillSentenceSchema.shape.text;
const titleCheck = SkillSchema.shape.title;
const whenCheck = SkillSchema.shape.whenToUse;

/** 用一个字段的结构校验检查一个值；通过返回 null，不通过返回中文原因。 */
function checkField(schema: { safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } }, value: string): string | null {
  const result = schema.safeParse(value);
  return result.success ? null : (result.error?.issues[0]?.message ?? '不合格');
}

/**
 * 一段旧文字的准备：切句、把句内的制表符等控制字符换成空格并去首尾空白、丢掉换完为空的、逐句预检。
 * 预检不过的只丢这一句（原因放进 dropped），不拖累同一单元、同一组别的句子。
 */
export function prepareSentences(raw: string): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const piece of splitSentences(raw)) {
    const text = cleanControl(piece);
    if (text === '') continue; // 换完为空：按空句处理（不计入跳过）
    const problem = checkField(sentenceCheck, text);
    if (problem === null) kept.push(text); else dropped.push(problem);
  }
  return { kept, dropped };
}

/** 技能计划的预检（让不合格在第一段就暴露、只跳过这一条）：句数、每一句、标题、「什么时候用」都按技能的结构校验。 */
function checkPlan(plan: SkillPlan): void {
  if (plan.sentences.length === 0) throw new Error('没有可迁移的句子');
  if (plan.sentences.length > SD.SENTENCES_MAX) throw new Error(`有 ${plan.sentences.length} 句，超过上限 ${SD.SENTENCES_MAX} 句`);
  for (const sentence of plan.sentences) {
    const problem = checkField(sentenceCheck, sentence.text);
    if (problem !== null) throw new Error(`有一句不合格：${problem}`);
  }
  // 标题在写入前还要去重、截到上限；这里按截断后的样子检查。
  const title = checkField(titleCheck, [...plan.title].slice(0, SD.TITLE_MAX_CHARS).join(''));
  if (title !== null) throw new Error(`技能名称不合格：${title}`);
  const when = checkField(whenCheck, plan.whenToUse);
  if (when !== null) throw new Error(`「什么时候用」不合格：${when}`);
}

/**
 * 旧 MEMORY.md 的迁移计划：去掉标题、空行、初始说明与停用说明后仍有内容才迁；按行切句，取前 SENTENCES_MAX 句。
 * 多出来的不迁入技能（全文在备份文件里），返回总句数让调用方写审计。
 */
function memoryMdPlan(botId: string, updatedAt: number, content: string | null, notice: string):
  { plan: SkillPlan; total: number; dropped: string[] } | null {
  if (content === null) return null;
  const lines = content.split('\n').map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#') && line !== MEMORY_MD_INITIAL && line !== notice);
  if (lines.length === 0) return null;
  const all: PlanSentence[] = [];
  const dropped: string[] = [];
  for (const line of lines) {
    // P75r4 第 2 节：句内的制表符等控制字符先换成空格；预检不过的只丢这一句，同一份文件里别的句子照迁。
    const prepared = prepareSentences(line);
    dropped.push(...prepared.dropped);
    for (const text of prepared.kept) all.push({ text, quote: line, kind: 'unknown', label: LABEL_MEMORY_MD });
  }
  return {
    total: all.length, dropped,
    plan: { botId, title: '原长期记忆', originName: '原长期记忆', whenToUse: '升级前记下的经验与事实，待整理',
      sentences: all.slice(0, SD.SENTENCES_MAX), legacy: { kind: 'memory_md', refId: null }, updatedAt,
      ownerInstruction: false, routineId: null, lessons: 0, memoryFile: true },
  };
}

/**
 * 算出全部新行。memoryFiles 是各员工的长期记忆原文（键是员工编号；备份已存在时调用方传备份内容），
 * notice 是停用说明（视同没有内容）。规矩（记忆）不合格抛中文错误，整次迁移不做；技能一条一条算，出错跳过这一条。
 */
export function planMigration(ctx: HubContext, memoryFiles: Map<string, string | null>, notice: string): MigrationPlan {
  const now = ctx.clock.now();
  const memories: MemoryDraft[] = [];
  const skills: SkillPlan[] = [];
  const audits: MigrationPlan['audits'] = [];
  const skipped: SkippedCounts = { routines: 0, lessons: 0, memoryFiles: 0 };
  const skip = (note: string, detail: Record<string, unknown> = {}) => audits.push({ action: 'p75_migration_skip', detail: { note, ...detail } });
  const bots = ctx.store.table('bots').list();
  const botExists = (id: string) => bots.some(bot => bot.id === id);
  const rules = ctx.store.table('rules').list() as Rule[];
  // 1 与 2. 旧规矩：来源 owner（全队或某员工）、来源 lesson 且作用全队、状态 active → 记忆（规矩），正文原样迁入。
  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    const ownerGlobal = rule.source === 'owner';
    const lessonGlobal = rule.source === 'lesson' && rule.scope === 'global';
    if (!ownerGlobal && !lessonGlobal) continue;
    const staff: Memory['scope']['staff'] = rule.scope === 'global' ? 'all' : [rule.scope];
    if (staff !== 'all' && !botExists(staff[0]!)) { skip(`规矩 ${rule.id} 的员工已不存在，未迁移`); continue; }
    if (rule.text.trim() === '') { skip(`规矩 ${rule.id} 没有内容，未迁移`); continue; }
    const draft: MemoryDraft = {
      kind: 'rule', text: rule.text, example: null, redLine: rule.redLine,
      scope: { staff, projects: 'all' },
      source: { kind: ownerGlobal ? 'legacy_owner_rule' : 'legacy_lesson',
        messageIds: [], quote: legacyQuote(rule.text), threadId: null, legacyRuleId: rule.id },
      category: null, createdAt: rule.createdAt,
    };
    // 逐行过 schema：万一不合格让整次迁移不做；parseInput 给出中文的出错字段。
    parseInput(MemorySchema, toMemoryRow(draft, newId('mem', ctx.rng)), '迁移的记忆行');
    memories.push(draft);
  }
  // 3. 旧规矩：来源 lesson、作用某员工、状态 active → 这位员工的技能「我的做法」（一条教训的各句不拆到两条技能里）。
  // 能对上一条主人接受过的提议（待你处理里 type 为 proposal、refId 是这条规矩、status 为 answered、答复为「接受」）的，出处写主人批准过。
  const approved = new Set(ctx.store.table('inbox').list(row => row.type === 'proposal' && row.status === 'answered' && row.answer === '接受')
    .flatMap(row => row.refId ? [row.refId] : []));
  const lessonsByBot = new Map<string, Rule[]>();
  for (const rule of rules) {
    if (rule.status !== 'active' || rule.source !== 'lesson' || rule.scope === 'global') continue;
    if (!botExists(rule.scope)) { skip(`规矩 ${rule.id} 的员工已不存在，未迁移`); continue; }
    const list = lessonsByBot.get(rule.scope) ?? [];
    list.push(rule);
    lessonsByBot.set(rule.scope, list);
  }
  for (const [botId, list] of lessonsByBot) {
    try {
      // P75r4 第 2 节：句内控制字符先换成空格；预检不过的只丢这一句，一条教训的句子全被丢掉时丢这一条，不拖累同一位员工别的教训。
      let droppedLessons = 0;
      const units = list.map(rule => {
        const prepared = prepareSentences(rule.text);
        for (const reason of prepared.dropped) skip(`规矩 ${rule.id} 有一句没能整理进技能库，已丢这一句：${reason}`, { botId, reason });
        if (prepared.kept.length === 0 && prepared.dropped.length > 0) {
          droppedLessons += 1;
          skip(`规矩 ${rule.id} 的句子全部没能整理进技能库，已丢这一条`, { botId, reason: prepared.dropped[0] });
        }
        return prepared.kept.map((text): PlanSentence => approved.has(rule.id)
          ? { text, quote: rule.text, kind: 'owner_instruction', label: LABEL_APPROVED_PROPOSAL }
          : { text, quote: rule.text, kind: 'unknown', label: LABEL_LESSON });
      });
      const groups = packUnits(units);
      if (groups.length === 0) throw new Error('切句之后没有任何句子');
      // 先全部算好、预检通过，再一起放进计划：中途不合格时不留下这位员工的一半技能。
      const built: SkillPlan[] = [];
      for (const group of groups) {
        const used = group.map(part => list[part.unit]!);
        const plan: SkillPlan = {
          botId, title: '我的做法', originName: '我的做法', whenToUse: '做事时参考',
          sentences: group.flatMap(part => part.items), legacy: { kind: 'lesson', refId: null },
          updatedAt: Math.max(...used.map(rule => rule.createdAt)),
          ownerInstruction: used.some(rule => approved.has(rule.id)),
          routineId: null, lessons: used.length, memoryFile: false,
        };
        checkPlan(plan);
        built.push(plan);
      }
      skills.push(...built);
      skipped.lessons += droppedLessons;
    } catch (error) {
      skipped.lessons += list.length;
      skip(`员工 ${botId} 的 ${list.length} 条教训没能整理进技能库：${error instanceof Error ? error.message : String(error)}`, { botId });
    }
  }
  // 4. 旧套路 → 每条套路一条或几条技能（一个步骤的各句不拆开；learnedFrom 有值时出处是「你的指示」，否则「来源不明」）。
  // 没有任何地方假设一条旧套路只对应一条技能（command grep refId 的核对结果见记录），所以每一篇都写这条套路的编号。
  for (const routine of ctx.store.table('routines').list() as Routine[]) {
    if (!botExists(routine.botId)) { skip(`套路 ${routine.id} 的员工已不存在，未迁移`); continue; }
    try {
      // P75r4 第 2 节：名称、「什么时候用」里的换行、制表符和其他控制字符各换成空格再去首尾空白；
      // 步骤里的句子同样先换掉控制字符，预检不过的只丢这一句，一个步骤的句子全被丢掉时丢这个步骤。
      const name = cleanControl(oneLine(routine.name));
      const taught = routine.learnedFrom !== null && routine.learnedFrom !== '';
      const label = taught ? LABEL_OWNER_INSTRUCTION : `迁移：原套路「${[...name].slice(0, 40).join('')}」`;
      const units = routine.steps.map(step => {
        const prepared = prepareSentences(step);
        for (const reason of prepared.dropped) skip(`套路 ${routine.id} 有一句没能整理进技能库，已丢这一句：${reason}`, { botId: routine.botId, reason });
        if (prepared.kept.length === 0 && prepared.dropped.length > 0)
          skip(`套路 ${routine.id} 有一个步骤的句子全部没能整理进技能库，已丢这个步骤`, { botId: routine.botId, reason: prepared.dropped[0] });
        return prepared.kept.map((text): PlanSentence => ({ text, quote: step, kind: taught ? 'owner_instruction' : 'unknown', label }));
      });
      const groups = packUnits(units);
      if (groups.length === 0) throw new Error('切句之后没有任何句子');
      const when = cleanControl([...cleanControl(oneLine(routine.whenToUse))].slice(0, SD.WHEN_MAX_CHARS).join(''));
      const built: SkillPlan[] = [];
      for (const group of groups) {
        const plan: SkillPlan = {
          botId: routine.botId, title: name === '' ? '旧套路' : name, originName: name === '' ? '旧套路' : name,
          whenToUse: when === '' ? '做事时参考' : when,
          sentences: group.flatMap(part => part.items), legacy: { kind: 'routine', refId: routine.id },
          updatedAt: routine.updatedAt, ownerInstruction: taught, routineId: routine.id, lessons: 0, memoryFile: false,
        };
        checkPlan(plan);
        built.push(plan);
      }
      skills.push(...built); // 一条套路的几篇一起放进计划：中途不合格时整条套路不留下一半
    } catch (error) {
      skipped.routines += 1;
      skip(`套路 ${routine.id} 没能整理进技能库：${error instanceof Error ? error.message : String(error)}`, { botId: routine.botId });
    }
  }
  // 5. 各员工的长期记忆有内容的 → 技能「原长期记忆」（按行切句，取前 12 句，多出来的写一条审计，不并句）。
  for (const bot of bots) {
    try {
      const made = memoryMdPlan(bot.id, bot.updatedAt ?? now, memoryFiles.get(bot.id) ?? null, notice);
      if (made === null) continue;
      for (const reason of made.dropped) skip(`员工 ${bot.id} 的原长期记忆有一句没能整理进技能库，已丢这一句：${reason}`, { botId: bot.id, reason });
      checkPlan(made.plan);
      skills.push(made.plan);
      if (made.total > made.plan.sentences.length)
        audits.push({ action: 'p75_migration_memory_trimmed', detail: { botId: bot.id, total: made.total, kept: made.plan.sentences.length } });
    } catch (error) {
      skipped.memoryFiles += 1;
      skip(`员工 ${bot.id} 的原长期记忆没能整理进技能库：${error instanceof Error ? error.message : String(error)}`, { botId: bot.id });
    }
  }
  // 名称去重按员工做（writeSkillVersion 不允许同一位员工有同名技能）：第二条起加「（2）」「（3）」。
  const perBotUsed = new Map<string, Set<string>>();
  for (const skill of skills) {
    const used = perBotUsed.get(skill.botId) ?? new Set<string>();
    skill.title = dedupeTitle(skill.title, used);
    perBotUsed.set(skill.botId, used);
  }
  return { memories, skills, audits, skipped };
}
