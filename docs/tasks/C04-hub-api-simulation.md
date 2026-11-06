# C04 Hub 组装、界面接口、仿真与主动性验收（T1–T7）

- 负责方：Codex
- 允许修改：`packages/core/`（src、test）、`docs/progress/C04.md`、`docs/questions.md`（只追加）
- 前置：C01、C02、C03 已验收

## 目标

把前三张卡的模块装成一个可运行的引擎 `createHub()`，给界面提供 UiApi，并用仿真跑出可量化的主动性证据：在假时钟下推进 7 天，验证第 0 节 T1–T7 与第 18 节的 16 个场景全部成立。这张卡完成后，core 就是一个可以交给 DSH 插件直接接线的完整引擎。

## 必读

`AGENTS.md`；`docs/build-spec.md` 第 6.1、6.6、14、15、18 节（逐条实现）与第 0 节；`docs/progress/C01.md`–`C03.md`；先通读 `packages/core/src`。

## 要做

### 1. `src/engine/hub.ts`：`createHub(deps) → Hub`（第 14 节接口）

- `start()`：store.load → resolveSettings 合并 store 里的 settings 表 → initRoot → 检测停机（C02）与补课候选 → 每个 probation/active 机器人 refreshBotFiles → syncFileWatches → runtime.startedAt=now → 记审计 → flush。
- `stop()`：取消所有文件监听 → flush。不取消正在跑的回合（DSH 会话归宿主）。
- `tick()`：第 6.1 节 1–12 步，每步独立 try/catch（出错写 Logger.error + 系统告警，不中断后续步骤）；串行（上一个 tick 没结束时新的 tick 直接返回）；末尾 flush。
- `pump()`（内部，事件与命令后也调用）：循环调用 selectNext，每次放行 1 个并检查放行间隔与并发；投递 = createTicket → buildWakePacket → 需要新会话（无 sessionId、needsRotation、或 sessionInfo.exists=false）则 `host.createSession`（rolePresetId 按角色：`agent-hub-chief` / `agent-hub-researcher` / `agent-hub-executor` / `agent-hub-sentinel`；permissionPresetId=`agent-hub-unattended`；title=`{name} · Agent 中心`；cwd=家目录；model=bot.model）并写回 bot.sessionId/sessionStartedAt，否则 `host.deliver`；成功 → 唤醒单 running、bot.activity=thinking、activityText「正在处理：{理由摘要}」、lastDispatchAt=now、消费感知、移出队列；失败 → 唤醒单 error、C02 重排、保留候选。宿主调用一律 try/catch。
- 事件入口：`onTurnEvent`（C03 回合守卫，然后 pump）、`onExternalSessionEvent`（C02 感知，然后 pump）、`onOwnerActivity`（runtime.ownerActiveAt）、`botIdForSession`、`tools()`（C03 buildTools，并把 handler 包成 `(sessionId, rawArgs) => Promise<{ok,text|error}>` 自动解析 botId 与当前 wakeId；非机器人会话调用返回错误「只有 Agent 中心的机器人能用这个工具」）、`guardToolCall`、`onHostApprovalRequest`、`subscribe`（emit 汇总后同步通知订阅者，订阅者异常要兜住）。
- 所有入口在处理后 flush（串行合并）。

### 2. `src/api/`：UiApi（第 15 节）

- 视图：`overview`、`bot`、`thread`、`inbox`、`activity`、`settings`、`recentSessions`，返回结构写成导出的 TS 类型（`OverviewView`、`BotView`…），字段命名英文、文案中文，时间都已格式化（formatShort/formatAgo）并同时给原始毫秒（`xxxAt` 与 `xxxText` 成对）。`bot` 视图的统计：7 天回合数、思考间隔变异系数、机器人自定 next_think 占比、自发事项数（source=bot 的议程与 proposals 计数）、提议接受率。
- 命令：第 15 节全部命令，每个用 zod 校验输入，返回 `{ok:true, data?}` 或 `{ok:false, error}`（中文），写审计，调用相应模块，最后 pump + flush。`createBot` 的约束（上限 6、总管 1 个、名字不重复）、创建后生成家目录、试岗、入队 trial。`setLifecycle` 的合法转换表写清楚（例如 retired 不能恢复；quarantined 只能被主人解除回 active 并清零计数）。

