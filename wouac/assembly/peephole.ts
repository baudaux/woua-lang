// peephole.ts — WAT-level peephole optimizer.
//
// Operates on the string body of a single WAT function after codegen.
// Implements five passes:
//
// ── Pass 1: while-loop inversion ─────────────────────────────────────────────
//
//   Converts the top-check/unconditional-br form into a do-while form,
//   eliminating one branch instruction per iteration.
//
// ── Pass 2: tee-swap (3-statement tmp elimination) ───────────────────────────
//
//   Collapses  set $T = f($Y) / set $X = $Y / set $Y = $T  into
//   set $Y = f(... local.tee $X ($Y) ...)  eliminating the tmp local.
//
// ── Pass 3: adjacent set/get → tee or inline ─────────────────────────────────
//
//   Replaces an immediately-consumed (local.set $x) + (local.get $x) pair
//   with local.tee (if $x is read later) or the bare expression (if not).
//
// ── Pass 4: eqz-comparison negation ──────────────────────────────────────────
//
//   Replaces (i32.eqz (OP A B)) → (NEG_OP A B) for integer comparison ops.
//   Eliminates one instruction from every while-loop pre-check and assert.
//
// ── Pass 5: dead local removal ───────────────────────────────────────────────
//
//   Removes (local $name type) declarations and (local.set $name EXPR) dead
//   stores for locals with no remaining reads.  Cleans up $tmp locals left
//   by tee-swap and $_dummy locals emitted by codegen for void if-branches.

// ─── Public entry point ───────────────────────────────────────────────────────

export function peepholeOptimizeBody(body: string): string {
  // Expression-level passes first — so the loop body is already in its
  // most compact form when the structural passes replicate it.
  let prev = "";
  let current = body;
  while (current != prev) {
    prev = current;
    current = eliminateTmpSwap(current);
    current = eliminateSetGet(current);
  }

  // Structural pass runs once on the already-optimised body.
  current = invertWhileLoops(current);

  // Simplify (i32.eqz (CMP A B)) → (NEG_CMP A B) — cleans up the pre-check
  // emitted by loop inversion and assert conditions.
  current = eliminateEqzNegation(current);

  // Remove declaration lines and dead stores for locals with no remaining reads.
  current = removeDeadLocals(current);

  return current;
}

// ─── Pass 1: adjacent set/get → tee or inline ────────────────────────────────

function eliminateSetGet(body: string): string {
  const SET_PREFIX = "(local.set $";
  let out = "";
  let pos = 0;

  while (pos < body.length) {
    const setStart = body.indexOf(SET_PREFIX, pos);
    if (setStart == -1) { out += body.slice(pos); break; }

    out += body.slice(pos, setStart);

    const nameStart = setStart + SET_PREFIX.length;
    let nameEnd = nameStart;
    while (nameEnd < body.length) {
      const c = body.charCodeAt(nameEnd);
      if (c == 32 || c == 41) break;
      nameEnd++;
    }
    const varName = body.slice(nameStart, nameEnd);

    const setEnd = matchingParen(body, setStart);
    if (setEnd == -1) {
      out += body.slice(setStart, setStart + SET_PREFIX.length);
      pos = setStart + SET_PREFIX.length;
      continue;
    }
    const expr = body.slice(nameEnd + 1, setEnd);

    let afterSet = setEnd + 1;
    while (afterSet < body.length && isWS(body.charCodeAt(afterSet))) afterSet++;

    const getStr = "(local.get $" + varName + ")";
    if (body.slice(afterSet, afterSet + getStr.length) == getStr) {
      const afterGet = afterSet + getStr.length;
      const tail = body.slice(afterGet);
      const remainingReads  = countSubstr(tail, "(local.get $"  + varName + ")");
      const remainingWrites = countSubstr(tail, "(local.set $"  + varName + " ")
                            + countSubstr(tail, "(local.tee $"  + varName + " ");

      if (remainingReads == 0 && remainingWrites == 0) {
        out += expr;
      } else {
        out += "(local.tee $" + varName + " " + expr + ")";
      }
      pos = afterGet;
    } else {
      out += body.slice(setStart, setEnd + 1);
      pos = setEnd + 1;
    }
  }
  return out;
}

