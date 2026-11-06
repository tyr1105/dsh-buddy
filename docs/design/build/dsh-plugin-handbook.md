# DSH 插件开发手册（为 dsh-agent-hub 定制）

- 适用版本：DeepSeek Harness 桌面版 0.2.1-rc.5（等于 `dsh --version`，取自 dsh-app-boot 的 package.json）。内置 @deepseek-ai/cordis 4.0.5，页面里的 React 和 ReactDOM 是 18.3.1，zod 是 4.4.3。DSH 升级后，本手册的签名和行号都要重新核对。
- 读者：DSH（写 `packages/plugin`）和 Codex（写 `packages/core`）照着写代码；总控 Claude 据此写任务卡、做验收。
- 定位：`agent-hub/docs/build-spec.md` 第 16 节引用的就是本手册。本手册只讲 DSH 接口的事实和推荐接法，产品规则仍以 build-spec 为准。0.4 节列出本手册与 build-spec 第 16 节、D02 任务卡写法不一致或需要补充的地方，是否同步回规格由总控决定。
- 写于 2026-11-05。

## 0 怎么读

### 0.1 收录规则

- 第 1 到 11 节只写已核实（confirmed）或核实后改正（corrected）的结论。改正过的条目直接写改正后的说法。
- 标「推断」的句子，代码逻辑已经读过，但没在运行中的 DSH 上跑过。可以照做，出问题时先怀疑它。
- 没有核实的点统一放在第 12 节，编号 H1、H2……正文用「见 H5」引用。
- 每个接口给出签名、最小示例和证据。签名优先取官方生成的签名表 `api-catalog`，与实现不一致时以实现为准并注明。

### 0.2 证据路径约定

- `dsh-src` 指 `/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src`，是从 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 只读解出的官方源码。临时目录被清掉后，用项目里的 `tools/asar_extract.py`（即 `agent-hub/tools/asar_extract.py`）重新解。
- 证据写成 `<包名>/<文件>:<行号>`，指 `dsh-src/@deepseek-ai/<包名>/<文件>`。例如 `dsh-agent-loop/lib/index.js:800-821`。
- `_app/main.js` 指 `dsh-src/_app/main.js`，即 Electron 主进程。
- `api-catalog` 指 `dsh-tool-cordis/lib/types/api-catalog.js`，是官方从源码生成的服务与事件签名表。
- 以 `agent-hub/` 开头的路径指本项目（`/Users/bytedance/Documents/DSH solo AGENT/agent-hub/`）；以 `/` 开头的是绝对路径。
- 逐条推理过程在 `agent-hub/docs/dsh-research/verified-T1…T8.md`。本手册写「详见 T2 Q1」，指的是那里的条目。

### 0.2.1 本手册用到的几个词

- 宿主（Host）：DSH 的 Node 进程，插件的宿主半边（`lib/index.js`）跑在这里。
- 页面（Client）：DSH 的界面，插件的界面半边（`lib/client.js`）跑在这里。
- 行（row）：Loader 配置树里的一个插件条目，有 `id`、`name`、`config`、`disabled` 等字段。
- fiber：cordis 给每个插件实例建的生命周期对象。插件卸载时，挂在它上面的副作用（effect）全部被清理。
- preset：DSH 的「模式」（standard、ptc、minimal、cordis），决定一个会话能用哪些工具和提示词。
- 权限档：permission preset，决定沙箱模式（read-only、workspace-write、danger-full-access）和审批策略（ask、never）。

### 0.3 中心插件在 DSH 里的位置

- 宿主进程：桌面版的 Host 是 Electron 用 `ELECTRON_RUN_AS_NODE` 拉起的 Node 子进程，工作目录是 `$DSH_HOME/profiles/desktop`，环境变量来自用户登录 shell（其中 `DSH_*` 和 `ELECTRON_*` 被忽略）。中心插件的宿主半边跑在这里：持有 core 的 Hub、实现 HostPort、给机器人装工具和钩子、注册界面要调的路由。证据：`_app/main.js:79-84、3649-3657、3794-3803、12051、12061-12063、12182、9283-9284`。
- 页面：桌面版页面地址是 `dsh-app://app/`。除了 `/`、`/index.html`、`/assets/*`、`/favicon.svg`、`/manifest.webmanifest`，其余路径都由 Electron 主进程连同 Host 的 cookie 转发给 Host。web 沙箱里页面和 Host 同源。所以界面一律用相对路径请求宿主。证据：`_app/main.js:12406-12414、8268-8299`。
- 机器人：一个工作区（目录就是机器人的家目录）里的一个顶层会话。会话由 `sessionController` 创建、恢复并持有，不归中心插件。中心插件只记住 sessionId，需要时用 `resolveAgent` 取到会话再投递消息。见 2.5、3.2。

### 0.4 与 build-spec 第 16 节、D02 任务卡的对照

1. `/api/agent-hub/<名字>` 这种多段路径可以用。connection 精确路由要求 `/api/` 后的每一段都匹配 `^[A-Za-z0-9_$.-]+$`，并且不能是空段、`.` 或 `..`。build-spec 16.4 里「多段路径不被允许就改用点号」的备选用不上。证据：`dsh-client-connection/lib/index.js:690、926-931、974-978`。
2. `sessionController.prompt(request, signal)` 和 `projections(request, signal)` 的第二个参数必填，省略会直接 TypeError。build-spec 16.6 里写的 `projections({ sessionId })` 要补上 signal。见 3.1。
3. 不要用 `commands.execute(agent, '/permission …')` 设权限。它会往会话日志写一条 `command/run`（source.kind 是 user）；审批策略真的变了时，还会给模型注入一条「changed by the user」的消息。改用 6.2 的写法：`permissionPresets.set` 加直接追加 `approval/policy`。D02 卡已经是这个写法。
4. 唤醒消息可以安全地带自定义来源（T2 Q2 已核实，并改正了约束）：用 `agent.followup(消息)`，`source.kind` 写 `'agent-hub'`。D02 卡写的是「证实能安全地带自定义 source 就带上」，这个前提已经成立，写法见 3.3。只有主人亲手写的话才走 `prompt`。
5. 机器人会话的审批策略设成 never 之后，`approval/asked` 后面会紧跟一条 outcome 为 rejected 的 `approval/decided`。这表示被自动拒绝了，不是 DSH 的审批框卡住。翻译 `awaiting_approval` 时，要先看有没有配对的 `approval/decided`（见 3.4、6.3），否则 build-spec 第 14 节「5 分钟后 cancel」会把正常的回合也取消掉。
6. 机器人会话归 `sessionController` 持有。中心插件重载、改普通配置、被热替换，都不会打断机器人正在跑的回合（本次回源码核实，见 2.5）。反过来，如果改用 `ctx.agents.create` 建会话，会话就归中心插件，插件一重载，所有会话都会被取消。
7. 界面打开中栏页面，用客户端服务 `layout` 的 `selectPanel(id)`，服务名已核实。见 8.7。
8. `ctx.logger` 的内存缓冲只收 error 和 info 两级，warn 和 debug 默认丢弃，所以运行期调试要用 `console.*`。build-spec 16.2 的做法是对的，原因要更正为日志级别过滤。见 2.7。
9. `agent/created` 的 `source` 在本版只会是 `'startup'` 或 `'resume'`。`'clear'` 和 `'compact'` 只在类型里保留，没有代码发出。证据：`dsh-agent-loop/lib/index.js:1909、2012`，`dsh-agent/lib/index.js:494`，`dsh-agent/README.zh.md:186`。

## 1 插件包结构与安装

### 1.1 package.json

DSH 没有统一的清单解析器，每个读取方只校验自己用到的字段。中心插件需要的字段如下（与当前 `agent-hub/packages/plugin/package.json` 一致，另补了可选的展示字段）：

```json
{
  "name": "dsh-agent-hub",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "dsh": ">=0.2.1-rc.5 <0.3.0-0" },
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

逐项规则：

1. `name`：写 `dsh-agent-hub`。它同时是 Loader 行的 `name`、浏览器 bundle 的 `id`、客户端组合的身份，三处必须一致。不要用 `@deepseek-ai/` 作用域：组合包名先从 DSH 安装目录解析、再从 profile 解析，混进官方命名空间容易撞名。证据：`dsh-app-boot/lib/index.js:976-1001`，`dsh-client-modules/lib/client.js:702-714`。
2. `engines.dsh`：版本闸门，必须写在顶层 `engines` 里；写在 `dsh.engines.dsh` 下宿主不读。规则如下。
   - 写了 `engines.dsh` 就只看它，peerDependencies 全部忽略。没写时，才逐个检查名字是 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的 peer 范围。
   - 用 `semver.satisfies` 比较，开了 `includePrerelease`。比较对象是 `getDshRuntimeVersion()`，即 dsh-app-boot 的版本号。空范围、无效范围（包括 `workspace:`）都算不兼容。
   - 有 4 个检查点：安装前（不兼容就报「nothing was installed」）；安装后（不兼容就恢复 package.json 和 lockfile，再跑 `pnpm install --frozen-lockfile`）；每次启动或重组时检查组合包（不兼容就跳过，stderr 打印 `skipping profile bundle`）；检查每个插件行（不兼容就把该行改成 disabled，stderr 打印 `disabling profile plugin`）。
   - 证据：`dsh-app-boot/lib/index.js:270-298、311-326、538、1015-1045、2305-2309`，`dsh-plugin-manager/lib/types/operations.js:351-374、496-560`。dsh-package-manifest 的 README 说「不强制 engines.dsh」，那是旧说法。
3. `dsh.bundle.patch`：字符串，或有序的字符串数组（相对包根的 YAML 文件）。只有声明了它，`dsh plugin add` 才会把包名追加进 profile 的 `dsh.profile.bundles`；没声明只会当普通依赖装上，并警告「declares no dsh.bundle — installed as a plain dependency」，插件不会被加载。类型写错时，启动阶段这个组合包被跳过。证据：`dsh-plugin-manager/lib/types/operations.js:83-87、96-125`，`dsh-app-boot/lib/index.js:517-521`。
4. `dsh.client`：浏览器半边的声明，有 4 个字段。
   - `platform`：必填字符串。只有 `'web'` 会被组合，其他值静默忽略。但另外三个字段的类型在判断 platform 之前就会校验，写错照样抛错。
   - `inject`：可选，字符串数组，填客户端包名。只决定这些包先到达、先激活；图里没有的包名直接跳过。它不是服务名。
   - `external`：可选，字符串数组，填 bundle 会 `require()`、但不在基座模块表里的精确模块名（基座表见 8.2）。写自己的包名，或者形成环，组合会失败。
   - `immediately`：可选布尔值。true 表示页面启动时预取。不写也会在插件加载阶段加载并挂载。
   - 证据：`dsh-client-modules/lib/index.js:62-76、422-445、720-748`，`dsh-client-modules/lib/client.js:777-792`。
5. `exports`：
   - `exports['.']`：宿主半边入口，Loader 按包名 import。
   - `exports['./client']`：`platform` 为 web 时必须有，值是字符串，或带字符串 `default` 的条件对象。缺这一项会抛「declares dsh.client but exports no "./client" bundle」；文件不存在会抛 MissingClientBundleError，要求先构建。证据：`dsh-client-modules/lib/index.js:172-182、720-750、830-841`。
   - `exports['./locale/*.json']`：可选，提供插件页显示的 `meta.title` 和 `meta.description`；缺了就用 package.json 的 name 和 description。
   - 图标：`exports['./icon']` 或顶层 `icon`，顶层优先，路径相对包根。只能是 SVG、PNG、JPEG、WebP，不超过 256KiB，不能是绝对路径、URL 或指向包外的符号链接。证据：`dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:29-51`。
   - `'./package.json'` 导出不是必需的，写了也没坏处。证据：`dsh-app-boot/lib/index.js:976-1001`。
6. 依赖：
   - 宿主自带的 `@deepseek-ai/*` 包绝不能写进 `dependencies`。pnpm 会把副本装进 profile，插件拿到的是副本，与宿主那份不是同一个实例。
   - 要复用宿主的包（例如 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`），写进插件根 package.json 的 `peerDependencies`。名字不以 `@deepseek-ai/dsh` 开头的 peer 不参与版本闸门。
   - 中心插件的做法是零运行时依赖：core 和所有第三方代码都用 esbuild 打进 `lib/`，见 1.3。证据：`dsh-app-boot/lib/index.js:1337-1356、1613-1729`，`dsh-app-boot/README.zh.md:67、134、138`。
7. `files` 对 `link:` 安装不起过滤作用。`dsh.manifestVersion` 可选，当前格式号是 1，不强制。证据：`dsh-package-manifest/README.zh.md:33-53`。

版本范围怎么取：写封闭范围（如 `>=0.2.1-rc.5 <0.3.0-0`），DSH 升到 0.3 后插件会被自动停用，要等发新版或手动加豁免，这是「失败时关闭」。不写范围就永远加载，但接口变了会在运行时出错。中心插件当前写的是封闭范围，这个取舍需要主人知情。

精确版本豁免写在 profile 目录的 `compatibility.json`，只对精确的 `插件名@版本` 和精确的 DSH 版本生效，任何一方升级都不继承。命令：

```bash
# 列出、授予、撤销豁免（--profile 换成实际的 profile 名）
dsh plugin --profile web version-exemptions
dsh plugin --profile web allow-version dsh-agent-hub@0.1.0 --dsh-version 0.3.0 --accept-risk
dsh plugin --profile web revoke-version dsh-agent-hub@0.1.0 --dsh-version 0.3.0
```

证据：`dsh/lib/plugin-BiveYA7h.js:14-56、95`，`dsh-app-boot/README.zh.md:52-56`。

### 1.2 cordis.patch.yml（组合包补丁）

格式规则：

- 文件必须是一个顶层 YAML 数组，每一项是一个 patch。
- 组合包自己的 patch 出错，整个组合包被跳过。用户层（profile 的 `cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`）出错，启动直接失败。用户层文件为空或只有注释也会启动失败，要关掉这一层就写 `[]`。
- 证据：`dsh-app-boot/lib/index.js:1015-1045、3961-4004`，`dsh-app-boot/README.zh.md:50、61、63`。

支持的写法：

1. `- insert: [行, …]`：在末尾追加行。插入的行立即建立索引，同一层里后面的 patch 能按 id 改它。如果 patch 同时带 `id`，并且这个 id 指向一个 `group: true` 的行，就追加到该分组里。
2. `- id: X`（不带 insert）：按 id 定位已有行。写出的字段整字段替换，`config` 也是整体替换、不做深合并，所以要把这一行需要的全部字段重写一遍。可以只写 `disabled: true` 来关掉一行。写了 `name` 只做断言，不会改名，不一致就跳过并警告。
3. 非 insert 的 patch 没有 id，或者 id 找不到行：只打警告（`dsh: [<层>] patch: entry "<id>" not found`），然后跳过。
4. 行字段：`id`、`name`、`config`、`disabled`、`inject`、`intercept`、`isolate`、`group`。
   - `name` 可以是包名、包的 exports 子路径（如 `dsh-agent-hub/scheduler`）、绝对路径，或 `./`、`../` 开头的相对路径（以 patch 文件所在目录为基准，只对 insert 行生效）。
   - 行级 `inject` 会让这一行等到列出的服务出现后，才对 `config` 里的 `!!js` 求值。
5. `!!js` 只在 `config` 和 `disabled` 里求值，以 `with (本插件 ctx)` 执行。可以写 `process.env.X`、`ctx.get('profileContext')?.name`、`dshHomePath('agent-hub')`。`disabled` 的 `!!js` 每次做挂载决定时都会重新求值；求值抛错，这一行算失败，不算禁用。

层的顺序（后面的覆盖前面的）：`dsh.profile.bundles` 里各组合包按列表顺序 → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 命令行 `--patch` 覆盖层 → 遥测开关。在插件页重新开启一个组合包时，它会被追加到列表末尾，可能改变优先级。证据：`dsh/lib/profile-boot-C14i-8IN.js:223-247`，`dsh-plugin-manager/README.zh.md:40`。

做不到的事：删除一行（只能 disabled）、深合并 config、给行改名。证据：`cordis-plugin-include/src/index.ts:57-127`。

行 id 必须全局唯一。下面这些官方行是 required，改坏了整个应用启动失败，绝不要覆盖或重名：`agent-loop`、`webserver`、`web-runtime`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`。证据：`dsh-app-boot/lib/index.js:4270-4279`。

中心插件的补丁（当前文件就是这样，够用）：

```yaml
# 组合包补丁：把 dsh-agent-hub 插入 Loader 树。
# 文件必须是顶层 YAML 数组；id 全局唯一，不能和官方 required id 重名。
- insert:
    - id: agent-hub          # 行 id；ctx.configForms、日志里都按它找这一行
      name: dsh-agent-hub    # 等于包名：宿主半边和浏览器半边都挂在这一行上
      # 需要可配置的根目录时再加 config，例如：
      # config:
      #   rootDir: !!js process.env.AGENT_HUB_ROOT ?? '~/AgentHub'
```

同一个包要挂第二个宿主子插件时，用 exports 子路径（在 package.json 里加 `'./scheduler': './lib/scheduler.js'`，行 name 写 `dsh-agent-hub/scheduler`）。子路径行不带浏览器半边。不要用 `./lib/x.js` 这种相对路径行：它会被识别成同一个包的第二个来源，报「resolves from multiple active Loader sources」，导致组合失败。证据：`dsh-client-modules/lib/index.js:851-896`，`dsh-web-app/cordis.patch.yml:168-169`。

HMR 只监视 profile 清单、profile 的 patch 和 home 的 patch，不监视组合包自己的 patch。改了 `cordis.patch.yml` 要重启。证据：`dsh-app-boot/README.zh.md:65`。

### 1.3 构建与依赖

- 宿主半边：esbuild 打成一个 Node ESM 文件 `lib/index.js`，target node22，Node 内置模块设为 external，core 打进去，运行时零依赖。这样就绕开了 link 安装的依赖解析问题（见 H2）。
- 界面半边：esbuild 打成经典脚本 `lib/client.js`，格式要求见 8.1 和 8.9。
- 链接安装的模块解析规则：被 import 的包不在运行时表里，就走 Node 原生解析，即插件自己的 node_modules 及祖先目录。在表里的话，从 importer 所在目录逐级向上查找，每一级先看 package.json 的 `peerDependencies` 有没有列出这个包，列了就用宿主那份；没列，再看这一级的 node_modules 里有没有物理副本，有就用副本；都没有就落回原生解析，通常报找不到模块。证据：`dsh-app-boot/lib/index.js:664-692、1676-1730`。
- 链接目录挪了位置，要先卸载再重装，否则报 ResolutionRestartRequired。证据：`dsh-plugin-manager/README.zh.md:50`。
- 清理构建产物时不要先删 `lib/`：声明了 `dsh.client` 的包缺了 `lib/client.js`，Web 和桌面版启动时必需行 `modules` 会失败，整个界面起不来。证据：`dsh-client-modules/lib/index.js:537-562、830-841`。

### 1.4 安装、卸载、停用

用哪个 dsh：桌面版自带的 CLI 在 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。它是一个 sh 脚本，用 `ELECTRON_RUN_AS_NODE=1` 执行 app.asar 里的 CLI，自带 pnpm。只有它能对 desktop profile 跑 plugin 子命令；任何 dsh 都拒绝用 `--profile desktop` 启动或 dump 配置。证据：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh:13-14`，`dsh-desktop-host/lib/cli.js:94-107`，`dsh/lib/bin.js:35-37、101-137、207-238`。

安装做了什么：在 `$DSH_HOME/profiles/<名字>/` 里执行 pnpm（`nodeLinker: hoisted`、`autoInstallPeers: false`），往 profile 的 package.json 加一条 link 依赖，`node_modules/<包名>` 变成指向源码目录的符号链接；然后把包名追加到 `dsh.profile.bundles` 末尾。相对路径的 `link:./x` 以执行命令时的目录为基准。和宿主内的插件管理器共用一把写锁，最多等 120 秒。每次操作的日志在 `<profile>/.plugin-manager/logs/operation-*/pnpm.log`。证据：`dsh-plugin-manager/lib/types/operations.js:71-77、96-125、299-330`，`dsh/lib/plugin-BiveYA7h.js:63-99`。

隔离沙箱（开发和端到端测试都用它，不碰桌面版）：

```bash
#!/bin/bash
# dsh-sandbox.sh：在独立的 DSH_HOME 里跑 web profile，不碰 ~/.dsh 和正在运行的桌面版
set -euo pipefail
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"  # 桌面版自带 CLI，自带 pnpm
SANDBOX="$HOME/dsh-sandbox"
PLUGIN_DIR="/绝对路径/agent-hub/packages/plugin"
export DSH_HOME="$SANDBOX/home"            # profiles、sessions、凭据、日志都落在这里
export DSH_AGENTS_HOME="$SANDBOX/agents"   # 不读 ~/.agents 的全局 AGENTS.md 和 skills
export DSH_TELEMETRY_DISABLED=1            # 任何非空值都会关掉遥测行
mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$SANDBOX/work"
cd "$SANDBOX/work"                          # 启动目录 = 新会话默认工作目录，也会读这里的 .env
case "${1:-run}" in
  install) "$DSH" plugin --profile web add "link:$PLUGIN_DIR" ;;   # 第一次会按 web 模板初始化 profile
  remove)  "$DSH" plugin --profile web remove dsh-agent-hub ;;
  dump)    "$DSH" --profile web --dump-config ;;                    # 确认组合里有 agent-hub 行
  run)     exec "$DSH" web --no-open --port 3999 ;;                 # 打印 dsh web: http://127.0.0.1:3999/?token=...
esac
```

证据：`dsh/README.zh.md:11-20、37、46、48`，`dsh-app-boot/lib/index.js:1105-1112`，`dsh-plugin-manager/lib/types/operations.js:591-604`。

桌面版（只在主人批准后执行）：

1. 完全退出桌面 App（官方流程）。在 App 运行时安装的效果没有实测，见 H1。
2. 运行 `"<桌面版 CLI>" plugin --profile desktop add "link:/绝对路径/agent-hub/packages/plugin"`。
3. 重新打开 App。

desktop profile 不存在时，CLI 不会自动初始化，会报「Open DeepSeek Harness Desktop once to initialize its profile…」。证据：`dsh/lib/plugin-BiveYA7h.js:10-12`，`_app/main.js:79-84、3636-3638`。

卸载：`dsh plugin --profile <名字> remove dsh-agent-hub`（写包名，不写路径）。插件自己写的数据文件不会被删。

只停用、不卸载：在插件页关掉开关；或者在 profile 的 `cordis.patch.yml` 里加一条：

```yaml
- id: agent-hub
  disabled: true
