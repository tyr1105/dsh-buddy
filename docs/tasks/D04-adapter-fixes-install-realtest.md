# D04 适配层修正、桌面版安装脚本、真实模型沙箱测试

- 负责方：DSH
- 允许修改：`packages/plugin/`（不得改依赖）、`scripts/`、`docs/progress/D04.md`、`docs/questions.md`（只追加）
- 不得修改：`packages/core/`、规格与任务卡
- 前置：D03 已验收；必读新出的开发手册 `docs/design/build/dsh-plugin-handbook.md`（第 0.4 节与本卡直接相关，第 12 节是未实测点 H1–H46）

## 1. 审批事件配对（手册 0.4 第 5 条）

机器人会话的审批策略是 never：DSH 先追加 `approval/asked`，紧跟一条 outcome 为 rejected 的 `approval/decided`，这是「被自动拒绝」，不是卡住。现在 `turn-events.ts` 一看到 asked 就翻译成 `awaiting_approval`，core 会因此发 P1 告警「卡在 DSH 审批」并在 5 分钟后取消一个正常进行的回合。要做：按审批 id 记录未决的 asked；收到配对的 decided 就删除；只有 asked 之后 30 秒仍没有 decided 的，才翻译成 `awaiting_approval`（用插件自己的定时检查，回合结束时清理该会话的未决记录）。测试：asked→decided 不产生 awaiting_approval；asked 后 30 秒无 decided 才产生；回合结束清理。

## 1b. 接上 core 的新接口（M02 已合入）

- `createHub(deps)` 新增可选依赖 `ownerHome`：动作闸用它展开 `~`、`$HOME` 并判断主人目录（没传时带 `~` 的路径一律按需审批处理）。插件建引擎时传 `ownerHome: os.homedir()`。
- core 的 `FsIO` 新增 `realpath(path)`（交接复制与出站写文件用它防符号链接越界）；插件用的是 core 自带的 SystemFs，已实现，确认没有自定义 FsIO 漏掉它。
- 测试：建引擎时 ownerHome 被传入；用一个机器人会话调用 `read_file {path: '~/.ssh/id_rsa'}` 与 `bash cat ~/.dsh/.credentials.yaml`，守卫拒绝。

## 2. 桌面版安装与卸载脚本（给主人用）

主人的终端运行方式有限制：命令里不能有引号、反斜杠、空格路径。所以：
- `scripts/install-desktop.sh` 与 `scripts/uninstall-desktop.sh`（项目内，供阅读与维护）；同时提供一份**放在无空格路径**的入口脚本：安装时由总控复制到 `$HOME/.agent-hub/install.sh`、`$HOME/.agent-hub/uninstall.sh`（本卡只写好两份脚本与复制命令的说明，不执行复制）。
- install：① 检查 DeepSeek Harness 桌面版是否在运行（`pgrep -f "DeepSeek Harness.app/Contents/MacOS"` 或等价方式）：在运行就打印「请先完全退出 DeepSeek Harness（菜单栏 → 退出），再运行本脚本」并以非零码退出；② 先构建插件；③ 运行桌面版自带 CLI：`dsh plugin --profile desktop add "link:<packages/plugin 绝对路径>"`；④ 打印成功与下一步：「打开 DeepSeek Harness，左侧栏会出现『队友』」；失败时原样打印 dsh 的错误并提示日志位置（只打印路径，不读 ~/.dsh 下的文件内容）。
- uninstall：同样先检查桌面版未运行，再 `dsh plugin --profile desktop remove dsh-agent-hub`；提示「中心数据保留在 ~/AgentHub，不会删除」。
- 一键停用说明（不卸载）：在 `~/AgentHub/.hub/` 下创建 `DISABLED` 文件，重启 DSH 后引擎停用、只显示界面；删除即恢复。写进 `scripts/README.md`（中文，给主人看，按「一条命令做什么」来写）。
- 两个脚本都 `set -euo pipefail`，注意 `wait`/管道的退出码陷阱（D02 进度末尾的总控修正）；`bash -n` 通过。

## 3. 真实模型的沙箱测试 `bash scripts/sandbox.sh real`

