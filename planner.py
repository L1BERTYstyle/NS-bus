"""
Планировщик поездок на автобусах Нови-Сада (как «Маршрут на транспорте» в Яндекс Картах).

1. Статический поиск: варианты без пересадок и с одной пересадкой (упрощённый RAPTOR),
   время поездки оценивается по расстоянию между остановками.
2. Уточнение по живым данным NSmart: реальное ожидание ближайшего автобуса нужной линии
   (с правильным направлением) и время прибытия этого же автобуса на остановку выхода.
"""
import math
from collections import defaultdict

WALK_SPEED = 1.25        # м/с (~4.5 км/ч)
WALK_DETOUR = 1.25       # улицы не идут по прямой
MAX_ACCESS = 1000        # м — радиус поиска остановок у старта/финиша
MAX_ACCESS_WIDE = 2000
MAX_TRANSFER = 350       # м — пешая пересадка между остановками
ROAD_FACTOR = 1.2
TRANSFER_PENALTY = 240   # с — «неудобство» пересадки при сортировке
DEFAULT_WAIT = {"1": 420, "2": 900, "3": 1200}
SPEED = {"1": 6.0, "2": 9.0, "3": 10.0}
DWELL = {"1": 20, "2": 15, "3": 15}


def hav(a_lat, a_lng, b_lat, b_lng):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    x = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lng - a_lng) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))


def walk_sec(m):
    return m * WALK_DETOUR / WALK_SPEED


def split_legs(ids, coords, title):
    """Делит список остановок линии из сети NSmart на направления (туда/обратно)."""
    if len(ids) < 6:
        return [ids]
    parts = [p.strip().lower() for p in title.replace("–", "-").split("-") if p.strip()]
    if len(parts) > 2 and parts[0] == parts[-1]:
        return [ids]  # кольцевая
    f, l = coords[ids[0]], coords[ids[-1]]
    if hav(f[0], f[1], l[0], l[1]) > 1500:
        return [ids]
    k, best = 0, -1
    for i, s in enumerate(ids):
        d = hav(f[0], f[1], coords[s][0], coords[s][1])
        if d > best:
            best, k = d, i
    if k < 2 or k > len(ids) - 3:
        return [ids]
    return [ids[:k + 1], ids[k + 1:]]