```

给主人手动运行的命令有限制：App 的 Run 按钮会弄丢引号和反斜杠，而桌面版 CLI 的路径带空格。所以要把命令写进脚本文件，只给主人一条 `bash /绝对路径/脚本.sh install` 这样的短命令。

### 1.5 改了什么，怎么生效

| 改动 | web 沙箱 | 桌面版 |
|---|---|---|
| `lib/client.js` | 约 0.5 秒内页面热替换，插件里的 React 状态会丢 | 未实测，见 H3；保守做法是刷新页面 |
| `lib/index.js`（宿主代码） | 重启 `dsh web`（Ctrl+C 后重跑），再刷新页面 | 完全退出 App 再打开 |
| 插件的 package.json、组合包 `cordis.patch.yml` | 重启 | 完全退出再打开 |
| profile 或 home 的 `cordis.patch.yml` | HMR 自动重组 | HMR 自动重组 |
| DSH 升级 | 必须刷新页面（页面只认启动时那个版本的模块图） | 同左 |

说明：

- `dsh-client-hmr` 每 500 毫秒检查一次每个客户端 bundle 的 mtime、ctime 和大小，有变化就热替换。证据：`dsh-client-hmr/lib/index.js:18-21、42-110`。
- 宿主侧的 HMR 配置是 `root: []`，不监视源码。已链接包的文件变了，要等下一次重组才会被替换（重组由插件管理器操作，或改动上表中被监视的那三个文件触发）。新代码加载失败时，旧版本也已经停了，不会恢复。官方开发指南写的是「替换已安装包的 JS 要重启」，两份文档说法不一，开发期一律重启。证据：`dsh-base/cordis.patch.yml:20-32`，`dsh-hmr/README.zh.md:49、113`，`dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:66-70`。
- headless、sdk、acp 三个组合都关闭了 HMR，改了什么都要重启。证据：`dsh-headless/cordis.patch.yml:32-33`。

## 2 宿主插件骨架与生命周期、错误隔离

### 2.1 入口模块的三种写法

Loader 的处理流程：

- import 模块后执行 `unwrapExports`：取 `exports.default ?? exports`，再处理 `__esModule`。同时有 default 导出和具名 `apply` 时，default 胜出，具名导出全部被忽略。
- 插件是函数就当回调；是带 `apply` 方法的对象（包括 ES 模块命名空间）就取 `apply`，同时从对象上读 `name`、`inject`、`Config`、`provide`、`intercept`。
- `name` 只用于诊断和默认 logger 名，值为 `'apply'` 时忽略。

函数怎么被调用，只看它有没有 `prototype`（`isConstructor`，生成器函数除外），由此分三种写法：

1. `export function apply(ctx, config)`（官方模板就是这种）：普通 function 声明有 prototype，会被 `new` 调用，返回值被丢弃，所以 return 清理函数等于没写。最危险的是 return 一个 Promise：它被 new 吞掉，没人处理；一旦 reject，就成了未处理的拒绝，宿主进程直接退出（见 2.6）。所以这种写法的 apply 必须同步、不 return；异步初始化写成 `init().catch(log)`；清理全部交给 `ctx.effect` 和 `ctx.on`。
2. `export async function apply(ctx, config)`：async 函数没有 prototype，按普通方式调用。返回值会被 await，异常会被兜住，也可以 return 清理函数。代价是 Promise 结算之前，这一行一直处于 LOADING；启动时 `boot()` 要等所有行结束 LOADING，才打印 URL、通知桌面版就绪。所以长任务会拖慢整个 DSH 的启动。
3. `export default { apply(ctx) {…} }`：方法简写和箭头函数同样没有 prototype，按普通方式调用，`this` 是 runtime 记录，不是你的对象。返回值按 effect 收集：函数当清理函数；Promise 等它结算，收集结果里的函数，reject 只记日志；同步或异步的可迭代对象逐个收集；`null` 或 `undefined` 忽略；返回其他对象会抛 `TypeError('Invalid effect')`，插件启动失败。

同样的规则也适用于 `ctx.inject(deps, cb)` 和 `ctx.plugin(fn)` 的回调：function 表达式会被 new；箭头回调的返回值被当作 effect，返回 disposer 正好被收集，返回普通对象则报 Invalid effect。

中心插件用第 1 种（当前 `src/host/index.ts` 就是这样写的）：

```js
// 具名导出：同步 apply，不 return；异步初始化放后台；清理全部交给 ctx.effect / ctx.on
export const name = 'agent-hub'                 // 只用于诊断和默认 logger 名
export const inject = ['connection']            // 顶层只放核心必需的服务，见 2.2
export function apply(ctx, config = {}) {
  const abort = new AbortController()
  ctx.effect(() => () => abort.abort(), 'agent-hub: stop init')   // 卸载时通知后台初始化停下
  init(ctx, config, abort.signal).catch((error) => console.error('[agent-hub] init failed:', error))
  // 可选依赖放子插件：webServer 不存在（headless）或重启时，只影响这一块
  ctx.inject(['webServer'], (sub) => {
    sub.effect(() => sub.webServer.register({
      kind: 'exact',
      path: '/agent-hub/ping',
      handler(req, res) { res.end('ok') },
    }), 'agent-hub: ping route')
  })
}
async function init(ctx, config, signal) { /* 读名册、建 Hub、启动 tick…… */ }
```

证据：`cordis-plugin-loader/src/index.ts:201-208`，`cordis-plugin-loader/src/config/entry.ts:223-238`，`cordis/src/registry.ts:91-133、300-302、316-336`，`cordis/src/utils.ts:79-89`，`cordis/src/fiber.ts:250-261、356-400`，`dsh-app-boot/lib/index.js:4216-4252、4535-4541`。核查时用 node 实验复现过：new 一个返回 rejected Promise 的 function 声明，得到的就是那个 Promise，并触发 unhandledRejection。

### 2.2 ctx 上的常用方法

```ts
ctx.effect(execute: () => Effect, label?: string): () => Promise<void>
//   Effect = 清理函数 | Promise<清理函数> | 清理函数的同步或异步可迭代对象 | null | undefined
ctx.on(name: string, listener: Function, options?: boolean | { prepend?: boolean; global?: boolean }): () => unknown
//   传布尔值 true 等于 { prepend: true }；返回手动移除用的取消函数
ctx.emit(name: string, ...args: unknown[]): void
ctx.get(name: string, strict?: boolean): unknown | undefined
ctx.inject(deps: string[], callback: (ctx, config) => Effect): unknown
//   等价于 ctx.plugin({ inject: deps, apply: callback, name: callback.name })
ctx.plugin(mod: object | Function, config?: unknown): unknown
ctx.provide(name: string, value: unknown): () => void
ctx.logger(name?: string): { info(...a): void; warn(...a): void; error(...a): void; debug(...a): void }
```

语义：

- 插件导出的 `inject` 可以是数组，也可以是「服务名 → 拦截配置」的对象。列出的服务全部可用才执行 apply，缺一个就停在 PENDING：可选行启动时只警告「等待服务」，必需行会让启动失败。任何一个被依赖服务的提供方重启或消失，本插件先卸载，服务回来后再重新 apply。证据：`cordis/src/fiber.ts:611-623`，`cordis/src/registry.ts:300-302`。
- 读服务：`ctx.X` 沿本 fiber 和祖先 fiber 查找。没 inject、祖先上也没有，就抛 `cannot get property "X" without inject`。在根上 provide 的服务（`dshHomePath`、`profileContext`），以及 `logger`、`events`、`reflect`、`registry`，不需要 inject。由其他行提供的服务（`webServer`、`agents`、`sessionController`、`timer`……）必须 inject，或用 `ctx.get`。证据：`cordis/src/reflect.ts:136-171`，`cordis/src/context.ts:71-84`，`dsh-app-boot/lib/index.js:4526`，`dsh/lib/profile-boot-C14i-8IN.js:302-305`。
- `ctx.get(name)` 不建立依赖。服务不存在、或者提供方 fiber 不是 ACTIVE 时返回 undefined；服务之后出现，插件也不会重跑。证据：`cordis/src/reflect.ts:233-243`。
- `ctx.inject(deps, cb)` 是处理可选依赖的正确写法：服务齐了才运行，服务消失时整块卸载。
- `ctx.provide(name, value)`：零依赖地提供一个服务，本插件卸载时撤销；同一作用域里已有同名服务就抛错。证据：`cordis/src/reflect.ts:277-305`。
- `ctx.effect(execute, label)`：execute 立即执行，返回的 disposer 可以手动调用，只生效一次。同一个 effect 里的多个清理函数按逆序串行执行。插件整体卸载时，各个顶层 effect、`ctx.on`、`ctx.provide` 的清理函数按逆序启动，但用 `Promise.all` 并发执行，彼此之间没有先后保证。有顺序要求就放进同一个 effect，用生成器依次 yield。fiber 已释放或正在卸载时调用 `ctx.effect`，同步抛 `CordisError('INACTIVE_EFFECT')`。证据：`cordis/src/fiber.ts:351-354、402-442、675-696`，`cordis/src/utils.ts:27-31`。
- `ctx.on`：监听器归本插件 fiber，卸载时自动移除。`{ global: true }` 表示无视派发方的作用域过滤。证据：`cordis/src/events.ts:112-117、288-302`。
- 下面这些不会跟着插件自动清理，必须自己包进 `ctx.effect`：裸 `setTimeout` 和 `setInterval`、`ctx.webServer.register()` 返回的 disposer、`fs.watch`、子进程、Node 全局设置，以及注册在别的上下文（例如机器人的 `agent.ctx`）上的东西。见 2.5。

事件的派发方式由发出方决定，监听器要按方式写：

| 派发方式 | 监听器怎么被调用 | 监听器抛错或 reject | 返回值 |
|---|---|---|---|
| emit | 同步逐个调用，不等待 | 同步异常冒泡给发出方；async 监听器的 reject 没人接，宿主进程退出 | 忽略 |
| parallel | 并发调用，全部等待 | 汇成 AggregateError 抛给发出方 | 忽略 |
| serial | 逐个 await | 第一个异常抛给发出方 | 不是 undefined、null、false 的值会短路，后面的监听器不再执行 |
| bail | 同步逐个调用 | 冒泡给发出方 | 同 serial |
| waterfall | 外层先跑，调用 next() 才进入内层 | 抛给发出方 | 必须 return 决定值或 `next()` 的结果；不调 next 就否决了内层和默认行为 |

证据：`cordis/src/events.ts:13-15、183-243`。哪些事件用哪种方式见 7.5。

### 2.3 Config 与 volatile 字段

- `Config` 可以是任何带 `'~standard'.validate` 的 Standard Schema 对象。官方写法是 `import z from '@deepseek-ai/schemastery'`（链接安装时要写 peerDependencies，见 H32）。validate 必须同步，返回 Promise 会抛「Async config validation is not supported」。校验失败时这一行不激活，只记 error。证据：`cordis/src/fiber.ts:50-62、646-673`。
- schemastery 的 `.volatile()` 字段解析后是一个引用，读值用 `config.x.get()`。只改 volatile 字段时，Loader 就地提交新值，并发出 `loader/volatile-update(paths)`，不重新挂载。改普通字段会整行重新挂载（先卸载，再执行 apply）。手写的 Standard Schema 不识别 volatile，任何改动都整行重挂载。`loader/volatile-update` 只投递给注册在本行根 ctx 上的监听器，ctx.inject 子插件里注册的收不到。证据：`schemastery/README.md:392-394`，`cordis-plugin-loader/src/config/entry.ts:140-197`，`cordis-plugin-loader/README.md:53`。
- Config 不会自动出现在插件页上。要在界面上改配置，客户端得自己注册插槽，见 8.4。
- 中心插件不导出 Config 也行：没有 schema 时，Loader 把行 config（`!!js` 求值后）原样传给 apply。当前做法是 `rootDir` 取自 `config.rootDir`，其次是环境变量 `AGENT_HUB_ROOT`，最后是 `~/AgentHub`。

### 2.4 激活顺序，以及什么会触发重载

激活顺序：import 模块并 unwrapExports → registry.plugin 建 fiber（PENDING）→ 等 inject 的服务全部可用 → 对 config 里的 `!!js` 求值，再跑 `Config` 校验 → 执行 apply → 按 2.1 收集返回的 effect。启动时 `boot()` 会等所有行结束 LOADING。证据：`cordis-plugin-loader/src/config/entry.ts:118-157、223-238`，`cordis-plugin-loader/src/config/tree.ts:35-49`。

会触发卸载或重载的情况：

1. 行被禁用或删除：改 patch、在插件页关掉开关、remove_bundle。
2. 组合包被取消选择或被卸载。
3. 任一 inject 服务的提供方重启或消失。
4. 行 config 的普通字段变了：整行重挂载。只改 volatile 字段时就地提交，不重挂载。
5. HMR 或插件管理器重组：已加载文件变了的插件会被停掉，换上新代码；新代码失败时旧版本不会恢复。
6. 进程退出：SIGINT、SIGTERM 走有界关闭，宽限 5 秒，超时强制退出；桌面宿主收到 shutdown 消息也走这条路。致命错误时最多等 2 秒释放资源。
7. 页面的客户端半边被 dsh-client-hmr 热替换，React 状态会丢。
8. 插件自己调用 `ctx.fiber.dispose()`：Loader 会把它当成「禁用这一行」，把 `disabled: true` 写回配置树。所以要停掉机器人，用中心自己的状态开关，绝不要 dispose 自己。

证据：`cordis/src/fiber.ts:611-696、736-753`，`cordis-plugin-loader/src/index.ts:129-166`，`dsh/lib/profile-boot-C14i-8IN.js:12-71、276-288`，`dsh-desktop-host/lib/index.js:258-262`，`dsh-app-boot/lib/index.js:4174、4216-4252`。

对中心插件的含义：机器人会话不归中心插件（见 2.5），所以上面任何一种重载都不会打断机器人正在跑的回合。但中心自己的定时器、内存状态、注册在机器人 `agent.ctx` 上的工具，都要能在重载后恢复：

- 状态随时落盘（core 的 FileStore 已经这样做）。
- apply 时遍历 `ctx.agents.list()`，给已在线的机器人补装工具（见 4.3）。
- 重载前通过插件自己的 effect 撤销旧工具，避免同名重复注册。

### 2.5 谁持有什么

这一节决定了「插件一重载，哪些东西会被连带清掉」。

| 资源 | 归谁持有 | 中心插件卸载时 | 中心要做什么 |
|---|---|---|---|
| `ctx.sessionController.create` 建出、`resolveAgent` 恢复的会话 | session-controller 那一行 | 不受影响 | 无 |
| `ctx.agents.create` 或 `resume` 建出的会话 | 调用方插件 | 回合被 `cancel({ kind: 'disposed' })` 打断 | 不要用它建机器人会话 |
| `ctx.connection.fetch.register` 的路由 | 调用方插件的 effect | 自动注销 | 无 |
| `ctx.webServer.register` 的路由 | 不登记到任何 effect | 不注销，重载后报 duplicate route | 包进 `ctx.effect` |
| `ctx.on`、`ctx.provide`、`ctx.effect` | 调用方插件 | 自动清理 | 无 |
| 机器人 `agent.ctx` 上的 `tools.register`、`restrict`、`guard`、`on` | 那个会话的 agent | 不清理 | 自己保存 disposer，在插件 effect 里统一调用 |
| `ctx.web.registerSearchProvider` 等 | 调用方插件 | 自动注销 | 无 |
| 裸 `setInterval`、`setTimeout`、`fs.watch`、子进程 | 没有人 | 不清理 | 包进 `ctx.effect` |

为什么 sessionController 建的会话不归调用方（本次回源码核实）：cordis 的服务代理只会把「服务方法里的 `this.ctx`」换成调用方的 ctx，服务对象上的普通数据属性则原样返回。sessionController 在构造时，用自己的 ctx 建了 `ApiSessionAgentController` 和 `SessionCommandController` 两个帮手对象，`create` 和 `resolveAgent` 都委托给它们，而它们用自己保存的 ctx 调 `ctx.agents.create` 或 `resume`。证据：`dsh-api-session-controller/lib/index.js:180-190、511-525、2956-2957、3037-3038、3090-3091`，`dsh-agent/lib/index.js:453-470`（create、resume 以访问者的 ctx 为 owner），`cordis/lib/index.js:123-146`（代理规则），`dsh-agent-loop/lib/index.js:1703-1764`（owner 卸载即取消）。

其他行的证据：`dsh-client-connection/lib/index.js:731-735、840-853`，`dsh-host-webserver/lib/index.js:325-332`，`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:8、19`，`dsh-web/lib/index.js:63-90`。

### 2.6 错误隔离：什么会带崩 DSH

宿主装了 `installFailLoud`：遇到未处理的 Promise 拒绝或未捕获异常，就往 stderr 写一行诊断，最多等 2 秒释放资源，然后 `exit(1)`。桌面版不会自动重启宿主，而是弹原生错误框，按钮是「退出 / 重启 / 禁用第三方插件、备份 profile patch 并重启」。选第三项会把 bundles 重置为 web 模板，并把 profile 的 `cordis.patch.yml` 改名为 `.bak-<毫秒时间戳>`，中心插件和它在 profile 里的配置会一起被摘掉。证据：`dsh-app-boot/lib/index.js:4174、4216-4252`，`_app/main.js:8344-8384、3531-3546、3585-3586`。

会致命的情况：

1. 脱离 apply 的同步回调里抛出未捕获异常：`setTimeout` 和 `setInterval` 的回调（`ctx.timeout`、`ctx.interval` 只负责清理，不捕获异常）、流的 `'data'` 回调、子进程和 `fs.watch` 的回调、`process.nextTick`。在已卸载的 fiber 上调用 `ctx.effect` 或 `ctx.on` 抛出的 INACTIVE_EFFECT 也算。
2. 没人接的 Promise：`void doSomething()`、定时器里调 async 函数却不 `.catch`、`await ctx.timeout(ms)` 在插件卸载时 reject、function 声明式 apply 里 return 出去的 Promise。
3. `ctx.emit` 派发的事件上的 async 监听器 reject。
4. 客户端组合错误：如果在必需行 `modules` 构造时发现，整个 Web 或桌面版启动失败；之后才发生的只记警告（见 H5）。

会被兜住、不会致命的情况：

- apply 同步抛错，或 async apply reject：记 error，这一行标记失败，其他插件照常运行。
- 清理函数抛错：记 error。
- webServer 路由 handler 抛错或 reject：响应头还没发出就返回 400，已发出就销毁 socket，并记警告。但 handler 里另起的、没被 await 的异步任务不受保护。证据：`dsh-host-webserver/lib/index.js:395-406`。
- `session/event`、`session/disposed`、`agent/disposed` 以及 agent 的各个 emit 类事件：派发方逐个兜住，只记警告。证据：`dsh-session/lib/index.js:1231-1240`，`dsh-agent/lib/index.js:242-273、546-557`。

半致命（不崩进程，但会让别的功能失败）：

- `agent/created` 用 serial 派发。监听器抛错或 reject，这个会话就创建或恢复失败，影响 DSH 里所有新建和恢复的会话；监听器返回任何不是 undefined、null、false 的值，后面的监听器（包括官方发 `api-session/added` 的那个）都会被跳过。证据：`dsh-agent/lib/index.js:574-590`，`dsh-api-session-controller/lib/index.js:2986-2990`。
- `session/created`：监听器同步抛错，会否决这次会话创建；返回的 Promise 被 reject 则只记警告。证据：`dsh-session/lib/index.js:1901-1922`。
- waterfall 监听器（`tools/pre-execute`、`agent/pre-step`、`agent/request`、`approval/request` 等）不 return `next()`，就否决了整条链。`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping` 的监听器抛错，这个机器人这一轮会以 error 结束。证据：`dsh-agent-loop/lib/index.js:1001-1006、1010-1026`。

兜底工具（宿主里所有脱离 apply 的回调都包一层）：

```js
// safe.js：同步异常和异步拒绝只记日志；一律返回 undefined（或结果为 undefined 的 Promise）
// 为什么必须返回 undefined：serial 和 bail 派发的事件（如 agent/created）会把非空返回值当成短路
// 注意：waterfall 事件（tools/pre-execute、agent/pre-step 等）不能用它包，必须自己 return next()
export function safe(label, fn) {
  return function guarded(...args) {
    try {
      const result = fn.apply(this, args)
      if (result && typeof result.then === 'function') {
        return result.then(() => undefined, (error) => { console.error(`[agent-hub] ${label} failed:`, error) })
      }
    } catch (error) {
      console.error(`[agent-hub] ${label} failed:`, error)
    }
    return undefined
  }
}

// 调度器：防重入；每次 tick 的同步异常也转成 rejection 再兜住；清理交给 ctx.effect
export function startTicker(ctx, intervalMs, tick) {
  ctx.effect(() => {
    let stopped = false
    let running = false
    const timer = setInterval(() => {
      if (stopped || running) return            // 上一次 tick 还没跑完就跳过这一次
      running = true
      Promise.resolve()
        .then(() => tick())                     // tick 里卸载后调 ctx.effect 抛的 INACTIVE_EFFECT 也会被接住
        .catch((error) => console.error('[agent-hub] tick failed:', error))
        .finally(() => { running = false })
    }, intervalMs)
    return () => { stopped = true; clearInterval(timer) }
  }, 'agent-hub: ticker')
}
```

证据：`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:16`，`cordis-plugin-timer/src/index.ts:31-66`，`cordis/src/events.ts:13-15、204-209`。

### 2.7 日志与诊断

- `ctx.logger(name)` 返回带 info、warn、error、debug 的 logger。产品 profile 没有控制台输出：内置的 exporter 只往内存缓冲写，最多 1000 条，而且默认阈值是 INFO，级别数值 ERROR=0、INFO=1、WARN=2、DEBUG=3，所以缓冲里只有 error 和 info，warn 和 debug 被丢掉。证据：`cordis/src/logger.ts:20-27、141-160、192-225`，`dsh-app-boot/lib/index.js:4507-4522`。
- 运行期调试一律用 `console.*`，加前缀 `[agent-hub]`。桌面版 Host 的 stdout 进 Electron 主进程的 stdout，从 Finder 启动时看不到；stderr 只保留最后 64KB，宿主退出时拼进错误框。web 沙箱里两者都直接打在终端上。证据：`_app/main.js:3794-3816、3841-3846`。
- 启动期诊断写在 stderr：`dsh: warning: N entries did not activate`（下面逐行写阶段和错误，pending 的行会写出在等哪个服务）、`dsh: startup failed: …`、`dsh: skipping profile bundle "<包名>"`、`dsh: disabling profile plugin row "<id>"`。启动失败的完整诊断在 `$DSH_HOME/logs/startup-<时间>-<uuid>.log`，文件开头警告里面可能含配置或凭据值，不要外传。证据：`dsh-app-boot/lib/index.js:538、2306-2309、4038-4083、4405-4466`。
- 直接调 `ctx.logger.info(...)` 时，日志名是插件导出的 `name` 转连字符形式，不是行 id。显式写 `ctx.logger('agent-hub')` 更稳。证据：`cordis/src/logger.ts:252-262`，`cordis/src/fiber.ts:336-343`。
- 要收集 warn 和 debug（例如测试时附上中心插件的告警），自己挂一个 exporter，它随本插件卸载自动移除：

```js
// 只收中心插件自己的日志，最多保留 50 条
const captured = []
ctx.logger.exporter({
  levels: { default: 3 },              // 3 = DEBUG：所有级别都收
  export(message) {
    if (!String(message.name).includes('agent-hub')) return
    captured.push(`${message.type} ${message.name}: ${message.args.map(String).join(' ')}`)
    if (captured.length > 50) captured.shift()
  },
})
```

证据：`cordis/src/logger.ts:232-238`。

### 2.8 中心插件宿主半边骨架

把后面几节的零件拼起来，`src/host/index.ts` 的形状如下。函数名是建议，不是 DSH 的接口。

```js
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { safe, startTicker } from './safe.js'
import { createHostPort } from './host-port.js'          // 第 3 节：建会话、投递、取消、读状态
import { createBotWiring } from './bot-wiring.js'        // 第 4 节：只给机器人装工具、收窄工具
import { installHooks } from './hooks.js'                // 第 5 节：动作闸、审批与提问兜底、回合守卫
import { createTurnTranslator } from './turn-events.js'  // 3.4：会话事件 → TurnEvent
import { registerRoutes } from './routes.js'             // 8.5：界面接口
import { createPusher, registerEvents } from './events.js'   // 8.6：SSE 推送

export const name = 'agent-hub'
// 顶层只放没有就完全不能工作的服务。它们的提供方一重启，本插件整行重载；机器人会话不受影响（2.5）
export const inject = ['connection', 'sessionController', 'workspaceRegistry', 'agents', 'sessions', 'tools']

export function apply(ctx, config = {}) {
  // function 声明会被 new 调用：这里必须同步，不能 return 任何值
  const rootDir = resolveRootDir(config)
  const state = { hub: null, stopped: false }
  const roster = new Map()                                // sessionId → botId，由 Hub 名册同步而来
  const wiring = createBotWiring(ctx, roster, () => state.hub)
  const pusher = createPusher()                           // SSE 推送器：路由和 Hub 订阅共用

  // 1) 路由和 SSE 先注册：引擎没起来时，界面也能显示「启动中」或「已停用」
  registerRoutes(ctx, () => state.hub)
  ctx.inject(['webServer'], (sub) => { sub.effect(() => registerEvents(sub, pusher), 'agent-hub: sse') })

  // 2) 事件与钩子都在 apply 里同步注册，随插件自动清理
  const translator = createTurnTranslator(ctx, roster, () => state.hub)
  ctx.on('session/event', safe('session/event', translator.onSessionEvent))
  ctx.on('agent/created', safe('agent/created', ({ agent }) => { wiring.wireIfBot(agent) }))     // 块体，不返回值
  ctx.on('agent/disposed', safe('agent/disposed', ({ agent }) => { wiring.unwire(agent.id) }))
  installHooks(ctx, { wiring, translator, getHub: () => state.hub })
  ctx.effect(() => () => wiring.unwireAll(), 'agent-hub: unwire bots')   // agent.ctx 上的注册要自己撤

  // 3) 停用开关：只提供界面，不启动引擎
  if (existsSync(join(rootDir, '.hub', 'DISABLED'))) { console.warn('[agent-hub] 已停用'); return }

  // 4) 引擎：卸载时先标记停止，再等 hub.stop()
  ctx.effect(() => async () => {
    state.stopped = true
    state.unsubscribe?.()
    await state.hub?.stop()
  }, 'agent-hub: stop hub')
  startTicker(ctx, 60_000, () => state.hub?.tick())
  init(ctx, rootDir, roster, wiring, pusher, state).catch((error) => console.error('[agent-hub] init failed:', error))
}

async function init(ctx, rootDir, roster, wiring, pusher, state) {
  const host = createHostPort(ctx, roster, wiring)
  const hub = createHub({ host, /* clock、rng、fs、net、exec、logger、store：用 core 的系统实现 */ })
  await hub.start()
  if (state.stopped) { await hub.stop(); return }         // 启动途中插件已被卸载
  state.hub = hub
  state.unsubscribe = hub.subscribe((event) => pusher.broadcast(event))   // Hub 变更 → SSE
  for (const agent of ctx.agents.list()) wiring.wireIfBot(agent)   // 补装已在线的机器人
}
```

要点：

- `ctx.on`、`ctx.effect` 都在 apply 里同步注册。init 里 await 之后不要再调 `ctx.effect`，否则插件可能已经卸载，抛 INACTIVE_EFFECT。
- 其余服务（`permissionPresets`、`approval`、`sandboxPolicy`、`agentDefaultModel`、`sessionProjections`、`commands`、`llm`、`web`）在用到时 `ctx.get(...)`。取不到就按「失败即关闭」处理，例如拿不到 `approval` 就不唤醒机器人，因为没法把审批策略设成 never。
- 这些服务都只在 web 和桌面版的组合里存在。headless 组合里没有 `sessionController`、`workspaceRegistry`，中心插件会一直 PENDING，这是预期行为。证据：`dsh-web-app/cordis.patch.yml:91、121、139、179、591`。

## 3 会话控制

这一节对应 HostPort 的 `createSession`、`deliver`、`steer`、`cancel`、`sessionInfo`、`listRecentSessions`、`readSessionDigest`，以及 TurnEvent 的翻译。

### 3.1 服务与签名

以下服务只在 web 和桌面版组合里存在（`dsh-web-app` 挂载），headless 没有。

```ts
// ctx.sessionController（服务名 sessionController）
create(request: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId; agentPreset?: string }): Promise<{ sessionId: SessionId; agentPreset?: string }>
prompt(request: { requestId: string; sessionId: SessionId; mode: 'queue' | 'steer'; content: PromptContentPart[]; clientTimeZone?: string }, signal: AbortSignal): Promise<{ accepted: true }>
resolveAgent(sessionId: SessionId): Promise<{ agent: Agent } | { error: RemoteError }>
cancel(request: { sessionId: SessionId }): { accepted: true }                     // 同步方法
projections(request: { sessionId: SessionId }, signal: AbortSignal): Promise<null | { kind: 'sequenced'; asOfSeq: number; values } | { kind: 'migration-required'; values }>
selectModel(request: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }): Promise<{ selected: ModelSelection }>
rename(request: { sessionId: SessionId; title: string }): Promise<{ title: string; seq: number }>
list(request: { cursor?: string }, signal: AbortSignal): Promise<{ items: SessionSummary[] }>
inspect(sessionId: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; inheritedEventCount: number; events: SessionEvent[] }>
modelCatalog(): Promise<ModelCatalog>

// ctx.workspaceRegistry
create(path: string, title?: string): Promise<Workspace>       // path 必须是已存在的绝对目录；同一规范路径复用已有工作区
resolveByPath(path: string): Promise<Workspace | undefined>
list(): Workspace[]
get(id: WorkspaceId): Workspace | undefined
archiveSession(sessionId: SessionId, options?: { stopActivity?: boolean }): Promise<void>
// Workspace = { id, path, title, createdAt, updatedAt, sessionIds, attachSession(id), detachSession(id), status(), … }

// ctx.sessions
get(id: SessionId): Session | undefined                       // 只返回已在内存里的会话
flush(session: Session): Promise<boolean>

// ctx.agents
get(id: SessionId): Agent | undefined
list(): Agent[]
roots(): Agent[]                                               // 没有 owner 的 agent；sessionController 建的会话都是根
```

会话对象（Agent）上中心会用到的成员：

```ts
agent.id                       // 就是 sessionId
agent.session                  // Session：header、append(type, data)、seq 等
agent.session.header           // { version, id, createdAt, cwd?, parentSession?, isSeeded, origin?: 'subagent', delegationDepth?, agentPreset? }
agent.ctx                      // 这个会话自己的作用域 ctx，见 4.3
agent.followup(message)        // 放进下一轮队列（next-turn）并唤醒
agent.steer(message)           // 放进下一步队列（next-step）并唤醒
agent.inject(message)          // 放进下一步队列，不唤醒
agent.cancel(cause, { keepInbox?: boolean })
agent.whenIdle(): Promise<void>
agent.status                   // 'idle' | 'running'；等审批时算 running，维护（压缩）期间算 idle
agent.inbox.nextTurn / agent.inbox.nextStep / agent.inbox.hasPending   // 只读；ReactLoopInbox 是包内部类型，无稳定承诺
```

注意事项：

- 在宿主内直接调这些方法，不经过网关，也不做 schema 校验。多余字段被静默丢弃；`mode` 只要不是 `'steer'` 就按 queue 处理；缺字段不会被友好地拒绝，而是在写日志时失败。例如 `prompt` 漏传 `requestId`，消息来源里就会出现 `rpcId: undefined`，写日志时被拒绝，最后包装成 `session/agent-busy`「prompt rejected」，真正原因在 `error.data.reason` 里。证据：`dsh-typert-protocol/lib/index.js:339-352、440-448`，`dsh-api-session-controller/lib/index.js:957-961、3218-3232`。
- `prompt`、`projections`、`list` 的 signal 必须传。`prompt` 第一行就是 `signal.throwIfAborted()`，不传直接 TypeError。用 `AbortSignal.timeout(30_000)`。
- `cancel` 是同步方法：会话不在线时，它同步抛出 `session/not-found`，不是返回 rejected Promise，所以要用 try/catch，不能只写 `.catch()`。证据：`dsh-api-session-controller/lib/index.js:1061-1067、3253-3255`。
- `resolveAgent` 从不抛错，失败时返回 `{ error }`，错误码有 `session/not-found`、`session/writer-held`（别的进程持有写锁），以及 `gateway/internal`（恢复失败，原因只在 message 文本里，例如 preset 找不到）。冷会话会被恢复成在线 agent。证据：`dsh-api-session-controller/lib/index.js:210-246`。
- `rename` 需要 sessionTitle 服务，否则报 `gateway/internal`。它写一条 source.kind 为 user 的 `session/title`，标题从此钉住，不再自动改。证据：`dsh-session-title/lib/index.js:295-311`，`dsh-session-title/README.zh.md:32`。

证据：`api-catalog:162-245、1994-2122、2442-2495、3848-3908、4748、6988、7004-7008、7143-7144、7272、7296、7320、7368、8668`，`dsh-api-session-controller/lib/index.js:3046、3061、3098、3121、3196、3253、3281`，`dsh-agent-loop/lib/index.js:80-90、752、780、790-821、854-875`。

### 3.2 建机器人会话

`create` 的规则：

- 只认 4 个字段：`workspaceId` 和 `cwd` 二选一，`agentPreset`，`sessionId`。两个都给报 `gateway/bad-request`。两个都不给，工作目录就是 Host 进程的 cwd，即 `$DSH_HOME/profiles/desktop`，所以绝不能省略。
- 用 `workspaceId` 时，工作目录取工作区的规范路径，建完自动挂到这个工作区下；工作目录不存在会被 `mkdir -p`。
- `sessionId` 的含义是「复用这个空白会话」，不是「按 id 取或建」：这个 id 下没有任何存储，才用它新建；有存储、目录相同、仍是空白（没有 turn/start）、没归档、属于指定工作区、没被别人持写锁，才原地复用；目录不同报 `session/conflict`；其余情况一律静默新建 `session-<uuid>`。所以永远以返回的 sessionId 为准。
- 标题、权限档、模型都不能通过 create 指定，传了也会被丢弃，要在创建后分别设置。
- `agent/created` 事件在 `create` 返回之前就会触发。想在那个监听器里认出新机器人，要先生成一个必然不存在的新 id 并登记进名册，再调用 create。

证据：`dsh-api-session-controller/lib/index.js:264-268、416-470、508-526、755-791`，`dsh-workspace/lib/index.js:111-129、408-412`。

配方（HostPort.createSession 的实现骨架）：

```js
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

/**
 * 给一个机器人建 DSH 会话，返回最终的 sessionId。
 * roster：Map<sessionId, botId>；wiring：4.3 的工具装配器。
 * bot：{ id, name, home（家目录绝对路径）, model: { provider, model, reasoningEffort? } | null }
 * 第一条消息由调用方随后用 3.3 的 deliverWake 投递。
 */
export async function createBotSession(ctx, roster, wiring, bot) {
  // 1) 家目录必须先存在：workspaceRegistry.create 要求已存在的绝对目录
  await mkdir(bot.home, { recursive: true })
  // 2) 每个机器人一个工作区：同一规范路径复用，没有就新建，标题用机器人名字
  const ws = (await ctx.workspaceRegistry.resolveByPath(bot.home))
    ?? (await ctx.workspaceRegistry.create(bot.home, bot.name))
  // 3) 预先生成 id 并登记：agent/created 早于 create 返回，届时要能认出这是机器人
  const wanted = `session-${randomUUID()}`
  roster.set(wanted, bot.id)
  let created
  try {
    created = await ctx.sessionController.create({ workspaceId: ws.id, sessionId: wanted, agentPreset: 'standard' })
  } catch (error) {
    // 预生成 id 这条路依赖 session-query 对新 id 报「找不到」，没实测（H7）：失败就退回不指定 id 的建法
    roster.delete(wanted)
    console.warn('[agent-hub] create with pre-minted id failed, retrying without it:', error)
    created = await ctx.sessionController.create({ workspaceId: ws.id, agentPreset: 'standard' })
  }
  const sessionId = String(created.sessionId)
  if (sessionId !== wanted) roster.delete(wanted)
  roster.set(sessionId, bot.id)                            // 一律以返回值为准
  // 4) 钉住标题
  await ctx.sessionController.rename({ sessionId, title: bot.name })
  // 5) 取到会话对象；resolveAgent 不抛错，失败时返回 { error }
  const found = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in found) throw found.error
  const { agent } = found
  wiring.wireIfBot(agent)                                  // 幂等：agent/created 里可能已经装过
  ensureBotPolicy(ctx, agent.session)                      // 6.2：沙箱 workspace-write，审批 never
  if (bot.model) await selectModelKeepDefault(ctx, sessionId, bot.model)   // 3.5
  if (!(await ctx.sessions.flush(agent.session))) console.warn('[agent-hub] flush returned false', sessionId)
  return sessionId
}
```

补充：

- 新会话在第一轮开始之前都是「空白会话」，DSH 左侧栏不显示它（当前选中的除外），见 3.8。
- 空白会话靠 200 毫秒批量写盘，约 200 毫秒内落盘（推断，见 H8）；显式 `flush` 之后再登记进中心名册最稳。`flush` 返回 true 只表示「至少有一个持久化监听器参与且都成功」，不严格等于「这个会话已写盘」；经 sessionController 建出的会话都有写句柄，可以视为已落盘。证据：`dsh-session-persistence-jsonl/lib/index.js:187-194、421-432、2465-2480`，`dsh-session/lib/index.js:1951-1966`，`dsh-schedule/lib/index.js:1586-1597`。

### 3.3 发消息：唤醒、主人的话

有两条路。中心的唤醒一律走第 1 条。

**第 1 条：手工构造消息，交给 `agent.followup` / `steer` / `inject`**

- `followup(message)`：放进下一轮队列并唤醒。空闲时开新一轮；正在跑时，等这一轮结束后接着开一轮。
- `steer(message)`：放进下一步队列并唤醒，正在跑的这一轮会在下一步看到它。
- `inject(message)`：放进下一步队列但不唤醒。agent 空闲时它会一直排着，直到别的东西唤醒这个会话；正在跑时，即使错过了这一轮最后一次检查，这一轮结束后也会因为队列非空立刻开新一轮。
- 唤醒时如果 agent 正在中止，目标自动改成下一轮，收尾后再唤醒。
- 领取规则：每一步先领取下一步队列的全部消息；第 1 步另外领取下一轮队列里的 1 条。
- 证据：`dsh-agent-loop/lib/index.js:103-111、800-821、885-893、1037-1041`。

消息的硬约束（任何一条不满足都会同步抛错，或让会话以后打不开）：

1. 形状是 `{ id, role: 'user', content: ContentBlock[], source: { kind, … } }`，并深冻结。id 必须是非空字符串。证据：`dsh-llm/lib/index.js:37-64`，`dsh-session/lib/index.js:1086-1090、1194-1215`。
2. 整条消息（包括 source 里的自定义字段）不能有值为 undefined 的属性。整条消息会写进 `agent/inbox/spliced` 事件，`Session.append` 校验时遇到 undefined 会直接抛「non-JSON-serializable」。证据：`dsh-agent-loop/lib/index.js:200-206`，`dsh-session/lib/index.js:1517-1537`，`dsh-util-values/lib/index.js:739`。
3. 同一个消息 id 已经在任一队列里，再入队会直接抛 `message "<id>" is already pending`，不会静默去重。证据：`dsh-agent-loop/lib/index.js:186-193`。
4. `source.kind` 必须是非空字符串，不能是 `'plugin'`（v4 会话格式恢复时会拒绝，会话从此打不开），也不要用 `'user'`（goal 工具会把它当作人类授权，tool-jobs 会因此重置唤醒预算）。用 `'agent-hub'`。证据：`dsh-session-format-v3-to-v4/lib/index.js:123-127`，`dsh-tool-goal/lib/index.js:44-53`，`dsh-tool-jobs/lib/index.js:231-233`。
5. 不能在同一个会话的 `session/event` 同步派发阶段里投递，会因为重入而抛错。在事件监听器里要投递时，用 `setImmediate` 推迟。证据：`dsh-session/lib/index.js:1568-1571`。
6. 不要往已归档的会话投递：归档门禁在 `agent/pre-step` 拒绝，这一轮以 blocked 结束，领到的消息被吞掉，不会重新排队。证据：`dsh-api-session-controller/lib/index.js:2508-2518`，`dsh-agent/lib/index.js:53-60`。

自定义来源在界面和其他功能上的表现：

- DSH 会话界面把非 user 来源渲染成上下文行，标签默认是 kind；唤醒这一轮的那条渲染成触发行；`form: 'notice'` 且 `summary` 非空时显示 summary（上限 120 字）。证据：`dsh-client-ui-chat/lib/client.js:9877-9925、7756-7805、4872-4875`，`dsh-llm/lib/index.js:15-23`。
- 代价：不触发自动标题（中心自己 rename，无所谓）；turnOutline 的 prompt 为空；不更新 lastPromptAt，侧栏里不上浮；不发 `api-session/activity`；`requestId` 幂等不适用，要自己按 wakeId 查队列去重。证据：`dsh-session-title/lib/index.js:91`，`dsh-session-turn-outline/lib/index.js:97-108`，`dsh-api-session-controller/lib/index.js:1128-1139、1871-1879、2997-3004`。
- 官方先例：dsh-schedule 用 `{ kind: 'schedule' }` 加 followup 再 flush；dsh-tool-jobs 用 `{ kind: 'tool-jobs', form: 'notice', summary }`。证据：`dsh-schedule/lib/index.js:1586-1597`，`dsh-tool-jobs/lib/index.js:271-295`。

HostPort.deliver 和 steer 的实现：

```js
import { randomUUID } from 'node:crypto'

