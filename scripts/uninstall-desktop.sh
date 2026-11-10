#!/bin/bash
# uninstall-desktop.sh —— 给主人用的桌面版卸载脚本（D04 第 2 条）。
# 同样先确认桌面版已完全退出，再从 desktop profile 移除 dsh-buddy。
# 中心数据（~/AgentHub）一律保留，不会删除。
set -euo pipefail

# 允许用环境变量 DSH_CLI 覆盖（与 install-desktop.sh 一致，测试用桩替换）。
DSH_CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"

# ① 桌面版在运行时不卸载（与安装同理，见手册 H1）。
#    规则以 $ 结尾，只认不带参数的桌面版主进程，开着走查沙箱不算（P56）。
if pgrep -f 'DeepSeek Harness\.app/Contents/MacOS/DeepSeek Harness$' >/dev/null 2>&1; then
  echo "请先完全退出 DeepSeek Harness（菜单栏 → 退出），再运行本脚本"
  exit 1
fi

# ② 移除插件。失败时原样打印 dsh 的错误，并提示日志位置后退出。
#    dsh plugin 把参数原样交给 pnpm，必须写完整包名（P56：写短名 dsh-buddy 会报「没有这个依赖」）。
echo "[uninstall] 正在从桌面版移除 dsh-buddy……"
if ! "$DSH_CLI" plugin --profile desktop remove @tyr1105/dsh-buddy; then
  echo "[uninstall] 移除失败。上面的输出是 dsh 命令的原始错误。"
  echo "[uninstall] 日志位置（本脚本不读取它们）：$HOME/.dsh/logs/"
  exit 1
fi

# ③ 删掉安装时复制的固定副本（P56）。这里只有构建产物，重新安装会再生成。
rm -rf "$HOME/.agent-hub/plugin"

# ④ 数据保留说明。
echo "[uninstall] 已移除。中心数据保留在 ~/AgentHub，不会删除。"
