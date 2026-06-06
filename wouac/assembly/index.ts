// Entry point for the woua compiler (WASI).
// Reads woua source from a file argument or stdin, writes WAT to stdout, errors to stderr.
//
// Usage:
//   wasmtime wouac.wasm source.woua
//   wasmtime wouac.wasm < source.woua
//   wasmtime wouac.wasm < source.woua > output.wat

import { Console, Process, CommandLine } from "as-wasi/assembly";
import {
  fd_prestat_get, fd_prestat_dir_name, path_open, fd_close, fd_read, fd_write,
  errno, oflags, rights, fdflags, lookupflags, fd, prestat, prestat_dir,
} from "@assemblyscript/wasi-shim/assembly/bindings/wasi_snapshot_preview1";
import { Node, ListNode, SymbolNode, RegexNode,
         TAG_LIST, TAG_SYMBOL, TAG_REGEX } from "./ast";
import { Reader } from "./reader";
import { Env, StaticInfo, LiteralInfo } from "./env";
import { expandAll } from "./expander";
import { generateModule } from "./codegen";
import { watToWasm } from "./wasm_encoder";

// ── Preopened-directory file open ────────────────────────────────────────────
//
// as-wasi's FileSystem.open() hardcodes dirfd=3, which only works when exactly
// one --dir is passed to wasmtime. We replace it with openPath(), which scans
// all preopened fds (starting at 3), finds the best-matching prefix for the
// requested path, and calls path_open with the relative portion of the path.
//
// Returns a WASI fd on success, or -1 on failure.

function openPath(path: string, write: bool): i32 {
  const pathUTF8Buf = String.UTF8.encode(path);
  const pathPtr     = changetype<usize>(pathUTF8Buf);
  const pathLen     = pathUTF8Buf.byteLength as usize;

  // Buffer for fd_prestat (8 bytes: type:u32 + pr_name_len:u32)
  let prestatBuf = memory.data(8);
  // Buffer for preopened dir name (up to 4096 bytes)
  let nameBufSize: usize = 4096;
  // @ts-ignore
  let nameBuf = heap.alloc(nameBufSize);

  let bestFd:      i32 = -1;
  let bestPrefLen: i32 = -1;

  for (let tryFd: i32 = 3; ; tryFd++) {
    let ret = fd_prestat_get(tryFd as fd, changetype<prestat>(prestatBuf));
    if (ret !== errno.SUCCESS) break; // no more preopened fds

    let prNameLen = load<u32>(prestatBuf + 4) as usize;
    if (prNameLen > nameBufSize) {
      // @ts-ignore
      nameBuf = heap.realloc(nameBuf, prNameLen);
      nameBufSize = prNameLen;
    }
    fd_prestat_dir_name(tryFd as fd, nameBuf, prNameLen);

    // Decode the preopened dir name to compare against the requested path.
    // A preopened dir of "." matches everything (prefix length = 0).
    let preDir = String.UTF8.decodeUnsafe(nameBuf, prNameLen, true);
    let isMatch = false;
    let relativeStart = 0;

    if (preDir == "." || preDir == "") {
      // The dot-preopen matches all relative paths
      isMatch = true;
      relativeStart = 0;
    } else {
      // Strip trailing slash from preDir for comparison
      if (preDir.endsWith("/")) preDir = preDir.slice(0, preDir.length - 1);
      if (path.startsWith(preDir + "/")) {
        isMatch = true;
        relativeStart = preDir.length + 1; // skip "preDir/"
      } else if (path == preDir) {
        isMatch = true;
        relativeStart = preDir.length;
      }
    }

    if (isMatch && preDir.length > bestPrefLen) {
      bestFd       = tryFd;
      bestPrefLen  = preDir == "." || preDir == "" ? 0 : preDir.length;
    }
  }

  // @ts-ignore
  heap.free(nameBuf);

  if (bestFd < 0) return -1;

  // Build the relative path for path_open.
  // If bestPrefLen == 0 (dot-preopen), the path is already relative.
  // Otherwise strip the "preDir/" prefix.
  let relPath = bestPrefLen > 0 ? path.slice(bestPrefLen + 1) : path;
  // Remove any leading "./" that might remain
  if (relPath.startsWith("./")) relPath = relPath.slice(2);

  let relUTF8     = String.UTF8.encode(relPath);
  let relPtr      = changetype<usize>(relUTF8);
  let relLen      = relUTF8.byteLength as usize;

  let fdRights: u64 = write
    ? (rights.FD_WRITE | rights.FD_SEEK | rights.FD_TELL | rights.FD_FILESTAT_GET | rights.PATH_CREATE_FILE)
    : (rights.FD_READ  | rights.FD_SEEK | rights.FD_TELL | rights.FD_FILESTAT_GET);
  let oflagsVal: u16 = write ? (oflags.CREAT | oflags.TRUNC) : 0;

  let fdOut = memory.data(8);
  let res   = path_open(
    bestFd as fd,
    lookupflags.SYMLINK_FOLLOW,
    relPtr, relLen,
    oflagsVal,
    fdRights, fdRights,
    0 as fdflags,
    fdOut,
  );
  if (res !== errno.SUCCESS) return -1;
  return load<u32>(fdOut) as i32;
}

