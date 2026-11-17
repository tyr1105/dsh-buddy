/**
 * P75b 的测试一：第四块新增的数据结构与表。
 * 覆盖：每个新 schema 一正一反（错误信息含字段名）；旧存档（不含九张新表）照常启动、九张新表读成空；
 * 新表写入后重启读回一致，且 40 天后（清理也跑过）仍在；新增的默认值分组与拦截原因。
 */
import { describe, expect, it } from 'vitest';
import { MEMORY_DEFAULTS, SKILL_DEFAULTS } from '../src/config/defaults.js';
import { explainSuppression } from '../src/appraisal/log.js';
import { parseWithPaths } from '../src/model/agreement.js';
import {
  AgreementTagSchema, JobOutcomeSchema, MemorySchema, MigrationSchema, SkillRunSchema, SkillSchema, SkillSourceSchema,
  SkillUpdateSchema, SkillVersionSchema, SUPPRESSION_REASONS, SUPPRESSION_REASON_LABELS,
} from '../src/model/index.js';
import type { QueueEntry } from '../src/model/index.js';
import { FileStore, TABLE_NAMES, type Store, type TableName } from '../src/store/index.js';
import { FakeClock, MemoryFs, MemoryLogger } from '../src/io/testing/index.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-05T04:00:00Z');
const ROOT = '/hub-fixture';
const TZ = 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// 合格样本（每个 schema 一份）；反例在它的基础上改一处
// ---------------------------------------------------------------------------
const skill = {
  id: 'sk_aaaaaaaaaa', botId: 'b_aaaaaaaaaa', title: '表单页做法', whenToUse: '做报名表单这类页面时', supplements: null,
  dirName: 'self-aaaaaaaa', state: 'active', collapseReason: null, currentVersionNo: 1, categories: ['表单页'], lastUsedAt: null,
  legacy: null, createdAt: NOW, updatedAt: NOW, collapsedAt: null,
};
const version = {
  id: 'skv_aaaaaaaaaa', skillId: 'sk_aaaaaaaaaa', no: 1,
  sentences: [{ text: '提交失败时在按钮下方提示原因', sourceIds: ['ss_aaaaaaaaaa'], addedInNo: 1 }],
  change: 'create', updateId: null, basedOnNo: null, checkedBy: 'hub', createdAt: NOW,
};
const source = {
  id: 'ss_aaaaaaaaaa', botId: 'b_aaaaaaaaaa', kind: 'review', label: '活动报名页第 1 轮退回第 3 条', quote: '失败时页面没有任何提示',
  relayed: false, jobId: 'job_aaaaaaaaaa', category: '表单页', refs: { reviewId: 'jrv_aaaaaaaaaa', itemNo: 3 }, createdAt: NOW,
};
const update = {
  id: 'su_aaaaaaaaaa', botId: 'b_aaaaaaaaaa', runId: 'sr_aaaaaaaaaa', kind: 'learn', skillId: null,
  newSkill: { title: '表单页做法', whenToUse: '做报名表单这类页面时', supplements: null }, mergeFromIds: [],
  sentences: [{ text: '提交失败时在按钮下方提示原因', sourceIds: ['ss_aaaaaaaaaa'] }],
  checkerId: 'b_bbbbbbbbbb', state: 'checking',
  checks: [{ at: NOW, checkerId: 'b_bbbbbbbbbb', exists: 'unmet', consistent: 'met', withinScope: 'met', note: null }],
  rewrites: 0, versionNo: null, createdAt: NOW, updatedAt: NOW,
};
const run = {
  id: 'sr_aaaaaaaaaa', kind: 'retro', jobId: 'job_aaaaaaaaaa', category: '表单页',
  participants: [{ botId: 'b_aaaaaaaaaa', role: 'executor', sourceIds: ['ss_aaaaaaaaaa'], state: 'skipped', reason: 'no_checker' }],
  turnsUsed: 0, turnCap: 5, tokens: 0, summaryPostedAt: null, createdAt: NOW, endedAt: null,
};
const outcome = {
  id: 'job_aaaaaaaaaa', category: '表单页', executorId: 'b_aaaaaaaaaa', reviewerId: null, title: '活动报名页',
  rounds: 1, reworks: 0, turns: 3, seq: 1, acceptedAt: NOW,
};
const tag = { id: 'agr_aaaaaaaaaa', category: '表单页', setAt: NOW };
const memory = {
  id: 'mem_aaaaaaaaaa', kind: 'rule', text: '页面一律提供手机版', example: null, redLine: false,
  scope: { staff: 'all', projects: 'all' },
  source: { kind: 'owner_words', messageIds: ['m1'], quote: '以后页面都要有手机版', threadId: 'b_aaaaaaaaaa' },
  category: null, status: 'active', history: [], noteWakeId: null, replyMessageId: null, createdAt: NOW, updatedAt: NOW, endedAt: null,
};
const migration = { id: 'p75-storage', state: 'writing', attempts: 1, written: { skills: ['sk_aaaaaaaaaa'] }, steps: { backup: false }, error: null, updatedAt: NOW };

