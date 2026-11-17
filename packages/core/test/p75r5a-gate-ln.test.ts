/**
 * P75r5a 第 2 节的测试：闸门对建链接（ln）的识别按连接符区分。
 * 背景：cd 失败时后面的命令其实在原目录执行，所以 `cd 不存在的目录; ln -s x .agents`、`cd /tmp || ln -s x .agents` 要识别；
 * 但 `cd /tmp && ln -s x .agents` 链接建在 /tmp，不能误拦。
 * 规则：&& 之后只在 cd 之后的目录；|| 之后只在原目录；; 换行 & 之后两个都可能；cd 的参数认不出（-、含 $）时之后也都可能。
 * 判定：每个可能的目录下都命中才照原有规则；只在一部分目录下命中（看不出在哪个目录）一律只拒绝、不计越界。
 * 每条命令沙箱开着、没开着都测，并写明越界计数的变化。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';
import { guardToolCall } from '../src/gate/guard.js';
import { lexShell } from '../src/gate/shell-lexer.js';

const SANDBOX = { sandboxed: true, tmpDirs: ['/tmp', '/private/tmp'] };
/** 技能库三处的拒绝原因（只读、不计越界）。 */
const READONLY_REASON = '技能库由中心维护：经验在复盘时用 hub_skill 提交，核对通过后写入。';
/** 中心管理的文件的拒绝原因（受保护、计越界）。 */
const PROTECTED_REASON = '中心管理的身份、心智视图和历史日志不能直接改写';
/** 看不出命令在哪个目录执行时的拒绝原因（逐字）。 */
const AMBIGUOUS_REASON = '看不出这条命令执行时在哪个目录，链接可能建在中心管理的位置上。把 cd 和 ln 用 && 连起来，或者写绝对路径。';

async function run(command: string, sandboxed: boolean) {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, sessionId: 'bot-session' });
  const decision = await guardToolCall(ctx, 'bot-session', 'exec', { command }, sandboxed ? SANDBOX : undefined);
  return { decision, violations: ctx.store.table('bots').get(botFixture.id)!.violations };
}
const messageOf = (decision: { allow: boolean; message?: string }): string => decision.allow ? '' : (decision.message ?? '');
const MODES = [true, false] as const;
const label = (sandboxed: boolean): string => sandboxed ? '沙箱开着' : '沙箱没开';

/** 拒绝、文字是指定的一句、越界次数不变（仍为 0）。 */
const AMBIGUOUS = [
  '1 cd /no/such/dir; ln -s x .agents',
  '3 cd /tmp && cd - && ln -s x .agents',
  '5 cd .agents || true; ln -s /x skills',
  '8 cd /tmp/no-such-dir; ln -s x mind/now.md',
  '10 cd /tmp && true; ln -s x .agents',
];
describe('看不出命令在哪个目录：拒绝、文字逐字、越界不变', () => {
  for (const sandboxed of MODES) {
    for (const entry of AMBIGUOUS) {
      const command = entry.slice(entry.indexOf(' ') + 1);
      it(`${label(sandboxed)}：${command}`, async () => {
        const { decision, violations } = await run(command, sandboxed);
        expect(decision).toEqual({ allow: false, message: AMBIGUOUS_REASON });
        expect(violations).toBe(0);
      });
    }
  }
});

