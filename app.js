/* Iberian Datacenter Intelligence — map view + BYOP siting engine.
   The scoring/sizing model is unchanged; the UI layer is the platform shell.
   Loaded after ui.js (U/KB/C/Router) and views.js. */
"use strict";

const F = {LAT:0, LON:1, CCAA:2, EY:3, ELEV:4, RELIEF:5, FVALID:6, FMAX:7, FMUYALTA:8, FALTA:9, FMOD:10, FBAJA:11,
           DCITY:12, CITYI:13, DDC:14, DCI:15, ISAV:16, EOLV:17, EOLDEV:18, PATCH:19, WS:20, PRECIP:21, PVMW:22, DSUB:23};
/* Hex mirrors of the --st-* tokens (canvas/Leaflet need literal colours).
   Validated for colour-vision safety — see the note in styles.css before editing. */
const DC_COLORS = {operating:"#1fa579", construction:"#cc7f1a", permit:"#5182e0",
                   announced:"#5182e0", land:"#cf5fa0", cancelled:"#6b7280"};
const CELL_HA = 9400;
const PUE = 1.15, HA_PER_MWP = 2, HA_PER_WIND_MW = 5, BESS_H = {solar:10, hybrid:7};
// Editable screening assumptions (Assumptions panel writes here; refresh() recomputes everything).
const A = {
  pv: 0.55,        // M EUR / MWp installed (incl. BOS)
  bess: 0.20,      // M EUR / MWh (4h-class)
  wind: 1.15,      // M EUR / MW onshore
  backup: 0.45,    // M EUR / MW load (engines / fuel cells capex)
  wacc: 8,         // % discount rate
  years: 20,       // amortization horizon
  om: 1.8,         // % of capex / year O&M
  gas_e: 68,       // EUR / MWh_e fuel+variable cost of gas generation (~35 EUR/MWh_th at ~50% eff)
  gas_capex: 0.95, // M EUR / MW, pure gas-BYOP plant benchmark
  landx: 1.0,      // multiplier on regional land prices
};
const A_DEFAULT = {...A};
// Approx. rural (secano) land EUR/ha by CCAA — MAPA Encuesta de Precios de la Tierra ballparks, screening-grade.
const LAND_HA = {"01":12000,"02":8000,"03":12000,"04":60000,"06":18000,"07":6500,"08":7000,"09":25000,
                 "10":20000,"11":5000,"12":15000,"13":40000,"14":15000,"15":15000,"16":30000,"17":15000};
const CRF = () => { const w = A.wacc/100, n = A.years; return w*Math.pow(1+w,n)/(Math.pow(1+w,n)-1); };

const MODES = {
  gw:   {label:"1 GW solar", it:1000, mix:{pv:0.9, wind:0, backup:0.1},
         note:"Hyperscale campus, PV+BESS only. Land need computed from each cell's own yield; aggregates neighbouring cells (~30 km).",
         w:{solar:90, env:80, terrain:70, reg:85, city:-30, dc:20, wind:0, eolv:0, rain:0, pvx:0, grid:0}, gates:{relief:300, dev:0.35}},
  gwh:  {label:"1 GW hybrid", it:1000, mix:{pv:0.55, wind:0.35, backup:0.1},
         note:"PV + on-site wind. Wind firms winter/night supply and cuts battery + land; needs wind resource AND wind permitting headroom.",
         w:{solar:70, env:70, terrain:60, reg:85, city:-30, dc:20, wind:60, eolv:50, rain:0, pvx:0, grid:0}, gates:{relief:300, dev:0.35}},
  mw100:{label:"100 MW", it:100, mix:{pv:0.9, wind:0, backup:0.1},
         note:"Large single-site campus; fits inside one cell's developable land in most of the meseta.",
         w:{solar:80, env:70, terrain:60, reg:70, city:20, dc:30, wind:0, eolv:0, rain:0, pvx:0, grid:0}, gates:{relief:350, dev:0.15}},
  edge: {label:"10 MW edge", it:10, mix:{pv:0.9, wind:0, backup:0.1},
         note:"Regional/edge site; proximity to labour and fibre flips to a positive.",
         w:{solar:50, env:30, terrain:30, reg:40, city:80, dc:10, wind:0, eolv:0, rain:0, pvx:0, grid:0}, gates:{relief:500, dev:0.05}},
};

const clamp = v => Math.max(0, Math.min(1, v));
const devFrac = c => (c[F.FMOD]+c[F.FBAJA]) * c[F.FVALID];
const devHa = c => devFrac(c) * CELL_HA;
const windCF = ws50 => clamp(((ws50*1.13)-3.5)/9) * 0.48;  // crude hub-height extrapolation + linearized power curve

const LAYERS = [
  {k:"solar", label:"Solar yield", dual:false, hint:"PVGIS specific yield, optimal fixed tilt",
   fmt:c=>c[F.EY]+" kWh/kWp·yr", norm:c=>clamp((c[F.EY]-1250)/(1800-1250))},
  {k:"env", label:"Env. sensitivity (PV)", dual:false, hint:"MITECO continuous ISA value, 0–10 (10 = least sensitive)",
   fmt:c=>c[F.ISAV].toFixed(1)+"/10 · "+Math.round(devFrac(c)*100)+"% developable", norm:c=>c[F.ISAV]/10},
  {k:"terrain", label:"Buildable terrain", dual:false, hint:"Intra-cell elevation range (lower = flatter)",
   fmt:c=>c[F.RELIEF]+" m relief", norm:c=>1-clamp(c[F.RELIEF]/600)},
  {k:"reg", label:"Regulatory reception", dual:false, hint:"Per-region score from primary-source dossier",
   fmt:c=>REGIONS[c[F.CCAA]].score+"/100 · "+REGIONS[c[F.CCAA]].name, norm:c=>REGIONS[c[F.CCAA]].score/100},
  {k:"wind", label:"Wind resource", dual:false, hint:"NASA POWER 50 m mean wind (0.5° grid — screening only)",
   fmt:c=>c[F.WS]+" m/s · CF≈"+Math.round(windCF(c[F.WS])*100)+"%", norm:c=>clamp((c[F.WS]-4)/3.5)},
  {k:"eolv", label:"Env. sensitivity (wind)", dual:false, hint:"MITECO continuous wind ISA, 0–10 — wind permitting is tighter than PV",
   fmt:c=>c[F.EOLV].toFixed(1)+"/10 · "+Math.round(c[F.EOLDEV]*100)+"% developable", norm:c=>c[F.EOLV]/10},
  {k:"rain", label:"Rain (soiling relief)", dual:false, hint:"Annual precip. Second-order: rain cleans panels (~1–3% yield in dry areas); cloud impact is already inside PVGIS yield",
   fmt:c=>c[F.PRECIP]+" mm/yr", norm:c=>clamp((c[F.PRECIP]-250)/550)},
  {k:"city", label:"City proximity", dual:true, hint:"Labour/fibre (+) vs pushback exposure (−); negative weight prefers remote",
   fmt:c=>c[F.DCITY]+" km to "+DATA.cities[c[F.CITYI]][0], norm:c=>1-clamp(c[F.DCITY]/150)},
  {k:"dc", label:"DC cluster proximity", dual:true, hint:"Validated corridor (+) vs uncontested whitespace (−)",
   fmt:c=>c[F.DDC]+" km to "+DATA.dcs[c[F.DCI]][0], norm:c=>1-clamp(c[F.DDC]/250)},
  {k:"pvx", label:"Existing PV build-out", dual:true, hint:"OSM-mapped solar in cell: follow proven zones (+) or hunt whitespace (−)",
   fmt:c=>c[F.PVMW]+" MW mapped in cell", norm:c=>clamp(c[F.PVMW]/150)},
  {k:"grid", label:"HV grid optionality", dual:true, hint:"Distance to nearest 220/400 kV substation (OSM). BYOP needs no tie — but surplus export / plan-B tie is optionality. Default off: the thesis stays off-grid",
   fmt:c=>c[F.DSUB]+" km to 220/400 kV substation", norm:c=>1-clamp(c[F.DSUB]/80)},
];

