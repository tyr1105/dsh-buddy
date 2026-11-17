/**
 * P75c 的测试（三）：身份文件改读记忆、upsertRule 改写、给主人看的文字不含内部名称、记忆表只经服务写入。
 *
 * 身份文件的两种来源：迁移完成（或没有旧规矩）读记忆；旧规矩还没迁移时仍读旧规矩表，规矩照常生效。
 * 全部走真实的 Hub 和注入的内存文件；时间用假时钟（每次推进不超过 10 分钟）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_DEFAULTS } from '../src/config/defaults.js';
import { refreshBotFiles } from '../src/memory/files.js';
import { legacyRulesInEffect, memoriesForBot } from '../src/memory/memory-read.js';
import { renderBotAgentsMd, renderRootAgentsMd } from '../src/memory/render.js';
import { correctMemoryText, setMemoryStatus, writeMemory, type WriteMemoryInput } from '../src/memory/service.js';
import { upsertRule } from '../src/memory/rules.js';
import { byteLength } from '../src/util/text.js';
import { agentsMdOf, bot, jobFix, memoriesOf, messagesIn, noted, MINUTE, type JobFix } from './p75c-fixtures.js';

const SECTION = '## 主人的规矩与偏好（全队共用，中心维护）';

/** 一条写记忆的参数（可覆盖）：来源是主人在记忆页自己写的，不依赖对话。 */
function input(text: string, extra: Partial<WriteMemoryInput> = {}): WriteMemoryInput {
  return { kind: 'rule', text, example: `例：${text.slice(0, 6)}`, redLine: false, scope: { staff: 'all', projects: 'all' },
    source: { kind: 'owner_edit', messageIds: [], quote: text, threadId: null }, ...extra };
}

/** 取身份文件里「主人的规矩与偏好」段的正文行（到下一个「## 」段标题之前为止；P75r1 起它后面还有「我的志向」段）。 */
function sectionLines(md: string): string[] {
  const start = md.indexOf(SECTION);
  expect(start, '身份文件里应该有「主人的规矩与偏好」段').toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + SECTION.length);
  const end = rest.indexOf('\n## ');
  return (end < 0 ? rest : rest.slice(0, end)).split('\n').filter(line => line !== '');
}

/** 标记迁移已完成：记忆可用。 */
function markMigrated(fix: JobFix): void {
  fix.ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'done', attempts: 1, written: {}, steps: {}, error: null, updatedAt: fix.ctx.clock.now() });
}

/** P75f：中心启动会自动迁移并记 done；模拟「升级前」要把记录置为未完成。 */
function unmarkMigrated(fix: JobFix): void {
  fix.ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'failed', attempts: 0, written: {}, steps: {}, error: null, updatedAt: fix.ctx.clock.now() });
}

