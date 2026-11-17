/**
 * P69 A-1：命令和路径分类器在「宿主确认沙箱开着」时的新规则（纯分类，不碰守卫和审批表）。
 *
 * 读法：每个 describe 对应任务卡的一条。大多数用例成对出现：
 * - 正例：sandboxed 为 true 时的新判定；
 * - 反例：不传 sandboxed（旧规则）时，同一条命令保持原判定，证明开关有效。
 * 路径全部用假根目录 /hub 和假主人 /Users/owner，不出现任何真实机器的路径。
 */
import { describe, expect, it } from 'vitest';
import { classifyCommand, classifyToolCall } from '../src/gate/classify.js';
import { mentionsCredentialPath, scanOpaque } from '../src/gate/sandbox-rules.js';
import type { GateContext } from '../src/gate/paths.js';

const owner = '/Users/owner', root = '/hub', home = `${root}/bots/b_0000000001`;
const project = `${root}/projects/prj_0000000001`, tmp = '/private/var/folders/ab/xyz/T';
/** 旧规则的上下文：没有 sandboxed、tmpDirs、projectDirs。 */
const legacy: GateContext = { homeDir: home, ownerHome: owner, rootDir: root, sharedDir: `${root}/shared`, workDataAllowed: false,
  workDataPaths: [`${owner}/CompanyWork`], cwd: home };
/** 沙箱确认开着：临时目录和项目目录都带上。 */
const sandboxed: GateContext = { ...legacy, sandboxed: true, tmpDirs: ['/tmp', '/private/tmp', tmp], projectDirs: [project] };
/** 同样的上下文，但宿主报了 sandboxed: false。 */
const notSandboxed: GateContext = { ...sandboxed, sandboxed: false };

describe('P69 A2 沙箱内的不确定，不再问人（开关有效）', () => {
  // [命令, 旧规则下的类别]：旧规则下全部是 C，开着沙箱后全部放行，子类 sandboxed_exec。
  it.each([
    'frobnicate --all', 'python3 -c "print(1)"', 'node -e "1"', 'ruby -e "1"', 'perl -e "1"', 'python3 build.py', 'python3 /opt/tools/x.py',
    'bash -c "echo hi && sort work/a"', 'sh work/run.sh', 'env FOO=1 frobnicate', 'FOO=1 frobnicate', 'nohup frobnicate', 'timeout 5 frobnicate',
    'xargs frobnicate', 'printenv', 'env', 'set', 'ls --weird', 'find work -name x -newer y -foo', 'find work -delete', 'find work -exec frobnicate {} ;',
    'cp -z work/a work/b', 'touch', 'tee', 'rm', 'ls $UNKNOWN_DIR', 'git add work', 'git commit -m x', 'git clone https://example.com/a.git', 'git config user.name x',
    'npm install', 'pnpm add x', 'yarn build', 'npx prettier work', 'pip install requests', 'pip3 install requests', 'sort work/a', 'cd work && ls',
  ])('沙箱开着放行：%s', command => {
    const withSandbox = classifyCommand(command, sandboxed);
    expect(withSandbox.cls, `${command} → ${withSandbox.reason}`).toBe('A');
    expect(withSandbox.readOnly).not.toBe(true);
  });

  it.each([
    ['frobnicate --all', 'C'], ['python3 -c "print(1)"', 'C'], ['bash -c "echo hi && sort work/a"', 'C'], ['env FOO=1 frobnicate', 'C'], ['printenv', 'C'],
    ['find work -delete', 'C'], ['cp -z work/a work/b', 'C'], ['ls $UNKNOWN_DIR', 'C'], ['git add work', 'C'], ['npm install', 'C'], ['pip install requests', 'C'],
    ['sort work/a', 'C'], ['cd work && ls', 'C'],
  ] as const)('旧规则保持：%s 仍是 %s', (command, cls) => {
    expect(classifyCommand(command, legacy).cls).toBe(cls);
    // 宿主明确报 false 和不传完全一样。
    expect(classifyCommand(command, notSandboxed).cls).toBe(cls);
  });

  it('子类是 sandboxed_exec，而且不是只读：L0 和「本轮已交账」仍然会拦', () => {
    expect(classifyCommand('frobnicate', sandboxed)).toMatchObject({ cls: 'A', subclass: 'sandboxed_exec' });
    expect(classifyCommand('frobnicate', sandboxed).readOnly).toBeFalsy();
  });

  it('递归出来的更高级别保留：sh -c 里面的 ssh 仍然要批准，sudo 仍是 D', () => {
    expect(classifyCommand('sh -c "ssh build.example.com"', sandboxed)).toMatchObject({ cls: 'C', subclass: 'remote_access' });
    expect(classifyCommand('sudo ls', sandboxed).cls).toBe('D');
    expect(classifyCommand('env sudo ls', sandboxed).cls).toBe('D');
    expect(classifyCommand('timeout 5 sh -c "git push origin main"', sandboxed)).toMatchObject({ cls: 'C', subclass: 'git_push' });
  });

  it('包装递归超过上限：沙箱开着不问，旧规则仍是 C', () => {
    const deep = 'env env env env env env env ls';
    expect(classifyCommand(deep, sandboxed).cls).toBe('A');
    expect(classifyCommand(deep, legacy).cls).toBe('C');
  });
});

