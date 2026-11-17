/**
 * 先例（P75d，方案 5.4、7.5）：约定每次固定时，中心把主人选定的待定项写成先例，供以后同类的事对齐时引用。
 *
 * 为什么由中心写、模型写不进：先例的内容只取自约定里的问题和主人选定的项，来源是「已固定的约定」；
 * 模型没有任何工具能写 kind 为 precedent 的记忆（hub_memory 只能记规矩和偏好）。
 *
 * 写什么：对这一版每个 chosen 不为空的待定项写一条：文字为「{问题前 50 字}：{选定项前 50 字}」，类别取约定的类别，
 * 适用范围全部，出处为这份约定的这一版（带待定项的 key 与主人确认那句话的消息编号）。
 * 去重：同一份约定、同一版、同一个待定项只写一次（重复调用不重复写）；之前某一版已经写过同一个待定项、
 * 文字完全相同的先例（例如主人选办法生成的新版本、小改动生效的新版本，待定项没变），沿用旧的，不再重复写。
 * 已否掉：主人否掉过的先例（状态 refuted，同一份约定、同一个待定项、文字相同）不再写新的（P85）。
 * 旧版先例：这份约定之前各版写的、这一版没有沿用的，改为「已取代」。
 * 文字过内部名称检查（job/owner-text.ts）：问题和选定项取自总管写的约定，可能带工具名、内部编号；含内部名称的这一条不写
 * （记日志），不能把内部名称带到主人面前的记忆页和「可引用的出处」里。
 *
 * 先例不进身份文件，所以写入不刷新身份文件（writeMemory 的 refresh 为假）。出错由调用方记日志，不影响约定固定。
 */
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { ownerTextProblem } from '../job/owner-text.js';
import { agreementCategory } from '../project/agreement-category.js';
import { joinQuestion } from '../util/question-join.js';
import { setMemoryStatus, writeMemory } from './service.js';

/** 按完整字符截取前 max 个字，不把一个汉字切成两半；多行压成一行。 */
function clipChars(text: string, max: number): string {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

/**
 * 写这一版的先例。返回新写了几条。约定不存在、这一版不存在或没有固定过时什么也不写。
 * 先写新的、再把旧版没沿用的改为已取代：写新的出错时旧的先例还在，不会出现「新旧都没有」。
 */
export async function writePrecedents(ctx: HubContext, agreementId: string, versionNo: number): Promise<number> {
  const agreement = ctx.store.table('agreements').get(agreementId);
  const version = agreement?.versions.find(row => row.no === versionNo);
  if (agreement === null || agreement === undefined || version === undefined || version.lockedAt === null) return 0;
  const category = agreementCategory(ctx, agreementId);
  // P75r1（L1）：这份约定的先例每次现取，不在循环开始前取一次：写一条先例要等异步收尾，
  // 同一版的收尾若同时开始两次，第二份在每条之前重新查表就能看到第一份刚写的，不会写出两条。
  const precedentsOfAgreement = () => ctx.store.table('memories').list(row => row.kind === 'precedent' && row.source.agreementId === agreementId);
  const keep = new Set<string>(); // 沿用下来、不需要改为已取代的先例
  let written = 0;
  for (const item of version.content.pending) {
    if (item.chosen === null) continue;
    const mine = precedentsOfAgreement();
    // 「问题：选定项」统一用 util/question-join.ts 拼：问题以问号结尾时先去掉问号再接冒号（P75h，避免「？：」）。
    const text = joinQuestion(clipChars(item.question, D.PRECEDENT_PART_MAX_CHARS), clipChars(item.chosen, D.PRECEDENT_PART_MAX_CHARS));
    const problem = ownerTextProblem('先例', text);
    if (problem !== null) {
      ctx.logger.warn('先例的文字含有内部名称，这一条不写', { agreementId, versionNo, pendingKey: item.key, problem });
      continue;
    }
    // 同一版同一个待定项已经写过：不重复写。
    const same = mine.find(row => row.source.versionNo === versionNo && row.source.pendingKey === item.key);
    if (same !== undefined) { keep.add(same.id); continue; }
    // 之前某一版写过同一个待定项、文字相同、仍然生效：沿用，不重复写。
    const carried = mine.find(row => row.status === 'active' && row.source.pendingKey === item.key && (row.source.versionNo ?? 0) < versionNo && row.text === text);
    if (carried !== undefined) { keep.add(carried.id); continue; }
    // P85（审查 W10）：主人已经否掉的先例不能复活：同一份约定、同一个待定项、文字相同、状态为已否掉的先例在，就不再写新的。
    // 否掉发生在返工时，约定本身没有换版；之后约定再固定一版，选定项没变，若照常写就会把被否掉的选择重新放回「可引用的出处」。
    // 选定项的文字变了（例如主人改成了别的办法）时文字不同，照常写新的。
    if (mine.some(row => row.status === 'refuted' && row.source.pendingKey === item.key && row.text === text)) continue;
    const row = await writeMemory(ctx, {
      kind: 'precedent', text, example: null, redLine: false, scope: { staff: 'all', projects: 'all' },
      source: { kind: 'agreement', messageIds: version.confirmMessageId === null ? [] : [version.confirmMessageId], quote: text,
        threadId: null, agreementId, versionNo, pendingKey: item.key },
      category, refresh: false,
    });
    keep.add(row.id);
    written += 1;
  }
  // 这份约定之前各版写的先例、这一版没有沿用的：改为已取代。
  for (const old of precedentsOfAgreement()) {
    if (old.status !== 'active' || keep.has(old.id) || (old.source.versionNo ?? 0) >= versionNo) continue;
    await setMemoryStatus(ctx, old.id, 'replaced', 'hub');
  }
  return written;
}

/**
 * 约定每次固定之后的记忆部分：只写先例（P75r1 起，约定卡上改了引用记忆的条目不再自动更正那条记忆：
 * 约定只管这一件事，规矩只在主人亲口说了之后由总管更正，或由主人在记忆页改）。
 * 写先例出错只记日志，不影响约定已经固定。
 */
export async function afterAgreementLockedMemory(ctx: HubContext, agreementId: string, versionNo: number): Promise<void> {
  try { await writePrecedents(ctx, agreementId, versionNo); }
  catch (error) { ctx.logger.warn('约定固定后写先例没有做成', { agreementId, versionNo, error: String(error) }); }
}
