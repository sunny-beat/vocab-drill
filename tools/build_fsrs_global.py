#!/usr/bin/env python3
"""把 ts-fsrs 的 ESM bundle 转成经典脚本（挂到 window.FSRS）。

为什么需要：
    file:// 协议下浏览器禁止加载 ES module（CORS），`<script type="module">` 与
    动态 import() 都会失败。用户的主要使用方式是双击 index.html，因此 FSRS 必须
    以经典脚本形式提供。

用法：
    python tools/build_fsrs_global.py        # 生成 js/vendor/fsrs.global.js

输入：js/vendor/fsrs.esm.js  （jsDelivr 的 ts-fsrs@5/+esm 原文件，勿改）
输出：js/vendor/fsrs.global.js（自动生成，勿手改）

升级 ts-fsrs 时：先替换 fsrs.esm.js，再跑本脚本。
"""
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "js" / "vendor" / "fsrs.esm.js"
DST = ROOT / "js" / "vendor" / "fsrs.global.js"

HEADER = """/* 自动生成，勿手改 —— 由 tools/build_fsrs_global.py 从 fsrs.esm.js 转换
 * ts-fsrs 5.4.2（jsDelivr +esm bundle）= FSRS-6 算法
 * 以经典脚本暴露 window.FSRS，使 file:// 双击打开时也能用（ESM 在 file:// 被 CORS 拦）
 */
"""


def main():
    code = SRC.read_text(encoding="utf-8")
    m = None
    for m in re.finditer(r"export\{([^}]*)\};?", code):
        pass
    if not m:
        raise SystemExit("未找到 export{...} 语句，源文件格式可能已变")
    body = code[: m.start()]
    mapping = []
    for part in m.group(1).split(","):
        part = part.strip()
        if not part:
            continue
        if " as " in part:
            local, exported = [s.strip() for s in part.split(" as ")]
        else:
            local = exported = part
        mapping.append("%s:%s" % (exported, local))

    out = (
        HEADER
        + "(function(){\n'use strict';\n"
        + body
        + "\nwindow.FSRS = {" + ",".join(mapping) + "};\n"
        + "})();\n"
    )
    DST.write_text(out, encoding="utf-8")
    print("written %s (%d bytes, %d exports)" % (DST.name, len(out.encode()), len(mapping)))


if __name__ == "__main__":
    main()
