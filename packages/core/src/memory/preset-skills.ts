/**
 * 预置 skill 的物化与清理。
 *
 * 物化：把主人勾选的预置项写成队友家目录下的 `.agents/skills/<id>/SKILL.md`，
 * 让队友在宿主里真的能看到这份 skill；内容来自代码内置清单，不读用户数据、不联网。
 * 清理：只删除带中心标记（`<!-- dsh-buddy:preset-skill:<id> -->`）的文件，
 * 队友自建的同名 skill 或改过的文件一律不碰——取消勾选不等于替队友删东西。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/index.js';
import {
  PRESET_SKILLS, PRESET_SKILL_DIR, presetSkillMarker, presetSkillsFor, renderPresetSkillFile,
} from '../config/preset-skills.js';

/** 单个预置 skill 的固定落点，目录名就是清单里的 id。 */
export function presetSkillPath(bot: Bot, id: string): string {
  return posix.join(bot.homeDir, PRESET_SKILL_DIR, id, 'SKILL.md');
}

/**
 * 把队友的预置 skill 同步到磁盘：
 * - 已勾选的项：内容不同才重写（避免每次档案保存都刷盘）；
 * - 已取消的项：文件带中心标记才删除，并顺手尝试删空目录。
 * 返回实际写入/删除的 id，供测试与排查使用。
 */
export async function syncPresetSkills(ctx: HubContext, bot: Bot): Promise<{ written: string[]; removed: string[] }> {
  const selected = presetSkillsFor(bot.presetSkillIds);
  const selectedIds = new Set(selected.map(skill => skill.id));
  const written: string[] = [];
  for (const skill of selected) {
    const path = presetSkillPath(bot, skill.id);
    const content = renderPresetSkillFile(skill);
    // 内容已一致就不写，避免无意义的文件修改时间变化。
    if (await ctx.fs.readText(path) === content) continue;
    await ctx.fs.mkdirp(posix.dirname(path), { within: bot.homeDir });
    await ctx.fs.writeTextAtomic(path, content, { within: bot.homeDir });
    written.push(skill.id);
  }
  const removed: string[] = [];
  for (const skill of PRESET_SKILLS) {
    if (selectedIds.has(skill.id)) continue;
    const path = presetSkillPath(bot, skill.id);
    const existing = await ctx.fs.readText(path);
    // 没有文件，或文件不是中心写的那份（队友自建/改写）都保持原样。
    // 新文件的标记排在 YAML 头后面，旧文件在第一行，所以这里按「包含」判断。
    if (existing === null || !existing.includes(presetSkillMarker(skill.id))) continue;
    await ctx.fs.remove(path, { within: bot.homeDir });
    // remove 是递归删除，目录里还有队友自己的文件时不能调用，所以先确认目录已空。
    try {
      const folder = posix.dirname(path);
      if ((await ctx.fs.list(folder)).length === 0) await ctx.fs.remove(folder, { within: bot.homeDir });
    } catch { /* 目录删不掉不影响主流程 */ }
    removed.push(skill.id);
  }
  return { written, removed };
}
