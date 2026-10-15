/**
 * 投擲の初期条件
 *
 * 5個のサイコロを手に握って、お椀の上から投げ入れる動作を模擬する。
 * ランダムなのは「手の位置・高さ・狙い・強さ・各サイコロの位置/向き/回転」だけで、
 * 目は物理シミュレーションの結果として決まる。
 */
import { DICE_COUNT, DIE, GRAVITY } from './constants';
import { BowlModel } from './bowlModel';
import { Prng } from './rng';

export interface DieInit {
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  w: [number, number, number];
}

export interface ThrowSpec {
  dice: DieInit[];
  /** 手の位置 (サイコロ群の中心) */
  hand: [number, number, number];
  /** 強さ係数 (0.6〜1.4 が通常) */
  strength: number;
  /** 「ションベン狙い」の投擲か */
  wild: boolean;
  /** 勢いよく投げ出される(椀外へ出やすい)サイコロ。通常投擲は -1 */
  wildDie: number;
}

/**
 * 投げ方の分布。
 *  - drop : お椀の真上から落とす (ほぼ垂直)
 *  - toss : お椀の縁の上から斜めに放り込み、対岸の壁に当ててカラカラ回す (実際のチンチロの投げ方)
 */
export const THROW_STYLE = {
  /** toss になる確率 */
  tossProb: 0.7,
  /** toss の手の位置 (お椀の中心からの水平距離 [m]) */
  tossHandDist: [0.06, 0.105] as [number, number],
  /** toss の手の高さ (机から) [m] */
  tossHandY: [0.115, 0.17] as [number, number],
  /** toss の狙い位置: 中心からの距離 [m] */
  tossAimR: [0.0, 0.05] as [number, number],
  /** toss の狙いの向き: 手と反対側(向こう岸)からのずれ [rad] */
  tossAimSpread: 1.0,
  /** toss の速度倍率 (1.0 = ちょうど狙いに着地。大きいほど突っ込み気味) */
  tossOvershoot: [0.8, 1.2] as [number, number],
  /** toss の上下速度 [m/s] */
  tossVy: [-0.5, 0.45] as [number, number],
  /** ションベン狙い(椀外へ飛び出す1個): 放り上げ(lob) の水平/上向き速度 [m/s] */
  wildLobH: [0.5, 1.1] as [number, number],
  wildLobV: [0.6, 1.7] as [number, number],
  /** ションベン狙い: 叩きつけ(slam) の水平/下向き速度 [m/s] */
  wildSlamH: [0.4, 1.3] as [number, number],
  wildSlamV: [1.2, 3.0] as [number, number],
};

/** 5個を互いに重ならないように手の中へ配置 */
function packDice(rng: Prng, out: [number, number, number][]): void {
  const minDist = 0.031;
  let radius = 0.017;
  for (let attempt = 0; attempt < 800; attempt++) {
    if (attempt % 100 === 99) radius += 0.004;
    out.length = 0;
    let ok = true;
    for (let i = 0; i < DICE_COUNT && ok; i++) {
      let placed = false;
      for (let t = 0; t < 60 && !placed; t++) {
        // 球内で一様
        const u = rng.float();
        const r = radius * Math.cbrt(u);
        const v: number[] = [0, 0, 0];
        rng.unitVector(v);
        const p: [number, number, number] = [v[0] * r, v[1] * r * 0.8, v[2] * r];
        let clear = true;
        for (const o of out) {
          const dx = p[0] - o[0];
          const dy = p[1] - o[1];
          const dz = p[2] - o[2];
          if (dx * dx + dy * dy + dz * dz < minDist * minDist) {
            clear = false;
            break;
          }
        }
        if (clear) {
          out.push(p);
          placed = true;
        }
      }
      if (!placed) ok = false;
    }
    if (ok) return;
  }
  // 最後の手段: 一直線に並べる
  out.length = 0;
  for (let i = 0; i < DICE_COUNT; i++) out.push([(i - 2) * 0.034, 0, 0]);
}

/**
 * @param wild true のとき、1個を強い横速度で投げ出して椀外へ飛び出しやすくする
 */
