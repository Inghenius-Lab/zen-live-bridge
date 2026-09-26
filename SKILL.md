---
name: zen-live-bridge
description: "Controla el Zen ABIERTO del usuario (la instancia real, no otra copia) via WebExtension local + servidor WS/TCP. Usala cuando haga falta actuar sobre el navegador ya en marcha: tabs reales, DOM, cookies de sesion, screenshots, sin abrir ventanas nuevas ni robar foco. CLI: zen-live. Requiere la extension 'Zen Live Bridge' cargada en Zen."
---

# Zen Live Bridge — control del Zen abierto

Controla la **instancia de Zen que ya está corriendo** (la del usuario, con sus
pestañas y sesiones reales) mediante una WebExtension propia + un puente local.
No lanza navegadores, no abre ventanas, no roba el foco: `goto` abre pestaña en
background (`active:false`) por defecto.

> Sustituye a `zen-web-autopilot` (que controlaba una COPIA del perfil) y a
> Browser-Use/Playwright/geckodriver (que lanzan su propio navegador).
> Regla del usuario intacta: **prohibido** abrir navegador GUI/visible; esto no
> abre nada, actúa sobre lo que ya ves.

## Componentes
- `extension/` — WebExtension MV2 (`manifest.json` + `background.js`). Es la
  única pieza que se instala en Zen (temporal vía `about:debugging` o
  permanente). Conecta como cliente WS a `127.0.0.1:8788`.
- `scripts/zen-live-bridge.py` — servidor puente (WS 8788 + TCP 8790), zero
  dependencias, solo escucha localhost. (TCP se movió de 8787 → 8790 el 2026-09-23:
  8787 lo posee el stt-server del dictado, canónico del ecosistema. La extensión
  solo usa el WS 8788, así que no requiere reinstalación.)
- `scripts/zen-live` — CLI para los agentes (habla por TCP 8790 en JSON lines).

## Instalación (una vez por perfil de Zen)
1. Arranca el puente: `zen-live serve` (o el primer comando lo auto-arranca).
2. Carga la extensión en Zen: abre `about:debugging#/runtime/this-firefox`
   → **Load Temporary Add-on** → selecciona
   `~/.pi/agent/skills/zen-live-bridge/extension/manifest.json`.
   La extensión queda activa hasta que cierres Zen.
3. Comprueba: `zen-live status` → debe decir `extension: OK`.

Para que sobreviva a reinicios de Zen (instalación permanente), la extensión
debe estar firmada o el perfil debe permitir no firmadas
(`xpinstall.signatures.required = false` en `about:config`); luego copia el
directorio empaquetado como `.xpi` en las extensiones del perfil. Pregunta al
usuario antes de tocar su perfil.

## Uso (agente)
```bash
zen-live status
zen-live doctor                     # diagnóstico real (versión, APIs, ws state) (v0.4+)
zen-live tabs
zen-live goto "https://ejemplo.com"
zen-live goto URL --container "NAME"
zen-live goto URL --cookie-store "ID"
zen-live text --limit 20000
zen-live snap                       # texto + interactivos
zen-live snap-refs [--all]          # ÁRBOL A11Y CON REFS ESTABLES [eN] (v0.4+, estilo Playwright MCP)
zen-live click-ref e3               # click por ref (determinista, no por CSS selector) (v0.4+)
zen-live fill-ref e5 "texto" [--submit]  # fill por ref (v0.4+)
zen-live click --text "Enviar" --wait 800
zen-live fill --sel "input[name=q]" --value "hola" --submit
zen-live js 'document.title'
zen-live js 'EXPR' --allow-eval
zen-live shot captura
zen-live cookies https://x.com
zen-live list-containers
zen-live focus [tabId]
zen-live reload-ext
zen-live close 12
zen-live stop
```

## Patrón Anti-fricción — REGLA DE ORO (26-sep-2026, v0.4+)
**Para CUALQUIER edición en `extension/`**: re-empaquetar + reemplazar .xpi + reiniciar Zen. Las extensiones instaladas como .xpi NO se recargan con about:debugging (eso es solo para temporales).

```bash
cd ~/.local/share/skills-hub/zen-live-bridge/extension
sed -i 's/"version": "0.X.Y"/"version": "0.X.Z+1"/' manifest.json
zip -q -r /tmp/zen-live-bridge-X.Y.Z.xpi manifest.json background.js
cp /tmp/zen-live-bridge-X.Y.Z.xpi ~/.zen/oab93wh5.Default\ \(release\)/extensions/zen-live-bridge@elemental.local.xpi
rm -rf ~/.zen/oab93wh5.Default\ \(release\)/startupCache
cp /tmp/zen-live-bridge-X.Y.Z.xpi ~/.pi/agent/skills/zen-live-bridge/extension/
cp /tmp/zen-live-bridge-X.Y.Z.xpi ~/.hermes/skills/zen-live-bridge/extension/
# Avisar reiniciar Zen (el agente NO lo reinicia sin permiso si está corriendo).
```

**Verificación**: tras reiniciar, `zen-live doctor` debe reportar la nueva versión. Si sigue reportando la vieja → startupCache se olvidó o el .xpi no se reescribió.

## Disponibilidad permanente (26-sep-2026)
**systemd**: servicio `zen-live-bridge.service` ahora es `enabled=always`, `Restart=always` (no solo on-failure), `MemoryMax=96M` (RAM-safe), `OOMScoreAdjust=-500` (earlyoom friendly), `WatchdogSec=300`. **NO TOCAR durante optimizaciones RAM** — usa ~10-20MB en reposo, es infraestructura crítica del ecosistema.

**Endpoint canónico**: `~/.local/share/skills-hub/zen-live-bridge/scripts/zen-live-bridge.py` (skills-hub, no pi). Los otros 2 lugares son symlinks.

**RAM**: el servicio NO es on-demand, es always-on. Está en la lista de exclusiones de ram-watchdog (ver `~/.local/bin/ram-watchdog.sh`). Si alguna optimización lo mata, systemd lo respawna auto en 3s.

## Reglas
- **Nunca cerrar pestañas del usuario** a no ser que él lo pida; cerrar solo las
  que el agente creó (`goto --new` devuelve `tabId`).
- **No robar foco**: `goto` abre en background. No usar `activate` salvo que el
  usuario lo pida (trae la ventana al frente).
- **Prudencia con cuentas**: si vas a escribir con la sesión del usuario
  (publicar, enviar), leer
  `~/.pi/agent/skills/agent-reach/references/reglas-prudencia.md`, pausas
  humanas, parar ante 403/captcha/2FA, borrador a aprobar antes de enviar.
- **Verificar**, no dar por hecho: tras click/fill usa `snap`/`text` y busca la
  confirmación real en el DOM antes de reportar éxito.
- Al terminar la tarea: `zen-live stop` (el puente no debe quedar para siempre).
- Si `status` dice `extension: DESCONECTADA` → el usuario debe recargar la
  extensión en `about:debugging` (se pierde al cerrar Zen si es temporal) o
  Zen no la tiene cargada.

## Troubleshooting
- `connection refused` en el primer comando → `zen-live serve` falla: mira
  `~/.pi/agent/skills/zen-live-bridge/server.log`.
- Comandos responden `timeout` → la pestaña activa tiene un diálogo bloqueante
  (alert/confirm) o la página se colgó; avisa al usuario.
- `executeScript` puede fallar en `about:*`, páginas de extensión o Mozilla
  pages internas (sin permiso); navega primero a una página web normal.