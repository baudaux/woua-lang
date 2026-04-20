// Expander — walks the AST and processes all compile-time macro forms.
// Compile-time macros (defstatic, deftype, defmacro) are consumed here and
// produce no output node — they only update the Env.
// User-defined macros are expanded recursively wherever they appear.
// Other forms are passed through to codegen.

import { Node, ListNode, SymbolNode, IntNode, StringNode, RegexNode,
         MacroListNode, CommentNode,
         TAG_INT, TAG_LIST, TAG_SYMBOL, TAG_STRING, TAG_REGEX, TAG_MACROLIST,
         TAG_COMMENT } from "./ast";
import { Env, MacroInfo, ImportInfo, OpInfo, LiteralInfo } from "./env";
import { expandDefstatic, expandDeftype, internString } from "./macros";
import { watData } from "./primitives";

// A form that survives expansion — either a (defn ...) or a top-level expression
export class ExpandedForm {
  node: Node;
  constructor(node: Node) { this.node = node; }
}

// ── Compile-time integer evaluation ──────────────────────────────────────────

// Wrapper for nullable i64 (AssemblyScript can't return primitive | null).
class IntVal { value: i64; constructor(v: i64) { this.value = v; } }

// Extract the original string content from a node:
//   StringNode(s)                → s
//   SymbolNode("__str:s")       → s  (interned form)
//   anything else               → null
function getStringContent(node: Node): string | null {
  if (node.tag == TAG_STRING) return (node as StringNode).value;
  if (node.tag == TAG_SYMBOL) {
    const n = (node as SymbolNode).name;
    if (n.startsWith("__str:")) return n.slice(6);
  }
  return null;
}

// Evaluate a node as a compile-time integer, or return null.
// Handles: IntNode, (string-length str), (string-byte-at str idx),
//          (macro-empty? list), arithmetic (+,-,*) and comparisons (=,<,>,<=,>=,!=).
function evalConstInt(node: Node): IntVal | null {
  if (node.tag == TAG_INT) return new IntVal((node as IntNode).value);
  if (node.tag != TAG_LIST) return null;
  const list = node as ListNode;
  if (list.children.length == 0 || list.children[0].tag != TAG_SYMBOL) return null;
  const op = (list.children[0] as SymbolNode).name;

  if (op == "string-length" && list.children.length == 2) {
    const s = getStringContent(list.children[1]);
    if (s != null) return new IntVal(s!.length as i64);
    return null;
  }
  if (op == "string-byte-at" && list.children.length == 3) {
    const s   = getStringContent(list.children[1]);
    const idx = evalConstInt(list.children[2]);
    if (s != null && idx != null) {
      const i = i32(idx!.value);
      if (i >= 0 && i < s!.length) return new IntVal(s!.charCodeAt(i) as i64);
      return new IntVal(-1 as i64); // out of bounds
    }
    return null;
  }
  if (op == "macro-empty?" && list.children.length == 2) {
    if (list.children[1].tag == TAG_MACROLIST)
      return new IntVal((list.children[1] as MacroListNode).items.length == 0 ? 1 : 0);
    return null;
  }
  if (list.children.length == 3) {
    const a = evalConstInt(list.children[1]);
    const b = evalConstInt(list.children[2]);
    if (a == null || b == null) return null;
    if (op == "+")  return new IntVal(a!.value + b!.value);
    if (op == "-")  return new IntVal(a!.value - b!.value);
    if (op == "*")  return new IntVal(a!.value * b!.value);
    if (op == "=")  return new IntVal(a!.value == b!.value ? 1 : 0);
    if (op == "!=") return new IntVal(a!.value != b!.value ? 1 : 0);
    if (op == "<")  return new IntVal(a!.value <  b!.value ? 1 : 0);
    if (op == ">")  return new IntVal(a!.value >  b!.value ? 1 : 0);
    if (op == "<=") return new IntVal(a!.value <= b!.value ? 1 : 0);
    if (op == ">=") return new IntVal(a!.value >= b!.value ? 1 : 0);
  }
  return null;
}

// ── User-macro expansion ──────────────────────────────────────────────────────

