# Grok Bot 功能清单

- 调研截至 2026-11-05。对象是 xAI（页面署名 SpaceXSI）与 Cursor 联合运营的 Grok Bot，桌面版到 0.78.x，手机版到 1.19.0。
- 用途：给「DSH 版 Grok Bot」（dsh-agent-hub）对照该做什么、不该做什么。内容是功能事实，不是设计建议。
- 可信度标记：
  - official：x.ai/news、x.ai/bot 的指南与用例、docs.x.ai/grok-bot、cursor.com/docs/grok-bot、cursor.com/help/grok-bot、cursor.com/terms/grok-bot。
  - third-party：媒体、博客、论坛、视频摘要，以及第三方转载的官方更新日志（x.ai/changelog/bot 抓取时返回 403，没能直接核实）。
  - inferred：由多条来源推断，没有直接出处。
- 一个条目同时有官方和第三方来源时，主体按官方写，第三方的补充单独标出。
- Reddit 原帖检索不到，凡是提到 Reddit 的内容都是 CellCog、eesel、explainx 等转述的，其中 CellCog 和 eesel 是竞品，有利益相关。YouTube 只拿到了摘要或章节标题，没有逐字稿。

## 1 身份与创建

### 1.1 常驻 AI 队友（official）

- 是什么：有名字、固定职责、独立对话和长期上下文的常驻 Agent。官方把它定位为能交付真实工作的 AI 队友，7×24 小时工作，只在需要审批时回来找你。产品起源于 SpaceXSI 的内部原型，在公司内用于销售外联、营销活动、行政运营、修 bug。
- 怎么用：像给同事发消息一样布置任务。Bot 在自己的云电脑上跨 app 和网站完成多步工作，并在会话里同步进度；关掉 app、笔记本或手机，后台任务和 routine 都不停。
- 官方建议：一个 Bot 只负责一个明确的岗位（例如人才搜寻、报销管理、Bug 复现），不要做「万能助手」。目标、工具、工作风格、审批边界或运行周期不同的工作，拆成不同的 Bot。
- 出处：https://x.ai/news/introducing-grok-bot ；https://cursor.com/docs/grok-bot ；https://docs.x.ai/grok-bot/overview ；https://cursor.com/docs/grok-bot/work

### 1.2 官方宣传的示例岗位（official）

- 8 月 26 日的扩容公告列了 9 个：销售拓客（每封发送都等你批准）、建站（建站、部署、买域名、配插件和跳转）、数字断舍离（删除或退订前都等你批准）、客服（读支持邮件、连支付商、在政策内处理常规退款）、游戏美术、办公室经理（在 Gmail、Slack、ServiceTitan、Quo、客户门户之间处理工单和排期）、收件箱管理、代参会（参会、记笔记、发纪要）、退款追回。
- 这些只是宣传示例，没有对应的功能说明页。「代参会」在产品文档里找不到操作说明。
- 出处：https://x.ai/news/grok-bot-more-plans ；https://x.ai/news/introducing-grok-bot

### 1.3 首次使用（official，附第三方补充）

- official：打开桌面 App 点 Sign in，在浏览器里用 Cursor 账号登录，没有单独的 Grok Bot 账号。Grok Business 席位用户选 Sign in with Grok；SuperGrok 或 X Premium+ 用户点 Link Grok Account 关联，这个关联是永久的，不能解绑。看完一段简短介绍（早期版本还会问你的主要工作领域和常用工具，并据此推荐 Bot）。第一次搭建云电脑要几分钟，桌面显示「Setting up your Grok Bot…」，手机显示「Starting your computer…」。完成后自动创建第一个名叫 Grok Bot 的 Bot，并打开和它的对话。
- third-party：欢迎屏「Meet a future teammate」可能卡住，要彻底退出重开、更新，再打开 Agent Computer（DataCamp）。引导会让你选颜色和角色（编程与仓库、研究与写作、收件箱与日历、混合），起名，再回答几个问题（Debbie O'Brien）。问卷里填的工具只影响之后的建议，不会真的去连接；云电脑在你填问卷时就在后台开机（Daily Dose of DS、Flavio Copes）。
- 出处：https://cursor.com/help/grok-bot/onboarding ；https://docs.x.ai/grok-bot/get-started ；https://docs.x.ai/grok-bot/troubleshooting ；https://www.datacamp.com/tutorial/grok-bot-tutorial ；https://debbie.codes/blog/how-to-get-started-with-grok-bot ；https://www.dailydoseofds.com/p/grok-bot-masterclass/ ；https://flaviocopes.com/grok-bot/

### 1.4 新建一个 Bot（official，附第三方补充）

- official：点侧栏顶部的「+」或按 Cmd/Ctrl+N；团队账号点「+」会弹出菜单（Create a Bot、Browse shared Bots）。在 Create New Bot 对话框里填名字、选头像的形状和颜色，点 Create 后直接进入它的对话。第一条消息写清它的职责、数据来源和审批边界，并让它记住（官方示例大意：负责产品性能，保留链接和截图，区分证据和假设，先说影响最大的问题，永远不改生产设置）。个人 Bot 现在没有描述字段和 Bot 设置页，它做什么完全靠聊天和记忆来定义；9 月 11 日的 101 指南里还是「名字、标题、描述」三个字段，并说搭一个 Bot 约 10 到 15 分钟，可以从一段随口录的语音备忘录开始。已有的 Bot 也会建议你为长期工作单独建一个 Bot。
- third-party：可以直接让主 Bot 或任意一个 Bot 帮你「招」一个新 Bot，它会写好名字、标签和配置。Bot 会反问澄清、建议该连哪些插件。名字本身就是规格：起名「LinkedIn bot」，它就知道该干什么。8 月底起可以通过链接导入 Bot 模板。DataCamp 作者遇到过 Bot 把资料当成任务直接开干，只好新建一个写了「先等指令」规则的 Bot。多篇教程建议长期规则写进描述，具体任务写在消息里。
- 出处：https://docs.x.ai/grok-bot/bots ；https://x.ai/bot/guides/grok-bot-101 ；https://debbie.codes/blog/how-to-get-started-with-grok-bot ；https://www.datacamp.com/tutorial/grok-bot-tutorial ；https://www.mindstudio.ai/blog/grok-bot-setup-guide/ ；https://youmind.com/landing/x-viral-articles/grok-bot-personal-ai-guide ；https://www.woshipm.com/ai/6479246.html ；https://www.eesel.ai/blog/grok-bot-review

### 1.5 Bot 详情面板（official）

- 点对话顶部的 Bot 名打开（快捷键 Cmd+Shift+I）。可以改名字、标签（手机上叫 Title）和头像（调整默认形象、用文字生成、上传小于 25MB 的图片）。
- Details 标签下是 Routines 列表，每条带暂停开关；Library 标签下是 Pages、文件、apps、图片和视频；另有 Share 和通知开关。
- 共享 Bot 额外有 About、Plugins、Secrets、Skills、Files，以及一个扳手图标进入 Bot settings。
- 出处：https://cursor.com/help/grok-bot/edit-bot ；https://cursor.com/help/grok-bot/shared-bots

### 1.6 侧栏组织，以及删除、隐藏、重置的区别（official）

- 侧栏：可以置顶；可以分区（右键 Move to new section 或 Move to；删除分区后里面的 Bot 移到 Unassigned）；可以 Hide from sidebar（不删除、不停 routine、不再发通知），在 Hidden Bots 里恢复。右键菜单有 Pin、Move to new section、Mark as Unread、Rename Bot、Copy conversation ID、Hide from sidebar、Delete。Bot 自己建的 helper Bot 也出现在侧栏，可以关通知或隐藏。
- 重置会话只清聊天历史，保留记忆、文件、routine 和设置。
- 删除 Bot 会删掉它的资料、会话、记忆、routine 和附件（包括它替其他 Bot 存下的共享事实），不可撤销；但云电脑上的文件和登录状态可能还在，要另外清理。
- 隐藏 Bot 什么都保留。删除账号会删掉一切，30 天内清除完毕。
- 出处：https://cursor.com/help/grok-bot/how-to ；https://cursor.com/help/grok-bot/memory ；https://cursor.com/docs/grok-bot/work ；https://cursor.com/help/grok-bot/delete-account

### 1.7 复制 Bot（official，只在 iPhone 上有）

- 副本带走资料、设置、技能、routine 和头像，不带聊天记录、记忆和附件。
- 出处：https://docs.x.ai/grok-bot/mobile

### 1.8 模板分享与 Marketplace（official）

- 是什么：把 Bot 打包成一份「配方」分享出去，接收方得到属于自己的独立副本，不是克隆。官方 Marketplace 页面展示了 35 个 Bot、9 个分类、4 个精选，作者包括 Lenny Rachitsky、Claire Vo、Kent C. Dodds。现在入口并入 Connect apps 里的 Bot templates。
- 分享流程：Bot 详情 → Share → Create a copy，Bot 在对话里生成模板卡，点 Publish 再点 Copy link（手机上是 Share as Template）。发布后可以查看、更新或删除模板。
- 模板包含：身份、描述、指令、相关技能和记忆、第一方插件、routines。不包含：秘密、个人记忆、私有技能、自定义代码和脚本、MCP 等非标准插件。
- 接收方在 x.ai 的预览页点 Add to Grok Bot 或 Import Bot，同时接受第三方 Bot 条款，必要时自己重装插件。接收方拿不到你的电脑、登录状态或聊天记录。
- 团队管理员可以把分享限制为仅团队内，企业版默认关闭公开分享。
- 出处：https://x.ai/bot/guides/templates-for-grok-bot ；https://x.ai/bot/marketplace ；https://docs.x.ai/grok-bot/bots ；https://cursor.com/docs/grok-bot/work ；https://cursor.com/docs/grok-bot/teams

### 1.9 Bot 的实质（inferred）

- 一个 Bot 大致等于：一份档案（名字、职责、规则、头像），加一条独立的对话和记忆，加一个一次只处理一件事的任务队列。电脑、浏览器登录、连接器、技能、Vault 全是账号级共享资源。所以 Bot 是分工单位，不是安全边界。
- 依据：文档和多篇评测都确认电脑和登录是全账号共享的；Builder.io 发现技能对所有 Bot 可见，而且每个 Bot 只有一条对话、一个队列，忙的 Bot 会变成瓶颈；Vault 不能限定给单个 Bot；复制 Bot 只复制档案，不复制记忆。
- 出处：https://www.builder.io/blog/grokbot-review ；https://www.dailydoseofds.com/p/grok-bot-masterclass/ ；https://www.eesel.ai/blog/grok-bot-review ；https://flaviocopes.com/grok-bot/ ；https://www.datacamp.com/tutorial/grok-bot-tutorial

## 2 自己的电脑

### 2.1 每个用户一台持久云电脑（official）

- 是什么：Bot 在一台持久的云电脑上工作，有桌面、浏览器、终端和文件系统，权限和你本人相同。同一用户的所有 Bot 共用这一台电脑，文件、浏览器会话、app 登录、命令行凭据都共享。每个 Bot 有自己的屏幕，可以并行；同一块屏幕一次只能跑一个电脑操作任务。
- 技术细节：每个用户一个 Firecracker 微虚拟机，用户之间硬件级隔离，运行在 Cursor 的美国云上。持久磁盘保存文件和浏览器会话，空闲时自动休眠，不删数据。共享目录 `/workspace` 用来在 Bot 之间交接文件。
- 第三方补充：长期保存的文件要放在 `/workspace`，临时目录、手动装的包、没提交的应用状态都不保证保留（DataCamp 等）。
- 说法冲突：官方营销以及 650 Group、Netalith、Kevin Stratvert 等说「每个 Bot 有自己的云电脑」；Cursor 文档和多篇深度评测说全账号共享一台，每个 Bot 只是在上面有一块屏幕。以共享为准（见存疑 2）。
- 出处：https://cursor.com/docs/grok-bot/work ；https://cursor.com/docs/grok-bot/teams ；https://cursor.com/help/grok-bot/computer-recovery ；https://x.ai/bot/guides/grok-bot-101 ；https://docs.x.ai/grok-bot/computer-and-apps ；https://www.datacamp.com/tutorial/grok-bot-tutorial

### 2.2 规格、出口 IP 与休眠（third-party，附官方说法）

- 第三方实测约 8 核、16GB 内存、100 到 128GB 磁盘、无 GPU，官方没有公布。出口 IP 固定在 AWS us-west-2（美国俄勒冈），不能选区域。官方说法是：出口 IP 是所有客户共享的固定段，不提供专属 IP。
- Builder.io 作者发现云电脑空闲时会休眠，导致定时任务晚 12 到 80 分钟才跑，重启后还会掉登录。
- 出处：https://www.ayautomate.com/blog/grok-bot-xai-ai-agents-explained ；https://aitoolsreview.co.uk/insights/grok-bot-agent-launch ；https://www.builder.io/blog/grokbot-review ；https://forum.cursor.com/t/grok-bot-computer-is-us-aws-only-nz-trade-sites-behind-imperva-hard-block-it/168271 ；https://cursor.com/docs/grok-bot/security

### 2.3 实时观看与接管（official，附第三方补充）

- official：点对话右侧面板的电脑预览，就能实时看 Bot 的点击、输入和页面跳转，用法像远程桌面。遇到单点登录、passkey、过不去的验证码、需要另一台设备批准、二维码、银行卡验证，或网站明确要求真人操作时，Bot 会把电脑交给你，不会尝试绕过：对话里出现标有「Action needed」的 Computer 卡片，你点 Take over，只完成卡住的那一步，再点 I'm done，Bot 继续；不想处理可以点 Skip。登录后的会话被你所有的 Bot 共用，直到过期。Mac 和 Windows 上可以在 Settings > General > Security Key 开启 YubiKey 这类硬件密钥，每次使用都要你确认。手机上也能接管。笔记本或手机上的指纹、Face ID、passkey 在云电脑上用不了。
- third-party：Debbie O'Brien 实测的流程是 Bot 打开登录页后停下，你在它的电脑上亲自登录（包括两步验证），点横幅上的「I'm done, continue」交回，Bot 始终看不到密码。Peter Yang 在云电脑上把老游戏跑了起来，能跑，但明显有延迟。
- 出处：https://cursor.com/help/grok-bot/how-to ；https://cursor.com/docs/grok-bot/work ；https://docs.x.ai/grok-bot/computer-and-apps ；https://docs.x.ai/grok-bot/mobile ；https://debbie.codes/blog/how-to-get-started-with-grok-bot ；https://digg.com/tech/memnl9ic

