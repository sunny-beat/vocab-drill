# 词汇训练 (Vocab Drill) 交接文档

> 交接对象：后续接手维护/迭代的 AI Agent 或开发者
> 最后更新：2026-10-26（v3.0.0：FSRS 真正生效 + PWA 离线安装）

## 1. 项目一句话

纯本地、零构建、零后端的键盘流背单词单页应用。在线地址：**https://sunny-beat.github.io/vocab-drill/**（GitHub Pages 自动部署，可安装为 PWA）；本地双击 `index.html` 同样可用。

## 2. 技术栈与架构约束

- **纯静态**：HTML + CSS + 原生 JS（有分号、函数声明为主、强调「`file://` 直开必须可用」）。**不要引入构建工具**——双击打开是核心使用方式。
- 词书数据以 `<script>` 标签加载 `data/*.js`（全局 `window.VD_DATA`），而非 fetch——绕开 `file://` 的 CORS 限制。
- **FSRS-6 算法**：`js/vendor/fsrs.esm.js`（ts-fsrs 5.4.2 原包，勿改）→ 由 `tools/build_fsrs_global.py` 转成 `js/vendor/fsrs.global.js`（经典脚本，挂 `window.FSRS`）。**必须用经典脚本**：ES module 在 `file://` 下会被 CORS 拦，而用户的常用方式是双击 index.html。改算法版本时先换 esm 再跑脚本。
- PWA：`manifest.webmanifest` + `sw.js`（仅 http/https 注册，`file://` 自动跳过）。
- 进度存储：`localStorage` key = `vocabdrill.v2`。线上（github.io）、本地 127.0.0.1、`file://` 三者的存储互相隔离。

## 3. 目录结构

```
vocab-drill/
├── index.html              # 单页入口（4 页面 + 底部导航 + modal）
├── manifest.webmanifest    # PWA 清单（start_url/scope 均为相对路径 "./"）
├── sw.js                   # Service Worker：导航 network-first、静态 SWR
├── icons/                  # icon.svg（源）+ icon-192/512 + apple-touch-180
├── css/style.css           # ~560 行。CSS 变量双主题：浅色=暖纸 / 深色=柔夜，主色绿
├── js/app.js               # 全部逻辑（~1500 行）
├── js/vendor/fsrs.esm.js   # ts-fsrs 5.4.2 ESM 原包（勿手改）
├── js/vendor/fsrs.global.js# 生成物（勿手改），window.FSRS 全局
├── data/cet6.js            # 词书数据（生成物，勿手改）
├── data/kaoyan.js
├── tools/convert.py        # 词库管线（Python 3，无第三方依赖）
├── tools/build_fsrs_global.py  # ESM → 经典脚本
├── tools/make_icons.py     # SVG → PNG（用系统 Edge 无头截图，免装 Pillow）
├── data_raw/               # 原始词库 jsonl（.gitignore，仓库不含）
├── README.md               # 用户向说明
├── HANDOFF.md              # 本文件
└── .gitignore
```

## 4. 数据管线（改词库必读）

