# -*- coding: utf-8 -*-
"""例句择优的效果自检：覆盖率 + 抽样人工可读的样本。"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from sent_pick import Ranker, pick_sentences, POS_PREFIX_RE  # noqa

FILES = ["sent_cet4", "sent_cet6", "sent_kaoyan"]


def load():
    rows = {}
    for n in FILES:
        with open(os.path.join(ROOT, "data_raw", n + ".jsonl"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                o = json.loads(line)
                w = (o.get("word") or "").strip()
                if not w:
                    continue
                rows.setdefault(w.lower(), o)
    return rows


rows = load()
texts = []
for o in rows.values():
    for s in (o.get("sentences") or []):
        if (s.get("sentence") or "").strip():
            texts.append(s["sentence"])
rk = Ranker(texts)

tot = defs_tot = defs_cov = multi = multi_full = 0
grade_hist = {1: 0, 2: 0}
no_sent = []
samples = []
for k, o in sorted(rows.items()):
    defs = []
    for t in (o.get("translations") or []):
        tr = (t.get("translation") or "").strip()
        if tr:
            tp = (t.get("type") or "").strip()
            defs.append((tp + ". " if tp else "") + tr)
    if not defs:
        continue
    raw = []
    for s in (o.get("sentences") or []):
        en = (s.get("sentence") or "").strip()
        cn = (s.get("translation") or "").strip()
        if en and cn:
            raw.append((en, cn))
    picked = pick_sentences(o.get("word") or k, defs, raw, rk)
    tot += 1
    defs_tot += len(defs)
    got = sum(1 for x in picked if x)
    defs_cov += got
    if got == 0:
        no_sent.append((o.get("word"), [r[0] for r in raw][:2]))
    if len(defs) > 1:
        multi += 1
        if got == len(defs):
            multi_full += 1
    for x in picked:
        if x:
            g, _ = __import__("sent_pick").grade(x[0], x[1], o.get("word") or k, rk)
            grade_hist[g] = grade_hist.get(g, 0) + 1
    if len(samples) < 28 and len(defs) >= 2:
        samples.append((o.get("word"), defs, picked))

print("词数 %d，释义 %d，已配例句 %d（%.1f%%）" % (tot, defs_tot, defs_cov, defs_cov * 100.0 / defs_tot))
print("无任何可用例句的词：%d" % len(no_sent))
print("多义词 %d，每个释义都配到的 %d（%.1f%%）" % (multi, multi_full, multi_full * 100.0 / max(1, multi)))
print("例句等级分布 A(完整句)/B(兜底)：", grade_hist)
print()
for w, defs, picked in samples:
    print("###", w)
    for d, s in zip(defs, picked):
        print("   -", d, "=>", (s[0] + " | " + s[1]) if s else "（无例句）")
print()
print("无例句样例：")
for w, ss in no_sent[:12]:
    print("  ", w, "|", ss)
