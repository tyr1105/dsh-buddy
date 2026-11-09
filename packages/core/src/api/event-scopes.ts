/** 界面刷新范围的唯一词表：推送描述发生变化的视图，插件据此定向重取数据，不依赖内部表名。 */
export const HUB_EVENT_SCOPES = {
  /** 全队总览变化：启动、健康、额度或团队汇总；全局变化 botId 为 null，单个机器人变化必须带它的 id。 */
  overview: 'overview',
  /** 机器人详情和对应总览卡片变化：交账、感知、议程、目标、关注、规矩、套路、生命周期、队列或回合；botId 必带。 */
  bot: 'bot',
  /** 线程消息、已读状态或内嵌卡片变化；机器人线程必带 botId，只有团队线程用 null。 */
  thread: 'thread',
  /** 收件箱新建、作答、审批决定、到期或关闭；机器人项必带 botId，中心级项目用 null。 */
  inbox: 'inbox',
  /** 活动流新增或现有活动状态变化：回合、交账、审批、告警、协作、生命周期和启停；机器人活动必带 botId，全局启停用 null。 */
  activity: 'activity',
  /** 全局设置或模型选项变化；botId 为 null。机器人自身模型变更使用 bot。 */
  settings: 'settings',
  /** 唤醒账本新增、追加动作或封存；机器人项必带 botId，集中回填用 null。 */
  ledger: 'ledger',
  /** 项目容器变化：项目与任务、验收结论；全队结构，botId 固定 null。 */
  project: 'project',
  /** 办公室投影变化：队友状态、账本、收件箱或资料变动都可能改变房间；botId 按来源带。 */
  office: 'office',
} as const;

/** 订阅者只需处理这些公开范围，不应判断 queue、wakes、bots 等内部表名。 */
export type HubEventScope = typeof HUB_EVENT_SCOPES[keyof typeof HUB_EVENT_SCOPES];
