# TODO — woua improvement ideas

## High priority

- [x] #01 Error reporting — display a useful message (file, line, column, description) when the input file has a syntax or semantic error, instead of silently failing or crashing
- [x] #02 WASI file I/O — investigate and fix issues with opening files and preopened directories; WASI requires enumerating preopened fds via `fd_prestat_get` / `fd_prestat_dir_name` before calling `path_open`; add helpers in `lib/wasi_p1.woua` and a demo
- [x] #03 Command-line arguments — expose `args_sizes_get` + `args_get` from WASI as helpers in `lib/io.woua`; provide `(args-count)` and `(args-get i buf)` macros so programs can read `argv`
- [x] #38 Static memory map — when a `-map` flag is passed to the compiler, write a `<output>.map` file alongside the WAT output listing every static allocation (name, address, size, type) recorded in `env.statics` during compilation; useful for debugging memory layout
- [x] #04 `not` / `and` / `or` — bitwise operators as `defop` entries in `lib/core.woua` (`i32.and`, `i32.or`, `i32.xor`, `i32.eqz` for not)
- [x] #05 `!=` — inequality operator (`defop` for each numeric type in `lib/core.woua`)
- [x] #06 `for` — loop macro in `lib/core.woua`: `(for i 0 n body)` expands to `let` + `while`
- [x] #07 `assert` — `(assert cond "msg")` macro: prints message and calls `proc_exit 1` if condition is false; invaluable for debugging
- [x] #40 WAT comments — emit `(;..;)` inline comments in the WAT output to aid readability and debugging; two sources: (1) compiler-generated labels on key constructs (`defn` name, `let` binding name, struct field accesses, generated `__printf_N` purpose); (2) user comments — `;; ...` lines in the source are forwarded as WAT comments attached to the next emitted construct
- [x] #41 Explicit return type on `defn` — `(defn name (params...) :ReturnType body...)` declares the return type explicitly instead of relying on inference; the compiler should emit the declared WAT `(result ...)` rather than inferring it from the last body expression; a `:void` annotation means no result; mismatches between declared and inferred type should produce a compile error; this is the last missing piece to make `defn` signatures fully explicit in this strictly-typed language
- [x] #44 Escape sequences in string literals — basic escapes (`\n`, `\t`, `\r`, `\\`, `\"`, `\0`) are handled in `readLiteral` in the reader; the only missing escape is `\xNN` (arbitrary hex byte); add two-digit hex parsing after the `\x` prefix in the `readLiteral` escape dispatcher in `reader.ts`
- [x] #45 `path_open` and preopens in `lib/wasi_p1.woua` — WASI sandboxes file system access via preopened directory fds; before any `path_open` call the program must enumerate them with `fd_prestat_get` / `fd_prestat_dir_name` (scanning fds starting at 3 until `EBADF`); add the missing `defimport` declarations (`fd_prestat_get`, `fd_prestat_dir_name`, `path_open`, `path_create_directory`, `path_unlink_file`, `path_rename`) to `lib/wasi_p1.woua`; add a `(find-preopen dir-name buf)` helper macro that iterates preopened fds and returns the fd whose name matches; add a `(open-file preopen-fd path flags oflags)` convenience wrapper around `path_open`; add a demo program in `demos/` that opens and reads a file passed on the command line
- [x] #43 Refactor `:str` — currently `:str` is treated as a bare `i32` (raw pointer) throughout the compiler; replace it with a first-class fat-pointer type `(ptr :i32, len :i32)` stored as two WAT locals or a two-value tuple; string literals should produce a `:str` value (ptr + len) rather than just a raw ptr; `printf %s` and `write` should accept `:str` directly; `(static-ptr msg)` / `(static-len msg)` become derived accessors on `:str`; `watType` should expand `:str` to two WAT values `i32 i32` in function signatures; this is a prerequisite for #08 (sprintf), #23 (static str structs), and any future string-manipulation library
- [ ] #08 `sprintf` — like `printf` but writes into a `str` buffer instead of stdout; enables building strings at runtime
- [x] #09 Numeric conversions — superseded by `(as :Type expr)` which handles all i32↔i64↔f32↔f64 casts with a single unified form (test 11)
- [ ] #10 `%x` / `%X` in `printf` — hexadecimal output specifier in `lib/io.woua`
- [x] #11 `printf` generated functions
- [ ] #12 Tail call optimization — emit `return_call` / `return_call_indirect` WAT instructions for self-tail-calls and mutual tail-calls; mandatory for recursive woua code to be safe at depth (the current `printf-impl` is already a recursive macro, but user `defn` functions risk stack overflow without TCO)
- [ ] #13 Operator overloading for user-defined types — allow `defop` to reference a `defn` name instead of a WAT opcode; e.g. `(defop + "Point_add" (:Point :Point) :Point)` dispatches to `(call $Point_add ...)`; `resolveOp` already handles multiple overloads per operator, only the codegen emit path needs extending

