# T7-notify-remote-browser-web-mcp

## [corrected] 1) 通知：宿主或客户端有没有系统通知/桌面通知能力（服务名、调用方式）、Dock 角标？

主结论成立：没有任何可供插件调用的系统通知或 Dock 角标接口。主人不看界面时的提醒，只能由中心插件自建。
① 宿主 ctx 服务清单 SERVICE_API 共 98 个键，没有 notify、notification、badge 一类的服务。这份清单是 monorepo 全集，比桌面版实际装的还多，所以清单里没有，桌面版也一定没有。
② Electron 主进程虽然 import 了 Notification 和 Tray，但 new Notification 只出现在 DesktopUpdateAttention（强制更新提醒）里。Dock 只调用了 app.dock?.bounce('informational') 和 cancelBounce，flashFrame 只在 win32 上用。
③ 主进程开放给页面的 IPC 表 DESKTOP_IPC 和 PLATFORM_IPC 里，都没有通知或角标通道。
④ Tray 只在 win32 创建，macOS 没有托盘。
⑤ 网页前端和所有 client 包都不调用 Web Notification API。全仓只有 dsh-experimental-inspector 自带的 DevTools 代码命中。

改正一处：应用内的提醒不止两种。除了会话行的 pendingInteraction 标记（等待审批 / 计划待审 / 等待回答）和 ui-workspace 包内的 workspace.toast，还有两种：
- 已完成但还没查看的 done 标记。
- ui-chat 挂在 shell.overlay 上的额度瞬时提示。

workspace.toast 的 notice kind 都在包内注册。uiWorkspace 实例上有一个内部 notify 成员，但没有文档，也没有随包的类型声明，第三方插件不应依赖。第三方客户端插件可以像用户样板那样，往 shell.overlay 注册自己的浮层，做应用内横幅或红点。

> 核查说明：原说法“应用内现有的提醒只有两种”不准确：ui-workspace README.zh.md:66 还写了已完成未查看的 done 状态，ui-chat README.zh.md:60 也有 shell.overlay 上的额度提示。补充三点：SERVICE_API 实为 98 个键，而且是 monorepo 全集；PLATFORM_IPC 同样没有通知通道；第三方插件可以自建 shell.overlay 浮层。主结论不变。

证据：根目录约定：dsh-src = /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:15-3929（SERVICE_API，共 98 个 key，从 17 行 agentDefaultModel 到 3916 行 worktrees）; dsh-src/_app/main.js:5（import Notification, Tray）；:9670-9760（DesktopUpdateAttention）；:9706-9711（win32 flashFrame / darwin app.dock?.bounce）；:9716-9732（唯一的 new Notification）; dsh-src/_app/main.js:6707-6713（PLATFORM_IPC）；:6981-7006（DESKTOP_IPC）：两张表都没有通知或角标通道; dsh-src/_app/main.js:11695-11730（DesktopTray）；:12803-12816（只在 process.platform === 'win32' 时创建）; grep 全仓：new Notification / requestPermission / setAppBadge / showNotification 只在 dsh-experimental-inspector/lib/devtools 命中；dsh-acp 的 requestPermission 是 ACP 协议方法，与通知无关; dsh-src/@deepseek-ai/dsh-client-ui-workspace/README.zh.md:66（pendingInteraction 三种标记，外加已完成未查看的 done 状态）、:108（workspace.toast 按 notice kind 分派）；lib/client.js:4575-4600（registerToasts）、:1379-1385（uiWorkspace 构造时注入内部 notify）; dsh-src/@deepseek-ai/dsh-client-ui-chat/README.zh.md:60（QUOTA 瞬时提示是本包注册在 shell.overlay 的全局条目）; /Users/bytedance/Documents/DSHarness Doc/dsh-auto-upgrade/plugin/lib/client.js:228-233（第三方插件往 shell.overlay 注册浮层的写法）

## [corrected] 1) 通知：客户端插件能否弹 macOS 系统通知（主人不看界面时）？

代码层面可行，但仍没有实机验证（medium）。下面这些依据全部核实过：
- 主窗口页面地址是 dsh-app://app/。这个 scheme 以 standard + secure 注册，属于安全上下文，页面里能用 Web Notification API。
- 主窗口没有指定 partition，用的是 session.defaultSession。装在上面的 installMicrophonePermissions 对 media 以外的权限：check 返回 true，request 直接 callback(true)。
- macOS 上关窗会被拦截，改成 hide，渲染进程还在。
- dsh-app://app 下的路径，除了 /、/index.html、/assets/、favicon、manifest，全部经 forwardWebRequest 转发给 Host，并注入 Host cookie。所以客户端插件可以 fetch 宿主半注册的路由。
- Remote 转发事件名单 API_REMOTE_FORWARDED_EVENTS 在构建时固定，第三方插件没法加自己的 ctx.remote.$on 事件，所以要自建路由。

改正两处：
① 原代码的游标从 0 开始。页面每刷新一次，宿主队列里最多 200 条旧通知就会被重弹一遍。另外，宿主半热重载或重启后 seq 会归零，客户端还拿着旧游标，就会漏掉新通知。宿主半要带 bootId，客户端第一次读取时只记下游标、不补弹积压。
② 原文说“用户样板已经在用户的 DSH 上跑通”，这一点源码里查不到证据。而且样板写死了 HEALTH_URL=127.0.0.1:3939 和 ~/.npm-global 的安装路径，看起来是给 npm 安装的 dsh web 服务写的，不是桌面版的实测。不过从桌面版的转发机制推断，同样的写法在桌面版也能成立。

建议：
- 路由改用 ctx.connection.fetch.register，见补充条目 S1。
- fetch 用文档相对路径 api/agent-hub/notices。
- 点击通知时可以调 ctx.get('uiWorkspace').openSession(sessionId)，打开对应机器人的会话。窗口隐藏时点击能不能把窗口叫回来，需要实测。

```
// lib/client.js：中心插件客户端半（主窗口渲染进程）。配合补充条目 S1 的宿主半路由使用
window.__ModuleLoader__.load({
  id: 'dsh-agent-hub', // 必须等于 package.json 的 name
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    exports.apply = function (ctx) {
      let boot = null; // 宿主半的 bootId
      let after = 0;   // 已弹过的最大 seq
      async function poll() {
        try {
          const qs = boot === null ? '' : '?boot=' + encodeURIComponent(boot) + '&after=' + after;
          const res = await fetch('api/agent-hub/notices' + qs); // 文档相对：桌面版解析为 dsh-app://app/api/…
          if (!res.ok) return;
          const data = await res.json();
          if (data.bootId !== boot) {
            const first = boot === null;
            boot = data.bootId;
            after = first ? data.latest : 0; // 首次进入页面：跳过积压；宿主重载：新一轮从 0 开始取
            if (!first) setTimeout(poll, 0);
            return;
          }
          for (const n of data.notices) {
            after = Math.max(after, n.seq);
            if (Notification.permission === 'default') await Notification.requestPermission(); // 主进程会自动放行
            if (Notification.permission !== 'granted') continue;
            const note = new Notification(n.title, { body: n.body, tag: n.botId });
            note.onclick = () => { const ws = ctx.get('uiWorkspace'); if (ws && n.botId) ws.openSession(n.botId); };
          }
        } catch (e) {}
      }
      poll();
      const timer = setInterval(poll, 15000); // 窗口隐藏后会被节流；要实时可改用补充条目 S2 的 SSE
      ctx.effect(function () { return function () { clearInterval(timer); }; });
    };
    return module.exports;
  },
});
```

> 核查说明：原代码有两个问题：after=0 会让页面每次刷新都重弹积压；宿主没有 bootId，重载后 seq 归零会漏发。原文“样板已在用户 DSH 上跑通”没有源码证据，样板也是针对 npm 版 web 服务写的（index.js:24-28）。另外，主窗口没有关闭 backgroundThrottling（main.js:11960-11968），隐藏后 setInterval 会被节流。

证据：dsh-src/_app/main.js:12134（applicationUrl = dsh-app://app/）；:11880-11890（registerSchemesAsPrivileged：standard、secure、supportFetchAPI、stream）; dsh-src/_app/main.js:11935-11968（createWindow：没有 partition，webPreferences 里没有 backgroundThrottling）; dsh-src/_app/main.js:7062-7085（installMicrophonePermissions：permission !== 'media' 时 check 返回 true、request 回调 true）；:12417（装在 session.defaultSession 上）; dsh-src/_app/main.js:12406-12414（protocol.handle：app 主机下的非静态路径转发给 Host）；:8268-8300（forwardWebRequest：删掉 host/origin/cookie/sec-fetch-site，注入 Host cookie，响应体流式透传）; dsh-src/_app/main.js:12880-12906（close 被 preventDefault，改为 hideMainWindow）; dsh-src/@deepseek-ai/dsh-api-remotes/lib/index.js:21-139（API_REMOTE_FORWARDED_EVENTS 固定名单）；README.zh.md:77-79（能力集合构建时固定；单向通知不回放）; dsh-src/@deepseek-ai/dsh-client-modules/README.zh.md:34（dsh.client.platform: 'web' + ./client 导出）、:77（manifest 包名就是浏览器模块身份，load 的 id 必须等于 package.json 的 name）; dsh-src/@deepseek-ai/dsh-client-ui-workspace/README.zh.md:74（ctx.uiWorkspace.openSession(target)，target 可以是已知的 Session id）; /Users/bytedance/Documents/DSHarness Doc/dsh-auto-upgrade/plugin/lib/client.js:7-16、33（ModuleLoader 包装和 fetch('/api/…')）；lib/index.js:24-28（HEALTH_URL=127.0.0.1:3939、~/.npm-global 安装路径）

