/**
 * F08 尾巴 - 办公室桌面的项目产物投影测试。
 *
 * 为什么单独测：桌面是主人判断「这个队友最近交付了什么」的第一眼，
 * 口径必须是「产物 > 账本自述 > 如实空着」；如果这里把别人的产物、
 * 自己看不了的产物或旧版本摆上桌，主人点进去就会看到错的或打不开的东西。
 * 同时检查服务层不把产物正文复制进办公室投影（性能与隐私边界）。
 */
import { describe, expect, it } from 'vitest';
import type { Bot, WakeLedgerEntry } from '../src/model/index.js';
import { ArtifactVersionSchema } from '../src/model/artifact.js';
import {
  officeView, projectOffice, type OfficeArtifactInput, type ProjectOfficeInput,
} from '../src/office/index.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';

const NOW = 1_793_808_000_000;
const SHA = 'a'.repeat(64);

/** 队友工厂：默认在岗；partial 可改 activity 或 lifecycle。 */
function bot(id: string, name: string, partial: Partial<Bot> = {}): Bot {
  return { ...botFixture, id, name, homeDir: `/hub/bots/${id}`, ...partial };
}

/** 产物版本摘要工厂：投影只关心这几个字段，正文与路径一律不参与。 */
function art(input: {
  artifactId: string;
  botId: string;
  number?: number;
  title?: string;
  createdAt?: number;
}): OfficeArtifactInput {
  const number = input.number ?? 1;
  return {
    id: `av_${input.artifactId}_${number}`,
    artifactId: input.artifactId,
    botId: input.botId,
    number,
    title: input.title ?? `产物 ${input.artifactId} v${number}`,
    createdAt: input.createdAt ?? NOW,
  };
}

/** 账本工厂：只填投影会读到的字段（封存时间、交账摘要）。 */
function ledger(wakeId: string, botId: string, summary: string): WakeLedgerEntry {
  return {
    id: `wl_${wakeId}`, wakeId, botId, sessionId: null, variant: 'regular', status: 'committed',
    source: 'live', completeness: 'full', missing: [], openedAt: NOW - 120_000, sealedAt: NOW - 60_000,
    trigger: {
      kind: 'percept', score: 0.8, threshold: 0.6, summary: '资料有变化', ownerSummary: null,
      ownerInitiated: false, subjectKey: null, queueWaitMs: null, evidenceRefs: [],
    },
    evidence: { items: [] },
    decision: {
      outcome: 'progress', summary, blocker: null, nextThink: null, ownerQuestion: null,
      report: null, importance: null,
    },
    actions: { items: [] },
    result: { verification: null, worldChanges: [], refs: [], summary: null },
    steps: 1, tokens: 100, truncated: false, bytes: 10,
  };
}

/** 默认空输入：每条用例只写自己关心的字段。 */
function office(partial: Partial<ProjectOfficeInput> = {}): ProjectOfficeInput {
  return {
    now: NOW, bots: [], ledgers: [], artifacts: [], inboxItems: [],
    quotaLight: 'green', openAlerts: 0, sandboxOk: true, truncated: false, ...partial,
  };
}

