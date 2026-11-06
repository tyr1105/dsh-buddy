#!/bin/bash
# sandbox.sh —— 在隔离沙箱里跑 dsh-agent-hub 插件，完全不碰主人的桌面版（verified-T1 Q5-e）。
# 用法：bash scripts/sandbox.sh install|run|dump|remove|status
# 原理：独立的 DSH_HOME（profiles/、sessions/、凭据、日志都在沙箱里）、独立端口、
#       web profile（与桌面版同为 base + web-app 组合，HMR 开着，行为最接近桌面版）。
# 约束：不读写 ~/.dsh（只设沙箱自己的 DSH_HOME）；不设置任何模型凭据。
set -euo pipefail

# 桌面版自带的 CLI（路径含空格，全部加引号；verified-T1 Q3-a）。
DSH_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 沙箱目录：仓库根下的 .sandbox/（该目录内自带 .gitignore 写 "*"，整体不入库）。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$ROOT/.sandbox"
PLUGIN_DIR="$ROOT/packages/plugin"
PORT=3951

export DSH_HOME="$SANDBOX/home"            # profiles/ sessions/ .credentials.yaml .env logs/ 都在这里
export DSH_AGENTS_HOME="$SANDBOX/agents"   # 不读 ~/.agents 的全局 AGENTS.md 和 skills
export DSH_TELEMETRY_DISABLED=1            # 任何非空值都会禁用 session-telemetry-otel 行
# 插件数据根目录放在仓库外（D03 先修项 B）：根目录在 agent-hub 仓库里时，DSH 会顺着
# 目录向上加载 AGENTS.md，把项目开发守则注入给机器人；沙箱数据本来就不属于项目。
export AGENT_HUB_ROOT="${TMPDIR:-/tmp}/agent-hub-sandbox/AgentHub"
WORKDIR="$SANDBOX/work"

prepare_dirs() {
  mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$WORKDIR"
  printf '*\n' > "$SANDBOX/.gitignore"
}

case "${1:-}" in
  install)
    prepare_dirs
    # 首次会按 web 模板（base + web-app）自动初始化沙箱里的 profile，并把插件选进 bundles。
    "$DSH_CLI" plugin --profile web add "link:$PLUGIN_DIR"
    ;;
  run)
    prepare_dirs
    cd "$WORKDIR"   # 启动目录 = 新会话默认 workspace 根
    # 前台启动；输出 tee 到 .sandbox/run.log。打印的带 token 的 URL 用浏览器打开。
    "$DSH_CLI" web --no-open --host 127.0.0.1 --port "$PORT" 2>&1 | tee "$SANDBOX/run.log"
    ;;
  dump)
    "$DSH_CLI" --profile web --dump-config 2>&1 | grep -i agent-hub || true
    ;;
  remove)
    "$DSH_CLI" plugin --profile web remove dsh-agent-hub
    ;;
  status)
    if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
      echo "端口 $PORT：在监听"
    else
      echo "端口 $PORT：没有在监听"
    fi
    if [ -f "$SANDBOX/run.log" ]; then
      echo "--- run.log 末尾 20 行 ---"
      tail -n 20 "$SANDBOX/run.log"
    else
      echo "（还没有 run.log，先执行 run）"
    fi
    ;;
  e2e)
    # 端到端冒烟（verified-T8 第 5 节）：沙箱 + 假模型 + 冒烟跑者，不花真实额度。
    # DEEPSEEK_BASE_URL/DEEPSEEK_API_KEY 只 export 进本脚本的沙箱进程环境
    # （DEEPSEEK_BASE_URL 是 bootstrap-only 变量，写 .env 会让启动器直接退出）。
    prepare_dirs
    # 0) 每次从干净的中心数据开始（只清沙箱里的测试数据 .sandbox/AgentHub，让冒烟可重复运行）
    rm -rf "$AGENT_HUB_ROOT"
    # 1) 先构建插件（link 安装要求 lib/index.js、lib/client.js、cordis.patch.yml 都在）。
    (cd "$ROOT" && pnpm --filter dsh-agent-hub build)
    # 2) 安装插件（已安装时重复 add 允许失败）。
    "$DSH_CLI" plugin --profile web add "link:$PLUGIN_DIR" || echo "[sandbox] 插件可能已安装，继续"
    # 3) 沙箱 home 补丁：默认模型指向 deepseek-official/deepseek-flash（配合假 BASE_URL），
    #    并关掉标题生成模型（它也会打模型请求）。
    cat > "$DSH_HOME/profiles/web/cordis.patch.yml" <<'PATCH'
