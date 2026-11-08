#!/usr/bin/env node
// scripts/verify-pack.mjs —— 校验打出来的 tgz 能不能被原灵装上。
//
// 为什么不用 GNU tar：CI（ubuntu）上的 tar 与我们本地（Windows bsdtar）行为不完全一致，
// 之前用 `tar -tzf ... | head` 还踩过 SIGPIPE（pipefail 下整步失败）。
// 这里直接用 Node 解 gzip + 走 tar 头，**和原灵的安装器是同一套语义**：
// 只看 manifest 在不在、路径是否合法、成员类型是否允许。
//
// 失败时会把成员清单和原因都打出来——CI 日志能直接定位，不用再猜。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const MANIFEST = 'yuanling.module.json'
const BLOCK = 512

function die(msg, extra = '') {
  console.error(`✗ ${msg}`)
  if (extra) console.error(extra)
  process.exit(1)
}

// 找包：dist/ 下最新的那个 tgz
// 注意用 fileURLToPath：`new URL(...).pathname` 在 Windows 上得到的是 `/D:/...`，
// 再拼一次就变成 `D:\D:\...`（踩过）。
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const distDir = path.join(ROOT, 'dist')
let tgz = null
try {
  const names = fs
    .readdirSync(distDir)
    .filter((n) => n.endsWith('.tgz'))
    .sort()
  if (!names.length) die(`dist/ 里没有 .tgz（目录内容：${fs.readdirSync(distDir).join(', ') || '空'}）`)
  tgz = path.join(distDir, names[names.length - 1])
} catch (error) {
  die(`读不了 dist/：${error?.message ?? error}`)
}

const bytes = zlib.gunzipSync(fs.readFileSync(tgz))

/** 走一遍 tar 头，收集成员。逻辑与 src/core/modules/untar.js 对齐。 */
function listMembers(buf) {
  const out = []
  let pos = 0
  while (pos + BLOCK <= buf.length) {
    const header = buf.subarray(pos, pos + BLOCK)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim()
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const typeflag = header.subarray(156, 157).toString('utf8') || '0'
    const size = parseInt(sizeStr, 8)
    if (!name && (size === 0 || Number.isNaN(size))) break // 结束块
    if (Number.isNaN(size)) die(`成员 ${name} 的 size 字段不是八进制：${JSON.stringify(sizeStr)}`)
    out.push({ name, typeflag, size })
    pos += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  return out
}

const members = listMembers(bytes)
console.log(`包：${tgz}`)
console.log(`成员 ${members.length} 个：`)
for (const m of members) console.log(`  ${m.typeflag === '5' ? 'dir ' : 'file'} ${m.name}  (${m.size} B)`)

// ① 必须有 manifest
if (!members.some((m) => m.name === MANIFEST && m.typeflag !== '5')) {
  die(`包里没有 ${MANIFEST}——原灵装不上`, `成员清单：\n${members.map((m) => '  ' + m.name).join('\n')}`)
}

// ② 路径必须是相对、不带 ..（安装器会拒）
for (const m of members) {
  if (path.isAbsolute(m.name) || m.name.split('/').includes('..')) die(`非法路径：${m.name}`)
}

// ③ 只允许普通文件与目录（符号链接/设备文件一律拒）
for (const m of members) {
  if (!['0', '5', '\u0000', ''].includes(m.typeflag)) {
    die(`不允许的成员类型 typeflag=${JSON.stringify(m.typeflag)}：${m.name}`)
  }
}

// ④ manifest 必须能解析、且 id/version 与我们打 tag 的意图一致
const manifestMember = members.find((m) => m.name === MANIFEST)
let offset = 0
let manifestText = null
let pos = 0
while (pos + BLOCK <= bytes.length) {
  const header = bytes.subarray(pos, pos + BLOCK)
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim()
  const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
  const size = parseInt(sizeStr, 8)
  if (!name && Number.isNaN(size)) break
  if (name === MANIFEST) {
    offset = pos + BLOCK
    manifestText = bytes.subarray(offset, offset + size).toString('utf8')
    break
  }
  pos += BLOCK + Math.ceil((Number.isNaN(size) ? 0 : size) / BLOCK) * BLOCK
}
void manifestMember
if (!manifestText) die('取不到 manifest 内容')
let manifest = null
try {
  manifest = JSON.parse(manifestText)
} catch (error) {
  die(`manifest 不是合法 JSON：${error?.message ?? error}`)
}
if (!manifest.id) die('manifest 缺少 id')
if (!manifest.version) die('manifest 缺少 version')

// ⑤ tag 与 manifest.version 要对得上（tag 名是 vX.Y.Z，版本是 X.Y.Z）
//    CI 里能拿到 GITHUB_REF_NAME；本地跑没有这个变量就跳过这条
const ref = String(process.env.GITHUB_REF_NAME ?? '').trim()
if (ref.startsWith('v')) {
  const tagVer = ref.slice(1)
  if (tagVer !== manifest.version) {
    die(`tag ${ref} 与 manifest 里的 version ${manifest.version} 不一致——发行版会对不上`)
  }
}

console.log(`\n✓ 包结构正常：${manifest.id} v${manifest.version}（api ${manifest.api}）`)
