/* ============================================================================
   views.js — Projects, Intelligence, Analytics and Audit.
   Every view reads the same normalised KB, so v1 and v2 payloads both render.
   Charts are hand-rolled (no chart library, no external requests).
   ========================================================================= */
"use strict";

const EVENT_META = {
  land_purchase:     {ico: "🟪", label: "Land purchase"},
  announcement:      {ico: "📣", label: "Announcement"},
  permit:            {ico: "📋", label: "Permit"},
  construction_start:{ico: "🏗", label: "Construction"},
  operational:       {ico: "🟢", label: "Operational"},
  expansion:         {ico: "➕", label: "Expansion"},
  deal:              {ico: "🤝", label: "Deal"},
  cancelled:         {ico: "❌", label: "Cancelled"},
  enrichment:        {ico: "🔎", label: "Enrichment"},
};
const ev = e => EVENT_META[e] || {ico: "•", label: U.titleCase(e || "update")};

/* ------------------------------------------------------------------ charts */
const Chart = {
  /* Column chart over time. One series → one hue, no legend (the title names it).
     Hover tooltip per column; y-grid recessive; direct label only on the max. */
  columns(rows, opts){
    opts = opts || {};
    if(!rows.length) return C.empty("📊", "No data yet", "");
    const W = opts.width || 680, H = opts.height || 170, P = {t: 14, r: 10, b: 26, l: 34};
    const max = Math.max(...rows.map(r => r.v), 1);
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const bw = Math.max(3, Math.min(38, iw/rows.length - 4));
    const ticks = [0, max/2, max].map(v => Math.round(v));
    const grid = [...new Set(ticks)].map(v => {
      const y = P.t + ih - (v/max)*ih;
      return `<line x1="${P.l}" y1="${y}" x2="${W-P.r}" y2="${y}" stroke="var(--line-soft)" stroke-width="1"/>
              <text x="${P.l-6}" y="${y+3}" text-anchor="end" font-size="9" fill="var(--faint)">${U.esc(opts.fmtTick ? opts.fmtTick(v) : v)}</text>`;
    }).join("");
    const bars = rows.map((r, i) => {
      const x = P.l + (i + 0.5) * (iw/rows.length) - bw/2;
      const h = Math.max(r.v > 0 ? 2 : 0, (r.v/max)*ih);
      const y = P.t + ih - h;
      const isMax = r.v === max;
      return `<g><title>${U.esc(r.label)}: ${U.esc(r.display !== undefined ? r.display : r.v)}</title>
        <rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="3"
              fill="${opts.color || "var(--accent)"}" opacity="${isMax ? 1 : .78}"/></g>`;
    }).join("");
    const step = Math.ceil(rows.length/8);
    const labels = rows.map((r, i) => (i % step === 0 || i === rows.length-1)
      ? `<text x="${P.l + (i+0.5)*(iw/rows.length)}" y="${H-8}" text-anchor="middle" font-size="10" fill="var(--dim)">${U.esc(r.short || r.label)}</text>` : "").join("");
    return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
      preserveAspectRatio="xMidYMid meet" role="img">${grid}${bars}${labels}</svg></div>`;
  },

  /* Stacked proportion bar — one row, segments separated by a 2px surface gap so
     adjacent fills never touch. Always paired with a labelled legend. */
  proportion(segs, total){
    if(!total) return "";
    let x = 0;
    const parts = segs.filter(s => s.v > 0).map(s => {
      const w = (s.v/total)*100, seg = `<div title="${U.esc(s.label)}: ${U.esc(s.display || s.v)}"
        style="position:absolute;left:${x}%;width:${w}%;top:0;bottom:0;background:${s.color};
        border-right:2px solid var(--panel-2)"></div>`;
      x += w; return seg;
    }).join("");
    return `<div style="position:relative;height:14px;border-radius:4px;overflow:hidden;background:var(--panel-3)">${parts}</div>
      <div class="legend">${segs.filter(s => s.v > 0).map(s =>
        `<span><span class="dot" style="background:${s.color}"></span>${U.esc(s.label)} <b class="tnum">${U.esc(s.display || s.v)}</b></span>`).join("")}</div>`;
  },
};

