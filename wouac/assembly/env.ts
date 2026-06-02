// Compile-time environment — tracks all state accumulated during macro expansion.

import { Node } from "./ast";

// Info stored for each (defimport ...) declaration
export class ImportInfo {
  localName: string;   // name used in woua code (e.g. fd_write)
  module_:   string;   // wasm import module string (e.g. "wasi_snapshot_preview1")
  field:     string;   // wasm import field string  (e.g. "fd_write")
  params:    Array<string>; // woua type keywords, e.g. [":i32", ":i64"]
  result:    string;   // woua type keyword for return, or "" for void

  constructor(localName: string, module_: string, field: string,
              params: Array<string>, result: string) {
    this.localName = localName;
    this.module_   = module_;
    this.field     = field;
    this.params    = params;
    this.result    = result;
  }
}

// Info stored for each (defop ...) declaration
export class OpInfo {
  name:   string;        // woua operator name (e.g. "+")
  watOp:  string;        // WAT instruction (e.g. "i32.add")
  params: Array<string>; // param type keywords
  result: string;        // result type keyword, or "" for void

  constructor(name: string, watOp: string, params: Array<string>, result: string) {
    this.name   = name;
    this.watOp  = watOp;
    this.params = params;
    this.result = result;
  }
}

// Info stored for each (defstatic ...) declaration
export class StaticInfo {
  ptr: i32;       // byte offset in linear memory
  len: i32;       // byte length (-1 for scalars)
  typeName: string; // ":strlit", ":*str", ":bytes", ":i32", ":f32", ":i64", ":f64", ":ptr", or a user type

  constructor(ptr: i32, len: i32, typeName: string) {
    this.ptr = ptr;
    this.len = len;
    this.typeName = typeName;
  }

  isString(): bool { return this.typeName == ":strlit" || this.typeName == ":*str"; }
  isBytes():  bool { return this.typeName == ":bytes";  }
  isScalar(): bool { return this.len == -1;              }
}

// Info stored for each field in a (deftype ...) declaration
export class FieldInfo {
  offset:   i32;    // byte offset within the struct
  typeName: string; // ":i32", ":f32", ":i64", ":f64", ":ptr"

  constructor(offset: i32, typeName: string) {
    this.offset   = offset;
    this.typeName = typeName;
  }
}

// Info stored for each (defmacro ...) declaration
export class MacroInfo {
  params:    Array<string>; // fixed parameter names
  restParam: string;        // name of the variadic rest param, or "" if none
  body:      Node;          // template body (a single expression)
  constructor(params: Array<string>, restParam: string, body: Node) {
    this.params    = params;
    this.restParam = restParam;
    this.body      = body;
  }
}

// Info stored for each (deftype ...) declaration
export class TypeInfo {
  size:       i32;                    // total byte size of the struct
  fields:     Map<string, FieldInfo>; // field name → field info
  fieldNames: Array<string>;          // field names in declaration order (for constructors)

  constructor(size: i32) {
    this.size       = size;
    this.fields     = new Map<string, FieldInfo>();
    this.fieldNames = new Array<string>();
  }
}

// Info stored for each (defvar ...) declaration
export class GlobalInfo {
  typeName:    string; // woua type keyword, e.g. ":i32" or ":Point"
  initWat:     string; // WAT initializer expression, e.g. "(i32.const 0)"
  isValueType: bool;   // true for value-type struct marker (no WAT global emitted)
  constructor(typeName: string, initWat: string, isValueType: bool = false) {
    this.typeName    = typeName;
    this.initWat     = initWat;
    this.isValueType = isValueType;
  }
}

// Info stored for each distinct function type used as a first-class value.
// Represents a function type annotation like (:i32 -> :i32) or (:i32 :i32 -> :i32 :i32).
export class FuncTypeEntry {
  params:  Array<string>; // woua type keywords for parameters, e.g. [":i32"]
  results: Array<string>; // woua type keywords for results — empty for void, multiple for tuples
  constructor(params: Array<string>, results: Array<string>) {
    this.params  = params;
    this.results = results;
  }
}

