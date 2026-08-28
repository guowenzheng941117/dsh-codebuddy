'use strict'
/**
 * dsh-codebuddy — CodeBuddy（腾讯云账号）接入插件（服务端）
 *
 * 原理：通过 ctx.llm.registerAdapter(['codebuddy'], adapter) 注册一个
 * provider 路由，让 CodeBuddy 订阅内的模型出现在 DSH 模型选择器里。
 *
 * 认证（与 dsh-opencode-zen 的 API key 方式不同）：
 * - 复用本机 CodeBuddy 客户端"web auth 授权一次"产生的账号会话文件。
 *   目录随系统自动定位（linux 还兼容 XDG_DATA_HOME）：
 *     win32 : %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\
 *     darwin: ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/
 *     linux : ~/.local/share/CodeBuddyExtension/Data/Public/auth/
 *   **自动发现**：默认扫描目录里全部 *.info 会话（每个宿主一个，如
 *   Tencent-Cloud.coding-copilot / workbuddy-desktop），按健康度自动择优——
 *   未过期优先于仅可刷新，同级取剩余有效期长者；损坏/加密的文件自动跳过。
 *   显式设置 DSH_CODEBUDDY_AUTH_ID 才锁定单一文件（找不到会报错）。
 * - 每个请求携带 Authorization: Bearer <accessToken> + X-User-Id（+ X-Domain），
 *   与 CodeBuddy 官方客户端的 AuthenticationHttpInterceptor 行为一致（源码逆向）。
 * - accessToken 临期（默认提前 5 分钟）时：优先重读会话文件（官方客户端可能已刷新），
 *   仍过期则用 refreshToken 调 POST /v2/plugin/auth/token/refresh 换新——
 *   结果只存内存、不回写文件，避免与官方客户端并发写冲突。
 * - 也支持纯手工注入：环境变量 DSH_CODEBUDDY_ACCESS_TOKEN（+ 可选
 *   DSH_CODEBUDDY_USER_ID / DSH_CODEBUDDY_DOMAIN），完全绕开会话文件。
 *
 * 上游：{DSH_CODEBUDDY_BASE:-https://copilot.tencent.com}/v2/chat/completions，
 * OpenAI 兼容流式（SSE：delta.content / delta.reasoning_content / delta.tool_calls / [DONE]）。
 *
 * 模型目录动态化：启动即拉 GET {base}/v3/config（逆向自 CloudProductManager，
 * 需账号凭据 + "CLI/<ver> CodeBuddy/<ver>" UA），取官方实时模型清单——上下文
 * 窗口、最大输出按上游真实数据热替换（默认每 6 小时，内存换表不重启）；失败
 * 沿用 models.json 静态表，连续失败按 30s→5min 指数退避。
 * DSH_CODEBUDDY_DISABLE_MODEL_FETCH=1 关闭。
 *
 * 能力位（思考档位/识图）全自动，无需手工配置：
 * - 思考档位优先级：models.json 显式声明 > 内置能力映射（BUILTIN_CAPABILITIES，
 *   按网关实测 + 各模型族最大思考程度内置，普遍到 max）> 上游
 *   reasoning.supportedEfforts > 推理模型默认全档。实测网关接受度比上游声明宽
 *   （hy4-preview 声明仅 high，实测 low/max 均可），故不完全按 CodeBuddy 的来。
 * - 识图：动态目录走上游 supportsImages 标识，静态条目走内置映射自动补齐。
 *
 * 稳定性：流空闲看门狗、429/5xx 指数退避、空流重试、半截断流自动续跑
 * （策略沿用 dsh-opencode-zen 的恢复矩阵，参数按付费网关放宽）。
 *
 * 注入：llm（注册 adapter）
 */

const { readFileSync, readdirSync, existsSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')

const name = 'dsh-codebuddy'
const inject = ['llm']

const PROVIDER = 'codebuddy'
/** 上游网关：日志与实测均落在此域（可用 DSH_CODEBUDDY_BASE 覆盖） */
const CODEBUDDY_BASE = (process.env.DSH_CODEBUDDY_BASE || 'https://copilot.tencent.com').replace(/\/+$/, '')
/** 会话文件对应的产品认证 id（product.json authentication.id）。
 *  仅作回退/展示默认值：未显式设置 DSH_CODEBUDDY_AUTH_ID 时，插件会自动
 *  扫描 auth 目录里全部 .info 会话并择优（见 discoverSession）。 */
const AUTH_ID = process.env.DSH_CODEBUDDY_AUTH_ID || 'Tencent-Cloud.coding-copilot'
/** 刷新接口的路径前缀（产品配置 authentication.attributes.prefixPath） */
const PREFIX_PATH = process.env.DSH_CODEBUDDY_PREFIX_PATH || '/plugin'

const MODELS_FILE = join(__dirname, '..', 'models.json')
const LOG_FILE = join(tmpdir(), 'dsh-codebuddy.log')
let PKG_VERSION = '0.0.0'
try { PKG_VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))?.version || PKG_VERSION } catch { /* keep default */ }

/** 内置模型能力映射（联网核实各厂商官方文档 + 网关实测，2026-08-28）：
 *  efforts = 支持的思考档位（词汇 low/high/max），vision = 识图能力，
 *  context = 最大上下文（输入上限），maxTokens = 最大输出。
 *  CodeBuddy /v3/config 的数值普遍偏保守甚至错误（例：hy3 标 192K 实为 256K，
 *  deepseek-v4 输出标 50K 实为 384K，glm-5.x 输出标 48K/32K 实为 128K，
 *  minimax-m3 标 512K 实为 1M），因此上下文与输出以本映射核实值为准。
 *  实测网关接受度也比上游 supportedEfforts 声明更宽：hy4-preview 上游仅声明
 *  high，实际 low/max 均 200 且真实产出思考内容；各家族推理模型 max 档全部通过。
 *  优先级：models.json 显式声明 > 本映射 > 上游声明（本映射缺失时才参考）。 */
