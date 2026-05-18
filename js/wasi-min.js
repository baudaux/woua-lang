/**
 * wasi-min.js — Minimal WASI snapshot_preview1 shim for browsers / Web Workers.
 *
 * Stubs all 42 wasi_snapshot_preview1 functions imported by woua programs.
 * Properly implements: fd_write, clock_time_get, proc_exit, random_get.
 * Everything else returns ENOTSUP (58) or EBADF (8) where appropriate.
 *
 * Usage:
 *   import { makeWasi } from '../js/wasi-min.js';
 *
 *   const wasi = makeWasi({
 *     onFdWrite(fd, text) {
 *       if (fd === 4) { ... handle SVG fd ... return true; }
 *       return false; // fall back to default (console.log for 1/2)
 *     }
 *   });
 *
 *   // Instantiate your WASM module using wasi.wasiImport:
 *   const { instance } = await WebAssembly.instantiateStreaming(resp, {
 *     wasi_snapshot_preview1: wasi.wasiImport,
 *   });
 *   wasi.setMemory(instance.exports.memory);
 *   instance.exports._start();  // may throw { type: 'wasi_exit', code: N }
 */

const ESUCCESS = 0;
const EBADF    = 8;
const ENOTSUP  = 58;

/**
 * @param {{ onFdWrite?: (fd: number, text: string) => boolean }} [opts]
 * @returns {{ wasiImport: object, setMemory: (mem: WebAssembly.Memory) => void }}
 */
export function makeWasi({ onFdWrite } = {}) {
  let memory;

  function v()  { return new DataView(memory.buffer); }

  const wasiImport = {

    // ── Process ─────────────────────────────────────────────────────────────
    proc_exit(code) {
      throw { type: 'wasi_exit', code };
    },

    // ── Arguments / environment ──────────────────────────────────────────────
    args_sizes_get(argc, buf_sz) {
      v().setUint32(argc,   0, true);
      v().setUint32(buf_sz, 0, true);
      return ESUCCESS;
    },
    args_get: () => ESUCCESS,

    environ_sizes_get(cnt, buf_sz) {
      v().setUint32(cnt,    0, true);
      v().setUint32(buf_sz, 0, true);
      return ESUCCESS;
    },
    environ_get: () => ESUCCESS,

    // ── Clocks ──────────────────────────────────────────────────────────────
    // clock_time_get(clockid: i32, precision: i64, out: i32*) → errno
    clock_time_get(_clockid, _precision, out) {
      // Return monotonic nanoseconds as a u64 (little-endian i64).
      const ns = BigInt(Math.round(performance.now() * 1_000_000));
      v().setBigUint64(out, ns, /* little-endian */ true);
      return ESUCCESS;
    },

    clock_res_get(_clockid, out) {
      v().setBigUint64(out, 1_000_000n, true); // 1 ms resolution
      return ESUCCESS;
    },

    // ── fd_write ─────────────────────────────────────────────────────────────
    fd_write(fd, iovs, iovsLen, nwritten) {
      const dv = v();
      let total = 0;
      const parts = [];
      for (let i = 0; i < iovsLen; i++) {
        const base = dv.getUint32(iovs + i * 8,     true);
        const len  = dv.getUint32(iovs + i * 8 + 4, true);
        parts.push(new TextDecoder().decode(new Uint8Array(memory.buffer, base, len)));
        total += len;
      }
      const text = parts.join('');

      let handled = onFdWrite ? onFdWrite(fd, text) : false;
      if (!handled) {
        if      (fd === 1) { console.log(text.replace(/\n$/, ''));   handled = true; }
        else if (fd === 2) { console.error(text.replace(/\n$/, '')); handled = true; }
      }
      if (!handled) return EBADF;

      dv.setUint32(nwritten, total, true);
      return ESUCCESS;
    },

    // ── Unimplemented fd operations ──────────────────────────────────────────
    fd_read:               () => ENOTSUP,
    fd_close:              () => ESUCCESS,
    fd_seek:               () => ENOTSUP,
    fd_tell:               () => ENOTSUP,
    fd_sync:               () => ESUCCESS,
    fd_datasync:           () => ESUCCESS,
    fd_prestat_get:        () => EBADF,    // no preopens → terminates scan loop
    fd_prestat_dir_name:   () => EBADF,
    fd_advise:             () => ESUCCESS,
    fd_allocate:           () => ENOTSUP,
    fd_fdstat_get:         () => ENOTSUP,
    fd_fdstat_set_flags:   () => ESUCCESS,
    fd_filestat_get:       () => ENOTSUP,
    fd_filestat_set_size:  () => ENOTSUP,
    fd_filestat_set_times: () => ENOTSUP,
    fd_pread:              () => ENOTSUP,
    fd_pwrite:             () => ENOTSUP,
    fd_readdir:            () => ENOTSUP,

    // ── Path operations ──────────────────────────────────────────────────────
    path_create_directory:   () => ENOTSUP,
    path_filestat_get:       () => ENOTSUP,
    path_filestat_set_times: () => ENOTSUP,
    path_link:               () => ENOTSUP,
    path_open:               () => ENOTSUP,
    path_readlink:           () => ENOTSUP,
    path_remove_directory:   () => ENOTSUP,
    path_rename:             () => ENOTSUP,
    path_symlink:            () => ENOTSUP,
    path_unlink_file:        () => ENOTSUP,

    // ── Sockets ──────────────────────────────────────────────────────────────
    sock_accept:   () => ENOTSUP,
    sock_recv:     () => ENOTSUP,
    sock_send:     () => ENOTSUP,
    sock_shutdown: () => ENOTSUP,

    // ── Poll ─────────────────────────────────────────────────────────────────
    poll_oneoff: () => ENOTSUP,

    // ── Misc ─────────────────────────────────────────────────────────────────
    random_get(buf, len) {
      crypto.getRandomValues(new Uint8Array(memory.buffer, buf, len));
      return ESUCCESS;
    },

  };

  return {
    wasiImport,
    setMemory(mem) { memory = mem; },
  };
}