## [confirmed] 1) 通知：宿主插件侧怎么提醒主人？用哪些事件触发？

核实成立。

【宿主半的运行环境】宿主半跑在 Host 子进程里。这个子进程由 Electron 以 ELECTRON_RUN_AS_NODE=1 拉起，所以拿不到 Electron 的 Notification 和 dock API。它可以：
- 用 child_process.execFile 调 /usr/bin/osascript 弹系统通知；
- 向外推送消息。

【可用事件】事件名、模式和签名都准确：
- approval/request（waterfall，签名 (req, next)；ApprovalRequestEvent 字段为 {agent, toolName, callId?, reason?, displayReason?, signal?}）；
- user-questions/request（waterfall；AskUserQuestionRequestEvent 字段为 {questions: AskUserQuestionItem[], agent?, signal?, wait?}）；
- agent/status（emit，idle ⇄ running）；
- goal/changed、goal/activation-changed、schedule/changed（无 payload）。

【只旁观、不作答】中心插件的监听器挂在根上，没有作用域标签，能收到所有 agent 的请求。用 {prepend: true} 排到最前，再 return next() 交出去，就不会替主人作答。

【没有页面连着时】网关会把请求挂在 pendingRemoteEvents 里，等有 owner 页面连上才投递。

补充四点：
① 子代理的审批策略被固定为 never。子代理需要审批的操作会被直接拒绝，不会触发 approval/request。所以名册只需匹配顶层会话的 id。
② 计划审阅也走 user-questions/request，判断条件是 questions[].intent.kind === 'plan-review'。
③ ctx.typertGateway.hasLiveClient() 能判断此刻有没有能作答的 owner 页面。注意桌面版窗口隐藏时仍算在线。
④ 可以写 const outcome = await next()，拿到最终结果（'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'）后再撤掉提醒。

> 核查说明：osascript 通知在新版 macOS 上显示为“脚本编辑器”来源，这属于 macOS 行为，源码无法核实。原代码用 ctx.webServer.register 注册的路由不经过鉴权，本机任何进程都能读到通知内容，建议换成补充条目 S1 的 ctx.connection.fetch.register 写法。

证据：dsh-src/_app/main.js:3794-3805（spawn Host 子进程）；:3649-3657（desktopNodeEnvironment 注入 ELECTRON_RUN_AS_NODE=1）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4092-4098（approval/request）、:4508-4514（user-questions/request）、:4028-4034（agent/status）、:4260-4275（goal/activation-changed、goal/changed）、:4348-4354（schedule/changed）; api-catalog.js TYPE_API：:4743（ApprovalRequestEvent）、:4731（ApprovalOutcome）、:4779（AskUserQuestionRequestEvent）、:4767（AskUserQuestionItem）、:4763（AskUserQuestionIntent {kind:'plan-review', approve, callId?}）; dsh-src/@deepseek-ai/dsh-user-approval/README.zh.md:32（应答者语义；同级顺序不是优先级）、:36（policy never 在分发前就拒绝）; dsh-src/@deepseek-ai/dsh-scope/README.zh.md:75（无标签监听器在作用域筛选中放行）; dsh-src/@deepseek-ai/dsh-tool-jobs/lib/index.js:235-239、dsh-experimental-auto-review/lib/index.js:461-488（{ prepend: true } 的现成用法）; dsh-src/@deepseek-ai/dsh-api-gateway/lib/index.js:758、:851-873（注册时立即消费事件源）、:1014（页面连上时投递挂起事件）、:1062-1106（startRemoteEvent 存入 pendingRemoteEvents）、:841-844（hasLiveClient）; dsh-src/@deepseek-ai/dsh-api-remotes/lib/index.js:146-180（每条转发 waterfall 都要求 request.agent 与载体一致）; dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:397-415（approval policy is pinned to 'never'）、:425-433（以 delegation 来源写入子会话日志）; /Users/bytedance/Documents/DSHarness Doc/dsh-auto-upgrade/plugin/lib/index.js:12、90-96（宿主插件 execFile 起子进程）

## [confirmed] 1) Dock 角标、把 DSH 窗口叫回前台

核实成立。

【Dock 角标】main.js 对 app.dock 只调用了 bounce 和 cancelBounce，没有 setBadge 或 setBadgeCount。宿主子进程拿不到 Electron API。navigator.setAppBadge 在这个 Electron 版本里会不会映射成 Dock 角标，仍需实测。

【实测入口】主窗口 webPreferences 里 devTools 为 true，菜单里有两个隐藏的 toggleDevTools 项（一个带 F12 快捷键），可以在控制台里直接试。

【叫回前台】
- dsh://open 会调用 focusPrimaryWindow，宿主插件可以 execFile('/usr/bin/open', ['dsh://open'])。
- macOS 的 activate 事件在没有可见窗口时也会调用 focusPrimaryWindow。

补充两个限制：
- setAsDefaultProtocolClient('dsh') 只在打包版，或设置了 DSH_DESKTOP_DEV_APP=1 时才注册。
- focusPrimaryWindow 在还没进入工作区时会直接 return。

> 核查说明：setAppBadge 部分仍是 low，属于未验证。

证据：dsh-src/_app/main.js:9707、9711（app.dock 只有 cancelBounce、bounce）；grep setBadge 无结果; dsh-src/_app/main.js:13031-13054（focusPrimaryWindow，13050 行：未进入工作区时 return）；:13055-13062（setAsDefaultProtocolClient 的条件、open-url 只认 dsh://open、activate）; dsh-src/_app/main.js:11960-11968（devTools: true）；:12787-12794（隐藏的 toggleDevTools，其中一个带 F12）

## [confirmed] 2) 远程访问：桌面版能否让主人从手机浏览器访问？

核实成立：不能，也没有开关。
- Host 子进程固定执行 runProfile({profile: 'desktop', args: ['--no-open', '--host', '127.0.0.1', '--port', '0']})。
- 带 token 的 URL 只通过 IPC 的 ready 消息交给 Electron，而且 URL 写死为 127.0.0.1。
- desktop 这个 profile 名留给 Electron 专用，dsh CLI 拒绝启动它，也拒绝对它做配置 dump。
- 如果用补丁把 webserver 行的 host 改成局域网 IP，Host 就不再监听 127.0.0.1，而 Electron 仍然去连 127.0.0.1，桌面版自己会坏掉。

一处细节更正：转发时注入的请求头分两种情况。
- 普通 HTTP 请求经 forwardWebRequest 转发：删掉 host、origin、cookie、sec-fetch-site，只注入 Host cookie。
- WebSocket 升级请求在 onBeforeSendHeaders 里改写：注入 origin、cookie 和 sec-fetch-site: same-origin。

证据：dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:217-243（runProfile 的 profile 与 args）、:342-349（authenticatedUrl 写死 127.0.0.1，经 process.send ready 交给 Electron）; dsh-src/@deepseek-ai/dsh/README.zh.md:20；dsh/lib/bin.js:36（desktop profile 只归 Electron 管）; dsh-src/_app/main.js:12406-12414、8268-8300（HTTP 转发）；:12447-12470（WebSocket 头改写）; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:178-186（webserver 行：host 取 webStartup.host，默认 127.0.0.1；拒绝通配地址）

## [corrected] 2) 远程访问：官方远程路径如何开启、鉴权，局域网和外网怎么做？

大部分核实成立，改正一处：Tailscale + TLS 的命令必须加 --public-url。

【原因】没设 publicUrl 时，打印的带 token 链接用的是绑定地址，也就是 https://100.x:3080/?token=…。证书上的名字是 ts.net 主机名，跟 IP 对不上，浏览器在页面加载前就会报错。--public-url 只改打印和公告的 URL，不授予信任，所以 --trusted-host 仍然要写。

