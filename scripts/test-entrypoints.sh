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
  # 桩 pgrep：拿脚本传入的匹配规则，去比对 PGREP_STUB_PROCESSES 里模拟的进程命令行；
  # 没有设置这个变量就是「没在运行」（退出 1）。这样连匹配规则本身也测到了。
  cat > "$home/bin/pgrep" <<'STUB'
#!/bin/bash
pattern="${*: -1}"
[ -n "${PGREP_STUB_PROCESSES:-}" ] || exit 1
printf '%s\n' "$PGREP_STUB_PROCESSES" | grep -Eq -- "$pattern"
STUB
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
  # DSH_STUB_MODE=fail 时模拟 dsh 命令本身失败。
  cat > "$home/bin/dsh" <<'STUB'
#!/bin/bash
echo "dsh args=$*" >> "$DSH_LOG"
if [ "${DSH_STUB_MODE:-ok}" = "fail" ]; then
  echo "dsh-stub: 模拟失败"
  exit 1
fi
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
      if ! grep -q "link:$home/.agent-hub/plugin" "$log_dsh"; then fail "$name：链接的不是固定副本"; return; fi
      if grep -q "link:$ROOT/packages/plugin" "$log_dsh"; then fail "$name：不应再链接开发目录"; return; fi
      for file in package.json cordis.patch.yml lib/index.js lib/client.js; do
        if [ ! -f "$home/.agent-hub/plugin/$file" ] || [ -L "$home/.agent-hub/plugin/$file" ]; then
          fail "$name：副本里的 $file 不是真实文件"
          return
        fi
      done
      pass "$name：入口构建后装的是固定副本（link:\$HOME/.agent-hub/plugin）"
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
# `dsh plugin --profile desktop remove @tyr1105/dsh-buddy`（P56：短名在改名后会失败）。
# P56：卸载后固定副本被删除，队友数据（~/AgentHub）原样保留。
uninstall_entry_case() {
  local home entry log_dsh rc=0
  home="$(new_env uninstall)"
  entry="$home/.agent-hub/uninstall.sh"
  log_dsh="$home/dsh.log"
  mkdir -p "$home/.agent-hub/plugin/lib" "$home/AgentHub"
  printf 'old\n' > "$home/.agent-hub/plugin/lib/client.js"
  printf 'data\n' > "$home/AgentHub/keep.txt"
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
  elif ! grep -q "plugin --profile desktop remove @tyr1105/dsh-buddy" "$log_dsh" 2>/dev/null; then
    fail "uninstall：没有用完整包名调用 dsh 移除插件"
  elif [ -e "$home/.agent-hub/plugin" ]; then
    fail "uninstall：固定副本没有删除"
  elif [ ! -f "$home/AgentHub/keep.txt" ]; then
    fail "uninstall：队友数据不应被删除"
  else
    pass "uninstall：用完整包名移除插件、删除固定副本、保留队友数据"
  fi
}
uninstall_entry_case

# ---------- P56：固定副本 ----------
# 假项目：插件名正确、产物完整，内容全由用例控制，不受别的 Agent 重新构建影响。
new_fake_project() {
  local fake
  fake="$(mktemp -d "${TMPDIR:-/tmp}/agent-hub-entry-fakeproj.XXXXXX")"
  mkdir -p "$fake/scripts" "$fake/packages/plugin/lib"
  cp "$ROOT/scripts/install-desktop.sh" "$ROOT/scripts/uninstall-desktop.sh" "$fake/scripts/"
  printf '{ "name": "@tyr1105/dsh-buddy", "version": "9.9.9" }\n' > "$fake/packages/plugin/package.json"
  printf -- '- insert: []\n' > "$fake/packages/plugin/cordis.patch.yml"
  printf 'host-v1\n' > "$fake/packages/plugin/lib/index.js"
  printf 'client-v1\n' > "$fake/packages/plugin/lib/client.js"
  echo "$fake"
}

