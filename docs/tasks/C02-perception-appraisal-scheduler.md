# C02 感知、评估、内驱、意图时钟、调度决策、额度、健康

- 负责方：Codex
- 允许修改：`packages/core/`（src、test）、`docs/progress/C02.md`、`docs/questions.md`（只追加）
- 前置：C01 已验收（model、config、io、util、store 可用）

## 目标

实现主动性引擎的「眼睛和闸门」：把世界的变化变成带分数的感知，算出每个机器人此刻该不该想、为什么；把候选放进队列，按闸门与优先级决定下一个放行谁（只做决定，真正投递在 C04）；记好每一次「为什么醒 / 为什么没醒」。另外实现额度与健康的计算部分。

## 必读

`AGENTS.md`；`docs/build-spec.md` 第 5、6.1–6.6、6.10、6.11、13 节（逐条实现），第 3、4 节（类型与存储，C01 已实现，先读 `packages/core/src` 熟悉）；`docs/progress/C01.md`。

## 要做

### 0. `src/engine/context.ts`

```ts
interface HubContext {
  store: Store; clock: Clock; rng: Rng; fs: FsIO; net: NetIO; exec: ExecIO; host: HostPort; logger: Logger
  settings: Settings
  runtime: HubRuntime        // 只在内存、不落盘的运行态（见下）
  emit(scope: string, botId?: string | null): void   // 通知界面有变化
}
interface HubRuntime {
  startedAt: number; lastTickAt: number | null; lastDispatchAt: number | null; ownerActiveAt: number | null
  pendingFileEvents: Map<string /*watchId*/, { firstAt: number; lastAt: number; paths: Set<string>; kinds: Set<string> }>
  watchDisposers: Map<string /*watchId*/, () => void>
  suppressionLogAt: Map<string /*botId+gate*/, number>   // 同一闸门 10 分钟内只记一次日志，防刷屏
  lastHeartbeatAt: number | null
}
```
并在 `src/io/testing/` 增加 `createTestContext(overrides?)`：MemoryStore + FakeClock(默认 2026-11-05 10:00 北京时间) + SeededRng + MemoryFs + FakeNet + FakeExec + 记录调用的假 HostPort + MemoryLogger + resolveSettings({rootDir:'/hub'})。

### 1. 感知 `src/perception/`

- `percept.ts`：`recordPercept(ctx, input) → Percept | null`。input 给出 botId、watchId、source、kind、summary、location、指纹原料、magnitude、anomaly、untrusted、发生时间；内部算 relevance/novelty/importance/urgency（第 6.2 节）、salience 与 tier；同机器人同指纹 24 小时内出现过 → 不建感知、写一条 AppraisalLog(decision='record_only', suppressedBy='dedup') 返回 null；否则落表并写 AppraisalLog（decision 先按 tier：urgent/candidate → 'queued' 由调用方在入队后覆盖为最终决定；pile → 'pile'；record → 'record_only'）。summary 截断到 500 字。
- `sources.ts`：主人消息、同伴消息、交接、收件箱回复、审批结果、停机等「特例」感知的构造函数（第 6.2 节特例分数）。
- `http.ts`、`rss.ts`、`script.ts`：三类轮询执行器；`pollDueWatches(ctx, now)` 找出到期的 active 关注项（http/rss/script），并发 ≤ 3 执行；失败只记该关注项（watch 上记 `lastError` 文本放进 lastValue 的 JSON 里或单独字段，自己定，写进进度记录），连续 3 次失败 → 该机器人 P2 告警（调用 health/alerts）。
  - http：`NetIO.get`（超时 20 秒、512 KB）→ `stripHtml` → sha1；首次检查只记录基线不产生感知；之后变化 → changed 感知，magnitude = lineDiff.changeRatio，summary 给前 3 行新增内容。
  - rss：最小 RSS 2.0 / Atom 解析（正则或简单状态机即可，读 item/entry 的 title、link、guid/id）；首次只记基线（已见 id 存 lastValue，最多保留 200 个）；新条目 → new_items 感知，magnitude = min(1, 新条目数/5)，summary 列标题。
  - script：target 按空白拆参数（支持双引号）；程序必须是机器人家目录内的文件，或白名单程序 `git`（仅 status/log/diff/show 子命令）、`ls`、`cat`、`wc`、`node`、`python3`（后两者的脚本参数必须在家目录内）；否则拒绝执行并记错误。ExecIO 超时 30 秒、64 KB；cwd=家目录。比较 stdout sha1 与退出码（第 6.2 节）。首次只记基线。
