/**
 * F17 资料可见性 - 服务层测试（org/resource-service.ts）。
 * 覆盖：路径/URL/笔记校验、归档与授权规则、防误操作上限、审计与事件、
 * 失败命令不消耗 RNG、upsert 不新增行不耗随机序列。
 * 主人取消编制后，资料不再有归属部门，授权对象只剩队友本人。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { V2_DEFAULTS } from '../src/config/defaults.js';
import {
  archiveResource, resolveSharedLocator, revokeGrant, saveResource, setGrant,
} from '../src/org/resource-service.js';
import type { Bot } from '../src/model/bot.js';
import { botFixture } from './model-fixtures.js';

/** 资源相关审计（resource_* 与 grant_set），与 ui_ 审计区分。 */
function resourceAudits(ctx: HubContext) {
  return ctx.store.log('audit').all().filter(a => a.action.startsWith('resource_') || a.action === 'grant_set');
}

/** 造一个在岗队友档案，作为授权对象。 */
function putBot(ctx: HubContext, id: string, name: string): Bot {
  const now = ctx.clock.now();
  const bot: Bot = { ...botFixture, id, name, homeDir: `/hub/bots/${id}`, createdAt: now, updatedAt: now };
  ctx.store.table('bots').put(bot);
  return bot;
}

describe('F17 resolveSharedLocator 路径收敛', () => {
  it('共享目录内的绝对路径规范化后通过', () => {
    expect(resolveSharedLocator('/hub/shared/../shared/dir/a.txt', '/hub')).toBe('/hub/shared/dir/a.txt');
  });
  it.each([
    ['../ 逃逸', '/hub/shared/../secret.txt'],
    ['共享目录外', '/etc/passwd'],
    ['相对路径', 'shared/a.txt'],
    ['家目录', '~/secret.txt'],
    ['变量', '$HOME/a.txt'],
    ['反引号', '/hub/shared/`id`.txt'],
  ])('%s 被中文拒绝', (_name, locator) => {
    expect(() => resolveSharedLocator(locator, '/hub')).toThrow(/共享目录|绝对路径|~/);
  });
  it('凭据与 .env 路径按敏感路径拒绝', () => {
    expect(() => resolveSharedLocator('/hub/shared/.env', '/hub')).toThrow('凭据');
    expect(() => resolveSharedLocator('/hub/shared/key.pem', '/hub')).toThrow('凭据');
  });
});

describe('F17 saveResource 新建与修改', () => {
  it('新建文件资料：生成 res_ id、写 resource_create 审计（actor=owner）、发 overview 事件', () => {
    const ctx = createTestContext();
    const saved = saveResource(ctx, { name: '名单', kind: 'file', locator: '/hub/shared/list.txt' });
    expect(saved.id).toMatch(/^res_[a-z0-9]{10}$/);
    expect(saved.sensitivity).toBe('normal');
    expect(saved.archivedAt).toBeNull();
    const audit = resourceAudits(ctx)[0]!;
    expect(audit.action).toBe('resource_create');
    expect(audit.actor).toBe('owner');
    expect(JSON.parse(audit.detail)).toMatchObject({ id: saved.id, kind: 'file' });
    expect(ctx.events).toContainEqual({ scope: 'overview', botId: null });
  });

  it('url 资料接受 http/https；ftp 与非法地址中文拒绝；note 保守拒绝', () => {
    const ctx = createTestContext();
    expect(saveResource(ctx, { name: '站', kind: 'url', locator: 'https://example.test/p' }).locator).toBe('https://example.test/p');
    expect(saveResource(ctx, { name: '站2', kind: 'url', locator: 'http://example.test/' }).locator).toBe('http://example.test/');
    expect(() => saveResource(ctx, { name: '坏', kind: 'url', locator: 'ftp://example.test/a' })).toThrow('http 或 https');
    expect(() => saveResource(ctx, { name: '坏', kind: 'url', locator: 'not a url' })).toThrow('有效');
    expect(() => saveResource(ctx, { name: '笔记', kind: 'note', locator: 'note-1' }))
      .toThrow('笔记资料后续版本支持');
  });

  it('修改资料：id 不变、写 resource_update；类型不可改；已归档不可改', () => {
    const ctx = createTestContext();
    const saved = saveResource(ctx, { name: '原名', kind: 'file', locator: '/hub/shared/a.txt' });
    const updated = saveResource(ctx, { id: saved.id, name: '新名', kind: 'file', locator: '/hub/shared/b.txt' });
    expect(updated.id).toBe(saved.id);
    expect(updated.name).toBe('新名');
    expect(resourceAudits(ctx).map(a => a.action)).toEqual(['resource_create', 'resource_update']);
    expect(() => saveResource(ctx, { id: saved.id, name: 'x', kind: 'url', locator: 'https://x.test' }))
      .toThrow('类型创建后不能修改');
    archiveResource(ctx, saved.id);
    expect(() => saveResource(ctx, { id: saved.id, name: 'y', kind: 'file', locator: '/hub/shared/b.txt' }))
      .toThrow('已归档');
  });

  it('未归档资料达 RESOURCE_MAX_ACTIVE 上限后新建被拒', () => {
    const ctx = createTestContext();
    for (let i = 0; i < V2_DEFAULTS.RESOURCE_MAX_ACTIVE; i++) {
      saveResource(ctx, { name: `r${i}`, kind: 'file', locator: `/hub/shared/f${i}.txt` });
    }
    expect(() => saveResource(ctx, { name: '超', kind: 'file', locator: '/hub/shared/extra.txt' }))
      .toThrow(`防误操作上限 ${V2_DEFAULTS.RESOURCE_MAX_ACTIVE}`);
    // 归档一条后腾出名额。
    archiveResource(ctx, ctx.store.table('resources').list()[0]!.id);
    expect(saveResource(ctx, { name: '腾出来的', kind: 'file', locator: '/hub/shared/extra.txt' }).archivedAt).toBeNull();
  });

  it('非法保存不耗 RNG：失败后下一条资料 id 与对照环境一致', () => {
    const good = createTestContext();
    const bad = createTestContext();
    const expectedId = saveResource(good, { name: '参照', kind: 'file', locator: '/hub/shared/a.txt' }).id;
    expect(() => saveResource(bad, { name: '坏', kind: 'file', locator: '../escape.txt' })).toThrow();
    expect(saveResource(bad, { name: '参照', kind: 'file', locator: '/hub/shared/a.txt' }).id).toBe(expectedId);
    expect(resourceAudits(bad).map(a => a.action)).toEqual(['resource_create']);
  });
});

