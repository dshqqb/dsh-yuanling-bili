// src/sources/search.mjs —— bili.search_video：按关键词搜视频。
//
// 形状约定（协议 §5.2.2）：返回 items 数组，每项必须有**稳定的 ext_id**。
// 这里的 ext_id 是 `search:<关键词>:<BV号>`——刻意把关键词也算进去：
//   · 同一次搜索重跑 → 去重，raw 里不会多一堆；
//   · 换个关键词搜到同一条视频 → 算两条记录，因为"她是在哪个问题下遇到它的"这个信息不该丢。
import { BiliError } from '../bili.mjs'
import { shapeSearchItem, fitBudget } from '../shape.mjs'

export const id = 'bili.search_video'

export const ORDERS = ['totalrank', 'click', 'pubdate', 'dm']

/** 参数校验：宁可直接拒，也不要带着奇怪参数去请求 B站（那边只会回空列表，看不出错在哪）。 */
export function validate(params = {}) {
  const q = String(params.q ?? '').trim()
  if (!q) throw new BiliError('E_BAD_REQUEST', '缺少 q（搜索关键词）')
  if (q.length > 80) throw new BiliError('E_BAD_REQUEST', `关键词太长（${q.length} 字，≤80）`)

  const page = params.page === undefined || params.page === null ? 1 : Number(params.page)
  if (!Number.isInteger(page) || page < 1 || page > 50) {
    throw new BiliError('E_BAD_REQUEST', `page 必须是 1~50 的整数（收到 ${params.page}）`)
  }

  const order = String(params.order ?? 'totalrank').trim()
  if (!ORDERS.includes(order)) {
    throw new BiliError('E_BAD_REQUEST', `order 只能是 ${ORDERS.join(' / ')}（收到「${order}」）`)
  }

  return { q, page, order }
}

/**
 * 把 B站的搜索响应变成 items。
 * 抽成纯函数是为了能在没有网络的地方测：形状错了单测就该红，不该等到真机。
 */
export function toItems(data, { q, limit }) {
  const list = Array.isArray(data?.result) ? data.result : []
  const picked = list.slice(0, Math.max(1, Math.min(20, Number(limit) || 20)))

  const shaped = picked
    .map((r) => {
      const bvid = String(r.bvid ?? '').trim()
      const shape = shapeSearchItem(r)
      if (!bvid || !shape.text) return null // 没有 BV 的结果没法当证据，直接丢
      return {
        ext_id: `search:${q}:${bvid}`,
        ts: Number(r.pubdate) > 0 ? new Date(Number(r.pubdate) * 1000).toISOString() : null,
        kind: 'material',
        text: shape.text,
        lean: shape.lean,
        // 作者就是这条内容的说话人；id 留空而不是编一个（编出来的 id 会污染人物档案）
        actor: { kind: 'member', id: '', name: String(r.author ?? '').trim() },
        media: [],
      }
    })
    .filter(Boolean)

  // 预算适配：8KB 是核心给模型的硬预算，20 条带简介必然超。
  // 先在模块这一侧降到"不带简介"，还不够就从尾部丢——别让核心从中间截断。
  const fitted = fitBudget(shaped)
  return fitted.items.map(({ lean, ...it }) => it)
}

/** 一次真的搜索。 */
export async function fetchItems(client, params, { limit } = {}) {
  const v = validate(params)
  const data = await client.check(
    client.signed(
      'https://api.bilibili.com/x/web-interface/wbi/search/type',
      { search_type: 'video', keyword: v.q, page: v.page, order: v.order },
      { referer: 'https://search.bilibili.com/' },
    ),
    '搜索',
  )
  return toItems(data, { q: v.q, limit })
}
