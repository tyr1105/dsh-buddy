/**
 * P74r18a 第 1 节的测试：对外发布不提前，约定里不写发布要去的位置、不把「已发布」当完成条件。
 * 覆盖：
 * 1.1 新增八种说法各一条被拒（参数化）；
 * 1.2 发布方式里取出的路径、网址、域名出现在「怎样算做完」「这次做」里被拒（文字逐字，一次列全）；
 *     大小写不同、末尾带斜杠的路径同样算；反例：没有对外发布、取不出位置、条目里是别的路径；
 * 1.3 校验的对象是合并之后生效的内容：修订只加对外发布时，上一版留下的条目也会被查到；同时改掉则通过；小改动（amend）同样校验；
 * 1.4 launch 字段的说明末尾有逐字加入的那句。
 * 全部走真实的 Hub、真实工具；时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import {
  AgreementSubmitInputSchema, LAUNCH_ONLY_PHRASES, afterAcceptanceRefusal, launchLocationsOf,
} from '../src/project/agreement-content.js';
import { newAgreementArgs } from './p72b-fixtures.js';
import { chiefDrafts, jobFix, ownerSays, speak, type JobFix } from './p74b-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { bot, callTool, started } from './p74f-fixtures.js';

const OK_DONE = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示'];
const OK_SCOPE = ['报价列表页', '手动刷新'];
const HOW = '把页面文件夹复制到你电脑上的 /tmp/p74l2-site 目录完成发布';

/** 总管新建一份约定（不要求成功）。 */
async function chiefSubmitsNew(fix: JobFix, extra: Record<string, unknown>) {
  await ownerSays(fix, fix.chief.id, '帮我做个每日报价页');
  return callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页', ...extra }));
}

/** 主人又说一句话之后，总管提交修订。 */
async function chiefAfterOwnerWords(fix: JobFix, args: Record<string, unknown>) {
  await speak(fix, bot(fix, fix.chief.id), '已记下。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, '再改一下');
  return callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', args);
}

const doneRefusal = (i: number, where: string) => `doneWhen[${i}]：这一条写到了对外发布要去的位置（${where}）。对外发布在验收之后、经主人批准才进行，不能当作交付时的完成条件；改成交付时就能核对的说法，或删去。`;
const scopeRefusal = (i: number, where: string) => `scopeIn[${i}]：这一条写到了对外发布要去的位置（${where}）。对外发布写在 launch 里，由中心在验收之后请主人批准再进行；「这次做」只写验收之前要做的事。`;

describe('1.1 新增八种「发布已经完成」的说法', () => {
  const NEW_EIGHT = ['已发布', '已上线', '发布完成', '上线完成', '发布成功', '上线成功', '完成发布', '完成上线'];

  it('名单里有这八种', () => {
    for (const phrase of NEW_EIGHT) expect(LAUNCH_ONLY_PHRASES as readonly string[]).toContain(phrase);
  });

  it.each(NEW_EIGHT)('写了对外发布时「%s」被拒，文字沿用原句', async phrase => {
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, { launch: { how: '发布到公司公众号' }, doneWhen: [OK_DONE[0], `页面${phrase}`, OK_DONE[2]] });
    expect(result.ok, phrase).toBe(false);
    expect(result.error).toBe(`约定内容无效：${afterAcceptanceRefusal(1)}`);
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
  });

  it.each(NEW_EIGHT)('没有对外发布时「%s」不拦', async phrase => {
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, { doneWhen: [OK_DONE[0], `文档写明${phrase}的判断标准`, OK_DONE[2]] });
    expect(result, phrase).toMatchObject({ ok: true });
  });
});