describe('读记忆还是读旧规矩', () => {
  it('没有旧规矩：记忆可用，文件是新的段名，没有记忆写「暂无」', async () => {
    const fix = await jobFix();
    await refreshBotFiles(fix.ctx, fix.engineer.id);
    const md = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
    expect(md).toContain(`${SECTION}\n暂无\n`);
    expect(md).not.toContain('## 红线与规矩');
  });

  it('工具清单：总管的清单写 hub_memory（仅总管），执行员工的清单没有这一句', async () => {
    const fix = await jobFix();
    await refreshBotFiles(fix.ctx, fix.chief.id);
    await refreshBotFiles(fix.ctx, fix.engineer.id);
    const sentence = 'hub_memory 记住主人以后都适用的规矩或偏好（仅总管）。';
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.chief.id))).toContain(sentence);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).not.toContain('hub_memory');
  });

  // P75r1：原来的断言是「旧规矩还没迁移时三处只读旧规矩表、不读记忆」，现在改成「旧规矩表和记忆两边都读，迁移完成之后只读记忆」。
  it('旧规矩还没迁移（有生效的旧规矩、迁移未完成）：旧规矩表和记忆两边都读（写法不变）；迁移完成后只读记忆', async () => {
    const fix = await jobFix();
    unmarkMigrated(fix);
    await upsertRule(fix.ctx, { scope: 'global', text: '旧红线：先核实来源', redLine: true });
    await upsertRule(fix.ctx, { scope: fix.engineer.id, text: '旧规矩：交回前先自测' });
    expect(legacyRulesInEffect(fix.ctx)).toBe(true);
    await writeMemory(fix.ctx, input('新规矩：提示用请字开头'));
    const engineer = bot(fix, fix.engineer.id);
    const both = await agentsMdOf(fix.ctx, engineer);
    expect(both).toContain('## 红线与规矩\n- 红线：旧红线：先核实来源\n- 旧规矩：交回前先自测\n');
    expect(both).toContain(`${SECTION}\n- 规矩：新规矩：提示用请字开头（例如：例：新规矩：提示）\n`);
    expect(renderBotAgentsMd(fix.ctx, engineer)).toBe(both);
    const root = renderRootAgentsMd(fix.ctx);
    expect(root).toContain('## 全体规矩\n- 红线：旧红线：先核实来源\n- 规矩：新规矩：提示用请字开头');
    expect(root).not.toContain('旧规矩：交回前先自测');
    // 迁移完成：旧规矩表不再读，只读记忆。
    markMigrated(fix);
    expect(legacyRulesInEffect(fix.ctx)).toBe(false);
    const after = renderBotAgentsMd(fix.ctx, engineer);
    expect(after).toContain(`${SECTION}\n- 规矩：新规矩：提示用请字开头（例如：例：新规矩：提示）\n`);
    expect(after).not.toContain('旧红线');
    expect(after).not.toContain('## 红线与规矩');
    expect(renderRootAgentsMd(fix.ctx)).toContain('## 全体规矩\n- 规矩：新规矩：提示用请字开头');
    expect(renderRootAgentsMd(fix.ctx)).not.toContain('旧红线');
  });
});

describe('排序、适用范围、项目后缀', () => {
  it('红线、规矩、偏好；同类内按更新时间倒序', async () => {
    const fix = await jobFix();
    await writeMemory(fix.ctx, input('偏好甲：汇报先说结论', { kind: 'preference', example: null }));
    fix.ctx.clock.advance(MINUTE);
    await writeMemory(fix.ctx, input('规矩甲：提示用请字开头'));
    fix.ctx.clock.advance(MINUTE);
    await writeMemory(fix.ctx, input('红线甲：不要对外发布', { redLine: true }));
    fix.ctx.clock.advance(MINUTE);
    await writeMemory(fix.ctx, input('规矩乙：按钮用圆角'));
    fix.ctx.clock.advance(MINUTE);
    await writeMemory(fix.ctx, input('偏好乙：交付带截图', { kind: 'preference', example: null }));
    const lines = sectionLines(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id)));
    expect(lines).toEqual([
      '- 红线：红线甲：不要对外发布',
      `- 规矩：规矩乙：按钮用圆角（例如：例：规矩乙：按钮）`,
      `- 规矩：规矩甲：提示用请字开头（例如：例：规矩甲：提示）`,
      '- 偏好：偏好乙：交付带截图',
      '- 偏好：偏好甲：汇报先说结论',
    ]);
    // 更正一条就刷新了它的更新时间，同类内排到前面。
    fix.ctx.clock.advance(MINUTE);
    const old = memoriesOf(fix.ctx).find(row => row.text.startsWith('规矩甲'))!;
    await correctMemoryText(fix.ctx, old.id, '规矩甲：提示一律用请字开头', 'owner', '测试更正');
    expect(sectionLines(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id)))[1]).toContain('规矩甲：提示一律用请字开头');
  });

  it('staff 只含另一位员工的规矩，不出现在这位员工的文件和全体守则里；已撤销、已删除、先例不出现', async () => {
    const fix = await jobFix();
    await writeMemory(fix.ctx, input('只给评审甲：核对要写依据', { scope: { staff: [fix.reviewer.id], projects: 'all' } }));
    await writeMemory(fix.ctx, input('给全队：提示用请字开头'));
    const gone = await writeMemory(fix.ctx, input('已撤销的规矩'));
    await setMemoryStatus(fix.ctx, gone.id, 'undone', 'owner');
    const deleted = await writeMemory(fix.ctx, input('已删除的规矩'));
    await setMemoryStatus(fix.ctx, deleted.id, 'deleted', 'owner');
    await writeMemory(fix.ctx, { kind: 'precedent', text: '先例：配色：深色', example: null, redLine: false, scope: { staff: 'all', projects: 'all' },
      source: { kind: 'agreement', messageIds: [], quote: '配色：深色', threadId: null }, category: '展示页' });
    const engineer = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
    const reviewer = await agentsMdOf(fix.ctx, bot(fix, fix.reviewer.id));
    expect(engineer).toContain('给全队：提示用请字开头');
    expect(engineer).not.toContain('只给评审甲');
    expect(reviewer).toContain('只给评审甲：核对要写依据');
    expect(reviewer).toContain('给全队：提示用请字开头');
    for (const text of ['已撤销的规矩', '已删除的规矩', '先例：配色']) { expect(engineer).not.toContain(text); expect(reviewer).not.toContain(text); }
    const root = renderRootAgentsMd(fix.ctx);
    expect(root).toContain('给全队：提示用请字开头');
    expect(root).not.toContain('只给评审甲');
    expect(memoriesForBot(fix.ctx, fix.reviewer).map(row => row.text).sort()).toEqual(['只给评审甲：核对要写依据', '给全队：提示用请字开头']);
  });

  it('projects 不是全部时，行尾加「（仅用于项目名）」', async () => {
    const fix = await jobFix();
    await writeMemory(fix.ctx, input('只在这个项目里：文案用请字开头', { scope: { staff: 'all', projects: [fix.project.id] } }));
    const lines = sectionLines(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id)));
    expect(lines).toEqual(['- 规矩：只在这个项目里：文案用请字开头（例如：例：只在这个项目）（仅用于季度战役）']);
  });
});

