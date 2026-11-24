#!/bin/bash
# host-sandbox.sh —— 用「另一个版本的 DSH」开隔离沙箱，验证插件在那个版本上能不能用。
#
# 用法：bash scripts/dev/host-sandbox.sh <DSH 应用的路径> <端口>
# 例子：bash scripts/dev/host-sandbox.sh "/tmp/dsh-0.2.3/DeepSeek Harness.app" 3961
#
# 什么时候用：DSH 出了新版本，想在升级自己电脑上的 DSH 之前，先确认插件在新版上正常。
# ui-sandbox.sh 写死了用「应用程序」里那份 DSH；本脚本换成你指定的那一份，其余做法相同。
#
# 新版 DSH 从哪里来：官方更新源 https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml
# 里写着最新版本号、安装包地址和 sha512。下载后核对 sha512，解压到任意目录即可，
# 不需要装进「应用程序」，也不会影响正在用的 DSH。
#
# 隔离保证（和 ui-sandbox.sh 一致）：
#   - DSH 的家目录、会话目录都在项目的 .sandbox/hosts/<版本>/ 里，不读写 ~/.dsh；
#   - 员工数据放系统临时目录，不碰 ~/AgentHub；
#   - 模型请求全部发给本机假模型（端口 18080），不花真实额度；真实密钥从本进程环境里去掉。
#
# 注意：和 ui-sandbox.sh、sandbox.sh e2e 共用 18080 端口，同一时间只能开一个。
# 先构建插件再运行：pnpm --filter @tyr1105/dsh-buddy build
set -uo pipefail

APP="${1:?需要 DSH 应用的路径，例如 \"/tmp/dsh-0.2.3/DeepSeek Harness.app\"}"
PORT="${2:?需要端口号，例如 3961}"

# 项目根目录 = 本脚本往上两级（scripts/dev/ → scripts/ → 项目根）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLUGIN_DIR="$ROOT/packages/plugin"
# 指定的那份 DSH 自带的命令行入口
DSH_CLI="$APP/Contents/Resources/runtime/cli/bin/dsh"

if [ ! -x "$DSH_CLI" ]; then
  echo "[host-sandbox] 找不到 DSH 命令行：$DSH_CLI"
  echo "[host-sandbox] 第一个参数要指向解压出来的 DeepSeek Harness.app。"
  exit 1
fi

# 用版本号给沙箱目录命名：不同版本的 DSH 各用各的家目录，互不影响
VERSION="$("$DSH_CLI" --version 2>/dev/null | head -1 | tr -c 'A-Za-z0-9._-' '_')"
SANDBOX="$ROOT/.sandbox/hosts/${VERSION:-unknown}"

# —— 沙箱环境变量：全部指向沙箱自己的目录 ——
export DSH_HOME="$SANDBOX/home"
export DSH_AGENTS_HOME="$SANDBOX/agents"
export DSH_TELEMETRY_DISABLED=1
export AGENT_HUB_ROOT="${TMPDIR:-/tmp}/agent-hub-host-sandbox-${VERSION:-unknown}/AgentHub"
# 走查绝不能花真实额度：把真实密钥从这个进程的环境里去掉
unset ZAI_CODING_CN_API_KEY

mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$SANDBOX/work"
printf '*\n' > "$ROOT/.sandbox/.gitignore"

# 端口被占就退出，避免连到别的沙箱上得出错误结论
for p in "$PORT" 18080; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[host-sandbox] 端口 $p 已被占用（可能另一个沙箱还开着）"
    exit 1
  fi
done

echo "[host-sandbox] DSH 版本：${VERSION:-未知}"
echo "[host-sandbox] 把插件装进沙箱（重复执行无害）……"
"$DSH_CLI" plugin --profile web add "link:$PLUGIN_DIR" > "$SANDBOX/install.log" 2>&1
echo "[host-sandbox] 安装命令退出码 $?（详情见 $SANDBOX/install.log）"

# 沙箱补丁：默认模型指向本机假模型，并关掉会调模型的标题生成
cat > "$DSH_HOME/profiles/web/cordis.patch.yml" <<'PATCH'
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
- id: session-title-llm
  disabled: true
PATCH

rm -rf "$AGENT_HUB_ROOT"   # 每次从干净的员工数据开始（这里只有沙箱测试数据）

# 拉起走查专用假模型；脚本结束（含 Ctrl+C）时一并关掉
FAKE_MODEL_LOG="$SANDBOX/fake-model.log" node "$ROOT/scripts/dev/fake-model-cards.mjs" > "$SANDBOX/fake-model.out" 2>&1 &
FAKE_PID=$!
trap 'kill $FAKE_PID 2>/dev/null' EXIT INT TERM

# 让沙箱 DSH 把模型请求发给本机假模型；密钥是假的，只为通过「已配置」检查
export DEEPSEEK_BASE_URL="http://127.0.0.1:18080/anthropic"
export DEEPSEEK_API_KEY="fake-local-test-key"

cd "$SANDBOX/work"
echo "[host-sandbox] 启动沙箱 DSH（端口 $PORT）；出现带 token 的网址后用浏览器打开。"
"$DSH_CLI" --profile web --no-open --host 127.0.0.1 --port "$PORT" 2>&1 | tee "$SANDBOX/run.log"
