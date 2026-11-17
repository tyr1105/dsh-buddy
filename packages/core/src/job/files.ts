/**
 * 一件事的主题文件（P74b）：派活时由中心写进主题文件夹的三份文本，以及「哪些文件不许覆盖」的判断。
 *
 * 为什么由中心生成、不让总管写：执行者要照约定做，约定的原文、主人的原话和草图必须与存储里的记录完全一致，
 * 总管转述一遍就可能漏条目、改措辞。中心从约定版本里原样抄出，序号与唤醒包、回答出处里的序号一致（从 1 起）。
 *
 * 文件夹结构（相对项目文件夹）：
 *   jobs/<jobId>/约定.md   当前已固定版本的全文（中心写）
 *   jobs/<jobId>/原话.md   这份约定每一版依据的主人原话（中心写）
 *   jobs/<jobId>/草图.md   草图的文字版（中心写）
 *   jobs/<jobId>/材料/     总管转交的主人材料（中心写，P74e）
 *   jobs/<jobId>/交付/     产出物（执行者用 hub_project_put 放）
 *   jobs/<jobId>/证据/     截图、测试日志（执行者用 hub_project_put 放）
 *
 * 纯函数负责生成文本；唯一碰盘的是 writeJobFiles。P74e 会在每次新版本固定后再调用它重写。
 */
import { posix } from 'node:path';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { launchOf, type Agreement, type AgreementVersion, type PendingItem, type Sketch } from '../model/agreement.js';
import type { Job } from '../model/job.js';
import { normalizeProjectSharedDir } from '../project/shared-dir.js';
import { localParts } from '../util/time.js';
import { joinQuestion } from '../util/question-join.js';

/** 草图块类型的中文名。 */
const BLOCK_KIND_LABELS: Record<string, string> = {
  title: '标题', text: '文字', field: '输入框', button: '按钮', image: '图片', list: '列表', table: '表格', note: '备注',
};

/** 草图元素上的待定项标记：对应待你定的第几项。 */
function markText(mark: number | undefined): string {
  return mark === undefined ? '' : `（对应待你定第 ${mark} 项）`;
}

/**
 * 草图的文字版（也是约定文件里「草图」一节的正文）。
 * page：逐屏逐块；flow：逐步；concept：先逐节点，再逐连线。
 * pending 目前只用来核对标记没有越界（约定内容校验已保证），保留参数是为了与任务卡的函数签名一致。
 */
export function renderSketchFile(sketch: Sketch, pending: readonly PendingItem[]): string {
  const rows: string[] = [];
  if (sketch.layout === 'page') {
    for (const [index, screen] of (sketch.screens ?? []).entries()) {
      rows.push(`### 第 ${index + 1} 屏：${screen.title}`);
      for (const block of screen.blocks) {
        const required = block.required === true ? '（必填）' : '';
        rows.push(`- [${BLOCK_KIND_LABELS[block.kind] ?? block.kind}] ${block.text}${required}${markText(mark(block.mark, pending))}`);
        for (const cells of block.rows ?? []) rows.push(`  | ${cells.join(' | ')} |`);
      }
    }
  } else if (sketch.layout === 'flow') {
    for (const [index, step] of (sketch.steps ?? []).entries()) {
      const actor = step.actor === undefined ? '' : `[${step.actor}] `;
      const note = step.note === undefined ? '' : `（${step.note}）`;
      rows.push(`${index + 1}. ${actor}${step.text}${note}${markText(mark(step.mark, pending))}`);
    }
  } else {
    rows.push('节点：');
    for (const node of sketch.nodes ?? []) {
      const note = node.note === undefined ? '' : `（${node.note}）`;
      rows.push(`- ${node.id}：${node.text}${note}${markText(mark(node.mark, pending))}`);
    }
    if ((sketch.links ?? []).length > 0) {
      rows.push('连线：');
      for (const link of sketch.links ?? []) rows.push(`- ${link.from} -> ${link.to}${link.text === undefined ? '' : `：${link.text}`}`);
    }
  }
  return rows.join('\n');
}

/** 标记只在不超过待定项数时才写出，防止旧数据里越界的标记印出一个不存在的序号。 */
function mark(value: number | undefined, pending: readonly PendingItem[]): number | undefined {
  return value !== undefined && value <= pending.length ? value : undefined;
}