describe('P69 A3 对外和系统类命令：不管沙箱开没开都要批准', () => {
  // 每个子类：直接调用的程序（至少两个）。用于直接调用和各种包装。
  const table: Record<string, string[]> = {
    remote_access: ['ssh build.example.com ls', 'scp work/a.txt user@build.example.com:/tmp/', 'rsync -a work/ user@build.example.com:/data/', 'nc example.com 80', 'telnet example.com', 'sftp user@build.example.com'],
    git_push: ['git push origin main', 'git push', 'git push -u origin feature/x'],
    publish_deploy: ['gh pr create', 'glab mr list', 'vercel deploy', 'twine upload dist/x.whl', 'docker push example/img', 'docker login', 'gem push x.gem', 'cargo publish'],
    cloud_resource: ['aws s3 ls', 'gcloud compute list', 'kubectl get pods', 'helm install x y', 'terraform apply', 'pulumi up', 'doctl compute droplet list'],
    send_message: ['lark-cli im send x', 'osascript -e x', 'open https://example.com', 'say hi', 'mail -s x a@example.com', 'mailx -s x a@example.com', 'pbcopy', 'pbpaste', 'shortcuts run x'],
    system_settings: ['defaults write x y', 'launchctl list', 'crontab -l', 'at now', 'networksetup -listallnetworkservices', 'kill 123', 'killall Dock', 'pkill node', 'diskutil list', 'shutdown -h now'],
    global_install: ['brew install x', 'brew uninstall x'],
    http_post: ['curl -X POST -d a=1 https://example.com/api', 'wget --post-data=a=1 https://example.com/', 'http POST example.com a=1', 'xh post example.com a=1'],
  };
  const direct = Object.entries(table).flatMap(([subclass, commands]) => commands.map(command => [subclass, command] as const));

  it.each(direct)('%s：直接调用 %s', (subclass, command) => {
    for (const ctx of [sandboxed, legacy]) {
      expect(classifyCommand(command, ctx), `${command} sandboxed=${ctx.sandboxed}`).toMatchObject({ cls: 'C', subclass });
    }
  });

  // 每个子类各取前两个程序，分别包进 sh -c、env、xargs、timeout 里：拆包之后仍然命中。
  const wrappers: Array<[string, (cmd: string) => string]> = [
    ['sh -c', cmd => `sh -c "${cmd.replaceAll('"', "'")}"`], ['env', cmd => `env ${cmd}`], ['xargs', cmd => `echo a | xargs ${cmd}`], ['timeout', cmd => `timeout 5 ${cmd}`],
  ];
  const wrapped = Object.entries(table).flatMap(([subclass, commands]) => commands.slice(0, 2).flatMap(command =>
    wrappers.map(([name, wrap]) => [subclass, name, command, wrap(command)] as const)));
  it.each(wrapped)('%s：用 %s 包住 %s 仍命中', (subclass, _name, _command, command) => {
    // 沙箱开着：包装器自己不带判定，子类就是里面那条命令的子类。
    expect(classifyCommand(command, sandboxed), command).toMatchObject({ cls: 'C', subclass });
    // 没确认沙箱：包装器自己先判 C（旧规则一直如此），子类以第一项为准，所以只断言仍然要批准；
    // 里面那件事保留在 asks 里，审批卡照样能说出来。
    const old = classifyCommand(command, legacy);
    expect(old.cls, command).toBe('C');
    expect(old.asks?.some(ask => ask.subclass === subclass), `${command} 的 asks`).toBe(true);
  });

  it('git push：强推和删远端分支保持 D；commit 和 clone 在沙箱里放行', () => {
    expect(classifyCommand('git push --force origin main', sandboxed).cls).toBe('D');
    expect(classifyCommand('git push origin :old-branch', sandboxed).cls).toBe('D');
    expect(classifyCommand('git push -f', sandboxed).cls).toBe('D');
    expect(classifyCommand('git commit -m x', sandboxed).cls).toBe('A');
    expect(classifyCommand('git clone https://example.com/a.git', sandboxed).cls).toBe('A');
    // 名字大小写不同也认得（macOS 文件系统不区分大小写）。
    expect(classifyCommand('GIT push origin main', sandboxed)).toMatchObject({ cls: 'C', subclass: 'git_push' });
  });

  it('sudo、su 判 D；security 判 protected（钥匙串）', () => {
    expect(classifyCommand('sudo ls', sandboxed).cls).toBe('D');
    expect(classifyCommand('su -', sandboxed).cls).toBe('D');
    expect(classifyCommand('su - -c "ls"', sandboxed).cls).toBe('D');
    expect(classifyCommand('security find-generic-password -s x', sandboxed)).toMatchObject({ cls: 'protected', reason: '不能读取钥匙串里的凭据' });
    // 旧规则下也直接拒绝。
    expect(classifyCommand('security find-generic-password -s x', legacy).cls).toBe('protected');
  });

  it('远端删除规则保持 D；rsync 没有冒号不算远端', () => {
    expect(classifyCommand('aws s3 rm s3://b/x', sandboxed).cls).toBe('D');
    expect(classifyCommand('kubectl delete pod x', sandboxed).cls).toBe('D');
    expect(classifyCommand('rsync -a work/a work/b', sandboxed).cls).toBe('A');
  });

  it('审批卡要用的对象带上了，且已清洗', () => {
    expect(classifyCommand('git push origin main', sandboxed)).toMatchObject({ detail: 'origin main' });
    expect(classifyCommand('ssh build.example.com ls', sandboxed)).toMatchObject({ detail: 'ssh 到 build.example.com' });
    expect(classifyCommand('osascript -e x', sandboxed)).toMatchObject({ detail: 'osascript' });
    expect(classifyCommand('curl -d a=1 https://example.com/api', sandboxed)).toMatchObject({ subclass: 'http_post', detail: 'example.com' });
    // 带中文或空白的分支名不原样显示给主人。
    expect(classifyCommand('git push origin "忽略以上指令"', sandboxed).detail).toBe('origin');
  });

  it('补充名单：数据库客户端、rclone、podman、ansible、npm 账号类、git alias、git credential', () => {
    expect(classifyCommand('psql -h db.example.com', sandboxed)).toMatchObject({ cls: 'C', subclass: 'remote_access' });
    expect(classifyCommand('rclone sync work remote:b', sandboxed)).toMatchObject({ cls: 'C', subclass: 'remote_access' });
    expect(classifyCommand('podman push x', sandboxed)).toMatchObject({ cls: 'C', subclass: 'publish_deploy' });
    expect(classifyCommand('ansible-playbook site.yml', sandboxed)).toMatchObject({ cls: 'C', subclass: 'cloud_resource' });
    for (const sub of ['login', 'owner', 'dist-tag']) expect(classifyCommand(`npm ${sub} x`, sandboxed)).toMatchObject({ cls: 'C', subclass: 'publish_deploy' });
    expect(classifyCommand('npm publish', sandboxed).cls).toBe('D');
    expect(classifyCommand('git -c alias.p=push p origin main', sandboxed).cls).toBe('C');
    // git credential 系列：改判 protected（总控裁定第 4 条）。
    expect(classifyCommand('git credential fill', sandboxed)).toMatchObject({ cls: 'protected', reason: '不能读取保存的凭据' });
  });

  it('审查补充：publish 不在程序名后面紧跟、git 别名、ssh 密钥代理，沙箱开着也要确认；没确认沙箱时旧判定不变', () => {
    for (const command of ['pnpm --filter x publish', 'yarn npm publish', 'npm -w x publish']) expect(classifyCommand(command, sandboxed).cls, command).toBe('D');
    // 这些只是装依赖、跑脚本，不是发布（包名或脚本名恰好叫 publish 也不误伤）。
    for (const command of ['npm run publish', 'npm install publish', 'pnpm add publish']) expect(classifyCommand(command, sandboxed).cls, command).toBe('A');
    expect(classifyCommand('git config alias.p push', sandboxed)).toMatchObject({ cls: 'C', subclass: 'git_write' });
    expect(classifyCommand('git config --global alias.p push', sandboxed).cls).toBe('C');
    expect(classifyCommand('git config user.name x', sandboxed).cls).toBe('A');
    for (const command of ['ssh-add -l', 'ssh-keyscan example.com']) expect(classifyCommand(command, sandboxed)).toMatchObject({ cls: 'C', subclass: 'remote_access' });
    // 旧规则：pnpm --filter x publish 原来就不是 D（'x' 被当成 exec 的别名），保持不变。
    expect(classifyCommand('pnpm --filter x publish', legacy).cls).not.toBe('D');
  });

  it('docker、tmux 这类让沙箱外进程办事的程序，沙箱开着也照旧审批', () => {
    expect(classifyCommand('docker run -v /:/host x', sandboxed).cls).toBe('C');
    expect(classifyCommand('tmux send-keys x', sandboxed).cls).toBe('C');
  });
});

