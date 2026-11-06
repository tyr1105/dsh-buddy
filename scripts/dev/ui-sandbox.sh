#!/bin/bash
# ui-sandbox.sh —— 开一个「能在浏览器里点」的隔离沙箱，用来人工走查「队友」界面。
# （总控写，2026-11-05 从临时目录搬进项目；原名 demo-sandbox.sh）
#
# 它做的事：
#   1. 构建插件，并确保插件已装进沙箱（不是你在用的 DSH，见下面的 DSH_HOME）；
#   2. 清空沙箱里的中心数据，让每次走查都从零开始；
#   3. 拉起走查专用假模型 scripts/dev/fake-model-cards.mjs（端口 18080，不花额度）；
#   4. 以 web 模式启动沙箱 DSH（端口 3951），打印带 token 的网址——用浏览器打开就能走查。
#   按 Ctrl+C 结束，假模型会一起关掉。
#
# 走查时在队友线程里发带暗号的消息即可出对应场景：【提问】【提议】【审批】【慢】（含义见 fake-model-cards.mjs 文件头）。
# 「打断」按钮要点两次（打断 → 确认打断）。
#
# 注意：
#   - 与 `bash scripts/sandbox.sh e2e` 共用 18080 端口和沙箱目录，两者不要同时跑；
#   - 不读写 ~/.dsh（DSH_HOME 指向项目里的 .sandbox/home）；假密钥只在本进程环境里。
set -uo pipefail

# 项目根目录 = 本脚本往上两级（scripts/dev/ → scripts/ → 项目根），挪动项目也不用改
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$ROOT/.sandbox"
DSH_CLI="${DSH_CLI:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
PORT="${UI_SANDBOX_PORT:-3951}"

# 沙箱环境：DSH 的家目录、会话目录都放在项目的 .sandbox 里，和你真实的 DSH 完全隔开
export DSH_HOME="$SANDBOX/home"
export DSH_AGENTS_HOME="$SANDBOX/agents"
export DSH_TELEMETRY_DISABLED=1
# 中心数据放系统临时目录（不放项目里，免得项目的 AGENTS.md 被注入到队友会话里）
export AGENT_HUB_ROOT="${TMPDIR:-/tmp}/agent-hub-sandbox/AgentHub"

# 端口被占就直接退出，并说清楚是谁占的
for p in "$PORT" 18080; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[ui-sandbox] 端口 $p 已被占用（可能 sandbox.sh e2e 或上一次走查还在跑）："
    lsof -nP -iTCP:"$p" -sTCP:LISTEN | tail -n +2
    exit 1
  fi
done

echo "[ui-sandbox] 构建插件……"
(cd "$ROOT" && pnpm --filter dsh-agent-hub build) >/dev/null || { echo "[ui-sandbox] 构建失败，先跑 pnpm --filter dsh-agent-hub build 看错误"; exit 1; }
echo "[ui-sandbox] 确保插件已装进沙箱（重复执行无害）……"
bash "$ROOT/scripts/sandbox.sh" install >/dev/null 2>&1 || { echo "[ui-sandbox] 沙箱安装失败，先跑 bash scripts/sandbox.sh install 看错误"; exit 1; }

rm -rf "$AGENT_HUB_ROOT"   # 每次走查从干净的中心数据开始（这里只有沙箱测试数据）
mkdir -p "$SANDBOX/work"

# 拉起走查专用假模型；脚本结束（含 Ctrl+C）时一并关掉
FAKE_MODEL_LOG="$SANDBOX/fake-model-cards.log" node "$ROOT/scripts/dev/fake-model-cards.mjs" > "$SANDBOX/fake-model-cards.out" 2>&1 &
FAKE_PID=$!
trap 'kill $FAKE_PID 2>/dev/null' EXIT INT TERM

# 让沙箱 DSH 把「DeepSeek」请求发给本机假模型；密钥是假的，只为通过「已配置」检查
export DEEPSEEK_BASE_URL="http://127.0.0.1:18080/anthropic"
export DEEPSEEK_API_KEY="fake-local-test-key"

cd "$SANDBOX/work"   # 启动目录 = 新会话默认工作区
echo "[ui-sandbox] 启动沙箱 DSH（端口 $PORT）；下面出现带 token 的网址后，用浏览器打开，点左侧栏「队友」。"
"$DSH_CLI" --profile web --no-open --host 127.0.0.1 --port "$PORT" 2>&1 | tee "$SANDBOX/ui-sandbox.log"
