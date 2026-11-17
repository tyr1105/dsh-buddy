/**
 * 对外和系统类命令名单（P69 A3）：哪些程序不管沙箱开没开，都要主人点头。
 *
 * 为什么单独成文件：DSH 的沙箱只拦「写到工作区外」，不拦联网和起进程。连远程机器、推代码、发布上线、
 * 动云端资源、调别的应用、改系统设置这些事，沙箱管不着，必须由我们自己的闸拦下来问主人。
 * 名单集中放在这里，一个程序一行或一组一行，以后要增删只改这一个文件。
 *
 * 判断方式：只看程序名（去掉路径后的最后一段），包在 env、sh -c、xargs、timeout 里拆开之后仍然命中。
 * 这是按名字认的，拦不住存心改名、起别名或藏进脚本里的写法（见 docs/progress/P69.md 的已知局限）。
 *
 * 标了「卡片之外补充」的行不在任务卡的表里，是同一类用途的常见程序。补进来只会多问，不会少问；
 * 觉得多余可以直接删掉那一行。
 */
import { httpieLocalOnly } from './local-address.js';

/** 审批卡要用的子类名；每个子类对应一句主人看得懂的话。 */
export type OutwardSubclass = 'remote_access' | 'git_push' | 'publish_deploy' | 'cloud_resource'
  | 'send_message' | 'system_settings' | 'global_install' | 'http_post';

/** 任务卡 A3 表的第三列：解析不出具体对象时就用这一句。 */
export const OUTWARD_SENTENCES: Readonly<Record<OutwardSubclass, string>> = {
  remote_access: '连接远程机器或向远程传文件',
  git_push: '把代码推送到远端仓库',
  publish_deploy: '发布上线或操作代码托管平台',
  cloud_resource: '操作云端资源',
  send_message: '调用其他应用、发消息或读写剪贴板',
  system_settings: '修改这台电脑的系统设置或结束其他进程',
  global_install: '安装软件',
  http_post: '向外部网址发送数据',
};

/** 写进审批记录的理由（分类器的话，不是给主人看的第一句）。已有的三句保持原文不动。 */
const REASONS: Readonly<Record<OutwardSubclass, string>> = {
  remote_access: '连接远程机器或向远程传文件需要主人确认',
  git_push: 'git 修改仓库或远端需要审批',
  publish_deploy: '发布上线或操作代码托管平台需要主人确认',
  cloud_resource: '操作云端资源需要主人确认',
  send_message: '调用外部应用或发送消息需要审批',
  system_settings: '修改系统设置需要审批',
  global_install: '安装软件需要审批',
  http_post: '网络写请求需审批',
};

/** 名单里的一行：这些程序属于哪一类，为什么要问主人。when 不写表示任何用法都算。 */
interface OutwardRule {
  programs: readonly string[];
  subclass: OutwardSubclass;
  /** 中文说明：为什么在名单里。只给读代码的人看。 */
  why: string;
  /** 只在某些用法下才算（例如 rsync 只在带远端写法时算）。 */
  when?(args: readonly string[]): boolean;
  /**
   * 这一行里「长得像日常英文单词」的程序名（open、say、kill 这类）。
   * 它们被直接调用时照旧要确认；但出现在别的未知程序的参数里时（`foo open x`）不触发 R4 的兜底检查，免得误拦。
   */
  plainWords?: readonly string[];
}

/** 去掉选项后的操作数：粗略地把以 - 开头的词都当选项。 */
const operands = (args: readonly string[]): string[] => args.filter(arg => !arg.startsWith('-'));
/** 第一个操作数是不是这些子命令之一。 */
const firstIs = (...names: string[]) => (args: readonly string[]): boolean => names.includes(operands(args)[0] ?? '');
/** docker、podman：直接 push/login，或者 image push 这类两段式，或者构建时带 --push。 */
const containerPublishes = (args: readonly string[]): boolean => {
  const [first, second] = operands(args);
  return ['push', 'login'].includes(first ?? '') || (['image', 'compose', 'manifest', 'plugin', 'buildx'].includes(first ?? '') && second === 'push') || args.includes('--push');
};
/**
 * httpie、xh：只有明明白白写了 GET、后面又没带要发送的数据项，才算只读。
 * 没写方法的不算：这类工具只要带了数据项或从管道读到内容，就会自己改用 POST，静态看不出来。
 */
