// Codegen — walks expanded forms and emits a complete WAT module as a string.
//
// Supported top-level forms:
//   (defimport name "mod" "field" (types...) result?)  wasm import
//   (defn name (params...) body...)                    function definition
//
// Supported expressions:
//   (op args...)                          operator call (overload selected via type inference)
//   (if cond then else?)                  conditional
//   (let name [:Type] val body)            local binding (type defaults to i32)
//   (set! name val)                       local assignment
//   (call name args...)                   explicit function call
//   (i32.store ptr val)                   raw memory store (void)
//   (drop expr)                           discard a value (void)
//   (as :Type expr)                       type cast, no-op in WAT (ptr → i32)
//   (TypeName/field ptr)                  struct getter
//   (TypeName/field! ptr val)             struct setter
//   integer literal                       i32.const
//   float literal                         f32.const
//   symbol                                local.get

import { Node, ListNode, IntNode, FloatNode, SymbolNode,
         CommentNode, V128Node,
         TAG_INT, TAG_FLOAT, TAG_SYMBOL, TAG_LIST, TAG_COMMENT, TAG_V128 } from "./ast";
import { Env, OpInfo, FuncTypeEntry } from "./env";
import { ExpandedForm } from "./expander";
import { expandFieldGet, expandFieldSet } from "./macros";
import {
  watI32Const, watF32Const, watF64Const, watI64Const,
  watLocalGet, watLocalSet, watLocalDecl,
  watI32Store, watI32Store8, watI32Load, watI32Load8u, watI32Load16u,
  watI64Store, watI64Load,
  watF32Store, watF32Load, watF64Store, watF64Load,
  watIf, watBlock, watLoop, watBrIf, watBr,
  watCall, watReturnCall, watDrop, watReturn,
} from "./primitives";
import { peepholeOptimizeBody } from "./peephole";

// ─── Public entry point ───────────────────────────────────────────────────────

export function generateModule(forms: Array<ExpandedForm>, env: Env): string {
  // Pass 1: collect explicit tuple return annotations — these are declared, not
  // inferred, so they are always available for forward references.
  for (let i = 0; i < forms.length; i++) {
    const node = forms[i].node;
    if (node.tag != TAG_LIST) continue;
    const list = node as ListNode;
    if (list.children.length < 2 || list.children[0].tag != TAG_SYMBOL) continue;
    if ((list.children[0] as SymbolNode).name != "defn") continue;
    const fname = (list.children[1] as SymbolNode).name;
    const tupleTypes = extractTupleAnnotation(list, 3);
    if (tupleTypes != null) {
      env.funcTupleResults.set(fname, tupleTypes);
      env.funcResultTypes.set(fname, ""); // multi-return: no single result type
    } else {
      // :str return annotation is treated as a two-value tuple (:i32 :i32).
      const scalarAnnot = extractScalarReturnAnnotation(list);
      if (scalarAnnot == ":str") {
        env.funcTupleResults.set(fname, [":i32", ":i32"]);
        env.funcResultTypes.set(fname, "");
      } else if (scalarAnnot != null && isSliceType(scalarAnnot)) {
        // :T[] return annotation → fat-pointer (ptr, len) = two i32 results.
        env.funcTupleResults.set(fname, [":i32", ":i32"]);
        env.funcResultTypes.set(fname, "");
      } else if (scalarAnnot != null && isValueTypeAnnot(scalarAnnot, env)) {
        // Value-type struct return → multi-value tuple of leaf field types (recursive)
        const vtN = valueTypeName(scalarAnnot);
        const vtFields = valueTypeLeafTypes(vtN, env);
        env.funcTupleResults.set(fname, vtFields);
        env.funcResultTypes.set(fname, "");
      }
    }
  }

  // Pass 2: infer result types for single-return functions (skips tuple ones).
  for (let i = 0; i < forms.length; i++) {
    const node = forms[i].node;
    if (node.tag != TAG_LIST) continue;
    const list = node as ListNode;
    if (list.children.length < 2 || list.children[0].tag != TAG_SYMBOL) continue;
    if ((list.children[0] as SymbolNode).name != "defn") continue;
    const fname = (list.children[1] as SymbolNode).name;
    if (env.funcTupleResults.has(fname)) continue; // already handled in pass 1
    const prescanType = inferDefnResultType(list, env);
    env.funcResultTypes.set(fname, prescanType);
  }

  // Codegen all top-level (defn ...) forms, keyed by function name.
  // Top-level CommentNodes are accumulated and prepended to the next defn.
  let pendingComment = "";
  for (let i = 0; i < forms.length; i++) {
    const node = forms[i].node;
    if (node.tag == TAG_COMMENT) {
      pendingComment += "  (; " + (node as CommentNode).text + " ;)\n";
      continue;
    }
    if (node.tag == TAG_LIST) {
      const list = node as ListNode;
      if (list.children.length > 0 && list.children[0].tag == TAG_SYMBOL) {
        const head = (list.children[0] as SymbolNode).name;
        if (head == "defn") {
          const name = (list.children[1] as SymbolNode).name;
          if (env.funcBodies.has(name)) {
            env.errors.push("defn: duplicate function name '" + name + "'");
          }
          const wat  = codegenDefn(list, env);
          env.funcBodies.set(name, pendingComment + (env.noPeephole ? wat : peepholeOptimizeBody(wat)));
          env.funcNames.push(name);
          pendingComment = "";
        }
      }
    }
    if (node.tag != TAG_COMMENT) pendingComment = "";
  }

  return assembleModule(env);
}

// ─── WAT type helper ──────────────────────────────────────────────────────────

// Convert a woua type keyword to a WAT primitive type name.
// Known primitives: :i32 :i64 :f32 :f64 :ptr :u8
// User-defined struct types (e.g. :Iovec) are pointer-sized → i32.
// True for the six typed SIMD subtypes (:i8x16, :i16x8, :i32x4, :i64x2, :f32x4, :f64x2).
// All are 128-bit (v128 in WAT) with specific lane interpretations.
function isSimdSubtype(t: string): bool {
  return t == ":i8x16" || t == ":i16x8" || t == ":i32x4" ||
         t == ":i64x2" || t == ":f32x4" || t == ":f64x2";
}

function watType(t: string): string {
  if (t == ":i32" || t == ":ptr" || t == ":u8") return "i32";
  if (t == ":i64")                 return "i64";
  if (t == ":f32")                 return "f32";
  if (t == ":f64")                 return "f64";
  if (t == ":v128" || isSimdSubtype(t)) return "v128";
  if (t.startsWith(":func:"))      return "i32"; // function reference = table index
  // User-defined type name — struct instances are always heap pointers (i32)
  return "i32";
}

// ─── Struct type helpers ─────────────────────────────────────────────────────

// ─── Slice type helpers ───────────────────────────────────────────────────────

// True if `t` is a fat-pointer slice type: `:T[]` or `:T[N]` (not `:*T[]`).
// These expand to two WAT locals/params just like `:str`.
function isSliceType(t: string): bool {
  return t.startsWith(":") && !t.startsWith(":*") && t.indexOf("[") > 0;
}

// True when `t` is a pointer-to-slice: `:*T[]` or `:*T[N]`.
// These store the {ptr, len} header in linear memory; the variable is a single i32.
function isPtrSliceType(t: string): bool {
  return t.startsWith(":*") && t.indexOf("[") > 0;
}

// True when `t` is a pointer-to-alloc-slice: `:*T[N]` with non-empty N.
// `(let buf :*f32[4] ...)` allocates both the element buffer and the 8-byte header.
function isPtrAllocSliceType(t: string): bool {
  if (!isPtrSliceType(t)) return false;
  const lb = t.lastIndexOf("[");
  return t.slice(lb + 1, t.length - 1).length > 0;
}

// Extract the element type from a pointer-to-slice annotation.
//   :*f32[]  → :f32
//   :*f32[4] → :f32
//   :*i32[N] → :i32
function ptrSliceElemType(t: string): string {
  const lb = t.indexOf("[");
  if (lb < 0) return ":i32";
  return ":" + t.slice(2, lb); // strip ":*" prefix up to "["
}

// True if `t` is an alloc-shorthand slice: `:T[N]` where N is non-empty.
// (`:T[]` with empty brackets is a plain slice without auto-alloc.)
function isAllocSliceType(t: string): bool {
  if (!isSliceType(t)) return false;
  const lb = t.lastIndexOf("[");
  return t.slice(lb + 1, t.length - 1).length > 0; // non-empty content
}

// Extract the element type from a slice annotation.
//   :i32[]   → :i32
//   :i32[16] → :i32
//   :f64[]   → :f64
//   :Point[] → :Point
function sliceElemType(t: string): string {
  const lb = t.indexOf("[");
  if (lb < 0) return ":i32";
  return t.slice(0, lb); // ":i32" from ":i32[]" or ":i32[16]"
}

// Return a WAT expression for the size N in `:T[N]`.
// N may be a decimal literal, a defconst name, or a local variable name.
function sliceAllocSizeWat(sizeStr: string, env: Env): string {
  // Pure integer literal
  let allDigits = sizeStr.length > 0;
  for (let i = 0; i < sizeStr.length; i++) {
    const c = sizeStr.charCodeAt(i);
    if (c < 48 || c > 57) { allDigits = false; break; }
  }
  if (allDigits) return "(i32.const " + sizeStr + ")";
  // Known defconst (zero-arg macro expanding to an IntNode)
  if (env.macros.has(sizeStr)) {
    const m = env.macros.get(sizeStr);
    if (m.params.length == 0 && m.body.tag == TAG_INT)
      return "(i32.const " + (m.body as IntNode).value.toString() + ")";
  }
  // Assume it's a local variable
  return "(local.get $" + sizeStr + ")";
}

// True if `t` is a value-type struct annotation: `:TypeName` where TypeName is
// registered in env.types (not a primitive, :str, :void, or :*TypeName).
function isValueTypeAnnot(t: string, env: Env): bool {
  if (t.length < 2) return false;
  if (!t.startsWith(":")) return false;
  if (t.startsWith(":*")) return false;
  if (t == ":i32" || t == ":i64" || t == ":f32" || t == ":f64" ||
      t == ":ptr" || t == ":u8"  || t == ":str" || t == ":void" || t == ":v128") return false;
  if (isSimdSubtype(t)) return false;
  if (t.startsWith(":func:")) return false;
  if (isSliceType(t)) return false; // :T[] and :T[N] are slice types, not user structs
  return env.types.has(t.slice(1));
}

// Strip the leading `:` from a value-type annotation to get the struct TypeName.
function valueTypeName(t: string): string { return t.slice(1); } // ":Point" → "Point"

// True if `t` is a reference-type struct annotation: `:*TypeName`.
function isRefTypeAnnot(t: string, env: Env): bool {
  if (!t.startsWith(":*")) return false;
  return env.types.has(t.slice(2));
}

// Strip the leading `:*` from a ref-type annotation to get the struct TypeName.
function refTypeName(t: string): string { return t.slice(2); } // ":*Point" → "Point"

// ─── First-class function helpers ────────────────────────────────────────────────────────────

// True if `node` is a function-type annotation: a ListNode containing a `->` symbol.
function isFuncTypeNode(node: Node): bool {
  if (node.tag != TAG_LIST) return false;
  const list = node as ListNode;
  for (let i = 0; i < list.children.length; i++) {
    if (list.children[i].tag == TAG_SYMBOL &&
        (list.children[i] as SymbolNode).name == "->") return true;
  }
  return false;
}

// Parse a function-type node (:T1 :T2 -> :TR) into a FuncTypeEntry.
// The `->` symbol separates parameter types from the result type.
function parseFuncTypeNode(node: ListNode): FuncTypeEntry {
  const params  = new Array<string>();
  const results = new Array<string>();
  let afterArrow = false;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.tag != TAG_SYMBOL) continue;
    const sym = (child as SymbolNode).name;
    if (sym == "->") { afterArrow = true; continue; }
    if (afterArrow) results.push(sym);
    else params.push(sym);
  }
  return new FuncTypeEntry(params, results);
}

// Produce the canonical WAT type key for a function signature.
// Example: params=[":i32",":i32"] results=[":i32",":i32"] → "fn_i32_i32_to_i32_i32"
function funcTypeKey(params: Array<string>, results: Array<string>): string {
  let key = "fn";
  for (let i = 0; i < params.length; i++) key += "_" + params[i].slice(1);
  key += "_to";
  if (results.length == 0) key += "_void";
  else for (let i = 0; i < results.length; i++) key += "_" + results[i].slice(1);
  return key;
}

// Register a function type in env (if new) and return its key.
function registerFuncTypeIfNeeded(params: Array<string>, results: Array<string>, env: Env): string {
  const key = funcTypeKey(params, results);
  if (!env.funcTypesByKey.has(key)) {
    env.funcTypesByKey.set(key, new FuncTypeEntry(params, results));
    env.funcTypeKeys.push(key);
  }
  return key;
}

// Add a named function to the first-class function table; return its table index.
function registerFuncRef(name: string, env: Env): i32 {
  if (env.funcTableIndex.has(name)) return env.funcTableIndex.get(name);
  const idx = env.funcTableEntries.length;
  env.funcTableEntries.push(name);
  env.funcTableIndex.set(name, idx);
  return idx;
}

// ─── Module assembly ──────────────────────────────────────────────────────────

