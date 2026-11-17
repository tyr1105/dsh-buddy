/**
 * 工具 hub_memory（P75c 起）：总管「记住」主人以后都适用的规矩或偏好；P75d 加入删掉、改掉记住的某条。
 * 三个 mode：note（记住）、forget（删掉，参数 memoryId）、correct（改掉，参数 memoryId、text）。
 *
 * 工具层只做两件事：校验参数（平铺对象、根节点不用联合类型，tools/json-schema.ts 的要求；错误信息中文、点出字段）、
 * 调用 memory/ 下对应的服务。每个 mode 只认自己的字段，放错 mode 的字段直接报错。
 * 身份（只有总管）、回合（必须主人发话叫醒）、触发词、名字能否找到等检查都在服务层。
 * 工具注册给所有员工，非总管调用时在服务层被拒绝（与 hub_job_manage、hub_agreement_submit 同一做法）。
 * 复盘回合禁止调用：在 tools/common.ts 的 reflectionWrites 里登记。
 */
import { z } from 'zod';
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import { runMemoryCorrect, runMemoryForget } from '../memory/forget.js';
import { runMemoryNote } from '../memory/note.js';
import { defineTool } from './common.js';

/** 带长度范围的一段文字：去首尾空白，1 到 max 字（按完整字符计）。 */
function limited(max: number, label: string) {
  return z.string({ error: `${label}：必须是文字` }).trim().min(1, `${label}：不能为空`)
    .refine(value => [...value].length <= max, `${label}：不能超过 ${max} 字`);
}

/** 各 mode 允许的字段；其余字段出现即报错。 */
const MODE_FIELDS: Record<'note' | 'forget' | 'correct', readonly string[]> = {
  note: ['mode', 'kind', 'text', 'example', 'staff', 'projects'],
  forget: ['mode', 'memoryId'],
  correct: ['mode', 'memoryId', 'text'],
};
/** 各 mode 必填的字段。 */
const MODE_REQUIRED: Record<'note' | 'forget' | 'correct', readonly string[]> = {
  note: ['kind', 'text'], forget: ['memoryId'], correct: ['memoryId', 'text'],
};

export const HubMemoryInputSchema = z.strictObject({
  mode: z.enum(['note', 'forget', 'correct'], { error: 'mode：必须是 note、forget、correct 之一' })
    .describe('note 记住主人以后都适用的规矩或偏好；forget 删掉记住的某条；correct 改掉记住的某条'),
  kind: z.enum(['rule', 'preference'], { error: 'kind：必须是 rule 或 preference' }).optional()
    .describe('只用于 note：rule 是做法；preference 是主人喜欢怎样被汇报、怎样交付'),
  text: limited(D.TEXT_MAX_CHARS, 'text').optional()
    .describe(`note 与 correct 用：用一句话写记住了什么（correct 写改成什么），不超过 ${D.TEXT_MAX_CHARS} 字`),
  example: z.string({ error: 'example：必须是文字' }).trim()
    .refine(value => [...value].length <= D.EXAMPLE_MAX_CHARS, `example：不能超过 ${D.EXAMPLE_MAX_CHARS} 字`).optional()
    .describe(`只用于 note：写一个例子，不超过 ${D.EXAMPLE_MAX_CHARS} 字；kind 为 rule 时必填`),
  staff: z.string({ error: 'staff：必须是文字' }).trim().optional()
    .describe('只用于 note：适用的员工名字，多个用顿号隔开；主人没说就写「全部」'),
  projects: z.string({ error: 'projects：必须是文字' }).trim().optional()
    .describe('只用于 note：适用的项目名，多个用顿号隔开；主人没说就写「全部」'),
  memoryId: z.string({ error: 'memoryId：必须是文字' }).trim().min(1, 'memoryId：不能为空').optional()
    .describe('forget 与 correct 用：要删或改的那一条的编号，见约定段的「可引用的出处」'),
}).superRefine((value, context) => {
  // 每个 mode 只认自己的字段：放错 mode 的字段报错；必填的没写也报错（错误信息中文、点出字段）。
  const allowed = MODE_FIELDS[value.mode];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) context.addIssue({ code: 'custom', path: [key], message: `${key}：mode 为 ${value.mode} 时不用写这一项` });
  }
  for (const key of MODE_REQUIRED[value.mode]) {
    if ((value as Record<string, unknown>)[key] === undefined) context.addIssue({ code: 'custom', path: [key], message: `${key}：mode 为 ${value.mode} 时必须写` });
  }
});

/** 工具说明：模型看到的全部使用规则（逐字，任务卡第 4 节；最后一句为 P75d 追加）。 */
const DESCRIPTION = '（仅总管）记住主人以后都适用的规矩或偏好。mode 写 note；kind 写 rule（做法）或 preference（喜欢怎样被汇报、怎样交付）；text 用一句话写记住了什么；example 写一个例子（rule 必填）；staff 写适用的员工名字，没说就写「全部」；projects 写适用的项目名，没说就写「全部」。只能在主人发话叫醒的回合里用；中心从主人这次说的话里取原文，主人的话里没有「以后」「每次」这类说法的不能记。主人要删掉或改掉记住的某条：mode forget（memoryId）或 mode correct（memoryId、text），memoryId 见约定段的『可引用的出处』。';

export const hubMemory = defineTool('hub_memory', DESCRIPTION, HubMemoryInputSchema, 'L1', async (ctx, tc, args) => {
  switch (args.mode) {
    // 字段是否齐全已在上面的 superRefine 里校验过，所以这里的非空断言是安全的。
    case 'note': return { ok: true, text: await runMemoryNote(ctx, tc, { kind: args.kind!, text: args.text!, example: args.example, staff: args.staff, projects: args.projects }) };
    case 'forget': return { ok: true, text: await runMemoryForget(ctx, tc, { memoryId: args.memoryId! }) };
    case 'correct': return { ok: true, text: await runMemoryCorrect(ctx, tc, { memoryId: args.memoryId!, text: args.text! }) };
  }
});
