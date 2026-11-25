/**
 * 总管专属的唤醒包段落（P72d）：「总管守则」和「你手上的约定」。
 *
 * 为什么单独一个文件：
 * - 这两段只给总管、只在完整回合出现，其他员工的唤醒包一字不变；放在 packet.ts 里会把主文件撑大。
 * - 守则正文是固定文字，一字不能改，集中在这里便于核对；约定段每回合现算。
 *
 * 约定：
 * - 本文件只读存储，不写任何东西；时间一律用注入时钟给的 now。
 * - 约定段不出现任何「默契度」「采纳数」相关文字（任务卡第 7 节）。
 * - 已撤下的约定不出现。
 */
import { AGREEMENT_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { basisLabelOf, basisLookupOf, type BasisLookup } from '../api/agreement-views.js';
import { memorySourceGroups, renderSourceGroups } from './chief-sources.js';
import { ON_TEAM_LIFECYCLES } from '../model/enums.js';
import { staffDutyLabel, staffPostName, staffWorkload } from '../team/workload.js';
import { launchOf, type Agreement, type AgreementContent } from '../model/agreement.js';
import type { Bot } from '../model/bot.js';
import type { QueueEntry } from '../model/wake.js';
import { pendingAgreementsOf } from '../project/agreements.js';
import { categoryListLine } from '../project/agreement-category.js';
import { LOCAL_DIR_SENTENCE } from '../project/agreement-content.js';
import { hasUnlinkedAsk } from '../project/agreement-chain.js';
import { activeJobOfAgreement } from '../job/agreement-hooks.js';
import { openAskText } from '../job/store.js';
import { truncateBytes } from '../util/text.js';
import { formatShort } from '../util/time.js';

/** 总管守则段的 key、标题（key 要加进 sections.ts 的不可截断名单）。 */
export const CHIEF_RULES_KEY = 'chief-rules';
export const CHIEF_RULES_TITLE = '## 总管守则：先分档，再开工';
/** 约定段的 key、标题。 */
export const AGREEMENTS_KEY = 'agreements';
export const AGREEMENTS_TITLE = '## 你手上的约定（中心维护）';

/** 总管守则正文：照任务卡第 3 节逐字抄入，不得改写措辞。 */
export const CHIEF_RULES_TEXT = `你是全队唯一的入口：主人只和你说话，事情由你安排，结果由你交回。对主人说话一律称「你」，不写「主人」。
1. 收到主人的话先分三档，只选一档；回复里不提分档，也不解释为什么这样处理。
   第一档，纯技术细节或一步能答的：直接做或直接答。
   第二档，需求明确的小事：reply 只写一句。做完了写「已改好：把 X 由 A 改为 B，其他不变。」；交给员工做的写「收到：把 X 由 A 改为 B，其他不变。已交给某某。」不提问。
   第三档，有主人会在意但还没定的选择，或者猜错代价大：先对齐，见第 2 条。拿不准是第二档还是第三档时，按第三档。
2. 对齐：先调用 hub_agreement_submit 提交约定，再调用 hub_commit。reply 只写一句结论：有几项需要你定、确认前不会开工，例如「这件事有 3 项需要你定，每项我都给了建议。确认前不会开工。」不要列举待定项的题目，也不要把约定内容在 reply 里再写一遍，卡片里已经有，会自动发给主人。对齐的回合交账时 outcome 写 needs_owner，不填 ownerQuestion，约定卡就是给主人的提问。提交时 category 填这件事属于哪类工作，从约定段末尾的类别表里选一个。
   在项目对话里提的约定不填 projectId，中心会放进这个项目；主人说的事明显属于另一个进行中的项目时，填那个项目的 projectId。在私聊里提的约定，先对照「进行中的项目」判断属于哪一个，属于就带上它的 projectId，都不属于就不填，由中心新建一个项目；中心会在约定卡上写明归属。
3. 主人没说的部分逐项考虑：目标和给谁用、范围、看得见的部分、规则和数值、边界情况、会动到哪些现有的东西、代价、怎样算做完。每一项走四条路之一：
   查得到出处的（下方「可引用的出处」里有）：放进 decided，basis.kind 写 source，ref 写出处编号；
   有公认做法的技术细节：放进 decided，kind 写 convention；
   试了才知道的：放进 decided，kind 写 trial，并在这次做里写明先做小试验；
   主人会在意、又没有先例的：放进 pending，给建议和一句理由。
   出处只能用下方列出的编号；没有出处就写 judgement，不得编造「你定过的规矩」。同类的事，先在「可引用的出处」里找先例和规矩，查得到的放进 decided；pending 只放查不到的，并在 reason 末尾写「查不到先例：……」。
4. pending 只放主人会在意的选择，最多 5 项；查得到的、有公认做法的不拿来问。花钱、不可撤销的动作放进 scopeOut，写明另行请你确认。主人的需求里有对外发布（上线、发布、部署、发出去）时：在约定的 launch 里写清发布到哪里、用什么方式（一行字，只写发布到哪里、用什么方式，不写「发布前请你批准」这类话（约定卡上中心会加））。主人没有说发布到哪里、用什么方式时，不要列进 pending：你能给出一个具体可行的发布方式，就直接写进 launch（约定卡上「验收之后对外发布：……」那一行就是给主人确认的，主人不同意会在确认前直接说，那时再改约定）；给不出具体的发布方式（不知道发布到哪里），就不写 launch，在 scopeOut（这次不做）里写一条「对外发布：你没有说发布到哪里，这次不含发布；需要时告诉我发布到哪里、用什么方式」，并且不要对主人说「发布前会请你批准」。${LOCAL_DIR_SENTENCE}写了 launch 的对外发布，不要再写进 scopeOut，也不用在别的栏里重复写。约定里没有 launch 的事，验收之后没有发布这一步，不要对主人说「发布前会请你批准」。doneWhen 只写交付核对时就能判断的结果；验收之后才发生的事（对外发布、上线之后的效果）不写进 doneWhen。范围取最小。
5. 主人确认前（约定是「待你确认」）：这件事不开工、不派活，中心会拦下这件事的派活和主题里的 @；别的已固定的事照常安排。主人修改时，带上 agreementId 提交新版本，只填改了的部分，没改的待定项保持原 key；主人说「其余按你的建议」，其余建议保持不变。修订时，没改的部分整段不传；传了的部分要带全，包括其中没改的条目；确实要删除某条时，用 removals 写明被删的条目。
6. 你不能替主人确认约定，主人说「定了」由中心识别。约定刚固定时，reply 用一句话说明交付时间，以及什么情况才会再来问你；交付时间以约定为准，约定里没有写的，不要在回复里另报时间。约定固定后安排人，按顺序做：
   一、列出这件事需要哪几种角色，取最少的人：一件事一位执行者；需要交付前核对的，由评审员核对；改动小的，或团队里没有评审员时，由你自己核对。
   二、在岗员工够用：直接调用 hub_job_manage 派活（mode 写 assign，参数见下方「在岗员工」那一行），不等主人确认；中心会把主人的原话、草图和约定作为文件交给执行者，并在主题里告诉主人谁执行、谁核对。reply 在交付时间那句之后只加一句安排：「这件事由某某（岗位名称）执行，某某在交付前核对。理由：……」；某某没有岗位名称就不写括号。理由只写角色对应和手上空不空。同角色的两位都空闲时，选最近做过同一项目的那位，这条不写进 reply。
   三、在岗员工里缺少需要的角色：只用这一次的需要，由你自己完成，reply 写「这是一次性的需要，由我自己完成，不新增员工。」；以后还会反复用到的，调用 hub_team_propose 推荐一位（template 写模板名，agreementId 写这份约定，needReason 写这件事为什么需要，residentReason 写为什么值得常驻），reply 用一句话说明这两层理由，请主人在卡片上确认。说不出为什么值得常驻，就按一次性处理。组队卡确认前，不把这件事交给任何人。
   四、在册已满时不推荐；reply 用一句话建议主人先归档一位，写明建议归档谁、为什么，以及在这位员工的卡片里操作。
   五、只有不需要专业技能、几步就能完成的小事才自己做。约定的工作只能用 hub_job_manage 派活，不能用 hub_send 交代。
7. 约定固定后，主人亲口的小改动碰到约定内容：用 mode amend 提交，直接生效，不再请主人确认；改动大到影响范围、交付时间或待定项时，用 mode revise 重新请主人确认。对外发布（launch）一项加上、改写、去掉都不能用 amend，一律用 mode revise 请主人确认。约定还没固定过时，主人说这件事不做了，用 mode withdraw；约定已经固定后，主人说这件事不做了，用 mode revise 提交一版，写明这件事不再做，请主人确认，你不能直接撤下已固定的约定。
8. 需要主人定的事放进约定；ownerQuestion 只用于约定之外的单个问题。
9. 写给主人看的 reply、report、blocker 不写工具名、机器人 id、议程编号等内部名称，用主人看得懂的说法。
10. 组队卡等主人确认期间：不提交新约定，不重新确认约定，也不能派活（这件事的派活和主题里的 @ 会被中心拦下），确认前不要把这件事交给别人。主人要改卡上某位的员工说明，或换成模板库里的其他人，用 hub_team_propose 的 mode revise（proposalId 写卡片编号，name 写卡上的名字，brief 写完整的员工说明，或 template 写新模板名），reply 用一句话说明改了什么。主人回复「不新增」时，中心会撤下卡片，这件事由你自己完成。
11. 执行中的事（唤醒包「你手上的事」里列出）：执行者或核对人问你时，约定能推出答案的，用 hub_job_manage 的 mode answer 回答（jobId、to 写提问人名字、text 写答案、basis 写出处，section 加 no，序号见唤醒包），不打扰主人，reply 只写一句。写不出出处，说明约定推不出来：会改动约定的，用 hub_agreement_submit 的 mode revise 出新版本请主人确认，并写 continuing（不受影响、照常在做）、paused（暂停）和 fallback（不改的退路）；reply 用一句话告诉主人冲突在哪、哪些照常在做。主人发话的回合里为这件事改约定时，若这件事有一个没回答的提问（「你手上的约定」里会写明），revise 要多写 answersAsk：这一版是在回答它就写 true，不是就写 false（之后仍要用 answer 回答它）。主人发来与这件事有关的材料，用 mode forward 存为主题文件交给执行者。材料与约定有出入时，两件事都要做：先用 forward 转交主人的原话，再修订约定请主人确认；只修订约定，执行者拿不到材料。主人说这件事不做了：主人在这一回合的原话里直接说了不做，用 mode stop（reason 写主人说了什么；主人说「定了」叫醒你的回合不能用）；主人还没拿定、要他确认的，按第 7 条修订约定并写 stopsJob: true（不用写 continuing、paused），主人确认后中心直接停下这件事，不用你再操作。主人已暂停的事要接着做，用 mode resume；主人已为这次受阻选了不带改动的办法、你不换人而照办法接着做，也用 mode resume（核对三轮不过的，换人或接着做之后核对从新的三轮算起）。
12. 交付和验收由中心完成：核对通过后中心把结果交给主人，主人点「验收通过」后中心记为完成，这几步不用你说话。主人在验收时指出不符，用 mode reopen 对到条目返工，reply 写明返工哪条、改到什么程度算过、核对为什么漏了、这次怎么补，以及预计什么时候再交给你。核对三轮仍不过、或执行者做不下去且你解决不了时，用 mode escalate 交给主人决定，不要用 ownerQuestion；说明之后交账写 blocked，不写 needs_owner。
13. 主人的话里有「以后」「每次」「都」「不要再」「别再」「记住」这类说法，说的是以后都要照做的做法或偏好时，在同一回合调用 hub_memory，mode 写 note：kind 写 rule（做法）或 preference（喜欢怎样被汇报、怎样交付），text 用一句话写记住了什么，example 写一个例子，staff 写适用的员工（没说就写「全部」），projects 写适用的项目（没说就写「全部」）。reply 一句话写全三样：「已记住：……，例如……。适用于……。」范围按主人原话，不另外问。只针对眼前这件事的，照常处理，不调用 hub_memory，也不写「已记住」。拿不准时只改这一次，reply 末尾加一句「要我以后都这样吗」。主人改了约定里一条引用规矩、偏好或先例的内容时，只改这份约定，不动那一条记忆；reply 末尾同样加一句「要我以后都这样吗」，主人说是，再用 mode correct 改那一条。主人要删掉或改掉记住的某条，用 mode forget 或 correct，memoryId 见「可引用的出处」。主人要某位员工学他在 DSH 里某段会话的做法，调用 hub_skill，mode 写 teach，staff 写员工名字，note 写要学什么；中心会请主人选会话，reply 只写一句「是哪一段？」。
14. 交付物一律派给队友，你自己不写交付文件；只有回复、说明和整理可以自己写。这一条优先于第 6 条第五项：主人要的成品（例如网页、页面）即使几步能完成，也先派活；没有合适的员工，就告诉主人需要先添加什么角色。
15. 回复里提到某件事现在的状态（在做、在返工、在等谁、已验收、已停止）时，以这一回合唤醒包「你手上的事」里写的为准；那里没有写的事，不说它正在进行或正在返工。对话里较早的消息只说明当时的情况，不代表现在。`;

/** 通用规矩里两条对总管的改写（rulesFor 只在总管时调用）：返回改写后的规矩正文。 */
export function chiefRulesAdjust(rules: string): string {
  return rules
    .replace('先做不依赖主人的部分。', '先做不依赖主人的部分；需要对齐的事，在主人确认约定之前不开工。')
    .replace('需要决定的写进 ownerQuestion，一次最多一个。', '需要主人定的事放进约定，约定之外的单个问题写进 ownerQuestion，一次最多一个。');
}

/** 这个回合是否带总管两段：总管、且不是轻复查和复盘。 */
export function wantsChiefSections(bot: Bot, variant: string): boolean {
  return bot.role === 'chief' && variant !== 'light_check' && variant !== 'reflection';
}

/** 把多行文字压成一行：出处、标题里的换行换成空格，避免撑乱列表。 */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/** 按字符数截取前 max 个完整字符（不加省略号）。 */
function clipChars(text: string, max: number): string {
  return [...oneLine(text)].slice(0, max).join('');
}

/**
 * 依据标签：与约定卡同口径（含 P75d 的「出处：……」写法），整句放进括号。
 * 标签自带「依据：」或「出处：」前缀，所以括号里不再另加前缀。
 */
function basisTag(basis: Parameters<typeof basisLabelOf>[0], lookup: BasisLookup): string {
  return basisLabelOf(basis, lookup);
}

/** 本回合证据里的消息 id 集合：证据本身，加上证据里主人消息感知指向的线程消息。 */
export function evidenceMessageIds(ctx: HubContext, entry: Pick<QueueEntry, 'reason'>): Set<string> {
  const ids = new Set(entry.reason.evidence);
  for (const id of entry.reason.evidence) {
    const percept = ctx.store.table('percepts').get(id);
    if (percept && percept.kind === 'owner_message' && percept.location) ids.add(percept.location);
  }
  return ids;
}

/**
 * P74r9：约定里「对外发布」一项的文字（总管不用翻文件就能看到）：有就写发布方式，没有写明验收之后没有发布这一步。
 * 刚确认、待确认、已固定三处共用。
 */
export function launchText(content: Pick<AgreementContent, 'launch'>): string {
  const launch = launchOf(content);
  // P81：约定写了发布位置（本机文件夹）时一并给出，总管改约定时不会把它漏掉。
  return launch === null ? '对外发布：无（验收之后没有发布这一步）'
    : `对外发布：${launch.how}（验收之后对外发布，发布前中心单独请主人批准）${launch.localDir === undefined ? '' : `；发布到本机文件夹：${launch.localDir}`}`;
}

/** 第 1 项：刚由主人确认的约定（证据里含某个已固定版本的 confirmMessageId）。 */
function justLockedLines(ctx: HubContext, bot: Bot, entry: QueueEntry): string[] {
  const ids = evidenceMessageIds(ctx, entry);
  const lines: string[] = [];
  for (const agreement of ctx.store.table('agreements').list(row => row.botId === bot.id && row.state === 'locked')) {
    const version = agreement.versions.find(row => row.state === 'locked');
    if (!version || version.confirmMessageId === null || !ids.has(version.confirmMessageId)) continue;
    // P74b：写明约定编号和「怎样算做完」的序号原文，总管据此一次填对 hub_job_manage 的 agreementId 与 deliveryItems。
    const done = version.content.doneWhen.map((item, index) => `${index + 1}. ${item}`).join(' ');
    const notDo = version.content.scopeOut.length > 0 ? version.content.scopeOut.join('；') : '无';
    lines.push(`刚由主人确认：约定「${agreement.title}」第 ${version.no} 版（agreementId 为 ${agreement.id}）。怎样算做完：${done}。这次不做：${notDo}。${launchText(version.content)}。现在可以安排员工开工；reply 用一句话说明交付时间，以及什么情况才会再来问你。`);
  }
  // P72h H2：由中心写明事实——当前除总管外有哪些在岗员工，总管据此决定是派活还是先告诉主人去添加。
  if (lines.length > 0) lines.push(staffFactLine(ctx));
  return lines;
}

/** 当前在岗（试岗或正式）的员工，不含总管；暂停、隔离、退役的不算。 */
function onDutyStaff(ctx: HubContext): Bot[] {
  return ctx.store.table('bots').list(row => row.role !== 'chief' && (ON_TEAM_LIFECYCLES as readonly string[]).includes(row.lifecycle));
}

/**
 * 「在岗员工」事实行：列出除总管外全部在岗员工及其角色（执行、调研、盯守、建议都算，
 * 约定的工作可能是调研，不能只看执行类）；一位也没有时明确要求总管告诉主人，不要自己动手。
 */
export function staffFactLine(ctx: HubContext): string {
  const staff = onDutyStaff(ctx);
  if (staff.length === 0) return '团队里除你之外没有在岗的员工：请告诉主人需要先添加一位（说明需要什么角色），不要自己动手。';
  // P73d：每位补「在办几件」和「最近做过的项目」，角色优先写模板的显示标签（评审员写「评审」），供总管判断「手上空不空」。
  const rows = staff.map(bot => {
    const load = staffWorkload(ctx, bot.id);
    const recent = load.lastProjectName === null ? '' : `，最近做过「${load.lastProjectName}」`;
    // 复核后：有岗位名称时写在岗位类别之前（「林舟（工程师，执行，在办 0 件）」），总管写「由某某（岗位名称）执行」时不会写成「（执行）执行」。
    const post = staffPostName(ctx, bot);
    return `${bot.name}（${post === null ? '' : `${post}，`}${staffDutyLabel(ctx, bot)}，在办 ${load.openCount} 件${recent}）`;
  });
  return `当前在岗的员工：${rows.join('、')}。约定里的工作交给合适的员工，你负责安排；没有合适的，就告诉主人需要先添加什么角色的员工，不要自己动手。安排开工：调用 hub_job_manage，mode 写 assign，agreementId 写上面那份约定的编号，executor 写员工名字，reviewer 写评审员名字或「总管」，dueAt 写交付时间，deliveryItems 只写「怎样算做完」里写了交付时间的那一条的序号（通常只有一条，没有就不写；其余条目都要有证据并经过核对），launchStep 不用填：验收之后有没有对外发布这一步，由约定里的对外发布一项（launch）决定。`;
}

/** 第 2 项：待确认的约定，完整给出最新版，供修订时保持 key。 */
function pendingBlock(ctx: HubContext, agreement: Agreement): string {
  const version = agreement.versions[agreement.versions.length - 1]!;
  const c = version.content;
  const rows = [
    `待主人确认：约定「${agreement.title}」第 ${version.no} 版（agreementId 为 ${agreement.id}，主题「${agreement.title}」）`,
    `一句话：${c.summary}`,
    '待定项（修订时保持 key）：',
    ...c.pending.map(p => `- key=${p.key}｜${p.question}｜选项：${p.options.join(' / ')}｜建议：${p.suggested}`),
  ];
  const lookup = basisLookupOf(ctx);
  if (c.decided.length > 0) rows.push(`你已定的：${c.decided.map((d, i) => `${i + 1}. ${d.text}（${basisTag(d.basis, lookup)}）`).join(' ')}`);
  rows.push(`这次做：${c.scopeIn.join('；')}；这次不做：${c.scopeOut.length > 0 ? c.scopeOut.join('；') : '无'}`);
  rows.push(`怎样算做完：${c.doneWhen.map((d, i) => `${i + 1}. ${d}`).join(' ')}`);
  rows.push(launchText(c));
  rows.push('草图沿用上一版；要改草图时整份重填 sketch。');
  const askLine = unlinkedAskLine(ctx, agreement);
  if (askLine !== null) rows.push(askLine);
  return rows.join('\n');
}

/**
 * P74r3（H1）：这份约定有进行中的事、这件事有一个没回答且还没关联到约定版本的提问时，给出一句说明
 * （提问人、原文、answersAsk 怎么写）；否则返回 null。已转成约定新版本的提问不在此列（它在等主人确认）。
 */
function unlinkedAskLine(ctx: HubContext, agreement: Agreement): string | null {
  const job = activeJobOfAgreement(ctx, agreement.id);
  if (job === null || !hasUnlinkedAsk(job)) return null;
  const asker = ctx.store.table('bots').get(job.openAsk!.fromId)?.name ?? '员工';
  const text = clipChars(openAskText(ctx, job) ?? '（问题原文没有留在记录里）', 80);
  return `这件事有一个没回答的提问：${asker}问「${text}」。主人这一回合的话若要你为这件事修订这份约定，revise 要写 answersAsk：这一版是在回答它就写 true，不是就写 false（之后仍要用 answer 回答它）。`;
}

/** 第 3 项：已固定的约定，按 updatedAt 从新到旧最多 3 份，每份一行。 */
function lockedLines(ctx: HubContext, bot: Bot, now: number): string[] {
  return ctx.store.table('agreements').list(row => row.botId === bot.id && row.state === 'locked')
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, D.PACKET_LOCKED_MAX)
    .map(agreement => {
      const version = agreement.versions.find(row => row.state === 'locked')!;
      const at = version.lockedAt === null ? '时间未知' : formatShort(version.lockedAt, now, ctx.settings.timezone);
      const base = `已固定：约定「${agreement.title}」第 ${version.no} 版（agreementId 为 ${agreement.id}，固定于 ${at}）：${version.content.summary}。${launchText(version.content)}`;
      // P74r3（H1）：这份约定有进行中的事、这件事有一个没回答的提问时，写明提问人和原文，并说明 answersAsk 怎么写，
      // 总管只凭唤醒包的文字就能把参数写对（主人发话的回合里出新版本时用）。已转成约定新版本的提问不在此列（它在等主人确认）。
      const askLine = unlinkedAskLine(ctx, agreement);
      return askLine === null ? base : `${base}\n${askLine}`;
    });
}

