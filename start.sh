#!/usr/bin/env bash
# Arranca un servidor web local para FreeRetro (sitio 100% estático).
# Uso: ./start.sh [puerto]   (por defecto 8080)
set -e
cd "$(dirname "$0")"
PORT="${1:-8080}"
URL="http://localhost:$PORT"

echo "FreeRetro disponible en $URL (Ctrl+C para detener)"

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  exec python -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes http-server -p "$PORT" -c-1
else
  echo "Error: se necesita python3 o Node.js (npx) para arrancar el servidor." >&2
  exit 1
fi