【其余核实成立的部分】
- 启动方式：dsh --profile web，第一次使用时从模板初始化。
- --host 只接受一个具体的本机 IP，通配地址会报错（报错原文提到 remote code execution）。
- --port 默认 3080。
- --tls-cert 和 --tls-key 必须成对给出，直接提供 HTTPS。
- --trusted-host：loopback 和绑定 IP 之外的 authority 都要用它点名。
- 鉴权：GET / 时用 token 换签名 cookie，再重定向到干净地址。cookie 是 HttpOnly、SameSite=Strict，绑定 host:port，默认 30 天，监听器是 TLS 时才带 Secure。
- Host/Origin 栅栏：sec-fetch-site 为 cross-site 一律拒绝；栅栏失败返回 403，未认证返回 401。
- 程序化调用走 /connect。
- 所有认证通过的调用方都是 owner。
- 没有 logout：删除凭据记录 client-connection/browser-session 并重启，才能撤销全部会话。
- 明文 HTTP 有告警，cookie 可能被嗅探。
- 前端带 PWA manifest（display: fullscreen），但中栏可能不到 400px。

【共用 $DSH_HOME 的风险】已核实：
- 会话目录是 dshHomePath('sessions')，KV 存储是 dshHomePath('storages')，schedule 和 workspace 走 storageDomain，落在 storages/<name>.json。
- storage-json 没有跨进程写锁。
- 同一会话被另一个写句柄占用时，界面会提示退出其他 DSH。

```
# 局域网（明文 HTTP，只在可信 Wi-Fi 用，启动时会告警）
dsh --profile web --no-open --host 192.168.1.23 --port 3080
# Tailscale + TLS：必须加 --public-url，否则打印的带 token 链接是 100.x 地址，和证书名对不上
dsh --profile web --no-open --host 100.101.102.103 --port 3080 --tls-cert ./mac.tailnet-xxxx.ts.net.crt --tls-key ./mac.tailnet-xxxx.ts.net.key --trusted-host mac.tailnet-xxxx.ts.net --public-url https://mac.tailnet-xxxx.ts.net:3080/
# 启动后终端打印 dsh web: https://mac.tailnet-xxxx.ts.net:3080/?token=…，在手机上打开一次，换得 30 天 cookie
```

> 核查说明：原 Tailscale 命令缺少 --public-url，照抄会因为证书名和 IP 不匹配而打不开。共用 $DSH_HOME 的证据补充为 dsh-base:141/184 和 storage-json README:141。两个进程同时跑会不会让同一个定时提醒触发两次，未核实，已列入 open_questions。

证据：dsh-src/@deepseek-ai/dsh-web-app/README.zh.md:16、41、51-58（publicUrl 未设置时公告绑定地址 URL）、65、67、79（--public-url 改打印/打开的启动 URL，不授予信任）、81、83、173（证书名字必须覆盖访问的 authority，证书与 --public-url 相互独立）; dsh-src/@deepseek-ai/dsh-web-app/lib/startup.js:25（各 flag 定义）、44-68（通配地址报错、TLS 必须成对）; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:178-186、233-240; dsh-src/@deepseek-ai/dsh-client-connection/README.zh.md:41、43、47、49、51、81、83；lib/index.js:240-251（isTrustedApiRequest）、294-300（processLaunchToken）; dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md:39、45、130; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:138-141（sessions 根目录）、182-185（storages 根目录）；dsh-storage-json/lib/index.js:162-179（<root>/<name>.json）；dsh-storage-json/README.zh.md:141（没有跨进程写锁）；dsh-schedule/lib/index.js:1675-1677（domain 名为 schedule）; dsh-src/@deepseek-ai/dsh-client-ui-conversation/README.zh.md:115; dsh-src/@deepseek-ai/dsh-web-frontend/dist/manifest.webmanifest（display: fullscreen，start_url ./）；dist/index.html（viewport、manifest link）；dsh-client-ui-layout/README.zh.md:95; dsh-src/@deepseek-ai/dsh/README.zh.md:20；dsh-src/_app/main.js:7441（菜单“管理 dsh 命令…”）

## [confirmed] 2) 远程访问：dsh-api-remote-access、dsh-api-remotes、liveshare、peer 这一套现在能做什么？

核实成立。

【ctx.remoteAccess】只是一套给非 owner Peer 做方法级访问控制的机制，成员有 registerPolicy、invalidate、decide、allows、snapshotFor、follow。全仓只有它自己的包和 api-catalog 里出现 registerPolicy，没有任何 policy 实现。

【principal】PrincipalMap 里只有 owner 一种。

【liveshare】只是 README 里举的例子，不存在 liveshare 包。

【回答转发的 waterfall】只限 owner。

【Peer】PeerScope 的字段是 {id, ctx, principal, signal, interactions, dispose}。
- ctx.connection.browserPeer：所有认证浏览器共享的 owner Peer。
- ctx.connection.createPeer({principal, interactions?})：在进程内造一个 Peer，interactions 默认 'answer'。
- InvokeRemoteRequest.peer 是必填字段。

【dsh-api-remotes】Client 能力集合在构建时固定。

结论：今天这套东西做不了开箱即用的只读分享。

> 核查说明：原文“0.2.1-rc.2 起 typertGateway.invoke 必须带 Peer”里的版本号，源码和 README 都查不到；peer 必填这一点属实。

证据：dsh-src/@deepseek-ai/dsh-api-remote-access/README.zh.md:12、27-36、46（liveshare 只是举例）、84（交互参与只限 owner）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:6435（PrincipalMap 只有 owner）、:6303（PeerScope）、:5687（InvokeRemoteRequest.peer: PeerScope，必填）、:717（createPeer）; grep registerPolicy：只出现在 dsh-api-remote-access 自身和 api-catalog; dsh-src/@deepseek-ai/dsh-client-connection/README.zh.md:49; dsh-src/@deepseek-ai/dsh-api-remotes/README.zh.md:77-78

## [confirmed] 2) 远程访问：桌面版宿主插件能否自己“开一扇门”？

核实成立：代码层面能做到，但不推荐。

【可用接口】
- ctx.connection.authenticatedUrl(baseUrl)：返回带本进程启动 token 的 URL，等于一把 owner 钥匙。
- ctx.connection.requestRejection(request)：返回 401、403 或 undefined。
- ctx.connection.admit 和 ctx.webServer.port。

【补丁】web-app 补丁里 connection 行的注释写明，可以追加部署值，例如 ['app.internal', ...ctx.webStartup.trustedHosts]。但补丁会整行替换 config。

【风险】端口每次随机、要自己处理 WebSocket 升级、所有访问者都是 owner、界面没适配手机，风险高。

> 核查说明：这条整体仍是 low：只验证了接口存在，没有验证整条方案能跑通。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:705（requestRejection）、711（admit）、717（createPeer）、735（authenticatedUrl）；:5059（ConnectionRequestRejection = 401 | 403 | undefined）; dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:440-444（authenticatedUrl 把 launchToken 加进 URL）、737-740（requestRejection）; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:233-240; dsh-src/@deepseek-ai/dsh/README.zh.md:41-44；dsh-web-app/README.zh.md:105

## [corrected] 2) 远程访问：如果不能直接访问，手机端最现实的路径是什么？

方向成立：先做只出不进的推送，再用长连接收指令，最后才考虑自建精简手机页。桌面 Host 只绑 127.0.0.1，外部 webhook 打不进来。dsh-webhook 和 dsh-webhook-github 只在 monorepo 里，没有随桌面版发货。沙箱只管文件写，不管网络。

改正两处代码问题：

① ctx.sessionController.prompt 的签名是 prompt(request, signal)，第二个参数必填。实现的第一行就是 signal.throwIfAborted()，原写法不传 signal 会直接抛 TypeError。requestId 是幂等键：同一个 requestId 已经在 inbox 或会话日志里，就只返回 {accepted: true}，不会重复入队。所以用飞书的 message_id 拼成 requestId，正好能挡住重复投递。

② 子进程环境只按变量名清洗：/KEY|PASSWORD|SECRET|TOKEN/i 和 DSH_*。原代码的变量名 AGENT_HUB_FEISHU_WEBHOOK 不在清洗范围内，机器人在 bash 里执行 env 就能看到 webhook 地址，而这个地址本身就等于发消息的凭据。变量名要包含 TOKEN、SECRET 或 KEY。注意 $DSH_HOME/.env 文件本身仍然能被机器人的读文件工具看到，因为沙箱只限制写。

```
// 宿主半：推送到飞书自定义机器人，并把主人的回复转给机器人（需要 inject: ['sessionController']）
import { createHmac } from 'node:crypto';

// 变量名必须含 TOKEN / SECRET / KEY，否则不会从 bash 子进程的环境里清掉
export async function pushFeishu(text) {
  const url = process.env.AGENT_HUB_FEISHU_WEBHOOK_TOKEN;  // 主人自己粘贴到 $DSH_HOME/.env
  const secret = process.env.AGENT_HUB_FEISHU_SIGN_SECRET; // 开了“签名校验”才需要
  if (!url) return;
  const body = { msg_type: 'text', content: { text } };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = createHmac('sha256', timestamp + '\n' + secret).update('').digest('base64'); // 飞书签名算法，需对照官方文档实测
  }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('feishu push failed: ' + res.status);
}

// 主人从飞书回了一句话：唤醒对应的机器人会话
export function relayToBot(ctx, sessionId, messageId, text) {
  return ctx.sessionController.prompt(
    { requestId: 'feishu-' + messageId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, // requestId 是幂等键
    AbortSignal.timeout(30000), // 第二个参数必填
  );
}
```

