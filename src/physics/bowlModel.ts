/**
 * お椀モデル = 断面プロファイル(回転体) + 凹凸高さマップ
 *
 * 物理側は `query()` で「任意の点から固体(お椀・机)までの符号付き距離と法線」を問い合わせる。
 *   φ > 0 : 空間(空気)側 / φ < 0 : 固体の内部
 *
 * - 回転体部分は (r, y) 断面の 2D 距離場を一度だけ焼き込み、双線形補間で引く。
 * - 内面には凹凸マップ b(x,z) を「垂直方向の変位」として重ねる。
 *     変位面の距離  φ' ≈ φ - b·n_y
 *     変位面の法線  n' ∝ n - n_y·(∂b/∂x, 0, ∂b/∂z)
 * - 机は y=0 の無限平面として扱う (min を取る)。
 */
import { MAT_GLAZE, MAT_TABLE } from './constants';
import { AXIS_SEGMENT, BowlProfile, BowlSpec, DEFAULT_BOWL_SPEC, buildBowlProfile } from './bowlProfile';
import { BumpField, generateBumpField, sampleBump } from './bowlBump';
import { Seed4 } from './rng';

/** 距離場を厳密に持つ帯の幅 [m]。これより遠い点は ±BAND にクランプ */
export const SDF_BAND = 0.014;

export interface SdfGrid {
  nR: number;
  nY: number;
  dR: number;
  dY: number;
  invDR: number;
  invDY: number;
  y0: number;
  rMax: number;
  yMax: number;
  /** stride 3: [φ, ∂φ/∂r, ∂φ/∂y] */
  data: Float32Array;
  mat: Uint8Array;
}

/** (r,y) 断面の符号付き距離場を焼き込む */
export function bakeSdfGrid(profile: BowlProfile): SdfGrid {
  const dR = 0.00025;
  const dY = 0.00025;
  const y0 = -0.002;
  const rMax = profile.maxR + SDF_BAND;
  const yMax = profile.rimTopY + SDF_BAND + 0.01;
  const nR = Math.ceil(rMax / dR) + 1;
  const nY = Math.ceil((yMax - y0) / dY) + 1;
  const nNodes = nR * nY;

  const seg = profile.segments;
  const segMat = profile.segmentMat;
  const segN = segMat.length;

  // --- 1. 帯の内側の厳密距離 (線分ごとに近傍ノードだけ更新) ---
  const bestSq = new Float32Array(nNodes).fill(SDF_BAND * SDF_BAND);
  const matBest = new Uint8Array(nNodes);
  for (let s = 0; s < segN; s++) {
    if (segMat[s] === AXIS_SEGMENT) continue;
    const r0 = seg[s * 4];
    const ya = seg[s * 4 + 1];
    const r1 = seg[s * 4 + 2];
    const yb = seg[s * 4 + 3];
    const ex = r1 - r0;
    const ey = yb - ya;
    const len2 = ex * ex + ey * ey;
    const i0 = Math.max(0, Math.floor((Math.min(r0, r1) - SDF_BAND) / dR));
    const i1 = Math.min(nR - 1, Math.ceil((Math.max(r0, r1) + SDF_BAND) / dR));
    const j0 = Math.max(0, Math.floor((Math.min(ya, yb) - SDF_BAND - y0) / dY));
    const j1 = Math.min(nY - 1, Math.ceil((Math.max(ya, yb) + SDF_BAND - y0) / dY));
    const m = segMat[s];
    for (let j = j0; j <= j1; j++) {
      const py = y0 + j * dY;
      for (let i = i0; i <= i1; i++) {
        const px = i * dR;
        let t = len2 > 0 ? ((px - r0) * ex + (py - ya) * ey) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (r0 + t * ex);
        const dy = py - (ya + t * ey);
        const d2 = dx * dx + dy * dy;
        const idx = j * nR + i;
        if (d2 < bestSq[idx]) {
          bestSq[idx] = d2;
          matBest[idx] = m;
        }
      }
    }
  }

  // --- 2. 符号: 走査線の交差数 (偶奇規則) ---
  const phi = new Float32Array(nNodes);
  const crossings: number[] = [];
  for (let j = 0; j < nY; j++) {
    const py = y0 + j * dY;
    crossings.length = 0;
    for (let s = 0; s < segN; s++) {
      const ya = seg[s * 4 + 1];
      const yb = seg[s * 4 + 3];
      if ((ya <= py && py < yb) || (yb <= py && py < ya)) {
        const ra = seg[s * 4];
        const rb = seg[s * 4 + 2];
        crossings.push(ra + ((py - ya) * (rb - ra)) / (yb - ya));
      }
    }
    crossings.sort((a, b) => a - b);
    let c = 0;
    for (let i = 0; i < nR; i++) {
      const px = i * dR;
      while (c < crossings.length && crossings[c] <= px) c++;
      const d = Math.sqrt(bestSq[j * nR + i]);
      phi[j * nR + i] = c & 1 ? -d : d;
    }
  }

  // --- 3. 勾配 (中心差分) をパック ---
  const data = new Float32Array(nNodes * 3);
  for (let j = 0; j < nY; j++) {
    const jl = j > 0 ? j - 1 : 0;
    const jh = j < nY - 1 ? j + 1 : nY - 1;
    for (let i = 0; i < nR; i++) {
      const il = i > 0 ? i - 1 : 0;
      const ih = i < nR - 1 ? i + 1 : nR - 1;
      const idx = j * nR + i;
      let gr = (phi[j * nR + ih] - phi[j * nR + il]) / ((ih - il) * dR);
      if (i === 0) gr = 0; // 回転軸上は対称性から 0
      const gy = (phi[jh * nR + i] - phi[jl * nR + i]) / ((jh - jl) * dY);
      data[idx * 3] = phi[idx];
      data[idx * 3 + 1] = gr;
      data[idx * 3 + 2] = gy;
    }
  }

  return { nR, nY, dR, dY, invDR: 1 / dR, invDY: 1 / dY, y0, rMax, yMax, data, mat: matBest };
}

