/**
 * P76p 第 2 节：主人用「是。」确认上一轮待确认问句时，要能落到记忆写入。
 *
 * 为什么走真实 Hub：note 的门、出处的取证、唤醒包的「主人对你说」段都在真实回合里接线；
 * 与 P76l 实测同一条路径（主人先说一句、总管追问、主人答「是。」）才能测到这次修的那一段。
 * 时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { NOTE_NO_TRIGGER_TEXT } from '../src/memory/note.js';
import { callTool, chiefHears, jobFix, memoriesOf, noteArgs, speak } from './p75c-fixtures.js';

/** 上一问之前主人说的那句：一个触发词都没有（有「别用」，不是「别再」）。 */
const EARLIER = '提示文字里别用感叹号吧。';
const ASK = '已改好：提示文字里没有感叹号了。要我以后都这样吗？';

/** 主人先说一句、总管追问、主人回答；返回主人回答那一回合的唤醒包。 */
async function askThenAnswer(ask: string, answer: string): Promise<{ fix: Awaited<ReturnType<typeof jobFix>>; packet: string }> {
  const fix = await jobFix();
  await chiefHears(fix, EARLIER);
  await speak(fix, fix.chief, ask, { outcome: 'progress' });
  const packet = await chiefHears(fix, answer);
  return { fix, packet };
}

describe('在回答待确认问句时，「是。」可以记下', () => {
  it('固定追问句「要我以后都这样吗」：note 成功，出处里两句都在；唤醒包写明这是在确认', async () => {
    const { fix, packet } = await askThenAnswer(ASK, '是。');
    expect(packet).toContain('中心判断');
    expect(packet).toContain(EARLIER);
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toMatchObject({ ok: true });
    const [memory] = memoriesOf(fix.ctx);
    expect(memory!.source.quote).toContain(EARLIER);
    expect(memory!.source.messageIds).toHaveLength(2);
  });

  it('问句写明在问要不要记住（「记下这条规矩？」）：同样可以记下', async () => {
    const { fix } = await askThenAnswer('这条我照办。记下这条规矩？', '是。');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toMatchObject({ ok: true });
    expect(memoriesOf(fix.ctx)).toHaveLength(1);
  });
});

describe('不是在回答待确认问句时，「是。」只当结束对话', () => {
  it('上一轮不是问句（「已改好。」）：note 被拒，没有写入，唤醒包也没有中心判断', async () => {
    const { fix, packet } = await askThenAnswer('已改好：提示文字里没有感叹号了。', '是。');
    expect(packet).not.toContain('中心判断');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('上一轮是别的问句（「你要红色还是蓝色？」）：不算记忆确认，note 被拒', async () => {
    const { fix, packet } = await askThenAnswer('你要红色还是蓝色？', '是。');
    expect(packet).not.toContain('中心判断');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('没有上一轮追问、主人直接说「是。」：note 被拒', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '是。');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('对追问回答「不用，就这一次」：不并入上一句，note 仍被拒', async () => {
    const fix = await jobFix();
    await chiefHears(fix, EARLIER);
    await speak(fix, fix.chief, ASK, { outcome: 'progress' });
    await chiefHears(fix, '不用，就这一次');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });
});
