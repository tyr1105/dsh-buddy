/**
 * F17 资料可见性 - org/access.ts 纯函数测试（取消编制后版本）。
 * 直接喂 bots/resources/grants 三张表快照，覆盖：normal 全队口径、
 * restricted 只认队友本人直授、归档不可读、旧档里的席位/部门授权被忽略。
 */
import { describe, expect, it } from 'vitest';
import type { Bot } from '../src/model/index.js';
import type { Grant, Resource } from '../src/model/resource.js';
import {
  canRead, effectiveGrants, explainReadDenial, hasResourceGrant,
  isBotOnTeam, readableResources, type ResourceAccessData,
} from '../src/org/access.js';
import { botFixture } from './model-fixtures.js';

const NOW = 1_793_808_000_000;

function teamBot(id: string, lifecycle: Bot['lifecycle'] = 'active'): Bot {
  return { ...botFixture, id, name: `队友${id}`, lifecycle, homeDir: `/hub/bots/${id}` };
}
function res(partial: Partial<Resource> = {}): Resource {
  return {
    id: 'res_0000000001', name: '资料一', kind: 'file', locator: '/hub/shared/a.txt',
    sensitivity: 'normal', createdAt: NOW, updatedAt: NOW, archivedAt: null, ...partial,
  };
}
function grant(partial: Partial<Grant> = {}): Grant {
  return {
    id: 'gr_0000000001', resourceId: 'res_0000000001', subjectKind: 'bot',
    subjectId: 'b_0000000001', level: 'read', createdAt: NOW, createdBy: 'owner', ...partial,
  };
}
/** 组装快照的小助手；bots/resources/grants 各自可覆盖。 */
function snapshot(parts: Partial<ResourceAccessData> = {}): ResourceAccessData {
  return {
    bots: parts.bots ?? [teamBot('b_0000000001')],
    resources: parts.resources ?? [res()],
    grants: parts.grants ?? [],
  };
}

describe('F17 canRead 基础口径', () => {
  it('normal 资料：active 与 probation 队友可读', () => {
    const data = snapshot({ bots: [teamBot('b_0000000001', 'active'), teamBot('b_0000000002', 'probation')] });
    expect(canRead(data.bots[0]!, data.resources[0]!, data, NOW)).toBe(true);
    expect(canRead(data.bots[1]!, data.resources[0]!, data, NOW)).toBe(true);
  });

  it.each(['retired', 'paused', 'draft', 'quarantined'] as const)('normal 资料：%s 状态队友不可读', lifecycle => {
    const bot = teamBot('b_0000000001', lifecycle);
    const data = snapshot({ bots: [bot] });
    expect(isBotOnTeam(bot)).toBe(false);
    expect(canRead(bot, data.resources[0]!, data, NOW)).toBe(false);
  });

  it('restricted 资料：无授权不可读，bot 直授可读（read 与 write 都赋读资格）', () => {
    const bot = teamBot('b_0000000001');
    const restricted = res({ sensitivity: 'restricted' });
    const noGrant = snapshot({ bots: [bot], resources: [restricted] });
    expect(canRead(bot, restricted, noGrant, NOW)).toBe(false);
    const withRead = snapshot({ bots: [bot], resources: [restricted], grants: [grant({ level: 'read' })] });
    expect(canRead(bot, restricted, withRead, NOW)).toBe(true);
    const withWrite = snapshot({ bots: [bot], resources: [restricted], grants: [grant({ id: 'gr_0000000002', level: 'write' })] });
    expect(canRead(bot, restricted, withWrite, NOW)).toBe(true);
  });

  it('restricted：只认本人直授；别人的授权与他无关', () => {
    const me = teamBot('b_0000000001');
    const other = teamBot('b_0000000002');
    const restricted = res({ sensitivity: 'restricted' });
    const data = snapshot({
      bots: [me, other], resources: [restricted],
      grants: [grant({ subjectId: other.id })],
    });
    expect(canRead(me, restricted, data, NOW)).toBe(false);
    expect(canRead(other, restricted, data, NOW)).toBe(true);
  });

  it('归档资料：normal 与带授权的 restricted 都不可读', () => {
    const bot = teamBot('b_0000000001');
    const archivedNormal = res({ archivedAt: NOW });
    const archivedRestricted = res({ id: 'res_0000000002', sensitivity: 'restricted', archivedAt: NOW });
    const data = snapshot({ bots: [bot], resources: [archivedNormal, archivedRestricted], grants: [grant()] });
    expect(canRead(bot, archivedNormal, data, NOW)).toBe(false);
    expect(canRead(bot, archivedRestricted, data, NOW)).toBe(false);
  });
});

