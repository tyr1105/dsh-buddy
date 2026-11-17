/**
 * 工具 hub_agreement_submit（P72b）：总管提交或修改「开工前的约定」。
 *
 * 工具层只做三件事：找到本回合的唤醒单、调用 P72a 的 submitAgreement、把结果翻成给模型看的一句话。
 * 身份（只有总管）、回合（必须是主人的话叫醒的）、内容校验都在 submitAgreement 里，
 * 这里不重复判断。工具注册给所有员工，非总管调用时在服务层被拒绝（和「仅负责人」工具同一做法）。
 * 卡片不在这里发：工具只写表，交账路由 routeCommit 里再发卡（见 project/agreement-cards.ts）。
 */
import { defineTool } from './common.js';
import { flushJobHooks } from '../job/agreement-hooks.js';
import { clip20 } from '../job/item-remap.js';
import { forwardReminderFor } from '../job/forward-reminder.js';
import { launchChangeNoteFor } from '../job/launch-removed.js';
import { AgreementSubmitInputSchema, LOCAL_DIR_SENTENCE } from '../project/agreement-content.js';
import { submitAgreement } from '../project/agreements.js';

/** 工具说明：模型看到的全部使用规则。 */
const DESCRIPTION = '（仅总管）提交或修改开工前的约定。新建：不传 agreementId，填 title 和六样内容：summary 一句话复述；sketch 草图（layout 选 page 页面、flow 流程、concept 概念之一，只填对应的数组）；pending 待主人定的事项 1 到 5 项，每项 key、question、2 到 4 个 options、suggested（必须是选项之一）、reason；decided 你已定的事项，每条写 basis（source 必须给「可引用的出处」里的编号，convention 通行做法，trial 需要试过才知道，其余写 judgement）；scopeIn 这次做；scopeOut 这次不做；doneWhen 怎样算做完 3 到 5 条；launch 验收之后要对外发布时写 { how: 发布到哪里、用什么方式 }（一行白话，不含内部名称；只写发布到哪里、用什么方式，不写「发布前请你批准」这类话（约定卡上中心会加））；' + LOCAL_DIR_SENTENCE + '主人没有说发布到哪里时，你能给出具体可行的方式就直接写进 launch（约定卡上那一行就是给主人确认的），给不出就不写 launch，在 scopeOut 里写一条「对外发布：你没有说发布到哪里，这次不含发布；需要时告诉我发布到哪里、用什么方式」；写了 launch 的不要再写进 scopeOut，也不用在别的栏里重复写；约定里没有 launch 的事，验收之后没有发布这一步。修订时 launch 不写表示不变，写 null 表示去掉，写对象表示设定或修改。主人修改时：传 agreementId 和 changeNote，只填改了的部分，没改的待定项保持原 key；没改的那一段整段不传（沿用上一版）；传了的那一段要带全，包括其中没改的条目；确实要删除某条时，在 removals 里逐条写明被删条目的原文（待定项去掉或换掉某一项时，也要写它的 key），没有写明就会被拒绝、不产生新版本。约定已固定后：主人亲口的小改动用 mode amend，直接生效（amend 不能改待定项、这次做、这次不做、怎样算做完和对外发布 launch，这几项一律用 revise）；大改用 mode revise，重新请主人确认。正在做的事要改约定时，revise 还要写 continuing（照常在做）、paused（暂停）和 fallback（不改的退路）；改了「怎样算做完」时，沿用的条目顺序不要调整，要到交付时才能核对的条目用 deliveryItems 写新版本里的序号（不写则中心按条目原文对应原来的，被改写的不再算）。约定还没固定过时主人说不做了：mode withdraw 并写 reason；约定已固定后主人说不做了：mode revise 提交一版写明不再做，请主人确认，不能直接撤下；这份约定有进行中的事时，还要写 stopsJob: true（不用写 continuing、paused，fallback 可写），主人确认后中心直接停下这件事。约定卡在你交账后发给主人，reply 只写一句结论。主人直接在提问卡上回答了你的提问（收件箱答复）与在对话里给你发一句话等价，那一回合可以提交约定。执行链回合（执行者或核对人的提问叫醒你，不是主人发消息叫醒的）里不能提交约定，只有一个例外：这件事有没回答的提问、约定里推不出答案时，可以对这件事已固定的约定用 mode revise 出新版本请主人确认（要写 continuing、paused、fallback）。主人发话的回合里，正在做的事要改约定、而且这件事有一个没回答的提问时，revise 还要写 answersAsk：这一版是在回答那个提问就写 true（主人确认后中心回答它），不是就写 false（之后仍要用 hub_job_manage 的 answer 回答它）；执行链回合里不写这个参数。你不能替主人确认约定。';

