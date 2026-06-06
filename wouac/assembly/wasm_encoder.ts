// wasm_encoder.ts — WAT string (output of generateModule()) → WASM binary.
// Entry point: watToWasm(wat: string): Array<u8>

// ── Constants ─────────────────────────────────────────────────────────────────
const WT_I32=0x7F, WT_I64=0x7E, WT_F32=0x7D, WT_F64=0x7C, WT_V128=0x7B;
const WT_FUNCREF=0x70, WT_VOID=0x40;
const SEC_TYPE=1,SEC_IMPORT=2,SEC_FUNC=3,SEC_TABLE=4,SEC_MEMORY=5;
const SEC_GLOBAL=6,SEC_EXPORT=7,SEC_ELEMENT=9,SEC_CODE=10,SEC_DATA=11;

// ── BinaryWriter ──────────────────────────────────────────────────────────────
class BW {
  b: Array<u8>;
  constructor() { this.b = new Array<u8>(); }

  byte(v: i32): void { this.b.push(v as u8); }

  u32(v: u32): void {
    do { let x = v & 0x7F; v >>= 7; if (v) x |= 0x80; this.b.push(x as u8); } while (v);
  }

  s32(v: i32): void {
    let more = true;
    while (more) {
      let x = v & 0x7F; v >>= 7;
      more = !((v == 0 && (x & 0x40) == 0) || (v == -1 && (x & 0x40) != 0));
      if (more) x |= 0x80;
      this.b.push(x as u8);
    }
  }

  s64(v: i64): void {
    let more = true;
    while (more) {
      let x = i32(v & 0x7F); v >>= 7;
      more = !((v == 0 && (x & 0x40) == 0) || (v == -1 && (x & 0x40) != 0));
      if (more) x |= 0x80;
      this.b.push(x as u8);
    }
  }

  f32b(v: f32): void {
    const n = reinterpret<u32>(v);
    this.b.push(n as u8); this.b.push((n >> 8) as u8);
    this.b.push((n >> 16) as u8); this.b.push((n >> 24) as u8);
  }

  f64b(v: f64): void {
    const n = reinterpret<u64>(v);
    for (let i = 0; i < 8; i++) this.b.push(i32(n >> (i * 8)) as u8);
  }

  name(s: string): void {
    const e = String.UTF8.encode(s);
    this.u32(e.byteLength as u32);
    for (let i = 0; i < e.byteLength; i++) this.b.push(load<u8>(changetype<usize>(e) + i));
  }

  cat(o: BW): void { for (let i = 0; i < o.b.length; i++) this.b.push(o.b[i]); }

  sec(id: i32, w: BW): void { this.byte(id); this.u32(w.b.length as u32); this.cat(w); }
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────
class Tok { k: i32; t: string; constructor(k: i32, t: string) { this.k = k; this.t = t; } }
const TLP=0, TRP=1, TAT=2, TST=3, TEF=4;

function hxN(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  return c >= 97 && c <= 102 ? c - 87 : 0;
}

class Tzr {
  s: string; p: i32;
  constructor(s: string) { this.s = s; this.p = 0; }

  skip(): void {
    while (this.p < this.s.length) {
      const c = this.s.charCodeAt(this.p);
      if (c == 32 || c == 9 || c == 10 || c == 13) { this.p++; continue; }
      if (c == 59 && this.p + 1 < this.s.length && this.s.charCodeAt(this.p + 1) == 59) {
        while (this.p < this.s.length && this.s.charCodeAt(this.p) != 10) this.p++;
        continue;
      }
      if (c == 40 && this.p + 1 < this.s.length && this.s.charCodeAt(this.p + 1) == 59) {
        this.p += 2;
        while (this.p + 1 < this.s.length) {
          if (this.s.charCodeAt(this.p) == 59 && this.s.charCodeAt(this.p + 1) == 41) { this.p += 2; break; }
          this.p++;
        }
        continue;
      }
      break;
    }
  }

  nx(): Tok {
    this.skip();
    if (this.p >= this.s.length) return new Tok(TEF, "");
    const c = this.s.charCodeAt(this.p);
    if (c == 40) { this.p++; return new Tok(TLP, ""); }
    if (c == 41) { this.p++; return new Tok(TRP, ""); }
    if (c == 34) {
      this.p++; let r = "";
      while (this.p < this.s.length) {
        const ch = this.s.charCodeAt(this.p);
        if (ch == 34) { this.p++; break; }
        if (ch == 92) {
          this.p++; const e = this.s.charCodeAt(this.p);
          if (e == 110) { r += "\n"; this.p++; continue; }
          if (e == 116) { r += "\t"; this.p++; continue; }
          if (e == 114) { r += "\r"; this.p++; continue; }
          if (e == 92)  { r += "\\"; this.p++; continue; }
          if (e == 34)  { r += '"';  this.p++; continue; }
          r += String.fromCharCode((hxN(this.s.charCodeAt(this.p)) << 4) | hxN(this.s.charCodeAt(this.p + 1)));
          this.p += 2; continue;
        }
        r += String.fromCharCode(ch); this.p++;
      }
      return new Tok(TST, r);
    }
    const st = this.p;
    while (this.p < this.s.length) {
      const ch = this.s.charCodeAt(this.p);
      if (ch == 32 || ch == 9 || ch == 10 || ch == 13 || ch == 40 || ch == 41) break;
      this.p++;
    }
    return new Tok(TAT, this.s.slice(st, this.p));
  }

