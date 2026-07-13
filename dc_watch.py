#!/usr/bin/env python3
"""Daily Spanish datacenter news watch. Runs on the Hermes VM via cron (12:15 UTC — outside
DeepSeek peak pricing windows 01-04 & 06-10 UTC).

Pipeline: RSS feeds -> keyword prefilter -> article text -> DeepSeek V4 Flash structured
extraction (batched, cost-capped) -> reconcile SQLite knowledge base -> export dc_live.json
-> push to GitHub (Contents API, no git needed) -> Telegram digest.

Env (.env in same dir): DEEPSEEK_API_KEY, GH_TOKEN, GH_REPO (owner/name),
TG_BOT_TOKEN, TG_CHAT_ID, [DEEPSEEK_MODEL=deepseek-v4-flash]
"""
import base64, difflib, json, os, re, sqlite3, sys, time, unicodedata
from datetime import date, datetime

import requests
import feedparser
import trafilatura

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "dc_watch.sqlite")
LOG = os.path.join(HERE, "dc_watch.log")
MAX_ARTICLES = 40          # daily LLM budget cap
BATCH = 8                  # articles per LLM call
TRUNC = 3500               # chars of article text sent to the LLM

FEEDS = [
    "https://news.google.com/rss/search?q=%22centro+de+datos%22+when:2d&hl=es&gl=ES&ceid=ES:es",
    "https://news.google.com/rss/search?q=%22data+center%22+Espa%C3%B1a+when:2d&hl=es&gl=ES&ceid=ES:es",
    "https://news.google.com/rss/search?q=hiperescala+OR+hyperscale+Espa%C3%B1a+when:2d&hl=es&gl=ES&ceid=ES:es",
    "https://www.datacenterdynamics.com/es/rss/",
]
KEY = re.compile(r"centro de datos|data\s?center|datacenter|cpd\b|hiperescala|hyperscale", re.I)

def env():
    p = os.path.join(HERE, ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
env()
E = os.environ.get

def log(msg):
    line = f"{datetime.utcnow().isoformat(timespec='seconds')} {msg}"
    print(line)
    open(LOG, "a").write(line + "\n")

def tg(text):
    tok, chat = E("TG_BOT_TOKEN"), E("TG_CHAT_ID")
    if not tok or not chat: return
    try:
        requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                      json={"chat_id": chat, "text": text[:4000], "disable_web_page_preview": True},
                      timeout=20)
    except Exception as e:
        log(f"telegram error: {e}")

def norm(s):
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")

# ---------------- DB ----------------
def db():
    con = sqlite3.connect(DB)
    con.executescript("""
    CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, name TEXT, company TEXT,
      lat REAL, lon REAL, status TEXT, mw REAL, region TEXT, src TEXT, review INTEGER DEFAULT 0,
      updated TEXT, notes TEXT);
    CREATE TABLE IF NOT EXISTS news(id INTEGER PRIMARY KEY, project_id INTEGER, url TEXT UNIQUE,
      source TEXT, date TEXT, title TEXT, event_type TEXT, mw REAL, eur_m REAL,
      summary TEXT, confidence REAL);
    CREATE TABLE IF NOT EXISTS seen(url TEXT PRIMARY KEY, ts TEXT, relevant INTEGER);
    CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY, project_id INTEGER, field TEXT,
      old TEXT, new TEXT, news_url TEXT, ts TEXT);
    """)
    try: con.execute("ALTER TABLE projects ADD COLUMN investment_eur_m REAL")
    except sqlite3.OperationalError: pass
    return con

def log_change(con, pid, field, old, new, url):
    con.execute("INSERT INTO changes(project_id,field,old,new,news_url,ts) VALUES(?,?,?,?,?,?)",
                (pid, field, str(old) if old is not None else None, str(new), url, date.today().isoformat()))

