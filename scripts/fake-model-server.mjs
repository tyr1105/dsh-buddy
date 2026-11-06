/**
 * 本机假模型服务（verified-T8 第 2 节「备选黑盒法」）：在 127.0.0.1:18080 实现
 * DeepSeek 适配器所需的 Anthropic Messages SSE 协议（message_start…message_stop、
 * tool_use、input_json_delta、stop_reason），按剧本应答，不花任何真实额度。
 *
 * 剧本（与冒烟跑者配套）：
 *   0) 试跑回合的第一步（D03 先修项 A4）：先探针调用一次禁用工具 ask_user_question；
 *      工具结果必须是错误（被宿主拦下）才继续，否则以「禁用工具未被拦截」收场（冒烟失败）。
 *   1) 收到唤醒包（user 文本，含「中心通知」或首次请求）→ 返回 tool_use hub_state_get
 *   2) 收到 hub_state_get 的 tool_result → 返回 tool_use hub_commit（完整合法参数，
 *      主人消息唤醒时 reply 为「收到：<主人原话前 20 字>」）
 *   3) 收到 hub_commit 的 tool_result → end_turn 文本「已交账」
 *
 * 每次请求（不含 x-api-key）记录到 .sandbox/fake-model.log，便于验收。
 * 用法：FAKE_MODEL_LOG=<路径> node scripts/fake-model-server.mjs
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOG_PATH = process.env.FAKE_MODEL_LOG ?? join(ROOT, '.sandbox', 'fake-model.log')
const PORT = Number(process.env.FAKE_MODEL_PORT ?? 18080)
const HOST = '127.0.0.1'

mkdirSync(dirname(LOG_PATH), { recursive: true })

/**
 * 从全部 user 文本里找「主人对你说」小节的下一行（唤醒包格式，见 build-spec 第 9 节）。
 * D07 第 29 条：取**最新**一条——同一工作会话里第二次起的唤醒包会把之前的话也拼在
 * 上下文里，取第一条会对不上原话（回复就不再是「收到：+ 原话」）。
 */
export function ownerMessageOf(messages) {
  let found = null
  for (const message of messages ?? []) {
    if (message?.role !== 'user') continue
    for (const block of message?.content ?? []) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const lines = block.text.split(/\r?\n/)
      const at = lines.findIndex(line => line.includes('主人对你说'))
      if (at < 0) continue
      for (let i = at + 1; i < lines.length; i += 1) {
        const line = lines[i].trim()
        if (line === '') continue
        if (line.startsWith('#')) break // 下一个小节开始了
        found = line // 继续找：后面更新的唤醒包（更新的原话）会覆盖
      }
    }
  }
  return found
}

/** 建立 tool_use id → 工具名映射（判断模型上一轮调了什么）。 */
function toolNames(messages) {
  const names = new Map()
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool_use' && block.id) names.set(block.id, block.name)
    }
  }
  return names
}

/** 最后一条 user 消息里是否有正文文本块（唤醒包在场的标志）。 */
export function lastUserHasText(messages) {
  const lastUser = [...(messages ?? [])].reverse().find((m) => m?.role === 'user')
  if (!lastUser) return false
  const blocks = Array.isArray(lastUser.content) ? lastUser.content : []
  return blocks.some((b) => b?.type === 'text' && String(b.text ?? '').trim() !== '')
}

/** 判定下一步动作：看最后一条 user 消息里的正文与 tool_result。 */
export function nextAction(body) {
  const messages = body?.messages ?? []
  const last = messages[messages.length - 1]
  const results = Array.isArray(last?.content) ? last.content.filter((b) => b?.type === 'tool_result') : []
  // D05 第 10 条起 hub_commit 成功后插件会 exec.concludeTurn() 收口：上一回合未答复的
  // tool_result 会拼进新回合的第一步（同一条 user 消息 = [tool_result, 唤醒正文]）。
  // 只要最后一条 user 消息带正文，就按「新回合第一步」处理，不看拼着的 tool_result。
  if (lastUserHasText(messages)) {
    // D03 先修项 A4：试跑回合的第一步先探针调用一次禁用工具 ask_user_question
    //（会话里还没有任何 tool_result 时才算第一步）。
    if (results.length === 0 && isFirstTrialStep(messages)) {
      return { kind: 'tool', name: 'ask_user_question', args: { question: '试跑探针：机器人不该能提问' } }
    }
    return { kind: 'tool', name: 'hub_state_get', args: {} }
  }
  if (results.length === 0) return { kind: 'tool', name: 'hub_state_get', args: {} }
  const names = toolNames(messages)
  const lastNames = results.map((b) => names.get(b.tool_use_id) ?? '').filter(Boolean)
  if (lastNames.includes('ask_user_question')) {
    return askUserIntercepted(messages) ? { kind: 'tool', name: 'hub_state_get', args: {} } : { kind: 'abort' }
  }
  if (lastNames.includes('hub_state_get')) return { kind: 'commit' }
  if (lastNames.includes('hub_commit')) return { kind: 'end' }
  return { kind: 'tool', name: 'hub_state_get', args: {} }
}

