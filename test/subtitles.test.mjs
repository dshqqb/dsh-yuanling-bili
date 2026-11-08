// test/subtitles.test.mjs —— bili.video_subtitles 的纯逻辑：选轨道、切段、参数。
//
// 网络那部分不在这里测（断网时不该红）。这里测的都是"错了就整条链路白跑"的环节：
// 轨道挑错 → 拿到英文字幕；切段错 → 模型看到的时间码对不上画面。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validate, pickTrack, segment, SEGMENT_SEC, SEGMENT_CHARS } from '../src/sources/subtitles.mjs'

test('sub：bvid 必填且要像 BV 号', () => {
  assert.throws(() => validate({}), (e) => e.code === 'E_BAD_REQUEST' && /缺少 bvid/.test(e.message))
  assert.throws(() => validate({ bvid: 'av170001' }), /bvid 格式/)
  assert.throws(() => validate({ bvid: 'BV1xx' }), /bvid 格式/)
  assert.deepEqual(validate({ bvid: 'BV1xx411c7mD' }), { bvid: 'BV1xx411c7mD', fromSec: 0, lan: '' })
})

test('sub：from 是分钟，转成秒；负数与非数字都拒', () => {
  assert.equal(validate({ bvid: 'BV1xx411c7mD', from: 3 }).fromSec, 180)
  assert.equal(validate({ bvid: 'BV1xx411c7mD', from: 0.5 }).fromSec, 30)
  assert.throws(() => validate({ bvid: 'BV1xx411c7mD', from: -1 }), /非负/)
  assert.throws(() => validate({ bvid: 'BV1xx411c7mD', from: 999 }), /太大/)
  assert.throws(() => validate({ bvid: 'BV1xx411c7mD', from: 'abc' }), /非负/)
})

test('sub：挑轨道——指定语言优先，其次中文，最后兜底', () => {
  const tracks = [
    { lan: 'en-US', subtitle_url: '//x/en.json' },
    { lan: 'zh-CN', subtitle_url: '//x/zh.json' },
    { lan: 'ai-zh', subtitle_url: '//x/aizh.json' },
  ]
  assert.equal(pickTrack(tracks).lan, 'ai-zh', '默认中文优先，AI 字幕最全')
  assert.equal(pickTrack(tracks, 'en-US').lan, 'en-US', '指定了就听指定的')
  assert.equal(pickTrack(tracks, 'ja').lan, 'ai-zh', '指定的没有就回落到默认策略')
  assert.equal(pickTrack([{ lan: 'en-US', subtitle_url: 'x' }]).lan, 'en-US', '只有外语时用它')
})

test('sub：没有 subtitle_url 的轨道不算数（拿不到地址就是没字幕）', () => {
  assert.equal(pickTrack([]), null)
  assert.equal(pickTrack([{ lan: 'ai-zh' }]), null, '有 lan 没 url，下载不了')
  assert.equal(pickTrack(null), null)
})

test('sub：切段按 1 分钟一桶，时间码是 mm:ss', () => {
  const body = [
    { from: 0, content: '第一句' },
    { from: 30, content: '第二句' },
    { from: 61, content: '第三句' },
    { from: 90, content: '第四句' },
  ]
  const segs = segment(body)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].startSec, 0)
  assert.match(segs[0].text, /\[00:00\] 第一句/)
  assert.match(segs[0].text, /\[00:30\] 第二句/)
  assert.equal(segs[1].startSec, SEGMENT_SEC)
  assert.match(segs[1].text, /\[01:01\] 第三句/)
  assert.ok(!segs[0].text.includes('第三句'), '60 秒之后的不该混进第一段')
})

test('sub：from 会丢掉前面的行，并从那一分钟开始重新切', () => {
  const body = [
    { from: 10, content: '开头' },
    { from: 130, content: '两分十秒' },
    { from: 190, content: '三分十秒' },
  ]
  const segs = segment(body, { fromSec: 120 })
  // 130 落在 [120,180) 这一桶；190 落在 [180,240) 这一桶
  assert.equal(segs.length, 2)
  assert.equal(segs[0].startSec, 120, '从 2 分钟起，第一段的桶是 120')
  assert.match(segs[0].text, /\[02:10\] 两分十秒/)
  assert.ok(!segs[0].text.includes('开头'), '10 秒那行在 fromSec 之前，必须丢掉')
  assert.equal(segs[1].startSec, 180)
  assert.match(segs[1].text, /\[03:10\] 三分十秒/)
})

test('sub：limit 夹在 1~20，空内容行被跳过', () => {
  const body = Array.from({ length: 30 }, (_, i) => ({ from: i * 60, content: `第${i}分钟` }))
  assert.equal(segment(body, { limit: 20 }).length, 20)
  assert.equal(segment(body, { limit: 3 }).length, 3)
  assert.equal(segment(body, { limit: 0 }).length, 20, 'limit=0 当作没给')

  const holes = [{ from: 0, content: '有' }, { from: 10, content: '' }, { from: 20, content: '   ' }]
  const segs = segment(holes)
  assert.equal(segs.length, 1, '空白的字幕行不该占一段')
  assert.ok(!segs[0].text.includes('[' + '00:10]'))
})

test('sub：没有内容时返回空数组，由调用方决定怎么说', () => {
  assert.deepEqual(segment([]), [])
  assert.deepEqual(segment([{ from: 500, content: '晚于 fromSec 的行' }], { fromSec: 999 }), [])
  assert.deepEqual(segment(null), [])
})

test('sub：单段过长会截断并明说（不能让一帧超 256KB）', () => {
  const dense = Array.from({ length: 200 }, (_, i) => ({ from: 0, content: '很密的字幕'.repeat(5) }))
  const [seg] = segment(dense)
  assert.ok(seg.text.length <= SEGMENT_CHARS + 40)
  assert.match(seg.text, /已截断/)
})
