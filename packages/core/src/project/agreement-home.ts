/**
 * 为约定建「家」（P72a）：约定要挂在一个项目的一个主题上，这里负责把项目和主题建出来。
 *
 * 设计要点：
 * - 总管指定了项目就放进那个项目（必须进行中；W1 起不要求总管是成员或负责人，不是成员就加进去），不新建项目；没指定就为这件事新建一个，
 *   项目名取约定标题、成员只有总管、负责人是总管；
 * - 主题第一条楼层是中心旁白，说明「约定确认前不会开工」；
 * - 这里不叫醒任何人、不写主人消息：开工前先对齐，主题里暂时没人说话；
 * - 所有校验先于任何写入（项目的校验也在 saveProject 里先于取随机数），失败时不留半条记录。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import { ProjectTopicSchema, type Project, type ProjectTopic } from '../model/project.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { newId } from '../util/ids.js';
import { addProjectMembers } from '../job/members.js';
import { saveProject } from './service.js';
import { ensureProjectSharedDir } from './shared-dir.js';

/** 主题里的第一条中心旁白。 */
export const AGREEMENT_TOPIC_NOTE = '总管为这件事建立了主题。约定确认前不会开工。';
/** P72h H5：约定已固定后，同一条旁白显示的文字（存储里的原文不改，只在视图里按约定状态换）。 */
export const AGREEMENT_TOPIC_NOTE_LOCKED = '总管为这件事建立了主题。约定已固定。';
/** 约定被撤下或已不存在时的旁白：只留事实，不再写「确认前不会开工」。 */
export const AGREEMENT_TOPIC_NOTE_PLAIN = '总管为这件事建立了主题。';

/** 按约定当前状态给出旁白文字：待确认沿用原文，已固定写已固定，没有约定（已撤下）只留事实。 */
export function topicNoteTextFor(state: 'pending' | 'locked' | null): string {
  if (state === 'pending') return AGREEMENT_TOPIC_NOTE;
  return state === 'locked' ? AGREEMENT_TOPIC_NOTE_LOCKED : AGREEMENT_TOPIC_NOTE_PLAIN;
}

/**
 * 给约定建项目（可选）和主题。
 * @param chief 总管（调用方已确认是 chief）
 * @param input title 约定标题；summary 一句话复述（新建项目时当作项目目标）；projectId 可选，放进已有项目
 */
export async function createAgreementHome(
  ctx: HubContext, chief: Bot, input: { title: string; summary: string; projectId?: string },
): Promise<{ project: Project; topic: ProjectTopic; created: boolean }> {
  let project: Project;
  let created = false;
  if (input.projectId !== undefined) {
    // 用已有项目：必须存在、进行中；一项不满足就报错，什么都不写。
    // W1：不再要求总管是成员、是负责人（P72g A4 那条限制已放开）。总管是协调者，任何进行中的项目里都能立约：
    // 不是成员就加进成员名单；主人在约定主题里说的话按约定交给总管（topics.ts 的 responderOf），不再交给负责人。
    const found = ctx.store.table('projects').get(input.projectId);
    if (!found || found.status !== 'active') {
      throw new Error('projectId：项目不存在或不在进行中');
    }
    addProjectMembers(ctx, found.id, [chief.id], chief.id, { byAgreement: true });
    project = ctx.store.table('projects').get(found.id)!;
  } else {
    // 新建项目：审计里记总管 id（不是 owner），因为是总管替主人起的头。
    project = saveProject(ctx, {
      name: input.title, charter: input.summary, memberBotIds: [chief.id], ownerBotId: chief.id,
    }, chief.id);
    await ensureProjectSharedDir(ctx, project);
    created = true;
  }

  // 主题：计数为 0、等待名单为空，不叫醒任何人。
  const now = ctx.clock.now();
  const topic: ProjectTopic = ProjectTopicSchema.parse({
    id: newId('ptp', ctx.rng), projectId: project.id, title: input.title,
    createdAt: now, updatedAt: now, lastMessageAt: now, agentTurnsSinceOwner: 0, pendingBotIds: [],
  });
  ctx.store.table('projectTopics').put(topic);
  postThread(ctx, { thread: topic.id, from: 'hub', kind: 'system', text: AGREEMENT_TOPIC_NOTE, refId: null });
  writeOutreachAudit(ctx, 'project_topic_create',
    { id: topic.id, projectId: project.id, title: topic.title, ownerBotId: chief.id, byAgreement: true }, chief.id, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return { project, topic: ctx.store.table('projectTopics').get(topic.id)!, created };
}
