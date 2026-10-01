/* Zen Live Bridge — service worker (MV3).
   Recibe comandos JSON por WebSocket 127.0.0.1:8788 y ejecuta las APIs
   nativas de la extension sobre la instancia de Zen abierta.
   MV2 -> MV3: el motor Gecko 151+ ya no admite MV2; scripting.executeScript
   sustituye a tabs.executeScript. El SW se mantiene vivo con pings del
   puente (cada 5s) + alarma de respaldo para reconectar. */
"use strict";

// El token lo inyecta package.sh al empaquetar: una WebExtension no puede
// leer archivos locales, asi que el secreto tiene que ir incrustado en el codigo
// empaquetado. Por eso __ZEN_LIVE_TOKEN__ NUNCA se commitea (ver .gitignore)
// y por eso rotarlo exige re-empaquetar, no solo reiniciar.
const WS_URL = "ws://127.0.0.1:8788/?t=__ZEN_LIVE_TOKEN__";
let ws = null;
let timer = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => console.log("[zen-live-bridge] conectado al puente local");
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || msg.id === 0) return; // keepalive del puente
    const resp = await handle(msg).catch(err => ({ ok: false, error: String((err && err.message) || err) }));
    try { ws.send(JSON.stringify({ id: msg.id, ...resp })); } catch (e) {}
  };
  ws.onclose = scheduleReconnect;
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function scheduleReconnect() {
  clearTimeout(timer);
  timer = setTimeout(connect, 2500);
}

// MV3: el service worker no es persistente -> alarma de respaldo que
// despierta el SW y reconecta si el WebSocket se cerro durante el sueno.
browser.alarms.create("zen-live-keepalive", { periodInMinutes: 0.5 });
browser.runtime.onStartup.addListener(() => connect());
browser.runtime.onInstalled.addListener(() => connect());
browser.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState > WebSocket.OPEN) {
    clearTimeout(timer);
    connect();
  }
});

async function activeTab() {
  try {
    const ts = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (ts && ts.length) return ts[0];
  } catch (e) {}
  try {
    const all = await browser.tabs.query({ active: true });
    if (all && all.length) return all[0];
  } catch (e) {}
  const anyTab = await browser.tabs.query({});
  return (anyTab && anyTab.length) ? anyTab[anyTab.length - 1] : null;
}

// ===== Funciones inyectables SIN eval (MV3-safe) =====
function fnText(limit) {
  return (document.body && document.body.innerText) ? document.body.innerText.slice(0, limit || 60000) : "";
}
function fnSnap(limit) {
  const text = (document.body && document.body.innerText) ? document.body.innerText.slice(0, limit || 20000) : "";
  const els = [...document.querySelectorAll('a,button,input,textarea,select,[role=button]')].slice(0, 90).map((e, i) => ({
    i,
    tag: e.tagName.toLowerCase(),
    text: ((e.innerText || e.value || e.placeholder || '') + '').trim().slice(0, 90),
    id: e.id || '',
    name: e.name || '',
    type: e.type || ''
  })).filter(x => x.text || x.tag === 'input' || x.tag === 'textarea');
  return JSON.stringify({ text, els });
}
/* ===== v0.6.0: capacidades que faltaban =====
   key     : teclas reales (Enter, Escape, flechas, Ctrl+...) via CDP-free
             dispatch a la pagina + browser.tabs API para atajos globales
   hover   : menús que solo abren al pasar el cursor
   wait    : esperar a que un selector o texto aparezca (SPAs lentas)
   links   : extraer todos los href de la pagina (investigacion/scraping)
   select  : elegir opcion de un <select>
   tabId   : todos los comandos pasan a aceptar la pestaña objetivo        */

function fnKey(keyName, mods, sel, value) {
  const parts = String(keyName).split('+');
  const k = parts[parts.length - 1];
  const m = { ctrl: mods.includes('ctrl'), alt: mods.includes('alt'),
              shift: mods.includes('shift'), meta: mods.includes('meta') };
  let el = sel ? document.querySelector(sel) : null;
  if (!el) {
    const ae = document.activeElement;
    el = (ae && ae !== document.body && ae.tagName !== 'BODY') ? ae : null;
  }
  if (el && typeof el.focus === 'function') { try { el.focus(); } catch (e) {} }
  const target = el || document.body;
  const init = { key: k, code: 'Key' + k.toUpperCase(), bubbles: true, cancelable: true,
                 ctrlKey: m.ctrl, altKey: m.alt, shiftKey: m.shift, metaKey: m.meta };
  try { target.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (e) {}
  try { target.dispatchEvent(new KeyboardEvent('keypress', init)); } catch (e) {}
  // Enter en un input debe disparar el submit del formulario
  if (k === 'Enter' && el && el.form && typeof el.form.requestSubmit === 'function') {
    try { el.form.requestSubmit(); } catch (e) {}
  }
  try { target.dispatchEvent(new KeyboardEvent('keyup', init)); } catch (e) {}
  return JSON.stringify({ ok: true, key: k, mods: m, onTag: el ? el.tagName.toLowerCase() : 'body' });
}

function fnHover(sel, nth) {
  let els = [...document.querySelectorAll(sel || '*')].filter(e => e.offsetWidth || e.offsetHeight);
  const el = (nth !== undefined && els[nth]) ? els[nth] : (els[0] || null);
  if (!el) return JSON.stringify({ ok: false, error: 'no encontrado para hover: ' + sel });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const o = { bubbles: true, cancelable: true, view: window,
              clientX: x, clientY: y, pointerType: 'mouse' };
  try { el.dispatchEvent(new PointerEvent('pointerover', o)); } catch (e) {}
  try { el.dispatchEvent(new MouseEvent('mouseover', o)); } catch (e) {}
  try { el.dispatchEvent(new PointerEvent('pointermove', o)); } catch (e) {}
  try { el.dispatchEvent(new MouseEvent('mousemove', o)); } catch (e) {}
  return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), x: Math.round(x), y: Math.round(y) });
}

function fnLinks(filter) {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!href || href.startsWith('javascript:')) continue;
    if (filter && href.indexOf(filter) === -1) continue;
    const txt = ((a.innerText || a.textContent || '') + '').trim().replace(/\s+/g, ' ');
    out.push({ href, text: txt.slice(0, 120) });
  }
  const seen = new Set(); const uniq = [];
  for (const l of out) { if (!seen.has(l.href)) { seen.add(l.href); uniq.push(l); } }
  return JSON.stringify({ ok: true, count: uniq.length, links: uniq.slice(0, 500) });
}

function fnExists(sel, text) {
  if (sel) {
    const el = document.querySelector(sel);
    return JSON.stringify({ ok: true, found: !!el, tag: el ? el.tagName.toLowerCase() : null });
  }
  const t = (document.body ? document.body.innerText : '') + '';
  return JSON.stringify({ ok: true, found: t.toLowerCase().indexOf(String(text).toLowerCase()) !== -1 });
}