> 核查说明：原写法 prompt({…}) 漏了必填的 signal，运行时会抛错；原变量名 AGENT_HUB_FEISHU_WEBHOOK 会暴露给机器人的 bash。飞书签名算法（timestamp + 换行 + secret 作 HMAC 的 key，消息为空）属于外部文档知识，离线无法核实。

证据：dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3218-3231（prompt(request, signal)，第一行 signal.throwIfAborted()）、:925-927、:1128-1140（hasPromptRequest：按 rpcId 在 inbox 和会话事件里去重）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:2078-2084（prompt 签名：signal 不是可选参数）、:7295（SessionPromptRequest）; dsh-src/@deepseek-ai/dsh-subprocess/lib/index.js:32（SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i）、:50-56（scrubbedParentEnv）；README.zh.md:80（子进程不会隐式继承形似凭据的名字）; dsh-src/@deepseek-ai/dsh-launch-environment/README.zh.md:12（Harness 主目录的 .env 会复制进 process.env）; dsh-src/@deepseek-ai/dsh-bash-sandbox/README.zh.md:32、170；dsh-sandbox-policy/README.zh.md:147（只管文件影响，不限网络）; docs/design/evidence/02-proactive-wakeup.md:162-164；dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:218-219

## [confirmed] 3) 浏览器：dsh-client-ui-sidebar-browser 是否只给人用？

核实成立：只给人用。README 的“模型体验”一节写的是：不注册工具、prompt section 或 Session event。

【桌面版的实现与限制】
- 用 Electron <webview>，默认启用。
- 每个工作区一个分区，名为 dsh-sidebar-browser-<uuid>。名字没有 persist: 前缀，Cookie 和 Web storage 重启后就没了。
- guest 的权限请求、设备、屏幕共享、下载一律拒绝。
- HTTP 认证用空的 callback() 直接取消。
- disableDialogs 为 true。
- devTools 只在开发版开启。
- 拒绝访问 DSH 自身的 Host 地址：同端口的 localhost、127.0.0.1、[::1] 都算。
- 通过检查的 HTTP(S) popup 会改成打开一个 Sidebar 标签。

【插件能做的】只有替人打开一个标签：客户端调用 ctx.sidebarRight.openTab('browser', { params: { url } })。

证据：dsh-src/@deepseek-ai/dsh-client-ui-sidebar-browser/README.zh.md:28、43、59、90-92、110; dsh-src/_app/main.js:10481-10512（acquire：分区 dsh-sidebar-browser-<uuid>）、10543-10566（webview 偏好被锁死，devTools: !app.isPackaged）、10607-10610（login 回调直接取消）、10623-10660（configureSession 和 isApplicationHost）

## [confirmed] 3) 浏览器：有没有给模型用的浏览器自动化工具？

核实成立。随桌面版发货的 308 个包里，没有任何给模型用的浏览器自动化工具。

packages.md 是官方从 monorepo 生成的清单，覆盖 260 个包，与已发货目录的差集正好 30 个。其中包括：
- dsh-browser-use；
- 三个 experimental browser-use 包（playwright-mcp 的描述是 per-Session Chromium browser tools）；
- dsh-computer-use 和 cua 系列。

api-catalog 里有 browserUse.register(name) 和 computerUse.register(name)，各自只允许注册一个 provider。web_fetch 只做匿名 GET。

> 核查说明：补充：api-catalog 的 SERVICE_API 是 monorepo 全集。browserUse、computerUse、webhookRuntime、lsp、ssh、claudeCodeMods 这些键，在桌面版运行时的 ctx 上都不存在，因为对应的包没有发货。

证据：dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md:3、43-47、191-193、199-201; packages.md 与 dsh-src/@deepseek-ai 目录的差集（30 个）：dsh-browser-use、dsh-computer-use、三个 dsh-experimental-browser-use-*、dsh-experimental-computer-use-cua-driver-mcp/native、dsh-experimental-cua-macos、dsh-experimental-claude-code-mods、dsh-lsp、dsh-ssh、dsh-webhook、dsh-webhook-github、dsh-web-search-exa/perplexity 等; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:484-495、636-647; dsh-src/@deepseek-ai/dsh-web-fetch-http/lib/index.js:162、196（method GET）

## [confirmed] 3) 浏览器：接 Playwright 之类 MCP 的路径

DSH 侧核实成立。

【接法】用随包的 dsh-mcp-client，以 stdio 方式接入。工具名形如 mcp__<serverName>__<原名>。

【环境】stdio 子进程的环境会被清洗：名字匹配 /KEY|PASSWORD|SECRET|TOKEN/i 的变量和所有 DSH_* 都删掉，再合并 config.env。

【超时与重连】
- 单次调用默认 60 秒超时，可用 toolCallTimeoutMs 调整。
- 断线后从 500ms 开始翻倍重连，上限 30 秒；连续失败 10 次就移除这些工具。
- 官方 SDK 优先用 2026-07-28 协议，并回退到它支持的旧版协议。

补充三个实操要点：
① Host 的 PATH 来自登录 shell。桌面版内置的 node 启动器目录只给插件包管理用，不在 MCP 子进程的 PATH 上。所以 command: npx 依赖用户自己装的 Node（Homebrew、nvm 等）。
② mcp-client 的 apply 会 await 初始连接和工具发现，npx @playwright/mcp@latest 每次启动都可能联网，拖慢启动。建议固定版本并预装。
③ 如果这条 MCP 行放在 preset 里，不要开 failOnStartupError: true。preset 里任何一行激活失败，整个 preset 都会拒绝挂载，新会话就绑不上它。

Playwright 自身的参数（--user-data-dir、--isolated 等）属于外部知识，仍以 --help 为准。

> 核查说明：补充的 npx 依赖用户自装 Node、preset 里 failOnStartupError 的风险，都是根据上列代码推断，confidence 为 medium。

证据：dsh-src/@deepseek-ai/dsh-mcp-client/README.zh.md:12、28、34-67、71、75、93、137; dsh-src/@deepseek-ai/dsh-mcp-client/lib/index.js:762-836（828-829 行：await connection.ready；failOnStartupError 时 throw）；package.json：@modelcontextprotocol/client 2.2.0; dsh-src/@deepseek-ai/dsh-subprocess/README.zh.md:149（MCP 由 SDK 自己 spawn，不经 subprocess 服务）; dsh-src/_app/main.js:9405-9420、12057-12064、12180-12185（Host 环境 = 登录 shell 环境 + DSH_CLIENT_VERSION）；:3649-3657、3804（Host spawn 时 bin 为 undefined，不改 PATH）; dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:236-246（内置 node-bin 只加进 packageManager.env.PATH）; dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md:56、60（激活失败会拒绝挂载，只禁用该定义的新绑定）

## [confirmed] 4) 联网工具：web_search、web_fetch 的准确名字、所在包、参数与配置

核实成立。

【包与插件】工具名是 web_search 和 web_fetch，来自 @deepseek-ai/dsh-tool-web。插件名为 'tool-web'，inject 为 ['tools', 'web', 'systemPrompt']。

【web_search】
- 参数：web_search({queries: string[]})，条数 1 到 searchMaxQueries。
- 处理：完全相同的查询用 new Set 去重，多条查询并发执行，结果按排名轮流合并，再按 URL 去重，最后截到 searchMaxResults 条。
- 输出：{content?, sources: [{url, title?, snippet?, publishedAt?}], truncated}。

【web_fetch】
- 参数：web_fetch({url})。
- 输出：{url, statusCode, body: {kind, content}, truncated}。

【配置默认值】search: true，fetch: true，searchMaxResults: 8，searchMaxQueries: 4，fetchTimeoutMs: 30000，searchTimeoutMs: 30000，fetchMaxOutputChars: 200000。

【挂在哪】dsh-base 有一条主机级 tool-web 行，web-app 把它 disabled 了，改由 standard、ptc、cordis 三个 preset 各自挂载（fetch: true，searchTimeoutMs: 60000）。minimal preset 没有 web 工具。

> 核查说明：只有行号小偏差（ptc 实为 118-122，cordis 实为 115-119），内容无误。

证据：dsh-src/@deepseek-ai/dsh-tool-web/lib/index.js:43（[...new Set(queries)]）、189-212、214-216（合并去重）、261-268、736-743、803-813、823-858; dsh-src/@deepseek-ai/dsh-tool-web/README.zh.md:44-52、56-72; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:454-490; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:584-585；presets/standard.patch.yml:116-120、ptc.patch.yml:118-122、cordis.patch.yml:115-119；minimal.patch.yml 中没有 tool-web

## [corrected] 4) 联网工具：搜索供应商怎么配置？凭据从哪来？

大部分成立，改正一处：环境变量在默认组合里不生效。

