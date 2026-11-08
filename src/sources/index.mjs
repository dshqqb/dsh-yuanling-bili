// src/sources/index.mjs —— source 分派表。
//
// source id 必须与 yuanling.module.json 的 `sources[].id` 一一对应：
// 核心会先用 manifest 校验再发请求，所以这里对不上时只会出现"没有模块声明 source"，
// 排查时很难想到是模块自己的表写错了——所以下面有一张显式的对应表 + 一条测试钉住。
import * as search from './search.mjs'
import * as subtitles from './subtitles.mjs'

export const SOURCES = {
  [search.id]: search,
  [subtitles.id]: subtitles,
}

export function sourceIds() {
  return Object.keys(SOURCES).sort()
}

export function getSource(id) {
  return SOURCES[String(id ?? '')] ?? null
}
