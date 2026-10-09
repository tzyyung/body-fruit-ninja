#!/bin/bash
# 體感切水果 MVP 的操作選單。
# 可以直接跑進選單，也可以當指令用：./menu.sh start|stop|open|status|check
set -u

cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8777}"
URL="http://localhost:$PORT/"
LOG="/tmp/watermelon-mvp-$PORT.log"

c_dim=$'\033[2m'; c_b=$'\033[1m'; c_g=$'\033[32m'; c_y=$'\033[33m'
c_r=$'\033[31m'; c_c=$'\033[36m'; c_0=$'\033[0m'

# 這個埠上在聽的 PID —— 只認我們自己開的 http.server，
# 免得誤殺剛好占用同一個埠的別人。
server_pid() {
  local pid
  for pid in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null); do
    if ps -p "$pid" -o command= 2>/dev/null | grep -q 'http\.server'; then
      echo "$pid"; return 0
    fi
  done
  return 1
}

# 埠被別人占著（不是我們的 http.server）
port_taken_by_other() {
  local pid
  pid=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
  [ -n "$pid" ] && ! server_pid >/dev/null
}

do_status() {
  local pid
  if pid=$(server_pid); then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "${URL}index.html" 2>/dev/null)
    if [ "$code" = "200" ]; then
      printf '%s● 執行中%s  %s  %sPID %s%s\n' "$c_g" "$c_0" "$URL" "$c_dim" "$pid" "$c_0"
    else
      printf '%s● 程序在但沒回應%s  PID %s（HTTP %s）\n' "$c_y" "$c_0" "$pid" "${code:-無}"
    fi
    return 0
  fi
  if port_taken_by_other; then
    printf '%s● 埠 %s 被別的程式占著%s　換一個：PORT=9000 %s\n' \
      "$c_r" "$PORT" "$c_0" "$0"
    return 2
  fi
  printf '%s○ 沒有在跑%s\n' "$c_dim" "$c_0"
  return 1
}

do_start() {
  if server_pid >/dev/null; then
    printf '已經在跑了：%s\n' "$URL"; return 0
  fi
  if port_taken_by_other; then
    printf '%s埠 %s 被別的程式占著。%s改用別的埠：PORT=9000 %s start\n' \
      "$c_r" "$PORT" "$c_0" "$0"
    return 1
  fi
  # 一定要從 localhost 開，不能用 file://
  # —— getUserMedia 只在 secure context 下存在
  nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >"$LOG" 2>&1 &
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${URL}index.html" 2>/dev/null)" = "200" ]; then
      printf '%s啟動完成%s  %s\n' "$c_g" "$c_0" "$URL"
      return 0
    fi
  done
  printf '%s啟動失敗。%s看一下 %s\n' "$c_r" "$c_0" "$LOG"
  return 1
}

do_stop() {
  local pid
  if pid=$(server_pid); then
    kill "$pid" 2>/dev/null
    sleep 0.4
    if server_pid >/dev/null; then kill -9 "$pid" 2>/dev/null; sleep 0.3; fi
    if server_pid >/dev/null; then
      printf '%s停不下來，PID %s%s\n' "$c_r" "$pid" "$c_0"; return 1
    fi
    printf '已停止（PID %s）\n' "$pid"
  else
    printf '本來就沒在跑\n'
  fi
}

do_open() {
  server_pid >/dev/null || do_start || return 1
  open "$URL" && printf '已在瀏覽器開啟 %s\n' "$URL"
}

