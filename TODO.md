# TODO — woua improvement ideas

## High priority

- [x] #01 Error reporting — display a useful message (file, line, column, description) when the input file has a syntax or semantic error, instead of silently failing or crashing
- [x] #02 WASI file I/O — investigate and fix issues with opening files and preopened directories; WASI requires enumerating preopened fds via `fd_prestat_get` / `fd_prestat_dir_name` before calling `path_open`; add helpers in `lib/wasi_p1.woua` and a demo
- [x] #03 Command-line arguments — expose `args_sizes_get` + `args_get` from WASI as helpers in `lib/io.woua`; provide `(args-count)` and `(args-get i buf)` macros so programs can read `argv`
- [ ] #04 `not` / `and` / `or` — logical operators as macros in `lib/core.woua`
  - `not`: `(= x 0)`
  - `and`: short-circuit via nested `if`
  - `or`: short-circuit via nested `if`
- [ ] #05 `!=` — inequality operator (`defop` for each numeric type in `lib/core.woua`)
- [ ] #06 `for` — loop macro in `lib/core.woua`: `(for i 0 n body)` expands to `let` + `while`
- [ ] #07 `assert` — `(assert cond "msg")` macro: prints message and calls `proc_exit 1` if condition is false; invaluable for debugging
- [ ] #08 `sprintf` — like `printf` but writes into a `String` buffer instead of stdout; enables building strings at runtime
- [ ] #09 Numeric conversions — `(i32->i64 x)`, `(i64->i32 x)`, `(f32->i32 x)` etc. as `defop` entries in `lib/core.woua`
- [ ] #10 `%x` / `%X` in `printf` — hexadecimal output specifier in `lib/io.woua`
- [ ] #11 `printf` generated functions — instead of inlining code at every call site, the compiler analyses the format string at compile time and emits a call to a generated function named after the WAT argument types; e.g. `(printf "%d\n" x)` → `(call $printf_i32 x)`, `(printf "%d %d\n" x y)` → `(call $printf_i32_i32 x y)`; same argument types → same function, generated once; reduces code size
- [ ] #12 Tail call optimization — emit `return_call` / `return_call_indirect` WAT instructions for self-tail-calls and mutual tail-calls; mandatory for recursive woua code to be safe at depth (the current `printf-impl` is already a recursive macro, but user `defn` functions risk stack overflow without TCO)
- [ ] #13 Operator overloading for user-defined types — allow `defop` to reference a `defn` name instead of a WAT opcode; e.g. `(defop + "Point_add" (:Point :Point) :Point)` dispatches to `(call $Point_add ...)`; `resolveOp` already handles multiple overloads per operator, only the codegen emit path needs extending

## Medium priority

- [ ] #14 First-class functions — pass and store functions as values using WAT function tables + `call_indirect`
  - Function type syntax: `(:i32 -> :i32)` for a function taking one i32 and returning one i32
  - `(defn apply (f (:i32 -> :i32) x :i32) (f x))` — function as parameter
  - `(let fn (:i32 -> :i32) my-func ...)` — function stored in a local
  - Compiler maintains a WAT `(table funcref)` and assigns an index to each referenced function
- [ ] #15 `begin` — sequence macro: `(begin e1 e2 ... en)` without dummy `let _d` workaround
- [ ] #16 `when` / `unless` — single-branch conditionals with implicit body sequence
- [ ] #17 `cond` — multi-branch conditional: `(cond ((test) expr) ... (else expr))`
- [ ] #18 `let*` — sequential bindings in one block: `(let* ((a 1) (b (+ a 1))) ...)` instead of deeply nested `let`
- [ ] #19 `min` / `max` — macros in `lib/core.woua` using `if` + a temp local to avoid double evaluation
- [ ] #20 `mod` / `rem` operators — `i32.rem_s` / `i32.rem_u` missing from `lib/core.woua`
- [ ] #21 Unsigned arithmetic — `div_u`, `rem_u`, `lt_u`, `shr_u` variants in `lib/core.woua` for treating i32/i64 as unsigned
- [ ] #22 `defconst` — named compile-time integer constant: `(defconst MAX_LEN 256)`
- [ ] #23 Static strings as `String` structs — store `(ptr, len)` header in the data section alongside the raw bytes; add `(static-ref msg)` intrinsic returning the header pointer directly as `:String` without heap allocation; `(static-ptr msg)` / `(static-len msg)` kept for backward compatibility
- [ ] #24 Bitwise operators in `lib/core.woua`: `band`, `bor`, `bxor`, `bnot`, `shl`, `shr`
- [ ] #25 Arrays — `Array` type as a `(ptr, len)` struct with index-get/set macros and optional bounds checking
- [ ] #26 Tuples — multi-value return via the WASM multi-value proposal: `(defn divmod (a b) (:i32 :i32) ...)` + destructuring `(let (q r) (divmod 10 3) ...)`; avoids struct allocation for result pairs
- [ ] #27 Value-type structs — one `deftype` definition, allocation site decides heap vs locals; depends on tuples (#26)
  - `deftype` auto-generates two constructors: `Point/heap` and `Point/local`
  - `(let p :Point (Point/heap 0 0) ...)` → one i32 heap pointer (current behavior)
  - `(let p :Point (Point/local 0 0) ...)` → N locals `$p.x $p.y`, no heap allocation
  - `(defn get-origin () :Point (Point/local 0 0))` emits `(result i32 i32)` automatically
  - `(let p :Point (get-origin) ...)` pops the N stack values into the locals
  - Field accessor syntax `(Point/x p)` and `(Point/x! p v)` unchanged in both cases
  - Value-type multi-return must always be bound via `let` (no anonymous temporaries)

## Lower priority

- [ ] #28 Memory management — the current bump allocator never reclaims memory; any loop that allocates will exhaust linear memory
  - Option 1: `(alloc-reset)` — reset `$heap_ptr` to post-static baseline; frees everything at once; useful for request/response style programs
  - Option 2: stack allocator — push/pop a stack pointer for scoped allocations; zero overhead within a `let` block
  - Option 3: real `free` — per-object deallocation via a buddy or slab allocator; complex but necessary for general-purpose programs
- [ ] #29 `string-to-int` in `lib/string.woua` — parse a decimal string to i32
- [ ] #30 `string-trim` in `lib/string.woua` — strip leading/trailing whitespace bytes
- [ ] #31 `defvar` — mutable global variable (WAT `global` with get/set sugar)
- [ ] #32 Maps (hash maps) — hash function, collision handling, dynamic resizing; depends on arrays (#25) being available first
- [ ] #33 Separate compilation — compile multiple `.woua` files independently and link them; needed once programs grow large; requires an export/import mechanism between woua modules
- [ ] #34 VS Code extension — update syntax highlighting to recognise char literals (`'A'`, `'\n'`) and highlight them as numeric literals
- [ ] #35 `clock_time_get` — wall clock and monotonic timer via WASI; needed for benchmarks and timeouts
- [ ] #36 `random_get` — entropy from the host via WASI; needed for hashing, UUIDs, random number generation
- [ ] #37 Environment variables — expose `environ_sizes_get` + `environ_get` from WASI; add `(env-get "VAR" buf)` helper in `lib/wasi_p1.woua`

