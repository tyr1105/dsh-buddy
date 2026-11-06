# M02 维护卡：C02、C03 独立验收发现的问题 + 一条安全加固

- 负责方：Codex
- 允许修改：`packages/core/src`、`packages/core/test`、`docs/progress/M02.md`、`docs/questions.md`（只追加）
- 前置：C04 已完成（本卡修完后，C04 的仿真与场景测试必须仍然全部通过，并按需要补场景）
- 每条问题的完整说明、复现脚本路径与修法建议在 `docs/reviews/C02-review.json`（`confirmed[编号]`）与 `docs/reviews/C03-review.json`。复现脚本在 `/private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/review-C02/`、`review-C03/`（可读，不要改）。修完后用你自己写的测试证明，不要依赖这些脚本。

## 第一部分：C02（编号对应 C02-review.json 的 confirmed 下标；重复项已合并）

### 严重
- [0][6] 额度校准把 tokenLimit 设成 0 → 红灯永久不解除、探针不再发放、连主人消息都被拦（违反第 5、13 节）。要做：tokenLimit 校准设下限（报错时窗口 token 为 0 就保留原值，或至少一个回合的估算量）；任何「判定用尽」的路径都必须同时设 redUntil，不能出现 redUntil=null 的红灯；maybeAllowProbe 区分「探针在途」与「无探针的红灯」。测试：tokenLimit=0 后滚窗、探针成功后再记账、探针失败后再成功，三种情况都能恢复。

### 中
- [1][8] next_think（与 light_check）候选共用固定主体键，被 6 小时冷却拦住，机器人自定节奏失效并误报死人开关（违反第 6.5 节与 T3）。要做：每次预约用唯一主体（例如 `next_think:<botId>:<nextThinkAt>`），或在第 4 闸豁免 next_think 与 light_check。测试：两次 next_think 间隔小于 6 小时也按 pace_min 放行；不产生死人开关告警。
- [2] 每次额度报错都重新校准，探针窗口内再报错会把上限压到不足一个回合。要做：只在「首次」（或距上次校准超过一个窗口时）校准；探针失败不校准，只再等一个窗口（第 13 节）。
- [7] classifyError 对 429/401/403 做无边界子串匹配，普通报错（如含「4290 行」「id 401xxx」）被判成额度/鉴权。要做：数字状态码只在词边界或「status 429」「HTTP 429」「code: 401」这类上下文匹配；补中英文正反例各 ≥ 5 个。
- [9] 到期的 toOwner 议程被标为 urgent，绕过冷却与 pace_min，同一件事连续放行直到预算用完。要做：urgent 只来自显著性 ≥ 0.90 的感知（第 5 节分档）；议程到期按其分数入队但不标 urgent；同一议程项处理后（交账 progress/no_change）若未关闭，下次触发至少间隔有效 pace_min。
- [10] 队列合并后 reason 与 subjectKey 被新候选替换，第 3 道闸按新 reason 整条丢弃，合并进来的主人回复也丢了。要做：合并时保留「最高优先级来源」的 subjectKey 与 reason，主人消息/提问回复永不被降级或丢弃；第 3 道闸只在条目里没有任何 owner_message/inbox_reply 证据时才丢弃。测试。
- [11] 回合进行中意图时钟重复产出 light_check/next_think，交账后陈旧的队列项仍被放行，冻结世界 24 小时出现 2 次轻复查（违反 T1）。要做：机器人有 running/delivering 唤醒单时不产出时间类候选；交账后清掉该机器人队列里早于交账的 light_check/next_think 条目（因为交账已重设 nextThink 与 lightCheckAt）。补一个 T1 场景：带一次真实交账的 24 小时冻结世界 ≤ 1 次。
- [12] http 关注项拿截到 4 KB 的基线与完整新正文做差异，页面超过 4 KB 时 summary/magnitude 出错并误触发。要做：基线只存完整正文的 sha1 与最多 200 行的行哈希集合（不存截断正文），差异按行哈希集合计算；超过 200 行的页面 magnitude 用「变化的行哈希数 / 总行数」近似。
- [13] 目录关注项的 sizes 基线超过 4 KB 会淘汰路径，重启补扫把没变的文件报成「新建」。要做：基线不放进 lastValue 的 4 KB 字段，改存独立表或单独文件（`<rootDir>/.hub/state/watch-baselines/<watchId>.json`），条目上限 2000，超出时只做计数比较并在 summary 写明「文件太多，只比较数量」。
- [14] 单文件 file/log 关注项直接监听文件本身，轮转或原子替换后监听失效且不重新注册。要做：一律监听所在目录（非递归）并按文件名过滤；每次 tick 的 syncFileWatches 若发现目标 inode/mtime 与上次不同且没收到事件，主动补一次检查。
- [15] 截止前 2 分钟内写出的日志被误报期望落空（满足要等去抖 flush 才记账）。要做：checkExpectations 先看该关注项的待处理批次，有就视为已满足（或先 flush 该批次再判断）。
- [16] 正则 filter 在宿主进程同步匹配外部内容，可能灾难性回溯卡死 DSH。要做：filter 只支持「关键词」与「受限正则」：创建时拒绝含嵌套量词（如 `(a+)+`、`(.*)*`）、反向引用、超过 200 字符的正则；匹配前把待匹配文本截到 64 KB；匹配超时无法在 JS 里打断，所以拒绝策略必须在创建时做。测试。
- [17] delivering 唤醒单没有超时出口，孤儿单让机器人永久被并发闸拦住。要做：delivering 超过 2 分钟没有 started 事件 → 视为投递失败（error，按重排处理）；死人开关也要覆盖这种状态。
- [18] 主人解除隔离后，checkQuarantine 仍按旧唤醒单历史判断「连续 3 次出错」，再错 1 次就被重新隔离。要做：以 bot.consecutiveErrors 等计数为准，解除隔离时记录 releasedAt，历史只看 releasedAt 之后。
- [23] 只有 log 关注项会写 lastSatisfiedAt，带 expectation 的 file/http/rss/script 关注项永远满足不了。要做：所有类型产生变化感知（或 script 成功运行且输出符合）时都标记满足。
- [24][4] 显著性恰好等于 0.90 被浮点误差降档。要做：分数统一四舍五入到 4 位小数后再比较分档；测试用会产生浮点误差的组合（如 0.25×0.8+0.20×1+…）。
- [25] 第一个额度窗口过期后，空闲 tick 就建立新窗口。要做：窗口只在机器人回合开始时建立（第 13 节「从第一次机器人回合开始计 5 小时」），过期后到下一次回合才开新窗口。

