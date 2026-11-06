# C03 唤醒包、回合守卫、交账、动作闸、机器人工具、找主人、记忆、套路、同伴

- 负责方：Codex
- 允许修改：`packages/core/`（src、test）、`docs/progress/C03.md`、`docs/questions.md`（只追加）
- 前置：C01、C02 已验收

## 目标

实现机器人「醒来之后」的全部逻辑：给它装唤醒包、看住回合、处理它的交账、拦住越界动作并走审批、提供它能调用的 hub_* 工具、把该告诉主人的话送进线程/收件箱/单推/日报、维护家目录里的身份与记忆文件、套路与教学、机器人之间的消息与交接。全部用 C01/C02 的类型、存储、上下文、队列接口。

## 必读

`AGENTS.md`；`docs/build-spec.md` 第 6.7–6.9、7、8、9、10、11、12 节（逐条实现），第 3、5 节；`docs/progress/C01.md`、`docs/progress/C02.md`；先通读 `packages/core/src` 现有代码。

## 要做

### 1. 唤醒 `src/wake/`

- `ticket.ts`：`createTicket(ctx, entry, sessionId) → WakeTicket`（id 用 `w_` 前缀，status=delivering）。
- `packet.ts`：`buildWakePacket(ctx, bot, entry, ticket) → string`，第 9 节 regular 模板与各变体（light_check、reflection、catch_up、trial、teach、approval_decided、主人消息时的「主人对你说」节、总管的「团队现在」节）。外部来源（untrusted=true）的感知摘要只能出现在 `<<<untrusted … untrusted>>>` 围栏内，且围栏内文本里如果出现 `untrusted>>>` 要转义（替换为 `untrusted>>＞`）。≤ 6 KB，按第 9 节顺序截断（用 C01 的 truncateBytes 按节截）。时间用北京时间格式。
- 新会话（无 sessionId 或需要轮换）时，在包最前面加一段「这是你的新工作会话。你的身份与规矩在 AGENTS.md，目标、议程、关注在 mind/，长期记忆在 memory/MEMORY.md。」

### 2. 回合守卫 `src/turn/`

`onTurnEvent(ctx, e)`：按 sessionId 找机器人与其 running/delivering 唤醒单，更新 status、steps、tokens、lastEventAt；ended 时若无交账 → 第 6.7 节未交账处理（合成 no_change 交账、consecutiveNoCommit+1、连续 2 次标记下次 reflection）；error → 交给 C02 的 `onDispatchOrTurnError` 与额度分类；awaiting_approval → P1 告警并记录 5 分钟后 cancel；owner_direct → 记一个 ownerInitiated 的 running 唤醒单（变体 regular，reason.kind=owner_message）。回合结束（任何终态）时：记账（C02 recordUsage）、bot.activity 回到 watching（或交账决定的状态）、移出队列、重算 expectedBy、`emit`。
`checkTurnLimits(ctx, now)`（tick 调用）：到上限 → `host.steer`（第 6.7 节文案）记 steeredAt；steeredAt 后 3 分钟仍 running → `host.cancel`、status=timeout，按错误处理。

### 3. 交账 `src/commit/`

- `schema.ts`：hub_commit 参数的 zod schema（第 10.2 节全部校验，错误信息中文且指明字段；dueAt/at 接受 ISO 与「YYYY-MM-DD HH:mm」）。
- `process.ts`：`processCommit(ctx, toolCtx, args) → {ok, text}`，第 6.8 节 1–8 步全部实现；返回给模型的 text 简短确认（例如「已交账：progress。下次思考：明天 09:00（你的理由已记录）。」）。

### 4. 动作闸 `src/gate/`