// 深冻结：和官方 createUserMessage 一样，消息交出去以后不能再被改
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}
// 去掉值为 undefined 的键：Session.append 遇到 undefined 会拒绝整条事件
const defined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))

/** 构造一条中心发出的用户消息；kind 固定写在最后，保证不会被调用方覆盖成 'user' 或 'plugin' */
export function hubMessage(text, source) {
  return deepFreeze(structuredClone({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: defined({ ...source, kind: 'agent-hub' }),
  }))
}

/** HostPort.deliver：投递一次唤醒。返回 'queued'，或者这张唤醒单已在队列里时返回 'duplicate'。 */
export async function deliverWake(ctx, sessionId, text, { wakeId, botId, variant }) {
  const found = await ctx.sessionController.resolveAgent(sessionId)   // 冷会话会被恢复
  if ('error' in found) throw found.error
  const { agent } = found
  const same = (m) => m.source?.kind === 'agent-hub' && m.source.wakeId === String(wakeId)
  if (agent.inbox.nextTurn.some(same) || agent.inbox.nextStep.some(same)) return 'duplicate'
  agent.followup(hubMessage(text, {
    form: 'notice',
    summary: `中心唤醒：${variant}`.slice(0, 120),
    wakeId: String(wakeId), botId: String(botId), variant: String(variant),
  }))
  await ctx.sessions.flush(agent.session)                          // 官方 schedule 投递后也立刻 flush
  return 'queued'
}

/** HostPort.steer：往正在跑的回合里插一句话（例如「该交账了」） */
export async function steerBot(ctx, sessionId, text) {
  const found = await ctx.sessionController.resolveAgent(sessionId)
  if ('error' in found) throw found.error
  found.agent.steer(hubMessage(text, { form: 'notice', summary: text.slice(0, 120), purpose: 'steer' }))
}
```

**第 2 条：`sessionController.prompt`，只用于主人亲手写的话**

`prompt` 把消息的来源写死为 `{ kind: 'user', rpcId: requestId, clientTimeZone?, principal? }`。内部顺序是：`resolveAgent` → 检查幂等（两条队列，加上内存日志里有没有 source.kind 为 user 且 rpcId 等于 requestId 的消息）→ 构造消息 → `mode === 'steer'` 时 steer，否则 followup。证据：`dsh-api-session-controller/lib/index.js:925-964、1128-1139、3218-3232`。

用它的好处：在 DSH 自己的会话界面里显示成主人的气泡，侧栏会上浮，同一个 requestId 重复调用只入队一次。代价：这条消息带「人类授权」，goal 工具会认；会触发 `api-session/activity`，所以中心判断主人是否活跃时要排除自己转发的消息（见 7.6）。

```js
/** 把主人在中心线程里写的原话原样转给机器人（可选；默认做法是把原话放进唤醒包里，走第 1 条） */
export async function relayOwnerWords(ctx, sessionId, messageId, text, tz) {
  await ctx.sessionController.prompt({
    sessionId,
    requestId: `agent-hub:owner:${messageId}`,       // 必须是非空字符串；前缀让翻译器认出是中心转发的
    mode: 'queue',
    content: [{ type: 'text', text }],
    ...(tz === undefined ? {} : { clientTimeZone: tz }),   // 不要写 clientTimeZone: undefined
  }, AbortSignal.timeout(30_000))                    // 第二个参数必填
}
```

### 3.4 判断一轮结束，拿结果

订阅方式：在中心插件的根 ctx 上 `ctx.on('session/event', (session, event) => …)`。根 ctx 没有作用域标签，能收到所有会话（包括 preset 作用域的会话和子代理会话）每一条已提交的事件。`event` 的形状是 `{ type, seq, time, data, ignorable? }`。证据：`dsh-session/lib/index.js:1576-1595`，`dsh-scope/README.zh.md:75`，`dsh-scope/lib/index.js:327-338`。

约束：

- 监听器在 `Session.append` 提交阶段同步执行：不能对同一个会话再 append、followup、steer、inject（会抛重入错误，被吞掉只记警告），要用 `setImmediate` 推迟。
- 监听器抛错只记警告，不影响别的监听器。
- 只在实时追加时触发，重启后不会重放历史事件；需要的状态要自己落盘。
- 证据：`dsh-session/lib/index.js:1227-1240、1567-1597`。

一轮的事件顺序（已改正）：

```text
turn/start {turn}
→ agent/inbox/spliced                  第 1 步之前领取输入
→ [compaction/start、compaction/summary、user/message(compact-checkpoint)、compaction/end]   自动压缩时才有
→ step/start {turn, step}
→ [system/message]
→ user/message …                       本步领取的输入，只在首次尝试时写
→ [request/header {header: {config, tools?}, reason: 'initial' | 'resume' | 'change' | 'series'}]
→ [developer/message]                  工具增删时才有
→ [request/context {provider, model, contextWindow?}]   变化时才写
→ assistant/message {turn, step, message, usage?, stream, interrupted?}；失败或重试的尝试写 assistant/attempt
→ tool/call {turn, step, callId, name, arguments}
→ [approval/asked {id, toolName, callId?, reason?} → approval/decided {id, outcome}]
→ tool/result {turn, step, message: {id, role: 'tool', toolCallId, content, isError}, error?, meta?}
→ step/end
→（有工具调用就进入下一步：agent/inbox/spliced → step/start …）
→ turn/end {turn, reason}
```

`turn/end` 的 `reason.kind`：

- `completed`：正常结束。
- `blocked`：被 `agent/pre-step` 拒绝（归档门禁，或中心自己的步数闸）。
- `aborted`：`reason.reason` 是 `{ kind: 'user' | 'parent' | 'disposed' | 'hook' | 'legacy', reason? }`。
- `error`：`reason.error` 是 `{ message, code, status?, providerRetryAfterMs?, requestId? }`。
- `max-tokens`：输出达到上限。
- `interrupted`、`forked`：只出现在崩溃恢复、fork 时合成的收尾事件里。

证据：`dsh-agent-loop/lib/index.js:906、938-1041、1043-1073、1098-1162、1214-1271、681-707`，`dsh-session/lib/index.js:750-794、908`，`dsh-session/lib/types/known-event-types.js:21-84`，`api-catalog:8303-8312`。

取结果：

- 最终回复：本轮最后一条有文本的 `assistant/message`，把 `message.content` 里 `type === 'text'` 的块拼起来。
- 工具调用：`tool/call` 和 `tool/result` 按 `callId` 与 `message.toolCallId` 配对，`isError` 表示失败。
- 用量：`assistant/message.usage`；没有 usage 字段时，取 `stream` 里最后一个 `{ type: 'chunk', chunk: { type: 'usage', usage } }`；失败的尝试 `assistant/attempt` 也要算；上下文压缩的用量在 `compaction/summary.usage`（这条没有 turn 和 step）。TokenUsage = `{ inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`，其中 inputTokens 是未命中缓存的输入。证据：`dsh-token-meter/lib/index.js:326-331、367-372、393-428`，`dsh-llm-pi-ai/lib/index.js:1439-1447`，`dsh-compaction-basic/lib/index.js:629-648`。
- 子代理的用量在子会话里：`header.origin === 'subagent'`，`header.parentSession` 指向父会话。

审批事件的含义：机器人的审批策略是 never 时，`approval/asked` 后面紧跟 outcome 为 rejected 的 `approval/decided`，表示这次提权被自动拒绝，不是「卡在 DSH 审批框」。只有策略是 ask、并且迟迟没有配对的 decided，才算卡住。证据：`dsh-user-approval/lib/index.js:128-144、172-189`。

HostPort 回合事件翻译器（TurnEvent 见 build-spec 第 14 节）：

```js
/**
 * 把 DSH 会话事件翻译成 core 的 TurnEvent。
 * 机器人会话：started / step / ended / error / awaiting_approval / owner_direct。
 * 其他顶层会话：只用来感知主人活动和外部会话的结束。
 */
export function createTurnTranslator(ctx, roster, getHub) {
  const turns = new Map()                       // sessionId → { steps, tokens, finalText, calls }
  const committedThisTurn = new Set()           // 本轮已成功交账的 sessionId（5.6 的催交账要用）
  const textOf = (message) => (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  const usageOf = (event) => {
    if (event.data.usage !== undefined) return event.data.usage
    const stream = event.data.stream ?? []
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const r = stream[i]
      if (r.type === 'chunk' && r.chunk.type === 'usage') return r.chunk.usage
    }
    return undefined
  }
  const addTokens = (t, usage) => {
    if (!t || !usage) return
    t.tokens = (t.tokens ?? 0) + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  }
  // 主人亲手写的消息：来源是 user，并且不是中心或桥转发的
  const isOwnerWords = (data) => data.source?.kind === 'user'
    && !String(data.source.rpcId ?? '').startsWith('agent-hub:')
    && !String(data.source.rpcId ?? '').startsWith('claude-bridge-')

  return {
    committedThisTurn,
    onSessionEvent(session, event) {
      const hub = getHub()
      if (!hub) return
      const sessionId = String(session.id)
      const header = session.header
      const isBot = roster.has(sessionId) || hub.botIdForSession(sessionId) !== null   // 预登记 + Hub 名册
      if (!isBot || header.origin === 'subagent') {
        // 非机器人的顶层会话：感知主人活动、外部会话结束
        if (header.origin === 'subagent') return
        if (event.type === 'user/message' && isOwnerWords(event.data)) hub.onOwnerActivity(event.time)
        if (event.type === 'turn/end') {
          const title = ctx.get('sessionProjections')?.snapshot(session, ['title'])?.values?.title ?? sessionId
          const failed = event.data.reason.kind === 'error'
          setImmediate(() => hub.onExternalSessionEvent({ type: failed ? 'error' : 'finished', sessionId, title, at: event.time, summary: failed ? String(event.data.reason.error?.message ?? '') : '' }))
        }
        return
      }
      const t = turns.get(sessionId)
      switch (event.type) {
        case 'turn/start':
          turns.set(sessionId, { steps: 0, tokens: null, finalText: '', calls: new Map() })
          committedThisTurn.delete(sessionId)
          hub.onTurnEvent({ type: 'started', sessionId, at: event.time })
          return
        case 'tool/call':
          t?.calls.set(event.data.callId, event.data.name)
          return
        case 'tool/result':
          if (t?.calls.get(event.data.message.toolCallId) === 'hub_commit' && !event.data.message.isError) committedThisTurn.add(sessionId)
          return
        case 'assistant/message': {
          const text = textOf(event.data.message)
          if (t && text !== '') t.finalText = text
          addTokens(t, usageOf(event))
          return
        }
        case 'assistant/attempt':
          addTokens(t, usageOf(event))
          return
        case 'step/end':
          if (!t) return
          t.steps += 1
          hub.onTurnEvent({ type: 'step', sessionId, at: event.time, steps: t.steps, tokens: t.tokens })
          return
        case 'approval/asked':
          // never 策略下会立刻被自动拒绝，不是卡住；只有 ask 策略才报 awaiting_approval
          if (ctx.get('approval')?.overrideOf(session) !== 'never') {
            hub.onTurnEvent({ type: 'awaiting_approval', sessionId, at: event.time, tool: event.data.toolName, summary: String(event.data.reason ?? '') })
          }
          return
        case 'user/message':
          if (isOwnerWords(event.data)) hub.onTurnEvent({ type: 'owner_direct', sessionId, at: event.time, text: textOf(event.data) })
          return
        case 'turn/end': {
          turns.delete(sessionId)
          const reason = event.data.reason
          // 同步阶段不能对同一会话 append：交给 core 前先推迟一拍
          setImmediate(() => {
            if (reason.kind === 'error') {
              hub.onTurnEvent({ type: 'error', sessionId, at: event.time, errorText: `${reason.error?.code ?? ''} ${reason.error?.message ?? ''}`.trim() })
            } else {
              hub.onTurnEvent({ type: 'ended', sessionId, at: event.time, finalText: t?.finalText ?? '', tokens: t?.tokens ?? null })
            }
          })
          return
        }
      }
    },
  }
}
```

说明：

- 这个翻译器整体被 `safe()` 包着注册（见 2.8），`setImmediate` 里的回调由 core 自己兜底；core 的 `onTurnEvent` 如果可能抛错，也要包一层 try/catch。
- TurnEvent 的 `ended` 没有 reason 字段，`blocked`、`aborted`、`max-tokens` 都被当成 ended。core 如果需要区分，可以在 TurnEvent 上加 `reasonKind`（规格变更由总控决定）。
- 主人在 DSH 原生界面里给机器人会话发的消息，会先以 `agent/inbox/inserted { agent, message }` 出现（入队时），轮到处理时才写成 `user/message`。要尽早知道，可以再监听 `agent/inbox/inserted`。证据：`dsh-agent-loop/lib/index.js:180-208`。
- `agent.whenIdle()` 等的是整条驱动链（包括已经排队的后续轮次和维护任务），不是单独一轮。证据：`dsh-agent-loop/lib/index.js:854-875`。

### 3.5 按机器人选模型，不改全局默认

一个会话真正使用的模型，按下面的顺序取：

1. `selectModel` 留下的待用选择（picked）。
2. 日志里最近一条 `request/header` 的模型（会话「黏」在它上面）。
3. 当前的全局默认模型，每次组装时实时读取。

所以，没调过 `selectModel`、也还没发过请求的新会话，用的是「第一次请求那一刻」的全局默认，不是创建时的。给机器人定模型，必须显式设置。证据：`dsh-api-session-controller/lib/index.js:274-300`，`dsh-agent/lib/index.js:167-191`。

`selectModel` 的流程：`resolveAgent`（会恢复冷会话）→ 检查 provider 在 `listProviders` 里、model 在 `listModels` 里，否则报 `session/model-unavailable` → 补全参数（没给 reasoningEffort 时补成模型的默认强度）→ 追加一条 `model/selection` 事件并设为待用选择 → 在后台（不等待）调用 `agentDefaultModel.saveSelection(selected)`，把它存成全局默认。`saveSelection` 内部用一条 Promise 链串行写入，所以 `selectModel` 返回后立刻 `await saveSelection(prev)`，一定排在后面，最终全局默认还是 prev。provider 必填。证据：`dsh-api-session-controller/lib/index.js:793-823、966-971`，`dsh-agent-default-model/lib/index.js:38-67`，`dsh-llm/lib/index.js:2174-2219`。

推荐做法（建会话和改机器人模型时用）：

```js
let modelChain = Promise.resolve()   // 所有「改会话模型」串行执行，避免两次还原互相覆盖

/** 给一个会话选模型，并立刻把全局默认还原成调用前的值 */
export function selectModelKeepDefault(ctx, sessionId, choice) {
  const run = async () => {
    const defaults = ctx.get('agentDefaultModel')
    const prev = defaults?.currentSelection()          // { provider, model, reasoningEffort? }
    const { selected } = await ctx.sessionController.selectModel({
      sessionId,
      provider: choice.provider,                        // 必填
      model: choice.model,
      ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
    })
    if (prev) await defaults.saveSelection(prev)        // selectModel 在后台把选择存成了全局默认：还原
    return selected
  }
  const result = modelChain.then(run, run)
  modelChain = result.then(() => undefined, () => undefined)
  return result
}
```

注意：

- prev 取自 `currentSelection()`。如果主人刚在界面里改了默认、保存还没提交，还原会把主人的改动盖掉（见 H10）。所以只在建机器人、改机器人设置这类主人主动操作时调用，不要在后台定时调用。
- 没有 configEditor 时，`saveSelection` 直接返回，不写也不报错。

模型目录（不读凭据）：

```ts
ctx.sessionController.modelCatalog(): Promise<{ default; routableProviders; groups: [{ id, name, models: [{ id, name, description?, reasoning?: { efforts: [{ id, name }], defaultEffort? } }] }]; failures: [{ id, name, message }] }>
ctx.llm.listProviders(): Array<{ id: string; name: string }>
ctx.llm.listModels(provider: string): Promise<Array<{ provider, id, name, description?, inputModalities? }>>
ctx.llm.resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ provider, id, name, context?: { contextWindow }, defaultMaxTokens?, reasoning? }>
ctx.agentDefaultModel.currentSelection(): { provider, model, reasoningEffort? }
ctx.agentDefaultModel.saveSelection(next: { provider, model, reasoningEffort? }): Promise<void>
```

签名证据：`api-catalog:22-28、1370、1431、1437、5884、5896`。

- 判断「已配置、可用」看 `listProviders()` 或 `modelCatalog().routableProviders`，不要看 `listConfigurableProviders()`：pi-ai 会给它目录里的每个供应商都声明一条，即使用户没配置。
- DeepSeek：路由 `deepseek-official`（密钥环境变量名 `DEEPSEEK_API_KEY`）和 `deepseek-account`（账号登录）；内置模型 `deepseek-flash`（上下文 1,048,576）和 `deepseek-v4-pro`；推理强度 off、low、high、max，默认 high。dsh-base 出厂默认是 `deepseek-official` / `deepseek-flash`。没有 key 或没通过认证时目录为空。
- GLM：走 `dsh-llm-pi-ai`，默认休眠，配了 providers 才注册路由。路由 id 就是 pi-ai 设置里 providers 字典的键名；pi-ai 目录里有 `zai` 和 `zai-coding-cn`。主人实际用的键名要在运行时打印确认（见 H12）。pi-ai 的推理等级是 off、minimal、low、medium、high、xhigh、max。
- 证据：`dsh-api-session-controller/lib/index.js:563-611、3121-3123`，`dsh-llm/lib/index.js:1908-1910、1964-1966、2086-2104、2111-2170、2416-2427`，`dsh-llm-pi-ai/lib/index.js:2784-2791、2841-2857、2943-2953`，`dsh-llm-deepseek/lib/index.js:16-31、36-40、472-546`，`dsh-llm-deepseek-api-key/lib/index.js:8-13、139-148`，`dsh-base/cordis.patch.yml:89-94、128-136`。

另一种做法：`agent/request` 钩子按回合改路由。适合「额度紧张时临时换便宜模型」这类动态需求，规则和代码见 5.4。两种做法不要混用：钩子改道的路由和 picked 不一致时，picked 永远消费不掉，而且几乎每一步都会往日志里追加一条方向相反的 `[model changed]` 通知（见 5.4 和 H11）。

### 3.6 上下文用量

token meter 在宿主层注册了 `contextPressure` 投影，wire 形状是 `{ contextWindow?, pressureTokens?, projectedTokens? }`：

- `pressureTokens` = 最近一次请求的未缓存输入 + cacheRead + cacheWrite。
- `projectedTokens` = max(0, pressure + 当前上下文估算 − 上次采样时的估算)。
- `contextWindow` 取自最近一条 `request/context`。
- 占用率与 DSH 界面一致：`used = projectedTokens ?? pressureTokens`，`ratio = used / contextWindow`。
- 第一次请求之前是空对象；之后 contextWindow 先出现，pressureTokens 后出现。估算按 4 个字符算 1 个 token，会低估中文的增量。
- `tokenUsage` 投影是累计计费量，不能当上下文占用。

证据：`dsh-token-meter/lib/types/usage-projection.js:121-188`，`dsh-token-meter/lib/types/estimate.js:9`，`dsh-client-ui-conversation/lib/client.js:18641-18649`。

读取：

```ts
ctx.sessionProjections.snapshot(session: Session, keys?: string[]): { asOfSeq: number; values: Record<string, unknown> }   // 在线会话，同步，wire 形状
ctx.sessionProjections.stateOf(session: Session, key: string): unknown | undefined                                      // 在线会话，内部状态
ctx.sessionProjections.onChanged(listener: (session, key, value, seq) => void): () => void
ctx.sessionController.projections({ sessionId }, signal)                                                                 // 冷会话，不激活 agent
```

```js
/** HostPort.sessionInfo 里的 contextRatio：在线会话直接读；不在线时读冷投影；还没数据返回 null */
export async function contextRatio(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  let view
  if (session) {
    view = ctx.get('sessionProjections')?.snapshot(session, ['contextPressure'])?.values?.contextPressure
  } else {
    const result = await ctx.sessionController.projections({ sessionId }, AbortSignal.timeout(10_000))
    view = result?.values?.contextPressure
  }
  const used = view?.projectedTokens ?? view?.pressureTokens
  if (!view?.contextWindow || used === undefined) return null
  return used / view.contextWindow
}
```

`onChanged` 的约束：回调在 `session/event` 派发里同步执行、逐个投影单元调用、外面没有 try/catch。回调里不能对同一会话 append；回调一旦抛错，同一事件后面的投影单元都不再推送，界面的实时更新（标题、队列、上下文）会漏。所以回调整体 try/catch，只打标记，真正的动作放到 `turn/end` 之后。证据：`dsh-session-projection/lib/index.js:64-66、402-426`，`dsh-api-session-controller/lib/index.js:1201-1209`。

### 3.7 压缩与会话轮换

自动压缩（DSH 自带，机器人会话默认就有）：

- standard、minimal、cordis、ptc 四个 preset 都在 `isolate: { compaction: true }` 组里挂了 compaction-basic 和 /compact 命令；宿主层的同名行被禁用。所以宿主插件拿不到 `ctx.compaction`。
- 阈值 = floor(min(W × 0.8, W − O − 65536))，压缩后保留 16% × (W − O)，W 是上下文窗口，O 是最大输出。DeepSeek flash 约在 727,040 token（69%）触发；pi-ai 没有目录值时约在 163,840（62.5%）触发。GLM 的实际窗口见 H12。
- 自动压缩发生在 `agent/pre-step`；溢出恢复发生在 `agent/request-error` 收到 `CONTEXT_WINDOW_EXCEEDED` 时。
- 事件依次是 `compaction/start`、`compaction/summary`（原始摘要在这里）、替换用的 `user/message`（source.kind 为 compact-checkpoint）、`compaction/end`。摘要用英文写。
- 手动压缩：`ctx.commands.execute(agent, '/compact', [], signal)`，返回 `{ commandId, result: { kind, text } }`，preset 没有这个命令时返回 undefined；agent 不空闲时返回 busy 错误结果。它会往会话日志写 `command/run`（source.kind 为 user）。

证据：`dsh-compaction-basic/README.zh.md:60-80`，`dsh-compaction-basic/lib/index.js:824-870`，`dsh-web-app/presets/standard.patch.yml:66-80`，`dsh-web-app/cordis.patch.yml:543-551`，`dsh-command-compact/lib/index.js:20-69`，`dsh-commands/lib/index.js:327-350`，`api-catalog:601`。

中心自己的轮换（build-spec：占用达到阈值就换新会话）：

1. 在同一个工作区里按 3.2 再建一个会话（同一家目录，同一工作区）。
2. 把需要延续的内容写进家目录的记忆文件，在新会话的第一条唤醒里让机器人先读。
3. 归档旧会话：`await ctx.workspaceRegistry.archiveSession(oldSessionId, { stopActivity: true })`。已归档的会话不再接受新回合（归档门禁在 `agent/pre-step` 拒绝），所以归档前要确认旧会话的队列里没有待处理的唤醒。
4. 更新名册：旧 sessionId 移除，新 sessionId 登记。

证据：`dsh-workspace/lib/index.js:526-542`，`dsh-api-session-controller/lib/index.js:2508-2518`。

### 3.8 会话在 DSH 侧栏里怎么显示

- `session/created` 时，控制器发 `api-session/added`；`session/disposed` 时发 `api-session/removed`；`agent/created`、`agent/disposed` 时再发一次 `api-session/added` 刷新可用状态；`agent/status` 转成 `api-session/status(sessionId, running)`；`agent/error` 转成 `api-session/error`。
- 空白会话（还没 turn/start）不显示，当前选中的除外；`origin: 'subagent'` 的会话不显示。
- 分组看工作区记录里的 sessionIds：只有挂过（attachSession）、并且规范工作目录与工作区路径一致的会话才算成员。只给 cwd 建的会话进「未分组」。每个工作区默认只显示 5 条。
- 排序用 `updatedAt = max(createdAt, lastPromptAt)`，lastPromptAt 只认 source.kind 为 user 的消息。所以中心用自定义来源唤醒的机器人会话不会上浮。
- 在桌面界面里打开一个冷会话，宿主会在后台把它恢复为在线 agent 并持有写锁；之后外部进程再驱动这个会话，会被 `session/writer-held` 挡住。

证据：`dsh-api-session-controller/lib/index.js:1586-1593、1871-1879、2124-2126、2980-3004`，`dsh-client-ui-workspace/lib/client.js:964-974、1027-1044`，`dsh-workspace/lib/index.js:102-104、111-129`，`dsh-client-ui-workspace/README.zh.md:30`。

### 3.9 不能往会话日志写自定义事件类型

`session.append` 不检查事件类型名，写自定义类型当下不报错。但持久化读路径会拒绝「不在已知类型表里、又没标 ignorable」的事件，抛「unknown to this harness and not marked ignorable; refusing to interpret the log」。结果是 DSH 重启或冷读之后，这个会话再也打不开、也恢复不了。唯一能写 ignorable 插件记录的 `appendPluginRecord`，README 明确禁止仓库外的插件调用。

结论：中心的名册、唤醒单、账本一律放在自己的存储里。需要在对话里留痕时，用合法的 `user/message`（3.3 的 followup 或 inject）。允许追加的已知类型只有那些有官方写入函数的，例如 `sandbox/mode`、`approval/policy`（见 6.2）。

证据：`dsh-session/lib/types/known-event-types.js:8-20`，`dsh-session-persistence/lib/index.js:184`，`dsh-session/lib/index.js:1272-1297、1517-1537`，`dsh-session/README.zh.md:70`。

### 3.10 取消与停止

- `ctx.sessionController.cancel({ sessionId })`：同步方法，取消原因固定是 `{ kind: 'user' }`。会话不在线时同步抛 `session/not-found`。
- 想在 `turn/end.reason` 里区分「中心发起的中断」：直接调 `agent.cancel({ kind: 'hook', reason: 'agent-hub:turn-limit' }, { keepInbox: true })`。reason 必须是字符串。不带 `keepInbox` 会持久清空两条队列。取消原因只有 user、parent、disposed、hook 四种。
- 停下后 `turn/end.reason` 是 `{ kind: 'aborted', reason: { kind: 'hook', reason: 'agent-hub:…' } }`。

```js
/** HostPort.cancel：中断机器人当前回合，保留排队的消息 */
export async function cancelBotTurn(ctx, sessionId, why = 'agent-hub:cancel') {
  const agent = ctx.agents.get(sessionId)          // 不在线就没有回合可取消
  if (!agent) return
  agent.cancel({ kind: 'hook', reason: why }, { keepInbox: true })
}
```

证据：`dsh-agent-loop/lib/index.js:731-745、800-821`，`api-catalog:4647-4648`。

### 3.11 列最近会话、读会话记录

给 `listRecentSessions` 和 `readSessionDigest` 用（教学时让主人挑一个自己做过事的会话）：

- `ctx.sessionController.list({}, signal)` 返回可见会话，按活动时间排序。每行是 `{ sessionId, updatedAt, agentAvailable, running, blank, parentSessionId?, origin?, cwd?, projections? }`；标题在 `projections.values.title`，是字符串或 null。要过滤掉 `origin === 'subagent'`、`blank` 的行和机器人自己的会话。
- `ctx.sessionController.inspect(sessionId, signal)` 返回 `{ meta, inheritedEventCount, events }`，不激活 agent。从 events 里挑 `user/message` 和 `assistant/message` 拼摘要，按 maxChars 截断。

证据：`dsh-api-session-controller/lib/typert.host.js:519-544`，`dsh-session-title/lib/index.js:173-182`，`dsh-api-session-controller/lib/index.js:3046-3066`，`api-catalog:7400`。

## 4 自定义工具，以及只给某些会话用

### 4.1 服务与签名

```ts
// ctx.tools（服务名 tools）
register(definition: ToolDefinition): () => void
restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void   // 只能在作用域 ctx 上调用，见 4.4
guard(guard: (exec: Readonly<ToolExecution>) => string | undefined): () => void       // 见 4.4
get(name: string, scope?: ScopeKey): ToolDefinition | undefined                        // scope 可以直接传 agent
schemas(scope?: ScopeKey): ToolSchema[]                                                // 某个 agent 可见的工具定义