/** 编号列表：「{序号}. {原文}」，序号从 1 起。没有内容时写「无」。 */
function numbered(items: readonly string[]): string {
  return items.length === 0 ? '无' : items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

/** 当前已固定的版本；约定没有已固定版本（不应出现）时取最后一版。 */
export function lockedVersionOf(agreement: Agreement): AgreementVersion {
  return agreement.versions.find(version => version.state === 'locked') ?? agreement.versions[agreement.versions.length - 1]!;
}

/** 约定文件全文：标题加七节，后四节逐条编号。 */
export function renderAgreementFile(agreement: Agreement, version: AgreementVersion): string {
  const c = version.content;
  const pending = c.pending.map((item, index) => `${index + 1}. ${joinQuestion(item.question, item.chosen ?? item.suggested)}`);
  // P74r9：约定里写了对外发布才有这一节（发布方式加「发布前由主人单独批准」）；没有就不写，文件与以前完全一致。
  const launch = launchOf(c);
  const launchSection = launch === null ? [] : ['## 对外发布', launch.how, '发布前由主人单独批准。', ''];
  return [
    `# ${agreement.title}（约定第 ${version.no} 版）`,
    '',
    '## 一句话',
    c.summary,
    '',
    '## 草图',
    renderSketchFile(c.sketch, c.pending),
    '',
    '## 待你定（已定）',
    pending.length === 0 ? '无' : pending.join('\n'),
    '',
    '## 我已定的',
    numbered(c.decided.map(item => item.text)),
    '',
    '## 这次做',
    numbered(c.scopeIn),
    '',
    '## 这次不做',
    numbered(c.scopeOut),
    '',
    '## 怎样算做完',
    numbered(c.doneWhen),
    '',
    ...launchSection,
  ].join('\n');
}

/** 「M月D日 HH:mm」，按设置里的时区。 */
function stamp(ctx: HubContext, at: number): string {
  const p = localParts(at, ctx.settings.timezone);
  return `${p.month}月${p.day}日 ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * 原话文件里某一版找不到主人消息时写什么（P74r1，R8）：
 * - 这一版本来就没有来源消息（主人在 DSH 会话里直接说的）：写原来的固定说明；
 * - 有来源消息但线程日志里已经没有（日志在内存里只保留 14 天，约定可能是更早起草的）：
 *   先从当时为这条消息记下的感知里取（感知摘要就是那句话），仍取不到才写「原话记录已超出保留范围，以约定为准」，不留空。
 */
function fallbackOwnerWords(ctx: HubContext, version: AgreementVersion): string {
  // P74r2b：起因是执行中的提问的版本，不是主人说的：如实写出起因，不冒充主人原话。
  if (version.askOrigin !== null && version.askOrigin !== undefined) {
    return `（这一版的起因是${version.askOrigin.askerName}的提问，不是主人说的：${version.askOrigin.text}）`;
  }
  if (version.sourceMessageId === null) return '（主人在 DSH 会话里直接说的，没有存下原文）';
  const percept = ctx.store.table('percepts').list(row => row.kind === 'owner_message' && row.location === version.sourceMessageId)[0];
  if (percept !== undefined && percept.summary.trim() !== '') return percept.summary;
  return '原话记录已超出保留范围，以约定为准';
}

/**
 * 主人原话文件：每一版的 sourceMessageId 对应的主人原话，按版本顺序。
 * 找不到原话的版本（主人在 DSH 会话里直接说的）写固定说明。
 */
export function renderOwnerWordsFile(ctx: HubContext, agreement: Agreement): string {
  const rows: string[] = [`# ${agreement.title}：你的原话`, ''];
  for (const version of agreement.versions) {
    const message = ctx.store.log('thread').recent(1, row => row.id === version.sourceMessageId && row.from === 'owner')[0];
    const at = message?.createdAt ?? version.createdAt;
    rows.push(`## 第 ${version.no} 版依据（${stamp(ctx, at)}）`);
    rows.push(message !== undefined ? message.text : fallbackOwnerWords(ctx, version));
    rows.push('');
  }
  return rows.join('\n');
}

/** 主题文件夹的绝对路径与项目文件夹（写文件的边界）。 */
export function jobFolderPaths(ctx: HubContext, job: Job): { projectDir: string; jobDir: string } {
  const project = ctx.store.table('projects').get(job.projectId);
  if (!project) throw new Error(`项目不存在：${job.projectId}`);
  const projectDir = normalizeProjectSharedDir(ctx, project.sharedDir).replace(/\/+$/, '');
  return { projectDir, jobDir: posix.join(projectDir, job.folder) };
}

/**
 * 建主题文件夹和三个子文件夹（材料、交付、证据），写三份文件。
 * 约定文件取当前已固定的版本。任何一步失败直接抛出，由调用方（startJob）负责恢复。
 * P74e 会在每次新版本固定后再调用它：文件是整份重写，所以重复调用安全。
 */
export async function writeJobFiles(ctx: HubContext, job: Job): Promise<void> {
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (!agreement) throw new Error(`约定不存在：${job.agreementId}`);
  const version = lockedVersionOf(agreement);
  const { projectDir, jobDir } = jobFolderPaths(ctx, job);
  const boundary = { within: projectDir };
  const F = D.FOLDER_FILES;
  for (const name of [F.materials, F.delivery, F.evidence]) await ctx.fs.mkdirp(posix.join(jobDir, name), boundary);
  await ctx.fs.writeTextAtomic(posix.join(jobDir, F.agreement), renderAgreementFile(agreement, version), boundary);
  await ctx.fs.writeTextAtomic(posix.join(jobDir, F.words), renderOwnerWordsFile(ctx, agreement), boundary);
  await ctx.fs.writeTextAtomic(posix.join(jobDir, F.sketch), `# ${agreement.title}：草图（约定第 ${version.no} 版）\n\n${renderSketchFile(version.content.sketch, version.content.pending)}\n`, boundary);
}

/**
 * 相对项目文件夹的路径是不是中心维护的主题文件：
 * jobs/<任意名>/约定.md、原话.md、草图.md，或 jobs/<任意名>/材料 本身及其下任何内容。
 * hub_project_put 用它拒绝覆盖（与 context.md 同一处理）。路径先规范化，../ 写法不能绕过。
 */
export function isJobMaintainedPath(rel: string): boolean {
  // 折叠大小写与 Unicode 写法：macOS 的文件系统不分大小写，「约定.MD」和「约定.md」是同一个文件。
  const fold = (text: string): string => text.normalize('NFC').toLowerCase();
  const parts = posix.normalize(rel).split('/').filter(part => part !== '' && part !== '.').map(fold);
  if (parts.length < 3 || parts[0] !== fold(D.FOLDER_ROOT)) return false;
  const F = D.FOLDER_FILES;
  const third = parts[2]!;
  if (parts.length === 3) return [F.agreement, F.words, F.sketch, F.materials].map(fold).includes(third);
  return third === fold(F.materials);
}
