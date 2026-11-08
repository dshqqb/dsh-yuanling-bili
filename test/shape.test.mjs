// test/shape.test.mjs —— 文本整形与预算适配。
//
// 这一层决定了"模型看到的东西像不像人话"。B站的原始字段带高亮标签、HTML 实体、
// 秒数时长、秒级时间戳——不整形的话，模型看到的是网页源码。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  stripHtml,
  formatCount,
  formatDuration,
  formatDate,
  mmss,
  clipChars,
  shapeSearchItem,
  fitBudget,
  bytesOf,
  MODULE_TEXT_BUDGET,
} from '../src/shape.mjs'

test('shape：去掉高亮标签与 HTML 实体（先解实体再剥标签）', () => {
  assert.equal(stripHtml('【<em class="keyword">原灵</em>】解析'), '【原灵】解析')
  assert.equal(stripHtml('a &amp; b'), 'a & b')
  assert.equal(stripHtml('&lt;em&gt;x&lt;/em&gt;'), 'x', '转义写法也要剥掉')
  assert.equal(stripHtml('  多   空格  '), '多 空格')
  assert.equal(stripHtml(null), '')
})

test('shape：播放量按中文习惯折成万/亿', () => {
  assert.equal(formatCount(4901), '4901')
  assert.equal(formatCount(25000), '2.5万')
  assert.equal(formatCount(726000), '72.6万')
  assert.equal(formatCount(120000000), '1.2亿')
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount('abc'), '0')
})

test('shape：时长不重复解析已经是 mm:ss 的字符串', () => {
  assert.equal(formatDuration('1:56'), '1:56')
  assert.equal(formatDuration('12:30'), '12:30')
  // 超过 1 小时才带小时位；59 分钟仍然是 mm:ss，跟 B站自己显示的一致
  assert.equal(formatDuration(3564), '59:24')
  assert.equal(formatDuration(3700), '1:01:40')
  assert.equal(formatDuration(125), '02:05')
  assert.equal(formatDuration(0), '')
})

test('shape：秒级时间戳按本地时区出日期（不是 UTC 的"昨天"）', () => {
  const d = formatDate(1770100000)
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(formatDate(null), '')
  assert.equal(formatDate('2026-11-08T10:00:00Z'), '2026-11-08')
})

test('shape：mmss 补零', () => {
  assert.equal(mmss(0), '00:00')
  assert.equal(mmss(75), '01:15')
  assert.equal(mmss(null), '00:00')
})

test('shape：clipChars 超长要明说裁了，不能悄悄剪短', () => {
  assert.equal(clipChars('abc', 10), 'abc')
  const cut = clipChars('一二三四五六', 4)
  assert.equal(cut.length, 4)
  assert.match(cut, /…/)
})

test('shape：一条搜索结果压成一行，BV/标题/UP/播放/时长/日期都在', () => {
  const item = {
    bvid: 'BV19E4h6yEEQ',
    title: '<em class="keyword">原灵</em> 解析',
    author: '叫我偷油贼',
    play: 25000,
    duration: '1:56',
    pubdate: 1770100000,
    description: '简介写在这里',
  }
  const { text, lean } = shapeSearchItem(item)
  for (const want of ['BV19E4h6yEEQ', '原灵 解析', 'UP:叫我偷油贼', '播放:2.5万', '1:56', '简介:简介写在这里']) {
    assert.ok(text.includes(want), `少了「${want}」：${text}`)
  }
  assert.ok(!text.includes('<em'), '标签必须被剥掉')
  assert.ok(lean.length < text.length, 'lean 是去掉简介的短版')
  assert.ok(!lean.includes('简介'), 'lean 不该有简介')
})

test('shape：没有 BV 的条目由调用方丢弃（这里只保证不炸）', () => {
  const { text } = shapeSearchItem({ title: '无 BV' })
  assert.ok(text.includes('无 BV'))
})

test('shape：预算够就全带简介，不够就整批降级，再不够从尾部丢', () => {
  const rich = [
    { text: 'A'.repeat(100), lean: 'a' },
    { text: 'B'.repeat(100), lean: 'b' },
  ]

  const fits = fitBudget(rich, 10_000)
  assert.equal(fits.items.length, 2)
  assert.equal(fits.lean, false, '预算够就不该降级')

  // 200 字节的富文本 vs 2 字节的 lean：预算 150 时富文本放不下、lean 放得下
  const leanOnly = fitBudget(rich, 150)
  assert.equal(leanOnly.items.length, 2)
  assert.equal(leanOnly.lean, true)
  assert.deepEqual(leanOnly.items.map((i) => i.text), ['a', 'b'])

  // lean 之后每条 1 字节：预算 1 只放得下一条，剩下的从尾部丢
  const dropTail = fitBudget(rich, 1)
  assert.equal(dropTail.items.length, 1)
  assert.equal(dropTail.dropped, 1)

  assert.deepEqual(fitBudget([], 100), { items: [], dropped: 0, lean: false })
})

test('shape：bytesOf 按 UTF-8 字节算，不按字符数', () => {
  assert.equal(bytesOf([{ text: '中' }]), 3)
  assert.equal(bytesOf([{ text: 'ab' }]), 2)
})

test('shape：默认预算小于核心的 8KB（留出外壳的空间）', () => {
  assert.ok(MODULE_TEXT_BUDGET < 8192, '正文预算必须小于核心预算，否则一定被截')
})