### 低
- [3] 补课候选优先级可能变成 70，规格是 30。修正优先级计算。
- [5][19] 红灯把全体 activity 改成 resting，恢复时一律改回 watching，丢失 waiting_owner/blocked/quarantined 等。要做：红灯只改 activity 为 watching/queued 的机器人，并记住原值；恢复时还原。
- [20] 补课候选的证据收不到启动补扫产生的汇总感知。修正时间范围。
- [21] enqueue 每次合并都写一条 queued 日志，闸门拦住期间每分钟一条。要做：同一条目在 10 分钟内只写一次 queued 日志。
- [22] syncFileWatches 先查后 await，两次重叠会注册两个监听器。要做：用进行中标记或「先占位再 await」。
- 测试补齐：[26] script 白名单三道显式拒绝各自的反例；[27] 补课候选入队（低于门槛的豁免）；[28] 感知落表的 tier 与评估日志的 decision；[29] 出错重排的升级梯度与抖动 ±20% 两侧；[30] 关注项「连续 3 次失败才发 P2」的反例；[31] 选取顺序、闸门顺序、until、日志限频按机器人区分；[32] 「为什么醒/没醒」中文解释文本的断言（每种 decision/suppressedBy 至少一条）；[33] 期望落空同日只报一次要用不同指纹的两次落空来测。

## 第二部分：C03（编号对应 `docs/reviews/C03-review.json` 的 confirmed 下标）

### A. 动作闸加固（最重要，按原则重写而不是逐条打补丁）

现状的命令分类器「认不出就当安全」，审查用十几种写法绕过了它。DSH 沙箱只拦「写到会话目录以外」，不拦读和联网，所以「读敏感数据」「联网对外写」「对外发布」只能靠这里。按以下原则重写 `src/gate/`（可以拆文件），并保留第 7.1 节的分类结果语义：