// Recursively walk `node`, expanding any user-defined macro calls found in env.
function expandNode(node: Node, env: Env): Node {
  // String literals are interned immediately on first encounter:
  // allocate static memory and replace the node with a symbol referencing it.
  if (node.tag == TAG_STRING) {
    internString((node as StringNode).value, env);
    return new SymbolNode("__str:" + (node as StringNode).value);
  }
  // MacroListNodes are compile-time only; pass through unchanged unless an
  // intrinsic (macro-first / macro-rest / macro-empty?) consumes them.
  if (node.tag == TAG_MACROLIST) return node;
  // CommentNodes pass through unchanged to codegen.
  if (node.tag == TAG_COMMENT) return node;
  if (node.tag != TAG_LIST) return node;
  const list = node as ListNode;
  if (list.children.length == 0) return node;

  const head = list.children[0];
  if (head.tag == TAG_SYMBOL) {
    const name = (head as SymbolNode).name;

    // ── (printf "fmt" args...) — compile-time printf function generation ─────
    // Intercept before user macros so the intrinsic takes priority over the
    // (defmacro printf ...) definition in io.woua.
    if (name == "printf") {
      return expandPrintf(list, env);
    }

    if (env.macros.has(name)) {
      const macro = env.macros.get(name)!;
      const args  = list.tail();
      // Expand macro call, then recursively expand the result
      return expandNode(expandMacroCall(macro, args, env), env);
    }
    // compile-time sizeof intrinsic (usable outside macro bodies too)
    if (name == "sizeof") {
      const typeName = (list.children[1] as SymbolNode).name;
      if (!env.types.has(typeName)) {
        env.errors.push("sizeof: unknown type '" + typeName + "'");
        return new IntNode(0 as i64);
      }
      return new IntNode(env.types.get(typeName)!.size as i64);
    }
    // compile-time static-ptr / static-len intrinsics
    if (name == "static-ptr" || name == "static-len") {
      const argNode = expandNode(list.children[1], env);
      const symName = (argNode as SymbolNode).name;
      if (!env.statics.has(symName)) {
        env.errors.push(name + ": unknown static '" + symName + "'");
        return new IntNode(0 as i64);
      }
      const info = env.statics.get(symName)!;
      const val = name == "static-ptr" ? info.ptr as i64 : info.len as i64;
      return new IntNode(val);
    }

    // ── (string-length str) — compile-time string length ────────────────────
    // ── (string-byte-at str idx) — compile-time byte value at index ───────
    if (name == "string-length" || name == "string-byte-at") {
      const v = evalConstInt(list);
      if (v != null) return new IntNode(v!.value);
      env.errors.push(name + ": arguments must be compile-time string/integer constants");
      return new IntNode(0 as i64);
    }

    // ── (macro-empty? list) — 1 if the compile-time list is empty, 0 otherwise ─
    if (name == "macro-empty?") {
      const inner = expandNode(list.children[1], env);
      if (inner.tag == TAG_MACROLIST)
        return new IntNode((inner as MacroListNode).items.length == 0 ? 1 : 0);
      env.errors.push("macro-empty?: argument is not a macro list");
      return new IntNode(0 as i64);
    }

    // ── (macro-first list) — first element of a compile-time list ───────────
    if (name == "macro-first") {
      const inner = expandNode(list.children[1], env);
      if (inner.tag == TAG_MACROLIST) {
        const items = (inner as MacroListNode).items;
        if (items.length == 0) {
          env.errors.push("macro-first: empty list");
          return new IntNode(0 as i64);
        }
        return expandNode(items[0], env);
      }
      env.errors.push("macro-first: argument is not a macro list");
      return new IntNode(0 as i64);
    }

    // ── (macro-rest list) — tail of a compile-time list ───────────────────
    if (name == "macro-rest") {
      const inner = expandNode(list.children[1], env);
      if (inner.tag == TAG_MACROLIST) {
        const items = (inner as MacroListNode).items;
        const rest  = new Array<Node>();
        for (let k = 1; k < items.length; k++) rest.push(items[k]);
        return new MacroListNode(rest);
      }
      env.errors.push("macro-rest: argument is not a macro list");
      return new IntNode(0 as i64);
    }

    // ── (macro-if cond then else?) — compile-time conditional ──────────────
    // Only the taken branch is expanded (enables recursive macros to terminate).
    if (name == "macro-if") {
      const condNode = expandNode(list.children[1], env);
      const cv = evalConstInt(condNode);
      if (cv == null) {
        env.errors.push("macro-if: condition is not a compile-time integer");
        return new IntNode(0 as i64);
      }
      if (cv!.value != 0) return expandNode(list.children[2], env);
      if (list.children.length > 3) return expandNode(list.children[3], env);
      return new IntNode(0 as i64);
    }

    // ── (macro-seq expr...) — sequence side-effectful expressions ───────────
    // With 0 exprs → 0. With 1 expr → that expr. With N → (let __macro_seq :i32 0 ...)
    if (name == "macro-seq") {
      if (list.children.length <= 1) return new IntNode(0 as i64);
      if (list.children.length == 2) return expandNode(list.children[1], env);
      const seq = new ListNode();
      seq.children.push(new SymbolNode("let"));
      seq.children.push(new SymbolNode("__macro_seq"));
      seq.children.push(new SymbolNode(":i32"));
      seq.children.push(new IntNode(0 as i64));
      for (let k = 1; k < list.children.length; k++) seq.children.push(list.children[k]);
      return expandNode(seq, env);
    }

    // ── (macro-do list) — sequence all items of a compile-time MacroListNode ─
    // Like (macro-seq ...) but takes a single MacroListNode and splices its items.
    if (name == "macro-do") {
      const inner = expandNode(list.children[1], env);
      if (inner.tag != TAG_MACROLIST) return expandNode(inner, env);
      const items = (inner as MacroListNode).items;
      if (items.length == 0) return new IntNode(0 as i64);
      if (items.length == 1) return expandNode(items[0], env);
      const seq = new ListNode();
      seq.children.push(new SymbolNode("macro-seq"));
      for (let k = 0; k < items.length; k++) seq.children.push(items[k]);
      return expandNode(seq, env);
    }
  }

  // Not a macro call — recursively expand children
  const result = new ListNode();
  for (let i = 0; i < list.children.length; i++) {
    result.children.push(expandNode(list.children[i], env));
  }
  return result;
}

