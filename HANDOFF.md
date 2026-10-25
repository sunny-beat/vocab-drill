# 词汇训练 (Vocab Drill) 交接文档

> 交接对象：后续接手维护/迭代的 AI Agent 或开发者
> 最后更新：2026-10-25（对应 commit `3086418`）

## 1. 项目一句话

纯本地、零构建、零后端的键盘流背单词单页应用。在线地址：**https://sunny-beat.github.io/vocab-drill/**（GitHub Pages 自动部署）；本地双击 `index.html` 同样可用。

## 2. 技术栈与架构约束

- **纯静态**：HTML + CSS + 原生 JS（ES5 风格，`var`-free 但未用框架/打包器）。**不要引入构建工具**——`file://` 直开是核心使用方式。
- 词书数据以 `<script>` 标签加载 `data/*.js`（全局 `window.VD_DATA`），而非 fetch——这是为了绕开 `file://` 下的 CORS 限制。
- FSRS 算法通过 `js/vendor/fsrs.js`（ts-fsrs 5.4.2 的 ESM 打包，23KB，本地 vendor 离线可用）加载。见 §5 已知坑。
- 进度存储：`localStorage` key = `vocabdrill.v2`。线上（github.io）与本地（file://）的存储互相隔离，按域名分。
- 代码风格：无分号偏好不明显（有分号）、函数声明为主、单文件 `js/app.js`（约 1450 行）承载全部逻辑。

## 3. 目录结构

