/**
 * 总管不许自己产出交付物（P76q 第 1 条）。
 *
 * 为什么需要：真实模型验证里，总管在一件小事上没出约定、没派活，自己用 write_file 做了网页，
 * 还提交了写文件的审批。这绕开了约定、执行者和核对：东西是总管做的，就没人按约定核对，
 * 主人看到的「交付」也没有回执。总管的职责是安排、回答、核对，交付物应当由队友产出。
 *
 * 怎么判断「这件事的交付物」：
 * - 已经派出去的这件事（没有收尾的 Job）的文件夹：交付、证据都放在里面，属于这件事，不属于总管；
 * - 这件事约定里写明的发布位置（launch.localDir）：成品最终发布到这里，同样属于交付物；
 * - 写着 `jobs/<jobId>`、但这个编号对不上任何已派出的事：这也只能是某件事的交付物，先派活再做。
 * 已经收尾（完成、停止）的事不算：写说明、整理旧交付不受这条规则影响。
 * 其余位置不算：写给主人看的说明文档可以放在总管自己的文件夹、项目文件夹的说明里，
 * 写约定卡走 hub_agreement_submit，回复里的状态说明根本不经文件写入。
 *
 * P82（第二轮真实模型验证的缺陷 1）：约定之前没有任何拦挡——约定还不存在时，上面三种位置都匹配不上，
 * 总管可以申请往主人桌面写「占位文件」。现在多一条兜底：
 * 总管自己的文件写入，目标不在中心的数据目录内（中心根目录、员工文件夹、共享文件夹、项目文件夹、工作数据目录）
 * 时一律拒绝，并说明「交付文件由队友写，先把这件事约定好并派给队友」。
 * 例外：派给总管自己、还没停下的事，它的文件夹与发布位置是总管自己的活（见 ownRoots）。
 * 同一条规则也用于 hub_outbox_submit（总管提交写文件、运行要写文件的命令时，见 gate/outbox.ts）。
 *
 * 本文件只做判断，不写存储、不读时钟。守卫在真正执行工具之前调用它；命中就拒绝这次调用，
 * 并告诉总管应该用 hub_job_manage 派活或让执行者改，而不是自己写。拒绝不计越界：这不是安全问题，
 * 是分工问题（和技能库只读同一处理，见 guard.ts）。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { launchOf, type Agreement } from '../model/agreement.js';
import type { Job } from '../model/job.js';
import { normalizeProjectSharedDir } from '../project/shared-dir.js';
import { within } from './paths.js';

/** 一件事的交付物范围：这件事的文件夹，以及约定里写明的发布位置。 */
export interface ChiefDeliverableZone {
  jobId: string;
  /** 约定标题，用来把拒绝的话说清楚；读不到时写「这件事」。 */
  title: string;
  /** 执行者名字，用来告诉总管该找谁改。 */
  executorName: string;
  /** 执行者编号：等于总管时说明这件事是派给总管自己的（P82，不拦）。 */
  executorId: string;
  /** 交付物所在的绝对路径（可能有多个）。 */
  roots: string[];
}

/** 一处约定里的发布位置；closed 表示这件事已经收尾，写说明、整理不算交付物。 */
export interface ChiefLaunchDir {
  root: string;
  closed: boolean;
}

/**
 * 守卫做判断要用的全部位置（一次算好，避免每条路径都翻一遍表）：
 * - active：已经派出、还没收尾的事的交付物范围；
 * - jobRoots：每个项目的 `jobs` 根目录，用来认出写着 jobs/<id> 却没有这件事的位置；
 * - closedJobIds：已经收尾的事的编号，这些文件夹里的写入不算交付物；
 * - launchDirs：约定里的发布位置，以及它对应的事是否已收尾；
 * - ownRoots：派给总管自己、还没停下的事的文件夹与发布位置（P82，放行）；
 * - centralRoots：中心的数据目录（P82 的兜底：总管自己的文件写入只放在这些地方）。
 */
export interface ChiefDeliverableMap {
  active: ChiefDeliverableZone[];
  jobRoots: string[];
  closedJobIds: string[];
  launchDirs: ChiefLaunchDir[];
  ownRoots: string[];
  centralRoots: string[];
}

/** 一件事是否已经收尾（完成、停止）。 */
function isClosed(job: Pick<Job, 'state'>): boolean {
  return job.state === 'done' || job.state === 'stopped';
}

