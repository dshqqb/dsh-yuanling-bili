// src/bili.mjs —— B站 HTTP 客户端：cookie、WBI 签名、超时、礼貌节流。
//
// 这个文件只做"发请求并把错误翻译成人话"。业务形状（搜什么、怎么切段）在 sources/ 里。
//
// 三条不写成配置项的死规矩：
//   ① 只发 GET。这个模块是只读的——发写请求要 bili_jct 与 csrf，等于把"能改她账号"的钥匙放进陌生人手里。
//   ② 每个请求都有超时（默认 20s）。B站偶尔会把连接挂住不返回，没有超时就是整个模块假死。
//   ③ 请求之间有最小间隔。核心的 10 次/分钟是外层闸，这里是内层礼貌——一次字幕要打 4 个接口。
import crypto from 'node:crypto'

import { mixinKeyFromNav, signParams } from './wbi.mjs'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** nav（含 wbi key）缓存 10 分钟：wbi key 按天轮换，10 分钟远小于轮换周期。 */
export const NAV_TTL_MS = 10 * 60 * 1000
/** 两个请求之间的最小间隔。一次字幕要打 4 个接口，不留间隔像在跑脚本。 */
export const MIN_GAP_MS = 250
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 带协议错误码的错误——main.mjs 原样回给核心。
 *
 * `diag`（v1.4）：这个问题是否值得进核心的「诊断」页。只给**用户能动手解决**的那些
 * （cookie 没了 / cookie 失效 / 被限流 / 被风控），网络抖动这类不该占着诊断位。
 */
export class BiliError extends Error {
  constructor(code, message, diag = null) {
    super(message)
    this.code = code
    this.diag = diag
  }
}

/** 从配置拼 cookie。缺哪个就不带哪个，但缺 SESDATA 时调用方要自己判断能不能干这活。 */
export function cookieOf(config = {}) {
  const parts = []
  if (config.sessdata) parts.push(`SESSDATA=${String(config.sessdata).trim()}`)
  if (config.bili_jct) parts.push(`bili_jct=${String(config.bili_jct).trim()}`)
  if (config.buvid3) parts.push(`buvid3=${String(config.buvid3).trim()}`)
  return parts.join('; ')
}

/** B站错误码 → 协议错误码。只有"风控/限流"值得让外层知道可重试。 */
export function mapBiliCode(code) {
  if (code === -352 || code === -412) return 'E_RATE'
  return 'E_BAD_REQUEST'
}

/**
 * B站业务码 → 要不要进「诊断」页。
 *
 * 只挑**用户自己能解决**的：限流（等一会儿）、未登录/登录失效（去填 cookie）。
 * 其它一律不报——诊断位很贵，塞满"偶发失败"就等于没有诊断。
 */
function diagForBiliCode(code) {
  if (code === -352 || code === -412) {
    return {
      code: 'rate.limited',
      level: 'warn',
      hint: '被 B站限流了：等十几分钟再取；一次取太多（limit 调大）更容易触发',
    }
  }
  if (code === -101) {
    return {
      code: 'cookie.expired',
      level: 'error',
      hint: '登录态失效（B站 code=-101）：重新登录 B站，把新的 SESSDATA / bili_jct / buvid3 填进模块配置',
    }
  }
  return null
}

export class BiliClient {
  constructor({ config = {}, fetchImpl = fetch, now = () => Date.now(), sleep = null } = {}) {
    this.config = config ?? {}
    this.fetchImpl = fetchImpl
    this.now = now
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.timeoutMs = Number(this.config.timeoutMs) > 0 ? Number(this.config.timeoutMs) : DEFAULT_TIMEOUT_MS
    this.navCache = null
    this.lastAt = 0
  }

  get hasCookie() {
    return Boolean(this.config.sessdata)
  }

  headers({ referer = 'https://www.bilibili.com/' } = {}) {
    const h = { 'user-agent': UA, referer }
    const cookie = cookieOf(this.config)
    if (cookie) h.cookie = cookie
    return h
  }

  /** 一个有超时的 GET。网络层错误统一翻成 E_BAD_REQUEST + 人话。 */
  async get(url, { referer, accept = 'application/json' } = {}) {
    const gap = MIN_GAP_MS - (this.now() - this.lastAt)
    if (gap > 0) await this.sleep(gap)
    this.lastAt = this.now()

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET', // 见文件头 ①
        headers: this.headers({ referer }),
        signal: ac.signal,
      })
      if (!res.ok) {
        throw new BiliError('E_BAD_REQUEST', `B站返回 HTTP ${res.status}（${url.split('?')[0]}）`)
      }
      if (accept === 'text') return await res.text()
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new BiliError('E_PROTO', `B站返回的不是 JSON（${url.split('?')[0]}）：${text.slice(0, 80)}`)
      }
    } catch (error) {
      if (error instanceof BiliError) throw error
      if (error?.name === 'AbortError') {
        throw new BiliError('E_BAD_REQUEST', `请求超时（${this.timeoutMs}ms）：${url.split('?')[0]}`)
      }
      throw new BiliError('E_BAD_REQUEST', `连不上 B站（${url.split('?')[0]}）：${error?.message ?? error}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * nav：既拿 wbi key，也顺便回答"登录态还在不在"。
   * 注意 nav 在未登录时也会回 `code:-101`，但仍带 `wbi_img`——所以能不能签名与登录是两件事。
   */
  async nav() {
    if (this.navCache && this.now() - this.navCache.at < NAV_TTL_MS) return this.navCache

    const raw = await this.get('https://api.bilibili.com/x/web-interface/nav')
    const mixin = mixinKeyFromNav(raw)
    if (!mixin) {
      throw new BiliError('E_BAD_REQUEST', '拿不到 WBI 签名材料（nav 里没有 wbi_img），B站可能改版或正在风控', {
        code: 'wbi.blocked',
        level: 'warn',
        hint: 'B站可能改版或正在风控：等一会儿再试；持续出现就是模块需要跟着改，不是配置问题',
      })
    }
    this.navCache = {
      at: this.now(),
      mixin,
      isLogin: Boolean(raw?.data?.isLogin),
      uname: raw?.data?.uname ?? null,
      mid: raw?.data?.mid ?? null,
    }
    return this.navCache
  }

  /** WBI 签名的 GET。 */
  async signed(base, params, { referer } = {}) {
    const { mixin } = await this.nav()
    const qs = signParams(params, mixin, this.now())
    return this.get(`${base}?${qs}`, { referer })
  }

  /** 业务请求：B站用 `code !== 0` 表示失败，这里翻成异常。 */
  async check(promiseOrJson, what) {
    const d = await promiseOrJson
    if (Number(d?.code) !== 0) {
      const n = Number(d?.code)
      throw new BiliError(mapBiliCode(n), `${what} 失败：B站 code=${n} ${d?.message ?? ''}`.trim(), diagForBiliCode(n))
    }
    return d.data
  }
}

/** 字幕 JSON 的 md5（用来生成跨次稳定的内容指纹，见 sources/subtitles.mjs）。 */
export function md5(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex')
}
