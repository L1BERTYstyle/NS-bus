"""
Собственный пешеходный роутер по улицам Нови-Сада (данные OpenStreetMap через Overpass API).

Граф скачивается один раз (~10 МБ, ~30 с) и хранится в cache/walk_graph.pickle (обновляется раз в 30 дней).
Поиск — Дейкстра / A* на компактных массивах, без внешних библиотек.
"""
import heapq
import json
import math
import os
import pickle
import threading
import time
import urllib.parse
import urllib.request
from array import array

BBOX = (45.17, 19.68, 45.36, 19.98)   # Нови-Сад + Петроварадин, Сремска-Каменица, Футог, Ветерник
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
HIGHWAYS = ("footway|pedestrian|path|steps|living_street|residential|service|unclassified|tertiary|tertiary_link|"
            "secondary|secondary_link|primary|primary_link|track|cycleway|road|trunk|trunk_link|bridleway|corridor|platform")
MAX_AGE = 30 * 86400


def hav(a_lat, a_lng, b_lat, b_lng):
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    x = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b_lng - a_lng) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(x))


class WalkGraph:
    CELL = 0.0015

    def __init__(self, cache_dir, log=print):
        self.file = os.path.join(cache_dir, "walk_graph.pickle")
        self.log = log
        self.ready = False
        self.loading = False
        self.lock = threading.Lock()

    # ------------------------------------------------------------------ load / build
    def ensure(self, background=True):
        if self.ready or self.loading:
            return self.ready
        self.loading = True
        if background:
            threading.Thread(target=self._load, daemon=True).start()
            return False
        self._load()
        return self.ready

    def _load(self):
        try:
            data = None
            if os.path.exists(self.file) and time.time() - os.path.getmtime(self.file) < MAX_AGE:
                with open(self.file, "rb") as f:
                    data = pickle.load(f)
            if data is None:
                try:
                    data = self._download()
                except Exception as e:  # noqa: BLE001
                    self.log("walk graph download failed:", e)
                    if os.path.exists(self.file):
                        with open(self.file, "rb") as f:
                            data = pickle.load(f)
                if data is None:
                    return
                tmp = self.file + ".tmp"
                with open(tmp, "wb") as f:
                    pickle.dump(data, f, protocol=pickle.HIGHEST_PROTOCOL)
                os.replace(tmp, self.file)
            self._setup(data)
            self.ready = True
            self.log(f"walk graph ready: {len(self.lat)} nodes, {len(self.adj_to) // 2} edges")
        except Exception as e:  # noqa: BLE001
            self.log("walk graph failed:", repr(e))
        finally:
            self.loading = False

    def _download(self):
        s, w, n, e = BBOX
        q = (f'[out:json][timeout:180];way[highway~"^({HIGHWAYS})$"][access!~"^(private|no)$"][foot!~"^(no|private)$"]'
             f'({s},{w},{n},{e});(._;>;);out skel qt;')
        last = None
        for url in OVERPASS:
            try:
                t = time.time()
                req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                             headers={"User-Agent": "NSBus/1.0 (Novi Sad bus map)"})
                with urllib.request.urlopen(req, timeout=240) as r:
                    raw = json.loads(r.read())
                self.log(f"walk graph: downloaded from {url} in {time.time() - t:.0f}s")
                return self._compile(raw)
            except Exception as ex:  # noqa: BLE001
                last = ex
                self.log("overpass failed:", url, ex)
        raise RuntimeError(f"all overpass mirrors failed: {last}")

    @staticmethod
    def _compile(raw):
        coords, ways = {}, []
        for el in raw.get("elements", []):
            if el["type"] == "node":
                coords[el["id"]] = (el["lat"], el["lon"])
            elif el["type"] == "way":
                ways.append(el.get("nodes") or [])
        idx, lat, lng = {}, array("d"), array("d")

        def nid(osm):
            i = idx.get(osm)
            if i is None:
                i = idx[osm] = len(lat)
                c = coords[osm]
                lat.append(c[0]); lng.append(c[1])
            return i
        edges = {}
        for nodes in ways:
            prev = None
            for osm in nodes:
                if osm not in coords:
                    prev = None
                    continue
                i = nid(osm)
                if prev is not None and prev != i:
                    a, b = (prev, i) if prev < i else (i, prev)
                    if (a, b) not in edges:
                        edges[(a, b)] = hav(lat[a], lng[a], lat[b], lng[b])
                prev = i
        # CSR (неориентированный граф)
        n = len(lat)
        deg = [0] * n
        for a, b in edges:
            deg[a] += 1; deg[b] += 1
        start = array("i", [0]) * (n + 1)
        for i in range(n):
            start[i + 1] = start[i] + deg[i]
        fill = list(start[:n])
        to = array("i", [0]) * start[n]
        wt = array("f", [0.0]) * start[n]
        for (a, b), d in edges.items():
            to[fill[a]] = b; wt[fill[a]] = d; fill[a] += 1
            to[fill[b]] = a; wt[fill[b]] = d; fill[b] += 1
        return {"lat": lat, "lng": lng, "start": start, "to": to, "wt": wt}

    def _setup(self, d):
        self.lat, self.lng = d["lat"], d["lng"]
        self.adj_start, self.adj_to, self.adj_wt = d["start"], d["to"], d["wt"]
        n = len(self.lat)
        # компоненты связности — привязываемся только к крупным (не к обрывкам дорожек)
        comp = array("i", [-1]) * n
        sizes = []
        for s in range(n):
            if comp[s] != -1:
                continue
            c = len(sizes)
            comp[s] = c
            stack, cnt = [s], 0
            while stack:
                u = stack.pop()
                cnt += 1
                for k in range(self.adj_start[u], self.adj_start[u + 1]):
                    v = self.adj_to[k]
                    if comp[v] == -1:
                        comp[v] = c
                        stack.append(v)
            sizes.append(cnt)
        big = {c for c, sz in enumerate(sizes) if sz >= 200}
        grid = {}
        for i in range(n):
            if comp[i] in big:
                grid.setdefault((int(self.lat[i] / self.CELL), int(self.lng[i] / self.CELL)), []).append(i)
        self.grid = grid

    # ------------------------------------------------------------------ queries
    def snap(self, lat, lng):
        """Ближайший узел графа: (node, метры) или (None, None)."""
        ci, cj = int(lat / self.CELL), int(lng / self.CELL)
        best, bd = None, 1e18
        for r in range(0, 4):
            for a in range(ci - r, ci + r + 1):
                for b in range(cj - r, cj + r + 1):
                    if r and abs(a - ci) != r and abs(b - cj) != r:
                        continue
                    for i in self.grid.get((a, b), ()):
                        d = hav(lat, lng, self.lat[i], self.lng[i])
                        if d < bd:
                            bd, best = d, i
            if best is not None and bd < r * self.CELL * 111000 * 0.7:
                break
        if best is None or bd > 600:
            return None, None
        return best, bd

    def _dijkstra(self, src, limit, targets=None, goal=None):
        dist = {src: 0.0}
        prev = {}
        pq = [(0.0, src)]
        left = set(targets) if targets else None
        st, to, wt = self.adj_start, self.adj_to, self.adj_wt
        gl = (self.lat[goal], self.lng[goal]) if goal is not None else None
        while pq:
            f, u = heapq.heappop(pq)
            du = dist[u]
            if gl is None and f > du + 1e-6:
                continue
            if du > limit:
                break
            if u == goal:
                break
            if left is not None:
                left.discard(u)
                if not left:
                    break
            for k in range(st[u], st[u + 1]):
                v = to[k]
                nd = du + wt[k]
                if nd < dist.get(v, 1e18):
                    dist[v] = nd
                    prev[v] = u
                    h = hav(self.lat[v], self.lng[v], gl[0], gl[1]) if gl else 0.0
                    heapq.heappush(pq, (nd + h, v))
        return dist, prev

    def distances(self, p, pts, limit=3500):
        """Пешие расстояния (м) от p до каждой точки pts по улицам; None — недостижимо."""
        s, sd = self.snap(*p)
        if s is None:
            return None
        snaps = [self.snap(*q) for q in pts]
        tg = {n for n, _ in snaps if n is not None}
        dist, _ = self._dijkstra(s, limit, targets=tg)
        out = []
        for n, d in snaps:
            if n is None or n not in dist:
                out.append(None)
            else:
                out.append(sd + dist[n] + d)
        return out

    def route(self, a, b, limit=8000):
        """{'m', 'geo'} — кратчайший пеший путь по улицам или None."""
        s, sd = self.snap(*a)
        g, gd = self.snap(*b)
        if s is None or g is None:
            return None
        if s == g:
            return {"m": hav(a[0], a[1], b[0], b[1]), "geo": [list(a), list(b)]}
        dist, prev = self._dijkstra(s, limit, goal=g)
        if g not in dist:
            return None
        path = [g]
        while path[-1] != s:
            path.append(prev[path[-1]])
        path.reverse()
        geo = [list(a)] + [[round(self.lat[i], 6), round(self.lng[i], 6)] for i in path] + [list(b)]
        return {"m": sd + dist[g] + gd, "geo": geo}


class Foot:
    """Интерфейс для планировщика: table() и route() по собственному графу."""

    def __init__(self, graph):
        self.g = graph

    def table(self, src, dsts, reverse=False):
        if not self.g.ready:
            raise RuntimeError("walk graph not ready")
        res = self.g.distances(src, dsts)
        if res is None:
            raise RuntimeError("point outside street graph")
        return [(m, m) if m is not None else None for m in res]

    def route(self, a, b):
        if not self.g.ready:
            raise RuntimeError("walk graph not ready")
        r = self.g.route(a, b)
        if r is None:
            raise RuntimeError("no walking path")
        return {"m": round(r["m"]), "sec": round(r["m"] / 1.25), "geo": r["geo"]}

    def save(self):
        pass