# 這個 MVP 的模型和函式庫都從 CDN 來，所以「能不能跑」有一半不在本機。
do_check() {
  local fail=0 sp
  sp=$(mktemp -d)

  printf '%s語法%s\n' "$c_b" "$c_0"
  python3 - "$sp/inline.js" <<'PY'
import re, sys
src = open('index.html', encoding='utf-8').read()
open(sys.argv[1], 'w', encoding='utf-8').write(
    '\n'.join(re.findall(r'<script>(.*?)</script>', src, re.S)))
PY
  if node --check "$sp/inline.js" >/dev/null 2>&1; then
    printf '  %s✓%s index.html 內嵌 JS\n' "$c_g" "$c_0"
  else
    printf '  %s✗%s index.html 內嵌 JS\n' "$c_r" "$c_0"
    node --check "$sp/inline.js" 2>&1 | head -3 | sed 's/^/    /'
    fail=1
  fi

  # id 撞名 getElementById 只回第一個，另一個元素就永遠不會被更新 ——
  # 這種 bug 語法檢查抓不到，畫面上只看到某一欄一直是空的。
  local dup
  dup=$(grep -oE 'id="[a-z0-9-]+"' index.html | sort | uniq -d)
  if [ -n "$dup" ]; then
    printf '  %s✗%s 重複的 id：%s\n' "$c_r" "$c_0" "$(echo "$dup" | tr '\n' ' ')"
    fail=1
  else
    printf '  %s✓%s 沒有重複的 id\n' "$c_g" "$c_0"
  fi

  printf '%s外部相依（CDN）%s\n' "$c_b" "$c_0"
  local u code
  for u in $(grep -oE 'https://cdn\.jsdelivr\.net[^"]*' index.html); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 8 "$u")
    if [ "$code" = "200" ]; then
      printf '  %s✓%s %s\n' "$c_g" "$c_0" "${u##*/}"
    else
      printf '  %s✗%s HTTP %s  %s\n' "$c_r" "$c_0" "$code" "$u"; fail=1
    fi
  done

  printf '%s本機模型%s\n' "$c_b" "$c_0"
  local entry name dir any=0
  for entry in $MODELS; do
    name="${entry%%:*}"; dir="models/$name"
    if [ -f "$dir/model.json" ]; then
      printf '  %s✓%s %s（%s）開頁約 45ms\n' "$c_g" "$c_0" "$name" \
        "$(du -sh "$dir" 2>/dev/null | cut -f1 | tr -d ' ')"
      any=1
    else
      printf '  %s○%s %s 未下載，會改從 CDN 抓（約 5 秒）\n' "$c_y" "$c_0" "$name"
    fi
  done
  [ "$any" = 0 ] && printf '  %s要下載：%s models%s\n' "$c_dim" "$0" "$c_0"

  printf '%s模型權重（CDN 退路）%s\n' "$c_b" "$c_0"
  # tfhub.dev 已退役，會重導到 Kaggle Models。斷掉的話模型載不下來。
  local m='https://tfhub.dev/google/tfjs-model/movenet/singlepose/lightning/4/model.json?tfjs-format=file'
  code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 15 "$m")
  if [ "$code" = "200" ]; then
    printf '  %s✓%s MoveNet Lightning（經 tfhub → Kaggle 重導）\n' "$c_g" "$c_0"
  else
    printf '  %s✗%s HTTP %s —— 模型載不下來，遊戲會卡在載入\n' "$c_r" "$c_0" "$code"; fail=1
  fi

  rm -rf "$sp"
  [ "$fail" = 0 ] && printf '\n%s全部通過%s\n' "$c_g" "$c_0" || printf '\n%s有項目失敗%s\n' "$c_r" "$c_0"
  return "$fail"
}

# 模型放本機。原本每次開頁都要走 tfhub.dev → Kaggle 的重導鏈抓
# model.json 和各個權重分片，實測三個檔加起來就是七秒多，
# 使用者就是在那裡乾等。放本機之後從 localhost 讀，而且能離線跑。
MODELS="movenet-lightning:singlepose/lightning/4 movenet-thunder:singlepose/thunder/4"