### 2.4 电脑维护（official，附第三方补充）

- official：电脑出问题时，在 Settings > Computer 里按破坏性从低到高依次用 Update、Recover、Reset。聊天记录存在电脑之外，重置不会丢。磁盘快满时，Bot 会在对话里列出最大的文件，征得你同意后才删。
- third-party：Reset 会保留 Bot、文件和登录，但会删掉已装的应用和包，以及没同步的内容。论坛工作人员经常建议「只重启 runner，不要 Reset」。
- 出处：https://cursor.com/help/grok-bot/computer-recovery ；https://cursor.com/docs/grok-bot/work ；https://www.datacamp.com/tutorial/grok-bot-tutorial

### 2.5 在没有 API 的网站上操作（official）

- 对没有连接器、没有 API 或 MCP 的网站和系统，Bot 直接在云电脑的浏览器里像人一样操作，例如供应商门户、安全问卷门户、需要真实点击才能覆盖的产品界面测试。
- 有 app 就优先用 app，没有才用电脑操作。网站封锁云 IP、会话过期或要求真人步骤时，交给你处理；被封时可以打开「Route traffic through this computer」，让流量走你本机的网络和 IP。
- 出处：https://x.ai/news/introducing-grok-bot ；https://cursor.com/docs/grok-bot ；https://cursor.com/help/grok-bot/faqs ；https://x.ai/bot/use-cases

### 2.6 在你本机执行命令与本机出网（official，附第三方补充）

- official：在 Settings > Computer > Your computer 的「Execution on this computer」里设置，三档是 Ask every time、Always allow、Never allow。默认每条命令都要你批准，审批卡显示确切的命令；官方建议没必要就设为 Never allow。打开「Route traffic through this computer」后，目标网站看到的是你本机的 IP；解析到内网或 VPN 地址的网站默认仍被拦。企业管理员可以给这两项设上限或直接关闭。所有设备在「Manage your devices」里管理。
- third-party：8 月时团队级的本地执行管控还是「即将推出」。Builder.io 作者用本地脚本通过 Bot 的 webhook 把编码线程的「完成、失败、等待输入」事件推给 Bot，并刻意不开公网隧道以降低提示注入风险。论坛上有 Windows 0.20.0 本地桥接报 404、macOS 本地执行进程挂掉的报告。
- 出处：https://cursor.com/docs/grok-bot/settings ；https://cursor.com/docs/grok-bot/security ；https://cursor.com/help/grok-bot/faqs ；https://www.dailydoseofds.com/p/grok-bot-masterclass/ ；https://vantaige.io/blog/grok-bot-complete-guide-2026 ；https://www.builder.io/blog/grokbot-review ；https://forum.cursor.com/t/grok-bot-issues-who-can-help/168114

### 2.7 重度用户的玩法（third-party）

- 在虚拟机里装 Tailscale 连回家里的网络。
- 在虚拟机终端里调用 Codex、Cursor Agent、Grok CLI 等别家 Agent。播客嘉宾 Aaron Makelky 只让 Grok Bot 当调度员，重活交给虚拟机里另外计费的 Codex。
- 出处：https://youmind.com/landing/x-viral-articles/grok-bot-personal-ai-guide ；https://ryandoser.com/is-grok-bot-worth-it/

### 2.8 网站拦截（official，附第三方实例）

- official：有些网站会封锁云服务器或数据中心的 IP，或要求验证码和真人操作，这时 Bot 交给你处理，不会绕过。
- third-party：开了 Imperva、Cloudflare、hCaptcha 等防护的网站会直接拦截，例如新西兰的 B2B 零件站、Suno、Shopify 登录。X 曾对云电脑显示「暂时限制登录」，过了一天都没解除。不能选出口区域，工作人员说在改进，但没有时间表。
- 出处：https://cursor.com/docs/grok-bot/security ；https://cursor.com/help/grok-bot/faqs ；https://forum.cursor.com/t/grok-bot-computer-is-us-aws-only-nz-trade-sites-behind-imperva-hard-block-it/168271 ；https://cellcog.ai/blog/grok-bot-problems/

## 3 登录与连接器

### 3.1 Connect apps：连接器、插件与 MCP（official，附第三方补充）

- 是什么：让 Bot 以结构化接口使用外部服务，比在网页上点来点去更可靠。官方指南说 Grok Bot 支持的 MCP server、插件和 skills 与 Cursor 相同。官方安全文档列出的内置连接器包括 GitHub、X、Gmail、Google Calendar/Drive/Docs/Sheets/Slides/Ads/BigQuery、Outlook/Outlook Calendar/OneDrive/Teams/SharePoint、Slack、Notion、Asana、Vanta、Power BI（只读）、Databricks Genie、QuickBooks、Workday、WhatsApp Business、Zoho、Stripe Link、Shop Pay、Tailscale、1Password 等。
- 怎么用：入口是侧栏的「Connect apps」（v0.67 之前叫 Marketplace），或对话里出现的「Connect」卡片。搜索并添加 app，在浏览器里完成授权，再在「Installed」里确认。
- 连接属于账号，所有 Bot 都能用。OAuth token 存在 Cursor 的连接器后端，Bot 只调用工具、拿不到 token。
- 部分 app 可以加第二个账号并用标签区分（例如工作 Notion 和个人 Notion）；Gmail 一次只能连一个邮箱。单个 app 内的具体工具可以分别开关（例如关掉发信、只留草稿）。团队策略禁用的 app 显示「Disabled by team admin」。Google 系 app 以「Grok」的身份授权，企业 Google Workspace 需要管理员先信任 Grok。Adapter、Robinhood、Intercom 等要在电脑上连接，连好后手机上也能用。
- third-party：连接卡片只在任务需要时才弹出。自定义 MCP 必须能从公网访问，本地服务要走隧道。接 Zapier 的方法是先在 Connect apps 里授权，再在对话里运行 `/zapier-setup`。GitHub 一度有两套连接方式，其中一套要个人访问令牌。Claire Vo 把「同一个服务连多个账号」称作杀手级功能。
- 出处：https://cursor.com/help/grok-bot/connect-apps ；https://cursor.com/docs/grok-bot/work ；https://cursor.com/docs/grok-bot/security ；https://x.ai/bot/guides/grok-bot-101 ；https://cursor.com/docs/grok-bot/teams ；https://zapier.com/blog/grok-bot/ ；https://www.mindstudio.ai/blog/grok-bot-setup-guide/ ；https://lennysnewsletter.com/p/i-tested-grok-bot-grok-46-and-cursor

### 3.2 Vault 保险库与安全表单（official）

- 是什么：账号级的保险库，保存网站登录、银行卡和联系信息。Bot 能用这些信息登录和结账，但看不到密码、卡号和安全码。
- 怎么用：Settings > Vault > New item，类型有 Login、Card、Contact info；银行卡可以拍照或上传图片识别；可以写「Hints」告诉 Bot 什么场景用哪一条。Bot 需要登录时依次尝试 Vault、已连接的密码管理器（1Password，每次要你在 1Password 里批准）、对话里弹出的安全表单（Secure Form）。表单上勾选「Securely save to Bot's vault」才会长期保存，不勾只在本次会话有效。
- 支持导入 1Password、Chrome、Safari、Firefox、Bitwarden、LastPass 导出的 CSV（小于 5MB，只在本机解析、不上传）。Bot 替你注册新网站时，可以由 Vault 生成密码，Bot 自己看不到。Bot 能看到联系信息，也知道你存了哪些登录，但看不到密钥的值。
- 限制：需要 0.75.2 及以上版本；Vault 里的条目对账号下所有 Bot 可用，不能只开放给某一个 Bot；共享 Bot 不支持 Vault，要改用 Secrets。
- 出处：https://cursor.com/help/grok-bot/secrets ；https://docs.x.ai/grok-bot/vault ；https://cursor.com/docs/grok-bot/security ；https://flaviocopes.com/grok-bot/

### 3.3 安全密钥卡与 Secrets（official）

- 用来收集 API key 这类不是登录的秘密。输入时打码显示，不写进聊天，也不发给模型。
- Bot 需要时弹出密钥卡，你输入后点「Save securely」。之后这个值只能写、不能读，界面上也不再显示。
- 共享 Bot 的拥有者可以在详情的 Secrets 里添加，格式是「环境变量名 + 描述 + 值」，描述 Bot 能看到，值看不到；要改值只能整个替换。这些 key 会在每个队友的对话里被使用。
- 官方要求：不要把秘密贴进聊天、Shell 或普通文件；用 Teach a task 演示时也不要输入秘密。
- 出处：https://cursor.com/help/grok-bot/secrets ；https://cursor.com/docs/grok-bot/work

### 3.4 1Password（official）

- Bot 需要登录时可以向已连接的 1Password 请求，每次都要你在 1Password 里批准。只能用个人或 Private 保险库，要求 1Password 8.12.42 及以上。1Password 不负责填银行卡。第三方转载的更新日志称 v0.77.0（10 月 26 日）起不再需要共享保险库（third-party）。
- 出处：https://cursor.com/help/grok-bot/secrets ；https://cursor.com/help/grok-bot/connect-apps ；https://www.gradually.ai/en/changelogs/grok-bot/

### 3.5 代付结账（official）

- 可用的支付方式：Vault 里保存的卡（结账时自动填写，不会每次都问你）、通过安全表单临时输入的卡、已连接的钱包 Link、X Money、Shop Pay。钱包和首选支付方式在 Settings > Vault 的「Payment accounts」和「Default payment method」里设置。
- 连接 Link 后，Bot 可以为单笔购买申请一次性虚拟卡。审批卡显示商户、商品和总价，按钮是「Pay（带金额）」「Pay another way」「Deny」；批准后还要在 Link 页面完成授权。拒绝或过期都不会扣款。
- 想每笔都亲自审批，就不要把卡存进 Vault。
- 出处：https://docs.x.ai/grok-bot/vault ；https://cursor.com/help/grok-bot/secrets ；https://cursor.com/help/grok-bot/connect-apps ；https://cursor.com/docs/grok-bot/work

### 3.6 商品卡片、订单跟踪、订阅管理（third-party）

- v0.78.1（10 月 27 日）：购物搜索结果以商品卡片显示（照片、评分、价格、商店，最多两个徽章，例如「Top rated」），每组 3 到 4 个轮播，缺货选项变灰。点「Buy now」下单需要你批准；下单后跟踪物流并通知你，物流卡片显示承运商和配送阶段。新增 3 个订阅类模板：试用到期前提醒或取消、取消不用的订阅、续费价格检查。Shop Pay 可以在 Vault 里设为首选支付方式。
- 来源是第三方对官方更新日志的转载和 Cursor 员工在 X 上的发帖。
- 出处：https://www.gradually.ai/en/changelogs/grok-bot/ ；https://aicatchup.com/news/grok-bot-v0-78-1-shopping-subscriptions ；https://x.com/ericzakariasson/status/2115586309096083730

### 3.7 X 连接器与 X 插件（official）

- 8 月 29 日的官方文章说：用 X 连接器登录后，可以搜帖子、读时间线、查被提及记录、汇总 X 上的动态；单独的 X 插件可以搜帖、读时间线、拉趋势、管理书签。现在的文档把插件定位为访问账号私密数据：私信、书签、主页时间线、谁点赞了你的帖子。
- 连接时如果你还没有 X 开发者账号，会自动创建一个；付费用户有起步的 X API 额度，金额没公布。插件跑在你自己的 X 开发者账号上，消耗 X API 额度，余额为 0 时要去 console.x.com 充值。官方承认起步额度不一定能自动到账。官方文章没有提到发帖等写操作。
- 第三方补充：X 连接器上线之前，要自己去开发者后台拿 bearer token（Debbie 建议预留 10 分钟或先跳过）。
- 出处：https://x.ai/news/grok-bot-and-x ；https://cursor.com/help/grok-bot/how-to ；https://cursor.com/help/grok-bot/connect-apps ；https://docs.x.ai/grok-bot/computer-and-apps ；https://debbie.codes/blog/how-to-get-started-with-grok-bot

### 3.8 X 公开内容只读检索（official）

- 不用连接 X 账号，也不消耗 X API 额度，就能搜索和阅读 X 上的公开内容：搜帖子、按链接打开帖子、读某个账号的帖子和被提及记录、看谁引用或转发了某条帖子、统计某话题近期的帖子数、看趋势和新闻。只读，不以你的身份登录。v0.70.2（10 月 11 日）加入。
- 出处：https://docs.x.ai/grok-bot/computer-and-apps ；https://cursor.com/help/grok-bot/how-to

### 3.9 Bot 专属邮箱（official）

- 是什么：为你的 Bot 领取一个「名字@mail.grokbot.com」的地址，Bot 可以用它收信、读信、搜信、发信，用于注册服务、收验证码、汇总收据和订阅邮件，以及转发邮件。
- 领取：对 Bot 说「给自己弄个邮箱」，它会问你想要的名字、查是否可用，再弹审批卡，你批准后才领取；或者在 Connect apps > Email 里选名字，点 Create address。
- 规则：每人只能有 1 个地址，不能改名也不能删除，地址永不复用。地址属于你本人，你的所有 Bot 在你的会话和 routine 里都能用，但在 Slack 线程或别人与 Bot 的对话里不能用。没有收件箱界面，也没有新邮件通知，想看邮件要问 Bot。来信只能通过 routine 触发处理，可以按任何人、指定地址或整个域名过滤，默认只处理通过邮件认证的发件人，不能按主题过滤。
- 发信：你在对话里要求发的邮件，经 Auto-review 放行后发出；routine 等其他来源产生的邮件一律停在草稿，等你按 Send。转发邮件、附件 Auto-review 读不全的邮件，总是要你批准。邮件里的指令不算你的授权。
- 限制：单封最多 50 个收件人、10 个附件（每个 10MB、合计 25MB），不能附可执行文件；对新联系人有发送数量限制；首次联系每封只能发给一个人，并自带一键退订；对方退信、退订或举报后不再发送。Cursor 团队需要管理员先在后台的 Bot Capabilities 里打开 Agent Email（默认关闭）。
- 出处：https://cursor.com/help/grok-bot/agent-email ；https://cursor.com/docs/grok-bot/teams ；https://docs.x.ai/grok-bot/computer-and-apps

