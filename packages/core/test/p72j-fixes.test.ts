/**
 * P72j 的测试：修复第二次真模型复测（P72i）发现的问题。
 * - J1：约定等确认期间，总管不能再发提问卡（带 ownerQuestion 交账被拒，needs_owner 不再要求提问）；
 * - J2：hub_send、hub_job_manage（P74b 起取代 hub_handoff）、hub_project_task_upsert 的收件人和跟进人可以写员工名字；
 * - J3：草图 mark 的参数说明、总管守则末尾一条、交账里可为空的字段省略时等同于 null。
 * 为什么走真实 Hub：交账、派活工具、唤醒包都挂在真实链路上，只有走链路才能测到接线。
 */
import { describe, expect, it } from 'vitest';
import { CommitInputSchema, CommitToolSchema } from '../src/commit/schema.js';
import { CHIEF_RULES_TEXT } from '../src/wake/chief-packet.js';
import { commitArgs } from './c03-turn-fixtures.js';
import { lastPacket } from './p63-topic-fixtures.js';
import { callTool, chiefDrafts, ownerSays, setup, speak, type Fix } from './p72b-fixtures.js';

/** 一个合法的提问（给反例用）。 */
const QUESTION = { text: '约定卡片里 5 项待定是否按建议确认？', options: ['按建议全部确认', '我来改'], defaultOption: '按建议全部确认', whyNeeded: '需要主人定' };

/** 以总管身份直接调用 hub_commit（不结束回合），返回工具结果。 */
function commitAs(fix: Fix, bot: Fix['chief'], patch: Record<string, unknown>) {
  return callTool(fix, bot, 'hub_commit', commitArgs(patch as never));
}

/** 「待你处理」里还开着的、不属于约定卡的条目。 */
function openNonAgreementItems(fix: Fix) {
  return fix.ctx.store.table('inbox').list(row => row.status === 'open' && !row.subjectKey.startsWith('agreement:'));
}

/** 总管提交约定后，主人说「定了」，总管收到「刚由主人确认」的唤醒包；返回这份唤醒包。 */
async function lockedAndAwake(fix: Fix): Promise<string> {
  await chiefDrafts(fix);
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, '定了');
  return lastPacket(fix, fix.chief);
}

