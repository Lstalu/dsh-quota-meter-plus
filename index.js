// 会话额度监控（Host 半部）— 记账 / 计费 / 拦截 / HTTP 接口
// 由 cordis.patch.yml 加载；数据通道为 HTTP（/quota 前缀路由）。
// 价目表 v2：定价模式化。每个模型声明 pricing 模式：
//   - per-token     恒定价（多数厂商）：prices = { inputMiss, inputHit, output }
//   - per-token-tod 按 token + 分时段（DeepSeek 峰谷）：prices = { default, peak? }
// 旧 v1 结构（无 pricing）加载时自动归一化为 per-token。
// 持久化：~/.dsh/storages/dsh-quota-meter-plus/prices.json

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UNIT = '¥'

// 默认价目表（人民币，每 1M tokens；DeepSeek 峰谷定价，default=空闲时段、
// peak=高峰时段；可随时在 UI 弹层修改并持久化）。
//
// 计价基准：官方 2026-09-11 中文页直接给人民币价（元/百万 tokens），无汇率折算。
// flash 系列：命中 0.02 / 未命中 1 / 输出 4；pro：命中 0.15 / 未命中 4.5 / 输出 13.5。
// peak = 空闲价 × 2（官方恒为 2 倍，两档数字均直接取自官方页面）。
// 旧版按 2026-08-21 美元价 × 6.78 折算（flash 1.49/0.05/4.47、pro 4.47/0.15/13.42）
// 已废弃：那是国际站美元口径，与中文站人民币价不是同一套数字。
// 峰谷窗口：官方 = 北京 09:00–12:00、14:00–18:00（周一至周五）；周六、周日全天空闲价。
//
// 模型名迁移（2026-09-10 生效）：deepseek-v4.1-flash-expires-on-0910 已失效，
// 正式名为 deepseek-flash；旧名 deepseek-v4-flash / -vision-exp 仍可调用，
// 但请求由 V4.1-Flash 提供服务并按 Flash 价计费，故三条必须同价。
const DEFAULT_PRICES = {
  version: 2,
  unit: UNIT,
  per: '1M',
  fallback: 'deepseek-v4-flash',
  ignored: [],
  plans: [],
  models: {
    'deepseek-flash': {
      provider: 'deepseek',
      pricing: 'per-token-tod',
      tod: { tz: 'Asia/Shanghai', peak: [[9, 12], [14, 18]] },
      prices: {
        default: { inputMiss: 1, inputHit: 0.02, output: 4, inputWrite: 1 },
        peak: { inputMiss: 2, inputHit: 0.04, output: 8, inputWrite: 2 },
      },
    },
    'deepseek-v4-flash': {
      provider: 'deepseek',
      pricing: 'per-token-tod',
      tod: { tz: 'Asia/Shanghai', peak: [[9, 12], [14, 18]] },
      prices: {
        default: { inputMiss: 1, inputHit: 0.02, output: 4, inputWrite: 1 },
        peak: { inputMiss: 2, inputHit: 0.04, output: 8, inputWrite: 2 },
      },
    },
    'deepseek-v4-flash-vision-exp': {
      provider: 'deepseek',
      pricing: 'per-token-tod',
      tod: { tz: 'Asia/Shanghai', peak: [[9, 12], [14, 18]] },
      prices: {
        default: { inputMiss: 1, inputHit: 0.02, output: 4, inputWrite: 1 },
        peak: { inputMiss: 2, inputHit: 0.04, output: 8, inputWrite: 2 },
      },
    },
    'deepseek-v4-pro': {
      provider: 'deepseek',
      pricing: 'per-token-tod',
      tod: { tz: 'Asia/Shanghai', peak: [[9, 12], [14, 18]] },
      prices: {
        default: { inputMiss: 4.5, inputHit: 0.15, output: 13.5, inputWrite: 4.5 },
        peak: { inputMiss: 9, inputHit: 0.3, output: 27, inputWrite: 9 },
      },
    },
  },
}

export const name = 'dsh-quota-meter-plus'
// 0.1.6-alpha.1：apiProxy 服务随 @deepseek-ai/dsh-host-apiproxy 一起被移除。
// 模型目录改为直接消费两个宿主本地服务（与 dsh-api-session-controller 的
// buildModelCatalog 所用的是同一对）：
//   ctx.llm                —— listProviders / listModels / resolveModelInfo
//   ctx.agentDefaultModel  —— currentSelection()
// 见 incidents/2026-09-16-upgrade-016-preflight/ADDENDUM-quota-meter-api-migration.md
export const inject = ['webServer', 'dshHomePath', 'llm', 'agentDefaultModel']

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