function assembleModule(env: Env): string {
  let out = "(module\n";

  // Function type declarations for call_indirect (first-class functions)
  for (let i = 0; i < env.funcTypeKeys.length; i++) {
    const key = env.funcTypeKeys[i];
    const ft  = env.funcTypesByKey.get(key);
    let typeDecl = "  (type $" + key + " (func";
    if (ft.params.length > 0) {
      typeDecl += " (param";
      for (let j = 0; j < ft.params.length; j++) typeDecl += " " + watType(ft.params[j]);
      typeDecl += ")";
    }
    if (ft.results.length > 0) {
      typeDecl += " (result";
      for (let j = 0; j < ft.results.length; j++) typeDecl += " " + watType(ft.results[j]);
      typeDecl += ")";
    }
    typeDecl += "))\n";
    out += typeDecl;
  }
  if (env.funcTypeKeys.length > 0) out += "\n";

  // Imports from (defimport ...) declarations
  for (let i = 0; i < env.imports.length; i++) {
    const imp = env.imports[i];
    out += '  (import "' + imp.module_ + '" "' + imp.field + '"\n';
    out += '    (func $' + imp.localName;
    if (imp.params.length > 0) {
      out += " (param";
      for (let j = 0; j < imp.params.length; j++) {
        out += " " + watType(imp.params[j]);
      }
      out += ")";
    }
    if (imp.result != "") {
      out += " (result " + watType(imp.result) + ")";
    }
    out += "))\n";
  }
  if (env.imports.length > 0) out += "\n";

  // Linear memory — shared when svg is used (worker↔main-thread access)
  if (env.usesSvg) {
    out += "  (memory 1 65536 shared)\n";
  } else {
    out += "  (memory 1)\n";
  }
  out += '  (export "memory" (memory 0))\n\n';

  // Function table for first-class functions (fn-ref / call_indirect)
  if (env.funcTableEntries.length > 0) {
    out += "  (table " + env.funcTableEntries.length.toString() + " funcref)\n";
    out += "  (elem (i32.const 0)";
    for (let i = 0; i < env.funcTableEntries.length; i++) {
      out += " $" + env.funcTableEntries[i];
    }
    out += ")\n\n";
  }

  // Data sections from defstatic
  for (let i = 0; i < env.dataEntries.length; i++) {
    out += "  " + env.dataEntries[i] + "\n";
  }
  if (env.dataEntries.length > 0) out += "\n";

  // Patch heap-ptr and heap-base to the first byte past static data (8-byte aligned).
  // lib/memory.woua declares both as (defvar ... :ptr) with placeholder zero;
  // heap-base is never mutated — it records the permanent baseline for alloc-reset.
  const alignedHeap = (env.memoryOffset + 7) & ~7;
  if (env.globals.has("heap-ptr")) {
    env.globals.get("heap-ptr").initWat = "(i32.const " + alignedHeap.toString() + ")";
  }
  if (env.globals.has("heap-base")) {
    env.globals.get("heap-base").initWat = "(i32.const " + alignedHeap.toString() + ")";
  }

  // User-defined mutable globals from (defvar ...)
  // Value-type struct markers (isValueType=true) are skipped — only their leaf sub-globals are emitted.
  for (let i = 0; i < env.globalNames.length; i++) {
    const gname = env.globalNames[i];
    const ginfo = env.globals.get(gname);
    if (ginfo.isValueType) continue; // marker only
    out += "  (global $" + gname + " (mut " + watType(ginfo.typeName) + ") " + ginfo.initWat + ")\n";
  }
  if (env.globalNames.length > 0) out += "\n";


  // User-defined functions — dead code elimination.
  // Walk reachable set starting from "main", following (call $name) references.
  const reachable = new Set<string>();
  const queue     = new Array<string>();
  queue.push("main");
  // Functions registered via fn-ref are reachable (called indirectly via the table)
  for (let i = 0; i < env.funcTableEntries.length; i++) {
    queue.push(env.funcTableEntries[i]);
  }
  while (queue.length > 0) {
    const fname = queue.shift();
    if (reachable.has(fname)) continue;
    reachable.add(fname);
    if (!env.funcBodies.has(fname)) continue;
    const body = env.funcBodies.get(fname);
    // Scan for (call $foo) and (return_call $foo) references in the WAT body
    let pos = 0;
    while (pos < body.length) {
      let idx = body.indexOf("(call $", pos);
      const ridx = body.indexOf("(return_call $", pos);
      // Pick whichever comes first; prefer return_call if it's at the same position
      // (return_call starts with "(call $" so indexOf("(call $") would also match it
      // at that position — but only the longer "(return_call $" prefix is correct there)
      const pfxLen: i32 = (ridx != -1 && (idx == -1 || ridx <= idx)) ? 14 : 7;
      if (pfxLen == 14) idx = ridx;
      if (idx == -1) break;
      let end = idx + pfxLen;
      while (end < body.length) {
        const c = body.charAt(end);
        if (c == " " || c == ")" || c == "\n" || c == "\t") break;
        end++;
      }
      const callee = body.slice(idx + pfxLen, end);
      if (!reachable.has(callee)) queue.push(callee);
      pos = end;
    }
  }
  // Also always include "alloc" if it's called anywhere in reachable bodies
  // (already handled above since alloc appears as "(call $alloc)" in bodies)

  // Emit functions in original declaration order, skipping unreachable ones
  for (let i = 0; i < env.funcNames.length; i++) {
    const fname = env.funcNames[i];
    if (reachable.has(fname)) {
      out += env.funcBodies.get(fname) + "\n";
    }
  }

  // Emit a _start wrapper that calls main then proc_exit.
  // - main returns :i32  → pass it directly as the exit code
  // - main returns void  → exit with 0
  // - main returns other → drop the value, exit with 0
  // Only emit the proc_exit call when proc_exit has been imported (not all
  // programs include wasi_p1 / io).
  const mainResultType = env.funcResultTypes.has("main")
    ? env.funcResultTypes.get("main") : "";
  let hasProcExit = false;
  for (let i = 0; i < env.imports.length; i++) {
    if (env.imports[i].localName == "proc_exit") { hasProcExit = true; break; }
  }
  out += "\n  (; _start wrapper — calls main then proc_exit ;)\n";
  out += "  (func $_start\n";
  out += "    (call $main)\n";
  if (hasProcExit) {
    if (mainResultType == ":i32" || mainResultType == ":ptr") {
      // use main's return value as the exit code directly
      out += "    (call $proc_exit)\n";
    } else {
      if (mainResultType != "" && mainResultType != ":void") {
        out += "    (drop)\n";
      }
      out += "    (call $proc_exit (i32.const 0))\n";
    }
  } else {
    if (mainResultType != "" && mainResultType != ":void") {
      out += "    (drop)\n";
    }
  }
  out += "  )\n";

  out += '\n  (export "_start" (func $_start))\n';

  out += ")\n";
  return out;
}

// ─── Type inference helpers ──────────────────────────────────────────────────

// Normalize a woua type for overload matching.
// :ptr, :u8, and user-defined struct types are heap pointers / i32-backed → treated as :i32.
function normalizeType(t: string): string {
  if (t == ":i32" || t == ":ptr" || t == ":u8") return ":i32";
  if (t == ":i64")                               return ":i64";
  if (t == ":f32")                               return ":f32";
  if (t == ":f64")                               return ":f64";
  if (t == ":v128")                              return ":v128";
  if (isSimdSubtype(t))                          return t; // subtypes match exactly
  if (t.startsWith(":func:"))                    return ":i32"; // function reference is i32
  return ":i32"; // user-defined struct type (pointer)
}

// Copy a locals map (name → type) for use in a new inner scope.
function copyLocals(locals: Map<string, string>): Map<string, string> {
  const copy = new Map<string, string>();
  const keys = locals.keys();
  for (let i = 0; i < keys.length; i++) copy.set(keys[i], locals.get(keys[i]));
  return copy;
}

// Find the matching OpInfo overload for an operator given inferred argument types.
// Exact match (without normalization) wins over normalized match so that
// user-defined overloads for `:*T` types beat built-in primitive overloads.
function resolveOp(name: string, argTypes: Array<string>, env: Env): OpInfo | null {
  if (!env.ops.has(name)) return null;
  const overloads = env.ops.get(name);
  // Pass 1: exact type match (no normalization)
  for (let i = 0; i < overloads.length; i++) {
    const ov = overloads[i];
    if (ov.params.length != argTypes.length) continue;
    let match = true;
    for (let j = 0; j < ov.params.length; j++) {
      if (ov.params[j] != argTypes[j]) { match = false; break; }
    }
    if (match) return ov;
  }
  // Pass 2: normalized match (treats :*T and :ptr as :i32)
  for (let i = 0; i < overloads.length; i++) {
    const ov = overloads[i];
    if (ov.params.length != argTypes.length) continue;
    let match = true;
    for (let j = 0; j < ov.params.length; j++) {
      if (normalizeType(ov.params[j]) != normalizeType(argTypes[j])) {
        match = false;
        break;
      }
    }
    if (match) return ov;
  }
  return overloads.length > 0 ? overloads[0] : null;
}

// Infer the woua type of an expression given the current locals map.
// Returns "" for void expressions (set!, drop, i32.store, struct setters).
function typeOf(node: Node, env: Env, locals: Map<string, string>): string {
  if (node.tag == TAG_INT)    return (node as IntNode).wide   ? ":i64" : ":i32";
  if (node.tag == TAG_FLOAT)  return (node as FloatNode).wide  ? ":f64" : ":f32";
  if (node.tag == TAG_V128)   return ":" + (node as V128Node).laneType;
  if (node.tag == TAG_SYMBOL) {
    const sym = (node as SymbolNode).name;
    if (sym.startsWith("__str:")) return ":str"; // interned string literal
    // Named defstatic — return its declared type
    if (env.statics.has(sym)) {
      const st = env.statics.get(sym);
      if (st.typeName == ":*str" || st.typeName == ":strlit") return ":str";
      return st.typeName; // :*Point, :i32, :bytes, etc.
    }
    // Mutable global variable — checked after locals so that local params/lets
    // with the same name take priority over globals (locals shadow globals).
    if (locals.has(sym)) return locals.get(sym);
    if (env.globals.has(sym)) return env.globals.get(sym).typeName;
    return ":i32";
  }
  if (node.tag == TAG_LIST) {
    const list = node as ListNode;
    if (list.children.length == 0) return "";
    if (list.children[0].tag != TAG_SYMBOL) return ":i32";
    const op = (list.children[0] as SymbolNode).name;
    if (op == "as") return (list.children[1] as SymbolNode).name;
    if (op == "set!" || op == "drop" || op == "i32.store" || op == "i32.store8" || op == "array-set!" || op == "v128.store") return "";
    if (op == "aset!" || op == "aset!!") return ""; // slice element write → void
    if (op.includes("/") && op.endsWith("!")) return ""; // struct setter → void
    if (op == "let") {
      // ── Tuple destructuring ──────────────────────────────────────────────────
      if (list.children[1].tag == TAG_LIST) {
        const pattern = list.children[1] as ListNode;
        let inferredTypes = new Array<string>();
        if (list.children.length > 2 && list.children[2].tag == TAG_LIST) {
          const callList = list.children[2] as ListNode;
          if (callList.children.length > 0 && callList.children[0].tag == TAG_SYMBOL) {
            const fnName = (callList.children[0] as SymbolNode).name;
            if (env.funcTupleResults.has(fnName)) inferredTypes = env.funcTupleResults.get(fnName);
          }
        }
        const pnames = new Array<string>(); const ptypes = new Array<string>();
        parseTuplePattern(pattern, inferredTypes, pnames, ptypes);
        const ext = copyLocals(locals);
        for (let k = 0; k < pnames.length; k++) ext.set(pnames[k], ptypes[k]);
        if (list.children.length <= 3) return "";
        return typeOf(list.children[list.children.length - 1], env, ext);
      }
      // ── Tuple local: (let name (:t1 :t2) val body...) ────────────────────────
      {
        const tlocTypes = extractTupleAnnotation(list, 2);
        if (tlocTypes != null) {
          const tname = (list.children[1] as SymbolNode).name;
          const ext = copyLocals(locals);
          ext.set(tname, "tuple");
          for (let k = 0; k < tlocTypes.length; k++) ext.set(tname + "_" + k.toString(), tlocTypes[k]);
          if (list.children.length <= 3) return "";
          return typeOf(list.children[list.children.length - 1], env, ext);
        }
      }
      // ── Inferred tuple local: (let name (tuple-fn args) body...) ───────────
      if (list.children.length > 2) {
        const iTypes = inferredTupleTypes(list.children[2], env);
        if (iTypes != null) {
          const tname = (list.children[1] as SymbolNode).name;
          const ext = copyLocals(locals);
          ext.set(tname, "tuple");
          for (let k = 0; k < iTypes.length; k++) ext.set(tname + "_" + k.toString(), iTypes[k]);
          if (list.children.length <= 3) return "";
          return typeOf(list.children[list.children.length - 1], env, ext);
        }
      }
      // ── Single binding ────────────────────────────────────────────────────────
      const letName = (list.children[1] as SymbolNode).name;
      let typeAnnot = "";
      let valIdx = 2;
      if (list.children.length > 2 &&
          list.children[2].tag == TAG_SYMBOL &&
          (list.children[2] as SymbolNode).name.startsWith(":")) {
        typeAnnot = (list.children[2] as SymbolNode).name;
        valIdx = 3;
      }
      if (typeAnnot == "") typeAnnot = typeOf(list.children[valIdx], env, locals);
      const letExt = copyLocals(locals);
      letExt.set(letName, typeAnnot);
      return typeOf(list.children[list.children.length - 1], env, letExt);
    }
    if (op == "values") {
      if (list.children.length < 2) return "";
      return typeOf(list.children[list.children.length - 1], env, locals);
    }
    if (op == "progn" || op == "with-arena") {
      if (list.children.length < 2) return "";
      return typeOf(list.children[list.children.length - 1], env, locals);
    }
    if (op == "if" && list.children.length > 2) {
      // Skip any comment nodes to reach the real then-branch.
      let thenIdx = 2;
      while (thenIdx < list.children.length && list.children[thenIdx].tag == TAG_COMMENT) thenIdx++;
      if (thenIdx < list.children.length) return typeOf(list.children[thenIdx], env, locals);
      return "";
    }
    if (op == "while") return ""; // while is always void
    if (op == "fn-ref") return ":i32"; // table index is i32
    if (op == "i64.load") return ":i64";
    if (op == "i64.store") return "";  // void
    if (op == "f32.load") return ":f32";
    if (op == "f32.store") return ""; // void
    if (op == "f64.load") return ":f64";
    if (op == "f64.store") return ""; // void
    // ── SIMD ──────────────────────────────────────────────────────────────────
    if (op == "v128.load")  return ":v128";
    if (op == "v128.store") return "";
    if (op == "v128.const") return ":v128";
    if (op == "i8x16.extract_lane_s" || op == "i8x16.extract_lane_u") return ":i32";
    if (op == "i16x8.extract_lane_s" || op == "i16x8.extract_lane_u") return ":i32";
    if (op == "i32x4.extract_lane") return ":i32";
    if (op == "i64x2.extract_lane") return ":i64";
    if (op == "f32x4.extract_lane") return ":f32";
    if (op == "f64x2.extract_lane") return ":f64";
    // Generic type-dispatched extract_lane / replace_lane
    if (op == "extract_lane" || op == "extract_lane_s" || op == "extract_lane_u") {
      const vecT = typeOf(list.children[2], env, locals);
      if (vecT == ":i64x2") return ":i64";
      if (vecT == ":f32x4") return ":f32";
      if (vecT == ":f64x2") return ":f64";
      return ":i32"; // :i8x16, :i16x8, :i32x4
    }
    if (op == "replace_lane") return typeOf(list.children[2], env, locals);
    if (op == "i8x16.replace_lane")  return ":i8x16";
    if (op == "i16x8.replace_lane")  return ":i16x8";
    if (op == "i32x4.replace_lane")  return ":i32x4";
    if (op == "i64x2.replace_lane")  return ":i64x2";
    if (op == "f32x4.replace_lane")  return ":f32x4";
    if (op == "f64x2.replace_lane")  return ":f64x2";
    if (op == "array-ref") {
      if (list.children.length > 1 && list.children[1].tag == TAG_SYMBOL)
        return (list.children[1] as SymbolNode).name; // :T
      return ":i32";
    }
    // ── Typed slice ops ──────────────────────────────────────────────────────
    if (op == "aref" || op == "aref!") {
      const bufType = typeOf(list.children[1], env, locals);
      const et = sliceElemType(bufType);
      // Struct element type: aref returns :*StructType (address of the slot)
      if (isValueTypeAnnot(et, env)) return ":*" + et.slice(1); // :Vec2 → :*Vec2
      return et; // :i32[] → :i32, :f64[16] → :f64
    }
    if (op == "alen") return ":i32";
    if (env.ops.has(op)) {
      const argTypes = new Array<string>();
      for (let i = 1; i < list.children.length; i++) {
        argTypes.push(typeOf(list.children[i], env, locals));
      }
      const resolved = resolveOp(op, argTypes, env);
      return resolved != null ? resolved.result : ":i32";
    }
    // struct getter or tuple-local accessor (TypeName/field ptr) or (name/N) ──
    if (op.includes("/")) {
      const slash = op.indexOf("/");
      const typeName = op.substring(0, slash);
      const field = op.substring(slash + 1);
      // Tuple-local accessor: (pair/0) — prefix is a "tuple" marker in locals
      if (locals.has(typeName) && locals.get(typeName) == "tuple") {
        const slotKey = typeName + "_" + field;
        return locals.has(slotKey) ? locals.get(slotKey) : ":i32";
      }
      // :str fat-pointer accessor: str/ptr → :ptr, str/len → :i32, setters → void
      if (typeName == "str") {
        if (field.endsWith("!")) return "";
        return field == "ptr" ? ":ptr" : ":i32";
      }
      if (env.types.has(typeName)) {
        const typeInfo = env.types.get(typeName);
        if (typeInfo.fields.has(field)) return typeInfo.fields.get(field).typeName;
      }
      return ":i32";
    }
    // First-class function call via a function-typed local (call_indirect)
    if (locals.has(op) && locals.get(op).startsWith(":func:")) {
      const typeKey = locals.get(op).slice(6);
      if (env.funcTypesByKey.has(typeKey)) {
        const ftRes = env.funcTypesByKey.get(typeKey).results;
        return ftRes.length == 1 ? ftRes[0] : "";
      }
      return ":i32";
    }
    // Function call (imported or user-defined) — look up return type
    return funcResultType(op, env);
  }
  return ":i32";
}