目的：在不碰主人桌面版的前提下，用主人现有的模型配置（GLM）跑一个真实机器人的两个回合，检验真模型是否按协议交账。做法（手册第 10 节、verified-T8）：
- 与 e2e 相同的沙箱（独立 DSH_HOME、仓库外的 AGENT_HUB_ROOT、清空中心数据），但**不启动假模型、不设任何假凭据**；
- 启动 web profile 时额外加 `--patch "$HOME/.dsh/profiles/desktop/cordis.patch.yml"`（**只把路径交给 dsh，脚本不得读取、复制、打印这个文件**），以沿用主人桌面版的模型配置；沙箱 home 补丁里**不要**覆盖 agent-default-model；
- 冒烟跑者加一个「真实模式」（环境变量 `HUB_SMOKE_REAL=1`）：createBot（盯守型，志向「每天确认沙箱目录里有一份 hello.txt，内容是今天的日期」，起步关注项指向沙箱工作目录）→ 等 trial 交账（超时 240 秒）→ pokeBot「请检查一下 hello.txt 在不在，不在就创建它」→ 等第二次交账与 reply（超时 240 秒）→ 打印摘要：两次交账的 outcome、reply 原文、每轮步数与 token、有没有未交账/出错、机器人实际调用了哪些工具（从会话事件统计）。外层看门狗 600 秒。
- 若启动时报缺少凭据或模型不可用，打印原因并以非零码退出（不要尝试任何登录或写凭据）。
- 本卡只写好并 `bash -n`；由总控执行（会消耗主人少量 GLM 额度，主人已授权）。

## 3b. 「打断」按钮（Grok Bot 有的体验）

机器人正在处理时（activity=thinking），线程头部显示「打断」按钮：二次确认后调用宿主 cancel 当前回合（经 core 的命令，若 core 没有对应命令，就在插件路由里直接调用 HostPort.cancel 并给该机器人线程写一条系统消息「你打断了它；它会在下次醒来时接着处理」），不计入机器人的错误次数。测试覆盖。

## 3c. 总控走查发现的界面问题（沙箱真引擎 + 假模型，暗色 1440×900）

1. 新建向导第 1 步：角色卡选中后没有可见变化（类名 `ah-wizard-role-picked` 有了，但样式不明显）；改成主色描边 + 浅底 + 右上角对勾，并加 `aria-pressed`。颜色色块加 `aria-label`（例如「头像颜色：绿色」）与选中描边。
2. 向导第 4 步版式：模型下拉框被拉得很高、右侧说明文字字号过大；三个选择框同高同宽对齐，说明用次要文字色、正常字号放在下方。
3. 「正在试跑：它会先做自我介绍，稍等片刻。知道了」提示条压在输入框上，挡住输入；而且试跑早已结束仍不消失。改为：放在线程顶部（不遮挡输入），收到该机器人第一次交账（线程出现 reply）后自动消失。
4. 主人消息的气泡底色在暗色主题下几乎看不见；用主色的浅透明底（只用主题变量，例如 accent 系列的弱底色 token），机器人消息用中性弱底，两者都要在亮/暗主题下清晰可辨。
5. 右栏「志向」区出现重复：一条完整文字下面又出现一行截断的同一文字与「收起」；只显示一份，编辑时才出现输入框。

## 4. 手册第 12 节里影响 v1 的未实测点

逐条看 H1–H46，挑出会影响「装进桌面版就能用」的（至少 H1、H3、H7、H9、H15），在 `docs/progress/D04.md` 里写：它是什么、我们的代码依赖它的哪里、真实模型测试或桌面安装后怎么确认、如果不成立怎么降级。能在沙箱里验证的就在 e2e 或 real 测试里加一项检查。

## 测试与验收

```bash
pnpm --filter dsh-agent-hub typecheck
pnpm --filter dsh-agent-hub test
pnpm --filter dsh-agent-hub build
bash -n scripts/sandbox.sh && bash -n scripts/install-desktop.sh && bash -n scripts/uninstall-desktop.sh
```

全部通过；新增测试覆盖第 1 条。`docs/progress/D04.md` 写清各脚本的预期输出。
