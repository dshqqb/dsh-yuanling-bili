// test/protocol.test.mjs —— NDJSON 帧协议这一层。
//
// 这一层错了的表现最难排查：模块"在跑"，但核心等满超时，日志里什么都没有。
// 所以这里直接测 dispatch（不起子进程），把每条分支钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRuntime, dispatch } from '../src/main.mjs'
import { SOURCES, sourceIds, getSource } from '../src/sources/index.mjs'
import { BiliError } from '../src/bili.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'yuanling.module.json'), 'utf8'))

test('protocol：init 回 ready 与 api，且把核心给的 config 收下来', async () => {
  const rt = createRuntime()
  const r = await dispatch(rt, { op: 'init', data: { api: '1.1', config: { sessdata: 'S', timeoutMs: 5000 } } })
  assert.deepEqual(r.result, { ready: true, api: '1.1' })
  assert.equal(rt.client.config.sessdata, 'S')
  assert.equal(rt.client.timeoutMs, 5000, '配置里的超时要真的生效')
})

test('protocol：ping 回 pong，不依赖任何状态', async () => {
  const rt = createRuntime()
  const r = await dispatch(rt, { op: 'ping', data: {} })
  assert.equal(r.ok, true)
  assert.equal(r.result.pong, true)
})

test('protocol：shutdown 回应答并标记不再 ready', async () => {
  const rt = createRuntime()
  const r = await dispatch(rt, { op: 'shutdown', data: { reason: 'bye' } })
  assert.equal(r.ok, true)
  assert.equal(rt.ready, false)
})

test('protocol：未知 op 回 E_UNSUPPORTED（不能装死让核心等超时）', async () => {
  const r = await dispatch(createRuntime(), { op: 'nonsense', data: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_UNSUPPORTED')
})

test('protocol：未知 source 回 E_BAD_REQUEST，并把可用列表说出来', async () => {
  const r = await dispatch(createRuntime(), { op: 'source.fetch', data: { source: 'bili.nope' } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_BAD_REQUEST')
  assert.match(r.message, /bili\.search_video/)
})

test('protocol：参数错时错误码是 E_BAD_REQUEST（不是 500 式的崩溃）', async () => {
  const rt = createRuntime()
  const r = await dispatch(rt, { op: 'source.fetch', data: { source: 'bili.search_video', params: {} } })
  assert.equal(r.code, 'E_BAD_REQUEST')
  assert.match(r.message, /缺少 q/)
})

test('protocol：manifest 声明的 sources 与代码里的分派表必须一一对应', () => {
  const declared = (manifest.sources ?? []).map((s) => s.id).sort()
  assert.deepEqual(declared, sourceIds(), '声明的和执行的对不上，核心会报"没有模块声明 source"')
  assert.deepEqual(Object.keys(SOURCES).sort(), declared)
  for (const s of manifest.sources) {
    assert.ok(getSource(s.id), `manifest 里有 ${s.id}，代码里没有`)
    assert.ok(s.title, '每个 source 必须有 title，模型全靠它判断要不要用')
  }
})

test('protocol：manifest 本身合协议——api 1.2、声明 provide.source、入口是 node', () => {
  // v1.2：模块给管理台加了只读/配置型 tab（ui.tabs），所以协议次版本必须是 1.2
  assert.equal(manifest.api, '1.2')
  assert.ok(manifest.capabilities.includes('provide.source'), '没有这个能力，核心根本不会发 source.fetch')
  assert.equal(manifest.entry.command[0], 'node')
  assert.ok(manifest.sources.length >= 2)
  // id 前缀必须是模块自己的 id（协议 §3.4）
  for (const s of manifest.sources) assert.ok(s.id.startsWith(`${manifest.id}.`), `${s.id} 缺前缀`)
})

test('protocol：ui.tabs 声明合法，字段都在 config.schema 里', () => {
  assert.ok(Array.isArray(manifest.ui?.tabs) && manifest.ui.tabs.length >= 1, '要声明自定义 tab')
  const props = Object.keys(manifest.config?.schema?.properties ?? {})
  for (const t of manifest.ui.tabs) {
    assert.match(t.id, /^[a-z][a-z0-9-]{1,23}$/)
    assert.ok(t.label && t.label.length <= 16)
    assert.ok(['kv', 'list', 'text', 'config', 'records'].includes(t.kind), `kind 不合法：${t.kind}`)
    // config 型 tab 认领的字段必须真的存在，否则页面上会静默少几个控件
    for (const f of t.fields ?? []) assert.ok(props.includes(f), `认领了不存在的字段：${f}`)
    // records 型必须给 type（核心按它查原始层，并且强制只查本模块的记录）
    if (t.kind === 'records') assert.match(t.records?.type ?? '', /^[a-z][a-z0-9._-]{0,31}$/)
  }
})

test('protocol：条目里不能漏出内部字段 lean', async () => {
  const rt = createRuntime()
  // 用假的 fetch 造一条最简响应，避免测试依赖网络
  rt.client.fetchImpl = async (url) => {
    if (String(url).includes('nav')) {
      return jsonRes({
        code: -101,
        data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } },
      })
    }
    return jsonRes({ code: 0, data: { result: [{ bvid: 'BV1xx411c7mD', title: '标题', author: 'UP', play: 1, duration: '1:00', pubdate: 1770100000 }] } })
  }
  rt.client.sleep = async () => {}
  const r = await dispatch(rt, { op: 'source.fetch', data: { source: 'bili.search_video', params: { q: 'x' } } })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.result.v, 1)
  assert.equal(r.result.items.length, 1)
  assert.equal(r.result.items[0].lean, undefined, 'lean 是内部字段，不能发给核心')
  assert.equal(r.result.items[0].ext_id, 'search:x:BV1xx411c7mD')
})

test('protocol：B站的业务错误被翻成协议错误码，不是裸异常', async () => {
  const rt = createRuntime()
  rt.client.fetchImpl = async (url) => {
    if (String(url).includes('nav')) {
      return jsonRes({ code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } })
    }
    return jsonRes({ code: -352, message: '风控校验失败' })
  }
  rt.client.sleep = async () => {}
  const r = await dispatch(rt, { op: 'source.fetch', data: { source: 'bili.search_video', params: { q: 'x' } } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_RATE', '-352/-412 是风控限流，外层要知道可重试')
  assert.match(r.message, /风控/)
})

test('protocol：没配 cookie 时取字幕直接说明原因，而不是回空结果', async () => {
  const rt = createRuntime({ config: {} })
  const r = await dispatch(rt, { op: 'source.fetch', data: { source: 'bili.video_subtitles', params: { bvid: 'BV1xx411c7mD' } } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'E_BAD_REQUEST')
  assert.match(r.message, /sessdata/, '要告诉人缺什么')
})

test('protocol：BiliError 带 code（外层靠它回错误码）', () => {
  const e = new BiliError('E_RATE', 'x')
  assert.equal(e.code, 'E_RATE')
  assert.ok(e instanceof Error)
})

/** 造一个 fetch 的假 Response。 */
function jsonRes(obj) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj),
  }
}
