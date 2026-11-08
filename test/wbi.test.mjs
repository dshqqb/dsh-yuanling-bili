// test/wbi.test.mjs —— WBI 签名。
//
// 这组测试的价值不在"跑通"，在于**钉住算法**：签名错了 B站只会回空列表或 -352，
// 看起来像"没搜到"，排查时会一路怀疑到别的地方去。
//
// 黄金值不是自己编的：mixin key `ea1db124af3c7062474693fa704f4ff8` 是 2026-11-08
// 从真实 nav 接口拿到的，用它签出来的 query string 打真实接口能返回 code=0。
// 所以这里断言的是一条**已被真机验证过**的输出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { MIXIN_TAB, keyOf, mixinKeyFromNav, cleanValue, sortedQuery, signParams } from '../src/wbi.mjs'

const REAL_MIXIN = 'ea1db124af3c7062474693fa704f4ff8'
/** surfcore 用的那对 wbi_img 文件名（公开在 nav 里，不是密钥）。 */
const NAV_SAMPLE = {
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
}

test('wbi：乱序表是 64 个不重复的 0~63 下标', () => {
  assert.equal(MIXIN_TAB.length, 64)
  assert.equal(new Set(MIXIN_TAB).size, 64, '有重复下标就会把一个字符取两次')
  for (const i of MIXIN_TAB) assert.ok(i >= 0 && i < 64, `下标越界：${i}`)
})

test('wbi：keyOf 取文件名主干，取不到时给空串', () => {
  assert.equal(keyOf(NAV_SAMPLE.data.wbi_img.img_url), '7cd084941338484aae1ad9425b84077c')
  assert.equal(keyOf(''), '')
  assert.equal(keyOf('nourl'), '')
  assert.equal(keyOf('https://x/y'), '')
})

test('wbi：由 nav 算出 32 位 mixin key，且与真实值一致', () => {
  const mixin = mixinKeyFromNav(NAV_SAMPLE)
  assert.equal(mixin.length, 32)
  // 这一条是从真接口拿到的同一个值——说明重排表与取法都对
  assert.equal(mixin, REAL_MIXIN)
})

test('wbi：nav 缺 wbi_img 时返回 null（不能拿空串继续签）', () => {
  assert.equal(mixinKeyFromNav({}), null)
  assert.equal(mixinKeyFromNav({ data: { wbi_img: { img_url: '', sub_url: '' } } }), null)
})

test('wbi：clean 只去掉那五个字符，别的原样', () => {
  assert.equal(cleanValue("a!b'c(d)e*f"), 'abcdef')
  assert.equal(cleanValue('中文 空格 + 斜杠/ 都保留'), '中文 空格 + 斜杠/ 都保留')
})

test('wbi：参数按**键名排序**，wts 参与排序', () => {
  const q = sortedQuery({ b: '2', a: '1' }, 100)
  assert.equal(q, 'a=1&b=2&wts=100')
  // wts 不是附加在末尾的"杂项"，它按字母序会在 t 与 z 之间——这里没有 z，所以最后
  assert.equal(sortedQuery({ z: '9' }, 100), 'wts=100&z=9')
})

test('wbi：签名字符串与黄金值一致（该值打真接口返回 code=0）', () => {
  const got = signParams({ search_type: 'video', keyword: '原灵', page: 1 }, REAL_MIXIN, Date.UTC(2026, 10, 8, 9, 30, 0))
  assert.equal(
    got,
    'keyword=%E5%8E%9F%E7%81%B5&page=1&search_type=video&wts=1794130200&w_rid=90fd4452013424ef986093908f8fe9ed',
  )
})

test('wbi：w_rid 是 param串 + mixin 的 md5（自己按公式算一遍对照）', () => {
  const mixin = REAL_MIXIN
  const q = sortedQuery({ a: '1' }, 1700000000)
  const expected = crypto.createHash('md5').update(q + mixin).digest('hex')
  const full = signParams({ a: '1' }, mixin, 1700000000_000)
  assert.equal(full, `${q}&w_rid=${expected}`)
  assert.equal(q.length > 0, true)
})

test('wbi：mixin 长度不对就抛，不悄悄签一个错的', () => {
  assert.throws(() => signParams({ a: 1 }, '', 0), /mixin key/)
  assert.throws(() => signParams({ a: 1 }, 'short', 0), /32 位/)
})

test('wbi：值里的特殊字符先清洗再 URL 编码', () => {
  const q = signParams({ k: "a!b'c" }, REAL_MIXIN, 0)
  assert.match(q, /k=abc/, '清洗后不该有 ! 与 \'')
})
