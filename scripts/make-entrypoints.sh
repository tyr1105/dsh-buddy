#!/bin/bash
# make-entrypoints.sh —— 总控一次性运行：在 $HOME/.agent-hub/ 下生成给主人用的
# 极短入口脚本 install.sh / uninstall.sh（D05 第 3 条）。
#
# 为什么需要它：主人的终端跑不了带引号/反斜杠/空格路径的命令，安装入口必须放在
# 无空格的 $HOME/.agent-hub/ 下。但把 install-desktop.sh 原样复制过去后，脚本按
# 自身位置推算项目根会得到 $HOME，去构建/链接一个不存在的目录。所以入口不复制
# 脚本本体，只写死项目内脚本的绝对路径并 exec 过去；项目根的推算始终由留在项目
# 里的本体完成，永远正确。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY_DIR="${HOME}/.agent-hub"

mkdir -p "$ENTRY_DIR"

# 生成入口：内容只有一行 exec bash "<项目内脚本绝对路径>" "$@"（路径写死并加引号，
# 空格、中文都不怕）。printf '%q' 会把路径里的空格转义成 shell 安全的形式。
printf '#!/bin/bash\nexec bash %q "$@"\n' "$ROOT/scripts/install-desktop.sh" > "$ENTRY_DIR/install.sh"
printf '#!/bin/bash\nexec bash %q "$@"\n' "$ROOT/scripts/uninstall-desktop.sh" > "$ENTRY_DIR/uninstall.sh"
chmod +x "$ENTRY_DIR/install.sh" "$ENTRY_DIR/uninstall.sh"

echo "[make-entrypoints] 已生成："
echo "  $ENTRY_DIR/install.sh   → $ROOT/scripts/install-desktop.sh"
echo "  $ENTRY_DIR/uninstall.sh → $ROOT/scripts/uninstall-desktop.sh"
echo "[make-entrypoints] 主人只需运行：bash ~/.agent-hub/install.sh（无引号、无空格）。"