let DATA, REGIONS, FARMS, DCJSON, SUBS, LIVE = null, map, canvasLayer, baseDark, baseSat, catWMS;
/* showFarms defaults OFF: 3,215 cyan dots visually outrank the datacenter projects, which are
   the subject of this map. It stays one click away as siting context. */
let state = {mode:"gw", w:{}, on:{}, gates:{}, view:"score", showCells:true, showFarms:false, showSubs:false};
let scores = [], pass = [], clusterHa = [], capex = [], capexDomain = [8,16],
    lcoe = [], lcoeDomain = [60,140], byKey = new Map();
let selected = -1, clickPt = null, muni = "";
let footLayer = null, footHandle = null, footOn = false;
let dcAll = [], dcGroups = {}, dcMarkers = new Map();

/* ============================ siting engine ============================= */
function sizing(mode, c){
  const it = mode.it, mix = mode.mix, load = it * PUE, E = load * 8760;   // MWh/yr delivered
  const mwp = E * mix.pv / c[F.EY];
  const cf = windCF(c[F.WS]);
  const windMW = mix.wind > 0 && cf > 0.05 ? E * mix.wind / (8760 * cf) : 0;
  const bess = load * (mix.wind > 0 ? BESS_H.hybrid : BESS_H.solar);
  const landEurHa = (LAND_HA[c[F.CCAA]] || 12000) * A.landx;
  const ha = mwp * HA_PER_MWP + windMW * HA_PER_WIND_MW + it * 0.03;
  const capexM = mwp*A.pv + windMW*A.wind + bess*A.bess + load*A.backup + ha*landEurHa/1e6;
  // LCOE of delivered energy: annualized capex + O&M + backup-share fuel
  const backupShare = Math.max(0, 1 - mix.pv - mix.wind);
  const annM = capexM * (CRF() + A.om/100);
  const lcoe = (annM * 1e6 + backupShare * E * A.gas_e) / E;
  // pure gas-BYOP benchmark at same load: gas capex + full-energy fuel (location-invariant)
  const gasLcoe = (load * A.gas_capex * (CRF() + A.om/100) * 1e6 + E * A.gas_e) / E;
  return {load, mwp, windMW, cf, bess, ha, capexM, perMW: capexM/it, lcoe, gasLcoe, landEurHa};
}

function computeScores(){
  const g = state.gates, m = MODES[state.mode];
  const refCell = []; refCell[F.EY] = 1750; refCell[F.WS] = 6;
  const needHa = sizing(m, refCell).ha;
  pass = DATA.cells.map(c =>
    c[F.FVALID] >= 0.3 && c[F.RELIEF] <= g.relief && devFrac(c) >= g.dev &&
    (m.mix.wind === 0 || windCF(c[F.WS]) > 0.05));
  clusterHa = DATA.cells.map((c,i)=>{
    if(!pass[i]) return 0;
    let ha = devHa(c);
    for(const j of neighbors(i)) if(pass[j]) ha += devHa(DATA.cells[j]);
    return ha;
  });
  if(m.it >= 1000) pass = pass.map((p,i)=> p && clusterHa[i] >= needHa);
  else pass = pass.map((p,i)=> p && devHa(DATA.cells[i]) >= needHa);

  let sumW = 0; for(const L of LAYERS) if(state.on[L.k]) sumW += Math.abs(state.w[L.k]);
  scores = DATA.cells.map((c,i)=>{
    if(!pass[i] || !sumW) return -1;
    let s = 0;
    for(const L of LAYERS){
      if(!state.on[L.k]) continue;
      const w = state.w[L.k], n = L.norm(c);
      s += Math.abs(w) * (w >= 0 ? n : 1-n);
    }
    return 100 * s / sumW;
  });
  capex = []; lcoe = [];
  for(let i = 0; i < DATA.cells.length; i++){
    if(!pass[i]){ capex.push(NaN); lcoe.push(NaN); continue; }
    const sz = sizing(m, DATA.cells[i]);
    capex.push(sz.perMW); lcoe.push(sz.lcoe);
  }
  const dom = arr => {
    const v = arr.filter(x=>!isNaN(x)).sort((a,b)=>a-b);
    return v.length ? [v[Math.floor(v.length*0.02)], v[Math.floor(v.length*0.98)]] : null;
  };
  capexDomain = dom(capex) || capexDomain;
  lcoeDomain = dom(lcoe) || lcoeDomain;
}

function neighbors(i){
  const c = DATA.cells[i], out = [];
  for(let dy=-1; dy<=1; dy++) for(let dx=-1; dx<=1; dx++){
    if(!dx && !dy) continue;
    const j = byKey.get(key(c[F.LAT]+dy*0.1, c[F.LON]+dx*0.1));
    if(j !== undefined) out.push(j);
  }
  return out;
}
const key = (lat,lon) => Math.round(lat*100)+"_"+Math.round(lon*100);

function viridis(t){
  t = clamp(t);
  const st = [[44,26,77],[32,144,140],[122,209,81],[253,231,37]];
  const x = t*3, i = Math.min(2, Math.floor(x)), f = x-i;
  const a = st[i], b = st[i+1];
  return `rgb(${a.map((v,k)=>Math.round(v+(b[k]-v)*f)).join(",")})`;
}

