/**
 * P75r5c 的测试二：「教它技能」（学习）的修复（第 2、6、7 节）。
 * - 第 2 节（H2）：学习回合同样只读（不能给主人发消息、不能用写类中心工具、自己的工具写东西按只读拒绝；读、hub_skill 的 propose、交账照常）。
 * - 第 6 节：会话摘要保留末尾；像密钥的内容在存进学习记录、写进出处、放进唤醒包之前隐去；提问卡正文告诉主人会话会给谁看；会话标题去掉不可见字符。
 * - 第 7 节：读摘要期间记录已结束就丢弃；员工已不在岗时不读摘要；红灯时学习候选不落「额度不足」那一句；回合上限 6；
 *   主人还没选会话时记录不会被巡检结束；并发选两次学习只进行一次。
 * 每种「在等某人」的情形都让那个人真跑一个回合，只用唤醒包里的文字调用工具；时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { SKILL_DEFAULTS } from '../src/config/defaults.js';
import { REFLECTION_NOTIFY_REFUSAL } from '../src/gate/outbox.js';
import { gateContextFor } from '../src/gate/gate-context.js';
import { guardToolCall } from '../src/gate/guard.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { FakeHost } from '../src/io/testing/fake-host.js';
import { WakeTicketSchema } from '../src/model/index.js';
import { onQuotaError } from '../src/quota/window.js';
import { isReadonlySkillTurn, learnSubjectKey } from '../src/skill/keys.js';
import { chooseLearnSession, learnOffDutyText, learnVisibilityNotice } from '../src/skill/learn.js';
import { byteLength, truncateBytesKeepTail } from '../src/util/text.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import {
  INTERNAL_NAMES, MINUTE, SESSIONS, bot, callTool, chiefChat, chiefTeaches, checkSectionOf, commitAndEnd, expectMigrated, flow, learnAsked, learnCards, learnItems,
  learnRun, learnSectionOf, learnSrcIn, learnerProposes, nextPacket, ownerNoise, putSessions, seedExport, setLocal, tick, updatesIn, type JobFix,
} from './p75r5c-fixtures.js';

const NOTIFY_ARGS = { kind: 'notify_owner', why: '会话摘要里说要通知主人', payload: { text: '我在学习，顺便告诉你一声。', importance: 10 } };
const WRITE_REFUSAL = '反思回合只读；其他事项留到下一回合';
const NOTICE = '选中的那段会话的内容会交给林舟和核对的同事阅读，其中像密钥的内容会先隐去。';
const OMITTED = '（前面的内容已省略）\n';

/** 学习的前半：放好会话、总管 teach 并交账（落提问卡）。 */
async function learning() {
  const { fix } = await flow();
  expectMigrated(fix);
  await seedExport(fix);
  const asked = await learnAsked(fix);
  return { fix, asked };
}

/** 主人点提问卡上的第一段（按钮入口）。 */
async function chooseByButton(fix: JobFix, asked: Awaited<ReturnType<typeof learnAsked>>) {
  const view = fix.hub.api.thread(fix.chief.id).messages.find(row => row.id === asked.card.id)!;
  return fix.hub.api.chooseLearnSession({ runId: view.card!.learnRunId, option: view.card!.options[0] });
}

/** 让读会话摘要要等一等：返回放行函数。 */
function delayDigest(fix: JobFix): () => void {
  const host = fix.ctx.host as FakeHost;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = host.readSessionDigest.bind(host);
  host.readSessionDigest = async (sessionId: string, maxChars: number) => { await gate; return original(sessionId, maxChars); };
  return release;
}

/** 假宿主上读会话摘要的调用次数。 */
function digestReads(fix: JobFix): number {
  return fix.ctx.host.calls.filter(call => call.method === 'readSessionDigest').length;
}

