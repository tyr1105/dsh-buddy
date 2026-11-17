/**
 * P76b 的测试一：第五块（进度、预算、通知）新增的六张表与两组常量。
 * 覆盖：每个新 schema 一正一反（错误信息含字段名）；旧存档（没有这六张表）加载后六表都是空；
 * 存储加载遇到目录里不认识的文件不报错（旧版本读新存档的前提）；六表写入后重启读回一致，且 40 天后（清理也跑过）仍在；
 * 常量与既有常量保持同一来源（不写第二个字面量）；新装默认值与旧默认值替换表。
 * 注：任务卡写「五张新表」，逐项列出的是六张（用量、预计、停滞记号、额度窗口、通知队列、主人上次打开），按六张实现。
 */
import { describe, expect, it } from 'vitest';
import { BUDGET_DEFAULTS, DEFAULTS, JOB_DEFAULTS, NOTIFY_DEFAULTS, P76_SETTINGS_REPLACEMENTS, resolveSettings } from '../src/config/defaults.js';
import { parseWithPaths } from '../src/model/agreement.js';
import {
  JobEstimateSchema, JobNoticeSchema, JobUsageSchema, OwnerPresenceSchema, PushQueueRowSchema, QuotaPlanSchema,
} from '../src/model/index.js';
import { FileStore, TABLE_NAMES, type Store, type TableName } from '../src/store/index.js';
import { FakeClock, MemoryFs, MemoryLogger } from '../src/io/testing/index.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-05T04:00:00Z');
const ROOT = '/hub-fixture';
const TZ = 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// 合格样本（每个 schema 一份）；反例在它的基础上改一处
// ---------------------------------------------------------------------------
const stepUsage = { turns: 0, tokens: 0 };
const jobUsage = {
  id: 'job_aaaaaaaaaa', agreementId: 'agr_aaaaaaaaaa', category: '表单页',
  steps: { align: { turns: 1, tokens: 90_000 }, exec: { turns: 1, tokens: 160_000 }, review: stepUsage, rework: stepUsage, chief: stepUsage, launch: stepUsage },
  turns: [{ wakeId: 'w_aaaaaaaaaa', step: 'exec', botId: 'b_aaaaaaaaaa', startedAt: NOW, endedAt: null, tokens: 0 }],
  finalizedAt: null, updatedAt: NOW,
};
const turnRow = jobUsage.turns[0]!;
const jobEstimate = {
  id: 'agr_aaaaaaaaaa',
  versions: [{
    versionNo: 1, total: 9, steps: { align: 1, exec: 3, review: 1, rework: 3, chief: 1 },
    tokenLow: 1_100_000, tokenHigh: 2_700_000, basis: 'default', historyCount: 0, reason: 'draft', createdAt: NOW,
  }],
};
const jobNotice = {
  id: 'job_aaaaaaaaaa', lastProgressAt: NOW, rewakeAt: null, stallNotifiedAt: null, stallKind: null, overdueNotifiedFor: null,
  remindedItemIds: [], budgetAskedCaps: [], holdAtCap: false, narrowRequestedAt: null, dueRiskNotifiedAt: null, updatedAt: NOW,
};
const quotaPlan = {
  id: 'quota', capacityTokens: 10_000_000, capacitySource: 'initial', windowStartAt: NOW, staffTokens: 0, ownerTokens: 0,
  staffTurns: 0, ownerTurns: 0, exhausted: null, ownerHoldUntil: null, borrowJobIds: [], errors: [], updatedAt: NOW,
};
const quotaError = { at: NOW, text: '已达到 5 小时的使用上限', resetAt: NOW + 3_600_000, pluginTokens: 4_000_000 };
const pushRow = {
  id: 'pq_aaaaaaaaaa', category: 'agreement', title: '约定待确认', body: '', subjectKey: 'agreement:agr_aaaaaaaaaa', botId: null,
  createdAt: NOW, sendAfter: NOW, state: 'waiting', sentAt: null, mergedInto: null,
};
const presence = { id: 'owner', lastSeenAt: null, away: null, updatedAt: NOW };

