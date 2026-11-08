// test/search.test.mjs —— bili.search_video 的参数校验与响应整形。
//
// 用**真的** B站响应形状（从 2026-11-08 的真实返回里摘出来的字段），不自己编。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validate, toItems, ORDERS } from '../src/sources/search.mjs'
import { bytesOf } from '../src/shape.mjs'

/** 一条真实搜索结果（字段是 B站 2026-11 的实际形状）。 */
function realRow(over = {}) {
  return {
    type: 'video',
    bvid: 'BV19E4h6yEEQ',
    title: '原神至冬哈萨瓦矮灵搭桥小游戏解密',
    author: '叫我偷油贼',
    play: 4901,
    video_review: 3,
    duration: '1:56',
    pubdate: 1762343940,
    description: '没装有剪辑软件观感体验可能不太好请见谅',
    tag: '原神,小游戏',
    ...over,
  }
}

test('search：参数校验——缺 q / 太长 / page 越界 / order 非法都要明确拒', () => {
  assert.throws(() => validate({}), (e) => e.code === 'E_BAD_REQUEST' && /缺少 q/.test(e.message))
  assert.throws(() => validate({ q: '  ' }), /缺少 q/)
  assert.throws(() => validate({ q: 'x'.repeat(81) }), /关键词太长/)
  assert.throws(() => validate({ q: 'a', page: 0 }), /page/)
  assert.throws(() => validate({ q: 'a', page: 51 }), /page/)
  assert.throws(() => validate({ q: 'a', page: 1.5 }), /page/)
  assert.throws(() => validate({ q: 'a', order: 'newest' }), /order/)
})

test('search：默认参数是 page=1 / order=totalrank', () => {
  assert.deepEqual(validate({ q: '原灵' }), { q: '原灵', page: 1, order: 'totalrank' })
  assert.deepEqual(ORDERS, ['totalrank', 'click', 'pubdate', 'dm'])
})

test('search：ext_id 稳定且带关键词（同一关键词重跑要能去重）', () => {
  const data = { result: [realRow()] }
  const a = toItems(data, { q: '原灵', limit: 20 })
  const b = toItems(data, { q: '原灵', limit: 20 })
  assert.equal(a[0].ext_id, b[0].ext_id)
  assert.equal(a[0].ext_id, 'search:原灵:BV19E4h6yEEQ')

  // 换个关键词搜到同一条视频 → 算另一条记录（"在哪个问题下遇到它"不该丢）
  const c = toItems(data, { q: '原神', limit: 20 })
  assert.notEqual(c[0].ext_id, a[0].ext_id)
})

test('search：ts 用视频发布时间，格式是 ISO', () => {
  const [it] = toItems({ result: [realRow()] }, { q: 'x', limit: 5 })
  assert.match(it.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/)
  assert.equal(new Date(it.ts).getTime(), 1762343940 * 1000)

  // 没有 pubdate 的结果不该造一个假时间
  const [noTs] = toItems({ result: [realRow({ pubdate: 0 })] }, { q: 'x', limit: 5 })
  assert.equal(noTs.ts, null)
})

test('search：没 BV 的条目被丢掉（没 BV 就没法当证据）', () => {
  const data = { result: [realRow(), realRow({ bvid: '' }), realRow({ bvid: 'BV1aa411c7mE' })] }
  const items = toItems(data, { q: 'x', limit: 20 })
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((i) => i.ext_id), ['search:x:BV19E4h6yEEQ', 'search:x:BV1aa411c7mE'])
})

test('search：limit 被夹在 1~20，且不会超过返回条数', () => {
  const data = { result: Array.from({ length: 30 }, (_, i) => realRow({ bvid: `BV1x${String(i).padStart(9, '0')}` })) }
  assert.equal(toItems(data, { q: 'x', limit: 99 }).length, 20)
  assert.equal(toItems(data, { q: 'x', limit: 3 }).length, 3)
  assert.equal(toItems(data, { q: 'x', limit: 0 }).length, 20, 'limit=0 当作没给')
  assert.equal(toItems({}, { q: 'x', limit: 5 }).length, 0, 'data 形状不对时给空数组，不抛')
})

test('search：作者进 actor，id 留空（不编造账号）', () => {
  const [it] = toItems({ result: [realRow()] }, { q: 'x', limit: 5 })
  assert.equal(it.actor.name, '叫我偷油贼')
  assert.equal(it.actor.id, '', '没有 mid 就不要编一个，编出来的会污染人物档案')
  assert.equal(it.kind, 'material')
})

test('search：20 条无论多长，正文都不许超过模块预算（否则核心必截）', () => {
  // 长标题 + 长简介：这才是真实搜索结果的样子（实测 20 条带简介 ≈ 5600 字节，再长就爆）
  const rows = Array.from({ length: 20 }, (_, i) =>
    realRow({
      bvid: `BV1x${String(i).padStart(9, '0')}`,
      title: `【第${i}条】这是一个很长很长的视频标题，用来把预算真的撑爆，顺便测试截断`,
      description: '这是一段比较长的简介，用来把预算撑爆。'.repeat(4),
    }),
  )
  const items = toItems({ result: rows }, { q: 'x', limit: 20 })
  const bytes = bytesOf(items)
  assert.ok(bytes <= 6000, `正文 ${bytes} 字节应落在 6000 以内（核心预算 8192，要留外壳）`)
  assert.ok(items.length >= 15, `不该因为预算就丢掉大半结果（实际 ${items.length} 条）`)
})

test('search：预算撑爆时先把简介整批降级，实在放不下才丢尾部条目', () => {
  // A：长标题（full 版本仍放得下）→ 20 条，带简介
  const longTitles = Array.from({ length: 20 }, (_, i) =>
    realRow({ bvid: `BV1x${String(i).padStart(9, '0')}`, title: '超长标题'.repeat(80), description: '超长简介'.repeat(80) }),
  )
  const a = toItems({ result: longTitles }, { q: 'x', limit: 20 })
  assert.ok(bytesOf(a) <= 6000, `A 超预算：${bytesOf(a)}`)
  assert.ok(a[0].text.includes('简介'), 'A 的 full 版本放得下，不该白白降级')

  // B：标题与作者都超长（lean 之后才放得下，还是超就只能丢）
  const heavier = longTitles.map((r) => ({ ...r, author: '超长作者名'.repeat(10) }))
  const b = toItems({ result: heavier }, { q: 'x', limit: 20 })
  assert.ok(bytesOf(b) <= 6000, `B 超预算：${bytesOf(b)}`)
  if (b.length < 20) {
    assert.ok(!b[0].text.includes('简介'), '丢条目时一定是先降到 lean')
    assert.ok(b[0].text.includes('BV1x'), 'BV 必须留着——那是唯一能追回视频的信息')
  }
})

test('search：到 items 的字段不带内部字段 lean（核心只认约定字段）', () => {
  const [it] = toItems({ result: [realRow()] }, { q: 'x', limit: 5 })
  assert.deepEqual(Object.keys(it).sort(), ['actor', 'ext_id', 'kind', 'media', 'text', 'ts'])
})
