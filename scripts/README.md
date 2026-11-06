# scripts/ 说明（给主人看）

这里放的是「队友中心」插件的各种脚本。按一条命令做什么来写。
主人的终端跑不了带引号、反斜杠或空格路径的命令，所以桌面版的安装/卸载入口
会先复制到 `$HOME/.agent-hub/` 下（复制命令见下面「总控要做的一次性准备」）。

## 桌面版安装与卸载（给主人用）

| 一条命令 | 做什么 |
|---|---|
| `bash $HOME/.agent-hub/install.sh` | 构建插件并装进 DeepSeek Harness 桌面版。装好后打开 DSH，左侧栏会出现「队友」。运行前要先完全退出 DSH（菜单栏 → 退出）。 |
| `bash $HOME/.agent-hub/uninstall.sh` | 从桌面版移除插件。中心数据保留在 `~/AgentHub`，不会删除。运行前同样要先退出 DSH。 |

两条脚本都会先检查 DSH 是否在运行：在运行就提示退出后重来，不会硬装。
失败时会原样打印 dsh 命令的错误，并提示日志位置（只提示路径，脚本不读那些文件）。

### 总控要做的一次性准备（把入口放到无空格路径）

```bash
bash /Users/bytedance/Documents/DSH\ solo\ AGENT/agent-hub/scripts/make-entrypoints.sh
```

make-entrypoints.sh 会在 `$HOME/.agent-hub/` 下生成两个极短的入口脚本
（install.sh / uninstall.sh），内容只有一行 `exec bash "<项目内脚本的绝对路径>" "$@"`。
入口不再按自身位置推算项目根（复制过去的副本会把 $HOME 当项目根），项目根的
推算始终由留在项目里的本体脚本完成。

复制之后，主人只需要跑 `bash $HOME/.agent-hub/install.sh`（无引号、无空格）。
入口的自动化测试（不碰真实桌面版）：`bash scripts/test-entrypoints.sh`。

## 一键停用（不卸载）

| 一条命令 | 做什么 |
|---|---|
| `mkdir -p ~/AgentHub/.hub && touch ~/AgentHub/.hub/DISABLED` | 停用中心引擎。重启 DSH 后引擎不再运行，只显示界面（界面会提示已停用）。 |
| `rm ~/AgentHub/.hub/DISABLED` | 恢复。再重启一次 DSH，引擎照常运行。 |

停用期间机器人不会被唤醒、不会跑回合；中心数据原样保留。

## 开发与测试（给实现方/总控用）

| 一条命令 | 做什么 |
|---|---|
| `bash scripts/sandbox.sh e2e` | 端到端冒烟：隔离沙箱 + 假模型，建一个机器人跑两个回合，不花真实额度。 |
| `bash scripts/sandbox.sh real` | 真实模型沙箱测试：沿用主人桌面版的模型配置（GLM）跑一个真实机器人的两个回合，会消耗少量额度。启动方式见脚本内注释：只把桌面版补丁的路径交给 dsh，脚本本身不读取它。 |
| `bash scripts/sandbox.sh install / run / dump / remove / status` | 沙箱环境的安装、前台启动、配置查看、移除与状态。 |
| `bash scripts/dev/ui-sandbox.sh` | 界面走查：开一个能在浏览器里点的隔离沙箱（端口 3951）+ 走查专用假模型，打印带 token 的网址。在队友线程里发带暗号的消息就能出对应场景：【提问】提问卡、【提议】提议卡、【审批】审批卡（批准后中心真的执行一次，发到假模型自己的 /hook-test）、【慢】回合故意拖 90 秒，用来测「打断」（要点两次确认）。Ctrl+C 结束。和 `sandbox.sh e2e` 共用 18080 端口，不要同时跑。 |
| `node scripts/dev/fake-model-cards.mjs` | 走查专用假模型本体（ui-sandbox.sh 会自动拉起，一般不用单独跑）。日志在 `.sandbox/fake-model-cards.log`。 |

## 其他资料在哪

- 设计资料（PRD、Grok Bot 功能清单、DSH 插件开发手册、可行性结论与证据）：`docs/design/`。
- 从 DSH 安装包只读解出官方源码的小工具：`tools/asar_extract.py`（核对 DSH 接口时用）。
