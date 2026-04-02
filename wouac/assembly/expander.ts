// Expander — walks the AST and processes all compile-time macro forms.
// Compile-time macros (defstatic, deftype, defmacro) are consumed here and
// produce no output node — they only update the Env.
// User-defined macros are expanded recursively wherever they appear.
// Other forms are passed through to codegen.

import { Node, ListNode, SymbolNode, IntNode, StringNode, RegexNode,
         MacroListNode,
         TAG_INT, TAG_LIST, TAG_SYMBOL, TAG_STRING, TAG_REGEX, TAG_MACROLIST } from "./ast";
import { Env, MacroInfo, ImportInfo, OpInfo, LiteralInfo } from "./env";
import { expandDefstatic, expandDeftype, internString } from "./macros";

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
  if (node.tag != TAG_LIST) return node;
  const list = node as ListNode;
  if (list.children.length == 0) return node;

  const head = list.children[0];
  if (head.tag == TAG_SYMBOL) {
    const name = (head as SymbolNode).name;
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
