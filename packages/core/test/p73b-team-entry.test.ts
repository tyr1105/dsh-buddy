/**
 * 守护测试：子路径出口 `@agent-hub/core/team`（入口 src/team/index.ts）要能进浏览器包。
 * 做法：从入口出发，沿相对导入递归收集全部文件，断言
 * - 没有任何以 node: 开头的导入（也没有 fs、path 这类裸名内置模块）；
 * - 没有引用 io/、engine/、store/ 等带副作用或依赖宿主的目录；
 * - package.json 里确实声明了 ./team 出口并指向入口文件。
 * 为什么要守：插件浏览器端的构建一旦被拉进 node 内置模块就会失败，而且是在很晚才暴露。
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = resolve(coreRoot, 'src');
const entry = resolve(srcRoot, 'team/index.ts');

/** 浏览器端不该碰到的 src 子目录（按仓库实际目录定）。 */
const FORBIDDEN_DIRS = ['io', 'engine', 'store', 'api', 'tools', 'sim', 'wake', 'turn', 'commit', 'health', 'peer', 'project', 'office'];
/** 裸名的 node 内置模块。 */
const NODE_BARE = new Set(['fs', 'path', 'os', 'child_process', 'crypto', 'net', 'http', 'https', 'url', 'util', 'stream', 'zlib', 'events', 'buffer']);

/** 取一个文件里全部导入/再导出的模块名（静态 import、export from、动态 import）。 */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const pattern = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    // 只有类型的导入（import type、export type）编译后整句消失，不会进浏览器包，不算。
    if (/^(?:import|export)\s+type[\s{]/.test(match[0])) continue;
    out.push((match[1] ?? match[2] ?? match[3])!);
  }
  return out;
}

/** 从入口沿相对导入收集全部文件，同时收集非相对的导入。 */
function collect(): { files: string[]; bare: Array<{ file: string; spec: string }> } {
  const seen = new Set<string>();
  const bare: Array<{ file: string; spec: string }> = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else bare.push({ file: relative(coreRoot, file), spec });
    }
  }
  return { files: [...seen], bare };
}

describe('@agent-hub/core/team 出口只含纯数据和纯函数', () => {
  const { files, bare } = collect();

  test('能收集到入口和它引用的文件', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain(entry);
  });

  test('没有 node: 开头的导入，也没有裸名的 node 内置模块', () => {
    const bad = bare.filter(item => item.spec.startsWith('node:') || NODE_BARE.has(item.spec));
    expect(bad).toEqual([]);
  });

  test('非相对导入只允许 zod', () => {
    expect([...new Set(bare.map(item => item.spec))].filter(spec => spec !== 'zod')).toEqual([]);
  });

  test('不引用 io、engine、store 等目录', () => {
    const bad = files.map(file => relative(srcRoot, file).split(sep)[0]!).filter(dir => FORBIDDEN_DIRS.includes(dir));
    expect(bad).toEqual([]);
  });

  test('package.json 声明了 ./team 出口并指向入口文件', () => {
    const pkg = JSON.parse(readFileSync(resolve(coreRoot, 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./team']).toBe('./src/team/index.ts');
    expect(resolve(coreRoot, pkg.exports['./team']!)).toBe(entry);
  });
});
