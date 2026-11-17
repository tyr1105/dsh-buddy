/** 普通交账工具委托统一交账处理器，避免不同入口漏记日志或绕过重复交账检查。 */
import { CommitToolSchema } from '../commit/schema.js';
import { processCommit } from '../commit/process.js';
import { defineTool } from './common.js';
export const hubCommit = defineTool('hub_commit', '本轮最后一步交账：报告实际结果、世界变化、证据与验证范围，并只约下一次思考及理由；主人消息必须 reply，阻塞须 blocker，需要主人须 ownerQuestion（总管在等主人确认约定时除外：约定卡就是提问，不填 ownerQuestion）；reply、report、blocker、ownerQuestion 没有内容时可以省略。', CommitToolSchema, 'all', processCommit);