describe('长度上限', () => {
  it('40 条记忆：整段不超过 2 KB，整条截断，末行写「另有 n 条未列出。」，固定部分完整', async () => {
    const fix = await jobFix();
    const engineer = bot(fix, fix.engineer.id);
    await refreshBotFiles(fix.ctx, fix.engineer.id);
    const baseline = await agentsMdOf(fix.ctx, engineer);
    // P75r1：可变部分的顺序改为「红线与规矩、主人的规矩与偏好、我的志向」，固定部分截到记忆段标题之前。
    const fixedPart = baseline.slice(0, baseline.indexOf(SECTION));
    for (let i = 1; i <= 40; i += 1) {
      fix.ctx.clock.advance(1_000);
      await writeMemory(fix.ctx, input(`第${String(i).padStart(2, '0')}条规矩：提示文字都用「请」字开头并保持一致`));
    }
    const md = await agentsMdOf(fix.ctx, engineer);
    expect(md.startsWith(fixedPart), '固定部分原样保留').toBe(true);
    const afterTitle = md.slice(md.indexOf(SECTION) + SECTION.length + 1);
    const body = afterTitle.slice(0, afterTitle.indexOf('\n## ')); // 到「我的志向」段标题之前
    expect(byteLength(body.trimEnd())).toBeLessThanOrEqual(MEMORY_DEFAULTS.AGENTS_SECTION_MAX_BYTES);
    const lines = body.trimEnd().split('\n');
    const tail = /^另有 (\d+) 条未列出。$/.exec(lines.at(-1)!);
    expect(tail, '末行应该写明有几条未列出').not.toBeNull();
    const shown = lines.slice(0, -1);
    expect(shown.length + Number(tail![1])).toBe(40);
    // 整条截断：每一行都是完整的一条，没有半句。
    for (const line of shown) expect(line).toMatch(/^- 规矩：第\d\d条规矩：提示文字都用「请」字开头并保持一致（例如：例：第\d\d条规矩）$/);
    // 最新的在前：被截掉的是最旧的。
    expect(shown[0]).toContain('第40条');
    expect(md).not.toContain('已截断');
  });

  it('不超限时没有末行；一条也不会被切成半句', async () => {
    const fix = await jobFix();
    for (let i = 1; i <= 3; i += 1) await writeMemory(fix.ctx, input(`第${i}条规矩：提示用请字开头`));
    const lines = sectionLines(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id)));
    expect(lines).toHaveLength(3);
    expect(lines.some(line => line.startsWith('另有'))).toBe(false);
  });

  it('量出总管与执行员工身份文件固定部分的字节数（写进进度记录）', async () => {
    const fix = await jobFix();
    await refreshBotFiles(fix.ctx, fix.chief.id);
    await refreshBotFiles(fix.ctx, fix.engineer.id);
    const sizes = new Map<string, number>();
    for (const who of [fix.chief, fix.engineer]) {
      const md = await agentsMdOf(fix.ctx, bot(fix, who.id));
      sizes.set(who.name, byteLength(md.slice(0, md.indexOf(SECTION))));
    }
    // 固定部分各自要小于单个身份文件的上限，留得出空间给志向和规矩段。
    for (const size of sizes.values()) expect(size).toBeLessThan(fix.ctx.settings.botAgentsMaxBytes - MEMORY_DEFAULTS.AGENTS_SECTION_MAX_BYTES);
    // eslint-disable-next-line no-console
    console.info(`P75c 固定部分字节数：总管 ${sizes.get('老大')}，执行员工 ${sizes.get('林舟')}`);
  });
});

