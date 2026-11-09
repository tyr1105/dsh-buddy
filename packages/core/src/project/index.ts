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
