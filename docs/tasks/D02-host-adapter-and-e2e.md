# D02 宿主适配：把引擎接进 DSH（会话、工具、钩子、模型、事件），并在沙箱里端到端跑通

- 负责方：DSH
- 允许修改：`packages/plugin/`（不得改 dependencies/devDependencies）、`scripts/`、`docs/progress/D02.md`、`docs/questions.md`（只追加）
- 不得修改：`packages/core/`（有问题写进 questions，由总控转给 Codex）、`docs/build-spec.md`、`docs/tasks/`
- 前置：C04（core 的 createHub、UiApi、仿真）与 D01（插件外壳）已验收。

## 目标

让插件从「样例数据」变成真引擎：宿主半边创建 core 的 Hub，实现 HostPort（用 DSH 的会话接口建机器人会话、投递唤醒包、收口与取消、读状态），把 DSH 会话事件翻译成 Hub 的回合事件，把 hub_* 工具只注册给机器人会话，用 `tools/pre-execute` 钩子执行动作闸，给机器人会话设「无人值守」权限，按机器人选模型且不改全局默认，感知主人是否在用 DSH 和其他会话的结束/出错，推送用 macOS 通知。最后在隔离沙箱里用「本机假模型服务」自动跑通「建机器人 → 主人发消息 → 唤醒 → 调工具 → 交账 → 回复进线程」，不花真实额度。

## 必读

1. `AGENTS.md`；`docs/build-spec.md` 第 0、6.1、6.7、7、14、15、16 节；`docs/progress/C04.md`（core 的公共接口、HostPort、UiApi 的最终形状）、`docs/progress/D01.md`。
2. `docs/dsh-research/verified-T2-sessions-models.md`（建会话配方 Q1、自定义 source Q2、回合结束与取结果 Q3、按会话选模型 Q4、上下文占用 Q5）、`verified-T3-tools-hooks.md`（工具注册 Q1、只对机器人可见 Q2-a、restrict/guard Q2-b、pre-execute Q2-c、钩子通用规则 Q3-0、用量 Q4、turn-stopping S1、构造消息的约束 S2）、`verified-T4-presets-permissions.md`（2b、2c、2e、坑清单）、`verified-T6-storage-events.md`（第 3 节事件、主人是否活跃、睡眠唤醒、退出）、`verified-T8-testing-devloop.md`（第 2 节假模型服务、第 5 节冒烟跑者）、`verified-T1-plugin-anatomy.md` Q4（错误隔离）。
3. 用户机器上已验证可用的桥插件：`/Users/bytedance/Documents/cc/dsh-bridge-work/lib/index.js`、`lib/bridge.js`（建会话、prompt、cancel、projections、session/event 的真实用法）。

## 定下来的做法（与规格第 16 节不同之处以本卡为准，并由总控同步回规格）

- 机器人会话一律用 DSH 自带的 `standard` preset，不注册自定义 preset（运行时注册的 preset 只在内存，DSH 重启后机器人会话可能先于插件恢复而失败）。机器人的差异靠家目录 AGENTS.md、唤醒包和按会话收窄的工具实现。
- 按会话收窄：在机器人的 `agent.ctx` 上 `tools.restrict` 去掉 `ask_user_question`、计划模式相关、`schedule_*`、`create_goal`/`update_goal`、全部子代理/委派/workflow 工具、`plugin_manager`/插件市场、`working_directory`（准确工具名以 verified-T3 Q5-a 清单为准；restrict 遇到未知名字会抛错，先与当前可见工具求交集再调用，并 try/catch）。理由：子代理不受机器人作用域上的工具、钩子、guard 管辖，必须整体去掉。
- 「无人值守」：建会话时 `permissionPresets.set(session, 'workspace-write')`，再把该会话的审批策略设为 `never`（按 verified-T4 2b 第三条：只追加日志事件、不注入消息的方式），这样需要审批的操作会被 DSH 在分发前自动拒绝，不会弹框挂住。不改全局权限配置。
- hub_* 工具注册在每个机器人的 `agent.ctx` 上（照官方 dsh-experimental-tool-agent-team：apply 时遍历 `ctx.agents.list()` 补装；监听 `agent/created`（serial，监听器绝不能返回值、绝不能抛错）新装；`agent/disposed` 撤销；插件 effect 里全部撤销）。用 raw ToolDefinition：`parameters` 直接给 core 工具的 JSON Schema（去掉 `$schema` 键），`output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: value }] }`，`execute` 里调用 `hub.tools()` 对应处理函数（它自己用 zod 校验），失败就 `throw new Error(中文错误)`（工具失败不结束回合，模型会看到错误文字）。识别机器人：按名册里的 sessionId，排除 `header.origin === 'subagent'`。新建会话时先生成 `session-<uuid>` 预登记再 create（agent/created 早于 create 返回），并以返回的 sessionId 为准。
- 动作闸：全局 `ctx.on('tools/pre-execute', async (payload, next) => { … })`，只对机器人会话调用 `hub.guardToolCall(sessionId, toolName, args)`；拒绝时按 verified-T3 Q2-c 的拒绝返回形状返回（模型看到中文原因）；放行必须 `return next()`。非机器人会话直接 `return next()`。
- 模型：机器人有 model 时，建会话后 `selectModel` 并立刻 `agentDefaultModel.saveSelection(prev)` 还原全局默认（verified-T2 Q4，串行执行）；model 为 null 跟随 DSH 默认。设置页的模型选项用 `modelCatalog()`/`llm.listProviders()`（不读凭据）。
- 投递：首条与后续唤醒包都用 `sessionController.prompt({ sessionId, requestId: wakeId, mode: 'queue', content: [{ type: 'text', text }] })`（requestId 用唤醒单 id 以便事件里认出是中心投递的）；如果 verified-T2 Q2 证实能安全地带自定义 source（标记 agent-hub、界面可区分、不算主人授权），就带上并在进度里写明依据；否则不带。steer/cancel 用 resolveAgent 后的 agent 或 sessionController 对应方法。
- 回合事件翻译：`ctx.on('session/event', safe(...))`：机器人会话的 turn/start → started；每个 tool/call → step（steps+1，tokens 用 verified-T3 Q4-a 的用量字段累计，拿不到给 null）；turn/end（reason.kind）→ ended（finalText 取本轮最后一条 assistant 文本，reason error → error 事件带错误文本）；approval/asked → awaiting_approval；机器人会话里出现主人亲手发的 user 消息（不是我们投递的 requestId）→ owner_direct。非机器人会话：主人亲手发的 user 消息 → `hub.onOwnerActivity(now)`（排除桥投递：requestId 以 `claude-bridge-` 开头）；turn/end → `hub.onExternalSessionEvent`（finished 或 error，title 用会话标题）。
- 上下文占用：`sessionInfo` 用 contextPressure 投影算 `used / contextWindow`（verified-T2 Q5）。
- 推送：`notify` 在 macOS 用 `osascript -e 'display notification "正文" with title "标题"'`（execFile，不经 shell，正文里的引号与反斜杠转义，长度截到 200 字）；Settings.pushChannel 为 'none' 时不推；同时通过 SSE 让界面出现应用内提示。
- 引擎循环：`ctx.effect` 包 `setInterval` 每 60 秒 `hub.tick()`（防重入）；`init()`：解析 rootDir → 若 `<rootDir>/.hub/DISABLED` 存在则只提供界面（显示「已停用」）不启动引擎 → `createHub({ host, clock: 系统时钟, … store: new FileStore(…) })` → `await hub.start()`；卸载时 `hub.stop()`。所有对 DSH 的调用 try/catch，单个机器人出错不影响其他。
- 界面接口：把 D01 的 FixtureHub 换成真 Hub 的 UiApi（字段不变）；保留 FixtureHub 仅用于测试与 `AGENT_HUB_FIXTURE=1` 演示模式。

