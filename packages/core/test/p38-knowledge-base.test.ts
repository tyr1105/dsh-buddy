/**
 * P38 公共知识库测试：一个默认关闭、只读、远程可选的知识层。
 * 分五块：
 * 1. 配置 schema：默认关闭、https 同源、凭据引用形状、readOnly 锁死、字节上下限；
 * 2. 领域服务：未配置零请求零审计、无适配 unsupported、检索/读取成功与审计口径、
 *    读取截断、limit 收口、同源护栏、唤醒包段；
 * 3. 工具：未配置固定文案、参数校验、L0 可用、停岗只读口径；
 * 4. 唤醒包：常规与轻复查两档按配置出现/消失，构建过程不触发任何请求；
 * 5. 界面 API：testKnowledgeConnection 五态、自检不落设置。
 */
import { describe, expect, it } from 'vitest';
import {
  KnowledgeBaseConfigSchema, isKnowledgeConfigured, knowledgeHost, parseKnowledgeEndpoint,
  KNOWLEDGE_MAX_BYTES_MIN, KNOWLEDGE_MAX_BYTES_MAX, KNOWLEDGE_PACKET_MAX_BYTES,
  KNOWLEDGE_QUERY_MAX, KNOWLEDGE_ENTRY_ID_MAX, KNOWLEDGE_SEARCH_LIMIT_MAX,
  type KnowledgeBaseConfig,
} from '../src/model/knowledge-base.js';
import {
  KNOWLEDGE_UNCONFIGURED_TEXT, assertKnowledgeUrl, checkKnowledgeConnection,
  knowledgePacketSection, readKnowledge, searchKnowledge,
  type KnowledgeEntry, type KnowledgeHit, type KnowledgeTransport,
} from '../src/knowledge/index.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { runTool } from '../src/tools/index.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { createUiApi } from '../src/api/index.js';
import { initRoot } from '../src/memory/files.js';
import { okData } from './c04-api-fixtures.js';
import { toolFixture } from './c03-tool-fixtures.js';
import { turnContext } from './c03-turn-fixtures.js';
import { byteLength } from '../src/util/text.js';
import type { HubContext } from '../src/engine/context.js';

/** 一份可用的假配置：https 地址 + 假协议名；其余字段走各用例补丁。 */
function kbConfig(patch: Partial<KnowledgeBaseConfig> = {}): KnowledgeBaseConfig {
  return {
    enabled: true, endpoint: 'https://wiki.example.test', authRef: '',
    protocol: 'fake-wiki', scope: '', readOnly: true, maxBytes: 256 * 1024, ...patch,
  };
}

/** 把测试上下文切到「已配置知识库」状态，默认不开 scope。 */
function enableKnowledge(ctx: HubContext, patch: Partial<KnowledgeBaseConfig> = {}): void {
  ctx.settings.knowledgeBase = kbConfig(patch);
}

/** 假协议适配：记录每次调用并回送预设结果；core 自身不内置任何真实协议。 */
function makeTransport(opts: {
  check?: { status: 'ok' } | { status: 'failed'; reason: string };
  hits?: KnowledgeHit[]; truncated?: boolean; entry?: KnowledgeEntry;
} = {}) {
  const calls = { check: 0, search: [] as Array<{ query: string; limit: number }>, read: [] as string[] };
  const transport: KnowledgeTransport = {
    protocol: 'fake-wiki',
    async check() { calls.check += 1; return opts.check ?? { status: 'ok' }; },
    async search(_ctx, _config, query, o) {
      calls.search.push({ query, limit: o.limit });
      return { hits: opts.hits ?? [{ id: 'k1', title: '入职指南', location: '空间/人事', snippet: '摘要一' }], truncated: opts.truncated ?? false };
    },
    async read(_ctx, _config, id) {
      calls.read.push(id);
      return opts.entry ?? { id, title: '入职指南', location: '空间/人事', text: '正文内容', bytes: byteLength('正文内容') };
    },
  };
  return { transport, calls };
}

/** 给 toolFixture 这类自建上下文补挂协议适配（字段可选，直接赋值类型上需显式收口）。 */
function attachTransports(ctx: HubContext, transports: KnowledgeTransport[]): void {
  Object.assign(ctx, { knowledgeTransports: transports });
}

