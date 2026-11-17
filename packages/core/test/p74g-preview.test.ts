/**
 * P74g 的测试：打开预览前的校验（job/preview.ts 的 jobPreviewTarget 与 localPreviewUrl；真正打开在宿主一侧，见插件测试）。
 *
 * 重点是安全：预览入口来自员工写的交回记录，主人点一下「打开预览」宿主就会打开 core 返回的目标。
 * 文件：每一种越出主题文件夹的写法各有一条反例；地址：补充要求第 1 节第 2 点列出的每一种伪装写法各有一条反例，
 * 正例包括 https://localhost:3000/ 和 http://[::1]:5173/。全程断言不写任何存储。
 * 「路径与地址的检查」对照表见 docs/progress/P74g.md。
 */
import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { PREVIEW_FILE_GONE_TEXT, PREVIEW_URL_REFUSED_TEXT, jobPreviewTarget, localPreviewUrl } from '../src/job/preview.js';
import { PNG, registerCleanup, setup, storeSnapshot, type Env } from './p74g-fixtures.js';

registerCleanup();

/** 记一次交回，预览入口写成 preview（这一步是测试在准备数据，不算命令的写入），再检查。 */
async function check(s: Env, preview: string | null) {
  s.submit({ preview });
  return jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' });
}

/** 先准备好数据，再拍快照、执行命令、比较快照：命令本身没有写任何存储。 */
async function checkReadOnly(s: Env, preview: string | null) {
  s.submit({ preview });
  const before = storeSnapshot(s.ctx);
  const result = await jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' });
  expect(storeSnapshot(s.ctx), String(preview)).toBe(before);
  return result;
}

/** 文件反例：返回固定说法，并且没有写任何存储。 */
async function expectFileRefused(s: Env, preview: string): Promise<void> {
  expect(await checkReadOnly(s, preview), JSON.stringify(preview)).toEqual({ ok: false, error: PREVIEW_FILE_GONE_TEXT });
}

describe('1 文件：正例', () => {
  it('主题文件夹里的 .html、.htm（含大写）：返回预览副本里的同名文件（P74r4b 起不再返回原文件）；全程不写存储', async () => {
    const s = setup();
    for (const name of ['index.html', 'old.htm', 'BIG.HTML', '带 空格.html']) s.write(`交付/${name}`, '<html>页面</html>');
    for (const name of ['index.html', 'old.htm', 'BIG.HTML', '带 空格.html']) {
      const result = await checkReadOnly(s, `交付/${name}`);
      expect(result.ok, name).toBe(true);
      const data = (result as { data: { kind: string; path: string } }).data;
      // 预期已改：原来是 join(s.jobDir, '交付', name)；现在是 <中心数据目录>/.hub/preview/<事项编号>/<随机串>/<name>，内容相同。
      expect(data.kind).toBe('file');
      expect(data.path.startsWith(join(s.root, '.hub', 'preview', 'job_0000000001') + '/'), name).toBe(true);
      expect(data.path.endsWith(`/${name}`), name).toBe(true);
      expect(nodeFs.readFileSync(data.path, 'utf8'), name).toBe('<html>页面</html>');
    }
  });
});

