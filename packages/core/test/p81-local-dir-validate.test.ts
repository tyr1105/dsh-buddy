/**
 * P81 第 1 节的测试：约定里「发布到本机的哪个文件夹」（launch.localDir）的校验。
 * P81r1 第 3.2、3.5 节收紧之后同步改写：第一级白名单、应用程序包、每段名字的字符、逗号断句与服务器分句。
 *
 * 覆盖：
 * 1 每条规则各一个被拒的例子，拒绝文字逐字；
 * 2 能用的例子：任务卡点名的三个放行例子，以及带中文、空格、末尾斜线的；
 * 3 大小写不同的写法视为同一处；~/Desktop/site 与 ~/Desktop/site-2 不互相算「之内」；
 * 4 NFD 写法的中文路径与 NFC 写法视为同一处；
 * 5 「明显是本机位置」的判断：三句不算、既有会被拒的写法仍然被拒、旧的三句仍算。
 * 纯函数测试：校验不读磁盘，环境（主目录、必须避开的目录）由测试自己给出。
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_DIR_MISSING_REFUSAL, checkLocalDir, foldSegment, howNamesLocalPlace, localDirRefusal, localDirShown, segmentsWithin, type LocalDirEnv } from '../src/project/local-dir.js';

const HOME = '/Users/owner';
/** 测试用的环境：主目录、中心数据目录（含员工文件夹、共享文件夹）、DSH 数据目录。 */
const env: LocalDirEnv = {
  homes: [HOME],
  protectedRoots: [`${HOME}/Documents/中心`, `${HOME}/Documents/中心/bots`, `${HOME}/Documents/中心/shared`, `${HOME}/.dsh`],
};
/** 拒绝文字里 {原因} 之后的固定部分（逐字抄自任务卡，不引用代码里的常量）。 */
const TAIL = '。能用的位置是主人主目录下的一个具体文件夹，至少两级，例如 ~/Desktop/活动页面；不能是主目录或桌面这类目录本身，不能是隐藏目录、系统目录、DSH 和员工的数据目录。位置不合适时和主人商量换一个。';
const refusal = (reason: string): string => `launch.localDir 不能用：${reason}${TAIL}`;
const CENTER = '在中心的数据目录、员工的文件夹、共享文件夹或 DSH 的数据目录之内，或者是它们的上级目录';
const FIRST = '第一级只能是 Desktop、Documents、Downloads、Sites、Public 之一';

/** 取校验失败的原因；通过时让用例失败。 */
function reasonOf(input: string, e: LocalDirEnv = env): string {
  const result = checkLocalDir(input, e);
  if (result.ok) throw new Error(`应当被拒绝但通过了：${input} -> ${result.path}`);
  return result.reason;
}

