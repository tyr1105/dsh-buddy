# D01 插件骨架、构建流水线、界面外壳与隔离沙箱

- 负责方：DSH
- 允许修改：`packages/plugin/`（不得改 package.json 的 dependencies/devDependencies）、`scripts/`（新建）、`docs/progress/D01.md`、`docs/questions.md`（只追加）
- 不得修改：`packages/core/`（Codex 正在那里并行开发）、`docs/build-spec.md`、`docs/tasks/`
- 前置：依赖已装好（esbuild、vitest、typescript、@types/react 18）。不要联网、不要运行 pnpm install / add。

## 目标

做出能被 DSH 加载的 `dsh-agent-hub` 插件外壳：宿主半边起来、注册界面接口与实时推送（数据先用样例），界面半边在左侧栏出现「队友」入口，打开后是一个像聊天软件的三栏页面——左边队友列表，中间对话线程，右边详情。另外写好隔离沙箱脚本，让总控能在不碰主人桌面版的前提下把插件跑起来看。这张卡不接真实引擎（那是 D02），但所有接口形状必须与规格第 15.1 节完全一致，D02 换成真引擎时界面一行不改。

## 必读

1. 根目录 `AGENTS.md`（红线、详细中文注释要求）。
2. `docs/build-spec.md` 第 1 节（Grok Bot 对照，决定界面气质）、第 15、15.1 节（视图数据结构，逐字段照用）、第 16 节（DSH 适配的全部决定）。
3. `docs/dsh-research/verified-T1-plugin-anatomy.md`（包结构、cordis.patch.yml、错误隔离 safe()、沙箱步骤 Q5-a…Q5-e）、`verified-T5-client-ui.md`（客户端 bundle 格式、可 require 的模块、插槽、fetch.register、SSE、主题变量、打开会话）、`verified-T8-testing-devloop.md`（怎么测、沙箱冒烟）。这三份是逐条对过源码的结论，以它们为准；有疑问再查 DSH 源码 `/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src/@deepseek-ai/`（只读），尤其官方模板 `dsh-agent-preset/skills/cordis-plugin-development/`。
4. 界面设计参考 `docs/design/prd/sections/16-ui.md` 的 16.0（挂载点、文案约定、时间写法、颜色只用主题 token）。本卡按下面「界面」一节的三栏结构做，不必实现 16 章全部页面。

## 要做

### 1. 包与构建

- `cordis.patch.yml`：`- insert:` 一行 `id: agent-hub`、`name: dsh-agent-hub`（照 dsh-net-tuning 的写法）。
- `build.mjs`（Node 脚本，用 esbuild API）：
  - 宿主：入口 `src/host/index.ts` → `lib/index.js`；bundle、platform node、format esm、target node22；external 只放 Node 内置模块（`node:*` 与裸名内置模块）。将来 D02 会 import `@agent-hub/core`，届时它会被打进来；本卡不 import core。
  - 界面：入口 `src/client/index.tsx` → `lib/client.js`；bundle、platform browser、format cjs、jsx automatic（不开 jsxDev）、external `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`；CSS 用 text loader 当字符串导入；用 banner/footer 把产物包成「整份只调用一次 `window.__ModuleLoader__.load({ id: 'dsh-agent-hub', factory: function (require) { var module = { exports: {} }; var exports = module.exports; …产物… return module.exports } })`」，文件顶层除此之外不得有任何 let/const/class/import/export；去掉 sourcemap 尾注。
  - `pnpm --filter dsh-agent-hub build` 产出两个文件，并打印各自大小。
- 不新增依赖。不 require `@deepseek-ai/dsh-client-ui-primitives` 或任何 Harness 客户端包。

### 2. 宿主半边 `src/host/`

