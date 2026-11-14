# -*- coding: utf-8 -*-
"""生成唯单词的应用图标（v6.11.2）

设计：深绿渐变底 + 一本摊开的书 + 书页上浮起的英文单词（vocab / learn / focus）
  - icons/icon.svg             圆角版（PWA any、favicon、单文件版内联）
  - icons/icon-square.svg      满幅方版（apple-touch / maskable / APK / exe 用，内容缩到 80%）
  - icons/*.png                由 Edge headless 按尺寸截图，透明底靠 --default-background-color
  - 可选 --packages <dir>      顺手生成安卓 mipmap 五档 + Windows icon.ico

用法：
  python tools/make_icons.py
  python tools/make_icons.py --packages "E:/workbuddy工作空间/vocab-drill-packages"
"""
import argparse
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / 'icons'
EDGE = pathlib.Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
if not EDGE.exists():
    EDGE = pathlib.Path(r'C:\Program Files\Microsoft\Edge\Application\msedge.exe')

# ---------- 图形 ----------
# 所有坐标基于 512×512。ART 是书 + 浮字，画在满幅坐标里。

ART = '''
  <g>
    <!-- 书脊底部的厚度（先画，压在页下面） -->
    <path d="M256 336 C 210 310 152 300 92 304 L92 410 C 152 406 210 416 256 438 Z" fill="#c9b998"/>
    <path d="M256 336 C 302 310 360 300 420 304 L420 410 C 360 406 302 416 256 438 Z" fill="#d8c9a9"/>

    <!-- 左右页 -->
    <path d="M256 318 C 210 292 152 282 92 286 L92 392 C 152 388 210 398 256 420 Z"
          fill="#fdf8ec"/>
    <path d="M256 318 C 302 292 360 282 420 286 L420 392 C 360 388 302 398 256 420 Z"
          fill="#fffdf7"/>

    <!-- 页面上淡淡的横线 -->
    <g stroke="#ddd0b4" stroke-width="4" stroke-linecap="round" fill="none" opacity=".85">
      <path d="M118 320 C 160 317 200 324 234 338"/>
      <path d="M118 348 C 160 345 200 352 234 366"/>
      <path d="M118 376 C 160 373 200 380 234 394"/>
      <path d="M278 338 C 312 324 352 317 394 320"/>
      <path d="M278 366 C 312 352 352 345 394 348"/>
      <path d="M278 394 C 312 380 352 373 394 376"/>
    </g>

    <!-- 书脊 -->
    <path d="M256 318 L256 420" stroke="#cbbda1" stroke-width="9" stroke-linecap="round"/>
    <path d="M256 322 L256 416" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" opacity=".55"/>

    <!-- 薄荷色书签带 -->
    <path d="M318 292 L318 372 L333 356 L348 372 L348 292 Z" fill="#43c08a"/>
    <path d="M318 292 L318 372 L333 356 L333 292 Z" fill="#31a874" opacity=".55"/>
  </g>

  <!-- 书页上浮起的单词 -->
  <g font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="700">
    <text x="112" y="252" font-size="46" fill="#f2fff9" opacity=".97"
          transform="rotate(-7 112 252)" letter-spacing="-1">vocab</text>
    <text x="300" y="196" font-size="31" fill="#a8f2cd" opacity=".95"
          transform="rotate(8 300 196)" letter-spacing="-.5">learn</text>
    <text x="214" y="146" font-size="24" fill="#7fe3b4" opacity=".88"
          transform="rotate(-4 214 146)" letter-spacing="1">focus</text>
  </g>

  <!-- 浮起来的小光点，暗示"飘" -->
  <g fill="#8dffcb">
    <circle cx="268" cy="112" r="5.5" opacity=".85"/>
    <circle cx="352" cy="142" r="4" opacity=".7"/>
    <circle cx="96"  cy="214" r="4.5" opacity=".6"/>
    <circle cx="408" cy="238" r="5" opacity=".55"/>
    <circle cx="176" cy="176" r="3.5" opacity=".5"/>
    <circle cx="440" cy="176" r="3" opacity=".4"/>
  </g>
'''

BG = '''  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a6d4f"/>
      <stop offset=".55" stop-color="#14543d"/>
      <stop offset="1" stop-color="#0d3a2a"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".12"/>
      <stop offset=".45" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="{rx}" fill="url(#bg)"/>
  <rect width="512" height="512" rx="{rx}" fill="url(#glow)"/>
'''


def svg(rounded):
    rx = 116 if rounded else 0
    art = ART
    if not rounded:
        # 满幅版把内容缩到 80%，留给桌面启动器的圆形/超椭圆裁切
        art = ('  <g transform="translate(256 256) scale(0.8) translate(-256 -256)">\n'
               + ART + '  </g>\n')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n'
            + BG.format(rx=rx) + art + '</svg>\n')


