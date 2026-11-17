/**
 * P75r3 第 1.1 至 1.3、1.5、2、9 节的测试（内存文件系统）：回合结束核对不能被关掉。
 *
 * - 1.1 路径本身（.agents、.agents/skills、playbooks、memory、MEMORY.md、技能目录下的每一项）被换成符号链接或别的类型：
 *   把它本身移走、重建、记审计 skill_dir_replaced；
 * - 1.2 核对失败不能只记日志：审计 skill_verify_failed、告警；
 * - 1.3 两句告警逐字、同一位员工同一句话当天只出一条、不计越界、不带编号和路径；
 * - 1.5 投递之前也核对；没有问题时不写文件、不发事件；
 * - 2 按「目录名加编号」精确核对；
 * - 9 MEMORY.md 在迁移的备份步骤完成之后才纳入核对。
 * 内存文件系统用 markSymlink 标出符号链接；真实文件系统上的同类测试在 p75r3-real-fs.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { MemoryFs } from '../src/io/testing/index.js';
import { botFixture } from './model-fixtures.js';
import { newId } from '../src/util/ids.js';
import { SkillSourceSchema } from '../src/model/skill.js';
import { writeSkillVersion } from '../src/skill/store.js';
import { selfSkillPath, verifyManagedSkillFiles, SKILL_DIR_REPLACED_ALERT, SKILL_VERIFY_FAILED_ALERT } from '../src/skill/files.js';
import { syncPresetSkills } from '../src/memory/preset-skills.js';
import { verifyManagedFiles, createBotHome, LEGACY_MEMORY_NOTICE } from '../src/memory/index.js';
import { verifyBeforeDelivery } from '../src/turn/pre-delivery.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { interruptBot } from '../src/api/interrupt.js';
import { onTurnEvent } from '../src/turn/events.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { SKILL_DEFAULTS, MEMORY_DEFAULTS } from '../src/config/defaults.js';

const HOME = botFixture.homeDir;
const NAME = botFixture.name;
const at = (...parts: string[]): string => posix.join(HOME, ...parts);

/** 一位带两个预置技能、一条在用的自己积累技能的员工；家目录已建好。 */
async function setup(patch: Partial<typeof botFixture> = {}) {
  const ctx = createTestContext();
  const bot = { ...botFixture, presetSkillIds: ['owner-brief', 'data-check'], dshSkillNames: [] as string[], ...patch };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const source = SkillSourceSchema.parse({
    id: newId('ss', ctx.rng), botId: bot.id, kind: 'review', label: '活动报名页第 1 轮退回第 3 条',
    quote: '提示文字与约定不一致', relayed: false, jobId: null, category: '表单页', refs: {}, createdAt: ctx.clock.now(),
  });
  ctx.store.table('skillSources').put(source);
  await writeSkillVersion(ctx, {
    botId: bot.id, change: 'create', newSkill: { title: '表单页做法', whenToUse: '做表单页时用', supplements: null },
    sentences: [{ text: '提交后显示明确的成功提示', sourceIds: [source.id] }, { text: '先校验必填项', sourceIds: [source.id] }],
    updateId: null, checkedBy: null, categories: ['表单页'],
  });
  const skill = ctx.store.table('skills').list()[0]!;
  const fs = ctx.fs as unknown as MemoryFs;
  return { ctx, bot, skill, fs, skillFile: selfSkillPath(bot, skill), expected: (await ctx.fs.readText(selfSkillPath(bot, skill)))! };
}
type Env = Awaited<ReturnType<typeof setup>>;

const auditsOf = (env: Env, action: string) => env.ctx.store.log('audit').all().filter(row => row.action === action).map(row => JSON.parse(row.detail) as Record<string, unknown>);
const alertTexts = (env: Env) => env.ctx.store.table('alerts').list().map(row => row.text);

/** 监视这个目录下的任何文件变化（写入、删除、移动）。 */
function watchWrites(env: Env): { count: () => number; stop: () => void } {
  let n = 0;
  const stop = env.ctx.fs.watch('/', { recursive: true }, () => { n += 1; });
  return { count: () => n, stop };
}