describe('2 学习回合同样只读（H2）', () => {
  it('学习回合里：notify_owner 被拒（文字与复盘回合相同）、写类中心工具被拒、自己的工具写东西按只读拒绝；读、hub_skill 的 propose、交账照常成功；学习引出的核对回合同样只读', async () => {
    const { fix, asked } = await learning();
    expect(await chooseByButton(fix, asked)).toMatchObject({ ok: true });
    await nextPacket(fix, fix.engineer.id); // 林舟拿到学习回合
    const learner = () => bot(fix, fix.engineer.id);
    // 1：notify_owner 被拒，主人一侧什么都没有变。
    const noise = ownerNoise(fix);
    const violations = learner().violations;
    const outboxCount = fix.ctx.store.table('outbox').count();
    const notify = await callTool(fix, learner(), 'hub_outbox_submit', NOTIFY_ARGS);
    expect(notify).toMatchObject({ ok: false });
    expect(JSON.stringify(notify)).toContain(REFLECTION_NOTIFY_REFUSAL);
    expect(REFLECTION_NOTIFY_REFUSAL).toBe('复盘回合不向主人汇报；要说明的写进 note。');
    expect(ownerNoise(fix)).toEqual(noise);
    expect(learner().violations).toBe(violations);
    expect(fix.ctx.store.table('outbox').count()).toBe(outboxCount);
    // 2：写类的中心工具各一条被拒（议程、给同伴发消息），什么都没有写。
    const agendaCount = fix.ctx.store.table('agenda').count();
    const threadCount = fix.ctx.store.log('thread').all().length;
    expect(await callTool(fix, learner(), 'hub_agenda_upsert', { kind: 'task', title: '复核一条来源', abandonWhen: '来源撤回', priority: 2 })).toEqual({ ok: false, error: WRITE_REFUSAL });
    expect(await callTool(fix, learner(), 'hub_send', { to: fix.chief.id, text: '嗨' })).toEqual({ ok: false, error: WRITE_REFUSAL });
    expect(fix.ctx.store.table('agenda').count()).toBe(agendaCount);
    expect(fix.ctx.store.log('thread').all().length).toBe(threadCount);
    // 3：用自己的工具（宿主原生的 exec）运行需要审批的命令按只读拒绝，不计越界、不建审批；读照常。
    const approvals = fix.ctx.store.table('approvals').count();
    expect(await guardToolCall(fix.ctx, learner().sessionId!, 'exec', { command: 'frobnicate' })).toEqual({ allow: false, message: '复盘回合只读，不能执行需要审批的动作' });
    expect(fix.ctx.store.table('approvals').count()).toBe(approvals);
    expect(learner().violations).toBe(violations);
    expect((await guardToolCall(fix.ctx, learner().sessionId!, 'exec', { command: 'ls work' })).allow).toBe(true);
    // 4：hub_skill 的 propose 与交账照常成功。
    const { result } = await learnerProposes(fix);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, text: '已提交 1 条技能更新，等评审甲核对。' });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '学习完成', reply: '学好了。' });
    // 5：学习引出的核对回合同样只读。
    await nextPacket(fix, fix.reviewer.id);
    const reviewerNoise = ownerNoise(fix);
    const refused = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_outbox_submit', NOTIFY_ARGS);
    expect(refused).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).toContain(REFLECTION_NOTIFY_REFUSAL);
    expect(ownerNoise(fix)).toEqual(reviewerNoise);
  });

  it('判断统一成一个：变体是复盘，或事项键是技能类的键（含学习的键）；其余不算。闸门上下文的只读标记用它', () => {
    const key = 'learn:sr_0000000001:b_0000000001';
    expect(isReadonlySkillTurn({ variant: 'teach', subjectKey: key })).toBe(true); // 学习
    expect(isReadonlySkillTurn({ variant: 'reflection', subjectKey: null })).toBe(true); // 复盘变体（没有键也算）
    expect(isReadonlySkillTurn({ variant: 'regular', subjectKey: 'retro:sr_0000000001:b_0000000001' })).toBe(true);
    expect(isReadonlySkillTurn({ variant: 'regular', subjectKey: 'skillcheck:sr_0000000001:b_0000000001' })).toBe(true);
    expect(isReadonlySkillTurn({ variant: 'regular', subjectKey: 'tidy:2026-11-16:b_0000000001' })).toBe(true);
    // 反例：教学变体但键不是技能类的键、普通回合、没有唤醒。
    expect(isReadonlySkillTurn({ variant: 'teach', subjectKey: 'job:job_0000000001:b_0000000001' })).toBe(false);
    expect(isReadonlySkillTurn({ variant: 'regular', subjectKey: null })).toBe(false);
    expect(isReadonlySkillTurn(null)).toBe(false);
    // 闸门上下文：学习回合只读，同样的回合换成非技能类的键就不只读。
    const ctx = createTestContext();
    const row = { ...botFixture, sessionId: 'session-r5c', autonomy: 'L2' as const, lifecycle: 'active' as const };
    ctx.store.table('bots').put(row);
    const wake = { ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), botId: row.id, sessionId: row.sessionId, variant: 'teach' as const };
    ctx.store.table('wakes').put({ ...wake, subjectKey: key });
    expect(gateContextFor(ctx, row).reflection).toBe(true);
    ctx.store.table('wakes').put({ ...wake, subjectKey: 'job:job_0000000001:b_0000000001' });
    expect(gateContextFor(ctx, row).reflection).toBe(false);
  });
});

