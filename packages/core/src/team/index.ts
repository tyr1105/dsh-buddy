/**
 * 组队相关的公开出口：模板库数据、规则表、模型档位，以及客户端要用的性格四句话。
 *
 * 这个文件同时是子路径出口 `@agent-hub/core/team` 的入口，插件的浏览器端从这里导入。
 * 所以它和它引用的文件只能是纯数据和纯函数：不能引入 node 内置模块，
 * 也不能引入存储、引擎、文件读写等模块（由 test/p73b-team-entry.test.ts 守住）。
 */
export * from './templates.js';
export * from './rules.js';
export * from './model-tiers.js';
// 性格四句话总表和取句函数在 model/mbti.ts（只依赖枚举），从这里再导出一次，客户端不必另找出口。
export { MBTI_BEHAVIOR_TEXT, mbtiBehaviorLines } from '../model/mbti.js';
