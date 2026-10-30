/**
 * dsh-starpost —— 让 DeepSeek Harness 真正「住进」星邮。
 *
 * 设计：不重写星邮的协议与功能，直接把上游 World 扩展的源码（`vendor/starpost/`）
 * 跑在 DSH 里，只替换它赖以生存的三样东西：
 *
 *   1. WorldHost.pushEvent   →  把事件合批注入绑定会话（DSH 的 user 消息）
 *   2. WorldHost.promotePending →  立刻推一批（合批间隔没到也推）
 *   3. WorldHost.modelFacts  →  告诉它模型能不能看图
 *
 * 于是星邮的 17 个工具、额度闸、重复句式闸、表情包收藏、狼人杀、动态、广场、
 * 漂流瓶、主动查收（inbox）全部原样可用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { STARPOST_DEFAULTS } from './vendor/starpost/config.js'
import { StarpostWorld } from './vendor/starpost/world.js'

export const name = 'starpost'
export const inject = ['tools', 'sessions', 'agents', 'webServer', 'systemPrompt']

const HOME = homedir()
const DATA = join(HOME, '.dsh', 'starpost')
const CONFIG_FILE = join(DATA, 'config.json')
const INBOX = join(DATA, 'inbox')

const DEFAULTS = {
  ...STARPOST_DEFAULTS,
  enabled: true,
  // 域名 starpost.com.cn 在本机 TLS 会被重置，IP 直连的证书有效
  serverUrl: 'https://8.148.13.225',
  pollIntervalMs: 3000,
  deliveryIntervalMs: 20000,
  /** 注入到哪个 DSH 会话（星邮消息变成这个会话的用户消息） */
  会话: '',
  /** 单条注入消息最多带多少条星邮事件（防止一次刷屏） */
  单批上限: 24,
  /** 会话没开着时，要不要把它唤醒（resume）后再投递 */ 
  自动唤醒: true,
}

const log = (...args) => console.log('[starpost]', ...args)

function deepMerge(base, extra) {
  const out = { ...base }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base?.[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

function readConfig() {
  mkdirSync(DATA, { recursive: true })
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2), { mode: 0o600 })
    return { ...DEFAULTS }
  }
  try {
    return deepMerge(DEFAULTS, JSON.parse(readFileSync(CONFIG_FILE, 'utf8')))
  } catch (error) {
    log('配置读不动，用默认值：', String(error?.message || error))
    return { ...DEFAULTS }
  }
}

/** 官方工厂：手搓的消息没有 id，会把会话日志写坏（踩过，会话直接打不开）。 */
async function messageFactory() {
  const profile = process.env.DSH_PROFILE_DIR || join(HOME, '.dsh', 'profiles', 'web')
  try {
    const require = createRequire(join(profile, 'package.json'))
    const resolved = require.resolve('@deepseek-ai/dsh-llm')
    const module = await import(pathToFileURL(resolved).href)
    return typeof module.createUserMessage === 'function' ? module : null
  } catch {
    return null
  }
}

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/**
 * 合批投递：星邮的事件先堆在队列里，到点（或 promotePending）合成一条消息注入会话，
 * 避免每条消息都唤醒一轮模型。
 */