### 3.10 Slack 集成（official）

- 三种结合方式：
  - 连接 Slack app，让 Bot 以你的身份读写 Slack，只能在你有权发言的频道发；用另一个工作区要单独连接。
  - routine 的 Slack 触发（与 Slack app 是两回事），前提是在拥有该 Bot 的 Cursor 账号上连好 Slack。
  - 共享 Bot 接入团队 Slack，拥有独立身份（见 9.4）。
- 个人 Bot 可以通过你自己的 Slack 私信使用，结果回到 app。routine 在某个 Slack 线程里回复后，会继续跟进这个线程，后续不需要再 @。
- 出处：https://cursor.com/help/grok-bot/shared-bots ；https://cursor.com/help/grok-bot/routines ；https://cursor.com/help/grok-bot/connect-apps ；https://x.ai/news/team-bots

### 3.11 连接器的上线时间与传闻（third-party）

- 9 月 22 日加入原生的 Google Docs、Sheets、Slides 连接器。
- 二手报道称：电脑操作类任务快了 3 倍，其他回复耗时减半；新增 Robinhood（只能在专门的 Agentic 子账户里下单）、Coinbase、Trello、PostHog、beehiiv、eToro 等连接器，以及一个可以提交自建集成的连接器市场。只见于第三方报道和论坛的 bug 帖，没有对应的官方页面。
- Zoom 授权目前报 4700 错误、无法使用，官方列为已知问题（official）。
- 出处：https://keywordseverywhere.com/news/grok-updates/grok-bot/ ；https://alphasignal.ai/news/xai-s-grok-bot-runs-tasks-3x-faster-and-trades-stocks-on-your-behalf ；https://forum.cursor.com/t/grok-bot-robinhood-agentic-trading-mcp-oauth-fails-after-allow-grokbot-callback-oauth-error/171111 ；https://cursor.com/help/grok-bot/connect-apps

## 4 常驻与后台

### 4.1 设备离线照常工作（official）

- routine 和后台任务在云端跑，你的笔记本合上、手机锁屏都照常执行，只在需要审批时推送通知。
- 出处：https://x.ai/news/introducing-grok-bot ；https://cursor.com/docs/grok-bot/work ；https://cursor.com/help/grok-bot/routines

### 4.2 Routines：定时或事件触发的例行任务（official）

- 是什么：让某一个 Bot 在指定时机运行某个流程。触发方式有：时间表；Slack 消息；GitHub、Linear、Sentry、PagerDuty 事件；发到 Bot 邮箱的邮件；webhook 调用。
- 创建：用自然语言告诉负责这件事的 Bot（官方示例大意：每个工作日 8:00 跑某个技能，把清单发在本对话；不要联系客户；源数据拿不到就报告失败，不要用旧数据）。创建后在 Bot 详情 Details 标签下的 Routines 里查看。
- 打开一条 routine 能看到 Instruction 和 When to run（用文字复述保存下来的计划，方便你核对）。webhook 类型多一个 Webhook 区，提供 POST 地址、key、header 三项，用 Bearer 方式认证；返回 200 只代表已受理，不代表已完成。
- 按钮：Pause/Resume、Test、Edit、Delete。Test 会真实执行，结果回到对话；Edit 会预填一条以「Edit your routine:」开头的消息；Delete 不可撤销。
- 时区取自 Settings > Bot > Timezone。新建的 routine 不会立即运行，要等下一个时间点。
- Slack 触发可以设为：Bot 被 @、出现某个关键词、你对消息加了表情、或任意消息；可以只盯一个频道或整个 Slack，只对触发器建立之后的新活动生效。
- 手机上可以 Add routine，查看 Active、Schedule、Next run、Run history。长时间不在时，系统可能问你是否继续运行，不回应就暂停。
- 出处：https://cursor.com/help/grok-bot/routines ；https://docs.x.ai/grok-bot/skills-routines-and-automations ；https://cursor.com/docs/grok-bot/work ；https://x.ai/bot/guides/grok-bot-101

### 4.3 Routine 的限制（official）

- 每个 Bot 最多 50 个 routine；每个 routine 只保留最近 20 次运行记录；两次运行至少间隔 5 分钟。
- 你所有 routine 合计每小时最多跑 300 次，单个 routine 每小时最多 200 次；超限报 rate limit 错误，不会自动重试。另有一个所有用户共享的全局上限，官方承认是已知问题。
- 后台任务（routine、来信、其他 Bot 发来的消息）发起的审批卡，30 分钟后过期，Bot 不会执行。
- 出处：https://docs.x.ai/grok-bot/skills-routines-and-automations ；https://cursor.com/help/grok-bot/routines ；https://cursor.com/help/grok-bot/approvals

### 4.4 Routine 的实际表现（third-party）

- Bot 有时会自己建 routine：AY Automate 的例子里，用户让 Bot 盯一个 X 账号，它就自建了每 30 分钟检查一次的任务。官方指南「Grok Bot for Work」里的 Bot Boss 案例中，几个 Bot 的 routine 创建后默认是停用状态，要手动点 Enable（这一句是 official）。
- 已知 bug（v0.29.0，8 月 28 日）：routine 显示运行成功，但结果被压在后台不发到对话里，要等你再发一条消息才出现。
- Builder.io 作者写好了一个能过滤掉约 80% 流量的过滤器却忘了打开，结果一个 Bot 每天被唤醒 500 到 750 次；额度用完后所有 routine 和 webhook 全部停摆。
- 云电脑空闲休眠会让定时任务晚 12 到 80 分钟（2.2）；长期不活跃可能自动暂停，额度用完、登录过期或来源不可达时也会停。
- 出处：https://www.ayautomate.com/blog/grok-bot-xai-ai-agents-explained ；https://x.ai/bot/guides/grok-bot-for-work ；https://forum.cursor.com/t/grok-bot-routine-marks-succeeded-but-never-posts-a-chat-bubble/169841 ；https://www.builder.io/blog/grokbot-review ；https://www.eesel.ai/blog/grok-bot-review

## 5 主动性

### 5.1 官方宣称的主动性（official）

- Bot 会跟进中断的话题、催促停滞的交接、接上早先的对话，在你开口之前就接手工作，并判断什么时候需要你注意。
- 产品层面由主 Bot 的主动建议（v0.66.0）和 routines 实现。什么时候主动出手的具体逻辑官方没有公开，目前主要是宣传层面的描述。
- 出处：https://x.ai/news/introducing-grok-bot ；https://docs.x.ai/grok-bot/bots

### 5.2 主 Bot（official）

- 是什么：你的主要联系人，会主动来找你，并协调你的其他 Bot。首发公告的说法是一个 chief of staff Bot 统管收件箱、报销、招聘、修 bug、运营等专职 Bot。
- 怎么用：还没有主 Bot 时，会出现「Introducing your primary Bot」引导，可以选 Create primary Bot 新建，或 Choose an existing Bot 选一个已有的再 Confirm。主 Bot 在侧栏带星标，右键「Replace with different Bot」可以更换（手机上是「Replace Primary Bot…」）。共享 Bot 不能当主 Bot。
- 从 v0.66.0（约 10 月 2 日）起，主 Bot 会主动发现可以替你接手的工作并提出来。从其他 AI 助手导入的记忆、在 X 上 @bot 派的任务，都交给主 Bot。
- 上线日期说法有三种：9 月 30 日（Flavio 截图）、10 月 1 日、10 月 2 日（见存疑 9）。
- 出处：https://docs.x.ai/grok-bot/bots ；https://x.ai/news/introducing-grok-bot ；https://flaviocopes.com/grok-bot/ ；https://digg.com/ai/0l4r5btp

### 5.3 实测可靠性（third-party）

- 一位 X 作者实测主 Bot 主动联系的频率很低。
- Builder.io 作者发现，跟进全靠模型自己决定要不要盯、记不记得回报；Bot 说「稍后回复你」之后经常就没了下文。某天有 24 个编码线程完成，Bot 准时报了 17 个、迟报 3 个、漏报 4 个。
- Alarcon 的收件箱 Bot 只在需要时提醒他，语气很口语化（大意是「有 4 件事要你处理」）。
- 出处：https://youmind.com/landing/x-viral-articles/grok-bot-personal-ai-guide ；https://www.builder.io/blog/grokbot-review ；https://christopheralarcon.com/blog/grok-bot-use-cases

### 5.4 主动消息是否扣额度（third-party，单一来源）

- 一位 X 作者转述官方说法，称主动消息不消耗额度。只有这一个来源。
- 出处：https://youmind.com/landing/x-viral-articles/grok-bot-personal-ai-guide

### 5.5 订单发货、到货通知（third-party）

- 10 月 27 日的版本加入了订单发货、到货通知（3.6）。
- 出处：https://aicatchup.com/news/grok-bot-v0-78-1-shopping-subscriptions

## 6 对话线程与手机、桌面

### 6.1 以 Bot 为中心的即时通讯式界面（official，附第三方描述）

- official：交互形态就是给队友发消息，没有拖拽式的工作流编辑器。在对话里可以粘贴文本、链接、图片；附加文件；语音输入；发起语音通话；按名字调用某个技能；用 @ 提及 Bot、群、routine 或 app；回复某条消息形成线程；加表情回应；在 Bot 工作时继续发指令（你的直接消息优先于后台工作，可以改变当前任务的方向）；发「Stop now」立即停止（已经完成的动作不会撤销）。Cmd/Ctrl+K 可以跨对话搜索消息、Bot、群、文件和 routine。
- third-party：桌面端长得像 iMessage 或 Slack，而不是 ChatGPT。左栏像通讯录一样列出各个 Bot，可以建文件夹、置顶，主 Bot 单独排在最上面；点开一个 Bot 就是和它的对话线程；右侧面板放资料、电脑画面、Routine 列表和会话详情。对话按「人」（Bot）组织，不按「任务」组织。输入「/」调出技能，左下角是 Connect apps，点头像看每周用量。需要你处理时状态栏显示「Waiting for you: Approval needed」，但 80aj 实测觉得状态提示不够明显，容易误以为卡死了。10 月改版简化了右侧面板。
- 出处：https://cursor.com/docs/grok-bot/work ；https://docs.x.ai/grok-bot/chat-and-collaboration ；https://www.ayautomate.com/blog/grok-bot-xai-ai-agents-explained ；https://www.80aj.com/2026/08/19/grok-bot-review-cloud-vm/ ；https://www.woshipm.com/ai/6479246.html ；https://christopheralarcon.com/blog/grok-bot-use-cases

### 6.2 消息流里的卡片（official）

- 工具调用、电脑操作状态（带「working」字样的短语）、生成的文件、链接和页面卡片、提问卡（一张卡可以有多个问题）、审批卡、安全表单、Connect 卡、语音备忘录、Cloud Agent 卡、草稿卡，和普通消息混在一起显示。
- 生成的文件和链接以卡片出现，可以预览、保存或直接回复修改意见；Bot 更新过的旧卡片会显示「Updated below」。悬停能看发送时间，右键能复制请求编号。官方建议针对某个结果或某次审批的反馈放在线程里。
- 1:1 对话里你的消息气泡染成该 Bot 的颜色，可在 Settings > Appearance > Accent 里关掉。
- 容易混淆的几种卡：审批卡问「能不能做这个动作」；安全表单收集密码、银行卡或秘密，并存进 Vault；Connect 卡让你登录某个 app；「Grok Bot needs permission」申请手机权限；Computer「Action needed」请你接管电脑。
- 出处：https://cursor.com/docs/grok-bot/work ；https://docs.x.ai/grok-bot/chat-and-collaboration ；https://docs.x.ai/grok-bot/files-and-results ；https://cursor.com/help/grok-bot/approvals ；https://docs.x.ai/grok-bot/mobile ；https://www.gradually.ai/en/changelogs/grok-bot/rss.xml

### 6.3 打断（official，附第三方实测）

- official：你的直接消息优先于后台工作，可以改变 Bot 当前在做的事。
- third-party：Zapier 作者在 Bot 订机票的途中发了一条新消息，结果 Bot 从第一步重新开始。
- 出处：https://cursor.com/docs/grok-bot/work ；https://zapier.com/blog/grok-bot/

### 6.4 一个 Bot 一条线程，没有手动压缩（third-party）

- 每个 Bot 本质上是一条越来越长的线程，接近上下文上限时自动摘要。截至 9 月 23 日，工作人员确认没有「同一个 Bot 开新会话」、手动压缩和上下文用量表。用户只能绕开：复制 Bot 再把旧的隐藏、清空对话（Windows 0.47.0 上没有这个按钮），或者新建群聊。这个需求帖到 11 月 2 日仍在活跃。
- Zapier 和 Flavio 提到左上角有「New chat (+)」，和上面的说法冲突（存疑 11）。
- 出处：https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333 ；https://forum.cursor.com/t/grok-bot-agents-context-compaction-clone-replace-for-hung-chats-and-per-bot-usage-telemetry/173357 ；https://cellcog.ai/blog/grok-bot-problems/

### 6.5 附件与文件进出（official）

- 支持图片、音视频、PDF、Word/Excel/PowerPoint、CSV/JSON/YAML、源码、HTML、邮件文件、Jupyter notebook。
- 桌面端每条消息最多 20 个附件。图片每个 25MB、每条合计 200MB；文档和音频每个 250MB；视频每个 1GB。
- 连接 Google Drive、OneDrive、SharePoint、Gmail、Outlook 之后，Bot 能把文件在云电脑和这些账号之间搬运，不用把内容贴进对话。Google 文档、表格、幻灯片、绘图分别转成 docx、xlsx、pptx、png。存到 Google Drive 总是新建文件；存到 OneDrive 或 SharePoint 遇到同名文件，要你明确说覆盖才会覆盖。
- iPhone 可以从系统分享面板把照片、文件、链接、文字发进指定对话，Android 目前只支持文字。
- 出处：https://docs.x.ai/grok-bot/files-and-results ；https://cursor.com/docs/grok-bot/work

### 6.6 Pages：Bot 维护的可读页面（official）

