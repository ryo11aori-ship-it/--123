/**
 * 乱数基盤
 *
 * 「サイコロの目」そのものは物理シミュレーションの結果として決まる。
 * ここで作る乱数は、その物理シミュレーションの *初期条件* (投げ出し位置・速度・回転・向き)
 * だけに使う。初期条件の揺らぎは暗号論的乱数 (crypto.getRandomValues) にタイミング揺らぎ等を
 * 混ぜた 128bit シードから sfc32 で生成する。
 */

export type Seed4 = readonly [number, number, number, number];

/** murmur3 の最終混合 */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** sfc32 (PractRand を通過する小型PRNG) */
export class Prng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spare: number | null = null;

  constructor(seed: Seed4) {
    this.a = seed[0] | 0;
    this.b = seed[1] | 0;
    this.c = seed[2] | 0;
    this.d = seed[3] | 0;
    for (let i = 0; i < 15; i++) this.nextU32(); // 立ち上がりを捨てる
  }

  nextU32(): number {
    const a = this.a | 0;
    const b = this.b | 0;
    let c = this.c | 0;
    let d = this.d | 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    this.a = b ^ (b >>> 9);
    this.b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    this.c = (c + t) | 0;
    this.d = d;
    return t >>> 0;
  }

  /** [0, 1) */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  /** [lo, hi) */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  /** 0 以上 n 未満の整数 */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** 標準正規分布 (Box–Muller) */
  gaussian(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u < 1e-12) u = this.float();
    const v = this.float();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  }

  /** 単位球面上の一様なベクトル */
  unitVector(out: number[] | Float64Array, offset = 0): void {
    const z = this.range(-1, 1);
    const phi = this.range(0, Math.PI * 2);
    const s = Math.sqrt(1 - z * z);
    out[offset] = s * Math.cos(phi);
    out[offset + 1] = z;
    out[offset + 2] = s * Math.sin(phi);
  }

  /** SO(3) 上で一様な単位クォータニオン (Shoemake) [x,y,z,w] */
  quaternion(out: number[] | Float64Array, offset = 0): void {
    const u1 = this.float();
    const u2 = this.float() * Math.PI * 2;
    const u3 = this.float() * Math.PI * 2;
    const s1 = Math.sqrt(1 - u1);
    const s2 = Math.sqrt(u1);
    out[offset] = s1 * Math.sin(u2);
    out[offset + 1] = s1 * Math.cos(u2);
    out[offset + 2] = s2 * Math.sin(u3);
    out[offset + 3] = s2 * Math.cos(u3);
  }

  /** 子PRNGを派生 */
  fork(): Prng {
    return new Prng([this.nextU32(), this.nextU32(), this.nextU32(), this.nextU32()]);
  }
}

/** シード文字列 → 4×u32 (xmur3 系) */
export function seedFromString(str: string): Seed4 {
  let h1 = 0x9e3779b9;
  let h2 = 0x243f6a88;
  let h3 = 0xb7e15162;
  let h4 = 0xdeadbeef;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = fmix32(h1 ^ Math.imul(c, 0x85ebca6b));
    h2 = fmix32(h2 ^ Math.imul(c, 0xc2b2ae35) ^ h1);
    h3 = fmix32(h3 ^ Math.imul(c, 0x27d4eb2f) ^ h2);
    h4 = fmix32(h4 ^ Math.imul(c, 0x165667b1) ^ h3);
  }
  return [h1, h2, h3, h4];
}

/** 数値 4 つ → Seed4 (テスト用の再現可能なシード) */
export function seedFromNumber(n: number): Seed4 {
  return seedFromString(`seed:${n}`);
}

/**
 * エントロピープール。
 * 操作タイミング・ポインタ座標などの揺らぎを蓄積し、暗号論的乱数と混ぜてシードを作る。
 */
export class EntropyPool {
  private h: [number, number, number, number] = [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344];
  private counter = 0;

  /** 揺らぎ(数値)を混ぜる。performance.now() やポインタ座標などを渡す */
  feed(...values: number[]): void {
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      const i = Math.floor(v);
      const f = Math.floor((v - i) * 4294967296);
      this.mix(i | 0);
      this.mix(f | 0);
    }
  }

  private mix(x: number): void {
    const h = this.h;
    h[0] = fmix32(h[0] ^ (x + 0x9e3779b9));
    h[1] = fmix32(h[1] ^ Math.imul(x, 0x85ebca6b) ^ h[0]);
    h[2] = fmix32(h[2] ^ Math.imul(x, 0xc2b2ae35) ^ h[1]);
    h[3] = fmix32(h[3] ^ Math.imul(x, 0x27d4eb2f) ^ h[2]);
  }

  /** 128bit シードを取り出す */
  seed(): Seed4 {
    const rnd = new Uint32Array(4);
    const cryptoObj: Crypto | undefined =
      typeof globalThis !== 'undefined' ? (globalThis as { crypto?: Crypto }).crypto : undefined;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
      cryptoObj.getRandomValues(rnd);
    } else {
      for (let i = 0; i < 4; i++) rnd[i] = Math.floor(Math.random() * 4294967296);
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.feed(now, this.counter++);
    const h = this.h;
    const out: [number, number, number, number] = [
      fmix32(rnd[0] ^ h[0]),
      fmix32(rnd[1] ^ h[1] ^ rnd[0]),
      fmix32(rnd[2] ^ h[2] ^ rnd[1]),
      fmix32(rnd[3] ^ h[3] ^ rnd[2]),
    ];
    // 取り出した分をプールへフィードバック (連続して同じ値が出ないように)
    this.mix(out[0] ^ out[3]);
    return out;
  }
}

/** 共有プール (UIの操作ゆらぎなどを溜める) */
export const entropyPool = new EntropyPool();

/** シードを短い16進表示にする (物理ログ表示用) */
export function seedToLabel(seed: Seed4): string {
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0').toUpperCase();
  return `${hex(seed[0]).slice(0, 4)}-${hex(seed[1]).slice(0, 4)}-${hex(seed[2]).slice(0, 4)}`;
}
