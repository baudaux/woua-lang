// Entry point for the woua compiler (WASI).
// Reads woua source from a file argument or stdin, writes WAT to stdout, errors to stderr.
//
// Usage:
//   wasmtime wouac.wasm source.woua
//   wasmtime wouac.wasm < source.woua
//   wasmtime wouac.wasm < source.woua > output.wat

import { Console, Process, CommandLine, FileSystem } from "as-wasi/assembly";
import { Node, ListNode, SymbolNode, RegexNode,
         TAG_LIST, TAG_SYMBOL, TAG_REGEX } from "./ast";
import { Reader } from "./reader";
import { Env, LiteralInfo } from "./env";
import { expandAll } from "./expander";
import { generateModule } from "./codegen";

// ── Helpers ──────────────────────────────────────────────────────────────────

function dirName(path: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path.charAt(i) == "/") return path.slice(0, i + 1);
  }
  return "";
}

// Ensure the path ends with .woua
function withExtension(name: string): string {
  return name.endsWith(".woua") ? name : name + ".woua";
}

// Try to open a file, searching baseDir first then libDir.
// Returns the resolved absolute path, or "" if not found.
function resolveIncludePath(name: string, baseDir: string, libDir: string): string {
  const withExt = withExtension(name);
  const fromBase = baseDir + withExt;
  const fd1 = FileSystem.open(fromBase, "r");
  if (fd1 != null) return fromBase;
  if (libDir != "") {
    const fromLib = libDir + withExt;
    const fd2 = FileSystem.open(fromLib, "r");
    if (fd2 != null) return fromLib;
  }
  return "";
}

// If `form` is a (defliteral name /pattern/ :type [:static]) form, register it in
// env.literals immediately so the reader can use the pattern for subsequent reads.
function tryRegisterDefliteral(form: Node, env: Env): void {
  if (form.tag != TAG_LIST) return;
  const list = form as ListNode;
  if (list.children.length < 4) return;
  if (list.children[0].tag != TAG_SYMBOL) return;
  if ((list.children[0] as SymbolNode).name != "defliteral") return;
  if (list.children[2].tag != TAG_REGEX) return;
  const litName  = (list.children[1] as SymbolNode).name;
  const pattern  = (list.children[2] as RegexNode).pattern;
  const nodeType = (list.children[3] as SymbolNode).name;
  const isStatic = list.children.length > 4 &&
                   (list.children[4] as SymbolNode).name == ":static";
  env.literals.set(litName, new LiteralInfo(litName, pattern, nodeType, isStatic));
}

// ── Streaming include resolution ─────────────────────────────────────────────
//
// Reads `src` one form at a time using a Reader that shares `env`.
// When an (include path) form is encountered, the file is read and resolved
// recursively before continuing -- this ensures that any (defliteral ...)
// declarations in an included file are registered in env.literals before the
// reader processes subsequent forms in the parent file.
//
// Include paths are bare symbols:  (include std_io.woua)
//
function readAndResolve(
  src:      string,
  baseDir:  string,
  libDir:   string,
  included: Set<string>,
  env:      Env,
): Array<Node> {
  const result = new Array<Node>();
  const reader = new Reader(src, env);

  while (reader.hasMore()) {
    const form = reader.readNextForm();

    // (include name) -- name is a bare symbol, e.g. std_io or std_io.woua
    if (form.tag == TAG_LIST) {
      const list = form as ListNode;
      if (list.children.length == 2 &&
          list.children[0].tag == TAG_SYMBOL &&
          (list.children[0] as SymbolNode).name == "include" &&
          list.children[1].tag == TAG_SYMBOL) {
        const name    = (list.children[1] as SymbolNode).name;
        const absPath = resolveIncludePath(name, baseDir, libDir);
        if (absPath == "") {
          env.errors.push("include: cannot find '" + name + "' in '" + baseDir + "' or '" + libDir + "'");
        } else if (!included.has(absPath)) {
          included.add(absPath);
          const fd = FileSystem.open(absPath, "r");
          if (fd == null) {
            env.errors.push("include: cannot open file: " + absPath);
          } else {
            const incSrc = fd!.readString();
            if (incSrc == null) {
              env.errors.push("include: failed to read file: " + absPath);
            } else {
              const subForms = readAndResolve(
                incSrc as string, dirName(absPath), libDir, included, env);
              for (let j = 0; j < subForms.length; j++) result.push(subForms[j]);
            }
          }
        }
        continue;
      }
    }

    // (defliteral ...) -- register pattern eagerly so the reader uses it
    // for all subsequent readNextForm() calls in this and parent files.
    tryRegisterDefliteral(form, env);

    result.push(form);
  }

  return result;
}

