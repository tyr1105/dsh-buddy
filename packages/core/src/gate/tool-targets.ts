/** 闸门与审批文案共用目标取值，避免同一份参数被检查一个目标、却给主人展示另一个。 */
export const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath', 'filename', 'directory', 'source', 'destination', 'src', 'dest', 'target'] as const;
export const COMMAND_ARGUMENT_KEYS = ['command', 'cmd', 'script'] as const;

/** 文件工具的全部路径别名都参与检查；空字符串也保留，由分类器决定是否可识别。 */
export function pathArguments(args: Record<string, unknown>): string[] {
  return PATH_ARGUMENT_KEYS.flatMap(key => typeof args[key] === 'string' ? [args[key] as string] : []);
}

/** 编辑补丁可能涉及多份文件，正文里的文件头与显式路径同样不能遗漏。 */
export function editTargetPaths(args: Record<string, unknown>): string[] {
  const patch = args.patch ?? args.input;
  return typeof patch === 'string'
    ? [...pathArguments(args), ...[...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1]!)]
    : pathArguments(args);
}

/** 保持宿主命令优先级；不能跳过一个已存在但无效的高优先字段去展示另一个命令。 */
export function selectedCommand(args: Record<string, unknown>): string | null {
  const value = args.command ?? args.cmd ?? args.script;
  return typeof value === 'string' ? value : null;
}

/** 只有完整字符串数组才是闸门认可的 argv，展示时也不擅自过滤坏元素。 */
export function commandArguments(args: Record<string, unknown>): string[] | null {
  return Array.isArray(args.args) && args.args.every(arg => typeof arg === 'string') ? args.args : null;
}

/** 选中的命令连同 argv 优先展示；不同别名原文继续列出，让矛盾参数可见。 */
export function commandTargets(args: Record<string, unknown>): string[] {
  const selected = selectedCommand(args);
  const declared = COMMAND_ARGUMENT_KEYS.flatMap(key => typeof args[key] === 'string' ? [args[key] as string] : []);
  const others = [...new Set(declared)].filter(value => value !== selected);
  return selected === null ? others : [[selected, ...(commandArguments(args) ?? [])].join(' '), ...others];
}
