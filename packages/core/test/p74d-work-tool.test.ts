/**
 * P74d 的测试：工具 hub_job_work 的提问、交回、说明做不下去，以及谁能调用什么。
 * 全部走真实 Hub（真实的启动整理和显著性数值），时间用注入的假时钟，文件放在内存文件系统里；
 * 不用人为调高分值的候选。核对（review）的测试在 p74d-review.test.ts，证据检查在 p74d-evidence.test.ts，卡片视图在 p74d-cards.test.ts。
 *
 * 其中四条是「只用唤醒包里给出的文字就能调用成功」：从唤醒包文本里用正则取出编号、条目序号、路径，再去调用工具，必须成功。
 */
import { describe, expect, it } from 'vitest';
import { AgreementSchema } from '../src/model/agreement.js';
import { JobSchema } from '../src/model/job.js';
import { HubJobWorkInputSchema } from '../src/tools/hub-job-work.js';
import {
  INTERNAL, bot, callTool, engineerSubmits, entriesOf, eventsOf, executorInfo, firstSubmitArgs, nextPacket,
  putFile, reviewerInfo, runningOf, sectionOf, started, theJob, threadOf, writeSnapshot, metWithImage,
} from './p74d-fixtures.js';
import { commitAndEnd, wakesOf } from './p74c-fixtures.js';

/** 林舟交回之后结束他的回合，让评审甲拿到核对的回合；返回评审甲的唤醒包。 */
async function reviewerGetsTurn(fix: Awaited<ReturnType<typeof started>>['fix']): Promise<string> {
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  return nextPacket(fix, fix.reviewer.id);
}