describe('P75r3 1.1 路径本身被换掉：移走本身、重建、核对内容', () => {
  it('.agents 被换成符号链接：链接本身移走（里面员工写的东西原样在搬走的位置），技能文件由技能库重新写出，告警一条逐字，审计一条，不计越界', async () => {
    const env = await setup();
    const { ctx, bot, skill, fs, skillFile, expected } = env;
    await ctx.fs.writeTextAtomic(skillFile, '员工改写的技能内容');
    fs.markSymlink(at('.agents'));
    const violations = bot.violations;
    await verifyManagedFiles(ctx, bot.id);
    // 技能库的内容回来了，.agents 不再是链接。
    expect(await ctx.fs.readText(skillFile)).toBe(expected);
    expect((await ctx.fs.lstat(at('.agents')))!.isSymlink).toBe(false);
    expect(await ctx.fs.readText(at('.agents/skills/owner-brief/SKILL.md'))).toContain('dsh-buddy:preset-skill:owner-brief');
    // 审计一条：哪个路径、是什么东西、搬到哪里；搬走的位置里保留着员工写的内容。
    const replaced = auditsOf(env, 'skill_dir_replaced');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ botId: bot.id, path: '.agents', found: '符号链接' });
    const to = replaced[0]!.to as string;
    expect(to).toContain(posix.join(SKILL_DEFAULTS.STRAY_DIR, bot.id));
    expect(await ctx.fs.readText(posix.join(to, 'skills', skill.dirName, 'SKILL.md'))).toBe('员工改写的技能内容');
    // 告警一条、文字逐字、不带编号和路径；不计越界。
    // P75r4 第 3 节第 2 条改了预期：告警第一句改写（原句「技能目录被换成了别的东西」）。
    expect(alertTexts(env)).toEqual([`${NAME}家目录里由中心维护的目录被替换过，中心已按技能库的内容恢复。`]);
    expect(alertTexts(env)[0]).not.toContain(bot.id);
    expect(alertTexts(env)[0]).not.toContain('.agents');
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(violations);
  });

  it('.agents/skills 被换成符号链接：同样移走并恢复', async () => {
    const env = await setup();
    const { ctx, bot, fs, skillFile, expected } = env;
    await ctx.fs.writeTextAtomic(skillFile, '员工改写的技能内容');
    fs.markSymlink(at('.agents/skills'));
    await verifyManagedFiles(ctx, bot.id);
    expect(await ctx.fs.readText(skillFile)).toBe(expected);
    expect(auditsOf(env, 'skill_dir_replaced')).toMatchObject([{ path: '.agents/skills', found: '符号链接' }]);
    expect(alertTexts(env)).toHaveLength(1);
  });

  it('playbooks 被换成一个文件：类型不对，移走并重建成目录', async () => {
    const env = await setup();
    const { ctx, bot } = env;
    await ctx.fs.remove(at('playbooks'));
    await ctx.fs.writeTextAtomic(at('playbooks'), '员工写的一个文件');
    await verifyManagedFiles(ctx, bot.id);
    expect((await ctx.fs.lstat(at('playbooks')))!.isDir).toBe(true);
    const replaced = auditsOf(env, 'skill_dir_replaced');
    expect(replaced).toMatchObject([{ path: 'playbooks', found: '文件' }]);
    expect(await ctx.fs.readText(replaced[0]!.to as string)).toBe('员工写的一个文件');
    expect(alertTexts(env)).toHaveLength(1);
  });

  it('memory 被换成符号链接：移走并重建 memory 与 memory/journal', async () => {
    const env = await setup();
    const { ctx, bot, fs } = env;
    // P75r4 第 3 节第 3 条改了夹具：迁移完成之前不查 memory 目录本身，所以这条先让迁移记录进入 done 且备份步骤完成；断言不变。
    ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'done', attempts: 1, written: {}, steps: { backupMemory: true }, error: null, updatedAt: 1 });
    fs.markSymlink(at('memory'));
    await verifyManagedFiles(ctx, bot.id);
    expect((await ctx.fs.lstat(at('memory')))!.isSymlink).toBe(false);
    expect((await ctx.fs.lstat(at('memory/journal')))!.isDir).toBe(true);
    expect(auditsOf(env, 'skill_dir_replaced')).toMatchObject([{ path: 'memory', found: '符号链接' }]);
  });

  it('技能目录下的一项是符号链接或文件：整项移走，每项一条审计，告警当天仍只有一条', async () => {
    const env = await setup();
    const { ctx, bot, fs } = env;
    await ctx.fs.mkdirp(at('.agents/skills/zz-link'));
    fs.markSymlink(at('.agents/skills/zz-link'));
    await ctx.fs.writeTextAtomic(at('.agents/skills/a-file.md'), '散落的文件');
    await verifyManagedFiles(ctx, bot.id);
    expect(await ctx.fs.list(at('.agents/skills'))).not.toContain('zz-link');
    expect(await ctx.fs.list(at('.agents/skills'))).not.toContain('a-file.md');
    expect(auditsOf(env, 'skill_dir_replaced').map(row => [row.path, row.found]).sort()).toEqual([
      ['.agents/skills/a-file.md', '文件'], ['.agents/skills/zz-link', '符号链接']]);
    expect(alertTexts(env)).toHaveLength(1);
  });

  it('MEMORY.md 被换成符号链接：迁移的备份步骤完成之后移走，并改写回停用说明', async () => {
    const env = await setup();
    const { ctx, bot, fs } = env;
    ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'done', attempts: 1, written: {}, steps: { backupMemory: true }, error: null, updatedAt: 1 });
    await ctx.fs.writeTextAtomic(at('memory/MEMORY.md'), '员工自己写的长期记忆');
    fs.markSymlink(at('memory/MEMORY.md'));
    await verifyManagedFiles(ctx, bot.id);
    expect((await ctx.fs.lstat(at('memory/MEMORY.md')))!.isSymlink).toBe(false);
    expect(await ctx.fs.readText(at('memory/MEMORY.md'))).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
    expect(auditsOf(env, 'skill_dir_replaced')).toMatchObject([{ path: 'memory/MEMORY.md', found: '符号链接' }]);
    expect(alertTexts(env)).toHaveLength(1);
  });

  it('反例：一切正常时没有审计、没有告警、不写任何文件、不发任何事件', async () => {
    const env = await setup();
    const { ctx, bot } = env;
    await verifyManagedFiles(ctx, bot.id); // 先让一切就位
    const events = ctx.events.length;
    const audits = ctx.store.log('audit').all().length;
    const watcher = watchWrites(env);
    await verifyManagedFiles(ctx, bot.id);
    await verifyBeforeDelivery(ctx, bot.id);
    expect(watcher.count()).toBe(0);
    watcher.stop();
    expect(ctx.events.length).toBe(events);
    expect(ctx.store.log('audit').all().length).toBe(audits);
    expect(ctx.store.table('alerts').count()).toBe(0);
  });
});

