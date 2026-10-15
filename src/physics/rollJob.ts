/**
 * 1回の投擲を「最後まで」シミュレーションして記録するジョブ。
 *
 * - 時間分割実行: advance(ms) を毎フレーム少しずつ呼べば UI を止めずに計算できる
 * - 判定: 全サイコロが静止したあと、各サイコロの姿勢から目を読み、
 *     * 椀外へ出たサイコロ   → ションベン (仕様: 発生確率 1% は呼び出し側 wantShonben で決める)
 *     * 傾いている / 重なっている → 「ノーカウント」として自動で振り直し
 *   を判定する。振り直しが起きた試行は破棄し、別の初期条件でやり直す。
 */
import {
  DICE_COUNT,
  DIE,
  FRAME_HZ,
  MAX_SIM_TIME,
  SLEEP_TIME,
  STEP_HZ,
} from './constants';
import { BowlModel } from './bowlModel';
import { ContactEvent, DiceWorld } from './world';
import { Prng, Seed4, seedToLabel } from './rng';
import { makeThrow, ThrowSpec } from './throw';
import { FLOATS_PER_DIE, Recording, RollMeta, RollOutcome } from './recording';
import { topFaceFromRotation } from './diceShape';

export type Quality = 'low' | 'medium' | 'high';

/**
 * 底面と(凹凸を除いた)お椀の面の傾きがこの角度を超えたら「傾いている(ノーカウント)」。
 * 静止した賽の傾きは 5°未満が99.5%で、5〜30°にはほぼ存在しない (scripts/physics-verify.ts 参照)
 */
export const TILT_LIMIT_DEG = 15;

/** ションベンで椀外に出たサイコロが止まる位置の許容範囲 (お椀の中心から) [m]。机の見える範囲に収める */
export const MAX_OUTSIDE_DISTANCE = 0.38;

export interface DieEval {
  value: number;
  /** お椀の中心から静止位置までの水平距離 [m] */
  dist: number;
  place: 'inside' | 'outside' | 'rim';
  tiltDeg: number;
  stacked: boolean;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function evaluateDie(world: DiceWorld, i: number, q: Float64Array): DieEval {
  const bowl = world.bowl;
  const prof = bowl.profile;
  const x = world.pos[i * 3];
  const y = world.pos[i * 3 + 1];
  const z = world.pos[i * 3 + 2];
  const r = Math.sqrt(x * x + z * z);
  let place: DieEval['place'];
  if (r < prof.rimInnerR - 0.001) place = 'inside';
  else if (y < prof.rimInnerY - 0.012) place = 'outside';
  else place = 'rim';

  const { arr, off } = world.rotationOf(i);
  const top = topFaceFromRotation(arr, off);

  bowl.queryBase(x, y, z, q);
  const phi = q[0];
  const nx = q[1];
  const ny = q[2];
  const nz = q[3];
  // 面(軸)と接触面法線のなす角が最小の面 = 底面
  let cosB = 0;
  for (let a = 0; a < 3; a++) {
    const d = Math.abs(arr[off + a] * nx + arr[off + 3 + a] * ny + arr[off + 6 + a] * nz);
    if (d > cosB) cosB = d;
  }
  const tiltDeg = (Math.acos(Math.min(1, cosB)) * 180) / Math.PI;
  const stacked = place === 'inside' && phi > DIE.half + 0.0035;
  return { value: top.value, dist: r, place, tiltDeg, stacked };
}

export interface RollJobOptions {
  quality?: Quality;
  /** true: ションベンになる投擲を探して再生する / false: 椀の中に収まる投擲 */
  wantShonben: boolean;
  maxAttempts?: number;
}

export class RollJob {
  readonly bowl: BowlModel;
  readonly world: DiceWorld;
  readonly wantShonben: boolean;
  readonly stepHz: number;
  private rng: Prng;
  private seedLabel: string;
  private maxAttempts: number;
  private stepsPerFrame: number;

