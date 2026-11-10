/**
 * P63「下一棒交给谁」的纯函数规则，以及点名解析。
 * 每条规则都有正例和反例：@ 接力、汇合回负责人、失败也推进、cap-1 收尾、cap 停。
 */
import { describe, expect, it } from 'vitest';
import { decideAfterAgentTurn, isFinalTurn, planOwnerTurn, type TopicTurnInput } from '../src/project/topic-rounds.js';
import { parseMentions } from '../src/project/topic-mentions.js';
import { pickDefaultOwnerId, assertOwnerEligible, requireProjectOwnerBot } from '../src/project/owner-rules.js';
import { botFixture } from './model-fixtures.js';
import type { Bot } from '../src/model/index.js';

/** 默认状态：负责人 owner，成员 a、b，上限 8，等 a 说话。 */
function input(patch: Partial<TopicTurnInput> = {}): TopicTurnInput {
  return { ownerBotId: 'owner', ownerOnDuty: true, speakerId: 'a', spoke: true, mentions: [], pending: ['a'],
    running: [], speakerStillQueued: false, turns: 0, cap: 8, ...patch };
}

describe('P63 主人说话时叫谁', () => {
  it('@ 了在岗成员就叫他们，不叫负责人', () => {
    expect(planOwnerTurn({ ownerBotId: 'owner', ownerOnDuty: true, mentions: ['a', 'b'], cap: 8 })).toEqual({ targets: ['a', 'b'], ownerUnavailable: false });
  });
  it('没 @ 人时叫负责人', () => {
    expect(planOwnerTurn({ ownerBotId: 'owner', ownerOnDuty: true, mentions: [], cap: 8 })).toEqual({ targets: ['owner'], ownerUnavailable: false });
  });
  it('没人可叫（负责人不在岗）时要告诉主人', () => {
    expect(planOwnerTurn({ ownerBotId: 'owner', ownerOnDuty: false, mentions: [], cap: 8 })).toEqual({ targets: [], ownerUnavailable: true });
  });
  it('上限设成 1 时点名不生效，唯一一次发言留给负责人', () => {
    expect(planOwnerTurn({ ownerBotId: 'owner', ownerOnDuty: true, mentions: ['a'], cap: 1 }).targets).toEqual(['owner']);
  });
});

describe('P63 队友说完后的下一棒', () => {
  it('@ 了在岗的其他成员：叫醒并加入等待名单，计数加一', () => {
    const decision = decideAfterAgentTurn(input({ mentions: ['b'] }));
    expect(decision).toMatchObject({ turns: 1, pending: ['b'], wake: ['b'], reachedCap: false });
  });
  it('没 @ 人且还有人没说完：等他们，不叫负责人', () => {
    const decision = decideAfterAgentTurn(input({ pending: ['a', 'b'] }));
    expect(decision).toMatchObject({ turns: 1, pending: ['b'], wake: [] });
  });
  it('汇合：最后一个说完的不是负责人，叫负责人', () => {
    const decision = decideAfterAgentTurn(input({ speakerId: 'b', pending: ['b'], turns: 1 }));
    expect(decision).toMatchObject({ turns: 2, pending: ['owner'], wake: ['owner'] });
  });
  it('负责人说完且没 @ 人：这一轮结束，等主人', () => {
    const decision = decideAfterAgentTurn(input({ speakerId: 'owner', pending: ['owner'], turns: 2 }));
    expect(decision).toMatchObject({ turns: 3, pending: [], wake: [], reachedCap: false });
  });
  it('需要负责人接棒但它不在岗：不叫人，并标记要告诉主人', () => {
    const decision = decideAfterAgentTurn(input({ ownerOnDuty: false }));
    expect(decision).toMatchObject({ wake: [], pending: [], ownerUnavailable: true });
  });
  it('失败或没回复：不计发言，但一定移出名单并按规则推进', () => {
    const failed = decideAfterAgentTurn(input({ spoke: false }));
    expect(failed).toMatchObject({ turns: 0, pending: ['owner'], wake: ['owner'] });
    // 负责人失败时不再叫自己，这一轮结束，不会原地打转。
    const ownerFailed = decideAfterAgentTurn(input({ speakerId: 'owner', pending: ['owner'], spoke: false }));
    expect(ownerFailed).toMatchObject({ turns: 0, pending: [], wake: [] });
  });
  it('主人刚又叫了它（还有新的唤醒在排队）：仍算在等它，不提前交回负责人', () => {
    const decision = decideAfterAgentTurn(input({ speakerStillQueued: true }));
    expect(decision).toMatchObject({ pending: ['a'], wake: [] });
  });
});

