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
         TAG_INT, TAG_FLOAT, TAG_SYMBOL, TAG_LIST } from "./ast";
import { Env, OpInfo } from "./env";
import { ExpandedForm } from "./expander";
import { expandFieldGet, expandFieldSet } from "./macros";
import {
  watI32Const, watF32Const, watF64Const, watI64Const,
  watLocalGet, watLocalSet, watLocalDecl,
  watI32Store, watI32Store8, watI32Load8u,
  watIf, watBlock, watLoop, watBrIf, watBr,
  watCall, watDrop, watReturn,
} from "./primitives";

// ─── Public entry point ───────────────────────────────────────────────────────

export function generateModule(forms: Array<ExpandedForm>, env: Env): string {
  // Codegen all top-level (defn ...) forms, keyed by function name
  for (let i = 0; i < forms.length; i++) {
    const node = forms[i].node;
    if (node.tag == TAG_LIST) {
      const list = node as ListNode;
      if (list.children.length > 0 && list.children[0].tag == TAG_SYMBOL) {
        const head = (list.children[0] as SymbolNode).name;
        if (head == "defn") {
          const name = (list.children[1] as SymbolNode).name;
          const wat  = codegenDefn(list, env);
          env.funcBodies.set(name, wat);
          env.funcNames.push(name);
        }
      }
    }
  }

  return assembleModule(env);
}

// ─── WAT type helper ──────────────────────────────────────────────────────────

// Convert a woua type keyword to a WAT primitive type name.
// Known primitives: :i32 :i64 :f32 :f64 :ptr
// User-defined struct types (e.g. :Iovec) are pointer-sized → i32.
function watType(t: string): string {
  if (t == ":i32" || t == ":ptr") return "i32";
  if (t == ":i64")                 return "i64";
  if (t == ":f32")                 return "f32";
  if (t == ":f64")                 return "f64";
  // User-defined type name — struct instances are always heap pointers (i32)
  return "i32";
}

// ─── Module assembly ──────────────────────────────────────────────────────────

function assembleModule(env: Env): string {
  let out = "(module\n";

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

  // Linear memory
  out += "  (memory 1)\n";
  out += '  (export "memory" (memory 0))\n\n';

  // Data sections from defstatic
  for (let i = 0; i < env.dataEntries.length; i++) {
    out += "  " + env.dataEntries[i] + "\n";
  }
  if (env.dataEntries.length > 0) out += "\n";

  // Bump allocator: alloc(size i32) → ptr i32
  // $heap_ptr global is initialised to the end of static data (memoryOffset,
  // aligned to 4 bytes) so that allocations never overlap the data section.
  const alignedHeap = (env.memoryOffset + 3) & ~3;
  out += "  (global $heap_ptr (mut i32) (i32.const " + alignedHeap.toString() + "))\n\n";
  out += "  (func $alloc (param $size i32) (result i32)\n";
  out += "    (local $ptr i32)\n";
  out += "    (local.set $ptr (global.get $heap_ptr))\n";
  out += "    (global.set $heap_ptr (i32.add (local.get $ptr) (local.get $size)))\n";
  out += "    (local.get $ptr)\n";
  out += "  )\n\n";

  // User-defined functions — dead code elimination.
  // Walk reachable set starting from "main", following (call $name) references.
  const reachable = new Set<string>();
  const queue     = new Array<string>();
  queue.push("main");
  while (queue.length > 0) {
    const fname = queue.shift();
    if (reachable.has(fname)) continue;
    reachable.add(fname);
    if (!env.funcBodies.has(fname)) continue;
    const body = env.funcBodies.get(fname)!;
    // Scan for (call $foo) references in the WAT body
    let pos = 0;
    while (pos < body.length) {
      const idx = body.indexOf("(call $", pos);
      if (idx == -1) break;
      let end = idx + 7;
      while (end < body.length) {
        const c = body.charAt(end);
        if (c == " " || c == ")" || c == "\n" || c == "\t") break;
        end++;
      }
      const callee = body.slice(idx + 7, end);
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
      out += env.funcBodies.get(fname)! + "\n";
    }
  }

  // Export _start pointing to the last defined function named "main"
  out += '\n  (export "_start" (func $main))\n';

  out += ")\n";
  return out;
}