function fnSelect(sel, values) {
  const el = document.querySelector(sel);
  if (!el) return JSON.stringify({ ok: false, error: 'select no encontrado: ' + sel });
  const vals = Array.isArray(values) ? values : [values];
  const done = [];
  for (const v of vals) {
    const opt = [...el.options].find(o => o.value === v || (o.textContent || '').trim() === v);
    if (opt) { opt.selected = true; done.push(v); }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ ok: true, applied: done, total: el.options.length });
}
function fnScroll(px, dir, sel) {
  const before = window.scrollY;
  const d = dir === 'up' ? -1 : 1;
  if (sel) {
    const el = document.querySelector(sel);
    if (el) { el.scrollIntoView({ block: dir === 'up' ? 'start' : 'end' }); }
  } else {
    window.scrollBy(0, d * Math.abs(px));
  }
  // scrollBy con comportamiento instantaneo: despues el render de la SPA
  // sigue, asi que el llamador debe dormir --wait antes de leer texto.
  return JSON.stringify({
    ok: true, before, after: window.scrollY,
    delta: window.scrollY - before,
    height: document.body ? document.body.scrollHeight : 0,
    matched: sel ? !!document.querySelector(sel) : null
  });
}
/* Una sola funcion inyectada. scripting.executeScript serializa la funcion y
   la ejecuta en la pagina: los helpers de fuera NO existen ahi dentro, por
   eso todo (helpers + dispatch) va dentro de esta unica funcion. */
