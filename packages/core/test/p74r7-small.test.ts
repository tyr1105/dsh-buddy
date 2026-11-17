/**
 * P74r7 第 3、4 节的测试：
 * 第 3 节：总管守则和派活工具的说明里有「发布方式要问清楚」「launchStep 只在写明发布到哪里、用什么方式时为 true」这几句；
 * 第 4 节：员工状态文字里模型写的受阻原因要过内部名称检查（带这件事编号的回合）：含工具名的显示成固定句，不含的原样显示，
 * 不带这件事编号的回合不动。
 */
import { describe, expect, it } from 'vitest';
import { BLOCKED_SEE_THREAD, blockedActivityText } from '../src/job/blocked-shown.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { bot, nextPacket } from './p74f-fixtures.js';
import { jobFix, lockedAndAwake } from './p74b-fixtures.js';
import { acceptedWithLaunch } from './p74g-launch-fixtures.js';

describe('第 3 节：总管守则和工具说明', () => {
  it('总管守则里有对外发布要问清楚的几句，派活提示里有 deliveryItems 与 launchStep 的新口径', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    expect(packet).toContain('主人的需求里有对外发布（上线、发布、部署、发出去）时：在约定的 launch 里写清发布到哪里、用什么方式（一行字，只写发布到哪里、用什么方式，不写「发布前请你批准」这类话（约定卡上中心会加））。主人没有说发布到哪里、用什么方式时，不要列进 pending：你能给出一个具体可行的发布方式，就直接写进 launch（约定卡上「验收之后对外发布：……」那一行就是给主人确认的，主人不同意会在确认前直接说，那时再改约定）；给不出具体的发布方式（不知道发布到哪里），就不写 launch，在 scopeOut（这次不做）里写一条「对外发布：你没有说发布到哪里，这次不含发布；需要时告诉我发布到哪里、用什么方式」，并且不要对主人说「发布前会请你批准」。');
    // 「列进待你定」那一句已去掉。
    expect(packet).not.toContain('列进 pending（待你定）');
    expect(packet).toContain('deliveryItems 只写「怎样算做完」里写了交付时间的那一条的序号（通常只有一条，没有就不写；其余条目都要有证据并经过核对）');
    expect(packet).toContain('launchStep 不用填：验收之后有没有对外发布这一步，由约定里的对外发布一项（launch）决定。');
  });

  it('hub_job_manage 的说明和参数说明里有同样的口径', async () => {
    const fix = await jobFix();
    const tool = fix.hub.tools().find(item => item.name === 'hub_job_manage')!;
    const text = JSON.stringify(tool);
    expect(text).toContain('launchStep 不用填：这件事验收之后有没有对外发布这一步，由约定里的对外发布一项（launch）决定');
    expect(text).toContain('不用填：这件事有没有发布这一步，由约定里的对外发布一项（launch）决定；填了而与约定不一致会被拒绝');
    expect(text).toContain('通常只有一条，没有就不填；其余条目都要有证据并经过核对');
    expect(text).toContain('deliveryItems 写「怎样算做完」里写了交付时间的那一条的序号（通常只有一条，没有就不写；其余条目都要有证据并经过核对）');
  });
});

describe('第 4 节：员工状态文字里的受阻原因', () => {
  it('函数：带这件事编号的回合，含工具名的换成固定句，不含的原样；不带编号的回合不动', () => {
    expect(BLOCKED_SEE_THREAD).toBe('受阻，详情见对话');
    expect(blockedActivityText('发布缺少目标信息：hub_job_work 提问又因事项已完成被系统拒绝', 'job_0000000001')).toBe('受阻，详情见对话');
    expect(blockedActivityText('约定里没有写发布到哪里', 'job_0000000001')).toBe('受阻：约定里没有写发布到哪里');
    expect(blockedActivityText('hub_job_work 报错', null)).toBe('受阻：hub_job_work 报错');
    expect(blockedActivityText('hub_job_work 报错', undefined)).toBe('受阻：hub_job_work 报错');
  });

  it('接线：执行者在这件事的回合里交账 blocked，状态文字按检查显示', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: 'hub_job_work 提问又因事项已完成被系统拒绝', summary: '受阻' });
    expect(bot(fix, fix.engineer.id)).toMatchObject({ activity: 'blocked', activityText: '受阻，详情见对话' });
  });

  it('接线：不含内部名称时原样显示', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '约定里没有写发布到哪里', summary: '受阻' });
    expect(bot(fix, fix.engineer.id)).toMatchObject({ activity: 'blocked', activityText: '受阻：约定里没有写发布到哪里' });
  });
});