// Return the tuple type list if children[pos] of `list` is a tuple return
// annotation — a non-empty ListNode where every element is a ':xxx' symbol.
// Returns null otherwise.
function extractTupleAnnotation(list: ListNode, pos: i32): Array<string> | null {
  if (pos >= list.children.length) return null;
  const child = list.children[pos];
  if (child.tag != TAG_LIST) return null;
  const inner = child as ListNode;
  if (inner.children.length == 0) return null;
  for (let k = 0; k < inner.children.length; k++) {
    if (inner.children[k].tag != TAG_SYMBOL) return null;
    if (!(inner.children[k] as SymbolNode).name.startsWith(":")) return null;
  }
  const types = new Array<string>();
  for (let k = 0; k < inner.children.length; k++) {
    types.push((inner.children[k] as SymbolNode).name);
  }
  return types;
}

// ── Arena helpers ───────────────────────────────────────────────────────────
// These emit raw WAT for arena-push / arena-pop without going through macro
// expansion.  Used by (with-arena ...) and (defn ... :arena ...).

function arenaStackAddr(env: Env): i32 {
  if (!env.statics.has("ARENA-STACK")) {
    env.errors.push("with-arena / :arena requires (include memory) — ARENA-STACK static not found");
    return 0;
  }
  return env.statics.get("ARENA-STACK").ptr;
}

function emitArenaPushWat(addr: i32): string {
  const a = addr.toString();
  return "(i32.store (i32.add (i32.const " + a + ") (i32.mul (global.get $arena-depth) (i32.const 4))) (global.get $heap-ptr))\n    "
       + "(global.set $arena-depth (i32.add (global.get $arena-depth) (i32.const 1)))";
}

function emitArenaPopWat(addr: i32): string {
  const a = addr.toString();
  return "(global.set $arena-depth (i32.sub (global.get $arena-depth) (i32.const 1)))\n    "
       + "(global.set $heap-ptr (i32.load (i32.add (i32.const " + a + ") (i32.mul (global.get $arena-depth) (i32.const 4)))))";
}

// Returns the explicit scalar return type annotation at children[3] of a defn
// list (e.g. ":i32", ":void", ":f32"), or null if not present.
// Mutually exclusive with extractTupleAnnotation — call that first.
function extractScalarReturnAnnotation(list: ListNode): string | null {
  if (list.children.length <= 3) return null;
  const child = list.children[3];
  if (child.tag != TAG_SYMBOL) return null;
  const sym = (child as SymbolNode).name;
  if (!sym.startsWith(":")) return null;
  return sym;
}

// Look up the return type of a named function (import or user-defined).
function funcResultType(name: string, env: Env): string {
  for (let i = 0; i < env.imports.length; i++) {
    if (env.imports[i].localName == name) return env.imports[i].result;
  }
  if (env.funcResultTypes.has(name)) return env.funcResultTypes.get(name);
  return ":i32"; // fallback
}

// ─── (defn name (params...) body...) ─────────────────────────────────────────

// Infer the result type of a defn without emitting any WAT.
// Used by the pre-scan pass so recursive/forward calls resolve correctly.
// Returns "" for tuple-annotated functions (handled separately).
function inferDefnResultType(list: ListNode, env: Env): string {
  const tupleTypes = extractTupleAnnotation(list, 3);
  if (tupleTypes != null) return ""; // tuple return, handled by pass 1

  // Explicit scalar return annotation overrides inference.
  const scalarAnnot = extractScalarReturnAnnotation(list);
  if (scalarAnnot != null) {
    return scalarAnnot == ":void" ? "" : scalarAnnot;
  }

  const bodyStart = 3;
  // Skip optional :arena modifier so type inference reaches the actual body.
  let bodyStartInfer = bodyStart;
  if (bodyStartInfer < list.children.length) {
    const maybeArena = list.children[bodyStartInfer];
    if (maybeArena.tag == TAG_SYMBOL && (maybeArena as SymbolNode).name == ":arena") bodyStartInfer++;
  }
  const params = list.children[2] as ListNode;
  const paramLocals = new Map<string, string>();
  for (let i = 0; i < params.children.length; i++) {
    const pname = (params.children[i] as SymbolNode).name;
    let ptype = ":i32";
    if (i + 1 < params.children.length) {
      const next = params.children[i + 1];
      if (next.tag == TAG_SYMBOL && (next as SymbolNode).name.startsWith(":")) {
        ptype = (next as SymbolNode).name;
        i++;
      } else if (isFuncTypeNode(next)) {
        const ft = parseFuncTypeNode(next as ListNode);
        ptype = ":func:" + registerFuncTypeIfNeeded(ft.params, ft.results, env);
        i++;
      }
    }
    paramLocals.set(pname, ptype);
    if (ptype == ":str") { paramLocals.set(pname + "_ptr", ":i32"); paramLocals.set(pname + "_len", ":i32"); }
    else if (isValueTypeAnnot(ptype, env)) {
      collectValueTypeSubLocals(pname, valueTypeName(ptype), env, paramLocals);
    }
  }
  if (list.children.length <= bodyStartInfer) return "";
  const letLocals = new Map<string, string>();
  for (let i = bodyStartInfer; i < list.children.length; i++) {
    collectLetLocals(list.children[i], env, paramLocals, letLocals);
  }
  const locals = copyLocals(paramLocals);
  const letKeys = letLocals.keys();
  for (let k = 0; k < letKeys.length; k++) locals.set(letKeys[k], letLocals.get(letKeys[k]));
  return typeOf(list.children[list.children.length - 1], env, locals);
}

// Walk an expression tree and collect all (let name :type ...) bindings into
// the letLocals map.  Params are excluded (they are not let-bindings).
function collectLetLocals(node: Node, env: Env, paramLocals: Map<string, string>,
                          letLocals: Map<string, string>): void {
  if (node.tag != TAG_LIST) return;
  const list = node as ListNode;
  if (list.children.length == 0) return;
  const head = list.children[0];
  if (head.tag != TAG_SYMBOL) return;
  const op = (head as SymbolNode).name;

  if (op == "let") {
    // ── Tuple destructuring: (let (a [:T] b [:T]...) (tuple-fn ...) body...) ─
    if (list.children[1].tag == TAG_LIST) {
      const pattern = list.children[1] as ListNode;
      let inferredTypes = new Array<string>();
      if (list.children.length > 2 && list.children[2].tag == TAG_LIST) {
        const callList = list.children[2] as ListNode;
        if (callList.children.length > 0 && callList.children[0].tag == TAG_SYMBOL) {
          const fnName = (callList.children[0] as SymbolNode).name;
          if (env.funcTupleResults.has(fnName)) inferredTypes = env.funcTupleResults.get(fnName);
        }
      }
      const pnames = new Array<string>(); const ptypes = new Array<string>();
      parseTuplePattern(pattern, inferredTypes, pnames, ptypes);
      for (let k = 0; k < pnames.length; k++) {
        if (!letLocals.has(pnames[k])) letLocals.set(pnames[k], ptypes[k]);
      }
      for (let i = 3; i < list.children.length; i++) {
        collectLetLocals(list.children[i], env, paramLocals, letLocals);
      }
      return;
    }
    // ── Tuple local: (let name (:t1 :t2...) val body...) ────────────────────
    {
      const maybeTypes = extractTupleAnnotation(list, 2);
      if (maybeTypes != null) {
        const tname = (list.children[1] as SymbolNode).name;
        for (let k = 0; k < maybeTypes.length; k++) {
          const slot = tname + "_" + k.toString();
          if (!letLocals.has(slot)) letLocals.set(slot, maybeTypes[k]);
        }
        // tname itself is a marker — not a real WAT local; skip adding to letLocals
        for (let i = 3; i < list.children.length; i++) {
          collectLetLocals(list.children[i], env, paramLocals, letLocals);
        }
        return;
      }
    }
    // ── Inferred tuple local: (let name (tuple-fn args) body...) ───────────
    if (list.children.length > 2) {
      const iTypes = inferredTupleTypes(list.children[2], env);
      if (iTypes != null) {
        const tname = (list.children[1] as SymbolNode).name;
        for (let k = 0; k < iTypes.length; k++) {
          const slot = tname + "_" + k.toString();
          if (!letLocals.has(slot)) letLocals.set(slot, iTypes[k]);
        }
        for (let i = 3; i < list.children.length; i++) {
          collectLetLocals(list.children[i], env, paramLocals, letLocals);
        }
        return;
      }
    }
    // ── Function-typed local: (let name (:P -> :R) val body...) ─────────────
    if (list.children.length > 3 && isFuncTypeNode(list.children[2])) {
      const ft = parseFuncTypeNode(list.children[2] as ListNode);
      const typeKey = registerFuncTypeIfNeeded(ft.params, ft.results, env);
      const letName = (list.children[1] as SymbolNode).name;
      if (!letLocals.has(letName)) letLocals.set(letName, ":func:" + typeKey);
      for (let i = 3; i < list.children.length; i++) {
        collectLetLocals(list.children[i], env, paramLocals, letLocals);
      }
      return;
    }
    // ── Single binding ────────────────────────────────────────────────────────
    if (list.children[1].tag != TAG_SYMBOL) {
      // Malformed let (children[1] is not a symbol name); recurse into remaining children
      for (let i = 2; i < list.children.length; i++) {
        collectLetLocals(list.children[i], env, paramLocals, letLocals);
      }
      return;
    }
    const letName = (list.children[1] as SymbolNode).name;
    let typeAnnot = "";
    let valIdx    = 2;
    if (list.children[2].tag == TAG_SYMBOL &&
        (list.children[2] as SymbolNode).name.startsWith(":")) {
      typeAnnot = (list.children[2] as SymbolNode).name;
      valIdx    = 3;
    }
    const allLocals = copyLocals(paramLocals);
    const keys = letLocals.keys();
    for (let k = 0; k < keys.length; k++) allLocals.set(keys[k], letLocals.get(keys[k]));
    if (typeAnnot == "") typeAnnot = typeOf(list.children[valIdx], env, allLocals);
    if (!letLocals.has(letName)) {
      if (typeAnnot == ":str") {
        // :str locals expand to two WAT locals: name_ptr and name_len.
        letLocals.set(letName, ":str"); // marker (not a real WAT local)
        letLocals.set(letName + "_ptr", ":i32");
        letLocals.set(letName + "_len", ":i32");
      } else if (isSliceType(typeAnnot)) {
        // :T[] and :T[N] locals expand to two WAT locals: name_ptr and name_len.
        letLocals.set(letName, typeAnnot); // marker (not a real WAT local)
        letLocals.set(letName + "_ptr", ":i32");
        letLocals.set(letName + "_len", ":i32");
      } else if (isValueTypeAnnot(typeAnnot, env)) {
        // Value-type struct: marker + recursively expand all leaf field locals.
        letLocals.set(letName, typeAnnot); // marker (not a real WAT local)
        collectValueTypeSubLocals(letName, valueTypeName(typeAnnot), env, letLocals);
      } else if (isRefTypeAnnot(typeAnnot, env)) {
        // Ref-type struct: preserve the :*T annotation for operator dispatch.
        letLocals.set(letName, typeAnnot);
      } else {
        letLocals.set(letName, typeAnnot);
      }
    }
    for (let i = valIdx; i < list.children.length; i++) {
      collectLetLocals(list.children[i], env, paramLocals, letLocals);
    }
    return;
  }

  // Recurse into all children for other forms
  for (let i = 0; i < list.children.length; i++) {
    collectLetLocals(list.children[i], env, paramLocals, letLocals);
  }
}

