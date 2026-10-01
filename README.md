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

## Panel lateral

`Ctrl+E` en Zen abre el panel. Es una extension normal con `sidebar_action`, asi
que aparece en la barra de extensiones con su icono y tambien se puede anclar.

La UI **no va dentro del xpi**: el puente la sirve desde `webui/` en el puerto
8789 y el panel la mete en un iframe. Eso se puede notar: se edita `webui/*.css`
en caliente y se recarga, sin reempaquetar nada. La unica excepcion es el token,
que si viaja en el codigo empaquetado porque una WebExtension no puede leer
archivos locales.

```
Ctrl+E
  panel.html  (moz-extension://, unico sitio con el token)
    └─ iframe → http://127.0.0.1:8789/ui/
         └─ fetch /api/*  →  puente  →  WS 8788  →  extension  →  pagina
```

El token viaja del panel al iframe por `postMessage`, no en la query: una URL con
el secreto acaba en historiales y logs. La web servida en `/ui/` no lo lleva
dentro; sin el `postMessage` se queda sin API y lo dice, en vez de pedir datos y
recibir un 401.

### Comandos que usa

| | |
|---|---|
| `interactive` | lista los elementos interactivos **sin** dibujar cajas en la pagina |
| `annotate` | numerarlos tambien sobre la pagina, para trabajar con una captura |
| `annotate-clear` | quitar el overlay |
| `click-at N` | pulsar el numero N |
| `back` `forward` `reload` | navegacion via la API de pestanas, sin inyectar script |

`interactive` y `annotate` salen del mismo recorrido determinista del DOM, asi que
el numero N es el mismo elemento en ambos. Si divergieran, un clic desde el panel
podria dar en otro sitio que el que el agente ve numerado.

### Puertos

| | |
|---|---|
| 8788 | WebSocket de la extension (exige token + `Origin: moz-extension://`) |
| 8789 | HTTP: UI en `/ui/` y API en `/api/*` (esta exige token) |
| 8790 | CLI, JSON delimitado por saltos de linea (exige token) |

El HTTP va en puerto aparte a proposito: meter HTTP y JSON-linea en el mismo puerto
obliga a sniffear los primeros bytes y es fragil. `/ui/` se sirve sin token porque
es maquetacion vacia; lo unico que manda algo al navegador es `/api/`.

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

## Historial y deshacer

Un agente con tu sesion real es una caja negra si no deja rastro. Cada accion
que pasa por el panel se guarda en memoria (ultimas 200) y aparece en la
seccion **Acciones**, con la hora y la pestaña.

Lo que **se puede** deshacer desde ahi:

| Accion | Como se revierte |
|---|---|
| `goto` / `back` / `forward` | historial del navegador |
| `scroll` | scroll en sentido contrario |
| `fill` / `shadowfill` / `set-range` | se guarda el valor previo del DOM antes de actuar |
| `annotate` / `annotate-clear` | la contraparte |

Lo que **no**: `click`, enviar, borrar. Se registran igual pero sin boton de
deshacer, porque no existe vuelta atras. Es preferible que el panel lo diga
a que prometa un undo que miente.

```bash
curl -H "X-Zen-Live-Token: $(cat ~/.local/state/zen-live-bridge/token)" \
     'http://127.0.0.1:8789/api/history?limit=20'

curl -X POST -H "X-Zen-Live-Token: $(cat ~/.local/state/zen-live-bridge/token)" \
     -H 'Content-Type: application/json' -d '{"id":3}' \
     http://127.0.0.1:8789/api/undo
```

El historial vive **en memoria del proceso**: al reiniciar el puente se
pierde. Es deliberado, no se escribe nada a disco.

## Almacenamiento, red y estilos (v0.10)

```bash
zen-live localstorage list --tab N              # solo claves
zen-live localstorage get CLAVE --tab N
zen-live localstorage set CLAVE VALOR --tab N
zen-live sessionstorage clear --tab N
zen-live storage-clear --tab N                  # ambos de golpe

zen-live network --limit 40 --tab N             # peticiones de la pagina
zen-live network api.github.com --tab N         # filtrar por subcadena
zen-live css h1 --tab N                         # estilos computados
zen-live resize --width 1400 --height 900       # redimensiona la ventana
```

