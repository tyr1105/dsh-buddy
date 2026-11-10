#!/bin/bash
# install-desktop.sh —— 给主人用的桌面版安装脚本（D04 第 2 条；D05 第 3 条加固；P56 改装固定副本）。
# 做五件事：① 确认 DeepSeek Harness 桌面版已完全退出；② 构建插件；③ 把构建产物复制成
# 一份固定副本；④ 用桌面版自带 CLI 把副本以 link: 方式装进 desktop profile；⑤ 打印下一步提示。
#
# 为什么装副本（P56）：link: 指向的目录里文件一变，DSH 约 0.5 秒内就会自动替换正在用的界面，
# 而后台引擎要重启才更新。以前直接链接开发目录，开发时每次构建都会替换桌面版的界面、
# 把中栏踢回对话页。现在链接的是 $HOME/.agent-hub/plugin，只有重新运行本脚本才会变。
#
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
# 固定副本的位置：和入口脚本放在同一个目录，路径里没有空格。
INSTALL_DIR="$HOME/.agent-hub/plugin"

# ① 桌面版在运行时不安装（热挂载行为未实测，见手册 H1；官方流程也是先退出）。
#    规则以 $ 结尾，只认不带参数的桌面版主进程。走查沙箱跑的是同一个程序，但启动时带参数，
#    不能因为开着沙箱就拦住安装（P56）。
if pgrep -f 'DeepSeek Harness\.app/Contents/MacOS/DeepSeek Harness$' >/dev/null 2>&1; then
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

# 收尾：不管脚本在哪一步退出都会执行。
# 下面这些变量先给初值，收尾时才不会因为「变量未定义」再出错。
STAGING_DIR=""   # 正在准备的新副本；换上之后清空
BACKUP_DIR=""    # 暂存的旧副本；安装成功后删除
SWAPPED=0        # 新副本是否已经换到正式位置
INSTALLED=0      # dsh 是否安装成功
BUILD_LOG=""
cleanup() {
  if [ -n "$BUILD_LOG" ]; then rm -f "$BUILD_LOG"; fi
  if [ -n "$STAGING_DIR" ]; then rm -rf "$STAGING_DIR"; fi
  # 换上了新副本但安装没成功：撤掉新副本、放回旧副本，桌面版保持安装前的样子。
  if [ "$SWAPPED" = 1 ] && [ "$INSTALLED" = 0 ]; then
    rm -rf "$INSTALL_DIR"
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then mv "$BACKUP_DIR" "$INSTALL_DIR"; fi
  fi
}
trap cleanup EXIT

# ③ 先构建插件（副本要用到 lib/index.js、lib/client.js）。
#    pnpm 在没有工作区的目录会打印「No projects found」并以 0 退出，必须一并拦下。
echo "[install] 正在构建插件……"
BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/agent-hub-build.XXXXXX")"
if ! (cd "$ROOT" && pnpm --filter @tyr1105/dsh-buddy build) 2>&1 | tee "$BUILD_LOG"; then
  echo "[install] 构建失败。上面的输出是 pnpm 的原始错误。"
  exit 1
fi
if grep -q "No projects found" "$BUILD_LOG"; then
  echo "[install] 构建失败：pnpm 在 $ROOT 下找不到 dsh-buddy 项目（No projects found）。"
  echo "[install] 请确认本脚本位于 agent-hub/scripts/ 目录中，或重新运行 scripts/make-entrypoints.sh 生成入口。"
  exit 1
fi

# ④ 把运行需要的四个文件复制成固定副本（和公开安装包是同一份清单）。
#    先在旁边的临时目录准备好、核对无误，再整体换上，中途出错不会留下半份副本。
COPY_FILES=(package.json cordis.patch.yml lib/index.js lib/client.js)
for file in "${COPY_FILES[@]}"; do
  if [ ! -f "$PLUGIN_DIR/$file" ]; then
    echo "[install] 构建产物不完整：缺少 $PLUGIN_DIR/$file。桌面版没有被改动。"
    exit 1
  fi
done
mkdir -p "$(dirname "$INSTALL_DIR")"
STAGING_DIR="$(mktemp -d "$INSTALL_DIR.new.XXXXXX")"
mkdir -p "$STAGING_DIR/lib"
for file in "${COPY_FILES[@]}"; do
  cp "$PLUGIN_DIR/$file" "$STAGING_DIR/$file"
  # 逐个比对：别的 Agent 可能正好在重新构建，复制到写了一半的文件会让桌面版打不开。
  if ! cmp -s "$PLUGIN_DIR/$file" "$STAGING_DIR/$file"; then
    echo "[install] 复制 $file 时文件发生了变化，可能有别的任务正在构建。桌面版没有被改动，稍后再运行一次。"
    exit 1
  fi
done

# 换上新副本：旧副本先改名留着，dsh 安装失败时由 cleanup 放回去。
if [ -d "$INSTALL_DIR" ]; then
  BACKUP_DIR="$INSTALL_DIR.old.$$"
  mv "$INSTALL_DIR" "$BACKUP_DIR"
fi
SWAPPED=1
mv "$STAGING_DIR" "$INSTALL_DIR"
STAGING_DIR=""

# ⑤ 安装到 desktop profile。失败时原样打印 dsh 的错误，并提示日志位置后退出。
echo "[install] 正在安装到桌面版（desktop profile）……"
if ! "$DSH_CLI" plugin --profile desktop add "link:$INSTALL_DIR"; then
  echo "[install] 安装失败。上面的输出是 dsh 命令的原始错误。"
  echo "[install] 日志位置（本脚本不读取它们）：$HOME/.dsh/logs/"
  exit 1
fi
INSTALLED=1
if [ -n "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR"; fi

# ⑥ 成功提示与下一步。
echo "[install] 安装完成。装的是一份固定副本：$INSTALL_DIR"
echo "[install] 开发时重新构建不会影响桌面版。想更新到最新代码，退出 DSH 后再运行一次这条命令。"
echo "[install] 下一步：打开 DeepSeek Harness，左侧栏会出现「队友」。"
