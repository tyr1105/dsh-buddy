# D07 插件第二轮审查与界面走查的修复

- 负责方：DSH
- 允许修改：`packages/plugin/`（不得改依赖）、`scripts/`、`docs/progress/D07.md`、`docs/progress/D05.md`（只更正第 9 条的不实说明）、`docs/questions.md`（只追加）
- 不得修改：`packages/core/`、规格与任务卡。需要 core 配合的地方用插件侧方案，并在 questions.md 记一条。
- 依据：`docs/reviews/PLUGIN-review-2.json`（下文 [n] 是其中 `confirmed[n]`，每条有复现脚本、证据与修法；复现脚本在 scratchpad 的 review-d06/ 下，可读不要改）；以及总控在沙箱里亲手走查发现的问题（标「走查」）。
- 每一条都要补「改坏即失败」的测试；按编号在 `docs/progress/D07.md` 写改法与测试名。

## 一、装机前必须修

1. **模型目录**（[0][13][34][6][9][18]，走查实测：沙箱里设置接口 500、模型下拉只剩「跟随默认」）
   - `sessionController.modelCatalog()` 必须按方法调用（不能先取出函数再裸调，会丢 this）。
   - `modelCatalog().failures` 不为空且没有任何可路由的组时，抛中文错误并带上供应商名与原因；`routableProviders` 字段缺失才不过滤，**是空数组时一行都不出**。
   - llm 兜底：`listProviders()` 返回的是对象（取 `p.id`），`listModels(id)` 是异步的，要 await。
   - 测试替身改成依赖 this 的类实例，夹具形状按 DSH 源码（scratchpad 的 dsh-src 里 dsh-api-session-controller、dsh-llm）；加一条接线测试：经 apply 或 createEngineHub 注入真实形状的 sessionController 后，`hub.api.settings()` 的 modelOptions 里有宿主模型。
   - 冒烟跑者（scripts/smoke-runner）增加一项检查：`GET /api/agent-hub/settings` 返回 200，且 modelOptions 多于 1 项（能列出沙箱里的模型）。今后这类问题 e2e 就能抓到。
2. **设置读取失败不等于连不上**（[1][27]）：refreshSettings 不走会置 connectionDown 的通用 guard；失败时存 settingsError，在设置页和各个模型下拉处显示中文原因和「重试」。只有网络错误、「尚未就绪」「已停用」才整页提示。
3. **切换队友时复位本地状态**（[19]）：在 A 上打开的退役确认、打断确认、编辑档案、输入草稿，切到 B 后必须消失（例如给 RightPanel、ThreadPane 加 key）。这条关系到「一下就把另一个队友退役了」，测试必须覆盖退役确认与打断确认。
4. **中心取消与主人打断改为无状态识别**（[4][15][17][31]）：
   - `HostPort.cancel`：机器人会话在线且正在跑回合时，用 `agent.cancel({ kind: 'hook', reason: 'agent-hub:cancel' }, { keepInbox: true })`（手册 3.10、第 1053–1054 行）；不在线或没在跑，就没有可取消的回合，直接返回成功。删掉旁路的「中心取消标记」。
   - 翻译层：`turn/end` 的 reason 为 aborted 时看内层 `reason.reason`：kind 为 hook 且 reason 以 `agent-hub:` 开头 → 中心自己取消的，不发任何事件（core 已记录）；**其余一切中止**（user、disposed、parent、legacy、其他插件的 hook）都翻译成 `{ type: 'interrupted', by: 'owner' }`。原则：不是中心发起的取消，一律不能算成队友的错（不能变成未交账或出错）。删掉不存在的 cancelled/canceled 分支。
   - 测试逐个覆盖这几种内层 kind，以及「先对没在跑的会话 cancel、再来一轮被主人停止」不会被吞掉。
5. **DSH 另铸会话 id 时补装工具**（[5][30]）：startEngine 里把工具安装器传给 HostPort 的 `wireIfBot`，加一条走真实 apply 的集成测试（假 sessionController.create 返回另一个 id，断言新会话装上了 hub_commit）。更正 D05.md 第 9 条。
6. **推送渠道不依赖设置视图**（[7][14]）：直接从引擎的存储同步读 settings 行的 pushChannel（createEngineHub 已返回 store），不要经过会读模型目录的 settings() 视图，也不要依赖有没有人订阅 SSE；读不到时保持上次读到的值，从未读到过就按「不推送」处理（只在应用内提示），绝不默认推送。测试：主人设为「不推送」后，即使模型目录坏了也不发系统通知。

## 二、应修（正确性与体验）

