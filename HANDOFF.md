# 词汇训练 (Vocab Drill) 交接文档

> 交接对象：后续接手维护/迭代的 AI Agent 或开发者
> 最后更新：2026-10-30（v3.3.0：例句库一义一例 + 识别改四选一 + 拼写加认识/不认识 + 下线听音）

## 1. 项目一句话

纯本地、零构建、零后端的键盘流背单词单页应用：落地是「今日任务」封面（目标环 + 待复习 + 7 天预测），一键进入卡片速刷。识别模式是**四选一选择题**（答对自动翻页），拼写模式给「认识/不认识」两个选项，每个释义都配自己的例句。在线地址：**https://sunny-beat.github.io/vocab-drill/**（GitHub Pages 自动部署，可安装为 PWA）；本地双击 `index.html` 同样可用。

## 2. 技术栈与架构约束

- **纯静态**：HTML + CSS + 原生 JS（有分号、函数声明为主、强调「`file://` 直开必须可用」）。**不要引入构建工具**——双击打开是核心使用方式。
- 词书数据以 `<script>` 标签加载 `data/*.js`（全局 `window.VD_DATA`），而非 fetch——绕开 `file://` 的 CORS 限制。
- **FSRS-6 算法**：`js/vendor/fsrs.esm.js`（ts-fsrs 5.4.2 原包，勿改）→ 由 `tools/build_fsrs_global.py` 转成 `js/vendor/fsrs.global.js`（经典脚本，挂 `window.FSRS`）。**必须用经典脚本**：ES module 在 `file://` 下会被 CORS 拦，而用户的常用方式是双击 index.html。改算法版本时先换 esm 再跑脚本。
- PWA：`manifest.webmanifest` + `sw.js`（仅 http/https 注册，`file://` 自动跳过）。**双缓存**：`vd-shell-<VER>` 装外壳（~60KB，安装时预缓存，逐项重试）、`vd-data-<VER>` 存词库（首次加载时按需缓存，避免每次更新代码重下 3.4MB）。
- 进度存储：`localStorage` key = `vocabdrill.v2`。线上（github.io）、本地 127.0.0.1、`file://` 三者的存储互相隔离。

## 3. 目录结构