- `files.ts`：`syncFileWatches(ctx)`：为 active 的 file/log 关注项调用 `FsIO.watch`（recursive=true），非 active 的取消；事件进 `runtime.pendingFileEvents`；`flushFileEvents(ctx, now)`：firstAt 距今 ≥ 2 分钟的批次变成一条感知（file：changed/created/deleted 按 kinds 归纳，magnitude = min(1, 路径数/5)；log：读 target 文件比上次大小多出的尾部（上次大小存在 watch.lastValue 的 JSON 里），≤ 4 KB 进 summary，并把带 expectation 的关注项 lastSatisfiedAt 设为 now）。target 支持单个文件路径或目录；glob 只支持末尾 `*.扩展名` 一种（目录内过滤），其他写进 questions。
- `expectations.ts`：`checkExpectations(ctx, now)`：everyMs —— 距 lastSatisfiedAt（没有则 createdAt）超过 everyMs；byLocalTime —— 今天该时刻已过且今天没满足。落空 → expectation_missed 感知（anomaly，urgency 1），同一关注项同一天只报一次（lastMissedAt）。
- `sessions.ts`：`onExternalSessionEvent(ctx, e)`：匹配 kind=session 的关注项（target 'any' 或标题包含关键词）→ session_finished / session_error 感知（error 为 anomaly）。

### 2. 评估 `src/appraisal/`

- `salience.ts`：纯函数 `computeSalience(parts) → {salience, tier}`，严格按第 6.2 节公式与分档。
- `pile.ts`：`evaluatePile(ctx, botId, now) → Candidate | null`：同机器人未消费、tier=pile 的感知显著性合计 ≥ 1.0 → 候选（kind='pile'，分数 = min(0.85, 0.70 + 0.05×(条数−2))，证据为这些感知 id）。
- `think.ts`：`agendaUrgency(item, now)`、`thinkScore(...)`、`thresholdFor`（用 C01 的辅助函数）；`buildCandidate(...)` 统一生成候选结构（含 subjectKey：感知用 `watch:<watchId>` 或 `src:<source>:<kind>`，议程用 `agenda:<id>`，内驱用 `drive:<名字>:<goalId?>`，主人消息用 `owner:<messageId>`，提问回复用 inbox 的 subjectKey）。
- `log.ts`：`logAppraisal(ctx, entry)` 与中文解释生成（例：「文件 export.csv 有 3 处变化，显著性 0.74 ≥ 门槛 0.66，排队」「同一件事 6 小时内已处理过，冷却到 16:20」「在等你回复同一件事，不再叫醒」「今天已想了 6 次，到上限」）。

### 3. 内驱 `src/drives/`

`computeDrives(bot, goals, agenda, inbox, handoffs, commits, budgetUsedRatio, now) → DriveValues`（纯函数，第 6.4 节）；`evaluateDrives(ctx, now) → Candidate[]`：每机器人每天触发 ≤ 2 次、触发后该内驱暂缓 24 小时、写 DriveState。受挫判断：最近 3 次交账 outcome 都是 blocked 且 blocker 的 fingerprint 相同。

### 4. 意图时钟 `src/agenda/`

- `clock.ts`：`collectTimeCandidates(ctx, now) → Candidate[]`：到期议程（toOwner 承诺 0.95 / 普通 0.85 / 1 小时内 0.70，第 6.3 节）、nextThinkAt 到期（0.75，kind=next_think）、lightCheckAt 到期（kind=light_check，variant=light_check）。
- `next-think.ts`：纯函数 `applyNextThink(bot, nextThink, now, ctxInfo) → Partial<Bot>`（第 6.5 节：at/after 夹到 [now+有效 pace_min, now+pace_max]；on_event 与 auto 只设 lightCheckAt；记录 nextThinkBy/Mode/Reason；at 文本用 C01 的 parseFlexibleTime，解析失败按 auto 处理并在返回里带 warning）；`refreshLightCheck(bot, now, settings, hasActiveGoal)`。
- `watch-expiry.ts`：机器人自建关注项到期 → status=expired。

### 5. 调度决策 `src/scheduler/`

- `queue.ts`：`enqueue(ctx, candidate)`：同一机器人只保留一条 QueueEntry——新候选分数更高则替换 reason，证据合并去重，ownerInitiated/urgent 取或，priority 取大，variant 取「更重」的（regular > catch_up > light_check；trial/teach/reflection 一旦出现保留）；写 AppraisalLog(decision='queued')。`removeEntry`、`listQueue`。
- `priority.ts`：第 6.6 节优先级表的纯函数。
- `pacing.ts`：`effectivePaceMinMs(bot, settings, quotaLight)`（基础 × 节奏档 × 2^noChangeStreak 封顶 24 小时；yellow 时非 urgent 再 ×2）；`afterOutcome(bot, outcome, hadHighPercept) → Partial<Bot>`（退避与复位）。
- `gates.ts`：纯函数 `evaluateGates(entry, snapshot, now, settings) → { pass: true } | { pass: false; by: SuppressedBy; until: number | null; drop: boolean }`，按第 6.6 节 1–9 的顺序；snapshot 由 `buildSnapshot(ctx, botId, now)` 从 store 与 runtime 收集（机器人、是否 running、主人最近活动、上次放行时间、启动时间、额度状态、今日回合与 token、本窗口回合、open 提问的 subjectKey 集合、各 subjectKey 最近唤醒时间、retryAt）。
- `select.ts`：`selectNext(ctx, now) → QueueEntry | null`：按优先级逐个评估闸门；被拦的写 AppraisalLog(suppressed)（同一机器人同一闸门 10 分钟内只写一次）；drop=true 的移出队列；返回第一个通过的（不移出队列，由 C04 投递成功后移出）。
- `retry.ts`：`retryDelayMs(attempt, rng)`（2m/10m/30m/2h ±20%）；`onDispatchOrTurnError(ctx, botId, errorText, now)`：consecutiveErrors+1、设 retryAt、第 4 次 quarantined + P1 告警；返回采取的动作。