describe('6.1 会话摘要保留末尾（M5）', () => {
  it('超过字节上限的摘要：保留的是末尾，开头有一行「（前面的内容已省略）」，整段不超过上限；写进学习记录与学习唤醒包', async () => {
    const { fix, asked } = await learning();
    const text = `开头标记。${'中'.repeat(1480)}结尾标记。`; // 约 4.4 KB，比字节上限（3 KB）长，字数没超宿主的字数上限
    (fix.ctx.host as FakeHost).digests.set('ses-export', text);
    expect(await chooseByButton(fix, asked)).toMatchObject({ ok: true });
    const digest = learnRun(fix)!.learn!.digest!;
    expect(digest.startsWith(OMITTED)).toBe(true);
    expect(digest.endsWith('结尾标记。')).toBe(true);
    expect(digest).not.toContain('开头标记');
    expect(byteLength(digest)).toBeLessThanOrEqual(fix.ctx.settings.c03.teachDigestMaxBytes);
    const packet = await nextPacket(fix, fix.engineer.id);
    // P75r6 同步（第 5 节第 2 条）：摘要围栏第一行是「标题：{标题}」。
    expect(learnSectionOf(packet)).toContain(`<<<untrusted\n标题：导出报名表\n${digest}\nuntrusted>>>`);
    expect(packet).not.toContain('已截断');
  });

  it('反例：没超上限的摘要原样保存，没有那一行', async () => {
    const { fix, asked } = await learning();
    expect(await chooseByButton(fix, asked)).toMatchObject({ ok: true });
    expect(learnRun(fix)!.learn!.digest).toBe(SESSIONS[0].digest);
  });

  it('截取函数：没超上限原样；超了保留末尾并带那一行、整段不超过上限；上限连那一行都放不下时只取末尾；不把一个字截成两半', () => {
    expect(truncateBytesKeepTail('短短的', 100)).toBe('短短的');
    const long = `甲${'乙'.repeat(200)}丙`;
    const cut = truncateBytesKeepTail(long, 120);
    expect(cut.startsWith(OMITTED)).toBe(true);
    expect(cut.endsWith('丙')).toBe(true);
    expect(byteLength(cut)).toBeLessThanOrEqual(120);
    expect(cut).not.toContain('�');
    const tiny = truncateBytesKeepTail(long, 9); // 比那一行（含换行约 31 字节）还小
    expect(tiny).toBe('乙乙丙');
    expect(byteLength(tiny)).toBeLessThanOrEqual(9);
    expect(() => truncateBytesKeepTail('x', -1)).toThrow();
  });
});