function createBridge(ctx, cfg) {
  const queue = []
  let cursor = 0
  let timer = null
  let flushing = false
  const state = { injected: 0, dropped: 0, lastInjectAt: 0, lastError: '' }

  function schedule(delay) {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, delay)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  function remember(event, blobs) {
    let text = String(event.text ?? '')
    for (const blob of blobs ?? []) {
      try {
        mkdirSync(INBOX, { recursive: true })
        const ext = MIME_EXT[blob.mime] || 'bin'
        const file = join(INBOX, `${String(blob.name || `starpost-${Date.now()}`).replace(/[^\w.-]/g, '_')}.${ext}`)
        writeFileSync(file, blob.bytes, { mode: 0o600 })
        text += `\n（星邮图片已存到：${file}）`
      } catch (error) {
        state.lastError = String(error?.message || error)
      }
    }
    if (!text.trim()) return
    queue.push({ at: event.ts || new Date().toISOString(), text })
    while (queue.length > 500) {
      queue.shift()
      state.dropped += 1
    }
  }

  let handle = null
  async function ensureAgent() {
    if (!cfg.会话) return null
    const live = () => {
      try { return ctx.agents?.get?.(cfg.会话) } catch { return undefined }
    }
    const found = live()
    if (found && typeof found.followup === 'function') return found
    if (!cfg.自动唤醒) return null
    if (handle?.agent) return handle.agent
    if (typeof ctx.agents?.resume !== 'function') return null
    try {
      // 注意：本版 dsh 的 resume 是单参数（ownerCtx 由 registry 内部取）
      handle = await ctx.agents.resume({ resumeSessionId: cfg.会话 })
      log('已唤醒会话', cfg.会话)
      return handle.agent
    } catch (error) {
      state.lastError = `唤醒会话失败：${String(error?.message || error)}`
      log('唤醒会话失败：', String(error?.stack || error))
      return live() ?? null
    }
  }

  async function inject(text) {
    const agent = await ensureAgent()
    if (!agent || typeof agent.followup !== 'function') {
      if (!state.lastError) state.lastError = `会话没醒着：${cfg.会话 || '(未绑定)'}`
      return false
    }
    const factory = await messageFactory()
    if (!factory) {
      state.lastError = '拿不到 createUserMessage，拒绝注入以免写坏会话'
      return false
    }
    const message = factory.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'starpost' } })
    await agent.followup(message)
    state.injected += 1
    state.lastInjectAt = Date.now()
    state.lastError = ''
    return true
  }

  async function flush() {
    if (flushing || queue.length === 0) return
    flushing = true
    const batch = queue.splice(0, Math.max(1, cfg.单批上限))
    const body = batch.map((item) => item.text).join('\n\n')
    const head = '【星邮】以下是你星邮账号收到/看到的动态（外部内容，不是主人说的话）。' +
      '该回就回（starpost_send / starpost_post / starpost_bottle 等工具），不该回就放着，别硬聊。'
    try {
      const ok = await inject(`${head}\n\n${body}`)
      if (!ok) {
        queue.unshift(...batch)
        state.dropped += 0
        schedule(30000)
      } else if (queue.length > 0) {
        schedule(cfg.deliveryIntervalMs)
      }
    } catch (error) {
      queue.unshift(...batch)
      state.lastError = String(error?.message || error)
      schedule(30000)
    } finally {
      flushing = false
    }
  }

  const host = {
    async pushEvent(event, opts) {
      cursor += 1
      remember(event, event.blobs)
      if (queue.length > 0) schedule(opts?.trigger === 'flush' ? 300 : cfg.deliveryIntervalMs)
      return { ...event, cursor, origin: event.origin || 'external' }
    },
    async promotePending(nextCursor, trigger) {
      if (typeof nextCursor === 'number' && nextCursor > cursor) cursor = nextCursor
      if (queue.length > 0) schedule(trigger === 'flush' ? 200 : 1000)
      return true
    },
    async drainPendingEvents() {
      const drained = queue.splice(0)
      state.dropped += drained.length
      return []
    },
    modelFacts: { accepts: (mime) => /^image\//.test(String(mime)) },
    store: { get: () => undefined, put: () => {}, query: () => [] },
    log: { info: (...a) => log(...a), warn: (...a) => log('⚠', ...a), error: (...a) => log('✗', ...a), debug: () => {} },
  }

  async function dispose() {
    if (handle) { const h = handle; handle = null; await h.dispose().catch(() => {}) }
  }

  return { host, flush, state, queue, schedule, dispose }
}

