#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source_icon="$repo_root/public/icon.svg"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

qlmanage -t -s 1024 -o "$work_dir" "$source_icon" >/dev/null 2>&1
rendered_icon="$work_dir/icon.svg.png"

for size in 180 192 512; do
  sips --resampleHeightWidth "$size" "$size" "$rendered_icon" --out "$repo_root/public/icon-$size.png" >/dev/null
done
