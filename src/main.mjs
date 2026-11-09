#!/usr/bin/env node
// src/main.mjs —— 模块主进程：NDJSON 帧协议，一帧一行。
//
// 协议（yuanling PROTOCOL v1.1）：
//   核心 → 我：{op, id, data}
//   我 → 核心：{id, ok:true, result} | {id, ok:false, code, message}
//
// 铁律（写错了就是"模块看起来在跑但什么都不干"）：
//   ① **stdout 只能出协议帧**。任何调试输出走 stderr——核心把非 JSON 的 stdout 判成 E_PROTO 直接断开。
//   ② 帧上限 256KB。字幕很密时靠分段压住，但这里仍然兜一层：超了截断并明说。
//   ③ 每个请求都要回，哪怕失败。不回 = 核心等满超时，看起来像卡死。
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BiliClient, BiliError } from './bili.mjs'
import { getSource, sourceIds } from './sources/index.mjs'

const API = '1.4'
const FRAME_MAX = 256 * 1024

/** 日志一律走 stderr，核心会收进 system/log/modules/bili.log。 */
function log(...args) {
  process.stderr.write(`[bili] ${args.join(' ')}\n`)
}

export function createRuntime({ config = {}, fetchImpl, now, sleep, emit } = {}) {
  const client = new BiliClient({ config, fetchImpl, now, sleep })
  return {
    client,
    config,
    api: API,
    ready: true,
    startedAt: now ? now() : Date.now(),
    // 测试里换成收集器；真实运行时就是写 stdout 的 send()
    emit: emit ?? send,
    diagSeq: 0,
  }
}

// ── v1.4：自报诊断（核心的「诊断」页会把它并进同一张清单）────────────────
//
// 为什么要做：cookie 失效、被限流这些**只有模块自己看得见**的事，只沉在 stderr 里，
// 用户永远不会去翻 system/log/modules/bili.log。报上来之后，诊断页直接说
// "cookie 过期了，去填新的" —— 这是 core 看不见的那一半。
//
// 两条纪律：① 只报"用户能动手解决"的（网络抖动不报，诊断位很贵）；
//          ② 成功时**主动报空**，把上一次的结论撤掉——TTL 是兜底，不是唯一手段。

/** 把一次失败翻译成诊断项；没有 diag 的错误不值得占位。 */
export function diagFromError(error) {
  const d = error?.diag
  if (!d || !d.code) return null
  return { code: d.code, level: d.level ?? 'warn', hint: String(d.hint ?? '') }
}

export function reportDiag(runtime, items) {
  const list = (items ?? []).filter(Boolean)
  const id = `diag-${++runtime.diagSeq}`
  try {
    runtime.emit({ op: 'diag.report', id, data: { items: list } })
  } catch {
    /* 自报失败不该影响取数：它只是让诊断页好看一点 */
  }
  return list
}

/**
 * 处理一帧，返回要回给核心的对象（不含 id）。
 * 抽出来是为了能在没有子进程的情况下单测每一条分支。
 */
export async function dispatch(runtime, { op, data } = {}) {
  if (op === 'ping') {
    return { ok: true, result: { pong: true, at: new Date().toISOString() } }
  }

  if (op === 'init') {
    // 核心会在 init 里带 config（协议 §6）；模块不读配置文件，只认这一份
    if (data && typeof data.config === 'object' && data.config) {
      runtime.client.config = data.config
      runtime.client.timeoutMs =
        Number(data.config.timeoutMs) > 0 ? Number(data.config.timeoutMs) : runtime.client.timeoutMs
      runtime.config = data.config
    }
    runtime.ready = true
    return { ok: true, result: { ready: true, api: API } }
  }

  if (op === 'shutdown') {
    runtime.ready = false
    return { ok: true, result: {} }
  }

  if (op === 'source.fetch') {
    const sourceId = String(data?.source ?? '').trim()
    const mod = getSource(sourceId)
    if (!mod) {
      return {
        ok: false,
        code: 'E_BAD_REQUEST',
        message: `本模块没有 source「${sourceId}」（有：${sourceIds().join(' / ')}）`,
      }
    }
    const params = data?.params && typeof data.params === 'object' ? data.params : {}
    const limit = Number(data?.limit) > 0 ? Number(data.limit) : undefined
    try {
      const items = await mod.fetchItems(runtime.client, params, { limit })
      // 成功了就把之前的诊断结论撤掉（尤其"cookie 过期"这种，成功本身就证明它没失效）
      reportDiag(runtime, [])
      return {
        ok: true,
        result: {
          v: 1,
          source: 'bili', // 核心会盖章成模块 id，这里写的是给日志看的名义
          acct: 'bili',
          items: items.map(trimItem),
        },
      }
    } catch (error) {
      // 预期内的失败（参数错、网络断、没 cookie）在这里就地翻成失败帧；
      // 抛给 handleLine 那一层只留"代码真写错了"的情况，方便区分。
      const code = error instanceof BiliError ? error.code : error?.code ?? 'E_BAD_REQUEST'
      log(`${sourceId} 失败：${code} ${error?.message ?? error}`)
      const diag = diagFromError(error)
      if (diag) reportDiag(runtime, [diag])
      return { ok: false, code, message: String(error?.message ?? error) }
    }
  }

  return { ok: false, code: 'E_UNSUPPORTED', message: `不支持的 op：${op}` }
}