const BUILTIN_CAPABILITIES = {
  'hy3':               { efforts: ['low', 'high', 'max'], vision: true, context: 256000, maxTokens: 131072 },
  'hy3-x':             { efforts: ['low', 'high', 'max'], vision: true, context: 256000, maxTokens: 131072 },
  'hy4-preview':       { efforts: ['low', 'high', 'max'], vision: true, context: 1000000, maxTokens: 64000 },
  'hy4-preview-x':     { efforts: ['low', 'high', 'max'], vision: true, context: 1000000, maxTokens: 64000 },
  'deepseek-v4-pro':   { efforts: ['low', 'high', 'max'], vision: true, context: 1000000, maxTokens: 393216 },
  'deepseek-v4-flash': { efforts: ['low', 'high', 'max'], vision: true, context: 1000000, maxTokens: 393216 },
  'glm-5.3':           { efforts: ['low', 'high', 'max'], vision: true, context: 1000000, maxTokens: 131072 },
  'glm-5.3-flash':     { efforts: ['low', 'high', 'max'], vision: true, context: 1000000, maxTokens: 131072 },
  'glm-5.2':           { efforts: ['low', 'high', 'max'], vision: true, context: 1000000, maxTokens: 131072 },
  'glm-5.1':           { efforts: ['low', 'high', 'max'], vision: true, context: 202745, maxTokens: 131072 },
  'glm-5v-turbo':      { efforts: ['low', 'high', 'max'], vision: true, context: 200000, maxTokens: 131072 },
  'glm-4.6v':          { efforts: ['low', 'high', 'max'], vision: true, context: 128000, maxTokens: 32000 },
  'kimi-k3-1':         { efforts: ['low', 'high', 'max'], vision: true, context: 1000000, maxTokens: 32000 },
  'kimi-k2.7':         { efforts: ['low', 'high', 'max'], vision: true, context: 256000, maxTokens: 32000 },
  'kimi-k2.6':         { efforts: ['low', 'high', 'max'], vision: true, context: 256000, maxTokens: 32000 },
  'kimi-k2.5':         { efforts: ['low', 'high', 'max'], vision: true, context: 256000, maxTokens: 32000 },
  'kimi-k2-thinking':  { efforts: ['low', 'high', 'max'], vision: false, context: 164000, maxTokens: 32000 },
  'minimax-m3':        { efforts: ['low', 'high', 'max'], vision: true, context: 1000000, maxTokens: 128000 },
  'minimax-m2.7':      { efforts: ['low', 'high', 'max'], vision: true, context: 204800, maxTokens: 48000 },
}

/** 内置默认表：仅当 models.json 缺失或损坏时兜底使用
 *  （能力位由内置映射 applyBuiltinCapabilities 补齐） */
const DEFAULT_MODELS = [
  { id: 'hy3', name: 'Hunyuan 3', contextWindow: 256000, description: '腾讯混元 Hy3' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, description: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, description: 'DeepSeek V4 Flash' },
]

/**
 * 模型清单外置化：优先读取插件根目录的 models.json（接受 { "models": [...] }
 * 或裸数组；每项至少要有字符串 id 字段）。上下文窗口等参数为联网核实的
 * 官方规格，按你的订阅实际能力改 models.json 即可，重启 dsh web 生效。
 */