- `index.ts`：`export const name = 'agent-hub'`；`export const inject = ['connection']`（本卡只需要它；webServer 用 `ctx.inject(['webServer'], …)` 子插件，headless 下不阻塞）；`export function apply(ctx, config)`：读 rootDir（config.rootDir → 环境变量 AGENT_HUB_ROOT → `~/AgentHub`，展开成绝对路径，只记录，本卡不建目录），创建 `FixtureHub`，注册路由与 SSE，打印一行 `[agent-hub] 已启动（样例数据模式）rootDir=…`。所有回调按第 16 节第 2 条用 `safe()` 包；apply 里的异步初始化写 `init().catch(log)`。
- `safe.ts`：照 verified-T1 Q4 的 safe()（同步异常与 rejection 只记日志，一律返回 undefined）。
- `hub-facade.ts`：定义界面接口要用的门面 `HubFacade`（方法：overview()、bot(id)、thread(id, {before, limit})、inbox()、activity({before, limit})、settings()、recentSessions()、command(name, input) → CommandResult、subscribe(fn)），以及 `FixtureHub implements HubFacade`：返回 `src/shared/fixtures.ts` 里的样例数据；`command('sendMessage', {threadId, text})` 要真的把主人消息追加进样例线程，并在 2 秒后追加一条机器人的样例回复（用于看实时推送效果），其余命令返回 `{ ok: true }`。
- `routes.ts`：`ctx.connection.fetch.register` 注册：GET `overview`、`bot`（?id=）、`thread`（?id=&before=&limit=）、`inbox`、`activity`（?before=&limit=）、`settings`、`recent-sessions`；POST `command`（JSON `{ name, input }`）。路径按第 16 节第 4 条（先确认 dsh-client-connection 是否允许多段路径，在进度里写明你选了哪种并给出源码行号）。GET 一律 `requestBody: 'buffered'`。处理函数 try/catch，出错返回 `{ ok: false, error: '…' }` 与 500。返回 JSON，`Content-Type: application/json; charset=utf-8`。
- `events.ts`：webServer exact 路由 `/agent-hub/events`：第一行 `ctx.connection.requestRejection(req)`，被拒就写对应状态码结束；否则 `text/event-stream`，每 25 秒写注释行保活；HubFacade 有变化时写 `event: changed` + `data: {"scope":…,"botId":…}`；`res` 的 close/error 时清理订阅；写之前检查 destroyed / writableEnded。注册用 `ctx.effect(() => ctx.webServer.register(...))`。
- `src/shared/views.ts`：把第 15.1 节的视图类型逐字段抄成 TS 类型（只做类型；D02 会改为从 core 导入，所以命名与字段必须完全一致）。`src/shared/fixtures.ts`：样例数据——3 个机器人：「巡检员」（盯守，在盯着，3 项）、「观潮」（调研，正在处理，第 12/30 步）、「总管」（总管，等你：一个提问）；团队线程与每个机器人的线程各 6–10 条消息，至少包含一张提问卡片（带选项）、一张审批卡片、一条汇报、一条日报；收件箱 3 项；活动流 10 条；为什么醒/没醒 8 条。文案要像真的（中文、北京时间、符合 16-ui.md 16.0.3 的时间与文案约定），不要 lorem ipsum。

### 3. 界面半边 `src/client/`

- `index.tsx`：`inject = ['slots', 'locale']`；apply 里：
  - 在 `ctx.effect` 里插入样式（`styles.css` 文本，`<style data-plugin="dsh-agent-hub">`），返回移除函数。
  - `slots` 注册 `main`（keyed，key `agent-hub`）→ `<HubPage>`；注册 `sidebar.panellist`（list，id `agent-hub`，order 15，label「队友」）→ 入口图标组件（内联 SVG，两三个人头的剪影，接收 {size, active}）。注册写法照 verified-T5 Q2-1/Q2-2 与官方 schedule 插件；每个注册 try/catch。
  - 建立唯一的数据仓库与一条 SSE 连接（`new EventSource('agent-hub/events')`，在 ctx.effect 里创建、返回 close）；收到 changed 就重拉受影响的视图；`ctx.on('connection/reset', 重拉全部)`。
- `api.ts`：`fetch('api/agent-hub/…')`（相对路径、同源 cookie，不加鉴权头）的封装与错误处理。
- `store.ts`：最小可观察仓库（订阅、快照、`useSyncExternalStore` 钩子）。
- `pages/HubPage.tsx` 与组件（按职责拆文件，单文件 ≤ 400 行）：
  - 顶栏：标题「队友」、现在时间与免打扰状态、额度灯（圆点 + 文字「绿灯」等）、收件箱计数按钮、「新建队友」按钮（本卡只弹出「下一张卡实现」的占位对话框）。
  - 左栏：「团队」行（未读数）+ 每个机器人一行：圆形头像（`color` 做底、`initials` 做字）、名字、角色、`activityText`（一行省略）、未读红点、`waitingOwner` 时显示「等你」标签；点选切换中栏线程。底部「收件箱」入口。
  - 中栏：线程视图——主人消息靠右、机器人消息靠左带头像与名字、中心消息（kind=system/digest）居中小字；提问/审批/提议卡片内嵌在消息里，带选项按钮（点了调 `command('answerInbox'|'decideApproval', …)`）；底部输入框「给 {名字} 发消息…」，回车发送（调 `command('sendMessage', {threadId, text})`），发送中禁用；向上滚动加载更早（用 hasMore/oldestId）。
  - 右栏（可收起）：选中机器人的档案摘要、志向、进行中目标、议程前 5、关注项前 5、套路列表、「为什么醒 / 为什么没醒」最近 8 条、按钮「打开工作会话」（按第 16 节第 5 条用 uiWorkspace.openSession，不可用时显示一句指引）、「教它一招」（本卡占位）。
  - 收件箱视图（左栏底部入口进入，中栏显示列表与操作）。
  - 空态写下一步能做什么；加载超过 300 ms 显示骨架；接口失败显示一句原因加「重试」；宿主连不上时整页提示「连不上 Agent 中心（插件可能停用或在重载）」。
