# -*- coding: utf-8 -*-
"""例句择优：给「每一个释义」配一条好懂的英文例句。

上游数据（data_raw/sent_*.jsonl）的例句有三个问题：
  1. 多数词只有 1 条，多义词的释义没有一一对应的例句；
  2. 相当一部分是词典碎片（"a parachute jump"）或长难句，读起来晦涩；
  3. 同一词的 n./v. 两条释义会被随机分配，出现「名词释义配动词例句」。

本模块的应对：
  * 质量分层：A 级＝完整句（大写开头 + 句末标点 + 5~26 词 + 生僻词占比低）；
              B 级＝可用但不完整（碎片、长句），只在没有 A 级时兜底；
  * 词性判别：看目标词在句中实际形态（-ed/-ing → 动词、前面是 a/the → 名词、
              前面是 to → 动词、前面是 very/so → 形容词）来判断它在句中是哪种词性；
  * 释义对齐：用释义中文与例句中译的「汉字二元组重合度」+ 词性一致性做贪心匹配，
              让「跳伞」优先拿到 "… parachute jump / 跳伞"，避免被「降落伞」抢走。
"""
import re
from collections import Counter

WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")
HAN_RE = re.compile(r"[\u4e00-\u9fff]")
POS_PREFIX_RE = re.compile(r"^([a-z]{1,4})\.\s*", re.I)

# 极常见词：即便语料频次不够，这些词也不该算「生僻」
_STOP = set("""a an the of to in on at for with and or but if so as by from into
about after before over under than then this that these those there here it its
is are was were be been being am do does did have has had will would can could
may might must shall should not no nor too very just only also more most much
many some any each every all both few other another such what which who whom
whose when where why how i you he she we they me him her us them my your his
our their one two three first new good great little long own same old right big
high small large next early young important public bad able get got go went
like make made take took come came see saw know knew think thought want said say
up out down off back again still even well here where why yes way thing time
people man woman day year life world hand part place work little house""".split())

_DET = set("a an the my your his her its our their this that these those some any "
           "no every each another".split())
_BE = set("is are was were be been being am".split())
_DEG = set("very so too quite rather extremely more most less pretty really "
           "highly totally completely absolutely".split())
_PREP = set("of for with in on at by from about into over under between among "
            "through during against without within".split())
_TO = set(["to"])

# 词性前缀归一
_POS_MAP = {
    "n": "n", "adj": "adj", "a": "adj", "v": "v", "vt": "v", "vi": "v",
    "adv": "adv", "ad": "adv", "prep": "prep", "pron": "pron", "conj": "conj",
    "num": "num", "art": "art", "det": "det", "int": "int", "abbr": "abbr",
}


def head_stem(word):
    """保留字母顺序的前缀词干，用于「词形变化」匹配（consistent → consis）"""
    w = word.lower()
    if len(w) <= 4:
        return w
    return w[:max(4, min(len(w) - 1, 6))]


def def_pos(d):
    """从 'adj. 一致的' 取出 'adj'；没有词性前缀返回 None"""
    m = POS_PREFIX_RE.match((d or "").strip())
    if not m:
        return None
    return _POS_MAP.get(m.group(1).lower())


def strip_pos(d):
    return POS_PREFIX_RE.sub("", (d or "").strip())


def match_token(en, word):
    """在句中找目标词（含常见词形变化），返回 (实际词形, 前一词, 后一词)"""
    stem = head_stem(word)
    base = word.lower()
    toks = WORD_RE.findall(en)
    lows = [t.lower() for t in toks]
    for i, t in enumerate(lows):
        flat = t.replace("-", "")          # co-ordinate → coordinate
        ok = flat.startswith(stem)
        if not ok and base.endswith("y") and flat.startswith(base[:-1] + "i"):
            ok = True                       # bury → buried
        if not ok:
            continue
        if len(flat) - len(base) > 4:       # 排除 consistency 之于 consist 这类派生词
            continue
        prev = lows[i - 1] if i > 0 else ""
        nxt = lows[i + 1] if i + 1 < len(lows) else ""
        return flat, prev, nxt
    return None


def guess_pos(en, word):
    """猜测目标词在该句中的词性；不确定返回 None"""
    hit = match_token(en, word)
    if not hit:
        return None
    form, prev, nxt = hit
    base = word.lower()
    if form != base:
        # 带词形变化的形态证据最强：-ing/-ed 一定是动词，-ly 是副词，-s/-es 多半是复数名词
        if form.endswith("ing") or form.endswith("ed"):
            return "v"
        if form.endswith("ly"):
            return "adv"
        if form.endswith("s"):
            return "n"
    if prev in _TO:
        return "v"
    if prev in _DEG:
        return "adj"
    if prev in _DET:
        # "an adult lion" 这类定语形容词会被误判成名词，但名词释义本来也更该拿它
        return "n"
    if nxt == "of":
        return "n"
    if prev in _PREP:
        return "n"
    if prev in _BE:
        return "adj"
    return None


def cap_ok(en):
    s = en.strip()
    if not s:
        return False
    if s[0] in "\"'“‘(":
        s = s[1:].strip()
    return bool(s) and s[0].isupper()