const NEW_TABLES = ['jobUsage', 'jobEstimates', 'jobNotices', 'quotaWindows', 'pushQueue', 'ownerPresence'] as const;
const ROWS: Record<(typeof NEW_TABLES)[number], { id: string }> = {
  jobUsage, jobEstimates: jobEstimate, jobNotices: jobNotice, quotaWindows: quotaPlan, pushQueue: pushRow, ownerPresence: presence,
};

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
  it('jobUsage：多一个字段被拒；turns 201 项被拒、200 项合格；步骤不在六个之内被拒；缺一步被拒', () => {
    const { launch: _launch, ...fiveSteps } = jobUsage.steps;
    check(JobUsageSchema, jobUsage, '一件事的用量', [
      ['多一个字段', { ...jobUsage, extra: 1 }, 'extra', '不支持字段'],
      ['turns 201 项', { ...jobUsage, turns: Array.from({ length: 201 }, () => turnRow) }, 'turns', '最多保留 200 项'],
      ['回合的步骤写错', { ...jobUsage, turns: [{ ...turnRow, step: 'think' }] }, 'turns[0].step', '步骤必须是'],
      ['缺 launch 一步', { ...jobUsage, steps: fiveSteps }, 'steps.launch', ''],
      ['category 为空', { ...jobUsage, category: '' }, 'category', '不能为空'],
      ['token 为负', { ...jobUsage, steps: { ...jobUsage.steps, exec: { turns: 1, tokens: -1 } } }, 'steps.exec.tokens', ''],
    ]);
    expect(() => parseWithPaths(JobUsageSchema, { ...jobUsage, turns: Array.from({ length: 200 }, () => turnRow) }, '一件事的用量')).not.toThrow();
  });
  it('jobEstimates：多一个字段被拒；原因四种都合格、第五种被拒；依据只能是 default 或 history；steps 缺 chief 被拒', () => {
    const version = jobEstimate.versions[0]!;
    const { chief: _chief, ...fourSteps } = version.steps;
    check(JobEstimateSchema, jobEstimate, '预计消耗', [
      ['多一个字段', { ...jobEstimate, extra: 1 }, 'extra', '不支持字段'],
      ['原因写错', { ...jobEstimate, versions: [{ ...version, reason: 'guess' }] }, 'versions[0].reason', '原因必须是'],
      ['依据写错', { ...jobEstimate, versions: [{ ...version, basis: 'guess' }] }, 'versions[0].basis', '依据必须是'],
      ['steps 缺 chief', { ...jobEstimate, versions: [{ ...version, steps: fourSteps }] }, 'steps.chief', ''],
      ['版本号为 0', { ...jobEstimate, versions: [{ ...version, versionNo: 0 }] }, 'versionNo', '至少为 1'],
      ['id 不是约定编号', { ...jobEstimate, id: 'job_aaaaaaaaaa' }, 'id', 'agr_'],
    ]);
    for (const reason of ['lock', 'top_up', 'narrow', 'draft']) {
      expect(() => parseWithPaths(JobEstimateSchema, { ...jobEstimate, versions: [{ ...version, reason }] }, '预计消耗'), reason).not.toThrow();
    }
  });
  it('jobNotices：多一个字段被拒；停滞种类写错被拒；三种停滞都合格；holdAtCap 不是布尔被拒', () => {
    check(JobNoticeSchema, jobNotice, '停滞记号', [
      ['多一个字段', { ...jobNotice, extra: 1 }, 'extra', '不支持字段'],
      ['停滞种类写错', { ...jobNotice, stallKind: 'slow' }, 'stallKind', '停滞种类必须是'],
      ['holdAtCap 写成文字', { ...jobNotice, holdAtCap: 'yes' }, 'holdAtCap', ''],
      // P76g：id 也认约定的编号（agr_ 开头：还没有事的约定确认条目，「在等你」的提醒记号写在这样的行里），所以原来的反例
      // 「agr_ 开头被拒」改成别的前缀；agr_ 开头改为正例（下面）。
      ['id 不是事的编号', { ...jobNotice, id: 'ptp_aaaaaaaaaa' }, 'id', 'job_'],
    ]);
    expect(() => parseWithPaths(JobNoticeSchema, { ...jobNotice, id: 'agr_aaaaaaaaaa' }, '停滞记号'), '约定的编号').not.toThrow();
    for (const stallKind of ['idle', 'spin', 'overdue']) {
      expect(() => parseWithPaths(JobNoticeSchema, { ...jobNotice, stallKind }, '停滞记号'), stallKind).not.toThrow();
    }
  });
  it('quotaWindows：多一个字段被拒；errors 正文 301 字被拒、300 字合格；errors 21 项被拒、20 项合格；id 只能是 quota', () => {
    check(QuotaPlanSchema, quotaPlan, '额度窗口', [
      ['多一个字段', { ...quotaPlan, extra: 1 }, 'extra', '不支持字段'],
      ['正文 301 字', { ...quotaPlan, errors: [{ ...quotaError, text: '字'.repeat(301) }] }, 'errors[0].text', '不能超过 300 字'],
      ['errors 21 项', { ...quotaPlan, errors: Array.from({ length: 21 }, () => quotaError) }, 'errors', '最多保留 20 项'],
      ['id 写错', { ...quotaPlan, id: 'other' }, 'id', '必须为 quota'],
      ['容量来源写错', { ...quotaPlan, capacitySource: 'guess' }, 'capacitySource', '容量来源必须是'],
      ['exhausted 缺 resetFromText', { ...quotaPlan, exhausted: { at: NOW, resetAt: NOW } }, 'exhausted.resetFromText', ''],
    ]);
    expect(() => parseWithPaths(QuotaPlanSchema, { ...quotaPlan, errors: [{ ...quotaError, text: '字'.repeat(300) }] }, '额度窗口')).not.toThrow();
    expect(() => parseWithPaths(QuotaPlanSchema, { ...quotaPlan, errors: Array.from({ length: 20 }, () => quotaError) }, '额度窗口')).not.toThrow();
    // 取不到恢复时间的报错也要能存。
    expect(() => parseWithPaths(QuotaPlanSchema, { ...quotaPlan, errors: [{ ...quotaError, resetAt: null }] }, '额度窗口')).not.toThrow();
  });
  it('pushQueue：多一个字段被拒；类别写错被拒；五种类别、四种状态都合格', () => {
    check(PushQueueRowSchema, pushRow, '通知队列', [
      ['多一个字段', { ...pushRow, extra: 1 }, 'extra', '不支持字段'],
      ['类别写错', { ...pushRow, category: 'daily' }, 'category', '通知类别必须是'],
      ['状态写错', { ...pushRow, state: 'queued' }, 'state', '通知状态必须是'],
      ['标题为空', { ...pushRow, title: '' }, 'title', '不能为空'],
      ['id 前缀不对', { ...pushRow, id: 'x_aaaaaaaaaa' }, 'id', 'pq_'],
    ]);
    for (const category of ['agreement', 'approval', 'escalation', 'stall', 'system']) {
      expect(() => parseWithPaths(PushQueueRowSchema, { ...pushRow, category }, '通知队列'), category).not.toThrow();
    }
    for (const state of ['waiting', 'sent', 'merged', 'dropped']) {
      expect(() => parseWithPaths(PushQueueRowSchema, { ...pushRow, state }, '通知队列'), state).not.toThrow();
    }
  });
  it('ownerPresence：多一个字段被拒；id 只能是 owner；带离开摘要的合格', () => {
    check(OwnerPresenceSchema, presence, '主人上次打开', [
      ['多一个字段', { ...presence, extra: 1 }, 'extra', '不支持字段'],
      ['id 写错', { ...presence, id: 'me' }, 'id', '必须为 owner'],
      ['摘要缺 notified', { ...presence, away: { from: NOW, to: NOW, lines: [], totalTurns: 0, totalTokens: 0, dismissedAt: null } }, 'away.notified', ''],
    ]);
    const away = { from: NOW, to: NOW + 8 * 3_600_000, lines: ['员工共做了 3 个回合'], totalTurns: 3, totalTokens: 600_000, notified: false, dismissedAt: null };
    expect(() => parseWithPaths(OwnerPresenceSchema, { ...presence, lastSeenAt: NOW, away }, '主人上次打开')).not.toThrow();
  });
});