【改正】dsh-web 选 provider 的代码是 config.searchProvider.get() ?? DSH_WEB_SEARCH_PROVIDER，也就是配置优先，环境变量只在配置为空时才用。dsh-base 的 web 行已经显式写了 searchProvider: deepseek-official、fetchProvider: http，所以在桌面版和 web 版的默认组合里，DSH_WEB_SEARCH_PROVIDER 和 DSH_WEB_FETCH_PROVIDER 都不起作用。要换 provider，只能改 web 行的 config，或用设置页的开关。

【其余核实成立】
- 错误码：没配置 id 时，没有可用 provider 报 WEB_PROVIDER_UNAVAILABLE，有多个报 WEB_PROVIDER_AMBIGUOUS；配置的 id 没注册报 WEB_PROVIDER_CONFIGURED_MISSING，注册了但不可用报 WEB_PROVIDER_CONFIGURED_UNAVAILABLE。
- deepseek-official：走 https://api.deepseek.com/anthropic/v1/messages，默认 model 为 deepseek-v4-flash、maxTokens 4096、maxUses 5。baseURL 没配置时回退到 $DEEPSEEK_SEARCH_BASE_URL。
- deepseek-search-api / deepseek-fetch-api：地址是 https://api.deepseek.com/v1/tools，count 默认 10（1 到 50），sendOriginalQuestion 默认开启（截取 128 个字符）。
- http：只抓公网单播地址，并把连接固定在校验过的地址上；只跟随同源重定向，最多 5 次；上限为响应 5,000,000 字节、正文 100,000 字符、超时 30 秒。
- 凭据优先级：账号 token（会话走 deepseek-account 路由时）> 字面 apiKey > apiKeyEnv（经 ctx.credentials 解析，没有该服务时退回环境变量）。
- 设置页“启用新版 Web 搜索 API”开关会同时切换 searchProvider 和 fetchProvider；密钥写进凭据域，不进设置文件。
- Exa 和 Perplexity 的 provider 只在 monorepo 里。

> 核查说明：原说法“也可以用环境变量 DSH_WEB_SEARCH_PROVIDER / DSH_WEB_FETCH_PROVIDER”在随包组合下不成立，改正依据是 dsh-web/lib/index.js:100、115 加 dsh-base/cordis.patch.yml:467-471。

证据：dsh-src/@deepseek-ai/dsh-web/lib/index.js:45-60（Config 与环境变量读取）、:100（searchProvider.get() ?? searchProviderEnv）、:115（fetchProvider 同理）、:123-132（resolveProvider 与各错误码）; dsh-src/@deepseek-ai/dsh-web/README.zh.md:36、44-47、67-76; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:467-481（web 行显式写了两个 provider；web-search-deepseek 与 web-deepseek-api 的 apiKeyEnv 都是 DEEPSEEK_API_KEY）; dsh-src/@deepseek-ai/dsh-web-search-deepseek/README.zh.md:28、36-54、61、65；lib/index.js:14、290; dsh-src/@deepseek-ai/dsh-web-deepseek-api/README.zh.md:27-48、53；lib/index.js:215、305; dsh-src/@deepseek-ai/dsh-web-fetch-http/README.zh.md:28-64；lib/index.js:422、646-648; dsh-src/@deepseek-ai/dsh-client-ui-settings-web-search/README.zh.md:12、28、30、40; packages.md:501-502

## [confirmed] 4) 联网工具：在 workspace-write 下是否会弹审批？

核实成立：workspace-write 和 danger-full-access 下，web_search 和 web_fetch 都不弹审批。

【原因】tools/pre-execute 这条 waterfall 的终点默认返回 {kind: 'allow'}，只有某个监听器返回 ask，才会走 approval.request。随包的 pre-execute 监听器只有三个：
- tool-jobs：直接 next()；
- workspace-changes：等记录器结算后 next()；
- auto-review：只在 Auto 档做 LLM 评审，评审不放行时才转人工。

tool-web 的 README 也写明公开抓取不请求审批。dsh-base 里 approval 行的策略由 DSH_PERMISSION_MODE 决定，permission 行有 read-only、workspace-write、danger-full-access 三档。沙箱只管文件，不管网络。

补充：一次 web_search 工具调用里，deepseek-official 最多可执行 searchMaxQueries × maxUses = 4 × 5 = 20 次服务端搜索。

> 核查说明：原证据里“使用 ctx.approval 的包只有 8 个”的 grep 清单不完整：还有 dsh-cordis-host-runner（另有一套待审批索引）、dsh-subagent（把子代理固定为 never）、dsh-user-approval 本身。结论不受影响。

证据：dsh-src/@deepseek-ai/dsh-tool-web/README.zh.md:250（最多 searchMaxQueries × maxUses 次原生搜索）、253（公开抓取不请求审批）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:3321-3325（终点默认 allow，ask 才进 serviceAsk）、3535-3555（serviceAsk 调 approval.request）; tools/pre-execute 监听器全集：dsh-tool-jobs/lib/index.js:235-239、dsh-workspace-changes/lib/index.js:1086-1094、dsh-experimental-auto-review/lib/index.js:461-488; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:259-277；dsh-permission-presets/README.zh.md:38-44; dsh-src/@deepseek-ai/dsh-bash-sandbox/README.zh.md:32、170；dsh-sandbox-policy/README.zh.md:147

## [corrected] 4) 联网工具：中心插件能否不经模型直接搜索和抓取，或者换成第三方搜索源？

两件事都能做，但要改正两处。

【能做的】中心插件 inject ['web'] 之后，可以直接调用：
- ctx.web.search({query, maxResults?}, signal?)
- ctx.web.fetch({url}, signal?)

也可以用 registerSearchProvider({id, available(), search(request, signal?)}) 或 registerFetchProvider 注册第三方搜索源。id 重复会抛 WEB_DUPLICATE_PROVIDER；注册通过调用方的 ctx.effect 完成，跟着插件 fiber 自动释放。

【改正】
① 换源只能把 profile 补丁里 web 行的 searchProvider 改成新 id。补丁会整行替换 config，所以 fetchProvider 也要一起写。设环境变量的办法在默认组合里无效。
② 直接调用 ctx.web.fetch 时，body.kind 为 'html' 的 content 是原始 HTML。转 markdown 是 tool-web 在给模型渲染时用 turndown 做的。所以“结果形状和工具一样”只对字段名成立，正文内容跟模型看到的不同，中心插件要自己转换或截断。

另外，中心插件直接调用时没有“发起会话”，deepseek-official 和 deepseek-api 两家都只能用 DEEPSEEK_API_KEY 凭据引用。如果主人之后在设置页切换“新版 Web 搜索 API”开关，会改写 searchProvider，覆盖掉补丁的值。

```
export default {
  inject: ['web'],
  apply(ctx) {
    // ① 中心插件自己“看世界”，不开模型轮次（没有发起会话，只能用 DEEPSEEK_API_KEY 凭据）
    async function scan(query, signal) {
      const r = await ctx.web.search({ query, maxResults: 5 }, signal); // { content?, sources: [{ url, title?, snippet?, publishedAt? }], truncated }
      if (r.sources.length === 0) return null;
      const page = await ctx.web.fetch({ url: r.sources[0].url }, signal); // { url, statusCode, body: { kind, content }, truncated }
      // kind === 'html' 时 content 是原始 HTML（最多约 10 万字符），要自己转 markdown 或截断
      return { sources: r.sources, first: page };
    }
    // ② 注册第三方搜索源。光注册不会切换，必须再改 profile 补丁里的 web 行
    ctx.web.registerSearchProvider({
      id: 'hub-search',
      available: () => Boolean(process.env.HUB_SEARCH_API_KEY), // 名字含 KEY，会从 bash 子进程环境里清掉
      async search(request, signal) {
        const res = await fetch('https://search.example.com/v1?q=' + encodeURIComponent(request.query), {
          signal,
          headers: { Authorization: 'Bearer ' + process.env.HUB_SEARCH_API_KEY },
        });
        const data = await res.json();
        return { sources: data.items.map((i) => ({ url: i.url, title: i.title, snippet: i.snippet })), truncated: false };
      },
    });
  },
};
// 对应的 profile 补丁（整行替换 config，两个键都要写；环境变量 DSH_WEB_SEARCH_PROVIDER 在默认组合里无效）：
// - id: web
//   config: { searchProvider: hub-search, fetchProvider: http }
```