interface ToolDefinition {
  name: string
  description: string                       // 原样发给模型
  parameters: object                        // 参数 schema，见 4.2
  output: { schema: object; render(args, value): ContentBlock[]; presentationMeta?(args, value): unknown }   // 必填
  execute(args: unknown, exec: ToolRunContext): Promise<JsonValue>
  timeoutMs?: number
  isConcurrencySafe?(args): boolean         // 严格返回 true 才会和别的工具并行
  deferLoading?: true
}
```

注册语义：

- 用插件自己的 ctx 注册，工具进全局层，所有会话（包括主人的普通会话和所有子代理）都看得见。用 `agent.ctx` 注册，只有那个会话看得见（见 4.3）。
- 同一层重名直接抛错，全局层的报错是 `tool "x" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)`。`run_code` 是保留名。作用域里注册的同名工具会遮蔽继承来的工具，preset 层的同名工具会遮蔽全局层。所以中心的工具一律加 `hub_` 前缀。
- 注册立即生效：工具 schema 自动进入提示词组装和请求的 tools 列表。发给模型的只有 name、description、parameters、deferLoading 四项。
- 注册、撤销、restrict，或者 description 变了，会话日志里会写一条 tool-addition 或 tool-removal 开发者消息，前缀缓存随之失效。所以 description 里不要放动态内容，机器人的工具在它第一轮之前一次装好。
- 工具名按 DeepSeek 函数名的约束：64 字符以内，只用 `[A-Za-z0-9_-]`。

证据：`api-catalog:3352-3394`，`dsh-tools/lib/index.js:2731、2798-2802、2974-2983、3055-3089、3135-3157`，`dsh-agent-loop/lib/index.js:1212-1258`。

### 4.2 参数、执行上下文、返回值和报错

参数 schema 有两种写法：

1. 官方 `defineTool`（`import { defineTool } from '@deepseek-ai/dsh-tools'`）：用 DSH 自己的值 schema DSL，既不是 zod，也不是裸 JSON Schema。模型给的实参在执行前严格校验，不合法时 handler 不执行，模型收到 `Error: invalid arguments: …`。链接安装的插件要 import 它，得在 package.json 里写 peerDependencies，没实测（H17）。DSL 的键按类型受限：标量只能再带 enum 或 const；array 只能带 items；object 必须显式写 additionalProperties，可以带 properties；oneOf 至少两支，不能和 type 并存；`required` 只能写 true，而且只能写在对象的属性条目上；不支持 minLength、pattern、minimum、format。证据：`dsh-tools/lib/index.js:838-868`，`dsh-tools/lib/types/schema.js:78-82、126-133、150-205、238-257`。
2. 原始定义（中心插件用这种）：不 import 任何包，直接把对象交给 `register`。注册表只检查 output（schema 属于受支持子集、render 是函数）、timeoutMs 和 run_code 保留名，不检查 parameters，也不校验入参：parameters 只经 structuredClone 就原样发给模型；模型给了坏 JSON 时 `args` 是原始字符串，空参数时是 `{}`，所以必须自己校验（core 的 zod 正好负责）。官方 dsh-subagent 的结构化输出工具也是这么写的。证据：`dsh-tools/lib/index.js:2974-2983`，`dsh-subagent/lib/index.js:903-930`，`dsh-system-prompt/lib/index.js:370-373`。

执行上下文 `exec`（handler 的第二个参数）：

- 字段：`callId`、`rootCallId`、`name`、`arguments`（快照后深冻结）、`signal`（handler 必须响应它）、`agent?`、`parent?`（只有 PTC 子调用才有）、`schema?`、`token`；方法 `deferContext(message)`、`concludeTurn()`。
- `exec.agent.id` 就是 sessionId，等于 `exec.agent.session.id`。程序化调用时 `exec.agent` 是 undefined，要先判空。子代理调用时 `exec.agent` 是子代理本身，用 `header.origin === 'subagent'` 和 `header.parentSession` 回溯。
- 证据：`dsh-tools/lib/index.js:3227-3290`，`dsh-agent-loop/lib/index.js:506-518`，`dsh-agent/lib/index.js:512-514`，`api-catalog:8167-8176、8247-8248`。

返回值和报错：

- 返回值必须是无损 JSON。返回 undefined、函数、NaN 会得到 INVALID_TOOL_OUTPUT；想返回空，就把 `output.schema` 写成 `{ type: 'null' }` 再返回 null。返回值先快照，再按 `output.schema` 校验，不符时模型收到 `Error: tool "<name>" returned invalid output: …`；校验通过后，`render` 的结果就是模型看到的内容。
- 直接 throw，结果是 `{ isError: true, content: [{ type: 'text', text: 'Error: <message>' }] }`。工具失败不会结束回合，模型会看到错误文字并继续。
- `timeoutMs` 只是声明，真正掐时间的是宿主默认挂载的超时策略：到点 abort `exec.signal`，模型收到 `Error: tool call timed out after <ms>ms`。前提是 handler 响应 signal。
- `presentCall`、`presentResult` 只给宿主本地消费方用，桌面内置的 Web 界面不读它们。要定制卡片，用 `output.presentationMeta` 写持久化的 meta。
- 证据：`dsh-tools/lib/index.js:2672-2681、3637-3667、3712-3725`，`dsh-tools/README.zh.md:30、95、235`，`dsh-tool-call-timeout-policy/lib/index.js:93-140`。

`exec.concludeTurn()` 的真实语义（已改正）：

1. 只对成功结果生效。handler 抛错、输出校验失败、post-execute 返回 block，都不会收口。
2. 同一条 assistant 消息里的其他工具调用照常执行。
3. 这一步结束时，只有下一步队列为空才收口。同一步里 `deferContext` 或 post-execute 附带的上下文，以及期间到达的 steer、inject，都会让循环再请求一次模型。

所以「交账完就收口」的工具里不要再调 `deferContext`，宿主也别在这时对这个会话 steer 或 inject。证据：`dsh-agent-loop/lib/index.js:519-531、572、1001-1007、1166-1167`，`api-catalog:4036-4041、8172、8187-8188`。

把 core 的工具（`hub.tools()` 返回的 RegisteredHubTool：`{ name, description, schema, jsonSchema, handler(sessionId, rawArgs) }`，handler 返回 `{ ok: true, text } | { ok: false, error }`）转成 DSH 的原始定义：

```js
/** 把一个 core 工具转成 DSH ToolDefinition；sessionId 取自调用方会话，不信任模型传来的身份 */
export function toToolDefinition(tool) {
  const { $schema, ...parameters } = tool.jsonSchema      // 去掉 $schema 键；其余原样发给模型（兼容性见 H15）
  return {
    name: tool.name,                                       // hub_ 前缀
    description: tool.description,                         // 固定文本：一变就打断前缀缓存
    parameters,
    output: {
      schema: { type: 'string' },                          // 受支持的输出 schema 子集
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('这个工具只能由机器人会话调用')
      // args 可能是坏 JSON 的原始字符串、{} 或任意值：交给 core 的 zod 校验
      const result = await tool.handler(String(exec.agent.id), args)
      if (!result.ok) throw new Error(result.error)        // 模型看到「Error: <中文原因>」，回合不中断
      if (tool.name === 'hub_commit') exec.concludeTurn()  // 交账成功后请求收口（不保证立刻结束，见上）
      return result.text
    },
  }
}
```

### 4.3 只对机器人可见：装在 agent.ctx 上

工具对谁可见，由注册时用的 ctx 属于哪个作用域决定。一个会话可见的工具 = 全局层 + 作用域链上所有祖先层 + 自己这一层。三种写法：

1. 用插件自己的 ctx 注册：进全局层，所有会话都看得见。
2. 写进某个 preset 的 plugins 列表：注册进这个 preset 的作用域层，用这个 preset 建的会话和它们派出的子代理看得见。中心 v1 不用自定义 preset，见 6.1。
3. 在某个会话的 `agent.ctx` 上注册：只有这个会话看得见。中心用这种。

`agent.ctx` 上的注册有两个特点：

- 它归那个会话持有，中心插件卸载时不会自动撤销。要像官方 `dsh-experimental-tool-agent-team` 那样：apply 时遍历 `ctx.agents.list()` 补装；监听 `agent/created` 新装；监听 `agent/disposed` 撤销；在插件自己的 effect 里全部撤销。`agent/disposed` 发出时作用域注册已经撤过一次，再调用 disposer 是安全的空操作。
- 子代理的作用域父链是 preset 代际，不是父会话。所以装在机器人 `agent.ctx` 上的工具、restrict、guard、监听器，都管不到它派出的子代理。要么在机器人身上把委派类工具整体去掉（D02 的做法），要么用全局监听器按 `header.parentSession` 把子代理归到机器人。

`agent/created`：

- 签名 `'agent/created'(payload: { agent: Agent; source: 'startup' | 'resume'; signal?: AbortSignal }): undefined | Promise<undefined>`，用 serial 派发。新建时 source 是 `'startup'`，重启后恢复时是 `'resume'`。
- 它在 AgentLoop 接受输入之前跑完，所以机器人第一次思考时工具已经就位。
- 监听器抛错或 reject，会让这个会话创建或恢复失败；返回非空值会跳过后面的监听器。所以写成块体、不返回值、整体 try/catch。不能在里面 `await agent.whenIdle()`，也不能等待自己 owner 的销毁。
- 证据：`api-catalog:3956-3962、7391-7392`，`dsh-agent-loop/lib/index.js:1786-1797、1909、2012`，`dsh-agent/lib/index.js:574-590`，`dsh-experimental-tool-agent-team/lib/index.js:227-249、531-553`，`dsh-agent-preset-registry/lib/index.js:654-711`，`dsh-subagent/lib/index.js:381`。

识别机器人：查名册，并排除 `header.origin === 'subagent'`。如果要按 preset 判断，用 `ctx.agentPresets.composedPreset(agent.ctx)`，不要用 `header.agentPreset`：它是创建时的快照，空白会话后来换了 preset 它也不会变。证据：`api-catalog:117-122`，`dsh-agent-loop/lib/index.js:1827`。

装配器（2.8 骨架里的 `createBotWiring`）：

```js
import { toToolDefinition } from './tool-definition.js'

// 机器人身上要去掉的继承工具。名字以 T3 Q5-a 的清单为准；不在当前会话可见集合里的名字会被过滤掉
const BOT_DENY = [
  'ask_user_question', 'exit_plan_mode',                                       // 会一直等人回答
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',    // 节奏由中心决定
  'create_goal', 'update_goal',                                                // 目标由中心管理
  'send_message', 'interrupt_agent', 'list_agents', 'subagent', 'subagent_fork', 'list_subagent_models', 'workflow',  // 子代理不受机器人作用域管辖
  'plugin_manager', 'plugin_market',                                           // standard 里默认禁用，通常会被过滤掉
  'working_directory',                                                         // 全局层工具，能把工作目录切到任意目录
]

/** 只给机器人会话装 hub_* 工具、收窄继承工具；注册在 agent.ctx 上的东西要自己撤 */
export function createBotWiring(ctx, roster, getHub) {
  const wired = new Map()                                   // sessionId → 撤销函数数组
  // 机器人 = 预登记的新会话（roster），或 Hub 名册里的会话；子代理会话一律不算
  const isBot = (agent) => {
    if (agent.session.header.origin === 'subagent') return false
    const id = String(agent.id)
    return roster.has(id) || (getHub()?.botIdForSession(id) ?? null) !== null
  }

  function wireIfBot(agent) {
    try {
      const id = String(agent.id)
      if (!isBot(agent) || wired.has(id)) return
      const hub = getHub()
      if (!hub) return                                      // 引擎没起来：init 结束时会遍历 ctx.agents.list() 补装
      const disposers = []
      for (const tool of hub.tools()) disposers.push(agent.ctx.tools.register(toToolDefinition(tool)))
      // restrict 只认「限制前继承来的」工具名，未知名字会抛错：先求交集
      const deny = BOT_DENY.filter((name) => ctx.tools.get(name, agent) !== undefined)
      if (deny.length > 0) disposers.push(agent.ctx.tools.restrict({ deny }))
      wired.set(id, disposers)
    } catch (error) {
      console.error('[agent-hub] wire bot failed:', error)  // 绝不能往外抛：agent/created 里抛错会让会话创建失败
    }
  }

  function unwire(id) {
    const disposers = wired.get(String(id))
    if (!disposers) return
    wired.delete(String(id))
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch (error) { console.warn('[agent-hub] unwire failed:', error) }
    }
  }

  return { isBot, wireIfBot, unwire, unwireAll: () => { for (const id of [...wired.keys()]) unwire(id) } }
}
```

注意：

- `wireIfBot` 在三个地方被调用：`agent/created` 监听器、init 结束时遍历 `ctx.agents.list()`、`createBotSession` 里 resolveAgent 之后。它是幂等的。
- restrict 的结果不持久化，每次会话恢复都要在 `agent/created` 里重做。恢复时重新装上同样的工具，是否会写开发者消息、打断前缀缓存，没有实测（H16）。

### 4.4 restrict 与 guard

`agent.ctx.tools.restrict({ allow?, deny? })`：

- 只能在作用域 ctx 上调用（`agent.ctx`，或 preset 内插件的 ctx），在宿主插件的全局 ctx 上调用会抛错。
- `allow` 表示只保留这些继承来的工具，`deny` 表示去掉这些。多次 restrict 取交集。
- 只作用于继承来的工具（全局层加祖先层）。本作用域自己注册的工具不受影响，`run_code` 也不受影响。
- 点名的工具必须在「限制前」的继承集合里，否则抛「names unknown global tool …」。例如 standard 里禁用的 `plugin_manager`、`plugin_market` 不在集合里，点名就抛错。先用 `ctx.tools.get(name, agent) !== undefined` 过滤。
- 传 `{}` 会抛错；不能点名 `run_code`；`{ allow: [] }` 合法，但会隐藏全部继承工具，过滤后为空就不要调用。
- 被去掉的工具同时从 schema、查找和执行里消失，模型硬调会得到 UNKNOWN_TOOL。
- 会话中途 restrict 会写 tool-removal 开发者消息，并打断前缀缓存，所以最好在 `agent/created` 时一次设好。

`ctx.tools.guard(fn)`：

- 必须是同步函数。只有在 pre-execute 的最终决定是 allow 时才会运行（ask 被批准后也会运行）。
- 判定条件是 `reason !== undefined`：「不管」必须返回 undefined。返回 null、false、空字符串都会被当成拒绝理由，模型会看到 `Error: null` 之类的内容。
- 拒绝不可推翻：任何监听器都无法把 guard 的拒绝改回允许，人工批准过的调用也照样被拒。
- 宿主 ctx 上的 guard 作用于全部会话，`agent.ctx` 上的只管那一个会话。判定顺序是先全局层，再沿作用域链。
- 需要异步判断的，用 `tools/pre-execute`（见 5.1）。

强弱排序：restrict 只能删工具，guard 只能拒绝，waterfall 监听器能改结果但依赖注册顺序。

```js
// guard 示例：机器人不得写 DSH 自己的目录。「不管」一定要 return undefined
// write、edit 的路径参数名是 file_path（dsh-tool-fs/lib/index.js:551-556、692-697）；可能是相对路径或 ~ 开头，按会话 cwd 解析后再判断
ctx.tools.guard((exec) => {
  if (exec.agent === undefined || !wiring.isBot(exec.agent)) return undefined
  if ((exec.name === 'write' || exec.name === 'edit') && touchesDshHome(exec.agent, exec.arguments?.file_path)) {
    return '机器人不能修改 DSH 的配置目录。'
  }
  return undefined
})
```

证据：`dsh-tools/lib/index.js:2737-2748、2991-3032、3036-3060、3318-3339`，`api-catalog:3358-3375、8199-8200、8231-8232`，`dsh-tools/README.zh.md:85、89、172-176`。

### 4.5 standard 模式里的内置工具名

以 macOS、0.2.1-rc.5 为准（standard preset 定义在 `dsh-web-app/presets/standard.patch.yml:4-128`）：

- bash（Windows 上换成 pwsh）
- read、write、edit、read_image
- glob、grep
- job_output、job_list、job_kill
- schedule_create、schedule_list、schedule_update、schedule_delete（拒绝子代理调用）
- skill
- get_goal、create_goal、update_goal（create 类操作要求本轮有 source.kind 为 user 的人类消息）
- exit_plan_mode（计划模式组，始终在工具目录里）
- send_message、interrupt_agent、list_agents、subagent、subagent_fork、workflow（委派组；开启子代理模型选择时另有 list_subagent_models）
- ask_user_question（standard 没给配置，是 legacy 阻塞模式，会无限等待）
- todo_write
- web_search、web_fetch
- present
- plugin_manager、plugin_market（两者在 standard 里都是 disabled）

宿主层（所有 preset 都继承）还有：

- working_directory。
- list_mcp_resources、list_mcp_resource_templates、read_mcp_resource：调用方作用域里有 MCP 资源提供方时才出现。
- 用户加了 MCP 行时的 `mcp__<server>__<tool>`。

其他 preset 的差别：

- ptc：模型能直接调用的只有 run_code。
- cordis：多 cordis_inspect_list、cordis_inspect_query，有 profileContext 时还有 plugin_manager、plugin_market。
- minimal：只有 read_image、持久终端版 bash、/compact 命令，外加宿主层工具。

核对办法：`ctx.tools.schemas(agent).map((s) => s.name)` 列出某个会话可见的工具。

证据：`dsh-web-app/presets/standard.patch.yml:4-128`，`dsh-web-app/cordis.patch.yml:482-585`，`dsh-base/cordis.patch.yml:169-170`，`dsh-tool-ask-user/lib/index.js:211-224`，`dsh-tools/lib/index.js:2932-2944、3121-3123`。

## 5 钩子

### 5.0 通用规则

- 注册：在 apply 里 `ctx.on(event, listener, options)`。所有 context 的监听器存在同一个数组里：普通注册按注册时间追加到末尾，`{ prepend: true }` 插到最前，派发时再按作用域过滤。证据：`cordis/lib/index.js:258-264、317-325、335-346、370-380`。
- 作用域：`agent/*`、`approval/request`、`user-questions/request`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result` 按会话作用域派发。中心插件根 ctx 上的监听器收全部会话的事件；`agent.ctx` 上的只收那个会话（及其后代）；preset 内插件的只收这个 preset 下的会话。例外：`tools/change` 不过滤作用域。证据：`dsh-scope/README.zh.md:42、71-75`，`dsh-agent/lib/types/dispatch.js:31-73`，`api-catalog:4460-4466`。
- waterfall：外层先跑，不调 `next()` 就截断后面所有监听器，连默认行为也跳过。不打算做决定，就 `return next()`。要改 `next()` 的结果，先 `await next()` 再展开修改，保留其他字段。这类监听器不能用 `safe()` 包（它会吞掉返回值），要自己 try/catch，出错时 `return next()`。
- serial（`agent/created`、`agent/turn-stopping`）：写成块体，不返回值。
- 监听器抛错的后果：`tools/pre-execute` 抛错，这次调用变成错误结果；`approval/request` 抛错，按 unavailable 处理；`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping` 抛错，这一轮以 error 结束；`agent/created` 抛错，会话创建失败。
- 上线前，可以在 cordis preset 的会话里用 `cordis_inspect_query`（Service、Event）核对当前版本的签名。证据：`dsh-tool-cordis/lib/index.js:38-57`，`dsh-web-app/presets/cordis.patch.yml:120-121`。

下面每个钩子都给出中心插件的写法，合起来就是 2.8 骨架里的 `installHooks(ctx, { wiring, translator, getHub })`。示例里的 `wiring.isBot(agent)` 是 4.3 的装配器方法，`translator` 是 3.4 的翻译器，`hubMessage` 是 3.3 的消息构造函数。

### 5.1 tools/pre-execute：动作闸

```ts
'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: { name: string; code: string; reason?: string } }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { en: string; [locale: string]: string } }
```

- `allow`：默认值，放行。
- `deny`：不执行，模型看到 `Error: <reason>`；`info` 只进日志和界面。
- `cancel`：模型看到 `Error: tool call aborted before dispatch`。
- `ask`：交给 `ctx.approval.request`。结果是 allowed-once 才执行，其余都转成拒绝。会话的审批策略是 never 时直接被拒，所以机器人会话不要返回 ask。

决定对象必须写严格：

- `deny` 漏写字符串 `reason`，或者返回了未知的 kind，都会被当成放行，而且跳过 guard。这是安全漏洞。
- 忘了 return（返回 undefined），读取 `gate.kind` 时抛 TypeError，这次调用变成错误结果。
- 监听器抛错时结果直接定稿，跳过 post-execute，但 `tools/result` 仍会触发。
- `exec.arguments` 是深冻结的，不能改写参数。要换参数，就 deny 并在 reason 里写清正确参数，让模型重新调用。
- 未注册的工具名也会进这个钩子；PTC 模式下 run_code 内部的子调用也会进来，此时 `exec.parent` 有值。
- `callId` 由模型或供应商生成，不保证跨会话唯一。按 callId 缓存东西时，键用 `${agent.id}:${callId}`。

证据：`api-catalog:4484-4490、6427-6428`，`dsh-tools/lib/index.js:3258-3265、3310-3370、3535-3588、1362-1377`，`dsh-tools/README.zh.md:233`。

```js
// 动作闸：只对机器人会话调用 core 的 guardToolCall；其他会话一律 return next()
// next() 放在 try 外面调用：避免内层出错时在 catch 里再调一次 next
ctx.on('tools/pre-execute', async (exec, next) => {
  let decision                                        // undefined 表示「不管」
  try {
    const hub = getHub()
    if (exec.agent !== undefined && hub && wiring.isBot(exec.agent)) {
      decision = hub.guardToolCall(String(exec.agent.id), exec.name, exec.arguments)   // { allow: true } | { allow: false, message }
    }
  } catch (error) {
    console.error('[agent-hub] pre-execute failed:', error)
    decision = { allow: false, message: '中心检查动作时出错，这次调用已被拦下。' }    // 机器人会话失败即关闭
  }
  if (decision === undefined || decision.allow) return next()
  return {
    kind: 'deny',
    reason: decision.message || '这个动作需要主人批准，已经提交审批单。',            // 必须是非空字符串
    info: { name: 'AgentHubGate', code: 'HUB_GATE_DENIED' },
  }
}, { prepend: true })
```

同一组的其他事件：

```ts
'tools/execute'(exec, next): Promise<ToolExecutionResult>          // 不调 next 就用自己的结果替代执行；成功结果仍按工具的 output.schema 校验
'tools/post-execute'(exec, result, next): Promise<{ kind: 'accept'; content? } | { kind: 'accept'; value } | { kind: 'block'; feedback }>
'tools/result'(exec, result): void                                   // 只能观察，适合记账；监听器失败会被兜住
```

每个调用（包括被拒、抛错、取消的）最终都会触发 `tools/result`，适合在这里清理按 callId 缓存的东西、统计 web_search 次数。默认组合里只有 dsh-tool-jobs（prepend）和 dsh-workspace-changes 注册了 pre-execute，两者最终都 `return next()`。证据：`api-catalog:4468-4504`，`dsh-tools/lib/index.js:3423-3445、3599-3630、3672-3695`，`dsh-tool-jobs/lib/index.js:235-239`，`dsh-workspace-changes/lib/index.js:1086-1094`。

### 5.2 agent/pre-step：步数上限的硬闸

```ts
'agent/pre-step'(payload: { agent; messages: UserMessage[]; turn: number; step: number; signal }, next): Promise<PreStepDecision>
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

- 每一步（也就是每次模型请求）之前跑一次。`turn` 是会话的累计轮次，`step` 每轮从 1 开始。
- 跑钩子之前，循环已经领取了本步的消息：每步领取下一步队列的全部消息，第 1 步另外领取 1 条下一轮消息。默认决定是 enter。
- 返回 `{ kind: 'reject' }`：这一步不发模型请求，这一轮立即以 `turn/end { reason: { kind: 'blocked' } }` 结束。本步已领取的消息既不放回队列，也不写成 `user/message`，等于被吞掉；下一轮队列里剩下的消息留着，等下一次唤醒。
- 外层 reject 且不调 next 时，内层监听器（模型选择、自动压缩、计划模式等）这一步都不运行。
- 这是硬截断：前面步骤的工具结果已经落盘，但模型不会再被请求做总结。更温和的做法是先在 `agent/turn-stopping` 或通过 HostPort.steer 催它交账（见 5.6），实在超限再 reject 或 `agent.cancel({ kind: 'hook', reason })`。
- 用它当暂停闸门时，被吞掉的唤醒内容要由中心自己记账、之后重投。

证据：`api-catalog:3980-3986、4004-4010、6423-6424`，`dsh-agent-loop/lib/index.js:103-110、886-924、955-964`，`dsh-agent/lib/index.js:53-60`，`dsh-agent-loop/README.zh.md:220`。

```js
// 步数硬闸：超过上限就不再请求模型（这一轮以 blocked 结束）
ctx.on('agent/pre-step', async (payload, next) => {
  try {
    const limit = wiring.isBot(payload.agent) ? stepLimitFor(String(payload.agent.id)) : undefined
    if (limit !== undefined && payload.step > limit) return { kind: 'reject' }
  } catch (error) {
    console.error('[agent-hub] pre-step failed:', error)
  }
  return next()
}, { prepend: true })
```

### 5.3 approval/request：审批兜底

```ts
'approval/request'(req: { agent; toolName: string; callId?: string; reason?: string; displayReason?: { en: string; [locale: string]: string }; signal?: AbortSignal }, next): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
```

- 会话策略是 never 时，`ApprovalService.decide` 在分发之前就返回 rejected，任何应答者都看不到这次请求，但审计事件 `approval/asked`、`approval/decided` 照样写。所以机器人会话在 never 策略下，这个钩子不会被调用。
- 策略是 ask 时，必须 prepend：桌面界面的转发器在 dsh-api-remotes 启动时就注册了，而且除非页面选择委派，它不调 next。没有页面连着时，请求挂在网关里，等有页面连上再投递，期间不会自动结束。
- 整条链路没有超时。只有有人作答、回合被取消（结果 cancelled），或这个会话的 ctx 被释放（结果 unavailable），等待才会结束。
- 返回值不是那 4 个字符串之一，或监听器抛错，都按 unavailable 处理。
- 请求里不带工具参数（plugin_manager 例外，它的 reason 里带着参数）。要看参数，在 pre-execute 里按 `${agent.id}:${callId}` 缓存，在 `tools/result` 里清理。
- 只能在开放的回合里请求，否则在写审计事件之前就抛错。
- 会触发审批的只有：沙箱提权（bash、write、edit、run_code 带 `sandbox_permissions` 和非空 `justification`，并且目标模式比当前更宽）、plugin_manager 的每个动作、pre-execute 返回 ask、其他插件直接调 `ctx.approval.request`。读文件、联网、MCP、工作区内的写入都不审批。委派出去的子代理的审批策略被固定为 never。

证据：`api-catalog:4092-4097、4731-4744`，`dsh-user-approval/lib/index.js:30-39、49-56、128-144、172-190`，`dsh-api-remotes/lib/index.js:146-176`，`dsh-api-gateway/lib/index.js:851-856、1014、1062-1124`，`dsh-sandbox/lib/index.js:30-33、64-78、99-123`，`dsh-plugin-manager/lib/types/tools.js:76、92-98`，`dsh-subagent/lib/index.js:397-415`。

```js
// 兜底：机器人会话的策略万一不是 never，也不让 DSH 的审批框挂住无人值守的会话
ctx.on('approval/request', async (req, next) => {
  let verdict = 'pass'                                               // 'deny' | 'pass'
  try {
    const hub = getHub()
    if (hub && wiring.isBot(req.agent)) {
      verdict = hub.onHostApprovalRequest(String(req.agent.id), req.toolName, String(req.reason ?? ''))
    }
  } catch (error) {
    console.error('[agent-hub] approval/request failed:', error)
    verdict = 'deny'                                                 // 出错时对机器人失败即关闭
  }
  return verdict === 'deny' ? 'rejected' : next()                    // 普通会话交给桌面审批面板
}, { prepend: true })
```

### 5.4 agent/request：按回合改模型路由

```ts
'agent/request'(payload: { agent; turn: number; step: number; signal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
type LlmCallConfig = { provider: string; model: string; reasoningEffort?: string; temperature?: number; maxTokens?: number; stop?: string[] }
```

- 每次模型请求尝试都跑一次（同一步的重试也算），时机在 `step/start` 之后。改不了消息。
- `await next()` 拿到循环本来要用的配置。返回值必须同时有 provider 和 model，否则抛「has no provider/model」。provider 没注册时，NO_ADAPTER 会被循环吞掉、回退为原配置，随后请求以 NO_ADAPTER 失败，这一轮以 error 结束。
- 会话控制器给每个会话在 `agent.ctx` 上装了模型选择的监听器（没有 prepend）。它在 `await next()` 之后把 provider 和 model 改成会话当前的选择，并去掉继承来的 reasoningEffort。所以中心的监听器要 `{ prepend: true }` 注册在根 ctx 上，并在 `await next()` 之后再覆盖。
- 换供应商时去掉继承来的 reasoningEffort。改道生效后，请求头会记成新模型，后续步骤保持一致。
- 改道时模型收不到任何「模型已切换」的提示，首次请求里提示词的 `{{model}}` 也和实际路由不一致。
- 和 selectModel 冲突：会话有一个与钩子路由不同的待用选择（picked，可能来自 selectModel，也可能来自主人在界面里切模型）时，picked 永远消费不掉，而且几乎每一步都会追加一条方向相反的 `[model changed]` 持久通知。对策：用钩子的机器人不要再 selectModel 别的模型；或者在钩子里读 `modelSelection` 投影的 pending，发现与路由不同就让位（H11）。

证据：`api-catalog:4012-4018、5843-5852`，`dsh-agent-loop/lib/index.js:1174-1210`，`dsh-agent/lib/index.js:133-148、166-209`，`dsh-api-session-controller/lib/index.js:274-306、2155-2189`，`dsh-llm/lib/index.js:2386-2413`。

```js
const routes = new Map()   // sessionId → { provider, model, reasoningEffort? }，由中心按额度等情况设置

ctx.on('agent/request', async (payload, next) => {
  const resolved = await next()                       // 先让内层（含模型选择）算出原配置
  try {
    const route = routes.get(String(payload.agent.id))
    if (route === undefined) return resolved
    const pending = ctx.get('sessionProjections')?.stateOf(payload.agent.session, 'modelSelection')?.pending
    if (pending && (pending.provider !== route.provider || pending.model !== route.model)) {
      routes.delete(String(payload.agent.id))         // 有人手动选了别的模型：让位，避免每步追加反向通知
      return resolved
    }
    const { reasoningEffort: _drop, ...rest } = resolved   // 换路由时去掉继承来的推理强度
    return { ...rest, provider: route.provider, model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }
  } catch (error) {
    console.error('[agent-hub] agent/request failed:', error)
    return resolved
  }
}, { prepend: true })
```

### 5.5 agent/request-error：识别额度错误

```ts
'agent/request-error'(payload: { agent; turn; step; provider: string; failure: LlmFailure; retryPolicy; signal }, next): Promise<{ kind: 'retry' } | undefined>
type LlmFailure = { message: string; code: string; status?: number; providerRetryAfterMs?: number; requestId?: string }
```

- 一次请求以 error 或 aborted 结束时，先把 `assistant/attempt` 写进日志，再跑这个 waterfall。适配器选择、分发和流迭代的失败都会进来；middleware、嵌套调用、消费方的异常直接结束这一轮，不进这里。
- 返回 `{ kind: 'retry' }`：立即在同一步重新请求，没有延时，要延时就自己 await。返回 undefined（默认）：这一轮以 `turn/end { reason: { kind: 'error', error: failure } }` 结束，并发出 `agent/error`。
- 宿主层的 dsh-llm-retry（没有 prepend）对 EMPTY_RESPONSE、RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT 重试，最多 5 次，延时从 500 毫秒指数增长到 10 秒；`providerRetryAfterMs` 超过上限就不重试。
- QUOTA 判定只认英文措辞。pi-ai（GLM 走这条）的分类顺序是：含 401 或 403 判为 AUTH；英文额度措辞判为 QUOTA；含 429 或 rate limit 判为 RATE_LIMIT。GLM 的中文额度报错很可能被判成 RATE_LIMIT，白白重试 5 次（推断，真实报错文本见 H14）。

证据：`api-catalog:4020-4026、5863-5864、6703-6704`，`dsh-agent-loop/lib/index.js:1094、1127-1146`，`dsh-llm-retry/lib/index.js:141-180`，`dsh-llm/lib/types/retry-policy.js:12-22`，`dsh-llm/lib/types/error.js:21-26、76-82`，`dsh-llm-pi-ai/lib/index.js:1448-1459、1513-1521`。

```js
// 明确的额度错误不要重试：直接让这一轮以 error 结束，由 3.4 的翻译器把 errorText 交给 core 的 classifyError
// 只认 QUOTA，或被归成 RATE_LIMIT / UNKNOWN 但文字明显是额度的错误。
// 绝不拦 CONTEXT_WINDOW_EXCEEDED、IMAGE_OFFLOAD_REQUIRED：本监听器在最外层，不调 next 会让内层的压缩、图片卸载恢复失效
const QUOTA_WORDS = /quota|usage limit|insufficient balance|额度|余额/i
ctx.on('agent/request-error', async (payload, next) => {
  try {
    if (wiring.isBot(payload.agent)) {
      const f = payload.failure
      const looksQuota = (f.code === 'RATE_LIMIT' || f.code === 'UNKNOWN') && QUOTA_WORDS.test(String(f.message))
      if (f.code === 'QUOTA' || looksQuota) return undefined
    }
  } catch (error) {
    console.error('[agent-hub] request-error failed:', error)
  }
  return next()                                       // 其他错误（包括普通限流）照常交给官方重试和恢复
}, { prepend: true })
```

### 5.6 agent/turn-stopping：没交账就催一次

```ts
'agent/turn-stopping'(payload: { agent; turn: number; signal }): Promise<void> | void      // serial
```

- 时机：模型这一轮已经不欠回复（没有在跑的工具调用，也没有新的 steer），回合即将关闭之前。
- 监听器调用 `agent.steer(消息)`，循环会在提交边界之前重读下一步队列：非空就再跑一步，空就关闭这一轮。由数据决定结果，与监听器顺序无关。
- serial 事件：写成块体、不返回值；抛错会让这一轮以 error 结束。
- 官方建议的「限制失控回合」也从这里做。

证据：`api-catalog:4036-4041`，`dsh-agent-loop/lib/index.js:806-814、996-1008`，`dsh-agent/README.zh.md:67`。

```js
// committedThisTurn 来自 3.4 的翻译器（translator.committedThisTurn）：
// turn/start 时删掉，看到 hub_commit 的 tool/result 且 isError 为 false 时加入
const committedThisTurn = translator.committedThisTurn
const nudged = new Map()   // sessionId → 已催过的 turn
ctx.on('agent/turn-stopping', ({ agent, turn }) => {
  try {
    const id = String(agent.id)
    if (!wiring.isBot(agent) || committedThisTurn.has(id) || nudged.get(id) === turn) return
    nudged.set(id, turn)                              // 每轮最多催一次，防止死循环
    agent.steer(hubMessage('结束前请调用一次 hub_commit 交账。', { form: 'notice', summary: '提醒交账', purpose: 'commit-nudge' }))
  } catch (error) {
    console.error('[agent-hub] turn-stopping failed:', error)
  }
})                                                    // 块体，不返回值
```

### 5.7 user-questions/request：机器人不等人

```ts
'user-questions/request'(request: { questions: AskUserQuestionItem[]; agent?; signal?; wait? }, next): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
```

- `ask_user_question` 工具（standard 里是 legacy 阻塞模式）和计划审阅（`questions[].intent.kind === 'plan-review'`）都走这条。它同样被桌面转发器以 waterfall 方式转发，没人回答就一直等。
- prepend 注册后返回 `{ answers }` 就能替机器人作答。只接受根 agent；完全没有应答者时报 NO_PROVIDER。
- 机器人身上已经去掉了 `ask_user_question` 和 `exit_plan_mode`（4.3），这里是兜底。

证据：`api-catalog:4508-4514、4755-4780`，`dsh-user-questions/lib/index.js:668-691`，`dsh-tool-ask-user/lib/index.js:211-224`，`dsh-plan-mode/lib/index.js:252-275`。

```js
ctx.on('user-questions/request', async (request, next) => {
  let answers
  try {
    if (request.agent !== undefined && wiring.isBot(request.agent)) {
      answers = request.questions.map((q) => ({
        id: q.id, selected: [],
        custom: '主人现在不在。请用中心的提问工具把问题交给主人，然后先按最稳妥的假设继续，并写明你的假设。',
      }))
    }
  } catch (error) {
    console.error('[agent-hub] user-questions/request failed:', error)
  }
  return answers === undefined ? next() : { answers }
}, { prepend: true })
```

### 5.8 session/created：一般不要监听

`SessionStore.announce` 同步调用 `session/created` 监听器，只处理返回 Promise 的拒绝，不捕获同步异常；而 announce 是在 agent 工厂的发布流程里调用的。所以监听器一旦同步抛错，DSH 里所有新建或恢复的会话都会失败（包装成 gateway/internal）。中心建会话以 `sessionController.create` 的返回值为准，用不到它。真要监听，回调整体 try/catch。证据：`dsh-session/lib/index.js:1901-1922`，`dsh-agent-loop/lib/index.js:1786-1797`。

## 6 preset、权限档、审批与沙箱

### 6.1 preset（模式）

```ts
// ctx.agentPresets（服务名 agentPresets，由 dsh-agent-preset-registry 提供；web 组合配 default: standard）
register(definition: PresetDefinition): Promise<() => Promise<void>>     // 只在内存里，返回注销函数
list(): Promise<AgentPreset[]>                                           // 按 order 再按 id 排序；内置 standard=1、ptc=2、minimal=3、cordis=4
resolve(id?: string): Promise<AgentPreset>                               // { id, broken? }；找不到抛 agent-preset/not-found
readDocument(agentPreset: string): Promise<{ agentPreset; content; name?; description? }>   // content 是 plugins 列表的 YAML
composedPreset(ctx: Context): string | undefined                          // 某个会话当前实际绑定的 preset
select(agent: Agent, agentPreset: string): Promise<string>               // 只能在空白会话上切换

interface PresetDefinition {
  id: string                       // trim 后非空、不重复；约定只用小写字母、数字和连字符
  name?: string; description?: string; order?: number   // 只给界面看，模型看不到
  plugins: Array<{ id?: string; name: string; config?: unknown; disabled?: boolean | { __jsExpr: string }; inject?; isolate?; intercept?; group? }>
}
```

要点：

- 没有 extends、model、permission、hidden 这类字段，也不能声明式继承 standard：覆盖一个 preset 就是整份替换它的插件列表。派生只能在代码里做：`readDocument('standard')` 读出当前生效的插件列表，按行 id 增删，再 register。
- 只在内存里：每次启动都要重新 register。register 返回的注销函数要交给 `ctx.effect`，否则插件重载后再注册会报「Duplicate agent preset」，旧的行代码也会继续跑。
- 定义 broken 时（某行导入或激活失败、服务漏到根 realm），register 照样返回注销函数，不会 reject；broken 的 preset 只在设置页显示「加载失败」，新任务的模式选择器里看不到。事后检查要用 `resolve(id)` 看 `broken` 字段，但 `resolve`、`list` 在有 pending 行时会等整个宿主 Loader 结算，在本插件自己的激活过程里 await 它们会互相等待，所以只能发起不等，或者在真正唤醒前再查。
- preset 行如果提供服务，提供方和所有消费方必须放在同一个 `cordis:group` 的 isolate realm 里，否则整个 preset broken。行 config 会经过 structuredClone，只能放纯数据和 `{ __jsExpr }`。
- 会话记住的是 preset id（会话头的 `agentPreset` 加上 `agent-preset/selected` 事件）。运行中的会话绑定确切的那一代定义；冷恢复时按 id 取当前定义，没注册时恢复失败。经 `resolveAgent` 恢复失败时，错误码是 `gateway/internal`，原因只在 message 里，不是 `agent-preset/not-found`；dsh-schedule 投递失败后只打警告，不重试。
- preset 只能在空白会话上切换，开过第一轮再切报 `agent-preset/locked`。
- 每个 preset 常驻一整棵插件树（包括技能目录监听等），按机器人数量注册 preset，资源会线性增长。

证据：`api-catalog:71-149、6411-6412`，`dsh-agent-preset-registry/lib/index.js:16-28、48-77、108-122、154-179、219-237、446-449、466-549、570-581、596-712、750-770`，`dsh-agent-preset-registry/README.zh.md:48、56、58、60、99`，`dsh-agent-preset/lib/index.js:7-27`，`dsh-api-session-controller/lib/index.js:221-244、351-362`，`dsh-schedule/lib/index.js:1521-1522、1576-1577`。

v1 的定法（D02 卡）：机器人会话一律用 DSH 自带的 `standard`，不注册自定义 preset。原因是运行时注册的 preset 只在内存里，DSH 重启后机器人会话可能先于中心插件恢复而失败（H19）。机器人之间的差异靠家目录的 AGENTS.md、唤醒包和按会话收窄的工具（4.3）实现。

### 6.2 权限档与「无人值守」

桌面组合（dsh-base）配置了三个权限档，客户端显示为「仅可查看、工作区内修改、完全权限」：

- `read-only`：沙箱 read-only，审批 ask。
- `workspace-write`：沙箱 workspace-write，审批 ask。
- `danger-full-access`：沙箱 danger-full-access，审批 never。

只有加载实验包 dsh-experimental-auto-review 时才多出 `auto`，默认组合不加载它。新会话在 `session/created` 时由 `pinInitialPermission` 写入设置里的默认档，同时写 `permission/preset`、`sandbox/mode`、`approval/policy` 三种事件。证据：`dsh-base/cordis.patch.yml:237-276`，`dsh-permission-presets/lib/index.js:138-159、291-306、370-389`。

可用的接口：

```ts
ctx.permissionPresets.set(session: Session, name: string): void      // 只追加有变化的事件，不给模型注入消息；名字不对会抛错
ctx.permissionPresets.current(session: Session): string               // 当前匹配的档名，都不匹配返回 'custom'
ctx.approval.overrideOf(session: Session): 'ask' | 'never' | undefined
ctx.approval.setPolicy(agent: Agent, policy: 'ask' | 'never'): void   // 会给模型注入「changed by the user」通知，中心不用
ctx.sandboxPolicy.overrideOf(session: Session): SandboxMode | undefined
ctx.sandboxPolicy.resolve(request?: { session? }): { mode; workspaceRoot }
// 日志事件本身：session.append('sandbox/mode', { mode })、session.append('approval/policy', { policy })
```

证据：`api-catalog:326-345、1570-1620、1916-1945`，`dsh-permission-presets/lib/index.js:344-363`，`dsh-user-approval/lib/index.js:63-66、98-110`，`dsh-sandbox-policy/lib/index.js:40-42`。

机器人用「工作区可写 + 审批 never」：需要审批的操作在分发之前就被自动拒绝，不会弹框挂住无人值守的会话；模型的运行时上下文里会写明「审批已关闭，不要申请提权」。没有内置档是这个组合，所以先 `set` 到 `workspace-write`，再直接追加一条 `approval/policy`。这正是 `setApprovalPolicy` 这个包导出函数的全部实现，不注入任何消息。之后权限选择器会显示 custom，这是预期的。

```js
/**
 * 机器人会话的「无人值守」权限：沙箱 workspace-write，审批 never。
 * 幂等：已经是目标值就不写。在建会话后、以及每次唤醒前调用（防止被人在界面里改掉，或重启后丢失，见 H9）。
 * 不能在这个会话的 session/event 同步派发阶段里调用（会重入）。
 */
