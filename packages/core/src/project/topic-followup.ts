/**
 * P65：「待你处理」里来自项目主题的事项，主人处理之后，队友接着做的那一回合回到原来的主题。
 *
 * 为什么要做：队友在主题里提问、申请审批、提建议，卡片会进「待你处理」。主人在那里处理后，
 * 原来接着做的那一回合不带主题，回复落进队友私聊，读主题的人看不到后续（看板问题 I22）。
 *
 * 做法只给原有的「回答后接着做」补上主题信息，不另起一套流程：
 * 1. 事项产生时记下来源主题：收件箱项和审批单上的可选字段 topicId（旧数据没有，按不属于主题处理）；
 * 2. 主人亲手处理后，原来那条后续候选带上 topicId，并和主题里其他回合一样标成主人发起：
 *    不等最短间隔、不占队友的自主额度；主题回合本来就不计窗口回合、账本照记，这里自然沿用；
 * 3. 主题里落一句中心旁白「你回答了……」「你批准了……」，读主题的人能看懂前因后果；旁白不叫醒任何人；
 * 4. 主人的处理算主人在这个主题里说了一句：发言计数清零，等待名单加上这位队友。
 *    但只叫这一位：主人发消息没 @ 人时会交给负责人，这里不这样做；
 *    别人正在接力的回合也不取消，主人只是处理了一件事，不是换了话题；
 * 5. 主题查不到、项目不在进行中（暂停、完成、归档）、队友已不是项目成员或不在岗时，
 *    不回主题，调用方照旧落私聊、不报错。到期按默认处理不是主人的回答，调用方也不走这里。
 *
 * 这个文件只管「回不回主题、回去时改哪些状态」；提问、建议的回答在 outreach/inbox.ts，
 * 审批的决定在 gate/approvals.ts，它们各自调用这里。
 */
import type { HubContext } from '../engine/context.js';
import type { Candidate } from '../appraisal/think.js';
import type { InboxItem } from '../model/outreach.js';
import type { ProjectTopic } from '../model/project.js';
import type { QueueEntry } from '../model/wake.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { isBotOnTeam } from '../org/access.js';
import { postThread } from '../outreach/thread.js';
import { enqueue } from '../scheduler/queue.js';
import { topicSummaryTitle } from './topics.js';