// 同源防护：/quota 是本地写接口（改额度 / 改价目表），浏览器里打开的
// 任意外部网页都能向 127.0.0.1 发请求，必须拒绝跨源来源。
// 规则：带 Origin 的请求要求 Origin 的 host 与请求 Host 头完全一致
// （dsh web 页面同源 fetch 天然满足）；无 Origin（curl、本机进程）放行。
function isSameOrigin(req) {
  const origin = req.headers['origin']
  if (!origin || origin === 'null') return true
  try {
    return new URL(origin).host === (req.headers['host'] || '')
  } catch {
    return false
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) { req.destroy(); reject(new Error('body too large')) }
    })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

// DeepSeek 高峰时段为北京时间 9:00-12:00、14:00-18:00（含起点、不含终点）。
// 峰谷规则是【模型属性】：每个 per-token-tod 模型通过 entry.tod 声明自己的
// 时区与高峰区间（{ tz, peak: [[start,end], ...] }），缺省用 DeepSeek 默认。
function hourInTz(tz, date) {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(date || new Date())
    return Number(s) % 24
  } catch {
    const d = new Date((date || new Date()).getTime() + 8 * 3600 * 1000) // 回退 UTC+8
    return d.getUTCHours()
  }
}

// 按模型 tod.tz（默认 Asia/Shanghai）判断是否为周末（周六/周日）。
// 官方新规（2026-08-23 北京时间 00:00 起）：周六、周日全天按空闲价计费。
function isWeekendInTz(tz, date) {
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz || "Asia/Shanghai", weekday: "short" }).format(date || new Date())
    return wd === 'Sat' || wd === 'Sun'
  } catch {
    return false
  }
}

function isPeakTime(tz, peakWindows, date) {
  const d = date || new Date()
  // 周末规则：模型 tz 下的周六/周日恒为 off-peak（不参与高峰窗口判断）
  if (isWeekendInTz(tz || "Asia/Shanghai", d)) return false
  const h = hourInTz(tz || "Asia/Shanghai", d)
  for (const w of peakWindows || []) {
    if (h >= w[0] && h < w[1]) return true
  }
  return false
}

// 校验一组价格（三档必填；inputWrite 可选，缺省 = inputMiss）
// inputWrite = 写缓存 token 单价（cacheWriteTokens 档）。写缓存是真实
// 成本（如 Anthropic cache_creation 按 1.25× 输入价计），缺省按未命中价
// 保守计，避免低估；DeepSeek 不报告 cacheWriteTokens，该档恒为 0。
function parseTriple(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'prices must be an object' }
  const inputMiss = Number(obj.inputMiss)
  const inputHit = Number(obj.inputHit)
  const output = Number(obj.output)
  if (![inputMiss, inputHit, output].every(Number.isFinite) || inputMiss < 0 || inputHit < 0 || output < 0) {
    return { ok: false, reason: 'prices must be non-negative numbers' }
  }
  const inputWrite = obj.inputWrite === undefined ? inputMiss : Number(obj.inputWrite)
  if (!Number.isFinite(inputWrite) || inputWrite < 0) {
    return { ok: false, reason: 'inputWrite must be a non-negative number' }
  }
  return { ok: true, value: { inputMiss, inputHit, output, inputWrite } }
}

