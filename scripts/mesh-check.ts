/// <reference types="node" />
/**
 * 描画メッシュの検証
 *   npm run verify:mesh
 *  - 面の向き(巻き方向)が法線と一致しているか
 *  - 見えているお椀の内面がサイコロの当たる面(SDF)と一致しているか  ← 旧実装の「貫通」の根本原因への対策の確認
 */
import { buildBowlModel } from '../src/physics/bowlModel';
import { seedFromNumber } from '../src/physics/rng';
import { buildBowlMeshes, buildDiceMesh, CM, MeshData } from '../src/render/meshes';

function windingCheck(name: string, m: MeshData): void {
  let bad = 0; let degenerate = 0; const n = m.indices.length / 3;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
    const P = m.positions;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-12) { degenerate++; continue; }
    const N = m.normals;
    const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
    if (fx * nx + fy * ny + fz * nz <= 0) bad++;
  }
  console.log(`${name}: 三角形 ${n}  逆向き ${bad}  縮退 ${degenerate}  頂点 ${m.positions.length / 3}`);
  if (bad > 0) process.exitCode = 1;
}

const dice = buildDiceMesh();
windingCheck('サイコロ', dice);
let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
for (let i = 0; i < dice.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], dice.positions[i + k]); mx[k] = Math.max(mx[k], dice.positions[i + k]); }
console.log('  サイコロの外形(cm):', mn.map(v => v.toFixed(3)).join(','), '→', mx.map(v => v.toFixed(3)).join(','), '(±0.800 になること)');

const bowl = buildBowlModel(seedFromNumber(2026));
const meshes = buildBowlMeshes(bowl, { segments: 256 });
windingCheck('お椀 内面', meshes.inner);
windingCheck('お椀 縁', meshes.rim);
windingCheck('お椀 外面', meshes.outer);

// 見た目の内面 = SDF の等値面か
const q = new Float64Array(5);
let worst = 0, sum = 0, cnt = 0, worstN = 1;
const P = meshes.inner.positions, N = meshes.inner.normals;
for (let i = 0; i < P.length; i += 3 * 7) {
  const x = P[i] / CM, y = P[i + 1] / CM, z = P[i + 2] / CM;
  if (Math.hypot(x, z) > bowl.profile.rimInnerR - 0.004) continue; // 縁のフェード帯は除く
  bowl.query(x, y, z, q);
  const a = Math.abs(q[0]); worst = Math.max(worst, a); sum += a; cnt++;
  worstN = Math.min(worstN, q[1] * N[i] + q[2] * N[i + 1] + q[3] * N[i + 2]);
}
console.log(`内面メッシュ頂点の SDF 値 |φ|: 平均 ${(sum / cnt * 1e6).toFixed(1)} µm, 最大 ${(worst * 1e6).toFixed(1)} µm (${cnt}点)  / 法線の一致 最小 cos = ${worstN.toFixed(4)}`);
if (worst > 5e-5) { console.log('NG: 見た目と当たり判定がずれています'); process.exitCode = 1; } else console.log('OK: 見た目の内面と当たり判定(SDF)は 0.05mm 以内で一致');