describe('J1 约定等确认期间不再发提问卡', () => {
  it('对齐回合带 ownerQuestion 交账被拒：报错是任务卡规定的文字，「待你处理」里没有提问条目，没有生成交账', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    const result = await commitAs(fix, fix.chief, { outcome: 'needs_owner', reply: '有 2 项需要你定', ownerQuestion: QUESTION });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('约定卡已经在等主人确认，不能再用 ownerQuestion 提问，它会生成第二张提问卡。需要主人定的事放进约定的待定项；outcome 可以写 needs_owner，不填 ownerQuestion');
    expect(openNonAgreementItems(fix)).toEqual([]);
    expect(fix.ctx.store.table('commits').count()).toBe(0);
  });

  it('被拒后同回合改正：needs_owner 不带 ownerQuestion 成功，总管状态是在等主人，仍然没有提问条目', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    expect((await commitAs(fix, fix.chief, { outcome: 'needs_owner', reply: '有 2 项需要你定', ownerQuestion: QUESTION })).ok).toBe(false);
    const result = await commitAs(fix, fix.chief, { outcome: 'needs_owner', reply: '这件事有 2 项需要你定，确认前不会开工。', ownerQuestion: null });
    expect(result.ok).toBe(true);
    expect(fix.ctx.store.table('bots').get(fix.chief.id)).toMatchObject({ activity: 'waiting_owner', activityText: '在等主人回复' });
    expect(openNonAgreementItems(fix)).toEqual([]);
    // 约定卡本身还在「待你处理」里，是唯一的确认入口。
    expect(fix.ctx.store.table('inbox').count(row => row.status === 'open' && row.subjectKey.startsWith('agreement:'))).toBe(1);
  });

  it('省略 ownerQuestion 字段也成功（模型常见写法）', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    const { ownerQuestion: _omit, ...args } = commitArgs({ outcome: 'needs_owner', reply: '有 2 项需要你定' });
    expect((await callTool(fix, fix.chief, 'hub_commit', args)).ok).toBe(true);
  });

  it('主人点「定了」后：「待你处理」里没有与这份约定有关的条目，总管不再是在等主人', async () => {
    const fix = await setup();
    await chiefDrafts(fix);
    await speak(fix, fix.chief, '有 2 项需要你定', { outcome: 'needs_owner' });
    expect(fix.ctx.store.table('bots').get(fix.chief.id)!.activity).toBe('waiting_owner');
    await ownerSays(fix, fix.chief.id, '定了');
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open')).toEqual([]);
    // 总管接着开工、正常交账之后，状态恢复为关注中，不残留「在等主人」。
    await speak(fix, fix.chief, '已安排，11-18 上线', { outcome: 'progress' });
    expect(fix.ctx.store.table('bots').get(fix.chief.id)!.activity).not.toBe('waiting_owner');
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open')).toEqual([]);
  });

  it('反例：普通员工 needs_owner 不带 ownerQuestion 仍被拒', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.wang.id, '帮我看看');
    const result = await commitAs(fix, fix.wang, { outcome: 'needs_owner', reply: '要你定', ownerQuestion: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('needs_owner 必须填写给主人提问');
  });

  it('反例：总管名下没有待确认约定时，needs_owner 不带 ownerQuestion 被拒，带 ownerQuestion 正常生成提问卡', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我看看');
    const bad = await commitAs(fix, fix.chief, { outcome: 'needs_owner', reply: '要你定', ownerQuestion: null });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('needs_owner 必须填写给主人提问');
    const good = await commitAs(fix, fix.chief, { outcome: 'needs_owner', reply: '要你定', ownerQuestion: QUESTION });
    expect(good.ok).toBe(true);
    expect(openNonAgreementItems(fix)).toHaveLength(1);
    expect(openNonAgreementItems(fix)[0]).toMatchObject({ type: 'question', title: QUESTION.text });
  });

  it('守则第 2 条补了「needs_owner、不填 ownerQuestion」', () => {
    expect(CHIEF_RULES_TEXT).toContain('对齐的回合交账时 outcome 写 needs_owner，不填 ownerQuestion，约定卡就是给主人的提问。');
  });
});