// 校验并规整价目表（支持 v1 旧结构与 v2 模式化结构）；失败返回 { ok:false, reason }
function normalizePrices(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'prices must be an object' }
  const raw = input.models
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'prices.models must be an object' }
  const models = {}
  for (const [model, p] of Object.entries(raw)) {
    if (!model || typeof p !== 'object' || p === null) return { ok: false, reason: 'bad model entry for "' + model + '"' }
    const provider = p.provider === undefined ? '' : String(p.provider)
    const pricing = p.pricing === undefined ? 'per-token' : String(p.pricing)
    if (pricing === 'per-token-tod') {
      const def = parseTriple(p.prices && p.prices.default)
      if (!def.ok) return { ok: false, reason: 'model "' + model + '": default ' + def.reason }
      let peak = null
      if (p.prices && p.prices.peak !== undefined) {
        const pk = parseTriple(p.prices.peak)
        if (!pk.ok) return { ok: false, reason: 'model "' + model + '": peak ' + pk.reason }
        peak = pk.value
      }
      // 峰谷时段（模型属性）：{ tz, peak: [[s,e],...] }，缺省 DeepSeek 默认
      let tod = { tz: 'Asia/Shanghai', peak: [[9, 12], [14, 18]] }
      if (p.tod !== undefined) {
        if (typeof p.tod !== 'object' || p.tod === null) return { ok: false, reason: 'model "' + model + '": tod must be an object' }
        const tz = (typeof p.tod.tz === 'string' && p.tod.tz) ? p.tod.tz : 'Asia/Shanghai'
        let windows = [[9, 12], [14, 18]]
        if (p.tod.peak !== undefined) {
          if (!Array.isArray(p.tod.peak) || p.tod.peak.length === 0) return { ok: false, reason: 'model "' + model + '": tod.peak must be a non-empty array' }
          const parsed = []
          for (const w of p.tod.peak) {
            if (!Array.isArray(w) || w.length !== 2) return { ok: false, reason: 'model "' + model + '": tod.peak window must be [start,end]' }
            const s = Number(w[0])
            const e = Number(w[1])
            if (![s, e].every(Number.isFinite) || s < 0 || e > 24 || s >= e) {
              return { ok: false, reason: 'model "' + model + '": tod.peak window must satisfy 0 <= start < end <= 24' }
            }
            parsed.push([s, e])
          }
          windows = parsed
        }
        tod = { tz, peak: windows }
      }
      models[model] = { provider, pricing, tod, prices: { default: def.value, ...(peak ? { peak } : {}) } }
    } else if (pricing === 'per-token') {
      const tri = p.prices ? parseTriple(p.prices) : parseTriple(p) // v2 用 prices，v1 用平铺字段
      if (!tri.ok) return { ok: false, reason: 'model "' + model + '": ' + tri.reason }
      models[model] = { provider, pricing, prices: tri.value }
    } else {
      return { ok: false, reason: 'model "' + model + '": unknown pricing "' + pricing + '"' }
    }
  }
  if (Object.keys(models).length === 0) return { ok: false, reason: 'at least one model required' }
  const fallback = (typeof input.fallback === 'string' && models[input.fallback]) ? input.fallback : Object.keys(models)[0]
  // 用户主动忽略的未配价模型（不再在 UI 提示），随价目表持久化
  const ignored = Array.isArray(input.ignored) ? input.ignored.filter((s) => typeof s === 'string') : []
  // 套餐模型（无具体费用，调用不计费），随价目表持久化
  const plans = Array.isArray(input.plans) ? input.plans.filter((s) => typeof s === 'string') : []
  return { ok: true, prices: { version: 2, unit: UNIT, per: '1M', fallback, models, ignored, plans } }
}

// 按定价模式取当前生效价格组（峰谷规则随模型自己的 tod 声明）
function entryPrices(entry) {
  if (entry.pricing === 'per-token-tod') {
    const tod = entry.tod || { tz: 'Asia/Shanghai', peak: [[9, 12], [14, 18]] }
    const peak = isPeakTime(tod.tz, tod.peak)
    return peak && entry.prices.peak ? entry.prices.peak : entry.prices.default
  }
  return entry.prices
}