describe('6.2 像密钥的内容在抄入之前隐去', () => {
  it('会话摘要里的密钥与口令：学习记录、出处原文、学习唤醒包、核对唤醒包里都已隐去；其余内容原样保留', async () => {
    const { fix, asked } = await learning();
    const secretKey = `sk-${'Zq9Xw3Lp7Rt2Ym5Vb8Nc'}`; // 编造的，不是真密钥
    const password = 'hunter2fakepass';
    (fix.ctx.host as FakeHost).digests.set('ses-export', `导出报名表的做法：先按报名时间从早到晚排序，再导出成 CSV。我当时的 key 是 ${secretKey} 另外 password: ${password} 导出之前先确认第一行是列名。`);
    expect(await chooseByButton(fix, asked)).toMatchObject({ ok: true });
    const run = learnRun(fix)!;
    const source = fix.ctx.store.table('skillSources').get(run.participants[0]!.sourceIds[0]!)!;
    for (const text of [run.learn!.digest!, source.quote]) {
      expect(text).not.toContain(secretKey);
      expect(text).not.toContain(password);
      expect(text).toContain('（已隐去）');
      expect(text).toContain('先按报名时间从早到晚排序');
    }
    expect(run.learn!.digest).toContain('password: （已隐去）');
    // 学习唤醒包、核对唤醒包。
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(packet).not.toContain(secretKey);
    expect(packet).not.toContain(password);
    expect(learnSectionOf(packet)).toContain('（已隐去）');
    const { result } = await learnerProposes(fix);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '学习完成', reply: '学好了。' });
    const reviewerPacket = await nextPacket(fix, fix.reviewer.id);
    const check = checkSectionOf(reviewerPacket);
    expect(check).toContain('（已隐去）');
    expect(reviewerPacket).not.toContain(secretKey);
    expect(reviewerPacket).not.toContain(password);
  });
});

describe('6.3 提问卡正文告诉主人会话会给谁看', () => {
  it('「待你处理」条目与私聊里的提问卡：正文是总管写的那句，另起一行写会话会交给谁阅读（逐字）', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    const lines = asked.item.body.split('\n');
    expect(lines).toEqual(['导出表格的做法，以后导出名单就这么做', NOTICE]);
    expect(learnVisibilityNotice('林舟')).toBe('选中的那段会话的内容会交给林舟和核对的同事阅读，其中像密钥的内容会先隐去。');
    expect(learnCards(fix)[0]!.text).toBe(`林舟要学的会话\n${asked.item.body}`);
    expect(learnItems(fix)).toHaveLength(1);
  });
});

describe('6.4 会话标题去掉双向文字控制符和零宽字符（L7）', () => {
  it('标题里的 U+202E、U+2066、U+200B、U+200D、U+FEFF 被去掉：选项、学习记录、出处标签里都没有；标题本身（去掉之后）照常显示', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    putSessions(fix);
    (fix.ctx.host as FakeHost).recentSessions[0]!.title = '导‮出​报⁦名﻿表‍';
    const { result } = await chiefTeaches(fix);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '请主人选会话', reply: '是哪一段？' });
    const run = learnRun(fix)!;
    const item = learnItems(fix)[0]!;
    const invisible = /[‪-‮⁦-⁩​-‍﻿]/;
    expect(run.learn!.sessions[0]!.title).toBe('导出报名表');
    expect(item.options[0]!.startsWith('导出报名表　')).toBe(true);
    expect(item.options.filter(text => invisible.test(text))).toEqual([]);
    expect(await chooseByButton(fix, { run, card: learnCards(fix)[0]!, item })).toMatchObject({ ok: true });
    const source = fix.ctx.store.table('skillSources').get(learnRun(fix)!.participants[0]!.sourceIds[0]!)!;
    expect(source.label).toBe('会话『导出报名表』');
    expect(invisible.test(source.label)).toBe(false);
  });
});