  private frames: Float32Array;
  private rollArr: Float32Array;
  private frameN = 0;
  private events: ContactEvent[] = [];
  private spec!: ThrowSpec;
  private running = false;
  private attempt = 0;
  private totalSteps = 0;
  private simMs = 0;
  private rejected = { cocked: 0, stacked: 0, escaped: 0, missed: 0, rim: 0, timeout: 0, numeric: 0 };
  private q = new Float64Array(5);

  done = false;
  outcome: RollOutcome | null = null;

  constructor(bowl: BowlModel, seed: Seed4, opts: RollJobOptions, world?: DiceWorld) {
    this.bowl = bowl;
    this.wantShonben = opts.wantShonben;
    const quality = opts.quality ?? 'medium';
    this.stepHz = STEP_HZ[quality];
    this.stepsPerFrame = Math.max(1, Math.round(this.stepHz / FRAME_HZ));
    this.world = world ?? new DiceWorld(bowl, this.stepHz);
    this.rng = new Prng(seed);
    this.seedLabel = seedToLabel(seed);
    this.maxAttempts = opts.maxAttempts ?? (opts.wantShonben ? 90 : 40);
    const maxFrames = Math.ceil(MAX_SIM_TIME * FRAME_HZ) + 4;
    this.frames = new Float32Array(maxFrames * DICE_COUNT * FLOATS_PER_DIE);
    this.rollArr = new Float32Array(maxFrames);
  }

  /** 毎フレーム少しずつ呼ぶ。完了で true */
  advance(budgetMs: number): boolean {
    if (this.done) return true;
    const t0 = now();
    while (!this.done) {
      if (!this.running) this.beginAttempt();
      for (let k = 0; k < 8 && this.running; k++) this.stepOnce();
      if (now() - t0 >= budgetMs) break;
    }
    this.simMs += now() - t0;
    return this.done;
  }

  /** 最後まで一気に計算 (テスト用) */
  runToEnd(): RollOutcome {
    while (!this.advance(1e9)) {
      /* advance が完了するまで */
    }
    return this.outcome as RollOutcome;
  }

  private beginAttempt(): void {
    this.attempt++;
    const w = this.world;
    w.reset();
    this.spec = makeThrow(this.rng, this.bowl, this.wantShonben);
    for (let i = 0; i < DICE_COUNT; i++) {
      const d = this.spec.dice[i];
      w.setBody(i, d.p, d.q, d.v, d.w);
    }
    this.events = [];
    w.eventSink = (e) => {
      this.events.push(e);
    };
    this.frameN = 0;
    this.recordFrame();
    this.running = true;
  }

  private recordFrame(): void {
    const w = this.world;
    const stride = DICE_COUNT * FLOATS_PER_DIE;
    const base = this.frameN * stride;
    const F = this.frames;
    for (let i = 0; i < DICE_COUNT; i++) {
      const o = base + i * FLOATS_PER_DIE;
      F[o] = w.pos[i * 3];
      F[o + 1] = w.pos[i * 3 + 1];
      F[o + 2] = w.pos[i * 3 + 2];
      F[o + 3] = w.quat[i * 4];
      F[o + 4] = w.quat[i * 4 + 1];
      F[o + 5] = w.quat[i * 4 + 2];
      F[o + 6] = w.quat[i * 4 + 3];
    }
    this.rollArr[this.frameN] = w.rollSteps > 0 ? w.rollAcc / w.rollSteps : 0;
    w.rollAcc = 0;
    w.rollSteps = 0;
    this.frameN++;
  }

  private stepOnce(): void {
    const w = this.world;
    w.step();
    this.totalSteps++;
    if (w.stepCount % this.stepsPerFrame === 0) this.recordFrame();

    if (w.failed) {
      this.rejected.numeric++;
      this.endAttempt(false, 'numeric');
      return;
    }
    if (w.allAsleep()) {
      if (w.stepCount % this.stepsPerFrame !== 0) this.recordFrame();
      this.finishAttempt();
      return;
    }
    if (w.time >= MAX_SIM_TIME) {
      this.rejected.timeout++;
      this.endAttempt(false, 'timeout');
    }
  }