/** 项目文件夹；旧存档或手工改库把它指到别处时返回 null，只跳过这一项，不抛错。 */
function projectDirOf(ctx: HubContext, sharedDir: string): string | null {
  try {
    return normalizeProjectSharedDir(ctx, sharedDir).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** 约定的当前版本：已固定的那一版；都没有时取最后一版。 */
function currentVersionOf(agreement: Agreement) {
  return agreement.versions.find(version => version.state === 'locked') ?? agreement.versions[agreement.versions.length - 1];
}

/** 约定里写明的发布位置；没写返回 null。 */
function launchLocalDirOf(agreement: Agreement): string | null {
  const version = currentVersionOf(agreement);
  return version === undefined ? null : launchOf(version.content)?.localDir ?? null;
}

/** 把「哪些位置属于交付物」一次算出来。 */
/**
 * 中心的数据目录（P82）：总管自己的文件写入只放在这些地方。
 * 中心根目录（含真实路径）、共享目录、每位员工的家目录、每个项目的文件夹、工作数据目录。
 * 员工家目录与项目文件夹一般就在中心根目录之下，这里仍逐个列出：旧存档把路径指到别处时也不会误拦。
 */
function centralRootsOf(ctx: HubContext, projectDirs: readonly string[]): string[] {
  const roots = [ctx.settings.rootDir, `${ctx.settings.rootDir}/shared`, ...projectDirs];
  const realRoot = ctx.runtime?.realRootDir;
  if (typeof realRoot === 'string' && realRoot !== '') roots.push(realRoot);
  for (const bot of ctx.store.table('bots').list()) roots.push(bot.homeDir);
  const home = ctx.ownerHome?.replace(/\/+$/, '');
  for (const raw of ctx.settings.workDataPaths ?? []) {
    if (raw === '~' || raw.startsWith('~/')) {
      if (home !== undefined && home !== '') roots.push(home + raw.slice(1));
      continue;
    }
    if (raw.startsWith('/')) roots.push(raw);
  }
  return [...new Set(roots.map(root => root.replace(/\/+$/, '')).filter(root => root !== ''))];
}

/** 把「哪些位置属于交付物」一次算出来。chiefId 是总管自己的编号，用来认出派给总管的事（P82，可省略）。 */
export function chiefDeliverableMap(ctx: HubContext, chiefId?: string): ChiefDeliverableMap {
  // 1 每个项目的文件夹与 jobs 根目录。项目目录不合规的只跳过它自己。
  const projectDirs = new Map<string, string>();
  const jobRoots: string[] = [];
  for (const project of ctx.store.table('projects').list()) {
    const dir = projectDirOf(ctx, project.sharedDir);
    if (dir === null) continue;
    projectDirs.set(project.id, dir);
    jobRoots.push(posix.join(dir, 'jobs'));
  }
  const jobs = ctx.store.table('jobs').list();
  const agreements = new Map(ctx.store.table('agreements').list().map(agreement => [agreement.id, agreement]));
  /** 这件事的文件夹与约定里的发布位置（读不到就少一项）。 */
  const rootsOf = (job: (typeof jobs)[number]): string[] => {
    const roots: string[] = [];
    const projectDir = projectDirs.get(job.projectId);
    if (projectDir !== undefined) roots.push(posix.join(projectDir, job.folder));
    const agreement = agreements.get(job.agreementId);
    const localDir = agreement === undefined ? null : launchLocalDirOf(agreement);
    if (localDir !== null) roots.push(localDir);
    return roots;
  };
  // 2 还没收尾的事：这件事的文件夹与它约定里的发布位置。
  const active: ChiefDeliverableZone[] = [];
  // P82：派给总管自己、还没停下的事（正常流程里总管不能当执行者；旧数据或手工改库时也要放行）。
  const ownRoots: string[] = [];
  for (const job of jobs) {
    if (chiefId !== undefined && job.executorId === chiefId && job.state !== 'stopped') ownRoots.push(...rootsOf(job));
    if (isClosed(job)) continue;
    const roots = rootsOf(job);
    if (roots.length === 0) continue;
    const agreement = agreements.get(job.agreementId);
    const executor = ctx.store.table('bots').get(job.executorId);
    active.push({ jobId: job.id, title: agreement?.title ?? '这件事', executorName: executor?.name ?? '队友', executorId: job.executorId, roots });
  }
  // 3 约定里的发布位置。同一处被多份约定用到时，只要有一件还没收尾就不能算「已收尾」。
  const launchStates = new Map<string, boolean>();
  for (const agreement of agreements.values()) {
    if (agreement.state === 'withdrawn') continue;
    const root = launchLocalDirOf(agreement);
    if (root === null) continue;
    const own = jobs.filter(job => job.agreementId === agreement.id);
    const closed = own.length > 0 && own.every(isClosed);
    if (launchStates.get(root) !== false) launchStates.set(root, closed);
  }
  return {
    active,
    jobRoots: [...new Set(jobRoots)],
    closedJobIds: jobs.filter(isClosed).map(job => job.id),
    launchDirs: [...launchStates].map(([root, closed]) => ({ root, closed })),
    ownRoots: [...new Set(ownRoots)],
    centralRoots: centralRootsOf(ctx, [...projectDirs.values()]),
  };
}

/**
 * path 在 root 下面的第一段名字（例如 jobs 根目录下面的 jobId）。
 * 调用前已经用 within 确认过是同一处；这里只按目录层数取，保留原来的大小写。
 */
function firstSegmentAfter(path: string, root: string): string | null {
  const parts = posix.normalize(path).split('/').filter(part => part !== '');
  const rootParts = posix.normalize(root).split('/').filter(part => part !== '');
  return parts[rootParts.length] ?? null;
}

/** 「还没派活」的统一说法；两条拒绝话都以它开头。 */
const DISPATCH_FIRST = '这类交付先派给队友，由队友来做：';

/**
 * P82 的兜底拒绝话：目标不在中心的数据目录内，一律说明交付文件由队友写。
 * 前半句是任务卡逐字要求的理由，后半句说明总管自己的文件写入能放在哪里。
 */
const CHIEF_FILE_SCOPE_REFUSAL = '交付文件由队友写，先把这件事约定好并派给队友：'
  + '先用 hub_agreement_submit 把这件事约定好、再用 hub_job_manage 派给队友，由队友写；'
  + '你自己的文件写入只能放在中心的数据目录里（你的文件夹、共享文件夹、项目文件夹）。'
  + '给主人看的说明写在回复里，不要写成文件。';

/**
 * 这次调用要写的位置里，只要有一处属于交付物、或写着某件事的 jobs 文件夹却没有这件事，就返回拒绝的话。
 * 判定顺序：先看已派出未收尾的事（能说出交给谁），再看 jobs/<id> 是否有对应事项，
 * 再看约定里的发布位置，最后是 P82 的兜底：不在中心的数据目录内一律拒绝。
 * 已收尾的文件夹与发布位置、派给总管自己的事（ownRoots）都不拦。
 * 只比较已经解析成绝对路径的写入目标；相对路径、含变量的路径交给原来的沙箱与审批规则。
 */
export function chiefDeliverableRefusal(paths: readonly string[], map: ChiefDeliverableMap): string | null {
  /** 派给总管自己的事：这件事的文件夹与发布位置都是总管自己的活。 */
  const own = (path: string): boolean => map.ownRoots.some(root => within(path, root));
  for (const zone of map.active) {
    for (const path of paths) {
      if (!path.startsWith('/') || own(path)) continue;
      if (!zone.roots.some(root => within(path, root))) continue;
      return `这类交付应当交给队友：「${zone.title}」已经交给「${zone.executorName}」做，交付物由他产出。`
        + `要让${zone.executorName}改，用 hub_job_manage（按这件事的情况改派或回答）；`
        + '要给主人看的说明，写在你的回复里，不要写进这件事的交付位置。';
    }
  }
  const closedIds = new Set(map.closedJobIds);
  for (const path of paths) {
    if (!path.startsWith('/') || own(path)) continue;
    // 写在某个项目的 jobs 下面：有这件事且已收尾就放行（写说明、整理），否则先派活。
    let closedJobFolder = false;
    for (const root of map.jobRoots) {
      if (!within(path, root)) continue;
      const jobId = firstSegmentAfter(path, root);
      if (jobId !== null && closedIds.has(jobId)) {
        closedJobFolder = true;
        break;
      }
      return `${DISPATCH_FIRST}这个位置在 jobs 文件夹里，但没有对应的事项。先用 hub_job_manage 派活，不要自己动手。`;
    }
    if (closedJobFolder) continue;
    // 约定里的发布位置：对应的事已收尾就不拦；没有这件事（或还没派）时先派活。
    for (const launch of map.launchDirs) {
      if (launch.closed || !within(path, launch.root)) continue;
      return `${DISPATCH_FIRST}这个位置是约定里写明的发布位置，但这件事还没有派给队友。先用 hub_job_manage 派活，不要自己动手。`;
    }
  }
  // P82 兜底：约定还不存在、上面几种位置都匹配不上时，总管也不能自己往中心的数据目录之外写文件。
  for (const path of paths) {
    if (!path.startsWith('/') || own(path)) continue;
    if (!map.centralRoots.some(root => within(path, root))) return CHIEF_FILE_SCOPE_REFUSAL;
  }
  return null;
}