> 核查说明：原说法“或设环境变量 DSH_WEB_SEARCH_PROVIDER=hub-search”在默认组合下无效（dsh-web/lib/index.js:100 加 dsh-base 显式配置）；原文没提醒直接调用拿到的是原始 HTML。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3548-3576（web 服务方法）；TYPE_API：:8575（WebSearchProvider）、:8515（WebFetchProvider）、:8579（WebSearchRequest）、:8583（WebSearchResult）、:8523（WebFetchResult）; dsh-src/@deepseek-ai/dsh-web/lib/index.js:63-90（注册与重复报错）、:100、:115（配置优先于环境变量）; dsh-src/@deepseek-ai/dsh-tool-web/lib/index.js:803-813（execute 原样返回 provider 的 content）、:591-552 一带的 renderFetchOutput 与 :550（turndown 只在渲染层）、:641-643（formatFetchOutput 供 render 使用）; dsh-src/@deepseek-ai/dsh-web-search-deepseek/README.zh.md:61（没有发起会话的调用用 API 密钥）；lib/index.js:10（原生 fetch，不走 ctx.llm）; dsh-src/@deepseek-ai/dsh-client-ui-settings-web-search/README.zh.md:30、40（开关暂存 searchProvider 和 fetchProvider）

## [confirmed] 5) MCP 客户端：MCP 服务器在哪里配置？格式是什么？

核实成立。

【格式】每台服务器就是一条 name 为 '@deepseek-ai/dsh-mcp-client' 的 Loader 行（插件名 'mcp-client'，inject ['tools']）。config 是一个 union：
- stdio：{transport: 'stdio', serverName, command, args: [], env: {}, cwd: ''}
- 远程：{transport: 'streamable-http', serverName, url, headers: {}}

公共字段与默认值：
- toolCallTimeoutMs：60000
- maxInstructionBytes：32768
- failOnStartupError：false
- reconnect：{enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10}

serverName 必须匹配 ^[A-Za-z0-9_-]{1,32}$。

【放在哪】
- profile 补丁：$DSH_HOME/profiles/desktop/cordis.patch.yml。
- home 级补丁：$DSH_HOME/cordis.patch.yml，桌面版也会应用。
- 只含配置的组合包：package.json 里写 dsh.bundle.patch，经插件页或 plugin_manager 安装。
- 写进某个 preset 的 plugins 列表。
- 用 await ctx.agentPresets.register(definition) 动态注册。它返回一个 Promise，结果是一个 disposer；注册后立即加载。

【生效方式】dsh-hmr 在有 profileContext 时默认启用，补丁改了会热重载。补丁会整行替换 config。preset 设置页是只读的。

> 核查说明：小差异：官方模板的行 id 是 demo-mcp，模板里没有 headers（headers 加 !!js 的写法来自 README 的示例）。模板里的 failOnStartupError: true 不要照搬进 preset，原因见第 3 题 Playwright 那条。

证据：dsh-src/@deepseek-ai/dsh-mcp-client/README.zh.md:12、34-71；lib/index.js:762-822; dsh-src/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml（行 id 为 demo-mcp，streamable-http，failOnStartupError: true，没有 headers）；templates/mcp/package.json（dsh.bundle.patch）；references/mcp-bundle.md:3-5; dsh-src/@deepseek-ai/dsh/README.zh.md:37-44、60（Desktop 也沿用 home patch）; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:28-32（hmr 的 disabled 条件是 !ctx.get('profileContext')）；dsh-web-app/README.zh.md:105; dsh-src/@deepseek-ai/dsh-client-ui-agent-preset/README.zh.md:28; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:66-75（async register(definition: PresetDefinition)）、:6411（PresetDefinition {id, name?, description?, order?, plugins}）

## [confirmed] 5) MCP 客户端：配置后对哪些会话或 preset 可见？连接粒度是什么？

核实成立。

【可见性】
- 写在顶层：注册在全局层，所有 preset 的会话都能看到，除非被 restrict 掉。
- 写在某个 preset 的 plugins 里：只有绑定这个 preset 的会话能看到。子作用域继承祖先的注册，反过来不成立。

【连接粒度】每个 preset 声明在启动时就创建一棵由注册表持有的 scope 和 Loader 树，绑定它的所有 Agent 共享这棵树。所以 preset 里的 MCP 是每个 preset 一条连接、一个进程，没有会话在用时也会建立。

【serverName】按注册作用域保留：全局实例之间、同一作用域内互斥，不同 agent 或 preset 作用域可以复用同名。

【共享资源工具】调用方作用域里有任一已配置的服务器时，才会出现 list_mcp_resources、list_mcp_resource_templates、read_mcp_resource 三个工具和服务器名提示段。

【会话的 preset】在创建时就定下来：SessionCreateRequest {workspaceId?, cwd?, sessionId?, agentPreset?}。会话一旦开始，就不能再换 preset。

证据：dsh-src/@deepseek-ai/dsh-scope/README.zh.md:12、75; dsh-src/@deepseek-ai/dsh-agent-preset-registry/README.zh.md:56、60; dsh-src/@deepseek-ai/dsh-mcp-client/README.zh.md:127；lib/index.js:767-774、812-822（activeServerNames 以 scopeOf(ctx) ?? ctx.root 为键）; dsh-src/@deepseek-ai/dsh-mcp-resources/README.zh.md:30-42、90；dsh-base/README.zh.md:64; dsh-src/@deepseek-ai/dsh-client-ui-agent-preset/README.zh.md:32、52; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:7003（SessionCreateRequest）

## [confirmed] 5) MCP 客户端：插件能否按会话挂载？

核实成立：官方没有给单个会话挂 MCP 的 API。

【方案 A】机器人类型对应一个专用 preset，把 MCP 行放进它的 plugins，建会话时指定 agentPreset。

【方案 B】MCP 行放全局，再按机器人裁剪：
- 在 agent/created 里处理。它是 serial 事件，payload 为 {agent, source, signal?}，source 取值 'startup' | 'resume' | 'clear' | 'compact'。
- 用 agent.ctx.tools.restrict({deny}) 把工具从模型可见列表里拿掉。必须经过带作用域的 ctx，不带作用域会抛错；名字必须是已注册的全局工具，传空过滤、写错名字、写作用域本地的名字都会抛错。
- 再用 agent.ctx.tools.guard(exec => 原因字符串或 undefined) 在调用时兜底拒绝。经 agent.ctx 注册的 guard 只作用于这个 agent，而且任何 guard 拒掉的调用都不能被别处强行放行。
- 先例：dsh-subagent 用 childCtx.tools.restrict(toolFilter)。

【方案 C】用 agent.ctx.plugin(...) 给单个会话挂实例，没有文档，未验证。

原代码在 restrict 外面包了 try/catch，这一点是对的：agent/created 的监听器一抛错，会话创建就失败。

> 核查说明：补充两点（推断，medium）：①经 agent.ctx 注册的 guard 和 restrict 归 agent 作用域所有，中心插件热重载或停用时不会自动撤掉，而 agent/created 只对新建或恢复的会话触发，需要自己防重复注册；②子代理也是 agent，它的 id 是子会话 id，不在名册里就会被 guard 拒掉，需要时按父会话映射。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3364（restrict）、3370（guard）、3956-3962（agent/created：serial，抛错会让创建失败）；TYPE_API：:8199（ToolGuard）、:8231（ToolRestriction）、:7391（SessionStartSource）; dsh-src/@deepseek-ai/dsh-tools/lib/index.js:2985-3005（restrict 的各种抛错条件）; dsh-src/@deepseek-ai/dsh-subagent/lib/index.js:395（childCtx.tools.restrict）、939（childCtx.tools.guard）; dsh-src/@deepseek-ai/dsh-scope/README.zh.md:56-58（注册上下文同时决定可见性和所有权）

## [confirmed] 6) 有没有飞书/Lark、邮件、IM 相关的官方包？

核实成立：没有。
- 已发货的 308 个包和 packages.md 列出的 260 个包里，都没有飞书/Lark、邮件（SMTP/IMAP）、Slack、Telegram、钉钉、企业微信等集成包，也没有通知或推送类包。
- 源码里“飞书”只用在两处：测试版更新策略的“用飞书登录”（authentication: 'feishu-test'），以及账号菜单的意见反馈问卷。
- dsh-webhook 和 dsh-webhook-github 只在 monorepo 里。webhookRuntime 只有 register(rule) 和 dispatch(delivery) 两个方法，唯一的内置动作是新建会话。

证据：包名 grep（lark|feishu|slack|mail|smtp|imap|telegram|wechat|dingtalk|discord|notif）：已发货目录和 packages.md 都没有命中; dsh-src/_app/main.js:7413-7415、9474-9482、10073、13133（feishu-test 只用于测试版更新策略）; dsh-src/@deepseek-ai/dsh-client-ui-settings-account/README.zh.md:45; packages.md:218-219；dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3592-3609; dsh-src/@deepseek-ai/dsh/README.zh.md:54

## [confirmed] 6) 飞书、邮件、IM 该怎么接？

核实成立，只能自建。三条路：
① 中心宿主插件直接调飞书 OpenAPI 或 webhook。
② 经 dsh-mcp-client 给机器人接飞书 MCP。
③ 在 bash 里用 curl 调 webhook。沙箱不拦网络；但 web_fetch 只能 GET，发不了消息。

对外的写操作默认都不审批，需要自己在 tools/pre-execute 里返回 allow、deny、cancel 或 ask，或者用 tools.guard 做白名单和确认。