def update_fields(con, pid, it, url):
    """Propagate newly-learned facts (MW, investment, company) into the project card, with provenance."""
    changed = []
    row = con.execute("SELECT mw, investment_eur_m, company, region FROM projects WHERE id=?", (pid,)).fetchone()
    cur_mw, cur_inv, cur_comp, cur_reg = row
    conf = it.get("confidence", 0)
    if it.get("mw") and (cur_mw is None or (abs(it["mw"] - cur_mw) / max(cur_mw, 1) > 0.15 and conf >= 0.7)):
        con.execute("UPDATE projects SET mw=?, updated=? WHERE id=?", (it["mw"], date.today().isoformat(), pid))
        log_change(con, pid, "mw", cur_mw, it["mw"], url); changed.append(f"mw {cur_mw}→{it['mw']}")
    if it.get("eur_m") and (cur_inv is None or (abs(it["eur_m"] - cur_inv) / max(cur_inv, 1) > 0.15 and conf >= 0.7)):
        con.execute("UPDATE projects SET investment_eur_m=?, updated=? WHERE id=?", (it["eur_m"], date.today().isoformat(), pid))
        log_change(con, pid, "investment_eur_m", cur_inv, it["eur_m"], url); changed.append(f"inv {cur_inv}→{it['eur_m']}M€")
    if it.get("company") and not cur_comp:
        con.execute("UPDATE projects SET company=? WHERE id=?", (it["company"], pid))
        log_change(con, pid, "company", None, it["company"], url)
    if it.get("province") and not cur_reg:
        con.execute("UPDATE projects SET region=? WHERE id=?", (it["province"], pid))
    return changed

STATUS_RANK = {"announced": 1, "land": 1, "permit": 2, "construction": 3, "operational": 4, "operating": 4}
EVENT_TO_STATUS = {"land_purchase": "land", "announcement": "announced", "permit": "announced",
                   "construction_start": "construction", "operational": "operating",
                   "expansion": None, "deal": None, "cancelled": "cancelled"}

# ---------------- collect ----------------
def collect(con):
    items, seen = [], {r[0] for r in con.execute("SELECT url FROM seen")}
    for f in FEEDS:
        try:
            fd = feedparser.parse(f)
            for e in fd.entries[:60]:
                url = e.get("link", "")
                title = e.get("title", "")
                if not url or url in seen: continue
                blob = title + " " + e.get("summary", "")
                if not KEY.search(blob):
                    con.execute("INSERT OR IGNORE INTO seen VALUES(?,?,0)", (url, date.today().isoformat()))
                    continue
                items.append({"url": url, "title": title,
                              "source": e.get("source", {}).get("title") or fd.feed.get("title", "rss"),
                              "published": e.get("published", "")[:16],
                              "rss_summary": re.sub(r"<[^>]+>", " ", e.get("summary", ""))[:400]})
                seen.add(url)
        except Exception as ex:
            log(f"feed error {f}: {ex}")
    con.commit()
    return items[:MAX_ARTICLES]

def fetch_text(url):
    try:
        if "news.google.com" in url:
            # Google News wraps links in an encoded redirect; decode when the helper is available
            try:
                from googlenewsdecoder import new_decoderv1
                d = new_decoderv1(url)
                if d.get("status"): url = d["decoded_url"]
            except Exception:
                return ""  # caller falls back to the RSS summary
        html = trafilatura.fetch_url(url)
        return (trafilatura.extract(html) or "")[:TRUNC]
    except Exception:
        return ""

# ---------------- extract ----------------
PROMPT = """Eres un analista de infraestructura. Para cada articulo devuelve JSON:
{"items":[{"i":<indice>,"relevant":bool,  // relevante SOLO si trata de un proyecto CONCRETO de centro de datos en ESPANA (no opinion, no global, no cursos)
"project_name":str,"company":str,"municipality":str,"province":str,
"event_type":"land_purchase|announcement|permit|construction_start|operational|expansion|deal|cancelled",
"mw":num|null,"eur_m":num|null,"summary":str,  // <=25 palabras, factual
"confidence":0-1}]}
Articulos:
"""

