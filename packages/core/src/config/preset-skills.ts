/**
 * 队友可选预置 skill 的内置清单（界面上叫「队友自带」）。
 *
 * 为什么放在 config 而不是用户数据里：这些内容随插件版本发布，只读、不可运行时下载；
 * 主人能选的只是「给这个队友开哪几项」，改动的是 Bot.presetSkillIds 这个引用列表。
 *
 * P55 起文件按 DSH 官方格式写到家目录 .agents/skills/<id>/SKILL.md，开头带 name 和 description。
 * 这样它们就是真正的 DSH 技能：只有这位队友的工作目录看得到，什么时候读由 DSH 的技能目录告诉模型。
 * 清单分两类：通用（任何队友都适合）和岗位专属（P52 模板库配套，内容在 role-preset-skills.ts）。
 */
import { ROLE_PRESET_SKILLS } from './role-preset-skills.js';

/** 这项技能给谁用：general 任何队友都适合；role 是某个岗位专属，选择界面里默认收起。 */
export type PresetSkillAudience = 'general' | 'role';

/** 一个只读预置 skill：id 同时是目录名，必须是安全的小写短横线标识。 */
export interface PresetSkill {
  id: string;
  name: string;
  /** 一句话用途，界面与 DSH 技能目录共用；不写成长篇说明。 */
  purpose: string;
  /** 不写就是通用；只影响选择界面的分组，不影响物化和唤醒。 */
  audience?: PresetSkillAudience;
  /** SKILL.md 正文（物化时再加统一标记与标题）。 */
  content: string;
}

/**
 * 内置预置清单：前 4 条是通用项；后面接岗位专属项，界面里默认收起，不会变成一大片。
 * 内容只讲做事方法，不涉及权限：不会因此多出任何工具、审批豁免或数据可见范围。
 */
export const PRESET_SKILLS: readonly PresetSkill[] = [
  {
    id: 'owner-brief',
    name: '给主人的简报',
    purpose: '汇报先把结论写在第一句，再补证据与下一步，避免主人从头读。',
    content: [
      '交账或回复主人时，按这个顺序写：',
      '',
      '1. 第一句给结论：做成了什么、没做成什么，不用铺垫。',
      '2. 第二段给证据：文件位置、命令结果或链接，能验证的放前面。',
      '3. 第三段给下一步：还需要主人做什么，或你打算什么时候再跟进。',
      '',
      '没有进展就直说没有进展，不要用忙碌的过程冒充结果。',
      '这份偏好不改变审批、权限和事实要求。',
    ].join('\n'),
  },
  {
    id: 'project-handoff',
    name: '项目交接核对',
    purpose: '在项目里动手前先核对共享上下文、交接目录与待领清单，避免重复劳动。',
    content: [
      '在项目里开始一件活之前，先做三步核对：',
      '',
      '1. 读项目共享上下文：背景、约定、已定决策、术语表，按同一套前提干活。',
      '2. 看 shared/ 交接目录：有没有别人已经做过的半成品或交接说明。',
      '3. 看待领与在做清单：这件事是不是已经有人领了；有就换一件或先沟通。',
      '',
      '做完后把可交付物放进项目 sharedDir，并在交账里写清位置。',
      '这份偏好不改变资料可见性与审批要求。',
    ].join('\n'),
  },
  {
    id: 'incident-triage',
    name: '异常排查四步',
    purpose: '遇到异常按「确认现象、定位范围、找最近变化、给下一步」推进，不猜结论。',
    content: [
      '排查类任务按四步走，每一步都要留下可复查的证据：',
      '',
      '1. 确认现象：什么时间、什么位置、影响面多大；先把原始报错或数据抄下来。',
      '2. 定位范围：最近一次正常是什么时候，从哪一层开始不对。',
      '3. 找最近变化：配置、依赖、数据、发布，哪一项和异常时间吻合。',
      '4. 给下一步：能修就修；不能修就写清需要谁、要什么权限、预计什么时候有结论。',
      '',
      '查不到就写查不到，不要用「可能是」下结论。',
      '这份偏好不提高任何工具权限。',
    ].join('\n'),
  },
  {
    id: 'data-check',
    name: '数据核对清单',
    purpose: '交付数字前先核对口径、时间范围与总量，避免把错数送给主人。',
    content: [
      '交付任何数字前，先自己核对四件事：',
      '',
      '1. 口径：这个指标的定义和上次一致吗，比较的是同一批对象吗。',
      '2. 时间范围：起止时间、时区、是否含当天，写清楚。',
      '3. 总量：分项加起来等于总数吗，异常波动能不能解释。',
      '4. 来源：数字来自哪个文件或查询，把位置写进交账。',
      '',
      '对不上就先把差异写出来，不要挑一个好看的数字交差。',
      '这份偏好不改变数据可见范围与审批要求。',
    ].join('\n'),
  },
  ...ROLE_PRESET_SKILLS,
];

/** 界面用的只读选项（不含正文）：向导与档案页据此渲染勾选列表。 */
export interface PresetSkillOption {
  id: string; name: string; purpose: string;
  /** 岗位专属项在选择界面里默认收起；旧夹具没有这个字段，按通用项处理。 */
  audience?: PresetSkillAudience;
}

/** 把清单整理成界面选项；正文只留在代码里，不随视图发给界面。 */
export function presetSkillOptions(): PresetSkillOption[] {
  return PRESET_SKILLS.map(skill => ({ id: skill.id, name: skill.name, purpose: skill.purpose,
    audience: skill.audience ?? 'general' }));
}

/** 按 id 查预置项；未知 id 返回 null（旧存档里可能残留已下线的 id）。 */
export function presetSkillById(id: string): PresetSkill | null {
  return PRESET_SKILLS.find(skill => skill.id === id) ?? null;
}

/** 过滤出仍然存在的预置项，保持清单顺序；用于界面与唤醒包。 */
export function presetSkillsFor(ids: readonly string[]): PresetSkill[] {
  const wanted = new Set(ids);
  return PRESET_SKILLS.filter(skill => wanted.has(skill.id));
}

/** 找出清单里没有的 id，交给入口校验报中文错误。 */
export function unknownPresetSkillIds(ids: readonly string[]): string[] {
  return ids.filter(id => presetSkillById(id) === null);
}

/** 去掉重复 id 并保持第一次出现的顺序，避免同一项被物化两次。 */
export function normalizePresetSkillIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** 物化目录：队友家目录下的固定位置（创建家目录时已建好这一层）。 */
export const PRESET_SKILL_DIR = '.agents/skills';

/** 中心写入标记：清理时只删带这个标记的文件，队友自建的 skill 一律不碰。 */
export function presetSkillMarker(id: string): string {
  return `<!-- dsh-buddy:preset-skill:${id} -->`;
}

/**
 * 渲染要写入的 SKILL.md。
 * DSH 要求文件开头是带 name 和 description 的 YAML 头，少了会被跳过，所以中心标记排在它后面。
 * description 用 JSON 字符串写，引号和冒号都不会破坏 YAML；中文名和用途给模型看，判断什么时候该读。
 * user-invocable 关掉：这是给队友自己用的，主人不需要用斜杠命令调用。
 */
export function renderPresetSkillFile(skill: PresetSkill): string {
  return [
    '---',
    `name: ${skill.id}`,
    `description: ${JSON.stringify(`${skill.name}：${skill.purpose}`)}`,
    'user-invocable: false',
    '---',
    presetSkillMarker(skill.id),
    `# ${skill.name}`,
    '',
    skill.purpose,
    '',
    skill.content,
    '',
  ].join('\n');
}
