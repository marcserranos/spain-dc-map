#!/usr/bin/env python3
"""Seed dc_watch.sqlite from the siting model's datacenters.json (run once on the VM).
Usage: python3 seed_db.py datacenters.json"""
import json, sqlite3, sys
from datetime import date

src = sys.argv[1] if len(sys.argv) > 1 else "datacenters.json"
data = json.load(open(src))
con = sqlite3.connect("dc_watch.sqlite")
con.executescript("""
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, name TEXT, company TEXT,
  lat REAL, lon REAL, status TEXT, mw REAL, region TEXT, src TEXT, review INTEGER DEFAULT 0,
  updated TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS news(id INTEGER PRIMARY KEY, project_id INTEGER, url TEXT UNIQUE,
  source TEXT, date TEXT, title TEXT, event_type TEXT, mw REAL, eur_m REAL,
  summary TEXT, confidence REAL);
CREATE TABLE IF NOT EXISTS seen(url TEXT PRIMARY KEY, ts TEXT, relevant INTEGER);
""")
if con.execute("SELECT COUNT(*) FROM projects").fetchone()[0]:
    sys.exit("DB already has projects — refusing to double-seed.")
for d in data:
    comp = d["note"].split("·")[0].strip() if "·" in d.get("note", "") else None
    con.execute("INSERT INTO projects(name,company,lat,lon,status,src,updated,notes) VALUES(?,?,?,?,?,?,?,?)",
                (d["name"], comp, d["lat"], d["lon"], d["status"], d.get("src", "seed"),
                 date.today().isoformat(), d.get("note", "")))
con.commit()
print("seeded", con.execute("SELECT COUNT(*) FROM projects").fetchone()[0], "projects")
