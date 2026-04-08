#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WOUAC="$REPO/wouac/dist/wouac.wasm"
TESTS="$REPO/tests"
OUT="$TESTS/out"
PASS=0
FAIL=0
FILTER=""
VERBOSE=0

for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    *) FILTER="$arg" ;;
  esac
done

vcmd() { if [ "$VERBOSE" -eq 1 ]; then echo "  + $*" >&2; fi; }

mkdir -p "$OUT"

for src in "$TESTS"/*.woua; do
  name="$(basename "$src" .woua)"
  if [ -n "$FILTER" ] && [[ "$name" != "${FILTER}_"* && "$name" != "$FILTER" ]]; then
    continue
  fi

  # Check for @expect-error (test expects compilation to fail)
  if grep -q '^;; @expect-error' "$src"; then
    src_rel="tests/$name.woua"
    err_wat="tests/out/$name.wat"
    vcmd "wasmtime --dir=. wouac/dist/wouac.wasm $src_rel -o $err_wat"
    vcmd "wat2wasm $err_wat -o tests/out/$name.wasm"
    if (cd "$REPO" && wasmtime --dir=. "$WOUAC" "$src_rel" -o "$err_wat" 2>/dev/null) \
        && wat2wasm "$OUT/$name.wat" -o "$OUT/$name.wasm" 2>/dev/null; then
      echo "FAIL  $name  (expected compile error, but compiled successfully)"
      FAIL=$((FAIL + 1))
    else
      echo "PASS  $name"
      PASS=$((PASS + 1))
    fi
    continue
  fi

  # Extract @expect lines from the test file
  expected="$(awk '
    /^;; @expect / { print substr($0, 12); found=1; next }
    /^;; @expect$/  { found=1; next }
    found && /^;;   / { print substr($0, 6); next }
    found { exit }
  ' "$src")"

  # Compile to WAT then WASM
  # -o path must be relative to $REPO (the WASI --dir root); run from $REPO
  wat_rel="tests/out/$name.wat"
  wat_file="$OUT/$name.wat"
  wasm_file="$OUT/$name.wasm"
  src_rel="tests/$name.woua"
  vcmd "wasmtime --dir=. wouac/dist/wouac.wasm $src_rel -o $wat_rel"
  if ! (cd "$REPO" && wasmtime --dir=. "$WOUAC" "$src_rel" -o "$wat_rel" 2>/dev/null); then
    echo "FAIL  $name  (compile error)"
    FAIL=$((FAIL + 1))
    continue
  fi
  vcmd "wat2wasm $wat_file -o $wasm_file"
  if ! wat2wasm "$wat_file" -o "$wasm_file" 2>/dev/null; then
    echo "FAIL  $name  (wat2wasm error)"
    FAIL=$((FAIL + 1))
    continue
  fi

  # Parse optional @args annotation for passing extra arguments to the wasm
  extra_args="$(awk '/^;; @args / { print substr($0, 10); exit }' "$src")"

  # Run and capture output
  if [ -n "$extra_args" ]; then
    vcmd "wasmtime run $wasm_file $extra_args"
    # shellcheck disable=SC2086
    actual="$(wasmtime run "$wasm_file" $extra_args 2>/dev/null)"
  else
    vcmd "wasmtime $wasm_file"
    actual="$(wasmtime "$wasm_file" 2>/dev/null)"
  fi

  if [ "$actual" = "$expected" ]; then
    echo "PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $name"
    echo "  expected: $(echo "$expected" | head -3 | sed 's/^/    /')"
    echo "  actual:   $(echo "$actual"   | head -3 | sed 's/^/    /')"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
