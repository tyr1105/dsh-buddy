# 底稿：主动唤醒与后台常驻（R2、R9）

> 研究底稿（2026-11-04，DSH 桌面版 0.2.1-rc.5）。先由一位读者细读官方插件说明与源码，再由另一位核查员逐条尝试推翻承重结论；「核查」一节里的修正优先于「读者结论」。证据路径中的 `dsh-src/` 指从安装包只读解出的官方插件源码，可用 `tools/asar_extract.py` 重新解出。

## 读者总结

DSH 自带一个能落盘的定时提醒服务 schedule。它支持一次性、固定间隔（至少 60 秒）、每日、每周、cron 几种规则。到点后它把一条消息投进机器人自己的会话，并真的开一轮让机器人干活；会话没打开过也会被自动恢复。任务存在 ~/.dsh/storages/schedule.json，重启或升级后还在，错过的只补最近一次。插件不经过模型，就能直接调用宿主的 ctx.schedule.create(会话id, …) 给任意根会话批量排班，这是 Agent 中心最关键的现成零件。硬伤是它只在 DSH 桌面 App 开着时才运行：关窗口没事（只是隐藏），但退出 App、电脑睡着都不会触发；没有开机自启，没有防休眠，Host 崩溃后要有人点对话框才能重启。文件变化、webhook、收到飞书消息这类事件触发没有现成插件，但宿主有 timer、fs.watch、webServer 路由等零件可以自己写。DSH 本身没有会话并发上限，「活动会话已达上限 2」来自用户自写的桥插件。

## 逐题回答

**问题 说明**

下文证据路径里的 dsh-src 指 dsh-src。按禁区要求，profiles 下的 package.json 和 cordis.patch.yml、storages 里的数据、sessions 里的内容都没读，只列了目录名。

**问题 1**

触发类型有 6 种：after_seconds（一次性，至少 1 秒的正整数）、at（绝对时间，必须晚于现在）、every_seconds（至少 60 秒，代码里小于 60 会返回 frequency_too_high）、daily 和 weekly（必须写 IANA 时区）、cron（5 字段，最小 1 分钟）。冷会话恢复：到期时 runtime 调 sessionController.resolveAgent，冷会话会从日志恢复，并按会话记录的 preset 重建 Agent，然后 followup 唤醒、开新一轮（lib 代码确认）。错过补发：Host 必须在运行；启动时会重扫，重复任务只补最近一次错过的时点，同一会话的多个重复任务合并成一条批量消息，一次性任务补一次后转为 inactive（README 和代码都确认）。持久化位置：宿主 storage domain「schedule」，JSON 后端写 ~/.dsh/storages/schedule.json（本机已存在），每次变更重写整个文件；发送历史默认每个任务保留 30 天、200 条，可配置。数量上限：代码里没有任务条数的上限常量。最短间隔：every 是 60 秒，cron 是 1 分钟，after 是 1 秒。是否只投原会话：是。任务创建时绑定一个 sessionId，到期只投到这个会话，事后不能改绑，也不支持每次运行新开会话。模型用工具只能给自己的会话建任务；但宿主服务的 create 由调用方指定 sessionId，所以插件可以给任意根会话建（子代理会话会被拒绝）。

**问题 2**

可以。服务名是 schedule（ScheduleService 继承 TypertRemoteService，构造时 super(ctx,'schedule')，注册为 Cordis 服务 ctx.schedule）。可调用的方法：create(sessionId, {prompt, title, after_seconds|at|every_seconds|daily|weekly|cron}, signal?)，代码注释写明 bound to the caller-selected Session without activating it；list({sessionId})；catalog()；history({sessionId,id,limit,before?})；update({sessionId,id,expected,title?,prompt?,change?})；delete({sessionId,id})；另有事件 schedule/changed。官方 dsh-tool-schedule 的调用方式是 lib/index.js:497 的 ctx.inject(['schedule'], …)，加上 :540 的 ctx.schedule.create(agent.session.id, args, exec.signal)。注意事项：(1) 浏览器 Remote 只开放 list、catalog、history、update、delete（lib/index.js:1902-1906），Agent 中心页面要建任务，必须经过自写的 Host 插件中转；(2) create 不校验会话是否存在，要先用 sessionController.create 建好根会话；(3) 用户插件能注入 sessionController 等宿主服务（桥插件已验证），schedule 和 session-controller 挂在同一层（dsh-web-app/cordis.patch.yml:62、139），所以应该也能注入，但还没实测；(4) 这是 0.2.1-rc 阶段的接口，没有稳定性承诺。

**问题 3**

关窗口：主窗口只是被隐藏，Host 继续跑，定时任务照常触发（main.js:12894-12906）。macOS 没有菜单栏或托盘图标，App 留在 Dock；Windows 有托盘。退出 App：会先弹确认框，写着「应用关闭期间，定时任务不会运行」；确认后 backend.close()，Host 先收到 shutdown，10 秒后 SIGTERM，再过 5 秒 SIGKILL。Electron 一退出，Host 也会因为 disconnect 自己停下，所以退出后没有任何东西在跑。系统关机或注销时跳过确认。电脑休眠：没有 powerSaveBlocker，休眠期间什么都不运行；powerMonitor 的 resume 只用来检查更新，没有通知 Host 重新排程。schedule 靠单个 setTimeout，醒来后能不能立刻补投取决于 Node 定时器在 macOS 上怎么处理休眠时间，没实测，有延迟风险。开机后：代码里没有 setLoginItemSettings 或 openAtLogin，不会自启，要用户自己打开或加登录项；打开后 Host 启动、schedule 初始化，requestDrive 立刻补投。App 没运行期间到期的任务：下次启动时每个任务最多补 1 次（重复任务取最近一次错过的时点，同一会话的多个重复任务合并成 1 条消息；一次性任务补 1 次）。如果关闭或崩溃发生在投递中途，可能再多投 1 次，因为是至少一次语义。升级：要用户确认安装，安装后自动重开，任务从 schedule.json 恢复；但自写插件可能因为接口变化失效，桥在 rc.2 已经踩过。崩溃：不会自动重启，会弹阻塞对话框等人点。

**问题 4**

jobs 是 Host 进程内的后台任务登记处（dsh-jobs 定约定、dsh-jobs-local 实现、dsh-tool-jobs 提供 job_output、job_list、job_kill 和完成通知）。生产者是 bash 的 run_in_background、PTY 终端和子代理。每个 job 归属启动它的会话，其他会话看不到也停不了；每个会话默认最多 10 个同时运行；输出环运行时保留 256KB，结束后保留 16KB。和会话的关系：job 结束时会通知所属会话，会话忙就注入下一步，会话空闲就新开一轮把机器人唤醒（completionDelivery 默认 wakeup，可设 maxConsecutiveWakes 封顶）；会话被归档时会停掉它的 job；所属 Agent 被释放时 job 被取消。能不能承载机器人的长时间工作：只能承载「醒着的这一次」里的长命令，比如跑 2 小时的抓取，跑完自动叫醒机器人收结果。不能承载跨天的工作，因为 job 和输出都只在内存里，Host 退出、崩溃或升级就没了，只有生命周期事件写进会话日志。所以 schedule 负责定时叫醒，jobs 负责醒着时跑长命令，两者是互补关系。另外，机器人所用的预设里要有 tool-jobs（standard 有）。

**问题 5**

现成的事件触发只有：schedule 到点、job 完成、子代理结算，以及实验性 agent-team 成员之间发消息（steer 唤醒，只适用于队友，而队友是子代理）。没有随包交付的文件变化、webhook、飞书或邮件消息触发器。UI 能渲染 webhook 和 github 来源的消息，dsh 的 README 提到仓库的 config/examples 里有 GitHub 评审 webhook 覆盖层，但安装包的 308 个包里没有它的生产者。插件可以自己做：(1) 轮询用 ctx.interval 或 ctx.timeout（dsh-base 默认挂载 cordis-plugin-timer，卸载时自动清理），也可以直接用 setInterval（桥就是每 2 秒扫一次文件夹）；(2) 文件监听用 ctx.fs.watch，只监听单个文件或目录的第一层；(3) 本机 webhook 用 ctx.webServer.register，但桌面版只绑 127.0.0.1、端口随机、没有内置鉴权，外网推送进不来；(4) 触发后用 sessionController.resolveAgent 拿到 Agent，再 agent.followup({content, source:{kind:自定义}})，或者用 sessionController.prompt 唤醒。硬性要求：回调里的异常必须捕获，否则 installFailLoud 会让整个 Host 退出。

**问题 6**

