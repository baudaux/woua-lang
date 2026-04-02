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

    // Try to parse "file:line:col: error: message" (future format)
    const located = line.match(/^.*?:(\d+):(\d+):\s*error:\s*(.+)$/);
    if (located) {
      const ln = Math.max(0, parseInt(located[1]) - 1);
      const col = Math.max(0, parseInt(located[2]) - 1);
      const msg = located[3].trim();
      const range = new vscode.Range(ln, col, ln, col + 1);
      diags.push(new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Error));
      continue;
    }

    // Generic "wouac: <message>" — squiggle the first non-empty line
    const generic = line.match(/^wouac:\s*(.+)$/);
    if (generic) {
      const msg = generic[1].trim();
      const range = new vscode.Range(0, 0, 0, document.lineAt(0).text.length);
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
}

export function deactivate(): void {
  diagnosticCollection.clear();
  diagnosticCollection.dispose();
}