### 3. `src/sim/`：仿真

- `sim-host.ts`：`SimHost implements HostPort`。每个机器人注册一个「大脑」：`(input: { packet: string; variant: Variant; botId: string; sessionId: string; call: (tool, args) => Promise<{ok, text|error}> }) => Promise<BrainResult>`；deliver/createSession 后在「下一个微任务」异步执行大脑：先发 started 事件，大脑通过 `call` 调用 hub 工具（走 hub.tools() 与 guardToolCall，与真实插件同一路径），每次调用后发 step 事件（steps+1，tokens 累加大脑声明的量），最后发 ended（或大脑声明的 error / 不交账 / 卡住不结束）。记录所有 notify、steer、cancel 调用供断言。
- `brains.ts`：常用大脑：`quietBrain`（每次 no_change + auto）、`scriptedBrain(steps[])`（按剧本逐次返回不同交账）、`replyBrain`（有主人消息就 reply）、`watchTunerBrain`（调慢一个关注项并提议一个新关注项）、`agendaMakerBrain`（自发建议程与提议）、`noCommitBrain`、`errorBrain(text)`、`approvalSeekerBrain`（调用一次需要审批的命令工具，被拒后交 needs_owner；被唤醒后用相同参数重试）。
- `runner.ts`：`createSimWorld({ bots, startAt, settings })` 组装 MemoryFs + FakeClock + SimHost + MemoryStore + createHub；`advance(world, ms, { tickEveryMs = 60000 })` 推进时间并逐 tick 调用，期间等待 SimHost 的异步大脑执行完（每次 tick 后 `await` 一个「沉降」函数直到没有进行中的大脑）；`metrics(world)` 计算：每机器人回合数、间隔、变异系数、bot 自定 next_think 占比、自发事项数、单推次数（按时段）、唤醒理由分布。

### 4. 场景测试 `test/scenarios/`

第 18 节 1–16 全部实现，每个一个 test 文件或 describe，断言基于 store 与 SimHost 记录；另加：
- 17. 冷启动：全新根目录 start → 目录结构与全体 AGENTS.md 生成；createBot 后家目录完整、trial 立即放行（主人发起不受启动静默限制）、trial 交账后进入 watching。
- 18. 7 天综合：3 个机器人（盯守、调研、执行），注入随机但可复现（SeededRng）的事件流（文件变化、http 变化、期望落空、主人消息、同伴消息），跑满 7 天：任何时刻 running ≤ 2；每天每机器人回合 ≤ 预算；免打扰时段单推只有 P0；所有唤醒单 reason 完整；输出一份 metrics 摘要写进测试快照（`expect(...).toMatchSnapshot()` 可用，但断言关键数值区间而不是只靠快照）。
- 7 天仿真单个测试 ≤ 15 秒。

### 5. 打包自检

`pnpm --filter @agent-hub/core build:check`：在 core 的 package.json 加脚本，用 esbuild 把 `src/index.ts` 打成单文件 ESM（platform=node，target=node22，external 只有 node 内置模块）输出到 `.tmp/core-bundle.mjs`，再用 `node -e` 动态 import 它并调用一次 `createHub`（MemoryStore + 系统实现以外的替身）确认能跑：这一步保证 DSH 插件能把 core 打进自己的 lib。

## 不要做

不碰 `packages/plugin/`；不改 docs 规格与任务卡；不装依赖；不跑 git commit。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

- 全部通过、最后一条无输出；之前所有测试仍全过。
- 场景测试 1–18 全部存在且通过；`docs/progress/C04.md` 里贴出 7 天综合仿真的 metrics 摘要（每机器人回合数、变异系数、自定 next_think 占比、自发事项数、各时段单推数、理由分布）。

## 交付物

源码与测试；`docs/progress/C04.md`。