describe('P75r3 1.2、1.3 核对失败不能只记日志；告警当天只出一条', () => {
  it('核对中写入失败：记审计 skill_verify_failed、出告警（逐字），不抛出去，不计越界', async () => {
    const env = await setup();
    const { ctx, bot, skillFile } = env;
    await ctx.fs.writeTextAtomic(skillFile, '员工改写的技能内容');
    ctx.fs.writeTextAtomic = async () => { throw new Error('路径越界：模拟写入被文件层拒绝'); };
    await expect(verifyManagedFiles(ctx, bot.id)).resolves.toBeUndefined();
    const failed = auditsOf(env, 'skill_verify_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ botId: bot.id, steps: ['恢复自己积累技能文件'] });
    expect(alertTexts(env)).toEqual([`${NAME}家目录里的技能目录核对没有完成，下一个回合读到的技能可能不是技能库里的内容。`]);
    expect(alertTexts(env)[0]).not.toContain(bot.id);
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(0);
  });

  it('同一位员工、同一句话，当天只出一条；过了一天再出', async () => {
    const env = await setup();
    const { ctx, bot, skillFile } = env;
    // 先改写技能文件，再让写入一直失败：每次核对都恢复不了。
    await ctx.fs.writeTextAtomic(skillFile, '员工改写的技能内容');
    ctx.fs.writeTextAtomic = async () => { throw new Error('模拟失败'); };
    for (let i = 0; i < 3; i += 1) {
      await verifyManagedFiles(ctx, bot.id);
      ctx.clock.advance(10 * 60_000);
    }
    expect(auditsOf(env, 'skill_verify_failed')).toHaveLength(3);
    expect(alertTexts(env).filter(text => text === SKILL_VERIFY_FAILED_ALERT(NAME))).toHaveLength(1);
    // 过了一天（每次推进 10 分钟）：同一句话再出一条。
    for (let i = 0; i < 150; i += 1) ctx.clock.advance(10 * 60_000);
    await verifyManagedFiles(ctx, bot.id);
    expect(alertTexts(env).filter(text => text === SKILL_VERIFY_FAILED_ALERT(NAME))).toHaveLength(2);
  });

  it('「移走并恢复」那一句同样当天只出一条', async () => {
    const env = await setup();
    const { ctx, bot, fs } = env;
    for (let i = 0; i < 3; i += 1) {
      fs.markSymlink(at('.agents/skills'));
      await verifyManagedFiles(ctx, bot.id);
      ctx.clock.advance(10 * 60_000);
    }
    expect(auditsOf(env, 'skill_dir_replaced')).toHaveLength(3);
    expect(alertTexts(env)).toEqual([SKILL_DIR_REPLACED_ALERT(NAME)]);
  });

  it('两句告警逐字固定', () => {
    // P75r4 第 3 节第 2 条改了预期：告警第一句改写。
    expect(SKILL_DIR_REPLACED_ALERT('小明')).toBe('小明家目录里由中心维护的目录被替换过，中心已按技能库的内容恢复。');
    expect(SKILL_VERIFY_FAILED_ALERT('小明')).toBe('小明家目录里的技能目录核对没有完成，下一个回合读到的技能可能不是技能库里的内容。');
  });
});

describe('P75r3 第 2 节：按「目录名加编号」精确核对', () => {
  /** 在技能目录下放一个目录，里面一份 SKILL.md。 */
  async function plant(env: Env, name: string, content: string) {
    await env.ctx.fs.mkdirp(at('.agents/skills', name));
    await env.ctx.fs.writeTextAtomic(at('.agents/skills', name, 'SKILL.md'), content);
  }
  const moved = (env: Env) => auditsOf(env, 'stray_skill_moved').map(row => row.dir as string).sort();

  it('审查 M1 复现一：名字等于自己某个 DSH 技能名的目录被搬走', async () => {
    const env = await setup({ dshSkillNames: ['pdf'] });
    await plant(env, 'pdf', '员工自己写的内容');
    await verifyManagedFiles(env.ctx, env.bot.id);
    expect(moved(env)).toEqual(['pdf']);
    expect(await env.ctx.fs.list(at('.agents/skills'))).not.toContain('pdf');
  });

  it('审查 M1 复现二：任意名字、文件里含中心标记字样的目录被搬走', async () => {
    const env = await setup();
    await plant(env, 'evil', '<!-- dsh-buddy:self-skill:x:v1 -->');
    await plant(env, 'evil2', '<!-- dsh-buddy:preset-skill:owner-brief -->');
    await verifyManagedFiles(env.ctx, env.bot.id);
    expect(moved(env)).toEqual(['evil', 'evil2']);
  });

  it('目录名对得上、标记写的是别的技能编号：搬走，随后由技能库重新写出正确内容', async () => {
    const env = await setup();
    const { ctx, skill, skillFile, expected } = env;
    await ctx.fs.writeTextAtomic(skillFile, '<!-- dsh-buddy:self-skill:sk_other0001:v1 -->\n员工换成了别的技能的标记');
    await ctx.fs.writeTextAtomic(at('.agents/skills', skill.dirName, 'notes.md'), '员工放在同一个目录里的笔记');
    await verifyManagedFiles(ctx, env.bot.id);
    expect(moved(env)).toEqual([skill.dirName]);
    expect(await ctx.fs.readText(skillFile)).toBe(expected);
    // 同目录里员工放的笔记随整个目录搬走，不留在新目录里。
    expect(await ctx.fs.readText(at('.agents/skills', skill.dirName, 'notes.md'))).toBeNull();
    const to = auditsOf(env, 'stray_skill_moved')[0]!.to as string;
    expect(await ctx.fs.readText(posix.join(to, 'notes.md'))).toBe('员工放在同一个目录里的笔记');
  });

  it('正例：正常的自己积累技能目录与勾选了的预置技能目录都不动（没有审计、没有告警、不写任何文件）', async () => {
    const env = await setup();
    await verifyManagedFiles(env.ctx, env.bot.id);
    const watcher = watchWrites(env);
    await verifyManagedFiles(env.ctx, env.bot.id);
    expect(watcher.count()).toBe(0);
    watcher.stop();
    expect(moved(env)).toEqual([]);
    expect((await env.ctx.fs.list(at('.agents/skills'))).sort()).toEqual(['data-check', 'owner-brief', env.skill.dirName].sort());
    expect(alertTexts(env)).toEqual([]);
  });

  it('正例：目录名对得上、文件被员工改成没有任何标记的内容，原地恢复（不另外搬走）', async () => {
    const env = await setup();
    await env.ctx.fs.writeTextAtomic(env.skillFile, '被员工改掉的内容');
    await verifyManagedFiles(env.ctx, env.bot.id);
    expect(await env.ctx.fs.readText(env.skillFile)).toBe(env.expected);
    expect(moved(env)).toEqual([]);
  });

  it('预置技能没有勾选：同名目录被搬走', async () => {
    const env = await setup({ presetSkillIds: ['owner-brief'] });
    await plant(env, 'data-check', '员工自己写的内容，预置技能并没有勾选');
    await verifyManagedFiles(env.ctx, env.bot.id);
    expect(moved(env)).toEqual(['data-check']);
    // 勾选了的那个照旧在。
    expect(await env.ctx.fs.list(at('.agents/skills'))).toContain('owner-brief');
  });

  it('收起的技能：它自己带标记的目录由同步清理，不算多余目录（没有搬走审计）', async () => {
    const env = await setup();
    const { ctx, bot, skill } = env;
    // 直接把技能收起、但不经 setSkillState，模拟「目录还在、文件还在」的瞬间。
    ctx.store.table('skills').patch(skill.id, { state: 'collapsed', collapseReason: 'unused', collapsedAt: 1 });
    await verifyManagedFiles(ctx, bot.id);
    expect(moved(env)).toEqual([]);
    expect(await ctx.fs.readText(env.skillFile)).toBeNull();
  });

  it('syncPresetSkills 仍照旧：取消勾选的带标记文件被删', async () => {
    const env = await setup();
    const bot = { ...env.bot, presetSkillIds: ['owner-brief'] };
    expect((await syncPresetSkills(env.ctx, bot)).removed).toEqual(['data-check']);
  });
});

describe('P75r3 第 9 节：MEMORY.md 什么时候纳入核对', () => {
  const memory = (env: Env) => env.ctx.fs.readText(at('memory/MEMORY.md'));
  const done = (env: Env, steps: Record<string, boolean>) => env.ctx.store.table('migrations').put({
    id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'done', attempts: 1, written: {}, steps, error: null, updatedAt: 1 });

  it('迁移是 done 但备份这一步没有完成：不改写 MEMORY.md', async () => {
    const env = await setup();
    await env.ctx.fs.writeTextAtomic(at('memory/MEMORY.md'), '员工写的长期记忆原文');
    done(env, { lessonProposals: true });
    await verifyManagedFiles(env.ctx, env.bot.id);
    expect(await memory(env)).toBe('员工写的长期记忆原文');
  });
  it('备份这一步完成之后：改写过的会被恢复成停用说明', async () => {
    const env = await setup();
    done(env, { backupMemory: true });
    await env.ctx.fs.writeTextAtomic(at('memory/MEMORY.md'), '员工又改写了');
    await verifyManagedFiles(env.ctx, env.bot.id);
    expect(await memory(env)).toBe(`${LEGACY_MEMORY_NOTICE}\n`);
  });
  it('迁移没有 done（或没有记录）：同样不改写', async () => {
    const env = await setup();
    await env.ctx.fs.writeTextAtomic(at('memory/MEMORY.md'), '员工写的长期记忆原文');
    await verifyManagedFiles(env.ctx, env.bot.id);
    expect(await memory(env)).toBe('员工写的长期记忆原文');
    env.ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'failed', attempts: 1, written: {}, steps: { backupMemory: true }, error: '模拟', updatedAt: 1 });
    await verifyManagedFiles(env.ctx, env.bot.id);
    expect(await memory(env)).toBe('员工写的长期记忆原文');
  });
});

