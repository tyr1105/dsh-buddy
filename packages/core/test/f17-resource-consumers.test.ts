/**
 * F17 资料可见性 - 两个消费者测试：
 * 1. 唤醒包「## 可查资料」段：场景 D（受限资料只直授队友 A）、normal 全队可见、
 *    归档消失、无资料省略、轻复查也带、类型中文标签；
 * 2. hub_resource_list / hub_resource_read 工具：授权、字节截断、目录子路径逃逸、
 *    链接网络参数、workData 优先、笔记拒绝、审计落痕。
 */
import { describe, expect, it } from 'vitest';
import type { Bot, QueueEntry } from '../src/model/index.js';
import type { Resource } from '../src/model/resource.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { createTicket } from '../src/wake/ticket.js';
import { newId } from '../src/util/ids.js';
import { createBotHome } from '../src/memory/index.js';
import { runTool } from '../src/tools/index.js';
import { V2_DEFAULTS } from '../src/config/defaults.js';
import { saveResource, setGrant, archiveResource } from '../src/org/resource-service.js';
import type { HubContext } from '../src/engine/context.js';
import { turnContext } from './c03-turn-fixtures.js';
import { toolFixture } from './c03-tool-fixtures.js';
import { botFixture } from './model-fixtures.js';

/** 在同一上下文里为第二个队友建一套可跑 buildWakePacket 的候选与运行中唤醒单。 */
async function secondBot(ctx: HubContext, id: string, name: string) {
  const now = ctx.clock.now();
  const bot: Bot = {
    ...botFixture, id, name, homeDir: `/hub/bots/${id}`,
    sessionId: `session-${id}`, sessionStartedAt: now, createdAt: now, updatedAt: now,
  };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const entry: QueueEntry = {
    ...buildCandidate(ctx, { botId: id, kind: 'next_think', variant: 'regular', score: 0.8, summary: '核对资料', now }),
    id: newId('q', ctx.rng), enqueuedAt: now,
  };
  const ticket = createTicket(ctx, entry, bot.sessionId);
  ctx.store.table('wakes').patch(ticket.id, { status: 'running', dispatchedAt: now });
  return { bot, entry, ticket: ctx.store.table('wakes').get(ticket.id)! };
}

describe('F17 唤醒包「可查资料」段', () => {
  it('场景 D：restricted 只直授队友 A：A 的包有摘要与（授权），B 的包整段没有', async () => {
    const setup = await turnContext('regular');
    const { ctx, bot: botA, entry, ticket } = setup;
    const restricted = saveResource(ctx, {
      name: '机密手册', kind: 'file', locator: '/hub/shared/secret.txt', sensitivity: 'restricted',
    });
    setGrant(ctx, { resourceId: restricted.id, subjectKind: 'bot', subjectId: botA.id, level: 'read' });

    const b = await secondBot(ctx, 'b_0000000002', '小乙');

    const packetA = await buildWakePacket(ctx, botA, entry, ticket);
    const packetB = await buildWakePacket(ctx, b.bot, b.entry, b.ticket);
    expect(packetA).toContain('## 可查资料');
    expect(packetA).toContain('- 机密手册（文件）：/hub/shared/secret.txt（授权）');
    expect(packetB).not.toContain('## 可查资料');
    expect(packetB).not.toContain('机密手册');
  });

  it('normal 资料：在岗队友的包都出现，且不带（授权）标记', async () => {
    const setup = await turnContext('regular');
    const { ctx, bot: botA, entry, ticket } = setup;
    saveResource(ctx, { name: '公开名单', kind: 'file', locator: '/hub/shared/list.txt' });
    const b = await secondBot(ctx, 'b_0000000002', '小乙');

    const packetA = await buildWakePacket(ctx, botA, entry, ticket);
    const packetB = await buildWakePacket(ctx, b.bot, b.entry, b.ticket);
    expect(packetA).toContain('- 公开名单（文件）：/hub/shared/list.txt');
    expect(packetA).not.toContain('（授权）');
    expect(packetB).toContain('公开名单');
  });

  it('归档后资料从包里消失；无任何资料时整段省略', async () => {
    const setup = await turnContext('regular');
    const { ctx, bot, entry, ticket } = setup;
    const empty = await buildWakePacket(ctx, bot, entry, ticket);
    expect(empty).not.toContain('## 可查资料');

    const r = saveResource(ctx, { name: '临时资料', kind: 'file', locator: '/hub/shared/tmp.txt' });
    expect(await buildWakePacket(ctx, bot, entry, ticket)).toContain('临时资料');
    archiveResource(ctx, r.id);
    expect(await buildWakePacket(ctx, bot, entry, ticket)).not.toContain('临时资料');
  });

  it('轻复查也带资料段；目录与链接使用中文类型标签', async () => {
    const setup = await turnContext('light_check');
    const { ctx, bot, entry, ticket } = setup;
    saveResource(ctx, { name: '资料夹', kind: 'dir', locator: '/hub/shared/docs' });
    saveResource(ctx, { name: '内网', kind: 'url', locator: 'https://inner.test/p' });
    const packet = await buildWakePacket(ctx, bot, entry, ticket);
    expect(packet).toContain('## 可查资料');
    expect(packet).toContain('资料夹（目录）');
    expect(packet).toContain('内网（链接）');
  });
});

