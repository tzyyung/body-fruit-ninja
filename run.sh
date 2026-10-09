#!/bin/sh
# 一定要從 http://localhost 開，不能用 file:// —— getUserMedia 只在 secure context
# 下存在，用檔案路徑開的話 navigator.mediaDevices 整個會是 undefined。
cd "$(dirname "$0")" || exit 1
PORT=${1:-8777}
echo "開 http://localhost:$PORT/ （Ctrl-C 結束）"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
