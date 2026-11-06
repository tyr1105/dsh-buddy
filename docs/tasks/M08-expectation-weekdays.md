# M08 维护卡：期望支持「只在某些日子检查」（工作日 / 周末 / 指定星期）

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M08.md`、`docs/questions.md`（只追加）
- 前置：M07 已合入。规格已由总控更新：`docs/build-spec.md` 的 `interface Expectation`（新增 weekdays）与第 6 节 tick 第 4 步「期望检查」的补充规则。以规格为准。

## 背景

主人想让一个盯守型队友盯「工作日 08:10 跑的模拟盘早盘日志」。现在期望只有「每天 HH:mm 前」和「每隔 N 毫秒」两种，周六、周日一定误报「期望落空」：队友被白白叫醒、日报里出现假的「未出现」。

## 要做

1. **数据**：`ExpectationSchema` 增加 `weekdays: number[] | null`。元素是 1–7 的整数（1=周一…7=周日，按 `settings.timezone` 的本地日期算），去重、升序、非空；`null` 表示每天。**旧存档兼容**：没有该字段的旧记录必须能正常读出并按 `null` 处理（不得因缺字段校验失败、不得丢数据），写回时补上 `null`。
2. **入口**：`hub_watch_propose`、`createBot` 的 watches 参数、以及能改期望的其他入口（如 `hub_watch_update`，若它支持改 expectation）都接受可选的 `expectation.weekdays`。工具导出的 JSON Schema 仍须满足 M06 的规则（根是 `type: object`、无 `$ref`/`$defs`、根无 oneOf/anyOf）。字段 description 写清：「只在这些日子检查：1=周一…7=周日；省略表示每天；工作日写 [1,2,3,4,5]」。非法值（0、8、小数、空数组）返回中文错误；重复值去重、乱序排好后保存。
3. **判断规则**（`perception/expectations.ts`）：按规格第 6 节 tick 第 4 步的补充规则实现：
   - byLocalTime 型：今天不在 weekdays 里 → 不判断。
   - everyMs 型：今天不在 weekdays 里 → 不判断；今天在 → 起算点 = max(最近满足时间或创建时间, 本段连续列出日第一天的本地 00:00)。
   - 「同一关注项同一本地日只报一次」的现有规则不变。
4. **文案**：机器人详情视图的 `expectationText` 体现日子：[1,2,3,4,5] →「工作日」；[6,7] →「周末」；其他 →「每周一、三、五」这种写法；null 不加。例：「早盘日志出现，工作日每天 08:20 前」。唤醒包或其他展示期望的地方同步。
5. **日报**：非检查日的期望写「今天不检查」，不标「未出现」。
6. **测试**（用注入的 Clock，时区 Asia/Shanghai）：
   - byLocalTime=08:20、weekdays=[1..5]：周六、周日 09:00 不报；周一 08:21 未满足 → 报一次，同日不重复报；周一 08:15 满足 → 不报。
   - everyMs=1 小时、weekdays=[1..5]：周五 22:00 最后一次满足；周一 00:30 不报；周一 01:01 报。
   - weekdays=null 的行为与改动前完全一致（回归现有期望测试）。
   - 旧存档（JSON 里没有 weekdays 字段）能读出、按每天处理。
   - 工具 schema 规则测试仍通过；非法 weekdays 的中文错误；重复与乱序被规范化。
   - 文案三种写法；日报「今天不检查」。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；`docs/progress/M08.md` 逐条写改法与测试名。
