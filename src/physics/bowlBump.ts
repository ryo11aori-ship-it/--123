/**
 * お椀内面の凹凸 (微細な高さマップ)
 *
 * 手作りの陶器丼を想定し、次の成分を重ねた「内面を垂直方向に動かす変位量 b(x, z) [m]」を作る。
 *   1. ろくろ目      : 同心円状の細かな波 (ゆるい螺旋)
 *   2. うねり        : 数cm周期のなだらかな起伏
 *   3. 槌目(つちめ)  : 数mm径の浅いくぼみが敷き詰められた手仕事の凹凸
 *   4. 欠陥          : ピンホール(くぼみ)・釉だまり(出っ張り) 数mm径が十数個
 *
 * このマップは「描画メッシュの頂点」と「物理の衝突判定」の両方から参照される。
 * 角丸 R1.5mm のサイコロの角が数mmの凹凸に当たって弾道が変わるため、
 * 結果にはこの凹凸が複雑に影響する (カオス的な感度)。
 */
import { Prng, Seed4 } from './rng';

export interface BumpField {
  /** 格子が覆う範囲 [-half, +half]² [m] */
  half: number;
  /** 格子間隔 [m] */
  step: number;
  /** 一辺の格子点数 */
  n: number;
  /** stride 3: [b, ∂b/∂x, ∂b/∂z] */
  data: Float32Array;
  /** 生成に使った成分の統計 (表示用) */
  stats: { rms: number; peak: number; dimples: number; defects: number };
}

/** 周期テーブル型の値ノイズ (C1連続) */
class NoiseTable {
  private v: Float32Array;
  private size = 64;
  constructor(rng: Prng) {
    this.v = new Float32Array(this.size * this.size);
    for (let i = 0; i < this.v.length; i++) this.v[i] = rng.range(-1, 1);
  }
  sample(x: number, z: number): number {
    const sz = this.size;
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    let tx = x - fx;
    let tz = z - fz;
    tx = tx * tx * (3 - 2 * tx);
    tz = tz * tz * (3 - 2 * tz);
    const x0 = ((fx % sz) + sz) % sz;
    const z0 = ((fz % sz) + sz) % sz;
    const x1 = (x0 + 1) % sz;
    const z1 = (z0 + 1) % sz;
    const v = this.v;
    const a = v[z0 * sz + x0];
    const b = v[z0 * sz + x1];
    const c = v[z1 * sz + x0];
    const d = v[z1 * sz + x1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }
}

/** 滑らかな釉薬の盛り上がり/くぼみの核 (C1連続, ρ<R で有限台) */
function kernel(rho2: number, R2: number): number {
  const u = 1 - rho2 / R2;
  return u * u;
}

export function generateBumpField(seed: Seed4, rimInnerR: number): BumpField {
  const rng = new Prng(seed);
  const step = 0.0004;
  const half = rimInnerR + 0.003;
  const n = Math.ceil((half * 2) / step) + 1;
  const b = new Float32Array(n * n);

  // ---- 1. うねり (2オクターブ・回転した格子) ----
  const noiseA = new NoiseTable(rng);
  const noiseB = new NoiseTable(rng);
  const lamA = 0.034; // 34mm
  const lamB = 0.015; // 15mm
  const ampA = 0.00032;
  const ampB = 0.00016;
  const ca = Math.cos(0.6);
  const sa = Math.sin(0.6);
  // ---- 2. ろくろ目 ----
  const ringLam = 0.0052;
  const ringAmp = 0.00006;
  const ringPhase = rng.range(0, Math.PI * 2);
  const ringSpiral = rng.range(0.8, 1.8);
  const ringMod = new NoiseTable(rng);

  const fadeOuter = rimInnerR - 0.004;
  const fadeInner = rimInnerR - 0.014;

  const x0 = -half;
  for (let j = 0; j < n; j++) {
    const z = x0 + j * step;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step;
      const r = Math.sqrt(x * x + z * z);
      if (r > fadeOuter) continue;
      let h = ampA * noiseA.sample(x / lamA, z / lamA);
      h += ampB * noiseB.sample((x * ca - z * sa) / lamB + 17.3, (x * sa + z * ca) / lamB + 5.1);
      const th = Math.atan2(z, x);
      const mod = 0.55 + 0.45 * (ringMod.sample(r / 0.02, 3.7) * 0.5 + 0.5);
      h += ringAmp * mod * Math.sin((Math.PI * 2 * r) / ringLam + ringPhase + ringSpiral * th);
      b[j * n + i] = h;
    }
  }

