#!/bin/sh
# 本機開發：閘道與串接的服務一起跑，服務綁定才接得通。
# 要一起跑的服務寫在 .dev.services（不進版控）：一行一個該服務 wrangler 設定檔的路徑，# 開頭是註解
set -eu
cd "$(dirname "$0")/.."

[ -f wrangler.local.jsonc ] || { echo "找不到 wrangler.local.jsonc：先複製 wrangler.jsonc 再填入服務綁定" >&2; exit 1; }

# 設定檔往前加，呼叫時多帶的參數（例如 --port）留在最後；閘道的設定最後才加，排在第一個
if [ -f .dev.services ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    set -- -c "$line" "$@"
  done < .dev.services
fi
set -- -c wrangler.local.jsonc "$@"

exec npx wrangler dev "$@"
