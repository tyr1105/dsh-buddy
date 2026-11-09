/**
 * 唤醒包「项目任务」段（v2 计划 3.4 派活，F12）。
 *
 * 为什么需要这一段：派活只建一条议程还不够——队友醒来时要直接看到
 * 「要做什么、按什么口径验收、东西放哪、最近交付到第几版」，才知道怎么干。
 *
 * 设计约束：
 * - 只读组装，不读时钟、不写存储；没有符合条件的任务就返回 null，整段不出现；
 * - 过滤口径与派活一致：项目必须进行中，任务必须是直接指派给这个队友的进行中/受阻任务；
 *   待办还没派、待验收/已通过不用再做，归档/暂停/完成项目里的活不带进唤醒包；
 * - 条数、验收项数、说明长度和产物条数都受 defaults 常量限制，总长度再由 fitSections 压缩；
 * - 返回 taskIds 供调用方把本轮真实 wakeId 追加到任务，账本与任务视图据此互相追溯。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { ArtifactVersion } from '../model/artifact.js';
import type { Project, ProjectTask } from '../model/project.js';
import { TASK_STATUS_LABELS } from '../model/project.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import type { PacketSection } from './sections.js';

/** 段落 + 本轮实际带入的任务 id；调用方用后者补 wakeIds。 */
export interface ProjectTasksSection {
  section: PacketSection;
  taskIds: string[];
}

/** 一条产物的最小展示信息：版本号 + 标题。路径、正文与指纹都不进唤醒包。 */
interface ArtifactBrief {
  number: number;
  title: string;
}

/** 按字数截断并加省略号；说明是给人看的叙述，不需要按字节精算。 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 把任务的 artifactIds 解析成最近版本：
 * - id 命中产物头：取该头下现存版本里 number 最大的；
 * - id 直接命中某版本：就用该版本；
 * - 悬空 id（头和版本都查不到）忽略，与项目视图 artifactCount 同一口径。
 * 同一产物只展示一次，最多给配置条数。
 */
function artifactBriefs(ctx: HubContext, ids: string[]): ArtifactBrief[] {
  const heads = new Set(ctx.store.table('artifactHeads').list().map(h => h.id));
  const byVersion = new Map<string, ArtifactVersion>();
  const latestByArtifact = new Map<string, ArtifactVersion>();
  for (const version of ctx.store.table('artifactVersions').list()) {
    byVersion.set(version.id, version);
    const old = latestByArtifact.get(version.artifactId);
    if (!old || version.number > old.number) latestByArtifact.set(version.artifactId, version);
  }
  const picked: ArtifactVersion[] = [];
  for (const id of ids) {
    const version = byVersion.get(id) ?? (heads.has(id) ? latestByArtifact.get(id) : undefined);
    if (!version) continue;
    if (picked.some(row => row.artifactId === version.artifactId)) continue;
    picked.push(version);
  }
  return picked
    .sort((a, b) => b.number - a.number)
    .slice(0, V2_DEFAULTS.PROJECT_TASKS_ARTIFACTS_MAX)
    .map(row => ({ number: row.number, title: row.title }));
}

/** 组装单条任务：标题、说明、验收口径、项目目录、最近产物，一行一件事。 */
function taskLines(ctx: HubContext, task: ProjectTask, project: Project): string {
  const open = project.acceptanceCriteria.filter(c => c.status === 'open');
  const shown = open.slice(0, V2_DEFAULTS.PROJECT_TASKS_CRITERIA_MAX);
  const criteria = shown.length === 0
    ? '项目暂无待满足的验收项'
    : shown.map(c => `${c.text}${c.verify ? `（验证：${c.verify}）` : ''}`).join('；')
      + (open.length > shown.length ? `；另有 ${open.length - shown.length} 条未列出` : '');
  const detail = task.detail.trim() ? clip(task.detail.trim(), V2_DEFAULTS.PROJECT_TASKS_DETAIL_MAX) : '暂无说明';
  const artifacts = artifactBriefs(ctx, task.artifactIds);
  return [
    `- 任务：${task.title}（项目「${project.name}」，${TASK_STATUS_LABELS[task.status]}，任务 ${task.id}）`,
    `  说明：${detail}`,
    `  验收口径：${criteria}`,
    `  项目目录：${project.sharedDir}`,
    `  最近产物：${artifacts.length === 0 ? '暂无' : artifacts.map(a => `v${a.number}「${a.title}」`).join('；')}`,
  ].join('\n');
}

/**
 * 为这个队友组装项目任务段；没有指派给他且正在进行的项目任务时返回 null。
 * 任务按截止时间从近到远，未设截止的排最后，同截止按创建时间；只取前 N 条。
 */
export function buildProjectTasksSection(ctx: HubContext, bot: Bot): ProjectTasksSection | null {
  const projects = new Map(
    ctx.store.table('projects').list(p => p.status === 'active').map(p => [p.id, p] as const),
  );
  const tasks = ctx.store.table('projectTasks').list(t =>
    (t.status === 'doing' || t.status === 'blocked')
    && t.assigneeBotId === bot.id
    && projects.has(t.projectId));
  if (tasks.length === 0) return null;

  const ordered = [...tasks].sort((a, b) => {
    const dueA = a.dueAt ?? Number.MAX_SAFE_INTEGER;
    const dueB = b.dueAt ?? Number.MAX_SAFE_INTEGER;
    return dueA - dueB || a.createdAt - b.createdAt;
  }).slice(0, V2_DEFAULTS.PROJECT_TASKS_PER_PACKET);

  return {
    section: {
      key: 'project-tasks',
      title: '## 你手上的项目任务（主人派的活）',
      body: ordered.map(task => taskLines(ctx, task, projects.get(task.projectId)!)).join('\n'),
    },
    taskIds: ordered.map(task => task.id),
  };
}
