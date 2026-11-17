/**
 * P74g 测试的公共环境（不是测试文件）之二：发布这一步、审批的三行用的真实 Hub 环境。
 *
 * 在 P74f 的「核对通过、已交付」起点上，提供：有发布步骤的事验收、林舟拿到发布准备回合并提交发布命令、
 * 只从唤醒包文字里取 jobId、提交发布命令用的参数。时间全部用注入的假时钟。
 */
import { expect } from 'vitest';
import type { Job } from '../src/model/job.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { bot, callTool, delivered, nextPacket, sectionOf, theJob, type JobFix } from './p74f-fixtures.js';

/** 唤醒包里取 jobId（只用文字）。 */
export function jobIdIn(packet: string): string {
  const id = /jobId 为 (job_[0-9a-z]{10})/.exec(sectionOf(packet))?.[1];
  expect(id, '唤醒包里应该有 jobId').toBeDefined();
  return id!;
}

/** 林舟提交发布命令用的参数：run_command，带 why 和三行说明。 */
export function launchArgs(fix: JobFix, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'run_command', why: '会员定价页已验收，发布到报名站点，让用户能看到', payload: { cmd: 'node', args: ['work/go-live.js'], cwd: bot(fix, fix.engineer.id).homeDir },
    cost: '不产生费用', undo: '可以在后台下线，下线后链接失效', after: '约 5 分钟后上线，上线后任何人拿到链接都能报名', ...extra };
}

/** 有发布步骤的事交付、主人点「验收通过」。返回环境和这件事（验收之后的记录）。 */
export async function acceptedWithLaunch(): Promise<{ fix: JobFix; job: Job }> {
  const { fix, job } = await delivered([], { launch: true });
  expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
  return { fix, job: theJob(fix) };
}

/** 林舟拿到发布准备的回合并提交发布命令（必须成功），结束这一回合；返回审批单和这一回合的唤醒包。 */
export async function submitLaunch(fix: JobFix, extra: Record<string, unknown> = {}) {
  const packet = await nextPacket(fix, fix.engineer.id);
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, extra));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const approval = fix.ctx.store.table('approvals').list()[0]!;
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已提交发布审批，等主人批准' });
  return { packet, approval };
}
