# M06 维护卡：真实模型（GLM-5.3）沙箱测试暴露的问题

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M06.md`、`docs/questions.md`（只追加）
- 前置：M05 已合入主目录（本卡直接在主目录做）

## 背景

总控用主人的 GLM-5.3 在真实 DSH 沙箱里跑了一个盯守型机器人两个回合（任务：检查自己家目录里的 hello.txt，不在就创建）。两次都正确调用了 hub_commit，自我介绍自然。但暴露了以下问题（证据来自该机器人会话日志与中心存储）。

## 1【严重】hub_outbox_submit 的参数结构让模型只能生成空参数

会话日志：模型连续 6 次调用 `hub_outbox_submit`，`arguments` 都是 `"{}"`，每次报「kind：不是允许的取值或类型」。原因：该工具导出的 JSON Schema 根节点是 `oneOf`（按 kind 分支的联合），没有根级 `type: "object"` 与 `properties`。OpenAI 兼容的工具调用接口（GLM 经 pi-ai 走的就是它）要求参数根必须是对象并列出字段；根级 oneOf 时模型无从生成参数。

要做：
- `hub_outbox_submit` 的参数改为扁平对象：`{ kind: enum['notify_owner','write_file','http_post','run_command'], why: string, payload: object }`，其中 payload 声明为对象并列出所有可能字段（text、importance、path、content、url、body、headers、cmd、args、cwd），每个字段的 description 写清「仅 kind=… 时需要」；按 kind 的必填校验放在 zod 的 superRefine 里，错误信息中文并指出缺哪个字段。
- **所有** hub 工具导出的 JSON Schema 统一后处理：去掉 `$schema`；根节点必须是 `type: "object"` 且有 `properties`；根节点不得出现 oneOf/anyOf/allOf/not/if；不得出现 `$ref`/`$defs`（需要时内联）；`propertyNames` 去掉（用 additionalProperties 表达即可）。字段内部的 `anyOf`（可空字段）允许，但优先改成 `type: ["string","null"]` 这类写法或在 description 里说明可省略。
- 测试：遍历 `buildTools()` 的每个工具，断言上述规则；`hub_outbox_submit` 四种 kind 的正例与缺字段反例（错误文案中文）。

## 2【中】无害的只读命令因 `2>/dev/null` 被判成「写到家目录外」

会话里 `pwd; ls -la; cat hello.txt 2>/dev/null || echo "NO hello.txt"; date` 被判 C（写入家目录允许区域以外的文件）而要求审批。要做：重定向目标是 `/dev/null`、`/dev/stdout`、`/dev/stderr`、`/dev/tty`，以及 `2>&1`、`>&2`、`&>/dev/null` 这类文件描述符复制，不算写文件；测试覆盖这些写法，并保留「重定向到家目录外普通文件仍判 C/D」的反例。

## 3【中】写自己家目录根下的普通文件也要审批

`write {file_path: "hello.txt"}`（解析为 `<家目录>/hello.txt`）被判 C。规格 7.1 只列了 work/、memory/MEMORY.md、playbooks/、.agents/skills/、shared/ 为 A，家目录里其他非受保护位置落进了「其他」。改为：**家目录内除受保护文件（AGENTS.md、mind/、memory/journal/ 历史）外，一律按 A**（含 bash 的重定向与 cp/mv/mkdir/touch 等写操作）。规格同步改（总控会改 build-spec）。测试：家目录根下新建/修改文件 → A；受保护文件 → protected；家目录外 → C/D 不变。

## 4【低】交账里 report 为 null 时，线程出现内容为 "null" 的汇报消息

线程日志里有两条 `kind=report, text="null"`。要做：reply/report 为空、null、仅空白时不发线程消息；排查其他把 null 转成字符串 "null" 的地方（视图文案、日报、收件箱正文）。测试。

## 5【低】唤醒包对 L1 机器人的说明

真实模型在 L1（试岗）下把目标、关注都提交成「提议」是对的，但它在 reply 里说「已设好每日巡检议程、目标与文件关注」，主人会误以为已生效。唤醒包「规矩」一节增加一句（按自主等级渲染）：「你现在是 L1：新目标与新关注只能提议，主人同意前不生效，向主人汇报时要说『已提议』而不是『已设好』。」测试断言 L1/L2 的文案差异。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；`docs/progress/M06.md` 逐条写改法与测试名。