export function ensureBotPolicy(ctx, session) {
  const presets = ctx.get('permissionPresets')
  const approval = ctx.get('approval')
  const sandbox = ctx.get('sandboxPolicy')
  if (!presets || !approval || !sandbox) throw new Error('权限服务不可用，不能唤醒机器人')   // 失败即关闭
  if (sandbox.overrideOf(session) !== 'workspace-write') presets.set(session, 'workspace-write')
  if (approval.overrideOf(session) !== 'never') session.append('approval/policy', { policy: 'never' })
}
```

不要用的两种方式：

- `/permission <档名>` 命令：会写 `command/run`（source.kind 为 user）；审批策略变了时还会注入「The approval policy changed … (changed by the user)」。带参数时切到完全权限也不弹风险确认。证据：`dsh-permission-presets/lib/index.js:206-231`，`dsh-commands/lib/index.js:327-345`。
- 用补丁覆盖 `permission` 行加一个自定义档：非 insert 补丁整体替换 config，三个内置档必须一起写上；`custom` 和 `auto` 是保留名，写进去构造函数直接抛错，整个权限服务起不来；用户保存过的默认档如果被删，构造时也会抛错；而且主人自己的 profile 补丁在组合包之后叠加，可能把它冲掉（H20）。证据：`dsh-permission-presets/lib/index.js:175-184、238-240、315`，`dsh-app-boot/lib/index.js:61-109、488-497、3044`。

### 6.3 审批的语义

- 只有代码显式调用 `approval.request` 才产生审批。来源见 5.3。
- 结果只有四种：`allowed-once` 是唯一的放行，只对这一次调用有效；没有「总是允许」，没有记忆规则。
- 策略 never：分发前直接返回 rejected。模型看到的错误文字：
  - 沙箱提权被拒：`the user rejected escalating this <command|operation|program> to "<mode>"; it stays denied, so stop and explain instead of working around it`。
  - pre-execute 返回 ask 被拒：`Error: the user rejected tool "<name>"`。
  - 审计照常写：先 `approval/asked`，再 outcome 为 rejected 的 `approval/decided`。
- 策略 ask：交给应答者链。没有应答者，或页面没连着，就一直等，没有超时。只有回合被取消（cancelled）或会话 ctx 被释放（unavailable）能解开。工具调用超时策略只覆盖声明了 timeoutMs 的工具，bash、read、write、edit 都没有声明。
- never 档下 bash 的结果里仍可能出现「可以提权」的提示，是否显示只取决于执行器能不能约束，与审批策略无关；模型照做去提权，会立刻收到上面那条被拒的错误。
- 把一个审批请求交给桌面面板之后，宿主代码没有公开接口替主人点允许或拒绝，只能取消回合。

证据：`dsh-user-approval/lib/index.js:39、79-89、128-144、172-189`，`dsh-sandbox/lib/index.js:99-123`，`dsh-tools/lib/index.js:3330-3340、3535-3576`，`dsh-tool-call-timeout-policy/README.zh.md:42、46`，`dsh-api-gateway/lib/index.js:1027-1036、1062-1159`，`dsh-tool-bash/lib/index.js:344`。

### 6.4 沙箱到底拦什么

只拦写文件：

- 内核级：bash、pwsh（包括后台作业，子孙进程继承规则）、持久终端、PTC 的 run_code 子进程，在 macOS 上都走 Seatbelt（`sandbox-exec -p <规则> -- bash -c <命令>`，规则是 `(allow default) (deny file-write*)` 再放开可写目录）。
- 进程内：write 和 edit 工具走文件围栏：先对路径做 realpath 规范化，再检查是否落在可写根之下。代码注释自己说这是「containment，不是安全边界」。
- 可写根：会话创建时定下的 `header.cwd`、`/tmp`、`os.tmpdir()`，再加 `/dev/null`，全部按真实路径算，macOS 上就是 `/private/tmp` 和 `/private/var/folders/…/T`。`header.cwd` 之后不能改，`working_directory` 工具的 cd 也不改变它。工作区里放指向外部的符号链接扩不出去（硬链接见 H46）。
- read-only 档：除了 `/dev/null` 一律不可写。danger-full-access：不套任何沙箱。

不拦的：

- 读：机器人能读全盘，包括别的机器人的目录、`~/.ssh`、`~/.dsh` 下的凭据文件。
- 网络和起进程。
- 宿主插件代码（包括中心自己的工具和钩子）、MCP 服务器进程、web_fetch 和 web_search、插件安装。
- `/tmp` 和 `$TMPDIR` 对所有会话可写，机器人之间可以互相改临时文件。

环境变量：子进程从父进程继承的环境里，名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量和所有 `DSH_*` 变量都会被剔除；但 bash、pwsh 每次调用都会显式注入受管的 `DSH_HOME`、`DSH_SHELL=1`、`DSH_SESSION_ID`、`DSH_PROFILE`、`DSH_PROFILE_DIR`。所以机器人能直接定位 DSH 主目录。中心要给机器人的密钥，名字必须含 KEY、TOKEN、SECRET 之一，否则会出现在机器人的 `env` 输出里。

失败即关闭：要求沙箱的模式下没有可用的执行器，报 SANDBOX_UNAVAILABLE，拒绝执行，不会静默地在无沙箱状态下跑。判定细节：命令退出码非 0 且 stderr 含「operation not permitted」算沙箱拒绝；退出码非 0 且任一 stderr 行含「sandbox-exec: 」算执行器故障。所以一个自己往 stderr 打出这串字并以非 0 退出的命令，会被误判成沙箱不可用。

宿主代码调 `ctx.fs.writeText`、`ctx.fs.editText` 或 `ctx.shell` 而不传 sandboxPolicy 时，用的是部署默认规则：workspace-write，可写根是 Host 的工作目录 `$DSH_HOME/profiles/desktop`。写 `~/AgentHub` 会报 FS_SANDBOX_DENIED。中心写自己的文件一律用 `node:fs`。

证据：`dsh-sandbox/README.zh.md:166`，`dsh-fs-sandbox/lib/index.js:68-93、125-166`，`dsh-sandbox-policy/lib/index.js:57-62、97-104、141-148`，`dsh-sandbox/lib/index.js:140-173、224-275`，`dsh-sandbox-local/lib/index.js:22-75、305-330`，`dsh-bash-sandbox/lib/index.js:65-119`，`dsh-subprocess/lib/index.js:25-56`，`dsh-shell-env/README.zh.md:12、32`，`dsh-tool-bash/lib/index.js:665`，`dsh-base/cordis.patch.yml:243-247、516-519`，`_app/main.js:3767、3803`。

### 6.5 机器人目录怎么布局

做不到「额外可写目录」，推荐布局是：

- 每个机器人的会话工作目录 = `<rootDir>/bots/<botId>`，权限是 workspace-write 加 never。它只能写自己的目录和临时区。
- 跨机器人共享、对外的产出，都通过中心的宿主工具来写。宿主代码不在沙箱里，由中心自己校验路径。
- 读本来就不受限，共享资料直接读，不需要符号链接。

其他方案和代价：

- 所有机器人的工作目录都设成 `<rootDir>`：机器人之间可以互相写，没有隔离；指令文件和技能的项目根也会变成同一个。
- 用 ask 加中心自动批准提权：一经批准，这一次调用整体升到 danger-full-access，可以写全盘。
- 给 dsh-sandbox-local 配 `runnerCommand`：对所有会话生效、跳过探测、官方不支持，而且进程内的文件围栏不认这个额外目录，两边行为不一致。

证据：`dsh-sandbox-local/lib/index.js:253-257、305-320`，`dsh-sandbox-local/README.zh.md:135`，`dsh-working-directory/lib/index.js:105-120`。

### 6.6 指令文件、人设和技能

- 指令链（dsh-agent-instructions）：先注入 `$DSH_HOME/AGENTS.md`，再注入 `$DSH_AGENTS_HOME`（默认 `~/.agents`）下的 `AGENTS.md`，这是进程级的，preset 关不掉，主人的全局指令对机器人同样生效。然后是项目链：从项目根到会话当前工作目录，每一层的 `AGENTS.md`、`CLAUDE.md` 和对应的 `.local.md`。项目根 = 离当前目录最近、含 `.git` 的祖先目录，一个都没有就用当前目录。工作目录变了，下一次请求前会重新加载项目链。
- 所以 `working_directory` 工具（全局层工具，能 cd 到任意已存在的目录）会让机器人读到别的机器人的 AGENTS.md，自己那份反而掉出链。4.3 的装配器已经把它从机器人身上去掉。
- 机器人在自己目录里 `git init`，项目根就变成它的目录；如果 `<rootDir>` 本身是 git 仓库，项目链会包含 `<rootDir>` 和 `<rootDir>/bots` 两层的指令文件。
- 人设（dsh-persona）和技能目录（dsh-skill-filesystem）都是 preset 里的行，中心 v1 不改它们。技能根目录按优先级是：`<项目根>/.dsh/skills`、`<项目根>/.agents/skills`、自定义目录、`<DSH 主目录>/skills`、`<agents 主目录>/skills`、随包技能；项目根按 `.git` 标记找，不可配置。

证据：`dsh-agent-instructions/lib/index.js:16-31、545-579`，`dsh-agent-instructions/README.zh.md:28、34、40`，`dsh-tool-working-directory/lib/index.js:16-41`，`dsh-skill-filesystem/lib/index.js:30-43、78`，`dsh-skill-filesystem/README.zh.md:48-56`。

## 7 存储与文件、定时器、可订阅事件、主人是否活跃

### 7.1 数据放在哪

DSH 主目录（`$DSH_HOME`，默认 `~/.dsh`；空白值当作没设，支持 `~` 展开）下已有：

- `profiles/<名字>/`：插件装在这里，桌面版是 `profiles/desktop`。
- `sessions/`：会话日志。
- `storages/`：storageDomain 的根目录。
- `cache/`、`logs/`、`cordis.patch.yml`（home 级补丁）、`.env`。
- `.credentials.yaml`：凭据。中心绝不读、不打印、不写。

中心的数据分三处放（与 build-spec 第 4 节一致）：

1. 中心自己的状态（名册、唤醒单、线程、账本）：放 `rootDir`（默认 `~/AgentHub`，可由行 config 的 `rootDir` 或环境变量 `AGENT_HUB_ROOT` 覆盖），用 core 的 FileStore，经 `node:fs` 原子写。不要用 `ctx.fs`：不带会话策略时它被围在 profile 目录里（6.4）。
2. 机器人自己读写的东西（人设、记忆、产出）：放机器人家目录 `<rootDir>/bots/<botId>`，机器人在 workspace-write 下只能写这里。
3. 不要写进插件包目录：重装或升级会覆盖。

路径工具：

```ts
ctx.get('dshHomePath')?.(...segments: string[]): string     // 等于 join(resolveDshHome(), ...segments)；根服务，无需 inject
ctx.get('profileContext')                                    // { name, dir, home, patchPath, installAnchor, startedBundles, cwd, overlays, … }
// 组合包补丁里：config 写 !!js dshHomePath('agent-hub')（官方语音包有同款写法）
```

不要硬编码 `homedir() + '/.dsh'`，那样会忽略 `$DSH_HOME`。桌面版 Host 的环境变量来自主人的登录 shell，所以主人在 shell 配置里设的 `AGENT_HUB_ROOT` 也会作用到桌面版的中心插件。

证据：`dsh-home-paths/lib/index.js:70-86、109-111、124-134`，`dsh-app-boot/lib/index.js:4526`，`dsh/lib/profile-boot-C14i-8IN.js:290-301`，`dsh-experimental-voice-input-bundle/cordis.patch.yml:6-9`，`cordis-plugin-loader/lib/index.js:233-240`，`_app/main.js:12061-12063`。

### 7.2 storageDomain（可选）

中心 v1 用自己的 FileStore，不用它。需要「原子写 + 启动时按 schema 校验 + 变更事件」的小块状态时可以考虑。

```ts
// ctx.storageDomain（inject: ['storageDomain']；dsh-base 默认挂载，本版只有 json 后端，落在 $DSH_HOME/storages/）
open(spec: DomainSpec): Promise<Domain>
// DomainSpec = { name, version, layout?: 'single' | 'per-record', compatibleVersions?: number[], invalidRecords?: 'backup-and-skip',
//                global?: { schema, initial }, tables: { [表名]: { valueSchema: { parse(raw): unknown } } } }
// Domain = { name, table(name): KvTable, global: { get(); set(v): Promise<void> }, close(): Promise<void> }
// KvTable = { get(key); entries(); keys(); size; put(key, value): Promise<void>; update(key, fn): Promise<next>; delete(key): Promise<boolean> }
```

要点：

- 域名和表名必须匹配 `^[a-z][a-z0-9_]*$`（不能叫 agent-hub）。per-record 的 key 必须匹配 `^[a-zA-Z0-9_-]+$`。官方已占用 `schedule`、`workspace`、`session_projcache`。
- 同一进程内每个域只有一条写链，写入依次执行：先持久化（临时文件 → fsync → rename → fsync 父目录），再改内存，再发 `domain/changed`。读是同步的。`update` 的变换函数必须同步。原子性只到单条记录，没有事务，不跨进程。
- open 不会替你跑 `defineDomain` 的校验：`layout` 拼错会被静默当成 single，`invalidRecords` 拼错会静默不备份。手写 spec 时要自己校验。
- 写入时不按 schema 校验，只在 open 时校验。值必须是纯 JSON。single 布局写入 BigInt 或循环引用会污染整个域，之后所有写入都失败，直到重启。
- 句柄不会随插件自动关闭，必须 `ctx.effect(() => () => domain.close())`；await open 期间插件可能已被卸载，这时 `ctx.effect` 抛 INACTIVE_EFFECT，要当场 `await domain.close()` 再抛出，否则域名被永久占用（官方 schedule 就是这样写的）。禁用后马上启用时可能短暂报 already-open，要退避重试。
- 证据：`dsh-storage-domain/lib/index.js:46-91、177-229、232-297、348-416、438-452`，`dsh-storage-json/lib/index.js:9-52、91-102、146-157、215-226、265-270、533-536、561-592`，`dsh-schedule/lib/index.js:2008-2022`，`cordis-plugin-loader/lib/index.js:70-77、373-375`。

### 7.3 文件监听

```ts
ctx.fs.resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>   // 相对路径以 Host 工作目录为基准，一律传绝对路径
ctx.fs.watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
ctx.fs.stat(target): Promise<{ version; type: 'file' | 'directory' | 'other'; size? } | undefined>
ctx.fs.listDir(target): Promise<Array<{ name; type; target; version?; size? }>>                   // 目录不存在抛 FS_NOT_FOUND
```

`ctx.fs.watch` 的限制（实现是 chokidar 5，`depth: 0`、`ignoreInitial: true`）：

- 只监听一层，不递归，不去抖，不轮询。
- 回调只说「有变化」：`changed()` 不带路径、不带事件类型；出错时 `changed(error)`。
- 启动前、DSH 关闭期间的变化收不到，启动时要自己对账一次。
- 监听模式在启动时一次性决定：目标在 watch 时不存在，就退化成「文件模式」，之后目录被创建只触发一次，目录里的新文件永远不报。所以先 `mkdir` 再 watch。
- signal 只能取消初始化这一步；就绪后拿到的关闭函数要挂进 `ctx.effect`，await 期间插件被卸载时要当场关掉。

build-spec 的 `FsIO.watch(path, { recursive }, onChange)` 需要递归和路径。直接用 Node 自带的 `fs.watch(dir, { recursive: true, signal })`（macOS 支持递归），自己去抖，关闭交给 `ctx.effect`。chokidar 不在桌面运行时的共享包里，插件不能直接 import。

证据：`api-catalog:1048、1055、1085、1121`，`dsh-fs-local/lib/index.js:287-327、726-754、780-788`，`dsh-fs-local/README.zh.md:57、95`，`dsh-api-workspace-files/lib/index.js:51-104`，`_app/desktop-runtime.json`（sharedPackages 全是 `@deepseek-ai/*`）。

### 7.4 定时器

- 推荐 2.6 的 `startTicker`：`ctx.effect` 包 `setInterval`，带防重入，每次 tick 兜底。
- 也可以用 cordis-plugin-timer（dsh-base 的 `timer` 行，需要 `inject: ['timer']` 或放进 `ctx.inject(['timer'], …)`）：`ctx.interval(cb, ms)`、`ctx.timeout(cb, ms)` 返回取消函数，随插件卸载自动清除，但不捕获回调里的异常；`await ctx.timeout(ms)` 在插件卸载时会以 `Context has been disposed` reject，必须接住；`ctx.interval(ms)` 的异步迭代器在卸载时 next() 会 reject。
- Node 定时器的最大延迟是 2147483647 毫秒，超过会按 1 毫秒立即触发。不要设长定时器：用 30 到 60 秒的短 tick，每次比对墙钟。
- 睡眠后墙钟会跳：两次 tick 之间的墙钟差远大于周期（例如超过 3 倍），就当作刚从睡眠或挂起中恢复，立刻全量对账一次。macOS 睡眠时定时器怎么计时没有实测（H21）。
- 在某个机器人的调用链里（例如工具 handler 里）创建的共享定时器，要包在 `ctx.agents.withoutInitiator(() => …)` 里，免得继承那个机器人的 initiator。

证据：`cordis-plugin-timer/lib/index.js:4-149`，`dsh-base/cordis.patch.yml:24-25`，`dsh-schedule/lib/index.js:1495、1524-1551、1636-1646`，`api-catalog:183-187、3260-3295`。

### 7.5 可订阅的宿主事件

全集在 `api-catalog` 的 `EVENT_API`（82 个事件，第 3930 行起），载荷类型在 `TYPE_API`（第 4589 行起）。中心会用到的：

| 事件 | 派发方式 | 载荷 | 中心用途 | 注意 |
|---|---|---|---|---|
| `session/event` | emit，派发方逐个兜住 | `(session, event)` | 回合翻译、记账、主人活动 | 同步阶段不能对同一会话 append；不重放历史 |
| `session/created` | 同步调用 | `(session)` | 一般不用 | 同步抛错会否决会话创建 |
| `session/disposed` | emit，兜住 | `(session)` | 清理内存状态 | 离开内存不等于被删除 |
| `agent/created` | serial | `{ agent, source: 'startup' \| 'resume', signal? }` | 给机器人装工具 | 块体、不返回值、不抛错 |
| `agent/disposed` | emit，兜住 | `{ agent }` | 撤销机器人工具 | |
| `agent/status` | emit，兜住 | `{ agent, status: 'idle' \| 'running' }` | 机器人在不在跑 | 一次 running 可能连跑好几轮 |
| `agent/error` | emit，兜住 | `{ agent, turn, step, error }` | 错误告警 | |
| `agent/inbox/inserted` | emit，兜住 | `{ agent, message }` | 主人在 DSH 里给机器人发了话（入队时） | |
| `agent/inbox/claimed` | emit，兜住 | `{ agent, message, turn }` | 唤醒被领取 | |
| `tools/result` | emit，兜住 | `(exec, result)` | 工具计数、清缓存 | |
| `fs/observed` | 同步 | `(target, observation, actor)` | 模型用文件工具碰过哪个文件（`actor?.agent?.id`） | 抛错会让模型的工具调用失败；bash 写文件不触发 |
| `api-session/added`、`removed`、`status`、`error`、`activity` | emit，不兜 | 纯 JSON | 侧栏同步 | async 监听器 reject 会让宿主退出；activity 只在 source.kind 为 user 时发 |
| `domain/changed` | emit，只兜同步异常 | `{ domain, table, key, operation, value? }` | storageDomain 变更 | 所有域都发，先按 domain 过滤 |
| `schedule/changed` | emit，只兜同步异常 | 无 | DSH 自带定时任务变化 | |
| `goal/changed` | emit | `{ agent, change }` | DSH 目标变化 | 中心不用 DSH 目标 |

证据：`api-catalog:3930、3956-4083、4220-4249、4260-4275、4348-4394、4500-4505`，`dsh-session/lib/index.js:1231-1240、1579-1598、1901-1923`，`dsh-agent/lib/index.js:242-273、549-590`，`dsh-api-session-controller/lib/index.js:2980-3004`，`dsh-jobs-local/lib/index.js:72-89`，`dsh-storage-domain/lib/index.js:214-220`，`dsh-schedule/lib/index.js:2231-2237`，`dsh-tool-fs/lib/index.js:195、350-353`。

DSH 自带定时提醒到点时的顺序：dsh-schedule 先构造 `{ kind: 'schedule' }` 消息，再 `agent.followup`，再 flush；入队时就出现 `agent/inbox/inserted`；`user/message` 要等这一轮真正开始处理时才写入，机器人正忙时会滞后。证据：`dsh-schedule/lib/index.js:1586-1597`，`dsh-agent-loop/lib/index.js:180-208、1061-1073`。

后台作业事件不走 `ctx.on`：`ctx.jobs.events.subscribe(filter, listener)`（inject `jobs`），filter 为 `{ owners: 'all' }`、`{ owner: sessionId }` 或 `{ owners: 'scope' }`；按 owner 过滤时，没有 owner 的作业事件也会放行，要自己再查。证据：`dsh-jobs-local/lib/index.js:53-89`，`api-catalog:1294、5703-5800`。

### 7.6 主人是否活跃

宿主进程里没有「窗口在前台」「主人活跃」「空闲多久」之类的事件或服务。Host 是独立的 Node 子进程，主进程发给它的控制消息只有 shutdown、quit-inspection、update-tasks 三种；主进程监听窗口的 focus、show，只用来检查更新，不转发。证据：`_app/main.js:3652、3664-3701、12893-12916`，`dsh-desktop-host/lib/index.js:268-327`。

能拼出来的代理信号：

1. 宿主侧：主人在任一非机器人会话里亲手发了消息。看 `session/event` 里的 `user/message`，`source.kind === 'user'`，并排除 rpcId 以 `agent-hub:`（中心转发）和 `claude-bridge-`（桥）开头的消息（见 3.4 的翻译器）。不要直接用 `api-session/activity`：`sessionController.prompt` 发出的消息都标成 user，principal 区分不了主人和进程内调用方。证据：`dsh-api-session-controller/lib/index.js:2997-3004、3218-3230`，`dsh-typert-protocol/lib/index.js:294-297`。
2. 审批：只有 outcome 为 allowed-once（以及确实由人点出的 rejected）的 `approval/decided` 才说明主人在场；never 策略的自动拒绝、cancelled、unavailable 都不算。证据：`dsh-user-approval/lib/index.js:30-35、172-189`。
3. 客户端侧：界面半边在页面里监听 `visibilitychange`、`focus`、`blur`、`online`、`offline`，有变化时上报给宿主路由（例如 `POST /api/agent-hub/presence`）。点关闭窗口只是隐藏，页面仍在运行；窗口没有关掉 backgroundThrottling，隐藏后定时器会被节流，所以靠事件上报，不靠心跳，宿主把「很久没上报」当作「未知」。隐藏时的实际取值没有实测（H22）。证据：`_app/main.js:11935-11969、12894-12906`。

### 7.7 睡眠、网络、启动和退出

- 睡眠与唤醒：Host 拿不到 Electron 的 powerMonitor（它只在主进程里，resume 只用来检查更新）。用 7.4 的墙钟跳变检测。证据：`_app/main.js:5、12697-12708、13066-13068`。
- 绝不要在宿主进程里调 `process.send()`：主进程收到不认识的 IPC 消息会直接用 SIGTERM 杀掉 Host。证据：`_app/main.js:3818-3822`。
- 网络：Host 里没有网络事件。可用的信号是 `turn/end` 的 error 码 TRANSPORT、TIMEOUT，`agent/request-error` 的 failure，页面的 `navigator.onLine`，或中心自己低频探测。证据：`dsh-llm/lib/index.js:247-257`。
- 启动完成：`ctx.get('appReady')?.onReady(cb)` 在整棵插件树加载完、必需行审计通过后回调一次；已经就绪就立即回调；返回取消函数。适合做启动后的第一次全量对账。`appExit` 是请求退出用的，插件不要调用。这一版 cordis 没有 `ready`、`dispose` 事件，一律用 effect。证据：`dsh-cmdline/lib/index.js:27-32`，`dsh/lib/profile-boot-C14i-8IN.js:87-108、307-314`。
- 退出：用户退出时，主进程先向 Host 发 quit-inspection（期限 2 秒）。有活跃任务（running 或队列非空的会话、运行中的作业）、已加载的会话里有定时提醒，或者查询失败、超时，都会弹确认框。常驻机器人在跑时，主人退出会看到「有任务在运行」。确认后主进程给 Host 发 shutdown，Host 用 5 秒宽限释放整棵插件树（各插件的 effect 清理按逆序执行）；主进程那边 10 秒后 SIGTERM，再过 5 秒 SIGKILL。系统关机或注销时跳过确认框。所以收尾逻辑写进 `ctx.effect`，几秒内完成，不依赖网络。证据：`_app/main.js:3663、3870-3877、3910-3925、11622-11673、13066-13127`，`dsh-desktop-host/lib/index.js:100-101、147、160-181、263-297、325-327`。
- 可选：quit-inspection 会对每个在线会话跑 `workspace/session-activity` waterfall，回答里带 `{ kind: 'schedule', items: [{ id, label }] }`，确认框就会提示「定时任务不会运行」。副作用是同一个 waterfall 也决定能否归档会话（回答非空就拒绝归档），监听器还受 2 秒预算约束且不能抛错。要不要做是产品决定。证据：`dsh-schedule/lib/index.js:2043-2062`，`api-catalog:4572-4586`。

## 8 客户端界面插件

### 8.1 bundle 格式

- `lib/client.js` 是经典脚本，宿主用 `<script src>` 加载，而且会把多个插件的 client.js 原样拼接成一个合并资源（URL 形如 `plugins/??<id>/client.js,<id2>/client.js&rev=<rev>`，拼接时去掉末尾的 `//# sourceURL=` 和 `//# sourceMappingURL=` 注释）。所以：
  - 文件顶层不能有 `import`、`export`（经典脚本里是语法错误）。
  - 顶层的 `let`、`const`、`class` 会进入所有经典脚本共享的全局词法作用域，和别的插件重名就 SyntaxError；`function`、`var` 会挂到 window 上。所有代码都放进 factory 闭包。
  - 某个合并资源没能登记某一行时，这一行会退回自己的单独 URL 重试（每行最多 3 次请求）。
- 整份文件只调用一次 `window.__ModuleLoader__.load({ id, factory })`：
  - `id` 必须等于 package.json 的 name（结尾的 `/client` 会被去掉，二者等价）。对不上报「loaded without registering "<id>" via __ModuleLoader__.load」；同一个 id 登记两次报 duplicate factory registration。
  - 执行脚本时只登记 factory，第一次 import 时才调用 `factory(require)`，返回值作为模块导出并缓存。
  - Loader 取插件时用 `e.default ?? e`，遇到 `__esModule` 再取一次 default。所以 factory 直接 `return { inject, apply }` 普通对象就行，`Symbol.toStringTag` 不是必需的。
- 客户端条目只以 `{ name: 包名 }` 创建，拿不到补丁行里的 config。需要配置时走宿主接口。
- 只有「有 fiber 且没被禁用」的 Loader 行才参与客户端组合，宿主行被禁用，界面半边也一起卸下。

证据：`dsh-client-modules/lib/client.js:16-23、484、581-594、702-714、728-775、803-830`，`dsh-client-modules/lib/index.js:166-182、255-265、337-341、852-858`，`dsh-web-frontend/dist/assets/index-BXV-oxvX.js:17`，`dsh-client-modules/README.zh.md:34、38`，`dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js:1-22`。

### 8.2 factory 能 require 的模块

`require` 按顺序查找：冻结的基座模块表 → 已物化的模块 → 已登记但还没物化的 factory。都找不到就抛 `client-modules: require("x") missed the module table`。基座模块表的键（必须写全名）：

- `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`（React 18.3.1）
- `@deepseek-ai/cordis`
- `zod`（4.4.3）
- `@tanstack/react-virtual`
- `@deepseek-ai/dsh-client-store`（只导出 createSnapshotStore、defineStore、notifySubscribers、shallowEqual）
- `@deepseek-ai/dsh-client-ui-slots`
- `@deepseek-ai/dsh-client-ui-primitives`
- `@deepseek-ai/dsh-client-ui-dockkit`

规则：

- 表里没有 `react/jsx-dev-runtime`、`react-dom/server`，打包时不能开 jsxDev。
- 官方规则：不要 require `@deepseek-ai/dsh-client-ui-primitives` 或任何 Harness 客户端包，虽然它在表里。
- 写短名（例如 `dsh-client-store`）会抛 missed the module table。
- 其他插件的客户端半边要写进 `dsh.client.external`，组合时才会排到前面先到达。

证据：`dsh-web-frontend/dist/assets/index-BXV-oxvX.js:25、59、120、188、190`（函数 OZ 返回的基座表），`dsh-client-modules/lib/client.js:777-794、832-841`，`dsh-client-modules/README.zh.md:51`，`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:35`。

### 8.3 apply(ctx)：服务、inject 和启动审计

页面启动时会审计：任何一个 Loader 条目没进入 active（bundle 语法错、require 了表外模块、factory 或 apply 抛错、顶层 inject 的服务一直不存在），前端就抛「web boot: N entries did not activate」。桌面版会把它交给主进程，弹致命错误框（退出 / 重启 / 禁用第三方插件并重启）。运行中热装失败只显示在「设置 → 插件 → 插件列表」，下次启动才变成致命错误。所以：

- 顶层 inject 只放随基座必有的 `['slots', 'locale']`。
- 其余服务用 `ctx.get(name)`（不需要 inject；提供方还没激活时返回 undefined），或放进 `ctx.inject([...], (c) => {…})` 子插件。子插件不在启动审计范围内，一直 pending 也不会让整页起不来。
- apply 整体 try/catch，不要在 apply 里 await 网络。
- Cordis 4 的 inject 没有「可选」：列出的都是必需。

证据：`dsh-web-frontend/dist/assets/index-BXV-oxvX.js:188、190`，`_app/main.js:8355-8380、12433-12438`，`cordis/lib/index.js:672-692、761-770、1491-1500`，`dsh-client-modules/README.zh.md:42`。

可用的客户端服务（中心会用到的）：

- `slots`：插槽，见 8.4。
- `locale`：`ctx.locale.register(namespace, { zh, en })`；同一个 namespace 和语言重复注册会抛错。
- `layout`：`selectPanel(id | null)`，见 8.7。
- `uiWorkspace`：`openSession(target)`、`startSession(…)`，见 8.7。
- `theme`：`getTheme()` 返回 `{ preference, fontSizes, fontFamilies, active: { colorScheme, tokens }, themes, revision }`。
- `timer`：由默认启用的 cordis-client-runner 全局提供，`ctx.interval(cb, ms)` 会自己挂 effect、卸载时清理。也可以直接用 `ctx.effect` 包 `setInterval`。
- `remote`：`ctx.remote.$on(事件名, 监听器)`，只能听宿主转发白名单里的事件（`api-session/added|removed|status|activity|error`、`schedule/changed` 等），中心自定义的宿主事件不会转发。官方命名空间（session、schedule……）各自是一个子服务 `remote.<命名空间>`，调用 `ctx.remote.schedule.xxx()` 这类方法必须 inject `'remote.schedule'`，只注入 `'remote'` 会抛 without inject。中心的界面用自己的路由（8.5）和 SSE（8.6），通常用不到 remote。

客户端事件只有四个：`connection/reset`（与宿主重新连上，要重拉全量）、`locale/change`、`slots/changed`、`theme/change`（载荷是主题快照）。

证据：`dsh-cordis-client-runner/lib/client.js:1690-1730、7227-7239、7286-7295、7467`，`dsh-api-gateway/lib/client.browser.js:1638-1641、1679-1682、1953-1962、2074-2076`，`dsh-api-remotes/lib/index.js:21-139`，`dsh-client-ui-schedule/lib/client.js:7365-7377`，`dsh-client-locale/lib/client.js:1387-1396`，`dsh-client-ui-theme/lib/client.js:1693-1695、1848-1880`，`dsh-client-ui-layout/lib/client.js:622`。

### 8.4 插槽：左侧栏入口和中栏页面

模型：`ctx.slots.inject(插槽名, () => ctx.slots.register(选项, 组件))`。插槽分 single、keyed、list、chain 四种，作用域分根级和会话级。组件拿到的 props 由「标准工具 + t + 条目的 inject 结果 + 插槽的 inject + owner props」合成，owner props 优先级最高。证据：`dsh-client-ui-renderer/lib/client.js:435-457、850-858、1354-1425、1603-1621`。

注册冲突规则（已改正，以代码为准）：

- single 插槽已有同 priority 的条目，再注册直接抛「single slot "x" already has a registration at priority 0 — register at a different priority to shadow it (lowest renders)」。要遮蔽官方占位，必须显式给更小的 priority，数值小的渲染。插槽目录文档里「注册已占用的 key 会替换它」的说法与代码不符。
- keyed 插槽同 key 同 priority 抛错；list 插槽同 id 同 priority 抛错。
- 抛错时机：插槽已声明时在 apply 里同步抛出，插件变成 failed（启动时就是致命框）；插槽之后才声明时，错误在 microtask 里抛出，这次注入停止。
- 所有 key 和 id 加 `agent-hub` 前缀。

证据：`dsh-web-frontend/dist/assets/index-BXV-oxvX.js:120`（SlotCore.register），`dsh-cordis-client-runner/lib/client.js:4372-4383`。

中心用到的插槽：

- `main`：keyed，根级，key 是面板 id。中栏只渲染当前选中的那一页（`activePanelId ?? 'conversation'`）。已占用的 key：`conversation`（保留）、`plugins`、`schedules`。
- `sidebar.panellist`：list，根级，选项 `{ id, order, label }`，label 可以是函数，同时用作可见文字、无障碍名称和折叠提示；组件拿到 owner props `{ size, active }`。已占用：插件页 order 0，自动化任务 order 10。主人可以在侧栏「更多」菜单里收起自定义面板行（只存内存，刷新后恢复），所以从代码打开页面要用 `layout.selectPanel`。
- `shell.overlay`：list，整层点击穿透，toast 放这里；需要可点的部分自己加 `pointer-events: auto`。
- `shell.bottom`：single，默认组合里没人占，可以当三栏下方的整行座位，但同一时间只能有一个占用方。
- `sidebar.session.row.leading`、`sidebar.session.row.hover`：根级，owner props 给 `{ sessionId }`，适合在机器人会话行上加标记。leading 只在该行状态为 idle 时渲染，归档行留空；hover 只在悬浮卡片打开时挂载。官方特意把它们设计成根级，因为会话级插槽会强制激活列表里的每个会话。
- 会话级插槽（`conversation.session.header.actions`、`header.utilities`、`conversation.input.dock`、`conversation.view`）：只挂在当前被渲染的会话界面里，切换会话时重挂，不是所有会话同时常驻。后台逻辑不要放在会话级组件里。
- 设置相关：`settings.section`（设置弹窗里单独一页，owner props `{ close }`）、`settings.general.item`（通用页里的一行，整行自绘）、`plugins.bundle.config`（key 是组合包包名，只以 `{ view: 'page' }` 渲染，不带表单）、`plugins.row.config`（key 是 `'<包名>#<行 id>'`，以 `{ view: 'page', form }` 或 `{ view: 'summary' }` 渲染）。`plugins.item` 被官方设置页占用，不要用。Config 不会自动生成表单（2.3）。

证据：`dsh-cordis-client-runner/lib/client.js:2434-7146`（103 个插槽的目录），`dsh-client-ui-layout/lib/client.js:117-119、468-472`，`dsh-client-ui-layout/README.zh.md:12、32、34`，`dsh-client-ui-sidebar/README.zh.md:38、40`，`dsh-client-ui-workspace/README.zh.md:96`，`dsh-client-ui-plugin-manager/lib/client.js:20-35、2818-2823、2964`，`dsh-client-ui-schedule/lib/client.js:7472-7540`。

组件抛错时，这个条目被摘除，控制台打印「slot entry crashed in '<插槽名>'」（list 和 single 会让出座位）。复杂组件自己包一层错误边界。证据：`dsh-client-ui-renderer/lib/client.js:638、1140`。

界面半边入口（源码形态，esbuild 打包后被 8.9 的 banner/footer 包进 factory）：

```js
// src/client/index.jsx：只注册插槽和样式，不在模块顶层做任何副作用
import css from './styles.css'                 // esbuild 用 text loader 当字符串导入
import { HubPage } from './pages/HubPage.jsx'
import { HubIcon } from './components/HubIcon.jsx'

const PANEL_ID = 'agent-hub'

export const inject = ['slots', 'locale']      // 只放随基座必有的服务
export function apply(ctx) {
  try {
    // 样式在 apply 的 effect 里插入并返回移除函数（官方作者规范：factory 无副作用）
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-agent-hub'
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }, 'agent-hub: styles')
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, HubPage))
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: 15, label: () => '队友',
    }, HubIcon))
  } catch (error) {
    console.error('[agent-hub] client apply failed', error)
  }
}
```

官方 schedule 注册 `sidebar.panellist` 时还传了 `locale`，这两个插槽有没有别的必填选项，以运行中的 `cordis_inspect_query` 的 `Slots.listSubTree` 为准（H29）。

### 8.5 界面调宿主

宿主侧用 Connection 的精确路由（带鉴权）：

```ts
ctx.connection.fetch.register(route: {
  path: string                                  // 以 /api/ 开头；/api/ 之后每一段匹配 ^[A-Za-z0-9_$.-]+$，不能是空段、. 或 ..；多段可以
  methods: ('GET' | 'HEAD' | 'POST')[]          // 非空、不重复
  requestBody: 'buffered' | 'streaming'         // 类型上必填；GET 必须写 'buffered'
  fetch: (request: Request) => Promise<Response>
}): () => unknown                               // 返回取消函数；注册同时挂在调用方 ctx 的 effect 上，插件卸载自动注销；同一路径重复注册抛错
ctx.connection.requestRejection(req: IncomingMessage): 401 | 403 | undefined
```

- 鉴权链：Host/Origin 栅栏（失败 403）→ cookie 或 API 认证（失败 401）→ `connection/request` waterfall（桌面版更新锁定期间回 503）→ 精确路由只放行主人身份（否则 403）。不接受 Authorization 头。
- `requestBody` 不写或写 `'streaming'` 时，桥接层会用流式 body 构造 Request；GET 带 body 按 Fetch 规范抛 TypeError，最后回 400。官方 GET 路由全部写 `'buffered'`。buffered 请求体超过上限回 413。
- 桌面版更新锁会等所有在途的 `/api` 请求结束，所以这类路由只适合短请求，长连接放到 8.6 的路由上。
- 返回的 Response 头会原样写回，可以自定义头。

证据：`dsh-client-connection/lib/index.js:14、40-110、240-251、690、731-740、816-853、926-931、972-978、1036-1066`，`dsh-client-connection/README.zh.md:41-53`，`dsh-desktop-host/lib/index.js:108-147`，`dsh-client-ui-deliverables/lib/index.js:47-96`，`api-catalog:684-735、5044`。

```js
// 宿主侧：只读视图用 GET，命令用 POST；路径前缀统一 /api/agent-hub/
export function registerRoutes(ctx, getHub) {
  const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } })
  ctx.connection.fetch.register({
    path: '/api/agent-hub/overview', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => {
      const hub = getHub()
      if (!hub) return json({ starting: true }, 503)                 // 引擎还没起来
      try { return json(await hub.api.overview()) } catch (error) { return json({ error: String(error) }, 500) }
    },
  })
  ctx.connection.fetch.register({
    path: '/api/agent-hub/command', methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      const hub = getHub()
      if (!hub) return json({ ok: false, error: '中心还在启动' }, 503)
      try {
        const { name, input } = await request.json()                 // { name, input } → CommandResult
        return json(await runCommand(hub.api, name, input))
      } catch (error) {
        return json({ ok: false, error: `命令执行失败：${String(error)}` }, 400)
      }
    },
  })
}

// 界面侧：文档相对路径，不加任何鉴权头（桌面版由主进程注入 Host cookie，web 版同源）
export async function fetchOverview() {
  const res = await fetch('api/agent-hub/overview')
  if (!res.ok) throw new Error(`overview ${res.status}`)
  return res.json()
}
```

裸路由 `ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler(req, res) })`：

- 只把路由写进表并返回 disposer，不会自动进 effect，必须写成 `ctx.effect(() => ctx.webServer.register(…))`。匹配顺序是先精确路由，再最长前缀，最后 fallback。
- 它本身没有任何认证或来源检查。要鉴权就在 handler 第一行调 `ctx.connection.requestRejection(req)`，返回 401 或 403 就照写状态码结束（官方 open-in-app 就是这样）。
- 不要把裸路由放在 `/api/` 下：精确优先、最长前缀优先的规则会让它抢在 Connection 的 `/api` 网关之前，绕过鉴权。主人旧插件 dsh-auto-upgrade 的 `/api/dsh-upgrade` 就是这种情况。
- 证据：`dsh-host-webserver/lib/index.js:320-333、399-410、494-505`，`dsh-host-webserver/README.zh.md:61、130`，`dsh-host-open-in-app/lib/index.js:1126-1133、1263-1283`。

### 8.6 实时推送（SSE）

放在 `/api` 之外的裸 webServer 精确路由上，handler 第一行鉴权。理由：桌面版页面没有 transport.fetch，官方常驻的 dsh-client-hmr 就是用 `new EventSource('plugins/events')` 经 `dsh-app://` 协议转发到 Host 的裸路由（协议注册时带 `stream: true`，转发时响应体流式透传）；webServer 的 gzip 会跳过 `text/event-stream`；长连接挂在 `/api` 上会卡住桌面版的更新锁，而且桥接层在客户端断开后还会把响应流读完，不结束的流会泄漏。

```js
// 宿主侧：推送器被 SSE 路由和 Hub 订阅共用。Hub 在 init 里才建好，所以订阅放在 init：
//   const unsubscribe = hub.subscribe((event) => pusher.broadcast(event))（取消订阅交给 hub.stop 或插件 effect）
export function createPusher() {
  const streams = new Set()
  return {
    streams,
    broadcast(event) {                                      // Hub 的变更通知 → 所有在线页面
      const line = `event: changed\ndata: ${JSON.stringify({ scope: event.scope, botId: event.botId })}\n\n`
      for (const res of streams) if (!res.destroyed && !res.writableEnded) res.write(line)
    },
    closeAll() { for (const res of streams) res.end(); streams.clear() },
  }
}

// 放在 ctx.inject(['webServer'], (sub) => sub.effect(() => registerEvents(sub, pusher))) 里（见 2.8）。
// sub 能读到父插件顶层 inject 过的 connection。
export function registerEvents(sub, pusher) {
  const unregister = sub.webServer.register({
    kind: 'exact',
    path: '/agent-hub/events',                              // 故意不放在 /api 下
    handler(req, res) {
      const rejection = sub.connection.requestRejection(req) // 与 /api 相同的 Host/Origin 和 cookie 校验
      if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const ping = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n') }, 25_000)
      const drop = () => { clearInterval(ping); pusher.streams.delete(res) }
      pusher.streams.add(res)
      res.on('close', drop)
      res.on('error', drop)
    },
  })
  return () => { pusher.closeAll(); unregister() }          // webServer 重启或插件卸载时收尾
}
```

```js
// 界面侧（apply 里）：文档相对路径；断线自动重连；重连后重拉全量
ctx.effect(() => {
  const es = new EventSource('agent-hub/events')
  es.addEventListener('changed', (e) => { try { store.invalidate(JSON.parse(e.data)) } catch {} })
  return () => es.close()
}, 'agent-hub: sse')
ctx.on('connection/reset', () => store.reloadAll())
```

证据：`dsh-client-hmr/lib/index.js:117-160`，`dsh-client-hmr/lib/client.js:235、249-262、287-305`，`dsh-web-frontend/dist/assets/index-BXV-oxvX.js:190`，`_app/main.js:8258-8299、11880-11890`，`dsh-host-webserver/lib/index.js:197-205`，`dsh-client-connection/lib/index.js:96-104`。第三方路由走这条链路的长期稳定性没有实测（H27）。

### 8.7 导航

下面这些客户端服务不在顶层 inject 里，用 `ctx.get('layout')`、`ctx.get('uiWorkspace')`、`ctx.get('pluginNavigation')` 取，取不到就不做。

```ts
ctx.layout.selectPanel(panelId: string | null): void
//   切中栏页面；key 没在 main 注册会抛「layout.selectPanel: main panel "x" is not registered」；null 回到会话界面但不换会话；刷新后重置
ctx.uiWorkspace.openSession(target: SessionId): void
//   同步把中栏切回会话界面并选中这个会话（内部 layout.selectPanel(null)），不等历史加载
ctx.uiWorkspace.startSession(workspaceId?: WorkspaceId, options?: { prompt?: string; whenDraftExists?: 'keep' | 'replace' | 'append'; clearPreviousDraft?: boolean; agentPreset?: string }): void
//   打开或复用该项目的空白会话并预填草稿，不会发送
ctx.pluginNavigation.openBundle(packageName: string): void          // 跳到插件页里这个组合包的页面
```

- 中栏页面没有 URL 路由，选中状态刷新即重置。
- `openSession` 会把主人从当前全局面板切走。
- 右侧栏标签（`ctx.sidebarRightTabs.register` 加 `ctx.sidebarRight.openTab`）只作用于屏幕上的会话，中栏是全局页时调用会抛错；标签参数刷新后丢失。中心 v1 不用。

官方打开会话前先判断能不能打开（`sessionLinkState`）：

```js
/** 打开机器人的工作会话；返回 'opened'、'loading'、'archived' 或 'unavailable' */
export function openBotSession(ctx, sessionId) {
  const ws = ctx.get('uiWorkspace'), sessions = ctx.get('sessions'), workspaces = ctx.get('workspaces')
  if (!ws || !sessions || !workspaces) return 'unavailable'
  const list = sessions.list.getSnapshot()
  const wsList = workspaces.list.getSnapshot()
  if (wsList.state === 'error') return 'unavailable'                 // 官方的第一步判断
  if (list.phase === 'pending' || wsList.phase === 'pending') return 'loading'
  if (wsList.archivedSessionIds.includes(sessionId)) return 'archived'
  if (!list.ids.includes(sessionId)) return 'unavailable'
  ws.openSession(sessionId)
  return 'opened'
}
```

证据：`dsh-client-ui-layout/lib/client.js:117-119、407、468-472、622`，`dsh-client-ui-workspace/lib/client.js:1471-1510`，`dsh-client-ui-workspace/README.zh.md:74`，`dsh-client-ui-schedule/lib/client.js:3651-3657、7441-7443`，`dsh-cordis-client-runner/lib/client.js:1489-1610`，`dsh-client-ui-sidebar-right/README.zh.md:74、83-84、93、97`，`dsh-experimental-client-ui-voice-input/lib/client.js:2888-2890`。

### 8.8 主题、样式和应用内提示

- 颜色只用 `var(--dsw-alias-*)`（共 107 个，例如 `--dsw-alias-bg-base`、`--dsw-alias-toast-bg`、`--dsw-alias-toast-label`），亮暗自动跟随：主题呈现器切换 `body[data-ds-dark-theme]` 并把当前 token 写成 body 上的内联变量。非颜色 token 有 `--dsw-radius-*`、`--dsw-shadow-lv1` 到 `lv3`、`--dsw-font-*`、`--dsh-content-font-size`。
- `--dsh-frame-top-clearance` 在 macOS 是 48px，普通浏览器里不存在，必须写兜底值：`calc(28px + var(--dsh-frame-top-clearance, 0px))`。官方任务页只在 `[data-platform=darwin]` 下给标题加它。
- 主人旧插件里的 `--dsh-accent`、`--dsh-fg`、`--dsh-border`、`--dsh-bg` 在 308 个包里都没有定义，不要用。
- 样式：在 apply 的 `ctx.effect` 里插入 `<style data-plugin="dsh-agent-hub">` 并返回移除函数，或者在组件里渲染 `<style>`。不要在模块顶层或组件之外写 DOM（官方作者规范）。
- 应用内提示：客户端没有通用 toast 服务（`workspace.toast` 的 key 由 ui-workspace 写死）。官方做法是功能插件自己持有提示状态，在 `shell.overlay` 注册条目渲染。官方 Toast 的样式可以照抄：`position: fixed; top: 40px; left: 50%; transform: translate(-50%); z-index: 1100; pointer-events: none; max-width: min(640px, calc(100vw - 48px)); padding: 12px 16px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-toast-bg); color: var(--dsw-alias-toast-label); font-size: 14px; line-height: 22px; box-shadow: var(--dsw-shadow-lv3)`，淡入 0.16 秒，停留 3 秒后 1 秒淡出。

证据：`dsh-client-ui-theme/lib/client.js:1413`，`dsh-client-ui-layout/lib/client.js:540-568`，`dsh-client-ui-layout/README.zh.md:39、43、47`，`dsh-client-ui-schedule/lib/client.js:147-197、2433`，`dsh-web-frontend/dist/assets/index-BNyAYEM7.css:1`，`dsh-cordis-client-runner/lib/client.js:5481-5539、6957-6985`，`dsh-agent-preset/skills/cordis-plugin-development/references/ui-plugin.md:9、13`，`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:33-36`。

### 8.9 构建界面半边

esbuild 配置（与当前 `packages/plugin/build.mjs` 一致）：

- `platform: 'browser'`、`format: 'cjs'`、`bundle: true`、`jsx: 'automatic'`、`jsxDev: false`、`splitting: false`。
- `external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']`。用到 zod 或 `@tanstack/react-virtual` 时也设成 external。
- CSS 用 `loader: { '.css': 'text' }` 当字符串导入。
- banner 写 `window.__ModuleLoader__.load({ id: 'dsh-agent-hub', factory: function (require) { var module = { exports: {} }; var exports = module.exports;`，footer 写 `return module.exports } })`。esbuild 的 cjs 输出会给 exports 设 `__esModule`，Loader 能正确取到导出；基座表里的 react 是带 default 的合并命名空间，esbuild 的 `__toESM` 能兼容。
- 产物只有一个 `lib/client.js`。如果拆 chunk，官方协议是 `require.async('./client.<name>.js')`，入口和 chunk 之间不能同步 require。

