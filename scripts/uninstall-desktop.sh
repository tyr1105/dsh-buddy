#!/bin/bash
# uninstall-desktop.sh —— 给主人用的桌面版卸载脚本（D04 第 2 条）。
# 同样先确认桌面版已完全退出，再从 desktop profile 移除 dsh-buddy。
# 中心数据（~/AgentHub）一律保留，不会删除。
set -euo pipefail

# 允许用环境变量 DSH_CLI 覆盖（与 install-desktop.sh 一致，测试用桩替换）。
DSH_CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"

# ① 桌面版在运行时不卸载（与安装同理，见手册 H1）。
if pgrep -f "DeepSeek Harness.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "请先完全退出 DeepSeek Harness（菜单栏 → 退出），再运行本脚本"
  exit 1
fi

# ② 移除插件。失败时原样打印 dsh 的错误，并提示日志位置后退出。
echo "[uninstall] 正在从桌面版移除 dsh-buddy……"
if ! "$DSH_CLI" plugin --profile desktop remove dsh-buddy; then
  echo "[uninstall] 移除失败。上面的输出是 dsh 命令的原始错误。"
  echo "[uninstall] 日志位置（本脚本不读取它们）：$HOME/.dsh/logs/"
  exit 1
fi

# ③ 数据保留说明。
echo "[uninstall] 已移除。中心数据保留在 ~/AgentHub，不会删除。"