export function makeThrow(rng: Prng, bowl: BowlModel, wild: boolean): ThrowSpec {
  const prof = bowl.profile;
  const floorTop = prof.spec.yFloor + DIE.half;

  const style = THROW_STYLE;
  // ションベン狙いのときは、他のサイコロはお椀の真上から落とす
  const toss = !wild && rng.float() < style.tossProb;
  const strength = rng.range(0.6, 1.4);

  let handY: number;
  let hx: number;
  let hz: number;
  let vx: number;
  let vz: number;
  let vy0: number;
  if (toss) {
    // --- 縁の上から、お椀の中の狙い位置へ放物線で放り込む ---
    handY = rng.range(style.tossHandY[0], style.tossHandY[1]);
    const hd = rng.range(style.tossHandDist[0], style.tossHandDist[1]);
    const ha = rng.range(0, Math.PI * 2);
    hx = hd * Math.cos(ha);
    hz = hd * Math.sin(ha);
    // 狙いは「手と反対側」寄り (向こう岸の壁に当てて回す)
    const aimA = ha + Math.PI + rng.range(-style.tossAimSpread, style.tossAimSpread);
    const aimR = rng.range(style.tossAimR[0], style.tossAimR[1]);
    const tx = aimR * Math.cos(aimA);
    const tz = aimR * Math.sin(aimA);
    vy0 = rng.range(style.tossVy[0], style.tossVy[1]);
    const drop = handY - floorTop;
    const tf = (vy0 + Math.sqrt(vy0 * vy0 + 2 * GRAVITY * drop)) / GRAVITY;
    const f = rng.range(style.tossOvershoot[0], style.tossOvershoot[1]) * (0.88 + 0.2 * strength);
    vx = ((tx - hx) / tf) * f;
    vz = ((tz - hz) / tf) * f;
  } else {
    // --- 真上から落とす ---
    handY = rng.range(0.15, 0.215);
    const hr = Math.sqrt(rng.float()) * 0.03;
    const ha = rng.range(0, Math.PI * 2);
    hx = hr * Math.cos(ha);
    hz = hr * Math.sin(ha);
    const aimR = Math.sqrt(rng.float()) * 0.026;
    const aimA = rng.range(0, Math.PI * 2);
    const tx = aimR * Math.cos(aimA);
    const tz = aimR * Math.sin(aimA);
    vy0 = rng.range(-0.45, 0.85);
    const drop = handY - floorTop;
    const tf = (vy0 + Math.sqrt(vy0 * vy0 + 2 * GRAVITY * drop)) / GRAVITY;
    const hv = rng.range(0.9, 1.15) * (0.85 + 0.3 * strength);
    vx = ((tx - hx) / tf) * hv;
    vz = ((tz - hz) / tf) * hv;
  }

  // --- サイコロの配置 ---
  const offsets: [number, number, number][] = [];
  packDice(rng, offsets);

  const dice: DieInit[] = [];
  let wildDie = -1;
  if (wild) wildDie = rng.int(DICE_COUNT);

  const tmp: number[] = [0, 0, 0, 0];
  for (let i = 0; i < DICE_COUNT; i++) {
    const o = offsets[i];
    const q: [number, number, number, number] = [0, 0, 0, 1];
    rng.quaternion(tmp);
    q[0] = tmp[0];
    q[1] = tmp[1];
    q[2] = tmp[2];
    q[3] = tmp[3];

    // 個体ごとの狙いのばらつき: 同時に着地して互いを弾き合わないよう、
    // 手の中の位置関係に加えて「投げの向き」に沿った速度差 (先に出る/遅れる) と
    // 横方向の小さな速度差を与える
    const spread = rng.range(0.5, 2.2);
    const along = rng.gaussian() * 0.075;
    const across = rng.gaussian() * 0.05;
    const hs = Math.hypot(vx, vz) || 1;
    const dirx = vx / hs;
    const dirz = vz / hs;
    const v: [number, number, number] = [
      vx + o[0] * spread + dirx * along - dirz * across,
      vy0 + o[1] * spread + rng.gaussian() * 0.05,
      vz + o[2] * spread + dirz * along + dirx * across,
    ];

    const wv: number[] = [0, 0, 0];
    rng.unitVector(wv);
    const wmag = rng.range(6, 38) * (0.7 + 0.3 * strength);
    const w: [number, number, number] = [wv[0] * wmag, wv[1] * wmag, wv[2] * wmag];

    if (i === wildDie) {
      // 1個だけ、椀の外へ出てしまう勢いで放る
      const ang = rng.range(0, Math.PI * 2);
      if (rng.float() < 0.5) {
        // 放り上げ: 斜め上へ。縁の上を越えて机へ
        const hs = rng.range(style.wildLobH[0], style.wildLobH[1]);
        v[0] = Math.cos(ang) * hs;
        v[1] = rng.range(style.wildLobV[0], style.wildLobV[1]);
        v[2] = Math.sin(ang) * hs;
      } else {
        // 叩きつけ: 底や壁に強く当てて跳ね上げ、縁を越える
        const hs = rng.range(style.wildSlamH[0], style.wildSlamH[1]);
        v[0] = Math.cos(ang) * hs;
        v[1] = -rng.range(style.wildSlamV[0], style.wildSlamV[1]);
        v[2] = Math.sin(ang) * hs;
      }
    }

    dice.push({ p: [hx + o[0], handY + o[1], hz + o[2]], q, v, w });
  }

  return { dice, hand: [hx, handY, hz], strength, wild, wildDie };
}