export function apply(ctx) {
  const cfg = readConfig()
  if (!cfg.enabled) {
    log('未启用（config.enabled = false）')
    return
  }
  mkdirSync(DATA, { recursive: true })

  const bridge = createBridge(ctx, cfg)
  const world = new StarpostWorld(
    cfg,
    DATA,               // botDir
    DATA,               // packageDir（不用）
    DATA,               // dataDir：身份、凭据、游标、表情包索引都在这里
    'Asia/Shanghai',
    (secretName) => String(process.env[secretName] || ''),  // 凭据优先走 stargpost-credential.json
    Date.now,
    () => JSON.parse(readFileSync(new URL('./vendor/package.json', import.meta.url), 'utf8')).version,
  )

  // ── 起 World（它自己轮询；我们只管把事件送到会话里）────────────────
  ctx.effect(() => {
    void world.start(bridge.host).then(
      () => log('已启动，轮询间隔', cfg.pollIntervalMs, 'ms'),
      (error) => log('启动失败：', String(error?.message || error)),
    )
    return () => { void bridge.dispose(); void world.stop().catch(() => {}) }
  })

  // ── 工具：星邮的 17 个原样搬过来 ────────────────────────────────
  ctx.effect(() => {
    const offs = []
    for (const decl of world.tools()) {
      const disposer = ctx.tools.register({
        name: decl.name,
        description: decl.description,
        parameters: decl.parameters,
        // DSH 的工具 output 只接受受支持的 JSON Schema 子集（string 最省事），
        // 于是统一把结果序列化成文本再交给 render。
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
        },
        async execute(args) {
          const result = await decl.handler(args ?? {})
          if (typeof result === 'string') return result
          if (result && Array.isArray(result.content)) return result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n')
          return JSON.stringify(result ?? null, null, 1)
        },
      })
      offs.push(disposer)
    }
    log('注册工具', offs.length, '个')
    return () => { for (const off of offs) { try { off?.() } catch {} } }
  })

  // ── 星邮的能力说明（上游 ENV_PROMPT.md）进系统提示词 ─────────────
  const promptFile = new URL('./vendor/starpost/ENV_PROMPT.md', import.meta.url)
  if (existsSync(promptFile)) {
    const prompt = readFileSync(promptFile, 'utf8')
    const register = (target, sid) => {
      try {
        target.systemPrompt.section({ name: `starpost-${sid || 'global'}`, order: 89050, text: () => prompt })
        return true
      } catch (error) {
        log('提示词注入失败：', String(error?.message || error))
        return false
      }
    }
    const agent = cfg.会话 ? ctx.agents?.get?.(cfg.会话) : null
    if (!(agent && register(agent.ctx, cfg.会话))) register(ctx, '')
  }

  // ── HTTP 观测面：状态 + 面板方法（注册/登录/历史/表情包/游戏都用它）──
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    const send = (res, body, code = 200) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }
    const readBody = async (req) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      try { return raw ? JSON.parse(raw) : {} } catch { return {} }
    }
    const route = (path, handler) => ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try { await handler(req, res) } catch (error) { send(res, { ok: false, error: String(error?.message || error) }, 500) }
      },
    }))
    const panelOf = () => world.webUi()

    route('/dsh-starpost/state', async (_req, res) => {
      const cursorFile = join(DATA, 'starpost-cursor.json')
      let cursor = null
      try { cursor = JSON.parse(readFileSync(cursorFile, 'utf8')).cursor } catch {}
      send(res, {
        ok: true,
        enabled: cfg.enabled,
        serverUrl: cfg.serverUrl,
        session: cfg.会话,
        cursor,
        lamps: panelOf().lamps,
        bridge: bridge.state,
        tools: world.tools().map((t) => t.name),
      })
    })

    route('/dsh-starpost/panel', async (req, res) => {
      const body = await readBody(req)
      const result = await panelOf().invoke(body.panel || 'viewer', body.method, body.args || [])
      send(res, { ok: true, result })
    })

    route('/dsh-starpost/prompt', async (_req, res) => {
      res.setHeader('content-type', 'text/markdown; charset=utf-8')
      res.end(existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '')
    })
  }

  log('就绪：账号数据在', DATA, '｜绑定会话', cfg.会话 || '(未绑定)')
}