**`list` devuelve solo claves, nunca valores.** Un volcado de localStorage suele
traer tokens de sesion y JWT; leerlos tiene que ser una accion deliberada
(`get CLAVE`), no el efecto secundario de listar.

**`network` oculta los tokens del query string** antes de devolver nada
(`access_token`, `sig`, `api_key`, `password`, `jwt`, ...). Un log de red es
justo el sitio donde un token se cuela en un archivo y se comparte sin querer.
Los parametros normales (`page`, `sort`, `user`) se conservan: oculta lo
sensible sin volver la salida inusable. Devuelve el contador `redacted` para
saber si limpio algo.

`css` y `resize` van por APIs de extension (`getComputedStyle`,
`browser.windows`), no por inyeccion: uno lee estilos calculados y el otro
cambia el estado de la ventana.

## Historial del navegador (v0.11)

```bash
zen-live history                          # 20 mas recientes
zen-live history github --limit 5         # filtrar por texto
zen-live history "open code" --limit 3    # el filtro acepta varias palabras
```

Usa `browser.history.search` (permiso `history`), no el DOM: funciona en
cualquier pestana sin navegar a ella. Devuelve titulo, URL y ultima visita.

**Que aporta frente a otras piezas del sistema.** `recall` ya leia el
historial, asi que esto no es lo mismo:

| Herramienta | Guarda | Pregunta que responde |
|---|---|---|
| `recall` | `places.sqlite` + shell (atuin) | *¿que he estado buscando?* |
| `zen-live history` | historial de Zen, con filtro | *¿que paginas concrete conozco?* |
| `/api/history` | acciones del agente | *¿que he **hecho** en el navegador?* |

Las tres encadenan: `recall "tema"` -> `zen-live history TEMA` -> `goto URL`
para volver a una pagina sin buscarla de nuevo. `history` es el puente entre
"me acuerdo de que estuve ahi" y "vuelve alla".

## Codigos de verificacion desde el correo (`otp`)

```bash
./otp                      # cuenta por defecto (morales), ultimos 15 min
./otp kike --minutes 30    # otra cuenta y otra ventana
./otp --all                # sin filtrar por remitente/asunto (ruidoso)
```

Imprime **solo el codigo** por stdout. No se guarda en ningun sitio: ni en el
historial de zen-live, ni en el log del puente, ni en ningun fichero. Cada
llamada relee el correo, asi que no hay estado entre invocaciones.

```bash
CODE=$(./otp morales) && zen-live fill '#code' "$CODE" --tab N
```


## v0.11 — Safety Guards

Un agente con tu sesion real puede escribir en paginas, pulsar botones y
navegar. Estos guards acotan eso. **Los guards 1 y 2 estan siempre activos**;
los 3, 4 y 5 se configuran y el 6 se escribe solo.

```bash
zen-live guards                     # estado actual de los guards
zen-live readonly on|off            # modo lectura (off por defecto)
zen-live ratelimit N                # maximo de escrituras por minuto (120)
zen-live audit [--limit N]          # ultimas decisiones
zen-live goto URL --confirm-token T # repetir un comando en sitio protegido
```

### 1. Esquema de URL (`url-scheme`) — siempre activo

`goto` (y `openInContainer`) solo aceptan `http:` y `https:`, mas `about:blank`.
Todo lo demas se rechaza **antes** de abrir la pestana.

Es una **lista blanca**, no negra: `file:`, `javascript:`, `data:`, `blob:`,
`moz-extension:`, `chrome:`, `resource:`, `view-source:`, `jar:`, `ftp:` y el
resto de `about:` quedan fuera. Una lista negra dejaria pasar cualquier esquema
que se invente mañana.

```bash
zen-live goto 'file:///etc/passwd'
# {"ok":false,"guard":"url-scheme","error":"guard: esquema file: bloqueado (leeria ficheros del disco local). Solo se permite http:// y https://","denied":"file:"}
```

### 2. Campo de contrasena (`password-field`) — siempre activo

`fill`, `fill-ref` y `shadowfill` se niegan a escribir si el elemento es
`input[type=password]` o tiene `autocomplete` `current-password` / `new-password`.

