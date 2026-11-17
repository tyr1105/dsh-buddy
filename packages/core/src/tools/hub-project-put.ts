/**
 * hub_project_put：把自己家目录里的文件或文件夹复制进自己所在项目的项目文件夹（P69）。
 *
 * 为什么是一个中心工具：DSH 沙箱只让队友写自己的家目录，项目文件夹在沙箱外。
 * 成员往自己项目的文件夹放东西是主人早就给的操作空间，所以这个工具不走审批。
 * 权限、符号链接、硬链接、敏感路径、数量和大小上限都在 project/project-put.ts 里检查，这里只负责登记和参数。
 * L0 只观察，不能调用（minimum 为 L1）；复盘回合只读（在 common.ts 的 reflectionWrites 里登记）。
 */
import { z } from 'zod';
import { projectPut } from '../project/project-put.js';
import { defineTool, getToolBot, requiredText } from './common.js';

export const HubProjectPutInputSchema = z.strictObject({
  from: requiredText.describe('要放进项目的文件或文件夹，必须在你的家目录内；相对路径按家目录算'),
  to: z.string().trim().min(1).optional().describe('放在项目文件夹里的相对路径，可省略，省略时用 from 的最后一段名字'),
  project: z.string().trim().min(1).optional().describe('项目 id，可省略：项目会话里默认当前项目，只在一个项目里时默认那个项目'),
  why: z.string().trim().min(1).max(200).optional().describe('一句话说明为什么放，可省略'),
});

export const hubProjectPut = defineTool('hub_project_put',
  '把你家目录里的一个文件或一个文件夹复制进你所在项目的项目文件夹，不需要主人批准。已有同名文件会被覆盖（项目里的 context.md 由中心维护，不能覆盖），二进制文件原样复制；一次最多 500 个文件、20 MB。符号链接、有多个硬链接的文件、凭据文件和中心维护的文件（mind/、memory/journal/、AGENTS.md）不能放。读项目里或同伴的文件，直接读路径即可。',
  HubProjectPutInputSchema, 'L1', async (ctx, tc, args) => {
    const bot = getToolBot(ctx, tc);
    const result = await projectPut(ctx, bot, tc.wakeId, args);
    return { ok: true, text: result.text };
  });