describe('P38 知识库配置 schema', () => {
  it('默认配置：关闭、全空、readOnly 字面量 true、上限 256KiB，且未达配置态', () => {
    const config = KnowledgeBaseConfigSchema.parse({
      enabled: false, endpoint: '', authRef: '', protocol: '', scope: '', readOnly: true, maxBytes: 256 * 1024,
    });
    expect(config.enabled).toBe(false);
    expect(isKnowledgeConfigured(config)).toBe(false);
    expect(knowledgeHost(config)).toBeNull();
  });

  it('endpoint 只收 https 且必须带主机：http、相对地址、乱码一律 null', () => {
    expect(parseKnowledgeEndpoint('https://wiki.example.test/x')?.hostname).toBe('wiki.example.test');
    expect(parseKnowledgeEndpoint('  https://wiki.example.test  ')?.hostname).toBe('wiki.example.test');
    expect(parseKnowledgeEndpoint('http://wiki.example.test')).toBeNull();
    expect(parseKnowledgeEndpoint('/relative/path')).toBeNull();
    expect(parseKnowledgeEndpoint('not a url')).toBeNull();
    expect(parseKnowledgeEndpoint('   ')).toBeNull();
  });

  it('启用且地址与协议齐备才通过；缺项逐项给中文错误', () => {
    expect(KnowledgeBaseConfigSchema.safeParse(kbConfig()).success).toBe(true);
    const noEndpoint = KnowledgeBaseConfigSchema.safeParse(kbConfig({ endpoint: '' }));
    expect(noEndpoint.success).toBe(false);
    expect(noEndpoint.error!.issues.some(i => i.path[0] === 'endpoint' && i.message.includes('连接地址'))).toBe(true);
    const noProtocol = KnowledgeBaseConfigSchema.safeParse(kbConfig({ protocol: '  ' }));
    expect(noProtocol.success).toBe(false);
    expect(noProtocol.error!.issues.some(i => i.path[0] === 'protocol' && i.message.includes('协议'))).toBe(true);
  });

  it('关着时填了非法 endpoint 照样报错，不存一份一开就炸的地址', () => {
    const result = KnowledgeBaseConfigSchema.safeParse(kbConfig({ enabled: false, endpoint: 'http://insecure.test' }));
    expect(result.success).toBe(false);
    expect(result.error!.issues.some(i => i.path[0] === 'endpoint')).toBe(true);
  });

  it('readOnly 锁死为 true；凭据引用拒绝空白等异常形状；协议名只收小写', () => {
    // readOnly:false 在类型层就不允许，这里刻意用展开字面量验证 schema 运行时同样拒绝。
    expect(KnowledgeBaseConfigSchema.safeParse({ ...kbConfig(), readOnly: false }).success).toBe(false);
    const badAuth = KnowledgeBaseConfigSchema.safeParse(kbConfig({ authRef: 'secret token 空格' }));
    expect(badAuth.success).toBe(false);
    expect(badAuth.error!.issues[0]!.message).toContain('凭据引用');
    expect(KnowledgeBaseConfigSchema.safeParse(kbConfig({ authRef: 'vault/wiki@prod:1' })).success).toBe(true);
    expect(KnowledgeBaseConfigSchema.safeParse(kbConfig({ protocol: 'FakeWiki' })).success).toBe(false);
    expect(KnowledgeBaseConfigSchema.safeParse(kbConfig({ protocol: 'generic-json_v2' })).success).toBe(true);
  });

  it('maxBytes 边界：1KiB 与 1MiB 合法，越界与小数拒绝；未知字段拒绝', () => {
    expect(KnowledgeBaseConfigSchema.safeParse(kbConfig({ maxBytes: KNOWLEDGE_MAX_BYTES_MIN })).success).toBe(true);
    expect(KnowledgeBaseConfigSchema.safeParse(kbConfig({ maxBytes: KNOWLEDGE_MAX_BYTES_MAX })).success).toBe(true);
    expect(KnowledgeBaseConfigSchema.safeParse(kbConfig({ maxBytes: KNOWLEDGE_MAX_BYTES_MIN - 1 })).success).toBe(false);
    expect(KnowledgeBaseConfigSchema.safeParse(kbConfig({ maxBytes: KNOWLEDGE_MAX_BYTES_MAX + 1 })).success).toBe(false);
    expect(KnowledgeBaseConfigSchema.safeParse(kbConfig({ maxBytes: 2048.5 })).success).toBe(false);
    expect(KnowledgeBaseConfigSchema.safeParse({ ...kbConfig(), bogus: 1 }).success).toBe(false);
  });

  it('配置态判定：开着但地址是 http 或协议为空都不算配置成功', () => {
    expect(isKnowledgeConfigured(kbConfig())).toBe(true);
    expect(isKnowledgeConfigured(kbConfig({ enabled: false }))).toBe(false);
    expect(isKnowledgeConfigured(kbConfig({ protocol: '' }))).toBe(false);
    expect(knowledgeHost(kbConfig())).toBe('wiki.example.test');
  });
});