describe('1 每一条规则各一个被拒的例子，文字逐字', () => {
  const cases: Array<[string, string, string]> = [
    ['不是绝对路径', 'Desktop/上新页面', '不是完整路径（要以 / 或 ~/ 开头）'],
    ['~用户名写法不认', '~other/Desktop/x', '不是完整路径（要以 / 或 ~/ 开头）'],
    ['含 .. 这一段', '~/Desktop/../Desktop/x', '路径里含有 .. 这一段'],
    ['含换行', '~/Desktop/a\nb', '路径里含有换行、引号、反斜杠或看不见的字符'],
    ['含零宽字符', '~/Desktop/a​b', '路径里含有换行、引号、反斜杠或看不见的字符'],
    ['含双引号', '~/Desktop/a"b', '路径里含有换行、引号、反斜杠或看不见的字符'],
    ['含反斜杠', '~/Desktop/a\\b', '路径里含有换行、引号、反斜杠或看不见的字符'],
    ['超过 200 个字符', `~/Desktop/${'长'.repeat(200)}`, '路径超过 200 个字符'],
    ['不在主目录之下', '/Volumes/外置盘/Desktop/x', '不在你电脑的主目录之下'],
    ['别的用户的主目录', '/Users/other/Desktop/x', '不在你电脑的主目录之下'],
    ['就是主目录', '~', '层级不够深，需要是主目录下面至少两级的具体文件夹'],
    ['只有一级（桌面本身）', '~/Desktop', '层级不够深，需要是主目录下面至少两级的具体文件夹'],
    ['以点开头的一段（隐藏目录）', '~/Desktop/.hidden/x', '路径里有以点开头的隐藏目录'],
    ['单个点这一段', '~/Desktop/./x', '路径里有以点开头的隐藏目录'],
    // P81r1：原来「不是 Library」的黑名单换成第一级白名单，Library、Applications、Projects、go 都走这一条。
    ['第一级是 Library', '~/Library/LaunchAgents', FIRST],
    ['第一级是 Applications', '~/Applications/Foo.app/Contents', FIRST],
    ['第一级是 Projects', '~/Projects/out', FIRST],
    ['第一级是 go', '~/go/bin', FIRST],
    // P81r1：应用程序包、资料库。
    ['应用程序包 .app', '~/Documents/Foo.app/x', '不能选应用程序包或资料库里面的位置'],
    ['应用程序包 .bundle', '~/Desktop/Foo.bundle/x', '不能选应用程序包或资料库里面的位置'],
    ['应用程序包 .framework', '~/Desktop/Foo.framework/x', '不能选应用程序包或资料库里面的位置'],
    ['应用程序包 .plugin', '~/Desktop/Foo.plugin/x', '不能选应用程序包或资料库里面的位置'],
    ['照片资料库 .photoslibrary', '~/Desktop/照片.photoslibrary/x', '不能选应用程序包或资料库里面的位置'],
    // P81r1：每段名字的字符。
    ['全角斜线', '~/Desktop/a／b', '文件夹名只能包含文字、数字、空格、连字符、下划线、点和括号'],
    ['顿号与第二个文件夹', '~/Desktop/site、~/Documents', '文件夹名只能包含文字、数字、空格、连字符、下划线、点和括号'],
    ['命令替换', '~/Desktop/a$(id)', '文件夹名只能包含文字、数字、空格、连字符、下划线、点和括号'],
    ['反引号', '~/Desktop/a`id`', '文件夹名只能包含文字、数字、空格、连字符、下划线、点和括号'],
    ['问号', '~/Desktop/a?b', '文件夹名只能包含文字、数字、空格、连字符、下划线、点和括号'],
    ['一段以组合附加符开头', '~/Desktop/\u0301x', '文件夹名只能包含文字、数字、空格、连字符、下划线、点和括号'],
    ['在中心数据目录之内', '~/Documents/中心/projects/site', CENTER],
    ['在员工的文件夹之内', '~/Documents/中心/bots/b_x/work', CENTER],
    ['在 DSH 数据目录之内（隐藏目录先拒）', '~/.dsh/plugins', '路径里有以点开头的隐藏目录'],
  ];
  for (const [name, input, reason] of cases) {
    it(`${name}：被拒，原因「${reason}」，整句逐字`, () => {
      expect(reasonOf(input)).toBe(reason);
      expect(localDirRefusal(reason)).toBe(refusal(reason));
    });
  }

  it('中心数据目录的上级目录也被拒（上下两个方向都查）', () => {
    const deep: LocalDirEnv = { homes: [HOME], protectedRoots: [`${HOME}/Documents/DSH solo AGENT/hub`] };
    expect(reasonOf('~/Documents/DSH solo AGENT', deep)).toBe(CENTER);
    expect(reasonOf('~/Documents/DSH solo AGENT/hub/x', deep)).toBe(CENTER);
    // 反例：同一级的兄弟目录不受影响。
    expect(checkLocalDir('~/Documents/DSH solo AGENT 备份/x', deep)).toEqual({ ok: true, path: `${HOME}/Documents/DSH solo AGENT 备份/x` });
  });

  it('取不到主人的主目录：带 ~ 的和绝对路径都拒绝（无法核对）', () => {
    const noHome: LocalDirEnv = { homes: [], protectedRoots: [] };
    expect(reasonOf('~/Desktop/x', noHome)).toBe('取不到你电脑的主目录，无法核对这个位置');
    expect(reasonOf('/Users/owner/Desktop/x', noHome)).toBe('取不到你电脑的主目录，无法核对这个位置');
  });

  it('同时有几处不合格时只报第一处（顺序固定）：含 .. 且在主目录之外，先报 ..', () => {
    expect(reasonOf('/Volumes/x/../y')).toBe('路径里含有 .. 这一段');
  });
});

