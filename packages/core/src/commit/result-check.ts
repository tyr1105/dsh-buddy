/**
 * F06 中心实查与主人验收：只检查本地交付文件的元信息，正确性仍交给主人。
 * 不执行交账里的命令，不联网，不读正文；所有文件操作都经注入接口。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Commit, Goal, ResultCheck, ArtifactCheck, ResultVerdict } from '../model/index.js';
import { ResultCheckSchema, ARTIFACT_CHECK_LABELS } from '../model/result-check.js';
import { isSensitive, within, workDataDenied } from '../gate/paths.js';
import { F06_DEFAULTS } from '../config/defaults.js';
import { parseInput } from '../engine/validation.js';
import { VERIFICATION_LEVEL_LABELS } from '../model/enums.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';

/** 只接受家中 work/ 与 shared/ 的文件；外部结果由主人亲自核实，不猜测成功。 */
export async function inspectArtifacts(ctx: HubContext, commit: Commit): Promise<ArtifactCheck[]> {
  const bot = ctx.store.table('bots').get(commit.botId);
  if (!bot) return [];
  const boundaries = { homeDir: bot.homeDir, rootDir: ctx.settings.rootDir,
    sharedDir: `${ctx.settings.rootDir}/shared`, workDataAllowed: bot.workDataAllowed,
    workDataPaths: ctx.settings.workDataPaths };
  const allowed = (path: string): boolean => !isSensitive(path) && !workDataDenied(path, boundaries)
    && [ `${bot.homeDir}/work`, boundaries.sharedDir ].some(root => within(path, root));
  const locations = [...new Set(commit.worldChanges.map(change => change.where.trim()))];
  const results: ArtifactCheck[] = [];
  for (const where of locations.slice(0, F06_DEFAULTS.ARTIFACT_MAX)) {
    const item: ArtifactCheck = { where, status: 'unchecked', detail: '只支持工作目录和共享目录内的本地文件；其余由主人核实', size: null };
    // URL、空位置与未知变量都不当作文件名，防止把自述当成可执行指令。
    if (!where || /^[a-z][a-z0-9+.-]*:/i.test(where) || /[$`*?\u0000]/.test(where)) { results.push(item); continue; }
    const path = posix.resolve(bot.homeDir, where);
    if (!allowed(path)) { results.push(item); continue; }
    try {
      const real = await ctx.fs.realpath(path);
      if (!allowed(real)) { results.push({ ...item, detail: '真实路径超出允许的实查范围' }); continue; }
      const stat = await ctx.fs.stat(real);
      if (!stat) results.push({ ...item, status: 'missing', detail: '在交付位置未找到文件' });
      else if (stat.isFile !== true) results.push({ ...item, status: 'invalid', detail: '交付位置不是可核实的普通文件' });
      else results.push({ ...item, status: stat.size > 0 ? 'present' : 'empty',
        detail: stat.size > 0 ? '仅确认存在与非空；内容及完成标准尚待主人验收' : '尚未交付文件内容', size: stat.size });
    } catch (error) {
      // realpath 的不存在也算缺失；其他异常不能冒充“没做”，更不能泄漏底层错误中的路径。
      const missing = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
      results.push({ ...item, status: missing ? 'missing' : 'unchecked',
        detail: missing ? '在交付位置未找到文件' : '文件元信息读取失败，需主人核实' });
    }
  }
  if (locations.length > F06_DEFAULTS.ARTIFACT_MAX)
    results.push({ where: '', status: 'unchecked', detail: '交付位置超出本轮实查上限，剩余部分需主人核实', size: null });
  return results;
}

/** 原始实查只写一次；同回合重入不能制造第二条验收记录。 */
export async function recordResultCheck(ctx: HubContext, commit: Commit, goals: Goal[]): Promise<ResultCheck> {
  const old = ctx.store.table('resultChecks').get(commit.id);
  if (old) return old;
  const record = parseInput(ResultCheckSchema, { id: commit.id, botId: commit.botId, wakeId: commit.wakeId,
    createdAt: commit.createdAt, goals: goals.map(goal => ({ id: goal.id, doneWhen: goal.doneWhen })),
    artifacts: await inspectArtifacts(ctx, commit), decisions: [] }, '中心结果校验');
  ctx.store.table('resultChecks').put(record);
  return record;
}

/** 验收卡同时呈现完成标准、自述验证和中心实查，避免“程序验证”被误认成独立验证。 */
export function resultCheckBody(goal: Goal, commit: Commit, check: ResultCheck | null): string {
  const observations = check?.artifacts.map(item => `${item.where || '未给出位置'}：${ARTIFACT_CHECK_LABELS[item.status]}`).join('\n');
  return `完成标准：${goal.doneWhen}\n交账：${commit.summary}\n执行者自述验证：${VERIFICATION_LEVEL_LABELS[commit.verification.level]}`
    + `；未覆盖：${commit.verification.notCovered || '未说明'}\n中心实查：${observations || '未提供可实查的交付位置，需主人核实'}`
    + '\n中心只查存在与非空；内容是否正确、是否符合要求由你验收。未通过时可注明：没做、做错、不是你要的。';
}

/** 自由文本不猜成通过；三类明确失败原样保留，过期也不冒充主人选择。 */
export function verdictOf(answer: string, expired: boolean): ResultVerdict {
  if (expired) return 'expired';
  if (['通过', '验收通过', '接受'].includes(answer)) return 'passed';
  return ({ '没做': 'not_done', '做错': 'incorrect', '不是你要的': 'mismatch' } as const)[answer as '没做'] ?? 'rejected';
}

/** 通过前再查一次，文件被删或变空时不能沿用旧实查；每个目标只追加一次决定。 */
export async function checkGoalAnswer(ctx: HubContext, goal: Goal, answer: string, expired: boolean, at: number): Promise<void> {
  const check = ctx.store.table('resultChecks').list(row => row.botId === goal.botId
    && row.goals.some(item => item.id === goal.id) && !row.decisions.some(item => item.goalId === goal.id))
    .reverse().sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!check) return; // 旧档没独立实查时继续走主人验收，不能编造历史检查。
  const verdict = verdictOf(answer, expired);
  let artifacts = check.artifacts;
  if (verdict === 'passed') {
    if (check.goals.find(item => item.id === goal.id)?.doneWhen !== goal.doneWhen)
      throw new Error('完成标准已变更，请按新标准重新交账验收');
    const commit = ctx.store.table('commits').get(check.id);
    if (!commit) throw new Error('原交账已不可读取，不能复查产物；请重新交账验收');
    artifacts = await inspectArtifacts(ctx, commit);
    if (artifacts.some(item => ['missing', 'empty', 'invalid'].includes(item.status)))
      throw new Error('产物不存在、为空或不是普通文件，请先补齐交付再验收通过');
  }
  ctx.store.table('resultChecks').patch(check.id, {
    decisions: [...check.decisions, { goalId: goal.id, verdict, answer, at, artifacts }],
  });
  ctx.emit(HUB_EVENT_SCOPES.ledger, goal.botId);
}
