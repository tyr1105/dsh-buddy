/**
 * P76h 第 2 至 7 条：建条目即推送、免打扰期间到点补发、10 分钟合并、24 小时去重、渠道关闭、宿主通知出错后重试。
 *
 * 前提（每条用例开头写明）：当时是否在免打扰时段（默认 23:00 至 08:00）、推送渠道（pushChannel）。
 * 假时钟：每次推进不超过 10 分钟，推进后调用一次 flushPushQueue，相当于引擎每个 tick 做的那一次整理。
 * 条目都经 createInboxItem 建立（真实入口），再看队列表 pushQueue 和宿主收到的通知。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { createInboxItem, AGREEMENT_CONFIRM_OPTION } from '../src/outreach/inbox.js';
import { flushPushQueue, notifyOwner } from '../src/outreach/notify.js';
import { pushHistory } from '../src/outreach/push.js';
import { budgetOptions, STALL_OPTIONS } from '../src/job/block-options.js';

const MINUTE = 60_000;
const at = (hhmm: string, day = '2026-11-05') => Date.parse(`${day}T${hhmm}:00+08:00`);

/** 建一个测试上下文，起始时间默认 10:00（不在免打扰时段）。 */
function setup(options: { start?: number; pushChannel?: 'dsh' | 'macos' | 'none' } = {}) {
  const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub', ...(options.pushChannel ? { pushChannel: options.pushChannel } : {}) }) });
  ctx.clock.set(options.start ?? at('10:00'));
  return ctx;
}
const notices = (ctx: ReturnType<typeof setup>) => ctx.host.calls.filter(call => call.method === 'notify').map(call => call.args[0] as { title: string; body: string; level: string });
const rows = (ctx: ReturnType<typeof setup>) => ctx.store.table('pushQueue').list();
/** 把假时钟推进 total 毫秒，每步不超过 10 分钟，每步整理一次队列（相当于一个 tick）。 */
async function advance(ctx: ReturnType<typeof setup>, total: number) {
  for (let left = total; left > 0; left -= 10 * MINUTE) {
    ctx.clock.advance(Math.min(10 * MINUTE, left));
    await flushPushQueue(ctx, ctx.clock.now());
  }
}
/** 建条目后等一次整理完成（notifyOwner 在条目建好后异步发出，这里等它结束）。 */
async function settle(ctx: ReturnType<typeof setup>) {
  await flushPushQueue(ctx, ctx.clock.now());
}

/** 各类条目的最小合法建法（选项、默认项、到期时间按 createInboxItem 对各类条目的要求）。 */
const make = {
  agreement(ctx: ReturnType<typeof setup>, key = 'agreement:ag_aaaaaaaaaa:1', title = '约定确认') {
    return createInboxItem(ctx, { botId: null, type: 'question', title, body: '请确认', options: [AGREEMENT_CONFIRM_OPTION], defaultOption: null, expiresAt: null, subjectKey: key });
  },
  cap(ctx: ReturnType<typeof setup>, title = '回合用到上限') {
    return createInboxItem(ctx, { botId: null, type: 'question', title, body: '请决定', options: [...budgetOptions(2)], defaultOption: null, expiresAt: null, subjectKey: 'job:jb_aaaaaaaaaa:cap:12', refId: 'jb_aaaaaaaaaa' });
  },
  approval(ctx: ReturnType<typeof setup>, title = '批准：运行命令') {
    return createInboxItem(ctx, { botId: null, type: 'approval', title, body: '要执行一个动作', options: ['批准', '拒绝'], defaultOption: '拒绝', subjectKey: 'approval:ap_aaaaaaaaaa', refId: 'ap_aaaaaaaaaa' });
  },
  escalate(ctx: ReturnType<typeof setup>, title = '三轮不过') {
    return createInboxItem(ctx, { botId: null, type: 'question', title, body: '核对三轮没有通过', options: ['办法一', '办法二'], defaultOption: null, expiresAt: null, subjectKey: 'job:jb_bbbbbbbbbb:escalate:1', refId: 'jb_bbbbbbbbbb' });
  },
  stall(ctx: ReturnType<typeof setup>, title = '没有进展') {
    return createInboxItem(ctx, { botId: null, type: 'question', title, body: '已等很久', options: [...STALL_OPTIONS], defaultOption: null, expiresAt: null, subjectKey: 'job:jb_cccccccccc:stall:1', refId: 'jb_cccccccccc' });
  },
  question(ctx: ReturnType<typeof setup>) {
    return createInboxItem(ctx, { botId: null, type: 'question', title: '员工提问', body: '选哪个', options: ['甲', '乙'], defaultOption: '甲', subjectKey: 'question:i_aaaaaaaaaa' });
  },
  accept(ctx: ReturnType<typeof setup>) {
    return createInboxItem(ctx, { botId: null, type: 'question', title: '待你验收', body: '请验收', options: ['验收通过'], defaultOption: null, expiresAt: null, subjectKey: 'job:jb_dddddddddd:accept:1', refId: 'jb_dddddddddd' });
  },
};

