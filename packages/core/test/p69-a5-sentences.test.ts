/**
 * P69 A-5：审批卡上两类话说得更具体。
 *
 * P1  D 类（不可逆）：分类器的内部理由（reason）不改，审批卡靠 hint 标记查表，说成主人看得懂的话。
 *     这里有一条「覆盖性」检查：闸里每一种 D 结果都必须带标记、且标记在表里有话；
 *     以后新增一种 D 而忘了配话，这条测试会变红（源码里 cls: 'D' 的位置也会被扫一遍）。
 * P2  「发布上线」这一类按程序说得更具体（部署、代码托管、发布软件包、镜像、包仓库账号），表里没有的保持笼统说法。
 * 分类器是纯函数，命令只是字符串，不会被执行；路径全是假的。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyToolCall } from '../src/gate/classify.js';
import type { GateContext } from '../src/gate/paths.js';
import { DANGER_SENTENCES, outwardSentence } from '../src/gate/outward-commands.js';
import { ASK_HINTS } from '../src/model/outreach.js';
import { dangerSentence, ownerApprovalSentence } from '../src/util/approval-sentence.js';

const owner = '/Users/owner', root = '/hub', home = `${root}/bots/b_0000000001`;
const legacy: GateContext = { homeDir: home, ownerHome: owner, rootDir: root, sharedDir: `${root}/shared`, workDataAllowed: false, workDataPaths: [`${owner}/CompanyWork`], cwd: home };
const sandboxed: GateContext = { ...legacy, sandboxed: true, tmpDirs: ['/tmp', '/private/tmp'], projectDirs: [`${root}/projects/prj_0000000001`] };
const opts = { ownerHome: owner, commandMaxChars: 200 };
const say = (command: string, ctx: GateContext = sandboxed): string => ownerApprovalSentence('exec', { command }, classifyToolCall('exec', { command }, ctx).asks, opts)!;

/** 不属于 D 类的说法标记（C 类的几种）；其余标记都是 D 类，必须在 DANGER_SENTENCES 里有话。 */
const C_HINTS = ['remote_script', 'blind_script', 'sandbox_escape', 'managed_files'];

