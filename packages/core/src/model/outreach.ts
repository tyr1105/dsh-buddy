/** 对话、收件箱和审批记录：明确动作状态与批准内容哈希，便于后续一次性放行。 */
import { z } from 'zod';
import * as e from './enums.js';
import { bool, byteText, nonempty, recordId, text, timestamp } from './primitives.js';

/** 校验对话线程消息，保留发送者、来源记录和已读时间。 */
export const ThreadMessageSchema = z.strictObject({
  id: recordId('m'), // 记录的唯一标识；前缀区分记录类型
  thread: nonempty, // 机器人 id、team 或项目主题 id（ptp_ 开头），决定消息所在的对话线程
  from: nonempty, // 发送者：owner、hub 或机器人 id
  kind: e.ThreadKindSchema, // 聊天、回复、汇报、提问、审批、提议、告警、日报、交接、同伴或系统消息
  text, // 正文
  refId: nonempty.nullable(), // 关联业务记录 id，例如审批单或交账
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  readAt: timestamp.nullable(), // 主人或收件方读取时间；未读时为空
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
/** 校验需要主人动手的事项，使回答和过期处理使用同一状态。 */
export const InboxItemSchema = z.strictObject({
  id: recordId('i'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty.nullable(), // 相关机器人 id；全体事项可为空
  type: e.InboxTypeSchema, // 需要主人动手的提议、提问、审批或告警
  title: nonempty, // 供主人和机器人识别的标题
  body: text, // 给主人展示的详细正文
  options: z.array(nonempty), // 提供给主人选择的答案
  defaultOption: text.nullable(), // 主人未及时回复时采用的默认答案
  priority: e.PrioritySchema, // P0 紧急、P1 重要、P2 一般
  status: e.InboxStatusSchema, // 待处理、已回答、过期、撤回或关闭
  answer: text.nullable(), // 主人实际选择或填写的回答
  refId: nonempty.nullable(), // 关联业务记录 id，例如审批单或交账
  subjectKey: nonempty, // 同一事项的稳定标识，用于冷却与等待主人去重
  pushed: bool, // 是否已单独推送给主人
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  expiresAt: timestamp.nullable(), // 到期时间；无到期约束时可为空
  answeredAt: timestamp.nullable(), // 主人回答的时间
  // P65：这件事是在哪个项目主题的回合里提出的；主人处理后，队友接着做的那一回合回到这个主题。
  // 旧记录和不在主题里提出的事项没有这一项，一律按「不属于主题」处理，照旧落私聊。
  topicId: recordId('ptp').nullable().optional(),
  // P79：主人答复提议时附的一句话（已去掉首尾空白，不超过 200 字）；没有附言的记录没有这一项。
  ownerNote: text.optional(),
});
export type InboxItem =z.infer<typeof InboxItemSchema>;
/**
 * P69：分类器给出的「这条动作一共有哪几件事要主人确认」，建审批单时原样存下来。
 * 下一步（A-2）据此给每件事各生成一句主人看得懂的话；旧审批单没有这一项。
 */
/**
 * P69 A-4（S13）：分类器给某一件待确认的事打的「说法标记」，让生成主人话的地方认得出几类没有子类的情况。
 * 标记只影响那句话，不影响类别和自主等级矩阵；旧审批单没有，照旧显示。
 * remote_script 下载来的脚本（detail 是主机名）；blind_script 看不见内容的脚本；sandbox_escape 沙箱管不到的程序（detail 是程序名）；
 * managed_files 看不懂的命令碰到中心管理的文件；delete 删除（D 类，paths 是被删的位置）。
 * A-5（P1）：D 类（不可逆）的每一种理由各有一个标记，让审批卡把分类器的内部理由换成主人看得懂的话：
 * git_force 强推或删除远端分支；publish_package 发布或撤回软件包；elevate 提权；payment 支付下单转账接口；
 * remote_delete 删除云端或代码托管平台上的资源；system_write 往系统目录写文件（paths 是落点）。
 */
export const ASK_HINTS = ['remote_script', 'blind_script', 'sandbox_escape', 'managed_files', 'delete',
  'git_force', 'publish_package', 'elevate', 'payment', 'remote_delete', 'system_write'] as const;
export type AskHint = (typeof ASK_HINTS)[number];
export const ApprovalAskSchema = z.strictObject({
  cls: z.enum(['C', 'D']), // 这件事的类别
  reason: nonempty, // 分类器的理由（中文，来自中心规则，不含队友的原文）
  subclass: nonempty.optional(), // 子类，例如 git_push、remote_access
  detail: nonempty.optional(), // 已清洗的对象：域名、远端和分支、程序名
  download: bool.optional(), // 网络命令只是下载
  blocked: bool.optional(), // 要确认的原因只是「目标在沙箱之外」
  paths: z.array(nonempty).max(8).optional(), // 涉及的路径（最多 8 个）
  hint: z.enum(ASK_HINTS).optional(), // A-4：说法标记，见上
  moreAfter: z.number().int().positive().optional(), // A-4：这一件之后还有这么多件因条数上限没存下来，那句话写「等 N 件」
});
export type ApprovalAsk = z.infer<typeof ApprovalAskSchema>;
/** 校验审批内容与一次性票据状态，防止不同参数误用批准。 */
export const ApprovalSchema = z.strictObject({
  id: recordId('ap'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  actionClass: e.ApprovalActionClassSchema, // 只允许 C 或 D：对外或高风险动作
  tool: nonempty, // 被请求执行的工具名
  actionText: nonempty.optional(), // 给主人看的动作描述；旧记录缺省时从参数预览还原
  // 2：按全部目标生成的描述；3（P69）：按分类结果生成的主人话，不含原始命令。缺省是更早的旧档，读取时重算或保守回退。
  actionTextVersion: z.union([z.literal(2), z.literal(3)]).optional(),
  ownerReason: nonempty.optional(), // P69：为什么要做这件事（队友的 why，或它此刻在做的事）；旧记录没有
  riskNote: nonempty.optional(), // P69：风险提示（例如中心代跑命令的沙箱提醒）；旧记录没有，界面按「无」显示
  argsPreview: byteText(4096), // M02 长命令展示首尾各 400 字，允许中文预览达到 4 KB
  contentHash: text.regex(/^[a-f0-9]{64}$/, '批准内容哈希必须是 64 位小写十六进制字符'), // 工具名与规范化参数的 SHA-256，批准只对相同内容生效一次
  why: nonempty, // 创建或执行的理由
  status: e.ApprovalStatusSchema, // 待审批、已批准、已拒绝、已过期或已使用
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  decidedAt: timestamp.nullable(), // 主人批准或拒绝的时间
  expiresAt: timestamp, // 到期时间；无到期约束时可为空
  usedAt: timestamp.nullable(), // 一次性批准票被消费的时间
  // P65：申请审批时队友正在哪个项目主题的回合里；主人批准或拒绝后，接着做的那一回合回到这个主题。
  // 旧审批单没有这一项，按「不属于主题」处理。
  topicId: recordId('ptp').nullable().optional(),
  // P69：分类器记下的待确认事项清单，供审批卡生成人话用；旧审批单没有，界面按旧写法显示。
  asks: z.array(ApprovalAskSchema).max(24).optional(),
  // P74r4b-m1：中心作废的审批为 true（状态同时记为已过期）；主人拒绝、到期没人处理、已使用的没有这一项。界面据此写「已作废」。
  voided: z.boolean().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
/** 校验中心代执行动作的状态，保留审批和执行结果的关联。 */
export const OutboxActionSchema = z.strictObject({
  id: recordId('o'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  kind: e.OutboxKindSchema, // 通知主人、写文件、网络提交或运行命令
  payload: z.record(text, z.unknown()), // 动作负载，由对应出站动作校验结构
  commandFiles: z.array(z.strictObject({
    path: nonempty.startsWith('/', '命令文件路径必须是绝对路径'), // 原引用路径，执行前重新检查链接
    realPath: nonempty.startsWith('/', '命令文件真实路径必须是绝对路径').optional(),
    sha256: text.regex(/^[a-f0-9]{64}$/, '命令文件哈希必须是 64 位小写十六进制字符'),
  })).optional(), // M12：旧档缺字段按空兼容读取；执行前须补齐内容并重新审批
  why: nonempty, // 创建或执行的理由
  actionClass: e.ActionClassSchema, // 动作类别 A–D，决定自主等级与审批门槛
  approvalId: nonempty.nullable(), // 关联审批单 id；无需审批时为空
  status: e.OutboxStatusSchema, // 等待审批、可执行、完成、失败或拒绝
  result: text.nullable(), // 执行结果摘要或失败原因
  executionStarted: bool.optional(), // 是否真正调用执行接口；执行前复查被拦不能声称已经执行
  ownerFailureReason: text.optional(), // 中心确认的一句失败原因，不能包含网络正文或命令输出
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  doneAt: timestamp.nullable(), // 执行完成时间
});
export type OutboxAction = z.infer<typeof OutboxActionSchema>;
