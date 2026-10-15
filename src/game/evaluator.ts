import { EvaluatedHand, SCORE_TABLE } from '../types/game';

/**
 * 5個のサイコロから役を判定する（出目ルール）
 *
 * 1. ピンゾロ (1,1,1,1,1) -> 1000点
 * 2. アラシ (n,n,n,n,n, n!=1) -> 900 + n 点
 * 3. 目あり (a,a,a,a, n) -> 800 + n 点 (1個だけの出目がスコア)
 * 4. シゴロ (4,5,6 + ペア a,a) -> 300点
 * 5. ヒフミ (1,2,3 + ペア a,a) -> -100点
 * 6. 役なし -> 0点 (サドンデス用スコア: 最大出目×10 + 最小出目)
 * 7. ションベン -> -50点 (確率1%固定、お椀外落下、サドンデス用スコア: -1)
 */
export function evaluateYaku(diceArray: number[]): EvaluatedHand {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  diceArray.forEach((d) => {
    if (counts[d] !== undefined) counts[d]++;
  });

  const values = Object.values(counts);
  const keys = Object.keys(counts).map(Number);

  const max = Math.max(...diceArray);
  const min = Math.min(...diceArray);
  const sdSubScore = max * 10 + min; // サドンデス時役なし比較用

  // 1. ピンゾロ (1,1,1,1,1)
  if (counts[1] === 5) {
    return {
      name: 'ピンゾロ',
      score: SCORE_TABLE.PINZORO,
      type: 'win',
      sub: sdSubScore,
      description: '1のゾロ目（5個すべて1）',
    };
  }

  // 2. アラシ (n,n,n,n,n)
  if (values.includes(5)) {
    const num = keys.find((k) => counts[k] === 5) ?? diceArray[0];
    return {
      name: `${num}のアラシ`,
      score: SCORE_TABLE.ARASHI_BASE + num,
      type: 'win',
      sub: sdSubScore,
      description: `同数5個揃い（出目: ${num}）`,
    };
  }

  // 3. 目あり (a,a,a,a, n)
  if (values.includes(4)) {
    const single = keys.find((k) => counts[k] === 1) ?? 1;
    return {
      name: `${single}の目`,
      score: SCORE_TABLE.MEARI_BASE + single,
      type: 'win',
      sub: sdSubScore,
      description: `4個同数、1個単数（出目: ${single}）`,
    };
  }

  // 4. シゴロ / 5. ヒフミ判定 (4,5,6 または 1,2,3 ＋ ペア)
  // まず4,5,6が含まれているか確認
  if (counts[4] >= 1 && counts[5] >= 1 && counts[6] >= 1) {
    const c = { ...counts };
    c[4]--;
    c[5]--;
    c[6]--;
    const rem: number[] = [];
    for (const k of keys) {
      for (let i = 0; i < c[k]; i++) rem.push(k);
    }
    // 残りが2個で同じ数字（ペア）であればシゴロ
    if (rem.length === 2 && rem[0] === rem[1]) {
      return {
        name: 'シゴロ',
        score: SCORE_TABLE.SHIGORO,
        type: 'win',
        sub: sdSubScore,
        description: `4・5・6 および ペア（${rem[0]}）`,
      };
    }
  }

  // ヒフミ確認 (1,2,3が含まれているか)
  if (counts[1] >= 1 && counts[2] >= 1 && counts[3] >= 1) {
    const c = { ...counts };
    c[1]--;
    c[2]--;
    c[3]--;
    const rem: number[] = [];
    for (const k of keys) {
      for (let i = 0; i < c[k]; i++) rem.push(k);
    }
    // 残りが2個で同じ数字（ペア）であればヒフミ
    if (rem.length === 2 && rem[0] === rem[1]) {
      return {
        name: 'ヒフミ',
        score: SCORE_TABLE.HIFUMI,
        type: 'lose',
        sub: sdSubScore,
        description: `1・2・3 および ペア（${rem[0]}）`,
      };
    }
  }

  // 6. 役なし
  return {
    name: '役なし',
    score: SCORE_TABLE.MENASHI,
    type: 'normal',
    sub: sdSubScore,
    description: `役なし（判定用スコア: ${sdSubScore}）`,
  };
}

/**
 * ションベン時の役オブジェクト
 */
export function getShonbenYaku(): EvaluatedHand {
  return {
    name: 'ションベン',
    score: SCORE_TABLE.SHONBEN,
    type: 'shonben',
    sub: -1,
    description: 'サイコロがお椀の外に落下（発生確率: 1%）',
  };
}