- Bot 替你做的报告、备忘录、仪表盘、跟踪表、讲解页，可以有表格、图表和筛选器、开关等控件。
- 对话里提要求，Bot 做好后发来带标题和「Open」按钮的卡片。桌面打开时页面占满窗口，对话缩到侧边（标题是「Message about」加页面名），在这里继续说，Bot 就修改同一个页面。页面上的控件只改变你看到的视图，不会保存。页面收在 Bot 详情的 Library 标签里，可以置顶。
- 分享范围三档：指定的人（个人账号下只有自己）、整个团队、任何拿到链接的人；公开链接在 pages.grok.bot 域名下，打开无需登录。企业团队禁止公开分享。已分享的页面在 Cursor 后台的 Shared Canvases 里统一管理。
- 要求桌面 0.60.0、手机 1.14.0 及以上，目前灰度发布，企业团队暂不可用。第三方称随 v0.75.2（10 月 22 日）发布，你说「每周一早上 8 点更新」时 Bot 会自己建 routine 定期刷新。版本要求与更新日志对不上（存疑 12）。
- 出处：https://cursor.com/help/grok-bot/pages ；https://docs.x.ai/grok-bot/files-and-results ；https://teslanorth.com/2026/10/27/elon-musk-grok-bot-pages-vault-video/

### 6.7 图片和视频生成（official）

- 只在你要求时才生成。图片比例有 1:1、4:3、3:4、16:9、9:16；图表类需求请改用 Pages。
- 视频可以从文字生成，也可以用一张图做首帧、两张图做首尾帧（用同一张图可做循环），或提供最多 14 张参考图；另外可指定最多 4 张图在视频特定时刻出现。时长 1 到 15 秒，默认 6 秒；默认 480p，可要求 720p；参考图格式 JPEG、PNG、WebP，合计约 35MB；输出 MP4。
- 要展示真实的人、地点或商品时，Bot 会去找真实图片而不是生成。涉及商标角色、品牌或真人的请求常被内容规则拦截。生成结果收在 Library 里。
- 第三方补充：图片和视频交给并行的子代理生成，不打断主任务（10 月 22 日起）。
- 出处：https://cursor.com/help/grok-bot/create-media ；https://docs.x.ai/grok-bot/files-and-results ；https://teslanorth.com/2026/10/27/elon-musk-grok-bot-pages-vault-video/

### 6.8 语音：听写、实时通话、语音备忘录（official）

- 听写：桌面点「Start voice input」或按 Cmd/Ctrl+D（也可按住说话），手机点「Start dictation」。
- 实时通话：输入框为空时点波形按钮「Start voice chat」。通话中可以静音、挂断、打开实时字幕，在设置里调音色、语速、语言。同一时间只能有一通电话。挂断后对话里出现带时长的「Voice chat」卡片，可读完整转录，Bot 可能在对话里跟进待办，也记得之前的通话内容。群聊不能语音。桌面上可以和同事共享的 Bot 通话。Grok Voice 3.0 驱动语音模式（10 月 14 日）。
- 发布时没有实时语音对话（第三方）。
- 出处：https://cursor.com/help/grok-bot/voice-chat ；https://docs.x.ai/grok-bot/chat-and-collaboration ；https://x.ai/news/grok-voice-3 ；https://www.dailydoseofds.com/p/grok-bot-masterclass/

### 6.9 通知与待办状态（official，附第三方问题）

- official：侧栏把 Bot 分成三种状态：需要你处理（有提问、审批或交接）、有未读结果、正在工作。Bot 完成工作或在等你时发系统通知或手机推送。每个 Bot 可以单独开关通知：手机上在 Bot 资料页开关，桌面上要让 Bot 自己去开关。macOS 或 Windows 桌面正在使用时，通知优先发到桌面；需要你输入的事项约 3 分钟后再推到手机。群聊没有单独的通知开关，隐藏的 Bot 不发通知。报错显示在输入框上方的 Notifications 区域，可以点 Copy request ID 复制请求编号给客服。
- third-party：额度用完时曾经静默失败（Bot 图标闪 3 秒就消失，既不回复也不提示），10 月 30 日才修成明确的额度提示。
- 出处：https://docs.x.ai/grok-bot/settings-and-notifications ；https://cursor.com/docs/grok-bot/settings ；https://cursor.com/help/grok-bot/how-to ；https://forum.cursor.com/t/grok-bot-icon-flashes-3-seconds-then-no-reply/171588

### 6.10 手机 App（official）

- 独立的手机 App，与桌面连同一批 Bot、对话、routine、连接器和同一台云电脑，用来在外面派活、回答问题、审批、看结果。iOS 18 及以上（也能在 iPadOS 18 的 iPad 上运行），Android 9 及以上。用同一个 Cursor 账号登录，权益自动带过来。
- 手机上可以：发文字、语音输入、语音通话、听语音备忘录、拍照和发附件、@、回复线程、加表情；查看和接管电脑（输密码、两步验证码、过验证码，完成后点 I'm done）；点开审批卡看完整请求；暂停、恢复、新增 routine，看 Run history；搜索，看 Library 和 Pages，编辑 Bot 资料。
- 手机能力：在你和自己 Bot 的一对一对话里、并且 App 在前台打开时，Bot 可以用日历（可读写，但不能改重复日程、不发邀请）、通讯录（只读）、位置（只给坐标）、闹钟和计时器（24 小时内，不能查看或取消）；iPhone 另有提醒事项和 Apple Home（灯、门锁、车库门、安防等）。第一次使用会弹「Grok Bot needs permission」权限卡。
- 手机上不能做：演示教学、测试 routine、更新或恢复电脑、重命名 Page、拿到 Microsoft 管理员审批链接、连接部分 app（Adapter、Robinhood、Intercom，以及 iPhone 上的 Postiz）；从 1.19.0 起也不能新建群聊（与另一份文档冲突，见存疑 10）。
- 侧栏分区在桌面和 iOS 之间同步；Mac 和 iOS 共用同一个用量额度。
- 第三方补充：Android 版约 9 月 2 日上架；10 月起 Android 上可以把它设为系统默认助手；80aj 在 8 月实测时认为移动端功能有缺失；论坛上有 Android 和 iOS 上「所有 Bot 都不回复」的报告。
- 出处：https://docs.x.ai/grok-bot/mobile ；https://cursor.com/help/grok-bot/mobile ；https://cursor.com/docs/grok-bot/get-started ；https://cursor.com/help/grok-bot/group-chats ；https://cursor.com/help/grok-bot/connect-apps ；https://cursor.com/help/grok-bot/plans ；https://forum.cursor.com/t/grok-bot-is-now-live-on-android/170384 ；https://teslanorth.com/2026/10/20/grok-bot-x-dms-android-assistant/

### 6.11 iPhone 独有（official）

- 从系统分享面板把内容发到指定对话。
- Siri、Spotlight、快捷指令有 List Bots、Send Message、Start Dictation、Start Voice Chat 四个动作。
- Action Button 可以设成一键和 Bot 通话，再按一次挂断。
- 听写和通话期间，锁屏和灵动岛显示 Live Activity。
- 出处：https://docs.x.ai/grok-bot/mobile

### 6.12 桌面 App（official）

- 主客户端，支持 macOS（Apple 芯片和 Intel）、Windows（x64 和 Arm64）、Linux（x64 和 Arm64，提供 deb、rpm、AppImage），负责聊天、审阅和审批；Bot 的实际工作在云电脑上完成。
- 下载：Cursor 后台 Grok Bot 页的 Download Grok Bot、cursor.com/download/bot，或 x.ai/bot。登录用 Cursor 账号在浏览器里完成；Grok Business 席位用户选 Sign in with Grok。
- 快捷键：Cmd/Ctrl+N 新建 Bot、Cmd/Ctrl+Shift+N 新建群、Cmd/Ctrl+K 搜索、Cmd/Ctrl+L 把选中文字引用进输入框、Cmd/Ctrl+/ 查看全部快捷键。界面支持 37 种语言。支持多账号切换。
- 更新：自动更新在你离开时安装（锁屏且空闲 10 分钟以上）；版本旧于 14 天且有新版时强制更新；管理员不能关闭桌面端的自动更新检查。Settings → Updates 里有 Stable 和 Nightly 两个通道（第三方）。
- 设置面板（账户菜单或 Cmd/Ctrl+, 打开）：General 下有账户、外观（主题、配色、37 种语言、拼写检查）、系统（麦克风、硬件加速）、Bot（时区、Auto-review 开关和自定义规则）、记忆导入、硬件安全密钥、共享 Bot（关联 Slack、清除连接器偏好）；Computer 下有 Your computer（本机执行权限、本机出网、设备管理）和 Bot's computer（Update、Reset）；另有 Vault、Usage & Billing、Updates。没有模型选择器。
- 出处：https://cursor.com/docs/grok-bot/settings ；https://cursor.com/docs/grok-bot/deployment ；https://docs.x.ai/grok-bot/chat-and-collaboration ；https://cursor.com/help/grok-bot/how-to ；https://docs.x.ai/grok-bot/faq ；https://docs.x.ai/grok-bot/settings-and-notifications

### 6.13 App 之外的入口（official）

- X Chat：在 X App（iOS、Android）和 x.com 的 X Chat 里，可以和 Grok Bot App 里同一批 Bot 对话。灰度上线，需要最新版 X App；计划要包含 Grok Bot（The X Subscription 的 Premium、Super、Ultra，Plus 不含），并且 Grok 账号已关联 Cursor 账号；只支持个人账号（公司托管邮箱、团队里的 Cursor 账号、旧版按请求计费计划都不行）。看到陌生 Bot 或「Something went wrong」，通常是 X 连到了另一个 Grok 账号，要在 accounts.x.ai 和 x.com/i/jf/grok/entry 重新关联。
- 在 X 上 @bot 派活：在帖子或回复里 @bot，就把这条帖子作为任务交给主 Bot；@bot 在 X 上公开回复一句确认，实际工作和结果留在 App 里。前提：Grok 账号已连接 X、有 Grok Bot 权限、至少有一个自己的 Bot（共享 Bot 不能接）、X 账号所在地区可用。Bot 收到你的帖子、你回复的那条帖子、以及它们引用的帖子（包括其中的静态图片）。第一次使用时，X 会提示这类请求会自动开始工作并消耗用量。以下情况 @bot 不回复：所在地区不可用（澳大利亚、英国、欧盟、冰岛、列支敦士登、挪威，按 X 登记的国家判断，用 VPN 也没用）；在已有 @bot 的线程里回复但自己没 @；同时 @ 了 grok；帖子含视频或 GIF；没通过审核；账号没关联或用量已用完。
- Slack：个人 Bot 通过你自己的 Slack 私信；共享 Bot 有独立身份，可以在频道里被 @（3.10、9.4）。
- Bot 邮箱：来信只能经 routine 处理（3.9）。webhook：外部系统 POST 触发 routine（4.2）。
- 出处：https://cursor.com/help/grok-bot/x-chat ；https://docs.x.ai/grok-bot/chat-and-collaboration ；https://docs.x.ai/grok-bot/tag-on-x ；https://docs.x.ai/grok-bot/overview ；https://docs.x.ai/grok-bot/troubleshooting ；https://docs.x.ai/grok-bot/faq

### 6.14 X 私信与打电话（third-party）

- 10 月 20 日起 Bot 能读写 X 私信，有防刷屏限制。
- 10 月 25 日 Musk 宣布 Bot 可以替你给个人或商家打电话，边打边记，结束后给书面摘要。Techloy 记者在尼日利亚实测一次都没打出去，提示只支持在美国境内（华盛顿州和伊利诺伊州除外）拨打美国号码；10 月 26 日的 0.77.0 更新日志没提打电话。
- 出处：https://teslanorth.com/2026/10/20/grok-bot-x-dms-android-assistant/ ；https://teslanorth.com/2026/10/25/grok-bot-phone-calls-elon-musk/ ；https://www.techloy.com/grok-bot-review-free-trial/

### 6.15 幻灯片（third-party）

- v0.68.1 起能做幻灯片，以 PowerPoint 或 Google Slides 交付。官方用例里的 Presentation Designer 按你的母版生成风格统一的演示文稿，返回可编辑链接。产品文档里没有专门的说明页。
- 出处：https://www.gradually.ai/en/changelogs/grok-bot/rss.xml ；https://x.ai/bot/use-cases

## 7 审批与安全

### 7.1 Auto-review 与审批卡（official）

- 一个独立的审查模型在 Bot 执行动作之前检查：shell 命令、app 调用、电脑操作、修改 routine 或触发器、委派给 Cloud Agent 或子代理。结果三种：直接放行、要你批准、拒绝。默认开启。可以关掉，关掉后动作不经检查直接执行，但内置的安全检查仍然有效。
- 审批卡标题是「Review an action」，列出要执行的操作和输入参数，可能带警示（「这一步不可撤销」「会修改登录或安全设置」「会把数据分享到本对话之外」）。
- 按钮：普通卡是「Allow once / Always allow / Deny」，Always allow 会存成一条 Allow 规则，卡上显示「Saved to Custom Rules」，Deny 之后在你发下一条消息之前 Bot 不再尝试；终端命令卡是「Allow / Skip / Manage settings」；被 Ask first 规则拦下的卡是「Allow / Not now / Edit rule」。手机上要点开卡片才看到完整请求和全部按钮。
- 审查时只把你本人发的消息当作授权，邮件或网页里的文字不算。
- Auto-review 不检查记忆写入和大部分设置变更。它本身也是模型判断，官方说它只能作为最小权限和明确边界的补充，不建议写「浏览器里一律放行」这类宽泛规则。
- 出处：https://cursor.com/help/grok-bot/approvals ；https://cursor.com/docs/grok-bot/security ；https://docs.x.ai/grok-bot/approvals-security-and-privacy ；https://cursor.com/help/grok-bot/how-to

### 7.2 审批卡的有效期（official）

- 从对话发起的任务，审批卡会一直等你。
- 后台任务（routine、来信、其他 Bot 发来的消息）发起的审批卡，30 分钟后变成「Expired」，Bot 不会执行；过期卡上仍可以点「Always allow next time」。
- 你发一条新消息，或者改了 Auto-review 设置，都会关掉还没回答的卡。
- 出处：https://cursor.com/help/grok-bot/approvals ；https://cursor.com/help/grok-bot/how-to

