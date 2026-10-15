/**
 * チンチロ専用の剛体物理ワールド (5個の角丸サイコロ + お椀 + 机)
 *
 * 方式: Box2D v3 の "Soft Step" に近い逐次インパルス法
 *   - 毎ステップ接触を検出 (投機的接触: 1ステップで届く距離内の隙間も拘束にする → すり抜けない)
 *   - ウォームスタート + ソフト接触(貫通からの復帰が穏やか) + 緩和パス + 反発は最後に適用
 *   - クーロン摩擦 (2接線方向を円錐で制限)
 *   - サイコロは立方体なので慣性は等方 → ジャイロ項なし
 *
 * 衝突形状
 *   - サイコロ×お椀/机 : 内箱表面のサンプル点 (各点に半径ρの球) と BowlModel の SDF
 *   - サイコロ×サイコロ: 内箱どうしの最短距離 (頂点-面 / 辺-辺) − 2ρ
 */
import {
  DICE_COUNT,
  DICE_DICE_PARAMS,
  DIE,
  DIE_INV_INERTIA,
  DIE_INV_MASS,
  GRAVITY,
  MAT_GLAZE,
  MAT_TABLE,
  MAX_ANGULAR_SPEED,
  MAX_LINEAR_SPEED,
  SLEEP_ANGULAR,
  SLEEP_LINEAR,
  SLEEP_TIME,
  SURFACE_PARAMS,
} from './constants';
import { BowlModel } from './bowlModel';
import { EDGE_A, EDGE_B, SAMPLES, SAMPLES_DENSE_N, SAMPLES_SPARSE_N, VERT_LOCAL, quatToMat } from './diceShape';

const N = DICE_COUNT;
const RHO = DIE.cornerRadius;
const B_IN = DIE.inner;
const INNER_DIAG = B_IN * Math.sqrt(3);

/** 接触の最大数と1接触あたりのフィールド数 */
const MAXC = 1400;
const CS = 40;

const F_NX = 0;
const F_NY = 1;
const F_NZ = 2;
const F_RAX = 3;
const F_RAY = 4;
const F_RAZ = 5;
const F_RBX = 6;
const F_RBY = 7;
const F_RBZ = 8;
const F_GAP = 9;
const F_FRIC = 10;
const F_REST = 11;
const F_MN = 12;
const F_MT1 = 13;
const F_MT2 = 14;
const F_T1X = 15;
const F_T1Y = 16;
const F_T1Z = 17;
const F_T2X = 18;
const F_T2Y = 19;
const F_T2Z = 20;
const F_JN = 21;
const F_JT1 = 22;
const F_JT2 = 23;
const F_REL0 = 24;
const F_MAXJN = 25;
const F_IMA = 26;
const F_IIA = 27;
const F_IMB = 28;
const F_IIB = 29;
const F_GAPR = 30;
const F_PX = 31;
const F_PY = 32;
const F_PZ = 33;
const F_KIND = 34;
const F_JNS = 35;

/** ウォームスタート用キー空間: お椀(die*128+sample) + 各ペア576 */
const BOWL_KEYS = N * 128;
const PAIR_KEYS = 576;
const PAIR_COUNT = (N * (N - 1)) / 2;
const TOTAL_KEYS = BOWL_KEYS + PAIR_COUNT * PAIR_KEYS;

/** 衝撃イベントの種別 (効果音用) */
export const EV_GLAZE = 0;
export const EV_DICE = 1;
export const EV_TABLE = 2;
export const EV_RIM = 3;

export interface ContactEvent {
  t: number;
  kind: number;
  /** 衝突の強さ (接触点での法線方向の接近速度 [m/s]) */
  intensity: number;
  x: number;
  y: number;
  z: number;
  /** 当たったサイコロ (お椀・机との衝突なら b = -1) */
  a: number;
  b: number;
}

export type EventSink = (e: ContactEvent) => void;

export interface WorldStats {
  steps: number;
  maxContacts: number;
  /** 最大めり込み深さ (角丸の表面どうし) [m] */
  maxPenetration: number;
  impacts: number;
  bowlImpacts: number;
  diceImpacts: number;
}

const SOLVER_ITERS = 8;
const RELAX_ITERS = 4;
const RESTITUTION_ITERS = 6;
const SLOP = 0.00005;
const MAX_BIAS = 0.5;
const REST_THRESHOLD = 0.25;
const MAX_MARGIN = 0.011;
const EVENT_MIN = 0.12;

export class DiceWorld {
  readonly bowl: BowlModel;
  readonly h: number;
  time = 0;
  stepCount = 0;
  failed = false;

  /** 状態 */
  readonly pos = new Float64Array(3 * N);
  readonly quat = new Float64Array(4 * N); // x,y,z,w
  readonly vel = new Float64Array(3 * N);
  readonly ang = new Float64Array(3 * N);
  readonly asleep = new Uint8Array(N);
  readonly rot = new Float64Array(9 * N);
  private verts = new Float64Array(24 * N);
  private sleepT = new Float64Array(N);
  private touching = new Uint8Array(N);
  private surfTouch = new Uint8Array(N);
  private margin = new Float64Array(N);

  /** 接触 */
  private nC = 0;
  private F = new Float64Array(MAXC * CS);
  private ci = new Int32Array(MAXC * 3);
  private wsX = new Float32Array(TOTAL_KEYS);
  private wsY = new Float32Array(TOTAL_KEYS);
  private wsZ = new Float32Array(TOTAL_KEYS);
  private wsStamp = new Int32Array(TOTAL_KEYS).fill(-1);

  /** ソフト接触パラメータ */
  private biasRate: number;
  private massScale: number;
  private impulseScale: number;
  private invH: number;

  /** イベント */
  eventSink: EventSink | null = null;
  private lastEvT = new Float64Array(N * 4).fill(-1);
  private evBest = new Float64Array(N * 4);
  private evPos = new Float64Array(N * 4 * 3);
  private evOther = new Int32Array(N * 4);

  /** 転がり音用: 1フレーム分の累積 */
  rollAcc = 0;
  rollSteps = 0;

  readonly stats: WorldStats = {
    steps: 0,
    maxContacts: 0,
    maxPenetration: 0,
    impacts: 0,
    bowlImpacts: 0,
    diceImpacts: 0,
  };