// Substitute macro params with actual args in the macro body template.
// Fixed params are bound by position; the rest param (if any) is bound to
// a MacroListNode wrapping all remaining args.
function expandMacroCall(macro: MacroInfo, args: Array<Node>, env: Env): Node {
  const subst = new Map<string, Node>();
  for (let i = 0; i < macro.params.length; i++) {
    if (i < args.length) subst.set(macro.params[i], args[i]);
  }
  if (macro.restParam != "") {
    const restItems = new Array<Node>();
    for (let i = macro.params.length; i < args.length; i++) restItems.push(args[i]);
    subst.set(macro.restParam, new MacroListNode(restItems));
  }
  return substituteNode(macro.body, subst, env);
}

// Walk a node, replacing param symbols with arg nodes and evaluating
// compile-time intrinsics:
//   (static-ptr sym) → IntNode with the static's memory pointer
//   (static-len sym) → IntNode with the static's byte length
//   (sizeof TypeName) → IntNode with the struct's byte size
function substituteNode(node: Node, subst: Map<string, Node>, env: Env): Node {
  // String literals are interned immediately — they become static symbols.
  if (node.tag == TAG_STRING) {
    internString((node as StringNode).value, env);
    return new SymbolNode("__str:" + (node as StringNode).value);
  }
  // MacroListNodes: recursively substitute inside each item.
  if (node.tag == TAG_MACROLIST) {
    const ml = node as MacroListNode;
    const newItems = new Array<Node>();
    for (let k = 0; k < ml.items.length; k++)
      newItems.push(substituteNode(ml.items[k], subst, env));
    return new MacroListNode(newItems);
  }
  if (node.tag == TAG_SYMBOL) {
    const name = (node as SymbolNode).name;
    if (subst.has(name)) {
      const sub = subst.get(name)!;
      // A macro argument that is a string literal must also be interned here.
      if (sub.tag == TAG_STRING) {
        internString((sub as StringNode).value, env);
        return new SymbolNode("__str:" + (sub as StringNode).value);
      }
      return sub;
    }
    return node;
  }
  if (node.tag == TAG_LIST) {
    const list = node as ListNode;
    if (list.children.length > 0 && list.children[0].tag == TAG_SYMBOL) {
      const head = (list.children[0] as SymbolNode).name;
      if (head == "static-ptr" || head == "static-len") {
        // By the time we get here, the arg is always a SymbolNode
        // (strings were already interned above into __str:... symbols).
        const argNode = substituteNode(list.children[1], subst, env);
        const symName = (argNode as SymbolNode).name;
        if (!env.statics.has(symName)) {
          env.errors.push(head + ": unknown static '" + symName + "'");
          return new IntNode(0 as i64);
        }
        const info = env.statics.get(symName)!;
        const val = head == "static-ptr" ? info.ptr as i64 : info.len as i64;
        return new IntNode(val);
      }
      if (head == "sizeof") {
        const argNode  = substituteNode(list.children[1], subst, env);
        const typeName = (argNode as SymbolNode).name;
        if (!env.types.has(typeName)) {
          env.errors.push("sizeof: unknown type '" + typeName + "'");
          return new IntNode(0 as i64);
        }
        return new IntNode(env.types.get(typeName)!.size as i64);
      }
    }
    const result = new ListNode();
    for (let i = 0; i < list.children.length; i++) {
      result.children.push(substituteNode(list.children[i], subst, env));
    }
    return result;
  }
  return node;
}