describe('UiApi upsertRule 改写', () => {
  it('记忆可用：新建写一条记忆（来源「你写下的规矩」），不写 rules 表；修改更正；archived 改为删除；返回形状不变', async () => {
    const fix = await jobFix();
    const created = await fix.hub.api.upsertRule({ scope: 'global', text: '先核实来源再下结论', redLine: true });
    expect(created).toMatchObject({ ok: true, data: { scope: 'global', text: '先核实来源再下结论', redLine: true, source: 'owner', status: 'active' } });
    expect(fix.ctx.store.table('rules').count()).toBe(0);
    const [memory] = memoriesOf(fix.ctx);
    expect(memory).toMatchObject({ kind: 'rule', redLine: true, scope: { staff: 'all', projects: 'all' },
      source: { kind: 'owner_edit', quote: '先核实来源再下结论', threadId: null, messageIds: [] } });
    expect(sectionLines(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id)))).toEqual(['- 红线：先核实来源再下结论']);
    // 单个员工的规矩：scope 转成员工名单。
    await fix.hub.api.upsertRule({ scope: fix.engineer.id, text: '交回前先自测' });
    expect(memoriesOf(fix.ctx)[1]!.scope.staff).toEqual([fix.engineer.id]);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.reviewer.id))).not.toContain('交回前先自测');
    // 带 id 的修改：按记忆编号找到，更正文字，旧说法进历史。
    const edited = await fix.hub.api.upsertRule({ id: memory!.id, scope: 'global', text: '先核实来源并写明出处', redLine: true });
    expect(edited).toMatchObject({ ok: true, data: { text: '先核实来源并写明出处' } });
    expect(fix.ctx.store.table('memories').get(memory!.id)!.history.map(row => row.text)).toEqual(['先核实来源再下结论']);
    // 归档：改为删除。
    const archived = await fix.hub.api.upsertRule({ id: memory!.id, scope: 'global', text: '先核实来源并写明出处', status: 'archived' });
    expect(archived).toMatchObject({ ok: true, data: { status: 'archived' } });
    expect(fix.ctx.store.table('memories').get(memory!.id)!.status).toBe('deleted');
    expect(fix.ctx.store.table('rules').count()).toBe(0);
    // 不存在的范围、不存在的 id、提议中的状态：拒绝。
    expect(await fix.hub.api.upsertRule({ scope: 'missing', text: '不明范围' })).toMatchObject({ ok: false, error: expect.stringContaining('scope') });
    expect(await fix.hub.api.upsertRule({ id: 'ru_0000000000', scope: 'global', text: '不存在' })).toMatchObject({ ok: false, error: expect.stringContaining('id') });
    expect(await fix.hub.api.upsertRule({ scope: 'global', text: '尚待批准', status: 'proposed' })).toMatchObject({ ok: false });
  });

  // P75r1：原来的断言是「旧规矩未迁移时，新建也照旧写 rules 表、不写记忆」；现在新建一律写记忆，只有「改旧规矩表里那一行」才写旧规矩表。
  it('旧规矩未迁移：新建写记忆；带旧规矩的 id 修改，改的是那条旧规矩本身；迁移完成后带旧 id 不再改旧规矩表', async () => {
    const fix = await jobFix();
    unmarkMigrated(fix);
    const legacy = await upsertRule(fix.ctx, { scope: 'global', text: '旧规矩：先核实来源' });
    expect(legacyRulesInEffect(fix.ctx)).toBe(true);
    const created = await fix.hub.api.upsertRule({ scope: fix.engineer.id, text: '交回前先自测', redLine: true });
    expect(created).toMatchObject({ ok: true, data: { scope: fix.engineer.id, text: '交回前先自测', redLine: true, source: 'owner' } });
    expect(fix.ctx.store.table('rules').count()).toBe(1);
    expect(memoriesOf(fix.ctx)).toHaveLength(1);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain('- 红线：交回前先自测');
    // 带旧规矩的 id：改的是旧规矩表那一行，不新增记忆。
    const edited = await fix.hub.api.upsertRule({ id: legacy.id, scope: 'global', text: '旧规矩：先核实来源并写明出处' });
    expect(edited).toMatchObject({ ok: true, data: { id: legacy.id, text: '旧规矩：先核实来源并写明出处' } });
    expect(fix.ctx.store.table('rules').get(legacy.id)!.text).toBe('旧规矩：先核实来源并写明出处');
    expect(memoriesOf(fix.ctx)).toHaveLength(1);
    // 迁移完成：旧规矩表不再读，带旧 id 的修改走记忆这一边（找不到对应记忆时报「规矩不存在」）。
    markMigrated(fix);
    expect(await fix.hub.api.upsertRule({ id: legacy.id, scope: 'global', text: '再改一次' })).toMatchObject({ ok: false, error: expect.stringContaining('id') });
    expect(fix.ctx.store.table('rules').get(legacy.id)!.text).toBe('旧规矩：先核实来源并写明出处');
  });

  it('机器人详情的 rules 字段：记忆可用时由记忆生成，形状不变', async () => {
    const fix = await jobFix();
    await writeMemory(fix.ctx, input('给全队：提示用请字开头'));
    await writeMemory(fix.ctx, input('只给林舟：交回前先自测', { scope: { staff: [fix.engineer.id], projects: 'all' }, redLine: true }));
    const view = await fix.hub.api.bot(fix.engineer.id);
    expect(view.rules.map(row => ({ text: row.text, redLine: row.redLine, scope: row.scope }))).toEqual([
      { text: '只给林舟：交回前先自测', redLine: true, scope: 'bot' },
      { text: '给全队：提示用请字开头', redLine: false, scope: 'global' },
    ]);
    expect((await fix.hub.api.bot(fix.reviewer.id)).rules.map(row => row.text)).toEqual(['给全队：提示用请字开头']);
  });
});

