# M12 维护卡：堵住「中心替机器人跑命令」的沙箱逃逸（安全，最高优先）

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M12.md`、`docs/questions.md`（只追加）
- 不得修改：`packages/plugin/`、规格与任务卡
- 前置：M11 已合入主目录，本卡直接在主目录做。规格已由总控更新：7.4「run_command」与「总原则」两条、6.2「script」一条。以规格为准。

## 背景

总原则：**中心替机器人运行的任何东西，没有主人批准，权限不得超过机器人在 DSH 沙箱里的权限。**

现在有两处违反。中心跑在 DSH 宿主进程里，`ctx.exec.run` 不受 DSH 沙箱限制（沙箱只管机器人会话里的工具）：

1. **出站命令**（`gate/outbox.ts`）：`hub_outbox_submit` 的 run_command 按 7.1 命令规则分类。规则是按「命令跑在 DSH 沙箱里」写的，所以 `python3 work/x.py`（`gate/commands.ts` 的 internal_script）、`mkdir`、`cp`、`ls` 这些都是 A 类，不出审批，由中心直接运行。实测：试岗期 L1 机器人把脚本写进家目录再提交运行，3 条命令全部执行，审批单 0 张，违规 0 次，线程没有记录。脚本能改动这台电脑上的任何文件。
2. **脚本关注**（`perception/script.ts`）：主人接受一次之后，机器人可以随时改脚本内容，中心按间隔在沙箱外运行它。

## 要做

### 1. 出站命令一律要批准

- `actionFor` 里 run_command 的分类结果如果低于 C（A、B），提升为 C，`subclass: 'host_command'`，理由写「这条命令由中心在 DSH 沙箱外运行，要主人批准」。`protected`、`work_data`、D 类保持原判定和原处理。L0 按矩阵拒绝。
- 升级前已经存成 `ready`、没有 approvalId 的旧 run_command：`executeReadyOutbox` 必须走到「生成审批单、改成 pending_approval」，不能直接运行。写测试。
- `hub_outbox_submit` 的工具说明写清：run_command 由中心在沙箱外运行，一律要主人批准；家目录内的日常工作用自己的 bash 工具。工具 JSON Schema 规则（M06）不变。
- 审批卡（`gate/approvals.ts` 的人话描述）：run_command 的正文加一句给主人看的话：「这条命令在 DSH 沙箱之外运行，能改动这台电脑上的其他文件。看不懂就拒绝。」

### 2. 批准绑定文件内容

机器人可以在批准和执行之间改脚本，批准不能只绑定命令文字。

- 提交 run_command 时，`cmd` 和 `args` 里凡是解析到机器人家目录内已有普通文件的，记下路径和 sha256，存进 OutboxAction 的新字段（旧存档缺字段时按空处理，参照 M08 的兼容做法），并纳入批准票的内容指纹。
- 执行前重新计算。内容变了、文件不见了或读不出来：不运行，状态记 rejected，线程写「未执行你批准的：<动作>（原因：脚本在批准后被改动）」，批准票作废。复用 M10 第 10 条的文案结构。
- 内容相同的同一动作，批准后只执行一次（现有规则不变）。

### 3. 脚本关注在写入沙箱里运行

- `ExecOptions` 增加可选字段 `sandbox?: { writableRoots: string[] }`。`pollScript` 传 `{ writableRoots: [bot.homeDir] }`。出站命令不传（批准过的命令按主人批准的权限运行）。
- `SystemExec`：带 `sandbox` 时，在 macOS 上用 `/usr/bin/sandbox-exec -p <配置> <cmd> <args...>` 启动，配置与 DSH 的 Seatbelt 规则一致：`(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))(allow file-write* (subpath <根1>) (subpath <根2>) ...)`。根目录是 `writableRoots` 加系统临时目录，全部先取真实路径（macOS 的 `/tmp`、`/var/folders` 是符号链接，不取真实路径会全部写失败）。路径里的 `\` 和 `"` 要转义（DSH 的写法见 scratchpad/dsh-src/@deepseek-ai/dsh-sandbox-local/lib/index.js 的 sbplString）。进程组、超时、输出上限的处理不变。
- 不是 macOS，或 `sandbox-exec` 不存在、启动失败：不退回无沙箱运行，抛中文错误「当前系统没有可用的沙箱，脚本关注不运行」，按关注项失败处理（连续失败走现有告警）。
- `FakeExec` 记录 `sandbox` 参数，供断言。

## 测试（每条都要「改坏即失败」）

- 出站：试岗 L1、L2、L3 提交 `python3 work/x.py`、`node work/x.js`、`mkdir`、`cp`、`ls`：都生成审批单，批准前 `exec.calls` 为 0，批准后运行一次。L0 被拒绝。`protected` 与 `work_data` 仍是原来的拒绝。
- 旧 `ready` 记录走审批，批准前不运行。
- 内容绑定：批准后改脚本 → 不运行、状态 rejected、线程有原因；批准后不改 → 运行一次；脚本被删 → 不运行；相同命令、内容变了再提交 → 生成新的审批单；旧存档缺新字段能读。
- 审批卡含沙箱提醒；工具说明含「一律要主人批准」；M06 的工具 Schema 测试仍通过。
- 脚本关注：`exec.calls` 里带 `sandbox.writableRoots` 且包含 bot.homeDir。
- `SystemExec` 真实测试（只在 macOS 跑，其他系统跳过并说明）：带沙箱时，脚本能写 writableRoots 里的文件和系统临时目录，写其他位置失败（目标放在 `os.homedir()` 下的随机文件名，测试结束确认文件不存在并清理）；路径含空格和引号时规则仍生效；不带沙箱时行为和原来一样。
- 非 macOS 的失败关闭：用注入平台或可测试的工厂函数验证抛中文错误，不无沙箱运行。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；`docs/progress/M12.md` 按编号逐条写改法与测试名。
