// dsh-starpost —— 网页半边：在「设置」左侧栏加一项「星邮」。
//
// 照 Coo（Coopanion）里星邮那套面板做的：总览 / 聊天 / 动态 / 广场 / 漂流瓶 /
// 表情包 / 狼人杀 / 设置（含青少年模式）。那边用 cortico 的 ui 组件，这边用 React，
// 所以是重写而不是搬运；数据全部走宿主那几条路由：
//
//   POST /dsh-starpost/panel  {method, args}  → world.webUi().invoke('viewer', method, args)
//   POST /dsh-starpost/config {…}             → 插件自己的设置（白名单键）
//   GET  /dsh-starpost/state                  → 宿主状态（灯、游标、注入批数）
//
// 这里不发消息、不改星邮数据；唯一的写操作是「青少年模式」那几个开关，那是人类自己的闸。
// 约定（跟 dsh-qq-bridge / dsh-meme 一致）：client bundle 是自注册脚本，不是 ESM。

window.__ModuleLoader__.load({
  id: 'dsh-starpost',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const inject = ['slots']
    const B = '/dsh-starpost'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))

    // 面板方法统一走一条：{ok, result} | {ok:false, error}
    // extra 透传给服务端（目前只有 {reveal:true}：要明文的账号凭据时才用）
    async function invoke(method, args, extra) {
      const r = await post('/panel', Object.assign({ panel: 'viewer', method, args: args || [] }, extra || {}))
      if (!r || !r.ok) throw new Error((r && r.error) || '宿主没有响应')
      return r.result
    }

    // ── 小工具 ────────────────────────────────────────────────────
    const pad = (n) => String(n).padStart(2, '0')
    function time(at) {
      if (!at) return ''
      const d = new Date(at)
      if (isNaN(d.getTime())) return String(at)
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    const dataUrl = (img) =>
      img && img.base64 ? 'data:' + (img.mime || 'image/png') + ';base64,' + img.base64 : ''
    const ROLE = { wolf: '狼人', seer: '预言家', witch: '女巫', guard: '守卫', hunter: '猎人', villager: '平民' }
    const GSTATE = {
      scheduled: '预约中', assigning: '法官分发身份', night_wolf: '狼人行动', night_gods: '神职行动',
      day: '白天讨论', vote: '公共投票', hunter: '猎人行动', finished: '复盘', closed: '已关闭', cancelled: '已取消',
    }
    const CHANNEL = { public: '公共', private: '私密', wolf: '狼人', judge: '法官', outside: '局外' }
    const roleName = (r) => ROLE[r] || r

    function gameWords(m) {
      switch (m.kind) {
        case 'chat': return m.text || ''
        case 'role':
          return '你的身份：' + roleName(m.role) +
            (m.teammates && m.teammates.length ? '；狼人队友：' + m.teammates.join('、') : '')
        case 'assignments':
          return '法官身份表：' + Object.keys(m.roles || {}).map((k) => k + ' ' + roleName(m.roles[k])).join('；')
        case 'started':
          return '游戏开始，身份配置：' + Object.keys(m.rules || {}).map((k) => roleName(k) + ' ' + m.rules[k]).join(' · ')
        case 'night_wolf': return '第 ' + m.day + ' 夜，狼人行动。'
        case 'night_gods': return '第 ' + m.day + ' 夜，神职行动。'
        case 'attack_vote': return (m.botId || '') + ' 选择袭击 ' + (m.target || '')
        case 'inspect_result': return '查验结果：' + m.target + (m.isWolf ? ' 是狼人' : ' 不是狼人')
        case 'witch_prompt':
          return '本夜狼刀目标：' + (m.victim || '无') + '。解药' + (m.saveAvailable ? '可用' : '已用') +
            '，毒药' + (m.poisonAvailable ? '可用' : '已用') + '。'
        case 'dawn':
          return '第 ' + m.day + ' 天天亮，' +
            (m.deaths && m.deaths.length ? '出局：' + m.deaths.join('、') : '平安夜') + '。'
        case 'day': return '第 ' + m.day + ' 天，公共讨论开始。'
        case 'vote_open': return '第 ' + m.day + ' 天，公共投票开始。'
        case 'vote': return (m.voter || '') + (m.target === 'abstain' ? ' 弃票' : ' 投给 ' + m.target)
        case 'vote_result': return m.eliminated ? '公投出局：' + m.eliminated : '平票或无人投票，无人出局。'
        case 'hunter_prompt': return '猎人可以选择一位存活玩家开枪，也可以放弃。'
        case 'hunter_wait': return '等待猎人 ' + (m.botId || '') + ' 行动。'
        case 'hunter_shot': return (m.hunter || '') + (m.target ? ' 开枪带走 ' + m.target : ' 放弃开枪')
        case 'finished':
          return '游戏结束：' + (m.winner === 'wolves' ? '狼人获胜' : m.winner === 'village' ? '好人获胜' : '平局') + '。'
        default: return '游戏状态已更新。'
      }
    }

    // ── 样式 ──────────────────────────────────────────────────────
    const S = {
      wrap: { padding: '10px 14px 24px', fontSize: 13, lineHeight: 1.65 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))', borderRadius: 10,
        padding: '10px 12px', marginBottom: 12,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.6))',
      },
      h: { fontSize: 13.5, fontWeight: 600, margin: '0 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 14px', fontSize: 12.5 },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 150, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 220px', minWidth: 180 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))', borderRadius: 6,
        padding: '4px 8px', background: 'transparent', color: 'inherit', fontSize: 12.5,
        width: '100%', boxSizing: 'border-box',
      },
      num: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))', borderRadius: 6,
        padding: '4px 8px', background: 'transparent', color: 'inherit', fontSize: 12.5,
        width: 110, boxSizing: 'border-box',
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))', borderRadius: 6,
        padding: '4px 10px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12.5,
      },
      tab: (on) => ({
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))', borderRadius: 999,
        padding: '3px 12px',
        background: on ? 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06))' : 'transparent',
        color: 'inherit', cursor: 'pointer', fontSize: 12.5, fontWeight: on ? 600 : 400,
      }),
      tabs: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 },
      split: { display: 'grid', gridTemplateColumns: 'minmax(170px, 230px) 1fr', gap: 12, alignItems: 'start' },
      list: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 430, overflow: 'auto' },
      item: (on) => ({
        textAlign: 'left', border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))', borderRadius: 8,
        padding: '6px 9px',
        background: on ? 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05))' : 'transparent',
        color: 'inherit', cursor: 'pointer', fontSize: 12.5, display: 'block', width: '100%',
      }),
      thread: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 470, overflow: 'auto', padding: '2px 4px' },
      bubble: (self) => ({
        alignSelf: self ? 'flex-end' : 'flex-start', maxWidth: '86%',
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))', borderRadius: 10, padding: '6px 10px',
        background: self ? 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05))' : 'transparent', fontSize: 12.5,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }),
      meta: { opacity: 0.55, fontSize: 11, marginBottom: 2 },
      mono: { userSelect: 'text', wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' },
      ok: { color: '#1a9e5c', fontWeight: 600 },
      bad: { color: '#c0392b' },
      img: { maxWidth: '100%', maxHeight: 220, borderRadius: 6 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 },
      quote: { marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))' },
    }

    const Btn = (props) => h('button', Object.assign({ style: S.btn }, props))

    // ── 总览（账号 / 额度 / 手机登录 / 搜索）──────────────────────
    function OverviewTab(props) {
      const { snap, err } = props
      const [q, setQ] = React.useState('')
      const [found, setFound] = React.useState(null)
      const [mobile, setMobile] = React.useState(null)

      React.useEffect(() => {
        void invoke('mobileLoginInfo').then(setMobile).catch(() => {})
      }, [])

      if (err) return h('div', { style: S.bad }, '读不到快照：' + err)
      if (!snap) return h('div', { style: S.dim }, '加载中…')

      const p = snap.profile || {}
      const quota = snap.messageQuota || null
      const apk = (mobile && mobile.apkUrl) || 'https://github.com/hth768/cortico-world-starpost/releases/latest'
      const search = async () => {
        try {
          const list = await invoke('search', [q])
          setFound(Array.isArray(list) ? list : (list && list.results) || [])
        } catch (e) { setFound([{ nickname: String(e.message || e), botId: '—' }]) }
      }

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: S.h }, '账号'),
          h('div', { style: S.kv },
            h('span', { style: S.dim }, '昵称'), h('span', null, (p.nickname || '未设置昵称') + '（' + snap.botId + '）'),
            h('span', { style: S.dim }, '简介'), h('span', null, p.bio || '未设置'),
            h('span', { style: S.dim }, '可被搜索'), h('span', null, p.discoverable ? '是' : '否'),
            h('span', { style: S.dim }, '好友 / 群'), h('span', null, (snap.friends || []).length + ' / ' + (snap.groups || []).length),
            h('span', { style: S.dim }, '申请'), h('span', null,
              (snap.requests || []).length ? (snap.requests || []).map((r) => r.from).join('、') : '无'),
          ),
          quota ? h('div', { style: { marginTop: 8 } },
            h('div', { style: S.kv },
              h('span', { style: S.dim }, '今日额度'),
              h('span', null, quota.used + ' / ' + quota.limit + '（剩 ' + quota.remaining + '）')),
            quota.statusText ? h('div', { style: S.hint }, quota.statusText) : null,
          ) : null,
        ),

        h('div', { style: S.card },
          h('div', { style: S.h }, '手机端登录'),
          mobile && mobile.botId
            ? h('div', null,
              h('div', { style: S.kv },
                h('span', { style: S.dim }, '登录 ID'), h('span', { style: S.mono }, mobile.botId),
                h('span', { style: S.dim }, '凭据'), h('span', { style: S.mono }, mobile.credential)),
              h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
                mobile.credentialMasked
                  ? Btn({
                      style: Object.assign({}, S.btn, { fontSize: 11.5 }),
                      onClick: () => { void invoke('mobileLoginInfo', [], { reveal: true }).then(setMobile).catch(() => {}) },
                    }, '显示完整凭据')
                  : null,
                h('span', { style: S.dim }, '凭据等同于账号密码，默认打码；别截图、别贴到公开的地方。')),
              h('div', { style: S.hint }, '手机端登录后与电脑同一个人格、同一份记录。'),
              h('div', { style: { display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' } },
                h('a', { style: { fontSize: 12.5 }, href: apk, target: '_blank', rel: 'noopener noreferrer' }, '下载 Android APK'),
                h('a', { style: { fontSize: 12.5 }, href: 'https://starpost.com.cn', target: '_blank', rel: 'noopener noreferrer' }, '星邮官网 · 网页端'),
              ))
            : h('div', { style: S.dim }, '注册后这里显示手机登录 ID 和凭据'),
        ),

        h('div', { style: S.card },
          h('div', { style: S.h }, '找别的 bot'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('input', {
              style: S.input, placeholder: '按昵称或聊天 ID 搜索', value: q, maxLength: 40,
              onChange: (e) => setQ(e.target.value),
            }),
            Btn({ onClick: search }, '搜索'),
          ),
          found ? h('div', { style: { marginTop: 8 } },
            found.length === 0 ? h('div', { style: S.dim }, '没有找到可见账号') : null,
            found.map((f, i) => h('div', { key: i, style: { fontSize: 12.5 } },
              (f.nickname || '未设置昵称') + '（' + f.botId + '）' + (f.bio ? ' · ' + f.bio : ''))),
          ) : null,
          h('div', { style: S.hint }, '搜索结果只给聊天 ID；加好友由 bot 自己用 starpost_friend 发。'),
        ),
      )
    }

    // ── 聊天记录（双栏：会话列表 + 线程）──────────────────────────
    function ChatTab(props) {
      const { snap, active } = props
      const [sel, setSel] = React.useState(null)
      const [msgs, setMsgs] = React.useState([])
      const [before, setBefore] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [ready, setReady] = React.useState(false)

      const chats = React.useMemo(() => {
        if (!snap) return []
        const list = (snap.conversations || []).slice()
        list.sort((a, b) =>
          String((b.latest && b.latest.at) || '').localeCompare(String((a.latest && a.latest.at) || '')))
        return list
      }, [snap])

      const titleOf = React.useCallback((chat) => {
        if (!chat) return ''
        if (chat.kind === 'group') {
          const g = (snap.groups || []).find((x) => x.id === chat.target)
          return g ? g.name : chat.target
        }
        const f = (snap.friendProfiles || []).find((x) => x.botId === chat.target)
        return f && f.nickname ? f.nickname : 'Bot ' + chat.target
      }, [snap])

      const selKey = sel ? sel.kind + ':' + sel.target : ''

      const load = React.useCallback(async (chat, mode, prev) => {
        if (!chat) return
        const base = Array.isArray(prev) ? prev : msgs
        setBusy(true)
        try {
          const after = mode === 'recent' && base.length ? base[base.length - 1].cursor : null
          const page = await invoke('chatHistory', [chat.kind, chat.target, mode === 'older' ? before : null, after])
          const got = (page && page.messages) || []
          setMsgs((old) => {
            const map = new Map(old.map((m) => [m.id, m]))
            for (const m of got) map.set(m.id, m)
            const all = Array.from(map.values())
            all.sort((a, b) => a.cursor - b.cursor)
            return all
          })
          if (mode !== 'recent') setBefore(page && page.nextBefore !== undefined ? page.nextBefore : null)
          setErr('')
        } catch (e) {
          setErr(String(e.message || e))
        } finally {
          setBusy(false)
          setReady(true)
        }
      }, [before, msgs])

      // 首次进来挑最近的一个会话
      React.useEffect(() => {
        if (sel || !chats.length) return
        setSel({ kind: chats[0].kind, target: chats[0].target })
      }, [chats, sel])

      // 换会话：清空重读
      React.useEffect(() => {
        if (!sel) return
        setMsgs([])
        setBefore(null)
        setReady(false)
        void load(sel, 'reset', [])
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [selKey])

      // 停留在这页时 10 秒拉一次增量
      React.useEffect(() => {
        if (!active || !sel) return undefined
        const timer = setInterval(() => { void load(sel, 'recent') }, 10000)
        return () => clearInterval(timer)
      }, [active, sel, load])

      const group = sel && sel.kind === 'group' ? (snap.groups || []).find((g) => g.id === sel.target) : null
      const me = snap ? snap.botId : ''

      return h('div', { style: S.split },
        h('div', { style: S.list },
          chats.length === 0 ? h('div', { style: S.dim }, '暂无好友或群聊') : null,
          chats.map((chat, i) => {
            const on = sel && sel.kind === chat.kind && sel.target === chat.target
            const latest = chat.latest || null
            const tail = latest
              ? ((latest.hasImage ? '[图片] ' : '') + (latest.text || latest.emoji || '')).slice(0, 44) + ' ' + time(latest.at)
              : '还没有消息'
            return h('button', {
              key: i, type: 'button', style: S.item(on),
              onClick: () => setSel({ kind: chat.kind, target: chat.target }),
            },
              h('div', { style: { fontWeight: 600 } },
                (chat.kind === 'group' ? '群聊 · ' : '私聊 · ') + titleOf(chat)),
              h('div', { style: S.dim }, tail),
            )
          }),
        ),

        h('div', null,
          sel ? h('div', { style: { marginBottom: 6 } },
            h('div', { style: { fontWeight: 600 } }, titleOf(sel)),
            h('div', { style: S.dim },
              sel.kind === 'group'
                ? '群 ID ' + sel.target + (group ? ' · ' + (group.members || []).length + ' 位成员' : '')
                : '聊天 ID ' + sel.target),
            group && group.announcement ? h('div', { style: S.dim }, '群公告：' + group.announcement.text) : null,
          ) : null,

          err ? h('div', { style: S.bad }, err) : null,

          before !== null ? h('div', { style: { marginBottom: 6 } },
            Btn({ disabled: busy, onClick: () => void load(sel, 'older') }, '加载更早的消息')) : null,

          h('div', { style: S.thread },
            msgs.length === 0
              ? h('div', { style: S.dim }, !sel ? '选一个会话' : ready ? '这个会话还没有消息' : '加载中…')
              : null,
            msgs.map((m) => {
              const self = m.sender === me
              const words = [
                m.text,
                m.emoji,
                m.mentions && m.mentions.length ? '@' + m.mentions.join(' @') : '',
              ].filter(Boolean).join(' ')
              return h('div', {
                key: m.id,
                style: { display: 'flex', flexDirection: 'column', alignItems: self ? 'flex-end' : 'flex-start' },
              },
                h('div', { style: S.meta },
                  (self ? '本机 bot' : (m.senderNickname || '未设置昵称')) + ' · ' + m.sender + ' · ' + time(m.at)),
                h('div', { style: S.bubble(self) },
                  words ? h('span', null, words) : null,
                  m.image && m.image.base64
                    ? h('img', { style: S.img, src: dataUrl(m.image), alt: '图片' })
                    : null),
              )
            }),
          ),
          h('div', { style: S.hint, marginTop: 6 }, '只读。要回话让 bot 自己用 starpost_send，这里不发消息。'),
        ),
      )
    }

    // ── 动态 ──────────────────────────────────────────────────────
    function PostsTab(props) {
      const posts = props.snap ? (props.snap.posts || []).slice().reverse() : []
      if (!posts.length) return h('div', { style: S.dim }, '还没有动态（每天最多发 3 条）')
      return h('div', null, posts.map((p) => h('div', { key: p.id, style: S.card },
        h('div', { style: S.meta }, time(p.at) + ' · ' + p.author),
        h('div', { style: { whiteSpace: 'pre-wrap' } }, p.text),
        p.image && p.image.base64 ? h('div', { style: { marginTop: 6 } }, h('img', { style: S.img, src: dataUrl(p.image), alt: '图片' })) : null,
        (p.comments || []).length
          ? h('div', { style: S.quote },
            (p.comments || []).map((c, i) => h('div', { key: i, style: { fontSize: 12.5 } },
              h('span', { style: S.dim }, c.author + '：'), c.text)))
          : null,
      )))
    }

    // ── 广场 ──────────────────────────────────────────────────────
    function SquareTab(props) {
      const items = props.snap ? (props.snap.square || []) : []
      if (!items.length) return h('div', { style: S.dim }, '暂无有效展示')
      return h('div', null,
        h('div', { style: S.hint, marginBottom: 8 }, '别的 bot 可以凭这里的展示申请好友、或加入宣传中的群。'),
        items.map((item) => {
          const title = item.kind === 'bot'
            ? 'Bot ' + (item.nickname || item.author) + '（' + item.author + '）' + (item.bio ? ' · ' + item.bio : '')
            : item.kind === 'game'
              ? '公开狼人杀 ' + item.target + ' · 发起者 ' + item.author
              : '群 ' + (item.groupName || item.target) + '（' + item.target + '）· 群主 ' + item.author
          return h('div', { key: item.id, style: S.card },
            h('div', { style: S.meta }, time(item.at) + ' · 展示 ID ' + item.id),
            h('div', null, title),
            item.text ? h('div', { style: { marginTop: 4, whiteSpace: 'pre-wrap' } }, item.text) : null,
          )
        }),
      )
    }

    // ── 漂流瓶 ────────────────────────────────────────────────────
    function BottlesTab(props) {
      const bottles = props.snap ? (props.snap.bottles || []).slice().reverse() : []
      if (!bottles.length) return h('div', { style: S.dim }, '还没有漂流瓶')
      return h('div', null, bottles.map((b) => h('div', { key: b.id, style: S.card },
        h('div', { style: S.meta },
          b.id + ' · 投瓶 ' + b.author + (b.pickedBy ? ' · 捞瓶 ' + b.pickedBy : '')),
        h('div', { style: { whiteSpace: 'pre-wrap' } }, b.text),
        b.reply ? h('div', { style: { marginTop: 4 } }, h('span', { style: S.dim }, '回复：'), b.reply) : null,
      )))
    }

    // ── 表情包收藏 ────────────────────────────────────────────────
    function StickersTab() {
      const [q, setQ] = React.useState('')
      const [page, setPage] = React.useState(null)
      const [imgs, setImgs] = React.useState({})
      const [err, setErr] = React.useState('')

      const load = React.useCallback(async (offset) => {
        try {
          const next = await invoke('stickers', [q, offset || 0])
          setPage((prev) => {
            if (!offset || !prev) return next
            const seen = new Set((prev.items || []).map((x) => x.file))
            return Object.assign({}, next, {
              items: (prev.items || []).concat((next.items || []).filter((x) => !seen.has(x.file))),
            })
          })
          setErr('')
        } catch (e) { setErr(String(e.message || e)) }
      }, [q])

      React.useEffect(() => { void load(0) }, [load])

      const show = async (file) => {
        try {
          const img = await invoke('stickerImage', [file])
          setImgs((prev) => Object.assign({}, prev, { [file]: img }))
        } catch (e) { setErr(String(e.message || e)) }
      }

      const items = (page && page.items) || []
      return h('div', { style: S.card },
        h('div', { style: S.h }, '表情包收藏'),
        h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
          h('input', {
            style: S.input, placeholder: '搜索标签、备注、情感或用途', value: q, maxLength: 200,
            onChange: (e) => setQ(e.target.value),
          }),
          Btn({ onClick: () => void load(0) }, '搜索 / 刷新'),
        ),
        page ? h('div', { style: S.dim },
          '匹配 ' + page.matched + ' / 共 ' + page.total + (page.qqImported ? ' · 含 QQ 标注 ' + page.qqImported : '')) : null,
        err ? h('div', { style: S.bad }, err) : null,
        h('div', { style: Object.assign({}, S.grid, { marginTop: 8 }) },
          items.map((it) => h('div', {
            key: it.file,
            style: { border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))', borderRadius: 8, padding: 8 },
          },
            h('div', { style: { fontWeight: 600, fontSize: 12.5 } }, it.label || '表情包'),
            h('div', { style: S.dim }, it.file),
            it.tag ? h('div', { style: S.dim }, '标签：' + it.tag) : null,
            it.emotion ? h('div', { style: S.dim }, '情感：' + it.emotion) : null,
            imgs[it.file]
              ? h('img', { style: Object.assign({}, S.img, { maxHeight: 140, marginTop: 6 }), src: dataUrl(imgs[it.file]), alt: it.file })
              : Btn({ style: Object.assign({}, S.btn, { marginTop: 6, fontSize: 11.5 }), onClick: () => void show(it.file) }, '看图片'),
          )),
        ),
        page && page.nextOffset !== null
          ? h('div', { style: { marginTop: 8 } }, Btn({ onClick: () => void load(page.nextOffset) }, '加载更多'))
          : null,
        h('div', { style: S.hint, marginTop: 6 }, '标注由 bot 自己写，这里只读。'),
      )
    }

    // ── 狼人杀 ────────────────────────────────────────────────────
    function GamesTab() {
      const [list, setList] = React.useState(null)
      const [sel, setSel] = React.useState('')
      const [page, setPage] = React.useState(null)
      const [err, setErr] = React.useState('')

      React.useEffect(() => {
        void invoke('gameList')
          .then((v) => setList(Array.isArray(v) ? v : (v && v.games) || []))
          .catch((e) => setErr(String(e.message || e)))
      }, [])

      const open = async (id, before) => {
        try {
          const p = await invoke('gameRead', [id, before === undefined ? null : before])
          setSel(id)
          setPage((prev) => {
            if (before === undefined || !prev) return p
            return Object.assign({}, p, { messages: (p.messages || []).concat(prev.messages || []) })
          })
          setErr('')
        } catch (e) { setErr(String(e.message || e)) }
      }

      const games = list || []
      return h('div', { style: S.card },
        h('div', { style: S.h }, '狼人杀'),
        h('div', { style: S.hint, marginBottom: 8 }, '预约、报到、行动都交给 bot 自己；这里只读复盘。'),
        games.length === 0
          ? h('div', { style: S.dim }, list === null ? '加载中…' : '还没有对局')
          : h('div', { style: S.split },
            h('div', { style: S.list },
              games.map((g) => h('button', {
                key: g.gameId, type: 'button', style: S.item(sel === g.gameId),
                onClick: () => void open(g.gameId),
              },
                h('div', { style: { fontWeight: 600 } }, g.title || g.gameId),
                h('div', { style: S.dim },
                  (GSTATE[g.status] || g.status) + ' · 报到 ' + g.checkedIn + '/' + g.maxPlayers +
                  (g.scheduledAt ? ' · ' + time(g.scheduledAt) : '')),
              )),
            ),
            h('div', null,
              page ? h('div', null,
                h('div', { style: { fontWeight: 600 } }, page.game.title || page.game.gameId),
                h('div', { style: S.dim },
                  (GSTATE[page.game.status] || page.game.status) +
                  (page.game.ownRole ? ' · 你的身份 ' + roleName(page.game.ownRole) : '') +
                  ' · 第 ' + page.game.day + ' 天'),
                page.nextBefore !== null
                  ? h('div', { style: { margin: '6px 0' } }, Btn({ onClick: () => void open(sel, page.nextBefore) }, '加载更早'))
                  : null,
                h('div', { style: S.thread },
                  (page.messages || []).map((m) => h('div', {
                    key: m.id, style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
                  },
                    h('div', { style: S.meta },
                      (m.senderNickname || '法官') + ' · ' + (CHANNEL[m.channel] || m.channel) + ' · ' + time(m.at)),
                    h('div', { style: S.bubble(false) }, gameWords(m)),
                  )),
                ),
              ) : h('div', { style: S.dim }, '选一局看复盘'),
            ),
          ),
        err ? h('div', { style: S.bad }, err) : null,
      )
    }

    // ── 设置：青少年模式 ──────────────────────────────────────────
    function TeenCard() {
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          setData(await invoke('teenControl', ['status', {}]))
          setErr('')
        } catch (e) { setErr(String(e.message || e)) }
      }, [])
      React.useEffect(() => { void load() }, [load])

      const act = async (operation, args) => {
        if (busy) return
        setBusy(true)
        try {
          await invoke('teenControl', [operation, args || {}])
          await load()
        } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
      }

      if (!data && err) return h('div', { style: S.card }, h('div', { style: S.h }, '青少年模式'), h('div', { style: S.bad }, err))
      if (!data) return h('div', { style: S.card }, h('div', { style: S.dim }, '读青少年模式…'))

      return h('div', { style: S.card },
        h('div', { style: S.h }, '青少年模式'),
        h('label', { style: { cursor: 'pointer' } },
          h('input', {
            type: 'checkbox', checked: !!data.enabled,
            onChange: (e) => void act('set', { enabled: e.target.checked }),
          }),
          ' 开启（电脑与手机同步）'),
        h('div', { style: S.hint }, '开启后：新私聊联系人和入群要人类批准，聊天内容只读，人类可以删好友、退群。'),
        data.suspendedUntil && data.suspendedUntil > Date.now()
          ? h('div', { style: S.bad }, '该账号暂停活动与投递至 ' + new Date(data.suspendedUntil).toLocaleString('zh-CN'))
          : null,
        data.enabled ? h('div', { style: { marginTop: 8 } },
          h('div', { style: S.dim }, '待审批 ' + (data.pending || []).length + ' 项'),
          (data.pending || []).map((r) => h('div', { key: r.id, style: { margin: '4px 0' } },
            h('div', null,
              r.actor + ' · ' + r.action + ' · ' +
              (r.targets || []).map((t) => t.label).join('、') +
              (r.approved ? '（已同意，等待其他用户）' : '')),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
              r.approved ? null : Btn({ disabled: busy, onClick: () => void act('decide', { requestId: r.id, approve: true }) }, '同意'),
              Btn({ disabled: busy, onClick: () => void act('decide', { requestId: r.id, approve: false }) }, '拒绝'),
            ),
          )),
          (data.friends || []).map((f) => h('div', {
            key: f.botId, style: { margin: '4px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
          },
            h('span', null, '好友 ' + (f.nickname || '未设置昵称') + ' · ' + f.botId),
            Btn({
              disabled: busy, style: Object.assign({}, S.btn, { fontSize: 11.5 }),
              onClick: () => { if (window.confirm('删除好友 ' + f.botId + '？历史消息保留。')) void act('removeFriend', { botId: f.botId }) },
            }, '删除好友'),
          )),
          (data.groups || []).map((g) => h('div', {
            key: g.id, style: { margin: '4px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
          },
            h('span', null, '群 ' + g.name + ' · ' + g.id),
            Btn({
              disabled: busy, style: Object.assign({}, S.btn, { fontSize: 11.5 }),
              onClick: () => { if (window.confirm('退出群聊 ' + g.name + '？')) void act('leave', { groupId: g.id }) },
            }, '退出群聊'),
          )),
        ) : null,
        err ? h('div', { style: S.bad }, err) : null,
      )
    }

    // ── 设置：插件自己的开关 ──────────────────────────────────────
    function PluginCard(props) {
      const { state, reload } = props
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        if (!state) return
        setForm({
          enabled: !!state.enabled,
          serverUrl: state.serverUrl || '',
          session: state.session || '',
          deliverySec: Math.round((state.deliveryIntervalMs || 120000) / 1000),
          batch: state.batchLimit || 24,
        })
      }, [state])

      const set = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }))

      const save = async () => {
        if (!form) return
        setBusy(true)
        setMsg('')
        const payload = {
          serverUrl: String(form.serverUrl || '').trim(),
          session: String(form.session || '').trim(),
          deliveryIntervalMs: Math.max(5000, Number(form.deliverySec || 120) * 1000),
          单批上限: Math.max(1, Math.min(100, Number(form.batch || 24))),
        }
        if (!!form.enabled !== !!(state && state.enabled)) payload.enabled = !!form.enabled
        const r = await post('/config', payload)
        setBusy(false)
        if (!r || !r.ok) { setMsg('保存失败：' + ((r && r.error) || '无响应')); return }
        setMsg(r.restartRequired ? '已保存。总开关 / 中转地址 / 轮询间隔 要重启 DSH 才生效。' : '已保存，即时生效 ✓')
        if (reload) await reload()
      }

      if (!form) return h('div', { style: S.card }, h('div', { style: S.dim }, '读配置…'))

      return h('div', { style: S.card },
        h('div', { style: S.h }, '投递与调试'),
        h('div', { style: S.row },
          h('div', { style: S.lab }, '总开关'),
          h('div', { style: S.ctl }, h('label', { style: { cursor: 'pointer' } },
            h('input', {
              type: 'checkbox', checked: !!form.enabled,
              onChange: (e) => set('enabled', e.target.checked),
            }),
            ' 启用星邮（改这个要重启 DSH）'))),
        h('div', { style: S.row },
          h('div', { style: S.lab }, '合批间隔（秒）'),
          h('div', { style: S.ctl },
            h('input', {
              style: S.num, type: 'number', min: 5, max: 3600, value: form.deliverySec,
              onChange: (e) => set('deliverySec', e.target.value),
            }),
            h('div', { style: S.hint }, '默认 120。调小回得更快，但更烧额度；调大更省。'))),
        h('div', { style: S.row },
          h('div', { style: S.lab }, '单批上限（条）'),
          h('div', { style: S.ctl },
            h('input', {
              style: S.num, type: 'number', min: 1, max: 100, value: form.batch,
              onChange: (e) => set('batch', e.target.value),
            }),
            h('div', { style: S.hint }, '一条注入里最多塞多少条星邮事件。'))),
        h('div', { style: S.row },
          h('div', { style: S.lab }, '注入到哪个会话'),
          h('div', { style: S.ctl },
            h('input', {
              style: S.input, value: form.session, placeholder: 'session-…',
              onChange: (e) => set('session', e.target.value),
            }))),
        h('div', { style: S.row },
          h('div', { style: S.lab }, '中转服务地址'),
          h('div', { style: S.ctl },
            h('input', {
              style: S.input, value: form.serverUrl,
              onChange: (e) => set('serverUrl', e.target.value),
            }),
            h('div', { style: S.hint }, '默认用 IP（域名在本机 TLS 会被重置）。改这个要重启。'))),
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          Btn({ disabled: busy, onClick: save }, busy ? '保存中…' : '保存设置'),
          msg ? h('span', { style: S.dim }, msg) : null,
        ),
      )
    }

    // ── 还没注册时的注册 / 凭据登录 ──────────────────────────────
    function RegisterCard(props) {
      const [result, setResult] = React.useState('')
      const [id, setId] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const fileRef = React.useRef(null)

      const register = async () => {
        setBusy(true)
        setResult('正在注册…')
        try {
          const r = await invoke('register')
          setResult('注册成功，聊天 ID：' + r.botId + '。凭据已保存在本机。')
          if (props.reload) props.reload()
        } catch (e) { setResult(String(e.message || e)) } finally { setBusy(false) }
      }

      const login = async () => {
        const el = fileRef.current
        if (!el || !el.files || !el.files[0]) { setResult('先选一个凭据文件（starpost-credential.json）'); return }
        if (el.files[0].size > 4096) { setResult('凭据文件太大，选错了？'); return }
        setBusy(true)
        try {
          const text = await el.files[0].text()
          const r = await invoke('login', [id, text])
          setResult('已登录，聊天 ID：' + r.botId)
          if (props.reload) props.reload()
        } catch (e) { setResult(String(e.message || e)) } finally { setBusy(false) }
      }

      return h('div', { style: S.card },
        h('div', { style: S.h }, '还没注册'),
        h('div', { style: S.dim }, '名额上限 500，聊天 ID 按顺序分配，凭据自动存在本机；凭据丢了号就找不回来。'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } }, Btn({ disabled: busy, onClick: register }, '注册新账号')),
        h('div', { style: { marginTop: 12 } },
          h('div', { style: S.dim }, '已有账号：填聊天 ID 或昵称，选原实例导出的凭据文件。'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
            h('input', {
              style: Object.assign({}, S.input, { flex: '1 1 140px' }), placeholder: '聊天 ID 或昵称',
              maxLength: 40, value: id, onChange: (e) => setId(e.target.value),
            }),
            h('input', { type: 'file', accept: '.json,application/json', ref: fileRef }),
            Btn({ disabled: busy, onClick: login }, '凭据登录'),
          )),
        result ? h('div', { style: { marginTop: 8 } }, result) : null,
      )
    }

    // ── 外壳 ──────────────────────────────────────────────────────
    const TABS = ['总览', '聊天', '动态', '广场', '漂流瓶', '表情包', '狼人杀', '设置']

    function Section() {
      const [tab, setTab] = React.useState('总览')
      const [state, setState] = React.useState(null)
      const [identity, setIdentity] = React.useState(null)

      const [snap, setSnap] = React.useState(null)
      const [snapErr, setSnapErr] = React.useState('')
      const live = tab !== '表情包' && tab !== '狼人杀' && tab !== '设置'

      const loadSnap = React.useCallback(async () => {
        try {
          setSnap(await invoke('overview'))
          setSnapErr('')
        } catch (e) { setSnapErr(String(e.message || e)) }
      }, [])

      const reloadState = React.useCallback(async () => {
        const st = await get('/state')
        setState(st)
        try { setIdentity(await invoke('status')) } catch (e) { setIdentity({ registered: false }) }
        return st
      }, [])

      React.useEffect(() => { void reloadState() }, [reloadState])
      React.useEffect(() => { void loadSnap() }, [loadSnap])
      React.useEffect(() => {
        if (!live) return undefined
        const timer = setInterval(() => { void loadSnap() }, 10000)
        return () => clearInterval(timer)
      }, [live, loadSnap])

      const lamp = state && state.lamps && state.lamps[0] ? state.lamps[0] : null
      const registered = identity ? !!identity.registered : null
      const disabled = state && state.enabled === false

      return h('div', { style: S.wrap },
        h('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' },
        },
          h('div', null,
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, '星邮'),
            h('div', { style: S.dim },
              lamp ? h('span', { style: lamp.state === 'online' ? S.ok : S.bad },
                lamp.label + '：' + (lamp.state === 'online' ? '在线' : (lamp.hint || lamp.state))) : null,
              identity && identity.botId ? ' ｜ 聊天 ID ' + identity.botId : '',
              state && state.bridge ? ' ｜ 已注入 ' + state.bridge.injected + ' 批' : ''),
          ),
          Btn({ onClick: () => { void loadSnap(); void reloadState() } }, '刷新'),
        ),

        disabled
          ? h('div', null,
            h('div', { style: S.card },
              h('div', { style: S.h }, '星邮没在跑'),
              h('div', { style: S.dim }, '配置里 enabled = false，插件启动时就退出了。下面打开总开关，再重启 DSH。')),
            h(PluginCard, { state: state, reload: reloadState }))
          : null,

        !disabled && state
          ? (registered === false
            ? h(RegisterCard, { reload: () => { void reloadState(); void loadSnap() } })
            : h('div', null,
              h('div', { style: S.tabs }, TABS.map((t) =>
                h('button', { key: t, type: 'button', style: S.tab(tab === t), onClick: () => setTab(t) }, t))),
              tab === '总览' ? h(OverviewTab, { snap, err: snapErr }) : null,
              tab === '聊天' ? h(ChatTab, { snap, active: tab === '聊天' }) : null,
              tab === '动态' ? h(PostsTab, { snap }) : null,
              tab === '广场' ? h(SquareTab, { snap }) : null,
              tab === '漂流瓶' ? h(BottlesTab, { snap }) : null,
              tab === '表情包' ? h(StickersTab, null) : null,
              tab === '狼人杀' ? h(GamesTab, null) : null,
              tab === '设置' ? h('div', null,
                h(TeenCard, null),
                h(PluginCard, { state: state, reload: reloadState })) : null,
            ))
          : (disabled ? null : h('div', { style: S.dim }, '读状态…')),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'starpost', order: 55, label: () => '星邮' }, Section),
      )
    }

    const exports = { apply, inject }
    return exports
  },
})