「活动会话已达上限 2」是用户自写桥插件的限制，不是 DSH 的限制。证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:54 的 DEFAULT_MAX_ACTIVE_SESSIONS = 2，:309-312 抛出这句文案，:161 允许在 ~/.dsh/claude-bridge/settings.json 里调成 1–4；它只统计桥自己开的、还没结束的会话。DSH 本身在 session-controller、agent 注册表、agent-loop 里都没有活会话数或并发轮次的上限，schedule 投递也不设上限。存在的局部上限有：单步内并行工具调用 maxParallelToolCalls 默认 10，每个会话的后台 job 10 个，每棵子代理树 maxActiveSubagents 8 个、委派深度 1；遇到模型限流时，normal 模式最多重试 5 次（退避 0.5–10 秒），之后这一轮报错。真正的天花板是模型额度（订阅每 5 小时上限）和本机内存。DSH 不会替你排队，N 个机器人在同一时刻醒来会同时调用模型，所以 Agent 中心需要自己做错峰和并发闸门。

## 能力清单（* 为承重结论）

- **C1**（依据：both；对应 R2）schedule 支持 6 种触发规则，每次只能选一种：after_seconds（一次性延迟，正整数秒）、at（绝对时间，必须严格晚于现在）、every_seconds（固定间隔，至少 60 秒）、daily 和 weekly（指定 IANA 时区的本地钟点）、cron（标准 5 字段，最小粒度 1 分钟）。每条任务都必须有 title（不超过 120 字）和非空 prompt。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:28-45（选择器表与 cron 方言）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:941（after_seconds must be a positive safe integer）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1010（every_seconds < 60 抛 frequency_too_high）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2083-2096（create 要求六选一）
- **C2***（依据：both；对应 R2）到点后，宿主用 sessionController.resolveAgent(会话id) 取到活的 Agent。会话如果是冷的（本次运行没打开过），会从磁盘日志恢复，并按会话记录的 preset 重建，然后调用 agent.followup(提醒消息) 并 flush。followup 会把消息放进下一轮收件箱并唤醒驱动器，Agent 空闲时立刻开新一轮。所以机器人是在原会话里、带着全部历史被真正叫醒干活的。这条消息是 user 角色，source.kind 为 schedule，前缀为 [SCHEDULE REMINDER]。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1576-1597（resolveAgent → createUserMessage(source kind schedule) → followup → sessions.flush）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:800-812（followup = send(input,'next-turn',wakeup=true)）及 845-865（wakeDriver：idle 时开新轮）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:210-240、370-395（resolve → resume → ctx.agents.resume，按 presetForObservation 组合）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:12、65、125-139
- **C3***（依据：both；对应 R2, R9）任务落盘在宿主级 storage domain「schedule」，JSON 后端存成单文件 ~/.dsh/storages/schedule.json（本机已有这个文件，没读内容）。Host 每次启动都会 requestDrive，把所有 active 任务重扫一遍。错过的补发规则：重复任务（every、daily、weekly、cron）只补最近一次错过的发生时点；同一会话里同时到期的多个重复任务，合并成一条 [SCHEDULE REMINDER BATCH]；一次性任务补发一次后转为 inactive。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1675（defineDomain name 'schedule'）、2024-2028（初始化即 requestDrive）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:595-620（resolveEveryOccurrence 只算最近一次，不枚举错过的历史）、661-672（daily 同理：not across its missed history）、1571（同会话重复任务成组投递）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:12、143、161
  - 证据：dsh-src/@deepseek-ai/dsh-storage-json/README.zh.md:12、72（single 布局，每次写入整文件原子替换）
  - 证据：ls /Users/bytedance/.dsh/storages 可见 schedule.json
- **C4***（依据：both；对应 R1, R2, R8, R10）插件可以不经过模型，直接调用宿主服务 ctx.schedule（Cordis 服务键 schedule）给任意根会话排班。create(sessionId, {prompt, title, 选择器}, signal?) 的 sessionId 由调用方指定，调用时不会激活会话。另有 list({sessionId})、catalog()（全宿主所有任务，含 sessionId、下次时间、状态、最近回执）、history、update、delete 几个方法，任务变更提交后会广播 schedule/changed 事件。官方 dsh-tool-schedule 也是先 ctx.inject(['schedule'])，再调用 ctx.schedule.create(agent.session.id, …)。浏览器侧的 Remote 只开放 list、catalog、history、update、delete，没有 create。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1992（super(ctx,'schedule')）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2068-2083（create 注释：Create a reminder bound to the caller-selected Session without activating it）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1902-1906（Remote 装饰器只有 list/catalog/history/delete/update）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2129-2136（catalog 返回 sessionId/status/lastDelivery）、2229-2236（emit schedule/changed）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:497（ctx.inject(['schedule'])）、540（ctx.schedule.create(agent.session.id, args, exec.signal)）
  - 证据：dsh-src/@deepseek-ai/dsh-typert-protocol/lib/index.js:339-351（TypertRemoteService 用 serviceKey 注册为 Cordis 服务）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:47
- **C5**（依据：both；对应 R2, R3）机器人也能自己管闹钟。standard、cordis、ptc 三个预设挂载了 schedule_create、schedule_list、schedule_update、schedule_delete 四个工具（minimal 没有），模型干完活后可以给自己排下一次唤醒。同一批预设还挂载了 dsh-time-context，醒来时模型能看到当前时间、时区和距上一条消息过了多久。限制是这些工具只作用于调用者自己的会话。
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:19-20、33-36
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:532-540（只用 exec.agent.session.id）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/README.zh.md 概述与「四个工具」
  - 证据：dsh-src/@deepseek-ai/dsh-time-context/README.zh.md:12
- **C6***（依据：code；对应 R9）关窗口不等于退出。主窗口的 close 事件被拦截，改成隐藏窗口，Host 子进程继续跑，定时任务照常触发；macOS 上 window-all-closed 不会让 App 退出。Windows 有常驻托盘，第一次关窗口时会提示「正在运行的任务不会中断」；macOS 没有托盘，App 只留在 Dock 里。
  - 证据：dsh-src/_app/main.js:12880-12906（close → preventDefault → hideMainWindow）
  - 证据：dsh-src/_app/main.js:13063-13065（window-all-closed 只在非 darwin 时 quit）
  - 证据：dsh-src/_app/main.js:12804-12816（new DesktopTray 只在 win32）
  - 证据：dsh-src/_app/main.js:7485（backgroundNoticeBody 文案）
- **C7**（依据：both；对应 R2, R5）jobs 是 Host 进程里的后台任务登记处（ctx.jobs）。bash 的 run_in_background、PTY 终端、子代理都登记成 job，归属启动它的会话，别的会话看不到；每个会话默认最多 10 个同时运行。job 结束时，dsh-tool-jobs 会通知所属会话：会话忙就注入到下一步，会话空闲就新开一轮把它唤醒（completionDelivery 默认 wakeup，可用 maxConsecutiveWakes 限制连续唤醒次数）。适合的场景是：一次唤醒里跑一个长命令，跑完自动再叫醒机器人。
  - 证据：dsh-src/@deepseek-ai/dsh-jobs/README.zh.md 概述与「归属边界」
  - 证据：dsh-src/@deepseek-ai/dsh-jobs-local/README.zh.md 配置表（maxConcurrentJobsPerOwner=10、retainBytes=262144）
  - 证据：dsh-src/@deepseek-ai/dsh-jobs-local/lib/index.js:358
  - 证据：dsh-src/@deepseek-ai/dsh-tool-jobs/README.zh.md「完成通知」
  - 证据：dsh-src/@deepseek-ai/dsh-tool-jobs/lib/index.js:91-92、226-227
  - 证据：dsh-src/@deepseek-ai/dsh-tool-bash/README.zh.md:12、62
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:96-97、289-290
- **C8**（依据：both；对应 R2, R10）宿主有自建事件触发要用的零件：ctx.timeout 和 ctx.interval（cordis-plugin-timer，dsh-base 默认挂载，插件卸载时自动清理）；ctx.fs.watch(target, changed, signal)（监听单个文件，或目录下第一层的子项）；ctx.webServer.register(route)（在 Host 的 HTTP 服务上注册路由，可以做本机 webhook 入口）。把这些和 sessionController.resolveAgent + agent.followup，或 sessionController.prompt 组合起来，就能实现「事件发生 → 唤醒某个机器人」。用户自写的 dsh-claude-bridge 已经用 setInterval 每 2 秒扫文件夹，加上 ctx.sessionController.create 和 prompt，跑通了这条路。
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:24-25（id: timer 挂载 cordis-plugin-timer）
  - 证据：dsh-src/@deepseek-ai/cordis-plugin-timer/src/index.ts（TimerService.timeout/interval 经 ctx.effect 注册，卸载即清理）
  - 证据：dsh-src/@deepseek-ai/dsh-fs-local/lib/index.js:726-748（watch，depth 0）；dsh-src/@deepseek-ai/dsh-fs/README.zh.md:38
  - 证据：dsh-src/@deepseek-ai/dsh-host-webserver/lib/index.js:286、326；README.zh.md:61
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js（inject sessionController 等；createSessionInvoke 直连 ctx.sessionController）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:50、137-143（setInterval 轮询）、315-345（session.create/prompt）
- **C9**（依据：both；对应 R2, R6）现成的非人类触发唤醒只有四种：schedule 到点、job 完成、子代理结算、实验性 agent-team 成员之间发消息（用 steer 唤醒，能冷恢复队友）。安装包里没有文件变化、webhook、飞书消息这类触发插件。聊天 UI 能渲染 webhook 和 github 来源的消息，dsh 的 README 也提到仓库 config/examples 里有 GitHub 评审 webhook 覆盖层，但 308 个包的 lib 里都找不到 webhook 消息的生产者。
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-chat/lib/client.js:7079-7090（webhook/github/schedule 来源的标题与图标）
  - 证据：dsh-src/@deepseek-ai/dsh/README.zh.md:54（config/examples 的 GitHub 评审 webhook 覆盖层，不在默认 profile）
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1598-1610（source kind agent-message，root.steer）
  - 证据：grep：各包 lib 中 "webhook" 只出现在 UI 渲染和 session-format 迁移表里
