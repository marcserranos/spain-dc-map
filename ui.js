/* ============================================================================
   ui.js — data layer + shared components for the intelligence platform.
   Classic script (no ES modules) so the page still opens from file://.
   Exposes: U (utils), KB (knowledge base), C (components), Router.
   ========================================================================= */
"use strict";

/* ------------------------------- utils --------------------------------- */
const U = {
  /* Article titles/summaries come from scraped third-party pages. Everything
     derived from the knowledge base is escaped before it reaches innerHTML. */
  esc(s){
    if(s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, c =>
      ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  },
  /* only http(s) links are ever rendered — blocks javascript: and data: URLs */
  safeUrl(u){
    if(!u) return null;
    try{
      const p = new URL(u, location.href);
      return (p.protocol === "http:" || p.protocol === "https:") ? p.href : null;
    }catch(e){ return null; }
  },
  host(u){ try{ return new URL(u).hostname.replace(/^www\./, ""); }catch(e){ return ""; } },

  num(v, dp){
    if(v === null || v === undefined || isNaN(v)) return "—";
    return Number(v).toLocaleString("en-GB", {minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0});
  },
  mw(v){
    if(v === null || v === undefined || isNaN(v)) return "—";
    return v >= 1000 ? (v/1000).toFixed(v >= 10000 ? 0 : 2).replace(/\.00$/, "") + " GW"
                     : U.num(v) + " MW";
  },
  eur(m){   // input in millions of EUR
    if(m === null || m === undefined || isNaN(m)) return "—";
    return m >= 1000 ? "€" + (m/1000).toFixed(m >= 10000 ? 0 : 1).replace(/\.0$/, "") + "bn"
                     : "€" + U.num(m) + "M";
  },
  date(s){
    if(!s) return "";
    const d = new Date(String(s).slice(0, 10));
    if(isNaN(d)) return String(s).slice(0, 10);
    return d.toLocaleDateString("en-GB", {day: "numeric", month: "short", year: "numeric"});
  },
  ago(s){
    if(!s) return "";
    const d = new Date(String(s).length <= 10 ? String(s) + "T12:00:00Z" : s);
    if(isNaN(d)) return "";
    const days = Math.floor((Date.now() - d.getTime())/864e5);
    if(days < 0) return "today";
    if(days === 0) return "today";
    if(days === 1) return "yesterday";
    if(days < 30) return days + "d ago";
    if(days < 365) return Math.floor(days/30) + "mo ago";
    return Math.floor(days/365) + "y ago";
  },
  titleCase(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; },
  /* some seed rows stored prose in the operator field ("AWS Aragon region; PIGA expansion
     approved 2026, ~30 buildings planned"). Clip for display; the full text stays in the title. */
  clip(s, n){
    s = String(s || "");
    return s.length > (n || 42) ? s.slice(0, (n || 42) - 1).trimEnd() + "…" : s;
  },
  debounce(fn, ms){
    let t; return function(){ clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms || 180); };
  },
};

/* --------------------------- knowledge base ---------------------------- */
const STATUS = {
  operating:    {label: "Operating",    color: "var(--st-operating)",    rank: 4},
  construction: {label: "Construction", color: "var(--st-construction)", rank: 3},
  permit:       {label: "Permitted",    color: "var(--st-announced)",    rank: 2},
  announced:    {label: "Announced",    color: "var(--st-announced)",    rank: 1},
  land:         {label: "Land secured", color: "var(--st-land)",         rank: 1},
  cancelled:    {label: "Cancelled",    color: "var(--st-cancelled)",    rank: 0},
};
const STATUS_ORDER = ["operating", "construction", "permit", "announced", "land", "cancelled"];

