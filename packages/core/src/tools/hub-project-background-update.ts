/**
 * 项目负责人更新项目背景的工具（P60，DC35）：项目背景要跟着项目走，所以不经主人采纳，
 * 由负责人直接写；每次都写文件、留修订、记下谁在什么时候改的，主人在项目页能看到。
 * 只有这个项目的负责人能用，L1 级别（试岗队友也能用）。普通成员没有这个工具的写权限。
 */
import { defineTool } from './common.js';
import { OwnerBackgroundUpdateSchema, updateProjectBackgroundByOwner } from '../project/context-service.js';

export const hubProjectBackgroundUpdate = defineTool('hub_project_background_update',
  '（仅项目负责人）直接更新项目背景（最多 2000 字），不用等主人采纳；项目有实质进展时用，写清现在做到哪、接下来要什么。',
  OwnerBackgroundUpdateSchema, 'L1', async (ctx, tc, args) => {
    const { project, changed } = await updateProjectBackgroundByOwner(ctx, tc.botId, args);
    return { ok: true, text: changed ? `项目「${project.name}」的背景已更新。` : `项目「${project.name}」的背景内容没有变化，没有留新修订。` };
  });