/** 是否「试跑回合的第一步」：会话里还没有任何 tool_result，且最新用户文本是试跑唤醒包。 */
export function isFirstTrialStep(messages) {
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool_result') return false
    }
  }
  const lastUser = [...(messages ?? [])].reverse().find((m) => m?.role === 'user')
  const text = typeof lastUser?.content === 'string'
    ? lastUser.content
    : (lastUser?.content ?? []).map((c) => (c?.type === 'text' ? c.text : '')).join('\n')
  return String(text).includes('试跑')
}

/** ask_user_question 的工具结果是否被宿主拒绝（is_error 或错误文字；Anthropic 两种口径都认）。 */
export function askUserIntercepted(messages) {
  const names = toolNames(messages)
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type !== 'tool_result' || names.get(block.tool_use_id) !== 'ask_user_question') continue
      const body = typeof block.content === 'string'
        ? block.content
        : (block?.content ?? []).map((c) => c?.text ?? '').join('\n')
      if (block.is_error === true || /不能使用|禁用|拒绝|denied|not allowed|error/i.test(String(body))) return true
    }
  }
  return false
}

/**
 * hub_commit 的完整合法参数（CommitInputSchema 12 个键全给、可空项显式 null）。
 * D05 第 19 条：试跑回合（ownerText 为 null）不带 reply——只有主人消息唤醒的
 * 回合才回「收到：<主人原话前 20 字>」，冒烟跑者据此判定那一轮确实收到了主人原话。
 */
export function commitArgs(ownerText) {
  const reply = ownerText === null ? null : `收到：${[...ownerText].slice(0, 20).join('')}`
  return {
    outcome: 'progress',
    summary: '端到端冒烟：按剧本完成一次交账',
    worldChanges: [],
    evidence: [],
    verification: { level: 'none', notCovered: '冒烟测试不做验证' },
    blocker: null,
    nextThink: { mode: 'after', afterMinutes: 90, reason: '冒烟测试：稍后再看一眼' },
    ownerQuestion: null,
    reply,
    report: null,
    importance: 5,
    proposals: [],
  }
}

let toolSeq = 0

/** 把一次应答写成 SSE 流（event 名必须等于 data.type，verified-T8 第 2 节）。 */
function writeStream(res, body, action) {
  const send = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  send('message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', content: [], model: body?.model ?? 'fake', usage: {} } })
  if (action.kind === 'tool' || action.kind === 'commit') {
    const isCommit = action.kind === 'commit'
    const name = isCommit ? 'hub_commit' : action.name
    const args = isCommit ? commitArgs(ownerMessageOf(body?.messages)) : action.args
    const id = `toolu_${(toolSeq += 1)}`
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 24 } })
  } else {
    // end 与 abort 都走文本分支；abort 是「禁用工具没被拦下」的失败信号（D03 先修项 A4）。
    const text = action.kind === 'abort' ? '禁用工具未被拦截：ask_user_question 没有被拒绝' : '已交账'
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })
  }
  send('message_stop', { type: 'message_stop' })
  res.end()
}

function logRequest(req, body) {
  const headers = { ...req.headers }
  delete headers['x-api-key'] // 绝不记录凭据
  const names = (body?.messages ?? []).map((m) => `${m?.role}:${Array.isArray(m?.content) ? m.content.length : 0}`).join(',')
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${req.method} ${req.url} model=${body?.model ?? ''} messages=[${names}]\n`)
  // 诊断（总控加）：把模型看到的工具名清单与最后一条用户消息的文字前 4000 字写进旁边的 .detail.jsonl，
  // 用来核对「机器人能用哪些工具」「唤醒包长什么样」。不含任何请求头（凭据只在请求头里）。
  try {
    const toolNames = (body?.tools ?? []).map((t) => t?.name).filter(Boolean)
    const lastUser = [...(body?.messages ?? [])].reverse().find((m) => m?.role === 'user')
    const text = typeof lastUser?.content === 'string'
      ? lastUser.content
      : (lastUser?.content ?? []).map((c) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n')
    appendFileSync(`${LOG_PATH}.detail.jsonl`, JSON.stringify({ at: new Date().toISOString(), toolNames, lastUserText: String(text).slice(0, 4000) }) + '\n')
  } catch { /* 诊断日志失败不影响假服务 */ }
}

// 直接运行（node scripts/fake-model-server.mjs）才启动服务；被测试 import 时只提供纯函数。
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  const server = createServer((req, res) => {
  if (req.method !== 'POST' || !String(req.url).endsWith('/messages')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('fake-model: 只支持 POST /…/messages')
    return
  }
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* 坏 JSON 按空处理 */ }
    try { logRequest(req, body) } catch { /* 日志失败不影响应答 */ }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    try {
      writeStream(res, body, nextAction(body))
    } catch (error) {
      console.error('[fake-model] 应答失败:', error)
      res.end()
    }
  })
})

  server.listen(PORT, HOST, () => {
    console.log(`[fake-model] 假模型服务已启动 http://${HOST}:${PORT}（Anthropic Messages SSE）日志=${LOG_PATH}`)
  })
}
