/**
 * fake-job-plan.mjs —— 假模型的「执行者」「评审员」「发布这一步」剧本（P74j）。
 *
 * 它是做什么的：
 *   第一级真实模型验证每次只让一个角色走真实模型，其余角色走本机假模型（不花额度、行为可预测）。
 *   本文件让假模型能当一件事的「执行者」「评审员」，并走完「发布这一步」：
 *   只读唤醒包里「你手上的事（中心维护）」那一段的文字，调用 hub_job_work、hub_outbox_submit 等工具。
 *   行为由环境变量 FAKE_JOB_PLAN 控制（取值见 parsePlan 的注释）。
 *
 * 为什么单独一个文件：
 *   scripts/dev/fake-model-cards.mjs 被 import 时会启动一个服务，测试没法引用它里面的函数。
 *   这里只放「纯函数」：不启动任何服务、不读写文件，只按入参算出下一步动作，测试可以直接 import。
 *   fake-model-cards.mjs 只在 decide() 开头调用 jobAction，返回 null 时走它原有的逻辑。
 *
 * 唤醒包的句子取自 core 的渲染函数（packages/core/src/wake/job-section.ts、job-section-launch.ts）。
 * packages/core/test/p74j-packet-samples.test.ts 用真实的中心生成各种样例并断言这些句子，
 * core 改了句子，那个测试先失败，提醒同步修改这里。
 *
 * 安全：不读任何凭据；写的文件只在员工自己的家目录 work/ 下；发布命令只是 echo。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 「你手上的事」段的标题（与 core 的 JOB_SECTION_TITLE 一致）。 */
export const SECTION_TITLE = '## 你手上的事（中心维护）'

/** 闸认的命令行工具名（同 fake-model-cards.mjs 的 SHELL_TOOL_NAMES）。 */
const SHELL_TOOL_NAMES = ['exec', 'shell', 'bash', 'run_command', 'exec_command']
/** 命令参数名的优先级（同 core 的 selectedCommand：command、cmd、script）。 */
const COMMAND_ARG_NAMES = ['command', 'cmd', 'script']

/** 名额上限（页面里写死，与约定里的「名额 80」对应）。 */
const QUOTA = 80
/** 手机号提示文字：正常和 wrong_text 两种。 */
export const GOOD_PROMPT = '请填写 11 位手机号'
export const WRONG_PROMPT = '手机号格式不正确'

/** 一张 1x1 PNG 的 base64（与 core 测试夹具里的 PNG 相同，是合法文件）。 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
/** 截图文件的全部字节（常量数组）；前 8 个字节是 PNG 文件头 137 80 78 71 13 10 26 10。 */
export const PNG_BYTES = Object.freeze(Array.from(Buffer.from(PNG_BASE64, 'base64')))

// ---------------------------------------------------------------------------
// 开关与进度
// ---------------------------------------------------------------------------

/** 允许的 FAKE_JOB_PLAN 取值。 */
export const PLAN_VALUES = ['wait_material', 'ask_once', 'wrong_text', 'review_fail_once', 'review_fail_always']

/**
 * 解析环境变量 FAKE_JOB_PLAN（逗号分隔）。取值：
 *   wait_material       执行者在「执行中」且「材料」那一行没有材料文件夹时先交账等材料（最多 4 个回合）
 *   ask_once            执行者在这件事里第一次做产出物之前先问总管一次
 *   wrong_text          执行者第一次交回的页面里手机号提示写成「手机号格式不正确」，返工时改对
 *   review_fail_once    评审员在这件事的第一次核对里判一条不符，之后都通过
 *   review_fail_always  评审员每一次普通核对都判同一条不符；主人选办法之后的重新核对一律通过
 * 不认识的取值忽略。没有设置：不等材料、不提问、页面文字正确、核对一律通过。
 */
export function parsePlan(value) {
  const set = new Set()
  for (const part of String(value ?? '').split(',')) {
    const name = part.trim()
    if (PLAN_VALUES.includes(name)) set.add(name)
  }
  return set
}