const sendsOverHttp = (args: readonly string[]): boolean => {
  const words = operands(args);
  const explicitGet = /^get$/i.test(words[0] ?? '') && words.length > 1;
  // 数据项的三种写法：key=value、key:=json、key@file；key==value 是查询参数，不算发送数据。
  const hasDataItem = words.slice(2).some(word => /^[^=:@/?&]+(?::=|=(?!=)|@)/.test(word));
  const bodyOption = args.some(arg => /^--(?:form|multipart|raw|json|data)/.test(arg) || arg === '-f');
  return !explicitGet || hasDataItem || bodyOption;
};

/**
 * 名单本体。一个程序一行或一组一行。
 * 顺序没有含义；同一个程序名不要出现在两行里。
 */
const RULES: readonly OutwardRule[] = [
  // —— 连接远程机器或向远程传文件 ——
  { programs: ['ssh'], subclass: 'remote_access', why: '登录远程机器并在上面执行命令' },
  { programs: ['scp', 'sftp'], subclass: 'remote_access', why: '和远程机器之间传文件' },
  { programs: ['ftp', 'lftp'], subclass: 'remote_access', why: '和 FTP 服务器之间传文件' },
  { programs: ['telnet'], subclass: 'remote_access', why: '明文登录远程机器' },
  { programs: ['nc', 'ncat', 'netcat', 'socat'], subclass: 'remote_access', why: '能向任意主机和端口收发数据' },
  { programs: ['rsync'], subclass: 'remote_access', why: '操作数带冒号时是在和远程机器同步文件', when: args => operands(args).some(arg => arg.includes(':')) },
  { programs: ['ssh-copy-id', 'mosh', 'autossh', 'rsh', 'rlogin', 'rcp', 'tftp', 'sshpass', 'sshfs'], subclass: 'remote_access', why: '卡片之外补充：同样是登录远程机器或向远程传文件' },
  { programs: ['ssh-add', 'ssh-keyscan', 'ssh-keygen'], subclass: 'remote_access', why: '卡片之外补充：和 ssh 密钥代理打交道，或向远程主机取公钥' },
  // A-3b：eval "$(ssh-agent -s)" 是 ssh 文档里的标准开头，只是在本机起一个存钥匙的后台进程，不连任何远程；带了别的参数（比如顺手运行一条命令）才算。
  { programs: ['ssh-agent'], subclass: 'remote_access', why: '卡片之外补充：ssh 密钥代理带了 -s、-c、-k 以外的用法', when: args => args.some(arg => !['-s', '-c', '-k'].includes(arg)) },
  { programs: ['rclone', 'gsutil', 's3cmd'], subclass: 'remote_access', why: '卡片之外补充：和云端存储之间同步文件' },
  { programs: ['psql', 'mysql', 'redis-cli', 'mongosh', 'mongo'], subclass: 'remote_access', why: '卡片之外补充：连上数据库服务后能直接改里面的真实数据' },

  // —— 发布上线或操作代码托管平台 ——
  { programs: ['gh', 'glab'], subclass: 'publish_deploy', why: '直接操作 GitHub、GitLab 上的仓库、合并请求和发布' },
  { programs: ['twine'], subclass: 'publish_deploy', why: '把 Python 包发布到公共仓库' },
  { programs: ['vercel', 'vc', 'netlify', 'firebase', 'heroku', 'wrangler', 'flyctl', 'surge'], subclass: 'publish_deploy', why: '把网站或服务部署到线上', plainWords: ['surge'] },
  { programs: ['docker'], subclass: 'publish_deploy', why: '推送镜像或登录镜像仓库', when: containerPublishes },
  { programs: ['gem'], subclass: 'publish_deploy', why: '发布 Ruby 包（yank、owner、signin 是卡片之外补充）', when: firstIs('push', 'yank', 'owner', 'signin') },
  { programs: ['cargo'], subclass: 'publish_deploy', why: '发布 Rust 包（yank、owner、login 是卡片之外补充）', when: firstIs('publish', 'yank', 'owner', 'login') },
  { programs: ['podman'], subclass: 'publish_deploy', why: '卡片之外补充：和 docker 同样的推送镜像、登录仓库', when: containerPublishes },
  { programs: ['fly', 'railway', 'serverless', 'sls'], subclass: 'publish_deploy', why: '卡片之外补充：同样是把服务部署到线上' },
  // A-3（R2）复查补充：官方文档里常见的其他部署工具。
  { programs: ['amplify', 'cdk', 'sam', 'gh-pages', 'deployctl', 'eas', 'swa'], subclass: 'publish_deploy', why: '复查补充：同样是把网站、应用或云函数部署到线上' },
  // A-3（R3）复查补充：这些包管理工具的 publish 子命令把软件包发到公共仓库，和 twine upload、npm publish 是同一种收不回来的动作。
  { programs: ['uv', 'poetry', 'hatch', 'flit', 'pdm', 'deno', 'lerna'], subclass: 'publish_deploy', why: '复查补充：把软件包发布到公共仓库', when: firstIs('publish') },

  // —— 操作云端资源（删除类另有规则，保持 D）——
  { programs: ['aws', 'gcloud', 'az'], subclass: 'cloud_resource', why: '三大云厂商的命令行，能增删改云上的任何资源' },
  { programs: ['kubectl', 'helm'], subclass: 'cloud_resource', why: '操作 Kubernetes 集群里正在运行的服务' },
  { programs: ['terraform', 'pulumi'], subclass: 'cloud_resource', why: '按配置批量创建或销毁云端资源' },
  { programs: ['doctl'], subclass: 'cloud_resource', why: 'DigitalOcean 的命令行' },
  { programs: ['ansible', 'ansible-playbook'], subclass: 'cloud_resource', why: '卡片之外补充：批量在远程机器上执行操作' },

  // —— 调用其他应用、发消息或读写剪贴板 ——
  { programs: ['lark-cli'], subclass: 'send_message', why: '以主人的身份发飞书消息' },
  { programs: ['osascript', 'shortcuts', 'automator'], subclass: 'send_message', why: '能驱动这台电脑上的任何应用替主人操作', plainWords: ['shortcuts'] },
  { programs: ['open'], subclass: 'send_message', why: '用系统默认应用打开文件或网址，会弹到主人面前', plainWords: ['open'] },
  { programs: ['say'], subclass: 'send_message', why: '让电脑出声', plainWords: ['say'] },
  { programs: ['mail', 'mailx', 'sendmail', 'mutt', 'msmtp'], subclass: 'send_message', why: '以主人的身份发邮件', plainWords: ['mail'] },
  { programs: ['pbcopy', 'pbpaste'], subclass: 'send_message', why: '读写系统剪贴板，里面可能有主人刚复制的密码' },

  // —— 修改这台电脑的系统设置或结束其他进程 ——
  { programs: ['defaults'], subclass: 'system_settings', why: '读写 macOS 和各应用的偏好设置' },
  { programs: ['launchctl', 'crontab', 'at', 'batch'], subclass: 'system_settings', why: '登记开机自启或定时执行的任务，回合结束后仍会运行', plainWords: ['at', 'batch'] },
  { programs: ['systemsetup', 'networksetup', 'scutil', 'pmset', 'softwareupdate'], subclass: 'system_settings', why: '改系统、网络、电源和更新设置' },
  { programs: ['spctl', 'csrutil', 'tccutil'], subclass: 'system_settings', why: '改系统安全策略和应用隐私授权' },
  { programs: ['dscl'], subclass: 'system_settings', why: '读写本机的用户和群组' },
  { programs: ['diskutil', 'hdiutil', 'mount', 'umount'], subclass: 'system_settings', why: '挂载、卸载或抹掉磁盘', plainWords: ['mount'] },
  { programs: ['shutdown', 'reboot', 'halt'], subclass: 'system_settings', why: '关机或重启这台电脑', plainWords: ['halt'] },
  { programs: ['kill', 'killall', 'pkill'], subclass: 'system_settings', why: '结束进程，可能是主人正在用的应用', plainWords: ['kill'] },

  // —— 安装软件 ——
  { programs: ['brew'], subclass: 'global_install', why: '给整台电脑安装或卸载软件' },

  // —— 向外部网址发送数据（curl、wget 另有专门规则，不在这里）——
  { programs: ['http', 'https', 'httpie', 'xh', 'xhs'], subclass: 'http_post', why: '不是明确的 GET 时会向外部网址发送数据（https、xhs 是同一工具的别名）',
    // P74r9 第 4 节：请求的地址是本机（解析后的主机名判断）时不算向外部网址发送数据。
    when: args => sendsOverHttp(args) && !httpieLocalOnly(args), plainWords: ['http'] },
];