上面的配置按源码契约推导，D01 已产出过产物；在真实页面里物化的结果见 H26。证据：`dsh-client-modules/lib/client.js:842-848`，`dsh-client-modules/README.zh.md:38、73`，`dsh-web-frontend/dist/assets/index-BXV-oxvX.js:2`。

## 9 通知、远程与手机、浏览器、联网工具、MCP

### 9.1 通知

插件能调用的系统通知、Dock 角标接口都没有：

- 宿主服务清单（`api-catalog` 的 SERVICE_API，98 个键，而且是 monorepo 全集）里没有 notify、notification、badge 一类服务。
- Electron 主进程只在「强制更新提醒」里用了系统通知；Dock 只调用过 bounce；开放给页面的 IPC 通道里没有通知或角标；macOS 上没有托盘图标。
- 网页前端和所有客户端包都不调用 Web Notification API。

证据：`api-catalog:15-3929`，`_app/main.js:5、6707-6713、6981-7006、9670-9760、11695-11730、12803-12816`。

可行的做法：

1. 宿主侧弹 macOS 通知（HostPort.notify 用这个）。Host 是 `ELECTRON_RUN_AS_NODE` 的 Node 进程，拿不到 Electron 的 Notification，只能起子进程跑 osascript。把标题和正文作为参数传入脚本，不拼进脚本字符串，就不用处理引号转义：

```js
import { execFile } from 'node:child_process'

/** 弹一条 macOS 通知。标题和正文作为 argv 传给 AppleScript，避免转义和注入问题 */
export function notifyMac(title, body) {
  const script = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run']
  const args = script.flatMap((line) => ['-e', line]).concat([String(title).slice(0, 80), String(body).slice(0, 200)])
  execFile('/usr/bin/osascript', args, { timeout: 10_000 }, (error) => {
    if (error) console.warn('[agent-hub] notify failed:', error.message)   // 回调里不抛错
  })
}
```

   通知来源会显示成什么、点击后会不会打开 DSH，属于 macOS 的行为，没有实测（H35）。

2. 页面里用 Web Notification：桌面版页面是 `dsh-app://app/`，注册为 standard、secure，属于安全上下文；主窗口用的默认 session 对 media 以外的权限一律放行；点关闭窗口只是隐藏，页面仍在运行。代码层面可行，没有实机验证（H33）。注意窗口隐藏后定时器会被节流，要靠 SSE 推送（8.6）而不是轮询。证据：`_app/main.js:7062-7085、11880-11890、11935-11968、12134、12417、12880-12906`。