function fnMaster(cmd, a, b, c) {
  const J = o => JSON.stringify(o);
  const box = el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return { r, vis: r.width > 0 && r.height > 0 &&
                   st.visibility !== 'hidden' && st.display !== 'none' };
  };
  const SEL = 'a[href],button,input:not([type=hidden]),textarea,select,summary,' +
    '[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true],[onclick]';
  const list = sel => [...document.querySelectorAll(sel || SEL)].filter(e => box(e).vis);
  const on = el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.readOnly;
  const label = el => ((el.innerText || el.value || el.textContent || '') + '').trim();

  // Click con coordenadas reales en TODOS los eventos, incluido el final.
  // HTMLElement.click() pone clientX/clientY en cero, y eso manda un arrastre
  // de slider o de barra de video a la posicion 0. Despues del click solo se
  // llama el() para checkbox/radio, que no cambian con un click sintetico.
  function doClick(el) {
    if (!on(el)) return { ok: false, error: 'elemento deshabilitado o read-only' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const o = { bubbles: true, cancelable: true, composed: true, view: window,
                clientX: x, clientY: y, button: 0, buttons: 1, detail: 1 };
    const up = Object.assign({}, o, { buttons: 0 });
    try { el.dispatchEvent(new PointerEvent('pointermove', up)); } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('mousemove', up)); } catch (e) {}
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', up)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', up));
    const chk = el.matches('input[type=checkbox],input[type=radio]') ? el.checked : null;
    el.dispatchEvent(new MouseEvent('click', up));
    if (chk !== null && el.checked === chk) { try { el.click(); } catch (e) {} }
    return { ok: true, tag: el.tagName.toLowerCase(), x: Math.round(x), y: Math.round(y),
             text: label(el).slice(0, 60) };
  }

  switch (cmd) {
    case 'click': {
      let el = null;
      if (a) {
        const els = list(a);
        el = (c !== null && els[c]) ? els[c] : (els[0] || document.querySelector(a));
      }
      if (!el && b) el = list(null).find(e => label(e).includes(b));
      if (!el) return J({ ok: false, error: 'elemento no encontrado' });
      return J(doClick(el));
    }
    // Localiza SIN clicar: cuando eval esta bloqueado por CSP, el agente pide
    // coordenadas y clica de verdad, sin buscar en el DOM con js.
    case 'locate': {
      let el = null;
      if (a) { const els = list(a); el = (c !== null && els[c]) ? els[c] : els[0]; }
      if (!el && b) {
        el = [...document.querySelectorAll('a,button,[role=button],summary,label,h1,h2,h3')]
          .find(e => label(e).includes(b));
      }
      if (!el) return J({ ok: false, error: 'no encontrado para locate' });
      const r = el.getBoundingClientRect();
      return J({ ok: true, tag: el.tagName.toLowerCase(),
                 x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 w: Math.round(r.width), h: Math.round(r.height),
                 inViewport: r.top >= 0 && r.bottom <= (window.innerHeight || 0),
                 text: label(el).slice(0, 70) });
    }
    // Overlay con numeros sobre cada interactuable, para que un agente con
    // vision vea la captura y luego haga click-at N. pointer-events:none.
    case 'annotate': {
      const old = document.getElementById('__zen_live_overlay');
      if (old) old.remove();
      if (a) return J({ ok: true, cleared: true });
      const ov = document.createElement('div');
      ov.id = '__zen_live_overlay';
      ov.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;' +
                         'z-index:2147483647;pointer-events:none';
      document.body.appendChild(ov);
      const items = [];
      list(null).slice(0, 60).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const L = r.left + window.scrollX, T = r.top + window.scrollY;
        const bx = document.createElement('div');
        bx.style.cssText = 'position:absolute;left:' + L + 'px;top:' + T + 'px;width:' +
          r.width + 'px;height:' + r.height + 'px;border:2px solid #d00;box-sizing:border-box';
        const lb = document.createElement('div');
        lb.textContent = String(i + 1);
        lb.style.cssText = 'position:absolute;left:' + (L - 2) + 'px;top:' + (T - 16) +
          'px;background:#d00;color:#fff;font:bold 11px monospace;padding:1px 3px;border-radius:2px';
        ov.appendChild(bx); ov.appendChild(lb);
        items.push({ n: i + 1, tag: el.tagName.toLowerCase(), text: label(el).slice(0, 50) });
      });
      return J({ ok: true, count: items.length, items });
    }
    case 'interactive': {
      // Listado puro, sin overlay. Lo usa el panel lateral, que ya muestra los
      // numeros en su propia lista y no quiere pintar cajas en la pagina real.
      const old = document.getElementById('__zen_live_overlay');
      if (old) old.remove();
      const els = list(a);
      return J({ ok: true, count: els.length,
                 elements: els.slice(0, 60).map((e, i) => ({ n: i + 1,
                   tag: e.tagName.toLowerCase(),
                   text: (e.getAttribute('aria-label') || label(e)).replace(/\s+/g, ' ').slice(0, 90) })) });
    }

    case 'annotate-clear': {
      const old = document.getElementById('__zen_live_overlay');
      if (old) old.remove();
      return J({ ok: true, cleared: true });
    }

    case 'click-at': {
      const el = list(null)[Number(a) - 1];
      if (!el) return J({ ok: false, error: 'indice fuera de rango: ' + a });
      const r = doClick(el);
      r.n = Number(a);
      return J(r);
    }
    // Buffer de console. Se instala en la primera llamada y vive en la
    // pagina; si hay navegacion se reinstala en la siguiente.
    case 'console': {
      const K = '__zenLiveConsole';
      if (!window[K]) {
        const ent = [];
        const ser = v => {
          const t = v === null ? 'null' : typeof v;
          if (t === 'string' || t === 'number' || t === 'boolean') return t + ':' + String(v);
          try { return t + ':' + JSON.stringify(v); } catch (e) { return t + ':' + String(v); }
        };
        for (const lv of ['log', 'info', 'warn', 'error', 'debug']) {
          const orig = console[lv] && console[lv].bind(console);
          if (!orig) continue;
          console[lv] = function () {
            try {
              ent.push({ type: lv, at: Date.now(),
                         text: Array.prototype.map.call(arguments, ser).join(' ').slice(0, 500) });
              if (ent.length > 500) ent.shift();
            } catch (e) {}
            return orig.apply(null, arguments);
          };
        }
        window[K] = ent;
      }
      const out = window[K].slice();
      if (b) window[K].length = 0;
      return J({ ok: true, count: out.length, entries: out.slice(-40) });
    }
    // Setter del prototype: si se asigna el .value a mano, los frameworks con
    // valor rastreado lo ignoran en silencio. observed != requested delata un
    // control que reescribio el valor, o sea que el set no sirvio.
    case 'set-range': {
      const els = [...document.querySelectorAll(a || 'input[type=range]')];
      const el = (c !== null && els[c]) ? els[c] : els[0];
      if (!el) return J({ ok: false, error: 'input[type=range] no encontrado' });
      if (!el.matches('input[type=range]'))
        return J({ ok: false, error: 'solo input[type=range]; para slider custom usa locate o click-at' });
      const mn = el.min === '' ? 0 : Number(el.min), mx = el.max === '' ? 100 : Number(el.max);
      const v = Number(b);
      if (!isFinite(v) || v < mn || v > mx)
        return J({ ok: false, error: 'valor fuera de rango ' + mn + '-' + mx });
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(el, String(v)); else el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return J({ ok: true, requested: v, observed: Number(el.value), min: mn, max: mx,
                 trusted: Math.abs(Number(el.value) - v) < 1e-6 });
    }
    case 'localstorage':
    case 'sessionstorage': {
      const store = cmd === 'localstorage' ? localStorage : sessionStorage;
      const action = String(a || 'list').toLowerCase();
      // 'list' devuelve SOLO claves. Los valores pueden ser tokens de sesion o
      // JWT, y listarlos los exponeria de un vistazo; leerlos es una accion
      // deliberada, uno por uno.
      if (action === 'list') {
        const keys = [];
        try { for (let i = 0; i < store.length; i++) keys.push(store.key(i)); }
        catch (e) { return J({ ok: false, error: 'no se pudo leer: ' + e.message }); }
        return J({ ok: true, action, count: keys.length, keys });
      }
      if (action === 'get') {
        if (!b) return J({ ok: false, error: 'hace falta la clave' });
        let v = null;
        try { v = store.getItem(b); } catch (e) { return J({ ok: false, error: e.message }); }
        return J({ ok: true, action, key: b, found: v !== null, value: v });
      }
      if (action === 'set') {
        if (!b) return J({ ok: false, error: 'hace falta la clave' });
        try { store.setItem(b, c === undefined || c === null ? '' : String(c)); }
        catch (e) {
          // Cuota excedida es el fallo tipico y el error real no lo dice claro.
          return J({ ok: false, error: 'no se pudo guardar: ' + e.message,
                     hint: /quota/i.test(e.message) ? 'localStorage lleno (5-10MB)' : null });
        }
        return J({ ok: true, action, key: b });
      }
      if (action === 'delete') {
        if (!b) return J({ ok: false, error: 'hace falta la clave' });
        try { store.removeItem(b); } catch (e) { return J({ ok: false, error: e.message }); }
        return J({ ok: true, action, key: b });
      }
      if (action === 'clear') {
        try { store.clear(); } catch (e) { return J({ ok: false, error: e.message }); }
        return J({ ok: true, action });
      }
      return J({ ok: false, error: 'accion desconocida: ' + action +
                 ' (list|get|set|delete|clear)' });
    }
    case 'storage-clear': {
      const r = { local: false, session: false };
      try { localStorage.clear(); r.local = true; } catch (e) {}
      try { sessionStorage.clear(); r.session = true; } catch (e) {}
      return J({ ok: true, ...r });
    }
    case 'network': {
      let entries = [];
      try { entries = performance.getEntriesByType('resource'); }
      catch (e) { return J({ ok: false, error: 'no se pudo leer: ' + e.message }); }
      // Las URLs llevan tokens en el query string (access_token, sig, key...).
      // Se ocultan antes de devolver nada: un log de red es justo el sitio donde
      // un token se cuela en un archivo de texto y se comparte sin querer.
      const SECRETS = /^(access_?token|token|key|api_?key|sig|signature|password|passwd|pwd|auth|session|sessionid|sid|jwt|bearer)$/i;
      let redacted = 0;
      const clean = u => {
        try {
          const url = new URL(u, location.href);
          if (!url.search) return url.href;
          let touched = false;
          for (const k of [...url.searchParams.keys()]) {
            if (SECRETS.test(k)) { url.searchParams.set(k, '***redacted***'); touched = true; }
          }
          if (touched) redacted++;
          return url.href;
        } catch (e) { return String(u).slice(0, 300); }
      };
      const kind = n => n === 'fetch' || n === 'xmlhttprequest' ? 'xhr'
        : /\.(js|mjs|css)\b/i.test(n) ? 'asset'
        : /\.(png|jpe?g|gif|svg|webp|avif|ico)\b/i.test(n) ? 'img'
        : /\.(woff2?|ttf|otf|eot)\b/i.test(n) ? 'font' : n;
      let items = entries.map(e => ({
        url: clean(e.name),
        kind: kind(e.initiatorType || ''),
        status: e.responseStatus || 0,      // 0 = cacheado o no informado
        size: e.transferSize || e.encodedBodySize || 0,
        ms: Math.round(e.duration * 10) / 10,
      }));
      if (b) { const f = String(b).toLowerCase(); items = items.filter(i => i.url.toLowerCase().indexOf(f) !== -1); }
      const cap = c ? Math.max(1, Number(c) || 50) : 50;
      items = items.slice(-cap);   // las mas recientes
      return J({ ok: true, total: entries.length, count: items.length, items, redacted });
    }
    case 'css': {
      const el = a ? document.querySelector(a) : null;
      if (!el) return J({ ok: false, error: 'no se encontro el selector' });
      const cs = getComputedStyle(el);
      const props = { color: cs.color, 'background-color': cs.backgroundColor,
        'font-family': cs.fontFamily, 'font-size': cs.fontSize, 'font-weight': cs.fontWeight,
        display: cs.display, position: cs.position, visibility: cs.visibility,
        opacity: cs.opacity, width: cs.width, height: cs.height,
        'margin-top': cs.marginTop, 'margin-bottom': cs.marginBottom,
        'padding-top': cs.paddingTop, 'border-radius': cs.borderRadius,
        'z-index': cs.zIndex, overflow: cs.overflow };
      const r = el.getBoundingClientRect();
      return J({ ok: true, selector: a, tag: el.tagName.toLowerCase(), styles: props,
                 box: { x: Math.round(r.x), y: Math.round(r.y),
                        w: Math.round(r.width), h: Math.round(r.height) } });
    }
    case 'exists': {
      if (a) {
        const el = document.querySelector(a);
        return J({ ok: true, found: !!el, tag: el ? el.tagName.toLowerCase() : null });
      }
      const t = (document.body ? document.body.innerText : '') + '';
      return J({ ok: true, found: t.toLowerCase().indexOf(String(b).toLowerCase()) !== -1 });
    }
    case 'select': {
      const el = document.querySelector(a);
      if (!el) return J({ ok: false, error: 'select no encontrado: ' + a });
      const vals = Array.isArray(b) ? b : [b];
      const done = [];
      for (const v of vals) {
        const o = [...el.options].find(x => x.value === v || (x.textContent || '').trim() === v);
        if (o) { o.selected = true; done.push(v); }
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return J({ ok: true, applied: done, total: el.options.length });
    }
    default:
      return J({ ok: false, error: 'comando desconocido: ' + cmd });
  }
}