const CellLayer = L.Layer.extend({
  onAdd(m){
    // "leaflet-zoom-animated" lets the canvas scale in lockstep with the tiles during zoom
    this._c = L.DomUtil.create("canvas", "leaflet-zoom-animated", m.getPane("overlayPane"));
    this._ctx = this._c.getContext("2d");
    m.on("moveend zoomend resize", this.redraw, this);
    if(m.options.zoomAnimation && L.Browser.any3d) m.on("zoomanim", this._animateZoom, this);
    this.redraw();
  },
  _animateZoom(e){
    // match Leaflet's own layer transforms so the grid doesn't lag/dephase mid-zoom
    const m = map, scale = m.getZoomScale(e.zoom);
    const offset = m._latLngToNewLayerPoint(m.containerPointToLatLng([0,0]), e.zoom, e.center);
    L.DomUtil.setTransform(this._c, offset, scale);
  },
  redraw(){
    const m = map, size = m.getSize(), z = m.getZoom();
    const tl = m.containerPointToLayerPoint([0,0]);
    L.DomUtil.setPosition(this._c, tl);
    this._c.width = size.x; this._c.height = size.y;
    if(!state.showCells) return;
    const ctx = this._ctx;
    const layerView = LAYERS.find(L2 => L2.k === state.view);
    const zoomFade = z >= 15 ? 0 : z >= 12 ? 0.35 : 1;  // let satellite/parcels show through when zoomed in
    for(let i=0; i<DATA.cells.length; i++){
      const c = DATA.cells[i];
      const p1 = m.latLngToContainerPoint([c[F.LAT]+0.05, c[F.LON]-0.05]);
      const p2 = m.latLngToContainerPoint([c[F.LAT]-0.05, c[F.LON]+0.05]);
      if(p2.x < 0 || p1.x > size.x || p2.y < 0 || p1.y > size.y) continue;
      let fill, alpha = 0.72;
      if(state.view === "score"){
        const s = scores[i];
        if(s === undefined || s < 0){ fill = "#3a3f4a"; alpha = 0.35; }
        else fill = viridis((s-35)/50);
      } else if(state.view === "capex" || state.view === "lcoe"){
        const v = state.view === "capex" ? capex[i] : lcoe[i];
        const d = state.view === "capex" ? capexDomain : lcoeDomain;
        if(isNaN(v)){ fill = "#3a3f4a"; alpha = 0.35; }
        else fill = viridis(1 - (v-d[0])/(d[1]-d[0]));  // yellow = cheap
      } else {
        fill = viridis(layerView.norm(c)); alpha = 0.7;
      }
      alpha *= zoomFade;
      if(alpha > 0){
        ctx.globalAlpha = alpha; ctx.fillStyle = fill;
        ctx.fillRect(p1.x, p1.y, Math.max(1.2, p2.x-p1.x-0.4), Math.max(1.2, p2.y-p1.y-0.4));
      }
      if(i === selected){
        ctx.globalAlpha = 1; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
        ctx.strokeRect(p1.x, p1.y, p2.x-p1.x, p2.y-p1.y);
      }
    }
    if(state.showSubs && SUBS){
      ctx.globalAlpha = 0.9;
      for(const s of SUBS){
        const p = m.latLngToContainerPoint([s[0], s[1]]);
        if(p.x < -4 || p.x > size.x+4 || p.y < -4 || p.y > size.y+4) continue;
        ctx.fillStyle = s[2] === 400 ? "#ffffff" : "#9aa3b2";
        ctx.fillRect(p.x-2.5, p.y-2.5, 5, 5);
      }
    }
    if(state.showFarms && FARMS){
      ctx.globalAlpha = 0.85; ctx.fillStyle = "#43d9f5"; ctx.strokeStyle = "#0b3a44"; ctx.lineWidth = 0.5;
      for(const f of FARMS){
        const p = m.latLngToContainerPoint([f[0], f[1]]);
        if(p.x < -5 || p.x > size.x+5 || p.y < -5 || p.y > size.y+5) continue;
        const r = Math.min(9, 1.2 + Math.sqrt(f[2])/4);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.283); ctx.fill(); ctx.stroke();
      }
    }
  }
});

/* ============================== map UI ================================= */
function buildUI(){
  const modes = document.getElementById("modes");
  modes.innerHTML = "";
  for(const k in MODES){
    const b = document.createElement("button");
    b.textContent = MODES[k].label; b.dataset.k = k;
    b.onclick = () => setMode(k);
    modes.appendChild(b);
  }
  const vs = document.getElementById("viewsel");
  vs.innerHTML = `<option value="score">Composite score</option><option value="lcoe">LCOE €/MWh delivered</option><option value="capex">Power capex €/MW IT</option>` +
    LAYERS.map(L2=>`<option value="${L2.k}">${L2.label}</option>`).join("");
  vs.onchange = () => {
    state.view = vs.value;
    const cost = vs.value === "capex" || vs.value === "lcoe";
    document.getElementById("lg0").textContent = cost ? "expensive" : "low";
    document.getElementById("lg1").textContent = cost ? "cheap" : "high";
    canvasLayer.redraw(); saveHash();
  };
  // assumptions
  const AMETA = [["pv","PV M€/MWp"],["bess","BESS M€/MWh"],["wind","Wind M€/MW"],["backup","Backup M€/MW"],
                 ["wacc","WACC %"],["years","Years"],["om","O&M %/yr"],["gas_e","Gas €/MWh_e"],
                 ["gas_capex","Gas M€/MW"],["landx","Land ×"]];
  document.getElementById("assume").innerHTML = AMETA.map(([k,l]) =>
    `<label class="afield"><span>${l}</span>
      <input type="number" step="any" data-k="${k}" value="${A[k]}"></label>`).join("");
  document.querySelectorAll("#assume input").forEach(inp => inp.onchange = () => {
    const v = parseFloat(inp.value);
    if(!isNaN(v)){ A[inp.dataset.k] = v; refresh(); }
  });

  // layer toggles
  document.getElementById("ov_subs").onchange = e => { state.showSubs = e.target.checked; canvasLayer.redraw(); };
  document.getElementById("bm_sat").onchange = e => {
    if(e.target.checked){ map.removeLayer(baseDark); map.addLayer(baseSat); }
    else { map.removeLayer(baseSat); map.addLayer(baseDark); }
  };
  document.getElementById("ov_cat").onchange = e => {
    if(e.target.checked) map.addLayer(catWMS); else map.removeLayer(catWMS);
  };
  document.getElementById("ov_cells").onchange = e => { state.showCells = e.target.checked; canvasLayer.redraw(); };
  document.getElementById("ov_pv").onchange = e => { state.showFarms = e.target.checked; canvasLayer.redraw(); };
  document.getElementById("ov_foot").onchange = e => toggleFoot(e.target.checked);
  if(FARMS) document.getElementById("m_pv").textContent = FARMS.length.toLocaleString();
  if(SUBS)  document.getElementById("m_subs").textContent = SUBS.length.toLocaleString();

  // model-settings drawer (progressive disclosure)
  const dr = document.getElementById("drawer"), bg = document.getElementById("drawerbg");
  const close = () => { dr.classList.remove("on"); bg.classList.remove("on"); };
  document.getElementById("modelbtn").onclick = () => { dr.classList.add("on"); bg.classList.add("on"); drawScatter(); };
  document.getElementById("drawerx").onclick = close;
  bg.onclick = close;
  document.addEventListener("keydown", e => { if(e.key === "Escape") close(); });
  document.getElementById("resetw").onclick = () => { setMode(state.mode); };

  setMode("gw");
}

function setMode(k){
  state.mode = k;
  const m = MODES[k];
  state.w = {...m.w};
  state.on = {}; for(const L2 of LAYERS) state.on[L2.k] = m.w[L2.k] !== 0;
  state.gates = {...m.gates};
  document.querySelectorAll("#modes button").forEach(b=>b.classList.toggle("on", b.dataset.k===k));
  document.getElementById("modenote").textContent = m.note;
  renderWeights(); renderGates(); refresh();
}

function renderWeights(){
  const el = document.getElementById("weights"); el.innerHTML = "";
  for(const L2 of LAYERS){
    const row = document.createElement("div");
    row.className = "slider" + (state.on[L2.k] ? "" : " off");
    row.innerHTML = `<input type="checkbox" ${state.on[L2.k]?"checked":""}>
      <label>${L2.label}</label>
      <input type="range" min="${L2.dual?-100:0}" max="100" value="${state.w[L2.k]}">
      <span class="val">${state.w[L2.k]}</span>`;
    const [cb,,rg,val] = row.children;
    cb.onchange = () => { state.on[L2.k] = cb.checked; row.classList.toggle("off", !cb.checked); refresh(); };
    rg.oninput = () => { state.w[L2.k] = +rg.value; val.textContent = rg.value; if(!state.on[L2.k] && +rg.value){cb.checked=true;state.on[L2.k]=true;row.classList.remove("off");} refresh(); };
    el.appendChild(row);
    const hint = document.createElement("div");
    hint.className = "hint"; hint.textContent = L2.hint;
    el.appendChild(hint);
  }
}