function loadModels() {
  try {
    if (existsSync(MODELS_FILE)) {
      const raw = JSON.parse(readFileSync(MODELS_FILE, 'utf8'))
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : null
      if (Array.isArray(list) && list.length > 0 && list.every((m) => m && typeof m.id === 'string' && m.id.length > 0)) {
        return list
      }
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_MODELS
}

/**
 * 静态条目能力位补齐：未显式声明 reasoningEfforts / input / contextWindow /
 * maxTokens 的，按内置映射（联网核实值）自动补上——思考档位、识图、上下文
 * 都不用手工配；显式声明（含 null = 关闭）不覆盖。
 */
function applyBuiltinCapabilities(list) {
  return list.map((m) => {
    const builtin = BUILTIN_CAPABILITIES[m.id]
    if (!builtin) return m
    return {
      ...m,
      ...(m.reasoningEfforts === undefined && builtin.efforts ? { reasoningEfforts: builtin.efforts } : {}),
      ...(m.input === undefined && typeof builtin.vision === 'boolean' ? { input: builtin.vision ? ['text', 'image'] : ['text'] } : {}),
      ...(m.contextWindow === undefined && builtin.context ? { contextWindow: builtin.context } : {}),
      ...(m.maxTokens === undefined && builtin.maxTokens ? { maxTokens: builtin.maxTokens } : {}),
    }
  })
}

const MODELS = applyBuiltinCapabilities(loadModels())
const STATIC_MODELS_BY_ID = new Map(MODELS.map((m) => [m.id, m]))

// ---------------------------------------------------------------------------
// 运行时模型目录（/v3/config 自动拉取）
// ---------------------------------------------------------------------------

/** 模型目录刷新周期（小时）；插件运行期内存热替换，无需重启 dsh */
const MODELS_REFRESH_MS = Math.max(1, Number(process.env.DSH_CODEBUDDY_MODELS_REFRESH_H) || 6) * 3600 * 1000
/** 置 1 完全关闭自动拉取，只用 models.json 静态表 */
const MODEL_FETCH_DISABLED = process.env.DSH_CODEBUDDY_DISABLE_MODEL_FETCH === '1'
/** /v3/config 按 UA 里的产品版本号做校验；官方网关未来可能拒绝过老版本 */
const CLI_UA_VERSION = process.env.DSH_CODEBUDDY_UA_VERSION || '2.137.1'
/** 目录拉取连续失败退避（参照官方 ModelsProductProvider）：30s 起步、倍增、封顶 5min */
const CATALOG_BACKOFF_MIN_MS = 30 * 1000
const CATALOG_BACKOFF_MAX_MS = 5 * 60 * 1000

const VENDOR_LABELS = { j: '腾讯混元', e: '智谱', f: '生态' }

/**
 * 拉取官方产品配置（逆向自 CloudProductManager：GET {base}/v3/config，
 * 需账号凭据 + 形如 "CLI/<ver> CodeBuddy/<ver>" 的 UA，否则 12403）。
 * 返回 {models:[插件格式条目], fetchedAt, total, whitelistCount}。
 */
async function fetchModelCatalog(auth) {
  const res = await fetch(`${CODEBUDDY_BASE}/v3/config`, {
    headers: {
      'Accept': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
      ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
      ...(auth.domain ? { 'X-Domain': auth.domain } : {}),
      'User-Agent': `CLI/${CLI_UA_VERSION} CodeBuddy/${CLI_UA_VERSION}`,
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`model catalog HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const cfg = await res.json()
  const data = cfg?.data ?? cfg
  const all = Array.isArray(data?.models) ? data.models : []
  // cli agent 的模型白名单 = 官方认可的可对话模型（顺带滤掉图像生成等非对话模型）
  const agents = Array.isArray(data?.agents) ? data.agents : []
  const whitelistAgent = agents.find((a) => a?.name === 'cli')
    || agents.find((a) => Array.isArray(a?.tags) && a.tags.includes('default'))
    || agents.find((a) => Array.isArray(a?.models))
  const whitelist = Array.isArray(whitelistAgent?.models) ? whitelistAgent.models : null
  const usable = all.filter((m) => m && typeof m.id === 'string' && m.id !== 'default' && Number(m.maxInputTokens) > 0 && (!whitelist || whitelist.includes(m.id)))
  if (!usable.length) throw new Error(`model catalog returned no usable chat models (upstream total: ${all.length})`)
  return {
    models: usable.map(toModelEntry),
    fetchedAt: Date.now(),
    total: all.length,
    whitelistCount: whitelist?.length ?? usable.length,
  }
}

/** 上游模型条目 → 插件模型条目。
 *  思考档位：models.json 显式声明 > 内置能力映射 > 上游 supportedEfforts > 推理模型默认全档
 *  上下文/输出：models.json 显式声明 > 内置核实值 > 上游 maxInput/OutputTokens
 *  （CodeBuddy 上游数值普遍偏保守，联网核实值优先）
 *  识图：上游 supportsImages 标识优先（自动），缺失时查内置映射，无需手工配置 */
function toModelEntry(m) {
  const stat = STATIC_MODELS_BY_ID.get(m.id)
  const builtin = BUILTIN_CAPABILITIES[m.id]
  const label = [VENDOR_LABELS[m.vendor] || m.vendor, m.credits].filter(Boolean).join(' · ')
  const upstreamEfforts = Array.isArray(m.reasoning?.supportedEfforts)
    ? m.reasoning.supportedEfforts.filter((e) => ['low', 'high', 'max'].includes(e))
    : []
  let reasoningEfforts
  if (stat && stat.reasoningEfforts !== undefined) reasoningEfforts = stat.reasoningEfforts
  else if (builtin?.efforts) reasoningEfforts = builtin.efforts
  else if (upstreamEfforts.length) reasoningEfforts = upstreamEfforts
  else reasoningEfforts = (m.supportsReasoning || m.onlyReasoning) ? ['low', 'high', 'max'] : null
  const vision = Array.isArray(stat?.input) ? stat.input.includes('image')
    : typeof m.supportsImages === 'boolean' ? (m.supportsImages && !m.disabledMultimodal)
    : (builtin?.vision ?? false)
  const contextWindow = Number(stat?.contextWindow) || builtin?.context || Number(m.maxInputTokens)
  const maxTokens = Number(stat?.maxTokens) || builtin?.maxTokens || Number(m.maxOutputTokens) || undefined
  return {
    id: m.id,
    name: m.name || m.id,
    contextWindow,
    maxTokens,
    description: stat?.description || m.descriptionZh || m.descriptionEn || label || 'CodeBuddy 云端模型',
    reasoningEfforts,
    input: vision ? ['text', 'image'] : ['text'],
  }
}

const REASONING_LEVELS = [
  { id: 'off', name: 'Off', description: '不思考，最快' },
  { id: 'low', name: 'Low', description: '轻量思考' },
  { id: 'high', name: 'High', description: '深度思考（默认）' },
  { id: 'max', name: 'Max', description: '极限思考' },
]
const DEFAULT_REASONING = 'high'
/** dsh 推理等级 → 上游 reasoning_effort 词汇；off = 不发该字段 */
const REASONING_WIRE_MAP = { off: undefined, low: 'low', high: 'high', max: 'high' }
const DEFAULT_REASONING_EFFORTS = ['low', 'high']

function pickReasoningEffort(level, model) {
  if (!level) return undefined
  const raw = model?.reasoningEfforts
  if (raw === null || raw === false) return undefined
  const allowed = Array.isArray(raw) && raw.length > 0 ? raw : DEFAULT_REASONING_EFFORTS
  if (allowed.includes(level)) return level
  const wire = REASONING_WIRE_MAP[level]
  if (wire && allowed.includes(wire)) return wire
  if (level === 'off') return undefined
  return allowed.includes('high') ? 'high' : allowed.includes('low') ? 'low' : allowed[0]
}

function inputModalitiesOf(m) {
  return Array.isArray(m?.input) && m.input.includes('image') ? ['text', 'image'] : ['text']
}

const DEFAULT_MAX_TOKENS = 32768
const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60000
const MAX_REQUEST_ATTEMPTS = 8
const RETRY_BUDGET_MS = 60000
const CONNECT_TIMEOUT_MS = 45000

/** 断流自愈（沿用 zen 的恢复矩阵，付费网关更稳，参数放宽） */
const MAX_CONTINUATIONS = 3
const EMPTY_STREAM_RETRIES = 2
const CONTINUE_NUDGE = '继续：从刚才中断的地方接着输出，不要重复已经输出的内容。'
const TRUNC_BACKOFF_BASE_MS = 2000
const TRUNC_BACKOFF_CAP_MS = 20000

/** accessToken 临期阈值：距过期不足 5 分钟就提前换，避免请求途中过期 */
const REFRESH_SKEW_MS = 5 * 60 * 1000

/** 图片输入：像素预算（对齐官方视觉通道口径） */
const DEFAULT_MAX_IMAGE_PIXELS = 640000
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024

function log(ctx, level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] [dsh-codebuddy] ${msg}`
  try { appendFileSync(LOG_FILE, line + '\n') } catch { /* noop */ }
  try {
    const fn = ctx?.logger?.[level]
    if (typeof fn === 'function') { fn(line); return }
    const c = typeof console?.[level] === 'function' ? console[level] : console.log
    c(line)
  } catch { /* noop */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function sleepOrAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(aborted()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function aborted() {
  const e = new Error('CodeBuddy request aborted by caller')
  e.code = 'ABORTED'
  return e
}

/** JWT 形态校验：at-rest 加密一旦启用，字段会变成密文，这里能第一时间识别并给出可读错误 */
function looksLikeJwt(s) {
  return typeof s === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s)
}

/** 个别构建里字符串字段会被二次 JSON 编码（"\"x\""），防御性解包 */
function unwrap(v) {
  if (typeof v === 'string' && v.length >= 2 && v.startsWith('"')) {
    try { const d = JSON.parse(v); if (typeof d === 'string') return d } catch { /* keep raw */ }
  }
  return v
}

// ---------------------------------------------------------------------------
// 会话（账号授权）管理
// ---------------------------------------------------------------------------

function candidateAuthDirs() {
  switch (process.platform) {
    case 'win32':
      return [join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
    case 'darwin':
      return [join(homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
    default: {
      // Linux：优先 XDG_DATA_HOME，回退官方默认 ~/.local/share
      const dirs = []
      const xdg = process.env.XDG_DATA_HOME
      if (xdg) dirs.push(join(xdg, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
      dirs.push(join(homedir(), '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
      return dirs
    }
  }
}

function authDir() {
  const dirs = candidateAuthDirs()
  return dirs.find((d) => existsSync(d)) || dirs[0]
}

/** 枚举 auth 目录里全部 .info 会话文件（每个宿主一个，如 Tencent-Cloud.coding-copilot / workbuddy-desktop） */
function listAuthFiles() {
  let entries = []
  try { entries = readdirSync(authDir()) } catch { return [] }
  return entries.filter((f) => f.endsWith('.info')).map((f) => join(authDir(), f))
}

/** 解析单个会话文件：无 accessToken 返回 null，文件损坏/字段加密抛可读错误 */
function loadSessionFromPath(file) {
  if (!existsSync(file)) return null
  let j
  try { j = JSON.parse(readFileSync(file, 'utf8')) } catch {
    throw new Error(`CodeBuddy session file is not valid JSON: ${file}`)
  }
  const accessToken = unwrap(j?.auth?.accessToken)
  if (!accessToken) return null
  if (!looksLikeJwt(accessToken)) {
    throw new Error(
      `CodeBuddy session field accessToken is unreadable (at-rest encryption likely enabled by the host). ` +
      `Provide DSH_CODEBUDDY_ACCESS_TOKEN manually instead. (file: ${file})`,
    )
  }
  return {
    accessToken,
    refreshToken: unwrap(j?.auth?.refreshToken) || '',
    tokenType: unwrap(j?.auth?.tokenType) || 'Bearer',
    domain: unwrap(j?.auth?.domain) || '',
    expiresAt: Number(j?.auth?.expiresAt) || 0,
    refreshExpiresAt: Number(j?.auth?.refreshExpiresAt) || 0,
    uid: unwrap(j?.account?.uid) || '',
    enterpriseId: unwrap(j?.account?.enterpriseId) || '',
    source: file,
  }
}

/**
 * 会话健康度打分（自动择优依据）：
 * 未过期(2 级) > 仅可刷新(1 级) > 彻底失效(0)；同级里剩余有效期长者胜。
 */
function sessionScore(s) {
  const now = Date.now()
  const fresh = !s.expiresAt || s.expiresAt > now
  const renewable = !!s.refreshToken && (!s.refreshExpiresAt || s.refreshExpiresAt > now)
  if (!fresh && !renewable) return 0
  const tier = fresh ? 2 : 1
  const remainDays = s.expiresAt ? Math.max(0, (s.expiresAt - now) / 86400000) : 0
  return tier * 1000 + Math.min(remainDays, 90)
}

/**
 * 自动发现最优会话：
 * - 显式设了 DSH_CODEBUDDY_AUTH_ID → 只用指定文件（找不到/不可读如实报错）
 * - 未设置 → 扫描 auth 目录全部 .info，跳过损坏/加密的，取得分最高者
 */
function discoverSession() {
  const override = process.env.DSH_CODEBUDDY_AUTH_ID
  if (override) {
    const file = join(authDir(), `${override}.info`)
    const s = loadSessionFromPath(file)
    if (!s) throw new Error(`CodeBuddy session not usable: ${file} missing or empty. Remove DSH_CODEBUDDY_AUTH_ID to auto-discover, or log in with that host first.`)
    return s
  }
  const candidates = []
  let lastError = null
  for (const f of listAuthFiles()) {
    try {
      const s = loadSessionFromPath(f)
      if (s) candidates.push(s)
    } catch (err) { lastError = err }
  }
  if (!candidates.length) {
    if (lastError) throw lastError
    return null
  }
  candidates.sort((a, b) => sessionScore(b) - sessionScore(a))
  return candidates[0]
}

/** 兼容封装（smoke-test / 日志用）：返回自动发现的最优会话，可能为 null */
function loadSessionFile() { return discoverSession() }

/** 供日志/报错引用的会话路径：发现到的最优文件，否则给默认期望路径 */
function authFilePath() {
  try {
    const s = discoverSession()
    if (s?.source) return s.source
  } catch { /* 发现过程出错时回退到默认路径展示 */ }
  return join(authDir(), `${process.env.DSH_CODEBUDDY_AUTH_ID || AUTH_ID}.info`)
}

/**
 * 会话管理：文件读取 → 内存缓存 → 临期刷新。
 * 刷新结果只存内存不回写会话文件——官方客户端（TUI/IDE/WorkBuddy）也在
 * 读写同一个文件，并发写会互相覆盖；官方进程下次自己会刷新并落盘。
 */
class SessionManager {
  constructor(ctx) {
    this.ctx = ctx
    this.cached = null       // {accessToken, refreshToken, uid, domain, enterpriseId, expiresAt, source}
    this.refreshing = null   // 并发去重：同一时刻只跑一次刷新
  }

  /** 手工注入优先（完全绕开会话文件） */
  envSession() {
    const token = process.env.DSH_CODEBUDDY_ACCESS_TOKEN
    if (!token) return null
    return {
      accessToken: token,
      refreshToken: process.env.DSH_CODEBUDDY_REFRESH_TOKEN || '',
      tokenType: 'Bearer',
      domain: process.env.DSH_CODEBUDDY_DOMAIN || '',
      expiresAt: Number(process.env.DSH_CODEBUDDY_EXPIRES_AT) || 0,
      refreshExpiresAt: 0,
      uid: process.env.DSH_CODEBUDDY_USER_ID || '',
      enterpriseId: process.env.DSH_CODEBUDDY_ENTERPRISE_ID || '',
      source: 'env',
    }
  }

  /** 拿当前可用凭据：缓存未过期直接用；临期先重读文件再走刷新 */
  async getAuth() {
    const env = this.envSession()
    if (env) {
      // env 模式不做自动刷新（除非同时给了 refresh token 与过期时间）
      if (env.expiresAt && env.expiresAt - REFRESH_SKEW_MS < Date.now() && env.refreshToken) {
        return this.refresh(env)
      }
      return env
    }
    const now = Date.now()
    if (this.cached && (!this.cached.expiresAt || this.cached.expiresAt - REFRESH_SKEW_MS > now)) {
      return this.cached
    }
    // 过期/临期：先重读文件——官方客户端可能已经刷新过了
    let session = null
    try { session = loadSessionFile() } catch (err) {
      if (!this.cached) throw err
      log(this.ctx, 'warn', `session file reload failed (${err.message}); using cached credentials`)
    }
    if (session && (!session.expiresAt || session.expiresAt - REFRESH_SKEW_MS > now)) {
      this.cached = session
      return session
    }
    const base = session || this.cached
    if (!base) throw new Error(`No CodeBuddy session found in ${authDir()} (auto-scanned *.info). Log in once with the codebuddy CLI / WorkBuddy (web auth), or set DSH_CODEBUDDY_ACCESS_TOKEN.`)
    if (!base.refreshToken) {
      if (base.expiresAt && base.expiresAt < now) throw new Error('CodeBuddy session expired and no refresh token available; please re-login with the codebuddy CLI.')
      return base // 没有过期时间信息，交给网关裁决
    }
    if (base.refreshExpiresAt && base.refreshExpiresAt < now) {
      throw new Error('CodeBuddy refresh token expired; please re-login with the codebuddy CLI (web auth).')
    }
    return this.refresh(base)
  }

  /** 401 后强制失效缓存：下一次 getAuth 会重读文件（别的进程可能刚刷新过） */
  invalidate() { this.cached = null }

  async refresh(base) {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(base).finally(() => { this.refreshing = null })
    }
    return this.refreshing
  }

  async doRefresh(base) {
    const url = `${CODEBUDDY_BASE}/v2${PREFIX_PATH}/auth/token/refresh`
    log(this.ctx, 'info', `refreshing CodeBuddy access token via ${url}`)
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Refresh-Token': base.refreshToken,
          'X-Auth-Refresh-Source': 'plugin',
          ...(base.uid ? { 'X-User-Id': base.uid } : {}),
          ...(base.domain ? { 'X-Domain': base.domain } : {}),
          ...(base.enterpriseId ? { 'X-Enterprise-Id': base.enterpriseId, 'X-Tenant-Id': base.enterpriseId } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(20000),
      })
    } catch (err) {
      throw new Error(`CodeBuddy token refresh transport error: ${err.message}`)
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) throw new Error(`CodeBuddy token refresh HTTP ${res.status}: ${text.slice(0, 300)}`)
    let payload
    try { payload = JSON.parse(text)?.data?.data } catch { /* handled below */ }
    const accessToken = payload?.accessToken
    if (!accessToken || !looksLikeJwt(accessToken)) {
      throw new Error(`CodeBuddy token refresh returned no usable accessToken: ${text.slice(0, 300)}`)
    }
    const now = Date.now()
    const next = {
      accessToken,
      refreshToken: payload?.refreshToken || base.refreshToken,
      tokenType: payload?.tokenType || 'Bearer',
      domain: payload?.domain || base.domain,
      expiresAt: payload?.expiresAt || now + (Number(payload?.expiresIn) || 5184000) * 1000,
      refreshExpiresAt: payload?.refreshExpiresAt || now + (Number(payload?.refreshExpiresIn) || 7776000) * 1000,
      uid: base.uid,
      enterpriseId: base.enterpriseId,
      source: 'refreshed-in-memory',
    }
    this.cached = next
    log(this.ctx, 'info', 'CodeBuddy access token refreshed (kept in memory; session file untouched)')
    return next
  }
}

// ---------------------------------------------------------------------------
// 请求体序列化（Harness 消息 → OpenAI chat.completions wire）
// ---------------------------------------------------------------------------

function flattenText(content) {
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return typeof content === 'string' ? content : ''
}

function blocksOf(content, type) {
  return Array.isArray(content) ? content.filter((b) => b.type === type) : []
}

function hasImageDeep(blocks) {
  return Array.isArray(blocks) && blocks.some((b) => b.type === 'image' || (b.type === 'tool-result' && hasImageDeep(b.content)))
}

function imageDataUrl(v) {
  const buf = Buffer.isBuffer(v.data) ? v.data : Buffer.from(v.data)
  // 依据魔数判型：PNG 优先，其余按 JPEG 兜底
  const mime = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${buf.toString('base64')}`
}

/**
 * 将 Harness 消息转成请求体。视觉走原生多模态（CodeBuddy 网关直接吃
 * image_url），与 zen 的"描述旁路"不同——付费通道没有免费档的降采样拒绝问题。
 */
async function serializeMessages(messages, systemPrompt, loadImage) {
  const wire = []
  if (systemPrompt) wire.push({ role: 'system', content: systemPrompt })
  for (const m of messages || []) {
    const role = m.role
    if (role === 'system') { wire.push({ role: 'system', content: flattenText(m.content) }); continue }
    if (role === 'assistant') {
      const text = flattenText(m.content)
      const reasoning = blocksOf(m.content, 'reasoning').map((b) => b.text).join('')
      // 历史里的 arguments 必须是合法 JSON 串，否则严格网关会 400 并毒化整条会话
      const toolCalls = blocksOf(m.content, 'tool-call').map((b) => {
        let args = b.arguments
        if (typeof args === 'string' && args.length > 0) {
          try { JSON.parse(args) } catch { args = JSON.stringify({ _raw: args }) }
        } else {
          args = '{}'
        }
        return { id: b.id, type: 'function', function: { name: b.name, arguments: args } }
      })
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length) msg.tool_calls = toolCalls
      wire.push(msg)
      continue
    }
    const toolResults = blocksOf(m.content, 'tool-result')
    // 用户消息带图且模型支持视觉 → 组装 text + image_url 多模态内容
    if (role === 'user' && loadImage && toolResults.length === 0 && hasImageDeep(m.content)) {
      const parts = []
      let text = ''
      const flush = () => { const t = text.trim(); if (t) parts.push({ type: 'text', text: t }); text = '' }
      const walk = async (bs) => {
        for (const b of bs || []) {
          if (b.type === 'text') text += b.text
          else if (b.type === 'image') {
            flush()
            try {
              const v = await loadImage(b.attachment)
              if (v?.data) parts.push({ type: 'image_url', image_url: { url: imageDataUrl(v) } })
              else parts.push({ type: 'text', text: '[image unavailable]' })
            } catch (err) {
              parts.push({ type: 'text', text: `[image unavailable: ${err?.message || 'load failed'}]` })
            }
          } else if (b.type === 'tool-result') await walk(b.content)
        }
      }
      await walk(m.content)
      flush()
      wire.push({ role: 'user', content: parts.length ? parts : flattenText(m.content) })
      continue
    }
    const text = flattenText(m.content)
    if (text || toolResults.length === 0) wire.push({ role: 'user', content: text })
    for (const r of toolResults) {
      wire.push({ role: 'tool', tool_call_id: r.toolCallId, content: flattenText(r.content) || '(no output)' })
    }
  }
  return wire
}

function serializeTools(tools) {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

// ---------------------------------------------------------------------------
// SSE 解析与流翻译（OpenAI 兼容 chunk → DSH 块事件）
// ---------------------------------------------------------------------------

async function* parseSse(response, marks) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') { if (marks) marks.done = true; return }
        try { yield JSON.parse(data) } catch { /* 忽略坏行 */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** 流空闲看门狗：连续 N 毫秒无字节才中止，慢速长思考流不被总时长腰斩 */
function attachIdleWatch(response, controller, signal, onIdleFire) {
  if (!response.body || !(DEFAULT_STREAM_IDLE_TIMEOUT_MS > 0)) return response
  const raw = response.body.getReader()
  let timer = setTimeout(onIdle, DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  function onIdle() { onIdleFire?.(); try { controller.abort() } catch { /* already aborted */ } }
  function reset() { clearTimeout(timer); if (!controller.signal.aborted) timer = setTimeout(onIdle, DEFAULT_STREAM_IDLE_TIMEOUT_MS) }
  const stop = () => clearTimeout(timer)
  controller.signal.addEventListener('abort', stop, { once: true })
  signal?.addEventListener('abort', stop, { once: true })
  return Object.create(response, {
    body: { value: { getReader() {
      return {
        read: async () => {
          let r
          try { r = await raw.read() } finally { reset() }
          return r
        },
        releaseLock: () => { stop(); try { raw.releaseLock() } catch { /* already released */ } },
      }
    }, enumerable: true } },
  })
}

function backoffDelay(attempt, retryAfterMs) {
  if (retryAfterMs > 0) return Math.min(retryAfterMs, 15000)
  return Math.round(Math.min(800 * 2 ** attempt, 5000) * (0.9 + Math.random() * 0.2))
}

function truncationBackoff(step) {
  const base = Math.min(TRUNC_BACKOFF_BASE_MS * 2 ** step, TRUNC_BACKOFF_CAP_MS)
  return Math.round(base * (0.65 + Math.random() * 0.7))
}

function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens || 0
  return {
    inputTokens: (usage.prompt_tokens || 0) - (cacheRead || 0),
    outputTokens: usage.completion_tokens || 0,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
  }
}

/**
 * 流翻译器：把上游 OpenAI SSE chunk 流翻译成 DSH 块事件。
 * 有状态——跨多次上游请求累积同一个块上下文，断流续跑时 UI 无感衔接。
 */
class StreamTranslator {
  constructor(estimateInput) {
    this.estimateInput = estimateInput
    this.nextIndex = 0
    this.textBlock = null
    this.reasoningBlock = null
    this.toolBlocks = new Map()
    this.order = []
    this.finish = null
    this.usage = null
    this.sawFinishReason = false
  }

  get openedBlocks() { return this.order.length > 0 }

  get continuable() {
    return this.toolBlocks.size === 0 && Boolean(this.reasoningBlock || this.textBlock)
  }

  #ensureValidArgs(block) {
    if (block.kind !== 'tool-call' || block.argsQuarantined) return
    try { JSON.parse(block.text) } catch {
      block.text = JSON.stringify({ _truncated: true, _raw: block.text })
      block.argsQuarantined = true
    }
  }

  quarantinePartialTools() {
    for (const b of this.order) this.#ensureValidArgs(b)
    this.toolBlocks.clear()
  }

  snapshotPartial() {
    return {
      reasoning: this.reasoningBlock?.text || '',
      text: this.textBlock?.text || '',
    }
  }

  #open(kind) {
    const block = { index: this.nextIndex++, kind, text: '' }
    this.order.push(block)
    return block
  }

  *feed(chunk) {
    const choices = chunk.choices || []
    for (const choice of choices) {
      const delta = choice.delta || {}
      const rc = delta.reasoning_content
      if (typeof rc === 'string' && rc.length > 0) {
        if (!this.reasoningBlock) {
          this.reasoningBlock = this.#open('reasoning')
          yield { type: 'block-start', index: this.reasoningBlock.index, blockType: 'reasoning' }
        }
        this.reasoningBlock.text += rc
        yield { type: 'reasoning-delta', index: this.reasoningBlock.index, text: rc }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        if (!this.textBlock) {
          this.textBlock = this.#open('text')
          yield { type: 'block-start', index: this.textBlock.index, blockType: 'text' }
        }
        this.textBlock.text += content
        yield { type: 'text-delta', index: this.textBlock.index, text: content }
      }
      for (const call of delta.tool_calls || []) {
        const idx = call.index || 0
        let block = this.toolBlocks.get(idx)
        if (!block) {
          block = this.#open('tool-call')
          this.toolBlocks.set(idx, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        const fn = call.function || {}
        if (call.id) block.callId = call.id
        if (fn.name) block.name = fn.name
        if (fn.arguments) {
          block.text += fn.arguments
          yield { type: 'tool-call-delta', index: block.index, name: block.name || '', argumentsDelta: fn.arguments }
        }
      }
      if (choice.finish_reason) {
        this.sawFinishReason = true
        if (choice.finish_reason === 'length') this.finish = { kind: 'max-tokens' }
      }
    }
    if (chunk.usage) this.usage = mapUsage(chunk.usage)
  }

  async *pump(rawChunks, marks) {
    for await (const chunk of rawChunks) yield* this.feed(chunk)
    return (marks.done || this.sawFinishReason) ? 'clean' : 'aborted'
  }

  *finalize() {
    for (const block of this.order) {
      switch (block.kind) {
        case 'text': yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }; break
        case 'reasoning': yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }; break
        case 'tool-call':
          this.#ensureValidArgs(block)
          yield {
            type: 'block-end',
            index: block.index,
            block: { type: 'tool-call', id: block.callId || '', name: block.name || '', arguments: block.text },
          }
          break
      }
    }
    let usage = this.usage
    if (!usage && this.estimateInput) {
      const outChars = (this.textBlock?.text || '').length + (this.reasoningBlock?.text || '').length
      usage = {
        inputTokens: Math.ceil(this.estimateInput().length / 4),
        outputTokens: Math.ceil(outChars / 4),
      }
    }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: this.finish || { kind: 'stop' } }
  }
}

function buildContinuationBody(baseBody, partial) {
  if (!partial.reasoning && !partial.text) return null
  const assistant = { role: 'assistant', content: partial.text }
  if (partial.reasoning) assistant.reasoning_content = partial.reasoning
  return {
    ...baseBody,
    messages: [...baseBody.messages, assistant, { role: 'user', content: CONTINUE_NUDGE }],
  }
}

// ---------------------------------------------------------------------------
// LlmAdapter
// ---------------------------------------------------------------------------

class CodeBuddyAdapter {
  constructor(ctx) {
    this.ctx = ctx
    this.sessions = new SessionManager(ctx)
    // 运行时模型目录：初始为静态 models.json；/v3/config 拉取成功后内存热替换
    this.catalog = { models: MODELS, fetchedAt: 0, source: 'static models.json' }
    this.fetching = null
    this.catalogFailures = 0
    this.catalogBackoffUntil = 0
  }

  /** 当前生效的模型清单（拉取成功后即为新目录，无需重启） */
  currentModels() { return this.catalog.models }

  /**
   * 刷新模型目录。非 force：过期才拉，且不阻塞调用方（后台换）；
   * force：等待本次拉取完成（仍失败则沿用旧目录）。
   * 连续失败按 30s→5min 指数退避，避免会话失效时每次 UI 轮询都空打一发。
   */
  ensureCatalog(force = false) {
    if (MODEL_FETCH_DISABLED) return Promise.resolve(this.catalog)
    const stale = !this.catalog.fetchedAt || Date.now() - this.catalog.fetchedAt > MODELS_REFRESH_MS
    if (!stale) return Promise.resolve(this.catalog)
    if (!force && Date.now() < this.catalogBackoffUntil) return Promise.resolve(this.catalog)
    if (!this.fetching) {
      this.fetching = (async () => {
        try {
          const auth = await this.sessions.getAuth()
          const cat = await fetchModelCatalog(auth)
          this.catalog = { ...cat, source: 'fetched /v3/config' }
          this.catalogFailures = 0
          this.catalogBackoffUntil = 0
          log(this.ctx, 'info', `model catalog refreshed from /v3/config: ${cat.models.length} chat models (upstream total ${cat.total})`)
        } catch (err) {
          this.catalogFailures += 1
          const backoff = Math.min(CATALOG_BACKOFF_MIN_MS * 2 ** (this.catalogFailures - 1), CATALOG_BACKOFF_MAX_MS)
          this.catalogBackoffUntil = Date.now() + backoff
          log(this.ctx, 'warn', `model catalog refresh failed (${err.message || err}); keeping ${this.catalog.source}, next retry in ${Math.round(backoff / 1000)}s`)
        } finally {
          this.fetching = null
        }
      })()
    }
    return force ? this.fetching.then(() => this.catalog) : Promise.resolve(this.catalog)
  }

  providerInfo(provider) { return { id: provider, name: 'CodeBuddy' } }

  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMITED', 'TIMEOUT', 'TRANSPORT'],
      backoff: { initialDelayMs: 800, maxDelayMs: 5000, jitterRatio: 0.1 },
    }
  }

  listModels() {
    this.ensureCatalog() // 后台刷新；本次先返回当前目录，下一轮 UI 轮询即可见新清单
    return Promise.resolve(this.currentModels().map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, description: m.description, inputModalities: inputModalitiesOf(m) })))
  }

  resolveModel(provider, model) {
    const found = this.currentModels().find((m) => m.id === model)
    const reasoning = { efforts: REASONING_LEVELS, defaultEffort: DEFAULT_REASONING }
    return Promise.resolve({
      provider,
      id: model,
      name: found?.name || model,
      ...(found?.description ? { description: found.description } : {}),
      inputModalities: found ? inputModalitiesOf(found) : ['text'],
      context: { contextWindow: found?.contextWindow || DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: Number(found?.maxTokens) || DEFAULT_MAX_TOKENS,
      reasoning,
    })
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  buildHeaders(auth) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
      ...(auth.uid ? { 'X-User-Id': auth.uid } : {}),
      ...(auth.domain ? { 'X-Domain': auth.domain } : {}),
      ...(auth.enterpriseId ? { 'X-Enterprise-Id': auth.enterpriseId, 'X-Tenant-Id': auth.enterpriseId } : {}),
      'X-Request-Id': randomUUID().replace(/-/g, ''),
      'User-Agent': `dsh-codebuddy/${PKG_VERSION}`,
    }
  }

  /**
   * 打开一条上游流式连接。响应头之前的失败（401/429/5xx、连接超时）就地退避重试。
   * 401 特殊处理：会话可能被别的进程刷新过——失效缓存重读一次再试。
   */
  async openStreamOnce(reqBody, options) {
    const signal = options.signal
    let lastError = null
    let retryAfterMs = 0
    let retried401 = false
    const startedAt = Date.now()
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw aborted()
      if (attempt > 0 && Date.now() - startedAt > RETRY_BUDGET_MS) break
      const auth = await this.sessions.getAuth()
      const controller = new AbortController()
      const state = { selfAbort: '' }
      const onAbort = () => controller.abort()
      const connectTimer = setTimeout(() => { state.selfAbort = 'connect'; controller.abort() }, options.timeoutMs || CONNECT_TIMEOUT_MS)
      if (signal) signal.addEventListener('abort', onAbort)
      try {
        let response
        try {
          response = await fetch(`${CODEBUDDY_BASE}/v2/chat/completions`, {
            method: 'POST',
            headers: this.buildHeaders(auth),
            body: JSON.stringify(reqBody),
            signal: controller.signal,
          })
        } finally {
          clearTimeout(connectTimer)
        }

        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          if (response.status === 401 && !retried401) {
            // token 失效：官方客户端可能刚刷新过文件——丢缓存重读再试一次
            retried401 = true
            this.sessions.invalidate()
            log(this.ctx, 'warn', `HTTP 401; re-reading session file and retrying once (${raw.slice(0, 120)})`)
            lastError = new Error(`CodeBuddy HTTP 401: ${raw.slice(0, 200)}`)
            lastError.code = 'PROVIDER_ERROR'
            continue
          }
          const code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
          const err = new Error(`CodeBuddy HTTP ${response.status}: ${raw.slice(0, 300)}`)
          err.code = code
          if (code === 'PROVIDER_ERROR') { err.fatal = true; throw err }
          const ra = Number(response.headers?.get?.('retry-after'))
          retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0
          lastError = err
        } else {
          response = attachIdleWatch(response, controller, signal, () => { state.selfAbort = 'idle' })
          return { response, controller, state }
        }
      } catch (err) {
        if (signal?.aborted) throw aborted()
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          if (!state.selfAbort || err.fatal) throw err
          lastError = new Error(`CodeBuddy ${state.selfAbort} timeout`)
          lastError.code = 'TIMEOUT'
        } else if (err.fatal) {
          throw err
        } else {
          lastError = err
        }
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      if (attempt < MAX_REQUEST_ATTEMPTS - 1) await sleep(backoffDelay(attempt, retryAfterMs))
    }
    throw lastError || new Error('CodeBuddy request failed')
  }

  /**
   * 对外主入口。恢复矩阵（沿用 zen）：
   * - 干净结束（[DONE]/finish_reason）→ 正常收尾
   * - 空流中断 → 整单重试
   * - 半截中断 → 递增间隔自动续跑
   * - 工具参数被掐 → 残参隔离成合法但必失败的 JSON，整轮重打
   */
  async *stream(options) {
    const { model, messages, system, tools, maxTokens, reasoningEffort, temperature, signal } = options

    const found = this.currentModels().find((m) => m.id === model)
    const effort = pickReasoningEffort(reasoningEffort, found)

    let loadImage = null
    const imagesPresent = (messages || []).some((m) => Array.isArray(m.content) && hasImageDeep(m.content))
    if (imagesPresent && found && inputModalitiesOf(found).includes('image')) {
      const attachments = typeof this.ctx?.get === 'function' ? this.ctx.get('attachments') : undefined
      if (typeof attachments?.readImageRequest === 'function') {
        loadImage = (ref) => attachments.readImageRequest(
          ref,
          { maxPixels: DEFAULT_MAX_IMAGE_PIXELS, maxBytes: DEFAULT_MAX_IMAGE_BYTES },
          signal,
        )
      } else {
        log(this.ctx, 'warn', `[${model}] image content present but attachment service unavailable; falling back to text-only`)
      }
    }

    const wireMessages = await serializeMessages(messages, system, loadImage)
    const wireTools = serializeTools(tools)

    const body = {
      model,
      messages: wireMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens || Number(found?.maxTokens) || DEFAULT_MAX_TOKENS,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(wireTools ? { tools: wireTools, tool_choice: 'auto' } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    }

    const translator = new StreamTranslator(() => JSON.stringify(wireMessages))
    let continuationsLeft = MAX_CONTINUATIONS
    let emptiesLeft = EMPTY_STREAM_RETRIES
    let cutStep = 0
    let lastError = null

    const self = this
    const runOnce = async function* (reqBody) {
      const { response } = await self.openStreamOnce(reqBody, options)
      const marks = { done: false }
      try {
        yield* translator.pump(parseSse(response, marks), marks)
      } catch (err) {
        if (signal?.aborted) throw aborted()
        lastError = err
      }
      if (marks.done || translator.sawFinishReason) {
        return translator.openedBlocks ? 'clean' : 'empty-clean'
      }
      return translator.openedBlocks ? 'aborted-mid' : 'aborted-empty'
    }

    const attemptRun = async function* (reqBody) {
      try {
        return yield* runOnce(reqBody)
      } catch (err) {
        if (signal?.aborted || !translator.openedBlocks) throw err
        log(self.ctx, 'warn', `recovery request failed (${err.message || err.code || 'unknown'}); finalizing partial output`)
        return 'clean'
      }
    }

    let status = yield* attemptRun(body)
    while (status !== 'clean') {
      const wait = truncationBackoff(cutStep++)
      if (status === 'aborted-empty' || status === 'empty-clean') {
        if (emptiesLeft-- <= 0) break
        log(this.ctx, 'warn', `[${model}] ${status === 'empty-clean' ? 'upstream returned an empty response' : 'upstream aborted an empty stream'}; retry #${EMPTY_STREAM_RETRIES - emptiesLeft} in ${wait}ms`)
      } else if (continuationsLeft > 0 && translator.continuable) {
        continuationsLeft--
        log(this.ctx, 'warn', `[${model}] stream cut mid-generation; auto-continue #${MAX_CONTINUATIONS - continuationsLeft} in ${wait}ms`)
        await sleepOrAbort(wait, signal)
        status = yield* attemptRun(buildContinuationBody(body, translator.snapshotPartial()) || body)
        continue
      } else if (continuationsLeft > 0 && translator.toolBlocks.size > 0) {
        continuationsLeft--
        translator.quarantinePartialTools()
        log(this.ctx, 'warn', `[${model}] stream cut mid-tool-call; args quarantined, full retry in ${wait}ms`)
        await sleepOrAbort(wait, signal)
        status = yield* attemptRun(body)
        continue
      } else {
        break
      }
      await sleepOrAbort(wait, signal)
      status = yield* attemptRun(body)
    }

    if (status !== 'clean' && !translator.openedBlocks) {
      throw Object.assign(
        lastError || new Error('CodeBuddy stream ended without any data'),
        { code: 'TRANSPORT' },
      )
    }
    yield* translator.finalize()
  }
}

function apply(ctx) {
  const adapter = new CodeBuddyAdapter(ctx)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  // 首次加载即后台拉取最新模型目录（/v3/config）；失败不影响注册，沿用静态表
  adapter.ensureCatalog().catch(() => {})
  // 启动即诊断会话可用性（不打断宿主启动；错误留给首次调用时如实上抛）
  try {
    let source
    if (process.env.DSH_CODEBUDDY_ACCESS_TOKEN) source = 'env DSH_CODEBUDDY_ACCESS_TOKEN'
    else {
      const s = discoverSession()
      source = s ? `${s.source} (auto-discovered, uid=${(s.uid || '?').slice(0, 8)}…, domain=${s.domain || '-'})` : 'none found (first call will error until you log in)'
    }
    const catalogNote = MODEL_FETCH_DISABLED
      ? `${MODELS.length} static models (auto-fetch disabled)`
      : `${MODELS.length} static models (auto-refreshing from /v3/config)`
    log(ctx, 'info', `provider "${PROVIDER}" registered, ${catalogNote}, session: ${source}, base: ${CODEBUDDY_BASE}`)
  } catch { /* noop */ }
}

module.exports = {
  apply,
  inject,
  name,
  CodeBuddyAdapter,
  SessionManager,
  StreamTranslator,
  serializeMessages,
  serializeTools,
  buildContinuationBody,
  truncationBackoff,
  loadSessionFile,
  authFilePath,
  discoverSession,
  listAuthFiles,
  loadSessionFromPath,
  sessionScore,
  authDir,
  candidateAuthDirs,
  fetchModelCatalog,
  toModelEntry,
  applyBuiltinCapabilities,
  BUILTIN_CAPABILITIES,
  inputModalitiesOf,
  PROVIDER,
  MODELS,
  CODEBUDDY_BASE,
}