describe('P38 领域服务', () => {
  it('未配置：检索与读取不调适配、不记审计，一律回 unconfigured', async () => {
    const { transport, calls } = makeTransport();
    const ctx = createTestContext({ knowledgeTransports: [transport] });
    const search = await searchKnowledge(ctx, 'b_0000000001', '查资料');
    const read = await readKnowledge(ctx, 'b_0000000001', 'k1');
    expect(search).toEqual({ status: 'unconfigured' });
    expect(read).toEqual({ status: 'unconfigured' });
    expect(calls.check).toBe(0);
    expect(calls.search).toHaveLength(0);
    expect(calls.read).toHaveLength(0);
    expect(ctx.store.log('audit').all().filter(a => a.action.startsWith('knowledge_'))).toHaveLength(0);
  });

  it('已配置但无协议适配：回 unsupported，不发请求、不记审计', async () => {
    const ctx = createTestContext();
    enableKnowledge(ctx, { protocol: 'ghost-proto' });
    const outcome = await searchKnowledge(ctx, 'b_0000000001', '查资料');
    expect(outcome.status).toBe('unsupported');
    if (outcome.status === 'unsupported') expect(outcome.protocol).toBe('ghost-proto');
    expect(ctx.store.log('audit').all()).toHaveLength(0);
  });

  it('检索成功：返回命中并记 knowledge_search 审计；审计只含主机/协议/条数/字节，无查询词', async () => {
    const { transport } = makeTransport();
    const ctx = createTestContext({ knowledgeTransports: [transport] });
    enableKnowledge(ctx);
    const outcome = await searchKnowledge(ctx, 'bot-甲', 'uniq-查询词-xyz');
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('应检索成功');
    expect(outcome.output.hits[0]!.id).toBe('k1');
    const expectedBytes = byteLength('k1\n入职指南\n空间/人事\n摘要一');
    expect(outcome.output.bytes).toBe(expectedBytes);
    const rows = ctx.store.log('audit').all().filter(a => a.action === 'knowledge_search');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe('bot-甲');
    const detail = JSON.parse(rows[0]!.detail) as Record<string, unknown>;
    expect(detail.host).toBe('wiki.example.test');
    expect(detail.protocol).toBe('fake-wiki');
    expect(detail.hits).toBe(1);
    expect(detail.bytes).toBe(expectedBytes);
    expect(rows[0]!.detail).not.toContain('uniq-查询词-xyz');
  });

  it('读取成功：正文返回给调用方，但审计只记元数据，不含正文与凭据', async () => {
    const { transport } = makeTransport({
      entry: { id: 'entry-1', title: '报销制度', location: '空间/财务', text: '正文机密-xyz', bytes: byteLength('正文机密-xyz') },
    });
    const ctx = createTestContext({ knowledgeTransports: [transport] });
    enableKnowledge(ctx, { authRef: 'vault/wiki-token' });
    const outcome = await readKnowledge(ctx, 'bot-乙', 'entry-1');
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('应读取成功');
    expect(outcome.entry.text).toContain('正文机密-xyz');
    expect(outcome.truncated).toBe(false);
    const row = ctx.store.log('audit').all().find(a => a.action === 'knowledge_read')!;
    expect(row.actor).toBe('bot-乙');
    expect(row.detail).toContain('entry-1');
    expect(row.detail).toContain('报销制度');
    expect(row.detail).not.toContain('正文机密-xyz');
    expect(row.detail).not.toContain('vault/wiki-token');
  });

  it('读取超 maxBytes：正文按字节截断并标 truncated，审计保留原始字节数', async () => {
    const longText = '字'.repeat(2000); // 6000 字节
    const { transport } = makeTransport({
      entry: { id: 'big', title: '长文', location: '空间', text: longText, bytes: byteLength(longText) },
    });
    const ctx = createTestContext({ knowledgeTransports: [transport] });
    enableKnowledge(ctx, { maxBytes: 2048 });
    const outcome = await readKnowledge(ctx, 'b1', 'big');
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('应读取成功');
    expect(outcome.truncated).toBe(true);
    expect(byteLength(outcome.entry.text)).toBeLessThanOrEqual(2048);
    const detail = JSON.parse(ctx.store.log('audit').all().find(a => a.action === 'knowledge_read')!.detail) as { bytes: number; truncated: boolean };
    expect(detail.bytes).toBe(6000);
    expect(detail.truncated).toBe(true);
  });

  it('检索 limit 收口：小于 1 归 1、超过上限裁到 20、小数截断', async () => {
    const { transport, calls } = makeTransport();
    const ctx = createTestContext({ knowledgeTransports: [transport] });
    enableKnowledge(ctx);
    await searchKnowledge(ctx, 'b1', 'q', 0);
    await searchKnowledge(ctx, 'b1', 'q', 999);
    await searchKnowledge(ctx, 'b1', 'q', 2.9);
    expect(calls.search.map(c => c.limit)).toEqual([1, KNOWLEDGE_SEARCH_LIMIT_MAX, 2]);
  });

  it('同源护栏：同主机放行，跨主机（含重定向目标）与 http 一律拒绝', () => {
    const config = kbConfig();
    expect(assertKnowledgeUrl(config, 'https://wiki.example.test/api/search').hostname).toBe('wiki.example.test');
    expect(() => assertKnowledgeUrl(config, 'https://other.example.test/x')).toThrow(/不一致/);
    expect(() => assertKnowledgeUrl(config, 'http://wiki.example.test/x')).toThrow(/https/);
    expect(() => assertKnowledgeUrl(kbConfig({ enabled: false, endpoint: '' }), 'https://wiki.example.test')).toThrow(/未配置/);
  });

  it('连接自检透传适配的 ok / failed', async () => {
    const ok = createTestContext({ knowledgeTransports: [makeTransport().transport] });
    enableKnowledge(ok);
    await expect(checkKnowledgeConnection(ok, kbConfig())).resolves.toEqual({ status: 'ok' });
    const failedCtx = createTestContext({ knowledgeTransports: [makeTransport({ check: { status: 'failed', reason: '401 鉴权失败' } }).transport] });
    enableKnowledge(failedCtx);
    await expect(checkKnowledgeConnection(failedCtx, kbConfig())).resolves.toEqual({ status: 'failed', reason: '401 鉴权失败' });
  });

  it('唤醒包段：未配置没有；配置后只含主机与用法（不含地址路径），且不超 1.5KB', () => {
    expect(knowledgePacketSection(kbConfig({ enabled: false }))).toBeNull();
    const section = knowledgePacketSection(kbConfig({ endpoint: 'https://wiki.example.test/secret-path', scope: '空间A' }))!;
    expect(section.key).toBe('knowledge');
    expect(section.title).toBe('## 公共知识库');
    expect(section.body).toContain('wiki.example.test');
    expect(section.body).toContain('空间A');
    expect(section.body).not.toContain('/secret-path');
    expect(byteLength(section.body)).toBeLessThanOrEqual(KNOWLEDGE_PACKET_MAX_BYTES);
    expect(knowledgePacketSection(kbConfig())!.body).toContain('库里全部');
  });
});

