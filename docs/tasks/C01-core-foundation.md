# C01 core 地基：领域模型、默认数值、注入接口、工具函数、存储

- 负责方：Codex
- 允许修改：`packages/core/`（src、test）、`docs/progress/C01.md`、`docs/questions.md`（只追加）
- 前置：无（依赖已装好：typescript 5.9、vitest 3、zod 4、@types/node 22）

## 目标

把 core 包的地基一次打牢：后面所有引擎模块（感知、评估、调度、交账、工具、界面接口、仿真）都只依赖这里的类型、默认值、注入接口、工具函数和存储。这张卡不写任何引擎逻辑。

## 必读

1. 项目根目录 `AGENTS.md`（红线与代码规范，尤其「core 里禁止直接用 Date.now / setTimeout / Math.random / fs / fetch / child_process」与「详细中文注释」）。
2. `docs/build-spec.md` 第 2、3、4、5 节（逐字段实现）；其余章节浏览一遍，理解这些类型将来怎么被用。

## 要做

### 1. `src/model/` 领域模型

- 第 3 节的每个类型写成 zod schema（命名 `BotSchema`、`GoalSchema`…）并导出 `type Bot = z.infer<typeof BotSchema>`；所有枚举另外导出常量数组（如 `ROLES = ['chief','researcher','executor','sentinel'] as const`）和中文标签映射（如 `ROLE_LABELS`：总管/调研/执行/盯守；`ACTIVITY_LABELS`；`OUTCOME_LABELS`；`VARIANT_LABELS`）。
- `Settings` schema：包含 rootDir、timezone、quietHours、digestAt、pushChannel、defaultModel、workDataPaths（字符串数组，默认空）、l3Grants（字符串数组，默认空），以及第 5 节每一个可覆盖数值（camelCase 英文字段名，每个字段上方一行中文注释写清对应第 5 节哪一项、单位）。
- `TurnEvent`、`ExternalSessionEvent`、`MessageSource`、`GuardDecision`、`HostPort`（第 14 节）放在 `src/model/host.ts`（HostPort 是 TS 接口，不需要 zod）。
- 工具与交账的「输入」schema（hub_commit 参数等）这张卡**不做**，留给 C03。

### 2. `src/config/defaults.ts`

- `DEFAULTS`：第 5 节全部数值，统一单位（时间用毫秒，常量命名清楚，例如 `PACE_MIN_MS_BY_ROLE`、`DAILY_THINK_CAP_BY_AUTONOMY`、`TURN_LIMITS_BY_VARIANT`）。
- `resolveSettings(partial?: unknown): Settings`：在默认值上深合并并用 zod 校验，非法时抛出中文错误（指明字段）。
- 辅助纯函数：`paceMinMsFor(role, paceProfile, settings)`（含 active ×0.5、quiet ×2）、`paceMaxMsFor(hasActiveGoal, settings)`、`dailyThinkCapFor(autonomy, lifecycle, settings)`（试岗期按 L1）、`botBudgetFor(lifecycle, settings)`（试岗减半）、`turnLimitsFor(variant | 'owner', settings)`、`thresholdFor(fatigue, paceProfile, settings)`。

### 3. `src/io/` 注入接口与实现

- 接口（第 2 节）：`Clock`、`Rng`、`Logger`、`FsIO`、`NetIO`（含 post）、`ExecIO`。
- 系统实现（只有这些文件允许用 Node 的时间、随机、fs、fetch、child_process）：
  - `system-clock.ts`、`system-rng.ts`（crypto.randomInt 或 Math.random 均可）、`console-logger.ts`（带前缀 `[agent-hub]`）。
  - `system-fs.ts`：node:fs/promises；所有路径必须是绝对路径（否则抛错）；`writeTextAtomic` 写同目录临时文件再 rename；`appendText` 自动建目录；`watch` 用 `fs.watch(path, { recursive })`，返回取消函数，回调异常要兜底不能抛出到外面；`remove` 递归删除。
  - `system-net.ts`：全局 fetch + `AbortSignal.timeout`；按 maxBytes 截断读取；非 2xx 也返回 status 与文本，不抛；网络错误抛出带中文说明的 Error。
  - `system-exec.ts`：`child_process.execFile`（不经过 shell）；超时杀进程并返回 timedOut=true；stdout/stderr 按 maxOutputBytes 截断。
- 测试替身（放 `src/io/testing/`，从 index 单独导出 `testing` 命名空间）：`FakeClock`（`now()`、`advance(ms)`、`set(ms)`）、`SeededRng`（mulberry32，同种子同序列）、`MemoryFs`（内存目录树；实现 FsIO 全部方法；`watch` 在任何写入/删除命中被监听路径时同步回调；额外提供 `snapshot()` 列出全部文件与内容，便于断言）、`FakeNet`（按 URL 返回预设结果，可设置抛错）、`FakeExec`（按「命令 + 参数」返回预设结果）、`MemoryLogger`（收集日志行）。

### 4. `src/util/` 工具函数（纯函数，时区一律显式传入）