/** query() の出力レイアウト */
export const Q_PHI = 0;
export const Q_NX = 1;
export const Q_NY = 2;
export const Q_NZ = 3;
export const Q_MAT = 4;

export class BowlModel {
  readonly profile: BowlProfile;
  readonly grid: SdfGrid;
  readonly bump: BumpField;
  readonly seed: Seed4;
  /** 凹凸の強さ (0 で完全に滑らかなお椀)。物理と描画の両方に効く */
  bumpScale = 1;
  /** 生成にかかった時間 [ms] (表示用) */
  readonly bakeMs: { profile: number; sdf: number; bump: number };

  private tmpB = new Float64Array(3);

  constructor(profile: BowlProfile, grid: SdfGrid, bump: BumpField, seed: Seed4, bakeMs: BowlModel['bakeMs']) {
    this.profile = profile;
    this.grid = grid;
    this.bump = bump;
    this.seed = seed;
    this.bakeMs = bakeMs;
  }

  /**
   * 点 (x,y,z) から固体までの符号付き距離 φ・法線 n(固体→空間向き)・材質を out に書く。
   * out = Float64Array(5): [φ, nx, ny, nz, mat]
   */
  query(x: number, y: number, z: number, out: Float64Array): void {
    const g = this.grid;
    // 机 (y=0 の平面)
    let phi = y;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let mat = MAT_TABLE;

    const r = Math.sqrt(x * x + z * z);
    if (r < g.rMax - g.dR && y < g.yMax - g.dY && y > g.y0) {
      const fr = r * g.invDR;
      const fy = (y - g.y0) * g.invDY;
      const i = fr | 0;
      const j = fy | 0;
      const tr = fr - i;
      const ty = fy - j;
      const d = g.data;
      const o00 = (j * g.nR + i) * 3;
      const o10 = o00 + 3;
      const o01 = o00 + g.nR * 3;
      const o11 = o01 + 3;
      const w00 = (1 - tr) * (1 - ty);
      const w10 = tr * (1 - ty);
      const w01 = (1 - tr) * ty;
      const w11 = tr * ty;
      let sphi = d[o00] * w00 + d[o10] * w10 + d[o01] * w01 + d[o11] * w11;
      if (sphi < phi) {
        const gr = d[o00 + 1] * w00 + d[o10 + 1] * w10 + d[o01 + 1] * w01 + d[o11 + 1] * w11;
        let gy = d[o00 + 2] * w00 + d[o10 + 2] * w10 + d[o01 + 2] * w01 + d[o11 + 2] * w11;
        const len = Math.sqrt(gr * gr + gy * gy);
        let nrr = 0;
        if (len > 1e-6) {
          nrr = gr / len;
          gy = gy / len;
        } else {
          gy = 1;
        }
        const nidx = ((tr > 0.5 ? i + 1 : i) + (ty > 0.5 ? j + 1 : j) * g.nR) | 0;
        const m = g.mat[nidx];
        const invR = r > 1e-9 ? 1 / r : 0;
        let sx = nrr * x * invR;
        let sz = nrr * z * invR;
        let sy = gy;

        // 内面の凹凸 (上向きの内面にだけ作用)
        if (m === MAT_GLAZE && sy > 0.02 && this.bumpScale !== 0) {
          const b = this.tmpB;
          sampleBump(this.bump, x, z, b);
          const s = this.bumpScale;
          sphi -= b[0] * s * sy;
          sx -= sy * b[1] * s;
          sz -= sy * b[2] * s;
          const l2 = Math.sqrt(sx * sx + sy * sy + sz * sz);
          sx /= l2;
          sy /= l2;
          sz /= l2;
        }

        if (sphi < phi) {
          phi = sphi;
          nx = sx;
          ny = sy;
          nz = sz;
          mat = m;
        }
      }
    }
    out[0] = phi;
    out[1] = nx;
    out[2] = ny;
    out[3] = nz;
    out[4] = mat;
  }

