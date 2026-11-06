# M01 维护卡：C01 独立验收发现的问题

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M01.md`、`docs/questions.md`（只追加）
- 前置：C03 已完成（本卡在 C04 之前做，保证地基可靠）。C02、C03 的验收问题另开 M02，本卡不处理。
- 背景：总控对 C01（以及 C02，见第二部分）做了对抗式独立验收：三个审查员找问题，每条再由核查员尝试推翻，下面只列被证实的。复现脚本在 `/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/review-C01/`（可读，不要改）。

## 第一部分：C01

### 1【严重】SystemExec 超时后不能按时返回，孙进程不被杀（`src/io/system-exec.ts`）

现象：命令自己再起子进程时（`sh -c 'sleep 4; echo done'`、脚本里调 curl / tail -f），超时只杀了直接子进程；execFile 要等管道全部关闭才回调，于是 `run()` 要等孙进程结束（tail -f 时永远不返回），孙进程不占管道时又会变成孤儿进程。复现：`review-C01/verify0/v1-grandchild-pipe.mjs`（timeoutMs=300 实际 4128 ms）、`v3-forever.mjs`（永不返回）、`v4-orphan.mjs`（孤儿进程）。
要做：改用 `spawn`（`detached: true`，自成进程组，不经过 shell），超时用 `process.kill(-pid, 'SIGKILL')` 杀整组，随后销毁 stdout/stderr 并立即结束等待，保证 `run()` 在 timeoutMs + 500 ms 内返回 `timedOut: true`；正常结束时也要确认进程组里没有残留（可在 exit 后对进程组发一次 SIGKILL，忽略 ESRCH）。
测试：孙进程占着管道（`/bin/sh -c 'sleep 5; echo done'`，timeout 300 ms，断言 1 秒内返回且 timedOut）；孙进程不占管道但仍在运行（断言返回后用 `process.kill(-pid, 0)` 检查进程组已不存在）；`tail -f /dev/null` 永不结束的情况。

### 2【中】输出超过上限时直接杀进程，丢了真实退出码（`src/io/system-exec.ts`）

任务卡要求「按 maxOutputBytes 截断」而不是杀进程。要做：自己累计 stdout/stderr 字节，超过上限后丢弃多余数据但继续读空管道，让进程正常结束并保留真实退出码；另设硬上限（maxOutputBytes 的 32 倍）才杀进程。结果类型增加 `outputTruncated: boolean`、`killedForOutput: boolean`（FakeExec 同步支持）。按新语义改 `test/io-system.test.ts` 第 117 行附近的用例，并补「只有 stderr 超量」的用例（断言 stderr ≤ 上限、不含替换字符 `�`、退出码保留）。同步检查 C02 的 `perception/script.ts` 与（若 C03 已写）`gate/outbox.ts` 对 `code === null` 的处理，按新字段区分「被截断但正常退出」「超时」「被杀」。

### 3【中】stripHtml 会删掉不是标签的「<」到下一个「>」之间的正文（`src/util/text.ts` 第 38 行附近）

例：`价格 a < b 时 ... <p>` 中间整段被删，http 关注项因此漏报变化。要做：只删除真正的标签 `/<\/?[A-Za-z][^>]*>/g`，`<!-- -->` 注释、`<!DOCTYPE>`、`<?xml ?>` 单独处理；script/style 块照旧整块删除。测试：小于号、箭头 `<-`、比较式 `a<b`、`<3` 不被删。

### 4【低】stripHtml 实体表是普通对象，`&constructor;` 会被替换成函数源码（同文件第 40 行）

改用 `Map` 或 `Object.create(null)` 并用 `Object.hasOwn` 判断；补测试。

### 5【中】FileStore.load 跳过单条坏记录时不备份（`src/store/file-store.ts` 第 74–77 行）

规格第 4 节：「坏记录跳过并备份为 .bad-<时间>」。要做：表文件里只要跳过任何一条记录，先把原文件复制为 `<表>.json.bad-<时间戳>`，warn 里写明跳过的条数与下标，并 markDirty 让下次 flush 写回干净文件。测试：出现 .bad- 文件，flush 后备份仍保留原始坏记录。

### 6【低】含坏行的日志文件每次 load 都重复整份备份，备份永不清理（同文件第 104 行附近）

要做：备份后用 `writeTextAtomic` 把只含有效行的内容写回原日志文件（同一文件只备份一次）；`.bad-*` 文件纳入 prune，保留 30 天。测试。

### 7【低】一条坏记录让之后每次 flush 都失败，后面的表和日志全部无法落盘（同文件第 113 行附近）

要做：`append` 时校验时间在 Date 可表示范围内；`put/patch` 时用 JSON 往返检查可序列化，入口直接拒绝坏记录（抛中文错误）；flush 按表、按日志分别 try/catch，单个失败只保留它自己的脏标记并记 error，其余照常写，最后汇总抛出。测试。

### 8【低】`log.recent(n)` 同一时间戳时先返回最早追加的（`src/store/memory-store.ts` 第 66 行，FileStore 同）

给每条日志附加单调递增的追加序号做次级排序键；倒序时序号也倒序；改对应测试的期望。

### 9【低】`ACTION_CLASS_LABELS` 与规格 7.2 不符、`proposed` 标签意思相反（`src/model/enums.ts` 第 200 行附近）

A「内部可撤销」、B「会持续生效的自我变更」、C「别人看得见或碰真实数据」、D「不可逆或高风险」；proposed 一律为「提议中」。

### 10【低】测试缺口

- `test/store.test.ts` 第 189 行附近：补「load 读回最近 14 天」的正向用例（NOW−3 天、NOW−13 天、正好在截止日的记录都要出现在 all() 与 since() 里）。
- `test/util-data.test.ts` 第 89 行附近：fingerprint 加固定向量断言（与 sha1Hex 前 16 位一致）。
- `test/io-system.test.ts`：stderr 截断用例（见第 2 条）。

### 11【低，但是主人的硬要求】中文注释不足

守则要求「每个文件开头写中文说明，关键函数和每段逻辑写中文注释」。审查统计 C01 源码 137 个函数/方法/类中有 91 个前面没有说明。要做：给 C01、C02（以及 C03 已写的代码）里所有导出函数、类、方法补「做什么、为什么」的中文注释；`model/*.ts` 每个字段旁写规格第 3 节的中文含义；`enums.ts` 的模板化注释改成各枚举的业务含义。不要为了压行数而把多条语句挤在一行：拆开写，单文件超过 400 行就按职责拆文件。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；`docs/progress/M01.md` 逐条写明每个问题怎么修的、新增了哪些测试、复现脚本修后的输出（至少重跑 `review-C01/verify0/v1-grandchild-pipe.mjs` 的同类场景，用你自己的测试证明）。
