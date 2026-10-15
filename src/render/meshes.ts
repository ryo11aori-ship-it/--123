/**
 * 描画メッシュの生成 (three.js 非依存。配列だけを返す)
 *
 * 単位は「1シーン単位 = 1cm」。物理は SI(m) なので ×100 して使う。
 *
 * ★ お椀のメッシュは物理と同じ BowlProfile(母線) + 凹凸マップから作る。
 *   頂点位置・法線は SDF の定義と同じ式 (φ' = φ - b·n_y) なので、
 *   「見えているお椀の面」と「サイコロが当たる面」は一致する (scripts/physics-verify.ts で検証)。
 */
import { BowlModel } from '../physics/bowlModel';
import { DIE } from '../physics/constants';

export const CM = 100;

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array | null;
  indices: Uint32Array;
}

// ---------------------------------------------------------------------------
//  サイコロ
// ---------------------------------------------------------------------------

/** 面の並び: [法線, U軸, V軸, 目]。U×V=法線 (外から見て U=右, V=上) */
export const DICE_FACES: readonly { n: number[]; u: number[]; v: number[]; pips: number }[] = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], pips: 1 }, // +X
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], pips: 6 }, // -X
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], pips: 2 }, // +Y
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], pips: 5 }, // -Y
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], pips: 3 }, // +Z
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], pips: 4 }, // -Z
];

/** 目の配置 (面の半幅=1 とした座標, 半径も同じ単位) */
export function pipLayout(n: number): { x: number; y: number; r: number }[] {
  const a = 0.5;
  const b = 0.55;
  const r = 0.17;
  switch (n) {
    case 1:
      return [{ x: 0, y: 0, r: 0.34 }];
    case 2:
      return [
        { x: -a, y: a, r },
        { x: a, y: -a, r },
      ];
    case 3:
      return [
        { x: -a, y: a, r },
        { x: 0, y: 0, r },
        { x: a, y: -a, r },
      ];
    case 4:
      return [
        { x: -a, y: a, r },
        { x: a, y: a, r },
        { x: -a, y: -a, r },
        { x: a, y: -a, r },
      ];
    case 5:
      return [
        { x: -a, y: a, r },
        { x: a, y: a, r },
        { x: 0, y: 0, r },
        { x: -a, y: -a, r },
        { x: a, y: -a, r },
      ];
    default:
      return [
        { x: -a, y: b, r },
        { x: -a, y: 0, r },
        { x: -a, y: -b, r },
        { x: a, y: b, r },
        { x: a, y: 0, r },
        { x: a, y: -b, r },
      ];
  }
}

/** 目のくぼみの深さ (面の半幅=1 に対する比) */
const PIP_DEPTH = 0.055;

function pipDepthAt(pips: number, u: number, v: number): number {
  let d = 0;
  for (const p of pipLayout(pips)) {
    const rho2 = ((u - p.x) * (u - p.x) + (v - p.y) * (v - p.y)) / (p.r * p.r);
    if (rho2 < 1) {
      const k = 1 - rho2;
      d += PIP_DEPTH * k * k * (p.r > 0.3 ? 1.35 : 1);
    }
  }
  return d;
}

