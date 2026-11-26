/**
 * 约定的界面视图（P72c）：线程里的约定卡、主题第一层的约定面板、默契度累计。
 *
 * 为什么由中心投影：约定的全部事实（版本、改动标记、固定信息）都在 agreements 表里，
 * 线程日志只记「这里有一张第 N 版的卡」。视图每次按表里的最新状态现算，
 * 所以旧版折叠、已固定只读都不用改写历史日志。只读，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import {
  VERSION_STATE_LABELS, launchOf, type Agreement, type AgreementContent, type AgreementVersion, type ChangeMark,
} from '../model/agreement.js';
import { agreementForTopic } from '../project/agreements.js';
import { localParts } from '../util/time.js';
import { localDirShown, sameLocalDirPath } from '../project/local-dir.js';
import { shortTime } from './common.js';
import { jobOfAgreement } from '../job/store.js';
import { dueTextOf } from './job-views.js';
import { displayEstimate } from '../job/estimate.js';
import { estimateCardOf, type EstimateCardView } from '../job/estimate-text.js';
import type { AgreementCardView, AgreementPanelView, AgreementRevisionRow, JobSplitView } from './types.js';

/** P74f-2：版本写明「不再做」（stopsJob）时约定卡多的一行，由中心生成、不由模型写；界面原样显示。 */
export const STOP_LINE = '确认后这件事停止，已经做出来的东西保留在项目文件夹里。';

/**
 * P74r8：这一版写明「不再做」时的那一行，否则 null。约定卡视图的 stopLine 与「待你处理」条目的 agreementStop 共用这一处判断，
 * 不各写一套。
 */
export function stopLineOf(version: Pick<AgreementVersion, 'stopsJob'>): string | null {
  return version.stopsJob === true ? STOP_LINE : null;
}

/** 版本的「来源」文字。owner_instruction 要看主人是在哪个线程说的（主题里还是总管私聊）。 */
function sourceLabelOf(agreement: Agreement, version: AgreementVersion): string {
  switch (version.source) {
    case 'draft': return '来源：你在总管私聊里的要求';
    case 'owner_revision': return '来源：你在对齐时的修改';
    case 'owner_instruction':
      return version.sourceThread !== null && version.sourceThread === agreement.topicId
        ? '来源：你在主题里的指示' : '来源：你在总管私聊里的指示';
    case 'owner_reopen': return '来源：你的修改，已重新请你确认';
    // P74r2b：起因是执行中的提问，不是主人的话；和「你的修改」区分开。
    case 'job_question': return '来源：执行中的提问，约定里没有写';
  }
}

/**
 * P74r2b：起因是提问的版本多一行起因，由中心生成、不由模型写：
 * 「起因：{提问人}在做这件事时问「{原文，超过 80 字截断加…}」，约定里没有写。」；其余版本为 null。
 * 约定在「待你处理」里的条目有正文时，正文也带这一句（agreement-cards.ts）。
 */
export function originLineOf(version: Pick<AgreementVersion, 'askOrigin'>): string | null {
  const origin = version.askOrigin;
  if (origin === null || origin === undefined) return null;
  const chars = [...origin.text.replace(/\s+/g, ' ').trim()];
  const shown = chars.length > 80 ? `${chars.slice(0, 80).join('')}…` : chars.join('');
  return `起因：${origin.askerName}在做这件事时问「${shown}」，约定里没有写。`;
}

/** 依据标签用的记忆信息：类型、记忆状态、记下的日期（「M月D日」）、先例所属约定的标题和版本号。 */
export interface BasisMemoryInfo {
  kind: 'rule' | 'preference' | 'precedent'; status: 'active' | 'undone' | 'deleted' | 'replaced' | 'refuted';
  dateText: string; agreementTitle: string | null; versionNo: number | null;
}
/** 按出处编号查记忆信息；查不到返回 null。 */
export type BasisLookup = (ref: string) => BasisMemoryInfo | null;