/** 一帧 256KB 的硬上限：正文超了就在这里截断并留痕，别让核心因为帧太大而整条丢弃。 */
function trimItem(item) {
  // `lean` 是模块内部预算适配用的备选文本，不能发给核心（核心只认 items[] 的约定字段）
  const { lean, ...rest } = item
  const it = { ...rest }
  if (typeof it.text === 'string' && Buffer.byteLength(it.text, 'utf8') > FRAME_MAX - 200) {
    // 按字节裁会切坏 UTF-8，按字符近似裁（中文约占 3 字节）
    const cut = Math.max(1, Math.floor((FRAME_MAX - 400) / 3))
    it.text = `${it.text.slice(0, cut)}…（单帧 256KB 上限，已截断）`
  }
  return it
}

function send(frame) {
  if (!process.stdout.writable) return
  try {
    process.stdout.write(`${JSON.stringify(frame)}\n`)
  } catch {
    /* 对端已断开：这条响应本来也没人要 */
  }
}

/**
 * 把 dispatch 的内部结果翻成**协议 §4.2 的信封**。
 *
 * 失败帧必须是嵌套的 `{id, ok:false, error:{code, message, retry}}`。
 * 曾经这里直接把 `code/message` 摊在顶层发出去——核心按协议读 `error.code`，
 * 读不到就一律记成 `E_MODULE` + "模块返回失败"，真实的错误码和说明全丢了。
 * 表现是：单测里消息都清楚，一过核心就只剩一句废话。
 */
export function toFrame(id, r) {
  if (r?.ok) return { id, ok: true, result: r.result ?? {} }
  return {
    id,
    ok: false,
    error: {
      code: String(r?.code ?? 'E_MODULE'),
      message: String(r?.message ?? '模块返回失败'),
      retry: Boolean(r?.retry),
    },
  }
}

export async function handleLine(runtime, line) {
  let req = null
  try {
    req = JSON.parse(line)
  } catch {
    log('收到非法 JSON 帧，丢弃')
    return
  }
  const id = req?.id
  if (id === undefined || id === null) {
    // 通知帧：不需要回应
    return
  }

  // 核心对**我们自己发出去的请求**（diag.report）的回执：带 ok 布尔。
  // 不回它——回了核心就会收到一条"孤儿响应"，日志里多一条警告。
  if (typeof req?.ok === 'boolean') {
    if (!req.ok) log(`自报被拒：${req.error?.code ?? ''} ${req.error?.message ?? ''}`.trim())
    return
  }

  try {
    const r = await dispatch(runtime, req)
    runtime.emit(toFrame(id, r))
  } catch (error) {
    const code = error instanceof BiliError ? error.code : error?.code ?? 'E_BAD_REQUEST'
    log(`${req?.op} 失败：${code} ${error?.message ?? error}`)
    runtime.emit(toFrame(id, { ok: false, code, message: String(error?.message ?? error) }))
  }
}

async function main() {
  const runtime = createRuntime()
  log(`启动（api=${API}，node=${process.version}）`)

  const rl = readline.createInterface({ input: process.stdin })
  const inflight = new Set()

  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    const p = handleLine(runtime, text).finally(() => inflight.delete(p))
    inflight.add(p)
  })

  rl.on('close', () => {
    // 还有没回完的请求就先等它们：核心可能正等着这条响应
    Promise.allSettled([...inflight]).finally(() => process.exit(0))
  })
}

// 只在被当成入口执行时跑循环；被 import（测试）时不碰 stdin
if (isEntryPoint()) {
  main().catch((error) => {
    log(`主循环崩了：${error?.message ?? error}`)
    process.exit(1)
  })
}

function isEntryPoint() {
  if (!process.argv[1]) return false
  // 注意：process.argv[1] 是**普通路径**，不是 file: URL——对它用 fileURLToPath 会得到垃圾（踩过）。
  // 两边都 path.resolve 之后再比，Windows 下还要忽略大小写。
  const self = path.resolve(fileURLToPath(import.meta.url))
  const argv = path.resolve(process.argv[1])
  return process.platform === 'win32' ? self.toLowerCase() === argv.toLowerCase() : self === argv
}