describe('2 文件：越出主题文件夹（每一种各一条）', () => {
  it('上级目录写法、指向同级 job_10 的写法', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.html'), '<html>外面</html>');
    nodeFs.writeFileSync(join(s.siblingDir, '交付/x.html'), '<html>兄弟</html>');
    s.write('交付/index.html', '<html>页面</html>');
    for (const preview of ['../../../../../outside/x.html', '../job_0000000010/交付/x.html', '交付/../../job_0000000010/交付/x.html', '交付/../交付/index.html']) {
      await expectFileRefused(s, preview);
    }
  });

  it('绝对路径（文件夹之外、文件夹之内）', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.html'), '<html>外面</html>');
    s.write('交付/index.html', '<html>页面</html>');
    await expectFileRefused(s, join(s.outside, 'x.html'));
    await expectFileRefused(s, join(s.jobDir, '交付/index.html'));
  });

  it('空字符、换行、回车、制表符、前后空白（文件真实存在，拒绝只能是因为这条规则）', async () => {
    const s = setup();
    s.write('交付/index.html', '<html>页面</html>');
    // 名字里真的带换行、回车、制表符的文件，以及名字前面带空格的目录（POSIX 文件系统允许）。
    for (const name of ['交付/in\ndex.html', '交付/in\rdex.html', '交付/in\tdex.html']) s.write(name, '<html>怪名字</html>');
    nodeFs.mkdirSync(join(s.jobDir, ' 交付'));
    s.write(' 交付/index.html', '<html>前面有空格</html>');
    for (const preview of ['交付/index.html\u0000', '交付/index.html\n', '\n交付/index.html', '交付/in\ndex.html', '交付/in\rdex.html', '交付/in\tdex.html', ' 交付/index.html', '交付/index.html ']) {
      await expectFileRefused(s, preview);
    }
  });

  it('符号链接：指向文件夹之外的文件、指向文件夹之内的文件、符号链接目录', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.html'), '<html>外面</html>');
    s.write('交付/真的.html', '<html>页面</html>');
    nodeFs.symlinkSync(join(s.outside, 'x.html'), join(s.jobDir, '交付/外链.html'));
    nodeFs.symlinkSync(join(s.jobDir, '交付/真的.html'), join(s.jobDir, '交付/内链.html'));
    nodeFs.symlinkSync(s.outside, join(s.jobDir, '交付/外目录'));
    for (const preview of ['交付/外链.html', '交付/内链.html', '交付/外目录/x.html']) await expectFileRefused(s, preview);
  });

  it('符号链接的名字是 .html、真实文件不是 .html：拒绝（扩展名在解析出真实路径之后再判断）', async () => {
    const s = setup();
    s.write('交付/secret.txt', '密码');
    nodeFs.symlinkSync(join(s.jobDir, '交付/secret.txt'), join(s.jobDir, '交付/看起来是网页.html'));
    await expectFileRefused(s, '交付/看起来是网页.html');
  });

  it('主题文件夹本身被换成指向别处的符号链接', async () => {
    const s = setup();
    const elsewhere = join(s.base, 'elsewhere');
    nodeFs.mkdirSync(join(elsewhere, '交付'), { recursive: true });
    nodeFs.writeFileSync(join(elsewhere, '交付/index.html'), '<html>别处</html>');
    nodeFs.rmSync(s.jobDir, { recursive: true, force: true });
    nodeFs.symlinkSync(elsewhere, s.jobDir);
    await expectFileRefused(s, '交付/index.html');
  });

  it('硬链接：文件夹里的名字其实是文件夹之外那个网页的另一个名字', async () => {
    const s = setup();
    nodeFs.writeFileSync(join(s.outside, 'x.html'), '<html>外面</html>');
    nodeFs.linkSync(join(s.outside, 'x.html'), join(s.jobDir, '交付/硬链.html'));
    await expectFileRefused(s, '交付/硬链.html');
  });

  it('不是 .html、.htm：其他扩展名、没有扩展名、图片', async () => {
    const s = setup();
    s.write('交付/a.txt', 'a');
    s.write('交付/a.js', 'a');
    s.write('交付/noext', 'a');
    s.write('证据/手机.png', PNG);
    s.write('交付/a.html.txt', 'a');
    for (const preview of ['交付/a.txt', '交付/a.js', '交付/noext', '证据/手机.png', '交付/a.html.txt']) await expectFileRefused(s, preview);
  });

  it('不存在、空文件、名字叫 .html 的文件夹', async () => {
    const s = setup();
    s.write('交付/空.html', '');
    nodeFs.mkdirSync(join(s.jobDir, '交付/文件夹.html'));
    for (const preview of ['交付/没有.html', '交付/空.html', '交付/文件夹.html']) await expectFileRefused(s, preview);
  });

  it('中心写的文件（约定、草图、材料里的网页，含大小写写法）不能当预览', async () => {
    const s = setup();
    s.write('约定.md', '约定');
    s.write('材料/页面.html', '<html>材料</html>');
    nodeFs.writeFileSync(join(s.jobDir, '草图.html'), '<html>草图</html>');
    for (const preview of ['材料/页面.html', '约定.md', './材料/页面.html', '材料/../材料/页面.html']) await expectFileRefused(s, preview);
  });
});