## Medium priority

- [x] #14 First-class functions — pass and store functions as values using WAT function tables + `call_indirect`
  - Function type syntax: `(:i32 -> :i32)` for a function taking one i32 and returning one i32
  - `(defn apply (f (:i32 -> :i32) x :i32) (f x))` — function as parameter
  - `(let fn (:i32 -> :i32) my-func ...)` — function stored in a local
  - Compiler maintains a WAT `(table funcref)` and assigns an index to each referenced function
- [x] #15 `progn` — sequence form: `(progn e1 e2 ... en)` without dummy `let _d` workaround
- [ ] #16 `when` / `unless` — single-branch conditionals with implicit body sequence
- [ ] #17 `cond` — multi-branch conditional: `(cond ((test) expr) ... (else expr))`
- [ ] #18 `let*` — sequential bindings in one block: `(let* ((a 1) (b (+ a 1))) ...)` instead of deeply nested `let`
- [ ] #19 `min` / `max` — macros in `lib/core.woua` using `if` + a temp local to avoid double evaluation
- [ ] #20 `mod` / `rem` operators — `i32.rem_s` / `i32.rem_u` missing from `lib/core.woua`
- [ ] #21 Unsigned arithmetic — `div_u`, `rem_u`, `lt_u`, `shr_u` variants in `lib/core.woua` for treating i32/i64 as unsigned
- [ ] #22 `defconst` — named compile-time integer constant: `(defconst MAX_LEN 256)`
- [ ] #23 Static strings as `str` structs — store `(ptr, len)` header in the data section alongside the raw bytes; add `(static-ref msg)` intrinsic returning the header pointer directly as `:str` without heap allocation; `(static-ptr msg)` / `(static-len msg)` kept for backward compatibility
- [ ] #24 Bitwise operators in `lib/core.woua`: `band`, `bor`, `bxor`, `bnot`, `shl`, `shr`
- [ ] #25 Arrays — `Array` type as a `(ptr, len)` struct with index-get/set macros and optional bounds checking
- [x] #26 Tuples — multi-value return via the WASM multi-value proposal: `(defn divmod (a b) (:i32 :i32) ...)` + destructuring `(let (q r) (divmod 10 3) ...)`; avoids struct allocation for result pairs
- [x] #42 Tuple locals — bind a multi-value result to a named local tuple variable without heap allocation; `(let pair (:i32 :i32) (minmax 4 3) ...)` expands internally to two locals `$pair_0 :i32` and `$pair_1 :i32`; accessors `(pair/0 pair)` and `(pair/1 pair)` read the individual fields; no `deftype` required; types inferred from the callee's declared tuple return annotation or taken from the inline type annotation; depends on #26
- [ ] #27 Value-type structs — the type annotation at the use site determines storage; `deftype` only declares field layout
  - `:Point` — value type: fields become WAT locals (`$p_x`, `$p_y`); no allocation
  - `:*Point` — reference type: one `i32` heap pointer (current implicit behavior); compiler emits `alloc` automatically
  - Constructor is the same in both cases: `(Point 10 20)` — no `Point/heap` / `Point/local` split
  - `(let p :Point (Point 10 20) ...)` → fields in WAT locals, no heap allocation
  - `(let p :*Point (Point 10 20) ...)` → compiler allocates, fills fields, `p` is an i32 pointer
  - `(defn get-origin () :Point (Point 0 0))` emits `(result i32 i32)` automatically (multi-value return)
  - Field accessor syntax `(Point/x p)` and `(Point/x! p v)` unchanged in both cases
  - Depends on tuples (#26) for the multi-value local case

## Lower priority

- [ ] #39 `proc_exit` after `main` — the generated `_start` function should call `proc_exit 0` immediately after `main` returns, ensuring a clean WASI exit code even when `main` does not call `proc_exit` itself

- [ ] #28 Memory management — the current bump allocator never reclaims memory; any loop that allocates will exhaust linear memory
  - Option 1: `(alloc-reset)` — reset `$heap_ptr` to post-static baseline; frees everything at once; useful for request/response style programs
  - Option 2: stack allocator — push/pop a stack pointer for scoped allocations; zero overhead within a `let` block
  - Option 3: real `free` — per-object deallocation via a buddy or slab allocator; complex but necessary for general-purpose programs
- [ ] #47 Number ↔ str conversions in `lib/string.woua`:
  - [x] `(i32->str n)` → `:str` — already done
  - [x] `(i64->str n)` → `:str` — already done
  - [ ] `(str->i32 s :str)` → `:i32` — parse decimal string (replaces old #29)
  - [ ] `(str->i64 s :str)` → `:i64` — parse decimal string to i64
  - [ ] `(f32->str x :f32 prec :i32)` → `:str` — f32 to decimal with given precision
  - [ ] `(f64->str x :f64 prec :i32)` → `:str` — f64 to decimal with given precision
  - [ ] `(str->f32 s :str)` → `:f32` — parse float from string
  - [ ] `(str->f64 s :str)` → `:f64` — parse float from string
- [ ] #30 `string-trim` in `lib/string.woua` — strip leading/trailing whitespace bytes
- [ ] #31 `defvar` — mutable global variable (WAT `global` with get/set sugar)
- [ ] #32 Maps (hash maps) — hash function, collision handling, dynamic resizing; depends on arrays (#25) being available first
- [ ] #33 Separate compilation — compile multiple `.woua` files independently and link them; needed once programs grow large; requires an export/import mechanism between woua modules
- [ ] #34 VS Code extension — update syntax highlighting to recognise char literals (`'A'`, `'\n'`) and highlight them as numeric literals
- [x] #35 `lib/time.woua` — time helpers built on top of `clock_time_get` and `clock_res_get` from `wasi_p1.woua`:
  - `(time-now-ns)` → i64 — monotonic timestamp in nanoseconds (`CLOCK_MONOTONIC`, id=1)
  - `(time-now-ms)` → i64 — monotonic timestamp in milliseconds
  - `(time-realtime-ns)` → i64 — wall-clock time in nanoseconds since Unix epoch (`CLOCK_REALTIME`, id=0)
  - `(time-elapsed-ms start)` → i64 — convenience: `(- (time-now-ms) start)`
  - Add a `demos/bench.woua` demo that times a simple loop using `time-now-ms`
- [ ] #36 `random_get` — entropy from the host via WASI; needed for hashing, UUIDs, random number generation
- [ ] #37 Environment variables — expose `environ_sizes_get` + `environ_get` from WASI; add `(env-get "VAR" buf)` helper in `lib/wasi_p1.woua`
- [ ] #46 Missing WASI Preview 1 functions — add `defimport` declarations in `lib/wasi_p1.woua` for the functions not yet covered:
  - **File descriptors**: `fd_advise`, `fd_allocate`, `fd_datasync`, `fd_fdstat_get`, `fd_fdstat_set_flags`, `fd_filestat_get`, `fd_filestat_set_size`, `fd_filestat_set_times`, `fd_pread`, `fd_pwrite`, `fd_readdir`
  - **Paths**: `path_filestat_get`, `path_filestat_set_times`, `path_link`, `path_readlink`, `path_remove_directory`, `path_symlink`
  - **Sockets**: `sock_accept`, `sock_recv`, `sock_send`, `sock_shutdown`
  - **Poll**: `poll_oneoff` — wait on a set of events (WASI equivalent of `select`)
  - Highest practical value first: `fd_readdir`, `fd_filestat_get`, `path_filestat_get`, `path_remove_directory`, `fd_pread`/`fd_pwrite`, `poll_oneoff`


