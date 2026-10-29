#!/usr/bin/env python3
"""
NS Bus — карта автобусов Нови-Сада.

Небольшой сервер без внешних зависимостей (только стандартная библиотека Python 3.8+):
  * раздаёт веб-приложение из папки ./static
  * проксирует API NSmart (online.nsmart.rs) — тот же, что использует приложение NSmart
  * строит маршруты по дорогам через OSRM и кэширует их на диск

Запуск:  python server.py [--port 8000] [--host 0.0.0.0]
"""
import argparse
import hashlib
import json
import math
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
CACHE = os.path.join(BASE, "cache")
os.makedirs(CACHE, exist_ok=True)

NSMART = "https://online.nsmart.rs/publicapi/v1"
# Публичный ключ, встроенный в приложение NSmart (одинаковый для всех установок).
NSMART_KEY = "4670f468049bbee2260"
OSRM = os.environ.get("OSRM_URL", "https://router.project-osrm.org")
UA = "NSBus/1.0 (personal Novi Sad bus map)"

NETWORK_RAW = os.path.join(CACHE, "network_raw.json")
LEGS_FILE = os.path.join(CACHE, "legs.json")
NETWORK_TTL = 12 * 3600       # статическая сеть обновляется раз в 12 часов
ARRIVALS_TTL = 12             # прибытия по остановке кэшируются 12 секунд
HIDDEN_LINES = {"777", "990"}  # тестовая линия и «внеплановые рейсы»


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def http_get(url, headers=None, timeout=30, data=None):
    h = {"User-Agent": UA}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def nsmart_get(path, timeout=30):
    return http_get(NSMART + path, {"X-Api-Authentication": NSMART_KEY}, timeout)


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def hav(a_lat, a_lng, b_lat, b_lng):
    """Расстояние в метрах."""
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp = p2 - p1
    dl = math.radians(b_lng - a_lng)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))