function codegenDefn(list: ListNode, env: Env): string {
  // list = (defn  name  (params...)  [rettype]  body...)
  //          [0]  [1]     [2]           [3?]     [3..] or [4..]
  // rettype is a tuple annotation (:t1 :t2 ...) — a ListNode of type keywords.
  const name   = (list.children[1] as SymbolNode).name;
  const params = list.children[2] as ListNode;

  // Detect optional tuple or scalar return annotation at children[3]
  const tupleTypes = extractTupleAnnotation(list, 3);
  const scalarAnnot = tupleTypes == null ? extractScalarReturnAnnotation(list) : null;
  let bodyStart  = (tupleTypes != null || scalarAnnot != null) ? 4 : 3;

  // Detect optional :arena modifier — the first non-annotation symbol after params.
  // Syntax: (defn name (params) [:rettype] :arena body...)
  let isArenaDefn = false;
  if (bodyStart < list.children.length) {
    const maybeArena = list.children[bodyStart];
    if (maybeArena.tag == TAG_SYMBOL && (maybeArena as SymbolNode).name == ":arena") {
      isArenaDefn = true;
      bodyStart++;
    }
  }

  // Build locals map: param name → type.
  // Syntax: (name :Type name :Type ...) — type annotation is optional, defaults to :i32.
  const paramLocals = new Map<string, string>();
  const paramNames  = new Array<string>();
  for (let i = 0; i < params.children.length; i++) {
    const pname = (params.children[i] as SymbolNode).name;
    paramNames.push(pname);
    // Peek at next child: if it starts with ':', it's a type annotation.
    // If it's a function type like (:i32 -> :i32), treat it as a func-ref param.
    let ptype = ":i32";
    if (i + 1 < params.children.length) {
      const next = params.children[i + 1];
      if (next.tag == TAG_SYMBOL && (next as SymbolNode).name.startsWith(":")) {
        ptype = (next as SymbolNode).name;
        i++; // consume the type token
      } else if (isFuncTypeNode(next)) {
        const ft = parseFuncTypeNode(next as ListNode);
        ptype = ":func:" + registerFuncTypeIfNeeded(ft.params, ft.results, env);
        i++; // consume the type annotation
      }
    }
    paramLocals.set(pname, ptype);
  }

  // Collect all let-bindings from the body so we can hoist their (local ...)
  // declarations before any instructions (WAT requires this).
  const letLocals = new Map<string, string>();
  for (let i = bodyStart; i < list.children.length; i++) {
    collectLetLocals(list.children[i], env, paramLocals, letLocals);
  }

  // Full locals map used for type inference during codegen
  const locals = copyLocals(paramLocals);
  const letKeys = letLocals.keys();
  for (let k = 0; k < letKeys.length; k++) locals.set(letKeys[k], letLocals.get(letKeys[k]));
  // Pre-populate _ptr/_len sub-locals for :str params so the fat-pointer
  // accessor (str/ptr / str/len) can detect them in the body codegen.
  for (let i = 0; i < paramNames.length; i++) {
    if (paramLocals.get(paramNames[i]) == ":str") {
      locals.set(paramNames[i] + "_ptr", ":i32");
      locals.set(paramNames[i] + "_len", ":i32");
    } else if (isSliceType(paramLocals.get(paramNames[i]))) {
      locals.set(paramNames[i] + "_ptr", ":i32");
      locals.set(paramNames[i] + "_len", ":i32");
    }
  }

  // Build param declarations
  // :str params expand to two WAT params: $name_ptr i32 and $name_len i32.
  let paramDecls = "";
  for (let i = 0; i < paramNames.length; i++) {
    const pname = paramNames[i];
    const ptype = paramLocals.get(pname);
    if (ptype == ":str") {
      paramDecls += " (param $" + pname + "_ptr i32) (param $" + pname + "_len i32)";
      // Make _ptr and _len available in paramLocals for downstream type inference.
      paramLocals.set(pname + "_ptr", ":i32");
      paramLocals.set(pname + "_len", ":i32");
    } else if (isSliceType(ptype)) {
      // :T[] params expand to two WAT params: $name_ptr i32 and $name_len i32.
      paramDecls += " (param $" + pname + "_ptr i32) (param $" + pname + "_len i32)";
      paramLocals.set(pname + "_ptr", ":i32");
      paramLocals.set(pname + "_len", ":i32");
    } else if (isValueTypeAnnot(ptype, env)) {
      // Value-type struct param → one WAT param per leaf field (recursively expanded)
      paramDecls += emitValueTypeParamDecls(pname, valueTypeName(ptype), env);
      collectValueTypeSubLocals(pname, valueTypeName(ptype), env, paramLocals);
    } else if (isRefTypeAnnot(ptype, env)) {
      // Ref-type struct param → single i32 (heap pointer); preserve :*T in locals for dispatch
      paramDecls += " (param $" + pname + " i32)";
      paramLocals.set(pname, ptype); // overwrite :*T entry (stays :*T, not :i32)
    } else {
      paramDecls += " (param $" + pname + " " + watType(ptype) + ")";
    }
  }

  // Determine return type declaration
  let resultDecl = "";
  if (tupleTypes != null) {
    // Explicit tuple return — emit (result t1 t2 ...)
    let rparts = "";
    for (let k = 0; k < tupleTypes.length; k++) rparts += " " + watType(tupleTypes[k]);
    resultDecl = " (result" + rparts + ")";
  } else if (scalarAnnot != null) {
    if (scalarAnnot == ":str") {
      resultDecl = " (result i32 i32)"; // :str = fat-pointer (ptr, len)
    } else if (isSliceType(scalarAnnot)) {
      resultDecl = " (result i32 i32)"; // :T[] = fat-pointer slice (ptr, len)
    } else if (isValueTypeAnnot(scalarAnnot, env)) {
      // Value-type struct return → multi-value of leaf field types (recursive)
      const vtN = valueTypeName(scalarAnnot);
      const leafTypes = valueTypeLeafTypes(vtN, env);
      let rparts = "";
      for (let fi = 0; fi < leafTypes.length; fi++) rparts += " " + watType(leafTypes[fi]);
      resultDecl = " (result" + rparts + ")";
    } else if (scalarAnnot != ":void") {
      resultDecl = " (result " + watType(scalarAnnot) + ")";
      // Mismatch check: warn when both declared and inferred are non-empty and differ.
      const inferred = list.children.length > bodyStart
        ? typeOf(list.children[list.children.length - 1], env, locals)
        : "";
      if (inferred != "" && normalizeType(inferred) != normalizeType(scalarAnnot)) {
        env.errors.push("defn " + name + ": declared return type " + scalarAnnot
          + " but body returns " + inferred);
      }
    }
    // :void → resultDecl stays ""
  } else {
    const resultType = list.children.length > bodyStart
      ? typeOf(list.children[list.children.length - 1], env, locals)
      : "";
    if (resultType != "") resultDecl = " (result " + watType(resultType) + ")";
  }

  // Hoisted local declarations (all let-bindings at the top of the func body)
  // :str marker locals are skipped here — their _ptr/_len counterparts are real WAT locals.
  let localDecls = "";
  for (let k = 0; k < letKeys.length; k++) {
    const lt = letLocals.get(letKeys[k]);
    if (lt == ":str") continue; // skip marker; _ptr and _len are emitted separately
    if (isSliceType(lt)) continue; // skip :T[] / :T[N] marker; _ptr and _len emitted separately
    if (isValueTypeAnnot(lt, env)) continue; // skip marker; field locals are emitted separately
    localDecls += "\n    " + watLocalDecl(letKeys[k], watType(lt));
  }

  // Codegen body expressions (let will emit only local.set, not local decl)
  let bodyWat = "";
  if (isArenaDefn) {
    const arAddr = arenaStackAddr(env);
    bodyWat += "\n    " + emitArenaPushWat(arAddr);
  }
  for (let i = bodyStart; i < list.children.length; i++) {
    const isTailPos = i == list.children.length - 1;
    bodyWat += "\n    " + codegenExpr(list.children[i], env, locals, isTailPos);
  }
  if (isArenaDefn) {
    const arAddr = arenaStackAddr(env);
    bodyWat += "\n    " + emitArenaPopWat(arAddr);
  }

  return "  (; defn " + name + " ;)\n  (func $" + name + paramDecls + resultDecl
       + localDecls
       + bodyWat
       + "\n  )";
}

// ─── Value-type struct helpers ────────────────────────────────────────────────

// Return the flat list of WAT type keywords for a value-type struct (leaf scalars only).
// Recursively expands embedded struct fields.
// Example: valueTypeLeafTypes("Pair", env) where Pair has (a :Vec2)(b :Vec2) → [":i32",":i32",":i32",":i32"]
function valueTypeLeafTypes(typeName: string, env: Env): Array<string> {
  const result = new Array<string>();
  if (!env.types.has(typeName)) return result;
  const typeInfo = env.types.get(typeName);
  for (let fi = 0; fi < typeInfo.fieldNames.length; fi++) {
    const ft = typeInfo.fields.get(typeInfo.fieldNames[fi]).typeName;
    if (!ft.startsWith(":*") && ft.startsWith(":") && env.types.has(ft.slice(1))) {
      const sub = valueTypeLeafTypes(ft.slice(1), env);
      for (let k = 0; k < sub.length; k++) result.push(sub[k]);
    } else {
      result.push(ft);
    }
  }
  return result;
}

// Return flat list of WAT local names for a value-type struct (leaf scalars only).
// Recursively expands embedded struct fields.
// Example: valueTypeLeafLocals("p", "Pair", env) → ["p_a_x","p_a_y","p_b_x","p_b_y"]
function valueTypeLeafLocals(prefix: string, typeName: string, env: Env): Array<string> {
  const result = new Array<string>();
  if (!env.types.has(typeName)) return result;
  const typeInfo = env.types.get(typeName);
  for (let fi = 0; fi < typeInfo.fieldNames.length; fi++) {
    const fname = typeInfo.fieldNames[fi];
    const ft    = typeInfo.fields.get(fname).typeName;
    const slot  = prefix + "_" + fname;
    if (!ft.startsWith(":*") && ft.startsWith(":") && env.types.has(ft.slice(1))) {
      const sub = valueTypeLeafLocals(slot, ft.slice(1), env);
      for (let k = 0; k < sub.length; k++) result.push(sub[k]);
    } else {
      result.push(slot);
    }
  }
  return result;
}

// Add all locals (marker + leaf scalars) for a value-type struct to a locals map.
// Sets markers for nested struct fields, leaf scalars for primitives.
function collectValueTypeSubLocals(prefix: string, typeName: string, env: Env,
                                    locals: Map<string, string>): void {
  if (!env.types.has(typeName)) return;
  const typeInfo = env.types.get(typeName);
  for (let fi = 0; fi < typeInfo.fieldNames.length; fi++) {
    const fname = typeInfo.fieldNames[fi];
    const ft    = typeInfo.fields.get(fname).typeName;
    const slot  = prefix + "_" + fname;
    if (!locals.has(slot)) {
      locals.set(slot, ft); // marker or scalar
      if (!ft.startsWith(":*") && ft.startsWith(":") && env.types.has(ft.slice(1))) {
        collectValueTypeSubLocals(slot, ft.slice(1), env, locals);
      }
    }
  }
}

// Emit WAT (param ...) declarations for a value-type struct parameter.
// Recursively expands embedded struct fields to leaf scalars.
function emitValueTypeParamDecls(prefix: string, typeName: string, env: Env): string {
  if (!env.types.has(typeName)) return "";
  const typeInfo = env.types.get(typeName);
  let out = "";
  for (let fi = 0; fi < typeInfo.fieldNames.length; fi++) {
    const fname = typeInfo.fieldNames[fi];
    const ft    = typeInfo.fields.get(fname).typeName;
    const slot  = prefix + "_" + fname;
    if (!ft.startsWith(":*") && ft.startsWith(":") && env.types.has(ft.slice(1))) {
      out += emitValueTypeParamDecls(slot, ft.slice(1), env);
    } else {
      out += " (param $" + slot + " " + watType(ft) + ")";
    }
  }
  return out;
}