# 在假 HOME 里运行假项目的安装脚本。调用前可用 env 传 DSH_STUB_MODE、PGREP_STUB_PROCESSES。
# 输出写到假 HOME 的 install.log；返回安装脚本的退出码。
install_fake() {
  local home="$1" fake="$2"
  HOME="$home" PATH="$home/bin:$PATH" DSH_CLI="$home/bin/dsh" \
    PNPM_LOG="$home/pnpm.log" DSH_LOG="$home/dsh.log" \
    bash "$fake/scripts/install-desktop.sh" > "$home/install.log" 2>&1
}

# 安装结束后，旁边不能留下准备中或暂存的目录。
no_leftovers() {
  local home="$1"
  ! ls -d "$home"/.agent-hub/plugin.new.* "$home"/.agent-hub/plugin.old.* >/dev/null 2>&1
}

# 副本和开发目录互不影响：之后开发目录重新构建，副本一个字节都不变。
copy_is_independent_case() {
  local home fake copy
  home="$(new_env copy-independent)"
  fake="$(new_fake_project)"
  copy="$home/.agent-hub/plugin"
  if ! install_fake "$home" "$fake"; then fail "copy-independent：安装失败（$(tail -2 "$home/install.log" | tr '\n' ' ')）"; return; fi
  if ! cmp -s "$fake/packages/plugin/lib/client.js" "$copy/lib/client.js"; then fail "copy-independent：副本内容和构建产物不一致"; return; fi
  printf 'client-v2\n' > "$fake/packages/plugin/lib/client.js"
  if [ "$(cat "$copy/lib/client.js")" != "client-v1" ]; then fail "copy-independent：开发目录重新构建后副本跟着变了"; return; fi
  if ! grep -q "link:$copy" "$home/dsh.log"; then fail "copy-independent：dsh 链接的不是副本"; return; fi
  pass "copy-independent：开发目录重新构建不影响固定副本"
}
copy_is_independent_case

# 重新安装：旧副本整份换掉，多余的旧文件不残留。
reinstall_replaces_case() {
  local home fake copy
  home="$(new_env reinstall)"
  fake="$(new_fake_project)"
  copy="$home/.agent-hub/plugin"
  mkdir -p "$copy/lib"
  printf 'stale\n' > "$copy/lib/stale.js"
  if ! install_fake "$home" "$fake"; then fail "reinstall：安装失败（$(tail -2 "$home/install.log" | tr '\n' ' ')）"; return; fi
  if [ -e "$copy/lib/stale.js" ]; then fail "reinstall：旧文件还留在副本里"; return; fi
  if ! no_leftovers "$home"; then fail "reinstall：留下了临时目录"; return; fi
  pass "reinstall：重新安装整份换掉旧副本，不留临时目录"
}
reinstall_replaces_case

# dsh 安装失败：放回旧副本，桌面版保持安装前的样子。
add_failure_restores_case() {
  local home fake copy rc=0
  home="$(new_env add-failure)"
  fake="$(new_fake_project)"
  copy="$home/.agent-hub/plugin"
  mkdir -p "$copy/lib"
  printf 'previous\n' > "$copy/lib/client.js"
  DSH_STUB_MODE=fail install_fake "$home" "$fake" || rc=$?
  if [ "$rc" -eq 0 ]; then fail "add-failure：dsh 失败不应算成功"; return; fi
  if [ "$(cat "$copy/lib/client.js" 2>/dev/null)" != "previous" ]; then fail "add-failure：旧副本没有放回"; return; fi
  if ! no_leftovers "$home"; then fail "add-failure：留下了临时目录"; return; fi
  pass "add-failure：dsh 失败时放回旧副本"
}
add_failure_restores_case

# 第一次装副本就失败：不留下任何东西。
first_install_failure_case() {
  local home fake rc=0
  home="$(new_env first-failure)"
  fake="$(new_fake_project)"
  DSH_STUB_MODE=fail install_fake "$home" "$fake" || rc=$?
  if [ "$rc" -eq 0 ]; then fail "first-failure：dsh 失败不应算成功"; return; fi
  if [ -e "$home/.agent-hub/plugin" ]; then fail "first-failure：失败后不应留下副本"; return; fi
  if ! no_leftovers "$home"; then fail "first-failure：留下了临时目录"; return; fi
  pass "first-failure：第一次安装失败不留下副本"
}
first_install_failure_case