function renderGates(){
  const el = document.getElementById("gates");
  el.innerHTML = `
    <div class="slider"><label>Max terrain relief</label>
      <input id="g_rel" type="range" min="50" max="800" step="25" value="${state.gates.relief}"><span class="val">${state.gates.relief} m</span></div>
    <div class="slider"><label>Min developable share</label>
      <input id="g_dev" type="range" min="0" max="0.9" step="0.05" value="${state.gates.dev}"><span class="val">${Math.round(state.gates.dev*100)}%</span></div>`;
  el.querySelector("#g_rel").oninput = e => { state.gates.relief = +e.target.value; e.target.nextElementSibling.textContent = e.target.value+" m"; refresh(); };
  el.querySelector("#g_dev").oninput = e => { state.gates.dev = +e.target.value; e.target.nextElementSibling.textContent = Math.round(e.target.value*100)+"%"; refresh(); };
}

function refresh(){
  computeScores();
  canvasLayer.redraw();
  renderTop();
  drawScatter();
  saveHash();
  if(selected >= 0) showDetail(selected);
  if(footOn && footHandle) drawFoot(footHandle.getLatLng());  // resize footprint if project mode changed
}

/* ---------- shareable state (model config + open view) ---------- */
function saveHash(){
  const h = {m:state.mode, v:state.view, w:state.w, on:state.on, g:state.gates};
  const view = (window.Router && Router.current) || "map";
  history.replaceState(null, "", "#" + encodeURIComponent(JSON.stringify(h)) + "&view=" + view);
}
function restoreHash(){
  try{
    const raw = location.hash.slice(1).split("&view=")[0];
    if(raw.length < 3) return;
    const h = JSON.parse(decodeURIComponent(raw));
    if(!MODES[h.m]) return;
    setMode(h.m);
    Object.assign(state.w, h.w); Object.assign(state.on, h.on); Object.assign(state.gates, h.g);
    state.view = h.v || "score";
    document.getElementById("viewsel").value = state.view;
    renderWeights(); renderGates(); refresh();
  }catch(e){}
}

/* ---------- validation: model score vs existing build-out ---------- */
function drawScatter(){
  const cv = document.getElementById("scatter");
  if(!cv) return;
  const ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const pts = [];
  let totMW = 0;
  for(let i = 0; i < DATA.cells.length; i++){
    if(scores[i] < 0) continue;
    const mw = DATA.cells[i][F.PVMW];
    totMW += mw;
    pts.push([scores[i], mw, i]);
  }
  if(!pts.length){ document.getElementById("valstat").textContent = "No cells pass gates."; return; }
  const yMax = Math.log10(1 + Math.max(...pts.map(p=>p[1]), 10));
  ctx.fillStyle = "#43d9f5";
  for(const [s, mw, i] of pts){
    ctx.globalAlpha = mw > 0 ? 0.75 : 0.18;
    const x = 6 + (s/100)*(W-12), y = H-6 - (Math.log10(1+mw)/yMax)*(H-12);
    ctx.fillRect(x-1.5, y-1.5, 3, 3);
  }
  ctx.globalAlpha = 1;
  const sorted = [...pts].sort((a,b)=>b[0]-a[0]);
  const q = Math.max(1, Math.floor(sorted.length/5));
  const topMW = sorted.slice(0, q).reduce((a,p)=>a+p[1], 0);
  const dcScore = st => {
    const v = (DCJSON||[]).filter(d=>st.includes(d.status))
      .map(d=>scores[byKey.get(key(Math.floor(d.lat/0.1)*0.1+0.05, Math.floor(d.lon/0.1)*0.1+0.05))])
      .filter(s=>s !== undefined && s >= 0);
    return v.length ? Math.round(v.reduce((a,b)=>a+b,0)/v.length) : null;
  };
  const sOp = dcScore(["operating"]), sNew = dcScore(["announced","construction","land"]);
  document.getElementById("valstat").innerHTML =
    `Top-20% scored cells hold <b>${totMW ? Math.round(100*topMW/totMW) : 0}%</b> of the ${(totMW/1000).toFixed(1)} GW of OSM-mapped PV in passing cells — ` +
    `x: composite score, y: existing MW (log).` +
    (sOp !== null && sNew !== null ? `<br>Pipeline check: operating sites average score <b>${sOp}</b>; announced/construction/land average <b>${sNew}</b> — the new wave ${sNew>sOp?"is moving toward":"is not yet moving toward"} the model's map.` : "");
}

