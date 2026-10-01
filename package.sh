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
sed "s|__ZEN_LIVE_TOKEN__|$TOKEN|g" "$EXT/background.js" > "$STAGE/background.js"
grep -q "$TOKEN" "$STAGE/background.js" || { echo "fallo al inyectar el token" >&2; exit 1; }

( cd "$STAGE" && zip -q -r "$OLDPWD/$OUT" manifest.json background.js )
chmod 644 "$OUT"
echo "construido $OUT (v$VER)"

if [[ "${1:-}" == "--install" || "${1:-}" == "--restart-zen" ]]; then
  PROF="$(ls -d "$HOME"/.zen/*.Default*release*/extensions 2>/dev/null | head -1)"
  [[ -n "$PROF" ]] || { echo "no encontre el perfil de Zen en ~/.zen" >&2; exit 1; }
  cp "$OUT" "$PROF/zen-live-bridge@elemental.local.xpi"
  rm -rf "$(dirname "$PROF")"/startupCache
  echo "instalado en $PROF (startupCache borrado; el token cambio dentro del xpi)"
fi

if [[ "${1:-}" == "--restart-zen" ]]; then
  echo "reiniciando Zen..."
  RUN=$(pgrep -x zen-bin | head -1)
  if [[ -n "$RUN" ]]; then
    eval "$(tr '\0' '\n' < "/proc/$RUN/environ" \
      | grep -E '^(WAYLAND_DISPLAY|DISPLAY|XDG_RUNTIME_DIR|XDG_CURRENT_DESKTOP|DBUS_SESSION_BUS_ADDRESS)=' \
      | sed 's/^\([A-Z_]*\)=\(.*\)$/export \1="\2"/')"
    export XDG_SESSION_TYPE=wayland
    kill "$RUN"; sleep 7
  fi
  setsid -f "$(command -v zen-browser)" >/dev/null 2>&1 || true
  sleep 20
  zen-live status 2>&1 | tail -2
fi