3. 把窗口叫回前台：`execFile('/usr/bin/open', ['dsh://open'])`，主进程会调用 focusPrimaryWindow。只在打包版（或设置了 `DSH_DESKTOP_DEV_APP=1`）注册了 `dsh://` 协议；还没进入工作区时 focusPrimaryWindow 直接返回。证据：`_app/main.js:13031-13062`。

4. 应用内提醒：`shell.overlay` 浮层（8.8）；侧栏会话行的标记插槽（8.4）。

Dock 角标：主进程没有调用 setBadge；页面的 `navigator.setAppBadge` 会不会映射成 Dock 角标没有实测（H34）。

想在主人的普通会话等审批或等回答时也提醒，可以 prepend 监听 `approval/request` 和 `user-questions/request`，只发通知、然后 `return next()`，不替主人作答。用 `const outcome = await next()` 能拿到最终结果，再撤掉提醒。用 `ctx.typertGateway.hasLiveClient()` 可以判断此刻有没有能作答的页面（桌面版窗口隐藏时仍算在线）。证据：`dsh-api-gateway/lib/index.js:841-844`，`dsh-api-remotes/lib/index.js:146-180`。

### 9.2 远程与手机

桌面版不能直接从手机访问，也没有开关：Host 固定以 `--no-open --host 127.0.0.1 --port 0` 启动，带 token 的地址只通过 IPC 交给 Electron；desktop 这个 profile 名留给 Electron 专用，CLI 拒绝启动它。证据：`dsh-desktop-host/lib/index.js:217-243、342-349`，`dsh/lib/bin.js:36`。

官方的远程路径是另起一个 web 进程：

```bash
# 局域网（明文 HTTP，只在可信网络用，启动时会告警）
dsh --profile web --no-open --host 192.168.1.23 --port 3080
# Tailscale + TLS：必须加 --public-url，否则打印的带 token 链接是 IP 地址，和证书上的名字对不上
dsh --profile web --no-open --host 100.101.102.103 --port 3080 --tls-cert ./mac.ts.net.crt --tls-key ./mac.ts.net.key --trusted-host mac.tailnet-xxxx.ts.net --public-url https://mac.tailnet-xxxx.ts.net:3080/
```

- `--host` 只接受一个具体的本机 IP，通配地址会报错；`--tls-cert` 和 `--tls-key` 必须成对；loopback 和绑定 IP 之外的地址要用 `--trusted-host` 点名。
- 首次用打印的带 token 地址打开，换一个签名 cookie（HttpOnly、SameSite=Strict、默认 30 天、绑定 host:port）。token 在进程存活期间可以反复使用，不要外传。
- 所有认证通过的访问者都是 owner，能跑 bash；没有 logout，撤销要删凭据记录再重启。
- 不要和桌面版共用同一个 `DSH_HOME` 同时运行：两个进程会抢同一会话的写锁，JSON 存储没有跨进程锁，会互相覆盖 schedule 和 workspace 数据（H36）。
- `ctx.remoteAccess` 只是给非 owner 访问者做方法级控制的空框架，没有任何策略实现，做不了只读分享。

证据：`dsh-web-app/README.zh.md:16、41、51-58、65、67、79-83、173`，`dsh-web-app/lib/startup.js:25、44-68`，`dsh-client-connection/README.zh.md:41-51`，`dsh-client-connection/lib/index.js:458-481`，`dsh-storage-json/README.zh.md:141`，`dsh-api-remote-access/README.zh.md:12、27-36`。

中心 v1 的手机路径（build-spec 第 17 节放在后续）：先做只出不进的推送，例如飞书自定义机器人 webhook；收主人回复要长连接（飞书 SDK），不在 v1。宿主插件可以直接用 Node 的 fetch 发出去（沙箱不管网络）。密钥变量名必须含 TOKEN、SECRET 或 KEY，否则会出现在机器人 bash 的 env 里（6.4）；`$DSH_HOME/.env` 文件本身仍能被机器人的读文件工具读到。飞书签名算法要对照飞书官方文档实测（H39）。主人的回复转给机器人时用 `prompt`，requestId 用飞书消息 id 拼成（同一个 requestId 只入队一次），见 3.3。

### 9.3 浏览器

- 侧栏浏览器（dsh-client-ui-sidebar-browser）只给人用：不注册工具、提示段或会话事件。每个工作区一个分区，Cookie 不持久；拒绝权限请求、下载、HTTP 认证；拒绝访问 DSH 自己的 Host 地址。插件能做的只是替主人打开一个标签：客户端 `ctx.get('sidebarRight')?.openTab('browser', { params: { url } })`，而且只在屏幕上有会话时可用。
- 随桌面版发货的 308 个包里没有任何给模型用的浏览器自动化工具。dsh-browser-use、dsh-computer-use 和几个 experimental browser-use 包只在 monorepo 里；`api-catalog` 里的 browserUse、computerUse、webhookRuntime、lsp、ssh 服务在桌面版运行时都不存在。
- 可行路径：用随包的 dsh-mcp-client 接 Playwright MCP（9.5）。参数、协议协商、用户机器上 npx 是否可用都没实测（H38）。

证据：`dsh-client-ui-sidebar-browser/README.zh.md:28、43、59、90-92、110`，`_app/main.js:10481-10660`，`dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:43-47、191-201`，`api-catalog:484-495、636-647、3592`。

### 9.4 联网工具

模型用的两个工具来自 dsh-tool-web（插件名 tool-web，inject `['tools', 'web', 'systemPrompt']`）：

- `web_search({ queries: string[] })`：1 到 searchMaxQueries 条查询；完全相同的查询去重，并发执行，结果按排名轮流合并、按 URL 去重，截到 searchMaxResults 条。输出 `{ content?, sources: [{ url, title?, snippet?, publishedAt? }], truncated }`。
- `web_fetch({ url })`：输出 `{ url, statusCode, body: { kind, content }, truncated }`。
- 默认配置：search 和 fetch 都开，searchMaxResults 8，searchMaxQueries 4，fetchTimeoutMs 和 searchTimeoutMs 30000，fetchMaxOutputChars 200000。dsh-base 的宿主层 tool-web 行被 web-app 禁用，改由 standard、ptc、cordis 三个 preset 各自挂载（searchTimeoutMs 60000）；minimal 没有联网工具。
- 两个工具在任何权限档下都不审批。
- 证据：`dsh-tool-web/lib/index.js:43、189-268、736-743、803-858`，`dsh-tool-web/README.zh.md:44-72、250、253`，`dsh-base/cordis.patch.yml:454-490`，`dsh-web-app/cordis.patch.yml:584-585`。

供应商：

- 搜索默认 `deepseek-official`：一次 `ctx.web.search` 是一次完整的辅助 Messages 调用（默认模型 deepseek-v4-flash），最多做 5 次服务端搜索；一次 web_search 工具调用最多 4 × 5 = 20 次。它用原生 fetch，不经过 `ctx.llm`，大概率不计入会话的 token 统计。
- 抓取默认 `http`：只抓公网单播地址，并把连接固定在校验过的地址上；只跟随同源重定向，最多 5 次；上限是响应 5,000,000 字节、正文 100,000 字符、超时 30 秒；只发 GET，不带 Cookie，不执行 JS。所以机器人不能用 web_fetch 访问中心在本机的接口。
- 换供应商只能改 `web` 行的 config（整行替换，`searchProvider` 和 `fetchProvider` 都要写）。默认组合里环境变量 `DSH_WEB_SEARCH_PROVIDER`、`DSH_WEB_FETCH_PROVIDER` 不生效，因为代码是「配置优先，环境变量兜底」，而 dsh-base 已经显式写了配置。设置页的「启用新版 Web 搜索 API」开关会改写这两个值。
- 证据：`dsh-web/lib/index.js:45-60、63-90、100、115、123-132`，`dsh-web-search-deepseek/README.zh.md:28、36-54、61`，`dsh-web-fetch-http/README.zh.md:28-64`，`dsh-web-fetch-http/lib/index.js:35、70、162、196`，`dsh-base/cordis.patch.yml:467-481`，`dsh-client-ui-settings-web-search/README.zh.md:30、40`。

中心自己调用（不开模型回合，适合感知）：

```ts
// inject: ['web']，或 ctx.get('web')
ctx.web.search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<{ content?; sources: Array<{ url; title?; snippet?; publishedAt? }>; truncated: boolean }>
ctx.web.fetch(request: { url: string }, signal?: AbortSignal): Promise<{ url; statusCode; body: { kind; content }; truncated: boolean }>
ctx.web.registerSearchProvider(provider: { id: string; available(): boolean; search(request, signal?) }): () => void   // 随调用方 effect 释放；id 重复抛 WEB_DUPLICATE_PROVIDER
ctx.web.registerFetchProvider(provider): () => void
```

- 没有「发起会话」，DeepSeek 搜索只能用 `DEEPSEEK_API_KEY` 凭据（优先从 `ctx.credentials` 解析，没有就用环境变量）。
- `body.kind` 为 html 时，content 是原始 HTML；转 markdown 是 tool-web 给模型渲染时才做的，中心要自己转或截断。
- build-spec 的 NetIO 要带请求头、能访问本机地址，用 Node 的 fetch 实现，不要用 `ctx.web.fetch`。
- 证据：`api-catalog:3548-3576、8515-8583`，`dsh-tool-web/lib/index.js:550、641-643、803-813`，`dsh-web-search-deepseek/lib/index.js:10、324-326`。

### 9.5 MCP

每台 MCP 服务器就是一条 name 为 `@deepseek-ai/dsh-mcp-client` 的 Loader 行（插件名 mcp-client，inject `['tools']`）：

```yaml
# 例：写在 profile 的 cordis.patch.yml（或 $DSH_HOME/cordis.patch.yml、组合包补丁、某个 preset 的 plugins 里）
- insert:
    - id: mcp-playwright
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio                   # 或 streamable-http（配 url、headers）
        serverName: playwright             # ^[A-Za-z0-9_-]{1,32}$；工具名变成 mcp__playwright__<原名>
        command: npx                       # 依赖用户自己装的 Node：Host 的 PATH 来自登录 shell
        args: ['@playwright/mcp@<固定版本>']
        env:
          SOME_TOKEN: !!js process.env.SOME_TOKEN   # stdio 子进程的环境会被清洗，密钥要这样显式传
        toolCallTimeoutMs: 60000           # 默认值
        failOnStartupError: false          # 放在 preset 里时不要开 true：起不来会让整个 preset 拒绝挂载
```

- 其他字段默认值：`maxInstructionBytes` 32768；`reconnect` 为 `{ enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }`，连续失败 10 次后移除这些工具。
- 可见范围：写在顶层就进全局层，所有会话都能看到；写在某个 preset 的 plugins 里，只有这个 preset 的会话能看到，而且是这个 preset 共用一条连接、一个进程，preset 启动时就连接。没有给单个会话挂 MCP 的官方接口：要按机器人裁剪，就全局挂载，再在机器人的 `agent.ctx` 上 restrict 或 guard（4.4）。
- 工具名超过 64 字符或含 `[A-Za-z0-9_-]` 以外的字符时，会被替换并追加 12 位哈希。
- 风险：服务器的 instructions 会原样进入系统提示词（有提示注入风险）；MCP 调用默认不审批；MCP 子进程由 SDK 自己启动，不经过 subprocess 服务，也不在沙箱里；mcp-client 的 apply 会 await 初始连接和工具发现，`npx …@latest` 会拖慢启动，要固定版本并预装。
- 补丁会整行替换 config；HMR 会热重载 profile 和 home 的补丁。

证据：`dsh-mcp-client/README.zh.md:12、28、34-75、93、127、137`，`dsh-mcp-client/lib/index.js:83-101、762-836`，`dsh-mcp-resources/README.zh.md:30-42`，`dsh-agent-preset-registry/README.zh.md:56、60`，`dsh-subprocess/README.zh.md:149`，`_app/main.js:12057-12064、12180-12185`，`dsh-desktop-host/lib/index.js:236-246`。

### 9.6 飞书、邮件、即时通讯

已发货的 308 个包和官方包清单里都没有飞书、Lark、邮件（SMTP、IMAP）、Slack、Telegram、钉钉、企业微信集成，也没有通知推送类的包。dsh-webhook、dsh-webhook-github 只在 monorepo 里，桌面版没有。源码里「飞书」只出现在测试版更新的登录方式和意见反馈问卷里。

能走的路：中心宿主插件直接调飞书 OpenAPI 或 webhook；或经 dsh-mcp-client 给机器人接飞书 MCP。对外的写操作默认都不审批，要自己在 `tools/pre-execute` 里做白名单或转审批单（5.1）。证据：`dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:218-219`，`_app/main.js:7413-7415、9474-9482`，`dsh-client-ui-settings-account/README.zh.md:45`。

## 10 测试与隔离开发环境

### 10.1 三层测法

- 官方的测试代码和测试支撑包都没有随桌面版发布：安装包里没有 tests 目录和 spec 文件；dsh-agent-loop-testkit、dsh-client-test-runtime、dsh-remote-mock、dsh-loader-smoke、dsh-llm-mock-server、dsh-llm-replay 都只出现在 devDependencies 里，安装包里没有对应目录。只能照官方的思路自己搭。证据：`dsh/package.json:110-144`，`dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:474-478`。
- 官方插件开发技能对测试只有一条硬要求：测试用的子进程或临时资源放在独立目录、限时执行、等清理完成。证据：`dsh-agent-preset/skills/cordis-plugin-development/references/verification.md:7`。

中心按三层测：

1. L1：core 的纯逻辑，用 core 自己的 SimHost、FakeClock（build-spec 第 18 节），已有。
2. L2：插件适配层的单测，用假 ctx 加 vitest（项目已装 vitest 3），见 10.2。
3. L3：真实 dsh 启动器 + 隔离的 DSH_HOME + 测试专用插件（假模型、冒烟跑者），不花额度，见 10.3 到 10.6。

最后才做少量真模型冒烟：会消耗额度，要先征得主人同意。

### 10.2 假 ctx（L2）

假 ctx 要对齐真 cordis 的这些语义，否则测试会误报：

- effect 回调可以返回清理函数、清理函数的可迭代对象、`Promise<清理函数>`、null 或 undefined；返回其他形状，真 cordis 抛 `TypeError('Invalid effect')`。
- effect、on、provide 返回的取消函数只生效一次；手动调过以后，插件卸载时不会再调。
- 同一作用域里同名服务重复 provide 会抛错。
- waterfall 的最后一个参数是 next，监听器不调 next 就等于否决。
- `ctx.inject(deps, cb)` 等价于 `ctx.plugin({ inject, apply: cb })`，cb 收到 `(ctx, config)`。
- 「回调里的错不外泄」仍然要测（AGENTS.md 红线 5）。但理由要写对：session/event 监听抛错会被 dsh-session 兜住只记警告，webServer 路由处理器抛错会回 400；真正会让进程退出的，是定时器、流回调里的未捕获异常，以及脱离 apply、没人处理的 Promise 拒绝（2.6）。

L2 该断言的内容：卸载后监听器数归零，所有 effect 和 provide 的取消函数都被调过且只调一次；注册在机器人 `agent.ctx` 上的工具在插件卸载后也被撤掉（4.3）；回调里抛错不外泄；HostPort 各方法调对了 ctx 服务、参数字段齐全（例如 `prompt` 和 `projections` 带了 signal、requestId 非空、消息里没有 undefined 值）。

假 ctx 测不到、要留给 L3 的：cordis 代理带来的 `this` 绑定，以及「服务方法里调的 ctx.effect 自动挂到调用方 fiber」；inject 的等待与重启；服务隔离；waterfall 的真实顺序；真实服务签名随版本的变化。

```ts
// packages/plugin/test/helpers/fake-ctx.ts：语义对齐 @deepseek-ai/cordis 4.0.5
type Disposer = () => unknown
type Listener = (...args: any[]) => unknown

export function createFakeCtx(services: Record<string, unknown> = {}) {
  const live = new Set<Disposer>()                     // 还没执行的清理函数（Set 保持登记顺序）
  const listeners = new Map<string, Listener[]>()      // 事件名 → 监听函数
  const logs: Array<{ level: string; name: string; args: unknown[] }> = []
  const named = (name: string) => ({
    info: (...args: unknown[]) => { logs.push({ level: 'info', name, args }) },
    warn: (...args: unknown[]) => { logs.push({ level: 'warn', name, args }) },
    error: (...args: unknown[]) => { logs.push({ level: 'error', name, args }) },
    debug: (...args: unknown[]) => { logs.push({ level: 'debug', name, args }) },
  })
  const logger: any = Object.assign((name = 'fiber') => named(name), named('fiber'))
  // 登记一个清理函数，返回「只执行一次、执行后自动出列」的包装
  const track = (d: Disposer): Disposer => {
    let done = false
    const once = () => { if (done) return; done = true; live.delete(once); return d() }
    live.add(once)
    return once
  }
  // 按真 cordis 的规则收集 effect 回调的返回值
  const collect = (out: unknown): Disposer[] => {
    if (out == null) return []
    if (typeof out === 'function') return [track(out as Disposer)]
    if (typeof (out as any).then === 'function') {
      void (out as Promise<unknown>).then((d) => { if (typeof d === 'function') track(d as Disposer) })
      return []
    }
    if (typeof (out as any)[Symbol.iterator] === 'function') {
      const list: Disposer[] = []
      for (const d of out as Iterable<unknown>) {
        if (typeof d === 'function') list.push(track(d as Disposer))
        else if (d != null) throw new TypeError('Invalid effect')
      }
      return list
    }
    throw new TypeError('Invalid effect')              // 与真 cordis 一致：返回普通对象等直接报错
  }
  const ctx: any = {
    ...services,
    logger, logs,
    get: (name: string) => services[name],
    provide(name: string, value: unknown) {
      if (services[name] !== undefined) throw new Error(`service "${name}" has been registered`)
      services[name] = value
      ctx[name] = value
      return track(() => { delete services[name]; delete ctx[name] })
    },
    effect(execute: () => unknown) {
      const list = collect(execute())
      return () => { for (const d of [...list].reverse()) d() }
    },
    on(name: string, cb: Listener) {
      const arr = listeners.get(name) ?? []
      arr.push(cb)
      listeners.set(name, arr)
      return track(() => { const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1); return i >= 0 })
    },
    emit(name: string, ...args: unknown[]) { for (const cb of [...(listeners.get(name) ?? [])]) cb(...args) },
    waterfall(name: string, ...args: unknown[]) {
      const inner = args.pop() as Listener             // 最里层的默认行为
      const chain = [...(listeners.get(name) ?? [])]
      const next = (): unknown => (chain.shift() ?? inner)(...args, next)
      return next()
    },
    inject(deps: string[], cb: (c: any, config?: unknown) => unknown) {
      if (deps.every((d) => services[d] !== undefined)) collect(cb(ctx, undefined))   // 依赖齐了才挂载
    },
    listenerCount: (name: string) => listeners.get(name)?.length ?? 0,
    liveDisposers: () => live.size,                    // 卸载后应为 0
    async dispose() { for (const d of [...live].reverse()) await d() },   // 模拟插件卸载：逆序清理
  }
  return ctx
}
```

证据：`cordis/src/fiber.ts:356-442`，`cordis/src/reflect.ts:233-305`，`cordis/src/events.ts:165-302`，`cordis/src/registry.ts:164-176、300-302`，`dsh-session/lib/index.js:1227-1240`，`dsh-host-webserver/lib/index.js:378-404`，`/Users/bytedance/Documents/DSHarness Doc/dsh-net-tuning/test/apply.test.mjs:14-27`（主人旧插件的同类做法）。

### 10.3 隔离沙箱的规则

脚本见 1.4。规则：

- `DSH_HOME` 一定要设，否则 `dsh web` 和桌面版共用 `~/.dsh`，会话写锁和存储会互相干扰。
- `DSH_AGENTS_HOME` 指向空目录，不读主人的全局 AGENTS.md 和技能。`DSH_TELEMETRY_DISABLED` 设任意非空值关掉遥测行。
- 工作目录放在任何 git 仓库之外、没有 `.env` 的位置。原因：会话工作目录决定读哪些指令文件，在 agent-hub 目录里跑会把给 Codex 的守则注入机器人会话；启动目录的 `.env` 会被读入。
- 启动变量只能 export，不能写进当前目录或 `$DSH_HOME` 的 `.env`，写了启动器直接抛错退出。这些名字包括：`PATH`、`HOME`、`SHELL`、`NODE_OPTIONS`、`NODE_PATH`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_SEARCH_BASE_URL`、`SSL_CERT_*`、`NODE_TLS_REJECT_UNAUTHORIZED`，以及所有 `DSH_*`、`XDG_*`、`DYLD_*`、`BASH_FUNC_*` 前缀的变量。代理变量 `HTTP(S)_PROXY`、`ALL_PROXY`、`NO_PROXY` 只能写在 `$DSH_HOME/.env`。
- `DEEPSEEK_API_KEY` 可以写进 `.env`。headless 按「启动环境 → 当前目录 .env → `$DSH_HOME/.env`」找；web 先查凭据库，再回落到这些层。`.env` 的值并入 process.env，不覆盖已有值。
- 同一个插件源码目录不要同时 link 进沙箱和桌面版：改动会在桌面版下一次重组或重启时被带进去。稳定前只 link 进沙箱。
- 沙箱里的机器人工具操作的是真实文件系统，工作目录放专用目录。给了真凭据就会消耗真实额度。

证据：`dsh-home-paths/README.zh.md:34-52`，`dsh-app-boot/lib/index.js:1105-1111、3610-3667、3688-3760`，`dsh-headless/README.zh.md:55`，`dsh-credentials-local/README.zh.md:42-47、71-80`，`dsh-agent-instructions/README.zh.md:34`。

### 10.4 假模型

安装包里没有假模型实现，注册模型路由的只有三行适配器：行 id `llm-deepseek`（包是 dsh-llm-deepseek-api-key，路由 deepseek-official）、`llm-deepseek-account`、`llm-pi-ai`（默认休眠）。注意行 id 和包名不是一回事，补丁写错 id 只会警告 `entry not found` 并跳过。证据：`dsh-base/cordis.patch.yml:88-94、128-136、521-529`。

**做法 A：本机假 Messages 服务器（D02 的选择，走真实的 DeepSeek 适配器）**

- 地址：适配器的 baseURL 取值顺序是 行配置 → 启动环境里的 `DEEPSEEK_BASE_URL` → `https://api.deepseek.com/anthropic`。请求发到 `POST {root}/messages`，root 的路径不以 `/v1` 结尾时自动补，所以 `http://127.0.0.1:18080/anthropic` 实际打到 `/anthropic/v1/messages`。只有官方地址且用内置模型目录时才会去拉 `/models`。本机地址永远绕过代理。
- 请求头：`x-api-key`、`content-type: application/json`、`accept: text/event-stream`、`anthropic-version: 2023-06-01`、`x-deepseek-harness-user-id`；带会话时有 `x-deepseek-harness-session-id`；压缩请求带 `x-deepseek-harness-compact: 1`。
- 请求体：`{ model, stream: true, messages, max_tokens, thinking: { type }, output_config?: { effort }, system?, tools?: [{ name, description, input_schema }] }`，外加扩展字段 `dsh_session_log`、`dsh_plugin_packages`。工具结果放在 user 消息的 `tool_result` 块里回传。
- SSE 规则：必须先发 `message_start`，其中 `message.usage` 是对象；`content_block_start` 支持 text、thinking、tool_use（tool_use 的 id、name 非空，input 是对象）；delta 支持 text_delta、thinking_delta、signature_delta、input_json_delta；`stop_reason` 只认 end_turn、stop_sequence、tool_use、max_tokens；写了 `event:` 行时它必须等于 data 里的 type；type 为 error 的事件按供应商错误处理。一个内容块都没有却 end_turn 报 EMPTY_RESPONSE；工具参数最终必须能解析成 JSON 对象；没收到 `message_stop` 流就结束报 STREAM_CLOSED。
- 会话标题生成也会调模型（默认继承会话路由），请求里没有 tools。假服务器要能回答这种请求，或者在测试补丁里关掉标题行：`- id: session-title-llm` 加 `disabled: true`（官方 SDK 组合就这么写）。
- 密钥只做格式校验（非空、能放进 HTTP 头），假 key 即可。

证据：`dsh-llm-deepseek/lib/index.js:346-349、441-443、577-580、1718-1742、1798-1812、1846-2030、2227-2244`，`dsh-llm-deepseek-api-key/lib/index.js:9-13、29-64`，`dsh-llm/lib/index.js:1659-1663`，`dsh-http-proxy/README.zh.md:52`，`dsh-session-title-first-prompt-llm/README.zh.md:36`，`dsh-sdk-app/cordis.patch.yml:8-9`。

```js
// scripts/fake-model-server.mjs（示意）：按上面的协议规则写，第一次跑时用请求日志校准
import http from 'node:http'

/** 按剧本决定这一步回什么：{ tool: { name, input } } 或 { text } */
function decide(body) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { text: '冒烟测试' }   // 标题生成等辅助请求
  const last = body.messages.at(-1)
  const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : []
  if (results.length === 0) return { tool: { name: 'hub_state_get', input: {} } }         // 刚被唤醒
  const lastTool = findToolName(body.messages, results[0].tool_use_id)
  if (lastTool === 'hub_state_get') return { tool: { name: 'hub_commit', input: commitArgs(body) } }
  return { text: '已交账' }                                                               // hub_commit 之后收尾
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/v1/messages')) { res.writeHead(404).end(); return }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  const plan = decide(body)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)   // event 名必须等于 type
  send({ type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  if (plan.tool) {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: plan.tool.name, input: {} } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(plan.tool.input) } })
    send({ type: 'content_block_stop', index: 0 })
    send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } })
  } else {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: plan.text } })
    send({ type: 'content_block_stop', index: 0 })
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
  }
  send({ type: 'message_stop' })
  res.end()
})
server.listen(18080, '127.0.0.1')
// findToolName：在 messages 里找到 id 等于 tool_use_id 的 tool_use 块，返回它的 name
// commitArgs：返回完整的 hub_commit 参数，规则见下
```

剧本里 `hub_commit` 的参数必须能通过 core 的严格 schema：12 个键都要有，可空的写 null，即 outcome、summary、worldChanges、evidence、verification、blocker、nextThink、ownerQuestion、reply、report、importance（1 到 10 的整数）、proposals。主人消息唤醒的回合 `reply` 必填，而 `pokeBot` 就等于主人发消息，所以剧本里统一带上 reply。参数不合法时 `tool/result` 的 isError 为 true，冒烟一定失败。证据：`agent-hub/packages/core/src/commit/schema.ts:10-33`，`agent-hub/packages/core/src/commit/process.ts:28`。

**做法 B：进程内假适配器（零端口）**

写一个测试专用插件，`ctx.llm.registerAdapter(['hub-fake'], adapter)`：

- 签名 `registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle`，返回值调用一次就注销，另有 `replace(nextProviders)`；随调用方插件释放。providers 为空抛 INVALID_ADAPTER；路由已被注册抛 DUPLICATE_ADAPTER；`providerInfo(p).id` 必须等于 p 且 name 非空。
- LlmRuntime 只调 `adapter.prepareCall(provider, model, signal)` 拿 `{ model, stream }`。`resolveModel` 的返回值要原样带回 provider 和 id、name 非空、contextWindow 是正整数；reasoning.efforts 要覆盖会话实际请求的档位（DeepSeek 默认 high），否则报 UNSUPPORTED_REASONING_EFFORT。
- chunk 类型有 block-start、text-delta、reasoning-delta、tool-call-delta、block-end、usage、finish；必须能无损 JSON 序列化；只能有一个终止 finish；finish 为 max-tokens 时工具调用会被丢弃；适配器抛错会变成终止 finish。
- 再用补丁把 `agent-default-model` 行的 provider 和 model 都改成假路由（补丁整段替换 config）。
- 测试夹具目录要有自己的 package.json，带 name 字段、不声明 `dsh.client`，否则会被当成 dsh-agent-hub 的第二个来源，Web 启动失败。

证据：`dsh-llm/lib/index.js:1665-1755、1842-1880、2086-2163、2182-2266、2309-2414`，`dsh-llm/lib/types/assembler.js:33-138`，`dsh-agent-default-model/README.zh.md:41-57`，`dsh-client-modules/lib/index.js:762-809、890-896`，`api-catalog:1364、4632`。

### 10.5 启动器参数、headless 与诊断

- 启动器只认 `--profile`、`--patch`、`--from-default-profile`、`--dump-config`、`--dump-default-config`、`--dump-config-schema`、`-V/--version`，遇到第一个不认识的参数，后面全部交给应用。所以 `dsh --profile headless --json --patch a.yml '任务'` 会把 `--patch` 当成 headless 自己的参数，要把启动器参数写在前面。
- `--patch <文件>`：YAML 数组，insert 行的 name 可以是绝对路径或相对补丁文件的路径。它是启动时的快照，不热重载；文件不存在直接启动失败。不要既 `plugin add` 了插件，又在 `--patch` 里按路径再插一遍。
- `--dump-config`：打印组合后的 YAML，注释写明每行来自哪一层。它不求值 `!!js`，而且会按模板初始化 profile、重写 profile 的 cordis.yml。版本被拒的行仍会出现，被跳过的组合包没有行。是否真正激活要看启动时的 stderr。
- `--dump-config-schema`：会真的 import 组合里的每个插件模块（执行模块顶层代码），收集不完整时退出码为 1。
- headless 组合关掉了 hmr、credentials、authorization、deepseek-account 四行，没有 webServer、schedule、sessionController、workspaceRegistry、agentPresets。中心插件在 headless 里会一直 PENDING，所以中心的端到端只能用 web profile。headless 只按环境变量和 `.env` 找 key，跑完一个任务就退出，最后一轮 completed 时退出码为 0，否则为 1。
- `--from-default-profile <模板>` 会删掉同名自定义 profile 的整个旧目录，只在创建或重置时用。随附模板名（web、headless、sdk、sdk-minimal、acp）不能当目标名。

证据：`dsh/README.zh.md:9-48`，`dsh/lib/bin.js:35-37、59-92、101-137`，`dsh/lib/dump-config-CWs_HdOc.js:7-28`，`dsh/lib/dump-config-schema-D_PxIzpe.js:12-39`，`dsh-headless/cordis.patch.yml:32-43`，`dsh-headless/README.zh.md:36、42-70、78、106-108`，`dsh/lib/profile-boot-C14i-8IN.js:129-247`。

### 10.6 冒烟跑者与退出码

冒烟跑者是一个测试专用插件，用 `--patch` 挂进沙箱的 web profile：

- 只 inject 一定存在的 `appReady`、`appExit`（启动器在挂载插件树之前提供到根 ctx 上）。`appReady.onReady(cb)` 在整棵树启动完、必需行审计通过后回调一次。
- 就绪后用 `ctx.get('agentHub')` 取中心的门面，取不到就立刻以 1 退出。所以中心插件要 `ctx.provide('agentHub', { api, status })`。
- 驱动中心：`api.createBot(...)`（role 只能是 chief、researcher、executor、sentinel）→ 等试用唤醒交账 → `api.pokeBot(botId, '冒烟：请交账')` → 等第二次交账和线程里的回复。命令返回 `{ ok: true, data? } | { ok: false, error }`。
- 判定依据是会话事件：`tool/call` 的 name；`tool/result`（只看 `surfaceOp === 'append'` 的）的 `message.isError`；`turn/end` 的 `reason.kind`。
- 结束时往 stdout 打一行 JSON（例如 `{"type":"hub-smoke","ok":true,…}`），再调 `appExit(code)`。要附中心的 warn 日志，自己挂 exporter（2.7），`ctx.logger.buffer` 里没有 warn。

