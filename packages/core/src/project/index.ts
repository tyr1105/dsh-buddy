/**
 * 项目容器模块统一出口（v2 第四期 F08，core 侧）：
 * 任务状态机纯函数、项目汇总纯函数、主人命令服务。
 * 测试可单独引纯函数，不需要构造存储与宿主。
 */
export * from './task-state.js';
export * from './project-summary.js';
export * from './service.js';
export * from './shared-dir.js';
// P39 项目共享上下文：渲染、哈希、变更摘要与唤醒包摘要是纯函数，供测试与宿主复用。
export * from './context.js';
// P60/P63 项目负责人规则与主题讨论：判断规则都是纯函数，流程函数供宿主与测试复用。
export * from './owner-rules.js';
export * from './owner-tasks.js';
export * from './topic-mentions.js';
export * from './topic-rounds.js';
export * from './topics.js';
// P65：主题里提的事项，主人处理后接着做的那一回合回到原主题。
export * from './topic-followup.js';
