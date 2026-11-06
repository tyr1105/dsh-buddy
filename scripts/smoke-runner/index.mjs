/**
 * agent-hub 端到端冒烟跑者（verified-T8 第 5 节，含核查员的四处改正）：
 * 等中心就绪 → createBot（role 只能是 chief/researcher/executor/sentinel）→
 * 等试跑交账 → pokeBot 主人消息 → 等第二次交账 → 以退出码 0/1 结束并打印
 * {"type":"hub-smoke","ok":…} 摘要行（外部脚本以这一行为准，退出码只作辅助）。
 * 只 inject 一定存在的 appReady/appExit；agentHub 用 ctx.get 探测。
 * 判定数据全部来自 agentHub 服务（core 的真实视图），不直接读文件。
 *
 * D04 第 3 条新增「真实模式」（环境变量 HUB_SMOKE_REAL=1，由 scripts/sandbox.sh real 设置）：
 * 不依赖假模型的固定剧本，用一个真实模型（主人桌面版配置的 GLM）跑两个回合：
 * 建一个盯守型机器人（志向：每天确认沙箱目录里有一份 hello.txt，内容是今天的日期；
 * 起步关注指向沙箱工作目录）→ 等 trial 交账（240 秒）→ pokeBot「请检查一下
 * hello.txt 在不在，不在就创建它」→ 等第二次交账与 reply（240 秒）→ 打印摘要：
 * 两次交账的 outcome、reply 原文、每轮步数与 token、有没有未交账/出错、
 * 机器人实际调用了哪些工具（从会话事件 tool/call 统计）。
 */
export const name = 'agent-hub-smoke-runner'
export const inject = ['appReady', 'appExit']

// 真实模式的模型响应慢，超时放宽；总兜底要留在外层看门狗（600 秒）之内。
const REAL = process.env.HUB_SMOKE_REAL === '1'
const OVERALL_TIMEOUT_MS = REAL ? 540_000 : 150_000
const HUB_READY_TIMEOUT_MS = 30_000
const COMMIT_TIMEOUT_MS = REAL ? 240_000 : 90_000

/**
 * 判定「主人消息那一轮的回复」（D05 第 19 条，导出的纯函数便于测试）：
 * - 只看 pokeBot 之后新出现的 reply（repliesBeforePoke 之前的都不算——试跑回合不再带
 *   reply，但仍要防试跑那条提前满足判定）。
 * - 假模型模式：内容必须恰为「收到：+ pokeText 前 20 字」，证明主人原话进了唤醒包并回到线程。
 * - 真实模式：取 poke 之后的第一条 reply。
 */
export function ownerReplyOf(replies, repliesBeforePoke, pokeText, real) {
  if (!Array.isArray(replies) || replies.length <= repliesBeforePoke) return null
  const after = replies.slice(repliesBeforePoke)
  if (real) return after[0]?.text ?? null
  const expected = `收到：${[...String(pokeText)].slice(0, 20).join('')}`
  return after.some((m) => m.text === expected) ? expected : null
}

/**
 * H7 结论（D05 第 19 条 / D07 第 23 条）：预登记 id 与实际返回 id 比对。
 * mints 是「预登记 id → 实际 id」记录（不随名册迁移）：找到实际 id 对应的记录后，
 * 比较两者是否相同——名册本身会迁到实际 id，用它比对永远「一致」，查不出另铸。
 */
export function h7NoteOf(actualSession, mints) {
  if (actualSession === null) return '会话 id=（还没有会话）'
  const entry = (mints ?? []).find(([, actual]) => actual === actualSession)
  if (entry === undefined) return `会话 id=${actualSession}（本次运行没有预登记记录，无法比对 H7）`
  return entry[0] === actualSession
    ? `会话 id=${actualSession}（与预登记 id 一致，H7 未走退回分支）`
    : `会话 id=${actualSession}（预登记 id=${entry[0]}，另铸了 id，H7 走了退回分支；已按返回 id 补装工具）`
}

/**
 * 设置接口检查（D07 第 1 条）：经诊断服务的进程内 GET（与真实 HTTP 同一组路由
 * 处理函数）拉 /api/agent-hub/settings，必须 200 且 modelOptions 多于 1 项——
 * 模型目录回调丢 this、目录失败返回空数组这类回归，今后 e2e 就能抓到。
 */