- `styles.css`：只用 `var(--dsw-alias-*)` 与 `--dsw-radius-*`、`--dsw-shadow-*` 等主题 token（具体名字查 verified-T5 Q4-1 与 dsh-client-ui-theme 源码），不得出现十六进制、rgb、hsl 颜色（transparent、currentColor 除外）；中栏 720–1600 px 宽度下可用，窄于 900 px 时右栏改成抽屉。macOS 标题区留 `calc(28px + var(--dsh-frame-top-clearance, 0px))`（只在 `[data-platform=darwin]` 下）。

### 4. 隔离沙箱脚本 `scripts/sandbox.sh`

照 verified-T1 Q5-e 与 verified-T8 第 5 节：`bash scripts/sandbox.sh install|run|dump|remove|status`。
- 沙箱目录 `agent-hub/.sandbox/`（已在 .gitignore 范围外的话请在 `scripts/` 旁加说明，不要改根 .gitignore 以外的东西；如需忽略就在 `.sandbox/` 里放一个 `.gitignore` 写 `*`）：`DSH_HOME=.sandbox/home`、`DSH_AGENTS_HOME=.sandbox/agents`、`DSH_TELEMETRY_DISABLED=1`、工作目录 `.sandbox/work`、`AGENT_HUB_ROOT=.sandbox/AgentHub`、端口 3951、`--host 127.0.0.1 --no-open`。
- install：`dsh plugin --profile web add link:<packages/plugin 的绝对路径>`；run：前台启动 web profile 并把输出 tee 到 `.sandbox/run.log`；dump：`--dump-config` 并 grep agent-hub 行；remove：卸载；status：端口是否在监听、run.log 末尾 20 行。
- dsh 路径用桌面版自带 CLI（路径含空格，全部加引号）。脚本不得读写 `~/.dsh`，不得设置任何模型凭据。
- 本卡你只需写好脚本、`bash -n` 语法检查通过；实际 install/run 由总控执行（需要联网与常驻进程）。

### 5. 测试 `packages/plugin/test/`（vitest）

- 路由：用假 ctx（记录 fetch.register 的调用）验证每个路由的 path、methods、requestBody，调用 fetch 处理函数验证 JSON 形状与 15.1 一致（至少 overview、thread、command sendMessage）；处理函数抛错时返回 500 且 `ok:false`。
- SSE：requestRejection 返回拒绝时写状态码并结束；接受时写 event-stream 头、变化时写 changed 事件、close 后取消订阅。
- safe()：同步抛错与异步拒绝都被吞并记录、返回 undefined。
- 构建产物：运行 build 后，`lib/client.js` 以 `window.__ModuleLoader__.load(` 开头（允许前面有注释）、只出现一次、顶层没有 `import `/`export `、不含 `@deepseek-ai/dsh-client-ui-primitives`；`lib/index.js` 能被 `import()` 并导出 name/inject/apply；`styles.css` 里没有十六进制/rgb/hsl 颜色。
- 测试数 ≥ 30。

## 不要做

接真实引擎、会话控制、工具注册、钩子（D02）；新建向导与教学的完整流程（D03）；改 core；联网；装依赖；git commit。

## 验收

在 `agent-hub/` 目录：

```bash
pnpm --filter dsh-agent-hub typecheck
pnpm --filter dsh-agent-hub test
pnpm --filter dsh-agent-hub build
bash -n scripts/sandbox.sh
```

全部通过。`docs/progress/D01.md` 写清：文件清单、路由路径的最终选择与源码依据、构建产物大小、样例数据概况、你对不确定点的处理（每条附 verified 文件或源码行号）。总控随后会在沙箱里实际加载并用浏览器检查界面（亮色、暗色各看一遍）。