// Recursively emit WAT store instructions for one field of a ref-type struct constructor.
// Handles embedded struct fields by recursing into their constructor args.
function emitStructFieldStores(basePtr: string, absOffset: i32, argNode: Node,
                                ftype: string, env: Env, locals: Map<string, string>): string {
  const ptrExpr = absOffset == 0
    ? basePtr
    : "(i32.add " + basePtr + " (i32.const " + absOffset.toString() + "))";
  if (ftype == ":u8")
    return "\n    (i32.store8 " + ptrExpr + " " + codegenExpr(argNode, env, locals, false) + ")";
  if (ftype == ":i32" || ftype == ":ptr" || ftype.startsWith(":*"))
    return "\n    (i32.store " + ptrExpr + " " + codegenExpr(argNode, env, locals, false) + ")";
  if (ftype == ":f32")
    return "\n    (f32.store " + ptrExpr + " " + codegenExpr(argNode, env, locals, false) + ")";
  if (ftype == ":i64")
    return "\n    (i64.store " + ptrExpr + " " + codegenExpr(argNode, env, locals, false) + ")";
  if (ftype == ":f64")
    return "\n    (f64.store " + ptrExpr + " " + codegenExpr(argNode, env, locals, false) + ")";
  // Embedded struct: recurse into constructor args
  const innerTypeName = ftype.startsWith(":") ? ftype.slice(1) : ftype;
  if (env.types.has(innerTypeName) && argNode.tag == TAG_LIST) {
    const argList = argNode as ListNode;
    if (argList.children.length > 0 && argList.children[0].tag == TAG_SYMBOL &&
        (argList.children[0] as SymbolNode).name == innerTypeName) {
      const innerInfo = env.types.get(innerTypeName);
      let out = "";
      for (let fi = 0; fi < innerInfo.fieldNames.length; fi++) {
        const fname = innerInfo.fieldNames[fi];
        const innerField = innerInfo.fields.get(fname);
        out += emitStructFieldStores(basePtr, absOffset + innerField.offset,
                                     argList.children[fi + 1], innerField.typeName, env, locals);
      }
      return out;
    }
  }
  return "\n    ;; ERROR: unsupported field type for store: " + ftype;
}

// ─── Expression codegen ───────────────────────────────────────────────────────

// If `node` is a call to a tuple-returning function, return its declared types.
// Returns null for anything else.
function inferredTupleTypes(node: Node, env: Env): Array<string> | null {
  if (node.tag != TAG_LIST) return null;
  const lst = node as ListNode;
  if (lst.children.length == 0 || lst.children[0].tag != TAG_SYMBOL) return null;
  const fname = (lst.children[0] as SymbolNode).name;
  if (!env.funcTupleResults.has(fname)) return null;
  return env.funcTupleResults.get(fname);
}

// Parse a tuple destructuring pattern `(name [:type] name [:type] ...)` into
// parallel arrays of names and types.  When no type annotation is present for
// a slot, falls back to `inferredTypes[slot]` if available, then `:i32`.
function parseTuplePattern(pattern: ListNode, inferredTypes: Array<string>,
                           names: Array<string>, types: Array<string>): void {
  let slot: i32 = 0;
  let k: i32 = 0;
  while (k < pattern.children.length) {
    const child = pattern.children[k];
    if (child.tag != TAG_SYMBOL) { k++; continue; }
    const sym = (child as SymbolNode).name;
    if (sym.startsWith(":")) { k++; continue; } // skip stray type token
    names.push(sym);
    k++;
    // Check for inline type annotation
    let t = slot < inferredTypes.length ? inferredTypes[slot] : ":i32";
    if (k < pattern.children.length && pattern.children[k].tag == TAG_SYMBOL &&
        (pattern.children[k] as SymbolNode).name.startsWith(":")) {
      t = (pattern.children[k] as SymbolNode).name;
      k++;
    }
    types.push(t);
    slot++;
  }
}

// Compute the WAT (result ...) declaration string for an `if` branch expression.
// For (values e1..en), returns "t1 t2 ... tn" (space-separated WAT types).
// For any other expression, returns the single WAT type or "" for void.
function ifResultDecl(node: Node, env: Env, locals: Map<string, string>): string {
  if (node.tag == TAG_LIST) {
    const lst = node as ListNode;
    if (lst.children.length > 0 && lst.children[0].tag == TAG_SYMBOL &&
        (lst.children[0] as SymbolNode).name == "values") {
      let parts = "";
      for (let i = 1; i < lst.children.length; i++) {
        if (parts.length > 0) parts += " ";
        parts += watType(typeOf(lst.children[i], env, locals));
      }
      return parts;
    }
  }
  const t = typeOf(node, env, locals);
  if (t == ":str") return "i32 i32"; // :str is a fat-pointer (ptr, len) — two i32s
  return t != "" ? watType(t) : "";
}

function codegenExpr(node: Node, env: Env, locals: Map<string, string>, emitTC: i32): string {

  // Source comment — emit as WAT block comment
  if (node.tag == TAG_COMMENT) {
    return "(; " + (node as CommentNode).text + " ;)";
  }

  // Integer literal
  if (node.tag == TAG_INT) {
    const inode = node as IntNode;
    return inode.wide
      ? watI64Const(inode.value)
      : watI32Const(i32(inode.value));
  }

  // Float literal
  if (node.tag == TAG_FLOAT) {
    const fnode = node as FloatNode;
    return fnode.wide
      ? watF64Const(f64(fnode.value))
      : watF32Const(f32(fnode.value));
  }

  // SIMD vector literal: 1:2:3:4i32x4 → (v128.const i32x4 1 2 3 4)
  if (node.tag == TAG_V128) {
    const vn = node as V128Node;
    const floatLanes = vn.laneType.charAt(0) == "f";
    let out = "(v128.const " + vn.laneType;
    for (let i = 0; i < vn.values.length; i++) {
      const v = vn.values[i];
      if (floatLanes) {
        // Emit as float — ensure decimal point is present
        const s = v.toString();
        out += " " + (s.indexOf(".") >= 0 || s.indexOf("e") >= 0 ? s : s + ".0");
      } else {
        out += " " + i64(v).toString();
      }
    }
    return out + ")";
  }

  // Symbol — local variable reference, global variable, or interned string literal
  if (node.tag == TAG_SYMBOL) {
    const sym = (node as SymbolNode).name;
    // Interned string literal __str:xxx → two compile-time constants (ptr, len)
    if (sym.startsWith("__str:") && env.statics.has(sym)) {
      const info = env.statics.get(sym);
      return "(i32.const " + info.ptr.toString() + ") (i32.const " + info.len.toString() + ")";
    }
    // Named defstatic — emit its address or value
    if (env.statics.has(sym)) {
      const info = env.statics.get(sym);
      if (info.typeName == ":*str") {
        // :*str statics have an 8-byte header; raw bytes start at hdrPtr+8
        return "(i32.const " + (info.ptr + 8).toString() + ") (i32.const " + info.len.toString() + ")";
      }
      if (info.typeName == ":strlit") {
        // inline interned literal — ptr IS the bytes directly
        return "(i32.const " + info.ptr.toString() + ") (i32.const " + info.len.toString() + ")";
      }
      // Any other static (struct pointer, scalar) — push its address as i32
      // Exception: :T[N] statics used as :T[] fat-pointer args → push (ptr, len)
      if (isAllocSliceType(info.typeName)) {
        const slb = info.typeName.lastIndexOf("[");
        const nStr = info.typeName.slice(slb + 1, info.typeName.length - 1);
        return "(i32.const " + info.ptr.toString() + ") (i32.const " + nStr + ")";
      }
      return "(i32.const " + info.ptr.toString() + ")";
    }
    // Mutable global variable
    if (env.globals.has(sym)) return "(global.get $" + sym + ")";
    // :str local → push two values (ptr, len)
    if (locals.has(sym) && locals.get(sym) == ":str") {
      return "(local.get $" + sym + "_ptr) (local.get $" + sym + "_len)";
    }
    // :T[] / :T[N] local → push two values (ptr, len) just like :str
    if (locals.has(sym) && isSliceType(locals.get(sym))) {
      return "(local.get $" + sym + "_ptr) (local.get $" + sym + "_len)";
    }
    // Value-type struct local → push all field values (used when passing as arg or returning)
    if (locals.has(sym) && isValueTypeAnnot(locals.get(sym), env)) {
      const vtN = valueTypeName(locals.get(sym));
      const vtI = env.types.get(vtN);
      let out = "";
      for (let fi = 0; fi < vtI.fieldNames.length; fi++) {
        if (out.length > 0) out += " ";
        out += "(local.get $" + sym + "_" + vtI.fieldNames[fi] + ")";
      }
      return out;
    }
    return watLocalGet(sym);
  }

  // List — call or special form
  if (node.tag == TAG_LIST) {
    return codegenList(node as ListNode, env, locals, emitTC);
  }

  return ";; ERROR: unknown node tag " + node.tag.toString();
}