# --------------------------------------------------------------------------- network
class Network:
    def __init__(self):
        self.lock = threading.Lock()
        self.compact = None
        self.compact_bytes = None
        self.loaded_at = 0
        self.stations = {}
        self.lines = {}

    def _download(self):
        last = None
        for attempt in range(6):  # сервер иногда обрывает большой ответ — повторяем
            try:
                raw = nsmart_get("/networkextended.php", timeout=90)
                data = json.loads(raw)
                if "stations" in data and "lines" in data:
                    with open(NETWORK_RAW, "wb") as f:
                        f.write(raw)
                    return data
            except Exception as e:  # noqa: BLE001
                last = e
                log("network download failed, retry", attempt + 1, e)
                time.sleep(1.5)
        raise RuntimeError(f"Не удалось загрузить сеть NSmart: {last}")

    def get(self):
        with self.lock:
            if self.compact and time.time() - self.loaded_at < NETWORK_TTL:
                return self.compact_bytes
            data = None
            fresh_file = os.path.exists(NETWORK_RAW) and time.time() - os.path.getmtime(NETWORK_RAW) < NETWORK_TTL
            if fresh_file:
                try:
                    with open(NETWORK_RAW, "rb") as f:
                        data = json.loads(f.read())
                except Exception:  # noqa: BLE001
                    data = None
            if data is None:
                try:
                    data = self._download()
                    log("network downloaded:", len(data["stations"]), "stations,", len(data["lines"]), "lines")
                except Exception:
                    if os.path.exists(NETWORK_RAW):  # офлайн-резерв: старый файл
                        with open(NETWORK_RAW, "rb") as f:
                            data = json.loads(f.read())
                    else:
                        raise
            self._build(data)
            self.loaded_at = time.time()
            return self.compact_bytes

    def _build(self, data):
        stations, out_st = {}, []
        for s in data["stations"]:
            c = s.get("coordinates") or {}
            lat, lng = fnum(c.get("latitude")), fnum(c.get("longitude"))
            if not lat or not lng:
                continue
            lines = [l for l in (s.get("lines_for_station") or []) if l not in HIDDEN_LINES]
            st = {"id": int(s["id"]), "n": (s.get("name") or "").strip(), "la": round(lat, 6),
                  "lo": round(lng, 6), "c": s.get("city_name") or "", "l": lines}
            stations[st["id"]] = st
            out_st.append(st)
        lines, out_ln = {}, []
        for l in data["lines"]:
            num = (l.get("line_number_for_display") or "").strip()
            if not num or num in HIDDEN_LINES:
                continue
            ids = []
            for i in l.get("all_stations") or []:
                try:
                    i = int(i)
                except (TypeError, ValueError):
                    continue
                if i in stations:
                    ids.append(i)
            if len(ids) < 2:
                continue
            ln = {"id": str(l["id"]), "n": num, "t": " ".join((l.get("line_title") or "").split()),
                  "d": l.get("direction_id_for_display") or "", "ty": str(l.get("line_type") or "1"),
                  "s": ids}
            lines[ln["id"]] = ln
            out_ln.append(ln)
        self.stations, self.lines = stations, lines
        self.compact = {"stations": out_st, "lines": out_ln, "updated": int(time.time())}
        self.compact_bytes = json.dumps(self.compact, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


NET = Network()


# --------------------------------------------------------------------------- arrivals
_arr_cache = {}
_arr_lock = threading.Lock()


def raw_arrivals(station_id):
    now = time.time()
    with _arr_lock:
        hit = _arr_cache.get(station_id)
        if hit and now - hit[0] < ARRIVALS_TTL:
            return hit
    raw = nsmart_get(f"/announcement/announcement.php?ibfm=TM00000&station_uid={station_id}", timeout=20)
    data = json.loads(raw)
    entry = (time.time(), data)
    with _arr_lock:
        _arr_cache[station_id] = entry
        if len(_arr_cache) > 3000:
            _arr_cache.clear()
    return entry


def clean_entry(e, station_id):
    if not isinstance(e, dict) or not isinstance(e.get("seconds_left"), (int, float)):
        return None
    veh = (e.get("vehicles") or [{}])[0] if isinstance(e.get("vehicles"), list) and e.get("vehicles") else {}
    lat, lng = fnum(veh.get("lat")), fnum(veh.get("lng"))
    live = abs(lat) > 1 and abs(lng) > 1
    trip = []
    for s in e.get("all_stations") or []:
        c = s.get("coordinates") or {}
        try:
            trip.append([int(s["id"]), round(fnum(c.get("latitude")), 6), round(fnum(c.get("longitude")), 6)])
        except (KeyError, TypeError, ValueError):
            pass
    between = e.get("stations_between")
    between = int(between) if isinstance(between, (int, float)) else None
    # индекс остановки в рейсе (на кольцевых линиях остановка может встречаться дважды)
    occ = [i for i, s in enumerate(trip) if s[0] == station_id]
    t = None
    if occ:
        if between is not None:
            cand = [i for i in occ if i - between >= 0] or occ
            if live and len(cand) > 1:
                cand.sort(key=lambda i: hav(lat, lng, trip[max(0, i - between)][1], trip[max(0, i - between)][2]))
            t = cand[0]
        else:
            t = occ[0]
    nxt = max(0, t - between) if (t is not None and between is not None) else None
    return {
        "line": str(e.get("line_number") or e.get("actual_line_number") or "?"),
        "title": " ".join((e.get("line_title") or "").split()),
        "sec": int(e["seconds_left"]),
        "between": between,
        "garage": str(e.get("garage_no") or veh.get("garageNo") or ""),
        "live": live,
        "lat": lat if live else None,
        "lng": lng if live else None,
        "stop": station_id,
        "t": t,
        "next": nxt,
        "trip": trip,
    }


def arrivals(station_id):
    fetched, data = raw_arrivals(station_id)
    items = []
    name = None
    for e in data if isinstance(data, list) else []:
        if isinstance(e, dict) and e.get("station_name"):
            name = e["station_name"]
        c = clean_entry(e, station_id)
        if c:
            items.append(c)
    items.sort(key=lambda x: x["sec"])
    for it in items:
        PATTERNS.learn(it["line"], [s[0] for s in it["trip"]])
    return {"station": station_id, "name": name, "age": round(time.time() - fetched, 1), "items": items}


# --------------------------------------------------------------------------- real trip patterns
PATTERNS_FILE = os.path.join(CACHE, "patterns.json")


class Patterns:
    """Реальные последовательности остановок рейсов (из живых данных) — правильное направление."""

    def __init__(self):
        self.lock = threading.Lock()
        self.data = {}   # line -> {"a-b-c": last_seen_ts}
        self.dirty = False
        self.version = 0
        if os.path.exists(PATTERNS_FILE):
            try:
                with open(PATTERNS_FILE, "r", encoding="utf-8") as f:
                    self.data = json.load(f)
            except Exception:  # noqa: BLE001
                self.data = {}

    def learn(self, line, ids):
        if len(ids) < 2:
            return
        key = "-".join(map(str, ids))
        with self.lock:
            d = self.data.setdefault(line, {})
            if key not in d:
                self.version += 1
            d[key] = int(time.time())
            self.dirty = True

    def get(self, max_age_days=21):
        lim = time.time() - max_age_days * 86400
        with self.lock:
            return {ln: [list(map(int, k.split("-"))) for k, ts in d.items() if ts >= lim]
                    for ln, d in self.data.items()}

    def save(self):
        with self.lock:
            if not self.dirty:
                return
            tmp = PATTERNS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, separators=(",", ":"))
            os.replace(tmp, PATTERNS_FILE)
            self.dirty = False