describe('cd 失败也会在原目录执行：按技能库只读拒绝，越界不变', () => {
  for (const sandboxed of MODES) {
    it(`${label(sandboxed)}：cd /tmp || ln -s x .agents（|| 之后只在原目录）`, async () => {
      const { decision, violations } = await run('cd /tmp || ln -s x .agents', sandboxed);
      expect(decision).toEqual({ allow: false, message: READONLY_REASON });
      expect(violations).toBe(0);
    });
    it(`${label(sandboxed)}：cd "$HOME" && ln -s x .agents（参数认不出，不当成字面路径）：拒绝，越界不变`, async () => {
      const { decision, violations } = await run('cd "$HOME" && ln -s x .agents', sandboxed);
      expect(decision.allow).toBe(false);
      expect([READONLY_REASON, AMBIGUOUS_REASON]).toContain(messageOf(decision));
      expect(violations).toBe(0);
    });
    it(`${label(sandboxed)}：cd work && cd ../.agents && ln -s x skills（&& 一路连下来，只在 .agents）：只读，越界不变`, async () => {
      const { decision, violations } = await run('cd work && cd ../.agents && ln -s x skills', sandboxed);
      expect(decision).toEqual({ allow: false, message: READONLY_REASON });
      expect(violations).toBe(0);
    });
  }
});

describe('不被误拦：cd 成功之后链接建在别处', () => {
  for (const sandboxed of MODES) {
    for (const command of ['cd /tmp && ln -s x .agents', 'cd /tmp && ln -sf x AGENTS.md']) {
      it(`${label(sandboxed)}：${command} 放行，越界不变`, async () => {
        const { decision, violations } = await run(command, sandboxed);
        expect(messageOf(decision)).not.toBe(READONLY_REASON);
        expect(messageOf(decision)).not.toBe(PROTECTED_REASON);
        expect(messageOf(decision)).not.toBe(AMBIGUOUS_REASON);
        expect(violations).toBe(0);
        // 第二条的链接建在 /tmp 里，通用的写入规则（不属于本节）可能要主人批准；只要不是本节的三种拒绝文字即可。
        if (sandboxed && command.endsWith('.agents')) expect(decision).toEqual({ allow: true });
      });
    }
  }
});

describe('链接建在中心管理的文件上、看得清：拒绝并计越界（越界加一）', () => {
  for (const sandboxed of MODES) {
    for (const command of ['cd /tmp || ln -sf x AGENTS.md', 'ln -sf /dev/null AGENTS.md']) {
      it(`${label(sandboxed)}：${command}`, async () => {
        const { decision, violations } = await run(command, sandboxed);
        expect(decision).toEqual({ allow: false, message: PROTECTED_REASON });
        expect(violations).toBe(1);
      });
    }
  }
});

describe('词法：每段记下与前一段之间的连接符', () => {
  const CASES: Array<[string, string, 'newline' | '&&' | '||' | ';' | '|' | '&']> = [
    ['&&', 'a && b', '&&'], ['||', 'a || b', '||'], [';', 'a ; b', ';'], ['|', 'a | b', '|'], ['&', 'a & b', '&'], ['换行', 'a\nb', 'newline'],
  ];
  for (const sandbox of MODES) {
    for (const [name, source, join] of CASES) {
      it(`${label(sandbox)}：${name}：第一段为 null，第二段为 ${join}`, () => {
        const parsed = lexShell(source, 0, undefined, sandbox ? { sandbox: true } : undefined);
        expect(parsed.parts.map(part => part.joinedBy)).toEqual([null, join]);
      });
    }
    it(`${label(sandbox)}：三段混合；换行之前的 && 不被换行覆盖`, () => {
      expect(lexShell('a && b || c ; d', 0, undefined, sandbox ? { sandbox: true } : undefined).parts.map(part => part.joinedBy)).toEqual([null, '&&', '||', ';']);
      expect(lexShell('a &&\nb', 0, undefined, sandbox ? { sandbox: true } : undefined).parts.map(part => part.joinedBy)).toEqual([null, '&&']);
    });
  }
  it('命令替换展开出来的段记 ;（前后关系说不清）', () => {
    const parts = lexShell('echo $(date) && ls', 0, undefined, { sandbox: true }).parts;
    expect(parts.map(part => part.words[0])).toEqual(['date', 'echo', 'ls'].filter(word => parts.some(part => part.words[0] === word)));
    expect(parts[0]!.joinedBy).toBeNull();
    expect(parts.find(part => part.words[0] === 'ls')!.joinedBy).toBe('&&');
  });
});
