# 底稿：安全管控、模型与用量、对外触达（R5、R7）

> 研究底稿（2026-11-04，DSH 桌面版 0.2.1-rc.5）。先由一位读者细读官方插件说明与源码，再由另一位核查员逐条尝试推翻承重结论；「核查」一节里的修正优先于「读者结论」。证据路径中的 `dsh-src/` 指从安装包只读解出的官方插件源码，可用 `tools/asar_extract.py` 重新解出。

## 读者总结

这一路的结论是：零件基本齐全，但「管控面」要自己搭。现成能做到的有：每个机器人（会话）单独设权限档（只读、工作区可写、完全访问，还能在配置里自定义「工作区可写＋越界自动拒绝」这种无人值守档）；单独选模型（pi-ai 带 42 家供应商目录）；按会话查看 token 用量；审批、权限变化和工具调用都记在会话日志里；对外可以用 MCP 接飞书等服务，也自带网页搜索和抓取。做不到的有：审批没有超时和规则，「需要时询问」档的机器人半夜一旦要越界就会一直挂着；沙箱只管写文件，联网、读文件、MCP 和网页抓取既不受限也不走审批；没有预算、金额、全局暂停和全局并发上限；也没有系统通知或 IM 推送。好在拦截工具调用、拦截每一步、改模型路由、自定义审批应答者、读会话用量这些插件接口都是现成的。除了「网络和读取隔离」在 macOS 上基本补不了，其余缺口都能用一两个自写插件补上。

## 逐题回答

**问题 1**

会卡住，而且没有超时。分三种情况。① 会话是 read-only 或 workspace-write（这两档默认都是 approval: ask）。机器人越界时（写工作区外、要更宽的沙箱、非完全权限下调用 plugin_manager，或某插件在 pre-execute 返回 ask），请求会进入按 agent 作用域分发的 approval/request 瀑布事件，桌面审批面板接管该会话的输入框，一直等人点「允许一次」或「拒绝」。代码里没有计时器，只有回合被取消才会结束。bash 和文件工具本身也没有工具级超时，只有 PTC 的 run_code 默认 120 秒上限会把审批等待算进去。macOS 上关窗只是隐藏窗口，面板仍在线等待（据 main.js 推断，需实测）。在此期间该回合不结束，同会话后续的唤醒只能排队（推断）。侧边栏会把这个会话标成「等待审批」，但不会弹系统通知，也没有 Dock 角标。② 没有任何应答者在线（如 headless 档、客户端断开）：结果是 unavailable，按拒绝处理，工具报错，模型继续往下走。③ approval: never：在分发前直接拒绝，并告诉模型不要申请提权。danger-full-access 档就是 never，但这一档本身几乎不需要审批，等于完全不设防。

能否预设规则：内置只有「全拒」（never），没有「总是允许」、白名单或记忆规则；审批请求只带工具名、理由和 callId，不带参数。可行做法有三种。(a) 改配置，在 permission.presets 里加 workspace-write + never：沙箱内照常干活，越界自动拒绝，这是最适合无人值守的档。(b) 自写挂在机器人 agent 作用域上的 approval/request 应答者插件，按规则自动批准或拒绝、设超时、转飞书审批。(c) 用 tools/pre-execute 按工具名和参数直接放行或拒绝。委派出去的子代理自动是 never。实验性的 Auto review 被拒后仍会转人工，夜里照样会卡。另外 ask_user_question 默认也会无限等，需要在 preset 里配 mode: timed；plan 模式要等人批准计划。

能否按机器人分别设权限档：可以，权限档是会话级的。用 /permission <名> 命令或 ctx.permissionPresets.set(session, name) 切换（你装的 dsh-taskboard 就是这样做的），切换会写进会话日志、重启后保留；新会话用默认档（workspace-write）。写入边界就是该会话的 cwd，所以「一个机器人一个目录」就能隔离写入。但三档都不限制联网和读文件，也不管 MCP 和 web_fetch。顺带更正一点：drive-dsh 技能里说「联网会弹批准」，这与代码不符。macOS 沙箱规则是 (allow default)+(deny file-write*)，联网本身不会触发审批；之前见到的批准请求，多半是 npm 之类的工具往工作区外写缓存被拦后申请提权（推断）。

**问题 2**

能按会话统计，不能设预算，也没有全局一键暂停。

统计：token-meter 给每个会话注册 tokenUsage（uncachedInputTokens、outputTokens、cacheReadTokens、cacheWriteTokens，按整份持久日志累计，同一步的重试另算），还有 contextPressure 和 contextBreakdown；session-stats 给出 sessionStats（turns、steps、llmMs、toolMs、首 token 和解码耗时）。远程方法 session.projections({sessionId}) 连冷会话都能读，不用唤醒机器人。所以「按机器人」看用量，就是把它名下的会话（含子代理的子会话）加总。盲区有三个：只算主循环的 assistant 消息；DeepSeek 网页搜索那一整轮模型调用、Auto review、会话标题生成等辅助调用都不计入；没有金额（代码注释明说 harness 不读价格，也没有任何地方报告花费），只有 DeepSeek 账号能查钱包余额。

预算和自动停：没有。agent loop 没有轮次预算；goal 只有 Round 上限（默认 256 轮，按轮不按 token）；llm-retry 的 normal 模式每次失败最多再打 5 次请求，always 模式会无限重试。要预算就得自写插件：读 tokenUsage，超限时在 agent/pre-step 返回 reject，同时调 goals.block('budget-exhausted') 并发通知。

一键暂停：没有全局的，现成的只有按会话操作。session.cancel 停当前回合；archiveSession(id,{stopActivity:true}) 停回合、后台任务、子代理并删除提醒，之后的唤醒会被 agent/pre-step 门禁拦成 blocked。定时提醒本身不支持暂停。退出 App 时会弹「有运行中或定时任务」的确认，这是唯一的全局急停。自写一个全局暂停插件很简单：全局 agent/pre-step 监听在暂停开关打开时返回 reject（与官方归档门禁同一机制），再加 tools.guard 兜底。

**问题 3**

pi-ai（@earendil-works/pi-ai ^1.1.0）安装包里带 42 个供应商目录：amazon-bedrock、ant-ling、anthropic、azure、baseten、cerebras、cloudflare-ai-gateway、cloudflare-workers-ai、deepseek、fireworks、github-copilot、google、google-vertex、groq、huggingface、kimi-coding、meta、minimax、minimax-cn、mistral、moonshotai、moonshotai-cn、nvidia、openai、openai-codex、opencode、opencode-go、openrouter、qwen-token-plan、qwen-token-plan-cn、qwen-token-plan-individual、radius、together、typesafe、vercel-ai-gateway、xai、xiaomi、xiaomi-token-plan-ams、xiaomi-token-plan-cn、xiaomi-token-plan-sgp、zai、zai-coding-cn。GLM 走 zai、zai-coding-cn 或自定义网关。此外还能手写任意 openai-completions、openai-responses、anthropic-messages 兼容网关（填 api、baseURL、models）；支持 OAuth 或交互式登录的供应商走授权流程。这个适配器默认处于休眠状态，在设置的 Models 页加路由后立即生效，不用重启。DeepSeek 另有 deepseek-official（API Key）和 deepseek-account（账号）两条原生路由。

按会话或机器人选模型：可以。session.selectModel 只改这个会话的下一次请求（代码已确认），但会在后台顺手存成全局默认，所以批量给机器人设模型会改掉你新开会话的默认模型。ctx.agents.create({agentOptions:{provider,model}}) 可以按 agent 直接指定；agent/request 瀑布事件可以逐个请求替换 provider/model（例如例行巡检用便宜模型、超预算自动降级）。权限档与模型无关；agent preset 是插件列表，README 里没看到模型字段（不确定）。每个 provider profile 可以单独配 retryPolicy。

**问题 4**

MCP 能接。dsh-mcp-client 每台服务器一条配置，走 stdio（本地命令，如 npx 某 MCP 包）或 Streamable HTTP（URL + headers）；工具名是 mcp__<server>__<tool>，单次调用默认 60 秒超时，断线后指数退避重连，连续 10 次失败就移除工具。配置行可以放在主机层（所有机器人共享），也可以放进某个 agent preset 的插件列表（只给这一类机器人，各用各的 token）。限制：没有 GUI 配置页（官方模板就是写 cordis.patch.yml）；没有 OAuth，不走凭据库，密钥只能写在 env 或 headers 里；不支持 MCP prompts 模板、资源订阅和 task-based 工具；MCP 工具调用默认不走审批，MCP 服务器进程不在沙箱里；服务器的 instructions 会原样进系统提示词。飞书、邮件、日历需要找对应的 MCP server（飞书有官方 OpenAPI MCP，兼容性需实测），或者在 bash 里调 lark-cli、curl（沙箱不拦网络）。

主动通知用户：现成的只在应用内。侧边栏会把「等待审批、提问、计划审阅」的会话标黄；任务完成有本地「未读」标记；present 工具能把文件挂成交付物；再就是会话里的消息本身。没有系统通知（主进程的 Notification 和 Dock 跳动只给强制更新用）、没有 Dock 角标，托盘只有打开和退出，网页前端不用 Notification API，也没有 IM 或邮件推送，这些都要自建。最省事的是给机器人一个「发飞书」工具（飞书 MCP，或 bash 调 lark-cli、curl 飞书机器人 webhook；web_fetch 只能 GET，发不了消息），工作量小。更可靠的是写宿主插件，监听 approval/asked、回合结束、goal blocked 等事件统一推送，不依赖模型记得汇报，工作量中等。系统通知可以写客户端插件调用渲染进程的 Web Notification（推断可行，未验证）。

**问题 5**

能用于自主调研，但有凭据和成本门槛，也没有总额度控制。standard agent preset 默认带 web_search 和 web_fetch，任何权限档都能用，也不走审批。