  private q = new Float64Array(5);

  /** デバッグ: 最も深いめり込みが起きた接触の情報 */
  debugPen = { depth: 0, t: 0, a: -1, b: -1, key: -1, kind: '', speed: 0 };

  constructor(bowl: BowlModel, stepHz: number) {
    this.bowl = bowl;
    this.h = 1 / stepHz;
    this.invH = stepHz;
    const hertz = Math.min(120, 0.25 * stepHz);
    const zeta = 10;
    const omega = 2 * Math.PI * hertz;
    const a1 = 2 * zeta + this.h * omega;
    const a2 = this.h * omega * a1;
    const a3 = 1 / (1 + a2);
    this.biasRate = omega / a1;
    this.massScale = a2 * a3;
    this.impulseScale = a3;
  }

  /** 状態を初期化して再利用する (投擲のやり直し用。巨大な配列は作り直さない) */
  reset(): void {
    this.time = 0;
    this.stepCount = 0;
    this.failed = false;
    this.nC = 0;
    this.asleep.fill(0);
    this.sleepT.fill(0);
    this.vel.fill(0);
    this.ang.fill(0);
    this.wsStamp.fill(-1);
    this.lastEvT.fill(-1);
    this.evBest.fill(0);
    this.rollAcc = 0;
    this.rollSteps = 0;
    const st = this.stats;
    st.steps = 0;
    st.maxContacts = 0;
    st.maxPenetration = 0;
    st.impacts = 0;
    st.bowlImpacts = 0;
    st.diceImpacts = 0;
    this.debugPen = { depth: 0, t: 0, a: -1, b: -1, key: -1, kind: '', speed: 0 };
  }

  setBody(
    i: number,
    p: ArrayLike<number>,
    q: ArrayLike<number>,
    v: ArrayLike<number>,
    w: ArrayLike<number>,
  ): void {
    for (let k = 0; k < 3; k++) {
      this.pos[i * 3 + k] = p[k];
      this.vel[i * 3 + k] = v[k];
      this.ang[i * 3 + k] = w[k];
    }
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    for (let k = 0; k < 4; k++) this.quat[i * 4 + k] = q[k] / l;
    this.asleep[i] = 0;
    this.sleepT[i] = 0;
    this.updateRot(i);
  }

  allAsleep(): boolean {
    for (let i = 0; i < N; i++) if (!this.asleep[i]) return false;
    return true;
  }

  // ------------------------------------------------------------------
  //  メインステップ
  // ------------------------------------------------------------------
  step(): void {
    const h = this.h;
    for (let i = 0; i < N; i++) this.updateRot(i);
    this.detect();
    this.prepare();
    this.integrateVelocities(h);
    this.warmStart();
    for (let it = 0; it < SOLVER_ITERS; it++) this.solve(true, it & 1);
    this.integratePositions(h);
    this.updateRelaxGaps(h);
    for (let it = 0; it < RELAX_ITERS; it++) this.solve(false, it & 1);
    this.applyRestitution();
    this.storeImpulses();
    this.updateSleep(h);
    this.time += h;
    this.stepCount++;
    this.stats.steps++;
    if (this.nC > this.stats.maxContacts) this.stats.maxContacts = this.nC;
    // 数値破綻の検出
    const s = this.pos[0] + this.pos[1] + this.pos[2] + this.vel[0] + this.ang[0];
    if (!Number.isFinite(s)) this.failed = true;
  }