PATTERNS = Patterns()


def sweep_all_stations():
    """Один проход по всем остановкам: собирает реальные рейсы всех линий (~10 с)."""
    NET.get()
    ids = [s for s, st in NET.stations.items() if st["l"]]

    def one(sid):
        try:
            arrivals(sid)
        except Exception:  # noqa: BLE001
            pass
    list(_pool.map(one, ids))
    PATTERNS.save()
    log("sweep done:", sum(len(v) for v in PATTERNS.data.values()), "trip patterns for", len(PATTERNS.data), "lines")


def sweeper():
    while True:
        try:
            hour = (time.gmtime().tm_hour + 1) % 24  # ≈ время в Сербии (на хостинге часы в UTC)
            if 5 <= hour <= 23 or not PATTERNS.data:
                sweep_all_stations()
        except Exception as e:  # noqa: BLE001
            log("sweep failed", e)
        time.sleep(30 * 60)


# --------------------------------------------------------------------------- planner
from planner import Planner  # noqa: E402

_planner = {"obj": None, "ver": -1, "net": 0}
_planner_lock = threading.Lock()


def get_planner():
    NET.get()
    with _planner_lock:
        p = _planner
        if p["obj"] is None or p["net"] != NET.loaded_at or (PATTERNS.version != p["ver"] and time.time() - p.get("t", 0) > 300):
            st = {i: {"la": s["la"], "lo": s["lo"], "n": s["n"]} for i, s in NET.stations.items()}
            p["obj"] = Planner(st, list(NET.lines.values()), PATTERNS.get())
            p["ver"], p["net"], p["t"] = PATTERNS.version, NET.loaded_at, time.time()
        return p["obj"]


