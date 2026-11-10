/**
 * P63 主题回合的唤醒包：内容齐全、楼层截断规则、主人原话不被截、不可信标记正确。
 */
import { describe, expect, it } from 'vitest';
import { V2_DEFAULTS } from '../src/config/defaults.js';
import { postThread } from '../src/outreach/thread.js';
import { fitSections, type PacketSection } from '../src/wake/sections.js';
import { byteLength } from '../src/util/text.js';
import { saveProjectContext } from '../src/project/context-service.js';
import { lastPacket, openTopic, runningWake, speak, topicHub, type TopicHub } from './p63-topic-fixtures.js';

/** 给成员填上员工说明和技能，并写好项目背景。 */
async function richHub(): Promise<TopicHub> {
  const fix = await topicHub();
  const [owner, wang] = fix.bots;
  fix.ctx.store.table('bots').patch(wang!.id, { brief: '擅长写竞品分析，'.repeat(20), dshSkillNames: ['竞品调研'], presetSkillIds: [] });
  fix.ctx.store.table('bots').patch(owner!.id, { brief: '管全局' });
  await saveProjectContext(fix.ctx, { projectId: fix.project.id, background: '这个项目要在年底前做完三份竞品报告。' });
  return fix;
}

describe('P63 主题段内容', () => {
  it('负责人收到：主题名、项目背景、成员（风格、说明摘要、技能）、回复规则、负责人专属要求', async () => {
    const fix = await richHub();
    const [owner] = fix.bots;
    await openTopic(fix, '竞品周报怎么做');
    const packet = lastPacket(fix, owner!);
    expect(packet).toContain('主题「竞品周报怎么做」');
    expect(packet).toContain('这个项目要在年底前做完三份竞品报告');
    expect(packet).toContain('- 小王（执行；员工说明：擅长写竞品分析');
    expect(packet).toContain('技能：竞品调研');
    expect(packet).toContain('- 老大（负责人；你自己；总管；员工说明：管全局）');
    expect(packet).toContain('reply 会直接显示在这个主题里');
    expect(packet).toContain('@ 他的名字');
    expect(packet).toContain('不为说而说');
    expect(packet).toContain('hub_project_task_upsert');
    expect(packet).toContain('hub_project_background_update');
    // 员工说明只放摘要，不把整段带进来。
    expect(packet).not.toContain('擅长写竞品分析，'.repeat(20));
  });

  it('反例：普通成员的包里没有负责人专属要求，改为更新自己的事务', async () => {
    const fix = await richHub();
    const [, wang] = fix.bots;
    await openTopic(fix, '@小王 看下');
    const packet = lastPacket(fix, wang!);
    expect(packet).not.toContain('hub_project_task_upsert');
    expect(packet).not.toContain('hub_project_background_update');
    expect(packet).toContain('hub_task_update');
  });

  it('列出未结束的事务，已完成的不列', async () => {
    const fix = await richHub();
    const [owner, wang] = fix.bots;
    const now = fix.ctx.clock.now();
    for (const [index, status] of (['doing', 'accepted'] as const).entries()) {
      fix.ctx.store.table('projectTasks').put({ id: `pt_000000000${index}`, projectId: fix.project.id, title: `事务${status}`, detail: '',
        assigneeBotId: wang!.id, status, wakeIds: [], artifactIds: [], createdAt: now, updatedAt: now, dueAt: null });
    }
    await openTopic(fix, '进展如何');
    const packet = lastPacket(fix, owner!);
    expect(packet).toContain('事务doing｜小王｜进行中');
    expect(packet).not.toContain('事务accepted');
  });

  it('主题回合不再带项目任务段和共享上下文摘要，普通回合不受影响', async () => {
    const fix = await richHub();
    const [owner] = fix.bots;
    await openTopic(fix, '开工');
    const packet = lastPacket(fix, owner!);
    expect(packet).not.toContain('## 项目共享上下文');
    expect(packet).not.toContain('## 你手上的项目任务');
  });
});