**No se lee el valor: solo se rechaza.** No hace falta leer contrasenas para no
escribirlas, y no existe API WebExtension para leerlas.

```bash
zen-live fill --sel '#p' --value 'hunter2'
# {"ok":false,"guard":"password-field","error":"escrito rechazado: campo de contrasena (usa el gestor de contrasenas del navegador)"}
```

Limite honesto: un `input[type=text]` que en realidad sea una contrasena
disfrazada pasa el guard. Cubre los casos declarados, no es un muro.

### 3. Modo lectura (`read-only`) — apagado por defecto

Con `zen-live readonly on` se bloquean las escrituras (`click`, `fill`, `key`,
`goto`, `scroll`, `select`, `set-range`, `localstorage set/delete/clear`...) y
pasan las lecturas (`text`, `snap`, `interactive`, `annotate`, `screenshot`,
`css`, `network`, `localstorage list`, `tabs`, `cookies`, `history`...).

Apagado por defecto a proposito: cambiar el comportamiento por defecto de una
herramienta que ya usas es decision tuya, no nuestra.

`localstorage`/`sessionstorage` se clasifican por accion: `list` y `get` leen,
`set`/`delete`/`clear` escriben.

Se apaga con `zen-live readonly off` por HTTP con token, **no** como un comando
mas: si fuera un comando normal, en read-only no habria forma de desactivarlo.

### 4. Limite de ritmo (`rate-limit`)

Maximo de escrituras por minuto (120 por defecto; `0` = sin limite). Corta un
bucle runaway que este clicando miles de veces. Las lecturas no cuentan.

```bash
zen-live ratelimit 4    # y a la 5a escritura: {"guard":"rate-limit","error":"rate limit: 4 escrituras en los ultimos 60s (maximo 4)..."}
```

### 5. Sitios protegidos (`protected-site`)

Patron de URL de bancos, pago, salud, gobierno y admins de infraestructura.
Una **escritura** a una URL que encaja devuelve `confirm_token`; si repites el
mismo comando con ese token, pasa.

```bash
zen-live goto 'https://www.bbva.com/netbanking'
# {"ok":false,"guard":"protected-site","confirm_token":"44492c1c5c125e5c","error":"requiere confirmacion: sitio protegido (banco)..."}
zen-live goto 'https://www.bbva.com/netbanking' --confirm-token 44492c1c5c125e5c   # ok
```

El token dura 5 minutos, vale **solo** para ese comando y esa URL, y se invalida
al reiniciar el puente (depende del token del puente). Leer una pagina de un
banco no requiere confirmacion: el riesgo es escribir, no mirar.

Honestidad: esto es un **freno**, no una autenticacion. Un agente que repita el
comando pasa. Su valor es que la intencion tiene que ser explicita y queda
registrada en el audit log.

### 6. Audit log — siempre activo

Una linea JSON por orden en `~/.local/state/zen-live-bridge/audit.jsonl`
(`0600`, rota a 5 MB):

```json
{"ts":"2026-10-01T14:28:07","decision":"denegado","guard":"password-field","cmd":"fill","target":{"sel":"#p","value_len":18,"tabId":77}}
```

**Redaccion:** del texto escrito solo se guarda `value_len`, nunca el contenido.
De la URL solo esquema+host+path, porque la query string lleva tokens de sesion.
Los codigos 2FA tampoco se guardan. Un audit log con el valor dentro seria un
segundo sitio donde acaba la contrasena.

Va en el puente (`zen-live-bridge.py`), no en la extension: **una WebExtension
no puede escribir ficheros**, y el puente es el punto unico por el que pasan
tanto el CLI (TCP 8790) como el panel web (HTTP 8789). Complementario del
historial del panel, no sustituto.

Una sola linea por orden, con la decision **final**: si la extension deniega
(guards 1 y 2), se registra `denegado`, no un `permitido` seguido de `denegado`.

### Donde vive cada guard