### 6. 额度 `src/quota/`

`classifyError(text)`（第 13 节关键词，中英文都要）；`rollWindow(ctx, now)`；`recordUsage(ctx, {botId, wakeId, tokens, steps, packetBytes})`（拿不到 token 时按第 5 节估算，× 1.2 记账，写 ledger，更新窗口）；`computeLight(state)`；`onQuotaError(ctx, now)`（red、校准 turnLimit/tokenLimit、redUntil、全体 activity=resting）；`maybeAllowProbe(ctx, now)` 与 `onProbeResult(ctx, ok)`；`botUsageToday(ctx, botId, now)` → {turns, tokens}；`botTurnsInWindow`。

### 7. 健康 `src/health/`

- `heartbeat.ts`：`maybeWriteHeartbeat(ctx, now)`（≥ 30 秒一次，写 `<rootDir>/.hub/heartbeat.json`：{pid 由 settings 外部传入可为 null, at, bots, thinking, version: '0.1.0'}）；`readLastHeartbeat(ctx)`。
- `downtime.ts`：`detectDowntimeOnStart(ctx, now)`（> 2 分钟记 host_down）；`detectSleep(ctx, now)`（两次 tick > 10 分钟记 sleep）；`catchUpCandidates(ctx, downtime, now) → Candidate[]`（≥ 30 分钟才产生；每个 probation/active 机器人 1 个，kind=catch_up，带停机时长文字）。
- `deadman.ts`：`computeExpectedBy(bot, earliestUrgentPerceptAt)`；`checkDeadman(ctx, now) → Candidate[]`（告警 + retry 候选，同机器人 6 小时内一次）；`findStuckWakes(ctx, now) → WakeTicket[]`（10 分钟无事件或总时长 > 30 分钟）。
- `alerts.ts`：`raiseAlert(ctx, {code, botId, text, level, immediate?})`（同 code 第 2 次才真正 open，immediate 例外；1 小时内合并计数）；`closeAlert(ctx, code, botId)`。
- `quarantine.ts`：`checkQuarantine(ctx, botId, now) → reason | null`（第 6.10 节触发条件）与 `quarantine(ctx, botId, reason)`（lifecycle=quarantined、P1 告警、移出队列）。

## 不要做

唤醒包、回合守卫、交账、动作闸、工具、线程/收件箱/日报、家目录与 AGENTS.md、套路、同伴、Hub 组装、界面接口、仿真——那是 C03、C04。不碰 `packages/plugin/`；不改 docs 规格与任务卡；不装依赖；不跑 git commit。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

- 全部通过、第三条无输出；C01 的测试仍全部通过。
- 本卡新增测试 ≥ 90 个，至少覆盖：显著性公式逐项与分档边界（0.39/0.40/0.69/0.70/0.89/0.90）、主人/同伴/回复特例分数、24 小时指纹去重、待处理堆合计 1.0 的边界与分数、http/rss/script 首次只记基线与之后的变化、script 白名单拒绝、文件变化 2 分钟去抖合并、log 尾部读取与期望满足、期望 everyMs 与 byLocalTime 落空且同日只报一次、内驱四种各自触发与每日 ≤ 2 次与 24 小时暂缓、受挫判断、议程紧迫度三档、next_think 四种模式与夹紧上下限与解析失败、轻复查时间刷新、队列合并规则、九道闸门每道至少一个拦截一个放行、优先级排序、闸门日志 10 分钟去重、退避 ×2 封顶 24 小时与复位、额度 yellow/orange/red 行为与校准公式与探针、错误分类中英文、重排时间与抖动范围与第 4 次隔离、心跳 30 秒节流、停机与睡眠检测、补课候选、死人开关 6 小时一次、卡住判定、告警第 2 次才 open 与 immediate、隔离四种触发。

## 交付物

源码与测试；`docs/progress/C02.md`（按文件列做了什么、验收输出摘要、与规格不一致处及理由、遗留问题）。