### 7.3 自定义规则（official，附冲突说法）

- 在 Settings > General > Bot > Custom Rules 里用自然语言写，格式是「When Grok Bot wants to …」加上「Allow automatically」或「Ask first」，再点 Add Rule。两类规则冲突时 Ask first 优先。
- 两类规则各最多 20 条，每条不超过 1000 个字符；Allow 规则满 20 条时，再点 Always allow 会挤掉最旧的那条并告诉你。
- 官方说规则在桌面和手机之间同步；第三方（Daily Dose of DS）说个人规则只存在当前这台桌面电脑上，换电脑要重新检查（存疑 16）。
- v0.75.8（10 月 24 日）起，Bot 能主动提议修改规则（第三方转载的更新日志）。
- 出处：https://cursor.com/help/grok-bot/approvals ；https://cursor.com/docs/grok-bot/security ；https://www.dailydoseofds.com/p/grok-bot-masterclass/ ；https://www.gradually.ai/en/changelogs/grok-bot/

### 7.4 外发草稿（official）

- Bot 准备发出的邮件或 Slack 消息，默认先做成可编辑的草稿卡，标着「Needs approval」，你审过收件人和正文再发。按钮是「Send」（Slack 草稿为「Send message」）和「Discard」，可以直接改收件人和正文。
- 对某一个 Bot 可以选「Disable drafts for Bot」，让它直接发送：仍受 Auto-review 约束，只对这个 Bot 生效，只有拥有者能看到这个选项，群聊里不提供；点草稿卡上的「Needs approval」可以恢复草稿模式。
- 不是你在对话里要求发的邮件（例如 routine 产生的邮件），一律停在草稿，没有无人值守自动发送的选项。
- 第三方补充：老章转述的官方演示里，邮件卡按钮是「Send email / Discard」；Zapier 实测 Gmail 发送前能预览。
- 出处：https://docs.x.ai/grok-bot/chat-and-collaboration ；https://cursor.com/help/grok-bot/agent-email ；https://www.woshipm.com/ai/6479246.html ；https://zapier.com/blog/grok-bot/

### 7.5 群聊、Slack 和共享 Bot 里的审批（official，两处文档冲突）

- 「Approvals」帮助页：群聊里只有被回答的那个人能批，其他人能看到这张卡在等谁，并且不提供 Always allow。Slack 线程里是同名卡片，按钮是 Allow once、Deny、View details，只有提问的人能点。
- 「Message and collaborate」文档页：审批、秘密或登录请求、邮件或 Slack 草稿都不会出现在群里（存疑 8）。
- 共享 Bot 在你自己的对话里要用你的个人账号之前，会弹「Allow 某 app」卡（Allow once / Always allow / Skip）。第三方补充：Always allow 可以选「只对这个 Bot」或「对所有共享 Bot」（Flavio）；Matt Palmer 的视频里出现过「Allow for this channel」。
- 出处：https://cursor.com/help/grok-bot/approvals ；https://docs.x.ai/grok-bot/chat-and-collaboration ；https://cursor.com/help/grok-bot/shared-bots ；https://flaviocopes.com/grok-bot/

### 7.6 审批在实践中的漏洞（third-party，附推断）

- 论坛工作人员确认：「Always allow」存下来的是一段文字说明，不是逐工具的权限开关；严格的逐工具审批没有时间表。点过 Always allow 的同类动作仍可能再次弹卡，9 月 24 日确认为已知问题。
- Zapier 实测编辑 Google Docs 时没有任何审批；Techloy 只给发邮件设了规则，结果 Bot 加日历事件、改 Google 文档都没问。
- inferred：Auto-review 是「模型判断 + 自然语言规则」，不是硬权限，所以同类动作可能重复弹卡，也可能该拦的没拦住。
- 出处：https://forum.cursor.com/t/auto-review-still-prompts-after-always-allowed-standing-approval/172859 ；https://zapier.com/blog/grok-bot/ ；https://www.techloy.com/grok-bot-review-free-trial/ ；https://www.eesel.ai/blog/grok-bot-review

### 7.7 隔离边界（official）

- 每个用户一台 Firecracker 微虚拟机，用户之间硬件级隔离。但同一个用户的所有 Bot 共用一台电脑、同一套文件、浏览器登录和命令行凭据。官方明确说不要把不同 Bot 当成安全边界，需要独立凭据的工作应该另开一个 Cursor 用户。服务条款也写明同一用户下的 Bot 不能被视为相互独立的安全边界。删除 Bot 不会清掉电脑上的文件和登录状态。
- 第三方补充：有商业用户给每个 Agent 建了单独的 Chrome 配置，结果这些配置每天被重置，还频繁崩溃；删除 Bot 后要彻底清理，得手动走六步（包括逐个网站退出登录）。
- 出处：https://cursor.com/docs/grok-bot/teams ；https://cursor.com/docs/grok-bot/security-faq ；https://cursor.com/terms/grok-bot ；https://www.eesel.ai/blog/grok-bot-review ；https://www.dailydoseofds.com/p/grok-bot-masterclass/

### 7.8 身份与凭据（official）

- Bot 没有自己的身份，一律以登录的用户身份行事，权限不会超过这个人。默认没有任何访问权，只能用你登录或连接给它的账号。
- 连接器的 OAuth token 存在 Cursor 后端，不落到云电脑上。Vault、安全表单、1Password 填进去的值不经过模型；API key 用打码的密钥卡输入；不要在对话里贴密码或验证码。
- 例外：团队统一管理的连接器，可能使用团队或服务账号的凭据。
- 出处：https://cursor.com/docs/grok-bot/security ；https://x.ai/news/grok-bot-for-enterprise

### 7.9 外部内容与提示注入（official，附第三方测试）

- 网页、app 返回结果、命令输出、邮件等外部内容，交给模型时被标记为不可信数据。Auto-review 只把你本人的消息当作授权，邮件里的指令不算发信许可。防护是分层的：Auto-review、网络策略、逐个动作的审批、用户隔离，企业版还可以加 Inference Hooks。官方明确说这些只能降低风险，不能消除。
- 第三方：Techloy 在邮件里埋的隐藏指令被全部识破，同样的测试 OpenClaw 没通过。
- 出处：https://cursor.com/docs/grok-bot/security ；https://cursor.com/help/grok-bot/agent-email ；https://www.techloy.com/grok-bot-review-free-trial/

### 7.10 支付风险（official，附冲突）

- Vault 里存的卡结账时自动填写，没有任何设置能要求每次都审批；想逐笔审批，就不要把卡存进 Vault。1Password 不负责填银行卡。
- 服务条款要求用户为 Bot 自主操作产生的费用负责，并自行设置花费上限。
- 冲突：v0.78.1 的更新日志说从商品卡片点「Buy now」下单要你批准（第三方转载），与 Vault 指南「保存的卡自动填写、不逐次询问」不一致（存疑 17）。
- 出处：https://docs.x.ai/grok-bot/vault ；https://cursor.com/terms/grok-bot ；https://cursor.com/help/grok-bot/connect-apps ；https://aicatchup.com/news/grok-bot-v0-78-1-shopping-subscriptions

### 7.11 没有演练沙箱（official，附第三方）

- routine 的 Test 会真实执行：真的访问网站、改文件、调用连接器，测试时只能用安全的输入。批准后已经完成的动作无法撤销，按 Stop 也不会回滚。
- 出处：https://cursor.com/help/grok-bot/routines ；https://cursor.com/docs/grok-bot/work ；https://www.dailydoseofds.com/p/grok-bot-masterclass/

### 7.12 共享与模板的风险（official）

- 共享 Bot 的拥有者添加的 secrets、apps、文件，所有使用者都能用。模板的公开链接会暴露 Bot 的身份、描述、技能和 routines，分享前要去掉 API key、内部网址和客户数据。别人的模板要像评估第三方软件一样先审再装。
- 出处：https://cursor.com/help/grok-bot/shared-bots ；https://docs.x.ai/grok-bot/bots ；https://x.ai/bot/guides/templates-for-grok-bot

### 7.13 服务条款要点（official，2026-10-31 版）

- 用户须年满 18 岁。
- Bot 的自主操作（无论是否出于本意）由用户承担全部责任；提供方只对自身的重大过失或故意不当行为负责，服务按现状提供。
- 审批功能只是辅助手段，不会撤销已经完成的动作。
- 禁止用通话功能做营销外呼、群呼、欺诈、骚扰、冒充他人或拨打紧急服务。
- 提供方有权删除内容或禁用某些动作。
- 出处：https://cursor.com/terms/grok-bot

## 8 记忆与教学（routine）

名词先说清：Grok Bot 里的「routine」是定时或事件触发的运行（第 4 节）；「skill」是可复用的做法；「Teach a task」演示一遍后生成的是草稿 skill。首发公告的说法是「看一遍就存成 routine 并自主运行」，现在的文档改成了「生成需要补完的草稿 skill」。build-spec 里的「套路（routine）」对应的是这里的 skill 加 Teach a task。

### 8.1 记忆（official）

- Bot 会自动保存长期有用的信息：你的工作偏好、你要求它遵守的规则、关于你的事实（如姓名、时区）、按日期记录的工作日志。登录信息、银行卡、联系方式放在 Vault，不进记忆。
- 保存什么由 Bot 自己判断，不会先问你；它常在回复里提一句，但不保证每次都显示。想确保它记住，就直接说「记住……」。
- 每个 Bot 的记忆是独立的，覆盖它的所有对话（包括语音通话）；只有少数个人事实（姓名、时区）在你所有的 Bot 之间共享。
- 个人 Bot 没有记忆列表界面，要靠对话查看、纠正、删除，例如问「你记得我什么」、说「那条已经过时了」「忘掉……」。
- 重置对话不清记忆；删除 Bot 会删掉它的记忆。在群聊里，你的 Bot 可能用到你们私聊的内容，不想带进去要提前叮嘱。
- 共享 Bot 可以保存团队层面的知识并告诉你，但不会把你的个人信息存给团队。官方文档也提醒记忆里可能有过时的假设。
- 出处：https://cursor.com/help/grok-bot/memory ；https://docs.x.ai/grok-bot/bots ；https://docs.x.ai/grok-bot/settings-and-notifications

### 8.2 记忆的实现细节与争议（third-party）

- Builder.io 作者直接读了记忆文件：每轮对话后后台更新一份画像，上限约 100 条事实、4000 字符；另有一些很快就会淡出的短期笔记。只有这一个来源。
- 能否查看和删除说法不一：Kevin Stratvert 的教程说可以让 Bot 列出它记住的全部内容；老章转述的官方演示说可以让 Bot 忘掉某个作废项目留下的习惯；Vellum 说没有记忆管理界面，也没有导出或 API，单条记忆无法查看、修改或删除（存疑 14）。
- DataCamp 作者的做法：不让记忆保存会变的事实，而是写进 `/workspace` 下的文件，让 Bot 每次运行前先读。
- 出处：https://www.builder.io/blog/grokbot-review ；https://www.vellum.ai/blog/official-grok-bot-breakdown ；https://dicloak.com/video-insights-detail/grok-bot-tutorial-for-beginners ；https://www.woshipm.com/ai/6479246.html ；https://www.datacamp.com/tutorial/grok-bot-tutorial

### 8.3 从其他 AI 助手导入记忆（official）

- Settings > General > Import：把给出的提示词发给另一个助手，再把它的回答粘贴回来，点「Add to Memory」。导入内容交给主 Bot。
- 出处：https://docs.x.ai/grok-bot/settings-and-notifications ；https://docs.x.ai/grok-bot/bots

### 8.4 Skills 技能库（official，附第三方做法）

- 是什么：可复用的「某件事怎么做」的说明，包含步骤、判断规则、输出格式和安全边界。私有技能是一个库，你所有的 Bot 都能用（但 Bot 可能还需要对应的 app 或登录）。
- 怎么用：一次任务跑通后，对 Bot 说「把刚才的流程存成名为 X 的 skill，写清数据源、风险定义、输出格式，以及联系客户一律要审批」。使用时点名或用「/」、@ 调用。Bot 找不到某个私有技能时，到 Connect apps 的已连接计数里为当前 Bot 启用它。
- 团队：成员可以把技能 Publish 给团队（发布前必须写描述），之后用 Sync 推送更新，也可以 Copy link 或 Unpublish。随 app 或模板一起来的技能不能发布。
- 第三方做法：先手动把任务跑通、纠正到满意，再让 Bot 存成技能；技能要窄，一类来源、一种输出、一个审批边界。存好的技能会显示输入和校验规则，之后可以让 Bot 接着改；在「/」菜单里找不到时，去 Settings → Plugins → Yours 启用。技能不是用户能直接打开检查的文件。Builder.io 作者吐槽每个 Bot 都能看到全部技能。中文社区作者建议去 GitHub 找现成的领域技能装进 Bot。
- 出处：https://docs.x.ai/grok-bot/skills-routines-and-automations ；https://cursor.com/docs/grok-bot/work ；https://www.datacamp.com/tutorial/grok-bot-tutorial ；https://www.dailydoseofds.com/p/grok-bot-masterclass/ ；https://www.builder.io/blog/grokbot-review ；https://youmind.com/landing/x-viral-articles/grok-bot-personal-ai-guide

### 8.5 演示教学 Teach a task（official，附第三方界面细节）

- official：不用逐条写步骤，自己在浏览器里做一遍，Bot 把过程整理成一个草稿 skill。在一对一对话里打开电脑视图，点「Teach a task」，先描述要演示的结果，然后操作一遍，停止录制，审阅生成的 skill，在安全的样本上测试后再排期。录的是可见的电脑操作，最长 10 分钟，不录麦克风。生成的只是草稿，需要你补上判断规则、失败处理和审批边界。只能在桌面端用，并且是灰度发布；没有这个入口时，可以让 Bot 根据书面说明和已完成的任务来写技能。
- third-party：入口位置说法不一（Zapier 说在输入框的「+」菜单里，电脑画面右上角也有录制键；视频教程说 Mac 上有按钮，Windows 界面不一样）。录制时屏幕顶部出现绿色横幅「<Bot 名> is watching and learning」并带计时；录完生成一份步骤清单式的草稿技能，存进技能库。网站一改版，技能就会失效，要重新测试。主要卖点是能自动化没有 API 的老系统。
- 出处：https://cursor.com/docs/grok-bot/work ；https://docs.x.ai/grok-bot/skills-routines-and-automations ；https://x.ai/news/introducing-grok-bot ；https://x.ai/news/grok-bot-more-plans ；https://zapier.com/blog/grok-bot/ ；https://www.woshipm.com/ai/6479246.html ；https://www.layer3labs.io/guides/grok-bot-teach-a-task