/**
 * 沙箱管不到的程序（卡片之外补充）：它们自己不写文件，而是让沙箱外早就在跑的常驻进程替它办事。
 * 例如 docker 把活交给后台的守护进程，守护进程可以把主人的任何目录挂进容器里改；tmux、screen 可以往沙箱外的终端里敲命令。
 * 「沙箱是墙」对它们不成立，所以沙箱开着时也照旧要主人确认，不享受「看不懂也放行」。
 */
export const SANDBOX_ESCAPE_PROGRAMS: readonly string[] = ['docker', 'podman', 'nerdctl', 'colima', 'limactl', 'multipass', 'vagrant', 'tmux', 'screen'];
/** 上面这类程序留在审批里的理由。 */
export const SANDBOX_ESCAPE_REASON = '这个程序会让沙箱外的常驻进程替它办事，沙箱管不到，需要主人确认';

/** 提权命令：一律 D，永远要主人批准。su 是 P69 补进来的。 */
export const PRIVILEGE_PROGRAMS: readonly string[] = ['sudo', 'doas', 'su'];
/** 钥匙串命令行：直接拒绝，不问主人。security 也是日常英文单词，所以它同样不触发 R4 的兜底检查（见 isPlainWordProgram）。 */
export const KEYCHAIN_PROGRAMS: readonly string[] = ['security'];
/** 钥匙串命令被拒绝时给队友看的理由。 */
export const KEYCHAIN_REASON = '不能读取钥匙串里的凭据';
/** git credential 和凭据助手（git-credential-osxkeychain、docker-credential-desktop 等）被拒绝时的理由。 */
export const CREDENTIAL_HELPER_REASON = '不能读取保存的凭据';
/** 凭据助手程序名（A-3b，T4 第 3 项）：它们被直接调用就能把钥匙串里保存的登录凭据读出来，和 git credential 一样直接拒绝。 */
export const isCredentialHelper = (cmd: string): boolean => /^(?:git|docker)-credential-/.test(cmd);

