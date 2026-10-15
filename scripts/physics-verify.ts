/// <reference types="node" />
/**
 * 物理シミュレータの総合検証 (モンテカルロ)
 *   npm run verify:physics            (標準: 約1〜2分)
 *   npm run verify:physics -- --quick (簡易: 数十秒)
 *   npm run verify:physics -- --n=3000
 *
 * 検証項目
 *   1. 公平性      : 目の出現頻度 χ² 検定 / 5個の目のパターン分布 (理論値との比較)
 *   2. 脱出率      : 通常投擲で椀外へ出る/傾く/重なる 割合 (棄却率)
 *   3. ションベン  : 椀外へ飛び出す投擲を物理で作れるか (成功率・停止位置)
 *   4. 再現性      : 同じシードなら全フレームがビット一致
 *   5. 凹凸の影響  : 凹凸あり/なしで結果がどれだけ変わるか / 極微小な初期差の影響 (カオス性)
 *   6. 貫通        : 全フレームで めり込み量・賽の中心が固体内に入っていないか
 *   7. 速度        : 1投擲あたりの計算時間
 */
import { buildBowlModel } from '../src/physics/bowlModel';
import { Prng, seedFromNumber } from '../src/physics/rng';
import { RollJob } from '../src/physics/rollJob';
import { DiceWorld } from '../src/physics/world';
import { DICE_COUNT, DIE } from '../src/physics/constants';
import { SAMPLES_DENSE_N, SAMPLES, quatToMat } from '../src/physics/diceShape';
import { FLOATS_PER_DIE } from '../src/physics/recording';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const nArg = args.find((a) => a.startsWith('--n='));
const N = nArg ? parseInt(nArg.slice(4), 10) : quick ? 300 : 1200;
const SEEDBASE = 424242;

const bowl = buildBowlModel(seedFromNumber(2026));
const world = new DiceWorld(bowl, 480);
const pad = (s: string | number, n = 8) => String(s).padStart(n);
const hr = (t: string) => console.log(`\n=== ${t} ===`);