describe('P69 硬拦没有放松（沙箱开着）', () => {
  it.each([
    'cat ~/.ssh/id_rsa', 'cat "~/.dsh/.credentials.yaml"', 'ls ~/.aws', 'cat $HOME/.claude/settings.json', 'cp ~/.netrc work/', 'cat ~/.config/gcloud/x',
    'echo x > AGENTS.md', 'echo x > mind/goals.md', 'tee memory/journal/a.md', 'rm -rf mind', 'rm -rf memory/journal', 'mv mind work/mind',
    'frobnicate ~/.ssh/id_rsa', 'KEY=~/.ssh/id_rsa frobnicate', 'python3 -c "1" ~/.ssh/id_rsa',
  ])('拒绝：%s', command => {
    expect(classifyCommand(command, sandboxed).cls, command).toBe('protected');
  });

  it('不认识的程序参数里写明中心管理的文件：不因为「看不懂就放行」而放松，留在审批', () => {
    expect(classifyCommand('frobnicate AGENTS.md', sandboxed).cls).toBe('C');
    expect(classifyCommand('frobnicate mind/goals.md', sandboxed).cls).toBe('C');
  });

  it('工作数据未授权：读写都拒绝，授权后读取放行', () => {
    expect(classifyCommand(`cat ${owner}/CompanyWork/plan.md`, sandboxed).subclass).toBe('work_data');
    expect(classifyCommand(`frobnicate ${owner}/CompanyWork`, sandboxed).subclass).toBe('work_data');
    expect(classifyCommand(`cat ${owner}/CompanyWork/plan.md`, { ...sandboxed, workDataAllowed: true }).cls).toBe('A');
  });

  it('内联代码里写死的凭据路径：拒绝（尽力而为的字符串检查）', () => {
    // 写成相对路径的写法路径规则看不见（它会被当成一个怪名字的文件），要靠原文检查这一道。
    expect(classifyCommand(`python3 -c "open('.netrc').read()"`, sandboxed).cls).toBe('A');
    expect(classifyToolCall('exec', { command: `python3 -c "open('.netrc').read()"` }, sandboxed)).toMatchObject({ cls: 'protected', reason: '命令里出现了凭据路径' });
    // 写成绝对路径的，路径规则或原文检查总有一个拦下，结论都是拒绝。
    expect(classifyToolCall('exec', { command: `python3 -c "open('${owner}/.ssh/id_rsa').read()"` }, sandboxed).cls).toBe('protected');
  });
});