/** 按程序名建索引，查找时不用每次扫整张表。 */
const INDEX = new Map<string, OutwardRule>(RULES.flatMap(rule => rule.programs.map(program => [program, rule] as const)));

/** 长得像日常英文单词的程序名：来自 RULES 里标了 plainWords 的行，再加上 security（钥匙串命令）。 */
const PLAIN_WORDS = new Set<string>([...RULES.flatMap(rule => rule.plainWords ?? []), ...KEYCHAIN_PROGRAMS]);
/** R4 的兜底检查用：这个程序名是不是日常单词。是的话，它出现在未知程序的参数里时不算「被包住的命令」。 */
export function isPlainWordProgram(name: string): boolean {
  return PLAIN_WORDS.has(name);
}

/**
 * 包执行器（npx、pnpm dlx、bunx、uvx、pipx run 等）里的「包名对应哪个程序」小表（A-3，R2）。
 * 官方文档给的部署命令常写包名而不是程序名：npx netlify-cli deploy 跑的是 netlify。
 * 一行一个；查不到的包名就当程序名本身。
 */
const PACKAGE_PROGRAMS: Readonly<Record<string, string>> = {
  'netlify-cli': 'netlify',
  'firebase-tools': 'firebase',
  '@railway/cli': 'railway',
  '@vercel/cli': 'vercel',
  '@cloudflare/wrangler': 'wrangler',
  '@aws-amplify/cli': 'amplify',
  'aws-cdk': 'cdk',
  '@azure/static-web-apps-cli': 'swa',
  // 同样是官方包名和程序名不一样的常见部署工具。
  'aws-sam-cli': 'sam',
  'eas-cli': 'eas',
};
/**
 * 把包执行器后面的第一个词规范成程序名：去掉 @版本（vercel@latest 变成 vercel，@scope/name@1.2 变成 @scope/name），
 * 再查上面的小表。不是包名的写法（带路径、带空格）原样返回。
 */