搜索后端只有 DeepSeek。默认是 deepseek-official 的 Messages 搜索，每次搜索等于一次完整的模型调用（默认 deepseek-v4-flash、maxTokens 4096、最多 maxUses=5 次服务端搜索），需要 DEEPSEEK_API_KEY 或已登录的 DeepSeek 账号，否则报 WEB_PROVIDER_CREDENTIAL_MISSING。也可以在「网页搜索」设置里切到 DeepSeek Search/Fetch API（单次直连，不耗模型 token，但另计费）。如果只订阅了 GLM，搜索可能用不了，需要确认。

抓取：匿名，只允许公网地址，只解析文本（PDF 和二进制不行），单次最多 20 万字符，只能 GET，超时 30 秒。

额度：只有单次调用级的上限（searchMaxQueries=4、searchMaxResults=8、搜索超时 60 秒），没有按会话、按天或全局的次数和费用上限；搜索那一轮的 token 也不进会话用量统计；供应商侧的计费和限流另算。替代方案是接第三方搜索 MCP（例如智谱的 web-search MCP，需实测）。

**问题 6**

按可能性和后果排序：
1. 半夜卡审批：ask 档的机器人一越界就无限等待，回合不结束，后续唤醒排队；没有系统通知，用户不打开窗口就不知道。
2. 完全权限放飞：danger-full-access 等于 never，几乎没有闸门。机器人可以删改工作区外的文件、改 ~/.dsh 配置、读凭据文件；在 Creator（cordis）preset 下装插件也不用审批；子代理会继承父会话的沙箱。插件或桥用 /permission 命令切到完全权限不会弹风险确认，「让一个 Agent 批量生成机器人」时必须夹紧档位。
3. 数据外泄和提示注入：所有档位都能读全盘、能联网（bash curl、web_fetch 带查询串、MCP）。网页、邮件、MCP 返回内容里藏的注入指令，可以让机器人把本机文件或凭据发出去；MCP 服务器的 instructions 还会直接进系统提示词。
4. 对外写操作没有闸门：接了飞书或邮件 MCP 后，机器人可以随意发消息、发邮件，默认不审批，需要自建 tools/pre-execute 白名单。
5. 凭据共享：全局只有一份凭据库，所有机器人用同一把 API key、同一个外部身份，无法按机器人限额或追责；secret-mask 只遮界面，不遮模型。
6. 额度被打爆：没有预算，也不会自动停；goal 默认 256 轮自动续行；没有轮次预算；normal 重试每次失败再打 5 次请求，always 模式无限重试（连 QUOTA 也重试）；Auto review 每次工具调用多一次模型请求；DeepSeek 搜索每次是一整轮调用；子代理和工作流还会按 CPU 数并发展开。所有机器人共享 GLM 的 5 小时额度，一个失控的机器人会饿死其他机器人，也会挤占你自己的交互使用。
7. 并发争用：平台层没有全局并发上限，整点同时醒来会集中撞上供应商的 429，重试又放大请求量；每个机器人还能各开 10 个后台任务。
8. 计量盲区：tokenUsage 不含辅助调用，子代理的用量在各自的子会话里，也没有金额，所以面板会低估真实消耗。
9. 没有全局止血：只能逐个会话 cancel 或归档（归档会删提醒）；定时提醒不能暂停；退出 App 是唯一的全局急停。
10. 小坑：selectModel 会改全局默认模型；ask_user_question 默认无限等；/tmp 等临时区所有机器人都能写；QUOTA 判定靠英文措辞，GLM 的中文额度报错可能被当成限流先重试 5 次。

## 能力清单（* 为承重结论）

- **C1***（依据：both；对应 R7, R1）权限档（permission preset）按会话、也就是按机器人独立设置。桌面版默认三档：read-only 和 workspace-write（都配 approval: ask），以及 danger-full-access（approval: never）。可以用 `/permission <名>` 命令或 `ctx.permissionPresets.set(session, name)` 逐个会话切换，切换会写进会话日志，重启后保留。presets 表可以在配置里自定义组合（如 workspace-write + never）。workspace-write 的可写边界就是该会话的 cwd，所以「一个机器人一个目录」就能隔离写入。
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:243-276（sandbox-policy 的 mode 默认 workspace-write；approval 由 DSH_PERMISSION_MODE 推导；permission presets 三档）
  - 证据：dsh-src/@deepseek-ai/dsh-permission-presets/lib/index.js:138-158（Config.presets = z.dict({sandbox, approval})，可自定义）、:207-209（注册 permission 命令）
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox-policy/README.zh.md「切换会话模式」（每个会话保持自己的模式、跨重启保留、以不可变 cwd 为写边界）
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts:249-257（用户已装的 taskboard 用 permissionPresets.set(session, permission) 按任务设权限）
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:323（桥用 /permission 夹紧每个会话）
- **C2***（依据：both；对应 R7, R2）审批只有 ask 和 never 两种会话策略，结果只有 allowed-once、rejected、cancelled、unavailable 四种。ask 时，请求进入按 agent 作用域分发的 `approval/request` 瀑布事件，桌面审批面板会一直等用户点（代码里没有任何计时器，只认回合的取消信号）。没有应答者在线时返回 unavailable，按拒绝处理。never 在分发前就直接拒绝。没有「总是允许」、白名单或记忆规则，审批请求也不携带工具参数。委派出去的子代理一律被固定为 never。
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:30-39（OUTCOMES、APPROVAL_POLICIES = ["ask","never"]、NEVER_SENTENCE）、:172-190（decide 只与 signal 赛跑；never 直接 rejected；缺应答者回落 unavailable）
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/README.zh.md「已知限制」（仅一次性授权、请求不携带工具参数、没有内置应答者）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-approval/lib/client.js:152-240（PendingApproval 无超时）、:355（ctx.remote.$on("approval/request")）
  - 证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3535-3575（serviceAsk 直接 await approval.request，无超时）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:413（委派子代理 approvalPolicy 固定 "never"）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-call-timeout-policy/README.zh.md（bash/read/write/edit 没有工具级超时）
- **C3***（依据：both；对应 R7, R5）沙箱只限制「写文件」，不限制联网和读文件。macOS Seatbelt 的配置是 `(allow default)` 加 `(deny file-write*)`；Linux bwrap 只读挂载整个根目录，也没有网络隔离。所以 workspace-write 的机器人照样能用 curl 联网，也能读全盘（包括 ~/.ssh 和 ~/.dsh 下的凭据文件）。MCP 服务器进程由 SDK 直接拉起，不进沙箱；MCP 工具和 web_fetch 的调用也都不走审批。
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox-local/lib/index.js:65-75（seatbeltProfileArgs：(allow default)、(deny file-write*)）、:22-38（bwrapProfileArgs：--ro-bind / /，没有 --unshare-net）
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox/README.zh.md「已知限制」（不表达网络、进程、凭据限制）
  - 证据：dsh-src/@deepseek-ai/dsh-fs-sandbox/README.zh.md「概述」（保留本地文件系统的读取行为）
  - 证据：dsh-src/@deepseek-ai/dsh-mcp-client/lib/index.js:7,28,40（StdioClientTransport + scrubbedParentEnv；全文件 0 处 approval/sandbox）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-web/README.zh.md「已知限制」（公开抓取不请求审批，模型仍可向公开 URL 发送数据）；lib/index.js 0 处 approval
  - 证据：dsh-src/@deepseek-ai/dsh-tool-bash/lib/index.js:218（TODO(permissions): deployment policy belongs in tools/pre-execute）
