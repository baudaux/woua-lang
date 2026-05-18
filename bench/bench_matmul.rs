use std::time::Instant;

const M: usize = 256;

fn main() {
    let mut a = vec![0f64; M * M];
    let mut b = vec![0f64; M * M];
    let mut c = vec![0f64; M * M];
    for i in 0..M {
        for j in 0..M {
            a[i * M + j] = (i + j) as f64;
            b[i * M + j] = (i * j) as f64;
        }
    }
    let start = Instant::now();
    for i in 0..M {
        for j in 0..M {
            let mut s = 0f64;
            for k in 0..M {
                s += a[i * M + k] * b[k * M + j];
            }
            c[i * M + j] = s;
        }
    }
    let elapsed = start.elapsed().as_millis();
    println!("matmul {}x{} in {} ms, c[1][1]={}", M, M, elapsed, c[1 * M + 1] as i64);
}