export function normalizePackageProgram(word: string): string {
  if (!word || (word.includes('/') && !word.startsWith('@'))) return word;
  const at = word.lastIndexOf('@');
  const bare = at > 0 ? word.slice(0, at) : word;
  return PACKAGE_PROGRAMS[bare.toLowerCase()] ?? bare;
}

/**
 * 包管理器里会改动公共仓库上的账号、归属和标签的子命令（卡片之外补充）。
 * 任务卡说沙箱里 npm 系只留 publish、unpublish 要批准；这几个同样是对外、收不回来的动作，所以照旧要主人确认。
 */
export const REGISTRY_SUBCOMMANDS: readonly string[] = ['login', 'logout', 'adduser', 'token', 'owner', 'access', 'dist-tag', 'deprecate', 'undeprecate', 'team', 'org', 'hook', 'profile', 'star', 'unstar'];

/** 各包管理器自己的子命令：子命令位置上出现这些词，说明不是在运行本地装的程序。 */
const OWN_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  yarn: ['install', 'add', 'remove', 'up', 'upgrade', 'upgrade-interactive', 'run', 'exec', 'dlx', 'init', 'config', 'cache', 'info', 'why', 'list', 'ls', 'outdated', 'audit', 'publish', 'npm', 'workspace', 'workspaces', 'version', 'link', 'unlink', 'pack', 'import', 'global', 'bin', 'check', 'licenses', 'owner', 'tag', 'team', 'login', 'logout', 'test', 'create', 'set', 'plugin', 'node', 'rebuild', 'patch', 'constraints', 'dedupe', 'explain', 'search', 'stage', 'unplug'],
  pnpm: ['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade', 'run', 'run-script', 'exec', 'dlx', 'create', 'init', 'test', 't', 'start', 'build', 'rebuild', 'list', 'ls', 'll', 'outdated', 'why', 'publish', 'pack', 'link', 'ln', 'unlink', 'deploy', 'audit', 'config', 'c', 'store', 'env', 'fetch', 'import', 'prune', 'dedupe', 'licenses', 'patch', 'patch-commit', 'setup', 'root', 'bin', 'cache', 'doctor', 'self-update', 'approve-builds', 'login', 'logout'],
  bun: ['install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'upgrade', 'run', 'x', 'create', 'init', 'test', 'build', 'link', 'unlink', 'pm', 'publish', 'repl', 'outdated', 'audit', 'patch', 'why', 'info', 'completions', 'bunx'],
};
/** 各包管理器自己带值的选项：值是下一个词，找子命令时要连值一起跳过。 */
const OWN_VALUE_OPTIONS: readonly string[] = ['--filter', '-F', '--dir', '-C', '--cwd', '--prefix', '--reporter', '--loglevel', '--config', '-c', '--network-timeout', '--registry'];
/**
 * A-3b（T3）：yarn、pnpm、bun 会把不认识的子命令当成本地装的程序来运行（pnpm wrangler deploy）。
 * 子命令位置那个词（yarn run、bun run 后面的第一个词也算；pnpm --filter 名字 之后的第一个词也算）
 * 如果不是包管理器自己的子命令，就当程序名：规范化后查对外名单，命中返回对外动作，没命中返回 null。
 * 日常英文单词的程序名（open 等）不触发；只看子命令位置，不看后面的参数。
 */