/** 由 ctx 生成依据标签用的查询函数（只读存储）。 */
export function basisLookupOf(ctx: HubContext): BasisLookup {
  return ref => {
    const memory = ctx.store.table('memories').get(ref);
    if (memory === null || memory === undefined) return null;
    const parts = localParts(memory.createdAt, ctx.settings.timezone);
    const agreementId = memory.source.agreementId ?? null;
    return { kind: memory.kind, status: memory.status, dateText: `${parts.month}月${parts.day}日`,
      agreementTitle: agreementId === null ? null : ctx.store.table('agreements').get(agreementId)?.title ?? null,
      versionNo: memory.source.versionNo ?? null };
  };
}

/** 已定事项的依据文字：有出处的写出处原文，其余按类型。P72d 的唤醒包约定段也用它（去掉「依据：」前缀后使用）。 */
export function basisLabelOf(basis: { kind: string; ref: string | null; refText: string | null }, lookup?: BasisLookup): string {
  if (basis.kind === 'source') {
    const text = basis.refText ?? '';
    // P75d：出处是记忆（mem_）：规矩「出处：你的规矩（M月D日）」、偏好「出处：你的偏好（M月D日）」、先例「出处：先例，{约定标题}约定第 n 版」；
    // 记忆已撤销时后面加「（已撤销）」、已删除时加「（已删除）」；查不到这条记忆时写「出处：{出处原文}」。
    if (basis.ref?.startsWith('mem_')) {
      const info = lookup === undefined ? null : lookup(basis.ref);
      if (info === null) return `出处：${text}`;
      const head = info.kind === 'precedent'
        ? `出处：先例，${info.agreementTitle ?? '已删除的约定'}约定第 ${info.versionNo ?? 1} 版`
        : `出处：你的${info.kind === 'rule' ? '规矩' : '偏好'}（${info.dateText}）`;
      // P75r1（L3）：已撤销写「（已撤销）」，已删除写「（已删除）」，与事实一致（原来两种都写「已删除」）。
      // P76p：被主人否掉的先例写「（已被你否掉）」，旧约定卡上仍看得到这条为什么不再用了。
      return info.status === 'undone' ? `${head}（已撤销）` : info.status === 'deleted' ? `${head}（已删除）`
        : info.status === 'refuted' ? `${head}（已被你否掉）` : head;
    }
    if (basis.ref?.startsWith('ru_')) return `依据：你定过的规矩「${text}」`;
    if (basis.ref?.startsWith('dc_')) return `依据：项目决定「${text}」`;
    return `依据：${text}`;
  }
  if (basis.kind === 'convention') return '依据：通行做法';
  if (basis.kind === 'trial') return '依据：需要试过才知道';
  return '依据：我的判断';
}

/** P74r9：这一版去掉对外发布一项时的那一行（中心生成）。 */
export const LAUNCH_REMOVED_LINE = '这一版去掉了对外发布这一步。';

/**
 * P74r9：约定卡上对外发布的一行：写了对外发布就是「验收之后对外发布：{how}。发布前单独请你批准。」；
 * 没写，但这一版的改动标记里有「去掉」（上一版有、这一版去掉了）写固定句；其余为 null（界面不显示）。
 */
export function launchLineOf(content: Pick<AgreementContent, 'launch'>, marks: readonly ChangeMark[]): string | null {
  const launch = launchOf(content);
  if (launch !== null) return `验收之后对外发布：${launch.how}。发布前单独请你批准。`;
  return marks.some(mark => mark.section === 'launch' && mark.kind === 'removed') ? LAUNCH_REMOVED_LINE : null;
}

/**
 * P81：约定卡上发布那一行之后的一行：写了发布位置（localDir）就是「发布到本机文件夹：{显示路径}」，显示路径以 ~ 开头；没有写为 null。
 * P81r1：提交时发现位置已经存在、里面有文件，发布一项记了 localDirHasFiles，这一行后面多一句「（已有文件夹，……）」。
 * ownerHome 是主人主目录（取不到时显示完整路径）。
 */
