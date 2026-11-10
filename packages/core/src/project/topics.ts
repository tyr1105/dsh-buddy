/**
 * 项目主题聊天的流程（P60/P63）：开主题、主人发言、队友说完之后叫谁、失败了怎么兜底。
 *
 * 一个主题就是一条线程（线程 id 就是主题 id），所有人看同一条聊天，回复线性往下盖。
 * 这里负责把事实写进存储并发出唤醒；「下一棒交给谁」的判断全部在 topic-rounds.ts 的纯函数里。
 *
 * 几条设计要点：
 * - 唤醒不经过感知层：感知收集器会把主人消息再排一条不带主题的唤醒，变成私聊里多叫一次。
 *   证据直接放线程消息 id，唤醒包凭 id 取原话，队友的话仍按不可信资料处理。
 * - subjectKey 带上消息 id：同一个主题反复讨论时，不能撞上「同一事项 6 小时冷却」。
 * - 全部唤醒标成主人发起：不等最短间隔、不占队友的自主额度；单次成本靠发言上限兜住。
 * - 任何一种回合结束（出错、超时、没回复、打断、被调度丢弃）都要把人移出等待名单，
 *   讨论绝不能卡死；tick 里还有一次兜底扫描，防止哪条路径漏掉。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import type { Bot } from '../model/bot.js';
import type { ThreadMessage } from '../model/outreach.js';
import { nonempty, recordId } from '../model/primitives.js';
import {
  PROJECT_STATUS_LABELS, ProjectTopicSchema, type Project, type ProjectTopic,
} from '../model/project.js';
import type { QueueEntry, WakeTicket } from '../model/wake.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { buildCandidate } from '../appraisal/think.js';
import { isBotOnTeam } from '../org/access.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { enqueue, removeEntry } from '../scheduler/queue.js';
import { isOpenWake } from '../turn/session.js';
import { newId } from '../util/ids.js';
import { optionalMessageText } from '../util/text.js';
import { pickDefaultOwnerId } from './owner-rules.js';
import { parseMentions } from './topic-mentions.js';
import { decideAfterAgentTurn, planOwnerTurn } from './topic-rounds.js';

/** 开主题入参：项目 + 第一句话；第一句话的第一行就是主题名。 */
export const CreateProjectTopicSchema = z.strictObject({
  projectId: recordId('prj'),
  text: nonempty.trim().min(1, '第一句话不能为空')
    .max(V2_DEFAULTS.TOPIC_MESSAGE_MAX_CHARS, `一条消息不能超过 ${V2_DEFAULTS.TOPIC_MESSAGE_MAX_CHARS} 字，长内容请放到项目目录再说路径`),
});

/** 主题名：取第一行，按完整字符截到上限，不把一个汉字或表情切成两半。 */
export function topicTitleFrom(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0]!.trim();
  return [...firstLine].slice(0, V2_DEFAULTS.TOPIC_TITLE_MAX_CHARS).join('');
}

/** 发言上限：设置里可调，这里再兜一次底，避免配成 0 时讨论一句话都说不了。 */
export function topicTurnCap(ctx: HubContext): number {
  return Math.max(1, ctx.settings.topicAgentTurnsPerOwnerMessage);
}

/** 这个线程 id 是不是项目主题。 */
export function isTopicThread(ctx: HubContext, threadId: string): boolean {
  return ctx.store.table('projectTopics').get(threadId) !== null;
}

/** 队友能不能看这个主题：只有项目成员能看，唤醒证据和账本都按这个口径核对归属。 */
export function botCanSeeTopic(ctx: HubContext, botId: string, topicId: string): boolean {
  const topic = ctx.store.table('projectTopics').get(topicId);
  return topic !== null && ctx.store.table('projects').get(topic.projectId)?.memberBotIds.includes(botId) === true;
}

