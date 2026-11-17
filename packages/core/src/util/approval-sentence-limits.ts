/**
 * 审批卡那句话的长度参数（P69 A-4）。
 *
 * 单独成文件：approval-sentence.ts 已经接近一个文件该有的长度，这几个数字又要在注释里讲清为什么，放在一起会把主逻辑淹掉。
 * 这里是句子排版的专用常量，不是可由 Settings 覆盖的业务阈值。
 */
/** 命令类的那一句话最长多少字（D 类自己超长时例外）。 */
export const SENTENCE_MAX_CHARS = 200;
/** 句子里一个路径最长多少字；超了保留开头和结尾。 */
export const PATH_SENTENCE_MAX_CHARS = 80;
/** 收尾「；……等 N 件」要留的字数（N 最多三位数时 11 个字，留 14 个有余量）。 */
export const SENTENCE_TAIL_RESERVE = 14;
