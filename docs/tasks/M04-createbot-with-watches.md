# M04 维护卡：新建机器人时带起步关注项会失败

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M04.md`、`docs/questions.md`（只追加）
- 前置：M03 已合入主目录（本卡直接在主目录做，此时没有其他实现方在改代码）

## 现象（总控在真实模型沙箱测试中发现）

`createBot` 输入里带 `watches`（界面「新建队友」向导第 5 步就是这个用法）时必然失败，返回「关注项所属机器人不存在」。

## 根因

`src/api/bots.ts` 的 `createBot` 为了「全部输入预检成功后才落表」，先 `makeWatch(ctx, bot, …)` 再 `put(bot)`；而 M02 加的关注项访问检查 `src/perception/access.ts` 的 `watchGateContext(ctx, botId)` 要到 `bots` 表里查机器人，此时还没落表，于是抛错。现有测试没有覆盖「新建时带关注项」这条路径。

## 要做

1. 让关注项的访问检查可以直接用传入的 Bot 对象构造 GateContext（例如 `watchGateContext(ctx, botOrId)` 接受 Bot 或 id；`makeWatch` 与 `assertWatchPathAccess`、`assertHttpWatchAccess` 一路把 bot 传下去），预检阶段不依赖存储。其余调用点（运行时读取、主人界面、机器人工具）行为不变。
2. 检查同一模式的其他预检（goals、script 命令校验 `validateCommand` 等）是否也依赖落表后的数据，有就一并改。
3. 测试：
   - `createBot` 带每种 kind 的关注项（file、log、http、rss、script（家目录内脚本）、session）各一条，全部成功落表，状态正确；file/log 关注项在创建后被 `syncFileWatches` 注册监听。
   - 带敏感路径的关注项（`~/.ssh`、`~/.dsh/.credentials.yaml`、工作数据目录）仍被拒绝，且拒绝时**不留下**半个机器人（bots/aspirations/watches/goals 表与家目录都回滚）。
   - 仿真：在 `createSimWorld` 场景里用带 file 关注项的 createBot 建机器人，写入被关注文件后能产生感知并唤醒（端到端证明起步关注生效）。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；`docs/progress/M04.md` 写清根因、改法、新增测试名。