describe('P76h 建条目即推送（不在免打扰时段 10:00，渠道 macos）', () => {
  it('五类在同一时刻建好 → 合成一条「有 5 件事等你处理」；每类都进了队列，条目 pushed 都为 true', async () => {
    const ctx = setup();
    const items = [make.agreement(ctx), make.cap(ctx), make.approval(ctx), make.escalate(ctx), make.stall(ctx)];
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]).toMatchObject({ title: '有 5 件事等你处理', body: '约定确认\n回合用到上限\n批准：运行命令\n三轮不过\n没有进展' });
    expect(rows(ctx).map(row => row.category).sort()).toEqual(['agreement', 'agreement', 'approval', 'escalation', 'stall']);
    for (const item of items) expect(ctx.store.table('inbox').get(item.id)?.pushed, item.subjectKey).toBe(true);
  });

  it('每类各自单独建（相隔 10 分钟）→ 各推一次，共 5 次', async () => {
    const ctx = setup();
    const builders = [make.agreement, make.cap, make.approval, make.escalate, make.stall];
    for (const [index, build] of builders.entries()) {
      if (index > 0) await advance(ctx, 10 * MINUTE);
      build(ctx);
      await settle(ctx);
      expect(notices(ctx), `第 ${index + 1} 类`).toHaveLength(index + 1);
    }
    expect(pushHistory(ctx).filter(row => row.result === 'sent')).toHaveLength(5);
    expect(rows(ctx).every(row => row.state === 'sent')).toBe(true);
  });

  it('员工提问、验收各建一条 → 不推，队列里没有行，条目 pushed 为 false', async () => {
    const ctx = setup();
    const question = make.question(ctx);
    const accept = make.accept(ctx);
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(0);
    expect(rows(ctx)).toHaveLength(0);
    expect(ctx.store.table('inbox').get(question.id)?.pushed).toBe(false);
    expect(ctx.store.table('inbox').get(accept.id)?.pushed).toBe(false);
  });

  it('审批只推一次：push 审计恰好一条、宿主通知恰好一次', async () => {
    const ctx = setup();
    make.approval(ctx);
    await settle(ctx);
    await settle(ctx);
    expect(pushHistory(ctx).filter(row => row.result === 'sent')).toHaveLength(1);
    expect(pushHistory(ctx)).toHaveLength(1);
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]).toMatchObject({ title: '批准：运行命令', level: 'P1' });
  });
});