describe('P1 D 类每一种结果都有主人话', () => {
  it('ASK_HINTS 里每个 D 类标记都在 DANGER_SENTENCES 里有话（新增而忘了配话会红）', () => {
    for (const hint of ASK_HINTS.filter(h => !C_HINTS.includes(h))) expect(DANGER_SENTENCES, hint).toHaveProperty(hint);
    for (const hint of Object.keys(DANGER_SENTENCES)) expect(ASK_HINTS as readonly string[], hint).toContain(hint);
  });

  it('源码里每个产出 D 的位置都带 hint（只有「尚未允许访问工作数据目录」例外，它被直接拒绝、不出审批卡）', () => {
    const dir = new URL('../src/gate/', import.meta.url);
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter(name => name.endsWith('.ts'))) {
      readFileSync(new URL(file, dir), 'utf8').split('\n').forEach((line, index) => {
        if (/cls: 'D'/.test(line) && !/hint:/.test(line) && !/work_data/.test(line) && !/rank|cls === |cls !== |\.cls|=== 'D'/.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  // 每种 D 理由各一条真实命令：闸给出的 D 件都带标记，主人话不再是分类器的内部理由。
  it.each<[string, string]>([
    ['git push --force origin main', '强制覆盖或删除远端仓库里的分支（不可逆）'],
    ['git push origin --delete feature-x', '强制覆盖或删除远端仓库里的分支（不可逆）'],
    ['npm publish', '把软件包发布到公共仓库，或撤回已发布的版本（不可逆）'],
    ['sudo ls', '用管理员权限运行命令'],
    ['su -c ls', '用管理员权限运行命令'],
    ['curl -X POST https://api.stripe.com/v1/charges', '调用支付、下单或转账接口'],
    ['curl -X DELETE https://api.example.com/items/1', '删除云端或代码托管平台上的资源（不可逆）'],
    ['gh repo delete owner/repo', '删除云端或代码托管平台上的资源（不可逆）'],
    ['kubectl delete pod web', '删除云端或代码托管平台上的资源（不可逆）'],
  ])('%s -> 主人话含「%s」', (command, expected) => {
    for (const ctx of [sandboxed, legacy]) {
      const result = classifyToolCall('exec', { command }, ctx);
      const dangers = (result.asks ?? []).filter(ask => ask.cls === 'D');
      expect(dangers.length, `${command} 没有 D 件`).toBeGreaterThan(0);
      for (const ask of dangers) {
        expect(ask.hint, `${command} 的 D 件没带标记：${ask.reason}`).toBeDefined();
        expect(dangerSentence(ask, owner)).not.toBe(ask.reason);
      }
      expect(say(command, ctx)).toContain(expected);
    }
  });

  it('分类器的 reason 文字不变（日志和越界记录在用）', () => {
    expect(classifyToolCall('exec', { command: 'sudo ls' }, sandboxed).reason).toBe('提权命令永久需要审批');
    expect(classifyToolCall('exec', { command: 'npm publish' }, sandboxed).reason).toBe('发布或撤回软件包是不可逆对外动作');
  });

  it('写系统目录：往系统目录里写文件：路径（路径写法同其他路径）', () => {
    expect(say('cp work/a.txt /etc/hosts', legacy)).toContain('往系统目录里写文件：/etc/hosts');
    expect(dangerSentence({ hint: 'system_write', reason: 'x', paths: [`${owner}/x`, '/etc/b', '/etc/c'] }, owner)).toBe('往系统目录里写文件：~/x、/etc/b 等 3 处');
  });

  it('没有标记的 D（旧审批单）照旧显示理由；出站动作里的 D 也用同一张表', () => {
    expect(dangerSentence({ reason: '某个旧理由' })).toBe('某个旧理由');
    expect(ownerApprovalSentence('hub_outbox_execute', { kind: 'run_command' }, [{ cls: 'D', reason: '提权命令永久需要审批', hint: 'elevate' }], opts))
      .toBe('用管理员权限运行命令；请中心代为运行一条命令');
  });
});

describe('P2 「发布上线」按程序说得更具体', () => {
  it.each<[string, string]>([
    ['vercel', '把网站或服务部署到线上（vercel）'], ['vc', '把网站或服务部署到线上（vc）'], ['wrangler', '把网站或服务部署到线上（wrangler）'],
    ['eas', '把网站或服务部署到线上（eas）'], ['swa', '把网站或服务部署到线上（swa）'], ['fly', '把网站或服务部署到线上（fly）'],
    ['gh', '操作代码托管平台上的仓库、合并请求或发布（gh）'], ['glab', '操作代码托管平台上的仓库、合并请求或发布（glab）'],
    ['twine', '把软件包发布到公共仓库（twine）'], ['cargo', '把软件包发布到公共仓库（cargo）'], ['lerna', '把软件包发布到公共仓库（lerna）'],
    ['docker', '推送镜像或登录镜像仓库（docker）'], ['podman', '推送镜像或登录镜像仓库（podman）'],
    ['npm', '操作软件包仓库上的账号或权限（npm）'], ['pnpm', '操作软件包仓库上的账号或权限（pnpm）'], ['yarn', '操作软件包仓库上的账号或权限（yarn）'], ['bun', '操作软件包仓库上的账号或权限（bun）'],
    ['某个没登记的程序', '发布上线或操作代码托管平台（某个没登记的程序）'],
  ])('%s', (program, sentence) => {
    expect(outwardSentence('publish_deploy', program)).toBe(sentence);
  });
  it('没有对象时保持笼统说法', () => {
    expect(outwardSentence('publish_deploy')).toBe('发布上线或操作代码托管平台');
  });
  it.each<[string, string]>([
    ['npx vercel --prod', '把网站或服务部署到线上（vercel）'],
    ['gh pr create --fill', '操作代码托管平台上的仓库、合并请求或发布（gh）'],
    ['python3 -m twine upload dist/x', '把软件包发布到公共仓库（twine）'],
    ['npm login', '操作软件包仓库上的账号或权限（npm）'],
    ['docker push example/app', '推送镜像或登录镜像仓库（docker）'],
  ])('真实命令 %s', (command, sentence) => {
    expect(say(command)).toContain(sentence);
  });
});