describe('只用唤醒包里的文字调用成功', () => {
  it('1 执行者只凭「你手上的事」段交回成功：状态核对中，评审员入队并被叫醒（他 10 分钟前刚思考过）', async () => {
    const { fix, job, info } = await started();
    expect(info.jobId).toBe(job.id);
    expect(info.items.map(item => item.no)).toEqual([1, 2, 3]);
    expect(info.items.map(item => item.atDelivery)).toEqual([true, false, false]);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info));
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已交回第 1 轮，评审甲会逐条核对。' });
    expect(theJob(fix)).toMatchObject({ state: 'checking', round: 1, unmet: [] });
    // 交回记录：条目原文由中心抄写，证据编号接连递增，机械检查结果已写入。
    const submission = fix.ctx.store.table('jobSubmissions').list()[0]!;
    expect(submission).toMatchObject({ jobId: job.id, round: 1, stage: 1, versionNo: 1, executorId: fix.engineer.id });
    expect(submission.items.map(item => [item.no, item.selfCheck])).toEqual([[1, 'at_delivery'], [2, 'met'], [3, 'met']]);
    expect(submission.items.flatMap(item => item.evidence.map(evidence => evidence.id))).toEqual(['ev1', 'ev2', 'ev3']);
    expect(submission.items[1]!.evidence[0]!.check).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^图片，/) });
    expect(submission.items[2]!.evidence.map(evidence => evidence.check.status)).toEqual(['ok', 'unchecked']);
    // 评审甲已入队、事件已记；往来里有交回卡和一句中心提示。
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(1);
    expect(eventsOf(fix.ctx, job.id).filter(event => event.kind === 'submitted')).toMatchObject([{ actor: fix.engineer.id, to: [fix.reviewer.id], refId: submission.id }]);
    const topic = threadOf(fix.ctx, job.topicId);
    expect(topic.filter(row => row.kind === 'job_card')).toMatchObject([{ from: fix.engineer.id, refId: `submission:${submission.id}`, text: '会员定价页　第 1 轮' }]);
    expect(topic.at(-1)).toMatchObject({ from: 'hub', kind: 'work', text: '林舟交回第 1 轮，2 条附证据，1 条交付时核对；评审甲正在核对。' });
    // 评审甲真的被叫醒：拿到回合，唤醒包里有这次交回的证据。
    const packet = await reviewerGetsTurn(fix);
    expect(runningOf(fix, fix.reviewer.id)).toBeDefined();
    expect(wakesOf(fix, fix.reviewer.id, job.id)).toHaveLength(1);
    expect(sectionOf(packet)).toContain('林舟的交回（搭好了价格页，三档价格和刷新按钮都有）：');
    expect(sectionOf(packet)).toContain('证据 ev1：图片');
  });

  it('2 核对人只凭自己那一段的文字提交核对结论成功：第 3 条不符，状态返工中，林舟被叫醒，他的唤醒包写明要改第 3 条', async () => {
    const { fix, job, info } = await started();
    await engineerSubmits(fix, info);
    const packet = await reviewerGetsTurn(fix);
    const seen = reviewerInfo(packet);
    expect(seen).toEqual({ jobId: job.id, nos: [1, 2, 3] });
    const result = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', {
      mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '截图无横向滚动', rechecked: true },
        { no: 3, verdict: 'unmet', note: '接口失败时没有任何提示', fixTo: '断开接口后页面显示「加载失败」' }],
    });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已退回林舟，只改第 3 条。' });
    expect(theJob(fix)).toMatchObject({ state: 'rework', round: 1, unmet: [{ no: 3, problem: '接口失败时没有任何提示', fixTo: '断开接口后页面显示「加载失败」' }] });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '第 3 条不符' });
    const engineerPacket = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(engineerPacket)).toContain('这一轮要改的条目：第 3 条：问题：接口失败时没有任何提示；改到什么程度算过：断开接口后页面显示「加载失败」。');
  });

  it('3 林舟返工只交第 3 条成功（其余沿用，说明和证据原样带过来）；评审甲只写第 3 条、抽查第 2 条，状态待你验收，不叫醒总管', async () => {
    const { fix, job, info } = await started();
    await engineerSubmits(fix, info);
    const first = fix.ctx.store.table('jobSubmissions').list()[0]!;
    const firstSnapshot = JSON.parse(JSON.stringify(first));
    const reviewerPacket = await reviewerGetsTurn(fix);
    await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', {
      mode: 'review', jobId: reviewerInfo(reviewerPacket).jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'unmet', note: '没有提示', fixTo: '失败时页面显示「加载失败」' }],
    });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '退回' });
    const again = executorInfo(await nextPacket(fix, fix.engineer.id));
    expect(again.jobId).toBe(job.id);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: again.jobId, changeNote: '补上了失败提示', deliverables: ['交付/报价页.html'],
      items: [{ no: 3, selfCheck: 'met', evidence: [{ kind: 'image', path: '证据/桌面.png', summary: '断开接口后的页面' }] }],
    });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已交回第 2 轮，评审甲会逐条核对。' });
    expect(theJob(fix)).toMatchObject({ state: 'checking', round: 2, unmet: [] });
    const submissions = fix.ctx.store.table('jobSubmissions').list();
    const second = submissions[1]!;
    // 其余条目逐项不变：原文、说明、证据（含编号和检查结果）与第一次交回完全一致，只有自查结论改为沿用；新证据接在旧编号之后。
    expect(second.items.map(item => [item.no, item.selfCheck])).toEqual([[1, 'carried'], [2, 'carried'], [3, 'met']]);
    for (const no of [1, 2]) {
      const before = firstSnapshot.items.find((item: { no: number }) => item.no === no);
      const after = second.items.find(item => item.no === no)!;
      expect({ text: after.text, note: after.note, evidence: after.evidence }).toEqual({ text: before.text, note: before.note, evidence: before.evidence });
    }
    expect(second.items[2]!.evidence.map(evidence => evidence.id)).toEqual(['ev4']);
    // 第一次交回的记录本身没有被改动。
    expect(JSON.parse(JSON.stringify(submissions[0]))).toEqual(firstSnapshot);
    expect(threadOf(fix.ctx, job.topicId).at(-1)).toMatchObject({ kind: 'work', text: '林舟交回第 2 轮，1 条附证据，2 条沿用上一轮；评审甲正在核对。' });
    // 评审甲第二次核对：只写第 3 条，抽查第 2 条。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const secondPacket = await nextPacket(fix, fix.reviewer.id);
    expect(sectionOf(secondPacket)).toContain('自查：沿用第 1 轮结论：符合');
    const reviewed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', {
      mode: 'review', jobId: reviewerInfo(secondPacket).jobId, items: [{ no: 3, verdict: 'met', note: '断开接口后看到了「加载失败」' }],
      spotChecked: [2], carriedNote: '本轮只改了失败提示，不影响其余条目',
    });
    expect(reviewed, JSON.stringify(reviewed)).toEqual({ ok: true, text: '核对通过，中心会交给主人验收。' });
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner', round: 2 });
    const reviews = fix.ctx.store.table('jobReviews').list();
    expect(reviews[1]).toMatchObject({ round: 2, spotChecked: [2], carriedNote: '本轮只改了失败提示，不影响其余条目' });
    expect(reviews[1]!.items.map(item => [item.no, item.verdict])).toEqual([[1, 'carried'], [2, 'carried'], [3, 'met']]);
    // 通过不叫醒总管：总管名下没有这件事的候选，也没有新的执行链回合。
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    // P74f：核对通过后由中心交付：主题里总管说一句话、紧接着落交付卡（原来这里是一句「核对通过。总管将向你交付。」）。
    expect(threadOf(fix.ctx, job.topicId).at(-1)).toMatchObject({ from: fix.chief.id, kind: 'job_card', refId: `delivery:${job.id}#1` });
  });

  it('4 林舟用唤醒包里的 jobId 提问成功；总管被叫醒，总管的唤醒包里有问题原文；往来里落这句问题', async () => {
    const { fix, job, info } = await started();
    const question = '价格页要不要显示年付优惠？';
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: info.jobId, text: question });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已问总管，等回答。' });
    expect(theJob(fix).openAsk).toMatchObject({ fromId: fix.engineer.id });
    expect(eventsOf(fix.ctx, job.id).filter(event => event.kind === 'asked')).toMatchObject([{ actor: fix.engineer.id, to: [fix.chief.id], data: { text: question } }]);
    expect(threadOf(fix.ctx, job.topicId).at(-1)).toMatchObject({ from: fix.engineer.id, kind: 'work', text: question });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '等回答' });
    expect(entriesOf(fix, fix.engineer.id, job.id), '提问后不续排，等回答').toHaveLength(0);
    const chiefPacket = await nextPacket(fix, fix.chief.id);
    expect(sectionOf(chiefPacket)).toContain(`林舟问你：${question}`);
  });
});