- **C10***（依据：code；对应 R1, R9）DSH 本身没有「同时活动会话数」上限：session-controller、agent 注册表、agent-loop 里都没找到活会话上限或空闲回收逻辑。能找到的上限都是局部的：单步内并行工具调用 maxParallelToolCalls 默认 10，每个会话后台 job 10 个，每棵子代理树 maxActiveSubagents 8 个。「活动会话已达上限 2」是用户自写桥插件的护栏（DEFAULT_MAX_ACTIVE_SESSIONS = 2，settings.json 可调成 1–4），而且只统计桥自己开的会话。
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:53-54（DEFAULT_MAX_ACTIVE_SESSIONS = 2）、161（settings 范围 1-4）、309-312（抛出「活动会话已达上限」）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/README.md「限制」节
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:553、619、1554（maxParallelToolCalls 默认 10）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/README.zh.md:49、53（maxDepth 1、maxActiveSubagents 8）
  - 证据：grep：dsh-api-session-controller、dsh-agent、dsh-agent-loop 的 lib 中无 maxLive/maxActive/evict/idleTimeout
- **C11**（依据：code；对应 R9）重启和升级后任务不丢。这个版本的升级要用户自己点下载，再单独确认安装（autoDownload=false、autoInstallOnAppQuit=false，安装包里也没配强制更新策略）。安装后 quitAndInstall 会自动重开 App，Host 启动时从 schedule.json 恢复任务并补发逾期的。退出或升级前，Electron 会先问 Host 有没有正在运行的任务和已开启的提醒。
  - 证据：dsh-src/_app/main.js:7806-7807（autoDownload=false、autoInstallOnAppQuit=false）、7871-7889（install：separate user confirmation → quitAndInstall）
  - 证据：dsh-src/_app/main.js:7554（zh 文案：更新期间应用将暂时关闭，完成后会自动打开）
  - 证据：dsh-src/_app/package.json 无 dshMandatoryUpdatePolicy
  - 证据：dsh-src/_app/main.js:3855-3876（updateTasks/inspectQuit）

## 限制清单（* 为承重结论）

- **L1*** 只有 DSH 桌面 App 开着、Host 子进程活着的时候，机器人才能被唤醒。退出 App 时 Host 会被关掉：先发 shutdown，10 秒不退就发 SIGTERM，再等 5 秒发 SIGKILL。退出确认框写明「应用关闭期间，定时任务不会运行」。Electron 主进程没了，Host 收到 disconnect 也会自己停下，不能脱离 App 单独常驻。schedule 也不能在 headless 或 SDK 组合里单独挂载。
  - 影响：机器人能主动干活的时间，上限就是这台 Mac 加上 DSH 在线的时间。想 7×24 小时运行，就得常开机器、常开 App，或者换一台常开的机器。
  - 证据：dsh-src/_app/main.js:7483-7484（quitScheduledTasks 文案）、11626-11629
  - 证据：dsh-src/_app/main.js:13068-13130（before-quit → 确认 → finishQuit → backend.close()）
  - 证据：dsh-src/_app/main.js:3910-3924（stop：shutdown → 10s → SIGTERM → SIGKILL）
  - 证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:325（process.once('disconnect') → stop）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:26、153（宿主必须运行才能投递提醒）
- **L2*** 没有开机自启，没有防休眠，电脑醒来后也不会主动重新排程。main.js 里 setLoginItemSettings、openAtLogin、powerSaveBlocker 一次都没出现；powerMonitor 只在 resume 时检查更新、在 shutdown 时跳过退出确认。schedule 只靠一个 setTimeout(...).unref() 等最近的到期时间；如果 Node 的定时器不把休眠时长计算在内，醒来后任务会比预定晚触发（这点没实测）。休眠时正在进行的模型请求也会断。
  - 影响：笔记本合盖，所有机器人一起停。早上的定点任务可能被推迟。用户得自己加登录项、调电源设置或用外部工具保持唤醒；Agent 中心最好自带一个按真实时间检查到期任务的兜底巡检。
  - 证据：grep dsh-src/_app/main.js：powerSaveBlocker=0、setLoginItemSettings=0、openAtLogin=0
  - 证据：dsh-src/_app/main.js:12697-12705（powerMonitor resume 只触发 automaticCheck 检查更新）、13066-13068（shutdown 只设 sessionEnding）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1495、1641-1645（单一 setTimeout，unref，按 next-Date.now() 计算）
- **L3*** 崩溃后不能自动恢复。Host 子进程异常退出后，DesktopBackendController 不会重试，而是直接弹出阻塞对话框（退出 / 重启 / 禁用第三方插件并重启），必须有人点。Host 启动时装了 installFailLoud，任何未捕获异常或未处理的 Promise 拒绝都按致命错误处理并以退出码 1 退出。任何一个插件在定时器或事件回调里抛错，都会带崩整个 Host。
  - 影响：无人值守时，一个插件 bug 就能让全部机器人停到有人回来点按钮。自写 Agent 中心插件的所有回调都必须 try/catch，另外还需要一个外部看门狗。
  - 证据：dsh-src/_app/main.js:7210-7225（failed 只更新 error 状态，不重启）、12251（host error → reportFatal）、11869-11878
  - 证据：dsh-src/_app/main.js:8325-8380（DesktopFatalRecovery 对话框：exit/restart/disableThirdPartyPlugins）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4216-4253（installFailLoud：uncaughtException/unhandledRejection → exit 1）
  - 证据：dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:280-288（runProfile 安装 installFailLoud，desktop-host 经由 runProfile 启动）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:109-110（失败矩阵：定时器同步回调抛错 → 致命错误）
- **L4** 投递只保证至少一次，不保证恰好一次。入队和写任务行是两次独立写入，崩溃或关闭时可能重复投递。投递失败（会话恢复失败、写锁被别的进程占着、flush 失败）只记一条警告，那条任务会被排除出本次定时计算，没有自动重试的定时器；要等下一次有任务被增删改、别的任务到期或 Host 重启才会重试。
  - 影响：机器人的任务要设计成重复执行也不会出问题（幂等）。Agent 中心需要自己巡检漏投：用 catalog 里的 scheduledAt 对比 lastDelivery。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:65、153-154
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1621-1636（失败进入 failed 集合，不参与下次定时）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:226-237（session/writer-held 等恢复失败）
- **L5** 任务在创建时绑死一个会话，到期只投到这个会话，事后不能改绑。不支持暂停、立即执行、投到别的会话或每次运行新开会话。子代理会话（委派深度大于 0）不能挂提醒：create 会以 subagent_session 拒绝。归档一个还有活动提醒的会话会被拒绝；选择停止时会删掉这个会话的全部提醒。
  - 影响：每个机器人必须是一个长期存在的根会话。如果把机器人做成 agent-team 的队友（子代理），就用不了 schedule。一键暂停要自己实现：删掉再重建，或者用 pre-step 拦截。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:49、157-158
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2254-2262（reminderTargetRefusal）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-schedule/README.zh.md 已知限制（不提供暂停或立即执行；页面「新建」只是开新会话）
- **L6** 被唤醒时默认只跑一轮。会话冷恢复（每次 agent/created）后，goal 的自动续行会被关掉；而 schedule 消息的 source.kind 是 schedule，不是 user。dsh-tool-goal 的 resume 要求本轮里有人类消息，所以模型醒来后没法自己重新打开 goal 续行。
  - 影响：想让机器人醒来后连续推进多轮，要由 Agent 中心插件代为执行 /goal resume 或调用 ctx.goals.resume；否则只能设计成「每次醒来干一轮，再自己排下一次」。
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md:75、99（续行开关不落盘，agent/created 时关闭）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:49-52（hasDirectHumanInput 要求 source.kind === 'user'）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1594（source kind schedule）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-goal/README.zh.md:55、72
- **L7** jobs 只存在于 Host 进程内存里：Host 退出、崩溃或升级，运行中的 job 和输出就没了，只有生命周期事件写进会话日志。所属 agent 被释放（比如会话被归档停止）时 job 会被取消；所属者被释放后，还没领取的完成通知也会丢。每个会话最多 10 个同时运行。
  - 影响：jobs 不能承载跨天的机器人工作，只能承载一次唤醒里的长命令。
  - 证据：dsh-src/@deepseek-ai/dsh-jobs-local/README.zh.md「已知限制」（任务只存在于进程本地）
  - 证据：dsh-src/@deepseek-ai/dsh-jobs/README.zh.md「可能出什么问题」
  - 证据：dsh-src/@deepseek-ai/dsh-tool-jobs/README.zh.md「已知限制」