def term_ok(en):
    return en.strip()[-1:] in ".!?"


def bigrams(cn):
    """释义/中译的汉字二元组集合，用来做语义粗匹配"""
    han = "".join(HAN_RE.findall(cn or ""))
    if len(han) < 2:
        return set([han]) if han else set()
    return set(han[i:i + 2] for i in range(len(han) - 1))


def overlap(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / float(len(a))


class Ranker(object):
    """基于语料词频估计一句英文的阅读难度"""

    def __init__(self, texts):
        cnt = Counter()
        for t in texts:
            for w in WORD_RE.findall(t.lower()):
                cnt[w] += 1
        self.rank = {w: i for i, (w, _) in enumerate(cnt.most_common())}
        self.common = set(list(self.rank)[:2600])

    def hard_ratio(self, en, skip_stem=None):
        ws = WORD_RE.findall(en)
        if not ws:
            return 1.0
        hard = 0
        n = 0
        for w in ws:
            lw = w.lower()
            # 目标词本身当然「生僻」，不该算进难度
            if skip_stem and lw.startswith(skip_stem):
                continue
            n += 1
            if lw in _STOP or lw in self.common:
                continue
            if len(lw) >= 12 or self.rank.get(lw, 99999) > 5000:
                hard += 1
        return hard / float(n) if n else 0.0


# 词典释义括注："weighed anchor (= lifted the anchor)" / "acceptance (= a letter ...)"
GLOSS_RE = re.compile(r"\s*\(\s*=[^)]*\)\s*")


def clean_en(en):
    """去掉词典括注与省略号残留，还原成一句能读的话"""
    s = GLOSS_RE.sub(" ", en or "")
    s = s.replace("“", "\"").replace("”", "\"").replace("‘", "'").replace("’", "'")
    s = re.sub(r"^[\s.…]+", "", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s


def clean_cn(cn):
    """中文译文里多余的空格（词典排版残留）清掉，但保留夹在英文词之间的空格"""
    s = (cn or "").replace("\u3000", " ").strip()
    s = re.sub(r"(?<=[\u4e00-\u9fff，。；：、！？（）“”])\s+", "", s)
    s = re.sub(r"\s+(?=[\u4e00-\u9fff，。；：、！？（）“”])", "", s)
    return s


def grade(en, cn, word, ranker):
    """返回 (等级, 分数)。等级 0 表示不可用；A=2 完整句，B=1 兜底。"""
    s = clean_en(en)
    if not s or not cn:
        return 0, 0
    if not match_token(s, word):
        return 0, 0
    if not HAN_RE.search(cn):
        return 0, 0
    if len(cn) > 60 or len(s) > 150:
        return 0, 0
    n = len(WORD_RE.findall(s))
    hr = ranker.hard_ratio(s, head_stem(word))
    score = 0.0
    if 6 <= n <= 20:
        score += 2.0
    elif 5 <= n <= 24:
        score += 1.0
    if 8 <= len(cn) <= 34:
        score += 1.0
    score += (0.35 - hr) * 6
    if ";" in s:
        score -= 0.8
    if re.search(r"—|--", s):
        score -= 0.5
    if s.count(",") >= 4:
        score -= 0.8
    if score <= -1.6:
        return 0, score
    if cap_ok(s) and term_ok(s) and 5 <= n <= 26 and hr <= 0.30:
        return 2, score + 1.2
    if 2 <= n <= 30 and hr <= 0.65:
        return 1, score - 0.6
    return 0, score


def pick_sentences(word, def_texts, raw_sents, ranker):
    """为每个释义挑一条例句；返回与 def_texts 等长的列表，缺例句处为 None。"""
    if not raw_sents:
        return [None] * len(def_texts)

    scored = []
    for en, cn in raw_sents:
        g, sc = grade(en, cn, word, ranker)
        if not g:
            continue
        ce = clean_en(en)
        scored.append({
            "en": ce, "cn": clean_cn(cn), "g": g, "score": sc,
            "bg": bigrams(cn), "pos": guess_pos(ce, word)
        })
    if not scored:
        return [None] * len(def_texts)

    if len(def_texts) == 1:
        best = max(scored, key=lambda x: (x["g"], x["score"]))
        return [[best["en"], best["cn"]]]

    pairs = []
    for di, d in enumerate(def_texts):
        dg = bigrams(strip_pos(d))
        dp = def_pos(d)
        for si, s in enumerate(scored):
            sem = overlap(dg, s["bg"])
            total = sem * 10 + s["score"] * 0.4 + (1.0 if s["g"] == 2 else 0)
            # 词性一致/冲突：语义分相近时靠它决定归属
            if dp and s["pos"]:
                total += 2.0 if dp == s["pos"] else -5.0
            # 释义在前的优先级略高（词典里第一个释义通常最常用）
            total -= di * 0.12
            pairs.append((total, si, di))
    pairs.sort(key=lambda x: (-x[0], x[2], x[1]))
    out = [None] * len(def_texts)
    used = set()
    for total, si, di in pairs:
        if out[di] is not None or si in used:
            continue
        out[di] = [scored[si]["en"], scored[si]["cn"]]
        used.add(si)
    return out
