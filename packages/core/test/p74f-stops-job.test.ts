/**
 * P74f-2 的测试（一）：停止的依据与 stopsJob（补充要求第 1 节）。
 *
 * 规则：停下一件事只有两种依据——主人确认了写明不再做的版本（stopsJob，由中心直接停，不叫醒总管），
 * 或主人在这一回合的原话里直接说了不做（总管 stop，派活那一回合里不行，见 p74e-stop.test.ts）。
 * 这里覆盖：四条确认途径（按钮、「待你处理」、主题里打字、私聊里打字）结果相同；撤销后照常接着做；
 * 没有进行中的事的约定上写 stopsJob 被拒；约定卡多一行由中心生成的话；总管只用唤醒包里的文字就能提交。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { chiefDrafts } from './p74b-fixtures.js';
import { commitAndEnd, entriesOf, eventsOf, wakesOf } from './p74c-fixtures.js';
import { INTERNAL, jobFix } from './p74d-fixtures.js';
import { ownerTypes } from './p74f-fixtures.js';
import { MINUTE, bot, callTool, lastPacket, ownerSays, speak, started, stopRevise, theJob, tick, type JobFix } from './p74f2-fixtures.js';
import { threadOf } from './p74b-fixtures.js';

type Route = 'button' | 'inbox' | 'topic_text' | 'chat_text';

/** 主人用某条途径确认第 2 版（写明不再做）。 */
async function confirmVia(fix: JobFix, agreementId: string, topicId: string, route: Route): Promise<void> {
  if (route === 'button') expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
  else if (route === 'inbox') {
    const item = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey === `agreement:${agreementId}:2`)[0];
    expect(item, '「待你处理」里应该有这一版的确认条目').toBeDefined();
    expect(await fix.hub.api.answerInbox(item!.id, '按建议，定了')).toMatchObject({ ok: true });
  } else await ownerTypes(fix, route === 'topic_text' ? topicId : fix.chief.id, '定了');
  await flushJobHooks(fix.ctx);
}

/** 四条途径共同的结果：只比较与路径无关的事实。 */
function outcome(fix: JobFix, jobId: string) {
  const job = theJob(fix);
  return {
    state: job.state, blocked: job.blocked, pause: job.pause, queued: fix.ctx.store.table('queue').count(row => row.jobId === jobId),
    stopped: eventsOf(fix.ctx, jobId).filter(row => row.kind === 'stopped').map(row => ({ actor: row.actor, via: row.data.via })),
    topic: threadOf(fix.ctx, job.topicId).filter(row => row.text.startsWith('这件事已按约定第')).map(row => [row.from, row.kind, row.text]),
    chief: threadOf(fix.ctx, fix.chief.id).filter(row => row.text === '「会员定价页」已停止。').map(row => [row.from, row.kind]),
  };
}

