/** 常用仿真大脑显式调用中心工具；交账失败会变成回合错误，避免测试把未执行当作成功。 */
import type { CommitInput } from '../commit/schema.js';
import { C03_DEFAULTS, DEFAULTS } from '../config/defaults.js';
import type { ToolResult } from '../tools/types.js';
import type { Brain, BrainInput, BrainResult } from './types.js';

/** 生成完整的无变化交账，调用方只覆盖剧本需要表达的业务差异。 */
export function simCommit(overrides: Partial<CommitInput> = {}): CommitInput {
  return { outcome: 'no_change', summary: '已经检查，暂时没有值得行动的新变化', worldChanges: [], evidence: [],
    verification: { level: 'program', notCovered: '仿真不执行真实外部动作' }, blocker: null,
    nextThink: { mode: 'auto', reason: '等待有意义的变化，保留最长间隔轻复查' }, ownerQuestion: null,
    reply: '已收到，已经检查。', report: null, importance: C03_DEFAULTS.reflectCommitImportance, proposals: [], ...overrides };
}

/** 所有预制大脑都检查工具结果；失败时让宿主发 error，而不是继续制造成功记录。 */
export function requireSimSuccess(result: ToolResult): string {
  if (!result.ok) throw new Error(result.error);
  return result.text;
}

/** 复盘必须用专属交账入口；普通剧本也能在中心强制复盘时安全结束。 */
export async function commitBrain(input: BrainInput, commit: Partial<CommitInput> = {}): Promise<BrainResult> {
  const value = simCommit(commit);
  if (input.variant === 'reflection') {
    requireSimSuccess(await input.call('hub_reflect_commit', { summary: value.summary, lessons: [], watchChanges: [], routineUpdates: [] }));
  } else requireSimSuccess(await input.call('hub_commit', value));
  return { finalText: value.summary };
}

/** 冻结世界时不主动预约重复检查，保持 no_change 加 auto 的节制行为。 */
export const quietBrain: Brain = input => commitBrain(input);

/** 只返回最终文本，让中心真实检测未交账及强制复盘。 */
export const noCommitBrain: Brain = async () => ({ finalText: '本回合结束但没有调用交账工具' });

/** 主人原话出现时明确回复；普通自动回合只交账不制造回复噪声。 */
export const replyBrain: Brain = input => commitBrain(input, {
  reply: input.packet.includes('主人对你说') ? '已收到你的消息，我会按这次要求处理。' : null,
});

/** 返回明确错误供额度、鉴权及普通重排路径分别验证。 */
export function errorBrain(text: string): Brain { return async () => ({ error: text }); }

export type ScriptStep = Partial<CommitInput> | Brain | {
  calls?: Array<{ tool: string; args: unknown; tokens?: number; allowFailure?: boolean }>;
  commit?: Partial<CommitInput> | false;
  result?: BrainResult;
};

/** 每次唤醒消费一步，剧本结束后重复最后一步；空剧本回到安静大脑。 */
export function scriptedBrain(steps: readonly ScriptStep[]): Brain {
  let cursor = 0;
  return async input => {
    const step = steps[Math.min(cursor++, steps.length - 1)];
    if (!step) return quietBrain(input);
    if (typeof step === 'function') return step(input);
    if ('calls' in step || 'commit' in step || 'result' in step) {
      for (const call of step.calls ?? []) {
        const result = await input.call(call.tool, call.args, call.tokens);
        if (!call.allowFailure) requireSimSuccess(result);
      }
      if (step.commit !== false && !step.result?.error && !step.result?.hang && !step.result?.awaitingApproval) {
        const result = await commitBrain(input, step.commit ?? {});
        return { ...result, ...step.result };
      }
      return step.result ?? {};
    }
    return commitBrain(input, step as Partial<CommitInput>);
  };
}

export interface WatchTunerOptions {
  watchId: string;
  intervalMinutes: number;
  proposal?: { kind: 'file' | 'log' | 'http' | 'rss' | 'script' | 'session'; target: string; why: string; intervalMinutes?: number };
}

/** 首次调慢已有关注并提出一个新范围，后续回合不重复制造同一提议。 */
export function watchTunerBrain(options: WatchTunerOptions): Brain {
  let tuned = false;
  return async input => {
    if (!tuned && input.variant !== 'reflection') {
      requireSimSuccess(await input.call('hub_watch_update', { id: options.watchId, intervalMinutes: options.intervalMinutes }));
      requireSimSuccess(await input.call('hub_watch_propose', options.proposal ?? {
        kind: 'session', target: '新的验证主题', why: '补充当前工作所缺的完成信号',
      }));
      tuned = true;
    }
    return commitBrain(input, { summary: '已根据近期变化调整注意范围' });
  };
}

export interface AgendaMakerOptions { title?: string; proposalTitle?: string }

/** 每个大脑实例只自发提出一次议程与改进建议，便于统计真正的自主发起。 */
export function agendaMakerBrain(options: AgendaMakerOptions = {}): Brain {
  let created = false;
  return async input => {
    let proposals: CommitInput['proposals'] = [];
    if (!created && input.variant !== 'reflection') {
      requireSimSuccess(await input.call('hub_agenda_upsert', { kind: 'task', title: options.title ?? '主动核对遗漏的证据',
        abandonWhen: '证据已经补齐或主人明确取消', priority: C03_DEFAULTS.handoffAgendaPriority }));
      proposals = [{ title: options.proposalTitle ?? '把证据核对过程整理成清单', detail: '先整理一次可复用的核对顺序，减少后续遗漏',
        value: DEFAULTS.PROPOSAL_MIN_VALUE, confidence: DEFAULTS.PROPOSAL_MIN_CONFIDENCE }];
      created = true;
    }
    return commitBrain(input, { outcome: 'progress', summary: '已记录自主发起的事项', proposals });
  };
}

export interface ApprovalSeekerOptions { tool?: string; args?: unknown; retryTwice?: boolean }

/** 首次请求需审批的命令，批准后以完全相同参数重试；可额外验证一次票不能重复使用。 */
export function approvalSeekerBrain(options: ApprovalSeekerOptions = {}): Brain {
  const tool = options.tool ?? 'exec_command';
  const args = structuredClone(options.args ?? { command: 'curl -X POST https://example.invalid/submit' });
  return async input => {
    if (input.variant === 'reflection') return quietBrain(input);
    const result = await input.call(tool, args);
    if (result.ok) {
      if (options.retryTwice) {
        const second = await input.call(tool, args);
        if (second.ok) throw new Error('同一张批准票不应该重复放行');
      }
      return commitBrain(input, { outcome: 'progress', summary: '主人批准的动作已执行一次' });
    }
    return commitBrain(input, { outcome: 'needs_owner', summary: '动作已转中心审批，等待主人决定',
      ownerQuestion: { text: '是否继续这项需要审批的动作？', options: ['继续', '暂缓'], defaultOption: '暂缓', whyNeeded: '动作会对外产生变化，需要主人确认' } });
  };
}