/* --------------------------------------------------------------- helpers */
function groupBy(items, keyFn){
  const m = new Map();
  for(const it of items){
    const k = keyFn(it) || "Unknown";
    if(!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}
function topN(map, valFn, n){
  return [...map.entries()].map(([k, v]) => ({key: k, items: v, v: valFn(v)}))
    .filter(r => r.v > 0).sort((a, b) => b.v - a.v).slice(0, n || 12);
}
function monthKey(s){ return s ? String(s).slice(0, 7) : null; }
function monthLabel(k){
  const [y, m] = k.split("-");
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m-1] + " " + y.slice(2);
}

/* ====================================================== PROJECTS view ==== */
const ProjectsView = {
  sort: {key: "mw", dir: -1},
  q: "", status: "all", only: "all",

  render(){
    const el = document.getElementById("projects-body");
    if(!KB.loaded){ el.innerHTML = C.empty("▦", "Knowledge base not loaded",
      "The tracker publishes dc_live.json; the map still works from baked data."); return; }

    const by = KB.byStatus();
    const chips = ["all", ...STATUS_ORDER.filter(s => by[s])].map(s =>
      `<button class="chip ${this.status===s?"on":""}" data-st="${s}">${
        s === "all" ? `All <b>${KB.projects.length}</b>` : `${U.esc(KB.statusMeta(s).label)} <b>${by[s]}</b>`}</button>`).join("");

    el.innerHTML = `
      <h1 class="title">Tracked projects</h1>
      <div class="subtitle">Every datacenter project in the knowledge base. Figures show the value the
        model currently believes, with the reported range where sources disagree. Click a row for the
        full dossier and its sources.</div>
      <div class="filters">
        <input type="search" class="grow" id="pq" placeholder="Search project, operator or region…" value="${U.esc(this.q)}">
        <select id="ponly" style="width:auto">
          <option value="all">All records</option>
          <option value="mw">Capacity disclosed</option>
          <option value="inv">Capital disclosed</option>
          <option value="news">Has news coverage</option>
          <option value="review">Needs review</option>
        </select>
      </div>
      <div class="filters">${chips}</div>
      <div id="ptable"></div>`;

    el.querySelector("#pq").oninput = U.debounce(e => { this.q = e.target.value; this.table(); }, 160);
    el.querySelector("#ponly").value = this.only;
    el.querySelector("#ponly").onchange = e => { this.only = e.target.value; this.table(); };
    el.querySelectorAll(".chip").forEach(c => c.onclick = () => {
      this.status = c.dataset.st;
      el.querySelectorAll(".chip").forEach(x => x.classList.toggle("on", x === c));
      this.table();
    });
    this.table();
  },

  rows(){
    const q = this.q.toLowerCase().trim();
    return KB.projects.filter(p => {
      if(this.status !== "all" && p.status !== this.status) return false;
      if(this.only === "mw" && !(p.mw > 0)) return false;
      if(this.only === "inv" && !(p.inv > 0)) return false;
      if(this.only === "news" && !(p.news || []).length) return false;
      if(this.only === "review" && !p.review) return false;
      if(q){
        const hay = `${p.name} ${p.company || ""} ${p.region || ""}`.toLowerCase();
        if(!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => {
      const k = this.sort.key, d = this.sort.dir;
      if(k === "name" || k === "company" || k === "region")
        return d * String(a[k] || "").localeCompare(String(b[k] || ""));
      if(k === "status") return d * (KB.statusMeta(a.status).rank - KB.statusMeta(b.status).rank);
      if(k === "news")   return d * ((a.news||[]).length - (b.news||[]).length);
      if(k === "updated")return d * String(a.updated || "").localeCompare(String(b.updated || ""));
      const av = a[k], bv = b[k];
      if(av === null || av === undefined) return 1;      // unknowns always sink
      if(bv === null || bv === undefined) return -1;
      return d * (av - bv);
    });
  },

  table(){
    const rows = this.rows();
    const cols = [["name","Project"],["company","Operator"],["region","Region"],["status","Stage"],
                  ["mw","Capacity"],["inv","Capital"],["news","Sources"],["updated","Updated"]];
    const head = cols.map(([k, l]) =>
      `<th class="sortable ${k==="mw"||k==="inv"||k==="news"?"num":""}" data-k="${k}">${l}${
        this.sort.key===k ? `<span class="arrow">${this.sort.dir<0?"▾":"▴"}</span>` : ""}</th>`).join("");

    const body = rows.map(p => {
      const fmw = KB.field(p, "mw"), finv = KB.field(p, "investment_eur_m");
      return `<tr data-id="${U.esc(p.id || p.name)}">
        <td><div class="nm">${U.esc(p.name)}${p.review ? ` <span class="badge badge-warn" style="font-size:9px">review</span>` : ""}</div>
            ${p.region ? `<div class="sub">${U.esc(p.region)}</div>` : ""}</td>
        <td title="${U.esc(p.company || "")}">${U.esc(U.clip(p.company, 38) || "—")}</td>
        <td>${U.esc(p.region || "—")}</td>
        <td>${p.status ? C.badge(p.status) : "—"}</td>
        <td class="num">${C.value(fmw, U.mw)}</td>
        <td class="num">${C.value(finv, U.eur)}</td>
        <td class="num">${(p.news||[]).length || "—"}</td>
        <td class="num"><span class="muted">${U.esc(U.ago(p.updated))}</span></td>
      </tr>`;
    }).join("");

    document.getElementById("ptable").innerHTML = rows.length
      ? `<div class="count" style="margin-bottom:6px">${rows.length} project${rows.length===1?"":"s"}</div>
         <table class="dt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
      : C.empty("🔍", "No projects match", "Try clearing the filters or search.");

    document.querySelectorAll("#ptable th.sortable").forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      this.sort = {key: k, dir: this.sort.key === k ? -this.sort.dir : (k === "name" || k === "company" || k === "region" ? 1 : -1)};
      this.table();
    });
    document.querySelectorAll("#ptable tbody tr").forEach(tr => tr.onclick = () => {
      if(window.Bridge) window.Bridge.openProject(tr.dataset.id);
    });
  },
};

/* ================================================== INTELLIGENCE view ==== */
const IntelView = {
  q: "", event: "all", limit: 60,

  render(){
    const el = document.getElementById("intel-body");
    if(!KB.loaded || !KB.news.length){
      el.innerHTML = `<h1 class="title">Intelligence feed</h1>
        <div class="subtitle">Articles the pipeline has ingested, linked to the projects they affect.</div>
        ${C.empty("📰", "Nothing ingested yet", "The daily watch populates this feed at 12:15 UTC.")}`;
      return;
    }
    const counts = {};
    for(const n of KB.news) counts[n.event] = (counts[n.event] || 0) + 1;
    const chips = ["all", ...Object.keys(counts).sort((a,b) => counts[b]-counts[a])].map(e =>
      `<button class="chip ${this.event===e?"on":""}" data-ev="${U.esc(e)}">${
        e === "all" ? `All <b>${KB.news.length}</b>` : `${ev(e).ico} ${U.esc(ev(e).label)} <b>${counts[e]}</b>`}</button>`).join("");

    el.innerHTML = `
      <h1 class="title">Intelligence feed</h1>
      <div class="subtitle">Every article the pipeline ingested, with its outlet, reliability tier and the
        project it was attributed to. This is the evidence base behind the numbers.</div>
      <div class="filters"><input type="search" class="grow" id="iq"
        placeholder="Search headline, outlet or project…" value="${U.esc(this.q)}"></div>
      <div class="filters">${chips}</div>
      <div id="ifeed"></div>`;

    el.querySelector("#iq").oninput = U.debounce(e => { this.q = e.target.value; this.feed(); }, 160);
    el.querySelectorAll(".chip").forEach(c => c.onclick = () => {
      this.event = c.dataset.ev;
      el.querySelectorAll(".chip").forEach(x => x.classList.toggle("on", x === c));
      this.feed();
    });
    this.feed();
  },

  feed(){
    const q = this.q.toLowerCase().trim();
    const items = KB.news.filter(n => {
      if(this.event !== "all" && n.event !== this.event) return false;
      if(q && !`${n.title} ${n.source||""} ${n.project||""}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const shown = items.slice(0, this.limit);
    const html = shown.map(n => `
      <div class="card" style="margin-bottom:8px">
        <div class="src-meta" style="margin-bottom:3px">
          <span>${ev(n.event).ico} ${U.esc(ev(n.event).label)}</span>
          ${n.date ? `<span>· ${U.esc(U.date(n.date))}</span>` : ""}
          ${n.source ? `<span>· ${U.esc(n.source)}</span>` : ""}
          ${C.tier(n.tier)}
          ${n.project ? `<span>· <b class="hl">${U.esc(n.project)}</b></span>` : ""}
        </div>
        ${n.url ? `<a href="${n.url}" target="_blank" rel="noopener" style="font-size:12.5px;font-weight:550">${U.esc(n.title)} ↗</a>`
                : `<span style="font-size:12.5px;font-weight:550">${U.esc(n.title)}</span>`}
        ${n.summary ? `<div style="font-size:11.5px;color:var(--text-2);margin-top:4px;line-height:1.5">${U.esc(n.summary)}</div>` : ""}
      </div>`).join("");

    document.getElementById("ifeed").innerHTML = items.length
      ? `<div class="count" style="margin-bottom:6px">${items.length} article${items.length===1?"":"s"}</div>${html}` +
        (items.length > shown.length
          ? `<button class="btn btn-full" id="imore">Show ${Math.min(60, items.length-shown.length)} more</button>` : "")
      : C.empty("🔍", "No articles match", "Try a different filter or search term.");

    const more = document.getElementById("imore");
    if(more) more.onclick = () => { this.limit += 60; this.feed(); };
  },
};

/* ===================================================== ANALYTICS view ==== */
const AnalyticsView = {
  render(){
    const el = document.getElementById("analytics-body");
    if(!KB.loaded){ el.innerHTML = C.empty("📊", "Knowledge base not loaded", ""); return; }
    const P = KB.projects, t = KB.totals(), by = KB.byStatus();

    /* ---- pipeline by stage: counts and the capacity behind them ---- */
    const stageRows = STATUS_ORDER.filter(s => by[s]).map(s => {
      const items = P.filter(p => p.status === s);
      const mw = items.filter(p => p.mw > 0).reduce((a, p) => a + p.mw, 0);
      return {label: KB.statusMeta(s).label, v: items.length, color: KB.statusMeta(s).color,
              display: `${items.length}${mw ? ` · ${U.mw(mw)}` : ""}`};
    });

    /* ---- geography ---- */
    const byRegion = groupBy(P.filter(p => p.region), p => p.region);
    const regionMW = topN(byRegion, its => its.filter(p => p.mw > 0).reduce((a, p) => a + p.mw, 0), 12)
      .map(r => ({label: r.key, v: r.v, display: U.mw(r.v)}));
    const regionCount = topN(byRegion, its => its.length, 12)
      .map(r => ({label: r.key, v: r.v, display: String(r.v)}));

    /* ---- operators ---- */
    const byCo = groupBy(P.filter(p => p.company), p => p.company);
    const coCount = topN(byCo, its => its.length, 12).map(r => ({
      label: r.key, v: r.v,
      display: `${r.v}${(() => { const mw = r.items.filter(p=>p.mw>0).reduce((a,p)=>a+p.mw,0); return mw ? ` · ${U.mw(mw)}` : ""; })()}`}));

    /* ---- biggest disclosed projects ---- */
    const bigMW = P.filter(p => p.mw > 0).sort((a,b) => b.mw - a.mw).slice(0, 10)
      .map(p => ({label: p.name, v: p.mw, display: U.mw(p.mw), color: KB.statusMeta(p.status).color}));
    const bigInv = P.filter(p => p.inv > 0).sort((a,b) => b.inv - a.inv).slice(0, 10)
      .map(p => ({label: p.name, v: p.inv, display: U.eur(p.inv), color: KB.statusMeta(p.status).color}));

    /* ---- news volume over time (the market's attention curve) ---- */
    const newsByMonth = new Map();
    for(const n of KB.news){ const k = monthKey(n.date); if(k) newsByMonth.set(k, (newsByMonth.get(k)||0)+1); }
    const months = [...newsByMonth.keys()].sort().slice(-18);
    const newsCols = months.map(k => ({label: monthLabel(k), short: monthLabel(k), v: newsByMonth.get(k)}));

    /* ---- disclosure coverage: honest about what we don't know ---- */
    const cov = [
      {label: "Stage",      n: P.filter(p => p.status).length},
      {label: "Operator",   n: P.filter(p => p.company).length},
      {label: "Region",     n: P.filter(p => p.region).length},
      {label: "Capacity",   n: t.nMW},
      {label: "Capital",    n: t.nInv},
      {label: "News trail", n: P.filter(p => (p.news||[]).length).length},
    ].map(r => ({label: r.label, v: r.n, display: `${Math.round(r.n/Math.max(P.length,1)*100)}%`,
                 color: r.n/P.length > .66 ? "var(--good)" : r.n/P.length > .33 ? "var(--accent)" : "var(--conf-low)"}));

    el.innerHTML = `
      <h1 class="title">Analytics</h1>
      <div class="subtitle">Aggregates across the tracked pipeline. Capacity and capital totals cover only
        the projects that disclose them — the coverage panel makes that explicit rather than implying
        the whole market is measured.</div>

      <div class="stats" style="margin-bottom:16px">
        <div class="stat"><div class="stat-v">${U.num(t.projects)}</div><div class="stat-l">Projects tracked</div></div>
        <div class="stat"><div class="stat-v">${U.mw(t.mw)}</div><div class="stat-l">Disclosed capacity</div>
          <div class="stat-s">across ${t.nMW} projects</div></div>
        <div class="stat"><div class="stat-v">${U.eur(t.inv)}</div><div class="stat-l">Announced capital</div>
          <div class="stat-s">across ${t.nInv} projects</div></div>
        <div class="stat"><div class="stat-v">${U.mw(t.pipelineMW)}</div><div class="stat-l">Pre-operational capacity</div>
          <div class="stat-s">announced, land or under construction</div></div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px">
        <div class="chart">
          <div class="chart-t">Pipeline by stage</div>
          <div class="chart-s">Projects per lifecycle stage, with disclosed capacity behind each</div>
          ${C.bars(stageRows)}
        </div>
        <div class="chart">
          <div class="chart-t">Disclosure coverage</div>
          <div class="chart-s">Share of the ${P.length} tracked projects with each attribute known</div>
          ${C.bars(cov)}
        </div>
        <div class="chart">
          <div class="chart-t">Capacity by region</div>
          <div class="chart-s">Sum of disclosed MW — regions with no disclosed capacity are omitted</div>
          ${regionMW.length ? C.bars(regionMW) : C.empty("—", "No capacity disclosed by region", "")}
        </div>
        <div class="chart">
          <div class="chart-t">Projects by region</div>
          <div class="chart-s">Count of tracked projects</div>
          ${regionCount.length ? C.bars(regionCount) : C.empty("—", "No regions recorded", "")}
        </div>
        <div class="chart">
          <div class="chart-t">Most active operators</div>
          <div class="chart-s">Projects per operator, with disclosed capacity</div>
          ${coCount.length ? C.bars(coCount) : C.empty("—", "No operators recorded", "")}
        </div>
        <div class="chart">
          <div class="chart-t">Largest projects by capacity</div>
          <div class="chart-s">Bar colour shows lifecycle stage</div>
          ${bigMW.length ? C.bars(bigMW) : C.empty("—", "No capacity disclosed", "")}
        </div>
        <div class="chart">
          <div class="chart-t">Largest projects by announced capital</div>
          <div class="chart-s">Bar colour shows lifecycle stage</div>
          ${bigInv.length ? C.bars(bigInv) : C.empty("—", "No capital disclosed", "")}
        </div>
        <div class="chart">
          <div class="chart-t">Media attention over time</div>
          <div class="chart-s">Articles ingested per month — a proxy for market momentum</div>
          ${newsCols.length ? Chart.columns(newsCols, {height: 160}) : C.empty("—", "No dated articles yet", "")}
        </div>
      </div>

      <div class="foot">Capacity is IT/announced MW as reported by sources; where reports disagree the model
        adopts the best-supported figure and retains the full range (visible per project). Operators are as
        named in sources and are not normalised to legal entities.</div>`;
  },
};

/* ======================================================= AUDIT view ====== */
const AuditView = {
  render(){
    const el = document.getElementById("audit-body");
    if(!KB.loaded){ el.innerHTML = C.empty("🛡", "Knowledge base not loaded", ""); return; }
    const P = KB.projects;
    const runs = KB.runs || [], log = KB.changelog || [], queue = KB.reviewQueue || [];
    const schemaV2 = KB.schema >= 2;

    /* provenance strength across the base */
    const withSrc = P.filter(p => (p.news||[]).length).length;
    const contested = [];
    if(schemaV2) for(const p of P) for(const k in (p.fields||{}))
      if(p.fields[k].status === "contested") contested.push({p, k, f: p.fields[k]});

    const runRows = runs.slice(0, 14).map(r => `
      <tr><td><span class="badge badge-mute">${U.esc(r.type || "run")}</span></td>
        <td class="mono" style="color:var(--dim)">${U.esc(r.run_id || "")}</td>
        <td class="num">${r.new || 0}</td><td class="num">${r.changed || 0}</td>
        <td class="num">${r.enriched || 0}</td>
        <td class="num muted">${U.esc(U.ago(r.at))}</td></tr>`).join("");

    const logRows = log.slice(0, 50).map(c => {
      const url = U.safeUrl(c.url);
      const act = {create: "created", update: "updated", enrich: "enriched", status: "stage change",
                   review: "flagged for review", conflict: "conflict (not applied)",
                   human_edit: "human edit", merge: "merged"}[c.action] || c.action;
      return `<div class="tl-i ${c.action==="create"||c.action==="human_edit"?"hi":""}">
        <div class="tl-d">${U.esc(U.date(c.ts))} · ${U.esc(act)}${c.run ? ` · <span class="mono">${U.esc(c.run)}</span>` : ""}</div>
        <div style="font-size:11.5px">
          <b>${U.esc(c.name || c.entity || "—")}</b>
          ${c.field ? ` · ${U.esc(U.fieldLabel(c.field))}: <span class="muted">${U.esc(U.fieldValue(c.field, c.old))}</span> → <b class="hl">${U.esc(U.fieldValue(c.field, c.new))}</b>` : ""}
          ${url ? ` · <a href="${url}" target="_blank" rel="noopener">source ↗</a>` : ""}
        </div>
        ${c.note ? `<div style="font-size:10.5px;color:var(--faint)">${U.esc(c.note)}</div>` : ""}
      </div>`;
    }).join("");

    el.innerHTML = `
      <h1 class="title">Audit &amp; data quality</h1>
      <div class="subtitle">How this knowledge base is maintained: what ran, what changed, what is
        disputed, and what still needs a human decision. Nothing here is generated for display — it is
        the pipeline's own record.</div>

      <div class="stats" style="margin-bottom:16px">
        <div class="stat"><div class="stat-v">${U.num(KB.counts.observations || 0)}</div>
          <div class="stat-l">Observations</div><div class="stat-s">append-only source claims</div></div>
        <div class="stat"><div class="stat-v">${U.num(KB.counts.changes || log.length)}</div>
          <div class="stat-l">Logged changes</div><div class="stat-s">every edit is attributable</div></div>
        <div class="stat"><div class="stat-v">${U.num(withSrc)}</div>
          <div class="stat-l">Projects with sources</div>
          <div class="stat-s">${Math.round(withSrc/Math.max(P.length,1)*100)}% of the base</div></div>
        <div class="stat"><div class="stat-v" style="color:${queue.length?"var(--warn)":"var(--good)"}">${U.num(queue.length || KB.totals().review)}</div>
          <div class="stat-l">Awaiting review</div><div class="stat-s">flagged, never auto-merged</div></div>
      </div>

      ${!schemaV2 ? `<div class="card" style="border-color:rgba(245,184,61,.3);margin-bottom:14px">
        <div class="card-t">⚠ Legacy payload</div>
        <div style="font-size:11.5px;color:var(--text-2)">This page is reading a v1 knowledge base, which
        stores one value per field with no per-fact provenance. Confidence, source lists and disputed-value
        tracking appear once the v2 pipeline publishes.</div></div>` : ""}

      ${queue.length ? `
        <div class="sec">Review queue<div class="sec-line"></div></div>
        <div class="subtitle" style="margin-bottom:8px">Auto-created records the resolver was not confident
          about. They are kept separate rather than silently merged into an existing project or silently
          duplicated.</div>
        ${queue.map(r => `<div class="card" style="margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
            <div><b style="font-size:12px">${U.esc(r.name)}</b>
              <div style="font-size:10.5px;color:var(--faint)">created ${U.esc(U.date(r.created))}</div></div>
            <span class="badge badge-warn">review</span></div>
          ${r.note ? `<div style="font-size:11px;color:var(--text-2);margin-top:5px">${U.esc(r.note)}</div>` : ""}
        </div>`).join("")}` : ""}

      ${contested.length ? `
        <div class="sec">Disputed figures<div class="sec-line"></div></div>
        <div class="subtitle" style="margin-bottom:8px">Where sources materially disagree, the model keeps
          every reported value and shows the range instead of flip-flopping between them.</div>
        ${contested.slice(0, 12).map(c => `<div class="card" style="margin-bottom:6px">
          <b style="font-size:12px">${U.esc(c.p.name)}</b> · <span class="muted">${U.esc(U.fieldLabel(c.k))}</span>
          <div style="margin-top:4px;font-size:12px">adopted <b class="hl">${U.esc(U.fieldValue(c.k, c.f.value))}</b>
            ${c.f.range ? `<span class="range">range ${U.esc(U.fieldValue(c.k, c.f.range[0]))}–${U.esc(U.fieldValue(c.k, c.f.range[1]))}</span>` : ""}
            ${C.conf(c.f)}</div>
          ${C.sources(c.f, "evidence")}
        </div>`).join("")}` : ""}

      ${(KB.duplicates || []).length ? `
        <div class="sec">Possible duplicates<div class="sec-line"></div>
          <span class="muted" style="text-transform:none;letter-spacing:0">${KB.duplicates.length} pairs</span></div>
        <div class="subtitle" style="margin-bottom:8px">Records that look like the same physical site under
          different names. Flagged for a human decision and never merged automatically — some near-identical
          pairs are genuinely separate phases of one campus.</div>
        ${KB.duplicates.slice(0, 14).map(p => `
          <div class="card" style="margin-bottom:6px;display:flex;justify-content:space-between;gap:10px;align-items:center">
            <div style="min-width:0">
              <div style="font-size:12px"><b>${U.esc(p.a_name)}</b>
                <span class="muted">≈</span> <b>${U.esc(p.b_name)}</b></div>
              <div style="font-size:10.5px;color:var(--faint);margin-top:2px">${U.esc(p.why)}</div>
            </div>
            <span class="badge ${p.score >= 0.95 ? "badge-bad" : "badge-warn"}">${Math.round(p.score*100)}%</span>
          </div>`).join("")}` : ""}

      <div class="sec">Pipeline runs<div class="sec-line"></div></div>
      ${runs.length ? `<table class="dt"><thead><tr><th>Type</th><th>Run</th><th class="num">New</th>
        <th class="num">Changed</th><th class="num">Enriched</th><th class="num">When</th></tr></thead>
        <tbody>${runRows}</tbody></table>`
        : C.empty("—", "No run ledger yet", "The v2 pipeline records every run here.")}

      <div class="sec">Change history<div class="sec-line"></div></div>
      ${log.length ? `<div class="tl">${logRows}</div>`
        : C.empty("—", "No change history yet", "Every create, update and correction will appear here with its source.")}

      <div class="sec">Operator tools<div class="sec-line"></div></div>
      <div class="card">
        <div class="card-t">Run the pipeline now</div>
        <div style="font-size:11.5px;color:var(--text-2);margin-bottom:8px">Triggers an out-of-schedule
          ingestion on the collector, then reloads when fresh data is published (~2–4 min). Requires a
          repository token, which is stored only in this browser.</div>
        <button class="btn btn-full" id="trigbtn">⚡ Trigger ingestion</button>
        <div id="trigstat" style="font-size:10.5px;color:var(--dim);margin-top:6px"></div>
      </div>

      <div class="foot">Method: articles are ingested daily, resolved to a canonical project (alias → geography
        → name/operator similarity, with a model confirmation only for ambiguous cases), then written as
        append-only observations. Values are never overwritten: the displayed figure is derived from all
        observations weighted by source reliability, recency and corroboration, and only moves when the
        evidence for a new value overtakes the incumbent. Human corrections take precedence over the
        automated pipeline.</div>`;

    const tb = document.getElementById("trigbtn");
    if(tb) tb.onclick = triggerIngestion;
  },
};

/* Manual pipeline trigger — writes a trigger file the collector polls. The token lives only in
   this browser's localStorage and is never sent anywhere except GitHub's own API. */
async function triggerIngestion(){
  const stat = t => { const e = document.getElementById("trigstat"); if(e) e.textContent = t; };
  let tok = localStorage.getItem("gh_pat");
  if(!tok){
    tok = prompt("Repository token with Contents:write (stored only in this browser):");
    if(!tok) return;
    localStorage.setItem("gh_pat", tok.trim());
  }
  const repo = (KB.raw && KB.raw.repo) || localStorage.getItem("gh_repo");
  if(!repo){ stat("No repository configured in the knowledge base."); return; }
  const api = `https://api.github.com/repos/${repo}/contents/web/data/trigger.json`;
  const h = {"Authorization": `Bearer ${localStorage.getItem("gh_pat")}`,
             "Accept": "application/vnd.github+json"};
  try{
    stat("writing trigger…");
    let sha;
    const g = await fetch(api, {headers: h});
    if(g.ok) sha = (await g.json()).sha;
    const body = {message: "manual ingestion trigger",
                  content: btoa(JSON.stringify({requested: new Date().toISOString()}))};
    if(sha) body.sha = sha;
    const r = await fetch(api, {method: "PUT", headers: h, body: JSON.stringify(body)});
    if(!r.ok){
      stat(`GitHub error ${r.status} — token wrong or lacks Contents write`);
      if(r.status === 401 || r.status === 403) localStorage.removeItem("gh_pat");
      return;
    }
    stat("trigger written ✓ — waiting for fresh data…");
    const before = KB.generated;
    let tries = 0;
    const iv = setInterval(async () => {
      tries++;
      try{
        const lr = await fetch("data/dc_live.json?ts=" + Date.now());
        if(lr.ok){
          const fresh = await lr.json();
          if(fresh.generated !== before){
            clearInterval(iv);
            stat("✅ fresh data published — reloading…");
            setTimeout(() => location.reload(), 1200);
            return;
          }
        }
      }catch(e){}
      stat(`waiting for the collector… ${tries*20}s`);
      if(tries > 24){ clearInterval(iv); stat("no fresh data after 8 min — check the collector log"); }
    }, 20000);
  }catch(e){ stat("error: " + e); }
}

/* ------------------------------------------------------------- register */
function registerViews(){
  Router.views.projects  = () => ProjectsView.render();
  Router.views.intel     = () => IntelView.render();
  Router.views.analytics = () => AnalyticsView.render();
  Router.views.audit     = () => AuditView.render();
}
