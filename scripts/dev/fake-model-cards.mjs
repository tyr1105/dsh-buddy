/**
 * fake-model-cards.mjs —— 界面走查专用的「假模型」（总控写，2026-11-05 从临时目录搬进项目）。
 *
 * 它是做什么的：
 *   在 127.0.0.1:18080 冒充 DeepSeek 的 Anthropic 兼容接口，让沙箱里的 DSH 以为在调真模型，
 *   但不花任何额度、回复完全可预测。行为在项目自带的假模型 scripts/fake-model-server.mjs
 *   （端到端冒烟用的剧本：查状态 → 交账 → 结束）基础上，按「主人消息里的暗号」多做几件事，
 *   方便在界面上把各种卡片和「打断」都点一遍：
 *     【提问】→ 交账时带一个给主人的提问（needs_owner），线程和收件箱出现提问卡
 *     【提议】→ 交账时带一条改进提议，收件箱出现提议卡（接受 / 不做）
 *     【审批】→ 先申请一个对外动作（POST 到本服务自己的 /hook-test），会生成审批卡；
 *               主人批准后中心会真的执行这一下，本服务把收到的请求记进日志，用来核对「批准只执行一次」
 *     【慢】  → 新回合的第一步故意拖 90 秒才回，留出时间点「打断」
 *   下面两个只在项目主题里有用（P60 走查），回复里带 @名字，用来走通队友之间的接力：
 *     【点名】→ 主人说话后，第一个回复的人 @ 另一位成员；被点名的人回一句，再回到负责人收尾
 *     【连环】→ 每个人回复时都 @ 下一位，一直接力到中心的发言上限，用来看「到上限」的提示
 *
 * 怎么用：一般不用单独运行，scripts/dev/ui-sandbox.sh 会自动把它拉起来。
 *   单独运行：node scripts/dev/fake-model-cards.mjs（日志默认写到 .sandbox/fake-model-cards.log）
 *
 * 安全：不读任何凭据；请求头一律不记录；只监听本机地址。
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 直接复用项目假模型导出的纯函数（被 import 时它不会启动自己的服务）
import { nextAction, commitArgs, ownerMessageOf, lastUserHasText } from '../fake-model-server.mjs'

// 项目根目录 = 本文件往上两级（scripts/dev/ → scripts/ → 项目根）
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// 端口固定 18080：沙箱里的 DSH 通过 DEEPSEEK_BASE_URL 指向这里（与 sandbox.sh e2e 相同，所以两者不能同时跑）
const PORT = Number(process.env.FAKE_MODEL_PORT ?? 18080)
const LOG = process.env.FAKE_MODEL_LOG ?? join(ROOT, '.sandbox', 'fake-model-cards.log')
mkdirSync(dirname(LOG), { recursive: true })

/** 建立「工具调用 id → 工具名」的对照表（项目假模型里的同名函数没导出，这里照抄一份）。 */
function toolNames(messages) {
  const names = new Map()
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool_use' && block.id) names.set(block.id, block.name)
    }
  }
  return names
}

/** 最后一条 user 消息里的工具结果，分别对应哪些工具（用来判断「上一步调了什么」）。 */
function lastResultNames(messages) {
  const last = messages[messages.length - 1]
  const results = Array.isArray(last?.content) ? last.content.filter(b => b?.type === 'tool_result') : []
  const names = toolNames(messages)
  return results.map(b => names.get(b.tool_use_id) ?? '').filter(Boolean)
}

/**
 * 决定这一步怎么回：先按项目剧本算出默认动作，再按暗号改写。
 * 返回 { action, delayMs }：action 是要回的动作，delayMs 是故意拖延的毫秒数（只有【慢】才拖）。
 */
function decide(body) {
  const messages = body?.messages ?? []
  // ownerMessageOf 取的是最新一条「主人对你说」（同一工作会话里会有好几轮主人消息）
  const owner = ownerMessageOf(messages) ?? ''
  const base = nextAction(body)
  const lastNames = lastResultNames(messages)
  // 【审批】：查完状态后不急着交账，先提交一个对外动作；对外动作有了结果再交账
  if (owner.includes('【审批】')) {
    if (lastNames.includes('hub_outbox_submit')) return { action: { kind: 'commit' }, delayMs: 0 }
    if (base.kind === 'commit') {
      return {
        action: { kind: 'tool', name: 'hub_outbox_submit', args: {
          kind: 'http_post',
          why: '走查测试：把日志异常摘要推送到本机测试地址（需要主人批准）',
          payload: { url: `http://127.0.0.1:${PORT}/hook-test`, body: '{"test":true}' },
        } },
        delayMs: 0,
      }
    }
  }
  // 【慢】：只在新回合的第一步（最后一条 user 消息带着唤醒正文）拖 90 秒
  const isFirstStep = base.kind === 'tool' && base.name === 'hub_state_get' && lastUserHasText(messages)
  const delayMs = owner.includes('【慢】') && isFirstStep ? 90_000 : 0
  return { action: base, delayMs }
}

/**
 * 这一回合的唤醒正文：最后一条带文字的 user 消息。
 * 交账那一步的最后一条 user 消息只有工具结果，所以要往前找；
 * 同一工作会话里更早的唤醒包不算，否则上一轮的暗号会影响这一轮。
 */
