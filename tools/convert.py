# -*- coding: utf-8 -*-
"""从 data_raw/ 生成 data/*.js。

数据源：
  sent_*.jsonl  —— 释义 + 短语 + 美音/英音音标 + 带中文翻译的例句（学习主数据）
  full_*.jsonl  —— 同义词（syno.synos，按词性分组）+ 官方 wordRank 词频排名

v6 变更（例句库重做）：
  - 例句改为「一义一例」：sentences 数组与 defs 一一对齐，缺例句处为 null
    （由 tools/sent_pick.py 做质量分层 + 词性判别 + 语义匹配）
  - 同一词在四/六/考研三份数据里的例句会合并成池子，覆盖率更高
  - 丢掉词典碎片里的括注（"(= lifted the anchor)"），句子读得通才留下
  - 单义词只留 1 条最好的例句，数据体积基本持平
"""
import json
import os
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from sent_pick import Ranker, pick_sentences  # noqa: E402


def load_learn(name):
    """学习主数据：word -> {w, defs, phs, us, uk, sents}"""
    out = {}
    with open(os.path.join(ROOT, "data_raw", name + ".jsonl"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            w = (o.get("word") or "").strip()
            if not w:
                continue
            k = w.lower()
            if k in out:
                continue
            defs = []
            for t in o.get("translations", []):
                tr = (t.get("translation") or "").strip()
                if not tr:
                    continue
                tp = (t.get("type") or "").strip()
                defs.append((tp + ". " if tp else "") + tr)
            if not defs:
                continue
            phs = []
            for ph in (o.get("phrases") or [])[:3]:
                p = (ph.get("phrase") or "").strip()
                t = (ph.get("translation") or "").strip()
                if p and t:
                    phs.append([p[:60], t[:40]])
            sents = []
            for s in (o.get("sentences") or []):
                en = (s.get("sentence") or "").strip()
                cn = (s.get("translation") or "").strip()
                if en and cn:
                    sents.append((en[:150], cn[:60]))
            out[k] = {
                "w": w, "defs": defs, "phs": phs,
                "us": (o.get("us") or "").strip()[:40],
                "uk": (o.get("uk") or "").strip()[:40],
                "sents": sents,
            }
    return out


def load_extra(name):
    """同义词与词频：word -> (syns, rank)"""
    out = {}
    with open(os.path.join(ROOT, "data_raw", name + ".jsonl"), encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            w = (o.get("headWord") or "").strip()
            if not w:
                continue
            k = w.lower()
            c = o.get("content", {}).get("word", {}).get("content", {}) if isinstance(o.get("content"), dict) else {}
            syns = []
            for g in (c.get("syno", {}).get("synos") or []):
                for h in (g.get("hwds") or []):
                    hw = (h.get("w") or "").strip()
                    if hw and " " not in hw and len(hw) <= 18 and hw.lower() != k:
                        syns.append(hw)
            syns = list(dict.fromkeys(syns))[:6]
            rank = o.get("wordRank")
            out[k] = (syns, rank if isinstance(rank, int) else None)
    return out


cet4 = load_learn("sent_cet4")
cet6x = load_learn("sent_cet6")
kaoyanx = load_learn("sent_kaoyan")

e4 = load_extra("full_cet4")
e6 = load_extra("full_cet6")
eky = load_extra("full_kaoyan")

# 三份大纲合并成一个词池：释义取先出现的（四级→六级→考研），例句取并集
POOL = {}
for part in (cet4, cet6x, kaoyanx):
    for k, rec in part.items():
        cur = POOL.get(k)
        if cur is None:
            POOL[k] = {"w": rec["w"], "defs": rec["defs"], "phs": rec["phs"],
                       "us": rec["us"], "uk": rec["uk"], "sents": list(rec["sents"])}
            continue
        seen = set(s[0] for s in cur["sents"])
        for s in rec["sents"]:
            if s[0] not in seen:
                cur["sents"].append(s)
                seen.add(s[0])
        cur["phs"] = cur["phs"] or rec["phs"]
        cur["us"] = cur["us"] or rec["us"]
        cur["uk"] = cur["uk"] or rec["uk"]

# 语料词频只用于判断例句难易，不参与输出
RK = Ranker([s[0] for rec in POOL.values() for s in rec["sents"]])


def finalize(keys):
    words = []
    for k in keys:
        rec = POOL[k]
        syns, rank = [], None
        for extra in (e4, e6, eky):
            if k in extra:
                s, r = extra[k]
                for x in s:
                    if x.lower() != k and x not in syns:
                        syns.append(x)
                syns = syns[:6]
                if r is not None and (rank is None or r < rank):
                    rank = r
        freq = 1 if (rank is not None and rank <= 500) else 0   # 词频前 500 ≈ 前 30%
        # 一义一例；没有合适例句的释义留 null
        picked = pick_sentences(rec["w"], rec["defs"], rec["sents"], RK)
        sens = [s if s else None for s in picked]
        words.append([rec["w"], rec["defs"], rec["phs"], freq,
                      rec["us"], rec["uk"], sens, syns, rank or 0])
    words.sort(key=lambda x: x[0].lower())
    return words


books = [
    ("cet6", "CET-6（含四级）", sorted(set(cet4) | set(cet6x))),
    ("kaoyan", "考研（含四六级）", sorted(POOL.keys())),
]

os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
for bid, name, keys in books:
    words = finalize(keys)
    freq_n = sum(w[3] for w in words)
    syn_n = sum(1 for w in words if w[7])
    defs_n = sum(len(w[1]) for w in words)
    sent_n = sum(1 for w in words for s in w[6] if s)
    payload = json.dumps(words, ensure_ascii=False, separators=(",", ":"))
    js = 'window.VD_DATA=window.VD_DATA||{};VD_DATA.%s={id:"%s",name:"%s",words:%s};' % (
        bid, bid, name, payload)
    path = os.path.join(ROOT, "data", bid + ".js")
    with open(path, "w", encoding="utf-8") as f:
        f.write(js)
    print("%s: %d words (%d 高频, %d 带同义词), 释义 %d 条 / 例句 %d 条 (%.1f%%), %.0f KB" % (
        bid, len(words), freq_n, syn_n, defs_n, sent_n,
        sent_n * 100.0 / max(1, defs_n), len(js.encode("utf-8")) / 1024))
