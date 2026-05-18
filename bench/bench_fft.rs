use std::time::Instant;

const N: usize = 4096;
const LOG2N: usize = 12;
const REPS: usize = 1000;

fn bit_reverse(mut x: usize, bits: usize) -> usize {
    let mut r = 0usize;
    for _ in 0..bits {
        r = (r << 1) | (x & 1);
        x >>= 1;
    }
    r
}

fn fft(re: &mut Vec<f64>, im: &mut Vec<f64>) {
    // Bit-reverse permutation
    for i in 0..N {
        let j = bit_reverse(i, LOG2N);
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    // Butterfly stages
    let mut mmax = 1usize;
    while mmax < N {
        mmax <<= 1;
        let half = mmax / 2;
        let angle = -2.0 * std::f64::consts::PI / mmax as f64;
        let wr0 = angle.cos();
        let wi0 = angle.sin();
        let mut k = 0usize;
        while k < N {
            let (mut cr, mut ci) = (1.0f64, 0.0f64);
            for j in 0..half {
                let idx_j = k + j;
                let idx_jh = k + j + half;
                let tr = cr * re[idx_jh] - ci * im[idx_jh];
                let ti = cr * im[idx_jh] + ci * re[idx_jh];
                re[idx_jh] = re[idx_j] - tr;
                im[idx_jh] = im[idx_j] - ti;
                re[idx_j]  = re[idx_j] + tr;
                im[idx_j]  = im[idx_j] + ti;
                let (ncr, nci) = (cr * wr0 - ci * wi0, cr * wi0 + ci * wr0);
                cr = ncr;
                ci = nci;
            }
            k += mmax;
        }
    }
}

fn main() {
    let mut re = vec![0f64; N];
    let mut im = vec![0f64; N];
    re[0] = 1.0; // impulse at index 0
    let start = Instant::now();
    for _ in 0..REPS {
        fft(&mut re, &mut im);
        // Re-initialise for the next rep
        re.iter_mut().for_each(|x| *x = 0.0);
        im.iter_mut().for_each(|x| *x = 0.0);
        re[0] = 1.0;
    }
    let elapsed = start.elapsed().as_millis();
    // One final FFT for the check value
    fft(&mut re, &mut im);
    // Impulse FFT → all output bins = 1+0i; re[1] ≈ 1
    println!("fft N={} reps={} in {} ms, re[1]={} (expect 1)", N, REPS, elapsed, re[1].round() as i64);
}