/** 新开或继续讨论都要求项目进行中；暂停、完成、归档的项目不再叫醒任何人。 */
function requireActiveProject(ctx: HubContext, projectId: string): Project {
  const project = ctx.store.table('projects').get(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (project.status !== 'active') {
    throw new Error(`项目「${project.name}」当前是「${PROJECT_STATUS_LABELS[project.status]}」，恢复进行中后才能在里面讨论`);
  }
  return project;
}

/** 负责人 id：项目上记了就用记的，旧项目没记就按建项目时的同一条规则算一个。 */
function resolveOwnerId(ctx: HubContext, project: Project): string | null {
  if (project.ownerBotId !== null) return project.ownerBotId;
  const members = project.memberBotIds.map(id => ctx.store.table('bots').get(id)).filter(bot => bot !== null);
  return pickDefaultOwnerId(members);
}

/** 把算出来的默认负责人记回旧项目，之后项目页和工具权限都能看到同一个人。 */
function persistOwner(ctx: HubContext, project: Project, ownerId: string): void {
  if (project.ownerBotId === ownerId) return;
  const now = ctx.clock.now();
  ctx.store.table('projects').patch(project.id, { ownerBotId: ownerId, updatedAt: now });
  writeOutreachAudit(ctx, 'project_owner_default', { id: project.id, name: project.name, ownerBotId: ownerId }, 'hub', now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
}

/** 落一条中心说明：主题里的旁白，不算队友发言。 */
function systemNote(ctx: HubContext, topicId: string, text: string, refId: string | null = null): void {
  postThread(ctx, { thread: topicId, from: 'hub', kind: 'system', text, refId });
}

/** 被点名的人分成叫得醒的和叫不醒的；后者要告诉主人原因。 */
function splitMentions(project: Project, mentioned: readonly Bot[]): { reachable: Bot[]; note: string | null } {
  const reachable: Bot[] = [];
  const blocked: string[] = [];
  for (const bot of mentioned) {
    if (!project.memberBotIds.includes(bot.id)) blocked.push(`${bot.name}（不是项目成员）`);
    else if (!isBotOnTeam(bot)) blocked.push(`${bot.name}（现在不在岗）`);
    else reachable.push(bot);
  }
  return { reachable, note: blocked.length === 0 ? null : `点名的 ${blocked.join('、')} 这次没有叫醒。` };
}

/** 主题里最新一条主人原话；唤醒包要保证它一字不差地带上。 */
export function latestOwnerMessage(ctx: HubContext, topicId: string): ThreadMessage | null {
  return ctx.store.log('thread').recent(1, row => row.thread === topicId && row.from === 'owner')[0] ?? null;
}

/** 按字数截断，主题名进摘要时不把整段标题都带上。 */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

/**
 * 主题名写进唤醒摘要和队友活动句时的样子（截到上限加省略号）。
 * 界面靠活动句里的「主题「…」」认出谁正在回复这个主题，所以各处都用这一个写法（P65 回答后接着做也用它）。
 */
export function topicSummaryTitle(title: string): string {
  return clip(title, V2_DEFAULTS.TOPIC_SUMMARY_TITLE_CHARS);
}

/**
 * 叫醒一个队友。主人消息用 owner_message，队友点名用 peer_message，
 * 但都标成主人发起：这是主人开启的讨论，不该等最短间隔，也不占自主额度。
 * 证据里总带上最新主人原话，这样被队友点名的人也能看到主人到底要什么。
 */
function wakeTopicBot(ctx: HubContext, topic: ProjectTopic, botId: string, kind: 'owner_message' | 'peer_message', messageId: string): void {
  const latest = latestOwnerMessage(ctx, topic.id);
  const title = topicSummaryTitle(topic.title);
  enqueue(ctx, buildCandidate(ctx, {
    // 分数决定合并后算哪种理由：主人的话分数更高，排队中的同伴点名被它接管，回合才会要求必须回复主人。
    botId, kind, score: kind === 'owner_message' ? ctx.settings.c02.ownerSalience : ctx.settings.c02.replySalience,
    summary: kind === 'owner_message' ? `主人在主题「${title}」里发了消息` : `同伴在主题「${title}」里叫你接着说`,
    ownerSummary: kind === 'owner_message' ? `回复主题「${title}」` : `接着讨论主题「${title}」`,
    evidence: [...new Set([messageId, ...(latest ? [latest.id] : [])])],
    messageId, ownerInitiated: true,
    // 带消息 id：同一主题的每句话都是新事项，不会被 6 小时冷却拦住。
    subjectKey: `topic:${topic.id}:${messageId}`,
    topicId: topic.id,
  }));
}

/** 主人这句话要叫谁：只做判断和校验，失败时什么都没写，不留半条记录。 */
function planOwnerMessage(ctx: HubContext, project: Project, text: string) {
  const ownerId = resolveOwnerId(ctx, project);
  if (ownerId === null) {
    throw new Error('这个项目还没有能当负责人的成员，请先在项目设置里加一位在岗的队友（建议风格不能当负责人）');
  }
  const { reachable, note } = splitMentions(project, parseMentions(text, ctx.store.table('bots').list()));
  const owner = ctx.store.table('bots').get(ownerId);
  const plan = planOwnerTurn({
    ownerBotId: ownerId, ownerOnDuty: owner !== null && isBotOnTeam(owner),
    mentions: reachable.map(bot => bot.id), cap: topicTurnCap(ctx),
  });
  const ownerName = owner?.name ?? '已删除的队友';
  const ownerNote = plan.ownerUnavailable ? `负责人「${ownerName}」现在不在岗，消息已保留；等它恢复后再说一句，或 @ 在岗的队友。` : null;
  return { ownerId, ownerName, targets: plan.targets, notes: [note, ownerNote].filter(item => item !== null) };
}

/**
 * 主人的话落楼并开启新一轮：发言计数清零，等待名单换成这次叫的人。
 * 上一轮排队还没开始的唤醒，如果这次没被点到就取消：主人已经换了话题或换了人。
 */
function deliverOwnerMessage(ctx: HubContext, topic: ProjectTopic, text: string, plan: ReturnType<typeof planOwnerMessage>): ThreadMessage {
  const message = postThread(ctx, { thread: topic.id, from: 'owner', kind: 'chat', text });
  ctx.runtime.ownerActiveAt = ctx.clock.now();
  for (const entry of ctx.store.table('queue').list(row => row.topicId === topic.id && !plan.targets.includes(row.botId))) {
    removeEntry(ctx, entry.id);
  }
  ctx.store.table('projectTopics').patch(topic.id, { agentTurnsSinceOwner: 0, pendingBotIds: plan.targets, updatedAt: ctx.clock.now() });
  for (const note of plan.notes) systemNote(ctx, topic.id, note, message.id);
  for (const botId of plan.targets) wakeTopicBot(ctx, topic, botId, 'owner_message', message.id);
  return message;
}

/**
 * 在项目里开一个主题：第一句话就是主题，消息自动送给负责人或被 @ 的队友。
 * 所有校验都在写入之前做完，失败时不留半条记录，也不消耗随机数。
 */
export function createProjectTopic(ctx: HubContext, raw: unknown): { topicId: string } {
  const input = parseInput(CreateProjectTopicSchema, raw, '新开主题');
  const project = requireActiveProject(ctx, input.projectId);
  const plan = planOwnerMessage(ctx, project, input.text);
  // 新开主题时一个能接话的人都没有，建出来也只是一条没人回的空话，直接报错让主人先处理。
  if (plan.targets.length === 0) throw new Error(`负责人「${plan.ownerName}」现在不在岗，请先恢复它，或在项目设置里换一位负责人`);
  persistOwner(ctx, project, plan.ownerId);
  const now = ctx.clock.now();
  const topic: ProjectTopic = ProjectTopicSchema.parse({
    id: newId('ptp', ctx.rng), projectId: project.id, title: topicTitleFrom(input.text),
    createdAt: now, updatedAt: now, lastMessageAt: now, agentTurnsSinceOwner: 0, pendingBotIds: [],
  });
  ctx.store.table('projectTopics').put(topic);
  writeOutreachAudit(ctx, 'project_topic_create', { id: topic.id, projectId: project.id, title: topic.title, ownerBotId: plan.ownerId }, 'owner', now);
  deliverOwnerMessage(ctx, topic, input.text, plan);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return { topicId: topic.id };
}

/** 主人在已有主题里接着说（sendMessage 走到这里）。 */
export function sendOwnerTopicMessage(ctx: HubContext, topicId: string, text: string): ThreadMessage {
  const topic = ctx.store.table('projectTopics').get(topicId);
  if (!topic) throw new Error(`主题不存在：${topicId}`);
  if ([...text].length > V2_DEFAULTS.TOPIC_MESSAGE_MAX_CHARS) {
    throw new Error(`一条消息不能超过 ${V2_DEFAULTS.TOPIC_MESSAGE_MAX_CHARS} 字，长内容请放到项目目录再说路径`);
  }
  const project = requireActiveProject(ctx, topic.projectId);
  const plan = planOwnerMessage(ctx, project, text);
  persistOwner(ctx, project, plan.ownerId);
  return deliverOwnerMessage(ctx, topic, text, plan);
}

/** 回合的结局：说了话（带原文，用来解析 @），或者没说话（可带一句给主人看的说明）。 */
export type TopicTurnEnd = { kind: 'spoke'; text: string } | { kind: 'silent'; note: string | null };

/** 这个主题里最后一条讨论内容；接棒的人凭它定位「说到哪了」。 */
function latestFloorId(ctx: HubContext, topicId: string): string | null {
  return ctx.store.log('thread').recent(1, row => row.thread === topicId && row.kind !== 'system')[0]?.id ?? null;
}

/**
 * 一个队友这一棒结束后推进讨论：按纯函数的判断改状态、取消排队、落提示、叫下一棒。
 * 没说话的人如果不在等待名单里，说明没人在等它（比如主人已经开启了新一轮），不用推进。
 */
export function advanceTopicTurn(ctx: HubContext, topicId: string, botId: string, end: TopicTurnEnd): void {
  const topic = ctx.store.table('projectTopics').get(topicId);
  if (!topic) return;
  const spoke = end.kind === 'spoke';
  if (!spoke && !topic.pendingBotIds.includes(botId)) return;
  if (end.kind === 'silent' && end.note !== null) systemNote(ctx, topicId, end.note);

  const project = ctx.store.table('projects').get(topic.projectId);
  const now = ctx.clock.now();
  // 项目中途暂停或归档：只把人移出名单，不再叫任何人。
  if (!project || project.status !== 'active') {
    ctx.store.table('projectTopics').patch(topicId, { pendingBotIds: topic.pendingBotIds.filter(id => id !== botId), updatedAt: now });
    return;
  }

  const roster = ctx.store.table('bots').list();
  const { reachable, note } = spoke
    ? splitMentions(project, parseMentions(end.text, roster).filter(bot => bot.id !== botId))
    : { reachable: [], note: null };
  const ownerId = resolveOwnerId(ctx, project) ?? '';
  const owner = roster.find(bot => bot.id === ownerId);
  const cap = topicTurnCap(ctx);
  const decision = decideAfterAgentTurn({
    ownerBotId: ownerId, ownerOnDuty: owner !== undefined && isBotOnTeam(owner),
    speakerId: botId, spoke, mentions: reachable.map(bot => bot.id),
    pending: topic.pendingBotIds,
    running: ctx.store.table('wakes').list(wake => wake.topicId === topicId && wake.botId !== botId && isOpenWake(wake)).map(wake => wake.botId),
    speakerStillQueued: ctx.store.table('queue').count(row => row.topicId === topicId && row.botId === botId) > 0,
    turns: topic.agentTurnsSinceOwner, cap,
  });

  ctx.store.table('projectTopics').patch(topicId, { agentTurnsSinceOwner: decision.turns, pendingBotIds: decision.pending, updatedAt: now });
  if (decision.cancelQueuedExcept !== null) {
    const keep = decision.cancelQueuedExcept;
    for (const entry of ctx.store.table('queue').list(row => row.topicId === topicId && !keep.includes(row.botId))) removeEntry(ctx, entry.id);
  }
  if (note !== null) systemNote(ctx, topicId, note);
  if (decision.ownerUnavailable) {
    systemNote(ctx, topicId, `需要负责人「${owner?.name ?? '已删除的队友'}」接着说，但它现在不在岗，这一轮先停在这里，等你下一句。`);
  }
  if (decision.reachedCap) systemNote(ctx, topicId, `这轮讨论已到 ${cap} 次发言，等你下一句`);
  const messageId = latestFloorId(ctx, topicId);
  if (messageId !== null) for (const target of decision.wake) wakeTopicBot(ctx, topic, target, 'peer_message', messageId);
}

/** 队友的话按「回复 + 汇报」算：两段都可能 @ 人，只算一次发言。 */
function spokenText(reply: string | null, report: string | null): string | null {
  const parts = [optionalMessageText(reply), optionalMessageText(report)].filter(part => part !== null);
  return parts.length === 0 ? null : parts.join('\n');
}

/** 回合正常收尾（含出错、超时、没交账）时推进讨论：finishTurn 是唯一同时看到终态和交账的位置。 */
export function settleFinishedTopicWake(ctx: HubContext, wake: WakeTicket): void {
  if (!wake.topicId) return;
  const name = ctx.store.table('bots').get(wake.botId)?.name ?? '这位队友';
  const commit = wake.commitId ? ctx.store.table('commits').get(wake.commitId) : null;
  const spoken = commit && !wake.syntheticCommit ? spokenText(commit.reply, commit.report) : null;
  if (spoken !== null) {
    advanceTopicTurn(ctx, wake.topicId, wake.botId, { kind: 'spoke', text: spoken });
    return;
  }
  // 主人消息叫醒却没交账时，交账路由已经落过「机器人没有回复」；主人直聊的回复也已经落楼，这里都不再重复。
  const routed = wake.ownerDirect === true || (wake.syntheticCommit === true && wake.reason.kind === 'owner_message');
  const note = routed ? null : commit && !wake.syntheticCommit ? `${name} 看过了，这次没有要补充的。` : `${name} 这次没有接上，这一棒先跳过。`;
  advanceTopicTurn(ctx, wake.topicId, wake.botId, { kind: 'silent', note });
}

/** 投递失败（根本没开始想）时跳过这一棒。 */
export function settleFailedTopicDelivery(ctx: HubContext, topicId: string, botId: string): void {
  const name = ctx.store.table('bots').get(botId)?.name ?? '这位队友';
  advanceTopicTurn(ctx, topicId, botId, { kind: 'silent', note: `${name} 这次没有接上，这一棒先跳过。` });
}

/** 排队中的唤醒被调度丢弃（队友暂停、退役、隔离）时跳过这一棒。 */
export function settleDroppedTopicEntry(ctx: HubContext, entry: QueueEntry): void {
  if (!entry.topicId) return;
  const name = ctx.store.table('bots').get(entry.botId)?.name ?? '这位队友';
  advanceTopicTurn(ctx, entry.topicId, entry.botId, { kind: 'silent', note: `${name} 现在不在岗，这一棒先跳过。` });
}

/**
 * 主人打断：只把这个队友移出等待名单，不自动叫下一棒。
 * 主人按了停止就是不想让它继续，这时候再叫负责人出来说话是添乱；想继续主人会再说一句。
 */
export function settleInterruptedTopicWake(ctx: HubContext, wake: WakeTicket): void {
  if (!wake.topicId) return;
  const topic = ctx.store.table('projectTopics').get(wake.topicId);
  if (!topic) return;
  const stillQueued = ctx.store.table('queue').count(row => row.topicId === topic.id && row.botId === wake.botId) > 0;
  if (stillQueued) return;
  ctx.store.table('projectTopics').patch(topic.id, { pendingBotIds: topic.pendingBotIds.filter(id => id !== wake.botId), updatedAt: ctx.clock.now() });
}

/**
 * 兜底扫描：等待名单里的人如果既没排队也没在跑，说明某条路径漏了收尾。
 * 每分钟扫一次，把这种人当作「没接上」处理，保证讨论不会永远卡住。
 */
export function sweepStuckTopics(ctx: HubContext): void {
  for (const topic of ctx.store.table('projectTopics').list(row => row.pendingBotIds.length > 0)) {
    for (const botId of topic.pendingBotIds) {
      const queued = ctx.store.table('queue').count(row => row.topicId === topic.id && row.botId === botId) > 0;
      const open = ctx.store.table('wakes').count(wake => wake.topicId === topic.id && wake.botId === botId && isOpenWake(wake)) > 0;
      if (!queued && !open) settleFailedTopicDelivery(ctx, topic.id, botId);
    }
  }
}

/**
 * 这个队友正在进行的主题回合属于哪个主题；不在主题回合里返回 null。
 * P65：审批单和工具提的建议靠它记下「是在哪个主题里提出的」，和下面那句主题提示用同一个口径，
 * 提示落在哪个主题，事项就记哪个主题，主人处理后队友才会回到同一个地方接着说。
 */
export function topicIdOfOpenWake(ctx: HubContext, botId: string): string | null {
  const wake = ctx.store.table('wakes').list(row => row.botId === botId && Boolean(row.topicId) && isOpenWake(row))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  return wake?.topicId ?? null;
}

/** 收件箱和审批的去处不变，只在主题里留一句提示，让主人知道这边在等什么。 */
export function noteTopicOfOpenWake(ctx: HubContext, botId: string, text: string, refId: string | null = null): void {
  const topicId = topicIdOfOpenWake(ctx, botId);
  if (topicId) systemNote(ctx, topicId, text, refId);
}