def extract(articles):
    key = E("DEEPSEEK_API_KEY")
    model = E("DEEPSEEK_MODEL", "deepseek-v4-flash")
    out = []
    for i in range(0, len(articles), BATCH):
        chunk = articles[i:i+BATCH]
        body = "".join(f"\n[{j}] TITULAR: {a['title']}\nTEXTO: {a['text'][:TRUNC]}\n" for j, a in enumerate(chunk))
        try:
            r = requests.post("https://api.deepseek.com/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json={"model": model, "response_format": {"type": "json_object"},
                      "messages": [{"role": "user", "content": PROMPT + body}],
                      "temperature": 0.1, "max_tokens": 1800},
                timeout=120)
            r.raise_for_status()
            items = json.loads(r.json()["choices"][0]["message"]["content"]).get("items", [])
            for it in items:
                j = it.get("i")
                if isinstance(j, int) and 0 <= j < len(chunk):
                    it["_a"] = chunk[j]
                    out.append(it)
        except Exception as ex:
            log(f"llm error batch {i}: {ex}")
    return out

# ---------------- reconcile ----------------
def geocode(muni, prov):
    try:
        time.sleep(1.1)  # Nominatim politeness
        r = requests.get("https://nominatim.openstreetmap.org/search",
                         params={"q": f"{muni}, {prov}, Spain", "format": "json", "limit": 1},
                         headers={"User-Agent": "dc-watch/1.0 (personal research)"}, timeout=20)
        j = r.json()
        return (float(j[0]["lat"]), float(j[0]["lon"])) if j else (None, None)
    except Exception:
        return (None, None)

def match_project(con, it):
    name, comp, muni = norm(it.get("project_name")), norm(it.get("company")), norm(it.get("municipality"))
    best, score = None, 0
    for pid, pname, pcomp, pnotes in con.execute("SELECT id,name,company,notes FROM projects"):
        s = 0
        blob = norm(f"{pname} {pcomp} {pnotes}")
        if comp and len(comp) > 3 and comp.split()[0] in blob: s += 0.45
        if muni and muni in blob: s += 0.35
        s += 0.4 * difflib.SequenceMatcher(None, name, norm(pname)).ratio()
        if s > score: best, score = pid, s
    return best if score >= 0.6 else None

def reconcile(con, results):
    new_p, changed, unmatched = [], [], []
    for it in results:
        a = it["_a"]
        con.execute("INSERT OR IGNORE INTO seen VALUES(?,?,?)",
                    (a["url"], date.today().isoformat(), int(bool(it.get("relevant")))))
        if not it.get("relevant") or it.get("confidence", 0) < 0.4: continue
        pid = match_project(con, it)
        if pid is None:
            lat, lon = geocode(it.get("municipality", ""), it.get("province", ""))
            cur = con.execute("INSERT INTO projects(name,company,lat,lon,status,mw,region,src,review,updated,notes) "
                              "VALUES(?,?,?,?,?,?,?,?,1,?,?)",
                              (it.get("project_name") or "?", it.get("company"), lat, lon,
                               EVENT_TO_STATUS.get(it.get("event_type")) or "announced", it.get("mw"),
                               it.get("province"), "news", date.today().isoformat(), it.get("municipality")))
            pid = cur.lastrowid
            log_change(con, pid, "created", None, it.get("event_type"), a["url"])
            if it.get("eur_m"):
                con.execute("UPDATE projects SET investment_eur_m=? WHERE id=?", (it["eur_m"], pid))
            new_p.append(f"{it.get('project_name')} ({it.get('company')}, {it.get('municipality')})")
        else:
            ns = EVENT_TO_STATUS.get(it.get("event_type"))
            if ns:
                old = con.execute("SELECT status FROM projects WHERE id=?", (pid,)).fetchone()[0]
                if ns == "cancelled" or STATUS_RANK.get(ns, 0) > STATUS_RANK.get(old, 0):
                    con.execute("UPDATE projects SET status=?, updated=? WHERE id=?",
                                (ns, date.today().isoformat(), pid))
                    log_change(con, pid, "status", old, ns, a["url"])
                    changed.append(f"{it.get('project_name')}: {old} → {ns}")
            fc = update_fields(con, pid, it, a["url"])
            if fc: changed.append(f"{it.get('project_name')}: " + ", ".join(fc))
        try:
            con.execute("INSERT OR IGNORE INTO news(project_id,url,source,date,title,event_type,mw,eur_m,summary,confidence) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (pid, a["url"], a["source"], a["published"] or date.today().isoformat(),
                         a["title"], it.get("event_type"), it.get("mw"), it.get("eur_m"),
                         it.get("summary"), it.get("confidence")))
        except Exception as ex:
            log(f"news insert: {ex}")
    con.commit()
    return new_p, changed, unmatched

