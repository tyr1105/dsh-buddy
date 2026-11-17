/**
 * P74r10 第 2 至 4 节的测试：
 * 2 「怎样算做完」不能写验收之后才发生的事：十五种说法各一条被拒（文字逐字相同），不该拦的照常通过，
 *   修订时新加一条同样被拒，一次提交两条都有问题时两条都列出；总管守则里有逐字加入的那句；
 * 3 发布方式（launch.how）末尾的标点：句号、两个句号、分号、半角符号都去掉，约定卡那一行里「发布前单独请你批准。」之前恰好一个句号；
 *   中间的标点不动；全是标点的被拒；旧数据读取时同样处理（约定文件、总管唤醒包、发布准备的唤醒包）；
 * 4 派活成功的返回文字：有对外发布这一步时多一句，没有时不变；落在主题里的话不变。
 * 全部走真实的 Hub，时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView } from '../src/api/agreement-views.js';
import { renderAgreementFile } from '../src/job/files.js';
import { ASSIGNED_LAUNCH_NOTE } from '../src/job/assign.js';
import { AFTER_ACCEPTANCE_PHRASES, LAUNCH_ONLY_PHRASES, afterAcceptanceRefusal } from '../src/project/agreement-content.js';
import { launchOf } from '../src/model/agreement.js';
import { newAgreementArgs } from './p72b-fixtures.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { FIXTURE_LAUNCH_HOW, assignArgs } from './p74c-fixtures.js';
import { chiefDrafts, jobFix, lockedAndAwake, ownerSays, speak, type JobFix } from './p74b-fixtures.js';
import { bot, callTool, delivered, nextPacket, threadOf } from './p74f-fixtures.js';

/** 三条正常的「怎样算做完」，测试在其中换一条。 */
const OK_ITEMS = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示'];

/** 主人说了一句话之后，总管新建一份约定（不要求成功），返回工具结果。 */
async function chiefSubmitsNew(fix: JobFix, extra: Record<string, unknown>) {
  await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
  return callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页', ...extra }));
}

