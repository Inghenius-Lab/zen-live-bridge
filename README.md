# Zen Live Bridge

Controla tu **Firefox/Zen ABIERTO** (la instancia real, con tus sesiones y pestañas)
desde agentes locales vía una WebExtension + puente WebSocket/TCP. Todo queda en
`127.0.0.1`: nada sale de tu máquina.

## Componentes
- `extension/` — WebExtension (MV2, id `zen-live-bridge@elemental.local`). Conecta como cliente WS a `127.0.0.1:8788`.
- `zen-live-bridge.py` — servidor puente (WS 8788 + TCP 8787), cero dependencias.
- `zen-live` — CLI para agentes: habla por TCP 8787 en JSON lines.

## Instalación rápida
1. Arranca el puente: `zen-live serve`
2. Carga la extensión en Zen/Firefox:
   - Temporal: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `extension/manifest.json`
   - Permanente: con `xpinstall.signatures.required=false`, copia el `.xpi` a `<perfil>/extensions/zen-live-bridge@elemental.local.xpi`
3. Verifica: `zen-live status` → `extension: OK`

## Uso
```bash
zen-live status            # estado del puente y la extensión
zen-live tabs              # lista pestañas reales
zen-live goto URL [--new]  # abre pestaña en background (no roba foco)
zen-live text | snap       # lee texto / interactivos con selectores
zen-live scroll [PX] [--dir up|down] [--sel CSS] [--wait MS]  # scroll; reporta delta
zen-live key Enter|Ctrl+A [--sel CSS]    # teclas reales (+ requestSubmit en forms)
zen-live hover --sel CSS [--nth N]      # menus que solo abren al pasar el cursor
zen-live links [--filter DOMINIO]       # extrae hrefs (scraping/investigacion)
zen-live wait --sel CSS | --text T      # espera a que aparezca (SPAs lentas)
zen-live select --sel CSS --values a,b  # <select> nativo (casi nadie lo usa ya)
zen-live exists --sel CSS               # booleano sin eval, funciona bajo CSP
zen-live locate --sel CSS | --text T    # coordenadas SIN clicar (resuelve CSP)
zen-live annotate [--tab N]             # overlay numerado sobre los interactuables
zen-live click-at N                     # clic por indice del overlay
zen-live console [--clear]              # buffer de console de la pagina
zen-live set-range --sel CSS --value V  # input[type=range]; avisa si la pagina reescribe
# casi todos aceptan --tab N para no depender de la pestanya activa
zen-live click --sel CSS   # clic real
zen-live fill --sel CSS --value V [--submit]
zen-live js 'expr'         # evalúa JS en la pestaña activa
zen-live shot nombre       # captura PNG a /tmp/zen-shot/
zen-live cookies URL       # cookies de sesión (incluye httpOnly)
zen-live activate [TABID]  # marca pestaña activa
zen-live close TABID       # cierra pestaña creada por el agente
```

## Seguridad
- Escucha **solo** en localhost.
- La extensión habla únicamente con `ws://127.0.0.1:8788`.
- No envía nada a internet; no incluye telemetría.

## Licencia
MIT