```
vocab-drill/
├── index.html              # 单页入口（4 页面 + 底部导航 + modal）
├── manifest.webmanifest    # PWA 清单（start_url/scope 均为相对路径 "./"）
├── sw.js                   # Service Worker：导航 network-first、静态 SWR
├── icons/                  # icon.svg（源）+ icon-192/512 + apple-touch-180
├── css/style.css           # ~980 行。CSS 变量双主题：浅色=暖纸 / 深色=柔夜，主色绿
├── js/app.js               # 全部逻辑（~1800 行）
├── js/vendor/fsrs.esm.js   # ts-fsrs 5.4.2 ESM 原包（勿手改）
├── js/vendor/fsrs.global.js# 生成物（勿手改），window.FSRS 全局
├── data/cet6.js            # 词书数据（生成物，勿手改）
├── data/kaoyan.js
├── tools/convert.py        # 词库管线（Python 3，无第三方依赖）
├── tools/sent_pick.py      # 例句择优：质量分层 + 词性判别 + 释义对齐
├── tools/check_sent.py     # 例句覆盖率/质量自检（抽样人工过目）
├── tools/build_fsrs_global.py  # ESM → 经典脚本
├── tools/make_icons.py     # SVG → PNG（用系统 Edge 无头截图，免装 Pillow）
├── tools/smoke.mjs         # 冒烟测试（零依赖 CDP：http 31 项 / file 26 项）
├── tools/shots.mjs         # 关键页面截图（视觉回归）
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
- `sentences`: **与 `defs` 等长、一义一例**，元素为 `[英文, 中文]`；没有合适例句的释义是 `null`
  - 单义词只留 1 条最好的；多义词每个释义各一条，尽量不重复
  - 精选逻辑在 `tools/sent_pick.py`：A 级=完整句（大写开头 + 句末标点 + 5~26 词 + 生僻词占比 ≤30%）、B 级=兜底碎片；先按**词性一致**（看句中形态）再按**释义中译汉字二元组重合度**做贪心分配
  - 覆盖率：释义 98.3%、多义词全配 93.9%（没有就留空，不硬凑）
- `synonyms`: 最多 6 个单词形（无释义）
- 词书合并口径：CET-6 = 四级+六级增量；考研 = 四级+六级+考研增量（同义词/排名跨词书取并集/min）；**例句在三份数据间合并成池子**后再择优，覆盖更全
- 体积：cet6 1.43MB / kaoyan 1.52MB（比"每词 2 句"的旧版更小，因为单义词只存 1 句）

## 5. 核心机制（js/app.js 关键索引）

| 机制 | 函数/位置 | 说明 |
|---|---|---|
| **封面/今日任务** | `renderHero()` `prepareBook()` `dueCount()` `forecastBuckets()` | 学习页有两个互斥状态：`#hero`（封面）和 `#study-main`（卡片区）。`renderCard()` 会隐藏 hero、显示 main；`renderHero()` 反之。所有"重新开始一批"的入口都要注意当前处于哪个状态 |
| **开始学习** | `startSession()` | 封面的按钮/空格键走这里：`buildQueue({})` → `renderCard()`。有当日会话时 init 直接续背，不经过封面 |
| 启动流程 | `init()` | `prepareBook()` 只准备词书（不建队列）→ 有 `S.session` 且是同书同天 → `buildQueue()+restoreSession(快照)`；否则 `renderHero()`。**快照必须在 buildQueue 之前取**（buildQueue 会清 `S.session`） |
| 模式切换 | `setMode(m)` / `toggleMode()` | 顶栏 `#modeseg` 两个按钮直达，`M` 键在两模式间切换。**封面/完成页时不能 renderCard**（`onCard` 判断） |
| 卡片动效 | `renderCard(dir)` | `dir` 传评分值：1/2 → `enter-down`（从上滑入），3 → `enter-up`（从下滑入） |
| 快捷键表单 | `openKeys()` | `?` 或页脚「全部 ?」或设置里「快捷键」，12 条 |
| 章节字母导航 | `renderBooksPage()` 内 `.chnav` | 按首字母生成跳转按钮，`scrollIntoView` 定位 |
| FSRS 调度 | `F()` `buildFsrsCard()` `grade()` | 封装 `window.FSRS`（fsrs.global.js），`enable_short_term:false`（天级调度，当日重复交给轮次巩固）。评分 1/2/3 → Rating Again/Hard/Good。**未加载时全链路自动降级到 INTERVALS 表** |
| 目标记忆率 | `S.settings.retention` + `F()` | 80/85/90/95%，改设置时置 `_FSRS=null` 重建调度器 |
| 间隔预览 | `nextIntervalPreview(p, g)` | **只在答完后作为信息显示**（`下次复习：3天`）。v3.3 起不再挂在评分按钮上——用户反馈看不懂 `≈2天 / +3天` |
| **识别四选一** | `buildQuizOptions()` `answerQuiz()` | 正确释义 + 3 个干扰项。干扰项**同词性优先、长度接近、字面重合低**，并排除双向近义词 |
| **自动评分** | `answerQuiz()` / `showSpellAnswer()` | 答对=3；答对但超时（识别 6s / 拼写 12s）=2；答错=1。用户不再手动挑三档 |
| **答对自动翻页** | `answerQuiz()` 内 `cardSeq` 守卫 | 0.9s 后 `grade()`；期间按空格立即前进。`cardSeq` 在每次 `renderCard()`/`renderDone()` 自增，旧计时器据此作废——**新增"延时跳转"必须沿用这个守卫** |
| **拼写认识/不认识** | `renderCard()` 的 spell 分支 + `showSpellAnswer()` | 「认识」=提交拼写（回车）、「不认识」=看答案（`Esc`）；答案态会隐藏输入框、挖空句和重复的释义提示 |
| 记忆留存率 | `retrievability(p)` | 优先 `fsrs.get_retrievability()`（FSRS-6 曲线，t=S 时恰为 90%），异常时退回 FSRS-5 公式 |
| 旧进度迁移 | `buildFsrsCard()` 内 | 无 stability 字段的旧 lv/due 进度 → S=2^lv |
| 轮次巩固 | `pendingWords()` + `renderCard()` 开头 | 队列刷完且 sessionGrades 有非 3 分 → 自动开下一轮，直到全部「认识」 |
| 会话持久化 | `saveSession()` / `restoreSession()` | 快照存 `S.session`（当天有效），评分后 QI++ 再存（时序坑，见 §7） |
| 章节模型 | `buildChapters()` | 按首字母分组，>40 词拆 A1/A2；`CHAPTERS[i] = {label, words[]}` |
| 两模式 | `renderCard()` | `recog`（识别四选一）/ `spell`（拼写+挖空 `clozeHint(w, entry)`）。**听音模式 v3.3 已下线**，`loadState()` 会把老数据的 `mode:'listen'` 回落成 `recog` |
| 收藏 | `S.stars` + `starCycle()` | 1=收藏 2=重点；快捷键 F |
| 查词 | `initDictPage()` `richCardHtml()` | 精准命中内嵌词条卡；同义词 chip 点击 `openDetail()` 跳转；查词历史 `S.shist`（12 个） |
| **释义渲染** | `defsHtml(defs, sents)` `sentOf()` `firstSent()` | 第二个参数是"与 defs 对齐的例句数组"，**不传就不显示例句**。凡是新增"展示释义"的地方都要把例句一起传进去，否则那条释义看起来像没例句 |
| PWA | `registerSW()` `installApp()` `updateCache()` | http/https 注册 sw.js；设置页「安装到桌面」「立即更新」 |

