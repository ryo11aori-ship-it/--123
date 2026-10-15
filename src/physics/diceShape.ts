/**
 * サイコロの衝突形状
 *
 * 角丸サイコロ = 「内側の箱 (半辺 b)」を半径 ρ の球でふくらませた形 (Minkowski和)。
 *   - サイコロ同士 : 内箱同士の最短距離 (頂点-面 と 辺-辺) − 2ρ を隙間とする
 *   - お椀・机     : 内箱の表面に並べたサンプル点 (各点に半径 ρ の球) とSDFを比較する
 *
 * 凸な空洞(お椀の内側)に対しては内箱の頂点だけで最深めり込みが決まる。
 * 縁(リム)のような凸の尾根や凹凸マップには辺・面上のサンプルが効く。
 */
import { DIE } from './constants';

const B = DIE.inner;

/** 頂点k: bit0=x, bit1=y, bit2=z (1 なら +b) */
export const VERT_LOCAL = new Float64Array(24);
for (let k = 0; k < 8; k++) {
  VERT_LOCAL[k * 3] = k & 1 ? B : -B;
  VERT_LOCAL[k * 3 + 1] = k & 2 ? B : -B;
  VERT_LOCAL[k * 3 + 2] = k & 4 ? B : -B;
}

/** 12本の辺 (頂点番号の組) */
export const EDGE_A = new Int32Array([0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3]);
export const EDGE_B = new Int32Array([1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7]);

export const SAMPLES_SPARSE_N = 26;
export const SAMPLES_DENSE_N = 98;

/**
 * サンプル点 (ローカル座標)。
 *   [0..7]    頂点
 *   [8..19]   辺の中点
 *   [20..25]  面の中心                 ← ここまで 26点 (通常)
 *   [26..49]  辺の 1/4, 3/4 点         (縁に近いとき追加)
 *   [50..97]  面の内部格子 (中心以外) 
 */
export const SAMPLES = (() => {
  const out: number[] = [];
  const push = (x: number, y: number, z: number) => out.push(x, y, z);
  for (let k = 0; k < 8; k++) push(VERT_LOCAL[k * 3], VERT_LOCAL[k * 3 + 1], VERT_LOCAL[k * 3 + 2]);
  const edgePoint = (e: number, t: number) => {
    const a = EDGE_A[e] * 3;
    const b = EDGE_B[e] * 3;
    push(
      VERT_LOCAL[a] + (VERT_LOCAL[b] - VERT_LOCAL[a]) * t,
      VERT_LOCAL[a + 1] + (VERT_LOCAL[b + 1] - VERT_LOCAL[a + 1]) * t,
      VERT_LOCAL[a + 2] + (VERT_LOCAL[b + 2] - VERT_LOCAL[a + 2]) * t,
    );
  };
  for (let e = 0; e < 12; e++) edgePoint(e, 0.5);
  for (let ax = 0; ax < 3; ax++) {
    for (const s of [1, -1]) {
      const p = [0, 0, 0];
      p[ax] = s * B;
      push(p[0], p[1], p[2]);
    }
  }
  for (let e = 0; e < 12; e++) {
    edgePoint(e, 0.25);
    edgePoint(e, 0.75);
  }
  for (let ax = 0; ax < 3; ax++) {
    const u = (ax + 1) % 3;
    const v = (ax + 2) % 3;
    for (const s of [1, -1]) {
      for (const a of [-0.5, 0, 0.5]) {
        for (const b of [-0.5, 0, 0.5]) {
          if (a === 0 && b === 0) continue;
          const p = [0, 0, 0];
          p[ax] = s * B;
          p[u] = a * B;
          p[v] = b * B;
          push(p[0], p[1], p[2]);
        }
      }
    }
  }
  return new Float64Array(out);
})();

if (SAMPLES.length !== SAMPLES_DENSE_N * 3) {
  throw new Error(`diceShape: サンプル数が想定と違います (${SAMPLES.length / 3})`);
}

/** 回転行列 (行優先) の第2行 = ローカル上方向(世界のY軸をローカルに写したもの)。目の判定に使う */
export function topFaceFromRotation(r: ArrayLike<number>, o = 0): { value: number; align: number } {
  const ux = r[o + 3]; // R[1][0]
  const uy = r[o + 4]; // R[1][1]
  const uz = r[o + 5]; // R[1][2]
  const ax = Math.abs(ux);
  const ay = Math.abs(uy);
  const az = Math.abs(uz);
  if (ax >= ay && ax >= az) return { value: ux > 0 ? 1 : 6, align: ax };
  if (ay >= ax && ay >= az) return { value: uy > 0 ? 2 : 5, align: ay };
  return { value: uz > 0 ? 3 : 4, align: az };
}

/** クォータニオン (x,y,z,w) → 回転行列 (行優先 9要素) */
export function quatToMat(qx: number, qy: number, qz: number, qw: number, out: Float64Array, o = 0): void {
  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;
  out[o] = 1 - 2 * (yy + zz);
  out[o + 1] = 2 * (xy - wz);
  out[o + 2] = 2 * (xz + wy);
  out[o + 3] = 2 * (xy + wz);
  out[o + 4] = 1 - 2 * (xx + zz);
  out[o + 5] = 2 * (yz - wx);
  out[o + 6] = 2 * (xz - wy);
  out[o + 7] = 2 * (yz + wx);
  out[o + 8] = 1 - 2 * (xx + yy);
}
