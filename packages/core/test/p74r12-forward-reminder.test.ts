/**
 * P74r12 第 1 节的测试：主人在一件进行中的事的主题里给了材料，总管只修订约定、没有转交时，修订成功的返回文字带一句提醒。
 *
 * 覆盖：
 * 1 在执行中的事的主题里发话，总管只调用修订：返回文字逐字带那一句提醒；
 * 2 同一回合先 forward 再修订：没有那一句；
 * 3 同一回合先修订（看到提醒）再 forward：forward 成功，材料出现在「材料」文件夹里；主人确认新版之后执行者被叫醒，唤醒包里列出这份材料；
 * 4 主人在总管私聊里发话引起的修订、主人在已完成的事的主题里发话引起的修订：没有那一句；
 * 5 只用唤醒包文字：唤醒包里有新加的做法说明，按它构造一次 forward 加一次修订，都成功。
 * 全部走真实的 Hub，时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { FORWARD_REMINDER_TEXT } from '../src/job/forward-reminder.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { ownerSays, speak } from './p74b-fixtures.js';
import { MINUTE, commitAndEnd, runningOf, tick } from './p74c-fixtures.js';
import { bot, callTool, lastPacket, nextPacket, sectionOf, started, type JobFix } from './p74d-fixtures.js';
import { delivered } from './p74f-fixtures.js';

const MATERIAL = '活动文案：AI 产品沙龙，11月20日 14:00，限 60 人，额满即止。';
const SENTENCE = '这一版出自主人在这件事主题里的话。那句话里如果有执行者要用的材料（文案、数据、文件、链接），再调用 hub_job_manage，mode 写 forward，把主人的原话转交给执行者；约定改版不会把材料带过去。';

/** 新版本只改「这次做」的第 2 条（其余不动）；进行中的事修订要写 continuing、paused。 */
function reviseArgs(agreementId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'revise', agreementId, changeNote: '限 60 人',
    scopeIn: ['报价列表页', '手动刷新，名额限 60 人'],
    continuing: ['报价列表页'], paused: ['名额相关的部分'], fallback: '如果只是文案说法，回复「不变」，我保留第 1 版。',
    ...extra,
  };
}

/** 执行者结束回合，主人在这件事的主题里 @总管 发话，总管拿到一个主人发起的回合（带这件事的主题）。 */
async function ownerInTopic(fix: JobFix, topicId: string, text: string): Promise<void> {
  for (const who of [fix.engineer, fix.reviewer]) if (runningOf(fix, who.id)) await commitAndEnd(fix, who.id, { outcome: 'progress', summary: '先收尾' });
  if (runningOf(fix, fix.chief.id)) await speak(fix, bot(fix, fix.chief.id), '好。', { outcome: 'progress' });
  await ownerSays(fix, topicId, `@老大 ${text}`);
  for (let i = 0; i < 8 && !runningOf(fix, fix.chief.id); i += 1) await tick(fix, 5 * MINUTE);
  const wake = runningOf(fix, fix.chief.id);
  expect(wake, '主人在主题里发话之后总管应该拿到一个回合').toBeDefined();
  expect(wake!.topicId).toBe(topicId);
  expect(wake!.ownerInitiated).toBe(true);
}

const forward = (fix: JobFix, jobId: string) => callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId, title: '活动文案', text: MATERIAL });

describe('1 修订成功时的转交提醒', () => {
  it('主人在执行中的事的主题里发话，总管只调用修订：返回文字逐字带那一句提醒', async () => {
    const { fix, job } = await started();
    await ownerInTopic(fix, job.topicId, MATERIAL);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(job.agreementId));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.text!.endsWith(SENTENCE)).toBe(true);
    expect(FORWARD_REMINDER_TEXT).toBe(SENTENCE);
    expect(result.text).toContain('已记下第 2 版，等主人确认。');
  });

  it('同一回合先 forward 再修订：返回文字没有那一句', async () => {
    const { fix, job } = await started();
    await ownerInTopic(fix, job.topicId, MATERIAL);
    expect(await forward(fix, job.id)).toMatchObject({ ok: true });
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(job.agreementId));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.text).not.toContain('forward');
    expect(result.text).not.toContain(SENTENCE);
  });

  it('同一回合先修订（看到提醒）再 forward：材料出现在「材料」里；主人确认之后执行者被叫醒，唤醒包里列出这份材料', async () => {
    const { fix, job } = await started();
    await ownerInTopic(fix, job.topicId, MATERIAL);
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(job.agreementId));
    expect(revised.text).toContain(SENTENCE);
    const forwarded = await forward(fix, job.id);
    expect(forwarded, JSON.stringify(forwarded)).toMatchObject({ ok: true });
    const jobDir = (/约定 (\S+)\/约定\.md；/.exec(sectionOf(lastPacket(fix, bot(fix, fix.engineer.id))))?.[1])!;
    expect(await fix.ctx.fs.readText(`${jobDir}/材料/活动文案.md`)).toContain('限 60 人');
    await speak(fix, bot(fix, fix.chief.id), '材料里是 60 人，和约定的不一样，请你确认。', { outcome: 'needs_owner' });
    await ownerSays(fix, job.topicId, '定了');
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain('活动文案.md');
  });

  it('主人在总管私聊里发话引起的修订：没有那一句', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, MATERIAL);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(job.agreementId));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.text).not.toContain(SENTENCE);
  });

  it('主人在已完成的事的主题里发话引起的修订：没有那一句', async () => {
    const { fix, job } = await delivered();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    await ownerInTopic(fix, job.topicId, MATERIAL);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId: job.agreementId, changeNote: '限 60 人', scopeIn: ['报价列表页', '手动刷新，名额限 60 人'] });
    expect(result.text ?? result.error).not.toContain(SENTENCE);
  });
});

describe('5 只用唤醒包文字', () => {
  it('唤醒包里有新加的做法说明；按它先 forward 再修订，都成功', async () => {
    const { fix, job } = await started();
    await ownerInTopic(fix, job.topicId, MATERIAL);
    const packet = lastPacket(fix, bot(fix, fix.chief.id));
    expect(packet).toContain('材料与约定有出入时，两件事都要做：先用 forward 转交主人的原话，再修订约定请主人确认；只修订约定，执行者拿不到材料。');
    const jobId = /jobId 为 (job_[0-9a-z]{10})/.exec(sectionOf(packet))?.[1];
    expect(jobId).toBe(job.id);
    expect(await forward(fix, jobId!)).toMatchObject({ ok: true });
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', reviseArgs(agreementIdIn(packet)));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.text).not.toContain(SENTENCE);
  });
});