describe('J2 派活工具按名字找人', () => {
  // P74b：派活只有 hub_job_manage 一条路，所以原来用 hub_handoff 的这条改用它（意图不变：只用唤醒包里的信息就能派活，对方被叫醒）。
  it('只用唤醒包里给出的信息就能派活：包里写着名字和做法，hub_job_manage 的 executor 写名字成功，对方收到唤醒', async () => {
    const fix = await setup();
    const packet = await lockedAndAwake(fix);
    expect(packet).toContain('当前在岗的员工：小王（执行，在办 0 件）、小李（执行，在办 0 件）。');
    expect(packet).toContain('安排开工：调用 hub_job_manage，mode 写 assign，agreementId 写上面那份约定的编号，executor 写员工名字，reviewer 写评审员名字或「总管」，dueAt 写交付时间，deliveryItems 只写「怎样算做完」里写了交付时间的那一条的序号（通常只有一条，没有就不写；其余条目都要有证据并经过核对），launchStep 不用填：验收之后有没有对外发布这一步，由约定里的对外发布一项（launch）决定。');
    const agreementId = /agreementId 为 (agr_[a-z0-9]{10})/.exec(packet)![1]!;
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'assign', agreementId, executor: '小王', reviewer: '总管', dueAt: '2026-11-17 18:00', launchStep: false });
    expect(result.ok).toBe(true);
    const job = fix.ctx.store.table('jobs').list()[0]!;
    expect(job).toMatchObject({ chiefId: fix.chief.id, executorId: fix.wang.id, agreementId });
    // 小王被叫醒：已经有唤醒单，或排在队列里。
    const woken = fix.ctx.store.table('wakes').count(row => row.botId === fix.wang.id) + fix.ctx.store.table('queue').count(row => row.botId === fix.wang.id);
    expect(woken).toBeGreaterThan(0);
  });

  it('hub_send 的 to 写名字成功，邮件按机器人 id 记账', async () => {
    const fix = await setup();
    await lockedAndAwake(fix);
    const result = await callTool(fix, fix.chief, 'hub_send', { to: '小李', text: '请先看一下约定' });
    expect(result.ok).toBe(true);
    expect(fix.ctx.store.table('mail').list()[0]).toMatchObject({ from: fix.chief.id, to: fix.li.id });
  });

  it('名字首尾有空白也能找到', async () => {
    const fix = await setup();
    await lockedAndAwake(fix);
    expect((await callTool(fix, fix.chief, 'hub_send', { to: '  小李 ', text: '你好' })).ok).toBe(true);
  });

  it('用 id 仍然可用（hub_send、hub_job_manage）', async () => {
    const fix = await setup();
    const packet = await lockedAndAwake(fix);
    const agreementId = /agreementId 为 (agr_[a-z0-9]{10})/.exec(packet)![1]!;
    expect((await callTool(fix, fix.chief, 'hub_send', { to: fix.wang.id, text: '你好' })).ok).toBe(true);
    expect((await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'assign', agreementId, executor: fix.li.id, dueAt: '2026-11-17 18:00', launchStep: false })).ok).toBe(true);
  });

  it('名字不存在：报错并列出在岗的员工（总管自己不列）', async () => {
    const fix = await setup();
    await lockedAndAwake(fix);
    const agreementId = fix.ctx.store.table('agreements').list()[0]!.id;
    // P74b：hub_handoff 换成 hub_job_manage（指人的参数叫 executor）。
    for (const name of ['hub_send', 'hub_job_manage']) {
      const field = name === 'hub_send' ? 'to' : 'executor';
      const args = name === 'hub_send' ? { to: '赵六', text: '你好' } : { mode: 'assign', agreementId, executor: '赵六', dueAt: '2026-11-17 18:00', launchStep: false };
      const result = await callTool(fix, fix.chief, name, args);
      expect(result.ok).toBe(false);
      expect(result.error).toBe(`${field}：没有叫「赵六」的员工。在岗的员工：小王（执行）、小李（执行）。写名字即可`);
    }
  });

  it('名字不存在且一位在岗员工也没有：写明目前没有', async () => {
    const fix = await setup();
    await lockedAndAwake(fix);
    fix.ctx.store.table('bots').patch(fix.wang.id, { lifecycle: 'paused' });
    fix.ctx.store.table('bots').patch(fix.li.id, { lifecycle: 'retired' });
    const result = await callTool(fix, fix.chief, 'hub_send', { to: '赵六', text: '你好' });
    expect(result.error).toBe('to：没有叫「赵六」的员工。目前没有在岗的员工');
  });

  it('同名两位：拒绝，列出每位的 id 和角色，要求改用 id；改用 id 后成功', async () => {
    const fix = await setup();
    const packet = await lockedAndAwake(fix);
    const agreementId = /agreementId 为 (agr_[a-z0-9]{10})/.exec(packet)![1]!;
    fix.ctx.store.table('bots').patch(fix.li.id, { name: '小王', role: 'researcher' });
    const base = { mode: 'assign', agreementId, dueAt: '2026-11-17 18:00', launchStep: false };
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { ...base, executor: '小王' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`${fix.wang.id}（执行）`);
    expect(result.error).toContain(`${fix.li.id}（调研）`);
    expect(result.error).toContain('请改用机器人 id');
    expect(fix.ctx.store.table('jobs').count()).toBe(0);
    expect((await callTool(fix, fix.chief, 'hub_job_manage', { ...base, executor: fix.li.id })).ok).toBe(true);
  });

  it('按名字找到但对方已暂停：报「不在岗」，错误里用名字指代对方', async () => {
    const fix = await setup();
    const packet = await lockedAndAwake(fix);
    const agreementId = /agreementId 为 (agr_[a-z0-9]{10})/.exec(packet)![1]!;
    fix.ctx.store.table('bots').patch(fix.wang.id, { lifecycle: 'paused' });
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'assign', agreementId, executor: '小王', dueAt: '2026-11-17 18:00', launchStep: false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('executor：「小王」当前不在岗');
  });

  it('按名字指自己：仍然拒绝', async () => {
    const fix = await setup();
    await lockedAndAwake(fix);
    const result = await callTool(fix, fix.chief, 'hub_send', { to: '老大', text: '自言自语' });
    expect(result.error).toContain('不能给自己');
  });

  it('hub_project_task_upsert 的 assigneeBotId 写名字（对方是项目成员）成功；非成员仍被拒并用名字指代', async () => {
    // P74b：总管不能再把事务指派给别人，这条测「跟进人可写名字」，所以改成项目负责人是小王（非总管，不受这条限制），由他指派。
    const fix = await setup();
    await lockedAndAwake(fix);
    fix.ctx.store.table('projects').patch(fix.project.id, { ownerBotId: fix.wang.id });
    const ok = await callTool(fix, fix.wang, 'hub_project_task_upsert', { projectId: fix.project.id, title: '做页面', assigneeBotId: '小李' });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(fix.ctx.store.table('projectTasks').list()[0]).toMatchObject({ title: '做页面', assigneeBotId: fix.li.id });
    // 把小李移出项目后，按名字指派被拒，报错里是名字。
    fix.ctx.store.table('projects').patch(fix.project.id, { memberBotIds: [fix.chief.id, fix.wang.id] });
    const bad = await callTool(fix, fix.wang, 'hub_project_task_upsert', { projectId: fix.project.id, title: '做测试', assigneeBotId: '小李' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('跟进人必须是项目成员：小李');
  });

  it('三个工具的参数说明都写了「员工名字或机器人 id」', async () => {
    const fix = await setup();
    for (const name of ['hub_send', 'hub_job_manage', 'hub_project_task_upsert']) {
      const tool = fix.hub.tools().find(item => item.name === name)!;
      expect(tool.description).toContain('员工名字或机器人 id');
    }
  });
});

