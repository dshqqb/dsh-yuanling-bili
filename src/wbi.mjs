// src/wbi.mjs —— B站的 WBI 签名。
//
// 为什么单独一个文件：这是整个模块唯一"算错就全盘失败"的地方。
// 签名错的表现不是报错，而是 B站返回 `code:-352`（风控）或干脆空列表——
// 看起来像"没搜到"，排查时最容易怀疑到别的地方去。
//
// 算法（照 surfcore 里跑通的实现，不改动）：
//   ① 拉 `/x/web-interface/nav`，从 `wbi_img.img_url` / `sub_url` 各取文件名（去掉 .png）
//   ② 两段拼起来，按固定的 64 位置乱序表重排，取前 32 位 = mixin key
//   ③ 参与签名的参数按**键名排序**，值里去掉 `!'()*`，再整个 encodeURIComponent
//   ④ 拼上 `wts`，md5(param串 + mixin key) 作为 `w_rid`
//
// 注意两点，都是踩过的：
//   · `wts` 必须参与排序与签名，不是附带参数；
//   · `clean` 只清值，不清键。
import crypto from 'node:crypto'

/** 位置乱序表。64 个数字，一个都不能差——它决定 mixin key 取哪些字符。 */
export const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

/** 从 img_url / sub_url 里取文件名主干（`.../7cd084941338484aae1ad9425b84077c.png` → 那串 hash）。 */
export function keyOf(url) {
  const s = String(url ?? '')
  const slash = s.lastIndexOf('/')
  const dot = s.lastIndexOf('.')
  if (slash < 0 || dot <= slash) return ''
  return s.slice(slash + 1, dot)
}

/**
 * 由 nav 响应算出 mixin key。
 * nav 拿不到（网络失败、风控）时返回 null——调用方必须把"拿不到 key"当成失败，
 * 不能拿空串继续签（那样只会得到一堆看不懂的风控错误）。
 */
export function mixinKeyFromNav(nav) {
  const img = keyOf(nav?.data?.wbi_img?.img_url)
  const sub = keyOf(nav?.data?.wbi_img?.sub_url)
  if (!img || !sub) return null
  const raw = img + sub
  return MIXIN_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32)
}

/** 值清洗：B站只要求去掉这四个字符（`!` `'` `(` `)` `*` 中的这几个）。 */
export function cleanValue(v) {
  return String(v).replace(/[!'()*]/g, '')
}

/** 参数字符串：按**键名排序**，`wts` 一起排进去。 */
export function sortedQuery(params, wts) {
  const all = { ...params, wts }
  return Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(k === 'wts' ? wts : cleanValue(all[k]))}`)
    .join('&')
}

/**
 * 给参数加上 `wts` 与 `w_rid`。
 * @param {object} params 业务参数（不要自己塞 wts）
 * @param {string} mixinKey 32 位 mixin key
 * @param {number} [nowMs] 当前毫秒时间戳（测试注入用）
 * @returns {string} 完整的 query string
 */
export function signParams(params, mixinKey, nowMs = Date.now()) {
  if (!mixinKey || mixinKey.length !== 32) {
    throw new Error(`mixin key 不合法（期望 32 位，实际 ${String(mixinKey ?? '').length} 位）`)
  }
  const wts = Math.round(nowMs / 1000)
  const q = sortedQuery(params, wts)
  const w_rid = crypto.createHash('md5').update(q + mixinKey).digest('hex')
  return `${q}&w_rid=${w_rid}`
}

/** 把已经签好的 query string 挂到 URL 上。 */
export function signedUrl(base, params, mixinKey, nowMs) {
  return `${base}?${signParams(params, mixinKey, nowMs)}`
}
