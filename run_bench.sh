#!/usr/bin/env bash
# run_bench.sh — build and run the woua benchmark suite; compare against Rust compiled to
# the same wasm32-wasip1 target so both programs run under the identical wasmtime JIT.
#
# Usage:
#   ./run_bench.sh            # run all benchmarks
#   ./run_bench.sh fib        # run only the fib benchmark
#
# Requirements:
#   wasmtime, wat2wasm, rustc with wasm32-wasip1 target
#   (install: rustup target add wasm32-wasip1)
#
# Output format (one block per benchmark):
#   ▶ <name>
#     woua: <program output>
#     rust: <program output>
#     build: woua Nms  /  rust-wasm Nms  /  rust-native Nms
#     ratio: <woua_ms / rust_ms>x  (woua/rust = N/M ms)

set -uo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
WOUAC="$REPO/wouac/dist/wouac.wasm"
BENCH="$REPO/bench"
OUT="$BENCH/out"

mkdir -p "$OUT"

FILTER="${1:-}"

# Accumulates one entry per completed benchmark for the summary table.
# Format: "name|woua_ms|rwasm_ms|rnative_ms|woua_kb|rswasm_kb|ratio_wasm|ratio_native|woua_build_ms|rs_wasm_build_ms|rs_native_build_ms"
SUMMARY_ROWS=()

# ── run_bench name [simd] ────────────────────────────────────────────────────
run_bench() {
  local name="$1"
  local use_simd="${2:-}"

  # Optional filter: skip benchmarks not matching the filter argument.
  if [ -n "$FILTER" ] && [ "$FILTER" != "$name" ]; then
    return
  fi

  local woua_src_rel="bench/$name.woua"
  local rs_src="$BENCH/bench_$name.rs"
  local wat_rel="bench/out/$name.wat"
  local wat_file="$OUT/$name.wat"
  local wasm_file="$OUT/$name.wasm"
  local rs_wasm="$OUT/bench_${name}_rs.wasm"
  local rs_native="$OUT/bench_${name}_native"

  printf "▶ %-14s  " "$name"

  # ── Compile woua → WAT ────────────────────────────────────────────────────
  local t0 t1 woua_build_ms
  t0=$(date +%s%3N)
  if ! (cd "$REPO" && wasmtime --dir=. "$WOUAC" "$woua_src_rel" -o "$wat_rel" 2>/dev/null); then
    echo "SKIP (woua compile error)"
    return
  fi

  # ── WAT → WASM ────────────────────────────────────────────────────────────
  if ! wat2wasm "$wat_file" -o "$wasm_file" 2>/dev/null; then
    echo "SKIP (wat2wasm error)"
    return
  fi
  t1=$(date +%s%3N)
  woua_build_ms=$((t1 - t0))

  # ── Compile Rust → wasm32-wasip1 ─────────────────────────────────────────
  # Pass +simd128 when the benchmark uses wasm32 SIMD intrinsics.
  local rs_wasm_extra_flags=""
  if [ -n "$use_simd" ]; then
    rs_wasm_extra_flags="-C target-feature=+simd128"
  fi
  local rs_wasm_build_ms
  t0=$(date +%s%3N)
  # shellcheck disable=SC2086
  if ! rustc --target wasm32-wasip1 -O -C debuginfo=0 $rs_wasm_extra_flags "$rs_src" -o "$rs_wasm" 2>/dev/null; then
    echo "SKIP (rustc wasm error)"
    return
  fi
  t1=$(date +%s%3N)
  rs_wasm_build_ms=$((t1 - t0))
  # Strip DWARF debug sections from the pre-compiled stdlib that rustc links in.
  wasm-strip "$rs_wasm" 2>/dev/null || true

  # ── Compile Rust native ──────────────────────────────────────────────
  local rust_native_ok=1 rs_native_build_ms=0
  t0=$(date +%s%3N)
  if ! rustc -O "$rs_src" -o "$rs_native" 2>/dev/null; then
    rust_native_ok=0
  else
    t1=$(date +%s%3N)
    rs_native_build_ms=$((t1 - t0))
  fi

  echo ""

  # ── Shared wasmtime flags ─────────────────────────────────────────────────
  local wasmtime_flags=""
  if [ -n "$use_simd" ]; then
    wasmtime_flags="--wasm simd"
  fi

  # ── Run woua WASM ────────────────────────────────────────────────────────
  local woua_out
  # shellcheck disable=SC2086
  woua_out=$(cd "$REPO" && wasmtime $wasmtime_flags "$wasm_file" 2>&1) || true

  # ── Run Rust WASM ────────────────────────────────────────────────────────
  local rust_wasm_out
  # shellcheck disable=SC2086
  rust_wasm_out=$(wasmtime $wasmtime_flags "$rs_wasm" 2>&1) || true

  # ── Run Rust native ──────────────────────────────────────────────────────
  local rust_native_out="(skipped)"
  if [ "$rust_native_ok" -eq 1 ]; then
    rust_native_out=$("$rs_native" 2>&1) || true
  fi

  echo "  woua  (wasm):       $woua_out"
  echo "  rust  (wasm32):     $rust_wasm_out"
  echo "  rust  (native -O):  $rust_native_out"
  echo "  build: woua ${woua_build_ms}ms  /  rust-wasm ${rs_wasm_build_ms}ms  /  rust-native ${rs_native_build_ms}ms"

  # ── WASM binary sizes ─────────────────────────────────────────────────────
  local woua_sz rs_sz woua_kb rs_kb
  woua_sz=$(wc -c < "$wasm_file" 2>/dev/null || echo 0)
  rs_sz=$(wc -c < "$rs_wasm" 2>/dev/null || echo 0)
  woua_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%d\", $woua_sz/1024 }")
  rs_kb=$(LC_NUMERIC=C awk "BEGIN { printf \"%d\", $rs_sz/1024 }")
  echo "  size: woua ${woua_kb} KB  /  rust-wasm ${rs_kb} KB"

  # ── Extract ms values and compute ratios ─────────────────────────────────
  local wt rwt rnt ratio_wasm ratio_native
  wt=$(echo  "$woua_out"         | grep -oP '[0-9]+ ms' | grep -oP '[0-9]+' | tail -1 || true)
  rwt=$(echo "$rust_wasm_out"   | grep -oP '[0-9]+ ms' | grep -oP '[0-9]+' | tail -1 || true)
  rnt=$(echo "$rust_native_out" | grep -oP '[0-9]+ ms' | grep -oP '[0-9]+' | tail -1 || true)
  wt=${wt:-0}; rwt=${rwt:-0}; rnt=${rnt:-0}

  ratio_wasm="-"
  ratio_native="-"
  if [ "$rwt" -gt 0 ] 2>/dev/null; then
    ratio_wasm=$(LC_NUMERIC=C awk "BEGIN { printf \"%.2f\", $wt/$rwt }")
    LC_NUMERIC=C awk "BEGIN { printf \"  ratio vs wasm32: %.2fx  (woua %d ms / rust-wasm %d ms)\\n\", $wt/$rwt, $wt, $rwt }"
  fi
  if [ "$rnt" -gt 0 ] 2>/dev/null; then
    ratio_native=$(LC_NUMERIC=C awk "BEGIN { printf \"%.2f\", $wt/$rnt }")
    LC_NUMERIC=C awk "BEGIN { printf \"  ratio vs native: %.2fx  (woua %d ms / rust-native %d ms)\\n\", $wt/$rnt, $wt, $rnt }"
  fi
  echo ""

  # ── Append row to summary ─────────────────────────────────────────────────
  SUMMARY_ROWS+=("$name|$wt|$rwt|$rnt|$woua_kb|$rs_kb|$ratio_wasm|$ratio_native|$woua_build_ms|$rs_wasm_build_ms|$rs_native_build_ms")
}