### 8.6 官方推荐的「教会一件事」的顺序（official）

1. 在对话里做一次真实的一次性任务，只读、只出草稿。
2. 反复纠正，直到结果不需要你在旁边解释也能被审阅。
3. 让 Bot 把方法存成 skill，或者在桌面用 Teach a task 亲自演示一遍。
4. 在第二个安全的输入上测试。
5. 用自然语言让负责的 Bot 建 routine，确认六件事：哪个 Bot 负责、时间和时区、输入来源、预期结果、审批边界、数据缺失时怎么办（报告并停下，而不是反复重试）。
6. 打开 routine 核对「When to run」，点 Test（会真实执行），再观察第一次正式运行。

发送、购买、删除、发布、改生产环境，始终放在审批之后。官方原则是先自动化准备工作，再自动化执行。官方用例的起手提示词都停在一个审阅点上（只出草稿或清单，不发送、不购买）。

出处：https://cursor.com/docs/grok-bot/use-cases ；https://docs.x.ai/grok-bot/skills-routines-and-automations ；https://x.ai/bot/use-cases

### 8.7 Bot 自己改进技能（third-party）

- MindStudio 观察到，Bot 跑完技能后自己发现了一处歧义（分不清帖子是否已经点过赞），并主动改写了技能说明。
- 出处：https://www.mindstudio.ai/blog/grok-bot-setup-guide/

### 8.8 团队共享记忆的审核（official）

- Data Bot 的例子里，Manager 要先审核提议的共享记忆，通过后才对全队生效。这个审核界面是否对所有团队开放不明确（存疑 24）。
- 出处：https://x.ai/news/data-bot

## 9 多 Bot 协作

### 9.1 Bot 之间交接工作（official）

- 一个 Bot 可以异步给另一个 Bot 发消息，对方被唤醒、处理完再回复，交接过程在对话里看得到（被叫到的 Bot 线程里会出现一条简短确认，第三方补充）。Bot 还能在共享上下文的线程里对齐共用的账号或项目，也能建议甚至直接创建新的专职 helper Bot。
- 适合的场景：一个 Bot 管数据源、另一个管交付物；需要专家复核；阻塞点属于另一个角色。官方建议每个阶段只设一个负责人，并行交接容易重复劳动、消息嘈杂。
- 交接要求 Bot 当时代表某一个具体的人：在 App 里或你自己的 Slack 私信里，任何 Bot 都能交接，回复回到 App；个人 Bot 在 Slack 频道线程里不能交接；共享 Bot 在 Slack 线程或私信里可以代表 @ 它的人，交给这个人自己的 Bot，结果回到同一线程。
- 没有开关能禁止 Bot 互相发消息，只能靠指令约束。Bot 之间的消息也计入用量。Bot 靠彼此的描述判断该把请求转给谁（第三方）。
- 出处：https://docs.x.ai/grok-bot/chat-and-collaboration ；https://cursor.com/help/grok-bot/group-chats ；https://x.ai/news/introducing-grok-bot ；https://cursor.com/docs/grok-bot/work ；https://www.mindstudio.ai/blog/grok-bot-setup-guide/

### 9.2 群聊（official，附第三方）

- official：把 2 到 6 个 Bot 放进同一个对话，共享一个目标，交接过程可见；Bot 之间传递工作、分配负责人，只把需要判断的问题升级给你。桌面点「New chat」、按 Cmd/Ctrl+Shift+N，或在命令面板选「New group chat」；在「To:」里加 Bot，系统自动起名（可以改），再描述共同目标和下一步谁负责（官方示例大意：@Researcher 收集资料并附出处，@Writer 写成发布稿，@Reviewer 对照来源只列阻断问题，什么都不要发布）。正常发言让 Bot 自己决定谁来回答；@ 指定某个 Bot；点某条消息的 Reply 只回复它；@everyone 用于全员通知。你在群里的消息可以带附件，Bot 在群里的交接消息只能是文字。群聊没有单独的通知开关，不能语音。同事共享给你的 Bot 可以拉进群，但它不能和跑在你自己电脑上的 Bot 同在一个群。Bot 可能在自己的 1:1 对话里私下找你或找别的 Bot；想让它只在群里说话，可以告诉它「在群里回复」并让它记住。
- third-party：每个 Bot 都会读每条消息、各自回复，Bot 之间还会聊起来；中文作者建议日常用私聊，复杂项目才建群，做完就让 Bot 退群。Zapier 作者的研究 Bot 向选题 Bot 要题目，拿到 3 个后自己挑一个开工；Create With 的 Kieran Ball 看到两个 Bot 自己商量着解决了回滚问题。社区指南里有人为每个项目开一个群，配一个负责 PM 的 Bot 和 Notion 任务看板。
- 出处：https://docs.x.ai/grok-bot/chat-and-collaboration ；https://cursor.com/help/grok-bot/group-chats ；https://cursor.com/docs/grok-bot/work ；https://x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots ；https://zapier.com/blog/grok-bot/ ；https://www.createwith.com/blog/we-both-tried-grokbot-we-disagree ；https://youmind.com/landing/x-viral-articles/grok-bot-personal-ai-guide

### 9.3 主 Bot、Chief of Staff 与 Bot Boss（official）

- 主 Bot 见 5.2。首发公告：一个 chief of staff Bot 统管收件箱、报销、招聘、修 bug、运营等专职 Bot。
- 官方用例「Chief of Staff」每天从 Slack、邮箱、日历、会议记录汇总一份带出处的摘要，每一项写清来源、为什么重要、建议的下一步、你是否欠一个决定；起手提示词要求不发消息、不改会议，先让你标注哪些有用、哪些是噪音，再排定时。
- 官方指南「Grok Bot for Work」里，作者搭了一个叫「Bot Boss」的统一入口：他只和 Bot Boss 说话，收件箱、日历、情报三个专职 Bot 向它汇报；Bot Boss 早上出全局看板、下午只报不显而易见的事，任何发送或写日历之前都等他批准。这是用户自建的用法，不是产品功能。
- 第三方补充：Debbie 的幕僚长 Bot 劝她别单独建缩略图 Bot，因为那样会多一次交接。
- 出处：https://x.ai/news/introducing-grok-bot ；https://x.ai/bot/use-cases ；https://x.ai/bot/guides/grok-bot-for-work ；https://cursor.com/docs/grok-bot/use-cases ；https://debbie.codes/blog/how-to-get-started-with-grok-bot

### 9.4 共享 Bot 与 Team Bots（official，附第三方）

- 是什么：把一个 Bot 本身（不是副本）像共享文档一样分享给整个团队或指定的人和组，大家用同一个 Bot 的技能和上下文，各自的对话互相保密。9 月 28 日以「Team Bots」名义在 Teams 和 Enterprise 计划公开 beta，预置 Customer、EPD、Marketing、Data 四个 Team Bot；后来改名 Shared Bots。
- 怎么用：点 Bot 名 → Share，在 Who has access 里选整个团队或指定的人和组。角色两种：Collaborator 只能聊天；Manager 还能改指令、技能、记忆和 apps。同事通过「+ → Browse shared Bots」找到 Bot 后点 Add。
- 共享 Bot 使用拥有者添加的 apps 和 secrets，对所有人生效。在你的对话里它通常跑在你的云电脑上；在 Slack 频道和群聊里，它用自己的一台共享电脑。回复的用量记在被回答的人头上（被回答的人没关联 Cursor 账号时记在拥有者头上）。只有拥有者能删除共享 Bot。
- Slack：拥有者或 Manager 在详情里点「Bring to your team's Slack」接入（有时要 Slack 管理员批准），同事可以私信它或在频道里 @ 它，它代表 @ 它的人办事；每个同事先在 Settings > General > Shared Bots 里点 Link 关联自己的账号；Bot 在 Slack 发的每条消息都记录是谁请求的。第三方称从 v0.77.0 起，没关联 Slack 的人不能用拥有者的登录和私有数据。
- 管理员可以在后台 Manage Shared Bots 里调整访问范围（Access 列：全队、指定人或组、仅拥有者），并用 Auto-add 把 Bot 自动加到成员侧栏（成员无法隐藏）。
- 背景（第三方）：8 月底时「分享 Bot」只是复制一份模板，各人手里的副本会越来越不一样；用户呼吁「同一套 Bot、各自私聊」之后才推出这个功能。
- 出处：https://cursor.com/help/grok-bot/shared-bots ；https://x.ai/news/team-bots ；https://x.ai/news/data-bot ；https://cursor.com/docs/grok-bot/teams ；https://sessionwatcher.com/news/xai-team-bots-shared-grok-bots-for-teams ；https://forum.cursor.com/t/shared-grok-bot-team-across-teammates-same-roster-separate-chats/169904 ；https://flaviocopes.com/grok-bot/

### 9.5 把编码任务委派给 Cursor Cloud Agents（official）

- Bot 可以把写代码的任务交给 Cursor 的 Cloud Agent，也可以发起 Project 来编排多个 Cloud Agent；Bot 自己负责外层工作：收集上下文、写清楚的提示词、跟进结果。
- Cloud Agent 完成后，Bot 把它报告里引用的图片、视频和文件复制到自己的电脑上，附在回复里；卡片上有 View PR 和 Open in Cursor。
- 101 指南的示例：每个工作日扫一遍 X 书签，挑一个技术，起草提示词；你批准后启动 Cloud Agent，完成后发截图并开 PR。SpaceXSI 内部一个 5 人团队用 Team Bot 驱动数百个 Cloud Agent，每天合并 100 多个 PR。
- 团队管理员可以关闭委派（默认开启）。
- 出处：https://docs.x.ai/grok-bot/files-and-results ；https://x.ai/bot/guides/grok-bot-101 ；https://cursor.com/docs/grok-bot/teams ；https://x.ai/news/team-bots

### 9.6 规模的实际体验（third-party）

- 一个账号里 Bot 和群加起来最多 50 个（第三方转述的文档）。
- Bot 超过 4 到 5 个后，开始出现重复劳动和刷屏（Daily Dose of DS）。
- Builder.io 作者观察到约 15% 的时候 Bot 在私聊里回复，而不是在群里；他发出的「暂停合并」指令没有传到编码线程，46 分钟后一个检查没通过的 PR 被合并了；他一周合并了 78 个 PR（之前最多 35 个），但最后还是停用了。
- 8 月有用户发现群里发的图片传不到 Bot 那里。
- 出处：https://www.dailydoseofds.com/p/grok-bot-masterclass/ ；https://www.builder.io/blog/grokbot-review ；https://www.woshipm.com/ai/6479246.html

### 9.7 多 Bot 的成本（inferred）

- 群里有 4 个 Bot 时，你说一句话大约是 4 倍消耗；往群里加 4 个 Bot 曾立刻用掉 25% 的周额度（第三方报告）。依据见 10.7。
- 出处：https://youmind.com/landing/x-viral-articles/grok-bot-personal-ai-guide ；https://www.builder.io/blog/grokbot-review

## 10 额度与套餐

### 10.1 当前套餐（official，2026-10-12 起新用户默认）

- The X Subscription：Free 免费、Plus 每月 8 美元，都不含 Grok Bot；Premium 每月 30 美元（用量是 Plus 的 4 倍）、Super 每月 100 美元（15 倍）、Ultra 每月 200 美元（50 倍）包含 Grok Bot。年付分别为 300、1000、2000 美元，团队席位按同价计。
- Grok Bot 不单独计量，和 Grok、Cursor 共用席位的每周额度池；超出后从预充值额度里扣，可以开自动充值并设月度上限。
- 出处：https://x.ai/news/x-subscription ；https://docs.x.ai/x-subscription/pricing ；https://docs.x.ai/x-subscription/usage-limits

### 10.2 旧套餐与账号关联（official）

- Cursor Pro、Pro+、Ultra 以及自助 Cursor Teams 的所有成员都包含 Grok Bot。也可以关联个人的 SuperGrok、SuperGrok Plus、SuperGrok Heavy 或 X Premium+ 订阅；自助 Grok Business 席位用 Sign in with Grok 登录。SuperGrok Lite 和 Grok Enterprise 不能关联。
- 档位对应：Pro、SuperGrok、X Premium+ 同档；Pro+ 与 SuperGrok Plus 同档；Ultra 与 SuperGrok Heavy 同档。多个来源的额度不叠加，取较高的那个。关联永久，不能解绑也不能迁移；升级后最多 24 小时生效。Cursor Enterprise 要找客户经理开通。
- 出处：https://cursor.com/help/grok-bot/plans ；https://cursor.com/help/grok-bot/supergrok

### 10.3 用量机制（official）

- 按周重置，界面上叫 Weekly usage limit，各档具体数值没有公开。旧计划用完后可以开按需付费（On-demand），受月度上限约束；这个上限不会在任务中途强行打断，正在跑的 Bot 可以略微超出。没有单独针对 Grok Bot 的花费上限。
- Grok Bot 的用量记在 Cursor 账号上，和 Grok App 里的 SuperGrok 周限额无关。8 月 26 日的官方公告说「Bot 用量独立，不占用原有 Grok 和 Cursor 计划的用量」，后来在 X Subscription 里改成了共享额度池。第三方说法也不一致（存疑 7）。
- 在头像菜单或 Settings → Usage 里看用量百分比和重置时间，在 cursor.com/dashboard/spending 加额度（第三方）。
- 出处：https://cursor.com/help/grok-bot/plans ；https://x.ai/news/grok-bot-more-plans ；https://cursor.com/docs/grok-bot/teams ；https://www.datacamp.com/tutorial/grok-bot-tutorial

### 10.4 试用（official，附第三方）

