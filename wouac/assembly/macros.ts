// Built-in macro definitions for woua.
// Each macro is a compile-time function: (args, env) → WAT string.
// Macros either update env (pure compile-time) or return a WAT expression.

import { Node, ListNode, SymbolNode, StringNode, IntNode, FloatNode,
         TAG_INT, TAG_FLOAT, TAG_SYMBOL, TAG_STRING, TAG_LIST } from "./ast";
import { Env, StaticInfo, TypeInfo, FieldInfo } from "./env";
import {
  watI32Const, watF32Const, watF64Const,
  watI32Store, watI32Load,
  watF32Store, watF32Load,
  watI32Add,
  watData
} from "./primitives";

// ─────────────────────────────────────────────────────────────────────────────
// (defstatic name "string literal")
// (defstatic name :i32 value)
// (defstatic name :i64 value)
// (defstatic name :f32 value)
// (defstatic name :f64 value)
// (defstatic name :ptr value)
// (defstatic name :bytes size)
//
// Pure compile-time macro — allocates space in linear memory, registers the
// symbol in env.statics, emits a (data ...) directive.
// Returns "" (no WAT expression at call site).
// ─────────────────────────────────────────────────────────────────────────────
export function expandDefstatic(args: Array<Node>, env: Env): string {
  if (args.length < 2) return watError("defstatic: too few arguments");

  const name = (args[0] as SymbolNode).name;
  const second = args[1];

  // ── (defstatic name "string") ─────────────────────────────────────────────
  if (second.tag == TAG_STRING) {
    const str  = (second as StringNode).value;
    const len  = str.length; // byte length (ASCII / UTF-8)
    const ptr  = env.allocate(len, 1);
    env.statics.set(name, new StaticInfo(ptr, len, ":string"));
    env.dataEntries.push(watData(ptr, str));
    return "";
  }

  // ── (defstatic name :type ...) ────────────────────────────────────────────
  if (second.tag == TAG_SYMBOL) {
    const typeName = (second as SymbolNode).name;

    // :bytes — reserve N zeroed bytes
    if (typeName == ":bytes") {
      if (args.length < 3) return watError("defstatic :bytes requires a size");
      const size = i32((args[2] as IntNode).value);
      const ptr  = env.allocate(size, 1);
      env.statics.set(name, new StaticInfo(ptr, size, ":bytes"));
      return "";
    }

    // Scalar types: :i32, :f32, :ptr, :i64, :f64
    const align = env.alignOf(typeName);
    const size  = env.sizeOf(typeName);
    const ptr   = env.allocate(size, align);
    env.statics.set(name, new StaticInfo(ptr, -1, typeName));

    // Optional inline initial value → emit a (data ...) directive
    if (args.length >= 3 && (typeName == ":i32" || typeName == ":ptr")) {
      const val = i32((args[2] as IntNode).value);
      env.dataEntries.push(
        "(data (i32.const " + ptr.toString() + ") " + encodeI32LE(val) + ")"
      );
    }

    return "";
  }

  return watError("defstatic: unrecognised form");
}

// ─────────────────────────────────────────────────────────────────────────────
// (deftype Name
//   (field1 :type1)
//   (field2 :type2) ...)
//
// Pure compile-time macro — computes field offsets with alignment, registers
// TypeInfo in env.types, and generates field accessor macros:
//   (TypeName/field ptr)       → i32.load / f32.load at ptr + offset
//   (TypeName/field! ptr val)  → i32.store / f32.store at ptr + offset
// Returns "" (no WAT expression at call site).
// ─────────────────────────────────────────────────────────────────────────────
export function expandDeftype(args: Array<Node>, env: Env): string {
  if (args.length < 2) return watError("deftype: too few arguments");

  const typeName = (args[0] as SymbolNode).name;
  const typeInfo = new TypeInfo(0);
  let   offset: i32 = 0;

  for (let i = 1; i < args.length; i++) {
    const fieldDef  = args[i] as ListNode;
    const fieldName = (fieldDef.children[0] as SymbolNode).name;
    const fieldType = (fieldDef.children[1] as SymbolNode).name;

    // Align field to its natural alignment
    const align = env.alignOf(fieldType);
    const rem   = offset % align;
    if (rem != 0) offset += align - rem;

    typeInfo.fields.set(fieldName, new FieldInfo(offset, fieldType));
    offset += env.sizeOf(fieldType);
  }

  // Align total size to the alignment of the first field (common C rule)
  typeInfo.size = offset;
  env.types.set(typeName, typeInfo);

  return ""; // compile-time only
}

