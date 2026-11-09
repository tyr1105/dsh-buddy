#!/bin/bash
# test-entrypoints.sh —— 安装入口的自动化测试（D05 第 3 条）。
# 全程用 HOME=<临时目录>，把 dsh / pgrep / pnpm 换成只记录调用的桩，
# 绝不碰真实的桌面版、真实的 pnpm 和主人真实的 $HOME。
# 用法：bash scripts/test-entrypoints.sh（退出码 0 = 全部通过）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0

pass() { echo "[test-entrypoints] 通过：$1"; }
fail() { echo "[test-entrypoints] 失败：$1"; FAILURES=$((FAILURES + 1)); }

# 每个用例一套独立的假 HOME 与桩 bin。
new_env() {
  local name="$1"
  local home
  home="$(mktemp -d "${TMPDIR:-/tmp}/agent-hub-entry-${name}.XXXXXX")"
  mkdir -p "$home/bin"
  # 桩 pgrep：永远「没在运行」（退出 1）。
  printf '#!/bin/bash\nexit 1\n' > "$home/bin/pgrep"
  # 桩 pnpm：把参数与 cwd 记到日志；BUILD_MODE 控制行为（ok / no-projects / fail）。
  cat > "$home/bin/pnpm" <<'STUB'
#!/bin/bash
echo "pnpm cwd=$PWD args=$*" >> "$PNPM_LOG"
case "${PNPM_STUB_MODE:-ok}" in
  no-projects) echo "No projects found in \"$PWD\""; exit 0 ;;
  fail) echo "构建炸了"; exit 1 ;;
  *) exit 0 ;;
esac
STUB
  # 桩 dsh：记录参数；链接目标不存在时以非零退出（模拟 DSH 校验）。
  cat > "$home/bin/dsh" <<'STUB'
#!/bin/bash
echo "dsh args=$*" >> "$DSH_LOG"
for arg in "$@"; do
  if [[ "$arg" == link:* ]]; then
    link="${arg#link:}"
    if [ ! -f "$link/package.json" ]; then
      echo "dsh-stub: 链接目标不存在：$link"
      exit 1
    fi
  fi
done
exit 0
STUB
  chmod +x "$home/bin/pgrep" "$home/bin/pnpm" "$home/bin/dsh"
  echo "$home"
}

run_case() {
  local name="$1" mode="$2"   # mode: expect-ok | expect-fail-no-plugin | expect-fail-no-projects | expect-fail-build
  local home entry log_pnpm log_dsh
  home="$(new_env "$name")"
  entry="$home/.agent-hub/install.sh"
  log_pnpm="$home/pnpm.log"
  log_dsh="$home/dsh.log"

  # 用本项目的 make-entrypoints.sh 生成入口（HOME 指向临时目录，绝不碰真实家目录）。
  if ! HOME="$home" bash "$ROOT/scripts/make-entrypoints.sh" > "$home/make.log" 2>&1; then
    fail "$name：make-entrypoints.sh 执行失败"
    return
  fi
  if [ ! -f "$entry" ]; then
    fail "$name：入口 $entry 没有生成"
    return
  fi
  # 入口内容检查：必须 exec 到项目内的 install-desktop.sh 绝对路径。
  if ! grep -q "exec bash.*install-desktop.sh" "$entry"; then
    fail "$name：入口没有 exec 到项目内脚本"
    return
  fi

  # 安装时插件目录检查要在「项目里」跑：把项目整个当 ROOT 用真目录；
  # no-plugin 场景则把入口改写为指向一个假项目。
  local target_root="$ROOT"
  if [ "$mode" = "expect-fail-no-plugin" ]; then
    target_root="$(mktemp -d "${TMPDIR:-/tmp}/agent-hub-entry-fakeproj.XXXXXX")"
    printf '#!/bin/bash\nexec bash %q "$@"\n' "$target_root/scripts/install-desktop.sh" > "$entry"
  fi

  case "$mode" in
    expect-fail-no-plugin)
      mkdir -p "$target_root/scripts"
      cp "$ROOT/scripts/install-desktop.sh" "$target_root/scripts/install-desktop.sh"
      ;;
    expect-fail-no-projects)
      # 让桩 pnpm 报 No projects found（exit 0），脚本必须把它当失败拦下。
      ;;
  esac

  local rc=0
  HOME="$home" PATH="$home/bin:$PATH" DSH_CLI="$home/bin/dsh" \
    PNPM_STUB_MODE="${PNPM_STUB_MODE_OVERRIDE:-ok}" \
    PNPM_LOG="$log_pnpm" DSH_LOG="$log_dsh" \
    bash "$entry" > "$home/install.log" 2>&1 || rc=$?

  case "$mode" in
    expect-ok)
      if [ "$rc" -ne 0 ]; then fail "$name：期望成功，退出码 $rc（$(tail -2 "$home/install.log" | tr '\n' ' ')）"; return; fi
      if ! grep -q "plugin --profile desktop add" "$log_dsh"; then fail "$name：没有调用 dsh 安装"; return; fi
      if ! grep -q "link:$ROOT/packages/plugin" "$log_dsh"; then fail "$name：链接的不是项目内插件目录"; return; fi
      pass "$name：入口装的是项目内插件（link:$ROOT/packages/plugin）"
      ;;
    expect-fail-no-plugin)
      if [ "$rc" -eq 0 ]; then fail "$name：对不存在的插件目录不应安装成功"; return; fi
      if ! grep -q "找不到插件清单" "$home/install.log"; then fail "$name：没有中文报错"; return; fi
      if [ -f "$log_dsh" ]; then fail "$name：不应调用 dsh"; return; fi
      pass "$name：插件目录不存在时报错退出、不安装"
      ;;
    expect-fail-no-projects)
      if [ "$rc" -eq 0 ]; then fail "$name：No projects found 不应算构建成功"; return; fi
      if ! grep -q "No projects found" "$home/install.log"; then fail "$name：没有说明 No projects found"; return; fi
      if [ -f "$log_dsh" ]; then fail "$name：构建失败后不应调用 dsh"; return; fi
      pass "$name：构建输出 No projects found 时报错退出"
      ;;
    expect-fail-build)
      if [ "$rc" -eq 0 ]; then fail "$name：pnpm 非零退出不应继续"; return; fi
      if [ -f "$log_dsh" ]; then fail "$name：构建失败后不应调用 dsh"; return; fi
      pass "$name：构建失败（非零退出）时报错退出"
      ;;
  esac
}