# agent-hub e2e：沙箱专用补丁（默认模型走假服务、关标题生成）
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
- id: session-title-llm
  disabled: true
PATCH
    # 4) 冒烟插件 patch：--patch 的 ./ 名相对 patch 文件，这里用绝对路径（含空格，YAML 引号包裹）。
    cat > "$SANDBOX/smoke.patch.yml" <<PATCH
- insert:
    - id: hub-smoke-runner
      name: "$ROOT/scripts/smoke-runner/index.mjs"
PATCH
    # 5) 启动假模型服务（127.0.0.1:18080，日志到 .sandbox/fake-model.log）。
    FAKE_MODEL_LOG="$SANDBOX/fake-model.log" node "$ROOT/scripts/fake-model-server.mjs" > "$SANDBOX/fake-model.out" 2>&1 &
    FAKE_PID=$!
    cleanup() { kill "$FAKE_PID" 2>/dev/null || true; }
    trap cleanup EXIT INT TERM
    : > "$SANDBOX/fake-model.log"
    # 6) 只在沙箱进程环境里 export 假凭据（绝不写 .env、绝不读 ~/.dsh）。
    export DEEPSEEK_BASE_URL="http://127.0.0.1:18080/anthropic"
    export DEEPSEEK_API_KEY="fake-local-test-key"
    E2E_PORT=3952
    : > "$SANDBOX/e2e.log"
    cd "$WORKDIR"
    "$DSH_CLI" --profile web --patch "$SANDBOX/smoke.patch.yml" --no-open --host 127.0.0.1 --port "$E2E_PORT" >> "$SANDBOX/e2e.log" 2>&1 &
    DSH_PID=$!
    # 7) 外层看门狗 180 秒：先 SIGINT（SIGTERM 会被 dsh 当正常关闭以 0 退出），再 SIGKILL。
    ( sleep 180; kill -INT "$DSH_PID" 2>/dev/null; sleep 10; kill -KILL "$DSH_PID" 2>/dev/null ) &
    WATCHDOG=$!
    # 注意：脚本开了 set -e，wait 返回非零会直接退出；用 || 接住退出码，保证后面的判定一定会执行
    CODE=0; wait "$DSH_PID" || CODE=$?
    kill "$WATCHDOG" 2>/dev/null || true
    cleanup
    # 8) 判定以冒烟跑者打印的结果行为准，退出码只作辅助。
    echo "--- e2e.log 里与 agent-hub / hub-smoke 相关的行 ---"
    grep -n "hub-smoke\|agent-hub\|fake-model" "$SANDBOX/e2e.log" | tail -n 40 || true
    if grep -q '"type":"hub-smoke","ok":true' "$SANDBOX/e2e.log" && [ "$CODE" -eq 0 ]; then
      echo "e2e 冒烟通过（退出码 $CODE）"
      exit 0
    fi
    echo "e2e 冒烟失败（退出码 $CODE；130=看门狗 INT，137=KILL）"
    grep -n "fatal\|did not activate\|startup failed" "$SANDBOX/e2e.log" | tail -n 10 || true
    exit 1
    ;;
  real)
    # 真实模型沙箱测试（D04 第 3 条）：与 e2e 相同的沙箱，但不启动假模型、不设任何假凭据；
    # 启动 web profile 时额外 --patch 桌面版补丁（只把路径交给 dsh，本脚本不读取、不复制、
    # 不打印该文件）；沙箱 home 补丁里不覆盖 agent-default-model，沿用主人桌面版的模型配置。
    # 会消耗主人少量 GLM 额度；本卡只写好脚本，由总控执行。
    prepare_dirs
    rm -rf "$AGENT_HUB_ROOT"
    # 1) 先构建插件。
    (cd "$ROOT" && pnpm --filter dsh-agent-hub build)
    # 2) 安装插件（已安装时重复 add 允许失败）。
    "$DSH_CLI" plugin --profile web add "link:$PLUGIN_DIR" || echo "[sandbox] 插件可能已安装，继续"
    # 3) 沙箱 home 补丁：只插冒烟跑者这一行；不写 agent-default-model（真实模型走主人配置）。
    # 沙箱里显式启用 GLM：pi-ai 的供应商在 DSH 设置文档里配置，沙箱没有主人的设置文档，
    # 所以这里用补丁声明 zai-coding-cn 路由；apiKeyEnv 只是环境变量名，补丁里不含任何密钥值，
    # 密钥由沙箱进程从启动环境继承（总控修正：不再引用桌面版补丁路径）。
    cat > "$DSH_HOME/profiles/web/cordis.patch.yml" <<PATCH
