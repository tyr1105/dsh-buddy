/** C03 的交互边界：数值默认由 defaults.ts 提供，这里只校验覆盖项。 */
import { z } from 'zod';
import { positive, ratio } from './primitives.js';
const integer = positive.int('必须是正整数');
/** 校验主人交互与出站边界，避免配置突破消息和审批预算。 */
export const InteractionSettingsSchema = z.strictObject({
  approvalPreviewMaxBytes: integer.max(1024, '审批摘要最多 1024 字节'), // 审批参数预览的字节上限，最多 1 KB
  approvalPreviewEdgeChars: integer.max(400, '长命令首尾最多各 400 字'), // 保留危险尾部，不能仅截断开头
  approvalOwnerParamsMaxChars: integer.min(10, '卡片原始参数至少保留 10 字').max(300, '卡片原始参数最多 300 字'), // 主人卡片末行的参数上限
  actionCommandMaxChars: integer.max(60, '动作描述中的命令最多 60 字'), // 标题只显示简短命令
  maxCommandDepth: integer.max(4, '命令包装最多递归四层'), // 超出可证明范围保守审批
  outboxResultMaxBytes: integer, // 出站结果摘要的字节上限
  reportPushImportance: integer.max(10, '重要度最多 10'), // 主动报告达到此重要度才尝试单推
  reportDigestImportance: integer.max(10, '重要度最多 10'), // 主动报告达到此重要度才进入日报
  outboxDoneSalience: ratio, // 出站动作完成感知的显著性
  botDueAgendaCap: integer, // 机器人自主创建带到期时间议程的上限
  handoffExpiryMs: positive, // 交接单未完成的过期时长
  stateMaxBytes: integer, // 自我状态概览的字节上限
  reflectionWeekMinTurns: integer, // 周日自动复盘要求本周至少多少回合
  reflectionHour: z.number().int().min(0).max(23), // 周日自动复盘的本地小时
  reflectionDailyCap: integer, // 每天复盘次数上限
  blockedChiefAfterMs: positive, // 机器人受阻多久后提醒总管
  reviewBackoffMultiplier: positive, // 无变化复查议程的间隔倍率
  teachDigestMaxChars: integer, // 教学时原会话摘要的字符上限
  teachDigestMaxBytes: integer, // 教学时原会话摘要的字节上限
  digestReportLimit: integer, // 日报最多列出的重要报告数
  deferredReportMaxChars: integer.max(60, '延迟汇报的首句最多 60 字'), // 日报补充被推迟汇报的首句长度
  awaitingApprovalCancelMs: positive, // 宿主审批框挂起多久后取消回合
  committedEndGraceMs: positive, // 已交账后等待 ended 的宽限，不再取消或计错
  packetAgendaKeep: integer, // 唤醒包优先保留的议程条数
  packetEvidenceKeep: integer, // 唤醒包优先保留的证据条数
  packetPerceptChars: integer, // 感知证据摘要最多保留的字符数
  packetAspirationChars: integer, // 志向证据最多保留的字符数
  reflectionHistoryMs: positive, // 复盘回溯历史的时间范围
  dayMs: positive, // 一天对应的毫秒数，供周期计算使用
  weekMs: positive, // 一周对应的毫秒数，供周期计算使用
  handoffAgendaPriority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), // 接收交接后创建议程的优先级
  reflectCommitImportance: integer.max(10, '重要度最多 10'), // 复盘交账的重要度
  syntheticCommitImportance: integer.max(10, '重要度最多 10'), // 中心合成未交账记录的重要度
});
