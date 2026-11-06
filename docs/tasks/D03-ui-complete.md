# D03 界面补全与打磨：新建队友向导、教它一招、收件箱/活动流/设置、详情可编辑、视觉

- 负责方：DSH
- 允许修改：`packages/plugin/src/client/`、`packages/plugin/test/`（界面相关）、`docs/progress/D03.md`、`docs/questions.md`（只追加）。如确需宿主路由小改，限 `packages/plugin/src/host/routes.ts` 并在进度里说明。
- 不得修改：`packages/core/`、规格与任务卡。
- 前置：D02 已验收（界面已接真引擎）。

## 目标

把「队友」页面补成主人每天会打开、像 Grok Bot 一样顺手的地方：像发短信一样和每个队友说话，审批与提问在线程里一键处理，新建队友有引导，「教它一招」能把自己做过的事教给它，收件箱、活动流、设置各有其页。视觉上像一个聊天软件：头像、气泡、按钮一眼可辨。

## 必读

`AGENTS.md`；`docs/build-spec.md` 第 1、8、11（套路与教学）、15、15.1、16 节；`docs/design/prd/sections/16-ui.md`（16.0.2 状态文案、16.0.3 文案与时间约定、16.3 收件箱、16.4 活动流、16.5 设置、16.6 新建向导——按本卡范围取用，不必全做）；`docs/dsh-research/verified-T5-client-ui.md`（插槽、主题变量、toast 做法 Q4-2、打开会话 Q4-3）；`docs/progress/D01.md`、`D02.md`。

## 先修项（总控在沙箱端到端里发现，安全相关，优先于界面工作）

A. **机器人会话的工具收窄完全失效**。沙箱 e2e 日志：`tools.restrict() names unknown global tool "subagent"; known global tools: ask_user_question, bash, create_goal, …`——`restrict` 只接受「全局层」工具名，`subagent`、`subagent_fork`、`workflow` 等来自 preset 层，混进名单后整次 restrict 抛错，结果一个都没去掉；假模型日志显示机器人看得到 46 个工具，含 ask_user_question、exit_plan_mode、create_goal、update_goal、schedule_create/list/update/delete、subagent、subagent_fork、workflow、list_agents、send_message、interrupt_agent、working_directory。要做：
   1. restrict 名单只放「当前确实存在的全局层工具名」（用 tools 注册表的列举接口拿全局名单，查不到列举接口就从该报错文本里的 known global tools 规则推导不可靠——请查 dsh-tools 源码找到正确的列举方法，见 verified-T3 Q2-b），与禁用清单求交集后再调用；
   2. 双保险：在 `tools/pre-execute` 里对机器人会话直接拒绝禁用清单里的**所有**工具名（不论全局还是 preset 层），返回中文原因「Agent 中心的机器人不能使用 {工具}：{原因}」；
   3. 测试：假 ctx 下 restrict 只收到全局名；pre-execute 对机器人调用 subagent/ask_user_question/schedule_create 等一律拒绝、对普通会话放行；
   4. e2e：假模型剧本在 trial 回合的第一步先调用一次 `ask_user_question`（参数随便），断言工具结果是错误，然后照常 hub_state_get → hub_commit；冒烟跑者在 summary 里报告「禁用工具已被拦截」。
B. **沙箱的中心根目录不能放在项目里**：`.sandbox/AgentHub` 位于 agent-hub 仓库内，DSH 顺着目录向上加载 AGENTS.md，把项目的开发守则注入给了机器人。把沙箱的 `AGENT_HUB_ROOT` 改到仓库外：`${TMPDIR:-/tmp}/agent-hub-sandbox/AgentHub`（e2e 开头照旧清空它）。

## 总控在沙箱里看到的问题（必须修）

1. 左栏与线程里的头像没有彩色圆底：用 `BotCard.color` 作为内联 `background`（数据驱动的颜色允许内联，样式表里仍不得硬编码颜色），`initials` 白字居中，直径 32px（线程 28px）。
2. 提问/审批/提议卡片里的选项看起来像普通文字：改成明确的按钮（圆角、描边；默认选项用主色填充），悬停与按下有反馈，已作答的卡片显示「你选了：…」并禁用按钮。
3. 消息缺少气泡：主人消息靠右、主色淡底气泡；机器人消息靠左、中性底气泡带头像与名字；中心/日报/系统消息居中、小字、无气泡；汇报（report）气泡左侧加一条细色条。连续同一发送者的消息合并头像。
4. 线程头部只有名字：加上角色、状态句（activityText 的完整形）、下次自查文案（nextThinkText），右侧放「教它一招」「打开工作会话」「暂停/恢复」按钮。

## 要做

### 1. 新建队友向导（顶栏「新建队友」）

