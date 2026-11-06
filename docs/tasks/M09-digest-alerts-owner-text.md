# M09 维护卡：M08 审查问题 + 界面走查暴露的核心问题

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M09.md`、`docs/progress/M08.md`（只改第 5 条说明不实的句子）、`docs/questions.md`（只追加；M08 段第 2 条用追加「更正」的方式，不删原文）
- 前置：在 M08 的成果上继续（同一份副本）。规格已由总控更新：`docs/build-spec.md` 第 6 节 tick 第 4 步（日报口径、生效时刻、everyMs 上限）、第 5 节阈值表「告警」行、7.3 末尾两条（审批人话、面向主人的文字）。以规格为准。
- 证据：对抗审查结果的复现脚本在 `/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/review-m08/` 下（可读，不要改）；界面走查的现象写在下面每条里。

## 1【高】日报按「被统计的那天」判断检查日（M08 审查 [0][1][3][6][7][9]）

现象：`outreach/digest.ts` 第 63–67 行先看「今天」是不是检查日，不是就写「今天不检查」并跳过——工作日期望下，周五漏跑在周六、周日、周一的日报里都看不到（真实 Hub tick 复现：周五落空感知存在，但没有任何一份日报写「【未出现】」）。[1,3,5]、[6,7]、[6,7,1] 同理。测试 `m08-weekdays-display.test.ts` 第 70–76、114–119 行把这个错误当成了预期。

要做：
- 期望行只按统计日（昨天）判断：昨天不是检查日 → 「昨日不检查」；昨天是检查日 → 照常「已出现 / 【未出现】」，与今天是否检查无关。
- 改掉上述错误断言；新增整周端到端测试（用 createHub 或仿真推进 tick，时区 Asia/Shanghai）：weekdays=[1..5]，周四满足、周五漏跑、周末无日志、周一满足、周二漏跑 → 周五到下周三的日报期望行依次为：已出现（周五日报统计周四）、【未出现】（周六统计周五）、昨日不检查、昨日不检查、已出现、【未出现】。再各补一组 [1,3,5] 与 [6,7]：每个检查日的结果都必须出现在次日日报里。

## 2【低】everyMs 不能超过最长连续检查段（M08 审查 [2]）

现象：[1,3,5] 配 24 小时、工作日配 7 天的期望按「检查段第一天零点起算」永远不会落空，入口也不拦。
要做：weekdays 不为空且不满 7 天时，算出最长连续检查段 L 天（周日接周一要连起来算），everyMs > L×24 小时 → 中文错误「everyMs 超过最长连续检查段（L 天），按检查日起算永远不会落空；请改用 byLocalTime 或缩短间隔」。hub_watch_propose、createBot、upsertWatch、反思交账新增关注共用这条校验。测试正反例。

## 3【中】期望生效之前的时间不判（M08 审查 [8]，基线就有）

现象：主人下午 15:00 让队友盯「每天 08:20 前出现」的日志，关注项一建好当天就判「期望落空」，队友被叫醒、日报写【未出现】——首日必然误报。
要做（规格 tick 第 4 步）：期望的生效时刻 = 关注项转为 active 的时刻与期望被设置/修改的时刻中较晚者（没有现成字段就在 Expectation 里加一个，旧存档缺省按关注项 createdAt，参照 M08 的兼容做法）。byLocalTime 期限早于生效时刻的那一天不判；everyMs 从生效时刻起算；日报对生效前的统计日写「昨日尚未开始检查」。测试：15:00 建 08:20 期望 → 当天不报、次日 08:21 未满足才报；提议型关注项第二天才被主人接受 → 从接受时刻起算。

## 4【低】时区测试要真的换时区（M08 审查 [5]）

`m08-weekdays-expectations.test.ts` 第 69 行附近：把设置时区改成非上海（例如 America/New_York 或 UTC），断言 checkExpectations 的 byLocalTime 判断、everyMs 起算点、buildDigest 的「昨日不检查 / 已出现 / 未出现」都跟随 settings.timezone。

## 5【中】更正不实说明（M08 审查 [4]）

`docs/questions.md` M08 段第 2 条与 `docs/progress/M08.md` 里「今天的真实落空仍会进入后续日报」的说法不成立：按第 1 条修好后，用追加「更正」的方式写清新口径。

## 6【中】同一告警重复建两条（界面走查）

现象：沙箱里额度用尽时，收件箱出现两条一模一样的「中心告警：quota」（P0，相隔 2 毫秒建的两条告警 al_…）。原因：`health/alerts.ts` 的 `raiseAlert` 查「上一条」时要求 `alert.lastAt <= now`；`turn/events.ts:62` 用宿主事件时间 `at` 调 `restForQuota`，其他路径用时钟 `now`，两个时间先后颠倒时，后到的那次找不到先建的记录，就新建一条。P0 不受打扰预算限制，主人会收到两条同样的推送。
要做：同一 code + botId 查找已有记录时不依赖时间戳先后（按 lastAt 取最新一条，合并窗口按绝对差值判断）；任何时刻同一 code + botId 最多一条开放告警；lastAt 取较大者。测试：两次 raiseAlert 时间戳倒序（相差 2 毫秒）→ 只有一条告警、一张收件箱卡、一次推送请求。

## 7【低】告警标题用中文名（界面走查）

现象：收件箱标题是「中心告警：quota」。要做：`outreach/alerts.ts` 标题按 code 映射中文名（quota→额度、auth→鉴权、deadman→掉线、quarantine→隔离、protected_verify→受保护文件校验、host_approval_blocked→宿主审批受阻、host_approval_wait→宿主审批等待；未知 code 退回「异常」），形如「中心告警：额度」「巡检员告警：掉线」。测试覆盖全部 code。

## 8【中】审批卡说人话（界面走查）

现象：审批卡标题「批准动作：hub_outbox_execute」，正文是原始 JSON（`{"kind":"http_post","payload":{"body":"{\"test\":true}","url":"http://127.0.0.1:18080/hook-test"}}`）。主人是产品经理，看不懂内部工具名和 JSON。
要做（`gate/approvals.ts` 第 42 行一带）：按工具与参数生成一句人话的动作描述，用于标题「批准：<动作>」和正文第一行；正文接着写分类与理由；原始参数放在正文最后一行「原始参数（供核对）：…」，最多 300 字。至少覆盖：hub_outbox_execute 的四种 kind（发通知、写文件 <路径>、向 <域名> 发送网络请求、运行命令 <命令行前 60 字>）、bash（运行命令 …）、write/edit（写入/修改文件 <路径>）、web_fetch（访问 <域名>）、其他工具（执行 <工具名>，作为兜底）。线程里 kind=approval 的那条消息同样用人话。测试每种描述，并断言标题与正文第一行不含内部工具名。

## 9【中】给主人看的文字不夹带写给机器人的指令（界面走查）

现象：主人批准后，队友状态栏显示「审批单 ap_… 已批准，由中心执行出站动作，请等待中心结果，不要再次调用」，线程系统消息也是这句——这是写给模型的指令。批准的出站动作执行完以后，主人在线程里看不到结果。
要做：
- `gate/approvals.ts` 第 81 行那段 summary 分两份：给机器人的（原文，进唤醒包）与给主人的（「你批准了：<动作>，中心会在下次巡检时执行」「你拒绝了：<动作>」「审批已过期：<动作>」，附言照带）。机器人状态（activityText，含 queued/thinking 的「正在处理：…」）与线程系统消息只用给主人的那份。其他把候选 summary 直接当状态文字的地方一并检查（例如 inbox_reply、outbox_done），凡是写给机器人的指令性句子都不进主人可见的文字。
- 中心执行完主人批准的出站动作后，在该机器人线程写一条系统消息：「已执行你批准的：<动作> → 成功（HTTP 200）」或「→ 失败：<一句原因>」。
- 测试：批准、拒绝、过期三种情况下，bot 视图的 activityText、线程系统消息都不含「不要再次调用」「用完全相同的参数」等字样；唤醒包里仍有给机器人的原句；出站执行后线程出现结果消息。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；`docs/progress/M09.md` 逐条写改法与测试名。
