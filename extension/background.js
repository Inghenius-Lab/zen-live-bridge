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
browser.alarms.create("zen-live-keepalive", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState > WebSocket.OPEN) {
    clearTimeout(timer);
    connect();
  }
});

function activeTab() {
  return browser.tabs.query({ active: true, currentWindow: true }).then(ts => ts[0])
    .catch(() => browser.tabs.query({}).then(ts => ts[0]));
}

/* Eval wrapper: se serializa y se inyecta en la pestanya objetivo via
   scripting.executeScript. El codigo (string, IIFE que devuelve JSON)
   corre en el mundo aislado de la extension, igual que tabs.executeScript. */
function evalCode(code) { return eval(code); }

function execCode(tabId, code) {
  return browser.scripting.executeScript({ target: { tabId }, func: evalCode, args: [code] });
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
    try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
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
      return { ok: true, pong: true, name: "zen-live-bridge", version: "0.1.1" };

    case "tabs": {
      const tabs = await browser.tabs.query({});
      return { ok: true, tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, pinned: t.pinned, windowId: t.windowId })) };
    }

    case "goto": {
      const newTab = msg.new !== false;
      let tab;
      if (newTab) {
        tab = await browser.tabs.create({ url: msg.url, active: false });
      } else {
        tab = await activeTab();
        await browser.tabs.update(tab.id, { url: msg.url });
      }
      if (msg.wait) await sleep(Number(msg.wait));
      const info = await browser.tabs.get(tab.id);
      return { ok: true, tabId: tab.id, url: info.url, title: info.title };
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
      const code = SNAP_CODE.replace("__LIMIT__", String(msg.limit || 60000));
      const res = await execCode(tab.id, code);
      const data = JSON.parse(res[0].result);
      return { ok: true, tabId: tab.id, title: tab.title, url: tab.url, ...data };
    }

    case "click": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
      const res = await execCode(tab.id, clickCode(msg.sel, msg.text));
      const parsed = JSON.parse(res[0].result);
      if (parsed.ok && msg.wait) await sleep(Number(msg.wait));
      return { ok: parsed.ok, tabId: tab.id, ...parsed };
    }

    case "fill": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
      const res = await execCode(tab.id, fillCode(msg.sel, msg.value || "", !!msg.submit));
      const parsed = JSON.parse(res[0].result);
      if (parsed.ok && msg.wait) await sleep(Number(msg.wait));
      return { ok: parsed.ok, tabId: tab.id, ...parsed };
    }

    case "js": {
      const tab = await activeTab();
      if (!tab) return { ok: false, error: "sin pestanyas abiertas" };
      const wrap = `(() => { try { const v = (${msg.expr}); return JSON.stringify({ ok: true, value: (typeof v === 'string') ? v : JSON.stringify(v) }); } catch (e) { return JSON.stringify({ ok: false, error: String(e) }); } })()`;
      const res = await execCode(tab.id, wrap);
      return { ok: true, ...JSON.parse(res[0].result) };
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