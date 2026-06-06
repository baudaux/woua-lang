// Expander — walks the AST and processes all compile-time macro forms.
// Compile-time macros (defstatic, deftype, defmacro) are consumed here and
// produce no output node — they only update the Env.
// User-defined macros are expanded recursively wherever they appear.
// Other forms are passed through to codegen.

import { Node, ListNode, SymbolNode, IntNode, FloatNode, StringNode, RegexNode,
         MacroListNode, CommentNode, V128Node,
         TAG_INT, TAG_FLOAT, TAG_LIST, TAG_SYMBOL, TAG_STRING, TAG_REGEX, TAG_MACROLIST,
         TAG_COMMENT, TAG_V128 } from "./ast";
import { Env, MacroInfo, ImportInfo, OpInfo, LiteralInfo, ProtocolInfo, ProtocolMethodSig, GlobalInfo } from "./env";

// Register one WAT global per leaf field of a value-type struct.
// Recurses into embedded structs so nested value types are fully flattened.
function registerValueTypeSubGlobals(prefix: string, typeName: string, env: Env): void {
  const typeInfo = env.types.get(typeName);
  const fnames = typeInfo.fieldNames;
  for (let fi = 0; fi < fnames.length; fi++) {
    const fname = fnames[fi];
    const ft    = typeInfo.fields.get(fname).typeName;
    const sub   = prefix + "_" + fname;
    // Embedded value-type struct field → recurse
    if (!ft.startsWith(":*") && ft.startsWith(":") && env.types.has(ft.slice(1))) {
      registerValueTypeSubGlobals(sub, ft.slice(1), env);
    } else {
      let initWat: string;
      if (ft == ":i64")       initWat = "(i64.const 0)";
      else if (ft == ":f32")  initWat = "(f32.const 0.0)";
      else if (ft == ":f64")  initWat = "(f64.const 0.0)";
      else                    initWat = "(i32.const 0)";
      env.globals.set(sub, new GlobalInfo(ft, initWat, false));
      env.globalNames.push(sub);
    }
  }
}
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
    if (s != null) return new IntVal(s.length as i64);
    return null;
  }
  if (op == "string-byte-at" && list.children.length == 3) {
    const s   = getStringContent(list.children[1]);
    const idx = evalConstInt(list.children[2]);
    if (s != null && idx != null) {
      const i = i32(idx.value);
      if (i >= 0 && i < s.length) return new IntVal(s.charCodeAt(i) as i64);
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
    if (op == "+")  return new IntVal(a.value + b.value);
    if (op == "-")  return new IntVal(a.value - b.value);
    if (op == "*")  return new IntVal(a.value * b.value);
    if (op == "=")  return new IntVal(a.value == b.value ? 1 : 0);
    if (op == "!=") return new IntVal(a.value != b.value ? 1 : 0);
    if (op == "<")  return new IntVal(a.value <  b.value ? 1 : 0);
    if (op == ">")  return new IntVal(a.value >  b.value ? 1 : 0);
    if (op == "<=") return new IntVal(a.value <= b.value ? 1 : 0);
    if (op == ">=") return new IntVal(a.value >= b.value ? 1 : 0);
  }
  return null;
}

// ── Compile-time constant folding ─────────────────────────────────────────────