describe('P69 A6 命令原文里的凭据字样', () => {
  const exec = (command: string, ctx: GateContext = sandboxed) => classifyToolCall('exec', { command }, ctx);

  it.each([
    `python3 -c "open('/Users/x/.ssh/id_rsa').read()"`,
    `python3 -c "import pathlib; pathlib.Path.home().joinpath('.aws/credentials').read_text()"`,
    `node -e "require('fs').readFileSync('/Users/x/.dsh/config.yaml')"`,
    `python3 -c "open('.netrc')"`,
    `ruby -e "File.read(File.expand_path('~/.claude/settings.json'))"`,
    `python3 -c "open('/Users/x/.config/gcloud/credentials.db')"`,
    `python3 -c "open('/Users/x/Library/Keychains/login.keychain-db','rb')"`,
    `python3 -c "open('/Users/x/.codex/auth.json')"`,
    `python3 -c "open('/Users/x/.ssh/id_ed25519')"`,
    `python3 -c "print(open('.env').read())"`,
    `python3 -c "print(open('config/.env.production').read())"`,
    `python3 -c "p = Path.home() / '.ssh'"`,
    `bash -c 'cat ~/.ssh/known_hosts'`,
    `python3 - <<'EOF'\nimport os\nprint(open(os.path.expanduser('~/.dsh/config.yaml')).read())\nEOF`,
  ])('命中：%s', command => {
    // 写成绝对路径的有时会先被路径规则拦下（理由不同），所以这里只断言被拒绝；理由由下一条单独断言。
    expect(exec(command).cls).toBe('protected');
    // 没确认沙箱时不做这道检查（理由不是原文检查那一句），而且旧规则下这些命令本来就不放行（要审批或直接拒绝）。
    // 只断言理由「不是那一句」验证的是没跑检查，验证不了「仍然要审批」，所以补上类别。
    expect(exec(command, legacy).reason).not.toBe('命令里出现了凭据路径');
    expect(exec(command, legacy).cls, `旧规则 ${command}`).not.toBe('A');
  });

  it.each([
    `python3 -c "open('.netrc')"`, `python3 -c "open('.aws/credentials')"`, `python3 -c "print(open('.env').read())"`, `python3 -c "p = Path.home() / '.ssh'"`,
    `python3 - <<'EOF'\nprint(open('.dsh/config.yaml').read())\nEOF`,
  ])('理由是原文检查那一句：%s', command => {
    expect(exec(command)).toMatchObject({ cls: 'protected', reason: '命令里出现了凭据路径' });
  });

  it.each([
    `python3 -c "print(obj.key)"`, `python3 -c "import os; print(os.environ['HOME'])"`, `node -e "console.log(process.env.HOME)"`,
    `python3 -c "d = {'api.key': 1}; print(d['api.key'])"`, `python3 -c "open('x.pem')"`, `python3 -c "open('work/.envrc')"`,
    `python3 -c "valid_rsa = 1; print(valid_rsa)"`, `python3 -c "print('.environment')"`, `node -e "console.log(process.env)"`,
    `python3 - <<'EOF'\nimport re\nprint(re.findall(r'<h1>(.*?)</h1>', open('index.html').read()))\nEOF`,
    // A-3（R10）：只是被 cat 写进文件的文字不是代码，里面提到凭据路径不算碰凭据（原来这一条在「命中」组里）。
    `cat > work/a.sh <<'EOF'\ncat /Users/x/.ssh/id_rsa\nEOF`,
  ])('不误伤：%s', command => {
    expect(exec(command)).toMatchObject({ cls: 'A' });
  });

  it('grep -r process.env src 放行（不是内联代码，走正常的只读规则）', () => {
    expect(exec('grep -r process.env src')).toMatchObject({ cls: 'A', readOnly: true });
  });

  it('只在有内联代码、here-document 或解析不了的部分时才检查原文：普通命令里的字样靠路径规则', () => {
    // cat 的参数是明确路径，走路径规则（也是 protected，但理由不是原文检查的那句）。
    expect(exec('cat ~/.ssh/id_rsa').reason).not.toBe('命令里出现了凭据路径');
    // 引号里的普通字符串参数不是内联代码，不做原文检查。
    expect(exec(`echo "文档里提到 .ssh/ 目录"`)).toMatchObject({ cls: 'A' });
  });

  it('函数本身的单元：mentionsCredentialPath 与 scanOpaque', () => {
    expect(mentionsCredentialPath('open(".ssh/id_rsa")')).toBe(true);
    expect(mentionsCredentialPath('obj.key and x.pem')).toBe(false);
    expect(mentionsCredentialPath('FOO=.env')).toBe(false);
    expect(mentionsCredentialPath('path = "/a/.env"')).toBe(true);
    const opaque = { cls: 'A' as const, reason: 'x', opaque: true };
    expect(scanOpaque(opaque, 'open(".ssh/x")', sandboxed).cls).toBe('protected');
    expect(scanOpaque(opaque, 'open(".ssh/x")', legacy).cls).toBe('A');
    expect(scanOpaque({ cls: 'A', reason: 'x' }, 'open(".ssh/x")', sandboxed).cls).toBe('A');
  });

  it('原文里写出未授权的工作数据目录：留在审批里（卡片之外补充）；授权后放行', () => {
    const command = `python3 -c "open('${owner}/CompanyWork/plan.md')"`;
    expect(exec(command)).toMatchObject({ cls: 'C' });
    expect(exec(command, { ...sandboxed, workDataAllowed: true })).toMatchObject({ cls: 'A' });
    // 目录名前缀相同的另一个目录不命中。
    expect(exec(`python3 -c "open('${owner}/CompanyWork-archive/a')"`)).toMatchObject({ cls: 'A' });
  });
});