function codegenList(list: ListNode, env: Env, locals: Map<string, string>, emitTC: i32): string {
  if (list.children.length == 0) return "";

  const head = list.children[0];
  if (head.tag != TAG_SYMBOL) {
    return ";; ERROR: first element of list must be a symbol";
  }
  const op = (head as SymbolNode).name;

  // ── (as :Type expr) — type cast ───────────────────────────────────────────
  // Pointer/struct casts (→ :i32) and same-type casts are no-ops in WAT.
  // Numeric conversions emit the appropriate WAT conversion instruction.
  if (op == "as") {
    const targetType = (list.children[1] as SymbolNode).name;
    const inner      = list.children[2];
    const srcType    = typeOf(inner, env, locals);
    const innerWat   = codegenExpr(inner, env, locals, false);

    // :*T[] → :T[]: cast a pointer-to-slice-header to a fat-pointer slice.
    // Loads {ptr, len} from the header at the given address.
    if (isPtrSliceType(srcType) && isSliceType(targetType)) {
      // Duplicate the inner expression only when it is pure (no side effects).
      if (isPureWat(innerWat))
        return "(i32.load " + innerWat + ") (i32.load (i32.add " + innerWat + " (i32.const 4)))";
      return ";; ERROR: as :T[]: source expression has side effects — bind to a local first";
    }

    // i32 → i64
    if ((srcType == ":i32" || srcType == ":ptr") && targetType == ":i64")
      return "(i64.extend_i32_s " + innerWat + ")";
    // i64 → i32
    if (srcType == ":i64" && (targetType == ":i32" || targetType == ":ptr"))
      return "(i32.wrap_i64 " + innerWat + ")";
    // i32 → f32
    if ((srcType == ":i32" || srcType == ":ptr") && targetType == ":f32")
      return "(f32.convert_i32_s " + innerWat + ")";
    // i32 → f64
    if ((srcType == ":i32" || srcType == ":ptr") && targetType == ":f64")
      return "(f64.convert_i32_s " + innerWat + ")";
    // f32 → i32
    if (srcType == ":f32" && (targetType == ":i32" || targetType == ":ptr"))
      return "(i32.trunc_f32_s " + innerWat + ")";
    // f64 → i32
    if (srcType == ":f64" && (targetType == ":i32" || targetType == ":ptr"))
      return "(i32.trunc_f64_s " + innerWat + ")";
    // f32 → f64
    if (srcType == ":f32" && targetType == ":f64")
      return "(f64.promote_f32 " + innerWat + ")";
    // f64 → f32
    if (srcType == ":f64" && targetType == ":f32")
      return "(f32.demote_f64 " + innerWat + ")";
    // i64 → f64
    if (srcType == ":i64" && targetType == ":f64")
      return "(f64.convert_i64_s " + innerWat + ")";
    // f64 → i64
    if (srcType == ":f64" && targetType == ":i64")
      return "(i64.trunc_f64_s " + innerWat + ")";
    // Same type or struct→i32 pointer casts: no-op
    return innerWat;
  }

  // ── Operator call (defined via defop) — overload selected by type inference ─
  if (env.ops.has(op)) {
    const argTypes = new Array<string>();
    for (let i = 1; i < list.children.length; i++) {
      argTypes.push(typeOf(list.children[i], env, locals));
    }
    const resolved = resolveOp(op, argTypes, env);
    if (resolved == null) return ";; ERROR: no overload of '" + op + "' for these types";
    // If watOp contains a dot it is a WAT instruction; otherwise it is a function name.
    if (resolved.watOp.includes(".")) {
      let out = "(" + resolved.watOp;
      for (let i = 1; i < list.children.length; i++) {
        out += " " + codegenExpr(list.children[i], env, locals, false);
      }
      return out + ")";
    } else {
      // Function-name dispatch: (call $fn arg0 arg1 ...)
      const args2 = new Array<string>();
      for (let i = 1; i < list.children.length; i++) {
        args2.push(codegenExpr(list.children[i], env, locals, false));
      }
      return emitTC ? watReturnCall(resolved.watOp, args2) : watCall(resolved.watOp, args2);
    }
  }

  // ── (while cond body...) ─────────────────────────────────────────────
  // Compiles to a WAT block/loop pair with br_if for the exit condition.
  if (op == "while") {
    const cond = codegenExpr(list.children[1], env, locals, false);
    let bodyParts = watBrIf("__while_break", "(i32.eqz " + cond + ")");
    for (let i = 2; i < list.children.length; i++) {
      bodyParts += "\n    " + codegenExpr(list.children[i], env, locals, false);
    }
    bodyParts += "\n    " + watBr("__while_loop");
    return watBlock("__while_break", watLoop("__while_loop", bodyParts));
  }

  // ── (if cond then else?) ───────────────────────────────────────────────────
  if (op == "if") {
    const cond = codegenExpr(list.children[1], env, locals, false);
    // Skip any interleaved comment nodes to find the real then/else branches.
    let thenIdx = 2;
    while (thenIdx < list.children.length && list.children[thenIdx].tag == TAG_COMMENT) thenIdx++;
    let elseIdx = thenIdx + 1;
    while (elseIdx < list.children.length && list.children[elseIdx].tag == TAG_COMMENT) elseIdx++;
    const thenExpr = thenIdx < list.children.length
      ? codegenExpr(list.children[thenIdx], env, locals, emitTC) : "";
    const elseExpr = elseIdx < list.children.length
      ? codegenExpr(list.children[elseIdx], env, locals, emitTC) : "";
    // Include (result T...) when the if produces a value (has an else branch).
    // If the then branch is (values ...), emit a multi-value result declaration.
    let resultWat = "";
    if (elseIdx < list.children.length) {
      resultWat = ifResultDecl(list.children[thenIdx], env, locals);
    }
    return watIf(cond, thenExpr, elseExpr, resultWat);
  }

  // ── (let name [:Type] val body...) ──────────────────────────────────────────
  // Type annotation is optional; when absent the type is inferred from the value.
  // The (local ...) declaration is hoisted by codegenDefn — we emit only local.set.
  if (op == "let") {
    // ── Tuple destructuring: (let (a [:T] b [:T]...) (tuple-fn args...) body...) ─
    if (list.children[1].tag == TAG_LIST) {
      const pattern = list.children[1] as ListNode;
      let inferredTypes = new Array<string>();
      if (list.children[2].tag == TAG_LIST) {
        const callList = list.children[2] as ListNode;
        if (callList.children.length > 0 && callList.children[0].tag == TAG_SYMBOL) {
          const fnName = (callList.children[0] as SymbolNode).name;
          if (env.funcTupleResults.has(fnName)) inferredTypes = env.funcTupleResults.get(fnName);
        }
      }
      const pnames = new Array<string>(); const ptypes = new Array<string>();
      parseTuplePattern(pattern, inferredTypes, pnames, ptypes);
      const callWat = codegenExpr(list.children[2], env, locals, false);
      const newLocals = copyLocals(locals);
      for (let k = 0; k < pnames.length; k++) newLocals.set(pnames[k], ptypes[k]);
      // Emit the call, then local.sets in reverse order (stack is LIFO)
      let nameList = "(";
      for (let k = 0; k < pnames.length; k++) {
        if (k > 0) nameList += " ";
        nameList += pnames[k];
      }
      nameList += ")";
      let body = "(; let " + nameList + " ;) " + callWat;
      for (let k = pnames.length - 1; k >= 0; k--) {
        body += "\n    (local.set $" + pnames[k] + ")";
      }
      for (let i = 3; i < list.children.length; i++) {
        body += "\n    " + codegenExpr(list.children[i], env, newLocals, emitTC && i == list.children.length - 1);
      }
      return body;
    }
    // ── Tuple local: (let name (:t1 :t2...) val body...) ────────────────────
    {
      const tlocTypes = extractTupleAnnotation(list, 2);
      if (tlocTypes != null) {
        const tname = (list.children[1] as SymbolNode).name;
        const callWat = codegenExpr(list.children[3], env, locals, false);
        const newLocals = copyLocals(locals);
        newLocals.set(tname, "tuple");
        for (let k = 0; k < tlocTypes.length; k++) newLocals.set(tname + "_" + k.toString(), tlocTypes[k]);
        let body = "(; let " + tname + " ;) " + callWat;
        for (let k = tlocTypes.length - 1; k >= 0; k--) {
          body += "\n    (local.set $" + tname + "_" + k.toString() + ")";
        }
        for (let i = 4; i < list.children.length; i++) {
          body += "\n    " + codegenExpr(list.children[i], env, newLocals, emitTC && i == list.children.length - 1);
        }
        return body;
      }
    }
    // ── Inferred tuple local: (let name (tuple-fn args) body...) ────────────
    {
      const iTypes = inferredTupleTypes(list.children[2], env);
      if (iTypes != null) {
        const tname = (list.children[1] as SymbolNode).name;
        const callWat = codegenExpr(list.children[2], env, locals, false);
        const newLocals = copyLocals(locals);
        newLocals.set(tname, "tuple");
        for (let k = 0; k < iTypes.length; k++) newLocals.set(tname + "_" + k.toString(), iTypes[k]);
        let body = "(; let " + tname + " ;) " + callWat;
        for (let k = iTypes.length - 1; k >= 0; k--) {
          body += "\n    (local.set $" + tname + "_" + k.toString() + ")";
        }
        for (let i = 3; i < list.children.length; i++) {
          body += "\n    " + codegenExpr(list.children[i], env, newLocals, emitTC && i == list.children.length - 1);
        }
        return body;
      }
    }
    // ── Function-typed local: (let name (:P -> :R) val body...) ─────────────
    if (list.children.length > 3 && isFuncTypeNode(list.children[2])) {
      const ft = parseFuncTypeNode(list.children[2] as ListNode);
      const typeKey = registerFuncTypeIfNeeded(ft.params, ft.results, env);
      const letName2 = (list.children[1] as SymbolNode).name;
      const val2 = codegenExpr(list.children[3], env, locals, false);
      const newLocals2 = copyLocals(locals);
      newLocals2.set(letName2, ":func:" + typeKey);
      let body2 = "(; let " + letName2 + " ;) " + watLocalSet(letName2, val2);
      for (let i = 4; i < list.children.length; i++) {
        body2 += "\n    " + codegenExpr(list.children[i], env, newLocals2, emitTC && i == list.children.length - 1);
      }
      return body2;
    }
    // ── Single binding ────────────────────────────────────────────────────────
    const letName = (list.children[1] as SymbolNode).name;
    let typeAnnot = "";
    let valIdx    = 2;
    if (list.children[2].tag == TAG_SYMBOL &&
        (list.children[2] as SymbolNode).name.startsWith(":")) {
      typeAnnot = (list.children[2] as SymbolNode).name;
      valIdx    = 3;
    }
    if (typeAnnot == "") typeAnnot = typeOf(list.children[valIdx], env, locals);
    // ── :str binding — two WAT locals (ptr, len) ─────────────────────────────
    if (typeAnnot == ":str") {
      const val = codegenExpr(list.children[valIdx], env, locals, false);
      const newLocals = copyLocals(locals);
      newLocals.set(letName, ":str");
      newLocals.set(letName + "_ptr", ":i32");
      newLocals.set(letName + "_len", ":i32");
      // val produces two stack values (ptr on bottom, len on top); pop in reverse.
      let bodyStr = "(; let " + letName + " ;) " + val;
      bodyStr += "\n    (local.set $" + letName + "_len)";
      bodyStr += "\n    (local.set $" + letName + "_ptr)";
      for (let i = valIdx + 1; i < list.children.length; i++) {
        bodyStr += "\n    " + codegenExpr(list.children[i], env, newLocals, emitTC && i == list.children.length - 1);
      }
      return bodyStr;
    }
    // ── :T[] binding — fat-pointer slice from an explicit expression ──────────
    // (let buf :f64[] expr body...) — expr must produce two stack values (ptr, len)
    if (isSliceType(typeAnnot) && !isAllocSliceType(typeAnnot)) {
      const val = codegenExpr(list.children[valIdx], env, locals, false);
      const newLocals = copyLocals(locals);
      newLocals.set(letName, typeAnnot);
      newLocals.set(letName + "_ptr", ":i32");
      newLocals.set(letName + "_len", ":i32");
      let bodyStr = "(; let " + letName + " ;) " + val;
      bodyStr += "\n    (local.set $" + letName + "_len)";
      bodyStr += "\n    (local.set $" + letName + "_ptr)";
      for (let i = valIdx + 1; i < list.children.length; i++) {
        bodyStr += "\n    " + codegenExpr(list.children[i], env, newLocals, emitTC && i == list.children.length - 1);
      }
      return bodyStr;
    }
    // ── :T[N] binding — auto-allocate N elements, no explicit value ───────────
    // (let buf :i32[16] body...) — compiler inserts alloc(16 * sizeof(:i32))
    if (isAllocSliceType(typeAnnot)) {
      const elemType = sliceElemType(typeAnnot);
      const lb = typeAnnot.lastIndexOf("[");
      const sizeStr = typeAnnot.slice(lb + 1, typeAnnot.length - 1);
      const sizeWat = sliceAllocSizeWat(sizeStr, env);
      const elemSize = env.sizeOf(elemType);
      const byteWat = elemSize == 1
        ? sizeWat
        : "(i32.mul " + sizeWat + " (i32.const " + elemSize.toString() + "))";
      const newLocals = copyLocals(locals);
      newLocals.set(letName, typeAnnot);
      newLocals.set(letName + "_ptr", ":i32");
      newLocals.set(letName + "_len", ":i32");
      // valIdx = 3 points to the first body expression (no explicit value in source)
      let bodyStr = "(; let " + letName + " :T[N] ;) (call $alloc " + byteWat + ")";
      bodyStr += "\n    (local.set $" + letName + "_ptr)";
      bodyStr += "\n    " + sizeWat;
      bodyStr += "\n    (local.set $" + letName + "_len)";
      for (let i = valIdx; i < list.children.length; i++) {
        bodyStr += "\n    " + codegenExpr(list.children[i], env, newLocals, emitTC && i == list.children.length - 1);
      }
      return bodyStr;
    }
    // ── :*T[N] binding — alloc element buffer + 8-byte {ptr,len} header ──────
    // (let hdr :*f32[4] body...) → hdr = alloc(8); header.ptr = alloc(4*4); header.len = 4
    if (isPtrAllocSliceType(typeAnnot)) {
      const elemType = ptrSliceElemType(typeAnnot);
      const lb = typeAnnot.lastIndexOf("[");
      const sizeStr = typeAnnot.slice(lb + 1, typeAnnot.length - 1);
      const sizeWat = sliceAllocSizeWat(sizeStr, env);
      const elemSize = env.sizeOf(elemType);
      const byteWat = elemSize == 1
        ? sizeWat
        : "(i32.mul " + sizeWat + " (i32.const " + elemSize.toString() + "))";
      const newLocals = copyLocals(locals);
      newLocals.set(letName, typeAnnot);
      // Allocate 8-byte header, store in local; then fill header.ptr and header.len
      let bodyStr = "(; let " + letName + " :*T[N] ;) (call $alloc (i32.const 8))";
      bodyStr += "\n    (local.set $" + letName + ")";
      bodyStr += "\n    (i32.store (local.get $" + letName + ") (call $alloc " + byteWat + "))";
      bodyStr += "\n    (i32.store (i32.add (local.get $" + letName + ") (i32.const 4)) " + sizeWat + ")";
      for (let i = valIdx; i < list.children.length; i++) {
        bodyStr += "\n    " + codegenExpr(list.children[i], env, newLocals, emitTC && i == list.children.length - 1);
      }
      return bodyStr;
    }
    // ── Value-type struct binding: (let p :Point (Point 3 4) ...) ─────────────
    if (isValueTypeAnnot(typeAnnot, env)) {
      const vtN = valueTypeName(typeAnnot);
      const vtI = env.types.get(vtN);
      const fnames = vtI.fieldNames;
      const newLocals = copyLocals(locals);
      newLocals.set(letName, typeAnnot); // marker
      collectValueTypeSubLocals(letName, vtN, env, newLocals);
      let bodyV = "(; let " + letName + " ;) ";
      const valNode = list.children[valIdx];
      // If value is a constructor call (TypeName arg0 arg1 ...), push each arg recursively
      if (valNode.tag == TAG_LIST) {
        const valList = valNode as ListNode;
        if (valList.children.length > 0 && valList.children[0].tag == TAG_SYMBOL &&
            (valList.children[0] as SymbolNode).name == vtN) {
          for (let fi = 0; fi < fnames.length; fi++) {
            if (fi > 0) bodyV += "\n    ";
            bodyV += codegenExpr(valList.children[fi + 1], env, locals, false);
          }
        } else {
          // Other expression (e.g. function returning :Point — already multi-value)
          bodyV += codegenExpr(valNode, env, locals, false);
        }
      } else {
        bodyV += codegenExpr(valNode, env, locals, false);
      }
      // Pop leaf field values in reverse (stack is LIFO; last leaf is on top)
      const leafLocals = valueTypeLeafLocals(letName, vtN, env);
      for (let li = leafLocals.length - 1; li >= 0; li--) {
        bodyV += "\n    (local.set $" + leafLocals[li] + ")";
      }
      for (let i = valIdx + 1; i < list.children.length; i++) {
        bodyV += "\n    " + codegenExpr(list.children[i], env, newLocals, emitTC && i == list.children.length - 1);
      }
      return bodyV;
    }
    // ── Ref-type struct binding: (let p :*Point (Point 3 4) ...) ──────────────
    if (isRefTypeAnnot(typeAnnot, env)) {
      const vtN = refTypeName(typeAnnot);
      const vtI = env.types.get(vtN);
      const fnames = vtI.fieldNames;
      const newLocals = copyLocals(locals);
      newLocals.set(letName, typeAnnot); // preserve :*T for operator dispatch
      let bodyR = "(; let " + letName + " ;) ";
      const valNode = list.children[valIdx];
      if (valNode.tag == TAG_LIST) {
        const valList = valNode as ListNode;
        if (valList.children.length > 0 && valList.children[0].tag == TAG_SYMBOL &&
            (valList.children[0] as SymbolNode).name == vtN) {
          // Constructor call: alloc then store each field (recursively for embedded structs)
          bodyR += "(call $alloc (i32.const " + vtI.size.toString() + "))\n    ";
          bodyR += "(local.set $" + letName + ")";
          for (let fi = 0; fi < fnames.length; fi++) {
            const finfo = vtI.fields.get(fnames[fi]);
            bodyR += emitStructFieldStores("(local.get $" + letName + ")", finfo.offset,
                                           valList.children[fi + 1], finfo.typeName, env, locals);
          }
        } else {
          // Non-constructor: treat result as already a pointer
          bodyR += watLocalSet(letName, codegenExpr(valNode, env, locals, false));
        }
      } else {
        bodyR += watLocalSet(letName, codegenExpr(valNode, env, locals, false));
      }
      for (let i = valIdx + 1; i < list.children.length; i++) {
        bodyR += "\n    " + codegenExpr(list.children[i], env, newLocals, emitTC && i == list.children.length - 1);
      }
      return bodyR;
    }
    const val       = codegenExpr(list.children[valIdx], env, locals, false);
    const newLocalsS = copyLocals(locals);
    newLocalsS.set(letName, typeAnnot);
    // Build the body first so we can analyse it before deciding how to emit.
    let bodyS = "";
    for (let i = valIdx + 1; i < list.children.length; i++) {
      if (bodyS.length > 0) bodyS += "\n    ";
      bodyS += codegenExpr(list.children[i], env, newLocalsS, emitTC && i == list.children.length - 1);
    }
    // ── Single-use inlining: if val is pure and the local is read exactly once
    // with no intervening set!, substitute the expression directly into the
    // use site.  This eliminates the local.set / local.get round-trip and lets
    // the Wasm value stack carry the value — matching what LLVM emits.
    //
    // Safety: we must not inline when any variable read by val is mutated
    // (local.set) in the body BEFORE the use site of letName.  Example:
    //   (let tmp (+ a b) (set! a b) (set! b tmp))  — a is set before tmp is read.
    const getPattern = "(local.get $" + letName + ")";
    const setPattern = "(local.set $" + letName + " ";
    const useIdx = bodyS.indexOf(getPattern);
    if (isPureWat(val)
        && countOccurrences(bodyS, getPattern) == 1
        && !bodyS.includes(setPattern)
        && !anyLocalSetBefore(extractLocalGetNames(val), bodyS, useIdx)) {
      return "(; let " + letName + " ;) " + replaceFirst(bodyS, getPattern, val);
    }
    return "(; let " + letName + " ;) " + watLocalSet(letName, val) + "\n    " + bodyS;
  }

  // ── (progn e1 e2 ... en) — evaluate in order, return last ─────────────────
  if (op == "progn") {
    let out = "";
    for (let i = 1; i < list.children.length; i++) {
      if (i > 1) out += "\n    ";
      out += codegenExpr(list.children[i], env, locals, emitTC && i == list.children.length - 1);
    }
    return out;
  }

  // ── (with-arena body...) — execute body in a push/pop arena scope ──────────
  // arena-push saves heap-ptr; arena-pop restores it, freeing all arena allocs.
  // The last body expression's value is returned (arena-pop is void — it uses
  // only global.set instructions that don't touch the WAT value stack).
  if (op == "with-arena") {
    const addr = arenaStackAddr(env);
    let out = emitArenaPushWat(addr);
    for (let i = 1; i < list.children.length; i++) {
      out += "\n    ";
      out += codegenExpr(list.children[i], env, locals, emitTC && i == list.children.length - 1);
    }
    out += "\n    " + emitArenaPopWat(addr);
    return out;
  }

  // ── (values e1 e2 ... en) — push multiple values onto the stack ───────────
  // Used as the final expression in tuple-returning functions.
  if (op == "values") {
    let out = "";
    for (let i = 1; i < list.children.length; i++) {
      if (i > 1) out += "\n    ";
      out += codegenExpr(list.children[i], env, locals, false);
    }
    return out;
  }

  // ── (set! name val) ────────────────────────────────────────────────────────
  if (op == "set!") {
    const name  = (list.children[1] as SymbolNode).name;
    if (env.globals.has(name)) {
      const ginfo = env.globals.get(name);
      // Value-type struct global: fields live as separate sub-globals
      if (ginfo.isValueType) {
        const sName = ginfo.typeName.slice(1); // ":Point" → "Point"
        const vtI   = env.types.get(sName);
        const rhsNode = list.children[2];
        if (rhsNode.tag == TAG_LIST) {
          const rhsList = rhsNode as ListNode;
          if (rhsList.children.length > 0 && rhsList.children[0].tag == TAG_SYMBOL &&
              (rhsList.children[0] as SymbolNode).name == sName) {
            // Constructor: set each sub-global directly (no heap allocation)
            let out = "";
            const fnames = vtI.fieldNames;
            for (let fi = 0; fi < fnames.length; fi++) {
              if (out.length > 0) out += "\n    ";
              const val = codegenExpr(rhsList.children[fi + 1], env, locals, false);
              out += "(global.set $" + name + "_" + fnames[fi] + " " + val + ")";
            }
            return out;
          }
        }
        return ";; ERROR: cannot assign non-constructor expression to value-type global '" + name + "'";
      }
      // Ref-type struct global: (set! g (TypeName f1 f2 ...)) → alloc + field stores
      const sName = ginfo.typeName.startsWith(":*") ? ginfo.typeName.slice(2) : ginfo.typeName.slice(1);
      if (env.types.has(sName)) {
        const vtI = env.types.get(sName);
        const rhsNode = list.children[2];
        if (rhsNode.tag == TAG_LIST) {
          const rhsList = rhsNode as ListNode;
          if (rhsList.children.length > 0 && rhsList.children[0].tag == TAG_SYMBOL &&
              (rhsList.children[0] as SymbolNode).name == sName) {
            // Constructor: alloc, store pointer in global, store each field
            let out = "(call $alloc (i32.const " + vtI.size.toString() + "))\n    ";
            out += "(global.set $" + name + ")";
            const fnames = vtI.fieldNames;
            for (let fi = 0; fi < fnames.length; fi++) {
              const finfo = vtI.fields.get(fnames[fi]);
              out += emitStructFieldStores(
                "(global.get $" + name + ")", finfo.offset,
                rhsList.children[fi + 1], finfo.typeName, env, locals);
            }
            return out;
          }
        }
        // Non-constructor RHS: treat as already a pointer (i32)
        return "(global.set $" + name + " " + codegenExpr(list.children[2], env, locals, false) + ")";
      }
      // Primitive global
      return "(global.set $" + name + " " + codegenExpr(list.children[2], env, locals, false) + ")";
    }
    return watLocalSet(name, codegenExpr(list.children[2], env, locals, false));
  }


  // ── (i32.store ptr val) — raw memory write (void) ────────────────────────
  if (op == "i32.store") {
    const ptr = codegenExpr(list.children[1], env, locals, false);
    const val = codegenExpr(list.children[2], env, locals, false);
    return watI32Store(ptr, val);
  }
  // ── (i32.store8 ptr val) — single-byte write (void) ───────────
  if (op == "i32.store8") {
    const ptr = codegenExpr(list.children[1], env, locals, false);
    const val = codegenExpr(list.children[2], env, locals, false);
    return watI32Store8(ptr, val);
  }

  // ── (i32.load ptr) — 4-byte read → i32 ─────────────────────────
  if (op == "i32.load") {
    return watI32Load(codegenExpr(list.children[1], env, locals, false));
  }
  // ── (i32.load8_u ptr) — unsigned single-byte read ──────────────
  if (op == "i32.load8_u") {
    return watI32Load8u(codegenExpr(list.children[1], env, locals, false));
  }
  // ── (i32.load16_u ptr) — unsigned 2-byte read ───────────────────
  if (op == "i32.load16_u") {
    return watI32Load16u(codegenExpr(list.children[1], env, locals, false));
  }
  // ── (i64.load ptr) — 8-byte read → i64 ─────────────────────────
  if (op == "i64.load") {
    return watI64Load(codegenExpr(list.children[1], env, locals, false));
  }
  // ── (i64.store ptr val) — 8-byte write ──────────────────────────
  if (op == "i64.store") {
    return watI64Store(codegenExpr(list.children[1], env, locals, false),
                      codegenExpr(list.children[2], env, locals, false));
  }
  // ── (f32.load ptr) — 4-byte f32 read ────────────────────────────
  if (op == "f32.load") {
    return watF32Load(codegenExpr(list.children[1], env, locals, false));
  }
  // ── (f32.store ptr val) — 4-byte f32 write ──────────────────────
  if (op == "f32.store") {
    return watF32Store(codegenExpr(list.children[1], env, locals, false),
                      codegenExpr(list.children[2], env, locals, false));
  }
  // ── (f64.load ptr) — 8-byte f64 read ────────────────────────────
  if (op == "f64.load") {
    return watF64Load(codegenExpr(list.children[1], env, locals, false));
  }
  // ── (f64.store ptr val) — 8-byte f64 write ──────────────────────
  if (op == "f64.store") {
    return watF64Store(codegenExpr(list.children[1], env, locals, false),
                      codegenExpr(list.children[2], env, locals, false));
  }

  // ── (array-ref :T data-ptr idx) — typed element load ─────────────────────
  // data-ptr is the raw element buffer pointer (not the Array header pointer).
  // Emits: T.load(data-ptr + idx * sizeof(T))
  if (op == "array-ref") {
    const etype    = (list.children[1] as SymbolNode).name;
    const dataPtr  = codegenExpr(list.children[2], env, locals, false);
    const idx      = codegenExpr(list.children[3], env, locals, false);
    const elemSize = env.sizeOf(etype);
    const addrExpr = elemSize <= 1
      ? "(i32.add " + dataPtr + " " + idx + ")"
      : "(i32.add " + dataPtr + " (i32.mul " + idx + " (i32.const " + elemSize.toString() + ")))";
    if (etype == ":i64") return watI64Load(addrExpr);
    if (etype == ":f32") return watF32Load(addrExpr);
    if (etype == ":f64") return watF64Load(addrExpr);
    return watI32Load(addrExpr); // :i32, :ptr, :*T, etc.
  }

  // ── SIMD instructions ─────────────────────────────────────────────────────

  // (v128.load ptr) → (v128.load expr)
  if (op == "v128.load") {
    return "(v128.load " + codegenExpr(list.children[1], env, locals, false) + ")";
  }

  // (v128.store ptr val) → (v128.store expr expr)  void
  if (op == "v128.store") {
    return "(v128.store " + codegenExpr(list.children[1], env, locals, false)
                  + " " + codegenExpr(list.children[2], env, locals, false) + ")";
  }

  // (v128.const b0 b1 ... b15) → (v128.const i8x16 0 1 2 ...)
  // Accepts exactly 16 integer literal arguments (bytes).
  if (op == "v128.const") {
    let out = "(v128.const i8x16";
    for (let i = 1; i < list.children.length; i++) {
      const b = codegenExpr(list.children[i], env, locals, false);
      // Strip (i32.const N) down to just N for the immediate
      if (b.startsWith("(i32.const ") && b.endsWith(")")) {
        out += " " + b.slice(11, b.length - 1);
      } else {
        out += " " + b;
      }
    }
    return out + ")";
  }

  // Lane extract: (i32x4.extract_lane lane vec) → (i32x4.extract_lane LANE expr)
  // Lane must be a compile-time integer literal.
  if (op == "i8x16.extract_lane_s" || op == "i8x16.extract_lane_u" ||
      op == "i16x8.extract_lane_s" || op == "i16x8.extract_lane_u" ||
      op == "i32x4.extract_lane"   || op == "i64x2.extract_lane"   ||
      op == "f32x4.extract_lane"   || op == "f64x2.extract_lane") {
    if (list.children[1].tag != TAG_INT) {
      return ";; ERROR: " + op + ": lane index must be an integer literal";
    }
    const lane = (list.children[1] as IntNode).value;
    const vec  = codegenExpr(list.children[2], env, locals, false);
    return "(" + op + " " + lane.toString() + " " + vec + ")";
  }

  // Generic extract_lane / extract_lane_s / extract_lane_u — type-dispatched
  if (op == "extract_lane" || op == "extract_lane_s" || op == "extract_lane_u") {
    if (list.children[1].tag != TAG_INT) {
      return ";; ERROR: extract_lane: lane index must be an integer literal";
    }
    const elLane = (list.children[1] as IntNode).value;
    const elVec  = codegenExpr(list.children[2], env, locals, false);
    const elType = typeOf(list.children[2], env, locals);
    let elOp: string;
    if (elType == ":i8x16")       elOp = op == "extract_lane_u" ? "i8x16.extract_lane_u" : "i8x16.extract_lane_s";
    else if (elType == ":i16x8")  elOp = op == "extract_lane_u" ? "i16x8.extract_lane_u" : "i16x8.extract_lane_s";
    else if (elType == ":i64x2")  elOp = "i64x2.extract_lane";
    else if (elType == ":f32x4")  elOp = "f32x4.extract_lane";
    else if (elType == ":f64x2")  elOp = "f64x2.extract_lane";
    else                          elOp = "i32x4.extract_lane"; // :i32x4 and generic :v128
    return "(" + elOp + " " + elLane.toString() + " " + elVec + ")";
  }

  // Lane replace: (i32x4.replace_lane lane vec val) → (i32x4.replace_lane LANE expr expr)
  if (op == "i8x16.replace_lane" || op == "i16x8.replace_lane" ||
      op == "i32x4.replace_lane" || op == "i64x2.replace_lane" ||
      op == "f32x4.replace_lane" || op == "f64x2.replace_lane") {
    if (list.children[1].tag != TAG_INT) {
      return ";; ERROR: " + op + ": lane index must be an integer literal";
    }
    const lane2 = (list.children[1] as IntNode).value;
    const vec2  = codegenExpr(list.children[2], env, locals, false);
    const val3  = codegenExpr(list.children[3], env, locals, false);
    return "(" + op + " " + lane2.toString() + " " + vec2 + " " + val3 + ")";
  }

  // Generic replace_lane — type-dispatched
  if (op == "replace_lane") {
    if (list.children[1].tag != TAG_INT) {
      return ";; ERROR: replace_lane: lane index must be an integer literal";
    }
    const rlLane = (list.children[1] as IntNode).value;
    const rlVec  = codegenExpr(list.children[2], env, locals, false);
    const rlVal  = codegenExpr(list.children[3], env, locals, false);
    const rlType = typeOf(list.children[2], env, locals);
    let rlOp: string;
    if (rlType == ":i8x16")       rlOp = "i8x16.replace_lane";
    else if (rlType == ":i16x8")  rlOp = "i16x8.replace_lane";
    else if (rlType == ":i64x2")  rlOp = "i64x2.replace_lane";
    else if (rlType == ":f32x4")  rlOp = "f32x4.replace_lane";
    else if (rlType == ":f64x2")  rlOp = "f64x2.replace_lane";
    else                          rlOp = "i32x4.replace_lane"; // :i32x4 fallback
    return "(" + rlOp + " " + rlLane.toString() + " " + rlVec + " " + rlVal + ")";
  }

  // (i8x16.shuffle m0..m15 a b) → (i8x16.shuffle m0 m1 ... m15 expr expr)
  // First 16 args are lane selectors (integer literals), last two are vectors.
  if (op == "i8x16.shuffle") {
    let out = "(i8x16.shuffle";
    for (let i = 1; i <= 16; i++) {
      if (list.children[i].tag != TAG_INT) {
        return ";; ERROR: i8x16.shuffle: lane selectors must be integer literals";
      }
      out += " " + (list.children[i] as IntNode).value.toString();
    }
    out += " " + codegenExpr(list.children[17], env, locals, false);
    out += " " + codegenExpr(list.children[18], env, locals, false);
    return out + ")";
  }

  // ── (array-set! :T data-ptr idx val) — typed element store ───────────────
  if (op == "array-set!") {
    const etype    = (list.children[1] as SymbolNode).name;
    const dataPtr  = codegenExpr(list.children[2], env, locals, false);
    const idx      = codegenExpr(list.children[3], env, locals, false);
    const val2     = codegenExpr(list.children[4], env, locals, false);
    const elemSize = env.sizeOf(etype);
    const addrExpr = elemSize <= 1
      ? "(i32.add " + dataPtr + " " + idx + ")"
      : "(i32.add " + dataPtr + " (i32.mul " + idx + " (i32.const " + elemSize.toString() + ")))";
    if (etype == ":i64") return watI64Store(addrExpr, val2);
    if (etype == ":f32") return watF32Store(addrExpr, val2);
    if (etype == ":f64") return watF64Store(addrExpr, val2);
    return watI32Store(addrExpr, val2);
  }

  // ── Typed slice ops ──────────────────────────────────────────────────────
  // (aref  buf idx)     — unchecked element read; buf must be a bare local name
  // (aset! buf idx val) — unchecked element write
  // (alen  buf)         — return the length stored in the slice's _len local
  if (op == "aref" || op == "aset!" || op == "alen") {
    const bufNode = list.children[1];
    if (bufNode.tag != TAG_SYMBOL) {
      return ";; ERROR: aref/aset!/alen: first argument must be a local variable name";
    }
    const bufName = (bufNode as SymbolNode).name;
    const bufType = locals.has(bufName) ? locals.get(bufName)
                  : (env.statics.has(bufName) ? env.statics.get(bufName).typeName : ":i32[]");
    // For :*T[] / :*T[N] the element type strips the leading :*
    const elemType = isPtrSliceType(bufType) ? ptrSliceElemType(bufType) : sliceElemType(bufType);
    const elemSize = env.sizeOf(elemType);

    if (op == "alen") {
      // For defstatic :T[N], fold to compile-time constant N.
      if (env.statics.has(bufName) && isAllocSliceType(env.statics.get(bufName).typeName)) {
        const st = env.statics.get(bufName);
        const slb = st.typeName.lastIndexOf("[");
        const nStr = st.typeName.slice(slb + 1, st.typeName.length - 1);
        return "(i32.const " + nStr + ")";
      }
      // :*T[N] — fold to compile-time constant if N is literal; otherwise load from header
      if (isPtrAllocSliceType(bufType)) {
        const slb = bufType.lastIndexOf("[");
        const nStr = bufType.slice(slb + 1, bufType.length - 1);
        // Check if N is a pure integer literal
        let allDigits = nStr.length > 0;
        for (let ci = 0; ci < nStr.length; ci++) {
          const cc = nStr.charCodeAt(ci);
          if (cc < 48 || cc > 57) { allDigits = false; break; }
        }
        if (allDigits) return "(i32.const " + nStr + ")";
        // defconst or runtime expression — load from header+4
      }
      // :*T[] / :*T[N] (non-literal N) — load len from memory header at offset 4
      if (isPtrSliceType(bufType)) {
        return "(i32.load (i32.add (local.get $" + bufName + ") (i32.const 4)))";
      }
      return "(local.get $" + bufName + "_len)";
    }

    // Shared: compute element address from buf_ptr + idx * elemSize
    const idx = codegenExpr(list.children[2], env, locals, false);
    // For :*T[] the data pointer is loaded from header[0]; for :T[] it's a sub-local
    const ptrExpr = isPtrSliceType(bufType)
      ? "(i32.load (local.get $" + bufName + "))"
      : env.statics.has(bufName)
        ? "(i32.const " + env.statics.get(bufName).ptr.toString() + ")"
        : "(local.get $" + bufName + "_ptr)";
    const addrExpr = elemSize <= 1
      ? "(i32.add " + ptrExpr + " " + idx + ")"
      : "(i32.add " + ptrExpr + " (i32.mul " + idx + " (i32.const " + elemSize.toString() + ")))";

    if (op == "aset!") {
      const val2 = codegenExpr(list.children[3], env, locals, false);
      if (elemType == ":i64") return watI64Store(addrExpr, val2);
      if (elemType == ":f32") return watF32Store(addrExpr, val2);
      if (elemType == ":f64") return watF64Store(addrExpr, val2);
      if (elemType == ":u8")  return "(i32.store8 " + addrExpr + " " + val2 + ")";
      return watI32Store(addrExpr, val2);
    }
    // aref — read value, or return address for struct element types
    if (isValueTypeAnnot(elemType, env)) return addrExpr; // returns :*StructType slot address
    if (elemType == ":i64") return "(i64.load " + addrExpr + ")";
    if (elemType == ":f32") return "(f32.load " + addrExpr + ")";
    if (elemType == ":f64") return "(f64.load " + addrExpr + ")";
    if (elemType == ":u8")  return "(i32.load8_u " + addrExpr + ")";
    return "(i32.load " + addrExpr + ")";
  }

  // ── (drop expr) — discard a value (void) ──────────────────────────────────
  if (op == "drop") {
    return watDrop(codegenExpr(list.children[1], env, locals, false));
  }

  // ── Struct getter/setter or tuple-local accessor ──────────────────────────
  if (op.includes("/")) {
    const slash    = op.indexOf("/");
    const typeName = op.substring(0, slash);
    const rawField = op.substring(slash + 1);
    const isSetter = rawField.endsWith("!");
    const field    = isSetter ? rawField.substring(0, rawField.length - 1) : rawField;
    // Tuple-local accessor: (pair/0) — no args, prefix is a tuple marker
    if (locals.has(typeName) && locals.get(typeName) == "tuple") {
      return "(local.get $" + typeName + "_" + field + ")";
    }
    // :str fat-pointer accessor — access $varname_ptr or $varname_len directly.
    // Only applies when the argument is a true :str fat-pointer local (has _ptr sub-local).
    // :*str pointers use the hardcoded {ptr@0, len@4} layout below.
    // Also handles (slice/ptr buf) / (slice/len buf) for :T[] slice locals.
    if (typeName == "str" || typeName == "slice") {
      const varNode = list.children[1];
      const varName = varNode.tag == TAG_SYMBOL ? (varNode as SymbolNode).name : "";
      if (locals.has(varName + "_ptr")) {
        if (isSetter) {
          const val = codegenExpr(list.children[2], env, locals, false);
          return "(local.set $" + varName + "_" + field + " " + val + ")";
        }
        return "(local.get $" + varName + "_" + field + ")";
      }
      if (typeName == "slice") return ";; ERROR: slice/ptr: " + varName + " has no _ptr sub-local";
      // Named :*str static used directly — fold to compile-time constants.
      // The header layout is {ptr@0 = bytesAddr, len@4 = length}.
      if (env.statics.has(varName) && env.statics.get(varName).typeName == ":*str") {
        const info = env.statics.get(varName);
        if (field == "ptr") return "(i32.const " + (info.ptr + 8).toString() + ")";
        if (field == "len") return "(i32.const " + info.len.toString() + ")";
      }
      // Interned string literal (__str:xxx, typeName ":strlit") — ptr IS the char bytes address.
      // Must handle before the generic ptrExpr path, because codegenExpr of a :strlit symbol
      // expands to two values (ptr, len) which would produce invalid i32.load operands.
      if (env.statics.has(varName) && env.statics.get(varName).typeName == ":strlit") {
        const info = env.statics.get(varName);
        if (field == "ptr") return "(i32.const " + info.ptr.toString() + ")";
        if (field == "len") return "(i32.const " + info.len.toString() + ")";
      }
      // :*str pointer in a local — hardcoded layout {ptr@0, len@4}; no deftype required.
      const ptrExpr = codegenExpr(list.children[1], env, locals, false);
      if (isSetter) {
        const val = codegenExpr(list.children[2], env, locals, false);
        if (field == "ptr") return "(i32.store " + ptrExpr + " " + val + ")";
        if (field == "len") return "(i32.store (i32.add " + ptrExpr + " (i32.const 4)) " + val + ")";
      }
      if (field == "ptr") return "(i32.load " + ptrExpr + ")";
      if (field == "len") return "(i32.load (i32.add " + ptrExpr + " (i32.const 4)))";
    }
    // Value-type struct field accessor: (Point/x p) where p has type :Point → local.get/set
    if (list.children.length > 1 && list.children[1].tag == TAG_SYMBOL) {
      const varName = (list.children[1] as SymbolNode).name;
      if (locals.has(varName) && locals.get(varName) == ":" + typeName) {
        if (env.types.has(typeName) && env.types.get(typeName).fields.has(field)) {
          const ft = env.types.get(typeName).fields.get(field).typeName;
          // Embedded struct field → push all its leaf sub-locals (multi-value)
          if (!ft.startsWith(":*") && ft.startsWith(":") && env.types.has(ft.slice(1))) {
            if (isSetter) return ";; ERROR: cannot set embedded struct field directly; use sub-field setters";
            const leaves = valueTypeLeafLocals(varName + "_" + field, ft.slice(1), env);
            let out = "";
            for (let k = 0; k < leaves.length; k++) {
              if (out.length > 0) out += " ";
              out += "(local.get $" + leaves[k] + ")";
            }
            return out;
          }
        }
        // Scalar or pointer field
        if (isSetter) {
          const val = codegenExpr(list.children[2], env, locals, false);
          return "(local.set $" + varName + "_" + field + " " + val + ")";
        }
        return "(local.get $" + varName + "_" + field + ")";
      }
      // Value-type struct *global* field accessor → global.get/set
      if (env.globals.has(varName) && env.globals.get(varName).isValueType &&
          env.globals.get(varName).typeName == ":" + typeName) {
        if (isSetter) {
          const val = codegenExpr(list.children[2], env, locals, false);
          return "(global.set $" + varName + "_" + field + " " + val + ")";
        }
        return "(global.get $" + varName + "_" + field + ")";
      }
    }
    const ptr      = codegenExpr(list.children[1], env, locals, false);
    if (isSetter) {
      const val = codegenExpr(list.children[2], env, locals, false);
      return expandFieldSet(typeName, field, ptr, val, env);
    }
    return expandFieldGet(typeName, field, ptr, env);
  }

  // ── (fn-ref name) — produce the call-table index of a named function ─────
  if (op == "fn-ref") {
    const name = (list.children[1] as SymbolNode).name;
    return watI32Const(registerFuncRef(name, env));
  }

  // ── Calling a function-typed local via call_indirect ──────────────────────
  if (locals.has(op) && locals.get(op).startsWith(":func:")) {
    const typeKey = locals.get(op).slice(6);
    const callOp = emitTC ? "return_call_indirect" : "call_indirect";
    let out = "(" + callOp + " (type $" + typeKey + ")";
    for (let i = 1; i < list.children.length; i++) {
      out += " " + codegenExpr(list.children[i], env, locals, false);
    }
    out += " " + watLocalGet(op) + ")";
    return out;
  }

  // ── Value-type struct constructor: (Point 10 20) — push field values inline ─
  // Used when returned from a function, passed as an argument, or used in any
  // non-let context.  The let branches handle `:Point` / `:*Point` specially.
  if (env.types.has(op)) {
    let out = "";
    for (let i = 1; i < list.children.length; i++) {
      if (i > 1) out += "\n    ";
      out += codegenExpr(list.children[i], env, locals, false);
    }
    return out;
  }

  // ── (call name args...) or implicit call (name args...) ───────────────────
  const args = new Array<string>();
  for (let i = 1; i < list.children.length; i++) {
    args.push(codegenExpr(list.children[i], env, locals, false));
  }
  let knownFunc = false;
  for (let i = 0; i < env.imports.length; i++) {
    if (env.imports[i].localName == op) { knownFunc = true; break; }
  }
  if (!knownFunc && (env.funcBodies.has(op) || env.funcResultTypes.has(op))) knownFunc = true;
  if (!knownFunc) env.errors.push("undefined function '" + op + "'");
  return emitTC ? watReturnCall(op, args) : watCall(op, args);
}

