#!/usr/bin/env node
// scripts/smoke.mjs —— 真机冒烟：用**真的模块进程 + 真的 B站**跑一遍协议。
//
// 为什么不在 test/ 里：测试不该依赖网络（断网时应该是"跳过"，不是"失败"）。
// 这里是人手动验的：`node scripts/smoke.mjs bili.search_video '{"q":"原灵"}'`
//
// 它做三件事：
//   ① 起 src/main.mjs 子进程（stdin/stdout 走 NDJSON）；
//   ② 发 init → 发 source.fetch → 发 shutdown，按 id 收集响应；
//   ③ 把结果按"核心会给模型的样子"打印出来，好判断能不能看。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('../src/main.mjs', import.meta.url))

const [source, paramsJson] = process.argv.slice(2)
if (!source) {
  console.error('用法：node scripts/smoke.mjs <source> [paramsJSON]')
  console.error('  node scripts/smoke.mjs bili.search_video \'{"q":"原灵"}\'')
  process.exit(2)
}

let params = {}
if (paramsJson) {
  try {
    params = JSON.parse(paramsJson)
  } catch (e) {
    console.error(`params 不是合法 JSON：${e.message}`)
    process.exit(2)
  }
}

/** 和核心一模一样的 cookie 来源：环境变量优先，其次 --cookie 参数，都没有就空跑。 */
const config = {
  sessdata: process.env.BILI_SESSDATA ?? '',
  bili_jct: process.env.BILI_JCT ?? '',
  buvid3: process.env.BILI_BUVUID3 ?? process.env.BILI_BUVID3 ?? '',
  timeoutMs: 20_000,
}

const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
const got = new Map()

child.stdout.on('data', (buf) => {
  for (const line of String(buf).split('\n')) {
    if (!line.trim()) continue
    try {
      const f = JSON.parse(line)
      got.set(String(f.id), f)
    } catch {
      console.error(`⚠ 收到非协议帧（这会让核心断开）：${line.slice(0, 100)}`)
    }
  }
})
child.stderr.on('data', (buf) => process.stderr.write(`[module] ${buf}`))

/** 等某个 id 的响应回来（最多 timeoutMs）。 */
function waitFor(id, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (got.has(id)) return resolve(got.get(id))
      if (Date.now() - started > timeoutMs) return reject(new Error(`等 id=${id} 超时（${timeoutMs}ms）`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

function sendFrame(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`)
}

try {
  sendFrame({ op: 'init', id: 'init', data: { api: '1.1', config } })
  const init = await waitFor('init', 10_000)
  console.log(`init → ${JSON.stringify(init.result)}`)
  if (!init.ok) throw new Error(`init 失败：${init.message}`)

  sendFrame({ op: 'source.fetch', id: 'fetch', data: { source, params, limit: 5 } })
  const res = await waitFor('fetch')
  if (!res.ok) throw new Error(`取数失败：${res.code} ${res.message}`)

  const items = res.result?.items ?? []
  console.log(`\n取到 ${items.length} 条（source=${res.result?.source} v=${res.result?.v}）\n`)
  for (const [i, it] of items.entries()) {
    console.log(`${i + 1}. ext_id=${it.ext_id}`)
    console.log(`   时间=${it.ts ?? '-'}  作者=${it.actor?.name || '-'}`)
    console.log(`   ${it.text.replace(/\n/g, '\n   ')}`)
    if (Buffer.byteLength(it.text, 'utf8') > 2048) console.log('   ⚠ 这条超过 2KB，核心会截断')
    console.log()
  }
  const totalBytes = Buffer.byteLength(JSON.stringify(items), 'utf8')
  console.log(`合计 ${totalBytes} 字节（核心给模型的预算是 8192 字节）`)

  sendFrame({ op: 'shutdown', id: 'bye', data: { reason: 'smoke-done' } })
  await waitFor('bye', 5000).catch(() => {})
  process.exitCode = 0
} catch (error) {
  console.error(`\n✗ ${error.message}`)
  process.exitCode = 1
} finally {
  child.stdin.end()
  setTimeout(() => child.kill(), 2000).unref?.()
}
