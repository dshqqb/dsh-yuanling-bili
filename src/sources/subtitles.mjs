// src/sources/subtitles.mjs —— bili.video_subtitles：拉官方/AI 字幕，按分钟切段。
//
// 为什么是「切段」而不是整篇：
//   核心给模型的取数是 8KB 预算，一条长视频的字幕全文轻松几万字。
//   整篇塞进去 = 前面 3000 字有用、后面全被截断，而且模型根本不知道后面还有。
//   切成 1 分钟一段，20 段 ≈ 20 分钟，模型扫完能判断"要不要继续"，续取就带 `from`。
//
// 三个踩过的坑（来自 surfcore 的实测笔记，这里照做）：
//   ① 必须走 WBI 签名的 `/x/player/wbi/v2`。旧的 `/x/player/v2` 拿到的 subtitle_url **不带 auth_key**，
//      CDN 会 403 或回一段错的内容。
//   ② auth_key 分钟级有效 → 拿到就得马上下载，且 URL 不能截断（尾部还有 `-0-<32位hex>`）。
//   ③ 匿名拿不到 AI 字幕（返回 0 轨道）→ 必须带登录 cookie。所以要区分
//      "没配 cookie" / "cookie 失效" / "这视频真的没字幕"，不能一律说"没有数据"。
import { BiliError } from '../bili.mjs'
import { mmss } from '../shape.mjs'

export const id = 'bili.video_subtitles'

/** 一段覆盖多少秒。1 分钟：够表达一个意思，又不至于 20 段只覆盖几分钟。 */
export const SEGMENT_SEC = 60
/** 单段正文上限（字符）。正常 1 分钟口播 ≈ 60~120 字，超了说明字幕很密，硬裁。 */
export const SEGMENT_CHARS = 900

export function validate(params = {}) {
  const bvid = String(params.bvid ?? '').trim()
  if (!bvid) throw new BiliError('E_BAD_REQUEST', '缺少 bvid（视频 BV 号）')
  if (!/^BV[0-9A-Za-z]{10,}$/.test(bvid)) {
    throw new BiliError('E_BAD_REQUEST', `bvid 格式不对（应以 BV 开头，如 BV1xx411c7mD；收到「${bvid}」）`)
  }

  const from = params.from === undefined || params.from === null ? 0 : Number(params.from)
  if (!Number.isFinite(from) || from < 0) throw new BiliError('E_BAD_REQUEST', `from 必须是非负的分钟数`)
  if (from > 600) throw new BiliError('E_BAD_REQUEST', `from 太大（${from} 分钟）；BV 视频一般没这么长`)

  const lan = params.lan === undefined || params.lan === null ? '' : String(params.lan).trim()
  return { bvid, fromSec: Math.floor(from * 60), lan }
}

/**
 * 挑字幕轨道：指定语言优先，否则按中文优先，最后兜底第一条。
 * 抽成纯函数：这是"能不能看到字幕"的关键判断，不该藏在网络请求后面。
 */
export function pickTrack(tracks, lan = '') {
  const list = Array.isArray(tracks) ? tracks.filter((t) => t && t.subtitle_url) : []
  if (!list.length) return null
  if (lan) {
    const exact = list.find((t) => t.lan === lan)
    if (exact) return exact
  }
  return (
    list.find((t) => t.lan === 'ai-zh') ??
    list.find((t) => t.lan === 'zh-CN') ??
    list.find((t) => String(t.lan).startsWith('zh')) ??
    list[0]
  )
}

/**
 * 把字幕行按 SEGMENT_SEC 切段。
 * @param {Array<{from:number,to?:number,content:string}>} body
 * @param {{fromSec?:number, limit?:number}} opts
 */
export function segment(body, { fromSec = 0, limit = 20 } = {}) {
  const lines = (Array.isArray(body) ? body : [])
    .filter((l) => l && String(l.content ?? '').trim())
    .map((l) => ({ from: Number(l.from) || 0, content: String(l.content).trim() }))
    .filter((l) => l.from >= fromSec)
  if (!lines.length) return []

  const cap = Math.max(1, Math.min(20, Number(limit) || 20))
  const buckets = []
  for (const l of lines) {
    const idx = Math.floor(l.from / SEGMENT_SEC)
    const bucket = buckets[idx] ?? (buckets[idx] = { startSec: idx * SEGMENT_SEC, lines: [] })
    bucket.lines.push(l)
  }

  const out = []
  for (const b of buckets) {
    if (!b) continue
    let text = b.lines.map((l) => `[${mmss(l.from)}] ${l.content}`).join('\n')
    if (text.length > SEGMENT_CHARS) {
      text = `${text.slice(0, SEGMENT_CHARS)}…（这一分钟字幕太密，已截断）`
    }
    out.push({ startSec: b.startSec, text })
    if (out.length >= cap) break
  }
  return out
}

/**
 * 取一次字幕。
 *
 * 分支要说清（这是最容易含糊的地方）：
 *   · 没配 cookie → 直接报错"要登录态"，因为匿名必然 0 轨道，说"没有字幕"是误导；
 *   · 配了 cookie 但 nav 显示未登录 → 报"cookie 已失效"；
 *   · 登录正常但真的 0 轨道 → 返回一条 notice 条目（这是真实观察，值得记下来）。
 */