describe('P76h 免打扰期间到点补发（渠道 macos）', () => {
  it('23:30（在免打扰时段内）建一条约定确认 → 不推；每 10 分钟推进到 08:00 之前都不推；08:00 推一次', async () => {
    const ctx = setup({ start: at('23:30') });
    make.agreement(ctx);
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(0);
    expect(rows(ctx)[0]).toMatchObject({ state: 'waiting', sendAfter: at('08:00', '2026-11-06') });
    // 23:30 → 07:50：每步 10 分钟，全程不推。
    await advance(ctx, at('07:50', '2026-11-06') - ctx.clock.now());
    expect(notices(ctx)).toHaveLength(0);
    // 07:50 → 08:00：补发一次。
    await advance(ctx, 10 * MINUTE);
    expect(ctx.clock.now()).toBe(at('08:00', '2026-11-06'));
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]).toMatchObject({ title: '约定确认', level: 'P1' });
    expect(rows(ctx)[0]).toMatchObject({ state: 'sent', sentAt: at('08:00', '2026-11-06') });
  });

  it('反例：不在免打扰时段（10:00）建的约定确认立即推出，不顺延', async () => {
    const ctx = setup();
    make.agreement(ctx);
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ state: 'sent', sendAfter: at('10:00') });
  });

  it('免打扰时段内产生的几条通知，到点后合成一条补发', async () => {
    const ctx = setup({ start: at('23:30') });
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '约定一');
    make.approval(ctx, '审批一');
    await settle(ctx);
    await advance(ctx, at('08:00', '2026-11-06') - ctx.clock.now());
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]).toMatchObject({ title: '有 2 件事等你处理', body: '约定一\n审批一' });
  });

  it('鉴权告警（系统类，P0）在免打扰时段内也立即推出', async () => {
    const ctx = setup({ start: at('23:30') });
    createInboxItem(ctx, { botId: null, type: 'alert', title: '中心告警：鉴权', body: '宿主鉴权失败', priority: 'P0', refId: 'al_aaaaaaaaaa', subjectKey: 'alert:hub:auth:al_aaaaaaaaaa:first' }, { alertCode: 'auth' });
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]).toMatchObject({ level: 'P0' });
  });
});

describe('P76h 10 分钟合并（不在免打扰时段，渠道 macos）', () => {
  it('10:00 推出一条；10:03、10:05 各建一条 → 10:05 不推；10:10 推出一条合并通知（标题与两行正文逐字）', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '约定一');
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(1);
    await advance(ctx, 3 * MINUTE);
    make.approval(ctx, '审批二');
    await settle(ctx);
    await advance(ctx, 2 * MINUTE);
    make.cap(ctx, '回合上限三');
    await settle(ctx);
    expect(ctx.clock.now()).toBe(at('10:05'));
    expect(notices(ctx)).toHaveLength(1);
    await advance(ctx, 5 * MINUTE);
    expect(ctx.clock.now()).toBe(at('10:10'));
    expect(notices(ctx)).toHaveLength(2);
    expect(notices(ctx)[1]).toEqual({ title: '有 2 件事等你处理', body: '审批二\n回合上限三', level: 'P1', botId: null });
    const states = rows(ctx).map(row => row.state);
    expect(states).toEqual(['sent', 'sent', 'merged']);
    expect(rows(ctx)[2]!.mergedInto).toBe(rows(ctx)[1]!.id);
  });

  it('反例：距上一次发出满 10 分钟再建一条，单独发出，不合并、标题是原标题', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '约定一');
    await settle(ctx);
    await advance(ctx, 10 * MINUTE);
    make.approval(ctx, '审批二');
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(2);
    expect(notices(ctx)[1]).toMatchObject({ title: '审批二' });
  });

  it('合并超过 5 件：正文前 5 行是原标题，末行「另有 k 件」', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '首条');
    await settle(ctx);
    // 窗口内再建 7 条（各自事项键不同）。
    await advance(ctx, 1 * MINUTE);
    for (let n = 1; n <= 7; n += 1) make.agreement(ctx, `agreement:ag_bbbbbbbb${String(n).padStart(2, '0')}:1`, `待办${n}`);
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(1);
    await advance(ctx, 9 * MINUTE);
    expect(notices(ctx)).toHaveLength(2);
    expect(notices(ctx)[1]).toMatchObject({ title: '有 7 件事等你处理', body: '待办1\n待办2\n待办3\n待办4\n待办5\n另有 2 件' });
  });

  it('恰好 5 件：5 行原标题，没有「另有」行', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '首条');
    await settle(ctx);
    await advance(ctx, 1 * MINUTE);
    for (let n = 1; n <= 5; n += 1) make.agreement(ctx, `agreement:ag_bbbbbbbb${String(n).padStart(2, '0')}:1`, `待办${n}`);
    await advance(ctx, 9 * MINUTE);
    expect(notices(ctx)[1]).toMatchObject({ title: '有 5 件事等你处理', body: '待办1\n待办2\n待办3\n待办4\n待办5' });
  });

  it('系统类（鉴权告警）不受合并窗口限制：刚推过一条，3 分钟后的鉴权告警照常立即推出', async () => {
    const ctx = setup();
    make.agreement(ctx);
    await settle(ctx);
    await advance(ctx, 3 * MINUTE);
    createInboxItem(ctx, { botId: null, type: 'alert', title: '中心告警：鉴权', body: '宿主鉴权失败', priority: 'P0', refId: 'al_aaaaaaaaaa', subjectKey: 'alert:hub:auth:al_aaaaaaaaaa:first' }, { alertCode: 'auth' });
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(2);
    expect(notices(ctx)[1]).toMatchObject({ level: 'P0' });
  });
});

