/**
 * P75r5c 第 6 节第 2 条：隐去像密钥的内容（util/redact.ts 的 redactSecrets）。
 * 每一类各一条正例（替换后原值不在结果里），再加不该被隐去的反例（普通的中文句子、短的版本号、网址、文件路径、一般的英文单词）。
 * 所有「密钥」都是现编的，不是任何真实的密钥。
 */
import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../src/util/redact.js';

// 公开仓库的密钥形状扫描会拦截源码里连续出现的密钥写法，所以这些现编的样例在源码里拆成两段，
// 运行时拼起来，得到的字符串与连写完全相同。
const SK_SAMPLE = 'sk-' + 'AbCdEfGh12345678IJKL';
const AKIA_SAMPLE = 'AKIA' + 'ABCDEFGH12345678';
const GHP_SAMPLE = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const RSA_BEGIN = '-----BEGIN ' + 'RSA PRIVATE KEY-----';

describe('隐去像密钥的内容：正例（原值不在结果里）', () => {
  it('REDACTED 就是「（已隐去）」', () => {
    expect(REDACTED).toBe('（已隐去）');
  });

  const prefixed: Array<[string, string]> = [
    ['sk- 后接 16 位以上', SK_SAMPLE],
    ['pk- 后接 16 位以上', 'pk-test_abcdefghijklmnop12'],
    ['rk- 后接 16 位以上', 'rk-ZZZZ1111yyyy2222xxxx'],
    ['ghp_ 后接 20 位以上', GHP_SAMPLE],
    ['gho_ 后接 20 位以上', 'gho_a1B2c3D4e5F6g7H8i9J0k1L2'],
    ['ghu_ 后接 20 位以上', 'ghu_a1B2c3D4e5F6g7H8i9J0k1L2'],
    ['ghs_ 后接 20 位以上', 'ghs_a1B2c3D4e5F6g7H8i9J0k1L2'],
    ['github_pat_ 后接 20 位以上', 'github_pat_A1b2C3d4E5f6G7h8I9j0K1'],
    ['AKIA 后接 16 位大写字母数字', AKIA_SAMPLE],
    ['AIza 后接 30 位以上', 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4'],
    ['xoxb- 开头的一段', 'xoxb-123456789012-abcdefABCDEF'],
    ['xoxp- 开头的一段', 'xoxp-123456789012-abcdefABCDEF'],
    ['xoxa- 开头的一段', 'xoxa-123456789012-abcdefABCDEF'],
    ['xoxr- 开头的一段', 'xoxr-123456789012-abcdefABCDEF'],
    ['xoxs- 开头的一段', 'xoxs-123456789012-abcdefABCDEF'],
  ];
  for (const [name, secret] of prefixed) {
    it(`常见前缀的密钥：${name}`, () => {
      const out = redactSecrets(`我的凭据是 ${secret} 用完就删。`);
      expect(out).not.toContain(secret);
      expect(out).toBe(`我的凭据是 ${REDACTED} 用完就删。`);
    });
  }

  it('Bearer 加空格后接 20 位以上的一段', () => {
    const secret = 'abcdefghijklmnopqrstuvwx1234';
    const out = redactSecrets(`请求头写 Authorization: Bearer ${secret} 就行`);
    expect(out).not.toContain(secret);
    expect(out).toBe(`请求头写 Authorization: ${REDACTED} 就行`);
  });

  it('-----BEGIN 到 -----END … ----- 之间的整段私钥（前后的文字保留）；没有结尾（被截断）时隐去到文末', () => {
    const body = 'MIIEfakeFAKEfakeFAKE0123456789\nabcdefFAKEghijklFAKE';
    const out = redactSecrets(`先贴私钥：\n${RSA_BEGIN}\n${body}\n-----END RSA PRIVATE KEY-----\n然后重启服务。`);
    expect(out).not.toContain('MIIEfake');
    expect(out).not.toContain('abcdefFAKE');
    expect(out).toBe(`先贴私钥：\n${REDACTED}\n然后重启服务。`);
    const cut = redactSecrets(`私钥：\n-----BEGIN PRIVATE KEY-----\n${body}`);
    expect(cut).toBe(`私钥：\n${REDACTED}`);
  });

  const named: Array<[string, string, string]> = [
    ['api_key', 'api_key=abc123fake', 'api_key='],
    ['apikey', 'apikey: abc123fake', 'apikey: '],
    ['api-key（等号两侧有空格）', 'api-key = abc123fake', 'api-key = '],
    ['secret', 'client_secret: s3cr3tfakevalue', 'client_secret: '],
    ['token', 'access_token=tok123fake', 'access_token='],
    ['password', 'password: pw123fake', 'password: '],
    ['passwd', 'passwd=pw123fake', 'passwd='],
    ['不分大小写', 'DB_PASSWORD=pw123fake', 'DB_PASSWORD='],
    ['密钥（全角冒号）', '密钥：abc123fake', '密钥：'],
    ['密码', '密码: xyz789fake', '密码: '],
    ['口令', '口令=zzz999fake', '口令='],
    ['令牌', '令牌：ttt111fake', '令牌：'],
  ];
  for (const [name, text, kept] of named) {
    it(`名字加等号或冒号再加值：名字含「${name}」，值隐去、名字保留`, () => {
      const out = redactSecrets(`配置是 ${text} 其余照旧`);
      const value = text.replace(/^.*?[=:：]\s*/, '');
      expect(out).not.toContain(value);
      expect(out).toBe(`配置是 ${kept}${REDACTED} 其余照旧`);
    });
  }

  it('值到行尾或空白为止：同一行后面的话保留，换行之后的内容不受影响', () => {
    const out = redactSecrets('password: fakepw123 之后正常说话\n下一行 token 的用法不变');
    expect(out).toBe(`password: ${REDACTED} 之后正常说话\n下一行 token 的用法不变`);
  });

  it('连续 40 位以上的十六进制串；连续 48 位以上的 base64 字符串', () => {
    const hex40 = 'deadbeef'.repeat(5);
    const hex64 = '0123456789abcdef'.repeat(4);
    const b64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm';
    const b64Mixed = 'dGhpcy9pcy9hL2Zha2UvYmFzZTY0L3N0cmluZy93aXRoL3NsYXNoZXMvQUJDMTIzNDU2';
    for (const secret of [hex40, hex64, b64, b64Mixed]) {
      const out = redactSecrets(`摘要里出现了 ${secret} 这一串`);
      expect(out).not.toContain(secret);
      expect(out).toBe(`摘要里出现了 ${REDACTED} 这一串`);
    }
    expect(redactSecrets('A'.repeat(48))).toBe(REDACTED);
  });

  it('同一段里有好几种：全部隐去，并且再处理一遍结果不变', () => {
    const text = `步骤：先 export api_key=abc123fake，再用 ${SK_SAMPLE} 调接口；备用 ${AKIA_SAMPLE}。`;
    const out = redactSecrets(text);
    for (const secret of ['abc123fake', SK_SAMPLE, AKIA_SAMPLE]) expect(out).not.toContain(secret);
    expect(redactSecrets(out)).toBe(out);
  });
});

describe('隐去像密钥的内容：反例（原样保留）', () => {
  const plain: Array<[string, string]> = [
    ['普通的中文句子', '导出报名表的做法：先按报名时间从早到晚排序，再导出成 CSV，文件名带日期。'],
    ['短的版本号', '当前版本 v1.2.3，上一版是 2026.11.16-beta.2。'],
    ['网址', '文档在 https://example.com/docs/getting-started?lang=zh&page=2 里。'],
    ['文件路径', '改了 /Users/someone/Documents/project/src/index.ts 和 packages/core/src/skill/learn.ts。'],
    ['很长的目录路径（带斜线、没有数字和大写）', 'packages/core/src/skill/learn-card-and-more/another-folder/deeply-nested-file-name'],
    ['一般的英文单词', 'The quick brown fox jumps over the lazy dog. Token budget and password policy were discussed.'],
    ['单词中间的 sk-（前面是字母）', 'risk-assessment-and-mitigation-plan-for-the-next-release'],
    ['太短的前缀串', 'sk-short ghp_short AKIA123 xox 字样 Bearer token'],
    ['短的十六进制（提交号）', '提交 1a2b3c4d 和 deadbeef 已合并。'],
    ['39 位十六进制、47 位字母（G 不是十六进制字符）', `${'a'.repeat(39)} ${'G'.repeat(47)}`],
    ['名字含关键词但没有等号或冒号', '这里的 token 和 password 只是名词，max_tokens 4096 也没有等号。'],
  ];
  for (const [name, text] of plain) {
    it(`不被隐去：${name}`, () => {
      expect(redactSecrets(text)).toBe(text);
    });
  }
});
