use std::time::Instant;

const N: usize = 1024;
const REPS: u32 = 100_000;

// Explicit f32x4 SIMD dot product (wasm32 with +simd128 target feature).
// On other targets falls back to a plain iterator loop (LLVM auto-vectorizes).
#[inline(always)]
fn dot(a: &[f32], b: &[f32]) -> f32 {
    #[cfg(target_arch = "wasm32")]
    {
        use std::arch::wasm32::*;
        let mut acc = f32x4_splat(0.0f32);
        let mut i = 0usize;
        while i + 4 <= a.len() {
            let va = unsafe { v128_load(a.as_ptr().add(i) as *const v128) };
            let vb = unsafe { v128_load(b.as_ptr().add(i) as *const v128) };
            acc = f32x4_add(acc, f32x4_mul(va, vb));
            i += 4;
        }
        f32x4_extract_lane::<0>(acc)
            + f32x4_extract_lane::<1>(acc)
            + f32x4_extract_lane::<2>(acc)
            + f32x4_extract_lane::<3>(acc)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
    }
}

fn main() {
    let a: Vec<f32> = (0..N).map(|i| (i + 1) as f32).collect();
    let b = vec![1.0f32; N];
    let start = Instant::now();
    let mut result = 0.0f32;
    for _ in 0..REPS {
        result = dot(&a, &b);
    }
    let elapsed = start.elapsed().as_millis();
    println!("simd_dot N={} reps={} dot={}, time = {} ms", N, REPS, result as i32, elapsed);
}