# 构建产物缺文件：中文报错，不调用 dsh，已有副本不动。
missing_output_case() {
  local home fake copy rc=0
  home="$(new_env missing-output)"
  fake="$(new_fake_project)"
  copy="$home/.agent-hub/plugin"
  rm "$fake/packages/plugin/lib/client.js"
  mkdir -p "$copy/lib"
  printf 'previous\n' > "$copy/lib/client.js"
  install_fake "$home" "$fake" || rc=$?
  if [ "$rc" -eq 0 ]; then fail "missing-output：缺文件不应算成功"; return; fi
  if ! grep -q "构建产物不完整" "$home/install.log"; then fail "missing-output：没有中文说明"; return; fi
  if [ -f "$home/dsh.log" ]; then fail "missing-output：不应调用 dsh"; return; fi
  if [ "$(cat "$copy/lib/client.js")" != "previous" ]; then fail "missing-output：已有副本被动了"; return; fi
  pass "missing-output：构建产物不完整时报错退出、不动已有副本"
}
missing_output_case

# 桌面版在运行：拒绝安装，也不构建。
desktop_running_case() {
  local home fake rc=0
  home="$(new_env desktop-running)"
  fake="$(new_fake_project)"
  PGREP_STUB_PROCESSES="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" install_fake "$home" "$fake" || rc=$?
  if [ "$rc" -eq 0 ]; then fail "desktop-running：桌面版在运行时不应安装"; return; fi
  if ! grep -q "请先完全退出" "$home/install.log"; then fail "desktop-running：没有提示退出"; return; fi
  if [ -f "$home/pnpm.log" ] || [ -f "$home/dsh.log" ]; then fail "desktop-running：不应构建或调用 dsh"; return; fi
  pass "desktop-running：桌面版在运行时拒绝安装"
}
desktop_running_case

# 只开着走查沙箱（同一个程序，但带启动参数）：不算桌面版在运行。
sandbox_running_case() {
  local home fake
  home="$(new_env sandbox-running)"
  fake="$(new_fake_project)"
  if ! PGREP_STUB_PROCESSES="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals /runtime/cli/bin/dsh --profile web" install_fake "$home" "$fake"; then
    fail "sandbox-running：只开沙箱时不应拦住安装（$(tail -2 "$home/install.log" | tr '\n' ' ')）"
    return
  fi
  pass "sandbox-running：只开走查沙箱时可以安装"
}
sandbox_running_case

# dsh 卸载失败：副本留着，还能继续用。
uninstall_failure_case() {
  local home fake rc=0
  home="$(new_env uninstall-failure)"
  fake="$(new_fake_project)"
  mkdir -p "$home/.agent-hub/plugin/lib"
  printf 'previous\n' > "$home/.agent-hub/plugin/lib/client.js"
  HOME="$home" PATH="$home/bin:$PATH" DSH_CLI="$home/bin/dsh" DSH_LOG="$home/dsh.log" DSH_STUB_MODE=fail \
    bash "$fake/scripts/uninstall-desktop.sh" > "$home/uninstall.log" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then fail "uninstall-failure：dsh 失败不应算成功"; return; fi
  if [ ! -f "$home/.agent-hub/plugin/lib/client.js" ]; then fail "uninstall-failure：卸载失败时不应删除副本"; return; fi
  pass "uninstall-failure：dsh 卸载失败时保留副本"
}
uninstall_failure_case

# 清理自己建的临时目录（只删 mkdtemp 建的）。
for d in "${TMPDIR:-/tmp}"/agent-hub-entry-*; do
  [ -d "$d" ] && rm -rf "$d"
done

if [ "$FAILURES" -gt 0 ]; then
  echo "[test-entrypoints] ${FAILURES} 个用例失败"
  exit 1
fi
echo "[test-entrypoints] 全部通过"