// Wrap openPath for reading: returns a string or null
function readPathString(path: string): string | null {
  let rawFd = openPath(path, false);
  if (rawFd < 0) return null;

  let result  = "";
  let chunkSz: usize = 4096;
  // @ts-ignore
  let buf    = heap.alloc(chunkSz);
  // @ts-ignore
  let iov    = heap.alloc(8);
  // @ts-ignore
  let nrBuf  = heap.alloc(4);

  while (true) {
    store<u32>(iov,     buf as u32);
    store<u32>(iov + 4, chunkSz as u32);
    // @ts-ignore
    let ret = fd_read(rawFd as fd, iov, 1, nrBuf);
    if (ret !== errno.SUCCESS) break;
    let n = load<u32>(nrBuf) as usize;
    if (n == 0) break;
    result += String.UTF8.decodeUnsafe(buf, n, false);
  }
  // @ts-ignore
  heap.free(buf);
  // @ts-ignore
  heap.free(iov);
  // @ts-ignore
  heap.free(nrBuf);
  fd_close(rawFd as fd);
  return result;
}

// Wrap openPath for writing binary data
function writePathBytes(path: string, data: Array<u8>): bool {
  let rawFd = openPath(path, true);
  if (rawFd < 0) return false;
  const len = data.length as usize;
  // @ts-ignore
  let buf = heap.alloc(len > 0 ? len : 1);
  for (let i = 0; i < data.length; i++) store<u8>(buf + i, data[i] as u8);
  // @ts-ignore
  let iov   = heap.alloc(8);
  // @ts-ignore
  let nwBuf = heap.alloc(4);
  store<u32>(iov,     buf as u32);
  store<u32>(iov + 4, len as u32);
  // @ts-ignore
  fd_write(rawFd as fd, iov, 1, nwBuf);
  // @ts-ignore
  heap.free(buf);
  // @ts-ignore
  heap.free(iov);
  // @ts-ignore
  heap.free(nwBuf);
  fd_close(rawFd as fd);
  return true;
}