/** 约定段正文：按任务卡规定的顺序拼出，超过 3 KB 截断。 */
export function buildAgreementsBody(ctx: HubContext, bot: Bot, entry: QueueEntry, now: number): string {
  const parts: string[] = [];
  parts.push(...justLockedLines(ctx, bot, entry));
  // P74e：每一张待确认的约定都给出完整一块（执行中的事重新确认的，和还在对齐的新事各一块），按 updatedAt 从新到旧。
  for (const pending of pendingAgreementsOf(ctx, bot.id)) parts.push(pendingBlock(ctx, pending));
  parts.push(...lockedLines(ctx, bot, now));
  // P75b：类别词表永远排在段末（在「可引用的出处」之后），且不参与截断：先给它留出字节，再截断前面的部分，
  // 否则约定很多时词表会被截掉，总管就不知道 category 能写什么。
  const categories = categoryListLine();
  const room = D.PACKET_MAX_BYTES - Buffer.byteLength(`\n${categories}`, 'utf8');
  const none = '暂无可引用的出处，依据只能写 convention、trial 或 judgement。';
  // P75d：三组出处（规矩与偏好、先例、项目页决策）；P75r1 起任何时候都这样（记忆不设开关，旧规矩表在迁移完成之前并入第一组）。
  // 整段超出上限时先截先例（从最后一条起去掉），再不行才整体截断。第 4 项永远给出，没有出处时也要让总管知道依据该怎么写。
  const groups = memorySourceGroups(ctx, bot);
  const build = (limit: number): string => [...parts, renderSourceGroups(groups, limit) ?? none].join('\n');
  let limit = groups.precedents.length;
  while (limit > 0 && Buffer.byteLength(build(limit), 'utf8') > room) limit -= 1;
  return `${truncateBytes(build(limit), room)}\n${categories}`;
}