# ---------------- publish ----------------
def export(con):
    projects = []
    for pid, name, comp, lat, lon, status, mw, inv, region, src, review, updated in con.execute(
            "SELECT id,name,company,lat,lon,status,mw,investment_eur_m,region,src,review,updated "
            "FROM projects WHERE lat IS NOT NULL"):
        news = [{"date": d, "title": t, "url": u, "source": s, "event": ev, "summary": sm}
                for (d, t, u, s, ev, sm) in con.execute(
                    "SELECT date,title,url,source,event_type,summary FROM news WHERE project_id=? "
                    "ORDER BY date DESC LIMIT 12", (pid,))]
        chg = [{"ts": ts, "field": f, "old": o, "new": n, "url": u}
               for (ts, f, o, n, u) in con.execute(
                   "SELECT ts,field,old,new,news_url FROM changes WHERE project_id=? "
                   "ORDER BY id DESC LIMIT 8", (pid,))]
        projects.append({"name": name, "company": comp, "lat": lat, "lon": lon, "status": status,
                         "mw": mw, "inv": inv, "region": region, "src": src, "review": review,
                         "updated": updated, "news": news, "changes": chg})
    feed = [{"date": d, "title": t, "url": u, "source": s, "event": ev, "summary": sm, "project": pn}
            for (d, t, u, s, ev, sm, pn) in con.execute(
                "SELECT n.date,n.title,n.url,n.source,n.event_type,n.summary,p.name "
                "FROM news n LEFT JOIN projects p ON p.id=n.project_id "
                "ORDER BY n.id DESC LIMIT 120")]
    return {"generated": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "repo": E("GH_REPO"), "projects": projects, "news_feed": feed}

def push_github(payload):
    tok, repo = E("GH_TOKEN"), E("GH_REPO")
    if not tok or not repo:
        log("GH_TOKEN/GH_REPO unset — skipping publish"); return False
    path, api = "web/data/dc_live.json", f"https://api.github.com/repos/{repo}/contents/"
    h = {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"}
    sha = None
    r = requests.get(api + path, headers=h, timeout=30)
    if r.status_code == 200: sha = r.json().get("sha")
    body = {"message": f"dc_watch {date.today().isoformat()}",
            "content": base64.b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode()}
    if sha: body["sha"] = sha
    r = requests.put(api + path, headers=h, json=body, timeout=30)
    ok = r.status_code in (200, 201)
    log(f"github push: {r.status_code}")
    return ok

# ---------------- main ----------------
def main():
    con = db()
    n_proj = con.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
    if n_proj == 0:
        log("empty DB — run seed_db.py first"); sys.exit(1)
    items = collect(con)
    log(f"candidates: {len(items)}")
    for a in items:
        a["text"] = fetch_text(a["url"])
        if len(a["text"]) < 200:  # paywalled / undecoded — classify from headline + RSS snippet
            a["text"] = f"(solo titular y resumen RSS) {a['title']}. {a.get('rss_summary','')}"
    results = extract(items)
    new_p, changed, _ = reconcile(con, results)
    payload = export(con)
    pushed = push_github(payload)
    rel = sum(1 for r in results if r.get("relevant"))
    msg = (f"🛰 DC-watch {date.today().isoformat()}\n"
           f"{len(items)} articulos, {rel} relevantes\n"
           f"➕ nuevos: {len(new_p)}" + ("".join(f"\n  · {p}" for p in new_p[:6])) +
           f"\n♻️ cambios: {len(changed)}" + ("".join(f"\n  · {c}" for c in changed[:6])) +
           f"\n📦 {len(payload['projects'])} proyectos · publicado: {'sí' if pushed else 'NO'}")
    tg(msg)
    log("done")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"FATAL: {e}")
        tg(f"⚠️ dc_watch FALLÓ: {e}")
        raise