- official：试用额度按「用量」给，另有 7 天期限。消耗按 agent 执行的步数和 token 计算，一个大任务就可能用光，用掉的不退。试用结束不会自动转付费；点 Cancel Trial 后不能再领。iOS App Store 内的试用归 Apple 管，到期会自动转付费。需要绑卡（第三方）。企业：9 月 3 日起 Grok 和 Cursor 的企业客户可免费用两周，并能邀请全公司（包括没有席位的人）。
- third-party：Zapier 作者说持续使用大约一小时就见底；Debbie 两天用掉了大半；Techloy 四天里从 6% 涨到 81%。
- 出处：https://cursor.com/help/grok-bot/plans ；https://docs.x.ai/grok-bot/faq ；https://x.ai/news/grok-bot-for-enterprise ；https://zapier.com/blog/grok-bot/ ；https://debbie.codes/blog/how-to-get-started-with-grok-bot ；https://www.techloy.com/grok-bot-review-free-trial/

### 10.5 哪些操作消耗用量（official）

- 每次 Bot 回复（包括群聊里的回复和 Bot 之间的消息）、每次 routine 运行、每次 Test 都消耗。按小时跑的 routine，或者挂在繁忙 Slack 频道上的触发器，可能一天就用掉一周的额度。在 X 上 @bot 派活也消耗。共享 Bot 的回复记在被回答的人头上。
- 出处：https://cursor.com/help/grok-bot/routines ；https://cursor.com/help/grok-bot/group-chats ；https://cursor.com/help/grok-bot/shared-bots ；https://docs.x.ai/grok-bot/tag-on-x

### 10.6 实测消耗（third-party）

- 6 个 Agent 第一天用掉 42% 的周额度；Ultra（200 美元/月）用户第一到第三天依次用到 65%、84%、99%，还有人一天用完，或一周额度只够用约 8 小时；Pro+ 用户两天用到 77%；SuperGrok Plus 用户一天用完，20 美元按需额度只撑了 3 小时；API 用户 10 分钟花掉 27 美元。
- 8 月 26 日官方给全员重置过额度；9 月 10 日有用户说明显改善；9 月 17 日又有人在还剩 4 天时用完。
- Builder.io 作者的 16 个 Bot 一个周末花掉 100 美元，触顶后所有 routine 和 webhook 全部停摆。
- 一位 Ultra 用户两天用了约 2.84 亿 token，其中约 84% 是缓存读取。
- 出处：https://forum.cursor.com/t/anyone-used-grokbot-on-the-api-very-high-costs/169551 ；https://www.builder.io/blog/grokbot-review ；https://flaviocopes.com/grok-bot/ ；https://explainx.ai/blog/musk-grok-bot-serving-cost-unsustainably-high-weekly-usage-limits-what-is-verified-2026 ；https://cellcog.ai/blog/grok-bot-problems/

### 10.7 成本结构（inferred）

- 额度消耗主要取决于「Bot 被唤醒的次数 × 对话长度」，而不是你发了几条消息。
- 依据：Builder.io 指出用户消息、routine、webhook、Bot 之间的消息、后台任务，每一次唤醒都会触发一次完整的模型回合，没有输出也要花推理费；论坛用户说成本随对话长度近似平方增长，因为每轮都要重读整段历史（工作人员 8 月 26 日称这不是预期行为）；每 15 分钟跑一次的 routine 一天就是 96 次；一条疑似员工的论坛回复说闲置的对话不耗额度。
- 出处：https://www.builder.io/blog/grokbot-review ；https://forum.cursor.com/t/anyone-used-grokbot-on-the-api-very-high-costs/169551 ；https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333 ；https://flaviocopes.com/grok-bot/

### 10.8 服务成本表态（third-party）

- 11 月 1 日 Musk 在 X 上说 Grok Bot 的服务成本相对收入高到不可持续。用户反映 11 月起额度耗得更快，官方没有公布新的额度数字。
- 出处：https://explainx.ai/blog/musk-grok-bot-serving-cost-unsustainably-high-weekly-usage-limits-what-is-verified-2026

### 10.9 推荐有奖（official）

- 只有 The X Subscription 的 Premium、Super、Ultra 用户、人在美国、结账已满 7 天，才能邀请。朋友需要是 Grok 新用户、在中国以外的任意国家、结账时绑卡，可获得 2 周 Premium 试用。朋友付款 7 天后你获得一次「用量重置」，有效期 6 个月。入口：手机对话右上角的礼物图标、桌面左下角 Connect apps 旁的礼物图标，或 grok.com/dashboard/referrals。通过 App Store 或 Google Play 内购的订阅不算。
- 出处：https://docs.x.ai/x-subscription/referral-program ；https://cursor.com/help/grok-bot/plans

### 10.10 模型路由（official，附第三方）

- official：不绑定单一模型，每个任务由系统挑选最可能做好的后端模型，可能用 xAI 的自有模型，也可能用子处理方名单上的第三方模型；帮助文档提到会用到 Opus 5.5，并说明路由到它不改变每 token 的价格。没有模型选择器，也不显示每次请求用了哪个模型，用量统一记为 Grok Bot usage。团队在 Cursor 里设的模型白名单或黑名单对 Grok Bot 不生效。
- third-party：OrcaRouter 和 80aj 推测底层是 Grok 4.5；10 月 7 日 Musk 说会为每个任务挑最合适的后端模型，点名 Claude Opus 5.5、Midjourney、Suno，但 xAI 的定价页没提。用户反映简单任务也被派给重型模型，后来换成便宜模型又变笨（Reddit，经 CellCog 转述）；论坛上有用户说看到过 Sonnet 4.5 的调用。多位作者认为不能把 routine 换成便宜模型是省钱的最大障碍。
- 出处：https://cursor.com/help/grok-bot/models ；https://docs.x.ai/grok-bot/faq ；https://cursor.com/docs/grok-bot/security ；https://www.ayautomate.com/blog/grok-bot-xai-ai-agents-explained ；https://keywordseverywhere.com/news/grok-updates/grok-bot/ ；https://cellcog.ai/blog/grok-bot-problems/ ；https://forum.cursor.com/t/anyone-used-grokbot-on-the-api-very-high-costs/169551

## 11 企业管控

### 11.1 企业版的控制项（official）

- 9 月 3 日起向企业开放，提供访问、网络和审计三类管控。管理入口是 Cursor 后台的 Grok Bot 页（cursor.com/dashboard/bot），成员看不到。页面上有安装清单（推荐和可选两组）、按组授权、邀请团队、共享 Bot 管理、安全与合规、网络、电脑管理等区块；企业版还在 Members > Groups 的每个组里提供 Grok Bot 标签，给这个组单独放宽权限。按组的设置只能放宽、不能收紧（网络策略除外）。
- 主要控制项：组织级启用开关和按组授权；批量邀请；Team Rules（对所有 Bot 强制生效的自然语言规则）；强制开启 Auto-review 并配置团队级审批规则（成员那边显示「Required by your admin」，不能改也不能删）；Inference Hooks（11.3）；网络访问控制（11.2）；Team Setup Scripts 和 Team Secrets（11.4）；是否允许 sudo（默认开启）、是否允许本机出网、本机执行权限上限；Agent Email、页面分享、模板公开分享、Cloud Agent 委派、共享 Bot 管理；成员电脑与数据管理（批量重建、终止、删除，可选 30 天无消息自动终止）；动作记录；审计日志；OpenTelemetry 导出；SAML SSO 和 SCIM；Admin API 与 Organization API；Conversation Insights 统计团队拿 Bot 做什么。
- 大多数控制项只有企业版有，自助 Teams 看不到。管理员不能把连接器强制推给成员；团队的模型白名单对 Grok Bot 不生效；屏蔽某个 app 不会屏蔽它的网站，要靠网络策略。
- 出处：https://x.ai/news/grok-bot-for-enterprise ；https://cursor.com/docs/grok-bot/teams ；https://cursor.com/docs/grok-bot/security ；https://cursor.com/docs/grok-bot/computers ；https://cursor.com/docs/grok-bot/security-faq ；https://cursor.com/help/grok-bot/approvals

### 11.2 网络访问控制（official）

- 三种模式：全部放行、默认目的地加团队白名单、仅团队白名单。可以按目录组单独设置，约 1 分钟生效，可选让 MCP server 也受白名单约束。
- 出处：https://cursor.com/docs/grok-bot/teams ；https://cursor.com/docs/grok-bot/security

### 11.3 Inference Hooks（official，beta）

- 每次模型请求签名后发到你自己的 AI 安全服务器，由它放行或拒绝。新配置先以只记录不拦截的 Shadow 模式运行。
- 出处：https://cursor.com/docs/grok-bot/inference-hooks ；https://cursor.com/docs/grok-bot/teams

### 11.4 Team Setup Scripts 与 Team Secrets（official）

- 用来在每台成员电脑上装工具。Team Secrets 每个团队最多 100 个，单个值不超过 32KB，合计不超过 96KB。
- 出处：https://cursor.com/docs/grok-bot/teams

### 11.5 审计与遥测（official）

- Action Recording 记录 Bot 动作，保留 90 天，只记元数据，不存截图、键入内容或消息正文；审计日志；OpenTelemetry 导出（标记 `cursor.surface=grok_bot`）。
- 出处：https://x.ai/news/grok-bot-for-enterprise ；https://cursor.com/docs/grok-bot/teams ；https://cursor.com/docs/grok-bot/security

### 11.6 部署与数据（official）

- 只运行在 Cursor 托管的美国云上，不支持私有化部署或自有镜像，可以申请美国境内数据驻留。
- 不支持旧版隐私模式（Legacy Privacy Mode），因为需要云端存储；开启隐私模式后数据不用于训练。模型商不留存数据，但模型商的滥用检测可能保存被标记的内容。
- 没有按组织定制的数据保留策略，用户也不能自助恢复到某个时间点。服务终止后按数据处理协议在 30 天内删除或返还数据；删除账号后 30 天内清除全部数据。
- Anysphere 持有 ISO/IEC 27001 和 42001 认证，Grok Bot 在认证范围内。
- 出处：https://cursor.com/docs/grok-bot/security ；https://cursor.com/help/grok-bot/delete-account

### 11.7 早期第三方评估（third-party）

- eesel 在 8 月评估时发现：审计视图还处于「即将推出」，只有用量面板和每个 Bot 的对话记录；没有 SOC 2、ISO 27001、GDPR、HIPAA 或数据驻留方面的声明；数据必须存在云端；数据保留期限没有公开。9 月 3 日的企业版之后，官方文档补上了上面 11.1 到 11.6 的内容。
- r/singularity 的用户指出所有数据都存在 xAI 后端，而且用户没法控制推理强度（经转述）。
- 出处：https://www.eesel.ai/blog/grok-bot-review ；https://www.vellum.ai/blog/official-grok-bot-breakdown ；https://cellcog.ai/blog/grok-bot-problems/

## 12 时间线

【官方】指 x.ai、docs.x.ai、cursor.com 的页面；【第三方】指媒体、论坛、博客，以及第三方转载的官方更新日志。