# agent-hub real：插冒烟跑者 + 用环境变量里的 GLM 编程套餐密钥
- insert:
    - id: hub-smoke-runner
      name: "$ROOT/scripts/smoke-runner/index.mjs"
- id: llm-pi-ai
  config:
    providers:
      zai-coding-cn:
        apiKeyEnv: ZAI_CODING_CN_API_KEY
- id: agent-default-model
  config: { provider: zai-coding-cn, model: glm-5.3 }
PATCH
    # 4) 真实模式开关与沙箱工作目录（起步关注项指向它）传给冒烟跑者。
    export HUB_SMOKE_REAL=1
    export AGENT_HUB_SANDBOX_WORKDIR="$WORKDIR"
    REAL_PORT=3953
    : > "$SANDBOX/real.log"
    cd "$WORKDIR"
    "$DSH_CLI" --profile web --no-open --host 127.0.0.1 --port "$REAL_PORT" >> "$SANDBOX/real.log" 2>&1 &
    DSH_PID=$!
    # 5) 外层看门狗 600 秒：先 SIGINT（SIGTERM 会被 dsh 当正常关闭以 0 退出），再 SIGKILL。
    ( sleep 600; kill -INT "$DSH_PID" 2>/dev/null; sleep 10; kill -KILL "$DSH_PID" 2>/dev/null ) &
    WATCHDOG=$!
    # set -e 下 wait 返回非零会直接退出；用 || 接住退出码，保证后面的判定一定会执行。
    CODE=0; wait "$DSH_PID" || CODE=$?
    kill "$WATCHDOG" 2>/dev/null || true
    # 6) 判定以冒烟跑者打印的结果行为准，退出码只作辅助。
    echo "--- real.log 里与 agent-hub / hub-smoke 相关的行 ---"
    grep -n "hub-smoke\|agent-hub" "$SANDBOX/real.log" | tail -n 40 || true
    if grep -q '"type":"hub-smoke","ok":true' "$SANDBOX/real.log" && [ "$CODE" -eq 0 ]; then
      echo "real 真实模型测试通过（退出码 $CODE）"
      exit 0
    fi
    echo "real 真实模型测试失败（退出码 $CODE；130=看门狗 INT，137=KILL）"
    # 缺凭据/模型不可用时的常见报错只从沙箱自己的日志里找（不碰 ~/.dsh 内容）。
    grep -in "fatal\|credential\|api key\|apikey\|model\|did not activate\|startup failed" "$SANDBOX/real.log" | tail -n 15 || true
    exit 1
    ;;
  *)
    echo "用法：bash scripts/sandbox.sh install|run|dump|remove|status|e2e|real" >&2
    exit 2
    ;;
esac
