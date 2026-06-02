#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WOUAC="$REPO/wouac/dist/wouac.wasm"
DEMOS="$REPO/demos"
OUT="$DEMOS/out"
PASS=0
FAIL=0

mkdir -p "$OUT"
mkdir -p tmp

FILTER="${1:-}"  # optional name filter, e.g. ./build_demos.sh fft

for src in "$DEMOS"/*.woua; do
  name="$(basename "$src" .woua)"
  [[ -n "$FILTER" && "$name" != "$FILTER" ]] && continue
  src_rel="demos/$name.woua"
  wat_rel="demos/out/$name.wat"
  wat_file="$OUT/$name.wat"
  wasm_file="$OUT/$name.wasm"

  echo "── $name ──────────────────────────────────────"
  if ! (cd "$REPO" && wasmtime --dir=. "$WOUAC" "$src_rel" -o "$wat_rel"); then
    echo "FAIL  $name  (compile error)"
    FAIL=$((FAIL + 1))
    continue
  fi
  if ! wat2wasm --enable-threads "$wat_file" -o "$wasm_file"; then
    echo "FAIL  $name  (wat2wasm error)"
    FAIL=$((FAIL + 1))
    continue
  fi
  echo "OK    $name  →  demos/out/$name.wasm"
  PASS=$((PASS + 1))
done

echo ""
echo "$PASS built, $FAIL failed"
[ "$FAIL" -eq 0 ]