describe('P76h 同一事项 24 小时只推一次（不在免打扰时段，渠道 macos）', () => {
  it('同一事项键 24 小时内第二次 → 第二行 dropped，只推一次', async () => {
    const ctx = setup();
    make.agreement(ctx);
    await settle(ctx);
    await advance(ctx, 10 * MINUTE);
    make.agreement(ctx);
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(1);
    expect(rows(ctx).map(row => row.state)).toEqual(['sent', 'dropped']);
  });

  it('反例：满 24 小时之后同一事项键可以再推一次', async () => {
    const ctx = setup();
    make.agreement(ctx);
    await settle(ctx);
    // 推进 24 小时零 10 分钟（跨过夜间），每步 10 分钟；到次日 10:10。
    await advance(ctx, 24 * 60 * MINUTE + 10 * MINUTE);
    expect(ctx.clock.now()).toBe(at('10:10', '2026-11-06'));
    make.agreement(ctx);
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(2);
  });

  it('被合并发出的事项同样算「已推过」：之后同一事项键 24 小时内不再推', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '首条');
    await settle(ctx);
    await advance(ctx, 1 * MINUTE);
    make.approval(ctx, '审批二');
    make.cap(ctx, '回合上限三');
    await advance(ctx, 9 * MINUTE);
    expect(notices(ctx)).toHaveLength(2);
    await advance(ctx, 10 * MINUTE);
    make.cap(ctx, '回合上限三');
    await settle(ctx);
    expect(notices(ctx)).toHaveLength(2);
    expect(rows(ctx).at(-1)!.state).toBe('dropped');
  });
});

describe('P76h 渠道关闭', () => {
  it('pushChannel 为 none（10:00，不在免打扰时段）→ 全部 dropped，宿主通知一次都没有调用', async () => {
    const ctx = setup({ pushChannel: 'none' });
    make.agreement(ctx);
    make.approval(ctx);
    await settle(ctx);
    await advance(ctx, 10 * MINUTE);
    expect(notices(ctx)).toHaveLength(0);
    expect(rows(ctx).map(row => row.state)).toEqual(['dropped', 'dropped']);
  });

  it('pushChannel 为 none、23:30（在免打扰时段内）→ 同样丢弃，不会攒到早上补发', async () => {
    const ctx = setup({ pushChannel: 'none', start: at('23:30') });
    make.agreement(ctx);
    await settle(ctx);
    await advance(ctx, at('08:10', '2026-11-06') - ctx.clock.now());
    expect(notices(ctx)).toHaveLength(0);
    expect(rows(ctx)[0]!.state).toBe('dropped');
  });
});

describe('P76h 宿主通知出错后重试（10:00，渠道 macos）', () => {
  it('宿主通知抛错 → 行保持 waiting，条目已建成；下个 tick 重试成功', async () => {
    const ctx = setup();
    const notify = ctx.host.notify.bind(ctx.host);
    ctx.host.notify = async () => { throw new Error('通知服务不可用'); };
    const item = make.agreement(ctx);
    await settle(ctx);
    expect(ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'open', pushed: false });
    expect(rows(ctx)[0]).toMatchObject({ state: 'waiting', sentAt: null });
    expect(pushHistory(ctx)).toHaveLength(0);
    ctx.host.notify = notify;
    await advance(ctx, 1 * MINUTE);
    expect(rows(ctx)[0]).toMatchObject({ state: 'sent' });
    expect(notices(ctx)).toHaveLength(1);
    expect(ctx.store.table('inbox').get(item.id)?.pushed).toBe(true);
  });
});