export function matchLocalProgram(manager: string, args: readonly string[]): OutwardMatch | null {
  const own = OWN_SUBCOMMANDS[manager];
  if (own === undefined) return null;
  // 跳过选项（带值的连值一起跳过），停在第一个非选项词。
  const skipOptions = (from: number): number => {
    let at = from;
    while (at < args.length && args[at]!.startsWith('-')) at += !args[at]!.includes('=') && OWN_VALUE_OPTIONS.includes(args[at]!) ? 2 : 1;
    return at;
  };
  let at = skipOptions(0);
  // yarn workspace 名字 命令：名字之后才是子命令位置。
  if (manager === 'yarn' && args[at] === 'workspace') at = skipOptions(at + 2);
  // yarn run、bun run 后面的第一个词按程序名看（它们会去找本地装的程序）；pnpm run 只跑脚本，不在此列。
  else if (args[at] === 'run' && manager !== 'pnpm') at = skipOptions(at + 1);
  else if (own.includes(args[at] ?? '')) return null;
  const word = args[at];
  if (word === undefined || own.includes(word)) return null;
  const program = posixBasenameLower(normalizePackageProgram(word));
  if (isPlainWordProgram(program)) return null;
  return matchOutward(program, args.slice(at + 1));
}
const posixBasenameLower = (word: string): string => word.slice(word.lastIndexOf('/') + 1).toLowerCase();

/** 对象只允许这些字符：来自队友写的命令，要原样显示给主人，不能夹带换行、中文或看起来像指令的句子。 */
const SAFE_OBJECT = /^[A-Za-z0-9._@:/+=-]{1,80}$/;
/** 清洗一个要显示给主人的对象；不合格就不显示。 */
export function safeObject(value: string | undefined | null): string | undefined {
  return value !== undefined && value !== null && SAFE_OBJECT.test(value) ? value : undefined;
}
/** 从网址取域名；写不成网址的返回 undefined。 */
export function hostOfUrl(value: string): string | undefined {
  try {
    const host = new URL(value).hostname;
    return /^[A-Za-z0-9.-]{1,80}$/.test(host) || /^\[[0-9a-fA-F:.]{2,45}\]$/.test(host) ? host : undefined;
  } catch { return undefined; }
}

/** ssh 这类命令里带值的短选项：值是下一个词，不能被当成主机名。 */
const SSH_VALUE_FLAGS = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-P', '-Q', '-R', '-S', '-W', '-w']);
/** 参数写法里能直接看出主机名的程序；其余（比如 socat 的地址写法）只显示程序名，不去猜。 */
const HOST_FIRST_PROGRAMS = new Set(['ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp', 'lftp', 'nc', 'ncat', 'netcat', 'mosh', 'autossh', 'rsh', 'rlogin', 'rcp', 'ssh-copy-id', 'tftp']);
/** 取出要连的主机：user@host:path 里的 host，或者第一个像主机名的操作数。 */
function remoteHost(cmd: string, args: readonly string[]): string | undefined {
  if (!HOST_FIRST_PROGRAMS.has(cmd)) return undefined;
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith('-')) { if (SSH_VALUE_FLAGS.has(arg)) index++; continue; }
    words.push(arg);
  }
  const copies = ['scp', 'rsync', 'sftp', 'rcp'].includes(cmd);
  // 传文件的命令：带冒号的那个操作数才是远端；登录的命令：第一个操作数就是主机。
  const target = copies ? words.find(word => word.includes(':') || word.includes('@')) ?? (cmd === 'sftp' ? words[0] : undefined) : words[0];
  if (target === undefined) return undefined;
  const afterUser = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target;
  const host = afterUser.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[:/]/)[0];
  return host !== undefined && /^[A-Za-z0-9.-]{1,80}$/.test(host) && !/^\d+$/.test(host) ? host : undefined;
}
/** httpie、xh 的网址：可以不写协议，按 http 补上再取域名。 */
function httpieHost(args: readonly string[]): string | undefined {
  for (const word of operands(args)) {
    if (/^[A-Za-z]+$/.test(word)) continue;
    if (/^[^=@]+(?::?=|@)/.test(word) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) continue;
    return hostOfUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(word) ? word : `http://${word.replace(/^:/, 'localhost:')}`);
  }
  return undefined;
}

