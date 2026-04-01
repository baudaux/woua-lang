# woua

**woua** is a low-level, Lisp-syntax language that compiles directly to [WebAssembly Text Format (WAT)](https://webassembly.github.io/spec/core/text/index.html) and targets [WASI Preview 1](https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md). It is designed to be as close to WAT as possible while remaining self-describing: operators, literal patterns, external imports, and struct types are all declared in `.woua` library files, not hardcoded in the compiler.

## Project structure

```
woua/
  lib/              Standard library (woua source)
    core.woua         Operators (defop), literal recognition (defliteral),
                      String type, i32->string, i64->string
    wasi_p1.woua      All WASI Preview 1 function imports (defimport)
    std_io.woua       Iovec type, write/print/print-int/print-int64 macros
  demos/
    hello_world.woua  Example program
  tests/
    01_defimport.woua … 15_i32_to_string.woua   One test per language feature
    out/              Compiled .wat and .wasm for each test
  wouac/            Compiler (AssemblyScript, compiles to WASM)
    assembly/
      index.ts        Entry point, include resolution, CLI
      reader.ts       Tokeniser / parser
      expander.ts     Macro expansion, compile-time evaluation
      codegen.ts      WAT code generation
      env.ts          Compiler environment (symbol tables)
      ast.ts          AST node types
      macros.ts       Built-in compile-time helpers
      primitives.ts   WAT instruction emitters
```

## Compiler pipeline

```
source.woua
    │
    ▼ readAndResolve          (index.ts)
    │  • reads one form at a time
    │  • (include name) → recursively reads the file from baseDir or lib/
    │  • (defliteral …) → registers the literal pattern in env immediately
    │    so subsequent tokens in the same file are read with the new pattern
    │  • string literals with :static flag are interned into linear memory
    │    as they are encountered
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
    │  • compiles (defn …) bodies with full type inference
    │  • hoists all (local …) declarations to the top of each function (WAT req.)
    │  • dead-code elimination: reachability walk from main via (call $name)
    │  • exports _start → main
    │
    ▼ WAT output (stdout)
```

## Language reference

### Comments
```woua
;; This is a line comment
```

### Including files
```woua
(include std_io)          ;; searches lib/ then current directory
(include ../mylib/foo)    ;; relative path, .woua extension added automatically
```
Includes are processed eagerly and deduplicated — the same file is never included twice.

### Declaring external functions (WASI / WASM imports)
```woua
(defimport fd_write "wasi_snapshot_preview1" "fd_write" (:i32 :i32 :i32 :i32) :i32)
;;          ^name   ^wasm module              ^wasm field  ^param types          ^result
;; Void functions omit the result type:
(defimport proc_exit "wasi_snapshot_preview1" "proc_exit" (:i32))
```
Imported functions appear as `(import …)` at the top of the generated WAT and can be called like any other function. Their return type is tracked by the compiler for correct type inference on call expressions.

### Declaring operators
Operators map directly to WAT instructions. The same name can be declared for multiple type signatures — the compiler selects the right overload via type inference on the arguments.
```woua
(defop + "i32.add"   (:i32 :i32) :i32)
(defop + "i64.add"   (:i64 :i64) :i64)
(defop + "f32.add"   (:f32 :f32) :f32)
(defop < "i32.lt_s"  (:i32 :i32) :i32)
(defop < "i64.lt_s"  (:i64 :i64) :i32)
```

### Declaring literal patterns
The reader has no hardcoded literal syntax. Literal types are declared with a regex pattern:
```woua
(defliteral string /"((?:[^"\\]|\\.)*)"/ :string :static)
;;           ^name  ^regex (JS-style /…/, capture group 1 = value)
;;                                        ^node type  ^optional :static flag
(defliteral int64  /-?[0-9]+i64/          :i64)
(defliteral int    /-?[0-9]+/             :i32)
(defliteral float  /-?[0-9]*\.[0-9]+/    :f32)
(defliteral float64 /-?[0-9]*\.[0-9]+f64/ :f64)
(defliteral hex    /0x[0-9a-fA-F]+/       :i32)
(defliteral hex64  /0x[0-9a-fA-F]+i64/    :i64)
```
Literals with `:static` are interned into linear memory at compile time (string literals). Longer patterns must be declared before shorter ones that match the same prefix (e.g. `int64` before `int`, `hex64` before `hex`).

### Declaring struct types
```woua
(deftype Point
  (x :i32)
  (y :i32))
```
Field types: `:i32` `:i64` `:f32` `:f64` `:ptr`.  
`(sizeof Point)` resolves to the byte size at compile time.  
Field accessors are generated automatically:
```woua
(Point/x p)        ;; getter → i32.load at p + offset
(Point/x! p val)   ;; setter → i32.store at p + offset
```

### Declaring macros
```woua
(defmacro square (x)
  (* x x))

(defmacro print (sym)
  (write 1 (static-ptr sym) (static-len sym)))
```
Macros are expanded recursively at compile time. Parameters are substituted textually. `(static-ptr sym)` and `(static-len sym)` resolve to the compile-time pointer and byte length of any static string (inline literal or named `defstatic`).

### Static data
```woua
(defstatic greeting "Hello!")    ;; string in linear memory
(defstatic counter :i32 0)       ;; 4-byte scalar initialised to 0
(defstatic buf :bytes 256)       ;; zeroed byte buffer
```
Inline string literals do not need `defstatic` — they are auto-interned and deduplicated:
```woua
(print "Hello!")   ;; no defstatic needed
;; Two occurrences of the same literal share the same pointer:
(= (static-ptr "hello") (static-ptr "hello"))  ;; → 1 (true)
```

### Functions
```woua
;; Parameter types default to :i32 when omitted.
(defn add (a b)
  (+ a b))

;; Explicit types on any parameter:
(defn scale (x :i64 factor :i64)
  (* x factor))

(defn main ()
  (print "Hello, World!\n"))
```
Return type is always inferred from the last expression in the body. The function named `main` is exported as `_start`. Dead functions (not reachable from `main`) are eliminated from the output.

### Expressions

| Form | Description |
|---|---|
| `42` `-7` | i32 literal |
| `100i64` `-1i64` | i64 literal |
| `3.14` `-1.5` | f32 literal |
| `2.718f64` | f64 literal |
| `0xFF` `0xDEADi64` | hex i32 / i64 literal |
| `"text"` | string literal (auto-interned into linear memory) |
| `/pattern/` | regex literal (used in `defliteral`) |
| `(op a b)` | operator call — overload selected by argument types |
| `(if cond then)` | conditional, no else branch (void) |
| `(if cond then else)` | conditional expression — both branches must return the same type |
| `(let name val body...)` | local binding, type inferred from value |
| `(let name :Type val body...)` | local binding with explicit type |
| `(set! name val)` | assign to an existing local |
| `(while cond body...)` | loop — body repeated until cond is false |
| `(drop expr)` | evaluate and discard a value |
| `(as :Type expr)` | numeric type cast — emits the appropriate WAT conversion instruction |
| `(i32.store ptr val)` | raw 4-byte memory write |
| `(i32.store8 ptr val)` | raw 1-byte memory write |
| `(i32.load8_u ptr)` | unsigned 1-byte memory read → i32 |
| `(Type/field ptr)` | struct field getter |
| `(Type/field! ptr val)` | struct field setter |
| `(sizeof Type)` | compile-time struct size in bytes |
| `(static-ptr sym)` | compile-time pointer to a static or inline string |
| `(static-len sym)` | compile-time byte length of a static or inline string |
| `(alloc size)` | runtime bump allocator — returns a 4-byte-aligned pointer |

### Type casts (`as`)

`(as :TargetType expr)` emits the correct WAT instruction for each conversion:

| From | To | WAT instruction |
|---|---|---|
| `:i32` | `:i64` | `i64.extend_i32_s` |
| `:i64` | `:i32` | `i32.wrap_i64` |
| `:f32` | `:f64` | `f64.promote_f32` |
| `:f64` | `:f32` | `f32.demote_f64` |
| `:i32` | `:f32` | `f32.convert_i32_s` |
| `:i32` | `:f64` | `f64.convert_i32_s` |
| `:ptr` ↔ `:i32` | either | no-op (both are `i32` in WAT) |

### Types

| Keyword | WAT type | Notes |
|---|---|---|
| `:i32` | `i32` | 32-bit integer, default parameter type |
| `:i64` | `i64` | 64-bit integer |
| `:f32` | `f32` | 32-bit float |
| `:f64` | `f64` | 64-bit float |
| `:ptr` | `i32` | pointer (alias for `:i32`) |
| `:TypeName` | `i32` | struct instance (heap pointer) |

## Standard library

### `lib/core.woua`
Defines all literal patterns, arithmetic and comparison operators for i32/i64/f32/f64, the `String` type, and number-to-string conversion:

| Function / Macro | Signature | Description |
|---|---|---|
| `i32->string` | `(n) → :String` | Convert i32 to a heap-allocated String |
| `i64->string` | `(n :i64) → :String` | Convert i64 to a heap-allocated String |
| `string` | `(s) → :String` | Wrap an inline string literal as a runtime String struct |

### `lib/wasi_p1.woua`
Imports the full WASI Preview 1 surface: `proc_exit`, `args_sizes_get`, `args_get`, `environ_sizes_get`, `environ_get`, `fd_read`, `fd_write`, `fd_close`, `fd_seek`, `fd_tell`, `fd_sync`, `clock_time_get`, `clock_res_get`, `random_get`.

### `lib/std_io.woua`
Defines the `Iovec` struct and I/O macros (includes `wasi_p1`):

| Macro | Signature | Description |
|---|---|---|
| `write` | `(fd ptr len)` | Write raw bytes to a file descriptor |
| `write-string` | `(fd s)` | Write a runtime `String` struct to a fd |
| `print-string` | `(s)` | Print a runtime `String` struct to stdout |
| `print-int` | `(n)` | Print an i32 to stdout |
| `print-int64` | `(n)` | Print an i64 to stdout |
| `print` | `(sym)` | Print a static/inline string literal to stdout |

## Hello, World

```woua
(include std_io)

(defn main ()
  (print "Hello, World!\n"))
```

The include chain: `std_io` → `wasi_p1` → `core`.

`core` registers all literal patterns and operators.  
`wasi_p1` imports all WASI functions.  
`std_io` defines `Iovec`, `write`, and the `print` family.

## Building the compiler

The compiler is written in [AssemblyScript](https://www.assemblyscript.org/) and compiles to a self-hosting WASI binary.

```sh
cd wouac
npm install
npm run asbuild
# Output: wouac/dist/wouac.wasm
```

## Running

```sh
# Compile a woua source file to WAT (stdout)
wasmtime --dir . wouac/dist/wouac.wasm demos/hello_world.woua

# Compile to a WAT file directly
wasmtime --dir . wouac/dist/wouac.wasm demos/hello_world.woua -o hello.wat

# Compile and assemble to WASM
wasmtime --dir . wouac/dist/wouac.wasm demos/hello_world.woua | wat2wasm - -o hello.wasm
wasmtime hello.wasm

# Use a custom library directory
wasmtime --dir . wouac/dist/wouac.wasm --lib /path/to/lib demos/hello_world.woua

# Read from stdin
cat demos/hello_world.woua | wasmtime --dir . wouac/dist/wouac.wasm
```

### CLI options

```
Usage: wouac [options] [source.woua]

  Compile a woua source file to WebAssembly Text Format (WAT).
  If no file is given, source is read from stdin.

Options:
  source.woua         Input source file
  -o, --output <file> Output file (default: stdout)
  --lib <dir>         Library directory (default: lib/)
  --help, -h          Show this help message
  --version, -v       Show compiler version
```


## Project structure

```
woua/
  lib/              Standard library (woua source)
    core.woua         Operators (defop), literal recognition (defliteral)
    wasi_p1.woua      All WASI Preview 1 function imports (defimport)
    std_io.woua       Iovec type, write/print macros
  demos/
    hello_world.woua  Example program
  wouac/            Compiler (AssemblyScript, compiles to WASM)
    assembly/
      index.ts        Entry point, include resolution, CLI
      reader.ts       Tokeniser / parser
      expander.ts     Macro expansion, compile-time evaluation
      codegen.ts      WAT code generation
      env.ts          Compiler environment (symbol tables)
      ast.ts          AST node types
      macros.ts       Built-in compile-time helpers
      primitives.ts   WAT instruction emitters
```

## Compiler pipeline

```
source.woua
    │
    ▼ readAndResolve          (index.ts)
    │  • reads one form at a time
    │  • (include name) → recursively reads the file from baseDir or lib/
    │  • (defliteral …) → registers the literal pattern in env immediately
    │  • string literals are interned into linear memory as they are read
    │
    ▼ expandAll               (expander.ts)
    │  • (defstatic …)  → allocates static data, emits (data …) directive
    │  • (deftype …)    → registers struct layout in env.types
    │  • (defmacro …)   → registers macro template in env.macros
    │  • (defimport …)  → registers WASM import in env.imports
    │  • (defop …)      → registers operator overload in env.ops
    │  • (defliteral …) → registers literal pattern in env.literals
    │  • user macros    → recursively expanded in-place
    │  • (defn …)       → forwarded to codegen unchanged
    │
    ▼ generateModule          (codegen.ts)
    │  • emits (import …) for each env.imports entry
    │  • emits linear memory, static data, bump allocator
    │  • compiles (defn …) bodies with type inference
    │  • exports _start → main
    │
    ▼ WAT output
```

## Language reference

### Comments
```
;; This is a line comment
```

### Including files
```woua
(include std_io)        ;; searches lib/ then current directory
(include ../mylib/foo)  ;; relative path, .woua extension added automatically
```

### Declaring external functions (WASI / WASM imports)
```woua
(defimport fd_write "wasi_snapshot_preview1" "fd_write" (:i32 :i32 :i32 :i32) :i32)
;;          ^name   ^wasm module              ^wasm field  ^param types          ^result
;; void functions omit the result type:
(defimport proc_exit "wasi_snapshot_preview1" "proc_exit" (:i32))
```

### Declaring operators
Operators are declared in `.woua` files and map directly to WAT instructions. The same name can be declared for multiple types — the compiler selects the right overload via type inference.
```woua
(defop + "i32.add" (:i32 :i32) :i32)
(defop + "f32.add" (:f32 :f32) :f32)
(defop < "i32.lt_s" (:i32 :i32) :i32)
```

### Declaring literal patterns
The reader has no hardcoded literal syntax. Literal types are declared with a regex pattern:
```woua
(defliteral string /"((?:[^"\\]|\\.)*)"/ :string)
;;           ^name  ^regex (capture group 1 = value)  ^node type
```
When the reader encounters the opening delimiter character it uses the registered pattern to consume the literal. String literals are interned into linear memory immediately.

### Declaring struct types
```woua
(deftype Iovec
  (base :ptr)
  (len  :i32))
```
Field types: `:i32` `:i64` `:f32` `:f64` `:ptr`.  
`(sizeof Iovec)` resolves to the byte size at compile time.  
Field accessors are generated automatically:
```woua
(Iovec/base ptr)       ;; getter → i32.load at ptr + offset
(Iovec/base! ptr val)  ;; setter → i32.store at ptr + offset
```

### Declaring macros
```woua
(defmacro print (sym)
  (write 1 (static-ptr sym) (static-len sym)))
```
Macros are expanded at compile time. `(static-ptr sym)` and `(static-len sym)` resolve to the linear-memory pointer and byte length of the named (or inline) static.

### Static data
```woua
(defstatic greeting "Hello!")   ;; string in linear memory
(defstatic counter :i32 0)      ;; scalar
(defstatic buf :bytes 256)      ;; zeroed byte buffer
```
Inline string literals do not need `defstatic` — they are auto-interned:
```woua
(print "Hello!")  ;; no defstatic needed
```

### Functions
```woua
(defn add (a b)
  (+ a b))

(defn main ()
  (print "Hello, World!\n"))
```
Parameter and return types are inferred. The function named `main` is exported as `_start`.

### Expressions

| Form | Description |
|---|---|
| `42` `-7` | i32 literal |
| `3.14` | f32 literal |
| `"text"` | string literal (auto-interned) |
| `/pattern/` | regex literal (used in `defliteral`) |
| `(op a b)` | operator call — overload selected by type inference |
| `(if cond then else?)` | conditional |
| `(let name val body...)` | local binding, type inferred |
| `(let name :Type val body...)` | local binding with explicit type |
| `(set! name val)` | assign to local |
| `(call name args...)` | explicit function call |
| `(drop expr)` | discard a value |
| `(as :Type expr)` | type cast (no-op in WAT — ptr types are i32) |
| `(i32.store ptr val)` | raw memory write |
| `(Type/field ptr)` | struct field getter |
| `(Type/field! ptr val)` | struct field setter |
| `(sizeof Type)` | compile-time struct size |
| `(static-ptr sym)` | compile-time pointer to a static |
| `(static-len sym)` | compile-time byte length of a static |
| `(alloc size)` | runtime bump allocator, returns pointer |

### Types

| Keyword | WAT type | Notes |
|---|---|---|
| `:i32` | `i32` | 32-bit integer |
| `:i64` | `i64` | 64-bit integer |
| `:f32` | `f32` | 32-bit float |
| `:f64` | `f64` | 64-bit float |
| `:ptr` | `i32` | pointer (alias for :i32) |
| `:TypeName` | `i32` | struct instance (heap pointer) |

## Hello, World

```woua
(include std_io)

(defn main ()
  (print "Hello, World!\n"))
```

The include chain: `std_io` → `wasi_p1` → `core`.

`core` registers the string literal pattern (`defliteral`), operators (`defop`), and the `String` type.  
`wasi_p1` imports all WASI Preview 1 functions.  
`std_io` defines `Iovec`, `write`, and `print`.

## Building the compiler

The compiler is written in [AssemblyScript](https://www.assemblyscript.org/) and compiles to a self-hosting WASI binary.

```sh
cd wouac
npm install
npm run asbuild
```

## Running

```sh
# Compile a woua source file to WAT
wasmtime wouac.wasm demos/hello_world.woua

# Pipe to wat2wasm and run
wasmtime wouac.wasm demos/hello_world.woua | wat2wasm - -o hello.wasm
wasmtime hello.wasm

# Custom lib directory
wasmtime wouac.wasm --lib /path/to/lib demos/hello_world.woua
```
