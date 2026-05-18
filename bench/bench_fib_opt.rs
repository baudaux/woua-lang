use std::time::Instant;

// Same single-recursion loop optimisation written by hand —
// mirrors what LLVM generates from the naive recursive form.
fn fib_opt(n: i32) -> i32 {
    if n < 2 { return n; }
    let mut acc = 0i32;
    let mut k = n;
    acc += fib_opt(k - 1);
    k -= 2;
    while k > 1 {
        acc += fib_opt(k - 1);
        k -= 2;
    }
    k + acc
}

fn main() {
    let start = Instant::now();
    let result = fib_opt(43);
    let elapsed = start.elapsed().as_millis();
    println!("fib_opt(43) = {}, time = {} ms", result, elapsed);
}
