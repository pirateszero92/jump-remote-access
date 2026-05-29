#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
TOKEN_FILE="${TOKEN_FILE:-$DATA_DIR/tokens.cfg}"
WEBSOCKIFY_PORT="${WEBSOCKIFY_PORT:-6080}"
GUACD_HOST="${GUACD_HOST:-127.0.0.1}"
GUACD_PORT="${GUACD_PORT:-4822}"
PORT="${PORT:-8080}"
WEBSOCKIFY_TARGET="${WEBSOCKIFY_TARGET:-http://127.0.0.1:${WEBSOCKIFY_PORT}}"

export DATA_DIR TOKEN_FILE WEBSOCKIFY_PORT GUACD_HOST GUACD_PORT PORT WEBSOCKIFY_TARGET
export LD_LIBRARY_PATH="/opt/guacamole/lib:${LD_LIBRARY_PATH:-}"
export PATH="/opt/guacamole/sbin:${PATH}"

mkdir -p "$DATA_DIR"
touch "$TOKEN_FILE"

websockify --token-plugin TokenFile --token-source "$TOKEN_FILE" "$WEBSOCKIFY_PORT" &
WS_PID=$!

guacd -b "$GUACD_HOST" -l "$GUACD_PORT" -f &
GUACD_PID=$!

node server.js &
APP_PID=$!

terminate() {
  kill "$APP_PID" "$WS_PID" "$GUACD_PID" 2>/dev/null || true
  wait "$APP_PID" "$WS_PID" "$GUACD_PID" 2>/dev/null || true
}

trap terminate INT TERM

EXIT_CODE=0

while :; do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    wait "$APP_PID" || EXIT_CODE=$?
    break
  fi

  if ! kill -0 "$WS_PID" 2>/dev/null; then
    wait "$WS_PID" || EXIT_CODE=$?
    break
  fi

  if ! kill -0 "$GUACD_PID" 2>/dev/null; then
    echo "guacd exited unexpectedly" >&2
    wait "$GUACD_PID" || EXIT_CODE=$?
    break
  fi

  sleep 1
done

terminate
exit "$EXIT_CODE"
