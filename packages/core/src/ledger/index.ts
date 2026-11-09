/**
 * 唤醒账本的统一出口：纯函数（开账、封存、证据、截断、回填）与服务层一起导出。
 * 引擎只需要记住「开账、追加动作、封存、回填、调和」五个入口；
 * 测试可以单独引入纯函数，不需要构造存储和宿主。
 */
export * from './evidence.js';
export * from './entry.js';
export * from './caps.js';
export * from './backfill.js';
export * from './service.js';