// ── printf compile-time code generation ──────────────────────────────────────

// Parse a printf format string into segments.
// Returns an array of strings:
//   "L:<ptr>:<len>"  — literal text, already allocated in static memory
//   "A:i32"          — %d or %i argument (i32)
//   "A:i64"          — %ld / %li argument (i64)
//   "A:str"          — %s argument (String struct pointer, i32)
//   "A:char"         — %c argument (i32 byte value)
// Also fills argTypes with the WAT type ("i32" or "i64") per argument.
// Extract only the argument type sequence from a printf format string, without
// allocating any static data or touching env. Used for function name generation.
function printfArgTypes(fmt: string): Array<string> {
  const types = new Array<string>();
  let i: i32 = 0;
  while (i < fmt.length) {
    if (fmt.charAt(i) == "%" && i + 1 < fmt.length) {
      i++;
      const spec = fmt.charAt(i);
      if (spec == "d" || spec == "i" || spec == "s" || spec == "c") { types.push("i32"); i++; }
      else if (spec == "l") { types.push("i64"); i += 2; }
      else i++;
    } else {
      i++;
    }
  }
  return types;
}

function parsePrintfFormat(fmt: string, argTypes: Array<string>, env: Env): Array<string> {
  const segments = new Array<string>();
  let litBuf = "";

  let i: i32 = 0;
  while (i < fmt.length) {
    const c = fmt.charAt(i);
    if (c == "%") {
      i++;
      if (i >= fmt.length) { litBuf += "%"; break; }
      const spec = fmt.charAt(i);
      // Flush accumulated literal chars into a static data segment
      if (litBuf.length > 0) {
        const ptr = env.allocate(litBuf.length, 1);
        env.dataEntries.push(watData(ptr, litBuf));
        segments.push("L:" + ptr.toString() + ":" + litBuf.length.toString());
        litBuf = "";
      }
      if (spec == "d" || spec == "i") { segments.push("A:i32");  argTypes.push("i32"); i++; }
      else if (spec == "s")           { segments.push("A:str");  argTypes.push("i32"); i++; }
      else if (spec == "c")           { segments.push("A:char"); argTypes.push("i32"); i++; }
      else if (spec == "l")           { i++; i++; segments.push("A:i64"); argTypes.push("i64"); }
      else if (spec == "%")           { litBuf += "%"; i++; }
      else                            { litBuf += "%" + spec; i++; }
    } else {
      litBuf += c;
      i++;
    }
  }
  // Flush remaining literal
  if (litBuf.length > 0) {
    const ptr = env.allocate(litBuf.length, 1);
    env.dataEntries.push(watData(ptr, litBuf));
    segments.push("L:" + ptr.toString() + ":" + litBuf.length.toString());
  }
  return segments;
}