export function localDirLineOf(content: Pick<AgreementContent, 'launch'>, ownerHome: string | undefined): string | null {
  const launch = launchOf(content);
  const dir = launch?.localDir;
  if (dir === undefined) return null;
  const shown = localDirShown(dir, ownerHome);
  return launch?.localDirHasFiles === true
    ? `发布到本机文件夹：${shown}（已有文件夹，发布命令可以修改和删除其中的文件）`
    : `发布到本机文件夹：${shown}`;
}

/**
 * P81r1：这一版改了发布位置、上一版也有发布位置时，「原来的位置：{上一版的显示路径}」；其余情况返回 null。
 * 按段、折叠后比较（大小写与 Unicode 写法的差别不算改动）。
 */
function localDirPrevLineOf(agreement: Agreement, version: AgreementVersion, ownerHome: string | undefined): string | null {
  const prev = agreement.versions.find(row => row.no === version.no - 1);
  if (prev === undefined) return null;
  const before = launchOf(prev.content)?.localDir;
  const now = launchOf(version.content)?.localDir;
  if (before === undefined || now === undefined || sameLocalDirPath(before, now)) return null;
  return `原来的位置：${localDirShown(before, ownerHome)}`;
}

/** 被哪一版取代：确认前被取代的是下一版；曾经生效的是之后第一个被固定过的版本。 */
function supersededByOf(agreement: Agreement, version: AgreementVersion): number | null {
  const later = agreement.versions.filter(row => row.no > version.no);
  if (version.state === 'superseded') return later[0]?.no ?? null;
  if (version.state === 'replaced') return later.find(row => row.lockedAt !== null)?.no ?? later[0]?.no ?? null;
  return null;
}

/** 某个区块里被标成「改过或新增」的序号集合（按序号的区块用）。 */
function markedIndexes(changes: ChangeMark[], section: ChangeMark['section']): Set<number> {
  return new Set(changes.filter(mark => mark.section === section && mark.kind !== 'removed' && mark.index !== undefined).map(mark => mark.index!));
}

/** 这位总管全部约定所有版本的默契度累计；两项都为 0 时为 null。 */
export function agreementRapport(ctx: HubContext, botId: string): { adopted: number; total: number } | null {
  let adopted = 0;
  let total = 0;
  for (const agreement of ctx.store.table('agreements').list(row => row.botId === botId)) {
    for (const version of agreement.versions) {
      if (version.adoption) { adopted += version.adoption.adopted; total += version.adoption.total; }
    }
  }
  return adopted === 0 && total === 0 ? null : { adopted, total };
}

/**
 * W1：约定卡上的「归属」一行：这件事放在哪个项目里。项目是为这件事新建的写「新建项目」。
 * 项目已被删除时写「项目已删除」。
 */
export function projectLineOf(ctx: HubContext, agreement: Agreement): string {
  const project = ctx.store.table('projects').get(agreement.projectId);
  if (!project) return '归属：项目已删除';
  return agreement.projectCreated === true ? `归属：新建项目「${project.name}」` : `归属：项目「${project.name}」`;
}