补充：所有给中心插件用的密钥变量，名字都要包含 TOKEN、SECRET 或 KEY，原因见第 2 题“手机端路径”那条。接 MCP 时，密钥用 env 加 !!js process.env.X 显式传进去。

证据：docs/design/evidence/07-guard-safety-quota.md:36-39、425-441; dsh-src/@deepseek-ai/dsh-mcp-client/README.zh.md:34-67、137; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4484-4490（tools/pre-execute）、:6427（PreToolDecision）; dsh-src/@deepseek-ai/dsh-web-fetch-http/lib/index.js:162、196; dsh-src/@deepseek-ai/dsh-subprocess/lib/index.js:32

## [corrected] 补充 S1：宿主半给客户端半提供数据，应该用什么路由才带鉴权？

补充，调研员漏掉了。官方有现成的鉴权路由接口：ctx.connection.fetch.register(route)，route 的字段如下：
- path：必须以 /api/ 开头，每一段只能包含 [A-Za-z0-9_$.-]；
- methods：('GET' | 'HEAD' | 'POST')[]，不能为空，也不能重复；
- requestBody：'buffered' | 'streaming'；
- fetch：(request: Request) => Promise<Response>。

【鉴权】请求先经过 Connection 的 /api 前缀路由：Host/Origin 栅栏、cookie 认证、connection/request waterfall，然后才精确匹配到这条路由。非 owner Peer 一律返回 403。注册归调用方 ctx 所有，插件卸载时自动撤销。桌面版的 dsh-app 转发会注入 Host cookie，所以客户端半能直接 fetch。现成的例子：ui-deliverables 的 /api/present.host，session-controller 的 /api/file。

【对比】原方案用 ctx.webServer.register，那种路由不经过任何鉴权：Connection 只占 /api 前缀，更长的前缀或精确路由会先命中。

【注意】桌面版准备安装更新时会加锁，并 await 所有在途的 /api 请求。所以这类路由只适合短请求，不要在上面挂长连接或 SSE。需要长连接时，用原始 webServer 路由，并在 handler 开头调用 ctx.connection.requestRejection(req)。dsh-host-open-in-app 就是这么写的。

```
// lib/index.js：中心插件宿主半。通知队列，加一条经 Connection 鉴权的读取路由（配合第 1 题客户端代码）
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export default {
  inject: ['connection'],
  apply(ctx) {
    const bootId = randomUUID(); // 宿主半每次启动或热重载都换新，客户端据此重置游标
    const notices = [];
    let seq = 0;
    function notify(title, body, botId) {
      notices.push({ seq: ++seq, title, body, botId, at: Date.now() });
      if (notices.length > 200) notices.shift();
      execFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], () => {});
    }
    // 只旁观不作答：prepend 保证先看到，必须 return next()
    ctx.on('approval/request', async (req, next) => {
      notify('机器人等你审批', req.toolName + ' ' + (req.reason ?? ''), req.agent.id);
      return next();
    }, { prepend: true });
    ctx.on('user-questions/request', async (req, next) => {
      const plan = req.questions.some((q) => q.intent?.kind === 'plan-review');
      notify(plan ? '机器人的计划等你审阅' : '机器人在问你', req.questions.map((q) => q.question).join(' / '), req.agent?.id);
      return next();
    }, { prepend: true });
    // 路径必须是 /api/…，只有 owner 能访问；注册随插件 fiber 自动撤销
    ctx.connection.fetch.register({
      path: '/api/agent-hub/notices',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url);
        const sameBoot = url.searchParams.get('boot') === bootId;
        const after = Number(url.searchParams.get('after') ?? 0);
        return Response.json(
          { bootId, latest: seq, notices: sameBoot ? notices.filter((n) => n.seq > after) : [] },
          { headers: { 'cache-control': 'no-store' } },
        );
      },
    });
  },
};
```

> 核查说明：补充：这是对原方案 ctx.webServer.register（不鉴权）的改进。代码模式取自官方包的现成写法，没有实机跑过。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:684-686（readonly fetch: HostConnectionFetch）、705-709（requestRejection）；TYPE_API：:5583（HostConnectionFetch）、:5043（ConnectionFetchRoute）、:5039（ConnectionFetchMethod）、:5055（ConnectionRequestBodyMode）; dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:731-735（get fetch()：owner 取读取服务的 ctx）、820-853（createSharedFetchHandler：非 owner 返回 403；registerFetchRoute）、690、926-931、972-978（路径和 methods 校验）、1040-1066（/api 前缀路由：admit 之后进 connection/request waterfall）; dsh-src/@deepseek-ai/dsh-client-connection/README.zh.md:49、53; dsh-src/@deepseek-ai/dsh-client-ui-deliverables/lib/index.js:4、15-17、47-95；dsh-api-session-controller/lib/index.js:2482-2487（现成用法）; dsh-src/@deepseek-ai/dsh-host-open-in-app/lib/index.js:1263-1276（原始路由加 requestRejection 的先例）; dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:115-146（connection/request 记录在途请求；lock 时 await Promise.all(pendingRequests)）; dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md:61（先精确、再最长前缀）、130（没有服务器级认证）

## [corrected] 补充 S2：不轮询，能否由宿主半主动推送给客户端半（窗口隐藏时更及时）？

补充：可以用 SSE，有官方先例。

【先例】桌面版启动时只设置了 __DSH_TRANSPORT__ = {ownsHost: true, streamBaseUrl}，没有 fetch。所以 dsh-client-hmr 在桌面版里走的就是 new EventSource('plugins/events')，经 dsh-app 协议转发到 Host 的原始 webServer 路由。

【为什么能通】dsh-app scheme 注册了 stream: true，forwardWebRequest 把响应体流式透传。webserver 的 gzip 也明确不压缩 SSE。

【做法】中心插件注册一条不在 /api 下的原始路由，handler 开头先 ctx.connection.requestRejection(req) 鉴权，然后写 text/event-stream。这样不经过 connection/request，也不会卡住桌面版的更新锁。客户端用 new EventSource('agent-hub/events')，用文档相对路径，断线会自动重连。

窗口隐藏后，网络事件的投递是否也会被节流，需要实测。

```
// 宿主半（inject: ['webServer', 'connection']）：SSE 推送路由，故意不放在 /api 下
const streams = new Set();
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: '/agent-hub/events',
  handler(req, res) {
    const rejection = ctx.connection.requestRejection(req); // 与 /api 相同的 Host/Origin 和 cookie 校验
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const ping = setInterval(() => res.write(': ping\n\n'), 30000);
    streams.add(res);
    res.on('close', () => { clearInterval(ping); streams.delete(res); }); // 用 res 的 close 判断客户端断开
  },
}));
ctx.effect(() => () => { for (const res of streams) res.end(); streams.clear(); }); // 插件卸载或热重载时收尾
function broadcast(notice) { for (const res of streams) res.write('data: ' + JSON.stringify(notice) + '\n\n'); }

// 客户端半（在 exports.apply 里）
const es = new EventSource('agent-hub/events'); // 文档相对路径，断线自动重连
es.onmessage = (e) => { const n = JSON.parse(e.data); /* new Notification(n.title, { body: n.body, tag: n.botId }) */ };
ctx.effect(function () { return function () { es.close(); }; });
```

> 核查说明：补充，confidence medium：能在桌面版用 EventSource，是根据 HMR 的代码路径推断的，没有实机验证。

证据：dsh-src/@deepseek-ai/dsh-client-hmr/lib/client.js:235（EVENTS_ROUTE = 'plugins/events'）、249-262（有 transport.fetch 时走 fetch 流）、287-304（否则 new EventSource）; dsh-src/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js（桌面分支：s.__DSH_TRANSPORT__={ownsHost:!0,streamBaseUrl:n}，没有 fetch）; dsh-src/_app/main.js:11880-11890（stream: true）、8268-8300（Response(response.body) 流式透传）、12406-12412; dsh-src/@deepseek-ai/dsh-host-webserver/README.zh.md:41（SSE 不压缩）; dsh-src/@deepseek-ai/dsh-host-open-in-app/lib/index.js:1263-1276（原始路由加 requestRejection）

## [corrected] 补充 S3：桌面 profile 默认由哪些组合包组成？补丁该写哪些行 id？

补充：桌面 profile 第一次初始化时，用的就是 web 模板的组合包 [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]，所在目录是 $DSH_HOME/profiles/desktop。Host 再用 --host 127.0.0.1 --port 0 启动它。

所以默认的行 id 与 web 版一致：
- 传输与服务：webserver、web-runtime、connection、modules、client-hmr、api-remotes。
- 联网：web、web-search-deepseek、web-deepseek-api、web-fetch-http、tool-web（已 disabled）。
- 权限与资源：approval、permission、mcp-resources、schedule。
- preset：agent-preset-registry（default: standard），以及 preset-standard、preset-ptc、preset-minimal、preset-cordis。