describe('P38 知识库工具', () => {
  it('未配置：检索与读取都回固定中文文案，不伪装成功或空结果', async () => {
    const { ctx, tc } = toolFixture();
    const search = await runTool(ctx, tc, 'hub_knowledge_search', { query: '查资料' });
    const read = await runTool(ctx, tc, 'hub_knowledge_read', { id: 'k1' });
    expect(search).toEqual({ ok: true, text: KNOWLEDGE_UNCONFIGURED_TEXT });
    expect(read).toEqual({ ok: true, text: KNOWLEDGE_UNCONFIGURED_TEXT });
  });

  it('无适配：中文失败并提示等主人更新连接方式', async () => {
    const { ctx, tc } = toolFixture();
    enableKnowledge(ctx, { protocol: 'ghost-proto' });
    const result = await runTool(ctx, tc, 'hub_knowledge_search', { query: '查资料' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('暂无适配');
  });

  it('检索成功输出条目行；零命中给专门文案；截断有提示', async () => {
    const setup1 = toolFixture();
    attachTransports(setup1.ctx, [makeTransport().transport]);
    enableKnowledge(setup1.ctx);
    const hit = await runTool(setup1.ctx, setup1.tc, 'hub_knowledge_search', { query: '入职' });
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.text).toContain('命中 1 条');
      expect(hit.text).toContain('[k1] 入职指南');
      expect(hit.text).toContain('空间/人事');
    }
    const setup2 = toolFixture();
    attachTransports(setup2.ctx, [makeTransport({ hits: [] }).transport]);
    enableKnowledge(setup2.ctx);
    const empty = await runTool(setup2.ctx, setup2.tc, 'hub_knowledge_search', { query: 'x' });
    if (empty.ok) expect(empty.text).toContain('没有检索到');
    const setup3 = toolFixture();
    attachTransports(setup3.ctx, [makeTransport({ truncated: true }).transport]);
    enableKnowledge(setup3.ctx);
    const cut = await runTool(setup3.ctx, setup3.tc, 'hub_knowledge_search', { query: 'x' });
    if (cut.ok) expect(cut.text).toContain('已截断');
  });

  it('读取成功带抬头与正文；截断时文末给原位置指引', async () => {
    const setup = toolFixture();
    attachTransports(setup.ctx, [makeTransport({
      entry: { id: 'k9', title: '制度', location: '空间/制度', text: '字'.repeat(2000), bytes: 6000 },
    }).transport]);
    enableKnowledge(setup.ctx, { maxBytes: 1024 });
    const result = await runTool(setup.ctx, setup.tc, 'hub_knowledge_read', { id: 'k9' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('[k9] 制度');
      expect(result.text).toContain('已截断');
      expect(result.text).toContain('空间/制度');
    }
  });

  it('参数校验：空查询、超长查询/ id、非法 limit、未知字段都被中文拦下', async () => {
    const { ctx, tc } = toolFixture();
    expect((await runTool(ctx, tc, 'hub_knowledge_search', { query: '   ' })).ok).toBe(false);
    const longQuery = { query: '字'.repeat(KNOWLEDGE_QUERY_MAX + 1) };
    const q = await runTool(ctx, tc, 'hub_knowledge_search', longQuery);
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error).toContain(String(KNOWLEDGE_QUERY_MAX));
    expect((await runTool(ctx, tc, 'hub_knowledge_search', { query: 'x', limit: 0 })).ok).toBe(false);
    expect((await runTool(ctx, tc, 'hub_knowledge_search', { query: 'x', limit: KNOWLEDGE_SEARCH_LIMIT_MAX + 1 })).ok).toBe(false);
    expect((await runTool(ctx, tc, 'hub_knowledge_search', { query: 'x', nope: 1 })).ok).toBe(false);
    const longId = await runTool(ctx, tc, 'hub_knowledge_read', { id: 'a'.repeat(KNOWLEDGE_ENTRY_ID_MAX + 1) });
    expect(longId.ok).toBe(false);
  });

  it('只读口径：L0 在队友与停岗队友都能检索（与产物读取同级，交账后也不拦）', async () => {
    const l0 = toolFixture();
    l0.ctx.store.table('bots').patch(l0.bot.id, { autonomy: 'L0' });
    const r1 = await runTool(l0.ctx, l0.tc, 'hub_knowledge_search', { query: 'x' });
    expect(r1.ok).toBe(true);
    const retired = toolFixture();
    retired.ctx.store.table('bots').patch(retired.bot.id, { lifecycle: 'retired' });
    const r2 = await runTool(retired.ctx, retired.tc, 'hub_knowledge_read', { id: 'k1' });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.text).toBe(KNOWLEDGE_UNCONFIGURED_TEXT);
  });
});

