/**
 * 项目共享上下文建议工具（队友侧，P39）：队友可以对项目上下文提修改建议，
 * 但不能直接改正文——主人采纳后才写入 context.md 并留痕。
 *
 * 为什么做成「建议」而不是写入口：共享上下文是所有成员干活的前提，一个队友擅自改
 * 会悄悄改变别人看到的世界。建议落 projectContextProposals 表，主人确认后走与主人编辑
 * 完全相同的写文件路径，修订记录里保留提议者，责任可追溯。
 *
 * 纪律：只认成员身份（服务层校验）、只在进行中的项目提；每人在每个项目只保留一条待审建议。
 */
import { defineTool } from './common.js';
import { ProposeProjectContextSchema, proposeProjectContext } from '../project/context-service.js';

export const hubProjectContextPropose = defineTool('hub_project_context_propose',
  '对你参与的项目提交共享上下文修改建议（背景、约定、决策、术语表任选其一）；不直接改正文，等主人确认。',
  ProposeProjectContextSchema, 'L1', (ctx, tc, args) => {
    const proposal = proposeProjectContext(ctx, tc.botId, args);
    return {
      ok: true,
      text: `建议已提交（项目 ${proposal.projectId}）：主人在项目页确认前不会写入共享上下文，也不会改变其他队友看到的内容。`,
    };
  });