/** 正例必须通过；反例必须失败，且错误信息含字段名和给定的中文片段。 */
function check(schema: Parameters<typeof parseWithPaths>[0], good: unknown, label: string, bads: Array<[string, unknown, string, string]>) {
  expect(() => parseWithPaths(schema, good, label), `${label}正例`).not.toThrow();
  for (const [name, bad, field, fragment] of bads) {
    let message = '';
    try { parseWithPaths(schema, bad, label); } catch (error) { message = (error as Error).message; }
    expect(message, `${label}反例：${name}应被拒绝`).not.toBe('');
    expect(message, `${label}反例：${name}应点出字段`).toContain(field);
    expect(message, `${label}反例：${name}应有中文说明`).toContain(fragment);
  }
}

describe('1 新增 schema：一正一反，错误信息含字段名', () => {
  it('Skill：缺字段、标题超 20 字、dirName 格式、多余字段', () => {
    const { botId: _drop, ...missing } = skill;
    check(SkillSchema, skill, '技能', [
      ['缺 botId', missing, 'botId', ''],
      ['标题 21 字', { ...skill, title: '一'.repeat(21) }, 'title', '不能超过 20 字'],
      ['dirName 不合格式', { ...skill, dirName: 'self-AB' }, 'dirName', 'self-'],
      ['dirName 少一位', { ...skill, dirName: 'self-aaaaaaa' }, 'dirName', '8 位'],
      ['多余字段', { ...skill, extra: 1 }, 'extra', '不支持字段'],
    ]);
  });
  it('SkillVersion：句子 0 句、13 句、某句出处为空、某句超 80 字', () => {
    const sentence = version.sentences[0]!;
    check(SkillVersionSchema, version, '技能版本', [
      ['0 句', { ...version, sentences: [] }, 'sentences', '至少要有 1 句'],
      ['13 句', { ...version, sentences: Array.from({ length: SKILL_DEFAULTS.SENTENCES_MAX + 1 }, () => sentence) }, 'sentences', '最多 12 句'],
      ['sourceIds 为空', { ...version, sentences: [{ ...sentence, sourceIds: [] }] }, 'sentences[0].sourceIds', '至少要有 1 个出处'],
      ['句子 81 字', { ...version, sentences: [{ ...sentence, text: '字'.repeat(81) }] }, 'sentences[0].text', '不能超过 80 字'],
    ]);
    // 12 句、每句恰好 80 字是边界上的正例。
    expect(() => parseWithPaths(SkillVersionSchema, {
      ...version, sentences: Array.from({ length: 12 }, () => ({ ...sentence, text: '字'.repeat(80) })),
    }, '技能版本')).not.toThrow();
  });
  it('SkillSource：出处原文超 400 字、类型不在名单内、缺 refs', () => {
    const { refs: _refs, ...missing } = source;
    check(SkillSourceSchema, source, '出处', [
      ['原文 401 字', { ...source, quote: '字'.repeat(401) }, 'quote', '不能超过 400 字'],
      ['类型不对', { ...source, kind: 'guess' }, 'kind', '出处类型'],
      ['缺 refs', missing, 'refs', ''],
    ]);
  });
  it('SkillUpdate：checks 允许 exists 为 unmet；新建缺名称、合并缺目标、改写 2 次被拒', () => {
    check(SkillUpdateSchema, update, '技能更新', [
      ['新建没写名称', { ...update, newSkill: null }, 'newSkill', '新建技能'],
      ['合并没写目标', { ...update, kind: 'merge', newSkill: null, skillId: null, mergeFromIds: ['sk_bbbbbbbbbb'] }, 'skillId', '合并'],
      ['合并没并入任何技能', { ...update, kind: 'merge', newSkill: null, skillId: 'sk_aaaaaaaaaa', mergeFromIds: [] }, 'mergeFromIds', '至少'],
      ['改写 2 次', { ...update, rewrites: 2 }, 'rewrites', '最多改写 1 次'],
      ['某句没有出处', { ...update, sentences: [{ text: '一句', sourceIds: [] }] }, 'sentences[0].sourceIds', '至少要有 1 个出处'],
    ]);
    // 出处不存在时中心写 unmet，必须能存。
    expect(parseWithPaths(SkillUpdateSchema, update, '技能更新').checks[0]!.exists).toBe('unmet');
  });
  it('SkillRun：原因码只能取名单之内的值或 null', () => {
    check(SkillRunSchema, run, '复盘记录', [
      ['原因码不在名单', { ...run, participants: [{ ...run.participants[0], reason: 'whatever' }] }, 'participants[0].reason', '原因码'],
      ['回合数为负', { ...run, turnsUsed: -1 }, 'turnsUsed', ''],
    ]);
    for (const reason of ['no_checker', 'owner_paused', 'archived', 'skill_cap', 'skill_expired', 'busy_all_day', 'no_update', null]) {
      expect(() => parseWithPaths(SkillRunSchema, { ...run, participants: [{ ...run.participants[0], reason }] }, '复盘记录'), String(reason)).not.toThrow();
    }
  });
  it('JobOutcome 与 AgreementTag：id 前缀、seq 从 1 起', () => {
    check(JobOutcomeSchema, outcome, '同类任务记录', [
      ['seq 为 0', { ...outcome, seq: 0 }, 'seq', '不能小于 1'],
      ['id 不是事的编号', { ...outcome, id: 'x_aaaaaaaaaa' }, 'id', 'job_'],
    ]);
    check(AgreementTagSchema, tag, '约定类别', [
      ['id 不是约定编号', { ...tag, id: 'job_aaaaaaaaaa' }, 'id', 'agr_'],
      ['类别为空', { ...tag, category: '' }, 'category', ''],
    ]);
  });
  it('Memory：适用范围写成空数组被拒；history 超 20 条被拒；原话超 300 字被拒', () => {
    check(MemorySchema, memory, '记忆', [
      ['staff 为空数组', { ...memory, scope: { staff: [], projects: 'all' } }, 'scope.staff', '不能是空数组'],
      ['projects 为空数组', { ...memory, scope: { staff: 'all', projects: [] } }, 'scope.projects', '不能是空数组'],
      ['staff 写成别的字', { ...memory, scope: { staff: 'some', projects: 'all' } }, 'scope.staff', ''],
      ['history 21 条', { ...memory, history: Array.from({ length: 21 }, () => ({ text: '旧', at: NOW, by: 'owner', note: '' })) }, 'history', '最多保留 20 条'],
      ['原话 301 字', { ...memory, source: { ...memory.source, quote: '字'.repeat(301) } }, 'source.quote', '不能超过 300 字'],
      ['正文 121 字', { ...memory, text: '字'.repeat(121) }, 'text', '不能超过 120 字'],
    ]);
    // 指定员工和项目的非空数组是合格的。
    expect(() => parseWithPaths(MemorySchema, { ...memory, scope: { staff: ['b_aaaaaaaaaa'], projects: ['prj_aaaaaaaaaa'] } }, '记忆')).not.toThrow();
  });
  it('Migration：状态不在名单内被拒', () => {
    check(MigrationSchema, migration, '迁移记录', [
      ['状态不对', { ...migration, state: 'half' }, 'state', '迁移状态'],
      ['steps 的值不是布尔', { ...migration, steps: { backup: 'yes' } }, 'steps', ''],
    ]);
  });
});