中栏弹出分步表单（可返回上一步，草稿存在内存与 localStorage，读写包 try/catch）：
1) 名字（1–20 字，重名实时提示）+ 角色（四张卡片：总管「统筹全队、分派与跟进，最多 1 个」、调研「盯信息源、做研究、写结论」、执行「把事情做完，按规矩交付」、盯守「盯运行记录与期望，异常就报」；已有总管时总管卡禁用并说明）+ 头像颜色（8 个预设色板，存入 color）。
2) 性格与说话风格（多行，≤ 300 字；按角色给 2 条示例可一键填入）。
3) 志向 1–3 条（每条一行；按角色给示例，例如盯守「我的自动线每天按时跑完，出问题第一时间知道」）；可选：第一个目标（标题、完成标准、周期）。
4) 自主等级（L0 只观察 / L1 建议（默认）/ L2 执行；L3 不在向导里出现）、节奏（积极 / 适中 / 安静）、模型（来自 settings 视图的 modelOptions，默认「跟随 DSH 默认」）。
5) 起步关注（可跳过）：类型（文件/日志/网页/RSS/脚本）+ 目标 + 说明；文件/日志给出「选择路径」输入框；网页/RSS 校验 URL。
6) 确认页：一段话复述（「我是 {名字}，{角色}。我的志向是…。我会先盯着…，有事会在这里找你。」）+「让它上岗」按钮 → `createBot` → 成功后跳到它的线程，显示「正在试跑：它会先做自我介绍」的系统提示；失败显示原因。

### 2. 教它一招（线程头部按钮、右栏按钮）

弹窗：列出 `recentSessions`（标题、更新时间，可搜索），选一个 + 一句说明（「把我刚才在这个会话里做的事学成套路」）→ `teach` 命令 → 线程里出现中心消息「已把会话 {标题} 交给 {名字} 学习」。右栏「会的套路」可点开查看步骤并编辑（`editRoutine`），保存后提示已更新。

### 3. 收件箱页（左栏底部入口）

按 P0/P1/P2 与类型分组；每项显示队友头像与名字、标题、正文、剩余有效期；操作：提问选选项或填自由文本、审批批准/拒绝（可附一句话）、提议接受/拒绝、告警「知道了」。处理后从列表消失并在对应线程里能看到结果。空态：「没有要你处理的事。队友们会在需要你拍板时出现在这里。」

### 4. 活动流页（顶栏入口）

全队时间线（唤醒、交账、审批、告警、交接、生命周期），每行：时间、头像、文字；按队友与类型筛选；向下加载更多。

### 5. 设置页（顶栏齿轮）

免打扰时段、日报时间、推送渠道（macOS 通知 / 不推）、每日单推上限、默认模型、根目录（只读显示）、「全部暂停 / 全部恢复」（对所有在岗与试岗队友调用 setLifecycle）、版本与健康（心跳、停机记录、额度灯说明）。保存走 `updateSettings`，非法值给出中文提示。

### 6. 机器人详情可编辑（右栏）

档案（性格、自主等级、节奏、模型）编辑；志向增删改；目标：完成待验收的显示「验收通过 / 没过」按钮；关注项：提议中的显示「同意 / 不要」，在用的可暂停/删除；规矩：新增一条（可勾选「红线」）；生命周期：暂停 / 恢复 / 提前转正（试岗满 3 天时可用）/ 解除停用 / 退役（二次确认）。

### 7. 提醒与入口计数

- 有新的 P0/P1 收件箱项时，通过 SSE 在 `shell.overlay` 显示一个 4 秒的应用内提示（照 verified-T5 Q4-2 的官方样式，只用主题变量），点击跳到收件箱。
- 左栏入口 label 用 thunk：有待处理收件箱时显示「队友 · N」。

### 8. 打开工作会话

照 verified-T5 Q4-3 的 `openBotSession`（含 workspaces.state==='error' 判断），返回 opened/loading/archived/unavailable 时给出相应提示。

## 约束

- 颜色只用 `var(--dsw-alias-*)` 等主题变量（数据驱动的头像底色除外，用内联样式）；不 require Harness 客户端组件包；所有插槽注册 try/catch；每个页面组件外包错误边界，出错只在该块显示「这块没显示出来，刷新试试」。
- 文案、时间写法按 16-ui.md 16.0.3；界面里不出现会话 id、工具名（hub_*）、英文状态码。
- 单文件 ≤ 400 行，按页面/组件拆分，中文注释。

## 测试

vitest（jsdom 不可用时用纯函数测试）：向导每步校验（名字长度、重名、志向 1–3 条、URL 校验）、复述文案生成、收件箱分组与排序、活动流筛选、设置项校验、入口 label 计数、openBotSession 各分支、气泡分组（连续同一发送者合并头像）。测试数 ≥ 40。

## 验收

```bash
pnpm --filter dsh-agent-hub typecheck
pnpm --filter dsh-agent-hub test
pnpm --filter dsh-agent-hub build
```

全部通过；构建产物与样式里搜不到十六进制/rgb/hsl 颜色（styles.css）与 `@deepseek-ai/dsh-client-ui-primitives`。总控会在沙箱里亮色、暗色各走查一遍：新建队友 → 线程里出现自我介绍 → 发消息收到回复 → 教它一招 → 处理一条审批。