// ─── Pass 1: while-loop inversion (do-while transformation) ──────────────────
//
// Converts the woua-emitted while form:
//   (block $__while_break
//     (loop $__while_loop
//     (br_if $__while_break (i32.eqz COND))   ← top check  (1 branch/iter)
//       BODY
//       (br $__while_loop)                     ← unconditional (1 branch/iter)
//     )
//   )
//
// into a do-while form:
//   (block $__while_break
//     (br_if $__while_break (i32.eqz COND))   ← pre-check (once, outside loop)
//     (loop $__while_loop
//       BODY
//       (br_if $__while_loop COND)             ← 1 conditional branch/iter
//     )
//   )
//
// Net saving: 1 branch instruction per loop iteration.
// Safe when COND is pure (reads only locals/constants — no calls, loads, globals).
// Nested while loops are left alone (they have the same label names and would
// need careful depth tracking; skipped for safety).

function invertWhileLoops(body: string): string {
  const BLOCK_TAG = "(block $__while_break";
  const LOOP_TAG  = "(loop $__while_loop";
  const BRIF_BREAK_PREFIX = "(br_if $__while_break (i32.eqz ";
  const BR_LOOP   = "(br $__while_loop)";

  let out = "";
  let pos = 0;

  while (pos < body.length) {
    const blockStart = body.indexOf(BLOCK_TAG, pos);
    if (blockStart == -1) { out += body.slice(pos); break; }

    const blockEnd = matchingParen(body, blockStart);
    if (blockEnd == -1) { out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue; }

    // ── loop must be the first child of the block ─────────────────────────
    let p = blockStart + BLOCK_TAG.length;
    while (p < blockEnd && isWS(body.charCodeAt(p))) p++;
    if (body.slice(p, p + LOOP_TAG.length) != LOOP_TAG) {
      out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue;
    }

    const loopStart = p;
    const loopEnd = matchingParen(body, loopStart);
    if (loopEnd == -1) { out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue; }

    // ── first instruction in loop must be br_if $__while_break ───────────
    p = loopStart + LOOP_TAG.length;
    while (p < loopEnd && isWS(body.charCodeAt(p))) p++;
    if (body.slice(p, p + BRIF_BREAK_PREFIX.length) != BRIF_BREAK_PREFIX) {
      out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue;
    }

    const brIfStart = p;
    const brIfEnd = matchingParen(body, brIfStart);
    if (brIfEnd == -1) { out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue; }

    // ── extract COND from (i32.eqz COND) inside the br_if ────────────────
    const EQZP = "(i32.eqz ";
    const eqzIdx = body.indexOf(EQZP, brIfStart + 1);
    if (eqzIdx == -1 || eqzIdx >= brIfEnd) {
      out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue;
    }
    const eqzEnd = matchingParen(body, eqzIdx);
    if (eqzEnd == -1 || eqzEnd > brIfEnd) {
      out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue;
    }
    const cond = body.slice(eqzIdx + EQZP.length, eqzEnd);
    if (cond.length == 0 || !isPureWat(cond)) {
      out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue;
    }

    // ── collect the loop body between br_if and closing paren ─────────────
    let innerStart = brIfEnd + 1;
    while (innerStart < loopEnd && isWS(body.charCodeAt(innerStart))) innerStart++;
    const loopInner = body.slice(innerStart, loopEnd);

    // ── safety: skip if there are nested while loops (same label names) ───
    if (loopInner.includes("(block $__while_break")) {
      out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue;
    }

    // ── last instruction in loop body must be (br $__while_loop) ─────────
    const brIdx = loopInner.lastIndexOf(BR_LOOP);
    if (brIdx == -1) { out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue; }
    let afterBr = brIdx + BR_LOOP.length;
    while (afterBr < loopInner.length && isWS(loopInner.charCodeAt(afterBr))) afterBr++;
    if (afterBr != loopInner.length) {
      // something after the br — bail
      out += body.slice(pos, blockStart + 1); pos = blockStart + 1; continue;
    }

    // ── extract the actual BODY (trim trailing whitespace before br) ──────
    let bodyEnd = brIdx;
    while (bodyEnd > 0 && isWS(loopInner.charCodeAt(bodyEnd - 1))) bodyEnd--;
    const actualBody = loopInner.slice(0, bodyEnd);

    // ── reconstruct do-while form ─────────────────────────────────────────
    // Preserve the br_if text exactly as emitted (comment-safe).
    const brIfText = body.slice(brIfStart, brIfEnd + 1);
    const newStructure =
      "(block $__while_break\n  " +
      brIfText + "\n  " +
      "(loop $__while_loop\n  " +
      actualBody + "\n    " +
      "(br_if $__while_loop " + cond + ")\n" +
      ")\n)";

    out += body.slice(pos, blockStart) + newStructure;
    pos = blockEnd + 1;
  }
  return out;
}

// ─── Pass 2: tee-swap — three-statement tmp elimination ──────────────────────