/** 进程内存里的进度，按 jobId 区分；假模型进程重启后清零。 */
export function createJobMemory() {
  return {
    waits: new Map(), // jobId -> 已经等了几个回合
    asked: new Set(), // 已经问过总管的 jobId
    reviews: new Map(), // jobId -> 已经核对过几次
    submitted: new Set(), // 已经提交过发布审批的 jobId
  }
}

// ---------------------------------------------------------------------------
// 读唤醒包
// ---------------------------------------------------------------------------

/** 这一回合的唤醒正文：最后一条带文字的 user 消息（同 fake-model-cards.mjs 的 latestPacket）。 */
export function latestPacketOf(messages) {
  for (const message of [...(messages ?? [])].reverse()) {
    if (message?.role !== 'user') continue
    const text = (Array.isArray(message.content) ? message.content : [])
      .map(block => (block?.type === 'text' ? String(block.text ?? '') : ''))
      .join('\n')
    if (text.trim() !== '') return text
  }
  return ''
}

/**
 * 取出「你手上的事」段：从标题行之后，到下一个以空行加「## 」开头的标题之前。
 * 没有这一段返回 null。只看这一段，别处的文字（主题楼层等）不参与识别。
 */
export function jobSectionOf(packet) {
  const start = String(packet ?? '').indexOf(SECTION_TITLE)
  if (start < 0) return null
  const rest = packet.slice(start + SECTION_TITLE.length)
  const next = rest.search(/\n\n## /)
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

/**
 * 识别这一段属于哪个剧本；按固定顺序判断，命中第一个：
 *   发布已批准 -> 发布在等批准 -> 发布准备中 -> 核对人 -> 执行者。
 * 都不命中（包括段里是没有 jobId 的一览）返回 null，由调用方走原有逻辑。
 * 返回 { role: 'launch'|'reviewer'|'executor', phase, jobId, section }。
 */
export function identifyJob(packet) {
  const section = jobSectionOf(packet)
  if (section === null) return null
  const jobIdOf = line => /jobId 为 (job_[A-Za-z0-9]+)/.exec(line)?.[1] ?? null
  const lineWith = text => section.split('\n').find(line => line.includes(text)) ?? null
  const pick = (text, role, phase) => {
    const line = lineWith(text)
    const jobId = line === null ? null : jobIdOf(line)
    return jobId === null ? null : { role, phase, jobId, section }
  }
  return pick('的发布申请主人已批准。', 'launch', 'approved')
    ?? pick('的发布申请在等主人批准。', 'launch', 'waiting')
    ?? pick('主人已验收。下一步是对外发布，必须先经主人批准。', 'launch', 'prepare')
    ?? pick('」的核对人（jobId 为 ', 'reviewer', 'review')
    ?? pick('」的执行者（jobId 为 ', 'executor', 'work')
}

/** 执行者段里的值：编号、放文件的路径、条目、返工序号、材料、暂停等。 */
export function parseExecutorSection(section) {
  const lines = section.split('\n')
  const items = []
  const start = lines.findIndex(line => line.startsWith('怎样算做完（交回时逐条对应，no 写序号）：'))
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const row = /^(\d+)\. (.+)$/.exec(line)
      if (row === null) break
      items.push({ no: Number(row[1]), text: row[2], atDelivery: row[2].includes('（交付时核对：') })
    }
  }
  const reworkLine = lines.find(line => line.startsWith('这一轮要改的条目：')) ?? ''
  const reworkNos = [...reworkLine.matchAll(/第 (\d+) 条：问题：/g)].map(match => Number(match[1]))
  const materialLine = lines.find(line => line.startsWith('材料（只读）：')) ?? ''
  const pause = /约定第 (\d+) 版在等主人确认：暂停/.exec(section) ?? /约定第 (\d+) 版写明这件事不再做，在等主人确认/.exec(section)
  return {
    jobId: /jobId 为 (job_[A-Za-z0-9]+)/.exec(section)?.[1] ?? null,
    projectId: /参数 project 填 (prj_[A-Za-z0-9]+)/.exec(section)?.[1] ?? null,
    folder: /to 写 (\S+?)\/交付\/文件名/.exec(section)?.[1] ?? null,
    state: /现在：([^，。]+)/.exec(section)?.[1] ?? '',
    items,
    reworkNos,
    hasMaterialFolder: materialLine.includes('材料文件夹'),
    pauseVersion: pause === null ? null : Number(pause[1]),
  }
}