function fnExists(sel, text) {
  if (sel) {
    const el = document.querySelector(sel);
    return JSON.stringify({ ok: true, found: !!el, tag: el ? el.tagName.toLowerCase() : null });
  }
  const t = (document.body ? document.body.innerText : '') + '';
  return JSON.stringify({ ok: true, found: t.toLowerCase().indexOf(String(text).toLowerCase()) !== -1 });
}

function fnSelect(sel, values) {
  const el = document.querySelector(sel);
  if (!el) return JSON.stringify({ ok: false, error: 'select no encontrado: ' + sel });
  const vals = Array.isArray(values) ? values : [values];
  const done = [];
  for (const v of vals) {
    const opt = [...el.options].find(o => o.value === v || (o.textContent || '').trim() === v);
    if (opt) { opt.selected = true; done.push(v); }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ ok: true, applied: done, total: el.options.length });
}
function fnScroll(px, dir, sel) {
  const before = window.scrollY;
  const d = dir === 'up' ? -1 : 1;
  if (sel) {
    const el = document.querySelector(sel);
    if (el) { el.scrollIntoView({ block: dir === 'up' ? 'start' : 'end' }); }
  } else {
    window.scrollBy(0, d * Math.abs(px));
  }
  // scrollBy con comportamiento instantaneo: despues el render de la SPA
  // sigue, asi que el llamador debe dormir --wait antes de leer texto.
  return JSON.stringify({
    ok: true, before, after: window.scrollY,
    delta: window.scrollY - before,
    height: document.body ? document.body.scrollHeight : 0,
    matched: sel ? !!document.querySelector(sel) : null
  });
}
function interactable(el) {
  return el.matches('a[href],button,input:not([type=hidden]),textarea,select,summary,' +
    '[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true],[onclick]') ||
    (el.tagName === 'A' && el.href);
}
function visibleBox(el) {
  const r = el.getBoundingClientRect();
  const vis = (r.width > 0 && r.height > 0) &&
    (getComputedStyle(el).visibility !== 'hidden') &&
    (getComputedStyle(el).display !== 'none');
  return { r, vis };
}
function enabledEl(el) {
  return !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.readOnly;
}
// Enumeracion determinista: la misma para annotate y para click-at, de modo
// que el indice N significa el mismo elemento en ambas llamadas mientras el
// DOM no cambie.
function interactiveList(sel) {
  const sel2 = sel || 'a[href],button,input:not([type=hidden]),textarea,select,summary,' +
    '[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true],[onclick]';
  return [...document.querySelectorAll(sel2)].filter(e => visibleBox(e).vis);
}

function fnClick(sel, txt, nth) {
  let el = null;
  if (sel) {
    const els = interactiveList(sel);
    el = (nth !== undefined && els[nth]) ? els[nth] : (els[0] || document.querySelector(sel));
  }
  if (!el && txt) {
    el = [...document.querySelectorAll('a,button,[role=button],input[type=submit],summary')]
      .find(e => ((e.innerText || e.value || '') + '').trim().includes(txt));
  }
  if (!el) return JSON.stringify({ ok: false, error: 'elemento no encontrado' });
  if (!enabledEl(el)) return JSON.stringify({ ok: false, error: 'elemento deshabilitado o read-only' });
  const { r } = visibleBox(el);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2, y = box.top + box.height / 2;
  const o = { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: x, clientY: y, button: 0, buttons: 1, detail: 1 };
  // Secuencia completa con coordenadas en TODOS los eventos, incluido el
  // click final. HTMLElement.click() pone las coordenadas en cero y eso
  // rompe los sliders (el arrastre de un video o una barra de progreso se
  // va a 0). Ademas se pierde la activacion nativa, asi que despues del
  // click solo se llama el() para checkbox/radio que no cambian de estado
  // con un click sintetico.
  try { el.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, o, { buttons: 0 }))); } catch (e) {}
  try { el.dispatchEvent(new MouseEvent('mousemove', Object.assign({}, o, { buttons: 0 }))); } catch (e) {}
  try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mousedown', o));
  try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { buttons: 0 }))); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, { buttons: 0 })));
  const check = el.matches('input[type=checkbox],input[type=radio]') ? el.checked : null;
  el.dispatchEvent(new MouseEvent('click', Object.assign({}, o, { buttons: 0 })));
  if (check !== null && el.checked === check) { try { el.click(); } catch (e) {} }
  return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), x: Math.round(x), y: Math.round(y),
                          text: ((el.innerText || el.value || '') + '').trim().slice(0, 60) });
}

// Localiza SIN hacer clic. Sirve cuando eval esta bloqueado por CSP: en vez
// de buscar en el DOM con js, el agente pide coordenadas y hace clic real.
function fnClickAt(n) {
  const idx = Number(n) - 1;
  const el = interactiveList(null)[idx];
  if (!el) return JSON.stringify({ ok: false, error: 'indice fuera de rango: ' + n });
  if (!enabledEl(el)) return JSON.stringify({ ok: false, error: 'elemento deshabilitado' });
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2, y = box.top + box.height / 2;
  const o = { bubbles: true, cancelable: true, composed: true, view: window,
              clientX: x, clientY: y, button: 0, buttons: 1, detail: 1 };
  try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mousedown', o));
  try { el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, o, { buttons: 0 }))); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, { buttons: 0 })));
  const check = el.matches('input[type=checkbox],input[type=radio]') ? el.checked : null;
  el.dispatchEvent(new MouseEvent('click', Object.assign({}, o, { buttons: 0 })));
  if (check !== null && el.checked === check) { try { el.click(); } catch (e) {} }
  return JSON.stringify({ ok: true, n: Number(n), tag: el.tagName.toLowerCase(),
                          x: Math.round(x), y: Math.round(y),
                          text: ((el.innerText || el.value || '') + '').trim().slice(0, 50) });
}