/** 一张约定卡（约定的某一个版本）的完整视图。 */
export function agreementCardView(ctx: HubContext, agreement: Agreement, version: AgreementVersion): AgreementCardView {
  const latest = agreement.versions[agreement.versions.length - 1]!;
  const marks = version.changes;
  const lookup = basisLookupOf(ctx);
  const pendingChanged = new Set(marks.filter(mark => mark.section === 'pending' && mark.kind === 'changed').map(mark => mark.key));
  const pendingAdded = new Set(marks.filter(mark => mark.section === 'pending' && mark.kind === 'added').map(mark => mark.key));
  const sectionRows = (section: 'scopeIn' | 'scopeOut' | 'doneWhen') => {
    const hit = markedIndexes(marks, section);
    return version.content[section].map((text, index) => ({ text, changed: hit.has(index) }));
  };
  const decidedHit = markedIndexes(marks, 'decided');
  // P72h：有意删去的条目逐条列出；没记原文的旧删除只计数，让界面知道「改动区没有覆盖全部差异」。
  // P74r9：对外发布一项被去掉的标记不属于「删去的条目」（它有自己的一行），不计入这里。
  const removedMarks = marks.filter(mark => mark.kind === 'removed' && mark.section !== 'launch');
  const removed = removedMarks.flatMap(mark => (mark.text !== undefined && mark.text !== '' ? [mark.text] : []));
  return {
    agreementId: agreement.id, title: agreement.title, projectId: agreement.projectId, topicId: agreement.topicId,
    topicTitle: ctx.store.table('projectTopics').get(agreement.topicId)?.title ?? null,
    projectLine: projectLineOf(ctx, agreement),
    versionNo: version.no, latestNo: latest.no,
    state: version.state, stateLabel: VERSION_STATE_LABELS[version.state], agreementState: agreement.state,
    canConfirm: agreement.state === 'pending' && version.no === latest.no && version.state === 'pending' && version.cardMessageId !== null,
    supersededBy: supersededByOf(agreement, version),
    createdText: shortTime(ctx, version.createdAt)!, lockedAt: version.lockedAt, lockedText: shortTime(ctx, version.lockedAt),
    sourceLabel: sourceLabelOf(agreement, version), originLine: originLineOf(version), changeNote: version.changeNote,
    stopLine: stopLineOf(version),
    removed, removedUnlisted: removedMarks.length - removed.length,
    summary: { text: version.content.summary, changed: marks.some(mark => mark.section === 'summary') },
    sketch: { value: version.content.sketch, changed: marks.some(mark => mark.section === 'sketch') },
    // P72h：index 是显示用的序号，从 1 起（数组下标加 1），与草图里圆圈数字（mark，从 1 起）指向同一项。
    pending: version.content.pending.map((item, position) => ({
      key: item.key, index: position + 1, question: item.question, options: [...item.options], suggested: item.suggested, chosen: item.chosen,
      reason: item.reason, changed: pendingChanged.has(item.key), added: pendingAdded.has(item.key),
    })),
    // P75d：出处是记忆时带 memoryId，界面点出处可跳到记忆页那一条；标签用 lookup 生成（整张卡只建一次）。
    decided: version.content.decided.map((item, index) => ({ text: item.text, basisLabel: basisLabelOf(item.basis, lookup), changed: decidedHit.has(index),
      ...(item.basis.ref?.startsWith('mem_') ? { memoryId: item.basis.ref } : {}) })),
    scopeIn: sectionRows('scopeIn'), scopeOut: sectionRows('scopeOut'), doneWhen: sectionRows('doneWhen'),
    launchLine: launchLineOf(version.content, marks), launchChanged: marks.some(mark => mark.section === 'launch'),
    // P81：没有发布位置时不带这个字段（视图与以前逐字相同）。
    ...(localDirLineOf(version.content, ctx.ownerHome) === null ? {} : { localDirLine: localDirLineOf(version.content, ctx.ownerHome) }),
    // P81r1：改了发布位置时多一行「原来的位置」；没改、上一版没有位置时不带这个键。
    ...(localDirPrevLineOf(agreement, version, ctx.ownerHome) === null ? {} : { localDirPrevLine: localDirPrevLineOf(agreement, version, ctx.ownerHome) }),
    adoption: version.adoption,
    rapport: version.adoption ? agreementRapport(ctx, agreement.botId) : null,
    jobSplit: jobSplitOf(ctx, agreement, version),
    // P76e：没有预计时不带这个键（含义等同 null）：既有的样例与预览快照（插件）逐字不变，界面卡 P76j 再决定怎样画。
    ...estimateField(ctx, agreement, version),
  };
}

/** 有预计才带 estimate 键；没有时为空对象。 */
function estimateField(ctx: HubContext, agreement: Agreement, version: AgreementVersion): { estimate?: EstimateCardView } {
  const estimate = estimateOf(ctx, agreement, version);
  return estimate === null ? {} : { estimate };
}

