/**
 * チンチロ物理シミュレータ — 定数
 *
 * 単位はすべて SI (m, kg, s)。描画側は 1 シーン単位 = 1 cm として ×100 して使う。
 * 数値は「実物のチンチロ」を基準にしている。
 *   - サイコロ : 16mm角・角丸 R1.5mm のアクリル賽 (約4.6g)
 *   - お椀     : 内径 約16cm・深さ 約5cm の釉薬がけ陶器丼
 */

/** 重力加速度 [m/s²] */
export const GRAVITY = 9.81;

/** サイコロ寸法・質量 */
export const DIE = {
  /** 一辺 [m] */
  size: 0.016,
  /** 半辺 [m] */
  half: 0.008,
  /** 角の丸み半径 [m]。衝突形状は「内側の箱 + この半径の球」で表現する */
  cornerRadius: 0.0015,
  /** 内側の箱の半辺 [m] (= half - cornerRadius) */
  inner: 0.0065,
  /** 質量 [kg] */
  mass: 0.0046,
  /** 外接球の半径 [m] (内箱の対角半分 + 角丸) */
  boundRadius: 0.0065 * Math.sqrt(3) + 0.0015,
} as const;

/** 立方体の慣性モーメント I = m s² / 6 (全軸等方) [kg·m²] */
export const DIE_INERTIA = (DIE.mass * DIE.size * DIE.size) / 6;
export const DIE_INV_MASS = 1 / DIE.mass;
export const DIE_INV_INERTIA = 1 / DIE_INERTIA;

/** サイコロの個数 (ゲーム仕様: 5個) */
export const DICE_COUNT = 5;

/** 材質ID (お椀の面ごとに摩擦・反発が異なる) */
export const MAT_TABLE = 0; // 机 (木/フェルト)
export const MAT_GLAZE = 1; // お椀の内側 (釉薬)
export const MAT_RIM = 2; // お椀の縁 (金縁)
export const MAT_OUTER = 3; // お椀の外側・高台

/** 面の値 ↔ ローカル軸 (サイコロの目の配置: 反対面の和が7) */
export const FACE_VALUE_POS_X = 1;
export const FACE_VALUE_NEG_X = 6;
export const FACE_VALUE_POS_Y = 2;
export const FACE_VALUE_NEG_Y = 5;
export const FACE_VALUE_POS_Z = 3;
export const FACE_VALUE_NEG_Z = 4;

/**
 * 接触材質ごとの [摩擦係数, 反発係数] (サイコロとの組み合わせ値)
 * 硬い釉薬の陶器に当たるアクリル賽は、実際によく跳ねて「カラカラ」と鳴る (反発 0.6 前後)。
 */
export const SURFACE_PARAMS: readonly (readonly [number, number])[] = [
  [0.42, 0.42], // MAT_TABLE   : 木の机 (跳ねにくい)
  [0.27, 0.62], // MAT_GLAZE   : アクリル × 釉薬 (すべりやすく、よく跳ねる)
  [0.3, 0.62], // MAT_RIM
  [0.32, 0.5], // MAT_OUTER
];

/** サイコロ同士 [摩擦, 反発] */
export const DICE_DICE_PARAMS: readonly [number, number] = [0.3, 0.58];

/** 物理ステップ設定 */
export const STEP_HZ = { low: 360, medium: 480, high: 600 } as const;
/** 記録(再生)フレームレート [Hz]。STEP_HZ の約数にしておく */
export const FRAME_HZ = 120;

/** 静止判定 */
export const SLEEP_LINEAR = 0.02; // m/s
export const SLEEP_ANGULAR = 0.35; // rad/s
export const SLEEP_TIME = 0.35; // s

/** 1回の投擲シミュレーションの最長時間 [s] */
export const MAX_SIM_TIME = 9;

/** 速度の安全上限 (数値爆発の防止) */
export const MAX_LINEAR_SPEED = 9; // m/s
export const MAX_ANGULAR_SPEED = 260; // rad/s