// Build the WAT function body for a printf-generated function.
function buildPrintfFunc(fmt: string, funcName: string, env: Env): string {
  const argTypes = new Array<string>();
  const segments = parsePrintfFormat(fmt, argTypes, env);

  // Function signature — returns i32 so typeOf(call) is :i32 at call sites
  // Escape double-quotes in the format string for the WAT comment
  let escFmt = "";
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt.charAt(i);
    if (ch == "\"") { escFmt += "\\\""; }
    else if (ch == "\n") { escFmt += "\\n"; }
    else { escFmt += ch; }
  }
  let wat = "  (; printf \"" + escFmt + "\" ;)\n  (func $" + funcName;
  for (let j = 0; j < argTypes.length; j++) {
    wat += " (param $a" + j.toString() + " " + argTypes[j] + ")";
  }
  wat += " (result i32)\n";
  if (segments.length > 0) {
    wat += "    (local $__s i32)\n";
    wat += "    (local $__iov i32)\n";
  }

  // Function body
  let curArg: i32 = 0;
  for (let j = 0; j < segments.length; j++) {
    const seg = segments[j];
    if (seg.startsWith("L:")) {
      // Literal segment — write static bytes via fd_write
      const colon1 = seg.indexOf(":", 2) as i32;
      const ptr    = i32(I64.parseInt(seg.slice(2, colon1)));
      const len    = i32(I64.parseInt(seg.slice(colon1 + 1)));
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (i32.const " + ptr.toString() + "))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (i32.const " + len.toString() + "))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
    } else if (seg == "A:i32") {
      // i32 → decimal string via $i32->string
      wat += "    (local.set $__s (call $i32->string (local.get $a" + curArg.toString() + ")))\n";
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (i32.load (local.get $__s)))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (i32.load (i32.add (local.get $__s) (i32.const 4))))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
      curArg++;
    } else if (seg == "A:i64") {
      // i64 → decimal string via $i64->string
      wat += "    (local.set $__s (call $i64->string (local.get $a" + curArg.toString() + ")))\n";
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (i32.load (local.get $__s)))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (i32.load (i32.add (local.get $__s) (i32.const 4))))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
      curArg++;
    } else if (seg == "A:str") {
      // String struct arg — ptr at offset 0, len at offset 4
      const an = "$a" + curArg.toString();
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (i32.load (local.get " + an + ")))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (i32.load (i32.add (local.get " + an + ") (i32.const 4))))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
      curArg++;
    } else if (seg == "A:char") {
      // Single byte arg — store byte then fd_write 1 byte
      wat += "    (local.set $__s (call $alloc (i32.const 4)))\n";
      wat += "    (i32.store8 (local.get $__s) (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (local.get $__s))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (i32.const 1))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
      curArg++;
    }
  }
  wat += "    (i32.const 0)\n";
  wat += "  )\n";
  return wat;
}

// Expand a (printf "fmt" args...) call to (call $__printf_N args...).
// Generates the $__printf_N function on first encounter of each format string.
function expandPrintf(list: ListNode, env: Env): Node {
  if (list.children.length < 2) {
    env.errors.push("printf: expected a format string argument");
    return new IntNode(0 as i64);
  }
  // Extract format string — accept StringNode or pre-interned __str: symbol
  const fmtArg = list.children[1];
  let fmtStr = "";
  if (fmtArg.tag == TAG_STRING) {
    fmtStr = (fmtArg as StringNode).value;
  } else if (fmtArg.tag == TAG_SYMBOL) {
    const sym = (fmtArg as SymbolNode).name;
    if (sym.startsWith("__str:")) {
      fmtStr = sym.slice(6);
    } else {
      env.errors.push("printf: format must be a string literal (got '" + sym + "')");
      return new IntNode(0 as i64);
    }
  } else {
    env.errors.push("printf: format must be a compile-time string literal");
    return new IntNode(0 as i64);
  }

  // Get or generate the dedicated function for this format string
  let funcName = "";
  if (env.printfFuncsByFmt.has(fmtStr)) {
    funcName = env.printfFuncsByFmt.get(fmtStr)!;
  } else {
    // Derive base name from argument types: __printf_i32, __printf_i32_i64, etc.
    const probeTypes = printfArgTypes(fmtStr);
    const typeSig = probeTypes.length > 0 ? probeTypes.join("_") : "str";
    const baseName = "__printf_" + typeSig;
    // Disambiguate collisions with a suffix counter
    const count = env.printfNameCounts.has(baseName) ? env.printfNameCounts.get(baseName)! : 0;
    env.printfNameCounts.set(baseName, count + 1);
    funcName = count == 0 ? baseName : baseName + "_" + (count + 1).toString();
    env.printfFuncsByFmt.set(fmtStr, funcName);
    const body = buildPrintfFunc(fmtStr, funcName, env);
    env.funcBodies.set(funcName, body);
    env.funcNames.push(funcName);
  }

  // Return (drop (funcName arg1 arg2 ...)) — printf is always a statement
  const callNode = new ListNode();
  callNode.children.push(new SymbolNode(funcName));
  for (let i = 2; i < list.children.length; i++) {
    callNode.children.push(expandNode(list.children[i], env));
  }
  const dropNode = new ListNode();
  dropNode.children.push(new SymbolNode("drop"));
  dropNode.children.push(callNode);
  return dropNode;
}

// ── Main expansion pass ───────────────────────────────────────────────────────