describe('5 交回校验：缺条、重复、越界、at_delivery、证据、说明，各被拒且写明第几条；全部被拒时零写入', () => {
  /** 用 patch 改标准参数后交回，必须被拒；返回错误文字，并断言没有任何写入。 */
  async function refused(patch: Record<string, unknown>, mutate?: (args: Record<string, unknown>) => void) {
    const { fix, job, info } = await started();
    const args = firstSubmitArgs(info, patch);
    mutate?.(args);
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', args);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(writeSnapshot(fix, job.id), '被拒时一点都不能写').toEqual(before);
    expect(theJob(fix)).toMatchObject({ state: 'doing', round: 0 });
    return result.error!;
  }
  const items = (info: ReturnType<typeof executorInfo>) => firstSubmitArgs(info).items as Array<Record<string, unknown>>;

  it('第 1 轮少一条：写明第几条没交', async () => {
    const { info } = await started();
    const error = await refused({ items: items(info).filter(item => item.no !== 3) });
    expect(error).toContain('第 3 条：没有交回');
    expect(error).toContain('第一次交回每一条都要写');
  });

  it('重复一条', async () => {
    const { info } = await started();
    const rows = items(info);
    expect(await refused({ items: [...rows, rows[1]!] })).toContain('第 2 条：写了多次');
  });

  it('序号越界', async () => {
    const { info } = await started();
    const error = await refused({ items: [...items(info), metWithImage(9)] });
    expect(error).toContain('第 9 条：约定「怎样算做完」只有 3 条，没有这一条');
  });

  it('给交付时核对的条目附证据；给交付时核对的条目写成 met', async () => {
    const { info } = await started();
    const withEvidence = items(info).map(item => item.no === 1 ? { no: 1, selfCheck: 'at_delivery', evidence: [{ kind: 'test', summary: '测试' }] } : item);
    expect(await refused({ items: withEvidence })).toContain('第 1 条：交付时核对的条目不附证据');
    const asMet = items(info).map(item => item.no === 1 ? metWithImage(1) : item);
    expect(await refused({ items: asMet })).toContain('第 1 条：这一条在交付时核对，selfCheck 只能写 at_delivery');
  });

  it('给普通条目写 at_delivery', async () => {
    const { info } = await started();
    const rows = items(info).map(item => item.no === 2 ? { no: 2, selfCheck: 'at_delivery' } : item);
    expect(await refused({ items: rows })).toContain('第 2 条：这一条不是交付时核对的条目');
  });

  it('met 没有证据；证据超过 4 项', async () => {
    const { info } = await started();
    const noEvidence = items(info).map(item => item.no === 2 ? { no: 2, selfCheck: 'met' } : item);
    expect(await refused({ items: noEvidence })).toContain('第 2 条：自查符合必须至少附一项证据');
    const five = items(info).map(item => item.no === 2 ? { no: 2, selfCheck: 'met', evidence: Array.from({ length: 5 }, () => ({ kind: 'test', summary: '测试' })) } : item);
    expect(await refused({ items: five })).toContain('第 2 条：证据最多 4 项');
  });

  it('not_met 没有 note；not_met 写了 note 可以通过', async () => {
    const { info } = await started();
    const rows = items(info).map(item => item.no === 3 ? { no: 3, selfCheck: 'not_met' } : item);
    expect(await refused({ items: rows })).toContain('第 3 条：自查不符必须用 note');
    const { fix, info: info2 } = await started();
    const ok = items(info2).map(item => item.no === 3 ? { no: 3, selfCheck: 'not_met', note: '失败提示还没做' } : item);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info2, { items: ok }))).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobSubmissions').list()[0]!.items[2]).toMatchObject({ selfCheck: 'not_met', note: '失败提示还没做' });
  });

  it('证据不存在、是假图片、越出主题文件夹：写明第几条和哪个路径；格式不对（link 写 ftp、test 带 path）也写明', async () => {
    const { info } = await started();
    const bad = items(info).map(item => item.no === 2 ? { no: 2, selfCheck: 'met', evidence: [
      { kind: 'image', path: '证据/没有.png', summary: '截图' },
      { kind: 'file', path: '../../../等外面的文件.txt', summary: '外面' },
      { kind: 'link', url: 'ftp://example.com/a', summary: '链接' },
      { kind: 'test', path: '证据/x.log', summary: '测试' }] } : item);
    const error = await refused({ items: bad });
    expect(error).toContain('第 2 条：找不到 证据/没有.png');
    expect(error).toContain('第 2 条：../../../等外面的文件.txt 不在主题文件夹里');
    expect(error).toContain('第 2 条：第 3 项证据：url：只接受 http:// 或 https://');
    expect(error).toContain('第 2 条：第 4 项证据：test 类型的证据不能写 path 或 url');
  });

  it('产出物不存在或为空：写明第几项', async () => {
    const { fix, job, info } = await started();
    await putFile(fix, info, '交付/空.txt', '');
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work',
      firstSubmitArgs(info, { deliverables: ['交付/报价页.html', '交付/没有.html', '交付/空.txt'] }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('deliverables 第 2 项：找不到 交付/没有.html');
    expect(result.error).toContain('deliverables 第 3 项：交付/空.txt 是空文件');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });

  it('多处同时有问题：一次列全，不是改一处报一处', async () => {
    const { info } = await started();
    const rows = items(info).filter(item => item.no !== 3).map(item => item.no === 2 ? { no: 2, selfCheck: 'met' } : item);
    const error = await refused({ items: [...rows, rows[0]!, metWithImage(8)], deliverables: ['交付/没有.html'] });
    for (const part of ['第 3 条：没有交回', '第 2 条：自查符合必须至少附一项证据', '第 1 条：写了多次', '第 8 条：约定「怎样算做完」只有 3 条', 'deliverables 第 1 项：找不到']) {
      expect(error, part).toContain(part);
    }
  });

  it('缺必填项一次列全', async () => {
    const { fix, info } = await started();
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'submit', jobId: info.jobId });
    expect(result).toEqual({ ok: false, error: '缺少必填项：changeNote、items、deliverables（mode 为 submit 时都要填写）' });
  });
});

