/** 真实模型工具参数回归：逐个检查模型可见结构，并证明四类出站动作仍执行原有必填与审批边界。 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTools, runTool } from '../src/tools/index.js';
import { normalizeToolJsonSchema, toolJsonSchema } from '../src/tools/json-schema.js';
import { OutboxInputSchema, executeReadyOutbox } from '../src/gate/outbox.js';
import { decideApproval } from '../src/gate/approvals.js';
import { toolFixture } from './c03-tool-fixtures.js';

const tools = buildTools(toolFixture().ctx);
/** 遍历全部 Schema 子树，防止只清理根节点而把引用或 propertyNames 留在 payload 中。 */
function assertPortableTree(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertPortableTree(item);
  } else if (value !== null && typeof value === 'object') {
    for (const key of ['$schema', '$ref', '$defs', 'propertyNames']) expect(value).not.toHaveProperty(key);
    for (const item of Object.values(value)) assertPortableTree(item);
  }
}

describe('M06 所有 hub 工具的模型参数格式', () => {
  it.each(tools)('$name 根为显式对象且所有层都无引用与不兼容元数据', tool => {
    expect(tool.jsonSchema).toMatchObject({ type: 'object', properties: expect.any(Object) });
    for (const key of ['oneOf', 'anyOf', 'allOf', 'not', 'if']) expect(tool.jsonSchema).not.toHaveProperty(key);
    assertPortableTree(tool.jsonSchema);
  });

  it('outbox 列出四种 kind、全部 payload 字段和按 kind 使用的中文说明', () => {
    const schema = tools.find(tool => tool.name === 'hub_outbox_submit')!.jsonSchema;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(schema.required).toEqual(expect.arrayContaining(['kind', 'why', 'payload']));
    expect(properties.kind).toMatchObject({ type: 'string', enum: ['notify_owner', 'write_file', 'http_post', 'run_command'] });
    expect(properties.payload).toMatchObject({ type: 'object', additionalProperties: false });
    const fields = properties.payload!.properties as Record<string, Record<string, unknown>>;
    const kinds = { text: 'notify_owner', importance: 'notify_owner', path: 'write_file', content: 'write_file',
      url: 'http_post', body: 'http_post', headers: 'http_post', cmd: 'run_command', args: 'run_command', cwd: 'run_command' };
    expect(Object.keys(fields).sort()).toEqual(Object.keys(kinds).sort());
    for (const [field, kind] of Object.entries(kinds)) expect(fields[field]?.description).toContain(`仅 kind=${kind} 时需要`);
    expect(fields.headers).toMatchObject({ type: 'object', additionalProperties: { type: 'string' } });
  });

  it('重复类型内联，普通可空类型与可空枚举保持限制', () => {
    const shared = z.strictObject({ title: z.string().min(2) });
    const schema = toolJsonSchema(z.strictObject({ first: shared, second: shared,
      note: z.string().min(2).nullable(), state: z.enum(['ready', 'done']).nullable() }));
    assertPortableTree(schema);
    expect(schema.properties).toMatchObject({ first: { type: 'object' }, second: { type: 'object' },
      note: { type: ['string', 'null'], minLength: 2 }, state: { type: ['string', 'null'], enum: ['ready', 'done', null] } });
  });

  it('本地引用展开后仍保留字段约束和兄弟说明，不修改原文档', () => {
    const schema = { type: 'object', properties: { payload: { $ref: '#/$defs/entry', description: '参数说明' } },
      $defs: { entry: { type: 'object', properties: { value: { type: 'string', minLength: 2 } }, required: ['value'], additionalProperties: false } } };
    const result = normalizeToolJsonSchema(schema);
    assertPortableTree(result);
    expect(result.properties).toEqual({ payload: { ...schema.$defs.entry, description: '参数说明' } });
    expect(schema.properties.payload).toHaveProperty('$ref');
    expect(schema).toHaveProperty('$defs');
  });

  it('可空联合外还有约束时保留 anyOf，不能覆盖分支的更严格约束', () => {
    const field = { anyOf: [{ type: 'string', minLength: 5 }, { type: 'null' }], minLength: 2 };
    const result = normalizeToolJsonSchema({ type: 'object', properties: { value: field } });
    expect(result.properties).toEqual({ value: field });
    expect(field.anyOf[0]).toMatchObject({ minLength: 5 });
  });

  it.each([
    { not: { type: 'null' } },
    { allOf: [{ type: 'string' }] },
    { anyOf: [{ type: 'string', minLength: 5 }] },
    { oneOf: [{ type: 'string' }] },
    { if: { type: 'null' }, then: false },
    { const: '固定值' },
    { customConstraint: true },
  ])('分支有可能影响 null 的约束时保留 anyOf %#', constraint => {
    const field = { anyOf: [{ type: 'string', ...constraint }, { type: 'null' }] };
    expect(normalizeToolJsonSchema({ type: 'object', properties: { value: field } }).properties).toEqual({ value: field });
  });

  it('可空联合外只有说明时可简化，同时保留分支约束和外层说明', () => {
    const field = { anyOf: [{ type: 'string', minLength: 5 }, { type: 'null' }], description: '可省略的说明' };
    expect(normalizeToolJsonSchema({ type: 'object', properties: { value: field } }).properties)
      .toEqual({ value: { type: ['string', 'null'], minLength: 5, description: '可省略的说明' } });
  });

  it.each(['oneOf', 'anyOf', 'allOf', 'not', 'if'])('根级 %s 被明确拒绝，不通过删除约束伪装成对象', keyword => {
    expect(() => normalizeToolJsonSchema({ type: 'object', properties: {}, [keyword]: [] })).toThrow('根节点');
  });

  it.each([
    { type: 'string' },
    { type: 'object' },
    { type: 'object', properties: { value: { $ref: 'https://example.test/schema' } } },
    { type: 'object', properties: { value: { $ref: '#/$defs/missing' } } },
    { type: 'object', properties: { value: { $ref: '#/$defs/loop' } }, $defs: { loop: { $ref: '#/$defs/loop' } } },
    { type: 'object', properties: { value: { $ref: '#/$defs/value', minLength: 1 } }, $defs: { value: { type: 'string', minLength: 2 } } },
  ])('无法安全导出的结构拒绝注册 %#', schema => {
    expect(() => normalizeToolJsonSchema(schema)).toThrow(/工具 Schema/);
  });
});