describe('P75r3 1.5 投递之前也核对', () => {
  /** 一位在岗员工、一条自己积累的技能、一个等着派出的主人消息候选；host 的建会话与投递都会记下当时技能文件的内容。 */
  async function delivery() {
    const env = await setup({ sessionId: null });
    const { ctx, bot } = env;
    ctx.clock.advance(ctx.settings.startupQuietMs);
    const seen: Array<string | null> = [];
    const host = ctx.host as unknown as { createSession: (input: unknown) => Promise<{ sessionId: string }>; deliver: (sessionId: string, text: string, source: unknown) => Promise<void> };
    const createSession = host.createSession.bind(host);
    const deliver = host.deliver.bind(host);
    host.createSession = async input => { seen.push(await ctx.fs.readText(env.skillFile)); return createSession(input); };
    host.deliver = async (sessionId, text, source) => { seen.push(await ctx.fs.readText(env.skillFile)); return deliver(sessionId, text, source); };
    const dispatcher = createDispatcher(ctx);
    const send = async (summary: string) => {
      ctx.clock.advance(ctx.settings.dispatchGapMs);
      enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'owner_message', score: 1, summary, messageId: `m_${summary}` }));
      await dispatcher.pump();
    };
    return { ...env, seen, send };
  }

  it('两个回合之间技能文件被直接改写：下一次投递之前已恢复，员工这个回合读到的是技能库的内容', async () => {
    const env = await delivery();
    const { ctx, bot } = env;
    await env.send('第一件事');
    const first = ctx.store.table('wakes').list()[0]!;
    // 回合正常结束（结束时的核对也会跑一次）。
    await onTurnEvent(ctx, { type: 'ended', sessionId: first.sessionId!, at: ctx.clock.now(), tokens: 10, finalText: '好' });
    ctx.host.sessions.get(first.sessionId!)!.running = false;
    // 两个回合之间，员工（或别的员工）经不透明的命令直接改写了技能文件。
    await ctx.fs.writeTextAtomic(env.skillFile, '回合之间被改写的内容');
    await env.send('第二件事');
    expect(env.seen).toHaveLength(2);
    expect(env.seen[1]).toBe(env.expected);
    expect(await ctx.fs.readText(env.skillFile)).toBe(env.expected);
    expect(ctx.store.table('bots').get(bot.id)!.violations).toBe(0);
  });

  it('主人打断一个回合之后的下一次投递同样已恢复（打断不经过回合结束的核对）', async () => {
    const env = await delivery();
    const { ctx, bot } = env;
    await env.send('第一件事');
    await interruptBot(ctx, { botId: bot.id });
    await ctx.fs.writeTextAtomic(env.skillFile, '打断之后被改写的内容');
    await env.send('第二件事');
    expect(env.seen).toHaveLength(2);
    expect(env.seen[1]).toBe(env.expected);
  });

  it('核对本身出错时不阻止投递（记审计和告警，投递照常）', async () => {
    const env = await delivery();
    const { ctx } = env;
    await ctx.fs.writeTextAtomic(env.skillFile, '被改写的内容');
    ctx.fs.writeTextAtomic = async () => { throw new Error('模拟写入失败'); };
    await env.send('第一件事');
    expect(env.seen).toHaveLength(1);
    expect(ctx.store.table('wakes').list()[0]).toMatchObject({ status: 'running' });
    expect(auditsOf(env, 'skill_verify_failed')).toHaveLength(1);
    expect(alertTexts(env)).toContain(SKILL_VERIFY_FAILED_ALERT(NAME));
  });

  it('没有问题时投递前核对不写任何文件、不发任何事件', async () => {
    const env = await delivery();
    const { ctx, bot } = env;
    await verifyManagedFiles(ctx, bot.id);
    const emits = ctx.events.length;
    const watcher = watchWrites(env);
    await verifyBeforeDelivery(ctx, bot.id);
    expect(watcher.count()).toBe(0);
    watcher.stop();
    expect(ctx.events.length).toBe(emits);
  });
});

