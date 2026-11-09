/** 认领工具返回实际持有者，冲突时不覆盖他人的负责范围。 */
import { claim, ClaimInputSchema } from '../peer/claims.js';
import { defineTool } from './common.js';
export const hubClaim = defineTool('hub_claim', '认领 resource，说明 why；minutes 默认 120、最长 1440。已被同伴持有会返回持有者和到期时间，不会抢占。', ClaimInputSchema, 'L1', (ctx, tc, args) => {
    const result = claim(ctx, tc.botId, args);
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.text };
});