  // ---- 3. 槌目: ジッタ付き格子に浅いくぼみ ----
  const cell = 0.0075;
  const cells = Math.ceil((half * 2) / cell) + 1;
  let dimples = 0;
  const splat = (cx: number, cz: number, R: number, amp: number) => {
    const R2 = R * R;
    const i0 = Math.max(0, Math.floor((cx - R - x0) / step));
    const i1 = Math.min(n - 1, Math.ceil((cx + R - x0) / step));
    const j0 = Math.max(0, Math.floor((cz - R - x0) / step));
    const j1 = Math.min(n - 1, Math.ceil((cz + R - x0) / step));
    for (let j = j0; j <= j1; j++) {
      const dz = x0 + j * step - cz;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + i * step - cx;
        const rho2 = dx * dx + dz * dz;
        if (rho2 >= R2) continue;
        b[j * n + i] += amp * kernel(rho2, R2);
      }
    }
  };
  for (let cj = 0; cj < cells; cj++) {
    for (let ci = 0; ci < cells; ci++) {
      if (rng.float() > 0.92) continue;
      const cx = x0 + (ci + 0.5 + rng.range(-0.38, 0.38)) * cell;
      const cz = x0 + (cj + 0.5 + rng.range(-0.38, 0.38)) * cell;
      if (Math.hypot(cx, cz) > fadeOuter) continue;
      splat(cx, cz, rng.range(0.0024, 0.0036), -rng.range(0.0001, 0.00028));
      dimples++;
    }
  }

  // ---- 4. 欠陥: ピンホール / 釉だまり ----
  const defects = 16;
  for (let k = 0; k < defects; k++) {
    const rr = Math.sqrt(rng.float()) * (rimInnerR - 0.014);
    const th = rng.range(0, Math.PI * 2);
    const R = rng.range(0.001, 0.0024);
    const sign = rng.float() < 0.55 ? 1 : -1;
    splat(rr * Math.cos(th), rr * Math.sin(th), R, sign * rng.range(0.0002, 0.0005));
  }

  // ---- 外周のフェード (縁に近づくほど 0) ----
  for (let j = 0; j < n; j++) {
    const z = x0 + j * step;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step;
      const r = Math.sqrt(x * x + z * z);
      if (r <= fadeInner) continue;
      let f = 0;
      if (r < fadeOuter) {
        const t = (fadeOuter - r) / (fadeOuter - fadeInner);
        f = t * t * (3 - 2 * t);
      }
      b[j * n + i] *= f;
    }
  }

  // ---- 勾配 (中心差分) と統計 ----
  const data = new Float32Array(n * n * 3);
  let sum2 = 0;
  let peak = 0;
  let count = 0;
  const inv2 = 1 / (2 * step);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3;
      const v = b[j * n + i];
      const xm = b[j * n + Math.max(0, i - 1)];
      const xp = b[j * n + Math.min(n - 1, i + 1)];
      const zm = b[Math.max(0, j - 1) * n + i];
      const zp = b[Math.min(n - 1, j + 1) * n + i];
      data[o] = v;
      data[o + 1] = (xp - xm) * inv2;
      data[o + 2] = (zp - zm) * inv2;
      const x = x0 + i * step;
      const z = x0 + j * step;
      if (x * x + z * z < fadeInner * fadeInner) {
        sum2 += v * v;
        count++;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
  }
  return {
    half,
    step,
    n,
    data,
    stats: { rms: Math.sqrt(sum2 / Math.max(1, count)), peak, dimples, defects },
  };
}

/** 双線形補間で b と勾配を取り出す。範囲外は 0。 */
export function sampleBump(field: BumpField, x: number, z: number, out: Float64Array): void {
  const half = field.half;
  const n = field.n;
  const fx = (x + half) / field.step;
  const fz = (z + half) / field.step;
  if (fx < 0 || fz < 0 || fx >= n - 1 || fz >= n - 1) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return;
  }
  const i = fx | 0;
  const j = fz | 0;
  const tx = fx - i;
  const tz = fz - j;
  const d = field.data;
  const o00 = (j * n + i) * 3;
  const o10 = o00 + 3;
  const o01 = o00 + n * 3;
  const o11 = o01 + 3;
  const w00 = (1 - tx) * (1 - tz);
  const w10 = tx * (1 - tz);
  const w01 = (1 - tx) * tz;
  const w11 = tx * tz;
  out[0] = d[o00] * w00 + d[o10] * w10 + d[o01] * w01 + d[o11] * w11;
  out[1] = d[o00 + 1] * w00 + d[o10 + 1] * w10 + d[o01 + 1] * w01 + d[o11 + 1] * w11;
  out[2] = d[o00 + 2] * w00 + d[o10 + 2] * w10 + d[o01 + 2] * w01 + d[o11 + 2] * w11;
}