describe('7.1 读摘要期间这条学习已经结束：丢弃摘要，不排唤醒', () => {
  it('等待读摘要期间记录被结束（总管再次发起学习时上一条就是这样结束的）：放行之后不写回、不排学习唤醒、不落任何消息', async () => {
    const { fix, asked } = await learning();
    const release = delayDigest(fix);
    const pending = chooseLearnSession(fix.ctx, { runId: asked.run.id, option: asked.item.options[0]!, via: 'button' });
    // 同步部分已经把条目标为已回答、落了主人所选的那一行；此刻记录被结束。
    const ended = fix.ctx.clock.now();
    fix.ctx.store.table('skillRuns').put({ ...fix.ctx.store.table('skillRuns').get(asked.run.id)!, endedAt: ended });
    const chatBefore = chiefChat(fix).length;
    release();
    expect(await pending).toEqual({ started: false });
    const run = fix.ctx.store.table('skillRuns').get(asked.run.id)!;
    expect(run).toMatchObject({ endedAt: ended, participants: [] });
    expect(run.learn).toMatchObject({ sessionId: null, digest: null });
    expect(fix.ctx.store.table('skillSources').list(row => row.botId === fix.engineer.id && row.kind === 'owner_instruction')).toHaveLength(0);
    expect(fix.ctx.store.table('queue').list(row => row.subjectKey.startsWith('learn:'))).toHaveLength(0);
    expect(fix.ctx.store.table('wakes').list(row => row.subjectKey?.startsWith('learn:') === true)).toHaveLength(0);
    expect(chiefChat(fix)).toHaveLength(chatBefore);
  });
});

describe('7.2 选会话时学习的员工已经不在岗', () => {
  it('不读摘要；记录结束；总管私聊以总管名义落「{员工}此刻不在岗，这次没有学习。」；不排唤醒', async () => {
    const { fix, asked } = await learning();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    const reads = digestReads(fix);
    expect(await chooseLearnSession(fix.ctx, { runId: asked.run.id, option: asked.item.options[0]!, via: 'button' })).toEqual({ started: false });
    expect(digestReads(fix)).toBe(reads);
    const run = fix.ctx.store.table('skillRuns').get(asked.run.id)!;
    expect(run.endedAt).not.toBeNull();
    expect(run).toMatchObject({ participants: [] });
    expect(run.learn).toMatchObject({ sessionId: null, digest: null });
    const last = chiefChat(fix).at(-1)!;
    expect(last).toMatchObject({ from: fix.chief.id, kind: 'reply', text: '林舟此刻不在岗，这次没有学习。' });
    expect(learnOffDutyText('林舟')).toBe('林舟此刻不在岗，这次没有学习。');
    expect(chiefChat(fix).some(row => row.text.includes('没能'))).toBe(false);
    expect(fix.ctx.store.table('queue').list(row => row.subjectKey.startsWith('learn:'))).toHaveLength(0);
  });
});

describe('7.3 额度灯为红：学习候选不在学习员工的私聊里落「当前额度不足」', () => {
  it('红灯下排队中的学习候选：员工私聊与总管私聊都没有那一句，候选仍在队列里；对照：主人发给员工的消息照常落一次', async () => {
    const { fix, asked } = await learning();
    expect(await chooseLearnSession(fix.ctx, { runId: asked.run.id, option: asked.item.options[0]!, via: 'button' })).toEqual({ started: true });
    const key = learnSubjectKey(asked.run.id, fix.engineer.id);
    expect(fix.ctx.store.table('queue').list(row => row.subjectKey === key)).toHaveLength(1);
    onQuotaError(fix.ctx, fix.ctx.clock.now());
    for (let i = 0; i < 3; i += 1) await tick(fix, MINUTE);
    const quotaLines = (botId: string) => fix.ctx.store.log('thread').all().filter(row => row.thread === botId && row.text.includes('当前额度不足'));
    expect(quotaLines(fix.engineer.id)).toHaveLength(0);
    expect(quotaLines(fix.chief.id)).toHaveLength(0);
    expect(fix.ctx.store.table('queue').list(row => row.subjectKey === key)).toHaveLength(1);
    // 对照：主人发给员工的消息仍然收到一次说明。
    await fix.hub.api.sendMessage(fix.engineer.id, '红灯期间消息');
    for (let i = 0; i < 3; i += 1) await tick(fix, MINUTE);
    expect(quotaLines(fix.engineer.id)).toHaveLength(1);
  });
});

describe('7.4 回合上限', () => {
  it('单次学习的回合上限是 6', async () => {
    const { fix, asked } = await learning();
    expect(SKILL_DEFAULTS.LEARN_TURN_CAP).toBe(6);
    expect(asked.run.turnCap).toBe(6);
    expect(learnRun(fix)!.turnCap).toBe(6);
  });
});