// Wrap openPath for writing
function writePathString(path: string, content: string): bool {
  let rawFd = openPath(path, true);
  if (rawFd < 0) return false;

  let encoded = String.UTF8.encode(content);
  let ptr     = changetype<usize>(encoded);
  let len     = encoded.byteLength as usize;
  // @ts-ignore
  let iov   = heap.alloc(8);
  // @ts-ignore
  let nwBuf = heap.alloc(4);
  store<u32>(iov,     ptr as u32);
  store<u32>(iov + 4, len as u32);
  // @ts-ignore
  fd_write(rawFd as fd, iov, 1, nwBuf);
  // @ts-ignore
  heap.free(iov);
  // @ts-ignore
  heap.free(nwBuf);
  fd_close(rawFd as fd);
  return true;
}

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
  let probeFd = openPath(fromBase, false);
  if (probeFd >= 0) { fd_close(probeFd as fd); return fromBase; }
  if (libDir != "") {
    const fromLib = libDir + withExt;
    probeFd = openPath(fromLib, false);
    if (probeFd >= 0) { fd_close(probeFd as fd); return fromLib; }
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
  filename: string,
  baseDir:  string,
  libDir:   string,
  included: Set<string>,
  env:      Env,
): Array<Node> {
  const result = new Array<Node>();
  const reader = new Reader(src, env, filename != "" ? filename : "<stdin>");

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
          const incSrc = readPathString(absPath);
          if (incSrc == null) {
            env.errors.push("include: cannot open file: " + absPath);
          } else {
            const subForms = readAndResolve(
              incSrc as string, absPath, dirName(absPath), libDir, included, env);
            for (let j = 0; j < subForms.length; j++) result.push(subForms[j]);
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

// ── Static memory map generation ─────────────────────────────────────────────

function sizeOfStatic(info: StaticInfo): i32 {
  if (!info.isScalar()) return info.len; // :string or :bytes — len is the actual byte count
  if (info.typeName == ":i64" || info.typeName == ":f64") return 8;
  return 4; // :i32, :f32, :ptr
}

function hexAddr(ptr: i32): string {
  const digits = "0123456789abcdef";
  let s = "0x";
  for (let shift = 12; shift >= 0; shift -= 4) {
    s += digits.charAt((ptr >> shift) & 0xf);
  }
  return s;
}

// Build a map file: one line per named static, sorted by address.
// Skips internal interned-string entries (keys starting with "__str:").
function generateMap(env: Env): string {
  const keys = env.statics.keys();
  const sorted = new Array<string>();
  for (let i = 0; i < keys.length; i++) {
    if (!keys[i].startsWith("__str:")) sorted.push(keys[i]);
  }
  // Insertion sort by address
  for (let i = 1; i < sorted.length; i++) {
    const key = sorted[i];
    const ptr = env.statics.get(key).ptr;
    let j = i - 1;
    while (j >= 0 && env.statics.get(sorted[j]).ptr > ptr) {
      sorted[j + 1] = sorted[j];
      j--;
    }
    sorted[j + 1] = key;
  }
  let out = "";
  for (let i = 0; i < sorted.length; i++) {
    const key  = sorted[i];
    const info = env.statics.get(key);
    out += hexAddr(info.ptr) + "  " + sizeOfStatic(info).toString()
         + "  " + info.typeName + "  " + key + "\n";
  }
  return out;
}

export function _start(): void {
  const args = CommandLine.all;

  // -- Parse flags first ------------------------------------------------------
  let libDir    = "lib/";
  let inputArg  = "";
  let outputArg = "";
  let emitMap   = false;
  let emitWasm  = false;
  let noPeephole = false;
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
        "  -map                Write a <output>.map file with static memory layout\n" +
        "  -wasm               Also write a .wasm binary alongside the .wat (requires -o)\n" +
        "  Note: -o foo.wasm writes WASM directly (no separate .wat needed)\n" +
        "  --no-peephole       Disable WAT peephole optimizer\n" +
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
      if (outputArg.endsWith(".wasm")) emitWasm = true;
      i++;
    } else if (args[i] == "-map") {
      emitMap = true;
    } else if (args[i] == "-wasm" || args[i] == "--wasm") {
      emitWasm = true;
    } else if (args[i] == "--no-peephole") {
      noPeephole = true;
    } else if (inputArg == "") {
      inputArg = args[i];
    }
  }

  // -- Read source from file argument or stdin --------------------------------
  let source: string | null = null;

  if (inputArg != "") {
    source = readPathString(inputArg);
    if (source == null) {
      Console.error("wouac: cannot open file: " + inputArg + "\n");
      Process.exit(1);
      return;
    }
  } else {
    source = Console.readAll();
  }

  if (source == null || (source as string).length == 0) {
    Console.error("wouac: no input (provide a .woua file as argument or pipe to stdin)\n");
    Process.exit(1);
    return;
  }

  // -- Pipeline: readAndResolve -> expand -> codegen --------------------------
  const env = new Env();
  env.noPeephole = noPeephole;

  const inputDir = inputArg != "" ? dirName(inputArg) : "";
  const included = new Set<string>();
  if (inputArg != "") included.add(inputArg);

  const forms = readAndResolve(source as string, inputArg != "" ? inputArg : "<stdin>", inputDir, libDir, included, env);

  const expanded = expandAll(forms, env);

  // Report any compile-time errors
  if (env.errors.length > 0) {
    for (let i = 0; i < env.errors.length; i++) {
      Console.error("wouac: " + env.errors[i] + "\n");
    }
    Process.exit(1);
    return;
  }

  const wat = generateModule(expanded, env);

  // Report any errors produced during codegen (e.g. duplicate defn names)
  if (env.errors.length > 0) {
    for (let i = 0; i < env.errors.length; i++) {
      Console.error("wouac: " + env.errors[i] + "\n");
    }
    Process.exit(1);
    return;
  }

  // -- Write WAT (skip if output is a .wasm path — binary written below) ------
  if (outputArg != "" && !outputArg.endsWith(".wasm")) {
    if (!writePathString(outputArg, wat)) {
      Console.error("wouac: cannot open output file: " + outputArg + "\n");
      Process.exit(1);
      return;
    }
  } else if (outputArg == "") {
    Console.log(wat);
  }

  // -- Write .wasm binary (explicit -wasm flag or -o *.wasm) -------------------
  if (emitWasm) {
    if (outputArg == "") {
      Console.error("wouac: -wasm requires -o <output>; wasm file not written\n");
    } else {
      let wasmPath = outputArg;
      if (wasmPath.endsWith(".wat")) wasmPath = wasmPath.slice(0, wasmPath.length - 4) + ".wasm";
      else if (!wasmPath.endsWith(".wasm")) wasmPath = wasmPath + ".wasm";
      const wasmBytes = watToWasm(wat);
      if (wasmBytes.length == 0) {
        Console.error("wouac: wasm encoding failed (undefined reference)\n");
        Process.exit(1);
        return;
      }
      if (!writePathBytes(wasmPath, wasmBytes)) {
        Console.error("wouac: cannot write wasm file: " + wasmPath + "\n");
        Process.exit(1);
        return;
      }
    }
  }

  // -- Optionally write .map file --------------------------------------------
  if (emitMap) {
    if (outputArg == "") {
      Console.error("wouac: -map requires -o <output>; map file not written\n");
    } else {
      const mapPath = outputArg + ".map";
      if (!writePathString(mapPath, generateMap(env))) {
        Console.error("wouac: cannot write map file: " + mapPath + "\n");
        Process.exit(1);
        return;
      }
    }
  }

  Process.exit(0);
}