/** 角丸サイコロ。目は実際にくぼませる (UVはアトラス 3×2 に対応) */
export function buildDiceMesh(): MeshData {
  const h = DIE.half * CM;
  const rho = DIE.cornerRadius * CM;
  const b = h - rho;

  // 1次元の格子座標 (-1..1): 角の丸み部分は細かく、面の内側は目のくぼみを表現できる細かさ
  const bandN = 4;
  const midN = 22;
  const rb = b / h; // 面が平らな範囲 (|t| < rb)
  const coords: number[] = [];
  for (let i = 0; i <= bandN; i++) coords.push(-1 + (1 - rb) * (i / bandN));
  for (let i = 1; i < midN; i++) coords.push(-rb + (2 * rb * i) / midN);
  for (let i = 0; i <= bandN; i++) coords.push(rb + (1 - rb) * (i / bandN));
  const nv = coords.length;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  DICE_FACES.forEach((face, fi) => {
    const base = positions.length / 3;
    const col = fi % 3;
    const row = Math.floor(fi / 3);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nv; i++) {
        const tu = coords[i];
        const tv = coords[j];
        // 外側の立方体表面上の点 p
        const px = face.n[0] * h + face.u[0] * tu * h + face.v[0] * tv * h;
        const py = face.n[1] * h + face.u[1] * tu * h + face.v[1] * tv * h;
        const pz = face.n[2] * h + face.u[2] * tu * h + face.v[2] * tv * h;
        // 内箱への最近接点 q と、そこからの方向 = 法線
        const qx = Math.max(-b, Math.min(b, px));
        const qy = Math.max(-b, Math.min(b, py));
        const qz = Math.max(-b, Math.min(b, pz));
        let nx = px - qx;
        let ny = py - qy;
        let nz = pz - qz;
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-9) {
          nx = face.n[0];
          ny = face.n[1];
          nz = face.n[2];
        } else {
          nx /= nl;
          ny /= nl;
          nz /= nl;
        }
        let x = qx + rho * nx;
        let y = qy + rho * ny;
        let z = qz + rho * nz;
        // 目のくぼみ (平らな面の内側だけ)
        let dep = 0;
        if (Math.abs(tu) <= rb + 1e-9 && Math.abs(tv) <= rb + 1e-9) {
          dep = pipDepthAt(face.pips, tu, tv) * h;
        }
        x -= nx * dep;
        y -= ny * dep;
        z -= nz * dep;
        positions.push(x, y, z);
        normals.push(nx, ny, nz); // くぼみの法線は後で再計算
        const uu = tu * 0.5 + 0.5;
        const vv = tv * 0.5 + 0.5;
        uvs.push((col + uu) / 3, 1 - (row + 1 - vv) / 2);
      }
    }
    for (let j = 0; j < nv - 1; j++) {
      for (let i = 0; i < nv - 1; i++) {
        const a = base + j * nv + i;
        const bb = a + 1;
        const c = a + nv;
        const d = c + 1;
        // 外から見て反時計回り (U=右, V=上)
        indices.push(a, bb, d, a, d, c);
      }
    }
  });

  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  const nrm = new Float32Array(normals);
  recomputeDimpleNormals(pos, nrm, idx, nv);
  return { positions: pos, normals: nrm, uvs: new Float32Array(uvs), colors: null, indices: idx };
}