**状态对象 `S`**（localStorage 持久化）：`settings{book,mode,newPerDay,autoSpeak,theme,retention}` / `progress{word:{due,stability,difficulty,last,state,lv,wrong,lastWrong}}` / `days{YYYY-MM-DD:{n,r}}` / `books{bookId:{chapter}}` / `stars` / `shist[]` / `session` / `page`。

## 6. 测试与部署

**本地测试**：`python -m http.server 8642 --bind 127.0.0.1`（后台跑） + `node tools/smoke.mjs`。

`tools/smoke.mjs` 是自带的冒烟测试：用 Node 22 内置 WebSocket 直连 Edge 的 CDP（**不需要装 Playwright**），
用独立临时 profile + 禁用 HTTP 缓存，断言 封面落地与三指标、开始学习、FSRS 加载、四选一（4 项/仅 1 正确/文本不重复）、答错反馈与停留、
答错落错词本、答对写 stability 且自动翻页、记忆留存率、两模式（分段控件 + 拼写认识/不认识）、例句与释义一一对齐、覆盖率 ≥95%、四页面、
manifest/SW 外壳预缓存、词库进离线缓存、断网重载仍可用、运行期无异常。**http 31 项 / file 26 项**，两个协议都要跑：

```bash
node tools/smoke.mjs "http://127.0.0.1:8642/index.html"
node tools/smoke.mjs "file:///E:/.../vocab-drill/index.html"     # file:// 自动跳过 SW 检查
```

要写临时断言时，直接复制 `tools/smoke.mjs` 里的 `js()` 用法即可（表达式内可 `await`，外层已包 async IIFE）。

**视觉回归**：`node tools/shots.mjs` 会用同样的 CDP 通道把 封面 / 识别卡 / 答错反馈 / 答对反馈 / 拼写卡 / 拼写答案 / 词书页 截到 `_tmp/shots/*.png`（该目录在 .gitignore 里），改样式后直接看图比对。
注意截图时机：答对后 0.9s 就会自动翻页，抓"答对态"必须把等待压到 150ms 内（`shot(name, preWait)` 的第二个参数）。

**自动化已知坑**：
1. 该环境 Playwright locator `.click()` 会超时——用 `element.click()` 派发；键盘用 `new KeyboardEvent('keydown', {key:'3', bubbles:true})`，合成事件无 `e.code`（代码已做 `e.code || e.key` 双判定）。
2. Edge profile 会缓存 HTML/JS。曾经因为复用 profile 读到旧 index.html，得出「改没生效」的错误结论——**每次测试用新 profile + 禁缓存**。
3. 测完 `localStorage.clear()` + 关标签，避免污染用户数据。
4. `--dump-dom` 抓不到异步渲染结果，要断言就用 CDP `Runtime.evaluate`。

**部署**：commit + `git push` → GitHub Pages 自动构建（约 1-2 分钟）。Pages 对静态资源有 ~10 分钟缓存；**改了前端资源请同时提升 `sw.js` 里的 `VER` 常量和 `app.js` 的 `APP_VER`**，否则老用户会被 SW 缓存钉在旧版（救急：设置 → 立即更新）。gh CLI 已认证（账号 sunny-beat）。

## 7. 已知坑与设计决策（别踩）

