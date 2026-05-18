use std::time::Instant;
use std::hint::black_box;

const FIB_REPS: i32 = 1_000_000;

#[inline(never)]
fn fib_iter(n: i32) -> i32 {
    let (mut a, mut b) = (0i32, 1i32);
    for _ in 0..n {
        let tmp = a + b;
        a = b;
        b = tmp;
    }
    a
}

fn main() {
    let start = Instant::now();
    let mut result = 0i32;
    for _ in 0..FIB_REPS {
        // black_box prevents LLVM from eliminating the loop as dead code.
        result = black_box(fib_iter(black_box(43)));
    }
    let elapsed = start.elapsed().as_millis();
    println!("fib_iter(43) = {}, reps = {}, time = {} ms", result, FIB_REPS, elapsed);
    assert_eq!(result, 433494437, "fib_iter(43) correctness check failed");
}