- `classify.ts`：纯函数 `classifyToolCall(tool, args, gctx) → { cls: 'A'|'B'|'C'|'D'|'protected'; reason: string }`，第 7.1 节全部规则。DSH 工具名与参数结构尚未最终确定：做一个 `ToolShape` 适配表（读文件、写文件、编辑文件、执行命令、网页搜索、网页抓取各自的候选工具名与取路径/命令参数的方法），先按常见命名（`read_file`/`read`、`write_file`/`write`、`edit_file`/`edit`/`apply_patch`、`exec`/`shell`/`bash`/`run_command`、`web_search`、`web_fetch`），未知工具 → C。命令解析：自己写一个小的 shell 词法器（引号、转义、`|`、`;`、`&&`、`||`、`$(`、反引号），按最危险段分类。
- `matrix.ts`：第 7.2 节矩阵，`decide(cls, autonomy, lifecycle, grants) → 'allow' | 'approval' | 'deny'`。
- `approvals.ts`：`requestApproval(ctx, botId, tool, args, cls, why) → Approval`（同 contentHash 的 pending 不重复建；建收件箱项与线程消息；按第 8.3 节申请单推）；`decideApproval(ctx, id, approve, note)`（入队 approval_decided 候选，priority 90）；`consumeTicket(ctx, botId, tool, args) → boolean`；`expireApprovals(ctx, now)`。
- `guard.ts`：`guardToolCall(ctx, sessionId, tool, args) → GuardDecision`：非机器人会话 allow；protected → 拒绝并计 violation；deny → 拒绝（D 类无票计 violation，满 3 次隔离）；approval → 先查批准票（有则放行一次）否则建审批单并拒绝（第 7.3 节文案）；allow → allow。`onHostApprovalRequest(ctx, sessionId, tool, summary)`：机器人会话 → 建中心审批单（tool+summary 作内容）并返回 'deny'；否则 'pass'。
- `outbox.ts`：`submitOutbox(ctx, botId, input)` 与 `executeReadyOutbox(ctx)`（批准后执行：write_file 用 FsIO、http_post 用 NetIO.post、run_command 用 ExecIO，结果写回并产生 outbox_done 系统感知；notify_owner 直接进线程按 importance 申请单推）。

### 5. 机器人工具 `src/tools/`

第 10.1 节全部 15 个工具，每个一个文件，导出 `HubTool = { name, description, schema, jsonSchema, handler(ctx, toolCtx, args) }`（jsonSchema 用 `z.toJSONSchema(schema)`；description 用中文写清何时用、参数含义、限制，模型会读）。`buildTools(ctx) → HubTool[]` 与 `runTool(ctx, toolCtx, name, rawArgs)`（统一 zod 校验 → 自主等级检查 → handler；任何异常都转成 `{ok:false, error}`，绝不抛出）。等级限制、L1 变提议、L2 直接生效、每对机器人每天条数、第 6.5 节防「拼周期」的议程校验等全部按规格。hub_state_get 返回给模型的是中文纯文本（不是 JSON），控制在 3 KB 内。

### 6. 找主人 `src/outreach/`

- `thread.ts`：`postThread(ctx, {thread, from, kind, text, refId})`；`sendOwnerMessage(ctx, threadId, text)`（第 8.1 节路由：机器人线程直投；team 线程按 @名字 → 总管 → 规则兜底；生成 owner_message 感知并入队 ownerInitiated 候选，priority 100）；`markRead`。
- `inbox.ts`：`createInboxItem`、`answerInbox(ctx, id, answer)`（question → inbox_reply 感知与候选；proposal 接受 → 视提议内容：若来自 hub_watch_propose / hub_goal_upsert / hub_lesson_propose 则落实为 active 记录，否则给机器人 inbox_reply 感知；拒绝 → 记 30 天同标题不再提）；`expireInbox(ctx, now)`（提问 72 小时按默认回答并唤醒、24 小时时标记「日报提醒」、提议 7 天撤回）；`closeAlertItem`。
- `push.ts`：`requestPush(ctx, {botId, level, title, body, subjectKey}) → 'sent' | 'deferred_quiet' | 'over_budget' | 'duplicate'`（第 8.3 节；sent 才调用 host.notify；被拦的记下来给日报）。
- `digest.ts`：`maybeSendDigest(ctx, now)`（每天 digestAt 后第一次 tick 生成一次；免打扰内顺延）与 `buildDigest(ctx, now) → string`（第 8.4 节全部内容，纯拼装，不调用模型；周日追加点子池与接受率）。

### 7. 记忆与规矩 `src/memory/`