describe('P38 唤醒包集成', () => {
  it('未配置：常规包与轻复查包都不含知识库段', async () => {
    const regular = await turnContext('regular');
    const packet = await buildWakePacket(regular.ctx, regular.bot, regular.entry, regular.ticket);
    expect(packet).not.toContain('## 公共知识库');
    const light = await turnContext('light_check');
    const lightPacket = await buildWakePacket(light.ctx, light.bot, light.entry, light.ticket);
    expect(lightPacket).not.toContain('## 公共知识库');
  });

  it('已配置：两种包都出现入口段与主机名；构建包全程不调用适配（不发请求）', async () => {
    const { transport, calls } = makeTransport();
    const regular = await turnContext('regular');
    attachTransports(regular.ctx, [transport]);
    enableKnowledge(regular.ctx, { scope: '人事空间' });
    const packet = await buildWakePacket(regular.ctx, regular.bot, regular.entry, regular.ticket);
    expect(packet).toContain('## 公共知识库');
    expect(packet).toContain('wiki.example.test');
    expect(packet).toContain('人事空间');
    const light = await turnContext('light_check');
    attachTransports(light.ctx, [transport]);
    enableKnowledge(light.ctx);
    const lightPacket = await buildWakePacket(light.ctx, light.bot, light.entry, light.ticket);
    expect(lightPacket).toContain('## 公共知识库');
    expect(calls.check).toBe(0);
    expect(calls.search).toHaveLength(0);
    expect(calls.read).toHaveLength(0);
  });
});