describe('F17 archiveResource 归档', () => {
  it('归档只打标不删除，写 resource_archive；重复归档被拒', () => {
    const ctx = createTestContext();
    const saved = saveResource(ctx, { name: 'r', kind: 'file', locator: '/hub/shared/a.txt' });
    const archived = archiveResource(ctx, saved.id);
    expect(archived.archivedAt).toBe(ctx.clock.now());
    expect(ctx.store.table('resources').get(saved.id)).not.toBeNull();
    expect(() => archiveResource(ctx, saved.id)).toThrow('已经归档');
  });
  it('归档不存在的资料被中文拒绝', () => {
    const ctx = createTestContext();
    expect(() => archiveResource(ctx, 'res_0000000099')).toThrow('资料不存在');
  });
});

describe('F17 setGrant 授权', () => {
  /** 建一份未归档资料 + 两个在岗队友（A、B）。 */
  function grantFixture() {
    const ctx = createTestContext();
    const resource = saveResource(ctx, { name: '受限', kind: 'file', locator: '/hub/shared/s.txt', sensitivity: 'restricted' });
    const botA = putBot(ctx, 'b_0000000001', '队友 A');
    const botB = putBot(ctx, 'b_0000000002', '队友 B');
    return { ctx, resource, botA, botB };
  }

  it('两个队友授权成功，写 grant_set 审计；id 前缀不对直接拒', () => {
    const { ctx, resource, botA, botB } = grantFixture();
    setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: botA.id, level: 'read' });
    setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: botB.id, level: 'write' });
    expect(() => setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: 'dept_x', level: 'read' }))
      .toThrow('subjectId：授权对象必须是 b_ 开头的队友 id');
    const audits = resourceAudits(ctx).filter(a => a.action === 'grant_set');
    expect(audits).toHaveLength(2);
    expect(audits.every(a => a.actor === 'owner')).toBe(true);
  });

  it('授权队友不存在、资料不存在/已归档分别中文拒绝', () => {
    const { ctx, resource, botA } = grantFixture();
    expect(() => setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: 'b_0000000099', level: 'read' }))
      .toThrow('授权队友不存在');
    expect(() => setGrant(ctx, { resourceId: 'res_0000000099', subjectKind: 'bot', subjectId: botA.id, level: 'read' }))
      .toThrow('资料不存在');
    archiveResource(ctx, resource.id);
    expect(() => setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: botA.id, level: 'read' }))
      .toThrow('归档资料不能新增授权');
  });

  it('同自然键 upsert：只改 level，不新增行、不耗 RNG，审计带 updated:true', () => {
    const { ctx, resource, botA } = grantFixture();
    const first = setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: botA.id, level: 'read' });
    const patched = setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: botA.id, level: 'write' });
    expect(patched.id).toBe(first.id);
    expect(patched.level).toBe('write');
    expect(ctx.store.table('grants').count()).toBe(1);
    const lastAudit = resourceAudits(ctx).filter(a => a.action === 'grant_set').at(-1)!;
    expect(JSON.parse(lastAudit.detail)).toMatchObject({ updated: true, level: 'write' });

    // RNG 对照：审计本身要为审计 id 取 10 次随机数，所以不能拿「下游授权 id」直接比对；
    // 这里直接数随机取样次数：upsert 只允许写一条审计（10 次），不得再为授权 id 取随机数。
    const nextSpy = vi.spyOn(ctx.rng, 'next');
    setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: botA.id, level: 'read' });
    expect(nextSpy).toHaveBeenCalledTimes(10);
    nextSpy.mockRestore();
  });

  it('授权总数达 RESOURCE_GRANT_MAX 后新建被拒', () => {
    const ctx = createTestContext();
    const resource = saveResource(ctx, { name: 'r', kind: 'file', locator: '/hub/shared/a.txt', sensitivity: 'restricted' });
    const extraBot = putBot(ctx, 'b_0000000999', '溢出的队友');
    // 直接写表把授权数灌到上限，避免循环造 200 个队友；对象 id 全部互不相同。
    for (let i = 0; i < V2_DEFAULTS.RESOURCE_GRANT_MAX; i++) {
      ctx.store.table('grants').put({
        id: `gr_${String(i + 1).padStart(10, '0')}`, resourceId: resource.id,
        subjectKind: 'bot', subjectId: `b_${String(i + 1).padStart(10, '0')}`,
        level: 'read', createdAt: ctx.clock.now(), createdBy: 'owner',
      });
    }
    // 对真实存在但未授权过的队友发起第 201 条：走新建分支，撞上限。
    expect(() => setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: extraBot.id, level: 'read' }))
      .toThrow(`防误操作上限 ${V2_DEFAULTS.RESOURCE_GRANT_MAX}`);
  });

  it('队友本人直授后可读（服务层与 access 口径打通的冒烟校验）', async () => {
    const { ctx, resource, botA } = grantFixture();
    setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: botA.id, level: 'read' });
    const { canRead } = await import('../src/org/access.js');
    const bot = ctx.store.table('bots').get(botA.id)!;
    const facts = {
      bots: ctx.store.table('bots').list(), grants: ctx.store.table('grants').list(),
    };
    expect(canRead(bot, ctx.store.table('resources').get(resource.id)!, facts, ctx.clock.now())).toBe(true);
  });
});

