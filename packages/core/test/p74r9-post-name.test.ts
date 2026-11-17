/**
 * P74r9 第 5 节的测试：派活后主题里那句话，括号里写员工的岗位名称（组队时的岗位，如「工程师」），
 * 不再写岗位类别（原来写成「林舟（执行）执行」）；没有岗位名称时不写括号。
 * 同样用岗位类别拼出的试用反馈句（「评审甲（评审）……核对」）一并改成岗位名称（文字测试在 p74f-receipt.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import { staffPostName } from '../src/team/workload.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { assignArgs } from './p74c-fixtures.js';
import { callTool, jobFix, lockedAndAwake, threadOf } from './p74b-fixtures.js';

/** 总管派活，返回主题里总管那一句。 */
async function assignAndRead(removeOrigin: boolean): Promise<{ text: string; post: string | null }> {
  const fix = await jobFix();
  const id = agreementIdIn(await lockedAndAwake(fix));
  if (removeOrigin) fix.ctx.store.table('botOrigins').remove(fix.engineer.id);
  const post = staffPostName(fix.ctx, fix.ctx.store.table('bots').get(fix.engineer.id)!);
  expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id))).toMatchObject({ ok: true });
  const job = fix.ctx.store.table('jobs').list()[0]!;
  const said = threadOf(fix.ctx, job.topicId).find(row => row.from === fix.chief.id && row.kind === 'reply' && row.refId === job.id)!;
  return { text: said.text, post };
}

describe('复核后：总管唤醒包的岗位名称与发布口径', () => {
  it('在岗员工清单带岗位名称（岗位类别保留）；守则句式用岗位名称；守则和两个工具说明里没有「列进待你定」，有新口径', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    expect(packet).toContain('林舟（工程师，执行，在办 0 件）');
    expect(packet).toContain('评审甲（评审员，评审，在办 0 件）');
    expect(packet).toContain('「这件事由某某（岗位名称）执行，某某在交付前核对。理由：……」；某某没有岗位名称就不写括号');
    expect(packet).not.toContain('列进 pending（待你定）');
    expect(packet).toContain('你能给出一个具体可行的发布方式，就直接写进 launch');
    expect(packet).toContain('在 scopeOut（这次不做）里写一条「对外发布：你没有说发布到哪里，这次不含发布；需要时告诉我发布到哪里、用什么方式」');
    const tool = JSON.stringify(fix.hub.tools().find(item => item.name === 'hub_agreement_submit'));
    expect(tool).toContain('你能给出具体可行的方式就直接写进 launch');
    expect(tool).toContain('给不出就不写 launch，在 scopeOut 里写一条「对外发布：你没有说发布到哪里，这次不含发布；需要时告诉我发布到哪里、用什么方式」');
    expect(tool).not.toContain('待你定');
  });
});

describe('5 主题里「这件事由……执行」', () => {
  it('有岗位名称：括号里写「工程师」，不是「执行」', async () => {
    const { text, post } = await assignAndRead(false);
    expect(post).toBe('工程师');
    expect(text).toBe('这件事由林舟（工程师）执行，评审甲在交付前对照约定核对。我已把你的原话、草图和约定第 1 版作为文件交给林舟。');
    expect(text).not.toContain('（执行）执行');
  });

  it('没有岗位名称（员工没有来历记录）：不写括号', async () => {
    const { text, post } = await assignAndRead(true);
    expect(post).toBeNull();
    expect(text).toBe('这件事由林舟执行，评审甲在交付前对照约定核对。我已把你的原话、草图和约定第 1 版作为文件交给林舟。');
  });
});