1. **白名单定 A**：只有「明确列出的只读程序 + 明确安全的参数」才是 A。每个只读程序给出允许的选项集合；出现未知选项、未知写法、无法解析 → 至少 C。curl/wget 只有在：协议 http/https、方法 GET（无 -X/--request 非 GET、无 -d/-F/-T/--data*/--upload*/--json）、**没有任何把内容写到文件的选项**（-o/-O/--output*/--remote-name*/--output-dir/-D/--dump-header/--stderr/--libcurl/--etag-save/--hsts/--cookie-jar/-c 等，包括组合短选项如 -sSLo、-LO、-OJ）时才是 A；其余 C。find 只有不含 -exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls 时才是 A。
2. **包装一律剥开递归**：sudo、doas、env（含 `VAR=val` 前缀与 env 的选项）、xargs、timeout、nohup、nice、time、command、builtin、exec、caffeinate、script、watch、`bash/sh/zsh/dash/ksh -c`（含 -lc、-ic、--norc 等组合；-c 之后的**第一个操作数**才是脚本）、`npm/pnpm/npx/yarn exec|x|dlx|create`、`find -exec ...`、`git -c ...`、`python -c`/`node -e`/`ruby -e`/`perl -e`（内联代码一律 C）：把被包装的命令递归交给分类器，取最危险结果；递归深度超过 4 → C。sudo/doas 本身至少 D。
3. **npm/pnpm/yarn 子命令白名单**：只有 install/i/ci/add/remove/run/run-script/test/build/exec 已剥开后的结果、list/ls/outdated/why 在家目录 work/ 下为 A；publish/unpublish/deprecate/owner/access/dist-tag/login/logout/adduser/token/config set/link/cache clean/-g/--global/--prefix 到家目录外 → C（publish/unpublish → D）。
4. **路径规范化**：所有路径参数（含重定向目标 `>` `>>` `>|` `>&` `&>` `<`、`--output=…`、`file://` URL、`-C dir`、`--git-dir`、`--work-tree`）先展开 `~`、`~user`（一律视为家目录外）、`$HOME`/`${HOME}`/`$DSH_HOME`（视同 `~/.dsh`）、相对路径（按命令的 cwd，缺省为机器人家目录）、`..`，再**统一转小写**后与受保护路径、工作数据路径、敏感路径、家目录边界比较（macOS 文件系统默认不区分大小写）。含其他未知变量（`$X`、`${X}`、`$(…)`、反引号）的路径 → C。GateContext 增加由宿主提供的 `ownerHome`（主人家目录）。
5. **受保护与工作数据**：工作数据路径的「祖先目录递归读取」（如 `grep -r x ~/`、`rg x /Users/owner`、`find / -name …`）也算读工作数据；web_fetch/读工具的 `file://` 视同读该路径。
6. **D 类识别**：支付/下单/转账类 API 用 URL 路径片段子串匹配（pay、payment、payments、checkout、charge、charges、order、orders、purchase、transfer、transfers、withdraw、refund、invoice、subscription，大小写不敏感）→ D；`git push` 带 -f/--force/--force-with-lease/--delete/-d/`:refspec`/`+refspec` → D；`aws|gcloud|az … delete*|remove*|terminate*`、`gh repo delete`、`kubectl delete` → D；rm/rmdir/unlink/shred/truncate 目标在家目录外 → D。
7. **git commit/push 的边界**：判断仓库位置要看 `.git` 是文件（gitdir: 指向）的情况：读出 gitdir 实际位置（FsIO.readText），在家目录外 → C。
8. **出站审批卡片**：显示中心判定的类别与原因（例如「D 类：git 强推，不可逆」）、完整命令（超过 1 KB 时显示首尾各 400 字并标明中间省略，不能把危险尾部藏在截断之后）。
9. **复盘回合**（[4]）：只读的意思是「不改中心状态与对外」，不是禁止写 work/；复盘里写 work/、MEMORY.md、playbooks/ 按普通规则，不计越界。
10. 测试：为 [0][1][2][3][14][15][16][17][18][20][34][35][36][37][39] 的每一种绕过写法各写一条反例测试（审查文件里有完整清单），外加白名单正例；目标是「删掉任何一条判断，至少一个测试失败」。

### B. 宿主侧文件操作的符号链接（[19]）

中心以宿主权限执行的复制（交接单）与出站写文件，要先 `realpath` 源与目标（FsIO 增加 `realpath(path)`；SystemFs 用 fs.realpath，MemoryFs 原样返回）再做边界判断；源是指向边界外的符号链接 → 拒绝。

### C. 唤醒包与围栏

- [5][22] 总管「团队现在」里来自同伴或不可信摘要的文字一律进不可信围栏，并转义 `untrusted>>>`。
- [12][23] 主人原话（owner_message、主人对提问/提议的回答）是**可信**的：放在「主人对你说」节，带规格第 9 节的授权说明，不放进不可信围栏。
- [7] 审批结果唤醒包：approved 写「主人已批准，用完全相同的参数再调用一次」；used 写「已执行过」；rejected/expired 写「不要执行」。出站动作（hub_outbox_submit）批准后由中心执行，唤醒包写「中心已执行，结果是…」，不要再让机器人调用。

### D. 调度与回合

