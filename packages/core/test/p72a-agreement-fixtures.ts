/**
 * P72a 约定测试的公共样例：一份合法的内容、一份合法的提交参数、一张「主人的话叫醒的」唤醒单。
 * 为什么集中放这里：模型测试和服务测试都要造合法样例，再按字段破坏它去验证边界。
 */
import type { HubContext } from '../src/engine/context.js';
import type { Agreement, AgreementContent, AgreementVersion } from '../src/model/agreement.js';
import type { WakeTicket } from '../src/model/index.js';
import { postThread } from '../src/outreach/thread.js';

/** 一份合法内容：页面草图一屏，两个待定项，三条「怎样算做完」。每次返回新对象，测试可放心改。 */
export function contentFixture(): AgreementContent {
  return {
    summary: '做一个能查看每日报价的小页面',
    sketch: { layout: 'page', screens: [{ title: '报价页', blocks: [
      { kind: 'title', text: '每日报价' }, { kind: 'list', text: '报价列表', mark: 1 }, { kind: 'button', text: '刷新', mark: 2 },
    ] }] },
    pending: [
      { key: 'source', question: '报价从哪里取', options: ['公开接口', '手工表格'], suggested: '公开接口', reason: '更新快，不用人维护', chosen: null },
      { key: 'refresh', question: '多久刷新一次', options: ['每小时', '每天'], suggested: '每天', reason: '你说看日报即可', chosen: null },
    ],
    decided: [{ text: '只做网页，不做手机端', basis: { kind: 'judgement', ref: null, refText: null } }],
    scopeIn: ['报价列表页', '手动刷新'], scopeOut: ['历史曲线'],
    doneWhen: ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示'],
  };
}

/** 合法的提交参数（新建用，七项内容齐全）。 */
export function submitFixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const c = contentFixture();
  return {
    title: '每日报价页', summary: c.summary, sketch: c.sketch,
    pending: c.pending.map(({ key, question, options, suggested, reason }) => ({ key, question, options, suggested, reason })),
    decided: [{ text: c.decided[0]!.text, basis: { kind: 'judgement' } }],
    scopeIn: c.scopeIn, scopeOut: c.scopeOut, doneWhen: c.doneWhen, ...extra,
  };
}

/** 一个版本的完整样例，按需覆盖字段。 */
export function versionFixture(no: number, patch: Partial<AgreementVersion> = {}): AgreementVersion {
  return {
    no, state: 'pending', source: 'draft', sourceMessageId: `m_${String(no).padStart(10, '0')}`, sourceThread: 'b_0000000001',
    wakeId: 'w_0000000001', content: contentFixture(), changes: [], changeNote: '', cardMessageId: null, createdAt: 1000 + no,
    lockedAt: null, lockedVia: null, confirmMessageId: null, choices: null, adoption: null, ...patch,
  };
}

/** 一份合法约定（默认一个待确认版本）。 */
export function agreementFixture(patch: Partial<Agreement> = {}): Agreement {
  return {
    id: 'agr_0000000001', botId: 'b_0000000001', projectId: 'prj_0000000001', topicId: 'ptp_0000000001',
    originThread: 'b_0000000001', title: '每日报价页', state: 'pending', versions: [versionFixture(1)],
    inboxId: null, withdrawn: null, createdAt: 1000, updatedAt: 1000, ...patch,
  };
}

/**
 * 模拟「主人在总管私聊里说了一句话，并叫醒总管」：落一条主人线程消息，返回一张证据指向它的唤醒单。
 * 唤醒单不写进存储（服务层只读它的 id、理由和 ownerDirect）。
 */
export function ownerWake(ctx: HubContext, botId: string, text = '就按这个做'): WakeTicket {
  const message = postThread(ctx, { thread: botId, from: 'owner', kind: 'chat', text });
  return wakeTicket(ctx, botId, { kind: 'owner_message', evidence: [message.id] });
}

let wakeCounter = 0;

/** 一张最小的唤醒单。 */
export function wakeTicket(ctx: HubContext, botId: string, reason: { kind: WakeTicket['reason']['kind']; evidence: string[] }, patch: Partial<WakeTicket> = {}): WakeTicket {
  const now = ctx.clock.now();
  // 用计数器造 id，不碰注入的随机数：服务测试要断言「失败时随机数调用次数不变」。
  wakeCounter += 1;
  const n = String(wakeCounter).padStart(10, '0');
  return {
    id: `w_${n}`, botId, sessionId: 'session-1', variant: 'regular',
    reason: { kind: reason.kind, score: 0.9, threshold: 0.5, summary: '主人发来消息', evidence: reason.evidence },
    ownerInitiated: true, packetBytes: 0, status: 'running', startedAt: now, lastEventAt: now, endedAt: null,
    steps: 0, tokens: 0, steeredAt: null, commitId: null, error: null, ...patch,
  } as WakeTicket;
}