```
vocab-drill/
├── index.html          # 单页入口：4 页面（study/books/dict/list）+ 底部导航 + modal + FSRS module 标签
├── css/style.css       # ~560 行。CSS 变量双主题：浅色=暖纸 / 深色=柔夜，主色绿色
├── js/app.js           # 全部逻辑（~1450 行）
├── js/vendor/fsrs.js   # ts-fsrs 5.4.2 ESM bundle（勿手改，来源 jsdelivr npm/ts-fsrs@5/+esm）
├── data/cet6.js        # 词书数据（生成物，勿手改）
├── data/kaoyan.js
├── tools/convert.py    # 数据管线脚本（Python 3，无第三方依赖）
├── data_raw/           # 原始词库 jsonl（见 §4）
├── README.md           # 用户向说明
├── HANDOFF.md          # 本文件
└── .gitignore          # 忽略 data_raw/（仓库不含原始数据）
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
| FSRS 调度 | `F()` `buildFsrsCard()` `grade()` | ts-fsrs 封装，`enable_short_term:false`（天级调度，当日重复交给轮次巩固）。评分 1/2/3 → Rating Again/Hard/Good。**动态 import 兜底**：静态 module 标签失效时 F() 会 `import('./vendor/fsrs.js')` 自救 |
| 间隔预览 | `nextIntervalPreview(p, g)` | 评分按钮上的 `认识 +3天` 文案 |
| 记忆留存率 | `retrievability(p)` | FSRS 公式 R=(1+19t/81S)^-0.5，显示"记忆 72%" |
| 旧进度迁移 | `buildFsrsCard()` 内 | 无 stability 字段的旧 lv/due 进度 → S=2^lv 换算 |
| 轮次巩固 | `pendingWords()` + `renderCard()` 开头 | 队列刷完且 sessionGrades 有非 3 分 → 自动开下一轮，直到全部「认识」 |
| 会话持久化 | `saveSession()` / `restoreSession()` | 快照存 `S.session`（当天有效），评分后 QI++ 再存（时序坑，见 §7） |
| 章节模型 | `buildChapters()` | 按首字母分组，>40 词拆 A1/A2；`CHAPTERS[i] = {label, words[]}` |
| 三模式 | `renderCard()` | `recog`（识别）/ `spell`（拼写+挖空 `clozeHint()`）/ `listen`（听音辨意 `buildListenOptions()`） |
| 收藏 | `S.stars` + `starCycle()` | 1=收藏 2=重点；快捷键 F |
| 查词 | `initDictPage()` `richCardHtml()` | 精准命中内嵌词条卡；同义词 chip 点击 `openDetail()` 跳转；查词历史 `S.shist`（12 个） |

**状态对象 `S`**（localStorage 持久化）：`settings{book,mode,newPerDay,autoSpeak,theme}` / `progress{word:{due,stability,difficulty,last,state,lv,wrong,lastWrong}}` / `days{YYYY-MM-DD:{n,r}}` / `books{bookId:{chapter}}` / `stars` / `shist[]` / `session` / `page`。

## 6. 测试与部署

**本地测试**：`python -m http.server 8642 --bind 127.0.0.1`（后台）+ 浏览器自动化（ZCode 的 browser-use/node_repl）。

**自动化已知坑**（重要）：
1. 该环境 Playwright 的 locator `.click()` 会超时（count() 能找到但点击挂起）——**用 `playwright.evaluate("document.getElementById('x').click()")` 派发事件**；键盘同理用 `new KeyboardEvent('keydown', {key:'3', bubbles:true})`，注意合成事件无 `e.code`，代码里已做 `e.code || e.key` 双判定。
2. evaluate 只接受**表达式**（字符串拼接或 IIFE），`var x=...;` 语句会 SyntaxError。
3. 测试页与用户自开的 file:// 标签页共存，`tabs.list()[0]` 可能绑错——先 `browser.tabs.list()` 核对 id。
4. 测完必须 `localStorage.clear()` + `tab.close()`，避免污染用户数据。

**部署**：commit + `git push` → GitHub Pages 自动构建（约 1-2 分钟）。**Pages 对静态资源有 ~10 分钟缓存**，push 后验证线上要么等，要么 URL 加 `?v=N` 查询串绕过；用户端强刷 Ctrl+F5 可立即拿到新版。gh CLI 已认证（账号 sunny-beat，repo 权限）。

## 7. 已知坑与设计决策（别踩）

1. **`js/vendor/fsrs.js` 扩展名**：原本是 `.mjs`，但 Windows 下 `python -m http.server` 对 `.mjs` 返回错误 MIME 导致 module 加载被浏览器拒绝——已改名 `.js`。若换静态服务器需注意 MIME。
2. **会话快照时序**：快照必须在 `QI++` **之后**保存，否则刷新后重放刚刷过的卡（已修，改动时别动这个顺序）。
3. **CET 词表不含超基础词**（tell/speech/a 之外的部分常用词）：源词表本身如此，不是转换丢数据。同义词 chip 点击未收录词会置灰（.dim）+ toast 提示，这是预期行为。
4. **`认识`不再重现**：v1 曾把所有评分都重新入队，已改为只有 1/2 分进轮次巩固。
5. **完成页会清 `S.session`**（新批重新计数），`renderDone()` 里轮次状态归零的顺序影响副标题显示，改动前先读该函数。
6. 用户实际在用：**file:// 打开的多个标签页**。改动后提醒用户 F5；绝不主动清用户的 localStorage。

## 8. 待办/建议方向（按优先级）

1. **PWA 离线缓存**（Service Worker + manifest）：线上版可安装到手机主屏、离线可用。注意 SW 的 scope 和缓存失效策略。
2. **错词听写模式**：错词本 + 听音拼写组合，强化最弱环节。
3. **自定义词库导入**：粘贴/上传词表 → 生成 `VD_DATA.custom`（沿用现有 script 数据格式即可）。
4. **FSRS 参数个性化**：目前用默认参数，可加"优化器"入口（需要积累复习记录后基于 ts-fsrs 的 optimizer）。
5. **数据云同步**（可选）：目前仅 localStorage + 手动导出/导入 JSON。
6. 词库扩展：源仓库还有托福/雅思/专四专八/GMAT（`convert.py` 的 `books` 列表加条目即可，下载用 jsDelivr）。

## 9. 快速上手清单

```bash
# 本地跑
cd vocab-drill && python -m http.server 8642   # http://127.0.0.1:8642/
# 或直接双击 index.html

# 重新生成词库数据
python tools/convert.py

# 语法检查（无构建，这就是全部检查）
node --check js/app.js

# 部署
git add -A && git commit -m "..." && git push   # Pages 自动部署
```
