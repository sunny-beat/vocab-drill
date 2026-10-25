# 从 data_raw/ 生成 data/*.js。
# 数据源：
#   sent_*.jsonl  —— 释义 + 短语 + 美音/英音音标 + 带中文翻译的例句（学习主数据）
#   full_*.jsonl  —— 同义词（syno.synos，按词性分组）+ 官方 wordRank 词频排名
# v5 变更：
#   - 新增同义词（单一词形，每词最多 6 个，跨词书合并去重）
#   - 高频改用真实词频：min(wordRank) <= 1200 或跨 >=2 份大纲，两者取并集
#   - 词书仍按字母排序；只输出六级（含四级）与考研（含四六级）
import json
import os
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_learn(name):
    """学习主数据：word -> [w, defs, phs, us, uk, sents]"""
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
                if en and cn and 15 <= len(en) <= 130:
                    sents.append([en[:130], cn[:60]])
                if len(sents) >= 2:
                    break
            sents.sort(key=lambda x: len(x[0]))
            out[k] = [w, defs, phs, (o.get("us") or "").strip()[:40],
                      (o.get("uk") or "").strip()[:40], sents]
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

cnt = Counter()
for s in (cet4, cet6x, kaoyanx):
    cnt.update(s.keys())


def finalize(entries):
    words = []
    for k, e in entries.items():
        # 同义词与词频跨词书合并：syns 取并集，rank 取最小值
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
        words.append([e[0], e[1], e[2], freq, e[3], e[4], e[5], syns, rank or 0])
    words.sort(key=lambda x: x[0].lower())
    return words


books = [
    ("cet6", "CET-6（含四级）", {**cet4, **cet6x}),
    ("kaoyan", "考研（含四六级）", {**cet4, **cet6x, **kaoyanx}),
]

os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
for bid, name, entries in books:
    words = finalize(entries)
    freq_n = sum(w[3] for w in words)
    syn_n = sum(1 for w in words if w[7])
    payload = json.dumps(words, ensure_ascii=False, separators=(",", ":"))
    js = 'window.VD_DATA=window.VD_DATA||{};VD_DATA.%s={id:"%s",name:"%s",words:%s};' % (
        bid, bid, name, payload)
    path = os.path.join(ROOT, "data", bid + ".js")
    with open(path, "w", encoding="utf-8") as f:
        f.write(js)
    print("%s: %d words (%d 高频, %d 带同义词), %.0f KB" % (
        bid, len(words), freq_n, syn_n, len(js.encode("utf-8")) / 1024))
