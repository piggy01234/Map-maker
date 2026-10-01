/* MAP QUIZ MAKER — plain JavaScript. Leaflet and Supabase load from local files (leaflet.js, supabase.js, see index.html).
 * The image is the map, so Leaflet runs in CRS.Simple: shapes are stored as [y, x] image units.
 * Quizzes are saved in localStorage (and kept in memory if storage is blocked). */

const WORLD_IMAGE = "world-map.png";
const W = 2000, H = 1053.5, FULL = [[0, 0], [H, W]];
const REGIONS = { World: FULL };               // add more later: Europe: [[y1, x1], [y2, x2]]
const KEY = "mapquizmaker.v1";
const RED = "#c4452c", GOLD = "#e0a21b", GREEN = "#3d7a4f", INK = "#1f2b2e";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Inline icons (no icon library needed)
const PATHS = {
  back: '<path d="M15 18l-6-6 6-6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  area: '<path d="M4 9l8-5 8 6-3 9H7z"/>', cursor: '<path d="M5 3l14 7-6 2-2 6z"/>',
  play: '<path d="M7 4l13 8-13 8z"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>', undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
  retry: '<path d="M3 12a9 9 0 109-9 9 9 0 00-7 3M3 4v5h5"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
};
const ic = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${PATHS[n]}</svg>`;
$$("[data-ic]").forEach((el) => el.insertAdjacentHTML("afterbegin", ic(el.dataset.ic)));

// ---------- Data ----------
let LIB = [];
try { LIB = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) {}
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(LIB)); } catch (e) {} };
let Q = null;       // quiz being edited or played
let P = null;       // current play session
const V = { screen: "library", tool: "point", draft: [], sel: null, revealed: {}, armed: null, region: "World" };

// ---------- Cloud storage (Supabase) ----------
// Quizzes always save to this device. When config.js has real Supabase values they also sync to the cloud.
const CFG = window.SUPABASE_CONFIG || {};
let sb = null, cfgError = "";
if (!window.supabase) cfgError = "The Supabase library didn't load. Check the supabase script line in index.html. Saving on this device only";
else if (!CFG.url || !CFG.anonKey || /YOUR-|PASTE-/.test(CFG.url + CFG.anonKey)) cfgError = "Add your Supabase URL and key in config.js to sync. Saving on this device only";
else {
  try { sb = window.supabase.createClient(CFG.url, CFG.anonKey); }
  catch (e) { cfgError = "Supabase URL looks wrong (it must start with https://). Saving on this device only"; console.warn(e); }
}
let CLOUD = false;
const timers = {};

function setSync(text, on) { const el = $("#sync"); if (el) { el.textContent = text; el.classList.toggle("on", !!on); } }

// Turn Supabase errors into a plain-English next step (shown under the title on the library page)
function explain(e) {
  const m = String((e && (e.message || e.error_description)) || e);
  if (/anonymous/i.test(m)) return "Anonymous sign-ins are off. Turn them on in Supabase: Authentication > Sign In / Providers.";
  if (/schema cache|does not exist|relation/i.test(m)) return "The quizzes table wasn't found. Run the setup SQL in Supabase.";
  if (/row-level security|violates/i.test(m)) return "Supabase blocked the save (row-level security). Re-run the policies from the setup SQL.";
  if (/api key|apikey|jwt|forbidden/i.test(m)) return "Supabase rejected the key. Check anonKey in config.js (use the publishable key).";
  if (/fetch|network/i.test(m)) return "Couldn't reach Supabase. Check the URL in config.js.";
  return m;
}

async function pushQuiz(q) {
  if (!CLOUD) return;
  const { id, title, updated, ...data } = q;
  const { error } = await sb.from("quizzes").upsert({ id, title, data, updated_at: new Date(updated).toISOString() });
  if (error) { console.warn("Supabase save failed:", error.message); setSync("Cloud save failed: " + explain(error)); }
  else setSync("Synced with Supabase", true);
  if (Q === q) $("#ed-status").textContent = error ? "Saved on this device only" : "Saved";
}

function dropQuiz(id) {
  if (CLOUD) sb.from("quizzes").delete().eq("id", id).then(({ error }) => error && console.warn("Supabase delete failed:", error.message));
}

async function initCloud() {
  if (!sb) return setSync(cfgError || "Saving on this device only");
  setSync("Connecting to Supabase…");
  try {
    const { data: s } = await sb.auth.getSession();
    if (!s.session) { const r = await sb.auth.signInAnonymously(); if (r.error) throw r.error; }
    const { data, error } = await sb.from("quizzes").select("*");
    if (error) throw error;
    const cloud = data.map((r) => ({ ...r.data, id: r.id, title: r.title, updated: Date.parse(r.updated_at) }));
    const have = new Set(cloud.map((q) => q.id));
    const localOnly = LIB.filter((q) => !have.has(q.id));      // first run: upload what was saved on this device
    LIB = [...cloud, ...localOnly]; persist(); CLOUD = true;
    if (Q) Q = LIB.find((x) => x.id === Q.id) || Q;
    localOnly.forEach(pushQuiz);
    setSync("Synced with Supabase", true);
  } catch (e) {
    console.warn("Supabase unavailable:", e.message || e);
    setSync("Cloud unavailable: " + explain(e));
  }
  if (V.screen === "library") renderLibrary();
}

const touch = () => {
  Q.updated = Date.now(); persist();
  $("#ed-status").textContent = CLOUD ? "Saving…" : "Saved";
  if (CLOUD) { const q = Q; clearTimeout(timers[q.id]); timers[q.id] = setTimeout(() => pushQuiz(q), 700); }
};
const modeLabel = (q) => (q.reveal ? "Study mode" : q.type === "find" ? "Find the location" : "Name the location");

// ---------- Map ----------
const map = L.map("map", {
  crs: L.CRS.Simple, minZoom: -2, maxZoom: 2, zoomSnap: 0.25, zoomDelta: 0.5,
  maxBounds: L.latLngBounds(FULL).pad(0.12), maxBoundsViscosity: 1, renderer: L.svg({ padding: 1 }),
  doubleClickZoom: false, zoomControl: false, attributionControl: false,
});
L.imageOverlay(WORLD_IMAGE, FULL, { className: "world" }).addTo(map);
L.control.zoom({ position: "bottomleft" }).addTo(map);
const shapes = L.layerGroup().addTo(map);
const draftLayer = L.layerGroup().addTo(map);
const handleLayer = L.layerGroup().addTo(map);

function fit() {
  const side = innerWidth > 760 && V.screen === "editor" ? 340 : 16;
  map.fitBounds(REGIONS[V.region], { paddingTopLeft: [64, 72], paddingBottomRight: [side, 96] });
}

function colorOf(it) {
  if (V.screen === "editor") return V.sel === it.id ? GOLD : RED;
  const m = P && P.mark[it.id];
  return m === "ok" ? GREEN : m === "bad" ? INK : m === "ask" ? GOLD : V.revealed[it.id] ? GREEN : RED;
}

const clampLL = (ll) => [Math.min(H, Math.max(0, ll.lat)), Math.min(W, Math.max(0, ll.lng))];
const inMap = (ll) => ll.lat >= 0 && ll.lat <= H && ll.lng >= 0 && ll.lng <= W;
const dot = (cls, n) => L.divIcon({ className: "hdl " + cls, iconSize: [n, n] });
const layers = new Map();      // item id -> Leaflet layer. Updated in place so nothing flickers.

function drawShapes() {
  const live = Q && ["editor", "play"].includes(V.screen) ? Q.items : [];
  const ids = new Set(live.map((it) => it.id));
  for (const [id, l] of layers) if (!ids.has(id)) { shapes.removeLayer(l); layers.delete(id); }
  live.forEach((it) => {
    const c = colorOf(it), pt = it.type === "point";
    const style = pt ? { color: "#fff", weight: 2, fillColor: c, fillOpacity: 0.92 }
                     : { color: c, weight: c === GOLD ? 3 : 2, fillColor: c, fillOpacity: 0.4 };
    let l = layers.get(it.id);
    if (!l) {
      l = pt ? L.circleMarker(it.pts[0], { ...style, radius: Q.size, bubblingMouseEvents: false })
             : L.polygon(it.pts, { ...style, bubblingMouseEvents: false });
      l.on("click", (e) => onShape(it, e));
      l.addTo(shapes); layers.set(it.id, l);
    } else {
      l.setStyle(style);
      if (pt) { l.setRadius(Q.size); l.setLatLng(it.pts[0]); } else l.setLatLngs(it.pts);
    }
    const named = V.screen === "editor" || V.revealed[it.id] || (P && ["ok", "bad"].includes(P.mark[it.id]));
    const text = esc(it.name || "Unnamed");
    if (named) { if (l.getTooltip()) l.setTooltipContent(text); else l.bindTooltip(text, { permanent: true, direction: "top" }); }
    else if (l.getTooltip()) l.unbindTooltip();
  });
  $("#map").style.cursor = V.screen === "editor" && V.tool !== "select" ? "crosshair" : "";
  drawHandles();
}

// Select tool: the selected shape gets drag handles so it can be moved or reshaped
function drawHandles() {
  handleLayer.clearLayers();
  const editing = V.screen === "editor" && V.tool === "select";
  if (editing) renderStrip();
  const it = editing && Q.items.find((x) => x.id === V.sel);
  const lyr = it && layers.get(it.id);
  if (!lyr) return;
  const apply = () => (it.type === "point" ? lyr.setLatLng(it.pts[0]) : lyr.setLatLngs(it.pts));
  const done = () => { touch(); if (it.type === "area") { lyr.closeTooltip(); lyr.openTooltip(); } drawHandles(); };
  it.pts.forEach((p, i) => {
    const h = L.marker(p, { draggable: true, icon: dot("", 16) }).addTo(handleLayer);
    h.on("drag", () => { it.pts[i] = clampLL(h.getLatLng()); apply(); });
    h.on("dragend", done);
    if (it.type === "area") h.on("dblclick", () => { if (it.pts.length > 3) { it.pts.splice(i, 1); apply(); done(); } });
  });
  if (it.type !== "area") return;
  it.pts.forEach((p, i) => {                              // faint dots on each edge: drag or click to add a corner
    const q = it.pts[(i + 1) % it.pts.length];
    const h = L.marker([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], { draggable: true, icon: dot("mid", 10) }).addTo(handleLayer);
    const insert = () => { it.pts.splice(i + 1, 0, clampLL(h.getLatLng())); apply(); done(); };
    h.on("dragend", insert); h.on("click", insert);
  });
}

function drawDraft() {
  draftLayer.clearLayers();
  if (V.draft.length) {
    L.polyline(V.draft, { color: GOLD, weight: 2, dashArray: "6 6", interactive: false }).addTo(draftLayer);
    V.draft.forEach((p, i) => L.circleMarker(p, { radius: i ? 4 : 7, color: GOLD, fillOpacity: 1, interactive: false }).addTo(draftLayer));
  }
  renderStrip();
}

// ---------- Screens ----------
function go(screen) {
  V.screen = screen; V.draft = [];
  ["library", "editor", "play", "results"].forEach((n) => ($("#s-" + n).hidden = n !== screen));
  ({ library: renderLibrary, editor: renderEditor, play: renderPlay, results: renderResults })[screen]();
  requestAnimationFrame(() => { map.invalidateSize(); if (screen === "editor" || screen === "play") fit(); drawShapes(); drawDraft(); });
}

// 1 · Library
function renderLibrary() {
  const dots = (q) => q.items.map((it) => {
    const n = it.pts.length, y = it.pts.reduce((s, p) => s + p[0], 0) / n, x = it.pts.reduce((s, p) => s + p[1], 0) / n;
    return `<i style="left:${(x / W) * 100}%;top:${(1 - y / H) * 100}%"></i>`;
  }).join("");
  const cards = LIB.slice().sort((a, b) => b.updated - a.updated).map((q) => `
    <article class="card">
      <div class="thumb">${dots(q)}</div>
      <h3>${esc(q.title)}</h3>
      <p class="meta">${q.items.length} ${q.items.length === 1 ? "place" : "places"} · ${modeLabel(q)}</p>
      <div class="acts">
        <button class="b pri" data-act="play" data-id="${q.id}" ${q.items.length ? "" : "disabled"}>${ic("play")}Play</button>
        <button class="b" data-act="open" data-id="${q.id}">${ic("edit")}Edit</button>
        <button class="b ${V.armed === q.id ? "armed" : ""}" data-act="del" data-id="${q.id}" aria-label="Delete quiz">${V.armed === q.id ? "Delete?" : ic("trash")}</button>
      </div>
    </article>`).join("");
  $("#lib-grid").innerHTML = cards + `<button class="card new" data-act="new">${ic("plus")}New quiz</button>`;
}

// 2 · Editor
function renderEditor() {
  $("#ed-title").value = Q.title;
  $("#q-type").value = Q.type;
  $$(".switch").forEach((s) => s.setAttribute("aria-checked", !!Q[s.dataset.v]));
  const multi = Object.keys(REGIONS).length > 1;
  $("#region-f").hidden = !multi;
  if (multi) $("#q-region").innerHTML = Object.keys(REGIONS).map((r) => `<option>${r}</option>`).join("");
  $("#ed-status").textContent = "Saved";
  setTab(V.tab || "places"); syncTools(); renderList();
}

function setTab(t) {
  V.tab = t;
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === t));
  $("#tab-places").hidden = t !== "places"; $("#tab-quiz").hidden = t !== "quiz";
}
const syncTools = () => $$("[data-act=tool]").forEach((b) => b.classList.toggle("on", b.dataset.v === V.tool));

function renderList() {
  $("#list").innerHTML = Q.items.map((it) => `
    <li data-id="${it.id}" class="${V.sel === it.id ? "sel" : ""}">
      ${ic(it.type === "point" ? "pin" : "area")}
      <input value="${esc(it.name)}" placeholder="Place name" aria-label="Place name" data-in="name" />
      <button data-act="rm" data-id="${it.id}" aria-label="Delete place">${ic("trash")}</button>
    </li>`).join("");
  $("#n-places").textContent = Q.items.length;
  $("#empty").hidden = Q.items.length > 0;
  $("#clear").hidden = !Q.items.length;
  $("#clear").previousElementSibling.hidden = !Q.items.length;
}
const hiliteRows = () => $$("#list li").forEach((li) => li.classList.toggle("sel", li.dataset.id === V.sel));

function renderStrip() {
  const s = $("#strip");
  if (V.screen !== "editor") return (s.innerHTML = "");
  if (V.tool === "point") {
    s.innerHTML = `<span>Marker size</span><input type="range" min="4" max="30" value="${Q.size}" data-in="size" aria-label="Marker size" /><output id="size-out">${Q.size}</output>`;
  } else if (V.tool === "area") {
    s.innerHTML = V.draft.length
      ? `<span>${V.draft.length} corners</span>
         <button class="b" data-act="undo">${ic("undo")}Undo</button>
         <button class="b pri" data-act="finish" ${V.draft.length < 3 ? "disabled" : ""}>${ic("check")}Close shape</button>
         <button class="b" data-act="cancel">${ic("x")}Cancel</button>`
      : `<span>Click to add corners. Click the first dot or press Enter to close.</span>`;
  } else {
    const it = Q.items.find((x) => x.id === V.sel);
    s.innerHTML = !it ? `<span>Click a place on the map or in the list to edit it.</span>`
      : it.type === "point" ? `<span>Drag the dot to move this point.</span>`
      : `<span>Drag a corner to reshape. Drag a faint dot to add a corner. Double-click a corner to remove it.</span>`;
  }
}

function addItem(it) { Q.items.push(it); V.sel = it.id; touch(); renderList(); drawShapes(); }

function finishArea() {
  if (V.draft.length < 3) return;
  addItem({ id: uid(), type: "area", pts: V.draft, name: `Area ${Q.items.length + 1}` });
  V.draft = []; drawDraft();
}

function mapClick(ll) {
  if (V.screen !== "editor") return;
  if (V.tool === "select") { V.sel = null; hiliteRows(); drawShapes(); return; }
  if (!inMap(ll)) return;
  if (V.tool === "point") return addItem({ id: uid(), type: "point", pts: [[ll.lat, ll.lng]], name: `Place ${Q.items.length + 1}` });
  const near = V.draft.length >= 3 && map.latLngToContainerPoint(ll).distanceTo(map.latLngToContainerPoint(V.draft[0])) < 14;
  if (near) return finishArea();
  V.draft.push([ll.lat, ll.lng]); drawDraft();
}
map.on("click", (e) => mapClick(e.latlng));

function onShape(it, e) {
  if (V.screen === "editor") {
    if (V.tool !== "select") return mapClick(e.latlng);
    V.sel = it.id; hiliteRows(); return drawShapes();
  }
  if (V.screen !== "play" || !P) return;
  if (Q.reveal) { V.revealed[it.id] = true; return drawShapes(); }
  if (Q.type === "find" && !P.lock) answer(it.id === curItem().id, it.name, it);
}

// 3 · Play
const curItem = () => (P && !Q.reveal ? Q.items[P.order[P.i]] : null);

function startPlay(q, from) {
  Q = q;
  const order = q.items.map((_, i) => i);
  if (q.shuffle) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  P = { order, i: 0, score: 0, log: [], lock: false, mark: {}, from, fb: null };
  V.revealed = {};
  ask(); go("play");
}

function ask() {
  P.mark = {}; P.fb = null;
  const it = curItem();
  if (it && Q.type === "name") P.mark[it.id] = "ask";
}

function answer(ok, given, clicked, typo) {
  if (P.lock) return;
  const it = curItem();
  P.lock = true;
  P.log.push({ name: it.name, ok, given });
  if (ok) P.score++;
  P.mark = { [it.id]: "ok" };
  if (clicked && !ok) P.mark[clicked.id] = "bad";
  P.fb = { ok, name: it.name, typo };
  renderPlay(); drawShapes();
  setTimeout(() => {
    P.i++; P.lock = false;
    if (P.i >= Q.items.length) return go("results");
    ask(); renderPlay(); drawShapes();
  }, 1200);
}

const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
function dist(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}
// Capitals, accents and punctuation never count against you. With Spell check on, small typos are accepted too.
function judge(guess, name) {
  const g = norm(guess), t = norm(name);
  if (g && g === t) return "exact";
  if (Q.spell && g && t.length > 4 && dist(g, t) <= (t.length > 8 ? 2 : 1)) return "typo";
  return "no";
}

function submitName() {
  const box = $("#guess");
  if (!box || P.lock) return;
  const val = box.value.trim();
  const r = judge(val, curItem().name);
  answer(r !== "no", val || "(blank)", null, r === "typo");
}

function renderPlay() {
  $("#pl-title").textContent = Q.title;
  const n = Q.items.length;
  $("#pl-prog").textContent = Q.reveal ? "" : `${Math.min(P.i + 1, n)} of ${n} · ${P.score} correct`;
  $("#pl-bar").style.width = Q.reveal ? "0" : `${(P.i / n) * 100}%`;
  let h = "";
  if (Q.reveal) {
    h = `<p class="eyebrow">Study mode</p><p class="q">Click a place to reveal its name</p>
         <div class="row"><button class="b" data-act="hideAll">Hide all</button><button class="b pri" data-act="quit">Done</button></div>`;
  } else {
    const it = curItem();
    h = Q.type === "find"
      ? `<p class="eyebrow">Find on the map</p><p class="q">${esc(it.name || "Unnamed")}</p>`
      : `<p class="eyebrow">Name the highlighted ${it.type === "point" ? "point" : "area"}</p>
         <div class="row"><input id="guess" placeholder="Type your answer" autocomplete="off" ${P.lock ? "disabled" : ""} />
         <button class="b pri" data-act="check" ${P.lock ? "disabled" : ""}>Check</button></div>`;
    if (P.fb) h += `<p class="fb ${P.fb.ok ? "ok" : "no"}">${P.fb.ok ? (P.fb.typo ? `Correct. It's spelled ${esc(P.fb.name)}.` : "Correct") : `Not quite. That was ${esc(P.fb.name || "Unnamed")}.`}</p>`;
  }
  $("#pl-card").innerHTML = h;
  if ($("#guess") && !P.lock) $("#guess").focus();
}

// 4 · Results
function renderResults() {
  const n = Q.items.length, pct = P.score / n;
  $("#r-score").textContent = `${P.score} / ${n}`;
  $("#r-note").textContent = pct === 1 ? "A perfect round." : pct >= 0.7 ? "Solid. A few to revisit below." : pct >= 0.4 ? "Getting there. Another pass will help." : "Tough round. The answers are listed below.";
  $("#r-list").innerHTML = P.log.map((r) => `
    <li class="${r.ok ? "ok" : "no"}">${ic(r.ok ? "check" : "x")}<b>${esc(r.name || "Unnamed")}</b>${r.ok ? "" : `<span>You said ${esc(r.given)}</span>`}</li>`).join("");
}

// ---------- Actions (one delegated click handler) ----------
const ACT = {
  new() {
    Q = { id: uid(), title: "Untitled quiz", type: "find", reveal: false, shuffle: false, size: 10, items: [], updated: Date.now() };
    LIB.push(Q); persist(); V.sel = null; V.tool = "point"; go("editor");
  },
  open(d) { Q = LIB.find((q) => q.id === d.id); V.sel = null; go("editor"); },
  play(d) { startPlay(LIB.find((q) => q.id === d.id), "library"); },
  del(d) {
    if (V.armed !== d.id) { V.armed = d.id; setTimeout(() => { V.armed = null; if (V.screen === "library") renderLibrary(); }, 3000); return renderLibrary(); }
    LIB = LIB.filter((q) => q.id !== d.id); V.armed = null; persist(); dropQuiz(d.id); renderLibrary();
  },
  back() {
    if (!Q.items.length && Q.title === "Untitled quiz") { LIB = LIB.filter((q) => q !== Q); persist(); dropQuiz(Q.id); }
    go("library");
  },
  preview() { if (Q.items.length) startPlay(Q, "editor"); else $("#ed-status").textContent = "Add a place first"; },
  tool(d) { V.tool = d.v; V.draft = []; syncTools(); drawDraft(); drawShapes(); },
  tab(d) { setTab(d.v); },
  flag(d, el) { Q[d.v] = !Q[d.v]; el.setAttribute("aria-checked", Q[d.v]); touch(); },
  rm(d) { Q.items = Q.items.filter((x) => x.id !== d.id); if (V.sel === d.id) V.sel = null; touch(); renderList(); drawShapes(); },
  clear() { Q.items = []; V.sel = null; touch(); renderList(); drawShapes(); },
  undo() { V.draft.pop(); drawDraft(); },
  finish: finishArea,
  cancel() { V.draft = []; drawDraft(); },
  quit() { go(P.from === "editor" ? "editor" : "library"); },
  hideAll() { V.revealed = {}; drawShapes(); },
  check: submitName,
  again() { startPlay(Q, P.from); },
  resback() { go(P.from === "editor" ? "editor" : "library"); },
  zin() { map.zoomIn(1); },
  zout() { map.zoomOut(1); },
};
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (el && ACT[el.dataset.act]) ACT[el.dataset.act](el.dataset, el);
  else if (V.screen === "library" && V.armed) { V.armed = null; renderLibrary(); }
});

// Text inputs, sliders and selects
const INPUT = {
  title(el) { Q.title = el.value; touch(); },
  type(el) { Q.type = el.value; touch(); },
  region(el) { V.region = el.value; fit(); },
  size(el) { Q.size = +el.value; $("#size-out").textContent = Q.size; touch(); drawShapes(); },
  name(el) {
    const it = Q.items.find((x) => x.id === el.closest("li").dataset.id);
    it.name = el.value; touch(); drawShapes();
  },
};
document.addEventListener("input", (e) => { const k = e.target.dataset.in; if (k && INPUT[k]) INPUT[k](e.target); });
$("#list").addEventListener("focusin", (e) => {
  const li = e.target.closest("li");
  if (li) { V.sel = li.dataset.id; hiliteRows(); drawShapes(); }
});

document.addEventListener("keydown", (e) => {
  if (e.target.id === "guess" && e.key === "Enter") return submitName();
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (V.screen !== "editor") return;
  if (e.key === "Escape") { V.draft = []; drawDraft(); }
  if (e.key === "Enter" && V.tool === "area") finishArea();
});

go("library");
initCloud();