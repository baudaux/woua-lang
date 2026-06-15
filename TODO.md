# TODO — woua improvement ideas

## High priority

- [x] #63 SIMD vector literals — `v128.const` is too verbose and low-level; design a friendlier syntax
  - Preferred style: colon-separated lane values with the type as a bare suffix (no leading `:`), e.g. `1:2:3:4i32x4`, `1.0:2.0:3.0:4.0f32x4`, `0:1:2:3:4:5:6:7:8:9:10:11:12:13:14:15i8x16`
  - Consistent with existing suffix literals like `42i64` — type tag comes last, no leading colon
  - Splat shorthand: `5i32x4` (single value, no colons) broadcasts to all lanes
  - Expands directly to WAT's native typed form: `1:2:3:4i32x4` → `v128.const i32x4 1 2 3 4`, `1.0:2.0:3.0:4.0f32x4` → `v128.const f32x4 1.0 2.0 3.0 4.0`
  - WAT supports all lane interpretations: `i8x16`, `i16x8`, `i32x4`, `i64x2`, `f32x4`, `f64x2`
  - Requires a new `TAG_V128` AST node (lane type + values) since `defliteral` only handles single Int/Float values
  - The current `(v128.const b0 b1 … b15)` 16-byte i8x16 form stays as a low-level escape hatch

- [x] #62 SIMD support — expose WebAssembly SIMD (128-bit vector) instructions as first-class operations in woua
  - Add `:v128` as a primitive type recognized by `watType`, `sizeOf`, `alignOf`
  - Add `defop` entries in `lib/core.woua` (or a new `lib/simd.woua`) for the main SIMD opcodes: `v128.load`, `v128.store`, `i8x16.splat`, `i16x8.splat`, `i32x4.splat`, `i64x2.splat`, `f32x4.splat`, `f64x2.splat`, lane-wise add/sub/mul (`i32x4.add`, `f32x4.add`, …), shuffle (`i8x16.shuffle`), and comparisons
  - SIMD literals: `(v128 0x00 0x01 … 0x0f)` — 16-byte constant encoded as a `v128.const` immediate
  - `(v128.load ptr)` / `(v128.store ptr val)` macros wrapping the typed memory instructions
  - Add a `demos/simd.woua` demo (e.g. dot-product of two f32x4 vectors)
  - Requires the target runtime / `wasm-opt` to have the SIMD proposal enabled (`--enable-simd`)

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
- [x] #08 `sprintf` — like `printf` but writes into a `str` buffer instead of stdout; enables building strings at runtime
- [x] #09 Numeric conversions — superseded by `(as :Type expr)` which handles all i32↔i64↔f32↔f64 casts with a single unified form (test 11)
- [ ] #10 `%x` / `%X` in `printf` — hexadecimal output specifier in `lib/io.woua`
- [x] #65 `%f` / `%lf` in `printf` — float formatting specifiers; requires a runtime f32/f64→string conversion (e.g. Grisu or ryu-style) since WASM has no built-in float-to-decimal; `%f` → `:f32`, `%lf` → `:f64`
- [x] #11 `printf` generated functions
- [x] #12 Tail call optimization — emit `return_call` / `return_call_indirect` WAT instructions for self-tail-calls and mutual tail-calls; mandatory for recursive woua code to be safe at depth (the current `printf-impl` is already a recursive macro, but user `defn` functions risk stack overflow without TCO)
- [x] #13 Operator overloading for user-defined types — allow `defop` to reference a `defn` name instead of a WAT opcode; e.g. `(defop + "Point_add" (:Point :Point) :Point)` dispatches to `(call $Point_add ...)`; `resolveOp` already handles multiple overloads per operator, only the codegen emit path needs extending
- [x] #59 `lib/wasix.woua` — WASIX extension library with at least two helpers:
  - `tty_get` — wraps the `wasix:tty/get` syscall to retrieve the current TTY settings (rows, cols, stdin/stdout isatty flags) into a struct
  - `tty_set` — wraps `wasix:tty/set` to apply new TTY settings (e.g. disable echo, set raw mode)
  - `defimport` both from the `"wasix_32v1"` module; define a `(deftype TtyState ...)` struct capturing the relevant fields; expose `(tty-get buf)` and `(tty-set buf)` macros in the library

## Medium priority

- [x] #66 `lib/math.woua` — math function library: `sin`, `cos`, `sqrt`, `floor`, `ceil`, `round`, `pow`, `log`, `exp`; backed by WASM's built-in `f32.sqrt`/`f64.sqrt` where available, and WASI `wasi:math` imports or a software fallback for the rest; prerequisite for FFT twiddle factors and any numeric demo
- [x] #14 First-class functions — pass and store functions as values using WAT function tables + `call_indirect`
  - Function type syntax: `(:i32 -> :i32)` for a function taking one i32 and returning one i32
  - `(defn apply (f (:i32 -> :i32) x :i32) (f x))` — function as parameter
  - `(let fn (:i32 -> :i32) my-func ...)` — function stored in a local
  - Compiler maintains a WAT `(table funcref)` and assigns an index to each referenced function