describe('2 能用的例子', () => {
  it('任务卡点名的三个放行例子', () => {
    expect(checkLocalDir('~/Desktop/上新页面', env)).toEqual({ ok: true, path: `${HOME}/Desktop/上新页面` });
    expect(checkLocalDir('~/Documents/site (2)', env)).toEqual({ ok: true, path: `${HOME}/Documents/site (2)` });
    expect(checkLocalDir('~/Downloads/out_v1.2', env)).toEqual({ ok: true, path: `${HOME}/Downloads/out_v1.2` });
  });
  it('带中文和空格的路径、末尾带斜线、多余的斜线：整理后通过', () => {
    expect(checkLocalDir('~/Desktop/我的 活动/上新 页面', env)).toEqual({ ok: true, path: `${HOME}/Desktop/我的 活动/上新 页面` });
    expect(checkLocalDir('~/Desktop//上新页面///', env)).toEqual({ ok: true, path: `${HOME}/Desktop/上新页面` });
    expect(checkLocalDir('  /Users/owner/Documents/发布/page/  ', env)).toEqual({ ok: true, path: `${HOME}/Documents/发布/page` });
  });
  it('五个第一级都能用；半角与全角括号、点、连字符、下划线都可以', () => {
    for (const level of ['Desktop', 'Documents', 'Downloads', 'Sites', 'Public']) {
      expect(checkLocalDir(`~/${level}/a (b)（c）/d.e-f_g`, env)).toMatchObject({ ok: true });
    }
  });
  it('显示路径：主目录之下写成 ~ 开头；不在主目录之下或取不到主目录时显示完整路径', () => {
    expect(localDirShown('/Users/owner/Desktop/上新页面', HOME)).toBe('~/Desktop/上新页面');
    expect(localDirShown('/Users/OWNER/desktop/x', HOME)).toBe('~/desktop/x');
    expect(localDirShown('/Volumes/x/y', HOME)).toBe('/Volumes/x/y');
    expect(localDirShown('/Users/owner/Desktop/x', undefined)).toBe('/Users/owner/Desktop/x');
    // 反例：主目录名只是前缀相同（owner2）不算在主目录之下。
    expect(localDirShown('/Users/owner2/Desktop/x', HOME)).toBe('/Users/owner2/Desktop/x');
  });
});

describe('3 大小写与「之内」的判断按路径的段比较', () => {
  it('~/desktop/x 与 ~/Desktop/x 视为同一处；~/library/x 被拒（第一级不在名单里）', () => {
    expect(segmentsWithin('/Users/owner/desktop/x', '/Users/owner/Desktop/x')).toBe(true);
    expect(segmentsWithin('/Users/owner/Desktop/x', '/Users/owner/desktop/X')).toBe(true);
    expect(checkLocalDir('~/desktop/x', env)).toEqual({ ok: true, path: '/Users/owner/desktop/x' });
    expect(reasonOf('~/library/x')).toBe(FIRST);
    expect(reasonOf('~/LIBRARY/x')).toBe(FIRST);
    // 主目录的大小写写法不同也认得出来。
    expect(checkLocalDir('/users/OWNER/Desktop/x', env)).toEqual({ ok: true, path: '/users/OWNER/Desktop/x' });
  });
  it('大小写不同的写法也撞得上必须避开的目录', () => {
    expect(reasonOf('~/documents/中心/BOTS/x')).toBe(CENTER);
  });
  it('~/Desktop/site 与 ~/Desktop/site-2 不互相算作「之内」', () => {
    expect(segmentsWithin('/Users/owner/Desktop/site-2', '/Users/owner/Desktop/site')).toBe(false);
    expect(segmentsWithin('/Users/owner/Desktop/site', '/Users/owner/Desktop/site-2')).toBe(false);
    expect(segmentsWithin('/Users/owner/Desktop/site/a/b', '/Users/owner/Desktop/site')).toBe(true);
    // 必须避开的目录是 site 时，site-2 不被误伤；site 之内的被拒。
    const guarded: LocalDirEnv = { homes: [HOME], protectedRoots: [`${HOME}/Desktop/site`] };
    expect(checkLocalDir('~/Desktop/site-2/x', guarded).ok).toBe(true);
    expect(reasonOf('~/Desktop/site/x', guarded)).toBe(CENTER);
  });
  it('折叠写法：把长 s（ſ）、开尔文符号这类不分大小写的文件系统会当成普通字母的写法也折叠掉', () => {
    expect(foldSegment('ſhared')).toBe(foldSegment('shared'));
    expect(foldSegment('Key')).toBe(foldSegment('key'));
    expect(reasonOf('~/Documents/中心/ſhared/x')).toBe(CENTER);
  });
});