describe('P76h 发出之前核对条目还开着（渠道 macos）', () => {
  it('23:30（免打扰）建一条审批，夜里这条审批过期 → 08:00 到点不发，这一行 dropped', async () => {
    const ctx = setup({ start: at('23:30') });
    const item = make.approval(ctx);
    await settle(ctx);
    await advance(ctx, 3 * 60 * MINUTE);
    ctx.store.table('inbox').patch(item.id, { status: 'expired', answer: '拒绝', answeredAt: ctx.clock.now() });
    await advance(ctx, at('08:10', '2026-11-06') - ctx.clock.now());
    expect(notices(ctx)).toHaveLength(0);
    expect(rows(ctx)[0]!.state).toBe('dropped');
  });

  it('10 分钟窗口里先后建两条，其中一条发出前被主人处理 → 到点只发剩下的一条，按单条标题正文发', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '首条');
    await settle(ctx);
    await advance(ctx, 1 * MINUTE);
    const handled = make.approval(ctx, '审批二');
    make.cap(ctx, '回合上限三');
    await settle(ctx);
    ctx.store.table('inbox').patch(handled.id, { status: 'answered', answer: '批准', answeredAt: ctx.clock.now() });
    await advance(ctx, 9 * MINUTE);
    expect(notices(ctx)).toHaveLength(2);
    expect(notices(ctx)[1]).toMatchObject({ title: '回合上限三', body: '请决定' });
    expect(rows(ctx).map(row => row.state)).toEqual(['sent', 'dropped', 'sent']);
  });

  it('一行不剩就不发：窗口里建的唯一一条被处理', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '首条');
    await settle(ctx);
    await advance(ctx, 1 * MINUTE);
    const item = make.approval(ctx, '审批二');
    await settle(ctx);
    ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: '拒绝', answeredAt: ctx.clock.now() });
    await advance(ctx, 9 * MINUTE);
    expect(notices(ctx)).toHaveLength(1);
  });

  it('条目建好后被撤销（从 inbox 表删掉）→ 不发，这一行 dropped', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '首条');
    await settle(ctx);
    await advance(ctx, 1 * MINUTE);
    const item = make.approval(ctx, '审批二');
    await settle(ctx);
    ctx.store.table('inbox').remove(item.id);
    await advance(ctx, 9 * MINUTE);
    expect(notices(ctx)).toHaveLength(1);
    expect(rows(ctx)[1]!.state).toBe('dropped');
  });

  it('反例：条目仍然开着的照发', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '首条');
    await settle(ctx);
    await advance(ctx, 1 * MINUTE);
    make.approval(ctx, '审批二');
    await advance(ctx, 9 * MINUTE);
    expect(notices(ctx)).toHaveLength(2);
    expect(notices(ctx)[1]).toMatchObject({ title: '审批二' });
  });

  it('反例：没有对应条目、直接调用 notifyOwner 的行照发', async () => {
    const ctx = setup();
    await notifyOwner(ctx, { category: 'agreement', title: '直接通知', body: '正文', subjectKey: 'duerisk:x:y', botId: null });
    expect(notices(ctx)).toHaveLength(1);
    expect(notices(ctx)[0]).toMatchObject({ title: '直接通知' });
    expect(rows(ctx)[0]!.inboxId).toBeUndefined();
  });
});

describe('P76h 队列清理', () => {
  it('已发出的行超过保留期（30 天）被清理；没超过的保留', async () => {
    const ctx = setup();
    make.agreement(ctx, 'agreement:ag_aaaaaaaaaa:1', '旧的');
    await settle(ctx);
    await advance(ctx, 10 * MINUTE);
    make.approval(ctx, '新的');
    await settle(ctx);
    expect(rows(ctx)).toHaveLength(2);
    // 不推进时钟：把第一行的产生时间改到 31 天前，清理只看这个时间与当前时间之差。
    const old = rows(ctx)[0]!;
    ctx.store.table('pushQueue').patch(old.id, { createdAt: ctx.clock.now() - 31 * 24 * 60 * MINUTE });
    await flushPushQueue(ctx, ctx.clock.now());
    expect(rows(ctx).map(row => row.title)).toEqual(['新的']);
  });
});
