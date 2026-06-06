import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";

const diagnosticCollection = vscode.languages.createDiagnosticCollection("woua");

// Resolve the path to wouac.wasm:
//   1. User setting woua.compilerPath
//   2. <workspaceRoot>/wouac/dist/wouac.wasm
function resolveCompilerPath(workspaceRoot: string): string | null {
  const cfg = vscode.workspace.getConfiguration("woua");
  const setting = cfg.get<string>("compilerPath");
  if (setting && setting.trim() !== "") {
    return setting.trim();
  }
  const candidate = path.join(workspaceRoot, "wouac", "dist", "wouac.wasm");
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function resolveLibDir(workspaceRoot: string): string {
  const candidate = path.join(workspaceRoot, "lib");
  if (fs.existsSync(candidate)) return candidate;
  return "";
}

// Parse a single woua compiler error line.
// Compiler errors written to stderr:  "wouac: <message>"
// wat2wasm-style errors (if we ever add them):  "file.wat:<line>:<col>: error: <msg>"
// For now we only surface wouac errors without line info (whole-file squiggle on line 0).
function parseErrors(stderr: string, document: vscode.TextDocument): vscode.Diagnostic[] {
  const diags: vscode.Diagnostic[] = [];
  const lines = stderr.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;

    // wouac format: "wouac: <file>:<line>:<col>: <message>"
    const located = line.match(/^wouac:\s*.+?:(\d+):(\d+):\s*(.+)$/);
    if (located) {
      const ln  = Math.max(0, parseInt(located[1]) - 1);
      const col = Math.max(0, parseInt(located[2]) - 1);
      const msg = located[3].trim();
      const range = new vscode.Range(ln, col, ln, col + 1);
      diags.push(new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error));
      continue;
    }

    // Fallback: generic "wouac: <message>" with no location — squiggle the
    // first non-comment, non-empty line so the squiggle doesn't land on a
    // leading comment block.
    const generic = line.match(/^wouac:\s*(.+)$/);
    if (generic) {
      const msg = generic[1].trim();
      let fallbackLine = 0;
      for (let i = 0; i < document.lineCount; i++) {
        const t = document.lineAt(i).text.trim();
        if (t.length > 0 && !t.startsWith(";;")) { fallbackLine = i; break; }
      }
      const range = new vscode.Range(fallbackLine, 0, fallbackLine, document.lineAt(fallbackLine).text.length);
      diags.push(new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error));
    }
  }
  return diags;
}

function compileDocument(document: vscode.TextDocument): void {
  if (document.languageId !== "woua") return;

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return;
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const compilerPath = resolveCompilerPath(workspaceRoot);
  if (!compilerPath) {
    // Compiler not found — clear diagnostics silently
    diagnosticCollection.delete(document.uri);
    return;
  }

  const cfg = vscode.workspace.getConfiguration("woua");
  const wasmtime = cfg.get<string>("wasmtimePath") || "wasmtime";
  const libDir = resolveLibDir(workspaceRoot);

  const args = [
    "--dir", workspaceRoot,
    compilerPath,
    document.uri.fsPath,
  ];
  if (libDir) {
    args.push("--lib", libDir);
  }

  // Output to /dev/null (we only care about stderr for errors)
  const proc = cp.spawn(wasmtime, args, {
    cwd: workspaceRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  proc.on("close", (code) => {
    if (code === 0) {
      diagnosticCollection.delete(document.uri);
    } else {
      const diags = parseErrors(stderr, document);
      diagnosticCollection.set(document.uri, diags);
    }
  });

  proc.on("error", () => {
    // wasmtime not found or other spawn error — fail silently
    diagnosticCollection.delete(document.uri);
  });
}

// ── Semantic tokens ───────────────────────────────────────────────────────────
// Token types match the VS Code standard set so all themes colour them out of
// the box without any extra theme configuration.
const TOKEN_TYPES    = ['function', 'macro', 'type', 'variable', 'operator'];
const TOKEN_MODIFIERS = ['declaration', 'readonly'];
const semanticLegend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);
type TokenType = 'function' | 'macro' | 'type' | 'variable' | 'operator';

interface DefEntry { type: TokenType; readonly: boolean; }

/** Returns sorted [start, end) ranges covering strings and ;; comments. */
function findExcludedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      ranges.push([start, i + 1]);
      i++;
    } else if (ch === ';') {
      const start = i;
      while (i < text.length && text[i] !== '\n') i++;
      ranges.push([start, i]);
    } else {
      i++;
    }
  }
  return ranges;
}

function inExcluded(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (s > pos) break;
    if (pos < e) return true;
  }
  return false;
}