这部分回答了原 open question 第 7 条中“用了哪些 bundles、行 id”的默认情况。用户有没有另外加组合包、改写这些行，仍需在不读 ~/.dsh 的前提下，从创造模式里用 cordis_inspect_query 的 Config.listConfigs 查看。

> 核查说明：补充：用源码回答了原 open question 第 7 条中关于默认组合的部分。

证据：dsh-src/_app/main.js:3385-3391（PROFILE_TEMPLATES.web = dsh-base + dsh-web-app）、3552（WEB_PROFILE）、3636-3638（createPluginProfile 用 WEB_PROFILE.bundles 初始化）、79-84（profile 目录为 $DSH_HOME/profiles/desktop）; dsh-src/@deepseek-ai/dsh-web-app/package.json（dsh.bundle.patch 依次为 cordis.patch.yml、presets/standard、ptc、minimal、cordis）; dsh-src/@deepseek-ai/dsh-web-app/cordis.patch.yml:178、196、217、223、233、248、584、591-594；presets/*.patch.yml:5（preset-standard、preset-ptc、preset-cordis、preset-minimal）; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:259、264、467-490

## 坑

- 所有提醒都要求 DSH 正在运行、Mac 没睡眠：全仓没有 powerSaveBlocker 或 caffeinate；Cmd+Q 退出后 Host 也会停。
- 主窗口没有关掉 backgroundThrottling（main.js:11960-11968 取 Electron 默认），窗口隐藏后客户端的 setInterval 轮询会被节流。关键提醒放在宿主侧（osascript 或飞书推送）发；客户端想及时，改用 SSE（补充 S2）。
- approval/request 和 user-questions/request 都是 waterfall：只想旁观，必须加 {prepend:true} 并 return next()。可以写 const outcome = await next()，拿到最终结果后再撤掉提醒。同级监听器的注册顺序不是优先级。
- 子代理的审批策略被固定为 never（dsh-subagent/lib/index.js:397-433）：子代理需要审批的操作会被直接拒绝，不会触发 approval/request。计划审阅走 user-questions/request，判断条件是 questions[].intent.kind === 'plan-review'。
- 单向通知断线后不回放（api-remotes README:79）。中心插件自己的通知队列要带 bootId 和游标，否则页面刷新会重弹积压，宿主重载后 seq 归零会漏发。
- ctx.webServer.register 注册的路由不经过任何鉴权：Connection 只占 /api 前缀，更长的前缀或精确路由会先命中。要鉴权，用 ctx.connection.fetch.register（路径必须是 /api/…，只有 owner 能访问），或在原始路由开头调用 ctx.connection.requestRejection(req)。
- 桌面版准备安装更新时会加锁，并 await 所有在途的 /api 请求（dsh-desktop-host/lib/index.js:115-146），所以不要在 connection.fetch 路由上挂 SSE 或长轮询；长连接放在 /api 之外的原始路由。
- dsh --profile web 与桌面版共用 $DSH_HOME/sessions 和 $DSH_HOME/storages，storage-json 没有跨进程写锁：同时运行两个进程，会抢同一会话的写锁，也会互相覆盖 schedule 和 workspace 的数据。
- Web 宿主上所有认证通过的调用方都是 owner，能跑 bash；明文 HTTP 下 cookie 可能被嗅探；没有 logout。authenticatedUrl 返回的就是 owner 钥匙，绝不能写进日志或发到飞书。
- TLS 部署要加 --public-url，否则打印出来的带 token 链接用的是绑定 IP，和证书上的主机名对不上。
- web_fetch 的 http provider 只抓公网单播地址，私网和 loopback 会被拒，所以机器人不能用 web_fetch 访问中心插件在本机的 API；它也不带 Cookie、不执行 JS。
- 中心插件直接调用 ctx.web.fetch 时，kind 为 'html' 的 content 是原始 HTML；转 markdown 是 tool-web 渲染给模型时才做的。
- 默认组合里，环境变量 DSH_WEB_SEARCH_PROVIDER 和 DSH_WEB_FETCH_PROVIDER 不生效：代码是 config ?? env，而 dsh-base 已经显式写了两个 provider。换源必须整行改写 web 行的 config。设置页的“新版 Web 搜索 API”开关也会改写这两个值。
- deepseek-official 每次 ctx.web.search 是一次完整的辅助 Messages 调用，最多做 maxUses=5 次服务端搜索；一次 web_search 工具调用最多 4×5=20 次。它用原生 fetch，不经过 ctx.llm，大概率不计入会话的 token 统计（这一点没有逐行核实计量路径）。
- 中心插件直接调用 ctx.web.* 时没有“发起会话”，用不了 DeepSeek 账号 token，只能用 DEEPSEEK_API_KEY 凭据引用（优先从 ctx.credentials 解析，没有时用环境变量）。
- 子进程环境只按变量名清洗：/KEY|PASSWORD|SECRET|TOKEN/i 和 DSH_*（dsh-subprocess/lib/index.js:32、50-56）。放进 $DSH_HOME/.env 的变量，名字不含这些词就会暴露给机器人的 bash；而且 .env 文件本身也能被机器人的读文件工具看到，因为沙箱只限制写。
- preset 里的 MCP 是每个 preset 一条连接、一个进程，同一 preset 下的机器人会共用浏览器；preset 启动时就会连接，apply 会 await 初始连接，npx @latest 会拖慢启动。preset 里不要开 failOnStartupError: true，否则 MCP 起不来，整个 preset 都会拒绝挂载。
- command: npx 依赖用户自己装的 Node：Host 的 PATH 来自登录 shell，桌面版内置的 node 启动器只给插件包管理用。
- MCP 工具的 schema 每轮请求都会发给模型；服务器的 instructions 会原样进系统提示词，有提示注入风险；MCP 调用默认不审批；MCP 子进程由 SDK 自己 spawn，不经过 subprocess 服务和沙箱。
- tools.restrict 只能经 agent.ctx 调用，只能裁剪已注册的全局工具；agent/created 是 serial 事件，监听器抛错会让会话创建失败，务必 try/catch。经 agent.ctx 注册的 guard 和 restrict 归 agent 作用域所有，中心插件热重载时不会被撤掉（推断）。
- Cordis 补丁会整行替换 config；会话一旦开始就不能再换 preset。
- api-catalog 的 SERVICE_API 是 monorepo 全集：browserUse、computerUse、webhookRuntime、lsp、ssh、claudeCodeMods 在桌面版运行时都不存在。
- sessionController.prompt(request, signal) 的 signal 是必填参数；requestId 是幂等键，可以拿外部消息 id 来拼。
- osascript 通知显示为“脚本编辑器”来源、点击不会打开 DSH，这些都是 macOS 行为，未核实。

## 未决

- 渲染进程里 new Notification() 在 0.2.1-rc.5 实机能否弹出？窗口隐藏时点击通知，能否靠 macOS 激活事件把窗口叫回来？验证方法：按 F12 或 ⌥⌘I 打开主窗口控制台，执行 new Notification('test', {body: 'x'})。
- preload-app.cjs 不在解包的源码里（main.js:12133 引用了它），没法完全排除它对页面 Notification 的影响。在 contextIsolation 下这种可能性很低。
- navigator.setAppBadge 是否会映射成 Dock 角标？验证方法同上。
- 主窗口隐藏后，setInterval 实际被节流到多长的间隔？EventSource 推送的投递会不会被延迟？
- SSE 走 dsh-app 协议在桌面版能否长期稳定？只从 HMR 的代码路径推断可以，没有实测。
- dsh --profile web 和桌面版同时运行时，两个进程的 schedule 服务会不会把同一个定时提醒各触发一次？
- monorepo 里的 dsh-browser-use、experimental browser-use、web-search-exa/perplexity、dsh-webhook 是否已经发布到 npm？engines.dsh 是否兼容 0.2.1-rc.5？
- @playwright/mcp 当前版本的确切参数和工具清单是什么？和 @modelcontextprotocol/client 2.2.0 实际协商出的是哪个协议版本？用户机器上 npx 是否可用？
- 飞书长连接 SDK 在宿主插件里怎么装依赖、是否稳定？Lark OpenAPI MCP 与 dsh-mcp-client 是否兼容？飞书 webhook 的签名算法需要对照官方文档实测。
- 用户的桌面 profile 有没有在默认的 dsh-base + dsh-web-app 之外另加组合包，或改写 webserver、connection、web 等行？不读 ~/.dsh 就无法确认，可以在创造模式里用 cordis_inspect_query 查 Config.listConfigs。
- iOS 上把页面加到主屏后，PWA 和 Safari 的 cookie 可能是隔离的；manifest 的 start_url 是 ./，不带 token。从主屏打开时会不会 401？（推测，未验证）
- tailscale cert 生成的证书能否直接用于 --tls-cert/--tls-key？iOS 是否信任 ts.net 证书？
- 用 agent.ctx.plugin(...) 给单个会话挂 mcp-client 实例是否可行？文档里没有提到。