describe('F17 hub_resource_list 工具', () => {
  it('无资料回空提示；只列可读项：受限无授权与已归档不出现，标签为中文', async () => {
    const f = toolFixture();
    const { ctx, tc } = f;
    const empty = await runTool(ctx, tc, 'hub_resource_list', {});
    expect(empty).toMatchObject({ ok: true });
    if (empty.ok) expect(empty.text).toContain('没有可查阅');
    saveResource(ctx, { name: '公开', kind: 'file', locator: '/hub/shared/pub.txt' });
    saveResource(ctx, { name: '机密', kind: 'file', locator: '/hub/shared/sec.txt', sensitivity: 'restricted' });
    const archived = saveResource(ctx, { name: '旧档', kind: 'url', locator: 'https://old.test/' });
    archiveResource(ctx, archived.id);
    return runTool(ctx, tc, 'hub_resource_list', {}).then(result => {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text).toContain('公开');
      expect(result.text).toContain('文件');
      expect(result.text).not.toContain('机密');
      expect(result.text).not.toContain('旧档');
    });
  });
});

describe('F17 hub_resource_read 工具', () => {
  /** 取资源读取审计（ok/denied），便于逐例核对 actor 与 detail。 */
  function readAudits(ctx: ReturnType<typeof toolFixture>['ctx']) {
    return ctx.store.log('audit').all().filter(a => a.action === 'resource_read_ok' || a.action === 'resource_read_denied');
  }

  it('文件读取成功：回正文，写 resource_read_ok 审计（actor=hub，带 resourceId/botId）', async () => {
    const { ctx, bot, tc } = toolFixture();
    await ctx.fs.writeTextAtomic('/hub/shared/a.txt', '资料正文 ABC');
    const r = saveResource(ctx, { name: '资料', kind: 'file', locator: '/hub/shared/a.txt' });
    const result = await runTool(ctx, tc, 'hub_resource_read', { resourceId: r.id });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.text).toContain('资料正文 ABC');
    const row = readAudits(ctx)[0]!;
    expect(row.action).toBe('resource_read_ok');
    expect(row.actor).toBe('hub');
    expect(JSON.parse(row.detail)).toMatchObject({ resourceId: r.id, botId: bot.id, kind: 'file', truncated: false });
  });

  it('超过 65536 字节的正文按 UTF-8 截断并标明', async () => {
    const { ctx, tc } = toolFixture();
    const content = '字'.repeat(40_000); // 每字 3 字节，共 120000 字节
    await ctx.fs.writeTextAtomic('/hub/shared/big.txt', content);
    const r = saveResource(ctx, { name: '大文件', kind: 'file', locator: '/hub/shared/big.txt' });
    const result = await runTool(ctx, tc, 'hub_resource_read', { resourceId: r.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('已截断，超过 65536 字节');
      expect(result.text.length).toBeLessThan(content.length);
    }
    expect(JSON.parse(readAudits(ctx)[0]!.detail)).toMatchObject({ truncated: true });
  });

  it('restricted 无授权：中文失败、写 denied 审计，审计与错误都不含正文', async () => {
    const { ctx, tc } = toolFixture();
    await ctx.fs.writeTextAtomic('/hub/shared/sec.txt', 'SECRETMARKER');
    const r = saveResource(ctx, { name: '机密', kind: 'file', locator: '/hub/shared/sec.txt', sensitivity: 'restricted' });
    const result = await runTool(ctx, tc, 'hub_resource_read', { resourceId: r.id });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain('授权');
      expect(result.error).not.toContain('SECRETMARKER');
    }
    const row = readAudits(ctx)[0]!;
    expect(row.action).toBe('resource_read_denied');
    expect(row.detail).not.toContain('SECRETMARKER');
  });

  it('restricted 直授后可读；归档资料统一回「已归档」口径', async () => {
    const { ctx, tc } = toolFixture();
    await ctx.fs.writeTextAtomic('/hub/shared/sec.txt', '授权后可见');
    const r = saveResource(ctx, { name: '机密', kind: 'file', locator: '/hub/shared/sec.txt', sensitivity: 'restricted' });
    setGrant(ctx, { resourceId: r.id, subjectKind: 'bot', subjectId: tc.botId, level: 'read' });
    const granted = await runTool(ctx, tc, 'hub_resource_read', { resourceId: r.id });
    expect(granted).toMatchObject({ ok: true });
    archiveResource(ctx, r.id);
    const archived = await runTool(ctx, tc, 'hub_resource_read', { resourceId: r.id });
    expect(archived).toMatchObject({ ok: false });
    if (!archived.ok) expect(archived.error).toContain('已归档');
  });

  it('目录：不带 path 列直接子项；path 读子文件；../ 逃逸被中文拒绝', async () => {
    const { ctx, tc } = toolFixture();
    await ctx.fs.mkdirp('/hub/shared/docs');
    await ctx.fs.writeTextAtomic('/hub/shared/docs/a.md', '# 标题甲');
    await ctx.fs.writeTextAtomic('/hub/shared/docs/b.md', '# 标题乙');
    await ctx.fs.writeTextAtomic('/hub/shared/outside.txt', '外面');
    const dir = saveResource(ctx, { name: '资料夹', kind: 'dir', locator: '/hub/shared/docs' });

    const listing = await runTool(ctx, tc, 'hub_resource_read', { resourceId: dir.id });
    expect(listing.ok).toBe(true);
    if (listing.ok) {
      expect(listing.text).toContain('a.md');
      expect(listing.text).toContain('b.md');
    }
    const sub = await runTool(ctx, tc, 'hub_resource_read', { resourceId: dir.id, path: 'a.md' });
    expect(sub.ok).toBe(true);
    if (sub.ok) expect(sub.text).toContain('# 标题甲');
    const escape = await runTool(ctx, tc, 'hub_resource_read', { resourceId: dir.id, path: '../outside.txt' });
    expect(escape).toMatchObject({ ok: false });
    if (!escape.ok) expect(escape.error).toContain('逃出资料目录');
  });

  it('文件类型资料给 path 被拒绝；文件不存在给中文失败', async () => {
    const { ctx, tc } = toolFixture();
    await ctx.fs.writeTextAtomic('/hub/shared/a.txt', 'x');
    const file = saveResource(ctx, { name: '文件', kind: 'file', locator: '/hub/shared/a.txt' });
    const withPath = await runTool(ctx, tc, 'hub_resource_read', { resourceId: file.id, path: 'b.txt' });
    expect(withPath).toMatchObject({ ok: false });
    if (!withPath.ok) expect(withPath.error).toContain('只有目录');
    const missing = saveResource(ctx, { name: '丢了', kind: 'file', locator: '/hub/shared/missing.txt' });
    const result = await runTool(ctx, tc, 'hub_resource_read', { resourceId: missing.id });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('不存在或已移动');
  });

  it('链接走 NetIO：带超时与字节上限参数，200 回正文；500 失败并写 denied 审计', async () => {
    const { ctx, tc } = toolFixture();
    const url = 'https://example.test/feed';
    ctx.net.set(url, { status: 200, text: '<html>网页正文</html>', contentType: 'text/html' });
    const r = saveResource(ctx, { name: '网页', kind: 'url', locator: url });
    const okResult = await runTool(ctx, tc, 'hub_resource_read', { resourceId: r.id });
    expect(okResult).toMatchObject({ ok: true });
    if (okResult.ok) expect(okResult.text).toContain('网页正文');
    expect(ctx.net.calls[0]!.opts).toMatchObject({
      timeoutMs: V2_DEFAULTS.RESOURCE_NET_TIMEOUT_MS,
      maxBytes: V2_DEFAULTS.RESOURCE_READ_MAX_BYTES,
    });

    const badUrl = 'https://broken.test/x';
    ctx.net.set(badUrl, { status: 500, text: 'err', contentType: 'text/plain' });
    const bad = saveResource(ctx, { name: '坏页', kind: 'url', locator: badUrl });
    const failed = await runTool(ctx, tc, 'hub_resource_read', { resourceId: bad.id });
    expect(failed).toMatchObject({ ok: false });
    expect(readAudits(ctx).some(a => a.action === 'resource_read_denied')).toBe(true);
  });

  it('workData 优先：命中工作数据且未许可时，直授也读不了；许可后可读', async () => {
    const { ctx, tc, bot } = toolFixture();
    await ctx.fs.writeTextAtomic('/hub/shared/workdata/w.txt', '工作数据正文');
    const r = saveResource(ctx, {
      name: '工作资料', kind: 'file', locator: '/hub/shared/workdata/w.txt', sensitivity: 'restricted',
    });
    setGrant(ctx, { resourceId: r.id, subjectKind: 'bot', subjectId: bot.id, level: 'read' });
    ctx.settings.workDataPaths = ['/hub/shared/workdata'];
    // botFixture 默认 workDataAllowed=false。
    const denied = await runTool(ctx, tc, 'hub_resource_read', { resourceId: r.id });
    expect(denied).toMatchObject({ ok: false });
    if (!denied.ok) expect(denied.error).toContain('工作数据');

    ctx.store.table('bots').patch(bot.id, { workDataAllowed: true });
    const allowed = await runTool(ctx, tc, 'hub_resource_read', { resourceId: r.id });
    expect(allowed).toMatchObject({ ok: true });
    if (allowed.ok) expect(allowed.text).toContain('工作数据正文');
  });

  it('note 类型本期读取被拒，口径与服务层一致', async () => {
    const { ctx, tc, now } = toolFixture();
    const note: Resource = {
      id: 'res_0000000009', name: '笔记', kind: 'note', locator: 'note-1',
      sensitivity: 'normal', createdAt: now, updatedAt: now, archivedAt: null,
    };
    ctx.store.table('resources').put(note);
    const result = await runTool(ctx, tc, 'hub_resource_read', { resourceId: note.id });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('笔记资料后续版本支持');
  });

  it('resourceId 格式错误由 zod 给中文提示；反思回合只读工具仍可用', async () => {
    const { ctx, tc, wake } = toolFixture();
    const bad = await runTool(ctx, tc, 'hub_resource_read', { resourceId: 'not-an-id' });
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toContain('res_');

    await ctx.fs.writeTextAtomic('/hub/shared/a.txt', '反思也能查');
    const r = saveResource(ctx, { name: '资料', kind: 'file', locator: '/hub/shared/a.txt' });
    ctx.store.table('wakes').patch(wake.id, { variant: 'reflection' });
    const inReflection = await runTool(ctx, tc, 'hub_resource_read', { resourceId: r.id });
    expect(inReflection).toMatchObject({ ok: true });
  });
});