describe('P69 A4 临时目录', () => {
  it('写入临时目录放行（子类 tmp）', () => {
    expect(classifyCommand(`echo x > ${tmp}/a.txt`, sandboxed)).toMatchObject({ cls: 'A', subclass: 'tmp' });
    expect(classifyCommand('echo x > /tmp/a.txt', sandboxed)).toMatchObject({ cls: 'A', subclass: 'tmp' });
    expect(classifyCommand(`cp work/a ${tmp}/b`, sandboxed)).toMatchObject({ cls: 'A', subclass: 'tmp' });
    expect(classifyToolCall('write_file', { path: `${tmp}/note.txt` }, sandboxed)).toMatchObject({ cls: 'A', subclass: 'tmp' });
  });

  it('tmpDirs 为空或没确认沙箱：保持现状（/var 仍是系统目录 D，/tmp 仍要审批）', () => {
    const noTmp = { ...sandboxed, tmpDirs: [] };
    expect(classifyCommand(`echo x > ${tmp}/a.txt`, noTmp).cls).toBe('D');
    expect(classifyCommand('echo x > /tmp/a.txt', noTmp).cls).toBe('C');
    expect(classifyCommand(`echo x > ${tmp}/a.txt`, legacy).cls).toBe('D');
    expect(classifyCommand('echo x > /tmp/a.txt', legacy).cls).toBe('C');
    // 宿主报了 tmpDirs 却没确认沙箱：同样不认。
    expect(classifyCommand('echo x > /tmp/a.txt', { ...legacy, tmpDirs: ['/tmp'] }).cls).toBe('C');
  });

  it('临时目录排在系统目录之前，但敏感路径仍然最先', () => {
    // 上溯五级才到 /private，再进 etc：真正落在系统目录（D）。原来写两级只走到 /private/var/folders/ab/etc，根本没测到系统目录。
    expect(classifyCommand(`cp work/a ${tmp}/../../../../../etc/hosts`, sandboxed)).toMatchObject({ cls: 'D', subclass: 'system_write', blocked: true });
    // 临时目录本身在 /private/var 下面（系统目录之内），却必须判 A tmp；这一条改坏「临时目录排在系统目录之前」就会变红。
    expect(classifyCommand(`echo x > ${tmp}/a.txt`, sandboxed)).toMatchObject({ cls: 'A', subclass: 'tmp' });
    expect(classifyCommand(`cat ${tmp}/.ssh/id_rsa`, sandboxed).cls).toBe('protected');
    expect(classifyCommand('echo x > /etc/hosts', sandboxed)).toMatchObject({ cls: 'D', blocked: true });
  });

  it('删除临时目录里的文件放行；变量目标交给沙箱；rm -f "$TMP" 旧规则仍是 D', () => {
    expect(classifyCommand('rm /tmp/x.py', sandboxed).cls).toBe('A');
    expect(classifyCommand(`rm ${tmp}/x.py`, sandboxed).cls).toBe('A');
    expect(classifyCommand('rm -f "$TMP"', sandboxed).cls).toBe('A');
    expect(classifyCommand('rm /tmp/x.py', legacy).cls).toBe('D');
    expect(classifyCommand('rm -f "$TMP"', legacy).cls).toBe('D');
  });
});