describe('4 NFD 与 NFC 写法的中文路径视为同一处', () => {
  const nfc = '/Users/owner/Desktop/上新é页面';
  const nfd = nfc.normalize('NFD');
  it('两种写法不是同一个字符串，但视为同一处', () => {
    expect(nfd).not.toBe(nfc);
    expect(segmentsWithin(nfd, nfc)).toBe(true);
    expect(segmentsWithin(nfc, nfd)).toBe(true);
  });
  it('必须避开的目录用 NFC 写、路径用 NFD 写，同样被拦；主目录同理', () => {
    const guarded: LocalDirEnv = { homes: [HOME], protectedRoots: ['/Users/owner/Desktop/é共享'] };
    expect(reasonOf('/Users/owner/Desktop/é共享/x'.normalize('NFD'), guarded)).toBe(CENTER);
    const accentHome: LocalDirEnv = { homes: ['/Users/émile'], protectedRoots: [] };
    expect(checkLocalDir('/Users/émile/Desktop/x'.normalize('NFD'), accentHome).ok).toBe(true);
  });
});

describe('5 第 1 节第 5 条：发布方式明显写的是本机位置、却没有填 localDir', () => {
  const ctx = { ownerHome: HOME, settings: { rootDir: `${HOME}/AgentHub` } } as unknown as Parameters<typeof howNamesLocalPlace>[1];
  it('拒绝文字逐字', () => {
    expect(LOCAL_DIR_MISSING_REFUSAL).toBe('发布方式写的是主人电脑上的位置，要把那个文件夹填进 launch.localDir（完整路径，可以用 ~ 表示主目录），主人确认约定时会看到它。位置说得不具体时先问主人。发布到本机临时文件夹（/tmp 之下）或项目文件夹的不用填。');
  });
  it('三种「明显是本机位置」各一例', () => {
    // 1 以 ~ 开头的路径
    expect(howNamesLocalPlace('复制到 ~/Desktop/活动页面', ctx)).toBe(true);
    // 2 以主人主目录开头的路径
    expect(howNamesLocalPlace('复制到 /Users/owner/Documents/活动页面', ctx)).toBe(true);
    // 3 桌面、我电脑、我的电脑、本机，加同一句里的文件夹或目录
    expect(howNamesLocalPlace('复制到桌面上的活动页面文件夹', ctx)).toBe(true);
    expect(howNamesLocalPlace('放进我电脑的一个目录', ctx)).toBe(true);
    expect(howNamesLocalPlace('放到我的电脑里的新文件夹', ctx)).toBe(true);
    expect(howNamesLocalPlace('复制到本机的上新目录', ctx)).toBe(true);
  });
  it('不触发：/tmp 之下、项目文件夹之下、网址、服务器上的路径', () => {
    expect(howNamesLocalPlace('复制到 /tmp/site', ctx)).toBe(false);
    expect(howNamesLocalPlace('发布到本机临时文件夹 /tmp/site', ctx)).toBe(false);
    expect(howNamesLocalPlace('复制到 /Users/owner/AgentHub/projects/prj_1/dist 之下的本机目录', ctx)).toBe(false);
    expect(howNamesLocalPlace('发到 https://example.com/site/index.html', ctx)).toBe(false);
    expect(howNamesLocalPlace('上传到服务器的 /var/www/site', ctx)).toBe(false);
    expect(howNamesLocalPlace('发到内网演示地址，把地址发给你', ctx)).toBe(false);
    expect(howNamesLocalPlace('约 ~5 分钟后上线到内网', ctx)).toBe(false);
  });
  it('P81r1：单独一个 ~ 当作「大约」、波浪号连接两个词，都不算位置', () => {
    expect(howNamesLocalPlace('周一~周五同步到网站', ctx)).toBe(false);
    expect(howNamesLocalPlace('约 ~ 5 分钟后上线', ctx)).toBe(false);
    expect(howNamesLocalPlace('发布到 ~/Desktop/out', ctx)).toBe(true);
  });
  it('P81r1：逗号也断句，含服务器、云端、远程的分句不算', () => {
    expect(howNamesLocalPlace('部署到服务器的 /var/www 目录，本机不保留副本', ctx)).toBe(false);
    expect(howNamesLocalPlace('上传到云端目录，本机不保留副本', ctx)).toBe(false);
    expect(howNamesLocalPlace('复制到远程机器的目录，本机不保留副本', ctx)).toBe(false);
    // 反例：同一句里有「本机」加「目录」，没有远程类词，仍然算。
    expect(howNamesLocalPlace('复制到本机的目录', ctx)).toBe(true);
  });
  it('词和「文件夹」不在同一句里不触发；主目录名只是前缀相同的路径不触发', () => {
    expect(howNamesLocalPlace('先在桌面看效果。再上传到服务器的目录 /var/www/site', ctx)).toBe(false);
    expect(howNamesLocalPlace('复制到 /Users/owner2/Documents/x', ctx)).toBe(false);
  });
});
