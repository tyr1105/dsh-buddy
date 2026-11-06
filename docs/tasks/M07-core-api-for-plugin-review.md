# M07 维护卡：插件审查暴露的 core 接口缺口

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M07.md`、`docs/questions.md`（只追加）
- 前置：M06 已合入。插件侧的配套修改由 DSH 在 D05 里做（本卡完成后会把接口写进 progress，DSH 照用）。
- 依据：`docs/reviews/PLUGIN-review.json`（编号见下）

## 1. 主人「打断」（审查 [9][27][37]）

现状：插件的「打断」按钮直接 cancel 回合，core 收到的是「回合结束但没交账」，计一次 no_commit；连打断两次下一轮被强制复盘，第三次机器人被隔离。要做：
- `TurnEvent` 增加 `{ type: 'interrupted', sessionId, at, by: 'owner' }`：对应唤醒单 status=canceled（新增或复用取消状态，记 `canceledBy: 'owner'`），**不计** no_commit、不计错误、不触发复盘或隔离；机器人回到 watching，线程写系统消息「你打断了它；它会在下次醒来时接着处理」；该回合消费的感知恢复为未消费（下次醒来仍能看到）。
- UiApi 增加命令 `interruptBot({ botId })`：机器人有 running/delivering 唤醒单时，先在 core 里标记为主人打断（防止随后到来的 ended/error 被当成未交账或出错），再调用 `host.cancel(sessionId)`；没有在途回合时返回中文错误「它现在没在处理事情」。
- 测试：连续打断 5 次，consecutiveNoCommit、consecutiveErrors 都为 0，lifecycle 不变；打断后到来的 ended/error 事件不改变结果；打断后主人发消息，下一轮是正常回合（不是复盘）。

## 2. 生命周期用「动作」而不是「目标状态」（审查 [30]）

现状：界面「恢复」发 `setLifecycle(active)`，试岗未满 3 天的机器人恢复失败，满 3 天的被静默提前转正。要做：UiApi 增加 `lifecycleAction({ botId, action })`，action ∈ pause / resume / promote / release_quarantine / retire：
- resume：回到暂停前的生命周期（暂停时记录 `pausedFrom`）；若暂停期间试岗已到期，按试岗到期规则转 active（自主等级上限按 M03 规则）。
- promote：只在试岗满 3 天且无越界时允许（否则中文错误说明还差几天或有越界）。
- release_quarantine：按 M03 规则（试岗期内回 probation）。
- 保留原 `setLifecycle` 以兼容，但界面改用新命令。测试每个动作的正反例。

## 3. 收件箱作答的取值约定（审查 [5][29]）

现状：提议卡片「不做」按钮发 `answer='不做'`，core 不认。要做：
- 规定每类收件箱项的合法回答，并通过视图 `card.options` 原样给出（界面只需把用户点的那个 option 原样回传）：proposal → ['接受', '不做']；approval → 走 decideApproval（视图里给出 `['批准', '拒绝']` 供显示）；question → 机器人给的 options 或自由文本；alert → ['知道了']。
- `answerInbox` 对 proposal 接受同义词（接受/同意/好/accept 与 不做/拒绝/不要/reject，大小写与空白不敏感），其余返回中文错误并列出合法值。
- 测试：每类卡片的 options 与 answerInbox 的往返。

## 4. 推送事件的范围名（审查 [4]）

现状：界面只认 scope='bot'，core 发的是 'bots' 等名字，右栏不随推送刷新。要做：在 `src/api/` 导出一份**推送范围常量表**（例如 `HUB_EVENT_SCOPES = { overview, bot, thread, inbox, activity, settings }`）并在文档注释写清：每次 emit 用哪个 scope、botId 是否必带；core 内所有 emit 改用这份常量（对机器人相关的变化一律带 botId）。测试：每种变化（交账、感知、议程、关注、生命周期、收件箱作答）发出的 scope 与 botId。

## 5. 设置视图的模型选项（审查 [6][31]）

现状：`SettingsView.modelOptions` 只有「跟随默认」。要做：`createHub` 依赖增加可选的 `listModels?: () => Promise<Array<{ provider: string; model: string; label: string }>>`（由宿主提供 DSH 模型目录）；`settings()` 视图与新建/编辑机器人时的校验都用它（provider/model 不在目录里 → 中文错误）；没提供时保持现状。测试。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；`docs/progress/M07.md` 写清新增接口的签名与用法（DSH 要照着接）。