# ── Banner ────────────────────────────────────────────────────────────────────
echo "=== woua benchmark suite (both run under wasmtime) ==="
echo "woua compiler : $WOUAC"
echo "rust target   : wasm32-wasip1 -O"
echo "runner        : $(wasmtime --version 2>/dev/null || echo 'wasmtime')"
echo "bench/out     : $OUT"
echo ""

# ── Run all benchmarks ────────────────────────────────────────────────────────
run_bench fib
run_bench fib_opt
run_bench fib_opt2
run_bench sum
run_bench sieve
run_bench matmul
run_bench fft
run_bench simd_dot simd

# ── Summary table ─────────────────────────────────────────────────────────────
if [ ${#SUMMARY_ROWS[@]} -gt 0 ]; then
  echo "┌──────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬───────────────┬────────────────┬────────────┬────────────┬──────────────┐"
  echo "│ benchmark    │ woua(ms) │ rust-w32 │ rust-nat │ woua(KB) │ rust(KB) │ vs rust-wasm  │ vs rust-native │ build:woua │ build:r-w32│ build:r-nat  │"
  echo "├──────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────────────┼────────────────┼────────────┼────────────┼──────────────┤"
  for row in "${SUMMARY_ROWS[@]}"; do
    IFS='|' read -r bname wt rwt rnt woua_kb rs_kb ratio_wasm ratio_native woua_bms rs_wasm_bms rs_nat_bms <<< "$row"
    printf "│ %-12s │ %8s │ %8s │ %8s │ %8s │ %8s │ %13s │ %14s │ %8sms │ %8sms │ %10sms │\n" \
      "$bname" "${wt}" "${rwt}" "${rnt}" "${woua_kb}" "${rs_kb}" \
      "${ratio_wasm}x" "${ratio_native}x" "${woua_bms}" "${rs_wasm_bms}" "${rs_nat_bms}"
  done
  echo "└──────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴───────────────┴────────────────┴────────────┴────────────┴──────────────┘"
  echo ""
fi

echo "Done."