describe('P75r3 内存文件系统的 move（接口新增的方法）', () => {
  it('移动整棵子树、连同符号链接标记；源不存在、目标已存在都抛错；目标父目录自动建', async () => {
    const env = await setup();
    const { ctx, fs } = env;
    await ctx.fs.writeTextAtomic('/t/a/x.txt', 'X');
    await ctx.fs.writeTextAtomic('/t/a/sub/y.txt', 'Y');
    fs.markSymlink('/t/a/sub');
    await ctx.fs.move('/t/a', '/t/new/deeper/a');
    expect(await ctx.fs.readText('/t/a/x.txt')).toBeNull();
    expect(await ctx.fs.readText('/t/new/deeper/a/x.txt')).toBe('X');
    expect((await ctx.fs.lstat('/t/new/deeper/a/sub'))!.isSymlink).toBe(true);
    expect((await ctx.fs.lstat('/t/a/sub'))).toBeNull();
    await expect(ctx.fs.move('/t/missing', '/t/z')).rejects.toThrow('移动源不存在');
    await ctx.fs.writeTextAtomic('/t/exist.txt', 'E');
    await expect(ctx.fs.move('/t/new', '/t/exist.txt')).rejects.toThrow('移动目标已存在');
  });
  it('带边界时，源的上级是符号链接就拒绝；源本身是链接则可以移动', async () => {
    const env = await setup();
    const { ctx, fs } = env;
    await ctx.fs.writeTextAtomic('/b/home/real/f.txt', 'F');
    await ctx.fs.mkdirp('/b/home/lnk');
    fs.markSymlink('/b/home/lnk');
    await ctx.fs.move('/b/home/lnk', '/b/aside/lnk', { within: '/b/home' });
    expect((await ctx.fs.lstat('/b/aside/lnk'))!.isSymlink).toBe(true);
    fs.markSymlink('/b/home/real');
    await expect(ctx.fs.move('/b/home/real/f.txt', '/b/aside/f.txt', { within: '/b/home' })).rejects.toThrow('路径越界');
    expect(await ctx.fs.readText('/b/home/real/f.txt')).toBe('F');
  });
});

describe('P75r3 verifyManagedSkillFiles 直接调用', () => {
  it('第三个参数为假时不检查 MEMORY.md 与迁移状态无关；缺 SKILL.md 的中心技能目录不被搬走', async () => {
    const env = await setup();
    await env.ctx.fs.remove(env.skillFile);
    await verifyManagedSkillFiles(env.ctx, env.bot, false);
    // 文件缺失：目录名对得上，不算多余目录，随后由同步写回。
    expect(await env.ctx.fs.readText(env.skillFile)).toBe(env.expected);
    expect(auditsOf(env, 'stray_skill_moved')).toEqual([]);
  });
});