const KB = {
  raw: null, schema: 1, projects: [], news: [], runs: [], changelog: [], reviewQueue: [],
  duplicates: [], counts: {}, generated: null, loaded: false,

  load(payload){
    this.raw = payload || null;
    this.loaded = !!payload;
    if(!payload) return this;
    this.schema    = payload.schema || 1;
    this.generated = payload.generated || null;
    this.counts    = payload.counts || {};
    this.runs      = payload.runs || [];
    this.changelog = payload.changelog || [];
    this.reviewQueue = payload.review_queue || [];
    this.duplicates  = payload.duplicates || [];
    this.news      = (payload.news_feed || []).map(n => ({
      date: n.date, title: n.title, url: U.safeUrl(n.url), source: n.source,
      tier: n.tier || null, event: n.event, summary: n.summary, project: n.project,
    }));
    this.projects = (payload.projects || []).map(p => this._norm(p));
    return this;
  },

  /* one shape for the UI regardless of whether the pipeline emitted v1 or v2 */
  _norm(p){
    const f = p.fields || null;
    return {
      id: p.id || null,
      name: p.name || "—",
      lat: p.lat, lon: p.lon,
      region: p.region || null,
      status: p.status || null,
      review: !!p.review,
      updated: p.updated || null,
      src: p.src || null,
      fields: f,
      company: this._val(f, "company", p.company),
      mw:      this._val(f, "mw", p.mw),
      inv:     this._val(f, "investment_eur_m", p.inv),
      news:    (p.news || []).map(n => ({...n, url: U.safeUrl(n.url)})),
      changes: p.changes || [],
    };
  },
  _val(fields, attr, fallback){
    if(fields && fields[attr] && fields[attr].value !== undefined && fields[attr].value !== null)
      return fields[attr].value;
    return (fallback === undefined ? null : fallback);
  },

  /* full provenance record for an attribute, or a thin legacy shim */
  field(p, attr){
    if(p.fields && p.fields[attr]) return p.fields[attr];
    const legacy = attr === "investment_eur_m" ? p.inv : p[attr];
    if(legacy === null || legacy === undefined) return null;
    return {value: legacy, confidence: null, status: "legacy", range: null,
            n_sources: null, sources: [], alternatives: []};
  },

  statusMeta(s){ return STATUS[s] || {label: U.titleCase(s || "unknown"), color: "var(--dim)", rank: 0}; },

  byStatus(){
    const out = {};
    for(const s of STATUS_ORDER) out[s] = 0;
    for(const p of this.projects){ if(p.status) out[p.status] = (out[p.status] || 0) + 1; }
    return out;
  },

  totals(){
    const withMW  = this.projects.filter(p => p.mw > 0);
    const withInv = this.projects.filter(p => p.inv > 0);
    return {
      projects: this.projects.length,
      mw:  withMW.reduce((a, p) => a + p.mw, 0),
      nMW: withMW.length,
      inv: withInv.reduce((a, p) => a + p.inv, 0),
      nInv: withInv.length,
      review: this.projects.filter(p => p.review).length,
      /* pipeline = everything not yet operating (the forward-looking number) */
      pipelineMW: withMW.filter(p => p.status !== "operating" && p.status !== "cancelled")
                        .reduce((a, p) => a + p.mw, 0),
    };
  },

  /* every source URL backing a project, deduped — used by the provenance panel */
  allSources(p){
    const seen = new Map();
    for(const n of (p.news || [])) if(n.url) seen.set(n.url, {url: n.url, source: n.source, date: n.date, tier: n.tier});
    if(p.fields) for(const k in p.fields)
      for(const s of (p.fields[k].sources || []))
        if(s.url && !seen.has(s.url)) seen.set(s.url, {url: U.safeUrl(s.url), source: U.host(s.url), date: s.date, tier: s.tier});
    return [...seen.values()].filter(s => s.url).sort((a, b) => String(b.date||"").localeCompare(String(a.date||"")));
  },
};