describe('P63 楼层截断', () => {
  it('单楼最多 400 字；首楼永远保留；放不下时省略中间的旧楼层', async () => {
    const fix = await topicHub();
    const [owner, wang] = fix.bots;
    const topicId = await openTopic(fix, '首楼标记ABCDE');
    await speak(fix, owner!, '收到');
    // 往主题里塞很多长楼层，超过楼层段的总预算。
    for (let index = 0; index < 20; index += 1) {
      postThread(fix.ctx, { thread: topicId, from: wang!.id, kind: 'reply', text: `第${index}楼${'字'.repeat(600)}` });
    }
    await fix.hub.api.sendMessage(topicId, '继续');
    const packet = lastPacket(fix, owner!);
    expect(packet).toContain('首楼标记ABCDE');
    expect(packet).toContain('第19楼');
    expect(packet).toContain('（中间省略');
    expect(packet).not.toContain('字'.repeat(401));
    expect(packet).toContain('字'.repeat(390));
    expect(packet).not.toContain('第0楼');
  });

  it('楼层段总字节受上限约束', async () => {
    const fix = await topicHub();
    const [owner, wang] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    await speak(fix, owner!, '收到');
    for (let index = 0; index < 30; index += 1) postThread(fix.ctx, { thread: topicId, from: wang!.id, kind: 'reply', text: `第${index}楼${'字'.repeat(300)}` });
    await fix.hub.api.sendMessage(topicId, '继续');
    const floors = lastPacket(fix, owner!).split('## 主题楼层')[1]!.split('## 本次上限')[0]!;
    expect(byteLength(floors)).toBeLessThanOrEqual(V2_DEFAULTS.TOPIC_PACKET_FLOORS_MAX_BYTES + 300);
  });

  it('最新主人原话一字不截，哪怕比整包预算还长', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    await speak(fix, owner!, '收到');
    const long = `长${'内容'.repeat(1500)}尾巴`;
    expect(byteLength(long)).toBeGreaterThan(fix.ctx.settings.wakePacketMaxBytes);
    expect((await fix.hub.api.sendMessage(topicId, long)).ok).toBe(true);
    const packet = lastPacket(fix, owner!);
    expect(packet).toContain(long);
    expect(packet).toContain('## 本次上限');
    expect(runningWake(fix.ctx, owner!.id)!.packetBytes).toBeGreaterThan(fix.ctx.settings.wakePacketMaxBytes);
  });

  it('被同伴点名的人也能看到最新主人原话', async () => {
    const fix = await topicHub();
    const [, wang, li] = fix.bots;
    await openTopic(fix, '@小王 主人原话在这里，只给小王看的第一句');
    await speak(fix, wang!, '@小李 你也看看');
    const packet = lastPacket(fix, li!);
    expect(packet).toContain('## 主人对你说');
    expect(packet).toContain('主人原话在这里，只给小王看的第一句');
  });

  it('别的主题的主人原话不会串进来', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await openTopic(fix, '主题甲的内容');
    await speak(fix, owner!, '收到');
    await openTopic(fix, '主题乙的内容');
    const packet = lastPacket(fix, owner!);
    expect(packet).toContain('主题乙的内容');
    expect(packet).not.toContain('主题甲的内容');
  });
});

describe('P63 fitSections 主人原话优先保留', () => {
  const section = (key: string, title: string, body: string): PacketSection => ({ key, title, body });
  const owner = `主人说的话${'要'.repeat(200)}`;

  it('其他段超预算时先被压缩，主人原话不被截', () => {
    const out = fitSections([
      section('header', '', '头'),
      section('owner', '## 主人对你说', owner),
      section('goals', '## 目标', '目'.repeat(1000)),
      section('rules', '## 规矩', '规矩正文'),
      section('limits', '## 本次上限', '上限正文'),
    ], 1600, 10, 5);
    expect(out).toContain(owner);
    expect(out).toContain('规矩正文');
    expect(out).toContain('上限正文');
    expect(byteLength(out)).toBeLessThanOrEqual(1600);
  });

  it('主题的固定规则永不截断；项目情况和楼层先于主人原话被压缩', () => {
    const out = fitSections([
      section('owner', '## 主人对你说', owner),
      section('topic-rules', '## 主题规则', '规则正文一字不能少'),
      section('topic', '## 项目情况', '成'.repeat(800)),
      section('topic-floor-first', '', `首楼${'甲'.repeat(300)}`),
      section('topic-floor', '', `后面的楼${'乙'.repeat(300)}`),
      section('limits', '', '上限'),
    ], 1300, 10, 5);
    expect(out).toContain(owner);
    expect(out).toContain('规则正文一字不能少');
    expect(out).toContain('首楼');
    expect(byteLength(out)).toBeLessThanOrEqual(1300);
  });

  it('实在放不下时才动主人原话，整包仍不超预算', () => {
    const out = fitSections([section('owner', '## 主人对你说', owner.repeat(10)), section('limits', '', '上限')], 800, 10, 5);
    expect(byteLength(out)).toBeLessThanOrEqual(800);
    expect(out).toContain('主人说的话');
  });
});
