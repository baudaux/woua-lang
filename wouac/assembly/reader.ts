// Reader -- converts a woua source string into a list of AST nodes.
// String literals and other quoted literals are recognised dynamically using
// the patterns declared by (defliteral ...) in env.literals -- no hardcoded
// readString. The reader checks env.literals at every readForm() call, so
// patterns registered between calls (via streaming include resolution) are
// picked up immediately.

import { Node, IntNode, FloatNode, SymbolNode, StringNode, RegexNode, ListNode } from "./ast";
import { Env, LiteralInfo } from "./env";

export class Reader {
  private src:      string;
  private pos:      i32;
  private env:      Env;
  private line:      i32;   // 1-based current line number
  private lineStart: i32;   // pos of the first char on the current line (for column calc)
  private filename:  string; // for error messages

  constructor(src: string, env: Env, filename: string = "") {
    this.src       = src;
    this.pos       = 0;
    this.env       = env;
    this.line      = 1;
    this.lineStart = 0;
    this.filename  = filename;
  }

  // True if there are more non-whitespace forms to read.
  hasMore(): bool {
    this.skipWhitespace();
    return this.pos < this.src.length;
  }

  // Read the next top-level form (public single-form interface).
  readNextForm(): Node {
    return this.readForm();
  }

  // Read all top-level forms from the source.
  readAll(): Array<Node> {
    const forms = new Array<Node>();
    this.skipWhitespace();
    while (this.pos < this.src.length) {
      forms.push(this.readForm());
      this.skipWhitespace();
    }
    return forms;
  }

  // Read one form.
  private readForm(): Node {
    this.skipWhitespace();
    const c = this.src.charAt(this.pos);
    if (c == "(") return this.readList();
    if (c == ")") {
      const col = this.pos - this.lineStart + 1;
      const loc = this.filename != "" ? this.filename + ":" + this.line.toString() + ":" + col.toString() : "line " + this.line.toString() + ":" + col.toString();
      this.env.errors.push(loc + ": unexpected ')' — no matching '('");
      this.pos++; // consume it and continue
      return new SymbolNode("<error>");
    }
    // A '/' is a regex literal only when immediately followed by a non-space,
    // non-'/' character. A lone '/' or '/ ' is the division operator (symbol).
    if (c == "/") {
      const next = this.pos + 1 < this.src.length ? this.src.charAt(this.pos + 1) : "";
      if (next != "" && next != " " && next != "\t" && next != "\n" && next != "\r" && next != "/") {
        return this.readRegex();
      }
    }

    // Try registered literal patterns (e.g. defliteral string /".."/ :string).
    // Each LiteralInfo stores the raw regex pattern; its first character is the
    // opening delimiter of the literal.
    // Atom-mode literals (:i32, :i64, :f32, :f64) have no opening delimiter —
    // they are matched later in readAtom() after the full token has been consumed.
    const lits  = this.env.literals;
    const names = lits.keys();
    for (let i = 0; i < names.length; i++) {
      const info = lits.get(names[i])!;
      if (info.nodeType == ":i32" || info.nodeType == ":i64" ||
          info.nodeType == ":f32" || info.nodeType == ":f64") continue;
      if (c == info.pattern.charAt(0)) {
        return this.readLiteral(info);
      }
    }

    return this.readAtom();
  }

  // -- Literal: driven by a defliteral pattern --------------------------------
  // Supports quote-delimited literals where the opening and closing delimiter
  // are the same character (the first char of the pattern), with \ escaping.
  // For :string literals, interns the value into linear memory immediately and
  // returns a StringNode (still needed by defimport / defstatic at compile time).
  // For :char literals, returns an IntNode with the Unicode code point.

  private readLiteral(info: LiteralInfo): Node {
    const delim = info.pattern.charAt(0); // e.g. '"' or "'"
    this.pos++; // consume opening delimiter
    let value = "";
    while (this.pos < this.src.length) {
      const c = this.src.charAt(this.pos);
      if (c == delim) { this.pos++; break; }
      if (c == "\\") {
        this.pos++;
        const esc = this.src.charAt(this.pos);
        if      (esc == "n")    value += "\n";
        else if (esc == "t")    value += "\t";
        else if (esc == "r")    value += "\r";
        else if (esc == "\\")   value += "\\";
        else if (esc == delim)  value += delim;
        else if (esc == "0")    value += "\0";
        else                    value += esc;
        this.pos++;
      } else {
        value += c;
        this.pos++;
      }
    }
    if (info.nodeType == ":char") {
      const code = value.length > 0 ? value.charCodeAt(0) : 0;
      return new IntNode(code as i64);
    }
    return new StringNode(value);
  }

  // -- List: (form form ...) --------------------------------------------------

  private readList(): ListNode {
    const openLine = this.line;
    const openCol  = this.pos - this.lineStart + 1;
    this.pos++; // consume '('
    const node = new ListNode();
    this.skipWhitespace();
    while (this.pos < this.src.length && this.src.charAt(this.pos) != ")") {
      node.children.push(this.readForm());
      this.skipWhitespace();
    }
    if (this.pos >= this.src.length) {
      const loc = this.filename != "" ? this.filename + ":" + openLine.toString() + ":" + openCol.toString() : "line " + openLine.toString() + ":" + openCol.toString();
      this.env.errors.push(loc + ": unmatched '(' — missing closing ')'");
    } else {
      this.pos++; // consume ')'
    }
    return node;
  }

