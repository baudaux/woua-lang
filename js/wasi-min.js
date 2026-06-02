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
 *     // Optional: virtual preopen directories (e.g. ['/dev']).
 *     // Each entry becomes an fd starting at 3.
 *     preopens: ['/dev'],
 *
 *     // Called when path_open is invoked for a preopened dir.
 *     // Return a positive fd number to accept, or -1 to reject (→ ENOTSUP).
 *     onPathOpen(dirfd, path) {
 *       if (path === 'svg') return 5;
 *       return -1;
 *     },
 *
 *     onFdWrite(fd, text) {
 *       return false; // fall back to default (console.log for 1/2)
 *     },
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
export function makeWasi({ onFdWrite, preopens = [], onPathOpen } = {}) {
  let memory;

  function v()  { return new DataView(memory.buffer); }

  // TextDecoder.decode() rejects SharedArrayBuffer-backed views in Firefox.
  // Explicitly allocate a plain ArrayBuffer-backed copy via set().
  function decodeStr(ptr, len) {
    const copy = new Uint8Array(len);
    copy.set(new Uint8Array(memory.buffer, ptr, len));
    return new TextDecoder().decode(copy);
  }

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
        parts.push(decodeStr(base, len));
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
    fd_prestat_get(fd, buf) {
      const idx = fd - 3;
      if (idx >= 0 && idx < preopens.length) {
        const dv = v();
        dv.setUint32(buf,     0,                    true); // pr_type = 0 (dir)
        dv.setUint32(buf + 4, preopens[idx].length, true); // pr_name_len
        return ESUCCESS;
      }
      return EBADF; // terminates preopen scan loop
    },
    fd_prestat_dir_name(fd, ptr, len) {
      const idx = fd - 3;
      if (idx >= 0 && idx < preopens.length) {
        const enc = new TextEncoder().encode(preopens[idx]);
        new Uint8Array(memory.buffer, ptr, len).set(enc.subarray(0, len));
        return ESUCCESS;
      }
      return EBADF;
    },
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
    path_open(dirfd, _dirflags, pathPtr, pathLen, _oflags, _rb, _ri, _fdflags, fdOut) {
      if (onPathOpen && memory) {
        const path  = decodeStr(pathPtr, pathLen);
        const newFd = onPathOpen(dirfd, path);
        if (newFd >= 0) {
          v().setUint32(fdOut, newFd, true);
          return ESUCCESS;
        }
      }
      return ENOTSUP;
    },
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
    // Minimal implementation: only handles a single clock subscription (sleep).
    // Layout of one subscription (48 bytes, little-endian):
    //   +0  userdata i64
    //   +8  tag      u8  (0 = clock)
    //   +9  padding  7 bytes
    //   +16 clock_id u32 (0=realtime, 1=monotonic)
    //   +20 padding  4 bytes
    //   +24 timeout  i64 (nanoseconds, relative when flags=0)
    //   +32 precision i64
    //   +40 flags    u16 (0=relative)
    // Layout of one event (32 bytes):
    //   +0  userdata i64
    //   +8  error    u16
    //   +10 type     u8
    //   +11 padding
    //   +16 fd_readwrite.nbytes i64 (unused for clock)
    poll_oneoff(inPtr, outPtr, nSubs, nEventsPtr) {
      const dv = v();
      let nWritten = 0;
      for (let i = 0; i < nSubs; i++) {
        const base = inPtr + i * 48;
        const tag  = dv.getUint8(base + 8);
        if (tag === 0) {
          // Clock subscription — sleep
          const timeoutNs = Number(dv.getBigUint64(base + 24, true));
          const ms = timeoutNs / 1_000_000;
          // In a Web Worker Atomics.wait() gives a true synchronous sleep.
          // On the main thread it is not allowed; fall back to spin-wait.
          try {
            const tmp = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(tmp, 0, 0, ms);
          } catch (_) {
            const deadline = performance.now() + ms;
            while (performance.now() < deadline) { /* spin */ }
          }
          // Write the clock event to the output buffer
          const oBase = outPtr + nWritten * 32;
          dv.setBigUint64(oBase,      dv.getBigUint64(base, true), true); // userdata
          dv.setUint16   (oBase + 8,  0,   true); // error = 0
          dv.setUint8    (oBase + 10, 0);          // type  = clock
          nWritten++;
        }
        // fd subscriptions not implemented; skip silently
      }
      dv.setUint32(nEventsPtr, nWritten, true);
      return ESUCCESS;
    },

    // ── Misc ─────────────────────────────────────────────────────────────────
    random_get(buf, len) {
      // crypto.getRandomValues also rejects SharedArrayBuffer-backed views.
      const tmp = new Uint8Array(len);
      crypto.getRandomValues(tmp);
      new Uint8Array(memory.buffer, buf, len).set(tmp);
      return ESUCCESS;
    },

  };

  return {
    wasiImport,
    setMemory(mem) { memory = mem; },
  };
}
