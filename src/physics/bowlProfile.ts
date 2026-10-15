/**
 * お椀の断面プロファイル (回転体の母線)
 *
 * ★ このデータが「見た目のお椀」と「物理の当たり判定」の唯一の形状ソース。
 *   描画メッシュもこの母線を回転させて作り、衝突用の符号付き距離場(SDF)もこの母線から焼き込む。
 *   旧実装で起きていた「見えているお椀と当たり判定のズレ」を構造的に起こさないための設計。
 *
 * 座標系: r = 中心軸からの距離 [m], y = 机の面を 0 とした高さ [m]
 * 法線は「自由空間(空気)側」を向く。
 */
import { MAT_GLAZE, MAT_OUTER, MAT_RIM } from './constants';

export interface BowlSpec {
  /** 内底面の高さ (机の面から) [m] */
  yFloor: number;
  /** 平らな底の半径 [m] */
  floorFlat: number;
  /** 底→壁へ立ち上がる曲面(アークA)の長さ [m] と終端角 [rad] */
  arcALength: number;
  angleA: number;
  /** 直線状の壁(コーン)の長さ [m] */
  coneLength: number;
  /** 縁へ向かって反り返るアークBの長さ [m] と縁での角度 [rad] */
  arcBLength: number;
  angleB: number;
  /** 器の肉厚(法線方向) [m] */
  thickness: number;
  /** 高台(底の接地リング)の外半径・内半径 [m] */
  footOuterR: number;
  footInnerR: number;
  /** 母線の分割幅 [m] */
  step: number;
}

export const DEFAULT_BOWL_SPEC: BowlSpec = {
  yFloor: 0.0105,
  floorFlat: 0.02,
  arcALength: 0.04,
  angleA: (46 * Math.PI) / 180,
  coneLength: 0.01,
  arcBLength: 0.036,
  angleB: (76 * Math.PI) / 180,
  thickness: 0.0064,
  footOuterR: 0.028,
  footInnerR: 0.019,
  step: 0.0006,
};

export interface ProfilePoint {
  r: number;
  y: number;
  /** 法線 (自由空間側) */
  nr: number;
  ny: number;
}

export interface BowlProfile {
  spec: BowlSpec;
  /** 内面: 中心 (0, yFloor) → 縁の内側上端 */
  inner: ProfilePoint[];
  /** 縁の丸み (半円): 内側上端 → 外側上端 */
  cap: ProfilePoint[];
  /** 外面: 縁の外側上端 → 外底の平面始端 */
  outer: ProfilePoint[];
  /** 高台まわり (外底 → 接地リング → 凹み → 中心) */
  foot: ProfilePoint[];
  /** SDF焼き込み用の閉ポリゴン線分。[r0,y0,r1,y1]×N */
  segments: Float64Array;
  /** 各線分の材質。軸上の閉じ線分は 255 (距離計算から除外) */
  segmentMat: Uint8Array;
  /** 縁内側上端の半径 / 高さ */
  rimInnerR: number;
  rimInnerY: number;
  /** 縁の頂点(最高点)の高さ */
  rimTopY: number;
  /** 器の最大半径 (縁の外側) */
  maxR: number;
  /** 外底の高さ (机から) */
  underY: number;
  /** 内面の高さ y(r) を返す (r は内面の範囲内) */
  innerHeightAt(r: number): number;
  /** 内面の傾斜角 θ(r) [rad] */
  innerSlopeAt(r: number): number;
}

export const AXIS_SEGMENT = 255;