- 2026 年 2 月【第三方】SpaceX 与 xAI 合并。此后第三方文章多把开发方称为 SpaceXAI，个别写作 SpaceXSI。
- 2026-06-16【第三方】SpaceX 宣布以约 600 亿美元全股票收购 Cursor 的母公司 Anysphere，8 月 14 到 15 日完成。这解释了为什么 Grok Bot 用 Cursor 账号登录、跑在 Cursor 的基础设施上。
- 发布前【官方】Grok Bot 起源于内部原型，员工用它做销售外联、营销、入职、行政和修 bug，后来在全公司推开。
- 2026-08-11【官方】beta 发布：定位为常驻 agents，桌面和 iOS 可用，企业开放候补名单。【第三方】首发当天只对 SuperGrok Heavy、Cursor Ultra、Cursor Teams Premium 开放；Android 标为「即将推出」；Musk 说先修复早期问题、发布 Grok 4.6 之后再扩大范围。
- 08-12【第三方】论坛出现大量 Bot 加载不出、初始化失败的帖子，工作人员说自发布以来负载一直很高。
- 08-13【第三方】第一批上下文和成本投诉（Health.AI 的 Michael Greenhalgh 指出每个 Bot 就是一条无限长的线程）；新西兰用户报告 AWS 美国出口被网站拦截。
- 08-14【第三方】Debbie O'Brien 发布上手教程；一位商业用户的 6 个 Agent 第一天用掉 42% 的周额度。
- 08-15 至 08-21【第三方】Cursor 曾表示持有 SuperGrok Heavy 期间 Cursor Ultra 免费；8 月 21 日宣布促销结束，引发退款争议。
- 08-17【第三方】Peter Yang 发布搭 5 个 Bot 的教程，Musk 转发。
- 08-18【第三方】Claire Vo 在 How I AI 节目里发布测评；论坛出现 runner 停摆事件。
- 08-21【第三方】开放范围扩到 SuperGrok Plus 和更多 Cursor 套餐（@bot 账号宣布，文档滞后）。
- 08-25【第三方】v0.26.0、v0.27.0：Cursor Pro、SuperGrok、X Premium+（需关联账号）用户可用；webhook 触发的 routine 能收到请求体。
- 08-26【官方】「Grok Bot is now included with more plans」：所有 SuperGrok、Cursor Pro、Cursor Teams 计划都包含 Grok Bot，Bot 有独立用量；同日 v0.28.0 新增 4 种语言。【第三方】全员周额度重置，官方承认部分情况下额度消耗过快；入门价格在大约 3 天内从 200 美元降到 60 美元，再降到 30 美元。
- 08-27【官方】指南「How I run multiple teams of Grok Bots」。【第三方】v0.29.0：设置里新增 Computer 区，本机执行有三档权限。
- 08-28【第三方】v0.30.0：模板分享（团队内或公开）、Link 支付卡、管理员可控制模板是否公开；有人报告 routine 显示成功却不发消息的 bug（v0.29.0）。
- 08-29【官方】「Grok Bot now works with X」：X 连接器和 X 插件上线，连接时自动创建开发者账号，付费用户送起步 API 额度。
- 08-30【第三方】工作人员确认「分享 Bot」当时只是复制一份模板，团队协作功能正在开发。
- 08-31【第三方】工作人员说暂时没有官方更新日志，让用户关注 X 上的 @bot 账号；之后才上线 x.ai/changelog/bot。
- 09-01 至 09-02【第三方】v0.31 到 v0.36：引导推荐 Bot、团队邀请、Link 付款、按组授权、支持更长的任务、购买被拒或过期的处理、本机执行可选「总是允许」、routine 每次运行开独立会话。09-02 Android 版上架 Google Play。
- 09-03【官方】「Grok Bot for Enterprise」：访问、网络、审计三类管控；企业客户免费用两周；点名客户 Legora、Supermicro、ServiceTitan。【第三方】同日 v0.37 到 v0.40：向所有企业团队开放、审计日志、新增语言；cursor.com 上 Grok Bot 条款的一个版本日期也是这天。
- 09-04【第三方】v0.41.0：Marketplace 上架 Bot 和插件，官方出品的 Bot 带认证标识。
- 09-06【第三方】v0.44.0：需要登录时用对话内表单收集（安全表单的雏形）。
- 09-08【官方】指南「Templates for Grok Bot」。【第三方】v0.45.0：邮件和 Slack 草稿；企业管理员可强制 Auto-review 并设团队规则。
- 09-09【第三方】v0.46.0、v0.48.0：Usage & Billing 页面、按需付费月度上限、多账号、新版 Marketplace。
- 09-10【第三方】论坛用户说 Cursor 修复后用量问题明显改善；Alarcon 公布了自己在跑的 12 个 Bot。
- 09-11【官方】指南「Grok Bot 101」。【第三方】v0.49、v0.50：代码仓库连接卡、允许云电脑流量走你本机网络。
- 09-13 至 09-14【第三方】多起「所有 Bot 都不回复」的报告，最后查明是周额度用完了，但 App 没给任何提示。
- 09-14 至 09-18【第三方】v0.51 到 v0.57：首个 Bot 自动创建、routine 可暂停和删除、Mac 版接入 1Password、可上传到 Drive 和 OneDrive、搜索面板、更多 GitHub 操作、审批卡改为一句话摘要、Projects（由 Cloud Agent 做任务规划）、语音备忘录字幕与音频同步。
- 09-22【第三方】v0.58.0：新增语言、侧栏改版、企业版可设 30 天不活跃自动终止电脑；加入原生 Google Docs、Sheets、Slides 连接器。
- 09-24【官方】指南「Grok Bot for Work」，介绍 Bot Boss 统一协调者模式。【第三方】「点了 Always allow 仍然弹卡」被工作人员确认为已知问题。
- 09-25 至 09-26【第三方】v0.59.0：Team Secrets；v0.60.0：Outlook 草稿，Marketplace 按钮改名为 Connect apps；v0.61.0：Team Bots（发布给团队、接入 Slack、按人隔离记忆）。
- 09-28【官方】「Team Bots」公告：Teams 和 Enterprise 计划公开 beta，预置四个 Team Bot。【第三方】同日 v0.62.0：引用文字、列表格式、拼写检查、Library 标签。
- 09-29 至 09-30【第三方】v0.63.0：Slack 线程里的审批卡；v0.64.0：Team Bot 可设 Manager，新增「关闭草稿」选项；v0.65.0：可以和 Team Bot 语音聊天，自动更新默认开启。
- 2026 年 9 月【第三方】上线 1Password 集成（具体日期未见）。
- 09-30 至 10-02【第三方】v0.66.0：主 Bot（星标）开始主动发现并提出可代办的工作（上线日期有 9 月 30 日、10 月 1 日、10 月 2 日三种说法）；v0.67.0：Marketplace 正式改名 Connect Apps，网页上可浏览 Bot 模板。
- 10-05 至 10-07【第三方】v0.68.0：新增语言，可移除其他已登录的电脑；v0.68.1：可生成幻灯片，1:1 对话按 Bot 颜色着色。10-07 Musk 说 Grok Bot 会为每个任务选最好的后端模型。
- 10-11【第三方】v0.70.2：Bot 专属邮箱、无需连接即可搜索 X、app 以卡片形式嵌入对话、支持 X Money 和 Stripe Link 付款。
- 10-12【官方】「Introducing The X Subscription」：Grok、Grok Bot、Cursor、X Premium 合并为一个订阅，Premium 及以上包含 Grok Bot；也是服务条款的上一个版本日期。
- 10-14【官方】Grok Voice 3.0 发布，驱动 Grok Bot 的语音模式。【第三方】v0.71.2：附件上限提高到单个文件 250MB、视频 1GB、每条 20 个。
- 10-15【第三方】Builder.io 发长文，讲 16 个 Bot 的使用过程和最终停用的原因。
- 10-16【第三方】Musk 号召大家把 X 私信接给 Grok Bot。
- 10-20【第三方】Bot 可以处理 X 私信；Android 上可以把它设为默认助手。
- 10-22【第三方】v0.75.2：Pages、新版卡片设计、视频生成、Shop Pay、团队分享选项；iPhone 上的 Bot 可以使用日历、提醒事项、通讯录等。
- 10-23【第三方】v0.75.5：Vault、邮件转发、减少审批卡、提高 routine 运行上限、可关联 X Money。
- 10-24【第三方】v0.75.8：Bot 可以主动提议修改审批规则，连接器更智能。
- 10-25【第三方】Musk 宣布 Bot 可以替你给个人或商家打电话。
- 10-26【第三方】v0.77.0：权限设置、Vault 新增支付标签、一张卡可提多个问题、1Password 不再需要共享保险库；据称没关联 Slack 的人从此不能用共享 Bot 拥有者的登录和私有数据。
- 10-27【第三方】v0.78.0 和 0.78.1：商品卡片、订单跟踪、订阅类模板、Shop Pay 可在 Vault 中设置；Musk 转发 Matt Palmer 介绍新功能的视频。
- 10-27 至 10-30【第三方】Techloy 在尼日利亚实测 4 天，打电话功能受地区限制。
- 10-30【第三方】额度用完时显示明确提示的修复就绪。
- 10 月下旬【第三方】称日活连续 16 天增长、付费周活约 80 万（来源 Tesla North，未证实）。
- 10-31【官方】Grok Bot 服务条款更新。
- 11-01【第三方】Musk 说服务成本相对收入高到不可持续；用户反映 11 月起额度耗得更快。
- 11-02【官方】「Giving every team a data scientist with Grok Bot」：介绍 Data Bot，称上周为数据团队省下约 70 小时。【第三方】「压缩上下文」的需求帖仍在活跃。
- 截至 2026-11 的现状【官方】桌面端支持 macOS、Windows、Linux，移动端支持 iOS 和 Android，手机 App 到 1.19.0；X Chat 和 @bot 仍在灰度或有地区限制。

## 13 存疑点

1. 官方更新日志页（x.ai/changelog/bot）、它的 RSS、x.ai/bot 和 x.ai/news 列表页抓取时都返回 403（网站的机器人防护，没有绕过）。版本和日期的对应全靠 gradually.ai 对官方 RSS 的转载，覆盖 8 月 25 日到 10 月 27 日，缺 8 月 11 日到 24 日的 v0.1x 到 v0.25；个别有出入，例如 Pages 和 Vault 都说是 v0.75.2，日期却差一天。需要在浏览器里人工核对。
2. 每个 Bot 一台电脑，还是每个账号一台：官方营销及部分媒体说前者，Cursor 文档和深度评测说后者。本清单按共享写，但营销说法会让人误判隔离程度。
3. 首发和扩容的开放范围：现在的首发公告页列出 SuperGrok 全系、Cursor Pro/Pro+/Ultra 和 Teams，第三方说首日只有 Heavy、Ultra、Teams Premium 能用，官方页面可能在 8 月 26 日扩容后改过；8 月 21 日扩大开放的具体范围，各来源说法也不一致。
4. 平台支持：官方首发文写的是桌面和 iOS；部分媒体说当时已有 Windows 和 Linux；eesel、DataCamp、Vantaige 说发布时不支持 Linux 桌面和 iPad（营销页上有 Linux 下载按钮）。Windows、Linux、Android 的具体上线日期没有官方说法（Android 约 9 月 2 日是第三方说法）；iPad 支持说法不一。
5. 各档每周用量的具体数值（token、步数或美元）都没公开，只有相对倍数；11 月 1 日之后额度是否被下调也没有官方数字。
6. 价格：Vellum 写的「14 天试用后 200 美元/月、可单独订阅」与其他来源矛盾；「SuperGrok Heavy 300 美元」被 Alarcon 否认；Reddit 上「每席 120 美元」「200 到 300 美元套餐」已过时；Alarcon 提到的「Bot Lite / Bot Heavy」没有公开价格；The X Subscription 取代旧 Cursor 套餐的确切日期没有官方确认。
7. 额度池是否与其他产品共享：8 月 26 日官方说独立，10 月 12 日后的 X Subscription 文档说共享；Flavio 说新套餐与 Cursor、Grok 共用；Alarcon 说 Bot 和 Grok 聊天分开计；还有人报告 Bot 额度用到 70% 时 SuperGrok Heavy 只用了 6%。
8. 群聊里是否出现审批卡：「Message and collaborate」页说审批、秘密或登录请求、草稿都不会出现在群里；「Approvals」页说群聊里由被回答的人审批、其他人能看到在等谁。可能分别指个人 Bot 和共享 Bot。
9. 主 Bot 的上线日期有三种说法（9 月 30 日、10 月 1 日、10 月 2 日，Digg 那条还把年份误写成 2025）；「主动消息不扣额度」只有一位 X 作者转述。
10. 手机能否新建群聊：docs.x.ai 的手机页说可以通过「+ → New Group Chat」，Cursor 帮助中心说手机 1.19.0 起不再提供。
11. 同一个 Bot 能否开多个对话：Zapier、Flavio 提到左上角有「New chat (+)」，工作人员 9 月 23 日说没有「同一个 Bot 开新会话」，11 月初论坛上还有人在要。可能界面上的「新对话」只能建群或新建 Bot。
12. Pages 的版本要求：帮助中心说桌面 0.60.0 以上即可，更新日志在 v0.75.2（10 月 22 日）才列出。可能是先灰度、后正式发布。
13. Teach a task 何时上线、覆盖多少用户，更新日志里没有记载；Windows 上的入口在哪里没人说清；首发文宣传「跟着看一遍就存成 routine 并自主运行」，文档说生成的是需要补完的草稿 skill。
14. 记忆能否查看、修改、删除、导出：Vellum 说都不能；Kevin Stratvert 说可以让 Bot 列出全部记忆；老章说可以让 Bot 忘掉某些内容，并称长期记忆存在加密的 S3 里（只有他一个来源，他引用的约 8 小时官方视频也没找到原始出处）；Builder.io 的「约 100 条事实、4000 字符」也只有单一来源。
15. 审批卡按钮文案随版本变化：拒绝按钮有 Deny 和 Skip 两种写法；共享 Bot 在 Slack 里的卡片有三种说法（Allow once / Deny / View details；Allow once / Always allow / Skip；视频里还出现过 Allow for this channel）；「Send email / Discard」只来自二手转述的演示；10 月宣传的「减少审批卡」具体改了哪些规则不清楚。
16. 自定义审批规则是否跨设备同步：官方说桌面和手机同步；第三方说个人规则只存在当前这台桌面电脑上。
17. 购买时是否每次审批：v0.78.1 的更新日志说「Buy now」要你批准；Vault 指南说保存的卡结账时自动填写、不逐次询问。
18. 每个 Bot 是否有独立的邮箱身份：官方帮助页提到 Bot 会用「自己的地址」发邮件；邮箱文档又说每人只有 1 个地址、属于你本人，所有 Bot 共用。第三方评测里没见到这方面的描述。
19. 服务条款提到通话（Calls）和会议功能（Meeting Features），8 月 26 日的文章也举了「代你参会、记笔记、发纪要」的例子，但产品文档里找不到打电话或参会的说明；打电话的地区限制（美国境内，华盛顿州和伊利诺伊州除外）只来自 Techloy 一位记者的截图，更新日志里没写，其他地区何时开放也不知道。
20. 「电脑任务快 3 倍」「Robinhood 交易连接器」「Coinbase、eToro 等新连接器」只见于第三方报道和论坛 bug 帖。
21. X API 起步额度的金额没有公布，文档还承认起步额度可能不会自动到账；官方 X 连接器能不能发帖没有说明（官方只写了读取类操作）。
22. 企业公告里「数百万个 Bot」这个数字带着方括号，疑似是没替换掉的占位符。
23. 运营主体不清楚：页面署名是 SpaceXSI（SpaceX Super Intelligence LLC），但账号、计费、云电脑、文档、客服邮箱 hi@cursor.com、ISO 认证都属于 Cursor（Anysphere）；服务条款没有写明「提供方」是哪家公司。
24. 团队共享记忆的审核界面（Data Bot 文章里 Manager 审核后才生效）是否对所有团队开放不明确；帮助中心只说共享 Bot 保存团队知识时会告诉你。
25. 不公开的产品逻辑：主 Bot 什么时候主动出手、记忆什么时候保存、Auto-review 用的是什么审查模型，都没有公开。「Bot Boss」「projects Manager」是用户在指南里自建的用法，不是产品功能。
26. 后端模型：是 Grok 4.5（第三方推测），还是按任务路由到 Claude Opus 5.5 等第三方模型（官方帮助页提到 Opus 5.5，Musk 10 月 7 日点名 Claude Opus 5.5、Midjourney、Suno），没有官方技术说明；用户说看到过 Sonnet 4.5 的调用、简单任务被派给重型模型，都没有证实。
27. 云电脑规格（约 8 核、16GB、100 到 128GB）来自第三方实测和未经证实的报告；休眠策略（空闲多久会休眠、会不会推迟 routine）没有文档说明。
28. 关键安全细节没公开：凭证怎么存储、能不能只让某个 Bot 用部分登录、共享虚拟机有没有经过独立审计、恶意网站能不能感染云电脑（Zapier 作者问过，文档没有回答）、数据保留多久。
29. 「约 80 万付费周活」「日活连续 16 天增长」只有二手来源。
30. 名称容易混淆：开发方在不同文章里写作 xAI、SpaceXAI 或 SpaceXSI；产品名有 Grok Bot、GrokBot、Grok @Bot 几种写法，还常和 X 上的 @grok 账号、Grok 聊天机器人、Grok Build 混在一起。例如 MyClaw 那篇「Grok Bot 评测」写的其实是 Grok 聊天机器人。
