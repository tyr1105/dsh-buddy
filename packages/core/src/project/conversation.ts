/**
 * 项目对话（W1）：每个项目一条「项目对话」，主人在里面直接跟总管说话。
 *
 * 为什么用主题来做：主题本来就是「一条线程 + 一张进度表」（线程 id 就是主题 id），主人发言、叫人、轮次上限、
 * 兜底扫描都现成；项目对话只是一个特殊的主题（kind 写 conversation），区别只有三处：
 * - 主人在里面说的话交给总管，不交给项目负责人（topics.ts 的 responderOf）；
 * - 总管在这里提的约定默认放进这个项目，不再新建项目（agreements.ts 的 createNew）；
 * - 总管在这里被叫醒时，唤醒包带这个项目的上下文、在办的事和项目记忆（wake/conversation-section.ts）。
 *
 * 每个项目最多一条，第一次打开时建（ensureProjectConversation）；建的时候把总管加进项目成员：
 * 总管是协调者，要能在任何进行中的项目里说话、立约。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { recordId } from '../model/primitives.js';
import type { Bot } from '../model/bot.js';
import { PROJECT_STATUS_LABELS, ProjectTopicSchema, type Project, type ProjectTopic } from '../model/project.js';
import type { WakeTicket } from '../model/wake.js';
import { addProjectMembers } from '../job/members.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { liveChief } from '../team/roster.js';
import { newId } from '../util/ids.js';

/** 项目对话的标题（主题标题，界面显示在项目下第一行）。 */
export const PROJECT_CONVERSATION_TITLE = '项目对话';

/** 项目对话第一条中心旁白。 */
export function projectConversationNote(project: Pick<Project, 'name'>): string {
  return `这是项目「${project.name}」的项目对话：你在这里说的话交给总管；在这里提的事，默认放进这个项目。`;
}

/** 这个主题是不是项目对话。 */
export function isConversationTopic(topic: Pick<ProjectTopic, 'kind'> | null | undefined): boolean {
  return topic?.kind === 'conversation';
}

/** 这个项目的项目对话；还没建过返回 null。 */
export function projectConversationOf(ctx: HubContext, projectId: string): ProjectTopic | null {
  return ctx.store.table('projectTopics').list(row => row.projectId === projectId && row.kind === 'conversation')
    .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
}

/**
 * 取项目对话，没有就建一条。项目必须存在、没有归档；必须已经有总管（项目对话是跟总管说话的地方）。
 * 建的时候：总管不是项目成员就加进去（写审计）；第一条是中心旁白；不叫醒任何人。
 * 所有校验在写入之前做完，失败时不留半条记录、不耗随机数。
 */
export function ensureProjectConversation(ctx: HubContext, projectId: string): ProjectTopic {
  const project = ctx.store.table('projects').get(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const existing = projectConversationOf(ctx, projectId);
  if (existing) return existing;
  if (project.archivedAt !== null || project.status === 'archived') {
    throw new Error(`项目「${project.name}」当前是「${PROJECT_STATUS_LABELS[project.status]}」，不能再开项目对话`);
  }
  const chief = liveChief(ctx);
  if (!chief) throw new Error('还没有总管，项目对话要先有总管才能用');
  addProjectMembers(ctx, project.id, [chief.id], 'hub', { byConversation: true });
  const now = ctx.clock.now();
  const topic: ProjectTopic = ProjectTopicSchema.parse({
    id: newId('ptp', ctx.rng), projectId: project.id, title: PROJECT_CONVERSATION_TITLE, kind: 'conversation',
    createdAt: now, updatedAt: now, lastMessageAt: now, agentTurnsSinceOwner: 0, pendingBotIds: [],
  });
  ctx.store.table('projectTopics').put(topic);
  postThread(ctx, { thread: topic.id, from: 'hub', kind: 'system', text: projectConversationNote(project), refId: null });
  writeOutreachAudit(ctx, 'project_topic_create',
    { id: topic.id, projectId: project.id, title: topic.title, ownerBotId: chief.id, conversation: true }, 'hub', now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return ctx.store.table('projectTopics').get(topic.id)!;
}

/**
 * 这一回合是不是在某个项目的项目对话里：唤醒单带的主题是项目对话、项目还在进行中，返回那个项目；否则 null。
 * 约定提交和唤醒包都用它判断「在哪个项目里说话」。
 */
export function conversationProjectOfWake(ctx: HubContext, wake: Pick<WakeTicket, 'topicId'>): Project | null {
  if (!wake.topicId) return null;
  const topic = ctx.store.table('projectTopics').get(wake.topicId);
  if (!isConversationTopic(topic)) return null;
  const project = ctx.store.table('projects').get(topic!.projectId);
  return project !== null && project.status === 'active' ? project : null;
}

/** 总管在这个项目对话里：用于主题规则段（总管在项目对话里的写法与负责人不同）。 */
export function isChiefInConversation(bot: Pick<Bot, 'role'>, topic: Pick<ProjectTopic, 'kind'> | null): boolean {
  return bot.role === 'chief' && isConversationTopic(topic);
}

/** 打开项目对话的入参。 */
export const OpenProjectConversationSchema = z.strictObject({ projectId: recordId('prj') });

/** 界面命令：打开（必要时新建）项目对话，返回主题 id。 */
export function openProjectConversation(ctx: HubContext, raw: unknown): { topicId: string } {
  const input = parseInput(OpenProjectConversationSchema, raw, '打开项目对话');
  return { topicId: ensureProjectConversation(ctx, input.projectId).id };
}
