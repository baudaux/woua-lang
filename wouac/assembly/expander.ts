// Expander — walks the AST and processes all compile-time macro forms.
// Compile-time macros (defstatic, deftype, defmacro) are consumed here and
// produce no output node — they only update the Env.
// User-defined macros are expanded recursively wherever they appear.
// Other forms are passed through to codegen.

import { Node, ListNode, SymbolNode, IntNode, StringNode, RegexNode,
         TAG_LIST, TAG_SYMBOL, TAG_STRING, TAG_REGEX } from "./ast";
import { Env, MacroInfo, ImportInfo, OpInfo, LiteralInfo } from "./env";
import { expandDefstatic, expandDeftype, internString } from "./macros";

// A form that survives expansion — either a (defn ...) or a top-level expression
export class ExpandedForm {
  node: Node;
  constructor(node: Node) { this.node = node; }
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
  }

  // Not a macro call — recursively expand children
  const result = new ListNode();
  for (let i = 0; i < list.children.length; i++) {
    result.children.push(expandNode(list.children[i], env));
  }
  return result;
}

// Substitute macro params with actual args in the macro body template.
function expandMacroCall(macro: MacroInfo, args: Array<Node>, env: Env): Node {
  const subst = new Map<string, Node>();
  for (let i = 0; i < macro.params.length; i++) {
    subst.set(macro.params[i], args[i]);
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

    // ── (defmacro name (params...) body) ────────────────────────────────────
    if (headName == "defmacro") {
      // children: [defmacro, name, (params...), body]
      const macroName   = (list.children[1] as SymbolNode).name;
      const paramsNode  = list.children[2] as ListNode;
      const bodyNode    = list.children[3];
      const params      = new Array<string>();
      for (let j = 0; j < paramsNode.children.length; j++) {
        params.push((paramsNode.children[j] as SymbolNode).name);
      }
      env.macros.set(macroName, new MacroInfo(params, bodyNode));
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