function eliminateTmpSwap(body: string): string {
  // Match:
  //   (local.set $T  EXPR_T)
  //   (local.set $X  (local.get $Y))
  //   (local.set $Y  (local.get $T))
  // and collapse to:
  //   (local.set $Y  (EXPR_T with last (local.get $Y) → (local.tee $X (local.get $Y))))
  const SET_PREFIX = "(local.set $";
  let out = "";
  let pos = 0;

  while (pos < body.length) {
    // ── Find first set ────────────────────────────────────────────────────
    const s1Start = body.indexOf(SET_PREFIX, pos);
    if (s1Start == -1) { out += body.slice(pos); break; }

    const T = extractName(body, s1Start + SET_PREFIX.length);
    if (T == "") { out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue; }

    const s1End = matchingParen(body, s1Start);
    if (s1End == -1) { out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue; }

    const exprT = body.slice(s1Start + SET_PREFIX.length + T.length + 1, s1End);

    // ── Find second set immediately after ────────────────────────────────
    let after1 = s1End + 1;
    while (after1 < body.length && isWS(body.charCodeAt(after1))) after1++;

    if (body.slice(after1, after1 + SET_PREFIX.length) != SET_PREFIX) {
      out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue;
    }
    const X = extractName(body, after1 + SET_PREFIX.length);
    if (X == "") { out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue; }

    const s2End = matchingParen(body, after1);
    if (s2End == -1) { out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue; }

    // s2Body must be exactly (local.get $Y)
    const s2Body = body.slice(after1 + SET_PREFIX.length + X.length + 1, s2End);
    const GET_PREFIX = "(local.get $";
    if (!s2Body.startsWith(GET_PREFIX) || s2Body.charCodeAt(s2Body.length - 1) != 41) {
      out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue;
    }
    const Y = s2Body.slice(GET_PREFIX.length, s2Body.length - 1);
    if (s2Body != "(local.get $" + Y + ")") {
      out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue;
    }

    // ── Find third set immediately after ─────────────────────────────────
    let after2 = s2End + 1;
    while (after2 < body.length && isWS(body.charCodeAt(after2))) after2++;

    if (body.slice(after2, after2 + SET_PREFIX.length) != SET_PREFIX) {
      out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue;
    }
    const Y2 = extractName(body, after2 + SET_PREFIX.length);
    if (Y2 != Y) { out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue; }

    const s3End = matchingParen(body, after2);
    if (s3End == -1) { out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue; }

    // s3Body must be exactly (local.get $T)
    const s3Body = body.slice(after2 + SET_PREFIX.length + Y2.length + 1, s3End);
    if (s3Body != "(local.get $" + T + ")") {
      out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue;
    }

    // ── Safety checks ─────────────────────────────────────────────────────
    if (T == X || T == Y || X == Y) { out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue; }

    // T must be dead everywhere else (only the one set + one get we just matched)
    const bodyBefore = body.slice(0, s1Start);
    const bodyAfter  = body.slice(s3End + 1);
    if (countSubstr(bodyBefore, "(local.get $" + T + ")") != 0 ||
        countSubstr(bodyAfter,  "(local.get $" + T + ")") != 0 ||
        countSubstr(bodyBefore, "(local.set $" + T + " ") != 0 ||
        countSubstr(bodyAfter,  "(local.set $" + T + " ") != 0) {
      out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue;
    }

    // EXPR_T must be pure
    if (!isPureWat(exprT)) { out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue; }

    // Y must appear in EXPR_T
    const yGet = "(local.get $" + Y + ")";
    const lastYIdx = exprT.lastIndexOf(yGet);
    if (lastYIdx == -1) { out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue; }

    // Every read of X in EXPR_T must precede the last (local.get $Y)
    const xGet = "(local.get $" + X + ")";
    if (exprT.slice(lastYIdx + yGet.length).includes(xGet)) {
      out += body.slice(pos, s1Start + 1); pos = s1Start + 1; continue;
    }

    // ── Rewrite ───────────────────────────────────────────────────────────
    const teeExpr = "(local.tee $" + X + " " + yGet + ")";
    const newExprT = exprT.slice(0, lastYIdx) + teeExpr + exprT.slice(lastYIdx + yGet.length);

    out += body.slice(pos, s1Start);
    out += "(local.set $" + Y + " " + newExprT + ")";
    pos = s3End + 1;
  }
  return out;
}

// ─── Pass 4: eqz-comparison negation ─────────────────────────────────────────
//
// Replaces (i32.eqz (CMP_OP A B)) → (NEG_CMP_OP A B) for integer comparison ops.
// This fires on every loop pre-check emitted by invertWhileLoops as well as on
// assert and if conditions.  The transformation is semantically exact for integer
// ops (all Wasm comparison ops return i32 0/1; i32.eqz flips that to 1/0).