// ─── Type inference helpers ──────────────────────────────────────────────────

// Normalize a woua type for overload matching.
// :ptr and user-defined struct types are heap pointers → treated as :i32.
function normalizeType(t: string): string {
  if (t == ":i32" || t == ":ptr") return ":i32";
  if (t == ":i64")                 return ":i64";
  if (t == ":f32")                 return ":f32";
  if (t == ":f64")                 return ":f64";
  return ":i32"; // user-defined struct type (pointer)
}

// Copy a locals map (name → type) for use in a new inner scope.
function copyLocals(locals: Map<string, string>): Map<string, string> {
  const copy = new Map<string, string>();
  const keys = locals.keys();
  for (let i = 0; i < keys.length; i++) copy.set(keys[i], locals.get(keys[i])!);
  return copy;
}

// Find the matching OpInfo overload for an operator given inferred argument types.
// Falls back to the first registered overload when no exact match is found.
function resolveOp(name: string, argTypes: Array<string>, env: Env): OpInfo | null {
  if (!env.ops.has(name)) return null;
  const overloads = env.ops.get(name)!;
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
  if (node.tag == TAG_SYMBOL) {
    const sym = (node as SymbolNode).name;
    return locals.has(sym) ? locals.get(sym)! : ":i32";
  }
  if (node.tag == TAG_LIST) {
    const list = node as ListNode;
    if (list.children.length == 0) return "";
    if (list.children[0].tag != TAG_SYMBOL) return ":i32";
    const op = (list.children[0] as SymbolNode).name;
    if (op == "as") return (list.children[1] as SymbolNode).name;
    if (op == "set!" || op == "drop" || op == "i32.store" || op == "i32.store8") return "";
    if (op.includes("/") && op.endsWith("!")) return ""; // struct setter → void
    if (op == "let") {
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
      const ext = copyLocals(locals);
      ext.set(letName, typeAnnot);
      return typeOf(list.children[list.children.length - 1], env, ext);
    }
    if (op == "if" && list.children.length > 2) {
      return typeOf(list.children[2], env, locals);
    }
    if (op == "while") return ""; // while is always void
    if (env.ops.has(op)) {
      const argTypes = new Array<string>();
      for (let i = 1; i < list.children.length; i++) {
        argTypes.push(typeOf(list.children[i], env, locals));
      }
      const resolved = resolveOp(op, argTypes, env);
      return resolved != null ? resolved.result : ":i32";
    }
    // struct getter (TypeName/field ptr) → field type
    if (op.includes("/")) {
      const slash = op.indexOf("/");
      const typeName = op.substring(0, slash);
      const field = op.substring(slash + 1);
      if (env.types.has(typeName)) {
        const typeInfo = env.types.get(typeName)!;
        if (typeInfo.fields.has(field)) return typeInfo.fields.get(field)!.typeName;
      }
      return ":i32";
    }
    // Function call (imported or user-defined) — look up return type
    return funcResultType(op, env);
  }
  return ":i32";
}

// Look up the return type of a named function (import or user-defined).
function funcResultType(name: string, env: Env): string {
  for (let i = 0; i < env.imports.length; i++) {
    if (env.imports[i].localName == name) return env.imports[i].result;
  }
  return ":i32"; // user-defined functions default to i32
}

