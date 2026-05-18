use std::time::Instant;

fn fib(n: i32) -> i32 {
    if n < 2 { n } else { fib(n - 1) + fib(n - 2) }
}

fn main() {
    let start = Instant::now();
    let result = fib(43);
    let elapsed = start.elapsed().as_millis();
    println!("fib(43) = {}, time = {} ms", result, elapsed);
}