- [x] #15 `progn` — sequence form: `(progn e1 e2 ... en)` without dummy `let _d` workaround
- [ ] #16 `when` / `unless` — single-branch conditionals with implicit body sequence
- [x] #17 `cond` — multi-branch conditional: `(cond ((test) expr) ... (else expr))`
- [x] #18 `let*` — sequential bindings in one block: `(let* ((a 1) (b (+ a 1))) ...)` instead of deeply nested `let`
- [ ] #19 `min` / `max` — macros in `lib/core.woua` using `if` + a temp local to avoid double evaluation
- [x] #20 `mod` / `rem` operators — `i32.rem_s` / `i32.rem_u` missing from `lib/core.woua`
- [ ] #21 Unsigned arithmetic — `div_u`, `rem_u`, `lt_u`, `shr_u` variants in `lib/core.woua` for treating i32/i64 as unsigned
- [x] #22 `defconst` — named compile-time integer constant: `(defconst MAX_LEN 256)`
- [x] #69 `defconst` constant folding — arithmetic expressions in `defconst` bodies should be evaluated at compile time rather than emitted as runtime instructions; e.g. `(defconst FFT-BYTES (* FFT-N 8))` should resolve to `32768` in the compiled output; requires a compile-time evaluator (`constEval`) that handles `+`, `-`, `*`, `/`, `%`, `<<`, `>>`, `and`, `or`, `xor` over literals and previously-defined `defconst` names; supported types: `:i32`, `:i64`, `:f32`, `:f64` (type inferred from the operands); the result should be stored as a typed constant in `env.consts` so all use sites inline the folded value; operands that are not literals or known `defconst` names should be a hard compile error rather than silently falling back to runtime evaluation
- [x] #23 Static strings as `str` structs — `(defstatic name :str "text")` stores an 8-byte `{base:i32, len:i32}` header followed by the raw bytes in the data section; `(static-ref name)` returns the header address (a `:str` pointer in linear memory); `(static-ptr name)` / `(static-len name)` kept for backward compatibility
- [x] #24 Bitwise operators in `lib/core.woua`: `band`, `bor`, `bxor`, `bnot`, `shl`, `shr`
- [ ] #48 Dynamic `:str` allocation — consistent in-memory `{base:i32, len:i32}` layout for runtime-built strings; add `(str-alloc maxlen)` → i32 pointer to a zeroed header+buffer in the heap; add `(str-set-ptr s ptr)` / `(str-set-len s len)` setters; `(str/ptr s)` / `(str/len s)` getters already work via the fat-pointer accessors; this makes static `(defstatic name :str "text")` and dynamic heap strings share the same representation, enabling arrays of `:str`, return by pointer, and eventually a string-builder API
- [x] #25 Arrays — `Array` type as a `(ptr, len, capacity)` struct with index-get/set macros and optional bounds checking
- [ ] #70 Typed array / slice syntax — `:T[]` as a fat-pointer slice `{ptr, len}` and `:T[N]` as a fixed allocation; the element type and length are declared once and never repeated at call sites
  - **Storage follows the same `:T` / `:*T` convention as structs (#27)**:
    - `:T[N]` / `:T[]` — fat pointer `{ptr: i32, len: i32}` held in **two WAT locals**; used for local variables and function parameters; like `:str` which already works this way
    - `:*T[N]` / `:*T[]` — the `{ptr, len}` header lives in **linear memory**; the variable holds a single `i32` pointing to it; used for struct fields, arrays-of-slices, and heap-allocated slice headers
  - **`:T[]` — slice (fat pointer in locals)**: two WAT values `(i32, i32)`; `sizeOf` = 8; element type `T` drives load/store selection; like `:str`
  - **`:T[N]` — allocation shorthand (locals)**: `(let buf :i32[16] ...)` expands to a `:i32[]` slice `{alloc(16 * sizeof(:i32)), 16}` in two WAT locals; `N` may be a literal, `defconst`, or runtime expression
  - **`:*T[]` — slice header in memory**: `sizeOf` = 4 (one `i32` pointer); the pointed-to header is 8 bytes in the heap; used in `deftype` fields and struct arrays: `(deftype Foo (items :*i32[]) ...)`
  - **`:*T[N]` — heap-allocated slice**: `(let buf :*i32[16] ...)` allocates both the element buffer and the 8-byte `{ptr, len}` header in linear memory; `buf` is an `i32` pointer to the header
  - `(aref buf i)` — reads element `i`; works for both `:T[]` and `:*T[]`; element type inferred from declared type
  - `(aset! buf i val)` — writes element `i`
  - `(aref! buf i)` — bounds-checked read; length read from fat pointer automatically
  - `(aset!! buf i val)` — bounds-checked write
  - `(alen buf)` — returns the length; works for both storage forms
  - Example:
    ```
    (let buf :i32[16]                         ;; two WAT locals {alloc(64), 16}
      (for i 0 (alen buf) (aset! buf i (* i i)))
      (printf "%d\n" (aref! buf 7)))
    (defn sum (xs :f64[]) :f64                ;; fat pointer passed as two WAT params
      (let acc :f64 0.0
        (for i 0 (alen xs) (set! acc (+ acc (aref xs i))))
        acc))
    (deftype Window                            ;; slice field stored in linear memory
      (samples :*f64[])
      (size    :i32))
    ```
  - **Relation to `Array`**: `Array` = owned growable `{ptr, len, cap}`; `:T[]` = fixed-length slice `{ptr, len}`; `(Array/slice a)` produces a `:f64[]` from an `Array`; after #70 most `Array` uses (fixed-size numeric buffers) can be replaced with `:T[N]`; only push/pop dynamic accumulation still needs `Array`
  - **Consistency with `:str`**: `:str` is already `{ptr, len}` as two `i32` WAT values; `:T[]` follows the identical pattern; compiler machinery (`watType`, `funcTupleResults`, param expansion) is largely reusable
  - **Reader**: `[` is not a delimiter so `:i32[16]` is already one atom in `readAtom`; post-process: `:[T][]` → slice type, `:[T][N]` → alloc shorthand, `:*[T][]` / `:*[T][N]` → heap-header variants
  - **`sizeOf` / `watType`**: `:T[]` → size 8, two WAT params; `:*T[]` → size 4, one WAT param
  - **`defstatic`**: `(defstatic name :i32[8])` allocates 32 bytes in the data section; `(alen name)` folds to compile-time constant `8`
  - Migration: existing `(array-ref :i32 buf i)` stays valid; all new syntax is purely additive
- [x] #26 Tuples — multi-value return via the WASM multi-value proposal: `(defn divmod (a b) (:i32 :i32) ...)` + destructuring `(let (q r) (divmod 10 3) ...)`; avoids struct allocation for result pairs
- [x] #42 Tuple locals — bind a multi-value result to a named local tuple variable without heap allocation; `(let pair (:i32 :i32) (minmax 4 3) ...)` expands internally to two locals `$pair_0 :i32` and `$pair_1 :i32`; accessors `(pair/0 pair)` and `(pair/1 pair)` read the individual fields; no `deftype` required; types inferred from the callee's declared tuple return annotation or taken from the inline type annotation; depends on #26
- [x] #27 Value-type structs — the type annotation at the use site determines storage; `deftype` only declares field layout
  - `:Point` — value type: fields become WAT locals (`$p_x`, `$p_y`); no allocation
  - `:*Point` — reference type: one `i32` heap pointer (current implicit behavior); compiler emits `alloc` automatically
  - Constructor is the same in both cases: `(Point 10 20)` — no `Point/heap` / `Point/local` split
  - `(let p :Point (Point 10 20) ...)` → fields in WAT locals, no heap allocation
  - `(let p :*Point (Point 10 20) ...)` → compiler allocates, fills fields, `p` is an i32 pointer
  - `(defn get-origin () :Point (Point 0 0))` emits `(result i32 i32)` automatically (multi-value return)
  - Field accessor syntax `(Point/x p)` and `(Point/x! p v)` unchanged in both cases
  - Depends on tuples (#26) for the multi-value local case

## Lower priority

- [x] #58 `:u8` field type in structs — 1-byte unsigned integer field in `deftype`; size 1, alignment 1; get emits `i32.load8_u`, set emits `i32.store8`; static constructors encode one escaped byte; WAT local type remains `i32` (WebAssembly has no u8 local)

- [x] #49 Nested structs — a struct field whose type is another `deftype`
  - Currently broken: `sizeOf` and `alignOf` in `env.ts` only know primitives; user-defined type names return size 1
  - `sizeOf(t)` must recurse into `env.types` when `t` is a registered struct name
  - `alignOf(t)` must return the alignment of the first field of the inner struct
  - `expandFieldGet` / `expandFieldSet` must compute the correct flat byte offset (outer offset + inner field offset)
  - Value-type let-binding must recursively expand nested struct fields into WAT locals (e.g. `outer_inner_x`, `outer_inner_y`)
  - Reference-type binding already stores a flat pointer, so nested ref fields just need correct offsets

- [x] #39 `proc_exit` after `main` — the generated `_start` function should call `proc_exit 0` immediately after `main` returns, ensuring a clean WASI exit code even when `main` does not call `proc_exit` itself

- [x] #28 Memory management — the current bump allocator never reclaims memory; any loop that allocates will exhaust linear memory
  - [x] Option 1: `(alloc-reset)` — reset `heap-ptr` to post-static baseline; frees everything at once
  - [x] Option 2: arena stack — `(arena-push)` / `(arena-pop)`, `(with-arena body...)`, `(defn f () :arena ...)` for scoped allocations

- [ ] #50 Ownership and lifetimes for heap-allocated structs — currently nothing in the language tracks who owns a `:*T` pointer or how long it lives
  - The compiler allocates but never frees; callers cannot express "this function gives you ownership" vs "borrow only"
  - Potential approaches (from lightest to heaviest):
    - Convention-based: document ownership in comments; programmer calls `(free p)` manually when #28 option 3 exists
    - Arena/scope lifetime: tie allocation lifetime to a `let` scope via a scope-local bump pointer; pointer becomes invalid after the `let` exits (compile-time enforcement optional)
    - Linear types: mark a `:*T` as `own` vs `borrow` in the type system; compiler enforces that owned pointers are freed exactly once
  - Depends on #28 (need a reclamation strategy before ownership matters)
- [ ] #47 Number ↔ str conversions in `lib/string.woua`:
  - [x] `(i32->str n)` → `:str` — already done
  - [x] `(i64->str n)` → `:str` — already done
  - [ ] `(str->i32 s :str)` → `:i32` — parse decimal string (replaces old #29)
  - [ ] `(str->i64 s :str)` → `:i64` — parse decimal string to i64
  - [x] `(f32->str f :f32)` → `:str` — done (fixed 6 decimal places; no precision param yet)
  - [x] `(f64->str f :f64)` → `:str` — done (fixed 6 decimal places; no precision param yet)
  - [ ] `(f32->str x :f32 prec :i32)` → `:str` — f32 to decimal with configurable precision
  - [ ] `(f64->str x :f64 prec :i32)` → `:str` — f64 to decimal with configurable precision
  - [ ] `(str->f32 s :str)` → `:f32` — parse float from string
  - [ ] `(str->f64 s :str)` → `:f64` — parse float from string
- [ ] #30 `string-trim` in `lib/string.woua` — strip leading/trailing whitespace bytes
- [x] #31 `defvar` — mutable global variable (WAT `global` with get/set sugar)
- [ ] #31b `defvar :NestedStruct` — `defvar` with value-type structs containing embedded structs (e.g. `(defvar r :Rect)` where `Rect` has a `Vec2` field); currently only flat structs work; nested fields need recursive sub-global registration and accessor dispatch
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
- [x] #46 Missing WASI Preview 1 functions — add `defimport` declarations in `lib/wasi_p1.woua` for the functions not yet covered:
  - **File descriptors**: `fd_advise`, `fd_allocate`, `fd_datasync`, `fd_fdstat_get`, `fd_fdstat_set_flags`, `fd_filestat_get`, `fd_filestat_set_size`, `fd_filestat_set_times`, `fd_pread`, `fd_pwrite`, `fd_readdir`
  - **Paths**: `path_filestat_get`, `path_filestat_set_times`, `path_link`, `path_readlink`, `path_remove_directory`, `path_symlink`
  - **Sockets**: `sock_accept`, `sock_recv`, `sock_send`, `sock_shutdown`
  - **Poll**: `poll_oneoff` — wait on a set of events (WASI equivalent of `select`)
  - Highest practical value first: `fd_readdir`, `fd_filestat_get`, `path_filestat_get`, `path_remove_directory`, `fd_pread`/`fd_pwrite`, `poll_oneoff`

- [x] #51 Object-oriented dispatch — static method dispatch via `defop` calling a `defn` (extends TODO #13)
  - Extend `defop` to accept a function name in place of a WAT opcode: `(defop area "shape-area" (:*Shape) :i32)`
  - The compiler emits `(call $shape-area ...)` instead of a WAT instruction
  - Combined with overloading this gives CLOS-style generic functions: `(area circle)` and `(area rect)` dispatch to different implementations based on argument type
  - No vtable or heap overhead — dispatch is resolved at compile time
  - Depends on #13

- [x] #52 Protocols — compile-time interface declaration and verification
  - `(defprotocol Name (method (self :*Self) :RetType) ...)` declares a named set of required methods
  - `(defimpl Name TypeName (defn method ...) ...)` provides the implementation; compiler verifies all methods are present with correct signatures
  - A type satisfying a protocol can be passed wherever the protocol is expected (structural subtyping)
  - The compiler can optionally generate a vtable struct automatically for runtime dispatch
  - Builds on #51 (defop → defn dispatch) and #13

- [ ] #60 Protocol as parameter type — allow a function to accept a protocol as a parameter type: `(defn print-shape (s :*Shape) :void ...)`
  - Currently impossible: dispatch is purely compile-time and there is no runtime representation of a protocol value
  - Option A: vtable — `defprotocol` generates a vtable struct (one function-pointer field per method); `defimpl` populates a static vtable instance; `:*Shape` becomes a fat pointer `(data :i32, vtable :i32)`; dispatch emits `call_indirect`
  - Option B: monomorphic generics — the compiler specialises the function for each concrete type at call sites (no runtime overhead, but code duplication)
  - Option A is more idiomatic for WASM; option B avoids vtable overhead; both depend on `first_class_fn` (#33 table) being solid

- [ ] #61 Pattern matching — `(match expr (pattern body) ...)` form for structural dispatch
  - More powerful than `cond`: matches on value, type, struct shape, or destructures a tuple/struct in one step
  - Example: `(match x (0 "zero") ((< 0) "positive") (_ "negative"))`
  - Struct destructuring: `(match p ((Point x y) (printf "%d %d\n" x y)))`
  - Could compile to nested `if` + let-bindings for destructuring
  - Depends on tuples (#26) and protocols (#52) for type-based dispatch

- [x] #67 `bench/` — benchmark suite comparing woua (via `wasmtime`) against native Rust; each benchmark has a `.woua` source and an equivalent `bench_NAME.rs`; a `run_bench.sh` driver runs both, prints side-by-side wall-clock times (`time-now-ns` from `lib/time.woua` for woua, `std::time::Instant` for Rust), and emits a ratio
  - **`bench/fib.woua`** — recursive Fibonacci `fib(40)`: integer recursion, no allocation; classic baseline
  - **`bench/sum.woua`** — sum 100 M integers in a loop: tight loop, pure i64 arithmetic; tests loop overhead vs LLVM -O3
  - **`bench/sieve.woua`** — Sieve of Eratosthenes up to 1 M: array reads/writes, branch-heavy inner loop; tests memory access patterns
  - **`bench/matmul.woua`** — 256×256 f64 matrix multiply: floating-point throughput; prerequisite for SIMD matmul follow-up
  - **`bench/fft.woua`** — 4096-point Cooley-Tukey FFT using `lib/math.woua` (`sin`/`cos`/`exp`): complex arithmetic, divide-and-conquer; tests the math library end-to-end
  - **`bench/simd_dot.woua`** — dot product of two 1024-element f32 arrays using `f32x4.mul` + `f32x4.add`: SIMD throughput vs scalar Rust; requires `lib/simd.woua`
  - Rust equivalents compiled with `rustc -O` or `cargo build --release`; wasmtime run with `--wasm simd` where needed
  - Expected outcome: wasmtime/woua within ~1.5–2× of native Rust for compute-bound kernels; larger gaps expose missing optimisations

- [x] #71 HTML DOM rendering — build interactive HTML apps from woua programs by writing incremental DOM commands to `/dev/dom`, a virtual device file provided by the host environment
  - **Protocol**: each `write` to `/dev/dom` carries one or more newline-terminated commands; the JS bridge applies them to a live HTML container using upsert-by-id — if an element with the given `id` already exists its attributes/text are updated in place, otherwise a new child element is inserted under the current insertion parent; this enables both static layout and live animation without full redraws
  - **`DomBuf` deftype** — `(ptr :ptr) (len :i32) (cap :i32)`; all commands take a `:*DomBuf` and update `len` in place; the caller passes `(DomBuf/ptr buf)` and `(DomBuf/len buf)` to `write`; mirrors `SvgBuf` from `lib/svg.woua`
  - **`lib/dom.woua`** — woua-side library that serialises DOM commands into a linear-memory byte buffer:
    - `(dom-buf-new cap)` — allocate a `DomBuf` with `cap` byte capacity
    - `(dom-buf-reset buf)` — reset write cursor to start
    - `(dom-flush-to buf fd)` — write buffer contents to fd and reset
    - **Block elements**: `(dom-div buf id)`, `(dom-section buf id)` — upsert an empty container element
    - **Text elements**: `(dom-h1 buf id text)`, `(dom-h2 buf id text)`, `(dom-h3 buf id text)`, `(dom-p buf id text)`, `(dom-span buf id text)`, `(dom-pre buf id text)` — upsert element with text content
    - **Form elements**: `(dom-button buf id text)`, `(dom-input buf id type value)`
    - **Structure**: `(dom-parent buf id)` — set insertion parent; `(dom-parent-root buf)` — reset to root container
    - **Lifecycle**: `(dom-remove buf id)` — remove element; `(dom-clear buf)` — remove all children from root
    - **Attribute commands**: `(dom-style buf id css)`, `(dom-class buf id classname)`, `(dom-text buf id text)`, `(dom-attr buf id name value)`
    - **Root helpers**: `(dom-root-style buf css)`, `(dom-root-attr buf name value)` — target the container element via the sentinel id `"__root"`
    - Commands serialised as ASCII protocol strings into the buffer; no intermediate AST
    - To send: open `/dev/dom` with `open-file`, `write` `(DomBuf/len buf)` bytes from `(DomBuf/ptr buf)`, close the fd
  - **Protocol messages** (newline-terminated):
    - `<tag id="ID" attr="val".../>` — upsert self-closing element
    - `<tag id="ID" ...>TEXT</tag>` — upsert element with text content
    - `<!parent ID>` / `<!parent-root>` — control insertion context
    - `<!remove ID>` / `<!clear>` — remove element or all children
    - `<!style ID CSS>` / `<!class ID CLASSNAME>` — set style or className
    - `<!text ID TEXT>` — set textContent (efficient for live value updates)
    - `<!attr ID NAME VALUE>` — set arbitrary attribute
    - Special id `"__root"` in directives refers to the root container element
  - **`js/dom-processor.js`** — JavaScript DOM protocol processor:
    - `makeDomProcessor(root)` → `(line: string) => void`; stateful, tracks insertion parent
    - Creates plain HTML elements via `document.createElement` (no namespace needed)
    - Handles all protocol directives; `<!text>` sets `textContent` directly for efficiency
  - **`js/dom-bridge.js`** — JavaScript host-side module that exposes `/dev/dom` as a WASI preopened virtual device:
    - `mountDom(wasmImports, selector)` — injects the virtual device into the WASI imports object and mounts a container `<div class="woua-dom">` under the selected element; call before `WebAssembly.instantiate`
    - Intercepts `fd_write` calls on the `/dev/dom` fd; parses each newline-terminated write using `dom-processor.js`
    - Returns a bridge object with `setMemory(mem)` and `connectInstance(instance)` helpers
    - Plugs into the WASI imports object passed to `WebAssembly.instantiate`; no changes to the woua runtime
  - **`demos/dom_demo.woua`** — demo that builds a live 3×3 counter dashboard: nine HSL-coloured cells each incrementing at a different rate; initial layout sent once via element creation commands, then only `<!text>` directives are sent each frame (80 ms per tick) to update the displayed values by id
  - **`demos/dom_worker.js`** — Web Worker companion to `dom_demo.html`; uses `wasi-min.js` with `onPathOpen`/`onFdWrite` hooks to intercept `/dev/dom` writes and post `{ type: 'dom', line }` messages to the main thread
  - **`demos/dom_demo.html`** — HTML page that spawns the worker, creates the `makeDomProcessor` on the main thread, and wires worker messages to DOM updates

- [ ] #72 JSX-like HTML templating — a `lib/html.woua` macro library that transforms declarative, tree-shaped HTML-as-S-expressions into `dom-*` protocol calls, eliminating the manual `dom-parent` / `dom-flush-to` bookkeeping required by the low-level API
  - **Motivation**: the current `dom-*` API is assembly-level — each element, attribute, and parent switch is a separate call; a declarative tree notation mirrors the HTML structure directly and is easier to read, write, and refactor; it also makes it straightforward to see which elements are children of which, since that relationship is encoded in nesting rather than in `dom-parent` side-effects
  - **Proposed syntax** — element forms are `(tag "id" attr-form... child-or-expr...)`:
    ```woua
    (html buf dom-fd
      (div "app" (style "font-family:sans-serif;padding:1rem;")
        (h1  "title"    "woua DOM demo")
        (p   "subtitle" "Live counter board — running in WebAssembly")
        (div "grid" (style "display:grid;grid-template-columns:repeat(3,1fr);gap:10px;")
          (for i 0 9
            (span (id (string-concat "cell" (i32->str i)))
                  (style "display:block;text-align:center;border-radius:8px;")
                  (i32->str vals[i]))))
        (p "status" (string-concat "Frame: " (i32->str frame)))))
    ```
  - **Expansion model** — each `(TAG ID-OR-ATTR... CHILD...)` form inside `html` expands to:
    1. `(dom-TAG buf id TEXT)` or `(dom-TAG buf id)` — creates/upserts the element
    2. recognised attribute sub-forms emit their corresponding `dom-*` call on `id`
    3. `(dom-parent buf id)` — push insertion context before expanding child element forms
    4. child forms expand recursively
    5. `(dom-parent buf parent-id)` or `(dom-parent-root buf)` — pop insertion context
    6. non-form children (string literals, runtime expressions returning `:str`) become the element's text content via `dom-text`
    7. `(dom-flush-to buf fd)` is emitted once at the end of the top-level `html` call
  - **Attribute sub-forms** — recognised by the macro, stripped before processing children:
    - `(id expr)` — dynamic id (expression returning `:str`); required when id cannot be a string literal
    - `(style "css")` → `(dom-style buf id "css")`
    - `(class "cls")` → `(dom-class buf id "cls")`
    - `(attr "name" expr)` → `(dom-attr buf id "name" expr)`
  - **ID handling** — when the first child of a tag form is a string literal it is used as the element id (e.g. `(div "app" ...)`); when it is an `(id expr)` sub-form the id is a runtime expression evaluated once and bound to a local variable
  - **Implementation — runtime parent stack**: `lib/html.woua` provides a small runtime with `(__html-push-parent id)` / `(__html-pop-parent)` backed by a static stack of `:str` values; the `html` macro emits push/pop calls around each container element instead of inlining literal `dom-parent` strings; this enables dynamic ids, dynamic tag selection, element forms inside function calls, and — crucially — `defhtml` components that contain nested children and can be attached to any parent at the call site without the caller having to pass a parent-id parameter explicitly; costs a handful of bytes of static memory and two protocol writes per nesting level
  - **`defhtml` — reusable components**: define named, parameterised HTML fragments that inline at the call site:
    ```woua
    (defhtml counter-cell (buf i val)
      (span (id (string-concat "cell" (i32->str i)))
            (style "display:block;text-align:center;border-radius:8px;")
            (i32->str val)))

    ;; Usage inside an html form:
    (html buf dom-fd
      (div "grid" (style "display:grid;...")
        (for i 0 9
          (counter-cell buf i vals[i]))))
    ```
    `defhtml` expands to a `defmacro` that splices the body into the surrounding `html` expansion, so the parent context and buffer variable are inherited automatically; components are therefore inlinable templates, not runtime function calls
  - **SVG interop**: within an `html` form, an `(svg "id" w h SVGCHILD...)` form creates an `<svg>` container via `dom-svg`, then switches to a `SvgBuf` and emits child elements using `svg-*` macros (from `lib/svg.woua`) flushed to the same dom fd; the caller passes both `buf` and `sbuf` to `html`; a keyword like `:svg sbuf` distinguishes the SVG buffer from the dom buffer
  - **Update variant**: `(html-update buf dom-fd ...)` omits element-creation calls and emits only `dom-text` / `dom-attr` / `svg-rect` etc. for existing elements — used in the animation loop where the DOM structure is already built; the macro distinguishes creation vs update by checking whether text content or attribute sub-forms are present on a leaf node
  - **`lib/html.woua`** — the macro library; depends on `lib/dom.woua` (and optionally `lib/svg.woua` for SVG interop); no new WASI calls, no compiler changes required for v1

- [x] #68 SVG rendering — draw 2-D graphics from woua programs by writing incremental SVG commands to `/dev/svg`, a virtual device file provided by the host environment
  - **Protocol**: each `write` to `/dev/svg` carries one or more SVG element fragments; the JS bridge applies them incrementally to the DOM using upsert-by-id — if an element with the given `id` already exists its attributes are updated in place, otherwise a new child element is inserted into the `<svg>` container; this enables both static scenes and live animation without full redraws
  - **`SvgBuf` deftype** — `(ptr :ptr) (len :i32) (cap :i32)`; all commands take a `:*SvgBuf` and update `len` in place; the caller passes `(SvgBuf/ptr buf)` and `(SvgBuf/len buf)` to `write`; eliminates manual write-cursor tracking
  - **`lib/svg.woua`** — woua-side library that serialises drawing commands into a linear-memory byte buffer:
    - `(svg-begin buf cap)` — allocate a `SvgBuf` wrapping `buf`/`cap` and zero the write position
    - `(svg-line      buf id x1 y1 x2 y2 color stroke-w)` — append a `<line id="...">` element
    - `(svg-rect      buf id x y w h color stroke-color stroke-w)` — append a `<rect id="...">` element
    - `(svg-circle    buf id cx cy r color stroke-color stroke-w)` — append a `<circle id="...">` element
    - `(svg-text      buf id x y text color)` — append a `<text id="...">` element using a runtime `:str`
    - `(svg-path      buf id d color stroke-color stroke-w)` — append a `<path id="...">` element with a raw SVG path data string
    - `(svg-group     buf id transform)` — open a `<g id="..." transform="...">` container; `transform` is a raw SVG transform string (e.g. `"translate(10,20) rotate(45)"`) or empty `:str` for none
    - `(svg-group-end buf)` — close the current `</g>`
    - `(svg-parent    buf group-id)` — set the insertion parent for all subsequent element commands to the group with `group-id`; `(svg-parent buf "")` resets to the `<svg>` root; this allows adding elements to an existing group in a later batch without reopening a `svg-group`/`svg-group-end` block
    - `(svg-transform buf id transform)` — set the `transform` attribute on element `id`; sent alone to reposition/rotate an existing element without redrawing it
    - `(svg-style     buf id style)` — set the `style` attribute on element `id`; `style` is a raw CSS string (e.g. `"font-size:14px;font-weight:bold;opacity:0.8"`); works on any element type
    - `(svg-remove    buf id)` — emit a remove directive for element `id`; the JS bridge deletes the matching DOM element
    - `(svg-clear     buf)` — emit a clear directive; the JS bridge removes all children from the `<svg>` container
    - **Gradients**:
      - `(svg-linear-gradient buf id x1 y1 x2 y2)` — define a `<linearGradient>`; coordinates are in `userSpaceOnUse` units
      - `(svg-radial-gradient buf id cx cy r)` — define a `<radialGradient>`
      - `(svg-gradient-stop buf grad-id offset color opacity)` — add a `<stop>` to an existing gradient; `offset` is 0–100 (percent), `opacity` is 0–100
      - Gradients are defined once in `<defs>` and referenced by id in `color` or `stroke-color` fields as `"url(#grad-id)"`
    - **Clip paths**:
      - `(svg-clip-begin buf id)` — open a `<clipPath id="...">` in `<defs>`
      - `(svg-clip-end   buf)` — close the `</clipPath>`
      - `(svg-clip       buf id clip-id)` — set `clip-path="url(#clip-id)"` on element `id`
    - **Animation**:
      - `(svg-animate     buf elem-id attr from to dur-ms repeat)` — append an `<animate>` child to element `elem-id` that interpolates `attr` from `from` to `to` over `dur-ms` milliseconds; `repeat` is `"indefinite"` or a count as `:str`
      - `(svg-animate-transform buf elem-id type from to dur-ms repeat)` — append an `<animateTransform>` for `transform` attribute; `type` is `"translate"`, `"rotate"`, `"scale"`, etc.
      - `(svg-animate-stop buf elem-id)` — remove all `<animate>` children of element `elem-id` to stop its animation
    - **Additional shapes**:
      - `(svg-ellipse  buf id cx cy rx ry color stroke-color stroke-w)` — `<ellipse>` with independent x/y radii
      - `(svg-polygon  buf id points color stroke-color stroke-w)` — `<polygon>` closed shape; `points` is an SVG point-list string (e.g. `"0,0 50,100 100,0"`)
      - `(svg-polyline buf id points color stroke-color stroke-w)` — `<polyline>` open path; same `points` format
    - **Markers** (arrowheads, dots on line endpoints):
      - `(svg-marker-begin buf id width height)` — open a `<marker id="..." ...>` in `<defs>`; `width`/`height` set `markerWidth`/`markerHeight`
      - `(svg-marker-end   buf)` — close the `</marker>`; any shape commands between `svg-marker-begin` and `svg-marker-end` define the marker graphic
      - `(svg-marker-attach buf elem-id start-marker-id end-marker-id)` — set `marker-start` and/or `marker-end` on element `elem-id`; pass empty `:str` to omit either end
    - **viewBox**: `mountSvg(wasmImports, selector, width, height, viewBox)` — `viewBox` is an optional string (e.g. `"0 0 100 100"`) for resolution-independent scaling; pass `""` to default to `"0 0 width height"`
    - All coordinates are `:i32` (pixel units); colors are `#RRGGBB` format passed as `:str`; `id` is a `:str`
    - Commands are serialised as ASCII SVG element strings directly into the buffer (no intermediate AST)
    - To send: open `/dev/svg` with `open-file`, `write` `(SvgBuf/len buf)` bytes from `(SvgBuf/ptr buf)`, close the fd
  - **`js/svg-bridge.js`** — JavaScript host-side module that exposes `/dev/svg` as a WASI preopened virtual device:
    - `mountSvg(wasmImports, selector, width, height)` — injects the virtual device into the WASI imports object and sets the `<svg>` container dimensions; call before `WebAssembly.instantiate`
    - Intercepts `fd_write` calls on the `/dev/svg` fd; parses each received fragment as one or more directives
    - **Upsert**: element fragment with known `id` → `setAttribute` on existing DOM node; unknown id → `appendChild` new element
    - **Transform / style**: attribute-only directives → `setAttribute` on the target element
    - **Remove**: remove directive → `removeChild` on the matching element
    - **Clear**: clear directive → remove all children from the `<svg>` container
    - Plugs into the WASI imports object passed to `WebAssembly.instantiate`; no changes to the woua runtime
  - **`demos/svg_demo.woua`** — demo that draws an animated scene: initial shapes sent once, then a loop updates positions by resending only the changed elements (same ids, new coordinates)

- [x] #73 Build-time file embedding — `(defstatic name :bytes "path/to/data")` reads a file from the host file system at **compile time** and places its raw bytes into the WAT data section; a `{ptr: i32, len: i32}` header (same layout as `:str`) is emitted immediately before the bytes, giving zero-cost access to both the raw data and a WASI-compatible iovec for `fd_write`
  - **Syntax**: extends `defstatic` with a `:bytes` type — `(defstatic page :bytes "assets/index.html")` — consistent with `(defstatic msg :str "hello")`; path is resolved relative to the directory of the `.woua` source file being compiled; a missing file is a hard compile error with file + line reported
  - **Compiler changes** (`expander.ts` / `env.ts`): detect `:bytes` in `defstatic`; open and read the file; emit two entries into `env.statics`: (1) an 8-byte header `{ptr_imm: i32, len_imm: i32}` at `addr`, pointing to `addr + 8`; (2) the raw file bytes starting at `addr + 8`; record `{addr, len}` in `env.consts` so accessors fold to compile-time constants
  - **Memory adjustment**: after all statics are laid out, if `env.heapBase` exceeds `currentMemoryPages × 65536` (the value in the emitted `(memory N)` declaration), bump `N` to `ceil(env.heapBase / 65536)`; large embedded files will silently increase the module's initial memory footprint; the `-map` output should report embedded file entries with their path, address, and byte size
  - **Access helpers**: `(static-ptr name)` → raw byte pointer (`i32`), `(static-len name)` → byte count (`i32`), `(static-iov name)` → address of the 8-byte `{ptr, len}` header (`i32`); the header address is what gets passed to `fd_write` as the `iovs` parameter since its layout matches the WASI Preview 1 `ciovec` struct exactly
  - **Use cases**: embedding CSS/JS/HTML templates, WASM binary payloads, lookup tables from binary files, shader source strings, test fixtures — zero runtime overhead, no WASI file-system access at startup

- [x] #75 DOM event subscriptions — make `/dev/dom` full-duplex so WASM writes DOM commands and reads event records back on the same fd; no second fd required
  - **Motivation**: the current `/dev/dom` protocol is write-only (WASM → DOM); making it readable turns it into a Unix-style device where the host can push data back; the woua program keeps the one `dom-fd` it already has open and simply calls `fd_read` on it to receive events
  - **Registration** (new `/dev/dom` write command): `<!listen ID EVENT>` — attaches a JS listener; `<!unlisten ID EVENT>` removes it; e.g. `<!listen btn click>`, `<!listen inp input>`
  - **Delivery channel**: a SharedArrayBuffer ring buffer shared between the main thread (producer) and the worker (consumer); when a registered listener fires on the main thread, the event record is serialised into the ring and `Atomics.notify` wakes the worker; `fd_read` on `dom-fd` drains the ring into WASM linear memory
  - **Ring buffer layout** (in SharedArrayBuffer): `{ write-idx: i32, read-idx: i32, data: u8[N] }` — lock-free SPSC queue; event records are newline-terminated text lines (same encoding as the write side): `EVENT elem-id event-type client-x client-y key-code value\n`; capacity `N` default 4 KB
  - **Supported event types** — each record always carries all fields; unused fields are `0` / empty string:
    - **Mouse**: `click`, `dblclick`, `mousedown`, `mouseup`, `mousemove`, `mouseenter`, `mouseleave`, `contextmenu` — `client-x`, `client-y` populated; `key-code` = mouse button (0=left, 1=middle, 2=right)
    - **Pointer** (unifies mouse + touch + stylus): `pointerdown`, `pointermove`, `pointerup`, `pointercancel` — `client-x`, `client-y`, `key-code` = pointerId
    - **Keyboard**: `keydown`, `keyup` — `key-code` = `event.keyCode`; `value` = `event.key` (e.g. `"a"`, `"Enter"`, `"ArrowLeft"`)
    - **Input / form**: `input` — `value` = element's current `.value`; `change` — same; `focus`, `blur` — no extra data; `submit` — `value` = serialised form data (URL-encoded)
    - **Scroll**: `scroll` — `client-x` = `scrollLeft`, `client-y` = `scrollTop`
  - **`fd_read` implementation** (`wasi-min.js`): for the dom fd, block via `Atomics.wait` on the ring's `write-idx` until data is available, then copy bytes into the WASM buffer passed by the caller; non-blocking peek returns 0 bytes if ring is empty
  - **woua-side API** (`lib/dom.woua`):
    - `(dom-listen buf elem-id event-type)` / `(dom-unlisten buf elem-id event-type)` — emit directives into the write buffer, flushed as usual with `(dom-flush-to buf dom-fd)`
    - `(dom-event-read dom-fd scratch-ptr scratch-cap)` — calls `fd_read` on `dom-fd`; returns a `:str` of the raw event line, or an empty string if no event is pending
    - `DomEvent` deftype + `(dom-event-parse line ev)` — parses the text line into a structured record with fields `elem-id`, `event-type`, `client-x`, `client-y`, `key-code`, `value`
  - **Worker changes** (`dom_worker.js`): intercept `<!listen>` / `<!unlisten>` directives from `onFdWrite`; relay as `postMessage({ type: 'listen'|'unlisten', elemId, eventType })`; allocate the SharedArrayBuffer ring on startup and pass a reference to the main thread
  - **Main thread changes**: handle `listen`/`unlisten` messages; on event fire, encode the record and write into the ring with `Atomics.notify`
  - **Integration with animation loop**: `(dom-event-read ...)` can be polled non-blocking at the top of each frame; for event-only apps, the blocking form suspends until the next event arrives — replaces `(poll-sleep-ns ...)`
  - **Depends on**: `#71` (DOM rendering via `/dev/dom`)

- [ ] #76 Canvas pixel buffer — bind a `<canvas>` to a WASM linear-memory buffer using `OffscreenCanvas`; the worker renders pixels directly from WASM memory with zero cross-thread copy
  - **Motivation**: SVG handles retained-mode vector graphics; canvas handles raster — pixel shaders, image processing, procedural textures, game framebuffers; shapes/paths/text stay in SVG/DOM
  - **OffscreenCanvas approach**: the main thread creates the visible `<canvas>` element and transfers control to the worker via `canvas.transferControlToOffscreen()`; the worker holds the `OffscreenCanvasRenderingContext2D` and calls `ctx.putImageData(new ImageData(new Uint8ClampedArray(wasmMemory.buffer, ptr, w*h*4), w, h))` directly — WASM memory is read in-place, no copy, no postMessage for pixels
  - **Handshake**: main thread sends `{ type: 'canvas', id, offscreen }` (transferable) to the worker on `<!canvas>` directive; worker stores `Map<id, {ctx, ptr, w, h, auto}>` and calls `offscreen.getContext('2d')`
  - **Multiple canvases** — any number of canvases can be active simultaneously, each tracked by id in the worker's map
  - **Two modes**, selected at init time per canvas:
    - **Auto mode** — `(dom-canvas buf id w h ptr)` emits `<!canvas ID W H PTR>`; worker registers `{ctx, ptr, w, h, auto:true}` and starts a `setInterval` loop calling `ctx.putImageData` each ~16 ms; the app writes pixels freely, display stays in sync automatically
    - **Manual mode** — `(dom-canvas buf id w h 0)` (ptr=0) emits `<!canvas ID W H>`; worker registers `{ctx, auto:false}`; no automatic refresh; the app calls `(dom-canvas-put buf id ptr w h)` which emits `<!canvas-put ID PTR W H>`; the worker intercepts this in `onFdWrite` and calls `ctx.putImageData` immediately
  - **Auto mode pattern**:
    ```woua
    (defstatic pixels :bytes[(* W (* H 4))])
    (dom-canvas buf "screen" W H (static-ptr pixels))
    (dom-flush-to buf dom-fd)
    (while 1
      (render-frame (static-ptr pixels) W H frame)
      (set! frame (+ frame 1)))
    ```
  - **Manual mode pattern**:
    ```woua
    (let px :ptr (alloc (* W (* H 4)))
      (dom-canvas buf "screen" W H 0)
      (dom-flush-to buf dom-fd)
      (while 1
        (render-frame px W H frame)
        (dom-canvas-put buf "screen" px W H)
        (dom-flush-to buf dom-fd)
        (set! frame (+ frame 1))))
    ```
  - **`demos/canvas_demo.woua`** — demo rendering a Mandelbrot set or plasma effect in auto mode; pixels written directly into WASM static buffer, worker's interval loop blits to screen
  - **Depends on**: `#71` (DOM rendering via `/dev/dom`)

- [x] #74 DOM blob registration for embedded binary assets — extends the `/dev/dom` protocol with a `<!blob>` directive that tells the JavaScript bridge to read a range of WASM linear memory, create a `Blob`, and register its `ObjectURL` under a named id; works in tandem with `#73` (`:bytes` embeds) so that images, fonts, audio, and other binary assets baked into the WASM binary can be referenced by DOM elements without any server fetch or base64 encoding
  - **Protocol directive** (new `/dev/dom` command): `<!blob BLOB-ID PTR LEN MIME>` — JS reads `new Uint8Array(memory.buffer, PTR, LEN)`, creates `new Blob([slice], {type: MIME})`, calls `URL.createObjectURL(blob)`, stores the resulting URL in a registry keyed by `BLOB-ID`; the directive must be sent before any element that references the blob
  - **Blob id references** in element directives — when the bridge encounters a `src`, `href`, or other URL attribute containing `blob:BLOB-ID` (the literal prefix `blob:` followed by the registered id), it substitutes the stored `ObjectURL` before setting the DOM attribute; this keeps the woua-side protocol free of opaque `blob:http://...` strings
  - **woua-side helpers** (additions to `lib/dom.woua`):
    - `(dom-blob buf blob-id ptr len mime)` — serialises the `<!blob BLOB-ID PTR LEN MIME>` directive into the buffer; `ptr` and `len` are i32 runtime values; `mime` is a `:str`
    - `(dom-blob-static buf blob-id name mime)` — convenience form for a `:bytes` static: expands to `(dom-blob buf blob-id (static-ptr name) (static-len name) mime)` with compile-time constants for ptr and len; this is the primary usage pattern for `#73` embeds
    - `(dom-img buf elem-id blob-id)` — creates/upserts `<img id="elem-id" src="blob:blob-id">`, relying on the bridge to resolve the id to its ObjectURL
  - **JavaScript bridge changes** (`js/dom-processor.js`):
    - Handle `<!blob BLOB-ID PTR LEN MIME>`: access `memory.buffer` (set via `bridge.setMemory(mem)`), create the `Blob` and `ObjectURL`, store in a `Map<string, string>` local to the processor
    - On element upsert, before calling `setAttribute`, scan attribute values for the `blob:` prefix and substitute the stored URL; if the id is not yet registered (blob directive not yet sent), emit a console warning and leave the attribute as-is
    - `URL.revokeObjectURL` is not called automatically — the app is responsible for cleanup if needed
  - **Typical usage pattern** (PNG logo embedded at build time):
    ```woua
    (defstatic logo :bytes "assets/logo.png")   ;; #73 embed

    ;; Once at startup — register the blob, then reference it in an img
    (dom-blob-static buf "logo-blob" logo "image/png")
    (dom-flush-to buf dom-fd)
    (dom-img buf "my-logo" "logo-blob")
    (dom-flush-to buf dom-fd)
    ```
  - **Depends on**: `#73` (`:bytes` file embedding) and `#71` (DOM rendering via `/dev/dom`)