describe('6 返工轮：被退回的条目必须重交；约定改写过的条目不能沿用', () => {
  /** 走到「第 1 轮核对退回第 3 条，林舟在返工」。 */
  async function reworking() {
    const ctx = await started();
    const { fix, info } = ctx;
    await engineerSubmits(fix, info);
    const packet = await reviewerGetsTurn(fix);
    await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', {
      mode: 'review', jobId: reviewerInfo(packet).jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'unmet', note: '没有提示', fixTo: '失败时显示「加载失败」' }],
    });
    expect(theJob(fix).state).toBe('rework');
    return ctx;
  }
  const submitPart = (jobId: string, items: unknown[]) => ({ mode: 'submit', jobId, changeNote: '改了', deliverables: ['交付/报价页.html'], items });

  it('省略被退回的第 3 条被拒，写明原因；零写入', async () => {
    const { fix, job } = await reworking();
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', submitPart(job.id, [metWithImage(2)]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('第 3 条：没有交回。这一条被退回了，要重新交回');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });

  it('约定出了新版本且改写了第 2 条：省略第 2 条被拒；重交第 2 条和第 3 条通过，第 1 条沿用', async () => {
    const { fix, job } = await reworking();
    // 约定第 2 版已固定，第 2 条的原文改了。
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const v1 = agreement.versions[0]!;
    const v2 = { ...v1, no: 2, state: 'locked' as const, content: { ...v1.content, doneWhen: [v1.content.doneWhen[0]!, '点刷新后数据在 1 秒内更新', v1.content.doneWhen[2]!] } };
    fix.ctx.store.table('agreements').put(AgreementSchema.parse({ ...agreement, versions: [{ ...v1, state: 'replaced' }, v2] }));
    const before = writeSnapshot(fix, job.id);
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', submitPart(job.id, [{ no: 3, selfCheck: 'met', evidence: [{ kind: 'test', summary: '失败提示测试通过' }] }]));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('第 2 条：没有交回。约定第 2 版改写了这一条');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    const ok = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', submitPart(job.id, [metWithImage(2),
      { no: 3, selfCheck: 'met', evidence: [{ kind: 'test', summary: '失败提示测试通过' }] }]));
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    const second = fix.ctx.store.table('jobSubmissions').list()[1]!;
    expect(second.versionNo).toBe(2);
    expect(second.items.map(item => [item.no, item.selfCheck])).toEqual([[1, 'carried'], [2, 'met'], [3, 'met']]);
    expect(second.items[1]!.text).toBe('点刷新后数据在 1 秒内更新');
  });
});