describe('2 常量', () => {
  it('BUDGET_DEFAULTS 与既有常量同一来源：发布另计回合、执行链总时长、你发起回合的 token 线', () => {
    expect(BUDGET_DEFAULTS.LAUNCH_NOTE_TURNS).toBe(JOB_DEFAULTS.LAUNCH_TURN_CAP);
    expect(BUDGET_DEFAULTS.CHAIN_TURN_HARD_MS).toBe(JOB_DEFAULTS.CHAIN_TURN_HARD_MS);
    expect(BUDGET_DEFAULTS.OWNER_TURN_TOKENS).toBe(DEFAULTS.TURN_LIMITS_BY_VARIANT.owner.tokens);
    expect(BUDGET_DEFAULTS.OWNER_TURN_TOKENS).toBe(300_000);
  });
  it('BUDGET_DEFAULTS、NOTIFY_DEFAULTS 与任务卡逐项一致', () => {
    const HOUR = 3_600_000;
    const MINUTE = 60_000;
    expect(BUDGET_DEFAULTS).toMatchObject({
      INITIAL_WINDOW_TOKENS: 10_000_000, MIN_WINDOW_TOKENS: 2_000_000, QUOTA_ERRORS_MAX: 20, RESET_TEXT_MAX_AHEAD_MS: 5 * HOUR + 10 * MINUTE,
      TOKENS_PER_TURN_FALLBACK: 200_000, TOKENS_PER_TURN_SAMPLE: 20, TOKENS_PER_TURN_SAMPLE_MIN: 5, CHAIN_TURN_HARD_MS: 60 * MINUTE,
      EXEC_DEFAULT: 3, REVIEW_PER_ROUND: 1, REWORK_RESERVE_DEFAULT: 3, CHIEF_RESERVE_DEFAULT: 1,
      HISTORY_MIN: 2, HISTORY_TAKE: 5, TOKEN_SAMPLE_MIN: 3, TOP_UP_MIN: 2, USAGE_TURNS_MAX: 200, LAUNCH_NOTE_TURNS: 4, AVG_TURN_MS: 5 * MINUTE,
      STALL_IDLE_MS: 2 * HOUR, STALL_AFTER_REWAKE_MS: HOUR, SPIN_TURNS: 3, WAIT_OWNER_REMIND_MS: 24 * HOUR, STALL_NOTIFY_GAP_MS: 24 * HOUR,
      AWAY_SUMMARY_MS: 8 * HOUR, OWNER_SEEN_INTERVAL_MS: 5 * MINUTE, OWNER_HOLD_MAX_HOURS: 5, BORROW_REPLY_WINDOW_MS: 24 * HOUR, SELF_WORK_UI_MAX: 10,
    });
    expect(BUDGET_DEFAULTS.TOKENS_PER_TURN_DEFAULT).toEqual({
      exec: [160_000, 390_000], rework: [160_000, 390_000], review: [60_000, 180_000], chief: [60_000, 180_000],
    });
    expect(NOTIFY_DEFAULTS).toEqual({ MERGE_WINDOW_MS: 10 * MINUTE, MERGED_LINES_MAX: 5, QUEUE_RETENTION_MS: 30 * DAY });
  });
  it('新装默认值：员工自己发起的工作每天 2 回合；你发起的回合 token 线 30 万；员工份额比例不变（0.7）', () => {
    const settings = resolveSettings();
    expect(settings.botDailyTurnBudget).toBe(2);
    expect(settings.turnLimitsByVariant.owner.tokens).toBe(300_000);
    expect(settings.botQuotaShare).toBe(0.7);
  });
  it('旧默认值替换表：两项，旧值 6 与 8 万，新值取自常量', () => {
    expect(P76_SETTINGS_REPLACEMENTS).toEqual([
      { path: ['botDailyTurnBudget'], from: 6, to: 2 },
      { path: ['turnLimitsByVariant', 'owner', 'tokens'], from: 80_000, to: 300_000 },
    ]);
  });
  it('被取消的设置字段仍在 Settings 里、值不变（strictObject 删字段会让旧设置读不出）', () => {
    const settings = resolveSettings();
    expect(settings).toMatchObject({
      digestAt: '08:30', dailyPushCap: 3, botDailyPushCap: 2, botDailyTokenBudget: 250_000, botWindowTurnBudget: 3,
      probationBudgetMultiplier: 0.5, dailyThinkCapByAutonomy: { L0: 2, L1: 6, L2: 10, L3: 12 },
    });
  });
});