export async function settingsCheckOf(hub) {
  if (typeof hub?.request !== 'function') return { ok: false, note: '设置检查：诊断服务没有 request 入口（插件版本过旧）' }
  try {
    const response = await hub.request('/api/agent-hub/settings')
    if (!response || response.status !== 200) {
      return { ok: false, note: `设置接口返回 ${response ? response.status : '不可用'}（期望 200）` }
    }
    const options = response.body?.modelOptions ?? []
    const note = `设置接口 200、模型选项 ${options.length} 项`
    return options.length > 1 ? { ok: true, note } : { ok: false, note: `${note}（少于 2 项：模型目录没列出沙箱里的模型）` }
  } catch (error) {
    return { ok: false, note: `设置接口检查失败：${error?.message ?? String(error)}` }
  }
}

export function apply(ctx) {
  let finished = false
  /** 从会话事件统计机器人实际调用的工具与错误文本（真实模式的摘要用）。 */
  const toolCalls = new Map() // sessionId → Set<toolName>
  const turnErrors = new Map() // sessionId → string[]
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || !session) return
        const sid = String(session.id ?? '')
        if (event.type === 'tool/call') {
          const name = String(event.data?.name ?? '')
          if (name === '') return
          if (!toolCalls.has(sid)) toolCalls.set(sid, new Set())
          toolCalls.get(sid).add(name)
        }
        if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
          if (!turnErrors.has(sid)) turnErrors.set(sid, [])
          turnErrors.get(sid).push(String(event.data.reason.error?.message ?? event.data.reason.error?.code ?? '回合出错'))
        }
      } catch { /* 统计失败不影响冒烟 */ }
    })
  } catch { /* 拿不到事件监听就只少一段摘要 */ }

  const finish = (code, summary) => {
    if (finished) return
    finished = true
    console.log(JSON.stringify({ type: 'hub-smoke', ok: code === 0, summary }))
    // appExit 正常释放后只设退出码，等事件循环清空；稍等一拍让 stdout 刷出。
    setTimeout(() => { try { ctx.get('appExit')(code) } catch (e) { console.error('[hub-smoke] appExit 失败:', e) } }, 100)
  }

  // 外层兜底超时（模型或引擎卡死时不能挂住进程）。
  const watchdog = setTimeout(() => finish(1, '总超时：冒烟没有在时限内完成'), OVERALL_TIMEOUT_MS)
  if (typeof watchdog.unref === 'function') watchdog.unref()

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const waitFor = async (probe, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await probe()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`${label}超时（${timeoutMs}ms）`)
      await sleep(1000)
    }
  }

  /** 真实模式：两回合的摘要（outcome、reply、步数 token、工具清单、错误）。 */
  const realSummary = (botId, replyText) => {
    const sessionIdKnown = [...toolCalls.keys()]
    const tools = [...new Set(sessionIdKnown.flatMap(sid => [...(toolCalls.get(sid) ?? [])]))]
    const errors = [...new Set(sessionIdKnown.flatMap(sid => turnErrors.get(sid) ?? []))]
    return [
      `真实模式：机器人 ${botId} 完成两次交账`,
      replyText ? `reply 原文：${replyText}` : '（线程里没有出现 reply）',
      `调用的工具：${tools.length > 0 ? tools.join('、') : '（无）'}`,
      errors.length > 0 ? `回合错误：${errors.join('；')}` : '没有回合错误',
    ].join('；')
  }

  const run = async () => {
    const hub = await waitFor(() => ctx.get('agentHub'), HUB_READY_TIMEOUT_MS, '等 agentHub 服务')
    // 服务对象先于引擎就绪挂出；必须等 status().ok（mode=engine）后再发命令，否则会撞上「尚未就绪」
    await waitFor(() => { try { return hub.status?.().ok === true } catch { return false } }, HUB_READY_TIMEOUT_MS, '等中心引擎就绪')
    const api = hub.api

    // 0) 设置接口检查（D07 第 1 条）：GET /api/agent-hub/settings 必须 200 且
    //    modelOptions 多于 1 项；不过直接失败，摘要里带原因。
    const settingsCheck = await settingsCheckOf(hub)
    if (!settingsCheck.ok) return finish(1, `设置检查未通过：${settingsCheck.note}`)

    // 1) 建机器人。真实模式：盯守型 + hello.txt 志向 + 沙箱工作目录起步关注。
    const created = REAL
      ? await api.command('createBot', {
          name: '实测员', role: 'sentinel',
          persona: '真实模型测试机器人，按协议交账',
          aspirations: ['每天确认沙箱目录里有一份 hello.txt，内容是今天的日期'],
          watches: [{
            kind: 'file',
            target: process.env.AGENT_HUB_SANDBOX_WORKDIR || process.cwd(),
            why: '起步关注：真实模型测试指定的沙箱工作目录',
          }],
        })
      : await api.command('createBot', {
          name: '冒烟员', role: 'researcher', persona: '端到端冒烟测试机器人', aspirations: ['完成一次交账'],
        })
    if (!created?.ok) return finish(1, `createBot 失败：${created?.error ?? '未知'}`)
    const botId = created.data?.id
    if (!botId) return finish(1, 'createBot 成功但没有返回机器人 id')

    // 2) 等第一次交账（trial 唤醒 → hub_state_get → hub_commit）。
    await waitFor(async () => {
      const bot = await api.bot(botId)
      return bot.wakes.some((w) => w.status === 'committed')
    }, COMMIT_TIMEOUT_MS, '等第一次交账')

    // H7 观察（手册第 12 节；D05 第 19 条 / D07 第 23 条）：用「预登记 id → 实际 id」
    // 的映射（不随名册迁移）比对实际会话 id——名册会迁到实际 id，用它永远查不出另铸。
    const botView = await api.bot(botId)
    const actualSession = botView.profile.sessionId ?? null
    let mints = []
    try { mints = (await hub.sessionMints?.()) ?? [] } catch { /* 诊断取不到按未知处理 */ }
    const h7Note = h7NoteOf(actualSession, mints)
    const sessionNote = h7Note

    // 3) pokeBot（等同主人发消息）：本回合交账必须带 reply。
    // 记录 poke 之前的 reply 数：判定必须落在 poke 之后的那一条（D05 第 19 条）。
    const threadBeforePoke = await api.thread(botId, { limit: 100 })
    const repliesBeforePoke = threadBeforePoke.messages.filter((m) => m.kind === 'reply').length
    const pokeText = REAL
      ? '请检查一下 hello.txt 在不在，不在就创建它'
      : '冒烟：请交账'
    const poked = await api.command('pokeBot', { botId, text: pokeText })
    if (!poked?.ok) return finish(1, `pokeBot 失败：${poked?.error ?? '未知'}`)

    // 4) 等第二次交账 + 线程里出现「对主人原话的回复」（ownerReplyOf 的判定见上）。
    const replyText = await waitFor(async () => {
      const bot = await api.bot(botId)
      const committed = bot.wakes.filter((w) => w.status === 'committed').length
      if (committed < 2) return null
      const thread = await api.thread(botId, { limit: 100 })
      const replies = thread.messages.filter((m) => m.kind === 'reply')
      return ownerReplyOf(replies, repliesBeforePoke, pokeText, REAL)
    }, COMMIT_TIMEOUT_MS, '等第二次交账与线程回复')

    if (REAL) {
      // 摘要：两次交账的 outcome、reply 原文、每轮步数与 token、工具清单、错误。
      const bot = await api.bot(botId)
      const committedRows = bot.wakes.filter((w) => w.status === 'committed')
        .map((w) => `outcome=${w.outcomeLabel ?? w.outcome}（${w.steps} 步 / ${w.tokens} token）`)
      const uncommitted = bot.wakes.filter((w) => w.status !== 'committed')
        .map((w) => `${w.id}:${w.status}`)
      const parts = [
        realSummary(botId, replyText),
        `两次交账：${committedRows.join('，')}`,
      ]
      if (uncommitted.length > 0) parts.push(`未交账/异常：${uncommitted.join('，')}`)
      parts.push(sessionNote)
      parts.push(settingsCheck.note)
      return finish(0, parts.join('；'))
    }

    // 摘要里报告「禁用工具已被拦截」（D03 先修项 A4）：假模型剧本在试跑回合第一步先调
    // ask_user_question，宿主没拦下的话剧本不会走到交账、上面的等待会超时失败——
    // 所以能走到这里，就证明禁用工具确实被拦下了。
    finish(0, `冒烟通过：机器人 ${botId} 完成两次交账，线程出现 reply；禁用工具已被拦截；${settingsCheck.note}；${sessionNote}`)
  }

  ctx.get('appReady').onReady(() => {
    run().catch((error) => {
      // 真实模式常见的失败是缺凭据或模型不可用：把已捕获的回合错误一并带出来。
      const known = [...new Set([...turnErrors.values()].flat())]
      const extra = known.length > 0 ? `；回合错误：${known.join('；')}` : ''
      finish(1, `冒烟失败：${error?.message ?? String(error)}${extra}`)
    })
  })
}