describe('P38 设置页连接自检 API', () => {
  /** API 夹具需要自建上下文，才能注入假协议适配。 */
  async function apiWith(transport?: KnowledgeTransport) {
    const ctx = createTestContext(transport ? { knowledgeTransports: [transport] } : {});
    await initRoot(ctx);
    const api = createUiApi(ctx, async () => { await ctx.store.flush(); });
    return { ctx, api };
  }

  it('草稿形状不合法：state=invalid，错误逐项中文且带字段路径', async () => {
    const { api } = await apiWith();
    const result = await api.testKnowledgeConnection(kbConfig({ endpoint: 'http://x', protocol: '' }));
    expect(result.ok).toBe(true);
    const state = okData(result);
    expect(state.state).toBe('invalid');
    expect(state.errors.some(e => e.startsWith('endpoint：'))).toBe(true);
    expect(state.errors.some(e => e.startsWith('protocol：'))).toBe(true);
    expect(state.host).toBeNull();
  });

  it('关闭空配置：unconfigured；协议无适配：unsupported 并回显主机', async () => {
    const { api } = await apiWith();
    const off = okData(await api.testKnowledgeConnection(kbConfig({ enabled: false, endpoint: '', protocol: '' })));
    expect(off.state).toBe('unconfigured');
    const ghost = okData(await api.testKnowledgeConnection(kbConfig({ protocol: 'ghost' })));
    expect(ghost.state).toBe('unsupported');
    expect(ghost.host).toBe('wiki.example.test');
    expect(ghost.reason).toContain('暂无适配');
  });

  it('适配自检 ok / failed 如实回传', async () => {
    const okApi = await apiWith(makeTransport().transport);
    expect(okData(await okApi.api.testKnowledgeConnection(kbConfig())).state).toBe('ok');
    const failedApi = await apiWith(makeTransport({ check: { status: 'failed', reason: '连不上主机' } }).transport);
    const failed = okData(await failedApi.api.testKnowledgeConnection(kbConfig()));
    expect(failed.state).toBe('failed');
    expect(failed.reason).toBe('连不上主机');
  });

  it('自检只读：不落任何设置，也不留审计', async () => {
    const { ctx, api } = await apiWith(makeTransport().transport);
    const before = JSON.stringify(ctx.settings.knowledgeBase);
    await api.testKnowledgeConnection(kbConfig());
    expect(JSON.stringify(ctx.settings.knowledgeBase)).toBe(before);
    expect(ctx.store.log('audit').all().filter(a => a.action.startsWith('knowledge_'))).toHaveLength(0);
  });
});