describe('F17 旧档授权兼容', () => {
  it('旧档里席位、部门的授权一律忽略，不报错，只有 bot 直授生效', () => {
    const me = teamBot('b_0000000001');
    const restricted = res({ sensitivity: 'restricted' });
    // 旧版本写入的授权行：subjectKind 可能是 position/department，读取时当脏数据忽略。
    const legacy = [
      { id: 'gr_0000000001', resourceId: restricted.id, subjectKind: 'position', subjectId: 'pos_0000000001', level: 'read', createdAt: NOW, createdBy: 'owner' },
      { id: 'gr_0000000002', resourceId: restricted.id, subjectKind: 'department', subjectId: 'dept_0000000001', level: 'read', createdAt: NOW, createdBy: 'owner' },
    ] as unknown as Grant[];
    const data = snapshot({ bots: [me], resources: [restricted], grants: legacy });
    expect(hasResourceGrant(data, me.id, restricted.id)).toBe(false);
    expect(effectiveGrants(data, me.id)).toEqual([]);
    expect(canRead(me, restricted, data, NOW)).toBe(false);

    data.grants.push(grant({ id: 'gr_0000000003', subjectId: me.id }));
    expect(hasResourceGrant(data, me.id, restricted.id)).toBe(true);
    expect(effectiveGrants(data, me.id).map(h => h.via)).toEqual(['bot']);
  });

  it('同一授权在快照里重复出现：命中判定仍成立（授权唯一由写入层保证）', () => {
    const me = teamBot('b_0000000001');
    const restricted = res({ sensitivity: 'restricted' });
    const hit = grant({ subjectId: me.id });
    const data = snapshot({ bots: [me], resources: [restricted], grants: [hit, { ...hit }] });
    // 取消编制后生效授权只剩「本人直授」一条来源，不再做跨席位展开去重；
    // 授权 id 的唯一性由存储层按 id 覆盖与 setGrant 的自然键 upsert 保证。
    expect(effectiveGrants(data, me.id).every(entry => entry.via === 'bot')).toBe(true);
    expect(hasResourceGrant(data, me.id, restricted.id)).toBe(true);
  });
});

describe('F17 readableResources 与拒绝解释', () => {
  it('只回非归档且可读的资料，按创建时间再 id 稳定排序', () => {
    const me = teamBot('b_0000000001');
    const r1 = res({ id: 'res_0000000003', createdAt: NOW + 20 });
    const r2 = res({ id: 'res_0000000001', createdAt: NOW + 10 });
    const r3 = res({ id: 'res_0000000002', createdAt: NOW + 10, archivedAt: NOW });
    const r4 = res({ id: 'res_0000000004', createdAt: NOW + 30, sensitivity: 'restricted' });
    const data = snapshot({ bots: [me], resources: [r1, r2, r3, r4] });
    expect(readableResources(data, me.id, NOW).map(r => r.id)).toEqual([r2.id, r1.id]);
  });

  it('不存在的队友没有可读资料', () => {
    const data = snapshot();
    expect(readableResources(data, 'b_9999999999', NOW)).toEqual([]);
  });

  it('explainReadDenial：归档/不存在、不在岗、无授权分别给中文原因；可读返回 null', () => {
    const me = teamBot('b_0000000001');
    const restricted = res({ sensitivity: 'restricted' });
    const normal = res();
    const data = snapshot({ bots: [me], resources: [restricted, normal] });
    expect(explainReadDenial(me, restricted, data, NOW)).toContain('没有资料');
    expect(explainReadDenial(me, normal, data, NOW)).toBeNull();
    expect(explainReadDenial(me, res({ archivedAt: NOW }), data, NOW)).toContain('已归档');
    expect(explainReadDenial(me, null, data, NOW)).toContain('不存在或已归档');
    const paused = teamBot('b_0000000002', 'paused');
    expect(explainReadDenial(paused, normal, snapshot({ bots: [paused] }), NOW)).toContain('不在岗');
  });
});