describe('办公室桌面：产物优先（纯投影）', () => {
  it('正例：有产物时桌面显示产物，ref 指向产物头 id', () => {
    const view = projectOffice(office({
      bots: [bot('b_1', '小研')],
      artifacts: [art({ artifactId: 'art_1', botId: 'b_1' })],
    }));
    expect(view.seats[0]!.desk).toEqual({
      kind: 'artifact', kindLabel: '产物', title: '产物 art_1 v1',
      ref: 'artifact:art_1', refKind: 'artifact', refId: 'art_1',
    });
  });

  it('没有产物时回退到最近一条有产出的账本', () => {
    const view = projectOffice(office({
      bots: [bot('b_1', '小研')],
      ledgers: [ledger('w_1', 'b_1', '交付了调研结论')],
    }));
    expect(view.seats[0]!.desk.kind).toBe('wake_output');
    expect(view.seats[0]!.desk.ref).toBe('wake:w_1');
    expect(view.seats[0]!.desk.title).toBe('交付了调研结论');
  });

  it('同一队友多版产物只上最新：先比创建时间，再比版本号', () => {
    const newer = projectOffice(office({
      bots: [bot('b_1', '小研')],
      artifacts: [
        art({ artifactId: 'art_old', botId: 'b_1', createdAt: NOW - 1_000 }),
        art({ artifactId: 'art_new', botId: 'b_1', createdAt: NOW }),
      ],
    }));
    expect(newer.seats[0]!.desk.refId).toBe('art_new');
    const higher = projectOffice(office({
      bots: [bot('b_1', '小研')],
      artifacts: [
        art({ artifactId: 'art_a', botId: 'b_1', number: 1 }),
        art({ artifactId: 'art_a', botId: 'b_1', number: 2 }),
      ],
    }));
    expect(higher.seats[0]!.desk.title).toBe('产物 art_a v2');
  });

  it('产物标题只有空白时不算产出，如实回退到账本', () => {
    const view = projectOffice(office({
      bots: [bot('b_1', '小研')],
      artifacts: [art({ artifactId: 'art_1', botId: 'b_1', title: '   ' })],
      ledgers: [ledger('w_1', 'b_1', '交付了调研结论')],
    }));
    expect(view.seats[0]!.desk.kind).toBe('wake_output');
    expect(view.seats[0]!.desk.title).toBe('交付了调研结论');
  });

  it('反例：没坐在席位上的队友，其产物不会出现在别人的桌上', () => {
    const view = projectOffice(office({
      bots: [bot('b_1', '小研')],
      artifacts: [art({ artifactId: 'art_2', botId: 'b_2' })],
    }));
    expect(view.seats[0]!.desk.kind).toBe('none');
    expect(view.seats[0]!.desk.title).toBeNull();
  });

  it('ref 完整性：产物桌面的 ref 前缀与 refId 一致，不拼出空引用', () => {
    const view = projectOffice(office({
      bots: [bot('b_1', '小研')],
      artifacts: [art({ artifactId: 'art_1', botId: 'b_1' })],
    }));
    for (const seat of view.seats) {
      expect(seat.desk.ref.startsWith(`${seat.desk.refKind}:`)).toBe(true);
      expect(seat.desk.refId.length).toBeGreaterThan(0);
    }
  });
});

describe('办公室服务：桌面产物读取边界', () => {
  /** 建一个干净的中心；投影只读表，不需要初始化根目录。 */
  function newContext() {
    return createTestContext();
  }
  /** 测试环境类型：经非泛型包装推导，避免 ReturnType 把必填字段可选化。 */
  type TestCtx = ReturnType<typeof newContext>;

  /** 往产物表放一版；head 表不参与投影，不必写。 */
  function putVersion(
    ctx: TestCtx,
    input: {
      id: string; artifactId: string; botId: string; number: number; title: string;
      createdAt: number; visibility?: 'only_me' | 'owner' | 'others'; content?: string;
    },
  ): void {
    const content = input.content ?? '正文秘密';
    ctx.store.table('artifactVersions').put(ArtifactVersionSchema.parse({
      id: input.id, artifactId: input.artifactId, botId: input.botId, number: input.number,
      title: input.title, sourcePath: `/hub/bots/${input.botId}/work/a.md`,
      realPath: `/hub/bots/${input.botId}/work/a.md`, visibility: input.visibility ?? 'owner',
      content, bytes: content.length, sha256: SHA, commitId: 'c_1', wakeId: 'w_1',
      goalIds: [], createdAt: input.createdAt,
    }));
  }

  it('服务层把主人可读的产物放上桌，且不复制正文', () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    ctx.store.table('bots').put(bot('b_1', '小研'));
    putVersion(ctx, {
      id: 'av_1', artifactId: 'art_1', botId: 'b_1', number: 1, title: '第 45 周周报',
      createdAt: now - 60_000,
    });
    const view = officeView(ctx);
    expect(view.seats[0]!.desk).toMatchObject({ kind: 'artifact', refId: 'art_1', title: '第 45 周周报' });
    expect(JSON.stringify(view)).not.toContain('正文秘密');
  });

  it('只有队友自己可看的版本不上桌：主人点开也读不到，放上桌就是坏链接', () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    ctx.store.table('bots').put(bot('b_1', '小研'));
    putVersion(ctx, {
      id: 'av_1', artifactId: 'art_1', botId: 'b_1', number: 1, title: '私人笔记',
      createdAt: now - 60_000, visibility: 'only_me',
    });
    expect(officeView(ctx).seats[0]!.desk.kind).toBe('none');
  });

  it('保留期外的版本不上桌，保留期内的照常显示', () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const retention = ctx.settings.retentionMsByCollection.artifactVersions;
    ctx.store.table('bots').put(bot('b_1', '小研'));
    putVersion(ctx, {
      id: 'av_old', artifactId: 'art_old', botId: 'b_1', number: 1, title: '过期产物',
      createdAt: now - retention - 1,
    });
    expect(officeView(ctx).seats[0]!.desk.kind).toBe('none');
    putVersion(ctx, {
      id: 'av_new', artifactId: 'art_new', botId: 'b_1', number: 1, title: '保留期内产物',
      createdAt: now - retention + 1,
    });
    expect(officeView(ctx).seats[0]!.desk.refId).toBe('art_new');
  });
});
