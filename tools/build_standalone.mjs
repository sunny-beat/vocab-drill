/* 打包单文件版：把 CSS / FSRS / app.js / 两本词库全部内联进一个 .html。
 *
 * 目的：`index.html` 只是外壳，靠相对路径引 css/ js/ data/，单独拷出去必然打不开。
 * 单文件版双击即用，发给别人 / 传到手机也不丢资源。
 *
 *   node tools/build_standalone.mjs
 *   node tools/build_standalone.mjs --out "D:/唯单词.html"
 *
 * 产物默认落在项目根目录「唯单词.html」。
 */
import { readFileSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOut = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 ? process.argv[i + 1] : null;
})();
const OUT = argOut || path.join(ROOT, '唯单词.html');

const R = (p) => readFileSync(path.join(ROOT, p), 'utf8');

/* 内联进 <script> / <style> 时必须打断结束标签，否则 HTML 解析器会提前收尾 */
const inScript = (s) => s.replace(/<\/script/gi, '<\\/script');
/* 注意：String.replace 的字符串替换串里 `$&` `$'` `$1` 会被当成占位符。
 * app.js 里正好有 `.replace(/[...]/g, '\\$&')`，直接传字符串会把 HTML 标签塞进源码 →
 * 所以下面所有 replace 的第二个参数一律用函数返回，绝不传裸字符串。 */
const inStyle = (s) => s.replace(/<\/style/gi, '<\\/style');

let html = R('index.html');

/* 1. 去掉离线版用不上的外链（file:// 打开会 404），favicon 换成内联 SVG */
html = html.replace(/[ \t]*<link rel="manifest"[^>]*>\r?\n?/, '');
html = html.replace(/[ \t]*<link rel="apple-touch-icon"[^>]*>\r?\n?/, '');

const svg = R('icons/icon.svg').replace(/\s+/g, ' ').trim();
const iconUri = 'data:image/svg+xml,' + encodeURIComponent(svg)
  .replace(/'/g, '%27').replace(/"/g, '%22');
html = html.replace(/[ \t]*<link rel="icon"[^>]*>/, () => `  <link rel="icon" href="${iconUri}">`);

/* 2. 标题加个标记，方便一眼看出拿的是哪份 */
html = html.replace(/<title>([^<]*)<\/title>/, (m, t) => '<title>' + t + ' · 单文件版</title>');

/* 3. CSS 内联 */
const css = R('css/style.css');
const cssTag = '<link rel="stylesheet" href="css/style.css">';
if (!html.includes(cssTag)) throw new Error('找不到 CSS 外链，index.html 结构变了？');
html = html.replace(cssTag, () => `<style>\n${inStyle(css)}\n</style>`);

/* 4. 词库内联（必须在 app.js 之前，ensureBook / ensureDict 才能短路）
 *    dict.js 是 8MB 的通用字典（9.8 万词），内联后单文件会到 12MB 左右 ——
 *    这是「拷走就能查任何词」的代价。它只影响文件体积，不影响启动：
 *    对象字面量解析在现代浏览器是百毫秒级，真正慢的是首次下载。 */
/* exam.js 是考试标签词的短语/例句/近义词（约 3.7MB），和字典一起内联：
 * 缺了它单文件版查词就没有例句，但「零外链」自检不会报错（它是可选文件），所以必须在这手动加上。 */
const data = ['data/cet6.js', 'data/kaoyan.js', 'data/dict.js', 'data/exam.js', 'data/paper.js'].map(R).join('\n');

/* 词根词缀表（12KB）+ 词干表（344KB）也内联，保证离线拆分照常工作。
 * 这两份在 index.html 里是两个相邻的 <script src>，这里合成一块内联 ——
 * 只内联 roots 而漏掉 stems 的话，末尾「零外链」自检会直接报错（别只改一半）。 */
const stemsTag = '<script src="data/stems.js"></script>';
const rootsTag = '<script src="data/roots.js"></script>';
if (!html.includes(stemsTag) || !html.includes(rootsTag)) {
  throw new Error('找不到 stems.js / roots.js 外链，index.html 结构变了？');
}
html = html.replace(stemsTag, () =>
  '<!-- 词干表 + 词根词缀表（内联）-->\n<script>\n' +
  inScript(R('data/stems.js')) + '\n' + inScript(R('data/roots.js')) + '\n</script>');
html = html.replace(rootsTag, '');

/* 5. 脚本内联 */
const fsrsTag = '<script src="js/vendor/fsrs.global.js"></script>';
const appTag = '<script src="js/app.js"></script>';
if (!html.includes(fsrsTag) || !html.includes(appTag)) throw new Error('找不到脚本外链，index.html 结构变了？');

const fsrs = R('js/vendor/fsrs.global.js');
const app = R('js/app.js');
const ver = (app.match(/const APP_VER = '([^']+)'/) || [])[1] || '?';

html = html.replace(fsrsTag, () =>
  '<script>window.VD_STANDALONE=1;</script>\n' +
  `<!-- 词库（两本，内联）-->\n<script>\n${inScript(data)}\n</script>\n` +
  `<!-- FSRS -->\n<script>\n${inScript(fsrs)}\n</script>`);
html = html.replace(appTag, () => `<script>\n${inScript(app)}\n</script>`);

/* 6. 顶部留个生成说明，方便日后确认是不是最新一份 */
html = html.replace('<!DOCTYPE html>', () =>
  '<!DOCTYPE html>\n<!-- 唯单词 v' + ver + ' · 单文件版（由 tools/build_standalone.mjs 生成，勿手改）\n' +
  '     所有 CSS / JS / 词库已内联，双击即可用，不依赖同目录任何文件。 -->');

/* 7. 写盘 */
writeFileSync(OUT, html, 'utf8');

/* 8. 顺带写一份纯 ASCII 文件名的孪生本。
 * 中文名在某些环境里会出事：微信/QQ 内置浏览器不认、部分安卓文件管理器按 GBK 存盘后
 * 文件名变乱码、老 iOS「文件」App 打开中文名的本地 html 会白屏。多一个 vocab-drill.html，
 * 对方打不开时换个文件试就行，不需要技术解释。 */
const twin = path.join(path.dirname(OUT), 'vocab-drill.html');
if (path.basename(OUT) !== 'vocab-drill.html') {
  try { copyFileSync(OUT, twin); } catch (e) { console.warn('孪生本写入失败：' + e.message); }
}

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
console.log('生成：' + OUT);
console.log('版本：v' + ver);
console.log('体积：' + mb(statSync(OUT).size));
console.log('  其中 CSS ' + kb(css.length) + ' · app.js ' + kb(app.length) +
  ' · FSRS ' + kb(fsrs.length) + ' · 词库 ' + mb(data.length));
if (path.basename(OUT) !== 'vocab-drill.html') console.log('孪生本（纯 ASCII 名）：' + twin);

/* 最后一遍自检：单文件不该再有任何外链，脚本标签要成对 */
const ext = html.match(/<script[^>]*\ssrc=/gi) || [];
const open = (html.match(/<script\b/gi) || []).length;
const close = (html.match(/<\/script>/gi) || []).length;
if (ext.length) throw new Error('还有外链脚本：' + ext.join(' , '));
if (open !== close) throw new Error('script 标签不成对：' + open + ' 开 / ' + close + ' 闭');
console.log('自检：零外链 · script ' + open + ' 对 · 通过');