class Planner:
    def __init__(self, stations, lines, patterns):
        """
        stations: {id: {"la","lo","n"}}
        lines:    [{"n","t","ty","s"}]  (сеть NSmart, порядок не гарантирован)
        patterns: {line_num: [[ids...], ...]}  — реальные рейсы, собранные из живых данных
        """
        self.st = stations
        coords = {i: (s["la"], s["lo"]) for i, s in stations.items()}
        self.coords = coords
        ty_by_num, title_by_num = {}, {}
        for l in lines:
            ty_by_num.setdefault(l["n"], l["ty"])
            title_by_num.setdefault(l["n"], l["t"])
        self.title = title_by_num
        self.pats = []
        seen = set()

        def add(num, ids, verified):
            clean = []
            for i in ids:
                if i in coords and (not clean or clean[-1] != i):
                    clean.append(i)
            if len(clean) < 2:
                return
            key = (num, tuple(clean))
            if key in seen:
                return
            seen.add(key)
            ty = ty_by_num.get(num, "1")
            sp, dw = SPEED.get(ty, 6.0), DWELL.get(ty, 20)
            cum, dist = [0.0], [0.0]
            for a, b in zip(clean, clean[1:]):
                d = hav(*coords[a], *coords[b]) * ROAD_FACTOR
                cum.append(cum[-1] + d / sp + dw)
                dist.append(dist[-1] + d)
            self.pats.append({"line": num, "ty": ty, "ids": clean, "cum": cum, "dist": dist, "ver": verified})

        for num, plist in patterns.items():
            if num in ty_by_num:
                for ids in plist:
                    add(num, ids, True)
        for l in lines:
            if l["n"] in patterns:
                continue
            # линия ещё не видна в живых данных — берём сеть, оба направления
            for leg in split_legs(l["s"], coords, l["t"]):
                add(l["n"], leg, False)
                add(l["n"], leg[::-1], False)

        self.at = defaultdict(list)
        for pi, p in enumerate(self.pats):
            for k, s in enumerate(p["ids"]):
                self.at[s].append((pi, k))
        # пространственная сетка
        self.cell = 0.004
        self.grid = defaultdict(list)
        for i, (la, lo) in coords.items():
            if i in self.at:
                self.grid[(int(la / self.cell), int(lo / self.cell))].append(i)
        self.nb = {}
        for s in self.at:
            self.nb[s] = [(m, d) for m, d in self.near(*coords[s], MAX_TRANSFER)]

    def near(self, lat, lng, radius):
        dl = radius / 111000.0
        dg = radius / (111000.0 * math.cos(math.radians(lat)))
        out = []
        for a in range(int((lat - dl) / self.cell) - 1, int((lat + dl) / self.cell) + 2):
            for b in range(int((lng - dg) / self.cell) - 1, int((lng + dg) / self.cell) + 2):
                for s in self.grid.get((a, b), ()):
                    d = hav(lat, lng, *self.coords[s])
                    if d <= radius:
                        out.append((s, d))
        return out

    # ------------------------------------------------------------------ static search
    def access(self, p):
        """Остановки в пешей доступности: {stop: прямое расстояние, м}."""
        A = dict(self.near(p[0], p[1], MAX_ACCESS))
        if len(A) < 3:
            A = dict(self.near(p[0], p[1], MAX_ACCESS_WIDE))
        return A

    def candidates(self, Ow, Dw, limit=10):
        """Ow/Dw: {stop: секунд пешком} от старта / до финиша."""
        pats = self.pats
        best = {}

        def keep(key, cost, rank, legs):
            cur = best.get(key)
            if cur is None or rank < cur[1]:
                best[key] = (cost, rank, legs)

        # --- без пересадок
        for pi, P in enumerate(pats):
            ids, cum = P["ids"], P["cum"]
            bv, bi = None, None
            w = DEFAULT_WAIT.get(P["ty"], 600)
            for j, s in enumerate(ids):
                if bv is not None and s in Dw and j > bi:
                    cost = bv + cum[j] + Dw[s] + w
                    keep(("d", P["line"]), cost, cost, [("bus", pi, bi, j)])
                if s in Ow:
                    v = Ow[s] - cum[j]
                    if bv is None or v < bv:
                        bv, bi = v, j

        # --- одна пересадка
        to_dest = {}
        for pi, P in enumerate(pats):
            ids, cum = P["ids"], P["cum"]
            if not any(s in Dw for s in ids):
                continue
            arr = [None] * len(ids)
            ba, bq = math.inf, None
            for p in range(len(ids) - 1, -1, -1):
                if bq is not None:
                    arr[p] = (ba - cum[p], bq)
                s = ids[p]
                if s in Dw and cum[p] + Dw[s] < ba:
                    ba, bq = cum[p] + Dw[s], p
            to_dest[pi] = arr
        by_stop_b = defaultdict(list)
        for pi, arr in to_dest.items():
            for p, v in enumerate(arr):
                if v is not None:
                    by_stop_b[pats[pi]["ids"][p]].append((pi, p, v[0], v[1]))

        for pa, A in enumerate(pats):
            ids, cum = A["ids"], A["cum"]
            wa = DEFAULT_WAIT.get(A["ty"], 600)
            bv, bi = None, None
            for k, s in enumerate(ids):
                if bv is not None and k > bi:
                    t_arr = bv + cum[k] + wa
                    for m, dm in self.nb.get(s, ()):
                        for pb, p, rest, q in by_stop_b.get(m, ()):
                            B = pats[pb]
                            if B["line"] == A["line"]:
                                continue
                            cost = t_arr + walk_sec(dm) + DEFAULT_WAIT.get(B["ty"], 600) + rest
                            keep(("t", A["line"], B["line"]), cost, cost + TRANSFER_PENALTY,
                                 [("bus", pa, bi, k), ("bus", pb, p, q)])
                if s in Ow:
                    v = Ow[s] - cum[k]
                    if bv is None or v < bv:
                        bv, bi = v, k

        items = sorted(best.values(), key=lambda x: x[1])
        if not items:
            return []
        top = items[0][1]
        # прямые варианты ценнее: берём их шире
        out, nd = [], 0
        for cost, rank, legs in items:
            direct = len(legs) == 1
            if rank > top * 2.2 + 900 and not (direct and rank < top * 3):
                continue
            if not direct and nd >= limit - 3 and len(out) >= limit:
                continue
            out.append(legs)
            nd += not direct
            if len(out) >= limit + 4:
                break
        return out

    # ------------------------------------------------------------------ walking
    def walk(self, a, b, foot=None):
        """Пеший участок по улицам: {'m','sec','geo','street'}; без роутера — оценка."""
        if foot is not None:
            try:
                r = foot.route(a, b)
                # своя скорость: ~4.5 км/ч (у OSRM foot она ниже, ~4.5 тоже, но учтём светофоры)
                return {"m": r["m"], "sec": r["m"] / WALK_SPEED + 15, "geo": r["geo"], "street": True}
            except Exception as e:  # noqa: BLE001
                print("foot route failed:", e, flush=True)
        m = hav(a[0], a[1], b[0], b[1]) * WALK_DETOUR
        return {"m": m, "sec": m / WALK_SPEED, "geo": [list(a), list(b)], "street": False}

    def walk_access(self, p, stops, foot=None, reverse=False):
        """{stop: (метры, секунды, по_улицам)} для точки p и остановок рядом (по улицам — одним запросом table)."""
        straight = {s: (m * WALK_DETOUR, m * WALK_DETOUR / WALK_SPEED, False) for s, m in stops.items()}
        if foot is None or not stops:
            return straight
        ids = list(stops)
        try:
            res = foot.table(p, [self.coords[s] for s in ids], reverse=reverse)
        except Exception as e:  # noqa: BLE001
            print("foot table failed:", e, flush=True)
            return straight
        out = {}
        for s, r in zip(ids, res):
            if r is None:
                continue
            m = r[0]
            if m > MAX_ACCESS_WIDE * 1.6:
                continue  # напрямую близко, а по улицам — далеко (река, ж/д, забор)
            out[s] = (m, m / WALK_SPEED + 15, True)
        return out or straight

    # ------------------------------------------------------------------ build journey
    def build(self, o, d, legs, arrivals_fn, foot=None, acc_o=None, acc_d=None):
        """Собирает вариант с учётом живых данных. arrivals_fn(stop_id) -> list items.
        acc_o/acc_d — готовые пешие расстояния по улицам до остановок у старта/финиша."""
        t = 0.0
        pos = o
        out = []
        walk_m = 0.0
        bus_m = 0.0
        live_any = False
        for n, (kind, pi, i, j) in enumerate(legs):
            P = self.pats[pi]
            s_from, s_to = P["ids"][i], P["ids"][j]
            c_from = self.coords[s_from]
            if hav(pos[0], pos[1], *c_from) > 12:
                if n == 0 and acc_o and s_from in acc_o:
                    m_, s_, st_ = acc_o[s_from]
                    w = {"m": m_, "sec": s_, "geo": None, "street": st_}
                else:
                    w = self.walk(pos, c_from, foot)
                out.append({"type": "walk", "from": list(pos), "to": list(c_from), "m": round(w["m"]), "sec": round(w["sec"]),
                            "geo": w["geo"], "street": w["street"], "toStop": s_from})
                t += w["sec"]
                walk_m += w["m"]
            ride = P["cum"][j] - P["cum"][i]
            wait = DEFAULT_WAIT.get(P["ty"], 600)
            dep_live = None
            nexts = []
            garage = None
            status = "estimate"
            try:
                items = arrivals_fn(s_from) or []
            except Exception:  # noqa: BLE001
                items = None
            if items is not None:
                fit = []
                for it in items:
                    if it["line"] != P["line"]:
                        continue
                    trip = [x[0] for x in it.get("trip") or []]
                    if trip:
                        try:
                            a = trip.index(s_from)
                        except ValueError:
                            continue
                        if s_to not in trip[a + 1:]:
                            continue  # автобус идёт в другую сторону
                    fit.append(it)
                fit.sort(key=lambda x: x["sec"])
                ok = [x for x in fit if x["sec"] >= t - 20]
                if ok:
                    b = ok[0]
                    wait = max(0.0, b["sec"] - t)
                    dep_live = b["sec"]
                    garage = b.get("garage") or None
                    status = "live" if b.get("live") else "sched"
                    live_any = live_any or b.get("live")
                    nexts = [x["sec"] for x in ok[1:3]]
                    # время в пути по прогнозу NSmart для этого же автобуса
                    if garage:
                        try:
                            for it2 in arrivals_fn(s_to) or []:
                                if it2.get("garage") == garage and it2["line"] == P["line"] and it2["sec"] > b["sec"]:
                                    r2 = it2["sec"] - b["sec"]
                                    if 0.4 * ride < r2 < 2.5 * ride + 300:
                                        ride = r2
                                    break
                        except Exception:  # noqa: BLE001
                            pass
                else:
                    status = "none"
                    wait = DEFAULT_WAIT.get(P["ty"], 600) * (1.6 if status == "none" else 1.0)
            t += wait
            out.append({
                "type": "bus", "line": P["line"], "ty": P["ty"], "title": self.title.get(P["line"], ""),
                "from": s_from, "to": s_to, "stops": P["ids"][i:j + 1], "hops": j - i, "head": P["ids"][-1],
                "wait": round(wait), "dep": round(dep_live if dep_live is not None else t),
                "ride": round(ride), "dist": round(P["dist"][j] - P["dist"][i]),
                "status": status, "garage": garage, "next": [round(x) for x in nexts], "verified": P["ver"],
            })
            t += ride
            bus_m += P["dist"][j] - P["dist"][i]
            pos = self.coords[s_to]
        if hav(pos[0], pos[1], d[0], d[1]) > 12:
            last = legs[-1] if legs else None
            s_last = self.pats[last[1]]["ids"][last[3]] if last else None
            if acc_d and s_last in acc_d:
                m_, s_, st_ = acc_d[s_last]
                w = {"m": m_, "sec": s_, "geo": None, "street": st_}
            else:
                w = self.walk(pos, d, foot)
            out.append({"type": "walk", "from": list(pos), "to": list(d), "m": round(w["m"]), "sec": round(w["sec"]),
                        "geo": w["geo"], "street": w["street"]})
            t += w["sec"]
            walk_m += w["m"]
        nb = sum(1 for x in out if x["type"] == "bus")
        return {"total": round(t), "walk_m": round(walk_m), "dist_m": round(walk_m + bus_m),
                "transfers": max(0, nb - 1), "live": bool(live_any), "legs": out}

    def plan(self, o, d, arrivals_fn, pool=None, foot=None):
        direct = hav(o[0], o[1], d[0], d[1])
        walk_only = None
        if direct < 4000:
            w = self.walk(o, d, foot)
            walk_only = {"total": round(w["sec"]), "walk_m": round(w["m"]), "dist_m": round(w["m"]), "transfers": 0, "live": False,
                         "legs": [{"type": "walk", "from": list(o), "to": list(d), "m": round(w["m"]), "sec": round(w["sec"]),
                                   "geo": w["geo"], "street": w["street"]}]}
        if direct < 350:
            return {"options": [], "walk": walk_only}
        O, D = self.access(o), self.access(d)
        if pool is not None:
            fo = pool.submit(self.walk_access, o, O, foot, False)
            fd = pool.submit(self.walk_access, d, D, foot, True)
            Ao, Ad = fo.result(), fd.result()
        else:
            Ao, Ad = self.walk_access(o, O, foot), self.walk_access(d, D, foot, True)
        cands = self.candidates({s: v[1] for s, v in Ao.items()}, {s: v[1] for s, v in Ad.items()})
        # пересадки считаем по прямой (их мало и они короткие), чтобы не делать десятки запросов
        if pool is not None:
            built = list(pool.map(lambda lg: self.build(o, d, lg, arrivals_fn, None, Ao, Ad), cands))
        else:
            built = [self.build(o, d, lg, arrivals_fn, None, Ao, Ad) for lg in cands]
        # нет смысла ехать, если пешком быстрее или почти так же
        if walk_only:
            built = [b for b in built if b["total"] < walk_only["total"] - 120]
        # пересадка ради 1 короткой остановки — бессмысленна
        built = [b for b in built if b["transfers"] == 0 or all(l["hops"] > 1 or l["dist"] > 700 for l in b["legs"] if l["type"] == "bus")]
        rank = lambda b: b["total"] + TRANSFER_PENALTY * b["transfers"] + (300 if any(l.get("status") == "none" for l in b["legs"]) else 0)
        built.sort(key=rank)
        # варианты с теми же остановками посадки/выхода объединяем: «5 / 5N»
        groups = {}
        for b in built:
            key = tuple((l["from"], l["to"]) for l in b["legs"] if l["type"] == "bus")
            g = groups.get(key)
            if g is None:
                groups[key] = b
                for l in b["legs"]:
                    if l["type"] == "bus":
                        l["alts"] = []
                continue
            gl = [l for l in g["legs"] if l["type"] == "bus"]
            for la, lb in zip(gl, [l for l in b["legs"] if l["type"] == "bus"]):
                if lb["line"] != la["line"] and lb["line"] not in [a["line"] for a in la["alts"]]:
                    la["alts"].append({"line": lb["line"], "wait": lb["wait"], "status": lb["status"]})
        built = sorted(groups.values(), key=rank)
        # убираем варианты, которые хуже других по всем параметрам
        res, sigs = [], set()
        for b in built:
            sig = tuple((l["line"], l["from"], l["to"]) for l in b["legs"] if l["type"] == "bus")
            lines_sig = tuple(l["line"] for l in b["legs"] if l["type"] == "bus")
            if sig in sigs or lines_sig in sigs:
                continue
            dominated = any(r["total"] <= b["total"] - 60 and r["transfers"] <= b["transfers"] and r["walk_m"] <= b["walk_m"] + 100 for r in res)
            if dominated and b["transfers"] > 0:
                continue
            if res and b["total"] > res[0]["total"] * 2 + 900:
                continue
            sigs.add(sig); sigs.add(lines_sig)
            res.append(b)
            if len(res) >= 7:
                break
        # пешие участки итоговых вариантов: линия пути по улицам; пересадки — уточняем расстояние
        for b in res:
            for k, l in enumerate(b["legs"]):
                if l["type"] == "walk" and not l.get("geo"):
                    w = self.walk(l["from"], l["to"], foot)
                    l["geo"] = w["geo"]
                    if not w["street"] or l["street"]:
                        continue
                    b["total"] += round(w["sec"] - l["sec"])
                    b["walk_m"] += round(w["m"] - l["m"])
                    b["dist_m"] += round(w["m"] - l["m"])
                    l.update(m=round(w["m"]), sec=round(w["sec"]), street=True)
                elif l["type"] == "walk" and l.get("toStop") and k > 0 and not l["street"]:
                    w = self.walk(l["from"], l["to"], foot)
                    b["total"] += round(w["sec"] - l["sec"])
                    b["walk_m"] += round(w["m"] - l["m"])
                    b["dist_m"] += round(w["m"] - l["m"])
                    l.update(m=round(w["m"]), sec=round(w["sec"]), geo=w["geo"], street=w["street"])
        return {"options": res, "walk": walk_only}