// Info stored for a single method signature inside a (defprotocol ...) declaration.
// :*Self is used as a placeholder for the implementing type.
export class ProtocolMethodSig {
  params: Array<string>; // param type keywords; :*Self = implementing type
  result: string;        // return type keyword, or "" for void
  constructor(params: Array<string>, result: string) {
    this.params = params;
    this.result = result;
  }
}

// Info stored for each (defprotocol ...) declaration
export class ProtocolInfo {
  methods:     Map<string, ProtocolMethodSig>; // method name → signature
  methodNames: Array<string>;                  // insertion order
  constructor() {
    this.methods     = new Map<string, ProtocolMethodSig>();
    this.methodNames = new Array<string>();
  }
}

// Info stored for each (defliteral ...) declaration
export class LiteralInfo {
  name:     string; // e.g. "string"
  pattern:  string; // regex pattern that matches the literal
  nodeType: string; // woua type keyword produced, e.g. ":string"
  suffix:   string; // literal text suffix derived from the pattern, e.g. "i64" for /-?[0-9]+i64/
                    // empty string for delimiter-based literals and unsuffixed atom literals
  prefix:   string; // literal text prefix derived from the pattern, e.g. "0x" for /0x[0-9a-fA-F]+/
                    // empty string when the pattern starts with an optional or variable part
  isStatic: bool;   // true when declared with :static — matched values are interned in linear memory

  constructor(name: string, pattern: string, nodeType: string, isStatic: bool = false) {
    this.name     = name;
    this.pattern  = pattern;
    this.nodeType = nodeType;
    this.suffix   = extractSuffix(pattern);
    this.prefix   = extractPrefix(pattern);
    this.isStatic = isStatic;
  }
}

// Scan the pattern from the right until a regex metacharacter is found;
// the remaining text is the literal suffix (e.g. "i64" in "-?[0-9]+i64").
function extractSuffix(pattern: string): string {
  let i = pattern.length - 1;
  while (i >= 0) {
    const c = pattern.charAt(i);
    if (c == "+" || c == "*" || c == "?" || c == "]" || c == ")" ||
        c == "|" || c == "." || c == "\\" || c == "^" || c == "$" ||
        c == "{" || c == "(") break;
    i--;
  }
  return pattern.slice(i + 1);
}

// Scan the pattern from the left, collecting characters that are mandatory
// literal text: stop when a regex metachar is found or the next character is
// a quantifier (which would make the current char optional/repeated).
// Examples: "0x[0-9a-fA-F]+" -> "0x",  "-?[0-9]+" -> ""
function extractPrefix(pattern: string): string {
  let result = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c == "[" || c == "(" || c == "{" || c == "\\" || c == "." ||
        c == "|" || c == "^" || c == "$") break;
    if (i + 1 < pattern.length) {
      const next = pattern.charAt(i + 1);
      if (next == "?" || next == "*" || next == "+") break;
    }
    result += c;
  }
  return result;
}

// The global compiler environment, threaded through all passes
export class Env {
  // ── Memory cursor ───────────────────────────────────────────────────────────
  // Linear memory begins at 0; statics are packed from here.
  // The $alloc heap starts immediately after all statics (see assembleModule).
  memoryOffset: i32 = 0;

  // ── Symbol tables ────────────────────────────────────────────────────────────
  statics:    Map<string, StaticInfo>    = new Map<string, StaticInfo>();
  types:      Map<string, TypeInfo>      = new Map<string, TypeInfo>();
  macros:     Map<string, MacroInfo>     = new Map<string, MacroInfo>();
  ops:        Map<string, Array<OpInfo>> = new Map<string, Array<OpInfo>>();
  literals:   Map<string, LiteralInfo>   = new Map<string, LiteralInfo>();
  protocols:  Map<string, ProtocolInfo>  = new Map<string, ProtocolInfo>();
  globals:    Map<string, GlobalInfo>    = new Map<string, GlobalInfo>();
  globalNames: Array<string>             = new Array<string>();