- **L8** 同一份数据只能有一个 Host 在写。Electron 有单实例锁；JSON 存储没有跨进程写锁，domain 变更也只在本进程可见；每个会话有 flock 写锁。headless 一次性模式会拒绝续跑带 agent preset 的会话（桌面会话一般都带），而且默认不用 GUI 里保存的登录凭据。
  - 影响：不能靠「再起一个 dsh 常驻进程」或「用 launchd 定时跑 headless」来代替桌面 App 去唤醒同一批机器人，否则会重复投递或抢锁失败。
  - 证据：dsh-src/_app/main.js:7659（requestSingleInstanceLock）、7498（startupAddressInUse 文案）
  - 证据：dsh-src/@deepseek-ai/dsh-storage-json/README.zh.md:141（没有跨进程写锁）
  - 证据：dsh-src/@deepseek-ai/dsh-storage-domain/README.zh.md:146
  - 证据：dsh-src/@deepseek-ai/dsh-session-persistence-jsonl/README.zh.md:168（session.lock flock）
  - 证据：dsh-src/@deepseek-ai/dsh-headless/lib/index.js:222-223（runs under agent preset … does not compose）
  - 证据：dsh-src/@deepseek-ai/dsh-headless/README.zh.md「凭据」节
- **L9** 规模和容错方面：代码里没有任务条数上限，但 JSON 后端每次变更都重写整个 schedule.json，全部发送历史也常驻内存（默认每个任务保留 30 天、200 条）。schedule.json 损坏或含非法任务时，整个 schedule 服务会拒绝启动；因为它不在必需插件列表里，App 照常启动，只打一条警告。另外没找到空闲 Agent 的回收逻辑，被唤醒过的会话可能在本次运行中一直占着内存（没实测）。
  - 影响：机器人上到几十个时，要留意写盘放大和内存占用；schedule.json 需要备份和校验，否则一次损坏会让所有机器人的闹钟悄悄失效。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:73、161
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1880-1882、1976-1979（deliveryHistoryDays 30 / Records 200）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:43（必需插件列表不含 schedule）
- **L10** 事件触发没有现成插件。桌面版 Host 的 HTTP 服务只绑 127.0.0.1，端口每次启动随机分配，路由也没有内置鉴权，所以外网的 webhook（比如飞书事件推送）打不进来。
  - 影响：要接飞书等外部消息，插件只能自己向外轮询，或者维护一条对外长连接；本机 webhook 也要自己做 token 校验。
  - 证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:233-240（--host 127.0.0.1 --port 0）
  - 证据：dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md:130（不提供服务器级认证）
- **L11** 退出时的「有定时任务」检查只看本次运行里加载过的会话，没加载过的冷会话上的提醒不算在内。代码注释还说这些提醒「不会触发」，和 schedule 运行时会冷恢复会话的实现矛盾。
  - 影响：用户退出 App 时可能收不到警告；注释和实现不一致，要实测确认冷会话提醒的真实行为。
  - 证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:151-181（quit-inspection 只遍历 agents.list()）

## 核查结果

- **C2：部分成立**。原结论：到点后宿主用 sessionController.resolveAgent 取到活的 Agent，冷会话从日志恢复并按记录的 preset 重建，再 followup 加 flush，空闲时立刻开新一轮。机器人是在原会话里、带着全部历史被叫醒的。消息是 user 角色，source.kind 为 schedule，前缀为 [SCHEDULE REMINDER]。
  - 核查说明：主链路在 lib 代码里确认成立。drive() 对到期任务调用 ctx.sessionController.resolveAgent。没有活 Agent 时走 resume → observeSession → composeAgent(presetForObservation(...)) → ctx.agents.resume，从持久日志恢复，并按会话记录的 preset 重建。随后调用 agent.followup(message)，再 await ctx.sessions.flush。followup 就是 send(input,'next-turn',true)：Agent 空闲时立即开新一轮；正在忙时，消息排到当前回合结束后接着跑（turn() 结尾 inbox.hasPending 为真就继续下一轮）。消息由 createUserMessage 生成，role 固定为 user，source.kind 为 'schedule'。

需要更正和补充四点：
① 前缀不总是 [SCHEDULE REMINDER]。只有一次性任务（after_seconds、at）用 [SCHEDULE REMINDER]，后面跟 schedule_id_json、occurrence_at、reminder_prompt_json。every、daily、weekly、cron 这类周期任务，哪怕只有 1 条到期，也一律用 [SCHEDULE REMINDER BATCH]，后面跟 reminders_json 数组。两种格式第二行都是固定文本 This is a scheduled message from the user。主动型机器人主要靠周期任务唤醒，机器人指令要按 BATCH 格式来写。
② 冷恢复有前提。会话记录的 preset 必须还在注册表里，否则报 agent-preset/not-found。会话写锁被别的进程占着时，返回 session/writer-held。子代理会话一律被拒绝。这几种情况下，投递只记一条 warn：任务保持 active，但被排除出下一次定时，不会自动重试。
③ 已归档的会话即使被投递，也会被 ArchivedSessionGate 在 agent/pre-step 拒绝，这一回合以 blocked 收口，不发模型请求。
④「带着全部历史」指会话日志完整恢复。模型实际收到的上下文仍受压缩（compaction）影响。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1571（周期任务按会话成组，一次性任务单独成组）、1576（resolveAgent）、1586-1594（createUserMessage，source kind 为 schedule；按 isRecurringScheduleRecord 三元判断，周期任务一律用 renderRecurringReminderBatchFraming）、1596-1597（followup，然后 sessions.flush）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1387-1419（固定文本 This is a scheduled message from the user，以及 [SCHEDULE REMINDER] 和 [SCHEDULE REMINDER BATCH] 两种渲染）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:125-139（单次提醒与周期提醒批次两套固定文本）
  - 证据：dsh-src/@deepseek-ai/dsh-llm/lib/index.js:59-64（createUserMessage 固定 role user）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:800-812（send/followup）、854-868（wakeDriver：空闲时开驱动器）、1037-1041（回合结束后收件箱还有消息就继续）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:210-245（resolve、冷恢复、错误映射，243 行为 session/writer-held）、392-403（resumeObserved → composeAgent(presetForObservation) → ctx.agents.resume）、542-545
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:596-601（未知 preset 抛 agent-preset/not-found）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2508-2517（ArchivedSessionGate 拒绝归档会话的步骤）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1625-1636（失败只 warn，并排除出下一次定时）
- **C3：成立**。原结论：任务落盘在 storage domain「schedule」，JSON 后端写成单文件 ~/.dsh/storages/schedule.json。Host 每次启动都 requestDrive 重扫全部 active 任务。重复任务只补最近一次错过的时点；同一会话同时到期的多个重复任务合并成一条 BATCH；一次性任务补发一次后转为 inactive。
  - 核查说明：README 和 lib 一致，全部核实。domain 名是 'schedule'，没有声明 layout，所以用 storage-json 默认的 single 布局，一个单元一个 <unit>.json。dsh-base 把 storage-json 的 root 设为 dshHomePath('storages')、backend 设为 json，因此文件就是 ~/.dsh/storages/schedule.json（本机存在，3499 字节，没读内容）。ScheduleService 在初始化 effect 里直接调用 this.runtime.requestDrive()。every、daily、weekly、cron 四种 resolve*Occurrence 都只计算「最近一次已到期时点」和下一个未来时点。