/* ---------------------------- components ------------------------------- */
const C = {
  badge(status){
    const m = KB.statusMeta(status);
    return `<span class="badge" style="background:color-mix(in srgb, ${m.color} 16%, transparent);color:${m.color}">${U.esc(m.label)}</span>`;
  },
  dot(status){
    return `<span class="dot" style="background:${KB.statusMeta(status).color}"></span>`;
  },
  tier(t){
    if(!t) return "";
    return `<span class="tier tier-${U.esc(t)}">${U.esc(t)}</span>`;
  },

  /* confidence: bar + plain-language state. Legacy (v1) data shows nothing rather
     than a fake certainty score. */
  conf(f){
    if(!f || f.status === "legacy") return "";
    const c = f.confidence;
    const map = {locked: ["var(--conf-locked)", "pinned"], contested: ["var(--conf-low)", "contested"],
                 stable: ["var(--conf-high)", "corroborated"], single: ["var(--conf-med)", "single source"],
                 ratcheted: ["var(--conf-high)", "confirmed"]};
    const [col, lbl] = map[f.status] || ["var(--dim)", f.status || ""];
    const pct = c === null || c === undefined ? 100 : Math.round(c * 100);
    return `<span class="conf" title="${U.esc(lbl)}${f.n_sources ? ` · ${f.n_sources} source(s)` : ""}">
      <span class="conf-bar"><i style="width:${pct}%;background:${col}"></i></span>
      <span style="color:${col}">${U.esc(lbl)}</span></span>`;
  },

  /* a headline number with its disagreement range — the anti-flip-flop display */
  value(f, fmt){
    if(!f || f.value === null || f.value === undefined) return `<span class="muted">—</span>`;
    const v = fmt ? fmt(f.value) : U.esc(f.value);
    const r = f.range && f.range[0] !== f.range[1]
      ? `<span class="range" title="sources disagree — full reported range">${fmt ? fmt(f.range[0]) : f.range[0]}–${fmt ? fmt(f.range[1]) : f.range[1]}</span>` : "";
    return `${v}${r ? " " + r : ""}`;
  },

  /* the "where did this come from" block */
  sources(f, label){
    if(!f || !f.sources || !f.sources.length) return "";
    const rows = f.sources.map(s => {
      const u = U.safeUrl(s.url);
      if(!u) return "";
      return `<div class="src-meta"><a href="${u}" target="_blank" rel="noopener">${U.esc(U.host(u))} ↗</a>
        ${C.tier(s.tier)}<span>${U.esc(U.date(s.date))}</span></div>`;
    }).join("");
    const alt = (f.alternatives || []).length
      ? `<div class="src-meta" style="margin-top:4px">also reported: ${
          f.alternatives.map(a => `${U.esc(a.value)}${a.n > 1 ? ` (×${a.n})` : ""}`).join(", ")}</div>`
      : "";
    return `<div style="margin-top:5px">${label ? `<div class="src-meta" style="margin-bottom:2px">${U.esc(label)}</div>` : ""}${rows}${alt}</div>`;
  },

  empty(icon, title, msg){
    return `<div class="empty"><span class="empty-ico">${icon}</span><b>${U.esc(title)}</b>${U.esc(msg || "")}</div>`;
  },

  /* horizontal bar list — one visual idiom reused by every analytics block */
  bars(rows, opts){
    opts = opts || {};
    const max = Math.max(...rows.map(r => r.v), 1);
    return `<div class="bars">${rows.map(r => `
      <div class="bar-row">
        <span class="bar-lb" title="${U.esc(r.label)}">${U.esc(r.label)}</span>
        <span class="bar-tr"><i class="bar-fi" style="width:${(r.v/max*100).toFixed(1)}%;background:${r.color || "var(--accent)"}"></i></span>
        <span class="bar-vl">${r.display !== undefined ? U.esc(r.display) : U.num(r.v)}</span>
      </div>`).join("")}</div>`;
  },

  kv(rows){
    return `<table class="kv">${rows.filter(Boolean).map(([k, v, wrap]) =>
      `<tr><td>${k}</td><td class="${wrap ? "wrap-cell" : ""}">${v}</td></tr>`).join("")}</table>`;
  },
};