class Foot:
    """Пешие маршруты по улицам (OSRM, профиль foot, данные OpenStreetMap)."""

    FILE = os.path.join(CACHE, "foot.json")

    def __init__(self, base):
        self.base = base.rstrip("/")
        self.lock = threading.Lock()
        self.sem = threading.Semaphore(2)      # публичный сервер не любит много параллельных запросов
        self.last = 0.0
        self.fail_until = 0
        self.dirty = False
        try:
            with open(self.FILE, "r", encoding="utf-8") as f:
                self.cache = json.load(f)
        except Exception:  # noqa: BLE001
            self.cache = {}

    @staticmethod
    def _k(p):
        return f"{p[0]:.5f},{p[1]:.5f}"

    def _get(self, path, timeout=12):
        if time.time() < self.fail_until:
            raise RuntimeError("foot router temporarily disabled")
        for attempt in range(4):
            with self.sem:
                with self.lock:
                    gap = 0.12 - (time.time() - self.last)
                    self.last = time.time() + max(0.0, gap)
                if gap > 0:
                    time.sleep(gap)
                try:
                    return json.loads(http_get(self.base + path, timeout=timeout))
                except urllib.error.HTTPError as e:
                    if e.code == 429 and attempt < 3:
                        time.sleep(0.4 * (attempt + 1))
                        continue
                    if e.code != 429:
                        self.fail_until = time.time() + 60
                    raise
                except Exception:
                    self.fail_until = time.time() + 60
                    raise
        raise RuntimeError("foot router busy")

    def save(self):
        with self.lock:
            if not self.dirty:
                return
            if len(self.cache) > 20000:
                self.cache = dict(list(self.cache.items())[-10000:])
            tmp = self.FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.cache, f, separators=(",", ":"))
            os.replace(tmp, self.FILE)
            self.dirty = False

    def table(self, src, dsts, reverse=False):
        """Пешие (метры, секунды) от src до каждой точки dsts (или от каждой до src при reverse)."""
        if not dsts:
            return []
        coords = ";".join(f"{p[1]:.6f},{p[0]:.6f}" for p in [src] + list(dsts))
        role = "destinations=0" if reverse else "sources=0"
        j = self._get(f"/table/v1/foot/{coords}?{role}&annotations=duration,distance")
        if j.get("code") != "Ok":
            raise RuntimeError(j.get("code"))
        if reverse:
            dist = [row[0] for row in j["distances"][1:]]
            dur = [row[0] for row in j["durations"][1:]]
        else:
            dist, dur = j["distances"][0][1:], j["durations"][0][1:]
        return [(m, s) if m is not None and s is not None else None for m, s in zip(dist, dur)]

    def route(self, a, b):
        """{'m','sec','geo':[[lat,lng],...]} по улицам."""
        key = self._k(a) + "|" + self._k(b)
        with self.lock:
            hit = self.cache.get(key)
        if hit:
            return hit
        j = self._get(f"/route/v1/foot/{a[1]:.6f},{a[0]:.6f};{b[1]:.6f},{b[0]:.6f}?overview=full&geometries=geojson")
        if j.get("code") != "Ok" or not j.get("routes"):
            raise RuntimeError(j.get("code"))
        r = j["routes"][0]
        geo = [[round(y, 6), round(x, 6)] for x, y in r["geometry"]["coordinates"]]
        res = {"m": round(r["distance"]), "sec": round(r["duration"]), "geo": [list(a)] + geo + [list(b)]}
        with self.lock:
            self.cache[key] = res
            self.dirty = True
        return res


import walkgraph  # noqa: E402

# По умолчанию — свой граф улиц из OpenStreetMap (не зависит от чужих серверов маршрутизации).
# Можно указать внешний OSRM foot-сервер: FOOT_URL=https://.../routed-foot
WALK_GRAPH = walkgraph.WalkGraph(CACHE, log=log)
FOOT = Foot(os.environ["FOOT_URL"]) if os.environ.get("FOOT_URL") else walkgraph.Foot(WALK_GRAPH)


def plan_trip(o, d):
    pl = get_planner()

    def arr(sid):
        try:
            return arrivals(sid)["items"]
        except Exception:  # noqa: BLE001
            return None
    res = pl.plan(o, d, arr, pool=_plan_pool, foot=FOOT)
    res["patterns"] = sum(1 for p in pl.pats if p["ver"])
    try:
        FOOT.save()
    except Exception:  # noqa: BLE001
        pass
    return res