describe('P63 发言上限', () => {
  it('到 cap-1：不管有没有 @，下一棒只叫负责人，并取消排队中的其他人', () => {
    const decision = decideAfterAgentTurn(input({ turns: 6, mentions: ['b'], pending: ['a', 'c'] }));
    expect(decision).toMatchObject({ turns: 7, wake: ['owner'], pending: ['owner'], cancelQueuedExcept: ['owner'] });
  });
  it('到 cap-1 时已经在跑的回合拦不住，让它说完，负责人照样收尾', () => {
    const decision = decideAfterAgentTurn(input({ turns: 6, pending: ['a', 'c'], running: ['c'] }));
    expect(decision).toMatchObject({ wake: ['owner'], pending: ['c', 'owner'] });
  });
  it('负责人恰好说了倒数第二句且没 @ 人：这轮就结束，不再叫自己', () => {
    const decision = decideAfterAgentTurn(input({ speakerId: 'owner', pending: ['owner'], turns: 6 }));
    expect(decision).toMatchObject({ turns: 7, wake: [], pending: [] });
  });
  it('负责人说倒数第二句但还 @ 了人：@ 不生效，下一棒还是它自己收尾', () => {
    const decision = decideAfterAgentTurn(input({ speakerId: 'owner', pending: ['owner'], turns: 6, mentions: ['a'] }));
    expect(decision).toMatchObject({ wake: ['owner'], pending: ['owner'] });
  });
  it('到 cap：不再叫任何人，并落「等你下一句」', () => {
    const decision = decideAfterAgentTurn(input({ speakerId: 'owner', pending: ['owner'], turns: 7, mentions: ['a'] }));
    expect(decision).toMatchObject({ turns: 8, wake: [], pending: [], reachedCap: true });
  });
  it('到 cap 时负责人的收尾还在路上：先不落提示，等它说完', () => {
    const decision = decideAfterAgentTurn(input({ speakerId: 'c', pending: ['c', 'owner'], turns: 7 }));
    expect(decision).toMatchObject({ turns: 8, pending: ['owner'], wake: [], reachedCap: false });
  });
  it('讨论早已停住时迟到的发言不重复提醒', () => {
    const decision = decideAfterAgentTurn(input({ speakerId: 'c', pending: [], turns: 8 }));
    expect(decision).toMatchObject({ turns: 9, wake: [], pending: [], reachedCap: false });
  });
  it('最后一次发言的判定：cap-1 起算最后一次，更早的不算', () => {
    expect(isFinalTurn(7, 8)).toBe(true);
    expect(isFinalTurn(6, 8)).toBe(false);
  });
});

describe('P63 点名解析', () => {
  const roster = [{ id: 'b1', name: '小王' }, { id: 'b2', name: '小王子' }, { id: 'b3', name: '老大' }];
  it('名字后面紧跟文字也算点名（中文常这样写）', () => {
    expect(parseMentions('@小王帮忙看下', roster).map(bot => bot.id)).toEqual(['b1']);
  });
  it('长名字优先：@小王子 不会算成小王', () => {
    expect(parseMentions('请 @小王子 看看', roster).map(bot => bot.id)).toEqual(['b2']);
  });
  it('按出现顺序返回，同一人点多次只算一次，全角 @ 也算', () => {
    expect(parseMentions('＠老大 和 @小王 还有 @老大', roster).map(bot => bot.id)).toEqual(['b3', 'b1']);
  });
  it('反例：只提名字不带 @ 不算点名', () => {
    expect(parseMentions('小王说得对', roster)).toEqual([]);
  });
});

describe('P60 负责人规则', () => {
  const member = (id: string, patch: Partial<Bot>): Bot => ({ ...botFixture, id, ...patch });
  it('默认选总管，哪怕排在后面', () => {
    expect(pickDefaultOwnerId([member('a', { role: 'executor' }), member('b', { role: 'chief' })])).toBe('b');
  });
  it('没有总管就选第一位非建议风格的成员', () => {
    expect(pickDefaultOwnerId([member('a', { role: 'advisor' }), member('b', { role: 'researcher' })])).toBe('b');
  });
  it('反例：不在岗的总管不选，全是建议风格时选不出来', () => {
    expect(pickDefaultOwnerId([member('a', { role: 'chief', lifecycle: 'paused' }), member('b', { role: 'sentinel' })])).toBe('b');
    expect(pickDefaultOwnerId([member('a', { role: 'advisor' })])).toBeNull();
    expect(pickDefaultOwnerId([])).toBeNull();
  });
  it('建议风格不能当负责人，其他风格可以', () => {
    expect(() => assertOwnerEligible({ name: '军师', role: 'advisor' })).toThrow('建议风格');
    expect(() => assertOwnerEligible({ name: '小王', role: 'executor' })).not.toThrow();
  });
  it('只有项目记录的负责人能过身份检查', () => {
    expect(() => requireProjectOwnerBot({ name: 'P', ownerBotId: 'a' }, 'a')).not.toThrow();
    expect(() => requireProjectOwnerBot({ name: 'P', ownerBotId: 'a' }, 'b')).toThrow('负责人');
  });
});