describe('1.2 发布要去的位置不能出现在「这次做」「怎样算做完」里', () => {
  it('取位置：路径、网址、域名；取不出时为空', () => {
    expect(launchLocationsOf(HOW)).toEqual(['/tmp/p74l2-site']);
    expect(launchLocationsOf('复制到 ~/Sites/signup/ 下')).toEqual(['~/Sites/signup']);
    expect(launchLocationsOf('上传到 https://static.example.com/site 并通知')).toEqual(['https://static.example.com/site']);
    expect(launchLocationsOf('发布到 signup.example.com')).toEqual(['signup.example.com']);
    expect(launchLocationsOf('发到公司公众号')).toEqual([]);
    // 只有一级的路径不算位置。
    expect(launchLocationsOf('复制到 /tmp 目录')).toEqual([]);
  });

  it('「怎样算做完」第 5 条写到位置：被拒，文字逐字，没有建约定', async () => {
    const fix = await jobFix();
    const doneWhen = [...OK_DONE, '页面里有报价表', '页面文件夹已复制到 /tmp/p74l2-site，浏览器可从该目录打开页面'];
    const result = await chiefSubmitsNew(fix, { launch: { how: HOW }, doneWhen });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`约定内容无效：${doneRefusal(4, '/tmp/p74l2-site')}`);
    expect(result.error).toContain('doneWhen[4]：这一条写到了对外发布要去的位置（/tmp/p74l2-site）。对外发布在验收之后、经主人批准才进行，不能当作交付时的完成条件；改成交付时就能核对的说法，或删去。');
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
  });

  it('「这次做」写到位置：被拒，文字逐字', async () => {
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, { launch: { how: HOW }, scopeIn: ['报价列表页', '把页面文件夹复制到 /tmp/p74l2-site 的发布方式'] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`约定内容无效：${scopeRefusal(1, '/tmp/p74l2-site')}`);
    expect(result.error).toContain('scopeIn[1]：这一条写到了对外发布要去的位置（/tmp/p74l2-site）。对外发布写在 launch 里，由中心在验收之后请主人批准再进行；「这次做」只写验收之前要做的事。');
  });

  it('两处都有：一次列全（怎样算做完在前，这次做在后）', async () => {
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, {
      launch: { how: HOW }, scopeIn: ['把页面文件夹复制到 /tmp/p74l2-site 的发布方式', '手动刷新'],
      doneWhen: [OK_DONE[0], OK_DONE[1], '页面已复制到 /tmp/p74l2-site'],
    });
    expect(result.error).toBe(`约定内容无效：${doneRefusal(2, '/tmp/p74l2-site')}；${scopeRefusal(0, '/tmp/p74l2-site')}`);
  });

  it('网址、域名各一条正例', async () => {
    for (const [how, where, item] of [
      ['上传到 https://static.example.com/site 完成发布', 'https://static.example.com/site', '页面可通过 https://static.example.com/site 访问'],
      ['绑定到 signup.example.com 这个域名', 'signup.example.com', '页面可通过 signup.example.com 访问'],
    ] as const) {
      const fix = await jobFix();
      const result = await chiefSubmitsNew(fix, { launch: { how }, doneWhen: [OK_DONE[0], OK_DONE[1], item] });
      expect(result.error, how).toBe(`约定内容无效：${doneRefusal(2, where)}`);
    }
  });

  it('发布方式里的文件名不当作域名：只取出真正的域名；条目里提到文件名不被拒，提到域名被拒', async () => {
    const how = '把 index.html 部署到 signup.example.com';
    expect(launchLocationsOf(how)).toEqual(['signup.example.com']);
    const fixA = await jobFix();
    const fine = await chiefSubmitsNew(fixA, { launch: { how }, doneWhen: [OK_DONE[0], OK_DONE[1], 'index.html 里有报名表单'] });
    expect(fine, JSON.stringify(fine)).toMatchObject({ ok: true });
    const fixB = await jobFix();
    const refused = await chiefSubmitsNew(fixB, { launch: { how }, doneWhen: [OK_DONE[0], OK_DONE[1], 'signup.example.com 可以打开'] });
    expect(refused.error).toBe(`约定内容无效：${doneRefusal(2, 'signup.example.com')}`);
  });

  it('发布方式里只有文件名、没有路径网址域名：位置规则不生效', async () => {
    expect(launchLocationsOf('把 index.html 发给对方')).toEqual([]);
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, { launch: { how: '把 index.html 发给对方' }, doneWhen: [OK_DONE[0], OK_DONE[1], 'index.html 里有报名表单'] });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });

  it('路径大小写不同、末尾带斜杠各一条正例', async () => {
    const fixA = await jobFix();
    const upper = await chiefSubmitsNew(fixA, { launch: { how: HOW }, doneWhen: [OK_DONE[0], OK_DONE[1], '页面在 /TMP/P74L2-SITE 下'] });
    expect(upper.error).toBe(`约定内容无效：${doneRefusal(2, '/tmp/p74l2-site')}`);
    const fixB = await jobFix();
    const slash = await chiefSubmitsNew(fixB, { launch: { how: `${HOW}/` }, doneWhen: [OK_DONE[0], OK_DONE[1], '页面在 /tmp/p74l2-site/ 下'] });
    expect(slash.error).toBe(`约定内容无效：${doneRefusal(2, '/tmp/p74l2-site')}`);
  });

  it('反例：没有写对外发布时同样的条目不被拒', async () => {
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, { doneWhen: [OK_DONE[0], OK_DONE[1], '页面文件夹已复制到 /tmp/p74l2-site'], scopeIn: ['把页面文件夹复制到 /tmp/p74l2-site'] });
    expect(result).toMatchObject({ ok: true });
  });

  it('反例：发布方式里取不出位置（发到公司公众号），位置规则不生效', async () => {
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, { launch: { how: '发到公司公众号' }, doneWhen: [OK_DONE[0], OK_DONE[1], '页面文件夹已复制到 /tmp/p74l2-site'] });
    expect(result).toMatchObject({ ok: true });
  });

  it('反例：条目里的路径与发布位置不同（交付文件夹、更长的路径）不被拒', async () => {
    const fix = await jobFix();
    const result = await chiefSubmitsNew(fix, {
      launch: { how: HOW }, scopeIn: ['报价列表页', '页面放进交付文件夹 /work/deliver/site'],
      doneWhen: [OK_DONE[0], '交付文件夹 /work/deliver/site 里有 index 页面', '备份在 /tmp/p74l2-site-backup 里'],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });
});