/**
 * 核对人段里的值：交回的条目（序号、原文、自查）、第几轮、重新核对要写的序号、有没有交回。
 * 条目格式：一行「{no}. {原文}」，紧接一行「自查：…」；「证据 …」行跳过；到「产出物：」结束。
 * kind：carried 沿用、at_delivery 交付时核对、other 其余。
 */
export function parseReviewerSection(section) {
  const lines = section.split('\n')
  const items = []
  const start = lines.findIndex(line => /的交回（.*）：$/.test(line))
  if (start >= 0) {
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.startsWith('产出物：') || line.startsWith('核对规则：')) break
      const row = /^(\d+)\. (.+)$/.exec(line)
      if (row === null) continue
      const self = /^自查：(.*)$/.exec(lines[index + 1] ?? '')?.[1] ?? ''
      const kind = self.startsWith('沿用第') ? 'carried' : self === '交付时核对' ? 'at_delivery' : 'other'
      items.push({ no: Number(row[1]), text: row[2], self, kind })
    }
  }
  const recheck = /这一轮是主人选了办法之后的重新核对：只需要给第 ([\d、]+) 条写结论/.exec(section)
  return {
    jobId: /jobId 为 (job_[A-Za-z0-9]+)/.exec(section)?.[1] ?? null,
    round: Number(/这是第 \d+ 阶段第 (\d+) 轮核对/.exec(section)?.[1] ?? 1),
    items,
    recheckNos: recheck === null ? null : recheck[1].split('、').filter(Boolean).map(Number),
    notSubmitted: section.includes('还没有交回，暂时没有可核对的内容。'),
  }
}

/**
 * 发布准备时要写进审批的执行目录（必须是绝对路径）：
 *   第一级压缩起，段里有「下面的路径都相对于主题文件夹 {绝对路径}」，直接取它；
 *   第零级，从「产出物：{主题文件夹}/交付/…」去掉 /交付/ 及其后部分；
 *   都取不到用 /tmp。
 */
export function launchCwdOf(section) {
  const relative = /下面的路径都相对于主题文件夹 (\S+)/.exec(section)?.[1]
  if (relative !== undefined && relative.startsWith('/')) return relative
  const line = section.split('\n').find(row => row.startsWith('产出物：')) ?? ''
  const absolute = /^产出物：(\/\S*?)\/交付\//.exec(line)?.[1]
  return absolute ?? '/tmp'
}

// ---------------------------------------------------------------------------
// 这一回合已经调用过的工具（从对话历史里读，让每一步都不依赖内存状态）
// ---------------------------------------------------------------------------

/** 工具结果是不是错误：is_error 为真，或文字以 Error、错误 开头。 */
function resultIsError(block) {
  if (block?.is_error === true) return true
  return /^\s*(Error|错误)/i.test(resultTextOf(block))
}

/** 工具结果的文字（内容可能是字符串，也可能是文字块数组）。 */
export function resultTextOf(block) {
  const raw = block?.content
  const text = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw.map(c => c?.text ?? '').join('\n') : '')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 这一回合（最新唤醒正文之后）调用过的工具：[{ name, input, result: { isError, text } | null }]。
 * 最新唤醒正文所在的那条 user 消息里拼着的 tool_result 属于上一回合，不算。
 */