describe('7 约定重新确认中', () => {
  it('约定第 2 版在等主人确认时交回被拒，文字正确，零写入', async () => {
    const { fix, job, info } = await started();
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const v1 = agreement.versions[0]!;
    fix.ctx.store.table('agreements').put(AgreementSchema.parse({ ...agreement, state: 'pending', versions: [v1, { ...v1, no: 2, state: 'pending', lockedAt: null, lockedVia: null, adoption: null }] }));
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info));
    // P74r2b：拒绝文字补一句，告诉执行者做完照常的部分就结束这一回合。
    expect(result).toEqual({ ok: false, error: '约定第 2 版还在等主人确认，暂停的部分确认后再交回。照常在做的部分做完了就结束这一回合，主人确认后中心会叫你。' });
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });
});

describe('8 预览入口', () => {
  it('主题文件夹外的 html、不存在的 html、外网地址各被拒（零写入）；本机地址通过', async () => {
    const { fix, job, info } = await started();
    const before = writeSnapshot(fix, job.id);
    for (const preview of ['../../../别处/index.html', '交付/没有.html', 'http://example.com/', 'http://localhost.example.com', 'http://127.0.0.1@example.com']) {
      const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info, { preview }));
      expect(result.ok, preview).toBe(false);
      expect(result.error, preview).toContain('preview：');
      expect(writeSnapshot(fix, job.id), preview).toEqual(before);
    }
    await putFile(fix, info, '交付/index.html', '<html></html>');
    const ok = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info, { preview: 'http://localhost:5173/' }));
    expect(ok).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobSubmissions').list()[0]!.preview).toBe('http://localhost:5173/');
  });

  it('主题文件夹里的 html 通过，记下的是相对路径', async () => {
    const { fix, info } = await started();
    await putFile(fix, info, '交付/index.html', '<html></html>');
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info, { preview: '交付/index.html' }))).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('jobSubmissions').list()[0]!.preview).toBe('交付/index.html');
  });
});

