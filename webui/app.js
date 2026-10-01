"use strict";
// UI local servida por el puente. No lleva el token dentro: lo recibe del panel
// de la extension via postMessage. Asi el secreto solo vive en el codigo
// empaquetado de la extension, que es lo unico con permisos de moz-extension.

let TOKEN = "";
let TAB = null;          // indice de la pestana seleccionada
let MINE = false;       // el postMessage viene del panel real

const $ = (s) => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

// ---------- puente con la API ----------
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { "X-Zen-Live-Token": TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let body;
  try { body = await r.json(); } catch { throw new Error(`HTTP ${r.status} sin JSON`); }
  if (!r.ok || body.ok === false) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}
const send = (cmd, arg) => api("/api/cmd", { method: "POST", body: JSON.stringify({ cmd, arg }) });

// ---------- avisos ----------
function log(msg, err) {
  const d = el("div", err ? "err" : "", msg);
  $("#log").appendChild(d);
  setTimeout(() => d.remove(), err ? 6000 : 2600);
}

// ---------- render ----------
function renderTabs(list) {
  const s = $("#tabs");
  s.textContent = "";
  list.forEach((t, i) => {
    const o = el("option", null, `${i} · ${t.title || "(sin titulo)"}`);
    o.value = i;
    if (i === TAB) o.selected = true;
    s.appendChild(o);
  });
}

function renderMeta(active) {
  const m = $("#meta");
  m.textContent = "";
  if (!active) { m.textContent = "—"; return; }
  m.appendChild(el("b", null, active.title || "(sin titulo)"));
  m.appendChild(document.createTextNode("\n" + (active.url || "")));
}

function renderElements(list) {
  const box = $("#elements");
  box.textContent = "";
  $("#count").textContent = list.length;
  if (!list.length) {
    box.appendChild(el("p", "empty", "Sin elementos. Pulsa Anotar."));
    return;
  }
  list.forEach((it) => {
    const row = el("div", "el");
    row.appendChild(el("span", "n", it.n));
    row.appendChild(el("span", "t", it.text || it.sel || "(sin texto)"));
    row.appendChild(el("span", "tag", it.tag || ""));
    row.title = "Click en este elemento";
    row.onclick = async () => {
      try {
        await send("click-at", it.n);
        log(`click ${it.n}`);
        setTimeout(refresh, 450);
      } catch (e) { log(e.message, true); }
    };
    box.appendChild(row);
  });
}

// ---------- refresco ----------

// --- historial de acciones -------------------------------------------------
// El panel lista lo que el agente hizo y ofrece deshacer lo reversible. Las
// acciones irreversibles salen igual pero sin boton: es mas honesto que
// prometer un undo que no se puede hacer.
async function loadHistory() {
  const box = document.getElementById("history");
  if (!box) return;
  let items = [];
  try {
    const r = await fetch("/api/history?limit=40", { headers: { "X-Zen-Live-Token": TOKEN } });
    items = (await r.json()).history || [];
  } catch (e) {
    box.innerHTML = '<p class="empty">No se pudo leer el historial.</p>';
    return;
  }
  if (!items.length) { box.innerHTML = '<p class="empty">Sin acciones todavia.</p>'; return; }
  box.innerHTML = "";
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i];
    const row = document.createElement("div");
    row.className = "hrow" + (e.ok === false ? " bad" : "") + (e.undone ? " undone" : "");
    const when = new Date(e.ts * 1000).toLocaleTimeString("es", { hour12: false });
    row.innerHTML =
      '<span class="hcmd">' + e.cmd + '</span>' +
      '<span class="hlabel"></span>' +
      '<span class="htag">' + when + (e.tab != null ? " · #" + e.tab : "") + "</span>";
    row.querySelector(".hlabel").textContent = e.label || "";
    if (e.undo && !e.undone) {
      const b = document.createElement("button");
      b.className = "mini";
      b.textContent = "deshacer";
      b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await fetch("/api/undo", { method: "POST",
            headers: { "X-Zen-Live-Token": TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ id: e.id }) });
          const res = await r.json();
          log(res.ok ? ("deshecho: " + (res.deshecho || e.cmd)) : (res.error || "no se pudo deshacer"), !res.ok);
          loadHistory();
          refresh();
        } catch (err) { log("no se pudo deshacer: " + err.message, true); b.disabled = false; }
      };
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}

async function refresh() {
  try {
    const st = await api("/api/status");
    $("#dot").classList.toggle("on", !!st.extension);
    $("#ver").textContent = st.version || "";
    if (!st.extension) { log("extension desconectada", true); return; }

    const tb = await send("tabs");
    const list = (tb.tabs || []).filter((t) => /^https?:/.test(t.url || ""));
    if (TAB === null || TAB >= list.length) TAB = 0;
    renderTabs(list);
    renderMeta(list[TAB]);

    const [els, txt] = await Promise.all([
      send("interactive", TAB),
      send("text", { tab: TAB, limit: 900 }),
    ]);
    renderElements(els.elements || []);
    $("#text").textContent = (txt.text || "—").slice(0, 900);
  } catch (e) {
    $("#dot").classList.remove("on");
    log(e.message, true);
  }
}

// ---------- eventos ----------
$("#btn-annotate").onclick = async () => {
  try { const r = await send("annotate", TAB); log(`${r.count} anotados`); renderElements(r.elements || []); }
  catch (e) { log(e.message, true); }
};
$("#btn-clear").onclick = async () => {
  try { await send("annotate-clear", TAB); renderElements([]); log("limpio"); }
  catch (e) { log(e.message, true); }
};
$("#btn-refresh").onclick = refresh;
$("#tabs").onchange = (e) => { TAB = +e.target.value; refresh(); };
document.querySelectorAll("[data-go]").forEach((b) => {
  b.onclick = async () => {
    const g = b.dataset.go;
    try {
      if (g === "back") await send("back", TAB);
      else if (g === "forward") await send("forward", TAB);
      else if (g === "reload") await send("reload", TAB);
      else if (g === "scroll-dn") await send("scroll", { tab: TAB, dir: "down" });
      else if (g === "scroll-up") await send("scroll", { tab: TAB, dir: "up" });
      setTimeout(refresh, 500);
    } catch (e) { log(e.message, true); }
  };
});

// ---------- token desde el panel ----------
window.addEventListener("message", (ev) => {
  // Solo el panel de la extension puede inicializarnos. Si otra pagina iframea
  // /ui/, no puede trabajar sin token, y aunque mandara uno no seria el bueno.
  if (MINE || ev.data?.type !== "zen-live-init") return;
  TOKEN = ev.data.token || "";
  if (!TOKEN) { log("el panel no paso el token", true); return; }
  MINE = true;
  refresh();
  loadHistory();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  // El agente tambien actua desde el CLI, fuera del panel, asi que el
  // historial se refresca por su cuenta para que no aparezca congelado.
  setInterval(() => { if (MINE && !document.hidden) loadHistory(); }, 4000);
});

// No se llama refresh() al cargar: todavia no hay token, porque llega por
// postMessage del panel. Pedir datos aqui solo generaba un 401 espurio y un
// toast de error en cada apertura.
$("#st").textContent = "esperando al panel";
$("#hist-refresh")?.addEventListener("click", loadHistory);