describe('1.3 校验的对象是合并之后生效的内容', () => {
  it('第 1 版没有对外发布、「怎样算做完」带路径；修订只加对外发布（发布到这个路径）：被拒，序号是原条目的序号', async () => {
    const fix = await jobFix();
    const id = await chiefDrafts(fix as never, { title: '会员定价页', doneWhen: [OK_DONE[0], '页面文件夹已复制到 /tmp/p74l2-site', OK_DONE[2]] });
    const result = await chiefAfterOwnerWords(fix, { mode: 'revise', agreementId: id, changeNote: '加上对外发布', launch: { how: HOW } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`约定内容无效：${doneRefusal(1, '/tmp/p74l2-site')}`);
    expect(fix.ctx.store.table('agreements').get(id)!.versions).toHaveLength(1);
  });

  it('修订同时把那一条改掉：通过', async () => {
    const fix = await jobFix();
    const id = await chiefDrafts(fix as never, { title: '会员定价页', doneWhen: [OK_DONE[0], '页面文件夹已复制到 /tmp/p74l2-site', OK_DONE[2]] });
    const result = await chiefAfterOwnerWords(fix, {
      mode: 'revise', agreementId: id, changeNote: '加上对外发布', launch: { how: HOW }, doneWhen: [OK_DONE[0], '页面文件夹里有 index 页面', OK_DONE[2]],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('agreements').get(id)!.versions).toHaveLength(2);
  });

  it('上一版留下的「已发布」类说法，只加对外发布的修订同样被查到', async () => {
    const fix = await jobFix();
    const id = await chiefDrafts(fix as never, { title: '会员定价页', doneWhen: [OK_DONE[0], '页面已上线可访问', OK_DONE[2]] });
    const result = await chiefAfterOwnerWords(fix, { mode: 'revise', agreementId: id, changeNote: '加上对外发布', launch: { how: '发到公司公众号' } });
    expect(result.error).toBe(`约定内容无效：${afterAcceptanceRefusal(1)}`);
  });

  /** 进行中的事（约定带对外发布，发布位置 /tmp/p74k-site）、执行者先收尾，主人对总管说一句话，返回可以调用 amend 的环境。 */
  async function chiefHearsOwner() {
    const { fix, job } = await started([], { launch: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, '复述改一下');
    return { fix, job };
  }
  const amendSummary = (fix: JobFix, agreementId: string) =>
    callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'amend', agreementId, changeNote: '复述更准确', summary: '做一个能查看会员定价的小页面' });

  it('小改动（amend）：生效内容合法时照常通过', async () => {
    const { fix, job } = await chiefHearsOwner();
    const result = await amendSummary(fix, job.agreementId);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });

  it('小改动：生效内容里有违规（旧数据里留下的，沿用上一版）时，amend 同样被拒，序号是生效内容里的序号', async () => {
    const { fix, job } = await chiefHearsOwner();
    // 模拟升级前存下的数据：生效版的「怎样算做完」里带着发布位置。
    const agreement = fix.ctx.store.table('agreements').get(job.agreementId)!;
    const versions = agreement.versions.map(row => ({ ...row, content: { ...row.content, doneWhen: [OK_DONE[0]!, '页面已复制到 /tmp/p74k-site', OK_DONE[2]!] } }));
    fix.ctx.store.table('agreements').patch(job.agreementId, { versions });
    const result = await amendSummary(fix, job.agreementId);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`约定内容无效：${doneRefusal(1, '/tmp/p74k-site')}`);
    expect(fix.ctx.store.table('agreements').get(job.agreementId)!.versions).toHaveLength(1);
  });
});

describe('1.4 launch 字段说明', () => {
  it('末尾有逐字加入的那句', () => {
    const description = AgreementSubmitInputSchema.shape.launch.description ?? '';
    expect(description.endsWith('发布这一步只写在这里：「这次做」「怎样算做完」里不要出现发布要去的位置，也不要把「已发布」「已上线」当作完成条件。')).toBe(true);
  });
});