// Run macro expansion over all top-level forms.
// Returns only the forms that codegen needs to process (defn, top-level exprs).
export function expandAll(forms: Array<Node>, env: Env): Array<ExpandedForm> {
  const result = new Array<ExpandedForm>();

  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];

    // Only lists can be macro calls
    if (form.tag != TAG_LIST) {
      result.push(new ExpandedForm(form));
      continue;
    }

    const list = form as ListNode;
    if (list.children.length == 0) continue;

    const head = list.children[0];
    if (head.tag != TAG_SYMBOL) {
      result.push(new ExpandedForm(expandNode(form, env)));
      continue;
    }

    const headName = (head as SymbolNode).name;

    // ── compile-time macros (consumed, not forwarded to codegen) ────────────
    if (headName == "defstatic") {
      const err = expandDefstatic(list.tail(), env);
      if (err != "") env.errors.push(err);
      continue;
    }

    if (headName == "deftype") {
      const err = expandDeftype(list.tail(), env);
      if (err != "") env.errors.push(err);
      continue;
    }

    // ── (defmacro name (params... [. rest]) body) ──────────────────────────
    if (headName == "defmacro") {
      // children: [defmacro, name, (params...), body]
      // Params may end with ". restName" to capture variadic trailing args.
      const macroName  = (list.children[1] as SymbolNode).name;
      const paramsNode = list.children[2] as ListNode;
      const bodyNode   = list.children[3];
      const params     = new Array<string>();
      let   restParam  = "";
      for (let j = 0; j < paramsNode.children.length; j++) {
        if (paramsNode.children[j].tag != TAG_SYMBOL) {
          env.errors.push("defmacro " + macroName + ": param " + j.toString() + " is not a symbol");
          break;
        }
        const pname = (paramsNode.children[j] as SymbolNode).name;
        if (pname.startsWith("...")) {
          // ...name — variadic rest parameter; collects all remaining args
          restParam = pname.slice(3);
          break;
        }
        params.push(pname);
      }
      env.macros.set(macroName, new MacroInfo(params, restParam, bodyNode));
      continue;
    }

    // ── (defimport name "module" "field" (param-types...) result-type?) ─────
    if (headName == "defimport") {
      // children: [defimport, name, "module", "field", (params...), result?]
      const localName  = (list.children[1] as SymbolNode).name;
      const module_    = (list.children[2] as StringNode).value;
      const field      = (list.children[3] as StringNode).value;
      const paramsNode = list.children[4] as ListNode;
      const params     = new Array<string>();
      for (let j = 0; j < paramsNode.children.length; j++) {
        params.push((paramsNode.children[j] as SymbolNode).name);
      }
      const result = list.children.length >= 6
        ? (list.children[5] as SymbolNode).name
        : "";
      env.imports.push(new ImportInfo(localName, module_, field, params, result));
      continue;
    }

    // ── (defliteral name /regex/ :node-type [:static]) ─────────────────
    if (headName == "defliteral") {
      // children: [defliteral, name, /regex/, :node-type, :static?]
      const litName  = (list.children[1] as SymbolNode).name;
      const pattern  = (list.children[2] as RegexNode).pattern;
      const nodeType = (list.children[3] as SymbolNode).name;
      const isStatic = list.children.length > 4 &&
                       (list.children[4] as SymbolNode).name == ":static";
      env.literals.set(litName, new LiteralInfo(litName, pattern, nodeType, isStatic));
      continue;
    }

    // ── (defop name "wat-op" (param-types...) result-type?) ─────────────────
    if (headName == "defop") {
      // children: [defop, name, "wat-op", (params...), result?]
      const iName      = (list.children[1] as SymbolNode).name;
      const watOp      = (list.children[2] as StringNode).value;
      const paramsNode = list.children[3] as ListNode;
      const iParams    = new Array<string>();
      for (let j = 0; j < paramsNode.children.length; j++) {
        iParams.push((paramsNode.children[j] as SymbolNode).name);
      }
      const iResult = list.children.length >= 5
        ? (list.children[4] as SymbolNode).name
        : "";
      if (!env.ops.has(iName)) env.ops.set(iName, new Array<OpInfo>());
      env.ops.get(iName)!.push(new OpInfo(iName, watOp, iParams, iResult));
      continue;
    }

    // ── everything else: expand user macros recursively, then forward ────────
    result.push(new ExpandedForm(expandNode(form, env)));
  }

  return result;
}