describe('谁能调用什么：只有这件事的执行者能提问、交回、说明做不下去；别的员工、别的事、已收尾的事一律拒绝并说明原因', () => {
  it('核对人、总管、无关员工不能交回或说明做不下去；无关员工不能提问', async () => {
    const { fix, job, info } = await started(['小周']);
    const stranger = fix.extras[0]!;
    const before = writeSnapshot(fix, job.id);
    for (const [who, name] of [[fix.reviewer, '评审甲'], [fix.chief, '老大']] as const) {
      const submit = await callTool(fix, bot(fix, who.id), 'hub_job_work', firstSubmitArgs(info));
      expect(submit, name).toEqual({ ok: false, error: '只有这件事的执行者能交回' });
      const block = await callTool(fix, bot(fix, who.id), 'hub_job_work', { mode: 'block', jobId: info.jobId, stuckAt: '卡住', tried: ['试了一下'] });
      expect(block, name).toEqual({ ok: false, error: '只有这件事的执行者能说明做不下去' });
    }
    const ask = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_work', { mode: 'ask', jobId: info.jobId, text: '问问题' });
    expect(ask).toEqual({ ok: false, error: '只有这件事的执行者和核对人能向总管提问' });
    for (const args of [firstSubmitArgs(info), { mode: 'ask', jobId: info.jobId, text: '问' }, { mode: 'block', jobId: info.jobId, stuckAt: '卡', tried: ['x'] },
      { mode: 'review', jobId: info.jobId, items: [{ no: 1, verdict: 'at_delivery' }] }]) {
      const result = await callTool(fix, bot(fix, stranger.id), 'hub_job_work', args);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('jobId：没有这件事，或你不在这件事里。你手上的事：无');
    }
    expect(writeSnapshot(fix, job.id)).toEqual(before);
  });

  it('别的事：执行者拿另一件事的编号来调用被拒，并列出他手上的事', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').put(JobSchema.parse({ ...job, id: 'job_0000000099', executorId: fix.reviewer.id, reviewerId: null }));
    const result = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'ask', jobId: 'job_0000000042', text: '问' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^jobId：没有这件事，或你不在这件事里。你手上的事：/);
    expect(result.error).toContain(`（${job.id}）`);
    expect(result.error).toContain('（job_0000000099）');
    // 林舟不在 job_0000000099 里。
    const mine = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: 'job_0000000099', text: '问' });
    expect(mine.error).toContain('你不在这件事里');
    expect(mine.error).toContain(`会员定价页（${job.id}）`);
  });

  it('已完成、已停止的事：提问、交回、说明做不下去一律拒绝并说明原因', async () => {
    const { fix, job, info } = await started();
    for (const [state, word] of [['done', '已完成'], ['stopped', '已停止']] as const) {
      fix.ctx.store.table('jobs').put(JobSchema.parse({ ...theJob(fix), state, blocked: null, acceptedAt: state === 'done' ? fix.ctx.clock.now() : null, stoppedAt: state === 'stopped' ? fix.ctx.clock.now() : null }));
      for (const [args, verb] of [[{ mode: 'ask', jobId: job.id, text: '问' }, '提问'], [firstSubmitArgs(info), '交回'],
        [{ mode: 'block', jobId: job.id, stuckAt: '卡', tried: ['x'] }, '说明做不下去']] as const) {
        const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', args);
        expect(result, `${state} ${verb}`).toEqual({ ok: false, error: `这件事${word}，不能再${verb}` });
      }
    }
  });

  it('状态不对：核对中不能交回，待开工之外的状态不能说明做不下去；核对人也能提问', async () => {
    const { fix, job, info } = await started();
    await engineerSubmits(fix, info);
    const again = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info));
    expect(again).toEqual({ ok: false, error: '这件事当前是「核对中」，只有执行中、返工中时才能交回' });
    const block = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '卡', tried: ['x'] });
    expect(block.ok).toBe(false);
    expect(block.error).toContain('只有待开工、执行中、返工中时才能说明做不下去');
    // 核对人此刻可以向总管提问。
    const ask = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '第 2 条的截图要不要换成真机？' });
    expect(ask, JSON.stringify(ask)).toEqual({ ok: true, text: '已问总管，等回答。' });
    expect(theJob(fix).openAsk).toMatchObject({ fromId: fix.reviewer.id });
  });

  it('有未回答的提问时不能交回', async () => {
    const { fix, job, info } = await started();
    await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '问' });
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info));
    expect(result).toEqual({ ok: false, error: '你的问题总管还没有回答，先等回答，再交回' });
  });
});

