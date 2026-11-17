/**
 * P76f：能到达同一结果的全部路径（方案 8.4 的「看到一次将超出预计的提问」「一件事因为预算停下」两行），以及与别处的接线。
 *
 * 路径：回合收尾的 checkBudget、每个 tick 的巡检（sweepJobs）、闸门丢弃 job_cap 之后（settleDroppedJobEntry）、
 * 交回时回合用到上限没叫醒下一个人（stuckText）。每条路径到预算线各只产生一条条目；问过时 0 条。
 * 夹具说明见 p76f-fixtures.ts：额度灯为绿、预算线 8、时钟每次推进不超过 10 分钟。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sweepJobs } from '../src/job/sweep.js';
import {
  MINUTE, askedNotReached, capItems, chiefSaid, countEvents, engineerProgress, engineerTurns, entriesOf, openCap, reachedAfterAsked, started,
  theJob, threadOf, tick,
} from './p76f-fixtures.js';
import { engineerSubmits, nextPacket } from './p74d-fixtures.js';

describe('11 到预算线的各条路径各只产生一条条目', () => {
  it('闸门丢弃 job_cap 之后（settleDroppedJobEntry）：候选在被选择时丢弃，这件事立刻受阻，条目恰好一条，再调度不重复', async () => {
    const { fix, job } = await started();
    await engineerProgress(fix);
    // 林舟的续排候选在队列里；已用回合数改成预算线，闸门选择时丢弃它。
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await tick(fix, 1_000);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
    expect(capItems(fix, job.id)).toHaveLength(1);
    expect(countEvents(fix, job.id, 'turn_cap')).toBe(1);
    await tick(fix, 5 * MINUTE);
    expect(capItems(fix, job.id)).toHaveLength(1);
  });

  it('巡检（sweepJobs）：直接巡检一次建一条，再巡检不重复', async () => {
    const { fix, job } = await started();
    await engineerProgress(fix);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    sweepJobs(fix.ctx, fix.ctx.clock.now());
    expect(capItems(fix, job.id)).toHaveLength(1);
    sweepJobs(fix.ctx, fix.ctx.clock.now());
    expect(capItems(fix, job.id)).toHaveLength(1);
    expect(countEvents(fix, job.id, 'turn_cap')).toBe(1);
  });

  it('交回时回合用到上限没能叫醒核对人（stuckText）：条目一条，正文最后一行写等谁做什么；之后巡检不重复', async () => {
    const { fix, job, info } = await started();
    // 林舟这一回合还开着，已用回合数就是预算线：交回成功，核对人叫不醒，这个动作本身就是最后一步。
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await engineerSubmits(fix, info);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
    const items = capItems(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('会员定价页：已用到预计消耗');
    expect(items[0]!.body.split('\n').at(-1)).toBe('目前停在：等评审甲核对第 1 轮交回');
    await tick(fix, 5 * MINUTE);
    expect(capItems(fix, job.id)).toHaveLength(1);
    expect(chiefSaid(fix).filter(text => text.includes('已停下'))).toHaveLength(1);
  });

  it('问过之后各路径都是 0 条：交回时用到预算线（stuckText）只停下，不另建；私聊只落「超出的部分已停下」', async () => {
    // 各步已用：对齐 1、执行 3；问过一次；林舟再拿一个回合，已用回合数改成预算线后交回。
    const { fix, job, info } = await askedNotReached();
    await nextPacket(fix, fix.engineer.id);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await engineerSubmits(fix, info);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
    expect(capItems(fix, job.id)).toHaveLength(1);
    expect(theJob(fix).inboxId).toBe(openCap(fix, job.id)!.id);
    expect(chiefSaid(fix).filter(text => text.includes('超出的部分已停下'))).toEqual(['会员定价页已用到预计的 9 回合，超出的部分已停下，在等你决定。']);
  });

  it('同一件事先「将超出」后「用到预算线」：条目只有一条、总管私聊两句（预计要用、超出的部分已停下）', async () => {
    const { fix, job } = await reachedAfterAsked();
    expect(capItems(fix, job.id)).toHaveLength(1);
    const said = chiefSaid(fix).filter(text => text.includes('预计'));
    expect(said).toEqual([
      '会员定价页预计要用 10 回合，超出约定的 9 回合，在等你决定；预计之内的部分照常在做。',
      '会员定价页已用到预计的 9 回合，超出的部分已停下，在等你决定。',
    ]);
  });

  it('问过的条目被别的条目顶替撤回之后用到预算线：当作没问过，重新建一条，停下之后主人才有地方答复', async () => {
    const { fix, job } = await askedNotReached();
    const first = openCap(fix, job.id)!;
    fix.ctx.store.table('inbox').patch(first.id, { status: 'withdrawn', answer: '这件事有了新的待办', answeredAt: fix.ctx.clock.now() });
    await engineerTurns(fix, 5);
    await tick(fix, MINUTE);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
    const items = capItems(fix, job.id);
    expect(items.map(row => row.status)).toEqual(['withdrawn', 'open']);
    expect(items[1]!.title).toBe('会员定价页：已用到预计消耗');
  });
});

describe('11 源码里不再有旧的写法', () => {
  /** src 下全部 .ts 文件的文字。 */
  function sourceTexts(): Array<{ rel: string; text: string }> {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const found: Array<{ rel: string; text: string }> = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) found.push({ rel: path.slice(root.length + 1), text: readFileSync(path, 'utf8') });
      }
    };
    walk(root);
    return found;
  }

  it('TURN_TOP_UP、capOptions、topUpOption 不再出现；写预算线的位置只有建这件事和 budget-line.ts', () => {
    const all = sourceTexts();
    for (const word of [/\bTURN_TOP_UP\b/, /\bcapOptions\b/, /\btopUpOption\b/]) {
      expect(all.filter(file => word.test(file.text)).map(file => file.rel), String(word)).toEqual([]);
    }
    const writers = all.filter(file => !file.rel.startsWith('skill/') && !['model/job.ts', 'model/skill.ts'].includes(file.rel)
      && (/\bturnCap:\s*(?!number\b)\S/.test(file.text) || /\bturnCap \+/.test(file.text))).map(file => file.rel).sort();
    expect(writers).toEqual(['job/assign.ts', 'job/budget-line.ts']);
  });

});

