# woua

**woua** is a low-level, Lisp-syntax language that compiles directly to [WebAssembly Text Format (WAT)](https://webassembly.github.io/spec/core/text/index.html) and targets [WASI Preview 1](https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md). It is designed to be as close to WAT as possible while remaining self-describing: operators, literal patterns, external imports, and struct types are all declared in `.woua` library files, not hardcoded in the compiler.

## Building the compiler

The compiler is written in [AssemblyScript](https://www.assemblyscript.org/) and compiles to a self-hosting WASI binary.

```sh
cd wouac
npm install
npm run build
# Output: wouac/dist/wouac.wasm
```

## Running

```sh
# Compile a woua source file to WAT (stdout)
wasmtime --dir . wouac/dist/wouac.wasm demos/hello_world.woua

# Compile to a WAT file directly
wasmtime --dir . wouac/dist/wouac.wasm demos/hello_world.woua -o demos/out/hello_world.wat

# Compile directly to WASM (-o *.wasm triggers binary output automatically)
wasmtime --dir . wouac/dist/wouac.wasm demos/hello_world.woua -o demos/out/hello_world.wasm
wasmtime demos/out/hello_world.wasm

# Compile to both WAT and WASM side-by-side
wasmtime --dir . wouac/dist/wouac.wasm demos/hello_world.woua -o demos/out/hello_world.wat -wasm
```

### CLI options

```
Usage: wouac [options] [source.woua]

  Compile a woua source file to WebAssembly Text Format (WAT).
  If no file is given, source is read from stdin.

Options:
  source.woua         Input source file
  -o, --output <file> Output file; use .wasm extension to emit binary directly
  -wasm               Also write a .wasm binary alongside the .wat (requires -o)
  -map                Also write a <output>.map memory layout file
  --lib <dir>         Library directory (default: lib/)
  --help, -h          Show this help message
  --version, -v       Show compiler version
```

## Running the tests

```sh
./run_tests.sh          # run all 89 tests
./run_tests.sh 07       # run only test 07
./run_tests.sh -v       # verbose (prints each command)
./run_tests.sh -v 07    # verbose + filter
```

Each test is a self-describing `.woua` file with `@test`, `@feature`, and `@expect` / `@expect-exit` header comments that the runner checks against the program's actual output and exit code.

## Building the demos

```sh
./build_demos.sh        # compiles all demos/*.woua → demos/out/*.wasm
```

Demos:

| Demo | Description |
|---|---|
| `hello_world` | Print "Hello, World!" |
| `echo` | Echo command-line arguments |
| `cat` | Open and print a file (uses preopened dirs) |
| `bench` | Measure a counting loop with `time-now-ms` |
| `simd_demo` | f32x4 SIMD vector arithmetic |
| `tty_raw` | Raw-mode terminal input via WASIX `tty_get` / `tty_set` |
| `svg_demo` | Draw / animate an SVG scene through `/dev/svg` (run with `svg_demo.html`) |
| `svg_dump` | Emit a static SVG document to stdout |
| `wave_demo` | Animated waveform rendered to SVG (`wave_demo.html`) |
| `fft` | FFT visualisation rendered to SVG (`fft.html`) |

## Benchmarks

`bench/` contains compute kernels with both a woua (`.woua`) and an equivalent native Rust (`bench_*.rs`) implementation. `./run_bench.sh` runs both under `wasmtime` and `rustc -O`, printing side-by-side wall-clock times and a ratio: `fib`, `sum`, `sieve`, `matmul`, `fft`, `simd_dot`.

## Hello, World

```woua
(include io)

(defn main () :void
  (printf "Hello, World!\n"))
```

The include chain: `io` → `wasi_p1` → `core`.

- `core` registers literal patterns and operators. String literals produce `:str` fat-pointers `(ptr, len)` automatically — no heap allocation or wrapper needed.
- `wasi_p1` imports all WASI Preview 1 functions.
- `io` defines the `Iovec` struct, `write`, `printf`, `read-line`, `args-count`, `args-get`, and the filesystem helpers.

## Project structure

```
woua/
  lib/              Standard library (woua source)
    core.woua         Operators, literals, :str fat-pointer type (includes memory)
    memory.woua       Bump allocator, memory.grow, arena stack, alloc-reset
    wasi_p1.woua      WASI Preview 1 defimports
    wasix.woua        WASIX extensions: TTY control, sockets
    io.woua           I/O: write, printf, sprintf, read-line, args, file ops
    string.woua       str comparison, copy, slice, concat, search, number↔str
    math.woua         sqrt/floor/ceil/round + sin/cos/exp/log/pow (f32/f64)
    simd.woua         128-bit SIMD (v128) typed operators and literals
    array.woua        Dynamic Array + typed slice (:T[]) helpers
    time.woua         Monotonic + wall-clock time via WASI
    svg.woua          Incremental SVG drawing to the /dev/svg virtual device
  demos/
    hello_world.woua  Print "Hello, World!"
    echo.woua         Echo command-line arguments
    cat.woua          Open and print a file (uses preopened dirs)
    bench.woua        Measure a counting loop with time-now-ms
    simd_demo.woua    f32x4 SIMD arithmetic
    tty_raw.woua      Raw-mode terminal input (WASIX)
    svg_demo.woua …   SVG rendering demos (.html harnesses included)
  bench/            Benchmark suite (woua + native Rust equivalents)
  js/               JS host bridges (WASI shim, SVG device)
  tests/
    01_defimport.woua … 89_sprintf.woua
    out/              Compiled .wat and .wasm for each test
  wouac/            Compiler (AssemblyScript → WASM)
    assembly/
      index.ts        Entry point, include resolution, CLI
      reader.ts       Tokeniser / parser
      expander.ts     Macro expansion, compile-time evaluation
      codegen.ts      WAT code generation
      env.ts          Compiler environment (symbol tables)
      ast.ts          AST node types
      macros.ts       Built-in compile-time helpers
      primitives.ts   WAT instruction emitters
      wasm_encoder.ts WAT → WASM binary encoder (used by -wasm flag)
  run_tests.sh      Test runner
  build_demos.sh    Demo build script
```

## Compiler pipeline

```
source.woua
    │
    ▼ readAndResolve          (index.ts)
    │  • reads one form at a time
    │  • (include name) → recursively reads from baseDir or lib/
    │  • (defliteral …) → registers the literal pattern immediately
    │  • string literals with :static flag are interned into linear memory
    │
    ▼ expandAll               (expander.ts)
    │  • (defstatic …)  → allocates static data, emits (data …) directive
    │  • (deftype …)    → registers struct layout in env.types
    │  • (defmacro …)   → registers macro template in env.macros
    │  • (defimport …)  → registers WASM import in env.imports
    │  • (defop …)      → registers operator overload in env.ops
    │  • (defliteral …) → registers literal pattern in env.literals
    │  • user macros    → recursively expanded in-place
    │  • (static-ptr s) / (static-len s) → resolved to compile-time constants
    │  • (defn …)       → forwarded to codegen unchanged
    │
    ▼ generateModule          (codegen.ts)
    │  • emits (import …) for each env.imports entry
    │  • emits linear memory, static data segments, bump allocator ($alloc)
    │  • two-pass prescan: collect explicit return types and tuple annotations
    │  • compiles (defn …) bodies with full type inference
    │  • hoists all (local …) declarations to function top (WAT requirement)
    │  • dead-code elimination: reachability walk from main
    │  • exports _start → main
    │
    ▼ WAT output
    │
    ▼ watToWasm (wasm_encoder.ts)  [only with -wasm flag]
    │  • parses WAT s-expressions
    │  • builds type / function / global index tables
    │  • encodes all sections to WASM binary format
    │
    ▼ .wasm binary output
```

## Language reference

### Comments
```woua
;; This is a line comment
```
Comments inside a `defn` body are forwarded as `(; … ;)` inline WAT comments.

### Including files
```woua
(include io)              ;; searches lib/ then current directory
(include ../mylib/foo)    ;; relative path, .woua added automatically
```
Includes are processed eagerly and deduplicated.

### Functions
```woua
;; Inferred return type
(defn add (a :i32 b :i32)
  (+ a b))

;; Explicit return type annotation
(defn scale (x :i64 factor :i64) :i64
  (* x factor))

;; Void function (no result)
(defn greet (name :str) :void
  (printf "Hello %s\n" name))

(defn main () :void
  (let s :str "world"
    (greet s)))
```
- Parameter types default to `:i32` when omitted.
- Return type can be declared explicitly after the parameter list with `:ReturnType`.
- `:void` means the function produces no WAT result.
- A declared type that mismatches the inferred type is a compile error.
- `main` is exported as `_start`. If `main` returns an `:i32` it becomes the WASI exit code; otherwise `_start` calls `proc_exit 0` after `main` returns. Dead functions are eliminated.
- Defining two functions or two types with the same name is a compile error.
- Self-tail-calls and mutual tail-calls are emitted as WAT `return_call` / `return_call_indirect` (tail-call optimisation), so deep recursion does not overflow the stack.

### Expressions

| Form | Description |
|---|---|
| `42` `-7` | i32 literal |
| `100i64` `-1i64` | i64 literal |
| `3.14` `-1.5` | f32 literal |
| `2.718f64` | f64 literal |
| `1.5e-3` `2.7e10f64` | float literal, scientific notation |
| `0xFF` `0xDEADi64` | hex i32 / i64 literal |
| `'A'` `'\n'` | character literal — i32 code point |
| `1:2:3:4i32x4` | SIMD vector literal (see SIMD section) |
| `"text"` | string literal — produces a `:str` fat-pointer `(ptr, len)` automatically; no wrapper needed |
| `(op a b)` | operator call — overload selected by argument types |
| `(if cond then)` | conditional, void (no else) |
| `(if cond then else)` | conditional expression — both branches must match |
| `(cond (test expr)... (else expr))` | multi-branch conditional; subject-less; `else` is the fallback |
| `(match subj (pat expr)... (_ expr))` | scalar pattern match (i32/i64/f32/f64 literal patterns, `_` default); subject evaluated once |
| `(progn e1 e2 ... en)` | sequence — evaluate in order, return last |
| `(let name val body...)` | local binding, type inferred from value |
| `(let name :Type val body...)` | local binding with explicit type |
| `(let* ((a v1) (b v2)...) body...)` | sequential bindings — each binding is in scope for the next |
| `(set! name val)` | assign to an existing local |
| `(while cond body...)` | loop |
| `(for i start end body...)` | counted loop — expands to `let` + `while`; `i` increments each iteration |
| `(drop expr)` | discard a value |
| `(as :Type expr)` | numeric type cast |
| `(i32.store ptr val)` | raw 4-byte memory write |
| `(i32.store8 ptr val)` | raw 1-byte memory write |
| `(i32.load ptr)` | 4-byte memory read → i32 |
| `(i32.load8_u ptr)` | unsigned 1-byte read → i32 |
| `(i64.load ptr)` | 8-byte memory read → i64 |
| `(i64.store ptr val)` | raw 8-byte memory write |
| `(Type/field ptr)` | struct field getter |
| `(Type/field! ptr val)` | struct field setter |
| `(sizeof Type)` | compile-time struct size in bytes |
| `(static-ptr sym)` | compile-time pointer to a static/inline string |
| `(static-len sym)` | compile-time byte length |
| `(alloc size)` | runtime bump allocator — returns aligned pointer |
| `(sprintf buf "fmt" args...)` | format into a buffer; returns bytes written |

### Tuples (multi-value return)

```woua
;; Declare a tuple-returning function with a list of result types:
(defn minmax (a :i32 b :i32) (:i32 :i32)
  (if (< a b) (values a b) (values b a)))

;; Destructuring bind:
(let (lo hi) (minmax 7 3)
  (printf "%d %d\n" lo hi))

;; Named tuple local:
(let pair (:i32 :i32) (minmax 7 3)
  (printf "%d %d\n" (pair/0) (pair/1)))
```

### First-class functions

```woua
;; Function type syntax: (:arg -> :result)
(defn apply (f (:i32 -> :i32) x :i32) :i32
  (f x))

(defn double (x :i32) :i32 (* x 2))

(defn main () :void
  (printf "%d\n" (apply (fn-ref double) 5)))  ;; 10
```
- `(fn-ref name)` returns a WAT table index for the named function.
- Function-typed locals: `(let fn (:i32 -> :i32) (fn-ref double) ...)`
- Multi-param and tuple-returning function types are supported.

### Type casts (`as`)

| From | To | WAT instruction |
|---|---|---|
| `:i32` | `:i64` | `i64.extend_i32_s` |
| `:i64` | `:i32` | `i32.wrap_i64` |
| `:f32` | `:f64` | `f64.promote_f32` |
| `:f64` | `:f32` | `f32.demote_f64` |
| `:i32` | `:f32` | `f32.convert_i32_s` |
| `:i32` | `:f64` | `f64.convert_i32_s` |
| `:ptr` ↔ `:i32` | either | no-op |

### Types

| Keyword | WAT type | Notes |
|---|---|---|
| `:i32` | `i32` | 32-bit integer, default parameter type |
| `:i64` | `i64` | 64-bit integer |
| `:f32` | `f32` | 32-bit float |
| `:f64` | `f64` | 64-bit float |
| `:ptr` | `i32` | pointer (alias for `:i32`) |
| `:str` | `i32 i32` | fat pointer `(ptr, len)` — two WAT values |
| `:u8` | `i32` | 1-byte unsigned struct field (load8_u / store8) |
| `:void` | — | no result (function return annotation only) |
| `:Type` | (fields) | value-type struct — fields become WAT locals, no allocation |
| `:*Type` | `i32` | reference-type struct — a heap pointer (compiler allocates) |
| `:v128` | `v128` | untyped 128-bit SIMD vector |
| `:i8x16` `:i16x8` `:i32x4` `:i64x2` | `v128` | integer SIMD lanes (carry lane info for operator dispatch) |
| `:f32x4` `:f64x2` | `v128` | float SIMD lanes |
| `:bytes` | — | raw byte buffer in a `defstatic` (e.g. `:bytes 256`) |

### Declaring external functions
```woua
(defimport fd_write "wasi_snapshot_preview1" "fd_write" (:i32 :i32 :i32 :i32) :i32)
(defimport proc_exit "wasi_snapshot_preview1" "proc_exit" (:i32))
```

### Declaring operators
```woua
(defop + "i32.add"  (:i32 :i32) :i32)
(defop + "i64.add"  (:i64 :i64) :i64)
(defop < "i32.lt_s" (:i32 :i32) :i32)
```
Multiple signatures for the same operator name are resolved by argument types.

### Declaring literal patterns
```woua
(defliteral string /"((?:[^"\\]|\\.)*)"/ :string :static)
(defliteral int64  /-?[0-9]+i64/          :i64)
(defliteral int    /-?[0-9]+/             :i32)
(defliteral float  /-?[0-9]*\.[0-9]+/    :f32)
```
Longer patterns must be declared before shorter ones that match the same prefix.  
str literals support `\n \t \r \\ \" \0 \xNN` escape sequences.

### Declaring struct types
```woua
(deftype Point (x :i32) (y :i32))
```
`deftype` only declares the field layout. The storage strategy is chosen at the
use site by the type annotation:

```woua
;; Value type — fields live in WAT locals, no heap allocation:
(let p :Point (Point 10 20)
  (printf "%d\n" (Point/x p)))

;; Reference type — the compiler allocates on the heap; p is an i32 pointer:
(let q :*Point (Point 10 20)
  (Point/x! q 30)
  (printf "%d\n" (Point/x q)))
```
- `(Point 10 20)` is the constructor; the same form works for both storage kinds.
- Field accessors `(Point/x p)` (get) and `(Point/x! p v)` (set) are identical in both cases.
- `(sizeof Point)` is a compile-time constant.
- A value-type struct returned from a function emits a multi-value `(result …)` automatically.

#### Field types
- Any primitive (`:i32 :i64 :f32 :f64 :ptr`) or `:u8` (1-byte unsigned).
- Another `deftype` name → **nested struct**; offsets are computed by flattening, and value-type bindings expand inner fields into their own locals.

```woua
(deftype Rect (origin :Point) (w :i32) (h :i32))
```

### Protocols and method dispatch

Operator overloads can dispatch to a `defn` instead of a raw WAT opcode — this
gives compile-time (zero-overhead) generic functions and static method dispatch:

```woua
(defn point-add (a :*Point b :*Point) :*Point
  (Point (+ (Point/x a) (Point/x b)) (+ (Point/y a) (Point/y b))))
(defop + "point-add" (:*Point :*Point) :*Point)   ;; now (+ p q) dispatches here
```

`defprotocol` declares a named set of required methods; `defimpl` provides them
for a concrete type and the compiler verifies every method is present with the
correct signature:

```woua
(defprotocol Shape
  (area (self :*Self) :i32))

(defimpl Shape Circle
  (defn area (self :*Circle) :i32
    (* 3 (* (Circle/r self) (Circle/r self)))))
```
A missing or wrongly-typed method in a `defimpl` is a compile error.

### SIMD (128-bit vectors)

`(include simd)` exposes WebAssembly SIMD as first-class typed operations. Six
typed lane interpretations of `v128` carry lane information so plain operators
dispatch correctly:

```woua
(include simd)

(defn main () :void
  (let a :f32x4 1.0:2.0:3.0:4.0f32x4      ;; vector literal
    (let b :f32x4 5i32x4                  ;; splat: broadcast a single value
      (let c :f32x4 (+ a b)              ;; (+) dispatches to f32x4.add
        (printf "%f\n" (f32x4.extract_lane 0 c))))))
```
- Vector literals: `1:2:3:4i32x4`, `1.0:2.0:3.0:4.0f32x4`, `0:1:…:15i8x16`; a single value with no colons (`5i32x4`) splats to all lanes.
- Type-dispatched operators per subtype: `+ - * /`, `neg abs sqrt min max`, comparisons, `shl shr_s shr_u`.
- Typed load/store: `(f32x4-load ptr)`, `(i32x4-store ptr v)`, etc.
- Lane access: `(extract_lane n v)` / `(replace_lane n v val)` (type-dispatched), or named forms like `(f32x4.extract_lane 0 v)`.
- Low-level escape hatch: `(v128.const b0 … b15)` for a raw 16-byte i8x16 constant.
- The target runtime must have the SIMD proposal enabled (`wasmtime --wasm simd`).

### Compile-time constants and globals
```woua
(defconst MAX_LEN 256)               ;; named compile-time integer constant
(defconst BYTES (* MAX_LEN 8))       ;; folded at compile time → 2048

(defvar counter :i32)                ;; mutable WAT global with get/set sugar
(defn bump () :void (set! counter (+ counter 1)))
```
`defconst` bodies are constant-folded (`+ - * / % << >> and or xor`) over literals
and previously-defined constants; a non-constant operand is a compile error.

### Memory and arenas

`alloc` is a bump allocator that grows linear memory automatically. Memory is
reclaimed in bulk via the arena stack or a full reset (from `lib/memory.woua`,
included by `core`):

| Form | Description |
|---|---|
| `(alloc n)` | allocate `n` bytes, 8-byte aligned; grows memory as needed |
| `(memory-size)` | current size in 64 KiB pages |
| `(memory-grow n)` | grow by `n` pages; returns old size or -1 |
| `(arena-push)` / `(arena-pop)` | save / restore the heap pointer (scoped frees) |
| `(alloc-reset)` | free everything (reset to the post-static baseline) |

### Arrays and slices

`(include array)` provides a heap-allocated dynamic `Array` `{ptr, len, cap}` plus
bounds-checked typed-slice helpers:

```woua
(include array)

(defn main () :void
  (let a :*Array (array-new :i32 8)
    (array-push :i32 a 10)
    (array-push :i32 a 20)
    (printf "%d %d\n" (array-get :i32 a 0) (array-len a))))
```
- `array-new`, `array-push` / `array-push!`, `array-pop` / `array-pop!`, `array-get`, `array-set`, `array-len`, `array-cap`, `array-full?`.
- `array-slot` / `array-ptr` return a `:*T` pointing inside the buffer for inline structs.
- Typed slices `:T[]` (fat pointer in locals) and `:T[N]` (allocation shorthand): `(aref buf i)`, `(aset! buf i v)`, `(alen buf)`, and bounds-checked `(aref! buf i)` / `(aset!! buf i v)`.


### Declaring macros
```woua
(defmacro square (x) (* x x))
```
Macros expand recursively at compile time. `(static-ptr sym)` and `(static-len sym)` resolve inline string literals to compile-time constants.

### Static data
```woua
(defstatic greeting "Hello!")
(defstatic counter :i32 0)
(defstatic buf :bytes 256)
```
Inline string literals are auto-interned and deduplicated — no `defstatic` needed.

## Standard library

### `lib/core.woua`
Literal patterns (int, i64, hex, f32/f64 incl. scientific notation, char, string)
and arithmetic / comparison / bitwise operators for i32/i64/f32/f64. Provides the
`for` loop macro and (transitively) the allocator from `lib/memory.woua`.

Operators include: `+ - * /`, `div divu % %u`, signed/unsigned comparisons
(`< > <= >=` and `<u >u <=u >=u`), equality `= !=`, bitwise
(`band bor bxor bnot` / `& | ^ ~`, `not !`), and shifts (`shl shr shru` / `<< >> >>u`).

### `lib/memory.woua`
Bump allocator and memory control (included by `core`):
`alloc`, `memory-size`, `memory-grow`, `heap-ptr`, arena stack
(`arena-push` / `arena-pop`), and `alloc-reset`.

### `lib/string.woua`
Str utilities (includes `core`):

| Function / Macro | Signature | Description |
|---|---|---|
| `string-len` | `(s :str) → :i32` | Byte length |
| `string-ptr` | `(s :str) → :ptr` | Raw data pointer |
| `string=` | `(a :str b :str) → :i32` | Content equality |
| `string-eq` | `(s :str "literal") → :i32` | Compare with a compile-time literal |
| `string-copy` | `(s :str) → :str` | Deep copy |
| `string-slice` | `(s :str offset len) → :str` | Slice (no copy) |
| `string-concat` | `(a :str b :str) → :str` | Concatenate |
| `string-index-of-byte` | `(s :str b :i32) → :i32` | First index of byte, or -1 |
| `i32->str` | `(n :i32) → :str` | Convert i32 to decimal string |
| `i64->str` | `(n :i64) → :str` | Convert i64 to decimal string |
| `f32->str` | `(f :f32) → :str` | Convert f32 to decimal string (6 places) |
| `f64->str` | `(f :f64) → :str` | Convert f64 to decimal string (6 places) |

The `str` struct (`{ptr, len}`) layout is also declared here, so field accessors
`(str/ptr s)` / `(str/len s)` work on both `:str` locals and `:*str` memory pointers.

### `lib/math.woua`
Math functions (includes `core`):

| Operator | Types | Backed by |
|---|---|---|
| `sqrt abs floor ceil round neg min max` | `:f32` `:f64` | WASM float intrinsics |
| `sin cos exp log pow` | `:f32` `:f64` | software (polynomial) implementations |

Operators dispatch by argument type, so `(sqrt 2.0)`, `(sin x)`, `(pow b e)` work
for both `:f32` and `:f64`.

### `lib/simd.woua`
128-bit SIMD operators and vector literals — see the [SIMD section](#simd-128-bit-vectors).

### `lib/array.woua`
Dynamic `Array` `{ptr, len, cap}` and typed-slice (`:T[]`) helpers — see
[Arrays and slices](#arrays-and-slices).

### `lib/wasi_p1.woua`
`defimport` declarations for the WASI Preview 1 surface (includes `core`):

- **Process**: `proc_exit`
- **Args / env**: `args_sizes_get`, `args_get`, `environ_sizes_get`, `environ_get`
- **File descriptors**: `fd_read`, `fd_write`, `fd_close`, `fd_seek`, `fd_tell`,
  `fd_sync`, `fd_datasync`, `fd_prestat_get`, `fd_prestat_dir_name`, `fd_advise`,
  `fd_allocate`, `fd_fdstat_get`, `fd_fdstat_set_flags`, `fd_filestat_get`,
  `fd_filestat_set_size`, `fd_filestat_set_times`, `fd_pread`, `fd_pwrite`, `fd_readdir`
- **Paths**: `path_open`, `path_create_directory`, `path_unlink_file`,
  `path_rename`, `path_filestat_get`, `path_filestat_set_times`, `path_link`,
  `path_readlink`, `path_remove_directory`, `path_symlink`
- **Sockets**: `sock_accept`, `sock_recv`, `sock_send`, `sock_shutdown`
- **Poll**: `poll_oneoff`
- **Clock / random**: `clock_time_get`, `clock_res_get`, `random_get`

### `lib/wasix.woua`
WASIX (`wasix_32v1`) extensions (includes `wasi_p1`):

| Function / Macro | Signature | Description |
|---|---|---|
| `tty-get` | `(buf :*Tty) → :i32` | Read terminal state into a `Tty` struct |
| `tty-set` | `(buf :*Tty) → :i32` | Apply `Tty` settings (echo, raw mode, …) |
| `sock-open-tcp` / `sock-open-udp` | `() → :i32` | Create a socket; returns fd or -errno |
| `sock-bind-ipv4` | `(fd port b0 b1 b2 b3) → :i32` | Bind to an IPv4 address:port |
| `sock-listen-fd` | `(fd backlog) → :i32` | Listen for connections |
| `sock-connect-ipv4` | `(fd port b0 b1 b2 b3) → :i32` | Connect to a remote IPv4 address:port |

### `lib/io.woua`
I/O helpers (includes `wasi_p1` and `string`):

| Function / Macro | Signature | Description |
|---|---|---|
| `write` | `(fd ptr len)` | Write raw bytes to a fd |
| `write-string` | `(fd s :str)` | Write a runtime `:str` to a fd |
| `print` / `print-string` | `(sym)` / `(s :str)` | Write to stdout |
| `print-int` / `print-int64` | `(n)` | Print an integer to stdout |
| `print-float` / `print-float64` | `(f)` | Print a float to stdout |
| `print-char` | `(c :i32)` | Print one byte as a character |
| `printf` | `(fmt args...)` | Formatted print to stdout |
| `sprintf` | `(buf fmt args...) → :i32` | Format into a buffer; returns bytes written |
| `assert` | `(cond "msg")` | Print message to stderr and exit 1 if false |
| `read-line` | `(fd buf maxlen) → :str` | Read one line; returns a `:str` into buf |
| `args-count` | `() → :i32` | Number of CLI arguments |
| `args-get` | `(i :i32) → :str` | i-th CLI argument as a `:str` |
| `open-file` | `(path :str readonly :i32) → :i32` | Resolve preopen + open file in one call |
| `create-file` | `(path :str) → :i32` | Create/truncate a file (preopen-resolved) |
| `close-file` | `(fd :i32)` | Close a file descriptor |
| `file-size` | `(fd :i32) → :i64` | Byte size of an open file |
| `pread` / `pwrite` | `(fd buf len offset :i64) → :i32` | Positional read / write |
| `find-preopen` | `(name :str buf buf-len) → :i32` | Scan WASI preopens; fd or -1 |
| `resolve-path` | `(path scratch len) → :*ResolvedPath` | Split a path into preopen fd + relative sub-path |

`printf` / `sprintf` format specifiers (expanded at compile time): `%d` `%i` (i32),
`%ld` `%li` (i64), `%f` (f32), `%lf` (f64), `%s` (`:str`), `%c` (byte), `%%` (literal `%`).

### `lib/time.woua`
Time helpers built on `clock_time_get` (includes `wasi_p1`):

| Function | Signature | Description |
|---|---|---|
| `time-now-ns` | `() → :i64` | Monotonic time in nanoseconds |
| `time-realtime-ns` | `() → :i64` | Wall-clock nanoseconds since Unix epoch |
| `time-now-ms` | `() → :i64` | Monotonic time in milliseconds |
| `time-elapsed-ms` | `(start :i64) → :i64` | Milliseconds since `start` |

### `lib/svg.woua`
Incremental 2-D SVG drawing to the `/dev/svg` virtual device provided by the JS
bridge (`js/svg-bridge.js`). Commands serialise SVG fragments into an `SvgBuf`
byte buffer; the bridge upserts them into the DOM by `id` for live animation
without full redraws.

- **Buffer**: `svg-buf-new`, `svg-buf-reset`, `svg-flush-to`.
- **Shapes**: `svg-line`, `svg-rect`, `svg-circle`, `svg-ellipse`, `svg-text`,
  `svg-path`, `svg-polygon`, `svg-polyline` (plus `-f` float-coordinate variants).
- **Grouping / structure**: `svg-group`, `svg-group-end`, `svg-parent`,
  `svg-clip-begin`, `svg-clip-end`, `svg-clip`.
- **Attributes**: `svg-attr`, `svg-style`, `svg-transform`, `svg-root-attr`, `svg-root-style`.
- **Gradients**: `svg-linear-gradient`, `svg-radial-gradient`, `svg-gradient-stop`.
- **Animation**: `svg-animate`, `svg-animate-transform`.
- **Markers**: `svg-marker`, `svg-marker-attach`.
- **Lifecycle**: `svg-remove`, `svg-clear`.

The browser side mounts the device with `mountSvg(wasmImports, selector, width, height)`.