- [24] 提问沿用唤醒单的通用 subjectKey，导致之后所有 next_think 被 T7 丢弃。要做：提问的 subjectKey 用它自己的（`question:<inboxId>`），T7 只拦同一个提问主体；配合第一部分 [1][8] 的唯一 next_think 主体。
- [26] 已交账但宿主 ended 未到的回合仍被 steer 并在宽限后取消。要做：收到 hub_commit 后该唤醒单不再检查上限，只等 ended；ended 迟迟不来（10 分钟）就直接视为 committed 结束，不计错误。
- [8] 教学与试跑回合用规格的 30 步 / 20 分钟 / 6 万上限。

### E. 工具与议程

- [6][25] 防「拼周期」：同一回合内续建 review、以及对 open 的 review 反复改 dueAt，都要受「间隔 × 2」约束（按「同一标题最近两次 dueAt 的间隔」计算）。
- [11] L1 提议额度用完时如实回复「本周提议额度已用完，已记进点子池」。
- [33] L2 改目标：不能复活 abandoned/done，不能把 done_pending_check 改回 active，不能改写 createdBy；违规返回中文错误。
- [28] 关注过滤正则：与第一部分 [16] 同一修法（创建与修改时都校验）。

### F. 找主人与记忆

- [10][30] @名字 用完整名字匹配（名字后面是空白、标点或结尾），名字互为前缀时取最长匹配；只点名不在岗的机器人时，线程里回一条系统说明并按兜底规则投递。
- [13][32] digestAt 落在免打扰内（含跨午夜）时：到点生成并写进团队线程，推送顺延到免打扰结束。
- [9][31] mind/*.md 的「今天/明天」按渲染时刻（now）计算；渲染时只放未关闭的议程/目标/关注与最近 7 天关闭的，大小遵守第 5 节上限。
- [27] 刷新 mind 视图时审计只记文件名与哈希，不记全文。

### G. 测试补强

[38] 交接复制范围要用「文件存在但在边界外」来测；[39] 每个命令类别至少一条只命中它的测试；[40] 唤醒包各变体的关键段落、6 KB 截断顺序逐节断言；[41] 回合守卫的 cancel、按错误处理、expectedBy、移出队列；[42] report 单推门槛、目标 lastProgressAt、受挫判断；[43] 「全部等级」的工具在 L0 下的行为、议程 30 条上限与复查加倍的反例；[44] hub_commit 各上限的边界正例。

## 第三部分：安全加固（来自 DSH 机制调研）

DSH 的沙箱只拦「写」，不拦「读」和「联网」（verified-T4 2d、4a）。机器人在 bash 里 `cat ~/.dsh/.credentials.yaml` 或用读文件工具读凭据，沙箱都不管。要做（`src/gate/classify.ts`）：
- 敏感路径一律 protected（拒绝并计越界），无论读写、无论哪个工具或命令参数：`~/.dsh/`（整个目录）、`~/.ssh/`、`~/.aws/`、`~/.config/gcloud/`、`~/.codex/auth.json`、`~/.claude/`、`~/.netrc`、`~/Library/Keychains/`、`~/Library/Application Support/Google/Chrome/`、任何 `.env` / `.env.*` 文件、`*.pem`、`*.key`、`id_rsa*`、`credentials*.json|yaml`。路径先展开 `~`、环境变量（`$HOME`、`${HOME}`）、相对路径（按机器人家目录解析）再判断；命令里的 `cat`/`less`/`head`/`tail`/`cp`/`grep`/`base64`/`xxd`/`open` 等任何引用这些路径的参数都算。
- `env`、`printenv`、`set`（无参数）这类会输出环境变量的命令 → C（审批）。
- 机器人在 bash 里能看到 `DSH_HOME`，用 `$DSH_HOME` 拼出的路径同样要识别（把 `$DSH_HOME` 视同 `~/.dsh`）。
- 测试：每条敏感路径至少一个读文件工具用例与一个 bash 用例；变量与相对路径绕过的反例（`cat $HOME/.ssh/id_rsa`、`cd ~ && cat .dsh/.credentials.yaml`、`cat ../../../.dsh/x`）。

## 验收

```bash
pnpm --filter @agent-hub/core typecheck
pnpm --filter @agent-hub/core test
pnpm --filter @agent-hub/core build:check
grep -rnE "Date\.now\(|new Date\(\)|setTimeout|setInterval|Math\.random" packages/core/src --include=*.ts | grep -v "src/io/system-"
```

全部通过、最后一条无输出；C04 的 18 个场景测试仍全部通过（如因修复改变了数值区间，在进度里写明理由）。`docs/progress/M02.md` 按编号逐条写：怎么修的、新增测试名、修后的行为证据。