describe('7.5 主人还没选会话时不结束；并发选两次只学习一次', () => {
  it('发起学习和选会话之间推进几次巡检（含隔了两天）：学习记录没有被结束，总管私聊没有落「没能……」；之后主人选会话，照常学习', async () => {
    const { fix, asked } = await learning();
    for (let i = 0; i < 6; i += 1) await tick(fix, 10 * MINUTE);
    setLocal(fix, '2026-11-08 10:00');
    for (let i = 0; i < 3; i += 1) await tick(fix, 10 * MINUTE);
    const run = fix.ctx.store.table('skillRuns').get(asked.run.id)!;
    expect(run.endedAt).toBeNull();
    expect(run).toMatchObject({ participants: [] });
    expect(chiefChat(fix).some(row => row.refId?.startsWith('learn-end:') === true)).toBe(false);
    expect(fix.ctx.store.table('inbox').get(asked.item.id)).toMatchObject({ status: 'open' });
    // 主人此时才选：照常学习。
    expect(await chooseByButton(fix, asked)).toMatchObject({ ok: true });
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(learnSrcIn(packet).kind).toBe('你的指示');
  });

  it('选会话时条目必须还开着：第一次还在读摘要时第二次到达被拒；学习只进行一次（只读一次摘要、只有一条出处、一个学习唤醒、主人所选的那一行只落一次）', async () => {
    const { fix, asked } = await learning();
    const release = delayDigest(fix);
    const reads = digestReads(fix);
    const first = chooseLearnSession(fix.ctx, { runId: asked.run.id, option: asked.item.options[0]!, via: 'button' });
    const second = chooseLearnSession(fix.ctx, { runId: asked.run.id, option: asked.item.options[0]!, via: 'inbox' });
    // 第二次一到就应该被拒（不等读摘要）：与「还在等」比先后，条目不再检查「还开着」时第二次会一直等在读摘要上，这里立刻判为失败而不是等超时。
    const settled = await Promise.race([second.then(() => '通过了', (error: Error) => error.message), Promise.resolve().then(() => '还在等')]);
    release();
    await Promise.allSettled([second]);
    expect(settled).toBe('这次学习的提问已经处理过了');
    expect(await first).toEqual({ started: true });
    expect(digestReads(fix) - reads).toBe(1);
    const run = fix.ctx.store.table('skillRuns').get(asked.run.id)!;
    expect(run.participants).toHaveLength(1);
    expect(fix.ctx.store.table('skillSources').list(row => row.botId === fix.engineer.id && row.kind === 'owner_instruction')).toHaveLength(1);
    expect(fix.ctx.store.table('queue').list(row => row.subjectKey === learnSubjectKey(asked.run.id, fix.engineer.id))).toHaveLength(1);
    expect(chiefChat(fix).filter(row => row.from === 'owner' && row.refId === asked.item.id)).toHaveLength(1);
  });
});

describe('5.8 学习写出的技能：活动流里来源的写法', () => {
  it('「来自你的指示（会话『…』）」，不重复「你的指示」', async () => {
    const { fix, asked } = await learning();
    expect(await chooseByButton(fix, asked)).toMatchObject({ ok: true });
    const { result } = await learnerProposes(fix);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '学习完成', reply: '学好了。' });
    const reviewerPacket = await nextPacket(fix, fix.reviewer.id);
    const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: updatesIn(reviewerPacket)[0]!.id, consistent: 'met', withinScope: 'met' });
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '核对完了。' });
    const rows = fix.hub.api.activity({ limit: 200 } as never).rows.filter(row => row.kind === 'skill');
    expect(rows.map(row => row.text)).toContain('技能更新　林舟　「名单导出」第 2 版，来自你的指示（会话『导出报名表』）。评审甲核对通过。');
    expect(rows.flatMap(row => [row.text, ...(row.lines ?? [])]).filter(text => INTERNAL_NAMES.test(text))).toEqual([]);
  });
});
