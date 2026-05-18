use std::hint::black_box;
use std::time::Instant;

fn main() {
    let start = Instant::now();
    let n = black_box(100_000_000i64);
    let mut sum: i64 = 0;
    for i in 0i64..n {
        sum ^= i.wrapping_mul(i);
    }
    let elapsed = start.elapsed().as_millis();
    println!("sum = {}, time = {} ms", black_box(sum), elapsed);
}
