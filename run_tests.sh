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
mkdir tmp

for src in "$TESTS"/*.woua; do
  name="$(basename "$src" .woua)"
  if [ -n "$FILTER" ] && [[ "$name" != "${FILTER}_"* && "$name" != "$FILTER" ]]; then
    continue
  fi

  # Check for @expect-map (test verifies the -map flag output)
  if grep -q '^;; @expect-map' "$src"; then
    src_rel="tests/$name.woua"
    wat_rel="tests/out/$name.wat"
    wasm_file="$OUT/$name.wasm"
    map_file="$OUT/$name.wat.map"
    vcmd "wasmtime --dir=. wouac/dist/wouac.wasm $src_rel -o $wat_rel -map"
    if ! (cd "$REPO" && wasmtime --dir=. "$WOUAC" "$src_rel" -o "$wat_rel" -map 2>/dev/null); then
      echo "FAIL  $name  (compile error)"
      FAIL=$((FAIL + 1))
      continue
    fi
    vcmd "wat2wasm $wat_rel -o $wasm_file"
    if ! wat2wasm "$OUT/$name.wat" -o "$wasm_file" 2>/dev/null; then
      echo "FAIL  $name  (wat2wasm error)"
      FAIL=$((FAIL + 1))
      continue
    fi
    expected="$(awk '
      /^;; @expect / { print substr($0, 12); found=1; next }
      /^;; @expect$/  { found=1; next }
      found && /^;;   / { print substr($0, 6); next }
      found { exit }
    ' "$src")"
    actual="$(cat "$map_file" 2>/dev/null)"
    if [ "$actual" = "$expected" ]; then
      echo "PASS  $name"
      PASS=$((PASS + 1))
    else
      echo "FAIL  $name"
      echo "  expected: $(echo "$expected" | head -3 | sed 's/^/    /')"
      echo "  actual:   $(echo "$actual"   | head -3 | sed 's/^/    /')"
      FAIL=$((FAIL + 1))
    fi
    continue
  fi

  # Check for @expect-wat (test verifies strings present in the WAT output)
  if grep -q '^;; @expect-wat' "$src"; then
    src_rel="tests/$name.woua"
    wat_rel="tests/out/$name.wat"
    wat_file="$OUT/$name.wat"
    vcmd "wasmtime --dir=. wouac/dist/wouac.wasm $src_rel -o $wat_rel"
    if ! (cd "$REPO" && wasmtime --dir=. "$WOUAC" "$src_rel" -o "$wat_rel" 2>/dev/null); then
      echo "FAIL  $name  (compile error)"
      FAIL=$((FAIL + 1))
      continue
    fi
    wat_ok=1
    while IFS= read -r line; do
      pattern="${line#;; @expect-wat }"
      if ! grep -qF "$pattern" "$wat_file"; then
        echo "FAIL  $name  (WAT missing: $pattern)"
        wat_ok=0
      fi
    done < <(grep '^;; @expect-wat ' "$src")
    if [ "$wat_ok" -eq 1 ]; then
      echo "PASS  $name"
      PASS=$((PASS + 1))
    else
      FAIL=$((FAIL + 1))
    fi
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

  # Parse optional @runtime annotation (default: wasmtime)
  runtime="$(awk '/^;; @runtime / { print substr($0, 13); exit }' "$src")"
  runtime="${runtime:-wasmtime}"
  if ! command -v "$runtime" &>/dev/null; then
    echo "SKIP  $name  (runtime '$runtime' not found)"
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

  # Parse optional @expect-exit annotation (expected exit code, default 0)
  expect_exit="$(awk '/^;; @expect-exit / { print substr($0, 17); exit }' "$src")"
  expect_exit="${expect_exit:-0}"

  # Parse optional @dir annotations — ;; @dir <path> mounts a preopened WASI directory.
  # Paths are relative to $REPO; tests are run from $REPO so they resolve correctly.
  # Example: ;; @dir tmp  →  --dir=tmp  (guest preopen name = "tmp")
  dir_flags=""
  while IFS= read -r dir; do
    dir_flags="$dir_flags --dir=$dir"
  done < <(awk '/^;; @dir / { print substr($0, 9) }' "$src")

  # Parse optional @stdin annotation — ;; @stdin <text> pipes <text>\n to program stdin.
  # A bare ;; @stdin (no value) pipes a single newline.  Multiple lines are piped in order.
  stdin_data=""
  has_stdin=0
  while IFS= read -r sline; do
    stdin_data="${stdin_data}${sline}"$'\n'
    has_stdin=1
  done < <(awk '/^;; @stdin$/ { print ""; next } /^;; @stdin / { print substr($0, 11) }' "$src")

  # Helper: run command with or without piped stdin
  run_wasm() {
    if [ "$has_stdin" -eq 1 ]; then
      printf '%s' "$stdin_data" | "$@"
    else
      "$@"
    fi
  }

  # Run and capture output (stdout normally, stderr when non-zero exit expected)
  if [ -n "$extra_args" ]; then
    if [ "$runtime" = "wasmer" ]; then
      vcmd "wasmer run $dir_flags $wasm_file -- $extra_args"
      # shellcheck disable=SC2086
      set +e
      if [ "$expect_exit" != "0" ]; then
        actual="$(cd "$REPO" && run_wasm wasmer run $dir_flags "$wasm_file" -- $extra_args 2>&1 >/dev/null)"
      else
        actual="$(cd "$REPO" && run_wasm wasmer run $dir_flags "$wasm_file" -- $extra_args 2>/dev/null)"
      fi
      actual_exit=$?
      set -e
    else
      vcmd "wasmtime run $dir_flags $wasm_file $extra_args"
      # shellcheck disable=SC2086
      set +e
      if [ "$expect_exit" != "0" ]; then
        actual="$(cd "$REPO" && run_wasm wasmtime run $dir_flags "$wasm_file" $extra_args 2>&1 >/dev/null)"
      else
        actual="$(cd "$REPO" && run_wasm wasmtime run $dir_flags "$wasm_file" $extra_args 2>/dev/null)"
      fi
      actual_exit=$?
      set -e
    fi
  else
    if [ "$runtime" = "wasmer" ]; then
      vcmd "wasmer run $dir_flags $wasm_file"
      set +e
      if [ "$expect_exit" != "0" ]; then
        actual="$(cd "$REPO" && run_wasm wasmer run $dir_flags "$wasm_file" 2>&1 >/dev/null)"
      else
        actual="$(cd "$REPO" && run_wasm wasmer run $dir_flags "$wasm_file" 2>/dev/null)"
      fi
      actual_exit=$?
      set -e
    else
      vcmd "wasmtime $dir_flags $wasm_file"
      set +e
      if [ "$expect_exit" != "0" ]; then
        actual="$(cd "$REPO" && run_wasm wasmtime $dir_flags "$wasm_file" 2>&1 >/dev/null)"
      else
        actual="$(cd "$REPO" && run_wasm wasmtime $dir_flags "$wasm_file" 2>/dev/null)"
      fi
      actual_exit=$?
      set -e
    fi
  fi

  if [ "$actual_exit" != "$expect_exit" ]; then
    echo "FAIL  $name  (expected exit $expect_exit, got $actual_exit)"
    FAIL=$((FAIL + 1))
    continue
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
