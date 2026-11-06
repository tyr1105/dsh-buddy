# agent-hub 项目守则（实现方必读）

## 这是什么

「DSH 版 Grok Bot」：在 DSH（DeepSeek Harness 桌面版）里养一群常驻、有名字、各有长期目标的机器人队友。中心插件 `dsh-buddy` 在 DSH 宿主进程里零成本地替它们盯着世界，评估出「有理由」才唤醒对应机器人的会话去想、去做；机器人想完自己决定下次什么时候再想、盯什么、要不要找主人。主人在一个像发短信的对话线程里和每个机器人说话，只在审批、提问、告警时被打扰。不是定时任务：主人从不设闹钟。

唯一权威的实现规格：`docs/build-spec.md`。设计背景（只读参考）：`docs/design/`（PRD 在 `docs/design/prd/spine.md`，DSH 接口手册在 `docs/design/build/dsh-plugin-handbook.md`）。

## 分工与目录

| 目录 | 负责方 | 内容 |
|---|---|---|
| `packages/core/` | Codex（GPT） | 主动性引擎核心：纯 TypeScript，**不得 import 任何 DSH 包**；时间、文件、网络、子进程、宿主全部经注入接口访问；全部逻辑可单测、可仿真 |
| `packages/plugin/` | DSH | DSH 插件 `dsh-buddy`：宿主半边（把 core 接到 DSH 会话、工具、钩子、权限档）与界面半边（总览、机器人线程、收件箱等） |
| `docs/tasks/` | 总控 Claude | 任务卡，**只读** |
| `docs/build-spec.md` | 总控 Claude | 实现规格，**只读** |
| `docs/progress/` | 实现方 | 每张卡一份进度记录 |
| `docs/questions.md` | 实现方 | 疑问与采用的保守默认 |

## 技术栈与命令

- Node 22、pnpm 11（**不要用 npm**）、TypeScript 5.9（strict、ESM、NodeNext）、vitest 3、zod 4（用 z.toJSONSchema 导出 JSON Schema）、esbuild。
- 依赖已经装好。**不要自己联网装新依赖**；确实需要时写进 `docs/questions.md`，先用 Node 内置能力或自己实现。
- 常用命令（在项目根目录 `agent-hub/` 下）：
  - `pnpm --filter @agent-hub/core test` 跑 core 测试
  - `pnpm --filter @agent-hub/core typecheck` 类型检查
  - `pnpm -r test`、`pnpm -r typecheck` 全部包

## 红线

1. 只改任务卡允许你改的目录；`docs/build-spec.md`、`docs/tasks/`、`docs/design/` 一律只读。
2. 不提交、不推送 git（不运行 git commit / push / reset / checkout 等改变历史或工作区的命令）。
3. 不读、不打印任何凭据：`~/.dsh/` 下除任务卡明确点名的路径外一律不碰，尤其 `.credentials.yaml`；`.env*` 不读。
4. core 里禁止直接使用 `Date.now()`、`new Date()`（无参）、`setTimeout`、`setInterval`、`Math.random()`、`fs`、`fetch`、`child_process`：一律通过注入的 `Clock`、`Rng`、`FsIO`、`NetIO`、`ExecIO`、`HostPort`。唯一例外是这些接口的「系统实现」文件（`src/io/system-*.ts`）。
5. 宿主插件里所有回调（定时器、事件监听、钩子、路由）必须 try/catch 兜底：一个机器人出错只影响它自己，绝不能带崩 DSH。
6. 不写 emoji；不在代码里写死主人的真实个人信息、公司信息。
7. 同一个错误连续修 5 次还不过，停下来把现象写进 `docs/questions.md`，不要硬改测试让它通过；**禁止为了通过而删改断言或跳过测试**。

## 代码规范

- 主人是产品经理、非程序员，要能读懂：**每个文件开头写中文说明（这个文件做什么、为什么这样设计），关键函数和每段逻辑写中文注释**，解释「做什么、为什么」。标识符用英文。
- 文件名 kebab-case（`wake-packet.ts`）。一个文件聚焦一件事，单文件尽量不超过 400 行。
- 纯函数优先：规则计算（显著性、门槛、节奏、闸门判断）写成纯函数，输入里显式带 `now`。
- 所有对外可调用的入口（工具参数、交账、界面命令）用 zod 校验，错误信息用中文、说清哪一项不对。
- 所有数值默认值集中在 `src/config/defaults.ts`，与 `docs/build-spec.md` 的默认值表逐项一致，可被 `Settings` 覆盖。
- 测试与实现同步写；每条规则至少一个正例一个反例；时间相关用注入的假时钟。

## 每张卡的工作流程

1. 完整读 `AGENTS.md`（本文件）、`docs/build-spec.md` 里卡片点名的章节、任务卡本身。
2. 实现 → 写测试 → 跑卡片「验收」一节的全部命令直到通过。
3. 写 `docs/progress/<卡号>.md`：做了什么（按文件列）、验收命令及输出摘要、与规格不一致的地方及理由、没做完的事。
4. 遇到规格没写清的：采用最保守、最简单的做法继续，并在 `docs/questions.md` 记一条（卡号、问题、你的默认、理由）。

## 完成的定义

卡片验收命令全部通过；类型检查零错误；没有 TODO/占位实现冒充完成；进度记录写好；没有越权改动。