// Captura de console. Se instala la primera vez y se queda en la pagina; si
// hay navegacion se pierde y se reinstala en la siguiente llamada.
function fnConsole(clear) {
  const KEY = '__zenLiveConsole';
  if (!window[KEY]) {
    const entries = [];
    const ser = v => {
      const t = v === null ? 'null' : typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') return t + ':' + String(v);
      try { return t + ':' + JSON.stringify(v); } catch (e) { return t + ':' + String(v); }
    };
    for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) {
      const orig = console[lvl] && console[lvl].bind(console);
      if (!orig) continue;
      console[lvl] = function () {
        try {
          entries.push({ type: lvl, text: [...arguments].map(ser).join(' ').slice(0, 500),
                         at: Date.now() });
          if (entries.length > 500) entries.shift();
        } catch (e) {}
        return orig.apply(null, arguments);
      };
    }
    window[KEY] = entries;
  }
  const out = window[KEY].slice();
  if (clear) window[KEY].length = 0;
  return JSON.stringify({ ok: true, count: out.length, entries: out.slice(-40) });
}

function fnSetRange(sel, value, nth) {
  const els = [...document.querySelectorAll(sel || 'input[type=range]')];
  const el = (nth !== undefined && els[nth]) ? els[nth] : els[0];
  if (!el) return JSON.stringify({ ok: false, error: 'input[type=range] no encontrado' });
  if (!el.matches('input[type=range]'))
    return JSON.stringify({ ok: false, error: 'solo input[type=range]; para sliders custom usa click-at o locate' });
  const min = el.min === '' ? 0 : Number(el.min), max = el.max === '' ? 100 : Number(el.max);
  const v = Number(value);
  if (!isFinite(v) || v < min || v > max)
    return JSON.stringify({ ok: false, error: 'valor fuera de rango ' + min + '-' + max });
  // Setter del prototype: si no, los frameworks con valor rastreado lo ignoran.
  const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (d && d.set) d.set.call(el, String(v)); else el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  // observed != requested delata un slider que reescribio el valor: no es
  // trustworthy afirmar exito sin mirar observed.
  return JSON.stringify({ ok: true, requested: v, observed: Number(el.value),
                          min, max, trusted: Math.abs(Number(el.value) - v) < 1e-6 });
}

function fnFill(sel, value, submitEnter, nth) {
  let els = sel ? [...document.querySelectorAll(sel)].filter(e => e.offsetWidth || e.isContentEditable) : [];
  let el = (nth !== undefined && els[nth]) ? els[nth] : (els[0] || null);
  if (!el && sel) el = document.querySelector(sel);
  if (!el) return JSON.stringify({ ok: false, error: "campo no encontrado: " + sel });
  if (el.isContentEditable) {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  } else {
    const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (submitEnter) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  }
  return JSON.stringify({ ok: true, value: value });
}
function deepQueryAll(sel, roots) {
  const out = [];
  const walk = (root) => {
    let found;
    try { found = root.querySelectorAll(sel); } catch (e) { return; }
    out.push(...found);
    [...root.querySelectorAll('*')].forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  (roots || [document]).forEach(walk);
  return out;
}
function setNativeValue(el, value) {
  const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
              : (el instanceof HTMLInputElement) ? HTMLInputElement.prototype
              : null;
  if (el.isContentEditable || !proto) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  } else {
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function fnShadowFill(sel, value, submitEnter) {
  const parts = sel.split('>>>').map(s => s.trim());
  let host = document.querySelector(parts[0]);
  if (!host) return JSON.stringify({ ok: false, error: "host no encontrado: " + parts[0] });
  let root = host.shadowRoot, el = null;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!root) return JSON.stringify({ ok: false, error: "sin shadowRoot en nivel " + i });
    host = root.querySelector(parts[i]);
    if (!host) return JSON.stringify({ ok: false, error: "nivel no encontrado: " + parts[i] });
    root = host.shadowRoot;
  }
  if (parts.length > 1) {
    if (!root) return JSON.stringify({ ok: false, error: "shadowRoot final ausente" });
    el = root.querySelector(parts[parts.length - 1]);
  } else {
    el = deepQueryAll(parts[0])[0] || null;
  }
  if (!el) return JSON.stringify({ ok: false, error: "campo no encontrado en shadow: " + sel });
  try { el.focus(); } catch (e) {}
  el.scrollIntoView({ block: 'center' });
  setNativeValue(el, value);
  if (submitEnter) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  }
  return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), value: String(value).slice(0, 60) });
}
function fnInputValue(sel) {
  const el = sel ? document.querySelector(sel) : null;
  if (!el) {
    // buscar cualquier input con value AIza
    const inputs = [...document.querySelectorAll('input')].filter(i => i.offsetWidth && (i.value || '').startsWith('AIza'));
    return JSON.stringify({ ok: inputs.length > 0, value: inputs.length ? inputs[0].value : '' });
  }
  return JSON.stringify({ ok: true, value: el.value || '' });
}

async function execFn(tabId, fn, args) {
  try {
    let rr = await browser.scripting.executeScript({ target: { tabId }, func: fn, args: args });
    let r0 = (rr || []).find(r => r && r.result !== undefined && r.result !== null);
    if (!r0) {
      try { rr = await browser.scripting.executeScript({ target: { tabId, allFrames: true }, func: fn, args: args });
            r0 = (rr || []).find(r => r && r.result !== undefined && r.result !== null); } catch (_) {}
    }
    if (!r0) return { ok: false, error: 'exec vacio' };
    const v = r0.result;
    return { ok: true, raw: typeof v === 'string' ? v : JSON.stringify(v) };
  } catch (e) {
    return { ok: false, error: 'exec error: ' + String(e).slice(0, 250) };
  }
}


/* Eval wrapper: se serializa y se inyecta en la pestanya objetivo via
   scripting.executeScript. El codigo (string, IIFE que devuelve JSON)
   corre en el mundo aislado de la extension, igual que tabs.executeScript. */
function evalCode(code) { return eval(code); }

/* ===== TIER 1 (26-sep): A11y snapshot con refs estables estilo Playwright MCP =====
   fnSnapRefs: devuelve árbol de elementos interactivos con ref=eN único por DOM actual.
   El agente lee la lista, elige por texto/role y actúa con clickRef/fillRef por ref.
   Menos tokens que screenshot, más determinista que click por selector genérico. */