- **C4***（依据：both；对应 R7, R8）用量能按会话查看，但没有预算也没有金额。token-meter 注册了 `tokenUsage`（uncachedInputTokens、outputTokens、cacheReadTokens、cacheWriteTokens，按整份持久日志累计，同一步的重试另算），还有 `contextPressure` 和 `contextBreakdown`；session-stats 注册了 `sessionStats`（turns、steps、llmMs、toolMs 等）；远程方法 `session.projections` 连冷会话都能读。统计范围只有本会话主循环的 assistant/message 和 assistant/attempt。harness 不读价格、也不报告花费；没有轮次或 token 预算，没有自动停，没有全局暂停；goal 只有 Round 上限（默认 256）；定时提醒不支持暂停。
  - 证据：dsh-src/@deepseek-ai/dsh-token-meter/lib/index.js:393-425（tokenUsage 只折叠 assistant/message 与 assistant/attempt）、:694-696（注册三个投影）
  - 证据：dsh-src/@deepseek-ai/dsh-token-meter/README.zh.md「解读数字」（占用是参考数字，harness 中没有任何机制依据它做决定）
  - 证据：dsh-src/@deepseek-ai/dsh-session-stats/lib/index.js:67（key "sessionStats"）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:270-274（The harness never reads pi-ai's cost metadata … no consumer reports spend）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md「已知限制」（没有内置轮次预算）
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（defaultMaxGoalRounds 256；只有 Round 数量预算）
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:157（不支持暂停）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3281（projections 读 live 或持久会话）
- **C5***（依据：both；对应 R7, R10）补管控所需的插件接口都是现成的，而且都能按 agent 作用域分发：`tools/pre-execute`（每次工具调用前可 allow、deny、ask、cancel，能看到工具名、解析后的参数和调用方 agent）；`ctx.tools.guard`（单调拒绝，不能被后续放行）；`ctx.tools.restrict`（按 agent 屏蔽工具）；`agent/pre-step`（拒绝一步，官方的归档门禁就用它拦唤醒）；`agent/request`（替换本次调用的 provider/model）；`agent/request-error`（处理额度、限流失败）；`approval/request`（自定义审批应答者）。
  - 证据：dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3321（ctx.waterfall(carrier,"tools/pre-execute",…)）、:2991（restrict）、:3017（guard）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4004,4012,4020,4484（agent/pre-step、agent/request、agent/request-error、tools/pre-execute 的签名与语义）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2516（ctx.on("agent/pre-step") 对归档会话返回 { kind: "reject" }）
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:176（waterfall(scopeTarget(req.agent, req.agent), "approval/request", …)）
- **C6**（依据：both；对应 R1, R7）支持多模型。pi-ai 适配器的安装包里带 42 个供应商目录（含 zai、zai-coding-cn、moonshotai、minimax、qwen-token-plan、deepseek、openai、anthropic、google、openrouter 等），还能手写任意 OpenAI 或 Anthropic 兼容网关，改了设置下一次请求就生效。按会话选模型可行：`session.selectModel` 只改这个会话，但会在后台顺手把它存成全局默认；`ctx.agents.create({ agentOptions: { provider, model } })` 可以按 agent 直接指定；`agent/request` 可以逐个请求改路由。
  - 证据：dsh-src/_app/desktop-runtime.json（files 中 node_modules/@earendil-works/pi-ai/dist/providers/data/*.json 共 42 个）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-pi-ai/package.json（@earendil-works/pi-ai ^1.1.0）及 README.zh.md「配置提供方路由」
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:128-136（llm-pi-ai 默认休眠，需在设置里添加路由）
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:793-812（selectModel → selectForNextRequest + agentDefaultModel.saveSelection）
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md「使用本包」（ctx.agents.create 的 agentOptions provider/model）
- **C7***（依据：both；对应 R5, R7）MCP 客户端可以接外部服务。每台服务器一条配置，走 stdio（本地命令）或 Streamable HTTP（URL + headers）；工具名是 `mcp__<server>__<tool>`，单次调用默认 60 秒超时；断线后指数退避重连，连续 10 次失败就移除工具。配置行可以放在主机层（所有机器人共享），也可以放进某个 agent preset（只给这一类机器人用）。限制：没有 GUI 配置页，没有 OAuth，不接凭据库，密钥只能写在 env 或 headers 里；服务器的 instructions 会原样进入系统提示词；不支持 MCP prompts 模板、资源订阅和 task-based 工具。
  - 证据：dsh-src/@deepseek-ai/dsh-mcp-client/README.zh.md「最小配置」字段表、「已知限制」、:127（独立 agent 作用域可复用相同 namespace）
  - 证据：dsh-src/@deepseek-ai/dsh-mcp-client/lib/index.js:96（publicToolName）、:145/:487（toolCallTimeoutMs）；全文件无 oauth/credentials 引用
  - 证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml（官方 MCP 接入模板就是写 cordis patch）
  - 证据：dsh-src/@deepseek-ai/（dsh-client-ui-settings-* 共 11 个设置页，无 MCP 设置页）
- **C8***（依据：code；对应 R5, R8）主动联系用户的现成手段只在应用内：侧边栏把等待审批、提问、计划审阅的会话标成 warning（如「等待审批」）；任务完成有「未读」标记，但只是本地视图状态；`present` 工具能把文件挂成交付物。没有系统通知、Dock 角标、托盘状态，也没有 IM 或邮件推送：主进程里的 Notification 和 Dock 跳动只用于强制更新提醒，托盘菜单只有打开和退出，网页前端也没有调用 Notification API。
  - 证据：dsh-src/_app/main.js:9673-9725（DesktopUpdateAttention：全文件唯一的 new Notification 与 dock.bounce）、:11695-11735（DesktopTray 只有 open/quit）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1048-1055（visiblePendingKind：approval/plan-review/question）、:2075-2081（status.waitingApproval，state warning）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-sidebar/README.zh.md:118（New task completed 未读标记是本地查看状态）
  - 证据：dsh-src/@deepseek-ai/dsh-web-frontend/dist（grep 无 Notification API 调用）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-present/README.zh.md「概述」
- **C9**（依据：both；对应 R5, R7）网页搜索和抓取是现成的：standard preset 默认带 `web_search` 和 `web_fetch`，任何权限档都能用，也不需要审批。搜索后端只有 DeepSeek：默认是 Messages 搜索，每次搜索等于一整轮 deepseek-v4-flash 调用，最多做 maxUses=5 次服务端搜索，需要 DEEPSEEK_API_KEY 或已登录的 DeepSeek 账号；也可以切到 DeepSeek Search/Fetch API（不耗模型 token，但另计费）。抓取是匿名的，只允许公网地址，只解析文本，单次最多 20 万字符，只能 GET。限额只有单次调用级（searchMaxQueries 4、searchMaxResults 8、超时 60 秒或 30 秒），没有按会话或按天的次数、费用上限。
  - 证据：dsh-src/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:116-120（tool-web fetch: true, searchTimeoutMs 60000）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:456-490（searchProvider: deepseek-official，apiKeyEnv DEEPSEEK_API_KEY）
  - 证据：dsh-src/@deepseek-ai/dsh-web-search-deepseek/README.zh.md「已知限制」（一次搜索消耗一个完整 Messages 模型轮次）；lib/index.js:284（maxUses default 5）
  - 证据：dsh-src/@deepseek-ai/dsh-web-deepseek-api/README.zh.md:88（不消耗辅助模型 token，API 抓取另行计费）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-web/README.zh.md 字段表与「已知限制」（没有覆盖整个批次的原生搜索计数器）
  - 证据：dsh-src/@deepseek-ai/dsh-web-fetch-http/lib/index.js:162,196（method "GET"）、:35-72（isPublicIpAddress）
- **C10**（依据：both；对应 R7）审计和止血都是按会话的。每次审批都会写 approval/asked 和 approval/decided；权限变化会写 permission/preset、sandbox/mode、approval/policy；工具调用与结果、llm/retry、DeepSeek 搜索的请求体也都进会话日志，并且可以导出。对单个机器人，可以用 `session.cancel` 停掉当前回合，或用 `archiveSession(id, { stopActivity: true })` 一次停掉回合、后台任务、子代理，并删除提醒，之后的唤醒会被 `agent/pre-step` 门禁拦成 blocked。没有跨机器人的审计视图，也没有全局一键暂停。
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js request()（追加 approval/asked、approval/decided）
  - 证据：dsh-src/@deepseek-ai/dsh-subagent/lib/typert.host.js:757（SessionEventMap 含 approval/*、permission/preset、sandbox/mode、llm/retry、tool/call）
  - 证据：dsh-src/@deepseek-ai/dsh-web-search-deepseek/README.zh.md「请求日志」
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2690（Remote("cancel")）、:2516（归档门禁）
  - 证据：dsh-src/@deepseek-ai/dsh-workspace/README.zh.md:104（archiveSession stopActivity 语义）
- **C11**（依据：readme；对应 R7）实验性的 Auto review 让模型逐次审查工具调用（包括 MCP 和 web）：低风险的直接放行；外部写入、不可逆删除需要人明确授权；跨信任边界外泄一律拒绝。但每次工具调用都要额外发一次模型请求，被拒后会转人工审批（仍然会卡住），只能对当前会话手动开启，不能设为默认，且默认处于关闭状态。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/README.zh.md「获得的能力」「模型体验」「已知限制」
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/cordis.patch.yml
- **C12***（依据：both；对应 R7, R9）平台层没有「同时活跃的会话或机器人数」上限，只有三处局部限制：每步并行工具数（maxParallelToolCalls）、每个 owner 最多 10 个后台任务（maxConcurrentJobsPerOwner），以及 workflow 的 maxConcurrentAgents。用户遇到的「活动会话已达上限 2」来自自写 claude-bridge 的护栏（DEFAULT_MAX_ACTIVE_SESSIONS = 2，settings 可调 1–4）。已装的 dsh-taskboard 也自带全局执行并发上限（默认 3，可用 DSH_TASKBOARD_MAX_CONCURRENT 修改）。
  - 证据：/Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:53-54、:161、:309-312
  - 证据：/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/shared/protocol.ts:125；/Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts:77-79
  - 证据：dsh-src/@deepseek-ai/dsh-jobs-local/README.zh.md:44
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md「概述」（maxParallelToolCalls）
  - 证据：dsh-src/@deepseek-ai/dsh-workflow-ptc/README.zh.md:42
- **C13**（依据：both；对应 R7）失败重试与额度：默认 normal 模式对 RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT、EMPTY_RESPONSE 最多重试 5 次，每次都是一次计费请求；QUOTA 不重试，这一步直接失败。always 模式会无限重试，连 QUOTA、AUTH 也重试。pi-ai 路由把 401/403 判为 AUTH，把「quota exceeded」「usage limit reached」这类英文措辞判为 QUOTA，其余含 429 的判为 RATE_LIMIT。所以 GLM 5 小时上限如果返回 429 加中文提示，会先被当成限流重试 5 次。
  - 证据：dsh-src/@deepseek-ai/dsh-llm-retry/README.zh.md（normal 默认 5 次；always 会重试永久性失败）
  - 证据：dsh-src/@deepseek-ai/dsh-llm/lib/types/error.js:76-82（isQuotaExceededError 英文正则）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1448-1460（classifyPiAiError）
- **C14**（依据：both；对应 R7）凭据库是进程级全局的：所有会话和机器人共用同一份 `ctx.credentials`（来源顺序是 .credentials.yaml → 环境变量 → .env），代码里没有按 agent 或会话的隔离。子进程环境会按名字（*KEY*、*TOKEN*、*SECRET*、*PASSWORD*）清洗凭据变量，但沙箱不拦读文件。secret-mask 只遮挡界面显示，模型收到的仍是原文。
  - 证据：dsh-src/@deepseek-ai/dsh-credentials/lib/index.js:109-111（CredentialProvider，全文件 0 处 agent/session）
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:113-125（凭据来源顺序注释）
  - 证据：dsh-src/@deepseek-ai/dsh-subprocess/README.zh.md:80；dsh-subprocess-local/README.zh.md:156
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-secret-mask/README.zh.md「概述」
- **C15**（依据：both；对应 R2, R7）有几个现成开关能让机器人「不等人」：会话级 approval never（越界动作自动拒绝，并告诉模型不要申请提权）；在 presets 表里加一个 `workspace-write + never` 组合，就得到「沙箱内干活、越界自动拒」的无人值守档；`ask_user_question` 可以在 preset 里配 `mode: timed`，到期后模型继续独立工作（默认是无限等待）；headless 档没有应答者，需要审批的动作一律按拒绝收口。
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:39（NEVER_SENTENCE）
  - 证据：dsh-src/@deepseek-ai/dsh-permission-presets/lib/index.js:138-158
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ask-user/README.zh.md「概述」、:28、:74
  - 证据：dsh-src/@deepseek-ai/dsh-headless/cordis.patch.yml；dsh-user-approval/README.zh.md「没有内置应答者」

## 限制清单（* 为承重结论）

- **L1*** 审批没有超时、没有规则、没有远程审批：桌面审批面板无限期等待，只有本机的 owner 能回答；关窗在 macOS 上只是隐藏窗口，面板仍在线挂着。
  - 影响：「需要时询问」（ask）档的主动机器人半夜一旦需要越界，就会整夜挂在「等待审批」，回合不结束，同会话后续的唤醒也只能排队；用户不打开 App 就不知道。无人值守的机器人必须改用 never（自动拒绝），或自写应答者。
  - 证据：dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:172-190
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-approval/lib/client.js:152-240
  - 证据：dsh-src/@deepseek-ai/dsh-api-remote-access/README.zh.md「已知限制」（交互参与仅限 owner）
  - 证据：dsh-src/_app/main.js:12880-12905（关窗只是 window.hide()）
- **L2*** 沙箱只管写文件。联网、读文件、MCP 和 web_fetch 都不受限，也不走审批。macOS 上无法通过配置加网络隔离：Seatbelt 规则写死在代码里，自定义 runner 只面向 bwrap 兼容的 Linux；要彻底隔离，只能把 ctx.shell/ctx.fs 换成容器或远程执行器。
  - 影响：没法给机器人设「只许访问某些网站或服务」的硬边界。被网页或邮件内容提示注入的机器人，可以读本机敏感文件再发出去；接了飞书、邮件后，对外写操作默认没有闸门。
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox-local/lib/index.js:65-75
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox-local/README.zh.md「已知限制」（Seatbelt 依赖 sandbox-exec；runnerCommand 是 bwrap 兼容 profile）
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox/README.zh.md「已知限制」（容器/microVM/远程执行需替换能力实现）
  - 证据：dsh-src/@deepseek-ai/dsh-tool-web/README.zh.md「已知限制」
- **L3*** 没有预算、金额、全局暂停和全局并发上限；goal 默认可以自动续行 256 轮；tokenUsage 不含辅助调用（搜索整轮、Auto review、标题生成），子代理的用量记在各自的子会话里。
  - 影响：十来个机器人同时醒来，几轮就可能把 GLM 5 小时额度打光，而且没有任何自动刹车。「预算＋暂停＋并发闸」插件必须自建，用量面板也会低估真实消耗。
  - 证据：dsh-src/@deepseek-ai/dsh-token-meter/lib/index.js:393-425
  - 证据：dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md「已知限制」
  - 证据：dsh-src/@deepseek-ai/dsh-goal/README.zh.md（defaultMaxGoalRounds 256）
  - 证据：dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:270-274
  - 证据：dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:157
- **L4** 凭据和外部服务账号无法按机器人隔离：凭据库是全局的；MCP 不走凭据库，也没有 OAuth。
  - 影响：所有机器人用同一把 API key、同一个外部账号身份，出了问题无法按机器人限额或追责；MCP 密钥只能写进配置（明文风险）。
  - 证据：dsh-src/@deepseek-ai/dsh-credentials/lib/index.js
  - 证据：dsh-src/@deepseek-ai/dsh-mcp-client/README.zh.md 字段表（env/headers）
- **L5** 没有系统通知、Dock 角标，也没有 IM 或邮件推送通道。
  - 影响：机器人的汇报、求助、等审批都要自建推送；否则只能等用户自己打开 App 看侧边栏。
  - 证据：dsh-src/_app/main.js:9673-9725、:11695-11735
- **L6** `session.selectModel` 在改会话模型的同时，会把这个选择存成全局默认。
  - 影响：批量给机器人设不同模型时，最后一次设置会变成用户新开会话的默认模型；要用 agent/request 或 ctx.agents.create 规避。
  - 证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:809
- **L7** 权限预设的几点局限：presets 表在插件生命周期内固定，改了要重载；每个会话只有一个可写根目录；/tmp 等临时区所有机器人都能写；Auto 不能设为默认；通过 `/permission <档>` 命令切换完全权限时不弹风险确认（只有界面点选才确认）。
  - 影响：机器人之间的共享文件夹只能放进各自的 cwd，或者给完全权限；让一个 Agent 批量生成机器人时，它可以静默把机器人切到完全权限，必须由创建插件夹紧档位。
  - 证据：dsh-src/@deepseek-ai/dsh-permission-presets/README.zh.md「已知限制」
  - 证据：dsh-src/@deepseek-ai/dsh-sandbox-policy/README.zh.md「已知限制」（每个会话只有一个主要工作区根目录）
  - 证据：dsh-src/@deepseek-ai/dsh-client-ui-permission-presets/README.zh.md「概述」
- **L8** 网页搜索依赖 DeepSeek 凭据，而且每次搜索都是一整轮模型调用。
  - 影响：如果只订阅了 GLM，搜索可能直接报凭据缺失；研究型机器人每次搜索都会产生额外的 DeepSeek 计费，而且不计入会话用量。
  - 证据：dsh-src/@deepseek-ai/dsh-web-search-deepseek/README.zh.md「已知限制」与「鉴权」
- **L9** MCP 服务器的 instructions 会原样拼进系统提示词；MCP 服务器进程不在沙箱里运行。
  - 影响：接入一个不可信的 MCP，等于给所有挂载它的机器人加了一段系统级指令，是提示注入的入口。
  - 证据：dsh-src/@deepseek-ai/dsh-mcp-client/README.zh.md「概述」
- **L10** Auto review 不适合无人值守：它被拒后会转人工审批，每次工具调用还要多一次模型请求。
  - 影响：不能指望用 Auto review 来替代夜间审批。
  - 证据：dsh-src/@deepseek-ai/dsh-experimental-auto-review/README.zh.md
- **L11** `ask_user_question` 默认无限等待；plan 模式需要人批准计划后才能执行。
  - 影响：给机器人用的 agent preset 要把提问改成 timed 模式，并且不要让机器人进入 plan 模式。
  - 证据：dsh-src/@deepseek-ai/dsh-tool-ask-user/README.zh.md:12,74
  - 证据：dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:346

## 核查结果

- **C1：部分成立**。原结论：权限档按会话独立设置；桌面默认三档：read-only、workspace-write（都配 ask）和 danger-full-access（never）；可用 /permission 或 permissionPresets.set 逐会话切换，切换写进会话日志、重启后保留；presets 表可自定义；workspace-write 的写边界就是会话 cwd，一个机器人一个目录就能隔离写入。
  - 核查说明：前半段在代码里确认：桌面用 web 档（dsh-base + dsh-web-app），dsh-base 配三档；实验性的 Auto review 默认关闭，开启后选择器会多出一个只能在当前会话选的 auto（danger-full-access + ask，由模型逐次审查）。/permission 和 permissionPresets.set 都把 permission/preset、sandbox/mode、approval/policy 追加进会话日志，重启后靠回放保留；presets 是 z.dict，可以在 profile 补丁里加 workspace-write + never 这类组合。

需要更正的是隔离结论：
(1) workspace-write 的可写集合是 writableRoots，即会话 cwd + /tmp + os.tmpdir()（macOS 上是每用户的 /var/folders/…/T）。Seatbelt 规则和进程内 fs 围栏用的是同一份集合，所以所有机器人共享这两个临时区，可以互相写入或篡改。读取在任何档位都不隔离，A 机器人能读 B 机器人的目录。“一个机器人一个目录”只隔离了工作区内的写入。
(2) ask 档下，单次调用可以通过 sandbox_permissions 申请升权；获批 allowed-once 后，这一次调用能写到工作区外。
(3) 新会话用的是 defaultPreset，用户能在“通用设置”里改，不一定是 workspace-write。批量创建机器人时，要像 bridge 那样显式执行 /permission 夹紧。
(4) 两条切换路径有差别：/permission 命令走 approval.setPolicy，会给模型注入“策略已由用户更改”；permissionPresets.set 直接写日志，不注入。界面选择器选完全权限要先确认风险，带参数的 /permission 命令则直接生效。
  - 证据：[配置] dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:243-276（sandbox-policy 默认 workspace-write；approval.policy 由 DSH_PERMISSION_MODE 推导；permission.presets 三档）
  - 证据：[代码] dsh-src/_app/main.js:3386-3387、3552（桌面 profile = PROFILE_TEMPLATES.web = dsh-base + dsh-web-app）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-experimental-auto-review/README.zh.md 概述（默认关闭，默认 Web 保持三种权限模式）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-permission-presets/lib/index.js:138-158（Config.presets = z.dict）、207-227（/permission 调 ctx.approval.setPolicy）、344-360（set/apply 追加 permission/preset 并调 setSandboxMode/setApprovalPolicy）、370-389（pinInitialPermission 取 defaultPreset）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-sandbox-policy/lib/index.js:141-147（resolve：显式授权 mode 优先；workspaceRoot = session.header.cwd）、:75（Some platform temporary areas may also be writable）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-sandbox/lib/index.js:166-173（writableRoots = [workspaceRoot, '/tmp', tmpdir()]）、99-123（approveEscalation：allowed-once 返回更宽 mode）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-fs-sandbox/README.zh.md 概述（workspace-write 只允许会话工作区或平台临时根目录；保留读取行为）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-client-ui-permission-presets/README.zh.md 概述/设置行（设置行只改未来会话默认；可见选项选完全权限需确认，/permission <preset> 直接执行）；dsh-permission-presets/README.zh.md:64
  - 证据：[代码] /Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/index.ts:249-257 与 lib/index.js:191（permissionPresets.set(session, permission)）
- **C2：部分成立**。原结论：审批只有 ask/never 两种策略、四种结果；ask 时进入按 agent 作用域分发的 approval/request 瀑布，桌面面板无限等待（无计时器，只认回合取消）；没有应答者在线时返回 unavailable 按拒绝处理；never 在分发前直接拒绝；无总是允许/白名单/记忆规则，请求不带参数；委派子代理固定 never。
  - 核查说明：代码确认的部分：
- 策略只有 ask/never，结果只有四种；never 在 waterfall 分发前就返回 rejected。
- decide() 只和回合 signal 赛跑，客户端的 PendingApproval 也没有计时器。
- 没有 allow-always，也没有记忆规则。
- 请求只带 toolName、callId、reason、displayReason、signal，另外借用 agent 对象。
- 委派子代理创建时被钉为 never，之后子会话自己切换仍可覆盖。

“没有应答者在线时返回 unavailable”在桌面版不成立。桌面 web 档组合了 dsh-api-remotes，它在宿主启动时就为 approval/request 注册了转发监听器，这个监听器不调用 next。dsh-api-gateway 把请求存进 pendingRemoteEvents，只投给当时在线的 owner 客户端。没有客户端时请求一直挂着；客户端断开也只是移除投递，不结算；客户端重连后用同一个 event id 重投。所以在桌面上，没人看窗口、甚至渲染进程断开，都不会落到 unavailable，只有取消回合（session.cancel、归档 stopActivity、退出 App）能解开。

unavailable 只在这几种情况出现：组合里根本没有应答者（headless/sdk 等档）；应答者抛错或返回非法值；客户端主动 delegate（例如它找不到该会话）；转发事件源已经关闭。

补充两点：
- 请求虽然不带参数，但带了 callId 和 agent，自写应答者可以按 callId 去会话日志里查参数；更简单的办法是在 tools/pre-execute 里直接看参数。
- bash 执行器自己有 60 秒期限（超时后转为后台任务），但升权审批发生在执行之前，不受这个期限约束。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:30-39（OUTCOMES、APPROVAL_POLICIES、NEVER_SENTENCE）、128-144（审计对）、172-189（never 直接 rejected；默认 next 为 'unavailable'；只与 signal 赛跑）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-user-approval/README.zh.md:153-156（仅开放回合内；仅 allowed-once；不携带参数；无内置应答者）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-api-remotes/lib/index.js:25-28（approval/request 以 waterfall 转发）、165-176（监听器入队、不调 next）、233-248（只有队列关闭才 next）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-api-gateway/lib/index.js:851-865（启动即消费事件源）、1062-1108（startRemoteEvent 存 pendingRemoteEvents，仅投在线 owner）、1014（新客户端连上时重投全部 pending）、1130-1134（断开只移除投递不结算）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-api-gateway/README.zh.md:90（pending 的 scoped waterfall 沿用同一 event id 重放）
  - 证据：[配置] dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:248-249（桌面所用 web 档组合 api-remotes）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-client-ui-approval/lib/client.js:151-240（PendingApproval 无计时器）、284-305（找不到会话时 next）、355
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3535-3575（serviceAsk 无超时，传 callId/agent）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:397-415（approvalPolicy 固定 never；later child switches still win）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-tool-bash/README.zh.md:51、66（bash 执行器超时转后台任务）
- **C3：成立**。原结论：沙箱只限写文件，不限联网和读文件（Seatbelt：(allow default)+(deny file-write*)；bwrap 只读挂根、无网络隔离），workspace-write 机器人能 curl、能读全盘含凭据；MCP 服务器进程不进沙箱；MCP 工具与 web_fetch 不走审批。
  - 核查说明：补充几点：
(1) 凭据 README 写明：agent 工具进程和用户是同一个 UID，文件沙箱不拒绝读取。所以 ~/.dsh/.credentials.yaml 对机器人不隔离；系统钥匙串方案还没做。
(2) bash 和 MCP stdio 子进程的环境变量里，名字匹配 KEY/PASSWORD/SECRET/TOKEN 的会被剔除，所有 DSH_* 也会被剔除。所以从环境变量偷不到密钥，但读文件可以。
(3) Linux 上的 Landlock 档同样没有网络规则。
(4) web_fetch 会拒绝解析到非公网地址的目标（防内网探测），但仍然可以把数据拼进公网 URL 发出去。
(5) 默认组合里注册了 tools/pre-execute 的只有 dsh-tool-jobs 和 dsh-workspace-changes，两者都直接 next。所以 MCP 工具和 web 工具确实没有任何默认闸门。
(6) README 写明 seam 不表达网络、进程、系统调用、设备、凭据方面的限制。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-sandbox-local/lib/index.js:22-38（bwrap：--ro-bind / /，仅 --unshare-pid）、45-52（Landlock）、65-75（Seatbelt：(allow default)、(deny file-write*)）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-sandbox/README.zh.md:166
  - 证据：[README] dsh-src/@deepseek-ai/dsh-credentials-local/README.zh.md:12、199（同 UID 进程可读；文件效果沙箱不拒读）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-mcp-client/lib/index.js:6-7、26-46（StdioClientTransport 直接 spawn；env = scrubbedParentEnv + 配置 env）；全文件 approval、sandbox 均 0 处
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-subprocess/lib/index.js:32、50-56（SENSITIVE_ENV_PATTERN /KEY|PASSWORD|SECRET|TOKEN/i 与 DSH_* 剔除）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-tool-web/README.zh.md:253；[代码] dsh-web-fetch-http/lib/index.js:35、70（WEB_BLOCKED_URL 非公网目标）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3310-3330（只有 pre-execute 返回 ask 才进审批）；dsh-tool-jobs/lib/index.js:235-239、dsh-workspace-changes/lib/index.js:1086（默认 pre-execute 监听均放行）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-tool-bash/lib/index.js:218（TODO(permissions)）
- **C4：成立**。原结论：用量可按会话查看（tokenUsage 四桶、contextPressure、contextBreakdown、sessionStats；session.projections 可读冷会话），只统计主循环 assistant/message 与 assistant/attempt；不读价格不报花费；无轮次/token 预算、无自动停、无全局暂停；goal 只有 Round 上限 256；定时提醒不支持暂停。
  - 核查说明：补充几点：
(1) 因为只折叠 assistant/message 和 assistant/attempt，上下文压缩（dsh-compaction-basic）的摘要模型调用也不计入；它的 usage 写在 compaction/summary 事件里。
(2) sessionStats 由 dsh-web-app 组合，只有 web/桌面档才有。
(3) 读者引用 token-meter 的“占用是参考数字”一句，说的是 contextPressure，算不上“没有预算”的直接证据，但和结论不矛盾。
(4) 唯一和金额沾边的是 DeepSeek 账号设置页的 getBalance，查的是平台钱包余额，不是按会话或按机器人算的花费。
(5) llm-retry 的 README 明说：每次重试都是一次新的、要另外计费的请求。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-token-meter/lib/index.js:320-336（四个桶）、393-425（只折叠 assistant/message、assistant/attempt；llm/retry-started 使重试另计）、691-693（注册三个投影）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-session-stats/lib/index.js:29-36、67；dsh-web-app/cordis.patch.yml:102-103
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3281-3310（live 或 sessionQuery.observeSession 读冷会话）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:270-274
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-api-account-controller/lib/index.js:221-226（getBalance 仅查平台钱包）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-compaction-basic/lib/index.js:629-648（compaction/summary 带 usage）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md:220；dsh-goal/README.zh.md:12、158；dsh-schedule/README.zh.md:157；dsh-llm-retry/README.zh.md 概述
- **C5：部分成立**。原结论：补管控所需的插件接口都现成且可按 agent 作用域分发：tools/pre-execute（allow/deny/ask/cancel，见工具名、参数、调用方）、ctx.tools.guard（单调拒绝）、ctx.tools.restrict（按 agent 屏蔽工具）、agent/pre-step（拒绝一步）、agent/request（换 provider/model）、agent/request-error（处理额度/限流）、approval/request（自定义应答者）。
  - 核查说明：七个接口都存在，签名和语义与 api-catalog 及实现一致，都按 scope 过滤分发（代码已确认）。但要拿来补管控，还有几个读者没说的前提：
(1) waterfall 按注册顺序执行，外层先跑，不调 next 就截断；只有 prepend 注册才排到最前（cordis 实现）。桌面的 UI 转发器（dsh-api-remotes）在宿主启动时就注册了，没用 prepend，也不调 next。所以自写的 approval/request 应答者必须用 prepend，否则只要 UI 不 delegate，它永远收不到请求。
(2) agent/pre-step 返回 reject 时，本步已经从 inbox claim 出来的消息不会放回，回合以 blocked 结束。归档门禁要的就是这个效果；但用它实现“暂停”，会吞掉暂停期间到达的提醒和消息，除非插件从 payload.messages 自己暂存，恢复后再 followup。这一条是读代码推断的，需要实测。
(3) ctx.tools.guard 只能做同步判断。restrict 必须在 agent scope 上调用，只能屏蔽继承来的全局或 preset 工具，名字不存在会直接抛错。
(4) 想按机器人分别生效，插件要挂在该 agent 的 scope 上（preset 插件列表或 ctx.agents.create）；挂在宿主层会收到所有机器人的事件。
(5) 这些钩子只管工具调用和模型请求这一层，管不到 bash 子进程和 MCP 服务器进程在 OS 层的联网、读文件。
(6) 轮次预算可以按 README 建议，借 agent/turn-stopping 等生命周期点执行取消。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4004、4012、4020、4484
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2990-3006（restrict 需 scope）、3008-3021（guard 同步、单调）、3310-3340（ask 获批后仍过 guardReason）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2500-2518（ArchivedSessionGate：迟到的唤醒被拒，以 blocked 结束且不发请求）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:176
  - 证据：[代码] dsh-src/@deepseek-ai/cordis/lib/index.js:317-325、336（waterfall 依注册顺序、prepend 才 unshift）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-api-remotes/lib/index.js:165-176（UI 转发器无 prepend、不调 next）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:103-111（inbox.claim 移出消息）、900-922、956-962（reject → blocked，未放回）；README.zh.md:120、220
- **C7：成立**。原结论：MCP 客户端可接外部服务：stdio 或 Streamable HTTP；工具名 mcp__<server>__<tool>；默认 60 秒超时；断线指数退避，连续 10 次失败移除工具；配置可放主机层或 agent preset；无 GUI、无 OAuth、不接凭据库、密钥写在 env/headers；instructions 原样进系统提示词；不支持 prompts、资源订阅、task-based 工具。
  - 核查说明：补充几点：
(1) dsh-mcp-client 随安装包附带，但默认组合没有它（dsh-base 只组合了 dsh-mcp-resources）。要用，得写 profile 补丁，或经 plugin_manager 装一个 bundle。
(2) 放进 preset 时，每个 preset 声明在启动时只建一个 scope 和 Loader 树，同一 preset 下的所有机器人共用一个 MCP 连接、一个 token。想让每个机器人有独立的外部身份，就得一个机器人配一个 preset。
(3) “没有 OAuth”是代码确认的，README 没写：StreamableHTTPClientTransport 只传了 requestInit.headers，没有 authProvider，插件也不注入 credentials。YAML 里可以用 !!js process.env.X 引用启动环境，但这份环境在启动时就冻结了。
(4) 连接和发现超时沿用 SDK 默认的 60 秒，没有单独的配置项。
  - 证据：[README] dsh-src/@deepseek-ai/dsh-mcp-client/README.zh.md 最小配置字段表、:127、已知限制
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-mcp-client/lib/index.js:38-46（仅 headers，无 authProvider）、96（publicToolName）、145/487/690（toolCallTimeoutMs）、567-573（超 maxAttempts 注销工具）、736-745（interpolate:false 进系统提示词）、766-776（serverName 按注册 scope 预留）
  - 证据：[配置] dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:491-492（默认只有 mcp-resources）；dsh-src/_app/package.json:182
  - 证据：[README] dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md:56（每个声明一个 scope/Loader 树）
  - 证据：[配置] dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml
  - 证据：[README] dsh-src/@deepseek-ai/dsh-client-ui-settings-plugins/README.zh.md 概述（配置页由各插件伴生包注册，无 MCP 伴生页）
- **C8：成立**。原结论：主动联系用户只在应用内：侧边栏 warning（等待审批/提问/计划审阅）、本地未读标记、present 交付物；无系统通知、Dock 角标、托盘状态、IM/邮件推送；主进程 Notification 与 Dock 跳动只用于强制更新，托盘只有打开/退出，前端无 Notification API。
  - 核查说明：补充几点：
(1) 托盘只在 process.platform === 'win32' 时创建，macOS 上根本没有托盘图标。“托盘只有打开和退出”说的是 Windows。
(2) 主窗口 defaultSession 的权限处理器对 media 以外的权限一律放行，包括 notifications。所以客户端插件在渲染进程里调 Web Notification 很可能可行；这一点没实测，而且还需要 macOS 的通知授权。
(3) DESKTOP_IPC 里没有通知通道。宿主插件想发系统通知，只能借客户端插件，或者走飞书等外部渠道。
  - 证据：[代码] dsh-src/_app/main.js:9673-9725（DesktopUpdateAttention 唯一的 new Notification、dock.bounce）
  - 证据：[代码] dsh-src/_app/main.js:11695-11735（DesktopTray open/quit）、12803-12805（仅 win32 创建托盘）、6981-7006（DESKTOP_IPC 无通知通道）
  - 证据：[代码] dsh-src/_app/main.js:7062-7071、12417（defaultSession 非 media 权限放行）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-client-ui-workspace/lib/client.js:1048-1055、2070-2090
  - 证据：[README] dsh-src/@deepseek-ai/dsh-client-ui-sidebar/README.zh.md:118
  - 证据：[代码] 对全部 dsh-src/@deepseek-ai 包与 dsh-web-frontend/dist grep new Notification/requestPermission/setAppBadge：只命中 dsh-experimental-inspector（DevTools 前端）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-tool-present/README.zh.md 概述
- **C12：部分成立**。原结论：平台层没有同时活跃会话/机器人数上限，只有三处局部限制（maxParallelToolCalls、maxConcurrentJobsPerOwner=10、workflow maxConcurrentAgents）；活动会话上限 2 来自自写 claude-bridge；taskboard 自带全局并发上限默认 3、可用 DSH_TASKBOARD_MAX_CONCURRENT 改。
  - 核查说明：成立的部分：平台层没有会话或机器人总数上限，LLM 层也没有请求并发闸。“活动会话已达上限 2”确实出自自写桥的 DEFAULT_MAX_ACTIVE_SESSIONS（settings 可调 1–4），官方包里搜不到这句话。

“只有三处局部限制”不完整，还漏了：
- dsh-subagent 的 maxActiveSubagents，默认 8，同一棵 activation 树共享，根父级不占名额，可在设置页修改。
- dsh-subagent 的 maxDepth，默认 1，只允许直接子代理。
- PTC 的 maxParallelSubCalls，默认 10。

taskboard 上限的取值顺序：看板设置里的 maxConcurrent（UI 可调 1–100）最优先，其次是环境变量 DSH_TASKBOARD_MAX_CONCURRENT，最后才是默认值 3。
  - 证据：[代码] /Users/bytedance/Documents/DSHarness Doc/肖像画项目/tools/dsh-bridge/lib/bridge.js:53-54、161、309-312
  - 证据：[代码] /Users/bytedance/.dsh/profiles/desktop/node_modules/dsh-taskboard/src/shared/protocol.ts:125-127、280-282；src/index.ts:77-79
  - 证据：[README] dsh-src/@deepseek-ai/dsh-jobs-local/README.zh.md:44；dsh-agent-loop/README.zh.md:48；dsh-workflow-ptc/README.zh.md:42
  - 证据：[代码+README] dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:2980（maxActiveSubagents 默认 8）；README.zh.md:49、53
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2752-2764（maxParallelSubCalls 默认 10）
  - 证据：[代码] 在 dsh-agent-loop、dsh-api-session-controller、dsh-session、dsh-llm、dsh-llm-pi-ai、dsh-llm-deepseek 中 grep maxSessions/maxAgents/semaphore/concurren：没有会话总数或请求并发闸
- **L1：成立**。原结论：审批无超时、无规则、无远程审批：桌面面板无限期等待，只有本机 owner 能答；macOS 关窗只是隐藏，面板仍在线；ask 档机器人夜里越界会整夜挂起，回合不结束，同会话后续唤醒排队；必须改 never 或自写应答者。
  - 核查说明：补充几点，结论比读者说的还要强：
(1) 关窗在所有平台都只是 hide（Windows 第一次关会弹“后台继续运行”提示），不只是 macOS。
(2) 即使渲染进程断开或崩溃，宿主网关也会把审批留在 pendingRemoteEvents 里，客户端重连后重投，不会落成 unavailable。唯一的出口是回合取消：session.cancel、归档时带 stopActivity、或退出 App。
(3) “后续唤醒只能排队”有代码支持，不只是推断：dsh-schedule 用 agent.followup 投递提醒，followup 进的是 next-turn 队列，要等当前回合结束。
(4) README 写明审批只能在开放回合内进行，“持久化的轮次外审批工作流仍属延期工作”。所以把审批转到飞书的自写应答者，也只能一直占着回合等；而且它必须 prepend 注册，才能排在 UI 转发器前面（见 C5）。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:172-189
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-client-ui-approval/lib/client.js:151-240
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-api-gateway/lib/index.js:1014、1062-1108、1130-1134；dsh-api-remotes/lib/index.js:165-176
  - 证据：[README] dsh-src/@deepseek-ai/dsh-api-remote-access/README.zh.md 已知限制（交互参与仅限 owner）
  - 证据：[代码] dsh-src/_app/main.js:12880-12906（close → preventDefault → hideMainWindow，所有平台）、12818（Windows 后台提示）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1596（agent.followup 投递提醒）；dsh-agent-loop/lib/index.js:806-808（followup = next-turn）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-user-approval/README.zh.md:153
- **L2：部分成立**。原结论：沙箱只管写文件，联网、读文件、MCP、web_fetch 都不受限也不审批；macOS 无法通过配置加网络隔离（Seatbelt 写死，自定义 runner 只面向 bwrap 兼容的 Linux），彻底隔离只能换 ctx.shell/ctx.fs 为容器或远程执行器；因此没法设只许访问某些网站或服务的硬边界。
  - 核查说明：主体成立：Seatbelt 规则写死在代码里；bwrap 和 Landlock 都没有网络隔离；MCP 进程不进沙箱；web_fetch 和 MCP 默认都不审批。

两处偏差：
(1) “自定义 runner 只面向 bwrap 兼容的 Linux”不准确。只要配置了 runnerCommand，confine() 在任何平台都会直接用它，并在后面追加 bwrap 风格的参数（--ro-bind / /、--bind <ws> <ws>、--tmpfs /tmp 等）。在 macOS 上可以写一个包装程序，把这些参数翻译成带 (deny network*) 的 sandbox-exec 配置，不用替换 ctx.shell。但这是跳过探测的“操作方断言”，官方不支持，要自己验证。
(2) “没法设只许访问某些网站或服务的硬边界”说得太绝对。web_fetch 和 MCP 工具的参数在 tools/pre-execute 里看得到，按 URL 或工具名做白名单，在工具这一层就是硬边界。Web 档的 web_search/web_fetch 是按 agent preset 组合的，可以给某类机器人干脆不放这两个工具。真正管不住的是 bash（以及 PTC）子进程任意联网，以及 MCP 服务器进程本身。

补充：web_fetch 会拒绝非公网目标；dsh-http-proxy 的代理环境变量只对愿意遵守代理变量的子进程生效，不能当安全边界。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-sandbox-local/lib/index.js:65-75（Seatbelt 写死）、253-257（Config：runnerCommand 等）、305-320（配置 runnerCommand 后任何平台都用它并追加 bwrapProfileArgs）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-sandbox-local/README.zh.md:45、57、135
  - 证据：[README] dsh-src/@deepseek-ai/dsh-sandbox/README.zh.md:166-167
  - 证据：[README] dsh-src/@deepseek-ai/dsh-tool-web/README.zh.md:253（需逐次确认的部署须加 tools/pre-execute 策略或禁用抓取）；dsh-tool-cordis/lib/types/api-catalog.js:4484（pre-execute 可见解析后参数）
  - 证据：[配置] dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:584-585（宿主层 tool-web disabled）；presets/standard.patch.yml:117、ptc.patch.yml:119、cordis.patch.yml:116；dsh-base/cordis.patch.yml:454-456
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-web-fetch-http/lib/index.js:35、70
  - 证据：[README] dsh-src/@deepseek-ai/dsh-http-proxy/README.zh.md 已知限制
- **L3：部分成立**。原结论：没有预算、金额、全局暂停和全局并发上限；goal 默认可自动续行 256 轮；tokenUsage 不含辅助调用（搜索整轮、Auto review、标题生成），子代理用量在各自子会话；十来个机器人同时醒来可能打光额度且没有任何自动刹车，用量面板会低估。
  - 核查说明：代码确认：没有预算、金额、全局暂停，也没有全局并发闸。需要补充或修正几点：
(1) tokenUsage 漏计的不只是搜索、Auto review、标题生成，上下文压缩的摘要调用也漏计（写在 compaction/summary）。
(2) “goal 可自动续行 256 轮”只在同一次进程生命周期内成立。遇到任何会话开始边界（重启、冷恢复、fork），active 的 goal 都会被停用续行；出现 agent/error（例如重试用尽、额度失败）时，goal-round-driver 也会 disarm。而 create/edit/pause/resume 工具要求当前回合有一条 source.kind === 'user' 的人类消息，所以定时提醒唤醒的回合，模型没法自己重新武装 goal。
(3) llm-retry 的 normal 模式只对 EMPTY_RESPONSE、RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT 最多重试 5 次，不重试 QUOTA；always 模式没有上限。QUOTA 是靠英文正则判定的，GLM 的中文额度报错可能被归成 RATE_LIMIT，先重试 5 次才失败。

所以“没有任何自动刹车”应改为：没有基于预算的主动刹车，只有出错后的被动停止，而定时提醒仍会照常唤醒机器人、继续消耗额度。
(4) 子代理有每棵树最多 8 个的并发上限，不是完全无限。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-token-meter/lib/index.js:393-425
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-compaction-basic/lib/index.js:629-648
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-web-search-deepseek/lib/index.js:323-325；dsh-experimental-auto-review/lib/index.js:414（ctx.llm.stream 直调）；dsh-session-title-llm/lib/index.js:199
  - 证据：[README] dsh-src/@deepseek-ai/dsh-goal/README.zh.md:12、72、158
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-goal-round-driver/lib/index.js:211-213（agent/error → disarm）；README.zh.md:128-129
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:51（要求 source.kind === 'user'）；README.zh.md:12、55、116
  - 证据：[README] dsh-src/@deepseek-ai/dsh-llm-retry/README.zh.md:50；[代码] dsh-llm/lib/index.js:181-183（QUOTA 英文正则）
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:270-274；dsh-subagent/lib/index.js:2980

## 核查员补充（读者漏掉的点）

- 读者建议用全局 agent/pre-step 返回 reject 来做“一键暂停”，这样会吞掉暂停期间到达的提醒和消息。agent-loop 先 inbox.claim 把消息移出队列，再交给 agent/pre-step；reject 后回合以 blocked 结束，消息不会放回。归档门禁要的就是这个效果；暂停插件必须自己从 payload.messages 暂存，恢复后再 followup，否则这段时间的唤醒全部丢失。这一条是读代码推断的，需要实测。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:103-111、900-922、956-962
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2500-2507（迟到的唤醒被门禁拒绝，以 blocked 结束且不发请求）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-agent-loop/README.zh.md:71、120
- 爆炸半径跨机器人：plugin_manager 的每个动作（启停、安装、升级、移除插件）都作用于整个 profile 的所有会话，前提是该会话是 danger-full-access，或者这次调用单独获批。所以任何一个拿到完全权限的机器人，或者一次审批被误点，都能改掉所有机器人的工具、钩子和管控插件。preset 也不是安全沙箱，preset 里的插件和 YAML 直接执行宿主代码。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-plugin-manager/lib/types/tools.js:76（Every action requires danger-full-access permission or approval… Changes affect every session in this profile）、95
  - 证据：[README] dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md:99
- 按机器人收窄能力的单位是 preset，但 preset 不能在运行时创建：注册表不写入任何声明，新建或覆盖 preset 只能写 bundle 补丁再经 plugin_manager 安装，而且只影响之后创建的 Agent。会话的 preset 只在会话还空白时能选或切换，第一轮之后就固定了。所以“另一个 Agent 批量生成带不同工具和权限的机器人”要走“写补丁 + 装插件（需完全权限或审批）+ 新建空白会话”这条路。
  - 证据：[README] dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md:48、56、60
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:30-40（A session may still change preset while it is blank）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-agent-preset/README.zh.md 概述（修改只影响之后创建的 Agent）
- 用 GLM 的机器人做自主调研时，web_search 需要单独存一个 DEEPSEEK_API_KEY。DeepSeek 账号登录态只在“当前会话的 provider 是 deepseek-account”时才被搜索使用，否则直接报 WEB_PROVIDER_CREDENTIAL_MISSING。所以读者说的“需要 DEEPSEEK_API_KEY 或已登录的 DeepSeek 账号”，对 GLM 机器人来说只剩前一个选项。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-web-search-deepseek/lib/index.js:205（错误文案：使用 DeepSeek Account 模型的对话才用账号登录搜索）、292（ACCOUNT_PROVIDER = 'deepseek-account'）、309-311（provider 不是账号时不取 token）
  - 证据：[配置] dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:454-479
- 长期目标的自我推进跨不过重启。任何会话开始边界（重启 App、冷恢复、fork）之后，active 的 goal 都会被停用续行。模型侧的 create/edit/pause/resume 工具要求当前回合里有人类直接消息（source.kind === 'user'），定时提醒唤醒的回合（source schedule）不能让机器人自己重新武装 goal。只能由用户或插件执行 /goal resume（bridge 正是这么做的）。这对“主动机器人”和“额度失控”两方面都很关键。
  - 证据：[README] dsh-src/@deepseek-ai/dsh-goal/README.zh.md:72
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-tool-goal/lib/index.js:51；README.zh.md:12、55、116
  - 证据：[README] dsh-src/@deepseek-ai/dsh-command-goal/README.zh.md 概述（/goal 命令可恢复）
- 审计能力：每次审批都在发起会话的日志里写一对 approval/asked 和 approval/decided（记录 toolName、callId、reason、结果），所有工具调用和结果也都在会话日志里，可以用 dsh-session-log-export 下载。但只有逐会话的日志，没有跨机器人的审计或汇总视图，Agent 中心要自己聚合。
  - 证据：[代码] dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:128-144
  - 证据：[README] dsh-src/@deepseek-ai/dsh-user-approval/README.zh.md:12
  - 证据：[README] dsh-src/@deepseek-ai/dsh-session-log-export/README.zh.md 概述
- 官方包目录里列了、但桌面 0.2.1-rc.5 没有随附的几个实验包，正好对口 R7 和事件触发：dsh-hooks-claude-code 和 dsh-hooks-codex，能把 Claude Code / Codex 的 hooks 配置跑在 DSH 的拦截点上，可直接复用 PreToolUse 式规则做放行或拒绝；dsh-webhook 和 dsh-webhook-github，用 Webhook 规则创建会话。会话格式里已经把 webhook、hooks-codex、hooks-claude-code 登记为消息来源。能否从市场或 npm 安装、和当前版本是否兼容，都没验证。
  - 证据：[README] dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:211-212、218-219
  - 证据：[配置] dsh-src/_app/desktop-runtime.json sharedPackages（305 个，不含上述包）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-session-format-v3-to-v4/README.zh.md:132
- 电脑睡着时机器人不会醒：桌面主进程没有用 powerSaveBlocker 阻止系统休眠，而提醒要求宿主进程正在运行才能投递。关窗只是隐藏，宿主还在；但系统一休眠就停了，只能等唤醒或重启后再补投。
  - 证据：[代码] dsh-src/_app/main.js（grep powerSaveBlocker 为 0；只有 12705 的 powerMonitor resume 用于检查更新）
  - 证据：[README] dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:153
- 被委派出去的子代理没有主动性和对外交互能力：不能创建或修改提醒（dsh-tool-schedule 拒绝所有被委派调用方），不能 ask_user_question，审批固定 never，委派深度默认 1，每棵树最多 8 个活跃子代理。所以“机器人派小弟”只适合一次性的子任务，长期主动的机器人必须是顶层会话。
  - 证据：[README] dsh-src/@deepseek-ai/dsh-schedule/README.zh.md:158
  - 证据：[README] dsh-src/@deepseek-ai/dsh-tool-ask-user/README.zh.md:12、74
  - 证据：[README] dsh-src/@deepseek-ai/dsh-subagent/README.zh.md:49、53；lib/index.js:363、397-415

## 缺口与补法

- [R7 无人值守审批｜工作量 M] ask 档会无限期等待；没有规则、超时或远程审批。
  - 补法：最快的办法是改配置：在 permission.presets 里加 workspace-write + never，作为机器人默认档，越界一律自动拒绝。进阶做法是自写挂在机器人 agent 作用域上的 approval/request 应答者插件，支持规则、超时，并能转飞书卡片审批。
- [R7 按机器人限定工具与对外写权限｜工作量 M] 没有部署级的逐工具策略（tool-bash 里标着 TODO）；MCP 和 web_fetch 不走审批。
  - 补法：自写 tools/pre-execute 策略插件：每个机器人一张允许清单（MCP 工具名、收件人或群、web_fetch 域名）；再配合 agent preset 只挂必要的工具。
- [R7 网络与读取隔离｜工作量 blocked] 沙箱只管写文件；macOS Seatbelt 规则写死，网络和读取补不进去。
  - 补法：配置层做不到。只能把高风险机器人放进容器、虚拟机或独立系统用户里运行（替换 ctx.shell/ctx.fs 执行器），或者干脆不给这类机器人 bash，只留受控工具。
- [R7 凭据按机器人隔离｜工作量 L] 凭据库是全局的，MCP 密钥写在配置里。
  - 补法：部分可补：不同类型的机器人用不同 agent preset，各自的 MCP 行用各自的 token。彻底隔离依赖上一条的进程级隔离。
- [R7 用量统计与预算自动停｜工作量 M] 只有按会话的 token 数；没有金额，没有预算；辅助调用和子会话不计入。
  - 补法：自写预算插件：按机器人汇总它名下会话（含子会话）的 tokenUsage，自己维护单价表折算金额；超限时 agent/pre-step 返回 reject，再调 goals.block('budget-exhausted') 并发通知。搜索、审查等辅助调用要在 tools/result 或包装层里另行计数。
- [R7 全局一键暂停｜工作量 S] 没有全局暂停；定时提醒不能暂停；归档会删除提醒。
  - 补法：自写插件：一个全局暂停开关，加全局 agent/pre-step reject（与官方归档门禁同一机制），再用 tools.guard 兜底；按钮做成客户端 slot 或 webServer 路由。
- [R7 并发上限｜工作量 M] 平台层没有同时活跃机器人数的上限。
  - 补法：在 agent/pre-step 里做信号量或排队；或者沿用 dsh-taskboard 的 maxConcurrent（默认 3）；给各机器人的唤醒时间加随机错峰。
- [R7 审计视图｜工作量 M] 只有逐会话的日志，没有跨机器人的汇总。
  - 补法：自写插件汇总各机器人会话的 approval/*、tool/call、permission/preset、llm/retry 事件（可走 session.page/follow 远程接口），做成审计页。
- [R7 额度错误识别｜工作量 S] QUOTA 判定靠英文措辞，GLM 5 小时上限可能被当成限流先重试 5 次。
  - 补法：在 agent/request-error 里识别 GLM 的额度报错，直接暂停该机器人直到额度窗口重置；机器人用的路由不要开 always 重试。
- [R5 主动通知用户｜工作量 M] 没有系统通知、角标、IM 或邮件推送。
  - 补法：(a) 给机器人一个「发飞书」工具：飞书 MCP，或 bash 调 lark-cli、curl 飞书机器人 webhook（沙箱不拦网络；web_fetch 只能 GET，发不了消息）。(b) 宿主插件监听 approval/asked、回合结束、goal blocked 事件统一推送，不依赖模型记得汇报。(c) 客户端插件用 Web Notification 弹系统通知。
- [R5 接飞书、邮件、日历｜工作量 S] mcp-client 能接，但没有 GUI、没有 OAuth，密钥要写进配置。
  - 补法：写一个带 cordis.patch.yml 的 MCP 接入包（参照官方 templates/mcp），密钥由包装脚本从本地文件读取；或在 bash 里调 lark-cli。
- [R5 网页搜索可用性｜工作量 S] 搜索后端只有 DeepSeek，需要 DeepSeek 凭据。
  - 补法：登录 DeepSeek 账号或填 DEEPSEEK_API_KEY；或者接第三方搜索 MCP（如智谱 web-search MCP，需实测）。
- [R5 浏览器自动化｜工作量 S] 没有给模型用的浏览器工具，侧栏浏览器是给人用的。
  - 补法：接 Playwright 等浏览器 MCP。
- [R1/R7 按机器人选模型且不改默认｜工作量 S] selectModel 会顺手改全局默认。
  - 补法：用 ctx.agents.create 的 agentOptions 指定，或在 agent/request 里按机器人改路由。

## 可调用的宿主接口

- `approval/request 瀑布事件（按 agent 作用域）`：自写审批应答者：按工具名和理由自动批准或拒绝，加超时（到点返回 rejected），或者转成飞书卡片等用户点；返回 allowed-once/rejected，或调用 next() 交给桌面面板。
- `ctx.approval.setPolicy(agent, policy) / setApprovalPolicy(session, policy)`：用程序给单个机器人切换 ask 或 never；setPolicy 会给模型注入一条「由用户更改」的提示。
- `ctx.permissionPresets.set(session, name)、`/permission <name>` 命令、permission.presets 配置表`：逐个机器人设权限档；在配置里加 workspace-write + never 等自定义组合，作为「无人值守档」。
- `tools/pre-execute 瀑布事件（按 agent 作用域）`：每次工具调用前，按工具名和参数做 allow/deny/ask/cancel。例如：只允许「通知机器人」调用 mcp__feishu__* 并限定群；限制 web_fetch 的域名；禁止某机器人用 bash。注意不能改写参数。
- `ctx.tools.guard(fn) / ctx.tools.restrict({ allow, deny })`：全局或按 agent 的硬拒绝（后续监听器无法再放行），以及按 agent 屏蔽工具；restrict 必须在 agent.ctx 上调用。
- `agent/pre-step 瀑布事件`：返回 { kind: 'reject' } 拒绝这一步（不发模型请求）：用于预算超限、全局暂停开关、并发闸。官方归档门禁就是同一机制，迟到的定时唤醒也会被拦成 blocked。
- `agent/request 瀑布事件`：替换本次调用的 LlmCallConfig（provider、model、reasoning），用来按机器人路由模型，或在超预算时自动降级到便宜模型，而且不会改全局默认。
- `agent/request-error 瀑布事件`：拿到 failure.code（QUOTA、RATE_LIMIT、ACCOUNT_QUOTA 等）后自己决定重试还是终止；可以识别 GLM 5 小时额度报错，把机器人暂停到额度窗口重置。
- `会话投影：ctx.sessionProjections 的 tokenUsage、contextPressure、sessionStats；远程 session.projections({ sessionId })；ctx.tokenMeter.measure(session)`：用量面板和预算判断的数据源；冷会话不用唤醒 agent 也能读。
- `ctx.goals.pause / block(agent, ref, reason)`：停止某个机器人的自动续行，并记录稳定的 blocker 代码（如 budget-exhausted、quota-window）；由宿主发起的暂停会中止正在跑的 Round。
- `session.cancel 远程方法 / ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })`：单个机器人的止血：前者停当前回合；后者停回合、后台任务、子代理，删除提醒，并拦截后续唤醒。
- `ctx.agents.create({ agentOptions: { provider, model } }) / session.selectModel`：按机器人指定模型；前者不会碰全局默认。
- `dsh-mcp-client 配置行（主机层，或放进 agent preset 的 plugins 列表）`：给某一类机器人接飞书、邮件、日历等 MCP 服务，每类机器人可以用各自的 token。
- `dsh-tool-web 与 dsh-web-search-deepseek 配置（search/fetch 开关、searchMaxQueries、searchMaxResults、各项超时、maxUses、maxTokens）`：收紧研究型机器人的搜索成本，或者给不需要上网的机器人关掉这两个工具。
- `ask_user_question 的 mode: timed 配置`：无人值守的机器人提问后，到期就继续独立工作，不会卡死。
- `客户端扩展：sidebar.toggle.badge slot、ctx.uiSession.registerPendingInteraction`：在应用内做提醒角标或自定义待办面板。系统通知需要在客户端插件里调用渲染进程的 Web Notification（推断可行，未验证）。
- `provider profile 的 retryPolicy（mode normal/always、maxRetries、backoff）`：控制失败重试带来的额外计费；机器人用的路由不要开 always。
- `ctx.deepseekAccount.getBalance()`：只能查 DeepSeek 账号的钱包余额，其他供应商查不了。

## 读者留下的未决问题

- 关掉主窗口后（macOS 上只是隐藏），挂起的审批是否仍在面板里无限等待？代码推断是，需实测；如果渲染进程被系统回收，结果会变成 unavailable（按拒绝处理）。
- 用户 GLM 订阅的 5 小时上限，报错的状态码和文本是什么？这决定 DSH 把它归为 QUOTA（立即失败）还是 RATE_LIMIT（先重试 5 次），影响预算和暂停插件怎么识别。
- 用户是否登录了 DeepSeek 账号，或配置了 DEEPSEEK_API_KEY？如果都没有，web_search 用不了。
- 用户当前的 desktop profile 是否改过 permission presets、开过 Auto review？按禁区规定没有读 profile 配置，无法确认。
- 飞书官方 OpenAPI MCP 能否与 DSH 的 MCP SDK（优先 2026-07-28 协议，回退旧版）正常握手？lark-cli 在 workspace-write 下刷新 token、写用户目录时，是否会被沙箱拦下而触发提权？
- 放进 agent preset 的 stdio MCP，是否每个机器人会话各起一个进程（推断是）？N 个机器人时的进程和内存开销需实测。
- compaction 摘要（compaction/summary 事件带 usage 字段）和会话标题生成的调用，是否消耗供应商额度但不计入 tokenUsage？推断如此，需核对。
- drive-dsh 技能 gotchas 第 12 条说「联网会弹批准」，与 Seatbelt 代码（allow default，只拒写）不符，需实测澄清，再修正技能文档。
- agent preset 能否声明默认模型（README 没提）？这决定「机器人模板」能否自带模型。
