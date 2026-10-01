"use strict";
// El panel es la unica pagina con permisos moz-extension, asi que es la que
// guarda el token. Se lo pasa al iframe por postMessage en vez de meterlo en la
// URL: la URL acaba en historiales, logs y en el "open in new tab".
const TOKEN = "__ZEN_LIVE_TOKEN__";
const UI = "http://127.0.0.1:8789/ui/";

const frame = document.getElementById("ui");
const st = document.getElementById("st");
const errBox = document.getElementById("err");

frame.addEventListener("load", () => {
  try {
    frame.contentWindow.postMessage({ type: "zen-live-init", token: TOKEN }, "*");
    errBox.style.display = "none";
  } catch (e) {
    errBox.style.display = "block";
    errBox.textContent = "No se pudo hablar con la UI: " + e.message;
  }
});

document.getElementById("open").onclick = () => browser.tabs.create({ url: UI });

// Si el puente no esta, el iframe no carga nada. Decirlo claro es mejor que
// mostrar un panel en blanco sin explicar por que.
fetch("http://127.0.0.1:8789/api/status", { headers: { "X-Zen-Live-Token": TOKEN } })
  .then((r) => r.json())
  .then((d) => { st.textContent = d.extension ? `ext v${d.version}` : "extension desconectada"; })
  .catch(() => {
    st.textContent = "puente caido";
    errBox.style.display = "block";
    errBox.textContent =
      "El puente local no responde en 127.0.0.1:8789.\n\n" +
      "Arrancalo con:\n  systemctl --user start zen-live-bridge.service";
  });