证据：`dsh-cmdline/lib/index.js:27-32`，`dsh/lib/profile-boot-C14i-8IN.js:87-108、302-314`，`dsh-headless/lib/json-stream-BA-F3lfb.js:182-264`，`agent-hub/docs/build-spec.md:661-672、726`，`agent-hub/packages/core/src/model/enums.ts:5`。

dsh 进程的退出码（写测试判定必读）：

- `appExit(code)`：先在 5 秒上限内释放整棵插件树；释放成功后只设置 `process.exitCode = code`，要等事件循环清空才真正退出。被测插件泄漏了没登记进 `ctx.effect` 的定时器或句柄，进程就会一直挂着（正好当泄漏探测器用）。释放失败或超过 5 秒才 `process.exit(code)` 强退。
- SIGTERM：释放后以 0 退出，会把「被杀」伪装成成功。SIGINT：以 130 退出。第二次收到信号立即强退。
- 任何时刻的未捕获异常或未处理拒绝（包括 appExit 之后、插件卸载期间冒出来的，例如 `await ctx.timeout(ms)` 被 reject）：stderr 写 `dsh: fatal …`，最多等 2 秒，`exit(1)`。
- 启动阶段必需行失败：stderr 写 `dsh: startup failed: …`，并写 `$DSH_HOME/logs/startup-*.log`，exit 1。可选行失败只告警。

证据：`dsh/lib/profile-boot-C14i-8IN.js:12、21-71、273-288`，`dsh-app-boot/lib/index.js:4172-4253`，`dsh-app-boot/README.zh.md:43、105-111`，`dsh/lib/bin.js:207-231`。

看门狗（macOS 默认没有 `timeout`、`gtimeout` 命令；不能用 TERM，因为 dsh 把 SIGTERM 当成正常关闭并以 0 退出）：

```bash
# web 冒烟：判定以冒烟跑者打印的 JSON 行为准，退出码只作辅助（130 = 被看门狗 INT，137 = 被 KILL）
"$DSH" --profile web --patch "$FIX/smoke.patch.yml" --no-open --port 0 > "$RUN/web.out" 2> "$RUN/web.err" &
PID=$!
( sleep 180; kill -INT "$PID" 2>/dev/null; sleep 10; kill -KILL "$PID" 2>/dev/null ) &
WATCH=$!
wait "$PID"; CODE=$?
kill "$WATCH" 2>/dev/null
if grep -q '"type":"hub-smoke","ok":true' "$RUN/web.out" && [ "$CODE" -eq 0 ]; then
  echo 'web 冒烟通过'
else
  echo "web 冒烟失败（退出码 $CODE）"
  grep -n 'fatal\|did not activate\|startup failed' "$RUN/web.err" || true
fi
```

退出码和 JSON 行不一致时（例如 JSON 行是 ok 但退出码是 1），看 web.err 里有没有 `dsh: fatal`，那通常说明插件的卸载路径有 bug。非交互 sh 里后台进程会不会忽略 SIGINT 没有实测，所以看门狗用 KILL 兜底（H44）。

### 10.7 开发循环

- 改界面：esbuild `--watch` 持续写 `lib/client.js`，web 沙箱里约 0.5 秒热替换（1.5）。
- 改宿主：重新构建后 Ctrl+C 重启 `dsh web`，页面会自动重连，必要时刷新。宿主代码没有「保存即生效」。
- 桌面版验收：完全退出 App，重新 link（或保持 link），再打开。
- 不要读写 `~/.dsh`；假 key 只出现在沙箱进程的环境里。

## 11 坑清单

每条后面括号里是详细说明所在的小节。

### 11.1 包与安装

1. 版本要求写在顶层 `engines.dsh`，写在 `dsh.engines` 下宿主不读，等于没写（1.1）。
2. 没有 `dsh.bundle.patch` 的包只会当普通依赖装上，不会被加载。主人旧插件 dsh-auto-upgrade 就是这样（1.1）。
3. 声明了 `dsh.client`，却缺 `./client` 导出或缺 `lib/client.js` 文件：Web 和桌面版启动时必需行 modules 失败，整个界面起不来。清理构建产物时不要先删 `lib/`（1.3）。
4. 不要把 `@deepseek-ai/*` 写进 dependencies；link 安装不会替你装插件自己的依赖，所以 `lib/` 要自包含（1.1、1.3）。
5. 同一个包被两行挂载（例如再插一个 `./lib/x.js` 相对路径行，或既 `plugin add` 又在 `--patch` 里按路径插一遍），报「resolves from multiple active Loader sources」，组合失败（1.2、10.5）。
6. 行 id 全局唯一，不要和 required 行重名（agent-loop、webserver、web-runtime、modules、connection、headless-runner、acp、sdk-jsonrpc-server）。行 id 和包名不是一回事，补丁写错 id 只会警告 `entry not found` 并跳过（1.2、10.4）。
7. profile 或 home 的 `cordis.patch.yml` 为空或只有注释，启动失败，要写 `[]`；`--patch` 指向的文件不存在，启动失败（1.2、10.5）。
8. desktop profile 只能用桌面版自带的 CLI 操作，官方流程是先完全退出 App；任何 dsh 都拒绝 `--profile desktop` 启动或 dump（1.4）。
9. `--from-default-profile` 会删掉同名自定义 profile 的整个旧目录（10.5）。
10. 给主人手动运行的命令不能带引号、空格路径、管道；桌面版 CLI 路径有空格，要写成脚本文件，只给主人一条短命令（1.4）。

### 11.2 宿主骨架与生命周期

11. `export function apply` 会被 new 调用，返回值被丢弃；return 一个 Promise 会变成未处理拒绝，宿主进程退出。这种写法必须同步、不 return（2.1）。
12. `export async function apply` 不会被 new，但它结算之前整个 DSH 的启动都在等（2.1）。
13. 方法简写或箭头函数形式的 apply 返回普通对象，报 Invalid effect，插件启动失败（2.1）。
14. 顶层 inject 的任一服务的提供方重启，整行重载。可选服务放进 `ctx.inject` 子插件（2.2）。
15. 普通 config 字段一改就整行重挂载；volatile 只对 schemastery 的 Config 生效，读值要 `.get()`（2.3）。
16. 插件卸载时，不同 effect 的清理并发执行，没有先后保证。有顺序要求就放进同一个 effect（2.2）。
17. await 之后再调 `ctx.effect`、`ctx.on`，插件可能已经卸载，抛 INACTIVE_EFFECT。所有注册都放在 apply 的同步部分（2.2、2.8）。
18. 不要 `ctx.fiber.dispose()` 停掉自己：Loader 会把这一行写成 disabled（2.4）。
19. `ctx.webServer.register` 不会随插件自动注销，要包进 `ctx.effect`，否则重载后报 duplicate route（2.5）。
20. `ctx.logger` 的内存缓冲只有 error 和 info；运行期用 `console.*`；桌面版的 stdout 从 Finder 启动时看不到（2.7）。
21. 退出时只有 5 秒宽限，致命错误时只有 2 秒；状态要随时落盘（2.4）。
22. 宿主崩溃后桌面版不会自动拉起；主人点了「禁用第三方插件」，中心插件和 profile 补丁都会被摘掉（2.6）。

### 11.3 错误隔离

23. 定时器、流、子进程、`fs.watch` 回调里的未捕获异常，以及没人接的 Promise，都会让宿主 `exit(1)`（2.6）。
24. `ctx.emit` 派发的事件（包括 `api-session/*`）上的 async 监听器 reject，宿主退出（2.6、7.5）。
25. `agent/created` 是 serial：监听器抛错会让会话创建失败；返回非空值会跳过后面的官方监听器。写成块体、不返回值、整体 try/catch；`safe()` 必须返回 undefined（2.6、4.3）。
26. waterfall 监听器必须 `return next()`，不能用 `safe()` 包；`next()` 放在 try 外面调用（5.0、5.1）。
27. `session/created` 监听器同步抛错，会否决 DSH 里所有新建和恢复的会话（5.8）。
28. `await ctx.timeout(ms)` 在插件卸载时 reject，必须接住，否则关停时进程以 1 退出（7.4、10.6）。

### 11.4 会话

29. `sessionController.create` 不给 workspaceId 也不给 cwd，工作目录就是 `$DSH_HOME/profiles/desktop`（3.2）。
30. `create({ sessionId })` 的意思是「复用这个空白会话」，不是「按 id 取或建」；永远以返回值为准；`agent/created` 早于 create 返回（3.2）。
31. `prompt`、`projections`、`list` 必须传 signal；`cancel` 是同步方法，不在线时同步抛错（3.1）。
32. 宿主直连不做 schema 校验：漏了 requestId，会伪装成 `session/agent-busy`「prompt rejected」（3.1）。
33. 手工构造的消息：id 非空且不能和队列里已有的重复（重复会抛错，不会去重）；整条消息不能有 undefined 值；`source.kind` 非空，不能是 `'plugin'`（会话以后打不开），不要用 `'user'`（3.3）。
34. 在同一会话的 `session/event` 或 `onChanged` 同步阶段里不能 append、followup、steer、inject，要 `setImmediate` 推迟（3.3、3.4、3.6）。
35. `onChanged` 回调抛错，同一事件后面的投影都不再推送，界面会漏更新（3.6）。
36. 不能往会话日志写自定义事件类型：写时不报错，重启后整个会话打不开（3.9）。
37. 往已归档的会话投递，唤醒会被吞掉（3.3、3.7）。
38. `agent/pre-step` 返回 reject，本步已领取的消息被吞掉，不会重新排队（5.2）。
39. 自定义来源的唤醒不触发自动标题、不让侧栏上浮、不发 `api-session/activity`、requestId 幂等不适用（3.3、3.8）。
40. 用 `prompt` 发的消息带人类授权，并会触发 `api-session/activity`；判断主人是否活跃时要排除中心自己转发的（3.3、7.6）。
41. `selectModel` 会在后台把选择存成全局默认，要立刻 `saveSelection(prev)` 还原；没给推理强度时会补成模型默认；和主人并发改默认有竞态（3.5）。
42. 没 selectModel、也还没发过请求的新会话，第一次请求用的是那一刻的全局默认（3.5）。
43. `agent/request` 钩子要 prepend；钩子路由和会话的待用选择不一致时，几乎每一步都会多一条反向的 `[model changed]` 通知（5.4）。
44. 审批策略 never 的会话里，`approval/asked` 紧跟一条 rejected 的 `approval/decided`，是自动拒绝，不是卡住（3.4、6.3）。
45. `tokenUsage` 是累计计费量，不是上下文占用；上下文估算按 4 字符 1 token，低估中文（3.6）。
46. 空白会话在侧栏不显示；每个工作区默认只显示 5 条；只给 cwd 建的会话进「未分组」（3.8）。
47. 在桌面界面里打开一个冷会话，宿主会恢复它并持有写锁（3.8）。
48. `whenIdle()` 等的是整条驱动链，不是一轮（3.4）。
49. 压缩服务在 preset 的隔离组里，宿主拿不到 `ctx.compaction`；手动 `/compact` 只能在会话空闲时（3.7）。

### 11.5 工具与钩子

50. 工具名加 `hub_` 前缀：全局层重名抛错，preset 层同名工具会遮蔽全局层，`run_code` 是保留名（4.1）。
51. 原始定义的工具不校验入参，`args` 可能是坏 JSON 的原始字符串（4.2）。
52. handler 返回值必须是无损 JSON，返回 undefined 得到 INVALID_TOOL_OUTPUT（4.2）。
53. `exec.concludeTurn()` 不保证立刻收口（4.2）。
54. 工具注册、撤销、restrict，或 description 变化，都会写开发者消息、打断前缀缓存（4.1）。
55. `agent.ctx` 上的注册在插件卸载时不会自动撤销；子代理不受机器人作用域上的工具、restrict、guard 管辖（4.3）。
56. restrict 只能在作用域 ctx 上调用；点名的工具必须在限制前的继承集合里；`{}` 抛错；`{ allow: [] }` 隐藏全部继承工具（4.4）。
57. guard 只能是同步函数；返回 undefined 以外的任何值（包括 null、false、空字符串）都算拒绝，而且不可推翻（4.4）。
58. pre-execute 的 deny 必须带字符串 reason；漏写 reason 或返回未知 kind 等于放行并跳过 guard；忘了 return 会报错（5.1）。
59. callId 不保证跨会话唯一，缓存键用 `${agent.id}:${callId}`（5.1）。
60. `approval/request`、`user-questions/request` 要 prepend；审批没有超时；交给桌面面板后宿主没法撤回（5.3、6.3）。
61. QUOTA 判定只认英文措辞，GLM 的中文额度报错可能被当成限流白白重试 5 次（5.5）。
62. `presentCall`、`presentResult` 在桌面 Web 界面里不生效（4.2）。
63. standard 的 `ask_user_question` 是 legacy 阻塞模式，会无限等；`exit_plan_mode` 始终在工具目录里（4.3、5.7）。

### 11.6 权限与沙箱

64. 审批 never 是自动拒绝，不是自动放行；想按规则放行一部分，只能用 ask 加自己写的应答者（6.3）。
65. `/permission` 命令会给模型注入「changed by the user」；用补丁覆盖 permission 行可能弄坏整个权限服务（6.2）。
66. 沙箱只拦写文件：读全盘（包括凭据文件）、联网、起进程都不拦；`/tmp` 对所有会话共享（6.4）。
67. bash 环境里会被注入 `DSH_HOME` 等变量；给机器人的密钥变量名要含 KEY、TOKEN 或 SECRET（6.4）。
68. 宿主代码用 `ctx.fs` 不带会话策略，只能写 profile 目录和临时区；写自己的文件用 `node:fs`（6.4）。
69. 会话的沙箱根在创建时定下，之后不能改；`working_directory` 会让指令链读到别的目录的 AGENTS.md；主人的全局 AGENTS.md 对机器人同样生效（6.4、6.6）。
70. 命令自己往 stderr 打出「sandbox-exec: 」并以非 0 退出，会被误判成沙箱不可用（6.4）。

### 11.7 存储、文件与事件

71. storageDomain：名字只能小写字母数字下划线；写入不按 schema 校验；single 布局写入坏值会污染整个域；句柄要自己 close；禁用后马上启用可能短暂 already-open（7.2）。
72. `ctx.fs.watch` 只监听一层、不去抖、回调里没有路径；目标不存在时会退化成文件模式，要先 mkdir（7.3）。
73. 超过 2147483647 毫秒的定时器会立即触发；用短 tick 比对墙钟（7.4）。
74. Host 里没有前台、在场、睡眠、网络、即将退出这几类事件；绝不要 `process.send()`（7.6、7.7）。
75. 在机器人调用链里创建的共享定时器，要包进 `ctx.agents.withoutInitiator(...)`（7.4）。
76. `domain/changed` 和插件自定义的宿主事件都不会转发给界面（7.5、8.3）。
77. `jobs.events.subscribe({ owner })` 也会收到没有 owner 的作业事件（7.5）。

### 11.8 界面

78. `client.js` 是被拼接执行的经典脚本：顶层不能有 import、export、let、const、class；load 的 id 必须等于包名（8.1）。
79. 页面启动审计：任何条目没激活，桌面版弹致命框。顶层 inject 只放 `['slots', 'locale']`，apply 整体 try/catch（8.3）。
80. require 基座模块要写全名；不要 require primitives 等 Harness 客户端包（8.2）。
81. 调官方 Remote 命名空间的方法，要 inject `'remote.<命名空间>'`（8.3）。
82. 往已占用的 single 插槽注册会抛错；key 和 id 加前缀；main 的 key 避开 conversation、plugins、schedules（8.4）。
83. 会话级插槽只挂在当前被渲染的会话里，后台逻辑不要放进去（8.4）。
84. GET 路由必须写 `requestBody: 'buffered'`；长连接不要放在 `/api`；裸路由也不要放在 `/api`（会绕过鉴权）（8.5、8.6）。
85. 颜色只用 `--dsw-alias-*`；`--dsh-frame-top-clearance` 要写兜底值 `0px`；样式在 apply 的 effect 里插入（8.8）。
86. `shell.overlay` 整层点击穿透，可点的部分自己加 `pointer-events: auto`（8.4）。
87. 同一个 locale namespace 和语言重复注册会抛错（8.3）。
88. 中栏选中的页面刷新即重置；`selectPanel` 传未注册的 key 会抛错（8.7）。
89. 机器人在跑时，主人退出 DSH 会看到「有任务在运行」的确认框（7.7）。

### 11.9 测试

90. 启动器参数写在应用参数前面（10.5）。
91. `DEEPSEEK_BASE_URL` 等启动变量只能 export，写进 `.env` 会让启动失败（10.3）。
92. headless 里没有 sessionController、workspaceRegistry，中心会一直 pending；中心的端到端只能用 web profile（10.5）。
93. 会话标题生成也会调模型，假模型要能回答不带工具的请求（10.4）。
94. 剧本里 `hub_commit` 的参数要完整（12 个键）并带 reply（10.4）。
95. dsh 把 SIGTERM 当正常关闭、以 0 退出；macOS 没有 timeout 命令；看门狗先 INT 再 KILL，判定以 JSON 结果行为准（10.6）。
96. 测试夹具目录的 package.json 要带 name、不声明 `dsh.client`（10.4）。
97. 沙箱的工作目录放在 git 仓库之外、没有 `.env` 的地方（10.3）。

## 12 尚未证实、需要实测的点

每一条写明：问题是什么，怎么测，测之前用什么保守做法。和 v1 直接相关的排在前面（安装、会话、模型、工具），远程和外部集成排在后面。

### 安装与开发循环

**H1 桌面版运行中用 CLI 安装或重新链接插件**
- 问题：代码显示 `dsh.profile.bundles` 一变就会触发 HMR 重组，可能直接热激活；但官方提示要求先退出 App，插件管理器的 README 又说在管理器之外重新链接要等重启。
- 怎么测：沙箱 web 进程运行时，另开终端执行 `dsh plugin --profile web add link:…`，看 stderr 和界面是否出现中心页面。
- 测之前：退出 App → 安装 → 重开。

**H2 自带 pnpm 对 link: 依赖的处理**
- 问题：link 安装时会不会安装链接目录自己的 dependencies；缺少 peer 时只是警告还是失败。
- 怎么测：给测试包加一个小依赖，link 进沙箱，看 profile 的 node_modules 和 `.plugin-manager/logs/operation-*/pnpm.log`。
- 测之前：零运行时依赖，全部打进 `lib/`。

**H3 桌面版页面里 client.js 的热替换**
- 问题：dsh-client-hmr 在 web 沙箱里能热替换；桌面版 `dsh-app://` 页面里对第三方链接插件是否同样生效，没在真实页面验证。
- 怎么测：桌面版装好后改 `lib/client.js`，看页面是否在 1 秒内更新。
- 测之前：改完刷新页面。

**H4 宿主代码的快速迭代**
- 问题：把 hmr 行的 `root` 改成插件 `lib` 的绝对路径，能否做到保存即替换；原样重写一次 profile 的 `cordis.patch.yml`，能否触发重组、换上已链接包的新代码。
- 测之前：改宿主代码就重启。

**H5 客户端组合错误在启动期是否必然致命**
- 问题：`dsh.client` 写错等组合错误，如果在必需行 modules 构造时被发现就让启动失败，之后才发现只记警告；结果取决于本插件行当时是否已经建好 fiber。
- 测之前：一律当作致命，发布前检查 `dsh.client` 字段和 `lib/client.js`。

**H6 第三方组合包补丁里的 `!!js dshHomePath(...)`**
- 问题：求值机制和官方 base 一样（`with (ctx)` 加 eval），但 `--dump-config` 不求值，需要真实启动确认。
- 测之前：rootDir 在代码里解析（config、`AGENT_HUB_ROOT`、`~/AgentHub`），不依赖补丁里的 `!!js`。

### 会话与模型

**H7 预先生成的 sessionId 能否稳定走「新建」分支**
- 问题：`create({ sessionId: 新 id })` 依赖 session-query 对不存在的 id 抛 `SESSION_QUERY_SESSION_NOT_FOUND`；桌面组合里 session-query 配的是 `openAt: never`，行为没实测。
- 怎么测：沙箱里用 `session-<uuid>` 调 create，看返回的 id 是否等于传入的 id。
- 测之前：用 3.2 的退回写法（失败就不带 id 重建），装配器 `wireIfBot` 保持幂等。

**H8 新会话约 200 毫秒内落盘**
- 问题：由代码链路推断（写句柄在发布前登记，权限事件进入 200 毫秒批写），没实测。
- 测之前：create 之后显式 `ctx.sessions.flush(session)`。

**H9 第一轮之前追加的权限事件，重启后是否保留**
- 问题：dsh-user-approval 的注释说「轮次之间的裸事件在重载时与崩溃尾巴无法区分」；但 jsonl 持久化层只截断物理上不完整的尾巴，官方 `pinInitialPermission` 也是在轮次之外写入的。
- 怎么测：建会话 → `ensureBotPolicy` → 不跑任何回合 → 重启 DSH → 读 `ctx.approval.overrideOf(session)` 和 `ctx.sandboxPolicy.overrideOf(session)`。
- 测之前：每次唤醒前都调用一次 `ensureBotPolicy` 重新确认（6.2）。

**H10 selectModel 后立刻还原全局默认的副作用与竞态**
- 问题：中间那一小段时间里全局默认是机器人的模型；两次写 profile 会不会触发设置页刷新或别的监听；主人同时在界面里改默认时谁覆盖谁。
- 测之前：只在建机器人、改机器人设置这类主人主动操作时调用，串行执行（3.5）。

**H11 agent/request 钩子与待用选择冲突的对策**
- 问题：钩子里检测 `modelSelection` 的 pending 后让位，或同步调用 selectModel 让两者一致，这两种对策都没实测；改道后提示词里的 `{{model}}` 与实际路由不一致，对模型有什么影响也没测。
- 测之前：v1 不用钩子改道，每个机器人固定一个模型。

**H12 主人实际的 GLM 路由键名、默认模型、上下文窗口与输出上限**
- 问题：不读 `~/.dsh` 就无法知道；它们决定模型选项怎么显示，以及 DSH 自动压缩阈值 W − O − 65536 是否有效（太小会跳过自动压缩）。DeepSeek 启用官方 `/models` 列表时，输出上限也可能被压低。
- 怎么测：在插件里运行时打印 `modelCatalog()`、`agentDefaultModel.currentSelection()`、`llm.resolveModelInfo(provider, model)`。
- 测之前：中心按 contextPressure 自己轮换会话，不依赖 DSH 的自动压缩。

**H13 pi-ai 能否识别 GLM 的上下文溢出报错**
- 问题：决定溢出恢复（溢出后自动压缩再重试）在 GLM 上是否生效。
- 测之前：同 H12，占用达到阈值就轮换。

**H14 GLM 额度耗尽、5 小时上限、限流时的真实报错文本**
- 问题：是否含 429，中文措辞是什么。它决定 core 的 `classifyError` 和 5.5 的关键词。
- 怎么测：抓一次真实报错（记录 `agent/request-error` 的 failure 和 `turn/end` 的 reason）。
- 测之前：关键词宽松匹配；`agent/request-error` 只对明确的额度措辞跳过重试，普通限流照常交给官方重试。

### 工具与钩子

**H15 core 用 z.toJSONSchema 生成的参数 schema，DeepSeek 和 GLM 是否接受**
- 问题：其中可能有 anyOf、null、`additionalProperties: false`、`$defs` 等关键字；同时要确认 GLM 路由对工具名字符集和长度的限制，以及 tool call id 会不会在不同会话之间重复。
- 怎么测：在假 Messages 服务器里检查请求体的 `tools`；真模型各调用一次 `hub_*` 工具（要花额度，先征得主人同意）。
- 测之前：参数结构尽量扁平，去掉 `$schema`；缓存键带 agent.id。

**H16 会话恢复时重新注册同样的工具，会不会写开发者消息、打断前缀缓存**
- 怎么测：重启前后对比会话日志里的 `developer/message`。
- 测之前：description 固定不变，工具集合不变。

**H17 链接安装的插件经 peerDependencies import 宿主包**
- 问题：`@deepseek-ai/dsh-tools` 的 defineTool、`@deepseek-ai/dsh-llm` 的 createUserMessage、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis-plugin-include` 都在桌面运行时的共享包表里，解析规则也支持，但没在真机验证。
- 测之前：不 import，用 3.3 和 4.2 的手写等价实现。

**H18 审批转人工后中心自己超时返回，桌面审批卡是否残留**
- 问题：网关的挂起请求只在 signal 中止或会话 ctx 释放时才清除，界面上的表现没测。
- 测之前：机器人用 never 策略，不走这条路。

### preset 与权限

**H19 运行时注册 preset 与会话恢复的先后，以及第三方子路径行在 preset 里的解析**
- 问题：DSH 重启时，dsh-schedule 投递或界面打开会话可能早于中心插件注册 preset，恢复会失败且不重试；`dsh-agent-hub/bot-tools` 这类子路径行在 preset 的内存 Loader 树里能否按调用方 baseUrl 解析，也没测。
- 测之前：v1 只用 standard（6.1）。

**H20 主人当前的 profile 是否改写过 permission、preset-standard 等行，是否开了 Auto review**
- 问题：影响 `permissionPresets.set(session, 'workspace-write')` 是否可用、`readDocument('standard')` 读到什么。
- 怎么测：在 cordis 模式的会话里用 `cordis_inspect_query` 查 `Config.listConfigs`，或者请主人在插件页看。
- 测之前：`ensureBotPolicy` 失败即关闭，不唤醒机器人并告警。

### 存储、事件与在场

**H21 macOS 睡眠后 Node 定时器的行为**
- 问题：醒来是立刻触发，还是按清醒时间顺延。
- 测之前：30 到 60 秒的短 tick，加墙钟跳变检测（7.4）。

**H22 窗口隐藏、最小化、锁屏时页面的可见性与定时器节流；系统空闲时间能否读到**
- 问题：`document.visibilityState`、`hasFocus()` 的实际取值，定时器被节流到多长；用子进程读 `ioreg -c IOHIDSystem` 的 HIDIdleTime 是否可行。
- 测之前：页面只在事件发生时上报，宿主把「很久没上报」当作「不知道」。

**H23 Host 会不会卸载空闲会话**
- 问题：决定 `session/disposed` 是否只在退出、回滚、归档时出现。
- 测之前：每次投递前都用 `resolveAgent`，不缓存 agent 对象。

**H24 ctx.fs.watch（chokidar）在目录被删后重建、编辑器原子保存时的表现**
- 测之前：用 Node 的 `fs.watch` 递归监听加去抖，再定期全量对账（7.3）。

**H25 Electron 主进程与 Host 对 DSH_HOME 的取值是否可能不一致**
- 问题：主进程用自己的 process.env 算 profile 路径，Host 用登录 shell 的环境；主人只在 shell 配置里设了 DSH_HOME 时会怎样。
- 测之前：中心的 rootDir 不依赖 DSH_HOME。

### 界面

**H26 esbuild 产出的 factory bundle 在真实页面里物化**
- 怎么测：沙箱 web 里打开中心页面，看浏览器控制台有没有 `missed the module table`、`slot entry crashed`，启动 stderr 有没有 did not activate。

**H27 第三方 webServer 路由上的 EventSource 经 `dsh-app://` 转发的长期稳定性**
- 问题：官方 HMR 走的是同一条链路，协议也有 stream 特权，但第三方路由没跑过。
- 测之前：EventSource 自动重连，加 `connection/reset` 时重拉、页面重新可见时补拉一次。

**H28 客户端插件里用 'remote'、'uiWorkspace' 等服务，以及 openSession 对已归档会话的行为**
- 问题：官方插件在 inject 里声明这些服务；第三方插件在 ModuleLoader 包装下是否一样生效没测。
- 测之前：用 `ctx.get(...)` 取，取不到就隐藏对应按钮。

**H29 main 与 sidebar.panellist 插槽是否有其他必填选项**
- 问题：官方 schedule 注册时还传了 `locale`。
- 怎么测：运行中用 `cordis_inspect_query` 查 `Slots.listSubTree`。

**H30 先 openSession，再在会话组件里 openTab 的时序**
- 测之前：v1 不用右侧栏。

**H31 宿主半边停在 pending 时，客户端半边是否仍加载**
- 问题：代码只检查条目存在、有 fiber、未禁用，推测仍会加载。
- 测之前：界面在接口返回 503 时显示「中心未就绪」。

**H32 链接安装的宿主半边能否用 schemastery 声明 volatile Config，configForms 能否服务第三方行**
- 测之前：设置走中心自己的接口（build-spec 的 `updateSettings`）。

### 通知、远程与外部集成

**H33 页面里的 Web Notification 能否弹出，点击能否叫回窗口**
- 怎么测：按 F12 或 Option+Command+I 打开主窗口控制台，执行 `new Notification('test', { body: 'x' })`。
- 测之前：宿主侧用 osascript（9.1）。

**H34 `navigator.setAppBadge` 能否映射成 Dock 角标**
- 怎么测：同 H33，在控制台执行 `navigator.setAppBadge(3)`。

**H35 osascript 通知的来源显示与点击行为**
- 问题：推测会显示为「脚本编辑器」，点击不会打开 DSH，这是 macOS 的行为。
- 测之前：通知正文写清「到 DSH 的队友页查看」。

**H36 远程访问方案的未测点**
- 问题：`dsh web` 与桌面版同时运行时，同一个定时提醒会不会各触发一次；iOS 加到主屏的 PWA 与 Safari 的 cookie 是否隔离；`tailscale cert` 生成的证书能否直接用、iOS 是否信任。
- 测之前：v1 不做远程访问。

**H37 只在 monorepo 里的包是否发布到 npm、是否兼容 0.2.1-rc.5**
- 涉及 dsh-browser-use、dsh-webhook、dsh-llm-replay、dsh-web-search-exa 等。

**H38 Playwright MCP**
- 问题：当前版本的参数和工具清单；与 DSH 自带的 MCP 客户端（@modelcontextprotocol/client 2.2.0）协商出的协议版本；主人机器上 npx 是否可用。

**H39 飞书 webhook 的签名算法与长连接 SDK**
- 测之前：v1 只做出站推送，签名按飞书官方文档实现后再实测。

**H40 用 `agent.ctx.plugin(...)` 给单个会话挂 mcp-client**
- 文档没提到，没测。

### 测试环境

**H41 全新隔离 profile 里 `dsh plugin add link:` 是否完全不联网**
- 问题：pnpm 会不会去 registry 取元数据或校验 packageManager。

**H42 用 DSH 自带 Electron 的 Node 模式跑 vitest，并从 app.asar import cordis**
- 价值：能做就可以用真 cordis 做进程内集成测试。

**H43 web 界面的输入框能否在假模型路由上提交消息**
- 问题：只影响「人工在界面里点」的冒烟；做法 A（假 Messages 服务器加 deepseek-official 路由）不受影响。

**H44 非交互 sh 里用 & 启动的后台进程会不会忽略 SIGINT**
- 测之前：看门狗用 KILL 兜底（10.6）。

**H45 沙箱与桌面版并存的未测点**
- 问题：桌面版自动更新替换 App 包时，正在用 App 包里 CLI 跑的沙箱进程会怎样；沙箱里用账号登录（订阅额度）能否使用、是否与桌面版共享额度。

**H46 Seatbelt 对工作区内硬链接的处理**
- 问题：符号链接已确认扩不出可写范围；通过工作区里的硬链接改写工作区外的同一个文件，会不会被拦，没验证。
- 测之前：中心不在机器人目录里创建指向外部文件的硬链接。