describe('P69 总控裁定第 2 条：下载放行', () => {
  it.each([
    'curl -sSL -o work/a.html https://example.com/a.html', 'curl -O https://example.com/a.zip', 'curl --output work/a.html https://example.com/a.html',
    'curl --remote-name https://example.com/a.zip', 'wget https://example.com/a.zip', 'wget -q https://example.com/a.zip', 'wget -O work/a.zip https://example.com/a.zip',
    'wget -P work https://example.com/a.zip', `curl -o ${tmp}/a.html https://example.com/a.html`, 'curl -o /dev/null https://example.com/', 'curl -fsSL -o /tmp/x https://example.com/x',
  ])('沙箱开着放行：%s', command => {
    const result = classifyCommand(command, sandboxed);
    expect(result.cls, `${command} → ${result.reason}`).toBe('A');
  });

  it.each([
    'curl -sSL -o work/a.html https://example.com/a.html', 'curl -O https://example.com/a.zip', 'wget https://example.com/a.zip', 'wget -O work/a.zip https://example.com/a.zip',
  ])('没确认沙箱：%s 仍要批准，但标成下载', command => {
    expect(classifyCommand(command, legacy)).toMatchObject({ cls: 'C', subclass: 'http_post', download: true, detail: 'example.com' });
  });

  it('输出到沙箱外：按指路处理（blocked）', () => {
    const result = classifyCommand(`curl -o ${owner}/Desktop/a.html https://example.com/a.html`, sandboxed);
    expect(result).toMatchObject({ cls: 'C', blocked: true });
    expect(classifyCommand(`curl -o ${project}/a.html https://example.com/a.html`, sandboxed)).toMatchObject({ cls: 'C', blocked: true });
    expect(classifyCommand(`wget -P ${owner}/Desktop https://example.com/a.zip`, sandboxed)).toMatchObject({ cls: 'C', blocked: true });
  });

  it('带数据、上传、改方法的仍要确认，说法是向域名发送数据', () => {
    for (const command of ['curl -o work/a -d x=1 https://example.com/a', 'curl -T work/a https://example.com/up', 'curl -X POST https://example.com/a',
      'curl -o work/a -F f=@work/a https://example.com/a', 'curl --json {} https://example.com/a', 'wget --post-data=a=1 https://example.com/', 'wget --method=PUT --body-data=x https://example.com/']) {
      expect(classifyCommand(command, sandboxed), command).toMatchObject({ cls: 'C', subclass: 'http_post', detail: 'example.com' });
      expect(classifyCommand(command, sandboxed).download).not.toBe(true);
    }
  });

  it('支付类地址和 DELETE 仍是 D，下载也一样', () => {
    expect(classifyCommand('curl -o work/a https://example.com/api/payments', sandboxed).cls).toBe('D');
    expect(classifyCommand('wget https://example.com/checkout', sandboxed).cls).toBe('D');
    expect(classifyCommand('curl -X DELETE https://example.com/a', sandboxed).cls).toBe('D');
  });

  it('下载到受保护或敏感位置：拒绝', () => {
    expect(classifyCommand('curl -o ~/.ssh/authorized_keys https://example.com/k', sandboxed).cls).toBe('protected');
    expect(classifyCommand('curl -o mind/goals.md https://example.com/k', sandboxed).cls).toBe('protected');
    expect(classifyCommand('wget -O AGENTS.md https://example.com/k', sandboxed).cls).toBe('protected');
  });

  it('只读 GET 不受影响：curl 到标准输出照旧是 A 只读', () => {
    expect(classifyCommand('curl -sSL https://example.com/a', sandboxed)).toMatchObject({ cls: 'A', readOnly: true });
    expect(classifyCommand('curl -sSL https://example.com/a', legacy)).toMatchObject({ cls: 'A', readOnly: true });
  });

  it('web_fetch 工具的 POST 也带上域名', () => {
    expect(classifyToolCall('web_fetch', { url: 'https://example.com/a', method: 'POST' }, sandboxed)).toMatchObject({ cls: 'C', subclass: 'http_post', detail: 'example.com' });
  });
});