/* ------------------------------ KPI strip ------------------------------ */
function renderKPIs(){
  const el = document.getElementById("kpis");
  const stamp = document.getElementById("stamp");
  if(!el) return;
  if(!KB.loaded){
    el.innerHTML = `<div class="kpi"><div class="kpi-v muted">Offline</div>
      <div class="kpi-l">knowledge base not loaded</div></div>`;
    if(stamp) stamp.innerHTML = `<span class="muted">baked data only</span>`;
    return;
  }
  const t = KB.totals(), by = KB.byStatus();
  const seg = STATUS_ORDER.filter(s => by[s]).map(s =>
    `<span class="kpi-seg" title="${U.esc(KB.statusMeta(s).label)}">
       <span class="kpi-dot" style="background:${KB.statusMeta(s).color}"></span>${by[s]}</span>`).join("");

  el.innerHTML = `
    <div class="kpi"><div class="kpi-v">${U.num(t.projects)}</div>
      <div class="kpi-l">Tracked projects</div></div>
    <div class="kpi"><div class="kpi-v">${U.mw(t.mw)}</div>
      <div class="kpi-l">Disclosed capacity</div>
      <div class="kpi-sub">${t.nMW} of ${t.projects} disclose</div></div>
    <div class="kpi kpi-opt"><div class="kpi-v">${U.eur(t.inv)}</div>
      <div class="kpi-l">Announced capital</div>
      <div class="kpi-sub">${t.nInv} of ${t.projects} disclose</div></div>
    <div class="kpi kpi-opt"><div class="kpi-v">${U.mw(t.pipelineMW)}</div>
      <div class="kpi-l">Pre-operational</div>
      <div class="kpi-sub">not yet live</div></div>
    <div class="kpi"><div class="kpi-split" style="margin-top:2px">${seg}</div>
      <div class="kpi-l" style="margin-top:3px">Pipeline by stage</div></div>`;

  if(stamp){
    const d = KB.generated;
    const obs = KB.counts.observations || 0;   // absent on legacy v1 payloads — don't show "0"
    stamp.innerHTML = `<div>Knowledge base <b>${U.esc(U.ago(d))}</b></div>
      <div>${U.esc(U.date(d))}${obs ? ` · ${U.num(obs)} observations` : ""}</div>`;
  }
}

/* ------------------------------- router -------------------------------- */
const Router = {
  current: "map",
  views: {},          // name -> render fn (registered by views.js)
  rendered: {},

  init(){
    document.querySelectorAll(".nav").forEach(b => {
      b.onclick = () => Router.go(b.dataset.view);
    });
    const initial = (location.hash.match(/view=(\w+)/) || [])[1];
    if(initial && document.getElementById("v-" + initial)) this.go(initial, true);
  },

  go(name, silent){
    if(!document.getElementById("v-" + name)) return;
    this.current = name;
    document.querySelectorAll(".nav").forEach(b => b.classList.toggle("on", b.dataset.view === name));
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === "v-" + name));
    // render on first visit, and re-render data views so they pick up fresh state
    const fn = this.views[name];
    if(fn && (!this.rendered[name] || name !== "map")){ fn(); this.rendered[name] = true; }
    if(name === "map" && window.map) setTimeout(() => window.map.invalidateSize(), 60);
    if(!silent) this.syncHash();
  },

  /* app.js owns the hash (it also encodes the siting-model state) and appends the
     view token, so a shared link restores both the model config and the open view. */
  syncHash(){ if(window.saveHash) window.saveHash(); },

  badge(name, n){
    const b = document.querySelector(`.nav[data-view="${name}"]`);
    if(!b) return;
    b.querySelector(".nav-badge")?.remove();
    if(n > 0){
      const s = document.createElement("span");
      s.className = "nav-badge"; s.textContent = n > 99 ? "99+" : n;
      b.appendChild(s);
    }
  },
};