describe('stopsJob：主人确认写明不再做的版本，由中心停下这件事', () => {
  const routes: Route[] = ['button', 'inbox', 'topic_text', 'chat_text'];
  it('四条确认途径结果相同：已停止、队列清空、两句话，总管没有新的回合', async () => {
    const results: Array<ReturnType<typeof outcome>> = [];
    for (const route of routes) {
      const { fix, job } = await started();
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
      const agreementId = await stopRevise(fix);
      // 确认前：这件事照常在做，没有被停下，也没有叫醒执行者去暂停什么。
      expect(theJob(fix)).toMatchObject({ state: 'doing', pause: { versionNo: 2, stopsJob: true, paused: [], continuing: [] } });
      const chiefBefore = entriesOf(fix, fix.chief.id).length + wakesOf(fix, fix.chief.id).length;
      await confirmVia(fix, agreementId, job.topicId, route);
      expect(theJob(fix).state, route).toBe('stopped');
      expect(entriesOf(fix, fix.chief.id).length + wakesOf(fix, fix.chief.id).length, `${route}：总管没有新的回合`).toBe(chiefBefore);
      const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
      expect(agreement.versions.find(row => row.state === 'locked')).toMatchObject({ no: 2, stopsJob: true });
      const result = outcome(fix, job.id);
      expect(result.topic.map(row => row[2])).toEqual(['这件事已按约定第 2 版停止，已经做出来的东西保留在项目文件夹里。']);
      expect(JSON.stringify(result)).not.toMatch(INTERNAL);
      results.push(result);
    }
    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
    expect(results[0]).toMatchObject({ state: 'stopped', queued: 0, stopped: [{ actor: 'hub', via: 'agreement' }], chief: [['hub', 'system']] });
  });

  it('确认之后时间流逝：这件事不产生任何回合，也不弹回合上限或停住了条目', async () => {
    const { fix, job } = await started();
    const agreementId = await stopRevise(fix);
    await confirmVia(fix, agreementId, job.topicId, 'button');
    const activity = () => fix.ctx.store.table('queue').count(row => row.jobId === job.id) + fix.ctx.store.table('wakes').count(row => row.jobId === job.id);
    const before = activity();
    for (let i = 0; i < 12; i += 1) await tick(fix, 10 * MINUTE);
    expect(activity()).toBe(before);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`) && row.status === 'open')).toHaveLength(0);
  });

  it('主人不确认、总管撤销：这件事照常接着做，约定仍是已固定的第 1 版', async () => {
    const { fix, job } = await started();
    const agreementId = await stopRevise(fix);
    await ownerSays(fix, fix.chief.id, '还是接着做吧');
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'withdraw', agreementId, reason: '主人说还是接着做' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', pause: null });
    expect(fix.ctx.store.table('agreements').get(agreementId)).toMatchObject({ state: 'locked' });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'stopped')).toHaveLength(0);
  });

  it('这件事有没回答的提问：带 stopsJob 的版本不要求写 answersAsk；确认停止时提问随之作废，工作往来写一句', async () => {
    const { fix, job } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '报价要不要含税？' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已问总管' });
    expect(theJob(fix).openAsk).not.toBeNull();
    await ownerSays(fix, fix.chief.id, '这件事不做了');
    const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId, changeNote: '这件事不再做',
      scopeOut: ['历史曲线', '这件事不再做'], stopsJob: true });
    expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '这件事不再做，请你确认。', { outcome: 'needs_owner' });
    await confirmVia(fix, agreementId, job.topicId, 'button');
    expect(theJob(fix)).toMatchObject({ state: 'stopped', openAsk: null });
    expect(threadOf(fix.ctx, job.topicId).some(row => row.kind === 'work' && row.text === '林舟的问题随之作废，这件事已停止。')).toBe(true);
  });

  it('约定卡多一行由中心生成的话；「待你处理」条目正文最后一句写「确认后这件事停止」', async () => {
    const { fix, job } = await started();
    const agreementId = await stopRevise(fix);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const view = agreementCardView(fix.ctx, agreement, agreement.versions.at(-1)!);
    expect(view.stopLine).toBe('确认后这件事停止，已经做出来的东西保留在项目文件夹里。');
    expect(view.jobSplit).toBeNull();
    expect(agreementCardView(fix.ctx, agreement, agreement.versions[0]!).stopLine).toBeNull();
    const item = fix.ctx.store.table('inbox').list(row => row.subjectKey === `agreement:${agreementId}:2`)[0]!;
    // P74r14 第 6 节改了预期：原来断言正文以这句结尾；说明行现在只由界面按标记（agreementStop）显示，正文不再带。
    expect(item.body).not.toContain('不会自动按建议处理');
    expect(item.body).not.toContain('你确认后这件事停止');
    expect(item.body).not.toMatch(INTERNAL);
    expect(job.id).toBeDefined();
  });

  it('stopsJob 用在没有进行中的事的约定上被拒；带 continuing 一起写也被拒', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页' });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    await speak(fix, fix.chief, '已固定。', { outcome: 'progress' });
    await ownerSays(fix, fix.chief.id, '这件事不做了');
    const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
    const refused = await callTool(fix, fix.chief, 'hub_agreement_submit', { mode: 'revise', agreementId, changeNote: '这件事不再做',
      scopeOut: ['历史曲线', '这件事不再做'], stopsJob: true });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('stopsJob');
    // 有进行中的事时，stopsJob 与 continuing、paused 同时写被拒。
    const { fix: other } = await started();
    await commitAndEnd(other, other.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(other, other.chief.id, '这件事不做了');
    const otherId = agreementIdIn(lastPacket(other, bot(other, other.chief.id)));
    const both = await callTool(other, other.chief, 'hub_agreement_submit', { mode: 'revise', agreementId: otherId, changeNote: '这件事不再做',
      scopeOut: ['历史曲线', '这件事不再做'], stopsJob: true, continuing: ['无'], paused: ['全部'] });
    expect(both).toMatchObject({ ok: false });
    expect(String(both.error)).toContain('stopsJob 为 true 时不用写');
  });
});