  // ------------------------------------------------------------------
  //  回転行列・頂点
  // ------------------------------------------------------------------
  private updateRot(i: number): void {
    const q = this.quat;
    quatToMat(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3], this.rot, i * 9);
    const R = this.rot;
    const o = i * 9;
    const p = this.pos;
    const vo = i * 24;
    for (let k = 0; k < 8; k++) {
      const lx = VERT_LOCAL[k * 3];
      const ly = VERT_LOCAL[k * 3 + 1];
      const lz = VERT_LOCAL[k * 3 + 2];
      this.verts[vo + k * 3] = p[i * 3] + R[o] * lx + R[o + 1] * ly + R[o + 2] * lz;
      this.verts[vo + k * 3 + 1] = p[i * 3 + 1] + R[o + 3] * lx + R[o + 4] * ly + R[o + 5] * lz;
      this.verts[vo + k * 3 + 2] = p[i * 3 + 2] + R[o + 6] * lx + R[o + 7] * ly + R[o + 8] * lz;
    }
  }

  // ------------------------------------------------------------------
  //  接触検出
  // ------------------------------------------------------------------
  private detect(): void {
    this.nC = 0;
    this.touching.fill(0);
    this.surfTouch.fill(0);
    const bowl = this.bowl;
    const prof = bowl.profile;
    const q = this.q;
    const h = this.h;
    const R = this.rot;
    const P = this.pos;

    // --- サイコロ × お椀/机 ---
    for (let i = 0; i < N; i++) {
      if (this.asleep[i]) continue;
      const o3 = i * 3;
      const cx = P[o3];
      const cy = P[o3 + 1];
      const cz = P[o3 + 2];
      const speed = Math.hypot(this.vel[o3], this.vel[o3 + 1], this.vel[o3 + 2]);
      const wm = Math.hypot(this.ang[o3], this.ang[o3 + 1], this.ang[o3 + 2]);
      let margin = 1.6 * (speed + wm * DIE.boundRadius) * h + 0.0006;
      if (margin > MAX_MARGIN) margin = MAX_MARGIN;
      this.margin[i] = margin;

      bowl.query(cx, cy, cz, q);
      if (q[0] - INNER_DIAG - RHO >= margin) continue;

      const rc = Math.sqrt(cx * cx + cz * cz);
      const dense =
        rc > prof.rimInnerR - 0.022 && cy > prof.rimInnerY - 0.035 && rc < prof.maxR + 0.03;
      const ns = dense ? SAMPLES_DENSE_N : SAMPLES_SPARSE_N;
      const ro = i * 9;
      for (let k = 0; k < ns; k++) {
        const lx = SAMPLES[k * 3];
        const ly = SAMPLES[k * 3 + 1];
        const lz = SAMPLES[k * 3 + 2];
        const px = cx + R[ro] * lx + R[ro + 1] * ly + R[ro + 2] * lz;
        const py = cy + R[ro + 3] * lx + R[ro + 4] * ly + R[ro + 5] * lz;
        const pz = cz + R[ro + 6] * lx + R[ro + 7] * ly + R[ro + 8] * lz;
        bowl.query(px, py, pz, q);
        const gap = q[0] - RHO;
        if (gap >= margin) continue;
        if (this.nC >= MAXC) break;

        const mat = q[4] | 0;
        const c = this.nC++;
        const o = c * CS;
        const F = this.F;
        // 法線は A(サイコロ) → B(固体) 向き = SDF勾配の逆
        const nx = -q[1];
        const ny = -q[2];
        const nz = -q[3];
        const pax = px + RHO * nx;
        const pay = py + RHO * ny;
        const paz = pz + RHO * nz;
        F[o + F_NX] = nx;
        F[o + F_NY] = ny;
        F[o + F_NZ] = nz;
        F[o + F_RAX] = pax - cx;
        F[o + F_RAY] = pay - cy;
        F[o + F_RAZ] = paz - cz;
        F[o + F_RBX] = pax;
        F[o + F_RBY] = pay;
        F[o + F_RBZ] = paz;
        F[o + F_GAP] = gap;
        const sp = SURFACE_PARAMS[mat] ?? SURFACE_PARAMS[MAT_GLAZE];
        F[o + F_FRIC] = sp[0];
        F[o + F_REST] = sp[1];
        F[o + F_PX] = pax;
        F[o + F_PY] = pay;
        F[o + F_PZ] = paz;
        F[o + F_KIND] = mat === MAT_TABLE ? EV_TABLE : mat === MAT_GLAZE ? EV_GLAZE : EV_RIM;
        this.ci[c * 3] = i;
        this.ci[c * 3 + 1] = -1;
        this.ci[c * 3 + 2] = i * 128 + k;
        if (gap < 0) {
          if (-gap > this.stats.maxPenetration) {
            this.stats.maxPenetration = -gap;
            if (-gap > this.debugPen.depth) {
              this.debugPen = { depth: -gap, t: this.time, a: i, b: -1, key: k, kind: 'bowl/mat' + mat, speed };
            }
          }
        }
        if (gap < 0.0005) {
          this.touching[i] = 1;
          this.surfTouch[i] = 1;
        }
      }
    }

    // --- サイコロ × サイコロ ---
    let pairIdx = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++, pairIdx++) {
        if (this.asleep[i] && this.asleep[j]) continue;
        this.detectPair(i, j, pairIdx);
      }
    }
  }

  private pairContact(
    i: number,
    j: number,
    key: number,
    nx: number,
    ny: number,
    nz: number,
    pax: number,
    pay: number,
    paz: number,
    pbx: number,
    pby: number,
    pbz: number,
    gap: number,
  ): void {
    if (this.nC >= MAXC) return;
    const c = this.nC++;
    const o = c * CS;
    const F = this.F;
    const P = this.pos;
    F[o + F_NX] = nx;
    F[o + F_NY] = ny;
    F[o + F_NZ] = nz;
    F[o + F_RAX] = pax - P[i * 3];
    F[o + F_RAY] = pay - P[i * 3 + 1];
    F[o + F_RAZ] = paz - P[i * 3 + 2];
    F[o + F_RBX] = pbx - P[j * 3];
    F[o + F_RBY] = pby - P[j * 3 + 1];
    F[o + F_RBZ] = pbz - P[j * 3 + 2];
    F[o + F_GAP] = gap;
    F[o + F_FRIC] = DICE_DICE_PARAMS[0];
    F[o + F_REST] = DICE_DICE_PARAMS[1];
    F[o + F_PX] = (pax + pbx) * 0.5;
    F[o + F_PY] = (pay + pby) * 0.5;
    F[o + F_PZ] = (paz + pbz) * 0.5;
    F[o + F_KIND] = EV_DICE;
    this.ci[c * 3] = i;
    this.ci[c * 3 + 1] = j;
    this.ci[c * 3 + 2] = key;
    if (gap < 0 && -gap > this.stats.maxPenetration) {
      this.stats.maxPenetration = -gap;
      if (-gap > this.debugPen.depth) {
        this.debugPen = { depth: -gap, t: this.time, a: i, b: j, key, kind: 'pair', speed: 0 };
      }
    }
    if (gap < 0.0005) {
      this.touching[i] = 1;
      this.touching[j] = 1;
    }
  }

  /** 2個のサイコロの接触を作る (内箱の最短距離 − 2ρ) */
  private detectPair(i: number, j: number, pairIdx: number): void {
    const P = this.pos;
    const ai = i * 3;
    const aj = j * 3;
    const cax = P[ai];
    const cay = P[ai + 1];
    const caz = P[ai + 2];
    const cbx = P[aj];
    const cby = P[aj + 1];
    const cbz = P[aj + 2];
    const dx = cbx - cax;
    const dy = cby - cay;
    const dz = cbz - caz;
    const margin = Math.max(this.margin[i], this.margin[j], 0.0006);
    const reach = 2 * DIE.boundRadius + margin;
    if (dx * dx + dy * dy + dz * dz > reach * reach) return;

    // 片方が眠っていて、もう片方が動いて近づいてきたら起こす
    if (this.asleep[i] !== this.asleep[j]) {
      const k = this.asleep[i] ? j : i;
      const sp = Math.hypot(this.vel[k * 3], this.vel[k * 3 + 1], this.vel[k * 3 + 2]);
      const wm = Math.hypot(this.ang[k * 3], this.ang[k * 3 + 1], this.ang[k * 3 + 2]);
      if (sp > 0.05 || wm > 1.0) {
        const s = this.asleep[i] ? i : j;
        this.asleep[s] = 0;
        this.sleepT[s] = 0;
        this.margin[s] = 0.0006;
      }
    }

    const Ra = this.rot;
    const oa = i * 9;
    const ob = j * 9;
    const D = 2 * RHO + margin;

    // --- 分離軸の早期棄却 (内箱 6軸) ---
    // M[a][b] = 軸A_a · 軸B_b
    const m00 = Ra[oa] * Ra[ob] + Ra[oa + 3] * Ra[ob + 3] + Ra[oa + 6] * Ra[ob + 6];
    const m01 = Ra[oa] * Ra[ob + 1] + Ra[oa + 3] * Ra[ob + 4] + Ra[oa + 6] * Ra[ob + 7];
    const m02 = Ra[oa] * Ra[ob + 2] + Ra[oa + 3] * Ra[ob + 5] + Ra[oa + 6] * Ra[ob + 8];
    const m10 = Ra[oa + 1] * Ra[ob] + Ra[oa + 4] * Ra[ob + 3] + Ra[oa + 7] * Ra[ob + 6];
    const m11 = Ra[oa + 1] * Ra[ob + 1] + Ra[oa + 4] * Ra[ob + 4] + Ra[oa + 7] * Ra[ob + 7];
    const m12 = Ra[oa + 1] * Ra[ob + 2] + Ra[oa + 4] * Ra[ob + 5] + Ra[oa + 7] * Ra[ob + 8];
    const m20 = Ra[oa + 2] * Ra[ob] + Ra[oa + 5] * Ra[ob + 3] + Ra[oa + 8] * Ra[ob + 6];
    const m21 = Ra[oa + 2] * Ra[ob + 1] + Ra[oa + 5] * Ra[ob + 4] + Ra[oa + 8] * Ra[ob + 7];
    const m22 = Ra[oa + 2] * Ra[ob + 2] + Ra[oa + 5] * Ra[ob + 5] + Ra[oa + 8] * Ra[ob + 8];
    const ta0 = dx * Ra[oa] + dy * Ra[oa + 3] + dz * Ra[oa + 6];
    const ta1 = dx * Ra[oa + 1] + dy * Ra[oa + 4] + dz * Ra[oa + 7];
    const ta2 = dx * Ra[oa + 2] + dy * Ra[oa + 5] + dz * Ra[oa + 8];
    if (Math.abs(ta0) - B_IN * (1 + Math.abs(m00) + Math.abs(m01) + Math.abs(m02)) > D) return;
    if (Math.abs(ta1) - B_IN * (1 + Math.abs(m10) + Math.abs(m11) + Math.abs(m12)) > D) return;
    if (Math.abs(ta2) - B_IN * (1 + Math.abs(m20) + Math.abs(m21) + Math.abs(m22)) > D) return;
    const tb0 = dx * Ra[ob] + dy * Ra[ob + 3] + dz * Ra[ob + 6];
    const tb1 = dx * Ra[ob + 1] + dy * Ra[ob + 4] + dz * Ra[ob + 7];
    const tb2 = dx * Ra[ob + 2] + dy * Ra[ob + 5] + dz * Ra[ob + 8];
    if (Math.abs(tb0) - B_IN * (1 + Math.abs(m00) + Math.abs(m10) + Math.abs(m20)) > D) return;
    if (Math.abs(tb1) - B_IN * (1 + Math.abs(m01) + Math.abs(m11) + Math.abs(m21)) > D) return;
    if (Math.abs(tb2) - B_IN * (1 + Math.abs(m02) + Math.abs(m12) + Math.abs(m22)) > D) return;

    const keyBase = BOWL_KEYS + pairIdx * PAIR_KEYS;
    const V = this.verts;

    // --- 頂点 × 箱 ---  dir=0: Aの頂点 vs 箱B / dir=1: Bの頂点 vs 箱A
    for (let dir = 0; dir < 2; dir++) {
      const vi = dir === 0 ? i : j; // 頂点側
      const bi = dir === 0 ? j : i; // 箱側
      const ob2 = bi * 9;
      const cbx2 = P[bi * 3];
      const cby2 = P[bi * 3 + 1];
      const cbz2 = P[bi * 3 + 2];
      for (let k = 0; k < 8; k++) {
        const vx = V[vi * 24 + k * 3];
        const vy = V[vi * 24 + k * 3 + 1];
        const vz = V[vi * 24 + k * 3 + 2];
        const rx = vx - cbx2;
        const ry = vy - cby2;
        const rz = vz - cbz2;
        // 箱ローカル座標
        let l0 = rx * Ra[ob2] + ry * Ra[ob2 + 3] + rz * Ra[ob2 + 6];
        let l1 = rx * Ra[ob2 + 1] + ry * Ra[ob2 + 4] + rz * Ra[ob2 + 7];
        let l2 = rx * Ra[ob2 + 2] + ry * Ra[ob2 + 5] + rz * Ra[ob2 + 8];
        const code0 = l0 < -B_IN ? 0 : l0 > B_IN ? 2 : 1;
        const code1 = l1 < -B_IN ? 0 : l1 > B_IN ? 2 : 1;
        const code2 = l2 < -B_IN ? 0 : l2 > B_IN ? 2 : 1;
        const code = code0 + code1 * 3 + code2 * 9;
        const key = keyBase + dir * 216 + k * 27 + code;
        if (code === 13) {
          // 頂点が箱の内部: 最も浅く抜けられる面を選ぶ (深い貫入の保険)
          const d0 = B_IN - Math.abs(l0);
          const d1 = B_IN - Math.abs(l1);
          const d2 = B_IN - Math.abs(l2);
          let ax = 0;
          let dep = d0;
          if (d1 < dep) {
            ax = 1;
            dep = d1;
          }
          if (d2 < dep) {
            ax = 2;
            dep = d2;
          }
          const sgn = (ax === 0 ? l0 : ax === 1 ? l1 : l2) >= 0 ? 1 : -1;
          // 箱から見て外向き e = sgn·軸  (頂点側はこの向きへ出る)
          const ex = sgn * Ra[ob2 + ax];
          const ey = sgn * Ra[ob2 + 3 + ax];
          const ez = sgn * Ra[ob2 + 6 + ax];
          // n は A→B。dir=0 (頂点がA側): A は +e へ出る → n = -e
          const s = dir === 0 ? -1 : 1;
          this.pairContact(i, j, key, s * ex, s * ey, s * ez, vx, vy, vz, vx, vy, vz, -(dep + 2 * RHO));
          continue;
        }
        if (l0 < -B_IN) l0 = -B_IN;
        else if (l0 > B_IN) l0 = B_IN;
        if (l1 < -B_IN) l1 = -B_IN;
        else if (l1 > B_IN) l1 = B_IN;
        if (l2 < -B_IN) l2 = -B_IN;
        else if (l2 > B_IN) l2 = B_IN;
        const qx = cbx2 + Ra[ob2] * l0 + Ra[ob2 + 1] * l1 + Ra[ob2 + 2] * l2;
        const qy = cby2 + Ra[ob2 + 3] * l0 + Ra[ob2 + 4] * l1 + Ra[ob2 + 5] * l2;
        const qz = cbz2 + Ra[ob2 + 6] * l0 + Ra[ob2 + 7] * l1 + Ra[ob2 + 8] * l2;
        const ex = qx - vx; // 頂点 → 箱の最近接点
        const ey = qy - vy;
        const ez = qz - vz;
        const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (dist >= D) continue;
        const gap = dist - 2 * RHO;
        const inv = dist > 1e-12 ? 1 / dist : 0;
        if (dir === 0) {
          // 頂点(A) → 箱(B): n(A→B) = 向きそのまま
          const nx = ex * inv;
          const ny = ey * inv;
          const nz = ez * inv;
          this.pairContact(i, j, key, nx, ny, nz, vx + RHO * nx, vy + RHO * ny, vz + RHO * nz, qx - RHO * nx, qy - RHO * ny, qz - RHO * nz, gap);
        } else {
          // 頂点(B) → 箱(A): n(A→B) = 逆向き
          const nx = -ex * inv;
          const ny = -ey * inv;
          const nz = -ez * inv;
          this.pairContact(i, j, key, nx, ny, nz, qx + RHO * nx, qy + RHO * ny, qz + RHO * nz, vx - RHO * nx, vy - RHO * ny, vz - RHO * nz, gap);
        }
      }
    }

    // --- 辺 × 辺 (交差する辺の内部どうしの最近点) ---
    for (let ea = 0; ea < 12; ea++) {
      const a0 = EDGE_A[ea] * 3;
      const a1 = EDGE_B[ea] * 3;
      const p1x = V[i * 24 + a0];
      const p1y = V[i * 24 + a0 + 1];
      const p1z = V[i * 24 + a0 + 2];
      const d1x = V[i * 24 + a1] - p1x;
      const d1y = V[i * 24 + a1 + 1] - p1y;
      const d1z = V[i * 24 + a1 + 2] - p1z;
      const aa = d1x * d1x + d1y * d1y + d1z * d1z;
      for (let eb = 0; eb < 12; eb++) {
        const b0 = EDGE_A[eb] * 3;
        const b1 = EDGE_B[eb] * 3;
        const p2x = V[j * 24 + b0];
        const p2y = V[j * 24 + b0 + 1];
        const p2z = V[j * 24 + b0 + 2];
        const d2x = V[j * 24 + b1] - p2x;
        const d2y = V[j * 24 + b1 + 1] - p2y;
        const d2z = V[j * 24 + b1 + 2] - p2z;
        const ee = d2x * d2x + d2y * d2y + d2z * d2z;
        const bb = d1x * d2x + d1y * d2y + d1z * d2z;
        const denom = aa * ee - bb * bb;
        if (denom < 1e-3 * aa * ee) continue; // ほぼ平行 (頂点-面で拾える)
        const rx = p1x - p2x;
        const ry = p1y - p2y;
        const rz = p1z - p2z;
        const cc = d1x * rx + d1y * ry + d1z * rz;
        const ff = d2x * rx + d2y * ry + d2z * rz;
        const s = (bb * ff - cc * ee) / denom;
        const t = (aa * ff - bb * cc) / denom;
        if (s <= 0.001 || s >= 0.999 || t <= 0.001 || t >= 0.999) continue;
        const qax = p1x + s * d1x;
        const qay = p1y + s * d1y;
        const qaz = p1z + s * d1z;
        const qbx = p2x + t * d2x;
        const qby = p2y + t * d2y;
        const qbz = p2z + t * d2z;
        const ex = qbx - qax;
        const ey = qby - qay;
        const ez = qbz - qaz;
        const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (dist >= D || dist < 1e-9) continue;
        const inv = 1 / dist;
        const nx = ex * inv;
        const ny = ey * inv;
        const nz = ez * inv;
        // 向きの健全性: A→B 方向であること
        if (nx * dx + ny * dy + nz * dz <= 0) continue;
        this.pairContact(
          i,
          j,
          keyBase + 432 + ea * 12 + eb,
          nx,
          ny,
          nz,
          qax + RHO * nx,
          qay + RHO * ny,
          qaz + RHO * nz,
          qbx - RHO * nx,
          qby - RHO * ny,
          qbz - RHO * nz,
          dist - 2 * RHO,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  //  接触の準備
  // ------------------------------------------------------------------
  private prepare(): void {
    const F = this.F;
    const ci = this.ci;
    const V = this.vel;
    const W = this.ang;
    const stamp = this.stepCount;
    for (let c = 0; c < this.nC; c++) {
      const o = c * CS;
      const A = ci[c * 3];
      const B = ci[c * 3 + 1];
      const imA = this.asleep[A] ? 0 : DIE_INV_MASS;
      const iiA = this.asleep[A] ? 0 : DIE_INV_INERTIA;
      const imB = B >= 0 && !this.asleep[B] ? DIE_INV_MASS : 0;
      const iiB = B >= 0 && !this.asleep[B] ? DIE_INV_INERTIA : 0;
      F[o + F_IMA] = imA;
      F[o + F_IIA] = iiA;
      F[o + F_IMB] = imB;
      F[o + F_IIB] = iiB;

      const nx = F[o + F_NX];
      const ny = F[o + F_NY];
      const nz = F[o + F_NZ];
      // 接線基底
      let t1x: number;
      let t1y: number;
      let t1z: number;
      if (Math.abs(nx) < 0.9) {
        // n × (1,0,0) = (0, nz, -ny)
        t1x = 0;
        t1y = nz;
        t1z = -ny;
      } else {
        // n × (0,1,0) = (-nz, 0, nx)
        t1x = -nz;
        t1y = 0;
        t1z = nx;
      }
      const tl = 1 / Math.sqrt(t1x * t1x + t1y * t1y + t1z * t1z);
      t1x *= tl;
      t1y *= tl;
      t1z *= tl;
      const t2x = ny * t1z - nz * t1y;
      const t2y = nz * t1x - nx * t1z;
      const t2z = nx * t1y - ny * t1x;
      F[o + F_T1X] = t1x;
      F[o + F_T1Y] = t1y;
      F[o + F_T1Z] = t1z;
      F[o + F_T2X] = t2x;
      F[o + F_T2Y] = t2y;
      F[o + F_T2Z] = t2z;

      const rax = F[o + F_RAX];
      const ray = F[o + F_RAY];
      const raz = F[o + F_RAZ];
      const rbx = F[o + F_RBX];
      const rby = F[o + F_RBY];
      const rbz = F[o + F_RBZ];
      F[o + F_MN] = effMass(imA, iiA, imB, iiB, rax, ray, raz, rbx, rby, rbz, nx, ny, nz);
      F[o + F_MT1] = effMass(imA, iiA, imB, iiB, rax, ray, raz, rbx, rby, rbz, t1x, t1y, t1z);
      F[o + F_MT2] = effMass(imA, iiA, imB, iiB, rax, ray, raz, rbx, rby, rbz, t2x, t2y, t2z);

      // 事前相対速度
      const ao = A * 3;
      let dvx = -(V[ao] + (W[ao + 1] * raz - W[ao + 2] * ray));
      let dvy = -(V[ao + 1] + (W[ao + 2] * rax - W[ao] * raz));
      let dvz = -(V[ao + 2] + (W[ao] * ray - W[ao + 1] * rax));
      if (B >= 0) {
        const bo = B * 3;
        dvx += V[bo] + (W[bo + 1] * rbz - W[bo + 2] * rby);
        dvy += V[bo + 1] + (W[bo + 2] * rbx - W[bo] * rbz);
        dvz += V[bo + 2] + (W[bo] * rby - W[bo + 1] * rbx);
      }
      F[o + F_REL0] = dvx * nx + dvy * ny + dvz * nz;
      F[o + F_MAXJN] = 0;
      F[o + F_JNS] = 0;

      // ウォームスタート
      const key = ci[c * 3 + 2];
      if (this.wsStamp[key] === stamp) {
        const px = this.wsX[key];
        const py = this.wsY[key];
        const pz = this.wsZ[key];
        F[o + F_JN] = Math.max(0, px * nx + py * ny + pz * nz);
        F[o + F_JT1] = px * t1x + py * t1y + pz * t1z;
        F[o + F_JT2] = px * t2x + py * t2y + pz * t2z;
      } else {
        F[o + F_JN] = 0;
        F[o + F_JT1] = 0;
        F[o + F_JT2] = 0;
      }
    }
  }

  private integrateVelocities(h: number): void {
    const V = this.vel;
    for (let i = 0; i < N; i++) {
      if (this.asleep[i]) continue;
      V[i * 3 + 1] -= GRAVITY * h;
    }
  }

  /** 接触 c に世界座標インパルス P を適用 (A は -P, B は +P) */
  private applyImpulse(c: number, px: number, py: number, pz: number): void {
    const F = this.F;
    const o = c * CS;
    const A = this.ci[c * 3];
    const B = this.ci[c * 3 + 1];
    const V = this.vel;
    const W = this.ang;
    const imA = F[o + F_IMA];
    const iiA = F[o + F_IIA];
    const ao = A * 3;
    const rax = F[o + F_RAX];
    const ray = F[o + F_RAY];
    const raz = F[o + F_RAZ];
    V[ao] -= imA * px;
    V[ao + 1] -= imA * py;
    V[ao + 2] -= imA * pz;
    W[ao] -= iiA * (ray * pz - raz * py);
    W[ao + 1] -= iiA * (raz * px - rax * pz);
    W[ao + 2] -= iiA * (rax * py - ray * px);
    if (B >= 0) {
      const imB = F[o + F_IMB];
      const iiB = F[o + F_IIB];
      const bo = B * 3;
      const rbx = F[o + F_RBX];
      const rby = F[o + F_RBY];
      const rbz = F[o + F_RBZ];
      V[bo] += imB * px;
      V[bo + 1] += imB * py;
      V[bo + 2] += imB * pz;
      W[bo] += iiB * (rby * pz - rbz * py);
      W[bo + 1] += iiB * (rbz * px - rbx * pz);
      W[bo + 2] += iiB * (rbx * py - rby * px);
    }
  }

  private warmStart(): void {
    const F = this.F;
    for (let c = 0; c < this.nC; c++) {
      const o = c * CS;
      const jn = F[o + F_JN];
      const j1 = F[o + F_JT1];
      const j2 = F[o + F_JT2];
      if (jn === 0 && j1 === 0 && j2 === 0) continue;
      this.applyImpulse(
        c,
        jn * F[o + F_NX] + j1 * F[o + F_T1X] + j2 * F[o + F_T2X],
        jn * F[o + F_NY] + j1 * F[o + F_T1Y] + j2 * F[o + F_T2Y],
        jn * F[o + F_NZ] + j1 * F[o + F_T1Z] + j2 * F[o + F_T2Z],
      );
    }
  }

  /** 接触点での相対速度 (B - A) を out へ */
  private relVel(c: number, out: Float64Array): void {
    const F = this.F;
    const o = c * CS;
    const A = this.ci[c * 3];
    const B = this.ci[c * 3 + 1];
    const V = this.vel;
    const W = this.ang;
    const ao = A * 3;
    const rax = F[o + F_RAX];
    const ray = F[o + F_RAY];
    const raz = F[o + F_RAZ];
    out[0] = -(V[ao] + (W[ao + 1] * raz - W[ao + 2] * ray));
    out[1] = -(V[ao + 1] + (W[ao + 2] * rax - W[ao] * raz));
    out[2] = -(V[ao + 2] + (W[ao] * ray - W[ao + 1] * rax));
    if (B >= 0) {
      const bo = B * 3;
      const rbx = F[o + F_RBX];
      const rby = F[o + F_RBY];
      const rbz = F[o + F_RBZ];
      out[0] += V[bo] + (W[bo + 1] * rbz - W[bo + 2] * rby);
      out[1] += V[bo + 1] + (W[bo + 2] * rbx - W[bo] * rbz);
      out[2] += V[bo + 2] + (W[bo] * rby - W[bo + 1] * rbx);
    }
  }

  private dv = new Float64Array(3);

  private solve(useBias: boolean, reverse: number): void {
    const F = this.F;
    const dv = this.dv;
    const nC = this.nC;
    const invH = this.invH;
    for (let n = 0; n < nC; n++) {
      const c = reverse ? nC - 1 - n : n;
      const o = c * CS;
      const nx = F[o + F_NX];
      const ny = F[o + F_NY];
      const nz = F[o + F_NZ];

      // ---- 摩擦 (先に解き、法線拘束を最後にして貫入を優先) ----
      {
        this.relVel(c, dv);
        const t1x = F[o + F_T1X];
        const t1y = F[o + F_T1Y];
        const t1z = F[o + F_T1Z];
        const t2x = F[o + F_T2X];
        const t2y = F[o + F_T2Y];
        const t2z = F[o + F_T2Z];
        const vt1 = dv[0] * t1x + dv[1] * t1y + dv[2] * t1z;
        const vt2 = dv[0] * t2x + dv[1] * t2y + dv[2] * t2z;
        let a1 = F[o + F_JT1];
        let a2 = F[o + F_JT2];
        const n1 = a1 - F[o + F_MT1] * vt1;
        const n2 = a2 - F[o + F_MT2] * vt2;
        let m1 = n1;
        let m2 = n2;
        const maxF = F[o + F_FRIC] * F[o + F_JN];
        const len = Math.sqrt(m1 * m1 + m2 * m2);
        if (len > maxF) {
          const s = len > 1e-18 ? maxF / len : 0;
          m1 *= s;
          m2 *= s;
        }
        const d1 = m1 - a1;
        const d2 = m2 - a2;
        a1 = m1;
        a2 = m2;
        F[o + F_JT1] = a1;
        F[o + F_JT2] = a2;
        if (d1 !== 0 || d2 !== 0) {
          // 摩擦はA側にもB側にも接線方向の対称インパルスとして与える
          this.applyImpulse(c, d1 * t1x + d2 * t2x, d1 * t1y + d2 * t2y, d1 * t1z + d2 * t2z);
        }
      }

      // ---- 法線 (非貫通) ----
      {
        this.relVel(c, dv);
        const vn = dv[0] * nx + dv[1] * ny + dv[2] * nz;
        const s = useBias ? F[o + F_GAP] : F[o + F_GAPR];
        let bias = 0;
        let massScale = 1;
        let impulseScale = 0;
        if (s > 0) {
          bias = s * invH; // 投機的接触: 1ステップで接地するまでの接近は許す
        } else if (useBias) {
          const pen = s + SLOP;
          if (pen < 0) bias = Math.max(this.biasRate * pen, -MAX_BIAS);
          massScale = this.massScale;
          impulseScale = this.impulseScale;
        }
        const jn = F[o + F_JN];
        let dj = -F[o + F_MN] * massScale * (vn + bias) - impulseScale * jn;
        const nj = Math.max(jn + dj, 0);
        dj = nj - jn;
        F[o + F_JN] = nj;
        if (nj > F[o + F_MAXJN]) F[o + F_MAXJN] = nj;
        if (dj !== 0) this.applyImpulse(c, dj * nx, dj * ny, dj * nz);
      }
    }
  }

  private integratePositions(h: number): void {
    const P = this.pos;
    const V = this.vel;
    const W = this.ang;
    const Q = this.quat;
    for (let i = 0; i < N; i++) {
      if (this.asleep[i]) continue;
      const o3 = i * 3;
      // 安全上限
      const sp = Math.hypot(V[o3], V[o3 + 1], V[o3 + 2]);
      if (sp > MAX_LINEAR_SPEED) {
        const s = MAX_LINEAR_SPEED / sp;
        V[o3] *= s;
        V[o3 + 1] *= s;
        V[o3 + 2] *= s;
      }
      const wm = Math.hypot(W[o3], W[o3 + 1], W[o3 + 2]);
      if (wm > MAX_ANGULAR_SPEED) {
        const s = MAX_ANGULAR_SPEED / wm;
        W[o3] *= s;
        W[o3 + 1] *= s;
        W[o3 + 2] *= s;
      }
      P[o3] += V[o3] * h;
      P[o3 + 1] += V[o3 + 1] * h;
      P[o3 + 2] += V[o3 + 2] * h;
      const wmag = Math.hypot(W[o3], W[o3 + 1], W[o3 + 2]);
      if (wmag > 1e-9) {
        const half = 0.5 * wmag * h;
        const s = Math.sin(half) / wmag;
        const dx = W[o3] * s;
        const dy = W[o3 + 1] * s;
        const dz = W[o3 + 2] * s;
        const dw = Math.cos(half);
        const o4 = i * 4;
        const qx = Q[o4];
        const qy = Q[o4 + 1];
        const qz = Q[o4 + 2];
        const qw = Q[o4 + 3];
        let nx = dw * qx + dx * qw + dy * qz - dz * qy;
        let ny = dw * qy - dx * qz + dy * qw + dz * qx;
        let nz = dw * qz + dx * qy - dy * qx + dz * qw;
        let nw = dw * qw - dx * qx - dy * qy - dz * qz;
        const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
        nx *= l;
        ny *= l;
        nz *= l;
        nw *= l;
        Q[o4] = nx;
        Q[o4 + 1] = ny;
        Q[o4 + 2] = nz;
        Q[o4 + 3] = nw;
      }
    }
  }

  /** 位置更新後の隙間 (一次近似: 隙間 + h·法線相対速度) */
  private updateRelaxGaps(h: number): void {
    const F = this.F;
    const dv = this.dv;
    for (let c = 0; c < this.nC; c++) {
      const o = c * CS;
      this.relVel(c, dv);
      const vn = dv[0] * F[o + F_NX] + dv[1] * F[o + F_NY] + dv[2] * F[o + F_NZ];
      F[o + F_GAPR] = F[o + F_GAP] + h * vn;
    }
  }

  /**
   * 反発の適用。面と面のような多点接触では1パスでは収束しないので、
   * 全接触点の接近速度が同時に e·(衝突前速度) になるまで反復する。
   */
  private applyRestitution(): void {
    const F = this.F;
    const dv = this.dv;
    this.evBest.fill(0);
    for (let c = 0; c < this.nC; c++) {
      const o = c * CS;
      // ウォームスタート用に、反発前の最終インパルスを控える (反発インパルスは含めない)
      F[o + F_JNS] = F[o + F_JN];
      const rel0 = F[o + F_REL0];
      const jmax = F[o + F_MAXJN];
      if (jmax > 0 && rel0 < -EVENT_MIN) this.noteImpact(c, -rel0);
    }
    const nC = this.nC;
    for (let it = 0; it < RESTITUTION_ITERS; it++) {
      let any = false;
      for (let n = 0; n < nC; n++) {
        const c = it & 1 ? nC - 1 - n : n;
        const o = c * CS;
        const rel0 = F[o + F_REL0];
        if (rel0 > -REST_THRESHOLD || F[o + F_MAXJN] === 0) continue;
        any = true;
        const e = F[o + F_REST];
        this.relVel(c, dv);
        const nx = F[o + F_NX];
        const ny = F[o + F_NY];
        const nz = F[o + F_NZ];
        const vn = dv[0] * nx + dv[1] * ny + dv[2] * nz;
        let dj = -F[o + F_MN] * (vn + e * rel0);
        const jn = F[o + F_JN];
        const nj = Math.max(jn + dj, 0);
        dj = nj - jn;
        F[o + F_JN] = nj;
        if (dj !== 0) this.applyImpulse(c, dj * nx, dj * ny, dj * nz);
      }
      if (!any) break;
    }
    this.flushImpacts();
  }

  private noteImpact(c: number, intensity: number): void {
    const F = this.F;
    const o = c * CS;
    const A = this.ci[c * 3];
    const B = this.ci[c * 3 + 1];
    const kind = F[o + F_KIND] | 0;
    const slot = A * 4 + kind;
    if (intensity > this.evBest[slot]) {
      this.evBest[slot] = intensity;
      this.evPos[slot * 3] = F[o + F_PX];
      this.evPos[slot * 3 + 1] = F[o + F_PY];
      this.evPos[slot * 3 + 2] = F[o + F_PZ];
      this.evOther[slot] = B;
    }
  }

  private flushImpacts(): void {
    for (let slot = 0; slot < N * 4; slot++) {
      const inten = this.evBest[slot];
      if (inten <= 0) continue;
      const kind = slot & 3;
      const a = slot >> 2;
      const last = this.lastEvT[slot];
      // 同じサイコロ・同じ種別の連打は 12ms あけるが、明らかに強い衝撃は通す
      if (last >= 0 && this.time - last < 0.012 && inten < 1.8) continue;
      this.lastEvT[slot] = this.time;
      this.stats.impacts++;
      if (kind === EV_DICE) this.stats.diceImpacts++;
      else this.stats.bowlImpacts++;
      if (this.eventSink) {
        this.eventSink({
          t: this.time,
          kind,
          intensity: inten,
          x: this.evPos[slot * 3],
          y: this.evPos[slot * 3 + 1],
          z: this.evPos[slot * 3 + 2],
          a,
          b: this.evOther[slot],
        });
      }
    }
  }

  private storeImpulses(): void {
    const F = this.F;
    const stamp = this.stepCount + 1;
    for (let c = 0; c < this.nC; c++) {
      const o = c * CS;
      const jn = F[o + F_JNS];
      const j1 = F[o + F_JT1];
      const j2 = F[o + F_JT2];
      const key = this.ci[c * 3 + 2];
      this.wsX[key] = jn * F[o + F_NX] + j1 * F[o + F_T1X] + j2 * F[o + F_T2X];
      this.wsY[key] = jn * F[o + F_NY] + j1 * F[o + F_T1Y] + j2 * F[o + F_T2Y];
      this.wsZ[key] = jn * F[o + F_NZ] + j1 * F[o + F_T1Z] + j2 * F[o + F_T2Z];
      this.wsStamp[key] = stamp;
    }
  }

  private updateSleep(h: number): void {
    const V = this.vel;
    const W = this.ang;
    let roll = 0;
    for (let i = 0; i < N; i++) {
      if (this.asleep[i]) continue;
      const o3 = i * 3;
      const sp = Math.hypot(V[o3], V[o3 + 1], V[o3 + 2]);
      const wm = Math.hypot(W[o3], W[o3 + 1], W[o3 + 2]);
      if (this.surfTouch[i]) roll += sp;
      if (this.touching[i] && sp < SLEEP_LINEAR && wm < SLEEP_ANGULAR) {
        this.sleepT[i] += h;
        if (this.sleepT[i] >= SLEEP_TIME) {
          this.asleep[i] = 1;
          V[o3] = V[o3 + 1] = V[o3 + 2] = 0;
          W[o3] = W[o3 + 1] = W[o3 + 2] = 0;
        }
      } else {
        this.sleepT[i] = 0;
      }
    }
    this.rollAcc += roll;
    this.rollSteps++;
  }

  /** サイコロ i の回転行列の参照 (行優先 9要素, オフセット) */
  rotationOf(i: number): { arr: Float64Array; off: number } {
    this.updateRot(i);
    return { arr: this.rot, off: i * 9 };
  }
}

/** 接触の有効質量 (等方慣性) */
function effMass(
  imA: number,
  iiA: number,
  imB: number,
  iiB: number,
  rax: number,
  ray: number,
  raz: number,
  rbx: number,
  rby: number,
  rbz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const cax = ray * dz - raz * dy;
  const cay = raz * dx - rax * dz;
  const caz = rax * dy - ray * dx;
  const cbx = rby * dz - rbz * dy;
  const cby = rbz * dx - rbx * dz;
  const cbz = rbx * dy - rby * dx;
  const k = imA + imB + iiA * (cax * cax + cay * cay + caz * caz) + iiB * (cbx * cbx + cby * cby + cbz * cbz);
  return k > 0 ? 1 / k : 0;
}