// ─── (defn name (params...) body...) ─────────────────────────────────────────

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
    const letName = (list.children[1] as SymbolNode).name;
    let typeAnnot = "";
    let valIdx    = 2;
    if (list.children[2].tag == TAG_SYMBOL &&
        (list.children[2] as SymbolNode).name.startsWith(":")) {
      typeAnnot = (list.children[2] as SymbolNode).name;
      valIdx    = 3;
    }
    // Merge param + already-found let locals for type inference on the value
    const allLocals = copyLocals(paramLocals);
    const keys = letLocals.keys();
    for (let k = 0; k < keys.length; k++) allLocals.set(keys[k], letLocals.get(keys[k])!);
    if (typeAnnot == "") typeAnnot = typeOf(list.children[valIdx], env, allLocals);
    if (!letLocals.has(letName)) letLocals.set(letName, typeAnnot);
    // Recurse into value and body children
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
  // list = (defn  name  (params...)  body...)
  //          [0]  [1]     [2]         [3..]
  const name   = (list.children[1] as SymbolNode).name;
  const params = list.children[2] as ListNode;

  // Build locals map: param name → type.
  // Syntax: (name :Type name :Type ...) — type annotation is optional, defaults to :i32.
  const paramLocals = new Map<string, string>();
  const paramNames  = new Array<string>();
  for (let i = 0; i < params.children.length; i++) {
    const pname = (params.children[i] as SymbolNode).name;
    paramNames.push(pname);
    // Peek at next child: if it starts with ':', it's a type annotation.
    let ptype = ":i32";
    if (i + 1 < params.children.length) {
      const next = params.children[i + 1] as SymbolNode;
      if (next.name.length > 0 && next.name.charAt(0) == ":") {
        ptype = next.name;
        i++; // consume the type token
      }
    }
    paramLocals.set(pname, ptype);
  }

  // Collect all let-bindings from the body so we can hoist their (local ...)
  // declarations before any instructions (WAT requires this).
  const letLocals = new Map<string, string>();
  for (let i = 3; i < list.children.length; i++) {
    collectLetLocals(list.children[i], env, paramLocals, letLocals);
  }

  // Full locals map used for type inference during codegen
  const locals = copyLocals(paramLocals);
  const letKeys = letLocals.keys();
  for (let k = 0; k < letKeys.length; k++) locals.set(letKeys[k], letLocals.get(letKeys[k])!);

  // Build param declarations
  let paramDecls = "";
  for (let i = 0; i < paramNames.length; i++) {
    paramDecls += " (param $" + paramNames[i] + " " + watType(paramLocals.get(paramNames[i])!) + ")";
  }

  // Determine return type via type inference on the last body expression
  const resultType = list.children.length > 3
    ? typeOf(list.children[list.children.length - 1], env, locals)
    : "";
  const resultDecl = resultType != ""
    ? " (result " + watType(resultType) + ")"
    : "";

  // Hoisted local declarations (all let-bindings at the top of the func body)
  let localDecls = "";
  for (let k = 0; k < letKeys.length; k++) {
    localDecls += "\n    " + watLocalDecl(letKeys[k], watType(letLocals.get(letKeys[k])!));
  }

  // Codegen body expressions (let will emit only local.set, not local decl)
  let bodyWat = "";
  for (let i = 3; i < list.children.length; i++) {
    bodyWat += "\n    " + codegenExpr(list.children[i], env, locals);
  }

  return "  (func $" + name + paramDecls + resultDecl
       + localDecls
       + bodyWat
       + "\n  )";
}

// ─── Expression codegen ───────────────────────────────────────────────────────

function codegenExpr(node: Node, env: Env, locals: Map<string, string>): string {

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

  // Symbol — local variable reference
  if (node.tag == TAG_SYMBOL) {
    return watLocalGet((node as SymbolNode).name);
  }

  // List — call or special form
  if (node.tag == TAG_LIST) {
    return codegenList(node as ListNode, env, locals);
  }

  return ";; ERROR: unknown node tag " + node.tag.toString();
}