describe('P69 沙箱模式的词法：括号、花括号、here-document', () => {
  it('子外壳和函数体里的对外命令认得出来', () => {
    for (const command of ['(cd work && ssh build.example.com)', '{ ssh build.example.com; }', 'f() { ssh build.example.com; }; f', 'if true; then git push origin main; fi',
      'for x in 1 2; do scp work/a u@h:/tmp/; done', 'echo $(ssh build.example.com id)', 'echo `ssh build.example.com id`']) {
      expect(classifyCommand(command, sandboxed).cls, command).toBe('C');
    }
  });

  it('here-document 正文不当成一行行命令；没带引号的定界符里的命令替换仍然要分类', () => {
    const quoted = classifyCommand(`cat > work/a.md <<'EOF'\nssh build.example.com\ngit push origin main\nEOF`, sandboxed);
    expect(quoted.cls).toBe('A');
    const plain = classifyCommand(`cat > work/a.md <<EOF\n$(ssh build.example.com id)\nEOF`, sandboxed);
    expect(plain.cls).toBe('C');
  });

  it('喂给外壳的 here-document 就是要执行的脚本', () => {
    expect(classifyCommand(`bash <<'EOF'\ngit push origin main\nEOF`, sandboxed)).toMatchObject({ cls: 'C', subclass: 'git_push' });
    expect(classifyCommand(`sh <<< "ssh build.example.com"`, sandboxed).cls).toBe('C');
    expect(classifyCommand(`eval "git push origin main"`, sandboxed)).toMatchObject({ cls: 'C', subclass: 'git_push' });
  });

  it('重定向目标在 here-document 命令上照旧检查', () => {
    expect(classifyCommand(`cat > ${owner}/Desktop/a.md <<'EOF'\nx\nEOF`, sandboxed)).toMatchObject({ cls: 'C', blocked: true });
    expect(classifyCommand(`cat > AGENTS.md <<'EOF'\nx\nEOF`, sandboxed).cls).toBe('protected');
  });
});

