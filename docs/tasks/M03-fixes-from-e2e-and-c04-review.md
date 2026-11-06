# M03 维护卡：沙箱端到端发现的 core 问题 + C04 独立验收的问题

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M03.md`、`docs/questions.md`（只追加）
- 前置：M02 已完成并合入。修完后全部测试、仿真与场景必须仍然通过。

## 第一部分：真实 DSH 沙箱端到端暴露的唤醒包问题

总控在隔离沙箱里用真实 DSH + 本机假模型跑通了「建机器人 → 试跑交账 → 主人发消息 → 回复进线程」。假模型收到的试跑唤醒包（节选）：

```
## 为什么叫醒你
<<<untrusted
主人创建了你，请试跑并交账（类型 trial，分数 1，门槛 0.6）
untrusted>>>

证据：
<<<untrusted
- [asp_kkxhogvrgn] - 记录 [asp_kkxhogvrgn]
untrusted>>>
```

1. 信任边界放错了：「为什么叫醒你」的理由句、证据列表都是中心按规则生成的（可信），不应进不可信围栏；只有**外部来源**的原文（关注项抓到的网页/文件/脚本输出/同伴原话/会话摘要等 untrusted=true 的感知正文）才进围栏。改为：理由句与证据条目直接写；证据条目里如果要引用外部原文，只把原文片段放进围栏。
2. 证据条目是占位文字「记录 [id]」：改成人能读懂的一句话，按证据类型渲染：感知 →「{来源}：{摘要前 80 字}（{时间}）」；议程 →「议程：{标题}（到期 {时间}）」；志向/目标 →「志向：{文本前 60 字}」「目标：{标题}」；收件箱 →「你问过主人：{标题} → 主人答：{答案}」；审批 →「审批单：{工具} {状态}」。找不到记录时写「（记录已过期）」。
3. trial/teach 的回合上限按规格第 5 节（30 步 / 20 分钟 / 6 万），唤醒包里的「本次上限」与回合守卫一致（若 M02 已修，这里只补测试）。
4. 测试：对每种变体构造包含外部感知的场景，断言外部原文只出现在围栏内、中心生成的理由与证据不在围栏内；证据渲染每种类型一条断言。

## 第二部分：C04 独立验收（编号对应 `docs/reviews/C04-review.json` 的 confirmed 下标；复现脚本在 scratchpad/review-C04/）

### 死人开关与主动性（影响主人体验，最优先）
- [2][23] 死人开关只应检测「掉线/卡住」，不能把中心**有意**推迟（bot_budget、quota、cooldown、pace_min、quiet、startup_quiet、dispatch_gap、concurrency、retry_backoff 等闸门压住的候选）当成「该动没动」。要做：checkDeadman 先看该机器人队列里是否有被闸门压住的条目（或最近一次 AppraisalLog 是 suppressed 且 until 在未来），有就把 expectedBy 顺延到该 until + 30 分钟，不告警、不排 retry。7 天综合仿真里健康宿主的 deadman 告警必须为 0：场景 18 增加断言「deadman 告警 = 0、retry 唤醒 = 0（除非注入了故障）」，并逐条断言单推的来源类型（提问/审批/告警/日报），不得再把误报固化进快照。
- [0] 第 3 道闸（等主人同一件事）丢弃的感知要标记已处理；放行时按规格「消费相关感知」：同机器人、同 subjectKey（或同 watchId）、创建不晚于放行时刻的未消费感知一并消费。场景 7b 在主人作答后再推进 24 小时，断言没有 deadman 告警、没有 retry 唤醒、总回合 ≤ 1。
- [6] 红灯恢复时队列为空就不发探针（不造 retry 唤醒），等下一个真实候选当探针。
- [22] T3 场景要检查「中心按约唤醒」：机器人约的 next_think 时刻到点（误差 ≤ 2 个 tick）确实发生了 next_think 唤醒；拆掉意图时钟时该场景必须失败。

### 稳健性
- [9] 宿主调用不返回会永久卡死中心：core 不能用定时器，所以做两层：① HostPort 的每个调用由宿主实现负责有界（在 HostPort 接口注释里写明「必须在 N 秒内返回或抛错」）；② core 侧给串行通道与 tick 锁加「过期释放」：记录 tick/flush 的开始时间，下一次 tick 发现上一次已运行超过 5 分钟仍未结束，就记 P1 告警、放弃等待它（不再阻塞后续 tick），并把卡住的唤醒单按错误处理。测试：注入一个永不返回的 host.deliver，后续 tick 仍能运行、其他机器人仍能被唤醒。
- [4] 已交账但宿主没报 ended 的回合：不能被卡住检测改成 timeout、计错误、排重试；按 M02 的约定，committed 之后 10 分钟没 ended 就直接收尾为 committed。
- [5][14] start 时设置的合并顺序：默认值 < 存储里的设置 < 宿主传入的设置（rootDir、heartbeatPid 这类「宿主事实」永远以宿主传入为准）；存储里的 rootDir 与宿主不同时记一条审计。
- [3][20] 候选评估游标持久化（或启动时以「已消费/已丢弃/已记录」状态为准重建），重启后不得把旧感知重新排队；seen/decisions 按保留期裁剪，不无界增长。
- [12][17] 中心步骤失败告警：同一步骤连续 2 次失败才开，恢复成功即关闭，不占单推预算（P2 只进日报）；解除隔离时关闭对应的 quarantine 告警与告警卡。
- [13] dispatch 前若 host.sessionInfo 显示该会话正在运行（主人在直聊），就等它结束再投递（候选保留，记 suppressedBy=concurrency）。

### 命令与生命周期
- [10] 解除隔离：试岗期内的机器人回到 probation（不直接转正），自主等级上限按试岗规则；暂停跨过试岗期后恢复，自主等级上限 L2（L3 只能主人手动设）。
- [7] teach 对 paused/retired/quarantined/draft 的机器人返回中文错误，不假装成功。
- [11] 宿主审批框转成的中心审批单：主人批准后机器人重试应能放行一次（与 7.3 的批准票同一机制：contentHash 用工具名 + 宿主给的 summary），或者干脆不为宿主审批框建单、只告警（二选一，写清理由）。
- [15] 主人重新启用已到期的机器人自建关注项时，expiresAt 顺延 30 天（或清空），不被下一个 tick 立刻过期。
- [16] 夏令时午夜开始的时区，「每天」目标的周期计算不得失败（Asia/Shanghai 无夏令时，但实现要通用）。
- [18] 回合进行中暂停：回合结束后状态为 paused，卡片文案「已暂停（你暂停的）」。
- [19] 退役档案不占「6 个上限」与「总管 1 个」名额（只统计非 retired）。
- [8] 校验错误文案去掉 zod 的英文默认信息，统一中文。

### 线程视图
- [1] card 只挂在 kind 为 question、approval、proposal、alert 的消息上，且只认 refId 精确等于收件箱 id；删除按 refId 回退匹配；点子池项（closed + idea_pool）永不生成卡片。测试：reply、report、system、主人回执消息的 card 一律为 null。

### 测试补强
- [21] tick 第 1 步（睡眠检测与补课）与第 9 步（回合上限收口/取消、卡住取消）各加能「拆掉即失败」的测试。
- [24] stop() 的两条要求用可证伪的断言：在途回合的 host.cancel 未被调用、FsIO.watch 的取消函数全部被调用。
- [25] 投递细节：thinking 状态与「正在处理：…」文案；主人消息在同一次 pump 连续放行；红灯时给主人线程的系统说明。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；`docs/progress/M03.md` 逐条写怎么修的与新增测试。