// χ² の上側確率 (Wilson–Hilferty 近似)
function chi2p(x: number, k: number): number {
  const z = (Math.cbrt(x / k) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
  return 0.5 * erfc(z / Math.SQRT2);
}
function erfc(x: number): number {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const r = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

// ---------------------------------------------------------------- 1,2,7
hr(`1) 公平性 / 2) 棄却率 / 7) 速度  (通常投擲 ${N}回)`);
const faceCount = [0, 0, 0, 0, 0, 0, 0];
const perDie: number[][] = Array.from({ length: DICE_COUNT }, () => [0, 0, 0, 0, 0, 0, 0]);
const patternCount: Record<string, number> = {};
let attempts = 0;
const rej = { cocked: 0, stacked: 0, escaped: 0, rim: 0, timeout: 0, numeric: 0, missed: 0 };
const msList: number[] = [];
const restList: number[] = [];
const impactList: number[] = [];
let relaxed = 0;
const t00 = performance.now();
for (let n = 0; n < N; n++) {
  const t0 = performance.now();
  const o = new RollJob(bowl, seedFromNumber(SEEDBASE + n), { wantShonben: false, quality: 'medium' }, world).runToEnd();
  msList.push(performance.now() - t0);
  attempts += o.meta.attempts;
  for (const k of Object.keys(rej) as (keyof typeof rej)[]) rej[k] += o.meta.rejected[k];
  if (o.meta.relaxed) relaxed++;
  restList.push(o.recording.restTime);
  impactList.push(o.meta.impacts);
  o.values.forEach((v, i) => { faceCount[v]++; perDie[i][v]++; });
  const cnt = [0, 0, 0, 0, 0, 0, 0];
  o.values.forEach((v) => cnt[v]++);
  const pat = cnt.slice(1).filter((c) => c > 0).sort((a, b) => b - a).join('');
  patternCount[pat] = (patternCount[pat] || 0) + 1;
}
const total = N * DICE_COUNT;
let chi = 0;
for (let v = 1; v <= 6; v++) chi += (faceCount[v] - total / 6) ** 2 / (total / 6);
console.log('目の出現数(1〜6):', faceCount.slice(1).map((c) => `${c} (${(c / total * 100).toFixed(2)}%)`).join('  '));
console.log(`χ²(5自由度)=${chi.toFixed(2)}  p=${chi2p(chi, 5).toFixed(3)}  (p>0.01 なら一様と矛盾しない / 理論値 16.667%)`);
perDie.forEach((c, i) => {
  let x = 0; for (let v = 1; v <= 6; v++) x += (c[v] - N / 6) ** 2 / (N / 6);
  console.log(`  サイコロ${i + 1}: ${c.slice(1).join(' ')}  χ²=${x.toFixed(2)} p=${chi2p(x, 5).toFixed(3)}`);
});
// パターン分布 (5個の目の組み合わせ)
const patTheory: Record<string, number> = { '5': 6, '41': 150, '32': 300, '311': 1200, '221': 1800, '2111': 3600, '11111': 720 };
const pats = ['5', '41', '32', '311', '221', '2111', '11111'];
let chiP = 0; let dof = 0;
const mergedObs: number[] = []; const mergedExp: number[] = [];
{
  // '5' と '41' は期待度数が小さいので統合
  const groups = [['5', '41'], ['32'], ['311'], ['221'], ['2111'], ['11111']];
  for (const g of groups) { const obs = g.reduce((s, k) => s + (patternCount[k] || 0), 0); const exp = g.reduce((s, k) => s + patTheory[k], 0) / 7776 * N; mergedObs.push(obs); mergedExp.push(exp); chiP += (obs - exp) ** 2 / exp; dof++; }
}
console.log('5個の目のパターン分布 (観測 / 理論):');
pats.forEach((k) => console.log(`   ${pad(k, 6)}: ${pad(patternCount[k] || 0, 5)} / ${(patTheory[k] / 7776 * N).toFixed(1)}`));
console.log(`  パターンχ²(${dof - 1}自由度)=${chiP.toFixed(2)} p=${chi2p(chiP, dof - 1).toFixed(3)}`);
console.log(`試行回数 ${attempts} (${(attempts / N).toFixed(3)}回/投擲)  棄却内訳:`, JSON.stringify(rej), ` relaxed(上限到達)=${relaxed}`);
console.log(`  → 椀外へ脱出 ${(rej.escaped / attempts * 100).toFixed(2)}% / 傾き ${(rej.cocked / attempts * 100).toFixed(2)}% / 重なり ${(rej.stacked / attempts * 100).toFixed(2)}% / 縁に乗る ${(rej.rim / attempts * 100).toFixed(2)}% (1試行あたり)`);
msList.sort((a, b) => a - b);
restList.sort((a, b) => a - b);
const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
console.log(`計算時間/投擲(ms): 中央値 ${pct(msList, 0.5).toFixed(0)}  90% ${pct(msList, 0.9).toFixed(0)}  99% ${pct(msList, 0.99).toFixed(0)}  最大 ${msList[msList.length - 1].toFixed(0)}  (合計 ${((performance.now() - t00) / 1000).toFixed(1)}s)`);
console.log(`静止までの時間(s): 中央値 ${pct(restList, 0.5).toFixed(2)}  10% ${pct(restList, 0.1).toFixed(2)}  90% ${pct(restList, 0.9).toFixed(2)}  最大 ${restList[restList.length - 1].toFixed(2)} / 衝突回数 中央値 ${impactList.sort((a, b) => a - b)[impactList.length >> 1]}`);

// ---------------------------------------------------------------- 3
hr('3) ションベン (椀外へ飛び出す投擲を物理で作る)');
{
  const M = quick ? 40 : 150;
  let att = 0; const ms: number[] = []; const dists: number[] = []; let multi = 0; let ok = 0; let relaxedS = 0;
  for (let n = 0; n < M; n++) {
    const t0 = performance.now();
    const o = new RollJob(bowl, seedFromNumber(SEEDBASE + 900000 + n), { wantShonben: true, quality: 'medium' }, world).runToEnd();
    ms.push(performance.now() - t0); att += o.meta.attempts;
    if (o.shonben) ok++;
    if (o.meta.relaxed) relaxedS++;
    if (o.outsideDice.length > 1) multi++;
    const r = o.recording; const last = (r.frameCount - 1) * DICE_COUNT * FLOATS_PER_DIE;
    for (const d of o.outsideDice) dists.push(Math.hypot(r.frames[last + d * 7], r.frames[last + d * 7 + 2]));
  }
  ms.sort((a, b) => a - b); dists.sort((a, b) => a - b);
  console.log(`ションベン成立 ${ok}/${M}  平均試行回数 ${(att / M).toFixed(2)}  (成功率/試行 ${(M / att * 100).toFixed(1)}%)  relaxed=${relaxedS}  2個以上飛び出した投擲 ${multi}`);
  console.log(`計算時間(ms): 中央値 ${pct(ms, 0.5).toFixed(0)} 90% ${pct(ms, 0.9).toFixed(0)} 最大 ${ms[ms.length - 1].toFixed(0)} / 椀外の賽の停止距離(cm): 中央値 ${(pct(dists, 0.5) * 100).toFixed(1)} 90% ${(pct(dists, 0.9) * 100).toFixed(1)} 最大 ${(dists[dists.length - 1] * 100).toFixed(1)}`);
}

// ---------------------------------------------------------------- 4
hr('4) 再現性 (同じシード → 全フレームがビット一致)');
{
  let same = 0; const M = 20;
  for (let n = 0; n < M; n++) {
    const a = new RollJob(bowl, seedFromNumber(77 + n), { wantShonben: n % 7 === 6, quality: 'medium' }, world).runToEnd();
    const b = new RollJob(bowl, seedFromNumber(77 + n), { wantShonben: n % 7 === 6, quality: 'medium' }, new DiceWorld(bowl, 480)).runToEnd();
    const fa = a.recording.frames; const fb = b.recording.frames;
    let eq = fa.length === fb.length && a.values.join() === b.values.join();
    for (let i = 0; eq && i < fa.length; i++) if (fa[i] !== fb[i]) eq = false;
    if (eq) same++;
  }
  console.log(`${same}/${M} 件がビット一致`);
}

// ---------------------------------------------------------------- 5
hr('5) お椀の凹凸の影響 / 初期条件への鋭敏性 (カオス性)');
{
  const M = quick ? 60 : 200;
  const run = (seed: number, bumpScale: number, jitter = 0) => {
    bowl.bumpScale = bumpScale;
    // jitter: 投擲の初期位置を微小にずらす (1e-9 m 単位)
    const job = new RollJob(bowl, seedFromNumber(seed), { wantShonben: false, quality: 'medium', maxAttempts: 1 }, world);
    if (jitter !== 0) {
      const orig = (job as any).beginAttempt.bind(job);
      (job as any).beginAttempt = () => { orig(); world.pos[0] += jitter; };
    }
    return job.runToEnd().values;
  };
  const cmp = (A: number[][], B: number[][]) => {
    let dieSame = 0, rollSame = 0;
    for (let i = 0; i < A.length; i++) { let all = true; for (let d = 0; d < DICE_COUNT; d++) { if (A[i][d] === B[i][d]) dieSame++; else all = false; } if (all) rollSame++; }
    return { dieSame: dieSame / (A.length * DICE_COUNT), rollSame: rollSame / A.length };
  };
  const base1 = [], base0 = [], base2 = [], pert = [];
  for (let n = 0; n < M; n++) {
    const sd = SEEDBASE + 500000 + n;
    base1.push(run(sd, 1)); base0.push(run(sd, 0)); base2.push(run(sd, 2)); pert.push(run(sd, 1, 1e-9));
  }
  bowl.bumpScale = 1;
  const c01 = cmp(base1, base0), c12 = cmp(base1, base2), cp = cmp(base1, pert);
  console.log('同一の投げ出し条件で比較した「同じ目になった賽の割合」(偶然一致の期待値 16.7%):');
  console.log(`  凹凸 1.0 vs 凹凸 0   : 賽ごと ${(c01.dieSame * 100).toFixed(1)}%  5個すべて一致 ${(c01.rollSame * 100).toFixed(1)}%`);
  console.log(`  凹凸 1.0 vs 凹凸 2.0 : 賽ごと ${(c12.dieSame * 100).toFixed(1)}%  5個すべて一致 ${(c12.rollSame * 100).toFixed(1)}%`);
  console.log(`  初期位置を 1e-9m(1ナノメートル) ずらす: 賽ごと ${(cp.dieSame * 100).toFixed(1)}%  5個すべて一致 ${(cp.rollSame * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------- 6
hr('6) 貫通チェック (全フレーム)');
{
  const M = quick ? 60 : 250;
  const q = new Float64Array(5); const R = new Float64Array(9);
  let frames = 0; let worstBowl = 0; let over1 = 0; let worstCenter = Infinity; let worstPair = 0; let pairOver1 = 0;
  const Hs = DIE.half;
  for (let n = 0; n < M; n++) {
    const o = new RollJob(bowl, seedFromNumber(SEEDBASE + 700000 + n), { wantShonben: n % 6 === 5, quality: 'medium' }, world).runToEnd();
    const rec = o.recording; const stride = DICE_COUNT * FLOATS_PER_DIE;
    for (let f = 0; f < rec.frameCount; f++) {
      frames++;
      for (let d = 0; d < DICE_COUNT; d++) {
        const b = f * stride + d * 7; const px = rec.frames[b], py = rec.frames[b + 1], pz = rec.frames[b + 2];
        quatToMat(rec.frames[b + 3], rec.frames[b + 4], rec.frames[b + 5], rec.frames[b + 6], R);
        bowl.query(px, py, pz, q); if (q[0] < worstCenter) worstCenter = q[0];
        let pen = 0;
        for (let k = 0; k < SAMPLES_DENSE_N; k++) {
          const lx = SAMPLES[k * 3], ly = SAMPLES[k * 3 + 1], lz = SAMPLES[k * 3 + 2];
          bowl.query(px + R[0] * lx + R[1] * ly + R[2] * lz, py + R[3] * lx + R[4] * ly + R[5] * lz, pz + R[6] * lx + R[7] * ly + R[8] * lz, q);
          const depth = DIE.cornerRadius - q[0]; if (depth > pen) pen = depth;
        }
        if (pen > worstBowl) worstBowl = pen; if (pen > 0.001) over1++;
      }
      // サイコロ同士の中心距離 (外接球の直径以下なら要注意) → 内箱の最近接距離で厳密に
      for (let i = 0; i < DICE_COUNT; i++) for (let j = i + 1; j < DICE_COUNT; j++) {
        const bi = f * stride + i * 7, bj = f * stride + j * 7;
        const dist = Math.hypot(rec.frames[bi] - rec.frames[bj], rec.frames[bi + 1] - rec.frames[bj + 1], rec.frames[bi + 2] - rec.frames[bj + 2]);
        // 内接球 (半径 half) が重なる = 確実に貫入
        const pen = 2 * Hs - dist; if (pen > worstPair) worstPair = pen; if (pen > 0.001) pairOver1++;
      }
    }
  }
  console.log(`${M}投擲 / ${frames}フレーム (120Hz記録) を全数検査`);
  console.log(`  賽 × お椀/机 : 最大めり込み ${(worstBowl * 1000).toFixed(3)} mm   (1mm超のフレーム ${over1} / ${frames * DICE_COUNT})`);
  console.log(`  賽の中心が固体の内側へ入った最小距離 φ = ${(worstCenter * 1000).toFixed(2)} mm  (正なら中心が一度も固体内に入っていない / 賽の半辺 ${(Hs * 1000).toFixed(0)}mm)`);
  console.log(`  賽 × 賽      : 内接球どうしの最大重なり ${(Math.max(0, worstPair) * 1000).toFixed(3)} mm  (1mm超のフレーム ${pairOver1})  ※内接球の重なり>0 は「面で埋まっている」ことを意味する`);
}
console.log('\n完了');