/** 按完整字符截断，超出时加省略号，不把一个汉字或表情切成两半。 */
function clip(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

/**
 * 主人处理之后还能不能回到这个主题。下面任何一条不满足就返回 null，调用方照旧落私聊：
 * - 事项记着来源主题，而且主题还在（删除了就回不去）；
 * - 项目还在进行中：暂停、完成、归档的项目不再叫醒任何人，和主题里发消息的规则一致；
 * - 队友还是项目成员：已经被移出项目的人看不到这个主题，唤醒包也带不上主题内容；
 * - 队友在岗：不在岗的唤醒会被调度丢掉，主题会按「这一棒跳过」把话交给负责人，
 *   等于主人回答了一个问题却叫醒了别人，所以这种情况也照旧落私聊。
 */
export function followUpTopic(ctx: HubContext, botId: string | null, topicId: string | null | undefined): ProjectTopic | null {
  if (!botId || !topicId) return null;
  const topic = ctx.store.table('projectTopics').get(topicId);
  if (!topic) return null;
  const project = ctx.store.table('projects').get(topic.projectId);
  if (!project || project.status !== 'active' || !project.memberBotIds.includes(botId)) return null;
  const bot = ctx.store.table('bots').get(botId);
  return bot !== null && isBotOnTeam(bot) ? topic : null;
}

/**
 * 回答提问、处理建议之后，后续候选要补的主题字段：属于哪个主题、算主人发起、摘要里写明主题。
 * 给主人看的那句会显示成队友的活动（「正在处理：按你的回复接着做主题「…」」），
 * 界面靠里面的「主题「…」」认出这位队友正在回复这个主题，所以主题名用和其他主题回合同一个截法。
 */
export function topicReplyFields(topic: ProjectTopic): { topicId: string; ownerInitiated: true; summary: string; ownerSummary: string } {
  const title = topicSummaryTitle(topic.title);
  return {
    topicId: topic.id,
    ownerInitiated: true,
    // 主人可能在「待你处理」里答，也可能直接点主题里的卡片答，这里不写在哪答的。
    summary: `主人回复了你在主题「${title}」里提的事，接着做`,
    ownerSummary: `按你的回复接着做主题「${title}」`,
  };
}

/**
 * 主题里那句旁白（提问、建议）：说清主人怎么处理的。
 * 标题和回答都截短，完整内容在卡片上；审批的旁白直接用审批结果那句「你批准了：……」。
 */
export function followUpNoteText(item: Pick<InboxItem, 'type' | 'title'>, answer: string): string {
  const title = clip(item.title, V2_DEFAULTS.TOPIC_FOLLOWUP_TITLE_CHARS);
  // 主题里对建议一直叫「建议」（「它提了 N 条建议」），这里沿用同一个叫法。
  if (item.type === 'proposal') return answer === '接受' ? `你接受了建议「${title}」。` : `你没有采纳建议「${title}」。`;
  return `你回答了「${title}」：${clip(answer, V2_DEFAULTS.TOPIC_FOLLOWUP_ANSWER_CHARS)}`;
}

/** startTopicFollowUp 的输入。 */
export interface TopicFollowUpInput {
  /** 要回的主题：调用方先用 followUpTopic 确认过还能回。 */
  topic: ProjectTopic;
  /** 原来那条「回答后接着做」的候选，已带好主题字段；回复感知没记下来（去重）时为 null，只落旁白。 */
  candidate: Candidate | null;
  /** 回复感知 id：要标成已评估，见下面的说明。 */
  perceptId: string | null;
  /** 主题里那句旁白。 */
  note: string;
  /** 旁白关联的业务记录：收件箱项或审批单 id。 */
  refId: string;
}

/**
 * 把主人的处理落进主题，并排上后续回合：
 * 1. 先落旁白：不管后面排没排上队，主人做了什么都要在主题里看得到；
 * 2. 候选按（队友, 主题）排队：同一位队友在这个主题里已经排着的唤醒会合并成一条，不会多叫一次；
 * 3. 排上了才推进主题：
 *    - 回复感知标成已评估。感知收集器只处理没评估过的感知，不标的话它会照旧再排一条不带主题的
 *      私聊唤醒，同一个回答叫醒两次；
 *    - 发言计数清零（主人说了一句），等待名单加上这位队友（不替换名单，别人的接力照常）。
 *    排不上就不改名单：讨论不能等一个不会来的人。
 */
export function startTopicFollowUp(ctx: HubContext, input: TopicFollowUpInput): QueueEntry | null {
  const { topic, candidate } = input;
  postThread(ctx, { thread: topic.id, from: 'hub', kind: 'system', text: input.note, refId: input.refId });
  if (!candidate) return null;
  const queued = enqueue(ctx, { ...candidate, topicId: topic.id });
  if (!queued) return null;
  const now = ctx.clock.now();
  const percept = input.perceptId ? ctx.store.table('percepts').get(input.perceptId) : null;
  if (percept && percept.evaluatedAt === undefined) ctx.store.table('percepts').patch(percept.id, { evaluatedAt: now });
  // 落旁白时主题的最后消息时间已经更新过，这里重新读一次，只改计数和名单。
  const current = ctx.store.table('projectTopics').get(topic.id) ?? topic;
  ctx.store.table('projectTopics').patch(topic.id, {
    agentTurnsSinceOwner: 0,
    pendingBotIds: [...new Set([...current.pendingBotIds, candidate.botId])],
    updatedAt: now,
  });
  return queued;
}