describe('15 入队失败：交回整体恢复，工具返回失败', () => {
  it('核对人刚被停用：交回被拒，交回记录、状态、事件、往来、队列全部原样', async () => {
    const { fix, job, info } = await started();
    fix.ctx.store.table('bots').patch(fix.reviewer.id, { lifecycle: 'paused' });
    const before = writeSnapshot(fix, job.id);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('交回失败，已恢复到交回前的状态（不占轮次）');
    expect(result.error).toContain('没有排上评审甲的队');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    expect(theJob(fix)).toMatchObject({ state: 'doing', round: 0 });
    // 评审甲恢复在岗后同样的交回成功，轮次从 1 开始（没有被失败的那次占掉）。
    fix.ctx.store.table('bots').patch(fix.reviewer.id, { lifecycle: 'active' });
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info))).toMatchObject({ ok: true });
    expect(theJob(fix).round).toBe(1);
  });

  // P74e 修正（主会话追加）：回合用到上限而叫不醒评审员时，交回不再被拒绝——照常记录，由回合上限的处理接手。
  // 原断言「交回被拒、零写入」因此改为下面的预期；别的原因叫不醒仍然拒绝（见上一条、p74e-fixes.test.ts）。
  it('这件事的回合已用到上限：交回照常记录（不排评审员的唤醒），返回文字写明回合用到上限，由回合上限的处理接手', async () => {
    const { fix, job, info } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: 16 });
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info));
    expect(result).toEqual({ ok: true, text: '已交回第 1 轮。这件事已用到预计消耗，核对要等主人决定是否继续。' });
    expect(fix.ctx.store.table('jobSubmissions').list()).toHaveLength(1);
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', round: 1, blocked: { kind: 'turn_cap', resumeTo: 'checking' } });
  });

  it('提问时总管不在岗：提问被拒并恢复；说明做不下去同样', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('bots').patch(fix.chief.id, { lifecycle: 'paused' });
    const before = writeSnapshot(fix, job.id);
    const ask = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '问' });
    expect(ask.ok).toBe(false);
    expect(ask.error).toContain('提问失败，已恢复到提问前的状态');
    const block = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '卡住了', tried: ['试了一下'] });
    expect(block.ok).toBe(false);
    expect(block.error).toContain('没有记下，已恢复到之前的状态');
    expect(writeSnapshot(fix, job.id)).toEqual(before);
    expect(theJob(fix)).toMatchObject({ state: 'doing', openAsk: null });
  });
});

describe('16 提问与说明做不下去', () => {
  it('已有未回答的问题再问被拒，文字正确；总管被叫醒的唤醒只有一条', async () => {
    const { fix, job } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '第一个问题' })).toMatchObject({ ok: true });
    const again = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '第二个问题' });
    expect(again).toEqual({ ok: false, error: '你上一个问题总管还没有回答，先等回答' });
    expect(eventsOf(fix.ctx, job.id).filter(event => event.kind === 'asked')).toHaveLength(1);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
  });

  it('block：状态转受阻（执行者），总管被叫醒，事件带试过什么，往来落一句；总管的唤醒包写明卡在哪', async () => {
    const { fix, job, info } = await started();
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'block', jobId: info.jobId, stuckAt: '拿不到线上的价格表', tried: ['问了总管', '找了历史记录'] });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已告诉总管。' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', text: '拿不到线上的价格表', resumeTo: 'doing' } });
    expect(eventsOf(fix.ctx, job.id).filter(event => event.kind === 'executor_blocked')).toMatchObject([{ actor: fix.engineer.id, to: [fix.chief.id], data: { text: '拿不到线上的价格表', tried: ['问了总管', '找了历史记录'] } }]);
    expect(threadOf(fix.ctx, job.topicId).at(-1)).toMatchObject({ from: 'hub', kind: 'work', text: '林舟无法继续：拿不到线上的价格表。已告诉总管。' });
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', summary: '做不下去', blocker: '拿不到线上的价格表' });
    const packet = await nextPacket(fix, fix.chief.id);
    expect(sectionOf(packet)).toContain('林舟做不下去：拿不到线上的价格表；试过：问了总管；找了历史记录。');
  });

  it('block 缺 stuckAt、tried 一次列全', async () => {
    const { fix, job } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id }))
      .toEqual({ ok: false, error: '缺少必填项：stuckAt、tried（mode 为 block 时都要填写）' });
  });
});