`initRoot(ctx)`（根目录结构与全体守则 AGENTS.md，不建 .git）；`verifyProtectedFiles(ctx, botId)`（第 11 节三重保护的第三重：回合终态时由回合守卫调用，哈希不符则重写并计 violation）；`createBotHome(ctx, bot)`；`renderBotAgentsMd(ctx, bot) → string`（第 11 节内容，≤ 8 KB）；`renderRootAgentsMd(ctx)`（≤ 3 KB）；`refreshBotFiles(ctx, botId)`（重写 AGENTS.md 与 mind/goals.md、agenda.md、watches.md）；`appendJournal(ctx, bot, commit, ticket)`；`readMemorySummary(ctx, bot) → string`（MEMORY.md 前 1.5 KB）；`upsertRule`；`needsRotation(bot, sessionInfo, now)`。

### 8. 套路 `src/routines/`

`saveRoutine(ctx, botId, input)`（同名更新，写 `playbooks/<slug>.md`：标题、什么时候用、编号步骤、学自哪里、修订记录追加一行）；`routineIndex(ctx, botId) → string`；`editRoutine(ctx, id, patch)`（主人编辑）；`enqueueTeach(ctx, botId, sessionId, note)`（读 host.readSessionDigest(sessionId, 3000) 存进候选，入队 teach 变体、ownerInitiated）。

### 9. 同伴 `src/peer/`

`sendMail`、`createHandoff`（复制文件到 shared/handoffs/<id>/，只允许源在发起方家目录或 shared 内）、handoff 状态联动（收件人对对应议程项 upsert → accepted；close done/dropped → done/declined 并通知发起方）、`expireHandoffs`（2 小时未接收 → 标记供 C02 等人内驱使用；7 天 → expired）、`claim`/`release`/`expireClaims`、`teamSummary(ctx) → string`（总管用）、总管的 system 感知（blocked 超 24 小时、交接超时、隔离事件）。

### 10. 反思 `src/reflect/`

`shouldReflect(ctx, botId, now)`（第 6.9 节四种触发，每天 ≤ 1 次）→ 入队 reflection 候选；`processReflectCommit(ctx, toolCtx, args)`（教训：self 且 L2 起直接成为该机器人的规矩，其余进收件箱提议；watchChanges 走与 hub_watch_update/propose 相同的规则；routineUpdates 调 saveRoutine；paceAdvice 只记录进日志供主人看）。

## 不要做

Hub 组装（createHub、start/stop/tick/pump 串联与投递）、界面接口 UiApi、仿真 SimHost 与场景测试——那是 C04（本卡的测试用 C02 的 createTestContext 直接调用各模块函数）。不碰 `packages/plugin/`；不改 docs 规格与任务卡；不装依赖；不跑 git commit。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

- 全部通过、第三条无输出；C01、C02 测试仍全过。
- 本卡新增测试 ≥ 110 个，至少覆盖：每个变体的唤醒包关键段落、6 KB 截断顺序、不可信围栏转义、新会话首段；回合守卫的上限 steer 与 3 分钟后 cancel、未交账合成与连续 2 次转复盘、owner_direct、awaiting_approval；hub_commit 每条校验规则的正反例与重复交账；交账对 outcome 五种的处理、reply/report/ownerQuestion/proposals 路由；命令分类（安全只读、家目录写、curl GET/POST、git push、rm -rf 家外、管道与 $( ) 取最危险段、无法解析）；写受保护文件；工作数据边界；矩阵每一格；审批单去重、批准票只放行一次且参数不同不放行、过期视为拒绝；DSH 审批框钩子；出站四种执行；15 个工具各自正反例与等级限制；线程路由（直投、@名字、总管、兜底）；收件箱作答与过期默认；单推的免打扰（跨午夜）、预算全体 3 与每机器人 2、P0 例外、24 小时同主题去重；日报内容含「未出现」与停机时长与周日点子池；AGENTS.md 大小上限与内容；mind 视图；日志追加；套路保存与同名更新与索引；教学入队；同伴消息条数上限；交接复制范围限制与状态联动与超时；认领锁冲突与到期；反思触发与 hub_reflect_commit 处理。

## 交付物

源码与测试；`docs/progress/C03.md`。