function renderTop(){
  const idx = scores.map((s,i)=>[s,i]).filter(x=>x[0]>=0).sort((a,b)=>b[0]-a[0]);
  const picks = [];
  for(const [s,i] of idx){
    if(picks.length >= 10) break;
    const c = DATA.cells[i];
    if(picks.some(p => dist(c, DATA.cells[p]) < 45)) continue;
    picks.push(i);
  }
  document.getElementById("topcount").textContent = `(${idx.length} cells pass)`;
  const el = document.getElementById("toplist"); el.innerHTML = "";
  picks.forEach((i,r)=>{
    const c = DATA.cells[i], R = REGIONS[c[F.CCAA]];
    const d = document.createElement("div");
    d.className = "card";
    d.style.cssText = "margin-bottom:6px;cursor:pointer;padding:9px 11px";
    d.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
        <b style="font-size:12px">${r+1}. ${U.esc(DATA.cities[c[F.CITYI]][0])} area</b>
        <span style="font-weight:700;color:var(--accent);font-size:13px">${scores[i].toFixed(0)}</span></div>
      <div style="font-size:10.5px;color:var(--dim);margin-top:2px">${U.esc(R.name)} · ${c[F.EY]} kWh/kWp · ${Math.round(devFrac(c)*100)}% developable${capex[i]?` · ${capex[i].toFixed(1)} M€/MW`:""}</div>`;
    d.onclick = () => { select(i, null); map.flyTo([c[F.LAT], c[F.LON]], 10); };
    el.appendChild(d);
  });
  if(!picks.length) el.innerHTML = C.empty("—", "No cells pass the current gates", "Relax them in Model settings.");
}

function dist(a,b){
  const p = Math.PI/180;
  const h = 0.5 - Math.cos((b[F.LAT]-a[F.LAT])*p)/2 + Math.cos(a[F.LAT]*p)*Math.cos(b[F.LAT]*p)*(1-Math.cos((b[F.LON]-a[F.LON])*p))/2;
  return 12742*Math.asin(Math.sqrt(h));
}

function select(i, pt){
  selected = i;
  muni = "";
  clickPt = pt || {lat: DATA.cells[i][F.LAT], lng: DATA.cells[i][F.LON]};
  canvasLayer.redraw(); showDetail(i);
  lookupParcel(clickPt);
}

function closeDetail(){
  document.getElementById("detail").style.display = "none";
  selected = -1; canvasLayer.redraw();
}

function showDetail(i){
  const c = DATA.cells[i], R = REGIONS[c[F.CCAA]], m = MODES[state.mode];
  const sz = sizing(m, c);
  const own = devHa(c), avail = m.it >= 1000 ? clusterHa[i] || own : own;
  const fits = avail >= sz.ha;
  let contrib = "";
  for(const L2 of LAYERS){
    if(!state.on[L2.k]) continue;
    const w = state.w[L2.k], n = L2.norm(c), eff = w>=0 ? n : 1-n;
    contrib += `<tr><td>${L2.label}<div class="bar-tr" style="height:4px;margin-top:3px"><i class="bar-fi" style="width:${Math.round(eff*100)}%;background:var(--accent)"></i></div></td>
      <td>${L2.fmt(c)}<br><span style="font-size:10px;color:var(--faint)">w ${w>0?"+":""}${w} → ${(eff*100).toFixed(0)}</span></td></tr>`;
  }
  const isa = [["#8c2f39",c[F.FMAX],"Máxima (excluded)"],["#c95d3f",c[F.FMUYALTA],"Muy alta"],["#e0a13f",c[F.FALTA],"Alta"],["#a4c05b",c[F.FMOD],"Moderada"],["#4caf7d",c[F.FBAJA],"Baja"]];
  const windRow = sz.windMW > 0 ? `<tr><td>Wind for ${Math.round(m.mix.wind*100)}% share (CF≈${Math.round(sz.cf*100)}%)</td><td>${Math.round(sz.windMW).toLocaleString()} MW</td></tr>` : "";
  const el = document.getElementById("detail");
  el.style.display = "block";
  el.innerHTML = `
    <div class="detail-h">
      <div>
        <h1 class="title"><span id="muni">${U.esc(muni || DATA.cities[c[F.CITYI]][0] + " area")}</span></h1>
        <div class="subtitle" style="margin-bottom:0">${U.esc(R.name)} · ${c[F.LAT].toFixed(2)}, ${c[F.LON].toFixed(2)} · elev ${c[F.ELEV]} m · cell ~94 km²</div>
      </div>
      <button class="x" onclick="closeDetail()">×</button>
    </div>
    <div style="display:flex;align-items:baseline;gap:12px;margin:10px 0 8px">
      <div><span style="font-size:28px;font-weight:700;color:var(--accent);letter-spacing:-1px">${scores[i]>=0?scores[i].toFixed(0):"—"}</span>
        <span style="font-size:11px;color:var(--dim)">/100 composite${scores[i]<0?" (fails gates)":""}</span></div>
      ${!isNaN(lcoe[i])?`<div style="margin-left:auto;text-align:right"><div style="font-size:17px;font-weight:650">${lcoe[i].toFixed(0)}</div>
        <div style="font-size:9.5px;color:var(--dim)">€/MWh delivered</div></div>`:""}
    </div>
    <button class="btn btn-full btn-accent" id="briefbtn">Copy site brief</button>

    <div class="sec">Parcel at clicked point<div class="sec-line"></div></div>
    <div class="card" id="parcel" style="font-size:11.5px">Looking up referencia catastral…</div>

    <div class="sec">Layer contributions<div class="sec-line"></div></div>
    <table class="kv">${contrib}</table>

    <div class="sec">BYOP build math — ${U.esc(m.label)}<div class="sec-line"></div></div>
    <table class="kv">
      <tr><td>IT load / campus load (PUE ${PUE})</td><td>${m.it} / ${Math.round(sz.load)} MW</td></tr>
      <tr><td>PV for ${Math.round(m.mix.pv*100)}% share at ${c[F.EY]} kWh/kWp</td><td>${Math.round(sz.mwp).toLocaleString()} MWp</td></tr>
      ${windRow}
      <tr><td>Battery (${m.mix.wind>0?BESS_H.hybrid:BESS_H.solar} MWh/MW load)</td><td>${Math.round(sz.bess).toLocaleString()} MWh</td></tr>
      <tr><td>Land required</td><td>${Math.round(sz.ha).toLocaleString()} ha</td></tr>
      <tr><td>Developable land ${m.it>=1000 ? "in cell + 8 neighbours" : "in this cell"}</td><td>${Math.round(avail).toLocaleString()} ha</td></tr>
      <tr><td>Largest contiguous patch touching cell</td><td>${c[F.PATCH].toLocaleString()} ha</td></tr>
    </table>
    <div style="margin-top:8px"><span class="badge ${fits?"badge-good":"badge-bad"}">${fits ? "Land requirement met" : "Insufficient contiguous land"}</span></div>

    <div class="sec">Power capex (screening)<div class="sec-line"></div></div>
    <table class="kv">
      <tr><td>PV ${Math.round(sz.mwp).toLocaleString()} MWp × ${A.pv} M€</td><td>${Math.round(sz.mwp*A.pv).toLocaleString()} M€</td></tr>
      ${sz.windMW>0?`<tr><td>Wind ${Math.round(sz.windMW).toLocaleString()} MW × ${A.wind} M€</td><td>${Math.round(sz.windMW*A.wind).toLocaleString()} M€</td></tr>`:""}
      <tr><td>BESS ${Math.round(sz.bess).toLocaleString()} MWh × ${A.bess} M€</td><td>${Math.round(sz.bess*A.bess).toLocaleString()} M€</td></tr>
      <tr><td>Backup ${Math.round(sz.load).toLocaleString()} MW × ${A.backup} M€</td><td>${Math.round(sz.load*A.backup).toLocaleString()} M€</td></tr>
      <tr><td>Land ${Math.round(sz.ha).toLocaleString()} ha × ${(sz.landEurHa/1000).toFixed(1)} k€/ha</td><td>${Math.round(sz.ha*sz.landEurHa/1e6).toLocaleString()} M€</td></tr>
      <tr><td><b>Total power system</b></td><td><b>${Math.round(sz.capexM).toLocaleString()} M€ · ${sz.perMW.toFixed(1)} M€/MW IT</b></td></tr>
      <tr><td><b>LCOE delivered</b> (WACC ${A.wacc}%, ${A.years} yr)</td><td><b>${sz.lcoe.toFixed(0)} €/MWh</b></td></tr>
      <tr><td>Pure gas-BYOP benchmark at this load</td><td>${sz.gasLcoe.toFixed(0)} €/MWh ${sz.lcoe < sz.gasLcoe ? "· <b style='color:var(--good)'>solar wins</b>" : "· <b style='color:var(--bad)'>gas wins</b>"}</td></tr>
    </table>

    <div class="sec">Environmental sensitivity (MITECO 25 m)<div class="sec-line"></div></div>
    <div style="display:flex;height:12px;border-radius:4px;overflow:hidden;margin:4px 0">${isa.map(x=>`<span style="width:${x[1]*100}%;background:${x[0]}" title="${x[2]}"></span>`).join("")}</div>
    <div style="font-size:10.5px;color:var(--dim)">${isa.map(x=>`${x[2]} ${(x[1]*100).toFixed(0)}%`).join(" · ")}</div>
    <div style="font-size:11px;color:var(--text-2);margin-top:4px">Continuous ISA — PV <b>${c[F.ISAV].toFixed(1)}/10</b> · wind <b>${c[F.EOLV].toFixed(1)}/10</b> (10 = least sensitive)</div>

    <div class="sec">Regulatory reception — ${R.score}/100<div class="sec-line"></div></div>
    <div class="card">
      <div class="card-t">${U.esc(R.instrument)} <span class="muted" style="font-weight:400">(${U.esc(R.confidence)} confidence)</span></div>
      <div style="font-size:11.5px;color:var(--text-2);line-height:1.5">${U.esc(R.dossier)}</div>
      <div style="margin-top:6px">${R.sources.map(s=>{const u=U.safeUrl(s); return u?`<a href="${u}" target="_blank" rel="noopener" style="font-size:10.5px;display:block">${U.esc(U.host(u))} ↗</a>`:"";}).join("")}</div>
    </div>

    <div class="sec">Context<div class="sec-line"></div></div>
    <table class="kv">
      <tr><td>Nearest DC project</td><td>${U.esc(DATA.dcs[c[F.DCI]][0])} · ${c[F.DDC]} km</td></tr>
      <tr><td>Nearest city ≥100k</td><td>${U.esc(DATA.cities[c[F.CITYI]][0])} · ${c[F.DCITY]} km</td></tr>
      <tr><td>Wind 50 m / precip</td><td>${c[F.WS]} m/s · ${c[F.PRECIP]} mm/yr</td></tr>
      <tr><td>Existing PV in cell (OSM)</td><td>${c[F.PVMW]>0 ? "<b>"+c[F.PVMW]+" MW</b>" : "none"}</td></tr>
      <tr><td>Nearest 220/400 kV substation</td><td>${c[F.DSUB]} km</td></tr>
    </table>
    <div class="foot">Economics are screening-grade and live-editable in Model settings. Wind CF from 0.5° mean speed is indicative only.</div>`;
  document.getElementById("briefbtn").onclick = () => copyBrief(i);
}

function copyBrief(i){
  const c = DATA.cells[i], R = REGIONS[c[F.CCAA]], m = MODES[state.mode], sz = sizing(m, c);
  const txt = `SITE BRIEF — Iberian Datacenter Intelligence / BYOP siting model
${muni || DATA.cities[c[F.CITYI]][0] + " area"} (${R.name}) · ${c[F.LAT].toFixed(3)}, ${c[F.LON].toFixed(3)}
Composite score: ${scores[i]>=0?scores[i].toFixed(0):"n/a"}/100 (mode: ${m.label})
Solar: ${c[F.EY]} kWh/kWp·yr (PVGIS SARAH3) · Terrain relief: ${c[F.RELIEF]} m · Elev: ${c[F.ELEV]} m
Env. sensitivity (MITECO): ${c[F.ISAV].toFixed(1)}/10 continuous · ${Math.round(devFrac(c)*100)}% developable (Baja+Moderada)
Regulatory: ${R.score}/100 (${R.confidence} confidence) — ${R.instrument}
Build math (${m.label}): ${Math.round(sz.mwp).toLocaleString()} MWp PV${sz.windMW?` + ${Math.round(sz.windMW)} MW wind`:""} + ${Math.round(sz.bess).toLocaleString()} MWh BESS · ${Math.round(sz.ha).toLocaleString()} ha needed vs ${Math.round(m.it>=1000?(clusterHa[i]||devHa(c)):devHa(c)).toLocaleString()} ha developable
Economics: ${Math.round(sz.capexM).toLocaleString()} M€ capex (${sz.perMW.toFixed(1)} M€/MW IT) · LCOE ${sz.lcoe.toFixed(0)} €/MWh vs gas-BYOP ${sz.gasLcoe.toFixed(0)} €/MWh
Context: ${c[F.DSUB]} km to 220/400kV · ${c[F.DCITY]} km to ${DATA.cities[c[F.CITYI]][0]} · ${c[F.DDC]} km to ${DATA.dcs[c[F.DCI]][0]} · ${c[F.PVMW]} MW PV already in cell
Assumptions: PV ${A.pv} M€/MWp · BESS ${A.bess} M€/MWh · WACC ${A.wacc}% · ${A.years} yr · land ${(sz.landEurHa/1000).toFixed(1)} k€/ha
— sources: PVGIS, MITECO Zonificación 2023, Copernicus, OSM, primary regulatory research`;
  navigator.clipboard.writeText(txt).then(() => {
    const b = document.getElementById("briefbtn");
    b.textContent = "✓ Copied"; setTimeout(()=> b.textContent = "Copy site brief", 1500);
  });
}

/* ---------- project dossier (map right panel) ---------- */
function showDC(d, ci){
  const el = document.getElementById("detail");
  el.style.display = "block";
  // prefer the normalised KB record (carries provenance); fall back to the baked marker
  const p = d.kb || null;
  const fld = a => p ? KB.field(p, a) : null;
  const fmw = fld("mw"), finv = fld("investment_eur_m"), fco = fld("company");
  const news = p ? p.news : (d.live && d.live.news) || [];
  const changes = p ? p.changes : [];
  const srcs = p ? KB.allSources(p) : [];

  el.innerHTML = `
    <div class="detail-h">
      <div>
        <h1 class="title">${U.esc(d.name)}</h1>
        <div class="subtitle" style="margin-bottom:0" title="${U.esc((p && p.company) || d.note || "")}">${U.esc(U.clip((p && p.company) || d.note || "", 64))}</div>
      </div>
      <button class="x" onclick="closeDetail()">×</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">
      ${C.badge(d.status)}
      ${p && p.review ? `<span class="badge badge-warn">needs review</span>` : ""}
      ${p && p.region ? `<span class="badge badge-mute">${U.esc(p.region)}</span>` : ""}
    </div>

    <div class="stats" style="grid-template-columns:1fr 1fr;gap:8px">
      <div class="stat" style="padding:10px 12px">
        <div class="stat-v" style="font-size:18px">${fmw ? C.value(fmw, U.mw) : "—"}</div>
        <div class="stat-l">Capacity</div>${fmw ? `<div style="margin-top:3px">${C.conf(fmw)}</div>` : ""}</div>
      <div class="stat" style="padding:10px 12px">
        <div class="stat-v" style="font-size:18px">${finv ? C.value(finv, U.eur) : "—"}</div>
        <div class="stat-l">Announced capital</div>${finv ? `<div style="margin-top:3px">${C.conf(finv)}</div>` : ""}</div>
    </div>
    ${fmw ? C.sources(fmw, "capacity evidence") : ""}
    ${finv ? C.sources(finv, "capital evidence") : ""}

    ${ci !== undefined && scores[ci] >= 0 ? `
      <div class="card" style="margin-top:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div><div class="card-t">Siting model score here</div>
            <div class="muted" style="font-size:10.5px">how this location scores for BYOP solar</div></div>
          <div style="font-size:20px;font-weight:700;color:var(--accent)">${scores[ci].toFixed(0)}</div>
        </div>
        <button class="btn btn-full btn-sm" style="margin-top:8px" onclick="select(${ci})">Open cell analysis →</button>
      </div>` : ""}

    ${changes.length ? `<div class="sec">Change history<div class="sec-line"></div></div>
      <div class="tl">${changes.slice(0,8).map(c => {
        const u = U.safeUrl(c.url);
        return `<div class="tl-i"><div class="tl-d">${U.esc(U.date(c.ts))}${c.action?` · ${U.esc(c.action)}`:""}</div>
          <div style="font-size:11.5px">${c.field?`<b>${U.esc(U.fieldLabel(c.field))}</b>: <span class="muted">${U.esc(U.fieldValue(c.field, c.old))}</span> → <b class="hl">${U.esc(U.fieldValue(c.field, c.new))}</b>`:U.esc(c.note||"")}
          ${u?` · <a href="${u}" target="_blank" rel="noopener">source ↗</a>`:""}</div></div>`;
      }).join("")}</div>` : ""}

    <div class="sec">News trail<div class="sec-line"></div></div>
    ${news.length ? news.map(n => {
      const u = U.safeUrl(n.url);
      return `<div class="card" style="margin-bottom:6px">
        <div class="src-meta" style="margin-bottom:3px">
          <span>${evTag(n.event)}</span>
          ${n.date?`<span>· ${U.esc(U.date(n.date))}</span>`:""}
          ${n.source?`<span>· ${U.esc(n.source)}</span>`:""}${C.tier(n.tier)}</div>
        ${u?`<a href="${u}" target="_blank" rel="noopener" style="font-size:12px">${U.esc(n.title)} ↗</a>`
            :`<span style="font-size:12px">${U.esc(n.title)}</span>`}
        ${n.summary?`<div style="font-size:11px;color:var(--text-2);margin-top:3px">${U.esc(n.summary)}</div>`:""}
      </div>`;
    }).join("") : C.empty("—", "No tracked news yet",
        KB.loaded ? "The daily watch adds articles as they appear." : "Live knowledge base not loaded.")}

    ${srcs.length > news.length ? `<div class="sec">All sources<div class="sec-line"></div></div>
      ${srcs.map(s => `<div class="src"><a href="${s.url}" target="_blank" rel="noopener">${U.esc(s.source || U.host(s.url))} ↗</a>
        <div class="src-meta">${C.tier(s.tier)}<span>${U.esc(U.date(s.date))}</span></div></div>`).join("")}` : ""}

    <div class="foot">Baked baseline: primary research + datacentermap + baxtel. Live layer: daily
      RSS → extraction → entity-resolution pipeline. Every figure above links to the article it came from.</div>`;
}

/* ---------- Catastro parcel lookup ---------- */
async function lookupParcel(pt){
  const el = () => document.getElementById("parcel");
  const gmaps = `https://www.google.com/maps/@${pt.lat.toFixed(5)},${pt.lng.toFixed(5)},2500m/data=!3m1!1e3`;
  try{
    const r = await fetch(`https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCoordenadas.svc/json/Consulta_RCCOOR?CoorX=${pt.lng.toFixed(6)}&CoorY=${pt.lat.toFixed(6)}&SRS=EPSG:4326`);
    const j = await r.json();
    const co = j.Consulta_RCCOORResult?.coordenadas?.coord?.[0];
    if(!co?.pc){ if(el()) el().innerHTML = `No parcel at this exact point (unregistered/public land). <a href="${gmaps}" target="_blank" rel="noopener">Satellite view ↗</a>`; return; }
    const rc = co.pc.pc1 + co.pc.pc2;
    const mm = (co.ldt || "").match(/\.\s*([^.]+\([^)]+\))\s*$/);
    if(mm){ muni = mm[1].trim(); const el2 = document.getElementById("muni"); if(el2) el2.textContent = muni; }
    let html = `<b>${U.esc(rc)}</b><br>${U.esc(co.ldt || "")}`;
    try{
      const r2 = await fetch(`https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/json/Consulta_DNPRC?RefCat=${rc}`);
      const j2 = await r2.json();
      const bi = j2.consulta_dnprcResult?.bico?.bi;
      const finca = j2.consulta_dnprcResult?.bico?.finca;
      if(bi){
        const cls = bi.idbi?.cn === "RU" ? "Rústica (rural)" : "Urbana";
        const uso = bi.debi?.luso || "—";
        const ha = finca?.dff?.ss ? (finca.dff.ss/10000).toFixed(1)+" ha" : "";
        html += `<br>Class: <b>${U.esc(cls)}</b> · Use: <b>${U.esc(uso)}</b>${ha?` · Surface: <b>${U.esc(ha)}</b>`:""}`;
        const sub = (j2.consulta_dnprcResult?.bico?.lspr || []).slice(0,4)
          .map(x=>x.spr?.dspr ? `${x.spr.dspr.dcc || ""} ${x.spr.dspr.ssp ? (x.spr.dspr.ssp/10000).toFixed(1)+" ha" : ""}` : "").filter(Boolean);
        if(sub.length) html += `<br><span style="font-size:11px;color:var(--dim)">Cultivos: ${U.esc(sub.join(" · "))}</span>`;
        const igraf = U.safeUrl(finca?.infgraf?.igraf);
        html += `<br><a href="${igraf || "https://www1.sedecatastro.gob.es/Cartografia/mapa.aspx?refcat="+rc}" target="_blank" rel="noopener">Sede Catastro ↗</a> · <a href="${gmaps}" target="_blank" rel="noopener">Satellite ↗</a>`;
      }
    }catch(e){ html += `<br><a href="${gmaps}" target="_blank" rel="noopener">Satellite ↗</a>`; }
    if(el()) el().innerHTML = html + `<div style="font-size:10px;color:var(--faint);margin-top:5px">Turn on the Catastro layer and zoom in to see parcel boundaries.</div>`;
  }catch(e){
    if(el()) el().innerHTML = `Catastro service unreachable right now. <a href="${gmaps}" target="_blank" rel="noopener">Satellite view ↗</a>`;
  }
}

/* ---------- BYOP footprint-to-scale overlay ---------- */
function footGeom(m){
  const Y = 1750, CF = 0.30;
  const load = m.it * PUE, E = load * 8760;
  const mwp = E * m.mix.pv / Y;
  const windMW = m.mix.wind > 0 ? E * m.mix.wind / (8760 * CF) : 0;
  return {pvHa: mwp*HA_PER_MWP, windHa: windMW*HA_PER_WIND_MW, dcHa: m.it*0.03};
}
function drawFoot(center){
  if(!footLayer) return;
  footLayer.clearLayers();
  const m = MODES[state.mode], g = footGeom(m);
  const lat0 = center.lat, lng0 = center.lng;
  const mLat = 111320, mLng = 111320*Math.cos(lat0*Math.PI/180);
  const LL = (xm,ym) => [lat0 + ym/mLat, lng0 + xm/mLng];
  const box = (x0,y0,s) => [LL(x0,y0),LL(x0+s,y0),LL(x0+s,y0+s),LL(x0,y0+s)];
  const S = Math.sqrt(g.pvHa*1e4);
  L.polygon(box(-S/2,-S/2,S), {color:"#4db3ff",weight:1.5,dashArray:"5 4",fillColor:"#2f6fb0",fillOpacity:0.28})
    .bindTooltip("Solar field — allocated land (only ~25% is actual panels)",{sticky:true}).addTo(footLayer);
  const d = Math.sqrt(g.dcHa*1e4);
  L.polygon(box(-S/2,-S/2,d), {color:"#fff",weight:1,fillColor:"#e05d5d",fillOpacity:0.95})
    .bindTooltip("Datacenter buildings",{sticky:true}).addTo(footLayer);
  if(g.windHa > 0){
    const Wd = Math.sqrt(g.windHa*1e4);
    L.polygon(box(S/2 + S*0.04, -Wd/2, Wd), {color:"#7bc47f",weight:1,fillColor:"#7bc47f",fillOpacity:0.14})
      .bindTooltip("Wind area — cropland/grazing continues below turbines",{sticky:true}).addTo(footLayer);
  }
  const totKm2 = (g.pvHa+g.windHa+g.dcHa)/100, solKm2 = g.pvHa/100;
  const lbl = `${m.label} BYOP · ${totKm2.toFixed(totKm2<10?1:0)} km² total`
    + `<br>Solar field ${solKm2.toFixed(solKm2<10?1:0)} km² (~25% actual panels)`
    + `<br>Buildings ${g.dcHa.toFixed(g.dcHa<10?1:0)} ha · ${Math.round((g.pvHa+g.windHa+g.dcHa)/g.dcHa)}:1 land-to-building`;
  if(footHandle){ footHandle.setLatLng(center); footHandle.setTooltipContent(lbl); }
}
function toggleFoot(on){
  footOn = on;
  if(on){
    footLayer = L.layerGroup().addTo(map);
    const c = map.getCenter();
    footHandle = L.marker(c, {draggable:true, zIndexOffset:1000,
      icon: L.divIcon({className:"", iconSize:[26,26], html:
        `<div style="width:26px;height:26px;border-radius:50%;background:#f5b83d;color:#14171c;display:flex;`
        + `align-items:center;justify-content:center;font-size:15px;font-weight:700;border:2px solid #14171c;cursor:move">✥</div>`})
    }).addTo(map);
    footHandle.bindTooltip("", {permanent:true, direction:"top", offset:[0,-16]});
    footHandle.on("drag", e => drawFoot(e.target.getLatLng()));
    drawFoot(c);
  } else {
    if(footLayer){ map.removeLayer(footLayer); footLayer = null; }
    if(footHandle){ map.removeLayer(footHandle); footHandle = null; }
  }
}

/* ---------- project markers ---------- */
function buildProjectLayers(){
  dcGroups = {}; dcMarkers = new Map();
  for(const d of dcAll){
    const st = d.status || "announced";
    const g = dcGroups[st] || (dcGroups[st] = L.layerGroup().addTo(map));
    const ci = byKey.get(key(Math.floor(d.lat/0.1)*0.1+0.05, Math.floor(d.lon/0.1)*0.1+0.05));
    // radius carries disclosed capacity — the map reads as a market picture, not just dots
    const mw = d.kb && d.kb.mw;
    const r = mw ? Math.max(4, Math.min(13, 3.4 + Math.sqrt(mw)/3.2)) : (d.src === "research" ? 5 : 3.6);
    const mk = L.circleMarker([d.lat, d.lon], {radius: r, color:"#fff", weight:1.2,
        fillColor: DC_COLORS[st] || "#5182e0", fillOpacity:0.9})
      .bindTooltip(() => {
        const p = d.kb;
        return `<b>${U.esc(d.name)}</b><br><i>${U.esc(KB.statusMeta(st).label)}</i>`
          + (p && p.company ? ` · ${U.esc(p.company)}` : "")
          + (p && p.mw ? `<br>${U.esc(U.mw(p.mw))}` : "")
          + (p && p.inv ? ` · ${U.esc(U.eur(p.inv))}` : "")
          + (p && (p.news||[]).length ? `<br>${p.news.length} article(s)` : "")
          + (ci !== undefined && scores[ci] >= 0 ? `<br>model score here: <b>${scores[ci].toFixed(0)}</b>` : "");
      })
      .on("click", ev2 => { L.DomEvent.stopPropagation(ev2); showDC(d, ci); })
      .addTo(g);
    if(d.kb && d.kb.id) dcMarkers.set(d.kb.id, {d, ci, mk});
    dcMarkers.set(d.name, {d, ci, mk});
  }

  // status filter chips
  const counts = {};
  for(const d of dcAll) counts[d.status] = (counts[d.status] || 0) + 1;
  const box = document.getElementById("dcfilters");
  box.innerHTML = STATUS_ORDER.filter(s => counts[s]).map(s => `
    <div class="tog"><input type="checkbox" class="dcst" value="${s}" checked>
      <label>${C.dot(s)} ${U.esc(KB.statusMeta(s).label)}</label>
      <span class="meta">${counts[s]}</span></div>`).join("");
  document.querySelectorAll(".dcst").forEach(cb => cb.onchange = () => {
    const g = dcGroups[cb.value];
    if(g) cb.checked ? map.addLayer(g) : map.removeLayer(g);
  });
}

/* ---------- cross-view bridge ---------- */
window.Bridge = {
  openProject(idOrName){
    const hit = dcMarkers.get(idOrName);
    if(!hit) return;
    Router.go("map");
    setTimeout(() => {
      map.invalidateSize();
      map.flyTo([hit.d.lat, hit.d.lon], Math.max(map.getZoom(), 11), {duration: .8});
      showDC(hit.d, hit.ci);
    }, 90);
  },
};

/* ================================ boot ================================= */
(async function(){
  if(window.__CELLS){  // data shipped as script files -> works from file:// with no server
    DATA = window.__CELLS; REGIONS = window.__REGIONS; FARMS = window.__FARMS; DCJSON = window.__DCS; SUBS = window.__SUBS;
  } else {
    const V = "?v=9";
    const [cellsR, regR, farmR, dcR] = await Promise.all([
      fetch("data/cells.json"+V), fetch("data/regions.json"+V),
      fetch("data/solar_farms.json"+V), fetch("data/datacenters.json"+V)]);
    DATA = await cellsR.json(); REGIONS = await regR.json();
    FARMS = await farmR.json(); DCJSON = await dcR.json();
  }
  DATA.cells.forEach((c,i)=> byKey.set(key(c[F.LAT], c[F.LON]), i));

  map = L.map("map", {zoomControl:true, maxZoom:19}).setView([40.2, -3.6], 6);
  window.map = map;
  baseDark = L.layerGroup([
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {attribution:"© OpenStreetMap, © CARTO", maxZoom:19}),
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png", {pane:"shadowPane", maxZoom:19}),
  ]);
  baseSat = L.layerGroup([
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {attribution:"© Esri, Maxar", maxZoom:19}),
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png", {pane:"shadowPane", maxZoom:19}),
  ]).addTo(map);  // satellite on by default
  catWMS = L.tileLayer.wms("https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx", {
    layers:"Catastro", format:"image/png", transparent:true, minZoom:13, maxZoom:19, attribution:"© DG Catastro"});

  canvasLayer = new CellLayer(); map.addLayer(canvasLayer);

  // live knowledge base (Hermes pipeline) merged into the baked baseline
  try{
    const lr = await fetch("data/dc_live.json?ts=" + Date.now());
    if(lr.ok) LIVE = await lr.json();
  }catch(e){}
  KB.load(LIVE);

  const toks = s => new Set((s||"").toLowerCase().split(/[^a-záéíóúñü0-9]+/).filter(w=>w.length>3));
  dcAll = DCJSON.map(d=>({...d}));
  if(KB.loaded && KB.projects.length){
    for(const p of KB.projects){
      if(p.lat === null || p.lat === undefined) continue;
      const pt = toks(p.name + " " + (p.company||""));
      const hit = dcAll.find(d => Math.abs(d.lat-p.lat) < 0.03 && Math.abs(d.lon-p.lon) < 0.04 &&
        [...toks(d.name + " " + d.note)].some(w => pt.has(w)));
      if(hit){ hit.kb = p; if(p.status && DC_COLORS[p.status]) hit.status = p.status; }
      else dcAll.push({name: p.name, lat: p.lat, lon: p.lon,
                       status: DC_COLORS[p.status] ? p.status : "announced",
                       note: (p.company||""), src: "live", kb: p});
    }
  }

  buildUI();
  buildProjectLayers();
  map.on("click", e => {
    const lat = Math.floor(e.latlng.lat/0.1)*0.1+0.05, lon = Math.floor(e.latlng.lng/0.1)*0.1+0.05;
    const i = byKey.get(key(lat,lon));
    if(i !== undefined) select(i, e.latlng);
  });

  // platform shell
  renderKPIs();
  registerViews();
  // narrow screens: start with the control panel collapsed so the map is visible first;
  // the floating toggle brings it back. Desktop is unaffected (the CSS rule is width-gated).
  if(window.innerWidth <= 900) document.body.classList.add("panel-collapsed");
  const pt = document.getElementById("panel-toggle");
  if(pt) pt.onclick = () => document.body.classList.toggle("panel-collapsed");
  Router.views.map = () => {};
  Router.init();
  Router.badge("audit", KB.reviewQueue.length || KB.totals().review);
  restoreHash();
  const v = (location.hash.match(/view=(\w+)/) || [])[1];
  if(v && v !== "map") Router.go(v);
})();
