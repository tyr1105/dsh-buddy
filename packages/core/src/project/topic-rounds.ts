/**
 * 主题讨论的「下一棒交给谁」（P63，纯函数）。
 *
 * 主题里队友可以互相 @ 接力，所以必须有刹车，否则两个队友能互相叫醒到额度用光。
 * 规则全部写在这里，输入显式给当前状态，同样的输入永远得到同样的结果，方便逐条单测：
 *
 * 1. 主人说话时清零：谁被 @ 且在岗就叫谁，没人可叫就叫负责人（planOwnerTurn）。
 * 2. 队友说完（decideAfterAgentTurn）：
 *    - @ 了在岗的其他成员：叫醒他们，并加入「还在等谁」；
 *    - 没 @ 人：把自己移出等待名单；名单空了时，发言者不是负责人就叫负责人，
 *      发言者是负责人就结束这一轮，等主人下一句；
 *    - 失败或没回复也走同一条路，不计发言次数，但一定把自己移出名单，讨论不能卡死。
 * 3. 上限 cap：累计到 cap-1 时不管有没有 @，下一棒只给负责人（它要收尾）；
 *    累计到 cap 后不再叫任何人。已经在路上的回合不打断，让它把话说完。
 */

/** 队友说完之后的判断输入：全是当前事实，纯函数不碰存储。 */
export interface TopicTurnInput {
  ownerBotId: string;
  /** 负责人现在能不能被叫醒；不能时要告诉主人，而不是默默停住。 */
  ownerOnDuty: boolean;
  speakerId: string;
  /** 这一回合有没有真的发言；失败、超时、没回复都是 false。 */
  spoke: boolean;
  /** 被点名的人：已过滤成在岗的其他成员。 */
  mentions: readonly string[];
  pending: readonly string[];
  /** 这个主题里已经在跑回合的人，他们的话拦不住，只能等他们说完。 */
  running: readonly string[];
  /** 发言者还有一次排着队的唤醒（主人刚又叫了它），那它仍然算在等待名单里。 */
  speakerStillQueued: boolean;
  turns: number;
  cap: number;
}

/** 判断结果：调用方照着改主题状态、发唤醒、落提示，不再做规则判断。 */
export interface TopicTurnDecision {
  turns: number;
  pending: string[];
  /** 这一步要新叫醒的人。 */
  wake: string[];
  /** 非 null 时取消这个主题里排队中的唤醒，名单里的人除外。 */
  cancelQueuedExcept: string[] | null;
  /** 这一步刚好把讨论停在上限，要落一条「等你下一句」。 */
  reachedCap: boolean;
  /** 需要负责人接棒，但负责人不在岗。 */
  ownerUnavailable: boolean;
}

/** 空结果模板：各分支只写自己不同的字段，读起来一眼看出差异。 */
function decision(turns: number, pending: readonly string[], patch: Partial<TopicTurnDecision> = {}): TopicTurnDecision {
  return { turns, pending: [...pending], wake: [], cancelQueuedExcept: null, reachedCap: false, ownerUnavailable: false, ...patch };
}

/** 队友这一回合结束后，下一棒交给谁。 */
export function decideAfterAgentTurn(input: TopicTurnInput): TopicTurnDecision {
  const { ownerBotId, speakerId, spoke, mentions, cap, running } = input;
  const turns = input.turns + (spoke ? 1 : 0);
  // 发言者说完就离开等待名单；唯一例外是它还有新的唤醒在排队，主人还在等它。
  const others = input.pending.filter(id => id !== speakerId || input.speakerStillQueued);
  // 上限附近只保留拦不住的人（已在跑的）和负责人，排队中还没开始的都取消。
  const inFlight = others.filter(id => running.includes(id));

  // 已到上限：不再叫任何人。负责人收尾那一棒如果已经在路上，让它说完，主人才有结论。
  if (turns >= cap) {
    const left = others.filter(id => running.includes(id) || id === ownerBotId);
    // 提示只落一次：讨论早已停住时，迟到的发言不再重复提醒。
    const stopsNow = left.length === 0 && (input.turns < cap || input.pending.length > 0);
    return decision(turns, left, { cancelQueuedExcept: [ownerBotId], reachedCap: stopsNow });
  }

  // 刚走到倒数第一次发言：下一棒只能是负责人，由它收尾给主人结论。
  if (spoke && turns === cap - 1) {
    const ownerEnded = speakerId === ownerBotId && mentions.length === 0;
    if (ownerEnded) return decision(turns, inFlight, { cancelQueuedExcept: [] });
    if (!input.ownerOnDuty) return decision(turns, inFlight, { cancelQueuedExcept: [], ownerUnavailable: true });
    if (inFlight.includes(ownerBotId)) return decision(turns, inFlight, { cancelQueuedExcept: [ownerBotId] });
    return decision(turns, [...inFlight, ownerBotId], { wake: [ownerBotId], cancelQueuedExcept: [ownerBotId] });
  }

  // 常规点名：叫醒被点到的人，继续等名单里的其他人。
  if (mentions.length > 0) {
    return decision(turns, [...new Set([...others, ...mentions])], { wake: [...mentions] });
  }
  // 还有人没说完：等他们汇合，最后一个说完的人负责把话题交回负责人。
  if (others.length > 0) return decision(turns, others);
  // 名单空了：负责人说完就结束这一轮，等主人下一句。
  if (speakerId === ownerBotId) return decision(turns, []);
  if (!input.ownerOnDuty) return decision(turns, [], { ownerUnavailable: true });
  return decision(turns, [ownerBotId], { wake: [ownerBotId] });
}

/** 主人说话时叫谁的判断输入。 */
export interface OwnerTurnInput {
  ownerBotId: string;
  ownerOnDuty: boolean;
  /** 被点名且在岗的项目成员。 */
  mentions: readonly string[];
  cap: number;
}

/**
 * 主人说话时叫谁：点名了在岗成员就叫他们，否则叫负责人。
 * cap 设成 1 时只有一次发言机会，只能留给负责人收尾，点名也不生效。
 * 返回 ownerUnavailable 时没有任何人可叫，调用方要告诉主人。
 */
export function planOwnerTurn(input: OwnerTurnInput): { targets: string[]; ownerUnavailable: boolean } {
  const useMentions = input.mentions.length > 0 && input.cap > 1;
  if (useMentions) return { targets: [...input.mentions], ownerUnavailable: false };
  return input.ownerOnDuty ? { targets: [input.ownerBotId], ownerUnavailable: false } : { targets: [], ownerUnavailable: true };
}

/** 这个累计次数下，下一次发言是不是最后一次（唤醒包据此写明要收尾）。 */
export function isFinalTurn(turns: number, cap: number): boolean {
  return turns >= cap - 1;
}
