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

El puente maneja la sesión ya autenticada del usuario, así que no es un detalle
cosmético. Kimi WebBridge documenta explícitamente que su puerto 10086 no tiene
frontera de seguridad ("any localhost process can connect"); aquí hay token.

**Cómo funciona**

- Token compartido en `~/.local/state/zen-live-bridge/token`, permisos `0600`,
  generado la primera vez con `secrets.token_urlsafe(32)`.
- El CLI lo lee en cada envío y lo manda en cada comando JSON.
- La extensión lo lleva en la query del WebSocket: `/?t=TOKEN`. Una
  WebExtension no puede leer archivos locales, así que `package.sh` lo inyecta
  al empaquetar. Por eso el `.xpi` está en `.gitignore`: lleva el secreto dentro.
- El WS también rechaza cualquier `Origin` que no sea `moz-extension://`.

**Qué protege y qué no, sin adornos**

| | |
|---|---|
| Protege | páginas web (no pueden leer un archivo `0600`), otros usuarios de la misma máquina, conexiones accidentales y el vector de red |
| NO protege | un proceso que ya corre como este usuario: puede leer el archivo del token igual que cualquier otra cosa |

Contra un atacante con ejecución como tu usuario ningún secreto en disco
sirve; haría falta aislamiento de procesos o un socket con permisos. Decirlo
claro es parte de la documentación, no una excusoria.

Ambos sockets hacen bind solo a `127.0.0.1`, así que no hay exposición a la LAN.
No se envía nada a internet; no hay telemetría.

**Verificado** con tres ataques y un caso legítimo:

```
proceso local sin token     -> ok: false, "token invalido"
página web (Origin falso)   -> HTTP/1.1 401 Unauthorized
token adivinado             -> HTTP/1.1 401 Unauthorized
CLI con el token correcto   -> lista las pestañas
```

**Rotar el token**

```bash
rm ~/.local/state/zen-live-bridge/token
systemctl --user restart zen-live-bridge.service
./package.sh --restart-zen        # re-inyecta el token nuevo en la extensión
```

## Empaquetar

```bash
./package.sh                  # solo construye el .xpi con el token inyectado
./package.sh --install        # además lo copia al perfil de Zen y borra startupCache
./package.sh --restart-zen    # y reinicia Zen con el entorno correcto
```

Zen no tiene `about:debugging`, así que recargar una extensión es empaquetar,
instalar y reiniciar el navegador entero. El proceso se llama `zen-bin`, no
`zen`: un `pkill -x zen` no hace nada. Y hace falta exportar `WAYLAND_DISPLAY`
del proceso vivo, porque un shell de agente puede no tenerla y entonces Zen
no relanza.

## Licencia
MIT