export async function fetchItems(client, params, { limit } = {}) {
  const v = validate(params)

  if (!client.hasCookie) {
    throw new BiliError(
      'E_BAD_REQUEST',
      '拿字幕需要登录态：模块配置里没有 sessdata。匿名请求只会返回 0 条字幕轨道（B站策略），' +
        '去管理台的模块配置里填 cookie 再试。',
      {
        code: 'cookie.missing',
        level: 'warn',
        hint: '模块配置里没有 SESSDATA：去「B站」页把 cookie（SESSDATA / bili_jct / buvid3）填上，匿名只能拿到公开结果',
      },
    )
  }
  const nav = await client.nav()
  if (!nav.isLogin) {
    throw new BiliError(
      'E_BAD_REQUEST',
      `配置里的 cookie 已失效（nav 说未登录${nav.uname ? '' : ''}）。` +
        '重新登录 B站后把新的 SESSDATA / bili_jct / buvid3 填进模块配置。',
      {
        code: 'cookie.expired',
        level: 'error',
        hint: 'cookie 已失效（B站 nav 说未登录）：重新登录后把新的 SESSDATA / bili_jct / buvid3 填进模块配置',
      },
    )
  }

  const referer = `https://www.bilibili.com/video/${v.bvid}/`
  const view = await client.check(
    client.get(`https://api.bilibili.com/x/web-interface/view?bvid=${v.bvid}`, { referer }),
    `取视频信息 ${v.bvid}`,
  )
  const aid = view?.aid
  const cid = view?.cid
  if (!aid || !cid) throw new BiliError('E_BAD_REQUEST', `B站没给出 aid/cid（${v.bvid}），这条视频可能已删除或需要大会员`)

  const pubdate = Number(view?.pubdate) > 0 ? new Date(Number(view.pubdate) * 1000).toISOString() : null
  const title = String(view?.title ?? '').trim()

  // ① 主端点：WBI 签名（决定 subtitle_url 里有没有 auth_key）
  const player = await client.signed('https://api.bilibili.com/x/player/wbi/v2', { bvid: v.bvid, cid }, { referer })
  let tracks = player?.data?.subtitle?.subtitles ?? []
  let source = 'x/player/wbi/v2'

  // ② 兜底：播放器实际调用的端点（同样要 cookie）
  if (!tracks.length) {
    const ext = encodeURIComponent(JSON.stringify({ video_type: 1 }))
    const fb = await client.get(
      'https://api.bilibili.com/x/v2/subtitle/web/view' +
        `?oid=${aid}&pid=${aid}&context_ext=${ext}&type=1&cur_production_type=0` +
        `&preferred_language=${encodeURIComponent(v.lan || 'ai-zh')}&playlist_switch=0`,
      { referer },
    )
    const s2 = fb?.data?.subtitle?.subtitles ?? []
    if (s2.length) {
      tracks = s2
      source = 'x/v2/subtitle/web/view'
    }
  }

  const track = pickTrack(tracks, v.lan)
  if (!track) {
    // 真·没有字幕：返回一条 notice。这是"观察到的现实"，落进 raw 也算一条真记忆。
    return [
      {
        ext_id: `${v.bvid}:no-subtitle`,
        ts: pubdate,
        kind: 'notice',
        text: `《${title || v.bvid}》没有可用字幕：两个端点都没给出轨道（${source} 与 web/view 都是空），大概率只把字幕烧进了画面，那种只能看画面。`,
        actor: { kind: 'system', id: 'bili', name: 'B站' },
        media: [],
      },
    ]
  }

  const url = String(track.subtitle_url).startsWith('http') ? track.subtitle_url : `https:${track.subtitle_url}`

  // auth_key 分钟级有效：一次失败就重新签一次再试，不在这里重试到天荒地老
  let body = []
  try {
    body = await downloadBody(client, url, { referer })
  } catch {
    const again = await client.signed('https://api.bilibili.com/x/player/wbi/v2', { bvid: v.bvid, cid }, { referer })
    const retryTrack = pickTrack(again?.data?.subtitle?.subtitles ?? [], v.lan)
    if (!retryTrack) throw new BiliError('E_BAD_REQUEST', '字幕链接过期，重新签名后也没拿到轨道，稍后再试一次')
    const u2 = String(retryTrack.subtitle_url).startsWith('http') ? retryTrack.subtitle_url : `https:${retryTrack.subtitle_url}`
    body = await downloadBody(client, u2, { referer })
  }

  const segs = segment(body, { fromSec: v.fromSec, limit })
  if (!segs.length) {
    return [
      {
        ext_id: `${v.bvid}:${track.lan}:empty-after-${v.fromSec}`,
        ts: pubdate,
        kind: 'notice',
        text: `《${title || v.bvid}》的字幕从第 ${Math.floor(v.fromSec / 60)} 分钟起没有内容了（字幕共 ${body.length} 行）。`,
        actor: { kind: 'system', id: 'bili', name: 'B站' },
        media: [],
      },
    ]
  }

  return segs.map((s) => ({
    // ext_id 里带段起点：续取后面的段不会覆盖前面的，也不会重复
    ext_id: `${v.bvid}:${track.lan}:${s.startSec}`,
    ts: pubdate,
    kind: 'material',
    text: `《${title}》${mmss(s.startSec)} 起（${track.lan_doc || track.lan}）\n${s.text}`,
    actor: { kind: 'member', id: '', name: String(view?.owner?.name ?? '').trim() },
    media: [],
  }))
}

/** 下载字幕 JSON，取出 body。字幕文件不是 JSON 时明确报错（别把 HTML 错误页当字幕存进去）。 */
async function downloadBody(client, url, { referer }) {
  const text = await client.get(url, { referer, accept: 'text' })
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BiliError('E_PROTO', `字幕不是 JSON：${String(text).slice(0, 80)}`)
  }
  const body = parsed?.body
  if (!Array.isArray(body)) throw new BiliError('E_PROTO', '字幕 JSON 里没有 body 数组')
  return body
}
