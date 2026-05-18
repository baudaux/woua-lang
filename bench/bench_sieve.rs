use std::time::Instant;

const N: usize = 1_000_000;

fn main() {
    let start = Instant::now();
    let mut sieve = vec![true; N];
    sieve[0] = false;
    sieve[1] = false;
    let mut p = 2usize;
    while p * p < N {
        if sieve[p] {
            let mut j = p * p;
            while j < N {
                sieve[j] = false;
                j += p;
            }
        }
        p += 1;
    }
    let count = sieve.iter().filter(|&&x| x).count();
    let elapsed = start.elapsed().as_millis();
    println!("primes below {}: {}, time = {} ms", N, count, elapsed);
}
