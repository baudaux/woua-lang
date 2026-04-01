;; Generated WAT/WASI output from hello_world.woua
;; Compiled by the woua compiler
;;
;; Memory layout:
;;   offset  0..13  "Hello, World!\n"  (defstatic greeting, ptr=0 len=14)
;;   offset 16..    $alloc heap (4-byte-aligned, grows upward at runtime)
;;                  first alloc from (write): 12 bytes for iovec{base,len} + nwritten

(module
  ;; Import WASI fd_write:
  ;;   fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) -> errno
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))

  ;; 1 page = 64KB of linear memory
  (memory 1)
  (export "memory" (memory 0))

  ;; defstatic greeting "Hello, World!\n"  →  ptr=0, len=14
  (data (i32.const 0) "Hello, World!\n")

  ;; Bump allocator: heap pointer starts after static data (aligned to 4)
  (global $heap_ptr (mut i32) (i32.const 16))

  (func $alloc (param $size i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $heap_ptr))
    (global.set $heap_ptr (i32.add (local.get $ptr) (local.get $size)))
    (local.get $ptr)
  )

  ;; (defn main ()) → (print greeting) → (write 1 0 14)
  ;; write macro expands to: alloc (sizeof Iovec)+4 bytes, store fields, call fd_write
  ;; (sizeof Iovec)=8 is resolved at compile time; (+ 8 4) emitted as i32.add
  (func $main
    (local $__write_iov i32)
    (local.set $__write_iov (call $alloc (i32.add (i32.const 8) (i32.const 4))))
    (i32.store (local.get $__write_iov) (i32.const 0))
    (i32.store (i32.add (local.get $__write_iov) (i32.const 4)) (i32.const 14))
    (drop (call $fd_write
      (i32.const 1)
      (local.get $__write_iov)
      (i32.const 1)
      (i32.add (local.get $__write_iov) (i32.const 8))))
  )

  (export "_start" (func $main))
)
