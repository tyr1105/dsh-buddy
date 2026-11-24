#!/usr/bin/env node
/**
 * pack.mjs —— 把构建好的插件整理成「要发出去的那一份」。
 *
 * 运行前先构建：pnpm -r build
 * 用法：node scripts/release/pack.mjs
 *
 * 产出两样东西，都放在 dist/release/ 下（dist/ 已在 .gitignore 里，不会入库）：
 *   1. dist/release/dsh-buddy/      发布目录，共 6 个文件。发布到 npm 用的就是这个目录。
 *   2. dist/release/dsh-buddy.tgz   把上面的目录打成一个压缩包，作为 GitHub 发布页的附件。
 *
 * 为什么需要这个压缩包：插件市场（awesome-dsh-plugin）的条目是从
 *   https://github.com/tyr1105/dsh-buddy/releases/latest/download/dsh-buddy.tgz
 * 安装的。发布页没有这个附件，市场的安装就会失败。
 * 压缩包里的顶层目录必须叫 dsh-buddy/，和以往各版本保持一致。
 *
 * 为什么不直接在 packages/plugin 里发布：那里的 package.json 写着 private（防止误发整个
 * 开发目录），还带着只在开发时有用的 scripts 和 devDependencies。这里生成一份干净的。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 项目根目录 = 本脚本往上两级（scripts/release/ → scripts/ → 项目根）
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const plugin = resolve(root, 'packages/plugin')
const outDir = resolve(root, 'dist/release')
const stage = resolve(outDir, 'dsh-buddy')
const tarball = resolve(outDir, 'dsh-buddy.tgz')

// 发布目录里的 6 个文件：[来源, 在发布目录里的位置]
const files = [
  [resolve(plugin, 'README.md'), 'README.md'],
  [resolve(root, 'LICENSE'), 'LICENSE'],
  [resolve(plugin, 'cordis.patch.yml'), 'cordis.patch.yml'],
  [resolve(plugin, 'lib/index.js'), 'lib/index.js'],
  [resolve(plugin, 'lib/client.js'), 'lib/client.js'],
]

// 先确认来源文件都在。最常见的原因是忘了构建，直接说清楚怎么办。
for (const [from] of files) {
  if (!existsSync(from)) {
    console.error(`[pack] 找不到 ${from}`)
    console.error('[pack] 请先运行 pnpm -r build，再运行本脚本。')
    process.exit(1)
  }
}

// 每次都从空目录开始，避免上一次的旧文件混进来
rmSync(outDir, { recursive: true, force: true })
mkdirSync(resolve(stage, 'lib'), { recursive: true })

// 生成发布用的 package.json：去掉三个只在开发时有用的字段，其余原样保留（包括字段顺序）
const manifest = JSON.parse(readFileSync(resolve(plugin, 'package.json'), 'utf8'))
for (const key of ['private', 'scripts', 'devDependencies']) delete manifest[key]
writeFileSync(resolve(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

for (const [from, to] of files) copyFileSync(from, resolve(stage, to))

// 打包。文件逐个列出，保证压缩包里只有这 6 个文件。
// COPYFILE_DISABLE=1：让 macOS 的 tar 不要把「._xxx」这类附带文件打进去。
const members = ['package.json', ...files.map(([, to]) => to)].map(name => `dsh-buddy/${name}`)
execFileSync('tar', ['-czf', tarball, ...members], {
  cwd: outDir,
  env: { ...process.env, COPYFILE_DISABLE: '1' },
  stdio: 'inherit',
})

// 打印结果，方便在发布日志里核对
console.log(`[pack] 版本 ${manifest.version}`)
console.log(`[pack] 发布目录 ${stage}`)
for (const name of members) {
  const size = statSync(resolve(outDir, name)).size
  console.log(`[pack]   ${String(size).padStart(9)}  ${name}`)
}
console.log(`[pack] 压缩包 ${tarball}（${statSync(tarball).size} 字节）`)