describe('给主人看的文字不含内部名称；记忆表只经服务写入', () => {
  it('「已记住」「已撤销」的文字和视图里给主人看的文字不含 hub_、mem_、b_', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    await fix.hub.api.sendMessage(fix.chief.id, '撤销');
    const internal = /hub_|mem_|\bb_[0-9a-z]{10}|\bm_[0-9a-z]{10}/;
    for (const row of messagesIn(fix.ctx, fix.chief.id).filter(item => item.from !== 'owner')) expect(row.text, row.text).not.toMatch(internal);
    for (const message of fix.hub.api.thread(fix.chief.id).messages) {
      expect(message.text).not.toMatch(internal);
      // memoryId 是界面「撤销」按钮的参数，不是显示的文字；显示的字段（种类名、正文）不含内部名称。
      for (const note of message.memoryNotes ?? []) { expect(note.text).not.toMatch(internal); expect(note.kindLabel).not.toMatch(internal); }
    }
    expect(memory.text).not.toMatch(internal);
  });

  it('src 下除 memory/service.ts 与迁移文件外没有直接写记忆表的代码', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith('.ts') || file === join('memory', 'service.ts') || file === join('migrate', 'p75-storage.ts')) continue;
      const text = readFileSync(join(root, file), 'utf8');
      // 对记忆表只允许读（get、list、count）；任何别的用法（put、patch、remove，或存成变量再写）都算越界。
      if (/table\('memories'\)(?!\s*\.(?:get|list|count)\b)/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('P75e/P75f：skills、skillVersions 两张表只经 skill/store.ts 与迁移文件写入（P75e 的白名单核对并到此处）', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith('.ts') || file === join('skill', 'store.ts') || file === join('migrate', 'p75-storage.ts')) continue;
      const text = readFileSync(join(root, file), 'utf8');
      if (/table\('skills'\)(?!\s*\.(?:get|list|count)\b)/.test(text)) offenders.push(file);
      if (/table\('skillVersions'\)(?!\s*\.(?:get|list|count)\b)/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
