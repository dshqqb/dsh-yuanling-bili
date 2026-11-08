// src/shape.mjs —— 把 B站的原始字段压成"人能一眼读懂、且塞得进 8KB 预算"的文本。
//
// 为什么压得这么狠：核心给模型的取数预算是 8KB（协议 §5.2.2 的 FETCH_TEXT_BUDGET），
// 超过会被核心粗暴截断。与其让核心在句子中间剪断，不如这里按条目排版——20 条 × 约 110 字
// 正好落在预算内，而且每条都完整。
//
// 另外：B站搜索的标题里带 `<em class="keyword">` 高亮标签，简介里带 HTML 实体。
// 不洗掉的话，模型看到的是 `&amp;` 与尖括号，像是抓到了网页源码。

/** 单条搜索结果的标题预算（字符）。 */
export const SEARCH_ITEM_CHARS = 46
export const DESC_CHARS = 36

/**
 * 模块侧给整批条目分配的总预算（字节）。
 *
 * 核心给模型的是 8192 字节，但那是**渲染后**的文本——每条还要加作者行与"证据：指针"。
 * 实测 5 条搜索 ≈ 2072 字节，其中约一半是核心加的外壳。所以这里按 6000 字节给正文，
 * 剩下的留给外壳。超了就自己先裁，别让核心在句子中间一刀切（那会整条丢掉）。
 */
export const MODULE_TEXT_BUDGET = 6000

export function bytesOf(items) {
  return items.reduce((n, it) => n + Buffer.byteLength(String(it.text ?? ''), 'utf8'), 0)
}

/**
 * 按预算适配一批条目：优先"全部带简介"，不行就"全部不带简介"，再不行从尾部丢条目。
 * 三档而不是逐条挑，是为了排版一致——一排条目里有的带简介有的不带，读起来像 bug。
 *
 * @param {Array<{text:string, lean?:string}>} items
 * @param {number} budget
 */
export function fitBudget(items, budget = MODULE_TEXT_BUDGET) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return { items: [], dropped: 0, lean: false }

  if (bytesOf(list) <= budget) return { items: list, dropped: 0, lean: false }

  const lean = list.map((it) => ({ ...it, text: it.lean ?? it.text }))
  if (bytesOf(lean) <= budget) return { items: lean, dropped: 0, lean: true }

  const kept = []
  let used = 0
  for (const it of lean) {
    const b = Buffer.byteLength(String(it.text ?? ''), 'utf8')
    if (used + b > budget) break
    used += b
    kept.push(it)
  }
  return { items: kept, dropped: lean.length - kept.length, lean: true }
}

/** 去掉 HTML 标签与常见实体。顺序有讲究：先解实体再剥标签，否则 `&lt;em&gt;` 剥不掉。 */
export function stripHtml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // 最后解，避免二次解析
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 播放量：12345 → 1.2万；1.2亿 → 1.2亿（B站自己也这么写）。 */
export function formatCount(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`
  return String(Math.round(v))
}

/** 秒数或 "mm:ss" → "mm:ss"。搜索结果里的 duration 已经是字符串，别二次解析。 */
export function formatDuration(d) {
  if (typeof d === 'string' && /^\d{1,2}:\d{2}(:\d{2})?$/.test(d)) return d
  const sec = Number(d)
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return h > 0 ? `${h}:${mmss}` : mmss
}

/**
 * 时间戳：接受秒（pubdate）或 ISO 字符串。
 * 输出统一成 `YYYY-MM-DD`——模型只需要"什么时候"，不需要毫秒与时区噪音。
 */
export function formatDate(v) {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number' || (/^\d+$/.test(String(v)) && String(v).length <= 10)) {
    const ms = Number(v) * 1000
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return ''
    // 用本地时区（用户在中国），别用 UTC 让人看到"昨天"
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  const s = String(v)
  return s.slice(0, 10)
}

/** 秒 → `mm:ss`（字幕时间码用）。 */
export function mmss(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 按字符数硬裁，并在尾巴上明说裁了——不能悄悄剪短。 */
export function clipChars(s, limit) {
  const str = String(s ?? '')
  if (str.length <= limit) return str
  return `${str.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * 把一条搜索结果排成一行：`〔BV号〕标题 · UP:xx · 播放:123 · 时长:03:12 · 2026-10-01 · 简介:…`
 *
 * 为什么挤成一行：核心的取数渲染会把每条正文压成一行（多行反而被折叠成空格）。
 * 与其指望排版，不如自己把分隔符写清楚。
 *
 * 返回 `{ text, lean }`：`lean` 是去掉简介的版本，预算不够时整批降级用（见 fitBudget）。
 */
export function shapeSearchItem(r) {
  const bv = String(r.bvid ?? '').trim()
  const title = stripHtml(r.title)
  const up = stripHtml(r.author)
  const desc = stripHtml(r.description)

  const head = clipChars(bv ? `〔${bv}〕${title}` : title, SEARCH_ITEM_CHARS)
  const meta = [
    up && `UP:${up}`,
    Number(r.play) > 0 && `播放:${formatCount(r.play)}`,
    formatDuration(r.duration) && `时长:${formatDuration(r.duration)}`,
    formatDate(r.pubdate) && formatDate(r.pubdate),
  ]
    .filter(Boolean)
    .join(' · ')

  const text = clipChars(`${head}${meta ? ` · ${meta}` : ''}${desc ? ` · 简介:${clipChars(desc, DESC_CHARS)}` : ''}`, 200)
  const lean = clipChars(`${head}${meta ? ` · ${meta}` : ''}`, 150)
  return { text, lean }
}