describe('P79：主人对预计消耗条目表示不同意并写一句话', () => {
  it('将超出预计（这件事还在做）：话落在总管私聊并叫醒总管（主人发起的回合），条目仍开着、这件事状态与预算线不变；之后仍能答复条目', async () => {
    // P79 的界面对这类条目没有多出按钮，主人用对话输入框写话，走 sendMessage（与对话里直接说话同一条路径）。
    const { fix, job } = await askedNotReached();
    const item = openCap(fix, job.id)!;
    const before = { state: theJob(fix).state, cap: theJob(fix).turnCap, used: theJob(fix).turnsUsed };
    const sent = await fix.hub.api.sendMessage(fix.chief.id, '我不同意再加回合，这件事的范围太大了');
    expect(sent).toMatchObject({ ok: true });
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.from === 'owner' && row.text === '我不同意再加回合，这件事的范围太大了')).toBe(true);
    expect(theJob(fix)).toMatchObject({ state: before.state, turnCap: before.cap, turnsUsed: before.used });
    expect(fix.ctx.store.table('inbox').get(item.id)!.status).toBe('open');
    expect(fix.ctx.store.table('jobNotices').get(job.id)!.budgetAskedCaps).toEqual([8]);
    // 条目仍然可以答复。
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '暂停' })).toMatchObject({ ok: true });
  });

  it('已用到预算线（这件事受阻）：同样，话照常落在总管私聊，状态和预算线不变，条目仍开着', async () => {
    const { fix, job } = await reachedAfterAsked();
    const item = openCap(fix, job.id)!;
    expect(await fix.hub.api.sendMessage(fix.chief.id, '先别加，我想把范围缩小一点')).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' }, turnCap: 8 });
    expect(fix.ctx.store.table('inbox').get(item.id)!.status).toBe('open');
  });
});
