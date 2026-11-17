/**
 * P75r6 第 6 节：密钥隐去的漏网与误伤（util/redact.ts 的 redactSecrets，复验 N6）。
 * 12 条规则各至少一个正例（原值不在结果里）一个反例（原样保留）；复验记录 N6 列出的每个漏网例子都被隐去、
 * 每个误伤例子不再被隐去（「断行或加空格的密钥」是这种方法的固有限制，不在范围内，最后一条测试把这个限制写成文档）。
 * 所有「密钥」都是现编的，不是任何真实的密钥。原有的 p75r5c-redact 测试原样通过（另一个文件）。
 */
import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../src/util/redact.js';

describe('第 1 条：网址里的用户名密码段', () => {
  it('正例：任何协议（含数据库连接串），密码段隐去，其余保留', () => {
    const pg = redactSecrets('连接串 postgres://admin:S3cretPassw0rd@db.example.com:5432/app 已配置');
    expect(pg).not.toContain('S3cretPassw0rd');
    expect(pg).toBe(`连接串 postgres://admin:${REDACTED}@db.example.com:5432/app 已配置`);
    const mongo = redactSecrets('mongodb+srv://user:pa55word@cluster0.example.net');
    expect(mongo).not.toContain('pa55word');
    expect(mongo).toBe(`mongodb+srv://user:${REDACTED}@cluster0.example.net`);
    expect(redactSecrets('ftp://anon:x1y2z3@files.example.com/pub')).toBe(`ftp://anon:${REDACTED}@files.example.com/pub`);
  });
  it('反例：没有用户名密码段的网址、带端口的网址、邮箱原样保留', () => {
    for (const text of ['https://example.com:8080/docs/a', 'postgres://db.example.com:5432/app', '联系 someone@example.com 或 https://example.com/u/name@x']) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe('第 2 条：sk_、rk_、pk_ 加 live_ 或 test_', () => {
  it('正例：下划线写法在 16 位以上时隐去（不到 48 位）', () => {
    for (const secret of ['sk_test_FAKEabcdefghijkl12', 'sk_live_FAKEabcdefghijkl12', 'rk_live_FAKEabcdefghijkl12', 'pk_test_FAKEabcdefghijkl12']) {
      const out = redactSecrets(`密钥串 ${secret} 用过一次`);
      expect(out).not.toContain(secret);
      expect(out).toBe(`密钥串 ${REDACTED} 用过一次`);
    }
  });
  it('反例：不到 16 位、没有 live_ 或 test_、单词中间的写法原样保留', () => {
    for (const text of ['sk_test_short', 'sk_prod_FAKEabcdefghijkl12', 'task_live_FAKEabcdefghijkl12']) expect(redactSecrets(text)).toBe(text);
  });
});

describe('第 3 条：名字里允许有一个空格', () => {
  it('正例：api key、secret key、access key、private key（不分大小写）加冒号或等号再加值', () => {
    for (const [text, kept] of [
      ['API Key: abcdef1234567890', 'API Key: '], ['Secret Key: abcdef1234567890', 'Secret Key: '],
      ['access key = abcdef1234567890', 'access key = '], ['PRIVATE KEY=abcdef1234567890', 'PRIVATE KEY='],
    ] as const) {
      const out = redactSecrets(`配置里写着 ${text} 就这些`);
      expect(out).not.toContain('abcdef1234567890');
      expect(out).toBe(`配置里写着 ${kept}${REDACTED} 就这些`);
    }
  });
  it('反例：没有冒号或等号、名字之间多于一个空格、不是这四个名字时原样保留', () => {
    for (const text of ['the api key is rotated monthly', 'api  key: abcdef1234567890', 'public key: abcdef1234567890', 'monkey key: abcdef1234567890']) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe('第 4 条：Authorization 后接冒号', () => {
  it('正例：保留认证方式那个词，后面的一段隐去', () => {
    const basic = redactSecrets('请求头 Authorization: Basic dXNlcjpwYXNzd29yZA== 已发送');
    expect(basic).not.toContain('dXNlcjpwYXNzd29yZA');
    expect(basic).toBe(`请求头 Authorization: Basic ${REDACTED} 已发送`);
    const bearer = redactSecrets('authorization: Bearer abc123def456');
    expect(bearer).toBe(`authorization: Bearer ${REDACTED}`);
  });
  it('反例：没有冒号、值太短的说明文字原样保留；Bearer 加 20 位以上仍按原来的规则整段隐去', () => {
    expect(redactSecrets('Authorization 头用来带令牌')).toBe('Authorization 头用来带令牌');
    expect(redactSecrets('Authorization: Bearer token 的写法见文档')).toBe('Authorization: Bearer token 的写法见文档');
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwx1234')).toBe(`Authorization: ${REDACTED}`);
  });
});

describe('第 5 条：带引号的值隐去到配对的引号为止', () => {
  it('正例：值里有空格时整段隐去（引号保留）；单引号、JSON 写法同样', () => {
    const spaced = redactSecrets('password = "correct horse battery staple" 之后照旧');
    expect(spaced).not.toContain('horse');
    expect(spaced).not.toContain('staple');
    expect(spaced).toBe(`password = "${REDACTED}" 之后照旧`);
    expect(redactSecrets("secret: 'two words here'")).toBe(`secret: '${REDACTED}'`);
    expect(redactSecrets('{"api_key": "abc def ghi 123"}')).toBe(`{"api_key": "${REDACTED}"}`);
  });
  it('反例：空引号、没有配对的引号退回到空白为止、引号之后的话保留', () => {
    expect(redactSecrets('password: ""')).toBe('password: ""');
    expect(redactSecrets('password: "abc123fake rest')).toBe(`password: ${REDACTED} rest`);
    expect(redactSecrets('password="abc123fake" 然后重启')).toBe(`password="${REDACTED}" 然后重启`);
  });
});

describe('第 6 条：值写在下一行', () => {
  it('正例：名字加冒号结尾、这一行没有值，隐去下一行第一段不含空白的文字', () => {
    const out = redactSecrets('password:\n  hunter2hunter2 就是这个\n下一行照旧');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).toBe(`password:\n  ${REDACTED} 就是这个\n下一行照旧`);
    expect(redactSecrets('密码：\r\nabc123def456')).toBe(`密码：\r\n${REDACTED}`);
  });
  it('反例：这一行有值时下一行不动；隔了空行、下一行是列表符号或太短的词不隐去', () => {
    expect(redactSecrets('password: abc123fake\nnext_line_word')).toBe(`password: ${REDACTED}\nnext_line_word`);
    expect(redactSecrets('password:\n\nhunter2hunter2')).toBe('password:\n\nhunter2hunter2');
    expect(redactSecrets('password:\n- 要求至少 12 位')).toBe('password:\n- 要求至少 12 位');
    expect(redactSecrets('password:\nabc')).toBe('password:\nabc');
  });
});

describe('第 7 条：中文「密码是……」', () => {
  it('正例：「密码」「口令」「密钥」「令牌」后面跟「是」「为」或空格，再跟 6 位以上含字母和数字的文字', () => {
    for (const [text, kept] of [
      ['密码是 abc123', '密码是 '], ['密码 abc123', '密码 '], ['口令为abc12345x', '口令为'], ['密钥是 Zx9Kq2Lm7P', '密钥是 '], ['令牌 tok123abc', '令牌 '],
    ] as const) {
      const out = redactSecrets(`账号的${text}，请保管`);
      expect(out).toBe(`账号的${kept}${REDACTED}，请保管`);
    }
  });
  it('反例：只有字母、只有数字、不足 6 位、没有「是」「为」或空格时原样保留', () => {
    for (const text of ['密码是 password', '密码是 12345678', '密码是 ab12', '密码要定期更换', '修改密码abc123fake']) expect(redactSecrets(text)).toBe(text);
  });
});

describe('第 8 条：网址查询串里的 key、auth、sig 等', () => {
  it('正例：key、access_key、auth、signature、sig 等于 12 位以上的值，值隐去、参数名保留', () => {
    for (const name of ['key', 'access_key', 'auth', 'signature', 'sig']) {
      const out = redactSecrets(`请求 https://api.example.com/v1/items?page=2&${name}=abc123def456ghi789 完成`);
      expect(out).not.toContain('abc123def456ghi789');
      expect(out).toBe(`请求 https://api.example.com/v1/items?page=2&${name}=${REDACTED} 完成`);
    }
    expect(redactSecrets('https://x.example.com/p?key=abc123def456ghi')).toBe(`https://x.example.com/p?key=${REDACTED}`);
  });
  it('反例：值不到 12 位、不是这些参数名、不在查询串里时原样保留', () => {
    for (const text of ['https://x.example.com/p?key=abc123', 'https://x.example.com/p?lang=zh-CN-very-long-value-here', 'key=abc123def456ghi789 写在这里']) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe('第 9 条：名字里的 token 只在是完整的一段时才算', () => {
  it('正例：整个名字是 token，或以 _token、-token、.token 结尾（含驼峰 accessToken）', () => {
    for (const text of ['token=abc123fake', 'access_token: abc123fake', 'refresh-token=abc123fake', 'auth.token: abc123fake', 'accessToken: abc123fake']) {
      const out = redactSecrets(text);
      expect(out, text).not.toContain('abc123fake');
      expect(out, text).toContain(REDACTED);
    }
  });
  it('反例：max_tokens、tokens、tokenizer、token_count 这类的值不隐去', () => {
    for (const text of ['max_tokens=abc123fake', 'tokens: abc123fake', 'tokenizer: bpe-fake-vocab', 'token_count=abc123fake', 'max_tokens=4096']) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });
});

describe('第 10 条：无害的值不隐去', () => {
  it('反例：不到 8 位的纯数字、true、false、null、none（不分大小写）', () => {
    for (const value of ['1234', '1234567', 'true', 'False', 'NULL', 'none']) {
      expect(redactSecrets(`password=${value}`), value).toBe(`password=${value}`);
      expect(redactSecrets(`api_key: ${value}`), value).toBe(`api_key: ${value}`);
    }
  });
  it('正例：8 位纯数字、不是这几个词的值照旧隐去', () => {
    expect(redactSecrets('password=12345678')).toBe(`password=${REDACTED}`);
    expect(redactSecrets('password=trueish1')).toBe(`password=${REDACTED}`);
  });
});

describe('第 11 条：提交号不隐去', () => {
  const sha = 'a1b2c3d4e5'.repeat(4);
  it('反例：前面 16 个字符之内有「提交」「commit」「sha」「hash」「版本」「revision」', () => {
    for (const lead of ['提交', 'commit', 'Commit:', 'sha', 'hash=', '版本', 'revision']) {
      const text = `${lead} ${sha} 已合并`;
      expect(redactSecrets(text), lead).toBe(text);
    }
    expect(redactSecrets(`提交 2aacceb${'1'.repeat(33)} 已合并`)).toBe(`提交 2aacceb${'1'.repeat(33)} 已合并`);
  });
  it('正例：没有这些词、词在 16 个字符之外或在上一行时照旧隐去；64 位十六进制照旧隐去', () => {
    expect(redactSecrets(`摘要里出现了 ${sha} 这一串`)).toBe(`摘要里出现了 ${REDACTED} 这一串`);
    expect(redactSecrets(`提交说明写得很长很长很长很长很长很长 ${sha}`)).toBe(`提交说明写得很长很长很长很长很长很长 ${REDACTED}`);
    expect(redactSecrets(`提交\n${sha}`)).toBe(`提交\n${REDACTED}`);
    const hex64 = '0123456789abcdef'.repeat(4);
    expect(redactSecrets(`commit ${hex64}`)).toBe(`commit ${REDACTED}`);
  });
});

describe('第 12 条：带斜线的长串、驼峰标识符不隐去', () => {
  it('反例：两个以上斜线、每一段都不超过 40 个字符时按路径处理（含数字和大小写也不隐去）', () => {
    const path = 'src/Skill2Tidy/Packages1/Wake3Section/FileName4Value/deepNested5Folder/lastSegment6';
    expect(path.length).toBeGreaterThan(48);
    expect(redactSecrets(`改了 ${path} 这个文件`)).toBe(`改了 ${path} 这个文件`);
  });
  it('反例：数字不多、小写字母成串的驼峰长标识符不隐去', () => {
    const name = 'buildSkillSectionForRetroTurnWithCheckerAndTidyRun2';
    expect(name.length).toBeGreaterThanOrEqual(48);
    expect(redactSecrets(`函数 ${name} 负责拼段`)).toBe(`函数 ${name} 负责拼段`);
  });
  it('正例：段超过 40 个字符的带斜线长串、只有一个斜线的、随机的字母数字串照旧隐去', () => {
    const longSegment = `${'zQ7'.repeat(17)}/xY9/zQ1`;
    expect(redactSecrets(`串 ${longSegment} 结束`)).toBe(`串 ${REDACTED} 结束`);
    const oneSlash = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3/kL5';
    expect(redactSecrets(oneSlash)).toBe(REDACTED);
    const random = 'x7Kq9ZmP2vB4nR8tY1wC6jL3hD5sF0gA7eU2iO9kM4qT1zXb';
    expect(redactSecrets(random)).toBe(REDACTED);
  });
});

describe('复验记录 N6 的全部例子', () => {
  const leaks: Array<[string, string]> = [
    ['postgres://admin:S3cretPassw0rd@db.example.com:5432/app', 'S3cretPassw0rd'],
    ['mongodb+srv://user:pa55word@cluster0.example.net', 'pa55word'],
    ['sk_test_FAKEabcdefghijkl1234', 'FAKEabcdefghijkl1234'],
    ['sk_live_FAKEabcdefghijkl1234', 'FAKEabcdefghijkl1234'],
    ['API Key: abcdef1234567890', 'abcdef1234567890'],
    ['Secret Key: abcdef1234567890', 'abcdef1234567890'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
    ['password = "correct horse battery staple"', 'battery staple'],
    ['password:\n  hunter2hunter2', 'hunter2hunter2'],
    ['密码是 abc123', 'abc123'],
    ['密码 abc123', 'abc123'],
    ['网址 https://x.example.com/p?key=abc123def456ghi', 'abc123def456ghi'],
  ];
  for (const [text, secret] of leaks) {
    it(`漏网的例子现在被隐去：${text.split('\n')[0]}`, () => {
      const out = redactSecrets(text);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTED);
      expect(redactSecrets(out)).toBe(out);
    });
  }

  it('误伤的例子不再被隐去：提交哈希、max_tokens、tokenizer、长路径、长驼峰标识符', () => {
    const hash = `2aacceb1${'0'.repeat(28)}9123`;
    expect(hash.length).toBe(40);
    for (const text of [
      `提交 ${hash} 已合并`, 'max_tokens=4096', 'tokenizer: bpe',
      'packages/core/src/Skill2Tidy/wake/SkillSection3/someVeryLongFolderName4/fileName5',
      'ownerSessionDigestRedactionPipelineStageNumber2Handler',
    ]) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });

  it('固有限制：断行或加空格的密钥认不出来（这种方法的限制，不在隐去范围内）', () => {
    const split = 'sk-abcd1234efgh5678\nijkl9012mnop3456';
    expect(redactSecrets(split)).toContain('ijkl9012mnop3456');
  });
});
