# 架构说明

一份「为什么这样写」的记录。想改代码前先看这个，能省掉半天。

## 1. 整体形状

```
index.html ──加载──> css/style.css
           └─────> js/vendor/fsrs.global.js   (调度算法，全局变量 FSRS)
           └─────> js/app.js                 (全部业务逻辑，单个 IIFE)
                        │
                        ├─ 懒加载 data/<book>.js   → window.VD_DATA[book]
                        ├─ 懒加载 data/dict.js     → window.VD_DICT（9.8 万词，查词用）
                        ├─ 懒加载 data/paper.js    → 真题例句
                        └─ 懒加载 data/exam.js     → 考试词层（短语/双语例句/近义词）
```

没有模块系统、没有打包。`data/*.js` 就是「给全局对象赋值」的脚本，用 `<script>` 动态插入，
所以**背单词的人永远不会下载那 8 MB 字典** —— 只有点进「查词」页才会请求。

## 2. 数据分三层，别混

| 层 | 文件 | 进不进背诵队列 | 什么时候加载 |
|---|---|---|---|
| 词书 | `data/cet6.js` `data/kaoyan.js` | **进** | 选词书时 |
| 考试词层 | `data/exam.js` | 不进，只补词条内容 | 打开词条卡时 |
| 真题层 | `data/paper.js` | 不进，只给例句 | 打开词条卡时 |
| 字典 | `data/dict.js` | **永不进** | 只在查词页 |

判断一个词能不能背：看它在不在 `WORDS`（当前词书），而不是看它在不在字典里。
这条界线一旦混了，队列会被 9.8 万词淹没。

## 3. 状态对象 `S`

全部状态在 `localStorage['vocabdrill.v2']` 一个键里，一个对象：

```js
S = {
  settings:  { book, mode, newPerDay, reviewCap, introBatch, order, retention, ... },
  progress:  { word: { lv, due, wrong, lastG, stability, difficulty } },
  days:      { 'YYYY-MM-DD': { n, r } },        // 当日新词/复习数，算打卡和进度
  books:     { cet6: { chapter: 3 } },
  stars:     { word: 1 | 2 },                   // 收藏 / 重点
  pause:     { word: 0 },                       // 已掌握，永久移出队列
  notes:     { word: '我自己的释义' },
  skills:    { word: { recog|spell|ctx|listen: { n, ok, msn, ms, hint } } },
  confuse:   { word: { 干扰词: 次数 } },          // 易混对
  meta:      { changedAt }                      // 内容指纹时间，云同步用
}
```

`save()` 会算一次内容指纹，**只有指纹变了才更新 `meta.changedAt`**。
切页面、换主题、改 `page` 字段都不算「数据改动」—— 这条是云同步不打架的前提。

## 4. 队列怎么来

- `newWords(n, chapter, strict)`：按词书顺序从当前 List 往后取没学过的词。
- `randomNewWords()`：`settings.order === 'random'` 时走这条，从全书未学词里随机抽。
- `dueWords()`：`due <= now` 的词，按到期时间升序、同到期按稳定性升序。
- `reviewPlan()`：在 `dueWords()` 之上套「只练错词 / 全部到期」和「每轮上限」，
  再按 `order` 决定要不要洗牌。

> 洗牌必须在**截断上限之后**。先洗再截，每次重绘（切页、换主题、开边栏）都会抽到不同的一批词，
> 于是「本轮复习 40 个」这个数字和真正要练的词对不上，用户会觉得进度在乱跳。

## 5. 一道题的生命周期

```
renderCard()
  ├─ 出题：recommendedMode(word) 决定四选一 / 拼写 / 语境 / 听写
  ├─ 判分：把「对/错、用时、是否用提示、选错的那个选项属于谁」一起记下来
  └─ 答后：
       ├─ FSRS 更新 lv / due / stability
       ├─ skills[word][mode] 累加（分模式的正确率）
       ├─ confuse[word][干扰词]++（攒易混对）
       └─ 本轮内如果答错 → 排进 pendingWords()，这一轮结束前再测一次
```

「复习能切回上一个词」是把评分回滚：`undoLast()` 恢复 `S.progress` 快照并清掉本轮记录。

## 6. Service Worker

两个缓存分开，避免为了改一行 CSS 重下 20 MB 词库：

| 缓存 | 内容 | 策略 |
|---|---|---|
| `vd-shell-<VER>` | html / css / js / 图标 / manifest / cloud-sdk | 安装时预缓存，逐个重试 |
| `vd-data-<VER>` | `data/*.js` | stale-while-revalidate，用过才缓存 |

- 页面导航：**network-first**，断网回退缓存。
- `VER` 必须和 `js/app.js` 的 `APP_VER` **同时改**。只改一个会出现「代码是新的、数据是旧的」
  或者反过来，症状千奇百怪。

## 7. 云同步

- 只在发布域名下可用（服务端做 exact-Origin 校验），`file://` 和 `127.0.0.1` 一律不可用。
- 因此安装包（APK / 桌面版）的外壳**直接加载线上地址**，而不是随包的离线 HTML —— 否则 Origin 对不上，登录必然被拒。
- 冲突判定看 `S.meta.changedAt`（数据自己的改动时间），不看「这台设备最后一次保存的时间」。
  后者会让新设备一登录就自带「我最新」的戳，把空进度推上去覆盖真进度。
- **空进度永不上传**；内容相同不写库。
- SDK 自托管在 `js/vendor/cloud-sdk.js`，CDN 只作兜底：`CLOUD_SDK_URLS` 数组按序试。

## 8. 测试

所有探针都是「Node 22 内建 WebSocket → CDP → 本机 Edge」，不装 Playwright。

- 断言写在脚本里，`ok` / `FAIL` 逐条打印，最后统计通过数。
- 视觉相关（一屏装下、手机布局）用 `Emulation.setDeviceMetricsOverride` 设真实视口再量 rect，
  **不要用** `--window-size`：Edge 有最小窗口宽度，量出来会被误判成 CSS 溢出。
- 改前端资源后必须升版本号，否则 SW 缓存混用，测试会莫名其妙地测到旧代码。

## 9. 踩过的坑（摘要）

1. `String.replace(串, 替换串)` 会把 `$&` `$1` 当占位符 —— 内联源码进 HTML 时必须传函数。
2. JS 注释里不要出现 `<script>` / `</script>` 字面量，单文件打包会数错标签对。
3. `cp a b dir/` 会把文件丢进目录根而不是子目录，发布前务必 md5 逐个核对。
4. 后台起的本地服务会被回收，脚本报一堆 `undefined` 时先 `curl` 一下服务。
5. 调试端口避开 Windows 动态保留段（9181–9780），落进去就是 `bind() 0x271D`。