describe('P50 revokeGrant 取消授权', () => {
  it('取消后这位队友不再有授权，并留下审计；重复取消不报错', () => {
    const ctx = createTestContext();
    const bot = putBot(ctx, 'b_a', '甲');
    const resource = saveResource(ctx, { name: '手册', kind: 'url', locator: 'https://example.com/a', sensitivity: 'restricted' });
    setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: bot.id, level: 'read' });
    expect(revokeGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: bot.id })).toEqual({ revoked: true });
    expect(ctx.store.table('grants').count()).toBe(0);
    expect(ctx.store.log('audit').all().some(row => row.action === 'grant_revoked')).toBe(true);
    expect(revokeGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: bot.id })).toEqual({ revoked: false });
  });
  it('只取消指定的那一位', () => {
    const ctx = createTestContext();
    const a = putBot(ctx, 'b_a', '甲');
    const b = putBot(ctx, 'b_b', '乙');
    const resource = saveResource(ctx, { name: '手册', kind: 'url', locator: 'https://example.com/a', sensitivity: 'restricted' });
    setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: a.id, level: 'read' });
    setGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: b.id, level: 'read' });
    revokeGrant(ctx, { resourceId: resource.id, subjectKind: 'bot', subjectId: a.id });
    expect(ctx.store.table('grants').list().map(g => g.subjectId)).toEqual([b.id]);
  });
  it('入参不合法时用中文报错，不多收字段', () => {
    const ctx = createTestContext();
    expect(() => revokeGrant(ctx, { resourceId: 'res_x', subjectKind: 'bot', subjectId: 'b_a', level: 'read' })).toThrow();
  });
});