run_case happy-path expect-ok
run_case missing-plugin expect-fail-no-plugin
PNPM_STUB_MODE_OVERRIDE=no-projects run_case no-projects expect-fail-no-projects
PNPM_STUB_MODE_OVERRIDE=fail run_case build-fail expect-fail-build

# D07 第 26 条：package.json 存在但 name 不对 → 中文报错退出，绝不调用 dsh。
wrong_name_case() {
  local home fake entry log_dsh rc=0
  home="$(new_env wrong-name)"
  fake="$(mktemp -d "${TMPDIR:-/tmp}/agent-hub-entry-wrongname.XXXXXX")"
  mkdir -p "$fake/scripts" "$fake/packages/plugin"
  cp "$ROOT/scripts/install-desktop.sh" "$fake/scripts/install-desktop.sh"
  # 假清单：name 不是 dsh-buddy（模拟入口被挪到别的项目里）。
  printf '{ "name": "some-other-plugin", "version": "0.0.1" }\n' > "$fake/packages/plugin/package.json"
  entry="$home/.agent-hub/install.sh"
  log_dsh="$home/dsh.log"
  HOME="$home" bash "$ROOT/scripts/make-entrypoints.sh" > "$home/make.log" 2>&1
  printf '#!/bin/bash\nexec bash %q "$@"\n' "$fake/scripts/install-desktop.sh" > "$entry"
  chmod +x "$entry"
  HOME="$home" PATH="$home/bin:$PATH" DSH_CLI="$home/bin/dsh" PNPM_LOG="$home/pnpm.log" DSH_LOG="$log_dsh" \
    bash "$entry" > "$home/install.log" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    fail "wrong-name：name 不对不应安装成功"
  elif ! grep -q "name 不是 dsh-buddy" "$home/install.log"; then
    fail "wrong-name：没有中文说明 name 不对"
  elif [ -f "$log_dsh" ]; then
    fail "wrong-name：不应调用 dsh"
  else
    pass "wrong-name：name 不对时报错退出、不调用 dsh"
  fi
  rm -rf "$fake"
}
wrong_name_case

# D07 第 26 条：卸载入口确实执行 uninstall-desktop.sh，并调用
# `dsh plugin --profile desktop remove dsh-buddy`。
uninstall_entry_case() {
  local home entry log_dsh rc=0
  home="$(new_env uninstall)"
  entry="$home/.agent-hub/uninstall.sh"
  log_dsh="$home/dsh.log"
  if ! HOME="$home" bash "$ROOT/scripts/make-entrypoints.sh" > "$home/make.log" 2>&1; then
    fail "uninstall：make-entrypoints.sh 执行失败"
    return
  fi
  if [ ! -f "$entry" ]; then
    fail "uninstall：入口 $entry 没有生成"
    return
  fi
  if ! grep -q "exec bash.*uninstall-desktop.sh" "$entry"; then
    fail "uninstall：入口没有 exec 到项目内卸载脚本"
    return
  fi
  HOME="$home" PATH="$home/bin:$PATH" DSH_CLI="$home/bin/dsh" DSH_LOG="$log_dsh" \
    bash "$entry" > "$home/uninstall.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "uninstall：期望成功，退出码 $rc（$(tail -2 "$home/uninstall.log" | tr '\n' ' ')）"
  elif ! grep -q "plugin --profile desktop remove dsh-buddy" "$log_dsh" 2>/dev/null; then
    fail "uninstall：没有调用 dsh 移除 dsh-buddy"
  else
    pass "uninstall：入口 exec 到卸载脚本并调用 plugin --profile desktop remove dsh-buddy"
  fi
}
uninstall_entry_case

# 清理自己建的临时目录（只删 mkdtemp 建的）。
for d in "${TMPDIR:-/tmp}"/agent-hub-entry-*; do
  [ -d "$d" ] && rm -rf "$d"
done

if [ "$FAILURES" -gt 0 ]; then
  echo "[test-entrypoints] ${FAILURES} 个用例失败"
  exit 1
fi
echo "[test-entrypoints] 全部通过"