export const hubAgreementSubmit = defineTool('hub_agreement_submit', DESCRIPTION, AgreementSubmitInputSchema, 'L1', async (ctx, tc, args) => {
  // 取本回合的唤醒单：宿主给了 wakeId 就用它；没给就找这个员工当前打开的唤醒单（口径与 defineTool 一致）。
  const wake = tc.wakeId
    ? ctx.store.table('wakes').get(tc.wakeId)
    : ctx.store.table('wakes').list(row => row.botId === tc.botId && row.sessionId === tc.sessionId
      && (['running', 'delivering'].includes(row.status) || (row.status === 'committed' && row.endedAt === null)))
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  if (!wake) throw new Error('约定只能在回合里提交');

  const { agreement, version, kind, job } = await submitAgreement(ctx, tc.botId, wake, args);
  // P74e：主人亲口的小改动直接生效后，这件事的收尾（重写主题文件、叫醒执行者）是异步的，等它做完再回话，
  // 这样工具说「已生效」时，主题文件已经是新版本。
  await flushJobHooks(ctx);
  const no = version?.no ?? agreement.versions[agreement.versions.length - 1]!.no;
  // P74r12：主人在进行中的事的主题里发话、这一回合还没转交过材料时，修订成功的返回文字后面加一句转交提醒。
  const reminder = kind === 'revised' || kind === 'reopened' || kind === 'amended' ? forwardReminderFor(ctx, wake, agreement.id) : '';
  const result = ((): { ok: true; text: string } => {
  switch (kind) {
    case 'created':
      return { ok: true, text: `已记下约定「${agreement.title}」第 1 版（agreementId 为 ${agreement.id}，主题「${agreement.title}」）。交账后卡片会发给主人；reply 只写一句结论，不要重复约定内容。主人确认前不要叫员工动手。` };
    case 'revised':
    case 'reopened':
      // P74e（B2）：正在做的事重新确认：如实告诉总管中心算出的两栏，以及执行者有没有被叫醒。
      if (job !== undefined && job.pause.stopsJob === true) {
        return { ok: true, text: `已记下第 ${no} 版，等主人确认。主人确认后中心会直接停下这件事，不会再叫你；确认前执行者照常在做。reply 用一句话告诉主人：确认后这件事停止，已经做出来的东西保留在项目文件夹里。` };
      }
      if (job !== undefined) {
        const list = (items: readonly string[]): string => (items.length === 0 ? '无' : items.join('、'));
        // P74r2c：如实写明新版本里「交付时核对」的条目；原来的交付时核对条目被改写而这次没写 deliveryItems 时，提醒重新指定。
        const delivery = job.pause.deliveryItems ?? [];
        const deliveryText = delivery.length === 0 ? '新版本里没有交付时核对的条目。' : `交付时核对的条目（新版本）：第 ${delivery.join('、')} 条。`;
        const lostText = job.deliveryLost.map(text => `原来在交付时核对的「${clip20(text)}」被改写了；它仍然要到交付时才能核对的话，重新提交这一版并在 deliveryItems 里写上它的新序号。`).join('');
        return { ok: true, text: `已记下第 ${no} 版，等主人确认。中心按这次的改动算出：照常在做：${list(job.pause.continuing)}；暂停：${list(job.pause.paused)}（改动涉及的条目已自动列入暂停）。${deliveryText}${lostText}${job.woken ? '' : '执行者此刻没有被叫醒（他可能不在岗或正在忙），暂停和照常在做的说明等他接着做时会给他。'}reply 用一句话告诉主人冲突在哪、哪些照常在做。` };
      }
      return { ok: true, text: `已记下第 ${no} 版，等主人确认。reply 用一句话说明改了什么。` };
    case 'amended':
      return { ok: true, text: `已记入约定第 ${no} 版并直接生效（来源：主人的指示）。` };
    case 'withdrawn':
      // P72g A2：重开中的约定被撤下，只取消这次重开，约定仍是已固定。
      if (agreement.state === 'locked') return { ok: true, text: '已取消这次重新确认，约定仍按已固定的版本执行。' };
      return { ok: true, text: '约定已撤下，不会开工。' };
  }
  })();
  // P74r13：这件事已经验收、这一版改了对外发布时，返回文字里写明事实（发布已完成、去掉不影响结果；或加上的不会自动进行），
  // 总管据此对主人如实说明。放在转交提醒之前。
  const launchNote = kind === 'revised' || kind === 'reopened' || kind === 'amended' ? launchChangeNoteFor(ctx, agreement.id, version) : '';
  const extra = `${launchNote}${reminder}`;
  return extra === '' ? result : { ok: true, text: `${result.text}${extra}` };
});