  pk(): Tok { const sv = this.p; const t = this.nx(); this.p = sv; return t; }
}

// ── S-expression ──────────────────────────────────────────────────────────────
class SX {
  atom: bool; str: bool; t: string; ch: Array<SX>;
  constructor(atom: bool, t: string = "", str: bool = false) {
    this.atom = atom; this.t = t; this.str = str; this.ch = new Array<SX>();
  }
  hd(): string { return this.ch.length > 0 && this.ch[0].atom ? this.ch[0].t : ""; }
}

function psx(tz: Tzr): SX | null {
  const tok = tz.nx();
  if (tok.k == TEF || tok.k == TRP) return null;
  if (tok.k == TAT) return new SX(true, tok.t);
  if (tok.k == TST) return new SX(true, tok.t, true);
  const n = new SX(false);
  while (true) {
    const p = tz.pk();
    if (p.k == TEF || p.k == TRP) { tz.nx(); break; }
    const c = psx(tz); if (c != null) n.ch.push(c);
  }
  return n;
}

function parseForms(wat: string): Array<SX> {
  const tz = new Tzr(wat);
  tz.nx(); tz.nx(); // ( module
  const fs = new Array<SX>();
  while (true) {
    const p = tz.pk(); if (p.k == TEF || p.k == TRP) break;
    const f = psx(tz); if (f != null) fs.push(f);
  }
  return fs;
}

// ── Module data structures ────────────────────────────────────────────────────
function wtc(s: string): i32 {
  if (s == "i32") return WT_I32; if (s == "i64") return WT_I64;
  if (s == "f32") return WT_F32; if (s == "f64") return WT_F64;
  if (s == "v128") return WT_V128; if (s == "funcref") return WT_FUNCREF;
  return WT_I32;
}

class FSig {
  p: Array<i32>; r: Array<i32>; k: string;
  constructor(p: Array<i32>, r: Array<i32>) {
    this.p = p; this.r = r;
    let k = ""; for (let i = 0; i < p.length; i++) k += p[i].toString() + ",";
    k += ">"; for (let i = 0; i < r.length; i++) k += r[i].toString() + ",";
    this.k = k;
  }
}

class Imp { m: string; f: string; n: string; s: FSig;
  constructor(m: string, f: string, n: string, s: FSig) { this.m=m; this.f=f; this.n=n; this.s=s; } }

class LDecl { n: string; t: i32;
  constructor(n: string, t: i32) { this.n = n; this.t = t; } }

class FDef { n: string; s: FSig; pnames: Array<string>; locs: Array<LDecl>; body: Array<SX>;
  constructor(n: string, s: FSig, pnames: Array<string>, l: Array<LDecl>, b: Array<SX>) {
    this.n=n; this.s=s; this.pnames=pnames; this.locs=l; this.body=b; } }

class GDef { n: string; t: i32; mut: bool; init: SX;
  constructor(n: string, t: i32, mut: bool, init: SX) { this.n=n; this.t=t; this.mut=mut; this.init=init; } }

class ExpDef { en: string; k: i32; ref: string;
  constructor(en: string, k: i32, ref: string) { this.en=en; this.k=k; this.ref=ref; } }

class DSeg { off: i32; b: Array<u8>;
  constructor(off: i32, b: Array<u8>) { this.off=off; this.b=b; } }

class Mod {
  ntK: Array<string>; ntS: Map<string, FSig>;
  imps: Array<Imp>; fns: Array<FDef>; glbs: Array<GDef>;
  exps: Array<ExpDef>; data: Array<DSeg>;
  mMin: i32; mMax: i32; mSh: bool;
  hasTbl: bool; tSz: i32; elem: Array<string>;
  constructor() {
    this.ntK=new Array<string>(); this.ntS=new Map<string,FSig>();
    this.imps=new Array<Imp>(); this.fns=new Array<FDef>();
    this.glbs=new Array<GDef>(); this.exps=new Array<ExpDef>();
    this.data=new Array<DSeg>();
    this.mMin=1; this.mMax=0; this.mSh=false;
    this.hasTbl=false; this.tSz=0; this.elem=new Array<string>();
  }
}

// ── WAT module parser ─────────────────────────────────────────────────────────
function parseSig(n: SX): FSig {
  const p = new Array<i32>(), r = new Array<i32>();
  for (let i = 1; i < n.ch.length; i++) {
    const c = n.ch[i]; if (c.atom) continue;
    const h = c.hd();
    if (h == "param") {
      let s = 1; if (c.ch.length > 1 && c.ch[1].atom && c.ch[1].t.startsWith("$")) s = 2;
      for (let j = s; j < c.ch.length; j++) p.push(wtc(c.ch[j].t));
    } else if (h == "result") {
      for (let j = 1; j < c.ch.length; j++) r.push(wtc(c.ch[j].t));
    }
  }
  return new FSig(p, r);
}

function parseFD(n: SX): FDef {
  let name = ""; const sp = new Array<i32>(), sr = new Array<i32>();
  const pnames = new Array<string>();
  const locs = new Array<LDecl>(), body = new Array<SX>(); let i = 1;
  if (i < n.ch.length && n.ch[i].atom && n.ch[i].t.startsWith("$")) { name = n.ch[i].t.slice(1); i++; }
  while (i < n.ch.length) {
    const c = n.ch[i];
    if (!c.atom) {
      const h = c.hd();
      if (h == "param") {
        if (c.ch.length > 1 && c.ch[1].atom && c.ch[1].t.startsWith("$")) {
          pnames.push(c.ch[1].t.slice(1)); sp.push(wtc(c.ch[2].t));
        } else { for (let j = 1; j < c.ch.length; j++) { sp.push(wtc(c.ch[j].t)); pnames.push(""); } }
        i++; continue;
      }
      if (h == "result") { for (let j = 1; j < c.ch.length; j++) sr.push(wtc(c.ch[j].t)); i++; continue; }
      if (h == "local") {
        if (c.ch.length >= 3 && c.ch[1].atom && c.ch[1].t.startsWith("$"))
          locs.push(new LDecl(c.ch[1].t.slice(1), wtc(c.ch[2].t)));
        else for (let j = 1; j < c.ch.length; j++) locs.push(new LDecl("", wtc(c.ch[j].t)));
        i++; continue;
      }
    }
    body.push(c); i++;
  }
  return new FDef(name, new FSig(sp, sr), pnames, locs, body);
}

function parseGD(n: SX): GDef {
  let name = "", t = WT_I32, mut = false; let init = new SX(true, "0"); let i = 1;
  if (i < n.ch.length && n.ch[i].atom && n.ch[i].t.startsWith("$")) { name = n.ch[i].t.slice(1); i++; }
  if (i < n.ch.length && !n.ch[i].atom) {
    const tc = n.ch[i];
    if (tc.hd() == "mut") { mut = true; t = tc.ch.length > 1 ? wtc(tc.ch[1].t) : WT_I32; }
    else t = tc.ch.length > 0 ? wtc(tc.ch[0].t) : WT_I32;
    i++;
  }
  if (i < n.ch.length) init = n.ch[i];
  return new GDef(name, t, mut, init);
}

function parseDS(n: SX): DSeg {
  let off = 0; const b = new Array<u8>();
  for (let i = 1; i < n.ch.length; i++) {
    const c = n.ch[i];
    if (!c.atom && c.hd() == "i32.const" && c.ch.length > 1) off = i32(I64.parseInt(c.ch[1].t));
    else if (c.atom && c.str) for (let j = 0; j < c.t.length; j++) b.push(c.t.charCodeAt(j) as u8);
  }
  return new DSeg(off, b);
}

function parseMod(wat: string): Mod {
  const forms = parseForms(wat), m = new Mod();
  for (let i = 0; i < forms.length; i++) {
    const f = forms[i]; if (f.atom) continue;
    const h = f.hd();
    if (h == "type" && f.ch.length >= 3 && f.ch[1].atom && f.ch[1].t.startsWith("$")) {
      const k = f.ch[1].t.slice(1); m.ntK.push(k); m.ntS.set(k, parseSig(f.ch[2]));
    } else if (h == "import" && f.ch.length >= 4) {
      const fd = f.ch[3]; if (fd.hd() == "func") {
        const sig = parseSig(fd); let n = "";
        if (fd.ch.length > 1 && fd.ch[1].atom && fd.ch[1].t.startsWith("$")) n = fd.ch[1].t.slice(1);
        m.imps.push(new Imp(f.ch[1].t, f.ch[2].t, n, sig));
      }
    } else if (h == "memory") {
      m.mMin = f.ch.length > 1 ? i32(I64.parseInt(f.ch[1].t)) : 1;
      if (f.ch.length > 2) {
        const last = f.ch[f.ch.length - 1];
        if (last.atom && last.t == "shared") { m.mSh = true; m.mMax = f.ch.length > 3 ? i32(I64.parseInt(f.ch[2].t)) : m.mMin; }
        else m.mMax = i32(I64.parseInt(f.ch[2].t));
      }
    } else if (h == "table") { m.hasTbl = true; m.tSz = f.ch.length > 1 ? i32(I64.parseInt(f.ch[1].t)) : 0; }
    else if (h == "elem") {
      for (let j = 2; j < f.ch.length; j++) if (f.ch[j].atom && f.ch[j].t.startsWith("$")) m.elem.push(f.ch[j].t.slice(1));
    } else if (h == "global") { m.glbs.push(parseGD(f)); }
    else if (h == "func") { m.fns.push(parseFD(f)); }
    else if (h == "export" && f.ch.length >= 3 && !f.ch[2].atom) {
      const ek = f.ch[2].hd(); let kc = 0;
      if (ek == "memory") kc = 2; else if (ek == "table") kc = 1; else if (ek == "global") kc = 3;
      m.exps.push(new ExpDef(f.ch[1].t, kc, f.ch[2].ch.length > 1 ? f.ch[2].ch[1].t : ""));
    } else if (h == "data") { m.data.push(parseDS(f)); }
  }
  return m;
}

// ── Index tables ──────────────────────────────────────────────────────────────
class Idx {
  tkeys: Array<string>; tsigs: Map<string, FSig>; tidx: Map<string, i32>;
  fidx: Map<string, i32>; gidx: Map<string, i32>; err: string;
  constructor() {
    this.tkeys=new Array<string>(); this.tsigs=new Map<string,FSig>();
    this.tidx=new Map<string,i32>(); this.fidx=new Map<string,i32>(); this.gidx=new Map<string,i32>();
    this.err="";
  }
}

function ensureSig(s: FSig, x: Idx): i32 {
  if (x.tidx.has(s.k)) return x.tidx.get(s.k);
  const i = x.tkeys.length; x.tkeys.push(s.k); x.tsigs.set(s.k, s); x.tidx.set(s.k, i); return i;
}

function buildIdx(m: Mod): Idx {
  const x = new Idx();
  for (let i = 0; i < m.ntK.length; i++) {
    const k = m.ntK[i], sig = m.ntS.get(k);
    const ti = ensureSig(sig, x);
    if (!x.tidx.has(k)) x.tidx.set(k, ti); // alias by $key name
  }
  for (let i = 0; i < m.imps.length; i++) { ensureSig(m.imps[i].s, x); x.fidx.set(m.imps[i].n, i); }
  for (let i = 0; i < m.fns.length; i++)  { ensureSig(m.fns[i].s, x); x.fidx.set(m.fns[i].n, m.imps.length + i); }
  for (let i = 0; i < m.glbs.length; i++) x.gidx.set(m.glbs[i].n, i);
  return x;
}

// ── Function body encoding context ────────────────────────────────────────────
class BCtx {
  fd: FDef; x: Idx; lbls: Array<string>; lmap: Map<string, i32>;
  constructor(fd: FDef, x: Idx) {
    this.fd = fd; this.x = x;
    this.lbls = new Array<string>(); this.lmap = new Map<string, i32>();
    // Named params occupy indices 0..nParams-1
    for (let i = 0; i < fd.pnames.length; i++) {
      if (fd.pnames[i] != "") this.lmap.set(fd.pnames[i], i);
    }
    // Named locals follow params
    let li = fd.s.p.length;
    for (let i = 0; i < fd.locs.length; i++) {
      if (fd.locs[i].n != "") this.lmap.set(fd.locs[i].n, li);
      li++;
    }
  }