// ─── Helpers for single-use let inlining ─────────────────────────────────────

// Count non-overlapping occurrences of needle in haystack.
function countOccurrences(haystack: string, needle: string): i32 {
  let count: i32 = 0;
  let idx: i32 = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found == -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

// Returns true when the WAT snippet has no observable side effects:
// no function calls, no memory loads/stores, no global reads.
function isPureWat(wat: string): bool {
  return !wat.includes("call ")
      && !wat.includes(".load")
      && !wat.includes(".store")
      && !wat.includes("global.");
}

// Replace the first occurrence of search with replacement in str.
function replaceFirst(str: string, search: string, replacement: string): string {
  const idx = str.indexOf(search);
  if (idx == -1) return str;
  return str.slice(0, idx) + replacement + str.slice(idx + search.length);
}

// Collect the variable names appearing as (local.get $name) operands in wat.
function extractLocalGetNames(wat: string): Array<string> {
  const names = new Array<string>();
  const prefix = "(local.get $";
  let idx: i32 = 0;
  while (true) {
    const found = wat.indexOf(prefix, idx);
    if (found == -1) break;
    const start = found + prefix.length;
    let end = start;
    while (end < wat.length && wat.charCodeAt(end) != 41 /* ) */) end++;
    names.push(wat.slice(start, end));
    idx = found + prefix.length;
  }
  return names;
}

// Returns true if any of the given variable names are written (local.set) in
// body[0..beforeIdx) — i.e., before the inlining candidate's use site.
function anyLocalSetBefore(names: Array<string>, body: string, beforeIdx: i32): bool {
  const prefix = body.slice(0, beforeIdx);
  for (let i = 0; i < names.length; i++) {
    if (prefix.includes("(local.set $" + names[i] + " ")) return true;
  }
  return false;
}


