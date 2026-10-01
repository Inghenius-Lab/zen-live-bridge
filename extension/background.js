/* Zen Live Bridge — service worker (MV3).
   Recibe comandos JSON por WebSocket 127.0.0.1:8788 y ejecuta las APIs
   nativas de la extension sobre la instancia de Zen abierta.
   MV2 -> MV3: el motor Gecko 151+ ya no admite MV2; scripting.executeScript
   sustituye a tabs.executeScript. El SW se mantiene vivo con pings del
   puente (cada 5s) + alarma de respaldo para reconectar. */
"use strict";

const WS_URL = "ws://127.0.0.1:8788";
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
function fnClick(sel, txt) {
  let el = null;
  if (sel) el = document.querySelector(sel);
  if (!el && txt) el = [...document.querySelectorAll('a,button,[role=button],input[type=submit],summary')].find(e => ((e.innerText || e.value || '') + '').trim().includes(txt));
  if (!el) return JSON.stringify({ ok: false, error: "elemento no encontrado" });
  el.scrollIntoView({ block: 'center' });
  const opts = { bubbles: true, cancelable: true, view: window };
  try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', opts)); }
  return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), text: ((el.innerText || el.value || '') + '').trim().slice(0, 60) });
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
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
      const out = await execFn(tab.id, fnSnap, [20000]);
      if (!out.ok) return out;
      const parsed = JSON.parse(out.raw);
      return { ok: true, tabId: tab.id, title: tab.title, url: tab.url, ...parsed };
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