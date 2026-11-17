/**
 * P74r18a 第 4 节的测试：审批标题（要主人确认的事）不带英文命令名。
 * 覆盖：
 * - 有专门中文说法的命令只写说法：结束其他进程（kill、killall、pkill）、用默认应用打开文件或网址（open，新加的专门说法）、发消息等；
 * - 没有专门说法的保持「说法（命令名）」：调用其他应用（osascript）；
 * - 括号里是主机名、远端名的说法不在本节范围，不改：连接远程机器（ssh 到 build.example.com）、把代码推送到远端仓库（origin main）；
 * - 真实路径：员工在会话里用命令工具运行 open、kill，生成的审批上写的就是新说法。
 */
import { describe, expect, it } from 'vitest';
import { outwardSentence } from '../src/gate/outward-commands.js';
import { jobFix, type JobFix } from './p74b-fixtures.js';
import { bot } from './p74f-fixtures.js';

/** 员工用自己的会话运行一条命令，返回新生成的那张审批。 */
function approvalFor(fix: JobFix, command: string) {
  const before = new Set(fix.ctx.store.table('approvals').list().map(row => row.id));
  const decision = fix.hub.guardToolCall(bot(fix, fix.engineer.id).sessionId!, 'bash', { command });
  expect(decision, command).toMatchObject({ allow: false });
  return fix.ctx.store.table('approvals').list().find(row => !before.has(row.id))!;
}

describe('4 审批标题不带英文命令名', () => {
  it('有专门说法的只写说法', () => {
    expect(outwardSentence('system_settings', 'kill')).toBe('结束其他进程');
    expect(outwardSentence('system_settings', 'killall')).toBe('结束其他进程');
    expect(outwardSentence('system_settings', 'pkill')).toBe('结束其他进程');
    expect(outwardSentence('system_settings', 'shutdown')).toBe('关机或重启这台电脑');
    expect(outwardSentence('send_message', 'open')).toBe('用默认应用打开文件或网址');
    expect(outwardSentence('send_message', 'pbcopy')).toBe('读写剪贴板');
    expect(outwardSentence('send_message', 'lark-cli')).toBe('发消息');
  });

  it('没有专门说法的保持「说法（命令名）」', () => {
    expect(outwardSentence('send_message', 'osascript')).toBe('调用其他应用（osascript）');
    expect(outwardSentence('system_settings', 'defaults')).toBe('修改这台电脑的系统设置（defaults）');
    expect(outwardSentence('cloud_resource', 'kubectl')).toBe('操作云端资源（kubectl）');
    expect(outwardSentence('global_install', 'brew')).toBe('安装软件（brew）');
  });

  it('发布上线那张表的命令仍带括号和名称（括号里是平台或工具的名字）', () => {
    expect(outwardSentence('publish_deploy', 'vercel')).toBe('把网站或服务部署到线上（vercel）');
    expect(outwardSentence('publish_deploy', 'gh')).toBe('操作代码托管平台上的仓库、合并请求或发布（gh）');
    expect(outwardSentence('publish_deploy', 'npm')).toBe('操作软件包仓库上的账号或权限（npm）');
  });

  it('括号里是主机名、远端名的说法不改', () => {
    expect(outwardSentence('remote_access', 'ssh 到 build.example.com')).toBe('连接远程机器（ssh 到 build.example.com）');
    expect(outwardSentence('git_push', 'origin main')).toBe('把代码推送到远端仓库（origin main）');
    expect(outwardSentence('http_post', 'example.com')).toBe('向 example.com 发送数据');
  });

  it('真实路径：员工运行 open、kill，审批上写的是新说法；osascript 仍带命令名', async () => {
    const fix = await jobFix();
    expect(approvalFor(fix, 'open index.html').actionText).toBe('用默认应用打开文件或网址');
    expect(approvalFor(fix, 'kill 12345').actionText).toBe('结束其他进程');
    expect(approvalFor(fix, 'osascript -e "beep"').actionText).toBe('调用其他应用（osascript）');
  });
});