function codegenList(list: ListNode, env: Env, locals: Map<string, string>): string {
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
    const innerWat   = codegenExpr(inner, env, locals);

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
    let out = "(" + resolved.watOp;
    for (let i = 1; i < list.children.length; i++) {
      out += " " + codegenExpr(list.children[i], env, locals);
    }
    return out + ")";
  }

  // ── (while cond body...) ─────────────────────────────────────────────
  // Compiles to a WAT block/loop pair with br_if for the exit condition.
  if (op == "while") {
    const cond = codegenExpr(list.children[1], env, locals);
    let bodyParts = watBrIf("__while_break", "(i32.eqz " + cond + ")");
    for (let i = 2; i < list.children.length; i++) {
      bodyParts += "\n    " + codegenExpr(list.children[i], env, locals);
    }
    bodyParts += "\n    " + watBr("__while_loop");
    return watBlock("__while_break", watLoop("__while_loop", bodyParts));
  }

  // ── (if cond then else?) ───────────────────────────────────────────────────
  if (op == "if") {
    const cond     = codegenExpr(list.children[1], env, locals);
    const thenExpr = codegenExpr(list.children[2], env, locals);
    const elseExpr = list.children.length > 3
      ? codegenExpr(list.children[3], env, locals)
      : "";
    // Include (result T) when the if produces a value (has an else branch).
    const ifType = list.children.length > 3
      ? typeOf(list.children[2], env, locals)
      : "";
    const resultWat = ifType != "" ? watType(ifType) : "";
    return watIf(cond, thenExpr, elseExpr, resultWat);
  }

  // ── (let name [:Type] val body...) ──────────────────────────────────────────
  // Type annotation is optional; when absent the type is inferred from the value.
  // The (local ...) declaration is hoisted by codegenDefn — we emit only local.set.
  if (op == "let") {
    const letName = (list.children[1] as SymbolNode).name;
    let typeAnnot = "";
    let valIdx    = 2;
    if (list.children[2].tag == TAG_SYMBOL &&
        (list.children[2] as SymbolNode).name.startsWith(":")) {
      typeAnnot = (list.children[2] as SymbolNode).name;
      valIdx    = 3;
    }
    if (typeAnnot == "") typeAnnot = typeOf(list.children[valIdx], env, locals);
    const val       = codegenExpr(list.children[valIdx], env, locals);
    const newLocals = copyLocals(locals);
    newLocals.set(letName, typeAnnot);
    let body = watLocalSet(letName, val);
    for (let i = valIdx + 1; i < list.children.length; i++) {
      body += "\n    " + codegenExpr(list.children[i], env, newLocals);
    }
    return body;
  }

  // ── (set! name val) ────────────────────────────────────────────────────────
  if (op == "set!") {
    const name = (list.children[1] as SymbolNode).name;
    const val  = codegenExpr(list.children[2], env, locals);
    return watLocalSet(name, val);
  }


  // ── (i32.store ptr val) — raw memory write (void) ────────────────────────
  if (op == "i32.store") {
    const ptr = codegenExpr(list.children[1], env, locals);
    const val = codegenExpr(list.children[2], env, locals);
    return watI32Store(ptr, val);
  }
  // ── (i32.store8 ptr val) — single-byte write (void) ───────────
  if (op == "i32.store8") {
    const ptr = codegenExpr(list.children[1], env, locals);
    const val = codegenExpr(list.children[2], env, locals);
    return watI32Store8(ptr, val);
  }

  // ── (i32.load8_u ptr) — unsigned single-byte read ──────────────
  if (op == "i32.load8_u") {
    return watI32Load8u(codegenExpr(list.children[1], env, locals));
  }
  // ── (drop expr) — discard a value (void) ──────────────────────────────────
  if (op == "drop") {
    return watDrop(codegenExpr(list.children[1], env, locals));
  }

  // ── Struct getter: (TypeName/field ptr) ────────────────────────────────────
  // ── Struct setter: (TypeName/field! ptr val) ───────────────────────────────
  if (op.includes("/")) {
    const slash    = op.indexOf("/");
    const typeName = op.substring(0, slash);
    const rawField = op.substring(slash + 1);
    const isSetter = rawField.endsWith("!");
    const field    = isSetter ? rawField.substring(0, rawField.length - 1) : rawField;
    const ptr      = codegenExpr(list.children[1], env, locals);
    if (isSetter) {
      const val = codegenExpr(list.children[2], env, locals);
      return expandFieldSet(typeName, field, ptr, val, env);
    }
    return expandFieldGet(typeName, field, ptr, env);
  }

  // ── (call name args...) or implicit call (name args...) ───────────────────
  const args = new Array<string>();
  for (let i = 1; i < list.children.length; i++) {
    args.push(codegenExpr(list.children[i], env, locals));
  }
  return watCall(op, args);
}