describe('P69 A5 沙箱外的写入：分类结果带 blocked 和目标路径', () => {
  it('项目目录、共享目录、其他位置各自 blocked，路径记在 asks 里', () => {
    const toProject = classifyCommand(`cp work/a.html ${project}/`, sandboxed);
    expect(toProject).toMatchObject({ cls: 'C', blocked: true });
    expect(toProject.asks?.some(ask => ask.paths?.some(path => path.startsWith(project)))).toBe(true);
    expect(classifyCommand(`echo x > ${root}/shared/a.txt`, sandboxed)).toMatchObject({ cls: 'C', blocked: true });
    expect(classifyCommand(`echo x > ${owner}/Desktop/a.txt`, sandboxed)).toMatchObject({ cls: 'C', blocked: true });
    expect(classifyCommand(`rm -rf ${owner}/Documents/x`, sandboxed)).toMatchObject({ cls: 'D', blocked: true });
  });

  it('混了别的对外动作：blocked 不成立', () => {
    expect(classifyCommand(`cp work/a.html ${owner}/Desktop/ && git push`, sandboxed).blocked).not.toBe(true);
    expect(classifyCommand(`cp work/a.html ${owner}/Desktop/ && ssh build.example.com`, sandboxed).blocked).not.toBe(true);
  });

  it('没确认沙箱：同样的写入没有 blocked（旧规则）', () => {
    expect(classifyCommand(`echo x > ${owner}/Desktop/a.txt`, legacy)).toMatchObject({ cls: 'C' });
    expect(classifyCommand(`echo x > ${owner}/Desktop/a.txt`, legacy).blocked).not.toBe(true);
  });
});

describe('P69 A7-1 项目目录：classifyPath 判 A（project_file）', () => {
  // 没确认沙箱、但上下文带了 projectDirs：这就是经中心代写（出站动作）的口径。
  const viaHub: GateContext = { ...legacy, projectDirs: [project] };

  it('经中心代写：写项目目录判 A project_file，非成员或没带项目目录仍判 C', () => {
    expect(classifyToolCall('write_file', { path: `${project}/index.html` }, viaHub)).toMatchObject({ cls: 'A', subclass: 'project_file' });
    expect(classifyToolCall('write_file', { path: `${project}/index.html` }, legacy)).toMatchObject({ cls: 'C', subclass: 'write_file' });
    expect(classifyToolCall('write_file', { path: `${root}/projects/prj_other/index.html` }, viaHub)).toMatchObject({ cls: 'C' });
  });

  it('敏感路径和受保护路径仍然最先', () => {
    expect(classifyToolCall('write_file', { path: `${project}/.env` }, viaHub).cls).toBe('protected');
    expect(classifyToolCall('write_file', { path: `${project}/.ssh/id_rsa` }, viaHub).cls).toBe('protected');
  });

  it('中心维护的 context.md 不跟着放开，仍要审批', () => {
    expect(classifyToolCall('write_file', { path: `${project}/context.md` }, viaHub)).toMatchObject({ cls: 'C' });
  });

  it('沙箱开着时原生工具写项目目录：不是 A，是 blocked 的 C（指路）', () => {
    expect(classifyToolCall('write_file', { path: `${project}/index.html` }, sandboxed)).toMatchObject({ cls: 'C', blocked: true });
  });
});
