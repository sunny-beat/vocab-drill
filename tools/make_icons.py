#!/usr/bin/env python3
"""把 icons/icon.svg 渲染成 PWA 需要的 PNG 尺寸（无第三方依赖）。

原理：用系统已装的 Edge/Chrome 无头模式截图（--screenshot + --window-size），
避免为了生成两张图标去装 Pillow。

用法：python tools/make_icons.py
输出：icons/icon-192.png、icons/icon-512.png、icons/apple-touch-180.png
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SVG = ROOT / "icons" / "icon.svg"
OUT = ROOT / "icons"
SIZES = [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-180.png")]

CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]


def find_browser():
    env = os.environ.get("BROWSER_BIN")
    if env and pathlib.Path(env).exists():
        return env
    for p in CANDIDATES:
        if pathlib.Path(p).exists():
            return p
    return shutil.which("chrome") or shutil.which("chromium") or shutil.which("msedge")


def main():
    browser = find_browser()
    if not browser:
        sys.exit("找不到 Edge/Chrome，可用 BROWSER_BIN 环境变量指定")

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="vicon_"))
    try:
        for size, name in SIZES:
            html = tmp / ("p%d.html" % size)
            html.write_text(
                "<!doctype html><meta charset='utf-8'>"
                "<style>html,body{margin:0;padding:0;background:transparent}"
                "img{display:block;width:%dpx;height:%dpx}</style>"
                "<img src='%s'>" % (size, size, SVG.as_uri()),
                encoding="utf-8",
            )
            out = OUT / name
            subprocess.run(
                [
                    browser,
                    "--headless=new",
                    "--disable-gpu",
                    "--hide-scrollbars",
                    "--no-first-run",
                    "--default-background-color=00000000",
                    "--user-data-dir=" + str(tmp / ("prof%d" % size)),
                    "--window-size=%d,%d" % (size, size),
                    "--screenshot=" + str(out),
                    html.as_uri(),
                ],
                capture_output=True,
                timeout=90,
            )
            if not out.exists():
                sys.exit("截图失败：" + name)
            print("written %s (%d bytes)" % (name, out.stat().st_size))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