# --------------------------------------------------------------------------- GSPNS news (route changes)
NEWS_URLS = [("changes", "http://www.gspns.co.rs/aktuelno"), ("notices", "http://www.gspns.co.rs/vazna-obavestenja")]
_news = {"t": 0, "data": None}
_news_lock = threading.Lock()


def _strip_html(s):
    import html as _h
    import re as _re
    s = _re.sub(r"<br\s*/?>|</p>|</li>|</h\d>", "\n", s, flags=_re.I)
    s = _re.sub(r"<[^>]+>", "", s)
    s = _h.unescape(s).replace("\xa0", " ")
    s = _re.sub(r"[ \t]+", " ", s)
    return _re.sub(r"\n\s*\n+", "\n", s).strip()


def _mark_news_status(items):
    """Определяет, действует ли ещё изменение: срок «do DD.MM.YYYY» и отмена новостью «Povratak na redovne trase»."""
    import re as _re
    import datetime as _dt
    today = _dt.date.today()

    def pdate(s):
        try:
            d, m, y = [int(x) for x in s.strip(". ").split(".")[:3]]
            return _dt.date(y, m, d)
        except Exception:  # noqa: BLE001
            return None

    def streets(title):
        m = _re.search(r"(?:u|na)\s+(?:Ulici|ulici|Bulevaru|bulevaru)?\s*([A-ZČĆŠŽĐ][\wčćšžđ]+(?:\s+[A-ZČĆŠŽĐ][\wčćšžđ]+)?)", title.split("-", 1)[-1].split("–", 1)[-1])
        return m.group(1).lower() if m else None

    for it in items:
        it["date_obj"] = pdate(it["date"]) if it["date"] else None
        it["active"] = True
        it["until"] = ""
        txt = it["title"] + " " + it["text"][:1500]
        ends = [pdate(x) for x in _re.findall(r"\bdo\s+(\d{1,2}\.\s?\d{1,2}\.\s?\d{4})", txt.replace(". ", "."))]
        ends = [e for e in ends if e]
        if ends:
            end = max(ends)
            it["until"] = end.strftime("%d.%m.%Y")
            if end < today:
                it["active"] = False
        if it["date_obj"] and (today - it["date_obj"]).days > 90:
            it["active"] = False
    # «Povratak na redovne trase u Ulici X» отменяет более ранние изменения по той же улице
    for it in items:
        if _re.search(r"povratak na redovn|vraćaju na redovn|vracaju na redovn", it["title"], _re.I):
            st = streets(it["title"])
            it["active"] = bool(it["date_obj"] and (today - it["date_obj"]).days <= 5)
            it["restored"] = True
            for old in items:
                if old is it or not st or not old["date_obj"] or not it["date_obj"]:
                    continue
                if old["date_obj"] <= it["date_obj"] and st in old["title"].lower():
                    old["active"] = False
    for it in items:
        it.pop("date_obj", None)


