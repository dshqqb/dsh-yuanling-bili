#!/usr/bin/env node
// scripts/pack.mjs —— 打发行包（tgz），给 `yuanling module install --file` 用。
//
// 为什么要自己写 tar：这个仓库是零依赖的（模块本身也要求零依赖），
// 装个 tar 库只为打包不值得。两个字段的宽度必须精确，写错了解包会报"特殊成员"：
//   · size 是**八进制**，占 11 字节（偏移 124）
//   · checksum 是**8 字节**（偏移 148），写成 9 字节会覆盖偏移 156 的 typeflag
//
// 只打这些：yuanling.module.json / src/ / scripts/ / package.json / README.md / LICENSE。
// test/ 与 .git 不进包——模块不需要自带测试，装了也只是占地方。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const OUT_DIR = path.join(ROOT, 'dist')

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'yuanling.module.json'), 'utf8'))
const VERSION = manifest.version

const INCLUDE = ['yuanling.module.json', 'package.json', 'README.md', 'LICENSE']
const INCLUDE_DIRS = ['src']

function walk(dir, rel, files) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    const next = `${rel}/${name}`
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      files.push({ name: `${next}/`, data: Buffer.alloc(0) })
      walk(full, next, files)
    } else if (st.isFile()) {
      files.push({ name: next, data: fs.readFileSync(full) })
    }
  }
  return files
}

function collect() {
  const files = []
  for (const f of INCLUDE) {
    const p = path.join(ROOT, f)
    if (fs.existsSync(p)) files.push({ name: f, data: fs.readFileSync(p) })
  }
  for (const d of INCLUDE_DIRS) {
    const p = path.join(ROOT, d)
    if (fs.existsSync(p)) walk(p, d, files)
  }
  return files
}

/**
 * 512 字节 tar 头。
 *
 * `typeflag` 不能偷懒写 '0'：目录必须是 **'5'**（并且名字以 `/` 结尾）。
 * 写成 '0' 的话，解包方会把它当成一个零字节的**文件**建出来，随后往这个"目录"里写子文件时
 * 就撞 EEXIST —— 报错信息是 `mkdir 'src/sources' exists`，看起来像解包器的毛病（真踩过）。
 */
function header(name, size, typeflag = '0') {
  const h = Buffer.alloc(512)
  h.write(String(name).slice(0, 100), 0, 'utf8')
  h.write('0000644\u0000', 100, 8) // mode
  h.write('0000000\u0000', 108, 8) // uid
  h.write('0000000\u0000', 116, 8) // gid
  h.write(`${size.toString(8).padStart(10, '0')}\u0000`, 124, 11) // size：八进制
  h.write('00000000000\u0000', 136, 12) // mtime 占位
  h.write(typeflag, 156, 1)
  h.write('ustar\u0000', 257, 6)
  h.write('00', 263, 2)

  h.fill(0, 148, 156) // checksum 先清零再算
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += h[i]
  h.write(`${sum.toString(8).padStart(7, '0')}\u0000 `, 148, 8) // 8 字节，多写 1 字节会覆盖 typeflag
  return h
}

const files = collect()
const blocks = []
for (const f of files) {
  if (f.data.length === 0 && f.name.endsWith('/')) {
    blocks.push(header(f.name, 0, '5')) // 目录：typeflag 5，无内容块
    continue
  }
  blocks.push(header(f.name, f.data.length))
  if (f.data.length) {
    blocks.push(f.data)
    const pad = (512 - (f.data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
}
blocks.push(Buffer.alloc(1024)) // 结束标记

fs.mkdirSync(OUT_DIR, { recursive: true })
const dest = path.join(OUT_DIR, `${manifest.id}-${VERSION}.tgz`)
const bytes = zlib.gzipSync(Buffer.concat(blocks))
fs.writeFileSync(dest, bytes)

const kb = (bytes.length / 1024).toFixed(1)
console.log(`✓ 打好：${dest}`)
console.log(`  ${kb} KB，含 ${files.length} 个条目（${manifest.id} v${VERSION}）`)
console.log(`  正文清单：${files.map((f) => f.name).join(' ')}`)
console.log('')
console.log('装到数据目录：')
console.log(`  yuanling module install --file "${dest}"`)