// Try to evaluate `node` as a compile-time numeric constant (integer or float).
// Returns an IntNode or FloatNode on success, null if any sub-expression is
// not a compile-time constant.  Previously-defined defconst names are resolved
// via env.macros.  For integer division/modulo by zero, an error is pushed into
// env.errors before returning null.
function constFold(node: Node, env: Env): Node | null {
  if (node.tag == TAG_INT)   return node;
  if (node.tag == TAG_FLOAT) return node;

  // Symbol: resolve as a previously-folded defconst (zero-param macro with literal body).
  if (node.tag == TAG_SYMBOL) {
    const sym = (node as SymbolNode).name;
    if (env.macros.has(sym)) {
      const m = env.macros.get(sym);
      if (m.params.length == 0 && m.restParam == "") {
        const b = m.body;
        if (b.tag == TAG_INT || b.tag == TAG_FLOAT) return b;
      }
    }
    return null;
  }

  if (node.tag != TAG_LIST) return null;
  const list = node as ListNode;
  if (list.children.length != 3) return null;
  if (list.children[0].tag != TAG_SYMBOL) return null;
  const op = (list.children[0] as SymbolNode).name;

  const lhs = constFold(list.children[1], env);
  const rhs = constFold(list.children[2], env);
  if (lhs == null || rhs == null) return null;

  // Both operands are integers.
  if (lhs.tag == TAG_INT && rhs.tag == TAG_INT) {
    const a    = (lhs as IntNode).value;
    const b    = (rhs as IntNode).value;
    const wide: bool = (lhs as IntNode).wide || (rhs as IntNode).wide;
    if (op == "+")   return new IntNode(a + b, wide);
    if (op == "-")   return new IntNode(a - b, wide);
    if (op == "*")   return new IntNode(a * b, wide);
    if (op == "/") {
      if (b == 0) { env.errors.push("defconst: integer division by zero"); return null; }
      return new IntNode(a / b, wide);
    }
    if (op == "%") {
      if (b == 0) { env.errors.push("defconst: modulo by zero"); return null; }
      return new IntNode(a % b, wide);
    }
    if (op == "<<")  return new IntNode(a << b, wide);
    if (op == ">>")  return new IntNode(a >> b, wide);
    if (op == "and") return new IntNode(a & b, wide);
    if (op == "or")  return new IntNode(a | b, wide);
    if (op == "xor") return new IntNode(a ^ b, wide);
    return null;
  }

  // At least one float operand → promote both to f64, result is float.
  if (lhs.tag == TAG_FLOAT || rhs.tag == TAG_FLOAT) {
    const a: f64 = lhs.tag == TAG_INT ? f64((lhs as IntNode).value) : (lhs as FloatNode).value;
    const b: f64 = rhs.tag == TAG_INT ? f64((rhs as IntNode).value) : (rhs as FloatNode).value;
    const wide: bool = (lhs.tag == TAG_FLOAT ? (lhs as FloatNode).wide : false) ||
                       (rhs.tag == TAG_FLOAT ? (rhs as FloatNode).wide : false);
    if (op == "+") return new FloatNode(a + b, wide);
    if (op == "-") return new FloatNode(a - b, wide);
    if (op == "*") return new FloatNode(a * b, wide);
    if (op == "/") return new FloatNode(a / b, wide); // ±Infinity on /0 (IEEE 754)
    return null;
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
  // V128Nodes (SIMD vector literals) pass through unchanged to codegen.
  if (node.tag == TAG_V128) return node;
  // Bare symbol that names a zero-param macro (defconst) → expand immediately.
  if (node.tag == TAG_SYMBOL) {
    const symName = (node as SymbolNode).name;
    if (env.macros.has(symName)) {
      const m = env.macros.get(symName);
      if (m.params.length == 0 && m.restParam == "") {
        return expandNode(expandMacroCall(m, new Array<Node>(), env), env);
      }
    }
    return node;
  }
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

    // ── (sprintf buf "fmt" args...) — write formatted string into a buffer ───
    if (name == "sprintf") {
      return expandSprintf(list, env);
    }

    if (env.macros.has(name)) {
      const macro = env.macros.get(name);
      const args  = list.tail();
      // Expand macro call, then recursively expand the result
      return expandNode(expandMacroCall(macro, args, env), env);
    }
    // compile-time sizeof intrinsic (usable outside macro bodies too)
    if (name == "sizeof") {
      const typeName = (list.children[1] as SymbolNode).name;
      // Primitive types (accept with or without ':' prefix)
      if (typeName == ":i32" || typeName == ":f32" || typeName == ":ptr" ||
          typeName == "i32"  || typeName == "f32"  || typeName == "ptr")  return new IntNode(4 as i64);
      if (typeName == ":i64" || typeName == ":f64" ||
          typeName == "i64"  || typeName == "f64")                        return new IntNode(8 as i64);
      if (typeName.startsWith(":*")) return new IntNode(4 as i64); // heap pointer
      // User-defined struct type (name may come with or without ':')
      const structName = typeName.startsWith(":") ? typeName.slice(1) : typeName;
      if (!env.types.has(structName)) {
        env.errors.push("sizeof: unknown type '" + typeName + "'");
        return new IntNode(0 as i64);
      }
      return new IntNode(env.types.get(structName).size as i64);
    }
    // compile-time static-ptr / static-len / static-ref intrinsics
    if (name == "static-ptr" || name == "static-len" || name == "static-ref") {
      const argNode = expandNode(list.children[1], env);
      const symName = (argNode as SymbolNode).name;
      if (!env.statics.has(symName)) {
        env.errors.push(name + ": unknown static '" + symName + "'");
        return new IntNode(0 as i64);
      }
      const info = env.statics.get(symName);
      // static-ref  → header address (only meaningful for :str statics)
      // static-ptr  → for :str statics, base = hdrPtr+8; otherwise ptr
      // static-len  → byte length
      let val: i64;
      if (name == "static-ref") {
        val = info.ptr as i64;
      } else if (name == "static-ptr") {
        val = info.typeName == ":*str" ? (info.ptr + 8) as i64 : info.ptr as i64;
      } else {
        val = info.len as i64;
      }
      return new IntNode(val);
    }

    // ── (string-length str) — compile-time string length ────────────────────
    // ── (string-byte-at str idx) — compile-time byte value at index ───────
    if (name == "string-length" || name == "string-byte-at") {
      const v = evalConstInt(list);
    if (v != null) return new IntNode(v.value);
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
      if (cv.value != 0) return expandNode(list.children[2], env);
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

    // ── (let* ((n1 v1) (n2 v2) ...) body...) — sequential let bindings ──────
    // Desugars to nested (let n val body) forms so each binding is in scope for
    // the next.  Each pair may be (name val) or (name :Type val).
    if (name == "let*") {
      if (list.children.length < 3 || list.children[1].tag != TAG_LIST) {
        env.errors.push("let*: expected (let* ((name val)...) body...)");
        return new IntNode(0 as i64);
      }
      const bindings = (list.children[1] as ListNode).children;
      const bodyExprs = new Array<Node>();
      for (let i = 2; i < list.children.length; i++) bodyExprs.push(list.children[i]);
      if (bindings.length == 0) {
        if (bodyExprs.length == 0) return new IntNode(0 as i64);
        if (bodyExprs.length == 1) return expandNode(bodyExprs[0], env);
        const seq = new ListNode();
        seq.children.push(new SymbolNode("progn"));
        for (let k = 0; k < bodyExprs.length; k++) seq.children.push(bodyExprs[k]);
        return expandNode(seq, env);
      }
      // Build from inside out: innermost let wraps the body, outer lets wrap that.
      const lastPair = bindings[bindings.length - 1] as ListNode;
      let current = new ListNode();
      current.children.push(new SymbolNode("let"));
      for (let k = 0; k < lastPair.children.length; k++) current.children.push(lastPair.children[k]);
      for (let k = 0; k < bodyExprs.length; k++) current.children.push(bodyExprs[k]);
      for (let b = bindings.length - 2; b >= 0; b--) {
        const pair = bindings[b] as ListNode;
        const outer = new ListNode();
        outer.children.push(new SymbolNode("let"));
        for (let k = 0; k < pair.children.length; k++) outer.children.push(pair.children[k]);
        outer.children.push(current);
        current = outer;
      }
      return expandNode(current, env);
    }

    // ── (cond (test1 expr1) (test2 expr2) ... (else exprN)) ──────────────────
    // Desugars into nested (if test expr ...) forms, right to left.
    // The last clause may use `else` as the test — it becomes an unconditional value.
    // Any clause with multiple body expressions is wrapped in (progn ...).
    if (name == "cond") {
      if (list.children.length < 2) return new IntNode(0 as i64);
      // Build from the last clause inward.
      let current: Node = new IntNode(0 as i64); // fallback when no else clause
      for (let c = list.children.length - 1; c >= 1; c--) {
        if (list.children[c].tag != TAG_LIST) {
          env.errors.push("cond: clause " + c.toString() + " is not a list");
          return new IntNode(0 as i64);
        }
        const clause = list.children[c] as ListNode;
        if (clause.children.length < 2) {
          env.errors.push("cond: each clause must be (test expr...)");
          return new IntNode(0 as i64);
        }
        const test = clause.children[0];
        // Build the clause body: single expr or (progn exprs...)
        let body: Node;
        if (clause.children.length == 2) {
          body = clause.children[1];
        } else {
          const pg = new ListNode();
          pg.children.push(new SymbolNode("progn"));
          for (let k = 1; k < clause.children.length; k++) pg.children.push(clause.children[k]);
          body = pg;
        }
        // `else` clause — becomes the unconditional fallback
        if (test.tag == TAG_SYMBOL && (test as SymbolNode).name == "else") {
          current = body;
        } else {
          const ifNode = new ListNode();
          ifNode.children.push(new SymbolNode("if"));
          ifNode.children.push(test);
          ifNode.children.push(body);
          ifNode.children.push(current);
          current = ifNode;
        }
      }
      return expandNode(current, env);
    }

    // ── (match subject (pat1 expr1) (pat2 expr2) ... (_ exprN)) ──────────────
    // Level-1 scalar pattern matching: patterns are integer/float/char literals
    // or `_` (wildcard, matches anything — equivalent to `else`).
    // The subject is evaluated exactly once (bound to __match_val).
    // Desugars into: (let __match_val subject (if (= __match_val pat1) expr1 ...))
    if (name == "match") {
      if (list.children.length < 3) return new IntNode(0 as i64);
      const subject = list.children[1];
      // Build nested ifs from the last arm inward.
      let current: Node = new IntNode(0 as i64); // fallback when no _ arm
      const tmpName = env.freshName("__match_val_");
      const matchSym = new SymbolNode(tmpName);
      for (let c = list.children.length - 1; c >= 2; c--) {
        if (list.children[c].tag != TAG_LIST) {
          env.errors.push("match: arm " + c.toString() + " is not a list");
          return new IntNode(0 as i64);
        }
        const arm = list.children[c] as ListNode;
        if (arm.children.length < 2) {
          env.errors.push("match: each arm must be (pattern expr...)");
          return new IntNode(0 as i64);
        }
        const pat = arm.children[0];
        // Build arm body: single expr or (progn exprs...)
        let body: Node;
        if (arm.children.length == 2) {
          body = arm.children[1];
        } else {
          const pg = new ListNode();
          pg.children.push(new SymbolNode("progn"));
          for (let k = 1; k < arm.children.length; k++) pg.children.push(arm.children[k]);
          body = pg;
        }
        // `_` wildcard — unconditional fallback
        if (pat.tag == TAG_SYMBOL && (pat as SymbolNode).name == "_") {
          current = body;
        } else {
          // (= __match_val pattern)
          const testNode = new ListNode();
          testNode.children.push(new SymbolNode("="));
          testNode.children.push(matchSym);
          testNode.children.push(pat);
          const ifNode = new ListNode();
          ifNode.children.push(new SymbolNode("if"));
          ifNode.children.push(testNode);
          ifNode.children.push(body);
          ifNode.children.push(current);
          current = ifNode;
        }
      }
      // Wrap in (let __match_val subject body) to evaluate subject once.
      const letNode = new ListNode();
      letNode.children.push(new SymbolNode("let"));
      letNode.children.push(matchSym);
      letNode.children.push(subject);
      letNode.children.push(current);
      return expandNode(letNode, env);
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
  // V128Nodes pass through unchanged (no substitutable parts).
  if (node.tag == TAG_V128) return node;
  if (node.tag == TAG_SYMBOL) {
    const name = (node as SymbolNode).name;
    if (subst.has(name)) {
      const sub = subst.get(name);
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
      if (head == "static-ptr" || head == "static-len" || head == "static-ref") {
        // By the time we get here, the arg is always a SymbolNode
        // (strings were already interned above into __str:... symbols).
        const argNode = substituteNode(list.children[1], subst, env);
        const symName = (argNode as SymbolNode).name;
        if (!env.statics.has(symName)) {
          env.errors.push(head + ": unknown static '" + symName + "'");
          return new IntNode(0 as i64);
        }
        const info = env.statics.get(symName);
        let val: i64;
        if (head == "static-ref") {
          val = info.ptr as i64;
        } else if (head == "static-ptr") {
          val = info.typeName == ":*str" ? (info.ptr + 8) as i64 : info.ptr as i64;
        } else {
          val = info.len as i64;
        }
        return new IntNode(val);
      }
      if (head == "sizeof") {
        const argNode  = substituteNode(list.children[1], subst, env);
        const typeName = (argNode as SymbolNode).name;
        if (typeName == ":i32" || typeName == ":f32" || typeName == ":ptr" ||
            typeName == "i32"  || typeName == "f32"  || typeName == "ptr")  return new IntNode(4 as i64);
        if (typeName == ":i64" || typeName == ":f64" ||
            typeName == "i64"  || typeName == "f64")                        return new IntNode(8 as i64);
        if (typeName.startsWith(":*")) return new IntNode(4 as i64);
        const structName = typeName.startsWith(":") ? typeName.slice(1) : typeName;
        if (!env.types.has(structName)) {
          env.errors.push("sizeof: unknown type '" + typeName + "'");
          return new IntNode(0 as i64);
        }
        return new IntNode(env.types.get(structName).size as i64);
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
      else if (spec == "f") { types.push("f32"); i++; }
      else if (spec == "l") {
        i++; // skip 'l'
        if (i < fmt.length && fmt.charAt(i) == "f") { types.push("f64"); i++; }
        else { types.push("i64"); i++; }
      }
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
      else if (spec == "s")           { segments.push("A:str");  argTypes.push("i32"); argTypes.push("i32"); i++; }
      else if (spec == "c")           { segments.push("A:char"); argTypes.push("i32"); i++; }
      else if (spec == "f")           { segments.push("A:f32");  argTypes.push("f32"); i++; }
      else if (spec == "l") {
        i++; // skip 'l'
        if (i < fmt.length && fmt.charAt(i) == "f") { segments.push("A:f64"); argTypes.push("f64"); i++; }
        else { segments.push("A:i64"); argTypes.push("i64"); i++; }
      }
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

// Build the WAT function body for a sprintf-generated function.
// The generated function takes ($__buf i32, args...) and returns bytes written.
// Literal segments and converted arg strings are copied into the buffer via
// a byte-copy loop; $__pos tracks the current write offset.
function buildSprintfFunc(fmt: string, funcName: string, env: Env): string {
  const argTypes = new Array<string>();
  const segments = parsePrintfFormat(fmt, argTypes, env);

  let escFmt = "";
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt.charAt(i);
    if (ch == "\"") escFmt += "\\\"";
    else if (ch == "\n") escFmt += "\\n";
    else escFmt += ch;
  }

  let wat = "  (; sprintf \"" + escFmt + "\" ;)\n  (func $" + funcName;
  wat += " (param $__buf i32)";
  for (let j = 0; j < argTypes.length; j++) {
    wat += " (param $a" + j.toString() + " " + argTypes[j] + ")";
  }
  wat += " (result i32)\n";
  wat += "    (local $__pos i32)\n";
  wat += "    (local $__s_ptr i32)\n";
  wat += "    (local $__s_len i32)\n";
  wat += "    (local $__i i32)\n";

  // Inline byte-copy helper: copies $__s_len bytes from $__s_ptr to ($__buf+$__pos)
  // emitted as a named block+loop using WAT structured control flow.
  const emitCopy = (): string => {
    let s = "";
    s += "    (local.set $__i (i32.const 0))\n";
    s += "    (block $__cp_brk\n";
    s += "      (loop $__cp_lp\n";
    s += "        (br_if $__cp_brk (i32.ge_u (local.get $__i) (local.get $__s_len)))\n";
    s += "        (i32.store8 (i32.add (i32.add (local.get $__buf) (local.get $__pos)) (local.get $__i))\n";
    s += "                    (i32.load8_u (i32.add (local.get $__s_ptr) (local.get $__i))))\n";
    s += "        (local.set $__i (i32.add (local.get $__i) (i32.const 1)))\n";
    s += "        (br $__cp_lp)))\n";
    s += "    (local.set $__pos (i32.add (local.get $__pos) (local.get $__s_len)))\n";
    return s;
  };

  let curArg: i32 = 0;
  for (let j = 0; j < segments.length; j++) {
    const seg = segments[j];
    if (seg.startsWith("L:")) {
      const colon1 = seg.indexOf(":", 2) as i32;
      const ptr    = i32(I64.parseInt(seg.slice(2, colon1)));
      const len    = i32(I64.parseInt(seg.slice(colon1 + 1)));
      wat += "    (local.set $__s_ptr (i32.const " + ptr.toString() + "))\n";
      wat += "    (local.set $__s_len (i32.const " + len.toString() + "))\n";
      wat += emitCopy();
    } else if (seg == "A:i32") {
      wat += "    (call $i32->str (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__s_len)\n";
      wat += "    (local.set $__s_ptr)\n";
      wat += emitCopy();
      curArg++;
    } else if (seg == "A:i64") {
      wat += "    (call $i64->str (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__s_len)\n";
      wat += "    (local.set $__s_ptr)\n";
      wat += emitCopy();
      curArg++;
    } else if (seg == "A:str") {
      wat += "    (local.set $__s_ptr (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__s_len (local.get $a" + (curArg + 1).toString() + "))\n";
      wat += emitCopy();
      curArg += 2;
    } else if (seg == "A:char") {
      // Single byte — store directly then advance pos by 1
      wat += "    (i32.store8 (i32.add (local.get $__buf) (local.get $__pos)) (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__pos (i32.add (local.get $__pos) (i32.const 1)))\n";
      curArg++;
    } else if (seg == "A:f32") {
      wat += "    (call $f32->str (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__s_len)\n";
      wat += "    (local.set $__s_ptr)\n";
      wat += emitCopy();
      curArg++;
    } else if (seg == "A:f64") {
      wat += "    (call $f64->str (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__s_len)\n";
      wat += "    (local.set $__s_ptr)\n";
      wat += emitCopy();
      curArg++;
    }
  }
  wat += "    (local.get $__pos)\n";
  wat += "  )\n";
  return wat;
}

// Expand a (sprintf buf "fmt" args...) call.
// Returns (call $__sprintf_N buf arg1 arg2 ...) — result is bytes written (:i32).
function expandSprintf(list: ListNode, env: Env): Node {
  if (list.children.length < 3) {
    env.errors.push("sprintf: expected (sprintf buf \"fmt\" args...)");
    return new IntNode(0 as i64);
  }
  const fmtArg = list.children[2];
  let fmtStr = "";
  if (fmtArg.tag == TAG_STRING) {
    fmtStr = (fmtArg as StringNode).value;
  } else if (fmtArg.tag == TAG_SYMBOL) {
    const sym = (fmtArg as SymbolNode).name;
    if (sym.startsWith("__str:")) fmtStr = sym.slice(6);
    else {
      env.errors.push("sprintf: format must be a string literal (got '" + sym + "')");
      return new IntNode(0 as i64);
    }
  } else {
    env.errors.push("sprintf: format must be a compile-time string literal");
    return new IntNode(0 as i64);
  }

  // Use a separate name registry for sprintf to avoid collisions with printf funcs.
  const cacheKey = "__sprintf:" + fmtStr;
  let funcName = "";
  if (env.printfFuncsByFmt.has(cacheKey)) {
    funcName = env.printfFuncsByFmt.get(cacheKey);
  } else {
    const probeTypes = printfArgTypes(fmtStr);
    const typeSig = probeTypes.length > 0 ? probeTypes.join("_") : "str";
    const baseName = "__sprintf_" + typeSig;
    const count = env.printfNameCounts.has(baseName) ? env.printfNameCounts.get(baseName) : 0;
    env.printfNameCounts.set(baseName, count + 1);
    funcName = count == 0 ? baseName : baseName + "_" + (count + 1).toString();
    env.printfFuncsByFmt.set(cacheKey, funcName);
    const body = buildSprintfFunc(fmtStr, funcName, env);
    env.funcBodies.set(funcName, body);
    env.funcNames.push(funcName);
  }

  // (call $__sprintf_N buf arg1 arg2 ...)
  const callNode = new ListNode();
  callNode.children.push(new SymbolNode(funcName));
  callNode.children.push(expandNode(list.children[1], env)); // buf
  for (let i = 3; i < list.children.length; i++) {
    callNode.children.push(expandNode(list.children[i], env));
  }
  return callNode;
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
    wat += "    (local $__s_ptr i32)\n";
    wat += "    (local $__s_len i32)\n";
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
      // i32 → decimal string via $i32->str (returns two-value :str)
      wat += "    (call $i32->str (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__s_len)\n";
      wat += "    (local.set $__s_ptr)\n";
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (local.get $__s_ptr))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (local.get $__s_len))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
      curArg++;
    } else if (seg == "A:i64") {
      // i64 → decimal string via $i64->str (returns two-value :str)
      wat += "    (call $i64->str (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__s_len)\n";
      wat += "    (local.set $__s_ptr)\n";
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (local.get $__s_ptr))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (local.get $__s_len))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
      curArg++;
    } else if (seg == "A:str") {
      // :str fat-pointer arg — two consecutive i32 params (ptr, len)
      const ptrParam = "$a" + curArg.toString();
      const lenParam = "$a" + (curArg + 1).toString();
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (local.get " + ptrParam + "))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (local.get " + lenParam + "))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
      curArg += 2; // two params for one :str arg
    } else if (seg == "A:char") {
      // Single byte arg — store byte then fd_write 1 byte
      wat += "    (local.set $__s_ptr (call $alloc (i32.const 4)))\n";
      wat += "    (i32.store8 (local.get $__s_ptr) (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (local.get $__s_ptr))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (i32.const 1))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
      curArg++;
    } else if (seg == "A:f32") {
      // f32 → decimal string via $f32->str (returns two-value :str)
      wat += "    (call $f32->str (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__s_len)\n";
      wat += "    (local.set $__s_ptr)\n";
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (local.get $__s_ptr))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (local.get $__s_len))\n";
      wat += "    (drop (call $fd_write (i32.const 1) (local.get $__iov) (i32.const 1) (i32.add (local.get $__iov) (i32.const 8))))\n";
      curArg++;
    } else if (seg == "A:f64") {
      // f64 → decimal string via $f64->str (returns two-value :str)
      wat += "    (call $f64->str (local.get $a" + curArg.toString() + "))\n";
      wat += "    (local.set $__s_len)\n";
      wat += "    (local.set $__s_ptr)\n";
      wat += "    (local.set $__iov (call $alloc (i32.const 12)))\n";
      wat += "    (i32.store (local.get $__iov) (local.get $__s_ptr))\n";
      wat += "    (i32.store (i32.add (local.get $__iov) (i32.const 4)) (local.get $__s_len))\n";
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
    funcName = env.printfFuncsByFmt.get(fmtStr);
  } else {
    // Derive base name from argument types: __printf_i32, __printf_i32_i64, etc.
    const probeTypes = printfArgTypes(fmtStr);
    const typeSig = probeTypes.length > 0 ? probeTypes.join("_") : "str";
    const baseName = "__printf_" + typeSig;
    // Disambiguate collisions with a suffix counter
    const count = env.printfNameCounts.has(baseName) ? env.printfNameCounts.get(baseName) : 0;
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

    // ── (defconst name val) — compile-time named constant ─────────────────
    // Folds the value to a compile-time literal (IntNode/FloatNode).
    if (headName == "defconst") {
      // children: [defconst, name, val]
      const constName = (list.children[1] as SymbolNode).name;
      const rawVal    = list.children[2];
      const prevErrs  = env.errors.length;
      const folded    = constFold(rawVal, env);
      if (folded != null) {
        env.macros.set(constName, new MacroInfo(new Array<string>(), "", folded));
      } else if (env.errors.length == prevErrs) {
        // constFold returned null without a specific error → generic message.
        env.errors.push("defconst " + constName + ": value must be a compile-time constant (literal or arithmetic on known defconst names)");
      }
      continue;
    }
    // ── (defvar name [:Type] val) — mutable global variable ──────────────────
    // Declares a WAT mutable global.  Type is optional, defaults to :i32.
    // Use (set! name val) to mutate, bare name to read.
    if (headName == "defvar") {
      // children: [defvar, name, :Type?, initval]
      const varName  = (list.children[1] as SymbolNode).name;
      let   typeName = ":i32";
      let   initNode: Node;
      // (defvar name :Type init) — 4 children
      if (list.children.length == 4 &&
          list.children[2].tag == TAG_SYMBOL &&
          (list.children[2] as SymbolNode).name.startsWith(":")) {
        typeName = (list.children[2] as SymbolNode).name;
        initNode = list.children[3];
      // (defvar name :Type) — 3 children, type only (no init; valid for value-type structs)
      } else if (list.children.length == 3 &&
                 list.children[2].tag == TAG_SYMBOL &&
                 (list.children[2] as SymbolNode).name.startsWith(":")) {
        typeName = (list.children[2] as SymbolNode).name;
        initNode = list.children[2]; // unused for value-type path; safe placeholder
      } else {
        initNode = list.children[2];
      }
      // Value-type struct: ":TypeName" (not :*T, not primitive) → sub-globals
      const isValueStruct = typeName != ":i32" && typeName != ":i64" &&
                            typeName != ":f32" && typeName != ":f64" &&
                            typeName != ":ptr" && !typeName.startsWith(":*") &&
                            typeName.length > 1 && env.types.has(typeName.slice(1));
      // Ref-type struct: ":*TypeName" → single i32 global (heap pointer), no init allowed
      const isRefStruct = typeName.startsWith(":*") && env.types.has(typeName.slice(2));
      if (isValueStruct || isRefStruct) {
        if (list.children.length > 3) {
          const kind = isValueStruct ? "value-type" : "ref-type";
          env.errors.push("defvar: '" + varName + "' has " + kind + " '" + typeName +
                          "' — cannot supply an init value; initialize to zero implicitly. " +
                          "Use (set! " + varName + " (" + typeName.slice(isValueStruct ? 1 : 2) + " ...)) after declaration.");
          continue;
        }
        if (isRefStruct) {
          if (env.globals.has(varName)) {
            env.errors.push("defvar: duplicate global name '" + varName + "'");
            continue;
          }
          env.globals.set(varName, new GlobalInfo(typeName, "(i32.const 0)", false));
          env.globalNames.push(varName);
          continue;
        }
        // Value-type: register marker + sub-globals
        if (env.globals.has(varName)) {
          env.errors.push("defvar: duplicate global name '" + varName + "'");
          continue;
        }
        // Register a marker (not emitted as WAT global) so typeOf can resolve it
        env.globals.set(varName, new GlobalInfo(typeName, "", true));
        env.globalNames.push(varName);
        // Register one sub-global per leaf field
        registerValueTypeSubGlobals(varName, typeName.slice(1), env);
        continue;
      }
      // Build the WAT initializer: must be a constant expression.
      // We first parse the node, then reconcile with declared type so the
      // WAT instruction matches (e.g. (defvar x :f32 0) must use f32.const 0).
      let initVal: f64 = 0;           // numeric value extracted from node
      let initIsFloat: bool = false;  // was the literal a float node?
      if (initNode.tag == TAG_INT) {
        initVal = f64((initNode as IntNode).value);
      } else if (initNode.tag == TAG_FLOAT) {
        initVal     = (initNode as FloatNode).value;
        initIsFloat = true;
      }
      // Pick the right WAT const based on the declared type
      let initWat: string;
      if (typeName == ":i64") {
        initWat = "(i64.const " + i64(initVal).toString() + ")";
      } else if (typeName == ":f32") {
        initWat = "(f32.const " + f32(initVal).toString() + ")";
      } else if (typeName == ":f64") {
        initWat = "(f64.const " + f64(initVal).toString() + ")";
      } else {
        // :i32, :ptr, user struct pointer — all i32
        initWat = "(i32.const " + i32(initVal).toString() + ")";
      }
      if (env.globals.has(varName)) {
        env.errors.push("defvar: duplicate global name '" + varName + "'");
        continue;
      }
      env.globals.set(varName, new GlobalInfo(typeName, initWat));
      env.globalNames.push(varName);
      continue;
    }
    // ── (shared-memory) — declare the linear memory as shared ────────────────
    // Required when the WASM module runs in a Worker and shares its memory with
    // the main thread (e.g. when using lib/svg.woua).  Emits
    // (memory 1 65536 shared) instead of (memory 1).
    if (headName == "shared-memory") {
      env.usesSvg = true;
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

    // ── (defprotocol Name (method (self :*Self ...) :RetType) ...) ────────────
    if (headName == "defprotocol") {
      // children: [defprotocol, Name, (method (self :*Self ...) :RetType)...]
      const protoName = (list.children[1] as SymbolNode).name;
      if (env.protocols.has(protoName)) {
        env.errors.push("defprotocol: duplicate protocol name '" + protoName + "'");
        continue;
      }
      const proto = new ProtocolInfo();
      for (let j = 2; j < list.children.length; j++) {
        const spec       = list.children[j] as ListNode;
        const methodName = (spec.children[0] as SymbolNode).name;
        const paramsNode = spec.children[1] as ListNode;
        // Param types are at odd indices (0 = name, 1 = type, 2 = name, 3 = type...)
        const params = new Array<string>();
        for (let k = 1; k < paramsNode.children.length; k += 2) {
          params.push((paramsNode.children[k] as SymbolNode).name);
        }
        const resultAnnot = spec.children.length >= 3
          ? (spec.children[2] as SymbolNode).name
          : ":void";
        const result = resultAnnot == ":void" ? "" : resultAnnot;
        proto.methods.set(methodName, new ProtocolMethodSig(params, result));
        proto.methodNames.push(methodName);
      }
      env.protocols.set(protoName, proto);
      continue;
    }

    // ── (defimpl ProtocolName TypeName (defn method ...) ...) ────────────────
    // Registers each defn under a mangled name (TypeName__method), auto-creates
    // a defop that dispatches to it, and verifies the full protocol is satisfied.
    if (headName == "defimpl") {
      // children: [defimpl, ProtocolName, TypeName, (defn method body...)...]
      const protoName = (list.children[1] as SymbolNode).name;
      const typeName  = (list.children[2] as SymbolNode).name;
      if (!env.protocols.has(protoName)) {
        env.errors.push("defimpl: unknown protocol '" + protoName + "'");
        continue;
      }
      const proto = env.protocols.get(protoName);
      const provided = new Set<string>();

      for (let j = 3; j < list.children.length; j++) {
        if (list.children[j].tag != TAG_LIST) continue;
        const defnList = list.children[j] as ListNode;
        if (defnList.children.length < 2 || defnList.children[0].tag != TAG_SYMBOL) continue;
        if ((defnList.children[0] as SymbolNode).name != "defn") continue;

        const methodName  = (defnList.children[1] as SymbolNode).name;
        const mangledName = typeName + "__" + methodName;

        // Verify this method exists in the protocol
        if (!proto.methods.has(methodName)) {
          env.errors.push("defimpl " + protoName + " " + typeName
            + ": method '" + methodName + "' is not part of the protocol");
          continue;
        }
        const sig = proto.methods.get(methodName);

        // Extract param types from the defn form
        const paramsList = defnList.children[2] as ListNode;
        const implParams = new Array<string>();
        for (let k = 1; k < paramsList.children.length; k += 2) {
          implParams.push((paramsList.children[k] as SymbolNode).name);
        }

        // Extract result type annotation (children[3] if it starts with ':')
        let implResult = "";
        if (defnList.children.length > 3 && defnList.children[3].tag == TAG_SYMBOL) {
          const s = (defnList.children[3] as SymbolNode).name;
          if (s.startsWith(":")) implResult = s == ":void" ? "" : s;
        }

        // Verify signature matches protocol (substitute :*Self → :*TypeName)
        if (implParams.length != sig.params.length) {
          env.errors.push("defimpl " + protoName + " " + typeName + " method '" + methodName
            + "': expected " + sig.params.length.toString() + " params, got "
            + implParams.length.toString());
        } else {
          for (let k = 0; k < sig.params.length; k++) {
            const expected = sig.params[k] == ":*Self" ? ":*" + typeName : sig.params[k];
            if (implParams[k] != expected) {
              env.errors.push("defimpl " + protoName + " " + typeName + " method '" + methodName
                + "': param " + k.toString() + " expected " + expected
                + ", got " + implParams[k]);
            }
          }
        }
        if (implResult != sig.result) {
          env.errors.push("defimpl " + protoName + " " + typeName + " method '" + methodName
            + "': declared return " + (implResult == "" ? ":void" : implResult)
            + " but protocol expects " + (sig.result == "" ? ":void" : sig.result));
        }

        // Build a new defn list with the mangled name
        const mangledDefn = new ListNode();
        mangledDefn.children.push(defnList.children[0]); // defn
        mangledDefn.children.push(new SymbolNode(mangledName));
        for (let k = 2; k < defnList.children.length; k++) {
          mangledDefn.children.push(defnList.children[k]);
        }
        result.push(new ExpandedForm(expandNode(mangledDefn, env)));

        // Auto-register defop: (defop methodName "mangledName" (:*TypeName ...) retType)
        // Build the concrete param types (substitute :*Self → :*TypeName)
        const concreteParams = new Array<string>();
        for (let k = 0; k < sig.params.length; k++) {
          concreteParams.push(sig.params[k] == ":*Self" ? ":*" + typeName : sig.params[k]);
        }
        if (!env.ops.has(methodName)) env.ops.set(methodName, new Array<OpInfo>());
        env.ops.get(methodName).push(
          new OpInfo(methodName, mangledName, concreteParams, sig.result));

        provided.add(methodName);
      }

      // Verify all protocol methods were provided
      for (let j = 0; j < proto.methodNames.length; j++) {
        const m = proto.methodNames[j];
        if (!provided.has(m)) {
          env.errors.push("defimpl " + protoName + " " + typeName
            + ": missing method '" + m + "'");
        }
      }
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
      env.ops.get(iName).push(new OpInfo(iName, watOp, iParams, iResult));
      continue;
    }

    // ── everything else: expand user macros recursively, then forward ────────
    result.push(new ExpandedForm(expandNode(form, env)));
  }

  return result;
}
