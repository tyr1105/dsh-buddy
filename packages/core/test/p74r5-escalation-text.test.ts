/**
 * P74r5 第 2、3 节的测试：三轮不过说明卡的两处文字。
 * 第 2 节：「试过什么」每一行「第 n 轮：{交回说明}。{核对说明}」里，交回说明末尾的标点和空白先去掉再加一个「。」，不出现连续两个句末标点；
 * 第 3 节：「可选的办法」小标题按带改动的办法个数写「选 A」「选 A 或 B」「选 A、B 或 C」，不可选的卡（已选、已失效）只写「可选的办法」。
 * 纯函数测试：直接调用 buildEscalationCard，不走完整流程。
 */
import { describe, expect, it } from 'vitest';
import { buildEscalationCard, type EscalationCardInput } from '../src/api/job-escalation-views.js';

/** 一个办法：change 为 null 表示不改约定（没有「记为约定新版本」的说法）。 */
const option = (title: string, withChange: boolean) => ({ title, detail: `${title}的做法`, change: withChange ? { no: 2, text: null } : null, followUp: false });

/** 拼一张三轮不过卡的输入；changeNotes 是每一轮交回说明，notes 是核对说明。 */
function input(patch: { options?: ReturnType<typeof option>[]; chosen?: number | null; expiry?: EscalationCardInput['expiry']; changeNotes?: string[]; notes?: string[] } = {}): EscalationCardInput {
  const changeNotes = patch.changeNotes ?? ['改了接口'];
  const notes = patch.notes ?? ['没有提示'];
  return {
    jobId: 'job_aaaaaaaaaa', executorName: '林舟', expiry: patch.expiry ?? null,
    escalation: { stage: 1, versionNo: 1, kind: 'review_limit', stuckAt: '卡在第 2 条', no: 2, noText: '断开接口后显示「加载失败」',
      options: patch.options ?? [option('只改这一条', false)], suggested: 0, reason: '改动最小', tried: [], at: 1, chosen: patch.chosen ?? null, chosenAt: null },
    reviews: changeNotes.map((_, index) => ({ round: index + 1, submissionId: `jsb_${index}`, items: [{ no: 2, note: notes[index] ?? '没有提示' }] })),
    submissions: changeNotes.map((changeNote, index) => ({ id: `jsb_${index}`, changeNote, items: [{ no: 2, text: '断开接口后显示「加载失败」' }] })),
  } as unknown as EscalationCardInput;
}

describe('2 「试过什么」不出现两个句号', () => {
  it('交回说明以句号、叹号、空格、英文句号、问号结尾：拼出的一行里只有一个「。」分隔，没有连续两个句末标点', () => {
    for (const ending of ['。', '！', '!', ' ', '. ', '？', '。 ', '；', '，', '。。']) {
      const card = buildEscalationCard(input({ changeNotes: [`改了接口${ending}`], notes: ['  没有提示'] }));
      expect(card.tried, JSON.stringify(ending)).toEqual(['第 1 轮：改了接口。没有提示']);
      expect(card.tried[0]).not.toMatch(/[。！!？?；;，,.．]{2}/);
    }
  });

  it('核对说明开头的空白去掉；没有交回说明、没有核对说明时固定字样不变', () => {
    expect(buildEscalationCard(input({ changeNotes: ['改了'], notes: ['\n  还是没有提示'] })).tried).toEqual(['第 1 轮：改了。还是没有提示']);
    // 交回说明全是标点：按没有写处理。
    expect(buildEscalationCard(input({ changeNotes: ['。。'], notes: [' '] })).tried).toEqual(['第 1 轮：（没有交回说明）。（没有写说明）']);
  });

  it('逐轮各一行', () => {
    const card = buildEscalationCard(input({ changeNotes: ['先改接口。', '再改页面！', '最后改文案'], notes: ['一', '二', '三'] }));
    expect(card.tried).toEqual(['第 1 轮：先改接口。一', '第 2 轮：再改页面。二', '第 3 轮：最后改文案。三']);
  });
});

describe('3 「可选的办法」小标题', () => {
  const T = '不再另外请你确认';
  it('带改动的办法一个、两个、三个：选 A / 选 A 或 B / 选 A、B 或 C', () => {
    expect(buildEscalationCard(input({ options: [option('甲', true), option('乙', false)] })).optionsTitle).toBe(`可选的办法　选 A 即记为约定第 2 版，${T}`);
    expect(buildEscalationCard(input({ options: [option('甲', true), option('乙', true)] })).optionsTitle).toBe(`可选的办法　选 A 或 B 即记为约定第 2 版，${T}`);
    expect(buildEscalationCard(input({ options: [option('甲', true), option('乙', true), option('丙', true)] })).optionsTitle).toBe(`可选的办法　选 A、B 或 C 即记为约定第 2 版，${T}`);
    // 只有 B、C 带改动：字母取它们自己的。
    expect(buildEscalationCard(input({ options: [option('甲', false), option('乙', true), option('丙', true)] })).optionsTitle).toBe(`可选的办法　选 B 或 C 即记为约定第 2 版，${T}`);
  });

  it('没有带改动的办法：只写「可选的办法」', () => {
    expect(buildEscalationCard(input({ options: [option('甲', false), option('乙', false)] })).optionsTitle).toBe('可选的办法');
  });

  it('不可选的卡（主人已选、五种失效状态）：只写「可选的办法」', () => {
    const options = [option('甲', true), option('乙', true)];
    const chosen = buildEscalationCard(input({ options, chosen: 0 }));
    expect(chosen).toMatchObject({ selectable: false, optionsTitle: '可选的办法' });
    for (const expiry of ['reconfirming', 'updated', 'withdrawn', 'released', 'stopped'] as const) {
      const card = buildEscalationCard(input({ options, expiry: expiry as never }));
      expect(card.selectable, expiry).toBe(false);
      expect(card.optionsTitle, expiry).toBe('可选的办法');
    }
  });
});