// ---------------------------------------------------------------------------
// 存储：旧存档、不认识的文件、重启读回
// ---------------------------------------------------------------------------
function newStore(fs: MemoryFs, clock: FakeClock): Store {
  return new FileStore(fs, clock, ROOT, TZ, new MemoryLogger());
}

describe('3 旧存档与持久化', () => {
  it('TABLE_NAMES 含六张新表', () => {
    for (const name of NEW_TABLES) expect(TABLE_NAMES).toContain(name);
  });

  it('旧存档（没有这六张表的数据目录）：六张新表读成空，原有表读取不变，也不因此标脏', async () => {
    const clock = new FakeClock(NOW);
    const fs = new MemoryFs(clock);
    await fs.writeTextAtomic(`${ROOT}/.hub/state/rules.json`, JSON.stringify([
      { id: 'ru_aaaaaaaaaa', text: '先核验证据', scope: 'global', redLine: false, source: 'owner', status: 'active', createdAt: NOW },
    ]));
    const store = newStore(fs, clock);
    await store.load();
    for (const name of NEW_TABLES) expect(store.table(name as TableName).count(), name).toBe(0);
    expect(store.table('rules').get('ru_aaaaaaaaaa')).toMatchObject({ text: '先核验证据' });
    expect(store.isDirty()).toBe(false);
  });

  it('目录里有不认识的文件：加载不报错、不被改动（旧版本读新存档的前提）；不认识的文件名与新表名都不影响已有表', async () => {
    const clock = new FakeClock(NOW);
    const fs = new MemoryFs(clock);
    const strange = `${ROOT}/.hub/state/someFutureTable.json`;
    await fs.writeTextAtomic(strange, '[{"id":"x_1"}]');
    await fs.writeTextAtomic(`${ROOT}/.hub/state/jobs.json`, JSON.stringify([]));
    const store = newStore(fs, clock);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.isDirty()).toBe(false);
    await store.flush();
    expect(await fs.readText(strange)).toBe('[{"id":"x_1"}]');
  });

  it('六张新表写入、落盘、重启后内容一致；40 天后（清理也跑过）仍在', async () => {
    const clock = new FakeClock(NOW);
    const fs = new MemoryFs(clock);
    const first = newStore(fs, clock);
    await first.load();
    for (const name of NEW_TABLES) first.table(name as TableName).put(ROWS[name] as never);
    await first.flush();

    // 40 天后：只把 prune 的 nowMs 参数设为 40 天之后（不推进假时钟），没有任何引擎在跑。
    await first.prune(NOW + 40 * DAY);
    const second = newStore(fs, clock);
    await second.load();
    for (const name of NEW_TABLES) {
      expect(second.table(name as TableName).list(), name).toEqual([ROWS[name]]);
    }
    expect(second.isDirty()).toBe(false);
  });
});