  /** 凹凸を無視した「基本形状だけ」の query。賽の傾き判定など、局所の凹凸に左右されたくない用途向け */
  queryBase(x: number, y: number, z: number, out: Float64Array): void {
    const s = this.bumpScale;
    this.bumpScale = 0;
    this.query(x, y, z, out);
    this.bumpScale = s;
  }

  /** 内面の高さ (凹凸込み)。r<rimInnerR の範囲で有効。サイコロの初期配置・描画用 */
  innerSurfaceY(x: number, z: number): number {
    const r = Math.sqrt(x * x + z * z);
    const base = this.profile.innerHeightAt(r);
    sampleBump(this.bump, x, z, this.tmpB);
    return base + this.tmpB[0] * this.bumpScale;
  }

  /** 凹凸の b と勾配 (スケール適用済み) */
  bumpAt(x: number, z: number, out: Float64Array): void {
    sampleBump(this.bump, x, z, out);
    out[0] *= this.bumpScale;
    out[1] *= this.bumpScale;
    out[2] *= this.bumpScale;
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** お椀を生成する (SDF焼き込み + 凹凸生成)。起動時に1回だけ呼ぶ */
export function buildBowlModel(seed: Seed4, spec: BowlSpec = DEFAULT_BOWL_SPEC): BowlModel {
  const t0 = now();
  const profile = buildBowlProfile(spec);
  const t1 = now();
  const grid = bakeSdfGrid(profile);
  const t2 = now();
  const bump = generateBumpField(seed, profile.rimInnerR);
  const t3 = now();
  return new BowlModel(profile, grid, bump, seed, { profile: t1 - t0, sdf: t2 - t1, bump: t3 - t2 });
}