/** くぼみのある面は、隣接三角形の面法線を平均して法線を再計算する (面ごとの格子内のみ) */
function recomputeDimpleNormals(pos: Float32Array, nrm: Float32Array, idx: Uint32Array, nv: number): void {
  const vertsPerFace = nv * nv;
  const acc = new Float32Array(nrm.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      acc[o] += fx;
      acc[o + 1] += fy;
      acc[o + 2] += fz;
    }
  }
  // 面の端(丸み部分)は解析法線のまま、内側の格子点だけ面法線平均に置換
  const faces = pos.length / 3 / vertsPerFace;
  for (let f = 0; f < faces; f++) {
    for (let j = 2; j < nv - 2; j++) {
      for (let i = 2; i < nv - 2; i++) {
        const vi = (f * vertsPerFace + j * nv + i) * 3;
        const l = Math.hypot(acc[vi], acc[vi + 1], acc[vi + 2]);
        if (l > 1e-12) {
          // 丸み帯の外側(band)では解析法線が正しいので、平らな領域(帯の内側)のみ
          const inBandI = i < 5 || i > nv - 6;
          const inBandJ = j < 5 || j > nv - 6;
          if (!inBandI && !inBandJ) {
            nrm[vi] = acc[vi] / l;
            nrm[vi + 1] = acc[vi + 1] / l;
            nrm[vi + 2] = acc[vi + 2] / l;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  お椀
// ---------------------------------------------------------------------------

export interface BowlMeshOptions {
  /** 周方向の分割数 */
  segments: number;
}

export interface BowlMeshes {
  inner: MeshData;
  rim: MeshData;
  outer: MeshData;
}

/** 内面の凹凸を反映した頂点位置・法線を書き直す (凹凸の強さを変えたとき用) */
export interface InnerMeshLayout {
  rings: number;
  segments: number;
  /** 各リングの基準 (r, y, nr, ny) */
  base: Float32Array;
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function hexToLinear(hex: number): [number, number, number] {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const GLAZE_DEEP = hexToLinear(0x0d1016);
const GLAZE_MID = hexToLinear(0x1d1b22);
const GLAZE_RIM = hexToLinear(0x4a2b16);
const GOLD_RING = hexToLinear(0xb98f3a);

/** 内面の頂点色: 底は黒藍、縁へ向かって天目釉の飴色に、底の端に金の細線 */
function innerColor(r: number, tHeight: number, bowl: BowlModel, bumpV: number): [number, number, number] {
  let c = lerp3(GLAZE_DEEP, GLAZE_MID, Math.min(1, tHeight * 1.6));
  const rimBlend = Math.max(0, (tHeight - 0.7) / 0.3);
  c = lerp3(c, GLAZE_RIM, rimBlend * rimBlend);
  // 釉が溜まる窪みは少し深く、出っ張りは少し明るく
  const k = 1 + Math.max(-0.35, Math.min(0.5, bumpV * 1800));
  c = [c[0] * k, c[1] * k, c[2] * k];
  const ringR = bowl.profile.spec.floorFlat + 0.0004;
  const dr = Math.abs(r - ringR);
  if (dr < 0.0009) {
    const w = 1 - dr / 0.0009;
    c = lerp3(c, GOLD_RING, w * 0.9);
  }
  return c;
}

function revolve(
  pts: { r: number; y: number; nr: number; ny: number }[],
  segments: number,
  displaced: ((x: number, z: number, out: Float64Array) => void) | null,
  colorFn: ((r: number, y: number, tH: number, b: number) => [number, number, number]) | null,
  heightRange: [number, number],
  flip: boolean,
): MeshData {
  const rings = pts.length;
  const vcount = rings * (segments + 1);
  const positions = new Float32Array(vcount * 3);
  const normals = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);
  const colors = colorFn ? new Float32Array(vcount * 3) : null;
  const tmp = new Float64Array(3);
  for (let i = 0; i < rings; i++) {
    const p = pts[i];
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const x = p.r * c;
      const z = p.r * s;
      let y = p.y;
      let nx = p.nr * c;
      let ny = p.ny;
      let nz = p.nr * s;
      let bv = 0;
      if (displaced) {
        displaced(x, z, tmp);
        bv = tmp[0];
        y += tmp[0];
        // 変位面の法線: n' ∝ n - n_y (∂b/∂x, 0, ∂b/∂z)
        nx -= p.ny * tmp[1];
        nz -= p.ny * tmp[2];
        const l = Math.hypot(nx, ny, nz);
        nx /= l;
        ny /= l;
        nz /= l;
      }
      const o = (i * (segments + 1) + j) * 3;
      positions[o] = x * CM;
      positions[o + 1] = y * CM;
      positions[o + 2] = z * CM;
      normals[o] = nx;
      normals[o + 1] = ny;
      normals[o + 2] = nz;
      uvs[(i * (segments + 1) + j) * 2] = j / segments;
      uvs[(i * (segments + 1) + j) * 2 + 1] = i / (rings - 1);
      if (colors && colorFn) {
        const tH = (p.y - heightRange[0]) / (heightRange[1] - heightRange[0]);
        const col = colorFn(p.r, p.y, Math.max(0, Math.min(1, tH)), bv);
        colors[o] = col[0];
        colors[o + 1] = col[1];
        colors[o + 2] = col[2];
      }
    }
  }
  const indices = new Uint32Array((rings - 1) * segments * 6);
  let k = 0;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j;
      const b = a + 1;
      const c = a + (segments + 1);
      const d = c + 1;
      // 面の向きは「空間(空気)側」(b=周方向+1, c=母線方向+1 の並びなので a,b,d の順が空気側)。flip で反転可
      if (!flip) indices.set([a, b, d, a, d, c], k);
      else indices.set([a, d, b, a, c, d], k);
      k += 6;
    }
  }
  return { positions, normals, uvs, colors, indices };
}

/** お椀の描画メッシュを作る (内面・縁・外面) */
export function buildBowlMeshes(bowl: BowlModel, opts: BowlMeshOptions): BowlMeshes {
  const prof = bowl.profile;
  const seg = opts.segments;
  const heightRange: [number, number] = [prof.spec.yFloor, prof.rimInnerY];
  const bump = (x: number, z: number, out: Float64Array) => bowl.bumpAt(x, z, out);
  const inner = revolve(
    prof.inner,
    seg,
    bump,
    (r, _y, tH, b) => innerColor(r, tH, bowl, b),
    heightRange,
    false,
  );
  const rim = revolve(prof.cap, seg, null, null, heightRange, false);
  // 外面: 縁から外底へ。外釉は少し明るい黒 (下の土見せは別材質にせず暗い色で十分)
  const outer = revolve(prof.outer, seg, null, null, heightRange, false);
  return { inner, rim, outer };
}

/** 凹凸の強さが変わったとき、内面の頂点位置と法線だけを更新する */
export function updateBowlInner(bowl: BowlModel, inner: MeshData, segments: number): void {
  const prof = bowl.profile;
  const pts = prof.inner;
  const tmp = new Float64Array(3);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const x = p.r * c;
      const z = p.r * s;
      bowl.bumpAt(x, z, tmp);
      let nx = p.nr * c - p.ny * tmp[1];
      const ny = p.ny;
      let nz = p.nr * s - p.ny * tmp[2];
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      nz /= l;
      const o = (i * (segments + 1) + j) * 3;
      inner.positions[o + 1] = (p.y + tmp[0]) * CM;
      inner.normals[o] = nx;
      inner.normals[o + 1] = ny / l;
      inner.normals[o + 2] = nz;
    }
  }
}
