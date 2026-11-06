/** 仿真专用替身入口，与真实环境的适配分开，防止生产代码意外依赖测试状态。 */
export * from './fake-clock.js';
export * from './seeded-rng.js';
export * from './memory-fs.js';
export * from './fake-net.js';
export * from './fake-exec.js';
export * from './memory-logger.js';
export * from './fake-host.js';
export * from './create-test-context.js';