补充四点：
① 周期任务哪怕只有一条到期，也用 BATCH 格式。一次性任务从不合并：同一会话里多条一次性任务同时到期，会各发一条消息（group=[task]）。
② 投递失败的任务保持 active，scheduledAt 停在过去，但被排除出下一次定时。只有在其他任务的定时触发、任何一次 create、有实际变更的 update、delete、停止会话任务，或 Host 重启时才会重试。
③ 投递是至少一次语义：flush 之后、任务写回之前如果崩溃或关闭，会重复投递。
④ JSON 单文件，每次变更都重写整个文件，全部发送历史常驻内存。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1675-1677（defineDomain name 'schedule'，没有 layout 字段）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:182-190（storage-json root: dshHomePath('storages')；storage-domain backend: json）
  - 证据：dsh-src/@deepseek-ai/dsh-storage-json/README.zh.md:12、72（默认 single 布局，每次写入原子替换整个 <unit>.json）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2026-2029（初始化即 requestDrive）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:595-620、656-672、687、821（各类周期规则只取最近一次，not across its missed history）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1567-1571、1599-1621（成组投递；一次性任务写 inactive；周期任务推进到下一目标）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1630、1636（失败任务排除出下一次 setTimeout 计算）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:12、143、153-154、161
  - 证据：ls /Users/bytedance/.dsh/storages：schedule.json、workspace.json、session_projcache
- **C4：成立**。原结论：插件可以不经过模型，直接用 ctx.schedule 给任意根会话排班：create(sessionId,{prompt,title,选择器},signal?) 不激活会话；另有 list、catalog、history、update、delete；变更后广播 schedule/changed。官方 tool-schedule 也这样调用。浏览器 Remote 没有 create。
  - 核查说明：核实成立。ScheduleService 继承 TypertRemoteService，构造时 super(ctx,'schedule')，也就是注册成 Cordis 服务 ctx.schedule；它依赖注入 agents、sessions、storageDomain、sessionController、sessionPersistence。create 的注释原文就是 Create a reminder bound to the caller-selected Session without activating it。只有 list、catalog、history、delete、update 这 5 个方法带 @Remote 装饰器，remote-client 也只导出这 5 个，没有 create。catalog 返回 sessionId、status、lastDelivery。每次提交后都会调用 emitChanged()。官方 tool-schedule 第 497 行 inject、第 540 行 create 的调用方式与描述一致。

补充六点限制：
① create 不校验会话是否存在。
② 拒绝子代理会话时，只检查当前活着的 Agent（用的是 ctx.agents.get）。冷着的子代理会话能建任务成功，但永远投递失败，每次扫描都会重试并告警。
③ README 明写「会话绑定校验不等于调用者鉴权」：任何能拿到 ctx.schedule 或浏览器 Remote 的代码，都能凭 sessionId 改或删任意会话的任务。
④ schedule/changed 事件不带任何载荷。浏览器端用 ctx.remote.$on('schedule/changed') 订阅，收到后要自己再调用 catalog。
⑤ update 在规范化后如果没有实际变化，会直接返回，既不写入也不触发重扫。
⑥ 读者答案里引用的 dsh-web-app/cordis.patch.yml:62 行号不对：session-controller 在 121-122 行，schedule 在 139-140 行，两者在同一个 insert 块里。

用户插件能不能注入 schedule 仍未实测。不过桥插件已经注入了 sessionController、agents 等同层服务，旁证可行。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1969-1975（static inject）、1992（super(ctx,'schedule')）、2069-2112（create 注释与实现，不查会话是否存在）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1902-1906（Remote 白名单只有 list/catalog/history/delete/update）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/typert.remote-client.js:455、470、503、535、567（只导出 schedule/catalog、delete、history、list、update）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2120、2129-2136（list、catalog）、2144、2164、2197-2224（update 在 2215 行无变化即返回）、2231-2237（emitChanged 不带载荷）、2254-2259（reminderTargetRefusal 只查活 Agent）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:497、540、293-303
  - 证据：dsh-src/@deepseek-ai/dsh-typert-protocol/lib/index.js:339-351
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-schedule/lib/client.js:6302（ctx.remote.$on('schedule/changed')）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:47、157
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:44、121-122、139-140
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/index.js:46（桥 inject sessionController、workspaceRegistry、commands、agents）
- **C6：成立**。原结论：关窗口不等于退出：close 被拦截改为隐藏，Host 继续跑，定时任务照常触发；macOS 上 window-all-closed 不退出；Windows 有托盘，第一次关窗口时会提示；macOS 没有托盘，只留在 Dock。
  - 核查说明：核实成立。补充四点：
① close 拦截只在三种情况下放行：正在退出、安装器接管、系统注销（sessionEnding）。全屏时会先退出全屏再隐藏。
② macOS 上点 Dock 图标会触发 activate → focusPrimaryWindow，重新显示窗口。main.js 里没有 app.dock.hide，所以 Dock 图标一直都在。
③ Windows 的后台提示，在用户点「确认」之前每次关窗都会弹；点了确认后写入 userData/background-close-confirmed 标记，以后不再提示。
④ 关窗口这条路径不会调用 backend.close()。backend.close() 只在 finishQuit 和崩溃恢复的 stopForRecovery 里调用，所以 Host 子进程不受关窗影响。
  - 证据：dsh-src/_app/main.js:12880-12906（close → preventDefault → hideMainWindow）
  - 证据：dsh-src/_app/main.js:13060-13065（activate 重新显示窗口；window-all-closed 只在非 darwin 时 quit）
  - 证据：dsh-src/_app/main.js:12804-12825（只在 win32 创建 DesktopTray 和 DesktopBackgroundNotice）、11741-11793（DesktopBackgroundNotice 确认后写标记）
  - 证据：dsh-src/_app/main.js:7485（backgroundNoticeBody 文案）
  - 证据：dsh-src/_app/main.js:12309、13084（backend.close 只出现在崩溃恢复和 finishQuit）
  - 证据：grep dsh-src/_app/main.js：app.dock 只用于 bounce/cancelBounce（9707、9711），没有 dock.hide
- **C10：成立**。原结论：DSH 本身没有「同时活动会话数」上限，也没有空闲回收；局部上限只有 maxParallelToolCalls 10、每会话后台 job 10、每棵子代理树 maxActiveSubagents 8。「活动会话已达上限 2」是用户自写桥插件的护栏（默认 2，可调 1–4，只统计桥自己开的会话）。
  - 核查说明：核实成立。补充三点：
① 我对全部 308 个包做了全量 grep，找 max 开头、含 Active/Parallel/Concurrent/Live 的标识。找到的只有：maxActiveSubagents、maxParallelSubCalls、maxParallelToolCalls、maxConcurrentJobsPerOwner（默认 10，按「精确所有者」计）、maxConcurrentFileUploads、maxConcurrentConversions，以及 dsh-workflow-ptc 的 maxConcurrentAgents（只管单次 workflow 里的子代理，默认 min(16, CPU 核数-2)）。没有一个是全局的活会话上限。
② 也没找到空闲回收逻辑。机器人会话被唤醒、恢复成活 Agent 后，会一直驻留到 Host 重启或会话被拆除。这是静态检索的结论，内存占用没有实测，机器人多了要关注。
③ schedule 投递只等 flush，不等回合结束，所以同一时刻到期的多个机器人会并发开跑。模型请求层没有并发闸门：遇到限流时，llm-retry 的 normal 模式最多重试 5 次，之后这一回合报错。而这次唤醒已经记为已投递，不会补跑。

桥插件部分与读者描述一致：第 54 行默认值 2，第 161 行 settings 范围 1–4，第 309-312 行只统计 this.tracked 里还没结束的会话。
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:54、161、309-312；README.md:92-97（「限制」节）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:553、619、1554（maxParallelToolCalls 默认 10）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/README.zh.md:49、53；lib/index.js:2979-2980（maxDepth 1、maxActiveSubagents 8）
  - 证据：dsh-src/@deepseek-ai/dsh-jobs-local/lib/index.js:340、419（每个精确所有者最多 10 个活动 job）
  - 证据：dsh-src/@deepseek-ai/dsh-workflow-ptc/lib/index.js（maxConcurrentAgents 只作用于单次 workflow）
  - 证据：grep dsh-api-session-controller、dsh-agent、dsh-agent-loop、dsh-session 的 lib：没有 maxLive、maxActive、evict、idleTimeout、LRU 之类的回收或上限
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1596-1597（投递只等 flush）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-retry/README.zh.md:50（normal 模式最多重试五次）
- **L1：部分成立**。原结论：只有桌面 App 开着、Host 活着时机器人才能被唤醒。退出 App 时 Host 依次收到 shutdown、10 秒后 SIGTERM、再 5 秒后 SIGKILL；退出确认框写着「应用关闭期间，定时任务不会运行」；Electron 退出后 Host 因 disconnect 自行停止，不能脱离 App 常驻；schedule 也不能在 headless 或 SDK 组合里单独挂载。
  - 核查说明：桌面 App 这部分核实成立。退出路径是 before-quit → 确认 → finishQuit → backend.close()。DesktopHost.stop 先发 shutdown，等 10 秒后发 SIGTERM，再等 5 秒发 SIGKILL。desktop-host 进程在 once('disconnect') 时自行 stop。schedule 依赖 sessionController 和 sessionPersistence，而 headless、SDK 组合都不挂 session-controller。