function negationOf(op: string): string {
  if (op == "i32.lt_s") return "i32.ge_s";
  if (op == "i32.lt_u") return "i32.ge_u";
  if (op == "i32.le_s") return "i32.gt_s";
  if (op == "i32.le_u") return "i32.gt_u";
  if (op == "i32.gt_s") return "i32.le_s";
  if (op == "i32.gt_u") return "i32.le_u";
  if (op == "i32.ge_s") return "i32.lt_s";
  if (op == "i32.ge_u") return "i32.lt_u";
  if (op == "i32.eq")   return "i32.ne";
  if (op == "i32.ne")   return "i32.eq";
  if (op == "i64.lt_s") return "i64.ge_s";
  if (op == "i64.lt_u") return "i64.ge_u";
  if (op == "i64.le_s") return "i64.gt_s";
  if (op == "i64.le_u") return "i64.gt_u";
  if (op == "i64.gt_s") return "i64.le_s";
  if (op == "i64.gt_u") return "i64.le_u";
  if (op == "i64.ge_s") return "i64.lt_s";
  if (op == "i64.ge_u") return "i64.lt_u";
  if (op == "i64.eq")   return "i64.ne";
  if (op == "i64.ne")   return "i64.eq";
  return "";
}

function eliminateEqzNegation(body: string): string {
  // Search for (i32.eqz (OP ...) ) where OP is a negatable comparison.
  const EQZ_PREFIX = "(i32.eqz (";
  let out = "";
  let pos = 0;

  while (pos < body.length) {
    const eqzStart = body.indexOf(EQZ_PREFIX, pos);
    if (eqzStart == -1) { out += body.slice(pos); break; }

    // innerStart is the position of '(' that begins the inner expression.
    const innerStart = eqzStart + EQZ_PREFIX.length - 1;
    const innerEnd = matchingParen(body, innerStart);
    if (innerEnd == -1) { out += body.slice(pos, eqzStart + 1); pos = eqzStart + 1; continue; }

    // The outer closing ')' of (i32.eqz ...) must immediately follow.
    if (innerEnd + 1 >= body.length || body.charCodeAt(innerEnd + 1) != 41) {
      out += body.slice(pos, eqzStart + 1); pos = eqzStart + 1; continue;
    }

    // inner = "(OP ARGS)"
    const inner = body.slice(innerStart, innerEnd + 1);
    const spaceIdx = inner.indexOf(" ");
    if (spaceIdx == -1) { out += body.slice(pos, eqzStart + 1); pos = eqzStart + 1; continue; }

    const innerOp  = inner.slice(1, spaceIdx);       // e.g. "i32.lt_s"
    const negOp    = negationOf(innerOp);
    if (negOp == "") { out += body.slice(pos, eqzStart + 1); pos = eqzStart + 1; continue; }

    // Emit (NEG_OP ARGS) in place of (i32.eqz (OP ARGS))
    const innerArgs = inner.slice(spaceIdx + 1, inner.length - 1);  // strip outer parens
    out += body.slice(pos, eqzStart) + "(" + negOp + " " + innerArgs + ")";
    pos = innerEnd + 2;  // skip inner ')' and outer ')'
  }
  return out;
}

// ─── Pass 5: dead local removal ──────────────────────────────────────────────
//
// Removes (local $name type) declarations and (local.set $name EXPR) dead stores
// for locals that are never read (no local.get or local.tee referencing them).
//
// Typical targets:
//   · $tmp  — declaration left by tee-swap after its set/get were eliminated.
//   · $_dummy — assigned (i32.const 0) by codegen for void if-branches but never read.
//
// For impure dead stores the set is replaced with (drop EXPR) to preserve effects.

