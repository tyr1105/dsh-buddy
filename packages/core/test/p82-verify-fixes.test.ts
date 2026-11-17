/**
 * P82：第二轮真实模型验证抓到的 core 侧缺陷（第 2、3、4 条）的测试。
 *
 * 依据是 /tmp/agent-hub-verify-20261114-2/verification-record.md 的逐回合记录：
 * - 缺陷 2：总管把「准备发布文件夹」当成自己的活（先 mkdir、再想写占位文件）。发布位置只需要上一级文件夹存在，
 *   文件夹本身由发布命令创建；对齐说明与拒绝原因里都要写清，不能反过来催总管去建。
 * - 缺陷 3：命令失败原因没有如实转述给主人。发布命令运行出错时要在给主人那一句里带上宿主原文（中心确认的失败原因）。
 * - 缺陷 4：发布命令的执行目录必须在家目录或共享目录内，工具说明和发布准备的唤醒包正文里都要有这一句。
 *
 * 缺陷 1（约定之前总管不能自己写交付物）的守卫测试在 p76q-chief-deliverable.test.ts，
 * 缺陷 5（stallOf 的 approval、failed 两个分支）在 p76g-stall.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_DIR_REASONS, localDirRefusal } from '../src/project/local-dir.js';
import { LOCAL_DIR_SENTENCE } from '../src/project/agreement-content.js';
import { launchFailedText } from '../src/job/launch-result.js';
import { launchPrepareBody } from '../src/wake/job-section-launch.js';
import { HOST_COMMAND_CWD_RULE } from '../src/gate/host-writable.js';
import { hubOutboxSubmit } from '../src/tools/hub-outbox-submit.js';

describe('2 发布位置：文件夹由发布命令创建', () => {
  it('对齐时的说明写清文件夹可以还不存在、不用先建，但上一级要存在', () => {
    expect(LOCAL_DIR_SENTENCE).toContain('这个文件夹本身可以还不存在，发布命令会自己建出来，不用先建');
    expect(LOCAL_DIR_SENTENCE).toContain('上一级文件夹要已经存在');
  });

  it('上一级文件夹不存在时不再让总管自己去建', () => {
    const text = localDirRefusal(LOCAL_DIR_REASONS.parentMissing);
    expect(text).toContain('不要自己去建');
    expect(text).not.toContain('请先建好');
  });
});

describe('3 失败原因如实带给主人', () => {
  it('发布命令运行出错时，括号里带上中心确认的失败原因（命令运行了、以非零退出码结束）', () => {
    // P85 同步：原来这里用「命令执行目录……宿主命令不运行」这条没有运行的原因来证明「带上原文」；
    // 命令没有运行的几种原因现在改为固定说法（见 p85 测试），这一条改用命令运行了的原因（退出码）证明原写法不变。
    const reason = '命令退出码 2';
    expect(launchFailedText('会员定价页', { ownerFailureReason: reason, result: `${reason}：boom`, executionStarted: true }))
      .toBe(`「会员定价页」没有发布成功：发布命令运行出错（${reason}）。`);
  });

  it('固定说明（超时、写入被拒）保持原样，不重复原因', () => {
    expect(launchFailedText('会员定价页', { ownerFailureReason: '命令超时', result: '命令超时：' }))
      .toBe('「会员定价页」没有发布成功：命令超时');
    expect(launchFailedText('会员定价页', { ownerFailureReason: '命令退出码 1', result: '命令退出码 1：cp: x: Permission denied' }))
      .toBe('「会员定价页」没有发布成功：要发布到的位置写不进去。');
  });
});

describe('4 命令执行目录的范围写进该写的地方', () => {
  it('hub_outbox_submit 的工具说明里有这一句', () => {
    expect(hubOutboxSubmit.description).toContain(HOST_COMMAND_CWD_RULE);
  });

  it('发布准备的唤醒包正文里有这一句', () => {
    const body = launchPrepareBody({ id: 'job_x' } as never, '会员定价页', '/hub/j', [], 0, '复制到 /tmp/site');
    expect(body.tail).toContain(HOST_COMMAND_CWD_RULE);
  });
});