1. **ESM 在 `file://` 下加载不了**。曾经 `index.html` 用 `<script type="module">` + `import('./vendor/fsrs.js')`，路径还错了一级（真实位置 `js/vendor/`），导致 FSRS 长期**静默失效**、全靠 INTERVALS 兜底表，界面上看不出来。现在统一走 `fsrs.global.js` 经典脚本，**不要再改回 ESM**。
2. 经典脚本里的动态 `import()` 相对**文档**解析（不是相对脚本），跨目录时极易踩空。已在 `F()` 里彻底移除动态导入。
3. **会话快照时序**：快照必须在 `QI++` **之后**保存，否则刷新后重放刚刷过的卡（已修，别动顺序）。另外 `restoreSession()` 结尾必须再 `saveSession()` 回写一次——`buildQueue()` 会把 `S.session` 清空，若恢复后不回写，**连着刷新两次就会掉回封面、丢失队列位置**（v3.2 修）。
4. **CET 词表不含超基础词**：源词表本身如此，不是转换丢数据。同义词 chip 点击未收录词会置灰（.dim）+ toast 提示，属预期行为。
5. **`认识`不再重现**：v1 曾把所有评分都重新入队，现只有 1/2 分进轮次巩固。
6. **完成页会清 `S.session`**，`renderDone()` 里轮次状态归零的顺序影响副标题显示，改动前先读该函数。
7. **SW 缓存版本**：`sw.js` 的 `VER` 是缓存名的一部分（shell 与 data 各一份），activate 时清掉旧 `vd-shell-*` / `vd-data-*`；改前端资源必须同时提 `sw.js` 的 `VER` 与 `app.js` 的 `APP_VER`，否则用户会拿到新旧混合文件。救急入口：设置 → 立即更新（清缓存重载，不动进度）。
8. **Pages 上预缓存大文件会偶发失败**（连接被掐）。所以词库不放在 install 预缓存里，走首次访问的 SWR；改 `sw.js` 时别把 `data/*.js` 塞回 `CORE` 数组。
9. 用户实际在用：**`file://` 打开的多个标签页**。改动后提醒用户 F5；绝不主动清用户的 localStorage。
10. **学习页是双态**（hero / study-main）。新加"重建队列"的入口时，先判断当前在哪个状态：封面里重建会直接把用户扔进卡片；封面里调 `renderCard()` 则会因为 `QUEUE` 为空走到完成页。
11. 样式改动集中在 `css/style.css` 末尾的「v3.1 视觉与流畅性升级」段（hero/开关/面板/动效）。改顶栏、底栏、卡片布局时注意这段覆盖了前面的基础规则，别在两处各写一半。
12. 移动端（`max-width:560px`）会隐藏键盘提示，并压缩顶栏/正文内边距；改布局时两档都要看一眼截图。
14. **干扰项不能随便取**。同词性优先、长度接近、字面重合低、双向近义词排除——不这么做会出现"两个答案都对"或"一眼排除三个"。改 `buildQuizOptions()` 时先跑 `shots.mjs` 看几屏。
15. **答对的自动翻页有 0.9s 窗口**，靠 `cardSeq` 作废旧计时器。任何"手动翻页"路径（`#qnext`、空格、`undo()`）都会让 `cardSeq` 变，计时器自然失效；反过来，**别在别的异步回调里直接 `grade()`**，先比 `cardSeq`。
16. **`clozeHint()` 的挖空用 ASCII `_____`**。曾用全角 `＿＿＿`，三个字宽空格看起来像 `_ _ _`，既难看又暗示了词长。
17. 对标产品取舍（这一轮刻意借鉴的）：墨墨的「今日任务 + 数据量化」→ 封面的目标环与 7 天预测；不背单词的「沉浸卡片 + 极简」→ 卡片撑满居中、动效、留白；Anki 的「全键盘 + 间隔预览」→ 已有，本轮补了 `?` 快捷键表和方向感动效。**刻意没做**：图片联想（百词斩，需图片资源）、社交打卡（扇贝，与本地单机定位冲突）。
    v3.3 追加：识别改成**四选一**（百词斩/扇贝的"认识就过"过不了考试场景，四选一逼真回忆且能自动判分），并砍掉"自评三档 + 间隔预览按钮"——用户实测看不懂 `≈2天`，改用**答题结果 + 犹豫时长自动映射**，间隔只在答完后提示。

## 8. 待办/建议方向（按优先级）

1. **错词听写**：错词本 + 纯听写（只放读音，不给释义）。拼写模式已经在，缺的是"不看释义只靠听"这一档；听音辨意（4 选 1）已随模式精简下线，真要做听，建议做成听写而不是再回到选择题。
2. **自定义词库导入**：粘贴/上传词表 → 生成 `VD_DATA.custom`（沿用现有 script 数据格式），导入后自动出现在词书下拉里。墨墨的招牌能力，本地化实现不难。
3. **随身听（后台听）**：连续播单词+释义，锁屏也能放——不背单词的强项，用现有 SpeechSynthesis 拼一个即可。
4. **FSRS 参数个性化（优化器）**：目前只有目标记忆率可调；积累复习记录后可接 ts-fsrs 的 optimizer 反推 w 参数（需要 review log，现在没存——要做得先在 `grade()` 里落 log）。另外"犹豫时长 → 模糊"目前是固定阈值（识别 6s / 拼写 12s），可以改成按个人中位反应时自适应。
5. **数据云同步**（可选）：目前仅 localStorage + 手动导出/导入 JSON。
6. 词库扩展：源仓库还有托福/雅思/专四专八/GMAT（`convert.py` 的 `books` 列表加条目即可，下载用 jsDelivr）。注意 PWA 预缓存列表要同步加文件。
7. 封面可以加「上次学到 List Ax / 连续 3 天」的回忆钩子，以及一周目标（周视图）。

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
node tools/smoke.mjs                      # 31 项断言（http）/ 26 项（file）
node tools/shots.mjs                      # 截图到 _tmp/shots/，肉眼比对
node tools/smoke.mjs "file:///E:/.../vocab-drill/index.html"

# 部署
git add -A && git commit -m "..." && git push   # Pages 自动部署
```