export function _start(): void {
  const args = CommandLine.all;

  // -- Parse flags first ------------------------------------------------------
  let libDir    = "lib/";
  let inputArg  = "";
  let outputArg = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] == "--help" || args[i] == "-h") {
      Console.write(
        "Usage: wouac [options] [source.woua]\n" +
        "\n" +
        "  Compile a woua source file to WebAssembly Text Format (WAT).\n" +
        "  If no file is given, source is read from stdin.\n" +
        "\n" +
        "Options:\n" +
        "  source.woua         Input source file\n" +
        "  -o, --output <file> Output file (default: stdout)\n" +
        "  --lib <dir>         Library directory (default: lib/)\n" +
        "  --help, -h          Show this help message\n" +
        "  --version, -v       Show compiler version\n" +
        "\n" +
        "Examples:\n" +
        "  wouac demos/hello_world.woua\n" +
        "  wouac demos/hello_world.woua -o hello.wat\n" +
        "  wouac --lib /usr/share/woua/lib demos/hello_world.woua\n" +
        "  wouac demos/hello_world.woua | wat2wasm - -o hello.wasm\n",
        false
      );
      Process.exit(0);
      return;
    }
    if (args[i] == "--version" || args[i] == "-v") {
      Console.write("wouac 0.1.0\n", false);
      Process.exit(0);
      return;
    }
    if (args[i] == "--lib" && i + 1 < args.length) {
      libDir = args[i + 1];
      if (!libDir.endsWith("/")) libDir += "/";
      i++;
    } else if ((args[i] == "-o" || args[i] == "--output") && i + 1 < args.length) {
      outputArg = args[i + 1];
      i++;
    } else if (inputArg == "") {
      inputArg = args[i];
    }
  }

  // -- Read source from file argument or stdin --------------------------------
  let source: string | null = null;

  if (inputArg != "") {
    const fd = FileSystem.open(inputArg, "r");
    if (fd == null) {
      Console.error("wouac: cannot open file: " + inputArg);
      Process.exit(1);
      return;
    }
    source = fd!.readString();
    if (source == null) {
      Console.error("wouac: failed to read file: " + inputArg);
      Process.exit(1);
      return;
    }
  } else {
    source = Console.readAll();
  }

  if (source == null || (source as string).length == 0) {
    Console.error("wouac: no input (provide a .woua file as argument or pipe to stdin)");
    Process.exit(1);
    return;
  }

  // -- Pipeline: readAndResolve -> expand -> codegen --------------------------
  const env = new Env();

  const inputDir = inputArg != "" ? dirName(inputArg) : "";
  const included = new Set<string>();
  if (inputArg != "") included.add(inputArg);

  const forms = readAndResolve(source as string, inputDir, libDir, included, env);

  const expanded = expandAll(forms, env);

  // Report any compile-time errors
  if (env.errors.length > 0) {
    for (let i = 0; i < env.errors.length; i++) {
      Console.error("wouac: " + env.errors[i]);
    }
    Process.exit(1);
    return;
  }

  const wat = generateModule(expanded, env);

  // -- Write WAT to stdout or file --------------------------------------------
  if (outputArg != "") {
    const outFd = FileSystem.open(outputArg, "w");
    if (outFd == null) {
      Console.error("wouac: cannot open output file: " + outputArg);
      Process.exit(1);
      return;
    }
    outFd!.writeString(wat);
  } else {
    Console.log(wat);
  }
  Process.exit(0);
}