  depth(lbl: string): i32 {
    for (let i = this.lbls.length - 1; i >= 0; i--) if (this.lbls[i] == lbl) return this.lbls.length - 1 - i;
    return 0;
  }

  local(name: string): i32 {
    if (this.lmap.has(name)) return this.lmap.get(name);
    // Fallback linear search
    for (let i = 0; i < this.fd.locs.length; i++) if (this.fd.locs[i].n == name) return this.fd.s.p.length + i;
    return 0;
  }

  func(name: string): i32 {
    const n = name.startsWith("$") ? name.slice(1) : name;
    if (!this.x.fidx.has(n)) { if (this.x.err == "") this.x.err = "undefined function: " + n; return 0; }
    return this.x.fidx.get(n);
  }

  glob(name: string): i32 {
    const n = name.startsWith("$") ? name.slice(1) : name;
    return this.x.gidx.has(n) ? this.x.gidx.get(n) : 0;
  }
}

// Re-scan raw WAT func node to capture named param indices too
function buildParamNames(fd: FDef, raw: SX, ctx: BCtx): void {
  let pi = 0;
  for (let i = 1; i < raw.ch.length; i++) {
    const c = raw.ch[i]; if (c.atom) break;
    const h = c.hd();
    if (h == "param") {
      if (c.ch.length >= 3 && c.ch[1].atom && c.ch[1].t.startsWith("$"))
        ctx.lmap.set(c.ch[1].t.slice(1), pi);
      pi++; continue;
    }
    if (h == "result") continue;
    break;
  }
}

// ── Result type helpers ───────────────────────────────────────────────────────
function findResult(ch: Array<SX>, from: i32): Array<SX> {
  for (let i = from; i < ch.length; i++) {
    if (!ch[i].atom && ch[i].hd() == "result") {
      const r = new Array<SX>(); for (let j = 1; j < ch[i].ch.length; j++) r.push(ch[i].ch[j]); return r;
    }
  }
  return new Array<SX>();
}

function emitBT(w: BW, rt: Array<SX>, ctx: BCtx): void {
  if (rt.length == 0) { w.byte(WT_VOID); return; }
  if (rt.length == 1) { w.byte(wtc(rt[0].t)); return; }
  // multi-value: register anonymous type and emit as s33
  const p = new Array<i32>(), r = new Array<i32>();
  for (let i = 0; i < rt.length; i++) r.push(wtc(rt[i].t));
  const sig = new FSig(p, r); const ti = ensureSig(sig, ctx.x);
  w.s32(ti);
}

// ── SIMD opcode table ─────────────────────────────────────────────────────────
function simdOp(op: string): i32 {
  if (op=="v128.load") return 0; if (op=="v128.store") return 11; if (op=="v128.const") return 12;
  if (op=="i8x16.shuffle") return 13; if (op=="i8x16.swizzle") return 14;
  if (op=="i8x16.splat") return 15; if (op=="i16x8.splat") return 16;
  if (op=="i32x4.splat") return 17; if (op=="i64x2.splat") return 18;
  if (op=="f32x4.splat") return 19; if (op=="f64x2.splat") return 20;
  if (op=="i8x16.extract_lane_s") return 21; if (op=="i8x16.extract_lane_u") return 22;
  if (op=="i8x16.replace_lane") return 23; if (op=="i16x8.extract_lane_s") return 24;
  if (op=="i16x8.extract_lane_u") return 25; if (op=="i16x8.replace_lane") return 26;
  if (op=="i32x4.extract_lane") return 27; if (op=="i32x4.replace_lane") return 28;
  if (op=="i64x2.extract_lane") return 29; if (op=="i64x2.replace_lane") return 30;
  if (op=="f32x4.extract_lane") return 31; if (op=="f32x4.replace_lane") return 32;
  if (op=="f64x2.extract_lane") return 33; if (op=="f64x2.replace_lane") return 34;
  if (op=="i8x16.eq")  return 35; if (op=="i8x16.ne")  return 36;
  if (op=="i8x16.lt_s") return 37; if (op=="i8x16.lt_u") return 38;
  if (op=="i8x16.gt_s") return 39; if (op=="i8x16.gt_u") return 40;
  if (op=="i8x16.le_s") return 41; if (op=="i8x16.le_u") return 42;
  if (op=="i8x16.ge_s") return 43; if (op=="i8x16.ge_u") return 44;
  if (op=="i16x8.eq")  return 45; if (op=="i16x8.ne")  return 46;
  if (op=="i16x8.lt_s") return 47; if (op=="i16x8.lt_u") return 48;
  if (op=="i16x8.gt_s") return 49; if (op=="i16x8.gt_u") return 50;
  if (op=="i16x8.le_s") return 51; if (op=="i16x8.le_u") return 52;
  if (op=="i16x8.ge_s") return 53; if (op=="i16x8.ge_u") return 54;
  if (op=="i32x4.eq")  return 55; if (op=="i32x4.ne")  return 56;
  if (op=="i32x4.lt_s") return 57; if (op=="i32x4.lt_u") return 58;
  if (op=="i32x4.gt_s") return 59; if (op=="i32x4.gt_u") return 60;
  if (op=="i32x4.le_s") return 61; if (op=="i32x4.le_u") return 62;
  if (op=="i32x4.ge_s") return 63; if (op=="i32x4.ge_u") return 64;
  if (op=="f32x4.eq")  return 65; if (op=="f32x4.ne")  return 66;
  if (op=="f32x4.lt")  return 67; if (op=="f32x4.gt")  return 68;
  if (op=="f32x4.le")  return 69; if (op=="f32x4.ge")  return 70;
  if (op=="f64x2.eq")  return 71; if (op=="f64x2.ne")  return 72;
  if (op=="f64x2.lt")  return 73; if (op=="f64x2.gt")  return 74;
  if (op=="f64x2.le")  return 75; if (op=="f64x2.ge")  return 76;
  if (op=="v128.not")  return 77; if (op=="v128.and")  return 78;
  if (op=="v128.andnot") return 79; if (op=="v128.or") return 80;
  if (op=="v128.xor")  return 81; if (op=="v128.bitselect") return 82;
  if (op=="v128.any_true") return 83;
  if (op=="i8x16.abs") return 96; if (op=="i8x16.neg") return 97;
  if (op=="i8x16.popcnt") return 98; if (op=="i8x16.all_true") return 99;
  if (op=="i8x16.narrow_i16x8_s") return 101; if (op=="i8x16.narrow_i16x8_u") return 102;
  if (op=="f32x4.ceil") return 103; if (op=="f32x4.floor") return 104;
  if (op=="f32x4.trunc") return 105; if (op=="f32x4.nearest") return 106;
  if (op=="i8x16.shl") return 107; if (op=="i8x16.shr_s") return 108; if (op=="i8x16.shr_u") return 109;
  if (op=="i8x16.add") return 110; if (op=="i8x16.add_sat_s") return 111; if (op=="i8x16.add_sat_u") return 112;
  if (op=="i8x16.sub") return 113; if (op=="i8x16.sub_sat_s") return 114; if (op=="i8x16.sub_sat_u") return 115;
  if (op=="f64x2.ceil") return 116; if (op=="f64x2.floor") return 117;
  if (op=="i8x16.min_s") return 118; if (op=="i8x16.min_u") return 119;
  if (op=="i8x16.max_s") return 120; if (op=="i8x16.max_u") return 121;
  if (op=="f64x2.trunc") return 122; if (op=="i8x16.avgr_u") return 123;
  if (op=="i16x8.extadd_pairwise_i8x16_s") return 124; if (op=="i16x8.extadd_pairwise_i8x16_u") return 125;
  if (op=="i32x4.extadd_pairwise_i16x8_s") return 126; if (op=="i32x4.extadd_pairwise_i16x8_u") return 127;
  if (op=="i16x8.abs") return 128; if (op=="i16x8.neg") return 129;
  if (op=="i16x8.q15mulr_sat_s") return 130; if (op=="i16x8.all_true") return 131;
  if (op=="i16x8.narrow_i32x4_s") return 133; if (op=="i16x8.narrow_i32x4_u") return 134;
  if (op=="i16x8.extend_low_i8x16_s") return 135; if (op=="i16x8.extend_high_i8x16_s") return 136;
  if (op=="i16x8.extend_low_i8x16_u") return 137; if (op=="i16x8.extend_high_i8x16_u") return 138;
  if (op=="i16x8.shl") return 139; if (op=="i16x8.shr_s") return 140; if (op=="i16x8.shr_u") return 141;
  if (op=="i16x8.add") return 142; if (op=="i16x8.add_sat_s") return 143; if (op=="i16x8.add_sat_u") return 144;
  if (op=="i16x8.sub") return 145; if (op=="i16x8.sub_sat_s") return 146; if (op=="i16x8.sub_sat_u") return 147;
  if (op=="f64x2.nearest") return 148; if (op=="i16x8.mul") return 149;
  if (op=="i16x8.min_s") return 150; if (op=="i16x8.min_u") return 151;
  if (op=="i16x8.max_s") return 152; if (op=="i16x8.max_u") return 153;
  if (op=="i16x8.avgr_u") return 155;
  if (op=="i32x4.abs") return 160; if (op=="i32x4.neg") return 161; if (op=="i32x4.all_true") return 163;
  if (op=="i32x4.extend_low_i16x8_s") return 167; if (op=="i32x4.extend_high_i16x8_s") return 168;
  if (op=="i32x4.extend_low_i16x8_u") return 169; if (op=="i32x4.extend_high_i16x8_u") return 170;
  if (op=="i32x4.shl") return 171; if (op=="i32x4.shr_s") return 172; if (op=="i32x4.shr_u") return 173;
  if (op=="i32x4.add") return 174; if (op=="i32x4.sub") return 177; if (op=="i32x4.mul") return 181;
  if (op=="i32x4.min_s") return 182; if (op=="i32x4.min_u") return 183;
  if (op=="i32x4.max_s") return 184; if (op=="i32x4.max_u") return 185;
  if (op=="i32x4.dot_i16x8_s") return 186;
  if (op=="i64x2.abs") return 192; if (op=="i64x2.neg") return 193; if (op=="i64x2.all_true") return 195;
  if (op=="i64x2.extend_low_i32x4_s") return 199; if (op=="i64x2.extend_high_i32x4_s") return 200;
  if (op=="i64x2.extend_low_i32x4_u") return 201; if (op=="i64x2.extend_high_i32x4_u") return 202;
  if (op=="i64x2.shl") return 203; if (op=="i64x2.shr_s") return 204; if (op=="i64x2.shr_u") return 205;
  if (op=="i64x2.add") return 206; if (op=="i64x2.sub") return 209; if (op=="i64x2.mul") return 213;
  if (op=="i64x2.eq") return 214; if (op=="i64x2.ne") return 215;
  if (op=="i64x2.lt_s") return 216; if (op=="i64x2.gt_s") return 217;
  if (op=="i64x2.le_s") return 218; if (op=="i64x2.ge_s") return 219;
  if (op=="f32x4.abs") return 224; if (op=="f32x4.neg") return 225; if (op=="f32x4.sqrt") return 227;
  if (op=="f32x4.add") return 228; if (op=="f32x4.sub") return 229;
  if (op=="f32x4.mul") return 230; if (op=="f32x4.div") return 231;
  if (op=="f32x4.min") return 232; if (op=="f32x4.max") return 233;
  if (op=="f32x4.pmin") return 234; if (op=="f32x4.pmax") return 235;
  if (op=="f64x2.abs") return 236; if (op=="f64x2.neg") return 237; if (op=="f64x2.sqrt") return 239;
  if (op=="f64x2.add") return 240; if (op=="f64x2.sub") return 241;
  if (op=="f64x2.mul") return 242; if (op=="f64x2.div") return 243;
  if (op=="f64x2.min") return 244; if (op=="f64x2.max") return 245;
  if (op=="f64x2.pmin") return 246; if (op=="f64x2.pmax") return 247;
  if (op=="i32x4.trunc_sat_f32x4_s") return 248; if (op=="i32x4.trunc_sat_f32x4_u") return 249;
  if (op=="f32x4.convert_i32x4_s") return 250; if (op=="f32x4.convert_i32x4_u") return 251;
  if (op=="i32x4.trunc_sat_f64x2_s_zero") return 252; if (op=="i32x4.trunc_sat_f64x2_u_zero") return 253;
  if (op=="f64x2.convert_low_i32x4_s") return 254; if (op=="f64x2.convert_low_i32x4_u") return 255;
  if (op=="f32x4.demote_f64x2_zero") return 94; if (op=="f64x2.promote_low_f32x4") return 95;
  return -1;
}

function memAlign(op: string): i32 {
  if (op=="i32.load"||op=="i32.store"||op=="f32.load"||op=="f32.store") return 2;
  if (op=="i64.load"||op=="i64.store"||op=="f64.load"||op=="f64.store") return 3;
  if (op=="i32.load8_u"||op=="i32.load8_s"||op=="i32.store8") return 0;
  if (op=="i32.load16_u"||op=="i32.load16_s"||op=="i32.store16") return 1;
  if (op=="i64.load8_u"||op=="i64.load8_s"||op=="i64.store8") return 0;
  if (op=="i64.load16_u"||op=="i64.load16_s"||op=="i64.store16") return 1;
  if (op=="i64.load32_u"||op=="i64.load32_s"||op=="i64.store32") return 2;
  if (op=="v128.load"||op=="v128.store") return 4;
  return 0;
}

// Check if an opcode is a memory instruction
function isMem(op: string): bool {
  return op=="i32.load"||op=="i64.load"||op=="f32.load"||op=="f64.load"||
         op=="i32.load8_s"||op=="i32.load8_u"||op=="i32.load16_s"||op=="i32.load16_u"||
         op=="i64.load8_s"||op=="i64.load8_u"||op=="i64.load16_s"||op=="i64.load16_u"||
         op=="i64.load32_s"||op=="i64.load32_u"||
         op=="i32.store"||op=="i64.store"||op=="f32.store"||op=="f64.store"||
         op=="i32.store8"||op=="i32.store16"||op=="i64.store8"||op=="i64.store16"||op=="i64.store32";
}

function memByte(op: string): i32 {
  if (op=="i32.load")    return 0x28; if (op=="i64.load")    return 0x29;
  if (op=="f32.load")    return 0x2A; if (op=="f64.load")    return 0x2B;
  if (op=="i32.load8_s") return 0x2C; if (op=="i32.load8_u") return 0x2D;
  if (op=="i32.load16_s")return 0x2E; if (op=="i32.load16_u")return 0x2F;
  if (op=="i64.load8_s") return 0x30; if (op=="i64.load8_u") return 0x31;
  if (op=="i64.load16_s")return 0x32; if (op=="i64.load16_u")return 0x33;
  if (op=="i64.load32_s")return 0x34; if (op=="i64.load32_u")return 0x35;
  if (op=="i32.store")   return 0x36; if (op=="i64.store")   return 0x37;
  if (op=="f32.store")   return 0x38; if (op=="f64.store")   return 0x39;
  if (op=="i32.store8")  return 0x3A; if (op=="i32.store16") return 0x3B;
  if (op=="i64.store8")  return 0x3C; if (op=="i64.store16") return 0x3D; if (op=="i64.store32") return 0x3E;
  return 0;
}

function simpleByte(op: string): i32 {
  if (op=="i32.eqz")  return 0x45; if (op=="i32.eq")   return 0x46; if (op=="i32.ne")   return 0x47;
  if (op=="i32.lt_s") return 0x48; if (op=="i32.lt_u") return 0x49; if (op=="i32.gt_s") return 0x4A;
  if (op=="i32.gt_u") return 0x4B; if (op=="i32.le_s") return 0x4C; if (op=="i32.le_u") return 0x4D;
  if (op=="i32.ge_s") return 0x4E; if (op=="i32.ge_u") return 0x4F;
  if (op=="i64.eqz")  return 0x50; if (op=="i64.eq")   return 0x51; if (op=="i64.ne")   return 0x52;
  if (op=="i64.lt_s") return 0x53; if (op=="i64.lt_u") return 0x54; if (op=="i64.gt_s") return 0x55;
  if (op=="i64.gt_u") return 0x56; if (op=="i64.le_s") return 0x57; if (op=="i64.le_u") return 0x58;
  if (op=="i64.ge_s") return 0x59; if (op=="i64.ge_u") return 0x5A;
  if (op=="f32.eq")   return 0x5B; if (op=="f32.ne")   return 0x5C; if (op=="f32.lt")   return 0x5D;
  if (op=="f32.gt")   return 0x5E; if (op=="f32.le")   return 0x5F; if (op=="f32.ge")   return 0x60;
  if (op=="f64.eq")   return 0x61; if (op=="f64.ne")   return 0x62; if (op=="f64.lt")   return 0x63;
  if (op=="f64.gt")   return 0x64; if (op=="f64.le")   return 0x65; if (op=="f64.ge")   return 0x66;
  if (op=="i32.clz")  return 0x67; if (op=="i32.ctz")  return 0x68; if (op=="i32.popcnt") return 0x69;
  if (op=="i32.add")  return 0x6A; if (op=="i32.sub")  return 0x6B; if (op=="i32.mul")  return 0x6C;
  if (op=="i32.div_s")return 0x6D; if (op=="i32.div_u")return 0x6E; if (op=="i32.rem_s")return 0x6F;
  if (op=="i32.rem_u")return 0x70; if (op=="i32.and")  return 0x71; if (op=="i32.or")   return 0x72;
  if (op=="i32.xor")  return 0x73; if (op=="i32.shl")  return 0x74; if (op=="i32.shr_s")return 0x75;
  if (op=="i32.shr_u")return 0x76; if (op=="i32.rotl") return 0x77; if (op=="i32.rotr") return 0x78;
  if (op=="i64.clz")  return 0x79; if (op=="i64.ctz")  return 0x7A; if (op=="i64.popcnt") return 0x7B;
  if (op=="i64.add")  return 0x7C; if (op=="i64.sub")  return 0x7D; if (op=="i64.mul")  return 0x7E;
  if (op=="i64.div_s")return 0x7F; if (op=="i64.div_u")return 0x80; if (op=="i64.rem_s")return 0x81;
  if (op=="i64.rem_u")return 0x82; if (op=="i64.and")  return 0x83; if (op=="i64.or")   return 0x84;
  if (op=="i64.xor")  return 0x85; if (op=="i64.shl")  return 0x86; if (op=="i64.shr_s")return 0x87;
  if (op=="i64.shr_u")return 0x88; if (op=="i64.rotl") return 0x89; if (op=="i64.rotr") return 0x8A;
  if (op=="f32.abs")  return 0x8B; if (op=="f32.neg")  return 0x8C; if (op=="f32.ceil") return 0x8D;
  if (op=="f32.floor")return 0x8E; if (op=="f32.trunc")return 0x8F; if (op=="f32.nearest") return 0x90;
  if (op=="f32.sqrt") return 0x91; if (op=="f32.add")  return 0x92; if (op=="f32.sub")  return 0x93;
  if (op=="f32.mul")  return 0x94; if (op=="f32.div")  return 0x95; if (op=="f32.min")  return 0x96;
  if (op=="f32.max")  return 0x97; if (op=="f32.copysign") return 0x98;
  if (op=="f64.abs")  return 0x99; if (op=="f64.neg")  return 0x9A; if (op=="f64.ceil") return 0x9B;
  if (op=="f64.floor")return 0x9C; if (op=="f64.trunc")return 0x9D; if (op=="f64.nearest") return 0x9E;
  if (op=="f64.sqrt") return 0x9F; if (op=="f64.add")  return 0xA0; if (op=="f64.sub")  return 0xA1;
  if (op=="f64.mul")  return 0xA2; if (op=="f64.div")  return 0xA3; if (op=="f64.min")  return 0xA4;
  if (op=="f64.max")  return 0xA5; if (op=="f64.copysign") return 0xA6;
  if (op=="i32.wrap_i64")       return 0xA7;
  if (op=="i32.trunc_f32_s")    return 0xA8; if (op=="i32.trunc_f32_u")    return 0xA9;
  if (op=="i32.trunc_f64_s")    return 0xAA; if (op=="i32.trunc_f64_u")    return 0xAB;
  if (op=="i64.extend_i32_s")   return 0xAC; if (op=="i64.extend_i32_u")   return 0xAD;
  if (op=="i64.trunc_f32_s")    return 0xAE; if (op=="i64.trunc_f32_u")    return 0xAF;
  if (op=="i64.trunc_f64_s")    return 0xB0; if (op=="i64.trunc_f64_u")    return 0xB1;
  if (op=="f32.convert_i32_s")  return 0xB2; if (op=="f32.convert_i32_u")  return 0xB3;
  if (op=="f32.convert_i64_s")  return 0xB4; if (op=="f32.convert_i64_u")  return 0xB5;
  if (op=="f32.demote_f64")     return 0xB6;
  if (op=="f64.convert_i32_s")  return 0xB7; if (op=="f64.convert_i32_u")  return 0xB8;
  if (op=="f64.convert_i64_s")  return 0xB9; if (op=="f64.convert_i64_u")  return 0xBA;
  if (op=="f64.promote_f32")    return 0xBB;
  if (op=="i32.reinterpret_f32")return 0xBC; if (op=="i64.reinterpret_f64")return 0xBD;
  if (op=="f32.reinterpret_i32")return 0xBE; if (op=="f64.reinterpret_i64")return 0xBF;
  if (op=="i32.extend8_s")  return 0xC0; if (op=="i32.extend16_s") return 0xC1;
  if (op=="i64.extend8_s")  return 0xC2; if (op=="i64.extend16_s") return 0xC3;
  if (op=="i64.extend32_s") return 0xC4;
  if (op=="unreachable") return 0x00; if (op=="nop") return 0x01;
  if (op=="return")      return 0x0F; if (op=="drop") return 0x1A; if (op=="select") return 0x1B;
  return -1;
}

// ── v128.const encoder ────────────────────────────────────────────────────────
function emitV128Const(w: BW, sx: SX): void {
  w.byte(0xFD); w.u32(12);
  if (sx.ch.length < 2) { for (let i = 0; i < 16; i++) w.byte(0); return; }
  const lt = sx.ch[1].t;
  if (lt == "i8x16") {
    for (let i = 0; i < 16; i++) { const v = i+2 < sx.ch.length ? i32(I64.parseInt(sx.ch[i+2].t)) : 0; w.byte(v & 0xFF); }
  } else if (lt == "i16x8") {
    for (let i = 0; i < 8; i++) { const v = i+2 < sx.ch.length ? i32(I64.parseInt(sx.ch[i+2].t)) : 0; w.byte(v&0xFF); w.byte((v>>8)&0xFF); }
  } else if (lt == "i32x4") {
    for (let i = 0; i < 4; i++) { const v = i+2 < sx.ch.length ? i32(I64.parseInt(sx.ch[i+2].t)) : 0; w.byte(v&0xFF); w.byte((v>>8)&0xFF); w.byte((v>>16)&0xFF); w.byte((v>>24)&0xFF); }
  } else if (lt == "i64x2") {
    for (let i = 0; i < 2; i++) { const v = i+2 < sx.ch.length ? I64.parseInt(sx.ch[i+2].t) : 0; for (let b=0;b<8;b++) w.byte(i32((v>>(b*8))&0xFF)); }
  } else if (lt == "f32x4") {
    for (let i = 0; i < 4; i++) { const fv = f32(F64.parseFloat(i+2<sx.ch.length?sx.ch[i+2].t:"0")); w.f32b(fv); }
  } else if (lt == "f64x2") {
    for (let i = 0; i < 2; i++) { const fv = F64.parseFloat(i+2<sx.ch.length?sx.ch[i+2].t:"0"); w.f64b(fv); }
  } else { for (let i = 0; i < 16; i++) w.byte(0); }
}

// ── Instruction encoder ───────────────────────────────────────────────────────
function encodeBody(w: BW, insns: Array<SX>, ctx: BCtx): void {
  for (let i = 0; i < insns.length; i++) encodeInsn(w, insns[i], ctx);
}

function encodeInsn(w: BW, sx: SX, ctx: BCtx): void {
  if (sx.atom) {
    const sb = simpleByte(sx.t); if (sb >= 0) w.byte(sb);
    return;
  }
  if (sx.ch.length == 0) return;
  const op = sx.ch[0].atom ? sx.ch[0].t : "";

  // ── control ───────────────────────────────────────────────────────────────
  if (op == "block" || op == "loop") {
    const code = op == "block" ? 0x02 : 0x03;
    let lbl = ""; let bs = 1;
    if (bs < sx.ch.length && sx.ch[bs].atom && sx.ch[bs].t.startsWith("$")) { lbl = sx.ch[bs].t.slice(1); bs++; }
    const rt = findResult(sx.ch, bs); if (rt.length > 0) bs++;
    w.byte(code); emitBT(w, rt, ctx);
    ctx.lbls.push(lbl);
    for (let i = bs; i < sx.ch.length; i++) encodeInsn(w, sx.ch[i], ctx);
    ctx.lbls.pop(); w.byte(0x0B); return;
  }

  if (op == "if") {
    let i = 1;
    const rt = new Array<SX>();
    if (i < sx.ch.length && !sx.ch[i].atom && sx.ch[i].hd() == "result") {
      for (let j = 1; j < sx.ch[i].ch.length; j++) rt.push(sx.ch[i].ch[j]); i++;
    }
    while (i < sx.ch.length) {
      const c = sx.ch[i]; if (!c.atom && (c.hd()=="then"||c.hd()=="else")) break;
      encodeInsn(w, c, ctx); i++;
    }
    w.byte(0x04); emitBT(w, rt, ctx); ctx.lbls.push("");
    if (i < sx.ch.length && !sx.ch[i].atom && sx.ch[i].hd()=="then") {
      for (let j = 1; j < sx.ch[i].ch.length; j++) encodeInsn(w, sx.ch[i].ch[j], ctx); i++;
    }
    if (i < sx.ch.length && !sx.ch[i].atom && sx.ch[i].hd()=="else") {
      w.byte(0x05);
      for (let j = 1; j < sx.ch[i].ch.length; j++) encodeInsn(w, sx.ch[i].ch[j], ctx);
    }
    ctx.lbls.pop(); w.byte(0x0B); return;
  }

  if (op == "br") { const l=sx.ch.length>1?sx.ch[1].t.slice(1):""; w.byte(0x0C); w.u32(ctx.depth(l) as u32); return; }
  if (op == "br_if") {
    const l=sx.ch.length>1?sx.ch[1].t.slice(1):"";
    if (sx.ch.length > 2) encodeInsn(w, sx.ch[2], ctx);
    w.byte(0x0D); w.u32(ctx.depth(l) as u32); return;
  }
  if (op == "return") { for (let i=1;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx); w.byte(0x0F); return; }
  if (op == "unreachable") { w.byte(0x00); return; }
  if (op == "nop")         { w.byte(0x01); return; }
  if (op == "drop")    { for (let i=1;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx); w.byte(0x1A); return; }
  if (op == "select")  { for (let i=1;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx); w.byte(0x1B); return; }

  if (op == "call") {
    const n=sx.ch.length>1?sx.ch[1].t.slice(1):"";
    for (let i=2;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx);
    w.byte(0x10); w.u32(ctx.func(n) as u32); return;
  }
  if (op == "return_call") {
    const n=sx.ch.length>1?sx.ch[1].t.slice(1):"";
    for (let i=2;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx);
    w.byte(0x12); w.u32(ctx.func(n) as u32); return;
  }
  if (op == "call_indirect" || op == "return_call_indirect") {
    let tk=""; let as2=1;
    if (sx.ch.length>1&&!sx.ch[1].atom&&sx.ch[1].hd()=="type") { if(sx.ch[1].ch.length>1)tk=sx.ch[1].ch[1].t.slice(1); as2=2; }
    for (let i=as2;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx);
    const ti=ctx.x.tidx.has(tk)?ctx.x.tidx.get(tk):0;
    w.byte(op=="call_indirect"?0x11:0x13); w.u32(ti as u32); w.u32(0); return;
  }

  // ── locals / globals ─────────────────────────────────────────────────────
  if (op == "local.get") { const n=sx.ch.length>1?sx.ch[1].t.slice(1):""; w.byte(0x20); w.u32(ctx.local(n) as u32); return; }
  if (op == "local.set") { const n=sx.ch.length>1?sx.ch[1].t.slice(1):""; for(let i=2;i<sx.ch.length;i++)encodeInsn(w,sx.ch[i],ctx); w.byte(0x21); w.u32(ctx.local(n) as u32); return; }
  if (op == "local.tee") { const n=sx.ch.length>1?sx.ch[1].t.slice(1):""; for(let i=2;i<sx.ch.length;i++)encodeInsn(w,sx.ch[i],ctx); w.byte(0x22); w.u32(ctx.local(n) as u32); return; }
  if (op == "global.get") { const n=sx.ch.length>1?sx.ch[1].t.slice(1):""; w.byte(0x23); w.u32(ctx.glob(n) as u32); return; }
  if (op == "global.set") { const n=sx.ch.length>1?sx.ch[1].t.slice(1):""; for(let i=2;i<sx.ch.length;i++)encodeInsn(w,sx.ch[i],ctx); w.byte(0x24); w.u32(ctx.glob(n) as u32); return; }

  // ── constants ─────────────────────────────────────────────────────────────
  if (op == "i32.const") { const v=sx.ch.length>1?i32(I64.parseInt(sx.ch[1].t)):0; w.byte(0x41); w.s32(v); return; }
  if (op == "i64.const") { const v=sx.ch.length>1?I64.parseInt(sx.ch[1].t):0; w.byte(0x42); w.s64(v); return; }
  if (op == "f32.const") { const v=sx.ch.length>1?f32(F64.parseFloat(sx.ch[1].t)):0.0; w.byte(0x43); w.f32b(v); return; }
  if (op == "f64.const") { const v=sx.ch.length>1?F64.parseFloat(sx.ch[1].t):0.0; w.byte(0x44); w.f64b(v); return; }

  // ── memory ────────────────────────────────────────────────────────────────
  if (op == "memory.size") { w.byte(0x3F); w.byte(0x00); return; }
  if (op == "memory.grow") { if(sx.ch.length>1)encodeInsn(w,sx.ch[1],ctx); w.byte(0x40); w.byte(0x00); return; }
  if (isMem(op)) {
    for (let i=1;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx);
    w.byte(memByte(op)); w.u32(memAlign(op) as u32); w.u32(0); return;
  }

  // ── SIMD ──────────────────────────────────────────────────────────────────
  const sop = simdOp(op);
  if (sop >= 0) {
    if (op == "v128.const") { emitV128Const(w, sx); return; }
    if (op == "i8x16.shuffle") {
      // Operands (two vectors) come before the instruction; 16 lane immediates follow the opcode
      for (let i=17;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx);
      w.byte(0xFD); w.u32(13 as u32);
      for (let i=1;i<=16;i++) { const v=i<sx.ch.length?i32(I64.parseInt(sx.ch[i].t)):0; w.byte(v&0xFF); }
      return;
    }
    // Lane ops (extract/replace): sx.ch[1] = lane index (immediate), sx.ch[2..] = operands
    const hasLane = sop >= 21 && sop <= 34;
    if (hasLane) {
      const lane = sx.ch.length > 1 ? i32(I64.parseInt(sx.ch[1].t)) : 0;
      for (let i=2;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx); // operands first
      w.byte(0xFD); w.u32(sop as u32); w.byte(lane & 0xFF); // opcode + lane immediate
      return;
    }
    // All other SIMD: encode operands first, then opcode (+ memory immediates if load/store)
    for (let i=1;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx);
    w.byte(0xFD); w.u32(sop as u32);
    if (op == "v128.load" || op == "v128.store") { w.u32(memAlign(op) as u32); w.u32(0); }
    return;
  }

  // ── simple opcodes (no children used as operands) ─────────────────────────
  const sb = simpleByte(op);
  if (sb >= 0) { for (let i=1;i<sx.ch.length;i++) encodeInsn(w,sx.ch[i],ctx); w.byte(sb); return; }

  // Unknown: encode children only (best-effort)
  for (let i = 1; i < sx.ch.length; i++) encodeInsn(w, sx.ch[i], ctx);
}

// ── Prescan: register all multi-value block types before type section ─────────
// Multi-value block/loop/if result types need entries in the type section.
// They are used as s33-encoded indices in the block type immediate, so they
// must be registered before the type section is written.
function prescanInsns(insns: Array<SX>, x: Idx): void {
  for (let i = 0; i < insns.length; i++) prescanInsn(insns[i], x);
}

function prescanInsn(sx: SX, x: Idx): void {
  if (sx.atom || sx.ch.length == 0) return;
  const op = sx.ch[0].atom ? sx.ch[0].t : "";
  if (op == "block" || op == "loop") {
    let bs = 1;
    if (bs < sx.ch.length && sx.ch[bs].atom && sx.ch[bs].t.startsWith("$")) bs++;
    const rt = findResult(sx.ch, bs);
    if (rt.length > 1) {
      const r = new Array<i32>();
      for (let j = 0; j < rt.length; j++) r.push(wtc(rt[j].t));
      ensureSig(new FSig(new Array<i32>(), r), x);
    }
    for (let j = bs; j < sx.ch.length; j++) prescanInsn(sx.ch[j], x);
  } else if (op == "if") {
    let i = 1;
    if (i < sx.ch.length && !sx.ch[i].atom && sx.ch[i].hd() == "result") {
      const rtCh = sx.ch[i];
      if (rtCh.ch.length > 2) { // >1 result type (child[0] is "result")
        const r = new Array<i32>();
        for (let j = 1; j < rtCh.ch.length; j++) r.push(wtc(rtCh.ch[j].t));
        ensureSig(new FSig(new Array<i32>(), r), x);
      }
    }
    for (let j = 1; j < sx.ch.length; j++) prescanInsn(sx.ch[j], x);
  } else {
    for (let j = 1; j < sx.ch.length; j++) prescanInsn(sx.ch[j], x);
  }
}

function prescanTypes(m: Mod, x: Idx): void {
  for (let i = 0; i < m.fns.length; i++) prescanInsns(m.fns[i].body, x);
}

// ── Section emitters ──────────────────────────────────────────────────────────
function emitTypeSection(out: BW, x: Idx): void {
  const w = new BW(); w.u32(x.tkeys.length as u32);
  for (let i = 0; i < x.tkeys.length; i++) {
    const sig = x.tsigs.get(x.tkeys[i]);
    w.byte(0x60); w.u32(sig.p.length as u32); for (let j=0;j<sig.p.length;j++) w.byte(sig.p[j]);
    w.u32(sig.r.length as u32); for (let j=0;j<sig.r.length;j++) w.byte(sig.r[j]);
  }
  out.sec(SEC_TYPE, w);
}

function emitImportSection(out: BW, m: Mod, x: Idx): void {
  if (m.imps.length == 0) return;
  const w = new BW(); w.u32(m.imps.length as u32);
  for (let i = 0; i < m.imps.length; i++) {
    const imp = m.imps[i]; const ti = x.tidx.has(imp.s.k) ? x.tidx.get(imp.s.k) : 0;
    w.name(imp.m); w.name(imp.f); w.byte(0x00); w.u32(ti as u32);
  }
  out.sec(SEC_IMPORT, w);
}

function emitFuncSection(out: BW, m: Mod, x: Idx): void {
  if (m.fns.length == 0) return;
  const w = new BW(); w.u32(m.fns.length as u32);
  for (let i = 0; i < m.fns.length; i++) {
    const sig = m.fns[i].s; const ti = x.tidx.has(sig.k) ? x.tidx.get(sig.k) : 0; w.u32(ti as u32);
  }
  out.sec(SEC_FUNC, w);
}

function emitTableSection(out: BW, m: Mod): void {
  if (!m.hasTbl) return;
  const w = new BW(); w.u32(1); w.byte(WT_FUNCREF); w.byte(0x00); w.u32(m.tSz as u32);
  out.sec(SEC_TABLE, w);
}

function emitMemorySection(out: BW, m: Mod): void {
  const w = new BW(); w.u32(1);
  if (m.mSh) { w.byte(0x03); w.u32(m.mMin as u32); w.u32(m.mMax as u32); }
  else if (m.mMax > 0) { w.byte(0x01); w.u32(m.mMin as u32); w.u32(m.mMax as u32); }
  else { w.byte(0x00); w.u32(m.mMin as u32); }
  out.sec(SEC_MEMORY, w);
}

function emitGlobalSection(out: BW, m: Mod, x: Idx): void {
  if (m.glbs.length == 0) return;
  const w = new BW(); w.u32(m.glbs.length as u32);
  for (let i = 0; i < m.glbs.length; i++) {
    const g = m.glbs[i]; w.byte(g.t); w.byte(g.mut ? 1 : 0);
    const ctx = new BCtx(new FDef("", new FSig(new Array<i32>(), new Array<i32>()), new Array<string>(), new Array<LDecl>(), new Array<SX>()), x);
    encodeInsn(w, g.init, ctx); w.byte(0x0B);
  }
  out.sec(SEC_GLOBAL, w);
}

function emitExportSection(out: BW, m: Mod, x: Idx): void {
  if (m.exps.length == 0) return;
  const w = new BW(); w.u32(m.exps.length as u32);
  for (let i = 0; i < m.exps.length; i++) {
    const e = m.exps[i]; w.name(e.en); w.byte(e.k);
    let idx = 0;
    if (e.k == 0) { // func
      const n = e.ref.startsWith("$") ? e.ref.slice(1) : e.ref;
      idx = x.fidx.has(n) ? x.fidx.get(n) : 0;
    } else if (e.k == 2) { idx = 0; } // memory 0
    else if (e.k == 1) { idx = 0; } // table 0
    else if (e.k == 3) { // global
      const n = e.ref.startsWith("$") ? e.ref.slice(1) : e.ref;
      idx = x.gidx.has(n) ? x.gidx.get(n) : 0;
    }
    w.u32(idx as u32);
  }
  out.sec(SEC_EXPORT, w);
}

function emitElementSection(out: BW, m: Mod, x: Idx): void {
  if (m.elem.length == 0) return;
  const w = new BW(); w.u32(1); // one element segment
  w.byte(0x00); // passive with i32.const offset
  w.byte(0x41); w.s32(0); w.byte(0x0B); // i32.const 0; end
  w.u32(m.elem.length as u32);
  for (let i = 0; i < m.elem.length; i++) {
    const n = m.elem[i]; const fi = x.fidx.has(n) ? x.fidx.get(n) : 0; w.u32(fi as u32);
  }
  out.sec(SEC_ELEMENT, w);
}

function emitCodeSection(out: BW, m: Mod, x: Idx): void {
  if (m.fns.length == 0) return;
  const w = new BW(); w.u32(m.fns.length as u32);
  for (let i = 0; i < m.fns.length; i++) {
    const fd = m.fns[i];
    const ctx = new BCtx(fd, x);
    // Group locals by type for compact encoding
    const locW = new BW();
    if (fd.locs.length > 0) {
      // Count runs of same type
      const runs = new Array<i32>(), rtypes = new Array<i32>();
      let curT = fd.locs[0].t, cnt = 1;
      for (let j = 1; j < fd.locs.length; j++) {
        if (fd.locs[j].t == curT) { cnt++; } else { runs.push(cnt); rtypes.push(curT); curT = fd.locs[j].t; cnt = 1; }
      }
      runs.push(cnt); rtypes.push(curT);
      locW.u32(runs.length as u32);
      for (let j = 0; j < runs.length; j++) { locW.u32(runs[j] as u32); locW.byte(rtypes[j]); }
    } else { locW.u32(0); }
    const bodyW = new BW();
    encodeBody(bodyW, fd.body, ctx);
    bodyW.byte(0x0B); // end of function
    const fnW = new BW();
    fnW.cat(locW); fnW.cat(bodyW);
    w.u32(fnW.b.length as u32); w.cat(fnW);
  }
  out.sec(SEC_CODE, w);
}

function emitDataSection(out: BW, m: Mod): void {
  if (m.data.length == 0) return;
  const w = new BW(); w.u32(m.data.length as u32);
  for (let i = 0; i < m.data.length; i++) {
    const d = m.data[i];
    w.byte(0x00); // active, memory 0
    w.byte(0x41); w.s32(d.off); w.byte(0x0B); // i32.const offset; end
    w.u32(d.b.length as u32);
    for (let j = 0; j < d.b.length; j++) w.byte(d.b[j]);
  }
  out.sec(SEC_DATA, w);
}

// ── Entry point ───────────────────────────────────────────────────────────────
export function watToWasm(wat: string): Array<u8> {
  const m = parseMod(wat);
  const x = buildIdx(m);
  prescanTypes(m, x); // register multi-value block types before type section
  const out = new BW();
  // WASM magic + version
  out.byte(0x00); out.byte(0x61); out.byte(0x73); out.byte(0x6D);
  out.byte(0x01); out.byte(0x00); out.byte(0x00); out.byte(0x00);
  emitTypeSection(out, x);
  emitImportSection(out, m, x);
  emitFuncSection(out, m, x);
  emitTableSection(out, m);
  emitMemorySection(out, m);
  emitGlobalSection(out, m, x);
  emitExportSection(out, m, x);
  emitElementSection(out, m, x);
  emitCodeSection(out, m, x);
  if (x.err != "") return new Array<u8>(); // undefined function reference
  emitDataSection(out, m);
  return out.b;
}