需要更正两点：
① 退出提示是有条件的。Host 的 quit-inspection 只遍历 agents.list() 里「活着的」会话，判断上面有没有提醒。如果既没有正在运行的任务，活会话上也没有提醒，resolveDesktopQuitPrompt 返回 undefined，App 不弹框直接退出。所以刚启动、所有机器人会话都还是冷的时候按 Cmd+Q，可能根本看不到「定时任务不会运行」的警告。系统关机或注销时也会跳过确认。
② 「只有桌面 App 开着才能唤醒、不能脱离 App 常驻」说得太绝对。官方 dsh 命令行还有两条不经过 Electron 的路：
- dsh web：启动 web profile（dsh-base 加 dsh-web-app），同样挂载 schedule 和 session-controller，没有按 desktop 名字禁用；sessions 和 storages 也都在同一个 ~/.dsh 下。理论上它可以作为常驻进程，投递同一份 schedule.json 里的提醒。
- headless：由系统定时器（launchd 或 cron）调用 dsh --profile headless --session-id <会话id> 加任务文本，在原会话里续跑。
这两条路的约束：
- 要先安装 dsh 命令（桌面菜单「管理 dsh 命令…」）。本机 ~/.dsh/profiles 下已有 web、headless 目录，drive-dsh 技能也记录过 headless 的用法。
- headless 默认不使用 GUI 里保存的凭据，并且拒绝运行在本 profile 没有组合的 preset 下的会话。
- 桌面端和 dsh web 不能同时运行；同一个会话同一时刻只能有一个写入进程。
- 两条路都没有实测，而且电脑仍须开机、不休眠。

结论应改为：机器人能主动干活的时间上限，是「这台 Mac 醒着，并且有一个 DSH Host 进程在线」的时间。这个进程可以是桌面 App、dsh web，或被外部定时器拉起的 headless。
  - 证据：dsh-src/_app/main.js:7483-7484（quitScheduledTasks 文案）、11625-11630（resolveDesktopQuitPrompt：无任务且无提醒时返回 undefined）、11665-11689（decide：prompt 为 undefined 时直接放行退出）
  - 证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:160-182（quit-inspection 只遍历 agents.list() 的活会话）、226-245（runProfile，profile desktop，参数 --host 127.0.0.1 --port 0）、325-327（disconnect → stop）
  - 证据：dsh-src/_app/main.js:13066-13068、13094-13125（系统关机或注销跳过确认）、13069-13092（finishQuit → backend.close()）、3910-3924（shutdown → 10s → SIGTERM → 5s → SIGKILL）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1969-1975；README.zh.md:26、153
  - 证据：dsh-src/@deepseek-ai/dsh/README.zh.md:11-20（dsh web、dsh --profile headless）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:551-557（web profile = dsh-base + dsh-web-app）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:121-122、135-140（session-controller、schedule 没有按 desktop 禁用）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:138-141、182-190（sessions、storages 都在 DSH home 下）
  - 证据：dsh-src/@deepseek-ai/dsh-headless/README.zh.md:12、47、55-70、74
  - 证据：dsh-src/_app/main.js:7441-7450（管理 dsh 命令）、7498（不能与 dsh web 同时运行）
  - 证据：dsh-src/@deepseek-ai/dsh-session-persistence-jsonl/README.zh.md:168（每个会话只允许一个写入方，跨进程 flock）
  - 证据：ls /Users/bytedance/.dsh/profiles：desktop、headless、web；/Users/bytedance/.claude/skills/drive-dsh/references/gotchas.md:13-14
- **L2：部分成立**。原结论：没有开机自启、没有防休眠、醒来后不会主动重新排程；powerMonitor 只在 resume 时检查更新、在 shutdown 时跳过确认；schedule 只靠一个 unref 的 setTimeout，醒后可能晚触发（未实测）；休眠时正在进行的模型请求也会断。
  - 核查说明：代码事实全部核实：
- main.js 里 powerSaveBlocker、setLoginItemSettings、openAtLogin、LoginItem 出现次数都是 0。
- powerMonitor 只有两处用法：resume 时调用 automaticCheck（检查更新和更新策略）；非 Windows 平台 shutdown 时设 sessionEnding=true。
- 全部 308 个包里也没有任何休眠、唤醒或 powerMonitor 处理。
- schedule 每次 drive 结束，只为「最近的那个 active 任务」设一个 setTimeout(Math.min(next-Date.now(), 2^31-1)).unref()。
- 其他触发重扫（requestDrive）的地方只有：初始化、create、有实际变更的 update、delete、停止会话任务。

需要修正和补充三点：
① 「休眠时正在进行的模型请求也会断」在代码里没有依据。dsh-base 默认挂载 llm-retry，normal 模式对 TRANSPORT、TIMEOUT、RATE_LIMIT 等错误最多重试 5 次，醒来后多半能续上（未实测）。
② 醒后延迟有上界。定时器触发时会用 Date.now() 重扫，一次补发所有已过期的任务。所以如果 macOS 上 Node 的定时器确实不计休眠时间，醒后的额外延迟最多等于入睡时「最近那个任务」还剩的等待时长。（libuv 在 macOS 上一般用 mach_absolute_time，休眠时不走。这是背景知识，本机这个版本没有验证。）举例：凌晨 1 点时最近的任务是早上 9 点，还剩 8 小时；电脑睡到 8:30，醒来后还要再醒着 7.5 小时，大约 16 点才触发。给 Agent 中心加一个 every_seconds 60～300 秒的心跳任务，就能把醒后延迟压到几分钟；另外任意一次 schedule 写入也会立即重扫。
③ 开机自启和防休眠只能靠 App 之外的手段，比如登录项、caffeinate/pmset，或用 launchd 拉起 dsh web。这一点结论不变。
  - 证据：grep dsh-src/_app/main.js：powerSaveBlocker、setLoginItemSettings、openAtLogin、LoginItem 均为 0；powerMonitor 只出现在第 5、12705、12708、13066 行
  - 证据：dsh-src/_app/main.js:12697-12705（resume → automaticCheck，只做更新和策略检查）、13066-13068（shutdown → sessionEnding）
  - 证据：grep 全部 308 个包：没有 powerMonitor、powerSaveBlocker、caffeinate、pmset、sleep/wake 处理
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1495（MAX_TIMER_DELAY_MS）、1636-1645（只为最近任务设一个 unref 的定时器）；其他 requestDrive 触发点在 2028、2111、2176、2221、2288、1643
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:63（定时器重新读取实际时间）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:99-100（默认挂载 llm-retry）；dsh-src/@deepseek-ai/dsh-llm-retry/README.zh.md:50
- **L3：成立**。原结论：崩溃后不能自动恢复：Host 异常退出后不重试，弹出阻塞对话框（退出 / 重启 / 禁用第三方插件并重启），必须有人点；Host 装了 installFailLoud，未捕获异常和未处理的 rejection 都会 exit 1；插件在定时器或事件回调里抛错会带崩整个 Host。
  - 核查说明：核实成立。完整链路：Host 子进程 close → DesktopHost.fail → DesktopBackendController.failed 只把状态改成 error，不重启 → reportFatal(…,'host') → DesktopFatalRecovery.report 弹出原生对话框。按钮是退出 / 重启 / 禁用第三方插件并重启，端口被占用时只有前两个；对话框没有超时，也不会自动选择。其中「重启」是用 app.relaunch 把整个 App 重开。desktop-host 经 runProfile 启动，runProfile 安装了 installFailLoud：任何 uncaughtException 或 unhandledRejection 都会写一行诊断，然后 exit(1)。唯一例外是启动审计已经收录的激活 rejection。