  /** 全サイコロが静止 → 判定 */
  private finishAttempt(): void {
    const w = this.world;
    const evals: DieEval[] = [];
    for (let i = 0; i < DICE_COUNT; i++) evals.push(evaluateDie(w, i, this.q));
    const outside = evals.filter((e) => e.place === 'outside').length;
    const rim = evals.filter((e) => e.place === 'rim').length;
    const tooFar = evals.some((e) => e.place === 'outside' && e.dist > MAX_OUTSIDE_DISTANCE);
    const cocked = evals.some((e) => e.place === 'inside' && e.tiltDeg > TILT_LIMIT_DEG);
    const stacked = evals.some((e) => e.stacked);

    let ok: boolean;
    if (this.wantShonben) {
      ok = outside >= 1 && rim === 0 && !tooFar;
      if (!ok) {
        if (rim > 0) this.rejected.rim++;
        else this.rejected.missed++; // 椀外に出なかった (狙いはずれ)
      }
    } else {
      ok = outside === 0 && rim === 0 && !cocked && !stacked;
      if (!ok) {
        if (outside > 0) this.rejected.escaped++;
        else if (rim > 0) this.rejected.rim++;
        else if (stacked) this.rejected.stacked++;
        else this.rejected.cocked++;
      }
    }
    this.endAttempt(ok, ok ? 'ok' : 'invalid', evals);
  }

  private endAttempt(ok: boolean, _why: string, evals?: DieEval[]): void {
    this.running = false;
    if (!ok && this.attempt < this.maxAttempts) return; // 次の試行へ
    if (!ok && !evals) {
      // 数値破綻/タイムアウトで試行上限 → 最後の状態から無理やり評価
      evals = [];
      for (let i = 0; i < DICE_COUNT; i++) evals.push(evaluateDie(this.world, i, this.q));
    }
    if (!evals) return;
    this.finalize(evals, !ok);
  }

  private finalize(evals: DieEval[], relaxed: boolean): void {
    const w = this.world;
    const stride = DICE_COUNT * FLOATS_PER_DIE;
    const frames = this.frames.slice(0, this.frameN * stride);
    const roll = this.rollArr.slice(0, this.frameN);
    // 最後の数フレームの転がり音は 0 に落として自然に消す
    for (let i = Math.max(0, roll.length - 3); i < roll.length; i++) roll[i] = 0;
    const duration = (this.frameN - 1) / FRAME_HZ;
    const rec: Recording = {
      frameHz: FRAME_HZ,
      frameCount: this.frameN,
      frames,
      roll,
      events: this.events,
      duration,
      restTime: Math.max(0, w.time - SLEEP_TIME),
    };
    const outsideDice: number[] = [];
    evals.forEach((e, i) => {
      if (e.place === 'outside') outsideDice.push(i);
    });
    const st = w.stats;
    const meta: RollMeta = {
      seedLabel: this.seedLabel,
      attempts: this.attempt,
      rejected: { ...this.rejected },
      steps: this.totalSteps,
      simMs: this.simMs,
      maxPenetrationMm: st.maxPenetration * 1000,
      impacts: st.impacts,
      bowlImpacts: st.bowlImpacts,
      diceImpacts: st.diceImpacts,
      stepHz: this.stepHz,
      bumpScale: this.bowl.bumpScale,
      relaxed,
    };
    this.outcome = {
      values: evals.map((e) => e.value),
      shonben: outsideDice.length > 0,
      outsideDice,
      recording: rec,
      throwSpec: this.spec,
      meta,
    };
    w.eventSink = null;
    this.done = true;
  }
}