export interface OutwardMatch {
  subclass: OutwardSubclass;
  reason: string;
  /** 给审批卡带上的对象（已清洗）；解析不出来就没有。 */
  detail?: string;
}

/**
 * 这条命令是不是名单里的对外或系统类命令。cmd 是去掉路径后的程序名，args 是它的参数。
 * 命中返回子类、理由和对象；没命中返回 null（git push、curl、wget 由各自的专门规则处理）。
 */
export function matchOutward(cmd: string, args: readonly string[]): OutwardMatch | null {
  const rule = INDEX.get(cmd);
  if (!rule || (rule.when && !rule.when(args))) return null;
  let detail: string | undefined;
  if (rule.subclass === 'remote_access') {
    const host = remoteHost(cmd, args);
    // 例：「ssh 到 build.example.com」。解析不出主机就只带程序名。
    detail = host === undefined ? safeObject(cmd) : `${cmd} 到 ${host}`;
  } else if (rule.subclass === 'http_post') detail = httpieHost(args);
  else detail = safeObject(cmd);
  return { subclass: rule.subclass, reason: REASONS[rule.subclass], ...(detail === undefined ? {} : { detail }) };
}

/** git push 的对象：远端名和分支，例如「origin main」；什么都没写就没有对象。 */
export function gitPushDetail(tail: readonly string[]): string | undefined {
  const words = operands(tail).map(word => safeObject(word)).filter((word): word is string => word !== undefined).slice(0, 3);
  return words.length ? words.join(' ') : undefined;
}

/** 调别的应用、发消息、读写剪贴板三种情况，各用一句更贴切的话。 */
const SEND_LABELS: Readonly<Record<string, string>> = {
  'lark-cli': '发消息', mail: '发消息', mailx: '发消息', sendmail: '发消息', mutt: '发消息', msmtp: '发消息',
  pbcopy: '读写剪贴板', pbpaste: '读写剪贴板', git: '发邮件',
  // P74r18a：open 加一条专门说法（原来写成「调用其他应用（open）」）。
  open: '用默认应用打开文件或网址',
};
/** 结束进程、关机重启两种情况，各用一句更贴切的话。 */
const SYSTEM_LABELS: Readonly<Record<string, string>> = {
  kill: '结束其他进程', killall: '结束其他进程', pkill: '结束其他进程',
  shutdown: '关机或重启这台电脑', reboot: '关机或重启这台电脑', halt: '关机或重启这台电脑',
};

/**
 * A-5（P2）：「发布上线」这一类按程序说得更具体。表里没有的程序保持笼统的「发布上线或操作代码托管平台」。
 * 包管理器（npm、pnpm、yarn、bun）走到这一类，只会是账号和权限类子命令（login、token、owner 等）：publish 是 D 类，另有说法。
 */