7. **保存设置只带改过的字段**（[3][26]）：草稿里的 defaultModel 与加载值不同时才放进 patch；当前值（设置默认模型或机器人模型）不在 modelOptions 里时，下拉额外显示一项「provider / model（已不在宿主目录）」并提示换一个。
8. **新建向导「跟随 DSH 默认」提交 `model: null`**（[2][20]）：下拉直接用视图的 modelOptions（含 value 为 null 的那项），测试断言 buildCreateBotInput 的 model 严格等于 null。
9. **refreshBot 竞态**（[22]）：先拿到详情，再在 updater 里合并进最新状态；其他 refresh 同样检查。并发测试。
10. **右栏关注项「暂停 / 恢复」与志向「收起」**（[23]）：用视图里该行已有字段拼完整入参。
11. **卡片作答失败要看得见**（[21][28]）：失败时按钮恢复可点并显示 `error`，保留自由文本草稿；结果文字按状态写：answered「你选了：X」、expired「已过期，已按默认：X」、withdrawn「已撤回」、closed「已关闭」。
12. **「中心正在启动」自动恢复**（[24]）：处于 starting 时每 2 秒重拉一次，成功即停；引擎启动失败时显示失败原因。
13. **SSE 重连后补拉当前机器人详情**（[25]），其他已缓存的机器人详情标为过期。
14. **「加载更早」的历史不被新推送冲掉**（[29]）：无 before 的刷新按 id 合并最新一页，只在切换线程时重置。
15. **重启后仍认得被打断解绑的旧会话**（[16]）：插件自己持久化「会话 → 机器人」名册（例如 `<rootDir>/.hub/plugin/session-roster.json`，createSession 成功即记），重启后 isBotSession 用它判断，这些会话的工具调用照样过动作闸、事件照样交给 core（core 会忽略已解绑会话）。
16. **回合 token 认 `llm/retry-started`**（[11]）：同一步失败尝试与重试的用量相加。
17. **走查：线程里带卡片的消息不重复显示**：消息带 card 时只渲染卡片，不再先渲染一个内容相同的气泡。
18. **走查：卡片上的时间要说清含义**：提问「{时间} 前未答复按默认「X」处理」；审批「{时间} 前有效，过期视为拒绝」；提议「{时间} 前未答复自动撤回」（规格第 5 节过期规则：提问 72 小时、审批 24 小时、提议 7 天）。
19. **走查：「正在试跑：它会先做自我介绍」提示只在试跑唤醒排队或进行中时显示**，试跑结束（无论有没有回复）就消失。
20. **清理与 D06 实现相反的旧注释**（[41]）。

## 三、测试与工具补强

21. 补回「整轮无用量时 ended.tokens 为 null」的断言（[12][33]）。
22. 测试守护真正生效（[10][37]）：vitest 的 setupFiles 把 HOME 与 AGENT_HUB_ROOT 指到 mkdtemp 临时目录；resolveRootDir 在 VITEST 环境下解析到真实 `~/AgentHub` 时直接抛错；补「测试环境下 apply(ctx,{}) 必须失败」用例。
23. H7 检查真的能查出另铸 id（[8][32]）：单独保存「预登记 id → 实际 id」，冒烟摘要据此比对；单测用会另铸 id 的假 sessionController。
24. 生命周期按钮抽成纯函数 `lifecycleButtons(lifecycle)`，按 probation/active/paused/quarantined/retired/draft 逐一断言（[35]）；togglePause 与全部暂停/恢复的选动作逻辑同样抽出并测试。
25. 推送范围测试加强（[36]）：每个 scope 用 toEqual 断言完整刷新计划；用假 fetch 测 onChanged 实际请求了哪些接口；测试里引入 core 的 HUB_EVENT_SCOPES 与客户端词表比对。
26. 入口脚本测试（[38]）：补「name 不对」反例；验证卸载入口确实执行 `plugin --profile desktop remove dsh-agent-hub`。
27. host-port 测试（[39]）：写 approval/policy 失败时中止且不投递；nextStep 队列去重；cancel 主路径参数。
28. 修正三个「标题声称了却没断言」的用例（[40]）。
29. 走查：`scripts/fake-model-server.mjs` 的 `ownerMessageOf` 取**最新**一条「主人对你说」（现在取的是第一条，同一工作会话里第二次起的回复就对不上原话）；冒烟跑者的判定随之核对。

## 验收

```bash
pnpm --filter dsh-agent-hub typecheck
pnpm --filter dsh-agent-hub test
pnpm --filter dsh-agent-hub build
bash -n scripts/sandbox.sh && bash -n scripts/install-desktop.sh && bash -n scripts/uninstall-desktop.sh && bash -n scripts/make-entrypoints.sh
bash scripts/test-entrypoints.sh
bash scripts/sandbox.sh e2e
```

全部通过（e2e 摘要里要能看到第 1 条新增的设置检查通过）；跑前确认 3952/18080 端口没有被占用；跑完测试 `~/AgentHub` 不应因为测试出现新内容。`docs/progress/D07.md` 按编号逐条写改法与测试名。