  // -- Regex: /pattern/ (escape sequences kept as-is in the raw pattern) -----

  private readRegex(): RegexNode {
    this.pos++; // consume opening '/'
    let pattern = "";
    while (this.pos < this.src.length) {
      const c = this.src.charAt(this.pos);
      if (c == "/") { this.pos++; break; }
      if (c == "\\") {
        pattern += c;
        this.pos++;
        if (this.pos < this.src.length) {
          pattern += this.src.charAt(this.pos);
          this.pos++;
        }
      } else {
        pattern += c;
        this.pos++;
      }
    }
    return new RegexNode(pattern);
  }

  // -- Atom: integer, float, keyword, or symbol ------------------------------

  private readAtom(): Node {
    let token = "";
    while (this.pos < this.src.length) {
      const c = this.src.charAt(this.pos);
      if (c == " " || c == "\n" || c == "\r" || c == "\t" ||
          c == "(" || c == ")") break;
      token += c;
      this.pos++;
    }

    // Match atom-mode literals declared by (defliteral name /pat/ :i32/:i64/:f32/:f64).
    // Two passes: suffixed patterns first so "42i64" matches :i64 before :i32.
    // Within each pass, prefix-based literals (e.g. 0x for hex) are tried via
    // info.prefix before falling back to ordinary decimal/float validation.
    const lits  = this.env.literals;
    const names = lits.keys();
    for (let i = 0; i < names.length; i++) {
      const info = lits.get(names[i])!;
      if (info.suffix.length == 0) continue;
      if (!token.endsWith(info.suffix)) continue;
      const base = token.slice(0, token.length - info.suffix.length);
      if (info.nodeType == ":i32" || info.nodeType == ":i64") {
        if (info.prefix.length > 0 && base.startsWith(info.prefix)) {
          const digits = base.slice(info.prefix.length);
          if (isHexDigits(digits))
            return new IntNode(I64.parseInt(digits, 16), info.nodeType == ":i64");
        } else if (isInteger(base)) {
          return new IntNode(I64.parseInt(base), info.nodeType == ":i64");
        }
      }
      if ((info.nodeType == ":f32" || info.nodeType == ":f64") && isFloat(base))
        return new FloatNode(F64.parseFloat(base), info.nodeType == ":f64");
    }
    for (let i = 0; i < names.length; i++) {
      const info = lits.get(names[i])!;
      if (info.suffix.length != 0) continue;
      if (info.nodeType == ":i32" || info.nodeType == ":i64") {
        if (info.prefix.length > 0 && token.startsWith(info.prefix)) {
          const digits = token.slice(info.prefix.length);
          if (isHexDigits(digits))
            return new IntNode(I64.parseInt(digits, 16), info.nodeType == ":i64");
        } else if (isInteger(token)) {
          return new IntNode(I64.parseInt(token), info.nodeType == ":i64");
        }
      }
      if ((info.nodeType == ":f32" || info.nodeType == ":f64") && isFloat(token))
        return new FloatNode(F64.parseFloat(token), info.nodeType == ":f64");
    }
    return new SymbolNode(token);
  }

  // -- Whitespace + line comments --------------------------------------------

  private skipWhitespace(): void {
    while (this.pos < this.src.length) {
      const c = this.src.charAt(this.pos);
      if (c == "\n") { this.line++; this.lineStart = this.pos + 1; this.pos++; continue; }
      if (c == " " || c == "\r" || c == "\t") {
        this.pos++;
      } else if (c == ";") {
        // line comment -- skip to end of line
        while (this.pos < this.src.length && this.src.charAt(this.pos) != "\n") {
          this.pos++;
        }
      } else {
        break;
      }
    }
  }
}

// -- Helpers ------------------------------------------------------------------

// Returns true if every character is a valid hexadecimal digit (no 0x prefix).
function isHexDigits(token: string): bool {
  if (token.length == 0) return false;
  for (let i = 0; i < token.length; i++) {
    const c = token.charAt(i);
    if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"))) return false;
  }
  return true;
}

function isDigit(c: string): bool {
  return c >= "0" && c <= "9";
}

function isInteger(token: string): bool {
  if (token.length == 0) return false;
  let start = 0;
  if (token.charAt(0) == "-") start = 1;
  if (start >= token.length)  return false;
  for (let i = start; i < token.length; i++) {
    if (!isDigit(token.charAt(i))) return false;
  }
  return true;
}

function isFloat(token: string): bool {
  if (token.length == 0) return false;
  let hasDot = false;
  let hasExp = false;
  let start  = 0;
  if (token.charAt(0) == "-") start = 1;
  if (start >= token.length)  return false;
  for (let i = start; i < token.length; i++) {
    const c = token.charAt(i);
    if (c == ".") { if (hasDot) return false; hasDot = true; continue; }
    if (c == "e" || c == "E") { if (hasExp) return false; hasExp = true; continue; }
    if (c == "+" || c == "-") { if (i == 0) continue; return false; }
    if (!isDigit(c)) return false;
  }
  return hasDot || hasExp;
}
