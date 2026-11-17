/**
 * P74r18a 第 2、3.1 节的测试：执行者与核对人的唤醒包写明「验收之前不发布」，执行者的唤醒包写明自测的做法。
 * 覆盖：
 * 2   约定有对外发布时，执行者（干活、返工）和核对人的唤醒包里各有逐字的一行；约定没有对外发布时不出现；压缩到最紧的一级仍在；
 * 3.1 自测那一行任何事都有，压缩到最紧的一级仍在。
 * 全部走真实的 Hub、真实工具；时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import type { QueueEntry, WakeTicket } from '../src/model/wake.js';
import { buildJobBodyDetailed } from '../src/wake/job-section.js';
import { FIXTURE_LAUNCH_HOW } from './p74c-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { bot, engineerSubmits, lastPacket, nextPacket, started, theJob, type JobFix } from './p74d-fixtures.js';

/** 逐字的三句（与任务卡一致）。 */
const EXECUTOR_LAUNCH = `这件事验收之后才对外发布（${FIXTURE_LAUNCH_HOW}），由中心在主人批准之后进行。验收之前不要做这一步，也不要把交付物放到发布的位置；交付物只放进这件事的交付文件夹。`;
const REVIEWER_LAUNCH = `这件事验收之后才对外发布（${FIXTURE_LAUNCH_HOW}）。核对时确认执行者没有提前做这一步；已经提前做了，判不符，并写明要撤回。`;
const SELF_TEST = '自测用命令行检查文件内容和脚本输出。不要在主人的电脑上打开浏览器或别的应用，不要启动常驻的本地服务：这些动作要主人批准，会打断他。';

/** 直接取这位员工在这件事上的「你手上的事」段（可指定更小的上限，逼出最紧的压缩级别）。 */
async function bodyOf(fix: JobFix, botId: string, maxBytes?: number) {
  const job = theJob(fix);
  const entry = { jobId: job.id, reason: { evidence: [] } } as unknown as QueueEntry;
  return buildJobBodyDetailed(fix.ctx, bot(fix, botId), entry, { jobId: job.id } as unknown as WakeTicket, maxBytes);
}

/** 执行者交回，核对人拿到核对的回合。返回核对人的整份唤醒包。 */
async function reviewerPacket(fix: JobFix, info: Parameters<typeof engineerSubmits>[1]): Promise<string> {
  await engineerSubmits(fix, info);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  return nextPacket(fix, fix.reviewer.id);
}

describe('2 约定有对外发布：执行者和核对人的唤醒包写明验收之前不发布', () => {
  it('执行者干活：有逐字的一行；与自测那一行同时在', async () => {
    const { fix } = await started([], { launch: true });
    const packet = lastPacket(fix, bot(fix, fix.engineer.id));
    expect(packet).toContain(EXECUTOR_LAUNCH);
    expect(packet).toContain(SELF_TEST);
  });

  it('执行者返工：同样有这一行', async () => {
    const { fix, info } = await started([], { launch: true });
    await engineerSubmits(fix, info);
    // 手工改成返工中（只改状态与未通过的条目，其余不动），取返工时的正文。
    fix.ctx.store.table('jobs').patch(theJob(fix).id, { state: 'rework', round: 1, unmet: [{ no: 2, problem: '没有刷新按钮', fixTo: '加上刷新按钮' }] });
    const result = await bodyOf(fix, fix.engineer.id);
    expect(result.text).toContain('现在：返工');
    expect(result.text).toContain(EXECUTOR_LAUNCH);
  });

  it('核对人：有逐字的一行', async () => {
    const { fix, info } = await started([], { launch: true });
    const packet = await reviewerPacket(fix, info);
    expect(packet).toContain(REVIEWER_LAUNCH);
    // 核对人的唤醒包里没有给执行者的那一行。
    expect(packet).not.toContain('验收之前不要做这一步');
  });

  it('反例：约定没有对外发布：执行者和核对人的唤醒包里都没有这一行', async () => {
    const { fix, info } = await started();
    expect(lastPacket(fix, bot(fix, fix.engineer.id))).not.toContain('验收之后才对外发布');
    const packet = await reviewerPacket(fix, info);
    expect(packet).not.toContain('验收之后才对外发布');
  });

  it('压缩到最紧的一级（上限小到装不下）：两行仍在', async () => {
    const { fix, info } = await started([], { launch: true });
    const executor = await bodyOf(fix, fix.engineer.id, 1);
    expect(executor.level).toBe(4);
    expect(executor.text).toContain(EXECUTOR_LAUNCH);
    await reviewerPacket(fix, info);
    const reviewer = await bodyOf(fix, fix.reviewer.id, 1);
    expect(reviewer.level).toBe(4);
    expect(reviewer.text).toContain(REVIEWER_LAUNCH);
  });
});

describe('3.1 自测那一行', () => {
  it('约定没有对外发布时，执行者的唤醒包也有；核对人的没有', async () => {
    const { fix, info } = await started();
    expect(lastPacket(fix, bot(fix, fix.engineer.id))).toContain(SELF_TEST);
    expect(await reviewerPacket(fix, info)).not.toContain(SELF_TEST);
  });

  it('压缩到最紧的一级仍在，并在「交回」之前', async () => {
    const { fix } = await started();
    const result = await bodyOf(fix, fix.engineer.id, 1);
    expect(result.level).toBe(4);
    expect(result.text).toContain(SELF_TEST);
    expect(result.text.indexOf(SELF_TEST)).toBeLessThan(result.text.indexOf('交回：调用 hub_job_work'));
  });
});
