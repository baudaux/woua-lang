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

# Compile and assemble to WASM
wasmtime --dir . wouac/dist/wouac.wasm demos/hello_world.woua -o demos/out/hello_world.wat
wat2wasm demos/out/hello_world.wat -o demos/out/hello_world.wasm
wasmtime demos/out/hello_world.wasm
```

### CLI options

```
Usage: wouac [options] [source.woua]

  Compile a woua source file to WebAssembly Text Format (WAT).
  If no file is given, source is read from stdin.

Options:
  source.woua         Input source file
  -o, --output <file> Output file (default: stdout)
  -map                Also write a <output>.map memory layout file
  --lib <dir>         Library directory (default: lib/)
  --help, -h          Show this help message
  --version, -v       Show compiler version
```

## Running the tests

```sh
./run_tests.sh          # run all 36 tests
./run_tests.sh 07       # run only test 07
./run_tests.sh -v       # verbose (prints each command)
./run_tests.sh -v 07    # verbose + filter
```

## Building the demos

```sh
./build_demos.sh        # compiles all demos/*.woua → demos/out/*.wasm
```

Demos: `hello_world`, `echo`, `cat`, `bench`.

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
    core.woua         Operators, literals, :str fat-pointer type
    wasi_p1.woua      WASI Preview 1 defimports
    io.woua           I/O: write, printf, read-line, args, file open helpers
    string.woua       str comparison, copy, slice, concat, search, int-to-str
    time.woua         Monotonic + wall-clock time via WASI
  demos/
    hello_world.woua  Print "Hello, World!"
    echo.woua         Echo command-line arguments
    cat.woua          Open and print a file (uses preopened dirs)
    bench.woua        Measure a counting loop with time-now-ms
  tests/
    01_defimport.woua … 36_return_type_mismatch.woua
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
- `main` is exported as `_start`. Dead functions are eliminated.

### Expressions

| Form | Description |
|---|---|
| `42` `-7` | i32 literal |
| `100i64` `-1i64` | i64 literal |
| `3.14` `-1.5` | f32 literal |
| `2.718f64` | f64 literal |
| `0xFF` `0xDEADi64` | hex i32 / i64 literal |
| `"text"` | string literal — produces a `:str` fat-pointer `(ptr, len)` automatically; no wrapper needed |
| `(op a b)` | operator call — overload selected by argument types |
| `(if cond then)` | conditional, void (no else) |
| `(if cond then else)` | conditional expression — both branches must match |
| `(progn e1 e2 ... en)` | sequence — evaluate in order, return last |
| `(let name val body...)` | local binding, type inferred from value |
| `(let name :Type val body...)` | local binding with explicit type |
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
| `:void` | — | no result (function return annotation only) |
| `:TypeName` | `i32` | struct instance (heap pointer) |

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

(let p :Point (alloc (sizeof Point))
  (Point/x! p 10)
  (Point/y! p 20)
  (printf "%d\n" (Point/x p)))
```

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
Literal patterns and arithmetic/comparison/bitwise operators for i32/i64/f32/f64.

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

### `lib/wasi_p1.woua`
`defimport` declarations for the WASI Preview 1 functions currently supported:
`proc_exit`, `args_sizes_get`, `args_get`, `environ_sizes_get`, `environ_get`,
`fd_read`, `fd_write`, `fd_close`, `fd_seek`, `fd_tell`, `fd_sync`,
`fd_prestat_get`, `fd_prestat_dir_name`,
`path_open`, `path_create_directory`, `path_unlink_file`, `path_rename`,
`clock_time_get`, `clock_res_get`, `random_get`.

### `lib/io.woua`
I/O helpers (includes `wasi_p1`):

| Function / Macro | Signature | Description |
|---|---|---|
| `write` | `(fd ptr len)` | Write raw bytes to a fd |
| `printf` | `(fmt args...)` | Formatted print to stdout (`%d %s %f %x`) |
| `assert` | `(cond "msg")` | Print message and exit 1 if false |
| `read-line` | `(fd buf maxlen) → :str` | Read one line; returns a `:str` pointing into buf |
| `args-count` | `() → :i32` | Number of CLI arguments |
| `args-get` | `(i :i32) → :str` | i-th CLI argument as a `str` |
| `find-preopen` | `(name :str buf :ptr buf-len :i32) → :i32` | Scan WASI preopens for a matching dir name; returns fd or -1 |
| `open-file-at` | `(dirfd :i32 path :str readonly :i32) → :i32` | Open a file relative to a preopened fd |
| `open-file` | `(dir :str path :str readonly :i32) → :i32` | Find preopen + open file in one call |

### `lib/string.woua`
See the table above (included via `lib/string.woua`).

### `lib/time.woua`
Time helpers built on `clock_time_get` (includes `wasi_p1`):

| Function | Signature | Description |
|---|---|---|
| `time-now-ns` | `() → :i64` | Monotonic time in nanoseconds |
| `time-realtime-ns` | `() → :i64` | Wall-clock nanoseconds since Unix epoch |
| `time-now-ms` | `() → :i64` | Monotonic time in milliseconds |
| `time-elapsed-ms` | `(start :i64) → :i64` | Milliseconds since `start` |