function fnSnapRefs() {
  const FOCUSABLE = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=combobox],[role=checkbox],[role=radio],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const els = [];
  const seen = new Set();
  // Limpiar refs previos (snapshot stale)
  try { document.querySelectorAll('[data-agent-ref]').forEach(e => delete e.dataset.agentRef); } catch (e) {}
  document.querySelectorAll(FOCUSABLE).forEach((el) => {
    try {
      if (seen.has(el)) return;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) === 0) return;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? (el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox') : tag === 'textarea' ? 'textbox' : tag === 'select' ? 'combobox' : '');
      const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').trim().slice(0, 100);
      const ref = 'e' + els.length;
      try { el.dataset.agentRef = ref; } catch (e) {}
      els.push({
        ref, tag, role, name,
        id: el.id || '',
        type: el.type || '',
        href: el.href || '',
        inViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth
      });
    } catch (e) {}
  });
  return JSON.stringify({ ok: true, url: location.href, title: document.title, els });
}

function fnClickRef(ref) {
  const el = document.querySelector('[data-agent-ref="' + ref + '"]');
  if (!el) return JSON.stringify({ ok: false, error: 'ref no encontrado: ' + ref + ' (snapshot stale, vuelve a snapRefs)' });
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const opts = { bubbles: true, cancelable: true, view: window };
  try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', opts)); }
  const changed = { url: location.href, focused: document.activeElement === el };
  return JSON.stringify({ ok: true, ref, tag: el.tagName.toLowerCase(), whatChanged: changed });
}