def render(svg_path, out_png, size, alpha=True):
    """用 Edge headless 把 SVG 渲染成精确 size×size 的 PNG"""
    html = pathlib.Path(tempfile.mkdtemp(prefix='vd-ico-'))
    try:
        page = html / 'i.html'
        page.write_text(
            '<!doctype html><meta charset="utf-8">'
            '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}'
            'svg{display:block;width:%dpx;height:%dpx}</style>' % (size, size)
            + svg_path.read_text(encoding='utf-8'),
            encoding='utf-8')
        profile = html / 'prof'
        cmd = [str(EDGE), '--headless=new', '--disable-gpu', '--hide-scrollbars',
               '--no-first-run', '--no-default-browser-check',
               '--force-device-scale-factor=1',
               '--window-size=%d,%d' % (size, size),
               '--user-data-dir=' + str(profile),
               '--virtual-time-budget=1200',
               '--screenshot=' + str(out_png)]
        if alpha:
            cmd.insert(1, '--default-background-color=00000000')
        cmd.append(page.as_uri())
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=90)
        if not pathlib.Path(out_png).exists():
            raise RuntimeError('渲染失败 %s\n%s' % (out_png, (r.stderr or '')[-600:]))
    finally:
        shutil.rmtree(html, ignore_errors=True)


def patch_brand_css():
    """把顶栏左上角 .brand-mark 的背景同步成新图标（base64 内联，单文件版仍零外链）。

    以前这里是「浅绿渐变 + 17px 简笔白书」，改桌面图标时漏掉过一次，
    所以做成生成脚本的一部分，改图不会再漏。
    """
    import base64
    import re
    css = ROOT / 'css' / 'style.css'
    txt = css.read_text(encoding='utf-8')
    # 顶栏只有 24px，用「内容满幅」的圆角版（不是给启动器留安全区的 0.8 缩版），
    # 否则书和浮动词缩到十来个像素，看着像个小色块。
    art = svg(True).replace('\n', ' ').strip()
    uri = 'data:image/svg+xml;base64,' + base64.b64encode(art.encode('utf-8')).decode('ascii')
    new, n = re.subn(r'(\.brand-mark \{[^}]*?background: )[^;]+;',
                     lambda m: m.group(1) + 'url("' + uri + '") center/cover no-repeat;',
                     txt, count=1, flags=re.S)
    if n != 1:
        sys.exit('没找到 .brand-mark 的 background 规则，停止写入 CSS')
    css.write_text(new, encoding='utf-8')
    print('同步 css/style.css 的 .brand-mark（内联 %d B）' % len(uri))


def ico(png256, out_ico):
    from PIL import Image
    im = Image.open(png256).convert('RGBA')
    im.save(out_ico, format='ICO',
            sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--packages', default='', help='同时生成安卓 mipmap 与 Windows ico')
    a = ap.parse_args()

    if not EDGE.exists():
        sys.exit('找不到 Edge')

    round_svg, square_svg = ICONS / 'icon.svg', ICONS / 'icon-square.svg'
    round_svg.write_text(svg(True), encoding='utf-8')
    square_svg.write_text(svg(False), encoding='utf-8')
    patch_brand_css()
    print('写入', round_svg.name, '/', square_svg.name)

    tmp = ICONS / '_tmp_png'
    tmp.mkdir(exist_ok=True)
    jobs = [
        (round_svg, ICONS / 'icon-192.png', 192, True),
        (round_svg, ICONS / 'icon-512.png', 512, True),
        (square_svg, ICONS / 'apple-touch-180.png', 180, False),
        (square_svg, ICONS / 'icon-maskable-512.png', 512, False),
    ]
    for s, o, n, al in jobs:
        render(s, o, n, al)
        print('  %-26s %dpx  %d B' % (o.name, n, o.stat().st_size))

    if a.packages:
        pkg = pathlib.Path(a.packages)
        # 安卓启动器图标
        for d, n in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
            out = pkg / 'android' / 'res' / ('mipmap-' + d) / 'ic_launcher.png'
            if out.parent.exists():
                render(square_svg, out, n, True)
                print('  mipmap-%-8s %dpx' % (d, n))
        # Windows ico
        big = tmp / 'ico-256.png'
        render(square_svg, big, 256, True)
        out_ico = pkg / 'electron' / 'build' / 'icon.ico'
        if out_ico.parent.exists():
            ico(big, out_ico)
            print('  icon.ico %d B' % out_ico.stat().st_size)
        shutil.copy2(square_svg, pkg / 'electron' / 'build' / 'icon.svg') \
            if (pkg / 'electron' / 'build').exists() else None

    shutil.rmtree(tmp, ignore_errors=True)
    print('done')


if __name__ == '__main__':
    main()