describe('工具参数', () => {
  it('字段放错 mode 直接报错，不悄悄忽略', async () => {
    const { fix, job, info } = await started();
    const askWithItems = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '问', stuckAt: '卡' });
    expect(askWithItems).toEqual({ ok: false, error: 'mode 为 ask 时不用这些字段：stuckAt' });
    const rows = (firstSubmitArgs(info).items as Array<Record<string, unknown>>).map(item => item.no === 2 ? { ...item, verdict: 'met' } : item);
    const submit = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info, { items: rows, carriedNote: '沿用' }));
    expect(submit.error).toContain('mode 为 submit 时不用这些字段：carriedNote');
    expect(submit.error).toContain('第 2 条：mode 为 submit 时条目不用这些字段：verdict');
  });

  it('参数校验：mode、jobId、未知字段、空文字、超长文字都给中文提示', async () => {
    const { fix, job } = await started();
    const call = (args: Record<string, unknown>) => callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', args);
    // P74g：launched 现在是合法的 mode，这条改用一个仍然不存在的 mode 名（预期只改了这个名字）。
    expect((await call({ mode: 'stop', jobId: job.id })).error).toContain('mode：必须是 ask');
    expect((await call({ mode: 'ask', jobId: 'abc', text: '问' })).ok).toBe(false);
    expect((await call({ mode: 'ask', jobId: job.id, text: '问', extra: 1 })).ok).toBe(false);
    expect((await call({ mode: 'ask', jobId: job.id, text: '   ' })).error).toContain('text：不能为空');
    expect((await call({ mode: 'ask', jobId: job.id, text: '问'.repeat(501) })).error).toContain('text：不能超过 500 字');
    expect((await call({ mode: 'ask', jobId: job.id })).error).toContain('缺少必填项：text');
    const shape = HubJobWorkInputSchema.shape;
    expect(Object.keys(shape)).toEqual(['mode', 'jobId', 'text', 'changeNote', 'items', 'deliverables', 'preview', 'carriedNote', 'spotChecked', 'stuckAt', 'tried', 'link']);
  });

  it('复盘回合禁止调用', async () => {
    const { fix, job } = await started();
    const wake = runningOf(fix, fix.engineer.id)!;
    fix.ctx.store.table('wakes').patch(wake.id, { variant: 'reflection' });
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '问' });
    expect(result).toEqual({ ok: false, error: '反思回合只读；其他事项留到下一回合' });
  });
});

describe('18 给主人看的文字不含内部名称', () => {
  it('往来里的卡片文字和中心提示（交回、核对、提问、说明做不下去）不含工具名、员工编号、各种内部编号', async () => {
    const { fix, job, info } = await started();
    await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'ask', jobId: job.id, text: '价格页要不要显示年付优惠？' });
    await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '卡住了', tried: ['试了一下'] });
    // 清掉提问，换一条干净的路径去交回、核对，覆盖更多提示。
    fix.ctx.store.table('jobs').put(JobSchema.parse({ ...theJob(fix), state: 'doing', blocked: null, openAsk: null }));
    await engineerSubmitsAgain(fix, info);
    const texts = threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' || row.kind === 'job_card').map(row => row.text);
    expect(texts.length).toBeGreaterThan(2);
    for (const text of texts) expect(text, text).not.toMatch(INTERNAL);
  });
});

/** 交回一次（用标准参数）。 */
async function engineerSubmitsAgain(fix: Awaited<ReturnType<typeof started>>['fix'], info: ReturnType<typeof executorInfo>): Promise<void> {
  expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info))).toMatchObject({ ok: true });
}