describe('J3 说明文字与可为空字段', () => {
  it('草图的 mark 在页面块、流程步骤、概念节点三处都有参数说明', async () => {
    const fix = await setup();
    const tool = fix.hub.tools().find(item => item.name === 'hub_agreement_submit')!;
    const text = JSON.stringify(tool.jsonSchema);
    const hint = '这个元素对应第几个待定项（从 1 起，1 表示 pending 的第一项）；与待定项无关的元素不要写';
    expect(text.split(hint).length - 1).toBeGreaterThanOrEqual(3);
  });

  it('总管守则末尾有一条：写给主人看的话不写工具名、机器人 id、议程编号', () => {
    expect(CHIEF_RULES_TEXT).toContain('9. 写给主人看的 reply、report、blocker 不写工具名、机器人 id、议程编号等内部名称，用主人看得懂的说法。');
    // P73d：第 9 条之后追加了第 10 条（组队卡等确认期间），所以守则末尾现在是第 10 条；第 9 条紧挨在它前面。
    expect(CHIEF_RULES_TEXT).toContain('用主人看得懂的说法。\n10. 组队卡等主人确认期间');
    // P74e：第 10 条之后又追加了第 11 条（执行中的事），所以守则末尾现在是第 11 条；第 10 条的结尾紧挨着它。
    expect(CHIEF_RULES_TEXT).toContain('这件事由你自己完成。\n11. 执行中的事');
    // P74f：第 11 条之后追加了第 12 条（交付和验收由中心完成），守则末尾现在是第 12 条。
    expect(CHIEF_RULES_TEXT).toContain('核对从新的三轮算起）。\n12. 交付和验收由中心完成');
    // P74f-2：第 12 条补上最后一句（escalate 已存在）。
    expect(CHIEF_RULES_TEXT).toContain('用 mode escalate 交给主人决定，不要用 ownerQuestion；说明之后交账写 blocked，不写 needs_owner。\n13. ');
    // P75c：第 12 条之后追加第 13 条第一段（记住），守则末尾现在是第 13 条的这一段。
    expect(CHIEF_RULES_TEXT).toContain('拿不准时只改这一次，reply 末尾加一句「要我以后都这样吗」。');
    // P75d：第 13 条第一段之后追加删改一句，守则末尾是这一句。
    // P75r1：在「拿不准时……」之后、「主人要删掉或改掉……」之前，逐字加入「约定里改了引用内容只改这份约定」一句。
    expect(CHIEF_RULES_TEXT).toContain('拿不准时只改这一次，reply 末尾加一句「要我以后都这样吗」。主人改了约定里一条引用规矩、偏好或先例的内容时，只改这份约定，不动那一条记忆；reply 末尾同样加一句「要我以后都这样吗」，主人说是，再用 mode correct 改那一条。主人要删掉或改掉记住的某条');
    // P75i：第 13 条末尾逐字追加 teach 一句，守则末尾现在是这一句；上一句（删改）紧挨在它前面，原文一字未动。
    expect(CHIEF_RULES_TEXT).toContain('主人要删掉或改掉记住的某条，用 mode forget 或 correct，memoryId 见「可引用的出处」。主人要某位员工学他在 DSH 里某段会话的做法');
    expect(CHIEF_RULES_TEXT).toContain('主人要某位员工学他在 DSH 里某段会话的做法，调用 hub_skill，mode 写 teach，staff 写员工名字，note 写要学什么；中心会请主人选会话，reply 只写一句「是哪一段？」。');
    // P76q：第 13 条之后追加第 14 条（交付物一律派给队友），守则末尾现在是第 14 条；第 13 条的结尾紧挨着它，原文一字未动。
    expect(CHIEF_RULES_TEXT).toContain('reply 只写一句「是哪一段？」。\n14. 交付物一律派给队友');
    // P88：第 14 条之后追加第 15 条（提到别的事的状态以唤醒包为准），守则末尾现在是第 15 条；第 14 条的结尾紧挨着它，原文一字未动。
    // 原断言：守则以第 14 条结尾（endsWith「没有合适的员工，就告诉主人需要先添加什么角色。」）；新断言：第 14 条结尾紧接第 15 条，守则以第 15 条结尾。
    expect(CHIEF_RULES_TEXT).toContain('没有合适的员工，就告诉主人需要先添加什么角色。\n15. 回复里提到某件事现在的状态');
    expect(CHIEF_RULES_TEXT.trimEnd().endsWith('对话里较早的消息只说明当时的情况，不代表现在。')).toBe(true);
  });

  it('「report：必须是文字」的原因是模型省略了可为空的字段：省略 reply、report、blocker、ownerQuestion 时成功，等同于 null', () => {
    const { blocker: _b, ownerQuestion: _q, reply: _r, report: _p, ...rest } = commitArgs();
    for (const schema of [CommitInputSchema, CommitToolSchema]) {
      const parsed = schema.safeParse(rest);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toMatchObject({ blocker: null, ownerQuestion: null, reply: null, report: null });
    }
  });

  it('省略后经 hub_commit 真正交账成功（中途不报「必须是文字」）', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我看看');
    const { reply: _r, report: _p, blocker: _b, ownerQuestion: _q, ...rest } = commitArgs({ summary: '看过了' });
    const result = await callTool(fix, fix.chief, 'hub_commit', { ...rest, reply: '看过了，没问题' });
    expect(result).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('commits').list()[0]).toMatchObject({ report: null, blocker: null, ownerQuestion: null });
  });

  it('反例：类型不对仍然报错（reply 或 report 传数字、blocker 传数组）', () => {
    for (const patch of [{ report: 5 }, { reply: 5 }, { blocker: ['x'] }, { ownerQuestion: 'x' }]) {
      const parsed = CommitInputSchema.safeParse({ ...commitArgs(), ...patch });
      expect(parsed.success).toBe(false);
    }
    const bad = CommitInputSchema.safeParse({ ...commitArgs(), report: 5 });
    if (!bad.success) expect(bad.error.issues.some(issue => issue.path.join('.') === 'report' && issue.message === '必须是文字')).toBe(true);
  });

  it('省略 blocker 但 outcome 是 blocked：仍然要求说明阻碍', () => {
    const { blocker: _b, ...rest } = commitArgs({ outcome: 'blocked' });
    expect(CommitInputSchema.safeParse(rest).success).toBe(false);
  });
});