## 端到端（沙箱 + 假模型，必须做）

- `scripts/fake-model-server.mjs`：本机 `127.0.0.1:18080`，实现 verified-T8 第 2 节的 Anthropic Messages SSE 协议（message_start…message_stop、tool_use、input_json_delta、stop_reason）。按「剧本」应答：看到唤醒包（含「中心通知」）时，第一步返回 tool_use `hub_state_get`，收到工具结果后返回 tool_use `hub_commit`（完整合法参数：outcome progress、summary、worldChanges、evidence、verification、nextThink {mode:'after', afterMinutes: 90, reason}、importance 5，主人消息唤醒时带 reply「收到：<主人原话前 20 字>」），再收到结果后 end_turn 文本「已交账」。记录每次请求（不含 x-api-key）到 `.sandbox/fake-model.log` 便于验收。
- `scripts/sandbox.sh` 增加 `e2e` 子命令：只在沙箱进程环境里 export `DEEPSEEK_BASE_URL=http://127.0.0.1:18080/anthropic` 与 `DEEPSEEK_API_KEY=fake-local-test-key`（DEEPSEEK_BASE_URL 只能 export，不能写进 .env），沙箱 home 补丁把默认模型设为 `deepseek-official` / `deepseek-flash`；启动假模型服务与 web profile；挂一个测试专用的冒烟插件（`scripts/smoke-runner/`，照 verified-T8 第 5 节，含核查员的四处改正）：等中心就绪 → `createBot`（role researcher）→ 等 trial 交账 → `pokeBot` 主人消息 → 等第二次交账且线程出现 reply → 以退出码 0/1 结束并打印摘要；外层看门狗 180 秒。
- 绝不读取或写入 `~/.dsh`；假 key 只出现在沙箱进程环境里。

## 测试（vitest，`packages/plugin/test/`）

假 ctx 覆盖：建会话配方的调用顺序与参数（含预登记 id、rename、权限、never、selectModel 后还原默认）；投递用 queue 模式与 requestId；session/event → TurnEvent 的翻译（含主人直接发言、桥投递排除、子代理排除）；工具只装在机器人 agent 上、agent/created 监听器无返回值且吞掉异常、agent/disposed 撤销、restrict 先求交集；pre-execute 对非机器人直接 next、对机器人按 guard 拒绝或 next；notify 的转义与截断、pushChannel none 不推；tick 防重入；DISABLED 文件生效。测试数 ≥ 40。

## 验收

```bash
pnpm --filter dsh-agent-hub typecheck
pnpm --filter dsh-agent-hub test
pnpm --filter dsh-agent-hub build
bash -n scripts/sandbox.sh
```

全部通过。`bash scripts/sandbox.sh e2e` 由总控执行（需要启动常驻进程），你写好并在进度里说明预期输出。`docs/progress/D02.md` 写清每个 DSH 接口用法的依据（verified 文件条目或源码行号）、与本卡不同的地方及理由、已知限制。