function fnFillRef(ref, value, submitEnter) {
  const el = document.querySelector('[data-agent-ref="' + ref + '"]');
  if (!el) return JSON.stringify({ ok: false, error: 'ref no encontrado: ' + ref });
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  if (el.isContentEditable) {
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  } else {
    const setter = (Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value') || {}).set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (submitEnter) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    if (el.form) try { el.form.requestSubmit(); } catch (e) {}
  }
  return JSON.stringify({ ok: true, ref, value: el.value || el.innerText });
}

/* TIER 4: doctor — auto-diagnóstico y auto-curación. Devuelve checklist. */
const DOCTOR_CODE = `(() => {
  const prov = { ok: true, checks: {} };
  try { prov.checks.manifestVersion = browser.runtime.getManifest().version; } catch (e) { prov.checks.manifestVersion = 'error: ' + e.message; }
  try { prov.checks.hasContextualIdentities = !!browser.contextualIdentities; } catch (e) { prov.checks.hasContextualIdentities = false; }
  try { prov.checks.hasScripting = !!browser.scripting; } catch (e) { prov.checks.hasScripting = false; }
  try { prov.checks.hasCookiesAPI = !!browser.cookies; } catch (e) { prov.checks.hasCookiesAPI = false; }
  try { prov.checks.hasTabsAPI = !!browser.tabs; } catch (e) { prov.checks.hasTabsAPI = false; }
  try { prov.checks.wsState = (typeof ws !== 'undefined' && ws) ? ws.readyState : 'ws-no-definido'; } catch (e) { prov.checks.wsState = 'desconocido'; }
  return JSON.stringify(prov);
})()`;

function doctorCode() { return DOCTOR_CODE; }

async function execCode(tabId, code) {
  try {
    let rr;
    try {
      rr = await browser.scripting.executeScript({ target: { tabId }, func: evalCode, args: [code] });
    } catch (e1) {
      try {
        rr = await browser.scripting.executeScript({ target: { tabId, allFrames: true }, func: evalCode, args: [code] });
      } catch (e2) {
        return { ok: false, error: 'exec fallo doble: ' + String(e1).slice(0,120) + ' / ' + String(e2).slice(0,120) };
      }
    }
    if (!rr || !rr.length) return { ok: false, error: 'exec vacio', detalle: JSON.stringify(rr || []).slice(0, 400) };
    for (const r of rr) {
      if (r && typeof r.result === 'string' && r.result.length) return { ok: true, raw: r.result };
    }
    // resultado no-string pero definido
    const r0 = rr.find(r => r && r.result !== undefined && r.result !== null);
    if (r0) return { ok: true, raw: typeof r0.result === 'string' ? r0.result : JSON.stringify({ ok: true, value: r0.result }) };
    return { ok: false, error: 'exec sin string', detalle: JSON.stringify(rr).slice(0, 300) };
  } catch (e) {
    return { ok: false, error: 'exec error: ' + String(e).slice(0, 250) };
  }
}

const SNAP_CODE = `(() => {
  const text = (document.body && document.body.innerText) ? document.body.innerText.slice(0, __LIMIT__) : "";
  const els = [...document.querySelectorAll('a,button,input,textarea,select,[role=button]')].slice(0, 90).map((e, i) => ({
    i,
    tag: e.tagName.toLowerCase(),
    text: (e.innerText || e.value || e.placeholder || '').trim().slice(0, 90),
    css: (function(){ try { if (e.id) return '#' + e.id; let p = e, s = '', k = 0; while (p && p !== document.body && k < 5) { const c = [...p.parentElement.children].indexOf(p); s = '> :nth-child(' + (c + 1) + ')' + s; p = p.parentElement; k++; } return 'body ' + s; } catch (e) { return ''; } })()
  })).filter(x => x.text || x.tag === 'input' || x.tag === 'textarea');
  return JSON.stringify({ text, els });
})()`;

function clickCode(sel, text) {
  return `(() => {
    let el = null;
    const sel = ${JSON.stringify(sel || "")}; const txt = ${JSON.stringify(text || "")};
    if (sel) el = document.querySelector(sel);
    if (!el && txt) el = [...document.querySelectorAll('a,button,[role=button],input[type=submit],summary')].find(e => (e.innerText || e.value || '').trim() === txt);
    if (!el) return JSON.stringify({ ok: false, error: "elemento no encontrado" });
    el.scrollIntoView({ block: 'center' });
    const opts = { bubbles: true, cancelable: true, view: window };
  try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', opts)); }
    return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim().slice(0, 60) });
  })()`;
}

function fillCode(sel, value, submit) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return JSON.stringify({ ok: false, error: "campo no encontrado: " + ${JSON.stringify(sel)} });
    const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (${submit ? "true" : "false"}) {
      const kd = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
      const ku = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true });
      el.dispatchEvent(kd); el.dispatchEvent(ku);
    }
    return JSON.stringify({ ok: true, value: ${JSON.stringify(value)} });
  })()`;
}

async function handle(msg) {
  switch (msg.cmd) {
    case "ping":
      let _v = "?"; try { _v = browser.runtime.getManifest().version; } catch (e) {}
      return { ok: true, pong: true, name: "zen-live-bridge", version: _v };

    case "tabs": {
      const tabs = await browser.tabs.query({});
      return { ok: true, tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, pinned: t.pinned, windowId: t.windowId })) };
    }

    case "goto": {
      const newTab = msg.new !== false;
      let tab;
      if (newTab) {
        const opts = { url: msg.url, active: false };
        if (msg.cookieStoreId) {
          opts.cookieStoreId = msg.cookieStoreId;
        } else if (msg.container) {
          if (browser.contextualIdentities && browser.contextualIdentities.query) {
            const ids = await browser.contextualIdentities.query({ name: msg.container });
            if (ids && ids[0]) opts.cookieStoreId = ids[0].cookieStoreId;
          }
        }
        tab = await browser.tabs.create(opts);
      } else {
        tab = await activeTab();
        await browser.tabs.update(tab.id, { url: msg.url });
      }
      if (msg.wait) await sleep(Number(msg.wait));
      const info = await browser.tabs.get(tab.id);
      return { ok: true, tabId: tab.id, url: info.url, title: info.title, cookieStoreId: tab.cookieStoreId };
    }

    case "activate": {
      const tabId = msg.tabId || (await activeTab()).id;
      await browser.tabs.update(tabId, { active: true });
      return { ok: true, tabId };
    }

    case "text":
    case "snap": {
      const tab = msg.tabId ? (await browser.tabs.get(msg.tabId)) : (await activeTab());
      if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
      const out = await execFn(tab.id, fnSnap, [20000]);
      if (!out.ok) return out;
      const parsed = JSON.parse(out.raw);
      return { ok: true, tabId: tab.id, title: tab.title, url: tab.url, ...parsed };
    }


case "key": {
      const tab = msg.tabId || (await activeTab()).id;
      const keyName = String(msg.key || "").split(/[,+\s]+/).filter(Boolean);
      const mods = keyName.slice(0, -1).map(s => s.toLowerCase());
      const k = keyName[keyName.length - 1];
      const out = await execFn(tab, fnKey, [k, mods, msg.sel || "", msg.value || ""]);
      if (!out.ok) return out;
      return { ok: true, tabId: tab, ...JSON.parse(out.raw) };
    }

    case "hover": {
      const tab = msg.tabId || (await activeTab()).id;
      const out = await execFn(tab, fnHover, [msg.sel || "", msg.nth]);
      if (!out.ok) return out;
      return { ok: true, tabId: tab, ...JSON.parse(out.raw) };
    }

    case "links": {
      const tab = msg.tabId || (await activeTab()).id;
      const out = await execFn(tab, fnLinks, [msg.filter || ""]);
      if (!out.ok) return out;
      return { ok: true, tabId: tab, ...JSON.parse(out.raw) };
    }

    case "locate":
    case "annotate":
    case "interactive":
    case "localstorage":
    case "sessionstorage":
    case "storage-clear":
    case "network":
    case "css": {
      // Estos van por fnMaster (se inyectan en la pagina): leen del DOM.
      const tab = msg.tabId || (await activeTab()).id;
      const out = await execFn(tab, fnMaster,
        [msg.cmd,
         msg.sel !== undefined ? msg.sel : (msg.text !== undefined ? msg.text : (msg.action || "")),
         msg.text !== undefined ? msg.text : (msg.key !== undefined ? msg.key : ""),
         msg.value !== undefined ? msg.value : msg.limit]);
      if (!out.ok) return out;
      return { ok: true, tabId: tab, ...JSON.parse(out.raw) };
    }

    case "annotate-clear":
    case "click-at":
    case "console":
    case "set-range":
    case "exists":
    case "select": {
      const tab = msg.tabId || (await activeTab()).id;
      const out = await execFn(tab, fnMaster,
        [msg.cmd, msg.sel !== undefined ? msg.sel : (msg.text !== undefined ? msg.text : msg.n),
         msg.text !== undefined ? msg.text : (msg.value !== undefined ? msg.value : !!msg.clear),
         msg.nth !== undefined ? msg.nth : null]);
      if (!out.ok) return out;
      return { ok: true, tabId: tab, ...JSON.parse(out.raw) };
    }

    case "resize": {
      // Va por browser.windows, no por el DOM: es estado del navegador, no de la
      // pagina. Se devuelve el tamano REAL tras el cambio, no el pedido, porque
      // el sistema puede ignorarlo (maximizar, pantallas multiples).
      const tabId = msg.tabId != null ? msg.tabId : (await activeTab()).id;
      try {
        const t = await browser.tabs.get(tabId);
        if (!t || t.windowId == null) return { ok: false, error: "la pestana no tiene ventana" };
        const patch = {};
        if (msg.width)  patch.width  = Math.max(320, Math.round(msg.width));
        if (msg.height) patch.height = Math.max(240, Math.round(msg.height));
        if (!patch.width && !patch.height) return { ok: false, error: "hace falta --width o --height" };
        const w = await browser.windows.update(t.windowId, patch);
        return { ok: true, tabId, windowId: t.windowId,
                 width: w.width, height: w.height, state: w.state };
      } catch (e) {
        return { ok: false, error: "resize: " + String(e && e.message || e).slice(0, 180) };
      }
    }

    case "back":
    case "forward":
    case "reload": {
      // These go through the tabs API, not a content script: no need to inject
      // anything into the page, and it works even if the page is mid-load.
      const tab = msg.tabId !== undefined && msg.tabId !== null ? msg.tabId : (await activeTab()).id;
      try {
        if (msg.cmd === "reload") await browser.tabs.reload(tab);
        else if (msg.cmd === "back") await browser.tabs.goBack(tab);
        else await browser.tabs.goForward(tab);
        return { ok: true, tabId: tab, cmd: msg.cmd };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    case "click": {
      const tab = msg.tabId || (await activeTab()).id;
      const out = await execFn(tab, fnMaster, ["click", msg.sel || "", msg.text || "", msg.nth ?? null]);
      if (!out.ok) return out;
      return { ok: true, tabId: tab, ...JSON.parse(out.raw) };
    }

    case "scroll": {
      const tab = msg.tabId || (await activeTab()).id;
      const out = await execFn(tab, fnScroll, [msg.px || 1200, msg.dir || "down", msg.sel || ""]);
      if (!out.ok) return out;
      return { ok: true, tabId: tab, ...JSON.parse(out.raw) };
    }

    case "click": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
      const out = await execFn(tab.id, fnClick, [msg.sel || "", msg.text || ""]);
      const parsed = JSON.parse(out.raw);
      if (parsed.ok && msg.wait) await sleep(Number(msg.wait));
      return { ok: parsed.ok, tabId: tab.id, ...parsed };
    }

    case "fill": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
      const out = await execFn(tab.id, fnFill, [msg.sel, msg.value || "", !!msg.submit, (msg.nth === undefined ? 0 : msg.nth)]);
      const parsed = JSON.parse(out.raw);
      if (parsed.ok && msg.wait) await sleep(Number(msg.wait));
      return { ok: parsed.ok, tabId: tab.id, ...parsed };
    }

    case "shadowfill": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
      const out = await execFn(tab.id, fnShadowFill, [msg.sel, msg.value || "", !!msg.submit]);
      if (!out.ok) return out;
      const parsed = JSON.parse(out.raw);
      if (parsed.ok && msg.wait) await sleep(Number(msg.wait));
      return { ok: parsed.ok, tabId: tab.id, ...parsed };
    }

    case "js": {
      // MV3-safe: expresiones pre-autorizadas (sin eval), o snippet corto via Function
      const e = String(msg.expr || "");
      let v;
      try {
        if (/^document\.title$/.test(e)) v = document.title;
        else if (/^location\.href$/.test(e)) v = location.href;
        else if (/^document\.body\.innerText$/.test(e)) v = document.body ? document.body.innerText : "";
        else if (msg.allowEval) {
          // OPT-IN explícito del agente: ejecuta snippet arbitrario en la pestaña activa.
          // Restringido: se ejecuta via scripting.executeScript con Function (no eval directo sobre la ext),
          // el permiso lo tiene la extensión pero aquí marcamos la intención.
          const tab = await activeTab();
          if (!tab) return { ok: false, error: "sin pestaña activa" };
          const result = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: (code) => { try { return Promise.resolve(eval(code)).then(r => ({ ok: true, value: String(r).slice(0, 4000) })); } catch (e2) { return { ok: false, error: String(e2).slice(0, 200) }; } },
            args: [e]
          });
          return result && result[0] && result[0].result ? result[0].result : { ok: false, error: "sin resultado" };
        }
        else return { ok: false, error: "js: expresión no whitelist. Añade allowEval:true para eval arbitrario." };
      } catch (e3) { return { ok: false, error: String(e3).slice(0,200) }; }
      return { ok: true, value: v };
    }

    case "listContainers": {
      if (!browser.contextualIdentities || !browser.contextualIdentities.query) {
        return { ok: false, error: "contextualIdentities no disponible" };
      }
      const list = await browser.contextualIdentities.query({});
      return { ok: true, containers: list.map(c => ({ name: c.name, cookieStoreId: c.cookieStoreId, color: c.color, icon: c.icon })) };
    }

    case "openInContainer": {
      if (!browser.contextualIdentities || !browser.contextualIdentities.query) {
        return { ok: false, error: "contextualIdentities no disponible. Añade el permiso al manifest." };
      }
      const url = msg.url; const contName = msg.container || "";
      const ids = await browser.contextualIdentities.query({ name: contName });
      if (!ids || !ids[0]) return { ok: false, error: "contenedor no encontrado: " + contName };
      const tab = await browser.tabs.create({ url, cookieStoreId: ids[0].cookieStoreId, active: msg.active !== false });
      return { ok: true, tabId: tab.id, container: contName, cookieStoreId: ids[0].cookieStoreId };
    }

    case "cookiesFor": {
      const url = msg.url;
      const store = msg.cookieStoreId ? { storeId: msg.cookieStoreId } : {};
      const list = await browser.cookies.getAll({ url, ...store });
      return { ok: true, count: list.length, cookies: list.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite })) };
    }

    case "focus": {
      const tabId = msg.tabId;
      if (tabId) {
        await browser.tabs.update(tabId, { active: true });
        const t = await browser.tabs.get(tabId);
        if (t && t.windowId) await browser.windows.update(t.windowId, { focused: true });
        return { ok: true, tabId };
      }
      const t = await activeTab();
      if (t && t.windowId) await browser.windows.update(t.windowId, { focused: true });
      return { ok: true, tabId: t && t.id };
    }

    case "screenshot": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestaña activa" };
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { ok: true, format: "png", base64: dataUrl.split(",")[1] };
    }

    case "reloadExt": {
      await browser.runtime.reload();
      return { ok: true, reloading: true };
    }

    case "snapRefs": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestaña activa" };
      const out = await execFn(tab.id, fnSnapRefs, []);
      if (!out.ok) return out;
      try { return JSON.parse(out.raw); } catch (e) { return { ok: false, error: "parse snapRefs: " + String(e).slice(0,150), raw: out.raw && out.raw.slice(0,300) }; }
    }

    case "clickRef": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestaña activa" };
      const out = await execFn(tab.id, fnClickRef, [msg.ref || ""]);
      if (!out.ok) return out;
      try { return JSON.parse(out.raw); } catch (e) { return { ok: false, error: "parse clickRef" }; }
    }

    case "fillRef": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestaña activa" };
      const out = await execFn(tab.id, fnFillRef, [msg.ref || "", msg.value || "", !!msg.submit]);
      if (!out.ok) return out;
      try { return JSON.parse(out.raw); } catch (e) { return { ok: false, error: "parse fillRef" }; }
    }

    case "doctor": {
      // Auto-diagnóstico: corre dentro del contexto de la extension (no en pestaña)
      // Devuelve estado real de APIs, manifest version, ws — usado por agentes para
      // detectar version mismatch antes de intentar acciones que fallarían.
      try {
        const m = browser.runtime.getManifest();
        const checks = {
          version: m.version,
          manifest: m.manifest_version,
          ws: (ws && ws.readyState) || 'sin ws',
          perms: {
            contextualIdentities: !!browser.contextualIdentities,
            scripting: !!browser.scripting,
            cookies: !!browser.cookies,
            tabs: !!browser.tabs,
            alarms: !!browser.alarms
          }
        };
        return { ok: true, checks };
      } catch (e) { return { ok: false, error: String(e).slice(0,200) }; }
    }

    case "shutdownZen": {
      const wins = await browser.windows.getAll();
      for (const w of wins) await browser.windows.remove(w.id);
      return { ok: true, closed: wins.length };
    }
    case "inputvalue": {
      try {
        const tab = await activeTab();
        if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
        const out = await execFn(tab.id, fnInputValue, [msg.sel || ""]);
        let parsed = {};
        try { parsed = JSON.parse(out.raw); } catch (e) { parsed = { ok: false, error: 'raw invalido' }; }
        return { ok: !!out.ok && !!parsed.ok, value: parsed.value || '', tabId: tab.id, error: parsed.error || (out && out.error) || '' };
      } catch (e) {
        return { ok: false, error: 'inputvalue: ' + String(e).slice(0, 150) };
      }
    }

    case "shot": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
      const dataUrl = await browser.tabs.captureTab(tab.id);
      return { ok: true, tabId: tab.id, dataUrl };
    }

    case "cookies": {
      const cs = await browser.cookies.getAll({ url: msg.url || undefined });
      return { ok: true, cookies: cs.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, session: c.session })) };
    }

    case "close": {
      if (msg.tabId) await browser.tabs.remove(msg.tabId);
      return { ok: true };
    }

    default:
      return { ok: false, error: "comando desconocido: " + msg.cmd };
  }
}

connect();

// Click en el icono. Con solo sidebar_action, si la extension no esta fijada en
// la barra el icono no hace nada: el sidebar_action no registra onClicked. Un
// action sin popup si lo hace, asi que este es el unico que responde.
if (browser.action && browser.action.onClicked && browser.sidebarAction) {
  browser.action.onClicked.addListener(async () => {
    try {
      await browser.sidebarAction.open();
    } catch (e) {
      console.error("zen-live: no se pudo abrir el sidebar:", e && e.message);
    }
  });
}
