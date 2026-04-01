// AST node tags
export const TAG_INT    : i32 = 0;
export const TAG_FLOAT  : i32 = 1;
export const TAG_SYMBOL : i32 = 2;
export const TAG_STRING : i32 = 3;
export const TAG_LIST   : i32 = 4;
export const TAG_REGEX  : i32 = 5;

// Base node — all AST nodes carry a tag for dynamic dispatch
export class Node {
  tag: i32;
  constructor(tag: i32) { this.tag = tag; }
}

// Integer literal:  42 (i32), 42i64 (i64)
export class IntNode extends Node {
  value: i64;
  wide:  bool;   // true → i64, false → i32
  constructor(v: i64, wide: bool = false) { super(TAG_INT); this.value = v; this.wide = wide; }
}

// Float literal:  3.14 (f32), 3.14f64 (f64)
export class FloatNode extends Node {
  value: f64;
  wide:  bool;   // true → f64, false → f32
  constructor(v: f64, wide: bool = false) { super(TAG_FLOAT); this.value = v; this.wide = wide; }
}

// Symbol (identifier or keyword):  foo, defn, :i32
export class SymbolNode extends Node {
  name: string;
  constructor(n: string) { super(TAG_SYMBOL); this.name = n; }
}

// String literal:  "Hello, World!"
export class StringNode extends Node {
  value: string;
  constructor(v: string) { super(TAG_STRING); this.value = v; }
}

// Regex literal:  /pattern/
export class RegexNode extends Node {
  pattern: string;
  constructor(p: string) { super(TAG_REGEX); this.pattern = p; }
}

// List:  (defn add (a b) (+ a b))
export class ListNode extends Node {
  children: Array<Node>;
  constructor() {
    super(TAG_LIST);
    this.children = new Array<Node>();
  }

  // First element — the head form (usually a symbol)
  head(): Node { return this.children[0]; }

  // All elements after the head
  tail(): Array<Node> { return this.children.slice(1); }

  // Convenience: get child at index as a SymbolNode name
  symbolAt(i: i32): string {
    return (this.children[i] as SymbolNode).name;
  }
}
