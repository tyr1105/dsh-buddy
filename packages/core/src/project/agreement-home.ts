/**
 * 为约定建「家」（P72a）：约定要挂在一个项目的一个主题上，这里负责把项目和主题建出来。
 *
 * 设计要点：
 * - 总管指定了项目就放进那个项目（必须进行中、总管是成员），不新建项目；没指定就为这件事新建一个，
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
import { pickDefaultOwnerId } from './owner-rules.js';
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
): Promise<{ project: Project; topic: ProjectTopic }> {
  let project: Project;
  if (input.projectId !== undefined) {
    // 用已有项目：必须存在、进行中、总管是成员；一项不满足就报错，什么都不写。
    const found = ctx.store.table('projects').get(input.projectId);
    if (!found || found.status !== 'active' || !found.memberBotIds.includes(chief.id)) {
      throw new Error('projectId：项目不存在、不在进行中，或你不是成员');
    }
    // P72g A4：约定只能建在总管自己负责的项目里。负责人不是总管时，主人在主题里说的话会交给负责人而不是总管，
    // 总管收不到「定了」，也改不了约定。旧项目没记负责人时按建项目时的同一条规则算一个。
    const members = found.memberBotIds.map(id => ctx.store.table('bots').get(id)).filter(bot => bot !== null);
    const responsible = found.ownerBotId ?? pickDefaultOwnerId(members);
    if (responsible !== chief.id) {
      throw new Error('projectId：约定只能放进你自己负责的项目；这个项目的负责人不是你。不带 projectId，由中心为这件事新建一个项目');
    }
    project = found;
  } else {
    // 新建项目：审计里记总管 id（不是 owner），因为是总管替主人起的头。
    project = saveProject(ctx, {
      name: input.title, charter: input.summary, memberBotIds: [chief.id], ownerBotId: chief.id,
    }, chief.id);
    await ensureProjectSharedDir(ctx, project);
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
  return { project, topic: ctx.store.table('projectTopics').get(topic.id)! };
}