export function buildBowlProfile(spec: BowlSpec = DEFAULT_BOWL_SPEC): BowlProfile {
  const total = spec.floorFlat + spec.arcALength + spec.coneLength + spec.arcBLength;
  const n = Math.max(16, Math.round(total / spec.step));
  const ds = total / n;

  const s1 = spec.floorFlat;
  const s2 = s1 + spec.arcALength;
  const s3 = s2 + spec.coneLength;

  /** 弧長 s における壁の傾斜角 */
  const angleAt = (s: number): number => {
    if (s <= s1) return 0;
    if (s <= s2) return (spec.angleA * (s - s1)) / spec.arcALength;
    if (s <= s3) return spec.angleA;
    return spec.angleA + ((spec.angleB - spec.angleA) * (s - s3)) / spec.arcBLength;
  };

  // --- 内面 ---
  const inner: ProfilePoint[] = [{ r: 0, y: spec.yFloor, nr: 0, ny: 1 }];
  let r = 0;
  let y = spec.yFloor;
  for (let k = 1; k <= n; k++) {
    const thMid = angleAt((k - 0.5) * ds);
    r += ds * Math.cos(thMid);
    y += ds * Math.sin(thMid);
    const th = angleAt(k * ds);
    inner.push({ r, y, nr: -Math.sin(th), ny: Math.cos(th) });
  }
  const top = inner[inner.length - 1];
  const thTop = angleAt(total);
  const t = spec.thickness;

  // --- 縁の丸み (壁の接線方向に突き出る半円) ---
  const cap: ProfilePoint[] = [];
  const cx = top.r - (t / 2) * top.nr;
  const cy = top.y - (t / 2) * top.ny;
  const dX = Math.cos(thTop);
  const dY = Math.sin(thTop);
  const capN = 14;
  for (let k = 0; k <= capN; k++) {
    const phi = (k / capN) * Math.PI;
    const ax = Math.cos(phi) * top.nr + Math.sin(phi) * dX;
    const ay = Math.cos(phi) * top.ny + Math.sin(phi) * dY;
    cap.push({ r: cx + (t / 2) * ax, y: cy + (t / 2) * ay, nr: ax, ny: ay });
  }

  // --- 外面: 内面を肉厚ぶんだけ外へオフセット (縁 → 外底) ---
  const outer: ProfilePoint[] = [];
  let kFlat = 0; // 平らな外底が始まる添字
  for (let k = 0; k <= n; k++) if (k * ds <= s1 + 1e-12) kFlat = k;
  for (let k = n; k >= kFlat; k--) {
    const p = inner[k];
    outer.push({ r: p.r - t * p.nr, y: p.y - t * p.ny, nr: -p.nr, ny: -p.ny });
  }
  const underY = spec.yFloor - t;

  // --- 高台まわり ---
  const foot: ProfilePoint[] = [
    { r: spec.footOuterR, y: underY, nr: 0, ny: -1 },
    { r: spec.footOuterR, y: 0, nr: 1, ny: 0 },
    { r: spec.footInnerR, y: 0, nr: 0, ny: -1 },
    { r: spec.footInnerR, y: underY, nr: -1, ny: 0 },
    { r: 0, y: underY, nr: 0, ny: -1 },
  ];

  // --- SDF焼き込み用の閉ポリゴン ---
  // 継ぎ目の重複点 (内面上端=縁の始点 / 縁の終点=外面の始点) は除いて長さゼロの線分を作らない
  const poly: { r: number; y: number; mat: number }[] = [];
  inner.forEach((p) => poly.push({ r: p.r, y: p.y, mat: MAT_GLAZE }));
  cap.slice(1).forEach((p) => poly.push({ r: p.r, y: p.y, mat: MAT_RIM }));
  outer.slice(1).forEach((p) => poly.push({ r: p.r, y: p.y, mat: MAT_OUTER }));
  foot.forEach((p) => poly.push({ r: p.r, y: p.y, mat: MAT_OUTER }));
  // 最後の点 (0, underY) → 最初の点 (0, yFloor) は軸上の閉じ線分

  const segCount = poly.length;
  const segments = new Float64Array(segCount * 4);
  const segmentMat = new Uint8Array(segCount);
  for (let i = 0; i < segCount; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % segCount];
    segments[i * 4] = a.r;
    segments[i * 4 + 1] = a.y;
    segments[i * 4 + 2] = b.r;
    segments[i * 4 + 3] = b.y;
    // 線分の材質は終点側に合わせる (内面→縁の最初の線分は縁の材質になる)
    segmentMat[i] = i === segCount - 1 ? AXIS_SEGMENT : b.mat;
  }

  let rimTopY = -Infinity;
  let maxR = 0;
  for (const p of poly) {
    if (p.y > rimTopY) rimTopY = p.y;
    if (p.r > maxR) maxR = p.r;
  }

  // 内面の高さ参照 (r は単調増加)
  const innerR = inner.map((p) => p.r);
  const lookup = (rr: number): number => {
    if (rr <= 0) return 0;
    if (rr >= innerR[innerR.length - 1]) return inner.length - 1;
    let lo = 0;
    let hi = innerR.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (innerR[mid] <= rr) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const innerHeightAt = (rr: number): number => {
    if (rr <= 0) return inner[0].y;
    const last = inner[inner.length - 1];
    if (rr >= last.r) return last.y;
    const i = lookup(rr);
    const a = inner[i];
    const b = inner[i + 1];
    const f = (rr - a.r) / (b.r - a.r);
    return a.y + (b.y - a.y) * f;
  };
  const innerSlopeAt = (rr: number): number => {
    const i = Math.min(lookup(rr), inner.length - 2);
    const a = inner[i];
    const b = inner[i + 1];
    return Math.atan2(b.y - a.y, b.r - a.r);
  };

  return {
    spec,
    inner,
    cap,
    outer,
    foot,
    segments,
    segmentMat,
    rimInnerR: top.r,
    rimInnerY: top.y,
    rimTopY,
    maxR,
    underY,
    innerHeightAt,
    innerSlopeAt,
  };
}