function latestPacket(messages) {
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
 * 从主题唤醒包的「成员：」清单里读出能 @ 的其他人。
 * 一行长这样：`- 探路（负责人；你自己；调研）`。标了「你自己」的跳过（不能 @ 自己），
 * 标了「不在岗」的也跳过（@ 了也叫不醒）。
 */
function otherMembers(packet) {
  const names = []
  let reading = false
  for (const raw of packet.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '成员：') { reading = true; continue }
    if (!reading) continue
    const row = /^- (.+?)（(.*)）$/.exec(line)
    if (row === null) break // 成员清单结束了
    if (!row[2].includes('你自己') && !row[2].includes('不在岗')) names.push(row[1])
  }
  return names
}

/**
 * 主题楼层里最新一楼是不是主人说的；是的话，这一回合就是主人说完后的第一个回复。
 * 楼层一行长这样：`3 楼 探路（今天 12:00）：内容`。
 * 不能看有没有「主人对你说」这一段：队友被点名时，唤醒依据里也带着主人那句话，这一段同样会出现。
 */
function lastFloorByOwner(packet) {
  const floors = packet.split(/\r?\n/).map(line => /^\d+ 楼 (.+?)（/.exec(line.trim())).filter(row => row !== null)
  return floors.at(-1)?.[1] === '主人'
}

/**
 * 项目主题里这一回合说什么；不是主题回合时返回 null，沿用项目剧本的回复。
 * 暗号从最新唤醒正文里找：主人的话不管在「主人对你说」还是「主题楼层」里，都读得到。
 */
function topicReplyFor(packet) {
  if (!packet.includes('## 项目主题讨论')) return null
  // 中心要求收尾时一律不再 @ 人，否则走查看不出上限规则有没有生效。
  if (packet.includes('这是这轮讨论的最后一次发言')) return '大家的意见我收齐了，结论先这样，等你下一句。'
  const next = otherMembers(packet)[0]
  const firstReply = lastFloorByOwner(packet)
  if (next !== undefined && packet.includes('【连环】')) return `这一棒我说完了。@${next} 你接着说。`
  if (next !== undefined && firstReply && packet.includes('【点名】')) return `收到，这件事要找人一起看。@${next} 帮忙看一下。`
  // 没有要接力的：主人叫的回一句「收到」，被队友叫的（点名或交回负责人）说看过了，都不再 @ 人。
  return firstReply ? null : '我看过了，没有别的要补充。'
}

/** 交账参数：在项目剧本的合法参数上，按暗号补提问或提议。 */
function commitFor(body) {
  const owner = ownerMessageOf(body?.messages ?? [])
  const args = commitArgs(owner)
  const topicReply = topicReplyFor(latestPacket(body?.messages ?? []))
  if (topicReply !== null) args.reply = topicReply
  if (owner?.includes('【提问】')) {
    args.outcome = 'needs_owner' // needs_owner 必须带 ownerQuestion，否则中心会拒收交账
    args.ownerQuestion = {
      text: '日志里 10 分钟内出现 3 次超时，要不要现在重启服务？',
      options: ['重启', '先观察'],
      defaultOption: '先观察',
      whyNeeded: '重启会中断正在跑的任务，需要你拍板',
    }
  }
  if (owner?.includes('【提议】')) {
    args.proposals = [{ title: '工作日 08:20 检查早盘日志', detail: '早盘任务 08:10 开跑，08:20 前日志应有新行；没有就提醒你。', value: 0.7, confidence: 0.8 }]
  }
  return args
}

let seq = 0
/** 按 Anthropic 的流式格式（SSE）写回一次应答：要么是一次工具调用，要么是一段结束语。 */
function stream(res, body, action) {
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', { type: 'message_start', message: { id: `msg_cards_${seq}`, type: 'message', role: 'assistant', content: [], model: body?.model ?? 'fake', usage: {} } })
  if (action.kind === 'tool' || action.kind === 'commit') {
    const name = action.kind === 'commit' ? 'hub_commit' : action.name
    const input = action.kind === 'commit' ? commitFor(body) : action.args
    const id = `toolu_cards_${(seq += 1)}`
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 24 } })
  } else {
    // abort 是「禁用工具没被拦下」的失败信号（沿用项目剧本），其余情况都是正常结束
    const text = action.kind === 'abort' ? '禁用工具未被拦截：ask_user_question 没有被拒绝' : '已交账'
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })
  }
  send('message_stop', { type: 'message_stop' })
  res.end()
}

createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    if (req.method !== 'POST' || !String(req.url).endsWith('/messages')) {
      // 不是模型请求：多半是主人批准后中心执行的那次 POST /hook-test。只记一行，回 200
      appendFileSync(LOG, `${new Date().toISOString()} 非模型请求 ${req.method} ${req.url} body=${raw.slice(0, 200)}\n`)
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('ok')
      return
    }
    let body = {}
    try { body = JSON.parse(raw) } catch { /* 空体或坏 JSON 按空请求处理 */ }
    const { action, delayMs } = decide(body)
    appendFileSync(LOG, `${new Date().toISOString()} ${action.kind}${action.name ? ':' + action.name : ''} delay=${delayMs}\n`)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const timer = setTimeout(() => stream(res, body, action), delayMs)
    // 被「打断」时 DSH 会断开连接：取消定时器，别往已经关掉的流里写
    res.on('close', () => clearTimeout(timer))
  })
}).listen(PORT, '127.0.0.1', () => console.log(`[fake-model-cards] 在 127.0.0.1:${PORT} 监听；日志 ${LOG}`))
