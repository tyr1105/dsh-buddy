/**
 * 三问期间对总管的「保持安静」规则（P73r3 S3、S5、S6）。
 *
 * 为什么单独一个文件：三问进行中，总管不应被主人的任何一句话叫醒（叫醒就是一次模型调用，
 * 而三问和推荐按设计不调用模型），也不应在这期间被别的入口抢着做事（例如在主题里提交约定，
 * 与稍后生成的组队卡同时待确认）。拦截点分散在私聊、团队线程、项目主题和界面命令里，
 * 判断条件与固定文字集中在这里，各处只调用这几个小函数。
 *
 * 「三问进行中」的定义：三问记录处于 asking，且第三问还没有答案。
 * 第三问答完以后只剩中心生成组队卡这一步（不叫醒总管、不需要主人再答），此后总管可以正常被叫醒，
 * 这样即使组队卡因约定卡待确认而推迟生成，主人也仍能和总管讨论那份约定。
 *
 * 本文件只读存储，唯一的写入是落旁白和写「不算纠正」标记。
 */
import type { HubContext } from '../engine/context.js';
import type { TeamSetup } from '../model/team-proposal.js';
import { OWNER_CORRECTION_KEY_PREFIX } from '../scheduler/on-demand.js';
import { postThread } from '../outreach/thread.js';
import { auditTool } from '../tools/common.js';

/** 主人在三问进行中、在其他地方对总管说话时，中心落的固定句（同一个地方连续说几句只落一次）。 */
export const TEAM_SETUP_BUSY_TEXT = '总管正在问你三个问题，回答完再交代事情。';
/** 三问进行中，主人打了整句确认口令（「定了」一类），中心落的固定句；三问状态不变。 */
export const TEAM_SETUP_CONFIRM_TEXT = '请先回答上面的问题。';
/** 三问进行中，界面命令「戳一下」被拒绝时的说明。 */
export const TEAM_SETUP_POKE_TEXT = '总管正在问你三个问题，请先回答';

/** 这位机器人是不是正处于三问进行中的总管；是则返回三问记录，否则 null。 */
export function setupAskingFor(ctx: HubContext, botId: string): TeamSetup | null {
  const setup = ctx.store.table('teamSetups').list(row => row.chiefId === botId)[0];
  if (!setup || setup.state !== 'asking' || setup.answers.notify !== null) return null;
  return setup;
}

/** 中心在某个地方落一句旁白（来源 hub、类别 system，与其他中心旁白一致）。 */
export function hubNote(ctx: HubContext, threadId: string, text: string): void {
  postThread(ctx, { thread: threadId, from: 'hub', kind: 'system', text });
}

/**
 * 在这个地方落「总管正在问你三个问题」。同一个地方连续说几句只落一次：
 * 该线程里最近一条不是主人说的话如果已经是这句，就不再落。
 */
export function noteSetupBusy(ctx: HubContext, threadId: string): void {
  const last = ctx.store.log('thread').recent(1, row => row.thread === threadId && row.from !== 'owner')[0];
  if (last !== undefined && last.from === 'hub' && last.text === TEAM_SETUP_BUSY_TEXT) return;
  hubNote(ctx, threadId, TEAM_SETUP_BUSY_TEXT);
}

/**
 * 三问期间被当作回答（或被拦下）的主人消息不算「主人的纠正」：
 * 复盘触发（reflect/trigger.ts）把「已写 reflection_trigger 标记」的消息视为已用，所以这里直接写标记。
 */
export function markNotCorrection(ctx: HubContext, chiefId: string, messageId: string): void {
  auditTool(ctx, chiefId, 'reflection_trigger', `${OWNER_CORRECTION_KEY_PREFIX}${messageId}`);
}
