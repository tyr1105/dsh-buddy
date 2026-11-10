/**
 * 项目负责人（owner）的规则（P60）。
 *
 * 为什么单独一个文件：「谁能当负责人」「没选时默认谁」在三个地方都要用——保存项目、
 * 旧项目开主题时补负责人、负责人专用工具的身份检查。规则写一份，三处不会各说各话。
 *
 * 这里全部是纯函数：不读时钟、不写存储，输入显式给队友档案或项目，全部可单测。
 */
import type { Bot } from '../model/bot.js';
import type { Project } from '../model/project.js';
import { isBotOnTeam } from '../org/access.js';

/**
 * 没指定负责人时的默认人选：先找在岗的总管，没有总管就用第一位在岗且不是建议风格的成员。
 * 只从在岗成员里挑：默认挑一个暂停的队友，主人一开口就会报「负责人不在岗」，等于没挑。
 * 返回 null 表示选不出来，由调用方决定是留空（保存项目）还是报错（开主题）。
 */
export function pickDefaultOwnerId(members: readonly Bot[]): string | null {
  const eligible = members.filter(bot => isBotOnTeam(bot) && bot.role !== 'advisor');
  return (eligible.find(bot => bot.role === 'chief') ?? eligible[0])?.id ?? null;
}

/** 建议风格只提意见不动手，负责人要拆事、拍板，所以不能当；不合规时抛中文错误。 */
export function assertOwnerEligible(bot: Pick<Bot, 'name' | 'role'>): void {
  if (bot.role === 'advisor') {
    throw new Error(`队友「${bot.name}」是建议风格，只提意见不动手，不能当项目负责人，请换一位`);
  }
}

/** 负责人专用工具的身份检查：只认项目上记录的负责人，模型传什么参数都改变不了身份。 */
export function requireProjectOwnerBot(project: Pick<Project, 'name' | 'ownerBotId'>, botId: string): void {
  if (project.ownerBotId !== botId) {
    throw new Error(`只有项目「${project.name}」的负责人能用这个工具；你不是这个项目的负责人`);
  }
}