| Guard | Donde | Por que ahi |
|---|---|---|
| 1 esquema | `extension/background.js` | es lo unico que ve la URL antes de `tabs.create` |
| 2 contrasena | `extension/background.js` | hace falta el elemento real del DOM |
| 3 read-only | `zen-live-bridge.py` | estado en memoria; la extension se reinicia sola (MV3) |
| 4 rate limit | `zen-live-bridge.py` | idem: un contador en el SW se perderia al dormir |
| 5 protegidos | `zen-live-bridge.py` | tokens compartidos y comparables |
| 6 audit | `zen-live-bridge.py` | la extension no tiene API de disco |


### Por que NO es lo mismo que KeePassXC

KeePassXC genera los TOTP **dentro del navegador** y el codigo nunca pasa por
el contexto del agente: la extension lo inyecta directamente en el campo. Es
estrictamente mejor. `otp` cubre el caso que KeePass no cubre: servicios que
mandan el codigo **por correo** y no por TOTP.

El correo es un canal menos seguro que TOTP (quien tenga la cuenta puede
pedir un reenvio). Por eso:

- Filtra por remitente y asunto: solo `no-reply`, `security@`, `verify@` o
  asuntos con `codigo`/`verification`/`2fa`/`login`.
- Exige una palabra clave (`codigo`, `code`, `2fa`, `passcode`) **cerca** del
  numero. Un PIN suelto o una fecha no se toman.
- Solo 6 digitos, y no como parte de un numero mas largo.

Verificado con 10 casos (`test-otp.py`, 0 fallos), incluyendo los dos formatos
que rompen un extractor ingenuo: Google pone el codigo **despues** de la
palabra clave ("tu codigo es 123456") y GitHub lo pone **antes** ("123456 es
tu codigo"). El extractor mira una ventana a ambos lados.

### Que NO cubre

### CAPTCHA y desafios — FUERA DE ALCANCE por decision de seguridad

**Zen Live no resuelve CAPTCHAs ni sortea desafios, y no se va a anadir.** No es
una limitacion tecnica pendiente: es una decision. Un agente con tu sesion ya
puede hacer mucho; resolverle el antibot de un tercero automaticamente anade
una capacidad de evadir un control que otro sistema puso a proposito. Si la
pagina te pide un desafio, el flujo correcto es que lo resuelvas tu.

Lo que YA hay en la maquina, y por que no se expose como comando:

- `tesseract 5.5.3` (`/usr/bin/tesseract`, eng/spa/afr/osd) resuelve CAPTCHA de
  **texto/imagen** por OCR. Un comando `ocr` que lo aplique sobre un recorte de
  la pagina SI seria portable y no necesitaria CDP. No implementado aqui a
  proposito: seria automatizar el evasion, no leer texto.
- `ocrmypdf` es para PDFs escaneados, no para captchas.
- `oathtool`, `otpauth`, `ddddocr`, `opencv`, `angr`: **no instalados**.

Lo mejor de GitHub hoy, y por que no se integra:

| Proyecto | Estrellas | Nota |
|---|---|---|
| [NopeCHALLC/nopecha](https://github.com/NopeCHALLC/nopecha-extension) | 11.004 | La mas completa (reCAPTCHA, hCaptcha, Turnstile, Arkose, Geetest, DataDome...). Es **libreria**, y requiere Chromium/CDP. **No portable a Zen**: Firefox cerro CDP con WONTFIX (bugzilla 1679876) y Zen es Gecko. |
| [dessant/buster](https://github.com/dessant/buster) | 9.316 | Extension **para humanos**. Resuelve reCAPTCHA por **audio** (speech recognition), no por OCR. Declara soporte Firefox explicitamente: la unica con ese soporte. |
| [TheGP/untidetect-tools](https://github.com/TheGP/untidetect-tools) | 2.018 | Herramientas de fingerprint/anti-detect. |
| henryzawadzki6542/cloudflare-turnstile-bypass | 624 | Scripts de pago, no es open source de verdad. |

Conclusion honesta: la mejor libreria (nopecha) no sirve para Zen por CDP, y la
unica con soporte Firefox (buster) esta pensada para que la resuelva una
persona. Integrar cualquiera de las dos en un agente seria el caso de uso que
este parrafo quiere evitar.
- Contrasenas. No hay ninguna API WebExtension para leerlas, y no se anade una:
  las credenciales van en el gestor del navegador. El guard 2 de v0.11 refuerza
  esto: el agente tampoco puede **escribir** en un campo de contrasena.