describe('2 默认值分组与拦截原因', () => {
  it('SKILL_DEFAULTS、MEMORY_DEFAULTS 与任务卡逐项一致（抽查关键项与词表）', () => {
    expect(SKILL_DEFAULTS.CATEGORIES).toEqual(['表单页', '展示页', '数据整理', '数据核对', '文档撰写', '调研报告', '脚本工具', '问题排查', '设计稿', '其他']);
    expect(SKILL_DEFAULTS).toMatchObject({
      DEFAULT_CATEGORY: '其他', SELF_ACTIVE_MAX: 12, SENTENCES_MAX: 12, SENTENCE_MAX_CHARS: 80, TITLE_MAX_CHARS: 20, WHEN_MAX_CHARS: 60,
      // P75r5b：复盘回合上限 5 改 7；P75r5c：学习 4 改 6、整理 2 改 3（同步既有断言的两个数字；原来 TIDY_TURN_CAP 起的后半行被注释吞掉没有断言，这里恢复成断言）。
      RETRO_TURN_CAP: 7, LEARN_TURN_CAP: 6, TIDY_TURN_CAP: 3,
      TEAM_DAILY_TURNS: 12, WORK_EXPIRE_MS: 7 * DAY, UNUSED_COLLAPSE_MS: 30 * DAY,
      SKILL_FILE_MAX_BYTES: 4096, PACKET_MAX_BYTES: 12288, DIR_PREFIX: 'self-', STRAY_DIR: '.hub/stray-skills', LEGACY_DIR: '.hub/legacy',
    });
    expect(MEMORY_DEFAULTS).toMatchObject({ TEXT_MAX_CHARS: 120, QUOTE_MAX_CHARS: 300, HISTORY_MAX: 20, MIGRATION_ID: 'p75-storage', MIGRATION_ALERT_AFTER: 3, ASK_SUFFIX: '要我以后都这样吗' });
    expect(MEMORY_DEFAULTS.NOTE_TRIGGER_WORDS).toEqual(['以后', '今后', '都', '每次', '不要再', '别再', '记住', '一律', '所有']);
    expect(MEMORY_DEFAULTS.FIXED_RULES).toHaveLength(4);
  });
  it('三个新拦截原因在类型和名单里存在，说明文字不含英文代码', () => {
    const entry = { reason: { kind: 'percept', summary: '复盘', evidence: [], score: 0.5 }, botId: 'b_aaaaaaaaaa' } as unknown as QueueEntry;
    const expected = { skill_cap: '这次复盘、技能核对、学习或整理的回合已用完', skill_daily_cap: '全队今天的复盘与整理回合已用完', skill_expired: '等待超过 7 天，已放弃', skill_stale: '这次记录里已没有这位员工要做的事，不再进行' } as const; // P75r5b：拦截原因名单加 skill_stale；P75r7：按实际覆盖的回合种类补「技能核对」
    for (const [key, text] of Object.entries(expected)) {
      expect(SUPPRESSION_REASONS).toContain(key);
      expect(SUPPRESSION_REASON_LABELS[key as keyof typeof expected]).toBe(text);
      expect(SUPPRESSION_REASON_LABELS[key as keyof typeof expected]).not.toMatch(/[A-Za-z_]/);
      const explained = explainSuppression(entry, key as keyof typeof expected, null, NOW, TZ);
      expect(explained).toContain(text);
      expect(explained.slice(explained.indexOf('：') + 1)).not.toMatch(/[A-Za-z_]/);
    }
  });
});