- `time.ts`：`localParts(ms, tz)` → {year, month, day, hour, minute, second, weekday(0=周日)}；`localDateKey(ms, tz)` → 'YYYY-MM-DD'；`parseLocalDateTime('YYYY-MM-DD HH:mm', tz)` → ms；`parseFlexibleTime(text, tz)` 接受 ISO 8601（带时区或 Z）与 'YYYY-MM-DD HH:mm'（按 tz 解释），失败返回 null；`isInQuietHours(ms, {start:'HH:mm', end:'HH:mm'}, tz)`（跨午夜正确，start=end 表示不启用）；`nextLocalTime('HH:mm', afterMs, tz)` → 下一个该本地时刻的 ms；`startOfLocalDay(ms, tz)`；`formatShort(ms, nowMs, tz)` →「今天 14:05」「昨天 09:30」「明天 08:00」「11月3日 08:00」「2025年12月1日 08:00」（跨年才带年）；`formatAgo(ms, nowMs)` →「刚刚」(<1 分钟)「3 分钟前」「2 小时前」「5 天前」，未来时间返回「3 小时后」；`formatDuration(ms)` →「4 小时 30 分」「45 分钟」「20 秒」；`weekdayLabel(n)` →「周日」…。用 `Intl.DateTimeFormat`（formatToParts）实现，不引入依赖。
- `ids.ts`：`newId(prefix, rng)` → prefix + '_' 后接 10 位小写 base36。
- `hash.ts`：`sha1Hex`、`sha256Hex`（node:crypto，纯计算允许）、`stableStringify(value)`（对象键排序、去掉 undefined，数组保序）、`fingerprint(...parts)` → sha1 前 16 位。
- `text.ts`：`truncateBytes(text, maxBytes)`（按 UTF-8 字节截断，不切坏多字节字符，超出时末尾加「…（已截断）」且总字节仍 ≤ maxBytes）、`byteLength`、`stripHtml(html)`（去 script/style 块与标签、解码常见实体、合并空白）、`lineDiff(oldText, newText)` → {added: string[], removed: string[], changeRatio: number(0–1)}（按行集合差异即可）、`slugify(name)`（中文保留、空白与符号变连字符、小写、≤ 40 字符；为空时返回 'routine'）。
- `stats.ts`：`mean`、`stddev`、`coefficientOfVariation(values)`（少于 2 个值返回 0）。

### 5. `src/store/` 存储

- 接口：`Table<T extends {id: string}>`（get、list(pred?)、put、patch(id, partial)→T（不存在抛错）、remove、count）、`Log<T extends {id: string; at?: number; createdAt?: number}>`（append、recent(n, pred?)、since(ms, pred?)、all()）、`Store`（`table(name)`、`log(name)`、`load()`、`flush()`、`prune(nowMs)`、`isDirty()`）。表名与日志名用第 4 节列出的固定名字，做成字符串字面量联合类型，并把每个表名映射到它的记录类型（`TableTypes`），使 `store.table('bots')` 自动得到 `Table<Bot>`。
- `MemoryStore`：只在内存。
- `FileStore(fs: FsIO, clock: Clock, rootDir: string, tz: string)`：
  - 落盘布局：`<rootDir>/.hub/state/<表>.json`（整表 JSON 数组，`writeTextAtomic`）；日志 `<rootDir>/.hub/logs/<日志>/<YYYY-MM-DD>.jsonl`（按记录时间的上海日期分文件，追加）。
  - `load()`：读全部表；单条记录如果不是对象或缺 id → 跳过；整个文件 JSON 损坏 → 把原文件复制为 `<表>.json.bad-<时间戳>` 后当空表继续，并记 warn；日志读最近 14 天文件。
  - `flush()`：只写脏表与新追加的日志行；串行执行（进行中再调用则等这次结束后再写一次，不并发写同一文件）。
  - `prune(nowMs)`：按第 4 节保留期删除过期记录与过期日志文件。
- 两种实现共享同一套测试（参数化）。

### 6. `src/index.ts`

导出 model、config、io（接口与系统实现）、`testing`（测试替身）、util、store。

## 不要做

- 不写任何引擎逻辑（感知、显著性、调度、唤醒包、交账、工具、界面接口、仿真）——那是 C02–C04。
- 不碰 `packages/plugin/`；不装依赖；不改 `docs/build-spec.md` 与 `docs/tasks/`；不跑 git commit。

## 验收（全部要过）

在 `agent-hub/` 目录：

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

- 前两条零错误；第三条没有输出（除系统实现文件外不得出现）。
- 测试用例数 ≥ 60，至少覆盖：免打扰跨午夜的边界（22:59/23:00/07:59/08:00）、上海日期键在 UTC 16:00 前后的切换、parseFlexibleTime 两种格式与非法输入、formatShort 的今天/昨天/跨年、truncateBytes 截断中文不乱码且不超长、stableStringify 键序无关、lineDiff、slugify、MemoryFs 原子写与 watch 回调、FileStore 落盘路径与内容、坏 JSON 文件备份后继续、日志按天分文件与 since 查询、prune 保留期、resolveSettings 覆盖成功与非法报错、每个领域 schema 一个合法样例一个非法样例、各辅助函数（paceMinMsFor、dailyThinkCapFor 试岗期、botBudgetFor 减半、thresholdFor）。

## 交付物

- 上述源码与测试。
- `docs/progress/C01.md`：按文件列出做了什么；验收命令与输出摘要（测试数）；与规格不一致处及理由；遗留问题。
