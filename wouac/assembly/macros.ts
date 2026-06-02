// Built-in macro definitions for woua.
// Each macro is a compile-time function: (args, env) → WAT string.
// Macros either update env (pure compile-time) or return a WAT expression.

import { Node, ListNode, SymbolNode, StringNode, IntNode, FloatNode,
         TAG_INT, TAG_FLOAT, TAG_SYMBOL, TAG_STRING, TAG_LIST, TAG_COMMENT } from "./ast";
import { Env, StaticInfo, TypeInfo, FieldInfo } from "./env";
import {
  watI32Const, watF32Const, watF64Const,
  watI32Store, watI32Store8, watI32Load, watI32Load8u,
  watF32Store, watF32Load,
  watI64Store, watI64Load,
  watF64Store, watF64Load,
  watI32Add,
  watData
} from "./primitives";

// ─────────────────────────────────────────────────────────────────────────────
// (defstatic name "string literal")
// (defstatic name :str "string literal")
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
//
// (defstatic name :str "text") allocates in linear memory:
//   [header: {base:i32, len:i32} = 8 bytes] followed by [raw string bytes]
// (static-ref name)  → header address (i32) — a `:str` pointer in memory
// (static-ptr name)  → header_addr + 8       — address of raw bytes (backward compat)
// (static-len name)  → byte length            — (backward compat)
// ─────────────────────────────────────────────────────────────────────────────
export function expandDefstatic(args: Array<Node>, env: Env): string {
  if (args.length < 2) return watError("defstatic: too few arguments");

  const name = (args[0] as SymbolNode).name;
  const second = args[1];

  // ── (defstatic name "string") — bare string literal: same layout as :str ──
  // Allocates an 8-byte {base, len} header followed by the raw bytes so that
  // the named static can be used directly as a :str fat-pointer value.
  if (second.tag == TAG_STRING) {
    const str    = (second as StringNode).value;
    const len    = str.length;
    const hdrPtr = env.allocate(8, 4);
    const strPtr = env.allocate(len, 1);
    env.dataEntries.push(
      "(data (i32.const " + hdrPtr.toString() + ") \""
      + encodeI32LEBytes(strPtr) + encodeI32LEBytes(len) + "\")"
    );
    env.dataEntries.push(watData(strPtr, str));
    env.statics.set(name, new StaticInfo(hdrPtr, len, ":*str"));
    return "";
  }

  // ── (defstatic name :type ...) ────────────────────────────────────────────
  if (second.tag == TAG_SYMBOL) {
    const typeName = (second as SymbolNode).name;

    // :str / :*str — allocate an 8-byte {base, len} header followed by the string bytes.
    // (static-ref name) → header address; (static-ptr name) → base = header+8
    if (typeName == ":str" || typeName == ":*str") {
      if (args.length < 3 || args[2].tag != TAG_STRING)
        return watError("defstatic :str requires a string literal");
      const str    = (args[2] as StringNode).value;
      const len    = str.length;
      // Allocate: 8-byte header (4-byte aligned), then the string bytes.
      const hdrPtr = env.allocate(8, 4);
      const strPtr = env.allocate(len, 1);
      // Emit header: base = strPtr (i32 LE), len = len (i32 LE) — single string token
      env.dataEntries.push(
        "(data (i32.const " + hdrPtr.toString() + ") \""
        + encodeI32LEBytes(strPtr) + encodeI32LEBytes(len) + "\")"
      );
      env.dataEntries.push(watData(strPtr, str));
      // StaticInfo: ptr = hdrPtr, len = len, typeName = ":*str"
      env.statics.set(name, new StaticInfo(hdrPtr, len, ":*str"));
      return "";
    }

    // :bytes — reserve N zeroed bytes, 8-byte aligned so embedded i32/i64/ptr fields work correctly
    if (typeName == ":bytes") {
      if (args.length < 3) return watError("defstatic :bytes requires a size");
      const size = i32((args[2] as IntNode).value);
      const ptr  = env.allocate(size, 8);
      env.statics.set(name, new StaticInfo(ptr, size, ":bytes"));
      return "";
    }

    // Ref-type struct pointer: ":*TypeName" → reserve sizeof(TypeName) bytes, not sizeof(pointer)
    if (typeName.startsWith(":*") && env.types.has(typeName.slice(2))) {
      const innerName = ":" + typeName.slice(2); // ":*Point" → ":Point"
      const size  = env.sizeOf(innerName);
      const align = env.alignOf(innerName);
      const ptr   = env.allocate(size, align);
      env.statics.set(name, new StaticInfo(ptr, -1, typeName));
      // Optional compile-time initialiser: (defstatic name :*TypeName (TypeName f1 f2 ...))
      if (args.length >= 3 && args[2].tag == TAG_LIST) {
        const ctorList = args[2] as ListNode;
        const ctorName = ctorList.children.length > 0 && ctorList.children[0].tag == TAG_SYMBOL
          ? (ctorList.children[0] as SymbolNode).name : "";
        if (ctorName == typeName.slice(2)) {
          const bytes = encodeStructBytes(ctorList, typeName.slice(2), env);
          if (bytes.length > 0) {
            env.dataEntries.push(
              "(data (i32.const " + ptr.toString() + ") \"" + bytes + "\")"
            );
          }
        }
      }
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
  if (env.types.has(typeName)) return "deftype: duplicate type name '" + typeName + "'";
  const typeInfo = new TypeInfo(0);
  let   offset: i32 = 0;

  for (let i = 1; i < args.length; i++) {
    if (args[i].tag == TAG_COMMENT) continue; // skip inline comments
    const fieldDef  = args[i] as ListNode;
    const fieldName = (fieldDef.children[0] as SymbolNode).name;
    const fieldType = (fieldDef.children[1] as SymbolNode).name;

    // Align field to its natural alignment
    const align = env.alignOf(fieldType);
    const rem   = offset % align;
    if (rem != 0) offset += align - rem;

    typeInfo.fields.set(fieldName, new FieldInfo(offset, fieldType));
    typeInfo.fieldNames.push(fieldName);
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

  const typeInfo = env.types.get(typeName);
  if (!typeInfo.fields.has(fieldName)) {
    return watError(typeName + " has no field: " + fieldName);
  }

  const field   = typeInfo.fields.get(fieldName);
  const ptrExpr = field.offset == 0
    ? ptr
    : watI32Add(ptr, watI32Const(field.offset));

  if (field.typeName == ":u8") return watI32Load8u(ptrExpr);
  if (field.typeName == ":i32" || field.typeName == ":ptr") return watI32Load(ptrExpr);
  if (field.typeName == ":f32") return watF32Load(ptrExpr);
  if (field.typeName == ":i64") return watI64Load(ptrExpr);
  if (field.typeName == ":f64") return watF64Load(ptrExpr);
  if (field.typeName.startsWith(":*")) return watI32Load(ptrExpr); // pointer-to-struct field → i32
  // Embedded struct field → return sub-pointer (caller uses TypeName/subfield on it)
  if (field.typeName.startsWith(":") && env.types.has(field.typeName.slice(1))) return ptrExpr;
  return watError("unsupported field type for get: " + field.typeName);
}

// ─────────────────────────────────────────────────────────────────────────────
// Field setter: (TypeName/field! ptr val)
// Expands to the appropriate store instruction at (ptr + fieldOffset).
// ─────────────────────────────────────────────────────────────────────────────
export function expandFieldSet(typeName: string, fieldName: string,
                                ptr: string, val: string, env: Env): string {
  if (!env.types.has(typeName)) return watError("unknown type: " + typeName);

  const typeInfo = env.types.get(typeName);
  if (!typeInfo.fields.has(fieldName)) {
    return watError(typeName + " has no field: " + fieldName);
  }

  const field   = typeInfo.fields.get(fieldName);
  const ptrExpr = field.offset == 0
    ? ptr
    : watI32Add(ptr, watI32Const(field.offset));

  if (field.typeName == ":u8") return watI32Store8(ptrExpr, val);
  if (field.typeName == ":i32" || field.typeName == ":ptr") return watI32Store(ptrExpr, val);
  if (field.typeName == ":f32") return watF32Store(ptrExpr, val);
  if (field.typeName == ":i64") return watI64Store(ptrExpr, val);
  if (field.typeName == ":f64") return watF64Store(ptrExpr, val);
  if (field.typeName.startsWith(":*")) return watI32Store(ptrExpr, val); // pointer-to-struct field
  // Embedded struct field — cannot set as a whole; use sub-field setters on the sub-pointer
  if (field.typeName.startsWith(":") && env.types.has(field.typeName.slice(1)))
    return watError("use " + field.typeName.slice(1) + "/ sub-field setters on (" + typeName + "/" + fieldName + " ptr)");
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
// Encode all fields of a constructor (TypeName f1 f2 ...) as a flat LE byte string
// (no surrounding quotes). Field values must be compile-time integer/float literals.
// Recursively handles embedded structs.
function encodeStructBytes(ctor: ListNode, typeName: string, env: Env): string {
  if (!env.types.has(typeName)) return "";
  const typeInfo = env.types.get(typeName);
  const fnames   = typeInfo.fieldNames;
  let bytes      = "";
  for (let fi = 0; fi < fnames.length; fi++) {
    const field    = typeInfo.fields.get(fnames[fi]);
    const argNode  = ctor.children[fi + 1]; // +1 to skip constructor name
    const ft       = field.typeName;
    // Padding to field offset: each byteEscape() produces 3 chars (\xx),
    // so bytes.length / 3 = number of bytes encoded so far.
    while (bytes.length / 3 < field.offset) bytes += "\\00";
    if (!ft.startsWith(":*") && ft.startsWith(":") && env.types.has(ft.slice(1))) {
      // Embedded struct: recurse
      if (argNode.tag == TAG_LIST) {
        bytes += encodeStructBytes(argNode as ListNode, ft.slice(1), env);
      }
    } else if (ft == ":u8") {
      const v = argNode.tag == TAG_INT ? i32((argNode as IntNode).value) & 0xff : 0;
      bytes += byteEscape(v);
    } else if (ft == ":i64") {
      const v = argNode.tag == TAG_INT ? (argNode as IntNode).value : 0;
      bytes += encodeI64LEBytes(v);
    } else if (ft == ":f32") {
      const v = argNode.tag == TAG_FLOAT ? f32((argNode as FloatNode).value)
              : argNode.tag == TAG_INT   ? f32(i32((argNode as IntNode).value)) : 0.0;
      bytes += encodeI32LEBytes(reinterpret<i32>(v));
    } else if (ft == ":f64") {
      const v = argNode.tag == TAG_FLOAT ? (argNode as FloatNode).value
              : argNode.tag == TAG_INT   ? f64(i64((argNode as IntNode).value)) : 0.0;
      bytes += encodeI64LEBytes(reinterpret<i64>(v));
    } else {
      // :i32, :ptr, :*T — 4 bytes LE
      const v = argNode.tag == TAG_INT ? i32((argNode as IntNode).value) : 0;
      bytes += encodeI32LEBytes(v);
    }
  }
  return bytes;
}

// Encode an i64 as 8 LE bytes (no surrounding quotes).
function encodeI64LEBytes(n: i64): string {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += byteEscape(i32((n >> (i * 8)) & 0xff));
  }
  return s;
}

function encodeI32LE(n: i32): string {
  const b0 =  n        & 0xff;
  const b1 = (n >>  8) & 0xff;
  const b2 = (n >> 16) & 0xff;
  const b3 = (n >> 24) & 0xff;
  return '"' + byteEscape(b0) + byteEscape(b1) + byteEscape(b2) + byteEscape(b3) + '"';
}

// Like encodeI32LE but returns only the 4 escaped bytes, no surrounding quotes.
// Used to concatenate multiple values into a single WAT string token.
function encodeI32LEBytes(n: i32): string {
  const b0 =  n        & 0xff;
  const b1 = (n >>  8) & 0xff;
  const b2 = (n >> 16) & 0xff;
  const b3 = (n >> 24) & 0xff;
  return byteEscape(b0) + byteEscape(b1) + byteEscape(b2) + byteEscape(b3);
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
  env.statics.set(key, new StaticInfo(ptr, len, ":strlit"));
  env.dataEntries.push(watData(ptr, value));
}