// ---------------------------------------------------------------------------
// 存储：旧存档与重启读回
// ---------------------------------------------------------------------------
const NEW_TABLES = ['skills', 'skillVersions', 'skillSources', 'skillUpdates', 'skillRuns', 'jobOutcomes', 'agreementTags', 'memories', 'migrations'] as const;

function newStore(fs: MemoryFs, clock: FakeClock): Store {
  return new FileStore(fs, clock, ROOT, TZ, new MemoryLogger());
}

describe('3 旧存档与持久化', () => {
  it('TABLE_NAMES 含九张新表', () => {
    for (const name of NEW_TABLES) expect(TABLE_NAMES).toContain(name);
  });

  it('旧存档（只有原有表的文件）：九张新表读成空，原有表读取不变，也不因此标脏', async () => {
    const clock = new FakeClock(NOW);
    const fs = new MemoryFs(clock);
    await fs.writeTextAtomic(`${ROOT}/.hub/state/rules.json`, JSON.stringify([
      { id: 'ru_aaaaaaaaaa', text: '先核验证据', scope: 'global', redLine: false, source: 'owner', status: 'active', createdAt: NOW },
    ]));
    await fs.writeTextAtomic(`${ROOT}/.hub/state/jobs.json`, JSON.stringify([]));
    const store = newStore(fs, clock);
    await store.load();
    for (const name of NEW_TABLES) expect(store.table(name as TableName).count(), name).toBe(0);
    expect(store.table('rules').get('ru_aaaaaaaaaa')).toMatchObject({ text: '先核验证据' });
    expect(store.isDirty()).toBe(false);
  });

  it('九张新表写入、落盘、重启后内容一致；40 天后（清理也跑过）仍在', async () => {
    const clock = new FakeClock(NOW);
    const fs = new MemoryFs(clock);
    const first = newStore(fs, clock);
    await first.load();
    const rows: Record<(typeof NEW_TABLES)[number], { id: string }> = {
      skills: skill, skillVersions: version, skillSources: source, skillUpdates: update, skillRuns: run,
      jobOutcomes: outcome, agreementTags: tag, memories: memory, migrations: migration,
    };
    for (const name of NEW_TABLES) first.table(name as TableName).put(rows[name] as never);
    await first.flush();

    // 40 天后：时间只推进存储层自己的参数（假时钟和 prune 的 nowMs），没有任何引擎在跑。
    clock.advance(40 * DAY);
    await first.prune(clock.now());
    const second = newStore(fs, clock);
    await second.load();
    for (const name of NEW_TABLES) {
      expect(second.table(name as TableName).list(), name).toEqual([rows[name]]);
    }
    expect(second.isDirty()).toBe(false);
  });
});