const outboxCases = [
  { kind: 'notify_owner', payload: { text: '检查已经完成', importance: 2 }, required: ['text'] },
  { kind: 'write_file', payload: { path: '/owner/report.txt', content: '' }, required: ['path', 'content'] },
  { kind: 'http_post', payload: { url: 'https://example.test/report', body: '', headers: { 'Content-Type': 'text/plain' } }, required: ['url', 'body'] },
  { kind: 'run_command', payload: { cmd: 'external-cli', args: ['a b'], cwd: '/owner' }, required: ['cmd', 'args', 'cwd'] },
] as const;

describe('M06 出站扁平参数仍按 kind 校验与执行', () => {
  it.each(outboxCases)('$kind 有效字段通过工具，审批后完整执行 payload', async ({ kind, payload }) => {
    const { ctx, tc, bot } = toolFixture();
    ctx.net.set('https://example.test/report', { status: 200, text: '已收到', contentType: 'text/plain' });
    ctx.exec.set('external-cli', ['a b'], { code: 0, stdout: '执行完成', stderr: '', timedOut: false });
    const input = { kind, payload, why: '检查结果需要交付' };
    expect(OutboxInputSchema.safeParse(input).success).toBe(true);
    expect(await runTool(ctx, tc, 'hub_outbox_submit', input)).toMatchObject({ ok: true });
    const row = ctx.store.table('outbox').list()[0]!;
    expect(row.payload).toEqual(payload);
    if (kind === 'notify_owner') {
      expect(row.status).toBe('done');
      expect(ctx.store.log('thread').all().filter(message => message.thread === bot.id && message.kind === 'report')).toEqual([
        expect.objectContaining({ text: '检查已经完成' }),
      ]);
      expect(ctx.store.table('approvals').count()).toBe(0);
    } else {
      expect(row.status).toBe('pending_approval');
      expect(row.approvalId).not.toBeNull();
      await decideApproval(ctx, row.approvalId!, true);
      await executeReadyOutbox(ctx);
      expect(ctx.store.table('outbox').get(row.id)?.status).toBe('done');
      if (kind === 'write_file') expect(await ctx.fs.readText(payload.path)).toBe('');
      if (kind === 'http_post') expect(ctx.net.calls).toEqual(expect.arrayContaining([expect.objectContaining({ url: payload.url, body: '' })]));
      if (kind === 'run_command') expect(ctx.exec.calls[0]).toMatchObject({ cmd: payload.cmd, args: ['a b'], opts: { cwd: '/owner' } });
    }
  });

  for (const { kind, payload, required } of outboxCases) {
    for (const field of required) {
      it(`${kind} 缺 payload.${field} 时返回中文字段错误且无副作用`, async () => {
        const { ctx, tc } = toolFixture();
        const incomplete: Record<string, unknown> = { ...payload };
        delete incomplete[field];
        const result = await runTool(ctx, tc, 'hub_outbox_submit', { kind, payload: incomplete, why: '检查结果需要交付' });
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`缺少 payload.${field}`) });
        if (!result.ok) expect(result.error).toContain(`kind=${kind}`);
        expect(ctx.store.table('outbox').count()).toBe(0);
        expect(ctx.store.table('approvals').count()).toBe(0);
      });
    }
  }

  it.each(outboxCases)('$kind 不接受其他动作的字段', async ({ kind, payload }) => {
    const { ctx, tc } = toolFixture();
    const foreign = kind === 'notify_owner' ? { cmd: 'pwd' } : { text: '不属于此动作' };
    const result = await runTool(ctx, tc, 'hub_outbox_submit', { kind, payload: { ...payload, ...foreign }, why: '测试' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('不支持字段') });
    expect(ctx.store.table('outbox').count()).toBe(0);
  });

  it('空参数与缺少 payload 保留明确中文字段说明', async () => {
    const { ctx, tc } = toolFixture();
    expect(await runTool(ctx, tc, 'hub_outbox_submit', {})).toMatchObject({ ok: false, error: expect.stringContaining('kind') });
    const result = await runTool(ctx, tc, 'hub_outbox_submit', { kind: 'write_file', why: '测试' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('payload') });
    if (!result.ok) expect(result.error).toMatch(/[\u4e00-\u9fff]/);
  });

  it.each([null, '', ' \n\t ', 'null', ' null \n'])('notify_owner 空汇报 %j 不生成出站、线程或推送', async value => {
    const { ctx, tc } = toolFixture();
    const result = await runTool(ctx, tc, 'hub_outbox_submit', { kind: 'notify_owner', payload: { text: value, importance: 10 }, why: '主动汇报' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('payload.text') });
    if (!result.ok) expect(result.error).toMatch(/[\u4e00-\u9fff]/);
    expect(ctx.store.table('outbox').count()).toBe(0);
    expect(ctx.store.log('thread').all()).toEqual([]);
    expect(ctx.host.calls.filter(call => call.method === 'notify')).toEqual([]);
  });

  it('notify_owner 保留正常正文中的 null 和原有排版', async () => {
    const { ctx, tc } = toolFixture();
    const body = '  已确认接口返回 null，正在核对原因。\n';
    expect(await runTool(ctx, tc, 'hub_outbox_submit', { kind: 'notify_owner', payload: { text: body }, why: '报告检查结果' })).toMatchObject({ ok: true });
    expect(ctx.store.log('thread').all()).toEqual([expect.objectContaining({ kind: 'report', text: body })]);
    expect(ctx.store.table('outbox').list()).toEqual([expect.objectContaining({ status: 'done', payload: { text: body } })]);
  });
});