/**
 * P76e：约定卡上「预计消耗」一段：待确认的版本取 draft、已固定的版本取固定时算的那一项（见 job/estimate.ts 的 displayEstimate）；
 * 被取代的旧版本不显示；没有预计（旧数据）为 null。执行者、核对人：这份约定已有进行中的事时取这件事的人
 * （没有核对人写总管核对）；派活前约定里没有人选，写「执行者」「核对人」。有没有对外发布这一步：已有事取事上的，否则取这一版的约定内容。
 */
export function estimateOf(ctx: HubContext, agreement: Agreement, version: AgreementVersion): EstimateCardView | null {
  if (version.state !== 'pending' && version.state !== 'locked') return null;
  const estimate = displayEstimate(ctx, agreement, version);
  if (estimate === null) return null;
  const job = jobOfAgreement(ctx, agreement.id);
  const active = job !== null && job.state !== 'stopped' ? job : null;
  const nameOf = (id: string, fallback: string): string => ctx.store.table('bots').get(id)?.name ?? fallback;
  return estimateCardOf(estimate, {
    executorName: active === null ? '执行者' : nameOf(active.executorId, '执行者'),
    reviewerName: active === null ? '核对人' : active.reviewerId === null ? null : nameOf(active.reviewerId, '核对人'),
    hasLaunch: active === null ? launchOf(version.content) !== null : active.launchStep,
  });
}

/**
 * P74e（B2）：这一版是某件事 pause.versionNo 对应的版本时，给出两栏、交付时间不变的一行和退路；否则 null。
 * 两栏取自这件事的记录（由中心按改动算出，见 job/pause.ts），这里只读不算。
 */
export function jobSplitOf(ctx: HubContext, agreement: Agreement, version: AgreementVersion): JobSplitView | null {
  const job = jobOfAgreement(ctx, agreement.id);
  if (job === null || job.pause === null || job.pause.versionNo !== version.no || job.pause.stopsJob === true) return null;
  const due = job.dueAt === null ? '交付时间不变' : `交付时间不变：${dueTextOf(job.dueAt, ctx.settings.timezone)}`;
  return { continuing: [...job.pause.continuing], paused: [...job.pause.paused], dueText: due, fallback: job.pause.fallback };
}

/** 线程消息对应的约定卡：按 refId 找约定、按卡片消息 id 找版本；找不到返回 null。 */
export function agreementCardForMessage(ctx: HubContext, refId: string | null, messageId: string): AgreementCardView | null {
  const agreement = refId ? ctx.store.table('agreements').get(refId) : null;
  const version = agreement?.versions.find(row => row.cardMessageId === messageId);
  return agreement && version ? agreementCardView(ctx, agreement, version) : null;
}

/** 修订记录的一行：一句话优先用本版改动说明；第 1 版写「初稿」，若没来得及固定再加「，未固定」。 */
function revisionRow(ctx: HubContext, agreement: Agreement, version: AgreementVersion): AgreementRevisionRow {
  const text = version.changeNote !== '' ? version.changeNote
    : version.no === 1 ? (version.state === 'superseded' ? '初稿，未固定' : '初稿') : '修改';
  return { no: version.no, timeText: shortTime(ctx, version.createdAt)!, stateLabel: VERSION_STATE_LABELS[version.state], text,
    sourceLabel: sourceLabelOf(agreement, version), locked: version.state === 'locked' };
}

/**
 * 主题第一层的约定面板：主题上有未撤下的约定才给。
 * 当前版本：约定已固定取固定版，待确认取最新版；修订记录按版本号从新到旧。
 */
export function agreementPanelForTopic(ctx: HubContext, topicId: string): AgreementPanelView | null {
  const agreement = agreementForTopic(ctx, topicId);
  if (!agreement) return null;
  const latest = agreement.versions[agreement.versions.length - 1]!;
  const current = (agreement.state === 'locked' ? agreement.versions.find(row => row.state === 'locked') : null) ?? latest;
  return {
    current: agreementCardView(ctx, agreement, current),
    revisions: [...agreement.versions].reverse().map(version => revisionRow(ctx, agreement, version)),
    revisionCount: agreement.versions.length - 1,
  };
}