def fetch_news():
    import re as _re
    import http.cookiejar
    with _news_lock:
        if _news["data"] is not None and time.time() - _news["t"] < 1800:
            return _news["data"]
        jar = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        op.addheaders = [("User-Agent", "Mozilla/5.0 NSBus")]
        items = []
        try:
            op.open("http://www.gspns.co.rs/?selected_lang=lat", timeout=20).read()  # латиница
            for kind, url in NEWS_URLS:
                page = op.open(url, timeout=20).read().decode("utf-8", "replace")
                blocks = _re.findall(r"<div class=vest>(.*?)(?=<div class=vest>|<div class=\"col-sm-3|$)", page, _re.S)
                for b in blocks[:15]:
                    m = _re.search(r"class=vest-naslov>(.*?)</div>", b, _re.S)
                    title = _strip_html(m.group(1)) if m else ""
                    body = _strip_html(b[m.end():] if m else b)
                    date = ""
                    dm = _re.match(r"\s*(\d{1,2}\.\d{1,2}\.\d{4})\.?\s*", body)
                    if dm:
                        date, body = dm.group(1), body[dm.end():]
                    anchor = _re.search(r"<a name=(\d+)", b)
                    head = title.split(" - ")[0].split(" – ")[0]
                    lines = []
                    if _re.match(r"\s*Linij", head, _re.I):
                        lines = _re.findall(r"\b(\d{1,2}[A-ZČŠŽa-zčšž]{0,4})\b", head)
                        lines = [x.upper().replace("А", "A").replace("Б", "B") for x in lines]
                    items.append({"kind": kind, "title": title, "date": date, "text": body[:6000],
                                  "lines": sorted(set(lines)), "url": url + (f"#{anchor.group(1)}" if anchor else "")})
            _mark_news_status(items)
            _news["data"] = {"items": items, "fetched": int(time.time())}
            _news["t"] = time.time()
        except Exception as e:  # noqa: BLE001
            log("news fetch failed", e)
            if _news["data"] is None:
                _news["data"] = {"items": [], "fetched": 0, "error": str(e)}
                _news["t"] = time.time() - 1500  # повторим через 5 минут
        return _news["data"]


TR_FILE = os.path.join(CACHE, "translations.json")
_tr = {"data": None, "dirty": False}
_tr_lock = threading.Lock()


def _tr_load():
    if _tr["data"] is None:
        try:
            with open(TR_FILE, "r", encoding="utf-8") as f:
                _tr["data"] = json.load(f)
        except Exception:  # noqa: BLE001
            _tr["data"] = {}
    return _tr["data"]


def translate(text, tl="ru", sl="sr"):
    """Машинный перевод (Google Translate) с кэшем на диске. При ошибке — исходный текст."""
    if not text.strip():
        return text
    key = tl + ":" + hashlib.sha1(text.encode("utf-8")).hexdigest()
    with _tr_lock:
        hit = _tr_load().get(key)
    if hit is not None:
        return hit
    out = []
    # режем по абзацам на куски до ~1800 символов
    chunk, chunks = "", []
    for para in text.split("\n"):
        if len(chunk) + len(para) > 1800 and chunk:
            chunks.append(chunk)
            chunk = ""
        chunk += para + "\n"
    if chunk:
        chunks.append(chunk)
    try:
        for c in chunks:
            body = urllib.parse.urlencode({"q": c}).encode()
            raw = http_get(f"https://translate.googleapis.com/translate_a/single?client=gtx&sl={sl}&tl={tl}&dt=t",
                           {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "Mozilla/5.0"},
                           timeout=20, data=body)
            j = json.loads(raw)
            out.append("".join(s[0] for s in j[0] if s and s[0]))
    except Exception as e:  # noqa: BLE001
        log("translate failed", e)
        return text
    res = "".join(out).replace("\u200b", "").strip()
    with _tr_lock:
        _tr_load()[key] = res
        _tr["dirty"] = True
    return res


def _tr_save():
    with _tr_lock:
        if not _tr["dirty"]:
            return
        tmp = TR_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_tr["data"], f, ensure_ascii=False)
        os.replace(tmp, TR_FILE)
        _tr["dirty"] = False


def news_for_lang(lang):
    data = fetch_news()
    if lang != "ru" or not data.get("items"):
        return data
    items = data["items"]

    def tr_item(it):
        it = dict(it)
        it["title"] = translate(it["title"])
        it["text"] = translate(it["text"])
        return it
    out = list(_pool.map(tr_item, items))
    _tr_save()
    return dict(data, items=out, translated=True)


_pool = ThreadPoolExecutor(max_workers=8)
_plan_pool = ThreadPoolExecutor(max_workers=8)   # отдельно, чтобы фоновый обход остановок не тормозил маршруты