/** 总管在主人又说了一句话之后调用约定提交（先结束上一回合，再让主人说一句）。 */
async function chiefAfterOwnerWords(fix: JobFix, words: string, args: Record<string, unknown>) {
  await speak(fix, bot(fix, fix.chief.id), '已记下。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, words);
  return callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', args);
}

/** 该约定当前最新一版的约定卡视图。 */
function latestCard(fix: JobFix, agreementId: string) {
  const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
  return agreementCardView(fix.ctx, agreement, agreement.versions.at(-1)!);
}

describe('2 「怎样算做完」不能写验收之后的事', () => {
  it('十五种说法各一条被拒，文字逐字相同，没有建约定', async () => {
    // P74r18a：只在写了对外发布时才拦的说法由 6 种增至 14 种（新增八种「已发布」类），总数 15 变为 23；这一条仍逐种核对。
    expect(AFTER_ACCEPTANCE_PHRASES).toHaveLength(23);
    for (const phrase of AFTER_ACCEPTANCE_PHRASES) {
      const fix = await jobFix();
      // P74r13 第 7 节改了预期：「发布后」「上线后」一类六种只在这一版约定写了对外发布时才拦，所以这六种的约定带上 launch；
      // 其余九种任何约定都拦（没有 launch 的约定里六种的情形见 p74r13-small.test.ts）。
      const launchOnly = (LAUNCH_ONLY_PHRASES as readonly string[]).includes(phrase);
      const result = await chiefSubmitsNew(fix, { doneWhen: [OK_ITEMS[0], `${phrase}页面文件夹已复制到指定目录`, OK_ITEMS[2]], ...(launchOnly ? { launch: { how: FIXTURE_LAUNCH_HOW } } : {}) });
      expect(result.ok, phrase).toBe(false);
      // 逐字：{i} 是从 0 起的序号，这里放在第 2 条，序号是 1。
      expect(result.error, phrase).toContain('doneWhen[1]：这一条说的是验收之后才发生的事。「怎样算做完」的每一条都要在交付核对时就能判断；对外发布写在 launch 里，不写进这里。');
      expect(result.error, phrase).toBe(`约定内容无效：${afterAcceptanceRefusal(1)}`);
      expect(fix.ctx.store.table('agreements').count(), phrase).toBe(0);
    }
  });

  it('真实模型写过的那一条（验收通过后，经你批准，页面文件夹已复制到某目录）被拒', async () => {
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, { doneWhen: [OK_ITEMS[0], OK_ITEMS[1], '验收通过后，经你批准，页面文件夹已复制到 /tmp/p74k-site'] });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('doneWhen[2]：这一条说的是验收之后才发生的事。');
  });

  it('不该拦的照常通过', async () => {
    for (const item of ['提交后页面显示「报名成功」', '手机号不是 11 位时提示「请填写 11 位手机号」', '发布前的检查清单已写好', '导出的名单里有姓名、手机号、公司名三列']) {
      const fix = await jobFix();
      const result = await chiefSubmitsNew(fix, { doneWhen: [OK_ITEMS[0], OK_ITEMS[1], item] });
      expect(result, `${item}：${JSON.stringify(result)}`).toMatchObject({ ok: true });
    }
  });

  it('修订时新加一条这样的同样被拒，约定没有新版本', async () => {
    const fix = await jobFix();
    const id = await chiefDrafts(fix as never, { title: '会员定价页' });
    const result = await chiefAfterOwnerWords(fix, '再加一条', {
      mode: 'revise', agreementId: id, changeNote: '加一条', // P74r13 第 7 节改了预期：原来写「上线之后访问量不下降」；这份约定没有对外发布，「上线之后」不再拦，换成任何约定都拦的「验收之后」。
      doneWhen: [...fix.ctx.store.table('agreements').get(id)!.versions[0]!.content.doneWhen, '验收之后访问量不下降'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('doneWhen[3]：这一条说的是验收之后才发生的事。「怎样算做完」的每一条都要在交付核对时就能判断；对外发布写在 launch 里，不写进这里。');
    expect(fix.ctx.store.table('agreements').get(id)!.versions).toHaveLength(1);
  });

  it('修订时没有写 doneWhen（沿用上一版）不受影响', async () => {
    const fix = await jobFix();
    const id = await chiefDrafts(fix as never, { title: '会员定价页' });
    const result = await chiefAfterOwnerWords(fix, '一句话再准一点', { mode: 'revise', agreementId: id, changeNote: '一句话更准确', summary: '做一个能查看会员定价的小页面' });
    expect(result).toMatchObject({ ok: true });
  });

  it('一次提交两条都有问题：两条都列出', async () => {
    const fix = await jobFix();
    // P74r13 第 7 节改了预期：原来第一条写「发布后页面能打开」；没有对外发布的约定里它不再拦，换成「验收后页面能打开」。
    const result = await chiefSubmitsNew(fix, { doneWhen: ['验收后页面能打开', OK_ITEMS[1], '经你批准后复制到目录'] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`约定内容无效：${afterAcceptanceRefusal(0)}；${afterAcceptanceRefusal(2)}`);
  });

  it('总管守则里有逐字加入的那句', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    expect(packet).toContain('doneWhen 只写交付核对时就能判断的结果；验收之后才发生的事（对外发布、上线之后的效果）不写进 doneWhen。');
    // 位置：讲对外发布写进 launch 的那几句之后。
    expect(packet.indexOf('doneWhen 只写交付核对时就能判断的结果')).toBeGreaterThan(packet.indexOf('约定里没有 launch 的事，验收之后没有发布这一步'));
  });
});

describe('3 发布方式末尾的标点', () => {
  const TAIL = '发布前单独请你批准。';

  it('how 以「。」「。。」「；」和半角符号结尾：约定卡那一行里，发布前单独请你批准之前恰好一个句号，存储里的 how 已去掉', async () => {
    const cases: Array<[string, string]> = [
      ['。', '复制到本机的 /tmp/site 目录。'], ['。。', '复制到本机的 /tmp/site 目录。。'], ['；', '复制到本机的 /tmp/site 目录；'],
      ['，', '复制到本机的 /tmp/site 目录，'], ['、', '复制到本机的 /tmp/site 目录、'],
      ['半角句号', '复制到本机的 /tmp/site 目录.'], ['半角分号逗号', '复制到本机的 /tmp/site 目录;,'], ['末尾有空白', '  复制到本机的 /tmp/site 目录。 '],
      ['标点之间有空白', '复制到本机的 /tmp/site 目录。 ； '],
    ];
    for (const [label, how] of cases) {
      const fix = await jobFix();
      const id = await chiefDrafts(fix as never, { title: '会员定价页', launch: { how } });
      const agreement = fix.ctx.store.table('agreements').get(id)!;
      expect(launchOf(agreement.versions[0]!.content), label).toEqual({ how: '复制到本机的 /tmp/site 目录' });
      expect(latestCard(fix, id).launchLine, label).toBe(`验收之后对外发布：复制到本机的 /tmp/site 目录。${TAIL}`);
    }
  });

  it('how 中间的标点不动', async () => {
    const fix = await jobFix();
    const how = '先复制到 /tmp/site，再通知大家；完成后回复我。';
    const id = await chiefDrafts(fix as never, { title: '会员定价页', launch: { how } });
    expect(launchOf(fix.ctx.store.table('agreements').get(id)!.versions[0]!.content)).toEqual({ how: '先复制到 /tmp/site，再通知大家；完成后回复我' });
    expect(latestCard(fix, id).launchLine).toBe(`验收之后对外发布：先复制到 /tmp/site，再通知大家；完成后回复我。${TAIL}`);
  });

  it('how 去掉标点之后为空：按「不能为空」拒绝，修订也一样，约定没有新版本', async () => {
    const fix = await jobFix();
    const refused = await chiefSubmitsNew(fix, { launch: { how: '。；' } });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('不能为空');
    const id = await chiefDrafts(fix as never, { title: '另一件事' });
    const revised = await chiefAfterOwnerWords(fix, '加发布', { mode: 'revise', agreementId: id, changeNote: '加上对外发布', launch: { how: '。。' } });
    expect(revised.ok).toBe(false);
    expect(revised.error).toContain('不能为空');
    expect(fix.ctx.store.table('agreements').get(id)!.versions).toHaveLength(1);
  });

  it('旧数据（存储里的 how 带着句号）：约定卡、约定文件、总管唤醒包都只有一个句号', async () => {
    const fix = await jobFix();
    // P81 同步：提交时的发布方式不能同时有「本机」和「目录」又不填 localDir（第 1 节第 5 条），所以提交用别的写法；
    // 下面照旧直接把存储里的数据改成升级前的样子（带两个句号的「复制到本机目录」），后面的断言一字未动。
    const packetBefore = await lockedAndAwake(fix, undefined, { launch: { how: '复制到内网目录' } });
    const id = agreementIdIn(packetBefore);
    // 模拟升级前存下的数据：how 末尾带着两个句号。
    const agreement = fix.ctx.store.table('agreements').get(id)!;
    const versions = agreement.versions.map(version => ({ ...version, content: { ...version.content, launch: { how: '复制到本机目录。。' } } }));
    fix.ctx.store.table('agreements').patch(id, { versions });
    const stored = fix.ctx.store.table('agreements').get(id)!;
    expect(stored.versions.at(-1)!.content.launch).toEqual({ how: '复制到本机目录。。' });
    expect(latestCard(fix, id).launchLine).toBe(`验收之后对外发布：复制到本机目录。${TAIL}`);
    expect(renderAgreementFile(stored, stored.versions.at(-1)!)).toContain('## 对外发布\n复制到本机目录\n发布前由主人单独批准。');
    // 总管唤醒包：约定段「对外发布：……（验收之后对外发布……」。
    await speak(fix, bot(fix, fix.chief.id), '好的。', { outcome: 'progress' });
    await ownerSays(fix, fix.chief.id, '有进展吗');
    const chiefPacket = await nextPacket(fix, fix.chief.id);
    expect(chiefPacket).toContain('对外发布：复制到本机目录（验收之后对外发布，发布前中心单独请主人批准）');
    expect(chiefPacket).not.toContain('复制到本机目录。。');
  });

  it('旧数据：发布准备的唤醒包里「约定里写的发布方式」也去掉末尾的标点', async () => {
    const { fix, job } = await delivered([], { launch: true });
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const versions = agreement.versions.map(version => ({ ...version, content: { ...version.content, launch: { how: `${FIXTURE_LAUNCH_HOW}。。` } } }));
    fix.ctx.store.table('agreements').patch(job.agreementId, { versions });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(packet).toContain(`约定里写的发布方式：${FIXTURE_LAUNCH_HOW}`);
    expect(packet).not.toContain(`${FIXTURE_LAUNCH_HOW}。。`);
  });
});

describe('4 派活成功后告诉总管还有对外发布这一步', () => {
  it('约定带 launch：返回文字在原句之后多一句，逐字；主题里那句话不变', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix, undefined, { launch: { how: '发布到测试站点' } });
    const result = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementIdIn(packet), { launchStep: undefined }));
    expect(result).toEqual({
      ok: true,
      text: '已派给林舟，评审甲核对。这件事验收之后还有对外发布这一步，到时中心会单独请主人批准；对主人说明安排时把这一步说上。',
    });
    expect(ASSIGNED_LAUNCH_NOTE).toBe('这件事验收之后还有对外发布这一步，到时中心会单独请主人批准；对主人说明安排时把这一步说上。');
    // 落在主题里的话没有这一句。
    const topic = fix.ctx.store.table('agreements').list()[0]!.topicId;
    const texts = threadOf(fix.ctx, topic).map(row => row.text);
    expect(texts.some(text => text.startsWith('这件事由林舟'))).toBe(true);
    expect(texts.some(text => text.includes('这件事验收之后还有对外发布这一步'))).toBe(false);
  });

  it('约定没有 launch：返回文字不变', async () => {
    const fix = await jobFix();
    const packet = await lockedAndAwake(fix);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementIdIn(packet)));
    expect(result).toEqual({ ok: true, text: '已派给林舟，评审甲核对。' });
  });
});
