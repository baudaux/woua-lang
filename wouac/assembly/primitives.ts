// Primitives — functions that emit WAT text fragments.
// Every higher-level construct in the compiler is built from these.

// ─── Numeric literals ────────────────────────────────────────────────────────

export function watI32Const(n: i32): string {
  return "(i32.const " + n.toString() + ")";
}

export function watI64Const(n: i64): string {
  return "(i64.const " + n.toString() + ")";
}

export function watF32Const(n: f32): string {
  return "(f32.const " + n.toString() + ")";
}

export function watF64Const(n: f64): string {
  return "(f64.const " + n.toString() + ")";
}

// ─── Local variables ─────────────────────────────────────────────────────────

export function watLocalGet(name: string): string {
  return "(local.get $" + name + ")";
}

export function watLocalSet(name: string, val: string): string {
  return "(local.set $" + name + " " + val + ")";
}

export function watLocalDecl(name: string, type: string): string {
  return "(local $" + name + " " + type + ")";
}

// ─── Memory operations ───────────────────────────────────────────────────────

export function watI32Store(ptr: string, val: string): string {
  return "(i32.store " + ptr + " " + val + ")";
}

export function watI32Store8(ptr: string, val: string): string {
  return "(i32.store8 " + ptr + " " + val + ")";
}

export function watI32Load(ptr: string): string {
  return "(i32.load " + ptr + ")";
}

export function watI32Load8u(ptr: string): string {
  return "(i32.load8_u " + ptr + ")";
}

export function watI32Load16u(ptr: string): string {
  return "(i32.load16_u " + ptr + ")";
}

export function watI64Store(ptr: string, val: string): string {
  return "(i64.store " + ptr + " " + val + ")";
}

export function watI64Load(ptr: string): string {
  return "(i64.load " + ptr + ")";
}

export function watF32Store(ptr: string, val: string): string {
  return "(f32.store " + ptr + " " + val + ")";
}

export function watF32Load(ptr: string): string {
  return "(f32.load " + ptr + ")";
}

export function watF64Store(ptr: string, val: string): string {
  return "(f64.store " + ptr + " " + val + ")";
}

export function watF64Load(ptr: string): string {
  return "(f64.load " + ptr + ")";
}

// ─── Arithmetic (i32) ────────────────────────────────────────────────────────

export function watI32Add(a: string, b: string): string { return "(i32.add " + a + " " + b + ")"; }
export function watI32Sub(a: string, b: string): string { return "(i32.sub " + a + " " + b + ")"; }
export function watI32Mul(a: string, b: string): string { return "(i32.mul " + a + " " + b + ")"; }
export function watI32DivS(a: string, b: string): string { return "(i32.div_s " + a + " " + b + ")"; }

// ─── Arithmetic (f32) ────────────────────────────────────────────────────────

export function watF32Add(a: string, b: string): string { return "(f32.add " + a + " " + b + ")"; }
export function watF32Sub(a: string, b: string): string { return "(f32.sub " + a + " " + b + ")"; }
export function watF32Mul(a: string, b: string): string { return "(f32.mul " + a + " " + b + ")"; }
export function watF32Div(a: string, b: string): string { return "(f32.div " + a + " " + b + ")"; }

// ─── Control flow ────────────────────────────────────────────────────────────

export function watBlock(label: string, body: string): string {
  return "(block $" + label + "\n  " + body + "\n)";
}

export function watLoop(label: string, body: string): string {
  return "(loop $" + label + "\n  " + body + "\n)";
}

export function watIf(cond: string, thenBody: string, elseBody: string = "", resultType: string = ""): string {
  const result = resultType != "" ? " (result " + resultType + ")" : "";
  if (elseBody == "") {
    return "(if" + result + " " + cond + " (then " + thenBody + "))";
  }
  return "(if" + result + " " + cond + " (then " + thenBody + ") (else " + elseBody + "))";
}

export function watBr(label: string): string {
  return "(br $" + label + ")";
}

export function watBrIf(label: string, cond: string): string {
  return "(br_if $" + label + " " + cond + ")";
}

// ─── Functions & calls ───────────────────────────────────────────────────────

export function watCall(name: string, args: Array<string>): string {
  let result = "(call $" + name;
  for (let i = 0; i < args.length; i++) {
    result += " " + args[i];
  }
  return result + ")";
}

export function watDrop(expr: string): string {
  return "(drop " + expr + ")";
}

export function watReturn(expr: string = ""): string {
  if (expr == "") return "(return)";
  return "(return " + expr + ")";
}

// ─── Data section ────────────────────────────────────────────────────────────

// Escape a string so it is safe to embed inside a WAT "..." data literal.
// WAT only allows printable ASCII in string literals; all other bytes must use
// the \xx hex escape. Here we handle the common control characters explicitly
// and fall back to hex escapes for everything else below 0x20 or above 0x7E.
function escapeWatString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if      (c == 10) out += "\\n";
    else if (c == 13) out += "\\r";
    else if (c == 9)  out += "\\t";
    else if (c == 92) out += "\\\\";
    else if (c == 34) out += '\\"';
    else if (c >= 32 && c <= 126) out += s.charAt(i);
    else {
      // Two-digit hex escape: \xx
      const hi = (c >> 4) & 0xF;
      const lo = c & 0xF;
      const hexChars = "0123456789abcdef";
      out += "\\" + hexChars.charAt(hi) + hexChars.charAt(lo);
    }
  }
  return out;
}

export function watData(offset: i32, content: string): string {
  return '(data (i32.const ' + offset.toString() + ') "' + escapeWatString(content) + '")';
}