const DEPLOY_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['vercel', 'vc', 'netlify', 'firebase', 'heroku', 'wrangler', 'flyctl', 'fly', 'surge', 'railway', 'serverless', 'sls',
    'amplify', 'cdk', 'sam', 'gh-pages', 'deployctl', 'eas', 'swa'].map(name => [name, '把网站或服务部署到线上'])),
  gh: '操作代码托管平台上的仓库、合并请求或发布', glab: '操作代码托管平台上的仓库、合并请求或发布',
  ...Object.fromEntries(['twine', 'gem', 'cargo', 'uv', 'poetry', 'hatch', 'flit', 'pdm', 'deno', 'lerna'].map(name => [name, '把软件包发布到公共仓库'])),
  docker: '推送镜像或登录镜像仓库', podman: '推送镜像或登录镜像仓库',
  ...Object.fromEntries(['npm', 'pnpm', 'yarn', 'bun'].map(name => [name, '操作软件包仓库上的账号或权限'])),
};

/**
 * A-5（P1）：D 类（不可逆）每一种理由给主人看的话。分类器的 reason 不改（日志、越界记录在用），
 * 审批卡靠 hint 标记查这张表。system_write 和 delete 后面还会接路径，由调用方补；这里是不带路径时的整句。
 * 新增一种 D 而忘了配话：hint 是必填的类型，且有测试检查这张表覆盖了每一种标记。
 */
export const DANGER_SENTENCES: Readonly<Record<'git_force' | 'publish_package' | 'elevate' | 'payment' | 'remote_delete' | 'system_write' | 'delete', string>> = {
  git_force: '强制覆盖或删除远端仓库里的分支（不可逆）',
  publish_package: '把软件包发布到公共仓库，或撤回已发布的版本（不可逆）',
  elevate: '用管理员权限运行命令',
  payment: '调用支付、下单或转账接口',
  remote_delete: '删除云端或代码托管平台上的资源（不可逆）',
  system_write: '往系统目录里写文件',
  delete: '删除家目录以外的内容（不可逆）',
};

/** 是不是名单里的子类名。 */
export function isOutwardSubclass(value: string | undefined): value is OutwardSubclass {
  return value !== undefined && Object.prototype.hasOwnProperty.call(OUTWARD_SENTENCES, value);
}

/**
 * 把子类和对象拼成给主人看的一句话。
 * 例：把代码推送到远端仓库（origin main）、向 example.com 发送数据、连接远程机器（ssh 到 build.example.com）、调用其他应用（osascript）；
 * P74r18a 起「调用其他应用、发消息、读写剪贴板」「结束进程、关机重启」两张表里查得到说法的命令不再附命令名：
 * 结束其他进程、用默认应用打开文件或网址、发消息；发布上线（vercel、gh 等）仍写「说法（名称）」。
 * 这句话里只放子类的说法和清洗过的对象，不放原始命令。
 */
export function outwardSentence(subclass: OutwardSubclass, detail?: string, download = false): string {
  if (subclass === 'http_post') {
    // 只是把内容取回来存成文件时，不能说成「发送数据」。
    if (download) return detail ? `从 ${detail} 下载文件` : '从外部网址下载文件';
    return detail ? `向 ${detail} 发送数据` : OUTWARD_SENTENCES.http_post;
  }
  if (detail === undefined) return OUTWARD_SENTENCES[subclass];
  if (subclass === 'remote_access') return detail.includes(' 到 ') ? `连接远程机器（${detail}）` : `${OUTWARD_SENTENCES.remote_access}（${detail}）`;
  // P74r18a：命令在这两张对照表里查得到专门说法时只写说法，不再附英文命令名；没有专门说法的保持「说法（命令名）」。
  if (subclass === 'send_message') { const label = SEND_LABELS[detail]; return label ?? `调用其他应用（${detail}）`; }
  if (subclass === 'system_settings') { const label = SYSTEM_LABELS[detail]; return label ?? `修改这台电脑的系统设置（${detail}）`; }
  // 发布上线那张表：括号里是平台或工具的名字，主人据此知道发到哪里，保持原写法。
  if (subclass === 'publish_deploy') return `${DEPLOY_LABELS[detail] ?? OUTWARD_SENTENCES.publish_deploy}（${detail}）`;
  return `${OUTWARD_SENTENCES[subclass]}（${detail}）`;
}