do_models() {
  local entry name path base json shard dir got=0
  for entry in $MODELS; do
    name="${entry%%:*}"; path="${entry#*:}"
    dir="models/$name"
    base="https://tfhub.dev/google/tfjs-model/movenet/$path"
    if [ -f "$dir/model.json" ]; then
      printf '  %s✓%s %s 已存在（%s）\n' "$c_g" "$c_0" "$name" \
        "$(du -sh "$dir" 2>/dev/null | cut -f1)"
      continue
    fi
    mkdir -p "$dir"
    printf '  下載 %s …\n' "$name"
    if ! curl -s -L --max-time 60 -o "$dir/model.json" "$base/model.json?tfjs-format=file"; then
      printf '  %s✗%s %s model.json 下載失敗\n' "$c_r" "$c_0" "$name"; rm -rf "$dir"; continue
    fi
    # 權重分片的檔名寫在 model.json 的 weightsManifest 裡，
    # tfjs 會以 model.json 的網址為基準去找它們，所以要同目錄同檔名。
    for shard in $(python3 -c "
import json,sys
d=json.load(open('$dir/model.json'))
print(' '.join(p for g in d.get('weightsManifest',[]) for p in g['paths']))
" 2>/dev/null); do
      if ! curl -s -L --max-time 120 -o "$dir/$shard" "$base/$shard?tfjs-format=file"; then
        printf '  %s✗%s %s 下載失敗\n' "$c_r" "$c_0" "$shard"; rm -rf "$dir"; continue 2
      fi
    done
    printf '  %s✓%s %s（%s）\n' "$c_g" "$c_0" "$name" "$(du -sh "$dir" | cut -f1)"
    got=1
  done
  [ -d models ] && printf '\n  合計 %s\n' "$(du -sh models | cut -f1)"
  printf '  頁面會自動優先用本機的，抓不到才回去用 CDN。\n'
}

# 把 fp16 權重再量化成 uint8，體積減半。
# 注意：這會損失精度，用「比對 fp16 / uint8」按鈕量過再決定要不要用。
do_quantize() {
  local src=models/movenet-lightning dst=models/movenet-lightning-uint8
  if [ ! -f "$src/model.json" ]; then
    printf '  %s先下載模型：%s models%s\n' "$c_y" "$0" "$c_0"; return 1
  fi
  python3 quantize.py "$src" "$dst"
}

do_log() {
  [ -f "$LOG" ] && tail -40 "$LOG" || printf '還沒有紀錄：%s\n' "$LOG"
}

menu() {
  while true; do
    printf '\n%s體感切水果 MVP%s   %s\n' "$c_b" "$c_0" "$c_dim$PWD$c_0"
    printf '  '; do_status
    printf '\n'
    printf '  %s1%s  開啟（需要時自動啟動伺服器）\n' "$c_c" "$c_0"
    printf '  %s2%s  啟動伺服器\n'                   "$c_c" "$c_0"
    printf '  %s3%s  停止伺服器\n'                   "$c_c" "$c_0"
    printf '  %s4%s  重新啟動\n'                     "$c_c" "$c_0"
    printf '  %s5%s  自我檢查（語法、CDN、模型）\n'  "$c_c" "$c_0"
  printf '  %s8%s  下載模型到本機（開頁不用再等 CDN）\n' "$c_c" "$c_0"
  printf '  %s9%s  量化成 uint8（體積減半，會損失精度）\n'   "$c_c" "$c_0"
    printf '  %s6%s  看伺服器紀錄\n'                 "$c_c" "$c_0"
    printf '  %s7%s  看說明文件\n'                   "$c_c" "$c_0"
    printf '  %sq%s  離開（伺服器繼續跑）\n'         "$c_c" "$c_0"
    printf '\n選擇： '
    read -r choice
    case "$choice" in
      1) do_open ;;
      2) do_start ;;
      3) do_stop ;;
      4) do_stop; do_start ;;
      5) do_check ;;
      8) do_models ;;
      9) do_quantize ;;
      6) do_log ;;
      7) if command -v less >/dev/null; then less README.md; else cat README.md; fi ;;
      q|Q|'') printf '伺服器還在背景跑。要停：%s stop\n' "$0"; exit 0 ;;
      *) printf '沒有這個選項\n' ;;
    esac
  done
}

case "${1:-}" in
  start)  do_start ;;
  stop)   do_stop ;;
  restart) do_stop; do_start ;;
  open)   do_open ;;
  status) do_status ;;
  check)  do_check ;;
  models) do_models ;;
  quantize) do_quantize ;;
  log)    do_log ;;
  ''|menu) menu ;;
  *) printf '用法：%s [start|stop|restart|open|status|check|log|models|quantize]\n' "$0"; exit 1 ;;
esac