补充两点：
① 「事件回调」要分情况看。
- 定时器：cordis-plugin-timer 的 ctx.timeout 和 ctx.interval 直接把 callback 交给 setTimeout/setInterval，不包 try/catch，抛错必然致命。
- Cordis 的 emit：同步调用各监听器，也不捕获错误。同步抛出的错误会传回发起 emit 的代码，是否致命取决于对方有没有 catch，比如 schedule 的 emitChanged 就 catch 了。async 监听器返回的 rejection 没人 await，一定会变成 unhandledRejection，让整个 Host 退出。
② 恢复对话框里的「禁用第三方插件并重启」会禁用桌面 profile 里的全部插件，自写的 Agent 中心插件也会一起被关掉。

结论成立：一个插件 bug 就能让全部机器人停到有人回来点按钮；自写插件的所有回调都要 try/catch，并且需要外部看门狗。
  - 证据：dsh-src/_app/main.js:3842-3848（Host close → fail）、7213-7222（failed 只更新 error 状态）、12251（error → reportFatal）、11869-11878
  - 证据：dsh-src/_app/main.js:8325-8380（DesktopFatalRecovery 对话框）、11827-11848（restart 即 app.relaunch；disablePlugins 禁用桌面 profile 全部插件）
  - 证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:226（经 runProfile 启动）；dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:286-288（安装 installFailLoud）
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4216-4253（installFailLoud）；README.zh.md:109-110（失败矩阵）
  - 证据：dsh-src/@deepseek-ai/cordis-plugin-timer/lib/index.js:28-34、51-53（回调不包 try/catch）
  - 证据：dsh-src/@deepseek-ai/cordis/lib/index.js:280-282（emit 不捕获监听器错误）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2231-2237（emitChanged 自己 catch 了）

## 核查员补充（读者漏掉的点）

- 投递失败不会自动重试，机器人可能静默停摆。以下几种情况下 resolveAgent 失败，只记一条 warn：会话的 preset 被删除或改名（agent-preset/not-found）；会话写锁被别的进程占着（session/writer-held，例如 headless 或 dsh web 正持有这个会话）；会话根本不存在（create 不校验）；冷的子代理会话。失败后任务保持 active，时间停在过去，但被排除出下一次定时。只有在别的任务定时触发、任何一次 create、有实际变更的 update、delete，或 Host 重启时才会再试。公开接口里没有「立即重扫」方法。Agent 中心应定期用 catalog() 找出「仍 active 但 scheduledAt 已过去很久」的任务并告警。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1625-1636（catch 只 warn，failed 集合被排除出下一次 setTimeout）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:153
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:596-601
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:236-245（session/not-found、子代理、session/writer-held、gateway/internal）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2083-2112、2254-2259（create 不校验会话；子代理只查活 Agent）
  - 证据：requestDrive 调用点：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2028、2111、2176、2221、2288、1643
- 投递回执不等于干完活。lastDelivery 和 deliveryHistory 只证明消息进了收件箱，README 原文写着回执「不表示模型执行」。flush 成功后，一次性任务立即写成 inactive，周期任务立即推进到下一次。如果这一轮模型调用失败（比如 5 小时额度用光，或限流重试 5 次后放弃），这次唤醒已经被消耗，不会补跑；schedule 也不提供「执行状态」。Agent 中心要自己监听回合结果，自己做失败后的重排。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:65、157（不支持执行状态）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1596-1621（flush 后立即提交 inactive 或下一目标）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-retry/README.zh.md:50
- 启动补发和同刻到期会形成调用风暴。Host 一启动就 requestDrive，把停机期间所有过期任务逐个会话恢复并 followup。投递只等 flush、不等回合结束，所以 N 个机器人会几乎同时开跑、同时请求模型，正好撞上每 5 小时的额度上限。DSH 不提供错峰或排队，需要 Agent 中心自己做：比如给不同机器人的 cron 错开分钟位，或者自建并发闸门。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2026-2029（初始化即 requestDrive）、1567-1597（逐组 resolveAgent → followup → flush，不等回合）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:806-808、854-868（followup 立即唤醒驱动器）
- 没有暂停功能，归档也不能拿来当暂停。schedule 明确不支持暂停。会话上还有活动提醒时，归档会被拒绝；如果选择停止提醒，会删掉全部活动提醒，取消归档后也不会恢复。归档会话即使被唤醒，也会被 ArchivedSessionGate 以 blocked 拒绝。R7 要的「一键暂停」得自己实现：比如把规则存在 Agent 中心自己的存储里，暂停时删任务，恢复时重建。代价是发送历史会丢失。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:49、77、157
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2273-2300（stopSessionTasks 直接删行）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2494-2517（ArchivedSessionGate）
- 机器人的形态有三条硬约束。第一，必须是根会话：子代理会话收不到提醒，被委派的子代理也不能用提醒工具。第二，四个提醒工具和时钟插件只在 standard、cordis、ptc 三个 preset 里；自建的机器人 preset 要显式带上 dsh-tool-schedule（以及 dsh-time-context），机器人才能自己给自己定闹钟。第三，冷恢复按会话记录的 preset 重建，preset 一旦改名或删除，绑定它的所有机器人都醒不来。headless 续跑也要求会话的 preset 在 headless profile 里存在。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:158
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:293-303（被委派调用方一律拒绝）
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:135-138（提醒工具和时钟属于 standard、cordis、ptc preset）
  - 证据：dsh-src/@deepseek-ai/dsh-time-context/README.zh.md:28
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:596-601
  - 证据：dsh-src/@deepseek-ai/dsh-headless/README.zh.md:74
- 定时唤醒的回合拿不到浏览器时区。时钟插件只从带 rpcId 的普通用户消息里读 clientTimeZone，而 schedule 投递的消息不带这个字段。于是模型看到的时钟读数写着 Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times。无人值守的机器人可能会为日期时间去问用户，而不是直接干活。机器人指令和提醒 prompt 里要写死时区。
  - 证据：dsh-src/@deepseek-ai/dsh-time-context/lib/index.js:9-13（只认带 rpcId 的用户消息）、30-43、55（missing 时的提示原文）
  - 证据：dsh-src/@deepseek-ai/dsh-time-context/README.zh.md:12、138
- 现成的自我推进抓手。模型可以用 schedule_update 修改自己会话里提醒的 title、prompt 和时间（after 类型除外），id 和发送历史都保留。所以机器人每次醒来，可以把「下一步做什么」写回自己的提醒 prompt，并按进度调整下次醒来的时间，这可以支撑 R3。另外，提醒消息固定声明来自用户（This is a scheduled message from the user），prompt 会被模型当作用户指令执行。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:28、53、157
  - 证据：dsh-src/@deepseek-ai/dsh-tool-schedule/lib/index.js:604（schedule_update）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1387
- 没有调用者鉴权。README 明说会话绑定校验不等于调用者鉴权：任何能拿到 ctx.schedule 的 Host 插件，或浏览器 Remote，都能凭 sessionId 修改或删除任意机器人的任务。R7 的权限边界要由 Agent 中心自己做。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:157
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1902-1906、2164-2224
- schedule.json 是单点故障。它是 JSON 单文件，只要有一条记录非法（比如缺 title、时区非法），整个 schedule domain 都会拒绝打开。schedule 不在 required 列表里，按 app-boot 的失败矩阵只会告警，Host 照常启动，结果是所有机器人都不再被唤醒（推断，未实测）。另外每次变更都重写整个文件，全部发送历史常驻内存；默认每个任务保留 30 天、200 条，机器人和任务多了以后写放大明显。
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:73、75、161
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/README.zh.md:98-113（optional 条目失败只告警并继续；required 只有 modules 和 connection）
- 中断的工作不会自动续跑。退出、崩溃或升级时正在跑的回合，下次恢复会话时只会补一个中断收尾（interruptedTurnClosers），不会重跑；关停时最后的 turn/end 甚至可能只在内存里、没有落盘。Host 启动时也不会主动恢复任何会话，机器人要等到自己的下一个提醒才会接着干。所以长任务要设计成「每次醒来先读进度、可以断点续做」。
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md:116、216
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:154
- 有绕开桌面 App 常驻的官方入口（读者漏掉了）。dsh web 用的是同一套 schedule 加 session-controller、同一个 ~/.dsh，可以用 launchd 托管，实现开机自启和崩溃后自动拉起。dsh --profile headless --session-id 可以由外部定时器调用，在原会话里唤醒机器人。限制：凭据、preset 要一致，不能和桌面端同时运行，电脑仍须醒着；这两条路都没有实测。
  - 证据：dsh-src/@deepseek-ai/dsh/README.zh.md:11-20
  - 证据：dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:551-557
  - 证据：dsh-src/@deepseek-ai/dsh-headless/README.zh.md:12、47、55-70、74
  - 证据：dsh-src/_app/main.js:7441-7450、7498
  - 证据：/Users/bytedance/.claude/skills/drive-dsh/references/gotchas.md:13-14

