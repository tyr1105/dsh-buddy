#!/bin/bash
# install-desktop.sh —— 给主人用的桌面版安装脚本（D04 第 2 条；D05 第 3 条加固）。
# 做四件事：① 确认 DeepSeek Harness 桌面版已完全退出；② 构建插件；③ 用桌面版自带
# CLI 把插件以 link: 方式装进 desktop profile；④ 打印下一步提示。
# 本脚本按自身位置推算项目根（它一直留在 agent-hub/scripts/ 里，推算永远正确）。
# 主人运行的是 $HOME/.agent-hub/install.sh——那是由 scripts/make-entrypoints.sh 生成
# 的极短入口，只做 exec bash "<本脚本的绝对路径>"，不会再按位置推算项目根。
# 失败时原样打印 dsh 的错误，并提示日志位置（只打印路径，绝不读取 ~/.dsh 下的内容）。
set -euo pipefail

# 桌面版自带的 CLI（路径含空格，脚本内部加引号没问题；主人只需跑无空格的入口脚本）。
# 允许用环境变量 DSH_CLI 覆盖——scripts/test-entrypoints.sh 用它把 dsh 换成桩来测试。
DSH_CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"

# 项目根目录：脚本在 agent-hub/scripts/ 下，向上一级就是。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT/packages/plugin"

# ① 桌面版在运行时不安装（热挂载行为未实测，见手册 H1；官方流程也是先退出）。
if pgrep -f "DeepSeek Harness.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "请先完全退出 DeepSeek Harness（菜单栏 → 退出），再运行本脚本"
  exit 1
fi

# ② 确认插件目录真实存在且就是本项目的插件（D05 第 3 条：入口被复制/挪动后
#    ROOT 推算可能指向错误位置，绝不能对不存在的目录继续构建和安装）。
if [ ! -f "$PLUGIN_DIR/package.json" ]; then
  echo "[install] 找不到插件清单：$PLUGIN_DIR/package.json 不存在。"
  echo "[install] 请确认本脚本位于 agent-hub/scripts/ 目录中，或重新运行 scripts/make-entrypoints.sh 生成入口。"
  exit 1
fi
if ! grep -q '"name": *"@tyr1105/dsh-buddy"' "$PLUGIN_DIR/package.json"; then
  echo "[install] $PLUGIN_DIR/package.json 的 name 不是 dsh-buddy，这不是本项目的插件目录。"
  exit 1
fi

# ③ 先构建插件（link 安装要求 lib/index.js、lib/client.js 都在）。
#    pnpm 在没有工作区的目录会打印「No projects found」并以 0 退出，必须一并拦下。
echo "[install] 正在构建插件……"
BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/agent-hub-build.XXXXXX")"
trap 'rm -f "$BUILD_LOG"' EXIT
if ! (cd "$ROOT" && pnpm --filter @tyr1105/dsh-buddy build) 2>&1 | tee "$BUILD_LOG"; then
  echo "[install] 构建失败。上面的输出是 pnpm 的原始错误。"
  exit 1
fi
if grep -q "No projects found" "$BUILD_LOG"; then
  echo "[install] 构建失败：pnpm 在 $ROOT 下找不到 dsh-buddy 项目（No projects found）。"
  echo "[install] 请确认本脚本位于 agent-hub/scripts/ 目录中，或重新运行 scripts/make-entrypoints.sh 生成入口。"
  exit 1
fi

# ④ 安装到 desktop profile。失败时原样打印 dsh 的错误，并提示日志位置后退出。
echo "[install] 正在安装到桌面版（desktop profile）……"
if ! "$DSH_CLI" plugin --profile desktop add "link:$PLUGIN_DIR"; then
  echo "[install] 安装失败。上面的输出是 dsh 命令的原始错误。"
  echo "[install] 日志位置（本脚本不读取它们）：$HOME/.dsh/logs/"
  exit 1
fi

# ⑤ 成功提示与下一步。
echo "[install] 安装完成。"
echo "[install] 下一步：打开 DeepSeek Harness，左侧栏会出现「队友」。"