function removeDeadLocals(body: string): string {
  const DECL_PREFIX = "(local $";  // Leads declarations; never matches local.get/set/tee (those use '.')

  // ── Collect dead local names ──────────────────────────────────────────────
  const dead = new Array<string>();
  let pos = 0;
  while (true) {
    const declStart = body.indexOf(DECL_PREFIX, pos);
    if (declStart == -1) break;
    pos = declStart + DECL_PREFIX.length;

    let nameEnd = pos;
    while (nameEnd < body.length) {
      const c = body.charCodeAt(nameEnd);
      if (c == 32 || c == 41) break;
      nameEnd++;
    }
    const name = body.slice(pos, nameEnd);
    if (name.length == 0) continue;

    const reads = countSubstr(body, "(local.get $" + name + ")")
                + countSubstr(body, "(local.tee $" + name + " ");
    if (reads == 0 && !dead.includes(name)) dead.push(name);
    pos = nameEnd;
  }

  if (dead.length == 0) return body;

  let out = body;
  for (let d = 0; d < dead.length; d++) {
    const name = dead[d];

    // ── 1. Remove the declaration line: (local $name type) ───────────────
    {
      const declToken = DECL_PREFIX + name + " ";
      let p = 0;
      let newOut = "";
      while (true) {
        const found = out.indexOf(declToken, p);
        if (found == -1) { newOut += out.slice(p); break; }
        const declEnd = matchingParen(out, found);
        if (declEnd == -1) { newOut += out.slice(p, found + 1); p = found + 1; continue; }

        // Strip the indentation whitespace before the '(' on the same line.
        let lineStart = found;
        while (lineStart > 0 && (out.charCodeAt(lineStart - 1) == 32 || out.charCodeAt(lineStart - 1) == 9)) lineStart--;

        // Skip the trailing newline after ')'.
        let lineEnd = declEnd + 1;
        if (lineEnd < out.length && out.charCodeAt(lineEnd) == 13) lineEnd++;  // CR
        if (lineEnd < out.length && out.charCodeAt(lineEnd) == 10) lineEnd++;  // LF

        newOut += out.slice(p, lineStart);
        p = lineEnd;
      }
      out = newOut;
    }

    // ── 2. Remove / replace dead stores: (local.set $name EXPR) ─────────
    //   Pure EXPR  → remove entirely (no side effects).
    //   Impure EXPR → replace with (drop EXPR) to keep side effects.
    {
      const setToken = "(local.set $" + name + " ";
      let p = 0;
      let newOut = "";
      while (true) {
        const found = out.indexOf(setToken, p);
        if (found == -1) { newOut += out.slice(p); break; }
        const setEnd = matchingParen(out, found);
        if (setEnd == -1) { newOut += out.slice(p, found + 1); p = found + 1; continue; }

        const exprContent = out.slice(found + setToken.length, setEnd);
        newOut += out.slice(p, found);
        if (!isPureWat(exprContent)) {
          newOut += "(drop " + exprContent + ")";
        }
        // Pure → emit nothing (remove entirely).
        p = setEnd + 1;
      }
      out = newOut;
    }

    // ── 3. Replace no-arg dead stores: (local.set $name) → (drop) ────────
    //   The no-arg form pops the value stack.  Since the local is dead the
    //   value still needs to be consumed, so we replace with a bare drop.
    {
      const noArgToken = "(local.set $" + name + ")";
      let p = 0;
      let newOut = "";
      while (true) {
        const found = out.indexOf(noArgToken, p);
        if (found == -1) { newOut += out.slice(p); break; }
        newOut += out.slice(p, found) + "(drop)";
        p = found + noArgToken.length;
      }
      out = newOut;
    }
  }

  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isWS(c: i32): bool {
  return c == 32 || c == 9 || c == 10 || c == 13;
}

// Extract a WAT local name (ends at space or ')') starting at `start`.
function extractName(s: string, start: i32): string {
  let end = start;
  while (end < s.length) {
    const c = s.charCodeAt(end);
    if (c == 32 || c == 41) break;
    end++;
  }
  return s.slice(start, end);
}

// Find the index of the closing ')' matching the '(' at `start`.  Returns -1 on failure.
function matchingParen(s: string, start: i32): i32 {
  if (s.charCodeAt(start) != 40) return -1;
  let depth: i32 = 0;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 40) depth++;
    else if (c == 41) { depth--; if (depth == 0) return i; }
  }
  return -1;
}

// Returns true when the WAT snippet has no observable side effects.
function isPureWat(wat: string): bool {
  return !wat.includes("call ")
      && !wat.includes(".load")
      && !wat.includes(".store")
      && !wat.includes("global.");
}

// Collect unique variable names appearing as (local.get $name) in wat.
function localGetNames(wat: string): Array<string> {
  const names = new Array<string>();
  const prefix = "(local.get $";
  let idx: i32 = 0;
  while (true) {
    const found = wat.indexOf(prefix, idx);
    if (found == -1) break;
    const start = found + prefix.length;
    let end = start;
    while (end < wat.length && wat.charCodeAt(end) != 41 && wat.charCodeAt(end) != 32) end++;
    const name = wat.slice(start, end);
    if (!names.includes(name)) names.push(name);
    idx = found + prefix.length;
  }
  return names;
}

// Count non-overlapping occurrences of needle in haystack.
function countSubstr(haystack: string, needle: string): i32 {
  let count: i32 = 0;
  let idx: i32 = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found == -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}