/** All (defX name …) patterns and the semantic type they map to. */
const DEF_PATTERNS: Array<{ re: RegExp; type: TokenType; ro?: boolean }> = [
  { re: /\(defn\s+([a-zA-Z0-9_\/!?<>=+\-*][a-zA-Z0-9_\/!?<>=+\-*.]*)/g,     type: 'function' },
  { re: /\(defmacro\s+([a-zA-Z0-9_\/!?<>=+\-*][a-zA-Z0-9_\/!?<>=+\-*.]*)/g, type: 'macro'    },
  { re: /\(defimport\s+([a-zA-Z0-9_\/!?<>=+\-*][a-zA-Z0-9_\/!?<>=+\-*.]*)/g,type: 'function' },
  { re: /\(deftype\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,                             type: 'type'     },
  { re: /\(defop\s+([^\s"()\[\]{}]+)/g,                                       type: 'operator' },
  { re: /\(defliteral\s+([a-zA-Z_][a-zA-Z0-9_\-]*)/g,                        type: 'function' },
  { re: /\(defconst\s+([a-zA-Z0-9_][a-zA-Z0-9_]*)/g,  type: 'variable', ro: true  },
  { re: /\(defvar\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,        type: 'variable'           },
  { re: /\(defstatic\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,     type: 'variable', ro: true },
];

/** Slice the balanced parenthesised form starting at openParen '('. */
function sliceForm(text: string, openParen: number): string {
  let depth = 0, i = openParen;
  while (i < text.length) {
    const c = text[i];
    if      (c === '(') { depth++; }
    else if (c === ')') { if (--depth === 0) return text.slice(openParen, i + 1); }
    else if (c === '"') { i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; } }
    else if (c === ';') { while (i < text.length && text[i] !== '\n') i++; }
    i++;
  }
  return text.slice(openParen);
}

function extractDefs(text: string): Map<string, DefEntry> {
  const defs = new Map<string, DefEntry>();
  const excluded = findExcludedRanges(text);
  for (const { re, type, ro } of DEF_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const nameIndex = m.index + m[0].length - m[1].length;
      if (!inExcluded(nameIndex, excluded)) {
        defs.set(m[1], { type, readonly: !!ro });
      }
    }
  }

  // Synthesise accessor/setter names from deftype field lists.
  // (deftype TypeName (field1 :t1) (field2 :t2) …)
  //   → TypeName/field1  TypeName/field1!  TypeName/field2  …
  const deftypeRe = /\(deftype\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const fieldRe   = /\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s+:/g;
  deftypeRe.lastIndex = 0;
  let dm: RegExpExecArray | null;
  while ((dm = deftypeRe.exec(text)) !== null) {
    if (inExcluded(dm.index, excluded)) continue;
    const typeName = dm[1];
    // Slice the balanced form so we don't bleed into later forms
    const body = sliceForm(text, dm.index);
    fieldRe.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body)) !== null) {
      const field = fm[1];
      if (field === typeName) continue; // skip the type name itself
      defs.set(`${typeName}/${field}`,  { type: 'function', readonly: false });
      defs.set(`${typeName}/${field}!`, { type: 'function', readonly: false });
    }
  }

  return defs;
}

/** Walk (include name) directives and collect definitions from lib files. */
function collectLibDefs(
  text: string,
  libDir: string,
  visited: Set<string>
): Map<string, DefEntry> {
  const all = new Map<string, DefEntry>();
  if (!libDir) return all;

  const excluded = findExcludedRanges(text);
  const includeRe = /\(include\s+([a-zA-Z_][a-zA-Z0-9_]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = includeRe.exec(text)) !== null) {
    if (inExcluded(m.index, excluded)) continue;
    const libPath = path.join(libDir, m[1] + '.woua');
    if (visited.has(libPath)) continue;
    visited.add(libPath);
    if (!fs.existsSync(libPath)) continue;
    const libText = fs.readFileSync(libPath, 'utf8');
    // Transitive includes first, then this file's own defs override them
    collectLibDefs(libText, libDir, visited).forEach((v, k) => all.set(k, v));
    extractDefs(libText).forEach((v, k) => all.set(k, v));
  }
  return all;
}

// Matches any woua symbol/identifier (including numeric-prefixed names like 2_PI)
const SYMBOL_RE = /[a-zA-Z0-9_!?<>=+\-*\/][a-zA-Z0-9_\/!?<>=+\-*.~]*/g;
// Detect declaration site: text immediately before the name ends with (defX ...
const DEF_PREFIX_RE = /\(def\w*\s+$/;

class WouaSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  constructor(private readonly workspaceRoot: string) {}

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const text    = document.getText();
    const libDir  = resolveLibDir(this.workspaceRoot);
    const visited = new Set<string>([document.uri.fsPath]);

    // Lib defs first (lower priority), then file defs override them
    const allDefs = collectLibDefs(text, libDir, visited);
    extractDefs(text).forEach((v, k) => allDefs.set(k, v));

    const excluded = findExcludedRanges(text);
    const builder  = new vscode.SemanticTokensBuilder(semanticLegend);

    SYMBOL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SYMBOL_RE.exec(text)) !== null) {
      const name = m[0];
      const def  = allDefs.get(name);
      if (!def) continue;
      if (inExcluded(m.index, excluded)) continue;

      const pos       = document.positionAt(m.index);
      const typeIndex = TOKEN_TYPES.indexOf(def.type);
      if (typeIndex < 0) continue;

      let modMask = 0;
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      if (DEF_PREFIX_RE.test(before)) modMask |= 1; // declaration
      if (def.readonly)               modMask |= 2; // readonly

      builder.push(pos.line, pos.character, name.length, typeIndex, modMask);
    }

    return builder.build();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Run on every save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => compileDocument(doc))
  );

  // Run on open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => compileDocument(doc))
  );

  // Run on visible editor change (handles files open at startup)
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) compileDocument(editor.document);
    })
  );

  // Run on currently open woua files at activation
  vscode.workspace.textDocuments.forEach((doc) => compileDocument(doc));

  context.subscriptions.push(diagnosticCollection);

  // Semantic token provider
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    context.subscriptions.push(
      vscode.languages.registerDocumentSemanticTokensProvider(
        { language: 'woua' },
        new WouaSemanticTokensProvider(workspaceFolders[0].uri.fsPath),
        semanticLegend
      )
    );
  }
}