export function turnCalls(messages) {
  const msgs = messages ?? []
  let start = -1
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const blocks = Array.isArray(msgs[i]?.content) ? msgs[i].content : []
    if (msgs[i]?.role === 'user' && blocks.some(b => b?.type === 'text' && String(b.text ?? '').trim() !== '')) { start = i; break }
  }
  const calls = []
  const byId = new Map()
  for (const message of msgs.slice(start + 1)) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'tool_use') {
        const call = { name: block.name, input: block.input ?? {}, result: null }
        calls.push(call)
        if (block.id) byId.set(block.id, call)
      } else if (block?.type === 'tool_result' && byId.has(block.tool_use_id)) {
        byId.get(block.tool_use_id).result = { isError: resultIsError(block), text: resultTextOf(block) }
      }
    }
  }
  return calls
}

// ---------------------------------------------------------------------------
// 产出物：页面与截图
// ---------------------------------------------------------------------------

/**
 * 页面 HTML：一个能用的单文件网页，不引用任何外部资源（避免真实评审员因页面残缺判多条不符）。
 * 功能：姓名（必填）、手机号、公司名（选填）、提交；手机号不是 11 位数字时显示提示文字 promptText；
 * 同一手机号再次提交提示「这个手机号已经报过名」；名额 80，显示剩余名额，报满显示「名额已满」并禁用提交；
 * 成功显示「报名成功」；「导出报名名单」导出 CSV；数据存在浏览器本地存储里。
 * 全文不出现 ASCII 单引号，才能放进 printf '%s' '…' 里；字符串一律用双引号，引号与换行用 String.fromCharCode 生成。
 * 用 String.raw，页面脚本里的反斜杠原样保留。
 */