export function apply(ctx) {
  // 每会话记账本：{ quota, spent, calls, exhausted }——跟随会话持久化：
  // 惰性从磁盘恢复（~/.dsh/storages/dsh-quota-meter-plus/sessions/<id>.json），
  // 变更即写，会话销毁时删除（与对话记录生命周期一致）
  const ledgers = new Map()
  // 子代理会话 → 根父会话 映射：subagent/start 建立，持久化到子会话文件；
  // 子代理的消耗并入父会话额度（沿链上溯到根父）
  const parentMap = new Map()
  // 进行中的模型调用数（llm/stream 开始 +1 / 结束 -1），供客户端显示"请求中"动效
  let inflightCount = 0
  // 最近一次主调用使用的模型（catalog 查询当前会话模型的兜底）
  let lastModel = null
  // Plan 调用信号：套餐模型调用不计费，客户端显示 "Plan" 徽标代替金额
  let planTick = 0
  let lastPlanModel = null
  // 当前会话模型查询缓存（按 sessionId + TTL 1.5s，避免 1s 轮询每次都重建目录）
  const modelQueryCache = { at: 0, sessionId: null, value: null }

  // 模型目录缓存（TTL 60s）：provider 广告的模型列表变化很慢，避免每次打开弹层都重建。
  // 缓存值形如 { groups, defaultModel }：groups 供未配价列表用，defaultModel 供当前模型兜底。
  // 内联自 @deepseek-ai/dsh-api-session-controller 的 buildModelCatalog(ctx)（packages/api/
  // session-controller/src/catalog.ts）。不 import 内部模块：该包 exports 里只有 "./src/*"
  // 而没有 "./lib/*"，打包产物只发 lib/，跨包 import 会随上游重构而断——所以只依赖两个服务的
  // 公开方法（llm.listProviders / listModels / resolveModelInfo，agentDefaultModel.currentSelection）。
  const catalogCache = { at: 0, groups: null, defaultModel: null }

  async function loadModelCatalog() {
    const now = Date.now()
    if (catalogCache.groups && now - catalogCache.at < 60000) return catalogCache

    let defaultModel = null
    try {
      const sel = ctx.agentDefaultModel && ctx.agentDefaultModel.currentSelection()
      defaultModel = (sel && sel.model) || null
    } catch { /* 服务不可用，保持 null */ }

    let groups = []
    try {
      const providers = ctx.llm.listProviders()
      const built = await Promise.all(providers.map(async (provider) => {
        try {
          const models = await ctx.llm.listModels(provider.id)
          return {
            id: provider.id,
            name: provider.name,
            models: (models || []).map((m) => ({ id: m.id, name: m.name || m.id })),
          }
        } catch { return null }
      }))
      groups = built.filter((g) => g && g.models.length > 0)
    } catch { groups = [] }

    catalogCache.groups = groups
    catalogCache.defaultModel = defaultModel
    catalogCache.at = now
    return catalogCache
  }

  // 查询会话当前使用的模型。0.1.6 的 session/modelCatalog 是无参的部署级目录
  // （buildModelCatalog(ctx) 用的就是 agentDefaultModel.currentSelection()），
  // 不再有「按 sessionId 查当前选中模型」的 RPC；因此这里取部署默认模型，
  // 失败或未选时回退最近一次主调用实际使用的模型（llm/stream 里记录）。
  async function currentModelOf(sessionId) {
    const now = Date.now()
    if (modelQueryCache.sessionId === sessionId && now - modelQueryCache.at < 1500) return modelQueryCache.value
    let value = null
    try {
      const catalog = await loadModelCatalog()
      value = catalog.defaultModel || null
    } catch { /* 查询失败，走兜底 */ }
    if (!value) value = lastModel
    modelQueryCache.sessionId = sessionId
    modelQueryCache.at = now
    modelQueryCache.value = value
    return value
  }

  async function modelCatalogGroups(sessionId) {
    try {
      const catalog = await loadModelCatalog()
      return catalog.groups || []
    } catch { return [] }
  }

  // 目录中未配价的模型（排除已配价/已忽略/Plan），按 provider 分组
  async function catalogUnpricedOf(sessionId) {
    const groups = await modelCatalogGroups(sessionId)
    const priced = prices.models || {}
    const ignored = prices.ignored || []
    const plans = prices.plans || []
    const out = []
    for (const g of groups || []) {
      const items = []
      for (const m of (g.models || [])) {
        const id = m && m.id
        if (!id || priced[id] || ignored.indexOf(id) >= 0 || plans.indexOf(id) >= 0) continue
        items.push(id)
      }
      if (items.length > 0) out.push({ provider: g.id, providerName: g.name || g.id, models: items })
    }
    return out
  }

  const sessionsDir = ctx.dshHomePath('storages', 'dsh-quota-meter-plus', 'sessions')
  const safeId = (id) => String(id).replace(/[^a-zA-Z0-9._-]/g, '_')
  const sessionPath = (id) => join(sessionsDir, safeId(id) + '.json')

  function persistLedger(sessionId, ledger) {
    try {
      mkdirSync(sessionsDir, { recursive: true })
      const data = { quota: ledger.quota, spent: ledger.spent, calls: ledger.calls, unpricedModels: ledger.unpricedModels || [] }
      if (parentMap.has(sessionId)) data.parentId = parentMap.get(sessionId)
      writeFileSync(sessionPath(sessionId), JSON.stringify(data))
    } catch (err) {
      console.warn('[quota] persist ledger failed: ' + err.message)
    }
  }

  function deleteLedgerFile(sessionId) {
    try { if (existsSync(sessionPath(sessionId))) unlinkSync(sessionPath(sessionId)) } catch { /* 忽略 */ }
  }

  // 沿父子链上溯到根父会话（子代理还能派子代理，最多 32 层防环）
  function rootSessionId(sessionId) {
    let cur = sessionId
    let hops = 0
    while (parentMap.has(cur) && hops < 32) {
      cur = parentMap.get(cur)
      hops += 1
    }
    return cur
  }

  // 子代理归属：权威关系在会话 header 里——dsh-subagent 创建子会话时写入
  // parentSession + origin:'subagent'（+ delegationDepth），活着的 Agent 直接
  // 暴露 agent.session.header；dsh-subagent 自己也这么读（authorizeLineage 用
  // handle.agent.session.header.parentSession，listChildren 用
  // record.header.origin === 'subagent' 过滤）。
  //
  // 为什么不用 subagent/start：它的回调只收到 info（runId/provider/id/local）——
  // createLifecycleEmitter 把 parent 当作 scoped dispatch 的 carrier 用掉了
  // （ctx.events.dispatch('emit', [carrier(parent), name, info]) 之后只
  // callback(info)），第二个参数恒为 undefined。旧实现因此改用 tools/result +
  // /^subagent/ 工具名 FIFO 配对：多 agent（AgentTeams）成员经 agent_teams_* 工具
  // spawn，永远配不上，成员消耗留在成员自己的账本里（发起会话的额度条看不见），
  // 成员会话销毁时账本文件还会被 session/disposed 删掉。
  //
  // fork 会话也带 parentSession（seed lineage），但 origin 不是 'subagent'——那是
  // 用户自己开的新对话，不能并账；过滤条件与官方 listChildren 保持一致。
  function adoptFromAgent(agent) {
    const session = agent && agent.session
    const header = session && session.header
    if (!session || !header || header.origin !== 'subagent' || !header.parentSession) return
    const childId = String(session.id)
    const parentId = String(header.parentSession)
    if (childId === parentId || parentMap.has(childId)) return
    try {
      parentMap.set(childId, parentId)
      // 记账目标是根会话（与 llm/stream 的 rootSessionId 口径一致）
      const rootId = rootSessionId(parentId)
      const rootLedger = ledgerOf(rootId)
      // 补归：该子会话此前（旧版本遗留 / 上一个 epoch）已独立记下的消耗
      const childLedger = ledgerOf(childId)
      if (childLedger.spent > 0 || childLedger.calls > 0) {
        rootLedger.spent += childLedger.spent
        rootLedger.calls += childLedger.calls
        childLedger.spent = 0
        childLedger.calls = 0
      }
      if (rootLedger.quota !== null && rootLedger.spent >= rootLedger.quota) rootLedger.exhausted = true
      persistLedger(rootId, rootLedger)
      // 子账本清零并落盘 parentId：重启后 ledgerOf 凭它恢复这张映射表
      persistLedger(childId, childLedger)
      console.log('[quota] subagent merged child=' + childId + ' -> root=' + rootId)
    } catch (err) {
      console.warn('[quota] subagent merge failed: ' + err.message)
    }
  }

  // 价目表：内置默认 + 用户文件覆盖
  const pricesPath = ctx.dshHomePath('storages', 'dsh-quota-meter-plus', 'prices.json')
  let prices = DEFAULT_PRICES
  try {
    if (existsSync(pricesPath)) {
      const norm = normalizePrices(JSON.parse(readFileSync(pricesPath, 'utf8')))
      if (norm.ok) prices = norm.prices
      else console.warn('[quota] prices file ignored: ' + norm.reason)
    }
  } catch (err) {
    console.warn('[quota] failed to load prices file: ' + err.message)
  }

  // ── 账户余额校准（官方 GET /user/balance，见 https://api-docs.deepseek.com/api/get-user-balance）──
  // 用途：定期拉取 DeepSeek 平台真实余额，与插件的会话记账对照校准。
  // 密钥解析顺序：config 文件（用户经 UI 保存）> 环境变量；只用于向
  // api.deepseek.com 发送 HTTPS 请求，绝不回传给客户端 UI。
  const configPath = ctx.dshHomePath('storages', 'dsh-quota-meter-plus', 'config.json')
  let configCache = null
  function loadConfig() {
    if (configCache) return configCache
    configCache = {}
    try {
      if (existsSync(configPath)) {
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
        if (parsed && typeof parsed === 'object') configCache = parsed
      }
    } catch (err) {
      console.warn('[quota] failed to load config: ' + err.message)
    }
    return configCache
  }
  function saveConfig(next) {
    configCache = next
    try {
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, JSON.stringify(next, null, 2), { mode: 0o600 })
    } catch (err) {
      console.warn('[quota] failed to save config: ' + err.message)
    }
  }
  function apiKeyOf() {
    const cfg = loadConfig()
    if (cfg.apiKey) return String(cfg.apiKey)
    return process.env.DSH_DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || ''
  }
  // 余额缓存 60s：顶栏 60s 轮询 + 手动刷新共用，避免重复打官方接口
  const balanceCache = { at: 0, data: null }
  async function fetchBalance() {
    const now = Date.now()
    if (balanceCache.data && now - balanceCache.at < 60000) return balanceCache.data
    const key = apiKeyOf()
    if (!key) return { ok: false, reason: 'no-key' }
    let res = null
    let body = null
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 10000)
      res = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: ctl.signal,
      })
      clearTimeout(timer)
      body = await res.json()
    } catch (err) {
      return { ok: false, reason: 'fetch-failed', detail: String((err && err.message) || err) }
    }
    if (!res || !res.ok) return { ok: false, reason: 'http-' + (res ? res.status : 'unknown') }
    const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : []
    const info = infos.find((i) => i && i.currency === 'CNY') || infos[0]
    if (!info) return { ok: false, reason: 'no-balance-info' }
    const balance = Number(info.total_balance)
    // 基线：首次成功拉取时以当前余额为参考点；之后 realSpent = 基线 - 当前
    const cfg = loadConfig()
    if (cfg.balanceBaseline === undefined || cfg.balanceBaseline === null) {
      cfg.balanceBaseline = balance
      saveConfig(cfg)
    }
    const baseline = Number(cfg.balanceBaseline) || 0
    const data = {
      ok: true,
      balance: Math.round(balance * 100) / 100,
      currency: info.currency || 'CNY',
      isAvailable: !!body.is_available,
      baseline: Math.round(baseline * 100) / 100,
      realSpent: Math.round(Math.max(0, baseline - balance) * 100) / 100,
      updatedAt: now,
    }
    balanceCache.data = data
    balanceCache.at = now
    return data
  }

  function ledgerOf(sessionId) {
    let entry = ledgers.get(sessionId)
    if (entry === undefined) {
      entry = { quota: null, spent: 0, calls: 0, exhausted: false, unpricedModels: [] }
      // 惰性恢复：会话重启后额度/已花从磁盘取回（若有）
      try {
        if (existsSync(sessionPath(sessionId))) {
          const saved = JSON.parse(readFileSync(sessionPath(sessionId), 'utf8'))
          if (saved && typeof saved === 'object') {
            entry.quota = saved.quota === null || saved.quota === undefined ? null : Number(saved.quota) || 0
            entry.spent = Number(saved.spent) || 0
            entry.calls = Number(saved.calls) || 0
            entry.exhausted = entry.quota !== null && entry.spent >= entry.quota
            entry.unpricedModels = Array.isArray(saved.unpricedModels) ? saved.unpricedModels.map(String) : []
            // 恢复子代理映射（子会话文件带 parentId）
            if (saved.parentId) parentMap.set(sessionId, String(saved.parentId))
          }
        }
      } catch (err) {
        console.warn('[quota] failed to restore ledger: ' + err.message)
      }
      ledgers.set(sessionId, entry)
    }
    return entry
  }

  // TokenUsage 字段互斥（dsh 官方语义）：inputTokens=未缓存输入；
  // cacheRead+cacheWrite=缓存输入；outputTokens=输出。计费口径：
  // cacheRead 按命中价、cacheWrite 按 inputWrite 档（缺省=未命中价，
  // 见 parseTriple），输出单独计价。
  function costOf(model, usage) {
    const entry = prices.models[model] || prices.models[prices.fallback]
    const t = entryPrices(entry)
    const miss = usage.inputTokens || 0
    const read = usage.cacheReadTokens || 0
    const write = usage.cacheWriteTokens || 0
    const out = usage.outputTokens || 0
    return (miss * t.inputMiss + read * t.inputHit + write * t.inputWrite + out * t.output) / 1000000
  }

  function round4(v) { return Math.round(v * 10000) / 10000 }

  // 每次模型调用：真实 usage chunk -> 记账（子代理消耗并入根父会话）；
  // 同时维护"请求进行中"计数 + 记录未配价模型
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined) return next()
    const target = rootSessionId(options.sessionId)
    const ledger = ledgerOf(target)
    const model = String(options.model || '')
    // 只有主对话调用点亮"请求中"动效；compaction/session-title 等辅助调用
    // 不参与 inflight 计数，否则后台摘要会让光带在主对话结束后仍继续扫
    const isPrimary = options.purpose === undefined
    if (isPrimary) {
      inflightCount += 1
      if (model) lastModel = model
    }
    return (async function* () {
      try {
        const inner = next()
        for await (const chunk of inner) {
          if (chunk && chunk.type === 'usage' && chunk.usage) {
            const isPlan = !!(model && prices.plans && prices.plans.indexOf(model) >= 0)
            if (isPlan) {
              // 套餐模型：不计费、不计调用、不记未配价；仅发 "Plan" 徽标信号
              if (isPrimary) { planTick += 1; lastPlanModel = model }
              yield chunk
              continue
            }
            // 模型不在价目表 → 记入未配价集合（走 fallback 计价），供客户端提示
            if (model && !prices.models[model] && ledger.unpricedModels.indexOf(model) < 0) {
              ledger.unpricedModels.push(model)
              persistLedger(target, ledger)
            }
            const cost = costOf(model, chunk.usage)
            if (cost > 0) {
              ledger.spent += cost
              ledger.calls += 1
              if (ledger.quota !== null && ledger.spent >= ledger.quota) ledger.exhausted = true
              persistLedger(target, ledger)
              console.log('[quota] session=' + target + ' (child ' + options.sessionId + (target === options.sessionId ? '' : ' -> merged') + ') model=' + model + ' +' + cost.toFixed(6) + ' spent=' + ledger.spent.toFixed(6) + ' calls=' + ledger.calls + ' exhausted=' + ledger.exhausted)
            }
          }
          yield chunk
        }
      } finally {
        if (isPrimary) inflightCount -= 1
      }
    })()
  })

  // 额度耗尽：拦截新的模型调用（ledgerOf：重启后从磁盘恢复额度状态）
  // 同一步先认领子会话：agent/pre-step 由 agent loop 对每个 agent（含子代理）的
  // 每一步派发，payload.agent 就是那个 Agent，且必然早于该步的模型调用——子会话
  // 第一次花钱之前映射一定已经建立（冷恢复/重启后的成员也在这一步补上）。
  // global: true —— agent/pre-step 是作用域事件（routing subject = agent，
  // dsh-scope 的 scoped-events 表把 agent/pre-step 映射到 args[0].agent），
  // 不带 global 的 host 平面监听会被 context filter 过滤掉，子代理的步进收不到
  // （与当初 tools/result 需要 global 是同一个原因）。
  ctx.on('agent/pre-step', async (payload, next) => {
    const session = payload.agent && payload.agent.session
    if (session === undefined) return next()
    adoptFromAgent(payload.agent)
    const ledger = ledgerOf(session.id)
    if (ledger !== undefined && ledger.quota !== null && ledger.exhausted) {
      console.log('[quota] session=' + session.id + ' step rejected (quota exhausted)')
      return { kind: 'reject' }
    }
    return next()
  }, { global: true })

  // 会话关闭：清理记账本（内存 + 磁盘文件 + 子代理映射，与对话记录生命周期一致）
  ctx.on('session/disposed', (session) => {
    if (session) {
      ledgers.delete(session.id)
      parentMap.delete(session.id)
      deleteLedgerFile(session.id)
      console.log('[quota] session=' + session.id + ' disposed, ledger cleared')
    }
  })

  // HTTP 接口（客户端 UI 通过 fetch 调用）
  // GET  /quota/state?sessionId=xxx
  // POST /quota/set   { sessionId, amount }
  // POST /quota/clear { sessionId }
  // GET  /quota/prices
  // POST /quota/prices { ...prices } | { reset: true }
  ctx.webServer.register({
    kind: 'prefix',
    path: '/quota',
    handler: async (req, res) => {
      try {
        // 同源防护（见 isSameOrigin）：外部网页跨源调用 /quota 直接 403
        if (!isSameOrigin(req)) {
          sendJson(res, 403, { ok: false, reason: 'forbidden: cross-origin request' })
          return
        }
        const url = new URL(req.url || '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') || ''

        if (req.method === 'GET' && url.pathname === '/quota/prices') {
          // 附带目录中未配价模型（完整目录扫描，无需用户先调用即可提示）
          const catalogUnpriced = await catalogUnpricedOf(sessionId)
          // 峰谷模型当前时段状态（供价格弹层卡片标注"高峰中/空闲中"）
          const todStatus = {}
          for (const [name, m] of Object.entries(prices.models || {})) {
            if (m.pricing === 'per-token-tod') {
              todStatus[name] = {
                peak: isPeakTime(m.tod.tz, m.tod.peak),
                tod: { tz: m.tod.tz, peak: m.tod.peak },
              }
            }
          }
          sendJson(res, 200, { ok: true, prices, catalogUnpriced, todStatus })
          return
        }

        if (req.method === 'POST' && url.pathname === '/quota/prices') {
          const body = await readJsonBody(req)
          if (body && body.reset) {
            prices = DEFAULT_PRICES
            try { if (existsSync(pricesPath)) unlinkSync(pricesPath) } catch { /* 忽略 */ }
            console.log('[quota] prices reset to default')
            sendJson(res, 200, { ok: true, prices })
            return
          }
          // 忽略/Plan 标记操作（逐个，持久化到价目表）：
          // ignore/unignore = 按默认价粗算且不再提示；plan/unplan = 套餐模型不计费
          if (body && (body.ignore !== undefined || body.unignore !== undefined || body.plan !== undefined || body.unplan !== undefined)) {
            const addOp = body.ignore !== undefined || body.plan !== undefined
            const name = String(addOp ? (body.ignore !== undefined ? body.ignore : body.plan) : (body.unignore !== undefined ? body.unignore : body.unplan)).trim()
            if (!name) { sendJson(res, 400, { ok: false, reason: 'model name required' }); return }
            const isPlan = body.plan !== undefined || body.unplan !== undefined
            const list = (isPlan ? (prices.plans || []) : (prices.ignored || []))
            const set = new Set(list)
            if (addOp) set.add(name)
            else set.delete(name)
            // 同一模型不应同时出现在 ignored 与 plans：标记时从另一组移除
            const other = isPlan ? (prices.ignored || []) : (prices.plans || [])
            const otherSet = new Set(other)
            otherSet.delete(name)
            prices = Object.assign({}, prices,
              isPlan ? { plans: [...set], ignored: [...otherSet] } : { ignored: [...set], plans: [...otherSet] })
            try {
              mkdirSync(dirname(pricesPath), { recursive: true })
              writeFileSync(pricesPath, JSON.stringify(prices, null, 2))
            } catch (err) {
              sendJson(res, 500, { ok: false, reason: 'persist failed: ' + err.message })
              return
            }
            sendJson(res, 200, { ok: true, prices })
            return
          }
          const norm = normalizePrices(body)
          if (!norm.ok) { sendJson(res, 400, { ok: false, reason: norm.reason }); return }
          prices = norm.prices
          try {
            mkdirSync(dirname(pricesPath), { recursive: true })
            writeFileSync(pricesPath, JSON.stringify(prices, null, 2))
          } catch (err) {
            sendJson(res, 500, { ok: false, reason: 'persist failed: ' + err.message })
            return
          }
          console.log('[quota] prices updated: ' + Object.keys(prices.models).join(', '))
          sendJson(res, 200, { ok: true, prices })
          return
        }

        if (req.method === 'GET' && url.pathname === '/quota/state') {
          // ledgerOf：重启后惰性从磁盘恢复额度/已花（而非只看内存）
          const ledger = ledgerOf(sessionId)
          const inflight = inflightCount > 0
          const unpricedModels = (ledger && ledger.unpricedModels) || []
          // 当前会话选中的模型 + 是否未配价（决定额度条徽标显隐，切换模型即时生效；
          // Plan 套餐模型不计费也不提示）
          const currentModel = await currentModelOf(sessionId)
          const currentUnpriced = !!currentModel && !prices.models[currentModel] && !((prices.plans || []).indexOf(currentModel) >= 0)
          // 当前模型峰谷状态：per-token-tod 模型按自己声明的 tod 判断当前是否高峰；其他为 null
          const entry = currentModel ? prices.models[currentModel] : undefined
          const peak = entry && entry.pricing === 'per-token-tod'
            ? isPeakTime(entry.tod.tz, entry.tod.peak)
            : null
          const base = {
            unit: UNIT, inflight, unpricedModels, currentModel, currentUnpriced, peak,
            planTick, lastPlanModel,
          }
          const out = ledger === undefined
            ? Object.assign({ quota: null, spent: 0, calls: 0, exhausted: false }, base)
            : Object.assign({ quota: ledger.quota, spent: round4(ledger.spent), calls: ledger.calls, exhausted: ledger.exhausted }, base)
          sendJson(res, 200, out)
          return
        }
        // 账户真实余额（官方 /user/balance；未配置 Key 时返回 reason:'no-key'）
        if (req.method === 'GET' && url.pathname === '/quota/balance') {
          sendJson(res, 200, await fetchBalance())
          return
        }
        // 插件配置：{ apiKey } 设置密钥；{ clearKey: true } 显式清除密钥；
        // { resetBaseline: true } 重设余额基线
        if (req.method === 'POST' && url.pathname === '/quota/config') {
          const body = await readJsonBody(req)
          const cfg = Object.assign({}, loadConfig())
          if (body && body.apiKey !== undefined) {
            // 留空保存视为"保留现有 Key"，不再清除——避免在 ⚙ 弹层误点保存清空密钥。
            const key = String(body.apiKey).trim()
            if (key) {
              cfg.apiKey = key
              saveConfig(cfg)
              console.log('[quota] api key configured')
            } else {
              console.log('[quota] api key save skipped (empty; existing key kept)')
            }
          } else if (body && body.clearKey === true) {
            // 独立显式清除（前端带确认后触发），补回被"留空不覆盖"拿掉的清空能力
            cfg.apiKey = ''
            saveConfig(cfg)
            console.log('[quota] api key cleared')
          } else if (body && body.resetBaseline === true) {
            cfg.balanceBaseline = undefined
            saveConfig(cfg)
            console.log('[quota] balance baseline reset')
          } else {
            sendJson(res, 400, { ok: false, reason: 'unknown config op' })
            return
          }
          sendJson(res, 200, { ok: true, hasKey: !!cfg.apiKey, baselineSet: cfg.balanceBaseline !== undefined })
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          // sessionId 优先取 query string；body 里的 sessionId 作为兜底（客户端两种传法都兼容）
          const sid = sessionId || (body && body.sessionId) || ''
          if (url.pathname === '/quota/set') {
            const amount = Number(body && body.amount)
            if (!Number.isFinite(amount) || amount <= 0) {
              sendJson(res, 400, { ok: false, reason: 'amount must be a positive number' })
              return
            }
            const ledger = ledgerOf(sid)
            ledger.quota = amount
            ledger.exhausted = ledger.spent >= amount
            persistLedger(sid, ledger)
            console.log('[quota] session=' + sid + ' quota set to ' + amount)
            sendJson(res, 200, { ok: true, quota: amount, spent: round4(ledger.spent), calls: ledger.calls, exhausted: ledger.exhausted, unit: UNIT })
            return
          }
          if (url.pathname === '/quota/clear') {
            const ledger = ledgerOf(sid)
            if (ledger !== undefined) {
              ledger.quota = null
              ledger.exhausted = false
              persistLedger(sid, ledger)
            }
            sendJson(res, 200, { ok: true })
            return
          }
        }
        sendJson(res, 404, { ok: false, reason: 'not found' })
      } catch (err) {
        sendJson(res, 500, { ok: false, reason: String((err && err.message) || err) })
      }
    },
  })
}