// ─────────────────────────────────────────────────────────────────────────────
// Field getter: (TypeName/field ptr)
// Expands to the appropriate load instruction at (ptr + fieldOffset).
// ─────────────────────────────────────────────────────────────────────────────
export function expandFieldGet(typeName: string, fieldName: string,
                                ptr: string, env: Env): string {
  if (!env.types.has(typeName)) return watError("unknown type: " + typeName);

  const typeInfo = env.types.get(typeName)!;
  if (!typeInfo.fields.has(fieldName)) {
    return watError(typeName + " has no field: " + fieldName);
  }

  const field   = typeInfo.fields.get(fieldName)!;
  const ptrExpr = field.offset == 0
    ? ptr
    : watI32Add(ptr, watI32Const(field.offset));

  if (field.typeName == ":i32" || field.typeName == ":ptr") return watI32Load(ptrExpr);
  if (field.typeName == ":f32") return watF32Load(ptrExpr);
  return watError("unsupported field type for get: " + field.typeName);
}

// ─────────────────────────────────────────────────────────────────────────────
// Field setter: (TypeName/field! ptr val)
// Expands to the appropriate store instruction at (ptr + fieldOffset).
// ─────────────────────────────────────────────────────────────────────────────
export function expandFieldSet(typeName: string, fieldName: string,
                                ptr: string, val: string, env: Env): string {
  if (!env.types.has(typeName)) return watError("unknown type: " + typeName);

  const typeInfo = env.types.get(typeName)!;
  if (!typeInfo.fields.has(fieldName)) {
    return watError(typeName + " has no field: " + fieldName);
  }

  const field   = typeInfo.fields.get(fieldName)!;
  const ptrExpr = field.offset == 0
    ? ptr
    : watI32Add(ptr, watI32Const(field.offset));

  if (field.typeName == ":i32" || field.typeName == ":ptr") return watI32Store(ptrExpr, val);
  if (field.typeName == ":f32") return watF32Store(ptrExpr, val);
  return watError("unsupported field type for set: " + field.typeName);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Emit a WAT line comment as an error marker (does not abort compilation)
function watError(msg: string): string {
  return ";; ERROR: " + msg;
}

// Encode a 32-bit integer as a 4-byte little-endian WAT escaped string
function encodeI32LE(n: i32): string {
  const b0 =  n        & 0xff;
  const b1 = (n >>  8) & 0xff;
  const b2 = (n >> 16) & 0xff;
  const b3 = (n >> 24) & 0xff;
  return '"' + byteEscape(b0) + byteEscape(b1) + byteEscape(b2) + byteEscape(b3) + '"';
}

function byteEscape(b: i32): string {
  const hex = "0123456789abcdef";
  return "\\" + hex.charAt(b >> 4) + hex.charAt(b & 0xf);
}

// ─────────────────────────────────────────────────────────────────────────────
// internString — allocate a string literal in linear memory (deduplicated).
// Keyed as "__str:<value>" in env.statics.
// Called by the reader whenever it encounters a string literal.
// ─────────────────────────────────────────────────────────────────────────────
export function internString(value: string, env: Env): void {
  const key = "__str:" + value;
  if (env.statics.has(key)) return;
  const len = value.length;
  const ptr = env.allocate(len, 1);
  env.statics.set(key, new StaticInfo(ptr, len, ":string"));
  env.dataEntries.push(watData(ptr, value));
}
