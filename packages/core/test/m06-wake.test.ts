/** M06 自主等级说明回归：提议不冒充生效，试岗按实际 L1 权限提示，长包也不能丢掉边界。 */
import { describe, expect, test } from 'vitest';
import { buildWakePacket } from '../src/wake/packet.js';
import { byteLength } from '../src/util/text.js';
import { newId } from '../src/util/ids.js';
import { turnContext } from './c03-turn-fixtures.js';

const l1Rule = '你现在是 L1：新目标与新关注只能提议，主人同意前不生效，向主人汇报时要说『已提议』而不是『已设好』。';

describe('M06 唤醒包按实际自主等级说明提议边界', () => {
  test.each(['regular', 'light_check', 'reflection', 'catch_up', 'trial', 'teach'] as const)(
    'L1 的 %s 唤醒包保留提议文案且不放进外部围栏', async variant => {
      const { ctx, bot, entry, ticket } = await turnContext(variant, { autonomy: 'L1' });
      const packet = await buildWakePacket(ctx, bot, entry, ticket);
      const trusted = packet.replace(/<<<untrusted\n[\s\S]*?\nuntrusted>>>/g, '');
      expect(trusted).toContain(l1Rule);
      if (variant === 'light_check') {
        // 轻复查沿用简版模板，但仍保留同样的权限边界，不能因为没有规矩标题漏掉提示。
        expect(packet).not.toContain('## 规矩');
        expect(packet).not.toContain('## 记忆摘要');
      } else {
        expect(packet.split('## 规矩')[1]!.split('\n\n')[0]).toContain(l1Rule);
      }
      expect(byteLength(packet)).toBeLessThanOrEqual(ctx.settings.wakePacketMaxBytes);
    },
  );

  test.each(['L2', 'L3'] as const)('%s 文案说明权限内可生效，不误报为 L1 只能提议', async autonomy => {
    const { ctx, bot, entry, ticket } = await turnContext('regular', { autonomy });
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain(`你现在是 ${autonomy}：已有志向下的新目标与权限内的新关注`);
    expect(packet).toContain('是否生效以工具返回为准');
    expect(packet).toContain('未获主人同意的提议仍未生效');
    expect(packet).not.toContain(l1Rule);
    expect(packet).not.toContain('新目标与新关注只能提议');
  });

  test('L0 说明只观察，不能冒充拥有 L1 提议权限', async () => {
    const { ctx, bot, entry, ticket } = await turnContext('regular', { autonomy: 'L0' });
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain('你现在是 L0：只观察，不能新建目标与关注');
    expect(packet).not.toContain(l1Rule);
  });

  test.each(['L0', 'L2', 'L3'] as const)('试岗即使保存为 %s 仍按实际 L1 权限提示', async autonomy => {
    const { ctx, bot, entry, ticket } = await turnContext('trial', { autonomy, lifecycle: 'probation' });
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain(l1Rule);
    expect(packet).not.toContain(`你现在是 ${autonomy}：`);
    expect(packet).toContain('是否生效以工具返回为准');
  });

  test.each(['regular', 'trial'] as const)('%s 长包压缩保留完整 L1 提议提示', async variant => {
    const { ctx, bot, entry, ticket } = await turnContext(variant, { autonomy: 'L1' });
    for (let i = 0; i < 20; i++) {
      ctx.store.table('aspirations').put({ id: newId('asp', ctx.rng), botId: bot.id,
        text: '待核实的长期方向'.repeat(200), status: 'active', createdBy: 'owner', approved: true,
        createdAt: ctx.clock.now() });
    }
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain(l1Rule);
    expect(packet).toContain('最后一步必须 hub_commit');
    expect(byteLength(packet)).toBeLessThanOrEqual(ctx.settings.wakePacketMaxBytes);
  });
});