**上游**：开源词库 [KyleBing/english-vocabulary](https://github.com/KyleBing/english-vocabulary)。
`data_raw/` 里有 9 个 jsonl，两套来源（均在 .gitignore 中，仓库不含）：

| 文件 | 来源目录 | 提供字段 |
|---|---|---|
| `sent_{cet4,cet6,kaoyan}.jsonl` | `full_line_jsonl/sentence/乱序/` | 释义、短语、US/UK 音标、双语例句 |
| `full_{cet4,cet6,kaoyan}.jsonl` | `full_line_jsonl/full/乱序/` | 同义词（syno.synos）、官方词频排名 wordRank |

**下载渠道注意**：raw.githubusercontent.com 在本机网络下大文件经常中断（curl exit 18）；**用 jsDelivr CDN**：`https://cdn.jsdelivr.net/gh/KyleBing/english-vocabulary@master/<path>`，稳定秒下。中文路径需 URL 百分号编码。

**生成**：`python tools/convert.py` → 输出 `data/cet6.js`、`data/kaoyan.js`。

**输出词条格式**（`VD_DATA.<book>.words` 数组，按字母排序）：

```
[word, defs[], phrases[], freq, usPhon, ukPhon, sentences[], synonyms[], rank]
// 下标： 0      1       2         3    4       5       6            7          8
```

- `defs`: `["v. 丢弃；放弃", ...]`（词性前缀在字符串内，前端用正则拆出高亮）
- `phrases`: `[[短语, 中文], ...]` 最多 3 条
- `freq`: 1=高频（**rank ≤ 500**，约前 30%）
- `sentences`: `[[英文, 中文], ...]` 最多 2 条（按长度升序=最易读优先）
- `synonyms`: 最多 6 个单词形（无释义）
- 词书合并口径：CET-6 = 四级+六级增量；考研 = 四级+六级+考研增量（同义词/排名跨词书取并集/min）

## 5. 核心机制（js/app.js 关键索引）

| 机制 | 函数/位置 | 说明 |
|---|---|---|
| FSRS 调度 | `F()` `buildFsrsCard()` `grade()` | 封装 `window.FSRS`（fsrs.global.js），`enable_short_term:false`（天级调度，当日重复交给轮次巩固）。评分 1/2/3 → Rating Again/Hard/Good。**未加载时全链路自动降级到 INTERVALS 表** |
| 目标记忆率 | `S.settings.retention` + `F()` | 80/85/90/95%，改设置时置 `_FSRS=null` 重建调度器 |
| 间隔预览 | `nextIntervalPreview(p, g)` | 评分按钮上的 `认识 +3天` / `模糊 ≈2天` |
| 记忆留存率 | `retrievability(p)` | 优先 `fsrs.get_retrievability()`（FSRS-6 曲线，t=S 时恰为 90%），异常时退回 FSRS-5 公式 |
| 旧进度迁移 | `buildFsrsCard()` 内 | 无 stability 字段的旧 lv/due 进度 → S=2^lv |
| 轮次巩固 | `pendingWords()` + `renderCard()` 开头 | 队列刷完且 sessionGrades 有非 3 分 → 自动开下一轮，直到全部「认识」 |
| 会话持久化 | `saveSession()` / `restoreSession()` | 快照存 `S.session`（当天有效），评分后 QI++ 再存（时序坑，见 §7） |
| 章节模型 | `buildChapters()` | 按首字母分组，>40 词拆 A1/A2；`CHAPTERS[i] = {label, words[]}` |
| 三模式 | `renderCard()` | `recog`（识别）/ `spell`（拼写+挖空 `clozeHint()`）/ `listen`（听音辨意 `buildListenOptions()`） |
| 收藏 | `S.stars` + `starCycle()` | 1=收藏 2=重点；快捷键 F |
| 查词 | `initDictPage()` `richCardHtml()` | 精准命中内嵌词条卡；同义词 chip 点击 `openDetail()` 跳转；查词历史 `S.shist`（12 个） |
| PWA | `registerSW()` `installApp()` `updateCache()` | http/https 注册 sw.js；设置页「安装到桌面」「立即更新」 |

**状态对象 `S`**（localStorage 持久化）：`settings{book,mode,newPerDay,autoSpeak,theme,retention}` / `progress{word:{due,stability,difficulty,last,state,lv,wrong,lastWrong}}` / `days{YYYY-MM-DD:{n,r}}` / `books{bookId:{chapter}}` / `stars` / `shist[]` / `session` / `page`。

## 6. 测试与部署

**本地测试**：`python -m http.server 8642 --bind 127.0.0.1`（后台跑） + `node tools/smoke.mjs`。

`tools/smoke.mjs` 是自带的冒烟测试：用 Node 22 内置 WebSocket 直连 Edge 的 CDP（**不需要装 Playwright**），
用独立临时 profile + 禁用 HTTP 缓存，断言 FSRS 加载、评分落库、记忆留存率、三模式、四页面、manifest/SW 预缓存、
运行期无异常。两个协议都要跑：

```bash
node tools/smoke.mjs "http://127.0.0.1:8642/index.html"
node tools/smoke.mjs "file:///E:/.../vocab-drill/index.html"     # file:// 自动跳过 SW 检查
```

要写临时断言时，直接复制 `tools/smoke.mjs` 里的 `js()` 用法即可（表达式内可 `await`，外层已包 async IIFE）。

**自动化已知坑**：
1. 该环境 Playwright locator `.click()` 会超时——用 `element.click()` 派发；键盘用 `new KeyboardEvent('keydown', {key:'3', bubbles:true})`，合成事件无 `e.code`（代码已做 `e.code || e.key` 双判定）。
2. Edge profile 会缓存 HTML/JS。曾经因为复用 profile 读到旧 index.html，得出「改没生效」的错误结论——**每次测试用新 profile + 禁缓存**。
3. 测完 `localStorage.clear()` + 关标签，避免污染用户数据。
4. `--dump-dom` 抓不到异步渲染结果，要断言就用 CDP `Runtime.evaluate`。

**部署**：commit + `git push` → GitHub Pages 自动构建（约 1-2 分钟）。Pages 对静态资源有 ~10 分钟缓存；**改了前端资源请同时提升 `sw.js` 里的 `VER` 常量和 `app.js` 的 `APP_VER`**，否则老用户会被 SW 缓存钉在旧版（救急：设置 → 立即更新）。gh CLI 已认证（账号 sunny-beat）。

## 7. 已知坑与设计决策（别踩）

1. **ESM 在 `file://` 下加载不了**。曾经 `index.html` 用 `<script type="module">` + `import('./vendor/fsrs.js')`，路径还错了一级（真实位置 `js/vendor/`），导致 FSRS 长期**静默失效**、全靠 INTERVALS 兜底表，界面上看不出来。现在统一走 `fsrs.global.js` 经典脚本，**不要再改回 ESM**。
2. 经典脚本里的动态 `import()` 相对**文档**解析（不是相对脚本），跨目录时极易踩空。已在 `F()` 里彻底移除动态导入。
3. **会话快照时序**：快照必须在 `QI++` **之后**保存，否则刷新后重放刚刷过的卡（已修，别动顺序）。
4. **CET 词表不含超基础词**：源词表本身如此，不是转换丢数据。同义词 chip 点击未收录词会置灰（.dim）+ toast 提示，属预期行为。
5. **`认识`不再重现**：v1 曾把所有评分都重新入队，现只有 1/2 分进轮次巩固。
6. **完成页会清 `S.session`**，`renderDone()` 里轮次状态归零的顺序影响副标题显示，改动前先读该函数。
7. **SW 缓存版本**：`sw.js` 的 `VER` 是缓存名的一部分，activate 时只清 `vd-shell-` 前缀的旧缓存。改资源不提 VER = 用户拿到新旧混合的文件。
8. 用户实际在用：**`file://` 打开的多个标签页**。改动后提醒用户 F5；绝不主动清用户的 localStorage。

## 8. 待办/建议方向（按优先级）

1. **错词听写模式**：错词本 + 听音拼写组合（听音辨意在 4 选 1，听写更难也更像考试）。
2. **自定义词库导入**：粘贴/上传词表 → 生成 `VD_DATA.custom`（沿用现有 script 数据格式），导入后自动出现在词书下拉里。
3. **FSRS 参数个性化（优化器）**：目前只有目标记忆率可调；积累复习记录后可接 ts-fsrs 的 optimizer 反推 w 参数（需要 review log，现在没存——要做得先在 `grade()` 里落 log）。
4. **数据云同步**（可选）：目前仅 localStorage + 手动导出/导入 JSON。
5. 词库扩展：源仓库还有托福/雅思/专四专八/GMAT（`convert.py` 的 `books` 列表加条目即可，下载用 jsDelivr）。注意 PWA 预缓存列表要同步加文件。
6. 统计页可以加「未来 7 天到期量」预测（纯本地算，`progress[*].due` 现成）。

## 9. 快速上手清单

```bash
# 本地跑
cd vocab-drill && python -m http.server 8642   # http://127.0.0.1:8642/
# 或直接双击 index.html

# 重新生成词库数据
python tools/convert.py

# 升级 FSRS 版本后重新生成经典脚本
# 1) 替换 js/vendor/fsrs.esm.js  2) 执行：
python tools/build_fsrs_global.py

# 改图标后重新生成 PNG
python tools/make_icons.py

# 语法检查 + 冒烟测试（无构建，这就是全部检查）
node --check js/app.js && node --check sw.js
python -m http.server 8642 --bind 127.0.0.1 &
node tools/smoke.mjs                      # 15 项断言
node tools/smoke.mjs "file:///E:/.../vocab-drill/index.html"

# 部署
git add -A && git commit -m "..." && git push   # Pages 自动部署
```
