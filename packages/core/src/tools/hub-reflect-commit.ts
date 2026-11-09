/** 复盘交账工具只在反思回合内生效，保持复盘的只读边界和明确结束标志。 */
import { ReflectCommitInputSchema, processReflectCommit } from '../reflect/process.js';
import { defineTool } from './common.js';
export const hubReflectCommit = defineTool('hub_reflect_commit', '复盘回合最后一步：summary 总结、lessons 教训、watchChanges 按新增或更新关注的字段、routineUpdates 套路；paceAdvice 只作为主人可见建议。', ReflectCommitInputSchema, 'all', processReflectCommit);