describe('3 地址：不是本机地址一律拒绝', () => {
  it('补充要求列出的每一种伪装写法，以及协议、主机、空白的各种写法', () => {
    const refused = [
      'http://localhost.example.com', 'http://127.0.0.1.example.com', 'http://127.0.0.1@example.com', 'http://localhost:80@example.com',
      'http://example.com', 'https://example.com/a.html', 'file:///etc/passwd', 'javascript:alert(1)',
      ' http://localhost:3000/', 'http://localhost:3000/ ', 'http://localhost:3000/\n', '\nhttp://localhost:3000/', 'http://local\nhost:3000/', 'http://localhost:3000/\t',
      'http://user:pw@localhost/', 'http://localhost@evil.com/', 'ftp://localhost/', 'ws://localhost/', 'data:text/html,<b>x</b>', 'http:localhost', 'http:/localhost/',
      'http://[::2]/', 'http://localhost./', 'http://0.0.0.0:3000/', 'http://localhost%00.evil.com/', 'http://ｌｏｃａｌｈｏｓｔ/', 'http://localhost/路径',
      'localhost:3000', '//localhost/', '', 'http://', 'http://:3000/',
    ];
    for (const text of refused) expect(localPreviewUrl(text), JSON.stringify(text)).toBeNull();
  });

  it('正例：localhost、127.0.0.1、[::1]，http 和 https，带端口、路径、查询；返回解析后的标准写法', () => {
    expect(localPreviewUrl('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(localPreviewUrl('https://localhost:3000/')).toBe('https://localhost:3000/');
    expect(localPreviewUrl('http://127.0.0.1:3000/a/b?x=1')).toBe('http://127.0.0.1:3000/a/b?x=1');
    expect(localPreviewUrl('http://[::1]:5173/')).toBe('http://[::1]:5173/');
    expect(localPreviewUrl('http://localhost')).toBe('http://localhost/');
    expect(localPreviewUrl('HTTP://LOCALHOST:5173/x')).toBe('http://localhost:5173/x');
  });

  it('经 jobPreviewTarget：地址返回 {kind:url}，不合格的地址返回固定说法且不写存储', async () => {
    const s = setup();
    expect(await check(s, 'https://localhost:3000/')).toEqual({ ok: true, data: { kind: 'url', url: 'https://localhost:3000/' } });
    expect(await check(s, 'http://[::1]:5173/')).toEqual({ ok: true, data: { kind: 'url', url: 'http://[::1]:5173/' } });
    for (const preview of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', ' http://localhost/', 'http://localhost:80@example.com', 'http://127.0.0.1@example.com']) {
      expect(await checkReadOnly(s, preview), preview).toEqual({ ok: false, error: PREVIEW_URL_REFUSED_TEXT });
    }
  });
});

describe('4 其他', () => {
  it('没有预览、没有这件事、没有交回、参数不对：各返回中文错误，不抛出', async () => {
    const s = setup();
    expect(await jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' })).toEqual({ ok: false, error: '这件事没有可打开的预览' });
    expect(await check(s, null)).toEqual({ ok: false, error: '这件事没有可打开的预览' });
    expect(await jobPreviewTarget(s.ctx, { jobId: 'job_0000000002' })).toEqual({ ok: false, error: '找不到这件事' });
    for (const raw of [{}, null, 'x', { jobId: 'job_0000000001', url: 'http://localhost/' }, { jobId: 'abc' }]) {
      const result = await jobPreviewTarget(s.ctx, raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it('取最新一次交回的预览：旧交回里的预览不会被打开', async () => {
    const s = setup();
    s.write('交付/index.html', '<html>页面</html>');
    s.submit({ id: 'jsb_0000000001', preview: 'http://localhost:5173/', createdAt: 1000 });
    s.submit({ id: 'jsb_0000000002', preview: '交付/index.html', createdAt: 2000 });
    // 预期已改（P74r4b）：打开的是预览副本里的 index.html，不是原文件。
    const result = await jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' });
    expect(result.ok).toBe(true);
    const path = (result as { data: { path: string } }).data.path;
    expect(path.startsWith(join(s.root, '.hub', 'preview', 'job_0000000001') + '/')).toBe(true);
    expect(path.endsWith('/index.html')).toBe(true);
  });
});