## 缺口与补法

- [R2｜工作量 M] 没有现成的文件变化、webhook、飞书或邮件消息触发器
  - 补法：自写 Host 插件：文件用 ctx.fs.watch；外部消息用 ctx.interval 轮询外部 API，或在插件里维护长连接；本机 webhook 用 ctx.webServer.register 并自己做 token 校验。触发后用 sessionController.resolveAgent + agent.followup（自定义 source），或 sessionController.prompt 唤醒对应机器人。回调必须全部 try/catch。
- [R1/R2｜工作量 M] 后台批量排班没有现成入口：浏览器 Remote 没有 create，UI 的「新建」只是开一个新会话
  - 补法：自写 Host 插件包一层 ctx.schedule.create，并按 TypertRemoteService 的方式暴露自己的 Remote 服务给 Agent 中心页面；先用 sessionController.create 建好机器人会话，再排班。
- [R2/R3｜工作量 S] 唤醒默认只跑一轮：冷恢复后 goal 续行被关掉，schedule 消息又不算人类输入
  - 补法：插件监听 schedule 投递（会话事件里 source.kind 为 schedule 的 user/message），然后执行 /goal resume 或调用 ctx.goals.resume；或者把机器人设计成每次醒来只干一轮，干完再用 schedule_create 给自己排下一次。
- [R9｜工作量 S] 没有开机自启
  - 补法：用户在 macOS 系统设置 → 通用 → 登录项里加入 DeepSeek Harness（系统设置，由用户自己操作）。
- [R9｜工作量 S] 插电不合盖时会自动睡眠
  - 补法：外部工具：系统设置里打开「接电源时防止自动睡眠」，或者用 caffeinate、Amphetamine 这类工具保持唤醒（属于修改系统设置，需用户确认）。
- [R9｜工作量 blocked] 笔记本合盖或断电时机器人照常运行
  - 补法：做不到，硬件限制；只能换一台常开的机器（比如 Mac mini）来跑 DSH。
- [R9｜工作量 S] 电脑醒来后可能延迟投递，因为没有代码在系统唤醒时重新排程
  - 补法：先实测确认是否真的会延迟。如果会，自写插件每 60 秒用 ctx.interval 读一次 ctx.schedule.catalog()，发现 active 任务已经过点但 lastDelivery 没更新，就做一次无害的管理写入（比如建一个远期的哑任务再删掉，create 和 delete 都会触发 requestDrive），让 schedule 重新计算并补投；不要自己再投一遍，以免重复。
- [R9｜工作量 M] 崩溃后要人工点对话框才能恢复
  - 补法：外部看门狗：一个 launchd LaunchAgent 定时检查 Agent 中心插件写出的心跳文件（参考桥的 bridge-status.json），心跳过期就结束 DSH 进程并重新打开 App。Agent 中心插件本身不能抛出未捕获异常。
- [R9｜工作量 S] 投递只保证至少一次，失败后没有自动重试
  - 补法：机器人任务设计成重复执行无害（每次唤醒先读自己的状态文件、做过的就跳过）；Agent 中心按 catalog 的 scheduledAt 和 lastDelivery 巡检漏投并告警。
- [R9/R7｜工作量 M] 没有全局并发闸门，N 个机器人同时醒来会同时调用模型，容易撞上每 5 小时的订阅额度和限流
  - 补法：排班时错开时间；自写插件用 agent/pre-step 实现「同时最多 K 个机器人在跑」，超出的拒绝或延后（比如用 update 推迟它的下次时间）；对 job 唤醒设置 maxConsecutiveWakes。
- [R7/R2｜工作量 S] 不能暂停单个机器人的闹钟（schedule 不支持暂停）
  - 补法：插件把规则另外存一份后删除任务，恢复时再重建；或者用 agent/pre-step 拦截被暂停机器人的轮次（闹钟照响，但不调用模型）。

## 可调用的宿主接口

- `ctx.schedule.create(sessionId, {prompt, title, after_seconds|at|every_seconds|daily|weekly|cron}, signal?)`：Agent 中心后台批量给机器人排班，不需要模型参与，也不激活会话。插件声明 inject ['schedule'] 或用 ctx.inject(['schedule'], …)。目标必须是已经落盘的根会话：create 不校验会话是否存在，会话不存在时投递会报 session/not-found，任务卡在逾期状态。
- `ctx.schedule.catalog() / list({sessionId}) / history({sessionId,id,limit,before?}) / update({sessionId,id,expected,…}) / delete({sessionId,id}) + 事件 schedule/changed`：Agent 中心面板展示每个机器人的下次唤醒时间、最近一次投递、发送记录，以及改期或删除排班。浏览器端可以直接调 Remote namespace schedule 下除 create 以外的方法。
- `ctx.sessionController.create / prompt / cancel / rename / resolveAgent`：批量新建机器人会话（可指定 agentPreset），用 prompt 往会话里发指令来唤醒，用 resolveAgent 拿到 Agent 句柄（冷会话会被恢复）。用户的桥插件在 0.2.1-rc.2 之后改成直连这个服务。
- `Agent.followup(msg) / steer(msg) / inject(msg)`：事件触发时把消息塞进机器人会话：followup 排到下一轮并唤醒，steer 进入下一步并唤醒，inject 只附加上下文、不唤醒。要传自定义 source；不传的话会被当成 user，带上人类权限。
- `ctx.timeout / ctx.interval（cordis-plugin-timer）`：自建轮询：比如每分钟比对一次真实时间和 catalog，防止电脑醒来后漏投；或者定时拉取飞书、邮件等外部事件。插件卸载时会自动清理，但回调里必须 try/catch。
- `ctx.fs.watch(target, changed, signal)`：文件或目录（只看第一层子项）一有变化就触发，唤醒负责的机器人。
- `ctx.webServer.register({exact|prefix 路由})`：在 Host 上开一个本机 HTTP 入口，给本地脚本或外部隧道当 webhook 用。要自己做鉴权，端口每次启动都会变。
- `ctx.on('agent/pre-step', (payload, next) => …) 返回 {kind:'reject'}`：拦住被暂停、超预算或超并发的机器人的唤醒轮次：这一轮会以 blocked 收口，不发模型请求。官方的归档门禁就是这么做的。
- `ctx.goals.resume(agent, ref) / ctx.commands.execute(agent, '/goal resume', [], signal)`：schedule 唤醒或冷恢复之后，替机器人重新打开 goal 续行，让它连续推进多轮。
- `ctx.jobs + dsh-tool-jobs 配置（completionDelivery、maxConsecutiveWakes）`：让机器人在一次唤醒里后台跑长命令，跑完自动再唤醒。用 maxConsecutiveWakes 限制自己触发自己的循环，防止把额度打光。
- `workspace/session-activity / workspace/session-stop 事件`：归档会话时，schedule 会把这个会话的全部活动提醒删掉；Agent 中心可以用归档来做「退役机器人」，也可以监听这两个事件做自己的清理。

## 读者留下的未决问题

- macOS 上电脑睡着再醒来后，schedule 的 setTimeout 是立刻触发，还是会晚一段相当于睡眠时长的时间？建议实测：建一个 10 分钟后的 after 任务，合盖 30 分钟后打开，看实际投递时间。
- dsh-desktop-host 的 quit-inspection 注释说「本次运行没加载过的会话里的提醒不会触发」，但 schedule 运行时的代码会冷恢复任意会话，两者矛盾。需要实测：重启 App 后不打开某个会话，看它的提醒能否按时触发。
- 被 schedule 冷恢复的会话 Agent 会不会被释放？代码里没找到空闲回收逻辑。几十个机器人在一次运行里都被唤醒后，内存占用是多少？
- 窗口隐藏后，macOS 的 App Nap 会不会拖慢 Host 子进程的定时器？这只影响秒级精度，不影响分钟级排班，需要实测。
- 用户订阅额度（每 5 小时上限）走的是登录凭据还是 API Key？headless 模式默认禁用托管凭据和 DeepSeek 账号，这决定了外部 headless 唤醒能不能作为备选方案。
- 桌面 profile 的实际组合文件（profiles/desktop 的 package.json 和 cordis.patch.yml）按禁区没读，不确定用户有没有改过 schedule、tool-jobs（比如 maxConsecutiveWakes）或 jobs 的默认配置。
- ctx.schedule.create 等宿主方法的签名在以后的版本会不会变？官方没有稳定性承诺，而用户桥在 0.2.1-rc.2 时已经因为 typertGateway.invoke 改动失效过一次。
- 用户插件能不能直接 inject 到 schedule 服务（会不会被 preset 隔离挡住）？从组合层级看应该可以，但没有实测。
