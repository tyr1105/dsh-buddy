# M05 维护卡：动作闸认识 DSH 真实的工具名

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M05.md`、`docs/questions.md`（只追加）
- 前置：M04 已完成

## 问题

`src/gate/classify.ts` 的 `TOOL_SHAPES` 是按常见命名猜的。总控在真实 DSH 沙箱里看到，机器人会话实际可见的工具是：`bash, edit, glob, grep, job_kill, job_list, job_output, present, read, read_image, skill, subagent, todo_write, web_fetch, web_search, write` 加 15 个 `hub_*`。其中 `glob`、`grep`、`read_image`、`present`、`todo_write`、`skill`、`job_list`、`job_output`、`job_kill` 不在表里，会被判「未知工具需要主人审批」，机器人每搜一次文件、记一条待办都要等主人批准，没法干活。

DSH 的真实参数（来自 DSH 源码 `dsh-tool-fs`、`dsh-tool-fs-search`、`dsh-tool-bash-persistent`、`dsh-tool-todo`、`dsh-tool-present`、`dsh-tool-skill`、`dsh-tool-jobs`）：

- `read {file_path, offset?, limit?}`、`read_image {file_path}`、`write {file_path, content}`、`edit {file_path, old_string, new_string, replace_all?}`
- `glob {pattern, path?}`：path 缺省为会话工作区（机器人家目录），相对路径按它解析；pattern 不含 `/` 时匹配任意深度的文件名，**本质是递归读取**
- `grep {pattern (正则), path?, include?}`：同上，递归搜索内容
- `bash {command}`
- `present {files: [{path, description?}]}`：把已有文件展示给主人（读取并展示）
- `todo_write {todos: [...]}`、`skill {name}`、`job_list {}`、`job_output {job_id, wait?, timeout_ms?}`、`job_kill {job_id, reason?}`：只作用于本会话自己的清单、技能与后台任务

## 要做

1. `TOOL_SHAPES` 增加：
   - read 类：`read_image`（file_path）；`glob`、`grep`（path，缺省为 cwd；视为**递归读取**，套用 M02 的「递归读取工作数据祖先也算读工作数据」规则；`glob` 的 pattern 若含 `/` 或 `..`，与 path 拼接后一并按路径规则判断）；`present`（逐个取 `files[].path` 按读取判断）。
   - 内部工具（A，不需要审批，L0 也允许）：`todo_write`、`skill`、`job_list`、`job_output`、`job_kill`。
   - 保持：`read`/`write`/`edit` 用 `file_path`（已在 pathArgs 里，加测试确认）、`bash` 用 `command`。
2. 自主等级矩阵：读类 A 在 L0 也允许（只观察就是读）；写类按现有规则。
3. 测试（每条既有正例也有反例）：
   - `glob {pattern:'**/*.md'}`（无 path）→ A；`glob {pattern:'*', path:'~'}` 在配置了工作数据目录时 → work_data；`glob {pattern:'../../.ssh/*'}` → protected；`grep {pattern:'TODO', path:'work'}` → A；`grep {pattern:'key', path:'~/.dsh'}` → protected；
   - `read_image {file_path:'work/a.png'}` → A；`present {files:[{path:'work/report.md'}]}` → A；`present {files:[{path:'~/.ssh/id_rsa'}]}` → protected；
   - `todo_write`、`skill`、`job_list`、`job_output`、`job_kill` → A（L0 下也放行）；
   - `read {file_path:'~/.dsh/.credentials.yaml'}` → protected；`write {file_path:'work/x.txt'}` → A；`edit {file_path:'AGENTS.md'}`（家目录内）→ protected。
4. 仿真里加一个场景：大脑依次调用 glob、grep、read、todo_write、write(work/)、bash `ls`，全部放行、没有生成任何审批单。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；`docs/progress/M05.md` 写清改动与测试名。
