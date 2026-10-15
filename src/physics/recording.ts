/**
 * 投擲の記録
 *
 * 物理シミュレーションは投擲ごとに「先に最後まで」計算し、結果をこの形式で記録する。
 * 描画側は記録を任意の時刻でサンプリングして再生するだけなので、
 *   - フレームレート非依存 (60/120/144Hz どれでも同じ動き)
 *   - スロー再生・リプレイ・カメラ演出が自由
 *   - 結果が事前に確定しているので、表示途中で止まる/ズレることがない
 */
import { DICE_COUNT } from './constants';
import type { ContactEvent } from './world';
import type { ThrowSpec } from './throw';

export const FLOATS_PER_DIE = 7; // px,py,pz, qx,qy,qz,qw

export interface Recording {
  frameHz: number;
  frameCount: number;
  /** [frame][die][7] */
  frames: Float32Array;
  /** フレームごとの「転がり音の大きさ」 */
  roll: Float32Array;
  events: ContactEvent[];
  /** 記録の長さ [s] */
  duration: number;
  /** 最後のサイコロが実際に止まった時刻 [s] */
  restTime: number;
}

export interface RollMeta {
  /** 投擲のシード表示用ラベル */
  seedLabel: string;
  /** シミュレーションの試行回数 (傾き・椀外などで棄却されると増える) */
  attempts: number;
  /** 棄却内訳。escaped=椀外へ出た(通常投擲) / missed=椀外へ出なかった(ションベン狙い) */
  rejected: { cocked: number; stacked: number; escaped: number; missed: number; rim: number; timeout: number; numeric: number };
  steps: number;
  /** シミュレーションにかかった実時間 [ms] */
  simMs: number;
  /** 最大めり込み [mm] */
  maxPenetrationMm: number;
  impacts: number;
  bowlImpacts: number;
  diceImpacts: number;
  /** ステップ周波数 [Hz] */
  stepHz: number;
  /** お椀の凹凸の強さ */
  bumpScale: number;
  /** 条件を満たす試行が見つからず、最後の試行をそのまま採用した */
  relaxed: boolean;
}

export interface RollOutcome {
  /** 各サイコロの出目 (1〜6)。椀外に出たサイコロも姿勢から読んだ値 */
  values: number[];
  /** 椀外へ飛び出したサイコロがあるか (= ションベン) */
  shonben: boolean;
  /** 椀外へ出たサイコロの番号 */
  outsideDice: number[];
  recording: Recording;
  throwSpec: ThrowSpec;
  meta: RollMeta;
}

const tmpQ = new Float64Array(4);

/** 時刻 t [s] の各サイコロの姿勢を out (長さ 5×7) に書く */
export function sampleRecording(rec: Recording, t: number, out: Float32Array | Float64Array): void {
  const f = rec.frameCount;
  let x = t * rec.frameHz;
  if (x <= 0) x = 0;
  if (x >= f - 1) x = f - 1;
  const i0 = Math.floor(x);
  const i1 = Math.min(f - 1, i0 + 1);
  const a = x - i0;
  const stride = DICE_COUNT * FLOATS_PER_DIE;
  const base0 = i0 * stride;
  const base1 = i1 * stride;
  const F = rec.frames;
  for (let d = 0; d < DICE_COUNT; d++) {
    const o0 = base0 + d * FLOATS_PER_DIE;
    const o1 = base1 + d * FLOATS_PER_DIE;
    const oo = d * FLOATS_PER_DIE;
    out[oo] = F[o0] + (F[o1] - F[o0]) * a;
    out[oo + 1] = F[o0 + 1] + (F[o1 + 1] - F[o0 + 1]) * a;
    out[oo + 2] = F[o0 + 2] + (F[o1 + 2] - F[o0 + 2]) * a;
    slerp(F, o0 + 3, F, o1 + 3, a, tmpQ);
    out[oo + 3] = tmpQ[0];
    out[oo + 4] = tmpQ[1];
    out[oo + 5] = tmpQ[2];
    out[oo + 6] = tmpQ[3];
  }
}

export function sampleRoll(rec: Recording, t: number): number {
  const f = rec.frameCount;
  let x = t * rec.frameHz;
  if (x <= 0) return rec.roll[0] ?? 0;
  if (x >= f - 1) return 0;
  const i0 = Math.floor(x);
  const a = x - i0;
  return rec.roll[i0] + (rec.roll[Math.min(f - 1, i0 + 1)] - rec.roll[i0]) * a;
}

function slerp(
  A: ArrayLike<number>,
  ao: number,
  B: ArrayLike<number>,
  bo: number,
  t: number,
  out: Float64Array,
): void {
  const ax = A[ao];
  const ay = A[ao + 1];
  const az = A[ao + 2];
  const aw = A[ao + 3];
  let bx = B[bo];
  let by = B[bo + 1];
  let bz = B[bo + 2];
  let bw = B[bo + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (cos > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const th = Math.acos(cos);
    const sn = Math.sin(th);
    s0 = Math.sin((1 - t) * th) / sn;
    s1 = Math.sin(t * th) / sn;
  }
  const x = s0 * ax + s1 * bx;
  const y = s0 * ay + s1 * by;
  const z = s0 * az + s1 * bz;
  const w = s0 * aw + s1 * bw;
  const l = 1 / Math.sqrt(x * x + y * y + z * z + w * w);
  out[0] = x * l;
  out[1] = y * l;
  out[2] = z * l;
  out[3] = w * l;
}
