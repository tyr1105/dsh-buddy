# D05 插件审查修复（不依赖 core 新接口的部分）

- 负责方：DSH
- 允许修改：`packages/plugin/`（不得改依赖）、`scripts/`、`docs/progress/D05.md`、`docs/questions.md`（只追加）
- 不得修改：`packages/core/`（Codex 正在另一份副本里做 M07，合入后由 D06 接线）、规格与任务卡
- 依据：`docs/reviews/PLUGIN-review.json`（confirmed 下标；每条有复现脚本与修法建议，复现脚本在 scratchpad/review-plugin/ 下，可读不要改）。下面按优先级列出，每条都要修并补「改坏即失败」的测试。

## 最高优先（装机必需）

1. [0][23] **默认根目录展开错误**：`expandHome('~/AgentHub')` 得到 `/AgentHub`。改为 `join(homedir(), p.replace(/^~\/?/, ''))`；测试精确断言 `resolveRootDir({}) === join(homedir(), 'AgentHub')`、`'~/X'` → `join(homedir(),'X')`、绝对路径原样、DISABLED 标记路径同步。
2. [12] **测试不得碰主人真实的 ~/AgentHub**：所有会启动真引擎的测试都用临时目录（AGENT_HUB_ROOT 指向 mkdtemp），测试结束清理；加一个守护：测试环境下若解析出的根目录等于 `join(homedir(),'AgentHub')` 就直接失败。
3. [1][24][38] **安装入口**：复制到 `$HOME/.agent-hub/` 的入口不能靠相对位置推算项目根。做法：`scripts/install-desktop.sh` 与 `uninstall-desktop.sh` 保留在项目里（项目根按自身位置推算，正确）；另写 `scripts/make-entrypoints.sh`（总控运行）：在 `$HOME/.agent-hub/` 生成两个**极短的入口脚本**，内容只有一行 `exec bash "<项目内脚本的绝对路径>" "$@"`（绝对路径在生成时写死并加引号）。安装脚本开头检查 `$PLUGIN_DIR/package.json` 存在且 name 为 dsh-agent-hub，否则中文报错退出；构建失败（pnpm 非零或「No projects found」）也要报错退出。用 `HOME=<临时目录>` 的方式写测试脚本验证入口（桩掉 dsh 与 pgrep）。
4. [28][17][33] **重载/卸载时新旧引擎并存**：插件 effect 的清理必须等待 `hub.stop()` 完成（cordis 的 effect 清理可以返回 Promise 时就返回；不行就用「启动锁文件 `<rootDir>/.hub/engine.lock`（写入 pid 与启动时间）」：新实例启动时若锁存在且对应进程仍活着、心跳 < 2 分钟，就等待最多 30 秒再接管，否则视为陈旧锁接管）；启动期间被卸载时，start 完成后立即 stop。测试：模拟卸载与快速重载，任何时刻只有一个 Hub 在 tick。
5. [14] **无人值守权限设置失败必须中止**：permissionPresets.set 或写 approval/policy 失败时，不得继续投递唤醒包（返回错误，让 core 按投递失败重排）；并且**只在建会话时**设置一次（核对已是 never 就不重复写），不要每次投递都写 3 条权限事件。
6. [15] **approval/request 对机器人会话失败即拒绝**：中心出错时返回 'rejected'（fail closed），不交给桌面面板。
7. [18][35][46] **pre-execute 钩子**：用 `{ prepend: true }` 注册；`next()` 只调用一次且放在 try 之外（守卫判断在 try 内，出错时对机器人会话拒绝、对普通会话 `return next()`）；下游抛错原样向上传，不吞、不重试。

## 次优先

8. [8] **唤醒改用中心身份投递**：按手册 3.3（verified-T2 Q2）用 `agent.followup(消息)`，`source.kind='agent-hub'`（带 wakeId、botId、variant），遵守四条约束（同一消息 id 不重复入队、消息里不能有 undefined、kind 不能是 plugin/user、不在 session/event 同步阶段投递）；建会话后的首条消息也用它（会话首轮落盘的要求见手册 3.2）。主人亲手的话（界面发消息）由 core 走 owner_message 唤醒包，仍经同一投递路径。翻译事件时以 source.kind 区分中心投递与主人亲手发言，不再依赖 requestId。若 followup 在某种情况下不可用，降级回 prompt 并在进度里写明。
9. [16][43] **DSH 另铸会话 id**：create 返回的 id 与预登记不同时，立即对新 id 补装 hub 工具与 restrict（在 resolveAgent 后对 agent 调用安装函数），并把映射登记给 core（HostPort.createSession 返回实际 id）。测试。
10. [22] **hub_commit 成功后调用 `exec.concludeTurn()`**：交账成功的那一步结束回合，省掉一次模型请求（注意手册 Q1-b：同一步不要 deferContext）。测试。
11. [7][25] **回合 token**：按回合累计所有请求的 usage（含失败尝试 assistant/attempt）；provider 不报用量时报 null 而不是 0。测试。
12. [2][3][26][34][39][36] **SSE 生命周期**：插件卸载时结束全部已打开的 SSE 响应并清保活定时器；引擎就绪前建立的 SSE 连接在引擎就绪后要能收到事件（门面 setImpl 时把已有订阅接到引擎上）；客户端 SSE 断开后按 1/2/5/10 秒退避重连，重连成功后补拉当前页并恢复界面（不能一断就整页显示「连不上」，只有连续 30 秒连不上才显示）。
13. [20] 停用（DISABLED）与「引擎启动中」时，界面显示对应提示（「中心已停用：删除 ~/AgentHub/.hub/DISABLED 后重启 DSH 即可恢复」/「中心正在启动…」），不要显示「连不上」。
14. [10] `listRecentSessions`：标题按 sessionController/sessions 的列表正确取（手册 3.11），排除机器人自己的会话与子代理会话，按更新时间倒序。
15. [11] 外部会话标题：启动时从会话列表回填标题缓存，之后再用 session/title 事件更新。
16. [19] selectModel 与还原全局默认串行化（全局一个队列），并发建两个机器人时全局默认最终保持原值。测试。
17. [21] cancel 兜底按 DSH 的取消原因契约传参（查手册 3.10）。
18. [45] tick 调度器同步抛出的异常也要接住（与文件头注释一致）。
19. [13][40] 冒烟跑者：判定「主人消息那一轮」的 reply 必须是 pokeBot 之后、且回复内容对应主人原话（假模型回「收到：<原话前 20 字>」）；H7 检查真正生效（预登记 id 与实际 id 比对写进摘要）。
20. [41][42][44] 测试补强：ownerHome 真的传进 createHub（断言参数）；建会话配方的顺序（预登记先于 create、selectModel 参数、权限失败时中止）；把 bot-tools.test.ts 里只断言「不抛错」的用例改成断言具体行为。

## 验收

```bash
pnpm --filter dsh-agent-hub typecheck
pnpm --filter dsh-agent-hub test
pnpm --filter dsh-agent-hub build
bash -n scripts/sandbox.sh && bash -n scripts/install-desktop.sh && bash -n scripts/uninstall-desktop.sh && bash -n scripts/make-entrypoints.sh
```

全部通过；跑完测试后 `ls ~/AgentHub` 不应因为测试而出现（如果它本来不存在）。`docs/progress/D05.md` 按编号逐条写改法与测试名。