  // ── Accumulated WAT output sections ─────────────────────────────────────────
  imports:     Array<ImportInfo>   = new Array<ImportInfo>();   // defimport declarations
  dataEntries: Array<string>       = new Array<string>();       // (data ...) directives
  funcBodies:  Map<string, string> = new Map<string, string>(); // name → WAT body
  funcNames:   Array<string>       = new Array<string>();       // insertion order
  funcResultTypes: Map<string, string> = new Map<string, string>(); // name → inferred result type
  funcTupleResults: Map<string, Array<string>> = new Map<string, Array<string>>(); // name → tuple types

  // ── printf generated functions: format string → function name ──────────────
  printfFuncsByFmt:  Map<string, string> = new Map<string, string>();
  printfNameCounts:  Map<string, i32>    = new Map<string, i32>();    // base name → count

  // ── First-class function support (fn-ref / call_indirect) ───────────────────
  funcTypesByKey:   Map<string, FuncTypeEntry> = new Map<string, FuncTypeEntry>(); // key → type info
  funcTypeKeys:     Array<string>              = new Array<string>();               // insertion order
  funcTableEntries: Array<string>              = new Array<string>();               // funcs registered via fn-ref
  funcTableIndex:   Map<string, i32>           = new Map<string, i32>();            // func name → table index

  // ── Errors accumulated during compilation ────────────────────────────────
  errors: Array<string> = new Array<string>();

  // ── Compiler options ─────────────────────────────────────────────────────
  noPeephole: bool = false;  usesSvg:    bool = false;  // true when lib/svg.woua is included → emit shared memory
  // ── Alignment helpers ────────────────────────────────────────────────────────

  alignOf(typeName: string): i32 {
    if (typeName == ":u8")                                               return 1;
    if (typeName == ":i32" || typeName == ":f32" || typeName == ":ptr") return 4;
    if (typeName == ":i64" || typeName == ":f64")                        return 8;
    if (typeName == ":v128" || typeName == ":i8x16" || typeName == ":i16x8" ||
        typeName == ":i32x4" || typeName == ":i64x2" ||
        typeName == ":f32x4" || typeName == ":f64x2")                     return 16;
    if (typeName.startsWith(":*")) return 4; // ref-type field = pointer
    // Embedded struct: align to first field
    if (typeName.startsWith(":") && this.types.has(typeName.slice(1))) {
      const ti = this.types.get(typeName.slice(1));
      if (ti.fieldNames.length > 0) return this.alignOf(ti.fields.get(ti.fieldNames[0]).typeName);
      return 4;
    }
    return 4;
  }

  sizeOf(typeName: string): i32 {
    if (typeName == ":u8")                                               return 1;
    if (typeName == ":i32" || typeName == ":f32" || typeName == ":ptr") return 4;
    if (typeName == ":i64" || typeName == ":f64")                        return 8;
    if (typeName == ":v128" || typeName == ":i8x16" || typeName == ":i16x8" ||
        typeName == ":i32x4" || typeName == ":i64x2" ||
        typeName == ":f32x4" || typeName == ":f64x2")                     return 16;
    if (typeName.startsWith(":*")) return 4; // ref-type field = pointer
    // Embedded struct: size from env.types
    if (typeName.startsWith(":") && this.types.has(typeName.slice(1)))
      return this.types.get(typeName.slice(1)).size;
    return 4; // fallback
  }

  // Advance the memory cursor with alignment, return the allocated pointer
  allocate(size: i32, align: i32): i32 {
    const rem = this.memoryOffset % align;
    if (rem != 0) this.memoryOffset += align - rem;
    const ptr = this.memoryOffset;
    this.memoryOffset += size;
    return ptr;
  }
}
