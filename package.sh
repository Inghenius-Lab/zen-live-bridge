#!/usr/bin/env bash
# Empaqueta la extension e inyecta el token del puente.
#
# La extension no puede leer archivos locales, asi que el token va incrustado
# en background.js al empaquetar. Por eso el token NUNCA se commitea: se lee de
# ~/.local/state/zen-live-bridge/token (o de ZEN_LIVE_TOKEN_FILE).
#
#   ./package.sh                 # construye extension/zen-live-bridge-<ver>.xpi
#   ./package.sh --install       # ademas lo copia al perfil de Zen y borra startupCache
#   ./package.sh --restart-zen   # y reinicia Zen con el entorno correcto
#
# El token se puede rotar sin reinstalar el CLI: basta con borrar el archivo,
# reiniciar el puente y re-empaquetar para la extension.
set -euo pipefail
cd "$(dirname "$0")"

EXT="extension"
TOKEN_FILE="${ZEN_LIVE_TOKEN_FILE:-$HOME/.local/state/zen-live-bridge/token}"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "generando token en $TOKEN_FILE"
  mkdir -p "$(dirname "$TOKEN_FILE")"; chmod 700 "$(dirname "$TOKEN_FILE")"
  umask 077; python3 -c "import secrets;print(secrets.token_urlsafe(32))" > "$TOKEN_FILE"
fi
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
[[ -n "$TOKEN" ]] || { echo "token vacio: revisa $TOKEN_FILE" >&2; exit 1; }

VER="$(python3 -c "import json;print(json.load(open('$EXT/manifest.json'))['version'])")"
OUT="zen-live-bridge-${VER}.xpi"

# Stage en un dir temporal: el token entra ahi y NUNCA se escribe en el repo.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$EXT/manifest.json" "$STAGE/"
cp "$EXT/panel.html" "$STAGE/"
mkdir -p "$STAGE/icons"
cp "$EXT"/icons/*.png "$STAGE/icons/"

# El token va incrustado en DOS ficheros: background.js, que abre el WebSocket,
# y panel.js, que se lo pasa al iframe de la UI por postMessage. Si solo se
# inyectara en el primero, el panel cargaria pero la UI se quedaria sin API.
sed "s|__ZEN_LIVE_TOKEN__|$TOKEN|g" "$EXT/background.js" > "$STAGE/background.js"
sed "s|__ZEN_LIVE_TOKEN__|$TOKEN|g" "$EXT/panel.js" > "$STAGE/panel.js"
for f in background.js panel.js; do
  grep -q "$TOKEN" "$STAGE/$f" || { echo "fallo al inyectar el token en $f" >&2; exit 1; }
done

# La webui NO va dentro del xpi: la sirve el puente desde disco. Va en un
# directorio aparte, hermano del script, que es donde lo busca con
# WEBUI_DIR = dirname(dirname(abspath(__file__)))/webui
WEBUI_DEST="${ZEN_LIVE_WEBUI_DEST:-$HOME/.local/share/skills-hub/zen-live-bridge/webui}"
if [[ -d webui ]]; then
  mkdir -p "$WEBUI_DEST"
  cp webui/index.html webui/style.css webui/app.js "$WEBUI_DEST/"
fi

( cd "$STAGE" && zip -q -r "$OLDPWD/$OUT" manifest.json background.js panel.html panel.js icons )
chmod 644 "$OUT"
echo "construido $OUT (v$VER)"; [[ -d webui ]] && echo "webui copiada a $WEBUI_DEST"

if [[ "${1:-}" == "--install" || "${1:-}" == "--restart-zen" ]]; then
  PROF="$(ls -d "$HOME"/.zen/*.Default*release*/extensions 2>/dev/null | head -1)"
  [[ -n "$PROF" ]] || { echo "no encontre el perfil de Zen en ~/.zen" >&2; exit 1; }
  cp "$OUT" "$PROF/zen-live-bridge@elemental.local.xpi"
  rm -rf "$(dirname "$PROF")"/startupCache
  echo "instalado en $PROF (startupCache borrado; el token cambio dentro del xpi)"
fi

if [[ "${1:-}" == "--restart-zen" ]]; then
  echo "reiniciando Zen..."
  # El entorno hay que heredarlo del proceso Zen que ya corre: sin
  # WAYLAND_DISPLAY / XDG_RUNTIME_DIR, zen-bin arranca y muere al instante.
  # Si no hay ninguno corriendo (se murio antes, o es el primer arranque), se
  # reconstruye desde la sesion actual, que en un server systemd de usuario si
  # los tiene. Sin esto, un --restart-zen sin Zen previo dejaba el escritorio
  # sin navegador y sin avisar.
  RUN=$(pgrep -x zen-bin | head -1)
  if [[ -n "$RUN" ]]; then
    eval "$(tr '\0' '\n' < "/proc/$RUN/environ" \
      | grep -E '^(WAYLAND_DISPLAY|DISPLAY|XDG_RUNTIME_DIR|XDG_CURRENT_DESKTOP|DBUS_SESSION_BUS_ADDRESS)=' \
      | sed 's/^\([A-Z_]*\)=\(.*\)$/export \1="\2"/')"
    kill "$RUN"; sleep 7
  fi
  export XDG_SESSION_TYPE=wayland
  # Si no vino de un proceso vivo, deducirlo de las sesiones de Wayland activas.
  if [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
    for d in /run/user/$(id -u)/wayland-*; do
      [[ -S "$d" ]] && { WAYLAND_DISPLAY=$(basename "$d"); export WAYLAND_DISPLAY; break; }
    done
  fi
  : "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR
  : "${DBUS_SESSION_BUS_ADDRESS:=unix:path=$XDG_RUNTIME_DIR/bus}"; export DBUS_SESSION_BUS_ADDRESS

  if [[ -z "${WAYLAND_DISPLAY:-}" ]]; then
    echo "AVISO: no hay WAYLAND_DISPLAY; Zen no abrira ventana (sesion sin Wayland?)" >&2
  fi
  # --marionette NO es opcional: abre 127.0.0.1:2828, que es por donde el
  # MCP firefox-devtools se conecta al MISMO Zen. Sin este flag, el segundo
  # backend no existe y todo lo que la WebExtension no puede hacer (alert/
  # confirm, subir ficheros, instalar extensions) se queda sin cobertura.
  # Solo escucha en loopback, como el resto.
  # nohup + log: con "setsid -f >/dev/null" el proceso se lanzaba pero murio
  # dos veces seguidas al perder el controlling terminal. Con nohup y un log
  # propio aguanta. El log confirma que Marionette levanto ("Listening on port 2828").
  nohup setsid "$(command -v zen-browser)" --marionette \
    >/tmp/zen-launch.log 2>&1 </dev/null &
  disown 2>/dev/null || true
  # esperar a que los 4 puertos esten, en vez de dormir a ciegas
  for _ in $(seq 1 15); do
    n=$(ss -tln 2>/dev/null | grep -cE ':(2828|8788|8789|8790)\b')
    [ "$n" -ge 4 ] && break
    sleep 2
  done
  grep -q "Listening on port 2828" /tmp/zen-launch.log 2>/dev/null \
    || echo "AVISO: Marionette no arranco; revisa /tmp/zen-launch.log" >&2
  zen-live status 2>&1 | tail -2
fi