def line_vehicles(line_id):
    NET.get()
    line = NET.lines.get(str(line_id))
    if not line:
        return None
    ids = list(dict.fromkeys(line["s"]))
    n = len(ids)
    k = 8 if n <= 80 else 12
    probes = sorted({ids[min(n - 1, round(i * (n - 1) / (k - 1)))] for i in range(k)})
    num = line["n"]

    def one(sid):
        try:
            return arrivals(sid)
        except Exception as e:  # noqa: BLE001
            log("arrivals fail", sid, e)
            return None

    best = {}
    for res in _pool.map(one, probes):
        if not res:
            continue
        for it in res["items"]:
            if it["line"] != num or not it["live"]:
                continue
            key = it["garage"] or f"{it['lat']:.4f},{it['lng']:.4f}"
            it = dict(it, age=res["age"])
            cur = best.get(key)
            # оставляем запись, где автобус ближе к контрольной остановке (точнее прогноз)
            if cur is None or (it["between"] if it["between"] is not None else 99) < (cur["between"] if cur["between"] is not None else 99):
                best[key] = it
    return {"line": line_id, "n": num, "vehicles": list(best.values()), "probes": len(probes)}


# --------------------------------------------------------------------------- road geometry (OSRM)
class Legs:
    def __init__(self):
        self.lock = threading.Lock()
        self.osrm_lock = threading.Lock()
        self.data = {}
        self.dirty = 0
        if os.path.exists(LEGS_FILE):
            try:
                with open(LEGS_FILE, "r", encoding="utf-8") as f:
                    self.data = json.load(f)
            except Exception:  # noqa: BLE001
                self.data = {}

    @staticmethod
    def key(a, b):
        return f"{a[0]:.5f},{a[1]:.5f}|{b[0]:.5f},{b[1]:.5f}"

    def save(self):
        with self.lock:
            if not self.dirty:
                return
            tmp = LEGS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, separators=(",", ":"))
            os.replace(tmp, LEGS_FILE)
            self.dirty = 0

    def _osrm(self, pts):
        coords = ";".join(f"{p[1]:.6f},{p[0]:.6f}" for p in pts)
        url = f"{OSRM}/route/v1/driving/{coords}?overview=false&steps=true&geometries=geojson"
        res = json.loads(http_get(url, timeout=40))
        if res.get("code") != "Ok":
            raise RuntimeError(res.get("code"))
        out = []
        for i, leg in enumerate(res["routes"][0]["legs"]):
            geom = []
            for st in leg.get("steps") or []:
                for lng, lat in st["geometry"]["coordinates"]:
                    p = [round(lat, 5), round(lng, 5)]
                    if not geom or geom[-1] != p:
                        geom.append(p)
            a, b = pts[i], pts[i + 1]
            straight = hav(a[0], a[1], b[0], b[1])
            dist = leg.get("distance", 0)
            # защита от «петель» OSRM (разворот из-за неточной привязки остановки к дороге)
            if len(geom) < 2 or (dist > 3 * straight and dist - straight > 700):
                geom = [[round(a[0], 5), round(a[1], 5)], [round(b[0], 5), round(b[1], 5)]]
            out.append(geom)
        return out

    def route(self, pts):
        pts = [[float(p[0]), float(p[1])] for p in pts]
        if len(pts) < 2:
            return []
        keys = [self.key(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
        missing = [i for i, k in enumerate(keys) if k not in self.data]
        if missing:
            # собираем непрерывные куски с недостающими участками и запрашиваем их пачками
            runs, start = [], None
            for i in range(len(keys)):
                m = keys[i] not in self.data
                if m and start is None:
                    start = i
                if not m and start is not None:
                    runs.append((start, i)); start = None
            if start is not None:
                runs.append((start, len(keys)))
            CH = 80
            with self.osrm_lock:
                for a, b in runs:
                    i = a
                    while i < b:
                        j = min(b, i + CH)
                        chunk = pts[i:j + 1]
                        try:
                            geoms = self._osrm(chunk)
                            with self.lock:
                                for q, g in enumerate(geoms):
                                    self.data[keys[i + q]] = g
                                self.dirty += len(geoms)
                        except Exception as e:  # noqa: BLE001
                            log("OSRM failed:", e)
                        i = j
            self.save()
        out = []
        for i, k in enumerate(keys):
            g = self.data.get(k)
            if not g:
                a, b = pts[i], pts[i + 1]
                g = [[round(a[0], 5), round(a[1], 5)], [round(b[0], 5), round(b[1], 5)]]
            out.append(g)
        return out


LEGS = Legs()


# --------------------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or "") and not str(args[1] if len(args) > 1 else "").startswith("2"):
            log("HTTP", fmt % args)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, code=200, raw=None):
        body = raw if raw is not None else json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/api/network":
                return self.send_json(None, raw=NET.get())
            if u.path == "/api/arrivals":
                return self.send_json(arrivals(int(q["station"][0])))
            if u.path == "/api/vehicles":
                res = line_vehicles(q["line"][0])
                return self.send_json(res or {"error": "unknown line"}, 200 if res else 404)
            if u.path == "/api/news":
                return self.send_json(news_for_lang((q.get("lang") or ["sr"])[0]))
            if u.path == "/api/plan":
                o = [float(x) for x in q["from"][0].split(",")]
                d = [float(x) for x in q["to"][0].split(",")]
                return self.send_json(plan_trip(o, d))
            if u.path == "/api/walk":
                a = [float(x) for x in q["from"][0].split(",")]
                b = [float(x) for x in q["to"][0].split(",")]
                try:
                    r = FOOT.route(a, b)
                    FOOT.save()
                    return self.send_json({"m": r["m"], "sec": r["sec"], "geo": r["geo"], "street": True})
                except Exception as e:  # noqa: BLE001
                    return self.send_json({"geo": [a, b], "street": False, "error": str(e)})
            if u.path == "/api/health":
                return self.send_json({"ok": True, "walk_graph": WALK_GRAPH.ready})
        except (KeyError, ValueError):
            return self.send_json({"error": "bad request"}, 400)
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
            return self.send_json({"error": f"NSmart недоступен: {e}"}, 502)
        except Exception as e:  # noqa: BLE001
            log("error", self.path, repr(e))
            return self.send_json({"error": str(e)}, 500)
        if u.path.startswith("/api/"):
            return self.send_json({"error": "not found"}, 404)
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(n, 2_000_000)) or b"{}")
            if u.path == "/api/route":
                pts = body.get("pts") or []
                if len(pts) > 1500:
                    return self.send_json({"error": "too many points"}, 400)
                return self.send_json({"legs": LEGS.route(pts)})
        except Exception as e:  # noqa: BLE001
            log("error", self.path, repr(e))
            return self.send_json({"error": str(e)}, 500)
        return self.send_json({"error": "not found"}, 404)


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ips)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    print("=" * 60)
    print(" NS Bus - Novi Sad bus map")
    print(f"   On this PC:            http://localhost:{args.port}")
    if args.host == "0.0.0.0":
        for ip in lan_ips():
            print(f"   On phone (same Wi-Fi): http://{ip}:{args.port}")
    print(" Keep this window open. Stop: Ctrl+C")
    print("=" * 60, flush=True)
    threading.Thread(target=lambda: NET.get(), daemon=True).start()  # прогрев
    threading.Thread(target=sweeper, daemon=True).start()           # сбор реальных рейсов
    WALK_GRAPH.ensure(background=True)                               # граф улиц для пеших участков
    threading.Thread(target=lambda: news_for_lang("ru"), daemon=True).start()  # новости + перевод заранее
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        LEGS.save()
        PATTERNS.save()


if __name__ == "__main__":
    main()