export function pageHtml(promptText) {
  return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>活动报名</title>
<style>
body { font-family: sans-serif; max-width: 420px; margin: 24px auto; padding: 0 16px; }
label { display: block; margin: 12px 0; }
input { display: block; width: 100%; box-sizing: border-box; padding: 8px; margin-top: 4px; }
button { padding: 8px 16px; margin-top: 8px; }
#hint { color: #b00020; min-height: 1.5em; }
</style>
</head>
<body>
<h1>活动报名</h1>
<form id="form">
<label>姓名（必填）<input id="name" type="text" required></label>
<label>手机号<input id="phone" type="tel"></label>
<label>公司名（选填）<input id="company" type="text"></label>
<button id="submit" type="submit">提交</button>
</form>
<p id="hint" role="alert"></p>
<p id="quota"></p>
<button id="export" type="button">导出报名名单</button>
<script>
var LIMIT = ${QUOTA};
var KEY = "signups";
var BAD_PHONE = "${promptText}";
function load() { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; } }
function save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { } }
function render() {
  var left = LIMIT - load().length;
  document.getElementById("quota").textContent = left <= 0 ? "名额已满" : "剩余名额：" + left;
  document.getElementById("submit").disabled = left <= 0;
}
document.getElementById("form").addEventListener("submit", function (event) {
  event.preventDefault();
  var hint = document.getElementById("hint");
  hint.textContent = "";
  var name = document.getElementById("name").value.trim();
  var phone = document.getElementById("phone").value.trim();
  var company = document.getElementById("company").value.trim();
  var list = load();
  if (list.length >= LIMIT) { render(); return; }
  if (name === "") { hint.textContent = "请填写姓名"; return; }
  if (!/^[0-9]{11}$/.test(phone)) { hint.textContent = BAD_PHONE; return; }
  if (list.some(function (row) { return row.phone === phone; })) { hint.textContent = "这个手机号已经报过名"; return; }
  list.push({ name: name, phone: phone, company: company });
  save(list);
  hint.textContent = "报名成功";
  render();
});
document.getElementById("export").addEventListener("click", function () {
  var quote = String.fromCharCode(34);
  var newline = String.fromCharCode(10);
  function cell(value) { return quote + String(value).split(quote).join(quote + quote) + quote; }
  var rows = load().map(function (row) { return [row.name, row.phone, row.company].map(cell).join(","); });
  var text = String.fromCharCode(65279) + ["姓名,手机号,公司名"].concat(rows).join(newline);
  var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  var link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "signups.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});
render();
</script>
</body>
</html>
`
}

/** 写页面的命令：先建文件夹，再用 printf 把页面原样写进 work/{jobId}/index.html（页面里没有单引号）。 */
export function htmlCommand(jobId, promptText) {
  return `mkdir -p work/${jobId} && printf '%s' '${pageHtml(promptText)}' > work/${jobId}/index.html`
}

/** 写截图的命令：printf 加八进制转义（每个字节写成 \NNN）写出 PNG 常量数组的全部字节。 */
export function pngCommand(jobId) {
  const escaped = PNG_BYTES.map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('')
  return `printf '${escaped}' > work/${jobId}/shot.png`
}

/** 把 pngCommand 里的八进制转义还原成字节数组（测试用来核对与 PNG_BYTES 逐字节相同）。 */
export function decodeOctalEscapes(command) {
  const body = /printf '([^']*)'/.exec(command)?.[1] ?? ''
  return [...body.matchAll(/\\([0-7]{3})/g)].map(match => parseInt(match[1], 8))
}

// ---------------------------------------------------------------------------
// 工具参数的小工具
// ---------------------------------------------------------------------------

/** 请求里的命令行工具：{ name, schema }；清单里没有返回 null（调用方传入 shell 描述）。 */
export function shellToolIn(tools) {
  const found = (Array.isArray(tools) ? tools : []).find(tool => SHELL_TOOL_NAMES.includes(tool?.name))
  return found ? { name: found.name, schema: found.input_schema ?? found.inputSchema ?? {} } : null
}

/** 按命令行工具的参数清单拼出调用参数：命令放进 command、cmd、script 里清单上有的第一个；必填的其他文字参数填一句固定的话。 */
export function shellInputFor(shell, command) {
  const props = shell.schema?.properties ?? {}
  const argName = COMMAND_ARG_NAMES.find(name => name in props) ?? 'command'
  const input = { [argName]: command }
  for (const name of shell.schema?.required ?? []) {
    if (name !== argName && props[name]?.type === 'string') input[name] = '走查测试：P74 假模型剧本'
  }
  return input
}

/** 命令文字（从一次命令行工具调用的参数里取）。 */
function commandOf(input) {
  const value = input?.command ?? input?.cmd ?? input?.script
  return typeof value === 'string' ? value : ''
}

/** hub_project_put 的参数：from、to 必有；清单里有 project 才写 project（没有就不写，由中心按会话默认）。 */
function putArgs(tools, from, to, projectId) {
  const props = (tools ?? []).find(tool => tool?.name === 'hub_project_put')?.input_schema?.properties
    ?? (tools ?? []).find(tool => tool?.name === 'hub_project_put')?.inputSchema?.properties ?? null
  const args = { from, to }
  // 清单里读不到参数表时（测试里常见）也写 project：唤醒包里有就填
  if (projectId !== null && (props === null || 'project' in props)) args.project = projectId
  return args
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** 一个「调用工具」的结果。step 记在日志里。 */
function toolStep(info, step, name, args) {
  return { action: { kind: 'tool', name, args }, role: info.role, step, jobId: info.jobId, commit: null, error: null }
}

/** 一个「交账」的结果：commit 是要合并进 hub_commit 参数的字段 { outcome, summary, reply }。 */
function commitStep(info, step, commit, error = null) {
  return { action: { kind: 'commit' }, role: info.role, step, jobId: info.jobId, commit, error }
}

/** 出错时的交账：不重试，写 progress（写 no_change 或 blocked 会让中心转受阻、叫醒总管，产生计划外的真实回合）。 */
function errorStep(info, text) {
  const shown = Array.from(String(text)).slice(0, 200).join('')
  return commitStep(info, 'commit', { outcome: 'progress', summary: `假模型剧本出错：${shown}`, reply: null }, shown)
}

/**
 * 按唤醒包文字和这一回合已调用的工具，算出下一步。
 * 入参 { messages, tools, plan, memory }：
 *   messages 请求里的对话；tools 请求里的工具清单（每项含 name 和 input_schema）；
 *   plan 是 parsePlan 的结果；memory 是 createJobMemory 的结果（按 jobId 记进度，在发出对应动作时更新）。
 * 返回 { action, role, step, jobId, commit, error }；识别不到这一段，或这一回合已经交过账，返回 null（走原有逻辑）。
 *   action：{ kind: 'tool', name, args } 或 { kind: 'commit' }（交账字段在 commit 里，由调用方合并进合法参数）。
 */
export function jobAction({ messages, tools, plan, memory }) {
  const info = identifyJob(latestPacketOf(messages))
  if (info === null) return null
  const calls = turnCalls(messages)
  // 交账之后的收尾（end_turn）交给原有逻辑
  if (calls.some(call => call.name === 'hub_commit')) return null
  // 第一步：照原样查状态
  if (!calls.some(call => call.name === 'hub_state_get')) return toolStep(info, 'state', 'hub_state_get', {})
  // 工具报错：不重试，交账说明（状态查询之外的任何工具）
  const failed = calls.find(call => call.name !== 'hub_state_get' && call.result?.isError === true)
  if (failed !== undefined) return errorStep(info, failed.result.text || '工具返回了错误')
  if (info.role === 'launch') return launchAction(info, calls, memory)
  if (info.role === 'reviewer') return reviewerAction(info, calls, plan, memory)
  return executorAction(info, calls, tools, plan, memory)
}

// ---------------------------------------------------------------------------
// 执行者
// ---------------------------------------------------------------------------

function executorAction(info, calls, tools, plan, memory) {
  const seen = parseExecutorSection(info.section)
  const jobId = seen.jobId ?? info.jobId
  const work = calls.filter(call => call.name !== 'hub_state_get')
  const asked = work.some(call => call.name === 'hub_job_work' && call.input?.mode === 'ask')
  // 问过之后立即交账等回答
  if (asked) return commitStep(info, 'commit', { outcome: 'progress', summary: '已向总管提问，等回答', reply: '已问总管，等回答。' })
  if (work.length === 0) {
    // 1 约定新版本在等确认：不交回，交账 no_change
    if (seen.pauseVersion !== null) {
      return commitStep(info, 'paused', { outcome: 'no_change', summary: `在等约定第 ${seen.pauseVersion} 版确认`, reply: '在等约定确认。' })
    }
    // 2 等材料：执行中、没有材料文件夹，最多等 4 个回合，第 5 个回合起照常做
    const waited = memory.waits.get(jobId) ?? 0
    if (plan.has('wait_material') && seen.state === '执行中' && !seen.hasMaterialFolder && waited < 4) {
      memory.waits.set(jobId, waited + 1)
      return commitStep(info, 'wait', { outcome: 'progress', summary: '在等主人的材料', reply: '在等主人的材料。' })
    }
    // 3 先问总管一次
    if (plan.has('ask_once') && !memory.asked.has(jobId) && seen.state === '执行中') {
      memory.asked.add(jobId)
      return toolStep(info, 'ask', 'hub_job_work', { mode: 'ask', jobId, text: '同一手机号第二次提交时，页面应该提示什么？' })
    }
  }
  return produceAction(info, seen, work, tools, plan)
}

/** 做产出物并交回：写页面、写截图、放页面、放截图、交回、交账；每一步看这一回合已经做过哪些。 */
function produceAction(info, seen, work, tools, plan) {
  const jobId = seen.jobId ?? info.jobId
  const rework = seen.reworkNos.length > 0
  // 页面里手机号的提示文字：wrong_text 只在第一次交回写错，返工改对
  const prompt = plan.has('wrong_text') && !rework ? WRONG_PROMPT : GOOD_PROMPT
  const shell = shellToolIn(tools)
  const toolNames = (tools ?? []).map(tool => tool?.name)
  const htmlCmd = htmlCommand(jobId, prompt)
  const pngCmd = pngCommand(jobId)
  const ranShell = command => work.some(call => SHELL_TOOL_NAMES.includes(call.name) && commandOf(call.input) === command)
  const put = file => work.some(call => call.name === 'hub_project_put' && String(call.input?.from ?? '').endsWith(file))
  const submitted = work.some(call => call.name === 'hub_job_work' && call.input?.mode === 'submit')
  // 缺工具时交账说明缺哪个（errorStep 会自己加「假模型剧本出错：」前缀）
  const needShell = () => (shell === null ? errorStep(info, '这条会话里没有命令行工具') : null)
  const needPut = () => (toolNames.includes('hub_project_put') ? null : errorStep(info, '这条会话里没有 hub_project_put 工具'))
  const folder = seen.folder ?? `jobs/${jobId}`
  if (submitted) {
    return commitStep(info, 'commit', { outcome: 'progress', summary: rework ? '已按核对意见改好并重新交回' : '已按约定做好页面并交回',
      reply: rework ? '已按核对意见改好并重新交回。' : '已按约定做好页面并交回。' })
  }
  if (!ranShell(htmlCmd)) return needShell() ?? toolStep(info, 'write_html', shell.name, shellInputFor(shell, htmlCmd))
  if (!rework && !ranShell(pngCmd)) return needShell() ?? toolStep(info, 'write_png', shell.name, shellInputFor(shell, pngCmd))
  if (!put('index.html')) return needPut() ?? toolStep(info, 'put_html', 'hub_project_put', putArgs(tools, `work/${jobId}/index.html`, `${folder}/交付/index.html`, seen.projectId))
  if (!rework && !put('shot.png')) return needPut() ?? toolStep(info, 'put_png', 'hub_project_put', putArgs(tools, `work/${jobId}/shot.png`, `${folder}/证据/shot.png`, seen.projectId))
  return toolStep(info, 'submit', 'hub_job_work', submitArgs(seen, jobId, rework))
}

/**
 * 交回参数：第一轮每条都交，返工只交「这一轮要改的条目」；交付时核对的写 at_delivery 不附证据；
 * 其余 met，第一条非交付时核对的附截图证据，其余附页面文件证据；路径只写主题文件夹里的相对路径。
 */
export function submitArgs(seen, jobId, rework) {
  const nos = rework ? seen.reworkNos : seen.items.map(item => item.no)
  const byNo = new Map(seen.items.map(item => [item.no, item]))
  let imageUsed = false
  const items = nos.map(no => {
    if (byNo.get(no)?.atDelivery === true) return { no, selfCheck: 'at_delivery' }
    const evidence = imageUsed
      ? [{ kind: 'file', path: '交付/index.html', summary: '页面文件' }]
      : [{ kind: 'image', path: '证据/shot.png', summary: '页面截图' }]
    imageUsed = true
    return { no, selfCheck: 'met', evidence }
  })
  return {
    mode: 'submit', jobId,
    changeNote: rework ? `按核对意见改了第 ${nos.join('、')} 条` : '按约定做了页面',
    items, deliverables: ['交付/index.html'], preview: '交付/index.html',
  }
}

// ---------------------------------------------------------------------------
// 评审员
// ---------------------------------------------------------------------------

function reviewerAction(info, calls, plan, memory) {
  const seen = parseReviewerSection(info.section)
  const jobId = seen.jobId ?? info.jobId
  const work = calls.filter(call => call.name !== 'hub_state_get')
  // 还没有交回：不核对，交账 no_change
  if (seen.notSubmitted) return commitStep(info, 'commit', { outcome: 'no_change', summary: '还没有可核对的交回', reply: '还没有可核对的交回。' })
  if (work.some(call => call.name === 'hub_job_work' && call.input?.mode === 'review')) {
    return commitStep(info, 'commit', { outcome: 'progress', summary: `第 ${seen.round} 轮核对已提交`, reply: `已核对第 ${seen.round} 轮。` })
  }
  const before = memory.reviews.get(jobId) ?? 0
  memory.reviews.set(jobId, before + 1)
  return toolStep(info, 'review', 'hub_job_work', reviewArgs(seen, jobId, plan, before === 0))
}

/**
 * 核对结论参数。
 *   重新核对（主人选办法之后）：只给指定序号写 met，不论开关；
 *   普通核对：沿用的不写；交付时核对的写 at_delivery；其余 met。
 *   review_fail_once 且是第一次核对、或 review_fail_always：第一条既不沿用、也不是交付时核对的条目改写为不符。
 *   有沿用的条目时带 carriedNote 和 spotChecked（第一条沿用的序号）。
 */
export function reviewArgs(seen, jobId, plan, firstReview) {
  if (seen.recheckNos !== null) {
    return { mode: 'review', jobId, items: seen.recheckNos.map(no => ({ no, verdict: 'met', note: '已对照约定核对' })) }
  }
  const failing = plan.has('review_fail_always') || (plan.has('review_fail_once') && firstReview)
  let failed = false
  const items = []
  for (const item of seen.items) {
    if (item.kind === 'carried') continue
    if (item.kind === 'at_delivery') { items.push({ no: item.no, verdict: 'at_delivery' }); continue }
    if (failing && !failed) {
      failed = true
      items.push({ no: item.no, verdict: 'unmet', note: '提示文字与约定不一致', fixTo: '输入 10 位手机号时，提示文字与约定逐字一致，附一张截图' })
      continue
    }
    items.push({ no: item.no, verdict: 'met', note: '已对照约定核对' })
  }
  const args = { mode: 'review', jobId, items }
  const carried = seen.items.find(item => item.kind === 'carried')
  if (carried !== undefined) {
    args.carriedNote = '本轮只改了被退回的条目'
    args.spotChecked = [carried.no]
  }
  return args
}

// ---------------------------------------------------------------------------
// 发布这一步
// ---------------------------------------------------------------------------

function launchAction(info, calls, memory) {
  const work = calls.filter(call => call.name !== 'hub_state_get')
  const jobId = info.jobId
  if (info.phase === 'waiting') {
    return commitStep(info, 'wait', { outcome: 'no_change', summary: '发布申请在等主人批准', reply: '在等主人批准发布。' })
  }
  if (info.phase === 'approved') {
    if (work.some(call => call.name === 'hub_job_work' && call.input?.mode === 'launched')) {
      return commitStep(info, 'commit', { outcome: 'progress', summary: '已回报发布地址', reply: '已发布。' })
    }
    return toolStep(info, 'launched', 'hub_job_work', { mode: 'launched', jobId, link: `http://127.0.0.1:${process.env.FAKE_MODEL_PORT ?? 18080}/launched-demo` })
  }
  // 准备中：同一件事只提交一次
  if (work.some(call => call.name === 'hub_outbox_submit') || memory.submitted.has(jobId)) {
    return commitStep(info, 'commit', { outcome: 'progress', summary: '已提交发布审批，等主人批准', reply: '已提交发布审批，等主人批准。' })
  }
  memory.submitted.add(jobId)
  return toolStep(info, 'outbox', 'hub_outbox_submit', outboxArgs(info.section))
}

/** 发布审批的参数：run_command 只运行 echo；cost、undo、after 各一句白话，不超过 80 字。 */
export function outboxArgs(section) {
  return {
    kind: 'run_command',
    why: '演示发布：把活动报名页放到本机演示地址',
    payload: { cmd: 'echo', args: ['发布演示'], cwd: launchCwdOf(section) },
    cost: '不产生费用',
    undo: '可以撤回：再运行一次撤下命令即可',
    after: '批准后约 1 分钟内完成，之后可以在本机打开演示地址',
  }
}
