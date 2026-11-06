# D06 接上 core 的 M07 新接口

- 负责方：DSH
- 允许修改：`packages/plugin/`（不得改依赖）、`scripts/`、`docs/progress/D06.md`、`docs/questions.md`（只追加）
- 不得修改：`packages/core/`、规格与任务卡
- 前置：D05 已验收；M07 已合入主目录。**接口说明以 `docs/progress/M07.md`「插件接线」一节为准**（签名、参数、返回、注意事项都在那里）。

## 要做

1. **settings 变成异步**：`hub.api.settings()` 现在返回 Promise。所有调用点（设置路由、推送渠道读取等）改为 await；同步取不到时不要阻塞投递（推送渠道可缓存最近一次结果，设置变化事件到来时刷新）。
2. **打断**：界面「打断」按钮改为调用 `hub.api.interruptBot({ botId })`（经路由命令），删掉插件自己的 cancel 与系统消息（core 会写）。另外：主人在 DSH 自己的会话界面里停止机器人回合时（turn/end 的 reason 是取消/中止类，且不是中心发起的取消），翻译成 `{ type: 'interrupted', sessionId, at, by: 'owner' }` 交给 `hub.onTurnEvent`；中心自己因上限或卡住而取消的，不翻译成 interrupted（core 已先记录 timeout，会忽略）。测试。
3. **生命周期按钮**：暂停 / 恢复 / 提前转正 / 解除停用 / 退役 全部改用 `hub.api.lifecycleAction({ botId, action })`，按机器人当前状态只显示合法的按钮（例如试岗未满 3 天不显示「提前转正」或显示为禁用并提示还差几天，以 core 返回的错误为准）。
4. **卡片作答**：线程卡片与收件箱都用视图给的 `options` 渲染按钮，原样回传用户点的那一项；审批卡用 `decideApproval(card.approvalId, option === '批准', note)`（**不要把 inboxId 当 approvalId**），其他卡用 `answerInbox(inboxId, option)`；提问卡仍支持自由文本。
5. **推送范围**：界面按 `HUB_EVENT_SCOPES`（overview、bot、thread、inbox、activity、settings）与 botId 规则刷新对应视图（M07.md 第 4 节的表）；删除对内部表名（bots/wakes/watches…）的匹配。
6. **模型目录**：建引擎时传 `listModels`：从 DSH 的模型目录取可路由的模型（手册 3.5/Q4：`sessionController.modelCatalog()` 或 `llm.listProviders()` + `listModels()`，只取 routable 的），映射为 `{ provider, model, label }`，失败时抛中文错误（不要返回空数组冒充「没有模型」）。界面新建向导第 4 步与右栏档案编辑的模型下拉使用 settings 视图的 modelOptions。
7. **回归**：插件全部测试通过；`bash scripts/sandbox.sh e2e` 仍通过（你可以跑它，跑前确认没有别的沙箱进程占用 3952/18080 端口）。

## 验收

```bash
pnpm --filter dsh-agent-hub typecheck
pnpm --filter dsh-agent-hub test
pnpm --filter dsh-agent-hub build
bash scripts/sandbox.sh e2e
```

全部通过；`docs/progress/D06.md` 逐条写改法与测试名、e2e 输出摘要。
