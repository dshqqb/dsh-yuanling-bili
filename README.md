# dsh-yuanling-bili

原灵的 **B 站模块**。只读：搜视频、拉官方字幕。不发评论、不点赞、不动她的账号。

它和原灵是**两个项目**。这个仓库不 import 原灵一行代码，只通过 [模块协议](https://github.com/dshqqb/dsh-yuanling/blob/main/doc/PROTOCOL.md) 说话（NDJSON 帧，零依赖）。

| | |
|---|---|
| 版本 | `0.1.0`（协议 `api: 1.1`） |
| 用的能力 | `provide.source` — 只被"要数据"，不会往外说话 |
| Gitee | https://gitee.com/dshqqb/dsh-yuanling-bili （**推荐**，国内直连稳） |
| GitHub | https://github.com/dshqqb/dsh-yuanling-bili （镜像） |
| 装它 | `yuanling module install --url https://gitee.com/dshqqb/dsh-yuanling-bili` |

---

## 它能干什么

她可以主动向它要数据（协议 v1.1 的 `source.fetch`）：

| source | 要什么参数 | 拿到什么 |
|---|---|---|
| `bili.search_video` | `q`（必填）、`page`、`order` | 最多 20 条视频：BV 号、标题、UP、播放量、时长、发布日期、简介 |
| `bili.video_subtitles` | `bvid`（必填）、`from`（第几分钟）、`lan` | 按 1 分钟切段的字幕，带 `[mm:ss]` 时间码；一次最多 20 段 |

**取回的东西会先落进原灵的原始层（`raw/`），再交给她看。** 所以"查过"这件事本身是记得的——下次 `recall` 得到的是同一批记录，不是重新编一遍。

## 装上

装完之后，在**原灵管理台的「模块」页**，或者用命令行，填**库的网址**就能装——不用自己拼发行包的地址：

```
https://gitee.com/dshqqb/dsh-yuanling-bili        ← 推荐（国内直连稳）
https://github.com/dshqqb/dsh-yuanling-bili       ← 镜像
```

原灵会去这个库的**发行版**里找 `.tgz` 附件，取最新非预发布的那条。

管理台：模块 → 安装框里粘上面任一地址 → 安装 → 它会问一次"要不要授予 `provide.source`"。

命令行：

```powershell
# 填库的网址
yuanling module install --url https://gitee.com/dshqqb/dsh-yuanling-bili --root "D:\yuanling"

# 指定版本
yuanling module install --url https://gitee.com/dshqqb/dsh-yuanling-bili/releases/tag/v0.1.0

# 或者自己本地打包（不联网）
node scripts/pack.mjs
yuanling module install --file "dist/bili-0.1.0.tgz" --root "D:\yuanling"
```

装完**重启 DSH**（模块是插件启动时拉起的）。

### 装不上时的四种原因（都能照着做）

| 报错 | 真因 | 怎么办 |
|---|---|---|
| 这个库还没有发行版 | 库里只有代码，没有 Release | 按下面「发一个新版本」做一次 |
| 发行版里没有 .tgz 附件 | 只传了源码 zip/tar.gz | 源码包不能装（没有 `yuanling.module.json`），把 `pack.mjs` 打出来的 tgz 传上去 |
| 找不到这个库（HTTP 404） | owner/repo 拼错，或库是私有的 | 改地址，或先把库公开 |
| 拒绝匿名访问（HTTP 403） | 平台限流 | 等几分钟，或改用 `.tgz` 直链 |

### 发一个新版本（让上面那个地址能用）

发行版必须带 **`.tgz` 资产**，名字建议 `bili-<版本>.tgz`。

**GitHub（自动）**：推 tag 就会跑 [`.github/workflows/release.yml`](.github/workflows/release.yml)——跑测试、打包、把 tgz 附到发行版。

```powershell
git tag v0.1.0
git push origin v0.1.0
```

**Gitee（手动，没有 Actions）**：

```powershell
node scripts/pack.mjs                      # → dist/bili-0.1.0.tgz
```

然后在 Gitee 的「发行版」→ 新建发行版 → 填 tag `v0.1.0` → **上传附件** 选那个 tgz。
（Gitee 会自动把源码 zip/tar.gz 也放进资产里，不用管——原灵只认 `.tgz`。）

## 凭据怎么填

字幕要登录态，搜索不要。

`search_video` **匿名也能用**（实测：不带 cookie 搜索返回 `code=0`，20 条结果）。

`video_subtitles` **必须要登录态**：B 站对匿名请求只回 0 条字幕轨道（实测确认过），不是"这视频没字幕"，而是"不给你看"。所以三种情况模块会分开说话：

| 情况 | 模块的反应 |
|---|---|
| 配置里没有 `sessdata` | 明确报错"拿字幕需要登录态"，不会假装"没有数据" |
| `sessdata` 有但已失效（nav 说未登录） | 明确报错"cookie 已失效，重新登录后填新的" |
| 登录正常，这视频真的没字幕 | 返回一条 `notice` 条目说明原因（这是真实观察，落进 raw 也算一条记忆） |

配置项（原灵保管，模块自己不存文件）：

| 在哪填 | 怎么填 |
|---|---|
| **管理台（推荐）** | 模块 → B站 → 概况 tab 最下面的「规则与配置」→ 填完点「保存并重启模块」。保存时会按 schema 校验，成功后**自动重启模块**让新配置生效 |
| 手写文件 | `<数据目录>/system/modules/bili/config.json`，格式如下；改完要重启 DSH 才生效 |

密钥类字段在页面上是密码框，旁边有「显示」可以临时看一眼。

```jsonc
{
  "sessdata": "…",   // 必填才能拉字幕；浏览器 cookie 里的 SESSDATA
  "bili_jct": "…",   // cookie 里的 bili_jct（只读用途，模块不会发任何写请求）
  "buvid3":   "…",   // cookie 里的 buvid3，缺了容易被风控拦
  "timeoutMs": 20000 // 单次 HTTP 超时，默认 20s
}
```

> `sessdata` 与 `bili_jct` 都是凭证：原灵会把它们当密码框显示（输入时遮挡），日志里也不会明文出现。

> 从旧工具（比如 surfcore）迁过来的 cookie 大概率**已经过期**——实测 2026-10-29 保存的那份在 2026-11-08 已失效（nav 回 `-101`）。重新登录 B 站再取一次。

## 为什么这么设计

**只发 GET。** 写请求要 `bili_jct` 与 csrf，那等于把"能改她账号"的钥匙交给一个数据源模块。只读是硬约束，不是配置项。

**必须走 WBI 签名。** B 站现在的搜索与播放器接口都要 `w_rid`：拿 `nav` 里的两个 key 按固定乱序表重排成 32 位 mixin，再把参数按**键名排序**、值去掉 `!'()*`、拼上 `wts`，最后 md5。签名错了不会报错，只会返回空列表或 `-352`——看起来像"没搜到"，所以这条算法有专门的单测钉住。

**字幕必须用 `x/player/wbi/v2`。** 旧的 `/x/player/v2` 也能拿到 `subtitle_url`，但那个 URL 缺 `auth_key`，CDN 会 403 或回错内容。`auth_key` 是分钟级有效，所以拿到就得马上下载；模块会在下载失败时重新签一次再试一次。

**字幕按分钟切段，不整篇塞。** 原灵给模型的取数预算是 8KB，一条长视频的字幕全文几万字，整篇塞进去只会"前 3000 字有用、后面全被截断"。切成 1 分钟一段，20 段 ≈ 20 分钟，扫完能判断要不要继续，续取带 `from` 就行。

**模块自己压文本预算。** 20 条搜索结果带完整简介会超预算，模块会自动整批降级成"不带简介"，再放不下才从尾部丢条目——不让原灵从句子中间一刀切。

**幂等靠 `ext_id`。** 搜索结果的 `ext_id` 是 `search:<关键词>:<BV>`，字幕是 `<BV>:<语言>:<段起点秒>`。同一次搜索重跑不会写第二条；换个关键词搜到同一条视频算两条（"她是在哪个问题下遇到它的"这个信息不该丢）。

## 开发

```powershell
node --test test/*.test.mjs     # 52 条纯函数测试，不联网
node scripts/smoke.mjs bili.search_video '{"q":"原灵"}'   # 真机冒烟（要能上外网）
```

`smoke.mjs` 会真的起模块子进程、走完整帧协议、打真接口，并按"原灵会给模型看的样子"打印结果。

配置 cookie 后可测字幕：

```powershell
$env:BILI_SESSDATA="…"; $env:BILI_JCT="…"; $env:BILI_BUVUID3="…"
node scripts/smoke.mjs bili.video_subtitles '{"bvid":"BV1GJ411x7h7"}'
```

## 现在的验证状态（2026-11-08）

| 项 | 状态 |
|---|---|
| 单测 52 条（WBI 签名 / 文本整形 / 切段 / 帧协议 / manifest 一致性） | ✅ 全过，不联网 |
| WBI 签名打真接口 | ✅ `code=0`，20 条结果；从 nav 算出的 mixin 与实测值一致 |
| 搜索（匿名） | ✅ 可用，不带 cookie 也行 |
| 装进原灵 → 授予 → 取数 → 落 raw | ✅ 真链路验过 |
| 重复取数幂等 | ✅ 第二次全部"以前取过，未重复落库"，raw 条数不变 |
| 字幕 | ⚠️ 代码路径通，但**没拿到真数据**：手头那份 cookie 已失效（nav 回 `-101`），需要你重新登录后再验 |

## 边界

- **不碰原灵的数据目录**：只读 stdin、只写 stdout（协议帧）与 stderr（日志），数据目录的事归核心。
- **不自己存 cookie 文件**：配置由原灵保管，模块通过 `init` 拿到。
- **不发写请求**：评论、点赞、收藏、关注、私信，一个都没有，也不打算加。

## 许可

MIT。
